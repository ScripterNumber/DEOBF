// PRISM Lua/Luau -> Python 3 transpiler (static; for re-implementing decoders /
// deserializers in Python as in the "rewrite the unpacker" workflow).
//
// * strings are byte strings (see pyprelude), tables are LuaTable, nil = None
// * Lua truthiness is preserved (truthy()) unless both semantics provably agree
// * multiple returns use Multi(...) + first()/spread()/adj()
// * every Lua binding gets a unique Python name (shadowing-safe); captured
//   assignments become `nonlocal`; function expressions are hoisted to defs
import { siteKeyer } from '../passes/inline.js';
import type * as A from '../ast.js';
import { parse } from '../parser.js';
import { analyzeScopes, Binding, ScopeInfo } from '../analysis/scope.js';
import { PY_PRELUDE } from './pyprelude.js';

export interface PyOptions {
  prelude?: boolean;
  /** functionToPython: emit a __main__ that calls the target at every call site with static args (default true) */
  calls?: boolean; maxCalls?: number;
  /** code injected at the top of the body of the Lua function whose node starts at source offset `at`;
   *  `code` gets a resolver: Lua name -> Python name of the parameter / upvalue visible there (null if none) */
  hooks?: PyHook[];
  /** tag every emitted Lua function with its source offset (`f.__lua_at__ = <offset>`), so run-time dumps can say
   *  where each function value comes from */
  tagFunctions?: boolean;
}
export interface PyHook { at: number; code: (name: (lua: string) => string | null) => string; }
export interface PyResult { code: string; warnings: string[]; freeNames: string[]; }

const PY_RESERVED = new Set(['False', 'None', 'True', 'and', 'as', 'assert', 'async', 'await', 'break', 'class', 'continue', 'def', 'del', 'elif', 'else', 'except', 'finally', 'for', 'from', 'global', 'if', 'import', 'in', 'is', 'lambda', 'nonlocal', 'not', 'or', 'pass', 'raise', 'return', 'try', 'while', 'with', 'yield', 'match', 'case', 'type', 'print', 'len', 'str', 'int', 'float', 'list', 'dict', 'tuple', 'set', 'range', 'object', 'id', 'min', 'max', 'abs', 'ord', 'chr', 'iter', 'next', 'map', 'filter', 'sum', 'any', 'all', 'open', 'input', 'format', 'hash', 'super', 'self_', 'callable', 'isinstance', 'repr', 'sorted', 'reversed', 'zip', 'enumerate', 'bytes', 'bool', 'exec', 'eval', 'compile', 'globals', 'locals', 'vars', 'getattr', 'setattr', 'hasattr', 'delattr',
  // prelude names
  'T', 'G', 'LuaTable', 'LuaError', 'Multi', 'first', 'spread', 'adj', 'truthy', 'concat', 'tostring', 'tonumber', 'lua_type', 'lua_len', 'lua_range', 'lua_iter', 'pairs', 'ipairs', 'lua_next', 'select', 'lua_unpack', 'lua_print', 'lua_error', 'lua_assert', 'pcall', 'xpcall', 'setmetatable', 'getmetatable', 'rawget', 'rawset', 'rawequal', 'rawlen', 'invoke', 'lua_div', 'lua_idiv', 'lua_mod', 'lua_pow', 'mul', 'string', 'table', 'math', 'bit32', 'utf8', 'os', 'getfenv', 'setfenv', 'main', 'varargs']);

/** Lua global -> prelude expression */
const GLOBAL_MAP: Record<string, string> = {
  print: 'lua_print', tostring: 'tostring', tonumber: 'tonumber', type: 'lua_type', typeof: 'lua_type', pairs: 'pairs', ipairs: 'ipairs', next: 'lua_next',
  select: 'select', unpack: 'lua_unpack', error: 'lua_error', assert: 'lua_assert', pcall: 'pcall', xpcall: 'xpcall', setmetatable: 'setmetatable',
  getmetatable: 'getmetatable', rawget: 'rawget', rawset: 'rawset', rawequal: 'rawequal', rawlen: 'rawlen', string: 'string', table: 'table', math: 'math',
  bit32: 'bit32', utf8: 'utf8', os: 'os', getfenv: 'getfenv', setfenv: 'setfenv', _G: 'G', _ENV: 'G', shared: 'G',
};
const LIBS = new Set(['string', 'table', 'math', 'bit32', 'utf8', 'os']);
const SINGLE_METHODS = new Set(['sub', 'upper', 'lower', 'rep', 'len', 'reverse', 'format']);
/** library functions known to return exactly one value (everything else in a library may return several) */
const KNOWN_SINGLE_LIB = (g: string): boolean => /^(string\.(sub|upper|lower|rep|len|reverse|format|char)|table\.(concat|insert|create|clear|move|find|sort|getn)|math\.(floor|ceil|abs|max|min|sqrt|fmod|log|log10|exp|sin|cos|tan|asin|acos|atan|atan2|sinh|cosh|tanh|pow|deg|rad|random|huge|clamp|sign|round|noise)|bit32\.\w+|utf8\.char|tostring|tonumber|type|typeof|rawget|rawequal|rawlen|setmetatable|getmetatable|rawset|assert|print|error|getfenv|setfenv|buffer\.\w+)$/.test(g);
const MULTI_LIB = new Set(['string.find', 'string.match', 'string.gsub', 'table.unpack', 'unpack', 'select', 'next', 'pcall', 'xpcall', 'math.modf', 'math.frexp']);

const unparen = (e: any): any => { while (e && e.type === 'ParenExpr') e = e.expr; return e; };

function pyStr(s: string): string {
  let out = "'";
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 92) out += '\\\\';
    else if (c === 39) out += "\\'";
    else if (c === 10) out += '\\n';
    else if (c === 13) out += '\\r';
    else if (c === 9) out += '\\t';
    else if (c >= 32 && c < 127) out += s[i];
    else out += '\\x' + (c & 255).toString(16).padStart(2, '0');
  }
  return out + "'";
}
function pyNum(v: number): string {
  if (Number.isNaN(v)) return "float('nan')";
  if (v === Infinity) return "float('inf')";
  if (v === -Infinity) return "float('-inf')";
  if (Number.isInteger(v) && Math.abs(v) < 2 ** 63) return BigInt(v).toString();
  return String(v);
}

type PE = [string, number];   // python expression + precedence
const P = { cond: 1, or: 2, and: 3, not: 4, cmp: 5, bor: 6, bxor: 7, band: 8, shift: 9, add: 10, mul: 11, unary: 12, pow: 13, atom: 14 };
const par = (e: PE, min: number) => e[1] >= min ? e[0] : '(' + e[0] + ')';

class PyEmitter {
  sc: ScopeInfo;
  names = new Map<Binding, string>();
  used = new Set<string>(PY_RESERVED);
  decl = new Map<any, Binding[]>();
  multiFns = new Set<A.FunctionExpr>();
  /** injected code per FunctionExpr source offset (PyOptions.hooks) */
  hooks = new Map<number, PyHook['code']>();
  tagFns = false;
  warnings: string[] = [];
  out: string[] = [];
  pre: string[] = [];
  depth = 0;
  tmp = 0;
  fnCount = 0;
  /** bindings that live at Python module level (function-only mode) */
  moduleLevel = new Set<Binding>();
  /** per-iteration bindings of the enclosing loops (closures must capture their value) */
  loopBindings = new Set<Binding>();

