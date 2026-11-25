// PRISM constants finder — universal literal inventory + decoder/deserializer hunting.
//
// * strings: unique literals with count, Shannon entropy, printable ratio and a
//   coarse class (identifier / text / url / base64 / hex / alphabet / binary / blob)
// * numbers: frequency table with tags (byte, large, float, xor-operand, mod-operand ...)
// * arrays: numeric table constructors (byte arrays, key schedules, packed bytecode)
// * decoders: every function scored for string-decryptor / deserializer / bit-helper
//   features, plus its call sites (a function called hundreds of times with literal
//   arguments is almost always the constant decryptor: `w(-46073)`)
// * keys: literal operands of xor / bxor and repeating-key string indexing
import type * as A from '../ast.js';
import { walk } from '../ast.js';
import { bytesToDisplay } from '../lexer.js';
import { analyzeScopes } from './scope.js';

export interface StringConst { value: string; display: string; count: number; len: number; entropy: number; printable: number; kind: string; lines: number[]; }
export interface NumberConst { value: number; raw: string; count: number; lines: number[]; tags: string[]; }
export interface ArrayConst { line: number; pos: number; length: number; min: number; max: number; kind: string; values: number[]; strings?: string[]; avgEntropy?: number; }
export interface DecoderCandidate {
  name: string; line: number; endLine: number; pos: number; endPos?: number; stmts?: number; params: number;
  score: number; kind: string; reasons: string[];
  callSites: number; literalArgCalls: number; sampleCalls: string[];
}
export interface KeyCandidate { value: string; line: number; context: string; }
export interface ConstantsReport {
  summary: { strings: number; uniqueStrings: number; numbers: number; uniqueNumbers: number; arrays: number; decoders: number; bytes: number };
  strings: StringConst[];
  numbers: NumberConst[];
  arrays: ArrayConst[];
  decoders: DecoderCandidate[];
  keys: KeyCandidate[];
}

export function entropy(s: string): number {
  if (!s.length) return 0;
  const f = new Map<number, number>();
  for (let i = 0; i < s.length; i++) { const c = s.charCodeAt(i); f.set(c, (f.get(c) ?? 0) + 1); }
  let h = 0;
  for (const c of f.values()) { const p = c / s.length; h -= p * Math.log2(p); }
  return Math.round(h * 100) / 100;
}
export function printableRatio(s: string): number {
  if (!s.length) return 1;
  let p = 0;
  for (let i = 0; i < s.length; i++) { const c = s.charCodeAt(i); if ((c >= 32 && c < 127) || c === 9 || c === 10 || c === 13 || c >= 128) p++; }
  return Math.round(p / s.length * 100) / 100;
}
const ROBLOX = new Set(['game', 'workspace', 'Players', 'LocalPlayer', 'GetService', 'HttpGet', 'HttpService', 'RunService', 'ReplicatedStorage', 'UserInputService', 'TweenService', 'Instance', 'FindFirstChild', 'WaitForChild', 'Character', 'Humanoid', 'HumanoidRootPart', 'CoreGui', 'StarterGui', 'Heartbeat', 'RenderStepped', 'Connect', 'Destroy', 'Parent', 'Name', 'CFrame', 'Vector3', 'Enum', 'loadstring', 'getfenv', 'setfenv', 'getgenv', 'hookfunction', 'getrawmetatable', 'setreadonly', 'newcclosure', 'syn', 'request', 'http_request', 'identifyexecutor', 'writefile', 'readfile']);

export function classifyString(s: string): string {
  const n = s.length;
  const pr = printableRatio(s);
  if (n >= 4 && /^https?:\/\//i.test(s)) return 'url';
  if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(s)) return ROBLOX.has(s) ? 'api' : 'identifier';
  if (n >= 32) {
    const uniq = new Set(s).size;
    if (uniq >= 32 && uniq === n) return 'alphabet';
  }
  if (n >= 16 && /^[0-9a-fA-F]+$/.test(s) && n % 2 === 0) return 'hex';
  if (n >= 16 && /^[A-Za-z0-9+/_-]+={0,2}$/.test(s) && /[0-9]/.test(s) && /[a-z]/.test(s) && /[A-Z]/.test(s)) return 'base64';
  if (pr < 0.7) return 'binary';
  if (n >= 64 && entropy(s) > 5.2) return 'blob';
  if (n >= 64 && !/\s/.test(s)) return 'blob';
  return 'text';
}

