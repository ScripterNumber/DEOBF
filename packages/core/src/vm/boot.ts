// VM boot dump + helper wrappers — universal, nothing obfuscator- or sample-specific.
//
// vmBootProgram: the decoded chunk of ANY Lua VM obfuscator without reversing its serialisation format.
// The loader is ported 1:1 to Python (transpile/python.ts: Lua-semantics prelude, no OS / network access) and
// runs on its own payload. The interpreter structure analysis (findVmShape) identifies the closure factory —
// the function that turns a decoded proto into a callable VM closure; a hook at the top of its Python body
// writes what the first call received (root proto, upvalues, environment) plus every table the factory reads
// from enclosing scopes (helper / library tables) as a PRISM dump (vm/dump.ts) and ends the program before
// any virtualised code runs. Every Lua function is tagged with its source offset, so the dump says where each
// function value comes from: {"$fn": name, "$at": offset}.
//
// helperWrapperRules: helper-table slots holding small pure wrappers around globals, e.g.
//   function(n, t, i) return unpack(t, i, n) end
// (found through those offsets) become rewrite rules  H[k](__a0, __a1, __a2) -> unpack(__a1, __a2, __a0).
import type * as A from '../ast.js';
import { walk } from '../ast.js';
import { parse } from '../parser.js';
import { analyzeScopes } from '../analysis/scope.js';
import type { Binding, ScopeInfo } from '../analysis/scope.js';
import { findVmShape, printExpr, LIB } from './specialize.js';
import type { VmShape } from './specialize.js';
import { LuaDump, numRaw } from './dump.js';
import { luaToPython } from '../transpile/python.js';
import type { RewriteRule } from '../passes/rewrite.js';
import { sideEffectFree } from '../passes/rewrite.js';

const unparen = (e: A.Expr): A.Expr => { while (e && e.type === 'ParenExpr') e = e.expr; return e; };
const within = (p: A.Pos | undefined, r: A.Pos | undefined): boolean => !!p && !!r && p.start >= r.start && p.start <= r.end;

export interface VmFactoryInfo {
  shape: VmShape;
  /** the closure factory: first line, Lua parameters, source offset, where it is stored */
  factory: { line: number; params: string[]; at: number; target: string | null };
  /** names to dump: the factory's parameters, then the tables it reads from enclosing scopes */
  keys: string[];
  /** upvalue tables of the factory: reads, calls through them, calls inside the interpreter loop */
  tables: Array<{ name: string; reads: number; calls: number; loopCalls: number }>;
  /** the interpreter's helper table: the upvalue table called through most inside the interpreter loop */
  helper?: { name: string; path: string };
}

/** Structural facts about the VM closure factory of a (cleaned) script. */
export function vmFactoryInfo(chunk: A.Chunk, extra: string[] = []): { info: VmFactoryInfo | null; notes: string[] } {
  const { shape, notes } = findVmShape(chunk);
  if (!shape) return { info: null, notes };
  const mk = shape.makeFn, ml = mk.loc;
  if (!ml) return { info: null, notes: [...notes, 'the closure factory has no source position'] };
  const sc = analyzeScopes(chunk);
  const lp = (shape.loop as { loc?: A.Pos }).loc;
  const tabs = new Map<string, { name: string; reads: number; calls: number; loopCalls: number }>();
  walk(mk, (n: any, parent: any) => {
    if (n.type !== 'IndexExpr' && n.type !== 'MemberExpr') return;
    const o = unparen(n.obj);
    if (o.type !== 'NameExpr') return;
    const b = sc.refOf.get(o);
    if (!b || b.kind === 'global' || within((b.decl as { loc?: A.Pos } | undefined)?.loc, ml)) return;
    let t = tabs.get(b.name);
    if (!t) { t = { name: b.name, reads: 0, calls: 0, loopCalls: 0 }; tabs.set(b.name, t); }
    t.reads++;
    if (parent && parent.type === 'CallExpr' && parent.callee === n) { t.calls++; if (within(n.loc, lp)) t.loopCalls++; }
  });
  const tables = [...tabs.values()].sort((a, b) => b.loopCalls - a.loopCalls || b.calls - a.calls || b.reads - a.reads);
  const h = tables.find(t => t.calls > 0);
  const keys: string[] = [];
  for (const k of [...mk.params, ...tables.map(t => t.name), ...extra]) if (!keys.includes(k)) keys.push(k);
  return {
    info: { shape, factory: { line: ml.line, params: mk.params.slice(), at: ml.start, target: shape.makeTarget }, keys, tables, helper: h ? { name: h.name, path: h.name } : undefined },
    notes,
  };
}

