import { z } from 'zod';
import { defineTool } from '../types.js';
import { SRC, OUT, FORMAT, getSource, table, trunc, readFileChecked } from '../source.js';
import { analyze, parse, buildCallGraph, detectVM, computeMetrics, fingerprint, tokenize, bytesToDisplay, behaviorReport, formatBehavior, luaLiteralToJson, collectJsonStrings } from '@prism/core';

const lineOfPos = (src: string) => { const starts = [0]; for (let i = 0; i < src.length; i++) if (src.charCodeAt(i) === 10) starts.push(i + 1); return (pos: number) => { let lo = 0, hi = starts.length - 1; while (lo < hi) { const m = (lo + hi + 1) >> 1; if (starts[m] <= pos) lo = m; else hi = m - 1; } return lo + 1; }; };

/** Strings given as a JSON array (of strings or {value}), a JSON object (values), or newline-separated text. */
export function parseStringList(raw: string): Array<{ value: string; where?: string }> {
  const t = raw.trim();
  if (t.startsWith('[') || t.startsWith('{')) {
    try { return collectJsonStrings(JSON.parse(t)).map(x => ({ value: x.value, where: 'str ' + x.where })); } catch { /* fall through to lines */ }
  }
  return t.split(/\r?\n/).filter(Boolean).map((value, i) => ({ value, where: `#${i + 1}` }));
}

