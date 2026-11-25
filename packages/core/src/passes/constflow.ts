// Flow-sensitive constant & copy propagation over the structured AST — universal, conservative.
//
//   x = 5; …; f(x)          ->  f(5)        (x not reassigned on any path in between)
//   t = R; …; t[k] = v      ->  R[k] = v    (copy of a local that is still unchanged)
//
// Tracked: locals that are never written from a nested closure (so no call can change them).
// Values: number/string/boolean/nil literals, integer arithmetic over them (so the counter of an
// unrolled loop — `n = n + 1` / `n += 1` — stays a known constant), copies of tracked locals, and caller-declared
// constant globals (e.g. the read-only record names introduced by the VM specialiser).
// Control flow: if/elseif/else branches are processed separately and merged (a branch that
// ends in return/break/continue does not reach the join); loops first forget every variable
// assigned anywhere inside them, so no iteration can observe a stale value. Reads inside
// nested functions are never replaced (they may run later). Functions containing goto/labels
// are skipped.
import type * as A from '../ast.js';
import { walk } from '../ast.js';
import { analyzeScopes, Binding } from '../analysis/scope.js';

interface Val { key: string; expr: A.Expr; src?: Binding; }
type Env = Map<Binding, Val>;

export interface ConstFlowOptions {
  /** global names whose value never changes (treated like literals) */
  constGlobals?: (name: string) => boolean;
  /** longest string literal that is copied into use sites (default 80) */
  maxString?: number;
}

const unparen = (e: A.Expr): A.Expr => { while (e && e.type === 'ParenExpr') e = e.expr; return e; };

/** integer arithmetic that gives the same result in Lua 5.1-5.4 and Luau (no floats, no -0, no overflow) */
export function arithInt(op: string, a: number, b: number): number | null {
  let r: number;
  const small = Math.abs(a) <= 2 ** 31 && Math.abs(b) <= 2 ** 31;
  switch (op) {
    case '+': r = a + b; break;
    case '-': r = a - b; break;
    case '*': r = a * b; break;
    case '//': if (b === 0 || !small) return null; r = Math.floor(a / b); break;
    case '%': if (b === 0 || !small) return null; r = a - Math.floor(a / b) * b; break;
    default: return null;
  }
  return Number.isSafeInteger(r) && !Object.is(r, -0) ? r : null;
}
/** value of an integer-literal arithmetic expression (`3`, `-2`, `0x10`, `(1 + 1) * 4`); floats are left alone */
export function intOf(e: A.Expr, depth = 0): number | null {
  const u = unparen(e);
  if (!u || depth > 16) return null;
  switch (u.type) {
    case 'NumberLit': return Number.isSafeInteger(u.value) && !Object.is(u.value, -0) && (!u.raw || /^(?:\d+|0[xX][0-9a-fA-F]+)$/.test(u.raw.replace(/_/g, ''))) ? u.value : null;
    case 'UnExpr': { if (u.op !== '-') return null; const v = intOf(u.expr, depth + 1); return v === null || v === 0 ? null : -v; }
    case 'BinExpr': { const a = intOf(u.left, depth + 1); if (a === null) return null; const b = intOf(u.right, depth + 1); return b === null ? null : arithInt(u.op, a, b); }
  }
  return null;
}
const intExpr = (r: number): A.Expr => r < 0
  ? { type: 'UnExpr', op: '-', expr: { type: 'NumberLit', value: -r, raw: String(-r) } } as A.Expr
  : { type: 'NumberLit', value: r, raw: String(r) } as A.Expr;
const isMulti = (e: A.Expr | undefined) => !!e && (e.type === 'CallExpr' || e.type === 'MethodCallExpr' || e.type === 'VarargLit');

/** standard-library tables whose fields constFlow may propagate (when the global is never assigned) */
const LIB_TABLES = new Set(['string', 'table', 'math', 'bit32', 'buffer', 'utf8', 'coroutine', 'os', 'debug', 'task']);

