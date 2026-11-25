// CFF (control-flow flattening) recovery — universal and semantics-preserving.
//
//  * guardConstProp: inside `if V == K then BODY` (and in the branches after a failed
//    `V ~= K` test) every read of the uncaptured local V that happens before V can
//    change is replaced by K. State transitions such as `V = f(V, 72)` become
//    literal arithmetic that the fold pass evaluates.
//
//  * unflattenStateLoops: a dispatcher loop
//        V = K0
//        while true do            -- or `repeat … until false`, `while V do`, `while V ~= Kx do`
//          if V == K1 then B1 elseif V < K2 then … end   -- if-chain or binary search tree
//        end
//    whose reachable blocks all end in a constant transition (`V = K`,
//    `V = c and K1 or K2`, `if c then …; V = K1 else …; V = K2 end`), `break` or
//    `return` is rebuilt as structured code: sequences, if/else (joins found with
//    post-dominators) and `while true do … end` loops for cyclic state graphs.
//    Unreachable blocks (junk states) disappear.
import type * as A from '../ast.js';
import { walk } from '../ast.js';
import { analyzeScopes, Binding, ScopeInfo } from '../analysis/scope.js';
import { forEachStatList } from './scopepasses.js';
import { fold } from './fold.js';
import { eliminateDeadCode } from './deadcode.js';
import { print } from '../printer.js';

const unparen = (e: A.Expr): A.Expr => { while (e && e.type === 'ParenExpr') e = e.expr; return e; };

/** literal key: numbers and strings only (the values a state variable takes) */
function litKey(e: A.Expr | undefined): string | null {
  if (!e) return null;
  const u = unparen(e);
  if (u.type === 'NumberLit') return 'n:' + u.value;
  if (u.type === 'UnExpr' && u.op === '-') { const v = unparen(u.expr); if (v.type === 'NumberLit') return 'n:' + (-v.value); }
  if (u.type === 'StringLit') return 's:' + u.value;
  return null;
}
function keyExpr(k: string): A.Expr {
  if (k.startsWith('n:')) { const v = Number(k.slice(2)); return v < 0 ? { type: 'UnExpr', op: '-', expr: { type: 'NumberLit', value: -v, raw: String(-v) } } : { type: 'NumberLit', value: v, raw: String(v) }; }
  const s = k.slice(2); return { type: 'StringLit', value: s, raw: JSON.stringify(s) };
}
const clone = <T>(x: T): T => structuredClone(x);

interface Guard { b: Binding; k: string; }
function guardOn(cond: A.Expr, scope: ScopeInfo, want: '==' | '~='): Guard | null {
  let c = unparen(cond);
  let neg = false;
  if (c.type === 'UnExpr' && c.op === 'not') { c = unparen(c.expr); neg = true; }
  if (c.type !== 'BinExpr' || (c.op !== '==' && c.op !== '~=')) return null;
  const op = (c.op === '==') !== neg ? '==' : '~=';
  if (op !== want) return null;
  const l = unparen(c.left), r = unparen(c.right);
  let name: A.NameExpr | null = null, k: string | null = null;
  if (l.type === 'NameExpr') { name = l; k = litKey(r); } else if (r.type === 'NameExpr') { name = r; k = litKey(l); }
  if (!name || k === null) return null;
  const b = scope.refOf.get(name);
  if (!b || b.kind === 'global' || b.capturedWrite) return null;
  return { b, k };
}

// ---------------------------------------------------------------- guardConstProp
export function guardConstProp(chunk: A.Chunk): number {
  const scope = analyzeScopes(chunk);
  let n = 0;
  const writeSets = new Map<Binding, Set<A.NameExpr>>();
  const wset = (b: Binding) => { let s = writeSets.get(b); if (!s) { s = new Set(b.writeRefs); writeSets.set(b, s); } return s; };
  const writes = (node: any, b: Binding): boolean => {
    const ws = wset(b); if (!ws.size) return false;
    let hit = false;
    walk(node, (m: any) => { if (!hit && m.type === 'NameExpr' && ws.has(m)) hit = true; });
    return hit;
  };
  /** replace reads of b inside an expression tree (never entering functions) */
  const substExpr = (node: any, b: Binding, k: string): void => {
    if (!node || typeof node !== 'object') return;
    const ws = wset(b);
    const isRead = (e: any) => e && e.type === 'NameExpr' && scope.refOf.get(e) === b && !ws.has(e);
    for (const key of Object.keys(node)) {
      if (key === 'loc') continue;
      const v = node[key];
      if (Array.isArray(v)) {
        for (let i = 0; i < v.length; i++) {
          if (isRead(v[i])) { v[i] = keyExpr(k); n++; } else if (v[i] && typeof v[i] === 'object' && v[i].type !== 'FunctionExpr') substExpr(v[i], b, k);
        }
      } else if (v && typeof v === 'object') {
        if (isRead(v)) { node[key] = keyExpr(k); n++; } else if (v.type !== 'FunctionExpr') substExpr(v, b, k);
      }
    }
  };
  const substTargets = (targets: A.Expr[], b: Binding, k: string) => {
    for (const t of targets) { if (t.type === 'IndexExpr') { substExpr(t, b, k); } else if (t.type === 'MemberExpr') substExpr(t, b, k); }
  };
  /** true while b is still known to equal k after the statements */
  const applyBody = (body: A.Stat[], b: Binding, k: string): boolean => {
    for (const s of body) if (!applyStat(s, b, k)) return false;
    return true;
  };
  const applyStat = (s: A.Stat, b: Binding, k: string): boolean => {
    switch (s.type) {
      case 'LocalStat': for (const e of s.init) substExpr({ e }, b, k); s.init = s.init.map(e => { const h = { e }; substExpr(h, b, k); return h.e; }); return true;
      case 'AssignStat': {
        const w = writes(s, b);
        const h = { values: s.values }; substExpr(h, b, k);
        if (!s.op) substTargets(s.targets, b, k);
        return !w;
      }
      case 'CallStat': { const h = { e: s.expr }; substExpr(h, b, k); s.expr = h.e as any; return true; }
      case 'ReturnStat': { const h = { args: s.args }; substExpr(h, b, k); return true; }
      case 'IfStat': {
        const w = writes(s, b);
        for (const c of s.clauses) { const h = { e: c.cond }; substExpr(h, b, k); c.cond = h.e; }
        for (const c of s.clauses) applyBody(c.body, b, k);
        if (s.elseBody) applyBody(s.elseBody, b, k);
        return !w;
      }
      case 'WhileStat': case 'RepeatStat': {
        if (writes(s, b)) return false;
        const h = { e: s.cond }; substExpr(h, b, k); s.cond = h.e;
        applyBody(s.body, b, k); return true;
      }
      case 'NumericForStat': {
        const h = { from: s.from, to: s.to, step: s.step }; substExpr(h, b, k); s.from = h.from; s.to = h.to; s.step = h.step;
        if (writes(s, b)) return false;
        applyBody(s.body, b, k); return true;
      }
      case 'GenericForStat': {
        const h = { iters: s.iters }; substExpr(h, b, k);
        if (writes(s, b)) return false;
        applyBody(s.body, b, k); return true;
      }
      case 'DoStat': return applyBody(s.body, b, k);
      case 'LabelStat': case 'GotoStat': return false;
      default: return !writes(s, b);
    }
  };
  walk(chunk, (node: any) => {
    if (node.type !== 'IfStat') return;
    const st = node as A.IfStat;
    let known: Guard | null = null;     // from an earlier failed `V ~= K`
    st.clauses.forEach((cl) => {
      if (known) { const h = { e: cl.cond }; substExpr(h, known.b, known.k); cl.cond = h.e; applyBody(cl.body, known.b, known.k); }
      const g = guardOn(cl.cond, scope, '==');
      if (g) applyBody(cl.body, g.b, g.k);
      if (!known) { const ne = guardOn(cl.cond, scope, '~='); if (ne) known = ne; }
    });
    if (known && st.elseBody) applyBody(st.elseBody, (known as Guard).b, (known as Guard).k);
  });
  return n;
}

