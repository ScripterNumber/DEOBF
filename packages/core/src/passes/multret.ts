// Multiple-results fusion for VM residual code — universal (the pack helper is recognised structurally).
//
// A register VM passes "all results" between instructions through a top-of-stack marker. In the residual code
// of the interpreter this shows up as a pack of the call's results, a copy loop into the register table and a
// consumer that unpacks a register range up to the marker:
//
//   n, t = PACK(f(a))                       -- results of f, and their count
//   n = n + 106 - 1                         -- top = base + count - 1
//   j = 0
//   for i = 106, n do j = j + 1; R[i] = t[j] end
//   R[103] = R[103](table.unpack(R, 104, n))           ->   R[103] = R[103](R[104], R[105], f(a))
//
// Consumers: the last argument of a call, the last value of a return, and the list store
// `table.move(R, a, n, off, T)` (becomes a table constructor when T was created just before, otherwise a
// `table.pack` of the values). Fixed result counts — `n, t = PACK(f(a)); x = t[1]; y = t[2]` — become
// `x, y = f(a)`; a pack nobody reads becomes the plain call.
// Safety: the pack temporaries (n, t, j) must be dead after the consumer (liveness over the function's statement
// graph); everything the consumer evaluates before the unpacked range must be free of calls (the call f(a)
// now runs after it). Registers from the base upwards are not written any more: as in compiled code, the
// registers above a consumer's operands are assumed to be dead after it (reported by the caller).
import type * as A from '../ast.js';
import { analyzeScopes, Binding, ScopeInfo } from '../analysis/scope.js';
import { buildStmtCfg, visitExpr } from '../analysis/stmtcfg.js';

export interface MultretOptions {
  /** the varargs-packing helper: `n, t = PACK(...)` with t[i] the i-th value and n their count */
  isPack: (callee: A.Expr) => boolean;
}
export interface MultretResult { fused: number; fixed: number; setlists: number; varargs: number; skipped: Map<string, number>; }

const unparen = (e: A.Expr): A.Expr => { while (e && e.type === 'ParenExpr') e = e.expr; return e; };
const intLit = (e: A.Expr | undefined): number | null => {
  if (!e) return null;
  const u = unparen(e);
  if (u.type === 'NumberLit' && Number.isInteger(u.value)) return u.value;
  if (u.type === 'UnExpr' && u.op === '-') { const v = unparen(u.expr); if (v.type === 'NumberLit' && Number.isInteger(v.value)) return -v.value; }
  return null;
};
const isMulti = (e: A.Expr | undefined) => !!e && (e.type === 'CallExpr' || e.type === 'MethodCallExpr' || e.type === 'VarargLit');
const calleeName = (c: A.Expr): string => {
  const u = unparen(c);
  if (u.type === 'NameExpr') return u.name;
  if (u.type === 'MemberExpr' && unparen(u.obj).type === 'NameExpr') return (unparen(u.obj) as A.NameExpr).name + '.' + u.name;
  if (u.type === 'IndexExpr' && unparen(u.obj).type === 'NameExpr' && unparen(u.index).type === 'StringLit') return (unparen(u.obj) as A.NameExpr).name + '.' + (unparen(u.index) as A.StringLit).value;
  return '';
};
const num = (v: number): A.Expr => v < 0 ? { type: 'UnExpr', op: '-', expr: { type: 'NumberLit', value: -v, raw: String(-v) } as A.NumberLit } as A.UnExpr : { type: 'NumberLit', value: v, raw: String(v) } as A.NumberLit;
const clone = <T>(x: T): T => structuredClone(x);

/** statement lists of a function body (nested functions excluded) */
function forLists(body: A.Stat[], f: (list: A.Stat[]) => void) {
  f(body);
  for (const s of body) {
    switch (s.type) {
      case 'DoStat': case 'WhileStat': case 'RepeatStat': case 'NumericForStat': case 'GenericForStat': forLists(s.body, f); break;
      case 'IfStat': for (const c of s.clauses) forLists(c.body, f); if (s.elseBody) forLists(s.elseBody, f); break;
    }
  }
}

interface Group {
  list: A.Stat[];
  stmts: A.Stat[];            // pack, top marker, counter, copy loop (removed)
  pack: A.Stat; P: A.Expr; R: Binding; base: number;
  /** the temporaries of the group (dead after the consumer) and the top-marker expression */
  temps: Array<Binding | null>; isTop: (e: A.Expr) => boolean;
  consumer: A.Stat;
  extra: A.Stat[];            // the table-alias copy before a list store (removed with it)
  kind: 'arg' | 'setlist';
  unpack?: A.CallExpr; holder?: any; holderKey?: string; holderIndex?: number; from?: number;
  move?: A.CallExpr; alias?: Binding | null;
}

