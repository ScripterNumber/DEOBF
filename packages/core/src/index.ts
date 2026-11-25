// PRISM core — universal static Luau reverse-engineering engine.
// Single entry point used by the web app and the MCP server.
export * from './lexer.js';
export * from './parser.js';
export * as AST from './ast.js';
export { print } from './printer.js';

import { lex, T } from './lexer.js';
import { parse } from './parser.js';
import type * as A from './ast.js';
import { walk } from './ast.js';
import { print } from './printer.js';
import { fold } from './passes/fold.js';
import { recoverStrings, collectStrings } from './passes/strings.js';
import { analyzeAliases } from './passes/alias.js';
import { eliminateDeadCode } from './passes/deadcode.js';
import { computeMetrics, fingerprint, Metrics, FamilyGuess } from './analysis/fingerprint.js';
import { buildCallGraph, CallGraph } from './analysis/callgraph.js';
import { detectVM, VMReport } from './analysis/vmdetect.js';
import { propagateConstants, removeDeadLocals } from './passes/scopepasses.js';
import { smartRename, looksObfuscated, RenameMode } from './passes/rename.js';
import { analyzeScopes } from './analysis/scope.js';
import { stripParens } from './passes/parens.js';
import { loopOnce, foldGuards, unrollSwitchLoops, flattenDo, mergeDeclAssign } from './passes/controlflow.js';
import { guardConstProp, unflattenStateLoops, simplifyWhileTrue, unrollSwitchFor, rotateHeadUpdates } from './passes/cff.js';
import type { UnflattenOptions } from './passes/cff.js';
import { forwardSubst, expandCompound } from './passes/forward.js';
import { constFlow, unrollSmallFor } from './passes/constflow.js';
import { removeDeadStores } from './passes/deadstores.js';
import { promoteRegisters } from './passes/regpromote.js';
import { foldKnownTruthy } from './passes/truthy.js';
import { fuseMultret } from './passes/multret.js';
import { lowerIfExprs } from './passes/ifexpr.js';
import { astRewrite, globalsFromEnv, compileRules } from './passes/rewrite.js';
import type { RewriteRule } from './passes/rewrite.js';
import { specializeVM, findVmShape, selectHandler, printExpr, collectPatches } from './vm/specialize.js';
import { resolvePatchedReads } from './vm/patches.js';
import { findPureReaderSlots } from './vm/purity.js';
import { substituteConstPools, findPackHelpers } from './vm/constpool.js';
import { dropUnobservedRecords, foldIdempotentGuards } from './vm/records.js';
import { emitRecordTables, rewriteRecordRefs, luaForValue } from './vm/emit.js';
import type { SpecializeOptions, SpecializeResult, VmShape, PatchSpec } from './vm/specialize.js';
import { LuaDump } from './vm/dump.js';
import { reinlineOutlined } from './passes/outline.js';

export { fold, recoverStrings, collectStrings, analyzeAliases, eliminateDeadCode };
export { removeDeadStores, promoteRegisters, foldKnownTruthy };
export { propagateConstants, removeDeadLocals, smartRename, looksObfuscated, analyzeScopes, stripParens, loopOnce, foldGuards, unrollSwitchLoops, flattenDo, mergeDeclAssign, guardConstProp, unflattenStateLoops, simplifyWhileTrue, unrollSwitchFor, forwardSubst, expandCompound, constFlow, unrollSmallFor };
export type { RenameMode };
export { computeMetrics, fingerprint, buildCallGraph, detectVM };
export { resolvePrimitives, formatPrimitives, primitiveCallSites, linearizeDispatch, formatDispatch } from './analysis/primitives.js';
export type { PrimitiveTable, PrimitiveEntry, PrimitivesReport, IntervalDispatch, DispatchLeaf, LinearizeReport } from './analysis/primitives.js';
export { protoInventory, formatInventory, formatCapture } from './analysis/inventory.js';
export type { Inventory, InvUnit, InvChild, InvCapture, InvUpvalue, InvPool } from './analysis/inventory.js';
export { liftReport, formatLiftReport } from './analysis/liftreport.js';
export type { LiftReport } from './analysis/liftreport.js';
export type { Metrics, FamilyGuess, CallGraph, VMReport };
import { extractOpcodes, formatOpcodeTree } from './analysis/opcodes.js';
import type { OpcodeReport, DispatchTree, HandlerInfo, VmRoles } from './analysis/opcodes.js';
import { findConstants, entropy, classifyString, printableRatio } from './analysis/constants.js';
import type { ConstantsReport, StringConst, NumberConst, ArrayConst, DecoderCandidate } from './analysis/constants.js';
import { searchPattern, xrefs } from './analysis/search.js';
import type { PatternResult, PatternMatch, XrefBinding } from './analysis/search.js';
export { extractOpcodes, formatOpcodeTree, findConstants, entropy, classifyString, printableRatio, searchPattern, xrefs };
export type { OpcodeReport, DispatchTree, HandlerInfo, VmRoles, ConstantsReport, StringConst, NumberConst, ArrayConst, DecoderCandidate, PatternResult, PatternMatch, XrefBinding };