// ---------------------------------------------------------------- unflattenStateLoops
interface Pred { e: A.Expr; truth: boolean; isV: (e: A.Expr) => boolean; memo: Map<string, boolean | null>; }
interface Constraint { lo: number; hi: number; excl: Set<number>; eqStr?: string; neStr: Set<string>; preds: Pred[]; }
interface Leaf { c: Constraint; body: A.Stat[]; }
const EMPTY = (): Constraint => ({ lo: -Infinity, hi: Infinity, excl: new Set(), neStr: new Set(), preds: [] });
const PURE_OPS = new Set(['+', '-', '*', '/', '//', '%', '^', '..', '==', '~=', '<', '<=', '>', '>=', 'and', 'or']);
/** condition built only from V, literals, arithmetic/logic and bit32.* calls */
function pureOnV(e: A.Expr, isV: (e: A.Expr) => boolean): boolean {
  let usesV = false;
  const ok = (x: A.Expr): boolean => {
    switch (x.type) {
      case 'NumberLit': case 'StringLit': case 'TrueLit': case 'FalseLit': case 'NilLit': return true;
      case 'ParenExpr': return ok(x.expr);
      case 'NameExpr': if (isV(x)) { usesV = true; return true; } return false;
      case 'BinExpr': return PURE_OPS.has(x.op) && ok(x.left) && ok(x.right);
      case 'UnExpr': return (x.op === '-' || x.op === 'not') && ok(x.expr);
      case 'CallExpr': return x.callee.type === 'MemberExpr' && x.callee.obj.type === 'NameExpr' && x.callee.obj.name === 'bit32' && !isV(x.callee.obj) && x.args.every(ok);
      default: return false;
    }
  };
  return ok(e) && usesV;
}
/** truth of a pure condition for V := key (null if it does not fold to a literal) */
function evalPred(p: Pred, key: string): boolean | null {
  const m = p.memo.get(key); if (m !== undefined) return m;
  const c: A.Expr = structuredClone(p.e);
  const sub = (node: any): any => {
    if (!node || typeof node !== 'object') return node;
    if (node.type === 'NameExpr' && p.isV(node)) return keyExpr(key);
    for (const k of Object.keys(node)) { if (k === 'loc') continue; const v = node[k]; if (Array.isArray(v)) node[k] = v.map(sub); else if (v && typeof v === 'object') node[k] = sub(v); }
    return node;
  };
  const ret: A.ReturnStat = { type: 'ReturnStat', args: [sub(c)] };
  fold({ type: 'Chunk', body: [ret] });
  const r = unparen(ret.args[0]);
  const v = r.type === 'TrueLit' ? true : r.type === 'FalseLit' || r.type === 'NilLit' ? false : (r.type === 'NumberLit' || r.type === 'StringLit') ? true : null;
  p.memo.set(key, v);
  return v;
}
const NEG: Record<string, string> = { '<': '>=', '<=': '>', '>': '<=', '>=': '<', '==': '~=', '~=': '==' };
const FLIP: Record<string, string> = { '<': '>', '<=': '>=', '>': '<', '>=': '<=', '==': '==', '~=': '~=' };

interface Cmp { op: string; k: string; }
function cmpOn(cond: A.Expr, isV: (e: A.Expr) => boolean): Cmp | null {
  const c = unparen(cond);
  if (c.type === 'UnExpr' && c.op === 'not') { const p = cmpOn(c.expr, isV); return p ? { op: NEG[p.op], k: p.k } : null; }
  if (c.type !== 'BinExpr' || !(c.op in FLIP)) return null;
  const l = unparen(c.left), r = unparen(c.right);
  if (isV(l)) { const k = litKey(r); return k ? { op: c.op, k } : null; }
  if (isV(r)) { const k = litKey(l); return k ? { op: FLIP[c.op], k } : null; }
  return null;
}
function applyC(c: Constraint, p: Cmp): Constraint {
  const n: Constraint = { lo: c.lo, hi: c.hi, excl: new Set(c.excl), eqStr: c.eqStr, neStr: new Set(c.neStr), preds: c.preds };
  if (p.k.startsWith('s:')) {
    const s = p.k.slice(2);
    if (p.op === '==') { n.eqStr = s; n.lo = 1; n.hi = 0; } else if (p.op === '~=') n.neStr.add(s); else { n.lo = 1; n.hi = 0; n.eqStr = undefined; n.neStr.add('\0all'); }
    return n;
  }
  const k = Number(p.k.slice(2));
  switch (p.op) {
    case '<': n.hi = Math.min(n.hi, k - 1e-9); break;
    case '<=': n.hi = Math.min(n.hi, k); break;
    case '>': n.lo = Math.max(n.lo, k + 1e-9); break;
    case '>=': n.lo = Math.max(n.lo, k); break;
    case '==': n.lo = Math.max(n.lo, k); n.hi = Math.min(n.hi, k); n.neStr.add('\0all'); break;
    case '~=': n.excl.add(k); break;
  }
  return n;
}
function admits(c: Constraint, key: string): boolean {
  if (key.startsWith('s:')) { const s = key.slice(2); if (c.neStr.has('\0all') || c.neStr.has(s)) return false; if (c.eqStr !== undefined) { if (c.eqStr !== s) return false; } else if (!(c.lo === -Infinity && c.hi === Infinity && c.excl.size === 0)) return false; }
  else {
    if (c.eqStr !== undefined) return false;
    const v = Number(key.slice(2));
    if (!(v >= c.lo && v <= c.hi && !c.excl.has(v))) return false;
  }
  for (const p of c.preds) { const t = evalPred(p, key); if (t === null || t !== p.truth) return false; }
  return true;
}
const withPred = (c: Constraint, p: Pred): Constraint => ({ ...c, excl: new Set(c.excl), neStr: new Set(c.neStr), preds: [...c.preds, p] });
/** flatten an if-chain / search tree over V into leaves; null if some test is not on V */
function flattenTree(ifs: A.IfStat, isV: (e: A.Expr) => boolean, c0: Constraint, out: Leaf[]): boolean {
  let c = c0;
  for (const cl of ifs.clauses) {
    const p = cmpOn(cl.cond, isV);
    if (p) {
      if (!subtree(cl.body, isV, applyC(c, p), out)) return false;
      c = applyC(c, { op: NEG[p.op], k: p.k });
      continue;
    }
    // compound test on V only (`V < 55 and V > 1`, `bit32.band(V, 3) == 0` …): exact per-state evaluation
    if (!pureOnV(cl.cond, isV)) {
      // `if V < K then A elseif cond then B else C end`: a leaf whose own if-chain was merged into the
      // tree node (else + if -> elseif) — the remaining clauses form that leaf's body
      const q = ifs.clauses.indexOf(cl);
      if (q === 0) return false;
      out.push({ c, body: [{ type: 'IfStat', clauses: ifs.clauses.slice(q), elseBody: ifs.elseBody }] });
      return true;
    }
    const memo = new Map<string, boolean | null>();
    if (!subtree(cl.body, isV, withPred(c, { e: cl.cond, truth: true, isV, memo }), out)) return false;
    c = withPred(c, { e: cl.cond, truth: false, isV, memo });
  }
  return subtree(ifs.elseBody ?? [], isV, c, out);
}
function subtree(body: A.Stat[], isV: (e: A.Expr) => boolean, c: Constraint, out: Leaf[]): boolean {
  if (body.length === 1 && body[0].type === 'IfStat' && (cmpOn(body[0].clauses[0].cond, isV) || pureOnV(body[0].clauses[0].cond, isV))) return flattenTree(body[0], isV, c, out);
  out.push({ c, body });
  return true;
}

/** break/continue binding to the dispatcher loop anywhere in stmts (not in nested loops/functions) */
function loopExits(stmts: A.Stat[]): boolean {
  let hit = false;
  const scan = (list: A.Stat[]) => {
    for (const s of list) {
      if (hit) return;
      if (s.type === 'BreakStat' || s.type === 'ContinueStat' || s.type === 'GotoStat' || s.type === 'LabelStat') { hit = true; return; }
      if (s.type === 'IfStat') { for (const c of s.clauses) scan(c.body); if (s.elseBody) scan(s.elseBody); }
      else if (s.type === 'DoStat') scan(s.body);
    }
  };
  scan(stmts); return hit;
}
function endsWithExit(stmts: A.Stat[]): boolean {
  const last = stmts[stmts.length - 1];
  if (!last) return false;
  if (last.type === 'ReturnStat') return true;
  if (last.type === 'DoStat') return endsWithExit(last.body);
  if (last.type === 'IfStat') return !!last.elseBody && last.clauses.every(c => endsWithExit(c.body)) && endsWithExit(last.elseBody);
  return false;
}

/** exit carries the value V holds when the dispatcher is left (litKey, or 'nil' / 'false' / 'true') */
type Target = { kind: 'state'; k: string } | { kind: 'exit'; v: string } | { kind: 'ret' };
interface Branch { cond?: A.Expr; prefix: A.Stat[]; to: Target; }
interface Block { key: string; prefix: A.Stat[]; branches: Branch[] | null; /* null = plain goto via prefix-less single branch */ }

export interface UnflattenOptions { maxGrowth?: number; maxStates?: number; /** diagnostics: why a candidate dispatcher loop was not unflattened */ onFail?: (reason: string) => void; }

export function unflattenStateLoops(chunk: A.Chunk, opts: UnflattenOptions = {}): number {
  const scope = analyzeScopes(chunk);
  const maxGrowth = opts.maxGrowth ?? 2.5, maxStates = opts.maxStates ?? 4000;
  let n = 0;
  forEachStatList(chunk, (list) => {
    for (let i = 0; i < list.length; i++) {
      const r = tryUnflatten(list, i, scope, maxGrowth, maxStates, opts.onFail);
      if (r) { list.splice(i, 1, ...r); n++; i += r.length - 1; }
    }
  });
  return n;
}

function tailText(stmts: A.Stat[]): string { try { const t = print({ type: 'Chunk', body: stmts.slice(-2) } as A.Chunk).replace(/\s+/g, ' '); return t.length > 300 ? t.slice(0, 150) + ' … ' + t.slice(-150) : t; } catch { return '?'; } }
function countStats(stmts: A.Stat[]): number { let c = 0; walk(stmts, (m: any) => { if (m && typeof m.type === 'string' && /Stat$/.test(m.type)) c++; }); return c; }

