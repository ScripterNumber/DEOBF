// Emit the dump records a residual program references (`K_n` constant tables, `PROTO_n` proto
// records) as plain Lua literals, so the devirtualised output is self-contained and runnable.
//
// Until now vm_specialize only *named* those records (`K_4294`) — the names were placeholders and the
// lifted file could not run without an external harness providing them. This module closes that gap:
// it scans the emitted code for the names actually used and writes one `local K_x = { … }` per record,
// skipping records that cannot be expressed as data (functions, byte buffers) and capping the volume so
// a payload-sized record cannot turn into a 100 MB file.
import { LuaDump, numRaw } from './dump.js';

export interface EmitRecordsOptions {
  /** deepest nested table written as data (deeper ones become nil); default 6 */
  maxDepth?: number;
  /** most entries written per record (the rest become nil); default 200000 */
  maxItems?: number;
  /** overall budget of written values across every record; default 400000 */
  maxTotal?: number;
}

export interface EmitRecordsResult {
  /** Lua source of the record definitions: `local <holder> = {}` + `<holder>[key] = …` lines */
  lua: string;
  /** names actually defined */
  emitted: string[];
  /** referenced but not emitted, with the reason */
  skipped: Array<{ name: string; why: string }>;
}

const NAME_RE = /\b((?:K|PROTO)_[A-Za-z0-9_.]+)/g;

function luaString(s: string): string {
  let out = '"';
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 34) out += '\\"';
    else if (c === 92) out += '\\\\';
    else if (c === 10) out += '\\n';
    else if (c === 13) out += '\\r';
    else if (c === 9) out += '\\t';
    else if (c < 32 || c === 127) out += '\\' + String(c).padStart(3, '0');
    else if (c > 126) out += '\\' + String(c & 255).padStart(3, '0');
    else out += s[i];
  }
  return out + '"';
}

function luaNumber(v: number): string {
  if (Number.isNaN(v)) return '(0/0)';
  if (v === Infinity) return '(1/0)';
  if (v === -Infinity) return '(-1/0)';
  return numRaw(v);
}

function luaKey(k: number | string): string {
  if (typeof k === 'number' && Number.isInteger(k) && k >= 0) return '';
  return '[' + (typeof k === 'number' ? luaNumber(k) : luaString(k)) + '] = ';
}

/** library globals a `$fn` record may name; anything else (obfuscator closures, lambdas) is not data */
const LIB_GLOBALS = new Set(['type', 'select', 'next', 'pairs', 'ipairs', 'pcall', 'xpcall', 'error', 'assert', 'tonumber', 'tostring', 'rawget', 'rawset', 'rawequal', 'rawlen', 'setmetatable', 'getmetatable', 'unpack', 'setfenv', 'getfenv', 'loadstring', 'load', 'require', 'print', 'unpack', 'newproxy', 'gcinfo', 'collectgarbage', 'tick', 'wait', 'spawn', 'delay', 'warn', 'typeof']);
const LIB_TABLES = new Set(['string', 'table', 'math', 'bit32', 'buffer', 'coroutine', 'os', 'utf8', 'debug', 'vector', 'task']);

/** `$fn` → the global path it names, when it is a library function */
function fnPath(name: string): string | null {
  if (LIB_GLOBALS.has(name)) return name;
  const m = /^([A-Za-z_][A-Za-z0-9_]*)((?:\.[A-Za-z_][A-Za-z0-9_]*)+)$/.exec(name);
  if (!m || !LIB_TABLES.has(m[1])) return null;
  return name;
}

/** one dump value as a Lua literal; `null` when it cannot be data */
export function luaForValue(dump: LuaDump, v: unknown, options: EmitRecordsOptions = {}): string | null {
  const o: Required<EmitRecordsOptions> = { maxDepth: options.maxDepth ?? 6, maxItems: options.maxItems ?? 200000, maxTotal: options.maxTotal ?? 400000 };
  return valueToLua(dump, v, 0, o, { left: o.maxTotal });
}

/** one dump value as a Lua literal; `null` when it cannot be data */
function valueToLua(dump: LuaDump, v: unknown, depth: number, o: Required<EmitRecordsOptions>, budget: { left: number }): string | null {
  if (budget.left <= 0) return null;
  const sc = dump.scalar(v);
  switch (sc.kind) {
    case 'nil': return 'nil';
    case 'bool': return sc.value ? 'true' : 'false';
    case 'num': budget.left--; return luaNumber(sc.value);
    case 'str': budget.left--; return luaString(sc.value);
    case 'fn': { const p = fnPath(sc.name); if (p) { budget.left--; return p; } return null; }
    case 'buffer': return null;
    case 'table': break;
  }
  if (depth >= o.maxDepth) return null;
  const t = dump.deref(v);
  const parts: string[] = [];
  let n = 0;
  for (const [k, e] of dump.entries(t)) {
    if (n >= o.maxItems) break;
    const s = valueToLua(dump, e, depth + 1, o, budget);
    if (s === null) continue;
    parts.push(luaKey(k) + s);
    n++;
  }
  return '{' + parts.join(', ') + '}';
}

