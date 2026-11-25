// vm_chain — universal multi-stage VM support.
// Many VM loaders (Luraph, IronBrew-style droppers, custom packers) run a FIRST virtualised stage whose only job is to
// decode / decrypt the NEXT chunk (the real program) out of the same payload and hand it to the same interpreter.
// vm_chain keeps the stage-1 boot program running past its first closure-factory call, then finds — structurally,
// nothing sample-specific — the payload buffer, its cursor and the reader that decodes the next chunk (shape
// similarity with the stage-1 chunk), resolves lazily decoded constants (pending-record maps behind __index +
// key-stream ciphers: multiplier / increment / output xor + the paired handle arrays, auto-detected and reported),
// writes the stage dump in the vm_lift dump format, lifts it, audits the lift and runs it in Luau.
import { z } from 'zod';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve, join, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { defineTool } from '../types.js';
import type { ToolContext } from '../types.js';
import { SRC, getSource, trunc } from '../source.js';
import { findPython } from './lift.js';
import { findLuau } from './audit.js';

const here = dirname(fileURLToPath(import.meta.url));
/** python runtime of the chain step: <repo>/tools/chain (PRISM_CHAIN_DIR overrides) */
export const CHAIN_DIR = process.env.PRISM_CHAIN_DIR ?? resolve(here, '../../../../tools/chain');

