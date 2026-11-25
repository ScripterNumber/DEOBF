// PRISM constant + MBA folding pass.
// Evaluates literal arithmetic, comparisons, string concat, and bit32/bitops
// (including Luau's native operators and the common MBA identities obfuscators emit).
import type * as A from '../ast.js';

export interface FoldStats { folded: number; mbaFolded: number; }

const U32 = 0x100000000;
const toU32 = (n: number) => ((n % U32) + U32) % U32 >>> 0;
const toI32 = (n: number) => (toU32(n) | 0);

// Map of known bit32.* builtins -> operation (populated from alias analysis later; here the literal names).
function bitFn(name: string): ((a: number, b: number) => number) | null {
  switch (name) {
    case 'bxor': return (a, b) => toU32(toU32(a) ^ toU32(b));
    case 'band': return (a, b) => toU32(toU32(a) & toU32(b));
    case 'bor': return (a, b) => toU32(toU32(a) | toU32(b));
    default: return null;
  }
}

/** Exact Lua 5.2 / Luau `bit32` semantics over integer literals (results are unsigned 32-bit).
 *  Returns null when the call cannot be folded safely (non-integer args, bad arity, unknown fn). */
export function evalBit32(name: string, args: number[]): number | boolean | null {
  if (!args.every(a => Number.isFinite(a) && Number.isInteger(a))) return null;
  const u = args.map(toU32);
  const shl = (x: number, d: number): number => d <= -32 || d >= 32 ? 0 : d >= 0 ? toU32(x * Math.pow(2, d)) : Math.floor(x / Math.pow(2, -d));
  switch (name) {
    case 'band': return u.reduce((x, y) => toU32(x & y), 0xFFFFFFFF);
    case 'bor': return u.reduce((x, y) => toU32(x | y), 0);
    case 'bxor': return u.reduce((x, y) => toU32(x ^ y), 0);
    case 'btest': return u.reduce((x, y) => toU32(x & y), 0xFFFFFFFF) !== 0;
    case 'bnot': return u.length >= 1 ? toU32(~u[0]) : null;
    case 'lshift': return u.length >= 2 ? shl(u[0], args[1]) : null;
    case 'rshift': return u.length >= 2 ? shl(u[0], -args[1]) : null;
    case 'arshift': {
      if (u.length < 2) return null;
      const d = args[1];
      if (d < 0) return shl(u[0], -d);
      const neg = u[0] >= 0x80000000;
      if (d >= 32) return neg ? 0xFFFFFFFF : 0;
      const r = Math.floor(u[0] / Math.pow(2, d));
      return neg ? toU32(r + (0xFFFFFFFF - (Math.pow(2, 32 - d) - 1))) : r;
    }
    case 'lrotate': case 'rrotate': {
      if (u.length < 2) return null;
      let d = ((name === 'lrotate' ? args[1] : -args[1]) % 32 + 32) % 32;
      if (d === 0) return u[0];
      return toU32(toU32(u[0] * Math.pow(2, d)) + Math.floor(u[0] / Math.pow(2, 32 - d)));
    }
    case 'countlz': { if (u.length < 1) return null; return u[0] === 0 ? 32 : Math.clz32(u[0]); }
    case 'countrz': { if (u.length < 1) return null; let x = u[0]; if (x === 0) return 32; let n = 0; while ((x & 1) === 0) { x >>>= 1; n++; } return n; }
    case 'extract': {
      if (u.length < 2) return null;
      const f = args[1], w = args.length >= 3 ? args[2] : 1;
      if (f < 0 || w <= 0 || f + w > 32) return null;
      return Math.floor(u[0] / Math.pow(2, f)) % Math.pow(2, w);
    }
    case 'replace': {
      if (u.length < 3) return null;
      const f = args[2], w = args.length >= 4 ? args[3] : 1;
      if (f < 0 || w <= 0 || f + w > 32) return null;
      const mask = (Math.pow(2, w) - 1) * Math.pow(2, f);
      const v = (u[1] % Math.pow(2, w)) * Math.pow(2, f);
      return toU32((u[0] - (toU32(u[0] & mask) >>> 0)) + v);
    }
    case 'byteswap': { if (u.length < 1) return null; const x = u[0]; return toU32(((x & 0xFF) << 24) | ((x >>> 8 & 0xFF) << 16) | ((x >>> 16 & 0xFF) << 8) | (x >>> 24)); }
    default: return null;
  }
}

