// Smart renaming: give every obfuscated local a unique, role-based name
// (fn3, tbl2, str_byte, Players, arg1, i4, k2/v2 ...). Unique names make the
// output collision-free and shadow-free, which also unlocks safe alias passes.
import type * as A from '../ast.js';
import { analyzeScopes, renameBinding, Binding } from '../analysis/scope.js';
import { KEYWORDS } from '../lexer.js';

export type RenameMode = 'none' | 'obfuscated' | 'all';
export interface RenameStats { renamed: number; map: Array<{ from: string; to: string; line: number; kind: string }>; }

const COMMON_OK = new Set(['i', 'j', 'k', 'v', 'n', 'x', 'y', 'z', '_', 'self', 'key', 'value', 'index', 'idx', 'val']);

/** Heuristic: does this identifier look machine-generated / meaningless? */
export function looksObfuscated(name: string): boolean {
  if (COMMON_OK.has(name)) return false;
  if (name.length === 1) return true;
  if (/^[Il1|_]{3,}$/.test(name) || /^[O0o_]{3,}$/.test(name)) return true;
  if (/^_0x[0-9a-f]+$/i.test(name)) return true;
  if (/^[A-Za-z]{1,2}_*\d+_*$/.test(name)) return true;          // v12, L_3_, l__2
  if (/^_+[A-Za-z]?\d*_*$/.test(name) && name !== '_') return true; // __, _1
  if (/^[A-Za-z]{2}$/.test(name)) return true;                   // two-letter minified
  // low-information mixed-case noise (e.g. lIlIIl, IIlIl1)
  if (name.length >= 5 && /^[IlL1i]+$/.test(name)) return true;
  // hex-ish noise: long run without vowels
  if (name.length >= 8 && !/[aeiouAEIOU]/.test(name) && /\d/.test(name)) return true;
  return false;
}

function unparen(e: A.Expr): A.Expr { while (e.type === 'ParenExpr') e = e.expr; return e; }
const ident = (s: string) => s.replace(/[^A-Za-z0-9_]/g, '_').replace(/^(\d)/, '_$1');

function chainName(e: A.Expr): string | null {
  const parts: string[] = [];
  let cur: A.Expr = e;
  while (cur.type === 'MemberExpr') { parts.unshift(cur.name); cur = cur.obj; }
  if (cur.type !== 'NameExpr') return null;
  parts.unshift(cur.name);
  return parts.join('_');
}

function roleOf(b: Binding): string {
  if (b.kind === 'param') return 'arg';
  if (b.kind === 'localfn') return 'fn';
  if (b.kind === 'for') {
    const d = b.decl;
    if (d.type === 'NumericForStat') return 'i';
    const it = d.iters[0] && unparen(d.iters[0]);
    const callee = it && it.type === 'CallExpr' && it.callee.type === 'NameExpr' ? it.callee.name : '';
    if (callee === 'ipairs') return b.index === 0 ? 'idx' : 'val';
    if (callee === 'pairs' || callee === 'next') return b.index === 0 ? 'key' : 'val';
    return b.index === 0 ? 'k' : b.index === 1 ? 'v' : 'it';
  }
  const init = b.init && unparen(b.init);
  if (!init) return 'var';
  switch (init.type) {
    case 'FunctionExpr': return 'fn';
    case 'StringLit': return 'str';
    case 'NumberLit': return 'num';
    case 'TrueLit': case 'FalseLit': return 'flag';
    case 'NilLit': return 'var';
    case 'VarargLit': return 'arg';
    case 'TableExpr': {
      if (!init.fields.length) return 'tbl';
      if (init.fields.length === 1 && init.fields[0].value.type === 'VarargLit') return 'args';
      if (init.fields.every(f => f.kind === 'item')) return 'arr';
      return 'obj';
    }
    case 'MemberExpr': { const c = chainName(init); return c ? '=' + c : 'field'; }
    case 'NameExpr': return '=' + init.name + '_';
    case 'IndexExpr': return 'elem';
    case 'MethodCallExpr': {
      if (init.method === 'GetService' && init.args[0]?.type === 'StringLit') return '=' + ident(init.args[0].value);
      return 'res';
    }
    case 'CallExpr': {
      const c = chainName(init.callee) ?? '';
      if (c === 'require') return 'module';
      if (c === 'setmetatable') return 'obj';
      if (c === 'getfenv' || c === 'getgenv' || c === 'getrenv') return 'env';
      if (c === 'select' && init.args[0]?.type === 'StringLit' && init.args[0].value === '#') return 'argc';
      if (c === 'Instance_new' && init.args[0]?.type === 'StringLit') return '=' + ident(init.args[0].value);
      if (c === 'string_char' || c === 'string_sub' || c === 'tostring' || c === 'table_concat') return 'str';
      if (c === 'tonumber' || c === 'string_byte' || c === 'math_floor' || c.startsWith('bit32_')) return 'num';
      if (c === 'coroutine_wrap' || c === 'loadstring' || c === 'load') return 'fn';
      return 'ret';
    }
    case 'BinExpr':
      if (init.op === '..') return 'str';
      if (['+', '-', '*', '/', '%', '^', '//'].includes(init.op)) return 'num';
      if (['==', '~=', '<', '>', '<=', '>='].includes(init.op)) return 'cond';
      return 'var';
    case 'UnExpr': return init.op === '#' ? 'len' : init.op === 'not' ? 'cond' : 'num';
    default: return 'var';
  }
}

export function smartRename(chunk: A.Chunk, mode: RenameMode = 'obfuscated'): RenameStats {
  const map: RenameStats['map'] = [];
  if (mode === 'none') return { renamed: 0, map };
  const scope = analyzeScopes(chunk);
  const taken = new Set<string>([...scope.globals.keys()]);
  for (const kw of KEYWORDS) taken.add(kw);
  // keep names of bindings we will not rename
  const toRename: Binding[] = [];
  for (const b of scope.bindings) {
    if (b.kind === 'global') continue;
    if (b.name === 'self' && b.kind === 'param') { taken.add(b.name); continue; }
    if (mode === 'obfuscated' && !looksObfuscated(b.name)) { taken.add(b.name); continue; }
    toRename.push(b);
  }
  const counters = new Map<string, number>();
  const fresh = (role: string): string => {
    if (role.startsWith('=')) {
      const base = ident(role.slice(1)) || 'v';
      if (!taken.has(base)) { taken.add(base); return base; }
      let k = 2; while (taken.has(base + '_' + k)) k++;
      taken.add(base + '_' + k); return base + '_' + k;
    }
    let c = counters.get(role) ?? 0, name: string;
    do { c++; name = role + c; } while (taken.has(name));
    counters.set(role, c); taken.add(name); return name;
  };
  for (const b of toRename) {
    const to = fresh(roleOf(b));
    map.push({ from: b.name, to, line: b.line, kind: b.kind });
    renameBinding(b, to);
  }
  return { renamed: map.length, map };
}