  constructor(public chunk: A.Chunk) {
    this.sc = analyzeScopes(chunk);
    for (const b of this.sc.bindings) { if (b.kind === 'global') continue; const l = this.decl.get(b.decl) ?? []; l[b.index] = b; this.decl.set(b.decl, l); }
    const scanFn = (f: A.FunctionExpr) => {
      const visit = (n: any) => {
        if (!n || typeof n !== 'object') return;
        if (Array.isArray(n)) { n.forEach(visit); return; }
        if (n.type === 'FunctionExpr') return;
        if (n.type === 'ReturnStat') { const last = unparen(n.args[n.args.length - 1]); if (n.args.length >= 2 || (last && ['CallExpr', 'MethodCallExpr', 'VarargLit'].includes(last.type))) this.multiFns.add(f); }
        for (const k of Object.keys(n)) if (k !== 'loc') visit(n[k]);
      };
      visit(f.body);
    };
    const all = (n: any) => { if (!n || typeof n !== 'object') return; if (Array.isArray(n)) { n.forEach(all); return; } if (n.type === 'FunctionExpr') scanFn(n); for (const k of Object.keys(n)) if (k !== 'loc') all(n[k]); };
    all(chunk);
  }

  // ------------------------------------------------------------ names --
  fresh(base: string): string {
    let b = base.replace(/[^A-Za-z0-9_]/g, '_'); if (!/^[A-Za-z_]/.test(b)) b = '_' + b;
    if (PY_RESERVED.has(b)) b += '_';
    let c = b, k = 2; while (this.used.has(c)) c = b + '_' + k++;
    this.used.add(c); return c;
  }
  nameOf(b: Binding): string { let n = this.names.get(b); if (!n) { n = this.fresh(b.name); this.names.set(b, n); } return n; }
  bindingsOf(decl: any): Binding[] { return this.decl.get(decl) ?? []; }
  temp(): string { return '_t' + (++this.tmp); }

  // ------------------------------------------------------------ output --
  line(s: string) { const ind = '    '.repeat(this.depth); for (const p of this.pre) this.out.push(p); this.pre = []; this.out.push(ind + s); }
  /** bindings declared by a loop header / inside its body (not in nested functions) */
  loopDecls(s: A.Stat): Binding[] {
    const out: Binding[] = [...this.bindingsOf(s)];
    const visit = (n: any) => { if (!n || typeof n !== 'object') return; if (Array.isArray(n)) { n.forEach(visit); return; } if (n.type === 'FunctionExpr') return; if (n.type === 'LocalStat' || n.type === 'LocalFunctionStat' || n.type === 'NumericForStat' || n.type === 'GenericForStat') out.push(...this.bindingsOf(n).filter(Boolean)); for (const k of Object.keys(n)) if (k !== 'loc') visit(n[k]); };
    visit((s as any).body);
    return out.filter(Boolean);
  }
  loopMode: Array<{ flag: string } | null> = [];
  loopBlock(s: A.Stat, body: A.Stat[]) {
    const added = this.loopDecls(s).filter(b => !this.loopBindings.has(b));
    for (const b of added) this.loopBindings.add(b);
    this.loopMode.push(null);
    this.block(body);
    this.loopMode.pop();
    for (const b of added) this.loopBindings.delete(b);
  }
  block(body: A.Stat[]) { this.depth++; const n = this.out.length; for (const s of body) this.stat(s); if (this.out.length === n && !this.pre.length) this.line('pass'); else if (this.pre.length) { for (const p of this.pre) this.out.push(p); this.pre = []; } this.depth--; }

  // ------------------------------------------------------- expressions --
  calleeFn(e: A.Expr): A.FunctionExpr | undefined {
    const u = unparen(e);
    if (u?.type !== 'NameExpr') return undefined;
    const b = this.sc.refOf.get(u);
    if (!b || b.kind === 'global') return undefined;
    if (b.kind === 'localfn') return (b.decl as A.LocalFunctionStat).func;
    if (b.kind === 'local' && b.writes === 0 && b.init && unparen(b.init).type === 'FunctionExpr') return unparen(b.init);
    return undefined;
  }
  globalName(e: A.Expr): string | null {
    const u = unparen(e);
    if (u?.type === 'NameExpr') { const b = this.sc.refOf.get(u); return !b || b.kind === 'global' ? u.name : null; }
    if (u?.type === 'MemberExpr') { const o = this.globalName(u.obj); return o ? o + '.' + u.name : null; }
    return null;
  }
  /** can this call yield several values? */
  mayMulti(e: A.Expr): boolean {
    const u = unparen(e);
    if (u.type === 'VarargLit') return true;
    // string methods with a single result stay unwrapped; any other method (user objects,
    // outlined method tables) may return several values -> truncate with first()
    if (u.type === 'MethodCallExpr') return !SINGLE_METHODS.has(u.method);
    if (u.type !== 'CallExpr') return false;
    const f = this.calleeFn(u.callee); if (f) return this.multiFns.has(f);
    const g = this.globalName(u.callee); if (g) return MULTI_LIB.has(g) || (g === 'string.byte' && u.args.length >= 3) || !KNOWN_SINGLE_LIB(g);
    // unknown callee (table field, upvalue, parameter...): it may return several values
    return true;
  }
  isMultiPos(e: A.Expr | undefined): boolean { const u = e && unparen(e); return !!u && e!.type !== 'ParenExpr' && (u.type === 'CallExpr' || u.type === 'MethodCallExpr' || u.type === 'VarargLit'); }
  /** expression in multi-value position -> python starred expression */
  star(e: A.Expr): string { const u = unparen(e); if (u.type === 'VarargLit') return '*varargs'; return '*spread(' + this.raw(u)[0] + ')'; }
  list(es: A.Expr[]): string[] { return es.map((e, i) => i === es.length - 1 && this.isMultiPos(e) ? this.star(e) : this.ex(e)[0]); }

  isBool(e: A.Expr): boolean {
    const u = unparen(e);
    if (u.type === 'TrueLit' || u.type === 'FalseLit') return true;
    if (u.type === 'UnExpr' && u.op === 'not') return true;
    if (u.type === 'BinExpr') { if (['==', '~=', '<', '<=', '>', '>='].includes(u.op)) return true; if (u.op === 'and' || u.op === 'or') return this.isBool(u.left) && this.isBool(u.right); }
    return false;
  }
  /** python truthiness == lua truthiness for this expression's value */
  safeTruth(e: A.Expr): boolean {
    const u = unparen(e);
    if (this.isBool(u) || u.type === 'NilLit' || u.type === 'TableExpr' || u.type === 'FunctionExpr') return true;
    if (u.type === 'NumberLit') return u.value !== 0;
    if (u.type === 'StringLit') return u.value.length > 0;
    if (u.type === 'BinExpr' && (u.op === 'and' || u.op === 'or')) return this.safeTruth(u.left) && this.safeTruth(u.right);
    return false;
  }
  cond(e: A.Expr): string { return this.safeTruth(e) ? this.ex(e)[0] : 'truthy(' + this.ex(e)[0] + ')'; }
  simple(e: A.Expr): boolean { const u = unparen(e); return ['NameExpr', 'NumberLit', 'StringLit', 'NilLit', 'TrueLit', 'FalseLit', 'VarargLit'].includes(u.type) && !(u.type === 'NameExpr' && this.isGlobalLookup(u)); }
  isGlobalLookup(n: A.NameExpr): boolean { const b = this.sc.refOf.get(n); return (!b || b.kind === 'global') && !GLOBAL_MAP[n.name]; }

