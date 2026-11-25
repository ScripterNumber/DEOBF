// Dead-store elimination by liveness — universal, conservative.
//
//   x = t; y = 8; …; x = 5; return f(x)     ->   …; x = 5; return f(x)
//
// Per function: a statement-level control-flow graph of the structured body (if / loops / break /
// continue / return), then backward liveness of its locals. An assignment whose targets are all
// locals that are dead afterwards is removed when its values have no effect (literals, names,
// closures, table constructors of such; with `pureIndex` also table reads), or reduced to the call
// when it is a single call. Locals referenced from nested functions are never touched (a call may
// read them), nor are functions with goto/labels.
import type * as A from '../ast.js';
import { analyzeScopes, Binding, ScopeInfo } from '../analysis/scope.js';
import { devEnv } from '../env.js';

const unparen = (e: A.Expr): A.Expr => { while (e && e.type === 'ParenExpr') e = e.expr; return e; };
export interface DeadStoreOptions { /** table reads have no side effects (no __index metamethods), e.g. VM residual code */ pureIndex?: boolean; }

class Bail extends Error {}

export function removeDeadStores(chunk: A.Chunk, o: DeadStoreOptions = {}): number {
  const scope = analyzeScopes(chunk);
  let removed = 0;
  const fns: Array<A.FunctionExpr | A.Chunk> = [chunk];
  const collect = (m: any) => { if (!m || typeof m !== 'object') return; if (Array.isArray(m)) { for (const x of m) collect(x); return; } if (m.type === 'FunctionExpr') fns.push(m); for (const k of Object.keys(m)) if (k !== 'loc') collect(m[k]); };
  collect(chunk.body);
  for (const fn of fns) { const t = Date.now(); try { removed += perFunction(fn, scope, o); } catch (e) { if (!(e instanceof Bail)) throw e; if (devEnv('PRISM_DS_TRACE')) console.error('[ds] bail', Date.now() - t, 'ms'); } if (devEnv('PRISM_DS_TRACE') && Date.now() - t > 50) console.error('[ds] slow fn', Date.now() - t, 'ms', (scope.fnBindings.get(fn) ?? []).length, 'bindings'); }
  return removed;
}

