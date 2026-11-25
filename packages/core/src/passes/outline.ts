// PRISM de-outlining pass — universal, nothing obfuscator- or sample-specific.
//
// Some protectors split every real function into dozens of tiny "outlined" chunks stored as methods of ONE
// object table and drive them with a state variable, e.g.
//
//   return setmetatable({
//       Tp = function(r)        local A = 35; while true do
//                                 if A <= 4 then A, G = r:jO(O, G) elseif A <= 6 then ... end end end,
//       jO = function(r, x, H)  ... return 17, r:rO(x)(r.b) end,
//       rO = function(r, x)     ... return function(...) ... end end,
//       [65] = buffer.readu8, kp = "[ -&|-~]", ...
//   }, {}):Tp()(...)
//
// Every chunk receives the state it needs as parameters and returns the next state + updated locals, so an
// interpreter loop / a byte-code deserializer / a loader is scattered across ~100 methods and no single function
// ever shows the whole machine. Because of that the opcode mapper, vm_anatomy, findVmShape and vm_lift only see
// fragments and report "no VM interpreter recognised".
//
// This pass rebuilds the original functions:
//   1. detect method tables: `setmetatable({...}, {})` with an EMPTY metatable (or a write-once local holding one)
//      used as `(...):m()`, carrying >= 2 named function fields;
//   2. prove "self": the object flows only through each method's first parameter and write-once local copies of it;
//   3. resolve constant slots: self[65] -> buffer.readu8, self.kp -> "[ -&|-~]" (keys never written, no dynamic
//      writes, self never leaks as a bare value);
//   4. hoist single-value method calls out of expressions when nothing side-effecting runs before them;
//   5. re-inline every method that has exactly one call site, bottom-up and semantics-preserving: a `return a, b`
//      in tail position becomes an assignment to the call's targets, a fall-through becomes `= nil`.
//
// Everything is guarded: a table whose object escapes, is stored through a dynamic key, has duplicate keys, or a
// method that is recursive / variadic / returns from a non-tail position is left untouched (and reported). The
// result is ordinary Lua that the existing passes and the VM tools can analyse directly.
import type * as A from '../ast.js';
import { walk } from '../ast.js';
import { analyzeScopes, renameBinding } from '../analysis/scope.js';
import type { Binding, ScopeInfo } from '../analysis/scope.js';
import { print } from '../printer.js';

export interface OutlineTableInfo {
  line: number;
  methods: number;
  slots: number;
  entryCalls: number;
  poisoned: string[];
}

export interface OutlineStats {
  /** method tables detected */
  tables: OutlineTableInfo[];
  /** methods re-inlined at their single call site */
  inlined: number;
  /** single-value method calls hoisted out of an expression so they could be inlined */
  hoisted: number;
  /** constant slot reads replaced by their value */
  slots: number;
  /** table fields removed because nothing can read them any more */
  removedFields: number;
  rounds: number;
  notes: string[];
}

export interface OutlineOptions {
  /** cap on fixpoint rounds (default 400) */
  maxRounds?: number;
  /** collect per-table diagnostics */
  diagnostics?: string[];
  /** only process tables that are called as a method on the constructor itself (`({...}):entry()`).
   *  An ordinary class/module table is usually stored or returned and its methods may be called from
   *  outside the chunk, so it is left alone by default. Set false to process every detected table. */
  entryOnly?: boolean;
}

type Parent = { p: any; k: string };

/** library roots whose member paths may be substituted for a constant slot */
const LIBROOTS = new Set([
  'string', 'table', 'math', 'bit32', 'buffer', 'coroutine', 'utf8', 'os', 'debug', 'vector', 'task', 'bit',
  'Vector3', 'Vector2', 'CFrame', 'Color3', 'UDim', 'UDim2', 'Rect', 'Ray', 'Region3', 'BrickColor', 'TweenInfo',
  'NumberRange', 'NumberSequence', 'ColorSequence', 'NumberSequenceKeypoint', 'ColorSequenceKeypoint', 'Instance',
  'Enum', 'DateTime', 'Random', 'Axes', 'Faces', 'PhysicalProperties', 'Font', 'OverlapParams', 'RaycastParams',
  'Vector3int16', 'Vector2int16', 'Region3int16',
  'type', 'typeof', 'select', 'pairs', 'ipairs', 'next', 'rawget', 'rawset', 'rawequal', 'rawlen', 'setmetatable',
  'getmetatable', 'tonumber', 'tostring', 'unpack', 'pcall', 'xpcall', 'error', 'assert', 'print', 'warn',
  'getfenv', 'setfenv', 'newproxy', 'gcinfo', 'require', 'tick', 'time', 'collectgarbage',
]);

const unparen = (e: any): any => { while (e && e.type === 'ParenExpr') e = e.expr; return e; };
const nameExpr = (name: string): A.NameExpr => ({ type: 'NameExpr', name });
const nilLit = (): A.NilLit => ({ type: 'NilLit' });
const clone = <T>(n: T): T => structuredClone(n);

const STAT_TYPES = new Set([
  'LocalStat', 'AssignStat', 'CallStat', 'DoStat', 'WhileStat', 'RepeatStat', 'IfStat', 'NumericForStat',
  'GenericForStat', 'FunctionStat', 'LocalFunctionStat', 'ReturnStat', 'BreakStat', 'ContinueStat', 'GotoStat',
  'LabelStat',
]);

function litKey(e: any): string | null {
  e = unparen(e);
  if (!e) return null;
  if (e.type === 'StringLit') return 's:' + e.value;
  if (e.type === 'NumberLit' && Number.isFinite(e.value)) return 'n:' + e.value;
  return null;
}

/** a value worth substituting for a slot read: library path (buffer.readu8) or a plain literal */
function constSlotValue(e: any, sc: ScopeInfo): A.Expr | null {
  const u = unparen(e);
  if (!u) return null;
  if (u.type === 'NumberLit' || u.type === 'StringLit' || u.type === 'NilLit' || u.type === 'TrueLit' || u.type === 'FalseLit') return u;
  // member path rooted at a library global, e.g. buffer.readu8 / string.byte / table.create
  let cur = u;
  while (cur && cur.type === 'MemberExpr') cur = unparen(cur.obj);
  if (cur && cur.type === 'NameExpr' && LIBROOTS.has(cur.name)) {
    const b = sc.refOf.get(cur);
    if (b && b.kind === 'global') return u;
  }
  return null;
}

// ── value-kind inference ────────────────────────────────────────────────────────────────────────────
// A named method field is always a STRING key, so `self[<numeric>]` can never reach it, and a numeric
// data slot can never be reached by `self[<string>]`. We approximate which kinds a value can evaluate to,
// so a dynamic `self[e]` read/write only poisons the kinds it can actually produce. Anything we cannot
// prove widens to K_ANY and stays fully conservative.
//
// The interesting case is an obfuscator state machine: dynamic keys are parameters of handlers that are
// invoked from one dispatcher, and the arguments are state variables fed by other handlers' return values.
// So a plain "look at the key expression" pass is not enough — we need an interprocedural kind summary:
//   * parameter kinds: union of the argument kinds at every known `self:m(...)` / `(...):m(...)` call site;
//   * return kinds: union over every `return` of a method, per position;
//   * slot kinds: union of the constructor value and every static `self[k] = v` (plus writes routed
//     through a table-field function's first parameter).
// All three are computed together as a monotone fixpoint. Bottom (0) means "no value observed yet"; it is
// not a claim about runtime, only the starting point of the iteration.
const K_NUM = 1, K_STR = 2, K_OTH = 4, K_ANY = 7;