  /** single-value expression */
  ex(e: A.Expr): PE {
    const r = this.raw(e);
    const u = unparen(e);
    if ((u.type === 'CallExpr' || u.type === 'MethodCallExpr') && this.mayMulti(u)) return ['first(' + r[0] + ')', P.atom];
    return r;
  }
  name(n: A.NameExpr): string {
    const b = this.sc.refOf.get(n);
    if (b && b.kind !== 'global') return this.nameOf(b);
    if (GLOBAL_MAP[n.name]) return GLOBAL_MAP[n.name];
    return 'G[' + pyStr(n.name) + ']';
  }
  raw(e: A.Expr): PE {
    switch (e.type) {
      case 'NilLit': return ['None', P.atom];
      case 'TrueLit': return ['True', P.atom];
      case 'FalseLit': return ['False', P.atom];
      case 'NumberLit': return [pyNum(e.value), e.value < 0 ? P.unary : P.atom];
      case 'StringLit': return [pyStr(e.value), P.atom];
      case 'VarargLit': return ['(varargs[0] if varargs else None)', P.atom];
      case 'NameExpr': return [this.name(e), P.atom];
      case 'ParenExpr': return this.ex(e.expr);
      case 'MemberExpr': {
        const g = this.globalName(e.obj);
        if (g && LIBS.has(g)) return [GLOBAL_MAP[g] + '.' + e.name, P.atom];
        return [par(this.ex(e.obj), P.atom) + '[' + pyStr(e.name) + ']', P.atom];
      }
      case 'IndexExpr': return [par(this.ex(e.obj), P.atom) + '[' + this.ex(e.index)[0] + ']', P.atom];
      case 'CallExpr': return [par(this.ex(e.callee), P.atom) + '(' + this.list(e.args).join(', ') + ')', P.atom];
      case 'MethodCallExpr': return ['invoke(' + [this.ex(e.obj)[0], pyStr(e.method), ...this.list(e.args)].join(', ') + ')', P.atom];
      case 'FunctionExpr': { const nm = this.fresh('_fn' + (++this.fnCount)); this.func(nm, e, true); return [nm, P.atom]; }
      case 'TableExpr': return [this.table(e), P.atom];
      case 'UnExpr': {
        if (e.op === '-') return ['-' + par(this.ex(e.expr), P.unary), P.unary];
        if (e.op === 'not') return this.safeTruth(e.expr) ? ['not ' + par(this.ex(e.expr), P.not), P.not] : ['not truthy(' + this.ex(e.expr)[0] + ')', P.not];
        if (e.op === '#') return ['lua_len(' + this.ex(e.expr)[0] + ')', P.atom];
        if (e.op === '~') return ['~int(' + this.ex(e.expr)[0] + ')', P.unary];
        this.warnings.push('unknown unary ' + e.op); return [e.op + par(this.ex(e.expr), P.unary), P.unary];
      }
      case 'BinExpr': return this.bin(e);
      case 'IfExpr': {
        let out = this.ex(e.elseValue)[0];
        for (let i = e.clauses.length - 1; i >= 0; i--) { const c = e.clauses[i]; out = '(' + this.ex(c.value)[0] + ' if ' + this.cond(c.cond) + ' else ' + out + ')'; }
        return [out, P.atom];
      }
      case 'InterpExpr': return ['concat(' + e.parts.map(p => p.kind === 'str' ? pyStr(p.value) : 'tostring(' + this.ex(p.expr)[0] + ')').join(', ') + ')', P.atom];
    }
    this.warnings.push('unsupported expression ' + (e as any).type);
    return ['None', P.atom];
  }
  bin(e: A.BinExpr): PE {
    const op = e.op;
    if (op === '..') {
      const parts: A.Expr[] = [];
      const flat = (x: A.Expr) => { const u = x.type === 'BinExpr' ? x : null; if (u && u.op === '..') { flat(u.left); flat(u.right); } else parts.push(x); };
      flat(e);
      return ['concat(' + parts.map(p => this.ex(p)[0]).join(', ') + ')', P.atom];
    }
    if (op === 'and' || op === 'or') {
      if (this.safeTruth(e.left)) {
        const p = op === 'and' ? P.and : P.or;
        return [par(this.ex(e.left), p) + ' ' + op + ' ' + par(this.ex(e.right), p + 1), p];
      }
      const l = this.ex(e.left)[0], r = this.ex(e.right)[0];
      if (this.simple(e.left)) return [op === 'and' ? `${r} if truthy(${l}) else ${l}` : `${l} if truthy(${l}) else ${r}`, P.cond];
      const t = this.temp();
      return [op === 'and' ? `${r} if truthy(${t} := ${l}) else ${t}` : `${t} if truthy(${t} := ${l}) else ${r}`, P.cond];
    }
    const cmp: Record<string, string> = { '==': '==', '~=': '!=', '<': '<', '<=': '<=', '>': '>', '>=': '>=' };
    if (cmp[op]) return [par(this.ex(e.left), P.cmp + 1) + ' ' + cmp[op] + ' ' + par(this.ex(e.right), P.cmp + 1), P.cmp];
    const fn: Record<string, string> = { '/': 'lua_div', '%': 'lua_mod', '^': 'lua_pow', '//': 'lua_idiv' };
    if (fn[op]) return [fn[op] + '(' + this.ex(e.left)[0] + ', ' + this.ex(e.right)[0] + ')', P.atom];
    if (op === '*') {
      // exact Python ints diverge from Lua doubles past 2^53: route big products through mul()
      const small = (x: A.Expr) => { const u = unparen(x); return u.type === 'NumberLit' && Math.abs(u.value) <= 65536; };
      if (!small(e.left) && !small(e.right)) return ['mul(' + this.ex(e.left)[0] + ', ' + this.ex(e.right)[0] + ')', P.atom];
    }
    const arith: Record<string, number> = { '+': P.add, '-': P.add, '*': P.mul };
    if (arith[op]) { const p = arith[op]; return [par(this.ex(e.left), p) + ' ' + op + ' ' + par(this.ex(e.right), p + 1), p]; }
    const bits: Record<string, [string, number]> = { '&': ['&', P.band], '|': ['|', P.bor], '~': ['^', P.bxor], '<<': ['<<', P.shift], '>>': ['>>', P.shift] };
    if (bits[op]) { const [o, p] = bits[op]; return ['int(' + this.ex(e.left)[0] + ') ' + o + ' int(' + this.ex(e.right)[0] + ')', p]; }
    this.warnings.push('unknown operator ' + op);
    return ['(' + this.ex(e.left)[0] + ' ' + op + ' ' + this.ex(e.right)[0] + ')', P.atom];
  }
  table(e: A.TableExpr): string {
    const arr: string[] = [], hash: string[] = [];
    e.fields.forEach((f, i) => {
      if (f.kind === 'item') arr.push(i === e.fields.length - 1 && this.isMultiPos(f.value) ? this.star(f.value) : this.ex(f.value)[0]);
      else if (f.kind === 'named') hash.push(pyStr(f.name!) + ': ' + this.ex(f.value)[0]);
      else hash.push(this.ex(f.key!)[0] + ': ' + this.ex(f.value)[0]);
    });
    if (!arr.length && !hash.length) return 'T()';
    if (!hash.length) return 'T([' + arr.join(', ') + '])';
    return 'T(' + (arr.length ? '[' + arr.join(', ') + ']' : 'None') + ', {' + hash.join(', ') + '})';
  }

