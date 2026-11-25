// Value re-injection: replace call sites with the values your Python port computed for them.
// The Python __main__ produced by functionToPython keys every result by its call site "L<line>:<col>" (position of the
// call's first character); this pass parses the same source, finds those calls and splices literal values in place —
// formatting of the rest of the file is preserved. Static: the values come from the user, nothing is executed here.
import type * as A from '../ast.js';
import { parse } from '../parser.js';
import { lex, T } from '../lexer.js';
import { print } from '../printer.js';

const unparen = (e: any): any => { while (e && e.type === 'ParenExpr') e = e.expr; return e; };
/** offset of the first character of an expression (suffixed expressions carry the loc of their suffix token) */
export function exprStart(e: any): number {
  if (!e) return 0;
  switch (e.type) {
    case 'MemberExpr': case 'IndexExpr': case 'MethodCallExpr': return exprStart(e.obj);
    case 'CallExpr': return exprStart(e.callee);
    case 'BinExpr': return exprStart(e.left);
    default: return e.loc?.start ?? 0;
  }
}
/** offset → 1-based line/col */
export function lineIndex(src: string) {
  const starts = [0];
  for (let i = 0; i < src.length; i++) if (src.charCodeAt(i) === 10) starts.push(i + 1);
  return (off: number) => { let lo = 0, hi = starts.length - 1; while (lo < hi) { const m = (lo + hi + 1) >> 1; if (starts[m] <= off) lo = m; else hi = m - 1; } return { line: lo + 1, col: off - starts[lo] + 1 }; };
}
/** "L<line>:<col>" key of a call expression */
export function siteKeyer(src: string) {
  const lc = lineIndex(src);
  return (call: any) => { const p = lc(exprStart(call)); return `L${p.line}:${p.col}`; };
}

export interface InlineOptions {
  /** longest literal to inject (default 4000 chars) */
  maxLen?: number;
  /** also inject tables as table constructors (default true) */
  tables?: boolean;
  /** only replace calls whose callee text is this (e.g. "decode" or "fn12") */
  callee?: string;
}
export interface InlineResult {
  code: string;
  replaced: Array<{ key: string; line: number; callee: string; literal: string }>;
  skipped: Array<{ key: string; reason: string }>;
}

const isIdent = (s: string) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(s) && !/^(and|break|do|else|elseif|end|false|for|function|goto|if|in|local|nil|not|or|repeat|return|then|true|until|while|continue)$/.test(s);
function luaString(bytes: string): string {
  let out = '"';
  for (let i = 0; i < bytes.length; i++) {
    const c = bytes.charCodeAt(i);
    const nx = bytes.charCodeAt(i + 1);
    if (c === 34) out += '\\"'; else if (c === 92) out += '\\\\'; else if (c === 10) out += '\\n'; else if (c === 13) out += '\\r'; else if (c === 9) out += '\\t';
    else if (c >= 32 && c < 127) out += bytes[i];
    else out += '\\' + (nx >= 48 && nx <= 57 ? String(c & 255).padStart(3, '0') : String(c & 255));
  }
  return out + '"';
}
const hexLatin1 = (h: string) => { let s = ''; for (let i = 0; i + 1 < h.length; i += 2) s += String.fromCharCode(parseInt(h.slice(i, i + 2), 16)); return s; };
/** JSON value (lua_dump encoding) → Lua literal source, or a reason why it cannot be inlined */
export function jsonToLua(v: unknown, opts: { tables?: boolean } = {}, depth = 0): { lua?: string; why?: string } {
  if (v === null || v === undefined) return { lua: 'nil' };
  if (typeof v === 'boolean') return { lua: String(v) };
  if (typeof v === 'number') return { lua: Number.isNaN(v) ? '(0/0)' : v === Infinity ? 'math.huge' : v === -Infinity ? '(-math.huge)' : v < 0 || Object.is(v, -0) ? `(${Object.is(v, -0) ? '-0' : String(v)})` : String(v) };
  if (typeof v === 'string') return v === '<function>' || v === '<cycle>' ? { why: `value is ${v}` } : { lua: luaString(v) };
  if (typeof v === 'object') {
    const o = v as Record<string, unknown>;
    if (!Array.isArray(o) && typeof o.$bytes === 'string' && Object.keys(o).length === 1) return { lua: luaString(hexLatin1(o.$bytes as string)) };
    if (!Array.isArray(o) && '$error' in o) return { why: 'the call raised ' + String(o.$error).slice(0, 120) };
    if (!Array.isArray(o) && '$multi' in o) return { why: 'multiple return values' };
    if (opts.tables === false) return { why: 'table value (tables disabled)' };
    if (depth > 12) return { why: 'table nested too deeply' };
    const parts: string[] = [];
    if (Array.isArray(o)) for (const x of o) { const r = jsonToLua(x, opts, depth + 1); if (r.why) return r; parts.push(r.lua!); }
    else for (const [k, x] of Object.entries(o)) {
      const r = jsonToLua(x, opts, depth + 1); if (r.why) return r;
      const key = /^-?\d+$/.test(k) ? `[${k}]` : isIdent(k) ? k : `[${luaString(k)}]`;
      parts.push(`${key} = ${r.lua}`);
    }
    return { lua: '{' + parts.join(', ') + '}' };
  }
  return { why: 'unsupported value' };
}