function lit(n: A.Expr | undefined): number | string | boolean | null | undefined {
  if (!n) return undefined;
  if (n.type === 'NumberLit') return n.value;
  if (n.type === 'StringLit') return n.value;
  if (n.type === 'TrueLit') return true;
  if (n.type === 'FalseLit') return false;
  if (n.type === 'NilLit') return null;
  return undefined;
}
const isNum = (v: any): v is number => typeof v === 'number';

function mkNum(value: number, loc?: A.Pos): A.NumberLit { return { type: 'NumberLit', value, raw: String(value), loc }; }
function mkStr(value: string, loc?: A.Pos): A.StringLit { return { type: 'StringLit', value, raw: JSON.stringify(value), loc }; }
function mkBool(v: boolean, loc?: A.Pos): A.Expr { return v ? { type: 'TrueLit', loc } : { type: 'FalseLit', loc }; }

// Recognize bit32.op(a,b) or alias via a resolver (name -> canonical bit op).
function asBitCall(e: A.Expr, resolve: (name: string) => string | null): { op: string; a: A.Expr; b: A.Expr } | null {
  if (e.type !== 'CallExpr') return null;
  let name: string | null = null;
  if (e.callee.type === 'MemberExpr' && e.callee.obj.type === 'NameExpr' && e.callee.obj.name === 'bit32') name = e.callee.name;
  else if (e.callee.type === 'NameExpr') name = resolve(e.callee.name);
  if (!name) return null;
  if (!['bxor', 'band', 'bor'].includes(name)) return null;
  if (e.args.length !== 2) return null;
  return { op: name, a: e.args[0], b: e.args[1] };
}

