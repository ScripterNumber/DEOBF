import React, { useCallback, useEffect, useMemo, useState } from 'react';
import type { PatternResult, XrefBinding } from '@prism/core';
import { usePrism, useInbox } from '../ctx.js';
import { engine } from '../engineClient.js';
import { Copy, Empty, ErrorBox, Busy, Seg, Toggle, LineLink, useLocal } from './ui.js';

type Mode = 'text' | 'pattern' | 'xrefs' | 'functions';
const PATTERNS = ['string.char($$$)', 'bit32.bxor($X, $Y)', '$T[$K] = $T[$K] + 1', 'local $A = $F($$$)', 'for $I = 1, #$S do $$$ end', 'while true do $$$ end', 'getfenv($$$)', 'loadstring($$$)', 'string.byte($S, $I)', 'setmetatable($T, $M)', '$X % 256', 'select("#", ...)'];

export function Search() {
  const { text, reveal, target, send } = usePrism();
  const [mode, setMode] = useLocal<Mode>('search:mode', 'text');
  const [q, setQ] = useLocal('search:q', '');
  const [regex, setRegex] = useLocal('search:regex', false);
  const [cs, setCs] = useLocal('search:cs', false);
  const [word, setWord] = useLocal('search:word', false);
  const [pat, setPat] = useLocal('search:pat', 'string.char($$$)');
  const [xname, setXname] = useState(''); const [xline, setXline] = useState('');
  const [res, setRes] = useState<any>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [fnq, setFnq] = useState('');

  const go = useCallback(async (m: Mode = mode, over?: { name?: string; line?: string }) => {
    setErr(null); setBusy(true);
    try {
      if (m === 'text') { if (!q) { setRes(null); return; } setRes({ m, ...(await engine.op('find', text, { query: q, regex, caseSensitive: cs, word, max: 3000 })).result }); }
      else if (m === 'pattern') setRes({ m, ...(await engine.op<PatternResult>('pattern', text, { pattern: pat, max: 2000 })).result });
      else if (m === 'xrefs') { const name = over?.name ?? xname; const line = over?.line ?? xline; if (!name) { setRes(null); return; } setRes({ m, list: (await engine.op<XrefBinding[]>('xrefs', text, { name, line: line ? Number(line) : undefined, max: 5000 })).result }); }
      else setRes({ m, rep: (await engine.analyze(text)).result });
    } catch (e: any) { setErr(e.message); setRes(null); } finally { setBusy(false); }
  }, [mode, q, regex, cs, word, pat, xname, xline, text]);

  useInbox('search', useCallback((p: any) => { if (p.mode === 'xrefs') { setMode('xrefs'); setXname(p.name ?? ''); setXline(p.line ? String(p.line) : ''); go('xrefs', { name: p.name, line: p.line ? String(p.line) : '' }); } else if (p.query) { setMode('text'); setQ(p.query); } }, [go, setMode, setQ]));
  useEffect(() => { if (mode === 'functions') go('functions'); }, [mode, text]); // eslint-disable-line react-hooks/exhaustive-deps

  const copyText = useMemo(() => {
    if (!res) return '';
    if (res.m === 'text') return res.hits.map((h: any) => `${h.line}:${h.col}: ${h.text}`).join('\n');
    if (res.m === 'pattern') return res.matches.map((h: any) => `${h.line}:${h.col}: ${h.text}${Object.keys(h.bindings).length ? '   ' + Object.entries(h.bindings).map(([k, v]) => `${k}=${v}`).join(' ') : ''}`).join('\n');
    if (res.m === 'xrefs') return res.list.map((b: XrefBinding) => `${b.kind} ${b.name} (line ${b.line}) — ${b.reads} reads, ${b.writes} writes\n` + b.refs.map(r => `  ${r.kind.padEnd(5)} ${r.line}:${r.col}  ${r.text}`).join('\n')).join('\n\n');
    return res.rep.callGraph.functions.map((f: any) => `${f.line}\t${f.name}\t(${f.params.join(', ')})\t${f.stmts} stmts\t${f.calls.length} calls`).join('\n');
  }, [res]);

  return (
    <div className="col">
      <Busy on={busy} label="Searching" />
      <div className="toolbar">
        <Seg value={mode} onChange={m => { setMode(m); setRes(null); }} options={[{ v: 'text', label: 'text / regex' }, { v: 'pattern', label: 'AST pattern' }, { v: 'xrefs', label: 'xrefs' }, { v: 'functions', label: 'functions' }]} />
        <span className="small muted">on {target} code</span><span className="spacer" />
        {res && <Copy text={copyText} label="Copy results" />}
      </div>
      <div className="toolbar" style={{ paddingTop: 6 }}>
        {mode === 'text' && <>
          <input className="inp" autoFocus style={{ flex: 1, minWidth: 180 }} placeholder="search text… (Enter)" value={q} onChange={e => setQ(e.target.value)} onKeyDown={e => e.key === 'Enter' && go()} />
          <Toggle on={regex} onChange={setRegex}>.* regex</Toggle><Toggle on={cs} onChange={setCs}>Aa case</Toggle><Toggle on={word} onChange={setWord}>whole word</Toggle>
          <button className="btn sm" onClick={() => go()}>Find</button>
        </>}
        {mode === 'pattern' && <>
          <input className="inp" style={{ flex: 1, minWidth: 200 }} placeholder="Lua code with $X / $_ / $$$" value={pat} onChange={e => setPat(e.target.value)} onKeyDown={e => e.key === 'Enter' && go()} />
          <button className="btn sm" onClick={() => go()}>Match</button>
          <div className="row" style={{ width: '100%' }}>{PATTERNS.map(p => <span key={p} className="chip" style={{ cursor: 'pointer' }} onClick={() => { setPat(p); }}>{p}</span>)}</div>
          <div className="small muted">$X = any expression (repeated $X must be equal) · $_ = wildcard · $$$ = any number of args/items/statements</div>
        </>}
        {mode === 'xrefs' && <>
          <input className="inp" style={{ width: 200 }} placeholder="identifier" value={xname} onChange={e => setXname(e.target.value)} onKeyDown={e => e.key === 'Enter' && go()} />
          <input className="inp" style={{ width: 90 }} placeholder="at line?" value={xline} onChange={e => setXline(e.target.value.replace(/\D/g, ''))} onKeyDown={e => e.key === 'Enter' && go()} title="only the binding visible at this line" />
          <button className="btn sm" onClick={() => go()}>Xrefs</button>
          <span className="small muted">scope-aware: every local with that name is a separate binding; globals listed separately</span>
        </>}
        {mode === 'functions' && <input className="inp" style={{ flex: 1 }} placeholder="filter functions…" value={fnq} onChange={e => setFnq(e.target.value)} />}
      </div>
      <ErrorBox error={err || res?.error} />
      <div className="fill scroll">
        {!res && !busy && <Empty>{mode === 'text' ? 'Type a query and press Enter.' : mode === 'pattern' ? 'Structural search over the AST — pick an example or write your own.' : mode === 'xrefs' ? 'Every read / write / declaration of a variable, scope-aware.' : ''}</Empty>}
        {res?.m === 'text' && <>
          <div className="small muted" style={{ padding: '6px 12px' }}>{res.total} matches{res.total > res.hits.length ? ` (showing ${res.hits.length})` : ''}</div>
          <table className="data"><tbody>{res.hits.map((h: any, i: number) => <tr key={i}><td style={{ width: 70 }}><LineLink line={h.line} onClick={l => reveal(l, h.col)} /></td><td style={{ whiteSpace: 'pre', overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: 700 }}><Hi text={h.text} m={h.match} /></td></tr>)}</tbody></table>
        </>}
        {res?.m === 'pattern' && <>
          <div className="small muted" style={{ padding: '6px 12px' }}>{res.total} matches ({res.kind})</div>
          <table className="data"><tbody>{res.matches.map((h: any, i: number) => <tr key={i}><td style={{ width: 70 }}><LineLink line={h.line} onClick={l => reveal(l, h.col)} /></td><td style={{ maxWidth: 520, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={h.text}>{h.text}</td><td>{Object.entries(h.bindings).map(([k, v]) => <span key={k} className="chip" style={{ marginRight: 4 }}>{k}=<b>{String(v).slice(0, 40)}</b></span>)}</td></tr>)}</tbody></table>
        </>}
        {res?.m === 'xrefs' && (res.list.length === 0 ? <Empty>No binding named “{xname}”.</Empty> : res.list.map((b: XrefBinding, i: number) => (
          <div className="card" key={i} style={{ margin: 10 }}>
            <div className="card-h"><span className="dot" /><span className="chip hi">{b.kind}</span><span className="mono" style={{ color: '#fff' }}>{b.name}</span>{b.line > 0 && <LineLink line={b.line} onClick={l => reveal(l)} />}<span className="small muted">{b.reads} reads · {b.writes} writes{b.captured ? ' · captured as upvalue' : ''}</span>
              <span className="spacer" />{b.line > 0 && <span className="copy-btn" onClick={() => send('python', { fn: String(b.line) })}>→ Python</span>}</div>
            <table className="data"><tbody>{b.refs.map((r, j) => <tr key={j}><td style={{ width: 54, color: r.kind === 'write' ? 'var(--warn)' : r.kind === 'decl' ? 'var(--neon2)' : 'var(--txt-mute)' }}>{r.kind}</td><td style={{ width: 80 }}><LineLink line={r.line} onClick={l => reveal(l, r.col)} />:{r.col}</td><td style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: 640 }}>{r.text}</td></tr>)}</tbody></table>
          </div>)))}
        {res?.m === 'functions' && (
          <table className="data"><thead><tr><th>line</th><th>name</th><th>params</th><th className="num">stmts</th><th className="num">calls</th><th>depth</th><th /></tr></thead>
            <tbody>{res.rep.callGraph.functions.filter((f: any) => !fnq || f.name.toLowerCase().includes(fnq.toLowerCase())).slice(0, 3000).map((f: any) => <tr key={f.id}>
              <td><LineLink line={f.line} onClick={l => reveal(l)} /></td><td style={{ color: '#fff' }}>{f.name}</td><td>({f.params.join(', ')}{f.vararg ? (f.params.length ? ', ...' : '...') : ''})</td><td className="num">{f.stmts}</td><td className="num">{f.calls.length}</td><td className="num">{f.depth}</td>
              <td style={{ whiteSpace: 'nowrap' }}><span className="copy-btn" onClick={() => send('python', { fn: String(f.line) })}>→ Python</span> {f.id !== 'main' && !/^</.test(f.name) && <span className="copy-btn" onClick={() => { setMode('xrefs'); setXname(f.name.split(/[.:]/).pop()!); setXline(''); go('xrefs', { name: f.name.split(/[.:]/).pop()!, line: '' }); }}>xrefs</span>}</td></tr>)}</tbody></table>
        )}
      </div>
    </div>
  );
}

function Hi({ text, m }: { text: string; m: string }) {
  const i = m ? text.indexOf(m) : -1;
  if (i < 0) return <>{text}</>;
  return <>{text.slice(0, i)}<b style={{ color: 'var(--neon2)', textShadow: '0 0 8px rgba(255,92,225,.5)' }}>{m}</b>{text.slice(i + m.length)}</>;
}