let cffAttempt = 0;
/** clone a block body specialised to V == k on entry, folded: flow-sensitively, every read of the marked
 *  state variable is replaced by the value V holds there — k until V is written, then the written value
 *  when it is a literal (`V = 72 + 44`), unknown after a non-literal write, at joins of different values
 *  and inside loops that write V (such reads are kept; the caller rejects the block) */
function specialise(body: A.Stat[], mark: number, k: string, multi = false): A.Stat[] {
  const c: A.Stat[] = structuredClone(body);
  const hit = (x: any) => x && x.type === 'NameExpr' && x.__cffR === mark && x.__cffW !== mark;
  const isW = (x: any) => x && x.type === 'NameExpr' && x.__cffW === mark;
  /** replace the reads in an expression subtree (not in nested functions) */
  const subE = (node: any, kv: string | null): any => {
    if (!node || typeof node !== 'object') return node;
    if (hit(node)) return kv === null ? node : keyExpr(kv);
    if (node.type === 'FunctionExpr') return node;
    for (const key of Object.keys(node)) {
      if (key === 'loc') continue;
      const v = node[key];
      if (Array.isArray(v)) { for (let i = 0; i < v.length; i++) v[i] = subE(v[i], kv); }
      else if (v && typeof v === 'object') node[key] = subE(v, kv);
    }
    return node;
  };
  const writesIn = (node: any): boolean => { let w = false; walk(node, (m: any) => { if (!w && isW(m)) w = true; }); return w; };
  const evalKey = (e: A.Expr): string | null => {
    const ch: A.Chunk = { type: 'Chunk', body: [{ type: 'ReturnStat', args: [structuredClone(e)] } as A.ReturnStat] };
    try { fold(ch); } catch { return null; }
    return litKey((ch.body[0] as A.ReturnStat).args[0]);
  };
  const UNREACH = Symbol('unreachable');
  type KV = string | null | typeof UNREACH;
  const meetKV = (xs: KV[]): KV => { const r = xs.filter(x => x !== UNREACH); if (!r.length) return UNREACH; return r.every(x => x === r[0]) ? r[0] : null; };
  const seq = (stmts: A.Stat[], kv: KV): KV => { for (const st of stmts) { if (kv === UNREACH) return UNREACH; kv = stat(st, kv); } return kv; };
  const stat = (st: any, kv0: KV): KV => {
    const kv = kv0 === UNREACH ? null : kv0;
    switch (st.type) {
      case 'LocalStat': st.init = st.init.map((e: any) => subE(e, kv)); return kv;
      case 'AssignStat': {
        st.values = st.values.map((e: any) => subE(e, kv));
        const multiE = (e: any) => !!e && (e.type === 'CallExpr' || e.type === 'MethodCallExpr' || e.type === 'VarargLit');
        const lastMulti = st.values.length > 0 && multiE(st.values[st.values.length - 1]);
        let wrote = false; let nk: string | null = null;
        st.targets = st.targets.map((t: any, i: number) => {
          if (!isW(t)) return subE(t, kv);
          wrote = true;
          const v = st.values[i];
          if (st.op) nk = kv === null || !v ? null : evalKey({ type: 'BinExpr', op: String(st.op).slice(0, -1), left: keyExpr(kv), right: v } as A.Expr);
          else if (i < st.values.length) nk = (multiE(v) && (i === st.values.length - 1)) ? null : evalKey(v);
          else nk = null;   // nil (no literal key) or one of several call results
          return t;
        });
        void lastMulti;
        return wrote ? nk : kv;
      }
      case 'CallStat': st.expr = subE(st.expr, kv); return kv;
      case 'DoStat': return seq(st.body, kv);
      case 'IfStat': {
        const ends: KV[] = [];
        for (const cl of st.clauses) { cl.cond = subE(cl.cond, kv); ends.push(seq(cl.body, kv)); }
        ends.push(st.elseBody ? seq(st.elseBody, kv) : kv);
        return meetKV(ends);
      }
      case 'WhileStat': case 'RepeatStat': {
        const w = writesIn(st.body) || (st.type === 'RepeatStat' && writesIn(st.cond));
        const inner = w ? null : kv;
        if (st.type === 'WhileStat') st.cond = subE(st.cond, inner);
        seq(st.body, inner);
        if (st.type === 'RepeatStat') st.cond = subE(st.cond, inner);
        return w ? null : kv;
      }
      case 'NumericForStat': {
        st.from = subE(st.from, kv); st.to = subE(st.to, kv); if (st.step) st.step = subE(st.step, kv);
        const w = writesIn(st.body); seq(st.body, w ? null : kv); return w ? null : kv;
      }
      case 'GenericForStat': {
        st.iters = st.iters.map((e: any) => subE(e, kv));
        const w = writesIn(st.body); seq(st.body, w ? null : kv); return w ? null : kv;
      }
      case 'ReturnStat': st.args = st.args.map((e: any) => subE(e, kv)); return UNREACH;
      case 'BreakStat': case 'ContinueStat': case 'GotoStat': return UNREACH;
      case 'FunctionStat': if (st.target) st.target = subE(st.target, kv); return kv;
      default: return kv;
    }
  };
  seq(c, k);
  const ch: A.Chunk = { type: 'Chunk', body: c };
  for (let r = 0; r < 3; r++) { const f = fold(ch); const d = eliminateDeadCode(ch); if (!f.folded && !d.prunedBranches && !d.removedStmts) break; }
  return multi ? normalizeExits(ch.body) : ch.body;
}
/** a return anywhere in the statements (not in nested functions) */
function hasReturn(stmts: A.Stat[]): boolean {
  let hit = false;
  const v = (m: any) => { if (hit || !m || typeof m !== 'object') return; if (Array.isArray(m)) { for (const x of m) v(x); return; } if (m.type === 'FunctionExpr') return; if (m.type === 'ReturnStat') { hit = true; return; } for (const k of Object.keys(m)) if (k !== 'loc') v(m[k]); };
  v(stmts);
  return hit;
}
const isJump = (st: A.Stat | undefined) => !!st && (st.type === 'ContinueStat' || st.type === 'BreakStat' || st.type === 'ReturnStat');
/**
 * Straight-line shape of a specialised dispatcher pass: `do … end` blocks without locals are inlined, code after
 * an unconditional jump is dropped, and `if c then …; <jump> end; REST` becomes `if c then …; <jump> else REST end`
 * (REST only runs when c fails).
 */
function normalizeExits(stmts: A.Stat[]): A.Stat[] {
  const out: A.Stat[] = [];
  for (const st of stmts) {
    if (st.type === 'DoStat' && !st.body.some(x => x.type === 'LocalStat' || x.type === 'LocalFunctionStat')) { out.push(...normalizeExits(st.body)); }
    else if (st.type === 'IfStat') {
      for (const c of st.clauses) c.body = normalizeExits(c.body);
      if (st.elseBody) st.elseBody = normalizeExits(st.elseBody);
      if (st.elseBody && !st.elseBody.length) st.elseBody = undefined;
      out.push(st);
    } else out.push(st);
    if (isJump(out[out.length - 1])) break;
  }
  // `if c then …; jump end; REST` -> if/else
  for (let i = 0; i < out.length - 1; i++) {
    const st = out[i];
    if (st.type !== 'IfStat' || st.elseBody || !st.clauses.every(c => isJump(c.body[c.body.length - 1]))) continue;
    const rest = out.splice(i + 1);
    st.elseBody = normalizeExits(rest);
    break;
  }
  return out;
}