const NUMERIC_LIBCALLS = new Set([
  'math.abs', 'math.ceil', 'math.floor', 'math.fmod', 'math.max', 'math.min', 'math.sqrt', 'math.random',
  'math.clamp', 'math.sign', 'math.round', 'math.exp', 'math.log', 'math.log10', 'math.pow', 'math.noise',
  'math.ldexp', 'math.sin', 'math.cos', 'math.tan', 'math.asin', 'math.acos', 'math.atan', 'math.atan2',
  'math.deg', 'math.rad', 'math.sinh', 'math.cosh', 'math.tanh',
  'bit32.band', 'bit32.bor', 'bit32.bxor', 'bit32.bnot', 'bit32.lshift', 'bit32.rshift', 'bit32.arshift',
  'bit32.lrotate', 'bit32.rrotate', 'bit32.extract', 'bit32.replace', 'bit32.countlz', 'bit32.countrz', 'bit32.byteswap',
  'buffer.readu8', 'buffer.readu16', 'buffer.readu32', 'buffer.readi8', 'buffer.readi16', 'buffer.readi32',
  'buffer.readf32', 'buffer.readf64', 'buffer.len',
  'string.byte', 'string.len', 'utf8.codepoint', 'utf8.len', 'utf8.offset', 'rawlen', 'tonumber', 'os.time', 'os.clock',
]);

/** library calls that always produce a string when they return */
const STRING_LIBCALLS = new Set([
  'tostring', 'type', 'typeof',
  'string.format', 'string.sub', 'string.rep', 'string.upper', 'string.lower', 'string.char', 'string.gsub',
  'string.reverse', 'string.pack', 'table.concat', 'utf8.char',
]);

interface KindCtx {
  /** method name -> its function */
  methods: Map<string, A.FunctionExpr>;
  /** parameter binding of a method -> union of kinds of the arguments passed at known call sites */
  paramKind: Map<Binding, number>;
  /** method function -> kind mask for each return position */
  retKind: Map<A.FunctionExpr, number[]>;
  /** literal key of the outlined object -> kind mask of the value stored there */
  slotKind: Map<string, number>;
  /** true when some dynamic write may create/overwrite a slot */
  dynWrite: boolean;
  /** expression is the outlined object (a self alias) */
  isSelf: (e: any) => boolean;
}

/** dotted global library path for a NameExpr / MemberExpr chain whose root is a global, else null */
function libPath(e: any, sc: ScopeInfo): string | null {
  const u = unparen(e);
  if (!u) return null;
  if (u.type === 'NameExpr') { const b = sc.refOf.get(u); return b && b.kind === 'global' ? u.name : null; }
  if (u.type === 'MemberExpr') { const base = libPath(u.obj, sc); return base ? base + '.' + u.name : null; }
  return null;
}

/** the value at target index `ti` of `as.values`, following Lua multi-value rules */
function assignedKind(values: any[], ti: number, sc: ScopeInfo, pm: Map<any, Parent>, ctx: KindCtx | null, seen: Set<Binding>, depth: number): number {
  if (ti < values.length) return valueKind(values[ti], sc, pm, ctx, seen, depth + 1, 0);
  if (!values.length) return K_OTH;
  const last = unparen(values[values.length - 1]);
  if (last.type === 'CallExpr' || last.type === 'MethodCallExpr' || last.type === 'VarargLit') {
    return valueKind(last, sc, pm, ctx, seen, depth + 1, ti - (values.length - 1));
  }
  return K_OTH;
}

/** best-effort bitmask of K_* kinds a value expression can evaluate to; `pos` selects a multi-value position */
function valueKind(e: any, sc: ScopeInfo, pm: Map<any, Parent>, ctx: KindCtx | null, seen: Set<Binding> = new Set(), depth = 0, pos = 0): number {
  const u = unparen(e);
  if (!u || depth > 24) return K_ANY;
  switch (u.type) {
    case 'NumberLit': return K_NUM;
    case 'StringLit': case 'InterpExpr': return K_STR;
    case 'NilLit': case 'TrueLit': case 'FalseLit': case 'FunctionExpr': case 'TableExpr': return K_OTH;
    case 'VarargLit': return K_ANY;
    case 'ParenExpr': return valueKind(u.expr, sc, pm, ctx, seen, depth + 1, pos);
    case 'UnExpr':
      if (u.op === '-' || u.op === '#') return K_NUM;
      if (u.op === 'not') return K_OTH;
      return K_ANY;
    case 'BinExpr': {
      const op = u.op;
      if (op === '+' || op === '-' || op === '*' || op === '/' || op === '//' || op === '%' || op === '^') return K_NUM;
      if (op === '..') return K_STR;
      if (op === '==' || op === '~=' || op === '<' || op === '>' || op === '<=' || op === '>=') return K_OTH;
      if (op === 'and' || op === 'or') return valueKind(u.left, sc, pm, ctx, seen, depth + 1, pos) | valueKind(u.right, sc, pm, ctx, seen, depth + 1, pos);
      return K_ANY;
    }
    case 'IfExpr': {
      let k = valueKind(u.elseValue, sc, pm, ctx, seen, depth + 1, pos);
      for (const c of u.clauses) k |= valueKind(c.value, sc, pm, ctx, seen, depth + 1, pos);
      return k;
    }
    case 'MethodCallExpr': {
      // `self:m(...)` — the method's return summary; any other receiver is unknown code
      if (ctx?.isSelf(u.obj)) {
        const fn = ctx.methods.get(u.method);
        if (fn) return ctx.retKind.get(fn)?.[pos] ?? K_OTH;
      }
      return K_ANY;
    }
    case 'CallExpr': {
      const lp = libPath(u.callee, sc);
      if (lp) {
        if (STRING_LIBCALLS.has(lp)) return K_STR;
        if (lp === 'select') {
          const a0 = unparen(u.args[0]);
          return a0?.type === 'StringLit' && a0.value === '#' ? K_NUM : K_ANY;
        }
        if (NUMERIC_LIBCALLS.has(lp)) return K_NUM | K_OTH;
      }
      return K_ANY;
    }
    case 'MemberExpr': {
      if (ctx?.isSelf(u.obj)) return ctx.slotKind.get('s:' + u.name) ?? K_OTH;
      return K_ANY;
    }
    case 'IndexExpr': {
      if (ctx?.isSelf(u.obj)) {
        const lk = litKey(u.index);
        if (lk !== null) {
          const sk = ctx.slotKind.get(lk);
          if (sk !== undefined) return sk;
          return ctx.dynWrite ? K_ANY : K_OTH; // absent slot = nil; a dynamic write could create it
        }
        return K_ANY; // dynamic key inside a slot lookup — not modelled
      }
      return K_ANY;
    }
    case 'NameExpr': {
      const b = sc.refOf.get(u);
      if (!b) return K_ANY;
      if (b.kind === 'global') return K_ANY;
      if (b.kind === 'param') return ctx ? (ctx.paramKind.get(b) ?? K_ANY) : K_ANY;
      if (b.kind === 'localfn') return K_OTH;
      if (b.decl && (b.decl as any).type === 'NumericForStat') return K_NUM;
      if (b.kind !== 'local') return K_ANY; // generic-for variables can hold anything
      if (seen.has(b)) return 0;
      seen.add(b);
      let k = 0;
      // initial value (explicit or the continuation of a multi-value initializer)
      if (b.init) k |= valueKind(b.init, sc, pm, ctx, seen, depth + 1, b.initMulti ? 0 : 0);
      else {
        const decl = b.decl;
        let fromMulti = false;
        if (decl && (decl as any).type === 'LocalStat' && (decl as any).init?.length) {
          const init = (decl as any).init as any[];
          const j = Math.min(b.index, init.length - 1);
          const src = unparen(init[j]);
          if (src && (src.type === 'CallExpr' || src.type === 'MethodCallExpr' || src.type === 'VarargLit')) {
            k |= valueKind(src, sc, pm, ctx, seen, depth + 1, b.index - j);
            fromMulti = true;
          }
        }
        if (!fromMulti) k |= K_OTH; // declared without initializer -> nil
      }
      for (const wr of b.writeRefs ?? []) {
        const pi = pm.get(wr);
        if (!pi || pi.p.type !== 'AssignStat' || pi.k !== 'targets') { k |= K_ANY; continue; }
        const as: any = pi.p;
        const ti = as.targets.indexOf(wr);
        if (ti < 0) { k |= K_ANY; continue; }
        if (as.op) { k |= as.op === '..' ? K_STR : K_NUM; continue; } // compound assignment
        k |= assignedKind(as.values, ti, sc, pm, ctx, seen, depth + 1);
      }
      return k || K_OTH;
    }
    default: return K_ANY;
  }
}