/** replace calls keyed "L<line>:<col>" by the given values */
export function inlineValues(src: string, values: Record<string, unknown>, opts: InlineOptions = {}): InlineResult {
  const { chunk } = parse(src);
  const key = siteKeyer(src);
  const maxLen = opts.maxLen ?? 4000;
  const parentOf = new Map<any, any>();
  const calls = new Map<string, any>();
  const visit = (n: any, parent: any) => {
    if (!n || typeof n !== 'object') return;
    if (Array.isArray(n)) { n.forEach(x => visit(x, parent)); return; }
    if (typeof n.type === 'string') { parentOf.set(n, parent); if (n.type === 'CallExpr' || n.type === 'MethodCallExpr') { const k = key(n); if (!calls.has(k)) calls.set(k, n); } }
    for (const k of Object.keys(n)) if (k !== 'loc') visit(n[k], typeof n.type === 'string' ? n : parent);
  };
  visit(chunk, null);
  // token index by start offset → find each call's closing bracket
  const { tokens } = lex(src);
  const tokAt = new Map<number, number>();
  tokens.forEach((t, i) => tokAt.set(t.start, i));
  const callEnd = (c: any): number | null => {
    let i = tokAt.get(c.loc?.start);
    if (i === undefined) return null;
    if (c.type === 'MethodCallExpr') { while (i < tokens.length && !(tokens[i].type === T.Punct && tokens[i].value === '(') && tokens[i].type !== T.String && !(tokens[i].type === T.Punct && tokens[i].value === '{')) i++; }
    const t = tokens[i];
    if (!t) return null;
    if (t.type === T.String || t.type === T.InterpString) return t.end;
    const open = t.value, close = open === '(' ? ')' : open === '{' ? '}' : null;
    if (!close) return null;
    let depth = 0;
    for (let j = i; j < tokens.length; j++) {
      const x = tokens[j];
      if (x.type !== T.Punct) continue;
      if (x.value === '(' || x.value === '{' || x.value === '[') depth++;
      else if (x.value === ')' || x.value === '}' || x.value === ']') { depth--; if (depth === 0) return x.value === close ? x.end : null; }
    }
    return null;
  };
  const replaced: InlineResult['replaced'] = [], skipped: InlineResult['skipped'] = [];
  const edits: Array<{ start: number; end: number; text: string; key: string }> = [];
  for (const [k, v] of Object.entries(values)) {
    if (!/^L\d+:\d+$/.test(k)) { skipped.push({ key: k, reason: 'not a call-site key (expected "L<line>:<col>")' }); continue; }
    const c = calls.get(k);
    if (!c) { skipped.push({ key: k, reason: 'no call starts at this position — is this the same source the Python port was generated from?' }); continue; }
    const calleeText = (() => { try { return print((c.type === 'CallExpr' ? c.callee : c.obj) as any).replace(/\s+/g, ' ').slice(0, 60) + (c.type === 'MethodCallExpr' ? ':' + c.method : ''); } catch { return '?'; } })();
    if (opts.callee && calleeText !== opts.callee && !calleeText.endsWith('.' + opts.callee)) { skipped.push({ key: k, reason: `callee ${calleeText} ≠ ${opts.callee}` }); continue; }
    const r = jsonToLua(v, { tables: opts.tables });
    if (r.why) { skipped.push({ key: k, reason: r.why }); continue; }
    let lit = r.lua!;
    if (lit.length > maxLen) { skipped.push({ key: k, reason: `literal too long (${lit.length} > ${maxLen} chars)` }); continue; }
    const p = parentOf.get(c);
    const prefix = p && (((p.type === 'MemberExpr' || p.type === 'IndexExpr' || p.type === 'MethodCallExpr') && p.obj === c) || (p.type === 'CallExpr' && p.callee === c));
    if (prefix && !lit.startsWith('(')) lit = `(${lit})`;
    const start = exprStart(c), end = callEnd(c);
    if (end === null || end <= start) { skipped.push({ key: k, reason: 'could not delimit the call in the source' }); continue; }
    edits.push({ start, end, text: lit, key: k });
    replaced.push({ key: k, line: c.loc?.line ?? 0, callee: calleeText, literal: lit.length > 80 ? lit.slice(0, 79) + '…' : lit });
  }
  // drop edits nested inside another replaced call, then splice from the end
  edits.sort((a, b) => a.start - b.start || b.end - a.end);
  const kept: typeof edits = [];
  for (const e of edits) { const last = kept[kept.length - 1]; if (last && e.start < last.end) { skipped.push({ key: e.key, reason: 'inside another replaced call' }); const i = replaced.findIndex(r => r.key === e.key); if (i >= 0) replaced.splice(i, 1); continue; } kept.push(e); }
  let code = src;
  for (let i = kept.length - 1; i >= 0; i--) code = code.slice(0, kept[i].start) + kept[i].text + code.slice(kept[i].end);
  void unparen;
  return { code, replaced, skipped };
}
export type { A };