function tryUnflatten(list: A.Stat[], i: number, scope: ScopeInfo, maxGrowth: number, maxStates: number, onFail?: (reason: string) => void): A.Stat[] | null {
  const loop = list[i];
  const bad = (why: string): null => { if (onFail) onFail(why); return null; };
  let body: A.Stat[]; let exitOn: ((k: string | 'nil') => boolean) = () => false; let vName: A.NameExpr | null = null;
  const pick = (e: A.Expr): A.NameExpr | null => { const u = unparen(e); if (u.type === 'UnExpr' && u.op === 'not') return pick(u.expr); if (u.type !== 'BinExpr') return null; if (u.op === 'and' || u.op === 'or') return pick(u.left) ?? pick(u.right); const l = unparen(u.left), r = unparen(u.right); if (l.type === 'NameExpr' && litKey(r)) return l; if (r.type === 'NameExpr' && litKey(l)) return r; return null; };
  /** `while <test on V> do`: evaluated per state once V is known */
  let loopTest: A.Expr | null = null;
  if (loop.type === 'WhileStat') {
    const c = unparen(loop.cond);
    if (c.type === 'TrueLit' || c.type === 'NumberLit' || c.type === 'StringLit') { /* forever */ }
    else if (c.type === 'NameExpr') { vName = c; exitOn = (k) => k === 'nil'; }
    else if (c.type === 'BinExpr' && c.op === '~=' && litKey(unparen(c.left).type === 'NameExpr' ? c.right : c.left)) {
      const l = unparen(c.left), r = unparen(c.right);
      const nm = l.type === 'NameExpr' ? l : r.type === 'NameExpr' ? r : null; const kx = litKey(nm === l ? r : l);
      if (!nm || !kx) return null; vName = nm; exitOn = (k) => k === kx;
    } else { vName = pick(c); if (!vName) return null; loopTest = c; }
    body = loop.body;
  } else if (loop.type === 'RepeatStat') {
    const c = unparen(loop.cond);
    if (c.type !== 'FalseLit' && c.type !== 'NilLit') return null;
    body = loop.body;
  } else return null;
  // dispatcher: one if-chain / search tree over V, or (multi) a sequence of tests on V whose arms leave with
  // `continue` / `break` / `return` or fall through to the next test — every state then runs the whole body
  // specialised to V == k. With a loop test on V the body may be any code.
  if (!body.length) return null;
  // the first test on a local against a literal (earlier ifs, e.g. guards on other data, are plain code)
  let firstIf = body.find(x => x.type === 'IfStat' && !!pick(unparen(x.clauses[0].cond))) as A.IfStat | undefined;
  if (!firstIf && !vName) firstIf = body.find(x => x.type === 'IfStat') as A.IfStat | undefined;
  const multi = body.length !== 1 || body[0].type !== 'IfStat';
  if (!firstIf && !vName) return null;
  const disp = (firstIf ?? body[0]) as A.IfStat;
  // the state variable
  const vFromLoop = !!vName;
  if (!vName) {
    vName = pick(unparen(disp.clauses[0].cond));
    if (!vName) return null;
  }
  const b = scope.refOf.get(vName);
  if (!b || b.kind === 'global' || b.captured || b.capturedWrite) return bad('state variable is global/captured');
  const mark = ++cffAttempt;
  for (const r of b.refs) (r as any).__cffR = mark;
  for (const w of b.writeRefs) (w as any).__cffW = mark;
  const isV = (e: A.Expr) => { const u: any = unparen(e); return u.type === 'NameExpr' && (u.__cffR === mark || u.__cffW === mark || scope.refOf.get(u) === b); };
  const leaves: Leaf[] = [];
  // V must not be read after it was written on the same path within one pass (the per-state specialisation
  // replaces every read by the state the pass started with)
  const readsVIn = (node: any) => { let hit = false; walk(node, (m: any) => { if (!hit && m.type === 'NameExpr' && m.__cffR === mark && m.__cffW !== mark) hit = true; }); return hit; };
    const writesVIn = (node: any) => { let hit = false; walk(node, (m: any) => { if (!hit && m.type === 'NameExpr' && m.__cffW === mark) hit = true; }); return hit; };
    /** { falls: the end of the list is reachable, wrote: V may have been written on a path reaching it } | null (violation) */
    const scan = (stmts: A.Stat[], wrote: boolean): { falls: boolean; wrote: boolean } | null => {
      for (const st of stmts) {
        if (st.type === 'ContinueStat' || st.type === 'BreakStat' || st.type === 'ReturnStat') { if (wrote && st.type === 'ReturnStat' && readsVIn(st)) return null; return { falls: false, wrote: false }; }
        if (st.type === 'GotoStat' || st.type === 'LabelStat') return null;
        if (st.type === 'IfStat') {
          if (wrote && st.clauses.some(c => readsVIn(c.cond))) return null;
          let anyFalls = false, w = false;
          for (const br of [...st.clauses.map(c => c.body), st.elseBody ?? []]) {
            const r = scan(br, wrote); if (!r) return null;
            if (r.falls) { anyFalls = true; w = w || r.wrote; }
          }
          if (!anyFalls) return { falls: false, wrote: false };
          wrote = w; continue;
        }
        if (st.type === 'DoStat') { const r = scan(st.body, wrote); if (!r) return null; if (!r.falls) return r; wrote = r.wrote; continue; }
        if (wrote && readsVIn(st)) return null;
        if (writesVIn(st)) wrote = true;
      }
      return { falls: true, wrote };
    };
  if (loopTest) {
    if (!pureOnV(loopTest, isV) && !cmpOn(loopTest, isV)) return null;
    const p: Pred = { e: loopTest, truth: true, isV, memo: new Map() };
    exitOn = (k) => k === 'nil' ? true : evalPred(p, k) === false;
  }
  if (multi) {
    if (!vFromLoop && !(firstIf && (cmpOn(firstIf.clauses[0].cond, isV) || pureOnV(firstIf.clauses[0].cond, isV)))) return null;
    if (!scan(body, false)) return bad('dispatcher sequence reads the state variable after writing it');
    leaves.push({ c: EMPTY(), body });
  } else if (!flattenTree(disp, isV, EMPTY(), leaves)) return bad('dispatcher tree not flattenable');
  /** leaves whose specialisation is exact on every path (no read of V after a write of V) */
  const exact = new Set<A.Stat[]>();
  for (const lf of leaves) if (multi || scan(lf.body, false)) exact.add(lf.body);
  let reorderOk = false;
  // entry state: the last write of V before the loop must be a literal
  let entry: string | null = null;
  const wset = new Set(b.writeRefs);
  const writesV = (node: any) => { let hit = false; walk(node, (m: any) => { if (!hit && m.type === 'NameExpr' && (wset.has(m) || m.__cffW === mark)) hit = true; }); return hit; };
  for (let j = i - 1; j >= 0 && entry === null; j--) {
    const s = list[j];
    if (s.type === 'LocalStat') {
      const idx = s.names.findIndex((_, q) => b.decl === s && b.index === q);
      if (idx >= 0) { if (s.init.length > idx && (idx < s.init.length - 1 || s.init.length === s.names.length)) entry = litKey(s.init[idx]); if (entry === null) return bad('entry state not literal'); break; }
      if (writesV(s)) return bad('state written before loop');
      continue;
    }
    if (s.type === 'AssignStat' && !s.op) {
      const idx = s.targets.findIndex(t => t.type === 'NameExpr' && wset.has(t));
      if (idx >= 0) { if (s.values.length === s.targets.length) entry = litKey(s.values[idx]); if (entry === null) return bad('entry state not literal'); break; }
    }
    if (writesV(s)) return bad('state written before loop');
  }
  if (entry === null) return bad('no entry state');
  if (exitOn(entry)) return bad('the loop test fails for the entry state');
  const leafFor = (k: string): Leaf | null => { const ls = leaves.filter(l => admits(l.c, k)); return ls.length === 1 ? ls[0] : null; };
  // is V live after the loop? (then its exit value is materialised at every exit)
  const rset = new Set(b.refs.filter(r => !wset.has(r)));
  let liveAfter = true;
  for (let j = i + 1; j < list.length; j++) {
    const t = list[j];
    let r = false, w = false;
    walk(t, (m: any) => { if (m.type === 'NameExpr') { if (rset.has(m)) r = true; if (wset.has(m)) w = true; } });
    if (r) break;
    if (w) { if (t.type === 'AssignStat' && !t.op && t.targets.some(x => x.type === 'NameExpr' && wset.has(x as A.NameExpr))) liveAfter = false; break; }
    if (t.type === 'ReturnStat') { liveAfter = false; break; }
    if (loopExits([t])) break;
  }
  let curKey = entry;
  // parse blocks
  const blocks = new Map<string, Block>();
  // synthetic states: a branch arm whose own transfer is conditional (`if a then if b then V = 1 else V = 2 end
  // elseif …`) becomes a block of its own, entered with V unchanged
  const synth = new Map<string, { stmts: A.Stat[]; parent: string }>();
  let synthSerial = 0;
  const endsInIf = (xs: A.Stat[]) => { let t = xs[xs.length - 1]; if (t && t.type === 'ContinueStat') t = xs[xs.length - 2]; return !!t && t.type === 'IfStat'; };
  const synthBlock = (stmts: A.Stat[]): Target => { const sk = curKey + '~' + (++synthSerial); synth.set(sk, { stmts, parent: curKey }); return { kind: 'state', k: sk }; };
  const parseTarget = (v: A.Expr): Target | null => {
    const u = unparen(v);
    if (u.type === 'NilLit' || u.type === 'FalseLit') return exitOn('nil') ? { kind: 'exit', v: u.type === 'NilLit' ? 'nil' : 'false' } : null;
    const k = litKey(u); if (k === null) return null;
    if (exitOn(k)) return { kind: 'exit', v: k };
    return { kind: 'state', k };
  };
  const isVAssign = (s: A.Stat | undefined): s is A.AssignStat => !!s && s.type === 'AssignStat' && !s.op && s.targets.length === 1 && s.values.length === 1 && isV(s.targets[0]);
  /** a branch body: prefix + transfer */
  const parseBranch = (stmts: A.Stat[], cond?: A.Expr): Branch[] | null => {
    let st = stmts;
    if (st.length && st[st.length - 1].type === 'ContinueStat') st = st.slice(0, -1);
    // `…; V = K; tail` where the tail neither touches V nor leaves: the transfer happens after the tail
    // (only for exact specialisations: no read of V in the tail was folded with the old state)
    if (reorderOk && st.length && !isVAssign(st[st.length - 1])) {
      let j = st.length - 1; while (j >= 0 && !isVAssign(st[j])) j--;
      if (j >= 0) {
        const tail = st.slice(j + 1);
        const v = unparen((st[j] as A.AssignStat).values[0]);
        const litV = litKey(v) !== null || v.type === 'NilLit' || v.type === 'FalseLit';
        if (litV && tail.length && !writesV(tail) && !loopExits(tail) && !endsWithExit(tail) && !hasReturn(tail)) st = [...st.slice(0, j), ...tail, st[j]];
      }
    }
    const last = st[st.length - 1];
    let pre = st.slice(0, -1);
    if (!last) return null;
    // V is dead once the dispatcher is left: drop literal state stores before break/return
    let exitV = curKey;
    const valKey = (e: A.Expr) => { const u = unparen(e); return u.type === 'NilLit' ? 'nil' : u.type === 'FalseLit' ? 'false' : u.type === 'TrueLit' ? 'true' : litKey(u); };
    const dropDead = (xs: A.Stat[]) => xs.filter(x => { if (isVAssign(x) && valKey(x.values[0]) !== null) { exitV = valKey(x.values[0])!; return false; } return true; });
    if (last.type === 'BreakStat') { pre = dropDead(pre); if (loopExits(pre) || writesV(pre)) return null; return [{ cond, prefix: pre, to: { kind: 'exit', v: exitV } }]; }
    if (endsWithExit(st)) { const st2 = dropDead(st); if (!loopExits(st2) && !writesV(st2)) return [{ cond, prefix: st2, to: { kind: 'ret' } }]; }
    if (loopExits(pre) || writesV(pre)) return null;
    if (isVAssign(last)) {
      const v = unparen(last.values[0]);
      // V = c and K1 or K2
      if (v.type === 'BinExpr' && v.op === 'or') {
        const l = unparen(v.left);
        if (l.type === 'BinExpr' && l.op === 'and') {
          const t1 = parseTarget(l.right), t2 = parseTarget(v.right);
          const k1 = litKey(l.right);
          if (t1 && t2 && k1 !== null) {
            if (cond) return null;    // nested conditional transfer inside a branch: keep simple
            return [{ cond: l.left, prefix: pre, to: t1 }, { prefix: [], to: t2 }];
          }
        }
        return null;
      }
      const t = parseTarget(v); if (!t) return null;
      return [{ cond, prefix: pre, to: t }];
    }
    if (last.type === 'IfStat' && last.elseBody) {
      // if c1 then …; V = K1 elseif … else …; V = Kn end
      if (cond) return null;
      const out: Branch[] = [];
      for (const c of last.clauses) {
        let br = parseBranch(c.body, c.cond);
        if (!br || br.length !== 1) { if (!endsInIf(c.body)) return null; br = [{ cond: c.cond, prefix: [], to: synthBlock(c.body) }]; }
        out.push(br[0]);
      }
      let eb = parseBranch(last.elseBody);
      if (!eb || eb.length !== 1) { if (!endsInIf(last.elseBody)) return null; eb = [{ prefix: [], to: synthBlock(last.elseBody) }]; }
      out.push({ ...eb[0], cond: undefined });
      return [{ cond: undefined, prefix: pre, to: { kind: 'state', k: '\0split' } }, ...out];
    }
    if (last.type === 'IfStat' && !last.elseBody && last.clauses.length === 1) {
      // `V = K2; if c then V = K1 end` (default first, then override)
      const prev = pre[pre.length - 1];
      if (isVAssign(prev)) {
        const t2 = parseTarget(prev.values[0]);
        const br = parseBranch(last.clauses[0].body, last.clauses[0].cond);
        if (t2 && br && br.length === 1 && br[0].prefix.length === 0) {
          const pre2 = pre.slice(0, -1); if (loopExits(pre2) || writesV(pre2)) return null;
          return [{ cond: undefined, prefix: pre2, to: { kind: 'state', k: '\0split' } }, br[0], { prefix: [], to: t2 }];
        }
      }
    }
    return null;
  };
  const queue: string[] = [entry];
  const seen = new Set<string>([entry]);
  while (queue.length) {
    const k = queue.shift()!;
    if (seen.size > maxStates) return bad('too many states');
    const sy = synth.get(k);
    let spec: A.Stat[];
    if (sy) { curKey = sy.parent; spec = sy.stmts; reorderOk = false; }
    else {
      const lf = leafFor(k); if (!lf) return bad('no unique leaf for state ' + k);
      curKey = k;
      reorderOk = exact.has(lf.body);
      // state specialisation: in this block V == k, so every read of V becomes k, then fold
      spec = specialise(lf.body, mark, k, multi);
      let readsV = false;
      walk(spec, (m: any) => { if (!readsV && m.type === 'NameExpr' && m.__cffR === mark && m.__cffW !== mark) readsV = true; });
      if (readsV) return bad('block ' + k + ' still reads the state variable');
    }
    const brs = parseBranch(spec);
    if (!brs) return bad('block ' + k + ' transfer not understood: ' + tailText(spec));
    let blk: Block;
    if (brs.length > 1 && brs[0].to.kind === 'state' && brs[0].to.k === '\0split') blk = { key: k, prefix: brs[0].prefix, branches: brs.slice(1) };
    else if (brs.length === 2) { /* V = c and K1 or K2 */ blk = { key: k, prefix: brs[0].prefix, branches: [{ cond: brs[0].cond, prefix: [], to: brs[0].to }, { prefix: [], to: brs[1].to }] }; }
    else blk = { key: k, prefix: brs[0].prefix, branches: [{ prefix: [], to: brs[0].to }] };
    blocks.set(k, blk);
    for (const br of blk.branches!) if (br.to.kind === 'state' && !seen.has(br.to.k)) { seen.add(br.to.k); queue.push(br.to.k); }
  }
  // irreducible regions (a loop entered at several nodes): split the extra entries until every cycle has one header
  const splitWhy = makeReducible(blocks, entry, Math.max(200, blocks.size * 2));
  if (splitWhy) return bad(splitWhy);
  // graph: nodes = state keys + EXIT
  const EXIT = '\0exit';
  const succ = (k: string): string[] => {
    const blk = blocks.get(k)!; const out: string[] = [];
    for (const br of blk.branches!) { const t = br.to.kind === 'state' ? br.to.k : EXIT; if (br.to.kind !== 'ret' && !out.includes(t)) out.push(t); }
    return out;
  };
  const nodes = [...blocks.keys()];
  // reverse graph for post-dominators (rets have no edge to EXIT: they leave the function)
  const preds = new Map<string, string[]>(); for (const k of [...nodes, EXIT]) preds.set(k, []);
  for (const k of nodes) for (const s of succ(k)) preds.get(s)!.push(k);
  // add ret edges to EXIT for post-dominance purposes (a return ends every path too)
  const pdSucc = (k: string) => { const blk = blocks.get(k)!; const s = succ(k); if (blk.branches!.some(br => br.to.kind === 'ret') && !s.includes(EXIT)) s.push(EXIT); return s; };
  const ipdom = postDominators([...nodes, EXIT], EXIT, pdSucc);
  // loops: DFS back edges from entry
  const color = new Map<string, number>(); const backTo = new Map<string, Set<string>>();
  const dfs = (k: string) => { color.set(k, 1); for (const s of succ(k)) { if (s === EXIT) continue; const c = color.get(s) ?? 0; if (c === 0) dfs(s); else if (c === 1) { if (!backTo.has(s)) backTo.set(s, new Set()); backTo.get(s)!.add(k); } } color.set(k, 2); };
  try { dfs(entry); } catch { return bad('dfs overflow'); }
  // post-dominators without return edges: a return leaves the function, it joins nothing
  const ipdom2 = postDominators([...nodes, EXIT], EXIT, succ);
  const pdChain = (x: string): string[] => { const c: string[] = [x]; let y = x; for (let g = 0; y !== EXIT && g < 100000; g++) { const z = ipdom2.get(y); if (z === undefined) break; c.push(z); y = z; } return c; };
  /** nodes reachable from starts without entering `inside` or `stop` */
  const reachOut = (starts: string[], inside: Set<string>, stop: string | null) => {
    const seenR = new Set<string>(); const st = [...starts]; let hitsExit = false, hitsInside = false;
    while (st.length) {
      const x = st.pop()!;
      if (x === stop) continue;
      if (x === EXIT) { hitsExit = true; continue; }
      if (inside.has(x)) { hitsInside = true; continue; }
      if (seenR.has(x)) continue; seenR.add(x);
      for (const y of succ(x)) st.push(y);
    }
    return { nodes: seenR, hitsExit, hitsInside };
  };
  /** nearest node every exit region flows into: an exit all others reach, else the first common reachable node */
  const commonFollow = (ex: string[], inside: Set<string>): string | null => {
    const dist = ex.map(e => { const d = new Map<string, number>([[e, 0]]); const q = [e]; while (q.length) { const x = q.shift()!; if (x === EXIT) continue; for (const y of succ(x)) { if (inside.has(y) || d.has(y)) continue; d.set(y, d.get(x)! + 1); q.push(y); } } return d; });
    const common = [...dist[0].keys()].filter(x => dist.every(d => d.has(x)));
    if (!common.length) return null;
    // candidates: common nodes from which every other common node is reachable
    const cands = common.filter(c => { const r = reachOut([c], inside, null).nodes; return common.every(o => o === c || r.has(o) || o === EXIT); });
    const pool = cands.length ? cands : common;
    let best: string | null = null, bestD = Infinity;
    for (const c of pool) { const d = dist.reduce((a, m) => a + m.get(c)!, 0); if (d < bestD) { bestD = d; best = c; } }
    return best;
  };
  const loopOf = new Map<string, Set<string>>(); const loopExit = new Map<string, string | null>();
  const natInfo = new Map<string, { nat: string[]; exits: string[] }>();
  for (const [h, srcs] of backTo) {
    const set = new Set<string>([h]); const st = [...srcs];
    while (st.length) { const x = st.pop()!; if (set.has(x)) continue; set.add(x); for (const p of preds.get(x) ?? []) if (!set.has(p)) st.push(p); }
    const exits = new Set<string>();
    for (const x of set) for (const s of succ(x)) if (!set.has(s)) exits.add(s);
    natInfo.set(h, { nat: [...set], exits: [...exits] });
    let follow: string | null = exits.size ? [...exits][0] : null;
    if (exits.size > 1) {
      // A `break` with code in front of it (or an `if … return end` block) is not part of the natural loop, so
      // such loops show several exits. Pick the follow node, then the other exits are break regions: body code
      // that ends by reaching the follow (emitted as `…; break`) or by returning.
      const ex = [...exits];
      const natural = ex.filter(e => succ(h).includes(e) || [...srcs].some(b => succ(b).includes(e)));
      // exits whose regions meet another exit's region decide the follow; private regions (`if c then …; return end`)
      // are simply body code
      const reach = new Map(ex.map(e => [e, reachOut([e], set, null).nodes] as const));
      const shared = ex.filter(e => ex.some(o => o !== e && [...reach.get(e)!].some(x => reach.get(o)!.has(x))));
      const pureReturn = (k: string) => { const b = blocks.get(k); return !!b && b.branches!.every(br => br.to.kind === 'ret'); };
      let f: string | null = shared.length >= 2 ? commonFollow(shared, set) : shared.length === 1 ? shared[0] : null;
      if (f !== null && pureReturn(f) && natural.length === 1) f = natural[0];
      if (f === null) f = natural.length === 1 ? natural[0] : natural.length > 1 ? commonFollow(natural, set) : null;
      if (f === null) {
        const live = ex.filter(e => { const r = reachOut([e], set, null); return r.hitsExit || r.hitsInside; });
        f = live.length === 0 ? null : live.length === 1 ? live[0] : commonFollow(live, set);
        if (f === null && live.length) return bad('loop at ' + h + ' has ' + ex.length + ' exits without a common follow: ' + ex.join(','));
      }
      if (f !== null && set.has(f)) return bad('loop at ' + h + ': follow inside the loop');
      const post = f === null ? new Set<string>() : reachOut([f], set, null).nodes;
      for (const e of ex) { if (e === f) continue; for (const x of reachOut([e], set, f).nodes) if (!post.has(x)) set.add(x); }
      follow = f;
    }
    loopOf.set(h, set); loopExit.set(h, follow);
  }
  // emission
  const origSize = countStats([loop]);
  let emitted = 0;
  interface LoopCtx { header: string; exit: string | null; /** outer targets reached from inside: break out with the jump flag set */ pending: Set<string>; }
  // multi-level break/continue (no labels in Lua): set a jump flag, break, test it after the loop
  const flagName = 'cffJump' + mark; const flagCodes = new Map<string, number>(); let flagUsed = false;
  const flagRef = (): A.NameExpr => ({ type: 'NameExpr', name: flagName });
  const flagCode = (t: string): A.NumberLit => { let c = flagCodes.get(t); if (c === undefined) { c = flagCodes.size + 1; flagCodes.set(t, c); } return { type: 'NumberLit', value: c, raw: String(c) }; };
  const flagSet = (t: string | null): A.Stat => { flagUsed = true; return { type: 'AssignStat', targets: [flagRef()], values: [t === null ? { type: 'NilLit' } : flagCode(t)] }; };
  const blockBody = (stmts: A.Stat[], copy: boolean): A.Stat[] => {
    const s = copy ? clone(stmts) : stmts;
    emitted += countStats(s);
    const declares = s.some(x => x.type === 'LocalStat' || x.type === 'LocalFunctionStat');
    return declares ? [{ type: 'DoStat', body: s }] : s;
  };
  const emittedOnce = new Set<any>();
  const take = (stmts: A.Stat[]): A.Stat[] => { const copy = emittedOnce.has(stmts); emittedOnce.add(stmts); return blockBody(stmts, copy); };
  const BRK: A.Stat = { type: 'BreakStat' }; const CONT: A.Stat = { type: 'ContinueStat' };
  const exitAssign = (v: string): A.Stat => ({ type: 'AssignStat', targets: [{ type: 'NameExpr', name: vName!.name }], values: [v === 'nil' ? { type: 'NilLit' } : v === 'false' ? { type: 'FalseLit' } : v === 'true' ? { type: 'TrueLit' } : keyExpr(v)] });
  let fail = false; let failWhy = ''; let wrapNeeded = false;
  /** leave the dispatcher (its exit / EXIT) from the current loop nest */
  const leave = (out: A.Stat[], loops: LoopCtx[]): void => {
    const inner = loops[loops.length - 1];
    if (!inner) return;                                   // top level: falling off the region is the exit
    if (inner.exit === EXIT) { out.push(BRK); return; }   // the loop's follow is the exit itself
    out.push(flagSet(EXIT), BRK); inner.pending.add(EXIT);
  };
  const emit = (start: string, stop: string | null, loops: LoopCtx[], out: A.Stat[], entered: string | null, depth: number): void => {
    let k: string | null = start;
    const visiting = new Set<string>();
    while (k !== null && !fail) {
      if (depth > 200 || emitted > origSize * maxGrowth + 50) { fail = true; failWhy = depth > 200 ? 'nesting too deep' : 'code growth limit (' + emitted + ' > ' + origSize + ' x ' + maxGrowth + ')'; return; }
      if (k === stop) return;
      const inner = loops[loops.length - 1];
      if (inner && k !== entered) {
        if (k === inner.header) { out.push(CONT); return; }
        if (k === inner.exit) { out.push(BRK); return; }
        if (loops.some((L, q) => q < loops.length - 1 && (L.header === k || L.exit === k))) { out.push(flagSet(k), BRK); inner.pending.add(k); return; }
      }
      if (k === EXIT) { leave(out, loops); return; }
      if (loopOf.has(k) && k !== entered && !(inner && inner.header === k)) {
        const ex: string | null = loopExit.get(k) ?? null;
        const lbody: A.Stat[] = [];
        const ctx: LoopCtx = { header: k, exit: ex, pending: new Set() };
        emit(k, null, [...loops, ctx], lbody, k, depth + 1);
        out.push({ type: 'WhileStat', cond: { type: 'TrueLit' }, body: lbody });
        for (const t of ctx.pending) {
          const up = loops[loops.length - 1];
          let tb: A.Stat[];
          if (t === EXIT) {
            if (!up) { tb = [flagSet(null), BRK]; wrapNeeded = true; }     // break out of the region wrapper
            else if (up.exit === EXIT) tb = [flagSet(null), BRK];
            else { tb = [BRK]; up.pending.add(EXIT); }
          }
          else if (up && t === up.header) tb = [flagSet(null), CONT];
          else if (up && t === up.exit) tb = [flagSet(null), BRK];
          else if (up && loops.some(L => L.header === t || L.exit === t)) { tb = [BRK]; up.pending.add(t); }
          else { fail = true; failWhy = 'jump to ' + t + ' out of nested loops'; return; }
          out.push({ type: 'IfStat', clauses: [{ cond: { type: 'BinExpr', op: '==', left: flagRef(), right: flagCode(t) }, body: tb }], elseBody: undefined });
        }
        if (ex === null) return;
        k = ex; entered = null; continue;
      }
      if (visiting.has(k)) { fail = true; failWhy = 'unstructured cycle through ' + k; return; }
      visiting.add(k);
      entered = null;
      const blk: Block = blocks.get(k)!;
      out.push(...take(blk.prefix));
      const brs: Branch[] = blk.branches!;
      if (brs.length === 1) {
        const to: Target = brs[0].to;
        if (to.kind === 'ret') return;
        if (to.kind === 'exit') { if (liveAfter) out.push(exitAssign(to.v)); leave(out, loops); return; }
        k = to.k; continue;
      }
      // conditional: join at the immediate post-dominator
      const j: string | null = ipdom.get(k) ?? null;
      const join: string | null = j === EXIT ? (loops.length ? null : EXIT) : j;
      const ifs: A.IfStat = { type: 'IfStat', clauses: [], elseBody: undefined };
      for (let q = 0; q < brs.length; q++) {
        const br = brs[q];
        const bb: A.Stat[] = [...take(br.prefix)];
        if (br.to.kind === 'state') emit(br.to.k, join, loops, bb, null, depth + 1);
        else if (br.to.kind === 'exit') { if (liveAfter) bb.push(exitAssign(br.to.v)); leave(bb, loops); }
        if (q < brs.length - 1 || br.cond) { if (!br.cond) { fail = true; failWhy = 'unconditional branch before the last'; return; } ifs.clauses.push({ cond: br.cond, body: bb }); }
        else ifs.elseBody = bb.length ? bb : undefined;
      }
      out.push(ifs);
      if (join === null || join === EXIT) return;
      k = join;
    }
  };
  const out: A.Stat[] = [];
  emit(entry, null, [], out, null, 0);
  if (wrapNeeded && !fail) { const body = out.splice(0, out.length); out.push({ type: 'RepeatStat', body, cond: { type: 'TrueLit' } }); }
  if (flagUsed && !fail) out.unshift({ type: 'LocalStat', names: [flagName], init: [] });
  if (fail) {
    const sink = (globalThis as any).__PRISM_CFF_DEBUG__ as ((g: unknown) => void) | undefined;
    if (sink) {
      const g: any = { entry, why: failWhy, nodes: {} as any, loops: {} as any };
      for (const k of nodes) g.nodes[k] = { succ: succ(k), ret: blocks.get(k)!.branches!.some(br => br.to.kind === 'ret'), ipdom: ipdom.get(k), code: tailText(blocks.get(k)!.prefix).slice(0, 120) };
      for (const [h, set] of loopOf) g.loops[h] = { exit: loopExit.get(h), set: [...set], nat: natInfo.get(h)?.nat, exits: natInfo.get(h)?.exits, latches: [...(backTo.get(h) ?? [])] };
      sink(g);
    }
    return bad('emission failed: ' + failWhy);
  }
  // a return in the middle of a statement list is a syntax error: wrap it
  if (i < list.length - 1 && out.length && out[out.length - 1].type === 'ReturnStat') out[out.length - 1] = { type: 'DoStat', body: [out[out.length - 1]] };
  return out;
}