// Python run inside the closure factory (relative indentation; PRISM prelude names: G, LuaTable, LuaBuffer, _unkey)
const HOOK = `import sys as _psys, json as _pjson
_pseen = {}
_pnames = {}
for _pk, _pv in list(G.h.items()):
    _pkk = _unkey(_pk)
    if isinstance(_pv, LuaTable):
        for _pk2, _pv2 in list(_pv.h.items()):
            if callable(_pv2) and not isinstance(_pv2, LuaTable): _pnames.setdefault(id(_pv2), str(_pkk) + '.' + str(_unkey(_pk2)))
    elif callable(_pv): _pnames.setdefault(id(_pv), str(_pkk))
def _prism_key(k):
    if k is True: return 'true'
    if k is False: return 'false'
    if isinstance(k, float) and k.is_integer(): return str(int(k))
    if isinstance(k, LuaTable): return '<table>'
    return str(k)
def _prism_conv(x):
    if isinstance(x, LuaTable):
        if id(x) in _pseen: return {'$ref': _pseen[id(x)]}
        me = _pseen[id(x)] = len(_pseen) + 1
        n = x.length()
        out = {'$id': me}
        if n: out['$arr'] = [_prism_conv(x.h.get(i)) for i in range(1, n + 1)]
        rest = {}
        for k, v in list(x.h.items()):
            kk = _unkey(k)
            if isinstance(kk, (int, float)) and not isinstance(kk, bool) and 1 <= kk <= n and float(kk).is_integer(): continue
            rest[_prism_key(kk)] = _prism_conv(v)
        if rest: out['$map'] = rest
        if x.meta is not None: out['$meta'] = _prism_conv(x.meta)
        return out
    if isinstance(x, LuaBuffer): return {'$buffer': bytes(x.b).hex()}
    if isinstance(x, str): return x if all(32 <= ord(c) < 127 for c in x) else {'$bytes': x.encode('latin-1', 'replace').hex()}
    if isinstance(x, float) and (x != x or x in (float('inf'), float('-inf'))): return {'$num': 'nan' if x != x else ('inf' if x > 0 else '-inf')}
    if x is None or isinstance(x, (bool, int, float)): return x
    if callable(x):
        r = {'$fn': _pnames.get(id(x), getattr(x, '__name__', '?'))}
        at = getattr(x, '__lua_at__', None)
        if at is not None: r['$at'] = at
        return r
    return repr(x)
_pdump = {__ENTRIES__}
with open(__PATH__, 'w') as _pf:
    _pf.write(_pjson.dumps(_pdump))
_psys.stderr.write('PRISM boot stop: VM closure factory reached, dump written to ' + str(__PATH__) + '\\n')
_psys.stderr.flush()
import os as _pos
_pos._exit(0)`;

// main() in a big-stack thread; any exit other than the hook's is reported
const RUNNER = `if __name__ == '__main__':
    import sys as _psys, threading as _pthr
    _psys.setrecursionlimit(100000)
    try:
        _pthr.stack_size(0x10000000)
    except Exception:
        pass
    _perr = []
    def _prism_main():
        try:
            main()
        except BaseException as _e:
            _perr.append(_e)
    _pt = _pthr.Thread(target=_prism_main)
    _pt.start()
    _pt.join()
    if _perr:
        import traceback as _ptb
        _ptb.print_exception(type(_perr[0]), _perr[0], _perr[0].__traceback__)
        _psys.exit(2)
    _psys.stderr.write('PRISM boot: the program ended without reaching the VM closure factory\\n')
    _psys.exit(3)`;

export interface VmBootOptions {
  /** file the program writes the dump to (default: its first command-line argument, else vm_dump.json) */
  dumpPath?: string;
  /** extra Lua names (parameters / upvalues visible in the closure factory) to dump */
  extra?: string[];
}
export interface VmBootResult {
  ok: boolean;
  notes: string[];
  warnings: string[];
  /** the Python program ('' when no VM closure factory was found) */
  program: string;
  info?: VmFactoryInfo;
  /** the dump's top-level keys (Lua names) */
  keys: string[];
}

