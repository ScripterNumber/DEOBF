// PRISM shared tool registry — the single source of truth for the HTTP API, the MCP server and the web UI.
import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { resolve, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ToolDef, ToolContext, ToolResult } from './types.js';
import { defineTool } from './types.js';
import { Workspace } from './workspace.js';
import { SRC, OUT, getSource, trunc, table } from './source.js';
import { workspaceTools } from './tools/workspace.js';
import { analysisTools } from './tools/analysis.js';
import { deobTools } from './tools/deob.js';
import { searchTools } from './tools/search.js';
import { vmTools } from './tools/vm.js';
import { liftTools } from './tools/lift.js';
import { bytecodeTools } from './tools/bytecode.js';
import { blobTools } from './tools/blob.js';
import { transpileTools } from './tools/transpile.js';
import { auditTools } from './tools/audit.js';
import { chainTools } from './tools/chain.js';
export type { ToolDef, ToolContext, ToolResult } from './types.js';
export { Workspace } from './workspace.js';
export { GUIDE, PROMPTS } from './guide.js';
export { resolveNative, hasNative } from './native.js';
import { GUIDE } from './guide.js';

const here = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = resolve(here, '../../..');
export function createContext(opts: { workspace?: string; luauDir?: string } = {}): ToolContext {
  return {
    ws: new Workspace(opts.workspace ?? process.env.PRISM_WORKSPACE ?? resolve(REPO_ROOT, 'workspace')),
    luauDir: opts.luauDir ?? process.env.PRISM_LUAU_DIR ?? resolve(REPO_ROOT, 'tools/luau'),
  };
}

const triage = defineTool({
  name: 'auto_triage', title: 'Auto triage (one click)', category: 'analysis',
  description: 'Full automatic static pass in one call: analyze → deobfuscate (stored as a new script) → constants/decoder candidates → VM anatomy (entry/exit/main chunks) → opcode map summary → embedded bytecode scan → behaviour / IOC report. Returns a compact brief with the next recommended steps and the ids of everything it saved.',
  input: { ...SRC, name: z.string().optional().describe('base name for stored scripts') },
  run: async (a, ctx) => {
    const { src, scriptId, label } = getSource(a, ctx);
    const base = a.name ?? (scriptId ? ctx.ws.getMeta(scriptId).name : a.path ? basename(a.path) : 'inline');
    const orig = scriptId ?? ctx.ws.addScript(base, src).id;
    const sec: string[] = [`# PRISM auto triage — ${label}`, `original script_id: ${orig}`];
    const run = async (n: string, args: Record<string, unknown>) => { try { return await runTool(n, args, ctx); } catch (e) { return { text: `(${n} failed: ${(e as Error).message})` } as ToolResult; } };
    const an = await run('analyze', { script_id: orig, max_chars: 4000 });
    sec.push('', '## analysis', an.text);
    const cl = await run('deobfuscate', { script_id: orig, rename: 'obfuscated', save_script_as: base.replace(/\.(lua|luau)$/i, '') + '.clean.lua', max_chars: 600 });
    const cleanId = (cl.data as { savedScriptId?: string } | undefined)?.savedScriptId;
    sec.push('', '## deobfuscate', cl.text.split('\n').slice(0, 3).join('\n'));
    const target = cleanId ?? orig;
    const co = await run('constants', { script_id: target, section: 'decoders', max: 8, max_chars: 5000 });
    sec.push('', '## decoder candidates (on cleaned code)', co.text);
    const ks = await run('constants', { script_id: target, section: 'keys', max: 8, max_chars: 2000 });
    sec.push('', '## key candidates', ks.text.split('\n').slice(1).join('\n'));
    const va = await run('vm_anatomy', { script_id: target, max_chunks: 12, code: false, max_chars: 5000 });
    sec.push('', '## VM anatomy (boot → run → exit, main chunks)', va.text.split('\n\nNEXT')[0]);
    const om = await run('opcode_map', { script_id: target, clean: false, lifted: false, max_trees: 4, max_chars: 4000 });
    sec.push('', '## dispatch / opcode map', om.text.split('\n').slice(0, 40).join('\n'));
    const eb = await run('find_embedded_bytecode', { script_id: orig });
    sec.push('', '## embedded bytecode', eb.text);
    const bh = await run('behavior_report', { script_id: target, max_hits: 4, max_chars: 3500 });
    sec.push('', '## behaviour / IOCs (static; decode strings first for full coverage)', bh.text.split('\n').slice(2).join('\n'));
    sec.push('', '## next steps',
      `- decode every constant in one go: decode_bundle {script_id:"${target}"} → user runs it → inline_values {script_id:"${target}", values_path:"out.json"}`,
      `- read the top decoder: get_function {script_id:"${target}", query:<line>} → python_transpile {function:<name|line>}`,
      `- VM lift (one click): vm_lift {script_id:"${target}"} — boot dump (loader ported to Python, stopped at the closure factory) + devirtualised Lua of every proto`,
      `- VM boot chain: vm_anatomy {script_id:"${target}"} → python_transpile {function:<deserializer line>} dumps the decoded chunk`,
      `- refine names: rename_symbols {script_id:"${target}", renames:[…], save_script_as:"…"}`,
      `- VM: opcode_map {script_id:"${target}", clean:false, code:true, save_opmap_as:"${base}"} → opmap_set to correct → vm_disasm`,
      `- blobs/keys: blob_auto / blob_transform / blob_xor {from_script:"${target}", string_line:N}`,
      `- after decoding constants: behavior_report {script_id:<inlined copy>} or {chunk_path:"out.json"} for URLs / webhooks / loaders`,
      `- record findings: workspace_note {script_id:"${target}", note:"…"}`);
    return { text: sec.join('\n'), data: { original: orig, cleaned: cleanId } };
  },
});

