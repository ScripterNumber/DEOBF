import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { usePrism } from '../ctx.js';
import { api, type WorkspaceIndex, type ScriptMeta } from '../api.js';
import { Copy, Empty, ErrorBox, formatBytes, bytesLatin1 } from './ui.js';

export function WorkspacePanel() {
  const { backend, setInput, toast, src, name, ensureScriptId, send } = usePrism();
  const [ws, setWs] = useState<WorkspaceIndex | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [peek, setPeek] = useState<{ title: string; text: string } | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [note, setNote] = useState('');
  const load = useCallback(() => { api.workspace().then(setWs).catch(e => setErr(e.message)); }, []);
  useEffect(load, [load]);

  const tree = useMemo(() => {
    if (!ws) return [] as Array<{ m: ScriptMeta; depth: number }>;
    const ids = new Set(ws.scripts.map(s => s.id));
    const kids = new Map<string, ScriptMeta[]>();
    for (const s of ws.scripts) { const p = s.parent && ids.has(s.parent) ? s.parent : ''; if (!kids.has(p)) kids.set(p, []); kids.get(p)!.push(s); }
    const out: Array<{ m: ScriptMeta; depth: number }> = [];
    const walk = (p: string, d: number) => { for (const s of kids.get(p) ?? []) { out.push({ m: s, depth: d }); if (d < 20) walk(s.id, d + 1); } };
    walk('', 0);
    return out;
  }, [ws]);

  if (err) return <ErrorBox error={err} />;
  if (!ws) return <Empty><span className="spin-loader" /></Empty>;
  const openScript = async (id: string) => { try { const r = await api.getScript(id); setInput(r.source, r.meta.name); toast(`opened ${id}`, 'ok'); } catch (e: any) { toast(e.message, 'bad'); } };
  const del = async (id: string) => { if (!confirm(`Delete script ${id}?`)) return; await api.deleteScript(id); load(); };
  const upload = async (f: File) => { try { const m = await api.uploadScript(f.name, await f.arrayBuffer()); toast(`stored ${m.id}`, 'ok'); load(); } catch (e: any) { toast(e.message, 'bad'); } };
  const addNote = async (m: ScriptMeta) => { if (!note.trim()) return; await api.patchScript(m.id, { notes: [...m.notes, note.trim()] }); setNote(''); load(); };
  const viewOutput = async (n: string) => { try { const b = await api.readOutput(n); let t: string; try { t = new TextDecoder('utf-8', { fatal: true }).decode(b); } catch { t = bytesLatin1(b); } setPeek({ title: n, text: t }); } catch (e: any) { toast(e.message, 'bad'); } };
  const viewOpmap = async (n: string) => { try { setPeek({ title: `opmap ${n}`, text: JSON.stringify(await api.getOpmap(n), null, 2) }); } catch (e: any) { toast(e.message, 'bad'); } };

  return (
    <div className="cards">
      <div className="card"><div className="card-h"><span className="dot" />Server workspace<span className="spacer" /><span className="copy-btn" onClick={load}>↻ refresh</span></div><div className="card-b">
        <div className="kv"><dt>root</dt><dd>{ws.root} <Copy text={ws.root} /></dd><dt>MCP</dt><dd>{backend?.mcp} <Copy text={backend?.mcp ?? ''} /></dd><dt>native luau</dt><dd>{backend ? ['compile', 'analyze', 'ast'].map(k => `${k} ${(backend.luau as any)[k] ? '✓' : '✗'}`).join('  ') : ''}</dd></div>
        <div className="row" style={{ marginTop: 10 }}>
          <button className="btn sm" disabled={!src.trim()} onClick={async () => { const id = await ensureScriptId('input'); if (id) { toast(`stored ${id}`, 'ok'); load(); } }}>Store current input ({name})</button>
          <label className="btn sm ghost" style={{ cursor: 'pointer' }}>Upload file…<input type="file" style={{ display: 'none' }} onChange={e => { const f = e.target.files?.[0]; if (f) upload(f); e.target.value = ''; }} /></label>
          <span className="small muted">the MCP server and this UI share the same workspace — an AI agent's results show up here</span>
        </div>
      </div></div>

      <div className="card"><div className="card-h"><span className="dot" />Scripts ({ws.scripts.length})<span className="spacer" /><Copy text={ws.scripts.map(s => `${s.id}\t${s.name}\t${s.lines}\t${s.size}\t${s.derivedBy ?? ''}\t${s.parent ?? ''}`).join('\n')} label="Copy list" /></div>
        <div className="card-b" style={{ padding: 0 }}>
          {tree.length === 0 ? <div className="small muted" style={{ padding: 12 }}>empty — store a script, or let an MCP agent add some</div> :
            <div className="list">{tree.map(({ m, depth }) => (
              <React.Fragment key={m.id}>
                <div className={'li ' + (open === m.id ? 'sel' : '')} onClick={() => setOpen(open === m.id ? null : m.id)}>
                  <span style={{ width: depth * 16 }} />{depth > 0 && <span className="muted">↳</span>}
                  <span className="t">{m.id}</span><span className="small muted">{m.lines.toLocaleString()} lines · {formatBytes(m.size)}{m.derivedBy ? ` · ${m.derivedBy}` : ''}{m.notes.length ? ` · ${m.notes.length} notes` : ''}</span>
                  <span className="spacer" />
                  <span className="copy-btn" onClick={e => { e.stopPropagation(); openScript(m.id); }}>Open</span>
                  <Copy text={m.id} label="id" />
                  <a className="copy-btn" href={api.rawScriptUrl(m.id)} onClick={e => e.stopPropagation()}>Download</a>
                  <span className="copy-btn" onClick={e => { e.stopPropagation(); send('tool', { name: 'auto_triage', args: {} }); }} title="open in All Tools">Tools</span>
                  <span className="x-btn" onClick={e => { e.stopPropagation(); del(m.id); }} title="delete">×</span>
                </div>
                {open === m.id && <div style={{ padding: '8px 14px 12px', background: 'rgba(10,6,22,0.4)' }}>
                  <div className="kv"><dt>name</dt><dd>{m.name}</dd><dt>sha1</dt><dd>{m.sha1}</dd><dt>created</dt><dd>{m.created}</dd><dt>updated</dt><dd>{m.updated}</dd><dt>encoding</dt><dd>{m.encoding}</dd>{m.parent && <><dt>parent</dt><dd>{m.parent}</dd></>}</div>
                  <div className="sec-title" style={{ marginTop: 8 }}>notes</div>
                  {m.notes.map((n, i) => <div key={i} className="small" style={{ marginBottom: 3 }}>• {n} <Copy text={n} /></div>)}
                  <div className="row" style={{ marginTop: 4 }}><input className="inp" style={{ flex: 1 }} value={note} onChange={e => setNote(e.target.value)} placeholder="add a finding…" onKeyDown={e => e.key === 'Enter' && addNote(m)} /><button className="btn sm" onClick={() => addNote(m)}>Add note</button></div>
                </div>}
              </React.Fragment>
            ))}</div>}
        </div>
      </div>

      <div className="card"><div className="card-h"><span className="dot" />Opcode maps ({ws.opmaps.length})</div><div className="card-b" style={{ padding: 0 }}>
        {ws.opmaps.length === 0 ? <div className="small muted" style={{ padding: 12 }}>none yet — save one from the Opcode Map tab or via opcode_map save_opmap_as</div> :
          <div className="list">{ws.opmaps.map(n => <div key={n} className="li" onClick={() => viewOpmap(n)}><span className="t">{n}</span><span className="spacer" /><span className="x-btn" onClick={async e => { e.stopPropagation(); if (confirm(`Delete opmap ${n}?`)) { await api.deleteOpmap(n); load(); } }}>×</span></div>)}</div>}
      </div></div>

      <div className="card"><div className="card-h"><span className="dot" />Outputs ({ws.outputs.length})</div><div className="card-b" style={{ padding: 0 }}>
        {ws.outputs.length === 0 ? <div className="small muted" style={{ padding: 12 }}>tool outputs saved with save_as / save_output land here</div> :
          <div className="list">{ws.outputs.map(o => <div key={o.name} className="li" onClick={() => viewOutput(o.name)}><span className="t">{o.name}</span><span className="small muted">{formatBytes(o.size)} · {new Date(o.modified).toLocaleString()}</span><span className="spacer" /><a className="copy-btn" href={api.outputUrl(o.name, true)} onClick={e => e.stopPropagation()}>Download</a><span className="x-btn" onClick={async e => { e.stopPropagation(); if (confirm(`Delete ${o.name}?`)) { await api.deleteOutput(o.name); load(); } }}>×</span></div>)}</div>}
      </div></div>

      {peek && <div className="modal-bg" onClick={() => setPeek(null)}><div className="modal" onClick={e => e.stopPropagation()}>
        <div className="modal-h">{peek.title}<span className="spacer" /><Copy text={peek.text} /><span className="x-btn" onClick={() => setPeek(null)}>×</span></div>
        <div className="modal-b"><pre className="block" style={{ maxHeight: '70vh' }}>{peek.text.length > 500000 ? peek.text.slice(0, 500000) + '\n… (Copy for everything)' : peek.text}</pre></div>
      </div></div>}
    </div>
  );
}
