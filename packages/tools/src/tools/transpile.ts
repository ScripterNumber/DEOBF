import { z } from 'zod';
import { defineTool } from '../types.js';
import { SRC, OUT, getSource } from '../source.js';
import { luaToPython, functionToPython, functionToLua, decodeBundle, luaLiteralToJson, inlineValues, clean, parse } from '@prism/core';
import { readFileChecked } from '../source.js';
import { saveDerived } from './deob.js';

export const transpileTools = [
  defineTool({
    name: 'python_transpile', title: 'Lua → Python', category: 'transpile', readOnly: true,
    description: 'Transpile Lua/Luau to standalone Python 3 with a faithful Lua-semantics prelude (tables, metatables, multiple returns, truthiness, string library incl. Lua patterns, bit32, math, utf8). Whole script, or just one function (by name / line) together with the local helper functions and static upvalues it depends on — ideal to port a constant/bytecode unpacker to Python and run it OUTSIDE of Lua. The output is only generated, never executed by PRISM. With a function: the output is a runnable program — its __main__ calls the function at every call site whose arguments are statically known (identical argument lists computed once) and prints ONE JSON object {"L<line>:<col>": result} (lua_dump encoding: tables → list/dict, non-text strings → {"$bytes": hex}); run `python3 file.py out.json` to save it, then feed it to inline_values (decoded constants back into the Lua) or chunk_disasm (a dumped VM chunk). Long programs are also saved to workspace outputs/.',
    input: {
      ...SRC, function: z.union([z.string(), z.number()]).optional().describe('function name or a line inside it (omit = whole script)'),
      prelude: z.boolean().optional().describe('include the Lua runtime prelude (default true)'),
      calls: z.boolean().optional().describe('with function: emit the __main__ that evaluates every static call site (default true)'),
      max_calls: z.number().int().min(1).max(20000).optional().describe('distinct argument lists evaluated by __main__ (default 1000)'),
      save_py_as: z.string().optional().describe('save the program as workspace outputs/<name> (done automatically when it is longer than max_chars)'),
      ...OUT,
    },
    run: (a, ctx) => {
      const { src } = getSource(a, ctx);
      if (a.function !== undefined) {
        const r = functionToPython(src, a.function, { prelude: a.prelude ?? true, calls: a.calls, maxCalls: a.max_calls ?? 1000 });
        if (!r) return { text: `no function matches "${a.function}" — try list_functions` };
        const files: string[] = [];
        const pyName = a.save_py_as ?? ((r.code.length + 400 > (a.max_chars ?? 60000)) ? `${r.name.replace(/[^\w]+/g, '_') || 'fn'}_L${r.line}.py` : undefined);
        if (pyName) files.push(ctx.ws.saveOutput(pyName, r.code));
        const head = `# PRISM: ${r.name} (line ${r.line})${r.deps?.length ? ` + deps: ${r.deps.join(', ')}` : ''}${r.freeNames.length ? `\n# free names (globals): ${r.freeNames.join(', ')}` : ''}${r.warnings.length ? '\n# warnings:\n' + r.warnings.map(w => '#   ' + w).join('\n') : ''}${pyName ? `\n# full program saved: ${files[0]} (absolute: ${ctx.ws.abs(files[0])}) — run: python3 ${pyName} out.json` : ''}\n`;
        return { text: head + r.code, files, data: { name: r.name, line: r.line, deps: r.deps, warnings: r.warnings, freeNames: r.freeNames, savedProgram: files[0] } };
      }
      const r = luaToPython(src, { prelude: a.prelude ?? true });
      const head = `${r.freeNames.length ? `# free names (globals): ${r.freeNames.join(', ')}\n` : ''}${r.warnings.length ? '# warnings:\n' + r.warnings.map(w => '#   ' + w).join('\n') + '\n' : ''}`;
      return { text: head + r.code, data: { warnings: r.warnings, freeNames: r.freeNames } };
    },
  }),
  defineTool({
    name: 'lua_slice', title: 'Lua slice (exact, runnable)', category: 'transpile', readOnly: true,
    description: 'Extract ONE function (name or a line inside it) together with its whole static dependency closure — helper functions, upvalues with static initializers, globals assigned once, statements that fill its tables — as a standalone Lua/Luau program in original source order (clashing names renamed, Lua 5.1/5.3 compat shims incl. pure-Lua bit32), plus a harness that evaluates every call site with static arguments and prints ONE JSON object {"L<line>:<col>": value} — the same contract as python_transpile, so inline_values / chunk_disasm / behavior_report consume it. Use it when the Python port hits an exotic construct, or to cross-check it. PRISM never runs it; the user does: `lua5.1 slice.lua out.json` or `luau slice.lua > out.json`.',
    input: {
      ...SRC, function: z.union([z.string(), z.number()]).describe('function name or a line inside it (decoder / deserializer from constants or vm_anatomy)'),
      calls: z.boolean().optional().describe('emit the call-site harness (default true)'),
      max_calls: z.number().int().min(1).max(20000).optional().describe('distinct argument lists evaluated (default 1000)'),
      prelude: z.boolean().optional().describe('include the compat shims (unpack/loadstring/bit32 for hosts without them; default true)'),
      save_slice_as: z.string().optional().describe('save the program as workspace outputs/<name> (done automatically when it is longer than max_chars)'),
      ...OUT,
    },
    run: (a, ctx) => {
      const { src } = getSource(a, ctx);
      const r = functionToLua(src, a.function, { prelude: a.prelude ?? true, calls: a.calls, maxCalls: a.max_calls ?? 1000 });
      if (!r) return { text: `no function matches "${a.function}" — try list_functions` };
      const files: string[] = [];
      const nm = a.save_slice_as ?? ((r.code.length + 400 > (a.max_chars ?? 60000)) ? `${r.name.replace(/[^\w]+/g, '_') || 'fn'}_L${r.line}.slice.lua` : undefined);
      if (nm) files.push(ctx.ws.saveOutput(nm, r.code));
      const head = `-- PRISM lua_slice: ${r.name} (line ${r.line}) · ${r.deps.length} helper(s) · ${r.sites} call site(s)${files[0] ? ` · saved ${files[0]}` : ''}${r.warnings.length ? '\n-- warnings: ' + r.warnings.join(' | ') : ''}\n`;
      return { text: head + r.code, files, data: { name: r.name, line: r.line, deps: r.deps, freeNames: r.freeNames, renamed: r.renamed, sites: r.sites, warnings: r.warnings, savedProgram: files[0] } };
    },
  }),
  defineTool({
    name: 'decode_bundle', title: 'Decode bundle (all decoders → one program)', category: 'transpile', readOnly: true,
    description: 'ONE runnable program for ALL decoders of a script: picks every decoder candidate called with literal arguments (or the functions you list), ports each with its dependency closure (python: shared Lua-semantics prelude, every decoder in its own namespace; lua: exact original slices, each in its own do…end block) and evaluates every static call site of every decoder. The user runs it once (`python3 bundle.py out.json` / `luau bundle.lua > out.json`) and gets ONE JSON {"L<line>:<col>": value} for the whole script → inline_values {values_path} on the SAME script, then deobfuscate to fold. Generated statically; PRISM never executes it.',
    input: {
      ...SRC,
      functions: z.array(z.union([z.string(), z.number()])).optional().describe('decoders to include (names or lines); omit = auto-pick decoder candidates with literal-argument calls'),
      lang: z.enum(['python', 'lua']).optional().describe('python (default) or lua (exact slices)'),
      max_decoders: z.number().int().min(1).max(40).optional().describe('auto-pick at most this many decoders (default 6)'),
      max_calls: z.number().int().min(1).max(20000).optional().describe('distinct argument lists per decoder (default 1000)'),
      save_program_as: z.string().optional().describe('save the program as workspace outputs/<name> (done automatically when it is longer than max_chars)'),
      ...OUT,
    },
    run: (a, ctx) => {
      const { src, label } = getSource(a, ctx);
      const lang = a.lang ?? 'python';
      const r = decodeBundle(src, a.functions?.length ? a.functions : 'auto', { lang, maxCalls: a.max_calls ?? 1000, maxDecoders: a.max_decoders, label });
      const files: string[] = [];
      const ext = lang === 'lua' ? '.bundle.lua' : '.bundle.py';
      const base = label.replace(/\s*\[.*$/, '').replace(/\.(lua|luau|txt)$/i, '').replace(/[^\w.-]+/g, '_') || 'script';
      const nm = a.save_program_as ?? ((r.code.length + 600 > (a.max_chars ?? 60000)) ? base + ext : undefined);
      if (nm) files.push(ctx.ws.saveOutput(nm, r.code));
      const c = lang === 'lua' ? '--' : '#';
      const head = [`${c} PRISM decode_bundle (${lang}): ${r.parts.filter(p => !p.error).length} decoder(s), ${r.sites} call site(s)${files[0] ? ` · saved ${files[0]}` : ''}`,
        ...r.parts.map((p, i) => `${c}   [${i + 1}] ${p.error ? `${p.query}: ${p.error}` : `${p.name} L${p.line}${p.kind ? ' ' + p.kind : ''} — ${p.sites} site(s)${p.deps.length ? ', deps ' + p.deps.join(', ') : ''}${p.freeNames.length ? ', free ' + p.freeNames.join(', ') : ''}`}`),
        ...r.warnings.slice(0, 8).map(w => `${c} warning: ${w}`),
        `${c} run: ${lang === 'lua' ? 'luau bundle.lua > out.json' : 'python3 bundle.py out.json'}  →  inline_values {${a.script_id ? `script_id:"${a.script_id}", ` : ''}values_path:"out.json", save_script_as:"…"}`, ''].join('\n');
      return { text: head + (files[0] && r.code.length + 600 > (a.max_chars ?? 60000) ? `${c} (program saved to ${files[0]} — workspace_read_output to read it)\n` + r.code.slice(0, 1500) : r.code), files, data: { lang, parts: r.parts, sites: r.sites, warnings: r.warnings, savedProgram: files[0] } };
    },
  }),
  defineTool({
    name: 'lua_literal_to_json', title: 'Lua literal → JSON', category: 'transpile', readOnly: true,
    description: 'Statically convert a Lua table/constant literal ({1,2,{x="y"}}) into JSON — handy for constant pools and instruction tables found in scripts (combine with get_lines / pattern_search).',
    input: { literal: z.string().optional(), ...SRC, line: z.number().int().optional().describe('with script_id/path/source: convert the table literal assigned/starting on this line'), ...OUT },
    run: (a, ctx) => {
      let lit = a.literal;
      if (!lit) {
        const { src } = getSource(a, ctx);
        if (a.line === undefined) lit = src;
        else {
          const lines = src.split('\n'); let off = 0; for (let i = 0; i < a.line - 1; i++) off += lines[i].length + 1;
          const start = src.indexOf('{', off); if (start < 0) throw new Error('no { on or after line ' + a.line);
          let depth = 0, i = start, q = '';
          for (; i < src.length; i++) { const c = src[i]; if (q) { if (c === '\\') i++; else if (c === q) q = ''; continue; } if (c === '"' || c === "'") q = c; else if (c === '{') depth++; else if (c === '}' && --depth === 0) break; }
          lit = src.slice(start, i + 1);
        }
      }
      const v = luaLiteralToJson(lit);
      return { text: JSON.stringify(v), data: v };
    },
  }),
  defineTool({
    name: 'inline_values', title: 'Inline decoded values back into Lua', category: 'deobfuscation', readOnly: false,
    description: 'Closes the static decoding loop: takes the JSON your Python port printed ({"L<line>:<col>": value} — the __main__ of python_transpile produces exactly this) and replaces each of those call sites in the SAME Lua source with the literal value (strings with exact byte escapes, numbers, booleans, nil, small tables). Formatting of the rest of the file is preserved; calls that raised, returned functions/multiple values or would produce oversized literals are skipped with a reason. Optionally re-runs deobfuscate so string ops on the new literals fold. Use the script the Python was generated from (usually the cleaned copy).',
    input: {
      ...SRC,
      values: z.string().optional().describe('JSON object {"L<line>:<col>": value, …} (the output of the Python __main__)'),
      values_path: z.string().optional().describe('path of that JSON file on the PRISM host'),
      values_output: z.string().optional().describe('name of a workspace output holding the JSON'),
      callee: z.string().optional().describe('only replace calls of this function name (safety filter)'),
      max_len: z.number().int().optional().describe('longest literal to inject (default 4000 chars)'),
      tables: z.boolean().optional().describe('also inject table values as constructors (default true)'),
      reclean: z.boolean().optional().describe('run deobfuscate (rename:none) on the result (default false)'),
      save_script_as: z.string().optional().describe('store the result as a new workspace script'),
      ...OUT,
    },
    run: (a, ctx) => {
      const { src, scriptId } = getSource(a, ctx);
      const raw = a.values ?? (a.values_path ? readFileChecked(a.values_path).toString('utf8') : a.values_output ? ctx.ws.readOutput(a.values_output).toString('utf8') : undefined);
      if (!raw) throw new Error('provide values (JSON), values_path or values_output');
      let values: unknown;
      try { values = JSON.parse(raw); } catch (e) { throw new Error('values is not valid JSON: ' + (e as Error).message); }
      if (!values || typeof values !== 'object' || Array.isArray(values)) throw new Error('values must be a JSON object keyed by call site, e.g. {"L12:5": "decoded"}');
      const r = inlineValues(src, values as Record<string, unknown>, { callee: a.callee, maxLen: a.max_len, tables: a.tables });
      let code = r.code;
      let note = '';
      if (a.reclean) { const c = clean(code, { rename: 'none' }); code = c.code; note = ` · re-cleaned (${c.rounds} rounds)`; }
      const pe = parse(code).errors.length;
      const saved = saveDerived(ctx, a.save_script_as, code, scriptId, 'inline_values');
      const reasons = new Map<string, number>();
      for (const s of r.skipped) reasons.set(s.reason, (reasons.get(s.reason) ?? 0) + 1);
      const text = [
        `inline_values: ${r.replaced.length} call site(s) replaced, ${r.skipped.length} skipped${note}${pe ? ` · WARNING: ${pe} parse errors in the result` : ''}${saved.line ? ' · ' + saved.line : ''}`,
        ...r.replaced.slice(0, 30).map(x => `  ${x.key.padEnd(12)} ${x.callee} → ${x.literal}`),
        r.replaced.length > 30 ? `  … ${r.replaced.length - 30} more` : '',
        ...[...reasons].map(([k, v]) => `  skipped ×${v}: ${k}`),
        '', '-- result --', code,
      ].filter(l => l !== '').join('\n');
      return { text, data: { replaced: r.replaced, skipped: r.skipped, savedScriptId: saved.id, parseErrors: pe } };
    },
  }),
];
