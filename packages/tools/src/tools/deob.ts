import { z } from 'zod';
import { defineTool } from '../types.js';
import { SRC, OUT, getSource, numbered, table } from '../source.js';
import { clean, renameSymbols, simplifyExpression } from '@prism/core';
import type { ToolContext } from '../types.js';

/** store a derived script and report it */
export function saveDerived(ctx: ToolContext, name: string | undefined, code: string, parent: string | undefined, how: string): { line: string; id?: string } {
  if (!name) return { line: '' };
  const m = ctx.ws.addScript(name, code, { parent, derivedBy: how });
  return { line: `saved as script_id "${m.id}"`, id: m.id };
}

export const deobTools = [
  defineTool({
    name: 'deobfuscate', title: 'Deobfuscate / junk removal', category: 'deobfuscation',
    description: 'Universal static cleanup pipeline (no execution): outlined method-table recovery (Superflow-style tables of tiny single-call-site helpers / state-machine blocks: literal self[k] slots folded, helpers re-inlined when the method space is provably closed), constant & MBA folding (number/bit32 junk), string recovery (string.char / escapes / concat chains), dead-branch pruning, opaque-predicate & state-guard folding, loop-once/while-break unrolling, constant & alias propagation, unused local/assignment removal, paren stripping, optional role-based renaming. Every pass can be toggled. Use save_script_as to store the result as a new workspace script for further analysis.',
    input: {
      ...SRC,
      rename: z.enum(['none', 'obfuscated', 'all']).optional().describe('role-based renaming: none (default), obfuscated-looking names only, or all locals'),
      fold_constants: z.boolean().optional(), recover_strings: z.boolean().optional(), remove_dead_code: z.boolean().optional(),
      propagate: z.boolean().optional(), remove_unused_locals: z.boolean().optional(), strip_parens: z.boolean().optional(), control_flow: z.boolean().optional(),
      outline: z.boolean().optional().describe('recover obfuscator-outlined method tables (default on; no-op when no such table exists)'),
      rounds: z.number().int().min(1).max(50).optional().describe('max fixpoint rounds (default 8)'),
      show_rename_map: z.boolean().optional(),
      save_script_as: z.string().optional().describe('store the cleaned code as a new workspace script with this name'),
      ...OUT,
    },
    run: (a, ctx) => {
      const { src, scriptId } = getSource(a, ctx);
      const r = clean(src, { rename: a.rename ?? 'none', foldConstants: a.fold_constants, recoverStrings: a.recover_strings, removeDeadCode: a.remove_dead_code, propagate: a.propagate, removeUnusedLocals: a.remove_unused_locals, stripParens: a.strip_parens, controlFlow: a.control_flow, outline: a.outline, rounds: a.rounds });
      const s = r.stats;
      const nz = Object.entries(s).filter(([, v]) => v).map(([k, v]) => `${k}=${v}`).join(' ');
      const saved = saveDerived(ctx, a.save_script_as, r.code, scriptId, 'deobfuscate');
      const head = `-- PRISM deobfuscate: ${src.length} → ${r.code.length} chars, ${r.rounds} rounds, ${nz || 'no changes'}${r.parseErrors ? `, ${r.parseErrors} parse errors` : ''}${saved.line ? '\n-- ' + saved.line : ''}\n`;
      const map = a.show_rename_map && r.renameMap.length ? '\n\n-- rename map:\n' + r.renameMap.map(m => `--   ${m.from} → ${m.to} (line ${m.line}, ${m.kind})`).join('\n') : '';
      return { text: head + r.code + map, data: { stats: s, rounds: r.rounds, renameMap: r.renameMap, parseErrors: r.parseErrors, savedScriptId: saved.id, code: r.code } };
    },
  }),
  defineTool({
    name: 'simplify_expression', title: 'Simplify expression', category: 'deobfuscation', readOnly: true,
    description: 'Constant-fold one Lua expression (arithmetic / bit32 / MBA junk / string.char / # of literals), e.g. "bit32.bxor(0x5A, 3) + #\'abc\' * 2^3" → 113. Several expressions can be given separated by newlines.',
    input: { expression: z.string() },
    run: a => {
      const exprs = a.expression.split('\n').map(e => e.trim()).filter(Boolean);
      const res = exprs.map(e => { try { return { expr: e, ...simplifyExpression(e) }; } catch (err) { return { expr: e, result: 'error: ' + (err as Error).message, changed: false }; } });
      return { text: res.map(r => exprs.length > 1 ? `${r.expr}  ⇒  ${r.result}` : r.result).join('\n'), data: res };
    },
  }),
  defineTool({
    name: 'rename_symbols', title: 'Rename symbols', category: 'deobfuscation',
    description: 'Scope-aware renaming of local variables / parameters / local functions that preserves the original formatting (only identifiers change). Each request: {name, to, line?} where line is the declaration line (or any line where that binding is used) to disambiguate; all=true renames every binding with that name.',
    input: { ...SRC, renames: z.array(z.object({ name: z.string(), to: z.string(), line: z.number().int().optional(), all: z.boolean().optional() })).min(1), save_script_as: z.string().optional().describe('store the renamed code as a workspace script (use the same name to keep a single evolving copy)'), ...OUT },
    run: (a, ctx) => {
      const { src, scriptId } = getSource(a, ctx);
      const r = renameSymbols(src, a.renames);
      const saved = r.applied.length ? saveDerived(ctx, a.save_script_as, r.code, scriptId, 'rename_symbols') : { line: '' };
      const t = [
        r.applied.length ? 'renamed:\n' + table(r.applied.map(x => [x.name, '→', x.to, `line ${x.line}`, x.kind, `${x.sites} sites`])) : 'nothing renamed',
        ...r.errors.map(e => 'error: ' + e), ...r.warnings.map(w => 'warning: ' + w), saved.line,
      ].filter(Boolean);
      return { text: t.join('\n') + (saved.id ? '' : '\n\n' + r.code), data: { applied: r.applied, errors: r.errors, warnings: r.warnings, savedScriptId: saved.id } };
    },
  }),
  defineTool({
    name: 'get_lines', title: 'View lines', category: 'search', readOnly: true,
    description: 'Show a numbered line range of a script (with optional context around a single line). Mark lines of interest with ">".',
    input: { ...SRC, line: z.number().int().optional().describe('center line'), context: z.number().int().optional().describe('lines of context around "line" (default 15)'), from_line: z.number().int().optional(), to_line: z.number().int().optional(), ...OUT },
    run: (a, ctx) => {
      const { src } = getSource(a, ctx);
      const c = a.context ?? 15;
      const from = a.from_line ?? (a.line ? a.line - c : 1), to = a.to_line ?? (a.line ? a.line + c : from + 2 * c);
      return { text: numbered(src, from, to, a.line ? new Set([a.line]) : undefined) };
    },
  }),
];