/** first result of a pure library call over literal arguments (undefined = not foldable) */
export function evalPureCall(name: string, args: Array<number | string | boolean | null>): number | string | boolean | undefined {
  const num = (v: any) => typeof v === 'number' ? v : undefined;
  const str = (v: any) => typeof v === 'string' ? v : typeof v === 'number' ? String(v) : undefined;
  switch (name) {
    case 'string.len': { const x = str(args[0]); return x === undefined ? undefined : x.length; }
    case 'string.upper': { const x = str(args[0]); return x?.toUpperCase(); }
    case 'string.lower': { const x = str(args[0]); return x?.toLowerCase(); }
    case 'string.reverse': { const x = str(args[0]); return x === undefined ? undefined : [...x].reverse().join(''); }
    case 'string.rep': { const x = str(args[0]), k = num(args[1]); if (x === undefined || k === undefined || args.length > 2) return undefined; if (x.length * Math.max(0, k) > 4096) return undefined; return k > 0 ? x.repeat(Math.floor(k)) : ''; }
    case 'string.sub': {
      const x = str(args[0]); let i = args.length > 1 ? num(args[1]) : 1; let j = args.length > 2 ? num(args[2]) : -1;
      if (x === undefined || i === undefined || j === undefined || !Number.isInteger(i) || !Number.isInteger(j)) return undefined;
      const L = x.length; if (i < 0) i = Math.max(L + i + 1, 1); else if (i === 0) i = 1; if (j < 0) j = L + j + 1; else if (j > L) j = L;
      return i > j ? '' : x.slice(i - 1, j);
    }
    case 'string.byte': {
      const x = str(args[0]); let i = args.length > 1 ? num(args[1]) : 1; let j = args.length > 2 ? num(args[2]) : i;
      if (x === undefined || i === undefined || j === undefined || !Number.isInteger(i) || !Number.isInteger(j)) return undefined;
      const L = x.length; if (i < 0) i = L + i + 1; if (j < 0) j = L + j + 1;
      if (i !== j || i < 1 || i > L) return undefined;          // exactly one result only
      return x.charCodeAt(i - 1) & 0xFF;
    }
    case 'string.unpack': {
      const f = str(args[0]), data = str(args[1]); const pos = args.length > 2 ? num(args[2]) : 1;
      if (f === undefined || data === undefined || pos === undefined || !Number.isInteger(pos) || pos < 1) return undefined;
      const m = /^([<>=!]?)([bBhHlLjJiIfdn])(\d*)$/.exec(f.trim()); if (!m) return undefined;
      const little = m[1] !== '>';
      const ch = m[2]; const sizes: Record<string, number> = { b: 1, B: 1, h: 2, H: 2, l: 8, L: 8, j: 8, J: 8, i: 4, I: 4, f: 4, d: 8, n: 8 };
      const size = m[3] ? Number(m[3]) : sizes[ch];
      if (!(size >= 1 && size <= 8) || ((ch === 'f' || ch === 'd' || ch === 'n') && m[3])) return undefined;
      if (pos - 1 + size > data.length) return undefined;
      const bytes: number[] = []; for (let q = 0; q < size; q++) bytes.push(data.charCodeAt(pos - 1 + q) & 0xFF);
      if (ch === 'f' || ch === 'd' || ch === 'n') { const dv = new DataView(new Uint8Array(bytes).buffer); return size === 4 ? dv.getFloat32(0, little) : dv.getFloat64(0, little); }
      const ordered = little ? bytes.slice().reverse() : bytes;    // most significant first
      let big = 0n; for (const b of ordered) big = (big << 8n) | BigInt(b);
      const signed = ch === 'b' || ch === 'h' || ch === 'l' || ch === 'j' || ch === 'i';
      if (signed && (ordered[0] & 0x80)) big -= 1n << BigInt(size * 8);
      const v = Number(big); return Number.isSafeInteger(v) ? v : undefined;
    }
    case 'math.floor': { const x = num(args[0]); return x === undefined ? undefined : Math.floor(x); }
    case 'math.ceil': { const x = num(args[0]); return x === undefined ? undefined : Math.ceil(x); }
    case 'math.abs': { const x = num(args[0]); return x === undefined ? undefined : Math.abs(x); }
    case 'math.max': { if (!args.length || !args.every(a => typeof a === 'number')) return undefined; return Math.max(...(args as number[])); }
    case 'math.min': { if (!args.length || !args.every(a => typeof a === 'number')) return undefined; return Math.min(...(args as number[])); }
    case 'math.fmod': { const a = num(args[0]), b = num(args[1]); if (a === undefined || b === undefined || b === 0) return undefined; return a % b; }
    case 'tonumber': {
      if (args.length !== 1) return undefined;
      const a = args[0]; if (typeof a === 'number') return a;
      if (typeof a !== 'string') return undefined;
      const t = a.trim(); if (/^-?0[xX][0-9a-fA-F]+$/.test(t)) return parseInt(t, 16);
      if (/^-?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/.test(t)) return Number(t);
      return undefined;
    }
    default: return undefined;
  }
}
const PURE_LIBS = new Set(['string', 'math']);

export interface FoldOptions {
  // resolver maps a local alias name to a canonical bit op ('bxor'|'band'|'bor') if known
  resolveBitAlias?: (name: string) => string | null;
  // resolver maps a local alias name to 'string.sub' / 'math.floor' … if known
  resolveStrAlias?: (name: string) => string | null;
  maxStringConcat?: number;
  /** read-only table hooks: `T[k]` / `T.k` -> value, `#T` -> length (null = unknown) */
  constIndex?: (obj: A.Expr, key: A.Expr) => A.Expr | null;
  constLen?: (obj: A.Expr) => A.Expr | null;
}