function perFunction(fn: A.FunctionExpr | A.Chunk, scope: ScopeInfo, o: DeadStoreOptions): number {
  const body = fn.type === 'Chunk' ? fn.body : fn.body;
  // tracked bindings: this function's own locals, never seen by a nested function
  const tracked = new Map<Binding, number>();
  for (const b of scope.fnBindings.get(fn) ?? []) if (!b.captured && b.kind !== 'global') tracked.set(b, tracked.size);
  if (!tracked.size) return 0;
  const W = Math.ceil(tracked.size / 32);
  interface Node { uses: Uint32Array; defs: Uint32Array; succ: number[]; stmt?: A.AssignStat; list?: A.Stat[]; }
  const nodes: Node[] = [];
  const mk = (): number => { nodes.push({ uses: new Uint32Array(W), defs: new Uint32Array(W), succ: [] }); return nodes.length - 1; };
  const set = (bs: Uint32Array, i: number) => { bs[i >>> 5] |= 1 << (i & 31); };
  const has = (bs: Uint32Array, i: number) => (bs[i >>> 5] & (1 << (i & 31))) !== 0;
  const useIn = (n: number, e: any) => {
    const v = (m: any) => {
      if (!m || typeof m !== 'object') return;
      if (Array.isArray(m)) { for (const x of m) v(x); return; }
      if (m.type === 'FunctionExpr') return;
      if (m.type === 'NameExpr') { const b = scope.refOf.get(m); const i = b ? tracked.get(b) : undefined; if (i !== undefined) set(nodes[n].uses, i); return; }
      for (const k of Object.keys(m)) if (k !== 'loc') v(m[k]);
    };
    v(e);
  };
  const defName = (n: number, nm: A.NameExpr) => { const b = scope.refOf.get(nm); const i = b ? tracked.get(b) : undefined; if (i !== undefined) set(nodes[n].defs, i); };
  const byDecl = new Map<any, Map<number, number>>();
  for (const [b, i] of tracked) { let m = byDecl.get(b.decl); if (!m) { m = new Map(); byDecl.set(b.decl, m); } m.set(b.index, i); }
  const defBinding = (n: number, decl: any, idx: number) => { const i = byDecl.get(decl)?.get(idx); if (i !== undefined) set(nodes[n].defs, i); };
  interface Loop { brk: number; cont: number; }
  /** first-clause condition node of every if statement, with its statement list */
  const ifCond = new Map<A.IfStat, { node: number; list: A.Stat[] }>();
  const seq = (stmts: A.Stat[], next: number, L: Loop | null): number => { let cur = next; for (let i = stmts.length - 1; i >= 0; i--) cur = stat(stmts[i], cur, L, stmts); return cur; };
  const stat = (s: A.Stat, next: number, L: Loop | null, list: A.Stat[]): number => {
    switch (s.type) {
      case 'AssignStat': {
        const n = mk(); nodes[n].succ.push(next);
        useIn(n, s.values);
        for (const t of s.targets) {
          const u = unparen(t);
          if (u.type === 'NameExpr') { if (s.op) useIn(n, u); defName(n, u); }
          else useIn(n, u);
        }
        nodes[n].stmt = s; nodes[n].list = list;
        return n;
      }
      case 'LocalStat': { const n = mk(); nodes[n].succ.push(next); useIn(n, s.init); s.names.forEach((_, i) => defBinding(n, s, i)); return n; }
      case 'CallStat': { const n = mk(); nodes[n].succ.push(next); useIn(n, s.expr); return n; }
      case 'DoStat': return seq(s.body, next, L);
      case 'IfStat': {
        let alt = s.elseBody ? seq(s.elseBody, next, L) : next;
        for (let i = s.clauses.length - 1; i >= 0; i--) {
          const c = s.clauses[i];
          const n = mk(); useIn(n, c.cond);
          nodes[n].succ.push(seq(c.body, next, L), alt);
          alt = n;
        }
        ifCond.set(s, { node: alt, list });
        return alt;
      }
      case 'WhileStat': {
        const h = mk(); useIn(h, s.cond);
        const b = seq(s.body, h, { brk: next, cont: h });
        nodes[h].succ.push(b, next);
        return h;
      }
      case 'RepeatStat': {
        const c = mk(); useIn(c, s.cond);
        const b = seq(s.body, c, { brk: next, cont: c });
        nodes[c].succ.push(next, b);
        return b;
      }
      case 'NumericForStat': {
        const init = mk(); useIn(init, [s.from, s.to, s.step]);
        const h = mk(); defBinding(h, s, 0);
        const b = seq(s.body, h, { brk: next, cont: h });
        nodes[h].succ.push(b, next); nodes[init].succ.push(h);
        return init;
      }
      case 'GenericForStat': {
        const init = mk(); useIn(init, s.iters);
        const h = mk(); s.names.forEach((_, i) => defBinding(h, s, i));
        const b = seq(s.body, h, { brk: next, cont: h });
        nodes[h].succ.push(b, next); nodes[init].succ.push(h);
        return init;
      }
      case 'ReturnStat': { const n = mk(); useIn(n, s.args); return n; }
      case 'BreakStat': { const n = mk(); if (L) nodes[n].succ.push(L.brk); return n; }
      case 'ContinueStat': { const n = mk(); if (L) nodes[n].succ.push(L.cont); return n; }
      case 'GotoStat': case 'LabelStat': throw new Bail();
      case 'FunctionStat': { const n = mk(); nodes[n].succ.push(next); const t = unparen(s.target as A.Expr); if (t.type === 'NameExpr') defName(n, t); else useIn(n, t); return n; }
      case 'LocalFunctionStat': { const n = mk(); nodes[n].succ.push(next); for (const i of byDecl.get(s)?.values() ?? []) set(nodes[n].defs, i); return n; }
      default: { const n = mk(); nodes[n].succ.push(next); useIn(n, s); return n; }
    }
  };
  const T0 = Date.now();
  const exit = mk();
  seq(body, exit, null);
  const T1 = Date.now();
  // backward liveness (worklist)
  const N = nodes.length;
  const liveIn = Array.from({ length: N }, () => new Uint32Array(W));
  const liveOut = Array.from({ length: N }, () => new Uint32Array(W));
  const preds: number[][] = Array.from({ length: N }, () => []);
  for (let i = 0; i < N; i++) for (const s of nodes[i].succ) preds[s].push(i);
  const work: number[] = []; const inWork = new Uint8Array(N);
  // nodes are numbered from the end of the body backwards: pop the lowest (latest code) first
  for (let i = N - 1; i >= 0; i--) { work.push(i); inWork[i] = 1; }
  let guard = 0;
  while (work.length) {
    if (++guard > 50_000_000) throw new Bail();
    const i = work.pop()!; inWork[i] = 0;
    const out = liveOut[i];
    for (const s of nodes[i].succ) { const li = liveIn[s]; for (let w = 0; w < W; w++) out[w] |= li[w]; }
    const nin = liveIn[i]; const u = nodes[i].uses, d = nodes[i].defs;
    let changed = false;
    for (let w = 0; w < W; w++) { const v = (u[w] | (out[w] & ~d[w])) >>> 0; if (v !== nin[w]) { nin[w] = v; changed = true; } }
    if (changed) for (const p of preds[i]) if (!inWork[p]) { inWork[p] = 1; work.push(p); }
  }
  if (devEnv('PRISM_DS_TRACE')) console.error(`[ds] nodes ${N} tracked ${tracked.size} W ${W} iterations ${guard} build ${T1 - T0}ms fix ${Date.now() - T1}ms`);
  // dead assignments
  const pure = (e: A.Expr): boolean => {
    const u = unparen(e);
    switch (u.type) {
      case 'NilLit': case 'TrueLit': case 'FalseLit': case 'NumberLit': case 'StringLit': case 'NameExpr': case 'FunctionExpr': case 'VarargLit': return true;
      case 'TableExpr': return u.fields.every(f => (!f.key || pure(f.key)) && pure(f.value));
      case 'IndexExpr': return !!o.pureIndex && pure(u.obj) && pure(u.index);
      case 'MemberExpr': return !!o.pureIndex && pure(u.obj);
      case 'UnExpr': return u.op === 'not' && pure(u.expr);
      default: return false;
    }
  };
  let removed = 0;
  const kill = new Map<A.Stat[], Map<A.Stat, A.Stat | null>>();
  for (let i = 0; i < N; i++) {
    const nd = nodes[i]; const s = nd.stmt; if (!s || s.op) continue;
    let allDead = true;
    for (const t of s.targets) {
      const u = unparen(t);
      if (u.type !== 'NameExpr') { allDead = false; break; }
      const b = scope.refOf.get(u); const ix = b ? tracked.get(b) : undefined;
      if (ix === undefined || has(liveOut[i], ix)) { allDead = false; break; }
    }
    if (!allDead) continue;
    let repl: A.Stat | null | undefined;
    if (s.values.every(pure)) repl = null;
    else if (s.values.length === 1 && (unparen(s.values[0]).type === 'CallExpr' || unparen(s.values[0]).type === 'MethodCallExpr')) repl = { type: 'CallStat', expr: unparen(s.values[0]) as any } as A.Stat;
    if (repl === undefined) continue;
    if (!kill.has(nd.list!)) kill.set(nd.list!, new Map());
    kill.get(nd.list!)!.set(s, repl);
  }
  for (const [list, m] of kill) {
    for (let j = list.length - 1; j >= 0; j--) {
      if (!m.has(list[j])) continue;
      const r = m.get(list[j])!;
      if (r) list[j] = r; else list.splice(j, 1);
      removed++;
    }
  }
  // condition temporaries: `x = E; if x then` (adjacent) where x is dead once the condition has read it
  // -> `if E then` (E is evaluated at the same point either way)
  const callFree = (e: any): boolean => { let ok = true; const v = (m: any) => { if (!ok || !m || typeof m !== 'object') return; if (Array.isArray(m)) { for (const x of m) v(x); return; } if (m.type === 'CallExpr' || m.type === 'MethodCallExpr' || m.type === 'FunctionExpr' || m.type === 'VarargLit') { ok = false; return; } for (const k of Object.keys(m)) if (k !== 'loc') v(m[k]); }; v(e); return ok; };
  for (const [ifs, { node, list }] of ifCond) {
    const j = list.indexOf(ifs); if (j <= 0) continue;
    const d = list[j - 1];
    if (d.type !== 'AssignStat' || d.op || d.targets.length !== 1 || d.values.length !== 1) continue;
    const t = unparen(d.targets[0]); if (t.type !== 'NameExpr') continue;
    const b = scope.refOf.get(t); const ix = b ? tracked.get(b) : undefined;
    if (ix === undefined || has(liveOut[node], ix)) continue;
    const cond = ifs.clauses[0].cond;
    const reads: Array<{ parent: any; key: string }> = [];
    const find = (m: any, parent: any, key: string) => { if (!m || typeof m !== 'object') return; if (Array.isArray(m)) { m.forEach((x, q) => find(x, m, String(q))); return; } if (m.type === 'NameExpr' && scope.refOf.get(m) === b) { reads.push({ parent, key }); return; } for (const k of Object.keys(m)) if (k !== 'loc') find(m[k], m, k); };
    const holder = { cond };
    find(cond, holder, 'cond');
    if (reads.length !== 1) continue;
    const cu = unparen(cond);
    const direct = (cu.type === 'NameExpr') || (cu.type === 'UnExpr' && cu.op === 'not' && unparen(cu.expr).type === 'NameExpr');
    if (!direct && !(callFree(d.values[0]) && callFree(cond))) continue;
    const v = d.values[0];
    const u = unparen(v);
    const simple = u.type === 'NameExpr' || u.type === 'NumberLit' || u.type === 'StringLit' || u.type === 'TrueLit' || u.type === 'FalseLit' || u.type === 'NilLit' || u.type === 'IndexExpr' || u.type === 'CallExpr' || u.type === 'MethodCallExpr';
    reads[0].parent[reads[0].key] = simple ? v : { type: 'ParenExpr', expr: v };
    ifs.clauses[0].cond = holder.cond;
    list.splice(j - 1, 1);
    removed++;
  }
  return removed;
}
