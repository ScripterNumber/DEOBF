import { z } from 'zod';
import { defineTool } from '../types.js';
import { SRC, OUT, BYTES, getSource, getBytes, table } from '../source.js';
import { disassembleBytecode, findEmbeddedBytecode, parseLuauBytecode, disassembleLuau, summarizeLuau, Blob } from '@prism/core';
import { runNative, withTempSource, resolveNative } from '../native.js';

export const bytecodeTools = [
  defineTool({
    name: 'bytecode_disasm', title: 'Bytecode disassembler (Luau / Lua 5.1)', category: 'bytecode', readOnly: true,
    description: 'Static disassembler for real bytecode blobs: Luau bytecode v3–v14 (incl. Roblox op*227 encoded opcodes, auto-detected) and Lua 5.1 (luac / FiOne / Rerubi payloads). Output matches luau-compile --text / luac -l exactly in compat style; the rich style adds pc, labels, constant tables, local/upvalue names and a pseudo-Lua reading of every instruction. Input: data (hex/base64/Lua escapes/decimal), file, saved output, or a string literal of a workspace script.',
    input: {
      ...BYTES,
      format: z.enum(['auto', 'luau', 'lua51']).optional(),
      style: z.enum(['rich', 'luau']).optional().describe("rich (default) or 'luau' = exact luau-compile --text / luac -l layout"),
      opcode_encoding: z.enum(['auto', 'plain', 'roblox']).optional().describe('Luau opcode byte encoding (auto-detected)'),
      hex: z.boolean().optional().describe('show raw instruction words'), lift: z.boolean().optional().describe('pseudo-Lua comments (default true)'),
      constants: z.boolean().optional().describe('print constant tables (default true)'),
      protos: z.array(z.number().int()).optional().describe('only these function ids (Luau)'),
      max_insns: z.number().int().optional(),
      ...OUT,
    },
    run: (a, ctx) => {
      const { bytes, how } = getBytes(a, ctx);
      const r = disassembleBytecode(bytes, { format: a.format, style: a.style, encoding: a.opcode_encoding, hex: a.hex, lift: a.lift, constants: a.constants, protos: a.protos, maxInsns: a.max_insns });
      return { text: `; input: ${how}, ${bytes.length} bytes\n` + r.text, data: { format: r.format, summary: r.summary } };
    },
  }),
  defineTool({
    name: 'find_embedded_bytecode', title: 'Find embedded bytecode', category: 'bytecode', readOnly: true,
    description: 'Scan every string literal of a script (raw bytes, base64- and hex-decoded) for embedded Lua 5.x / Luau bytecode. Feed hits to bytecode_disasm with from_script + string_line.',
    input: { ...SRC },
    run: (a, ctx) => {
      const { src } = getSource(a, ctx);
      const hits = findEmbeddedBytecode(src);
      return { text: hits.length ? table(hits.map(h => [h.line, h.via, h.format, h.length + ' B', h.preview]), ['line', 'via', 'format', 'size', 'head']) : 'no embedded bytecode found in string literals', data: hits };
    },
  }),
  defineTool({
    name: 'luau_compile', title: 'Luau compiler (native)', category: 'luau', readOnly: true,
    description: 'Compile Luau source with the bundled official luau-compile (compile only, never runs). Modes: prism (binary → PRISM rich disassembly with pseudo-Lua), text (luau-compile --text with source lines), remarks (inlining/fastcall remarks), constants (text + constant tables), summary (opcode distribution + function table), codegen / codegenir / codegenasm / codegenverbose (native codegen views), binary (hex; saved to outputs with save_as). Useful to learn how real Luau code looks in bytecode, to compare against a VM\'s opcode set, or to check that deobfuscated code still compiles.',
    input: {
      ...SRC, mode: z.enum(['prism', 'text', 'remarks', 'constants', 'summary', 'codegen', 'codegenir', 'codegenasm', 'codegenverbose', 'binary']).optional(),
      optimize: z.number().int().min(0).max(2).optional().describe('-O level (default 1)'), debug: z.number().int().min(0).max(2).optional().describe('-g level (default 1; 2 keeps local names)'),
      type_info: z.number().int().min(0).max(1).optional(), target: z.enum(['a64', 'x64', 'a64_nf', 'x64_ms']).optional(),
      ...OUT,
    },
    run: async (a, ctx) => {
      const { src } = getSource(a, ctx);
      const mode = a.mode ?? 'prism';
      const base = [`-O${a.optimize ?? 1}`, `-g${a.debug ?? (mode === 'prism' ? 2 : 1)}`, `-t${a.type_info ?? 0}`, ...(a.target ? [`--target=${a.target}`] : [])];
      const bin = resolveNative(ctx.luauDir, 'luau-compile');
      return withTempSource(src, '.luau', async file => {
        const argv = mode === 'prism' || mode === 'binary' || mode === 'summary' ? ['--binary', ...base, file]
          : mode === 'constants' ? ['--text', '--dump-constants', ...base, file]
          : [`--${mode}`, ...base, file];
        const r = await runNative(bin, argv, { timeoutMs: 120000 });
        if (r.timedOut) throw new Error('luau-compile timed out');
        if (mode === 'prism' || mode === 'binary' || mode === 'summary') {
          const bytes = new Uint8Array(r.stdout);
          if (!bytes.length || bytes[0] === 0) return { text: 'compile error:\n' + (bytes.length ? Buffer.from(bytes.subarray(1)).toString() : r.stderr), data: { ok: false } };
          if (mode === 'binary') {
            const files = a.save_as ? [ctx.ws.saveOutput(a.save_as, bytes)] : [];
            return { text: `${bytes.length} bytes of Luau bytecode v${bytes[0]}${files.length ? ` — saved ${files[0]}` : ''}\n` + Blob.hexdump(bytes, 1 << 16), data: { size: bytes.length, hex: Blob.hexencode(bytes) }, files };
          }
          if (mode === 'summary') {
            const sm = summarizeLuau(parseLuauBytecode(bytes));
            const hist = Object.entries(sm.opcodeHistogram).sort((x, y) => y[1] - x[1]);
            const total = hist.reduce((n, [, c]) => n + c, 0);
            return { text: `bytecode v${sm.version}, ${sm.protos.length} functions, ${total} instructions, ${bytes.length} bytes\n\nopcode distribution:\n` + table(hist.map(([op, c]) => [op, c, (c / total * 100).toFixed(1) + '%']), ['op', 'count', 'share']) + `\n\nfunctions:\n` + table(sm.protos.map(p => [`P${p.id}`, p.name, p.line, p.params + (p.vararg ? '+...' : ''), p.upvalues, p.instructions, p.constants]), ['id', 'name', 'line', 'params', 'upvals', 'insns', 'consts']) + (sm.imports.length ? `\n\nimports: ${sm.imports.join(', ')}` : ''), data: sm };
          }
          return { text: disassembleLuau(parseLuauBytecode(bytes)), data: { size: bytes.length } };
        }
        const out = r.stdout.toString('utf8').split(file).join('input.luau');
        return { text: (out || r.stderr || '(no output)').trimEnd() + (r.code ? `\n[exit ${r.code}] ${r.stderr.split(file).join('input.luau')}` : ''), data: { exit: r.code } };
      });
    },
  }),
  defineTool({
    name: 'luau_analyze', title: 'Luau type checker / linter (native)', category: 'luau', readOnly: true,
    description: 'Run the bundled luau-analyze (type checking + lint, static) on a script. annotate=true returns the source with inferred type annotations.',
    input: { ...SRC, strict: z.boolean().optional(), annotate: z.boolean().optional(), ...OUT },
    run: async (a, ctx) => {
      const { src } = getSource(a, ctx);
      return withTempSource(src, '.luau', async file => {
        const r = await runNative(resolveNative(ctx.luauDir, 'luau-analyze'), [...(a.annotate ? ['--annotate'] : ['--formatter=plain']), `--mode=${a.strict ? 'strict' : 'nonstrict'}`, file], { timeoutMs: 120000 });
        const out = (r.stdout.toString('utf8') + r.stderr).split(file).join('input.luau').trimEnd();
        const n = a.annotate ? 0 : out.split('\n').filter(l => l.trim()).length;
        return { text: out || 'no issues', data: { exit: r.code, issues: n } };
      });
    },
  }),
  defineTool({
    name: 'luau_ast', title: 'Luau AST (native JSON)', category: 'luau', readOnly: true,
    description: 'Official Luau parser AST as JSON (luau-ast). Large — use max_chars / save_as.',
    input: { ...SRC, ...OUT },
    run: async (a, ctx) => {
      const { src } = getSource(a, ctx);
      return withTempSource(src, '.luau', async file => {
        const r = await runNative(resolveNative(ctx.luauDir, 'luau-ast'), [file], { timeoutMs: 120000 });
        return { text: r.stdout.toString('utf8') || r.stderr, data: { exit: r.code } };
      });
    },
  }),
];
