// Remove redundant parentheses. A ParenExpr is only semantically meaningful when
// it truncates a multi-value expression (call / vararg) to one value; all other
// grouping is re-derived by the precedence-aware printer.
export function stripParens(node: any): number {
  let removed = 0;
  const seen = new Set<any>();
  const visit = (n: any) => {
    if (!n || typeof n !== 'object' || seen.has(n)) return;
    seen.add(n);
    const keys = Array.isArray(n) ? n.map((_: any, i: number) => i) : Object.keys(n);
    for (const k of keys) {
      if (k === 'loc') continue;
      let v = n[k];
      while (v && v.type === 'ParenExpr') {
        const inner = v.expr;
        if (!inner || inner.type === 'CallExpr' || inner.type === 'MethodCallExpr' || inner.type === 'VarargLit') break;
        v = inner; removed++;
      }
      if (v !== n[k]) n[k] = v;
      if (v && typeof v === 'object') visit(v);
    }
  };
  visit(node);
  return removed;
}
