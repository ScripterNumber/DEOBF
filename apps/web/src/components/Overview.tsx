import React from 'react';
import type { FullReport, CleanResult } from '@prism/core';
import { Card, Stat, Copy, formatBytes } from './ui.js';
import { usePrism } from '../ctx.js';
import { BehaviorPanel } from './Behavior.js';

export function Overview({ rep, ms, cleaned }: { rep: FullReport; ms: number; cleaned: CleanResult }) {
  const { goTab, backend, reveal } = usePrism();
  const m = rep.metrics;
  const top = rep.families[0];
  const vm = rep.vm;
  const summary = JSON.stringify({ families: rep.families, metrics: m, vm: vm.dispatchSummary, notes: vm.notes }, null, 2);
  const s = cleaned.stats;
  const cleanedLines = cleaned.code.split('\n').length;
  const steps: Array<{ t: string; d: string; tab: Parameters<typeof goTab>[0] }> = [
    { t: 'Deobfuscate', d: `${s.folded + s.mbaFolded} folds, ${s.charCalls + s.concatChains} strings, ${s.removedStmts + s.removedLocals} junk removed — review the diff, tune passes`, tab: 'cleaned' },
    { t: 'Constants', d: 'find the constant/string decoder and the bytecode deserializer (ranked candidates)', tab: 'constants' },
    ...(vm.isVM ? [{ t: 'Opcode Map', d: `VM detected (${vm.dispatchSummary.map(d => d.kind).join(', ')}) — map handlers to mnemonics, edit and export`, tab: 'opcodes' as const }] : []),
    { t: 'Python', d: 'port the decoder you found to Python and decode statically', tab: 'python' },
    { t: 'Blob Lab', d: 'peel encoded blobs (base64/xor/rc4/zlib/…) and recover keys', tab: 'blob' },
    ...(backend ? [{ t: 'All Tools', d: 'every backend tool (auto_triage, luau_compile, …) with a generated form', tab: 'tools' as const }] : []),
  ];
  return (
    <div className="cards">
      <Card title="Identification" right={<Copy text={summary} label="Copy" />}>
        {top ? (
          <div>
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 12, marginBottom: 10, flexWrap: 'wrap' }}>
              <span style={{ fontSize: 22, fontWeight: 800, color: '#fff', textShadow: '0 0 18px rgba(178,107,255,.6)' }}>{top.family}</span>
              <span className="pill ok">{Math.round(top.confidence * 100)}%</span>
            </div>
            <div className="bar" style={{ marginBottom: 10 }}><i style={{ width: Math.round(top.confidence * 100) + '%' }} /></div>
            <ul style={{ margin: '0 0 0 16px', padding: 0 }}>{top.reasons.map((r, i) => <li key={i} className="small">{r}</li>)}</ul>
            {rep.families.length > 1 && <div className="small muted" style={{ marginTop: 10 }}>Also: {rep.families.slice(1).map(f => f.family + ' (' + Math.round(f.confidence * 100) + '%)').join(', ')}</div>}
          </div>
        ) : <div className="muted">No known signature matched — generic heuristics apply (PRISM is not tied to any obfuscator).</div>}
      </Card>

      <Card title="Suggested next steps">
        <div className="list">
          {steps.map((x, i) => (
            <div key={i} className="li" onClick={() => goTab(x.tab)}><span className="chip hi">{i + 1}</span><b style={{ color: '#fff', minWidth: 96 }}>{x.t}</b><span className="small">{x.d}</span></div>
          ))}
        </div>
      </Card>

      <Card title="Behaviour / IOCs" right={<span className="small muted">static · names + strings + URLs</span>}>
        <BehaviorPanel compact />
      </Card>

      <Card title="Structure">
        <div className="chips">
          <Stat k="size" v={formatBytes(m.bytes)} />
          <Stat k="lines" v={m.lines} />
          <Stat k="tokens" v={m.tokens.toLocaleString()} />
          <Stat k="nodes" v={m.nodes.toLocaleString()} />
          <Stat k="functions" v={m.functions} hi />
          <Stat k="strings" v={m.strings} />
          <Stat k="numbers" v={m.numbers.toLocaleString()} />
          <Stat k="depth" v={m.maxDepth} />
          <Stat k="analyzed" v={ms + 'ms'} />
          <Stat k="cleaned lines" v={cleanedLines.toLocaleString()} hi />
        </div>
        {rep.parseErrors.length > 0 && (
          <div className="small" style={{ marginTop: 8, color: 'var(--warn)' }}>
            {rep.parseErrors.length} parse error(s) — analysis continued with error recovery:{' '}
            {rep.parseErrors.slice(0, 4).map((e, i) => <span key={i}><span className="line-link" onClick={() => reveal(e.line, 1, 'input')}>L{e.line}</span> {e.message}{i < 3 ? '; ' : ''}</span>)}
          </div>
        )}
      </Card>

      <Card title="Luau dialect tells">
        <div className="chips">
          <Stat k="underscore nums" v={m.underscoreNumbers} hi={m.underscoreNumbers > 0} />
          <Stat k="binary 0b" v={m.binaryLiterals} hi={m.binaryLiterals > 0} />
          <Stat k="dup-param fns" v={m.dupParamFns} hi={m.dupParamFns > 0} />
          <Stat k="while-true" v={m.whileTrue} hi={m.whileTrue > 0} />
          <Stat k="long brackets" v={m.longBrackets} />
          <Stat k="return({..})" v={m.tableReturnHead ? 'yes' : 'no'} hi={m.tableReturnHead} />
        </div>
        <div className="small muted" style={{ marginTop: 8 }}>Underscore and binary literals are Luau-only; stock Lua 5.1 rejects them.</div>
      </Card>

      <Card title="Virtual machine" right={<span className={'pill ' + (vm.isVM ? 'ok' : '')}>{vm.isVM ? 'VM detected' : 'no VM'}</span>}>
        <div className="chips" style={{ marginBottom: 10 }}>
          {vm.dispatchSummary.length ? vm.dispatchSummary.map((d, i) => <Stat key={i} k={d.kind} v={'×' + d.count} hi />) : <span className="muted small">no dispatch loop found</span>}
          {vm.trampolines.length > 0 && <Stat k="trampolines" v={vm.trampolines.length} />}
          {vm.opcodeEstimate != null && <Stat k="opcode est." v={'~' + vm.opcodeEstimate} hi />}
          {vm.blobs.length > 0 && <Stat k="blobs" v={vm.blobs.length} />}
          <Stat k="handler clusters" v={vm.handlerClusters.length} />
        </div>
        {vm.notes.map((n, i) => <div key={i} className="small">• {n}</div>)}
      </Card>

      {rep.aliases.length > 0 && (
        <Card title={`Builtin aliases (${rep.aliases.length})`} right={<Copy text={rep.aliases.map(a => `${a.name} = ${a.target}`).join('\n')} />}>
          <div className="chips">{rep.aliases.slice(0, 80).map((a, i) => <span key={i} className="chip">{a.name} <b>{a.target}</b></span>)}</div>
        </Card>
      )}
    </div>
  );
}
