// Unobserved dump records — universal clean-up of self-modifying-bytecode leftovers in residual programs.
//
// After specialisation the residual code may still write into the dump's records (the patches the original
// bytecode applied to itself) and test them in one-time guards:
//
//   if K_16[2092] == 2760 then else K_16[2092] = 2760; K_12[7] = 1 end
//   K_16[1684] = 2403
//
// A record that the residual program only ever writes at literal keys, or tests in such guards (an if whose
// branches do nothing but write records of the same kind), can no longer influence the program: its stores
// and guards are removed. A record read anywhere else (a run-time selected variant, an alias, a call
// argument) keeps all of its stores, and so do the records written under a guard on it (fixpoint).
import type * as A from '../ast.js';
import { analyzeScopes } from '../analysis/scope.js';
import { walk } from '../ast.js';

export interface RecordCleanResult { stores: number; guards: number; records: number; changed: Set<string>; notes: string[]; }

const unparen = (e: A.Expr): A.Expr => { while (e && e.type === 'ParenExpr') e = e.expr; return e; };
const isLit = (e: A.Expr | undefined): boolean => {
  if (!e) return false; const u = unparen(e);
  if (u.type === 'NumberLit' || u.type === 'StringLit' || u.type === 'TrueLit' || u.type === 'FalseLit' || u.type === 'NilLit') return true;
  return u.type === 'UnExpr' && u.op === '-' && unparen(u.expr).type === 'NumberLit';
};

