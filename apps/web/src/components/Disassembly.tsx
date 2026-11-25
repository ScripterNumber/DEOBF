import React, { useCallback, useEffect, useState } from 'react';
import Editor from '@monaco-editor/react';
import { usePrism, useInbox } from '../ctx.js';
import { engine } from '../engineClient.js';
import { api } from '../api.js';
import { Copy, Download, Empty, ErrorBox, Busy, Seg, Toggle, Field, LineLink, useLocal, bytesLatin1 } from './ui.js';
import { BehaviorPanel } from './Behavior.js';

const RO = { minimap: { enabled: false }, fontSize: 12, readOnly: true, scrollBeyondLastLine: false, automaticLayout: true, wordWrap: 'off' as const, lineNumbers: 'off' as const, glyphMargin: false, folding: true };
type Src = { bytes: Uint8Array; label: string };
type Emb = { line: number; via: string; format: string; length: number; preview: string };

export function Disassembly() {
  const [mode, setMode] = useLocal<'bytecode' | 'vm' | 'chunk'>('disasm:mode', 'bytecode');
  const [vmSeed, setVmSeed] = useState<any>(null);
  const [chunkSeed, setChunkSeed] = useState<any>(null);
  const [bcSeed, setBcSeed] = useState<Src | null>(null);
  useInbox('disasm', useCallback((p: Src) => { setMode('bytecode'); setBcSeed(p); }, [setMode]));
  useInbox('vm', useCallback((p: any) => { if (p?.chunk !== undefined) { setMode('chunk'); setChunkSeed(p); } else { setMode('vm'); setVmSeed(p); } }, [setMode]));
  return (
    <div className="col">
      <div className="toolbar">
        <Seg value={mode} onChange={setMode} options={[{ v: 'bytecode', label: 'Luau / Lua 5.1 bytecode' }, { v: 'vm', label: 'Custom VM instructions' }, { v: 'chunk', label: 'VM chunk explorer', title: 'a whole decoded chunk (JSON from the Python port / any JSON or Lua table): layout auto-detected, every proto disassembled' }]} />
        <span className="small muted">{mode === 'bytecode' ? 'auto-detects Luau v3–v14 (plain or Roblox op×227) and Lua 5.1 — exact luau-compile / luac listings + lifted pseudo-Lua' : mode === 'vm' ? 'decoded instruction arrays + your opcode map → readable listing' : 'decoded chunk → protos, instructions, constants, nested protos detected automatically → full listing + strings'}</span>
      </div>
      <div className="fill">{mode === 'bytecode' ? <BytecodeView seed={bcSeed} /> : mode === 'vm' ? <VmView seed={vmSeed} /> : <ChunkView seed={chunkSeed} />}</div>
    </div>
  );
}

