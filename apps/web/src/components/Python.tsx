import React, { useCallback, useEffect, useState } from 'react';
import Editor from '@monaco-editor/react';
import { usePrism, useInbox } from '../ctx.js';
import { engine } from '../engineClient.js';
import { Copy, Download, Empty, ErrorBox, Busy, Seg, Toggle, useLocal } from './ui.js';

type InlineRes = { code: string; replaced: Array<{ key: string; line: number; callee: string; literal: string }>; skipped: Array<{ key: string; reason: string }> };

/** paste the JSON printed by the generated program → re-inject the values into the Lua source */
function InlinePanel({ onClose, forText }: { onClose: () => void; forText: string }) {
  const { text, name, setInput, send, toast, reveal } = usePrism();
  const [json, setJson] = useLocal('py:inlineJson', '');
  const [reclean, setReclean] = useLocal('py:reclean', false);
  const [res, setRes] = useState<InlineRes | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const fileRef = React.useRef<HTMLInputElement>(null);
  const go = async () => {
    setErr(null); setBusy(true);
    try { const { result } = await engine.op<InlineRes>('inline', text, { values: json, reclean }); setRes(result); toast(`${result.replaced.length} call sites replaced`, 'ok'); }
    catch (e: any) { setErr(e.message); setRes(null); } finally { setBusy(false); }
  };
  const reasons = new Map<string, number>(); for (const s of res?.skipped ?? []) reasons.set(s.reason, (reasons.get(s.reason) ?? 0) + 1);
  return (
    <div className="inline-panel">
      <div className="row" style={{ gap: 8, alignItems: 'center' }}>
        <b className="small" style={{ color: 'var(--neon3)' }}>Results → Lua</b>
        <span className="small muted">run <span className="kbd">python3 file.py out.json</span>, then paste or open out.json — every <span className="mono">"L&lt;line&gt;:&lt;col&gt;"</span> call site is replaced by its value</span>
        <span className="spacer" />
        <span className="x-btn" onClick={onClose} title="close">×</span>
      </div>
      {forText !== text && <div className="small" style={{ color: 'var(--warn)', marginTop: 4 }}>⚠ the source changed since this program was generated — call-site keys only match the exact code the Python was made from.</div>}
      <textarea className="inp" rows={4} value={json} onChange={e => setJson(e.target.value)} placeholder='{"L12:5": "decoded string", "L40:9": {"$bytes": "00ff"}, …}' spellCheck={false} style={{ marginTop: 6, width: '100%' }} />
      <div className="row" style={{ gap: 8, marginTop: 6, alignItems: 'center' }}>
        <button className="btn ghost sm" onClick={() => fileRef.current?.click()}>Open out.json</button>
        <input ref={fileRef} type="file" accept=".json,.txt" style={{ display: 'none' }} onChange={async e => { const f = e.target.files?.[0]; if (f) setJson(await f.text()); e.target.value = ''; }} />
        <Toggle on={reclean} onChange={setReclean} title="run Deobfuscate on the result so string ops on the new literals fold">re-clean after</Toggle>
        <button className="btn primary sm" onClick={go} disabled={!json.trim() || busy}>Inline into Lua</button>
        <span className="copy-btn" onClick={() => { if (json.trim()) send('vm', { chunk: json }); }} title="open this JSON in Disassembly → Chunk explorer (for a dumped VM chunk)">→ Chunk explorer</span>
        <span className="spacer" />
        {res && <>
          <span className="chip hi">{res.replaced.length} replaced</span>{res.skipped.length > 0 && <span className="chip">{res.skipped.length} skipped</span>}
          <span className="copy-btn" onClick={() => { setInput(res.code, name.replace(/\.(lua|luau|txt)$/i, '') + '.inlined.lua'); toast('inlined code is now the input — re-analyzing', 'ok'); }}>Use as input</span>
          <Copy text={res.code} label="Copy Lua" /><Download name={name.replace(/\.(lua|luau|txt)$/i, '') + '.inlined.lua'} content={res.code} />
        </>}
      </div>
      <ErrorBox error={err} />
      {res && (res.replaced.length > 0 || reasons.size > 0) && (
        <div className="scroll" style={{ maxHeight: 150, marginTop: 6 }}>
          {[...reasons].map(([k, v]) => <div key={k} className="small" style={{ color: 'var(--warn)' }}>skipped ×{v}: {k}</div>)}
          <table className="data"><tbody>{res.replaced.slice(0, 300).map(r => <tr key={r.key}><td><span className="line-link" onClick={() => reveal(r.line)}>{r.key}</span></td><td>{r.callee}</td><td className="wrap" style={{ color: 'var(--neon3)' }}>{r.literal}</td></tr>)}</tbody></table>
        </div>
      )}
    </div>
  );
}

