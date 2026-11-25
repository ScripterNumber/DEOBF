// PRISM printer — AST -> readable Luau source. Deterministic, stable indentation.
import type * as A from './ast.js';

const KW_TARGET = new Set([
  'and','break','do','else','elseif','end','false','for','function','goto','if','in',
  'local','nil','not','or','repeat','return','then','true','until','while',
]);

export interface PrintOptions { indent?: string; }

export function print(node: A.Chunk | A.Stat | A.Expr, opts: PrintOptions = {}): string {
  const IND = opts.indent ?? '  ';
  const out: string[] = [];
  const push = (s: string) => out.push(s);

  let curDepth = 0;
  function block(body: A.Stat[], depth: number) {
    const saved = curDepth;
    for (const s of body) { curDepth = depth; push(IND.repeat(depth)); stat(s, depth); push('\n'); }
    curDepth = saved;
  }

  function stat(s: A.Stat, d: number) {
    switch (s.type) {
      case 'LocalStat': {
        push('local ' + s.names.join(', '));
        if (s.init.length) { push(' = '); push(s.init.map(e => expr(e)).join(', ')); }
        push(';'); break;
      }
      case 'AssignStat': {
        push(s.targets.map(e => expr(e)).join(', '));
        push(' ' + (s.op ?? '=') + ' ');
        push(s.values.map(e => expr(e)).join(', ')); push(';'); break;
      }
      case 'CallStat': push(expr(s.expr) + ';'); break;
      case 'DoStat': push('do\n'); block(s.body, d + 1); push(IND.repeat(d) + 'end'); break;
      case 'WhileStat': push('while ' + expr(s.cond) + ' do\n'); block(s.body, d + 1); push(IND.repeat(d) + 'end'); break;
      case 'RepeatStat': push('repeat\n'); block(s.body, d + 1); push(IND.repeat(d) + 'until ' + expr(s.cond)); break;
      case 'IfStat': {
        s.clauses.forEach((c, i) => {
          push((i === 0 ? 'if ' : IND.repeat(d) + 'elseif ') + expr(c.cond) + ' then\n');
          block(c.body, d + 1);
        });
        // collapse `else if ... end end` into an elseif chain (identical semantics)
        let eb = s.elseBody;
        while (eb && eb.length === 1 && eb[0].type === 'IfStat') {
          const inner = eb[0] as A.IfStat;
          for (const c of inner.clauses) { push(IND.repeat(d) + 'elseif ' + expr(c.cond) + ' then\n'); block(c.body, d + 1); }
          eb = inner.elseBody;
        }
        if (eb && eb.length) { push(IND.repeat(d) + 'else\n'); block(eb, d + 1); }
        push(IND.repeat(d) + 'end'); break;
      }
      case 'NumericForStat': {
        push('for ' + s.var + ' = ' + expr(s.from) + ', ' + expr(s.to) + (s.step ? ', ' + expr(s.step) : '') + ' do\n');
        block(s.body, d + 1); push(IND.repeat(d) + 'end'); break;
      }
      case 'GenericForStat': {
        push('for ' + s.names.join(', ') + ' in ' + s.iters.map(e => expr(e)).join(', ') + ' do\n');
        block(s.body, d + 1); push(IND.repeat(d) + 'end'); break;
      }
      case 'FunctionStat': {
        push('function ' + expr(s.target) + funcTail(s.func, d, s.isMethod)); break;
      }
      case 'LocalFunctionStat': push('local function ' + s.name + funcTail(s.func, d)); break;
      case 'ReturnStat': push('return' + (s.args.length ? ' ' + s.args.map(e => expr(e)).join(', ') : '') + ';'); break;
      case 'BreakStat': push('break;'); break;
      case 'ContinueStat': push('continue;'); break;
      case 'GotoStat': push('goto ' + s.label + ';'); break;
      case 'LabelStat': push('::' + s.name + '::'); break;
      default: push('--[[?]]');
    }
  }

  function funcTail(f: A.FunctionExpr, d: number, isMethod = false): string {
    const params = isMethod ? f.params.slice(1) : f.params;
    const p = params.concat(f.vararg ? ['...'] : []).join(', ');
    const inner: string[] = [];
    const saved = out.splice(0, out.length); // capture nested
    block(f.body, d + 1);
    const body = out.join(''); out.length = 0; out.push(...saved);
    return '(' + p + ')\n' + body + IND.repeat(d) + 'end';
  }

  function expr(e: A.Expr): string {
    switch (e.type) {
      case 'NilLit': return 'nil';
      case 'TrueLit': return 'true';
      case 'FalseLit': return 'false';
      case 'VarargLit': return '...';
      case 'NumberLit': return numStr(e.value, e.raw);
      case 'StringLit': return strLit(e.value);
      case 'NameExpr': return e.name;
      case 'MemberExpr': return callee(e.obj) + '.' + e.name;
      case 'IndexExpr': return callee(e.obj) + '[' + expr(e.index) + ']';
      case 'CallExpr': return callee(e.callee) + '(' + e.args.map(a => expr(a)).join(', ') + ')';
      case 'MethodCallExpr': return callee(e.obj) + ':' + e.method + '(' + e.args.map(a => expr(a)).join(', ') + ')';
      case 'ParenExpr': return '(' + expr(e.expr) + ')';
      case 'UnExpr': {
        const inner = operand(e.expr, UNARY_PREC, 'right');
        const opS = e.op === 'not' ? 'not ' : e.op;
        return opS + (opS === '-' && inner.startsWith('-') ? ' ' : '') + inner;
      }
      case 'BinExpr': {
        const p = BIN_PREC[e.op] ?? 0;
        return operand(e.left, p, 'left', e.op) + ' ' + e.op + ' ' + operand(e.right, p, 'right', e.op);
      }
      case 'FunctionExpr': { return 'function' + funcTailExpr(e); }
      case 'TableExpr': return table(e);
      case 'InterpExpr': return '`' + e.parts.map(p => p.kind === 'str' ? p.value : '{' + expr(p.expr) + '}').join('') + '`';
      case 'IfExpr': {
        const g = (x: A.Expr) => x.type === 'IfExpr' ? '(' + expr(x) + ')' : expr(x);
        return 'if ' + g(e.clauses[0].cond) + ' then ' + g(e.clauses[0].value) + e.clauses.slice(1).map(c => ' elseif ' + g(c.cond) + ' then ' + g(c.value)).join('') + ' else ' + expr(e.elseValue);
      }
      default: return '--[[?expr]]';
    }
  }

  function funcTailExpr(f: A.FunctionExpr): string {
    const p = f.params.concat(f.vararg ? ['...'] : []).join(', ');
    const d = curDepth;
    const saved = out.splice(0, out.length);
    block(f.body, d + 1);
    const body = out.join(''); out.length = 0; out.push(...saved);
    curDepth = d;
    return '(' + p + ')\n' + body + IND.repeat(d) + 'end';
  }

  function callee(e: A.Expr): string {
    // wrap calls on non-trivial callees
    if (e.type === 'NameExpr' || e.type === 'MemberExpr' || e.type === 'IndexExpr' || e.type === 'CallExpr' || e.type === 'MethodCallExpr' || e.type === 'ParenExpr') return expr(e);
    return '(' + expr(e) + ')';
  }

  // precedence-aware operand printing: parenthesize only when required
  function operand(e: A.Expr, parentPrec: number, side: 'left' | 'right', parentOp?: string): string {
    const p = precOf(e);
    const rightAssoc = parentOp === '..' || parentOp === '^';
    let wrap = p < parentPrec;
    if (p === parentPrec && e.type === 'BinExpr') wrap = rightAssoc ? side === 'left' : side === 'right';
    // comparison operators are non-associative in practice: keep explicit grouping
    if (p === parentPrec && p === 3) wrap = true;
    return wrap ? '(' + expr(e) + ')' : expr(e);
  }
  function precOf(e: A.Expr): number {
    if (e.type === 'IfExpr') return 0;
    if (e.type === 'BinExpr') return BIN_PREC[e.op] ?? 0;
    if (e.type === 'UnExpr') return UNARY_PREC;
    if (e.type === 'NumberLit' && (e.value < 0 || Object.is(e.value, -0))) return UNARY_PREC;
    return 100;
  }

  function table(t: A.TableExpr): string {
    if (!t.fields.length) return '{}';
    const parts = t.fields.map(f => {
      if (f.kind === 'item') return expr(f.value);
      if (f.kind === 'named') return f.name + ' = ' + expr(f.value);
      return '[' + expr(f.key!) + '] = ' + expr(f.value);
    });
    return '{ ' + parts.join(', ') + ' }';
  }

  if ((node as A.Chunk).type === 'Chunk') { block((node as A.Chunk).body, 0); return out.join(''); }
  if ('type' in node && isStat(node as A.Stat)) { stat(node as A.Stat, 0); return out.join(''); }
  return exprOnly(node as A.Expr);

  function exprOnly(e: A.Expr) { return expr(e); }
}

