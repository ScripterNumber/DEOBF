import React from 'react';
import type { FullReport } from '@prism/core';
import { Card, Copy, Empty, LineLink } from './ui.js';
import { usePrism } from '../ctx.js';

function Histo({ h }: { h: Array<{ byte: number; count: number }> }) {
  const max = Math.max(1, ...h.map(x => x.count));
  return (
    <div style={{ display: 'flex', alignItems: 'flex-end', gap: 2, height: 90, padding: '6px 0' }}>
      {h.slice(0, 40).map((x, i) => (
        <div key={i} title={`byte 0x${x.byte.toString(16).padStart(2, '0')} (${x.byte}) × ${x.count}`}
          style={{ flex: 1, height: `${Math.max(3, (x.count / max) * 100)}%`,
            background: 'linear-gradient(180deg, #5ce1ff, #b26bff)', borderRadius: 2, minWidth: 3 }} />
      ))}
    </div>
  );
}

export function VmAnalysis({ rep }: { rep: FullReport }) {
  const { reveal, goTab } = usePrism();
  const vm = rep.vm;
  if (!vm.isVM && !vm.blobs.length) return <Empty><div><div className="big">No VM / bytecode structure detected</div>This looks like a non-virtualized obfuscation (string/constant/flow only).</div></Empty>;
  const full = JSON.stringify(vm, null, 2);
  return (
    <div className="cards">
      <Card title="Dispatch & control flow" right={<><span className="copy-btn" onClick={() => goTab('anatomy')}>VM Map →</span><span className="copy-btn" onClick={() => goTab('opcodes')}>Open Opcode Map →</span><Copy text={full} label="Copy VM report" /></>}>
        {vm.dispatchSummary.length ? (
          <div className="chips" style={{ marginBottom: 8 }}>
            {vm.dispatchSummary.map((d, i) => <span key={i} className="chip hi">{d.kind} <b>×{d.count}</b> <span className="muted">@L{d.firstLine}</span></span>)}
          </div>
        ) : <div className="muted small">No explicit dispatch loop; may be inlined/linear.</div>}
        {vm.dispatch.filter(d => d.kind === 'cff-state-machine').slice(0, 8).map((d, i) => (
          <div key={i} className="small mono" style={{ marginTop: 4 }}>• CFF <LineLink line={d.line} onClick={l => reveal(l)} />: {d.detail} {d.cases ? `(${d.cases} cases)` : ''}</div>
        ))}
        {vm.trampolines.length > 0 && <div className="small" style={{ marginTop: 8 }}>Trampolines: {vm.trampolines.length} (e.g. @L{vm.trampolines[0].line} — {vm.trampolines[0].detail})</div>}
        {vm.notes.map((n, i) => <div key={i} className="small" style={{ marginTop: 4, color: 'var(--neon3)' }}>▸ {n}</div>)}
      </Card>

      {vm.blobs.length > 0 && (
        <Card title={`Bytecode / data blobs (${vm.blobs.length})`}>
          {vm.opcodeEstimate != null && (
            <div className="small" style={{ marginBottom: 8 }}>
              Opcode-count upper bound (distinct byte values in dominant blob): <b style={{ color: 'var(--neon3)' }}>~{vm.opcodeEstimate}</b>
            </div>
          )}
          {vm.blobs.slice(0, 4).map((b, i) => (
            <div key={i} style={{ marginBottom: 12, paddingBottom: 10, borderBottom: '1px solid rgba(150,100,240,0.12)' }}>
              <div className="small mono" style={{ marginBottom: 2 }}>
                [{b.kind}] <LineLink line={b.line} onClick={l => reveal(l)} /> · {b.length.toLocaleString()} units · {b.distinctBytes} distinct bytes
              </div>
              {b.histogram && <Histo h={b.histogram} />}
              <div className="small muted mono" style={{ marginTop: 2 }}>preview: {b.preview}</div>
            </div>
          ))}
          <div className="small muted">Histogram shows the 40 most frequent byte values. A narrow set with 1-2 dominant values usually means NOP/MOVE/RETURN opcodes; wide spread means encryption at rest.</div>
        </Card>
      )}

      <Card title={`Handler clusters (${vm.handlerClusters.length})`} right={<Copy text={JSON.stringify(vm.handlerClusters, null, 2)} label="Copy clusters" />}>
        <div className="small muted" style={{ marginBottom: 8 }}>
          Functions grouped by control-flow-shape hash. Same hash ⇒ same semantic family — read one representative per cluster instead of every handler.
        </div>
        <table className="data">
          <thead><tr><th>shape hash</th><th>members</th><th>rep. line</th><th>skeleton</th></tr></thead>
          <tbody>{vm.handlerClusters.slice(0, 30).map((c, i) => (
            <tr key={i}>
              <td style={{ color: 'var(--neon3)' }}>{c.shapeHash}</td>
              <td className="num">{c.members.length}</td>
              <td><LineLink line={c.representativeLine} onClick={l => reveal(l)} /></td>
              <td style={{ maxWidth: 260, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={c.sketch}>{c.sketch || '∅'}</td>
            </tr>
          ))}</tbody>
        </table>
      </Card>
    </div>
  );
}
