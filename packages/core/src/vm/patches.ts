// Static resolution of run-time patched dump-record slots (self-modifying bytecode).
//
// After patch discovery every instruction whose opcode/operand slot is written by the program is
// specialised once per possible value and selected by reading the slot (`if K_7[262] == 101 then …`).
// A forward must-analysis decides which slots are definitely stored before such a read: stores are
// direct (`K_n[k] = v`) or through a register/local holding the record (`R[33] = K_7; R[33][262] = 101`).
// Single-valued slots (every store in the program writes the same literal) are monotone — once
// written they keep the value across calls, loops and closure boundaries — so the state at a
// closure-creation site (`MAKER(PROTO_n, …)`) is a valid entry state for proto n.
//  * analyzeBlockGraph: on the residual state machine of one proto (blocks keyed by pc, `pc = K`
//    transfers) — optimistic reachability + must-analysis (SCCP style); resolved reads are replaced
//    by literals, unreachable blocks reported.
//  * resolvePatchedReads: on cleaned structured code (all protos) — remaining reads, and stores into
//    records that are no longer read anywhere are dropped.
import type * as A from '../ast.js';
import type { PatchSpec } from './specialize.js';
import { fold } from '../passes/fold.js';
import { devEnv } from '../env.js';

export type Lit = number | string | boolean | null;
interface SlotInfo { values: Lit[]; dynamic: boolean; single: boolean; }
/** must-state: patched-slot literals, record holders, tracked literals, and table aliases (`x = t`: x names the table t) */
/** known: patched slots; holders / lits / alias: must-facts about names and fields; rec: the records the
 *  fields of private fresh tables may hold (may-facts; a field not listed holds none; recTop: unknown) */
interface St { known: Map<string, Lit>; holders: Map<string, string>; lits: Map<string, Lit>; alias: Map<string, string>; rec: Map<string, Set<string>>; recTop: boolean; }
const mkSt = (known: Known): St => ({ known: new Map(known), holders: new Map(), lits: new Map(), alias: new Map(), rec: new Map(), recTop: false });
export type Known = Map<string, Lit>;

