import React, { useEffect, useMemo, useState } from 'react';
import type { ConstantsReport, DecoderCandidate } from '@prism/core';
import { usePrism } from '../ctx.js';
import { engine } from '../engineClient.js';
import { Copy, Download, Empty, ErrorBox, Busy, Seg, LineLink, Toggle, latin1Bytes, download } from './ui.js';

type Sec = 'decoders' | 'keys' | 'strings' | 'numbers' | 'arrays';

export function Constants() {
  const { text, target } = usePrism();
  const [rep, setRep] = useState<ConstantsReport | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [sec, setSec] = useState<Sec>('decoders');
  useEffect(() => {
    let live = true; setBusy(true); setErr(null);
    engine.op<ConstantsReport>('constants', text, { maxStrings: 5000, maxNumbers: 4000, maxArrays: 300, maxDecoders: 40 })
      .then(r => live && setRep(r.result)).catch(e => live && setErr(e.message)).finally(() => live && setBusy(false));
    return () => { live = false; };
  }, [text]);
  if (err) return <ErrorBox error={err} />;
  if (!rep) return <Empty><div><span className="spin-loader" style={{ display: 'inline-block' }} /><div className="big" style={{ marginTop: 8 }}>Collecting constants…</div></div></Empty>;
  const s = rep.summary;
  return (
    <div className="col">
      <Busy on={busy} label="Collecting" />
      <div className="toolbar">
        <Seg value={sec} onChange={setSec} options={[
          { v: 'decoders', label: `decoders ${rep.decoders.length}` }, { v: 'keys', label: `keys ${rep.keys.length}` },
          { v: 'strings', label: `strings ${s.uniqueStrings}` }, { v: 'numbers', label: `numbers ${s.uniqueNumbers}` }, { v: 'arrays', label: `arrays ${s.arrays}` }]} />
        <span className="small muted">{s.strings} string literals ({s.bytes.toLocaleString()} bytes), {s.numbers} numbers — on {target} code</span>
        <span className="spacer" />
        <Copy text={JSON.stringify(rep, null, 2)} label="Copy all JSON" />
      </div>
      <div className="fill scroll">
        {sec === 'decoders' && <Decoders list={rep.decoders} />}
        {sec === 'keys' && <Keys rep={rep} />}
        {sec === 'strings' && <StringsT rep={rep} />}
        {sec === 'numbers' && <Numbers rep={rep} />}
        {sec === 'arrays' && <Arrays rep={rep} />}
      </div>
    </div>
  );
}

