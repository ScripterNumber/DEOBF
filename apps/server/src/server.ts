// PRISM backend: serves the web UI, the tool HTTP API, the workspace and the MCP endpoint on one local port.
//   tsx apps/server/src/server.ts [--port 7777] [--host 127.0.0.1] [--workspace DIR] [--luau DIR]
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { resolve, join, extname, normalize, sep } from 'node:path';
import { createContext, listTools, runTool, getTool, REPO_ROOT, TOOLS, GUIDE, hasNative } from '@prism/tools';
import { decodeText } from '../../../packages/tools/src/workspace.js';
import { handleMcpHttp, VERSION } from '../../mcp/src/mcp.js';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf('--' + name);
  if (i >= 0) return process.argv[i + 1];
  return process.argv.find(a => a.startsWith(`--${name}=`))?.slice(name.length + 3);
}
const PORT = Number(arg('port') ?? process.env.PRISM_PORT ?? 7777);
const HOST = arg('host') ?? process.env.PRISM_HOST ?? '127.0.0.1';
const ctx = createContext({ workspace: arg('workspace'), luauDir: arg('luau') });
const DIST = resolve(arg('web') ?? resolve(REPO_ROOT, 'apps/web/dist'));
const MAX_BODY = 96 * 1024 * 1024;
const LOCAL = HOST === '127.0.0.1' || HOST === 'localhost' || HOST === '::1';
const ALLOWED_HOSTS = [`127.0.0.1:${PORT}`, `localhost:${PORT}`, `[::1]:${PORT}`];

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.woff': 'font/woff',
  '.ttf': 'font/ttf', '.lua': 'text/plain; charset=utf-8', '.luau': 'text/plain; charset=utf-8', '.txt': 'text/plain; charset=utf-8', '.map': 'application/json', '.wasm': 'application/wasm',
};

const send = (res: ServerResponse, code: number, body: unknown, headers: Record<string, string> = {}) => {
  const isBuf = Buffer.isBuffer(body) || typeof body === 'string';
  res.writeHead(code, { 'content-type': isBuf ? 'text/plain; charset=utf-8' : 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers });
  res.end(isBuf ? body : JSON.stringify(body));
};
async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = []; let n = 0;
  for await (const c of req) { n += (c as Buffer).length; if (n > MAX_BODY) throw Object.assign(new Error('request body too large'), { status: 413 }); chunks.push(c as Buffer); }
  return Buffer.concat(chunks);
}
const json = async (req: IncomingMessage) => { const b = await readBody(req); if (!b.length) return {}; try { return JSON.parse(b.toString('utf8')); } catch { throw Object.assign(new Error('invalid JSON body'), { status: 400 }); } };

function luauStatus() {
  const has = (b: string) => hasNative(ctx.luauDir, b);
  return { dir: ctx.luauDir, compile: has('luau-compile'), analyze: has('luau-analyze'), ast: has('luau-ast') };
}

