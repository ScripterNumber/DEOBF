// Control-flow normalisation passes (universal, semantics-preserving):
//  * loopOnce:  `while C do S; break end` -> `if C then S end`
//               `repeat S until true`     -> `do S end`
//    (only when no other break/continue in S binds to that loop)
//  * foldGuards: path-sensitive constant tracking for uncaptured locals.
//    Folds opaque predicates on "junk state" variables and rebuilds if/else
//    pairs that obfuscators encode as two guarded blocks:
//        X = K; if C then X -= X; ... end; if X / d == q then ... end
//    -> if C then ... else ... end
import type * as A from '../ast.js';
import { analyzeScopes, Binding, ScopeInfo } from '../analysis/scope.js';
import { forEachStatList } from './scopepasses.js';

const unparen = (e: A.Expr): A.Expr => { while (e && e.type === 'ParenExpr') e = e.expr; return e; };

/** does `stmts` contain a break/continue that binds to the enclosing loop? */
function bindsLoopExit(stmts: A.Stat[], allowLastBreak: boolean): boolean {
  const scan = (list: A.Stat[], top: boolean): boolean => {
    for (let i = 0; i < list.length; i++) {
      const s = list[i];
      if (s.type === 'BreakStat' || s.type === 'ContinueStat') { if (!(top && allowLastBreak && i === list.length - 1 && s.type === 'BreakStat')) return true; }
      else if (s.type === 'GotoStat') return true;
      else if (s.type === 'IfStat') { for (const c of s.clauses) if (scan(c.body, false)) return true; if (s.elseBody && scan(s.elseBody, false)) return true; }
      else if (s.type === 'DoStat') { if (scan(s.body, false)) return true; }
      // nested loops capture their own breaks; functions are separate
    }
    return false;
  };
  return scan(stmts, true);
}

/** every path through `stmts` ends in break/return (never falls off the end) */
function stmtExits(s: A.Stat): boolean {
  if (s.type === 'BreakStat' || s.type === 'ReturnStat') return true;
  if (s.type === 'IfStat') return !!s.elseBody && s.clauses.every(c => definitelyExits(c.body)) && definitelyExits(s.elseBody);
  if (s.type === 'DoStat') return definitelyExits(s.body);
  return false;
}
/** some top-level statement always leaves the block, so control never falls off its end */
function definitelyExits(stmts: A.Stat[]): boolean {
  return stmts.some(stmtExits);
}
function topLocalNames(stmts: A.Stat[]): string[] {
  const out: string[] = [];
  for (const s of stmts) { if (s.type === 'LocalStat') out.push(...s.names); else if (s.type === 'LocalFunctionStat') out.push(s.name); }
  return out;
}
function mentions(stmts: A.Stat[], names: string[]): boolean {
  if (!names.length) return false;
  const set = new Set(names); let hit = false;
  const visit = (n: any) => { if (hit || !n || typeof n !== 'object') return; if (Array.isArray(n)) { for (const x of n) visit(x); return; } if (n.type === 'NameExpr' && set.has(n.name)) { hit = true; return; } for (const k of Object.keys(n)) if (k !== 'loc') visit(n[k]); };
  visit(stmts); return hit;
}

/** Remove loop-bound breaks from a body that runs at most once:
 *  `if C then X; break end; REST` -> `if C then X else REST end`. null = impossible. */