function BytecodeView({ seed }: { seed: Src | null }) {
  const { text, backend, toast, send, reveal, target } = usePrism();
  const [srcBytes, setSrcBytes] = useState<Src | null>(seed);
  const [paste, setPaste] = useState('');
  const [enc, setEnc] = useState('auto');
  const [emb, setEmb] = useState<Emb[] | null>(null);
  const [opt, setOpt] = useLocal('disasm:opts', { style: 'rich', hex: false, lift: true, constants: true, debug: true, encoding: 'auto', format: 'auto' });
  const [cOpt, setCOpt] = useLocal('disasm:compile', { optimize: 1, debug: 2 });
  const [out, setOut] = useState<{ text: string; format: string; summary: any } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => { if (seed) setSrcBytes(seed); }, [seed]);
  useEffect(() => { let live = true; if (text.trim()) engine.op<Emb[]>('embedded', text).then(r => live && setEmb(r.result)).catch(() => live && setEmb([])); else setEmb([]); return () => { live = false; }; }, [text]);
  useEffect(() => {
    if (!srcBytes) return;
    let live = true; setBusy(true); setErr(null);
    engine.op('disasm', '', { bytes: srcBytes.bytes, options: { ...opt, maxInsns: 200000 } })
      .then(r => { if (live) setOut(r.result); }).catch(e => { if (live) { setErr(e.message); setOut(null); } }).finally(() => live && setBusy(false));
    return () => { live = false; };
  }, [srcBytes, opt]);

  const fromPaste = async () => { try { const { result } = await engine.op<Uint8Array>('parseBytes', '', { data: paste, encoding: enc }); setSrcBytes({ bytes: result, label: `pasted (${enc})` }); } catch (e: any) { setErr(e.message); } };
  const fromEmb = async (e: Emb) => { try { const { result } = await engine.op<Uint8Array>('embeddedBytes', text, e); setSrcBytes({ bytes: result, label: `L${e.line} (${e.via})` }); } catch (x: any) { setErr(x.message); } };
  const compile = async () => {
    setBusy(true); setErr(null);
    try {
      const r = await api.run('luau_compile', { source: text, mode: 'binary', optimize: cOpt.optimize, debug: cOpt.debug, max_chars: 400 });
      if (!r.ok) throw new Error(r.error);
      const hex = (r.data as any)?.hex; if (!hex) throw new Error(r.text ?? 'compile failed');
      const { result } = await engine.op<Uint8Array>('parseBytes', '', { data: hex, encoding: 'hex' });
      setSrcBytes({ bytes: result, label: `luau-compile -O${cOpt.optimize} -g${cOpt.debug} (${target})` });
    } catch (e: any) { setErr(e.message); } finally { setBusy(false); }
  };
  const onFile = async (f: File) => setSrcBytes({ bytes: new Uint8Array(await f.arrayBuffer()), label: f.name });
  const sum = out?.summary ?? {};

  return (
    <div className="split" style={{ gridTemplateColumns: 'minmax(250px, 320px) 1fr' }}>
      <div className="scroll">
        <div className="cards" style={{ padding: 10, gap: 10 }}>
          <div className="card"><div className="card-h"><span className="dot" />Embedded in script ({target})</div><div className="card-b" style={{ padding: 0 }}>
            {emb === null ? <div className="small muted" style={{ padding: 10 }}>scanning…</div> : emb.length === 0 ? <div className="small muted" style={{ padding: 10 }}>no Lua/Luau bytecode found in string literals (raw, base64, hex). Custom-VM scripts store their own format — use Constants / Blob Lab / Custom VM.</div> :
              <div className="list">{emb.map((e, i) => <div key={i} className="li" onClick={() => fromEmb(e)}><LineLink line={e.line} onClick={l => reveal(l)} /><span className="t">{e.format}</span><span className="small muted">{e.via} · {e.length} B</span></div>)}</div>}
          </div></div>
          <div className="card"><div className="card-h"><span className="dot" />Paste bytes</div><div className="card-b">
            <textarea className="inp" rows={5} placeholder={'hex / base64 / "\\27Lua..." / {27,76,117,97,…}'} value={paste} onChange={e => setPaste(e.target.value)} />
            <div className="row" style={{ marginTop: 6 }}>
              <select className="inp" value={enc} onChange={e => setEnc(e.target.value)}>{['auto', 'hex', 'base64', 'lua', 'decimal', 'latin1'].map(x => <option key={x}>{x}</option>)}</select>
              <button className="btn sm" disabled={!paste.trim()} onClick={fromPaste}>Disassemble</button>
            </div>
          </div></div>
          <div className="card"><div className="card-h"><span className="dot" />File</div><div className="card-b">
            <input type="file" onChange={e => { const f = e.target.files?.[0]; if (f) onFile(f); e.target.value = ''; }} style={{ fontSize: 11, color: 'var(--txt-dim)' }} />
            <div className="small muted" style={{ marginTop: 4 }}>.luac / .luau bytecode — dropping a binary file anywhere also lands here</div>
          </div></div>
          <div className="card"><div className="card-h"><span className="dot" />Compile {target} code (luau-compile)</div><div className="card-b">
            {backend?.luau.compile ? <>
              <div className="row">
                <Field label="-O"><select value={cOpt.optimize} onChange={e => setCOpt({ ...cOpt, optimize: Number(e.target.value) })}>{[0, 1, 2].map(x => <option key={x}>{x}</option>)}</select></Field>
                <Field label="-g"><select value={cOpt.debug} onChange={e => setCOpt({ ...cOpt, debug: Number(e.target.value) })}>{[0, 1, 2].map(x => <option key={x}>{x}</option>)}</select></Field>
                <button className="btn sm" onClick={compile} disabled={!text.trim()}>Compile → disasm</button>
              </div>
              <div className="small muted" style={{ marginTop: 6 }}>reference compiler: learn what real Luau handlers/opcodes look like, or diff against a VM's semantics</div>
            </> : <div className="small muted">needs the PRISM server with tools/luau (native luau-compile)</div>}
          </div></div>
        </div>
      </div>
      <div className="col">
        <Busy on={busy} label="Disassembling" />
        <div className="toolbar">
          <Seg value={opt.style} onChange={v => setOpt({ ...opt, style: v })} options={[{ v: 'rich', label: 'rich' }, { v: 'luau', label: 'reference', title: 'byte-identical to luau-compile --text / luac -l' }]} />
          <Toggle on={opt.lift} onChange={v => setOpt({ ...opt, lift: v })} title="pseudo-Lua per instruction">lift</Toggle>
          <Toggle on={opt.hex} onChange={v => setOpt({ ...opt, hex: v })}>hex</Toggle>
          <Toggle on={opt.constants} onChange={v => setOpt({ ...opt, constants: v })}>constants</Toggle>
          <Toggle on={opt.debug} onChange={v => setOpt({ ...opt, debug: v })} title="line info + local names">debug</Toggle>
          <Field label="format"><select value={opt.format} onChange={e => setOpt({ ...opt, format: e.target.value })}>{['auto', 'luau', 'lua51'].map(x => <option key={x}>{x}</option>)}</select></Field>
          <Field label="opcodes"><select value={opt.encoding} onChange={e => setOpt({ ...opt, encoding: e.target.value })} title="Roblox client bytecode stores op×227 mod 256"><option value="auto">auto</option><option value="plain">plain</option><option value="roblox">roblox ×227</option></select></Field>
          <span className="spacer" />
          {out && <><Copy text={out.text} label="Copy listing" /><Download name={(srcBytes?.label ?? 'bytecode').replace(/[^\w.-]+/g, '_') + '.disasm.txt'} content={out.text} /></>}
          {srcBytes && <span className="copy-btn" onClick={() => send('blob', { bytes: srcBytes.bytes, label: srcBytes.label })}>→ Blob Lab</span>}
        </div>
        {srcBytes && out && (
          <div className="toolbar" style={{ paddingTop: 5, paddingBottom: 5 }}>
            <div className="chips">
              <span className="chip hi">{out.format === 'luau' ? `Luau v${sum.version ?? '?'}` : 'Lua 5.1'}</span>
              <span className="chip">{srcBytes.label}</span>
              <span className="chip">bytes <b>{srcBytes.bytes.length}</b></span>
              {sum.protos && <span className="chip">functions <b>{sum.protos.length}</b></span>}
              {sum.functions !== undefined && <span className="chip">functions <b>{sum.functions}</b></span>}
              {sum.instructions !== undefined && <span className="chip">insns <b>{sum.instructions}</b></span>}
              {sum.strings !== undefined && <span className="chip">strings <b>{Array.isArray(sum.strings) ? sum.strings.length : sum.strings}</b></span>}
              {sum.opcodeHistogram && <span className="chip">insns <b>{Object.values(sum.opcodeHistogram as Record<string, number>).reduce((a, b) => a + b, 0)}</b></span>}
              {sum.imports?.length > 0 && <span className="chip" title={sum.imports.join('\n')}>imports <b>{sum.imports.length}</b></span>}
              {sum.warnings?.length > 0 && <span className="chip" style={{ color: 'var(--warn)' }} title={sum.warnings.join('\n')}>warnings <b>{sum.warnings.length}</b></span>}
              {sum.encoding && <span className="chip">opcodes <b>{sum.encoding}</b></span>}
            </div>
          </div>
        )}
        <ErrorBox error={err} />
        <div className="fill">
          {out ? <Editor height="100%" language="prism-asm" theme="prism" path="disasm.asm" value={out.text} options={RO} />
            : !err && <Empty><div><div className="big">Pick a bytecode source on the left</div>embedded literal · pasted hex/base64/escaped string · file · or compile the current script with luau-compile</div></Empty>}
        </div>
        {srcBytes && !out && err && <div className="small muted" style={{ padding: 10 }}>first bytes: {Array.from(srcBytes.bytes.subarray(0, 32), b => b.toString(16).padStart(2, '0')).join(' ')} — not standard bytecode? Try Blob Lab (it may be encrypted/compressed) or the Custom VM mode. <span className="copy-btn" onClick={() => send('blob', { bytes: srcBytes.bytes, label: srcBytes.label })}>→ Blob Lab</span> <Copy text={bytesLatin1(srcBytes.bytes)} label="Copy raw" /></div>}
      </div>
    </div>
  );
}