export interface CleanOptions {
  /** lower statement-level Luau if-expressions into if-statements (default true) */
  lowerIfExpr?: boolean;
  foldConstants?: boolean;
  recoverStrings?: boolean;
  removeDeadCode?: boolean;
  /** inline literal locals + pure aliases (local f = string.byte) */
  propagate?: boolean;
  /** drop never-read locals / assignments (junk) */
  removeUnusedLocals?: boolean;
  /** role-based renaming of obfuscated identifiers */
  rename?: RenameMode;
  /** drop redundant parentheses (printer re-adds the required ones) */
  stripParens?: boolean;
  /** while-break -> if, repeat-until-true -> do, opaque state-variable guards -> if/else */
  controlFlow?: boolean;
  rounds?: number;
  /** flow-sensitive constant/copy propagation (default on with propagate) */
  constFlow?: boolean;
  /** read-only global names (treated as constants by constFlow), e.g. specialiser record names */
  constGlobals?: (name: string) => boolean;
  /** fold hooks for read-only tables: `T[k]` / `#T` -> literal (VM specialiser) */
  constIndex?: (obj: A.Expr, key: A.Expr) => A.Expr | null;
  constLen?: (obj: A.Expr) => A.Expr | null;
  /** unroll numeric for-loops with literal bounds and at most this many iterations (default 0 = off) */
  unrollFor?: number;
  /** liveness-based dead-store elimination (default on) */
  deadStores?: boolean;
  /** table reads have no side effects (no __index metamethods) — lets dead stores of table reads go (VM residual code) */
  pureIndex?: boolean;
  /** promote register-file tables (`local R = table.create(n)` accessed by literal slots) to locals (VM residual code) */
  promoteRegisters?: boolean;
  /** state-machine unflattener limits / diagnostics */
  unflatten?: UnflattenOptions;
  /** the interpreter's varargs-pack helper (`n, t = PACK(...)`): multiple-results / varargs register ranges are
   *  fused back into call arguments, returns and table constructors (VM residual code) */
  packHelper?: (callee: A.Expr) => boolean;
  /** collects pass diagnostics (register promotion, multiple-results fusion) when given */
  diagnostics?: string[];
  /** re-inline obfuscator-outlined method tables (one big table of tiny single-call-site helpers /
   *  state-machine blocks): fold constant slots and inline the helpers (default true; no-op elsewhere) */
  outline?: boolean;
}

export interface CleanStats {
  ifexpr?: number;
  folded: number; mbaFolded: number; charCalls: number; concatChains: number;
  prunedBranches: number; removedStmts: number;
  propagated: number; aliases: number; removedLocals: number; removedAssigns: number; renamed: number; parens: number;
  loopsToIf: number; guardsFolded: number; guardsMerged: number; blocksFlattened: number;
  /** reads of a state variable replaced by the constant its guard proves */
  guardConsts: number;
  /** flattened state-machine loops rebuilt as structured code */
  cffUnflattened: number;
  /** temporaries forwarded into their single use (copy propagation) */
  forwarded: number;
  /** reads replaced by flow-sensitive constant/copy propagation */
  constFlow: number;
  /** small literal-bound for-loops unrolled */
  unrolled: number;
  /** assignments to locals that are dead afterwards, removed */
  deadStores?: number;
  /** register-file slots promoted to locals */
  promoted?: number;
  /** `x or y` / `x and y` folded where x is known truthy */
  truthyFolded?: number;
  /** multiple-results / varargs register ranges fused into calls, returns and constructors */
  multret?: number;
  /** obfuscator-outlined helper methods inlined back into their caller */
  outlineInlined?: number;
  /** literal `self[k]` reads replaced by the field's constant value */
  outlineSlots?: number;
  /** dead helper/slot fields removed from an outlined table */
  outlineRemoved?: number;
}

export interface CleanResult {
  code: string;
  rounds: number;
  stats: CleanStats;
  renameMap: Array<{ from: string; to: string; line: number; kind: string }>;
  parseErrors: number;
}

