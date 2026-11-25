// Known-truthy operands \u2014 universal, sound.
//
//   for i = 106, top do R[i] = v[i - 105] end       for i = 106, top do R[i] = v[i - 105] end
//   f(table.unpack(R, 104, top or #R))         ->   f(table.unpack(R, 104, top))
//
// A local is known truthy (neither nil nor false) where every path to the use passes a definition that
// cannot give nil / false \u2014 a number or string literal, `true`, a table or function constructor, another
// known-truthy local \u2014 or a numeric for loop that has the local as a bound (the loop raises an error on a
// nil / false bound), with no write of the local in between. There `x or y` becomes `x` and `x and y`
// becomes `y`. Forward must-analysis over the structured statements: branches meet by intersection, loop
// bodies only keep facts about locals they never write, labels reset everything, locals written by nested
// closures are never tracked. (VM residuals use `top or #R` as the multiple-results bound; dropping the dead
// `#R` lets the register file be promoted.)
import type * as A from '../ast.js';
import { analyzeScopes, Binding } from '../analysis/scope.js';

const unparen = (e: A.Expr): A.Expr => { while (e && e.type === 'ParenExpr') e = (e as A.ParenExpr).expr; return e; };
const isMulti = (e: A.Expr | undefined) => !!e && (e.type === 'CallExpr' || e.type === 'MethodCallExpr' || e.type === 'VarargLit');
const TERMINAL = new Set(['ReturnStat', 'BreakStat', 'ContinueStat', 'GotoStat']);
type S = Set<Binding>;