export function fuseMultret(chunk: A.Chunk, o: MultretOptions): MultretResult {
  const res: MultretResult = { fused: 0, fixed: 0, setlists: 0, varargs: 0, skipped: new Map() };
  function skip(why: string) { res.skipped.set(why, (res.skipped.get(why) ?? 0) + 1); }
  let any = false;
  visitAllCalls(chunk, (c) => { if (!any && c.args.length === 1 && isMulti(unparen(c.args[0])) && o.isPack(c.callee)) any = true; });
  if (!any) return res;
  const scope: ScopeInfo = analyzeScopes(chunk);
  let stored: Set<any> | null = null;
  const fns: Array<A.Chunk | A.FunctionExpr> = [chunk];
  visitAllFunctions(chunk, (f) => fns.push(f));
  for (const fn of fns) processFunction(fn);
  return res;

  function refB(e: A.Expr | undefined): Binding | null {
    const u = e && unparen(e);
    if (!u || u.type !== 'NameExpr') return null;
    const b = scope.refOf.get(u);
    return b && b.kind !== 'global' ? b : null;
  }
  function declB(s: A.LocalStat, q: number): Binding | null { return scope.bindings.find(b => b.decl === s && b.index === q) ?? null; }
  /** `n, t = PACK(e)` */
  function matchPack(s: A.Stat): { n: Binding; t: Binding; P: A.Expr } | null {
    let tg: Array<Binding | null>, val: A.Expr;
    if (s.type === 'AssignStat' && !s.op && s.targets.length === 2 && s.values.length === 1) { tg = s.targets.map(x => refB(x)); val = s.values[0]; }
    else if (s.type === 'LocalStat' && s.names.length === 2 && s.init.length === 1) { tg = [declB(s, 0), declB(s, 1)]; val = s.init[0]; }
    else return null;
    if (!tg[0] || !tg[1] || tg[0] === tg[1]) return null;
    const c = unparen(val);
    if (c.type !== 'CallExpr' || c.args.length !== 1 || !o.isPack(c.callee)) return null;
    const P = unparen(c.args[0]);
    if (!isMulti(P)) return null;
    return { n: tg[0], t: tg[1], P: c.args[0] };
  }
  /** e == x + c  ->  c */
  function linOff(e: A.Expr, b: Binding): number | null {
    const u = unparen(e);
    if (u.type === 'NameExpr') return scope.refOf.get(u) === b ? 0 : null;
    if (u.type === 'BinExpr' && (u.op === '+' || u.op === '-')) {
      const l = linOff(u.left, b), rl = intLit(u.right);
      if (l !== null && rl !== null) return u.op === '+' ? l + rl : l - rl;
      if (u.op === '+') { const ll = intLit(u.left), r = linOff(u.right, b); if (ll !== null && r !== null) return ll + r; }
    }
    return null;
  }
  function isStoredInto(r: A.NameExpr): boolean { return storedObjs().has(r); }
  function storedObjs(): Set<any> {
    if (stored) return stored;
    stored = new Set();
    const st = stored;
    const v = (node: any) => { if (!node || typeof node !== 'object') return; if (Array.isArray(node)) { node.forEach(v); return; } if (node.type === 'AssignStat') for (const t of node.targets) { const u = unparen(t); if (u.type === 'IndexExpr' || u.type === 'MemberExpr') st.add(unparen(u.obj)); } for (const k of Object.keys(node)) if (k !== 'loc') { const x = node[k]; if (x && typeof x === 'object') v(x); } };
    v(chunk);
    return st;
  }
  function refsAny(node: any, bs: Array<Binding | null>): boolean { let hit = false; visitExpr(node, (m) => { if (hit) return false; if (m.type === 'NameExpr') { const b = scope.refOf.get(m); if (b && bs.includes(b)) hit = true; } }); return hit; }
  function assigns(s: A.Stat, b: Binding): boolean { return (s.type === 'AssignStat' && s.targets.some(x => refB(x) === b)) || (s.type === 'LocalStat' && b.decl === s); }

  function processFunction(fn: A.Chunk | A.FunctionExpr) {
    const body = fn.body;
    const groups: Group[] = [];
    const fixed: Array<{ list: A.Stat[]; pack: A.Stat; P: A.Expr; n: Binding; t: Binding; copies: A.AssignStat[] }> = [];
    // the vararg prologue `local N, ARGS = PACK(...)` (read-only)
    let pro: { N: Binding; ARGS: Binding } | null = null;
    if (fn.type === 'FunctionExpr' && fn.vararg) for (const st of body) {
      if (st.type !== 'LocalStat' || st.names.length !== 2 || st.init.length !== 1) continue;
      const cx = unparen(st.init[0]);
      if (cx.type !== 'CallExpr' || cx.args.length !== 1 || unparen(cx.args[0]).type !== 'VarargLit' || !o.isPack(cx.callee)) continue;
      const N = declB(st, 0), ARGS = declB(st, 1);
      if (N && ARGS && !N.writeRefs.length && !ARGS.writeRefs.length && !N.capturedWrite && !ARGS.capturedWrite && !ARGS.refs.some(r => isStoredInto(r))) pro = { N, ARGS };
      break;
    }
    forLists(body, (list) => {
      for (let i = 0; i < list.length; i++) {
        // a pack whose results nobody takes is just the call (the helper itself has no effects)
        const cs = list[i];
        if (cs.type === 'CallStat' && cs.expr.type === 'CallExpr' && cs.expr.args.length === 1 && o.isPack(cs.expr.callee)) {
          const a = unparen(cs.expr.args[0]);
          if (a.type === 'VarargLit') { list.splice(i, 1); i--; res.fixed++; continue; }
          if (a.type === 'CallExpr' || a.type === 'MethodCallExpr') { list[i] = { type: 'CallStat', expr: a } as A.CallStat; res.fixed++; continue; }
        }
        if (pro) { const vg = matchVararg(list, i, pro); if (vg) { groups.push(vg); res.varargs++; i += vg.stmts.length - 1; continue; } }
        const pk = matchPack(list[i]);
        if (!pk || unparen(pk.P).type === 'VarargLit') continue;
        const g = matchGroup(list, i, pk);
        if (typeof g !== 'string') { groups.push(g); continue; }
        // fixed number of results: copies `x = t[q]`, q = 1, 2, … right after the pack
        const copies: A.AssignStat[] = [];
        for (let q = i + 1; q < list.length; q++) {
          const s = list[q];
          if (s.type !== 'AssignStat' || s.op || s.targets.length !== 1 || s.values.length !== 1) break;
          const v = unparen(s.values[0]);
          if (v.type !== 'IndexExpr' || refB(v.obj) !== pk.t || intLit(v.index) !== copies.length + 1) break;
          const tgt = unparen(s.targets[0]);
          if (tgt.type !== 'NameExpr' && tgt.type !== 'IndexExpr' && tgt.type !== 'MemberExpr') break;
          if (refsAny(tgt, [pk.n, pk.t]) || (tgt.type === 'NameExpr' && (refB(tgt) === pk.n || refB(tgt) === pk.t))) break;
          if (tgt.type !== 'NameExpr' && copies.some(c => { const b = refB(c.targets[0]); return !!b && refsAny(tgt, [b]); })) break;
          copies.push(s);
        }
        if (copies.length || g === 'no copy loop') fixed.push({ list, pack: list[i], P: pk.P, n: pk.n, t: pk.t, copies });
        else skip(g);
      }
    });
    if (!groups.length && !fixed.length) return;
    // liveness of the pack temporaries
    const temps = new Set<Binding>();
    for (const g of groups) { for (const b of g.temps) if (b) temps.add(b); if (g.alias) temps.add(g.alias); }
    for (const f of fixed) { temps.add(f.n); temps.add(f.t); }
    const live = liveness(body, temps);
    if (!live) { skip('goto in the function'); return; }
    const deadAfter = (s: A.Stat, bs: Array<Binding | null>): boolean => {
      for (const b of bs) { if (!b) continue; if (b.captured) return false; if (assigns(s, b)) continue; if (live.liveOut(s, b)) return false; }
      return true;
    };
    for (const g of groups) {
      if (!deadAfter(g.consumer, [...g.temps, g.alias ?? null])) { skip('pack temporaries still used after the consumer'); continue; }
      if (g.kind === 'arg') applyArg(g); else applySetlist(g, live);
    }
    for (const f of fixed) {
      const last = f.copies.length ? f.copies[f.copies.length - 1] : f.pack;
      if (!deadAfter(last, [f.n, f.t]) || f.copies.some(c => !deadAfter(c, [f.n]))) { skip('pack results read later'); continue; }
      if (f.pack.type === 'LocalStat') continue;
      const at = f.list.indexOf(f.pack); if (at < 0) continue;
      const P = unparen(f.P);
      let rep: A.Stat;
      if (f.copies.length) rep = { type: 'AssignStat', targets: f.copies.map(c => c.targets[0]), values: [P] } as A.AssignStat;
      else if (P.type === 'CallExpr' || P.type === 'MethodCallExpr') rep = { type: 'CallStat', expr: P } as A.CallStat;
      else continue;
      f.list.splice(at, 1 + f.copies.length, rep);
      res.fixed++;
    }
  }

  function matchGroup(list: A.Stat[], i: number, pk: { n: Binding; t: Binding; P: A.Expr }): Group | string {
    let q = i + 1;
    let off = 0;
    const stmts: A.Stat[] = [list[i]];
    const s2 = list[q];
    if (s2 && s2.type === 'AssignStat' && !s2.op && s2.targets.length === 1 && s2.values.length === 1 && refB(s2.targets[0]) === pk.n) {
      const c = linOff(s2.values[0], pk.n); if (c === null) return 'top marker not understood';
      off = c; q++; stmts.push(s2);
    }
    let j: Binding | null = null, j0: number | null = null;
    const s3 = list[q];
    if (s3 && s3.type === 'AssignStat' && !s3.op && s3.targets.length === 1 && s3.values.length === 1 && intLit(s3.values[0]) !== null) { j = refB(s3.targets[0]); j0 = intLit(s3.values[0]); if (j && j !== pk.n && j !== pk.t) q++; else j = null; }
    const lp = list[q];
    if (!lp || lp.type !== 'NumericForStat') return 'no copy loop';
    const base = intLit(lp.from);
    if (base === null || base !== off + 1 || refB(lp.to) !== pk.n || (lp.step && intLit(lp.step) !== 1)) return 'copy loop bounds not understood';
    const iv = scope.bindings.find(b => b.decl === lp && b.kind === 'for');
    if (!iv || iv.writeRefs.length) return 'copy loop variable written';
    // body: R[i] = t[j] with j counting 1, 2, …   or   R[i] = t[i - base + 1]
    let R: Binding | null = null;
    const isI = (e: A.Expr) => { const u = unparen(e); return u.type === 'NameExpr' && scope.refOf.get(u) === iv; };
    const store = (s: A.Stat): A.Expr | null => {
      if (s.type !== 'AssignStat' || s.op || s.targets.length !== 1 || s.values.length !== 1) return null;
      const tg = unparen(s.targets[0]); const v = unparen(s.values[0]);
      if (tg.type !== 'IndexExpr' || !isI(tg.index) || v.type !== 'IndexExpr' || refB(v.obj) !== pk.t) return null;
      R = refB(tg.obj);
      return v.index;
    };
    const inc = (s: A.Stat) => s.type === 'AssignStat' && !s.op && s.targets.length === 1 && s.values.length === 1 && j !== null && refB(s.targets[0]) === j && linOff(s.values[0], j) === 1;
    let ok = false;
    if (lp.body.length === 2 && j && j0 === 0 && inc(lp.body[0])) { const ix = store(lp.body[1]); ok = !!ix && refB(ix) === j; }
    else if (lp.body.length === 2 && j && j0 === 1 && inc(lp.body[1])) { const ix = store(lp.body[0]); ok = !!ix && refB(ix) === j; }
    else if (lp.body.length === 1) {
      const ix = store(lp.body[0]);
      if (ix) { const c = linOff(ix, iv); ok = c !== null && c === 1 - base; }
      if (ok && j) return 'statement between the pack and the copy loop';
    }
    if (!ok || !R) return 'copy loop body not understood';
    const Rb: Binding = R;
    if (Rb === pk.n || Rb === pk.t || Rb === j) return 'copy loop body not understood';
    if (j) stmts.push(s3);
    stmts.push(lp);
    const g: Group = { list, stmts, pack: list[i], P: pk.P, R: Rb, base, temps: [pk.n, pk.t, j], isTop: (e) => refB(e) === pk.n, consumer: lp, extra: [], kind: 'arg' };
    return consumerOf(list, q + 1, g);
  }
  /**
   * varargs copied into registers (`f(a, ...)` in a vararg function, with the prologue `local N, ARGS = PACK(...)`):
   *   c = N - np - 1; if c < 0 then c = -1 end; j = 0
   *   for i = base, base + c do R[i] = ARGS[np + 1 + j]; j = j + 1 end;  [top = base + c]
   *   consumer of table.unpack(R, a, base + c | top)        ->  R[a], …, R[base - 1], select(np + 1, ...)
   */
  function matchVararg(list: A.Stat[], i: number, pro: { N: Binding; ARGS: Binding }): Group | null {
    const s1 = list[i];
    if (s1.type !== 'AssignStat' || s1.op || s1.targets.length !== 1 || s1.values.length !== 1) return null;
    const c = refB(s1.targets[0]);
    if (!c || c === pro.N || c === pro.ARGS) return null;
    const off = linOff(s1.values[0], pro.N);
    if (off === null || off > -1) return null;
    const np = -off - 1;
    let q = i + 1;
    const stmts: A.Stat[] = [s1];
    // clamp: if c < 0 then c = -1 end   |   if not (c < 0) then else c = -1 end
    const cl = list[q];
    const isNeg = (e: A.Expr) => { const u = unparen(e); return u.type === 'BinExpr' && u.op === '<' && refB(u.left) === c && intLit(u.right) === 0; };
    const setM1 = (b: A.Stat[] | undefined) => !!b && b.length === 1 && b[0].type === 'AssignStat' && !b[0].op && b[0].targets.length === 1 && refB(b[0].targets[0]) === c && intLit(b[0].values[0]) === -1;
    if (cl && cl.type === 'IfStat' && cl.clauses.length === 1) {
      const cc = unparen(cl.clauses[0].cond);
      const ok = (isNeg(cc) && setM1(cl.clauses[0].body) && !cl.elseBody?.length) ||
        (cc.type === 'UnExpr' && cc.op === 'not' && isNeg(cc.expr) && cl.clauses[0].body.length === 0 && setM1(cl.elseBody));
      if (!ok) return null;
      stmts.push(cl); q++;
    } else return null;
    const s3 = list[q];
    if (!s3 || s3.type !== 'AssignStat' || s3.op || s3.targets.length !== 1 || s3.values.length !== 1 || intLit(s3.values[0]) === null) return null;
    const j = refB(s3.targets[0]); const j0 = intLit(s3.values[0])!;
    if (!j || j === c || j === pro.N || j === pro.ARGS) return null;
    stmts.push(s3); q++;
    const lp = list[q];
    if (!lp || lp.type !== 'NumericForStat' || lp.body.length !== 2 || (lp.step && intLit(lp.step) !== 1)) return null;
    const base = intLit(lp.from);
    if (base === null || linOff(lp.to, c) !== base) return null;
    const iv = scope.bindings.find(b => b.decl === lp && b.kind === 'for');
    if (!iv || iv.writeRefs.length) return null;
    let R: Binding | null = null, first: number | null = null;
    const store = (st: A.Stat, jval: number): boolean => {
      if (st.type !== 'AssignStat' || st.op || st.targets.length !== 1 || st.values.length !== 1) return false;
      const tg = unparen(st.targets[0]); const v = unparen(st.values[0]);
      if (tg.type !== 'IndexExpr' || unparen(tg.index).type !== 'NameExpr' || scope.refOf.get(unparen(tg.index) as A.NameExpr) !== iv) return false;
      if (v.type !== 'IndexExpr' || refB(v.obj) !== pro.ARGS) return false;
      const k = linOff(v.index, j); if (k === null) return false;
      R = refB(tg.obj); first = k + jval;
      return true;
    };
    const inc = (st: A.Stat) => st.type === 'AssignStat' && !st.op && st.targets.length === 1 && st.values.length === 1 && refB(st.targets[0]) === j && linOff(st.values[0], j) === 1;
    let ok = false;
    if (inc(lp.body[1])) ok = store(lp.body[0], j0);
    else if (inc(lp.body[0])) ok = store(lp.body[1], j0 + 1);
    if (!ok || !R || first !== np + 1) return null;
    const Rb: Binding = R;
    if (Rb === c || Rb === j || Rb === pro.ARGS || Rb === pro.N) return null;
    stmts.push(lp); q++;
    // optional `top = base + c`
    let top: Binding | null = null;
    const s5 = list[q];
    if (s5 && s5.type === 'AssignStat' && !s5.op && s5.targets.length === 1 && s5.values.length === 1 && linOff(s5.values[0], c) === base) {
      top = refB(s5.targets[0]);
      if (top && top !== c && top !== j && top !== pro.N && top !== pro.ARGS && top !== Rb) { stmts.push(s5); q++; } else top = null;
    }
    const va: A.Expr = np === 0 ? { type: 'VarargLit' } as A.VarargLit
      : { type: 'CallExpr', callee: { type: 'NameExpr', name: 'select' } as A.NameExpr, args: [num(np + 1), { type: 'VarargLit' } as A.VarargLit] } as A.CallExpr;
    const g: Group = { list, stmts, pack: s1, P: va, R: Rb, base, temps: [c, j, top], isTop: (e) => (top !== null && refB(e) === top) || linOff(e, c) === base, consumer: lp, extra: [], kind: 'arg' };
    const r = consumerOf(list, q, g);
    return typeof r === 'string' ? null : r;
  }
  /** the consumer at list[k]: an unpack in a multi-value position, or a list store */
  function consumerOf(list: A.Stat[], k: number, g: Group): Group | string {
    let c1 = list[k];
    if (!c1) return 'no consumer';
    if (c1.type === 'DoStat' && c1.body.length === 1 && c1.body[0].type === 'ReturnStat') c1 = c1.body[0];
    g.consumer = c1;
    const Rb = g.R;
    const arg = findUnpack(c1, g);
    if (arg === true) return g;
    // list store: [T = R[x];] table.move(R, a, n, off, T)
    let alias: Binding | null = null;
    if (c1.type === 'AssignStat' && !c1.op && c1.targets.length === 1 && c1.values.length === 1 && refB(c1.targets[0]) && unparen(c1.values[0]).type === 'IndexExpr' && refB((unparen(c1.values[0]) as A.IndexExpr).obj) === Rb && intLit((unparen(c1.values[0]) as A.IndexExpr).index) !== null) { alias = refB(c1.targets[0]); k++; }
    const mv = list[k];
    if (mv && mv.type === 'CallStat' && mv.expr.type === 'CallExpr' && calleeName(mv.expr.callee) === 'table.move' && mv.expr.args.length === 5 && refB(mv.expr.args[0]) === Rb && g.isTop(mv.expr.args[2])) {
      const a = intLit(mv.expr.args[1]);
      if (a === null || a > g.base) return 'list store range not understood';
      if (refsAny([mv.expr.args[1], mv.expr.args[3], mv.expr.args[4]], g.temps)) return 'list store range not understood';
      if (alias && alias !== refB(mv.expr.args[4])) return 'list store target not understood';
      if (alias && (g.temps.includes(alias) || alias.captured)) return 'list store target not understood';
      return { ...g, consumer: mv, extra: alias ? [c1] : [], kind: 'setlist', move: mv.expr, alias, from: a };
    }
    return typeof arg === 'string' ? arg : 'consumer not understood';
  }
  /** the consumer's `table.unpack(R, a, n)` in a multi-value position; true when found and usable */
  function findUnpack(s: A.Stat, g: Group): true | string | false {
    let found: { call: A.CallExpr; holder: any; key: string; index: number; path: any[] } | null = null;
    const visit = (node: any, parent: any, key: string, index: number, path: any[]) => {
      if (!node || typeof node !== 'object' || found) return;
      if (Array.isArray(node)) { node.forEach((x, i) => visit(x, parent, key, i, path)); return; }
      if (node.type === 'FunctionExpr') return;
      if (node.type === 'CallExpr' && /^(?:table\.)?unpack$/.test(calleeName(node.callee)) && node.args.length === 3 && refB(node.args[0]) === g.R && g.isTop(node.args[2])) { found = { call: node, holder: parent, key, index, path }; return; }
      const p2 = path.concat([node]);
      for (const k of Object.keys(node)) if (k !== 'loc') { const x = node[k]; if (x && typeof x === 'object') visit(x, node, k, -1, p2); }
    };
    visit(s, null, '', -1, []);
    if (!found) return false;
    const f = found as { call: A.CallExpr; holder: any; key: string; index: number; path: any[] };
    // the temporaries are read nowhere else in the consumer (a chained `n, t = PACK(…)` assigns them again)
    const targetNames = new Set<any>(s.type === 'AssignStat' ? s.targets.filter(x => unparen(x).type === 'NameExpr').map(x => unparen(x)) : []);
    const inTop = new Set<any>(); visitExpr(f.call.args[2], (m) => { inTop.add(m); });
    let bad = false;
    visitExpr(s, (m) => { if (m.type === 'NameExpr' && !targetNames.has(m) && !inTop.has(m)) { const b = scope.refOf.get(m); if (b && g.temps.includes(b)) bad = true; } });
    if (bad) return 'pack temporaries read by the consumer';
    const a = intLit(f.call.args[1]);
    if (a === null || a > g.base) return 'unpack range not understood';
    const h = f.holder;
    let okPos = false;
    if (h && (h.type === 'CallExpr' || h.type === 'MethodCallExpr') && f.key === 'args' && f.index === h.args.length - 1) okPos = true;
    if (h && h.type === 'ReturnStat' && f.key === 'args' && f.index === h.args.length - 1) okPos = true;
    if (!okPos) return 'unpack not in a multi-value position';
    // calls other than the chain holding the unpack would now run before the moved call
    const chain = new Set<any>(f.path);
    let calls = 0;
    visitExpr(s, (m) => { if ((m.type === 'CallExpr' || m.type === 'MethodCallExpr') && m !== f.call && !chain.has(m)) calls++; });
    if (calls) return 'consumer makes other calls';
    g.unpack = f.call; g.holder = h; g.holderKey = f.key; g.holderIndex = f.index; g.from = a;
    return true;
  }

  function regList(name: string, a: number, base: number): A.Expr[] {
    const out: A.Expr[] = [];
    for (let r = a; r < base; r++) out.push({ type: 'IndexExpr', obj: { type: 'NameExpr', name } as A.NameExpr, index: num(r) } as A.IndexExpr);
    return out;
  }
  function removeStmts(list: A.Stat[], stmts: A.Stat[]) { for (const s of stmts) { const at = list.indexOf(s); if (at >= 0) list.splice(at, 1); } }
  function applyArg(g: Group) {
    const arr = g.holder[g.holderKey!] as A.Expr[];
    if (arr[g.holderIndex!] !== g.unpack) { skip('consumer changed'); return; }
    const R = unparen(g.unpack!.args[0]) as A.NameExpr;
    arr.splice(g.holderIndex!, 1, ...regList(R.name, g.from!, g.base), unparen(g.P));
    removeStmts(g.list, g.stmts);
    res.fused++;
  }
  function applySetlist(g: Group, live: Liveness) {
    const mv = g.move!;
    const R = unparen(mv.args[0]) as A.NameExpr;
    const items = regList(R.name, g.from!, g.base);
    items.push(unparen(g.P));
    const off = intLit(mv.args[3]);
    const tgt = g.alias ? null : unparen(mv.args[4]);
    // constructor: `R[x] = {}` earlier in the same list, slot x untouched in between
    let x: number | null = null;
    if (g.alias) { const c1 = g.extra[0] as A.AssignStat; x = intLit((unparen(c1.values[0]) as A.IndexExpr).index); }
    else if (tgt && tgt.type === 'IndexExpr' && refB(tgt.obj) === g.R) x = intLit(tgt.index);
    if (off === 1 && x !== null && x < g.from!) {
      const list = g.list;
      const at = list.indexOf(g.pack);
      let mk = -1;
      for (let q = at - 1; q >= 0; q--) {
        const s = list[q];
        if (s.type === 'AssignStat' && !s.op && s.targets.length === 1 && s.values.length === 1) {
          const tg = unparen(s.targets[0]);
          if (tg.type === 'IndexExpr' && refB(tg.obj) === g.R && intLit(tg.index) === x) {
            const v = unparen(s.values[0]);
            if ((v.type === 'TableExpr' && v.fields.length === 0) || (v.type === 'CallExpr' && calleeName(v.callee) === 'table.create')) mk = q;
            break;
          }
        }
        if (touchesSlot(s, g.R, x)) break;
      }
      if (mk >= 0 && !(g.alias && live.liveOut(g.consumer, g.alias))) {
        const mkStat = list[mk] as A.AssignStat;
        const ctor: A.TableExpr = { type: 'TableExpr', fields: items.map(v => ({ kind: 'item', value: v } as A.TableField)) };
        const rep: A.AssignStat = { type: 'AssignStat', targets: [clone(mkStat.targets[0])], values: [ctor] };
        const ci = list.indexOf(g.consumer);
        list[ci] = rep;
        removeStmts(list, [mkStat, ...g.stmts, ...g.extra]);
        res.setlists++; res.fused++;
        return;
      }
    }
    // general: the values are packed and moved
    const name = 'items';
    const pack: A.CallExpr = { type: 'CallExpr', callee: { type: 'MemberExpr', obj: { type: 'NameExpr', name: 'table' } as A.NameExpr, name: 'pack' } as A.MemberExpr, args: items };
    const it = (k: string): A.Expr => ({ type: 'MemberExpr', obj: { type: 'NameExpr', name } as A.NameExpr, name: k } as A.MemberExpr);
    const doS: A.DoStat = { type: 'DoStat', body: [
      { type: 'LocalStat', names: [name], init: [pack] } as A.LocalStat,
      { type: 'CallStat', expr: { type: 'CallExpr', callee: clone(mv.callee), args: [{ type: 'NameExpr', name } as A.NameExpr, num(1), it('n'), clone(mv.args[3]), clone(mv.args[4])] } } as A.CallStat,
    ] };
    const ci = g.list.indexOf(g.consumer);
    g.list[ci] = doS;
    removeStmts(g.list, g.stmts);
    res.setlists++; res.fused++;
  }
  function touchesSlot(s: A.Stat, R: Binding, x: number): boolean {
    if (s.type === 'IfStat' || s.type === 'WhileStat' || s.type === 'RepeatStat' || s.type === 'NumericForStat' || s.type === 'GenericForStat' || s.type === 'DoStat') return true;
    let hit = false;
    visitExpr(s, (m) => {
      if (hit) return false;
      if (m.type === 'IndexExpr' && refB(m.obj) === R) { const k = intLit(m.index); if (k === null || k === x) hit = true; }
      if ((m.type === 'CallExpr' || m.type === 'MethodCallExpr') && m.args.some((a: A.Expr) => refB(a) === R)) {
        // a literal unpack range that does not cover x only reads other slots
        const lo = m.type === 'CallExpr' && /^(?:table\.)?unpack$/.test(calleeName(m.callee)) && refB(m.args[0]) === R ? intLit(m.args[1]) : null;
        const hi = lo !== null && m.args.length === 3 ? intLit(m.args[2]) : null;
        if (lo === null || hi === null || (x >= lo && x <= hi) || m.args.slice(1).some((a: A.Expr) => refB(a) === R)) hit = true;
      }
    });
    return hit;
  }
}

