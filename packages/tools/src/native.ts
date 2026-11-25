// Wrappers for the bundled native Luau tools. They only COMPILE / TYPECHECK / PARSE —
// nothing is ever executed (the `luau` runtime binary is intentionally not exposed).
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, existsSync, chmodSync, statSync } from 'node:fs';
import { join, delimiter } from 'node:path';
import { tmpdir } from 'node:os';

/** locate a native Luau tool: <luauDir>/<name>[.exe], then PATH */
export function resolveNative(dir: string, name: string): string {
  const exe = process.platform === 'win32' ? name + '.exe' : name;
  const local = join(dir, exe);
  if (existsSync(local)) return local;
  for (const p of (process.env.PATH ?? '').split(delimiter)) if (p && existsSync(join(p, exe))) return join(p, exe);
  return local;
}
export const hasNative = (dir: string, name: string) => existsSync(resolveNative(dir, name));
/** Binaries unpacked from zip/7z archives often lose the execute bit (spawn -> EACCES).
 *  Restore it once before running; returns true when the mode was changed. */
export function ensureExecutable(bin: string): boolean {
  if (process.platform === 'win32') return false;
  try {
    const mode = statSync(bin).mode;
    if ((mode & 0o111) === 0o111) return false;
    chmodSync(bin, mode | 0o755);
    return true;
  } catch { return false; }
}

export interface NativeResult { code: number | null; stdout: Buffer; stderr: string; timedOut: boolean; ms: number; }
export function runNative(bin: string, args: string[], opts: { timeoutMs?: number; maxBytes?: number } = {}): Promise<NativeResult> {
  if (!existsSync(bin)) return Promise.reject(new Error(`native tool not found: ${bin} (run "npm run fetch-luau", or set PRISM_LUAU_DIR / --luau)`));
  ensureExecutable(bin);
  const t0 = Date.now();
  return new Promise((res, rej) => {
    const p = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const out: Buffer[] = []; let err = ''; let size = 0; let timedOut = false;
    const max = opts.maxBytes ?? 64 * 1024 * 1024;
    const timer = setTimeout(() => { timedOut = true; p.kill('SIGKILL'); }, opts.timeoutMs ?? 60000);
    p.stdout.on('data', (d: Buffer) => { size += d.length; if (size <= max) out.push(d); else p.kill('SIGKILL'); });
    p.stderr.on('data', (d: Buffer) => { if (err.length < 200000) err += d.toString(); });
    p.on('error', e => { clearTimeout(timer); rej(e); });
    p.on('close', code => { clearTimeout(timer); res({ code, stdout: Buffer.concat(out), stderr: err, timedOut, ms: Date.now() - t0 }); });
  });
}
/** write source to a private temp file, run, clean up */
export async function withTempSource<T>(src: string, ext: string, fn: (file: string) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), 'prism-'));
  const file = join(dir, 'input' + ext);
  writeFileSync(file, src, 'utf8');
  try { return await fn(file); } finally { rmSync(dir, { recursive: true, force: true }); }
}
