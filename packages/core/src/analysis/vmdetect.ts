// PRISM VM / control-flow-flattening detector.
// Implements static heuristics distilled from real deobfuscation work:
//  - classic table VM:  handlers[opcode](...)   (dispatch table)
//  - CFF state machine:  while true do if STATE==x .. elseif STATE==y ..  with STATE=<next>
//  - bytecode blob discovery + byte histogram (#distinct bytes ~ #opcodes)
//  - handler inventory with CFG-shape hashing for semantic clustering
import type * as A from '../ast.js';
import { walk } from '../ast.js';

export interface DispatchSite {
  kind: 'table-dispatch' | 'cff-state-machine' | 'computed-goto';
  line: number;
  detail: string;
  stateVar?: string;
  cases?: number;
}

export interface BlobInfo {
  kind: 'numeric-array' | 'long-string' | 'string-literal';
  line: number;
  length: number;
  distinctBytes?: number;
  histogram?: Array<{ byte: number; count: number }>;
  preview: string;
}

export interface HandlerCluster { shapeHash: string; members: number[]; representativeLine: number; sketch: string; }

export interface VMReport {
  isVM: boolean;
  dispatch: DispatchSite[];
  dispatchSummary: Array<{ kind: DispatchSite['kind']; count: number; firstLine: number }>;
  trampolines: Array<{ line: number; detail: string }>;
  blobs: BlobInfo[];
  opcodeEstimate: number | null;
  handlerClusters: HandlerCluster[];
  notes: string[];
}

