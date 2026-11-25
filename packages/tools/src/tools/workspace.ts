import { z } from 'zod';
import { basename } from 'node:path';
import { defineTool } from '../types.js';
import { readFileChecked, numbered, table } from '../source.js';
import { decodeText } from '../workspace.js';
import { Blob } from '@prism/core';

export const workspaceTools = [
  defineTool({
    name: 'workspace_list', title: 'List workspace', category: 'workspace', readOnly: true,
    description: 'List everything stored in the PRISM workspace: scripts (id, name, size, lineage, notes), saved opcode maps and saved outputs. Start here to find script_ids.',
    input: {},
    run: (_a, { ws }) => {
      const scripts = ws.listScripts(), opmaps = ws.listOpmaps(), outputs = ws.listOutputs();
      const text = [
        `workspace: ${ws.root}`, '',
        `scripts (${scripts.length}):`,
        scripts.length ? table(scripts.map(s => [s.id, s.name, s.size + ' B', s.lines + ' lines', s.parent ? `${s.derivedBy ?? 'derived'} ← ${s.parent}` : '', s.notes.length ? s.notes.length + ' notes' : '']), ['id', 'name', 'size', 'lines', 'lineage', 'notes']) : '  (none — add one with workspace_add_script)',
        '', `opcode maps (${opmaps.length}): ${opmaps.join(', ') || '(none)'}`,
        '', `outputs (${outputs.length}):`, ...outputs.map(o => `  ${o.name}  ${o.size} B  ${o.modified}`),
      ].join('\n');
      return { text, data: { root: ws.root, scripts, opmaps, outputs } };
    },
  }),
  defineTool({
    name: 'workspace_add_script', title: 'Add script', category: 'workspace',
    description: 'Store a script in the workspace (from inline source or a file path) and get its script_id. All other tools accept script_id, so large files never need to be passed inline again.',
    input: { name: z.string().optional().describe('display name (default: file name)'), source: z.string().optional(), path: z.string().optional().describe('file on the PRISM host'), tags: z.array(z.string()).optional() },
    run: (a, { ws }) => {
      let src: string, enc: 'utf8' | 'latin1' = 'utf8';
      if (a.path) { const d = decodeText(readFileChecked(a.path)); src = d.text; enc = d.encoding; }
      else if (typeof a.source === 'string') src = a.source;
      else throw new Error('provide source or path');
      const m = ws.addScript(a.name ?? (a.path ? basename(a.path) : 'script.lua'), src, { encoding: enc, ...(a.tags ? { tags: a.tags } : {}) });
      return { text: `stored as script_id "${m.id}" (${m.size} bytes, ${m.lines} lines, ${enc})`, data: m };
    },
  }),
  defineTool({
    name: 'workspace_get_script', title: 'Read script', category: 'workspace', readOnly: true,
    description: 'Read a stored script, optionally a line range, with line numbers. Use this to look at code around a line reported by another tool.',
    input: { script_id: z.string(), from_line: z.number().int().optional(), to_line: z.number().int().optional(), numbered: z.boolean().optional().describe('prefix line numbers (default true)') },
    run: (a, { ws }) => {
      const src = ws.getScript(a.script_id); const m = ws.getMeta(a.script_id);
      const from = a.from_line ?? 1, to = a.to_line ?? Infinity;
      const text = a.numbered === false ? src.split('\n').slice(from - 1, to === Infinity ? undefined : to).join('\n') : numbered(src, from, to);
      return { text, data: { meta: m } };
    },
  }),
  defineTool({
    name: 'workspace_note', title: 'Annotate script', category: 'workspace',
    description: 'Attach findings to a stored script: append a note and/or set tags. Notes persist on disk and show up in workspace_list — use them to record keys, decoder functions, opcode findings, etc.',
    input: { script_id: z.string(), note: z.string().optional(), tags: z.array(z.string()).optional() },
    run: (a, { ws }) => {
      const m = ws.getMeta(a.script_id);
      const notes = a.note ? [...m.notes, `[${new Date().toISOString()}] ${a.note}`] : m.notes;
      const u = ws.updateMeta(a.script_id, { notes, ...(a.tags ? { tags: a.tags } : {}) });
      return { text: `notes (${u.notes.length}):\n` + u.notes.map(n => '- ' + n).join('\n') + (u.tags.length ? `\ntags: ${u.tags.join(', ')}` : ''), data: u };
    },
  }),
  defineTool({
    name: 'workspace_delete', title: 'Delete item', category: 'workspace',
    description: 'Delete a stored script, opcode map or output.',
    input: { kind: z.enum(['script', 'opmap', 'output']), id: z.string().describe('script_id, opmap name, or output file name') },
    run: (a, { ws }) => {
      if (a.kind === 'script') ws.deleteScript(a.id); else if (a.kind === 'opmap') ws.deleteOpmap(a.id); else ws.deleteOutput(a.id);
      return { text: `deleted ${a.kind} ${a.id}` };
    },
  }),
  defineTool({
    name: 'workspace_read_output', title: 'Read output', category: 'workspace', readOnly: true,
    description: 'Read a saved output file (text, or a hexdump for binary data).',
    input: { name: z.string(), hexdump: z.boolean().optional() },
    run: (a, { ws }) => {
      const b = new Uint8Array(ws.readOutput(a.name));
      const bin = a.hexdump || Blob.printableBytes(b.subarray(0, 4096)) < 0.85;
      return { text: bin ? Blob.hexdump(b, 1 << 20) : decodeText(b).text, data: { name: a.name, size: b.length, binary: bin } };
    },
  }),
  defineTool({
    name: 'workspace_save_output', title: 'Save output', category: 'workspace',
    description: 'Save arbitrary text (e.g. your own reconstructed Python decoder or notes) into workspace outputs.',
    input: { name: z.string(), content: z.string() },
    run: (a, { ws }) => { const f = ws.saveOutput(a.name, a.content); return { text: `saved ${f} (${a.content.length} chars)`, files: [f] }; },
  }),
];
