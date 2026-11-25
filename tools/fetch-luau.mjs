#!/usr/bin/env node
// Downloads the official prebuilt Luau CLI tools for this OS into tools/luau/.
// PRISM only uses them to COMPILE (luau-compile), TYPECHECK (luau-analyze) and PARSE (luau-ast).
// The `luau` runtime/REPL in the release archive is deliberately NOT extracted: PRISM is static-only.
//
//   node tools/fetch-luau.mjs [--version 0.745|latest] [--platform win32|darwin|linux] [--force] [--optional]
//   env: LUAU_VERSION, PRISM_LUAU_DIR (destination, default tools/luau)
import { mkdirSync, writeFileSync, existsSync, chmodSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inflateRawSync } from 'node:zlib';

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const optional = args.includes('--optional');
const force = args.includes('--force');
const vi = args.indexOf('--version');
const version = vi >= 0 ? args[vi + 1] : (process.env.LUAU_VERSION || '0.745');
const pi = args.indexOf('--platform');
const platform = pi >= 0 ? args[pi + 1] : process.platform;
const dest = process.env.PRISM_LUAU_DIR || join(here, 'luau');
const asset = { win32: 'luau-windows.zip', darwin: 'luau-macos.zip', linux: 'luau-ubuntu.zip' }[platform];
const exe = n => (platform === 'win32' ? n + '.exe' : n);
const WANT = ['luau-compile', 'luau-analyze', 'luau-ast'];

function fail(msg) { console.error('[fetch-luau] ' + msg); process.exit(optional ? 0 : 1); }

/** minimal ZIP reader (stored + deflate), enough for the official release archives */
function unzip(buf) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Error('not a zip archive');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const out = new Map();
  for (let k = 0; k < count; k++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('corrupt central directory');
    const method = buf.readUInt16LE(p + 10), csize = buf.readUInt32LE(p + 20);
    const nlen = buf.readUInt16LE(p + 28), xlen = buf.readUInt16LE(p + 30), clen = buf.readUInt16LE(p + 32), loff = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nlen);
    p += 46 + nlen + xlen + clen;
    if (name.endsWith('/')) continue;
    const start = loff + 30 + buf.readUInt16LE(loff + 26) + buf.readUInt16LE(loff + 28);
    const data = buf.subarray(start, start + csize);
    out.set(name, method === 0 ? data : method === 8 ? () => inflateRawSync(data) : null);
  }
  return out;
}

if (!asset) fail(`no prebuilt Luau for platform "${platform}" — build https://github.com/luau-lang/luau yourself and start PRISM with --luau <dir>`);
if (!force && WANT.every(n => existsSync(join(dest, exe(n))))) { console.log(`[fetch-luau] already present in ${dest} (use --force to re-download)`); process.exit(0); }
const url = version === 'latest'
  ? `https://github.com/luau-lang/luau/releases/latest/download/${asset}`
  : `https://github.com/luau-lang/luau/releases/download/${version}/${asset}`;
console.log(`[fetch-luau] downloading ${url}`);
let buf;
try {
  const r = await fetch(url, { redirect: 'follow' });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  buf = Buffer.from(await r.arrayBuffer());
} catch (e) { fail('download failed: ' + (e?.message ?? e) + ' — PRISM still works without native tools (only luau_compile / luau_analyze / luau_ast are disabled)'); }
let entries;
try { entries = unzip(buf); } catch (e) { fail('could not read archive: ' + e.message); }
mkdirSync(dest, { recursive: true });
const got = [];
for (const [name, data] of entries) {
  const base = basename(name);
  const tool = WANT.find(n => base === exe(n));
  if (!tool) continue;
  if (!data) { console.warn(`[fetch-luau] skip ${name}: unsupported compression`); continue; }
  const file = join(dest, base);
  writeFileSync(file, typeof data === 'function' ? data() : data);
  try { chmodSync(file, 0o755); } catch {}
  got.push(base);
}
if (!got.length) fail('archive did not contain luau-compile / luau-analyze / luau-ast');
console.log(`[fetch-luau] Luau ${version}: ${got.join(', ')} → ${dest}`);