/** Python program that runs the loader of `src` up to its VM closure factory and dumps the decoded chunk. */
export function vmBootProgram(src: string, opts: VmBootOptions = {}): VmBootResult {
  const { chunk, errors } = parse(src);
  const { info, notes } = vmFactoryInfo(chunk, opts.extra);
  if (errors.length) notes.push(`source has ${errors.length} parse error(s); first: ${errors[0].message} @L${errors[0].line}`);
  if (!info) return { ok: false, notes, warnings: [], program: '', keys: [] };
  const path = opts.dumpPath !== undefined ? JSON.stringify(opts.dumpPath) : "(_psys.argv[1] if len(_psys.argv) > 1 else 'vm_dump.json')";
  const dumped = new Set<string>(), missing = new Set<string>();
  const hook = (name: (lua: string) => string | null): string => {
    const entries: string[] = [];
    for (const k of info.keys) {
      const p = name(k);
      if (p) { entries.push(`${JSON.stringify(k)}: _prism_conv(${p})`); dumped.add(k); } else missing.add(k);
    }
    return HOOK.split('__ENTRIES__').join(entries.join(', ')).split('__PATH__').join(path);
  };
  const py = luaToPython(src, { hooks: [{ at: info.factory.at, code: hook }], tagFunctions: true });
  const main = "if __name__ == '__main__':\n    main()";
  const program = py.code.includes(main) ? py.code.replace(main, () => RUNNER) : py.code + '\n\n' + RUNNER + '\n';
  const warnings = py.warnings.slice();
  if (missing.size) warnings.push(`not visible in the closure factory, not dumped: ${[...missing].join(', ')}`);
  if (!dumped.size) return { ok: false, notes: [...notes, 'the Python port did not emit the closure factory as a function (hook not placed)'], warnings, program: '', info, keys: [] };
  const t = info.tables.slice(0, 4).map(x => `${x.name} (${x.reads} reads, ${x.calls} calls, ${x.loopCalls} in the loop)`).join(', ');
  notes.push(`closure factory L${info.factory.line} function(${info.factory.params.join(', ')})${info.factory.target ? ' stored in ' + info.factory.target : ''}; tables it reads: ${t || 'none'}${info.helper ? `; helper table ${info.helper.name}` : ''}`);
  return { ok: true, notes, warnings, program, info, keys: [...dumped] };
}

const globalPath = (e: A.Expr, sc: ScopeInfo): boolean => {
  const u = unparen(e);
  if (u.type === 'NameExpr') { const b = sc.refOf.get(u); return !b || b.kind === 'global'; }
  if (u.type === 'MemberExpr') return globalPath(u.obj, sc);
  if (u.type === 'BinExpr' && u.op === 'or') return globalPath(u.left, sc) && globalPath(u.right, sc);
  return false;
};

/** the key of a helper slot `T[k]` / `T.k` read through `alias` (the table the summarised function is stored in) */
function slotKey(e: A.Expr, alias: Binding | null, sc: ScopeInfo): number | string | undefined {
  if (!alias) return undefined;
  const u = unparen(e);
  if (u.type === 'MemberExpr') { const o = unparen(u.obj); return o.type === 'NameExpr' && sc.refOf.get(o) === alias ? u.name : undefined; }
  if (u.type !== 'IndexExpr') return undefined;
  const o = unparen(u.obj);
  if (o.type !== 'NameExpr' || sc.refOf.get(o) !== alias) return undefined;
  const i = unparen(u.index);
  return i.type === 'NumberLit' || i.type === 'StringLit' ? i.value : undefined;
}

/** metavariables __a<i> in evaluation (left-to-right) order */
const metaOrder = (e: unknown): string[] => {
  const seq: string[] = [];
  const visit = (x: unknown): void => {
    if (Array.isArray(x)) { x.forEach(visit); return; }
    if (!x || typeof x !== 'object') return;
    const n = x as { type?: unknown; name?: unknown };
    if (n.type === 'NameExpr' && typeof n.name === 'string' && /^__a\d+$/.test(n.name)) { seq.push(n.name); return; }
    for (const [k, v] of Object.entries(x)) if (k !== 'loc') visit(v);
  };
  visit(e);
  return seq;
};

interface HelperSummary { to: string; pure: boolean; guard: string | null; }
const FAIL = Symbol('fail');
const pathExpr = (p: string): A.Expr => (parse('return ' + p).chunk.body[0] as A.ReturnStat).args[0];
const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x)) as T;

/** Semantic summary of a small helper function:
 *     function(p…)  [p = p or <d> …]  return E  end
 *  or the same with a guarded alternative implementation through another slot of its own table
 *     if C then return T[j](…) else return E end          (C and the arguments: no calls)
 *  — e.g. an unpack that switches to a chunked version for huge ranges. E may use the parameters, globals,
 *  never-reassigned locals bound to global paths and library slots of the same table (resolved through the dump).
 *  Returns E with the parameters as metavariables __a<i> and their defaults inlined (`__a2 or 1`); `pure` marks
 *  summaries that reorder, duplicate or drop arguments — their rules only match side-effect-free arguments. */
