import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Editor from '@monaco-editor/react';
import { engine, FullResult, resetEngine } from './engineClient.js';
import { api, type Health } from './api.js';
import { Ctx, type Inbox, type PrismCtx, type TabId, type Target } from './ctx.js';
import type { FullReport, CleanOptions } from '@prism/core';
import { Overview } from './components/Overview.js';
import { Strings } from './components/Strings.js';
import { CallGraph } from './components/CallGraph.js';
import { Cleaned } from './components/Cleaned.js';
import { VmAnalysis } from './components/VmAnalysis.js';
import { Anatomy } from './components/Anatomy.js';
import { Tokens } from './components/Tokens.js';
import { OpcodeMap } from './components/OpcodeMap.js';
import { Disassembly } from './components/Disassembly.js';
import { Constants } from './components/Constants.js';
import { Search } from './components/Search.js';
import { Python } from './components/Python.js';
import { BlobLab } from './components/BlobLab.js';
import { ToolsConsole } from './components/ToolsConsole.js';
import { QuickTools } from './components/QuickTools.js';
import { WorkspacePanel } from './components/Workspace.js';
import { Help } from './components/Help.js';
import { Copy, Empty, formatBytes, useLocal } from './components/ui.js';

const GROUPS: Array<{ label: string; tabs: Array<{ id: TabId; label: string; needs?: 'report' | 'text' | 'backend'; hint: string }> }> = [
  { label: 'start', tabs: [
    { id: 'actions', label: '▶ Actions', hint: 'one button per tool — Auto lift, triage, audit, every backend tool' },
  ] },
  { label: 'analyze', tabs: [
    { id: 'overview', label: 'Overview', needs: 'report', hint: 'family, metrics, VM summary' },
    { id: 'cleaned', label: 'Deobfuscate', needs: 'report', hint: 'junk removal passes, diff, rename map' },
    { id: 'callgraph', label: 'Call Graph', needs: 'report', hint: 'functions and calls' },
    { id: 'strings', label: 'Strings', needs: 'report', hint: 'string literals' },
    { id: 'tokens', label: 'Tokens', needs: 'text', hint: 'raw lexer view' },
  ] },
  { label: 'reverse', tabs: [
    { id: 'anatomy', label: 'VM Map', needs: 'text', hint: 'boot → run → exit: payload, deserializer, wrapper, interpreter, exits, entry, main chunks' },
    { id: 'vm', label: 'VM', needs: 'report', hint: 'dispatch loops, blobs, handler clusters' },
    { id: 'opcodes', label: 'Opcode Map', needs: 'text', hint: 'editable opcode → mnemonic map' },
    { id: 'disasm', label: 'Disassembly', hint: 'Luau / Lua 5.1 bytecode + custom VM instruction arrays' },
    { id: 'constants', label: 'Constants', needs: 'text', hint: 'decoders, keys, strings, numbers, arrays' },
    { id: 'search', label: 'Search & Xrefs', needs: 'text', hint: 'text/regex, AST patterns, scope-aware xrefs' },
  ] },
  { label: 'extract', tabs: [
    { id: 'python', label: 'Python', needs: 'text', hint: 'port Lua to Python (whole file or one function)' },
    { id: 'blob', label: 'Blob Lab', hint: 'decode pipelines, XOR key recovery, magic detection' },
  ] },
  { label: 'server', tabs: [
    { id: 'tools', label: 'All Tools', needs: 'backend', hint: 'every backend/MCP tool with a generated form' },
    { id: 'workspace', label: 'Workspace', needs: 'backend', hint: 'stored scripts, opmaps, outputs' },
  ] },
];