/** Parse + run the cleanup pipeline, return readable source. */
export function clean(src: string, opts: CleanOptions = {}): CleanResult {
  // explicit `undefined` (e.g. an omitted tool argument) must not override a default
  const given = Object.fromEntries(Object.entries(opts).filter(([, v]) => v !== undefined)) as CleanOptions;
  const o = { foldConstants: true, recoverStrings: true, removeDeadCode: true, propagate: true, removeUnusedLocals: true, rename: 'none' as RenameMode, stripParens: true, controlFlow: true, rounds: 8, ...given };
  const { chunk, errors } = parse(src);
  const stats: CleanStats = { folded: 0, mbaFolded: 0, charCalls: 0, concatChains: 0, prunedBranches: 0, removedStmts: 0, propagated: 0, aliases: 0, removedLocals: 0, removedAssigns: 0, renamed: 0, parens: 0, loopsToIf: 0, guardsFolded: 0, guardsMerged: 0, blocksFlattened: 0, guardConsts: 0, cffUnflattened: 0, forwarded: 0, constFlow: 0, unrolled: 0 };
  // obfuscator-outlined method tables: fold literal slots + re-inline helpers before the normal cleanup
  if (o.outline !== false) {
    const ol = reinlineOutlined(chunk, { diagnostics: o.diagnostics });
    if (ol.inlined || ol.slots || ol.removedFields) {
      stats.outlineInlined = ol.inlined; stats.outlineSlots = ol.slots; stats.outlineRemoved = ol.removedFields;
    }
    if (o.diagnostics && ol.notes.length) o.diagnostics.push(...ol.notes.map(n => 'outline: ' + n));
  }
  let rounds = 0;
  const round = (): number => {
    rounds++;
    let changed = 0;
    if (o.lowerIfExpr !== false) { const k = lowerIfExprs(chunk); if (k) { changed += k; stats.ifexpr = (stats.ifexpr ?? 0) + k; } }
    const aliases = analyzeAliases(chunk);
    if (o.recoverStrings) { const s = recoverStrings(chunk, { resolveStrAlias: aliases.resolveStr }); stats.charCalls += s.charCalls; stats.concatChains += s.concatChains; changed += s.charCalls + s.concatChains; }
    if (o.foldConstants) { const s = fold(chunk, { resolveBitAlias: aliases.resolveBit, resolveStrAlias: aliases.resolveStr, constIndex: o.constIndex, constLen: o.constLen }); stats.folded += s.folded; stats.mbaFolded += s.mbaFolded; changed += s.folded; }
    if (o.removeDeadCode) { const s = eliminateDeadCode(chunk); stats.prunedBranches += s.prunedBranches; stats.removedStmts += s.removedStmts; changed += s.prunedBranches + s.removedStmts; }
    if (o.controlFlow) {
      const l = loopOnce(chunk) + unrollSwitchFor(chunk) + unrollSwitchLoops(chunk); stats.loopsToIf += l; changed += l;
      const g = foldGuards(chunk); stats.guardsFolded += g.folded; stats.guardsMerged += g.merged; changed += g.folded + g.merged;
      const rh = rotateHeadUpdates(chunk); changed += rh;
      const gc = guardConstProp(chunk); stats.guardConsts += gc; changed += gc;
      const u = unflattenStateLoops(chunk, o.unflatten); stats.cffUnflattened += u; changed += u + simplifyWhileTrue(chunk);
    }
    if (o.propagate) { const s = propagateConstants(chunk); stats.propagated += s.propagated; stats.aliases += s.aliases; changed += s.propagated + s.aliases; }
    if (o.propagate && o.constFlow !== false) { const c = constFlow(chunk, { constGlobals: o.constGlobals }); stats.constFlow += c; changed += c; }
    if (o.unrollFor) {
      // loops whose body indexes a constant table (or the register file being promoted) by the loop variable fold away
      const wide = (o.constIndex || o.promoteRegisters) ? (f: A.NumericForStat): boolean => {
        let hit = false;
        walk(f.body, (m: any) => {
          if (hit || m.type !== 'IndexExpr') return;
          const ix = m.index; if (!ix || ix.type !== 'NameExpr' || ix.name !== f.var) return;
          if (o.constIndex && o.constIndex(m.obj, { type: 'NumberLit', value: 1, raw: '1' } as A.Expr) !== null) hit = true;
        });
        if (!hit && o.promoteRegisters && f.body.length <= 4) walk(f.body, (m: any) => { if (m.type === 'IndexExpr' && m.obj.type === 'NameExpr' && m.index.type === 'NameExpr') hit = true; });
        return hit;
      } : undefined;
      const u = unrollSmallFor(chunk, o.unrollFor, 60, wide); stats.unrolled += u; changed += u;
    }
    if (o.propagate) { const x = expandCompound(chunk); const f = forwardSubst(chunk); stats.forwarded += f; changed += f + x; }
    if (o.controlFlow) { const f = flattenDo(chunk) + mergeDeclAssign(chunk); stats.blocksFlattened += f; changed += f; }
    if (o.deadStores !== false && o.removeUnusedLocals) { const d = removeDeadStores(chunk, { pureIndex: o.pureIndex }); stats.deadStores = (stats.deadStores ?? 0) + d; changed += d; }
    if (o.propagate || o.promoteRegisters || o.packHelper) { const t = foldKnownTruthy(chunk); if (t) { stats.truthyFolded = (stats.truthyFolded ?? 0) + t; changed += t; } }
    if (o.packHelper) { const m = fuseMultret(chunk, { isPack: o.packHelper }); const n = m.fused + m.fixed; if (n) { stats.multret = (stats.multret ?? 0) + n; changed += n; } if (o.diagnostics && m.skipped.size) o.diagnostics.push(`round ${rounds}: multret kept: ` + [...m.skipped].map(([k, v]) => `${k} ×${v}`).join(', ')); }
    if (o.promoteRegisters) { const pr = promoteRegisters(chunk); if (pr.promoted) { stats.promoted = (stats.promoted ?? 0) + pr.promoted; changed += pr.promoted; } if (o.diagnostics && pr.notes.length) o.diagnostics.push(...pr.notes.map(n => `round ${rounds}: ${n}`)); }
    if (o.removeUnusedLocals) { const s = removeDeadLocals(chunk); stats.removedLocals += s.removedLocals; stats.removedAssigns += s.removedAssigns; changed += s.removedLocals + s.removedAssigns; }
    return changed;
  };
  for (let r = 0; r < o.rounds; r++) if (round() === 0) break;
  let renameMap: CleanResult['renameMap'] = [];
  if (o.rename !== 'none') {
    const r = smartRename(chunk, o.rename);
    stats.renamed = r.renamed; renameMap = r.map;
    // unique names make local->local alias propagation safe; run a couple more rounds
    for (let r2 = 0; r2 < 2; r2++) if (round() === 0) break;
  }
  if (o.stripParens) stats.parens = stripParens(chunk);
  return { code: print(chunk), rounds, stats, renameMap, parseErrors: errors.length };
}

export interface FullReport {
  ok: boolean;
  metrics: Metrics;
  families: FamilyGuess[];
  vm: VMReport;
  callGraph: {
    functionCount: number;
    edgeCount: number;
    topExternalCalls: Array<{ name: string; count: number }>;
    functions: CallGraph['functions'];
    edges: CallGraph['edges'];
  };
  strings: { total: number; samples: Array<{ value: string; line?: number }> };
  aliases: Array<{ name: string; target: string }>;
  parseErrors: Array<{ message: string; line: number }>;
}

/** Full static analysis report over the ORIGINAL (unmodified) AST. */
export function analyze(src: string): FullReport {
  const { chunk, errors } = parse(src);
  const metrics = computeMetrics(src, chunk);
  const families = fingerprint(src, metrics);
  const vm = detectVM(chunk);
  const cg = buildCallGraph(chunk);
  const aliases = analyzeAliases(chunk);
  const strs = collectStrings(chunk);
  const seen = new Set<string>();
  const samples: Array<{ value: string; line?: number }> = [];
  for (const s of strs) { if (!seen.has(s.value)) { seen.add(s.value); samples.push(s); if (samples.length >= 200) break; } }
  return {
    ok: errors.length === 0,
    metrics,
    families,
    vm,
    callGraph: {
      functionCount: cg.functions.length,
      edgeCount: cg.edges.length,
      topExternalCalls: cg.externalCalls.slice(0, 40),
      functions: cg.functions,
      edges: cg.edges,
    },
    strings: { total: strs.length, samples },
    aliases: [...aliases.builtins.entries()].map(([name, target]) => ({ name, target })),
    parseErrors: errors.map(e => ({ message: e.message, line: e.line })),
  };
}

/** Tokenize only — for the raw token inspector tool. */
export function tokenize(src: string) {
  const { tokens, errors } = lex(src);
  return {
    tokens: tokens.map(t => ({ type: T[t.type], value: t.value, line: t.line, col: t.col, start: t.start, end: t.end })),
    errors,
  };
}
export interface OpcodeMapResult { report: OpcodeReport; code: string; cleaned: boolean; }
/** Dispatch-tree / opcode extraction. By default runs on the cleaned code so that
 *  handler line numbers match the Deobfuscate output (`code` is returned). */
export function mapOpcodes(src: string, opts: { clean?: boolean | CleanOptions; minLeaves?: number; maxTrees?: number } = {}): OpcodeMapResult {
  let code = src;
  const doClean = opts.clean !== false;
  if (doClean) code = clean(src, typeof opts.clean === 'object' ? opts.clean : { rename: 'obfuscated' }).code;
  const { chunk } = parse(code);
  return { report: extractOpcodes(chunk, { minLeaves: opts.minLeaves, maxTrees: opts.maxTrees }), code, cleaned: doClean };
}