export function Python() {
  const { text, target, name } = usePrism();
  const [maxCalls, setMaxCalls] = useLocal('py:maxCalls', 1000);
  const [inl, setInl] = useState(false);
  const [genFor, setGenFor] = useState('');
  const [mode, setMode] = useLocal<'function' | 'whole' | 'slice'>('py:mode', 'function');
  const [fn, setFn] = useState('');
  const [prelude, setPrelude] = useLocal('py:prelude', true);
  const [fns, setFns] = useState<Array<{ id: string; name: string; line: number; params: string[]; stmts: number }>>([]);
  const [out, setOut] = useState<any>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => { let live = true; engine.analyze(text).then(r => live && setFns(r.result.callGraph.functions.filter(f => f.id !== 'main').map(f => ({ id: f.id, name: f.name, line: f.line, params: f.params, stmts: f.stmts })))).catch(() => {}); return () => { live = false; }; }, [text]);

  const go = useCallback(async (m = mode, f = fn) => {
    setErr(null); setBusy(true);
    try {
      if (m !== 'whole' && !f) { setOut(null); return; }
      const q = m !== 'whole' ? (/^\d+$/.test(f) ? Number(f) : f) : '';
      const { result } = m === 'slice' ? await engine.op('luaslice', text, { fn: q, prelude, maxCalls }) : await engine.op('python', text, { fn: m === 'function' ? q : '', prelude, maxCalls });
      if (!result) throw new Error(`function "${f}" not found — pick one from the list (name or line number)`);
      setOut(result); setGenFor(text);
    } catch (e: any) { setErr(e.message); setOut(null); } finally { setBusy(false); }
  }, [mode, fn, text, prelude, maxCalls]);

  useInbox('python', useCallback((p: any) => { if (p.inline) { setInl(true); return; } const m = mode === 'slice' ? 'slice' : 'function'; setMode(m); setFn(String(p.fn)); go(m, String(p.fn)); }, [go, setMode, mode]));
  useEffect(() => { if (mode === 'whole') go('whole'); }, [mode, text, prelude]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (mode !== 'whole' && fn) go(mode, fn); }, [prelude, mode]); // eslint-disable-line react-hooks/exhaustive-deps

  const isLua = mode === 'slice';
  const file = (mode !== 'whole' && out?.name ? out.name.replace(/[^\w]+/g, '_') : name.replace(/\.(lua|luau|txt)$/i, '')) + (isLua ? '.slice.lua' : '.py');
  return (
    <div className="col">
      <Busy on={busy} label="Transpiling" />
      <div className="toolbar">
        <Seg value={mode} onChange={setMode} options={[{ v: 'function', label: 'one function (+ deps)' }, { v: 'whole', label: 'whole script' }, { v: 'slice', label: 'Lua slice (exact)', title: 'the ORIGINAL Lua of the function + its static dependencies + a call-site harness — runs unchanged in your Lua 5.1 / Luau, prints the same JSON' }]} />
        {mode !== 'whole' && <>
          <input className="inp" list="py-fns" placeholder="function name or line" value={fn} onChange={e => setFn(e.target.value)} onKeyDown={e => e.key === 'Enter' && go()} style={{ width: 200 }} />
          <datalist id="py-fns">{fns.slice(0, 2000).map(f => <option key={f.id} value={String(f.line)}>{f.name} ({f.params.join(', ')}) · {f.stmts} stmts</option>)}</datalist>
          <select className="inp" value="" onChange={e => { if (e.target.value) { setFn(e.target.value); go('function', e.target.value); } }} style={{ maxWidth: 240 }}>
            <option value="">pick… ({fns.length})</option>{fns.slice(0, 2000).map(f => <option key={f.id} value={String(f.line)}>L{f.line} {f.name}({f.params.join(',')})</option>)}
          </select>
          <button className="btn sm" onClick={() => go()} disabled={!fn}>{isLua ? 'Extract' : 'Transpile'}</button>
        </>}
        <Toggle on={prelude} onChange={setPrelude} title="include the Lua-semantics runtime helpers (1-based strings, bit32, string.byte/char/sub, table ops)">{isLua ? 'compat shims' : 'runtime prelude'}</Toggle>
        {mode !== 'whole' && <label className="small muted" title="__main__ evaluates the function at every call site with static arguments (identical argument lists once) — this caps the distinct argument lists">calls <input className="inp" type="number" min={1} max={20000} value={maxCalls} onChange={e => setMaxCalls(Math.max(1, Number(e.target.value) || 1))} style={{ width: 70, padding: '2px 6px' }} /></label>}
        <span className="small muted">on {target} code</span>
        <span className="spacer" />
        {out && <><Copy text={out.code} label={isLua ? 'Copy Lua' : 'Copy Python'} /><Download name={file} content={out.code} mime={isLua ? 'text/x-lua' : 'text/x-python'} /></>}
        {mode !== 'whole' && <span className={'copy-btn' + (inl ? ' on' : '')} onClick={() => setInl(v => !v)} title="paste the JSON the program printed and put the decoded values back into the Lua source">Results → Lua</span>}
      </div>
      {inl && <InlinePanel onClose={() => setInl(false)} forText={genFor || text} />}
      {out && (out.warnings?.length > 0 || out.freeNames?.length > 0 || out.deps?.length > 0) && (
        <div className="toolbar" style={{ paddingTop: 5, paddingBottom: 5 }}>
          {out.deps?.length > 0 && <span className="small">deps: <span className="mono" style={{ color: 'var(--neon3)' }}>{out.deps.join(', ')}</span></span>}
          {out.freeNames?.length > 0 && <span className="small">free names: <span className="mono" style={{ color: 'var(--warn)' }}>{out.freeNames.slice(0, 30).join(', ')}</span></span>}
          {out.warnings?.length > 0 && <span className="small" style={{ color: 'var(--warn)' }} title={out.warnings.join('\n')}>⚠ {out.warnings.length} warning(s): {out.warnings.slice(0, 2).join(' · ')}</span>}
          {out.warnings?.length > 0 && <Copy text={out.warnings.join('\n')} label="Copy warnings" />}
        </div>
      )}
      <ErrorBox error={err} />
      <div className="fill">
        {out ? <Editor height="100%" language={isLua ? 'lua' : 'python'} theme="prism" path={'py-' + file} value={out.code} options={{ minimap: { enabled: false }, fontSize: 12, readOnly: true, scrollBeyondLastLine: false, automaticLayout: true }} />
          : !err && <Empty><div><div className="big">Lua → Python 3</div>Port a decoder/unpacker (pick it from Constants or VM Map → “→ Python”, or by name / line here). The program runs standalone: its <span className="mono">__main__</span> evaluates the function at every call site with static arguments and prints one JSON object keyed <span className="mono">"L&lt;line&gt;:&lt;col&gt;"</span>. Run <span className="kbd">python3 file.py out.json</span>, then <b>Results → Lua</b> puts the decoded constants back into the script, or open a dumped VM chunk in Disassembly → Chunk explorer.</div></Empty>}
      </div>
    </div>
  );
}
