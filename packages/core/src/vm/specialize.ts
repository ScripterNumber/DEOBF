// VM specialiser — devirtualisation by partial evaluation (first Futamura projection).
//
// Given the source of a register VM interpreter and a dump of its proto records (instruction
// arrays + constants, e.g. captured by a Python-port dump hook), every instruction is replaced by
// its handler with the operands fixed: `F[pc]` reads of the proto field arrays become literals, the
// opcode dispatch is resolved, self-modifying opcode stores are dropped and `pc = X` jumps become
// literal state transfers. The residual program is ordinary Lua: one function per proto whose body
// is a state machine over basic blocks — exactly the shape PRISM's CFF unflattener structures back
// into if/while code. Nothing is executed; nothing is obfuscator-specific: the interpreter layout
// (fetch `local op = OPS[pc]`, dispatch tree, `pc += 1`, closure maker `function(proto, upv, …)`,
// optional pcall wrapper with an epilogue that interprets the handler's return values) is
// recognised structurally.
import type * as A from '../ast.js';
import { walk } from '../ast.js';
import { parse } from '../parser.js';
import { print } from '../printer.js';
import { fold } from '../passes/fold.js';
import { eliminateDeadCode } from '../passes/deadcode.js';
import { LuaDump, literalExpr, pathExpr, numRaw } from './dump.js';
import { PatchModel, analyzeBlockGraph, creationOrder, capturedNames, intersect, slotKey, evalLit, foldTrampolines } from './patches.js';
import type { Known, Lit } from './patches.js';
import { devEnv } from '../env.js';
import { analyzeScopes } from '../analysis/scope.js';

const unparen = (e: A.Expr): A.Expr => { while (e && e.type === 'ParenExpr') e = e.expr; return e; };
const clone = <T>(x: T): T => structuredClone(x);
const num = (v: number): A.Expr => v < 0 ? { type: 'UnExpr', op: '-', expr: { type: 'NumberLit', value: -v, raw: numRaw(-v) } } : { type: 'NumberLit', value: v, raw: numRaw(v) };
const name = (n: string): A.NameExpr => ({ type: 'NameExpr', name: n });
const isName = (e: A.Expr | undefined, n?: string): e is A.NameExpr => !!e && e.type === 'NameExpr' && (n === undefined || e.name === n);

export interface VmShape {
  /** interpreter loop and its parts */
  loop: A.RepeatStat | A.WhileStat;
  opVar: string; opsVar: string; pcVar: string;
  dispatch: A.Stat[];
  loopFn: A.FunctionExpr; runFn: A.FunctionExpr; makeFn: A.FunctionExpr;
  protoParam: string;
  /** local name -> proto field key */
  fieldVars: Map<string, number | string>;
  opsKey: number | string;
  prologue: A.Stat[];
  loopPre: A.Stat[];
  /** pcall-style wrapper: `local ok, a, b, c = pcall(loopFn)` + epilogue */
  wrapped: boolean;
  resultNames: string[];
  epilogue: A.Stat[];
  /** printed expression the closure maker is stored in (e.g. `H[57]`), if any */
  makeTarget: string | null;
  notes: string[];
}

interface ParentInfo { parent: any; key: string; index: number; }
function parentMap(root: any): Map<any, ParentInfo> {
  const m = new Map<any, ParentInfo>();
  const visit = (node: any, parent: any, key: string, index: number) => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) { node.forEach((x, i) => visit(x, parent, key, i)); return; }
    if (typeof node.type !== 'string') return;
    m.set(node, { parent, key, index });
    for (const k of Object.keys(node)) {
      if (k === 'loc') continue;
      const v = node[k];
      if (k === 'clauses' && Array.isArray(v)) { v.forEach((c: any, ci: number) => { visit(c.cond, node, 'clauses.' + ci + '.cond', -1); visit(c.body, node, 'clauses.' + ci + '.body', -1); }); continue; }
      if (k === 'fields' && Array.isArray(v)) { v.forEach((f: any) => { if (f.key) visit(f.key, node, 'fields', -1); visit(f.value, node, 'fields', -1); }); continue; }
      visit(v, node, k, -1);
    }
  };
  visit(root, null, '', -1);
  return m;
}
function enclosingFn(pm: Map<any, ParentInfo>, node: any): A.FunctionExpr | null {
  let p = pm.get(node)?.parent;
  while (p) { if (p.type === 'FunctionExpr') return p; p = pm.get(p)?.parent; }
  return null;
}
/** the statement of fn.body that contains node */
function topStatIn(pm: Map<any, ParentInfo>, fn: A.FunctionExpr, node: any): number {
  let cur = node;
  while (cur) {
    const info = pm.get(cur); if (!info) return -1;
    if (info.parent === fn && info.key === 'body') return info.index;
    cur = info.parent;
  }
  return -1;
}

function isIncrement(s: A.Stat | undefined, pc: string): boolean {
  if (!s || s.type !== 'AssignStat' || s.targets.length !== 1 || !isName(s.targets[0], pc) || s.values.length !== 1) return false;
  const v = unparen(s.values[0]);
  if (s.op) return s.op.replace(/=$/, '') === '+' && v.type === 'NumberLit' && v.value === 1;
  if (v.type !== 'BinExpr' || v.op !== '+') return false;
  const l = unparen(v.left), r = unparen(v.right);
  return (isName(l, pc) && r.type === 'NumberLit' && r.value === 1) || (isName(r, pc) && l.type === 'NumberLit' && l.value === 1);
}

