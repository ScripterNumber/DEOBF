// One-click VM lifting — universal: works on any interpreter findVmShape recognises, nothing obfuscator-specific.
//   vm_boot_dump  the decoded chunk without reversing its format: the loader, ported to Python, runs on its own
//                 payload and is stopped at the VM closure factory, which dumps proto / upvalues / env / helper tables
//   vm_lift       boot dump → helper library + pure wrapper slots → vmSpecialize on every proto → lifted Lua script
import { z } from 'zod';
import { existsSync, readFileSync, statSync, rmSync } from 'node:fs';
import { join, delimiter } from 'node:path';
import { defineTool } from '../types.js';
import type { ToolContext } from '../types.js';
import { SRC, OUT, getSource, table } from '../source.js';
import { vmBootProgram, vmFactoryInfo, helperWrapperRules, vmSpecialize, findVmShape, parse, clean, protoInventory, formatInventory, liftReport, formatLiftReport } from '@prism/core';
import { runNative } from '../native.js';
import { saveDerived } from './deob.js';

/** python3 on the PRISM host: explicit path, $PRISM_PYTHON, then PATH */
export function findPython(explicit?: string): string | null {
  for (const c of [explicit, process.env.PRISM_PYTHON]) if (c && existsSync(c)) return c;
  const names = process.platform === 'win32' ? ['python.exe', 'python3.exe', 'py.exe'] : ['python3', 'python'];
  const dirs = (process.env.PATH ?? '').split(delimiter).filter(Boolean);
  for (const n of names) for (const d of dirs) if (existsSync(join(d, n))) return join(d, n);
  return null;
}

const baseName = (ctx: ToolContext, scriptId: string | undefined): string =>
  ((scriptId && ctx.ws.getMeta(scriptId)?.name) || scriptId || 'inline').replace(/\.(lua|luau|txt)$/i, '');

const NO_VM = 'no VM interpreter recognised (a dispatch loop over decoded instructions + the closure factory that creates VM closures), not even after cleaning — vm_detect / vm_anatomy show what is there';

/** the script the VM tools need: the given one when its interpreter is recognisable, else its cleaned copy */
function vmSource(ctx: ToolContext, src: string, base: string, scriptId: string | undefined): { ok: boolean; src: string; scriptId?: string; line?: string } {
  if (findVmShape(parse(src).chunk).shape) return { ok: true, src, scriptId };
  const c = clean(src, { rename: 'obfuscated' });
  if (!findVmShape(parse(c.code).chunk).shape) return { ok: false, src, scriptId };
  const sv = saveDerived(ctx, base + '.clean.lua', c.code, scriptId, 'deobfuscate (vm_lift)');
  return { ok: true, src: c.code, scriptId: sv.id, line: 'cleaned first → ' + sv.line };
}

const BOOT_IN = {
  python: z.string().optional().describe('python executable (default: $PRISM_PYTHON, then python3 / python on PATH)'),
  timeout_s: z.number().int().min(5).max(3600).optional().describe('run-time limit of the boot program in seconds (default 300)'),
  extra: z.array(z.string()).optional().describe('extra Lua names visible in the closure factory to put in the dump'),
  save_dump_as: z.string().optional().describe('dump output name (default <script>.vmdump.json)'),
};

interface BootRun { ok: boolean; lines: string[]; dump?: unknown; dumpName?: string; program?: string; helper?: { name: string; path: string } }