function debreak(stmts: A.Stat[], depth = 0): A.Stat[] | null {
  if (depth > 40) return null;
  const out: A.Stat[] = [];
  for (let i = 0; i < stmts.length; i++) {
    const s = stmts[i];
    if (s.type === 'BreakStat') return out;              // rest is unreachable
    if (s.type === 'ContinueStat' || s.type === 'GotoStat') return null;
    if (s.type === 'DoStat') {
      if (!bindsLoopExit(s.body, false)) { out.push(s); continue; }
      const rest = stmts.slice(i + 1);
      if (definitelyExits(s.body)) { const r = debreak(s.body, depth + 1); if (!r) return null; out.push({ type: 'DoStat', body: r, loc: s.loc }); return out; }
      if (mentions(rest, topLocalNames(s.body))) return null;  // scoping hazard
      const r = debreak([...s.body, ...rest], depth + 1); if (!r) return null;
      out.push({ type: 'DoStat', body: r, loc: s.loc }); return out;
    }
    if (s.type === 'IfStat' && (s.clauses.some(c => bindsLoopExit(c.body, false)) || (s.elseBody && bindsLoopExit(s.elseBody, false)))) {
      const rest = stmts.slice(i + 1);
      const branches = [...s.clauses.map(c => c.body), s.elseBody ?? []];
      const falls = branches.filter(b => !definitelyExits(b));
      if (falls.length > 1 && rest.length) return null;     // would duplicate REST
      const nb: A.Stat[][] = [];
      for (const b of branches) {
        const exits = definitelyExits(b);
        if (!exits && rest.length && mentions(rest, topLocalNames(b))) return null; // scoping hazard
        const r = debreak(exits ? b : [...b, ...rest], depth + 1);
        if (!r) return null;
        nb.push(r);
      }
      const elseBody = nb.pop()!;
      out.push({ type: 'IfStat', clauses: s.clauses.map((c, k) => ({ cond: c.cond, body: nb[k] })), elseBody: elseBody.length ? elseBody : undefined, loc: s.loc });
      return out;
    }
    out.push(s);
  }
  return out;
}

export function loopOnce(chunk: A.Chunk): number {
  let n = 0;
  forEachStatList(chunk, (list) => {
    for (let i = 0; i < list.length; i++) {
      const s = list[i];
      if (s.type === 'WhileStat') {
        // body never reaches its end -> the loop runs at most once
        if (!definitelyExits(s.body)) continue;
        const body = debreak(s.body); if (!body) continue;
        const cond = unparen(s.cond);
        list[i] = cond.type === 'TrueLit' ? { type: 'DoStat', body, loc: s.loc } : { type: 'IfStat', clauses: [{ cond: s.cond, body }], loc: s.loc };
        n++;
      } else if (s.type === 'NumericForStat') {
        // constant bounds: zero-trip loops vanish; single-trip (body always exits) -> do-block
        const num = (e: A.Expr | undefined, d: number): number | null => {
          if (!e) return d; const u = unparen(e);
          if (u.type === 'NumberLit') return u.value;
          if (u.type === 'UnExpr' && u.op === '-' && unparen(u.expr).type === 'NumberLit') return -(unparen(u.expr) as A.NumberLit).value;
          return null;
        };
        const a = num(s.from, NaN), b = num(s.to, NaN), st = num(s.step, 1);
        if (a === null || b === null || st === null || !isFinite(a) || !isFinite(b) || !st) continue;
        const trips = st > 0 ? a <= b : a >= b;
        if (!trips) { list.splice(i, 1); i--; n++; continue; }
        if (!definitelyExits(s.body)) continue;
        const body = debreak(s.body); if (!body) continue;
        list[i] = { type: 'DoStat', body: [{ type: 'LocalStat', names: [s.var], init: [s.from] }, ...body], loc: s.loc }; n++;
      } else if (s.type === 'RepeatStat' && unparen(s.cond).type === 'TrueLit') {
        const body = debreak(s.body); if (!body) continue;
        list[i] = { type: 'DoStat', body, loc: s.loc }; n++;
      }
    }
  });
  return n;
}

/** `for i = a, b do <if-dispatch on i> end` with constant bounds -> sequential blocks.
 *  Bodies are cloned with i substituted; fold/deadcode then pick the right case. */
