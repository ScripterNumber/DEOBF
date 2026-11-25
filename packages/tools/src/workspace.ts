// PRISM workspace: everything an analyst (human or AI) produces lives on disk here.
//   scripts/<id>.lua + <id>.json   — imported / derived scripts with metadata + notes
//   opmaps/<name>.json             — custom opcode maps (editable mnemonics)
//   outputs/<name>                 — saved tool outputs (disassembly, python, reports…)
import { mkdirSync, readFileSync, writeFileSync, readdirSync, existsSync, statSync, unlinkSync } from 'node:fs';
import { join, resolve, basename } from 'node:path';
import { createHash } from 'node:crypto';

/** decode file bytes: UTF-8 when valid (the lexer expects Unicode text), else Latin-1 */
export function decodeText(buf: Uint8Array): { text: string; encoding: 'utf8' | 'latin1' } {
  try { return { text: new TextDecoder('utf-8', { fatal: true }).decode(buf).replace(/^\uFEFF/, ''), encoding: 'utf8' }; }
  catch { return { text: Buffer.from(buf).toString('latin1'), encoding: 'latin1' }; }
}
export interface ScriptMeta {
  id: string; name: string; size: number; lines: number; sha1: string; created: string; updated: string; encoding?: 'utf8' | 'latin1';
  parent?: string; derivedBy?: string; tags: string[]; notes: string[];
}
const slug = (s: string) => s.toLowerCase().replace(/\.(lua|luau|txt)$/i, '').replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'script';
const safeName = (s: string) => { const b = basename(s).replace(/[^A-Za-z0-9._-]+/g, '_'); if (!b || b.startsWith('.')) throw new Error('invalid file name: ' + s); return b; };

export class Workspace {
  readonly root: string;
  constructor(root: string) {
    this.root = resolve(root);
    for (const d of ['scripts', 'opmaps', 'outputs']) mkdirSync(join(this.root, d), { recursive: true });
  }
  private p(...xs: string[]) { return join(this.root, ...xs); }
  listScripts(): ScriptMeta[] {
    return readdirSync(this.p('scripts')).filter(f => f.endsWith('.json')).map(f => { try { return JSON.parse(readFileSync(this.p('scripts', f), 'utf8')) as ScriptMeta; } catch { return null; } })
      .filter((m): m is ScriptMeta => !!m).sort((a, b) => a.created.localeCompare(b.created));
  }
  hasScript(id: string) { return existsSync(this.p('scripts', safeName(id) + '.lua')); }
  getMeta(id: string): ScriptMeta {
    const f = this.p('scripts', safeName(id) + '.json');
    if (!existsSync(f)) throw new Error(`unknown script_id "${id}" — use workspace_list to see stored scripts`);
    return JSON.parse(readFileSync(f, 'utf8'));
  }
  getScript(id: string): string {
    const f = this.p('scripts', safeName(id) + '.lua');
    if (!existsSync(f)) throw new Error(`unknown script_id "${id}" — use workspace_list to see stored scripts`);
    return decodeText(readFileSync(f)).text;
  }
  addScript(name: string, source: string, extra: Partial<ScriptMeta> = {}): ScriptMeta {
    const encoding = extra.encoding ?? 'utf8';
    const raw = Buffer.from(source, encoding === 'latin1' ? 'latin1' : 'utf8');
    const sha1 = createHash('sha1').update(raw).digest('hex');
    let id = `${slug(name)}-${sha1.slice(0, 6)}`;
    for (let i = 2; this.hasScript(id) && this.getMeta(id).sha1 !== sha1; i++) id = `${slug(name)}-${sha1.slice(0, 6)}-${i}`;
    const now = new Date().toISOString();
    const prev = this.hasScript(id) ? this.getMeta(id) : null;
    const meta: ScriptMeta = { id, name, size: raw.length, lines: source.split('\n').length, sha1, created: prev?.created ?? now, updated: now, encoding, tags: prev?.tags ?? [], notes: prev?.notes ?? [], ...extra };
    writeFileSync(this.p('scripts', id + '.lua'), raw);
    writeFileSync(this.p('scripts', id + '.json'), JSON.stringify(meta, null, 2));
    return meta;
  }
  updateMeta(id: string, patch: Partial<ScriptMeta>): ScriptMeta {
    const m = { ...this.getMeta(id), ...patch, updated: new Date().toISOString() };
    writeFileSync(this.p('scripts', safeName(id) + '.json'), JSON.stringify(m, null, 2));
    return m;
  }
  deleteScript(id: string) { for (const ext of ['.lua', '.json']) { const f = this.p('scripts', safeName(id) + ext); if (existsSync(f)) unlinkSync(f); } }
  listOpmaps(): string[] { return readdirSync(this.p('opmaps')).filter(f => f.endsWith('.json')).map(f => f.slice(0, -5)).sort(); }
  getOpmap(name: string): Record<string, unknown> {
    const f = this.p('opmaps', safeName(name) + '.json');
    if (!existsSync(f)) throw new Error(`unknown opmap "${name}" — available: ${this.listOpmaps().join(', ') || '(none)'}`);
    return JSON.parse(readFileSync(f, 'utf8'));
  }
  setOpmap(name: string, map: Record<string, unknown>) { writeFileSync(this.p('opmaps', safeName(name) + '.json'), JSON.stringify(map, null, 2)); return 'opmaps/' + safeName(name) + '.json'; }
  deleteOpmap(name: string) { const f = this.p('opmaps', safeName(name) + '.json'); if (existsSync(f)) unlinkSync(f); }
  listOutputs(): Array<{ name: string; size: number; modified: string }> {
    return readdirSync(this.p('outputs')).map(f => { const s = statSync(this.p('outputs', f)); return { name: f, size: s.size, modified: s.mtime.toISOString() }; }).sort((a, b) => a.name.localeCompare(b.name));
  }
  saveOutput(name: string, content: string | Uint8Array): string {
    const n = safeName(name);
    writeFileSync(this.p('outputs', n), typeof content === 'string' ? content : Buffer.from(content));
    return 'outputs/' + n;
  }
  readOutput(name: string): Buffer {
    const f = this.p('outputs', safeName(name));
    if (!existsSync(f)) throw new Error(`unknown output "${name}"`);
    return readFileSync(f);
  }
  deleteOutput(name: string) { const f = this.p('outputs', safeName(name)); if (existsSync(f)) unlinkSync(f); }
  abs(rel: string) { return this.p(rel); }
}