export function constFlow(chunk: A.Chunk, opts: ConstFlowOptions = {}): number {
  const scope = analyzeScopes(chunk);
  const maxStr = opts.maxString ?? 80;
  const declOf = new Map<any, Binding[]>();
  for (const b of scope.bindings) if (b.decl) { let l = declOf.get(b.decl); if (!l) { l = []; declOf.set(b.decl, l); } l[b.index] = b; }
  const writeSet = new Set<A.NameExpr>(); for (const b of scope.bindings) for (const w of b.writeRefs) writeSet.add(w);
  let n = 0;
  const scopes: Array<Map<string, Binding>> = [];
  const visible = (name: string): Binding | undefined => { for (let i = scopes.length - 1; i >= 0; i--) { const b = scopes[i].get(name); if (b) return b; } return scope.globals.get(name); };
  const trackable = (b: Binding | undefined): b is Binding => !!b && b.kind !== 'global' && !b.capturedWrite;
  const declare = (name: string, b: Binding | undefined) => { if (b) scopes[scopes.length - 1].set(name, b); };

  const valOf = (e: A.Expr): Val | null => {
    const u = unparen(e);
    switch (u.type) {
      case 'NumberLit': return Number.isFinite(u.value) ? { key: 'n:' + (Object.is(u.value, -0) ? '-0' : String(u.value)), expr: u } : null;
      case 'StringLit': return u.value.length <= maxStr ? { key: 's:' + u.value, expr: u } : null;
      case 'TrueLit': return { key: 'b:1', expr: u };
      case 'FalseLit': return { key: 'b:0', expr: u };
      case 'NilLit': return { key: 'nil', expr: u };
      case 'UnExpr': { const v = unparen(u.expr); if (u.op === '-' && v.type === 'NumberLit' && Number.isFinite(v.value)) return { key: 'n:' + String(-v.value), expr: u }; const r = intOf(u); return r === null ? null : { key: 'n:' + String(r), expr: intExpr(r) }; }
      case 'BinExpr': { const r = intOf(u); return r === null ? null : { key: 'n:' + String(r), expr: intExpr(r) }; }
      case 'NameExpr': {
        const b = scope.refOf.get(u); if (!b) return null;
        if (b.kind === 'global') return opts.constGlobals?.(u.name) && visible(u.name) === b ? { key: 'g:' + u.name, expr: u, src: b } : null;
        if (!trackable(b)) return null;
        return { key: 'v:' + b.id, expr: { type: 'NameExpr', name: b.name }, src: b };
      }
      case 'MemberExpr':
      case 'IndexExpr': {
        // standard-library functions (`table.move`, `string["rep"]`) held in reused scratch locals — VM residual code
        // loads them into registers right before the call; the library table must be a never-written global
        const o = unparen(u.obj);
        if (o.type !== 'NameExpr' || !LIB_TABLES.has(o.name)) return null;
        const b = scope.refOf.get(o); if (!b || b.kind !== 'global' || b.writeRefs.length || visible(o.name) !== b) return null;
        let field: string | null = null;
        if (u.type === 'MemberExpr') field = u.name; else { const k = unparen(u.index); if (k.type === 'StringLit') field = k.value; }
        if (field === null || !/^[A-Za-z_]\w*$/.test(field)) return null;
        return { key: 'p:' + o.name + '.' + field, expr: { type: 'MemberExpr', obj: { type: 'NameExpr', name: o.name }, name: field } as A.Expr, src: b };
      }
    }
    return null;
  };
  const invalidate = (env: Env, b: Binding) => { env.delete(b); for (const [k, v] of env) if (v.src === b) env.delete(k); };

  const sub = (e: A.Expr, env: Env): A.Expr => {
    if (!e) return e;
    switch (e.type) {
      case 'NameExpr': {
        const b = scope.refOf.get(e);
        if (!b || !env.size || writeSet.has(e)) return e;
        const v = env.get(b); if (!v) return e;
        if (v.src && visible(v.src.name) !== v.src) return e;
        n++;
        const c = structuredClone(v.expr) as A.Expr;
        if (c.type === 'NameExpr' && v.src) { scope.refOf.set(c, v.src); v.src.refs.push(c); }
        return c;
      }
      case 'ParenExpr': e.expr = sub(e.expr, env); return e;
      case 'UnExpr': e.expr = sub(e.expr, env); return e;
      case 'BinExpr': e.left = sub(e.left, env); e.right = sub(e.right, env); return e;
      case 'CallExpr': e.callee = sub(e.callee, env); e.args = e.args.map(a => sub(a, env)); return e;
      case 'MethodCallExpr': e.obj = sub(e.obj, env); e.args = e.args.map(a => sub(a, env)); return e;
      case 'IndexExpr': e.obj = sub(e.obj, env); e.index = sub(e.index, env); return e;
      case 'MemberExpr': e.obj = sub(e.obj, env); return e;
      case 'TableExpr': for (const f of e.fields) { if (f.key) f.key = sub(f.key, env); f.value = sub(f.value, env); } return e;
      case 'InterpExpr': for (const p of e.parts) if (p.kind === 'expr') p.expr = sub(p.expr, env); return e;
      case 'IfExpr': for (const c of e.clauses) { c.cond = sub(c.cond, env); c.value = sub(c.value, env); } e.elseValue = sub(e.elseValue, env); return e;
      case 'FunctionExpr': fn(e); return e;
      default: return e;
    }
  };
  const copy = (env: Env): Env => new Map(env);
  const merge = (envs: Env[]): Env | null => {
    if (!envs.length) return null;
    const out = copy(envs[0]);
    for (const e of envs.slice(1)) for (const [k, v] of out) { const w = e.get(k); if (!w || w.key !== v.key) out.delete(k); }
    return out;
  };
  /** every binding assigned or declared inside node (nested functions included: conservative) */
  const killSet = (node: any): Set<Binding> => {
    const s = new Set<Binding>();
    walk(node, (m: any) => {
      if (m.type === 'NameExpr' && writeSet.has(m)) { const b = scope.refOf.get(m); if (b) s.add(b); }
      if (m.type === 'LocalStat' || m.type === 'NumericForStat' || m.type === 'GenericForStat' || m.type === 'LocalFunctionStat') for (const b of declOf.get(m) ?? []) if (b) s.add(b);
    });
    return s;
  };
  const killed = (env: Env, node: any): Env => { const out = copy(env); for (const b of killSet(node)) invalidate(out, b); return out; };

  const list = (stmts: A.Stat[], env: Env, ownScope = true): Env | null => {
    if (ownScope) scopes.push(new Map());
    let cur: Env | null = env;
    for (const s of stmts) { if (!cur) break; cur = stat(s, cur); }
    if (ownScope) scopes.pop();
    return cur;
  };
  const stat = (s: A.Stat, env: Env): Env | null => {
    switch (s.type) {
      case 'LocalStat': {
        s.init = s.init.map(e => sub(e, env));
        const bs = declOf.get(s) ?? [];
        const vals: Array<Val | null> = s.names.map((_, q) => {
          if (q < s.init.length) { if (q === s.init.length - 1 && q < s.names.length - 1 && isMulti(s.init[q])) return null; if (q === s.init.length - 1 && isMulti(s.init[q]) && s.init.length < s.names.length) return null; return valOf(s.init[q]); }
          if (s.init.length && isMulti(s.init[s.init.length - 1])) return null;
          return { key: 'nil', expr: { type: 'NilLit' } };
        });
        s.names.forEach((nm, q) => { const b = bs[q]; declare(nm, b); if (!b) return; invalidate(env, b); const v = vals[q]; if (v && trackable(b) && !(s.attribs && s.attribs[q] === 'close')) env.set(b, v); });
        return env;
      }
      case 'AssignStat': {
        for (const t of s.targets) { if (t.type === 'IndexExpr') { t.obj = sub(t.obj, env); t.index = sub(t.index, env); } else if (t.type === 'MemberExpr') t.obj = sub(t.obj, env); }
        s.values = s.values.map(e => sub(e, env));
        const tb: Array<Binding | undefined> = s.targets.map(t => t.type === 'NameExpr' ? scope.refOf.get(t) : undefined);
        const vals: Array<Val | null> = s.targets.map((_, q) => {
          if (s.op) {
            if (q !== 0 || s.targets.length !== 1 || s.values.length !== 1) return null;
            const b = tb[0], cv = b ? env.get(b) : undefined;
            if (!cv || cv.src) return null;
            const a = intOf(cv.expr), c = intOf(s.values[0]);
            const r = a === null || c === null ? null : arithInt(s.op.replace(/=$/, ''), a, c);
            return r === null ? null : { key: 'n:' + String(r), expr: intExpr(r) };
          }
          if (q < s.values.length) { if (q === s.values.length - 1 && isMulti(s.values[q]) && s.values.length < s.targets.length) return null; return valOf(s.values[q]); }
          if (s.values.length && isMulti(s.values[s.values.length - 1])) return null;
          return { key: 'nil', expr: { type: 'NilLit' } };
        });
        for (const b of tb) if (b) invalidate(env, b);
        tb.forEach((b, q) => { const v = vals[q]; if (b && v && trackable(b) && !(v.src && tb.includes(v.src))) env.set(b, v); });
        return env;
      }
      case 'CallStat': s.expr = sub(s.expr, env) as any; return env;
      case 'DoStat': return list(s.body, env);
      case 'IfStat': {
        const outs: Env[] = [];
        for (const c of s.clauses) { c.cond = sub(c.cond, env); const r = list(c.body, copy(env)); if (r) outs.push(r); }
        if (s.elseBody) { const r = list(s.elseBody, copy(env)); if (r) outs.push(r); } else outs.push(env);
        return merge(outs);
      }
      case 'WhileStat': {
        const e2 = killed(env, s);
        s.cond = sub(s.cond, e2);
        list(s.body, copy(e2));
        return e2;
      }
      case 'RepeatStat': {
        const e2 = killed(env, s);
        scopes.push(new Map());
        const end = list(s.body, copy(e2), false);
        s.cond = sub(s.cond, end ?? e2);
        scopes.pop();
        return e2;
      }
      case 'NumericForStat': {
        s.from = sub(s.from, env); s.to = sub(s.to, env); if (s.step) s.step = sub(s.step, env);
        const e2 = killed(env, s);
        scopes.push(new Map()); declare(s.var, (declOf.get(s) ?? [])[0]);
        list(s.body, copy(e2));
        scopes.pop();
        return e2;
      }
      case 'GenericForStat': {
        s.iters = s.iters.map(e => sub(e, env));
        const e2 = killed(env, s);
        scopes.push(new Map()); s.names.forEach((nm, q) => declare(nm, (declOf.get(s) ?? [])[q]));
        list(s.body, copy(e2));
        scopes.pop();
        return e2;
      }
      case 'ReturnStat': s.args = s.args.map(e => sub(e, env)); return null;
      case 'BreakStat': case 'ContinueStat': case 'GotoStat': return null;
      case 'FunctionStat': {
        if (s.target.type === 'IndexExpr') { s.target.obj = sub(s.target.obj, env); s.target.index = sub(s.target.index, env); }
        else if (s.target.type === 'MemberExpr') s.target.obj = sub(s.target.obj, env);
        else if (s.target.type === 'NameExpr') { const b = scope.refOf.get(s.target); if (b) invalidate(env, b); }
        fn(s.func);
        return env;
      }
      case 'LocalFunctionStat': { const b = (declOf.get(s) ?? [])[0]; declare(s.name, b); if (b) invalidate(env, b); fn(s.func); return env; }
      default: return env;
    }
  };
  const hasGoto = (f: A.FunctionExpr | A.Chunk) => { let hit = false; walk(f.body, (m: any) => { if (m.type === 'GotoStat' || m.type === 'LabelStat') hit = true; }); return hit; };
  const fn = (f: A.FunctionExpr) => {
    scopes.push(new Map());
    f.params.forEach((p, q) => declare(p, (declOf.get(f) ?? [])[q]));
    if (!hasGoto(f)) list(f.body, new Map());
    else walk(f.body, (m: any) => { if (m.type === 'FunctionExpr' && m !== f) { /* nested functions are visited by their own walk below */ } });
    scopes.pop();
  };
  scopes.push(new Map());
  if (!hasGoto(chunk)) list(chunk.body, new Map(), false);
  scopes.pop();
  return n;
}