/** node splitting (after Janssen & Corporaal): every extra entry of a multi-entry cycle gets its own copy of the part
 *  of the cycle it reaches before the chosen header, so every cycle ends up with one header (reducible graph). */
function makeReducible(blocks: Map<string, Block>, entry: string, maxNew: number): string | null {
  let made = 0; let serial = 0;
  const succOf = (k: string): string[] => { const out: string[] = []; for (const br of blocks.get(k)!.branches!) if (br.to.kind === 'state' && blocks.has(br.to.k) && !out.includes(br.to.k)) out.push(br.to.k); return out; };
  /** nodes of C reachable from e without passing through h */
  const region = (e: string, C: Set<string>, h: string): Set<string> => { const r = new Set<string>(); const st = [e]; while (st.length) { const x = st.pop()!; if (x === h || r.has(x) || !C.has(x)) continue; r.add(x); for (const y of succOf(x)) st.push(y); } return r; };
  for (let pass = 0; pass < 2000; pass++) {
    const order = new Map<string, number>(); const st = [entry];
    while (st.length) { const x = st.pop()!; if (order.has(x)) continue; order.set(x, order.size); const ss = succOf(x); for (let q = ss.length - 1; q >= 0; q--) if (!order.has(ss[q])) st.push(ss[q]); }
    const preds = new Map<string, string[]>(); for (const k of order.keys()) preds.set(k, []);
    for (const k of order.keys()) for (const t of succOf(k)) preds.get(t)?.push(k);
    let split = false;
    const work: Set<string>[] = [new Set(order.keys())];
    while (work.length && !split) {
      const S = work.pop()!;
      for (const C of sccs(S, (k) => succOf(k).filter(t => S.has(t)))) {
        if (C.size === 1) { const only = [...C][0]; if (!succOf(only).includes(only)) continue; }
        const entries = [...C].filter(x => x === entry || preds.get(x)!.some(p => !C.has(p))).sort((a, b) => order.get(a)! - order.get(b)!);
        if (entries.length <= 1) { const h = entries[0] ?? [...C].sort((a, b) => order.get(a)! - order.get(b)!)[0]; const inner = new Set(C); inner.delete(h); if (inner.size) work.push(inner); continue; }
        // header: the dispatcher entry if it is in the cycle, else the entry that needs the fewest copied nodes
        let header = entries[0];
        if (!C.has(entry) && entries.length <= 8) {
          let best = Infinity;
          for (const h of entries) { let cost = 0; for (const e of entries) if (e !== h) cost += region(e, C, h).size; if (cost < best) { best = cost; header = h; } }
        } else if (C.has(entry)) header = entry;
        for (const e of entries) {
          if (e === header) continue;
          const R = region(e, C, header);
          made += R.size;
          if (made > maxNew) return 'irreducible control flow: node-splitting budget exceeded (' + made + ' copies)';
          const map = new Map<string, string>(); for (const x of R) map.set(x, x + '#' + (++serial));
          for (const x of R) {
            const orig = blocks.get(x)!;
            const nk = map.get(x)!;
            blocks.set(nk, { key: nk, prefix: structuredClone(orig.prefix), branches: orig.branches!.map(br => ({ cond: br.cond ? structuredClone(br.cond) : undefined, prefix: structuredClone(br.prefix), to: br.to.kind === 'state' && map.has(br.to.k) ? { kind: 'state', k: map.get(br.to.k)! } : br.to })) });
          }
          for (const p of preds.get(e)!) {
            if (C.has(p)) continue;
            for (const br of blocks.get(p)!.branches!) if (br.to.kind === 'state' && br.to.k === e) br.to = { kind: 'state', k: map.get(e)! };
          }
        }
        split = true; break;
      }
    }
    if (!split) return null;
  }
  return 'irreducible control flow: node splitting did not converge';
}
/** strongly connected components (iterative Tarjan) of the subgraph induced by S */
function sccs(S: Set<string>, succ: (k: string) => string[]): Set<string>[] {
  const index = new Map<string, number>(), low = new Map<string, number>(), onStack = new Set<string>(); const stack: string[] = []; const out: Set<string>[] = [];
  let idx = 0;
  for (const root of S) {
    if (index.has(root)) continue;
    const call: Array<{ v: string; it: string[]; i: number }> = [{ v: root, it: succ(root), i: 0 }];
    index.set(root, idx); low.set(root, idx); idx++; stack.push(root); onStack.add(root);
    while (call.length) {
      const fr = call[call.length - 1];
      if (fr.i < fr.it.length) {
        const w = fr.it[fr.i++];
        if (!index.has(w)) { index.set(w, idx); low.set(w, idx); idx++; stack.push(w); onStack.add(w); call.push({ v: w, it: succ(w), i: 0 }); }
        else if (onStack.has(w)) low.set(fr.v, Math.min(low.get(fr.v)!, index.get(w)!));
      } else {
        call.pop();
        if (call.length) { const par = call[call.length - 1].v; low.set(par, Math.min(low.get(par)!, low.get(fr.v)!)); }
        if (low.get(fr.v) === index.get(fr.v)) { const c = new Set<string>(); let w: string; do { w = stack.pop()!; onStack.delete(w); c.add(w); } while (w !== fr.v); out.push(c); }
      }
    }
  }
  return out;
}
/** immediate post-dominators (Cooper–Harvey–Kennedy on the reverse graph) */
function postDominators(nodes: string[], exit: string, succ: (k: string) => string[]): Map<string, string> {
  const preds = new Map<string, string[]>(); for (const k of nodes) preds.set(k, []);
  for (const k of nodes) if (k !== exit) for (const s of succ(k)) preds.get(s)?.push(k);
  // reverse graph: edges s -> k for k -> s ; DFS postorder from exit
  const order: string[] = []; const seen = new Set<string>();
  const stack: Array<[string, number]> = [[exit, 0]]; seen.add(exit);
  while (stack.length) {
    const top = stack[stack.length - 1]; const ps = preds.get(top[0]) ?? [];
    if (top[1] < ps.length) { const p = ps[top[1]++]; if (!seen.has(p)) { seen.add(p); stack.push([p, 0]); } }
    else { order.push(top[0]); stack.pop(); }
  }
  const po = new Map<string, number>(); order.forEach((k, i) => po.set(k, i));
  const rpo = [...order].reverse();
  const idom = new Map<string, string>(); idom.set(exit, exit);
  const intersect = (a: string, b: string): string => {
    while (a !== b) {
      while (po.get(a)! < po.get(b)!) a = idom.get(a)!;
      while (po.get(b)! < po.get(a)!) b = idom.get(b)!;
    }
    return a;
  };
  let changed = true; let guard = 0;
  while (changed && guard++ < 1000) {
    changed = false;
    for (const k of rpo) {
      if (k === exit) continue;
      // "predecessors" in the reverse graph = successors in the original
      const ss = succ(k).filter(s => idom.has(s) && po.has(s));
      if (!ss.length) continue;
      let nd = ss[0];
      for (const s of ss.slice(1)) nd = intersect(s, nd);
      if (idom.get(k) !== nd) { idom.set(k, nd); changed = true; }
    }
  }
  idom.delete(exit);
  return idom;
}

