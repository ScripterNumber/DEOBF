import { z } from 'zod';
import { defineTool } from '../types.js';
import { SRC, OUT, FORMAT, getSource, table, trunc, readFileChecked } from '../source.js';
import { mapOpcodes, formatOpcodeTree, opmapFromTree, vmDisassemble, luaLiteralToJson, anatomy, formatAnatomy, chunkDisassemble } from '@prism/core';
import type { OpMap } from '@prism/core';
import { saveDerived } from './deob.js';

const OPENTRY = z.union([z.string(), z.object({ name: z.string(), lua: z.string().optional(), args: z.string().optional(), notes: z.string().optional() })]);

export const vmTools = [
  defineTool({
    name: 'vm_anatomy', title: 'VM anatomy — entry, exits, main chunks', category: 'vm', readOnly: false,
    description: 'One static map of how ANY obfuscated script boots, runs and exits: payload blob → its consumer → deserializer → closure factory (wrapper) → interpreter function → dispatch loop / instruction fetch / pc advance → exit points (RETURN / TAILCALL handlers) / CLOSURE creation / env access → the entry call that starts the protected program. Also covers CFF state machines (entry state, break exits). Includes a ranked inventory of the main chunks (largest functions with callers, refs, parent and roles: interpreter, wrapper, deserializer, string-decoder, payload-consumer, main-wrapper, unreferenced…). Use it first on a VM script to know what to port (deserializer → python_transpile) and where the VM starts/stops. Line numbers refer to the given script unless clean:true.',
    input: {
      ...SRC,
      clean: z.boolean().optional().describe('deobfuscate first (default false). Line numbers then refer to the cleaned code — keep it with save_script_as'),
      max_chunks: z.number().int().optional().describe('rows in the main-chunk inventory (default 25)'),
      code: z.boolean().optional().describe('show code snippets next to each part (default true)'),
      save_script_as: z.string().optional().describe('with clean:true, store the analysed cleaned code as a workspace script'),
      ...FORMAT, ...OUT,
    },
    run: (a, ctx) => {
      const { src, scriptId, label } = getSource(a, ctx);
      const r = anatomy(src, { clean: a.clean ?? false, maxChunks: Math.max(a.max_chunks ?? 25, 40) });
      const { code, ...data } = r;
      const saved = a.clean && code ? saveDerived(ctx, a.save_script_as, code, scriptId, 'vm_anatomy(clean)') : { line: '' as string, id: undefined as string | undefined };
      if (a.format === 'json') return { text: JSON.stringify(data, null, 2), data: { ...data, savedScriptId: saved.id } };
      const sid = saved.id ?? (a.clean ? undefined : scriptId);
      const ref = sid ? `script_id:"${sid}", ` : '';
      const de = data.parts.find(p => p.role === 'deserializer'), sd = data.parts.filter(p => p.role === 'string-decoder');
      const next: string[] = [];
      if (de) next.push(`- unpack statically: python_transpile {${ref}function:"${de.line}"} → run the Python; its __main__ calls the deserializer and lua_dump()s the decoded chunk (constants, instructions, protos)`);
      if (sd.length) next.push(`- constants: python_transpile {${ref}function:"${sd[0].line}"} (string decoder), or constants {${ref}section:"decoders"}`);
      if (data.kind !== 'plain') next.push(`- handlers: opcode_map {${ref}clean:false, save_opmap_as:"vm"} → opmap_set → vm_disasm on the dumped instruction array`);
      const it = data.parts.find(p => p.role === 'interpreter' || p.role === 'dispatch-loop');
      if (it) next.push(`- read the interpreter prologue: get_lines {${ref}from_line:${it.line}, to_line:${it.line + 25}}`);
      if (data.kind === 'plain' && !a.clean) next.push(`- nothing found on the raw code: retry with clean:true (junk can hide the dispatcher)`);
      const text = formatAnatomy(data, { label, maxChunks: a.max_chunks ?? 25, code: a.code }) + (next.length ? '\n\nNEXT\n' + next.join('\n') : '') + (saved.line ? '\n\n' + saved.line : '');
      return { text, data: { ...data, savedScriptId: saved.id } };
    },
  }),
  defineTool({
    name: 'opcode_map', title: 'Opcode map (VM handlers)', category: 'vm', readOnly: false,
    description: 'Universal VM opcode extraction: finds every dispatch tree (if-chains / binary-search trees over an opcode or state variable, including CFF state machines), resolves which opcode numbers reach each handler, infers VM roles (instruction/opcode field, operand fields A/B/C…, register stack, constant table, pc, env) and guesses a Lua-style mnemonic per handler (MOVE, LOADK, GETTABLE, CALL, EQ, JMP, SUPER[...] for fused handlers…) with lifted pseudo-code. By default runs on the cleaned code (line numbers refer to it; use save_script_as to keep that code). save_opmap_as stores the guessed map for editing and vm_disasm.',
    input: {
      ...SRC, tree: z.number().int().optional().describe('only this dispatch tree index'), opcode: z.number().int().optional().describe('only the handler for this opcode'),
      clean: z.boolean().optional().describe('clean first (default true)'), code: z.boolean().optional().describe('include handler source (default false)'), lifted: z.boolean().optional().describe('include lifted pseudo-code (default true)'),
      min_leaves: z.number().int().optional(), max_trees: z.number().int().optional(),
      save_opmap_as: z.string().optional().describe('save the guessed opcode map of the chosen (or first VM) tree under this name'),
      save_script_as: z.string().optional().describe('store the analysed (cleaned) code as a workspace script so handler line numbers can be viewed'),
      ...FORMAT, ...OUT,
    },
    run: (a, ctx) => {
      const { src, scriptId } = getSource(a, ctx);
      const r = mapOpcodes(src, { clean: a.clean ?? true, minLeaves: a.min_leaves, maxTrees: a.max_trees });
      const trees = a.tree !== undefined ? r.report.trees.filter(t => t.id === a.tree || r.report.trees.indexOf(t) === a.tree) : r.report.trees;
      const saved = saveDerived(ctx, a.save_script_as, r.code, scriptId, 'opcode_map(clean)');
      const files: string[] = [];
      let opmapNote = '';
      if (a.save_opmap_as) {
        const t = trees.find(x => x.kind === 'vm') ?? trees[0];
        if (t) { const f = ctx.ws.setOpmap(a.save_opmap_as, { $meta: { tree: t.id, var: t.var, kind: t.kind, roles: t.roles, from: scriptId ?? 'inline' }, ...opmapFromTree(t) }); files.push(f); opmapNote = `saved opcode map ${f} (${t.handlers.length} handlers)`; }
      }
      if (a.format === 'json') return { text: JSON.stringify({ trees, notes: r.report.notes }, null, 2), data: { trees, notes: r.report.notes }, files };
      const t: string[] = [];
      t.push(`${r.report.trees.length} dispatch trees${r.cleaned ? ' (on cleaned code)' : ''}: ` + r.report.trees.map((x, i) => `#${i} ${x.kind} var=${x.var} line ${x.line} ${x.leaves} leaves ops ${x.minOp}..${x.maxOp}`).join(' | '));
      for (const n of r.report.notes) t.push('note: ' + n);
      if (saved.line) t.push(saved.line); if (opmapNote) t.push(opmapNote);
      for (const tr of trees) {
        const view = a.opcode !== undefined ? { ...tr, handlers: tr.handlers.filter(h => h.opcodes.includes(a.opcode!)) } : tr;
        t.push('', formatOpcodeTree(view, { code: a.code ?? false, lifted: a.lifted ?? true }));
      }
      return { text: t.join('\n'), data: { trees: trees.map(x => ({ id: x.id, kind: x.kind, var: x.var, line: x.line, leaves: x.leaves, roles: x.roles, handlers: x.handlers.map(h => ({ opcodes: h.opcodes, guess: h.guess, confidence: h.confidence, line: h.line })) })), notes: r.report.notes, savedScriptId: saved.id }, files };
    },
  }),
  defineTool({
    name: 'opmap_get', title: 'Get opcode map', category: 'vm', readOnly: true,
    description: 'Show a saved (editable) opcode map: opcode → mnemonic + pseudo-Lua template. Without name: list maps.',
    input: { name: z.string().optional(), ...FORMAT },
    run: (a, { ws }) => {
      if (!a.name) return { text: ws.listOpmaps().join('\n') || '(no opcode maps saved)', data: ws.listOpmaps() };
      const m = ws.getOpmap(a.name);
      if (a.format === 'json') return { text: JSON.stringify(m, null, 2), data: m };
      const rows = Object.entries(m).filter(([k]) => k !== '$meta').sort((x, y) => +x[0] - +y[0]).map(([k, v]) => { const e = typeof v === 'string' ? { name: v } : v as { name: string; lua?: string; notes?: string }; return [k, e.name, trunc(e.lua ?? '', 100), e.notes ?? '']; });
      return { text: (m.$meta ? `meta: ${JSON.stringify(m.$meta).slice(0, 300)}\n\n` : '') + table(rows, ['op', 'name', 'lua', 'notes']), data: m };
    },
  }),
  defineTool({
    name: 'opmap_set', title: 'Create / edit opcode map', category: 'vm',
    description: 'Create or edit a custom opcode map. "set" merges entries {opcode: "NAME"} or {opcode: {name, lua, notes}} (lua is a pseudo-code template using field letters, e.g. "R[A] = K[B]"); "remove" deletes opcodes; replace=true starts from scratch. Use this to correct guesses — vm_disasm uses the map.',
    input: { name: z.string(), set: z.record(OPENTRY).optional(), remove: z.array(z.union([z.string(), z.number()])).optional(), replace: z.boolean().optional() },
    run: (a, { ws }) => {
      let m: Record<string, unknown> = {};
      if (!a.replace) { try { m = ws.getOpmap(a.name); } catch { m = {}; } }
      for (const [k, v] of Object.entries(a.set ?? {})) m[k] = v;
      for (const k of a.remove ?? []) delete m[String(k)];
      const f = ws.setOpmap(a.name, m);
      return { text: `saved ${f}: ${Object.keys(m).filter(k => k !== '$meta').length} opcodes`, files: [f], data: m };
    },
  }),
  defineTool({
    name: 'vm_disasm', title: 'Custom VM disassembler', category: 'vm', readOnly: true,
    description: 'Disassemble instructions of ANY custom VM once you have extracted them statically (e.g. with your Python decoder): give the instruction list as JSON ([[op,a,b,c],…] or [{"op":..,"A":..},…]) or as a Lua table literal ({{1,0,5},…} / {{[1]=…}}), plus an opcode map (saved name or inline). Optional constants array resolves K[x] in templates. Prints mnemonic, operands and the substituted pseudo-Lua per instruction, plus an opcode histogram and unmapped opcodes.',
    input: {
      instructions: z.string().optional().describe('JSON or Lua-literal instruction list'),
      instructions_output: z.string().optional().describe('read the instruction list from a saved workspace output instead'),
      opmap: z.string().optional().describe('name of a saved opcode map'),
      opmap_inline: z.record(OPENTRY).optional(),
      op_field: z.union([z.string(), z.number()]).optional().describe('key/position of the opcode (auto)'),
      fields: z.record(z.string()).optional().describe('operand key → letter, e.g. {"2":"A","3":"B","4":"C"} (auto, or taken from the saved map roles)'),
      constants: z.string().optional().describe('JSON or Lua-literal constant array for K[x] substitution'),
      k_base: z.number().int().optional().describe('constant index base (default 1)'),
      key_base: z.number().int().min(0).max(1).optional().describe('index base for array-shaped instructions: 0 = JSON positions, 1 = Lua keys (inst[1] = first element). Default 1 when op field/operands come from a saved map\'s roles, else 0'),
      max: z.number().int().optional(),
      ...OUT,
    },
    run: (a, { ws }) => {
      const parse = (s: string): unknown => { const t = s.trim(); try { return JSON.parse(t); } catch { return luaLiteralToJson(t); } };
      const raw = a.instructions ?? (a.instructions_output ? ws.readOutput(a.instructions_output).toString('utf8') : undefined);
      if (!raw) throw new Error('provide instructions or instructions_output');
      let ins = parse(raw);
      if (ins && typeof ins === 'object' && !Array.isArray(ins)) ins = Object.keys(ins).sort((x, y) => +x - +y).map(k => (ins as Record<string, unknown>)[k]);
      let map: OpMap = {}; let fields = a.fields; let opField = a.op_field; let keyBase = a.key_base;
      if (a.opmap) {
        const m = ws.getOpmap(a.opmap) as Record<string, unknown>;
        const meta = m.$meta as { roles?: { fields?: Record<string, string>; opField?: string } } | undefined;
        if (!fields && meta?.roles?.fields && Object.keys(meta.roles.fields).length) fields = meta.roles.fields;
        if (opField === undefined && meta?.roles?.opField) { opField = meta.roles.opField; if (keyBase === undefined && /^\d+$/.test(meta.roles.opField)) keyBase = 1; }
        for (const [k, v] of Object.entries(m)) if (k !== '$meta') map[k] = v as OpMap[string];
      }
      if (a.opmap_inline) map = { ...map, ...a.opmap_inline };
      const consts = a.constants ? parse(a.constants) : undefined;
      const r = vmDisassemble(ins as unknown[], map, { keyBase, fields, opField, constants: Array.isArray(consts) ? consts : consts && typeof consts === 'object' ? Object.keys(consts).sort((x, y) => +x - +y).map(k => (consts as Record<string, unknown>)[k]) : undefined, kBase: a.k_base, max: a.max });
      const hist = '\n\nopcode histogram:\n' + table(r.histogram.slice(0, 80).map(h => [h.op, h.name, h.count]), ['op', 'name', 'count']);
      return { text: r.text + hist, data: { count: r.count, histogram: r.histogram, unknown: r.unknown, fields: r.fields, opField: r.opField } };
    },
  }),
  defineTool({
    name: 'chunk_disasm', title: 'Chunk explorer (decoded VM chunk → full disassembly)', category: 'vm', readOnly: false,
    description: 'Feed it the decoded chunk of ANY custom VM — typically the JSON printed by the Python port of the deserializer (python_transpile → run → lua_dump), or any JSON / Lua table literal. It infers the layout automatically (proto records, instruction array as tuples/records/packed words or parallel struct-of-arrays, constant array, nested protos of the same shape), picks the opcode field (from the opcode map roles, the map itself, or the data), then disassembles EVERY proto recursively with the opcode map and lists the strings found in the chunk (the VM\'s real constants). Give an opmap name, or a script (script_id/path/source) whose interpreter supplies the guessed map + operand roles automatically.',
    input: {
      chunk: z.string().optional().describe('decoded chunk: JSON text (lua_dump output; {"$bytes":hex} strings are decoded) or a Lua table literal'),
      chunk_path: z.string().optional().describe('path of a JSON file on the PRISM host'),
      chunk_output: z.string().optional().describe('read the chunk from a saved workspace output'),
      ...SRC,
      clean: z.boolean().optional().describe('with a script: clean it before extracting the opcode map (default true)'),
      opmap: z.string().optional().describe('name of a saved opcode map (its roles supply op field + operands)'),
      opmap_inline: z.record(OPENTRY).optional(),
      op_field: z.string().optional().describe('opcode key inside an instruction (Lua keys for lists: "1" = first element)'),
      fields: z.record(z.string()).optional().describe('operand key → letter, e.g. {"2":"A","3":"B","4":"C"}'),
      bits: z.string().optional().describe('packed 32-bit instruction words: "op:0:8 A:8:8 B:16:8 C:24:8" or preset luau | lua51'),
      select: z.string().optional().describe('key path to the root proto when auto-detection picks the wrong node, e.g. "L10123:12" or "1.2"'),
      proto: z.string().optional().describe('only list this proto (ids like F, F.0, F.3.1)'),
      max: z.number().int().optional().describe('instructions listed per proto (default 4000)'),
      strings: z.number().int().optional().describe('how many distinct strings to list (default 80, 0 = none)'),
      save_listing_as: z.string().optional().describe('save the full listing as a workspace output'),
      ...FORMAT, ...OUT,
    },
    run: (a, ctx) => {
      const raw = a.chunk ?? (a.chunk_path ? readFileChecked(a.chunk_path).toString('utf8') : a.chunk_output ? ctx.ws.readOutput(a.chunk_output).toString('utf8') : undefined);
      if (!raw) throw new Error('provide chunk (JSON / Lua literal), chunk_path or chunk_output');
      const t = raw.trim();
      let json: unknown;
      try { json = JSON.parse(t); } catch { json = luaLiteralToJson(t); }
      let map: OpMap = {}; let fields = a.fields; let opField = a.op_field; let from = '';
      const takeRoles = (roles?: { opField?: string; fields?: Record<string, string> }) => {
        if (!fields && roles?.fields && Object.keys(roles.fields).length) fields = roles.fields;
        if (opField === undefined && roles?.opField) opField = roles.opField;
      };
      if (a.opmap) {
        const m = ctx.ws.getOpmap(a.opmap) as Record<string, unknown>;
        takeRoles((m.$meta as { roles?: { fields?: Record<string, string>; opField?: string } } | undefined)?.roles);
        for (const [k, v] of Object.entries(m)) if (k !== '$meta') map[k] = v as OpMap[string];
        from = `opmap "${a.opmap}"`;
      } else if (a.script_id || a.path || a.source) {
        const { src, label } = getSource(a, ctx);
        const r = mapOpcodes(src, { clean: a.clean ?? true });
        const tr = r.report.trees.filter(x => x.kind === 'vm').sort((x, y) => y.score - x.score)[0] ?? r.report.trees[0];
        if (tr) { map = opmapFromTree(tr); takeRoles(tr.roles); from = `guessed from ${label} (tree #${tr.id} on ${tr.var}, ${tr.handlers.length} handlers)`; }
        else from = `no dispatch tree found in ${label}`;
      }
      if (a.opmap_inline) map = { ...map, ...a.opmap_inline };
      const r = chunkDisassemble(json, map, { opField, fields, bits: a.bits, select: a.select, proto: a.proto, max: a.max });
      const files: string[] = [];
      if (a.save_listing_as) files.push(ctx.ws.saveOutput(a.save_listing_as, r.text));
      const data = { layout: r.layout, rootPath: r.rootPath, protos: r.protos, totalInstructions: r.totalInstructions, histogram: r.histogram, unknown: r.unknown, strings: r.strings.slice(0, 2000), notes: r.notes, opmapFrom: from };
      if (a.format === 'json') return { text: JSON.stringify(data, null, 2), data, files };
      const ns = a.strings ?? 80;
      const strs = ns > 0 && r.strings.length ? `\n\n; STRINGS (${r.strings.length} distinct; most frequent first — proto of first use)\n` + r.strings.slice(0, ns).map(s => `;   ${String(s.count).padStart(5)}×  ${JSON.stringify(s.value.length > 120 ? s.value.slice(0, 120) + '…' : s.value)}   (${s.first})`).join('\n') : '';
      const hist = '\n\n; OPCODE HISTOGRAM\n' + table(r.histogram.slice(0, 60).map(h => [h.op, h.name.length > 40 ? h.name.slice(0, 39) + '…' : h.name, h.count]), ['op', 'name', 'count']).split('\n').map(l => '; ' + l).join('\n');
      return { text: (from ? `; opcode map: ${from}\n` : '') + r.text + strs + hist, data, files };
    },
  }),
];