export function fold(node: any, opts: FoldOptions = {}): FoldStats {
  const stats: FoldStats = { folded: 0, mbaFolded: 0 };
  const resolve = opts.resolveBitAlias ?? (() => null);

  const strRes = opts.resolveStrAlias ?? (() => null);
  /** library call name: string.sub / math.floor / tonumber / local alias of those */
  function pureName(e: A.CallExpr): string | null {
    const c = e.callee;
    if (c.type === 'MemberExpr' && c.obj.type === 'NameExpr' && PURE_LIBS.has(c.obj.name)) return c.obj.name + '.' + c.name;
    if (c.type === 'NameExpr') { if (c.name === 'tonumber') return 'tonumber'; return strRes(c.name); }
    return null;
  }
  /** fold a pure call that sits in a single-value context */
  function single(e: A.Expr): A.Expr {
    if (e.type !== 'CallExpr') return e;
    const nm = pureName(e); if (!nm) return e;
    const vals = e.args.map(lit);
    if (vals.some(v => v === undefined)) return e;
    const r = evalPureCall(nm, vals as any);
    if (r === undefined) return e;
    stats.folded++;
    return typeof r === 'number' ? mkNum(r, e.loc) : typeof r === 'string' ? mkStr(r, e.loc) : mkBool(r, e.loc);
  }
  function evalExpr(e: A.Expr): A.Expr {
    switch (e.type) {
      case 'ParenExpr': {
        e.expr = single(evalExpr(e.expr));
        // collapse parens around a literal
        if (isLiteral(e.expr)) { stats.folded++; return e.expr; }
        return e;
      }
      case 'UnExpr': {
        e.expr = single(evalExpr(e.expr));
        const v = lit(e.expr);
        if (e.op === '-' && isNum(v)) { stats.folded++; return mkNum(-v, e.loc); }
        if (e.op === 'not' && v !== undefined) { stats.folded++; return mkBool(!(v !== false && v !== null), e.loc); }
        if (e.op === '#' && typeof v === 'string') { stats.folded++; return mkNum(v.length, e.loc); }
        if (e.op === '#' && opts.constLen) { const r = opts.constLen(e.expr); if (r) { stats.folded++; return r; } }
        if (e.op === '~' && isNum(v)) { stats.folded++; return mkNum(toI32(~toU32(v)), e.loc); }
        return e;
      }
      case 'BinExpr': {
        e.left = single(evalExpr(e.left));
        e.right = single(evalExpr(e.right));
        const folded = foldBin(e);
        if (folded) { stats.folded++; return folded; }
        const mba = foldMBA(e);
        if (mba) { stats.mbaFolded++; stats.folded++; return mba; }
        return e;
      }
      case 'CallExpr': {
        e.callee = evalExpr(e.callee);
        e.args = e.args.map(evalExpr);
        // every argument but the last is truncated to one value
        for (let q = 0; q < e.args.length - 1; q++) e.args[q] = single(e.args[q]);
        // fixed-arity bit32 functions ignore surplus values of a trailing multi-value call
        if (e.args.length && e.callee.type === 'MemberExpr' && e.callee.obj.type === 'NameExpr' && e.callee.obj.name === 'bit32') {
          const arity: Record<string, number> = { bnot: 1, countlz: 1, countrz: 1, byteswap: 1, lshift: 2, rshift: 2, arshift: 2, lrotate: 2, rrotate: 2, extract: 3, replace: 4 };
          const ar = arity[e.callee.name];
          if (ar !== undefined && e.args.length >= 1 && e.args.length <= ar) e.args[e.args.length - 1] = single(e.args[e.args.length - 1]);
        }
        // fold bit32.op(lit, ...) — every bit32 function, exact unsigned-32 semantics
        {
          let name: string | null = null;
          if (e.callee.type === 'MemberExpr' && e.callee.obj.type === 'NameExpr' && e.callee.obj.name === 'bit32') name = e.callee.name;
          else if (e.callee.type === 'NameExpr') name = resolve(e.callee.name);
          if (name) {
            const vals = e.args.map(lit);
            if (vals.every(isNum)) {
              const r = evalBit32(name, vals as number[]);
              if (r !== null) { stats.folded++; return typeof r === 'boolean' ? mkBool(r, e.loc) : mkNum(r, e.loc); }
            }
          }
        }
        return e;
      }
      case 'MethodCallExpr': { e.obj = evalExpr(e.obj); e.args = e.args.map(evalExpr); return e; }
      case 'IndexExpr': {
        e.obj = evalExpr(e.obj); e.index = single(evalExpr(e.index));
        if (opts.constIndex) { const r = opts.constIndex(e.obj, e.index); if (r) { stats.folded++; return r; } }
        return e;
      }
      case 'MemberExpr': {
        e.obj = evalExpr(e.obj);
        if (opts.constIndex) { const r = opts.constIndex(e.obj, { type: 'StringLit', value: e.name, raw: JSON.stringify(e.name) }); if (r) { stats.folded++; return r; } }
        return e;
      }
      case 'TableExpr': { for (const f of e.fields) { if (f.key) f.key = evalExpr(f.key); f.value = evalExpr(f.value); } return e; }
      case 'FunctionExpr': { walkStats(e.body); return e; }
      case 'InterpExpr': { for (const p of e.parts) if (p.kind === 'expr') p.expr = evalExpr(p.expr); return e; }
      case 'IfExpr': {
        const one = (x: A.Expr): A.Expr => (x.type === 'CallExpr' || x.type === 'MethodCallExpr' || x.type === 'VarargLit') ? ({ type: 'ParenExpr', expr: x, loc: x.loc } as A.Expr) : x;
        for (const c of e.clauses) { c.cond = single(evalExpr(c.cond)); c.value = single(evalExpr(c.value)); }
        e.elseValue = single(evalExpr(e.elseValue));
        const kept: typeof e.clauses = [];
        for (const c of e.clauses) {
          const v = lit(c.cond);
          if (v === undefined) { kept.push(c); continue; }
          stats.folded++;
          if (v === false || v === null) continue;
          if (!kept.length) return one(c.value);
          return { ...e, clauses: kept, elseValue: c.value };
        }
        if (!kept.length) return one(e.elseValue);
        e.clauses = kept;
        return e;
      }
      default: return e;
    }
  }

  function foldBin(e: A.BinExpr): A.Expr | null {
    const a = lit(e.left), b = lit(e.right);
    // `and` / `or` with a literal left operand (any right operand, numbers included)
    if (e.op === 'and' && a !== undefined) return (a === false || a === null) ? e.left : e.right;
    if (e.op === 'or' && a !== undefined) return (a !== false && a !== null) ? e.left : e.right;
    // string concat
    if (e.op === '..' && (typeof a === 'string' || isNum(a)) && (typeof b === 'string' || isNum(b))) {
      return mkStr(String(a) + String(b), e.loc);
    }
    if (!isNum(a) || !isNum(b)) {
      // boolean logic with literals
      if (e.op === 'and') { if (a === false || a === null) return e.left; if (a !== undefined) return e.right; }
      if (e.op === 'or') { if (a !== undefined && a !== false && a !== null) return e.left; if (a === false || a === null) return e.right; }
      return null;
    }
    switch (e.op) {
      case '+': return mkNum(a + b, e.loc);
      case '-': return mkNum(a - b, e.loc);
      case '*': return mkNum(a * b, e.loc);
      case '/': return mkNum(a / b, e.loc);
      case '%': return mkNum(a - Math.floor(a / b) * b, e.loc);
      case '^': return mkNum(Math.pow(a, b), e.loc);
      case '//': return mkNum(Math.floor(a / b), e.loc);
      case '==': return mkBool(a === b, e.loc);
      case '~=': return mkBool(a !== b, e.loc);
      case '<': return mkBool(a < b, e.loc);
      case '>': return mkBool(a > b, e.loc);
      case '<=': return mkBool(a <= b, e.loc);
      case '>=': return mkBool(a >= b, e.loc);
      case '&': return mkNum(toI32(toU32(a) & toU32(b)), e.loc);
      case '|': return mkNum(toI32(toU32(a) | toU32(b)), e.loc);
      case '~': return mkNum(toI32(toU32(a) ^ toU32(b)), e.loc);
      case '<<': return mkNum(toI32(toU32(a) << (b & 31)), e.loc);
      case '>>': return mkNum(toI32(toU32(a) >>> (b & 31)), e.loc);
      default: return null;
    }
  }

  // MBA identities over literals: bor(a,b)+band(a,b) == a+b ; bxor(a,b)+2*band(a,b) == a+b ; etc.
  function foldMBA(e: A.BinExpr): A.Expr | null {
    if (e.op !== '+' && e.op !== '-') return null;
    // Parse each side as either a bitcall, or k * bitcall / bitcall * k (coefficient form).
    const L = asTerm(e.left);
    const R = asTerm(e.right);
    if (!L || !R) return null;
    // operands must be the same literal pair
    const samePair = (L.a === R.a && L.b === R.b) || (L.a === R.b && L.b === R.a);
    if (!samePair) return null;
    const a = L.a, b = L.b;
    // build a signed coefficient map over {bor,band,bxor}
    const coef: Record<string, number> = { bor: 0, band: 0, bxor: 0 };
    coef[L.op] += L.k;
    coef[R.op] += (e.op === '+' ? 1 : -1) * R.k;
    // Known identities (all over the same operand pair a,b):
    //   a + b          = bor + band
    //   a + b          = bxor + 2*band
    //   a | b          = bor
    //   a & b          = band
    //   a ^ b          = bxor
    // Reduce coef map to a numeric value if it matches a known closed form.
    const bor = toU32(a) | toU32(b), band = toU32(a) & toU32(b), bxor = toU32(a) ^ toU32(b);
    const val = coef.bor * bor + coef.band * band + coef.bxor * bxor;
    // only fold when the expression is a pure integer combination we constructed
    if (Number.isFinite(val)) return mkNum(val, e.loc);
    return null;
  }

  // Recognize `bitcall`, `k * bitcall`, `bitcall * k` over literal args.
  function asTerm(e: A.Expr): { op: string; a: number; b: number; k: number } | null {
    const direct = asBitCall(e, resolve);
    if (direct) {
      const a = lit(direct.a), b = lit(direct.b);
      if (isNum(a) && isNum(b)) return { op: direct.op, a, b, k: 1 };
      return null;
    }
    if (e.type === 'BinExpr' && e.op === '*') {
      const ln = lit(e.left), rn = lit(e.right);
      if (isNum(ln)) { const c = asBitCall(e.right, resolve); if (c) { const a = lit(c.a), b = lit(c.b); if (isNum(a) && isNum(b)) return { op: c.op, a, b, k: ln }; } }
      if (isNum(rn)) { const c = asBitCall(e.left, resolve); if (c) { const a = lit(c.a), b = lit(c.b); if (isNum(a) && isNum(b)) return { op: c.op, a, b, k: rn }; } }
    }
    return null;
  }

  function isLiteral(e: A.Expr): boolean {
    return e.type === 'NumberLit' || e.type === 'StringLit' || e.type === 'TrueLit' || e.type === 'FalseLit' || e.type === 'NilLit';
  }

  function walkStats(body: A.Stat[]) {
    for (const s of body) walkStat(s);
    // a call statement whose call folded to a value (pure library call with literal arguments) has no effect
    for (let i = body.length - 1; i >= 0; i--) { const s = body[i]; if (s.type === 'CallStat' && s.expr.type !== 'CallExpr' && s.expr.type !== 'MethodCallExpr') body.splice(i, 1); }
  }
  /** an assignment target: fold its sub-expressions, never the stored-to place itself */
  function evalTarget(t: A.Expr): A.Expr {
    if (t.type === 'IndexExpr') { t.obj = evalExpr(t.obj); t.index = single(evalExpr(t.index)); return t; }
    if (t.type === 'MemberExpr') { t.obj = evalExpr(t.obj); return t; }
    return t;
  }
  function walkStat(s: A.Stat) {
    switch (s.type) {
      case 'LocalStat': s.init = s.init.map(evalExpr); break;
      case 'AssignStat': s.targets = s.targets.map(evalTarget); s.values = s.values.map(evalExpr); break;
      case 'CallStat': s.expr = evalExpr(s.expr) as any; break;
      case 'DoStat': walkStats(s.body); break;
      case 'WhileStat': s.cond = evalExpr(s.cond); walkStats(s.body); break;
      case 'RepeatStat': walkStats(s.body); s.cond = evalExpr(s.cond); break;
      case 'IfStat': for (const c of s.clauses) { c.cond = evalExpr(c.cond); walkStats(c.body); } if (s.elseBody) walkStats(s.elseBody); break;
      case 'NumericForStat': s.from = evalExpr(s.from); s.to = evalExpr(s.to); if (s.step) s.step = evalExpr(s.step); walkStats(s.body); break;
      case 'GenericForStat': s.iters = s.iters.map(evalExpr); walkStats(s.body); break;
      case 'FunctionStat': s.target = evalTarget(s.target); walkStats(s.func.body); break;
      case 'LocalFunctionStat': walkStats(s.func.body); break;
      case 'ReturnStat': s.args = s.args.map(evalExpr); break;
    }
  }

  if (node.type === 'Chunk') walkStats(node.body);
  else if (node.type && node.type.endsWith('Stat')) walkStat(node);
  else evalExpr(node);
  return stats;
}
