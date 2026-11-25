import { z } from 'zod';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { resolve, basename } from 'node:path';
import { Blob, lex, T } from '@prism/core';
import { decodeText } from './workspace.js';
import type { ToolContext } from './types.js';

export const SRC = {
  script_id: z.string().optional().describe('id of a script stored in the PRISM workspace (preferred for large files; see workspace_list)'),
  path: z.string().optional().describe('path of a Lua/Luau file on the PRISM host'),
  source: z.string().optional().describe('inline Lua/Luau source text'),
};
export const OUT = {
  max_chars: z.number().int().min(200).optional().describe('truncate the text result to this many characters (default 60000). Use save_as to keep everything.'),
  save_as: z.string().optional().describe('also save the full text output as workspace outputs/<save_as>'),
};
export const FORMAT = { format: z.enum(['text', 'json']).optional().describe('text (default, readable) or json (structured data)') };

export interface Src { src: string; label: string; scriptId?: string; encoding: 'utf8' | 'latin1' }
export function readFileChecked(path: string): Buffer {
  const p = resolve(path);
  if (!existsSync(p)) throw new Error(`file not found: ${p}`);
  const st = statSync(p);
  if (!st.isFile()) throw new Error(`not a file: ${p}`);
  if (st.size > 64 * 1024 * 1024) throw new Error(`file too large (${st.size} bytes, limit 64 MiB)`);
  return readFileSync(p);
}
export function getSource(a: { script_id?: string; path?: string; source?: string }, ctx: ToolContext): Src {
  if (a.script_id) { const m = ctx.ws.getMeta(a.script_id); return { src: ctx.ws.getScript(a.script_id), label: `${m.name} [${m.id}]`, scriptId: m.id, encoding: m.encoding ?? 'utf8' }; }
  if (a.path) { const d = decodeText(readFileChecked(a.path)); return { src: d.text, label: basename(a.path), encoding: d.encoding }; }
  if (typeof a.source === 'string') return { src: a.source, label: 'inline source', encoding: 'utf8' };
  throw new Error('provide one of: script_id, path, source');
}

export const BYTES = {
  data: z.string().optional().describe('input bytes as text — see "encoding"'),
  encoding: z.enum(['auto', 'hex', 'base64', 'latin1', 'utf8', 'lua', 'decimal']).optional()
    .describe('how to read "data": hex, base64, latin1 (1 char = 1 byte), utf8, lua (Lua string literal / escapes like \\27\\76), decimal ("27,76,117" or "{27,76}"). auto (default) guesses.'),
  file: z.string().optional().describe('read raw bytes from this file on the PRISM host'),
  output: z.string().optional().describe('read raw bytes from a saved workspace output'),
  from_script: z.string().optional().describe('script_id: take the bytes from a string literal of this workspace script (with string_line / string_index)'),
  string_line: z.number().int().optional().describe('with from_script: pick the longest string literal on this line'),
  string_index: z.number().int().optional().describe('with from_script: pick the N-th string literal (0-based) — default: the longest literal in the script'),
};
export type BytesArgs = { data?: string; encoding?: string; file?: string; output?: string; from_script?: string; string_line?: number; string_index?: number };
export function getBytes(a: BytesArgs, ctx: ToolContext): { bytes: Uint8Array; how: string } {
  if (a.file) return { bytes: new Uint8Array(readFileChecked(a.file)), how: 'file ' + basename(a.file) };
  if (a.output) return { bytes: new Uint8Array(ctx.ws.readOutput(a.output)), how: 'output ' + a.output };
  if (a.from_script) {
    const src = ctx.ws.getScript(a.from_script);
    const strs = lex(src).tokens.filter(t => t.type === T.String);
    if (!strs.length) throw new Error('script has no string literals');
    let t = strs[0];
    if (a.string_index !== undefined) { t = strs[a.string_index]; if (!t) throw new Error(`string_index out of range (0..${strs.length - 1})`); }
    else { const pool = a.string_line !== undefined ? strs.filter(s => s.line === a.string_line) : strs; if (!pool.length) throw new Error('no string literal on line ' + a.string_line); t = pool.reduce((x, y) => (y.cooked?.length ?? 0) > (x.cooked?.length ?? 0) ? y : x); }
    return { bytes: Blob.latin1(t.cooked ?? ''), how: `string literal at line ${t.line} (${(t.cooked ?? '').length} bytes)` };
  }
  if (typeof a.data !== 'string') throw new Error('provide one of: data, file, output, from_script');
  return { bytes: decodeBytes(a.data, a.encoding ?? 'auto'), how: 'data (' + (a.encoding ?? 'auto') + ')' };
}
export function decodeBytes(d: string, enc: string): Uint8Array { return Blob.parseBytes(d, enc); }

/** number source lines: "  12 | code" */
export function numbered(src: string, from = 1, to = Infinity, mark?: Set<number>): string {
  const lines = src.split('\n');
  const end = Math.min(lines.length, to);
  const w = String(end).length;
  const out: string[] = [];
  for (let i = Math.max(1, from); i <= end; i++) out.push(`${mark?.has(i) ? '>' : ' '}${String(i).padStart(w)} | ${lines[i - 1]}`);
  return out.join('\n');
}
export const trunc = (s: string, n: number) => s.length > n ? s.slice(0, n) + '…' : s;
export function table(rows: Array<Array<string | number>>, head?: string[]): string {
  const all = head ? [head, ...rows] : rows;
  const w: number[] = [];
  for (const r of all) r.forEach((c, i) => { w[i] = Math.max(w[i] ?? 0, Math.min(60, String(c).length)); });
  const fmt = (r: Array<string | number>) => r.map((c, i) => { const t = trunc(String(c), 60); return i === r.length - 1 ? t : t.padEnd(w[i]); }).join('  ');
  const out = all.map(fmt);
  if (head) out.splice(1, 0, w.map(x => '-'.repeat(x)).join('  '));
  return out.join('\n');
}