/** `for i = a, b[, s] do BODY end` with integer literal bounds and at most maxIter iterations
 *  -> `do local i = a; BODY end do local i = a + s; BODY end …` (fresh local per iteration, as in
 *  Lua). Loops whose body breaks/continues/jumps at loop level, or whose body is large, stay. */
/** `wide(loop)`: loops that fold away once unrolled (e.g. the body reads a constant table at the loop index)
 *  may run up to `wideIter` iterations */
export function unrollSmallFor(chunk: A.Chunk, maxIter = 8, maxBody = 60, wide?: (loop: A.NumericForStat) => boolean, wideIter = 64): number {
  let n = 0;
  const num = (e: A.Expr | undefined, d: number): number | null => {
    if (!e) return d;
    const u = unparen(e);
    if (u.type === 'NumberLit') return Number.isInteger(u.value) ? u.value : null;
    if (u.type === 'UnExpr' && u.op === '-') { const v = unparen(u.expr); if (v.type === 'NumberLit' && Number.isInteger(v.value)) return -v.value; }
    return null;
  };
  const loopLevelJump = (body: A.Stat[]): boolean => {
    let hit = false;
    const scan = (m: any, nested: boolean) => {
      if (hit || !m || typeof m !== 'object') return;
      if (Array.isArray(m)) { for (const x of m) scan(x, nested); return; }
      if (m.type === 'FunctionExpr') return;
      if ((m.type === 'BreakStat' || m.type === 'ContinueStat') && !nested) { hit = true; return; }
      if (m.type === 'GotoStat' || m.type === 'LabelStat') { hit = true; return; }
      const loop = m.type === 'WhileStat' || m.type === 'RepeatStat' || m.type === 'NumericForStat' || m.type === 'GenericForStat';
      for (const k of Object.keys(m)) if (k !== 'loc') scan(m[k], nested || loop);
    };
    scan(body, false);
    return hit;
  };
  const size = (x: any) => { let c = 0; walk(x, (m: any) => { if (m && typeof m.type === 'string' && /Stat$/.test(m.type)) c++; }); return c; };
  const visit = (list: A.Stat[]) => {
    for (let i = 0; i < list.length; i++) {
      const s = list[i];
      if (s.type !== 'NumericForStat') continue;
      const a = num(s.from, NaN), b = num(s.to, NaN), st = num(s.step, 1);
      if (a === null || b === null || st === null || !Number.isFinite(a) || !Number.isFinite(b) || st === 0) continue;
      const trips = st > 0 ? (b >= a ? Math.floor((b - a) / st) + 1 : 0) : (a >= b ? Math.floor((a - b) / -st) + 1 : 0);
      const isWide = trips > maxIter && trips <= wideIter && !!wide && wide(s);
      if ((trips > maxIter && !isWide) || loopLevelJump(s.body) || (!isWide && size(s.body) * trips > maxBody * Math.max(1, Math.min(trips, 4))) || (isWide && size(s.body) * trips > 4000)) continue;
      const out: A.Stat[] = [];
      for (let q = 0; q < trips; q++) {
        const v = a + q * st;
        const init: A.Expr = v < 0 ? { type: 'UnExpr', op: '-', expr: { type: 'NumberLit', value: -v, raw: String(-v) } } : { type: 'NumberLit', value: v, raw: String(v) };
        out.push({ type: 'DoStat', body: [{ type: 'LocalStat', names: [s.var], init: [init] }, ...structuredClone(s.body)] });
      }
      // a return inside a do-block is fine; keep the statement count stable for callers
      list.splice(i, 1, ...out);
      i += out.length - 1;
      n++;
    }
  };
  // innermost lists first is not required: the clean() rounds repeat until nothing changes
  const lists: A.Stat[][] = [];
  walk(chunk, (m: any) => { for (const k of ['body', 'elseBody']) if (Array.isArray(m[k])) lists.push(m[k]); if (m.type === 'IfStat') for (const c of m.clauses) lists.push(c.body); });
  lists.push(chunk.body);
  for (const l of lists) visit(l);
  return n;
}