function summarize(f: A.FunctionExpr, sc: ScopeInfo, alias: Binding | null, libOf: (k: number | string) => A.Expr | null): HelperSummary | null {
  if (f.vararg) return null;
  const param = (e: A.Expr): number => {
    const u = unparen(e);
    if (u.type !== 'NameExpr') return -1;
    const b: Binding | undefined = sc.refOf.get(u);
    return b && b.decl === f && b.kind === 'param' ? b.index : -1;
  };
  const body = f.body.slice();
  const defaults: Array<[number, A.Expr]> = [];
  while (body.length && body[0].type === 'AssignStat') {
    const s = body[0] as A.AssignStat;
    if (s.op || s.targets.length !== 1 || s.values.length !== 1) break;
    const i = param(s.targets[0]);
    const v = unparen(s.values[0]);
    if (i < 0 || defaults.some(d => d[0] === i) || v.type !== 'BinExpr' || v.op !== 'or' || param(v.left) !== i || !sideEffectFree(v.right)) break;
    defaults.push([i, v.right]);
    body.shift();
  }
  const ret1 = (ss: A.Stat[] | undefined): A.Expr | null =>
    ss && ss.length === 1 && ss[0].type === 'ReturnStat' && (ss[0] as A.ReturnStat).args.length === 1 ? (ss[0] as A.ReturnStat).args[0] : null;
  let alts: Array<[A.Expr, A.Expr | null]> = [];
  let guard: A.Expr | null = null;
  const r0 = ret1(body);
  if (r0) alts = [[r0, null]];
  else if (body.length && body.length <= 2 && body[0].type === 'IfStat') {
    const s = body[0] as A.IfStat;
    const a = s.clauses.length === 1 ? ret1(s.clauses[0].body) : null;
    const b = body.length === 1 ? ret1(s.elseBody) : (s.elseBody && s.elseBody.length ? null : ret1(body.slice(1)));
    if (a && b && sideEffectFree(s.clauses[0].cond)) { guard = s.clauses[0].cond; alts = [[b, a], [a, b]]; }
  }
  const defs = new Map<number, unknown>();
  const conv = (e: unknown): unknown => {
    if (Array.isArray(e)) { const r = e.map(conv); return r.includes(FAIL) ? FAIL : r; }
    if (!e || typeof e !== 'object') return e;
    const n = e as A.Expr;
    if (n.type === 'FunctionExpr' || n.type === 'VarargLit') return FAIL;
    if (n.type === 'NameExpr') {
      const b: Binding | undefined = sc.refOf.get(n);
      if (!b || b.kind === 'global') return { type: 'NameExpr', name: n.name };
      if (b.decl === f && b.kind === 'param') {
        const m = { type: 'NameExpr', name: '__a' + b.index };
        const d = defs.get(b.index);
        return d ? { type: 'ParenExpr', expr: { type: 'BinExpr', op: 'or', left: m, right: clone(d) } } : m;
      }
      if (b.kind === 'local' && b.writes === 0 && b.init && !b.initMulti && globalPath(b.init, sc)) {
        const i = unparen(b.init);
        return conv(i.type === 'BinExpr' ? { type: 'ParenExpr', expr: i } : i);
      }
      return FAIL;
    }
    if (n.type === 'IndexExpr' || n.type === 'MemberExpr') {
      const k = slotKey(n, alias, sc);
      if (k !== undefined) return libOf(k) ?? FAIL;
    }
    const o: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(e)) {
      if (k === 'loc') continue;
      const c = conv(v);
      if (c === FAIL) return FAIL;
      o[k] = c;
    }
    if (o.type === 'CallExpr' && Array.isArray(o.args))
      o.args = o.args.map((a: { type?: string; expr?: { type?: string } }) => (a && a.type === 'ParenExpr' && a.expr && a.expr.type === 'BinExpr' ? a.expr : a));
    return o;
  };
  for (const [i, d] of defaults) { const c = conv(d); if (c === FAIL) return null; defs.set(i, c); }
  for (const [res, alt] of alts) {
    if (alt) {
      const u = unparen(alt);
      if (u.type !== 'CallExpr' || slotKey(u.callee, alias, sc) === undefined || !sideEffectFree(u.args)) continue;
    }
    const to = conv(res);
    if (to === FAIL || !to || typeof to !== 'object') continue;
    const order = metaOrder(to);
    const pure = order.length !== f.params.length || order.some((s, i) => s !== '__a' + i);
    return { to: printExpr(to as A.Expr), pure, guard: guard ? printExpr(guard) : null };
  }
  return null;
}

