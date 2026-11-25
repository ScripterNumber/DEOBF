// VM anatomy — one static map of how an obfuscated script boots, runs and exits, for ANY obfuscator:
//   payload blob → its consumer → deserializer → closure factory ("wrap") → interpreter function →
//   dispatch loop → instruction fetch → handlers → exits (RETURN) / closure creation / env access → entry call,
// plus a ranked inventory of the main chunks (functions) with the roles they play.
// Purely structural (AST + scope + the generic dispatch-tree extractor); nothing is executed.
import type * as A from '../ast.js';
import { walk } from '../ast.js';
import { print } from '../printer.js';
import { analyzeScopes, type Binding, type ScopeInfo } from './scope.js';
import { extractOpcodes, type DispatchTree } from './opcodes.js';
import { findConstants, type DecoderCandidate } from './constants.js';

export interface AnatomyPart {
  role: 'payload' | 'payload-consumer' | 'deserializer' | 'string-decoder' | 'wrapper' | 'interpreter' | 'dispatch-loop' | 'fetch' | 'pc-advance' | 'dispatch' | 'exit' | 'closure' | 'env' | 'varargs' | 'entry' | 'cff-entry' | 'cff-exit';
  name?: string;
  line: number;
  endLine?: number;
  pos?: number;
  detail: string;
  code?: string;
}
export interface ChunkInfo { id: number; name: string; line: number; endLine: number; pos: number; size: number; callers: number; refs: number; roles: string[]; parent?: string; params: string; }
export interface VmAnatomy {
  kind: 'vm' | 'cff' | 'plain';
  pipeline: string[];
  parts: AnatomyPart[];
  chunks: ChunkInfo[];
  tree?: { id: number; line: number; var: string; kind: string; handlers: number; minOp: number; maxOp: number; roles: DispatchTree['roles'] };
  notes: string[];
}

interface Fn { id: number; f: A.FunctionExpr; name: string; line: number; endLine: number; start: number; end: number; parent: Fn | null; binding?: Binding; gname?: string; size: number; calls: number; refs: number; roles: Set<string>; }

const unparen = (e: any): any => { while (e && e.type === 'ParenExpr') e = e.expr; return e; };
const short = (s: string, n = 160) => { const t = s.replace(/\s+/g, ' ').trim(); return t.length > n ? t.slice(0, n - 1) + '…' : t; };
const code = (n: any, max = 160) => { try { return short(print(n as any), max); } catch { return ''; } };
const posOf = (n: any) => n?.loc?.start ?? 0;
/** statement locs only cover their first token — compute real extents from the subtree */
function makeSpan() {
  const cache = new Map<any, { start: number; end: number; endLine: number }>();
  const span = (n: any): { start: number; end: number; endLine: number } => {
    const hit = cache.get(n); if (hit) return hit;
    let start = n?.loc?.start ?? Infinity, end = n?.loc?.end ?? -1, endLine = n?.loc?.endLine ?? n?.loc?.line ?? 0;
    const sub = (v: any) => {
      if (!v || typeof v !== 'object') return;
      if (Array.isArray(v)) { v.forEach(sub); return; }
      if (typeof v.type === 'string') { const c = span(v); if (c.start < start) start = c.start; if (c.end > end) end = c.end; if (c.endLine > endLine) endLine = c.endLine; return; }
      for (const k of Object.keys(v)) if (k !== 'loc') sub(v[k]);
    };
    for (const k of Object.keys(n ?? {})) if (k !== 'loc') sub(n[k]);
    const r = { start, end, endLine };
    cache.set(n, r);
    return r;
  };
  return span;
}
const lineOf = (n: any) => n?.loc?.line ?? 0;

