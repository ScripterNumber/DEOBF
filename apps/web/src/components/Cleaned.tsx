import React, { useMemo, useState } from 'react';
import Editor, { DiffEditor } from '@monaco-editor/react';
import type { CleanResult, CleanOptions } from '@prism/core';
import { Copy, Download, Seg, Toggle, Field, LineLink } from './ui.js';
import { usePrism } from '../ctx.js';
import { engine } from '../engineClient.js';
import { api } from '../api.js';

const MONACO_OPTS = {
  minimap: { enabled: false }, fontSize: 12, lineNumbers: 'on' as const, scrollBeyondLastLine: false, wordWrap: 'off' as const,
  renderWhitespace: 'none' as const, automaticLayout: true, readOnly: true,
};

const PASSES: Array<{ k: keyof CleanOptions; label: string; hint: string }> = [
  { k: 'foldConstants', label: 'fold numbers / MBA', hint: 'constant folding incl. bit32 & mixed boolean-arithmetic identities' },
  { k: 'recoverStrings', label: 'decode strings', hint: 'string.char(...), escapes, concat chains, byte tables' },
  { k: 'removeDeadCode', label: 'dead code', hint: 'opaque predicates, unreachable branches, no-ops' },
  { k: 'propagate', label: 'inline aliases', hint: 'inline literal locals and pure builtin aliases (local f = string.byte)' },
  { k: 'removeUnusedLocals', label: 'drop junk locals', hint: 'never-read locals and assignments' },
  { k: 'controlFlow', label: 'control flow', hint: 'while-break → if, repeat-until-true → do, opaque state guards' },
  { k: 'stripParens', label: 'strip parens', hint: 'drop redundant parentheses' },
];