function DecodeKit({ list }: { list: DecoderCandidate[] }) {
  const { text, name, send, toast } = usePrism();
  const cands = list.filter(d => d.literalArgCalls > 0 && d.endLine > 0);
  const [sel, setSel] = useState<Record<number, boolean>>({});
  const [res, setRes] = useState<any>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [extra, setExtra] = useState('');
  const chosen = cands.filter(d => sel[d.line] !== false).slice(0, 12);
  const extras = extra.split(/[,\s]+/).filter(Boolean).map(x => /^\d+$/.test(x) ? Number(x) : x);
  const make = async (lang: 'python' | 'lua') => {
    setBusy(true); setErr(null);
    try { const { result } = await engine.op('bundle', text, { functions: [...chosen.map(d => d.line), ...extras], lang, maxCalls: 1000, label: name }); setRes(result); toast(`${result.parts.length} decoder(s), ${result.sites} call sites in one ${lang} program`, 'ok'); }
    catch (e: any) { setErr(e.message); } finally { setBusy(false); }
  };
  const file = name.replace(/\.(lua|luau|txt)$/i, '') + (res?.lang === 'lua' ? '.bundle.lua' : '.bundle.py');
  return (
    <div className="card">
      <div className="card-h"><span className="dot" /><b style={{ color: '#fff' }}>Decode kit</b><span className="small muted">all decoders → ONE program → ONE JSON for every call site</span><span className="spacer" />
        <button className="btn primary sm" onClick={() => make('python')} disabled={busy || !(chosen.length + extras.length)}>Python bundle</button>
        <button className="btn sm" onClick={() => make('lua')} disabled={busy || !(chosen.length + extras.length)} title="exact original Lua slices, each in its own do…end block — run with lua5.1 / luau">Lua bundle</button></div>
      <div className="card-b">
        <div className="chips" style={{ alignItems: 'center' }}>{cands.length === 0 && <span className="small muted">no candidate with literal-argument calls — add functions by name / line:</span>}
          <input className="inp" value={extra} onChange={e => setExtra(e.target.value)} placeholder="+ functions (name / line, …)" style={{ width: 190, padding: '2px 8px' }} title="extra functions to include, e.g. decode, 120" />
          {cands.slice(0, 12).map(d => <span key={d.line} className={'chip line-chip' + (sel[d.line] !== false ? ' hi' : '')} onClick={() => setSel({ ...sel, [d.line]: sel[d.line] === false })} title="click to include / exclude">{d.name} <b>L{d.line}</b> · {d.literalArgCalls} calls</span>)}</div>
        {err && <div className="small" style={{ color: 'var(--bad)', marginTop: 6 }}>{err}</div>}
        {res && <div style={{ marginTop: 8 }}>
          <div className="small">{res.parts.map((p: any, i: number) => <div key={i}>▸ {p.error ? `${p.query}: ${p.error}` : <><b className="mono">{p.name}</b> L{p.line} — {p.sites} site(s){p.deps.length ? ` · deps ${p.deps.join(', ')}` : ''}{p.freeNames.length ? <span style={{ color: 'var(--warn)' }}> · free {p.freeNames.join(', ')}</span> : null}</>}</div>)}</div>
          {res.warnings.length > 0 && <div className="small" style={{ color: 'var(--warn)' }}>{res.warnings.slice(0, 4).join(' · ')}</div>}
          <div className="row" style={{ marginTop: 6, gap: 6 }}>
            <Copy text={res.code} label={`Copy ${res.lang === 'lua' ? 'Lua' : 'Python'} (${Math.round(res.code.length / 1024)} KB)`} />
            <Download name={file} content={res.code} mime={res.lang === 'lua' ? 'text/x-lua' : 'text/x-python'} />
            <span className="small muted">run <span className="kbd">{res.lang === 'lua' ? `luau ${file} > out.json` : `python3 ${file} out.json`}</span> → </span>
            <span className="copy-btn" onClick={() => send('python', { inline: true })} title="opens Python → Results → Lua: paste / open out.json">Results → Lua</span>
          </div>
        </div>}
      </div>
    </div>
  );
}

function Decoders({ list }: { list: DecoderCandidate[] }) {
  const { text, reveal, send } = usePrism();
  const [open, setOpen] = useState<Record<number, string>>({});
  if (!list.length) return <Empty>No decoder-like functions found (no loops over bytes / pool accessors). Try Deobfuscate first, or switch the target.</Empty>;
  const view = async (i: number, d: DecoderCandidate) => {
    if (open[i] !== undefined) { const n = { ...open }; delete n[i]; setOpen(n); return; }
    const { result } = await engine.op('getFunction', text, { query: d.line });
    setOpen({ ...open, [i]: result?.code ?? '(function source not found)' });
  };
  const all = list.map(d => `${d.score.toFixed(1)}  ${d.kind.padEnd(18)} ${d.name}  L${d.line}-${d.endLine}  params=${d.params} calls=${d.callSites} literal=${d.literalArgCalls}\n    ${d.reasons.join('; ')}${d.sampleCalls.length ? '\n    e.g. ' + d.sampleCalls.join(' | ') : ''}`).join('\n');
  return (
    <div className="cards">
      <DecodeKit list={list} />
      <div className="row"><span className="small muted">Ranked by static evidence: byte loops, % 256 / bit ops, string.char/byte, table.concat, literal-argument call sites. “constant-accessor” = pool lookup, “string-decoder”/“deserializer” = the unpacker to port.</span><span className="spacer" /><Copy text={all} label="Copy list" /></div>
      {list.map((d, i) => (
        <div className="card" key={i}>
          <div className="card-h"><span className="dot" /><span className="chip hi">{d.kind}</span><span className="mono" style={{ color: '#fff' }}>{d.name}</span>
            <LineLink line={d.line} onClick={l => reveal(l)} /><span className="muted small">→ L{d.endLine} · {d.params} params{d.stmts ? ` · ${d.stmts} stmts` : ''}</span>
            <span className="spacer" /><span className="chip">score <b>{d.score.toFixed(1)}</b></span></div>
          <div className="card-b">
            <div className="small">{d.reasons.join(' · ')}</div>
            <div className="small muted" style={{ marginTop: 4 }}>{d.callSites} call site(s), {d.literalArgCalls} with literal args</div>
            {d.sampleCalls.length > 0 && <div className="code-peek" style={{ maxHeight: 90 }}>{d.sampleCalls.join('\n')}</div>}
            <div className="row" style={{ marginTop: 6 }}>
              <button className="btn sm" onClick={() => view(i, d)}>{open[i] !== undefined ? 'Hide code' : 'View code'}</button>
              <button className="btn sm" onClick={() => send('python', { fn: String(d.line) })}>→ Python</button>
              <button className="btn sm" onClick={() => send('search', { mode: 'xrefs', name: d.name.replace(/^<.*>$/, ''), line: d.line })} disabled={/^</.test(d.name)}>Xrefs</button>
              {open[i] && <Copy text={open[i]} label="Copy code" />}
            </div>
            {open[i] !== undefined && <div className="code-peek" style={{ maxHeight: 420 }}>{open[i]}</div>}
          </div>
        </div>
      ))}
    </div>
  );
}

