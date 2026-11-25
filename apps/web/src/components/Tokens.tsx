import React, { useEffect, useMemo, useState } from 'react';
import { engine } from '../engineClient.js';
import { Copy, Empty, LineLink } from './ui.js';
import { usePrism } from '../ctx.js';

export function Tokens({ src }: { src: string }) {
  const { reveal } = usePrism();
  const [toks, setToks] = useState<any[] | null>(null);
  const [errs, setErrs] = useState<any[]>([]);
  const [busy, setBusy] = useState(true);
  const [type, setType] = useState('all');
  const [q, setQ] = useState('');
  useEffect(() => {
    let live = true; setBusy(true);
    engine.tokenize(src).then(({ result }) => { if (live) { setToks(result.tokens); setErrs(result.errors ?? []); setBusy(false); } }).catch(() => setBusy(false));
    return () => { live = false; };
  }, [src]);
  const hist = useMemo(() => { const m = new Map<string, number>(); for (const t of toks ?? []) m.set(t.type, (m.get(t.type) ?? 0) + 1); return [...m.entries()].sort((a, b) => b[1] - a[1]); }, [toks]);
  const rows = useMemo(() => (toks ?? []).filter(t => (type === 'all' || t.type === type) && (!q || String(t.value).includes(q))), [toks, type, q]);
  if (busy) return <Empty><span className="spin-loader" /></Empty>;
  if (!toks || !toks.length) return <Empty>No tokens.</Empty>;
  const text = rows.map(t => `${t.line}:${t.col}\t${t.type}\t${t.value}`).join('\n');
  return (
    <div className="col">
      <div className="toolbar">
        <select className="inp" value={type} onChange={e => setType(e.target.value)}><option value="all">all types ({toks.length.toLocaleString()})</option>{hist.map(([k, n]) => <option key={k} value={k}>{k} ({n.toLocaleString()})</option>)}</select>
        <input className="inp" placeholder="filter value…" value={q} onChange={e => setQ(e.target.value)} style={{ width: 160 }} />
        <div className="chips">{hist.slice(0, 6).map(([k, n]) => <span key={k} className="chip">{k} <b>{n.toLocaleString()}</b></span>)}</div>
        {errs.length > 0 && <span className="chip" style={{ color: 'var(--bad)' }} title={errs.slice(0, 10).map((e: any) => `L${e.line}: ${e.message}`).join('\n')}>lexer errors <b>{errs.length}</b></span>}
        <span className="spacer" />
        <Copy text={text} label={`Copy ${rows.length.toLocaleString()} tokens`} />
      </div>
      <div className="fill scroll">
        <table className="data">
          <thead><tr><th style={{ width: 80 }}>pos</th><th style={{ width: 110 }}>type</th><th>value</th></tr></thead>
          <tbody>{rows.slice(0, 5000).map((t, i) => (
            <tr key={i}>
              <td><LineLink line={t.line} onClick={l => reveal(l, t.col)} /><span className="muted">:{t.col}</span></td>
              <td style={{ color: 'var(--neon3)' }}>{t.type}</td>
              <td style={{ maxWidth: 520, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={String(t.value).slice(0, 1000)}>{t.value}</td>
            </tr>
          ))}</tbody>
        </table>
        {rows.length > 5000 && <div className="small muted" style={{ padding: 10 }}>Showing first 5000 of {rows.length.toLocaleString()}. Copy for the full stream.</div>}
      </div>
    </div>
  );
}