export function Cleaned({ original, clean, opts, onReclean }: { original: string; clean: CleanResult; opts: CleanOptions; onReclean: (o: CleanOptions) => void }) {
  const { backend, toast, name, setInput, reveal } = usePrism();
  const [mode, setMode] = useState<'clean' | 'diff' | 'renames' | 'passes'>('clean');
  const [draft, setDraft] = useState<CleanOptions>(opts);
  const [code, setCode] = useState<string | null>(null); // manual renames applied on top
  const [rFrom, setRFrom] = useState(''); const [rTo, setRTo] = useState(''); const [rLine, setRLine] = useState('');
  const shown = code ?? clean.code;
  const s = clean.stats;
  const on = (k: keyof CleanOptions) => draft[k] !== false;
  const renameCsv = useMemo(() => 'from,to,line,kind\n' + clean.renameMap.map(r => `${r.from},${r.to},${r.line},${r.kind}`).join('\n'), [clean.renameMap]);

  const applyRename = async () => {
    if (!rFrom || !rTo) return;
    try {
      const { result } = await engine.op('rename', shown, { renames: [{ name: rFrom, to: rTo, line: rLine ? Number(rLine) : undefined, all: !rLine }] });
      setCode(result.code);
      toast(result.applied.length ? `renamed ${rFrom} → ${rTo}: ${result.applied.map((a: any) => `L${a.line} ${a.kind} ×${a.sites}`).join(', ')}` : `no rename: ${(result.errors ?? []).join('; ') || 'no binding found'}`, result.applied.length ? 'ok' : 'bad');
    } catch (e: any) { toast(e.message, 'bad'); }
  };
  const save = async () => {
    try {
      const base = name.replace(/\.(lua|luau|txt)$/i, '');
      const parent = await api.addScript(name, original);
      const m = await api.addScript(base + '.clean.lua', shown, { parent: parent.id, derivedBy: 'web deobfuscate' });
      toast(`saved to workspace as ${m.id}`, 'ok');
    } catch (e: any) { toast(e.message, 'bad'); }
  };

  return (
    <div className="col">
      <div className="toolbar">
        <Seg value={mode} onChange={setMode} options={[{ v: 'clean', label: 'cleaned' }, { v: 'diff', label: 'diff' }, { v: 'renames', label: `renames (${clean.renameMap.length})` }, { v: 'passes', label: 'passes ⚙' }]} />
        <div className="chips">
          <span className="chip" title="constant folds">folded <b>{s.folded}</b></span>
          <span className="chip" title="MBA / bit32 identities">mba <b>{s.mbaFolded}</b></span>
          <span className="chip">strings <b>{s.charCalls + s.concatChains}</b></span>
          <span className="chip">pruned <b>{s.prunedBranches}</b></span>
          <span className="chip">dead <b>{s.removedStmts + s.removedLocals + s.removedAssigns}</b></span>
          <span className="chip">inlined <b>{s.propagated + s.aliases}</b></span>
          <span className="chip">cf <b>{s.loopsToIf + s.guardsFolded + s.guardsMerged + s.blocksFlattened}</b></span>
          <span className="chip">rounds <b>{clean.rounds}</b></span>
          {code !== null && <span className="chip hi">manual renames</span>}
        </div>
        <span className="spacer" />
        <Copy text={shown} label="Copy cleaned" />
        <Download name={name.replace(/\.(lua|luau|txt)$/i, '') + '.clean.lua'} content={shown} />
        <span className="copy-btn" onClick={() => setInput(shown, name.replace(/\.(lua|luau|txt)$/i, '') + '.clean.lua')} title="Iterate: analyze the cleaned code as new input">Use as input</span>
        {backend && <span className="copy-btn" onClick={save} title="Store original + cleaned (with lineage) in the server workspace">Save to workspace</span>}
      </div>
      {mode === 'clean' && (
        <div className="toolbar" style={{ paddingTop: 6, paddingBottom: 6 }}>
          <span className="small muted">rename symbol</span>
          <input className="inp" style={{ width: 120 }} placeholder="old name" value={rFrom} onChange={e => setRFrom(e.target.value)} />
          <span className="muted">→</span>
          <input className="inp" style={{ width: 120 }} placeholder="new name" value={rTo} onChange={e => setRTo(e.target.value)} onKeyDown={e => e.key === 'Enter' && applyRename()} />
          <input className="inp" style={{ width: 70 }} placeholder="line?" value={rLine} onChange={e => setRLine(e.target.value.replace(/\D/g, ''))} title="optional: only the binding visible at this line (else every binding with that name)" />
          <button className="btn sm" onClick={applyRename} disabled={!rFrom || !rTo}>Rename</button>
          {code !== null && <span className="copy-btn" onClick={() => setCode(null)}>Reset renames</span>}
          <span className="small muted">scope-aware, formatting preserved</span>
        </div>
      )}
      <div className="fill">
        {mode === 'clean' && <Editor height="100%" language="lua" theme="prism" path="deob-view.lua" value={shown} options={MONACO_OPTS} />}
        {mode === 'diff' && <DiffEditor height="100%" language="lua" theme="prism" original={original} modified={shown} options={{ ...MONACO_OPTS, renderSideBySide: true }} />}
        {mode === 'renames' && (
          <div className="scroll" style={{ height: '100%' }}>
            <div className="toolbar"><span className="small muted">role-based names given by the rename pass (mode: {draft.rename ?? 'obfuscated'})</span><span className="spacer" />
              <Copy text={renameCsv} label="Copy CSV" /><Copy text={JSON.stringify(clean.renameMap, null, 2)} label="Copy JSON" /></div>
            <table className="data"><thead><tr><th>from</th><th>to</th><th>kind</th><th>line</th></tr></thead>
              <tbody>{clean.renameMap.slice(0, 3000).map((r, i) => <tr key={i}><td>{r.from}</td><td style={{ color: 'var(--ok)' }}>{r.to}</td><td>{r.kind}</td><td><LineLink line={r.line} onClick={l => reveal(l, 1, 'cleaned')} /></td></tr>)}</tbody></table>
          </div>
        )}
        {mode === 'passes' && (
          <div className="cards">
            <div className="card"><div className="card-h"><span className="dot" />Junk-removal passes</div><div className="card-b">
              <div className="row" style={{ marginBottom: 10 }}>
                {PASSES.map(p => <Toggle key={p.k} on={on(p.k)} onChange={v => setDraft({ ...draft, [p.k]: v })} title={p.hint}>{p.label}</Toggle>)}
              </div>
              <div className="row">
                <Field label="rename"><select value={draft.rename ?? 'obfuscated'} onChange={e => setDraft({ ...draft, rename: e.target.value as CleanOptions['rename'] })}>
                  <option value="none">none</option><option value="obfuscated">obfuscated names only</option><option value="all">all locals</option></select></Field>
                <Field label="rounds"><input type="number" min={1} max={12} value={draft.rounds ?? 4} onChange={e => setDraft({ ...draft, rounds: Math.max(1, Math.min(12, Number(e.target.value) || 4)) })} style={{ width: 60 }} /></Field>
                <button className="btn primary sm" onClick={() => { setCode(null); onReclean(draft); setMode('clean'); }}>Re-run cleanup</button>
                <span className="copy-btn" onClick={() => setDraft({ rounds: 4 })}>defaults</span>
              </div>
              <div className="small muted" style={{ marginTop: 10 }}>Every pass is semantics-preserving and purely static. Turn passes off to inspect what a single layer does (e.g. only number/MBA folding first).</div>
            </div></div>
            <Simplifier />
          </div>
        )}
      </div>
    </div>
  );
}

function Simplifier() {
  const [expr, setExpr] = useState('bit32.bxor(0x5A, 0x3C) + (2 ^ 8 - #"abcd") * 3 % 7');
  const [out, setOut] = useState<{ result: string; changed: boolean } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const go = async () => { setErr(null); try { setOut((await engine.op('simplify', '', { expr })).result); } catch (e: any) { setErr(e.message); setOut(null); } };
  return (
    <div className="card"><div className="card-h"><span className="dot" />Expression simplifier<span className="spacer" />{out && <Copy text={out.result} />}</div><div className="card-b">
      <div className="row"><input className="inp" style={{ flex: 1 }} value={expr} onChange={e => setExpr(e.target.value)} onKeyDown={e => e.key === 'Enter' && go()} placeholder="any Lua expression: number/bit32/MBA/string junk" /><button className="btn sm" onClick={go}>Simplify</button></div>
      {out && <div className="code-peek" style={{ color: out.changed ? 'var(--ok)' : 'var(--txt-dim)' }}>{out.result}</div>}
      {err && <div className="small" style={{ color: 'var(--bad)', marginTop: 6 }}>{err}</div>}
    </div></div>
  );
}
