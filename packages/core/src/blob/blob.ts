// PRISM blob lab — byte-level decoding toolkit for embedded payloads
// (constant pools, bytecode strings, key schedules). Pure TS, browser + node.
import { looksLikeLuauBytecode } from '../bytecode/luau.js';
export type Bytes = Uint8Array;

export const latin1 = (s: string): Bytes => { const b = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) b[i] = s.charCodeAt(i) & 255; return b; };
export const unlatin1 = (b: Bytes): string => { let s = ''; for (let i = 0; i < b.length; i += 8192) s += String.fromCharCode(...b.subarray(i, i + 8192)); return s; };
export const utf8 = (s: string): Bytes => new TextEncoder().encode(s);

export const STD_B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

export function b64decode(s: string, alphabet = STD_B64, pad = '='): Bytes {
  const map = new Map<string, number>();
  for (let i = 0; i < alphabet.length; i++) map.set(alphabet[i], i);
  const out: number[] = [];
  let bits = 0, n = 0;
  for (const ch of s) {
    if (ch === pad) break;
    const v = map.get(ch);
    if (v === undefined) continue;
    bits = (bits << 6) | v; n += 6;
    if (n >= 8) { n -= 8; out.push((bits >> n) & 255); }
  }
  return Uint8Array.from(out);
}
export function b64encode(b: Bytes, alphabet = STD_B64): string {
  let s = '';
  for (let i = 0; i < b.length; i += 3) {
    const n = (b[i] << 16) | ((b[i + 1] ?? 0) << 8) | (b[i + 2] ?? 0);
    s += alphabet[(n >> 18) & 63] + alphabet[(n >> 12) & 63] + (i + 1 < b.length ? alphabet[(n >> 6) & 63] : '=') + (i + 2 < b.length ? alphabet[n & 63] : '=');
  }
  return s;
}
export function hexdecode(s: string): Bytes {
  const h = s.replace(/0x/gi, '').replace(/[^0-9a-fA-F]/g, '');
  const out = new Uint8Array(h.length >> 1);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(h.substr(i * 2, 2), 16);
  return out;
}
export const hexencode = (b: Bytes, sep = ''): string => Array.from(b, x => x.toString(16).padStart(2, '0')).join(sep);

/** Lua string-literal escapes: \ddd \xNN \n \t \\ \" \u{...} \z */
export function luaUnescape(s: string): Bytes {
  let t = s.trim();
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) t = t.slice(1, -1);
  const out: number[] = [];
  const simple: Record<string, number> = { n: 10, t: 9, r: 13, a: 7, b: 8, f: 12, v: 11, '\\': 92, '"': 34, "'": 39, '\n': 10 };
  for (let i = 0; i < t.length; i++) {
    const c = t[i];
    if (c !== '\\') { const code = t.charCodeAt(i); if (code < 128) out.push(code); else for (const x of utf8(c)) out.push(x); continue; }
    const d = t[++i];
    if (d === undefined) break;
    if (/[0-9]/.test(d)) { let num = d; while (num.length < 3 && /[0-9]/.test(t[i + 1] ?? '')) num += t[++i]; out.push(Number(num) & 255); }
    else if (d === 'x') { out.push(parseInt(t.substr(i + 1, 2), 16) & 255); i += 2; }
    else if (d === 'u' && t[i + 1] === '{') { const e = t.indexOf('}', i); for (const x of utf8(String.fromCodePoint(parseInt(t.slice(i + 2, e), 16)))) out.push(x); i = e; }
    else if (d === 'z') { while (/\s/.test(t[i + 1] ?? '')) i++; }
    else out.push(simple[d] ?? d.charCodeAt(0));
  }
  return Uint8Array.from(out);
}
/** "12, 34, 0x56" / "{12,34}" -> bytes (values masked to 8 bits) */
export function decList(s: string): Bytes {
  const m = s.match(/-?(0x[0-9a-fA-F]+|\d+)/g) ?? [];
  return Uint8Array.from(m.map(x => Number(x) & 255));
}
export function xorBytes(b: Bytes, key: Bytes): Bytes { if (!key.length) return b.slice(); const o = new Uint8Array(b.length); for (let i = 0; i < b.length; i++) o[i] = b[i] ^ key[i % key.length]; return o; }
export function addBytes(b: Bytes, key: Bytes, sign = 1): Bytes { if (!key.length) return b.slice(); const o = new Uint8Array(b.length); for (let i = 0; i < b.length; i++) o[i] = (b[i] + sign * key[i % key.length]) & 255; return o; }