const SAMPLES = [
  'luraph_v14.8.lua', 'luraph_v14.7.lua', 'luraph_v14.5.1.lua', 'prometheus_strong_1.lua', 'prometheus_strong_2.lua', 'prometheus_weak_1.lua', 'prometheus_weak_2.lua',
  'prometheus_wearedevs_1.lua', 'moonsec_v3_1.lua', 'moonsec_v3_2.lua', 'moonsec_v2_1.lua', 'moonsec_v2_2.lua', 'ironbrew2_1.lua', 'ironbrew2_2.lua',
  'hercules_max_1.lua', 'hercules_max_2.lua', 'luaobf_vm_1.lua', 'luaobf_vm_2.lua',
];

const PLACEHOLDER = `-- Paste obfuscated Luau/Lua here, drop a .lua/.luau/.txt file (or bytecode), or load a sample.
-- Static analysis only: nothing is ever executed.  Ctrl+Enter = Analyze
`;

function quickHash(s: string): string { let h = 2166136261; for (let i = 0; i < s.length; i += Math.max(1, s.length >> 16)) h = Math.imul(h ^ s.charCodeAt(i), 16777619); return (h >>> 0).toString(16) + ':' + s.length; }

function decodeFile(buf: ArrayBuffer): { text?: string; bytes?: Uint8Array } {
  const b = new Uint8Array(buf);
  const head = b.subarray(0, 4096);
  let ctrl = 0; for (const x of head) if (x < 9 || (x > 13 && x < 32)) ctrl++;
  const isLuaBc = b[0] === 0x1b && b[1] === 0x4c && b[2] === 0x75 && b[3] === 0x61;
  if (isLuaBc || ctrl > head.length * 0.05) return { bytes: b };
  try { return { text: new TextDecoder('utf-8', { fatal: true }).decode(b) }; } catch { let s = ''; for (let i = 0; i < b.length; i += 8192) s += String.fromCharCode(...b.subarray(i, i + 8192)); return { text: s }; }
}

