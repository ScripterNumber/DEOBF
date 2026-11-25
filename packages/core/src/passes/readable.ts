// Readability pass for lifted / deobfuscated code. Every rewrite here is semantics-preserving:
//  A. field sugar      t["name"] -> t.name ; { ["k"] = v } -> { k = v }
//  M. method sugar    X.m(X, ...) -> X:m(...)   (X is a plain name, so it is evaluated once either way)
//  G. truthiness       not not x -> x   only where the value is used as a condition
//  I. if-inversion     if c then else B end -> if not c then B end
import type * as A from '../ast.js';

const KW = new Set(['and', 'break', 'do', 'else', 'elseif', 'end', 'false', 'for', 'function', 'goto', 'if', 'in', 'local', 'nil', 'not', 'or', 'repeat', 'return', 'then', 'true', 'until', 'while', 'continue']);
export const isIdent = (s: string) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(s) && !KW.has(s);

export interface ReadableStats { fieldSugar: number; methodSugar: number; notNot: number; ifInvert: number; }

export function makeReadable(chunk: A.Chunk): ReadableStats {
  const st: ReadableStats = { fieldSugar: 0, methodSugar: 0, notNot: 0, ifInvert: 0 };

  // strip `not not` from an expression used only for its truthiness
  const cond = (e: A.Expr): A.Expr => {
    let x: any = e;
    while (x.type === 'UnExpr' && x.op === 'not' && x.expr.type === 'UnExpr' && x.expr.op === 'not') { x = x.expr.expr; st.notNot++; }
    if (x.type === 'ParenExpr') { const inner = cond(x.expr); if (inner !== x.expr) x = { ...x, expr: inner }; }
    else if (x.type === 'BinExpr' && (x.op === 'and' || x.op === 'or')) {
      // the left operand of and/or is only tested when the whole is only tested? No: `a or b` may return a.
      // As a condition the whole result is only tested, so both operands are only tested.
      x.left = cond(x.left); x.right = cond(x.right);
    } else if (x.type === 'UnExpr' && x.op === 'not') x.expr = cond(x.expr);
    return x;
  };

  const rw = (n: any): any => {
    if (!n || typeof n !== 'object') return n;
    if (Array.isArray(n)) { for (let i = 0; i < n.length; i++) n[i] = rw(n[i]); return n; }
    for (const k of Object.keys(n)) { if (k === 'loc' || k === 'type') continue; const v = n[k]; if (v && typeof v === 'object') n[k] = rw(v); }
    switch (n.type) {
      case 'IndexExpr':
        if (n.index.type === 'StringLit' && isIdent(n.index.value)) { st.fieldSugar++; return { type: 'MemberExpr', obj: n.obj, name: n.index.value, loc: n.loc }; }
        break;
      case 'TableExpr':
        for (const f of n.fields as A.TableField[]) if (f.kind === 'keyed' && f.key?.type === 'StringLit' && isIdent((f.key as A.StringLit).value)) { f.kind = 'named'; f.name = (f.key as A.StringLit).value; delete f.key; st.fieldSugar++; }
        break;
      case 'CallExpr': {
        const c = n.callee;
        if (c.type === 'MemberExpr' && c.obj.type === 'NameExpr' && n.args.length > 0 && n.args[0].type === 'NameExpr' && n.args[0].name === c.obj.name) {
          st.methodSugar++; return { type: 'MethodCallExpr', obj: c.obj, method: c.name, args: n.args.slice(1), loc: n.loc };
        }
        break;
      }
      case 'IfStat':
        for (const cl of n.clauses) cl.cond = cond(cl.cond);
        if (n.clauses.length === 1 && n.clauses[0].body.length === 0 && n.elseBody && n.elseBody.length) {
          const c0 = n.clauses[0].cond;
          n.clauses[0].cond = c0.type === 'UnExpr' && c0.op === 'not' ? c0.expr : { type: 'UnExpr', op: 'not', expr: c0.type === 'BinExpr' ? { type: 'ParenExpr', expr: c0 } : c0 };
          n.clauses[0].body = n.elseBody; n.elseBody = undefined; st.ifInvert++;
        }
        break;
      case 'WhileStat': case 'RepeatStat': n.cond = cond(n.cond); break;
    }
    return n;
  };
  rw(chunk);
  return st;
}
