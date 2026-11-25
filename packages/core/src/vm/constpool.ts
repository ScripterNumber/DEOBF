// Constant pools handed between VM protos — universal for residual programs made of `PROTOS[n]` makers.
//
//   proto 1:   T = {}; T[2] = string; T[4] = "format"; …; T[0] = PROTOS[10](u); return T[0](T)
//   proto 10:  R1 = args[1]; R4 = R1[2][R1[4]]          ->   R4 = string["format"]
//
// A table built by straight-line stores at literal keys (literals, globals, global paths) that is never
// written after its construction and reaches a closure as a call argument (and from there child closures as
// an upvalue value) has its reads at literal keys replaced by the stored values. Flow-sensitive: a local
// counts as holding the table only where every reaching definition gives it the table (forward must
// analysis over the statement graph). Assumptions, reported in the notes: calls that receive the table do
// not modify it, and the globals read at construction still hold the same values where they are used.
import type * as A from '../ast.js';
import { analyzeScopes, Binding, ScopeInfo } from '../analysis/scope.js';
import { buildStmtCfg, visitExpr } from '../analysis/stmtcfg.js';
import { printExpr } from './specialize.js';

export interface ProtoChunk { id: string; chunk: A.Chunk; }
export interface ConstPoolOptions {
  /** the varargs-packing helper of the interpreter prologue: `local n, args = PACK(...)`, args[i] = i-th argument */
  isPack: (callee: A.Expr) => boolean;
  /** fewest literal-key stores for a table to count as a constant pool (default 16) */
  minFields?: number;
}
export interface ConstPoolResult { replaced: number; notes: string[]; changed: Set<string>; }

const unparen = (e: A.Expr): A.Expr => { while (e && e.type === 'ParenExpr') e = e.expr; return e; };
type Key = string;   // 'n:1' | 's:x'
const litKeyOf = (e: A.Expr | undefined): Key | null => {
  if (!e) return null; const u = unparen(e);
  if (u.type === 'NumberLit') return 'n:' + u.value;
  if (u.type === 'StringLit') return 's:' + u.value;
  if (u.type === 'UnExpr' && u.op === '-' && unparen(u.expr).type === 'NumberLit') return 'n:' + -(unparen(u.expr) as A.NumberLit).value;
  return null;
};
type FieldVal = { kind: 'lit'; expr: A.Expr } | { kind: 'global'; expr: A.Expr; root: string } | { kind: 'closure'; proto: string } | { kind: 'unknown' };
interface Site { parent: string; child: string; stmt: A.AssignStat; u: Binding; stores: Array<{ i: number; stmt: A.AssignStat; value: A.Expr }>; tUp: Set<number>; }
interface Proto { id: string; chunk: A.Chunk; scope: ScopeInfo; maker: A.FunctionExpr; inner: A.FunctionExpr; k: Binding | null; localNames: Set<string>; }

const protosCallee = (c: A.Expr): string | null => {
  const u = unparen(c);
  if (u.type === 'IndexExpr' && unparen(u.obj).type === 'NameExpr' && (unparen(u.obj) as A.NameExpr).name === 'PROTOS') { const k = litKeyOf(u.index); return k ? k.slice(2) : null; }
  return null;
};
const clone = <T>(x: T): T => structuredClone(x);

/** the residual maker `PROTOS[n] = function(k, …) f = function(...) … end; return f end` */
function protoOf(pc: ProtoChunk): Proto | null {
  const st = pc.chunk.body.find(s => s.type === 'AssignStat' && s.targets.length === 1 && protosCallee(s.targets[0]) !== null) as A.AssignStat | undefined;
  if (!st || st.values.length !== 1 || unparen(st.values[0]).type !== 'FunctionExpr') return null;
  const maker = unparen(st.values[0]) as A.FunctionExpr;
  let inner: A.FunctionExpr | null = null;
  for (const s of maker.body) {
    if (s.type === 'AssignStat' && s.values.length === 1 && unparen(s.values[0]).type === 'FunctionExpr') { inner = unparen(s.values[0]) as A.FunctionExpr; break; }
    if (s.type === 'LocalStat' && s.init.length === 1 && unparen(s.init[0]).type === 'FunctionExpr') { inner = unparen(s.init[0]) as A.FunctionExpr; break; }
  }
  if (!inner) return null;
  const scope = analyzeScopes(pc.chunk);
  const k = maker.params.length ? scope.bindings.find(b => b.kind === 'param' && b.decl === maker && b.index === 0) ?? null : null;
  const localNames = new Set(scope.bindings.filter(b => b.kind !== 'global').map(b => b.name));
  return { id: pc.id, chunk: pc.chunk, scope, maker, inner, k, localNames };
}