export function vmAnatomy(chunk: A.Chunk, opts: { maxChunks?: number } = {}): VmAnatomy {
  const sc: ScopeInfo = analyzeScopes(chunk);
  const span = makeSpan();
  const notes: string[] = [];
  const parts: AnatomyPart[] = [];

  // ---------------------------------------------------------------- function index
  const bindsByDecl = new Map<any, Binding[]>();
  for (const b of sc.bindings) if (b.kind !== 'global') { const l = bindsByDecl.get(b.decl) ?? []; l.push(b); bindsByDecl.set(b.decl, l); }
  const fns: Fn[] = [];
  const byExpr = new Map<A.FunctionExpr, Fn>();
  const declOf = new Map<A.FunctionExpr, { stat: any }>();
  walk(chunk, (n, parent) => {
    if (n.type === 'LocalFunctionStat' || n.type === 'FunctionStat') declOf.set(n.func, { stat: n });
    if (n.type === 'LocalStat') n.init.forEach((e: any, i: number) => { const u = unparen(e); if (u?.type === 'FunctionExpr' && n.names[i]) declOf.set(u, { stat: { type: 'LocalStat', idx: i, n } }); });
    if (n.type === 'AssignStat') n.targets.forEach((t: any, i: number) => { const u = unparen(n.values[i]); if (u?.type === 'FunctionExpr') declOf.set(u, { stat: { type: 'AssignStat', target: t } }); });
    void parent;
  });
  const stack: Fn[] = [];
  const visit = (n: any) => {
    if (!n || typeof n !== 'object') return;
    if (Array.isArray(n)) { n.forEach(visit); return; }
    let pushed = false;
    if (n.type === 'FunctionExpr') {
      const d = declOf.get(n)?.stat;
      let name = '', binding: Binding | undefined, gname: string | undefined;
      if (d?.type === 'LocalFunctionStat') { name = d.name; binding = bindsByDecl.get(d)?.[0]; }
      else if (d?.type === 'FunctionStat') { name = code(d.target, 60); if (d.target.type === 'NameExpr') { const b = sc.refOf.get(d.target); if (b && b.kind !== 'global') binding = b; else gname = d.target.name; } }
      else if (d?.type === 'LocalStat') { name = d.n.names[d.idx]; binding = bindsByDecl.get(d.n)?.find(b => b.index === d.idx); }
      else if (d?.type === 'AssignStat') { name = code(d.target, 60); if (d.target.type === 'NameExpr') { const b = sc.refOf.get(d.target); if (b && b.kind !== 'global') binding = b; else gname = d.target.name; } }
      const fn: Fn = { id: fns.length, f: n, name: name || `<fn@L${lineOf(n)}>`, line: lineOf(n), endLine: n.loc?.endLine ?? lineOf(n), start: posOf(n), end: n.loc?.end ?? posOf(n), parent: stack[stack.length - 1] ?? null, binding, gname, size: 0, calls: 0, refs: 0, roles: new Set() };
      fns.push(fn); byExpr.set(n, fn); stack.push(fn); pushed = true;
    }
    if (typeof n.type === 'string') for (const f of stack) f.size++;
    for (const k of Object.keys(n)) if (k !== 'loc') visit(n[k]);
    if (pushed) stack.pop();
  };
  visit(chunk);

  // resolve a callee expression to one of our functions
  const fnOfBinding = new Map<Binding, Fn>();
  for (const f of fns) if (f.binding) fnOfBinding.set(f.binding, f);
  const fnOfGlobal = new Map<string, Fn>();
  for (const f of fns) if (f.gname) fnOfGlobal.set(f.gname, f);
  const resolve = (callee: any): Fn | undefined => {
    const u = unparen(callee);
    if (!u) return undefined;
    if (u.type === 'FunctionExpr') return byExpr.get(u);
    if (u.type === 'NameExpr') { const b = sc.refOf.get(u); if (b && b.kind !== 'global') return fnOfBinding.get(b); return fnOfGlobal.get(u.name); }
    return undefined;
  };
  const callsOf = new Map<Fn, any[]>();
  walk(chunk, n => {
    if (n.type === 'CallExpr') { const f = resolve(n.callee); if (f) { f.calls++; const l = callsOf.get(f) ?? []; l.push(n); callsOf.set(f, l); } }
    if (n.type === 'NameExpr') { const b = sc.refOf.get(n); const f = b && b.kind !== 'global' ? fnOfBinding.get(b) : fnOfGlobal.get(n.name); if (f) f.refs++; }
  });
  const innermost = (pos: number): Fn | undefined => { let best: Fn | undefined; for (const f of fns) if (f.start <= pos && pos <= f.end && (!best || f.end - f.start < best.end - best.start)) best = f; return best; };
  const inside = (f: Fn, n: any) => posOf(n) >= f.start && posOf(n) <= f.end;
  const fnLabel = (f?: Fn) => f ? `${f.name} (L${f.line}${f.endLine !== f.line ? '–' + f.endLine : ''})` : '?';

  // ---------------------------------------------------------------- constants / decoders
  let decoders: DecoderCandidate[] = [];
  try { decoders = findConstants(chunk, { maxDecoders: 20, maxStrings: 50, maxNumbers: 10, maxArrays: 10 }).decoders; } catch (e) { notes.push('constant finder failed: ' + (e as Error).message); }
  const fnAtDecoder = (d: DecoderCandidate) => fns.find(f => f.start === d.pos) ?? innermost(d.pos);
  for (const d of decoders) { const f = fnAtDecoder(d); if (f && f.line === d.line) f.roles.add(d.kind); }

  // ---------------------------------------------------------------- payload blob
  let blob: { n: A.StringLit; len: number } | undefined;
  walk(chunk, n => { if (n.type === 'StringLit' && n.value.length >= 256 && (!blob || n.value.length > blob.len)) blob = { n, len: n.value.length }; });
  let payloadFn: Fn | undefined;
  if (blob) {
    // consumer: a call taking the literal (directly or through a local) as an argument
    let consumer: any;
    walk(chunk, n => { if (!consumer && n.type === 'CallExpr' && n.args.some((a: any) => unparen(a) === blob!.n)) consumer = n; });
    if (!consumer) {
      const holder = sc.bindings.find(b => b.init && unparen(b.init) === blob!.n);
      if (holder) walk(chunk, n => { if (!consumer && n.type === 'CallExpr' && n.args.some((a: any) => { const u = unparen(a); return u?.type === 'NameExpr' && sc.refOf.get(u) === holder; })) consumer = n; });
      if (!consumer && holder) notes.push(`payload is bound to local \`${holder.name}\` (L${holder.line}) and read ${holder.reads}x`);
    }
    parts.push({ role: 'payload', line: lineOf(blob.n), pos: posOf(blob.n), detail: `${blob.len.toLocaleString('en-US')}-byte string literal (largest in the script)`, code: short(blob.n.raw ?? '', 90) });
    if (consumer) {
      payloadFn = resolve(consumer.callee);
      if (payloadFn) payloadFn.roles.add('payload-consumer');
      parts.push({ role: 'payload-consumer', name: payloadFn?.name ?? code(consumer.callee, 40), line: lineOf(consumer), pos: posOf(consumer), detail: payloadFn ? `${fnLabel(payloadFn)} receives the payload` : 'payload passed to ' + code(consumer.callee, 60), code: code(consumer, 120) });
    }
  }

  // ---------------------------------------------------------------- interpreter / dispatch
  let trees: DispatchTree[] = [];
  try { trees = extractOpcodes(chunk, { maxTrees: 8 }).trees; } catch (e) { notes.push('dispatch extractor failed: ' + (e as Error).message); }
  const vmTree = trees.filter(t => t.kind === 'vm').sort((a, b) => b.score - a.score)[0];
  const cffTree = trees.filter(t => t.kind === 'cff').sort((a, b) => b.score - a.score)[0];
  const tree = vmTree ?? cffTree;
  const kind: VmAnatomy['kind'] = vmTree ? 'vm' : cffTree ? 'cff' : 'plain';
  let interp: Fn | undefined, wrapper: Fn | undefined, loop: any;
  if (tree) {
    const tpos = tree.handlers[0]?.pos ?? 0;
    interp = innermost(tpos);
    // innermost loop around the dispatch tree (inside the interpreter function)
    const loops: any[] = [];
    walk(interp?.f ?? chunk, n => { if ((n.type === 'WhileStat' || n.type === 'RepeatStat' || n.type === 'NumericForStat' || n.type === 'GenericForStat') && posOf(n) <= tpos && tpos <= span(n).end) loops.push(n); });
    loop = loops.sort((a, b) => (span(a).end - span(a).start) - (span(b).end - span(b).start))[0];
    if (kind === 'vm' && interp) {
      interp.roles.add('interpreter');
      parts.push({ role: 'interpreter', name: interp.name, line: interp.line, endLine: interp.endLine, pos: interp.start, detail: `${fnLabel(interp)} runs the dispatch on \`${tree.var}\` — ${tree.handlers.length} handlers, opcodes ${tree.minOp}..${tree.maxOp}`, code: `function(${interp.f.params.join(', ')}${interp.f.vararg ? (interp.f.params.length ? ', ' : '') + '...' : ''})` });
      // closure factory: the function that returns the interpreter closure — either the interpreter itself
      // (nested) or a small closure that calls it (`local function Wrapped(...) … return interp(state, …) end return Wrapped`)
      const returnsFn = (p: Fn, c: Fn) => { let r = false; walk(p.f, n => { if (!r && n.type === 'ReturnStat' && n.args.some((a: any) => { const u = unparen(a); return u === c.f || (u?.type === 'NameExpr' && !!c.binding && sc.refOf.get(u) === c.binding); })) r = true; }); return r; };
      const closures: Fn[] = [interp, ...(callsOf.get(interp) ?? []).map(c => innermost(posOf(c))).filter((f): f is Fn => !!f && f !== interp)];
      let closureFn: Fn | undefined;
      for (const c of closures) { const p = c.parent; if (p && returnsFn(p, c)) { wrapper = p; closureFn = c; break; } }
      if (!wrapper && interp.parent && interp.parent.f.body.length <= 12) { wrapper = interp.parent; closureFn = interp; }
      if (wrapper) {
        wrapper.roles.add('wrapper');
        if (closureFn && closureFn !== interp) closureFn.roles.add('closure');
        parts.push({ role: 'wrapper', name: wrapper.name, line: wrapper.line, endLine: wrapper.endLine, pos: wrapper.start, detail: `${fnLabel(wrapper)} returns ${closureFn && closureFn !== interp ? `the closure ${closureFn.name} (L${closureFn.line}) that calls the interpreter` : 'the interpreter closure'} — params (${wrapper.f.params.join(', ')}${wrapper.f.vararg ? ', ...' : ''}) usually = (proto/chunk, upvalues, env)`, code: `function(${wrapper.f.params.join(', ')})` });
      }
    }
    if (loop) parts.push({ role: 'dispatch-loop', line: lineOf(loop), endLine: span(loop).endLine, pos: posOf(loop), detail: `${loop.type.replace('Stat', '')} loop around the dispatch${tree.inLoop ? '' : ' (tree not marked in-loop)'}`, code: loop.type === 'WhileStat' ? 'while ' + code(loop.cond, 60) + ' do' : loop.type === 'RepeatStat' ? 'repeat … until ' + code(loop.cond, 60) : code({ ...loop, body: [] }, 80) });
    parts.push({ role: 'dispatch', line: tree.line, pos: tpos, detail: `${tree.kind} dispatch tree #${tree.id} on \`${tree.var}\` (${tree.leaves} leaves, score ${tree.score})${tree.entryState !== undefined ? `, entry state ${tree.entryState}` : ''}` });

    // instruction fetch + pc advance (inside the loop, before the tree)
    const r = tree.roles;
    if (loop && (r.code || r.pc || r.inst)) {
      let fetch: any, adv: any;
      walk(loop, n => {
        if (posOf(n) > tpos) return;
        if (!fetch && (n.type === 'LocalStat' || n.type === 'AssignStat')) {
          const vals = n.type === 'LocalStat' ? n.init : n.values;
          if (vals.some((v: any) => { const u = unparen(v); return u?.type === 'IndexExpr' && unparen(u.obj)?.type === 'NameExpr' && (unparen(u.obj).name === r.code || (r.pc && code(u.index, 40).includes(r.pc))); })) fetch = n;
        }
      });
      // the main pc advance is a direct statement of the loop body (handlers assign pc for jumps)
      const isAdv = (n: any) => n?.type === 'AssignStat' && n.targets.some((t: any) => t.type === 'NameExpr' && t.name === r.pc);
      adv = (loop.body as any[]).find(isAdv);
      if (!adv) walk(loop, n => { if (!adv && posOf(n) < tpos && isAdv(n)) adv = n; });
      if (fetch) parts.push({ role: 'fetch', line: lineOf(fetch), pos: posOf(fetch), detail: `instruction fetch${r.inst ? ` → \`${r.inst}\`` : ''}${r.code ? ` from \`${r.code}\`` : ''}${r.pc ? ` at pc \`${r.pc}\`` : ''}`, code: code(fetch, 120) });
      if (adv) parts.push({ role: 'pc-advance', line: lineOf(adv), pos: posOf(adv), detail: `program counter \`${r.pc}\` advances`, code: code(adv, 80) });
    }

    // exits: returns inside the interpreter loop (RETURN / TAILCALL handlers) or the CFF terminator
    if (loop) {
      const hs = [...tree.handlers].sort((a, b) => a.pos - b.pos);
      const handlerAt = (pos: number) => { let h; for (const x of hs) if (x.pos <= pos) h = x; else break; return h; };
      const exits: any[] = [];
      const visitExit = (n: any, depthFn: number) => {
        if (!n || typeof n !== 'object') return;
        if (Array.isArray(n)) { n.forEach(x => visitExit(x, depthFn)); return; }
        if (n.type === 'FunctionExpr') return; // returns of nested closures are not interpreter exits
        if (n.type === 'ReturnStat' || (kind === 'cff' && n.type === 'BreakStat')) exits.push(n);
        for (const k of Object.keys(n)) if (k !== 'loc') visitExit(n[k], depthFn);
      };
      visitExit(loop.body, 0);
      for (const e of exits.slice(0, 12)) {
        const h = handlerAt(posOf(e));
        parts.push({ role: kind === 'cff' ? 'cff-exit' : 'exit', line: lineOf(e), pos: posOf(e), detail: (e.type === 'BreakStat' ? 'break out of the state machine' : 'return from the interpreter') + (h ? ` — handler op ${h.rangeText}${h.guess ? ' ' + h.guess : ''}` : ''), code: code(e, 100) });
      }
      if (exits.length > 12) notes.push(`${exits.length - 12} more exit points not listed`);
      if (kind === 'cff' && tree.entryState !== undefined) parts.push({ role: 'cff-entry', line: lineOf(loop), pos: posOf(loop), detail: `state machine starts in state ${tree.entryState}` });
    }

    // closure creation inside the interpreter (CLOSURE handler calls the wrapper again)
    if (wrapper) for (const c of (callsOf.get(wrapper) ?? []).filter(c => interp && inside(interp, c)).slice(0, 4)) {
      const h = [...tree.handlers].sort((a, b) => a.pos - b.pos).filter(x => x.pos <= posOf(c)).pop();
      parts.push({ role: 'closure', line: lineOf(c), pos: posOf(c), detail: `interpreter calls the closure factory again${h ? ` in handler op ${h.rangeText}${h.guess ? ' ' + h.guess : ''}` : ''} (CLOSURE / nested proto)`, code: code(c, 100) });
    }
  }

  // ---------------------------------------------------------------- entry point
  const parentOf = new Map<any, any>();
  walk(chunk, (n, parent) => { if (parent) parentOf.set(n, parent); });
  const stmtOf = (n: any) => { let x = n; while (x && !(typeof x.type === 'string' && /Stat$/.test(x.type))) x = parentOf.get(x); return x ?? n; };
  // effective main body: peel `return (function(...) … end)(...)` style wrappers
  let main: { body: A.Stat[]; fn?: Fn } = { body: chunk.body };
  for (let guard = 0; guard < 4; guard++) {
    const last = main.body[main.body.length - 1] as any;
    const call = last?.type === 'ReturnStat' && last.args.length === 1 ? unparen(last.args[0]) : last?.type === 'CallStat' ? last.expr : null;
    const f = call?.type === 'CallExpr' ? byExpr.get(unparen(call.callee)) : undefined;
    if (!f || main.body.length > 3) break;
    f.roles.add('main-wrapper');
    main = { body: f.f.body, fn: f };
  }
  const outsideVm = (c: any) => !(interp && inside(interp, c)) && !(wrapper && inside(wrapper, c)) && !fns.some(f => f.roles.has('closure') && inside(f, c));
  let entryCall: any;
  if (wrapper) entryCall = (callsOf.get(wrapper) ?? []).find(outsideVm);
  if (!entryCall && interp) entryCall = (callsOf.get(interp) ?? []).find(outsideVm);
  let deser: Fn | undefined;
  if (entryCall) {
    const st = stmtOf(entryCall);
    // the deserializer is whatever function's result is fed into the closure factory
    walk(entryCall, n => { if (!deser && n !== entryCall && n.type === 'CallExpr') { const f = resolve(n.callee); if (f && f !== wrapper && f !== interp) deser = f; } });
    if (!deser) for (const a of entryCall.args) { const u = unparen(a); if (u?.type === 'NameExpr') { const b = sc.refOf.get(u); const init = b?.init && unparen(b.init); if (init?.type === 'CallExpr') { const f = resolve(init.callee); if (f) { deser = f; break; } } } }
    parts.push({ role: 'entry', line: lineOf(st), pos: posOf(st), detail: `boot: ${wrapper ? 'closure factory' : 'interpreter'} is invoked here${deser ? ` with the result of ${deser.name}` : ''} — execution of the protected program starts at this statement`, code: code(st, 160) });
  } else {
    const last = main.body[main.body.length - 1];
    if (last) parts.push({ role: 'entry', line: lineOf(last), pos: posOf(last), detail: `final statement of the ${main.fn ? 'main wrapper ' + main.fn.name : 'main chunk'} (no closure-factory call found)`, code: code(last, 160) });
  }
  const rankedDeser = (decoders.filter(d => d.kind === 'deserializer').map(fnAtDecoder).filter(Boolean) as Fn[]).filter(f => f !== interp && f !== wrapper);
  if (!deser && rankedDeser.length) deser = rankedDeser[0];
  if (deser) {
    deser.roles.add('deserializer');
    const d = decoders.find(x => fnAtDecoder(x) === deser);
    parts.push({ role: 'deserializer', name: deser.name, line: deser.line, endLine: deser.endLine, pos: deser.start, detail: `${fnLabel(deser)} ${entryCall && walkHas(entryCall, deser) ? 'feeds the closure factory' : 'top-ranked deserializer'}${d ? ` — ${d.reasons.slice(0, 3).join('; ')}` : ''} → port it with python_transpile to extract the chunk statically` });
  }
  for (const d of decoders.filter(x => /string-decoder|constant-accessor|constant-decryptor/.test(x.kind)).slice(0, 3)) {
    const f = fnAtDecoder(d);
    parts.push({ role: 'string-decoder', name: f?.name ?? d.name, line: d.line, endLine: d.endLine, pos: d.pos, detail: `${d.kind} (score ${d.score}, ${d.callSites} call sites, ${d.literalArgCalls} with literal args)` });
  }
  function walkHas(root: any, f: Fn) { let hit = false; walk(root, n => { if (!hit && n.type === 'CallExpr' && resolve(n.callee) === f) hit = true; }); return hit; }

  // ---------------------------------------------------------------- env / varargs
  const envSeen = new Set<number>();
  walk(chunk, n => {
    if (n.type === 'NameExpr' && /^(getfenv|setfenv|_ENV)$/.test(n.name) && (!sc.refOf.get(n) || sc.refOf.get(n)!.kind === 'global') && envSeen.size < 6) {
      const st = stmtOf(n); const l = lineOf(st);
      if (envSeen.has(l)) return; envSeen.add(l);
      const owner = innermost(posOf(n));
      parts.push({ role: 'env', line: l, pos: posOf(n), detail: `environment access via ${n.name}${owner ? ' in ' + owner.name : ' at top level'}`, code: code(st, 110) });
    }
  });
  for (const f of [wrapper, interp].filter(Boolean) as Fn[]) {
    let va: any;
    walk(f.f, n => { if (!va && n.type === 'CallExpr' && unparen(n.callee)?.type === 'NameExpr' && unparen(n.callee).name === 'select' && n.args[0]?.type === 'StringLit' && n.args[0].value === '#') va = n; });
    if (va) { parts.push({ role: 'varargs', line: lineOf(va), pos: posOf(va), detail: `${f.name} packs the caller's varargs (select("#", ...))`, code: code(stmtOf(va), 100) }); break; }
  }

  // ---------------------------------------------------------------- main chunks inventory
  for (const f of fns) if (f.calls === 0 && f.refs === 0 && !f.roles.size) { const p = parentOf.get(f.f); if (!(p && (p.type === 'CallExpr' || p.type === 'TableExpr' || p.type === 'ReturnStat'))) f.roles.add('unreferenced'); }
  const chunks: ChunkInfo[] = [...fns].sort((a, b) => b.size - a.size).slice(0, opts.maxChunks ?? 40).map(f => ({
    id: f.id, name: f.name, line: f.line, endLine: f.endLine, pos: f.start, size: f.size, callers: f.calls, refs: f.refs, roles: [...f.roles], parent: f.parent?.name,
    params: f.f.params.join(', ') + (f.f.vararg ? (f.f.params.length ? ', ...' : '...') : ''),
  }));

  // ---------------------------------------------------------------- pipeline summary
  const order: AnatomyPart['role'][] = ['payload', 'payload-consumer', 'deserializer', 'string-decoder', 'wrapper', 'interpreter', 'varargs', 'dispatch-loop', 'fetch', 'pc-advance', 'dispatch', 'cff-entry', 'exit', 'cff-exit', 'closure', 'env', 'entry'];
  parts.sort((a, b) => order.indexOf(a.role) - order.indexOf(b.role) || a.line - b.line);
  const pipeline: string[] = [];
  const first = (r: AnatomyPart['role']) => parts.find(p => p.role === r);
  const pl = first('payload'), pc = first('payload-consumer'), de = first('deserializer'), wr = first('wrapper'), it = first('interpreter'), en = first('entry');
  if (pl) pipeline.push(`payload  L${pl.line}: ${pl.detail}${pc ? ` → ${pc.name} (L${pc.line})` : ''}`);
  if (de) pipeline.push(`unpack   ${de.name} L${de.line}${de.endLine ? '–' + de.endLine : ''}: deserializes the chunk`);
  if (wr) pipeline.push(`wrap     ${wr.name} L${wr.line}${wr.endLine ? '–' + wr.endLine : ''}: closure factory (${wr.code})`);
  if (it) pipeline.push(`run      ${it.name} L${it.line}${it.endLine ? '–' + it.endLine : ''}: ${it.detail.replace(/^.*? runs /, '')}`);
  else if (kind === 'cff' && tree) {
    const dl = first('dispatch-loop');
    pipeline.push(`run      state machine on \`${tree.var}\` L${dl?.line ?? tree.line}${dl?.endLine ? '–' + dl.endLine : ''}${interp ? ' in ' + interp.name : ' at top level'}: ${tree.handlers.length} states${tree.entryState !== undefined ? ', entry state ' + tree.entryState : ''}`);
  }
  const ex = parts.filter(p => p.role === 'exit' || p.role === 'cff-exit');
  if (ex.length) pipeline.push(`exit     ${ex.slice(0, 6).map(e => 'L' + e.line).join(', ')}${ex.length > 6 ? ', …' : ''}`);
  if (en) pipeline.push(`entry    L${en.line}: ${en.code ?? ''}`);
  if (kind === 'plain') notes.push('no interpreter dispatch found — the script is not VM-protected (or the dispatch is hidden behind junk: deobfuscate first and re-run on the cleaned code)');
  if (kind === 'cff') notes.push('control-flow flattening (state machine) without a bytecode interpreter: use Deobfuscate (control-flow passes) and the Opcode Map view of the state tree');
  return {
    kind, pipeline, parts, chunks, notes,
    tree: tree ? { id: tree.id, line: tree.line, var: tree.var, kind: tree.kind, handlers: tree.handlers.length, minOp: tree.minOp, maxOp: tree.maxOp, roles: tree.roles } : undefined,
  };
}