export function dropUnobservedRecords(protos: Array<{ id: string; chunk: A.Chunk }>, recordId: (name: string) => string | null): RecordCleanResult {
  const res: RecordCleanResult = { stores: 0, guards: 0, records: 0, changed: new Set(), notes: [] };
  interface Store { proto: string; stmt: A.AssignStat; rec: string; }
  interface Guard { proto: string; stmt: A.IfStat; rec: string; stores: Store[]; }
  const stores: Store[] = [];
  const guards: Guard[] = [];
  const observed = new Set<string>();
  const seen = new Set<string>();
  const storeOf = new Map<A.Stat, Store>();
  for (const p of protos) {
    const sc = analyzeScopes(p.chunk);
    const recOf = (e: A.Expr | undefined): string | null => {
      const u = e && unparen(e);
      if (!u || u.type !== 'NameExpr') return null;
      const b = sc.refOf.get(u);
      if (b && b.kind !== 'global') return null;
      return recordId(u.name);
    };
    // the record store `REC[lit] = lit`
    const asStore = (s: A.Stat): string | null => {
      if (s.type !== 'AssignStat' || s.op || s.targets.length !== 1 || s.values.length !== 1) return null;
      const t = unparen(s.targets[0]);
      if (t.type !== 'IndexExpr' || !isLit(t.index) || !isLit(s.values[0])) return null;
      return recOf(t.obj);
    };
    // the guard condition `REC[lit] == lit` (or ~=, or not (…))
    const guardRec = (c: A.Expr): string | null => {
      let u = unparen(c);
      if (u.type === 'UnExpr' && u.op === 'not') u = unparen(u.expr);
      if (u.type !== 'BinExpr' || (u.op !== '==' && u.op !== '~=')) return null;
      const side = (a: A.Expr, b: A.Expr) => { const ua = unparen(a); return ua.type === 'IndexExpr' && isLit(ua.index) && isLit(b) ? recOf(ua.obj) : null; };
      return side(u.left, u.right) ?? side(u.right, u.left);
    };
    const counted = new Set<A.NameExpr>();
    const visitStmts = (list: A.Stat[]) => {
      for (const s of list) {
        const r = asStore(s);
        if (r !== null) { const st = { proto: p.id, stmt: s as A.AssignStat, rec: r }; stores.push(st); storeOf.set(s, st); seen.add(r); counted.add(unparen((unparen((s as A.AssignStat).targets[0]) as A.IndexExpr).obj) as A.NameExpr); continue; }
        if (s.type === 'IfStat' && s.clauses.length === 1) {
          const g = guardRec(s.clauses[0].cond);
          const branches = [s.clauses[0].body, s.elseBody ?? []];
          if (g !== null && branches.every(b => b.every(x => asStore(x) !== null))) {
            const gs: Store[] = [];
            for (const b of branches) for (const x of b) { const st = { proto: p.id, stmt: x as A.AssignStat, rec: asStore(x)! }; gs.push(st); counted.add(unparen((unparen((x as A.AssignStat).targets[0]) as A.IndexExpr).obj) as A.NameExpr); seen.add(st.rec); }
            guards.push({ proto: p.id, stmt: s, rec: g, stores: gs }); seen.add(g);
            // the record name inside the condition
            const visitC = (n: any) => { if (!n || typeof n !== 'object') return; if (n.type === 'NameExpr') { counted.add(n); return; } for (const k of Object.keys(n)) if (k !== 'loc') visitC(n[k]); };
            visitC(s.clauses[0].cond);
            continue;
          }
        }
        // nested statement lists
        switch (s.type) {
          case 'DoStat': case 'WhileStat': case 'RepeatStat': case 'NumericForStat': case 'GenericForStat': visitStmts(s.body); break;
          case 'IfStat': for (const c of s.clauses) visitStmts(c.body); if (s.elseBody) visitStmts(s.elseBody); break;
        }
      }
    };
    // every statement list, nested functions included
    const lists: A.Stat[][] = [];
    const findFns = (n: any) => { if (!n || typeof n !== 'object') return; if (Array.isArray(n)) { n.forEach(findFns); return; } if (n.type === 'FunctionExpr') lists.push(n.body); for (const k of Object.keys(n)) if (k !== 'loc') { const x = n[k]; if (x && typeof x === 'object') findFns(x); } };
    lists.push(p.chunk.body); findFns(p.chunk.body);
    for (const l of lists) visitStmts(l);
    // any other reference observes the record
    for (const b of sc.bindings) {
      if (b.kind !== 'global') continue;
      const r = recordId(b.name); if (r === null) continue;
      for (const ref of b.refs) if (!counted.has(ref)) { observed.add(r); break; }
    }
  }
  // records written under a guard on an observed record are observed too (the guard decides them) — and a guard
  // that writes an observed record observes its own condition
  let grow = true;
  while (grow) {
    grow = false;
    for (const g of guards) {
      if (observed.has(g.rec)) continue;
      if (g.stores.some(s => observed.has(s.rec))) { observed.add(g.rec); grow = true; }
    }
  }
  const dead = new Set([...seen].filter(r => !observed.has(r)));
  if (!dead.size) return res;
  const drop = new Set<A.Stat>();
  for (const s of stores) if (dead.has(s.rec)) drop.add(s.stmt);
  for (const g of guards) if (dead.has(g.rec) && g.stores.every(s => dead.has(s.rec))) { drop.add(g.stmt); res.guards++; }
  for (const p of protos) {
    let n = 0;
    const filter = (list: A.Stat[]) => {
      for (let i = list.length - 1; i >= 0; i--) {
        const s = list[i];
        if (drop.has(s)) { list.splice(i, 1); n++; continue; }
        switch (s.type) {
          case 'DoStat': case 'WhileStat': case 'RepeatStat': case 'NumericForStat': case 'GenericForStat': filter(s.body); break;
          case 'IfStat': for (const c of s.clauses) filter(c.body); if (s.elseBody) filter(s.elseBody); break;
        }
      }
    };
    const findFns = (x: any) => { if (!x || typeof x !== 'object') return; if (Array.isArray(x)) { x.forEach(findFns); return; } if (x.type === 'FunctionExpr') filter(x.body); for (const k of Object.keys(x)) if (k !== 'loc') { const y = x[k]; if (y && typeof y === 'object') findFns(y); } };
    filter(p.chunk.body); findFns(p.chunk.body);
    if (n) res.changed.add(p.id);
  }
  res.stores = stores.filter(s => dead.has(s.rec)).length;
  res.records = dead.size;
  res.notes.push(`${res.stores} store(s) into ${dead.size} dump record(s) and ${res.guards} one-time patch guard(s) removed: the residual program never reads these records otherwise (self-modifying bytecode leftovers)` + (observed.size ? `; ${observed.size} record(s) still read at run time keep their stores` : ''));
  return res;
}

/** One-time guards whose branches agree once the flag is written:
 *
 *    if R[k] == v then A else R[k] = v; A end      ->  do R[k] = v; A end
 *    if R[k] ~= v then R[k] = v; A else A end      ->  do R[k] = v; A end
 *
 *  (R a dump record — a plain table without metatables; several tested slots joined by `and`, with stores
 *  writing tested slots with their tested values). When the guard holds, the stores write the values the
 *  slots already have; otherwise the branch with the stores runs as it is. A is compared textually. */