/** every statement list of a function body (nested functions excluded) */
function forLists(body: A.Stat[], f: (list: A.Stat[]) => void) {
  f(body);
  for (const s of body) {
    switch (s.type) {
      case 'DoStat': case 'WhileStat': case 'RepeatStat': case 'NumericForStat': case 'GenericForStat': forLists(s.body, f); break;
      case 'IfStat': for (const c of s.clauses) forLists(c.body, f); if (s.elseBody) forLists(s.elseBody, f); break;
    }
  }
}
const refsBinding = (node: any, scope: ScopeInfo, bs: Set<Binding>): boolean => { let hit = false; visitExpr(node, (m) => { if (hit) return false; if (m.type === 'NameExpr') { const b = scope.refOf.get(m); if (b && bs.has(b)) hit = true; } }); return hit; };

export function substituteConstPools(chunks: ProtoChunk[], o: ConstPoolOptions): ConstPoolResult {
  const res: ConstPoolResult = { replaced: 0, notes: [], changed: new Set() };
  const minFields = o.minFields ?? 16;
  const protos = new Map<string, Proto>();
  for (const pc of chunks) { const p = protoOf(pc); if (p) protos.set(p.id, p); }
  // closure creation sites and their upvalue stores
  const sitesOf = new Map<string, Site[]>();
  const siteByStmt = new Map<A.AssignStat, Site>();
  for (const p of protos.values()) {
    forLists(p.inner.body, (list) => {
      list.forEach((s, i) => {
        if (s.type !== 'AssignStat' || s.values.length !== 1 || s.targets.length !== 1) return;
        const v = unparen(s.values[0]);
        if (v.type !== 'CallExpr' || v.args.length !== 1) return;
        const child = protosCallee(v.callee); const a = unparen(v.args[0]);
        if (child === null || a.type !== 'NameExpr') return;
        const u = p.scope.refOf.get(a); if (!u || u.kind === 'global') return;
        const site: Site = { parent: p.id, child, stmt: s, u, stores: [], tUp: new Set() };
        // `u[i] = e` until u is assigned again
        const scan = (stmts: A.Stat[]): boolean => {
          for (const t of stmts) {
            if (t.type === 'AssignStat' && t.targets.some(x => unparen(x).type === 'NameExpr' && p.scope.refOf.get(unparen(x) as A.NameExpr) === u)) return false;
            if (t.type === 'AssignStat' && t.targets.length === 1 && t.values.length === 1 && !t.op) {
              const tg = unparen(t.targets[0]);
              if (tg.type === 'IndexExpr' && unparen(tg.obj).type === 'NameExpr' && p.scope.refOf.get(unparen(tg.obj) as A.NameExpr) === u) { const k = litKeyOf(tg.index); if (k && k.startsWith('n:')) site.stores.push({ i: Number(k.slice(2)), stmt: t, value: t.values[0] }); }
            }
            if (t.type === 'IfStat') { for (const c of t.clauses) if (!scan(c.body)) return false; if (t.elseBody && !scan(t.elseBody)) return false; }
            if (t.type === 'DoStat' && !scan(t.body)) return false;
          }
          return true;
        };
        scan(list.slice(i + 1));
        if (!sitesOf.has(child)) sitesOf.set(child, []);
        sitesOf.get(child)!.push(site); siteByStmt.set(s, site);
      });
    });
  }
  // constant pools: construction by literal-key stores, then the call that hands the table to a closure
  for (const p of protos.values()) {
    const sc = p.scope;
    forLists(p.inner.body, (list) => {
      for (let i = 0; i < list.length; i++) {
        const s = list[i];
        let bx: Binding | undefined;
        if (s.type === 'AssignStat' && !s.op && s.targets.length === 1 && s.values.length === 1 && unparen(s.targets[0]).type === 'NameExpr' && unparen(s.values[0]).type === 'TableExpr' && (unparen(s.values[0]) as A.TableExpr).fields.length === 0) bx = sc.refOf.get(unparen(s.targets[0]) as A.NameExpr);
        else if (s.type === 'LocalStat' && s.names.length === 1 && s.init.length === 1 && unparen(s.init[0]).type === 'TableExpr' && (unparen(s.init[0]) as A.TableExpr).fields.length === 0) bx = sc.bindings.find(b => b.decl === s && b.index === 0);
        if (!bx || bx.kind === 'global' || bx.captured) continue;
        const fields = new Map<Key, FieldVal>();
        const closureOf = new Map<Binding, string>();
        const self = new Set([bx]);
        let j = i + 1;
        for (; j < list.length; j++) {
          const t = list[j];
          if (t.type === 'AssignStat' && !t.op && t.targets.length === 1 && t.values.length === 1) {
            const tg = unparen(t.targets[0]);
            if (tg.type === 'IndexExpr' && unparen(tg.obj).type === 'NameExpr' && sc.refOf.get(unparen(tg.obj) as A.NameExpr) === bx && !refsBinding(tg.index, sc, self) && !refsBinding(t.values[0], sc, self)) {
              const k = litKeyOf(tg.index); if (k === null) break;
              fields.set(k, classify(t.values[0], p, closureOf)); continue;
            }
          }
          if (refsBinding(t, sc, self)) break;
          trackClosures(t, p, closureOf);
        }
        if (fields.size < minFields) continue;
        // after the construction: aliases of the table and the closures it is handed to
        const aliases = new Set([bx]);
        const calls: Array<{ proto: string; params: Set<number> }> = [];
        let escaped = 0;
        const post = (stmts: A.Stat[]): boolean => {
          for (const t of stmts) {
            if (t.type === 'DoStat') { if (!post(t.body)) return false; continue; }
            const touches = refsBinding(t, sc, aliases) || [...closureOf.keys()].some(b => refsBinding(t, sc, new Set([b])));
            if (!touches) { trackClosures(t, p, closureOf); continue; }
            // the hand-over call
            let call: A.CallExpr | null = null;
            if (t.type === 'CallStat' && t.expr.type === 'CallExpr') call = t.expr;
            else if (t.type === 'ReturnStat' && t.args.length === 1 && unparen(t.args[0]).type === 'CallExpr') call = unparen(t.args[0]) as A.CallExpr;
            else if ((t.type === 'AssignStat' || t.type === 'LocalStat') && (t.type === 'AssignStat' ? t.values : t.init).length === 1 && unparen((t.type === 'AssignStat' ? t.values : t.init)[0]).type === 'CallExpr') call = unparen((t.type === 'AssignStat' ? t.values : t.init)[0]) as A.CallExpr;
            if (call) {
              const cal = unparen(call.callee);
              const cb = cal.type === 'NameExpr' ? sc.refOf.get(cal) : undefined;
              const proto = cb ? closureOf.get(cb) : undefined;
              const params = new Set<number>();
              call.args.forEach((a, q) => { const ua = unparen(a); if (ua.type === 'NameExpr' && aliases.has(sc.refOf.get(ua)!)) params.add(q + 1); else if (refsBinding(a, sc, aliases)) escaped++; });
              if (proto !== undefined && params.size) calls.push({ proto, params });
              else if (params.size) escaped++;
              if (t.type === 'ReturnStat') return false;
              if (t.type === 'AssignStat') for (const x of t.targets) { const ux = unparen(x); if (ux.type === 'NameExpr') { const b = sc.refOf.get(ux); if (b) { aliases.delete(b); closureOf.delete(b); } } }
              continue;
            }
            // copies: `a = T`, `f = T[k]` (a field holding a closure)
            if (t.type === 'AssignStat' && !t.op && t.targets.every(x => unparen(x).type === 'NameExpr') && t.values.length === t.targets.length) {
              const vals = t.values.map(v => { const u = unparen(v); if (u.type === 'NameExpr' && aliases.has(sc.refOf.get(u)!)) return 'T' as const; if (u.type === 'IndexExpr' && unparen(u.obj).type === 'NameExpr' && aliases.has(sc.refOf.get(unparen(u.obj) as A.NameExpr)!)) { const k = litKeyOf(u.index); const f = k ? fields.get(k) : undefined; return f && f.kind === 'closure' ? f : null; } return refsBinding(v, sc, aliases) ? undefined : null; });
              if (vals.includes(undefined)) return false;
              t.targets.forEach((x, q) => { const b = sc.refOf.get(unparen(x) as A.NameExpr); if (!b) return; aliases.delete(b); closureOf.delete(b); const v = vals[q]; if (v === 'T') aliases.add(b); else if (v && v.kind === 'closure') closureOf.set(b, v.proto); });
              continue;
            }
            return false;
          }
          return true;
        };
        post(list.slice(j));
        if (!calls.length) continue;
        for (const c of calls) {
          const r = propagate(fields, c.proto, c.params, p.id, escaped);
          if (r) res.notes.push(r);
        }
      }
    });
  }
  return res;

  function classify(e: A.Expr, p: Proto, closureOf: Map<Binding, string>): FieldVal {
    const u = unparen(e);
    switch (u.type) {
      case 'NilLit': case 'TrueLit': case 'FalseLit': case 'NumberLit': case 'StringLit': return { kind: 'lit', expr: clone(u) };
      case 'UnExpr': if (u.op === '-' && unparen(u.expr).type === 'NumberLit') return { kind: 'lit', expr: clone(u) }; return { kind: 'unknown' };
      case 'NameExpr': {
        const b = p.scope.refOf.get(u);
        if (b && b.kind === 'global') return { kind: 'global', expr: clone(u), root: u.name };
        const c = b ? closureOf.get(b) : undefined;
        return c !== undefined ? { kind: 'closure', proto: c } : { kind: 'unknown' };
      }
      case 'IndexExpr': case 'MemberExpr': {
        // global paths (bit32["band"]) and the environment table (`env = getfenv()`; env["type"] is the global `type`)
        let x: A.Expr = u; const keys: string[] = [];
        while (true) {
          const ux = unparen(x);
          if (ux.type === 'MemberExpr') { keys.unshift(ux.name); x = ux.obj; continue; }
          if (ux.type === 'IndexExpr' && unparen(ux.index).type === 'StringLit') { keys.unshift((unparen(ux.index) as A.StringLit).value); x = ux.obj; continue; }
          break;
        }
        const root = unparen(x);
        if (root.type !== 'NameExpr' || !keys.length) return { kind: 'unknown' };
        const b = p.scope.refOf.get(root);
        if (b && b.kind === 'global') return { kind: 'global', expr: clone(u), root: root.name };
        if (b && b.kind === 'local' && !b.writeRefs.length && b.init && isGetfenv(b.init) && /^[A-Za-z_]\w*$/.test(keys[0])) {
          let ex: A.Expr = { type: 'NameExpr', name: keys[0] };
          for (const k of keys.slice(1)) ex = { type: 'IndexExpr', obj: ex, index: { type: 'StringLit', value: k, raw: JSON.stringify(k) } as A.StringLit };
          return { kind: 'global', expr: ex, root: keys[0] };
        }
        return { kind: 'unknown' };
      }
      default: return { kind: 'unknown' };
    }
  }
  function isGetfenv(e: A.Expr): boolean { const u = unparen(e); return u.type === 'CallExpr' && u.args.length === 0 && unparen(u.callee).type === 'NameExpr' && (unparen(u.callee) as A.NameExpr).name === 'getfenv'; }
  function trackClosures(t: A.Stat, p: Proto, closureOf: Map<Binding, string>) {
    if (t.type !== 'AssignStat' && t.type !== 'LocalStat') return;
    const site = t.type === 'AssignStat' ? siteByStmt.get(t) : undefined;
    const targets = t.type === 'AssignStat' ? t.targets.map(x => unparen(x)).filter(x => x.type === 'NameExpr').map(x => p.scope.refOf.get(x as A.NameExpr)) : p.scope.bindings.filter(b => b.decl === t);
    for (const b of targets) if (b) closureOf.delete(b);
    if (site) { const b = p.scope.refOf.get(unparen(site.stmt.targets[0]) as A.NameExpr); if (b && b.kind !== 'global') closureOf.set(b, site.child); }
  }

  /** hand the pool to proto `root` (arguments `params`), then to the children receiving it as an upvalue */
  function propagate(fields: Map<Key, FieldVal>, root: string, params: Set<number>, owner: string, escapedAtOwner: number): string | null {
    if ((sitesOf.get(root) ?? []).length !== 1) return `constant table of proto ${owner}: closure of proto ${root} created at ${(sitesOf.get(root) ?? []).length} sites — not followed`;
    const closureKeys = new Set([...fields].filter(([, v]) => v.kind === 'closure').map(([k]) => k));
    interface Spec { params: Set<number>; ups: Set<number>; }
    const specs = new Map<string, Spec>([[root, { params, ups: new Set() }]]);
    const done = new Set<string>();
    const repl: Array<{ proto: string; parent: any; key: string; index: number; value: A.Expr }> = [];
    let escapes = escapedAtOwner, aborted: string | null = null, dynReads = 0;
    const queue = [root];
    while (queue.length && !aborted) {
      const id = queue.shift()!;
      const p = protos.get(id); const spec = specs.get(id)!;
      if (!p) continue;
      const r = analyzeProto(p, spec, fields, closureKeys);
      done.add(id);
      if (typeof r === 'string') { aborted = `proto ${id}: ${r}`; break; }
      repl.push(...r.repl.map(x => ({ proto: id, ...x })));
      escapes += r.escapes; dynReads += r.dynReads;
      // children whose every creation site is decided
      const kids = new Set<string>();
      for (const [child, ss] of sitesOf) if (ss.some(s => s.parent === id)) kids.add(child);
      for (const child of kids) {
        if (done.has(child) || specs.has(child)) continue;
        const ss = sitesOf.get(child)!;
        if (!ss.every(s => done.has(s.parent))) continue;
        const ups = new Set<number>([...ss[0].tUp].filter(i => ss.every(s => s.tUp.has(i))));
        if (!ups.size) continue;
        specs.set(child, { params: new Set(), ups }); queue.push(child);
      }
    }
    if (aborted) return `constant table of proto ${owner} (${fields.size} fields): not substituted (${aborted})`;
    let n = 0;
    for (const x of repl) { if (x.index >= 0) x.parent[x.key][x.index] = clone(x.value); else x.parent[x.key] = clone(x.value); n++; res.changed.add(x.proto); }
    res.replaced += n;
    const lits = [...fields.values()].filter(v => v.kind === 'lit').length, globs = [...fields.values()].filter(v => v.kind === 'global').length;
    return `constant table built in proto ${owner} (${fields.size} literal-key fields: ${lits} literals, ${globs} globals) handed to proto ${root} (argument ${[...params].join(',')})${specs.size > 1 ? ` and as an upvalue to ${specs.size - 1} closure(s)` : ''}: ${n} read(s) replaced by the stored values` +
      `; it is never written after construction${escapes ? `; it is passed on ${escapes} time(s) to code assumed not to modify it` : ''}${dynReads ? `; ${dynReads} read(s) at computed keys kept` : ''}; globals are assumed unchanged since construction`;
  }

  function analyzeProto(p: Proto, spec: { params: Set<number>; ups: Set<number> }, fields: Map<Key, FieldVal>, closureKeys: Set<Key>):
    string | { repl: Array<{ parent: any; key: string; index: number; value: A.Expr }>; escapes: number; dynReads: number } {
    const sc = p.scope; const fn = p.inner;
    // the argument table of the prologue `local n, args = PACK(...)`
    let args: Binding | null = null;
    if (spec.params.size) {
      for (const s of fn.body) {
        if (s.type !== 'LocalStat' || s.names.length !== 2 || s.init.length !== 1) continue;
        const c = unparen(s.init[0]);
        if (c.type === 'CallExpr' && c.args.length === 1 && unparen(c.args[0]).type === 'VarargLit' && o.isPack(c.callee)) { args = sc.bindings.find(b => b.decl === s && b.index === 1) ?? null; break; }
      }
      if (args && (args.writeRefs.length || args.capturedWrite)) args = null;
    }
    let k = spec.ups.size ? p.k : null;
    if (k && (k.writeRefs.length || k.capturedWrite)) k = null;
    if (k) {
      // stores into the upvalue array at a pool index (or a computed one) would replace the table
      for (const r of k.refs) {
        const pr = parentOf(fn, r);
        if (pr && pr.node.type === 'IndexExpr' && pr.key === 'obj' && isStoreTarget(fn, pr.node)) { const kk = litKeyOf(pr.node.index); if (!kk || spec.ups.has(Number(kk.slice(2)))) { k = null; break; } }
      }
    }
    if (!args && !k) return { repl: [], escapes: 0, dynReads: 0 };
    const srcDirect = (e: A.Expr): boolean => {
      const u = unparen(e);
      if (u.type !== 'IndexExpr' || unparen(u.obj).type !== 'NameExpr') return false;
      const b = sc.refOf.get(unparen(u.obj) as A.NameExpr); const kk = litKeyOf(u.index);
      if (!kk || !kk.startsWith('n:')) return false;
      const i = Number(kk.slice(2));
      return (!!args && b === args && spec.params.has(i)) || (!!k && b === k && spec.ups.has(i));
    };
    // tracked locals: assigned (somewhere) from a pool source
    const tracked = new Map<Binding, number>();
    let grow = true;
    const isCand = (e: A.Expr | undefined): boolean => { if (!e) return false; if (srcDirect(e)) return true; const u = unparen(e); return u.type === 'NameExpr' && tracked.has(sc.refOf.get(u)!); };
    while (grow) {
      grow = false;
      visitExpr(fn.body, (m) => {
        if (m.type === 'AssignStat' && !m.op) m.targets.forEach((t: A.Expr, q: number) => { const ut = unparen(t); if (ut.type !== 'NameExpr' || q >= m.values.length) return; const b = sc.refOf.get(ut); if (b && b.kind === 'local' && b.fn === fn && !b.capturedWrite && !tracked.has(b) && isCand(m.values[q])) { tracked.set(b, tracked.size); grow = true; } });
        if (m.type === 'LocalStat') m.names.forEach((_: string, q: number) => { if (q >= m.init.length) return; const b = sc.bindings.find(x => x.decl === m && x.index === q); if (b && !b.capturedWrite && !tracked.has(b) && isCand(m.init[q])) { tracked.set(b, tracked.size); grow = true; } });
      });
    }
    const cfg = buildStmtCfg(fn.body);
    if (!cfg) return 'goto in the function';
    const N = cfg.nodes.length, W = Math.max(1, Math.ceil(tracked.size / 32));
    const TOP = () => { const a = new Uint32Array(W); a.fill(0xffffffff); return a; };
    const inS: Array<Uint32Array | null> = new Array(N).fill(null);
    const has = (st: Uint32Array, b: Binding) => { const i = tracked.get(b); return i !== undefined && (st[i >>> 5] & (1 << (i & 31))) !== 0; };
    const holds = (e: A.Expr, st: Uint32Array): boolean => { if (srcDirect(e)) return true; const u = unparen(e); if (u.type !== 'NameExpr') return false; const b = sc.refOf.get(u); return !!b && has(st, b); };
    const put = (st: Uint32Array, b: Binding | undefined, on: boolean) => { const i = b ? tracked.get(b) : undefined; if (i === undefined) return; st[i >>> 5] &= ~(1 << (i & 31)); if (on) st[i >>> 5] |= 1 << (i & 31); };
    const transfer = (n: number, st: Uint32Array): Uint32Array => {
      const nd = cfg.nodes[n]; const s = nd.stmt;
      if (!s || (nd.kind !== 'stmt' && nd.kind !== 'forvars')) return st;
      const out = st.slice();
      if (nd.kind === 'forvars') { for (const b of sc.bindings) if (b.decl === s) put(out, b, false); return out; }
      if (s.type === 'AssignStat') s.targets.forEach((t, q) => { const ut = unparen(t); if (ut.type === 'NameExpr') put(out, sc.refOf.get(ut), !s.op && q < s.values.length && !(q === s.values.length - 1 && s.targets.length > s.values.length) && holds(s.values[q], st)); });
      else if (s.type === 'LocalStat') { for (const b of sc.bindings) if (b.decl === s) put(out, b, b.index < s.init.length && !(b.index === s.init.length - 1 && s.names.length > s.init.length) && holds(s.init[b.index], st)); }
      else if (s.type === 'LocalFunctionStat' || s.type === 'FunctionStat') { for (const b of tracked.keys()) if (b.decl === s || (s.type === 'FunctionStat' && unparen(s.target as A.Expr).type === 'NameExpr' && sc.refOf.get(unparen(s.target as A.Expr) as A.NameExpr) === b)) put(out, b, false); }
      return out;
    };
    // forward must analysis (meet = and)
    const pred: number[][] = Array.from({ length: N }, () => []);
    cfg.nodes.forEach((nd, i) => nd.succ.forEach(s => pred[s].push(i)));
    inS[cfg.entry] = new Uint32Array(W);
    const outS: Array<Uint32Array | null> = new Array(N).fill(null);
    const work = [cfg.entry]; const inW = new Uint8Array(N); inW[cfg.entry] = 1;
    let guard = 0;
    while (work.length) {
      if (++guard > 4_000_000) return 'analysis too large';
      const i = work.pop()!; inW[i] = 0;
      let st: Uint32Array;
      if (i === cfg.entry) st = new Uint32Array(W);
      else { st = TOP(); let any = false; for (const q of pred[i]) { const o2 = outS[q]; if (!o2) continue; any = true; for (let w = 0; w < W; w++) st[w] &= o2[w]; } if (!any) continue; }
      inS[i] = st;
      const out = transfer(i, st);
      const prev = outS[i];
      let ch = !prev; if (prev) for (let w = 0; w < W; w++) if (prev[w] !== out[w]) { ch = true; break; }
      if (!ch) continue;
      outS[i] = out;
      for (const s of cfg.nodes[i].succ) if (!inW[s]) { inW[s] = 1; work.push(s); }
    }
    // reads, stores, escapes
    const repl: Array<{ parent: any; key: string; index: number; value: A.Expr }> = [];
    let escapes = 0, dynReads = 0; let bad: string | null = null;
    const siteStores = new Map<A.AssignStat, { site: Site; i: number }>();
    for (const ss of sitesOf.values()) for (const s of ss) if (s.parent === p.id) for (const x of s.stores) siteStores.set(x.stmt, { site: s, i: x.i });
    for (let i = 0; i < N && !bad; i++) {
      const st = inS[i]; if (!st) continue;
      const nd = cfg.nodes[i]; const s = nd.stmt;
      // stores into the pool
      if (nd.kind === 'stmt' && s && s.type === 'AssignStat') for (const t of s.targets) { const ut = unparen(t); if ((ut.type === 'IndexExpr' || ut.type === 'MemberExpr') && holds(ut.obj, st)) { bad = 'the table is written: ' + printExpr(ut); break; } }
      if (bad) break;
      visitStmtExprs(nd, (m, parent, key, index) => {
        if (bad) return false;
        if (m.type !== 'NameExpr' && m.type !== 'IndexExpr') return;
        if (!holds(m, st)) return;
        // m holds the pool: classify its use
        if (parent && parent.type === 'IndexExpr' && key === 'obj') {
          const kk = litKeyOf(parent.index);
          if (!kk) { dynReads++; return false; }
          if (closureKeys.has(kk)) { bad = 'a closure stored in the table is read back'; return false; }
          const f = fields.get(kk);
          if (f && (f.kind === 'lit' || (f.kind === 'global' && !p.localNames.has(f.root)))) {
            const lp = parentOf(fn, parent);
            if (lp && !isStoreTarget(fn, parent)) repl.push({ parent: lp.parent, key: lp.key, index: lp.index, value: f.expr });
          }
          return false;
        }
        if (parent && parent.type === 'MemberExpr' && key === 'obj') { const f = fields.get('s:' + parent.name); if (f && (f.kind === 'lit' || (f.kind === 'global' && !p.localNames.has(f.root)))) { const lp = parentOf(fn, parent); if (lp && !isStoreTarget(fn, parent)) repl.push({ parent: lp.parent, key: lp.key, index: lp.index, value: f.expr }); } return false; }
        // copies into tracked locals: followed by the analysis
        if (s && s.type === 'AssignStat' && key === 'values' && parent === s) { const t = unparen(s.targets[index]); if (t && t.type === 'NameExpr' && tracked.has(sc.refOf.get(t)!)) return false; const ss = siteStores.get(s); if (ss) { ss.site.tUp.add(ss.i); return false; } }
        if (s && s.type === 'LocalStat' && key === 'init' && parent === s) { const b = sc.bindings.find(x => x.decl === s && x.index === index); if (b && tracked.has(b)) return false; }
        if (parent && (parent.type === 'BinExpr' && (parent.op === '==' || parent.op === '~=')) ) return false;
        escapes++;
        return false;
      });
    }
    if (bad) return bad;
    return { repl, escapes, dynReads };
  }
}