// ---------------------------------------------------------------- text report (shared by the tool, MCP and the web UI)
function textTable(rows: Array<Array<string | number>>, head: string[], maxCol = 70): string {
  const all = [head, ...rows.map(r => r.map(c => { const s = String(c ?? ''); return s.length > maxCol ? s.slice(0, maxCol - 1) + '…' : s; }))];
  const w = head.map((_, i) => Math.max(...all.map(r => (r[i] ?? '').length)));
  return all.map((r, ri) => r.map((c, i) => i === r.length - 1 ? c : c.padEnd(w[i])).join('  ') + (ri === 0 ? '\n' + w.map(x => '-'.repeat(x)).join('  ') : '')).join('\n');
}
const KIND_LABEL: Record<VmAnatomy['kind'], string> = { vm: 'bytecode interpreter (virtual machine)', cff: 'control-flow-flattened state machine (no bytecode VM)', plain: 'no VM / dispatcher found' };
export function formatAnatomy(a: VmAnatomy, opts: { label?: string; maxChunks?: number; code?: boolean } = {}): string {
  const out: string[] = [`VM ANATOMY${opts.label ? ' — ' + opts.label : ''}: ${KIND_LABEL[a.kind]}`];
  if (a.pipeline.length) { out.push('', 'PIPELINE  (boot → run → exit)'); for (const l of a.pipeline) out.push('  ' + l); }
  if (a.tree) {
    const r = a.tree.roles;
    const roles = [r.inst && `inst=${r.inst}`, r.opField && `op field=${r.opField}`, r.code && `code=${r.code}`, r.pc && `pc=${r.pc}`, r.stack && `stack=${r.stack}`,
      ...Object.entries(r.fields ?? {}).slice(0, 8).map(([k, v]) => `${v}=${k}`)].filter(Boolean).join(', ');
    out.push('', `DISPATCH  tree #${a.tree.id} (${a.tree.kind}) on \`${a.tree.var}\` L${a.tree.line}: ${a.tree.handlers} handlers, ops ${a.tree.minOp}..${a.tree.maxOp}${roles ? ' — ' + roles : ''}`);
  }
  if (a.parts.length) {
    out.push('', `PARTS (${a.parts.length})`);
    out.push(textTable(a.parts.map(p => [p.role, p.name ?? '', 'L' + p.line + (p.endLine && p.endLine !== p.line ? '–' + p.endLine : ''), p.detail + (opts.code !== false && p.code ? `  ⟨${p.code}⟩` : '')]), ['role', 'name', 'lines', 'detail'], 400));
  }
  const ch = a.chunks.slice(0, opts.maxChunks ?? 25);
  if (ch.length) {
    out.push('', `MAIN CHUNKS (${ch.length} largest functions; size = AST nodes)`);
    out.push(textTable(ch.map(c => [c.name, `L${c.line}–${c.endLine}`, c.size, c.callers, c.refs, c.roles.join(',') || '-', c.parent ?? '-', c.params]), ['name', 'lines', 'size', 'calls', 'refs', 'roles', 'parent', 'params'], 48));
  }
  if (a.notes.length) { out.push('', 'NOTES'); for (const n of a.notes) out.push('- ' + n); }
  return out.join('\n');
}