/** locate the interpreter structure; null + notes when the layout is not recognised */
export function findVmShape(chunk: A.Chunk): { shape: VmShape | null; notes: string[] } {
  const notes: string[] = [];
  const pm = parentMap(chunk);
  const cands: Array<{ loop: A.RepeatStat | A.WhileStat; size: number }> = [];
  walk(chunk, (m: any) => {
    if (m.type !== 'RepeatStat' && m.type !== 'WhileStat') return;
    const c = unparen(m.cond);
    if (m.type === 'RepeatStat' && c.type !== 'FalseLit' && c.type !== 'NilLit') return;
    if (m.type === 'WhileStat' && c.type !== 'TrueLit') return;
    const b: A.Stat[] = m.body;
    if (b.length < 3) return;
    const f = b[0];
    if (f.type !== 'LocalStat' || f.names.length !== 1 || f.init.length !== 1) return;
    const ix = unparen(f.init[0]);
    if (ix.type !== 'IndexExpr' || !isName(unparen(ix.obj)) || !isName(unparen(ix.index))) return;
    const pc = (unparen(ix.index) as A.NameExpr).name;
    if (!isIncrement(b[b.length - 1], pc)) return;
    let size = 0; walk(b, () => { size++; });
    cands.push({ loop: m, size });
  });
  if (!cands.length) { notes.push('no interpreter loop of the form `local op = OPS[pc]; <dispatch>; pc += 1` found'); return { shape: null, notes }; }
  cands.sort((a, b) => b.size - a.size);
  const loop = cands[0].loop;
  const fetch = loop.body[0] as A.LocalStat;
  const ix = unparen(fetch.init[0]) as A.IndexExpr;
  const opVar = fetch.names[0], opsVar = (unparen(ix.obj) as A.NameExpr).name, pcVar = (unparen(ix.index) as A.NameExpr).name;
  const loopFn = enclosingFn(pm, loop);
  if (!loopFn) { notes.push('interpreter loop is not inside a function'); return { shape: null, notes }; }
  const loopIdx = topStatIn(pm, loopFn, loop);
  // pcall-style wrapper?
  let wrapped = false, resultNames: string[] = [], epilogue: A.Stat[] = [], prologue: A.Stat[] = [], loopPre: A.Stat[] = [];
  let runFn: A.FunctionExpr = loopFn;
  const lp = pm.get(loopFn);
  if (lp && lp.parent && lp.parent.type === 'CallExpr' && lp.key === 'args') {
    const call = lp.parent as A.CallExpr;
    const cp = pm.get(call);
    const holder = cp?.parent;
    const outer = enclosingFn(pm, call);
    if (outer && holder && holder.type === 'LocalStat' && holder.init.length === 1 && unparen(holder.init[0]) === call) {
      const idx = topStatIn(pm, outer, holder);
      if (idx >= 0 && outer.body[idx] === holder) {
        wrapped = true; runFn = outer; resultNames = holder.names.slice();
        prologue = outer.body.slice(0, idx); epilogue = outer.body.slice(idx + 1);
        loopPre = loopFn.body.slice(0, loopIdx);
        const after = loopFn.body.slice(loopIdx + 1);
        if (after.length) notes.push(`${after.length} statement(s) after the interpreter loop ignored (unreachable)`);
        notes.push(`interpreter runs inside a protected call (${print({ type: 'Chunk', body: [{ type: 'CallStat', expr: { ...call, args: [] } } as any] }).trim().replace(/;$/, '')}); handler returns are routed through its ${epilogue.length}-statement epilogue`);
      }
    }
  }
  if (!wrapped) { prologue = loopFn.body.slice(0, loopIdx); epilogue = []; }
  const makeFn = enclosingFn(pm, runFn);
  if (!makeFn || !makeFn.params.length) { notes.push('no closure maker `function(proto, upvalues, …)` around the interpreter'); return { shape: null, notes }; }
  const protoParam = makeFn.params[0];
  const fieldVars = new Map<string, number | string>();
  const scanFields = (stmts: A.Stat[]) => {
    for (const s of stmts) {
      if (s.type !== 'LocalStat') continue;
      s.names.forEach((nm, q) => {
        const e = s.init[q]; if (!e || (q === s.init.length - 1 && s.init.length < s.names.length)) return;
        const u = unparen(e);
        if (u.type === 'IndexExpr' && isName(unparen(u.obj), protoParam)) {
          const k = unparen(u.index);
          if (k.type === 'NumberLit') fieldVars.set(nm, k.value); else if (k.type === 'StringLit') fieldVars.set(nm, k.value);
        } else if (u.type === 'MemberExpr' && isName(unparen(u.obj), protoParam)) fieldVars.set(nm, u.name);
      });
    }
  };
  scanFields(makeFn.body); scanFields(prologue);
  if (!fieldVars.has(opsVar)) { notes.push(`opcode array '${opsVar}' is not a field of the proto parameter '${protoParam}'`); return { shape: null, notes }; }
  let makeTarget: string | null = null;
  const mp = pm.get(makeFn);
  if (mp?.parent?.type === 'AssignStat' && mp.key === 'values') { const t = (mp.parent as A.AssignStat).targets[mp.index]; if (t) makeTarget = printExpr(t); }
  else if (mp?.parent?.type === 'LocalStat' && mp.key === 'init') makeTarget = (mp.parent as A.LocalStat).names[mp.index] ?? null;
  else if (mp?.parent?.type === 'LocalFunctionStat') makeTarget = (mp.parent as A.LocalFunctionStat).name;
  else if (mp?.parent?.type === 'FunctionStat') makeTarget = printExpr((mp.parent as A.FunctionStat).target);
  const shape: VmShape = {
    loop, opVar, opsVar, pcVar, dispatch: loop.body.slice(1, -1), loopFn, runFn, makeFn, protoParam, fieldVars, opsKey: fieldVars.get(opsVar)!,
    prologue, loopPre, wrapped, resultNames, epilogue, makeTarget, notes,
  };
  notes.push(`interpreter: fetch ${opVar} = ${opsVar}[${pcVar}] @L${fetch.loc?.line ?? '?'}; proto param '${protoParam}', fields ${[...fieldVars].map(([v, k]) => `${v}=[${k}]`).join(' ')}${makeTarget ? `; closure maker stored in ${makeTarget}` : ''}`);
  return { shape, notes };
}
export function printExpr(e: A.Expr): string {
  return print({ type: 'Chunk', body: [{ type: 'ReturnStat', args: [e] }] } as any).trim().replace(/^return\s+/, '').replace(/;$/, '');
}

// ------------------------------------------------------------------ opcode selection
type V = number | boolean | null | undefined;  // undefined = unknown
function evalOn(e: A.Expr, opVar: string, op: number): V {
  const u = unparen(e);
  switch (u.type) {
    case 'NumberLit': return u.value;
    case 'TrueLit': return true;
    case 'FalseLit': return false;
    case 'NilLit': return null;
    case 'NameExpr': return u.name === opVar ? op : undefined;
    case 'UnExpr': {
      const v = evalOn(u.expr, opVar, op);
      if (v === undefined) return undefined;
      if (u.op === 'not') return v === false || v === null;
      if (u.op === '-' && typeof v === 'number') return -v;
      return undefined;
    }
    case 'IfExpr': {
      for (const c of u.clauses) { const v = evalOn(c.cond, opVar, op); if (v === undefined) return undefined; if (v !== false && v !== null) return evalOn(c.value, opVar, op); }
      return evalOn(u.elseValue, opVar, op);
    }
    case 'BinExpr': {
      if (u.op === 'and' || u.op === 'or') {
        const a = evalOn(u.left, opVar, op); if (a === undefined) return undefined;
        const t = a !== false && a !== null;
        if (u.op === 'and') return t ? evalOn(u.right, opVar, op) : a;
        return t ? a : evalOn(u.right, opVar, op);
      }
      const a = evalOn(u.left, opVar, op), b = evalOn(u.right, opVar, op);
      if (typeof a !== 'number' || typeof b !== 'number') {
        if ((u.op === '==' || u.op === '~=') && a !== undefined && b !== undefined) return (a === b) === (u.op === '==');
        return undefined;
      }
      switch (u.op) {
        case '<': return a < b; case '<=': return a <= b; case '>': return a > b; case '>=': return a >= b;
        case '==': return a === b; case '~=': return a !== b;
        case '+': return a + b; case '-': return a - b; case '*': return a * b;
        case '%': return a - Math.floor(a / b) * b;
      }
      return undefined;
    }
  }
  return undefined;
}
/** the statements executed for opcode `op` (decidable tests on the opcode variable resolved) */
export function selectHandler(stmts: A.Stat[], opVar: string, op: number): A.Stat[] {
  const out: A.Stat[] = [];
  for (const s of stmts) {
    if (s.type !== 'IfStat') { out.push(s); continue; }
    let done = false;
    for (let ci = 0; ci < s.clauses.length; ci++) {
      const v = evalOn(s.clauses[ci].cond, opVar, op);
      if (v === undefined) {
        out.push({ ...s, clauses: s.clauses.slice(ci).map(c => ({ cond: c.cond, body: selectHandler(c.body, opVar, op) })), elseBody: s.elseBody ? selectHandler(s.elseBody, opVar, op) : undefined });
        done = true; break;
      }
      if (v !== false && v !== null) { out.push(...selectHandler(s.clauses[ci].body, opVar, op)); done = true; break; }
    }
    if (!done && s.elseBody) out.push(...selectHandler(s.elseBody, opVar, op));
  }
  return out;
}