function parentMap(root: any): Map<any, Parent> {
  const pm = new Map<any, Parent>();
  // Note: if-clause objects (`{ cond, body }`) carry no `type`; the generic `walk` never registers them,
  // so climbing from a statement directly inside an if-branch used to stop there (no owning function,
  // incomplete scope checks). Register every non-array object, typed or not.
  const visit = (n: any, p: any, k: string | null) => {
    if (!n || typeof n !== 'object') return;
    if (p && k !== null) pm.set(n, { p, k });
    for (const key of Object.keys(n)) {
      if (key === 'loc') continue;
      const v = (n as any)[key];
      if (Array.isArray(v)) { for (const el of v) visit(el, n, key); }
      else if (v && typeof v === 'object') visit(v, n, key);
    }
  };
  visit(root, null, null);
  return pm;
}

function declByDecl(sc: ScopeInfo): Map<any, Binding[]> {
  const m = new Map<any, Binding[]>();
  for (const b of sc.bindings) { if (!b.decl) continue; let l = m.get(b.decl); if (!l) m.set(b.decl, l = []); l.push(b); }
  return m;
}

/** walk a subtree without descending into nested functions (fn called on the FunctionExpr itself, then stops) */
function walkNoFn(node: any, fn: (n: any) => void) {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) { for (const x of node) walkNoFn(x, fn); return; }
  if (typeof node.type === 'string') { fn(node); if (node.type === 'FunctionExpr') return; }
  for (const k of Object.keys(node)) { if (k === 'loc') continue; const v = node[k]; if (v && typeof v === 'object') walkNoFn(v, fn); }
}

function returnsOf(body: A.Stat[]): A.ReturnStat[] {
  const out: A.ReturnStat[] = [];
  walkNoFn(body, (n: any) => { if (n.type === 'ReturnStat') out.push(n); });
  return out;
}

/** the returns that sit in tail position of a statement list (end of body / end of an if-branch / end of a do) */
function tailReturns(body: A.Stat[], acc: Set<A.ReturnStat>) {
  const last = body[body.length - 1];
  if (!last) return;
  if (last.type === 'ReturnStat') acc.add(last);
  else if (last.type === 'IfStat') { for (const c of last.clauses) tailReturns(c.body, acc); if (last.elseBody) tailReturns(last.elseBody, acc); }
  else if (last.type === 'DoStat') tailReturns(last.body, acc);
}

/** rewrite every tail return of `body` in place; fall-through ends get onFall() appended */
function rewriteTails(body: A.Stat[], onRet: (r: A.ReturnStat) => A.Stat[], onFall: () => A.Stat[]) {
  const last = body[body.length - 1];
  if (last && last.type === 'ReturnStat') { body.splice(body.length - 1, 1, ...onRet(last)); return; }
  if (last && last.type === 'IfStat') {
    for (const c of last.clauses) rewriteTails(c.body, onRet, onFall);
    if (last.elseBody) rewriteTails(last.elseBody, onRet, onFall);
    else { const e = onFall(); if (e.length) last.elseBody = e; }
    return;
  }
  if (last && last.type === 'DoStat') { rewriteTails(last.body, onRet, onFall); return; }
  body.push(...onFall());
}

interface Obj {
  tbl: A.TableExpr;
  line: number;
  /** key ("s:Tp" / "n:65") -> field */
  fields: Map<string, A.TableField>;
  /** keys that appear more than once, or may collide with a computed key */
  ambiguous: Set<string>;
  /** method name -> its FunctionExpr (named function fields with >= 1 param) */
  methods: Map<string, A.FunctionExpr>;
  /** method-call expressions on the raw table (entry points, e.g. `(...):Tp()`) */
  entries: A.MethodCallExpr[];
  /** write-once locals that hold the raw table */
  roots: Binding[];
}

function fieldKey(f: A.TableField, itemPos: number): string | null {
  if (f.kind === 'named') return 's:' + (f.name ?? '');
  if (f.kind === 'keyed') return litKey(f.key);
  return 'n:' + itemPos; // positional array entry
}

function makeObj(t: A.TableExpr): Obj | null {
  const fields = new Map<string, A.TableField>(), ambiguous = new Set<string>(), methods = new Map<string, A.FunctionExpr>();
  let pos = 0, hasComputedKey = false;
  for (const f of t.fields) {
    if (f.kind === 'item') pos++;
    if (f.kind === 'keyed' && litKey(f.key) === null) { hasComputedKey = true; continue; }
    const k = fieldKey(f, pos);
    if (k === null) continue;
    if (fields.has(k)) ambiguous.add(k);
    fields.set(k, f);
  }
  if (hasComputedKey) for (const k of fields.keys()) ambiguous.add(k); // a dynamic key may alias anything
  for (const [k, f] of fields) {
    if (ambiguous.has(k) || !k.startsWith('s:')) continue;
    const v = f.value;
    if (v.type === 'FunctionExpr' && v.params.length >= 1) methods.set(k.slice(2), v);
  }
  if (methods.size < 2) return null;
  return { tbl: t, line: t.loc?.line ?? 0, fields, ambiguous, methods, entries: [], roots: [] };
}

/** `setmetatable({...}, {})` with an empty metatable, or a bare `{...}` */
function rawTable(e0: any, sc: ScopeInfo): A.TableExpr | null {
  const e = unparen(e0);
  if (!e) return null;
  if (e.type === 'TableExpr') return e;
  if (e.type === 'CallExpr' && e.callee.type === 'NameExpr' && e.callee.name === 'setmetatable' && e.args.length === 2 && sc.refOf.get(e.callee)?.kind === 'global') {
    const t = unparen(e.args[0]), m = unparen(e.args[1]);
    if (t.type === 'TableExpr' && m.type === 'TableExpr' && m.fields.length === 0) return t;
  }
  return null;
}

function findObjects(chunk: A.Chunk, sc: ScopeInfo): Obj[] {
  const byTable = new Map<A.TableExpr, Obj>();
  const rejected = new Set<A.TableExpr>();
  walk(chunk, (n: any) => {
    if (n.type !== 'MethodCallExpr') return;
    let t = rawTable(n.obj, sc);
    let root: Binding | undefined;
    if (!t) {
      const o = unparen(n.obj);
      if (o.type === 'NameExpr') {
        const b = sc.refOf.get(o);
        if (b && b.kind === 'local' && b.writes === 0 && b.init && !b.initMulti) { t = rawTable(b.init, sc); if (t) root = b; }
      }
    }
    if (!t || rejected.has(t)) return;
    let ob = byTable.get(t);
    if (!ob) { const m = makeObj(t); if (!m) { rejected.add(t); return; } byTable.set(t, ob = m); }
    if (!ob.methods.has(n.method)) return;
    if (root) { if (!ob.roots.includes(root)) ob.roots.push(root); }
    else ob.entries.push(n);
  });
  return [...byTable.values()];
}