export function foldKnownTruthy(chunk: A.Chunk): number {
  const sc = analyzeScopes(chunk);
  const declB = new Map<unknown, Binding[]>();
  for (const b of sc.bindings) if (b.decl) { const l = declB.get(b.decl); if (l) l.push(b); else declB.set(b.decl, [b]); }
  const tracked = (b: Binding | undefined): b is Binding => !!b && b.kind !== 'global' && !b.capturedWrite;
  const bindingOf = (e: A.Expr | undefined): Binding | undefined => { const u = e && unparen(e); return u && u.type === 'NameExpr' ? sc.refOf.get(u as A.NameExpr) : undefined; };
  let n = 0;

  const truthy = (e: A.Expr | undefined, s: S): boolean => {
    if (!e) return false;
    const u = unparen(e);
    switch (u.type) {
      case 'NumberLit': case 'StringLit': case 'TrueLit': case 'TableExpr': case 'FunctionExpr': return true;
      case 'NameExpr': { const b = sc.refOf.get(u as A.NameExpr); return !!b && s.has(b); }
      default: return false;
    }
  };
  // rewrite the expressions evaluated at this point (nested functions get their own, empty state)
  const rw = (node: any, s: S): any => {
    if (!node || typeof node !== 'object') return node;
    if (Array.isArray(node)) { for (let i = 0; i < node.length; i++) node[i] = rw(node[i], s); return node; }
    if (node.type === 'FunctionExpr') { block(node.body, new Set()); return node; }
    for (const k of Object.keys(node)) {
      if (k === 'loc' || k === 'type') continue;
      const v = node[k];
      if (v && typeof v === 'object') node[k] = rw(v, s);
    }
    if (node.type === 'BinExpr' && (node.op === 'or' || node.op === 'and') && truthy(node.left, s)) { n++; return node.op === 'or' ? node.left : node.right; }
    return node;
  };
  const writesIn = (root: any): Set<Binding> => {
    const w = new Set<Binding>();
    const visit = (node: any) => {
      if (!node || typeof node !== 'object') return;
      if (Array.isArray(node)) { for (const x of node) visit(x); return; }
      if (node.type === 'AssignStat') for (const t of node.targets) { const b = bindingOf(t); if (b) w.add(b); }
      if (node.type === 'FunctionStat') { const b = bindingOf(node.target); if (b) w.add(b); }
      for (const k of Object.keys(node)) if (k !== 'loc' && k !== 'type') visit(node[k]);
    };
    visit(root);
    return w;
  };
  const minus = (s: S, w: Set<Binding>): S => { const r = new Set(s); for (const b of w) r.delete(b); return r; };
  const assignTo = (b: Binding | undefined, value: A.Expr | undefined, single: boolean, s: S, before: S) => {
    if (!tracked(b)) return;
    if (single && truthy(value, before)) s.add(b); else s.delete(b);
  };
  const replace = (s: S, by: S) => { s.clear(); for (const b of by) s.add(b); };

  function block(list: A.Stat[], s: S) { for (const st of list) stat(st, s); }
  function stat(st: A.Stat, s: S) {
    const x = st as any;
    switch (st.type) {
      case 'LocalStat': {
        rw(x.init, s);
        const before = new Set(s);
        const bs = declB.get(st) ?? [];
        for (const b of bs) assignTo(b, x.init[b.index], b.index < x.init.length, s, before);
        return;
      }
      case 'AssignStat': {
        rw(x.values, s);
        for (const t of x.targets) if (unparen(t).type !== 'NameExpr') rw(t, s);
        const before = new Set(s);
        x.targets.forEach((t: A.Expr, i: number) => {
          const b = bindingOf(t);
          if (x.op) { if (tracked(b)) s.delete(b); return; }
          assignTo(b, x.values[i], i < x.values.length, s, before);
        });
        return;
      }
      case 'CallStat': case 'ReturnStat': rw(st, s); return;
      case 'DoStat': block(x.body, s); return;
      case 'IfStat': {
        const outs: S[] = [];
        for (const c of x.clauses) {
          c.cond = rw(c.cond, s);
          const cs = new Set(s); block(c.body, cs);
          if (!c.body.length || !TERMINAL.has(c.body[c.body.length - 1].type)) outs.push(cs);
        }
        if (x.elseBody) { const cs = new Set(s); block(x.elseBody, cs); if (!x.elseBody.length || !TERMINAL.has(x.elseBody[x.elseBody.length - 1].type)) outs.push(cs); }
        else outs.push(new Set(s));
        if (!outs.length) return;
        const inter = new Set([...outs[0]].filter(b => outs.every(o => o.has(b))));
        replace(s, inter);
        return;
      }
      case 'WhileStat': {
        const e = minus(s, writesIn(x.body));
        x.cond = rw(x.cond, e);
        block(x.body, new Set(e));
        replace(s, e);
        return;
      }
      case 'RepeatStat': {
        const e = minus(s, writesIn(x.body));
        block(x.body, new Set(e));
        x.cond = rw(x.cond, e);
        replace(s, e);
        return;
      }
      case 'NumericForStat': {
        x.from = rw(x.from, s); x.to = rw(x.to, s); if (x.step) x.step = rw(x.step, s);
        for (const bound of [x.from, x.to, x.step]) { const b = bindingOf(bound); if (tracked(b)) s.add(b); }
        const e = minus(s, writesIn(x.body));
        block(x.body, new Set(e));
        replace(s, e);
        return;
      }
      case 'GenericForStat': {
        rw(x.iters, s);
        const e = minus(s, writesIn(x.body));
        block(x.body, new Set(e));
        replace(s, e);
        return;
      }
      case 'LocalFunctionStat': {
        block(x.func.body, new Set());
        for (const b of declB.get(st) ?? []) if (tracked(b)) s.add(b);
        return;
      }
      case 'FunctionStat': {
        block(x.func.body, new Set());
        if (x.target && unparen(x.target).type !== 'NameExpr') rw(x.target, s);
        const b = bindingOf(x.target);
        if (tracked(b)) s.add(b);
        return;
      }
      case 'BreakStat': case 'ContinueStat': return;
      default:
        // labels (goto targets) and anything unknown: forget everything
        s.clear();
        return;
    }
  }
  block(chunk.body, new Set());
  return n;
}