const VM_EXAMPLE = `-- instructions: JSON array or Lua table literal (e.g. decoded by your Python port)
{ {op=3, a=0, b=1, c=0}, {op=7, a=0, b=2}, {op=12, a=0, b=1} }`;

function VmView({ seed }: { seed: any }) {
  const { backend, toast } = usePrism();
  const [insn, setInsn] = useLocal('vm:insn', VM_EXAMPLE);
  const [consts, setConsts] = useLocal('vm:consts', '');
  const [mapTxt, setMapTxt] = useLocal('vm:opmap', '{\n  "3": {"name": "LOADK", "lua": "R[A] = K[B]"},\n  "7": {"name": "GETGLOBAL", "lua": "R[A] = _ENV[K[B]]"},\n  "12": {"name": "CALL", "lua": "R[A](R[A+1..A+B-1])"}\n}');
  const [o, setO] = useLocal('vm:opts', { opField: '', fields: '', kBase: 1, pcBase: 1 });
  const [out, setOut] = useState<any>(null);
  const [err, setErr] = useState<string | null>(null);
  const [wsList, setWsList] = useState<string[]>([]);
  useEffect(() => { if (seed?.instructions) { setInsn(seed.instructions); toast('instruction array loaded — add an opcode map and Disassemble', 'ok'); } if (seed?.opmap) { setMapTxt(JSON.stringify(seed.opmap, null, 2)); if (seed.roles?.opField) setO(p => ({ ...p, opField: seed.roles.opField })); toast('opcode map loaded into the VM disassembler', 'ok'); } }, [seed]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (backend) api.opmaps().then(setWsList).catch(() => {}); }, [backend]);

  const parse = async (t: string): Promise<unknown> => { const s = t.replace(/^\s*--.*$/gm, '').trim(); if (!s) return undefined; try { return JSON.parse(s); } catch { return (await engine.op('literal', '', { text: s })).result; } };
  const run = async () => {
    setErr(null);
    try {
      const instructions = await parse(insn); if (!Array.isArray(instructions)) throw new Error('instructions must be an array (JSON) or a Lua table literal');
      const constants = await parse(consts); const opmap = (await parse(mapTxt)) ?? {};
      const fields: Record<string, string> = {}; for (const p of o.fields.split(/[,\s]+/).filter(Boolean)) { const [k, v] = p.split(/[:=]/); if (k && v) fields[k] = v; }
      const { result } = await engine.op('vmdisasm', '', { instructions, opmap, options: { opField: o.opField || undefined, fields: Object.keys(fields).length ? fields : undefined, constants: Array.isArray(constants) ? constants : undefined, kBase: o.kBase, pcBase: o.pcBase } });
      setOut(result);
    } catch (e: any) { setErr(e.message); }
  };
  return (
    <div className="split" style={{ gridTemplateColumns: 'minmax(300px, 40%) 1fr' }}>
      <div className="scroll" style={{ padding: 10 }}>
        <div className="sec-title">instructions</div>
        <textarea className="inp" rows={9} value={insn} onChange={e => setInsn(e.target.value)} spellCheck={false} />
        <div className="sec-title" style={{ marginTop: 8 }}>constants (optional, JSON / Lua table)</div>
        <textarea className="inp" rows={3} value={consts} onChange={e => setConsts(e.target.value)} placeholder='{"print", "hello", 42}' spellCheck={false} />
        <div className="row" style={{ marginTop: 8 }}>
          <span className="sec-title" style={{ margin: 0 }}>opcode map</span><span className="spacer" />
          {wsList.length > 0 && <select className="inp" value="" onChange={async e => { if (e.target.value) { setMapTxt(JSON.stringify(await api.getOpmap(e.target.value), null, 2)); } }}><option value="">from workspace…</option>{wsList.map(n => <option key={n}>{n}</option>)}</select>}
        </div>
        <textarea className="inp" rows={8} value={mapTxt} onChange={e => setMapTxt(e.target.value)} spellCheck={false} />
        <div className="row" style={{ marginTop: 8 }}>
          <Field label="op field" hint="key/index of the opcode in each instruction (auto: op/opcode/1/0)"><input value={o.opField} onChange={e => setO({ ...o, opField: e.target.value })} style={{ width: 70 }} placeholder="auto" /></Field>
          <Field label="fields" hint='operand keys → letters, e.g. "2:A 3:B 4:C"'><input value={o.fields} onChange={e => setO({ ...o, fields: e.target.value })} style={{ width: 110 }} placeholder="2:A 3:B 4:C" /></Field>
          <Field label="K base"><input type="number" value={o.kBase} onChange={e => setO({ ...o, kBase: Number(e.target.value) })} style={{ width: 50 }} /></Field>
          <Field label="pc base"><input type="number" value={o.pcBase} onChange={e => setO({ ...o, pcBase: Number(e.target.value) })} style={{ width: 50 }} /></Field>
        </div>
        <button className="btn primary sm" style={{ marginTop: 10 }} onClick={run}>Disassemble</button>
        <div className="small muted" style={{ marginTop: 8 }}>Templates in the map (<span className="mono">R[A] = K[B]</span>) are filled with operands and constants. Get a map from the Opcode Map tab (“→ VM disasm”).</div>
      </div>
      <div className="col">
        <ErrorBox error={err} />
        {out ? <>
          <div className="toolbar">
            <div className="chips"><span className="chip hi">{out.count} insns</span><span className="chip">op field <b>{out.opField}</b></span>{Object.entries(out.fields ?? {}).map(([k, v]) => <span key={k} className="chip">{k}→<b>{String(v)}</b></span>)}{out.unknown?.length > 0 && <span className="chip" style={{ color: 'var(--warn)' }}>unknown ops <b>{out.unknown.length}</b></span>}</div>
            <span className="spacer" /><Copy text={out.text} label="Copy listing" /><Copy text={JSON.stringify(out.histogram, null, 2)} label="Copy histogram" /><Download name="vm.disasm.txt" content={out.text} />
          </div>
          {out.unknown?.length > 0 && <div className="small" style={{ padding: '4px 12px', color: 'var(--warn)' }}>unmapped opcodes: {out.unknown.slice(0, 60).join(', ')}</div>}
          <div className="fill"><Editor height="100%" language="prism-asm" theme="prism" path="vm.asm" value={out.text} options={RO} /></div>
        </> : !err && <Empty>Fill in instructions + opcode map, then Disassemble.</Empty>}
      </div>
    </div>
  );
}