/** a static write to a literal key of the object (`self[k] = v`), recorded for slot value-kind inference */
interface SlotWrite { key: string; stmt: A.AssignStat; ti: number; }
/** a dynamic `self[expr]` access; its kind is computed only after the call-site/return/slot fixpoint */
interface DynAccess { expr: any; isWrite: boolean; stmt?: A.AssignStat; ti?: number; node: any; }

interface Analysis {
  /** every binding that may hold the object (method selves + roots + write-once copies) */
  selfLike: Set<Binding>;
  /** self-alias binding -> true */
  isSelf: (e: any) => boolean;
  /** method name -> its `recv:m(...)` call sites that run on a proven self-alias */
  callSites: Map<string, A.MethodCallExpr[]>;
  /** method name -> true if its field value is read in any non-(method-call) way (so it cannot be dropped) */
  valueRead: Set<string>;
  /** keys written through self (`self.k = v`) */
  written: Set<string>;
  /** self[dynamicKey] read / write seen */
  dynRead: boolean;
  dynWrite: boolean;
  /** union of K_* kinds a dynamic read / write key can evaluate to */
  dynReadKinds: number;
  dynWriteKinds: number;
  /** printed dynamic key expressions -> count, prefixed R/W + proven kind mask (diagnostics) */
  dynKeys: Map<string, number>;
  /** self used as a bare value (argument, return, stored) — slot resolution then becomes unsafe */
  selfEscapes: boolean;
  /** self.k / self[k] read accesses grouped by key */
  reads: Map<string, any[]>;
  /** where self leaked as a bare value (diagnostics) */
  escapeSites: string[];
  /** binding details of each dynamic self[key] access (diagnostics) */
  dynSites: string[];
  /** static writes to literal keys (constructor fields are added separately) */
  slotWrites: SlotWrite[];
  /** dynamic self[key] accesses whose key kind is computed at the end of the analysis */
  dynAccesses: DynAccess[];
}

function analyzeObj(ob: Obj, sc: ScopeInfo, pm: Map<any, Parent>, decls: Map<any, Binding[]>): Analysis {
  const paramBinding = (fn: A.FunctionExpr, i: number) => (decls.get(fn) ?? []).find(b => b.index === i && b.kind === 'param');
  const selfLike = new Set<Binding>();
  const queue: Binding[] = [];
  for (const fn of ob.methods.values()) { const b = paramBinding(fn, 0); if (b) queue.push(b); }
  for (const r of ob.roots) queue.push(r);
  while (queue.length) {
    const b = queue.shift()!;
    if (selfLike.has(b)) continue;
    selfLike.add(b);
    for (const ref of b.refs) {
      const pi = pm.get(ref);
      if (pi && pi.p.type === 'LocalStat' && pi.k === 'init') {
        const idx = pi.p.init.indexOf(ref);
        if (idx >= 0 && idx < pi.p.names.length && (idx < pi.p.init.length - 1 || pi.p.init.length >= pi.p.names.length)) {
          const a = (decls.get(pi.p) ?? []).find(x => x.index === idx);
          if (a && a.writes === 0 && !selfLike.has(a)) queue.push(a);
        }
      }
    }
  }
  const isSelf = (e: any): boolean => { const u = unparen(e); if (!u || u.type !== 'NameExpr') return false; const b = sc.refOf.get(u); return !!b && selfLike.has(b); };

  const an: Analysis = {
    selfLike, isSelf, callSites: new Map(), valueRead: new Set(), written: new Set(), dynRead: false, dynWrite: false,
    dynReadKinds: 0, dynWriteKinds: 0, dynKeys: new Map(), selfEscapes: false, reads: new Map(), escapeSites: [], dynSites: [],
    slotWrites: [], dynAccesses: [],
  };
  const noteCall = (m: string, c: A.MethodCallExpr) => { let l = an.callSites.get(m); if (!l) an.callSites.set(m, l = []); l.push(c); };
  const noteRead = (k: string, node: any) => { let l = an.reads.get(k); if (!l) an.reads.set(k, l = []); l.push(node); };

  // `self` passed as arg0 of `self[k](self, ...)` or `f(self, ...)` where `f = self.m` is a method dispatch, not a leak
  const isDispatchReceiver = (ref: any, p: any, pi: Parent): boolean => {
    if (p.type !== 'CallExpr' || pi.k !== 'args' || p.args[0] !== ref) return false;
    const callee = unparen(p.callee);
    if ((callee.type === 'MemberExpr' || callee.type === 'IndexExpr') && isSelf(callee.obj)) return true;
    if (callee.type === 'NameExpr') {
      const cb = sc.refOf.get(callee);
      if (cb && cb.kind === 'local' && cb.writes === 0 && cb.init) { const ci = unparen(cb.init); if ((ci.type === 'MemberExpr' || ci.type === 'IndexExpr') && isSelf(ci.obj)) return true; }
    }
    return false;
  };

  for (const b of selfLike) {
    for (const ref of b.refs) {
      const pi = pm.get(ref);
      if (!pi) continue;
      const p = pi.p;
      // self:method(...)
      if (p.type === 'MethodCallExpr' && pi.k === 'obj') {
        if (ob.methods.has(p.method) && !ob.ambiguous.has('s:' + p.method)) noteCall(p.method, p); continue;
      }
      // self.k / self[k]
      if ((p.type === 'MemberExpr' || p.type === 'IndexExpr') && pi.k === 'obj') {
        const access = p;
        const k = p.type === 'MemberExpr' ? 's:' + p.name : litKey(p.index);
        const ap = pm.get(access);
        const isWrite = !!ap && ap.p.type === 'AssignStat' && ap.k === 'targets';
        if (k === null) {
          if (isWrite) {
            an.dynWrite = true;
            const as = ap!.p as A.AssignStat;
            const ti = as.targets.indexOf(access);
            an.dynAccesses.push({ expr: p.index, isWrite: true, node: p, stmt: as, ti: ti >= 0 ? ti : 0 });
          } else {
            an.dynRead = true;
            an.dynAccesses.push({ expr: p.index, isWrite: false, node: p });
          }
          continue;
        }
        if (isWrite) {
          an.written.add(k);
          const as = ap!.p as A.AssignStat;
          const ti = as.targets.indexOf(access);
          if (ti >= 0) an.slotWrites.push({ key: k, stmt: as, ti });
          continue;
        }
        noteRead(k, access);
        // reading a method field as a value (not a `self:m` call we already handled) prevents dropping it
        if (k.startsWith('s:') && ob.methods.has(k.slice(2))) an.valueRead.add(k.slice(2));
        continue;
      }
      // self as the receiver of a dynamic / indirect method call is fine (the callee is one of our own methods)
      if (isDispatchReceiver(ref, p, pi)) continue;
      // any other use of the self-alias name is a genuine escape — disables slot resolution for safety
      an.selfEscapes = true;
      if (an.escapeSites.length < 12) {
        let own = '?'; { let cur: any = p; while (cur) { if (cur.type === 'FunctionExpr') { for (const [mn, mf] of ob.methods) if (mf === cur) { own = mn; break; } if (own !== '?') break; } const q = pm.get(cur); cur = q ? q.p : null; } }
        let snip = ''; try { snip = print(p as any).replace(/\s+/g, ' ').slice(0, 140); } catch { snip = '<print failed>'; }
        an.escapeSites.push(`${p.type}.${pi.k} in=${own} :: ${snip}`);
      }
    }
  }

  // write-safety augmentation: a static write to a key through ANY table-field function's own first parameter
  // (the dynamic-dispatch convention `tbl[k](tbl, ...)` can route self into closure-generator slots too) marks
  // that key as written, so we never substitute a slot that some handler rewrites. Dynamic writes there are not
  // globally poisoning because that parameter is not proven to be the object.
  for (const f of ob.tbl.fields) {
    const v: any = f.value;
    if (!v || v.type !== 'FunctionExpr' || v.params.length < 1) continue;
    const b0 = (decls.get(v) ?? []).find(x => x.index === 0 && x.kind === 'param');
    if (!b0) continue;
    for (const ref of b0.refs) {
      const pi = pm.get(ref);
      if (!pi || (pi.p.type !== 'MemberExpr' && pi.p.type !== 'IndexExpr') || pi.k !== 'obj') continue;
      const k = pi.p.type === 'MemberExpr' ? 's:' + pi.p.name : litKey(pi.p.index);
      if (k === null) continue;
      const ap = pm.get(pi.p);
      if (ap && ap.p.type === 'AssignStat' && ap.k === 'targets') {
        an.written.add(k);
        const as = ap.p as A.AssignStat;
        const ti = as.targets.indexOf(pi.p);
        if (ti >= 0) an.slotWrites.push({ key: k, stmt: as, ti });
      }
    }
  }

  // dynamic key kinds need the complete call-site / return / slot picture, so compute them last
  inferKinds(ob, an, sc, pm, decls);
  return an;
}

