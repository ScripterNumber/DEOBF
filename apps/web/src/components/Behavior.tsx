// Behaviour / IOC panel — "what does this script do?" from static evidence (identifiers, methods, decoded strings, URLs).
import React, { useEffect, useState } from 'react';
import type { BehaviorReport } from '@prism/core';
import { Copy, Download, ErrorBox, LineLink } from './ui.js';
import { usePrism } from '../ctx.js';
import { engine } from '../engineClient.js';

type Res = { report: BehaviorReport; text: string };
const SEV: Record<string, string> = { high: 'bad', warn: 'warn', notice: 'ok', info: '' };
const URLSEV: Record<string, string> = { 'discord-webhook': 'bad', 'telegram-bot': 'bad', webhook: 'bad', 'ip-lookup': 'bad', 'ip-logger': 'bad', 'code-host': 'warn', 'discord-invite': 'ok' };

/** Runs behaviorReport in the worker on the current analysis text and/or a decoded chunk / string list. */
export function BehaviorPanel({ chunk, strings, noSource, label, compact }: { chunk?: string; strings?: Array<{ value: string; where?: string }>; noSource?: boolean; label?: string; compact?: boolean }) {
  const { text, reveal, name, toast } = usePrism();
  const [res, setRes] = useState<Res | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [extra, setExtra] = useState('');
  const [open, setOpen] = useState<string | null>(null);
  const fileRef = React.useRef<HTMLInputElement>(null);
  const run = async (more = extra) => {
    setBusy(true); setErr(null);
    try {
      const mine = more.trim();
      let extraChunk: string | undefined; let extraStrings: Array<{ value: string; where?: string }> | undefined;
      if (mine) { if (/^[[{]/.test(mine)) extraChunk = mine; else extraStrings = mine.split(/\r?\n/).filter(Boolean).map((value, i) => ({ value, where: '#' + (i + 1) })); }
      if (chunk && extraChunk) extraChunk = `[${chunk},${extraChunk}]`;
      const { result } = await engine.op<Res>('behavior', noSource ? '' : text, { chunk: extraChunk ?? chunk, strings: [...(strings ?? []), ...(extraStrings ?? [])], noSource, label: label ?? name, maxHits: 30 });
      setRes(result);
    } catch (e: any) { setErr(e.message); } finally { setBusy(false); }
  };
  useEffect(() => { run(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [text, chunk, strings, noSource]);
  const r = res?.report;
  const urls = r?.urls ?? [];
  const cats = (r?.categories ?? []).filter(c => c.count > 0);
  return (
    <div className="beh">
      <ErrorBox error={err} />
      {busy && !r && <div className="small muted">scanning…</div>}
      {r && <>
        <div className="row" style={{ gap: 6, flexWrap: 'wrap', marginBottom: 6 }}>
          <span className="small muted">{r.scanned.names.toLocaleString()} identifiers · {r.scanned.strings.toLocaleString()} strings scanned{busy ? ' · updating…' : ''}</span>
          <span className="spacer" />
          {urls.length > 0 && <Copy text={urls.map(u => u.url).join('\n')} label={`Copy URLs (${urls.length})`} />}
          <Copy text={res!.text} label="Copy report" />
          <Download name={(name || 'script').replace(/\.(lua|luau|txt)$/i, '') + '.iocs.txt'} content={res!.text} />
          <Copy text={JSON.stringify(r, null, 2)} label="JSON" />
        </div>
        <div className="beh-verdict">{r.verdict.map((v, i) => <div key={i} className={/^HIGH/.test(v) ? 'v-high' : ''}>▸ {v}</div>)}</div>
        {urls.length > 0 && (
          <div className="scroll" style={{ maxHeight: compact ? 180 : 320, marginTop: 8 }}>
            <table className="data"><thead><tr><th>kind</th><th>url / asset</th><th>where</th><th /></tr></thead>
              <tbody>{urls.slice(0, 300).map((u, i) => (
                <tr key={i}><td><span className={'pill ' + (URLSEV[u.kind] ?? '')}>{u.kind}</span></td><td className="wrap">{u.url}</td>
                  <td>{u.line ? <LineLink line={u.line} onClick={l => reveal(l)} /> : <span className="muted">{u.where ?? ''}</span>}</td>
                  <td><Copy text={u.url} label="Copy" /></td></tr>))}</tbody></table>
          </div>
        )}
        <div className="beh-cats">
          {cats.length ? cats.map(c => (
            <div key={c.id} className={'beh-cat' + (open === c.id ? ' open' : '')}>
              <div className="beh-cat-h" onClick={() => setOpen(open === c.id ? null : c.id)}>
                <span className={'pill ' + SEV[c.severity]}>{c.severity}</span><b>{c.title}</b><span className="chip">{c.count}</span>
                <span className="chips" style={{ flex: 1, minWidth: 0 }}>{c.indicators.slice(0, compact ? 6 : 14).map(n => <span key={n} className="chip role">{n}</span>)}{c.indicators.length > (compact ? 6 : 14) ? <span className="muted small">+{c.indicators.length - (compact ? 6 : 14)}</span> : null}</span>
                <span className="muted small">{open === c.id ? '▾' : '▸'}</span>
              </div>
              {open === c.id && <div className="beh-hits">{c.hits.map((h, i) => (
                <div key={i} className="small mono">{h.line ? <LineLink line={h.line} onClick={l => reveal(l)} /> : <span className="muted">{h.where ?? '—'}</span>} <b>{h.indicator}</b> <span className="muted">{h.text}</span></div>))}
                <Copy text={c.hits.map(h => `${h.line ? 'L' + h.line : h.where ?? ''}\t${h.indicator}\t${h.text}`).join('\n')} label="Copy hits" />
              </div>}
            </div>)) : <div className="small muted">no behaviour indicators — if strings are still encrypted, decode them first (Constants → Python → Results → Lua) and rescan.</div>}
        </div>
      </>}
      <details className="beh-more" style={{ marginTop: 8 }}>
        <summary className="small muted">add decoded strings / JSON (Python out.json, chunk dump, one string per line)</summary>
        <textarea className="inp" rows={4} value={extra} onChange={e => setExtra(e.target.value)} spellCheck={false} placeholder='["https://…", "writefile"]  or  {"L12:5": "decoded"}  or  one string per line' />
        <div className="row" style={{ gap: 6, marginTop: 4 }}>
          <button className="btn primary sm" onClick={() => run()} disabled={busy}>Rescan</button>
          <button className="btn ghost sm" onClick={() => fileRef.current?.click()}>Open JSON</button>
          <input ref={fileRef} type="file" accept=".json,.txt,.lua" style={{ display: 'none' }} onChange={async e => { const f = e.target.files?.[0]; if (f) { const t = await f.text(); setExtra(t); toast(`${f.name} loaded`, 'ok'); run(t); } e.target.value = ''; }} />
          {extra && <span className="copy-btn" onClick={() => { setExtra(''); run(''); }}>clear</span>}
        </div>
      </details>
    </div>
  );
}