export function unrollSwitchLoops(chunk: A.Chunk, maxIter = 32): number {
  let n = 0;
  const scope = analyzeScopes(chunk);
  const byDecl = new Map<any, Binding>();
  for (const b of scope.bindings) if (b.kind === 'for' && b.decl?.type === 'NumericForStat') byDecl.set(b.decl, b);
  const num = (e: A.Expr | undefined): number | null => { if (!e) return null; const u = unparen(e); if (u.type === 'NumberLit') return u.value; if (u.type === 'UnExpr' && u.op === '-') { const v = num(u.expr); return v === null ? null : -v; } return null; };
  forEachStatList(chunk, (list) => {
    for (let i = 0; i < list.length; i++) {
      const s = list[i];
      if (s.type !== 'NumericForStat') continue;
      const a = num(s.from), b = num(s.to), c = s.step ? num(s.step) : 1;
      if (a === null || b === null || c === null || c === 0) continue;
      const iters = Math.floor((b - a) / c) + 1;
      if (!(iters >= 1 && iters <= maxIter)) continue;
      const bind = byDecl.get(s); if (!bind || bind.writes > 0) continue;
      // body must dispatch on the loop variable
      const first = s.body[0];
      if (s.body.length !== 1 || first.type !== 'IfStat') continue;
      const c0 = unparen(first.clauses[0].cond);
      const onVar = c0.type === 'BinExpr' && [c0.left, c0.right].some(x => { const u = unparen(x); return u.type === 'NameExpr' && scope.refOf.get(u) === bind; });
      if (!onVar || bindsLoopExit(s.body, false)) continue;
      // only sequence-flattening loops: (nearly) every iteration hits a distinct case
      const isVarCmp = (e: A.Expr) => { const u = unparen(e); return u.type === 'BinExpr' && [u.left, u.right].some(x => { const w = unparen(x); return w.type === 'NameExpr' && scope.refOf.get(w) === bind; }); };
      const leaves = (st: A.IfStat): number => {
        let c = 0;
        const sub = (body: A.Stat[]) => { if (body.length === 1 && body[0].type === 'IfStat' && isVarCmp(body[0].clauses[0].cond)) c += leaves(body[0]); else c++; };
        for (const cl of st.clauses) sub(cl.body);
        sub(st.elseBody ?? []);
        return c;
      };
      if (leaves(first) < Math.max(2, Math.ceil(iters * 0.75))) continue;
      const blocks: A.Stat[] = [];
      for (let k = 0; k < iters; k++) {
        const v = a + k * c;
        const refs = new Set(bind.refs);
        const clone = (x: any): any => {
          if (!x || typeof x !== 'object') return x;
          if (Array.isArray(x)) return x.map(clone);
          if (x.type === 'NameExpr' && refs.has(x)) return { type: 'NumberLit', value: v, raw: String(v) };
          const o: any = {}; for (const key of Object.keys(x)) o[key] = key === 'loc' ? x[key] : clone(x[key]); return o;
        };
        blocks.push({ type: 'DoStat', body: clone(s.body), loc: s.loc });
      }
      list.splice(i, 1, ...blocks); i += blocks.length - 1; n++;
    }
  });
  return n;
}

// ---------------------------------------------------------------- guards ----
type V = number | boolean | string | null;   // null = nil
type AVal = V[] | 'T';
type State = Map<Binding, AVal>;
const MAXSET = 512;

function join(a: AVal | undefined, b: AVal | undefined): AVal {
  if (a === undefined || b === undefined || a === 'T' || b === 'T') return 'T';
  if (a === b) return a;
  const set = new Set<V>(a);
  for (const x of b) set.add(x);
  return set.size > MAXSET ? 'T' : [...set];
}
function joinStates(states: State[]): State {
  if (!states.length) return new Map();
  const keys = new Set<Binding>(); for (const s of states) for (const k of s.keys()) keys.add(k);
  const out: State = new Map();
  for (const k of keys) { let v: AVal | undefined = states[0].get(k); for (const s of states.slice(1)) v = join(v, s.get(k)); out.set(k, v === undefined ? 'T' : v); }
  return out;
}
const truthy = (v: V) => v !== null && v !== false;