/** union of kinds of the i-th argument of a call site, following Lua multi-value expansion */
function argKindAt(args: any[], i: number, sc: ScopeInfo, pm: Map<any, Parent>, ctx: KindCtx): number {
  if (i < args.length) return valueKind(args[i], sc, pm, ctx, new Set(), 0, 0);
  if (!args.length) return K_OTH;
  return assignedKind(args, i, sc, pm, ctx, new Set(), 0);
}

/**
 * Interprocedural kind fixpoint for the outlined table: parameter kinds from known call sites, method
 * return kinds per position, and literal slot kinds from the constructor plus static writes. The result
 * is only used to classify *dynamic keys*; every gate that removes a field still requires the final
 * `dynReadKinds & K_STR == 0`, so a key we cannot prove stays conservative.
 */
function inferKinds(ob: Obj, an: Analysis, sc: ScopeInfo, pm: Map<any, Parent>, decls: Map<any, Binding[]>): void {
  const sites = new Map<string, any[]>();
  const addSite = (m: string, c: any) => { let l = sites.get(m); if (!l) sites.set(m, l = []); l.push(c); };
  for (const [m, list] of an.callSites) for (const c of list) addSite(m, c);
  for (const e of ob.entries) addSite(e.method, e);

  // the largest multi-value position any assignment/call in this table can observe
  let maxNeed = 8;
  for (const fn of ob.methods.values()) walk(fn.body, (n: any) => {
    if (n.type === 'LocalStat') maxNeed = Math.max(maxNeed, n.names.length);
    else if (n.type === 'AssignStat') maxNeed = Math.max(maxNeed, n.targets.length);
    else if (n.type === 'ReturnStat') maxNeed = Math.max(maxNeed, n.args.length);
    else if ((n.type === 'CallExpr' || n.type === 'MethodCallExpr') && Array.isArray(n.args)) maxNeed = Math.max(maxNeed, n.args.length);
  });
  maxNeed = Math.min(maxNeed, 48);

  const paramKind = new Map<Binding, number>();
  const retKind = new Map<A.FunctionExpr, number[]>();
  const slotKind = new Map<string, number>();
  const ctx: KindCtx = { methods: ob.methods, paramKind, retKind, slotKind, dynWrite: an.dynWrite, isSelf: an.isSelf };

  const orInto = (m: Map<any, any>, key: any, k: number): boolean => {
    const old = (m.get(key) ?? 0) as number;
    if ((k & ~old) === 0) return false;
    m.set(key, old | k);
    return true;
  };

  for (let iter = 0; iter < 40; iter++) {
    let changed = false;

    // 1. return kinds, per method and position
    for (const fn of ob.methods.values()) {
      const arr = retKind.get(fn) ?? [];
      for (const r of returnsOf(fn.body)) {
        for (let pos = 0; pos < maxNeed; pos++) {
          const k = r.args.length
            ? (pos < r.args.length
              ? valueKind(r.args[pos], sc, pm, ctx, new Set(), 0, 0)
              : assignedKind(r.args, pos, sc, pm, ctx, new Set(), 0))
            : K_OTH;
          const old = arr[pos] ?? 0;
          if ((k & ~old) !== 0) { arr[pos] = old | k; changed = true; }
        }
      }
      if (!retKind.has(fn)) retKind.set(fn, arr);
    }

    // 2. parameter kinds from every known call site
    for (const [m, fn] of ob.methods) {
      if (an.valueRead.has(m)) continue; // the method value escapes; call sites are not exhaustive
      const list = sites.get(m);
      if (!list?.length) continue;
      for (const b of decls.get(fn) ?? []) {
        if (b.kind !== 'param' || b.index === 0) continue;
        let k = 0;
        for (const site of list) k |= argKindAt(site.args, b.index - 1, sc, pm, ctx);
        if (orInto(paramKind, b, k)) changed = true;
      }
    }

    // 3. slot kinds: constructor values + static writes
    for (const [key, field] of ob.fields) {
      if (orInto(slotKind, key, valueKind(field.value, sc, pm, ctx, new Set(), 0, 0))) changed = true;
    }
    for (const w of an.slotWrites) {
      if (orInto(slotKind, w.key, assignedKind(w.stmt.values, w.ti, sc, pm, ctx, new Set(), 0))) changed = true;
    }
    // a dynamic write can overwrite any slot of a matching kind
    if (an.dynWrite) {
      for (const d of an.dynAccesses) {
        if (!d.isWrite || !d.stmt) continue;
        const dk = valueKind(d.expr, sc, pm, ctx, new Set(), 0, 0);
        const vk = assignedKind(d.stmt.values, d.ti ?? 0, sc, pm, ctx, new Set(), 0);
        if (!dk || !vk) continue;
        for (const key of [...ob.fields.keys(), ...an.slotWrites.map(w => w.key)]) {
          const mask = key.startsWith('n:') ? K_NUM : K_STR;
          if (dk & mask) { if (orInto(slotKind, key, vk)) changed = true; }
        }
      }
    }

    if (!changed) break;
  }

  // 4. classify the deferred dynamic keys and fill the diagnostics
  for (const d of an.dynAccesses) {
    const kk = valueKind(d.expr, sc, pm, ctx, new Set(), 0, 0);
    if (d.isWrite) an.dynWriteKinds |= kk; else an.dynReadKinds |= kk;
    if (an.dynKeys.size < 400) {
      const ks = (d.isWrite ? 'W' : 'R') + kk + ' ' + print(d.expr as A.Expr).replace(/\s+/g, ' ').slice(0, 70);
      an.dynKeys.set(ks, (an.dynKeys.get(ks) ?? 0) + 1);
    }
    if (an.dynSites.length < 24) an.dynSites.push(describeDynSite(ob, an, d, kk, sc, pm, decls));
  }
}