/** IronBrew-style compressor: base36 length-prefixed LZW codes over a 256-char dictionary */
export function lzwBase36(s: string): Bytes {
  let pos = 0;
  const next = (): number => { const len = parseInt(s[pos], 36); pos++; const v = parseInt(s.substr(pos, len), 36); pos += len; return v; };
  const dict: string[] = []; for (let i = 0; i < 256; i++) dict[i] = String.fromCharCode(i);
  let size = 256;
  let w = String.fromCharCode(next());
  const out: string[] = [w];
  while (pos < s.length) {
    const k = next();
    if (isNaN(k)) break;
    const entry = dict[k] !== undefined ? dict[k] : k === size ? w + w[0] : null;
    if (entry === null) break;
    out.push(entry);
    dict[size++] = w + entry[0];
    w = entry;
  }
  return latin1(out.join(''));
}
/** classic LZW over byte codes (code width grows 9..16 bits, LSB-first) */
export function lzwBits(b: Bytes): Bytes {
  const dict: number[][] = []; for (let i = 0; i < 256; i++) dict[i] = [i];
  let width = 9, bitpos = 0, size = 256;
  const read = () => { let v = 0; for (let i = 0; i < width; i++, bitpos++) { const byte = b[bitpos >> 3]; if (byte === undefined) return -1; v |= ((byte >> (bitpos & 7)) & 1) << i; } return v; };
  let prev: number[] | null = null; const out: number[] = [];
  for (;;) {
    const k = read(); if (k < 0) break;
    const e: number[] | null = dict[k] ?? (k === size && prev ? [...prev, prev[0]] : null);
    if (!e) break;
    out.push(...e);
    if (prev) { dict[size++] = [...prev, e[0]]; if (size >= (1 << width) && width < 16) width++; }
    prev = e;
  }
  return Uint8Array.from(out);
}