const UNARY_PREC = 11;
const BIN_PREC: Record<string, number> = {
  'or': 1, 'and': 2,
  '<': 3, '>': 3, '<=': 3, '>=': 3, '~=': 3, '==': 3,
  '|': 4, '~': 5, '&': 6, '<<': 7, '>>': 7,
  '..': 8, '+': 9, '-': 9, '*': 10, '/': 10, '//': 10, '%': 10, '^': 12,
};

function isStat(n: any): boolean { return typeof n.type === 'string' && n.type.endsWith('Stat'); }

export function numStr(v: number, raw?: string): string {
  if (Number.isInteger(v) && Math.abs(v) < 1e15) return String(v);
  if (!Number.isFinite(v)) return v > 0 ? '(1/0)' : (v < 0 ? '(-1/0)' : '(0/0)');
  return String(v);
}

export function strLit(s: string): string {
  // Byte-exact string printer. Code units 0-255 are bytes; valid UTF-8 byte runs
  // are re-emitted as the decoded char (so UTF-8 encoding of the output yields
  // the same bytes); everything else non-printable becomes a 3-digit \ddd escape
  // (3 digits so a following digit can never be swallowed).
  const dq = s.includes('"'), sq = s.includes("'");
  const q = dq && !sq ? "'" : '"';
  let out = q;
  const n = s.length;
  for (let i = 0; i < n; i++) {
    const c = s.charCodeAt(i);
    const ch = s[i];
    if (c > 255) { out += ch; continue; }
    if (c >= 128) {
      const len = c >= 0xf0 && c < 0xf5 ? 4 : c >= 0xe0 ? 3 : c >= 0xc2 && c < 0xe0 ? 2 : 0;
      let ok = len > 0 && i + len <= n;
      for (let k = 1; ok && k < len; k++) { const cc = s.charCodeAt(i + k); if (cc < 0x80 || cc > 0xbf) ok = false; }
      if (ok) {
        let cp = len === 2 ? c & 0x1f : len === 3 ? c & 0x0f : c & 0x07;
        for (let k = 1; k < len; k++) cp = (cp << 6) | (s.charCodeAt(i + k) & 0x3f);
        const minCp = len === 2 ? 0x80 : len === 3 ? 0x800 : 0x10000;
        if (cp >= minCp && cp <= 0x10ffff && !(cp >= 0xd800 && cp <= 0xdfff)) { out += String.fromCodePoint(cp); i += len - 1; continue; }
      }
      out += '\\' + String(c).padStart(3, '0');
      continue;
    }
    if (ch === q) out += '\\' + q;
    else if (ch === '\\') out += '\\\\';
    else if (ch === '\n') out += '\\n';
    else if (ch === '\t') out += '\\t';
    else if (ch === '\r') out += '\\r';
    else if (c < 32 || c === 127) out += '\\' + String(c).padStart(3, '0');
    else out += ch;
  }
  return out + q;
}