/** one-line explanation of a dynamic key (diagnostics only) */
function describeDynSite(ob: Obj, an: Analysis, d: DynAccess, kk: number, sc: ScopeInfo, pm: Map<any, Parent>, decls: Map<any, Binding[]>): string {
  const p = d.node;
  let own = '?'; { let cur: any = p; while (cur) { if (cur.type === 'FunctionExpr') { for (const [mn, mf] of ob.methods) if (mf === cur) { own = mn; break; } if (own !== '?') break; } const q = pm.get(cur); cur = q ? q.p : null; } }
  const ix = unparen(d.expr);
  let detail = `${d.isWrite ? 'W' : 'R'} mask=${kk} own=${own} expr=${ix?.type ?? '?'}`;
  try { detail += ` site=${print(p).replace(/\s+/g, ' ').slice(0, 90)}`; } catch { /* ignore */ }
  if (ix?.type === 'NameExpr') {
    const b = sc.refOf.get(ix);
    if (b) {
      detail += ` name=${b.name} kind=${b.kind} decl=${(b.decl as any)?.type ?? '-'} idx=${b.index} writes=${b.writes}`;
      let ownerName = '';
      for (const [mn, mf] of ob.methods) if (mf === b.decl) { ownerName = mn; break; }
      if (ownerName) {
        const callSites = an.callSites.get(ownerName) ?? [];
        detail += ` paramOf=${ownerName} callSites=${callSites.length}`;
        for (const cs of callSites.slice(0, 3)) {
          const a = cs.args[b.index - 1];
          if (!a) { detail += ` [arg${b.index}=absent]`; continue; }
          let txt = ''; try { txt = print(a).replace(/\s+/g, ' ').slice(0, 36); } catch { /* ignore */ }
          detail += ` [arg${b.index}=${txt}]`;
        }
      } else if (b.kind === 'param') detail += ' paramOf=nested';
      if (b.init) { try { detail += ` init=${print(b.init).replace(/\s+/g, ' ').slice(0, 80)}`; } catch { /* ignore */ } }
    }
  } else if (ix) { try { detail += ` text=${print(ix).replace(/\s+/g, ' ').slice(0, 90)}`; } catch { /* ignore */ } }
  return detail;
}

function replaceNode(pm: Map<any, Parent>, node: any, repl: any): boolean {
  const pi = pm.get(node);
  if (!pi) return false;
  const slot = pi.p[pi.k];
  if (Array.isArray(slot)) { const i = slot.indexOf(node); if (i < 0) return false; slot[i] = repl; }
  else pi.p[pi.k] = repl;
  return true;
}

/** nearest enclosing statement of a node */
function enclosingStmt(node: any, pm: Map<any, Parent>): any {
  let cur = node;
  while (cur) { if (STAT_TYPES.has(cur.type)) return cur; const pi = pm.get(cur); if (!pi) return null; cur = pi.p; }
  return null;
}

/** the statement array (and the stmt itself) that directly contains `stmt` */
function stmtContainer(stmt: any, pm: Map<any, Parent>): { arr: any[] } | null {
  const pi = pm.get(stmt);
  if (!pi) return null;
  const slot = pi.p[pi.k];
  if (Array.isArray(slot)) return { arr: slot };
  return null;
}

/** which method body (or null = chunk / other) directly owns this node */
function owningMethod(node: any, pm: Map<any, Parent>, fnToName: Map<A.FunctionExpr, string>): string | null {
  let cur = node;
  while (cur) { if (cur.type === 'FunctionExpr' && fnToName.has(cur)) return fnToName.get(cur)!; const pi = pm.get(cur); if (!pi) return null; cur = pi.p; }
  return null;
}

/** does any side-effecting sub-expression evaluate before `target` inside `stmt`? (literals / names are safe) */
function sideEffectBefore(stmt: any, target: any, sc: ScopeInfo): boolean {
  let found = false, bad = false;
  const visit = (n: any): void => {
    if (found || bad || !n || typeof n !== 'object') return;
    if (Array.isArray(n)) { for (const x of n) { visit(x); if (found || bad) return; } return; }
    if (n === target) { found = true; return; }
    switch (n.type) {
      case 'NumberLit': case 'StringLit': case 'NilLit': case 'TrueLit': case 'FalseLit': case 'VarargLit': return;
      case 'NameExpr': { const b = sc.refOf.get(n); if (b && (b.kind === 'local' || b.kind === 'param') && !b.capturedWrite) return; bad = true; return; } // a global or captured-for-write name could be changed by the callee
      case 'ParenExpr': visit(n.expr); return;
      case 'BinExpr': visit(n.left); if (found || bad) return; visit(n.right); return;
      case 'UnExpr': visit(n.expr); return;
      case 'MemberExpr': visit(n.obj); if (!found) bad = true; return; // a field read before the call could observe a write the callee makes, or trigger __index
      case 'IndexExpr': visit(n.obj); if (found || bad) return; visit(n.index); if (!found) bad = true; return; // table index may invoke __index / observe callee writes
      case 'CallExpr': case 'MethodCallExpr': case 'TableExpr': case 'InterpExpr': case 'IfExpr': case 'FunctionExpr': bad = true; return;
      default: bad = true; return;
    }
  };
  // only look at the expression-bearing parts of the statement
  for (const key of ['init', 'values', 'args', 'cond', 'expr', 'from', 'to', 'step', 'iters', 'targets', 'target', 'clauses', 'elseValue']) {
    if (key in stmt) { visit((stmt as any)[key]); if (found || bad) break; }
  }
  return bad;
}

function isMultiTail(node: any, pm: Map<any, Parent>): boolean {
  const pi = pm.get(node);
  if (!pi) return false;
  const { p, k } = pi;
  if ((p.type === 'CallExpr' || p.type === 'MethodCallExpr') && k === 'args') return p.args[p.args.length - 1] === node;
  if (p.type === 'ReturnStat' && k === 'args') return p.args[p.args.length - 1] === node;
  if (p.type === 'TableExpr') return false;
  if (p.type === 'TableField' && k === 'value') { const tf = pm.get(p); return !!tf && tf.p.type === 'TableExpr' && tf.p.fields[tf.p.fields.length - 1] === p && p.kind === 'item'; }
  return false;
}

