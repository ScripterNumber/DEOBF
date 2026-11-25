import { z } from 'zod';
import { inflateSync, gunzipSync, inflateRawSync } from 'node:zlib';
import { defineTool } from '../types.js';
import { OUT, BYTES, getBytes, table } from '../source.js';
import { Blob } from '@prism/core';

const OUTFMT = z.enum(['hexdump', 'hex', 'latin1', 'utf8', 'base64', 'python', 'lua', 'c', 'decimal', 'json']).optional();
export function renderBytes(b: Uint8Array, fmt = 'hexdump'): string {
  switch (fmt) {
    case 'hex': return Blob.hexencode(b);
    case 'latin1': return Blob.unlatin1(b);
    case 'utf8': return new TextDecoder().decode(b);
    case 'base64': return Blob.b64encode(b);
    case 'python': return Blob.asPythonBytes(b);
    case 'lua': return Blob.asLuaString(b);
    case 'c': return Blob.asCArray(b);
    case 'decimal': return Blob.asLuaTable(b);
    case 'json': return JSON.stringify(Array.from(b));
    default: return Blob.hexdump(b, 1 << 20);
  }
}
const NODE_OPS: Record<string, (b: Uint8Array) => Uint8Array> = {
  inflate: b => new Uint8Array(inflateSync(b)), gunzip: b => new Uint8Array(gunzipSync(b)), 'inflate-raw': b => new Uint8Array(inflateRawSync(b)),
};
const info = (b: Uint8Array) => `${b.length} bytes, entropy ${Blob.entropyBytes(b).toFixed(3)} bits/byte, printable ${(Blob.printableBytes(b) * 100).toFixed(1)}%${Blob.detectMagic(b).length ? ', looks like: ' + Blob.detectMagic(b).join(', ') : ''}`;