// ---------------------------------------------------------------- head-update rotation
/** `while true do V = V + c; REST end` (a counter stepped at the loop head, tested against literals in REST —
 *  for-loop style dispatchers) -> `V = V + c; while true do REST' end`, where REST' runs the update before every
 *  `continue` of this loop and at its fall-through end. Exactly the same order of evaluation; afterwards every
 *  transition is `V = <state> + c`, which the per-state specialisation of the unflattener evaluates. */
export function rotateHeadUpdates(chunk: A.Chunk): number {
  const scope = analyzeScopes(chunk);
  let n = 0;
  const isUpdate = (s: A.Stat | undefined): A.NameExpr | null => {
    if (!s || s.type !== 'AssignStat' || s.targets.length !== 1 || s.values.length !== 1) return null;
    const t = unparen(s.targets[0]); if (t.type !== 'NameExpr') return null;
    const b = scope.refOf.get(t); if (!b || b.kind === 'global' || b.captured || b.capturedWrite) return null;
    const v = unparen(s.values[0]);
    const lit = (e: A.Expr) => { const u = unparen(e); return u.type === 'NumberLit' || (u.type === 'UnExpr' && u.op === '-' && unparen(u.expr).type === 'NumberLit'); };
    const isT = (e: A.Expr) => { const u = unparen(e); return u.type === 'NameExpr' && scope.refOf.get(u) === b; };
    if (s.op) return (s.op === '+=' || s.op === '-=') && lit(v) ? t : null;
    if (v.type !== 'BinExpr' || (v.op !== '+' && v.op !== '-')) return null;
    return (isT(v.left) && lit(v.right)) || (v.op === '+' && isT(v.right) && lit(v.left)) ? t : null;
  };
  const cmpOps = new Set(['==', '~=', '<', '<=', '>', '>=']);
  /** REST compares V with a literal (a dispatcher on the counter) */
  const testsV = (stmts: A.Stat[], b: Binding): boolean => {
    let hit = false;
    walk(stmts, (m: any) => {
      if (hit || m.type !== 'BinExpr' || !cmpOps.has(m.op)) return;
      const l = unparen(m.left), r = unparen(m.right);
      if ((l.type === 'NameExpr' && scope.refOf.get(l) === b && litKey(r)) || (r.type === 'NameExpr' && scope.refOf.get(r) === b && litKey(l))) hit = true;
    });
    return hit;
  };
  /** the end of the list may be reached (conservative) */
  const canFall = (stmts: A.Stat[]): boolean => {
    const last = stmts[stmts.length - 1];
    if (!last) return true;
    if (last.type === 'ReturnStat' || last.type === 'BreakStat' || last.type === 'ContinueStat') return false;
    if (last.type === 'DoStat') return canFall(last.body);
    if (last.type === 'IfStat') return !last.elseBody || last.clauses.some(c => canFall(c.body)) || canFall(last.elseBody);
    return true;
  };
  /** `continue` of this loop -> update; continue (not inside nested loops / functions) */
  const rewrite = (stmts: A.Stat[], upd: A.Stat): A.Stat[] => {
    const out: A.Stat[] = [];
    for (const s of stmts) {
      if (s.type === 'ContinueStat') { out.push(clone(upd), s); continue; }
      if (s.type === 'IfStat') { for (const c of s.clauses) c.body = rewrite(c.body, upd); if (s.elseBody) s.elseBody = rewrite(s.elseBody, upd); }
      else if (s.type === 'DoStat') s.body = rewrite(s.body, upd);
      out.push(s);
    }
    return out;
  };
  const hasGoto = (stmts: A.Stat[]) => { let hit = false; walk(stmts, (m: any) => { if (m.type === 'GotoStat' || m.type === 'LabelStat') hit = true; }); return hit; };
  forEachStatList(chunk, (list) => {
    for (let i = 0; i < list.length; i++) {
      const s = list[i];
      if (s.type !== 'WhileStat' || unparen(s.cond).type !== 'TrueLit' || s.body.length < 2) continue;
      const v = isUpdate(s.body[0]); if (!v) continue;
      const b = scope.refOf.get(v)!;
      const rest = s.body.slice(1);
      if (!testsV(rest, b) || hasGoto(rest)) continue;
      const upd = s.body[0];
      const body = rewrite(rest, upd);
      if (canFall(body)) body.push(clone(upd));
      list.splice(i, 1, clone(upd), { ...s, body });
      i++; n++;
    }
  });
  return n;
}