export function reinlineOutlined(chunk: A.Chunk, opts: OutlineOptions = {}): OutlineStats {
  const stats: OutlineStats = { tables: [], inlined: 0, hoisted: 0, slots: 0, removedFields: 0, rounds: 0, notes: [] };
  const maxRounds = opts.maxRounds ?? 400;

  let sc0 = analyzeScopes(chunk);
  const initialObjs = findObjects(chunk, sc0);
  if (!initialObjs.length) return stats;
  for (const ob of initialObjs) stats.tables.push({ line: ob.line, methods: ob.methods.size, slots: ob.fields.size - ob.methods.size, entryCalls: ob.entries.length, poisoned: [] });

  for (let round = 0; round < maxRounds; round++) {
    stats.rounds = round + 1;
    let changed = 0;
    try {
      const sc = analyzeScopes(chunk);
      const pm = parentMap(chunk);
      const decls = declByDecl(sc);
      const objs = findObjects(chunk, sc);
      if (!objs.length) break;

      for (const ob of objs) {
        if (opts.entryOnly !== false && !ob.entries.length) continue; // not an immediately-consumed constructor: leave it alone
        const an = analyzeObj(ob, sc, pm, decls);
        if (round === 0 && opts.diagnostics) {
          opts.diagnostics.push(`  @${ob.line}: selfAliases=${an.selfLike.size} readKeys=${an.reads.size} written=${[...an.written].join(',')} dynRead=${an.dynRead} dynWrite=${an.dynWrite} selfEscapes=${an.selfEscapes} callMethods=${an.callSites.size} valueRead=${[...an.valueRead].join(',')}`);
          for (const s of an.escapeSites) opts.diagnostics.push('    escape ' + s);
          for (const s of an.dynSites) opts.diagnostics.push('    dynSite ' + s);
          for (const [ks, n] of [...an.dynKeys].sort((x, y) => y[1] - x[1]).slice(0, 30)) opts.diagnostics.push('    dyn ' + ks + ' x' + n);
        }
        const fnToName = new Map<A.FunctionExpr, string>();
        for (const [name, fn] of ob.methods) fnToName.set(fn, name);

        // ── 1. constant slot resolution ───────────────────────────────────────────────────────────────────
        if (!an.selfEscapes) {
          for (const [k, accesses] of an.reads) {
            if (an.written.has(k) || ob.ambiguous.has(k)) continue;
            if (an.dynWrite && (an.dynWriteKinds & (k.startsWith('n:') ? K_NUM : K_STR))) continue; // a dynamic write could hit this key
            const field = ob.fields.get(k);
            if (!field) continue;
            const cv = constSlotValue(field.value, sc);
            if (!cv) continue;
            if (k.startsWith('s:') && ob.methods.has(k.slice(2))) continue; // never fold a method field
            // never duplicate a long string (payloads): substitute only short strings, or a string read exactly once
            if (cv.type === 'StringLit' && (cv as A.StringLit).value.length > 80 && accesses.length > 1) continue;
            for (const acc of accesses) if (replaceNode(pm, acc, clone(cv))) { stats.slots++; changed++; }
          }
        }

        // ── 2. hoist single-value method calls out of expressions ─────────────────────────────────────────
        for (const [m, sites] of an.callSites) {
          if (sites.length !== 1 || an.valueRead.has(m)) continue;
          const mc = sites[0];
          const stmt = enclosingStmt(mc, pm);
          if (!stmt) continue;
          const direct = (stmt.type === 'CallStat' && stmt.expr === mc)
            || (stmt.type === 'AssignStat' && !stmt.op && stmt.values.length === 1 && stmt.values[0] === mc)
            || (stmt.type === 'LocalStat' && stmt.init.length === 1 && stmt.init[0] === mc);
          if (direct) continue; // already in a form inlining can consume
          if (isMultiTail(mc, pm)) continue; // last arg / return value: hoisting would drop extra results
          if (sideEffectBefore(stmt, mc, sc)) continue;
          const cont = stmtContainer(stmt, pm);
          if (!cont) continue;
          const tmp = uniqueName(sc, 'hoist');
          const decl: A.LocalStat = { type: 'LocalStat', names: [tmp], init: [mc] };
          if (!replaceNode(pm, mc, nameExpr(tmp))) continue;
          const i = cont.arr.indexOf(stmt);
          if (i < 0) continue;
          cont.arr.splice(i, 0, decl);
          stats.hoisted++; changed++;
        }
        if (changed) break; // re-analyse after structural change

        // ── 3. re-inline single-call-site methods ─────────────────────────────────────────────────────────
        // Inlining a method only pays off when its definition can be dropped afterwards; otherwise every
        // inlined copy leaves a second, dead definition in the table and the output only gets longer.
        // A dynamic read whose key may be a string can reach any named method field, so the method space
        // is closed and we keep the calls (constant slot folding above still applies).
        const methodSpaceOpen = !an.selfEscapes && !(an.dynReadKinds & K_STR) && !(an.dynWriteKinds & K_STR);
        const reach = methodReach(ob, an);
        const batch: Array<{ m: string; fn: A.FunctionExpr; mc: A.MethodCallExpr; stmt: any; form: 'call' | 'assign' | 'local' | 'return' }> = [];
        if (methodSpaceOpen) for (const [m, sites] of an.callSites) {
          if (sites.length !== 1 || an.valueRead.has(m)) continue;
          const fn = ob.methods.get(m)!;
          if (fn.vararg) continue;
          if (an.selfEscapes || an.written.has('s:' + m) || (an.dynWriteKinds & K_STR)) continue; // the method field could be overwritten, or self leaks (hidden call sites)
          if (reach.get(m)?.has(m)) continue; // recursive / in a cycle
          const mc = sites[0];
          const stmt = enclosingStmt(mc, pm);
          if (!stmt) continue;
          let form: 'call' | 'assign' | 'local' | 'return' | null = null;
          if (stmt.type === 'CallStat' && stmt.expr === mc) form = 'call';
          else if (stmt.type === 'AssignStat' && !stmt.op && stmt.values.length === 1 && stmt.values[0] === mc) form = 'assign';
          else if (stmt.type === 'LocalStat' && stmt.init.length === 1 && stmt.init[0] === mc) form = 'local';
          else if (stmt.type === 'ReturnStat' && stmt.args.length === 1 && stmt.args[0] === mc) form = 'return';
          if (!form) continue;
          // assign-form targets must all be plain names, else they would be evaluated after the inlined body instead of before it
          if (form === 'assign' && !(stmt as A.AssignStat).targets.every((t: any) => unparen(t).type === 'NameExpr')) continue;
          const rs = returnsOf(fn.body); const tails = new Set<A.ReturnStat>(); tailReturns(fn.body, tails);
          if (form !== 'return' && !rs.every(r => tails.has(r))) continue; // a non-tail return cannot become an assignment (the return form keeps returns)
          if (!freeNamesSafe(fn, sc, decls, mc, pm)) continue;
          batch.push({ m, fn, mc, stmt, form });
        }
        const batchNames = new Set(batch.map(b => b.m));
        for (const item of batch) {
          const owner = owningMethod(item.mc, pm, fnToName);
          if (owner && batchNames.has(owner)) continue; // call site lives inside another method being inlined this round: defer to a later round
          if (inlineMethod(ob, item, sc, decls, pm, !an.selfEscapes && !(an.dynReadKinds & K_STR))) { stats.inlined++; changed++; }
        }
        if (changed) break;

        // ── 4. drop fields nothing can read any more ──────────────────────────────────────────────────────
        if (!an.selfEscapes) {
          for (const [k, field] of [...ob.fields]) {
            if (an.written.has(k) || ob.ambiguous.has(k)) continue;
            if (an.dynRead && (an.dynReadKinds & (k.startsWith('n:') ? K_NUM : K_STR))) continue; // a dynamic read could still reach this key
            if (k.startsWith('s:') && ob.methods.has(k.slice(2)) && an.callSites.get(k.slice(2))?.length) continue;
            if (an.valueRead.has(k.startsWith('s:') ? k.slice(2) : '')) continue;
            const stillRead = an.reads.get(k)?.some(acc => pm.has(acc));
            const usedAsMethod = k.startsWith('s:') && an.callSites.get(k.slice(2))?.length;
            if (stillRead || usedAsMethod) continue;
            const idx = ob.tbl.fields.indexOf(field);
            if (idx >= 0) { ob.tbl.fields.splice(idx, 1); ob.fields.delete(k); stats.removedFields++; changed++; }
          }
        }
      }
    } catch (e: any) {
      stats.notes.push('outline aborted: ' + (e?.message ?? String(e)));
      break;
    }
    if (!changed) break;
  }
  if (opts.diagnostics) for (const t of stats.tables) opts.diagnostics.push(`outline: table@${t.line} ${t.methods} methods / ${t.slots} slots, ${t.entryCalls} entry call(s)`);
  return stats;
}