/** literal inventory + decoder candidates over the given source */
export function constants(src: string, opts: Parameters<typeof findConstants>[1] = {}): ConstantsReport {
  return findConstants(parse(src).chunk, opts);
}

export interface FunctionSource { id: string; name: string; line: number; endLine: number; params: string[]; code: string; }
/** source of one function by callgraph id (f12), name, or a line inside it (innermost wins) */
export function getFunction(src: string, query: string | number): FunctionSource | null {
  const { chunk } = parse(src);
  const cg = buildCallGraph(chunk);
  const lineOf = (pos: number) => { let l = 1; for (let i = 0; i < pos && i < src.length; i++) if (src.charCodeAt(i) === 10) l++; return l; };
  // statement starts so `local function f` / `function a.b()` headers are included
  const headers = new Map<number, number>();
  const visit = (n: any) => {
    if (!n || typeof n !== 'object') return;
    if (Array.isArray(n)) { n.forEach(visit); return; }
    if ((n.type === 'LocalFunctionStat' || n.type === 'FunctionStat') && n.func?.loc) headers.set(n.func.loc.start, n.loc?.start ?? n.func.loc.start);
    if (n.type === 'LocalStat' && n.init?.length === 1 && n.init[0].type === 'FunctionExpr' && n.init[0].loc) headers.set(n.init[0].loc.start, n.loc?.start ?? n.init[0].loc.start);
    for (const k of Object.keys(n)) if (k !== 'loc') visit(n[k]);
  };
  visit(chunk);
  const fns = cg.functions.filter(f => f.id !== 'main');
  let f = typeof query === 'number' || /^\d+$/.test(String(query)) ? undefined : fns.find(x => x.id === query) ?? fns.find(x => x.name === query) ?? fns.find(x => x.name.endsWith('.' + query) || x.name.endsWith(':' + query));
  if (!f) {
    const line = Number(query);
    if (!isFinite(line)) return null;
    let best: typeof fns[number] | undefined;
    for (const x of fns) { const s = lineOf(x.start), e = lineOf(x.end); if (s <= line && line <= e && (!best || x.end - x.start < best.end - best.start)) best = x; }
    f = best;
  }
  if (!f) return null;
  const start = headers.get(f.start) ?? f.start;
  // also cover `function` keyword before the parameter list
  const kw = src.lastIndexOf('function', f.start);
  const s0 = Math.min(start, kw >= 0 && f.start - kw < 64 ? kw : start);
  return { id: f.id, name: f.name, line: lineOf(s0), endLine: lineOf(f.end), params: f.params, code: src.slice(s0, f.end) };
}

// ───────────── bytecode, blobs, transpilers ─────────────
import { luaToPython, functionToPython } from './transpile/python.js';
import { parseLuauBytecode, disassembleLuau, summarizeLuau, decodeLuauProto, looksLikeLuauBytecode } from './bytecode/luau.js';
import type { LuauChunk, LuauDisasmOptions, LuauSummary } from './bytecode/luau.js';
import { parseLua51Bytecode, disassembleLua51, detectLuaBytecode } from './bytecode/lua51.js';
import type { Lua51Chunk } from './bytecode/lua51.js';
import { vmDisassemble, opmapFromTree, luaLiteralToJson } from './bytecode/customvm.js';
import { chunkDisassemble, unbytes } from './bytecode/chunk.js';
import { behaviorReport, formatBehavior, collectJsonStrings } from './analysis/behavior.js';
import type { BehaviorReport, BehaviorCategory, BehaviorHit } from './analysis/behavior.js';
export { behaviorReport, formatBehavior, collectJsonStrings };
import { functionToLua } from './transpile/luaslice.js';
import type { LuaSliceResult } from './transpile/luaslice.js';
export { functionToLua };
import { decodeBundle, pickDecoders } from './transpile/bundle.js';
import type { BundleResult, BundlePart, BundleOptions } from './transpile/bundle.js';
export { decodeBundle, pickDecoders };
export type { BundleResult, BundlePart, BundleOptions };
export type { LuaSliceResult };
export type { BehaviorReport, BehaviorCategory, BehaviorHit };
import { inlineValues, jsonToLua, siteKeyer, exprStart, lineIndex } from './passes/inline.js';
import type { InlineOptions, InlineResult } from './passes/inline.js';
export { inlineValues, jsonToLua, siteKeyer, exprStart, lineIndex };
export type { InlineOptions, InlineResult };
import type { ChunkLayout, ChunkProto, ChunkDisasmOptions, ChunkDisasmResult } from './bytecode/chunk.js';
export { chunkDisassemble, unbytes };
export type { ChunkLayout, ChunkProto, ChunkDisasmOptions, ChunkDisasmResult };
import type { OpMap, OpEntry, VmDisasmOptions, VmDisasmResult } from './bytecode/customvm.js';
import * as Blob from './blob/blob.js';
export * as Blob from './blob/blob.js';
export * as LuauBytecode from './bytecode/luau.js';
export * as Lua51Bytecode from './bytecode/lua51.js';
export { luaToPython, functionToPython, parseLuauBytecode, disassembleLuau, summarizeLuau, decodeLuauProto, looksLikeLuauBytecode, parseLua51Bytecode, disassembleLua51, detectLuaBytecode, vmDisassemble, opmapFromTree, luaLiteralToJson };
export type { LuauChunk, LuauDisasmOptions, LuauSummary, Lua51Chunk, OpMap, OpEntry, VmDisasmOptions, VmDisasmResult };