// ------------------------------------------------------------------ protos
export interface ProtoRef { id: string; value: unknown; instrs: number; }
export function findProtos(dump: LuaDump, shape: VmShape, rootPath?: string): ProtoRef[] {
  const keys = [...new Set(shape.fieldVars.values())];
  const isCand = (t: unknown): boolean => {
    const ops = dump.get(t, shape.opsKey as any);
    if (!dump.isTable(ops)) return false;
    const n = dump.len(ops); if (!n) return false;
    for (let i = 1; i <= Math.min(n, 64); i++) if (dump.scalar(dump.get(ops, i)).kind !== 'num') return false;
    return true;
  };
  // field-kind signature (table / number / string / nil per field key): every proto record has
  // the layout of the largest one; look-alike tables (e.g. lists of pairs) are rejected
  const sig = (t: unknown) => keys.map(k => { const v = dump.get(t, k as any); return v === undefined || v === null ? '-' : dump.isTable(v) ? 't' : dump.scalar(v).kind[0]; }).join('');
  let start: unknown = dump.root;
  if (rootPath) for (const p of rootPath.split(/[./]/).filter(Boolean)) start = dump.get(start, /^\d+$/.test(p) ? Number(p) : p) ?? (dump.deref(start) as any)?.[p];
  const cands = dump.tables(start).filter(isCand).map(t => ({ t, n: dump.len(dump.get(t, shape.opsKey as any)), s: sig(t) }));
  if (!cands.length) return [];
  const best = cands.reduce((a, b) => b.n > a.n ? b : a);
  const out: ProtoRef[] = [];
  for (const c of cands) if (c.s === best.s) out.push({ id: dump.tableId(c.t), value: c.t, instrs: c.n });
  // stable order: numeric ids ascending
  out.sort((a, b) => (Number(a.id) || 0) - (Number(b.id) || 0));
  return out;
}

// ------------------------------------------------------------------ specialisation
export interface SpecializeOptions {
  /** dump path of the root proto / of the search start (default: whole dump) */
  root?: string;
  /** helper table: the interpreter's name for it and its dump path; library functions stored
   *  in it (recorded as {"$fn": "table.create"}) are substituted for `name[k]` reads */
  helper?: { name: string; path: string };
  /** only these proto ids */
  only?: string[];
  maxProtos?: number;
  maxInstrs?: number;
  /** run-time writes into dump records (self-modifying bytecode): such slots are never folded, and an
   *  instruction whose opcode/operand slot is written gets one specialised variant per possible value,
   *  selected by reading the slot at run time */
  patches?: PatchSpec[];
  /** run the reachability/patch analysis even without patches and report the stores into dump
   *  records found in the reachable residual code (`discovered`) */
  discover?: boolean;
  /** inspection hook: the residual blocks of every proto after the patch analysis (before emission) */
  onBlocks?: (protoId: string, blocks: Map<number, A.Stat[]>, pcVar: string) => void;
}
/** a slot of a dump table written by the program: `table` is the dump id, values are the written literals */
export interface PatchSpec { table: string; key?: number | string; /** written with a non-constant key: every slot */ anyKey?: boolean; values: Array<number | string | boolean | null>; dynamic?: boolean; }
export interface SpecializedProto { id: string; name: string; instrs: number; blocks: number; code: string; notes: string[]; }
export interface SpecializeResult {
  ok: boolean; notes: string[]; shape?: VmShape;
  protos: SpecializedProto[];
  /** names of read-only records used in the residual code -> dump table */
  constNames: Map<string, unknown>;
  dump: LuaDump;
  /** stores into dump records in the reachable residual code (patch discovery; with `patches` given) */
  discovered?: PatchSpec[];
  /** fold hooks resolving reads of those records (for clean()) */
  hooks: { constGlobals: (n: string) => boolean; constIndex: (obj: A.Expr, key: A.Expr) => A.Expr | null; constLen: (obj: A.Expr) => A.Expr | null };
}

export const LIB = /^(?:(?:string|table|math|bit32|buffer|coroutine|utf8|os|debug|task)\.[A-Za-z_]\w*|pcall|xpcall|select|type|typeof|tostring|tonumber|error|assert|getfenv|setfenv|setmetatable|getmetatable|rawget|rawset|rawequal|rawlen|next|pairs|ipairs|unpack|print|newproxy|gcinfo|collectgarbage)$/;