function Keys({ rep }: { rep: ConstantsReport }) {
  const { reveal, send } = usePrism();
  if (!rep.keys.length) return <Empty>No key-like constants (long high-entropy strings next to xor/byte loops) found.</Empty>;
  return (
    <>
      <div className="toolbar"><span className="small muted">strings/numbers used next to xor / byte arithmetic — likely keys or seeds</span><span className="spacer" /><Copy text={rep.keys.map(k => `L${k.line}\t${k.value}\t${k.context}`).join('\n')} label="Copy" /></div>
      <table className="data"><thead><tr><th>value</th><th>line</th><th>context</th><th /></tr></thead>
        <tbody>{rep.keys.map((k, i) => <tr key={i}><td style={{ color: 'var(--ok)', maxWidth: 300, overflow: 'hidden', textOverflow: 'ellipsis' }}>{k.value}</td><td><LineLink line={k.line} onClick={l => reveal(l)} /></td><td style={{ maxWidth: 380, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={k.context}>{k.context}</td>
          <td><Copy text={k.value} /> <span className="copy-btn" onClick={() => send('blob', { bytes: latin1Bytes(k.value), label: `key L${k.line}` })}>→ Blob</span></td></tr>)}</tbody></table>
    </>
  );
}

function StringsT({ rep }: { rep: ConstantsReport }) {
  const { reveal, send } = usePrism();
  const [q, setQ] = useState(''); const [kind, setKind] = useState('all'); const [hiEnt, setHiEnt] = useState(false);
  const kinds = useMemo(() => [...new Set(rep.strings.map(s => s.kind))].sort(), [rep]);
  const rows = useMemo(() => { const ql = q.toLowerCase(); return rep.strings.filter(s => (kind === 'all' || s.kind === kind) && (!hiEnt || s.entropy > 4.5) && (!ql || s.display.toLowerCase().includes(ql))); }, [rep, q, kind, hiEnt]);
  return (
    <>
      <div className="toolbar">
        <input className="inp" placeholder="filter…" value={q} onChange={e => setQ(e.target.value)} style={{ flex: 1, minWidth: 120 }} />
        <select className="inp" value={kind} onChange={e => setKind(e.target.value)}><option value="all">all kinds</option>{kinds.map(k => <option key={k}>{k}</option>)}</select>
        <Toggle on={hiEnt} onChange={setHiEnt} title="entropy > 4.5 bits/byte: encrypted / compressed / encoded">high entropy</Toggle>
        <span className="small muted">{rows.length}</span><span className="spacer" />
        <Copy text={rows.map(r => r.display).join('\n')} label="Copy values" />
        <Copy text={rows.map(r => `${r.lines[0] ?? ''}\t${r.kind}\t${r.len}\t${r.entropy.toFixed(2)}\t${r.display}`).join('\n')} label="Copy TSV" />
      </div>
      <table className="data"><thead><tr><th>value</th><th>kind</th><th className="num">len</th><th className="num">H</th><th className="num">×</th><th>line</th><th /></tr></thead>
        <tbody>{rows.slice(0, 2000).map((r, i) => <tr key={i}>
          <td style={{ maxWidth: 420, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: 'var(--ok)' }} title={r.display.slice(0, 2000)}>{r.display.slice(0, 300)}</td>
          <td>{r.kind}</td><td className="num">{r.len}</td><td className="num">{r.entropy.toFixed(2)}</td><td className="num">{r.count}</td>
          <td>{r.lines[0] !== undefined && <LineLink line={r.lines[0]} onClick={l => reveal(l)} />}{r.lines.length > 1 && <span className="muted"> +{r.lines.length - 1}</span>}</td>
          <td style={{ whiteSpace: 'nowrap' }}><Copy text={r.value} /> <span className="copy-btn" onClick={() => send('blob', { bytes: latin1Bytes(r.value), label: `string L${r.lines[0] ?? '?'}` })}>→ Blob</span></td></tr>)}</tbody></table>
      {rows.length > 2000 && <div className="small muted" style={{ padding: 10 }}>showing 2000 of {rows.length} — Copy gets all</div>}
    </>
  );
}

function Numbers({ rep }: { rep: ConstantsReport }) {
  const { reveal } = usePrism();
  const [q, setQ] = useState(''); const [tagged, setTagged] = useState(false);
  const rows = useMemo(() => rep.numbers.filter(n => (!tagged || n.tags.length) && (!q || n.raw.includes(q) || String(n.value).includes(q) || n.tags.some(t => t.includes(q)))), [rep, q, tagged]);
  return (
    <>
      <div className="toolbar">
        <input className="inp" placeholder="filter value / tag…" value={q} onChange={e => setQ(e.target.value)} style={{ flex: 1, minWidth: 120 }} />
        <Toggle on={tagged} onChange={setTagged} title="only numbers with a tag (mask, prime, power of two, ascii, …)">tagged only</Toggle>
        <span className="small muted">{rows.length}</span><span className="spacer" />
        <Copy text={rows.map(n => `${n.value}\t${n.raw}\t${n.count}\t${n.tags.join(',')}`).join('\n')} label="Copy TSV" />
      </div>
      <table className="data"><thead><tr><th className="num">value</th><th>raw</th><th>hex</th><th className="num">×</th><th>tags</th><th>line</th></tr></thead>
        <tbody>{rows.slice(0, 3000).map((n, i) => <tr key={i}><td className="num">{n.value}</td><td>{n.raw}</td><td className="muted">{Number.isInteger(n.value) && Math.abs(n.value) < 2 ** 53 ? (n.value < 0 ? '-0x' + (-n.value).toString(16) : '0x' + n.value.toString(16)) : ''}</td><td className="num">{n.count}</td><td>{n.tags.join(' ')}</td><td>{n.lines[0] !== undefined && <LineLink line={n.lines[0]} onClick={l => reveal(l)} />}</td></tr>)}</tbody></table>
    </>
  );
}

function Arrays({ rep }: { rep: ConstantsReport }) {
  const { reveal, send } = usePrism();
  if (!rep.arrays.length) return <Empty>No literal numeric/string arrays found.</Empty>;
  return (
    <div className="cards">
      {rep.arrays.map((a, i) => {
        const isBytes = a.min >= 0 && a.max <= 255 && !a.strings;
        const json = JSON.stringify(a.strings ?? a.values);
        return (
          <div className="card" key={i}>
            <div className="card-h"><span className="dot" /><span className="chip hi">{a.kind}</span><LineLink line={a.line} onClick={l => reveal(l)} /><span className="small muted">{a.length} items · {a.strings ? 'strings' : `range ${a.min}..${a.max}`}{a.avgEntropy !== undefined ? ` · H ${a.avgEntropy.toFixed(2)}` : ''}</span><span className="spacer" />
              <Copy text={json} label="Copy JSON" />
              {isBytes && <span className="copy-btn" onClick={() => send('blob', { bytes: new Uint8Array(a.values), label: `array L${a.line}` })}>→ Blob</span>}
              <span className="copy-btn" onClick={() => send('vm', { instructions: json })} title="use as instruction stream in the custom VM disassembler">→ VM</span>
              <span className="copy-btn" onClick={() => download(`array_L${a.line}.json`, json, 'application/json')}>Download</span>
            </div>
            <div className="card-b"><div className="code-peek" style={{ maxHeight: 110, whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>{(a.strings ? a.strings.map(s => JSON.stringify(s)) : a.values).slice(0, 400).join(', ')}{a.length > 400 ? ' …' : ''}</div></div>
          </div>
        );
      })}
    </div>
  );
}
