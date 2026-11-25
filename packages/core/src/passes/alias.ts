// PRISM alias/proxy analysis.
// Finds `local x = bit32.bxor`, `local c = string.char`, `local f = a.b.c`
// so that folding/string passes can resolve indirection. Universal: works on any names.
import type * as A from '../ast.js';

export interface AliasMap {
  // local name -> canonical dotted builtin path, e.g. 'J' -> 'bit32.bxor'
  builtins: Map<string, string>;
  resolveBit(name: string): string | null;   // -> 'bxor'|'band'|'bor'|null
  resolveStr(name: string): string | null;    // -> 'string.char'|'table.concat'|...|null
}

const BIT_OPS = new Set(['bxor', 'band', 'bor', 'rshift', 'lshift', 'bnot', 'arshift', 'lrotate', 'rrotate', 'countlz', 'countrz', 'extract', 'replace', 'btest', 'byteswap']);

export function analyzeAliases(chunk: A.Chunk): AliasMap {
  const builtins = new Map<string, string>();

  function dotted(e: A.Expr): string | null {
    if (e.type === 'NameExpr') return builtins.get(e.name) ?? e.name;
    if (e.type === 'MemberExpr') { const base = dotted(e.obj); return base ? base + '.' + e.name : null; }
    return null;
  }

  (function rec(body: A.Stat[]) {
    for (const s of body) {
      if (s.type === 'LocalStat') {
        s.names.forEach((nm, i) => {
          const init = s.init[i];
          if (init) { const d = dotted(init); if (d && d.includes('.')) builtins.set(nm, d); }
        });
      } else if (s.type === 'AssignStat' && s.targets.length === s.values.length) {
        s.targets.forEach((t, i) => {
          if (t.type === 'NameExpr') { const d = dotted(s.values[i]); if (d && d.includes('.')) builtins.set(t.name, d); }
        });
      }
      // recurse
      const kids = childBlocks(s);
      for (const b of kids) rec(b);
    }
  })(chunk.body);

  const resolveBit = (name: string): string | null => {
    const d = builtins.get(name);
    if (!d) return null;
    const last = d.split('.').pop()!;
    return BIT_OPS.has(last) ? last : null;
  };
  const resolveStr = (name: string): string | null => {
    const d = builtins.get(name);
    if (!d) return null;
    if (d === 'string.char' || d === 'string.byte' || d === 'table.concat' || d === 'string.sub' || d === 'string.rep') return d;
    if (/^(string|math)\.[a-z]+$/.test(d) || d === 'tonumber') return d;
    return null;
  };

  return { builtins, resolveBit, resolveStr };
}

function childBlocks(s: A.Stat): A.Stat[][] {
  switch (s.type) {
    case 'DoStat': return [s.body];
    case 'WhileStat': return [s.body];
    case 'RepeatStat': return [s.body];
    case 'IfStat': return [...s.clauses.map(c => c.body), ...(s.elseBody ? [s.elseBody] : [])];
    case 'NumericForStat': return [s.body];
    case 'GenericForStat': return [s.body];
    case 'FunctionStat': return [s.func.body];
    case 'LocalFunctionStat': return [s.func.body];
    default: return [];
  }
}
