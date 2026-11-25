// End-to-end MCP test: real SDK client ↔ PRISM MCP server over stdio AND Streamable HTTP.
//   npx tsx apps/mcp/test/mcp.ts
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { spawn } from 'node:child_process';
import { request } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const root = mkdtempSync(join(tmpdir(), 'prism-mcp-test-'));
const sample = join(process.cwd(), 'apps/web/public/samples/prometheus_weak_1.lua');
let fails = 0;
const check = (ok: unknown, what: string) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`); if (!ok) fails++; };
const text = (r: any) => String(r?.content?.[0]?.text ?? '');

// ---- stdio
const stdio = new StdioClientTransport({ command: process.execPath, args: ['--import', 'tsx', 'apps/mcp/src/server.ts', '--workspace', join(root, 'ws1')], cwd: process.cwd(), stderr: 'pipe' });
const c = new Client({ name: 'prism-test', version: '1' });
await c.connect(stdio);
check((c.getInstructions()?.length ?? 0) > 500, 'stdio: server instructions (workflow guide)');
const tools = (await c.listTools()).tools;
check(tools.length >= 40, `stdio: ${tools.length} tools listed`);
check(tools.find(t => t.name === 'workspace_delete')?.annotations?.destructiveHint === true, 'stdio: destructive annotation');
const add = await c.callTool({ name: 'workspace_add_script', arguments: { path: sample } });
const id = (add.structuredContent as any)?.id ?? /([A-Za-z0-9_.-]+-[0-9a-f]{6})/.exec(text(add))?.[1];
check(id, 'stdio: workspace_add_script → ' + id);
const an = await c.callTool({ name: 'analyze', arguments: { script_id: id, max_chars: 2000 } });
check(/Prometheus/.test(text(an)), 'stdio: analyze fingerprints Prometheus');
const bad = await c.callTool({ name: 'get_lines', arguments: { script_id: 'nope', line: 1 } });
check(bad.isError === true, 'stdio: errors surface as isError');
const res = await c.listResources();
check(res.resources.some(r => r.uri === 'prism://guide'), 'stdio: resources ' + res.resources.map(r => r.uri).join(' '));
const rd = await c.readResource({ uri: `prism://scripts/${id}` });
check(((rd.contents[0] as any).text?.length ?? 0) > 1000, 'stdio: read prism://scripts/{id}');
const pr = await c.listPrompts();
check(pr.prompts.length >= 4, 'stdio: prompts ' + pr.prompts.map(p => p.name).join(', '));
const gp = await c.getPrompt({ name: 'deobfuscate_script', arguments: { script: id } });
check(/deobfuscate/i.test((gp.messages[0].content as any).text), 'stdio: prompt renders');
await c.close();

// ---- Streamable HTTP
const port = 17000 + Math.floor(Math.random() * 2000);
const srv = spawn(process.execPath, ['--import', 'tsx', 'apps/mcp/src/server.ts', '--http', String(port), '--workspace', join(root, 'ws2')], { cwd: process.cwd(), stdio: ['ignore', 'ignore', 'pipe'] });
await new Promise<void>((resolve, reject) => {
  const t = setTimeout(() => reject(new Error('http server did not start')), 30000);
  srv.stderr!.on('data', d => { if (/listening|http:\/\//i.test(String(d))) { clearTimeout(t); resolve(); } });
});
const h = new Client({ name: 'prism-test-http', version: '1' });
await h.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`)));
check((await h.listTools()).tools.length >= 40, 'http: tools listed');
const s = await h.callTool({ name: 'simplify_expression', arguments: { expression: 'bit32.bxor(0x55, 0x55) + (3*4)' } });
check(/12/.test(text(s)), 'http: simplify_expression → ' + text(s).trim().split('\n')[0]);
await h.close();
const get = await fetch(`http://127.0.0.1:${port}/mcp`);
check(get.status === 405, 'http: GET /mcp → 405');
const evil = await new Promise<number>(resolve => {
  const rq = request({ host: '127.0.0.1', port, path: '/mcp', method: 'POST', headers: { host: 'evil.example', 'content-type': 'application/json' } }, r => { r.resume(); resolve(r.statusCode ?? 0); });
  rq.on('error', () => resolve(-1)); rq.end('{}');
});
check(evil === 403, `http: foreign Host header rejected (DNS-rebinding guard) → ${evil}`);
srv.kill();
rmSync(root, { recursive: true, force: true });
console.log(fails ? `\n${fails} FAILED` : '\nall MCP checks passed');
process.exit(fails ? 1 : 0);