function binop(op: string, a: V, b: V): V | undefined {
  if (op === '==') return a === b; if (op === '~=') return a !== b;
  if (op === 'and') return truthy(a) ? b : a; if (op === 'or') return truthy(a) ? a : b;
  if (op === '..') return (typeof a === 'string' || typeof a === 'number') && (typeof b === 'string' || typeof b === 'number') ? String(a) + String(b) : undefined;
  if (typeof a !== 'number' || typeof b !== 'number') {
    if (typeof a === 'string' && typeof b === 'string' && ['<', '<=', '>', '>='].includes(op)) return op === '<' ? a < b : op === '<=' ? a <= b : op === '>' ? a > b : a >= b;
    return undefined;
  }
  switch (op) {
    case '+': return a + b; case '-': return a - b; case '*': return a * b; case '/': return a / b;
    case '%': return a - Math.floor(a / b) * b; case '^': return Math.pow(a, b); case '//': return Math.floor(a / b);
    case '<': return a < b; case '<=': return a <= b; case '>': return a > b; case '>=': return a >= b;
  }
  return undefined;
}

class GuardFolder {
  folded = 0; merged = 0;
  private byDecl = new Map<any, Binding[]>();
  constructor(private scope: ScopeInfo) {
    for (const b of scope.bindings) if (b.decl) { const a = this.byDecl.get(b.decl) ?? []; a[b.index] = b; this.byDecl.set(b.decl, a); }
  }
  /** function currently being abstract-executed */
  private fnStack: Array<A.FunctionExpr | A.Chunk> = [];
  aggressive = true;
  tracked(n: A.Expr): Binding | null {
    if (n.type !== 'NameExpr') return null;
    const b = this.scope.refOf.get(n);
    if (!b || b.kind !== 'local') return null;
    if (!b.captured) return b;
    // captured upvalue written only by the function under analysis: calls from
    // here cannot change it (modulo re-entrancy, which obfuscators never rely on)
    const f = this.fnStack[this.fnStack.length - 1];
    if (this.aggressive && b.writeFns.size === 1 && f && b.writeFns.has(f)) { this.owned.add(b); return b; }
    return null;
  }
  private owned = new Set<Binding>();
  storesRemoved = 0;
  runFn(f: A.FunctionExpr | A.Chunk) {
    this.fnStack.push(f);
    const saved = this.owned; this.owned = new Set();
    this.block(f.body, new Map());
    if (this.owned.size) this.pruneJunkStores(f.body, this.owned);
    this.owned = saved;
    this.fnStack.pop();
  }
  /** upvalues owned by this function whose only remaining reads feed themselves are junk state */
  pruneJunkStores(body: A.Stat[], cands: Set<Binding>) {
    const live = new Map<Binding, number>();
    const count = (n: any, selfB: Binding | null) => {
      if (!n || typeof n !== 'object') return;
      if (Array.isArray(n)) { for (const x of n) count(x, selfB); return; }
      if (n.type === 'NameExpr') { const b = this.scope.refOf.get(n); if (b && cands.has(b) && b !== selfB) live.set(b, (live.get(b) ?? 0) + 1); return; }
      if (n.type === 'AssignStat') {
        const b0 = n.targets.length && n.targets.every((t: any) => t.type === 'NameExpr') ? this.scope.refOf.get(n.targets[0]) : undefined;
        const self = b0 && cands.has(b0) && n.targets.every((t: any) => this.scope.refOf.get(t) === b0) ? b0 : null;
        for (const t of n.targets) if (t.type !== 'NameExpr') count(t, null);
        count(n.values, self);
        return;
      }
      for (const k of Object.keys(n)) if (k !== 'loc') count(n[k], selfB);
    };
    count(body, null);
    const dead = new Set([...cands].filter(b => !live.get(b)));
    if (!dead.size) return;
    const pure = (e: any): boolean => { e = unparen(e); return ['NumberLit', 'StringLit', 'TrueLit', 'FalseLit', 'NilLit', 'NameExpr'].includes(e.type) || (e.type === 'BinExpr' && pure(e.left) && pure(e.right)) || (e.type === 'UnExpr' && pure(e.expr)); };
    forEachStatList(body, (list) => {
      for (let i = list.length - 1; i >= 0; i--) {
        const st = list[i];
        if (st.type === 'AssignStat' && st.targets.every(t => t.type === 'NameExpr' && dead.has(this.scope.refOf.get(t)!)) && st.values.every(pure)) { list.splice(i, 1); this.storesRemoved++; }
      }
    });
  }
  ev(e: A.Expr, s: State): AVal {
    e = unparen(e);
    switch (e.type) {
      case 'NumberLit': return [e.value];
      case 'StringLit': return [e.value];
      case 'TrueLit': return [true]; case 'FalseLit': return [false]; case 'NilLit': return [null];
      case 'NameExpr': { const b = this.tracked(e); if (!b) return 'T'; return s.get(b) ?? 'T'; }
      case 'UnExpr': {
        const v = this.ev(e.expr, s); if (v === 'T') return 'T';
        const out: V[] = [];
        for (const x of v) { if (e.op === 'not') out.push(!truthy(x)); else if (e.op === '-' && typeof x === 'number') out.push(-x); else if (e.op === '#' && typeof x === 'string') out.push(x.length); else return 'T'; }
        return out;
      }
      case 'BinExpr': {
        const l = this.ev(e.left, s);
        if ((e.op === 'and' || e.op === 'or') && l !== 'T') {
          // short-circuit: only evaluate right side when needed
          const out: V[] = [];
          for (const x of l) {
            if ((e.op === 'and' && !truthy(x)) || (e.op === 'or' && truthy(x))) out.push(x);
            else { const r = this.ev(e.right, s); if (r === 'T') return 'T'; out.push(...r); }
          }
          return out.length > MAXSET ? 'T' : out;
        }
        const r = this.ev(e.right, s);
        if (l === 'T' || r === 'T' || l.length * r.length > MAXSET * 8) return 'T';
        const out = new Set<V>();
        // x - x, x / x, x == x on the same variable are exact (not a cartesian product)
        const sameVar = e.left.type === 'NameExpr' && e.right.type === 'NameExpr' && e.left.name === e.right.name;
        if (sameVar) { for (const a of l) { const v = binop(e.op, a, a); if (v === undefined) return 'T'; out.add(v); } }
        else for (const a of l) for (const b of r) { const v = binop(e.op, a, b); if (v === undefined) return 'T'; out.add(v); }
        return out.size > MAXSET ? 'T' : [...out];
      }
      case 'IfExpr': {
        const ie: any = e;
        const acc: V[] = [];
        const go = (i: number): boolean => {
          if (i >= ie.clauses.length) { const v = this.ev(ie.elseValue, s); if (v === 'T') return false; acc.push(...v); return true; }
          const c = this.ev(ie.clauses[i].cond, s); if (c === 'T') return false;
          let anyT = false, anyF = false;
          for (const x of c) { if (truthy(x)) anyT = true; else anyF = true; }
          if (anyT) { const v = this.ev(ie.clauses[i].value, s); if (v === 'T') return false; acc.push(...v); }
          return anyF ? go(i + 1) : true;
        };
        if (!go(0)) return 'T';
        const u = [...new Set(acc)];
        return u.length > MAXSET ? 'T' : u;
      }
      default: return 'T';
    }
  }
  /** truth of a condition: true/false when decided for every possible state */
  truth(e: A.Expr, s: State): boolean | null {
    const v = this.ev(e, s); if (v === 'T' || !v.length) return null;
    const t = v.map(truthy);
    return t.every(Boolean) ? true : t.every(x => !x) ? false : null;
  }
  assignedIn(stmts: A.Stat[] | A.Stat, out: Set<Binding>) {
    const visit = (n: any) => {
      if (!n || typeof n !== 'object') return;
      if (Array.isArray(n)) { for (const x of n) visit(x); return; }
      if (n.type === 'AssignStat') for (const t of n.targets) { const b = this.tracked(t); if (b) out.add(b); }
      if (n.type === 'FunctionExpr') return;
      for (const k of Object.keys(n)) if (k !== 'loc') visit(n[k]);
    };
    visit(stmts);
  }
  terminates(stmts: A.Stat[]): boolean {
    const last = stmts[stmts.length - 1];
    return !!last && (last.type === 'ReturnStat' || last.type === 'BreakStat' || last.type === 'ContinueStat' || last.type === 'GotoStat');
  }
  /** abstract-execute a statement list, rewriting it in place */
  block(list: A.Stat[], s: State): State {
    for (let i = 0; i < list.length; i++) {
      const st = list[i];
      if (st.type === 'IfStat') {
        // decide clauses that are statically known
        const c0 = st.clauses[0];
        const t = this.truth(c0.cond, s);
        if (t === true) { list.splice(i, 1, { type: 'DoStat', body: c0.body, loc: st.loc }); this.folded++; i--; continue; }
        if (t === false) {
          this.folded++;
          if (st.clauses.length > 1) { st.clauses.shift(); i--; continue; }
          if (st.elseBody) { list.splice(i, 1, { type: 'DoStat', body: st.elseBody, loc: st.loc }); i--; continue; }
          list.splice(i, 1); i--; continue;
        }
        // unknown: try to merge a following complementary guard into else / then
        if (st.clauses.length === 1 && !st.elseBody) {
          const sThen = this.block(c0.body, new Map(s));
          const next = list[i + 1];
          if (next && next.type === 'IfStat' && next.clauses.length === 1 && !next.elseBody) {
            const thenFlows = !this.terminates(c0.body);
            const pThen = thenFlows ? this.truth(next.clauses[0].cond, sThen) : false;
            const pSkip = this.truth(next.clauses[0].cond, s);
            if (pSkip === true && pThen === false) {
              st.elseBody = next.clauses[0].body; list.splice(i + 1, 1); this.merged++;
              const sElse = this.block(st.elseBody, new Map(s));
              s = joinStates([...(thenFlows ? [sThen] : []), ...(this.terminates(st.elseBody) ? [] : [sElse])]);
              continue;
            }
            if (pSkip === false && pThen === true && thenFlows) {
              c0.body.push(...next.clauses[0].body); list.splice(i + 1, 1); this.merged++;
              const sAll = this.block(next.clauses[0].body, sThen);
              s = joinStates([sAll, s]);
              continue;
            }
          }
          s = joinStates([...(this.terminates(c0.body) ? [] : [sThen]), s]);
          continue;
        }
        const outs: State[] = [];
        for (const c of st.clauses) { const o = this.block(c.body, new Map(s)); if (!this.terminates(c.body)) outs.push(o); }
        if (st.elseBody) { const o = this.block(st.elseBody, new Map(s)); if (!this.terminates(st.elseBody)) outs.push(o); } else outs.push(s);
        s = joinStates(outs);
        continue;
      }
      if (st.type === 'WhileStat' || st.type === 'RepeatStat' || st.type === 'NumericForStat' || st.type === 'GenericForStat') {
        const mod = new Set<Binding>(); this.assignedIn((st as any).body, mod);
        if (st.type === 'WhileStat' || st.type === 'RepeatStat') this.assignedIn(st, mod);
        const entry: State = new Map(s); for (const b of mod) entry.set(b, 'T');
        if (st.type === 'WhileStat') { const t = this.truth(st.cond, entry); if (t === false) { list.splice(i, 1); this.folded++; i--; continue; } }
        this.block((st as any).body, new Map(entry));
        s = entry;
        this.funcsIn(st);
        continue;
      }
      if (st.type === 'DoStat') { s = this.block(st.body, s); continue; }
      if (st.type === 'LocalStat') {
        this.funcsIn(st);
        const vals = st.init.map(e => this.ev(e, s));
        const lastMulti = st.init.length > 0 && ['CallExpr', 'MethodCallExpr', 'VarargLit'].includes(unparen(st.init[st.init.length - 1]).type);
        const bs = this.byDecl.get(st) ?? [];
        st.names.forEach((_, k) => {
          const b = bs[k];
          if (!b || b.captured) return;
          s.set(b, k < st.init.length ? vals[k] : (lastMulti ? 'T' : [null]));
        });
        continue;
      }
      if (st.type === 'AssignStat') {
        this.funcsIn(st);
        if (st.op && st.targets.length === 1) {
          const b = this.tracked(st.targets[0]);
          if (b) { const bin: A.BinExpr = { type: 'BinExpr', op: st.op.slice(0, -1), left: st.targets[0], right: st.values[0] }; s.set(b, this.ev(bin, s)); }
          continue;
        }
        const vals = st.values.map(e => this.ev(e, s));
        st.targets.forEach((t, k) => { const b = this.tracked(t); if (b) s.set(b, k < vals.length ? vals[k] : 'T'); });
        continue;
      }
      this.funcsIn(st);
    }
    return s;
  }
  /** function bodies are analysed independently with a fresh state */
  funcsIn(n: any) {
    const visit = (x: any) => {
      if (!x || typeof x !== 'object') return;
      if (Array.isArray(x)) { for (const y of x) visit(y); return; }
      if (x.type === 'FunctionExpr') { this.runFn(x); return; }
      for (const k of Object.keys(x)) { if (k === 'loc' || k === 'body' || k === 'clauses' || k === 'elseBody') continue; visit(x[k]); }
    };
    visit(n);
  }
}

