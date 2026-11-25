// PRISM MCP server: exposes every tool of the shared registry, the workspace as resources and workflow prompts.
import { McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { z } from 'zod';
import { TOOLS, runTool, listTools, GUIDE, PROMPTS, REPO_ROOT, type ToolContext } from '@prism/tools';

export const VERSION = '0.1.0';

const DESTRUCTIVE = new Set(['workspace_delete']);

function textOf(buf: Buffer): { text?: string; blob?: string } {
  const t = buf.toString('utf8');
  // binary when it has NULs or many replacement chars
  if (/\u0000/.test(t) || (t.match(/\uFFFD/g)?.length ?? 0) > t.length / 50) return { blob: buf.toString('base64') };
  return { text: t };
}

export function buildMcpServer(ctx: ToolContext): McpServer {
  const server = new McpServer({ name: 'prism', title: 'PRISM static Luau reverse engine', version: VERSION }, { instructions: GUIDE, capabilities: { logging: {} } });

  for (const t of TOOLS) {
    server.registerTool(t.name, {
      title: t.title,
      description: t.description,
      inputSchema: t.input,
      annotations: { title: t.title, readOnlyHint: !!t.readOnly, destructiveHint: DESTRUCTIVE.has(t.name), idempotentHint: !!t.readOnly, openWorldHint: false },
    }, async (args: Record<string, unknown>) => {
      try {
        const r = await runTool(t.name, args ?? {}, ctx);
        return { content: [{ type: 'text' as const, text: r.text || '(empty result)' }] };
      } catch (e) {
        return { content: [{ type: 'text' as const, text: `error in ${t.name}: ${(e as Error).message}` }], isError: true };
      }
    });
  }

  // ---------- resources ----------
  server.registerResource('guide', 'prism://guide', { title: 'PRISM workflow guide', description: 'How to drive the PRISM tools for static deobfuscation', mimeType: 'text/markdown' },
    async uri => ({ contents: [{ uri: uri.href, mimeType: 'text/markdown', text: GUIDE }] }));
  server.registerResource('tools', 'prism://tools', { title: 'Tool catalog (JSON schemas)', mimeType: 'application/json' },
    async uri => ({ contents: [{ uri: uri.href, mimeType: 'application/json', text: JSON.stringify(listTools(), null, 2) }] }));
  server.registerResource('workspace', 'prism://workspace', { title: 'Workspace index', description: 'stored scripts (with lineage), opcode maps and outputs', mimeType: 'application/json' },
    async uri => ({ contents: [{ uri: uri.href, mimeType: 'application/json', text: JSON.stringify({ root: ctx.ws.root, scripts: ctx.ws.listScripts(), opmaps: ctx.ws.listOpmaps(), outputs: ctx.ws.listOutputs() }, null, 2) }] }));
  const techniques = resolve(REPO_ROOT, 'docs/STATIC-TECHNIQUES.md');
  if (existsSync(techniques)) server.registerResource('techniques', 'prism://docs/static-techniques', { title: 'Static technique catalog', mimeType: 'text/markdown' },
    async uri => ({ contents: [{ uri: uri.href, mimeType: 'text/markdown', text: readFileSync(techniques, 'utf8') }] }));

  server.registerResource('script', new ResourceTemplate('prism://scripts/{id}', {
    list: async () => ({ resources: ctx.ws.listScripts().map(m => ({ uri: `prism://scripts/${m.id}`, name: m.name, title: `${m.name} (${m.id})`, mimeType: 'text/x-lua', description: `${m.size} bytes, ${m.lines} lines${m.derivedBy ? `, ${m.derivedBy} of ${m.parent}` : ''}` })) }),
    complete: { id: v => ctx.ws.listScripts().map(m => m.id).filter(id => id.startsWith(v)) },
  }), { title: 'Workspace script source', mimeType: 'text/x-lua' },
    async (uri, vars) => ({ contents: [{ uri: uri.href, mimeType: 'text/x-lua', text: ctx.ws.getScript(String(vars.id)) }] }));

  server.registerResource('output', new ResourceTemplate('prism://outputs/{name}', {
    list: async () => ({ resources: ctx.ws.listOutputs().map(o => ({ uri: `prism://outputs/${encodeURIComponent(o.name)}`, name: o.name, description: `${o.size} bytes, ${o.modified}` })) }),
    complete: { name: v => ctx.ws.listOutputs().map(o => o.name).filter(n => n.startsWith(v)) },
  }), { title: 'Workspace output file' },
    async (uri, vars) => {
      const name = decodeURIComponent(String(vars.name));
      const c = textOf(ctx.ws.readOutput(name));
      return { contents: [c.text !== undefined ? { uri: uri.href, mimeType: 'text/plain', text: c.text } : { uri: uri.href, mimeType: 'application/octet-stream', blob: c.blob! }] };
    });

  server.registerResource('opmap', new ResourceTemplate('prism://opmaps/{name}', {
    list: async () => ({ resources: ctx.ws.listOpmaps().map(n => ({ uri: `prism://opmaps/${encodeURIComponent(n)}`, name: n, mimeType: 'application/json' })) }),
    complete: { name: v => ctx.ws.listOpmaps().filter(n => n.startsWith(v)) },
  }), { title: 'Stored opcode map', mimeType: 'application/json' },
    async (uri, vars) => ({ contents: [{ uri: uri.href, mimeType: 'application/json', text: JSON.stringify(ctx.ws.getOpmap(decodeURIComponent(String(vars.name))), null, 2) }] }));

  // ---------- prompts ----------
  for (const p of PROMPTS) {
    const shape: Record<string, z.ZodOptional<z.ZodString>> = {};
    for (const [k, d] of Object.entries(p.args)) shape[k] = z.string().optional().describe(d);
    server.registerPrompt(p.name, { title: p.title, description: p.description, argsSchema: shape },
      (a: Record<string, string | undefined>) => ({ messages: [{ role: 'user' as const, content: { type: 'text' as const, text: p.render(a) } }] }));
  }
  return server;
}

/** Stateless Streamable-HTTP handler (one short-lived server per request). Mount at POST /mcp. */
export async function handleMcpHttp(req: IncomingMessage, res: ServerResponse, ctx: ToolContext, body?: unknown, allowedHosts?: string[]): Promise<void> {
  if (req.method !== 'POST') {
    res.writeHead(405, { 'content-type': 'application/json', allow: 'POST' }).end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed (stateless server: use POST)' }, id: null }));
    return;
  }
  const server = buildMcpServer(ctx);
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true, ...(allowedHosts ? { allowedHosts, enableDnsRebindingProtection: true } : {}) });
  res.on('close', () => { void transport.close(); void server.close(); });
  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, body);
  } catch (e) {
    if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32603, message: (e as Error).message }, id: null }));
  }
}