const CHUNK_EXAMPLE = `-- paste the JSON printed by the Python port of the deserializer (python3 file.py out.json), any JSON, or a Lua table
{ {{3,0,1},{7,0,2},{12,0,1,1}}, { { {{3,1,2}}, {}, {"x"} } }, {"print","hello"} }`;

type ChunkOut = { text: string; layout: any; protos: Array<{ id: string; depth: number; instructions: number; children: number; consts: number }>; totalInstructions: number; histogram: Array<{ op: string; name: string; count: number }>; unknown: string[]; strings: Array<{ value: string; count: number; first: string }>; notes: string[]; rootPath: string[] };

function ChunkView({ seed }: { seed: any }) {
  const { text, backend, toast, name } = usePrism();
  const [chunk, setChunk] = useState(CHUNK_EXAMPLE);
  const [mapTxt, setMapTxt] = useLocal('chunk:opmap', '{}');
  const [o, setO] = useLocal('chunk:opts', { opField: '', fields: '', bits: '', select: '', proto: '', max: 4000 });
  const [out, setOut] = useState<ChunkOut | null>(null);
  const [view, setView] = useState<'listing' | 'strings' | 'protos' | 'iocs'>('listing');
  const [ran, setRan] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [wsList, setWsList] = useState<string[]>([]);
  const fileRef = React.useRef<HTMLInputElement>(null);
  useEffect(() => { if (seed?.chunk !== undefined) { setChunk(typeof seed.chunk === 'string' ? seed.chunk : JSON.stringify(seed.chunk)); toast('chunk loaded — Disassemble (use “Map from script” for the opcode names)', 'ok'); } }, [seed, toast]);
  useEffect(() => { if (backend) api.opmaps().then(setWsList).catch(() => {}); }, [backend]);
  const fromScript = async () => {
    setBusy(true); setErr(null);
    try {
      const { result } = await engine.op('opcodes', text, { maxTrees: 8 });
      const trees = result.report.trees as Array<{ kind: string; score: number; roles: any; handlers: unknown[]; var: string }>;
      const i = trees.map((t, k) => ({ t, k })).filter(x => x.t.kind === 'vm').sort((a, b) => b.t.score - a.t.score)[0]?.k ?? (trees.length ? 0 : -1);
      if (i < 0) throw new Error('no dispatch tree in the current script');
      const t = trees[i];
      setMapTxt(JSON.stringify(result.opmaps[i], null, 2));
      setO(p => ({ ...p, opField: t.roles?.opField ?? p.opField, fields: t.roles?.fields ? Object.entries(t.roles.fields).map(([k, v]) => `${k}:${v}`).join(' ') : p.fields }));
      toast(`opcode map from tree on ${t.var}: ${t.handlers.length} handlers`, 'ok');
    } catch (e: any) { setErr(e.message); } finally { setBusy(false); }
  };
  const run = async () => {
    setErr(null); setBusy(true);
    try {
      const body = chunk.replace(/^\s*--.*$/gm, '').trim();
      const opmap = mapTxt.trim() ? JSON.parse(mapTxt) : {};
      const fields: Record<string, string> = {}; for (const p of o.fields.split(/[,\s]+/).filter(Boolean)) { const [k, v] = p.split(/[:=]/); if (k && v) fields[k] = v; }
      const { result } = await engine.op<ChunkOut>('chunkdisasm', '', { chunk: body, opmap, options: { opField: o.opField || undefined, fields: Object.keys(fields).length ? fields : undefined, bits: o.bits || undefined, select: o.select || undefined, proto: o.proto || undefined, max: o.max || 4000 } });
      setOut(result); setView('listing'); setRan(body);
    } catch (e: any) { setErr(e.message); setOut(null); } finally { setBusy(false); }
  };
  const stringsText = out ? out.strings.map(s => `${String(s.count).padStart(6)}×  ${JSON.stringify(s.value)}   (${s.first})`).join('\n') : '';
  const protosText = out ? out.protos.map(p => `${'  '.repeat(p.depth)}${p.id}  ${p.instructions} insns${p.children ? ` · ${p.children} children` : ''}${p.consts ? ` · ${p.consts} consts` : ''}`).join('\n') : '';
  const shown = view === 'listing' ? out?.text ?? '' : view === 'strings' ? stringsText : view === 'protos' ? protosText : '';
  return (
    <div className="split" style={{ gridTemplateColumns: 'minmax(300px, 38%) 1fr' }}>
      <div className="scroll" style={{ padding: 10 }}>
        <div className="row"><span className="sec-title" style={{ margin: 0 }}>decoded chunk</span><span className="spacer" />
          <button className="btn ghost sm" onClick={() => fileRef.current?.click()}>Open JSON</button>
          <input ref={fileRef} type="file" accept=".json,.txt,.lua" style={{ display: 'none' }} onChange={async e => { const f = e.target.files?.[0]; if (f) { setChunk(await f.text()); toast(`${f.name} loaded`, 'ok'); } e.target.value = ''; }} />
        </div>
        <textarea className="inp" rows={9} value={chunk.length > 400000 ? chunk.slice(0, 400000) : chunk} onChange={e => setChunk(e.target.value)} spellCheck={false} readOnly={chunk.length > 400000} />
        {chunk.length > 400000 && <div className="small muted">{(chunk.length / 1e6).toFixed(1)} MB loaded (preview truncated, read-only) <span className="copy-btn" onClick={() => setChunk(CHUNK_EXAMPLE)}>clear</span></div>}
        <div className="row" style={{ marginTop: 8 }}>
          <span className="sec-title" style={{ margin: 0 }}>opcode map</span><span className="spacer" />
          <span className="copy-btn" onClick={fromScript} title="guess the map + operand roles from the interpreter of the script on the left">Map from script</span>
          {wsList.length > 0 && <select className="inp" value="" onChange={async e => { if (e.target.value) { const m = await api.getOpmap(e.target.value) as any; const meta = m.$meta; delete m.$meta; setMapTxt(JSON.stringify(m, null, 2)); if (meta?.roles) setO(p => ({ ...p, opField: meta.roles.opField ?? p.opField, fields: meta.roles.fields ? Object.entries(meta.roles.fields).map(([k, v]) => `${k}:${v}`).join(' ') : p.fields })); } }}><option value="">from workspace…</option>{wsList.map(n => <option key={n}>{n}</option>)}</select>}
        </div>
        <textarea className="inp" rows={6} value={mapTxt} onChange={e => setMapTxt(e.target.value)} spellCheck={false} />
        <div className="row" style={{ marginTop: 8, flexWrap: 'wrap' }}>
          <Field label="op field" hint='opcode key; lists use Lua keys ("1" = first element). auto = from roles / map / data'><input value={o.opField} onChange={e => setO({ ...o, opField: e.target.value })} style={{ width: 60 }} placeholder="auto" /></Field>
          <Field label="fields" hint='operand keys → letters, e.g. "2:A 3:B 4:C"'><input value={o.fields} onChange={e => setO({ ...o, fields: e.target.value })} style={{ width: 100 }} placeholder="auto" /></Field>
          <Field label="bits" hint='packed words: "op:0:8 A:8:8 B:16:8 C:24:8", or luau / lua51'><input value={o.bits} onChange={e => setO({ ...o, bits: e.target.value })} style={{ width: 90 }} placeholder="luau" /></Field>
          <Field label="root" hint='key path to the root proto when auto-detection is wrong, e.g. "L10123:12" or "1.2"'><input value={o.select} onChange={e => setO({ ...o, select: e.target.value })} style={{ width: 80 }} placeholder="auto" /></Field>
          <Field label="proto" hint="only list this proto (F, F.0, F.2.1 …)"><input value={o.proto} onChange={e => setO({ ...o, proto: e.target.value })} style={{ width: 60 }} placeholder="all" /></Field>
          <Field label="max/proto"><input type="number" value={o.max} onChange={e => setO({ ...o, max: Number(e.target.value) })} style={{ width: 64 }} /></Field>
        </div>
        <button className="btn primary sm" style={{ marginTop: 10 }} onClick={run} disabled={busy}>Disassemble chunk</button>
        <div className="small muted" style={{ marginTop: 8 }}>Workflow: VM Map → deserializer “→ Python” → run <span className="kbd">python3 file.py out.json</span> → open out.json here. Lists use Lua keys, so the Opcode Map roles (<span className="mono">inst[1]</span> = opcode) apply directly. Strings found anywhere in the chunk are the VM's real constants.</div>
      </div>
      <div className="col" style={{ position: 'relative' }}>
        <Busy on={busy} label="Disassembling chunk" />
        <ErrorBox error={err} />
        {out ? <>
          <div className="toolbar">
            <div className="chips">
              <span className="chip hi">{out.protos.length} protos</span><span className="chip">{out.totalInstructions.toLocaleString()} insns</span>
              <span className="chip">{out.layout.kind} · op <b>[{out.layout.opField}]</b></span>
              {out.layout.protos && <span className="chip">protos <b>[{out.layout.protos}]</b></span>}
              <span className="chip">consts <b>{out.layout.consts ? `[${out.layout.consts}]` : 'inline'}</b></span>
              {out.unknown.length > 0 && <span className="chip" style={{ color: 'var(--warn)' }}>{out.unknown.length} unmapped</span>}
            </div>
            <Seg value={view} onChange={setView} options={[{ v: 'listing', label: 'listing' }, { v: 'strings', label: `strings (${out.strings.length})` }, { v: 'protos', label: 'protos' }, { v: 'iocs', label: 'IOCs', title: 'behaviour / IOC report over every string in the chunk' }]} />
            <span className="spacer" />{view !== 'iocs' && <Copy text={shown} label="Copy" />}<Copy text={JSON.stringify({ layout: out.layout, protos: out.protos, histogram: out.histogram, strings: out.strings }, null, 2)} label="Copy JSON" /><Download name={name.replace(/\.(lua|luau|txt)$/i, '') + (view === 'listing' ? '.chunk.asm.txt' : view === 'strings' ? '.chunk.strings.txt' : '.chunk.protos.txt')} content={shown} />
          </div>
          {out.notes.length > 0 && <div className="small" style={{ padding: '4px 12px', color: 'var(--neon3)' }}>{out.notes.map((n, i) => <div key={i}>▸ {n}</div>)}</div>}
          {view === 'iocs' ? <div className="fill scroll" style={{ padding: 12 }}><BehaviorPanel chunk={ran} noSource label="decoded chunk" /></div>
            : <div className="fill"><Editor height="100%" language={view === 'listing' ? 'prism-asm' : 'plaintext'} theme="prism" path={'chunk-' + view} value={shown} options={RO} /></div>}
        </> : !err && <Empty><div><div className="big">VM chunk explorer</div>Paste / open the decoded chunk, optionally add an opcode map (“Map from script”), then Disassemble.</div></Empty>}
      </div>
    </div>
  );
}