// ---------------------------------------------------------------- while-true normalisation
/** `while true do if C then B; continue end; break end` -> `while C do B end`
 *  `while true do if C then break end; B end`            -> `while not C do B end` */
export function simplifyWhileTrue(chunk: A.Chunk): number {
  let n = 0;
  forEachStatList(chunk, (list) => {
    for (let i = 0; i < list.length; i++) {
      const s = list[i];
      if (s.type !== 'WhileStat' || unparen(s.cond).type !== 'TrueLit') continue;
      const b = s.body;
      if (b.length === 2 && b[0].type === 'IfStat' && b[0].clauses.length === 1 && !b[0].elseBody && b[1].type === 'BreakStat') {
        const cb = b[0].clauses[0].body;
        const last = cb[cb.length - 1];
        if (last && last.type === 'ContinueStat' && !loopExits(cb.slice(0, -1))) {
          list[i] = { type: 'WhileStat', cond: b[0].clauses[0].cond, body: cb.slice(0, -1), loc: s.loc }; n++; continue;
        }
      }
      if (b.length >= 1 && b[0].type === 'IfStat' && b[0].clauses.length === 1 && !b[0].elseBody && b[0].clauses[0].body.length === 1 && b[0].clauses[0].body[0].type === 'BreakStat') {
        const c = b[0].clauses[0].cond;
        const u = unparen(c);
        const cond: A.Expr = u.type === 'UnExpr' && u.op === 'not' ? u.expr : { type: 'UnExpr', op: 'not', expr: { type: 'ParenExpr', expr: c } };
        list[i] = { type: 'WhileStat', cond, body: b.slice(1), loc: s.loc }; n++; continue;
      }
    }
  });
  return n;
}

