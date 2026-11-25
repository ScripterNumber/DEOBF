// Drop never-used names from value-less local declarations:  local a, b, c  ->  local b
// A name is dropped only if no NameExpr anywhere in the enclosing function (nested functions
// included) refers to it; a declaration left with no names is removed.
import type * as A from '../ast.js';
import { visit } from './inlinetemps.js';

export function pruneLocals(chunk: A.Chunk): number {
  let total = 0;
  const doFunc = (body: A.Stat[]) => {
    const used = new Set<string>();
    visit(body, n => { if (n.type === 'NameExpr') used.add(n.name); });
    const block = (stmts: any[]) => {
      for (let i = 0; i < stmts.length; i++) {
        const s = stmts[i];
        if (s.type === 'IfStat') { s.clauses.forEach((c: any) => block(c.body)); if (s.elseBody) block(s.elseBody); }
        else if (['WhileStat', 'RepeatStat', 'NumericForStat', 'GenericForStat', 'DoStat'].includes(s.type)) block(s.body);
        if (s.type === 'LocalStat' && s.init.length === 0 && !(s.attribs ?? []).some((a: any) => a)) {
          const keep = s.names.filter((nm: string) => used.has(nm));
          total += s.names.length - keep.length;
          if (!keep.length) { stmts.splice(i, 1); i--; } else { s.names = keep; if (s.attribs) s.attribs = keep.map(() => null); }
        }
      }
    };
    block(body);
  };
  doFunc(chunk.body);
  visit(chunk.body, n => { if (n.type === 'FunctionExpr') doFunc(n.body); });
  return total;
}