/** the expressions evaluated at a statement-graph node, visited with their real parent links (statement fields) */
function visitStmtExprs(nd: { kind: string; stmt?: A.Stat; exprs: any[] }, f: (node: any, parent: any, key: string, index: number) => boolean | void) {
  const s = nd.stmt as any;
  const at = (parent: any, key: string) => { const x = parent[key]; if (Array.isArray(x)) x.forEach((y: any, i: number) => visitExpr({ type: '__wrap', y }, (m, pa, k, ix) => m.type === '__wrap' ? undefined : f(m, pa.type === '__wrap' ? parent : pa, pa.type === '__wrap' ? key : k, pa.type === '__wrap' ? i : ix))); else if (x) visitExpr({ type: '__wrap', y: x }, (m, pa, k, ix) => m.type === '__wrap' ? undefined : f(m, pa.type === '__wrap' ? parent : pa, pa.type === '__wrap' ? key : k, pa.type === '__wrap' ? -1 : ix)); };
  if (nd.kind === 'stmt' && s) {
    switch (s.type) {
      case 'AssignStat':
        at(s, 'values');
        for (const t of s.targets) { if (t.type === 'IndexExpr') { at(t, 'obj'); at(t, 'index'); } else if (t.type === 'MemberExpr') at(t, 'obj'); }
        if (s.op) at(s, 'targets');
        return;
      case 'LocalStat': at(s, 'init'); return;
      case 'ReturnStat': at(s, 'args'); return;
      case 'CallStat': at(s, 'expr'); return;
    }
  }
  visitExpr(nd.exprs, f);
}
/** parent link of a node inside a function body (nested functions excluded) */
const parentCache = new WeakMap<object, Map<any, { parent: any; key: string; index: number }>>();
function parentMap(fn: A.FunctionExpr) {
  let m = parentCache.get(fn);
  if (!m) {
    const mm = new Map<any, { parent: any; key: string; index: number }>();
    const v = (node: any) => { for (const k of Object.keys(node)) { if (k === 'loc') continue; const x = node[k]; if (Array.isArray(x)) x.forEach((y, i) => { if (y && typeof y === 'object') { mm.set(y, { parent: node, key: k, index: i }); if (y.type !== 'FunctionExpr') v(y); } }); else if (x && typeof x === 'object') { mm.set(x, { parent: node, key: k, index: -1 }); if (x.type !== 'FunctionExpr') v(x); } } };
    v(fn);
    m = mm; parentCache.set(fn, m);
  }
  return m;
}
function parentOf(fn: A.FunctionExpr, node: any): { parent: any; key: string; index: number; node: any } | null {
  const l = parentMap(fn).get(node); return l ? { ...l, node: l.parent } : null;
}
function isStoreTarget(fn: A.FunctionExpr, node: any): boolean { const l = parentMap(fn).get(node); return !!l && l.parent.type === 'AssignStat' && l.key === 'targets'; }