async function bootDump(ctx: ToolContext, src: string, base: string, a: { python?: string; timeout_s?: number; extra?: string[]; save_dump_as?: string; run?: boolean }): Promise<BootRun> {
  const dumpName = a.save_dump_as ?? base + '.vmdump.json';
  const dumpRel = ctx.ws.saveOutput(dumpName, '');
  const dumpAbs = ctx.ws.abs(dumpRel);
  rmSync(dumpAbs, { force: true });
  const embed = a.run !== false;
  const boot = vmBootProgram(src, { dumpPath: embed ? dumpAbs : undefined, extra: a.extra });
  const lines = [...boot.notes.map(n => '# ' + n), ...boot.warnings.map(w => '# warning: ' + w)];
  if (!boot.ok) return { ok: false, lines: [...lines, 'no VM closure factory to hook'] };
  const program = ctx.ws.saveOutput(base + '.boot.py', boot.program);
  const helper = boot.info?.helper;
  lines.push(`boot program: ${program} (${boot.program.length} chars; dump keys: ${boot.keys.join(', ')})`);
  if (!embed) return { ok: false, lines: [...lines, `run it: python3 ${base}.boot.py ${dumpName}  — then vm_lift {dump:"<that file>"} (or workspace_save_output it and pass the output name)`], program, helper };
  const py = findPython(a.python);
  if (!py) return { ok: false, lines: [...lines, `python3 not found on the PRISM host (set PRISM_PYTHON, or run: python3 "${ctx.ws.abs(program)}" — it writes ${dumpRel}; then vm_lift {dump:"${dumpName}"})`], program, helper };
  const r = await runNative(py, [ctx.ws.abs(program)], { timeoutMs: (a.timeout_s ?? 300) * 1000, maxBytes: 8 << 20 });
  const size = existsSync(dumpAbs) ? statSync(dumpAbs).size : 0;
  if (!size) {
    rmSync(dumpAbs, { force: true });
    const tail = String(r.stderr || r.stdout || '').trim().split('\n').slice(-25).join('\n');
    return { ok: false, lines: [...lines, `the boot program did not reach the closure factory (exit ${r.code}${r.timedOut ? ', timed out' : ''}, ${r.ms} ms):`, tail], program, helper };
  }
  lines.push(`dump: ${dumpRel} (${size} bytes; python ${r.ms} ms)`);
  return { ok: true, lines, dump: JSON.parse(readFileSync(dumpAbs, 'utf8')), dumpName, program, helper };
}

