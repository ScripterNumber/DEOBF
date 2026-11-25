// VM Map — static anatomy of how the script boots, runs and exits (payload → deserializer → wrapper → interpreter → exits → entry)
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import type { VmAnatomy, AnatomyPart, ChunkInfo } from '@prism/core';
import { usePrism } from '../ctx.js';
import { engine } from '../engineClient.js';
import { Card, Copy, Download, Empty, ErrorBox, Busy, LineLink, JsonView } from './ui.js';

interface Res { anatomy: VmAnatomy; text: string; }
type Stage = { key: string; title: string; hint: string; parts: AnatomyPart[]; sub?: AnatomyPart[]; py?: boolean; op?: boolean; blob?: boolean };
const KIND: Record<VmAnatomy['kind'], { label: string; cls: string }> = {
  vm: { label: 'bytecode VM', cls: 'ok' }, cff: { label: 'CFF state machine', cls: 'warn' }, plain: { label: 'no VM found', cls: '' },
};
const ROLE_HUE: Record<string, number> = { payload: 300, 'payload-consumer': 300, deserializer: 190, 'string-decoder': 160, wrapper: 265, interpreter: 280, 'dispatch-loop': 280, fetch: 230, 'pc-advance': 230, dispatch: 280, exit: 340, 'cff-exit': 340, 'cff-entry': 40, closure: 210, env: 50, varargs: 50, entry: 120 };
const roleChip = (r: string) => { const h = ROLE_HUE[r] ?? (r.length * 47) % 360; return <span className="chip role" style={{ borderColor: `hsla(${h},90%,70%,.45)`, color: `hsl(${h},95%,80%)` }}>{r}</span>; };
const lines = (p: { line: number; endLine?: number }) => 'L' + p.line + (p.endLine && p.endLine !== p.line ? '–' + p.endLine : '');

