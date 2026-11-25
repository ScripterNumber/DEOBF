// Backend client (PRISM server). Every call degrades gracefully when the UI runs as a static site.
export interface ToolInfo { name: string; title: string; category: string; description: string; readOnly: boolean; inputSchema: JsonSchema; }
export interface JsonSchema { type?: string | string[]; properties?: Record<string, JsonSchema>; required?: string[]; enum?: unknown[]; items?: JsonSchema; description?: string; default?: unknown; anyOf?: JsonSchema[]; minimum?: number; maximum?: number; additionalProperties?: unknown; }
export interface ToolRun { ok: boolean; tool: string; ms: number; text?: string; data?: unknown; files?: string[]; truncated?: boolean; fullLength?: number; error?: string; }
export interface ScriptMeta { id: string; name: string; size: number; lines: number; sha1: string; created: string; updated: string; encoding: string; parent?: string; derivedBy?: string; tags: string[]; notes: string[]; }
export interface Health { ok: boolean; name: string; version: string; workspace: string; luau: { dir: string; compile: boolean; analyze: boolean; ast: boolean }; tools: number; mcp: string; }
export interface WorkspaceIndex { root: string; scripts: ScriptMeta[]; opmaps: string[]; outputs: Array<{ name: string; size: number; modified: string }>; }

const BASE = (import.meta as any).env?.VITE_PRISM_API ?? '';

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const r = await fetch(BASE + path, init);
  const ct = r.headers.get('content-type') ?? '';
  const body = ct.includes('application/json') ? await r.json() : await r.text();
  if (!r.ok) throw new Error(typeof body === 'object' && body && 'error' in body ? String((body as any).error) : `HTTP ${r.status}`);
  return body as T;
}
const jsonInit = (method: string, body: unknown): RequestInit => ({ method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

export const api = {
  health: async (): Promise<Health | null> => {
    try {
      const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 2500);
      const h = await req<Health>('/api/health', { signal: ctl.signal }); clearTimeout(t);
      return h?.ok ? h : null;
    } catch { return null; }
  },
  tools: () => req<ToolInfo[]>('/api/tools'),
  guide: () => req<{ guide: string }>('/api/guide'),
  run: (name: string, args: Record<string, unknown>) => req<ToolRun>('/api/tool/' + encodeURIComponent(name), jsonInit('POST', args)),
  workspace: () => req<WorkspaceIndex>('/api/workspace'),
  addScript: (name: string, source: string, extra: { parent?: string; derivedBy?: string } = {}) => req<ScriptMeta>('/api/workspace/scripts', jsonInit('POST', { name, source, ...extra })),
  uploadScript: (name: string, bytes: ArrayBuffer) => req<ScriptMeta>('/api/workspace/scripts?name=' + encodeURIComponent(name), { method: 'POST', headers: { 'content-type': 'application/octet-stream' }, body: bytes }),
  getScript: (id: string) => req<{ meta: ScriptMeta; source: string }>('/api/workspace/scripts/' + encodeURIComponent(id)),
  deleteScript: (id: string) => req<{ ok: boolean }>('/api/workspace/scripts/' + encodeURIComponent(id), { method: 'DELETE' }),
  patchScript: (id: string, patch: Partial<Pick<ScriptMeta, 'name' | 'tags' | 'notes'>>) => req<ScriptMeta>('/api/workspace/scripts/' + encodeURIComponent(id), jsonInit('PATCH', patch)),
  rawScriptUrl: (id: string) => BASE + '/api/workspace/scripts/' + encodeURIComponent(id) + '/raw',
  opmaps: () => req<string[]>('/api/workspace/opmaps'),
  getOpmap: (name: string) => req<Record<string, unknown>>('/api/workspace/opmaps/' + encodeURIComponent(name)),
  putOpmap: (name: string, map: Record<string, unknown>) => req<{ ok: boolean; file: string }>('/api/workspace/opmaps/' + encodeURIComponent(name), jsonInit('PUT', map)),
  deleteOpmap: (name: string) => req<{ ok: boolean }>('/api/workspace/opmaps/' + encodeURIComponent(name), { method: 'DELETE' }),
  outputUrl: (name: string, download = false) => BASE + '/api/workspace/outputs/' + encodeURIComponent(name) + (download ? '?download=1' : ''),
  readOutput: async (name: string) => { const r = await fetch(api.outputUrl(name)); if (!r.ok) throw new Error('HTTP ' + r.status); return new Uint8Array(await r.arrayBuffer()); },
  saveOutput: (name: string, content: string | Uint8Array) => req<{ ok: boolean; file: string }>('/api/workspace/outputs/' + encodeURIComponent(name), { method: 'PUT', body: content as BodyInit }),
  deleteOutput: (name: string) => req<{ ok: boolean }>('/api/workspace/outputs/' + encodeURIComponent(name), { method: 'DELETE' }),
};