// the whole static pipeline in one call — everything the scratch scripts did by hand, as a product tool (universal)
const autoLift = defineTool({
  name: 'auto_lift', title: 'Auto lift — the whole static pipeline in one call', category: 'vm',
  description: 'Everything PRISM does to an obfuscated script, in ONE call, for ANY script (nothing obfuscator- or sample-specific): store it → deobfuscate (clean copy) → vm_detect → when an interpreter VM is recognised: vm_lift (boot dump + devirtualised Lua of every proto) → vm_readable (closures nested where they are created, upvalues named after their origin, VM scaffolding dropped) → vm_chain (multi-stage loaders: the chunk stage 1 decodes is dumped, its lazy constants resolved, lifted and run in Luau) → lift_report scorecard → lift_audit → vm_protos (constants / upvalues / nested protos / pools per proto) → constants → strings → behaviour; without a VM the same analysis runs on the clean copy. Every step is timed and its full output saved (outputs/<name>.auto.NN_<tool>.txt); one report (outputs/<name>.auto.report.md) explains how to read the result and what is left.',
  input: {
    ...SRC,
    name: z.string().optional().describe('base name for stored scripts and outputs (default: the script / file name)'),
    lift: z.enum(['auto', 'off']).optional().describe('auto (default): devirtualise when an interpreter VM is recognised; off: clean + analyse only'),
    only: z.array(z.string()).optional().describe('vm_lift: lift only these proto ids'),
    chain: z.enum(['auto', 'off']).optional().describe('auto (default): when stage 1 is a loader that decodes a NEXT chunk from its payload, vm_chain dumps it (lazy constants resolved), lifts it and runs it in Luau; off: stage 1 only'),
    compare_path: z.string().optional().describe('reference script (e.g. the original): the Luau output of the next stage is diffed against it'),
  },
  run: async (a, ctx) => {
    const T0 = Date.now();
    const { src, scriptId, label } = getSource(a, ctx);
    const name = a.name ?? (scriptId ? ctx.ws.getMeta(scriptId).name : a.path ? basename(a.path) : 'inline.lua');
    const base = name.replace(/\.(lua|luau|txt)$/i, '');
    const orig = scriptId ?? ctx.ws.addScript(name, src).id;
    const steps: Array<Array<string | number>> = [];
    const files: string[] = [];
    let n = 0;
    const step = async (what: string, tool: string, args: Record<string, unknown>, keep = 200): Promise<ToolResult | null> => {
      const tag = String(++n).padStart(2, '0') + '_' + tool;
      const t0 = Date.now();
      try {
        const r = await runTool(tool, { ...args, save_as: `${base}.auto.${tag}.txt`, max_chars: keep }, ctx);
        const fs = r.files ?? [];
        files.push(...fs);
        steps.push([n, what, tool, Date.now() - t0, 'ok', fs.find(f => f.includes(`.auto.${tag}`)) ?? '']);
        return r;
      } catch (e) {
        steps.push([n, what, tool, Date.now() - t0, 'FAILED: ' + trunc((e as Error).message, 80), '']);
        return null;
      }
    };
    const data = <T,>(r: ToolResult | null): T => (r?.data ?? {}) as T;
    const body = (r: ToolResult | null) => (r?.text ?? '').split('\n\n[saved')[0];
    const cl = await step('clean copy', 'deobfuscate', { script_id: orig, save_script_as: base + '.clean.lua' });
    const cleanId = data<{ savedScriptId?: string }>(cl).savedScriptId ?? orig;
    const det = await step('VM detection', 'vm_detect', { script_id: cleanId });
    const isVM = !!data<{ isVM?: boolean }>(det).isVM;
    let liftedId: string | undefined;
    let readableId: string | undefined;
    let lf: ToolResult | null = null;
    let ch: ToolResult | null = null;
    let stage2Id: string | undefined;
    if (a.lift !== 'off') {
      lf = await step('devirtualise (boot dump + every proto)', 'vm_lift', { script_id: cleanId, only: a.only, save_script_as: base + '.lifted.lua' }, 20000);
      const d = data<{ ok?: boolean; script_id?: string }>(lf);
      if (d.ok && d.script_id) liftedId = d.script_id;
      if (liftedId && getTool('vm_readable')) {
        const rd = await step('readable view (nested closures, named upvalues)', 'vm_readable', { script_id: liftedId, save_script_as: base + '.readable.lua' }, 6000);
        readableId = data<{ script_id?: string }>(rd).script_id;
      }
      if (liftedId && a.chain !== 'off' && getTool('vm_chain')) {
        ch = await step('next VM stage: the chunk stage 1 decodes — dump, lazy constants, lift, Luau run', 'vm_chain', { script_id: cleanId, ...(a.compare_path ? { compare_path: a.compare_path } : {}) }, 12000);
        stage2Id = data<{ script_id?: string }>(ch).script_id;
      }
    }
    const target = liftedId ?? cleanId;
    const rep = await step('scorecard', 'lift_report', { script_id: target }, 20000);
    const rep2 = readableId ? await step('scorecard of the readable view', 'lift_report', { script_id: readableId }, 20000) : null;
    const rep3 = stage2Id ? await step('scorecard of the next stage', 'lift_report', { script_id: stage2Id }, 20000) : null;
    const final = stage2Id ?? target;
    const au = liftedId ? await step('lift audit: run-time breakers + manual-fix list with line numbers', 'lift_audit', { script_id: final }, 8000) : null;
    await step('protos / functions: constants, upvalues, nested', 'vm_protos', { script_id: final, max_items: 100000 });
    await step('constants', 'constants', { script_id: final });
    await step('strings', 'strings', { script_id: final });
    const bh = await step(stage2Id ? 'behaviour / IOCs of the program (next stage)' : 'behaviour / IOCs', 'behavior_report', { script_id: final }, 8000);
    const bh1 = stage2Id ? await step('behaviour / IOCs of stage 1 (the loader)', 'behavior_report', { script_id: target }, 8000) : null;
    if (!liftedId) await step('analysis', 'analyze', { script_id: cleanId });
    const score = (r: ToolResult | null) => data<{ score?: number }>(r).score;
    const sec: string[] = [`# PRISM auto_lift — ${label}`,
      `${steps.length} steps in ${((Date.now() - T0) / 1000).toFixed(1)} s — original ${orig} → clean ${cleanId}${liftedId ? ` → lifted ${liftedId}` : ''}${readableId ? ` → readable ${readableId}` : ''}${stage2Id ? ` → next stage ${stage2Id}` : ''}`,
      `VM: ${isVM ? 'yes' : 'no'}${liftedId ? ' — devirtualised' : a.lift === 'off' ? ' — lift skipped (lift:"off")' : isVM ? ' — NOT lifted, see the vm_lift output for why' : ''}${score(rep) !== undefined ? ` — score ${score(rep)}/100` : ''}${score(rep2) !== undefined ? ` (readable view ${score(rep2)}/100)` : ''}`,
      '', '## steps', table(steps, ['#', 'step', 'tool', 'ms', 'status', 'full output'])];
    if (rep) sec.push('', '## scorecard', body(rep));
    if (rep2) sec.push('', '## scorecard — readable view', body(rep2));
    if (ch) sec.push('', '## next stage (vm_chain)', ...body(ch).split('\n').slice(1, 70));
    if (rep3) sec.push('', '## scorecard — next stage', body(rep3));
    if (au) sec.push('', '## audit of the final stage (lift_audit)', ...body(au).split('\n').slice(1, 18));
    if (lf) {
      const keep = body(lf).split('\n').filter(l => /^lifted \d|^patches|patch|slot|^no VM|^# (?!vm_lift)/i.test(l)).slice(0, 14);
      if (keep.length) sec.push('', '## lift', ...keep);
    }
    if (bh) sec.push('', '## behaviour (top)', ...body(bh).split('\n').slice(0, 25));
    if (bh1) sec.push('', '## behaviour of the loader (top)', ...body(bh1).split('\n').slice(0, 15));
    sec.push('', '## how to read');
    if (liftedId) sec.push(
      '- PROTOS[n] = function(k, K) … end — proto n of the decoded chunk; k is its upvalue array, the inner function is the closure body',
      '- p = PROTOS[n](A) followed by `if A then … A[i] = … end` — closure creation; each A[i] is one captured upvalue:',
      '    box rN — by reference: a shared cell for register N of the creator (read / written through the cell)',
      '    rN — by value (k[i] is the value itself); upvalue N — the creator passes its own upvalue N through',
      '- registers promoted to locals carry the register-table name + _N; registers captured by reference stay as <table>[N]',
      '- K_n — records (tables) of the decoded chunk; the helper table keeps the VM\'s own name',
      ...(readableId ? ['- readable view: closures are nested where they are created and every upvalue is named <proto>_r<N> in both the creator and the closure — for reading and comparing; the lifted script stays the runnable reference'] : []));
    else sec.push('- the clean copy is ordinary Lua: vm_protos lists every function with its constants, upvalues and nested functions');
    const sid = (x: string) => `script_id:"${x}"`;
    sec.push('', '## next', ...(liftedId ? [
      `- read: workspace_get_script {${sid(readableId ?? liftedId)}} · get_function / xrefs / find_text on it`,
      `- name what you understood: rename_symbols {${sid(readableId ?? liftedId)}, renames:[…], save_script_as:"…"} → lift_report again to see the score move`,
      '- untraced captures and run-time patched slots (scorecard / vm_lift output) are the next targets',
    ] : [
      `- decode constants: decode_bundle {${sid(cleanId)}} → run it → inline_values → deobfuscate again`,
      `- decoders / VM anatomy overview: auto_triage {${sid(cleanId)}}`,
      `- if a VM appears after decoding: auto_lift {${sid(cleanId)}}`,
    ]));
    if (stage2Id) sec.push(`- the program is the NEXT stage ${stage2Id} (stage 1 only decoded and started it) — read it first; run / diff it: luau_run {script_id:"${stage2Id}", append:"${data<{ entry?: string }>(ch).entry ?? 'PROTOS[1](false)()'}", compare_path:"<original>"}`);
    const text = sec.join('\n');
    const report = ctx.ws.saveOutput(`${base}.auto.report.md`, text);
    return { text, data: { original: orig, cleaned: cleanId, lifted: liftedId, readable: readableId, stage2: stage2Id, vm: isVM, score: score(rep), readableScore: score(rep2), steps, report }, files: [report, ...files] };
  },
});

const guide = defineTool({
  name: 'prism_guide', title: 'Workflow guide & tool catalog', category: 'workspace', readOnly: true,
  description: 'Returns the recommended static deobfuscation workflow and a one-line catalog of every PRISM tool. Call this first if unsure what to do next.',
  input: { category: z.string().optional().describe('only list tools of this category (workspace, analysis, deobfuscation, search, vm, bytecode, blob, transpile, luau)') },
  run: a => {
    const cat = TOOLS.filter(t => !a.category || t.category === a.category);
    const lines = cat.map(t => `- ${t.name} [${t.category}${t.readOnly ? ', read-only' : ''}] — ${t.title}: ${trunc(t.description.split(/(?<=\.)\s/)[0], 160)}`);
    return { text: `${GUIDE}\n\nTOOLS (${cat.length})\n${lines.join('\n')}`, data: { guide: GUIDE, tools: cat.map(t => ({ name: t.name, category: t.category, title: t.title })) } };
  },
});

export const TOOLS: ToolDef[] = [guide, ...workspaceTools, triage, autoLift, ...analysisTools, ...deobTools, ...searchTools, ...vmTools, ...liftTools, ...bytecodeTools, ...blobTools, ...transpileTools, ...auditTools, ...chainTools] as unknown as ToolDef[];
// every tool accepts the generic output controls (max_chars / save_as), even when it does not declare them itself
for (const t of TOOLS) for (const [k, v] of Object.entries(OUT)) if (!(k in t.input)) (t.input as Record<string, unknown>)[k] = v;
const BY_NAME = new Map(TOOLS.map(t => [t.name, t]));
export const getTool = (name: string) => BY_NAME.get(name);

export const DEFAULT_MAX_CHARS = 60000;
/** validate args, run, apply save_as / max_chars */
export async function runTool(name: string, args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult & { truncated?: boolean; fullLength?: number }> {
  const t = BY_NAME.get(name);
  if (!t) throw new Error(`unknown tool "${name}". Available: ${TOOLS.map(x => x.name).join(', ')}`);
  const parsed = z.object(t.input).strict().safeParse(args ?? {});
  if (!parsed.success) throw new Error('invalid arguments: ' + parsed.error.issues.map(i => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; '));
  const res = await t.run(parsed.data as never, ctx);
  const a = parsed.data as { save_as?: string; max_chars?: number };
  const files = [...(res.files ?? [])];
  if (a.save_as && !files.some(f => f.endsWith('/' + a.save_as))) files.push(ctx.ws.saveOutput(a.save_as, res.text));
  const max = a.max_chars ?? DEFAULT_MAX_CHARS;
  let text = res.text;
  let truncated = false;
  if (text.length > max) { truncated = true; text = text.slice(0, max) + `\n\n… [truncated: ${res.text.length - max} of ${res.text.length} chars omitted — raise max_chars or use save_as to keep the full output]`; }
  if (files.length) text += `\n\n[saved: ${files.join(', ')}]`;
  return { ...res, text, files, truncated, fullLength: res.text.length };
}

export interface ToolInfo { name: string; title: string; category: string; description: string; readOnly: boolean; inputSchema: Record<string, unknown>; }
export function listTools(): ToolInfo[] {
  return TOOLS.map(t => {
    const schema = zodToJsonSchema(z.object(t.input), { $refStrategy: 'none' }) as Record<string, unknown>;
    delete schema.$schema;
    return { name: t.name, title: t.title, category: t.category, description: t.description, readOnly: !!t.readOnly, inputSchema: schema };
  });
}