export interface BytecodeDisasm { format: 'luau' | 'lua51'; text: string; summary: Record<string, unknown>; }
/** Auto-detect Luau / Lua 5.1 bytecode and disassemble it (static parse only). */
export function disassembleBytecode(bytes: Uint8Array, opts: LuauDisasmOptions & { encoding?: 'auto' | 'plain' | 'roblox'; format?: 'auto' | 'luau' | 'lua51' } = {}): BytecodeDisasm {
  const fmt = opts.format ?? 'auto';
  if (fmt === 'lua51' || (fmt === 'auto' && detectLuaBytecode(bytes))) {
    const ch = parseLua51Bytecode(bytes);
    return { format: 'lua51', text: disassembleLua51(ch, { style: opts.style === 'luau' ? 'luac' : 'rich', hex: opts.hex, lift: opts.lift, constants: opts.constants }), summary: { functions: ch.all.length, littleEndian: ch.littleEndian, sizeNumber: ch.sizeNumber, trailing: ch.trailing, instructions: ch.all.reduce((n, p) => n + p.code.length, 0) } };
  }
  const ch = parseLuauBytecode(bytes, { encoding: opts.encoding });
  const s = summarizeLuau(ch);
  return { format: 'luau', text: disassembleLuau(ch, opts), summary: s as unknown as Record<string, unknown> };
}

export interface EmbeddedBytecode { line: number; via: string; format: string; length: number; preview: string; }
/** Scan every string literal (raw, and base64/hex decoded) for embedded Lua/Luau bytecode. */
export function findEmbeddedBytecode(src: string, opts: { max?: number } = {}): EmbeddedBytecode[] {
  const out: EmbeddedBytecode[] = [];
  const { tokens } = lex(src);
  for (const t of tokens) {
    if (t.type !== T.String || out.length >= (opts.max ?? 50)) continue;
    const v = t.cooked ?? '';
    if (v.length < 12) continue;
    const cands: Array<[string, Uint8Array]> = [['raw', Blob.latin1(v)]];
    if (/^[A-Za-z0-9+/=\s]+$/.test(v) && v.length % 4 === 0) { try { cands.push(['base64', Blob.b64decode(v.replace(/\s+/g, ''))]); } catch { /* not base64 */ } }
    if (/^[0-9a-fA-F\s]+$/.test(v) && v.replace(/\s+/g, '').length % 2 === 0) { try { cands.push(['hex', Blob.hexdecode(v)]); } catch { /* not hex */ } }
    for (const [via, b] of cands) {
      const lua = detectLuaBytecode(b);
      const fmt = lua ? lua.lua + ' bytecode' : looksLikeLuauBytecode(b) ? `Luau bytecode v${b[0]}` : '';
      if (fmt) { out.push({ line: t.line, via, format: fmt, length: b.length, preview: Blob.hexencode(b.subarray(0, 24), ' ') }); break; }
    }
  }
  return out;
}
export { renameSymbols } from './passes/manualrename.js';
import { vmAnatomy, formatAnatomy } from './analysis/anatomy.js';
import type { VmAnatomy, AnatomyPart, ChunkInfo } from './analysis/anatomy.js';
export { vmAnatomy, formatAnatomy };
export type { VmAnatomy, AnatomyPart, ChunkInfo };
/** static map of how the script boots, runs and exits (payload → deserializer → wrapper → interpreter → exits → entry) */
export function anatomy(src: string, opts: { clean?: boolean | CleanOptions; maxChunks?: number } = {}): VmAnatomy & { code?: string } {
  const code = opts.clean ? clean(src, typeof opts.clean === 'object' ? opts.clean : { rename: 'obfuscated' }).code : undefined;
  const { chunk } = parse(code ?? src);
  return { ...vmAnatomy(chunk, { maxChunks: opts.maxChunks }), code };
}
export type { RenameRequest, RenameApplied, RenameSymbolsResult } from './passes/manualrename.js';

/** constant-fold a single expression (number/bit/string junk) — e.g. "bit32.bxor(0x5A ^ 3, 7) + #'abc'" */
export function simplifyExpression(expr: string, opts: CleanOptions = {}): { result: string; changed: boolean } {
  const src = 'return ' + expr;
  const out = clean(src, { rename: 'none', removeUnusedLocals: false, ...opts }).code.trim();
  const result = out.replace(/^return\s+/, '').replace(/;$/, '');
  return { result, changed: result.replace(/\s+/g, '') !== expr.replace(/\s+/g, '') };
}

// ------------------------------------------------------------------ VM specialiser (devirtualiser)
export { astRewrite, globalsFromEnv, compileRules, specializeVM, findVmShape, selectHandler, LuaDump, collectPatches, resolvePatchedReads };
export { vmBootProgram, vmFactoryInfo, helperWrapperRules } from './vm/boot.js';
export type { VmBootOptions, VmBootResult, VmFactoryInfo, WrapperRules } from './vm/boot.js';
export type { RewriteRule, SpecializeOptions, SpecializeResult, VmShape, PatchSpec };
export interface VmSpecializeOptions extends SpecializeOptions {
  /** extra expression rewrite rules applied after cleaning (metavariables: __name) */
  rewrites?: RewriteRule[];
  /** skip cleaning (raw residual state machines) */
  raw?: boolean;
  rounds?: number;
  rename?: RenameMode;
  /** unflattener limits (defaults tuned for residual VM code) */
  unflatten?: UnflattenOptions;
  /** rounds of run-time patch discovery for self-modifying bytecode (default 6, 0 = off) */
  patchRounds?: number;
  /** promote the interpreter's register table to locals in the residual code (default on) */
  registers?: boolean;
  /** substitute constant tables handed between protos (argument / upvalue pools of literals and globals; default on) */
  constPools?: boolean;
  /** write the dump records the residual program reads (`K_n` constant tables) into the output as Lua
   *  literals, so the lifted file runs on its own instead of needing an external harness (default on) */
  emitRecords?: boolean;
  /** development hook: the cleaned residual protos before the patched-read resolution */
  onStage?: (stage: { makeTarget: string | null; records: string[]; protos: Array<{ id: string; code: string }>; patches: PatchSpec[]; helper?: string; pureSlots: Array<[string, number[]]> }) => void;
}
export interface VmSpecializedProto { id: string; instrs: number; blocks: number; code: string; structured: boolean; notes: string[]; stats?: CleanStats; }
export interface VmSpecializeResult { ok: boolean; notes: string[]; protos: VmSpecializedProto[]; code: string; patches: PatchSpec[]; }
const patchKey = (p: PatchSpec) => p.table + '|' + (p.anyKey || p.key === undefined ? '*' : (typeof p.key === 'number' ? 'n:' + p.key : 's:' + p.key));
/** merge patch lists; reports whether anything new was added */
function mergePatches(base: PatchSpec[], extra: PatchSpec[]): { list: PatchSpec[]; changed: boolean } {
  const m = new Map<string, PatchSpec>();
  for (const p of base) m.set(patchKey(p), { ...p, values: p.values.slice() });
  let changed = false;
  for (const p of extra) {
    const k = patchKey(p); const e = m.get(k);
    if (!e) { m.set(k, { ...p, values: p.values.slice() }); changed = true; continue; }
    for (const v of p.values) if (!e.values.some(x => x === v)) { e.values.push(v); changed = true; }
    if (p.dynamic && !e.dynamic) { e.dynamic = true; changed = true; }
  }
  return { list: [...m.values()], changed };
}
/** Devirtualise: residual program of the VM interpreter for every dumped proto, cleaned + structured.
 *  Self-modifying bytecode: stores into dump records found in the cleaned residual code are fed back
 *  (patch discovery rounds) — patched instructions get one variant per written value, and reads of a
 *  patched slot that are dominated by its store are resolved statically. */