export interface WrapperRules { rules: RewriteRule[]; notes: string[]; }

/** Rewrite rules that inline the helper-table slots holding small helper functions (see summarize; needs a dump
 *  with $at source offsets, i.e. one made by vm_boot_dump). */
export function helperWrapperRules(src: string, dumpJson: unknown, helper: { name: string; path: string }): WrapperRules {
  const { chunk } = parse(src);
  const sc = analyzeScopes(chunk);
  const fns = new Map<number, A.FunctionExpr>();
  const storedIn = new Map<A.FunctionExpr, Binding>();   // `T[k] = function … end` → T (the helper table in that scope)
  walk(chunk, (n: any) => {
    if (n.type === 'FunctionExpr' && n.loc) fns.set(n.loc.start, n);
    if (n.type !== 'AssignStat' || n.op) return;
    n.values.forEach((v: any, i: number) => {
      const t = n.targets[i];
      if (!v || v.type !== 'FunctionExpr' || !t || (t.type !== 'IndexExpr' && t.type !== 'MemberExpr')) return;
      const o = unparen(t.obj);
      const b: Binding | undefined = o.type === 'NameExpr' ? sc.refOf.get(o) : undefined;
      if (b && b.kind !== 'global' && b.writes === 0) storedIn.set(v, b);
    });
  });
  const dump = new LuaDump(dumpJson);
  let h: unknown = dump.root;
  for (const p of helper.path.split(/[./]/).filter(Boolean)) h = dump.get(h, /^\d+$/.test(p) ? Number(p) : p);
  if (!dump.isTable(h)) return { rules: [], notes: [`helper table path '${helper.path}' not found in the dump`] };
  const libOf = (key: number | string): A.Expr | null => {
    const d = dump.deref(dump.get(h, key)) as { $fn?: unknown; $at?: unknown } | null;
    if (!d || typeof d !== 'object' || typeof d.$fn !== 'string' || d.$at !== undefined || !LIB.test(d.$fn)) return null;
    return pathExpr(d.$fn);
  };
  const keyTexts = (k: unknown): string[] =>
    typeof k === 'number' ? [`[${numRaw(k)}]`] : typeof k === 'string' ? (/^[A-Za-z_]\w*$/.test(k) ? ['.' + k, `[${JSON.stringify(k)}]`] : [`[${JSON.stringify(k)}]`]) : [];
  const rules: RewriteRule[] = [];
  const shown: string[] = [];
  let tagged = 0;
  for (const [k, v] of dump.entries(h)) {
    const d = dump.deref(v) as { $fn?: unknown; $at?: unknown } | null;
    if (!d || typeof d !== 'object' || typeof d.$fn !== 'string' || typeof d.$at !== 'number') continue;
    tagged++;
    const f = fns.get(d.$at);
    if (!f) continue;
    const s = summarize(f, sc, storedIn.get(f) ?? null, libOf);
    if (!s) continue;
    const args = f.params.map((_, i) => '__a' + i).join(', ');
    const kts = keyTexts(k);
    for (const kt of kts) rules.push(s.pure ? { from: `${helper.name}${kt}(${args})`, to: s.to, pure: true } : { from: `${helper.name}${kt}(${args})`, to: s.to });
    if (kts.length) shown.push(`${helper.name}${kts[0]}(${args}) → ${s.to}${s.guard ? ` [its alternative implementation for ${s.guard} taken as equivalent]` : ''}`);
  }
  const notes: string[] = [];
  if (shown.length) notes.push(`helper table ${helper.name}: ${shown.length} helper function slot(s) summarised and inlined — ${shown.slice(0, 6).join('; ')}${shown.length > 6 ? '; …' : ''}${rules.some(r => r.pure) ? ' (rules that reorder / duplicate arguments only fire on side-effect-free arguments)' : ''}`);
  else if (!tagged) notes.push(`helper table ${helper.name}: the dump has no function source offsets ($at) — make it with vm_boot_dump to inline helper function slots`);
  else notes.push(`helper table ${helper.name}: none of its ${tagged} Lua function slot(s) is a small wrapper — they stay calls`);
  return { rules, notes };
}