export const analysisTools = [
  defineTool({
    name: 'analyze', title: 'Auto-analysis', category: 'analysis', readOnly: true,
    description: 'One-shot static triage of an obfuscated Lua/Luau script: obfuscator family guesses with reasons, size/complexity metrics, VM / control-flow-flattening detection (dispatch sites, opcode estimate, bytecode blobs), call graph summary, global aliases and parse errors. Run this first.',
    input: { ...SRC, ...FORMAT, ...OUT },
    run: (a, ctx) => {
      const { src, label } = getSource(a, ctx);
      const r = analyze(src);
      if (a.format === 'json') return { text: JSON.stringify(r, null, 2), data: r };
      const m = r.metrics;
      const t: string[] = [];
      t.push(`PRISM analysis — ${label}`, '');
      t.push('family guesses:');
      if (!r.families.length) t.push('  (no known obfuscator signature — generic static analysis applies; fingerprint the ORIGINAL script, cleaning removes tells)');
      for (const f of r.families.slice(0, 6)) t.push(`  ${(f.confidence * 100).toFixed(0).padStart(3)}%  ${f.family}${f.reasons.length ? '  — ' + f.reasons.slice(0, 4).join('; ') : ''}`);
      t.push('', `metrics: ${m.bytes} bytes, ${m.lines} lines, ${m.tokens} tokens, ${m.nodes} AST nodes, ${m.functions} functions, ${m.strings} strings, ${m.numbers} numbers, max depth ${m.maxDepth}`);
      t.push(`tells: while-true ${m.whileTrue}, long brackets ${m.longBrackets}, gotos ${m.gotos}, 0x/0b/_ numbers ${m.underscoreNumbers}/${m.binaryLiterals}, dup-param fns ${m.dupParamFns}, table-return head ${m.tableReturnHead}`);
      t.push('', `VM: ${r.vm.isVM ? 'YES' : 'no'}${r.vm.opcodeEstimate ? `, ~${r.vm.opcodeEstimate} opcodes` : ''}`);
      for (const d of r.vm.dispatchSummary) t.push(`  ${d.kind} ×${d.count} (first at line ${d.firstLine})`);
      for (const d of r.vm.dispatch.slice(0, 8)) t.push(`  line ${d.line}: ${d.kind}${d.stateVar ? ` var=${d.stateVar}` : ''}${d.cases ? ` cases=${d.cases}` : ''} — ${trunc(d.detail, 120)}`);
      for (const b of r.vm.blobs.slice(0, 8)) t.push(`  blob line ${b.line}: ${b.kind} len=${b.length}${b.distinctBytes ? ` distinct=${b.distinctBytes}` : ''} ${trunc(b.preview, 60)}`);
      for (const n of r.vm.notes) t.push('  note: ' + n);
      t.push('', `call graph: ${r.callGraph.functionCount} functions, ${r.callGraph.edgeCount} edges`);
      if (r.callGraph.topExternalCalls.length) t.push('top external calls: ' + r.callGraph.topExternalCalls.slice(0, 20).map(c => `${c.name}×${c.count}`).join(', '));
      if (r.aliases.length) t.push('', 'aliases: ' + r.aliases.slice(0, 40).map(x => `${x.name}=${x.target}`).join(', '));
      t.push('', `strings: ${r.strings.total} literals; samples: ` + r.strings.samples.slice(0, 12).map(s => JSON.stringify(trunc(bytesToDisplay(s.value), 40))).join(', '));
      if (r.parseErrors.length) t.push('', `parse errors (${r.parseErrors.length}):`, ...r.parseErrors.slice(0, 10).map(e => `  line ${e.line}: ${e.message}`));
      t.push('', 'next steps: deobfuscate (save_script_as) → constants / opcode_map / find_embedded_bytecode → python_transpile of the decoder');
      return { text: t.join('\n'), data: { families: r.families, metrics: r.metrics, vm: r.vm, callGraph: { functionCount: r.callGraph.functionCount, edgeCount: r.callGraph.edgeCount, topExternalCalls: r.callGraph.topExternalCalls }, aliases: r.aliases, parseErrors: r.parseErrors } };
    },
  }),
  defineTool({
    name: 'fingerprint', title: 'Fingerprint obfuscator', category: 'analysis', readOnly: true,
    description: 'Guess the obfuscator family (Luraph, Moonsec, IronBrew, Prometheus, PSU, Hercules, custom VM…) with confidence and the evidence for each guess.',
    input: { ...SRC },
    run: (a, ctx) => {
      const { src } = getSource(a, ctx);
      const { chunk } = parse(src);
      const fam = fingerprint(src, computeMetrics(src, chunk));
      return { text: fam.map(f => `${(f.confidence * 100).toFixed(0).padStart(3)}%  ${f.family}\n      ${f.reasons.join('\n      ')}`).join('\n') || 'no guess', data: fam };
    },
  }),
  defineTool({
    name: 'call_graph', title: 'Call graph', category: 'analysis', readOnly: true,
    description: 'Function inventory and caller→callee edges. Formats: text (default), json, dot (Graphviz), mermaid.',
    input: { ...SRC, format: z.enum(['text', 'json', 'dot', 'mermaid']).optional(), max_nodes: z.number().int().optional().describe('limit nodes in dot/mermaid (default 400)'), ...OUT },
    run: (a, ctx) => {
      const { src } = getSource(a, ctx);
      const cg = buildCallGraph(parse(src).chunk);
      const fmt = a.format ?? 'text';
      if (fmt === 'json') return { text: JSON.stringify(cg, null, 2), data: cg };
      const max = a.max_nodes ?? 400;
      const nodes = cg.functions.slice(0, max); const ids = new Set(nodes.map(n => n.id));
      const edges = cg.edges.filter(e => ids.has(e.from) && ids.has(e.to));
      const esc = (s: string) => s.replace(/["\\]/g, '\\$&');
      if (fmt === 'dot') {
        const t = ['digraph prism {', '  rankdir=LR; node [shape=box, style="rounded,filled", fillcolor="#1e1433", fontcolor="#e9ddff", color="#a855f7", fontname="monospace"]; edge [color="#7c3aed"];',
          ...nodes.map(n => `  "${n.id}" [label="${esc(n.name)}\\nline ${n.line} · ${n.stmts} stmts"];`), ...edges.map(e => `  "${e.from}" -> "${e.to}";`), '}'];
        return { text: t.join('\n'), data: { nodes: nodes.length, edges: edges.length } };
      }
      if (fmt === 'mermaid') {
        const t = ['flowchart LR', ...nodes.map(n => `  ${n.id}["${n.name.replace(/"/g, "'")} (L${n.line})"]`), ...edges.map(e => `  ${e.from} --> ${e.to}`)];
        return { text: t.join('\n'), data: { nodes: nodes.length, edges: edges.length } };
      }
      const callers = new Map<string, string[]>();
      for (const e of cg.edges) { const l = callers.get(e.to) ?? []; l.push(e.from); callers.set(e.to, l); }
      const rows = cg.functions.map(f => [f.id, trunc(f.name, 40), f.line, f.params.join(',') + (f.vararg ? (f.params.length ? ',...' : '...') : ''), f.stmts, cg.edges.filter(e => e.from === f.id).length, callers.get(f.id)?.length ?? 0]);
      const text = `${cg.functions.length} functions, ${cg.edges.length} edges\n\n` + table(rows, ['id', 'name', 'line', 'params', 'stmts', 'calls→', '←callers']) +
        `\n\nexternal calls: ${cg.externalCalls.slice(0, 60).map(c => `${c.name}×${c.count}`).join(', ')}\n\nedges:\n` + cg.edges.slice(0, 2000).map(e => `  ${e.from} → ${e.to}${e.label ? ` (${e.label})` : ''}`).join('\n');
      return { text, data: { functions: cg.functions.length, edges: cg.edges.length } };
    },
  }),
  defineTool({
    name: 'list_functions', title: 'List functions', category: 'analysis', readOnly: true,
    description: 'Compact function index (id, name, line range, params, size). Sort by line, size or fan-in to find decoders, VM loops and hot helpers.',
    input: { ...SRC, sort: z.enum(['line', 'size', 'callers', 'calls']).optional(), filter: z.string().optional().describe('substring filter on the function name'), max: z.number().int().optional(), ...OUT },
    run: (a, ctx) => {
      const { src } = getSource(a, ctx);
      const cg = buildCallGraph(parse(src).chunk);
      const lineOf = lineOfPos(src);
      const fanin = new Map<string, number>(); for (const e of cg.edges) fanin.set(e.to, (fanin.get(e.to) ?? 0) + 1);
      let fns = cg.functions.filter(f => f.id !== 'main').map(f => ({ ...f, endLine: lineOf(f.end), size: f.end - f.start, callers: fanin.get(f.id) ?? 0 }));
      if (a.filter) fns = fns.filter(f => f.name.toLowerCase().includes(a.filter!.toLowerCase()));
      const s = a.sort ?? 'line';
      fns.sort((x, y) => s === 'size' ? y.size - x.size : s === 'callers' ? y.callers - x.callers : s === 'calls' ? y.calls.length - x.calls.length : x.line - y.line);
      fns = fns.slice(0, a.max ?? 500);
      const text = table(fns.map(f => [f.id, trunc(f.name, 40), `${f.line}-${f.endLine}`, f.params.length + (f.vararg ? '+...' : ''), f.size + 'ch', f.callers, f.calls.length]), ['id', 'name', 'lines', 'params', 'size', 'callers', 'calls']);
      return { text, data: fns.map(f => ({ id: f.id, name: f.name, line: f.line, endLine: f.endLine, params: f.params, vararg: f.vararg, size: f.size, callers: f.callers, calls: f.calls.length })) };
    },
  }),
  defineTool({
    name: 'vm_detect', title: 'VM detection', category: 'vm', readOnly: true,
    description: 'Detect interpreter VMs and control-flow flattening: dispatch sites (table dispatch, if-chain state machines), trampolines, bytecode blobs with byte histograms, opcode count estimate and handler clusters (same CFG shape).',
    input: { ...SRC, ...FORMAT, ...OUT },
    run: (a, ctx) => {
      const { src } = getSource(a, ctx);
      const v = detectVM(parse(src).chunk);
      if (a.format === 'json') return { text: JSON.stringify(v, null, 2), data: v };
      const t = [`VM: ${v.isVM ? 'YES' : 'no'}${v.opcodeEstimate ? `  (~${v.opcodeEstimate} opcodes)` : ''}`, '', 'dispatch sites:'];
      for (const d of v.dispatch) t.push(`  line ${d.line}: ${d.kind}${d.stateVar ? ` var=${d.stateVar}` : ''}${d.cases ? ` cases=${d.cases}` : ''} — ${d.detail}`);
      if (v.trampolines.length) t.push('', 'trampolines:', ...v.trampolines.map(x => `  line ${x.line}: ${x.detail}`));
      if (v.blobs.length) t.push('', 'blobs:', ...v.blobs.map(b => `  line ${b.line}: ${b.kind} len=${b.length}${b.distinctBytes ? ` distinct bytes=${b.distinctBytes}` : ''}${b.histogram ? ' top: ' + b.histogram.slice(0, 8).map(h => `${h.byte}×${h.count}`).join(' ') : ''}\n      ${trunc(b.preview, 100)}`));
      if (v.handlerClusters.length) t.push('', 'handler clusters (same shape):', ...v.handlerClusters.slice(0, 30).map(c => `  ${c.shapeHash} ×${c.members.length} (line ${c.representativeLine}): ${trunc(c.sketch, 100)}`));
      for (const n of v.notes) t.push('note: ' + n);
      return { text: t.join('\n'), data: v };
    },
  }),
  defineTool({
    name: 'behavior_report', title: 'Behaviour / IOC report', category: 'analysis', readOnly: true,
    description: 'Static "what does this script DO" report: network (HttpGet/request/webhooks), remote code loading (loadstring/load of fetched code), executor file system, clipboard, identity/fingerprinting (HWID, ip lookups, UserId), hooks (hookfunction/hookmetamethod/getrawmetatable), executor APIs, anti-debug/anti-tamper, remotes (FireServer/InvokeServer), moderation (Kick/Ban), UI, crypto. Lists every URL with its kind (discord-webhook, ip-lookup, code-host, roblox-asset…) and a verdict. Feed it the CLEANED script (deobfuscate first) and/or decoded strings: the "strings" output of python runs, an inline_values result, or a dumped VM chunk (chunk/chunk_path — all strings are collected recursively). Nothing is executed.',
    input: {
      ...SRC,
      strings: z.string().optional().describe('extra decoded strings: JSON array / JSON object (all string values) / newline-separated text'),
      chunk: z.string().optional().describe('dumped VM chunk / decoder output as JSON or a Lua table literal — every string inside is scanned'),
      chunk_path: z.string().optional().describe('path of such a JSON file on the PRISM host (e.g. out.json from a generated Python program)'),
      chunk_output: z.string().optional().describe('read it from a saved workspace output'),
      max_hits: z.number().int().optional().describe('example hits listed per category (default 12)'),
      ...FORMAT, ...OUT,
    },
    run: (a, ctx) => {
      let src: string | undefined; let label = '';
      if (a.script_id || a.path || typeof a.source === 'string') { const s = getSource(a, ctx); src = s.src; label = s.label; }
      const strings: Array<{ value: string; where?: string }> = [];
      if (a.strings) strings.push(...parseStringList(a.strings));
      const raw = a.chunk ?? (a.chunk_path ? readFileChecked(a.chunk_path).toString('utf8') : a.chunk_output ? ctx.ws.readOutput(a.chunk_output).toString('utf8') : undefined);
      if (raw) {
        const t = raw.trim(); let json: unknown;
        try { json = JSON.parse(t); } catch { json = luaLiteralToJson(t); }
        strings.push(...collectJsonStrings(json));
        label = label ? `${label} + chunk` : (a.chunk_path ?? a.chunk_output ?? 'chunk');
      }
      if (src === undefined && !strings.length) throw new Error('provide a script (script_id | path | source) and/or strings / chunk / chunk_path / chunk_output');
      const r = behaviorReport({ src, strings: strings.length ? strings : undefined }, { maxHits: a.max_hits });
      if (a.format === 'json') return { text: JSON.stringify(r, null, 2), data: r };
      return { text: formatBehavior(r, { label: label || (strings.length ? `${strings.length} strings` : '') }), data: r };
    },
  }),
  defineTool({
    name: 'tokenize', title: 'Tokens', category: 'analysis', readOnly: true,
    description: 'Lexer view: token type statistics for the whole file and the raw token stream for a line range (useful to inspect weird escapes / number formats).',
    input: { ...SRC, from_line: z.number().int().optional(), to_line: z.number().int().optional(), ...OUT },
    run: (a, ctx) => {
      const { src } = getSource(a, ctx);
      const { tokens, errors } = tokenize(src);
      const counts = new Map<string, number>(); for (const t of tokens) counts.set(t.type, (counts.get(t.type) ?? 0) + 1);
      const from = a.from_line ?? 1, to = a.to_line ?? from + 20;
      const win = tokens.filter(t => t.line >= from && t.line <= to).slice(0, 3000);
      const text = `${tokens.length} tokens, ${errors.length} lexer errors\n` + [...counts].sort((x, y) => y[1] - x[1]).map(([k, v]) => `  ${k}: ${v}`).join('\n') +
        `\n\ntokens on lines ${from}-${to}:\n` + win.map(t => `  ${t.line}:${t.col} ${t.type.padEnd(12)} ${trunc(JSON.stringify(t.value), 100)}`).join('\n') + (errors.length ? '\n\nerrors:\n' + errors.slice(0, 20).map(e => `  line ${e.line}: ${e.message}`).join('\n') : '');
      return { text, data: { counts: Object.fromEntries(counts), errors: errors.length } };
    },
  }),
];