let uniqueCounter = 0;
function uniqueName(sc: ScopeInfo, base: string): string {
  let s: string;
  do { s = `_${base}${++uniqueCounter}`; } while (sc.allNames.has(s));
  sc.allNames.add(s);
  return s;
}

/** transitive method->method call reachability (for recursion / cycle detection) */
function methodReach(ob: Obj, an: Analysis): Map<string, Set<string>> {
  const direct = new Map<string, Set<string>>();
  for (const [name, fn] of ob.methods) {
    const s = new Set<string>();
    walkNoFnInto(fn.body, (n: any) => { if (n.type === 'MethodCallExpr' && an.isSelf(n.obj) && ob.methods.has(n.method)) s.add(n.method); });
    direct.set(name, s);
  }
  const reach = new Map<string, Set<string>>();
  for (const name of ob.methods.keys()) {
    const seen = new Set<string>(); const stack = [...(direct.get(name) ?? [])];
    while (stack.length) { const x = stack.pop()!; if (seen.has(x)) continue; seen.add(x); for (const y of direct.get(x) ?? []) stack.push(y); }
    reach.set(name, seen);
  }
  return reach;
}

/** walk descending INTO nested functions too (we want self:m calls anywhere in the method) */
function walkNoFnInto(node: any, fn: (n: any) => void) { walk(node, (n: any) => fn(n)); }

/** every free name of the method body resolves to a global or to something declared inside the method,
 *  and (when a call site is given) none of those globals is shadowed by a local/param in scope at the call site */
function freeNamesSafe(target: A.FunctionExpr, sc: ScopeInfo, decls: Map<any, Binding[]>, callSite?: any, pm?: Map<any, Parent>): boolean {
  const declared = new Set<Binding>();
  for (const b of decls.get(target) ?? []) declared.add(b); // params
  walk(target.body, (n: any) => {
    if (n.type === 'LocalStat' || n.type === 'LocalFunctionStat' || n.type === 'NumericForStat' || n.type === 'GenericForStat' || n.type === 'FunctionExpr') {
      for (const b of decls.get(n) ?? []) declared.add(b);
    }
  });
  const globalFree = new Set<string>();
  let ok = true;
  walk(target.body, (n: any) => {
    if (!ok || n.type !== 'NameExpr') return;
    const b = sc.refOf.get(n);
    if (!b) return;
    if (b.kind === 'global') { globalFree.add(n.name); return; }
    if (!declared.has(b)) ok = false;
  });
  if (!ok) return false;
  if (callSite && pm && globalFree.size) {
    const inScope = new Set<string>();
    let cur: any = callSite;
    while (cur) {
      if (cur.type === 'FunctionExpr' || cur.type === 'Chunk') for (const b of sc.fnBindings.get(cur) ?? []) inScope.add(b.name);
      const pi = pm.get(cur); cur = pi ? pi.p : null;
    }
    for (const g of globalFree) if (inScope.has(g)) return false;
  }
  return true;
}

function inlineMethod(ob: Obj, item: { m: string; fn: A.FunctionExpr; mc: A.MethodCallExpr; stmt: any; form: 'call' | 'assign' | 'local' | 'return' }, sc: ScopeInfo, decls: Map<any, Binding[]>, pm: Map<any, Parent>, canRemove: boolean): boolean {
  const { fn, mc, stmt, form } = item;
  const cont = stmtContainer(stmt, pm);
  if (!cont) return false;
  const at = cont.arr.indexOf(stmt);
  if (at < 0) return false;

  // avoid variable capture: rename any body local that collides with an assignment target name, otherwise
  // the generated `target = ...` tail would write the body local instead of the caller's variable
  if (form === 'assign' || form === 'local') {
    const targetNames = new Set<string>(form === 'local'
      ? (stmt as A.LocalStat).names
      : (stmt as A.AssignStat).targets.map((t: any) => unparen(t)).filter((t: any) => t.type === 'NameExpr').map((t: any) => t.name));
    if (targetNames.size) {
      const bodyBindings = new Set<Binding>();
      walk(fn.body, (n: any) => {
        if (n.type === 'LocalStat' || n.type === 'LocalFunctionStat' || n.type === 'NumericForStat' || n.type === 'GenericForStat' || n.type === 'FunctionExpr') {
          for (const b of decls.get(n) ?? []) bodyBindings.add(b);
        }
      });
      for (const b of bodyBindings) if (b.kind !== 'param' && targetNames.has(b.name)) renameBinding(b, uniqueName(sc, 'c'));
    }
  }

  // alpha-rename the method's params (incl. self) to fresh names, then clone the body
  const params = (decls.get(fn) ?? []).filter(b => b.kind === 'param').sort((a, b) => a.index - b.index);
  const freshNames: string[] = [];
  for (const b of params) { const nn = uniqueName(sc, 'p'); renameBinding(b, nn); freshNames.push(nn); }
  while (freshNames.length < fn.params.length) freshNames.push(uniqueName(sc, 'p'));
  const body = clone(fn.body) as A.Stat[];

  const recv = clone(mc.obj);
  const argInit: A.Expr[] = [recv, ...mc.args.map(a => clone(a))];
  const paramLocal: A.LocalStat = { type: 'LocalStat', names: freshNames.slice(), init: argInit };

  const out: A.Stat[] = [];
  if (form === 'call') {
    // discard the result but keep every side effect of a tail `return ...`
    rewriteTails(body,
      (r) => r.args.map((a): A.Stat => {
        const u = unparen(a);
        return (u.type === 'CallExpr' || u.type === 'MethodCallExpr')
          ? ({ type: 'CallStat', expr: clone(u) } as A.CallStat)
          : ({ type: 'LocalStat', names: [uniqueName(sc, 'r')], init: [clone(u)] } as A.LocalStat);
      }),
      () => []);
    out.push({ type: 'DoStat', body: [paramLocal, ...body] });
  } else if (form === 'return') {
    // `return self:m(args)` : keep every return as-is, append a bare `return` on fall-through
    rewriteTails(body, (r) => [r], () => [{ type: 'ReturnStat', args: [] } as A.ReturnStat]);
    out.push({ type: 'DoStat', body: [paramLocal, ...body] });
  } else {
    const targets: A.Expr[] = form === 'local'
      ? (stmt as A.LocalStat).names.map(nameExpr)
      : (stmt as A.AssignStat).targets;
    const nTargets = targets.length;
    rewriteTails(body,
      (r) => [{ type: 'AssignStat', targets: targets.map(t => clone(t)), values: r.args.length ? r.args.map(a => clone(a)) : [nilLit()] } as A.AssignStat],
      () => [{ type: 'AssignStat', targets: targets.map(t => clone(t)), values: Array.from({ length: nTargets }, () => nilLit()) } as A.AssignStat]);
    if (form === 'local') out.push({ type: 'LocalStat', names: (stmt as A.LocalStat).names.slice(), init: [] });
    out.push({ type: 'DoStat', body: [paramLocal, ...body] });
  }
  cont.arr.splice(at, 1, ...out);

  // stop treating it as an inlinable method; remove the field only when nothing could still read/call it dynamically
  ob.methods.delete(item.m);
  if (canRemove) {
    const key = 's:' + item.m;
    const field = ob.fields.get(key);
    if (field) { const idx = ob.tbl.fields.indexOf(field); if (idx >= 0) ob.tbl.fields.splice(idx, 1); ob.fields.delete(key); }
  }
  return true;
}