async function api(req: IncomingMessage, res: ServerResponse, url: URL) {
  const parts = url.pathname.split('/').filter(Boolean).slice(1).map(decodeURIComponent); // drop "api"
  const m = req.method ?? 'GET';
  const [a, b, c, d] = parts;
  if (a === 'health') return send(res, 200, { ok: true, name: 'prism', version: VERSION, workspace: ctx.ws.root, luau: luauStatus(), tools: TOOLS.length, mcp: `http://${req.headers.host}/mcp` });
  if (a === 'guide') return send(res, 200, { guide: GUIDE });
  if (a === 'tools' && m === 'GET') return send(res, 200, listTools());
  if (a === 'tool' && b && m === 'POST') {
    if (!getTool(b)) return send(res, 404, { ok: false, error: `unknown tool "${b}"` });
    const args = await json(req);
    const t0 = performance.now();
    try {
      const r = await runTool(b, args, ctx);
      return send(res, 200, { ok: true, tool: b, ms: Math.round(performance.now() - t0), text: r.text, data: r.data ?? null, files: r.files ?? [], truncated: !!r.truncated, fullLength: r.fullLength });
    } catch (e) {
      return send(res, 200, { ok: false, tool: b, ms: Math.round(performance.now() - t0), error: (e as Error).message });
    }
  }
  if (a === 'workspace') {
    if (!b) return send(res, 200, { root: ctx.ws.root, scripts: ctx.ws.listScripts(), opmaps: ctx.ws.listOpmaps(), outputs: ctx.ws.listOutputs() });
    if (b === 'scripts') {
      if (!c && m === 'GET') return send(res, 200, ctx.ws.listScripts());
      if (!c && m === 'POST') {
        // raw upload (?name=) keeps the exact bytes; JSON {name, source} for pasted text
        const ct = String(req.headers['content-type'] ?? '');
        if (ct.includes('application/json')) {
          const j = await json(req) as { name?: string; source?: string; parent?: string; derivedBy?: string };
          if (typeof j.source !== 'string') return send(res, 400, { error: 'missing "source"' });
          return send(res, 200, ctx.ws.addScript(j.name || 'pasted.lua', j.source, { ...(j.parent ? { parent: j.parent } : {}), ...(j.derivedBy ? { derivedBy: j.derivedBy } : {}) }));
        }
        const buf = await readBody(req);
        const { text, encoding } = decodeText(buf);
        return send(res, 200, ctx.ws.addScript(url.searchParams.get('name') || 'upload.lua', text, { encoding }));
      }
      if (c && !d && m === 'GET') return send(res, 200, { meta: ctx.ws.getMeta(c), source: ctx.ws.getScript(c) });
      if (c && d === 'raw' && m === 'GET') { const meta = ctx.ws.getMeta(c); return send(res, 200, Buffer.from(ctx.ws.getScript(c), meta.encoding === 'latin1' ? 'latin1' : 'utf8'), { 'content-disposition': `attachment; filename="${meta.name.replace(/"/g, '')}"` }); }
      if (c && !d && m === 'DELETE') { ctx.ws.getMeta(c); ctx.ws.deleteScript(c); return send(res, 200, { ok: true }); }
      if (c && !d && m === 'PATCH') { const j = await json(req) as Record<string, unknown>; const patch: Record<string, unknown> = {}; for (const k of ['name', 'tags', 'notes']) if (k in j) patch[k] = j[k]; return send(res, 200, ctx.ws.updateMeta(c, patch)); }
    }
    if (b === 'opmaps') {
      if (!c) return send(res, 200, ctx.ws.listOpmaps());
      if (m === 'GET') return send(res, 200, ctx.ws.getOpmap(c));
      if (m === 'PUT' || m === 'POST') { const j = await json(req); if (!j || typeof j !== 'object' || Array.isArray(j)) return send(res, 400, { error: 'opmap must be a JSON object' }); return send(res, 200, { ok: true, file: ctx.ws.setOpmap(c, j as Record<string, unknown>) }); }
      if (m === 'DELETE') { ctx.ws.deleteOpmap(c); return send(res, 200, { ok: true }); }
    }
    if (b === 'outputs') {
      if (!c) return send(res, 200, ctx.ws.listOutputs());
      if (m === 'GET') return send(res, 200, ctx.ws.readOutput(c), { 'content-type': MIME[extname(c)] ?? 'application/octet-stream', ...(url.searchParams.has('download') ? { 'content-disposition': `attachment; filename="${c.replace(/"/g, '')}"` } : {}) });
      if (m === 'PUT' || m === 'POST') { const buf = await readBody(req); return send(res, 200, { ok: true, file: ctx.ws.saveOutput(c, buf) }); }
      if (m === 'DELETE') { ctx.ws.deleteOutput(c); return send(res, 200, { ok: true }); }
    }
  }
  return send(res, 404, { error: `no route ${m} ${url.pathname}` });
}

function serveStatic(req: IncomingMessage, res: ServerResponse, url: URL) {
  if (!existsSync(DIST)) return send(res, 503, `PRISM web UI is not built yet.\nRun:  npm run build:web   (then reload)\nAPI: /api/health, /api/tools — MCP: POST /mcp`);
  let rel = normalize(decodeURIComponent(url.pathname)).replace(/^([/\\])+/, '');
  let file = join(DIST, rel);
  if (!file.startsWith(DIST + sep) && file !== DIST) return send(res, 403, 'forbidden');
  if (!rel || !existsSync(file) || statSync(file).isDirectory()) file = join(DIST, 'index.html'); // SPA fallback
  const ext = extname(file);
  const immutable = rel.startsWith('assets/');
  res.writeHead(200, { 'content-type': MIME[ext] ?? 'application/octet-stream', 'cache-control': immutable ? 'public, max-age=31536000, immutable' : 'no-cache' });
  res.end(readFileSync(file));
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://local');
  try {
    // DNS-rebinding guard for the default local bind
    if (LOCAL && req.headers.host && !ALLOWED_HOSTS.includes(req.headers.host)) return send(res, 403, 'forbidden host');
    if (url.pathname === '/mcp') {
      let body: unknown;
      if (req.method === 'POST') body = await json(req);
      return await handleMcpHttp(req, res, ctx, body, LOCAL ? ALLOWED_HOSTS : undefined);
    }
    if (url.pathname.startsWith('/api/')) return await api(req, res, url);
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'method not allowed');
    return serveStatic(req, res, url);
  } catch (e) {
    const err = e as Error & { status?: number };
    const status = err.status ?? (/unknown (script_id|opmap|output)/.test(err.message) ? 404 : 500);
    if (!res.headersSent) send(res, status, { ok: false, error: err.message });
    else res.end();
  }
});
server.requestTimeout = 0; // long analyses are fine locally
server.listen(PORT, HOST, () => {
  const l = luauStatus();
  process.stdout.write(`\n  PRISM ${VERSION} — static Luau reverse engine\n  web  http://${HOST === '0.0.0.0' ? '127.0.0.1' : HOST}:${PORT}/\n  api  http://${HOST}:${PORT}/api/tools  (${TOOLS.length} tools)\n  mcp  http://${HOST}:${PORT}/mcp  (Streamable HTTP)\n  workspace ${ctx.ws.root}\n  luau ${l.compile ? 'luau-compile ✓' : 'luau-compile ✗'} ${l.analyze ? 'luau-analyze ✓' : 'luau-analyze ✗'} ${l.ast ? 'luau-ast ✓' : 'luau-ast ✗'}\n  ui   ${existsSync(DIST) ? DIST : 'NOT BUILT — run npm run build:web'}\n\n`);
});
