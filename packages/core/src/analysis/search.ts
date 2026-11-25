// PRISM structural search + cross references.
//
// Pattern syntax (any Luau expression or statement list):
//   $X      metavariable: matches any expression / name; repeated $X must match equal code
//   $_      wildcard (no binding)
//   $$$     ellipsis: any number of call arguments / table items / statements
// Examples:  string.char($$$)    $T[$K] = $T[$K] + 1    local $A = $F($$$)    bit32.bxor($X, $X)
import type * as A from '../ast.js';
import { walk } from '../ast.js';
import { parse } from '../parser.js';
import { print } from '../printer.js';
import { analyzeScopes } from './scope.js';

const MV = '__prism_mv_';
const ELL = '__prism_ellipsis__';

export interface PatternMatch { line: number; col: number; start: number; end: number; text: string; bindings: Record<string, string>; }
export interface PatternResult { kind: 'expr' | 'stat'; matches: PatternMatch[]; total: number; error?: string; }

function prep(pattern: string): string {
  return pattern
    .replace(/\$\$\$/g, ELL + '()')
    .replace(/\$([A-Za-z_][A-Za-z0-9_]*)/g, (_m, n) => MV + n);
}

const isEllCall = (e: any) => e && e.type === 'CallExpr' && e.callee?.type === 'NameExpr' && e.callee.name === ELL && !e.args.length;
const isEll = (n: any) => n && ((n.type === 'NameExpr' && n.name === ELL) || isEllCall(n) || (n.type === 'CallStat' && isEllCall(n.expr)));
const unparen = (e: any): any => { while (e && e.type === 'ParenExpr') e = e.expr; return e; };

function same(a: any, b: any): boolean {
  a = unparen(a); b = unparen(b);
  if (a === b) return true;
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object') return a === b;
  if (Array.isArray(a)) { if (!Array.isArray(b) || a.length !== b.length) return false; for (let i = 0; i < a.length; i++) if (!same(a[i], b[i])) return false; return true; }
  if (a.type !== b.type) return false;
  if (a.type === 'NumberLit') return a.value === b.value;
  for (const k of Object.keys(a)) { if (k === 'loc' || k === 'raw') continue; if (!same(a[k], b[k])) return false; }
  return true;
}

function m(p: any, n: any, env: Map<string, any>): boolean {
  if (p && p.type === 'ParenExpr' && !(n && n.type === 'ParenExpr')) p = unparen(p);
  if (n && n.type === 'ParenExpr' && !(p && p.type === 'ParenExpr')) n = unparen(n);
  if (p && typeof p === 'object' && p.type === 'NameExpr' && p.name.startsWith(MV)) {
    if (!n || typeof n !== 'object' || !n.type) return false;
    const name = p.name.slice(MV.length);
    if (name === '_') return true;
    const prev = env.get(name);
    if (typeof prev === 'string') return n.type === 'NameExpr' && n.name === prev;
    if (prev) return same(prev, n);
    env.set(name, n); return true;
  }
  if (typeof p === 'string' && p.startsWith(MV)) {   // metavariable in a name slot (local $X = ...)
    if (typeof n !== 'string') return false;
    const name = p.slice(MV.length);
    if (name === '_') return true;
    const prev = env.get(name);
    if (prev !== undefined) return (typeof prev === 'string' ? prev : prev.type === 'NameExpr' ? prev.name : null) === n;
    env.set(name, n); return true;
  }
  if (Array.isArray(p)) return Array.isArray(n) && mList(p, 0, n, 0, env);
  if (!p || typeof p !== 'object') return p === n;
  if (!n || typeof n !== 'object' || p.type !== n.type) {
    // `$X` in a member slot: a.$X  ~ name strings handled above; method names too
    return false;
  }
  if (p.type === 'NumberLit') return p.value === n.value;
  for (const k of Object.keys(p)) {
    if (k === 'loc' || k === 'raw') continue;
    if (!m(p[k], n[k], env)) return false;
  }
  return true;
}
function mList(p: any[], i: number, n: any[], j: number, env: Map<string, any>): boolean {
  if (i === p.length) return j === n.length;
  const pi = p[i];
  const ell = isEll(pi) || (pi && pi.kind === 'item' && isEll(pi.value));
  if (ell) {
    for (let k = j; k <= n.length; k++) {
      const snap = new Map(env);
      if (mList(p, i + 1, n, k, env)) return true;
      env.clear(); for (const [a, b] of snap) env.set(a, b);
    }
    return false;
  }
  if (j >= n.length) return false;
  const snap = new Map(env);
  if (m(pi, n[j], env) && mList(p, i + 1, n, j + 1, env)) return true;
  env.clear(); for (const [a, b] of snap) env.set(a, b);
  return false;
}