  // -------------------------------------------------------- statements --
  lvalue(t: A.Expr): string {
    if (t.type === 'NameExpr') { const b = this.sc.refOf.get(t); return b && b.kind !== 'global' ? this.nameOf(b) : 'G[' + pyStr(t.name) + ']'; }
    if (t.type === 'MemberExpr') return par(this.ex(t.obj), P.atom) + '[' + pyStr(t.name) + ']';
    if (t.type === 'IndexExpr') return par(this.ex(t.obj), P.atom) + '[' + this.ex(t.index)[0] + ']';
    if (t.type === 'ParenExpr') return this.lvalue(t.expr);
    this.warnings.push('unsupported assignment target ' + t.type);
    return '_drop';
  }
  assign(targets: string[], values: A.Expr[]) {
    const n = targets.length;
    if (!values.length) { this.line(targets.join(', ') + ' = ' + (n === 1 ? 'None' : targets.map(() => 'None').join(', '))); return; }
    if (n === 1 && values.length === 1) { this.line(targets[0] + ' = ' + this.ex(values[0])[0]); return; }
    const last = values[values.length - 1];
    if (values.length < n && this.isMultiPos(last)) { this.line(targets.join(', ') + ' = adj(' + n + ', ' + this.list(values).join(', ') + ')'); return; }
    const vs = values.map(v => this.ex(v)[0]);
    while (vs.length < n) vs.push('None');
    if (vs.length > n) { this.line(targets.join(', ') + ', *_drop = ' + vs.join(', ')); return; }
    this.line(targets.join(', ') + ' = ' + vs.join(', '));
  }
  /** Python name of the Lua parameter / upvalue `lua` visible at the top of `f`'s body (last duplicate parameter wins) */
  visibleName(f: A.FunctionExpr, pyParams: string[], lua: string): string | null {
    const i = f.params.lastIndexOf(lua);
    if (i >= 0) return pyParams[i];
    const fl = f.loc;
    const box: { b: Binding | null } = { b: null };
    const v = (n: any): void => {
      if (box.b || !n || typeof n !== 'object') return;
      if (Array.isArray(n)) { n.forEach(v); return; }
      if (n.type === 'NameExpr' && n.name === lua) {
        const b = this.sc.refOf.get(n), d = (b?.decl as { loc?: A.Pos } | undefined)?.loc;
        if (b && b.kind !== 'global' && (!d || !fl || d.start < fl.start || d.start > fl.end)) { box.b = b; return; }
      }
      for (const k of Object.keys(n)) if (k !== 'loc') v(n[k]);
    };
    v(f.body);
    return box.b ? this.nameOf(box.b) : null;
  }
  func(name: string, f: A.FunctionExpr, hoisted: boolean) {
    const saveOut = this.out, savePre = this.pre;
    this.out = []; this.pre = [];
    const ps = this.bindingsOf(f);
    const pyParams = f.params.map((p, i) => (ps[i] ? this.nameOf(ps[i]) : this.fresh(p)));
    const params = pyParams.map(n => n + '=None');
    params.push(f.vararg ? '*varargs' : '*_rest');
    // Lua closures capture a fresh loop variable per iteration; Python closures are
    // late-bound -> freeze never-reassigned loop locals through keyword defaults
    if (this.loopBindings.size) {
      const caps = new Set<Binding>();
      const visit = (n: any) => { if (!n || typeof n !== 'object') return; if (Array.isArray(n)) { n.forEach(visit); return; } if (n.type === 'NameExpr') { const b = this.sc.refOf.get(n); if (b && this.loopBindings.has(b) && b.writes === 0) caps.add(b); } for (const k of Object.keys(n)) if (k !== 'loc') visit(n[k]); };
      visit(f.body);
      for (const b of caps) { const nm = this.nameOf(b); params.push(nm + '=' + nm); }
    }
    const savedLoop = this.loopBindings; this.loopBindings = new Set();
    const savedMode = this.loopMode; this.loopMode = [];
    this.line('def ' + name + '(' + params.join(', ') + '):');
    this.depth++;
    const nl: string[] = [], gl: string[] = [];
    for (const b of this.sc.bindings) if (b.kind !== 'global' && b.fn !== f && b.writeFns.has(f)) (this.moduleLevel.has(b) ? gl : nl).push(this.nameOf(b));
    if (gl.length) this.line('global ' + [...new Set(gl)].join(', '));
    if (nl.length) this.line('nonlocal ' + [...new Set(nl)].join(', '));
    const hook = f.loc ? this.hooks.get(f.loc.start) : undefined;
    if (hook) for (const l of hook(lua => this.visibleName(f, pyParams, lua)).split('\n')) if (l.trim()) this.line(l);
    const n0 = this.out.length;
    for (const s of f.body) this.stat(s);
    if (this.pre.length) { this.out.push(...this.pre); this.pre = []; }
    if (this.out.length === n0) this.line('pass');
    this.depth--;
    if (this.tagFns && f.loc) this.line(name + '.__lua_at__ = ' + f.loc.start);
    this.loopBindings = savedLoop; this.loopMode = savedMode;
    const lines = this.out;
    this.out = saveOut; this.pre = savePre;
    if (hoisted) this.pre.push(...lines);
    else { this.out.push(...this.pre); this.pre = []; this.out.push(...lines); }
  }
  stat(s: A.Stat) {
    switch (s.type) {
      case 'LocalStat': {
        const bs = this.bindingsOf(s);
        const names = s.names.map((nm, i) => bs[i] ? this.nameOf(bs[i]) : this.fresh(nm));
        if (names.length === 1 && s.init.length === 1 && s.init[0].type === 'FunctionExpr') { this.func(names[0], s.init[0], false); return; }
        this.assign(names, s.init); return;
      }
      case 'LocalFunctionStat': { const b = this.bindingsOf(s)[0]; this.func(b ? this.nameOf(b) : this.fresh(s.name), s.func, false); return; }
      case 'FunctionStat': {
        const t = s.target;
        if (t.type === 'NameExpr') { const b = this.sc.refOf.get(t); if (b && b.kind !== 'global') { this.func(this.nameOf(b), s.func, false); return; } }
        const nm = this.fresh(t.type === 'MemberExpr' ? t.name : t.type === 'NameExpr' ? t.name : 'fn');
        this.func(nm, s.func, false);
        this.line(this.lvalue(t) + ' = ' + nm);
        return;
      }
      case 'AssignStat': {
        const ts = s.targets.map(t => this.lvalue(t));
        if (s.op) { const v = this.ex({ type: 'BinExpr', op: s.op.replace(/=$/, ''), left: s.targets[0], right: s.values[0] } as A.BinExpr)[0]; this.line(ts[0] + ' = ' + v); return; }
        this.assign(ts, s.values); return;
      }
      case 'CallStat': this.line(this.raw(s.expr)[0]); return;
      case 'DoStat': for (const x of s.body) this.stat(x); return;
      case 'WhileStat': { const c = this.cond(s.cond); this.line('while ' + c + ':'); this.loopBlock(s, s.body); return; }
      case 'RepeatStat': {
        this.line('while True:'); this.depth++;
        const added = this.loopDecls(s).filter(b => !this.loopBindings.has(b));
        for (const b of added) this.loopBindings.add(b);
        if (hasOwnContinue(s.body)) {
          // Luau `continue` in repeat-until still evaluates the condition:
          // run the body in a one-shot inner loop (continue -> break, break -> flag)
          const flag = this.fresh('_brk');
          this.line(flag + ' = False');
          this.line('while True:'); this.depth++;
          this.loopMode.push({ flag });
          for (const x of s.body) this.stat(x);
          this.loopMode.pop();
          this.line('break'); this.depth--;
          this.line('if ' + flag + ':'); this.depth++; this.line('break'); this.depth--;
        } else {
          this.loopMode.push(null);
          for (const x of s.body) this.stat(x);
          this.loopMode.pop();
        }
        const c = this.cond(s.cond); this.line('if ' + c + ':'); this.depth++; this.line('break'); this.depth -= 2;
        for (const b of added) this.loopBindings.delete(b);
        return;
      }
      case 'IfStat': {
        const conds = s.clauses.map(c => this.cond(c.cond));
        s.clauses.forEach((c, i) => { this.line((i ? 'elif ' : 'if ') + conds[i] + ':'); this.block(c.body); });
        if (s.elseBody && s.elseBody.length) { this.line('else:'); this.block(s.elseBody); }
        return;
      }
      case 'NumericForStat': {
        const b = this.bindingsOf(s)[0];
        const v = b ? this.nameOf(b) : this.fresh(s.var);
        const lit = (e: A.Expr | undefined) => { const u = e && unparen(e); if (!u) return null; if (u.type === 'NumberLit' && Number.isInteger(u.value)) return u.value; if (u.type === 'UnExpr' && u.op === '-' && unparen(u.expr).type === 'NumberLit' && Number.isInteger(unparen(u.expr).value)) return -unparen(u.expr).value; return null; };
        const a = lit(s.from), z = lit(s.to), st = s.step ? lit(s.step) : 1;
        let it: string;
        if (a !== null && z !== null && st !== null && st !== 0) it = st === 1 ? `range(${a}, ${z + 1})` : `range(${a}, ${z + (st > 0 ? 1 : -1)}, ${st})`;
        else it = 'lua_range(' + [this.ex(s.from)[0], this.ex(s.to)[0], ...(s.step ? [this.ex(s.step)[0]] : [])].join(', ') + ')';
        this.line(`for ${v} in ${it}:`); this.loopBlock(s, s.body); return;
      }
      case 'GenericForStat': {
        const bs = this.bindingsOf(s);
        const names = s.names.map((nm, i) => bs[i] ? this.nameOf(bs[i]) : this.fresh(nm));
        const one = s.iters.length === 1 ? unparen(s.iters[0]) : null;
        const g = one?.type === 'CallExpr' ? this.globalName(one.callee) : null;
        if (one && (g === 'pairs' || g === 'ipairs') && one.args.length === 1 && names.length <= 2) {
          this.line(`for ${names[0]}, ${names[1] ?? '_drop'} in ${g}(${this.ex(one.args[0])[0]}):`);
        } else {
          this.line(`for ${names.join(', ')}, in lua_iter(${names.length}, ${this.list(s.iters).join(', ')}):`);
        }
        this.loopBlock(s, s.body); return;
      }
      case 'ReturnStat': {
        if (!s.args.length) { this.line('return None'); return; }
        if (s.args.length === 1) {
          const u = unparen(s.args[0]);
          if (s.args[0].type !== 'ParenExpr' && u.type === 'VarargLit') { this.line('return Multi(varargs)'); return; }
          if (s.args[0].type !== 'ParenExpr' && (u.type === 'CallExpr' || u.type === 'MethodCallExpr')) { this.line('return ' + this.raw(u)[0]); return; }
          this.line('return ' + this.ex(s.args[0])[0]); return;
        }
        this.line('return Multi((' + this.list(s.args).join(', ') + ',))'); return;
      }
      case 'BreakStat': { const m = this.loopMode[this.loopMode.length - 1]; if (m) { this.line(m.flag + ' = True'); } this.line('break'); return; }
      case 'ContinueStat': { const m = this.loopMode[this.loopMode.length - 1]; this.line(m ? 'break' : 'continue'); return; }
      case 'GotoStat': this.warnings.push(`L${s.loc?.line}: goto ${s.label} is not representable in Python`); this.line(`raise NotImplementedError('goto ${s.label}')`); return;
      case 'LabelStat': this.line(`pass  # ::${s.name}::`); return;
    }
    this.warnings.push('unsupported statement ' + (s as any).type);
  }
}