export function specializeVM(src: string, dumpJson: unknown, opts: SpecializeOptions = {}): SpecializeResult {
  const { chunk } = parse(src);
  const { shape, notes } = findVmShape(chunk);
  const dump = new LuaDump(dumpJson);
  const constNames = new Map<string, unknown>();
  // run-time written slots of dump records: table id -> key -> written values
  const patchMap = new Map<string, Map<string, { values: Array<number | string | boolean | null>; dynamic: boolean }>>();
  const dynTables = new Set<string>();
  for (const ps of opts.patches ?? []) {
    if (ps.anyKey || ps.key === undefined) { dynTables.add(String(ps.table)); continue; }
    if (!ps.dynamic) {   // every written value equals the dump value: the slot is constant
      const t = dump.ids.get(Number(ps.table));
      if (t !== undefined) { const dv = dump.scalar(dump.get(t, ps.key)); const sv = (v: unknown) => v === null ? dv.kind === 'nil' : ((dv.kind === 'num' || dv.kind === 'str' || dv.kind === 'bool') && dv.value === v); if (ps.values.every(sv)) continue; }
    }
    let m = patchMap.get(String(ps.table)); if (!m) { m = new Map(); patchMap.set(String(ps.table), m); }
    const kk = typeof ps.key === 'number' ? 'n:' + ps.key : 's:' + ps.key;
    let e = m.get(kk); if (!e) { e = { values: [], dynamic: false }; m.set(kk, e); }
    for (const v of ps.values) if (!e.values.some(x => x === v)) e.values.push(v);
    if (ps.dynamic) e.dynamic = true;
  }
  const effPatches: PatchSpec[] = [];
  for (const [tid, m] of patchMap) for (const [kk, e] of m) effPatches.push({ table: tid, key: kk.startsWith('n:') ? Number(kk.slice(2)) : kk.slice(2), values: e.values, dynamic: e.dynamic });
  for (const t of dynTables) effPatches.push({ table: t, anyKey: true, values: [], dynamic: true });
  const patchedSlot = (tableId: string | null, key: number | string): { values: Array<number | string | boolean | null>; dynamic: boolean } | null => {
    if (tableId === null) return null;
    if (dynTables.has(tableId)) return { values: [], dynamic: true };
    return patchMap.get(tableId)?.get(typeof key === 'number' ? 'n:' + key : 's:' + key) ?? null;
  };
  const nameToId = (nm: string): string | null => { const v = constNames.get(nm); if (v === undefined) return null; return dump.tableId(v) ?? null; };
  const res: SpecializeResult = { ok: false, notes, shape: shape ?? undefined, protos: [], constNames, dump, hooks: { constGlobals: (n: string) => constNames.has(n), constIndex: (o, k) => hookHelper(o, k) ?? hookIndex(o, k), constLen: (o) => hookLen(o) } };
  if (!shape) return res;
  const protos = findProtos(dump, shape, opts.root);
  if (!protos.length) { notes.push(`no proto records with an opcode array at key ${JSON.stringify(shape.opsKey)} in the dump`); return res; }
  const protoIds = new Set(protos.map(p => p.id));
  notes.push(`${protos.length} proto(s) in the dump: ${protos.slice(0, 40).map(p => `#${p.id}(${p.instrs})`).join(' ')}${protos.length > 40 ? ' …' : ''}`);
  const tableName = (id: string) => protoIds.has(id) ? 'PROTO_' + id : 'K_' + id;
  const nameOf = (v: unknown): A.Expr => {
    const s = dump.scalar(v);
    if (s.kind === 'table') { const nm = tableName(s.id); constNames.set(nm, dump.deref(v)); return name(nm); }
    if (s.kind === 'fn') { const p = LIB.test(s.name) ? pathExpr(s.name) : null; return p ?? name('FN_' + s.name.replace(/\W/g, '_')); }
    if (s.kind === 'buffer') return { type: 'CallExpr', callee: pathExpr('buffer.fromstring')!, args: [{ type: 'StringLit', value: hexToLatin1(s.hex), raw: '' }] } as A.CallExpr;
    return literalExpr(s, () => name('nil'));
  };
  const lit = (v: unknown): A.Expr => literalExpr(dump.scalar(v), () => nameOf(v));
  // helper-table library aliases
  const helperAlias = new Map<string, A.Expr>();
  if (opts.helper) {
    let h: unknown = dump.root;
    for (const p of opts.helper.path.split(/[./]/).filter(Boolean)) h = dump.get(h, /^\d+$/.test(p) ? Number(p) : p);
    if (dump.isTable(h)) {
      for (const [k, v] of dump.entries(h)) {
        const s = dump.scalar(v);
        if (s.kind === 'fn' && LIB.test(s.name)) helperAlias.set(`${opts.helper.name}[${typeof k === 'number' ? numRaw(k) : JSON.stringify(k)}]`, pathExpr(s.name)!);
        if (s.kind === 'table') for (const [k2, v2] of dump.entries(v)) { const s2 = dump.scalar(v2); if (s2.kind === 'fn' && LIB.test(s2.name)) helperAlias.set(`${opts.helper.name}[${typeof k === 'number' ? numRaw(k) : JSON.stringify(k)}][${typeof k2 === 'number' ? numRaw(k2) : JSON.stringify(k2)}]`, pathExpr(s2.name)!); }
      }
      notes.push(`helper table ${opts.helper.name}: ${helperAlias.size} library function slot(s) resolved`);
    } else notes.push(`helper table path '${opts.helper.path}' not found in the dump`);
  }
  // handler cache per opcode
  const handlerCache = new Map<number, A.Stat[]>();
  const handlerFor = (op: number) => { let h = handlerCache.get(op); if (!h) { h = selectHandler(shape.dispatch, shape.opVar, op); handlerCache.set(op, h); } return h; };
  const selfModified: string[] = [];
  const max = opts.maxProtos ?? 400;
  const only = opts.only ? new Set(opts.only.map(String)) : null;
  const writtenHelperSlots = new Set<string>();
  const results: Array<{ p: ProtoRef; fn: A.FunctionExpr; blocks: number; pnotes: string[] }> = [];
  const pending: Array<{ p: ProtoRef; blocks: Map<number, A.Stat[]>; pnotes: string[]; refold: (stmts: A.Stat[]) => A.Stat[]; emit: (keys: number[]) => A.FunctionExpr }> = [];
  for (const p of protos) {
    if (only && !only.has(p.id)) continue;
    if (results.length >= max) { notes.push(`stopped after ${max} protos (maxProtos)`); break; }
    const pnotes: string[] = [];
    const ops = dump.get(p.value, shape.opsKey as any);
    const n = Math.min(p.instrs, opts.maxInstrs ?? 100000);
    // per-instruction field arrays and their dump identities (for run-time patches)
    const fieldKeys: Array<number | string> = [...new Set<number | string>([shape.opsKey, ...shape.fieldVars.values()])];
    const fieldTid = new Map<string, string | null>(fieldKeys.map(k => { const t = dump.get(p.value, k as any); return [String(k), dump.isTable(t) ? dump.tableId(t) : null]; }));
    let override: Map<string, unknown> | null = null; let overridePc = NaN;
    const fieldVal = (key: number | string, pc: number): unknown => (override && pc === overridePc && override.has(String(key))) ? override.get(String(key)) : dump.get(dump.get(p.value, key as any), pc);
    const fieldPatched = (key: number | string, pc: number): boolean => !!patchedSlot(fieldTid.get(String(key)) ?? null, pc) && !(override && pc === overridePc && override.has(String(key)));
    const fieldRef = (key: number | string): A.Expr => lit(dump.get(p.value, key as any));
    const protoName = tableName(p.id);
    constNames.set(protoName, dump.deref(p.value));
    // ---- per instruction
    interface Ins { stmts: A.Stat[]; targets: number[]; falls: boolean; plain: boolean; }
    const insns: Ins[] = [];
    let patchedInsns = 0;
    for (let pc = 1; pc <= n; pc++) {
      const specOne = (ov: Map<string, unknown> | null): { body: A.Stat[]; op: number } => {
        override = ov; overridePc = pc;
        const opv = dump.scalar(fieldVal(shape.opsKey, pc));
        const op = opv.kind === 'num' ? opv.value : NaN;
        let stmts: A.Stat[] = Number.isFinite(op) ? clone(handlerFor(op)) : [];
        stmts = substitute(stmts, pc, op);
        override = null; overridePc = NaN;
        const ch: A.Chunk = { type: 'Chunk', body: stmts };
        for (let r = 0; r < 3; r++) { const f = fold(ch, { constIndex: hookIndex, constLen: hookLen }); const d = eliminateDeadCode(ch); if (!f.folded && !d.prunedBranches && !d.removedStmts) break; }
        return { body: ch.body, op };
      };
      // slots of this instruction written by the program at run time (self-modifying bytecode)
      const patched: Array<{ key: number | string; tid: string; dumpV: unknown; vals: Array<number | string | boolean | null>; dynamic: boolean }> = [];
      for (const fk of fieldKeys) { const tid = fieldTid.get(String(fk)) ?? null; const ps = patchedSlot(tid, pc); if (ps && tid !== null) patched.push({ key: fk, tid, dumpV: dump.get(dump.get(p.value, fk as any), pc), vals: ps.values, dynamic: ps.dynamic }); }
      let body: A.Stat[]; let op: number;
      if (!patched.length) ({ body, op } = specOne(null));
      else {
        patchedInsns++;
        const same = (a: unknown, b: unknown) => { const x = dump.scalar(a), y = dump.scalar(b); return x.kind === y.kind && JSON.stringify(x) === JSON.stringify(y); };
        let combos: Array<Map<string, unknown>> = [new Map()];
        for (const f of patched) {
          const choices: unknown[] = [f.dumpV, ...f.vals.filter(v => !same(v, f.dumpV))];
          const next: Array<Map<string, unknown>> = [];
          for (const c of combos) for (const v of choices) { const m = new Map(c); m.set(String(f.key), v); next.push(m); }
          combos = next;
        }
        const tooMany = combos.length > 16;
        if (tooMany) combos = combos.slice(0, 16);
        const slotRead = (f: typeof patched[number]): A.Expr => ({ type: 'IndexExpr', obj: nameOf(dump.get(p.value, f.key as any)), index: num(pc) });
        const guard = (c: Map<string, unknown>): A.Expr => patched.map(f => ({ type: 'BinExpr', op: '==', left: slotRead(f), right: lit(c.get(String(f.key))) } as A.Expr)).reduce((a, b) => ({ type: 'BinExpr', op: 'and', left: a, right: b } as A.Expr));
        const dynamic = tooMany || patched.some(f => f.dynamic);
        const ifs: A.IfStat = { type: 'IfStat', clauses: [], elseBody: undefined };
        for (const c of combos.slice(1)) ifs.clauses.push({ cond: guard(c), body: specOne(c).body });
        const base = specOne(combos[0]); op = base.op;
        if (dynamic) {
          ifs.clauses.push({ cond: guard(combos[0]), body: base.body });
          ifs.elseBody = [{ type: 'CallStat', expr: { type: 'CallExpr', callee: name('error'), args: [{ type: 'StringLit', value: `PRISM: instruction ${p.id}:${pc} is rewritten at run time with a value the static analysis could not resolve`, raw: '' }] } } as A.CallStat];
          pnotes.push(`pc ${pc}: run-time patched with unresolved value(s) — guarded, unknown values raise an error`);
        } else ifs.elseBody = base.body;
        body = ifs.clauses.length ? [ifs] : base.body;
      }
      const info = normalize(body, pc + 1);
      insns.push({ stmts: body, targets: info.targets, falls: info.falls, plain: info.plain });
      if (info.dynamic) pnotes.push(`pc ${pc} (op ${op}): non-literal jump target — left as a dynamic transfer`);
    }
    if (patchedInsns) pnotes.push(`${patchedInsns} instruction(s) rewritten at run time (self-modifying bytecode): specialised per possible value, selected by the run-time slot`);
    // ---- basic blocks
    const leaders = new Set<number>([1]);
    insns.forEach((ins, i) => { const pc = i + 1; if (ins.plain) return; for (const t of ins.targets) if (t >= 1 && t <= n) leaders.add(t); if (pc + 1 <= n) leaders.add(pc + 1); });
    const keys = [...leaders].sort((a, b) => a - b);
    const blocks = new Map<number, A.Stat[]>();
    for (let bi = 0; bi < keys.length; bi++) {
      const start = keys[bi], end = bi + 1 < keys.length ? keys[bi + 1] - 1 : n;
      const body: A.Stat[] = [];
      for (let pc = start; pc <= end; pc++) {
        const ins = insns[pc - 1];
        if (ins.plain && pc < end) body.push(...ins.stmts.slice(0, -1));   // drop the fall-through `pc = pc + 1`
        else body.push(...ins.stmts);
      }
      if (end === n && insns[n - 1]?.plain) { /* falls off the end: the VM would read a nil opcode */ }
      blocks.set(start, body);
    }
    // ---- dispatcher (balanced search tree over block keys) + residual maker, emitted after the patch analysis
    const emit = (keys: number[]): A.FunctionExpr => {
      const tree = (ks: number[]): A.Stat[] => {
        if (ks.length === 1) return blocks.get(ks[0])!;
        const mid = Math.floor(ks.length / 2);
        return [{ type: 'IfStat', clauses: [{ cond: { type: 'BinExpr', op: '<', left: name(shape.pcVar), right: num(ks[mid]) }, body: tree(ks.slice(0, mid)) }], elseBody: tree(ks.slice(mid)) }];
      };
      const disp: A.Stat[] = keys.length === 1 ? [{ type: 'IfStat', clauses: [{ cond: { type: 'BinExpr', op: '==', left: name(shape.pcVar), right: num(keys[0]) }, body: blocks.get(keys[0])! }] }] : tree(keys);
      // ---- residual run function: prologue + scratch locals + state machine
      const pro = substitute(clone(shape.prologue), NaN, NaN, true);
      const pre = substitute(clone(shape.loopPre), NaN, NaN, true);
      const run: A.FunctionExpr = { type: 'FunctionExpr', params: shape.runFn.params.slice(), vararg: shape.runFn.vararg, body: [...pro, ...pre, { type: 'WhileStat', cond: { type: 'TrueLit' }, body: disp }] };
      // ---- residual maker: the maker body with the interpreter replaced, the proto parameter dropped
      const mk = clone(shape.makeFn);
      const runPath = findPath(shape.makeFn, shape.runFn);
      setPath(mk, runPath, run);
      mk.params = mk.params.slice(1);
      mk.body = substitute(mk.body, NaN, NaN, true, run);
      return mk;
    };
    const refold = (stmts: A.Stat[]): A.Stat[] => {
      const ch: A.Chunk = { type: 'Chunk', body: stmts };
      for (let r = 0; r < 3; r++) { const f = fold(ch, { constIndex: hookIndex, constLen: hookLen }); const d = eliminateDeadCode(ch); if (!f.folded && !d.prunedBranches && !d.removedStmts) break; }
      return ch.body;
    };
    pending.push({ p, blocks, pnotes, refold, emit });


    // -- helpers bound to this proto -------------------------------------------------
    function substitute(stmts: A.Stat[], pc: number, op: number, outside = false, keep?: any, noRoute = false): A.Stat[] {
      const inFn = (depth: number) => depth > 0;
      // names declared inside the substituted code (locals, loop variables, parameters of nested functions) shadow
      // the interpreter's variables: `for R = 1, n do A[R - 1] = ... end` with R also the proto parameter keeps its R
      const bound = new Set<any>();
      { const sc = analyzeScopes({ type: 'Chunk', body: stmts } as A.Chunk); for (const [ref, b] of sc.refOf) if (b && b.kind !== 'global') bound.add(ref); }
      const freeName = (e: any, nm?: string): boolean => !!e && e.type === 'NameExpr' && !bound.has(e) && (nm === undefined || e.name === nm);
      const visitE = (e: any, depth: number): any => {
        if (!e || typeof e !== 'object' || e === keep) return e;
        switch (e.type) {
          case 'NameExpr': {
            if (bound.has(e)) return e;
            if (!outside && e.name === shape!.opVar && Number.isFinite(op)) return num(op);
            if (!outside && e.name === shape!.pcVar && Number.isFinite(pc) && !inFn(depth)) return num(pc);
            if (e.name === shape!.protoParam) { return name(protoName); }
            if (shape!.fieldVars.has(e.name)) return fieldRef(shape!.fieldVars.get(e.name)!);
            return e;
          }
          case 'IndexExpr': {
            const o = unparen(e.obj);
            e.index = visitE(e.index, depth);
            if (isName(o) && !bound.has(o) && shape!.fieldVars.has(o.name)) {
              const key = shape!.fieldVars.get(o.name)!;
              const ix = foldExpr(e.index);
              if (ix.type === 'NumberLit') { if (fieldPatched(key, ix.value)) { e.obj = fieldRef(key); e.index = num(ix.value); return e; } return lit(fieldVal(key, ix.value)); }
              if (ix.type === 'UnExpr' && ix.op === '-' && unparen(ix.expr).type === 'NumberLit') return lit(fieldVal(key, -(unparen(ix.expr) as A.NumberLit).value));
              e.obj = fieldRef(key); return e;
            }
            e.obj = visitE(e.obj, depth);
            return e;
          }
          case 'FunctionExpr': { e.body = visitS(e.body, depth + 1); return e; }
          default:
            for (const k of Object.keys(e)) {
              if (k === 'loc') continue;
              const v = e[k];
              if (Array.isArray(v)) e[k] = v.map((x: any) => (x && typeof x === 'object' && 'type' in x) ? visitE(x, depth) : (k === 'fields' ? visitField(x, depth) : (k === 'parts' && x && x.kind === 'expr') ? { ...x, expr: visitE(x.expr, depth) } : x));
              else if (v && typeof v === 'object' && typeof v.type === 'string') e[k] = visitE(v, depth);
            }
            return e;
        }
      };
      const visitField = (f: any, depth: number) => { if (f.key) f.key = visitE(f.key, depth); f.value = visitE(f.value, depth); return f; };
      const visitS = (list: A.Stat[], depth: number): A.Stat[] => {
        const out: A.Stat[] = [];
        for (const s of list) {
          if (s === keep) { out.push(s); continue; }
          if (s.type === 'AssignStat') {
            // self-modifying store into the opcode array: the patched opcode has the same meaning
            const dropIdx = s.targets.map((t, q) => (t.type === 'IndexExpr' && freeName(unparen(t.obj), shape!.opsVar)) ? q : -1).filter(q => q >= 0);
            if (dropIdx.length && !outside) {
              if (dropIdx.length === s.targets.length) { selfModified.push(`${p.id}:${pc}`); continue; }
            }
            if (!outside && !inFn(depth) && s.targets.length === 1 && freeName(s.targets[0], shape!.pcVar) && !s.op) {
              s.values = [{ type: 'BinExpr', op: '+', left: { type: 'ParenExpr', expr: visitE(s.values[0], depth) }, right: num(1) }];
              out.push(s); continue;
            }
            s.targets = s.targets.map(t => { if (t.type === 'IndexExpr') { t.obj = visitE(t.obj, depth); t.index = visitE(t.index, depth); const hk = printExpr(t); if (opts.helper && hk.startsWith(opts.helper.name + '[')) writtenHelperSlots.add(hk); return t; } if (t.type === 'MemberExpr') { t.obj = visitE(t.obj, depth); return t; } return t; });
            s.values = s.values.map(v => visitE(v, depth));
            out.push(s); continue;
          }
          if (s.type === 'ReturnStat' && !outside && !noRoute && !inFn(depth) && shape!.wrapped) {
            s.args = s.args.map(a => visitE(a, depth));
            out.push(...routeReturn(s, (ep) => substitute(ep, pc, op, false, undefined, true)));
            continue;
          }
          visitStatInner(s, depth);
          out.push(s);
        }
        return out;
      };
      const visitStatInner = (s: any, depth: number) => {
        for (const k of Object.keys(s)) {
          if (k === 'loc') continue;
          const v = s[k];
          if (k === 'body' || k === 'elseBody') { if (Array.isArray(v)) s[k] = visitS(v, depth); continue; }
          if (k === 'clauses') { for (const c of v) { c.cond = visitE(c.cond, depth); c.body = visitS(c.body, depth); } continue; }
          if (k === 'func') { s.func.body = visitS(s.func.body, depth + 1); continue; }
          if (Array.isArray(v)) s[k] = v.map((x: any) => (x && typeof x === 'object' && typeof x.type === 'string') ? visitE(x, depth) : x);
          else if (v && typeof v === 'object' && typeof v.type === 'string') s[k] = visitE(v, depth);
        }
      };
      return visitS(stmts, 0);
    }
  }
  // ---- self-modifying bytecode: which patched slots are definitely written before they are read
  if (effPatches.length || opts.discover) {
    const model = new PatchModel(effPatches);
    const recordId = (nm: string): string | null => constNames.has(nm) ? nameToId(nm) : null;
    const createdProto = (c: A.CallExpr): string | null => {
      const a0 = c.args[0];
      if (shape.makeTarget && a0 && a0.type === 'NameExpr' && a0.name.startsWith('PROTO_') && printExpr(c.callee) === shape.makeTarget) return a0.name.slice(6);
      return null;
    };
    const created = new Map<string, Set<string>>();
    for (const pd of pending) {
      const cs = new Set<string>();
      walk([...pd.blocks.values()], (m: any) => { if (m.type === 'CallExpr') { const id = createdProto(m); if (id !== null) cs.add(id); } });
      created.set(pd.p.id, cs);
    }
    const byId = new Map(pending.map(pd => [pd.p.id, pd]));
    let resolved = 0, unresolved = 0, unreached = 0, phases = 0, trampolines = 0;
    const perProto = new Map<string, { resolved: number; unresolved: number; dropped: number; tramp: number }>();
    let storeLog = new Map<string, PatchSpec>();
    // phases: a true guard `slot == v` implies the state at the stores writing v (from the previous phase)
    let ssPrev = new Map<string, Known>();
    const order = creationOrder(pending.map(pd => pd.p.id), created);
    for (let phase = 0; phase < 12; phase++) {
      phases++;
      const ssCur = new Map<string, Known>();
      storeLog = new Map();
      const entry = new Map<string, Known>();
      let gained = 0, foldedNow = 0; unresolved = 0;
      for (const { id, cyclic } of order) {
        const pd = byId.get(id)!;
        const ent = cyclic ? new Map<string, Lit>() : (entry.get(id) ?? new Map<string, Lit>());
        const gr = analyzeBlockGraph(pd.blocks, 1, ent, { model, recordId, createdProto, pcVar: shape.pcVar, captured: capturedNames([...pd.blocks.values()]),
          onRecordStore: (tid, key, value) => { const kk = tid + '|' + (key.ok ? (typeof key.v === 'number' ? 'n:' + key.v : 's:' + String(key.v)) : '*'); let e = storeLog.get(kk); if (!e) { e = key.ok ? { table: tid, key: key.v as number | string, values: [] } : { table: tid, anyKey: true, values: [] }; storeLog.set(kk, e); } if (value.ok) { if (!e.values.some(x => x === value.v)) e.values.push(value.v); } else e.dynamic = true; },
          implied: (tid, key, lit) => ssPrev.get(slotKey(tid, key) + '=' + JSON.stringify(lit)) ?? null,
          onStore: (sk, lit, before) => { const kk = sk + '=' + JSON.stringify(lit); const b2 = new Map(before); b2.set(sk, lit); const prev = ssCur.get(kk); ssCur.set(kk, prev ? intersect(prev, b2) : b2); } });
        if (devEnv('PRISM_PATCH_TRACE')) console.error(`[patch] phase ${phase} proto ${id}: ${gr.incomplete ? 'INCOMPLETE' : gr.iterations + ' iterations'}, reached ${gr.reached.size}/${pd.blocks.size}, resolved ${gr.resolved}, unresolved ${gr.unresolved}`);
        if (gr.incomplete) pd.pnotes.push('self-modifying bytecode: block analysis did not converge within its budget (no patched read resolved)');
        gained += gr.resolved; unresolved += gr.unresolved;
        for (const [c, k] of gr.creates) { const prev = entry.get(c); entry.set(c, prev ? intersect(prev, k) : k); }
        let dropped = 0;
        for (const k of [...pd.blocks.keys()]) {
          if (!gr.reached.has(k)) { pd.blocks.delete(k); dropped++; continue; }
          pd.blocks.set(k, pd.refold(pd.blocks.get(k)!));
        }
        unreached += dropped;
        const tr = foldTrampolines(pd.blocks, model, recordId, shape.pcVar);
        trampolines += tr; foldedNow += tr;
        const pp = perProto.get(id) ?? { resolved: 0, unresolved: 0, dropped: 0, tramp: 0 };
        pp.resolved += gr.resolved; pp.unresolved = gr.unresolved; pp.dropped += dropped; pp.tramp += tr; perProto.set(id, pp);
      }
      resolved += gained;
      const ssSame = ssCur.size === ssPrev.size && [...ssCur].every(([k, v]) => { const o = ssPrev.get(k); return !!o && o.size === v.size && [...v].every(([a, b]) => o.get(a) === b); });
      ssPrev = ssCur;
      if (!gained && ssSame && !foldedNow) break;
    }
    res.discovered = [...storeLog.values()];
    for (const pd of pending) { const pp = perProto.get(pd.p.id); if (pp && (pp.resolved || pp.dropped || pp.tramp)) pd.pnotes.push(`self-modifying bytecode: ${pp.resolved} patched-slot read(s) resolved (the store dominates the read), ${pp.unresolved} left to run time${pp.tramp ? `, ${pp.tramp} one-time patch trampoline(s) folded` : ''}${pp.dropped ? `, ${pp.dropped} unreachable block(s) removed` : ''}`); }
    notes.push(`self-modifying bytecode: ${effPatches.length} written slot(s); ${resolved} patched-slot read(s) resolved statically (${phases} phase(s)), ${unresolved} selected at run time, ${trampolines} one-time patch trampoline(s) folded (the patching chain always runs; its stores are idempotent, its scratch registers are dead at the join), ${unreached} unreachable block(s) removed`);
  }
  if (opts.onBlocks) for (const pd of pending) opts.onBlocks(pd.p.id, pd.blocks, shape.pcVar);
  for (const pd of pending) { const keys = [...pd.blocks.keys()].sort((a, b) => a - b); results.push({ p: pd.p, fn: pd.emit(keys), blocks: keys.length, pnotes: pd.pnotes }); }
  if (selfModified.length) notes.push(`${selfModified.length} self-modifying opcode store(s) removed (the patched opcode has the same meaning)`);
  if (writtenHelperSlots.size) notes.push(`helper slots written by the program (not aliased): ${[...writtenHelperSlots].slice(0, 12).join(', ')}`);
  // library functions read from the helper table (slots the program never writes)
  if (helperAlias.size) {
    let na = 0;
    const visit = (node: any, target: boolean) => {
      if (!node || typeof node !== 'object') return node;
      if (Array.isArray(node)) { for (let i = 0; i < node.length; i++) node[i] = visit(node[i], target); return node; }
      for (const k of Object.keys(node)) {
        if (k === 'loc') continue;
        const tgt = node.type === 'AssignStat' && k === 'targets';
        if (tgt) { node[k] = node[k].map((t: any) => { if (t.type === 'IndexExpr') { t.obj = visit(t.obj, false); t.index = visit(t.index, false); } else if (t.type === 'MemberExpr') t.obj = visit(t.obj, false); return t; }); continue; }
        node[k] = visit(node[k], false);
      }
      if (node.type === 'IndexExpr' && !target) {
        const hk = printExpr(node);
        const ha = helperAlias.get(hk);
        if (ha && !writtenHelperSlots.has(hk)) { na++; return clone(ha); }
      }
      return node;
    };
    for (const r of results) visit(r.fn, false);
    notes.push(`${na} helper-table read(s) replaced by library functions`);
  }
  for (const r of results) {
    const code = print({ type: 'Chunk', body: [{ type: 'AssignStat', targets: [{ type: 'IndexExpr', obj: name('PROTOS'), index: num(Number(r.p.id) || 0) }], values: [r.fn] }] } as any);
    res.protos.push({ id: r.p.id, name: tableName(r.p.id), instrs: r.p.instrs, blocks: r.blocks, code, notes: r.pnotes });
  }
  res.ok = res.protos.length > 0;
  return res;

  // ---- shared helpers -------------------------------------------------------------
  function hookIndex(obj: A.Expr, key: A.Expr): A.Expr | null {
    const o = unparen(obj); if (o.type !== 'NameExpr' || !constNames.has(o.name)) return null;
    const k = unparen(key);
    let kv: number | string | null = null;
    if (k.type === 'NumberLit') kv = k.value; else if (k.type === 'StringLit') kv = k.value;
    else if (k.type === 'UnExpr' && k.op === '-' && unparen(k.expr).type === 'NumberLit') kv = -(unparen(k.expr) as A.NumberLit).value;
    if (kv === null) return null;
    if (patchedSlot(nameToId(o.name), kv)) return null;   // written at run time: not a constant
    const v = dump.get(constNames.get(o.name), kv);
    const s = dump.scalar(v);
    if (s.kind === 'fn' && !LIB.test(s.name)) return null;
    return lit(v);
  }
  /** library functions of the helper table (also nested: `E[7][10]` -> bit32.band) for the cleanup passes that
   *  run after specialisation — propagation there forms helper reads the residual-code substitution never saw.
   *  Slots the program writes are never resolved. */
  function hookHelper(obj: A.Expr, key: A.Expr): A.Expr | null {
    if (!helperAlias.size) return null;
    const k = unparen(key); if (k.type !== 'NumberLit' && k.type !== 'StringLit') return null;
    const hk = printExpr({ type: 'IndexExpr', obj: unparen(obj), index: k } as A.IndexExpr);
    const ha = helperAlias.get(hk);
    return ha && !writtenHelperSlots.has(hk) ? clone(ha) : null;
  }
  function hookLen(obj: A.Expr): A.Expr | null {
    const o = unparen(obj); if (o.type !== 'NameExpr' || !constNames.has(o.name)) return null;
    return num(dump.len(constNames.get(o.name)));
  }
  function foldExpr(e: A.Expr): A.Expr {
    const ch: A.Chunk = { type: 'Chunk', body: [{ type: 'ReturnStat', args: [clone(e)] }] };
    fold(ch);
    return unparen((ch.body[0] as A.ReturnStat).args[0]);
  }
  /** `return a, b, c` inside the protected interpreter -> the epilogue with those results */
  function routeReturn(s: A.ReturnStat, sub: (ep: A.Stat[]) => A.Stat[]): A.Stat[] {
    const decl: A.LocalStat = { type: 'LocalStat', names: shape!.resultNames.slice(), init: [{ type: 'TrueLit' }, ...s.args] };
    const ep = sub(clone(shape!.epilogue));
    const last = ep[ep.length - 1];
    const tail: A.Stat[] = last && last.type === 'ReturnStat' ? [] : [{ type: 'ReturnStat', args: [] }];
    return [{ type: 'DoStat', body: [decl, ...ep, ...tail] }];
  }
  /** make every path end in `pc = K` / return; report literal targets */
  function normalize(stmts: A.Stat[], next: number): { targets: number[]; falls: boolean; plain: boolean; dynamic: boolean } {
    const targets: number[] = []; let dynamic = false;
    const pcAssign = (s: A.Stat | undefined): s is A.AssignStat => !!s && s.type === 'AssignStat' && s.targets.length === 1 && isName(s.targets[0], shape!.pcVar);
    const writesPc = (x: any) => { let hit = false; walk(x, (m: any) => { if (m.type === 'FunctionExpr') return; if (m.type === 'AssignStat' && m.targets.some((t: any) => isName(t, shape!.pcVar))) hit = true; }); return hit; };
    const exits = (list: A.Stat[]): boolean => { const l = list[list.length - 1]; if (!l) return false; if (l.type === 'ReturnStat') return true; if (l.type === 'DoStat') return exits(l.body); if (l.type === 'IfStat') return !!l.elseBody && l.clauses.every(c => exits(c.body)) && exits(l.elseBody); return false; };
    let ok = true;
    const tailFix = (list: A.Stat[]): void => {
      const l = list[list.length - 1];
      if (l && (l.type === 'ReturnStat' || pcAssign(l))) return;
      if (l && l.type === 'DoStat' && exits(l.body)) return;
      if (l && l.type === 'IfStat' && writesPc(l)) {
        if (writesPc(list.slice(0, -1))) ok = false;
        for (const c of l.clauses) tailFix(c.body);
        if (!l.elseBody) l.elseBody = [];
        tailFix(l.elseBody);
        return;
      }
      if (writesPc(list)) ok = false;
      list.push({ type: 'AssignStat', targets: [name(shape!.pcVar)], values: [num(next)] });
    };
    const plain = !writesPc(stmts) && !exits(stmts) && !hasReturn(stmts);
    tailFix(stmts);
    if (!ok) dynamic = true;
    walk(stmts, (m: any) => {
      if (m.type === 'AssignStat' && m.targets.length === 1 && isName(m.targets[0], shape!.pcVar)) {
        const v = foldExpr(m.values[0]);
        m.values = [v];
        if (v.type === 'NumberLit') targets.push(v.value); else dynamic = true;
      }
    });
    return { targets, falls: true, plain, dynamic };
  }
  function hasReturn(stmts: A.Stat[]): boolean { let hit = false; walk(stmts, (m: any) => { if (m.type === 'FunctionExpr') return; if (m.type === 'ReturnStat') hit = true; }); return hit; }
}

function hexToLatin1(h: string): string { let s = ''; for (let i = 0; i + 1 < h.length; i += 2) s += String.fromCharCode(parseInt(h.slice(i, i + 2), 16)); return s; }
/** property path from root to target node (object keys / array indexes) */
function findPath(root: any, target: any): Array<string | number> {
  const path: Array<string | number> = [];
  const visit = (n: any): boolean => {
    if (n === target) return true;
    if (!n || typeof n !== 'object') return false;
    for (const k of Object.keys(n)) {
      if (k === 'loc') continue;
      const v = n[k];
      if (Array.isArray(v)) { for (let i = 0; i < v.length; i++) { path.push(k, i); if (visit(v[i])) return true; path.pop(); path.pop(); } }
      else if (v && typeof v === 'object') { path.push(k); if (visit(v)) return true; path.pop(); }
    }
    return false;
  };
  if (!visit(root)) throw new Error('interpreter function not found inside the closure maker');
  return path;
}
function setPath(root: any, path: Array<string | number>, value: any) {
  let n = root;
  for (let i = 0; i < path.length - 1; i++) n = n[path[i]];
  n[path[path.length - 1]] = value;
}

// ---------------------------------------------------------------- run-time writes into dump records
/** Find program stores into dump records (`K_7[262] = 101`, or through a holder: `R[28] = K_413; …; R[28][103] = 27`).
 *  recordId maps a residual record name to its dump table id. Keys/values that are not literals (after a
 *  straight-line look-up of literal assignments) are reported as `dynamic` / `anyKey`. */
export function collectPatches(chunk: A.Chunk, recordId: (name: string) => string | null, debug?: (tid: string, key: unknown, value: A.Expr | undefined) => void): PatchSpec[] {
  const out = new Map<string, PatchSpec>();
  const litOf = (e: A.Expr | undefined): { ok: boolean; v: number | string | boolean | null } => {
    const u = e ? unparen(e) : undefined;
    if (!u) return { ok: false, v: null };
    if (u.type === 'NumberLit') return { ok: true, v: u.value };
    if (u.type === 'UnExpr' && u.op === '-' && unparen(u.expr).type === 'NumberLit') return { ok: true, v: -(unparen(u.expr) as A.NumberLit).value };
    if (u.type === 'StringLit') return { ok: true, v: u.value };
    if (u.type === 'TrueLit') return { ok: true, v: true };
    if (u.type === 'FalseLit') return { ok: true, v: false };
    if (u.type === 'NilLit') return { ok: true, v: null };
    return { ok: false, v: null };
  };
  // function-wide fallback: holders assigned exactly one record (other writes only nil)
  const unique = new Map<string, string | null>();
  walk(chunk, (m: any) => {
    if (m.type !== 'AssignStat' || m.op) return;
    m.targets.forEach((t: A.Expr, q: number) => {
      const key = printExpr(t); const v = m.values[q] ? unparen(m.values[q]) : undefined;
      const id = v && v.type === 'NameExpr' ? recordId(v.name) : null;
      if (v && v.type === 'NilLit') return;
      const prev = unique.get(key);
      if (id === null) unique.set(key, null);
      else if (prev === undefined) unique.set(key, id);
      else if (prev !== id) unique.set(key, null);
    });
  });
  const record = (tid: string, k: { ok: boolean; v: any }, v: { ok: boolean; v: any }) => {
    const key = k.ok ? (typeof k.v === 'number' ? 'n:' + k.v : 's:' + String(k.v)) : '*';
    const id = tid + '|' + key;
    let ps = out.get(id);
    if (!ps) { ps = k.ok ? { table: tid, key: k.v as number | string, values: [] } : { table: tid, anyKey: true, values: [] }; out.set(id, ps); }
    if (v.ok) { if (!ps.values.includes(v.v)) ps.values.push(v.v); } else ps.dynamic = true;
  };
  type St = { holders: Map<string, string>; lits: Map<string, { ok: boolean; v: any }> };
  const assignedIn = (node: any): Set<string> => { const s = new Set<string>(); walk(node, (m: any) => { if (m.type === 'AssignStat') for (const t of m.targets) s.add(printExpr(t)); }); return s; };
  const list = (stmts: A.Stat[], st: St): void => {
    for (const s of stmts) {
      if (s.type === 'AssignStat' && !s.op) {
        s.targets.forEach((t, q) => {
          const v = s.values[q];
          if (t.type === 'IndexExpr') {
            const o = unparen(t.obj);
            const ok = printExpr(o);
            const tid = (o.type === 'NameExpr' ? recordId(o.name) : null) ?? st.holders.get(ok) ?? unique.get(ok) ?? null;
            if (tid !== null) {
              const look = (k: string) => st.lits.get(k) ?? { ok: false, v: null };
              const kk = evalLit(t.index, look);
              const vv = evalLit(v, look);
              if (debug && (!vv.ok || !kk.ok)) debug(tid, kk.ok ? kk.v : '*', v);
              record(tid, kk, vv);
            }
          }
          const key = printExpr(t);
          const u = v ? unparen(v) : undefined;
          const rid = u && u.type === 'NameExpr' ? recordId(u.name) : null;
          if (rid !== null) st.holders.set(key, rid); else st.holders.delete(key);
          const l = evalLit(v, (k) => st.lits.get(k) ?? { ok: false, v: null }); if (l.ok) st.lits.set(key, l); else st.lits.delete(key);
          // anything indexed through the overwritten name is stale too
          for (const k of [...st.holders.keys()]) if (k !== key && k.startsWith(key + '[')) st.holders.delete(k);
          for (const k of [...st.lits.keys()]) if (k !== key && k.startsWith(key + '[')) st.lits.delete(k);
        });
        fnsIn(s);
        continue;
      }
      if (s.type === 'DoStat') { list(s.body, st); continue; }
      const nested: A.Stat[][] = [];
      if (s.type === 'IfStat') { for (const c of s.clauses) nested.push(c.body); if (s.elseBody) nested.push(s.elseBody); }
      else if (s.type === 'WhileStat' || s.type === 'RepeatStat' || s.type === 'NumericForStat' || s.type === 'GenericForStat') nested.push(s.body);
      const loop = s.type === 'WhileStat' || s.type === 'RepeatStat' || s.type === 'NumericForStat' || s.type === 'GenericForStat';
      const changed = nested.length ? assignedIn(s) : new Set<string>();
      const base: St = loop ? { holders: new Map([...st.holders].filter(([k]) => !changed.has(k))), lits: new Map([...st.lits].filter(([k]) => !changed.has(k))) } : st;
      for (const b of nested) list(b, { holders: new Map(base.holders), lits: new Map(base.lits) });
      for (const k of changed) { st.holders.delete(k); st.lits.delete(k); }
      // nested functions: their own lists
      fnsIn(s);
    }
  };
  // function expressions inside a statement's expressions (statement bodies are handled by list())
  const fnsIn = (s: any) => {
    const visit = (x: any, top: boolean) => {
      if (!x || typeof x !== 'object') return;
      if (Array.isArray(x)) { for (const y of x) visit(y, top); return; }
      if (x.type === 'FunctionExpr') { list(x.body, { holders: new Map(), lits: new Map() }); return; }
      for (const k of Object.keys(x)) { if (k === 'loc') continue; if (top && (k === 'body' || k === 'clauses' || k === 'elseBody')) { if (k === 'clauses') for (const c of x.clauses) visit(c.cond, false); continue; } visit(x[k], false); }
    };
    visit(s, true);
  };
  list(chunk.body, { holders: new Map(), lits: new Map() });
  return [...out.values()];
}