function lineCol(src: string, pos: number): { line: number; col: number } {
  let line = 1, last = -1;
  for (let i = 0; i < pos && i < src.length; i++) if (src.charCodeAt(i) === 10) { line++; last = i; }
  return { line, col: pos - last };
}

const show = (v: any): string => typeof v === 'string' ? v : v.type && /Stat$/.test(v.type) ? print({ type: 'Chunk', body: [v] }).trim() : print({ type: 'Chunk', body: [{ type: 'ReturnStat', args: [v] }] }).trim().replace(/^return\s+/, '').replace(/;$/, '');

/** structural AST search. `src` must be the code the positions refer to. */
export function searchPattern(src: string, pattern: string, opts: { max?: number; kind?: 'auto' | 'expr' | 'stat' } = {}): PatternResult {
  const max = opts.max ?? 500;
  const pp = prep(pattern.trim());
  let kind: 'expr' | 'stat' = 'expr';
  let pnode: any = null;
  const asStat = parse(pp);
  if (!asStat.errors.length && asStat.chunk.body.length) {
    const b = asStat.chunk.body;
    // a lone call is searched as an expression (also matches nested calls)
    if (opts.kind !== 'stat' && b.length === 1 && b[0].type === 'CallStat' && !isEll(b[0])) pnode = (b[0] as A.CallStat).expr;
    else if (opts.kind !== 'expr') { kind = 'stat'; pnode = b; }
  }
  if (!pnode) {
    const r = parse('local __prism_x__ = (' + pp + '\n)');
    const ls = r.chunk.body[0] as A.LocalStat | undefined;
    if (r.errors.length || r.chunk.body.length !== 1 || ls?.type !== 'LocalStat' || ls.init.length !== 1) {
      return { kind: 'expr', matches: [], total: 0, error: 'pattern parse error: ' + (asStat.errors[0]?.message ?? r.errors[0]?.message ?? 'not an expression or statement list') };
    }
    pnode = unparen(ls.init[0]); kind = 'expr';
  }
  const { chunk } = parse(src);
  const matches: PatternMatch[] = [];
  let total = 0;
  const record = (node: any, env: Map<string, any>, endNode?: any) => {
    total++;
    if (matches.length >= max) return;
    const start = node.loc?.start ?? 0;
    const lc = lineCol(src, start);
    const lineEnd = src.indexOf('\n', start);
    const b: Record<string, string> = {};
    for (const [k, v] of env) b[k] = show(v).slice(0, 300);
    const text = show(endNode ? node : node).split('\n').slice(0, 6).join('\n');
    matches.push({ line: node.loc?.line ?? lc.line, col: lc.col, start, end: endNode?.loc?.end ?? (lineEnd < 0 ? src.length : lineEnd), text: text.slice(0, 600), bindings: b });
  };
  if (kind === 'expr') {
    walk(chunk, (n: any) => {
      if (!n.type || /Stat$/.test(n.type) || n.type === 'Chunk') return;
      const env = new Map<string, any>();
      if (m(pnode, n, env)) record(n, env);
    });
  } else {
    const plist = pnode as any[];
    const visitList = (list: A.Stat[]) => {
      for (let i = 0; i < list.length; i++) {
        // try every window start; ellipsis lets the window grow
        const hasEll = plist.some(isEll);
        for (let len = hasEll ? list.length - i : Math.min(plist.length, list.length - i); len >= 1; len--) {
          const env = new Map<string, any>();
          if (mList(plist, 0, list.slice(i, i + len), 0, env)) { record(list[i], env, list[i + len - 1]); break; }
          if (!hasEll) break;
        }
      }
    };
    walk(chunk, (n: any) => {
      for (const k of ['body', 'elseBody']) if (Array.isArray(n[k]) && n[k].length && n[k][0]?.type && /Stat$/.test(n[k][0].type)) visitList(n[k]);
      if (n.type === 'IfStat') for (const c of n.clauses) visitList(c.body);
    });
  }
  matches.sort((a, b) => a.start - b.start);
  return { kind, matches, total };
}