export const liftTools = [
  defineTool({
    name: 'vm_boot_dump',
    title: 'VM boot dump — the decoded chunk without reversing its format',
    category: 'vm',
    readOnly: false,
    description: 'Decoded chunk of ANY Lua VM obfuscator (Luraph, IronBrew, Moonsec, PSU, Prometheus, custom …) without reversing its serialisation format. Finds the interpreter and its closure factory structurally (the script is cleaned first if needed), ports the whole loader 1:1 to Python with a hook at the top of the factory and runs it on the PRISM host: the loader deserialises its own payload, the hook writes the root proto, its upvalues, the environment and every helper table the factory reads as a JSON dump and ends the program before any virtualised code runs (the Python prelude has no OS / network access). Functions in the dump carry their Lua source offsets ($at). Output: outputs/<script>.vmdump.json + the program <script>.boot.py; run:false only writes the program (for the user to run). Feed the dump to vm_lift or chunk_disasm.',
    input: { ...SRC, run: z.boolean().optional().describe('run the program now on the PRISM host (default true; needs python3)'), ...BOOT_IN, ...OUT },
    run: async (a, ctx) => {
      const s = getSource(a, ctx);
      const base = baseName(ctx, s.scriptId);
      const v = vmSource(ctx, s.src, base, s.scriptId);
      if (!v.ok) return { text: NO_VM, data: { ok: false } };
      const b = await bootDump(ctx, v.src, base, a);
      const sid = v.scriptId ? `script_id:"${v.scriptId}", ` : '';
      const text = [`# vm_boot_dump — ${s.label}`, ...(v.line ? [v.line] : []), ...b.lines,
        ...(b.ok ? ['', 'next:', `- vm_lift {${sid}dump:"${b.dumpName}"} — devirtualised Lua for every proto`, `- chunk_disasm {${sid}chunk_output:"${b.dumpName}"} — proto layout + raw disassembly`] : [])].join('\n');
      return { text, data: { ok: b.ok, dump: b.dumpName, program: b.program, script_id: v.scriptId, helper: b.helper } };
    },
  }),
  defineTool({
    name: 'vm_lift',
    title: 'VM lift — devirtualise a VM-obfuscated script (one click)',
    category: 'vm',
    readOnly: false,
    description: 'Universal devirtualiser for Lua VM obfuscators (nothing obfuscator- or sample-specific): cleans the script if needed, gets the decoded chunk (vm_boot_dump now, or the dump you give), resolves the helper table automatically (library functions; pure wrapper slots like function(n,t,i) return unpack(t,i,n) end are inlined), specialises the interpreter on every proto — self-modifying bytecode patch discovery, constant pools, register / upvalue promotion, record folding, unflattening — and saves the lifted, structured Lua as a new workspace script. Returns the per-proto table, the notes of every pass and next steps.',
    input: {
      ...SRC,
      dump: z.string().optional().describe('dump JSON: workspace output name or file path (default: vm_boot_dump runs now)'),
      helper: z.string().optional().describe("helper table Lua name (default: auto — the factory's most called-through upvalue table)"),
      helper_path: z.string().optional().describe('path of the helper table inside the dump (default: its Lua name)'),
      only: z.array(z.string()).optional().describe('lift only these proto ids (see the table of a full run)'),
      rewrites: z.array(z.object({ from: z.string(), to: z.string() })).optional().describe('extra expression rewrite rules (metavariables __name)'),
      patch_rounds: z.number().int().min(0).max(20).optional().describe('self-modifying bytecode discovery rounds (default 6)'),
      save_script_as: z.string().optional().describe('lifted script name (default <script>.lifted.lua)'),
      ...BOOT_IN,
      ...OUT,
    },
    run: async (a, ctx) => {
      const t0 = Date.now();
      const s = getSource(a, ctx);
      const base = baseName(ctx, s.scriptId);
      const v = vmSource(ctx, s.src, base, s.scriptId);
      if (!v.ok) return { text: NO_VM, data: { ok: false } };
      const lines = [`# vm_lift — ${s.label}`, ...(v.line ? [v.line] : [])];
      let helper = a.helper ? { name: a.helper, path: a.helper_path ?? a.helper } : undefined;
      let dump: unknown;
      if (a.dump) {
        dump = JSON.parse(existsSync(a.dump) ? readFileSync(a.dump, 'utf8') : ctx.ws.readOutput(a.dump).toString('utf8'));
        lines.push(`dump: ${a.dump}`);
        if (!helper) helper = vmFactoryInfo(parse(v.src).chunk).info?.helper;
      } else {
        const b = await bootDump(ctx, v.src, base, a);
        lines.push(...b.lines);
        if (!b.ok) return { text: lines.join('\n'), data: { ok: false, program: b.program } };
        dump = b.dump;
        helper ??= b.helper;
      }
      const wr = helper ? helperWrapperRules(v.src, dump, helper) : { rules: [], notes: [] };
      const r = vmSpecialize(v.src, dump, { helper, only: a.only, rewrites: [...wr.rules, ...(a.rewrites ?? [])], patchRounds: a.patch_rounds });
      lines.push(...wr.notes.map(n => '# ' + n), ...r.notes.map(n => '# ' + n));
      if (!r.ok || !r.protos.length) return { text: lines.join('\n'), data: { ok: false } };
      const sv = saveDerived(ctx, a.save_script_as ?? base + '.lifted.lua', r.code, v.scriptId, 'vm_lift');
      const patches = ctx.ws.saveOutput(base + '.patches.json', JSON.stringify(r.patches));
      const rows = r.protos.map(p => [p.id, p.instrs, p.blocks, p.structured ? 'yes' : 'no', p.code.split('\n').length]);
      const id = sv.id ? `script_id:"${sv.id}"` : '…';
      lines.push('', `lifted ${r.protos.length} proto(s): ${r.code.split('\n').length} lines, ${r.code.length} chars — ${sv.line}`, `patches: ${patches} (${r.patches.length}); ${Date.now() - t0} ms`, '',
        table(rows, ['proto', 'instrs', 'blocks', 'structured', 'lines']), '', 'next:',
        `- vm_protos {${id}} — per proto: constants, upvalues (and what the creator puts in each), nested protos, constant pools`,
        `- strings {${id}} / constants {${id}} — every literal of the lifted program`,
        `- behavior_report {${id}} — what it does (calls, remotes, HTTP, files)`,
        `- get_function / xrefs {${id}} — read it; rename_symbols to name things`);
      return { text: lines.join('\n'), data: { ok: true, script_id: sv.id, protos: r.protos.map(p => ({ id: p.id, instrs: p.instrs, blocks: p.blocks, structured: p.structured })), patches, helper } };
    },
  }),
  defineTool({
    name: 'vm_protos',
    title: 'Proto inventory — constants, upvalues and nested protos of every proto / function',
    category: 'vm',
    readOnly: false,
    description: 'The luac -l -l view recovered from source, for ANY script (nothing obfuscator- or sample-specific). On a lifted VM program (vm_lift / vm_specialize output: PROTOS[n] makers, closures made by PROTOS[m](upvalues)) it lists every proto; on any other script every function. Per proto / function: constants (strings, numbers, globals and global paths such as string.format, method names), upvalues (upvalue-array slots, how each is read and what the creator put there: a shared register box, a register value, one of its own upvalues; or the free locals), the protos / functions it creates with the upvalues of each new closure, the constant pools it fills, and the data tables of the program it reads. Plus the creation tree and the scaffolding common to every proto. The full data (every constant, pool entry and upvalue) is saved as JSON: outputs/<script>.protos.json.',
    input: {
      ...SRC,
      only: z.array(z.string()).optional().describe('only these proto ids / function names in the text (the JSON keeps everything)'),
      max_items: z.number().int().min(5).max(100000).optional().describe('items per list in the text (default 60; the JSON has everything)'),
      ...OUT,
    },
    run: (a, ctx) => {
      const t0 = Date.now();
      const s = getSource(a, ctx);
      const base = baseName(ctx, s.scriptId);
      const p = parse(s.src);
      const inv = protoInventory(p.chunk, s.src);
      const json = ctx.ws.saveOutput(base + '.protos.json', JSON.stringify(inv));
      const text = [`# vm_protos — ${s.label}${p.errors.length ? ` (${p.errors.length} parse error(s))` : ''}`,
        formatInventory(inv, { max: a.max_items, only: a.only }), '',
        `full inventory (every constant, pool entry and upvalue): ${json}; ${Date.now() - t0} ms`].join('\n');
      const units = inv.units.map(u => ({ id: u.id, line: u.line, strings: u.strings.length, numbers: u.numbers.length, globals: u.globals.length, upvalues: u.upvalues.length, children: u.children.length, pools: u.pools.length }));
      return { text, data: { mode: inv.mode, units, common: inv.common, json }, files: [json] };
    },
  }),
  defineTool({
    name: 'lift_report',
    title: 'Lift scorecard — how de-virtualised / readable a program is, in one number',
    category: 'vm',
    readOnly: true,
    description: 'Universal quality metrics for ANY Lua script (nothing obfuscator- or sample-specific): size, function literals, protos / functions, closure creation sites, deepest creation chain, captures by kind (box = by reference, by-value, pass-through of the creator upvalue, untraced) with the % resolved, the scaffolding locals every unit shares, and a 0-100 score with its penalties. Run it after vm_lift / vm_readable / deobfuscate / rename_symbols to measure progress between runs; it lists exactly which capture sites are still untraced.',
    input: {
      ...SRC,
      max_items: z.number().int().min(5).max(100000).optional().describe('items per list in the text (default 40; the JSON has everything)'),
      ...OUT,
    },
    run: (a, ctx) => {
      const s = getSource(a, ctx);
      const p = parse(s.src);
      const r = liftReport(p.chunk, s.src);
      const body = formatLiftReport(r, { max: a.max_items }).split('\n').slice(1);
      const text = [`# lift_report — ${s.label} — ${r.mode} mode${p.errors.length ? ` (${p.errors.length} parse error(s))` : ''}`, ...body].join('\n');
      return { text, data: { ...r, parseErrors: p.errors.length } };
    },
  }),
];