export function Anatomy() {
  const { text, target, reveal, send, goTab, toast, name } = usePrism();
  const [res, setRes] = useState<Res | null>(null);
  const [ms, setMs] = useState(0);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [q, setQ] = useState('');
  const [allChunks, setAllChunks] = useState(false);

  const go = useCallback(async () => {
    if (!text.trim()) return;
    setBusy(true); setErr(null);
    try { const r = await engine.op<Res>('anatomy', text, { maxChunks: 80 }); setRes(r.result); setMs(Math.round(r.ms)); }
    catch (e: any) { setErr(String(e?.message || e)); setRes(null); }
    finally { setBusy(false); }
  }, [text]);
  useEffect(() => { go(); }, [go]);

  const a = res?.anatomy;
  const stages: Stage[] = useMemo(() => {
    if (!a) return [];
    const by = (...r: string[]) => a.parts.filter(p => r.includes(p.role));
    return [
      { key: 'payload', title: 'Payload', hint: 'largest string literal and the call that consumes it', parts: by('payload'), sub: by('payload-consumer'), blob: true },
      { key: 'unpack', title: 'Deserializer', hint: 'turns the payload into the chunk (protos, constants, instructions) — port it to Python', parts: by('deserializer'), py: true },
      { key: 'decoders', title: 'String decoders', hint: 'constant / string decryptors', parts: by('string-decoder'), py: true },
      { key: 'wrap', title: 'Closure factory', hint: 'wraps a proto into a callable Lua closure', parts: by('wrapper') },
      { key: 'run', title: a.kind === 'cff' ? 'State machine' : 'Interpreter', hint: 'dispatch loop, instruction fetch, pc advance', parts: by('interpreter').length ? by('interpreter') : by('dispatch-loop'), sub: [...by('fetch', 'pc-advance', 'dispatch', 'varargs', 'cff-entry'), ...(by('interpreter').length ? by('dispatch-loop') : [])], op: true },
      { key: 'exit', title: 'Exits', hint: 'RETURN / TAILCALL handlers, CLOSURE creation', parts: by('exit', 'cff-exit'), sub: by('closure') },
      { key: 'entry', title: 'Entry', hint: 'the statement that starts the protected program', parts: by('entry'), sub: by('env') },
    ];
  }, [a]);

  const toBlob = useCallback(async (p: AnatomyPart) => {
    try { const { result } = await engine.op('literalBytes', text, { line: p.line, largest: true }); send('blob', { bytes: result, label: `payload L${p.line}` }); }
    catch (e: any) { toast(String(e?.message || e), 'bad'); }
  }, [text, send, toast]);

  if (!text.trim()) return <Empty><div><div className="big">No script yet</div>Paste or open a script on the left.</div></Empty>;
  const chunks = (a?.chunks ?? []).filter(c => !q || (c.name + ' ' + c.roles.join(' ') + ' ' + c.params + ' ' + (c.parent ?? '')).toLowerCase().includes(q.toLowerCase()));
  const shown = allChunks ? chunks : chunks.slice(0, 30);
  const maxSize = Math.max(1, ...(a?.chunks ?? []).map(c => c.size));
  const tsvParts = a ? 'role\tname\tline\tendLine\tdetail\tcode\n' + a.parts.map(p => [p.role, p.name ?? '', p.line, p.endLine ?? '', p.detail, p.code ?? ''].join('\t')).join('\n') : '';
  const tsvChunks = a ? 'name\tline\tendLine\tsize\tcallers\trefs\troles\tparent\tparams\n' + a.chunks.map((c: ChunkInfo) => [c.name, c.line, c.endLine, c.size, c.callers, c.refs, c.roles.join(','), c.parent ?? '', c.params].join('\t')).join('\n') : '';
  const json = a ? JSON.stringify(a, null, 2) : '';
  const k = a ? KIND[a.kind] : null;

  return (
    <div className="col">
      <Busy on={busy} label="Mapping the VM" />
      <div className="toolbar">
        {k && <span className={'pill ' + k.cls}>{k.label}</span>}
        <span className="small muted">static boot → run → exit map on {target} code{ms ? ` · ${ms}ms` : ''}</span>
        <span className="spacer" />
        {res && <><Copy text={res.text} label="Copy report" /><Copy text={json} label="Copy JSON" /><Download name={name.replace(/\.(lua|luau|txt)$/i, '') + '.anatomy.txt'} content={res.text} /></>}
        <button className="btn sm" onClick={go} disabled={busy}>Re-run</button>
      </div>
      <ErrorBox error={err} />
      <div className="fill scroll">
        {a && <div className="cards">
          <Card title="Boot chain" right={<Copy text={a.pipeline.join('\n')} label="Copy pipeline" />}>
            <div className="flow">
              {stages.map((st, i) => (
                <React.Fragment key={st.key}>
                  {i > 0 && <div className="flow-arrow">→</div>}
                  <div className={'flow-node' + (st.parts.length ? '' : ' missing')} title={st.hint}>
                    <div className="flow-t"><span>{st.title}</span>{st.parts.length > 1 && <span className="muted"> ×{st.parts.length}</span>}</div>
                    {st.parts.length === 0 && <div className="small muted">not found</div>}
                    {st.parts.slice(0, st.key === 'exit' ? 4 : 2).map((p, j) => (
                      <div key={j} className="flow-p">
                        {p.name && <b className="mono">{p.name} </b>}<LineLink line={p.line} onClick={l => reveal(l)} />{p.endLine && p.endLine !== p.line ? <span className="muted mono">–{p.endLine}</span> : null}
                        {st.key === 'exit' && <span className="muted small"> {p.detail.replace(/^.*handler op /, 'op ')}</span>}
                        {st.key !== 'exit' && <div className="small muted flow-d">{p.detail}</div>}
                      </div>
                    ))}
                    {st.key === 'exit' && st.parts.length > 4 && <div className="small muted">+{st.parts.length - 4} more</div>}
                    {st.sub && st.sub.length > 0 && <div className="flow-sub">{st.sub.slice(0, 5).map((p, j) => <div key={j} className="small" title={p.detail}>{roleChip(p.role)} <LineLink line={p.line} onClick={l => reveal(l)} /> <span className="mono muted">{(p.code ?? p.name ?? '').slice(0, 48)}</span></div>)}</div>}
                    <div className="flow-a">
                      {st.py && st.parts[0] && <span className="copy-btn" onClick={() => send('python', { fn: String(st.parts[0].line) })} title="port this function (+ deps) to Python; __main__ calls it at its call sites and dumps the result">→ Python</span>}
                      {st.blob && st.parts[0] && <span className="copy-btn" onClick={() => toBlob(st.parts[0])}>→ Blob Lab</span>}
                      {st.op && st.parts[0] && <span className="copy-btn" onClick={() => goTab('opcodes')}>→ Opcode Map</span>}
                      {st.parts[0] && <Copy text={[...st.parts, ...(st.sub ?? [])].map(p => `${p.role} ${p.name ?? ''} ${lines(p)}: ${p.detail}${p.code ? ' | ' + p.code : ''}`).join('\n')} label="Copy" />}
                    </div>
                  </div>
                </React.Fragment>
              ))}
            </div>
            {a.pipeline.length > 0 && <pre className="block" style={{ marginTop: 10 }}>{a.pipeline.join('\n')}</pre>}
          </Card>

          {a.tree && (
            <Card title={`Dispatch tree #${a.tree.id} · ${a.tree.kind}`} right={<span className="copy-btn" onClick={() => goTab('opcodes')}>Open Opcode Map →</span>}>
              <div className="chips">
                <span className="chip hi">var <b>{a.tree.var}</b></span>
                <span className="chip">handlers <b>{a.tree.handlers}</b></span>
                <span className="chip">ops <b>{a.tree.minOp}..{a.tree.maxOp}</b></span>
                <span className="chip line-chip" onClick={() => reveal(a.tree!.line)}>L<b>{a.tree.line}</b></span>
                {a.tree.roles.inst && <span className="chip">inst <b>{a.tree.roles.inst}</b></span>}
                {a.tree.roles.opField && <span className="chip">op field <b>{a.tree.roles.opField}</b></span>}
                {a.tree.roles.code && <span className="chip">code <b>{a.tree.roles.code}</b></span>}
                {a.tree.roles.pc && <span className="chip">pc <b>{a.tree.roles.pc}</b></span>}
                {a.tree.roles.stack && <span className="chip">stack <b>{a.tree.roles.stack}</b></span>}
                {Object.entries(a.tree.roles.fields ?? {}).slice(0, 10).map(([f, r]) => <span key={f} className="chip">{r} <b>{f}</b></span>)}
              </div>
            </Card>
          )}

          <Card title={`Parts (${a.parts.length})`} right={<Copy text={tsvParts} label="Copy TSV" />}>
            <div className="scroll" style={{ maxHeight: 420 }}>
              <table className="data">
                <thead><tr><th>role</th><th>name</th><th>lines</th><th>detail</th><th>code</th><th /></tr></thead>
                <tbody>{a.parts.map((p, i) => (
                  <tr key={i}>
                    <td>{roleChip(p.role)}</td>
                    <td style={{ color: 'var(--txt)' }}>{p.name ?? ''}</td>
                    <td><LineLink line={p.line} onClick={l => reveal(l)} />{p.endLine && p.endLine !== p.line ? <span className="muted">–{p.endLine}</span> : null}</td>
                    <td className="wrap" style={{ maxWidth: 420 }}>{p.detail}</td>
                    <td className="wrap" style={{ maxWidth: 300, color: 'var(--neon3)' }} title={p.code}>{p.code}</td>
                    <td style={{ whiteSpace: 'nowrap' }}>{/deserializer|string-decoder|payload-consumer|wrapper/.test(p.role) && <span className="copy-btn" onClick={() => send('python', { fn: String(p.role === 'payload-consumer' ? p.line : p.line) })}>→ Py</span>} <Copy text={`${p.role} ${p.name ?? ''} ${lines(p)}: ${p.detail}${p.code ? ' | ' + p.code : ''}`} label="copy" /></td>
                  </tr>
                ))}</tbody>
              </table>
            </div>
          </Card>

          <Card title={`Main chunks (${a.chunks.length} largest functions)`} right={<><input className="inp" placeholder="filter name / role…" value={q} onChange={e => setQ(e.target.value)} style={{ width: 160, padding: '3px 8px' }} /><Copy text={tsvChunks} label="Copy TSV" /></>}>
            <div className="small muted" style={{ marginBottom: 6 }}>size = AST nodes (nested functions included) · calls = resolved call sites · refs = name references · roles from the anatomy + constant finder</div>
            <div className="scroll" style={{ maxHeight: 460 }}>
              <table className="data">
                <thead><tr><th>name</th><th>lines</th><th>size</th><th>calls</th><th>refs</th><th>roles</th><th>parent</th><th>params</th><th /></tr></thead>
                <tbody>{shown.map(c => (
                  <tr key={c.id}>
                    <td style={{ color: 'var(--txt)' }}>{c.name}</td>
                    <td><LineLink line={c.line} onClick={l => reveal(l)} /><span className="muted">–{c.endLine}</span></td>
                    <td className="num" style={{ minWidth: 90 }}><div className="bar" title={String(c.size)} style={{ display: 'inline-block', width: 44, verticalAlign: 'middle', marginRight: 6 }}><i style={{ width: `${Math.max(3, (c.size / maxSize) * 100)}%` }} /></div>{c.size}</td>
                    <td className="num">{c.callers}</td>
                    <td className="num">{c.refs}</td>
                    <td><div className="chips" style={{ flexWrap: 'nowrap' }}>{c.roles.map(r => <React.Fragment key={r}>{roleChip(r)}</React.Fragment>)}</div></td>
                    <td className="muted">{c.parent ?? ''}</td>
                    <td className="muted" style={{ maxWidth: 180, overflow: 'hidden', textOverflow: 'ellipsis' }} title={c.params}>{c.params}</td>
                    <td><span className="copy-btn" onClick={() => send('python', { fn: String(c.line) })}>→ Py</span></td>
                  </tr>
                ))}</tbody>
              </table>
            </div>
            {chunks.length > 30 && <div style={{ marginTop: 6 }}><span className="copy-btn" onClick={() => setAllChunks(v => !v)}>{allChunks ? 'show top 30' : `show all ${chunks.length}`}</span></div>}
          </Card>

          {a.notes.length > 0 && <Card title="Notes">{a.notes.map((n, i) => <div key={i} className="small" style={{ color: 'var(--neon3)', marginBottom: 3 }}>▸ {n}</div>)}</Card>}
          <Card title="Full report" right={<Copy text={res!.text} />}><JsonView value={a} label="anatomy JSON" /><pre className="block" style={{ marginTop: 8, maxHeight: 360, overflow: 'auto' }}>{res!.text}</pre></Card>
        </div>}
        {!a && !busy && !err && <Empty><div><div className="big">VM Map</div>Static boot → run → exit map: payload, deserializer, closure factory, interpreter, exits, entry and the main chunks.</div></Empty>}
      </div>
    </div>
  );
}