export function detectVM(chunk: A.Chunk): VMReport {
  const dispatch: DispatchSite[] = [];
  const trampolines: Array<{ line: number; detail: string }> = [];
  const blobs: BlobInfo[] = [];
  const notes: string[] = [];

  // ---- 1. dispatch detection ----
  walk(chunk, (n) => {
    // table dispatch: call where callee is Index/Member on a name, index is a var/arith
    if (n.type === 'CallExpr' && (n.callee.type === 'IndexExpr')) {
      const idx = n.callee.index;
      if (idx.type === 'NameExpr' || idx.type === 'BinExpr' || idx.type === 'CallExpr') {
        // looks like handlers[op](...)
        dispatch.push({ kind: 'table-dispatch', line: n.loc?.line ?? 0, detail: 'T[expr](...) indexed call (opcode handler table)' });
      }
    }
  });

  // CFF: while true do ... with an if/elseif chain comparing a state var to constants,
  // and assignments `state = <const>` inside.
  walk(chunk, (n) => {
    if (n.type === 'WhileStat' && n.cond?.type === 'TrueLit') {
      const info = analyzeCFFLoop(n);
      if (info) dispatch.push(info);
      else trampolines.push({ line: n.loc?.line ?? 0, detail: 'while true do (dispatch/trampoline loop)' });
    }
    if (n.type === 'RepeatStat') {
      // repeat ... until false is also a trampoline
      if (n.cond?.type === 'FalseLit') trampolines.push({ line: n.loc?.line ?? 0, detail: 'repeat .. until false (trampoline)' });
    }
  });

  // computed goto trampoline: `local f = entry; while f do f = f(...) end`
  walk(chunk, (n) => {
    if (n.type === 'WhileStat' && n.cond?.type === 'NameExpr') {
      for (const s of n.body) {
        if (s.type === 'AssignStat' && s.targets[0]?.type === 'NameExpr' && s.targets[0].name === n.cond.name &&
            s.values[0]?.type === 'CallExpr') {
          dispatch.push({ kind: 'computed-goto', line: n.loc?.line ?? 0, detail: 'while f do f = f(...) continuation trampoline', stateVar: n.cond.name });
        }
      }
    }
  });

  // ---- 2. bytecode blob discovery ----
  walk(chunk, (n) => {
    if (n.type === 'TableExpr' && n.fields.length >= 32) {
      let allNum = true, cnt = 0;
      const bytes: number[] = [];
      for (const f of n.fields) {
        if (f.kind === 'item' && f.value.type === 'NumberLit') { cnt++; if (bytes.length < 100000) bytes.push(f.value.value & 0xff); }
        else { allNum = false; break; }
      }
      if (allNum && cnt >= 32) {
        const { distinct, histogram } = histo(bytes);
        blobs.push({
          kind: 'numeric-array', line: n.loc?.line ?? 0, length: cnt,
          distinctBytes: distinct, histogram,
          preview: bytes.slice(0, 16).join(','),
        });
      }
    }
    if (n.type === 'StringLit' && n.value.length >= 256) {
      const bytes: number[] = [];
      for (let i = 0; i < n.value.length && i < 100000; i++) bytes.push(n.value.charCodeAt(i) & 0xff);
      const { distinct, histogram } = histo(bytes);
      blobs.push({
        kind: n.long ? 'long-string' : 'string-literal', line: n.loc?.line ?? 0, length: n.value.length,
        distinctBytes: distinct, histogram, preview: n.value.slice(0, 24).replace(/[^\x20-\x7e]/g, '.'),
      });
    }
  });

  // ---- 3. opcode estimate from the dominant blob ----
  let opcodeEstimate: number | null = null;
  const best = blobs.slice().sort((a, b) => (b.length) - (a.length))[0];
  if (best && best.distinctBytes) {
    opcodeEstimate = best.distinctBytes;
    notes.push(`dominant blob @L${best.line}: ${best.length} units, ${best.distinctBytes} distinct byte values (~opcode count upper bound)`);
  }

  // ---- 4. handler clustering by CFG-shape hash ----
  const handlerClusters = clusterHandlers(chunk);

  // aggregate dispatch by kind so the report stays compact (hundreds of indexed
  // calls collapse into one summary line per kind, keeping only a few examples).
  const summaryMap = new Map<DispatchSite['kind'], { count: number; firstLine: number }>();
  for (const d of dispatch) {
    const cur = summaryMap.get(d.kind);
    if (cur) cur.count++;
    else summaryMap.set(d.kind, { count: 1, firstLine: d.line });
  }
  const dispatchSummary = [...summaryMap.entries()].map(([kind, v]) => ({ kind, count: v.count, firstLine: v.firstLine }));
  // keep a bounded, representative set of concrete sites (state machines are most
  // interesting individually; cap each kind at a handful)
  const keep: DispatchSite[] = [];
  const perKind = new Map<string, number>();
  for (const d of dispatch.sort((a, b) => (b.cases ?? 0) - (a.cases ?? 0))) {
    const c = perKind.get(d.kind) ?? 0;
    const cap = d.kind === 'cff-state-machine' ? 12 : 4;
    if (c < cap) { keep.push(d); perKind.set(d.kind, c + 1); }
  }

  const isVM = dispatch.length > 0 || trampolines.length > 0 || (!!best && best.length > 200);
  if (dispatch.some(d => d.kind === 'cff-state-machine')) notes.push('control-flow flattening (state-machine) detected');
  if (dispatch.some(d => d.kind === 'table-dispatch')) notes.push('table-based opcode dispatch detected');
  if (dispatch.some(d => d.kind === 'computed-goto')) notes.push('continuation-passing trampoline detected');

  return { isVM, dispatch: keep, dispatchSummary, trampolines, blobs, opcodeEstimate, handlerClusters, notes };
}

function analyzeCFFLoop(w: A.WhileStat): DispatchSite | null {
  // find an if-chain comparing a single var to numeric constants
  let stateVar: string | null = null;
  let cases = 0;
  function scanIf(s: A.IfStat) {
    for (const c of s.clauses) {
      const v = comparedVar(c.cond);
      if (v) { if (!stateVar) stateVar = v.name; if (v.name === stateVar) cases++; }
    }
  }
  for (const s of w.body) {
    if (s.type === 'IfStat') scanIf(s);
  }
  // also detect state reassignment
  let reassigned = false;
  walk(w, (n) => {
    if (n.type === 'AssignStat' && stateVar && n.targets[0]?.type === 'NameExpr' && n.targets[0].name === stateVar) reassigned = true;
  });
  if (stateVar && cases >= 2) {
    return { kind: 'cff-state-machine', line: w.loc?.line ?? 0, detail: `if-chain on '${stateVar}'${reassigned ? ' with state reassignment' : ''}`, stateVar, cases };
  }
  return null;
}

