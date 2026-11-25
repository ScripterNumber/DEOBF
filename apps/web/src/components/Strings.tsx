import React, { useMemo, useState } from 'react';
import type { FullReport } from '@prism/core';
import { Copy, Empty, LineLink, latin1Bytes } from './ui.js';
import { usePrism } from '../ctx.js';

function tags(s: string): string[] {
  const t: string[] = [];
  if (/^https?:\/\//i.test(s) || /discord\.gg|roblox\.com|pastebin|github/i.test(s)) t.push('url');
  if (/GetService|FindFirstChild|WaitForChild|HttpGet|loadstring|getgenv|hookfunction/.test(s) || /^(game|workspace|Players|Instance|Enum)\b/.test(s)) t.push('roblox');
  if (/^[A-Za-z0-9+/=]{24,}$/.test(s)) t.push('base64?');
  if (/[^\x20-\x7e]/.test(s)) t.push('binary');
  if (/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(s) && s.length <= 32) t.push('ident');
  return t;
}
const esc = (s: string) => s.replace(/[\x00-\x1f]/g, c => '\\' + c.charCodeAt(0));

export function Strings({ rep }: { rep: FullReport }) {
  const { reveal, send } = usePrism();
  const [q, setQ] = useState('');
  const [only, setOnly] = useState('all');
  const rows = useMemo(() => rep.strings.samples.map(s => ({ ...s, tags: tags(s.value) })), [rep]);
  const filtered = useMemo(() => {
    const ql = q.toLowerCase();
    return rows.filter(r => (only === 'all' || r.tags.includes(only)) && (!ql || r.value.toLowerCase().includes(ql)));
  }, [rows, q, only]);
  const allText = filtered.map(r => r.value).join('\n');
  const tsv = filtered.map(r => `${r.line ?? ''}\t${r.tags.join(',')}\t${esc(r.value)}`).join('\n');
  if (!rows.length) return <Empty>No string literals found.</Empty>;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <div className="toolbar">
        <input value={q} onChange={e => setQ(e.target.value)} placeholder="Search strings…"
          style={{ flex: 1, minWidth: 140, background: 'rgba(10,6,22,0.6)', border: '1px solid var(--stroke)', borderRadius: 9, color: 'var(--txt)', padding: '7px 11px', fontFamily: 'var(--mono)', fontSize: 12, outline: 'none' }} />
        <div className="seg">
          {['all', 'url', 'roblox', 'ident', 'base64?', 'binary'].map(t => (
            <label key={t}><input type="radio" name="strfilter" checked={only === t} onChange={() => setOnly(t)} style={{ display: 'none' }} />{t}</label>
          ))}
        </div>
        <span className="spacer" />
        <span className="small muted">{filtered.length} / {rep.strings.total}</span>
        <Copy text={allText} label="Copy all" /><Copy text={tsv} label="Copy TSV" />
      </div>
      <div className="panel-body" style={{ overflow: 'auto' }}>
        <table className="data">
          <thead><tr><th style={{ width: 40 }}>#</th><th>value</th><th style={{ width: 90 }}>tags</th><th style={{ width: 60 }}>line</th><th style={{ width: 110 }}></th></tr></thead>
          <tbody>
            {filtered.map((r, i) => (
              <tr key={i}>
                <td className="num">{i + 1}</td>
                <td style={{ maxWidth: 420, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={r.value}>{esc(r.value)}</td>
                <td>{r.tags.map(t => <span key={t} className="chip" style={{ fontSize: 9, padding: '1px 6px', marginRight: 3 }}>{t}</span>)}</td>
                <td>{r.line !== undefined && <LineLink line={r.line} onClick={l => reveal(l)} />}</td>
                <td style={{ whiteSpace: 'nowrap' }}><Copy text={r.value} label="copy" /> <span className="copy-btn" onClick={() => send('blob', { bytes: latin1Bytes(r.value), label: `string L${r.line ?? '?'}` })}>→ Blob</span></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}