export const blobTools = [
  defineTool({
    name: 'blob_transform', title: 'Blob Lab: decode pipeline', category: 'blob', readOnly: false,
    description: 'Run a chain of byte transforms over a blob (static, pure functions): ' + Object.entries(Blob.BLOB_OPS).map(([k, v]) => `${k} (${v.label})`).join('; ') + '; inflate / gunzip / inflate-raw (zlib). Output as hexdump/hex/latin1/utf8/base64/python/lua/c/decimal/json. save_output stores the raw resulting bytes in workspace outputs (chain further with input "output").',
    input: { ...BYTES, steps: z.array(z.object({ op: z.string(), arg: z.string().optional() })).describe('e.g. [{"op":"base64"},{"op":"xor","arg":"0x5A"}]'), out: OUTFMT, save_output: z.string().optional().describe('save resulting raw bytes as outputs/<name>'), ...OUT },
    run: (a, ctx) => {
      const { bytes, how } = getBytes(a, ctx);
      let cur = bytes; const trace: string[] = [];
      for (const s of a.steps) {
        try {
          if (NODE_OPS[s.op]) cur = NODE_OPS[s.op](cur);
          else { const r = Blob.runBlob(cur, [s]); if (r.trace[0]?.error) throw new Error(r.trace[0].error); cur = r.out; }
          trace.push(`  ${s.op}${s.arg ? `(${s.arg})` : ''} → ${cur.length} bytes`);
        } catch (e) { trace.push(`  ${s.op} FAILED: ${(e as Error).message}`); break; }
      }
      const files = a.save_output ? [ctx.ws.saveOutput(a.save_output, cur)] : [];
      return { text: `input: ${how}, ${bytes.length} bytes\n${trace.join('\n')}\nresult: ${info(cur)}${files.length ? `\nsaved ${files[0]}` : ''}\n\n${renderBytes(cur, a.out)}`, data: { length: cur.length, hex: cur.length <= 1 << 16 ? Blob.hexencode(cur) : undefined }, files };
    },
  }),
  defineTool({
    name: 'blob_info', title: 'Blob Lab: inspect', category: 'blob', readOnly: true,
    description: 'Inspect a blob: size, entropy, printable ratio, magic detection (Lua/Luau bytecode, zlib, gzip, zip, PNG, JSON, Lua source…), byte histogram and a hexdump head.',
    input: { ...BYTES, head: z.number().int().optional().describe('hexdump bytes (default 512)') },
    run: (a, ctx) => {
      const { bytes, how } = getBytes(a, ctx);
      const hist = new Map<number, number>(); for (const x of bytes) hist.set(x, (hist.get(x) ?? 0) + 1);
      const top = [...hist].sort((p, q) => q[1] - p[1]).slice(0, 16).map(([k, v]) => `0x${k.toString(16).padStart(2, '0')}×${v}`).join(' ');
      return { text: `input: ${how}\n${info(bytes)}\ndistinct bytes: ${hist.size}, range ${bytes.length ? Math.min(...bytes.subarray(0, 1 << 16)) : 0}..${bytes.length ? Math.max(...bytes.subarray(0, 1 << 16)) : 0}\ntop bytes: ${top}\n\n${Blob.hexdump(bytes, a.head ?? 512)}`, data: { length: bytes.length, entropy: Blob.entropyBytes(bytes), printable: Blob.printableBytes(bytes), magic: Blob.detectMagic(bytes), distinct: hist.size } };
    },
  }),
  defineTool({
    name: 'blob_auto', title: 'Blob Lab: auto-decode', category: 'blob', readOnly: true,
    description: 'Try the common encodings (Lua escapes, hex, base64, decimal lists, IronBrew LZW base36, zlib) on a blob and rank the results by magic / printability / entropy.',
    input: { ...BYTES },
    run: (a, ctx) => {
      const { bytes, how } = getBytes(a, ctx);
      const r = Blob.autoDecode(bytes);
      for (const [op, fn] of Object.entries(NODE_OPS)) { try { const b = fn(bytes); r.push({ steps: [{ op }], len: b.length, printable: Blob.printableBytes(b), entropy: Blob.entropyBytes(b), magic: Blob.detectMagic(b), preview: Blob.unlatin1(b.subarray(0, 96)).replace(/[^\x20-\x7e]/g, '.') }); } catch { /* not compressed */ } }
      return { text: `input: ${how}, ${bytes.length} bytes\n\n` + table(r.map(x => [x.steps.map(s => s.op).join(' → ') || '(raw)', x.len, (x.printable * 100).toFixed(0) + '%', x.entropy.toFixed(2), x.magic.join(', '), x.preview]), ['steps', 'len', 'print', 'H', 'magic', 'preview']), data: r };
    },
  }),
  defineTool({
    name: 'blob_xor', title: 'Blob Lab: XOR key recovery', category: 'blob', readOnly: true,
    description: 'Recover XOR keys statically: single-byte brute force ranked by plaintext score, repeating-key length estimation (Hamming distance), or known-plaintext key recovery (e.g. known "\\27Lua" header or "local ").',
    input: { ...BYTES, mode: z.enum(['single', 'keylen', 'known']).optional(), known_plaintext: z.string().optional(), offset: z.number().int().optional() },
    run: (a, ctx) => {
      const { bytes } = getBytes(a, ctx);
      const mode = a.mode ?? (a.known_plaintext ? 'known' : 'single');
      if (mode === 'known') {
        if (!a.known_plaintext) throw new Error('known_plaintext required');
        const k = Blob.xorKnownPlaintext(bytes, Blob.luaUnescape(a.known_plaintext), a.offset ?? 0);
        return { text: `key bytes at offset ${a.offset ?? 0}: ${Blob.hexencode(k, ' ')}  (${JSON.stringify(Blob.unlatin1(k))})\nif the key repeats, look for the period in these bytes.`, data: { key: Array.from(k) } };
      }
      if (mode === 'keylen') { const r = Blob.xorKeyLengths(bytes); return { text: table(r.map(x => [x.len, x.dist]), ['key length', 'norm. hamming']), data: r }; }
      const r = Blob.xorSingleCandidates(bytes, 10);
      return { text: table(r.map(x => ['0x' + x.key.toString(16).padStart(2, '0'), x.key, x.score, x.preview]), ['key', 'dec', 'score', 'preview']), data: r };
    },
  }),
];
