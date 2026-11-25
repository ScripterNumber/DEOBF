// Universal post-lift analysis: what is still VM-shaped, what was lost, what to fix by hand, and a real Luau run.
//   lift_audit  static scan of any lifted / cleaned script → residue metrics + a ranked manual-fix list with line numbers
//   luau_run    runs a script with a real Luau binary (PRISM_LUAU, bundled tools/luau, PATH) and optionally diffs it against another;
//               without Luau it falls back to Lua 5.4 + a line-preserving Luau compat shim (compat54.ts, QA only)
import { z } from 'zod';
import { existsSync, writeFileSync, mkdtempSync, statSync } from 'node:fs';
import { join, delimiter, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { defineTool } from '../types.js';
import type { ToolContext } from '../types.js';
import { SRC, getSource, table } from '../source.js';
import { ensureExecutable } from '../native.js';
import { toLua54 } from '../compat54.js';

interface Hit { line: number; text: string }
interface Check { id: string; severity: 'break' | 'noise'; what: string; fix: string; re: RegExp }

// every pattern is generic Lua shape — nothing tied to one obfuscator build or sample
const CHECKS: Check[] = [
  { id: 'nil_index', severity: 'break', what: 'index by nil (x[nil]) — a constant operand the lifter could not resolve', fix: 'look the slot up in vm_protos / constants of that proto (or the dump K list) and put the literal back; usually a string field name', re: /\[nil\]/ },
  { id: 'nil_concat', severity: 'break', what: 'nil .. x / x .. nil — lost string constant in a concatenation', fix: 'same as nil_index: restore the string constant (strings tool lists candidates)', re: /\bnil\s*\.\.|\.\.\s*nil\b/ },
  { id: 'nil_call', severity: 'break', what: 'call of a nil-valued register / nil argument hole', fix: 'the callee was a constant or global (often print/string.*); check the creator and the env table', re: /\bnil\s*\(/ },
  { id: 'runtime_patch', severity: 'break', what: 'slot still written / read at run time (self-modifying bytecode)', fix: 'see lift_report "untraced captures"; replace the read with the patched value from the patches json', re: /<computed>|K_\d+\[null\]/ },
  { id: 'state_machine', severity: 'noise', what: 'dispatcher compare on a block-id variable (state machine not unflattened)', fix: 'rerun cleanup on that proto; if it stays, follow W = N edges manually: each `if W < N` leaf is one basic block', re: /\bif\s+[A-Za-z_]\w*\s*<\s*\d{2,}\s+then/ },
  { id: 'frame_save', severity: 'noise', what: 'VM loop frame save/restore table ({ [5] = L, [1] = M, ... })', fix: 'this is a for-loop prologue/epilogue: the saved regs are the loop counters — rewrite as for i = a, b do', re: /=\s*\{\s*\[\d+\]\s*=\s*[A-Za-z_]\w*\s*,\s*\[\d+\]/ },
  { id: 'register_table', severity: 'noise', what: 'register-table access (h[N]) — register not promoted to a local', fix: 'rename h[N] → a local per live range (rename_symbols / manual)', re: /\b[A-Za-z_]\w*\[\d+\]\s*=(?!=)/ },
  { id: 'table_create', severity: 'noise', what: 'table.create(n) + indexed stores instead of a constructor', fix: 'fold the following stores into { ... }', re: /table\.create\(/ },
  { id: 'string_key', severity: 'noise', what: 't["name"] instead of t.name', fix: 'mechanical: rewrite to t.name', re: /\["[A-Za-z_][A-Za-z0-9_]*"\]/ },
  { id: 'not_not', severity: 'noise', what: 'not not x (truthiness coercion from VM TEST ops)', fix: 'in conditions drop it; elsewhere keep (it converts to boolean)', re: /\bnot\s+not\b/ },
  { id: 'temp_name', severity: 'noise', what: 'generated temporary h_N / __aN', fix: 'inline single-use temps, rename the rest', re: /\bh_\d+\b|\b__a\d+\b/ },
  { id: 'protos_table', severity: 'noise', what: 'PROTOS[n](upvalues) closure maker instead of a local function', fix: 'inline the proto body at its creation site as local function; box cells become plain upvalues', re: /PROTOS\[\d+\]\s*\(/ },
  { id: 'getfenv', severity: 'noise', what: 'getfenv() environment table — globals read through it', fix: 'env["print"] → print; keep it only if the script really swaps envs', re: /getfenv\s*\(/ },
];

export function auditLift(src: string, maxHits = 12) {
  const lines = src.split('\n');
  const res = CHECKS.map(c => ({ ...c, count: 0, hits: [] as Hit[] }));
  lines.forEach((l, i) => {
    if (/^\s*--/.test(l)) return;
    for (const r of res) if (r.re.test(l)) { r.count++; if (r.hits.length < maxHits) r.hits.push({ line: i + 1, text: l.trim().slice(0, 160) }); }
  });
  // functions + strings + globals inventory: what the program touches
  const code = lines.filter(l => !/^\s*--/.test(l)).join('\n');
  const strings = [...new Set([...code.matchAll(/"((?:[^"\\\n]|\\.){2,})"/g)].map(m => m[1]))];
  const libs = new Map<string, number>();
  for (const m of code.matchAll(/\b(string|table|math|bit32|buffer|coroutine|debug|os|utf8)\.([a-z_]+)/g)) libs.set(m[0], (libs.get(m[0]) ?? 0) + 1);
  const fnLits = (code.match(/\bfunction\b/g) ?? []).length;
  const breaks = res.filter(r => r.severity === 'break').reduce((a, r) => a + r.count, 0);
  const noise = res.filter(r => r.severity === 'noise').reduce((a, r) => a + r.count, 0);
  // readability score: 100 minus weighted residue per 100 code lines
  const codeLines = Math.max(1, lines.filter(l => l.trim() && !/^\s*--/.test(l)).length);
  const score = Math.max(0, Math.round(100 - (breaks * 5 + noise) * 100 / codeLines / 2));
  return { lines: lines.length, codeLines, fnLits, breaks, noise, score, checks: res.map(({ re, ...r }) => r), strings, libs: [...libs].sort((a, b) => b[1] - a[1]) };
}

/** a candidate path may be the binary itself or a directory that contains it */
function binAt(c: string | undefined, exe: string): string | null {
  if (!c || !existsSync(c)) return null;
  try { if (statSync(c).isDirectory()) return existsSync(join(c, exe)) ? join(c, exe) : null; } catch { return null; }
  return c;
}

function onPath(names: string[]): string | null {
  for (const d of (process.env.PATH ?? '').split(delimiter).filter(Boolean)) for (const n of names) if (existsSync(join(d, n))) return join(d, n);
  return null;
}

/** Luau binary: explicit, $PRISM_LUAU, the bundled tools/luau dir, then PATH (file or directory paths) */
export function findLuau(ctx: ToolContext, explicit?: string): string | null {
  const exe = process.platform === 'win32' ? 'luau.exe' : 'luau';
  for (const c of [explicit, process.env.PRISM_LUAU, ctx.luauDir]) { const p = binAt(c, exe); if (p) return p; }
  return onPath([exe]);
}

/** QA fallback when there is no Luau: Lua 5.4 (explicit, $PRISM_LUA54, lua5.4 on PATH, bundled tools/lua54 runner) */
export function findLua54(ctx: ToolContext, explicit?: string): string | null {
  const win = process.platform === 'win32';
  const exe = win ? 'lua54.exe' : 'lua54';
  for (const c of [explicit, process.env.PRISM_LUA54]) { const p = binAt(c, exe) ?? binAt(c, win ? 'lua5.4.exe' : 'lua5.4'); if (p) return p; }
  const p = onPath(win ? ['lua5.4.exe', 'lua54.exe'] : ['lua5.4', 'lua54']);
  if (p) return p;
  const local = ctx.luauDir ? join(dirname(ctx.luauDir), 'lua54') : undefined;
  const b = binAt(local, exe);
  if (b) return b;
  // build the tiny bundled runner once if a C compiler and a system liblua 5.4 exist (Linux)
  if (local && !win && existsSync(join(local, 'runner.c'))) {
    const lib = ['/usr/lib64/liblua-5.4.so', '/usr/lib/x86_64-linux-gnu/liblua5.4.so', '/usr/lib/x86_64-linux-gnu/liblua5.4.so.0', '/usr/lib/liblua5.4.so', '/usr/lib/liblua.so.5.4', '/usr/local/lib/liblua.so']
      .find(existsSync);
    if (lib && onPath(['cc', 'gcc'])) {
      const r = spawnSync(onPath(['cc', 'gcc'])!, ['-O2', '-o', join(local, exe), join(local, 'runner.c'), lib, '-lm', '-ldl'], { encoding: 'utf8' });
      if (r.status === 0 && existsSync(join(local, exe))) return join(local, exe);
    }
  }
  return null;
}

export type Engine = 'luau' | 'lua54';

function runEngine(engine: Engine, bin: string, src: string, timeoutMs: number) {
  const dir = mkdtempSync(join(tmpdir(), 'prism-run-'));
  const compat = engine === 'lua54' ? toLua54(src) : undefined;
  const f = join(dir, engine === 'lua54' ? 'main.lua' : 'main.luau');
  writeFileSync(f, compat ? compat.code : src);
  ensureExecutable(bin);
  const r = spawnSync(bin, [f], { encoding: 'utf8', timeout: timeoutMs, maxBuffer: 64 << 20 });
  const err = (r.stderr ?? '') + (r.error ? String(r.error) : '');
  // map "main.luau:LINE:" / "main.lua:LINE:" errors back to the script line (the 5.4 shim keeps line numbers)
  const m = /main\.luau?:(\d+):\s*(.*)/.exec(err + '\n' + (r.stdout ?? ''));
  const failed = r.status !== 0 || !!r.error || r.signal != null;
  return { code: r.status, failed, out: (r.stdout ?? '').split('\n'), err: err.trim(), errLine: m ? +m[1] : undefined, errMsg: m?.[2], compat };
}

/** pick the engine: explicit choice, else real Luau, else the Lua 5.4 QA shim */
export function pickEngine(ctx: ToolContext, want: 'auto' | Engine = 'auto', luau?: string, lua54?: string): { engine: Engine; bin: string } | null {
  if (want !== 'lua54') { const b = findLuau(ctx, luau); if (b) return { engine: 'luau', bin: b }; if (want === 'luau') return null; }
  const b = findLua54(ctx, lua54);
  return b ? { engine: 'lua54', bin: b } : null;
}

export const auditTools = [
  defineTool({
    name: 'lift_audit', title: 'Lift audit (what is left + manual fix list)', category: 'vm', readOnly: true,
    description: 'Static audit of a lifted or cleaned script: counts every VM leftover (state machine, frame tables, register tables, PROTOS makers, table.create, t["k"], not not, temps) and every place that will BREAK at run time (x[nil], nil .., nil(), run-time patched slots), each with line numbers and the concrete fix. Also lists library calls and string literals the program uses. Universal — pure Lua-shape patterns. Run it after vm_lift / clean to know exactly what to fix by hand to make it run in Luau.',
    input: { ...SRC, max_hits: z.number().int().min(1).max(200).optional().describe('example lines per check (default 12)') },
    run(a, ctx) {
      const s = getSource(a, ctx);
      const r = auditLift(s.src, a.max_hits ?? 12);
      const out: string[] = [`# lift_audit — ${s.label}`, `readability ${r.score}/100 · ${r.codeLines} code lines · ${r.fnLits} function literal(s) · ${r.breaks} run-time breaker(s) · ${r.noise} readability leftover(s)`, ''];
      out.push(table(r.checks.filter(c => c.count).map(c => [c.severity === 'break' ? 'BREAK' : 'noise', c.id, c.count, c.what]), ['kind', 'check', 'count', 'meaning']));
      for (const c of [...r.checks].sort((x, y) => (x.severity === 'break' ? 0 : 1) - (y.severity === 'break' ? 0 : 1)).filter(c => c.count)) {
        out.push('', `## ${c.id} (${c.count}) — fix: ${c.fix}`, ...c.hits.map(h => `  L${h.line}: ${h.text}`));
      }
      if (r.libs.length) out.push('', `## library calls: ${r.libs.slice(0, 30).map(([k, n]) => `${k}×${n}`).join(', ')}`);
      if (r.strings.length) out.push('', `## string literals (${r.strings.length}): ${r.strings.slice(0, 60).map(x => JSON.stringify(x)).join(', ')}`);
      out.push('', 'next: fix BREAK lines first (they stop a Luau run), then luau_run {script_id} to see the first real error; noise only affects readability.');
      return { text: out.join('\n'), data: r };
    },
  }),
  defineTool({
    name: 'luau_run', title: 'Run in real Luau (+ diff)', category: 'luau', readOnly: true,
    description: 'Runs a script in a real Luau interpreter (PRISM_LUAU env, bundled tools/luau, or PATH) — or, when there is no Luau, in Lua 5.4 through a line-preserving Luau compat shim (continue, generalized for, bit32, table.create, Luau double arithmetic; QA only) — and returns its output and the first error with the offending source line. A failed or silent run is reported as NOT VERIFIED, never as identical. With compare_* it also runs a second script (e.g. the original) and diffs the printed output line by line (blank lines ignored). Optional append code (e.g. a driver call like PROTOS[1](false)()). Use it as the ground truth after manual fixes.',
    input: {
      ...SRC,
      append: z.string().optional().describe('Lua appended before running (driver call)'),
      compare_script_id: z.string().optional(), compare_path: z.string().optional(),
      luau: z.string().optional().describe('path of the luau binary (file or folder)'),
      lua54: z.string().optional().describe('path of a Lua 5.4 binary for the QA fallback'),
      engine: z.enum(['auto', 'luau', 'lua54']).optional().describe('auto (default): real Luau if found, else Lua 5.4 with the Luau compat shim'),
      timeout_ms: z.number().int().optional(),
    },
    run(a, ctx) {
      const eng = pickEngine(ctx, a.engine ?? 'auto', a.luau, a.lua54);
      if (!eng) return { text: a.engine === 'luau'
        ? 'no luau binary: set PRISM_LUAU, put it in tools/luau (npm run fetch-luau) or on PATH'
        : 'no engine: no Luau (PRISM_LUAU / tools/luau / PATH) and no Lua 5.4 (PRISM_LUA54 / lua5.4 on PATH / tools/lua54) — install one of them' };
      const s = getSource(a, ctx);
      const src = s.src + (a.append ? '\n' + a.append + '\n' : '');
      const ms = a.timeout_ms ?? 60000;
      const r = runEngine(eng.engine, eng.bin, src, ms);
      const lines = src.split('\n');
      const c = r.compat;
      const out = [`# luau_run — ${s.label}`,
        c ? `engine: Lua 5.4 + Luau compat shim (${eng.bin}) — QA only; ${c.continues} continue→goto, ${c.iterators} generalized for, ${c.floats} big literal(s) as doubles`
          : `engine: Luau (${eng.bin})`,
        ...(c?.notes ?? []).map(x => `  shim: ${x}`),
        `exit ${r.code}${r.failed ? ' (FAILED)' : ''}; ${r.out.filter(l => l.trim()).length} output line(s)`];
      if (r.err) out.push(`error: ${r.err.split('\n')[0]}`);
      if (r.errLine) out.push(`at L${r.errLine}: ${(lines[r.errLine - 1] ?? '').trim()}`, ...lines.slice(Math.max(0, r.errLine - 4), r.errLine + 2).map((l, i) => `  ${Math.max(1, r.errLine! - 3) + i}| ${l}`));
      let diff: unknown;
      if (a.compare_script_id || a.compare_path) {
        const o = getSource({ script_id: a.compare_script_id, path: a.compare_path }, ctx);
        const b = runEngine(eng.engine, eng.bin, o.src, ms);
        const x = r.out.filter(l => l.trim()), y = b.out.filter(l => l.trim());
        let same = 0, first = -1;
        for (let i = 0; i < Math.max(x.length, y.length); i++) { if (x[i] === y[i]) same++; else if (first < 0) first = i; }
        // a crashed or silent run proves nothing: never report it as identical
        const failed = [r.failed && 'this script failed', b.failed && `${o.label} failed`].filter(Boolean).join(' and ');
        const verified = !failed && (x.length > 0 || y.length > 0);
        const identical = verified && first < 0;
        diff = { same, a: x.length, b: y.length, first, verified, identical };
        const head = `compare with ${o.label}: ${same}/${Math.max(x.length, y.length)} identical line(s)`;
        if (failed) out.push('', `${head} — NOT VERIFIED (${failed})`, ...(b.failed && b.err ? [`  other error: ${b.err.split('\n')[0]}`] : []));
        else if (!verified) out.push('', `${head} — NOT VERIFIED (neither script printed anything; call the entry point with append, e.g. PROTOS[1](false)())`);
        else if (identical) out.push('', `${head} — OUTPUT IDENTICAL`);
        else out.push('', `${head}; first difference at line ${first + 1}:\n  this : ${x[first] ?? '<none>'}\n  other: ${y[first] ?? '<none>'}`);
      }
      out.push('', '## output (first 60)', ...r.out.slice(0, 60));
      return { text: out.join('\n'), data: { engine: eng.engine, exit: r.code, failed: r.failed, error: r.err, errLine: r.errLine, output: r.out, diff } };
    },
  }),
];