const unparen = (e: A.Expr): A.Expr => { while (e && e.type === 'ParenExpr') e = e.expr; return e; };
const clone = <T>(x: T): T => structuredClone(x);
export const litOf = (e: A.Expr | undefined): { ok: boolean; v: Lit } => {
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
const numRaw = (v: number) => String(v);
const litExpr = (v: Lit): A.Expr => {
  if (v === null) return { type: 'NilLit' };
  if (v === true) return { type: 'TrueLit' };
  if (v === false) return { type: 'FalseLit' };
  if (typeof v === 'number') return v < 0 ? { type: 'UnExpr', op: '-', expr: { type: 'NumberLit', value: -v, raw: numRaw(-v) } } : { type: 'NumberLit', value: v, raw: numRaw(v) };
  return { type: 'StringLit', value: v, raw: '' };
};
export const slotKey = (tid: string, k: Lit) => tid + '|' + (typeof k === 'number' ? 'n:' + k : 's:' + String(k));
const keyStr = (k: Lit) => typeof k === 'number' ? numRaw(k) : JSON.stringify(k);
/** tracked expression keys: `name` or `name[literal]` */
const trackKey = (e: A.Expr): string | null => {
  const u = unparen(e);
  if (u.type === 'NameExpr') return u.name;
  if (u.type === 'IndexExpr') { const o = unparen(u.obj); const k = litOf(u.index); if (o.type === 'NameExpr' && k.ok && (typeof k.v === 'number' || typeof k.v === 'string')) return o.name + '[' + keyStr(k.v) + ']'; }
  return null;
};
/** literal value of an expression, substituting known literals of tracked names / `name[k]` slots */
export function evalLit(e: A.Expr | undefined, lookup: (key: string) => { ok: boolean; v: Lit }, keyFn: (e: A.Expr) => string | null = trackKey): { ok: boolean; v: Lit } {
  if (!e) return { ok: false, v: null };
  const l = litOf(e); if (l.ok) return l;
  let bad = false, subs = 0;
  const sub = (x: A.Expr): A.Expr => {
    const u = unparen(x);
    const tk = keyFn(u);
    if (tk !== null) { const r = lookup(tk); if (r.ok) { subs++; return litExpr(r.v); } bad = true; return u; }
    switch (u.type) {
      case 'BinExpr': return { ...u, left: sub(u.left), right: sub(u.right) };
      case 'UnExpr': return { ...u, expr: sub(u.expr) };
      case 'NumberLit': case 'StringLit': case 'TrueLit': case 'FalseLit': case 'NilLit': return u;
      default: bad = true; return u;
    }
  };
  const r = sub(e);
  if (bad) return { ok: false, v: null };
  const ch: A.Chunk = { type: 'Chunk', body: [{ type: 'ReturnStat', args: [r] }] };
  try { fold(ch); } catch { return { ok: false, v: null }; }
  const out = litOf((ch.body[0] as A.ReturnStat).args[0]);
  return out.ok && (subs > 0 || true) ? out : { ok: false, v: null };
}
const copySt = (s: St): St => ({ known: new Map(s.known), holders: new Map(s.holders), lits: new Map(s.lits), alias: new Map(s.alias), rec: new Map(s.rec), recTop: s.recTop });
export const intersect = (a: Known, b: Known): Known => { const m = new Map<string, Lit>(); for (const [k, v] of a) if (b.has(k) && b.get(k) === v) m.set(k, v); return m; };
function meet(states: Array<St | null>): St | null {
  const live = states.filter((s): s is St => !!s);
  if (!live.length) return null;
  const out = copySt(live[0]);
  for (const s of live.slice(1)) {
    for (const [k, v] of out.known) if (!s.known.has(k) || s.known.get(k) !== v) out.known.delete(k);
    for (const [k, v] of out.holders) if (s.holders.get(k) !== v) out.holders.delete(k);
    for (const [k, v] of out.lits) if (!s.lits.has(k) || s.lits.get(k) !== v) out.lits.delete(k);
    for (const [k, v] of out.alias) if (s.alias.get(k) !== v) out.alias.delete(k);
    for (const [k, v] of s.rec) { const c = out.rec.get(k); out.rec.set(k, c ? new Set([...c, ...v]) : v); }
    if (s.recTop) out.recTop = true;
  }
  return out;
}
const truth = (e: A.Expr): boolean | null => {
  const ch: A.Chunk = { type: 'Chunk', body: [{ type: 'ReturnStat', args: [clone(e)] }] };
  try { fold(ch); } catch { return null; }
  const u = unparen((ch.body[0] as A.ReturnStat).args[0]);
  if (u.type === 'TrueLit' || u.type === 'NumberLit' || u.type === 'StringLit' || u.type === 'TableExpr' || u.type === 'FunctionExpr') return true;
  if (u.type === 'FalseLit' || u.type === 'NilLit') return false;
  return null;
};

/** the written slots of all dump records */
export class PatchModel {
  readonly slots = new Map<string, SlotInfo>();
  readonly dynTables = new Set<string>();
  readonly tables = new Set<string>();
  constructor(patches: PatchSpec[]) {
    for (const p of patches) {
      const t = String(p.table);
      this.tables.add(t);
      if (p.anyKey || p.key === undefined) { this.dynTables.add(t); continue; }
      const sk = slotKey(t, p.key);
      let e = this.slots.get(sk); if (!e) { e = { values: [], dynamic: false, single: false }; this.slots.set(sk, e); }
      for (const v of p.values) if (!e.values.some(x => x === v)) e.values.push(v);
      if (p.dynamic) e.dynamic = true;
    }
    for (const [sk, e] of this.slots) e.single = !e.dynamic && e.values.length === 1 && !this.dynTables.has(sk.slice(0, sk.indexOf('|')));
  }
  slot(tid: string, k: Lit): SlotInfo | null { return this.dynTables.has(tid) ? { values: [], dynamic: true, single: false } : (this.slots.get(slotKey(tid, k)) ?? null); }
  single(sk: string): boolean { return !!this.slots.get(sk)?.single; }
}

export interface AnalyzerHooks {
  model: PatchModel;
  recordId: (name: string) => string | null;
  createdProto?: (call: A.CallExpr) => string | null;
  /** replace resolved reads in the AST (otherwise expressions are evaluated on copies) */
  mutate: boolean;
  /** state-machine mode: assignments `pcVar = K` are edges */
  pcVar?: string;
  onEdge?: (target: number | null, st: St) => void;
  /** any store into a dump record (patch discovery): key / value literal when known */
  onRecordStore?: (tid: string, key: { ok: boolean; v: Lit }, value: { ok: boolean; v: Lit }) => void;
  onCreate?: (proto: string, known: Known) => void;
  onRead?: (tid: string, resolved: boolean) => void;
  onEscape?: (tid: string) => void;
  /** names a call may change (captured by closures) */
  captured?: Set<string>;
  /** knowledge implied by a true guard `slot == lit` (state at the stores that write lit) */
  implied?: (tid: string, key: Lit, lit: Lit) => Known | null;
  /** a literal store into a patched slot, with the state before it */
  onStore?: (sk: string, lit: Lit, before: Known) => void;
  /** a literal store into a patched slot, with the single-valued state at the end of its straight-line run
   *  (the following assignments without calls, closures or control flow have run as well) */
  onRunStore?: (sk: string, lit: Lit, after: Known) => void;
  /** a store into a table that is not known to be a dump record (literal key / value when known) */
  onUnknownStore?: (key: { ok: boolean; v: Lit }, value: { ok: boolean; v: Lit }, base: A.Expr) => void;
  /** a read through a table that is not known to be a dump record (its base expression) */
  onUnknownRead?: (base: A.Expr) => void;
  /** argument positions a callee only reads (a fresh table handed there stays private) */
  readerCall?: (callee: A.Expr) => Set<number> | null;
  /** fresh private tables of the proto: fields that may hold records (key text / '*'), and the keys other
   *  code can reach through reference pairs; calls keep what is known about the other fields */
  privateFields?: (name: string) => { fields: Map<string, Set<string>>; shared: Set<string> } | null;
  /** flow-insensitive: the records an expression may evaluate to */
  mayRecords?: (e: A.Expr) => Set<string>;
}
interface Loop { breaks: Array<St | null>; conts: Array<St | null>; }

/** statement-level must-analysis (one function body / block list) */
export function makeAnalyzer(h: AnalyzerHooks) {
  const model = h.model;
  const captured = h.captured ?? new Set<string>();
  const singlesOf = (st: St): Known => { const m = new Map<string, Lit>(); for (const [k, v] of st.known) if (model.single(k)) m.set(k, v); return m; };
  // a call cannot change the unshared fields of a private table
  const keepOnCall = (k: string): boolean => {
    if (!h.privateFields) return false;
    const i = k.indexOf('['); if (i <= 0 || !k.endsWith(']')) return false;
    const pf = h.privateFields(k.slice(0, i)); if (!pf) return false;
    return !pf.shared.has(k.slice(i + 1, -1));
  };
  const killCall = (st: St) => {
    for (const k of [...st.holders.keys()]) if ((k.includes('[') && !keepOnCall(k)) || captured.has(k)) st.holders.delete(k);
    for (const k of [...st.lits.keys()]) if ((k.includes('[') && !keepOnCall(k)) || captured.has(k)) st.lits.delete(k);
    for (const k of [...st.known.keys()]) if (!model.single(k)) st.known.delete(k);
    for (const [k, v] of [...st.alias]) if (captured.has(k) || captured.has(v)) st.alias.delete(k);
  };
  const killName = (st: St, n: string) => {
    for (const m of [st.holders, st.lits] as Array<Map<string, unknown>>) for (const k of [...m.keys()]) if (k === n || k.startsWith(n + '[')) m.delete(k);
    st.alias.delete(n);
    for (const [k, v] of [...st.alias]) if (v === n) st.alias.delete(k);
  };
  const killIndex = (st: St, k: Lit | undefined) => {   // a store X[k] into an unknown table
    const suf = k === undefined ? null : '[' + keyStr(k) + ']';
    for (const m of [st.holders, st.lits] as Array<Map<string, unknown>>) for (const key of [...m.keys()]) if (key.includes('[') && (suf === null || key.endsWith(suf))) m.delete(key);
    const ks = k === undefined ? null : '|' + (typeof k === 'number' ? 'n:' + k : 's:' + String(k));
    for (const sk of [...st.known.keys()]) { if (model.single(sk)) continue; if (ks === null || sk.endsWith(ks)) st.known.delete(sk); }
  };
  /** canonical tracked key: `name`, or `base[k]` with the base resolved through table aliases and the index
   *  through tracked literals (`var53 = R; var62 = 127; var53[var62]` is `R[127]`) */
  const tkey = (e: A.Expr, st: St): string | null => {
    const u = unparen(e);
    if (u.type === 'NameExpr') return u.name;
    if (u.type === 'IndexExpr') {
      const o = unparen(u.obj); if (o.type !== 'NameExpr') return null;
      const base = st.alias.get(o.name) ?? o.name;
      let k = litOf(u.index);
      if (!k.ok) k = keyOf(u.index, st);
      if (k.ok && (typeof k.v === 'number' || typeof k.v === 'string')) return base + '[' + keyStr(k.v) + ']';
    }
    return null;
  };
  const tableOf = (e: A.Expr, st: St): string | null => {
    const u = unparen(e);
    if (u.type === 'NameExpr') { const r = h.recordId(u.name); if (r !== null) return r; }
    const tk = tkey(u, st); return tk === null ? null : (st.holders.get(tk) ?? null);
  };
  const keyOf = (e: A.Expr, st: St): { ok: boolean; v: Lit } => evalLit(e, (k) => st.lits.has(k) ? { ok: true, v: st.lits.get(k)! } : { ok: false, v: null }, (x) => tkey(x, st));
  const escape = (e: A.Expr, st: St) => { if (!h.onEscape) return; const u = unparen(e); if (u.type !== 'NameExpr' && u.type !== 'IndexExpr') return; const t = tableOf(u, st); if (t !== null && model.tables.has(t)) { if (devEnv('PRISM_ESC_TRACE')) console.error('[esc]', t, JSON.stringify(u).slice(0, 160)); h.onEscape(t); } };
  // ---- expressions (evaluation order; calls apply their effects)
  const visitE = (e: A.Expr, st: St, ctx: 'value' | 'base' | 'copy' = 'value'): A.Expr => {
    if (!e || typeof e !== 'object') return e;
    switch (e.type) {
      case 'IndexExpr': {
        e.obj = visitE(e.obj, st, 'base');
        e.index = visitE(e.index, st);
        const tid = tableOf(e.obj, st);
        if (tid === null) h.onUnknownRead?.(e.obj);
        if (tid !== null && model.tables.has(tid)) {
          const k = keyOf(e.index, st);
          if (!k.ok) { h.onRead?.(tid, false); return e; }
          if (model.slot(tid, k.v)) {
            const sk = slotKey(tid, k.v);
            if (st.known.has(sk)) { h.onRead?.(tid, true); return litExpr(st.known.get(sk)!); }
            h.onRead?.(tid, false);
          }
        }
        if (ctx === 'value') escape(e, st);
        return e;
      }
      case 'NameExpr': if (ctx === 'value') escape(e, st); return e;
      case 'NumberLit': case 'StringLit': case 'NilLit': case 'TrueLit': case 'FalseLit': case 'VarargLit': return e;
      case 'CallExpr': {
        e.callee = visitE(e.callee, st, 'base');
        e.args = e.args.map(a => visitE(a, st));
        // a private table handed to a pure reader: the records its fields may hold right now escape
        const rp = h.readerCall?.(e.callee);
        if (rp && h.privateFields && h.onEscape) for (const i of rp) {
          const a = e.args[i] ? unparen(e.args[i]) : null; if (!a || a.type !== 'NameExpr') continue;
          const pf = h.privateFields(a.name); if (!pf) continue;
          if (st.recTop) { if (devEnv('PRISM_ESC_TRACE')) console.error('[esc-top]', a.name); for (const ts of pf.fields.values()) for (const t of ts) h.onEscape(t); continue; }
          for (const [key, ts] of st.rec) if (key.startsWith(a.name + '[')) for (const t of ts) { if (devEnv('PRISM_ESC_TRACE')) console.error('[esc-reader]', t, key, JSON.stringify(e.callee).slice(0, 80)); h.onEscape(t); }
        }
        const pid = h.createdProto ? h.createdProto(e) : null;
        if (pid !== null) h.onCreate?.(pid, singlesOf(st));
        killCall(st);
        return e;
      }
      case 'MethodCallExpr': {
        e.obj = visitE(e.obj, st, 'base');
        escape(e.obj, st);   // passed as self
        e.args = e.args.map(a => visitE(a, st));
        killCall(st);
        return e;
      }
      case 'FunctionExpr': { fnBody(e, st); return e; }
      case 'BinExpr': {
        e.left = visitE(e.left, st);
        if (e.op === 'and' || e.op === 'or') { const s2 = copySt(st); e.right = visitE(e.right, s2); const m = meet([st, s2])!; st.known = m.known; st.holders = m.holders; st.lits = m.lits; }
        else e.right = visitE(e.right, st);
        return e;
      }
      case 'TableExpr': {
        for (const f of e.fields) { if (f.key) f.key = visitE(f.key, st); f.value = visitE(f.value, st); }
        return e;
      }
      default: {
        const x: any = e;
        for (const k of Object.keys(x)) {
          if (k === 'loc') continue;
          const v = x[k];
          if (Array.isArray(v)) x[k] = v.map((y: any) => y && typeof y === 'object' && typeof y.type === 'string' ? visitE(y, st) : (y && typeof y === 'object' && y.kind === 'expr' ? { ...y, expr: visitE(y.expr, st) } : y));
          else if (v && typeof v === 'object' && typeof v.type === 'string') x[k] = visitE(v, st);
        }
        return e;
      }
    }
  };
  /** evaluate an expression slot of a statement (copy unless mutating) */
  const ev = (e: A.Expr, st: St, ctx: 'value' | 'base' | 'copy' = 'value'): A.Expr => visitE(h.mutate ? e : clone(e), st, ctx);
  const fnBody = (f: A.FunctionExpr, st: St) => {
    const s2: St = mkSt(singlesOf(st));
    const sub = makeAnalyzer({ ...h, pcVar: undefined, onEdge: undefined });
    sub.list(f.body, s2);
  };
  const loopKill = (body: A.Stat[], st: St) => {
    const visit = (x: any) => {
      if (!x || typeof x !== 'object') return;
      if (Array.isArray(x)) { for (const y of x) visit(y); return; }
      if (x.type === 'FunctionExpr') return;
      if (x.type === 'AssignStat') for (const t of x.targets) { const u = unparen(t); if (u.type === 'NameExpr') killName(st, u.name); else if (u.type === 'IndexExpr') { const k = litOf(u.index); const tk = k.ok ? tkey(u, st) : null; if (tk) killName(st, tk); killIndex(st, k.ok ? k.v : undefined); } }
      if (x.type === 'LocalStat') for (const n of x.names) killName(st, n);
      if (x.type === 'NumericForStat') killName(st, x.var);
      if (x.type === 'GenericForStat') for (const n of x.names) killName(st, n);
      if (x.type === 'LocalFunctionStat') killName(st, x.name);
      if (x.type === 'CallExpr' || x.type === 'MethodCallExpr') killCall(st);
      for (const k of Object.keys(x)) if (k !== 'loc') visit(x[k]);
    };
    visit(body);
  };
  /** a true guard `slot == lit` (conjunction of such tests): the slot holds lit, and the stores writing it have run */
  const learn = (cond: A.Expr, st: St) => {
    const conj: A.Expr[] = [];
    const flat = (e: A.Expr) => { const u = unparen(e); if (u.type === 'BinExpr' && u.op === 'and') { flat(u.left); flat(u.right); } else conj.push(u); };
    flat(cond);
    for (const c of conj) {
      if (c.type !== 'BinExpr' || c.op !== '==') continue;
      let ix = unparen(c.left), lv = litOf(c.right);
      if (ix.type !== 'IndexExpr' || !lv.ok) { ix = unparen(c.right); lv = litOf(c.left); }
      if (ix.type !== 'IndexExpr' || !lv.ok) continue;
      const tid = tableOf(ix.obj, st); if (tid === null || !model.tables.has(tid)) continue;
      const k = keyOf(ix.index, st); if (!k.ok) continue;
      const si = model.slot(tid, k.v); if (!si || !si.values.some(x => x === lv.v)) continue;
      st.known.set(slotKey(tid, k.v), lv.v);
      // (inside the straight-line run that stores the flag, the rest of its chain has not run yet)
      { const fk = slotKey(tid, k.v); if (pendChain.some(pl => pl.some(([x]) => x === fk))) continue; }
      const imp = h.implied?.(tid, k.v, lv.v);
      if (imp) for (const [kk, vv] of imp) if (model.single(kk)) st.known.set(kk, vv);
    }
  };
  const isMulti = (e: A.Expr | undefined) => !!e && (e.type === 'CallExpr' || e.type === 'MethodCallExpr' || e.type === 'VarargLit');
  /** what is known about an assigned value — evaluated before any target of the statement is assigned */
  type Val = { tab: string | null; lit: { ok: boolean; v: Lit }; alias?: string };
  const valOf = (st: St, value: A.Expr | undefined, valueUnknown: boolean): Val => {
    if (!value) return { tab: null, lit: valueUnknown ? { ok: false, v: null } : { ok: true, v: null } };
    const u = unparen(value);
    const tab = tableOf(value, st);
    const alias = tab === null && u.type === 'NameExpr' ? (st.alias.get(u.name) ?? u.name) : undefined;
    return { tab, lit: keyOf(value, st), alias };
  };
  const assign = (st: St, target: A.Expr, value: A.Expr | undefined, valueUnknown: boolean, pre?: Val) => {
    const u = unparen(target);
    const val = pre ?? valOf(st, value, valueUnknown);
    const setTrack = (tk: string) => {
      killName(st, tk);
      if (val.tab !== null) st.holders.set(tk, val.tab);
      if (val.lit.ok) st.lits.set(tk, val.lit.v);
    };
    if (u.type === 'NameExpr') {
      setTrack(u.name);
      if (val.alias !== undefined && val.alias !== u.name && !captured.has(u.name) && !captured.has(val.alias)) st.alias.set(u.name, val.alias);
      return;
    }
    if (u.type === 'IndexExpr') {
      const tid = tableOf(u.obj, st);
      const k = keyOf(u.index, st);
      recStore(st, u, k, value, val);
      if (tid !== null) {
        if (h.onRecordStore) h.onRecordStore(tid, k, val.lit);
        if (model.tables.has(tid)) {
          if (k.ok) {
            const sk = slotKey(tid, k.v);
            const v = val.lit;
            if (v.ok && model.slot(tid, k.v)) { h.onStore?.(sk, v.v, new Map(st.known)); st.known.set(sk, v.v); if (runPend) runPend.push([sk, v.v]); } else if (!model.single(sk)) st.known.delete(sk);
          } else for (const sk of [...st.known.keys()]) if (sk.startsWith(tid + '|') && !model.single(sk)) st.known.delete(sk);
        }
      } else { killIndex(st, k.ok ? k.v : undefined); h.onUnknownStore?.(k, val.lit, u.obj); }
      const tk = tkey(u, st);
      if (tk !== null) setTrack(tk);
      return;
    }
  };
  /** the may-records of a private table field after a store */
  function recStore(st: St, target: A.IndexExpr, k: { ok: boolean; v: Lit }, value: A.Expr | undefined, val: Val) {
    if (!h.privateFields) return;
    const o = unparen(target.obj); if (o.type !== 'NameExpr') return;
    const base = st.alias.get(o.name) ?? o.name;
    if (!h.privateFields(base)) return;
    let recs: Set<string>;
    if (val.tab !== null && model.tables.has(val.tab)) recs = new Set([val.tab]);
    else if (!value) recs = new Set();
    else { const vk = tkey(value, st); const r = vk !== null ? st.rec.get(vk) : undefined; recs = r ?? (vk !== null && vk.includes('[') && h.privateFields(vk.slice(0, vk.indexOf('['))) && !st.recTop ? new Set(st.rec.get(vk.slice(0, vk.indexOf('[')) + '[*]') ?? []) : (h.mayRecords?.(value) ?? new Set())); }
    if (k.ok && (typeof k.v === 'number' || typeof k.v === 'string')) { const key = base + '[' + keyStr(k.v) + ']'; if (recs.size) st.rec.set(key, recs); else st.rec.delete(key); }
    else if (recs.size) { const key = base + '[*]'; st.rec.set(key, new Set([...(st.rec.get(key) ?? []), ...recs])); }
  }
  // straight-line runs: assignments without calls / closures / varargs (and register-range clears); the
  // literal stores into patched slots of a run are reported with the state at the end of the run
  let runPend: Array<[string, Lit]> | null = null;
  const pendChain: Array<Array<[string, Lit]>> = [];   // pending runs enclosing the statement being analysed
  const noCode = (x: any): boolean => { const stk: any[] = [x]; while (stk.length) { const y = stk.pop(); if (!y || typeof y !== 'object') continue; if (Array.isArray(y)) { for (const z of y) stk.push(z); continue; } if (y.type === 'CallExpr' || y.type === 'MethodCallExpr' || y.type === 'FunctionExpr' || y.type === 'VarargLit') return false; for (const k of Object.keys(y)) if (k !== 'loc') stk.push(y[k]); } return true; };
  // (an if / do statement made only of such code continues the run: nested one-time guards of a patch chain)
  const straight = (s: A.Stat): boolean => (s.type === 'AssignStat' || s.type === 'LocalStat') ? noCode(s)
    : s.type === 'NumericForStat' ? s.body.length === 1 && s.body[0].type === 'AssignStat' && noCode(s)
    : s.type === 'IfStat' ? s.clauses.every(c => noCode(c.cond) && c.body.every(straight)) && (!s.elseBody || s.elseBody.every(straight))
    : s.type === 'DoStat' ? s.body.every(straight) : false;
  const list = (stmts: A.Stat[], st: St | null, loop: Loop | null = null): St | null => {
    if (!h.onRunStore) { for (const s of stmts) { if (!st) return null; st = stat(s, st, loop); } return st; }
    const saved = runPend;
    let pend: Array<[string, Lit]> = [];
    const flush = (x: St | null) => { if (x && pend.length) { const k = singlesOf(x); for (const [sk, v] of pend) h.onRunStore!(sk, v, k); } pend = []; };
    for (const s of stmts) {
      if (!st) { runPend = saved; return null; }
      if (straight(s)) { runPend = pend; pendChain.push(pend); st = stat(s, st, loop); pendChain.pop(); runPend = null; continue; }
      flush(st);
      runPend = null;
      st = stat(s, st, loop);
    }
    flush(st);
    runPend = saved;
    return st;
  };
  /** the may-records of private fields at a loop head include what the back edges bring: the body is
   *  analysed again while they grow (not when mutating: the escapes of the last observation are used) */
  const growRec = (head: St, backs: Array<St | null>): boolean => {
    let grown = false;
    for (const b of backs) {
      if (!b) continue;
      if (b.recTop && !head.recTop) { head.recTop = true; grown = true; }
      for (const [k, v] of b.rec) { const c = head.rec.get(k); if (!c) { head.rec.set(k, v); grown = true; continue; } let add = false; for (const t of v) if (!c.has(t)) { add = true; break; } if (add) { head.rec.set(k, new Set([...c, ...v])); grown = true; } }
    }
    return grown;
  };
  const iterLoop = (head: St, run: (hd: St, lp: Loop) => Array<St | null>): Loop => {
    for (let i = 0; ; i++) {
      const lp: Loop = { breaks: [], conts: [] };
      const backs = run(copySt(head), lp);
      if (h.mutate || !h.privateFields || head.recTop) return lp;
      if (!growRec(head, backs)) return lp;
      if (i >= 3) { head.recTop = true; const lp2: Loop = { breaks: [], conts: [] }; run(copySt(head), lp2); return lp2; }
    }
  };
  const stat = (s: A.Stat, st: St, loop: Loop | null): St | null => {
    switch (s.type) {
      case 'LocalStat': {
        const vals = s.init.map(e => ev(e, st, 'copy'));
        if (h.mutate) s.init = vals;
        const pre = s.names.map((_, i) => valOf(st, vals[i], i >= vals.length && isMulti(vals[vals.length - 1])));
        s.names.forEach((n, i) => assign(st, { type: 'NameExpr', name: n }, vals[i], false, pre[i]));
        return st;
      }
      case 'AssignStat': {
        const tgts = s.targets.map(t => { const u = h.mutate ? t : clone(t); const x = unparen(u); if (x.type === 'IndexExpr') { x.obj = visitE(x.obj, st, 'base'); x.index = visitE(x.index, st); } else if (x.type === 'MemberExpr') x.obj = visitE(x.obj, st, 'base'); return u; });
        if (h.mutate) s.targets = tgts;
        if (s.op) {   // compound `t op= v`: the value is `t op v`
          const vals = s.values.map(e => ev(e, st)); if (h.mutate) s.values = vals;
          const bop = s.op.slice(0, -1);
          const pre = tgts.map((t, i) => { const v = vals[i]; const r = v ? valOf(st, { type: 'BinExpr', op: bop, left: clone(t), right: v } as A.Expr, false) : valOf(st, undefined, true); return { tab: null, lit: r.lit }; });
          tgts.forEach((t, i) => assign(st, t, undefined, true, pre[i]));
          return st;
        }
        const vals = s.values.map((e, i) => ev(e, st, tgts[i] && tkey(tgts[i], st) !== null ? 'copy' : 'value'));
        if (h.mutate) s.values = vals;
        // state transfer
        if (h.pcVar && tgts.length === 1 && unparen(tgts[0]).type === 'NameExpr' && (unparen(tgts[0]) as A.NameExpr).name === h.pcVar) {
          const v = litOf(vals[0]);
          h.onEdge?.(v.ok && typeof v.v === 'number' ? v.v : null, copySt(st));
          return st;
        }
        const pre = tgts.map((_, i) => valOf(st, vals[i], i >= vals.length && isMulti(vals[vals.length - 1])));
        tgts.forEach((t, i) => assign(st, t, vals[i], false, pre[i]));
        return st;
      }
      case 'CallStat': {
        const c = ev(s.expr, st) as any; if (h.mutate) s.expr = c;
        if (c.type === 'CallExpr' && c.callee.type === 'NameExpr' && c.callee.name === 'error') return null;
        return st;
      }
      case 'DoStat': return list(s.body, st, loop);
      case 'IfStat': {
        const ends: Array<St | null> = [];
        let decided = false;
        for (const c of s.clauses) {
          const cond = ev(c.cond, st); if (h.mutate) c.cond = cond;
          let t = truth(cond);
          if (t === null) {   // decided by tracked literals (registers / locals known on every path)
            const l = keyOf(cond, st);
            if (l.ok) { t = l.v !== null && l.v !== false; if (h.mutate) c.cond = { type: t ? 'TrueLit' : 'FalseLit' } as A.Expr; }
          }
          if (t === false) continue;
          const bs = copySt(st);
          if (t === null) learn(cond, bs);
          ends.push(list(c.body, bs, loop));
          if (t === true) { decided = true; break; }
        }
        if (!decided) ends.push(s.elseBody ? list(s.elseBody, copySt(st), loop) : st);
        return meet(ends);
      }
      case 'WhileStat': {
        const head = copySt(st); loopKill(s.body, head);
        const cond = ev(s.cond, head); if (h.mutate) s.cond = cond;
        const t = truth(cond);
        if (t === false) return head;
        let first = true;
        const lp = iterLoop(head, (hd, l) => { if (!first) ev(s.cond, hd); first = false; const end = list(s.body, hd, l); return [end, ...l.conts]; });
        return meet(t === true ? lp.breaks : [head, ...lp.breaks]);
      }
      case 'RepeatStat': {
        const once = truth(s.cond) === true;
        const head = copySt(st); if (!once) loopKill(s.body, head);
        let atCond: St | null = null;
        const lp = iterLoop(head, (hd, l) => { const end = list(s.body, hd, l); atCond = meet([end, ...l.conts]); if (atCond) { const cond = ev(s.cond, atCond); if (h.mutate) s.cond = cond; } return once ? [] : [atCond]; });
        return meet([atCond, ...lp.breaks]);
      }
      case 'NumericForStat': {
        const f = ev(s.from, st), t = ev(s.to, st), p = s.step ? ev(s.step, st) : undefined;
        if (h.mutate) { s.from = f; s.to = t; s.step = p; }
        // register-range clear `for i = a, b do R[i] = <literal> end` (LOADNIL-like): a store per slot
        {
          const a = keyOf(f, st), b = keyOf(t, st), stp = p ? keyOf(p, st) : { ok: true, v: 1 as Lit };
          const one = s.body.length === 1 ? s.body[0] : null;
          if (a.ok && b.ok && stp.ok && typeof a.v === 'number' && typeof b.v === 'number' && stp.v === 1 && b.v - a.v <= 256 && one && one.type === 'AssignStat' && !one.op && one.targets.length === 1 && one.values.length === 1) {
            const tg = unparen(one.targets[0]);
            const vl = litOf(one.values[0]);
            if (tg.type === 'IndexExpr' && tg.obj.type === 'NameExpr' && tg.obj.name !== s.var && unparen(tg.index).type === 'NameExpr' && (unparen(tg.index) as A.NameExpr).name === s.var && vl.ok) {
              for (let i = a.v; i <= b.v; i++) assign(st, { type: 'IndexExpr', obj: tg.obj, index: { type: 'NumberLit', value: i, raw: String(i) } } as A.Expr, one.values[0], false);
              return st;
            }
          }
        }
        const head = copySt(st); loopKill(s.body, head); killName(head, s.var);
        const lp = iterLoop(head, (hd, l) => [list(s.body, hd, l), ...l.conts]);
        return meet([head, ...lp.breaks]);
      }
      case 'GenericForStat': {
        const its = s.iters.map(e => ev(e, st)); if (h.mutate) s.iters = its;
        killCall(st);
        const head = copySt(st); loopKill(s.body, head); for (const n of s.names) killName(head, n);
        const lp = iterLoop(head, (hd, l) => [list(s.body, hd, l), ...l.conts]);
        return meet([head, ...lp.breaks]);
      }
      case 'ReturnStat': { const a = s.args.map(e => ev(e, st)); if (h.mutate) s.args = a; return null; }
      case 'BreakStat': { if (loop) loop.breaks.push(copySt(st)); return null; }
      case 'ContinueStat': { if (loop) loop.conts.push(copySt(st)); return null; }
      case 'FunctionStat': { fnBody(s.func, st); assign(st, s.target, undefined, true); return st; }
      case 'LocalFunctionStat': { killName(st, s.name); fnBody(s.func, st); return st; }
      case 'GotoStat': case 'LabelStat': { const r = mkSt(singlesOf(st)); r.recTop = true; return r; }
      default: return st;
    }
  };
  return { list, fresh: (known: Known): St => mkSt(known) };
}

/** free names of nested functions (approximation: referenced inside, not declared inside) — a call may change them */
export function capturedNames(root: any): Set<string> {
  const out = new Set<string>();
  const visitFn = (f: A.FunctionExpr) => {
    const declared = new Set<string>(f.params);
    const refs = new Set<string>();
    const v = (x: any) => {
      if (!x || typeof x !== 'object') return;
      if (Array.isArray(x)) { for (const y of x) v(y); return; }
      if (x.type === 'LocalStat') for (const n of x.names) declared.add(n);
      if (x.type === 'LocalFunctionStat') declared.add(x.name);
      if (x.type === 'NumericForStat') declared.add(x.var);
      if (x.type === 'GenericForStat') for (const n of x.names) declared.add(n);
      if (x.type === 'FunctionExpr' && x !== f) for (const p of x.params) declared.add(p);
      if (x.type === 'NameExpr') refs.add(x.name);
      for (const k of Object.keys(x)) if (k !== 'loc') v(x[k]);
    };
    v(f.body);
    for (const r of refs) if (!declared.has(r)) out.add(r);
  };
  const st: any[] = [root];
  while (st.length) { const x = st.pop(); if (!x || typeof x !== 'object') continue; if (Array.isArray(x)) { for (const y of x) st.push(y); continue; } if (x.type === 'FunctionExpr') visitFn(x); for (const k of Object.keys(x)) if (k !== 'loc') st.push(x[k]); }
  return out;
}

export interface BlockGraphResult { reached: Set<number>; resolved: number; unresolved: number; creates: Map<string, Known>; incomplete?: boolean; iterations?: number; }
const stSize = (s: St) => s.known.size + s.holders.size + s.lits.size;
/** must-analysis over the residual state machine of one proto (optimistic reachability, SCCP style);
 *  resolved reads are replaced in `blocks` */
export function analyzeBlockGraph(blocks: Map<number, A.Stat[]>, entryPc: number, entryKnown: Known, hooks: Omit<AnalyzerHooks, 'mutate' | 'onEdge' | 'pcVar'> & { pcVar: string }): BlockGraphResult {
  const IN = new Map<number, St>([[entryPc, mkSt(entryKnown)]]);
  const work: number[] = [entryPc];
  const all = [...blocks.keys()];
  let guard = 0;
  while (work.length && guard++ < 400000) {
    const b = work.pop()!;
    const stmts = blocks.get(b); if (!stmts) continue;
    const edges = new Map<number, St>(); let dyn: St | null = null;
    const an = makeAnalyzer({ ...hooks, onCreate: undefined, onRead: undefined, onEscape: undefined, onStore: undefined, onRecordStore: undefined, mutate: false, onEdge: (t, k) => { if (t === null) dyn = dyn ? meet([dyn, k]) : k; else edges.set(t, edges.has(t) ? meet([edges.get(t)!, k])! : k); } });
    an.list(stmts, copySt(IN.get(b)!));
    const outs: Array<[number, St]> = [...edges];
    if (dyn) for (const t of all) outs.push([t, edges.has(t) ? meet([edges.get(t)!, dyn])! : dyn]);
    for (const [t, k] of outs) {
      if (!blocks.has(t)) continue;
      const prev = IN.get(t);
      if (prev === undefined) { IN.set(t, k); work.push(t); continue; }
      const nk = meet([prev, k])!;
      if (stSize(nk) < stSize(prev)) { IN.set(t, nk); work.push(t); }
    }
  }
  // no fixpoint within the budget: nothing is known (every block may run, no read is resolved)
  if (work.length) return { reached: new Set(all), resolved: 0, unresolved: 0, creates: new Map(), incomplete: true };
  const res: BlockGraphResult = { reached: new Set(IN.keys()), resolved: 0, unresolved: 0, creates: new Map(), iterations: guard };
  for (const [b, st] of IN) {
    const stmts = blocks.get(b); if (!stmts) continue;
    const an = makeAnalyzer({ ...hooks, mutate: true, onEdge: undefined, onRead: (_t, ok) => { if (ok) res.resolved++; else res.unresolved++; }, onCreate: (pid, k) => { const prev = res.creates.get(pid); res.creates.set(pid, prev ? intersect(prev, k) : k); } });
    an.list(stmts, copySt(st));
  }
  return res;
}

/** flow-insensitive references to the patched records in one proto: the locations that may hold a record
 *  (names; fields of the proto's own fresh tables) and the records that escape — passed to calls, returned,
 *  stored into tables other code can reach — where code this analysis cannot see may write them.
 *  A fresh table (every assignment a constructor / table.create / nil) is private while it is only
 *  indexed or handed to a pure reader (a function that only reads that argument: its fields are checked
 *  flow-sensitively at the call by the analyzer); handed out as the [2] of a `{[1] = r, [2] = T}`
 *  reference pair only its field r is shared (references are used as `C[2][C[1]]`). */
export interface RecordFlow {
  escaped: Set<string>;
  /** records an expression may evaluate to */
  may: (e: A.Expr) => Set<string>;
  /** fields (tracked key text, or '*') of a fresh table that may hold records; null when not a fresh table or fully shared */
  fields: (name: string) => Map<string, Set<string>> | null;
  /** keys (tracked key text) of a fresh table reachable by other code through reference pairs */
  sharedKeys: (name: string) => Set<string> | null;
}
export type PureReader = (callee: A.Expr) => Set<number> | null;
export function recordFlow(chunk: A.Chunk, recordId: (n: string) => string | null, isTable: (t: string) => boolean, pureReader?: PureReader, why?: (t: string, reason: string, e: A.Expr) => void): RecordFlow {
  const recOf = (e: A.Expr): string | null => { const u = unparen(e); if (u.type !== 'NameExpr') return null; const t = recordId(u.name); return t !== null && isTable(t) ? t : null; };
  const isCreate = (e: A.Expr): boolean => { const u = unparen(e); if (u.type !== 'CallExpr') return false; const c = unparen(u.callee); if (c.type === 'MemberExpr') return unparen(c.obj).type === 'NameExpr' && (unparen(c.obj) as A.NameExpr).name === 'table' && c.name === 'create'; if (c.type === 'IndexExpr') { const o = unparen(c.obj), i = unparen(c.index); return o.type === 'NameExpr' && o.name === 'table' && i.type === 'StringLit' && i.value === 'create'; } return false; };
  // ---- fresh names
  const assigned = new Map<string, boolean>();   // name -> every assignment fresh so far
  const note = (n: string, e: A.Expr | null) => { const f = e !== null && (unparen(e).type === 'TableExpr' || unparen(e).type === 'NilLit' || isCreate(e)); assigned.set(n, (assigned.get(n) ?? true) && f); };
  const multi = (e: A.Expr | undefined) => !!e && (e.type === 'CallExpr' || e.type === 'MethodCallExpr' || e.type === 'VarargLit');
  const scanAssign = (x: any) => {
    if (!x || typeof x !== 'object') return;
    if (Array.isArray(x)) { for (const y of x) scanAssign(y); return; }
    switch (x.type) {
      case 'LocalStat': x.names.forEach((n: string, i: number) => note(n, i < x.init.length ? x.init[i] : (x.init.length && multi(x.init[x.init.length - 1]) ? null : { type: 'NilLit' } as A.Expr))); break;
      case 'AssignStat': x.targets.forEach((t: A.Expr, i: number) => { const u = unparen(t); if (u.type === 'NameExpr') note(u.name, x.op ? null : i < x.values.length ? x.values[i] : (x.values.length && multi(x.values[x.values.length - 1]) ? null : { type: 'NilLit' } as A.Expr)); }); break;
      case 'NumericForStat': note(x.var, null); break;
      case 'GenericForStat': for (const n of x.names) note(n, null); break;
      case 'LocalFunctionStat': note(x.name, null); break;
      case 'FunctionStat': { const u = unparen(x.target); if (u.type === 'NameExpr') note(u.name, null); break; }
      case 'FunctionExpr': for (const n of x.params) note(n, null); break;
    }
    for (const k of Object.keys(x)) if (k !== 'loc') scanAssign(x[k]);
  };
  scanAssign(chunk);
  const captured = capturedNames(chunk);
  const fresh = (n: string) => assigned.get(n) === true && recordId(n) === null && !captured.has(n);
  // the keys a fresh table may have (literal keys of its non-nil stores; null: unknown), and the key
  // variables of loops over such tables (`for k, v in T` / pairs(T) / next, T) — assigned nowhere else
  const keyLit = (e: A.Expr): string | null => { const l = litOf(e); return l.ok && (typeof l.v === 'number' || typeof l.v === 'string') ? keyStr(l.v) : null; };
  const tableKeys = new Map<string, Set<string> | null>();
  const addKey = (n: string, k: string | null) => { const c = tableKeys.get(n); if (c === null) return; if (k === null) { tableKeys.set(n, null); return; } if (c) c.add(k); else tableKeys.set(n, new Set([k])); };
  const forKeyNodes = new Map<A.NameExpr, string>();   // uses of a loop key variable -> the table iterated
  {
    const st: any[] = [chunk];
    while (st.length) {
      const x = st.pop(); if (!x || typeof x !== 'object') continue;
      if (Array.isArray(x)) { for (const y of x) st.push(y); continue; }
      if (x.type === 'AssignStat' && !x.op) x.targets.forEach((t: A.Expr, i: number) => {
        const u = unparen(t);
        if (u.type === 'IndexExpr' && unparen(u.obj).type === 'NameExpr') { const v = x.values[i]; if (!(v && unparen(v).type === 'NilLit')) addKey((unparen(u.obj) as A.NameExpr).name, keyLit(u.index)); }
        if (u.type === 'NameExpr') { const v = x.values[i] ? unparen(x.values[i]) : null; if (v && v.type === 'TableExpr') { let n = 0; for (const f of v.fields) { if (f.kind === 'item') addKey(u.name, keyStr(++n)); else if (f.kind === 'named' && f.name !== undefined) addKey(u.name, keyStr(f.name)); else if (f.key) addKey(u.name, keyLit(f.key)); } } }
      });
      if (x.type === 'LocalStat') x.names.forEach((n: string, i: number) => { const v = x.init[i] ? unparen(x.init[i]) : null; if (v && v.type === 'TableExpr') { let c = 0; for (const f of v.fields) { if (f.kind === 'item') addKey(n, keyStr(++c)); else if (f.kind === 'named' && f.name !== undefined) addKey(n, keyStr(f.name)); else if (f.key) addKey(n, keyLit(f.key)); } } });
      if (x.type === 'GenericForStat') {
        const it = x.iters.map((e: A.Expr) => unparen(e));
        let t: string | null = null;
        if (it.length === 1 && it[0].type === 'NameExpr') t = it[0].name;
        else if (it.length === 1 && it[0].type === 'CallExpr' && unparen(it[0].callee).type === 'NameExpr' && (unparen(it[0].callee) as A.NameExpr).name === 'pairs' && it[0].args.length === 1 && unparen(it[0].args[0]).type === 'NameExpr') t = (unparen(it[0].args[0]) as A.NameExpr).name;
        else if (it.length === 2 && it[0].type === 'NameExpr' && it[0].name === 'next' && it[1].type === 'NameExpr') t = it[1].name;
        if (t !== null) {
          // the key variable's uses in the body (up to a re-declaration; assigned there: unknown)
          const kv = x.names[0]; const nodes: A.NameExpr[] = []; let bad = false;
          const w = (y: any) => {
            if (!y || typeof y !== 'object' || bad) return;
            if (Array.isArray(y)) { for (const z of y) w(z); return; }
            if ((y.type === 'LocalStat' && y.names.includes(kv)) || (y.type === 'GenericForStat' && y.names.includes(kv)) || (y.type === 'NumericForStat' && y.var === kv) || (y.type === 'FunctionExpr' && y.params.includes(kv)) || (y.type === 'LocalFunctionStat' && y.name === kv)) { if (y.type === 'LocalStat') for (const e of y.init) w(e); return; }
            if (y.type === 'AssignStat') for (const tg of y.targets) if (unparen(tg).type === 'NameExpr' && (unparen(tg) as A.NameExpr).name === kv) bad = true;
            if (y.type === 'NameExpr' && y.name === kv) nodes.push(y);
            for (const k of Object.keys(y)) if (k !== 'loc') w(y[k]);
          };
          w(x.body);
          if (!bad) for (const n of nodes) forKeyNodes.set(n, t);
        }
      }
      for (const k of Object.keys(x)) if (k !== 'loc') st.push(x[k]);
    }
  }
  /** the keys an index expression may denote (null: any) */
  const keysOf = (e: A.Expr): Set<string> | null => {
    const l = keyLit(e); if (l !== null) return new Set([l]);
    const u = unparen(e);
    if (u.type === 'NameExpr') { const t = forKeyNodes.get(u); if (t && fresh(t)) { const ks = tableKeys.get(t); if (ks) return ks; } }
    return null;
  };
  // ---- contexts
  const shared = new Map<string, Set<string> | 'all'>();
  const share = (n: string, k: string | null) => { const cur = shared.get(n); if (cur === 'all') return; if (k === null) { shared.set(n, 'all'); return; } if (cur) cur.add(k); else shared.set(n, new Set([k])); };
  const escaped = new Set<string>();
  const valueUses: A.Expr[] = [];
  const copies: Array<{ target: A.Expr; value: A.Expr }> = [];
  type Ctx = 'value' | 'base' | 'copy' | 'harmless';
  const keyTextOf = (e: A.Expr): string | null => { const l = litOf(e); return l.ok && (typeof l.v === 'number' || typeof l.v === 'string') ? keyStr(l.v) : null; };
  const visitE = (e: A.Expr | undefined, ctx: Ctx): void => {
    if (!e) return;
    switch (e.type) {
      case 'ParenExpr': visitE(e.expr, ctx); return;
      case 'NameExpr': {
        const t = recOf(e);
        if (t !== null) { if (ctx === 'value') { escaped.add(t); why?.(t, 'value use', e); } return; }
        if (fresh(e.name)) { if (ctx === 'value' || ctx === 'copy') { share(e.name, null); why?.('~' + e.name, 'shared (' + ctx + ')', e); } return; }
        if (ctx === 'value') valueUses.push(e);
        return;
      }
      case 'IndexExpr': visitE(e.obj, 'base'); visitE(e.index, 'value'); if (ctx === 'value') valueUses.push(e); return;
      case 'MemberExpr': visitE(e.obj, 'base'); if (ctx === 'value') valueUses.push(e); return;
      case 'CallExpr': {
        const pr = pureReader?.(e.callee) ?? null;
        visitE(e.callee, 'value');
        // a fresh table handed to a pure reader stays private (its fields are checked at the call)
        e.args.forEach((a, i) => { const u = unparen(a); if (pr && pr.has(i) && u.type === 'NameExpr' && fresh(u.name)) return; visitE(a, 'value'); });
        return;
      }
      case 'MethodCallExpr': visitE(e.obj, 'value'); for (const a of e.args) visitE(a, 'value'); return;
      case 'BinExpr': if (e.op === 'and' || e.op === 'or') { visitE(e.left, ctx); visitE(e.right, ctx); } else { visitE(e.left, 'harmless'); visitE(e.right, 'harmless'); } return;
      case 'UnExpr': visitE(e.expr, 'harmless'); return;
      case 'TableExpr': {
        // reference pair {[1] = r, [2] = T}: T shared at r only
        if (e.fields.length === 2) {
          const f1 = e.fields.find(f => f.kind === 'keyed' && f.key && keyTextOf(f.key) === '1'), f2 = e.fields.find(f => f.kind === 'keyed' && f.key && keyTextOf(f.key) === '2');
          const v2 = f2 ? unparen(f2.value) : null; const r = f1 ? keyTextOf(f1.value) : null;
          if (f1 && f2 && v2 && v2.type === 'NameExpr' && fresh(v2.name) && r !== null) { share(v2.name, r); return; }
        }
        for (const f of e.fields) { if (f.key) visitE(f.key, 'value'); visitE(f.value, 'value'); }
        return;
      }
      case 'FunctionExpr': visitS(e.body); return;
      case 'InterpExpr': for (const p of e.parts) if (p.kind === 'expr') visitE(p.expr, 'harmless'); return;
      case 'IfExpr': for (const c of e.clauses) { visitE(c.cond, 'harmless'); visitE(c.value, ctx); } visitE(e.elseValue, ctx); return;
      default: return;
    }
  };
  const visitTarget = (t: A.Expr) => { const u = unparen(t); if (u.type === 'IndexExpr') { visitE(u.obj, 'base'); visitE(u.index, 'value'); } else if (u.type === 'MemberExpr') visitE(u.obj, 'base'); };
  const visitS = (body: A.Stat[]): void => {
    for (const s of body) switch (s.type) {
      case 'LocalStat': s.init.forEach((e, i) => { visitE(e, i < s.names.length ? 'copy' : 'value'); if (i < s.names.length) copies.push({ target: { type: 'NameExpr', name: s.names[i] }, value: e }); }); break;
      case 'AssignStat':
        s.targets.forEach(visitTarget);
        if (s.op) { for (const v of s.values) visitE(v, 'harmless'); break; }
        s.values.forEach((e, i) => { visitE(e, i < s.targets.length ? 'copy' : 'value'); if (i < s.targets.length) copies.push({ target: s.targets[i], value: e }); });
        break;
      case 'CallStat': visitE(s.expr, 'harmless'); break;
      case 'DoStat': visitS(s.body); break;
      case 'WhileStat': visitE(s.cond, 'harmless'); visitS(s.body); break;
      case 'RepeatStat': visitS(s.body); visitE(s.cond, 'harmless'); break;
      case 'IfStat': for (const c of s.clauses) { visitE(c.cond, 'harmless'); visitS(c.body); } if (s.elseBody) visitS(s.elseBody); break;
      case 'NumericForStat': visitE(s.from, 'harmless'); visitE(s.to, 'harmless'); visitE(s.step, 'harmless'); visitS(s.body); break;
      case 'GenericForStat': for (const e of s.iters) visitE(e, 'value'); visitS(s.body); break;
      case 'ReturnStat': for (const e of s.args) visitE(e, 'value'); break;
      case 'FunctionStat': visitTarget(s.target); visitS(s.func.body); break;
      case 'LocalFunctionStat': visitS(s.func.body); break;
      default: break;
    }
  };
  visitS(chunk.body);
  // ---- may-hold fixpoint
  const MH = new Map<string, Set<string>>();                    // name -> records it may hold
  const MHF = new Map<string, Map<string, Set<string>>>();      // fresh table -> key text / '*' -> records
  const EMPTY = new Set<string>();
  const fieldsOf = (n: string, ks: Set<string> | null): Set<string> => {
    const m = MHF.get(n); if (!m) return EMPTY;
    const out = new Set<string>();
    if (ks === null) { for (const ts of m.values()) for (const t of ts) out.add(t); return out; }
    for (const k of [...ks, '*']) { const a = m.get(k); if (a) for (const t of a) out.add(t); }
    return out;
  };
  const R = (e: A.Expr): Set<string> => {
    const u = unparen(e);
    if (u.type === 'NameExpr') { const t = recOf(u); return t !== null ? new Set([t]) : (MH.get(u.name) ?? EMPTY); }
    if (u.type === 'IndexExpr' || u.type === 'MemberExpr') { const o = unparen(u.obj); return o.type === 'NameExpr' && fresh(o.name) ? fieldsOf(o.name, u.type === 'MemberExpr' ? new Set([keyStr(u.name)]) : keysOf(u.index)) : EMPTY; }
    if (u.type === 'BinExpr' && (u.op === 'and' || u.op === 'or')) { const a = R(u.left), b = R(u.right); return a.size ? (b.size ? new Set([...a, ...b]) : a) : b; }
    return EMPTY;
  };
  const addTo = (c: Set<string>, r: Set<string>): boolean => { const n = c.size; for (const t of r) c.add(t); return c.size !== n; };
  for (let changed = true, guard = 0; changed && guard < 100; guard++) {
    changed = false;
    for (const { target, value } of copies) {
      const r = R(value); if (!r.size) continue;
      const u = unparen(target);
      if (u.type === 'NameExpr') { let c = MH.get(u.name); if (!c) MH.set(u.name, c = new Set()); if (addTo(c, r)) changed = true; continue; }
      if (u.type === 'IndexExpr' || u.type === 'MemberExpr') {
        const o = unparen(u.obj);
        const k = u.type === 'MemberExpr' ? keyStr(u.name) : keyTextOf(u.index);
        if (o.type === 'NameExpr' && fresh(o.name)) {
          const sh = shared.get(o.name);
          if (!sh || (sh !== 'all' && k !== null && !sh.has(k))) { let m = MHF.get(o.name); if (!m) MHF.set(o.name, m = new Map()); let c = m.get(k ?? '*'); if (!c) m.set(k ?? '*', c = new Set()); if (addTo(c, r)) changed = true; continue; }
        }
      }
      for (const t of r) if (!escaped.has(t)) { escaped.add(t); changed = true; why?.(t, 'stored into ' + (u.type === 'IndexExpr' || u.type === 'MemberExpr' ? (unparen(u.obj).type === 'NameExpr' ? (unparen(u.obj) as A.NameExpr).name + (fresh((unparen(u.obj) as A.NameExpr).name) ? ' (fresh, shared)' : ' (not fresh)') : 'a computed table') : u.type), target); }
    }
  }
  for (const u of valueUses) for (const t of R(u)) { if (!escaped.has(t)) why?.(t, 'value use of a holder', u); escaped.add(t); }
  return {
    escaped, may: R,
    fields: (n) => fresh(n) && shared.get(n) !== 'all' ? (MHF.get(n) ?? new Map()) : null,
    sharedKeys: (n) => { const sh = shared.get(n); return fresh(n) && sh !== 'all' ? (sh ?? new Set()) : null; },
  };
}

export interface ResolveReport { resolved: number; remaining: number; dropped: number; notes: string[]; }
export interface ResolveOptions {
  /** residual record name -> dump table id (K_n / PROTO_n) */
  recordId: (name: string) => string | null;
  /** closure creation site -> created proto id */
  createdProto?: (call: A.CallExpr) => string | null;
  /** the dump value of a record slot before the program runs (`ok` false: not a literal / unknown);
   *  without it no one-time patch flag implies anything (a flag already holding its value says nothing) */
  initial?: (tid: string, key: Lit) => { ok: boolean; v: Lit };
  /** argument positions a (non-library) callee only reads — e.g. the interpreter's unpack helpers */
  pureReader?: PureReader;
}
/** library functions that only read their table arguments (and do not keep them) */
export const LIB_READERS: Record<string, number[]> = { 'table.move': [0], 'table.unpack': [0], 'unpack': [0], 'rawlen': [0], 'rawget': [0], 'table.concat': [0], 'next': [0], 'ipairs': [0], 'pairs': [0], 'type': [0], 'typeof': [0], 'rawequal': [0, 1], 'table.find': [0] };
const printCallee = (e: A.Expr): string | null => { const u = unparen(e); if (u.type === 'NameExpr') return u.name; if (u.type === 'MemberExpr' && unparen(u.obj).type === 'NameExpr') return (unparen(u.obj) as A.NameExpr).name + '.' + u.name; if (u.type === 'IndexExpr' && unparen(u.obj).type === 'NameExpr' && unparen(u.index).type === 'StringLit') return (unparen(u.obj) as A.NameExpr).name + '.' + (unparen(u.index) as A.StringLit).value; return null; };
export const libReader: PureReader = (callee) => { const n = printCallee(callee); const r = n !== null ? LIB_READERS[n] : undefined; return r ? new Set(r) : null; };
const skParts = (sk: string): { tid: string; key: Lit; keyLit: string } => {
  const i = sk.indexOf('|'); const kp = sk.slice(i + 1);
  const key: Lit = kp.startsWith('n:') ? Number(kp.slice(2)) : kp.slice(2);
  return { tid: sk.slice(0, i), key, keyLit: JSON.stringify(key) };
};
/** structured code of all protos: resolve remaining patched reads, then drop stores into records no longer read */
export function resolvePatchedReads(protos: Array<{ id: string; chunk: A.Chunk }>, patches: PatchSpec[], o: ResolveOptions): ResolveReport {
  const rep: ResolveReport = { resolved: 0, remaining: 0, dropped: 0, notes: [] };
  const model = new PatchModel(patches);
  const remainingBy = new Map<string, number>();
  const escaped = new Set<string>();
  // creation order (parents first)
  const created = new Map<string, Set<string>>();
  const scanCalls = (node: any, fn: (c: A.CallExpr) => void) => { const st: any[] = [node]; while (st.length) { const x = st.pop(); if (!x || typeof x !== 'object') continue; if (Array.isArray(x)) { for (const y of x) st.push(y); continue; } if (x.type === 'CallExpr') fn(x); for (const k of Object.keys(x)) if (k !== 'loc') st.push(x[k]); } };
  for (const p of protos) { const s = new Set<string>(); if (o.createdProto) scanCalls(p.chunk, (c) => { const id = o.createdProto!(c); if (id !== null) s.add(id); }); created.set(p.id, s); }
  const order = creationOrder(protos.map(p => p.id), created);
  const byId = new Map(protos.map(p => [p.id, p]));
  const capturedBy = new Map(protos.map(p => [p.id, capturedNames(p.chunk)]));
  const reader: PureReader = (c) => libReader(c) ?? o.pureReader?.(c) ?? null;
  const flows = new Map(protos.map(p => [p.id, recordFlow(p.chunk, o.recordId, (t) => model.tables.has(t), reader)]));
  const flowEscaped = new Set<string>(); for (const f of flows.values()) for (const t of f.escaped) flowEscaped.add(t);
  /** what a (non-mutating) analysis of the whole program under some implications observed */
  interface Seen { runs: Map<string, Known>; escaped: Set<string>; unknown: Map<string, Set<string>>; }
  const run = (mutate: boolean, implied: Map<string, Known>, seen?: Seen) => {
    const entry = new Map<string, Known>();
    for (const { id, cyclic } of order) {
      const p = byId.get(id)!;
      const fl = flows.get(id)!;
      const an = makeAnalyzer({ model, recordId: o.recordId, createdProto: o.createdProto, mutate, captured: capturedBy.get(id),
        readerCall: reader, privateFields: (n) => { const f = fl.fields(n); return f ? { fields: f, shared: fl.sharedKeys(n) ?? new Set() } : null; }, mayRecords: fl.may,
        onRead: mutate ? (t, ok) => { if (ok) rep.resolved++; else { rep.remaining++; remainingBy.set(t, (remainingBy.get(t) ?? 0) + 1); } } : undefined,
        onEscape: seen ? (t) => seen.escaped.add(t) : undefined,
        onUnknownRead: mutate ? (base) => { for (const t of flows.get(id)!.may(base)) remainingBy.set(t, (remainingBy.get(t) ?? 0) + 1); } : undefined,
        implied: implied.size ? (tid, key, lit) => implied.get(slotKey(tid, key) + '=' + JSON.stringify(lit)) ?? null : undefined,
        onRunStore: seen ? (sk, lit, after) => { const kk = sk + '=' + JSON.stringify(lit); const prev = seen.runs.get(kk); seen.runs.set(kk, prev ? intersect(prev, after) : new Map(after)); } : undefined,
        // a store through a location that may hold a record (an alias the must-analysis lost)
        onUnknownStore: seen ? (key, value, base) => { const ks = (key.ok ? JSON.stringify(key.v) : '*') + '=' + (value.ok ? JSON.stringify(value.v) : '*'); for (const t of flows.get(id)!.may(base)) { let u = seen.unknown.get(t); if (!u) seen.unknown.set(t, u = new Set()); u.add(ks); } } : undefined,
        onCreate: (pid, k) => { const prev = entry.get(pid); entry.set(pid, prev ? intersect(prev, k) : k); } });
      an.list(p.chunk.body, an.fresh(cyclic ? new Map() : (entry.get(id) ?? new Map())));
    }
  };
  // guard implications: a true guard `slot == v` (a one-time patch flag) implies the single-valued slots
  // known at the end of the straight-line run of every store writing v (the patch chain the flag closes).
  // F(I): the implications observed under the implications I — from the stores reachable under I, for flags
  // whose dump value is known and differs from v, in records that never escape, and with no store into an
  // unknown table (key / value matching) in a proto holding a copy of the record. An implication set with
  // I ⊆ F(I) justifies itself: the first read at run time contradicting it would follow a store that was
  // reachable under it. Growth (I := F(I)) proposes, a descending verification (I := I ∩ F(I)) disposes.
  let lastSeen: Seen | null = null, lastImplied: Map<string, Known> | null = null;
  const observe = (implied: Map<string, Known>, optimistic = false): Map<string, Known> => {
    const seen: Seen = { runs: new Map(), escaped: new Set(), unknown: new Map() };
    run(false, implied, seen);
    lastSeen = seen; lastImplied = implied;
    const out = new Map<string, Known>();
    const trace = devEnv('PRISM_IMPL_TRACE');
    const why = new Map<string, number>();
    const drop = (r: string) => why.set(r, (why.get(r) ?? 0) + 1);
    for (const [kk, m] of seen.runs) {
      const sk = kk.slice(0, kk.indexOf('=')); const litS = kk.slice(kk.indexOf('=') + 1); const lit = JSON.parse(litS) as Lit;
      if (!model.single(sk)) { drop('multi-valued'); continue; }
      const { tid, key, keyLit } = skParts(sk);
      if (seen.escaped.has(tid) || flowEscaped.has(tid)) { drop('escaped'); continue; }
      const iv = o.initial?.(tid, key);
      if (!iv || !iv.ok || iv.v === lit) { drop(iv && iv.ok ? 'initially set' : 'initial unknown'); continue; }
      const u = seen.unknown.get(tid);
      if (!optimistic && u && (u.has(keyLit + '=' + litS) || u.has(keyLit + '=*') || u.has('*=' + litS) || u.has('*=*'))) { drop('aliased store'); continue; }
      const mm = new Map(m); mm.delete(sk);
      if (mm.size) out.set(kk, mm);
    }
    if (trace !== undefined) { console.error(`[impl] observed ${out.size} implication(s); dropped: ${[...why].map(([r, n]) => r + ' ' + n).join(', ')}; escaped ${new Set([...seen.escaped, ...flowEscaped]).size} record(s), aliased stores into ${seen.unknown.size}`); for (const [kk, mm] of out) if (trace && kk.startsWith(trace)) console.error('  ', kk, [...mm].slice(0, 12).map(([x, y]) => x + '=' + y).join(' ')); }
    return out;
  };
  const sameK = (a: Map<string, Known>, b: Map<string, Known>) => a.size === b.size && [...a].every(([k, v]) => { const w = b.get(k); return !!w && w.size === v.size && [...v].every(([x, y]) => w.get(x) === y); });
  let implied = new Map<string, Known>();
  let phases = 0;
  if (model.slots.size && o.initial) {
    // growth: until stable (bounded)
    // (optimistic: a store through an unknown table may be unreachable under the implications themselves —
    // a decoy chain behind a guard they decide; the verification below drops what it does not justify)
    for (let g = 0; g < 8; g++) { phases++; const next = observe(implied, true); if (sameK(next, implied)) break; implied = next; }
    // verification: strictly descending until self-justified (always terminates)
    for (let d = 0; d < 64; d++) {
      phases++;
      const f = observe(implied);
      const next = new Map<string, Known>();
      for (const [kk, m] of implied) { const w = f.get(kk); if (!w) continue; const x = intersect(m, w); if (x.size) next.set(kk, x); }
      if (sameK(next, implied)) break;
      implied = next;
      if (d === 63) implied = new Map();   // (unreachable in practice) not verified: use nothing
    }
  }
  // the escapes under the final implications (observed: loops iterated for the may-records)
  if (lastImplied !== implied || !lastSeen) { const seen: Seen = { runs: new Map(), escaped: new Set(), unknown: new Map() }; run(false, implied, seen); lastSeen = seen; }
  for (const t of (lastSeen as Seen).escaped) escaped.add(t);
  run(true, implied);
  const usedImplications = [...implied.values()].reduce((a, m) => a + m.size, 0);
  if (usedImplications) rep.notes.push(`one-time patch flags: ${implied.size} guard value(s) imply ${usedImplications} slot value(s) (the slots the patch chain closed by the flag always writes; verified self-consistent in ${phases} analysis phase(s))`);
  for (const t of flowEscaped) escaped.add(t);
  const dead = new Set([...model.tables].filter(t => !remainingBy.get(t) && !escaped.has(t)));
  if (dead.size) for (const p of protos) rep.dropped += dropStores(p.chunk, dead, o.recordId);
  rep.notes.push(`patched-slot reads in the structured code: ${rep.resolved} resolved, ${rep.remaining} still read at run time${remainingBy.size ? ' (' + [...remainingBy].sort((a, b) => b[1] - a[1]).slice(0, 12).map(([t, n]) => `K_${t}×${n}`).join(', ') + ')' : ''}`);
  if (rep.dropped) rep.notes.push(`${rep.dropped} store(s) into ${dead.size} record(s) that are never read any more removed`);
  if (escaped.size) rep.notes.push(`patched record(s) escaping into calls/tables (kept): ${[...escaped].slice(0, 12).map(t => 'K_' + t).join(', ')}`);
  return rep;
}

/** topological order of the closure-creation graph (parents first); members of cycles last, flagged */
export function creationOrder(ids: string[], created: Map<string, Set<string>>): Array<{ id: string; cyclic: boolean }> {
  const set = new Set(ids);
  const indeg = new Map(ids.map(id => [id, 0]));
  for (const [p, cs] of created) if (set.has(p)) for (const c of cs) if (set.has(c) && c !== p) indeg.set(c, indeg.get(c)! + 1);
  const queue = ids.filter(id => indeg.get(id) === 0);
  const out: Array<{ id: string; cyclic: boolean }> = []; const done = new Set<string>();
  while (queue.length) { const id = queue.shift()!; if (done.has(id)) continue; done.add(id); out.push({ id, cyclic: false }); for (const c of created.get(id) ?? []) { if (!set.has(c) || c === id) continue; indeg.set(c, indeg.get(c)! - 1); if (indeg.get(c) === 0) queue.push(c); } }
  for (const id of ids) if (!done.has(id)) out.push({ id, cyclic: true });
  return out;
}

/** remove `R[k] = v` stores (direct or through a straight-line holder) into dead records; values must be side-effect free */
function dropStores(chunk: A.Chunk, dead: Set<string>, recordId: (n: string) => string | null): number {
  let n = 0;
  const pure = (e: A.Expr): boolean => { const u = unparen(e); switch (u.type) { case 'NumberLit': case 'StringLit': case 'NilLit': case 'TrueLit': case 'FalseLit': case 'NameExpr': return true; case 'UnExpr': return pure(u.expr); case 'BinExpr': return pure(u.left) && pure(u.right); case 'IndexExpr': return pure(u.obj) && pure(u.index); default: return false; } };
  const fns = (x: any, top: boolean) => {
    if (!x || typeof x !== 'object') return;
    if (Array.isArray(x)) { for (const y of x) fns(y, top); return; }
    if (x.type === 'FunctionExpr') { x.body = list(x.body, new Map()); return; }
    for (const k of Object.keys(x)) { if (k === 'loc') continue; if (top && (k === 'body' || k === 'elseBody')) continue; if (top && k === 'clauses') { for (const c of x.clauses) fns(c.cond, false); continue; } fns(x[k], false); }
  };
  const list = (stmts: A.Stat[], holders: Map<string, string>): A.Stat[] => {
    const out: A.Stat[] = [];
    for (const s of stmts) {
      if (s.type === 'AssignStat' && !s.op && s.targets.length === 1 && s.values.length === 1) {
        const t = unparen(s.targets[0]);
        if (t.type === 'IndexExpr') {
          const ob = unparen(t.obj);
          const tk0 = trackKey(ob);
          const tid = (ob.type === 'NameExpr' ? recordId(ob.name) : null) ?? (tk0 !== null ? holders.get(tk0) ?? null : null);
          if (tid !== null && dead.has(tid) && pure(s.values[0]) && pure(t.index)) { n++; continue; }
        }
        const tk = trackKey(t);
        if (tk !== null) {
          for (const k of [...holders.keys()]) if (k === tk || k.startsWith(tk + '[')) holders.delete(k);
          const v = unparen(s.values[0]);
          const rid = v.type === 'NameExpr' ? recordId(v.name) : null;
          if (rid !== null) holders.set(tk, rid);
        } else holders.clear();
        fns(s, true);
        if (s.values.some(v => JSON.stringify(v).includes('"CallExpr"'))) holders.clear();
        out.push(s); continue;
      }
      if (s.type === 'AssignStat' || s.type === 'LocalStat' || s.type === 'CallStat' || s.type === 'ReturnStat') { holders.clear(); fns(s, true); out.push(s); continue; }
      const x: any = s;
      if (Array.isArray(x.body)) x.body = list(x.body, new Map());
      if (x.clauses) for (const c of x.clauses) c.body = list(c.body, new Map());
      if (x.elseBody) x.elseBody = list(x.elseBody, new Map());
      if (x.func) x.func.body = list(x.func.body, new Map());
      holders.clear();
      fns(s, true);
      out.push(s);
    }
    return out;
  };
  chunk.body = list(chunk.body, new Map());
  return n;
}

// ---------------------------------------------------------------- one-time patch trampolines
/** A jump whose target slot is patched, `if S == w then pc = T else pc = P end`, where the chain from P only
 *  writes dump records / scratch registers and ends at T (pattern A), or a patched instruction whose decoy
 *  jumps to such a chain that returns to the instruction (pattern B). The program runs the chain once and
 *  then takes the patched path; the chain's stores are idempotent (single-valued), so the jump can always
 *  run the chain: the guard disappears and the stores dominate every later read. The chain's scratch-register
 *  writes are assumed dead at the join (they are on the patched path the program itself takes). */
export function foldTrampolines(blocks: Map<number, A.Stat[]>, model: PatchModel, recordId: (n: string) => string | null, pcVar: string): number {
  const isPc = (e: A.Expr | undefined) => !!e && unparen(e).type === 'NameExpr' && (unparen(e) as A.NameExpr).name === pcVar;
  const jumpOf = (s: A.Stat | undefined): number | null => {
    if (!s || s.type !== 'AssignStat' || s.op || s.targets.length !== 1 || !isPc(s.targets[0])) return null;
    const v = litOf(s.values[0]); return v.ok && typeof v.v === 'number' ? v.v : null;
  };
  const hasCode = (x: any): boolean => { let bad = false; const v = (y: any) => { if (bad || !y || typeof y !== 'object') return; if (Array.isArray(y)) { for (const z of y) v(z); return; } if (y.type === 'CallExpr' || y.type === 'MethodCallExpr' || y.type === 'FunctionExpr' || y.type === 'VarargLit' || y.type === 'ReturnStat' || y.type === 'BreakStat' || y.type === 'ContinueStat' || y.type === 'GotoStat' || y.type === 'WhileStat' || y.type === 'RepeatStat' || y.type === 'GenericForStat' || y.type === 'IfStat') { bad = true; return; } for (const k of Object.keys(y)) if (k !== 'loc') v(y[k]); }; v(x); return bad; };
  /** block = patch-only statements + final `pc = K`; returns K (stores recorded) */
  const patchOnly = (stmts: A.Stat[], stored: Map<string, Lit>): number | null => {
    if (!stmts.length) return null;
    const target = jumpOf(stmts[stmts.length - 1]);
    if (target === null) return null;
    const body = stmts.slice(0, -1);
    if (hasCode(body)) return null;
    // register tables: bases of record-holder writes, and their aliases
    const regs = new Set<string>();
    const holderWrite = (s: any) => { if (s.type !== 'AssignStat' || s.targets.length !== 1) return; const t = unparen(s.targets[0]); const v = s.values[0] ? unparen(s.values[0]) : undefined; if (t.type === 'IndexExpr' && unparen(t.obj).type === 'NameExpr' && v && v.type === 'NameExpr' && recordId(v.name) !== null) regs.add((unparen(t.obj) as A.NameExpr).name); };
    const all: any[] = []; const flat = (l: A.Stat[]) => { for (const s of l) { all.push(s); if (s.type === 'DoStat' || s.type === 'NumericForStat') flat(s.body); } }; flat(body);
    for (const s of all) holderWrite(s);
    if (!regs.size) return null;
    for (let i = 0; i < 3; i++) for (const s of all) if (s.type === 'AssignStat' && s.targets.length === 1 && s.values.length === 1) { const t = unparen(s.targets[0]), v = unparen(s.values[0]); if (t.type === 'NameExpr' && v.type === 'NameExpr' && regs.has(v.name)) regs.add(t.name); }
    const holders = new Map<string, string>();
    const lits = new Map<string, Lit>();
    const look = (k: string) => lits.has(k) ? { ok: true, v: lits.get(k)! } : { ok: false, v: null as Lit };
    const run = (l: A.Stat[]): boolean => {
      for (const s of l) {
        if (s.type === 'DoStat') { if (!run(s.body)) return false; continue; }
        if (s.type === 'NumericForStat') { lits.clear(); for (const k of [...holders.keys()]) holders.delete(k); if (!run(s.body)) return false; lits.clear(); holders.clear(); continue; }
        if (s.type !== 'AssignStat' || s.targets.length !== 1) return false;
        const t = unparen(s.targets[0]);
        if (isPc(t)) return false;
        const v = s.values[0];
        if (t.type === 'NameExpr') { if (regs.has(t.name) && !(v && unparen(v).type === 'NameExpr' && regs.has((unparen(v) as A.NameExpr).name))) return false; const tk = t.name; for (const k of [...lits.keys()]) if (k === tk || k.startsWith(tk + '[')) lits.delete(k); if (!s.op) { const l2 = evalLit(v, look); if (l2.ok) lits.set(tk, l2.v); } continue; }
        if (t.type !== 'IndexExpr') return false;
        const ob = unparen(t.obj);
        if (ob.type === 'NameExpr' && regs.has(ob.name)) {   // register write
          const tk = trackKey(t);
          if (tk !== null) {
            holders.delete(tk); lits.delete(tk);
            const vu = v ? unparen(v) : undefined;
            if (vu && vu.type === 'NameExpr' && recordId(vu.name) !== null && !s.op) holders.set(tk, recordId(vu.name)!);
            else if (!s.op) { const l2 = evalLit(v, look); if (l2.ok) lits.set(tk, l2.v); }
          } else { holders.clear(); lits.clear(); }
          continue;
        }
        const tk = trackKey(ob);
        const tid = tk !== null ? holders.get(tk) : undefined;
        if (tid === undefined || !model.tables.has(tid) || s.op) return false;   // a store into anything but a patched record
        const k = evalLit(t.index, look); const val = evalLit(v, look);
        if (!k.ok) return false;
        if (val.ok) stored.set(slotKey(tid, k.v), val.v);
      }
      return true;
    };
    return run(body) ? target : null;
  };
  const chain = (start: number, stop: number): { stored: Map<string, Lit>; last: number } | null => {
    const seen = new Set<number>(); let b = start; let last = start; const stored = new Map<string, Lit>();
    while (b !== stop) {
      if (seen.has(b) || seen.size > 24) return null; seen.add(b);
      const stmts = blocks.get(b); if (!stmts) return null;
      const r = stmts.length === 1 ? jumpOf(stmts[0]) ?? patchOnly(stmts, stored) : patchOnly(stmts, stored);
      if (r === null) return null;
      last = b; b = r;
    }
    return { stored, last };
  };
  const guardSlots = (cond: A.Expr): Array<[string, Lit]> | null => {
    const out: Array<[string, Lit]> = [];
    const flat = (e: A.Expr): boolean => {
      const u = unparen(e);
      if (u.type === 'BinExpr' && u.op === 'and') return flat(u.left) && flat(u.right);
      if (u.type !== 'BinExpr' || u.op !== '==') return false;
      let ix = unparen(u.left), lv = litOf(u.right);
      if (ix.type !== 'IndexExpr' || !lv.ok) { ix = unparen(u.right); lv = litOf(u.left); }
      if (ix.type !== 'IndexExpr' || !lv.ok) return false;
      const ob = unparen(ix.obj); if (ob.type !== 'NameExpr') return false;
      const tid = recordId(ob.name); const k = litOf(ix.index);
      if (tid === null || !k.ok) return false;
      const sk = slotKey(tid, k.v); const si = model.slots.get(sk);
      if (!si || !si.single || si.values[0] !== lv.v) return false;
      out.push([sk, lv.v]); return true;
    };
    return flat(cond) && out.length ? out : null;
  };
  let folded = 0;
  let nextKey = Math.max(0, ...blocks.keys()) + 1;
  for (const [x, stmts] of [...blocks]) {
    const last = stmts[stmts.length - 1];
    if (!last || last.type !== 'IfStat' || last.clauses.length !== 1 || !last.elseBody || last.elseBody.length !== 1) continue;
    const p = jumpOf(last.elseBody[0]); if (p === null) continue;
    const gs = guardSlots(last.clauses[0].cond); if (!gs) continue;
    const arm = last.clauses[0].body;
    const t = arm.length === 1 ? jumpOf(arm[0]) : null;
    if (t !== null && t !== x) {
      // pattern A: patched jump target; the chain from the decoy target ends at the patched target
      const c = chain(p, t);
      if (!c || !gs.every(([sk, v]) => c.stored.get(sk) === v)) continue;
      stmts[stmts.length - 1] = { type: 'AssignStat', targets: [{ type: 'NameExpr', name: pcVar }], values: [{ type: 'NumberLit', value: p, raw: String(p) }] };
      folded++; continue;
    }
    // pattern B: the chain returns to this instruction, which then runs its patched variant
    if (stmts.length !== 1) continue;
    const c = chain(p, x);
    if (!c || !gs.every(([sk, v]) => c.stored.get(sk) === v)) continue;
    const lastStmts = blocks.get(c.last)!;
    const k2 = nextKey++;
    blocks.set(k2, arm);
    lastStmts[lastStmts.length - 1] = { type: 'AssignStat', targets: [{ type: 'NameExpr', name: pcVar }], values: [{ type: 'NumberLit', value: k2, raw: String(k2) }] };
    blocks.set(x, [{ type: 'AssignStat', targets: [{ type: 'NameExpr', name: pcVar }], values: [{ type: 'NumberLit', value: p, raw: String(p) }] }]);
    folded++;
  }
  return folded;
}