/** continue statements binding to this loop (not nested loops / functions) */
function hasOwnContinue(body: A.Stat[]): boolean {
  let hit = false;
  const visit = (n: any) => {
    if (hit || !n || typeof n !== 'object') return;
    if (Array.isArray(n)) { n.forEach(visit); return; }
    if (n.type === 'ContinueStat') { hit = true; return; }
    if (n.type === 'FunctionExpr' || n.type === 'WhileStat' || n.type === 'RepeatStat' || n.type === 'NumericForStat' || n.type === 'GenericForStat') return;
    for (const k of Object.keys(n)) if (k !== 'loc') visit(n[k]);
  };
  visit(body);
  return hit;
}

/** transpile a whole chunk (wrapped in main(*varargs)) */
export function luaToPython(src: string, opts: PyOptions = {}): PyResult {
  const { chunk, errors } = parse(src);
  const em = new PyEmitter(chunk);
  for (const h of opts.hooks ?? []) em.hooks.set(h.at, h.code);
  em.tagFns = !!opts.tagFunctions;
  em.used.add('_rest'); em.used.add('_drop');
  if (errors.length) em.warnings.push(`source has ${errors.length} parse error(s); first: ${errors[0].message} @L${errors[0].line}`);
  em.out.push('def main(*varargs):');
  em.depth = 1;
  const n0 = em.out.length;
  for (const s of chunk.body) em.stat(s);
  if (em.pre.length) { em.out.push(...em.pre); em.pre = []; }
  if (em.out.length === n0) em.out.push('    pass');
  em.out.push('', '', "if __name__ == '__main__':", '    main()');
  const header = opts.prelude === false ? '' : PY_PRELUDE + '\n\n';
  return { code: header + em.out.join('\n') + '\n', warnings: em.warnings, freeNames: [] };
}

export interface PyFunctionResult extends PyResult { name: string; line: number; deps: string[]; }

/** transpile one function (by name, callgraph id or a line inside it) plus the local
 *  helper functions / literal upvalues it depends on, as standalone Python. */
export interface FnSite { f: A.FunctionExpr; line: number; endLine: number; name: string; binding?: Binding; stat?: A.Stat; }
/** The static dependency closure of one function: helper functions, upvalues with static initializers,
 *  globals assigned once, table populators and the call sites with statically known arguments.
 *  Shared by the Python port (functionToPython) and the exact Lua slice (functionToLua). */