// ---------------------------------------------------------------- for-loop sequence flattening
/** `for i = a, b, c do if <test on i> then … elseif … end end` with constant bounds, where every
 *  iteration selects exactly one case (tests may be compound: `i > 647 and i < 881`) ->
 *  the selected case bodies in order (`continue` = next case, `break` = stop). */
export function unrollSwitchFor(chunk: A.Chunk, maxIter = 64): number {
  const scope = analyzeScopes(chunk);
  let n = 0;
  const numLit = (e: A.Expr | undefined): number | null => { if (!e) return null; const k = litKey(e); return k && k.startsWith('n:') ? Number(k.slice(2)) : null; };
  forEachStatList(chunk, (list) => {
    for (let i = 0; i < list.length; i++) {
      const s = list[i];
      if (s.type !== 'NumericForStat') continue;
      const a = numLit(s.from), b = numLit(s.to), c = s.step ? numLit(s.step) : 1;
      if (a === null || b === null || c === null || c === 0) continue;
      const iters = Math.floor((b - a) / c) + 1;
      if (!(iters >= 1 && iters <= maxIter)) continue;
      const bind = scope.bindings.find(x => x.kind === 'for' && x.decl === s);
      if (!bind || bind.writes > 0 || bind.captured) continue;
      if (s.body.length !== 1 || s.body[0].type !== 'IfStat') continue;
      const mark = ++cffAttempt;
      for (const r of bind.refs) (r as any).__cffR = mark;
      const isV = (e: A.Expr) => { const u: any = unparen(e); return u.type === 'NameExpr' && u.__cffR === mark; };
      const disp = s.body[0];
      if (!pureOnV(disp.clauses[0].cond, isV)) continue;
      const select = (ifs: A.IfStat, key: string, depth: number): A.Stat[] | null => {
        if (depth > 64) return null;
        for (const cl of ifs.clauses) {
          if (!pureOnV(cl.cond, isV)) return null;
          const t = evalPred({ e: cl.cond, truth: true, isV, memo: new Map() }, key);
          if (t === null) return null;
          if (t) return descend(cl.body, key, depth);
        }
        return descend(ifs.elseBody ?? [], key, depth);
      };
      const descend = (body: A.Stat[], key: string, depth: number): A.Stat[] | null =>
        body.length === 1 && body[0].type === 'IfStat' && pureOnV(body[0].clauses[0].cond, isV) ? select(body[0], key, depth + 1) : body;
      const blocks: A.Stat[] = [];
      let ok = true;
      for (let q = 0; q < iters; q++) {
        const v = a + q * c;
        const body = select(disp, 'n:' + v, 0);
        if (!body) { ok = false; break; }
        let bb = body; let stop = false;
        if (bb.length && bb[bb.length - 1].type === 'ContinueStat') bb = bb.slice(0, -1);
        else if (bb.length && bb[bb.length - 1].type === 'BreakStat') { bb = bb.slice(0, -1); stop = true; }
        if (loopExits(bb)) { ok = false; break; }
        const cl: A.Stat[] = structuredClone(bb);
        const sub = (node: any): void => {
          if (!node || typeof node !== 'object') return;
          for (const key of Object.keys(node)) {
            if (key === 'loc') continue;
            const x = node[key];
            const hit = (y: any) => y && y.type === 'NameExpr' && y.__cffR === mark;
            if (Array.isArray(x)) { for (let z = 0; z < x.length; z++) { if (hit(x[z])) x[z] = keyExpr('n:' + v); else sub(x[z]); } }
            else if (x && typeof x === 'object') { if (hit(x)) node[key] = keyExpr('n:' + v); else sub(x); }
          }
        };
        sub(cl);
        if (cl.length) blocks.push({ type: 'DoStat', body: cl, loc: s.loc });
        if (stop) break;
      }
      if (!ok) continue;
      list.splice(i, 1, ...blocks); i += blocks.length - 1; n++;
    }
  });
  return n;
}