/** `function(...) local n = f("#", ...); if n == 0 then return … end; return n, { ... } end` */
export function isPackFunction(fn: A.FunctionExpr): boolean {
  if (fn.params.length || !fn.vararg) return false;
  const body = fn.body; const last = body[body.length - 1];
  if (!last || last.type !== 'ReturnStat' || last.args.length !== 2) return false;
  const t = unparen(last.args[1]);
  if (t.type !== 'TableExpr' || t.fields.length !== 1 || t.fields[0].kind !== 'item' || unparen(t.fields[0].value).type !== 'VarargLit') return false;
  for (const st of body.slice(0, -1)) {
    if (st.type === 'LocalStat' && st.init.length === 1) { const c = unparen(st.init[0]); if (c.type === 'CallExpr' && c.args.length === 2 && unparen(c.args[0]).type === 'StringLit' && (unparen(c.args[0]) as A.StringLit).value === '#' && unparen(c.args[1]).type === 'VarargLit') continue; }
    if (st.type === 'IfStat' && st.clauses.length === 1 && !st.elseBody && st.clauses[0].body.length === 1 && st.clauses[0].body[0].type === 'ReturnStat') {
      const c = unparen(st.clauses[0].cond);
      const zero = (e: A.Expr) => { const u = unparen(e); return u.type === 'NumberLit' && u.value === 0; };
      if (c.type === 'BinExpr' && c.op === '==' && (zero(c.left) || zero(c.right))) continue;
    }
    return false;
  }
  return true;
}
/** expressions (as printed) the source assigns a pack function to: `H = function(...) … return n, { ... } end` */
export function findPackHelpers(chunk: A.Chunk): Set<string> {
  const out = new Set<string>();
  visitAll(chunk, (m: any) => {
    if (m.type === 'AssignStat' && m.targets.length === 1 && m.values.length === 1 && unparen(m.values[0]).type === 'FunctionExpr' && isPackFunction(unparen(m.values[0]) as A.FunctionExpr)) out.add(printExpr(m.targets[0]));
    if (m.type === 'LocalFunctionStat' && isPackFunction(m.func)) out.add(m.name);
  });
  return out;
}
function visitAll(node: any, f: (m: any) => void) { if (!node || typeof node !== 'object') return; if (Array.isArray(node)) { for (const x of node) visitAll(x, f); return; } if (typeof node.type === 'string') f(node); for (const k of Object.keys(node)) if (k !== 'loc') { const x = node[k]; if (x && typeof x === 'object') visitAll(x, f); } }