const unparen = (e: any): any => { while (e && e.type === 'ParenExpr') e = e.expr; return e; };
const isLit = (e: any): boolean => { const u = unparen(e); if (!u) return false; if (u.type === 'NumberLit' || u.type === 'StringLit' || u.type === 'NilLit' || u.type === 'TrueLit' || u.type === 'FalseLit') return true; return u.type === 'UnExpr' && u.op === '-' && unparen(u.expr)?.type === 'NumberLit'; };
const litText = (e: any): string => { const u = unparen(e); if (u.type === 'StringLit') return JSON.stringify(bytesToDisplay(u.value)).slice(0, 40); if (u.type === 'NumberLit') return u.raw ?? String(u.value); if (u.type === 'UnExpr') return '-' + litText(u.expr); return u.type.replace('Lit', '').toLowerCase(); };
/** best-effort callee label: name / a.b / a:b */
function calleeName(e: any): string | null {
  const u = unparen(e);
  if (!u) return null;
  if (u.type === 'NameExpr') return u.name;
  if (u.type === 'MemberExpr') { const o = calleeName(u.obj); return o ? o + '.' + u.name : null; }
  if (u.type === 'IndexExpr' && unparen(u.index)?.type === 'StringLit') { const o = calleeName(u.obj); return o ? o + '.' + unparen(u.index).value : null; }
  return null;
}

/** walk without descending into nested function bodies */
function walkOwn(node: any, fn: (n: any) => void) {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) { for (const x of node) walkOwn(x, fn); return; }
  if (typeof node.type === 'string') { fn(node); if (node.type === 'FunctionExpr') return; }
  for (const k of Object.keys(node)) { if (k === 'loc' || k === 'type') continue; const v = node[k]; if (v && typeof v === 'object') walkOwn(v, fn); }
}

interface Feat { stmts: number; byte: number; char: number; sub: number; xor: number; bitops: number; mod256: number; len: number; loops: number; concat: number; tconcat: number; tonumberBase: number; posAdvance: number; newTables: number; gsub: number; ldexp: number; selects: number; stringCompares: number; returnsCall: number; }

