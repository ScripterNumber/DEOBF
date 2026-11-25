// PRISM — which arguments of the interpreter's helper functions are only read.
// A helper slot `H[k]` of the helper table is a pure reader at argument i when every function the source
// assigns to a literal key k (of any table — a superset of the helper's definitions; a slot assigned
// anything else that may be a function is unknown; helpers are assumed installed under literal keys) only reads its
// parameter i: indexes it, takes its length, compares / tests it, or hands it to library readers or to
// helper slots that are pure readers at that position (optimistic fixpoint). Stored, returned, called,
// captured or otherwise passed on, it is not.
import type * as A from '../ast.js';
import { LIB_READERS } from './patches.js';

const unparen = (e: A.Expr): A.Expr => { while (e && e.type === 'ParenExpr') e = e.expr; return e; };
const litKey = (e: A.Expr): string | null => { const u = unparen(e); if (u.type === 'NumberLit') return String(u.value); if (u.type === 'StringLit') return JSON.stringify(u.value); return null; };

/** slot key text (String(number) / JSON string) -> argument positions only read; `libOf` names the library
 *  function a slot holds in the dump (those use the library table), `isClosure` says it holds a Lua function */
export function findPureReaderSlots(chunk: A.Chunk, libOf: (k: string) => string | null): Map<string, Set<number>> {
  const defs = new Map<string, A.FunctionExpr[] | null>();
  const def = (k: string, v: A.Expr | undefined) => {
    const u = v ? unparen(v) : null;
    // values that cannot be a function (another table's field of the same key) say nothing about the slot
    if (u && (u.type === 'NilLit' || u.type === 'NumberLit' || u.type === 'StringLit' || u.type === 'TrueLit' || u.type === 'FalseLit' || u.type === 'TableExpr' || u.type === 'InterpExpr')) return;
    if (u && u.type === 'FunctionExpr') { const d = defs.get(k); if (d === null) return; if (d) d.push(u); else defs.set(k, [u]); return; }
    defs.set(k, null);
  };
  const visit = (x: any) => {
    if (!x || typeof x !== 'object') return;
    if (Array.isArray(x)) { for (const y of x) visit(y); return; }
    if (x.type === 'AssignStat' && !x.op) x.targets.forEach((t: A.Expr, i: number) => { const u = unparen(t); if (u.type === 'IndexExpr') { const k = litKey(u.index); if (k !== null) def(k, i < x.values.length ? x.values[i] : undefined); } else if (u.type === 'MemberExpr') def(JSON.stringify(u.name), i < x.values.length ? x.values[i] : undefined); });
    if (x.type === 'TableExpr') { let n = 0; for (const f of x.fields as A.TableField[]) { if (f.kind === 'item') { n++; if (unparen(f.value).type === 'FunctionExpr') def(String(n), f.value); } else if (f.kind === 'named' && f.name !== undefined) { if (unparen(f.value).type === 'FunctionExpr') def(JSON.stringify(f.name), f.value); } else if (f.key) { const k = litKey(f.key); if (k !== null && unparen(f.value).type === 'FunctionExpr') def(k, f.value); } } }
    for (const k of Object.keys(x)) if (k !== 'loc') visit(x[k]);
  };
  visit(chunk);
  // optimistic start: every parameter position of every definition
  const pure = new Map<string, Set<number>>();
  for (const [k, ds] of defs) { if (!ds || libOf(k) !== null) continue; const n = Math.max(...ds.map(d => d.params.length)); pure.set(k, new Set(Array.from({ length: n }, (_, i) => i))); }
  const slotReader = (callee: A.Expr): Set<number> | null => {
    const u = unparen(callee);
    if (u.type === 'NameExpr') { const r = LIB_READERS[u.name]; return r ? new Set(r) : null; }
    if ((u.type === 'MemberExpr' || u.type === 'IndexExpr') && unparen(u.obj).type === 'NameExpr') {
      const base = (unparen(u.obj) as A.NameExpr).name;
      const key = u.type === 'MemberExpr' ? u.name : (unparen(u.index).type === 'StringLit' ? (unparen(u.index) as A.StringLit).value : null);
      if (key !== null && LIB_READERS[base + '.' + key]) return new Set(LIB_READERS[base + '.' + key]);
      const k = u.type === 'MemberExpr' ? JSON.stringify(u.name) : litKey(u.index);
      if (k === null) return null;
      const lib = libOf(k); if (lib !== null) { const r = LIB_READERS[lib]; return r ? new Set(r) : null; }
      return pure.get(k) ?? null;
    }
    return null;
  };
  const onlyRead = (f: A.FunctionExpr, p: string): boolean => {
    let ok = true;
    type Ctx = 'value' | 'read' | 'harmless';
    const E = (e: A.Expr | undefined, ctx: Ctx, nested: boolean): void => {
      if (!e || !ok) return;
      switch (e.type) {
        case 'ParenExpr': E(e.expr, ctx, nested); return;
        case 'NameExpr': if (e.name === p && (nested || ctx === 'value')) ok = false; return;
        case 'IndexExpr': E(e.obj, 'read', nested); E(e.index, 'value', nested); return;
        case 'MemberExpr': E(e.obj, 'read', nested); return;
        case 'CallExpr': { const r = slotReader(e.callee); E(e.callee, 'value', nested); e.args.forEach((a, i) => E(a, r && r.has(i) ? 'read' : 'value', nested)); return; }
        case 'MethodCallExpr': E(e.obj, 'value', nested); for (const a of e.args) E(a, 'value', nested); return;
        case 'BinExpr': if (e.op === 'and' || e.op === 'or') { E(e.left, ctx, nested); E(e.right, ctx, nested); } else { E(e.left, 'harmless', nested); E(e.right, 'harmless', nested); } return;
        case 'UnExpr': E(e.expr, 'harmless', nested); return;
        case 'TableExpr': for (const fl of e.fields) { if (fl.key) E(fl.key, 'value', nested); E(fl.value, 'value', nested); } return;
        case 'FunctionExpr': S(e.body, true); return;
        case 'InterpExpr': for (const q of e.parts) if (q.kind === 'expr') E(q.expr, 'harmless', nested); return;
        case 'IfExpr': for (const c of e.clauses) { E(c.cond, 'harmless', nested); E(c.value, ctx, nested); } E(e.elseValue, ctx, nested); return;
        default: return;
      }
    };
    const T = (t: A.Expr, nested: boolean) => { const u = unparen(t); if (u.type === 'IndexExpr') { const o = unparen(u.obj); if (o.type === 'NameExpr' && o.name === p) ok = false; else E(u.obj, 'read', nested); E(u.index, 'value', nested); } else if (u.type === 'MemberExpr') { const o = unparen(u.obj); if (o.type === 'NameExpr' && o.name === p) ok = false; else E(u.obj, 'read', nested); } else if (u.type === 'NameExpr' && u.name === p && nested) ok = false; };
    const S = (body: A.Stat[], nested: boolean): void => {
      for (const s of body) {
        if (!ok) return;
        switch (s.type) {
          case 'LocalStat': if (s.names.includes(p)) { ok = false; return; } for (const e of s.init) E(e, 'value', nested); break;
          case 'AssignStat': for (const t of s.targets) T(t, nested); for (const e of s.values) E(e, s.op ? 'harmless' : 'value', nested); break;
          case 'CallStat': E(s.expr, 'harmless', nested); break;
          case 'DoStat': S(s.body, nested); break;
          case 'WhileStat': E(s.cond, 'harmless', nested); S(s.body, nested); break;
          case 'RepeatStat': S(s.body, nested); E(s.cond, 'harmless', nested); break;
          case 'IfStat': for (const c of s.clauses) { E(c.cond, 'harmless', nested); S(c.body, nested); } if (s.elseBody) S(s.elseBody, nested); break;
          case 'NumericForStat': if (s.var === p) { ok = false; return; } E(s.from, 'harmless', nested); E(s.to, 'harmless', nested); E(s.step, 'harmless', nested); S(s.body, nested); break;
          case 'GenericForStat': if (s.names.includes(p)) { ok = false; return; } for (const e of s.iters) E(e, 'value', nested); S(s.body, nested); break;
          case 'ReturnStat': for (const e of s.args) E(e, 'value', nested); break;
          case 'FunctionStat': T(s.target, nested); S(s.func.body, true); break;
          case 'LocalFunctionStat': if (s.name === p) { ok = false; return; } S(s.func.body, true); break;
          default: break;
        }
      }
    };
    S(f.body, false);
    return ok;
  };
  for (let changed = true, guard = 0; changed && guard < 50; guard++) {
    changed = false;
    for (const [k, pos] of pure) for (const i of [...pos]) {
      const ds = defs.get(k)!;
      if (ds.every(d => i >= d.params.length ? !d.vararg : onlyRead(d, d.params[i]))) continue;
      pos.delete(i); changed = true;
    }
  }
  for (const [k, pos] of [...pure]) if (!pos.size) pure.delete(k);
  return pure;
}