export interface SliceClosure {
  chunk: A.Chunk; em: PyEmitter; site: FnSite; sites: FnSite[]; fnSites: FnSite[];
  values: Array<{ b: Binding; init?: A.Expr }>; gValues: Array<{ name: string; init: A.Expr; line: number }>; gFns: Array<{ name: string; site: FnSite }>;
  populate: A.Stat[]; callSites: Array<{ call: A.CallExpr; keys: string[] }>; totalSites: number; skippedSites: number; initOf: (b: Binding) => A.Expr | undefined;
}
export function sliceClosure(src: string, query: string | number, opts: PyOptions): SliceClosure | null {
  const { chunk } = parse(src);
  const em = new PyEmitter(chunk);
  em.used.add('_rest'); em.used.add('_drop');
  // index every function expression with its declaring statement / binding
  const sites: FnSite[] = [];
  const visit = (n: any, stat?: any) => {
    if (!n || typeof n !== 'object') return;
    if (Array.isArray(n)) { n.forEach(x => visit(x, stat)); return; }
    if (n.type === 'FunctionExpr') {
      let name = '<anonymous>', binding: Binding | undefined;
      if (stat?.type === 'LocalFunctionStat' && stat.func === n) { binding = em.bindingsOf(stat)[0]; name = stat.name; }
      else if (stat?.type === 'LocalStat' && stat.init.length === 1 && stat.init[0] === n && stat.names.length === 1) { binding = em.bindingsOf(stat)[0]; name = stat.names[0]; }
      else if (stat?.type === 'FunctionStat' && stat.func === n) { const t = stat.target; name = t.type === 'NameExpr' ? t.name : t.type === 'MemberExpr' ? t.name : name; if (t.type === 'NameExpr') { const b = em.sc.refOf.get(t); if (b && b.kind !== 'global') binding = b; } }
      sites.push({ f: n, line: n.loc?.line ?? 0, endLine: n.loc?.endLine ?? n.loc?.line ?? 0, name, binding, stat });
    }
    const isStat = typeof n.type === 'string' && /Stat$/.test(n.type);
    for (const k of Object.keys(n)) if (k !== 'loc') visit(n[k], isStat ? n : stat);
  };
  visit(chunk);
  let site: FnSite | undefined;
  const q = String(query);
  if (/^\d+$/.test(q)) {
    const line = Number(q);
    for (const s of sites) if (s.line <= line && line <= s.endLine && (!site || s.endLine - s.line < site.endLine - site.line)) site = s;
  } else site = sites.find(s => s.name === q) ?? sites.find(s => s.binding && em.nameOf(s.binding) === q);
  if (!site) return null;

  const inner = (f: A.FunctionExpr) => { const set = new Set<any>(); const v = (n: any) => { if (!n || typeof n !== 'object') return; if (Array.isArray(n)) { n.forEach(v); return; } if (n.type === 'FunctionExpr') set.add(n); for (const k of Object.keys(n)) if (k !== 'loc') v(n[k]); }; v(f); return set; };
  const innerAll = (e: any) => { const set = new Set<any>(); const v = (n: any) => { if (!n || typeof n !== 'object') return; if (Array.isArray(n)) { n.forEach(v); return; } if (n.type === 'FunctionExpr') for (const x of inner(n)) set.add(x); else for (const k of Object.keys(n)) if (k !== 'loc') v(n[k]); }; v(e); return set; };
  const freeOf = (node: any, own: Set<any>, exclude?: Set<Binding>): Binding[] => {
    const out = new Set<Binding>();
    const v = (n: any) => { if (!n || typeof n !== 'object') return; if (Array.isArray(n)) { n.forEach(v); return; } if (n.type === 'NameExpr') { const b = em.sc.refOf.get(n); if (b && b.kind !== 'global' && !own.has(b.fn) && !exclude?.has(b)) out.add(b); } for (const k of Object.keys(n)) if (k !== 'loc') v(n[k]); };
    v(node);
    return [...out];
  };
  // `local a, b; ...; a = <static>` (declared without value, assigned exactly once in the same block)
  // counts as a static initializer — common in VM prologues (Hercules, PSU, ...)
  const blockOf = new Map<any, any[]>();
  // globals written exactly once in the whole script (static `__ = 1`, `function Foo() … end`)
  const gWrites = new Map<string, Array<{ value?: A.Expr; fn?: A.FunctionExpr; line: number; inFn: any }>>();
  let curFn: any = chunk;
  const assignOf = new Map<A.NameExpr, { stat: A.AssignStat; value: A.Expr }>();
  const idx = (n: any) => {
    if (!n || typeof n !== 'object') return;
    if (Array.isArray(n)) { for (const x of n) { if (x && typeof x.type === 'string' && /Stat$/.test(x.type)) blockOf.set(x, n); idx(x); } return; }
    if (n.type === 'AssignStat') n.targets.forEach((t: A.Expr, i: number) => {
      if (t.type !== 'NameExpr') return;
      const multiTail = i >= n.values.length - 1 && n.targets.length > n.values.length && /CallExpr|VarargLit/.test(unparen(n.values[n.values.length - 1] ?? { type: 'NilLit' } as any).type);
      const value = !n.op && i < n.values.length && !multiTail ? n.values[i] : undefined;
      if (value) assignOf.set(t, { stat: n, value });
      const b = em.sc.refOf.get(t);
      if (!b || b.kind === 'global') { const g = gWrites.get(t.name) ?? []; g.push({ value, line: t.loc?.line ?? 0, inFn: curFn }); gWrites.set(t.name, g); }
    });
    if (n.type === 'FunctionStat' && n.target.type === 'NameExpr') { const b = em.sc.refOf.get(n.target); if (!b || b.kind === 'global') { const g = gWrites.get(n.target.name) ?? []; g.push({ fn: n.func, line: n.loc?.line ?? 0, inFn: curFn }); gWrites.set(n.target.name, g); } }
    const saved = curFn;
    if (n.type === 'FunctionExpr') curFn = n;
    for (const k of Object.keys(n)) if (k !== 'loc') idx(n[k]);
    curFn = saved;
  };
  idx(chunk);
  const initOf = (b: Binding): A.Expr | undefined => {
    if (b.init) return b.initMulti ? undefined : b.init;
    if (b.kind !== 'local' || b.writes !== 1 || b.writeRefs.length !== 1) return undefined;
    const w = assignOf.get(b.writeRefs[0]);
    if (!w) return undefined;
    const blk = blockOf.get(b.decl);
    return blk && blk === blockOf.get(w.stat) && blk.indexOf(b.decl) < blk.indexOf(w.stat) ? w.value : undefined;
  };
  const fnSites: FnSite[] = [site];
  const values: Array<{ b: Binding; init?: A.Expr }> = [];
  const seen = new Set<Binding>();
  if (site.binding) seen.add(site.binding);
  const work: Array<{ node: any; own: Set<any>; exclude?: Set<Binding> }> = [{ node: site.f, own: inner(site.f) }];
  const isStaticInit = (e: A.Expr): boolean => {
    const u = unparen(e);
    if (['NumberLit', 'StringLit', 'NilLit', 'TrueLit', 'FalseLit'].includes(u.type)) return true;
    if (u.type === 'UnExpr') return isStaticInit(u.expr);
    if (u.type === 'BinExpr') return isStaticInit(u.left) && isStaticInit(u.right);
    if (u.type === 'TableExpr') return u.fields.every((f: A.TableField) => isStaticInit(f.value) && (!f.key || isStaticInit(f.key)));
    if (u.type === 'MemberExpr' || (u.type === 'NameExpr' && em.globalName(u))) return !!em.globalName(u);
    if (u.type === 'CallExpr') {
      const g = em.globalName(u.callee);
      if (g) return /^(string|math|bit32|table|utf8)\./.test(g) && u.args.every(isStaticInit);
      // call of a local helper with static args, e.g. local bytecode = decompress("...")
      return !!em.calleeFn(u.callee) && u.args.every(isStaticInit);
    }
    if (u.type === 'FunctionExpr') return true;
    if (u.type === 'NameExpr') { const b = em.sc.refOf.get(u); return !!b && b.kind !== 'global' && (b.kind === 'localfn' || (b.writes === 0 && !!b.init) || (!b.init && !!initOf(b))); }
    return false;
  };
  // call sites of the target whose arguments are statically known → runnable __main__
  // identical argument lists are computed once; every call site keeps its own "L<line>:<col>" key for inline_values
  const callSites: Array<{ call: A.CallExpr; keys: string[] }> = [];
  let totalSites = 0, skippedSites = 0;
  if (opts.calls !== false) {
    const gname = !site.binding && site.stat?.type === 'FunctionStat' && site.stat.target.type === 'NameExpr' ? site.stat.target.name : null;
    const staticArg = (e: A.Expr) => unparen(e).type !== 'FunctionExpr' && unparen(e).type !== 'VarargLit' && isStaticInit(e);
    const byArgs = new Map<string, { call: A.CallExpr; keys: string[] }>();
    const siteKey = siteKeyer(src);
    const maxCalls = opts.maxCalls ?? 256;
    const vc = (n: any) => {
      if (!n || typeof n !== 'object') return;
      if (Array.isArray(n)) { n.forEach(vc); return; }
      if (n.type === 'CallExpr' && (em.calleeFn(n.callee) === site!.f || (gname && em.globalName(n.callee) === gname))) {
        totalSites++;
        if (n.args.every(staticArg)) {
          const key = JSON.stringify(n.args, (k, v) => (k === 'loc' ? undefined : v));
          const g = byArgs.get(key);
          if (g) g.keys.push(siteKey(n));
          else if (byArgs.size < maxCalls) { const e = { call: n as A.CallExpr, keys: [siteKey(n)] }; byArgs.set(key, e); callSites.push(e); work.push({ node: n.args, own: innerAll(n.args) }); }
          else skippedSites++;
        }
      }
      for (const k of Object.keys(n)) if (k !== 'loc') vc(n[k]);
    };
    vc(chunk);
  }
  // statements that fill a static table after its declaration (`local map = {} for i = 0, 255 do map[string.char(i)] = i end`)
  const populate: A.Stat[] = [];
  const popSeen = new Set<any>();
  const declaredIn = (stmt: any): Set<Binding> => {
    const out = new Set<Binding>();
    const v = (n: any) => { if (!n || typeof n !== 'object') return; if (Array.isArray(n)) { n.forEach(v); return; } if (n.type === 'FunctionExpr') return; if (n.type === 'LocalStat' || n.type === 'LocalFunctionStat' || n.type === 'NumericForStat' || n.type === 'GenericForStat') for (const b of em.bindingsOf(n)) if (b) out.add(b); for (const k of Object.keys(n)) if (k !== 'loc') v(n[k]); };
    v(stmt);
    return out;
  };
  const SAFE_CALL = /^(string|math|bit32|table|utf8)\.|^(ipairs|pairs|tostring|tonumber|select|unpack|type|next|rawset|rawget|rawlen|setmetatable|getmetatable)$/;
  const STR_METHODS = new Set(['sub', 'byte', 'char', 'rep', 'len', 'lower', 'upper', 'find', 'match', 'gmatch', 'gsub', 'format', 'reverse', 'split']);
  const mutates = (stmt: any, b: Binding): boolean => {
    let hit = false;
    const v = (n: any) => {
      if (hit || !n || typeof n !== 'object') return;
      if (Array.isArray(n)) { n.forEach(v); return; }
      if (n.type === 'FunctionExpr') return;
      if (n.type === 'AssignStat') for (const t of n.targets) { const o = t.type === 'IndexExpr' || t.type === 'MemberExpr' ? unparen(t.obj) : null; if (o?.type === 'NameExpr' && em.sc.refOf.get(o) === b) hit = true; }
      if (n.type === 'CallExpr' && em.globalName(n.callee) === 'table.insert' && n.args[0] && unparen(n.args[0]).type === 'NameExpr' && em.sc.refOf.get(unparen(n.args[0]) as A.NameExpr) === b) hit = true;
      for (const k of Object.keys(n)) if (k !== 'loc') v(n[k]);
    };
    v(stmt);
    return hit;
  };
  const safeCallee = (c: A.Expr): boolean => {
    const g = em.globalName(c);
    if (g) return SAFE_CALL.test(g);
    if (em.calleeFn(c)) return true;
    const u = unparen(c);
    if (u.type === 'NameExpr') { const b = em.sc.refOf.get(u); const i = b && b.kind !== 'global' ? initOf(b) : undefined; const gi = i ? em.globalName(i) : null; return !!gi && SAFE_CALL.test(gi); }
    return false;
  };
  const staticStat = (stmt: any): boolean => {
    const local = declaredIn(stmt);
    let ok = true;
    const v = (n: any) => {
      if (!ok || !n || typeof n !== 'object') return;
      if (Array.isArray(n)) { n.forEach(v); return; }
      if (n.type === 'FunctionExpr' || n.type === 'ReturnStat' || n.type === 'GotoStat' || n.type === 'VarargLit') { ok = false; return; }
      if (n.type === 'CallExpr' && !safeCallee(n.callee)) { ok = false; return; }
      if (n.type === 'MethodCallExpr' && !STR_METHODS.has(n.method)) { ok = false; return; }
      if (n.type === 'NameExpr') { const b = em.sc.refOf.get(n); if (b && b.kind !== 'global' && !local.has(b) && b.kind !== 'localfn') { const i = initOf(b); if (!i || !isStaticInit(i)) { ok = false; return; } } }
      for (const k of Object.keys(n)) if (k !== 'loc') v(n[k]);
    };
    v(stmt);
    return ok;
  };
  const addPopulators = (b: Binding) => {
    const blk = blockOf.get(b.decl);
    if (!blk) return;
    // read-only aliases of the table (`local t2 = t` … `t2[i] = decode(t2[i])`) mutate it too
    const aliases = em.sc.bindings.filter(a => a !== b && a.kind === 'local' && a.writes === 0 && a.init && unparen(a.init).type === 'NameExpr' && em.sc.refOf.get(unparen(a.init) as A.NameExpr) === b);
    for (let i = blk.indexOf(b.decl) + 1; i < blk.length; i++) {
      const st = blk[i];
      if (popSeen.has(st) || !(mutates(st, b) || aliases.some(a => mutates(st, a))) || !staticStat(st)) continue;
      popSeen.add(st);
      populate.push(st);
      work.push({ node: st, own: innerAll(st), exclude: declaredIn(st) });
    }
  };
  const gSeen = new Set<string>();
  const gValues: Array<{ name: string; init: A.Expr; line: number }> = [];
  const gFns: Array<{ name: string; site: FnSite }> = [];
  const globalsIn = (node: any): string[] => {
    const out = new Set<string>();
    const v = (n: any) => { if (!n || typeof n !== 'object') return; if (Array.isArray(n)) { n.forEach(v); return; } if (n.type === 'NameExpr' && !GLOBAL_MAP[n.name]) { const b = em.sc.refOf.get(n); if (!b || b.kind === 'global') out.add(n.name); } for (const k of Object.keys(n)) if (k !== 'loc') v(n[k]); };
    v(node);
    return [...out];
  };
  while (work.length) {
    const { node, own, exclude } = work.pop()!;
    for (const g of globalsIn(node)) {
      if (gSeen.has(g)) continue;
      gSeen.add(g);
      const w = gWrites.get(g);
      if (!w || w.length !== 1) continue;
      // defined at runtime by code we already extract (e.g. a global function declared inside the target)
      if ([site, ...fnSites].some(x => inner(x.f).has(w[0].inFn))) continue;
      if (w[0].fn) { const fs = sites.find(x => x.f === w[0].fn); if (fs && fs !== site) { fnSites.push(fs); gFns.push({ name: g, site: fs }); work.push({ node: fs.f, own: inner(fs.f) }); } }
      else if (w[0].value && isStaticInit(w[0].value)) { gValues.push({ name: g, init: w[0].value, line: w[0].line }); work.push({ node: w[0].value, own: innerAll(w[0].value) }); }
    }
    for (const b of freeOf(node, own, exclude)) {
      if (seen.has(b)) continue;
      seen.add(b);
      em.moduleLevel.add(b);
      const ds = sites.find(s => s.binding === b && (b.kind === 'localfn' || b.writes === 0));
      if (ds) { fnSites.push(ds); work.push({ node: ds.f, own: inner(ds.f) }); continue; }
      const init = initOf(b);
      if (init && isStaticInit(init)) { values.push({ b, init }); work.push({ node: init, own: unparen(init).type === 'FunctionExpr' ? inner(unparen(init)) : innerAll(init) }); if (unparen(init).type === 'TableExpr') addPopulators(b); }
      else values.push({ b });
    }
  }
  return { chunk, em, site, sites, fnSites, values, gValues, gFns, populate, callSites, totalSites, skippedSites, initOf };
}

