// PRISM string-recovery pass.
// Folds string.char(a,b,...) and alias(...) chains, and {string.byte-style} decoders,
// plus collects a string table for reporting. Escapes are already decoded by the lexer.
import type * as A from '../ast.js';

export interface StringStats { charCalls: number; concatChains: number; }

export interface StringOptions {
  // resolve a name to 'string.char' / 'string.byte' / 'table.concat' if it's an alias
  resolveStrAlias?: (name: string) => string | null;
}

function mkStr(value: string, loc?: A.Pos): A.StringLit { return { type: 'StringLit', value, raw: JSON.stringify(value), loc }; }

export function recoverStrings(node: any, opts: StringOptions = {}): StringStats {
  const stats: StringStats = { charCalls: 0, concatChains: 0 };
  const resolve = opts.resolveStrAlias ?? (() => null);

  function nameOf(e: A.Expr): string | null {
    if (e.type === 'MemberExpr' && e.obj.type === 'NameExpr') return e.obj.name + '.' + e.name;
    if (e.type === 'NameExpr') return resolve(e.name);
    return null;
  }

  function ev(e: A.Expr): A.Expr {
    switch (e.type) {
      case 'CallExpr': {
        e.callee = ev(e.callee);
        e.args = e.args.map(ev);
        const fn = nameOf(e.callee);
        if (fn === 'string.char') {
          const codes: number[] = [];
          let allNum = e.args.length > 0;
          for (const a of e.args) { if (a.type === 'NumberLit') codes.push(a.value & 0xff); else { allNum = false; break; } }
          if (allNum) { stats.charCalls++; return mkStr(codes.map(c => String.fromCharCode(c)).join(''), e.loc); }
        }
        return e;
      }
      case 'MethodCallExpr': { e.obj = ev(e.obj); e.args = e.args.map(ev); return e; }
      case 'BinExpr': {
        e.left = ev(e.left); e.right = ev(e.right);
        if (e.op === '..' && e.left.type === 'StringLit' && e.right.type === 'StringLit') {
          stats.concatChains++;
          return mkStr(e.left.value + e.right.value, e.loc);
        }
        return e;
      }
      case 'UnExpr': e.expr = ev(e.expr); return e;
      case 'ParenExpr': e.expr = ev(e.expr); return e;
      case 'IndexExpr': e.obj = ev(e.obj); e.index = ev(e.index); return e;
      case 'MemberExpr': e.obj = ev(e.obj); return e;
      case 'TableExpr': for (const f of e.fields) { if (f.key) f.key = ev(f.key); f.value = ev(f.value); } return e;
      case 'FunctionExpr': walkStats(e.body); return e;
      case 'InterpExpr': for (const p of e.parts) if (p.kind === 'expr') p.expr = ev(p.expr); return e;
      case 'IfExpr': for (const c of e.clauses) { c.cond = ev(c.cond); c.value = ev(c.value); } e.elseValue = ev(e.elseValue); return e;
      default: return e;
    }
  }

  function walkStats(body: A.Stat[]) { for (const s of body) walkStat(s); }
  function walkStat(s: A.Stat) {
    switch (s.type) {
      case 'LocalStat': s.init = s.init.map(ev); break;
      case 'AssignStat': s.targets = s.targets.map(ev); s.values = s.values.map(ev); break;
      case 'CallStat': s.expr = ev(s.expr) as any; break;
      case 'DoStat': walkStats(s.body); break;
      case 'WhileStat': s.cond = ev(s.cond); walkStats(s.body); break;
      case 'RepeatStat': walkStats(s.body); s.cond = ev(s.cond); break;
      case 'IfStat': for (const c of s.clauses) { c.cond = ev(c.cond); walkStats(c.body); } if (s.elseBody) walkStats(s.elseBody); break;
      case 'NumericForStat': s.from = ev(s.from); s.to = ev(s.to); if (s.step) s.step = ev(s.step); walkStats(s.body); break;
      case 'GenericForStat': s.iters = s.iters.map(ev); walkStats(s.body); break;
      case 'FunctionStat': walkStats(s.func.body); break;
      case 'LocalFunctionStat': walkStats(s.func.body); break;
      case 'ReturnStat': s.args = s.args.map(ev); break;
    }
  }

  if (node.type === 'Chunk') walkStats(node.body);
  else if (node.type && node.type.endsWith('Stat')) walkStat(node);
  else ev(node);
  return stats;
}

// Collect all string literals in the AST (for the string-table tool).
export function collectStrings(node: any): Array<{ value: string; line?: number }> {
  const out: Array<{ value: string; line?: number }> = [];
  const seen = new Set<string>();
  (function rec(n: any) {
    if (!n || typeof n !== 'object') return;
    if (n.type === 'StringLit' && typeof n.value === 'string') {
      if (n.value.length >= 1) out.push({ value: n.value, line: n.loc?.line });
    }
    for (const k of Object.keys(n)) {
      if (k === 'loc' || k === 'type') continue;
      const v = n[k];
      if (Array.isArray(v)) v.forEach(rec); else if (v && typeof v === 'object') rec(v);
    }
  })(node);
  return out;
}