function features(body: A.Stat[]): Feat {
  const ft: Feat = { stmts: 0, byte: 0, char: 0, sub: 0, xor: 0, bitops: 0, mod256: 0, len: 0, loops: 0, concat: 0, tconcat: 0, tonumberBase: 0, posAdvance: 0, newTables: 0, gsub: 0, ldexp: 0, selects: 0, stringCompares: 0, returnsCall: 0 };
  walkOwn(body, (n: any) => {
    if (/Stat$/.test(n.type)) ft.stmts++;
    switch (n.type) {
      case 'CallExpr': case 'MethodCallExpr': {
        const nm = n.type === 'MethodCallExpr' ? n.method ?? n.name : calleeName(n.callee ?? n.func);
        const last = (nm ?? '').split('.').pop() ?? '';
        if (last === 'byte') ft.byte++;
        else if (last === 'char') ft.char++;
        else if (last === 'sub') ft.sub++;
        else if (last === 'bxor') ft.xor++;
        else if (['band', 'bor', 'rshift', 'lshift', 'arshift', 'bnot', 'extract', 'replace', 'lrotate', 'rrotate', 'btest'].includes(last)) ft.bitops++;
        else if (last === 'concat') ft.tconcat++;
        else if (last === 'gsub' || last === 'gmatch') ft.gsub++;
        else if (last === 'ldexp' || last === 'frexp') ft.ldexp++;
        else if (last === 'select') ft.selects++;
        else if (last === 'tonumber' && (n.args?.length ?? 0) >= 2) ft.tonumberBase++;
        break;
      }
      case 'BinExpr': {
        if (n.op === '~') ft.xor++;
        else if (['&', '|', '<<', '>>'].includes(n.op)) ft.bitops++;
        else if (n.op === '%') { const r = unparen(n.right); if (r?.type === 'NumberLit' && [256, 65536, 4294967296, 2 ** 53].includes(r.value)) ft.mod256++; }
        else if (n.op === '..') ft.concat++;
        else if ((n.op === '==' || n.op === '~=') && (unparen(n.right)?.type === 'StringLit' || unparen(n.left)?.type === 'StringLit')) ft.stringCompares++;
        break;
      }
      case 'UnExpr': if (n.op === '#') ft.len++; else if (n.op === '~') ft.bitops++; break;
      case 'WhileStat': case 'RepeatStat': case 'NumericForStat': case 'GenericForStat': ft.loops++; break;
      case 'TableExpr': ft.newTables++; break;
      case 'AssignStat': {
        if (n.targets.length === 1 && n.targets[0].type === 'NameExpr') {
          const v = unparen(n.values[0]);
          if (n.op === '+' || (v?.type === 'BinExpr' && v.op === '+' && unparen(v.left)?.type === 'NameExpr' && unparen(v.left).name === n.targets[0].name)) ft.posAdvance++;
        }
        break;
      }
      case 'ReturnStat': if (n.args?.length === 1 && ['CallExpr', 'MethodCallExpr'].includes(unparen(n.args[0])?.type)) ft.returnsCall++; break;
    }
  });
  return ft;
}

function scoreFn(ft: Feat, literalCalls: number, calls: number, params: number): { score: number; kind: string; reasons: string[] } {
  const r: string[] = [];
  let dec = 0, des = 0, bit = 0;
  if (ft.byte) { dec += 2 + Math.min(ft.byte, 4); des += 2 + Math.min(ft.byte, 6); r.push(`string.byte×${ft.byte}`); }
  if (ft.char) { dec += 3 + Math.min(ft.char, 3); r.push(`string.char×${ft.char}`); }
  if (ft.sub) { dec += 1; des += 2 + Math.min(ft.sub, 4); r.push(`string.sub×${ft.sub}`); }
  if (ft.xor) { dec += 4 + Math.min(ft.xor, 4); bit += 3; r.push(`xor×${ft.xor}`); }
  if (ft.bitops) { bit += 2 + Math.min(ft.bitops, 6); des += Math.min(ft.bitops, 4); r.push(`bitops×${ft.bitops}`); }
  if (ft.mod256) { dec += 3; bit += 3; r.push(`% 256-style×${ft.mod256}`); }
  if (ft.len) { dec += 1; des += 1; r.push(`#len×${ft.len}`); }
  if (ft.loops) { dec += 2; des += 2 + Math.min(ft.loops, 4); r.push(`loops×${ft.loops}`); }
  if (ft.tconcat) { dec += 2; r.push('table.concat'); }
  if (ft.concat) { dec += 1; }
  if (ft.tonumberBase) { dec += 3; des += 2; r.push(`tonumber(x, base)×${ft.tonumberBase}`); }
  if (ft.gsub) { dec += 2; r.push(`gsub/gmatch×${ft.gsub}`); }
  if (ft.ldexp) { des += 4; r.push('ldexp/frexp (float decode)'); }
  if (ft.posAdvance) { des += Math.min(ft.posAdvance, 6); r.push(`counter advance×${ft.posAdvance}`); }
  if (ft.newTables >= 2) { des += Math.min(ft.newTables, 5); r.push(`table builds×${ft.newTables}`); }
  if (ft.stringCompares >= 3) { des += 2; r.push(`type-tag compares×${ft.stringCompares}`); }
  let acc = 0;
  if (literalCalls >= 3) { acc = Math.min(16, 4 + Math.log2(literalCalls) * 2); dec += acc; r.unshift(`called ${literalCalls}× with literal args`); }
  else if (calls) r.push(`${calls} call site(s)`);
  let kind = 'helper', score = Math.max(dec, des, bit);
  if (literalCalls >= 8 && ft.stmts <= 4 && dec - acc < 4) { kind = 'constant-accessor'; score = acc + 2; r.push('tiny body: pool lookup / offset accessor'); }
  else if (des >= dec && des >= bit && des >= 8) kind = 'deserializer';
  else if (dec >= bit && dec >= 6) kind = literalCalls >= 3 && params <= 3 ? 'constant-decryptor' : 'string-decoder';
  else if (bit >= 5) kind = 'bit-helper';
  // huge wrapper functions (whole-program closures) are rarely the decoder itself
  if (ft.stmts > 1500) { score *= 0.3; r.push(`large (${ft.stmts} stmts)`); }
  else if (ft.stmts > 400) { score *= 0.6; r.push(`large (${ft.stmts} stmts)`); }
  return { score: Math.round(score * 10) / 10, kind, reasons: r };
}

