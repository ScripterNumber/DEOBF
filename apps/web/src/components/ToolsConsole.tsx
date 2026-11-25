import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { usePrism, useInbox } from '../ctx.js';
import { api, type ToolInfo, type JsonSchema, type ToolRun, type ScriptMeta } from '../api.js';
import { Copy, Download, Empty, ErrorBox, Toggle, JsonView, useLocal } from './ui.js';

const LONG = new Set(['source', 'data', 'instructions', 'constants', 'text', 'lua', 'expression', 'pattern', 'renames', 'opmap', 'map', 'steps', 'note', 'content', 'plaintext', 'fields']);
const SRC_KEYS = ['script_id', 'path', 'source'];
type SrcMode = 'target' | 'input' | 'cleaned' | 'script' | 'path' | 'inline' | 'none';

const typeOf = (s: JsonSchema): string => { const t = Array.isArray(s.type) ? s.type.find(x => x !== 'null') : s.type; if (t) return t; if (s.anyOf) return s.anyOf.map(typeOf).includes('string') ? 'string' : typeOf(s.anyOf[0]); return 'string'; };

export function ToolsConsole() {
  const { ensureScriptId, target, toast, backend } = usePrism();
  const [tools, setTools] = useState<ToolInfo[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [sel, setSel] = useLocal('tools:sel', 'auto_triage');
  const [q, setQ] = useState('');
  const [vals, setVals] = useLocal<Record<string, Record<string, string>>>('tools:vals', {});
  const [srcMode, setSrcMode] = useLocal<SrcMode>('tools:src', 'target');
  const [srcVal, setSrcVal] = useState('');
  const [scripts, setScripts] = useState<ScriptMeta[]>([]);
  const [run, setRun] = useState<ToolRun | null>(null);
  const [busy, setBusy] = useState(false);
  const [hist, setHist] = useLocal<Array<{ tool: string; args: Record<string, unknown>; ok: boolean; ms: number; at: string }>>('tools:hist', []);

  useEffect(() => { api.tools().then(setTools).catch(e => setErr(e.message)); api.workspace().then(w => setScripts(w.scripts)).catch(() => {}); }, [backend]);
  useInbox('tool', useCallback((p: { name: string; args?: Record<string, string> }) => { setSel(p.name); if (p.args) setVals(v => ({ ...v, [p.name]: p.args! })); }, [setSel, setVals]));

  const tool = tools?.find(t => t.name === sel);
  const props = tool?.inputSchema.properties ?? {};
  const hasSrc = SRC_KEYS.some(k => k in props);
  const v = vals[sel] ?? {};
  const setV = (k: string, x: string) => setVals(all => ({ ...all, [sel]: { ...(all[sel] ?? {}), [k]: x } }));
  const groups = useMemo(() => {
    const ql = q.toLowerCase(); const m = new Map<string, ToolInfo[]>();
    for (const t of tools ?? []) if (!ql || t.name.includes(ql) || t.title.toLowerCase().includes(ql) || t.description.toLowerCase().includes(ql)) { if (!m.has(t.category)) m.set(t.category, []); m.get(t.category)!.push(t); }
    return [...m.entries()];
  }, [tools, q]);

  const buildArgs = async (): Promise<Record<string, unknown>> => {
    const args: Record<string, unknown> = {};
    for (const [k, s] of Object.entries(props)) {
      if (SRC_KEYS.includes(k)) continue;
      const raw = v[k]; if (raw === undefined || raw === '') continue;
      const t = typeOf(s);
      if (t === 'number' || t === 'integer') { const n = Number(raw); if (Number.isNaN(n)) throw new Error(`${k}: not a number`); args[k] = n; }
      else if (t === 'boolean') args[k] = raw === 'true';
      else if (t === 'array' || t === 'object') { try { args[k] = JSON.parse(raw); } catch { throw new Error(`${k}: invalid JSON`); } }
      else args[k] = raw;
    }
    if (hasSrc) {
      if (srcMode === 'target' || srcMode === 'input' || srcMode === 'cleaned') { const id = await ensureScriptId(srcMode === 'target' ? undefined : srcMode); if (!id) throw new Error('no current script — paste/open one first'); args.script_id = id; }
      else if (srcMode === 'script') { if (!srcVal) throw new Error('pick a workspace script'); args.script_id = srcVal; }
      else if (srcMode === 'path') { if (!srcVal) throw new Error('enter a path on the server'); args.path = srcVal; }
      else if (srcMode === 'inline') { if (!srcVal) throw new Error('enter source'); args.source = srcVal; }
    }
    return args;
  };
  const exec = async () => {
    if (!tool) return;
    setBusy(true); setErr(null);
    try {
      const args = await buildArgs();
      const r = await api.run(tool.name, args);
      setRun(r);
      setHist(h => [{ tool: tool.name, args, ok: r.ok, ms: r.ms, at: new Date().toLocaleTimeString() }, ...h].slice(0, 40));
      if (r.files?.length || /script_id|saved/.test(r.text ?? '')) api.workspace().then(w => setScripts(w.scripts)).catch(() => {});
    } catch (e: any) { setErr(e.message); } finally { setBusy(false); }
  };
  const restore = (h: { tool: string; args: Record<string, unknown> }) => {
    setSel(h.tool);
    const o: Record<string, string> = {};
    for (const [k, x] of Object.entries(h.args)) { if (SRC_KEYS.includes(k)) continue; o[k] = typeof x === 'string' ? x : JSON.stringify(x); }
    setVals(all => ({ ...all, [h.tool]: o }));
    if (h.args.script_id) { setSrcMode('script'); setSrcVal(String(h.args.script_id)); } else if (h.args.path) { setSrcMode('path'); setSrcVal(String(h.args.path)); }
  };

  if (err && !tools) return <ErrorBox error={err} />;
  if (!tools) return <Empty><span className="spin-loader" /></Empty>;
  const mcpCall = (a: Record<string, unknown>) => JSON.stringify({ name: sel, arguments: a }, null, 2);
  const lastArgs = hist.find(h => h.tool === sel)?.args ?? {};

  return (
    <div className="split" style={{ gridTemplateColumns: 'minmax(220px, 270px) 1fr' }}>
      <div className="col">
        <div className="toolbar"><input className="inp" style={{ flex: 1 }} placeholder={`filter ${tools.length} tools…`} value={q} onChange={e => setQ(e.target.value)} /></div>
        <div className="fill scroll">
          {groups.map(([cat, ts]) => (
            <div key={cat}>
              <div className="sec-title" style={{ padding: '8px 12px 2px' }}>{cat}</div>
              <div className="list">{ts.map(t => <div key={t.name} className={'li ' + (t.name === sel ? 'sel' : '')} onClick={() => { setSel(t.name); setRun(null); }} title={t.description}>
                <div style={{ minWidth: 0 }}><div className="t" style={{ fontSize: 11.5 }}>{t.name}</div><div className="small muted" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{t.title}</div></div>
                <span className="spacer" />{!t.readOnly && <span title="may write to the workspace" style={{ color: 'var(--warn)', fontSize: 10 }}>✎</span>}
              </div>)}</div>
            </div>
          ))}
          {hist.length > 0 && <>
            <div className="row" style={{ padding: '12px 12px 2px' }}><span className="sec-title" style={{ margin: 0 }}>history</span><span className="spacer" /><span className="copy-btn" onClick={() => setHist([])}>clear</span></div>
            <div className="list">{hist.map((h, i) => <div key={i} className="li" onClick={() => restore(h)} title={JSON.stringify(h.args).slice(0, 400)}><span style={{ color: h.ok ? 'var(--ok)' : 'var(--bad)' }}>●</span><span className="t small">{h.tool}</span><span className="spacer" /><span className="small muted">{h.ms}ms · {h.at}</span></div>)}</div>
          </>}
        </div>
      </div>
      <div className="col">
        {tool ? <>
          <div className="toolbar" style={{ alignItems: 'flex-start' }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div className="row"><b style={{ color: '#fff' }}>{tool.title}</b><span className="chip">{tool.name}</span><span className="chip">{tool.category}</span>{tool.readOnly ? <span className="chip">read-only</span> : <span className="chip" style={{ color: 'var(--warn)' }}>writes workspace</span>}</div>
              <div className="small" style={{ marginTop: 4, maxHeight: 74, overflow: 'auto' }}>{tool.description}</div>
            </div>
          </div>
          <div className="fill scroll">
            <div style={{ padding: 12, display: 'grid', gridTemplateColumns: 'minmax(120px, 170px) 1fr', gap: '8px 12px', alignItems: 'start' }}>
              {hasSrc && <>
                <span className="small" style={{ paddingTop: 6, color: 'var(--txt)' }}>source</span>
                <div>
                  <div className="row">
                    <select className="inp" value={srcMode} onChange={e => { setSrcMode(e.target.value as SrcMode); setSrcVal(''); }}>
                      <option value="target">current ({target})</option><option value="input">current input</option><option value="cleaned">current cleaned</option>
                      <option value="script">workspace script…</option><option value="path">file path on server…</option><option value="inline">inline source…</option><option value="none">none</option>
                    </select>
                    {srcMode === 'script' && <select className="inp" value={srcVal} onChange={e => setSrcVal(e.target.value)} style={{ maxWidth: 320 }}><option value="">pick ({scripts.length})…</option>{scripts.map(s => <option key={s.id} value={s.id}>{s.id} — {s.lines} lines{s.derivedBy ? ` (${s.derivedBy})` : ''}</option>)}</select>}
                    {srcMode === 'path' && <input className="inp" style={{ flex: 1 }} value={srcVal} onChange={e => setSrcVal(e.target.value)} placeholder="/abs/path/to/script.lua" />}
                  </div>
                  {srcMode === 'inline' && <textarea className="inp" rows={4} value={srcVal} onChange={e => setSrcVal(e.target.value)} style={{ marginTop: 6 }} />}
                  <div className="small muted" style={{ marginTop: 3 }}>current script is uploaded to the workspace once and passed as script_id</div>
                </div>
              </>}
              {Object.entries(props).filter(([k]) => !SRC_KEYS.includes(k)).map(([k, s]) => {
                const t = typeOf(s); const req = tool.inputSchema.required?.includes(k);
                const en = s.enum ?? s.anyOf?.flatMap(a => a.enum ?? []);
                return (
                  <React.Fragment key={k}>
                    <span className="small mono" style={{ paddingTop: 6, color: req ? '#fff' : 'var(--txt-dim)' }} title={s.description}>{k}{req && <span style={{ color: 'var(--neon2)' }}> *</span>}<div className="muted" style={{ fontSize: 9.5, fontFamily: 'var(--sans)' }}>{t}</div></span>
                    <div>
                      {en && en.length ? <select className="inp" value={v[k] ?? ''} onChange={e => setV(k, e.target.value)}><option value="">(default)</option>{en.map(x => <option key={String(x)} value={String(x)}>{String(x)}</option>)}</select>
                        : t === 'boolean' ? <select className="inp" value={v[k] ?? ''} onChange={e => setV(k, e.target.value)}><option value="">(default)</option><option value="true">true</option><option value="false">false</option></select>
                        : t === 'array' || t === 'object' || LONG.has(k) ? <textarea className="inp" rows={t === 'array' || t === 'object' ? 3 : 4} value={v[k] ?? ''} onChange={e => setV(k, e.target.value)} placeholder={t === 'array' ? '[ … ] JSON' : t === 'object' ? '{ … } JSON' : ''} spellCheck={false} />
                        : <input className="inp" style={{ width: t === 'number' || t === 'integer' ? 140 : '100%' }} type={t === 'number' || t === 'integer' ? 'number' : 'text'} value={v[k] ?? ''} onChange={e => setV(k, e.target.value)} onKeyDown={e => e.key === 'Enter' && exec()} />}
                      {s.description && <div className="small muted" style={{ marginTop: 2 }}>{s.description}</div>}
                    </div>
                  </React.Fragment>
                );
              })}
            </div>
            <div className="row" style={{ padding: '0 12px 12px' }}>
              <button className="btn primary" onClick={exec} disabled={busy}>{busy ? <span className="spin-loader" /> : '▶'} Run {tool.name}</button>
              <span className="copy-btn" onClick={() => setVals(all => ({ ...all, [sel]: {} }))}>reset form</span>
              <span className="spacer" />
              <Copy text={mcpCall(lastArgs)} label="Copy as MCP call" />
              <Copy text={`curl -s -X POST -H 'content-type: application/json' -d '${JSON.stringify(lastArgs).replace(/'/g, "'\\''")}' ${location.origin}/api/tool/${sel}`} label="Copy as curl" />
            </div>
            <ErrorBox error={err} />
            {run && (
              <div style={{ padding: '0 12px 12px' }}>
                <div className="row" style={{ marginBottom: 6 }}>
                  <span className={'pill ' + (run.ok ? 'ok' : 'bad')}>{run.ok ? 'ok' : 'error'}</span><span className="small muted">{run.ms} ms{run.fullLength ? ` · ${run.fullLength.toLocaleString()} chars` : ''}{run.truncated ? ' · truncated (raise max_chars or use save_as)' : ''}</span>
                  <span className="spacer" />{run.ok && <><Copy text={run.text ?? ''} label="Copy output" /><Download name={`${run.tool}.txt`} content={run.text ?? ''} /></>}
                </div>
                {run.ok ? <pre className="block" style={{ maxHeight: 'none' }}>{run.text}</pre> : <ErrorBox error={run.error} />}
                {run.files && run.files.length > 0 && <div className="row" style={{ marginTop: 6 }}><span className="small muted">files:</span>{run.files.map(f => <a key={f} className="chip" href={f.startsWith('outputs/') ? api.outputUrl(f.slice(8), true) : '#'} onClick={e => { if (!f.startsWith('outputs/')) { e.preventDefault(); toast(f, 'info'); } }}>{f}</a>)}</div>}
                {run.data != null && <JsonView value={run.data} label="structured data" />}
              </div>
            )}
          </div>
        </> : <Empty>Pick a tool.</Empty>}
      </div>
    </div>
  );
}