/** record definitions for every `K_*` / `PROTO_*` name the code mentions, inside one holder table */
export function emitRecordTables(code: string, constNames: Map<string, unknown>, dump: LuaDump, options: EmitRecordsOptions = {}, holder = 'R'): EmitRecordsResult {
  const o: Required<EmitRecordsOptions> = { maxDepth: options.maxDepth ?? 6, maxItems: options.maxItems ?? 200000, maxTotal: options.maxTotal ?? 400000 };
  const seen = new Set<string>();
  for (const m of code.matchAll(NAME_RE)) seen.add(m[1]);
  const emitted: string[] = [];
  const skipped: Array<{ name: string; why: string }> = [];
  const lines: string[] = [];
  const budget = { left: o.maxTotal };
  // numeric ids first, then the proto records, so the file reads in proto order
  const ordered = [...seen].sort((a, b) => {
    const pa = a.startsWith('PROTO_') ? 1 : 0, pb = b.startsWith('PROTO_') ? 1 : 0;
    if (pa !== pb) return pa - pb;
    return Number(/\d+/.exec(a)?.[0] ?? 0) - Number(/\d+/.exec(b)?.[0] ?? 0);
  });
  for (const name of ordered) {
    if (!constNames.has(name)) { skipped.push({ name, why: 'not in the dump' }); continue; }
    if (budget.left <= 0) { skipped.push({ name, why: 'value budget exhausted' }); continue; }
    const v = constNames.get(name);
    const s = valueToLua(dump, v, 0, o, budget);
    if (s === null) { skipped.push({ name, why: dump.isTable(v) ? 'table too deep / not representable as data' : 'value is not data (function or buffer)' }); continue; }
    const key = name.startsWith('PROTO_') ? JSON.stringify('P' + name.slice(6)) : (/^\d+$/.test(name.slice(2)) ? name.slice(2) : JSON.stringify(name.slice(2)));
    lines.push(`${holder}[${key}] = ${s}`);
    emitted.push(name);
  }
  return { lua: lines.length ? [`local ${holder} = {}`, ...lines].join('\n') : '', emitted, skipped };
}

/** number of `K_*` / `PROTO_*` names in a chunk of residual code */
export function countRecordRefs(code: string): number {
  const s = new Set<string>();
  for (const m of code.matchAll(NAME_RE)) s.add(m[1]);
  return s.size;
}

/** `K_7` -> `R[7]`, `PROTO_7` -> `R["P7"]` for the name `R` */
export function recordRef(name: string, holder = 'R'): string {
  const m = /^(K|PROTO)_(.+)$/.exec(name);
  if (!m) return name;
  const key = m[1] === 'K' ? (String(Number(m[2])) === m[2] ? m[2] : JSON.stringify(m[2])) : JSON.stringify('P' + m[2]);
  return `${holder}[${key}]`;
}

/** Rewrite every `K_n` / `PROTO_n` reference to `<holder>[…]` outside strings and comments.
 *  Why: one local per record blows past Luau's 200-upvalue limit on real targets (3339 records here),
 *  while a single holder table costs exactly one upvalue. */
export function rewriteRecordRefs(code: string, holder = 'R'): string {
  let out = '';
  let i = 0;
  const n = code.length;
  while (i < n) {
    const c = code[i];
    // comments
    if (c === '-' && code[i + 1] === '-') {
      if (code[i + 2] === '[') {
        const m = /^--(\[[=]*\[)/.exec(code.slice(i, i + 12));
        if (m) { const close = ']' + m[1].slice(1, -1) + ']'; const e = code.indexOf(close, i + m[0].length); const end = e < 0 ? n : e + close.length; out += code.slice(i, end); i = end; continue; }
      }
      const e = code.indexOf('\n', i); const end = e < 0 ? n : e; out += code.slice(i, end); i = end; continue;
    }
    // strings
    if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < n) { if (code[j] === '\\') { j += 2; continue; } if (code[j] === c) { j++; break; } j++; }
      out += code.slice(i, j); i = j; continue;
    }
    if (c === '[') {
      const m = /^\[([=]*)\[/.exec(code.slice(i, i + 12));
      if (m) { const close = ']' + m[1] + ']'; const e = code.indexOf(close, i + m[0].length); const end = e < 0 ? n : e + close.length; out += code.slice(i, end); i = end; continue; }
    }
    // identifiers
    if (/[A-Za-z_]/.test(c)) {
      let j = i + 1;
      while (j < n && /[A-Za-z0-9_]/.test(code[j])) j++;
      const word = code.slice(i, j);
      // `local K_1 = …` keeps its declaration name; only expressions are rewritten
      if (/^(K|PROTO)_[0-9]+$/.test(word) && !/\blocal\s/.test(out.slice(Math.max(0, out.length - 8)))) out += recordRef(word, holder);
      else out += word;
      i = j; continue;
    }
    out += c; i++;
  }
  return out;
}