export function functionToPython(src: string, query: string | number, opts: PyOptions = {}): PyFunctionResult | null {
  const cl = sliceClosure(src, query, opts);
  if (!cl) return null;
  const { em, site, fnSites, values, gValues, gFns, populate, callSites, totalSites, skippedSites } = cl;
  if (site.binding) em.moduleLevel.add(site.binding);
  for (const s of fnSites) if (s.binding) em.moduleLevel.add(s.binding);
  em.depth = 0;
  const deps: string[] = [];
  const ordered = [...fnSites.slice(1)].sort((a, b) => a.line - b.line);
  ordered.push(site);
  if (ordered.length > 1) em.out.push('# ---- helper functions it depends on ----');
  let targetName = '';
  for (const s of ordered) {
    const nm = s.binding ? em.nameOf(s.binding) : em.fresh(s.name === '<anonymous>' ? 'fn_L' + s.line : s.name);
    if (s !== site) deps.push(nm); else targetName = nm;
    if (s === site) em.out.push('', '', '# ---- target function (L' + s.line + ') ----');
    em.func(nm, s.f, false);
    const gf = gFns.find(x => x.site === s);
    if (gf) em.out.push(`G[${pyStr(gf.name)}] = ${nm}  # global function`);
    em.out.push('');
  }
  em.out.push('', '# ---- free variables (upvalues + globals of the original script, in source order) ----');
  const entries: Array<{ line: number; emit: () => void }> = [
    ...values.map(({ b, init }) => ({ line: init && !b.init ? (init.loc?.line ?? b.line) : b.line, emit: () => {
      if (init) em.line(em.nameOf(b) + ' = ' + em.ex(init)[0] + '  # L' + b.line + (b.init && b.writes ? ' (initial value; reassigned ' + b.writes + 'x)' : !b.init ? ' (assigned once after its declaration)' : ''));
      else em.line(em.nameOf(b) + ' = None  # TODO: upvalue `' + b.name + '` (L' + b.line + ', written ' + b.writes + 'x) - set before calling');
    } })),
    ...gValues.map(g => ({ line: g.line, emit: () => em.line(`G[${pyStr(g.name)}] = ${em.ex(g.init)[0]}  # L${g.line} global, assigned once`) })),
    ...populate.map(st => ({ line: st.loc?.line ?? 0, emit: () => { em.out.push(`# L${st.loc?.line ?? '?'}: fills a table used above`); em.depth = 0; em.stat(st); if (em.pre.length) { em.out.push(...em.pre); em.pre = []; } } })),
  ];
  entries.sort((a, b) => a.line - b.line).forEach(e => e.emit());
  if (!values.length && !gValues.length) em.out.push('# (none)');
  const target = targetName;
  em.out.push('', '', "if __name__ == '__main__':");
  if (callSites.length) {
    const nSites = callSites.reduce((n, c) => n + c.keys.length, 0);
    em.out.push(
      `    # ${nSites} of ${totalSites} call site(s) of ${target} have statically known arguments (${callSites.length} distinct argument lists${skippedSites ? `, ${skippedSites} more skipped — raise max_calls` : ''}).`,
      '    # Every result is stored under its call-site key "L<line>:<col>" and printed as ONE JSON object',
      '    # (non-text strings as {"$bytes": hex}).  Save it:  python3 this_file.py out.json',
      '    #   → PRISM inline_values puts the values back into the Lua source; chunk_disasm disassembles a dumped VM chunk.',
      '    import sys',
      '    _sites = {}',
      '',
      '    def _site(keys, fn):',
      '        try:',
      '            v = fn()',
      '            if isinstance(v, Multi):',
      "                v = v[0] if len(v) == 1 else None if len(v) == 0 else {'$multi': list(v)}",
      '        except Exception as e:  # one failing call must not hide the others',
      "            v = {'$error': '%s: %s' % (type(e).__name__, e)}",
      '        for k in keys:',
      '            _sites[k] = v',
      '');
    em.depth = 1;
    callSites.forEach(c => {
      const args = c.call.args.map(a => em.ex(a)[0]);
      if (em.pre.length) { em.out.push(...em.pre.map(l => l)); em.pre = []; }
      em.line(`_site(${JSON.stringify(c.keys)}, lambda: ${target}(${args.join(', ')}))`);
    });
    em.depth = 0;
    em.out.push('', '    _out = sys.argv[1] if len(sys.argv) > 1 else None', '    lua_dump(_sites, _out)', "    if _out:", "        print('saved %d call-site results to %s' % (len(_sites), _out))");
  } else em.out.push(`    # no call site with static arguments found — call it yourself, e.g. lua_dump(${target}(...))`, '    pass');
  const header = opts.prelude === false ? '' : PY_PRELUDE + '\n\n';
  return { code: header + em.out.join('\n') + '\n', warnings: em.warnings, freeNames: values.filter(v => !v.init).map(v => em.nameOf(v.b)), name: target, line: site.line, deps };
}