export function entropyBytes(b: Bytes): number {
  if (!b.length) return 0;
  const f = new Array(256).fill(0); for (const x of b) f[x]++;
  let h = 0; for (const c of f) if (c) { const p = c / b.length; h -= p * Math.log2(p); }
  return Math.round(h * 1000) / 1000;
}
export function printableBytes(b: Bytes): number {
  if (!b.length) return 1;
  let p = 0; for (const x of b) if ((x >= 32 && x < 127) || x === 9 || x === 10 || x === 13) p++;
  return Math.round(p / b.length * 1000) / 1000;
}
export function hexdump(b: Bytes, max = 4096): string {
  const lines: string[] = [];
  for (let i = 0; i < Math.min(b.length, max); i += 16) {
    const row = b.subarray(i, i + 16);
    lines.push(i.toString(16).padStart(8, '0') + '  ' + Array.from(row, x => x.toString(16).padStart(2, '0')).join(' ').padEnd(48) + ' |' + Array.from(row, x => x >= 32 && x < 127 ? String.fromCharCode(x) : '.').join('') + '|');
  }
  if (b.length > max) lines.push(`… ${b.length - max} more bytes`);
  return lines.join('\n');
}
export function detectMagic(b: Bytes): string[] {
  const out: string[] = [];
  const at = (i: number, ...xs: number[]) => xs.every((x, k) => b[i + k] === x);
  if (at(0, 0x1b, 0x4c, 0x75, 0x61)) out.push('Lua bytecode ' + (b[4] === 0x51 ? '5.1' : b[4] === 0x52 ? '5.2' : b[4] === 0x53 ? '5.3' : b[4] === 0x54 ? '5.4' : '0x' + b[4]?.toString(16)));
  if (b.length > 4 && ((b[0] >= 3 && b[0] <= 14) || b[0] === 100) && (b[0] < 4 || (b[1] >= 1 && b[1] <= 3))) out.push(looksLikeLuauBytecode(b) ? `Luau bytecode v${b[0]}` : `possible Luau bytecode v${b[0]}`);
  if (b[0] === 0) out.push('Luau compile error blob (version 0)');
  if (at(0, 0x1f, 0x8b)) out.push('gzip');
  if (b[0] === 0x78 && [0x01, 0x5e, 0x9c, 0xda].includes(b[1])) out.push('zlib');
  if (at(0, 0x50, 0x4b, 0x03, 0x04)) out.push('zip');
  if (at(0, 0x89, 0x50, 0x4e, 0x47)) out.push('png');
  if (at(0, 0x28, 0xb5, 0x2f, 0xfd)) out.push('zstd');
  const head = unlatin1(b.subarray(0, 64));
  if (/^\s*(local|return|function|--|if|for|while|print|game|loadstring)\b/.test(head)) out.push('Lua source');
  if (/^\s*[{[]/.test(head) && printableBytes(b) > 0.95) out.push('JSON?');
  return out;
}

export interface BlobStep { op: string; arg?: string; }
export const BLOB_OPS: Record<string, { label: string; arg?: string; run: (b: Bytes, arg: string) => Bytes }> = {
  'lua-unescape': { label: 'Lua string escapes → bytes', run: b => luaUnescape(unlatin1(b)) },
  'base64': { label: 'Base64 decode (arg: custom 64-char alphabet)', arg: 'alphabet', run: (b, a) => b64decode(unlatin1(b), a && a.length >= 64 ? a.slice(0, 64) : STD_B64) },
  'base64-encode': { label: 'Base64 encode', run: b => latin1(b64encode(b)) },
  'hex': { label: 'Hex decode', run: b => hexdecode(unlatin1(b)) },
  'hex-encode': { label: 'Hex encode', run: b => latin1(hexencode(b)) },
  'declist': { label: 'Decimal list → bytes', run: b => decList(unlatin1(b)) },
  'xor': { label: 'XOR with key (arg: number, 0xNN, hex:.. or text)', arg: 'key', run: (b, a) => xorBytes(b, parseKey(a)) },
  'add': { label: 'Add key bytes (mod 256)', arg: 'key', run: (b, a) => addBytes(b, parseKey(a), 1) },
  'sub': { label: 'Subtract key bytes (mod 256)', arg: 'key', run: (b, a) => addBytes(b, parseKey(a), -1) },
  'reverse': { label: 'Reverse bytes', run: b => b.slice().reverse() },
  'lzw-base36': { label: 'LZW decompress (IronBrew base36 codes)', run: b => lzwBase36(unlatin1(b)) },
  'lzw-bits': { label: 'LZW decompress (9..16-bit codes)', run: b => lzwBits(b) },
  'slice': { label: 'Slice (arg: start[:end], 0-based)', arg: 'start:end', run: (b, a) => { const [s, e] = (a || '0').split(':').map(Number); return b.slice(s || 0, isNaN(e) ? undefined : e); } },
  'strip-ws': { label: 'Remove whitespace', run: b => b.filter(x => x !== 32 && x !== 9 && x !== 10 && x !== 13) },
  'utf8-decode': { label: 'UTF-8 text → latin-1 bytes', run: b => { const s = new TextDecoder().decode(b); return latin1(s); } },
  'rc4': { label: 'RC4 decrypt (arg: key)', arg: 'key', run: (b, a) => rc4(b, parseKey(a)) },
  'xor-rolling': { label: 'XOR with rolling key k_i = (seed + i*step) & 255 (arg: seed,step)', arg: 'seed,step', run: (b, a) => { const [seed, step] = (a || '0,1').split(',').map(x => Number(x.trim()) || 0); return b.map((x, i) => x ^ ((seed + i * step) & 255)); } },
  'xor-prev': { label: 'XOR each byte with the previous cipher byte (CBC-like, arg: iv)', arg: 'iv', run: (b, a) => { let prev = Number(a) & 255; return b.map(x => { const o = x ^ prev; prev = x; return o; }); } },
  'nibble-swap': { label: 'Swap nibbles of each byte', run: b => b.map(x => ((x & 15) << 4) | (x >> 4)) },
  'not': { label: 'Bitwise NOT of each byte', run: b => b.map(x => ~x & 255) },
  'url-decode': { label: 'URL / percent decode', run: b => latin1(unlatin1(b).replace(/%([0-9a-fA-F]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)))) },
};
export function rc4(data: Bytes, key: Bytes): Bytes {
  if (!key.length) throw new Error('rc4 needs a key');
  const S = new Uint8Array(256); for (let i = 0; i < 256; i++) S[i] = i;
  for (let i = 0, j = 0; i < 256; i++) { j = (j + S[i] + key[i % key.length]) & 255; const t = S[i]; S[i] = S[j]; S[j] = t; }
  const out = new Uint8Array(data.length);
  for (let n = 0, i = 0, j = 0; n < data.length; n++) { i = (i + 1) & 255; j = (j + S[i]) & 255; const t = S[i]; S[i] = S[j]; S[j] = t; out[n] = data[n] ^ S[(S[i] + S[j]) & 255]; }
  return out;
}
export function parseKey(a: string | undefined): Bytes {
  if (!a) return new Uint8Array();
  const t = a.trim();
  if (/^hex:/i.test(t)) return hexdecode(t.slice(4));
  if (/^(0x[0-9a-f]+|\d+)(\s*,\s*(0x[0-9a-f]+|\d+))*$/i.test(t)) return Uint8Array.from(t.split(',').map(x => Number(x.trim()) & 255));
  return latin1(t);
}
export function runBlob(input: Bytes, steps: BlobStep[]): { out: Bytes; trace: Array<{ op: string; len: number; error?: string }> } {
  let cur = input; const trace: Array<{ op: string; len: number; error?: string }> = [];
  for (const s of steps) {
    const op = BLOB_OPS[s.op];
    if (!op) { trace.push({ op: s.op, len: cur.length, error: 'unknown op' }); break; }
    try { cur = op.run(cur, s.arg ?? ''); trace.push({ op: s.op, len: cur.length }); } catch (e: any) { trace.push({ op: s.op, len: cur.length, error: String(e?.message ?? e) }); break; }
  }
  return { out: cur, trace };
}

/** single-byte XOR brute force ranked by English/Lua-ish plaintext score */
export function xorSingleCandidates(b: Bytes, top = 5): Array<{ key: number; score: number; preview: string }> {
  const sample = b.subarray(0, 4096);
  const res: Array<{ key: number; score: number; preview: string }> = [];
  for (let k = 0; k < 256; k++) {
    let s = 0;
    for (const x of sample) { const c = x ^ k; if (c >= 97 && c <= 122) s += 3; else if (c === 32) s += 4; else if (c >= 65 && c <= 90) s += 2; else if (c >= 48 && c <= 57) s += 1.5; else if (c >= 32 && c < 127) s += 1; else if (c === 10 || c === 9) s += 1; else s -= 3; }
    res.push({ key: k, score: Math.round(s / sample.length * 100) / 100, preview: unlatin1(xorBytes(sample.subarray(0, 64), Uint8Array.of(k))).replace(/[^\x20-\x7e]/g, '.') });
  }
  return res.sort((a, c) => c.score - a.score).slice(0, top);
}
/** repeating-key XOR key length estimate (normalized Hamming distance) */
export function xorKeyLengths(b: Bytes, maxLen = 32): Array<{ len: number; dist: number }> {
  const out: Array<{ len: number; dist: number }> = [];
  const pop = (x: number) => { let c = 0; while (x) { c += x & 1; x >>= 1; } return c; };
  for (let L = 2; L <= Math.min(maxLen, b.length >> 2); L++) {
    let d = 0, n = 0;
    for (let i = 0; i + 2 * L <= Math.min(b.length, 4096); i += L) { for (let j = 0; j < L; j++) d += pop(b[i + j] ^ b[i + L + j]); n += L; }
    if (n) out.push({ len: L, dist: Math.round(d / n * 1000) / 1000 });
  }
  return out.sort((a, c) => a.dist - c.dist).slice(0, 6);
}
/** recover a repeating XOR key from known plaintext at offset */
export function xorKnownPlaintext(b: Bytes, plain: Bytes, offset = 0): Bytes { const k = new Uint8Array(plain.length); for (let i = 0; i < plain.length; i++) k[i] = b[offset + i] ^ plain[i]; return k; }

/** try common decodings of a text/bytes blob and rank the results */
export function autoDecode(input: Bytes): Array<{ steps: BlobStep[]; len: number; printable: number; entropy: number; magic: string[]; preview: string }> {
  const s = unlatin1(input).trim();
  const tries: BlobStep[][] = [[]];
  if (/\\(\d{1,3}|x[0-9a-fA-F]{2})/.test(s)) tries.push([{ op: 'lua-unescape' }]);
  if (/^[0-9a-fA-F\s]+$/.test(s) && s.replace(/\s/g, '').length % 2 === 0) tries.push([{ op: 'hex' }]);
  if (/^[A-Za-z0-9+/=\s]+$/.test(s) && s.length >= 8) tries.push([{ op: 'base64' }]);
  if (/^\s*[{(]?\s*-?\d+(\s*[,;]\s*-?\d+){3,}/.test(s)) tries.push([{ op: 'declist' }]);
  if (/^[0-9A-Za-z]+$/.test(s) && s.length > 16 && !isNaN(parseInt(s[0], 36))) tries.push([{ op: 'lzw-base36' }]);
  // unique-char 64+ alphabets embedded in the text are tried by the caller with an explicit alphabet
  const out = [];
  for (const steps of tries) {
    try {
      const { out: b, trace } = runBlob(input, steps);
      if (trace.some(t => t.error) || (steps.length && !b.length)) continue;
      out.push({ steps, len: b.length, printable: printableBytes(b), entropy: entropyBytes(b), magic: detectMagic(b), preview: unlatin1(b.subarray(0, 96)).replace(/[^\x20-\x7e]/g, '.') });
    } catch { /* ignore */ }
  }
  return out.sort((a, b) => (b.magic.length - a.magic.length) || (b.printable - a.printable));
}

export const asPythonBytes = (b: Bytes): string => "b'" + Array.from(b, x => x === 92 ? '\\\\' : x === 39 ? "\\'" : x >= 32 && x < 127 ? String.fromCharCode(x) : '\\x' + x.toString(16).padStart(2, '0')).join('') + "'";
export const asLuaString = (b: Bytes): string => '"' + Array.from(b, x => x === 92 ? '\\\\' : x === 34 ? '\\"' : x >= 32 && x < 127 ? String.fromCharCode(x) : '\\' + String(x).padStart(3, '0')).join('') + '"';
export const asCArray = (b: Bytes): string => '{ ' + Array.from(b, x => '0x' + x.toString(16).padStart(2, '0')).join(', ') + ' }';
export const asLuaTable = (b: Bytes): string => '{' + Array.from(b).join(',') + '}';

/** Parse a textual byte representation: hex | base64 | lua (quoted/escaped literal) | decimal list | latin1 | utf8 | auto-detect. */
export function parseBytes(d: string, enc: string = 'auto'): Bytes {
  const s = d.trim();
  const fromLua = (x: string) => {
    let body = x;
    const m = /^(["'])([\s\S]*)\1$/.exec(x) ?? /^\[(=*)\[([\s\S]*)\]\1\]$/.exec(x);
    if (m) body = m[2];
    return luaUnescape(body);
  };
  switch (enc) {
    case 'hex': return hexdecode(s.replace(/0x/gi, ''));
    case 'base64': return b64decode(s.replace(/\s+/g, ''));
    case 'latin1': return latin1(d);
    case 'utf8': return utf8(d);
    case 'lua': return fromLua(s);
    case 'decimal': return decList(s);
  }
  if (/^(["'])[\s\S]*\1$/.test(s) || /\\\d{1,3}|\\x[0-9a-fA-F]{2}/.test(s)) return fromLua(s);
  if (/^\{?\s*\d{1,3}(\s*[,;]\s*\d{1,3})+\s*,?\s*\}?$/.test(s)) return decList(s);
  if (/^(0x)?[0-9a-fA-F\s]+$/.test(s) && s.replace(/\s+|0x/g, '').length % 2 === 0) return hexdecode(s.replace(/0x/g, ''));
  if (/^[A-Za-z0-9+/\s]+={0,2}$/.test(s) && s.replace(/\s+/g, '').length % 4 === 0) return b64decode(s.replace(/\s+/g, ''));
  return latin1(d);
}
