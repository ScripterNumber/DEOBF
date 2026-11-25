#!/usr/bin/env -S npx tsx
// PRISM MCP server entry point.
//   stdio (default):   tsx apps/mcp/src/server.ts [--workspace DIR] [--luau DIR]
//   HTTP:              tsx apps/mcp/src/server.ts --http 7778 [--host 127.0.0.1]   → POST http://127.0.0.1:7778/mcp
import { createServer } from 'node:http';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createContext } from '@prism/tools';
import { buildMcpServer, handleMcpHttp, VERSION } from './mcp.js';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf('--' + name);
  if (i >= 0) return process.argv[i + 1];
  const eq = process.argv.find(a => a.startsWith(`--${name}=`));
  return eq?.slice(name.length + 3);
}
if (process.argv.includes('--help') || process.argv.includes('-h')) {
  process.stderr.write(`prism-mcp ${VERSION}\n  --workspace DIR   workspace folder (default <repo>/workspace or $PRISM_WORKSPACE)\n  --luau DIR        native luau tools folder (default <repo>/tools/luau)\n  --http PORT       serve Streamable HTTP on /mcp instead of stdio\n  --host HOST       bind address for --http (default 127.0.0.1)\n`);
  process.exit(0);
}
const ctx = createContext({ workspace: arg('workspace'), luauDir: arg('luau') });
const httpPort = arg('http');

if (httpPort) {
  const host = arg('host') ?? '127.0.0.1';
  const port = Number(httpPort);
  const allowed = host === '127.0.0.1' || host === 'localhost' ? [`127.0.0.1:${port}`, `localhost:${port}`] : undefined;
  createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    if (url.pathname !== '/mcp') { res.writeHead(404, { 'content-type': 'text/plain' }).end('PRISM MCP — POST JSON-RPC to /mcp'); return; }
    let body: unknown;
    if (req.method === 'POST') {
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { res.writeHead(400, { 'content-type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32700, message: 'Parse error' }, id: null })); return; }
    }
    await handleMcpHttp(req, res, ctx, body, allowed);
  }).listen(port, host, () => process.stderr.write(`PRISM MCP (Streamable HTTP) on http://${host}:${port}/mcp — workspace ${ctx.ws.root}\n`));
} else {
  // stdout belongs to the protocol: route stray logging to stderr
  for (const k of ['log', 'info', 'debug'] as const) console[k] = (...a: unknown[]) => process.stderr.write(a.map(String).join(' ') + '\n');
  const server = buildMcpServer(ctx);
  await server.connect(new StdioServerTransport());
  process.stderr.write(`PRISM MCP ${VERSION} ready on stdio — workspace ${ctx.ws.root}\n`);
}
