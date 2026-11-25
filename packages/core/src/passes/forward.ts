// Forward substitution (copy propagation) of temporaries — universal, conservative.
//   x = <stable expr>; …; use(x)   ->   use(<stable expr>)
// Stable expressions: literals, locals, varargs, globals and table paths (a.b[1][k]) and
// side-effect-free arithmetic over them. The value must provably not change between the
// definition and the use: no intervening write of a dependency, and — when the expression
// reads memory (globals / table fields) — no intervening call or table/global store.
// Only the first statement that reads x is rewritten per run (clean() iterates). The
// definition is deleted when x is certainly dead afterwards (unconditionally redefined in
// the same block, no other read and no exit in between).
import type * as A from '../ast.js';
import { walk } from '../ast.js';
import { analyzeScopes, Binding, ScopeInfo } from '../analysis/scope.js';
import { forEachStatList } from './scopepasses.js';

const PURE_BIN = new Set(['+', '-', '*', '/', '//', '%', '^', '..', '==', '~=', '<', '<=', '>', '>=', 'and', 'or']);

interface Info { ok: boolean; mem: boolean; deps: Set<Binding>; cheap: boolean; }
function stable(e: A.Expr, scope: ScopeInfo): Info {
  const info: Info = { ok: true, mem: false, deps: new Set(), cheap: true };
  const visit = (x: A.Expr) => {
    if (!info.ok) return;
    switch (x.type) {
      case 'NumberLit': case 'StringLit': case 'TrueLit': case 'FalseLit': case 'NilLit': case 'VarargLit': return;
      case 'ParenExpr': visit(x.expr); return;
      case 'NameExpr': {
        const b = scope.refOf.get(x);
        if (!b) { info.ok = false; return; }                 // unknown node: be safe
        if (b.kind === 'global') { info.mem = true; return; }
        if (b.capturedWrite) { info.ok = false; return; }
        info.deps.add(b); return;
      }
      case 'IndexExpr': info.mem = true; info.cheap = false; visit(x.obj); visit(x.index); return;
      case 'MemberExpr': info.mem = true; info.cheap = false; visit(x.obj); return;
      case 'BinExpr': if (!PURE_BIN.has(x.op)) { info.ok = false; return; } info.cheap = false; visit(x.left); visit(x.right); return;
      case 'UnExpr': if (x.op !== '-' && x.op !== 'not' && x.op !== '#') { info.ok = false; return; } info.cheap = false; visit(x.expr); return;
      default: info.ok = false;
    }
  };
  visit(e);
  return info;
}
/** calls / table or global stores / exits inside the node (functions excluded) */
function effects(node: any, scope: ScopeInfo): { call: boolean; store: boolean; exit: boolean } {
  const r = { call: false, store: false, exit: false };
  const visit = (m: any) => {
    if (!m || typeof m !== 'object') return;
    if (Array.isArray(m)) { for (const x of m) visit(x); return; }
    if (m.type === 'FunctionExpr') return;
    if (m.type === 'CallExpr' || m.type === 'MethodCallExpr') r.call = true;
    if (m.type === 'BreakStat' || m.type === 'ReturnStat' || m.type === 'ContinueStat' || m.type === 'GotoStat' || m.type === 'LabelStat') r.exit = true;
    if (m.type === 'AssignStat') for (const t of m.targets) {
      if (t.type === 'IndexExpr' || t.type === 'MemberExpr') r.store = true;
      else if (t.type === 'NameExpr') { const b = scope.refOf.get(t); if (!b || b.kind === 'global') r.store = true; }
    }
    if (m.type === 'FunctionStat') r.store = true;
    for (const k of Object.keys(m)) if (k !== 'loc') visit(m[k]);
  };
  visit(node);
  return r;
}

/** break/continue leaving t (not inside a loop nested in t), or any goto/label */
function loopExit(t: A.Stat): boolean {
  let hit = false;
  const visit = (m: any, inLoop: boolean) => {
    if (hit || !m || typeof m !== 'object') return;
    if (Array.isArray(m)) { for (const x of m) visit(x, inLoop); return; }
    if (m.type === 'FunctionExpr') return;
    if ((m.type === 'BreakStat' || m.type === 'ContinueStat') && !inLoop) { hit = true; return; }
    if (m.type === 'GotoStat' || m.type === 'LabelStat') { hit = true; return; }
    const loop = m.type === 'WhileStat' || m.type === 'RepeatStat' || m.type === 'NumericForStat' || m.type === 'GenericForStat';
    for (const k of Object.keys(m)) if (k !== 'loc') visit(m[k], inLoop || loop);
  };
  visit(t, false);
  return hit;
}

