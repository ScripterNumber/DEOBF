// Lower Luau if-expressions in statement-level single-value positions into if-statements, so the
// statement-based passes (CFF unflattening, guard folding, dead stores, VM recognisers) see the branches:
//   x = if c then a else b          ->  if c then x = a else x = b end
//   local x = if c then a else b    ->  local x; if c then x = a else x = b end   (only when c/a/b do not mention x)
//   return if c then a else b       ->  if c then return a else return b end
// Branch calls are parenthesised to keep exactly one value. Nested if-expressions are lowered on later
// clean() rounds. Universal: no obfuscator-specific shape.
import { walk } from '../ast.js';

const callish = (x: any) => !!x && (x.type === 'CallExpr' || x.type === 'MethodCallExpr' || x.type === 'VarargLit');
const one = (x: any): any => callish(x) ? { type: 'ParenExpr', expr: x, loc: x.loc } : x;
const nameList = (ts: any[]) => ts.map(t => ({ type: 'NameExpr', name: t.name, loc: t.loc }));

function mentions(node: any, names: Set<string>): boolean {
  let hit = false;
  walk(node, (n: any) => { if (!hit && n && n.type === 'NameExpr' && names.has(n.name)) hit = true; });
  return hit;
}

function build(ie: any, mk: (v: any) => any, loc: any): any {
  return {
    type: 'IfStat',
    clauses: ie.clauses.map((c: any) => ({ cond: c.cond, body: [mk(one(c.value))] })),
    elseBody: [mk(one(ie.elseValue))],
    loc,
  };
}

function lower(s: any): any[] | null {
  if (s.type === 'AssignStat' && !s.op && s.values.length === 1 && s.values[0].type === 'IfExpr'
      && s.targets.length >= 1 && s.targets.every((t: any) => t.type === 'NameExpr')) {
    return [build(s.values[0], v => ({ type: 'AssignStat', targets: nameList(s.targets), values: [v], loc: s.loc }), s.loc)];
  }
  if (s.type === 'LocalStat' && s.init.length === 1 && s.init[0].type === 'IfExpr'
      && !(s.attribs && s.attribs.some((a: any) => a)) && !mentions(s.init[0], new Set(s.names))) {
    return [
      { ...s, init: [] },
      build(s.init[0], v => ({ type: 'AssignStat', targets: s.names.map((n: string) => ({ type: 'NameExpr', name: n })), values: [v], loc: s.loc }), s.loc),
    ];
  }
  if (s.type === 'ReturnStat' && s.args.length === 1 && s.args[0].type === 'IfExpr') {
    return [build(s.args[0], v => ({ type: 'ReturnStat', args: [v], loc: s.loc }), s.loc)];
  }
  return null;
}

/** lowers in place; returns the number of if-expressions lowered */
export function lowerIfExprs(root: any): number {
  let n = 0;
  const visit = (node: any): void => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      const block = node.length > 0 && node.every((x: any) => x && typeof x.type === 'string' && x.type.endsWith('Stat'));
      for (const x of node) visit(x);
      if (block) for (let i = 0; i < node.length; i++) {
        const r = lower(node[i]);
        if (r) { node.splice(i, 1, ...r); n++; i += r.length - 1; }
      }
      return;
    }
    for (const k of Object.keys(node)) if (k !== 'loc') visit(node[k]);
  };
  visit(root);
  return n;
}