export function findConstants(chunk: A.Chunk, opts: { maxStrings?: number; maxNumbers?: number; maxArrays?: number; maxDecoders?: number } = {}): ConstantsReport {
  const strMap = new Map<string, StringConst>();
  const numMap = new Map<string, NumberConst>();
  const arrays: ArrayConst[] = [];
  const keys: KeyCandidate[] = [];
  let totalStr = 0, totalNum = 0, bytes = 0;
  const xorOperands = new Set<number>(), modOperands = new Set<number>();
  const pushLine = (arr: number[], l: number) => { if (arr.length < 12 && arr[arr.length - 1] !== l) arr.push(l); };

  walk(chunk, (n: any) => {
    if (n.type === 'StringLit') {
      totalStr++; bytes += n.value.length;
      let s = strMap.get(n.value);
      if (!s) { s = { value: n.value, display: bytesToDisplay(n.value), count: 0, len: n.value.length, entropy: entropy(n.value), printable: printableRatio(n.value), kind: classifyString(n.value), lines: [] }; strMap.set(n.value, s); }
      s.count++; pushLine(s.lines, n.loc?.line ?? 0);
    } else if (n.type === 'NumberLit') {
      totalNum++;
      const key = String(n.value);
      let c = numMap.get(key);
      if (!c) { c = { value: n.value, raw: n.raw ?? key, count: 0, lines: [], tags: [] }; numMap.set(key, c); }
      c.count++; pushLine(c.lines, n.loc?.line ?? 0);
    } else if (n.type === 'BinExpr') {
      const r = unparen(n.right), l = unparen(n.left);
      if (n.op === '~') { for (const x of [l, r]) if (x?.type === 'NumberLit') { xorOperands.add(x.value); keys.push({ value: x.raw ?? String(x.value), line: n.loc?.line ?? 0, context: 'x ~ K' }); } }
      if (n.op === '%' && r?.type === 'NumberLit') modOperands.add(r.value);
    } else if (n.type === 'CallExpr') {
      const nm = calleeName(n.callee ?? n.func) ?? '';
      if (/(^|\.)bxor$/.test(nm)) for (const a of n.args ?? []) { const u = unparen(a); if (u?.type === 'NumberLit') { xorOperands.add(u.value); keys.push({ value: u.raw ?? String(u.value), line: n.loc?.line ?? 0, context: nm + '(x, K)' }); } }
    } else if (n.type === 'TableExpr') {
      const items = (n.fields ?? []).filter((f: any) => f.kind === 'item');
      if (items.length >= 16 && items.length >= n.fields.length * 0.9 && items.every((f: any) => unparen(f.value)?.type === 'StringLit')) {
        const vals: string[] = items.map((f: any) => unparen(f.value).value);
        const ent = Math.round(vals.reduce((a, v) => a + entropy(v), 0) / vals.length * 100) / 100;
        arrays.push({ line: n.loc?.line ?? 0, pos: n.loc?.start ?? 0, length: vals.length, min: Math.min(...vals.map(v => v.length)), max: Math.max(...vals.map(v => v.length)), kind: 'string-pool', values: [], strings: vals.slice(0, 2000).map(bytesToDisplay), avgEntropy: ent } as ArrayConst);
        return;
      }
      if (items.length >= 8 && items.length === n.fields.length) {
        const vals: number[] = [];
        for (const f of items) { const u = unparen(f.value); if (u?.type === 'NumberLit') vals.push(u.value); else if (u?.type === 'UnExpr' && u.op === '-' && unparen(u.expr)?.type === 'NumberLit') vals.push(-unparen(u.expr).value); else return; }
        let min = Infinity, max = -Infinity; for (const v of vals) { if (v < min) min = v; if (v > max) max = v; }
        const ints = vals.every(v => Number.isInteger(v));
        const kind = ints && min >= 0 && max <= 255 ? 'bytes' : ints && min >= 0 && max < 2 ** 32 ? 'u32' : ints ? 'ints' : 'floats';
        arrays.push({ line: n.loc?.line ?? 0, pos: n.loc?.start ?? 0, length: vals.length, min, max, kind, values: vals.slice(0, 4096) });
      }
    }
  });
  // repeating-key indexing:  key:byte(i % #key + 1)  /  string.byte(key, (i - 1) % #key + 1)
  walk(chunk, (n: any) => {
    if (n.type !== 'BinExpr' || n.op !== '%') return;
    const r = unparen(n.right);
    if (r?.type === 'UnExpr' && r.op === '#' && unparen(r.expr)?.type === 'NameExpr') keys.push({ value: '#' + unparen(r.expr).name, line: n.loc?.line ?? 0, context: 'repeating key index (i % #key)' });
  });

  for (const c of numMap.values()) {
    const v = c.value;
    if (Number.isInteger(v) && v >= 0 && v <= 255) c.tags.push('byte');
    if (Math.abs(v) >= 65536) c.tags.push('large');
    if (!Number.isInteger(v)) c.tags.push('float');
    if (v < 0) c.tags.push('negative');
    if (Number.isInteger(v) && v > 1 && (v & (v - 1)) === 0 && v <= 2 ** 31) c.tags.push('pow2');
    if (/^0x/i.test(c.raw)) c.tags.push('hex');
    if (xorOperands.has(v)) c.tags.push('xor-operand');
    if (modOperands.has(v)) c.tags.push('mod-operand');
  }

  // decoder candidates
  const sc = analyzeScopes(chunk);
  const fnName = new Map<A.FunctionExpr, string>();
  const callStats = new Map<A.FunctionExpr, { calls: number; literal: number; samples: string[] }>();
  for (const b of sc.bindings) {
    let f: A.FunctionExpr | undefined;
    if (b.kind === 'localfn') f = (b.decl as A.LocalFunctionStat).func;
    else if (b.kind === 'local' && b.init && unparen(b.init).type === 'FunctionExpr' && b.writes === 0) f = unparen(b.init);
    if (!f) continue;
    fnName.set(f, b.name);
    const st = { calls: 0, literal: 0, samples: [] as string[] };
    for (const ref of b.refs) callStats.set(f, st);
    callStats.set(f, st);
  }
  const callee2fn = new Map<A.NameExpr, A.FunctionExpr>();
  for (const b of sc.bindings) {
    const f = b.kind === 'localfn' ? (b.decl as A.LocalFunctionStat).func : (b.kind === 'local' && b.init && unparen(b.init).type === 'FunctionExpr' && b.writes === 0 ? unparen(b.init) : undefined);
    if (f) for (const ref of b.refs) callee2fn.set(ref, f);
  }
  walk(chunk, (n: any) => {
    if (n.type === 'FunctionStat') { const nm = calleeName(n.target); if (nm && !fnName.has(n.func)) fnName.set(n.func, nm); }
    if (n.type !== 'CallExpr') return;
    const c = unparen(n.callee ?? n.func);
    const f = c?.type === 'NameExpr' ? callee2fn.get(c) : undefined;
    if (!f) return;
    const st = callStats.get(f)!;
    st.calls++;
    const args = n.args ?? [];
    if (args.length && args.every(isLit)) { st.literal++; if (st.samples.length < 6) st.samples.push(`${c.name}(${args.map(litText).join(', ')})  -- L${n.loc?.line ?? 0}`); }
  });
  const decoders: DecoderCandidate[] = [];
  walk(chunk, (n: any) => {
    if (n.type === 'FunctionExpr') {
      const f = n as A.FunctionExpr;
      const ft = features(f.body);
      const st = callStats.get(f) ?? { calls: 0, literal: 0, samples: [] };
      const { score, kind, reasons } = scoreFn(ft, st.literal, st.calls, f.params.length);
      if (score < 6) return;
      decoders.push({ name: fnName.get(f) ?? '<anonymous>', line: f.loc?.line ?? 0, endLine: f.loc?.endLine ?? 0, pos: f.loc?.start ?? 0, endPos: f.loc?.end ?? 0, stmts: ft.stmts, params: f.params.length, score, kind, reasons, callSites: st.calls, literalArgCalls: st.literal, sampleCalls: st.samples });
    } else if (n.type === 'NumericForStat' || n.type === 'GenericForStat' || n.type === 'WhileStat' || n.type === 'RepeatStat') {
      // inline decode loops (constant pools decoded in place, no dedicated function)
      const ft = features(n.body);
      if (ft.stmts > 400) return;
      const { score, kind, reasons } = scoreFn(ft, 0, 0, 0);
      if (score < 9 || kind === 'helper') return;
      decoders.push({ name: '<loop L' + (n.loc?.line ?? 0) + '>', line: n.loc?.line ?? 0, endLine: 0, pos: n.loc?.start ?? 0, params: 0, score: Math.round(score * 0.9 * 10) / 10, kind: kind === 'deserializer' ? 'decode-loop' : kind === 'bit-helper' ? 'bit-loop' : 'decode-loop', reasons, callSites: 0, literalArgCalls: 0, sampleCalls: [] });
    }
  });
  // drop loops nested in a function already reported with a higher score
  const fnCands = decoders.filter(d => !d.name.startsWith('<loop'));
  for (let i = decoders.length - 1; i >= 0; i--) {
    const d = decoders[i];
    if (!d.name.startsWith('<loop')) continue;
    if (fnCands.some(f => f.pos <= d.pos && (f.endPos ?? 0) >= d.pos && f.score >= d.score && f.kind !== 'constant-accessor' && (f.stmts ?? 0) <= 25)) decoders.splice(i, 1);
  }
  decoders.sort((a, b) => b.score - a.score);

  const strings = [...strMap.values()].sort((a, b) => (b.len * (b.kind === 'blob' || b.kind === 'binary' ? 4 : 1)) - (a.len * (a.kind === 'blob' || a.kind === 'binary' ? 4 : 1)) || b.count - a.count);
  const numbers = [...numMap.values()].sort((a, b) => b.count - a.count);
  arrays.sort((a, b) => b.length - a.length);
  const ms = opts.maxStrings ?? 2000, mn = opts.maxNumbers ?? 2000, ma = opts.maxArrays ?? 200, md = opts.maxDecoders ?? 60;
  const seenK = new Set<string>(); const uk = keys.filter(k => { const id = k.value + '|' + k.context; if (seenK.has(id)) return false; seenK.add(id); return true; }).slice(0, 200);
  return {
    summary: { strings: totalStr, uniqueStrings: strMap.size, numbers: totalNum, uniqueNumbers: numMap.size, arrays: arrays.length, decoders: decoders.length, bytes },
    strings: strings.slice(0, ms), numbers: numbers.slice(0, mn), arrays: arrays.slice(0, ma), decoders: decoders.slice(0, md), keys: uk,
  };
}