export function forwardSubst(chunk: A.Chunk): number {
  const scope = analyzeScopes(chunk);
  let n = 0;
  const readCache = new Map<Binding, Set<A.NameExpr>>(), writeCache = new Map<Binding, Set<A.NameExpr>>();
  const reads = (b: Binding) => { let s = readCache.get(b); if (!s) { const w = new Set(b.writeRefs); s = new Set(b.refs.filter(r => !w.has(r))); readCache.set(b, s); } return s; };
  const writes = (b: Binding) => { let s = writeCache.get(b); if (!s) { s = new Set(b.writeRefs); writeCache.set(b, s); } return s; };
  const countIn = (node: any, set: Set<A.NameExpr>): number => { if (!set.size) return 0; let c = 0; walk(node, (m: any) => { if (m.type === 'NameExpr' && set.has(m)) c++; }); return c; };
  const readInFn = (node: any, set: Set<A.NameExpr>): boolean => { let hit = false; walk(node, (m: any) => { if (!hit && m.type === 'FunctionExpr' && countIn(m, set) > 0) hit = true; }); return hit; };
  /** clone an expression and keep the scope tables in sync for its names */
  const cloneScoped = (e: A.Expr): A.Expr => {
    const c = structuredClone(e);
    const a: A.NameExpr[] = [], b: A.NameExpr[] = [];
    walk(e, (m: any) => { if (m.type === 'NameExpr') a.push(m); });
    walk(c, (m: any) => { if (m.type === 'NameExpr') b.push(m); });
    a.forEach((orig, q) => { const bd = scope.refOf.get(orig); if (bd && b[q]) { scope.refOf.set(b[q], bd); bd.refs.push(b[q]); readCache.get(bd)?.add(b[q]); } });
    return c;
  };
  const directTarget = (t: A.Stat, ws: Set<A.NameExpr>) => t.type === 'AssignStat' && !t.op && t.targets.some(x => x.type === 'NameExpr' && ws.has(x));
  // statement lists that are whole function bodies: falling off their end kills every local
  const fnBodies = new Set<A.Stat[]>([chunk.body]);
  // `repeat <body> until cond`: cond sees the body's locals, so it is part of their scope
  const repeatCond = new Map<A.Stat[], A.Expr>();
  walk(chunk, (m: any) => { if (m.type === 'FunctionExpr') fnBodies.add(m.body); if (m.type === 'RepeatStat') repeatCond.set(m.body, m.cond); });
  const pureValue = (e: A.Expr): boolean => {
    const u = e.type === 'ParenExpr' ? e.expr : e;
    if (u.type === 'FunctionExpr') return true;
    if (u.type === 'TableExpr') return u.fields.every(f => (!f.key || pureValue(f.key)) && pureValue(f.value));
    const inf = stable(u, scope); return inf.ok && !inf.mem;
  };
  forEachStatList(chunk, (list) => {
    for (let i = 0; i < list.length; i++) {
      const s = list[i];
      let val: A.Expr | null = null, bx: Binding | undefined;
      if (s.type === 'AssignStat' && !s.op && s.targets.length === 1 && s.values.length === 1 && s.targets[0].type === 'NameExpr') { val = s.values[0]; bx = scope.refOf.get(s.targets[0]); }
      else if (s.type === 'LocalStat' && s.names.length === 1 && s.init.length === 1 && !(s.attribs && s.attribs[0])) { val = s.init[0]; bx = scope.bindings.find(b => b.decl === s && b.index === 0); }
      if (!val || !bx || bx.kind === 'global' || bx.captured || bx.capturedWrite) continue;
      const info = stable(val, scope);
      if (!info.ok || info.deps.has(bx)) continue;
      const rs = reads(bx), ws = writes(bx);
      if (!rs.size) continue;
      let useIdx = -1, blocked = false, exitSeen = false;
      for (let j = i + 1; j < list.length; j++) {
        const t = list[j];
        if (countIn(t, rs) > 0) { if (readInFn(t, rs)) blocked = true; else useIdx = j; break; }
        if (countIn(t, ws) > 0) {
          // dead store: unconditionally overwritten before any read
          if (s.type === 'AssignStat' && directTarget(t, ws) && !exitSeen && pureValue(val)) { list.splice(i, 1); i--; n++; }
          blocked = true; break;
        }
        if (loopExit(t)) exitSeen = true;
        const ef = effects(t, scope);
        let depW = false; for (const d of info.deps) if (countIn(t, writes(d)) > 0) depW = true;
        if (depW || (info.mem && (ef.call || ef.store))) { blocked = true; break; }
      }
      if (blocked || useIdx < 0) continue;
      const u = list[useIdx];
      const uses = countIn(u, rs);
      if (uses > 1 && !info.cheap) continue;
      // the reads inside u must happen before any side effect of u (compound statements: head only)
      if (u.type === 'WhileStat' || u.type === 'RepeatStat' || u.type === 'DoStat' || u.type === 'FunctionStat' || u.type === 'LocalFunctionStat') continue;
      if (u.type === 'IfStat') { if (countIn(u.clauses[0].cond, rs) !== uses) continue; if (info.mem && effects(u.clauses[0].cond, scope).call) continue; }
      if (u.type === 'NumericForStat') { const head = { a: u.from, b: u.to, c: u.step }; if (countIn(head, rs) !== uses) continue; if (info.mem && effects(head, scope).call) continue; }
      if (u.type === 'GenericForStat') { if (countIn(u.iters, rs) !== uses) continue; if (info.mem && effects(u.iters, scope).call) continue; }
      if (info.mem && (u.type === 'AssignStat' || u.type === 'LocalStat' || u.type === 'CallStat' || u.type === 'ReturnStat')) {
        const calls: any[] = []; walk(u, (m: any) => { if (m.type === 'CallExpr' || m.type === 'MethodCallExpr') calls.push(m); });
        // with several calls the evaluation order relative to the read is unclear; with one,
        // every read must sit inside it (callee/args are evaluated before the call runs)
        if (calls.length > 1) continue;
        if (calls.length === 1 && countIn(calls[0], rs) !== uses) continue;
      }
      // is x dead after u (u's reads get replaced)? The next statement touching x must be an
      // unconditional redefinition or a return, with no loop exit in between.
      let dead = false;
      if (s.type === 'AssignStat') {
        for (let j = useIdx; j < list.length; j++) {
          const t = list[j];
          if (loopExit(t)) break;
          const r = j === useIdx ? false : countIn(t, rs) > 0, w = countIn(t, ws) > 0;
          if (r) break;
          if (w) { dead = directTarget(t, ws) && (j !== useIdx || true); break; }
          if (t.type === 'ReturnStat') { dead = true; break; }
          if (j === list.length - 1 && fnBodies.has(list)) dead = true;
        }
      }
      // a local whose only references are the reads in u disappears with its declaration
      let localDead = false;
      if (s.type === 'LocalStat') { const all = new Set(bx.refs); const rc = repeatCond.get(list); localDead = countIn(list.slice(i + 1), all) + (rc ? countIn(rc, all) : 0) === uses; }
      if (localDead) dead = true;
      // a non-trivial value is only moved, never duplicated
      if (!info.cheap && !dead) continue;
      // rewrite (only the evaluated-first part for compound statements)
      const replaceIn = (node: any) => {
        for (const key of Object.keys(node)) {
          if (key === 'loc') continue;
          const v = node[key];
          if (Array.isArray(v)) { for (let q = 0; q < v.length; q++) { if (v[q] && v[q].type === 'NameExpr' && rs.has(v[q])) { v[q] = cloneScoped(val!); n++; } else if (v[q] && typeof v[q] === 'object' && v[q].type !== 'FunctionExpr') replaceIn(v[q]); } }
          else if (v && typeof v === 'object') { if (v.type === 'NameExpr' && rs.has(v)) { node[key] = cloneScoped(val!); n++; } else if (v.type !== 'FunctionExpr') replaceIn(v); }
        }
      };
      if (u.type === 'IfStat') { const h = { cond: u.clauses[0].cond }; replaceIn(h); u.clauses[0].cond = h.cond; }
      else if (u.type === 'NumericForStat') { const h = { from: u.from, to: u.to, step: u.step }; replaceIn(h); u.from = h.from; u.to = h.to; u.step = h.step; }
      else if (u.type === 'GenericForStat') { const h = { iters: u.iters }; replaceIn(h); }
      else replaceIn({ u });
      if (dead && (s.type === 'AssignStat' || localDead)) { list.splice(i, 1); i--; }
    }
  });
  return n;
}

/** `x op= e` -> `x = x op (e)` for plain names (identical semantics: a name target is
 *  evaluated once either way). Lets forwarding/folding see through accumulator chains. */
export function expandCompound(chunk: A.Chunk): number {
  let n = 0;
  walk(chunk, (m: any) => {
    if (m.type !== 'AssignStat' || !m.op || m.targets.length !== 1 || m.values.length !== 1 || m.targets[0].type !== 'NameExpr') return;
    const op = String(m.op).replace(/=$/, '');
    if (!PURE_BIN.has(op)) return;
    const t = m.targets[0] as A.NameExpr;
    m.values = [{ type: 'BinExpr', op, left: { type: 'NameExpr', name: t.name, loc: t.loc }, right: { type: 'ParenExpr', expr: m.values[0] } }];
    delete m.op;
    n++;
  });
  return n;
}