type Proc = { code: number | null; out: string; ms: number; killed: boolean };
/** async child process with a hard time limit; on POSIX the whole process group is killed (the chain forks scanners) */
export function runProc(cmd: string, args: string[], env: Record<string, string>, timeoutMs: number, cwd: string): Promise<Proc> {
  return new Promise(res => {
    const t0 = Date.now();
    const group = process.platform !== 'win32';
    const p = spawn(cmd, args, { env: { ...process.env, ...env }, cwd, detached: group, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let killed = false;
    const add = (d: Buffer) => { out += d.toString('utf8'); if (out.length > 4 << 20) out = out.slice(-(2 << 20)); };
    p.stdout?.on('data', add);
    p.stderr?.on('data', add);
    const timer = setTimeout(() => {
      killed = true;
      try { if (group && p.pid) process.kill(-p.pid, 'SIGKILL'); else p.kill('SIGKILL'); } catch { p.kill('SIGKILL'); }
    }, timeoutMs);
    p.on('error', e => { clearTimeout(timer); res({ code: -1, out: out + String(e), ms: Date.now() - t0, killed }); });
    p.on('close', code => { clearTimeout(timer); res({ code, out, ms: Date.now() - t0, killed }); });
  });
}

const EXIT: Record<number, string> = {
  4: 'no payload buffer in the tables visible to the closure factory — the loader has no second stage inside the interpreter',
  5: 'payload cursor slot not identified (no counter moved by the chunk readers) — single-stage VM, or the cursor lives outside the visible tables',
  6: 'no reader decoded a chunk shaped like stage 1 behind the cursor — the remaining payload is data, not another chunk',
};

type Post = {
  records?: number; writes?: number; string?: number; number?: number; boolean?: number; other?: number;
  config?: Record<string, unknown>; samples?: string[]; lazy?: string;
};

const vmChain = defineTool({
  name: 'vm_chain', title: 'Next VM stage — run the loader past stage 1, dump + lift + verify the chunk it decodes', category: 'vm',
  description: 'For VM loaders whose first virtualised stage only decodes / decrypts the NEXT chunk (the real program) out of the same payload and runs it in the same interpreter (Luraph and many custom loaders). Builds a chain program from the stage-1 boot program (vm_boot_dump / vm_lift), lets stage 1 run, then structurally finds the payload buffer, its cursor and the reader that decodes the next chunk; auto-detects lazily decoded constants (pending-record maps resolved through __index, key-stream ciphers: multiplier / increment / output xor, the paired handle arrays — all reported, overridable with lazy); writes the stage dump, lifts it (vm_lift), audits the lift (lift_audit) and runs it in Luau (luau_run; compare_* diffs the output against e.g. the original). Nothing obfuscator- or sample-specific. Needs python3; the run takes minutes (timeout_s).',
  input: {
    ...SRC,
    boot: z.string().optional().describe('stage-1 boot program (workspace output name or path; default <script>.boot.py — generated now when missing)'),
    lazy: z.string().optional().describe('lazy-constant resolver config as JSON {"table","pending","a","c","x","pair"} — default: auto-detected (shown in the result)'),
    timeout_s: z.number().optional().describe('time limit of the chain run in seconds (default 900)'),
    lift: z.boolean().optional().describe('lift the dumped stage (default true)'),
    run: z.boolean().optional().describe('run the lift in Luau (default true when a Luau binary is found)'),
    entry: z.string().optional().describe('Lua appended to the lift to start it (default PROTOS[<root proto>](false)())'),
    compare_path: z.string().optional().describe('diff the Luau output of the lift against this script (e.g. the original)'),
    compare_script_id: z.string().optional().describe('diff the Luau output of the lift against this workspace script'),
    save_script_as: z.string().optional().describe('name of the lifted stage (default <script>.stage2.lifted.lua)'),
    python: z.string().optional().describe('python interpreter (default PRISM_PYTHON / python3 on PATH)'),
  },
  run: async (a, ctx) => {
    const { runTool } = await import('../index.js');
    const s = getSource(a, ctx);
    const py = findPython(a.python);
    if (!py) return { text: 'python3 not found on the PRISM host (set PRISM_PYTHON) — vm_chain runs the stage-1 boot program', data: { ok: false } };
    if (!existsSync(join(CHAIN_DIR, 'mkchain.py'))) return { text: `chain runtime missing: ${join(CHAIN_DIR, 'mkchain.py')} (set PRISM_CHAIN_DIR)`, data: { ok: false } };
    const lines: string[] = [`# vm_chain — ${s.label}`];
    let sid = s.scriptId ?? ctx.ws.addScript('inline.lua', s.src).id;
    const nameOf = (id: string) => ((ctx.ws.getMeta(id)?.name) || id).replace(/\.(lua|luau|txt)$/i, '');
    let base = nameOf(sid);
    // 1. the stage-1 boot program (written by vm_boot_dump / vm_lift; generated now when missing)
    const look = (n: string): string => {
      if (isAbsolute(n)) return existsSync(n) ? n : '';
      const p = ctx.ws.abs('outputs/' + n);
      return existsSync(p) ? p : existsSync(n) ? resolve(n) : '';
    };
    let bootAbs = a.boot ? look(a.boot) : '';
    if (a.boot && !bootAbs) return { text: `boot program not found: ${a.boot}`, data: { ok: false } };
    if (!bootAbs) for (const c of [base + '.boot.py', base + '.clean.boot.py']) if ((bootAbs = look(c))) break;
    if (!bootAbs) {
      const b = await runTool('vm_boot_dump', { script_id: sid }, ctx);
      const d = (b.data ?? {}) as { program?: string; script_id?: string };
      if (!d.program) return { text: [...lines, 'no stage-1 boot program: vm_boot_dump failed —', trunc(b.text, 1500)].join('\n'), data: { ok: false } };
      bootAbs = ctx.ws.abs(d.program);
      if (d.script_id) { sid = d.script_id; base = nameOf(sid); }
      lines.push(`boot program generated: ${d.program}`);
    }
    // 2. chain program (boot program + chain runtime + lazy-constant resolver) and its run
    const chainRel = ctx.ws.saveOutput(base + '.chain.py', '');
    const chainAbs = ctx.ws.abs(chainRel);
    const dumpName = base + '.stage2.json';
    const dumpRel = ctx.ws.saveOutput(dumpName, '');
    ctx.ws.deleteOutput(dumpName);
    const dumpAbs = ctx.ws.abs(dumpRel);
    const mk = await runProc(py, [join(CHAIN_DIR, 'mkchain.py'), bootAbs, chainAbs], {}, 120000, CHAIN_DIR);
    if (mk.code !== 0) return { text: [...lines, `the boot program ${bootAbs} has no closure-factory dump hook (it must come from vm_boot_dump / vm_lift):`, trunc(mk.out.trim(), 1500)].join('\n'), data: { ok: false } };
    const tmo = Math.max(30, a.timeout_s ?? 900) * 1000;
    const env: Record<string, string> = { PRISM_CHAIN_OUT: dumpAbs };
    if (a.lazy) env.PRISM_LAZY = a.lazy;
    const ch = await runProc(py, [chainAbs], env, tmo, dirname(chainAbs));
    const logRel = ctx.ws.saveOutput(base + '.chain.log', ch.out);
    lines.push(`chain run: ${(ch.ms / 1000).toFixed(1)} s, ${ch.killed ? 'TIME LIMIT' : 'exit ' + ch.code} — full log ${logRel}`);
    const log = ch.out.split('\n').filter(l => l.startsWith('[chain]'));
    lines.push(...log.filter(l => /payload|cursor|candidates|scanned|next chunk|written|no |not identified/i.test(l)).slice(0, 14).map(l => '  ' + trunc(l.replace(/^\[chain\]\s*/, ''), 220)));
    let report: Record<string, unknown> = {};
    try { report = JSON.parse(readFileSync(dumpAbs + '.report.json', 'utf8')); } catch { /* no report written */ }
    if (!existsSync(dumpAbs)) {
      const why = ch.killed ? `time limit (${tmo / 1000} s) — raise timeout_s` : EXIT[ch.code ?? -1] ?? `exit ${ch.code}: ` + trunc(ch.out.trim().split('\n').slice(-6).join(' | '), 600);
      lines.push('', `no next stage: ${why}`);
      return { text: lines.join('\n'), data: { ok: false, reason: why, log: logRel }, files: [logRel, chainRel] };
    }
    // 3. lazily decoded constants
    const post = (report.post ?? {}) as Post;
    if (post.records !== undefined) {
      const c = post.config ?? {};
      const pct = c.confidence !== undefined ? `, confidence ${Math.round(Number(c.confidence) * 1000) / 10}%` : '';
      const cfg = Object.fromEntries(Object.entries(c).filter(([k]) => k !== 'why' && k !== 'confidence'));
      lines.push('', `lazy constants: ${post.records} pending record(s) resolved → ${post.writes} constant slot(s) (${post.string ?? 0} strings, ${post.number ?? 0} numbers, ${post.boolean ?? 0} booleans, ${post.other ?? 0} other)`,
        `  resolver ${c.why === 'auto' ? 'auto-detected' : 'as configured'}: pending map ${c.table}.${c.pending}, key stream key = (a*key + c) % 256 with a=${c.a} c=${c.c}, output xor ${c.x}${pct}, paired handle fields ${JSON.stringify(c.pair ?? {})}`,
        `  override: vm_chain {lazy:'${JSON.stringify(cfg)}'}`,
        '  samples: ' + trunc((post.samples ?? []).slice(0, 16).map(x => JSON.stringify(x)).join(', '), 700));
    } else if (post.lazy) lines.push('', `lazy constants: ${post.lazy}`);
    if (report.post_error) lines.push(`lazy constants FAILED: ${trunc(String(report.post_error), 300)} — constants of this stage stay unresolved (nil in the lift)`);
    lines.push(`dump: ${dumpRel}`);
    const files = [dumpRel, logRel];
    if (a.lift === false) {
      lines.push('', `next: vm_lift {script_id:"${sid}", dump:"${dumpName}"}`);
      return { text: lines.join('\n'), data: { ok: true, dump: dumpRel, lazy: post }, files };
    }
    // 4. lift + audit + run
    const lf = await runTool('vm_lift', { script_id: sid, dump: dumpAbs, save_script_as: a.save_script_as ?? base + '.stage2.lifted.lua' }, ctx);
    const ld = (lf.data ?? {}) as { ok?: boolean; script_id?: string; protos?: Array<{ id: number; instrs: number; blocks: number; structured: boolean }> };
    if (!ld.ok || !ld.script_id) return { text: [...lines, '', 'lift FAILED:', trunc(lf.text, 2000)].join('\n'), data: { ok: false, dump: dumpRel, lazy: post }, files };
    lines.push('', '## lift', ...lf.text.split('\n').filter(l => /^lifted |^proto\s+instrs|^-----|^\d+\s+\d+\s+\d+/.test(l)).slice(0, 40));
    const au = await runTool('lift_audit', { script_id: ld.script_id, max_hits: 3 }, ctx);
    const at = au.text.split('\n');
    const aCut = at.findIndex((l, i) => i > 0 && l.startsWith('## '));
    lines.push('', '## audit', ...at.slice(1, aCut < 0 ? 16 : aCut).filter(Boolean));
    const root = ld.protos?.[0]?.id ?? 1;
    const entry = a.entry ?? `PROTOS[${root}](false)()`;
    let run: unknown;
    if (a.run !== false && findLuau(ctx)) {
      const rr = await runTool('luau_run', {
        script_id: ld.script_id, append: entry, timeout_ms: 60000,
        ...(a.compare_path ? { compare_path: a.compare_path } : {}), ...(a.compare_script_id ? { compare_script_id: a.compare_script_id } : {}),
      }, ctx);
      const rt = rr.text.split('\n');
      const rCut = rt.findIndex(l => l.startsWith('## output'));
      lines.push('', '## run (Luau)', `entry: ${entry}`, ...rt.slice(1, rCut < 0 ? 10 : rCut).filter(Boolean));
      run = rr.data;
    } else if (a.run !== false) lines.push('', '## run', `no Luau binary (PRISM_LUAU / tools/luau / PATH) — to run it append: ${entry}`);
    lines.push('', 'next:',
      `- read it: workspace_get_script {script_id:"${ld.script_id}"} — the decoded program; lift_audit lists what is left to fix by hand, with line numbers`,
      `- raw layout of this stage: chunk_disasm {script_id:"${sid}", chunk_output:"${dumpName}"}`,
      `- run / diff it: luau_run {script_id:"${ld.script_id}", append:"${entry}", compare_path:"<original>"}`);
    return {
      text: lines.join('\n'),
      data: { ok: true, dump: dumpRel, script_id: ld.script_id, protos: ld.protos, entry, lazy: post, run },
      files: [...files, ...(lf.files ?? [])],
    };
  },
});

export const chainTools = [vmChain];
