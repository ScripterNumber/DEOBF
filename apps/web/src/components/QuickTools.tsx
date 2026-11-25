import React, { useEffect, useMemo, useState } from 'react';
import { usePrism } from '../ctx.js';
import { api, type ToolInfo, type ToolRun } from '../api.js';
import { Copy, Download, Empty, ErrorBox, JsonView } from './ui.js';

// One button per tool. Tools whose only required input is the script run in one click on the
// current script; tools that need more input open their form in "All Tools".
const SRC_KEYS = ['script_id', 'path', 'source'];

const CAT: Record<string, { label: string; icon: string; order: number }> = {
  vm: { label: 'VM / lifting', icon: '⚙', order: 1 },
  analysis: { label: 'Analysis', icon: '◎', order: 2 },
  deobfuscation: { label: 'Deobfuscation', icon: '✦', order: 3 },
  search: { label: 'Search', icon: '⌕', order: 4 },
  transpile: { label: 'Extract / transpile', icon: '⇄', order: 5 },
  blob: { label: 'Blob Lab', icon: '▦', order: 6 },
  bytecode: { label: 'Bytecode', icon: '01', order: 7 },
  luau: { label: 'Luau (native)', icon: '◆', order: 8 },
  workspace: { label: 'Workspace', icon: '▤', order: 9 },
};

const HERO = [
  { name: 'auto_lift', label: 'Auto lift', sub: 'Full static pipeline: clean → VM → lift → audit', primary: true },
  { name: 'auto_triage', label: 'Auto triage', sub: 'What is this file and what to do next' },
  { name: 'lift_audit', label: 'Lift audit', sub: 'Readability score + manual-fix list' },
  { name: 'deobfuscate', label: 'Deobfuscate', sub: 'Junk removal, constants, renames' },
];

const short = (d: string) => { const s = d.split(/(?<=[.!?])\s|\n/)[0] ?? d; return s.length > 120 ? s.slice(0, 117) + '…' : s; };

