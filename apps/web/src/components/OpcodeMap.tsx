import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { OpcodeReport, DispatchTree, HandlerInfo } from '@prism/core';
import { usePrism } from '../ctx.js';
import { engine } from '../engineClient.js';
import { api } from '../api.js';
import { Copy, Download, Empty, ErrorBox, Busy, Toggle, LineLink, useLocal, download } from './ui.js';

type Edit = { name?: string; lua?: string; notes?: string };
type Edits = Record<string, Edit>; // key = handler index
interface OpData { report: OpcodeReport; opmaps: Array<Record<string, { name: string; lua?: string }>>; texts: string[]; }

const hue = (s: string) => { let h = 0; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0; return h % 360; };
const hash = (s: string) => { let h = 2166136261; for (let i = 0; i < s.length; i += Math.max(1, s.length >> 15)) h = Math.imul(h ^ s.charCodeAt(i), 16777619); return (h >>> 0).toString(36) + s.length.toString(36); };

function exportMap(t: DispatchTree, edits: Edits): Record<string, { name: string; lua?: string; notes?: string; conf?: number; shape?: string; line?: number }> {
  const out: Record<string, { name: string; lua?: string; notes?: string; conf?: number; shape?: string; line?: number }> = {};
  for (const h of t.handlers) {
    const e = edits[h.index] ?? {};
    const lua = e.lua ?? h.lifted.split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('--')).join(' ').slice(0, 240);
    for (const op of h.opcodes) out[String(op)] = { name: e.name || h.guess || `OP_${op}`, ...(lua ? { lua } : {}), ...(e.notes ? { notes: e.notes } : {}), conf: e.name ? 1 : h.confidence, shape: h.shape, line: h.line };
  }
  return out;
}
const asText = (t: DispatchTree, edits: Edits) => t.handlers.map(h => `[${h.rangeText}]`.padEnd(22) + ' ' + (edits[h.index]?.name || h.guess || '?').padEnd(18) + ` conf=${edits[h.index]?.name ? 'user' : h.confidence}  L${h.line}  shape=${h.shape}`).join('\n');
const asLua = (m: ReturnType<typeof exportMap>) => 'local OPCODES = {\n' + Object.entries(m).sort((a, b) => Number(a[0]) - Number(b[0])).map(([k, v]) => `  [${k}] = ${JSON.stringify(v.name)},${v.lua ? ' -- ' + v.lua.replace(/\n/g, ' ').slice(0, 120) : ''}`).join('\n') + '\n}';
const asPy = (m: ReturnType<typeof exportMap>) => 'OPCODES = {\n' + Object.entries(m).sort((a, b) => Number(a[0]) - Number(b[0])).map(([k, v]) => `    ${k}: ${JSON.stringify(v.name)},`).join('\n') + '\n}';