export function App() {
  const [src, setSrc] = useState('');
  const [name, setName] = useState('untitled.lua');
  const [res, setRes] = useState<FullResult | null>(null);
  const [cleanedReport, setCleanedReport] = useState<FullReport | null>(null);
  const [analyzedHash, setAnalyzedHash] = useState('');
  const [ms, setMs] = useState(0);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [tab, setTab] = useLocal<TabId>('tab', 'actions');
  const [target, setTarget] = useLocal<Target>('target', 'cleaned');
  const [cleanOpts, setCleanOpts] = useLocal<CleanOptions>('cleanOpts', { rounds: 4 });
  const [edTab, setEdTab] = useState<Target>('input');
  const [focus, setFocus] = useState(false);
  const [split, setSplit] = useLocal('split', 38);
  const bodyRef = useRef<HTMLDivElement>(null);
  const startDrag = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    const el = bodyRef.current; if (!el) return;
    const r = el.getBoundingClientRect();
    const move = (ev: MouseEvent) => setSplit(Math.min(75, Math.max(18, ((ev.clientX - r.left) / r.width) * 100)));
    const up = () => { window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up); document.body.classList.remove('dragging'); };
    window.addEventListener('mousemove', move); window.addEventListener('mouseup', up); document.body.classList.add('dragging');
  }, [setSplit]);
  const [help, setHelp] = useState(false);
  const [over, setOver] = useState(false);
  const [backend, setBackend] = useState<Health | null>(null);
  const [inbox, setInbox] = useState<Inbox | null>(null);
  const [toasts, setToasts] = useState<Array<{ id: number; msg: string; kind: string }>>([]);
  const fileRef = useRef<HTMLInputElement>(null);
  const editorRef = useRef<any>(null);
  const monacoRef = useRef<any>(null);
  const decoRef = useRef<string[]>([]);
  const idCache = useRef(new Map<string, string>());

  const toast = useCallback((msg: string, kind: 'ok' | 'bad' | 'info' = 'info') => {
    const id = Date.now() + Math.random();
    setToasts(t => [...t.slice(-4), { id, msg, kind }]);
    setTimeout(() => setToasts(t => t.filter(x => x.id !== id)), kind === 'bad' ? 6000 : 3200);
  }, []);

  const refreshBackend = useCallback(() => { api.health().then(setBackend); }, []);
  useEffect(() => { refreshBackend(); const t = setInterval(refreshBackend, 15000); return () => clearInterval(t); }, [refreshBackend]);

  const run = useCallback(async (text: string, opts?: CleanOptions) => {
    if (!text.trim()) return;
    setBusy(true); setErr(null);
    try {
      const { result, ms } = await engine.full(text, opts ?? cleanOpts);
      setRes(result); setMs(ms); setCleanedReport(null); setAnalyzedHash(quickHash(text));
    } catch (e: any) { setErr(String(e?.message || e)); }
    finally { setBusy(false); }
  }, [cleanOpts]);

  const reclean = useCallback(async (opts: CleanOptions) => {
    setCleanOpts(opts);
    if (!res || !src.trim()) return;
    setBusy(true);
    try { const { result } = await engine.clean(src, opts); setRes({ ...res, clean: result }); setCleanedReport(null); toast(`re-cleaned: ${result.rounds} rounds`, 'ok'); }
    catch (e: any) { toast(String(e?.message || e), 'bad'); }
    finally { setBusy(false); }
  }, [res, src, setCleanOpts, toast]);

  const setInput = useCallback((text: string, n?: string) => { setSrc(text); if (n) setName(n); setEdTab('input'); run(text); }, [run]);

  const onFile = useCallback(async (f: File) => {
    const d = decodeFile(await f.arrayBuffer());
    if (d.bytes) { setInbox({ kind: 'disasm', payload: { bytes: d.bytes, label: f.name }, nonce: Date.now() }); setTab('disasm'); toast(`${f.name}: binary file → Disassembly`, 'info'); return; }
    setInput(d.text!, f.name);
  }, [setInput, setTab, toast]);

  const onDrop = useCallback((e: React.DragEvent) => { e.preventDefault(); setOver(false); const f = e.dataTransfer.files?.[0]; if (f) onFile(f); }, [onFile]);

  const loadSample = useCallback(async (n: string) => {
    try { const r = await fetch('samples/' + n); if (!r.ok) throw new Error('sample not found'); setInput(await r.text(), n); }
    catch (e: any) { setErr(String(e?.message || e)); }
  }, [setInput]);

  const cleanedText = res?.clean.code ?? '';
  const text = target === 'cleaned' && cleanedText ? cleanedText : src;
  const effTarget: Target = target === 'cleaned' && cleanedText ? 'cleaned' : 'input';

  // lazily analyze the cleaned code when a report-based tab needs it
  const needsReport = GROUPS.flatMap(g => g.tabs).find(t => t.id === tab)?.needs === 'report';
  useEffect(() => {
    if (effTarget === 'cleaned' && needsReport && tab !== 'overview' && tab !== 'cleaned' && res && !cleanedReport && cleanedText) {
      engine.analyze(cleanedText).then(r => setCleanedReport(r.result)).catch(e => toast(String(e.message || e), 'bad'));
    }
  }, [effTarget, needsReport, tab, res, cleanedReport, cleanedText, toast]);
  const report = effTarget === 'cleaned' ? cleanedReport : res?.report ?? null;

  const reveal = useCallback((line: number, col = 1, t?: Target) => {
    const tt = t ?? effTarget;
    setFocus(false); setEdTab(tt);
    setTimeout(() => {
      const ed = editorRef.current, m = monacoRef.current; if (!ed || !m) return;
      ed.revealLineInCenter(line); ed.setPosition({ lineNumber: line, column: col });
      decoRef.current = ed.deltaDecorations(decoRef.current, [{ range: new m.Range(line, 1, line, 1), options: { isWholeLine: true, className: 'hl-line', glyphMarginClassName: 'hl-glyph' } }]);
      ed.focus();
    }, 80);
  }, [effTarget]);

  const ensureScriptId = useCallback(async (t?: Target): Promise<string | null> => {
    if (!backend) return null;
    const tt = t ?? effTarget;
    const body = tt === 'cleaned' ? cleanedText : src;
    if (!body.trim()) return null;
    const key = tt + '|' + quickHash(body);
    const hit = idCache.current.get(key); if (hit) return hit;
    try {
      let parent: string | undefined;
      if (tt === 'cleaned') parent = await ensureScriptId('input') ?? undefined;
      const base = name.replace(/\.(lua|luau|txt)$/i, '');
      const meta = await api.addScript(tt === 'cleaned' ? base + '.clean.lua' : name, body, parent ? { parent, derivedBy: 'web deobfuscate' } : {});
      idCache.current.set(key, meta.id);
      return meta.id;
    } catch (e: any) { toast('workspace upload failed: ' + e.message, 'bad'); return null; }
  }, [backend, effTarget, cleanedText, src, name, toast]);

  const send = useCallback((kind: Inbox['kind'], payload: any) => {
    setInbox({ kind, payload, nonce: Date.now() + Math.random() });
    const map: Record<Inbox['kind'], TabId> = { blob: 'blob', disasm: 'disasm', vm: 'disasm', search: 'search', python: 'python', tool: 'tools' };
    setTab(map[kind]);
  }, [setTab]);

  // keyboard shortcuts
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); run(src); }
      else if ((e.ctrlKey || e.metaKey) && e.shiftKey && (e.key === 'F' || e.key === 'f')) { e.preventDefault(); setTab('search'); }
      else if (e.key === 'F1') { e.preventDefault(); setHelp(true); }
      else if (e.key === 'Escape') setHelp(false);
    };
    window.addEventListener('keydown', h); return () => window.removeEventListener('keydown', h);
  }, [run, src, setTab]);

  const ctx: PrismCtx = useMemo(() => ({
    src, name, clean: res?.clean ?? null, report, target: effTarget, text, setTarget, backend, refreshBackend, ensureScriptId,
    reveal, goTab: setTab, send, inbox, setInput, toast,
  }), [src, name, res, report, effTarget, text, setTarget, backend, refreshBackend, ensureScriptId, reveal, setTab, send, inbox, setInput, toast]);

  const rep = res?.report;
  const stale = !!res && quickHash(src) !== analyzedHash;
  const exportAll = rep ? JSON.stringify({ name, report: rep, cleanStats: res?.clean.stats, renameMap: res?.clean.renameMap }, null, 2) : '';
  const curTab = GROUPS.flatMap(g => g.tabs).find(t => t.id === tab) ?? GROUPS[0].tabs[0];

  const body = (() => {
    if (curTab.needs === 'backend' && !backend) return <Empty><div><div className="big">Backend not connected</div>Start the PRISM server (<span className="kbd">npm start</span>) and open the site from it — then all {''}
      tools, the workspace, native luau-compile/analyze and MCP become available.<div style={{ marginTop: 12 }}><button className="btn sm" onClick={refreshBackend}>Retry connection</button></div></div></Empty>;
    if (curTab.needs === 'report' && !rep) return <Empty><div><div className="big">Load or paste a script, then Analyze</div>Generic static engine for any Lua 5.1 / Luau obfuscator — Luraph, Prometheus, MoonSec, IronBrew, Hercules, LuaObfuscator, custom VMs.</div></Empty>;
    if (curTab.needs === 'report' && effTarget === 'cleaned' && tab !== 'overview' && tab !== 'cleaned' && !cleanedReport) return <Empty><div><span className="spin-loader" style={{ display: 'inline-block' }} /><div className="big" style={{ marginTop: 8 }}>Analyzing cleaned code…</div></div></Empty>;
    if (curTab.needs === 'text' && !text.trim()) return <Empty><div><div className="big">No script yet</div>Paste or open a script on the left.</div></Empty>;
    switch (tab) {
      case 'overview': return <Overview rep={rep!} ms={ms} cleaned={res!.clean} />;
      case 'cleaned': return <Cleaned original={src} clean={res!.clean} opts={cleanOpts} onReclean={reclean} />;
      case 'anatomy': return <Anatomy />;
      case 'vm': return <VmAnalysis rep={report!} />;
      case 'callgraph': return <CallGraph rep={report!} />;
      case 'strings': return <Strings rep={report!} />;
      case 'tokens': return <Tokens src={text} />;
      case 'opcodes': return <OpcodeMap />;
      case 'disasm': return <Disassembly />;
      case 'constants': return <Constants />;
      case 'search': return <Search />;
      case 'python': return <Python />;
      case 'blob': return <BlobLab />;
      case 'actions': return <QuickTools />;
      case 'tools': return <ToolsConsole />;
      case 'workspace': return <WorkspacePanel />;
    }
  })();

  return (
    <Ctx.Provider value={ctx}>
      <div className="app" onDragOver={e => { e.preventDefault(); setOver(true); }} onDragLeave={e => { if (e.currentTarget === e.target) setOver(false); }} onDrop={onDrop}>
        <div className="topbar">
          <div className="brand">
            <div className="logo" />
            <div><h1>PRISM</h1><div className="tag">static luau reverse engine</div></div>
          </div>
          <div className="spacer" />
          <div className="meta">
            {rep && <span className={'pill ' + (rep.ok ? 'ok' : 'bad')} title={rep.parseErrors.slice(0, 5).map(e => `L${e.line}: ${e.message}`).join('\n')}>{rep.ok ? 'parsed clean' : rep.parseErrors.length + ' parse errors'}</span>}
            {rep && <span className="mono" title={name}>{name.length > 28 ? name.slice(0, 26) + '…' : name} · {formatBytes(rep.metrics.bytes)} · {ms}ms</span>}
            {stale && <span className="pill warn link" onClick={() => run(src)} title="Input changed since the last analysis">stale — re-analyze</span>}
            {rep && <Copy text={exportAll} label="Export report" />}
            <span className={'pill link ' + (backend ? 'ok' : '')} onClick={() => { refreshBackend(); if (backend) setTab('workspace'); }}
              title={backend ? `server ${backend.version} · workspace ${backend.workspace}\nMCP: ${backend.mcp}` : 'static mode — everything runs in your browser. Start the server for the workspace, native luau tools and MCP.'}>
              {backend ? `● server · ${backend.tools} tools` : '○ local engine'}
            </span>
            <span className="pill link" onClick={() => setHelp(true)} title="Help, workflow & MCP setup (F1)">? Help</span>
          </div>
        </div>

        <div className={'body ' + (focus ? 'focus' : '')} ref={bodyRef} style={focus ? undefined : { gridTemplateColumns: `${split}% 10px minmax(0, 1fr)` }}>
          <div className="panel">
            <div className="panel-head">
              <div className="edtabs">
                <span className={'edtab ' + (edTab === 'input' ? 'active' : '')} onClick={() => setEdTab('input')}>Input</span>
                <span className={'edtab ' + (edTab === 'cleaned' ? 'active' : '') + (cleanedText ? '' : ' dis')} onClick={() => setEdTab('cleaned')}>Cleaned</span>
              </div>
              <span className="spacer" />
              {edTab === 'cleaned' && cleanedText && <><Copy text={cleanedText} label="Copy" /><span className="copy-btn" onClick={() => { setInput(cleanedText, name.replace(/\.(lua|luau|txt)$/i, '') + '.clean.lua'); toast('cleaned code is now the input', 'ok'); }} title="Use the cleaned code as new input (iterate)">Use as input</span></>}
              {edTab === 'input' && src && <Copy text={src} label="Copy" />}
              <SampleMenu onPick={loadSample} />
              <button className="btn ghost sm" onClick={() => fileRef.current?.click()}>Open file</button>
              <input ref={fileRef} type="file" style={{ display: 'none' }} onChange={e => { const f = e.target.files?.[0]; if (f) onFile(f); e.target.value = ''; }} />
              <button className="btn primary" disabled={busy || !src.trim()} onClick={() => run(src)} title="Ctrl+Enter">
                {busy ? <span className="spin-loader" /> : '▶'} {busy ? 'Analyzing' : 'Analyze'}
              </button>
              {busy && <span className="copy-btn" onClick={() => { resetEngine(); setBusy(false); toast('analysis cancelled', 'info'); }}>Cancel</span>}
            </div>
            <div style={{ flex: 1, minHeight: 0, position: 'relative' }}>
              {over && <div className="drop over" style={{ position: 'absolute', inset: 0, zIndex: 5, display: 'grid', placeItems: 'center', margin: 0 }}>Drop a .lua / .luau file (or compiled bytecode)</div>}
              <Editor height="100%" language="lua" theme="prism" path={edTab === 'input' ? 'input.lua' : 'cleaned.lua'}
                value={edTab === 'input' ? (src || '') : cleanedText}
                onChange={v => { if (edTab === 'input') setSrc(v ?? ''); }}
                onMount={(ed, m) => { editorRef.current = ed; monacoRef.current = m; }}
                options={{ minimap: { enabled: false }, fontSize: 12, wordWrap: 'on', scrollBeyondLastLine: false, automaticLayout: true, glyphMargin: true, readOnly: edTab === 'cleaned', placeholder: PLACEHOLDER } as any} />
              {edTab === 'input' && !src && <div className="editor-ph">{PLACEHOLDER}</div>}
            </div>
          </div>

          <div className="gutter" onMouseDown={startDrag} onDoubleClick={() => setSplit(38)} title="drag to resize · double-click to reset" />
          <div className="panel">
            <div className="tabbar">
              <span className="icon-btn" onClick={() => setFocus(!focus)} title={focus ? 'Show the editor panel' : 'Hide the editor panel (focus mode)'}>
                <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5"><rect x="1.5" y="2.5" width="13" height="11" rx="2" /><line x1="6" y1="2.5" x2="6" y2="13.5" />{focus ? <path d="M8.5 6l2 2-2 2" /> : <path d="M10.5 6l-2 2 2 2" />}</svg>
              </span>
              {GROUPS.map(g => (
                <div className="grp" key={g.label}>
                  <span className="grp-l">{g.label}</span>
                  <div className="grp-t">
                    {g.tabs.map(t => (
                      <div key={t.id} title={t.hint} className={'tab ' + (tab === t.id ? 'active ' : '') + ((t.needs === 'backend' && !backend) || (t.needs === 'report' && !rep) ? 'off' : '')} onClick={() => setTab(t.id)}>{t.label}</div>
                    ))}
                  </div>
                </div>
              ))}
              <div className="target-switch" title="Which code the analysis tabs work on">
                on
                <div className="seg">
                  <label><input type="radio" checked={target === 'input'} onChange={() => setTarget('input')} style={{ display: 'none' }} />input</label>
                  <label style={cleanedText ? undefined : { opacity: .5 }}><input type="radio" checked={target === 'cleaned'} onChange={() => setTarget('cleaned')} style={{ display: 'none' }} />cleaned</label>
                </div>
              </div>
            </div>
            <div className="panel-body" style={{ position: 'relative' }}>
              {err && <div className="errbox"><b>Error</b> {err}<Copy text={err} /></div>}
              {body}
            </div>
          </div>
        </div>
        {help && <Help onClose={() => setHelp(false)} />}
        <div className="toasts">{toasts.map(t => <div key={t.id} className={'toast ' + t.kind}>{t.msg}</div>)}</div>
      </div>
    </Ctx.Provider>
  );
}

function SampleMenu({ onPick }: { onPick: (n: string) => void }) {
  return (
    <select className="btn ghost sm" defaultValue="" onChange={e => { if (e.target.value) { onPick(e.target.value); e.target.value = ''; } }} style={{ appearance: 'none', paddingRight: 12, maxWidth: 140 }}>
      <option value="" disabled>Load sample…</option>
      {SAMPLES.map(s => <option key={s} value={s}>{s}</option>)}
    </select>
  );
}