export function QuickTools() {
  const { ensureScriptId, target, toast, backend, goTab, send } = usePrism();
  const [tools, setTools] = useState<ToolInfo[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [q, setQ] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [run, setRun] = useState<ToolRun | null>(null);
  const [runErr, setRunErr] = useState<string | null>(null);

  useEffect(() => { if (backend) api.tools().then(setTools).catch(e => setErr(e.message)); }, [backend]);

  const info = (t: ToolInfo) => {
    const props = t.inputSchema.properties ?? {};
    const needsSrc = SRC_KEYS.some(k => k in props);
    const extraReq = (t.inputSchema.required ?? []).filter(k => !SRC_KEYS.includes(k));
    return { needsSrc, oneClick: extraReq.length === 0, extraReq };
  };

  const groups = useMemo(() => {
    const ql = q.toLowerCase();
    const m = new Map<string, ToolInfo[]>();
    for (const t of tools ?? []) {
      if (ql && !(t.name.includes(ql) || t.title.toLowerCase().includes(ql) || t.description.toLowerCase().includes(ql))) continue;
      if (!m.has(t.category)) m.set(t.category, []);
      m.get(t.category)!.push(t);
    }
    return [...m.entries()].sort((a, b) => (CAT[a[0]]?.order ?? 99) - (CAT[b[0]]?.order ?? 99));
  }, [tools, q]);

  const exec = async (t: ToolInfo) => {
    const { needsSrc, oneClick } = info(t);
    if (!oneClick) { send('tool', { name: t.name }); return; }
    setBusy(t.name); setRunErr(null); setRun(null);
    try {
      const args: Record<string, unknown> = {};
      if (needsSrc && 'script_id' in (t.inputSchema.properties ?? {})) {
        const id = await ensureScriptId();
        if (!id) throw new Error('load or paste a script first');
        args.script_id = id;
      }
      const r = await api.run(t.name, args);
      setRun(r);
      if (!r.ok) setRunErr(r.error ?? 'tool failed');
      else toast(`${t.title}: done in ${r.ms} ms`, 'ok');
    } catch (e: any) { setRunErr(e.message); } finally { setBusy(null); }
  };

  if (!backend) return <Empty><div><div className="big">Server not connected</div>Tool buttons need the PRISM server: run <span className="kbd">npm start</span> and open the site from it.<br />Analysis tabs still work in the browser.</div></Empty>;
  if (err) return <ErrorBox error={err} />;
  if (!tools) return <Empty><span className="spin-loader" /></Empty>;
  const byName = new Map(tools.map(t => [t.name, t]));

  return (
    <div className="qt">
      <div className="qt-hero">
        {HERO.map(h => { const t = byName.get(h.name); if (!t) return null; return (
          <button key={h.name} className={'qt-big ' + (h.primary ? 'primary' : '')} disabled={!!busy} onClick={() => exec(t)} title={t.description}>
            <span className="qt-big-l">{busy === h.name ? <span className="spin-loader" /> : (h.primary ? '▶' : '›')} {h.label}</span>
            <span className="qt-big-s">{h.sub}</span>
          </button>); })}
      </div>
      <div className="qt-note small muted">Runs on the current <b>{target}</b> script. Buttons marked <span className="chip">form</span> need extra input and open their form.</div>

      {(run || runErr || busy) && <div className="qt-out">
        <div className="row" style={{ gap: 8 }}>
          <b>{busy ? `Running ${busy}…` : run ? run.tool : 'Error'}</b>
          {run && <span className={'pill ' + (run.ok ? 'ok' : 'bad')}>{run.ok ? 'ok' : 'failed'} · {run.ms} ms</span>}
          <span className="spacer" />
          {run?.text && <><Copy text={run.text} /><Download name={`${run.tool}.txt`} content={run.text} /></>}
          {run?.files?.length ? <span className="copy-btn" onClick={() => goTab('workspace')}>{run.files.length} file(s) → Workspace</span> : null}
          <span className="copy-btn" onClick={() => { setRun(null); setRunErr(null); }}>close</span>
        </div>
        {runErr && <ErrorBox error={runErr} />}
        {run?.text && <pre className="qt-pre">{run.text}</pre>}
        {run?.data !== undefined && <JsonView value={run.data} label="data" />}
      </div>}

      <div className="toolbar" style={{ padding: '10px 0' }}><input className="inp" style={{ flex: 1 }} placeholder={`find a tool (${tools.length})…`} value={q} onChange={e => setQ(e.target.value)} /></div>
      {groups.map(([cat, ts]) => (
        <section key={cat} className="qt-sec">
          <div className="qt-sec-h"><span className="qt-ico">{CAT[cat]?.icon ?? '•'}</span>{CAT[cat]?.label ?? cat}<span className="muted small"> · {ts.length}</span></div>
          <div className="qt-grid">
            {ts.map(t => { const i = info(t); return (
              <div key={t.name} className="qt-card">
                <div className="qt-card-t">{t.title}</div>
                <div className="qt-card-d">{short(t.description)}</div>
                <div className="row" style={{ gap: 6, marginTop: 'auto' }}>
                  <button className={'btn sm ' + (i.oneClick ? 'primary' : '')} disabled={!!busy} onClick={() => exec(t)} title={i.oneClick ? 'Run on the current script' : 'Needs: ' + i.extraReq.join(', ')}>
                    {busy === t.name ? <span className="spin-loader" /> : i.oneClick ? '▶ Run' : 'Open form'}
                  </button>
                  {i.oneClick && <span className="copy-btn" onClick={() => send('tool', { name: t.name })} title="Open with all options">options</span>}
                  <span className="spacer" />
                  {!i.oneClick && <span className="chip">form</span>}
                  {!t.readOnly && <span className="chip" title="may write to the workspace">writes</span>}
                </div>
              </div>); })}
          </div>
        </section>
      ))}
    </div>
  );
}