export function OpcodeMap() {
  const { text, target, reveal, backend, toast, send, name } = usePrism();
  const [data, setData] = useState<OpData | null>(null);
  const [forHash, setForHash] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [sel, setSel] = useState(0);
  const [q, setQ] = useState('');
  const [lowOnly, setLowOnly] = useState(false);
  const [byShape, setByShape] = useState(false);
  const [open, setOpen] = useState<number | null>(null);
  const [maxTrees, setMaxTrees] = useLocal('opmap:maxTrees', 8);
  const h = useMemo(() => hash(text), [text]);
  const [allEdits, setAllEdits] = useLocal<Record<string, Edits>>('opmap:edits', {});
  const [wsName, setWsName] = useState(name.replace(/\.(lua|luau|txt)$/i, ''));
  const [wsList, setWsList] = useState<string[]>([]);
  const fileRef = useRef<HTMLInputElement>(null);

  const runMap = useCallback(async () => {
    setBusy(true); setErr(null);
    try { const { result } = await engine.op<OpData>('opcodes', text, { maxTrees }); setData(result); setForHash(h); setSel(0); setOpen(null); }
    catch (e: any) { setErr(e.message); } finally { setBusy(false); }
  }, [text, h, maxTrees]);
  useEffect(() => { if (forHash !== h) runMap(); }, [h]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (backend) api.opmaps().then(setWsList).catch(() => {}); }, [backend]);

  const tree = data?.report.trees[sel];
  const ekey = `${h}:${tree?.id ?? 0}`;
  const edits: Edits = allEdits[ekey] ?? {};
  const setEdit = (idx: number, patch: Edit) => setAllEdits(a => ({ ...a, [ekey]: { ...(a[ekey] ?? {}), [idx]: { ...((a[ekey] ?? {})[idx] ?? {}), ...patch } } }));
  const shapeCount = useMemo(() => { const m = new Map<string, number>(); tree?.handlers.forEach(x => m.set(x.shape, (m.get(x.shape) ?? 0) + 1)); return m; }, [tree]);

  const rows = useMemo(() => {
    if (!tree) return [] as HandlerInfo[];
    const ql = q.toLowerCase();
    let r = tree.handlers.filter(x => (!lowOnly || (x.confidence < 0.6 && !edits[x.index]?.name)) && (!ql || (edits[x.index]?.name ?? x.guess).toLowerCase().includes(ql) || x.rangeText.includes(ql) || x.lifted.toLowerCase().includes(ql) || x.shape.includes(ql)));
    if (byShape) r = [...r].sort((a, b) => a.shape.localeCompare(b.shape) || a.opcodes[0] - b.opcodes[0]);
    return r;
  }, [tree, q, lowOnly, byShape, edits]);

  if (!data && busy) return <Empty><div><span className="spin-loader" style={{ display: 'inline-block' }} /><div className="big" style={{ marginTop: 8 }}>Mapping dispatch trees…</div></div></Empty>;
  if (err) return <ErrorBox error={err} />;
  if (!data) return null;
  if (!data.report.trees.length) return <Empty><div><div className="big">No dispatch tree found in the {target} code</div>{data.report.notes.join(' · ') || 'Not a VM / CFF script, or the dispatcher is hidden behind another layer — try the other target, or Deobfuscate first.'}<div style={{ marginTop: 10 }}><button className="btn sm" onClick={runMap}>Re-scan</button></div></div></Empty>;

  const map = tree ? exportMap(tree, edits) : {};
  const nEdited = Object.values(edits).filter(e => e.name).length;
  const applyShape = (hh: HandlerInfo) => { const nm = edits[hh.index]?.name; if (!nm || !tree) return; let n = 0; for (const x of tree.handlers) if (x.shape === hh.shape && x.index !== hh.index && !edits[x.index]?.name) { setEdit(x.index, { name: nm }); n++; } toast(`applied "${nm}" to ${n} same-shape handlers`, 'ok'); };
  const importJson = (txt: string) => {
    try {
      const j = JSON.parse(txt) as Record<string, string | { name: string; lua?: string; notes?: string }>;
      const next: Edits = { ...edits }; let n = 0;
      for (const hh of tree!.handlers) for (const op of hh.opcodes) { const e = j[String(op)]; if (e) { next[hh.index] = typeof e === 'string' ? { name: e } : { name: e.name, ...(e.notes ? { notes: e.notes } : {}) }; n++; break; } }
      setAllEdits(a => ({ ...a, [ekey]: next })); toast(`imported ${n} opcode names`, n ? 'ok' : 'bad');
    } catch (e: any) { toast('import failed: ' + e.message, 'bad'); }
  };
  const saveWs = async () => { try { const r = await api.putOpmap(wsName || 'opmap', map as any); toast('saved ' + r.file, 'ok'); setWsList(await api.opmaps()); } catch (e: any) { toast(e.message, 'bad'); } };
  const loadWs = async (n: string) => { try { importJson(JSON.stringify(await api.getOpmap(n))); } catch (e: any) { toast(e.message, 'bad'); } };

  return (
    <div className="col">
      <Busy on={busy} label="Mapping" />
      <div className="toolbar">
        <select className="inp" value={sel} onChange={e => { setSel(Number(e.target.value)); setOpen(null); }} style={{ maxWidth: 360 }}>
          {data.report.trees.map((t, i) => <option key={i} value={i}>#{t.id} {t.kind} var={t.var} · {t.leaves} handlers · L{t.line} · score {Math.round(t.score)}</option>)}
        </select>
        <input className="inp" placeholder="filter name / opcode / code / shape…" value={q} onChange={e => setQ(e.target.value)} style={{ flex: 1, minWidth: 140 }} />
        <Toggle on={lowOnly} onChange={setLowOnly} title="only unnamed handlers with confidence < 0.6">low conf</Toggle>
        <Toggle on={byShape} onChange={setByShape} title="sort by CFG shape hash: equal hash ⇒ same semantics">group shape</Toggle>
        <span className="copy-btn" onClick={runMap} title="re-run the opcode mapper">↻</span>
        <select className="inp" value={maxTrees} onChange={e => setMaxTrees(Number(e.target.value))} title="max dispatch trees to extract"><option value={4}>4 trees</option><option value={8}>8 trees</option><option value={16}>16 trees</option><option value={32}>32 trees</option></select>
      </div>
      {tree && (
        <div className="toolbar" style={{ paddingTop: 6, paddingBottom: 6 }}>
          <div className="chips">
            <span className="chip hi">{tree.kind}</span>
            <span className="chip">range <b>{tree.minOp}..{tree.maxOp}</b></span>
            <span className="chip">handlers <b>{tree.leaves}</b></span>
            <span className="chip">shapes <b>{shapeCount.size}</b></span>
            <span className="chip">named <b>{nEdited}</b></span>
            {Object.entries({ inst: tree.roles.inst, code: tree.roles.code, pc: tree.roles.pc, stack: tree.roles.stack, opField: tree.roles.opField }).filter(([, v]) => v).map(([k, v]) => <span key={k} className="chip">{k} <b>{v}</b></span>)}
            {Object.entries(tree.roles.fields).map(([k, v]) => <span key={k} className="chip">{k}→<b>{v}</b></span>)}
          </div>
          <span className="spacer" />
          <Copy text={asText(tree, edits)} label="Copy table" />
          <Copy text={JSON.stringify(map, null, 2)} label="Copy JSON" />
          <Copy text={asLua(map)} label="Copy Lua" />
          <Copy text={asPy(map)} label="Copy Python" />
          <Copy text={data.texts[sel] ?? ''} label="Copy full dump" />
          <span className="copy-btn" onClick={() => download(`${wsName || 'opmap'}.json`, JSON.stringify(map, null, 2), 'application/json')}>Export</span>
          <span className="copy-btn" onClick={() => fileRef.current?.click()}>Import</span>
          <input ref={fileRef} type="file" accept=".json" style={{ display: 'none' }} onChange={async e => { const f = e.target.files?.[0]; if (f) importJson(await f.text()); e.target.value = ''; }} />
          <span className="copy-btn" onClick={() => send('vm', { opmap: map, roles: tree.roles })} title="open the custom-VM disassembler with this map">→ VM disasm</span>
          {nEdited > 0 && <span className="copy-btn" onClick={() => { if (confirm('Discard all opcode names you entered for this tree?')) setAllEdits(a => { const n = { ...a }; delete n[ekey]; return n; }); }}>Reset</span>}
        </div>
      )}
      {backend && tree && (
        <div className="toolbar" style={{ paddingTop: 4, paddingBottom: 6 }}>
          <span className="small muted">workspace opmap</span>
          <input className="inp" style={{ width: 150 }} value={wsName} onChange={e => setWsName(e.target.value)} />
          <button className="btn sm" onClick={saveWs}>Save</button>
          {wsList.length > 0 && <select className="inp" value="" onChange={e => e.target.value && loadWs(e.target.value)}><option value="">Load…</option>{wsList.map(n => <option key={n} value={n}>{n}</option>)}</select>}
          <span className="small muted">shared with MCP tools opmap_get / vm_disasm</span>
        </div>
      )}
      <div className="fill scroll">
        <table className="data">
          <thead><tr><th style={{ width: 120 }}>opcode</th><th style={{ width: 190 }}>mnemonic (editable)</th><th style={{ width: 60 }}>conf</th><th style={{ width: 110 }}>shape</th><th style={{ width: 54 }}>line</th><th>lifted semantics</th></tr></thead>
          <tbody>
            {rows.slice(0, 1500).map(x => {
              const e = edits[x.index] ?? {};
              const hu = hue(x.shape);
              const same = shapeCount.get(x.shape) ?? 1;
              const liftedOne = x.lifted.split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('--')).join('  ');
              return (
                <React.Fragment key={x.index}>
                  <tr onClick={() => setOpen(open === x.index ? null : x.index)} style={{ cursor: 'pointer' }}>
                    <td style={{ color: 'var(--neon3)' }}>{x.rangeText}</td>
                    <td onClick={ev => ev.stopPropagation()}><input className={'op-name ' + (e.name ? 'edited' : '')} value={e.name ?? ''} placeholder={x.guess || '?'} onChange={ev => setEdit(x.index, { name: ev.target.value })} /></td>
                    <td><span className="conf" title={String(x.confidence)}><i style={{ width: `${Math.round((e.name ? 1 : x.confidence) * 100)}%` }} /></span></td>
                    <td title={`${same} handler(s) share this shape`}><span className="shape-dot" style={{ color: `hsl(${hu} 90% 65%)`, background: `hsl(${hu} 90% 65%)` }} />{x.shape.slice(0, 8)}{same > 1 && <span className="muted"> ×{same}</span>}</td>
                    <td><LineLink line={x.line} onClick={l => reveal(l)} /></td>
                    <td style={{ maxWidth: 420, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={liftedOne}>{liftedOne || <span className="muted">∅</span>}</td>
                  </tr>
                  {open === x.index && (
                    <tr><td colSpan={6} style={{ background: 'rgba(10,6,22,0.55)' }}>
                      <div className="row" style={{ marginBottom: 4 }}>
                        <span className="small muted">opcodes {x.opcodes.slice(0, 20).join(', ')}{x.opcodes.length > 20 ? '…' : ''} · {x.stmts} stmts{x.successors ? ' · → ' + x.successors.join(', ') : ''}</span>
                        <span className="spacer" />
                        {e.name && same > 1 && <span className="copy-btn" onClick={() => applyShape(x)}>Apply “{e.name}” to {same - 1} same-shape</span>}
                        <Copy text={x.lifted} label="Copy lifted" /><Copy text={x.code} label="Copy code" />
                      </div>
                      {x.lifted && <div className="code-peek">{x.lifted}</div>}
                      <div className="code-peek">{x.code}</div>
                      <input className="inp" style={{ width: '100%' }} placeholder="notes (exported with the map)" value={e.notes ?? ''} onChange={ev => setEdit(x.index, { notes: ev.target.value })} />
                    </td></tr>
                  )}
                </React.Fragment>
              );
            })}
          </tbody>
        </table>
        {rows.length > 1500 && <div className="small muted" style={{ padding: 10 }}>showing 1500 of {rows.length} — use the filter or Copy for everything</div>}
        {data.report.notes.length > 0 && <div className="small muted" style={{ padding: 10 }}>{data.report.notes.map((n, i) => <div key={i}>▸ {n}</div>)}</div>}
      </div>
    </div>
  );
}
