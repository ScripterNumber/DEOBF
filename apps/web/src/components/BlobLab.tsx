import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { BLOB_OPS, asPythonBytes, asLuaString, asCArray, asLuaTable, b64encode, hexencode } from '../../../../packages/core/src/blob/blob.js';
import { usePrism, useInbox } from '../ctx.js';
import { engine } from '../engineClient.js';
import { api } from '../api.js';
import { Copy, Empty, ErrorBox, Seg, Field, useLocal, download, bytesLatin1 } from './ui.js';

type Step = { op: string; arg?: string };
type Info = { length: number; entropy: number; printable: number; magic: string[]; hexdump: string };
const ZOPS: Record<string, string> = { inflate: 'zlib inflate (DecompressionStream)', gunzip: 'gzip decompress', 'inflate-raw': 'raw deflate decompress' };
const ALL_OPS: Array<[string, string, string | undefined]> = [...Object.entries(BLOB_OPS).map(([k, v]) => [k, v.label, v.arg] as [string, string, string | undefined]), ...Object.entries(ZOPS).map(([k, v]) => [k, v, undefined] as [string, string, undefined])];
type View = 'hexdump' | 'text' | 'utf8' | 'python' | 'lua' | 'c' | 'table' | 'base64' | 'hex';

export function BlobLab() {
  const { text, send, backend, toast, reveal } = usePrism();
  const [raw, setRaw] = useLocal('blob:raw', '');
  const [enc, setEnc] = useLocal('blob:enc', 'auto');
  const [bin, setBin] = useState<{ bytes: Uint8Array; label: string } | null>(null);
  const [steps, setSteps] = useLocal<Step[]>('blob:steps', []);
  const [view, setView] = useLocal<View>('blob:view', 'hexdump');
  const [input, setInput] = useState<Uint8Array | null>(null);
  const [res, setRes] = useState<{ out: Uint8Array; trace: Array<{ op: string; len: number; error?: string }>; info: Info } | null>(null);
  const [auto, setAuto] = useState<any[] | null>(null);
  const [xor, setXor] = useState<any>(null);
  const [plain, setPlain] = useState(''); const [plainOff, setPlainOff] = useState(0);
  const [err, setErr] = useState<string | null>(null);
  const [lit, setLit] = useState('');

  useInbox('blob', useCallback((p: { bytes: Uint8Array; label: string }) => { setBin(p); setAuto(null); setXor(null); }, []));

  // resolve the input bytes
  useEffect(() => {
    let live = true; setErr(null);
    if (bin) { setInput(bin.bytes); return; }
    if (!raw.trim()) { setInput(null); return; }
    engine.op<Uint8Array>('parseBytes', '', { data: raw, encoding: enc }).then(r => live && setInput(r.result)).catch(e => live && setErr(e.message));
    return () => { live = false; };
  }, [raw, enc, bin]);
  // run the pipeline
  useEffect(() => {
    let live = true;
    if (!input) { setRes(null); return; }
    engine.op('blob', '', { bytes: input, steps }).then(r => live && setRes(r.result)).catch(e => live && setErr(e.message));
    return () => { live = false; };
  }, [input, steps]);

  const out = res?.out;
  const rendered = useMemo(() => {
    if (!out || !res) return '';
    const cap = out.length > 2_000_000 ? out.subarray(0, 2_000_000) : out;
    switch (view) {
      case 'hexdump': return res.info.hexdump + (out.length > 8192 ? `\n… ${out.length - 8192} more bytes (Copy/Download in another format for everything)` : '');
      case 'text': return bytesLatin1(cap);
      case 'utf8': return new TextDecoder().decode(cap);
      case 'python': return asPythonBytes(cap);
      case 'lua': return asLuaString(cap);
      case 'c': return asCArray(cap);
      case 'table': return asLuaTable(cap);
      case 'base64': return b64encode(cap);
      case 'hex': return hexencode(cap);
    }
  }, [out, res, view]);
  const fullFor = (v: View) => { if (!out) return ''; switch (v) { case 'hexdump': return res!.info.hexdump; case 'text': return bytesLatin1(out); case 'utf8': return new TextDecoder().decode(out); case 'python': return asPythonBytes(out); case 'lua': return asLuaString(out); case 'c': return asCArray(out); case 'table': return asLuaTable(out); case 'base64': return b64encode(out); case 'hex': return hexencode(out); } };

  const runAuto = async () => { if (!input) return; try { setAuto((await engine.op('blobAutoZ', '', { bytes: input })).result); } catch (e: any) { setErr(e.message); } };
  const runXor = async () => { const b = out ?? input; if (!b) return; try { setXor((await engine.op('xor', '', { bytes: b, plain: plain || undefined, offset: plainOff })).result); } catch (e: any) { setErr(e.message); } };
  const fromLiteral = async () => { const [l, i] = lit.split(/[:#]/).map(Number); if (!l) return; try { const { result } = await engine.op<Uint8Array>('literalBytes', text, { line: l, index: (i || 1) - 1 }); setBin({ bytes: result, label: `string literal L${l}${i ? '#' + i : ''}` }); } catch (e: any) { setErr(e.message); } };
  const isBc = !!res?.info.magic.some(m => /bytecode/i.test(m));
  const saveWs = async () => { if (!out) return; const n = prompt('workspace output name', 'blob.bin'); if (!n) return; try { const r = await api.saveOutput(n, out); toast('saved ' + r.file, 'ok'); } catch (e: any) { toast(e.message, 'bad'); } };
  const recipe = JSON.stringify(steps);

  return (
    <div className="split" style={{ gridTemplateColumns: 'minmax(300px, 38%) 1fr' }}>
      <div className="scroll" style={{ padding: 10 }}>
        <div className="sec-title">input</div>
        {bin ? (
          <div className="step"><span className="n">bytes</span><span className="mono">{bin.label}</span><span className="muted">{bin.bytes.length} B</span><span className="spacer" /><span className="copy-btn" onClick={() => setBin(null)}>use text input</span></div>
        ) : <>
          <textarea className="inp" rows={6} value={raw} onChange={e => setRaw(e.target.value)} placeholder={'paste a blob: base64 / hex / "\\27\\76…" / {1,2,3} / raw text'} spellCheck={false} />
          <div className="row" style={{ marginTop: 6 }}>
            <Field label="as"><select value={enc} onChange={e => setEnc(e.target.value)}>{['auto', 'latin1', 'utf8', 'lua', 'hex', 'base64', 'decimal'].map(x => <option key={x}>{x}</option>)}</select></Field>
            <input type="file" style={{ fontSize: 11, color: 'var(--txt-dim)', maxWidth: 190 }} onChange={async e => { const f = e.target.files?.[0]; if (f) setBin({ bytes: new Uint8Array(await f.arrayBuffer()), label: f.name }); e.target.value = ''; }} />
          </div>
        </>}
        <div className="row" style={{ marginTop: 6 }}>
          <Field label="string literal at line" hint="line[:n] — n-th literal on that line (current target code)"><input value={lit} onChange={e => setLit(e.target.value)} onKeyDown={e => e.key === 'Enter' && fromLiteral()} placeholder="123 or 123:2" style={{ width: 100 }} /></Field>
          <button className="btn sm" onClick={fromLiteral} disabled={!lit}>Load</button>
        </div>

        <div className="row" style={{ marginTop: 14 }}><span className="sec-title" style={{ margin: 0 }}>pipeline</span><span className="spacer" /><Copy text={recipe} label="Copy recipe" /><span className="copy-btn" onClick={() => { const r = prompt('paste a recipe (JSON array of {op,arg})', recipe); if (r) { try { setSteps(JSON.parse(r)); } catch { toast('invalid recipe', 'bad'); } } }}>Paste recipe</span>{steps.length > 0 && <span className="copy-btn" onClick={() => setSteps([])}>Clear</span>}</div>
        <div className="col" style={{ gap: 6, height: 'auto' }}>
          {steps.map((s, i) => {
            const meta = ALL_OPS.find(o => o[0] === s.op); const tr = res?.trace[i];
            return (
              <div key={i} className={'step ' + (tr?.error ? 'err' : '')}>
                <span className="n">{i + 1}</span>
                <select className="inp" value={s.op} onChange={e => setSteps(steps.map((x, j) => j === i ? { op: e.target.value } : x))} style={{ maxWidth: 140 }}>{ALL_OPS.map(([k]) => <option key={k}>{k}</option>)}</select>
                {meta?.[2] && <input className="inp" style={{ flex: 1, minWidth: 60 }} placeholder={meta[2]} value={s.arg ?? ''} onChange={e => setSteps(steps.map((x, j) => j === i ? { ...x, arg: e.target.value } : x))} />}
                <span className="spacer" />
                <span className="small muted" title={tr?.error}>{tr ? (tr.error ? '✗ ' + tr.error.slice(0, 40) : tr.len + ' B') : ''}</span>
                <span className="x-btn" onClick={() => setSteps(steps.filter((_, j) => j !== i))} title="remove">×</span>
              </div>
            );
          })}
          <select className="inp" value="" onChange={e => { if (e.target.value) setSteps([...steps, { op: e.target.value }]); }}>
            <option value="">+ add step…</option>{ALL_OPS.map(([k, l]) => <option key={k} value={k}>{k} — {l}</option>)}
          </select>
        </div>

        <div className="row" style={{ marginTop: 14 }}><span className="sec-title" style={{ margin: 0 }}>auto-decode</span><span className="spacer" /><button className="btn sm" onClick={runAuto} disabled={!input}>Try encodings</button></div>
        {auto && (auto.length === 0 ? <div className="small muted">nothing decoded cleanly</div> : <div className="list" style={{ border: '1px solid var(--stroke)', borderRadius: 9, marginTop: 6 }}>
          {auto.slice(0, 12).map((a, i) => <div key={i} className="li" onClick={() => setSteps(a.steps)} title="apply this pipeline">
            <span className="mono" style={{ color: 'var(--neon3)', minWidth: 110 }}>{a.steps.map((s: Step) => s.op).join(' → ') || '(raw)'}</span>
            <span className="small muted">{a.len} B · {(a.printable * 100).toFixed(0)}% print · H {a.entropy.toFixed(2)}</span>
            {a.magic.length > 0 && <span className="chip hi">{a.magic[0]}</span>}
          </div>)}</div>)}

        <div className="row" style={{ marginTop: 14 }}><span className="sec-title" style={{ margin: 0 }}>xor key recovery</span><span className="spacer" /><button className="btn sm" onClick={runXor} disabled={!input}>Analyze {out && steps.length ? 'output' : 'input'}</button></div>
        <div className="row" style={{ marginTop: 6 }}>
          <Field label="known plaintext"><input value={plain} onChange={e => setPlain(e.target.value)} placeholder='e.g. "\x1bLua" or local ' style={{ width: 130 }} /></Field>
          <Field label="@"><input type="number" value={plainOff} onChange={e => setPlainOff(Number(e.target.value))} style={{ width: 60 }} /></Field>
        </div>
        {xor && <div style={{ marginTop: 6 }}>
          <div className="small muted">single-byte keys (best plaintext score):</div>
          <div className="list">{xor.single.map((c: any, i: number) => <div key={i} className="li" onClick={() => setSteps([...steps, { op: 'xor', arg: String(c.key) }])} title="add as xor step"><span className="chip hi">0x{c.key.toString(16).padStart(2, '0')}</span><span className="small muted">{c.score.toFixed(2)}</span><span className="t small">{c.preview}</span></div>)}</div>
          <div className="small muted" style={{ marginTop: 6 }}>repeating-key length guesses (normalized Hamming): {xor.lengths.map((l: any) => `${l.len} (${l.dist.toFixed(2)})`).join(', ')}</div>
          {xor.known && <div className="small" style={{ marginTop: 6 }}>key from known plaintext: <span className="mono" style={{ color: 'var(--ok)' }}>{xor.known.map((x: number) => x.toString(16).padStart(2, '0')).join(' ')}</span> <span className="copy-btn" onClick={() => setSteps([...steps, { op: 'xor', arg: 'hex:' + xor.known.map((x: number) => x.toString(16).padStart(2, '0')).join('') }])}>add xor step</span></div>}
        </div>}
      </div>

      <div className="col">
        <ErrorBox error={err} />
        {res && out ? <>
          <div className="toolbar">
            <div className="chips">
              <span className="chip hi">{out.length.toLocaleString()} B</span>
              <span className="chip">H <b>{res.info.entropy.toFixed(2)}</b></span>
              <span className="chip">printable <b>{(res.info.printable * 100).toFixed(0)}%</b></span>
              {res.info.magic.map((m, i) => <span key={i} className="chip hi">{m}</span>)}
            </div>
            <span className="spacer" />
            {isBc && <span className="copy-btn" onClick={() => send('disasm', { bytes: out, label: 'Blob Lab output' })}>→ Disassemble</span>}
            <span className="copy-btn" onClick={() => { setBin({ bytes: out, label: 'previous output' }); setSteps([]); }} title="chain: use this output as the new input">Use as input</span>
            <span className="copy-btn" onClick={() => download('blob.bin', out, 'application/octet-stream')}>Download .bin</span>
            {backend && <span className="copy-btn" onClick={saveWs}>Save to workspace</span>}
          </div>
          <div className="toolbar" style={{ paddingTop: 5, paddingBottom: 5 }}>
            <Seg value={view} onChange={setView} options={['hexdump', 'text', 'utf8', 'python', 'lua', 'c', 'table', 'base64', 'hex'] as View[]} />
            <span className="spacer" /><Copy text={fullFor(view)} label={`Copy ${view}`} />
          </div>
          <div className="fill scroll"><pre className="block" style={{ maxHeight: 'none', border: 'none', borderRadius: 0, minHeight: '100%' }}>{rendered.length > 400000 ? rendered.slice(0, 400000) + '\n… (Copy / Download for everything)' : rendered}</pre></div>
        </> : <Empty><div><div className="big">Blob Lab</div>Paste or send a blob (Constants/Strings “→ Blob”, Disassembly, files). Build a decode pipeline step by step — every step is a pure static transform; copy the recipe, export the bytes.</div></Empty>}
      </div>
    </div>
  );
}