export function foldGuards(chunk: A.Chunk, opts: { aggressive?: boolean } = {}): { folded: number; merged: number } {
  const scope = analyzeScopes(chunk);
  const g = new GuardFolder(scope);
  g.aggressive = opts.aggressive ?? true;
  g.runFn(chunk);
  return { folded: g.folded, merged: g.merged + g.storesRemoved };
}

/** Inline `do ... end` blocks whose removal cannot change scoping or syntax. */
export function flattenDo(chunk: A.Chunk): number {
  let n = 0;
  const visitList = (list: A.Stat[], inRepeat: boolean) => {
    for (let i = 0; i < list.length; i++) {
      const s = list[i];
      visitStat(s);
      if (s.type !== 'DoStat') continue;
      if (!s.body.length) { list.splice(i, 1); i--; n++; continue; }
      const isLast = i === list.length - 1;
      const last = s.body[s.body.length - 1];
      const endsExit = last.type === 'ReturnStat' || last.type === 'BreakStat' || last.type === 'ContinueStat';
      if (endsExit && !isLast) continue;
      const locals = topLocalNames(s.body);
      if (locals.length && (!isLast || inRepeat)) {
        // safe when later statements never mention the names
        if (inRepeat || mentions(list.slice(i + 1), locals)) continue;
      }
      list.splice(i, 1, ...s.body); i--; n++;
    }
  };
  const visitStat = (s: A.Stat) => {
    switch (s.type) {
      case 'DoStat': visitList(s.body, false); break;
      case 'WhileStat': case 'NumericForStat': case 'GenericForStat': visitList((s as any).body, false); break;
      case 'RepeatStat': visitList(s.body, true); break;
      case 'IfStat': for (const c of s.clauses) visitList(c.body, false); if (s.elseBody) visitList(s.elseBody, false); break;
      case 'LocalFunctionStat': case 'FunctionStat': visitList(s.func.body, false); break;
    }
    // function expressions nested inside expressions
    const scan = (x: any) => {
      if (!x || typeof x !== 'object') return;
      if (Array.isArray(x)) { for (const y of x) scan(y); return; }
      if (x.type === 'FunctionExpr') { visitList(x.body, false); return; }
      for (const k of Object.keys(x)) { if (k === 'loc' || k === 'body' || k === 'elseBody' || k === 'func') continue; if (k === 'clauses') { for (const c of x.clauses) scan(c.cond); continue; } scan(x[k]); }
    };
    scan(s);
  };
  visitList(chunk.body, false);
  return n;
}

/** `local x; x = e` -> `local x = e` (adjacent, e does not mention x) */
export function mergeDeclAssign(chunk: A.Chunk): number {
  let n = 0;
  forEachStatList(chunk, (list) => {
    for (let i = 0; i + 1 < list.length; i++) {
      const d = list[i], a = list[i + 1];
      if (d.type !== 'LocalStat' || d.init.length || d.names.length !== 1) continue;
      if (a.type !== 'AssignStat' || a.op || a.targets.length !== 1 || a.values.length !== 1) continue;
      const t = a.targets[0];
      if (t.type !== 'NameExpr' || t.name !== d.names[0] || mentions([{ type: 'ReturnStat', args: a.values }], [t.name])) continue;
      d.init = a.values; list.splice(i + 1, 1); n++;
    }
  });
  return n;
}
