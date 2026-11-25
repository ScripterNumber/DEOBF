import { z } from 'zod';
import { defineTool } from '../types.js';
import { SRC, OUT, FORMAT, getSource, table, trunc } from '../source.js';
import { searchPattern, xrefs, getFunction, constants, bytesToDisplay } from '@prism/core';

export const searchTools = [
  defineTool({
    name: 'find_text', title: 'Find text / regex', category: 'search', readOnly: true,
    description: 'grep inside a script: plain substring or JavaScript regex, with context lines and match counts. Good for locating getfenv/loadstring/string.byte usage, magic numbers, key strings…',
    input: { ...SRC, pattern: z.string(), regex: z.boolean().optional(), ignore_case: z.boolean().optional(), context: z.number().int().min(0).max(20).optional(), max: z.number().int().optional(), ...OUT },
    run: (a, ctx) => {
      const { src } = getSource(a, ctx);
      const flags = 'g' + (a.ignore_case ? 'i' : '');
      const re = a.regex ? new RegExp(a.pattern, flags) : new RegExp(a.pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), flags);
      const lines = src.split('\n'); const c = a.context ?? 0; const max = a.max ?? 200;
      const hits: Array<{ line: number; col: number; match: string }> = [];
      let total = 0;
      lines.forEach((l, i) => { re.lastIndex = 0; let m: RegExpExecArray | null; while ((m = re.exec(l))) { total++; if (hits.length < max) hits.push({ line: i + 1, col: m.index + 1, match: m[0] }); if (!m[0].length) re.lastIndex++; } });
      const out: string[] = [`${total} matches${total > hits.length ? ` (showing ${hits.length})` : ''}`];
      let lastShown = 0;
      for (const h of hits) {
        if (c === 0) { out.push(`${h.line}:${h.col}: ${trunc(lines[h.line - 1].trim(), 240)}`); continue; }
        const from = Math.max(1, h.line - c, lastShown + 1), to = Math.min(lines.length, h.line + c);
        if (from > lastShown + 1 && lastShown) out.push('--');
        for (let i = from; i <= to; i++) out.push(`${i === h.line ? '>' : ' '}${i}: ${trunc(lines[i - 1], 240)}`);
        lastShown = to;
      }
      return { text: out.join('\n'), data: { total, hits } };
    },
  }),
  defineTool({
    name: 'pattern_search', title: 'Structural search (AST pattern)', category: 'search', readOnly: true,
    description: 'Search code by AST shape, not text. Metavariables: $X (any expression; repeated $X must match the same code), $_ (wildcard), $$$ (any number of args/items/statements). Examples: "string.char($$$)", "$T[$K] = $T[$K] + 1", "local $A = $B .. $C", "for $I = 1, #$S do $$$ end", "bit32.bxor($X, $X)".',
    input: { ...SRC, pattern: z.string(), kind: z.enum(['auto', 'expr', 'stat']).optional(), max: z.number().int().optional(), ...FORMAT, ...OUT },
    run: (a, ctx) => {
      const { src } = getSource(a, ctx);
      const r = searchPattern(src, a.pattern, { max: a.max ?? 300, kind: a.kind });
      if (a.format === 'json') return { text: JSON.stringify(r, null, 2), data: r };
      if (r.error) return { text: 'pattern error: ' + r.error, data: r };
      const t = [`${r.total} ${r.kind} matches${r.total > r.matches.length ? ` (showing ${r.matches.length})` : ''}`];
      for (const m of r.matches) {
        const b = Object.entries(m.bindings).map(([k, v]) => `${k}=${trunc(v, 60)}`).join('  ');
        t.push(`${m.line}:${m.col}: ${trunc(m.text.replace(/\s+/g, ' '), 200)}${b ? '\n      ' + b : ''}`);
      }
      return { text: t.join('\n'), data: r };
    },
  }),
  defineTool({
    name: 'xrefs', title: 'Cross references', category: 'search', readOnly: true,
    description: 'Scope-aware cross references of a variable: every binding named `name` (or only the one visible at `line`) with its declaration, reads and writes (line, column, code). Globals are listed too.',
    input: { ...SRC, name: z.string(), line: z.number().int().optional(), max: z.number().int().optional(), ...FORMAT, ...OUT },
    run: (a, ctx) => {
      const { src } = getSource(a, ctx);
      const r = xrefs(src, a.name, { line: a.line, max: a.max ?? 500 });
      if (a.format === 'json') return { text: JSON.stringify(r, null, 2), data: r };
      if (!r.length) return { text: `no binding or global named "${a.name}"`, data: r };
      const t: string[] = [];
      for (const b of r) {
        t.push(`${b.kind} ${b.name} (line ${b.line}) — ${b.reads} reads, ${b.writes} writes${b.captured ? ', captured by closures' : ''}`);
        for (const x of b.refs) t.push(`  ${x.kind.padEnd(5)} ${x.line}:${x.col}  ${trunc(x.text, 200)}`);
      }
      return { text: t.join('\n'), data: r };
    },
  }),
  defineTool({
    name: 'get_function', title: 'Get function source', category: 'search', readOnly: true,
    description: 'Extract the full source of one function by call-graph id (f12), name (local/field/method name) or by a line number inside it (innermost function wins).',
    input: { ...SRC, query: z.union([z.string(), z.number()]).describe('function id, name, or line number'), ...OUT },
    run: (a, ctx) => {
      const { src } = getSource(a, ctx);
      const f = getFunction(src, a.query);
      if (!f) return { text: `no function matches "${a.query}" — try list_functions` };
      return { text: `-- ${f.id} ${f.name} (lines ${f.line}-${f.endLine}, params: ${f.params.join(', ') || 'none'})\n${f.code}`, data: f };
    },
  }),
  defineTool({
    name: 'constants', title: 'Constant finder', category: 'search', readOnly: true,
    description: 'Inventory of every literal: strings (kind: url/api/identifier/alphabet/hex/base64/binary/blob/text, entropy, count, lines), numbers (byte/large/float/pow2/xor-operand/mod-operand tags), numeric & string-pool arrays, KEY candidates and DECODER candidates (deserializers, string decoders, constant decryptors/accessors, bit helpers, decode loops) ranked by score with call sites. Use it to find the constant + bytecode unpacker.',
    input: { ...SRC, section: z.enum(['all', 'summary', 'strings', 'numbers', 'arrays', 'decoders', 'keys']).optional(), max: z.number().int().optional().describe('max rows per section (default 60)'), ...FORMAT, ...OUT },
    run: (a, ctx) => {
      const { src } = getSource(a, ctx);
      const max = a.max ?? 60;
      const r = constants(src, { maxStrings: Math.max(max, 300), maxNumbers: Math.max(max, 300), maxArrays: Math.max(max, 100), maxDecoders: Math.max(max, 50) });
      if (a.format === 'json') return { text: JSON.stringify(r, null, 2), data: r };
      const s = a.section ?? 'all'; const t: string[] = [];
      const S = r.summary;
      t.push(`summary: ${S.strings} strings (${S.uniqueStrings} unique), ${S.numbers} numbers (${S.uniqueNumbers} unique), ${S.arrays} arrays, ${S.decoders} decoder candidates, ${S.bytes} literal bytes`);
      if (s === 'all' || s === 'decoders') {
        t.push('', 'DECODER CANDIDATES:');
        for (const d of r.decoders.slice(0, max)) t.push(`  ${d.score.toFixed(1).padStart(5)}  ${d.kind.padEnd(19)} ${d.name} (lines ${d.line}-${d.endLine}, ${d.params} params, ${d.callSites} calls, ${d.literalArgCalls} with literal args)\n         ${d.reasons.join('; ')}${d.sampleCalls.length ? '\n         e.g. ' + d.sampleCalls.slice(0, 3).map(x => trunc(x, 80)).join(' | ') : ''}`);
      }
      if (s === 'all' || s === 'keys') { t.push('', 'KEY CANDIDATES:'); for (const k of r.keys.slice(0, max)) t.push(`  line ${k.line}: ${trunc(JSON.stringify(bytesToDisplay(k.value)), 80)}  — ${trunc(k.context, 100)}`); }
      if (s === 'all' || s === 'strings') {
        t.push('', 'STRINGS:');
        t.push(table(r.strings.slice(0, max).map(x => [x.kind, x.len, x.count, x.entropy.toFixed(2), x.lines.slice(0, 4).join(',') + (x.lines.length > 4 ? '…' : ''), trunc(x.display, 90)]), ['kind', 'len', 'count', 'H', 'lines', 'value']));
      }
      if (s === 'all' || s === 'numbers') {
        t.push('', 'NUMBERS:');
        t.push(table(r.numbers.slice(0, max).map(n => [n.raw, n.value, n.count, n.tags.join(','), n.lines.slice(0, 5).join(',')]), ['raw', 'value', 'count', 'tags', 'lines']));
      }
      if (s === 'all' || s === 'arrays') {
        t.push('', 'ARRAYS:');
        for (const x of r.arrays.slice(0, max)) t.push(`  line ${x.line}: ${x.kind} ×${x.length} [${x.min}..${x.max}]${x.avgEntropy !== undefined ? ` avgH=${x.avgEntropy.toFixed(2)}` : ''}  ${trunc(x.strings ? x.strings.slice(0, 6).map(v => JSON.stringify(v)).join(', ') : x.values.slice(0, 24).join(','), 120)}`);
      }
      return { text: t.join('\n'), data: s === 'all' ? r : { summary: r.summary, [s]: (r as unknown as Record<string, unknown>)[s] } };
    },
  }),
  defineTool({
    name: 'strings', title: 'Strings', category: 'search', readOnly: true,
    description: 'List string literals with filters (min length, kind, substring/regex, entropy) — decoded bytes shown as UTF-8 when valid, escapes otherwise.',
    input: { ...SRC, min_len: z.number().int().optional(), kind: z.string().optional().describe('url | api | identifier | alphabet | hex | base64 | binary | blob | text'), filter: z.string().optional().describe('regex on the decoded value'), min_entropy: z.number().optional(), sort: z.enum(['count', 'len', 'entropy', 'line']).optional(), max: z.number().int().optional(), ...FORMAT, ...OUT },
    run: (a, ctx) => {
      const { src } = getSource(a, ctx);
      const r = constants(src, { maxStrings: 100000, maxNumbers: 0, maxArrays: 0, maxDecoders: 0 });
      let xs = r.strings.filter(x => x.len >= (a.min_len ?? 0) && (!a.kind || x.kind === a.kind) && (a.min_entropy === undefined || x.entropy >= a.min_entropy));
      if (a.filter) { const re = new RegExp(a.filter, 'i'); xs = xs.filter(x => re.test(x.display) || re.test(x.value)); }
      const so = a.sort ?? 'count';
      xs.sort((p, q) => so === 'len' ? q.len - p.len : so === 'entropy' ? q.entropy - p.entropy : so === 'line' ? (p.lines[0] ?? 0) - (q.lines[0] ?? 0) : q.count - p.count);
      const shown = xs.slice(0, a.max ?? 300);
      if (a.format === 'json') return { text: JSON.stringify(shown, null, 2), data: shown };
      return { text: `${xs.length} strings match\n` + table(shown.map(x => [x.kind, x.len, x.count, x.entropy.toFixed(2), x.lines[0] ?? '', trunc(x.display, 120)]), ['kind', 'len', 'count', 'H', 'line', 'value']), data: shown };
    },
  }),
];