export interface XrefRef { line: number; col: number; kind: 'read' | 'write' | 'decl'; text: string; }
export interface XrefBinding { name: string; kind: string; line: number; reads: number; writes: number; captured: boolean; refs: XrefRef[]; }

/** scope-aware references of every binding called `name` (optionally only the one visible at `line`) */
export function xrefs(src: string, name: string, opts: { line?: number; max?: number } = {}): XrefBinding[] {
  const { chunk } = parse(src);
  const sc = analyzeScopes(chunk);
  const lines = src.split('\n');
  const text = (l: number) => (lines[l - 1] ?? '').trim().slice(0, 200);
  const lineStart: number[] = [0];
  for (let i = 0; i < src.length; i++) if (src.charCodeAt(i) === 10) lineStart.push(i + 1);
  const colOf = (pos: number, line: number) => pos - (lineStart[line - 1] ?? 0) + 1;
  const declCol = (line: number, nm: string, from?: number) => {
    const raw = lines[line - 1] ?? '';
    const startCol = from !== undefined && from >= (lineStart[line - 1] ?? 0) ? from - (lineStart[line - 1] ?? 0) : 0;
    const re = new RegExp('(^|[^A-Za-z0-9_])' + nm.replace(/[^A-Za-z0-9_]/g, '') + '(?![A-Za-z0-9_])', 'g');
    re.lastIndex = Math.max(0, startCol - 1);
    const m = re.exec(raw) ?? (re.lastIndex = 0, re.exec(raw));
    return m ? m.index + m[1].length + 1 : 1;
  };
  let cands = sc.bindings.filter(b => b.name === name);
  const globals = [...sc.refOf.entries()].filter(([n, b]) => b.kind === 'global' && n.name === name);
  const out: XrefBinding[] = [];
  if (opts.line !== undefined) {
    // binding whose reference/declaration sits on that line, else nearest declaration above
    const onLine = cands.filter(b => b.line === opts.line || b.refs.some(r => r.loc?.line === opts.line));
    cands = onLine.length ? onLine : cands.filter(b => b.line <= opts.line!).sort((a, b) => b.line - a.line).slice(0, 1);
  }
  const max = opts.max ?? 2000;
  for (const b of cands) {
    const writes = new Set(b.writeRefs);
    const refs: XrefRef[] = [{ line: b.line, col: declCol(b.line, b.name, b.decl?.loc?.start), kind: 'decl', text: text(b.line) }];
    for (const r of b.refs) { if (refs.length >= max) break; const l = r.loc?.line ?? 0; refs.push({ line: l, col: colOf(r.loc?.start ?? 0, l), kind: writes.has(r) ? 'write' : 'read', text: text(l) }); }
    out.push({ name: b.name, kind: b.kind, line: b.line, reads: b.reads, writes: b.writes, captured: b.captured, refs });
  }
  if (globals.length && (!cands.length || opts.line === undefined)) {
    const refs: XrefRef[] = globals.slice(0, max).map(([n]) => { const l = n.loc?.line ?? 0; return { line: l, col: colOf(n.loc?.start ?? 0, l), kind: 'read' as const, text: text(l) }; });
    out.push({ name, kind: 'global', line: 0, reads: globals.length, writes: 0, captured: false, refs });
  }
  return out;
}