export function foldIdempotentGuards(chunk: A.Chunk, recordId: (name: string) => string | null, print: (n: A.Chunk) => string): number {
  let n = 0;
  const sc = analyzeScopes(chunk);
  const recName = (e: A.Expr): string | null => {
    const u = unparen(e); if (u.type !== 'NameExpr') return null;
    const b = sc.refOf.get(u); if (b && b.kind !== 'global') return null;
    return recordId(u.name) !== null ? u.name : null;
  };
  const litKey = (e: A.Expr | undefined): string | null => {
    if (!e || !isLit(e)) return null; const u = unparen(e);
    switch (u.type) {
      case 'NumberLit': return 'n' + String(u.value);
      case 'StringLit': return 's' + JSON.stringify(u.value);
      case 'TrueLit': return 'b1'; case 'FalseLit': return 'b0'; case 'NilLit': return 'nil';
      case 'UnExpr': { const v = unparen(u.expr) as A.NumberLit; return 'n' + String(-v.value); }
    }
    return null;
  };
  /** `R[k] op v` -> "R|k" -> "v" */
  const tests = (cond: A.Expr, op: '==' | '~='): Map<string, string> | null => {
    const out = new Map<string, string>();
    const flat = (e: A.Expr): boolean => {
      const u = unparen(e);
      if (op === '==' && u.type === 'BinExpr' && u.op === 'and') return flat(u.left) && flat(u.right);
      if (u.type !== 'BinExpr' || u.op !== op) return false;
      let ix = unparen(u.left), lv = u.right;
      if (ix.type !== 'IndexExpr') { ix = unparen(u.right); lv = u.left; }
      if (ix.type !== 'IndexExpr') return false;
      const r = recName(ix.obj), k = litKey(ix.index), v = litKey(lv);
      if (r === null || k === null || v === null || v === 'nil') return false;
      const sk = r + '|' + k; if (out.has(sk) && out.get(sk) !== v) return false;
      out.set(sk, v); return true;
    };
    return flat(cond) && out.size ? out : null;
  };
  const storeOf = (s: A.Stat): [string, string] | null => {
    if (s.type !== 'AssignStat' || s.op || s.targets.length !== 1 || s.values.length !== 1) return null;
    const t = unparen(s.targets[0]); if (t.type !== 'IndexExpr') return null;
    const r = recName(t.obj), k = litKey(t.index), v = litKey(s.values[0]);
    return r !== null && k !== null && v !== null ? [r + '|' + k, v] : null;
  };
  const text = (l: A.Stat[]) => print({ type: 'Chunk', body: l } as A.Chunk);
  /** body = stores of tested slots with their tested values, then `rest` equal to other */
  const split = (body: A.Stat[], other: A.Stat[], ts: Map<string, string>): A.Stat[] | null => {
    let i = 0;
    while (i < body.length) { const st = storeOf(body[i]); if (!st || ts.get(st[0]) !== st[1]) break; i++; }
    if (i === 0 || body.length - i !== other.length) return null;
    return text(body.slice(i)) === text(other) ? body.slice(0, i) : null;
  };
  const visit = (l: A.Stat[]) => {
    for (let i = 0; i < l.length; i++) {
      const s = l[i];
      for (const k of ['body', 'elseBody'] as const) { const b = (s as any)[k]; if (Array.isArray(b)) visit(b); }
      if (s.type === 'IfStat') for (const c of s.clauses) visit(c.body);
      if (s.type !== 'IfStat' || s.clauses.length !== 1) continue;
      const c = s.clauses[0], els = s.elseBody ?? [];
      let pre: A.Stat[] | null = null, rest: A.Stat[] = [];
      const pos = tests(c.cond, '==');
      if (pos) { pre = split(els, c.body, pos); rest = c.body; }
      if (!pre) { const neg = tests(c.cond, '~='); if (neg && neg.size === 1) { pre = split(c.body, els, neg); rest = els; } }
      if (!pre) continue;
      l[i] = { type: 'DoStat', body: [...pre, ...rest] } as A.Stat;
      n++;
    }
  };
  visit(chunk.body);
  walk(chunk, (m: any) => { if (m.type === 'FunctionExpr') visit(m.body); });
  return n;
}
