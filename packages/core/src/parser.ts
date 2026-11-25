// PRISM Luau parser — recursive descent + Pratt expressions.
// Tolerant: records errors but keeps going so obfuscated inputs still yield a usable AST.
import { lex, T, Token } from './lexer.js';
import type * as A from './ast.js';

export interface ParseError { message: string; start: number; line: number; }
export interface ParseResult { chunk: A.Chunk; errors: ParseError[]; }

// Binary operator precedence (left, right) — Lua 5.1/Luau semantics.
const BINPRI: Record<string, [number, number]> = {
  'or': [1, 1], 'and': [2, 2],
  '<': [3, 3], '>': [3, 3], '<=': [3, 3], '>=': [3, 3], '~=': [3, 3], '==': [3, 3],
  '|': [4, 4], '~': [5, 5], '&': [6, 6], '<<': [7, 7], '>>': [7, 7],
  '..': [9, 8], // right assoc
  '+': [10, 10], '-': [10, 10],
  '*': [11, 11], '/': [11, 11], '//': [11, 11], '%': [11, 11],
  '^': [14, 13], // right assoc
};
const UNARY_PRI = 12;
const UNARY = new Set(['not', '-', '#', '~']);

export function parse(src: string): ParseResult {
  const { tokens } = lex(src);
  const errors: ParseError[] = [];
  let p = 0;

  const peek = (o = 0) => tokens[Math.min(p + o, tokens.length - 1)];
  const next = () => tokens[p++];
  const atEof = () => peek().type === T.Eof;
  const loc = (t: Token): A.Pos => ({ start: t.start, end: t.end, line: t.line });

  function err(message: string) {
    const t = peek();
    errors.push({ message, start: t.start, line: t.line });
  }
  function isPunct(v: string, o = 0) { const t = peek(o); return t.type === T.Punct && t.value === v; }
  function isKw(v: string, o = 0) { const t = peek(o); return t.type === T.Keyword && t.value === v; }
  function expectPunct(v: string) { if (isPunct(v)) return next(); err(`expected '${v}'`); return peek(); }
  function expectName(): string {
    const t = peek();
    if (t.type === T.Name || (t.type === T.Keyword && t.value === 'continue')) { next(); return t.value; }
    err('expected name'); return '';
  }

  function parseChunk(): A.Chunk {
    const start = peek();
    const body = parseBlock();
    return { type: 'Chunk', body, loc: loc(start) };
  }

  const BLOCK_END = new Set(['end', 'else', 'elseif', 'until']);
  function blockEnds(): boolean {
    const t = peek();
    if (t.type === T.Eof) return true;
    if (t.type === T.Keyword && BLOCK_END.has(t.value)) return true;
    return false;
  }

  function parseBlock(): A.Stat[] {
    const out: A.Stat[] = [];
    while (!blockEnds()) {
      if (isKw('return')) { out.push(parseReturn()); break; }
      const before = p;
      const s = parseStatement();
      if (s) out.push(s);
      // Only force-advance when the parser is genuinely stuck (made no progress).
      // An empty `;` statement returns null but DID advance, so must not skip a token.
      if (p === before && !blockEnds()) next();
    }
    return out;
  }

  function parseStatement(): A.Stat | null {
    const t = peek();
    if (isPunct(';')) { next(); return null; }
    if (isPunct('::')) return parseLabel();
    if (t.type === T.Keyword) {
      switch (t.value) {
        case 'local': return parseLocal();
        case 'do': { next(); const body = parseBlock(); expectKw('end'); return { type: 'DoStat', body, loc: loc(t) }; }
        case 'while': return parseWhile();
        case 'repeat': return parseRepeat();
        case 'if': return parseIf();
        case 'for': return parseFor();
        case 'function': return parseFunctionStat();
        case 'break': next(); return { type: 'BreakStat', loc: loc(t) };
        case 'continue': next(); return { type: 'ContinueStat', loc: loc(t) };
        case 'goto': { next(); const label = expectName(); return { type: 'GotoStat', label, loc: loc(t) }; }
      }
    }
    return parseExprStatement();
  }

  function expectKw(v: string) { if (isKw(v)) { next(); return; } err(`expected '${v}'`); }

  function parseLabel(): A.LabelStat {
    const t = next(); // ::
    const name = expectName();
    expectPunct('::');
    return { type: 'LabelStat', name, loc: loc(t) };
  }

  function parseLocal(): A.Stat {
    const t = next(); // local
    if (isKw('function')) {
      next();
      const name = expectName();
      const func = parseFuncBody();
      return { type: 'LocalFunctionStat', name, func, loc: loc(t) };
    }
    const names: string[] = [];
    const attribs: (string | null)[] = [];
    do {
      names.push(expectName());
      if (isPunct('<')) { next(); attribs.push(expectName()); expectPunct('>'); }
      else attribs.push(null);
    } while (isPunct(',') && next());
    let init: A.Expr[] = [];
    if (isPunct('=')) { next(); init = parseExprList(); }
    return { type: 'LocalStat', names, attribs, init, loc: loc(t) };
  }

  function parseWhile(): A.Stat {
    const t = next();
    const cond = parseExpr();
    expectKw('do');
    const body = parseBlock();
    expectKw('end');
    return { type: 'WhileStat', cond, body, loc: loc(t) };
  }
  function parseRepeat(): A.Stat {
    const t = next();
    const body = parseBlock();
    expectKw('until');
    const cond = parseExpr();
    return { type: 'RepeatStat', body, cond, loc: loc(t) };
  }
  function parseIf(): A.Stat {
    const t = next();
    const clauses: A.IfClause[] = [];
    const cond = parseExpr(); expectKw('then');
    clauses.push({ cond, body: parseBlock() });
    while (isKw('elseif')) { next(); const c = parseExpr(); expectKw('then'); clauses.push({ cond: c, body: parseBlock() }); }
    let elseBody: A.Stat[] | undefined;
    if (isKw('else')) { next(); elseBody = parseBlock(); }
    expectKw('end');
    return { type: 'IfStat', clauses, elseBody, loc: loc(t) };
  }
  function parseFor(): A.Stat {
    const t = next();
    const first = expectName();
    if (isPunct('=')) {
      next();
      const from = parseExpr(); expectPunct(',');
      const to = parseExpr();
      let step: A.Expr | undefined;
      if (isPunct(',')) { next(); step = parseExpr(); }
      expectKw('do'); const body = parseBlock(); expectKw('end');
      return { type: 'NumericForStat', var: first, from, to, step, body, loc: loc(t) };
    }
    const names = [first];
    while (isPunct(',')) { next(); names.push(expectName()); }
    expectKw('in');
    const iters = parseExprList();
    expectKw('do'); const body = parseBlock(); expectKw('end');
    return { type: 'GenericForStat', names, iters, body, loc: loc(t) };
  }
  function parseFunctionStat(): A.Stat {
    const t = next();
    let target: A.Expr = { type: 'NameExpr', name: expectName(), loc: loc(peek()) };
    let isMethod = false;
    while (isPunct('.') || isPunct(':')) {
      const method = isPunct(':');
      next();
      const name = expectName();
      target = { type: 'MemberExpr', obj: target, name, loc: loc(t) };
      if (method) { isMethod = true; break; }
    }
    const func = parseFuncBody(isMethod);
    return { type: 'FunctionStat', target, isMethod, func, loc: loc(t) };
  }

  function parseReturn(): A.Stat {
    const t = next();
    let args: A.Expr[] = [];
    if (!blockEnds() && !isPunct(';')) args = parseExprList();
    if (isPunct(';')) next();
    return { type: 'ReturnStat', args, loc: loc(t) };
  }

  const COMPOUND = new Set(['+=', '-=', '*=', '/=', '%=', '^=', '//=', '..=']);
  function parseExprStatement(): A.Stat {
    const t = peek();
    const first = parseSuffixedExpr();
    // Multiple assignment: a, b, c = ...   (also single `a = ...`)
    if (isPunct('=') || isPunct(',')) {
      const targets = [first];
      while (isPunct(',')) { next(); targets.push(parseSuffixedExpr()); }
      expectPunct('=');
      const values = parseExprList();
      return { type: 'AssignStat', targets, values, loc: loc(t) };
    }
    // Compound assignment: a += x, s ..= y, ...
    if ([...COMPOUND].some(o => isPunct(o))) {
      const opTok = next();
      const values = parseExprList();
      return { type: 'AssignStat', targets: [first], values, op: opTok.value, loc: loc(t) };
    }
    if (first.type === 'CallExpr' || first.type === 'MethodCallExpr') {
      return { type: 'CallStat', expr: first, loc: loc(t) };
    }
    err('unexpected expression statement');
    return { type: 'CallStat', expr: first as any, loc: loc(t) };
  }

  // ---- expressions ----
  function parseExprList(): A.Expr[] {
    const out = [parseExpr()];
    while (isPunct(',')) { next(); out.push(parseExpr()); }
    return out;
  }

  function parseExpr(limit = 0): A.Expr {
    let left: A.Expr;
    const t = peek();
    if ((t.type === T.Keyword && t.value === 'not') || (t.type === T.Punct && UNARY.has(t.value))) {
      next();
      const expr = parseExpr(UNARY_PRI);
      left = { type: 'UnExpr', op: t.value, expr, loc: loc(t) };
    } else {
      left = parseSimpleExpr();
    }
    for (;;) {
      const op = peek();
      const key = op.type === T.Keyword ? op.value : op.type === T.Punct ? op.value : '';
      const pri = BINPRI[key];
      if (!pri || pri[0] <= limit) break;
      next();
      const right = parseExpr(pri[1]);
      left = { type: 'BinExpr', op: key, left, right, loc: loc(t) };
    }
    return left;
  }

  function parseSimpleExpr(): A.Expr {
    const t = peek();
    switch (t.type) {
      case T.Number: next(); return { type: 'NumberLit', value: t.num ?? 0, raw: t.value, loc: loc(t) };
      case T.String: next(); return { type: 'StringLit', value: t.cooked ?? '', raw: t.value, long: t.value.startsWith('['), loc: loc(t) };
      case T.InterpString: {
        next();
        const parts = (t.parts ?? []).map(part =>
          part.kind === 'str'
            ? { kind: 'str' as const, value: part.value }
            : { kind: 'expr' as const, expr: parse(part.value || 'nil').chunk.body[0] && exprOf(part.value) });
        return { type: 'InterpExpr', parts: parts as any, loc: loc(t) };
      }
      case T.Keyword:
        if (t.value === 'nil') { next(); return { type: 'NilLit', loc: loc(t) }; }
        if (t.value === 'true') { next(); return { type: 'TrueLit', loc: loc(t) }; }
        if (t.value === 'false') { next(); return { type: 'FalseLit', loc: loc(t) }; }
        if (t.value === 'if') { // Luau if-expression: IfExpr
          next();
          const clauses: any[] = [];
          { const c = parseExpr(); expectKw('then'); clauses.push({ cond: c, value: parseExpr() }); }
          while (isKw('elseif')) { next(); const c = parseExpr(); expectKw('then'); clauses.push({ cond: c, value: parseExpr() }); }
          expectKw('else');
          const elseValue = parseExpr();
          return { type: 'IfExpr', clauses, elseValue, loc: loc(t) };
        }
        if (t.value === 'function') { next(); return parseFuncBody(); }
        break;
      case T.Punct:
        if (t.value === '...') { next(); return { type: 'VarargLit', loc: loc(t) }; }
        if (t.value === '{') return parseTable();
        break;
    }
    return parseSuffixedExpr();
  }

  function exprOf(srcPart: string): A.Expr {
    // parse an embedded interpolation expression fragment
    const r = parse('return (' + srcPart + ')');
    const ret = r.chunk.body[0] as A.ReturnStat | undefined;
    return (ret && ret.args[0]) || { type: 'NilLit' };
  }

  function parsePrimaryExpr(): A.Expr {
    const t = peek();
    if (isPunct('(')) {
      next();
      const e = parseExpr();
      expectPunct(')');
      return { type: 'ParenExpr', expr: e, loc: loc(t) };
    }
    if (t.type === T.Name || (t.type === T.Keyword && t.value === 'continue')) {
      next();
      return { type: 'NameExpr', name: t.value, loc: loc(t) };
    }
    err('unexpected token in expression');
    next();
    return { type: 'NilLit', loc: loc(t) };
  }

  function parseSuffixedExpr(): A.Expr {
    let e = parsePrimaryExpr();
    for (;;) {
      const t = peek();
      if (isPunct('.')) { next(); const name = expectName(); e = { type: 'MemberExpr', obj: e, name, loc: loc(t) }; }
      else if (isPunct('[')) { next(); const index = parseExpr(); expectPunct(']'); e = { type: 'IndexExpr', obj: e, index, loc: loc(t) }; }
      else if (isPunct(':')) { next(); const method = expectName(); const args = parseCallArgs(); e = { type: 'MethodCallExpr', obj: e, method, args, loc: loc(t) }; }
      else if (isPunct('(') || isPunct('{') || t.type === T.String || t.type === T.InterpString) {
        const args = parseCallArgs();
        e = { type: 'CallExpr', callee: e, args, loc: loc(t) };
      } else break;
    }
    return e;
  }

  function parseCallArgs(): A.Expr[] {
    const t = peek();
    if (t.type === T.String) { next(); return [{ type: 'StringLit', value: t.cooked ?? '', raw: t.value, loc: loc(t) }]; }
    if (t.type === T.InterpString) { const e = parseSimpleExpr(); return [e]; }
    if (isPunct('{')) return [parseTable()];
    expectPunct('(');
    if (isPunct(')')) { next(); return []; }
    const args = parseExprList();
    expectPunct(')');
    return args;
  }

  function parseTable(): A.Expr {
    const t = expectPunct('{');
    const fields: A.TableField[] = [];
    while (!isPunct('}') && !atEof()) {
      if (isPunct('[')) {
        next(); const key = parseExpr(); expectPunct(']'); expectPunct('=');
        fields.push({ kind: 'keyed', key, value: parseExpr() });
      } else if ((peek().type === T.Name) && isPunct('=', 1)) {
        const name = expectName(); next(); // =
        fields.push({ kind: 'named', name, value: parseExpr() });
      } else {
        fields.push({ kind: 'item', value: parseExpr() });
      }
      if (isPunct(',') || isPunct(';')) next(); else break;
    }
    expectPunct('}');
    return { type: 'TableExpr', fields, loc: loc(t) };
  }

  function parseFuncBody(isMethod = false): A.FunctionExpr {
    const t = peek();
    expectPunct('(');
    const params: string[] = [];
    let vararg = false;
    if (isMethod) params.push('self');
    if (!isPunct(')')) {
      do {
        if (isPunct('...')) { next(); vararg = true; break; }
        params.push(expectName());
        // optional Luau type annotation: name: Type
        if (isPunct(':')) { next(); skipTypeAnnotation(); }
      } while (isPunct(',') && next());
    }
    expectPunct(')');
    if (isPunct(':')) { next(); skipTypeAnnotation(); } // return type
    const body = parseBlock();
    const e = peek();
    expectKw('end');
    return { type: 'FunctionExpr', params, vararg, body, loc: { start: t.start, end: e.end, line: t.line, endLine: e.line } };
  }

  // Minimal Luau type-annotation skipper (so handlers with types still parse).
  function skipTypeAnnotation() {
    let depth = 0;
    for (;;) {
      const t = peek();
      if (t.type === T.Eof) return;
      if (isPunct('(') || isPunct('{') || isPunct('<')) { depth++; next(); continue; }
      if (isPunct(')') || isPunct('}') || isPunct('>')) { if (depth === 0) return; depth--; next(); continue; }
      if (depth === 0 && (isPunct(',') || isPunct('=') || isPunct(')') || isKw('end') || isPunct(';'))) return;
      if (depth === 0 && (t.type === T.Name || t.type === T.Keyword) && (isPunct('=', 1) || isPunct(',', 1) || isPunct(')', 1))) {
        // likely start of next param
        if (!isPunct('.', 1) && !isPunct('<', 1)) return;
      }
      next();
    }
  }

  const chunk = parseChunk();
  return { chunk, errors };
}
