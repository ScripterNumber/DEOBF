import React, { useEffect, useMemo, useRef, useState } from 'react';
import type { FullReport } from '@prism/core';
import { Copy, Empty, Seg, LineLink } from './ui.js';
import { forceLayout, GNode } from './force.js';
import { usePrism } from '../ctx.js';

export function CallGraph({ rep }: { rep: FullReport }) {
  const { reveal, send } = usePrism();
  const cg = rep.callGraph;
  const [sel, setSel] = useState<string | null>(null);
  const [view, setView] = useState<'graph' | 'table'>('graph');
  const [limit, setLimit] = useState(150);
  const [q, setQ] = useState('');
  const [tf, setTf] = useState({ x: 0, y: 0, k: 1 });
  const drag = useRef<{ x: number; y: number; tx: number; ty: number } | null>(null);
  const wrap = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 800, h: 500 });
  useEffect(() => {
    const el = wrap.current; if (!el) return;
    const ro = new ResizeObserver(() => setSize({ w: el.clientWidth || 800, h: el.clientHeight || 500 }));
    ro.observe(el); return () => ro.disconnect();
  }, [view]);

  const byId = useMemo(() => new Map(cg.functions.map(f => [f.id, f])), [cg]);
  const { nodes, edges } = useMemo(() => {
    const deg = new Map<string, number>();
    for (const e of cg.edges) { deg.set(e.from, (deg.get(e.from) ?? 0) + 1); deg.set(e.to, (deg.get(e.to) ?? 0) + 1); }
    const fns = cg.functions.slice().sort((a, b) => (deg.get(b.id) ?? 0) - (deg.get(a.id) ?? 0)).slice(0, limit);
    const keep = new Set(fns.map(f => f.id));
    const ns: GNode[] = fns.map((f, i) => ({ id: f.id, name: f.name, deg: deg.get(f.id) ?? 0,
      x: size.w / 2 + Math.cos(i * 2.4) * (40 + i * 2), y: size.h / 2 + Math.sin(i * 2.4) * (40 + i * 2), vx: 0, vy: 0 }));
    const es = cg.edges.filter(e => keep.has(e.from) && keep.has(e.to));
    forceLayout(ns, es, size.w, size.h);
    return { nodes: ns, edges: es };
  }, [cg, size.w, size.h, limit]);

  const pos = new Map(nodes.map(n => [n.id, n]));
  const selFn = sel ? byId.get(sel) : undefined;
  const nameOf = (id: string) => byId.get(id)?.name ?? id;
  const callers = useMemo(() => sel ? [...new Set(cg.edges.filter(e => e.to === sel).map(e => e.from))] : [], [cg, sel]);
  const callees = useMemo(() => sel ? [...new Set(cg.edges.filter(e => e.from === sel).map(e => e.to))] : [], [cg, sel]);
  const ql = q.toLowerCase();
  const match = (n: string) => !!ql && n.toLowerCase().includes(ql);
  const dot = 'digraph calls {\n  node [shape=box];\n' + cg.edges.map(e => '  "' + nameOf(e.from) + '" -> "' + nameOf(e.to) + '";').join('\n') + '\n}';
  const mermaid = 'graph LR\n' + cg.edges.map(e => `  ${e.from.replace(/\W/g, '_')}["${nameOf(e.from).replace(/"/g, "'")}"] --> ${e.to.replace(/\W/g, '_')}["${nameOf(e.to).replace(/"/g, "'")}"]`).join('\n');
  const tsv = cg.functions.map(f => `${f.id}\t${f.name}\t${f.line}\t${f.params.join(',')}\t${f.stmts}\t${f.calls.length}`).join('\n');

  if (!cg.functions.length) return <Empty>No functions found.</Empty>;
  const onWheel = (e: React.WheelEvent) => { const r = wrap.current!.getBoundingClientRect(); const mx = e.clientX - r.left, my = e.clientY - r.top; const k = Math.min(6, Math.max(0.2, tf.k * (e.deltaY < 0 ? 1.15 : 1 / 1.15))); setTf({ k, x: mx - (mx - tf.x) * (k / tf.k), y: my - (my - tf.y) * (k / tf.k) }); };
  return (
    <div className="col">
      <div className="toolbar">
        <Seg value={view} onChange={setView} options={[{ v: 'graph', label: 'graph' }, { v: 'table', label: 'functions' }]} />
        <input className="inp" placeholder="highlight function…" value={q} onChange={e => setQ(e.target.value)} style={{ width: 160 }} />
        {view === 'graph' && <select className="inp" value={limit} onChange={e => setLimit(Number(e.target.value))} title="nodes shown (by degree)">{[50, 150, 300, 600].map(n => <option key={n} value={n}>{n} nodes</option>)}</select>}
        {view === 'graph' && <span className="copy-btn" onClick={() => setTf({ x: 0, y: 0, k: 1 })}>reset view</span>}
        <span className="small muted">{cg.functionCount} functions · {cg.edgeCount} edges</span>
        <span className="spacer" />
        <Copy text={dot} label="Copy DOT" /><Copy text={mermaid} label="Copy Mermaid" /><Copy text={tsv} label="Copy TSV" />
        <Copy text={JSON.stringify({ functions: cg.functions, edges: cg.edges }, null, 2)} label="Copy JSON" />
      </div>
      {view === 'graph' ? (
        <div style={{ flex: 1, display: 'flex', minHeight: 0 }}>
          <div className="graph-wrap" ref={wrap} style={{ flex: 1, cursor: drag.current ? 'grabbing' : 'grab' }} onWheel={onWheel}
            onMouseDown={e => { drag.current = { x: e.clientX, y: e.clientY, tx: tf.x, ty: tf.y }; }}
            onMouseMove={e => { const d = drag.current; if (d) setTf({ ...tf, x: d.tx + e.clientX - d.x, y: d.ty + e.clientY - d.y }); }}
            onMouseUp={() => { drag.current = null; }} onMouseLeave={() => { drag.current = null; }}>
            <svg viewBox={`0 0 ${size.w} ${size.h}`}>
              <defs>
                <marker id="arr" viewBox="0 0 10 10" refX="16" refY="5" markerWidth="5" markerHeight="5" orient="auto"><path d="M0,0 L10,5 L0,10 z" fill="rgba(178,107,255,0.7)" /></marker>
                <radialGradient id="ng"><stop offset="0%" stopColor="#ff5ce1" /><stop offset="100%" stopColor="#b26bff" /></radialGradient>
                <filter id="glow"><feGaussianBlur stdDeviation="3" result="b" /><feMerge><feMergeNode in="b" /><feMergeNode in="SourceGraphic" /></feMerge></filter>
              </defs>
              <g transform={`translate(${tf.x},${tf.y}) scale(${tf.k})`}>
                {edges.map((e, i) => {
                  const a = pos.get(e.from), b = pos.get(e.to); if (!a || !b) return null;
                  const hot = sel && (e.from === sel || e.to === sel);
                  return <line key={i} x1={a.x} y1={a.y} x2={b.x} y2={b.y} stroke={hot ? (e.from === sel ? '#ff5ce1' : '#5ce1ff') : 'rgba(178,107,255,0.25)'} strokeWidth={(hot ? 1.8 : 1) / Math.sqrt(tf.k)} markerEnd="url(#arr)" />;
                })}
                {nodes.map(n => {
                  const m = match(n.name);
                  return (
                    <g key={n.id} className="graph-node" transform={`translate(${n.x},${n.y})`} onMouseDown={e => e.stopPropagation()} onClick={() => setSel(n.id === sel ? null : n.id)}>
                      <circle r={4 + Math.min(10, n.deg * 1.3)} fill={n.id === 'main' ? '#5ce1ff' : m ? '#ffcf5c' : 'url(#ng)'} stroke={n.id === sel ? '#fff' : 'none'} strokeWidth={2} filter={m || n.id === sel ? 'url(#glow)' : undefined} />
                      {(n.deg > 1 || n.id === sel || m || nodes.length < 40 || tf.k > 1.8) && <text x={9} y={4} fontSize={10 / Math.sqrt(tf.k)} fill={m ? '#ffcf5c' : '#d8ccff'} style={{ pointerEvents: 'none', fontFamily: 'var(--mono)' }}>{n.name.length > 26 ? n.name.slice(0, 24) + '…' : n.name}</text>}
                    </g>
                  );
                })}
              </g>
            </svg>
            <div className="small muted" style={{ position: 'absolute', left: 10, bottom: 8, pointerEvents: 'none' }}>wheel = zoom · drag = pan · click node = details · pink = calls, cyan = called by</div>
          </div>
          {selFn && (
            <div style={{ width: 280, borderLeft: '1px solid var(--stroke)', padding: 12, overflow: 'auto' }} className="fade">
              <div style={{ fontWeight: 700, color: '#fff', marginBottom: 6, wordBreak: 'break-all' }}>{selFn.name}</div>
              <div className="small muted"><LineLink line={selFn.line} onClick={l => reveal(l)} /> · {selFn.stmts} stmts · depth {selFn.depth}</div>
              <div className="small" style={{ margin: '6px 0' }}>params: <span className="mono">({selFn.params.join(', ')}{selFn.vararg ? (selFn.params.length ? ', ...' : '...') : ''})</span></div>
              <div className="row" style={{ margin: '8px 0' }}>
                <span className="copy-btn" onClick={() => send('python', { fn: String(selFn.line) })}>→ Python</span>
                {!/^</.test(selFn.name) && <span className="copy-btn" onClick={() => send('search', { mode: 'xrefs', name: selFn.name.split(/[.:]/).pop(), line: selFn.line })}>Xrefs</span>}
                <Copy text={JSON.stringify(selFn, null, 2)} label="Copy info" />
              </div>
              <div className="small muted" style={{ marginTop: 8 }}>called by ({callers.length}):</div>
              <div className="chips" style={{ marginTop: 4 }}>{callers.slice(0, 60).map(c => <span key={c} className="chip" style={{ fontSize: 10, cursor: 'pointer', color: 'var(--neon3)' }} onClick={() => setSel(c)}>{nameOf(c)}</span>)}</div>
              <div className="small muted" style={{ marginTop: 8 }}>calls functions ({callees.length}):</div>
              <div className="chips" style={{ marginTop: 4 }}>{callees.slice(0, 60).map(c => <span key={c} className="chip" style={{ fontSize: 10, cursor: 'pointer', color: 'var(--neon2)' }} onClick={() => setSel(c)}>{nameOf(c)}</span>)}</div>
              <div className="small muted" style={{ marginTop: 8 }}>all call expressions ({selFn.calls.length}):</div>
              <div className="chips" style={{ marginTop: 4 }}>{[...new Set(selFn.calls)].slice(0, 80).map((c, i) => <span key={i} className="chip" style={{ fontSize: 10 }}>{c}</span>)}</div>
            </div>
          )}
        </div>
      ) : (
        <div className="fill scroll">
          <table className="data">
            <thead><tr><th>id</th><th>name</th><th>line</th><th className="num">params</th><th className="num">stmts</th><th className="num">calls</th><th /></tr></thead>
            <tbody>{cg.functions.filter(f => !ql || f.name.toLowerCase().includes(ql)).slice(0, 5000).map(f => (
              <tr key={f.id} onClick={() => setSel(f.id)} style={{ cursor: 'pointer', background: f.id === sel ? 'rgba(178,107,255,0.12)' : undefined }}>
                <td>{f.id}</td>
                <td style={{ maxWidth: 260, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: '#fff' }} title={f.name}>{f.name}</td>
                <td><LineLink line={f.line} onClick={l => reveal(l)} /></td>
                <td className="num">{f.params.length + (f.vararg ? 1 : 0)}</td>
                <td className="num">{f.stmts}</td>
                <td className="num">{f.calls.length}</td>
                <td><span className="copy-btn" onClick={e => { e.stopPropagation(); send('python', { fn: String(f.line) }); }}>→ Py</span></td>
              </tr>
            ))}</tbody>
          </table>
        </div>
      )}
    </div>
  );
}