function comparedVar(cond: A.Expr): A.NameExpr | null {
  if (cond.type === 'BinExpr' && (cond.op === '==' || cond.op === '<' || cond.op === '>' || cond.op === '<=' || cond.op === '>=' || cond.op === '~=')) {
    if (cond.left.type === 'NameExpr' && cond.right.type === 'NumberLit') return cond.left;
    if (cond.right.type === 'NameExpr' && cond.left.type === 'NumberLit') return cond.right;
  }
  if (cond.type === 'BinExpr' && (cond.op === 'and' || cond.op === 'or')) {
    return comparedVar(cond.left) || comparedVar(cond.right);
  }
  return null;
}

function histo(bytes: number[]): { distinct: number; histogram: Array<{ byte: number; count: number }> } {
  const counts = new Array(256).fill(0);
  for (const b of bytes) counts[b & 0xff]++;
  let distinct = 0;
  const histogram: Array<{ byte: number; count: number }> = [];
  for (let i = 0; i < 256; i++) if (counts[i]) { distinct++; histogram.push({ byte: i, count: counts[i] }); }
  histogram.sort((a, b) => b.count - a.count);
  return { distinct, histogram: histogram.slice(0, 40) };
}

// Hash each function by the shape of its control-flow / statement skeleton.
// Same hash => same semantic family (per the clustering technique).
function clusterHandlers(chunk: A.Chunk): HandlerCluster[] {
  const fns: Array<{ line: number; shape: string }> = [];
  walk(chunk, (n) => {
    if (n.type === 'FunctionExpr') fns.push({ line: n.loc?.line ?? 0, shape: shapeOf(n.body) });
  });
  const map = new Map<string, number[]>();
  const lineOf = new Map<string, number>();
  const sketchOf = new Map<string, string>();
  fns.forEach((f, i) => {
    if (!map.has(f.shape)) { map.set(f.shape, []); lineOf.set(f.shape, f.line); sketchOf.set(f.shape, f.shape.slice(0, 60)); }
    map.get(f.shape)!.push(i);
  });
  const clusters: HandlerCluster[] = [];
  for (const [shape, members] of map) {
    clusters.push({ shapeHash: hash32(shape), members, representativeLine: lineOf.get(shape) ?? 0, sketch: sketchOf.get(shape) ?? '' });
  }
  clusters.sort((a, b) => b.members.length - a.members.length);
  return clusters;
}

function shapeOf(body: A.Stat[]): string {
  // compact skeleton string of statement/control structure (ignores names & literals)
  const parts: string[] = [];
  for (const s of body) parts.push(stmtShape(s));
  return parts.join(',');
}
function stmtShape(s: A.Stat): string {
  switch (s.type) {
    case 'IfStat': return 'I(' + s.clauses.map(c => shapeOf(c.body)).join('|') + (s.elseBody ? ';' + shapeOf(s.elseBody) : '') + ')';
    case 'WhileStat': return 'W(' + shapeOf(s.body) + ')';
    case 'RepeatStat': return 'R(' + shapeOf(s.body) + ')';
    case 'NumericForStat': case 'GenericForStat': return 'F(' + shapeOf((s as any).body) + ')';
    case 'DoStat': return 'D(' + shapeOf(s.body) + ')';
    case 'LocalStat': return 'l' + s.names.length;
    case 'AssignStat': return 'a' + s.targets.length;
    case 'CallStat': return 'c';
    case 'ReturnStat': return 'r' + s.args.length;
    case 'BreakStat': return 'b';
    case 'ContinueStat': return 'k';
    case 'GotoStat': return 'g';
    case 'LabelStat': return 'L';
    default: return '?';
  }
}
function hash32(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return (h >>> 0).toString(16).padStart(8, '0');
}