export function vmSpecialize(src: string, dumpJson: unknown, opts: VmSpecializeOptions = {}): VmSpecializeResult {
  const rules = opts.rewrites?.length ? compileRules(opts.rewrites) : [];
  let patches: PatchSpec[] = (opts.patches ?? []).slice();
  const maxRounds = opts.raw ? 0 : (opts.patchRounds ?? 6);
  const patchNotes: string[] = [];
  const canon = (l: PatchSpec[]) => l.map(p => patchKey(p) + '=' + [...p.values].map(v => JSON.stringify(v)).sort().join(',') + (p.dynamic ? '+dyn' : '')).sort().join(';');
  let checked: PatchSpec[] = [];
  for (let outer = 0; ; outer++) {
    // patch discovery on the residual blocks: the stores into dump records reachable under the current
    // patch set become the next patch set, until it reproduces itself (least fixpoint from the user's patches)
    let r: ReturnType<typeof specializeVM> | null = null;
    if (maxRounds > 0) {
      const seen = new Set<string>();
      for (let round = 0; round < maxRounds * 2; round++) {
        r = specializeVM(src, dumpJson, { ...opts, patches, discover: true });
        if (!r.ok) break;
        const next = mergePatches(mergePatches(opts.patches ?? [], checked).list, r.discovered ?? []).list;
        const cur = canon(patches), nx = canon(next);
        if (nx === cur) break;
        r = null;
        if (seen.has(nx)) { patchNotes.push(`patch rounds oscillate: union of the last two patch sets used`); patches = mergePatches(patches, next).list; break; }
        seen.add(cur);
        patchNotes.push(`patch round ${patchNotes.length + 1}: ${next.length} written slot(s) of dump records (${next.filter(p => p.dynamic).length} with computed values)`);
        patches = next;
      }
    }
    if (!r) r = specializeVM(src, dumpJson, { ...opts, patches });
    const out: VmSpecializeResult = { ok: r.ok, notes: r.notes.slice(), protos: [], code: '', patches };
    if (!r.ok || !r.shape) return out;
    const R = r;
    const makeTarget = r.shape.makeTarget;
    const pcVar = r.shape.pcVar;
    const recordId = (nm: string): string | null => { if (!R.constNames.has(nm)) return null; const m = /^(?:K|PROTO)_(.+)$/.exec(nm); return m ? m[1] : null; };
    // the interpreter's varargs-pack helper(s), recognised structurally in the source
    let packHelpers: Set<string> = new Set();
    let srcChunk: A.Chunk | null = null;
    if (!opts.raw) { try { srcChunk = parse(src).chunk; packHelpers = findPackHelpers(srcChunk); } catch { /* none */ } }
    const packHelper = packHelpers.size ? (e: A.Expr) => packHelpers.has(printExpr(e)) : undefined;
    // stage 1: clean every residual proto (state machines unflattened)
    const stage: Array<{ p: typeof r.protos[number]; chunk: A.Chunk | null; stats?: CleanStats; why: Set<string>; unflatten: UnflattenOptions }> = [];
    for (const p of r.protos) {
      const why = new Set<string>();
      const unflatten: UnflattenOptions = { maxGrowth: 4, maxStates: 20000, ...opts.unflatten, onFail: (m) => { why.add(m); opts.unflatten?.onFail?.(m); } };
      if (opts.raw) { stage.push({ p, chunk: null, why, unflatten }); continue; }
      const c1 = clean(p.code, { rename: 'none', unrollFor: 8, rounds: opts.rounds ?? 16, constGlobals: r.hooks.constGlobals, constIndex: r.hooks.constIndex, constLen: r.hooks.constLen, unflatten });
      stage.push({ p, chunk: parse(c1.code).chunk, stats: c1.stats, why, unflatten });
    }
    // consistency check: stores into dump records left in the cleaned code that the patch set does not cover
    if (maxRounds > 0 && outer < 3) {
      const found: PatchSpec[] = [];
      for (const s of stage) if (s.chunk) found.push(...collectPatches(s.chunk, recordId));
      const have = new Map(patches.map(p => [patchKey(p), p]));
      const extra: PatchSpec[] = [];
      for (const f of found) {
        const h = have.get(patchKey(f)) ?? have.get(f.table + '|*');
        if (h && (h.anyKey || h.key === undefined)) continue;
        const lits = f.values.filter(v => !h || !h.values.some(x => x === v));
        if (!h || lits.length) extra.push({ ...f, values: lits, dynamic: !h && f.dynamic });
      }
      if (extra.length) { patchNotes.push(`patch check: ${extra.length} store(s) found in the cleaned code outside the patch set (${extra.slice(0, 8).map(e => `K_${e.table}[${e.anyKey ? '*' : JSON.stringify(e.key)}]`).join(', ')}) — another round`); checked = mergePatches(checked, extra).list; patches = mergePatches(patches, extra).list; continue; }
    }
    // static resolution of patched-slot reads (store dominates the read)
    if (!opts.raw && patches.length) {
      const createdProto = (c: A.CallExpr): string | null => {
        const a0 = c.args[0];
        if (makeTarget && printExpr(c.callee) === makeTarget && a0 && a0.type === 'NameExpr' && /^PROTO_/.test(a0.name)) return a0.name.slice(6);
        if (c.callee.type === 'IndexExpr' && c.callee.obj.type === 'NameExpr' && c.callee.obj.name === 'PROTOS' && c.callee.index.type === 'NumberLit') return String(c.callee.index.value);
        return null;
      };
      // dump values of the records before the program runs (one-time patch flags must start elsewhere)
      const recTable = new Map<string, unknown>();
      for (const [nm, v] of R.constNames) { const id = recordId(nm); if (id !== null && R.dump.isTable(v)) recTable.set(id, v); }
      const initial = (tid: string, key: string | number | boolean | null): { ok: boolean; v: string | number | boolean | null } => {
        const t = recTable.get(tid); if (t === undefined || key === null || typeof key === 'boolean') return { ok: false, v: null };
        const sc = R.dump.scalar(R.dump.get(t, key));
        return sc.kind === 'nil' ? { ok: true, v: null } : (sc.kind === 'num' || sc.kind === 'str' || sc.kind === 'bool') ? { ok: true, v: sc.value } : { ok: false, v: null };
      };
      // helper slots that only read some table arguments (the interpreter's unpack helpers): the register
      // table handed to them stays private to the frame
      let pureReader: ((c: A.Expr) => Set<number> | null) | undefined;
      if (opts.helper && srcChunk) {
        let ht: unknown = R.dump.root;
        for (const q of opts.helper.path.split(/[./]/).filter(Boolean)) ht = R.dump.get(ht, /^\d+$/.test(q) ? Number(q) : q);
        const slotVal = (k: string) => { const key: string | number = /^-?\d+(\.\d+)?$/.test(k) ? Number(k) : JSON.parse(k); return R.dump.scalar(R.dump.get(ht, key)); };
        const libOf = (k: string): string | null => { const sc = slotVal(k); return sc.kind === 'fn' && !/^_fn\d+$/.test(sc.name) ? sc.name : null; };
        const slots = findPureReaderSlots(srcChunk, libOf);
        const written = new Set<string>();
        for (const s of stage) if (s.chunk) walk(s.chunk, (m: any) => { if (m.type !== 'AssignStat') return; for (const t of m.targets) if (t.type === 'IndexExpr' && t.obj.type === 'NameExpr' && t.obj.name === opts.helper!.name) written.add(t.index.type === 'NumberLit' ? String(t.index.value) : t.index.type === 'StringLit' ? JSON.stringify(t.index.value) : '*'); });
        if (slots.size && !written.has('*')) pureReader = (c: A.Expr) => {
          if (c.type !== 'IndexExpr' || c.obj.type !== 'NameExpr' || c.obj.name !== opts.helper!.name) return null;
          const k = c.index.type === 'NumberLit' ? String(c.index.value) : c.index.type === 'StringLit' ? JSON.stringify(c.index.value) : null;
          if (k === null || written.has(k)) return null;
          const sc = slotVal(k); if (sc.kind !== 'fn' || !/^_fn\d+$/.test(sc.name)) return null;
          return slots.get(k) ?? null;
        };
      }
      opts.onStage?.({ makeTarget, records: [...R.constNames.keys()], protos: stage.filter(s => s.chunk).map(s => ({ id: s.p.id, code: print(s.chunk!) })), patches, helper: opts.helper?.name, pureSlots: pureReader ? [...findPureReaderSlots(srcChunk!, (k) => { let ht: unknown = R.dump.root; for (const q of opts.helper!.path.split(/[./]/).filter(Boolean)) ht = R.dump.get(ht, /^\d+$/.test(q) ? Number(q) : q); const sc = R.dump.scalar(R.dump.get(ht, /^-?\d+$/.test(k) ? Number(k) : JSON.parse(k))); return sc.kind === 'fn' && !/^_fn\d+$/.test(sc.name) ? sc.name : null; })].map(([k, v]) => [k, [...v]]) : [] });
      const rs = resolvePatchedReads(stage.filter(s => s.chunk).map(s => ({ id: s.p.id, chunk: s.chunk! })), patches, { recordId, createdProto, initial, pureReader });
      patchNotes.push(...rs.notes);
    }
    const codes: Array<{ s: typeof stage[number]; code: string; cleaned: boolean }> = [];
    let multretTotal = 0;
    for (const s of stage) {
      const p = s.p;
      let code = p.code;
      if (s.chunk) {
        const chunk = s.chunk;
        // closure creation through the maker: MAKER(PROTO_n, upvalues…) -> PROTOS[n](upvalues…)
        if (makeTarget) walk(chunk, (m: any) => {
          if (m.type !== 'CallExpr' || !m.args.length) return;
          if (printExpr(m.callee) !== makeTarget) return;
          const a0 = m.args[0];
          if (a0.type !== 'NameExpr' || !/^PROTO_/.test(a0.name)) return;
          const id = a0.name.slice(6);
          m.callee = { type: 'IndexExpr', obj: { type: 'NameExpr', name: 'PROTOS' }, index: /^\d+$/.test(id) ? { type: 'NumberLit', value: Number(id), raw: id } : { type: 'StringLit', value: id, raw: JSON.stringify(id) } };
          m.args = m.args.slice(1);
        });
        globalsFromEnv(chunk);
        if (rules.length) astRewrite(chunk, rules);
        const dbg = (globalThis as any).__prismDebugStage; if (typeof dbg === 'function') dbg(p.id, 'c2-input', print(chunk));
        const c2 = clean(print(chunk), { rename: opts.rename ?? 'none', unrollFor: 8, rounds: opts.registers === false ? 6 : 10, constGlobals: r.hooks.constGlobals, constIndex: r.hooks.constIndex, constLen: r.hooks.constLen, unflatten: s.unflatten, promoteRegisters: opts.registers !== false, pureIndex: true, packHelper: opts.registers !== false ? packHelper : undefined });
        code = c2.code;
        multretTotal += c2.stats.multret ?? 0;
      }
      codes.push({ s, code, cleaned: !!s.chunk });
    }
    // whole-program passes over the cleaned protos: constant pools handed from proto to proto (argument / upvalue
    // tables built from literals and globals), dump records the residual program no longer observes
    if (!opts.raw && codes.some(c => c.cleaned)) {
      try {
        const pcs = codes.filter(c => c.cleaned).map(c => ({ c, id: c.s.p.id, chunk: parse(c.code).chunk }));
        const changed = new Set<string>();
        if (opts.constPools !== false) {
          const cp = substituteConstPools(pcs.map(x => ({ id: x.id, chunk: x.chunk })), { isPack: (e) => packHelpers.has(printExpr(e)) });
          patchNotes.push(...cp.notes);
          for (const id of cp.changed) changed.add(id);
        }
        if (maxRounds > 0) {
          let foldedGuards = 0;
          for (const x of pcs) {
            const n = foldIdempotentGuards(x.chunk, recordId, print);
            if (n) { foldedGuards += n; changed.add(x.id); }
          }
          if (foldedGuards) patchNotes.push(`${foldedGuards} idempotent record guard(s) folded`);
          const rc = dropUnobservedRecords(pcs.map(x => ({ id: x.id, chunk: x.chunk })), recordId);
          patchNotes.push(...rc.notes);
          for (const id of rc.changed) changed.add(id);
        }
        for (const x of pcs) {
          if (!changed.has(x.id)) continue;
          const c3 = clean(print(x.chunk), { rename: opts.rename ?? 'none', unrollFor: 8, rounds: 6, constGlobals: r.hooks.constGlobals, constIndex: r.hooks.constIndex, constLen: r.hooks.constLen, unflatten: x.c.s.unflatten, promoteRegisters: false, pureIndex: true, packHelper: opts.registers !== false ? packHelper : undefined });
          x.c.code = c3.code;
          multretTotal += c3.stats.multret ?? 0;
        }
      } catch (e) { patchNotes.push('whole-program passes: skipped (' + String((e as Error)?.message ?? e).slice(0, 120) + ')'); }
    }
    if (multretTotal) patchNotes.push(`${multretTotal} multiple-results / varargs register range(s) fused back into calls, returns, assignments and table constructors (registers above an instruction's operands are taken as dead after it, as in compiled code)`);
    for (const { s, code, cleaned } of codes) {
      const p = s.p;
      // structured = no dispatcher loop on the state variable left
      const structured = cleaned && !new RegExp('\\b' + pcVar + '\\s*(<|==|~=|>)').test(code);
      const notes = p.notes.slice();
      if (!structured && s.why.size) notes.push(...[...s.why].slice(0, 5).map(w => 'unflatten: ' + w));
      out.protos.push({ id: p.id, instrs: p.instrs, blocks: p.blocks, code, structured, notes, stats: s.stats });
    }
    out.notes.push(...patchNotes);
    const patchLines = patches.length ? ['-- run-time written slots of dump records (self-modifying bytecode): ' + patches.length, ...patches.slice(0, 400).map(ps => `--   K_${ps.table}[${ps.anyKey || ps.key === undefined ? '*' : JSON.stringify(ps.key)}] <- ${ps.values.map(v => JSON.stringify(v)).join(' | ')}${ps.dynamic ? ' | <computed>' : ''}`)] : [];
    // the dump records the residual program actually reads, written out as Lua data: without this the
    // lifted file references K_n / PROTO_n names that nothing defines and cannot run outside PRISM.
    // They live in ONE holder table (R) because one local per record blows past Luau's 200-upvalue limit.
    let recordLines: string[] = [];
    let helperLine = '';
    let protoBody = out.protos.map(p => `-- proto ${p.id}: ${p.instrs} instructions, ${p.blocks} blocks${p.structured ? ', structured' : ', state machine kept'}\n` + p.code).join('\n');
    if (opts.emitRecords !== false) {
      // the interpreter's helper table itself: its library slots are real functions, the slots the program
      // writes start empty exactly as in the loader — without it every residual proto reads a nil table
      const hn = opts.helper?.name;
      if (hn && /^[A-Za-z_][A-Za-z0-9_]*$/.test(hn)) {
        try {
          let hv: unknown = R.dump.root;
          for (const q of (opts.helper!.path ?? hn).split(/[./]/).filter(Boolean)) hv = R.dump.get(hv, /^\d+$/.test(q) ? Number(q) : q);
          const s = luaForValue(R.dump, hv, { maxDepth: 5 });
          if (s) { helperLine = `-- helper table "${hn}" recovered from the dump (library slots are the real functions; slots the program writes start empty)\nlocal ${hn} = ${s}`; out.notes.push(`helper table "${hn}" written into the output`); }
        } catch { /* not in the dump — leave it free */ }
      }
      const er = emitRecordTables(protoBody, R.constNames, R.dump, { maxDepth: opts.raw ? 3 : 6 });
      if (er.emitted.length) {
        recordLines = ['', '-- data of the decoded chunk (dump records the program below reads)', er.lua];
        protoBody = out.protos.map(p => `-- proto ${p.id}: ${p.instrs} instructions, ${p.blocks} blocks${p.structured ? ', structured' : ', state machine kept'}\n` + rewriteRecordRefs(p.code)).join('\n');
        out.notes.push(`${er.emitted.length} dump record(s) written into the output as Lua data (self-contained lift)`);
      }
      const missing = er.skipped.filter(x => x.why !== 'not in the dump');
      if (missing.length) out.notes.push(`${missing.length} record reference(s) not written as data: ${missing.slice(0, 6).map(m => m.name + ' (' + m.why + ')').join(', ')}`);
      if (er.skipped.some(x => x.why === 'not in the dump')) out.notes.push(`${er.skipped.filter(x => x.why === 'not in the dump').length} referenced record name(s) are not in the dump`);
    }
    out.code = ['-- PRISM vm_specialize: residual program of the VM interpreter (one maker per proto).',
      '-- PROTOS[n](upvalues) returns the closure for proto n; R holds the decoded chunk\'s records (R[n] = constants of proto n, R["Pn"] = its record).',
      ...out.notes.map(n => '-- ' + n), ...patchLines, 'local PROTOS = {}', ...(helperLine ? ['', helperLine] : []), ...recordLines, '', protoBody].join('\n');
    return out;
  }
}
export { makeReadable, isIdent, type ReadableStats } from './passes/readable.js';
export { inlineTemps } from './passes/inlinetemps.js';
export { foldTables } from './passes/tablefold.js';
export { recoverForLoops } from './passes/forloops.js';
export { pruneLocals } from './passes/prunelocals.js';