interface Liveness { liveOut(s: A.Stat, b: Binding): boolean; }
/** backward liveness of a few locals over the statement graph of one function body */
function liveness(body: A.Stat[], temps: Set<Binding>): Liveness | null {
  const cfg = buildStmtCfg(body);
  if (!cfg) return null;
  const idx = new Map<Binding, number>(); for (const b of temps) idx.set(b, idx.size);
  const W = Math.max(1, Math.ceil(idx.size / 32));
  const N = cfg.nodes.length;
  const use = cfg.nodes.map(() => new Uint32Array(W)), def = cfg.nodes.map(() => new Uint32Array(W));
  const set = (a: Uint32Array, b: Binding | undefined) => { const i = b ? idx.get(b) : undefined; if (i !== undefined) a[i >>> 5] |= 1 << (i & 31); };
  const refMap = new Map<A.NameExpr, Binding>();
  for (const b of temps) { for (const r of b.refs) refMap.set(r, b); }
  cfg.nodes.forEach((nd, n) => {
    visitExpr(nd.exprs, (m) => { if (m.type === 'NameExpr') { const b = refMap.get(m); if (b) set(use[n], b); } });
    const s: any = nd.stmt;
    if (nd.kind === 'stmt' && s) {
      if (s.type === 'AssignStat') for (const t of s.targets) { if (t.type === 'NameExpr') { const b = refMap.get(t); if (b) { if (s.op) set(use[n], b); set(def[n], b); } } }
      if (s.type === 'LocalStat') for (const b of temps) if (b.decl === s) set(def[n], b);
    }
    if (nd.kind === 'forvars' && s) for (const b of temps) if (b.decl === s) set(def[n], b);
  });
  const inS = cfg.nodes.map(() => new Uint32Array(W));
  const pred: number[][] = Array.from({ length: N }, () => []);
  cfg.nodes.forEach((nd, i) => nd.succ.forEach(t => pred[t].push(i)));
  const work: number[] = []; const inW = new Uint8Array(N);
  for (let i = 0; i < N; i++) { work.push(i); inW[i] = 1; }
  while (work.length) {
    const n = work.pop()!; inW[n] = 0;
    const out = new Uint32Array(W);
    for (const t of cfg.nodes[n].succ) for (let w = 0; w < W; w++) out[w] |= inS[t][w];
    let ch = false;
    for (let w = 0; w < W; w++) { const v = use[n][w] | (out[w] & ~def[n][w]); if (v !== inS[n][w]) { inS[n][w] = v; ch = true; } }
    if (ch) for (const p of pred[n]) if (!inW[p]) { inW[p] = 1; work.push(p); }
  }
  return {
    liveOut(s: A.Stat, b: Binding): boolean {
      const n = cfg.nodeOf.get(s); const i = idx.get(b);
      if (n === undefined || i === undefined) return true;
      for (const t of cfg.nodes[n].succ) if (inS[t][i >>> 5] & (1 << (i & 31))) return true;
      return false;
    },
  };
}

function visitAllCalls(node: any, f: (c: A.CallExpr) => void) {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) { for (const x of node) visitAllCalls(x, f); return; }
  if (node.type === 'CallExpr') f(node);
  for (const k of Object.keys(node)) if (k !== 'loc') { const x = node[k]; if (x && typeof x === 'object') visitAllCalls(x, f); }
}
function visitAllFunctions(node: any, f: (fn: A.FunctionExpr) => void) {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) { for (const x of node) visitAllFunctions(x, f); return; }
  if (node.type === 'FunctionExpr') f(node);
  for (const k of Object.keys(node)) if (k !== 'loc') { const x = node[k]; if (x && typeof x === 'object') visitAllFunctions(x, f); }
}