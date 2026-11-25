// Register-file promotion — universal, conservative.
//
//   local R = table.create(40)          local R = table.create(40)
//   R[3] = f(R[2]); g(R[3])        ->   local r2, r3; r3 = f(r2); g(r3)
//
// A local table that is used as a register file (initialised with `table.create(n)` or `{}`, never
// reassigned, not referenced from nested functions) has the slots it is only ever accessed through
// with literal indices turned into plain locals, so the usual propagation / dead-store / state-machine
// passes see them. Slots that can be reached in any other way stay in the table:
//   * upvalue cells `{[1] = n, [2] = R}` (another closure reads / writes slot n through the cell);
//   * ranges with a non-literal bound (`table.unpack(R, a, top)`, `for i = a, top do R[i] = … end`):
//     every slot from a upwards;
//   * `R[k]` with k a key of a generic-for over a local table whose keys are all literal (closing upvalue
//     cells): exactly those keys.
// `table.unpack(R, a, b)` with literal bounds becomes the list of the slots (one value when it is not the
// last expression of a list). A dead alias (`t = R` overwritten before any read) is harmless.
// The table itself may be passed to calls, directly or through slots that hold it (`R[n] = R`, followed by a
// forward may-alias analysis over the function's statement graph): around each such call statement the
// promoted slots are written back to the table before and reloaded after (the callee sees and may change
// the real register file; it is assumed not to keep the table for later use). Any other use of R (stored
// elsewhere, a live local alias, an unknown index) leaves the whole table untouched.
import type * as A from '../ast.js';
import { analyzeScopes, Binding, ScopeInfo } from '../analysis/scope.js';
import { devEnv } from '../env.js';

const unparen = (e: A.Expr): A.Expr => { while (e && e.type === 'ParenExpr') e = e.expr; return e; };
const intLit = (e: A.Expr | undefined): number | null => {
  if (!e) return null;
  const u = unparen(e);
  if (u.type === 'NumberLit' && Number.isInteger(u.value)) return u.value;
  if (u.type === 'UnExpr' && u.op === '-') { const v = unparen(u.expr); if (v.type === 'NumberLit' && Number.isInteger(v.value)) return -v.value; }
  return null;
};
const isMulti = (e: A.Expr | undefined) => !!e && (e.type === 'CallExpr' || e.type === 'MethodCallExpr' || e.type === 'VarargLit');
const calleeName = (c: A.Expr): string => {
  const u = unparen(c);
  if (u.type === 'NameExpr') return u.name;
  if (u.type === 'MemberExpr' && unparen(u.obj).type === 'NameExpr') return (unparen(u.obj) as A.NameExpr).name + '.' + u.name;
  if (u.type === 'IndexExpr' && unparen(u.obj).type === 'NameExpr' && unparen(u.index).type === 'StringLit') return (unparen(u.obj) as A.NameExpr).name + '.' + (unparen(u.index) as A.StringLit).value;
  return '';
};

interface Link { parent: any; key: string; index: number; }
function parentLinks(root: any): Map<any, Link> {
  const m = new Map<any, Link>();
  const visit = (node: any) => {
    for (const k of Object.keys(node)) {
      if (k === 'loc' || k === 'type') continue;
      const v = node[k];
      if (Array.isArray(v)) v.forEach((el, i) => { if (el && typeof el === 'object') { m.set(el, { parent: node, key: k, index: i }); visit(el); } });
      else if (v && typeof v === 'object') { m.set(v, { parent: node, key: k, index: -1 }); visit(v); }
    }
  };
  visit(root);
  return m;
}

export interface PromoteOptions {
  /** most locals a function may hold after promotion (Luau: 200) */
  maxLocals?: number;
}
export interface PromoteResult { promoted: number; tables: number; notes: string[]; }

/**
 * Table accesses of the write-back / reload statements around calls that receive the register table carry
 * this mark (it survives cloning): their slots stay in the table from then on.
 */
const SYNC = 'prismSync';
const isSync = (ix: any) => !!ix && ix[SYNC] === true;

/** `table.move(R, a, b, t, dst)` statements copying out of a register table that never escapes, with literal bounds
 *  (the VM's SETLIST / multiple-results copy): the explicit stores `dst[t+i] = R[a+i]` — the moved slots stay
 *  promotable and the stores can be rebuilt into a table constructor. R never escapes, so dst is another table. */
function expandTableMoves(chunk: A.Chunk): number {
  const scope = analyzeScopes(chunk);
  const links = parentLinks(chunk);
  const num = (v: number): A.NumberLit => ({ type: 'NumberLit', value: v, raw: String(v) });
  let count = 0;
  for (const b of scope.bindings) {
    if (b.kind !== 'local' || !b.init || b.writeRefs.length || b.captured) continue;
    const init = unparen(b.init);
    const fresh = (init.type === 'CallExpr' && calleeName(init.callee) === 'table.create') || (init.type === 'TableExpr' && init.fields.length === 0);
    if (!fresh) continue;
    const moves: A.CallExpr[] = [];
    let escapes = false;
    for (const r of b.refs) {
      const l = links.get(r); if (!l) { escapes = true; break; }
      const p = l.parent;
      if (p.type === 'IndexExpr' && l.key === 'obj') continue;
      if (p.type === 'CallExpr' && l.key === 'args' && l.index === 0 && /^(?:table\.)?unpack$/.test(calleeName(p.callee))) continue;
      if (p.type === 'CallExpr' && l.key === 'args' && calleeName(p.callee) === 'table.move' && (l.index === 0 || l.index === 4)) { if (l.index === 0) moves.push(p); continue; }
      escapes = true; break;
    }
    if (escapes) continue;
    for (const call of moves) {
      if (call.args.length !== 5) continue;
      const a = intLit(call.args[1]), z = intLit(call.args[2]), t = intLit(call.args[3]);
      const dst = unparen(call.args[4]);
      if (a === null || z === null || t === null || a < 0 || t < 0 || z < a || z - a >= 64) continue;
      if (dst.type !== 'NameExpr' || dst.name === b.name) continue;
      const cl = links.get(call); if (!cl || cl.key !== 'expr') continue;
      const st = cl.parent; if (st.type !== 'CallStat') continue;
      const sl = links.get(st); if (!sl || sl.index < 0 || !Array.isArray(sl.parent[sl.key])) continue;
      const list = sl.parent[sl.key] as A.Stat[];
      const at = list.indexOf(st); if (at < 0) continue;
      const stores: A.Stat[] = [];
      for (let i = 0; i <= z - a; i++) stores.push({ type: 'AssignStat', targets: [{ type: 'IndexExpr', obj: { type: 'NameExpr', name: dst.name }, index: num(t + i) } as A.IndexExpr], values: [{ type: 'IndexExpr', obj: { type: 'NameExpr', name: b.name }, index: num(a + i) } as A.IndexExpr] } as A.AssignStat);
      list.splice(at, 1, ...stores);
      count++;
    }
  }
  return count;
}

export function promoteRegisters(chunk: A.Chunk, o: PromoteOptions = {}): PromoteResult {
  const maxLocals = o.maxLocals ?? 190;
  const res: PromoteResult = { promoted: 0, tables: 0, notes: [] };
  const moved = expandTableMoves(chunk);
  if (moved) res.notes.push(`${moved} table.move copy(ies) out of register tables expanded into explicit stores`);
  const scope: ScopeInfo = analyzeScopes(chunk);
  const links = parentLinks(chunk);
  const isTarget = (node: any): boolean => { const l = links.get(node); return !!l && l.parent.type === 'AssignStat' && l.key === 'targets'; };
  for (const b of scope.bindings) {
    if (b.kind !== 'local' || !b.init) continue;
    const init = unparen(b.init);
    const fresh = (init.type === 'CallExpr' && calleeName(init.callee) === 'table.create') || (init.type === 'TableExpr' && init.fields.length === 0);
    // (`table.create` returns exactly one value, so a last-position init is still just the table)
    if (!fresh || b.writeRefs.length || b.captured) continue;
    const why = analyzeTable(b);
    if (typeof why === 'string') { if (b.refs.length > 20 || devEnv('PRISM_PROMOTE_TRACE')) res.notes.push(`register table ${b.name}: not promoted (${why})`); continue; }
    const { uses, unsafe, minRange, unpacks, escapes } = why;
    // slots: used literally, not reachable otherwise; literal unpack ranges must be wholly promotable
    const ok = (n: number) => !unsafe.has(n) && n < minRange;
    // (a literal unpack range becomes a list of its slots: promoted ones as locals, the others as table reads)
    let slots = [...uses.keys()].filter(n => ok(n));
    // keep within the local-variable budget of the function: the most used slots first
    const fnLocals = maxActiveLocals(b.fn.body, b.fn.type === 'FunctionExpr' ? b.fn.params.length : 0);
    const room = Math.max(0, maxLocals - fnLocals);
    if (slots.length > room) {
      slots.sort((x, y) => uses.get(y)!.length - uses.get(x)!.length);
      slots = slots.slice(0, room);
      res.notes.push(`register table ${b.name}: ${slots.length} slot(s) promoted (local-variable budget)`);
    }
    if (!slots.length) continue;
    slots.sort((x, y) => x - y);
    const names = new Map<number, string>();
    for (const n of slots) {
      let nm = `${b.name}_${n < 0 ? 'm' + -n : n}`;
      while (scope.allNames.has(nm)) nm += '_';
      scope.allNames.add(nm);
      names.set(n, nm);
    }
    const nameExpr = (n: number): A.NameExpr => ({ type: 'NameExpr', name: names.get(n)! });
    // rewrite literal slot accesses
    for (const [n, list] of uses) {
      if (!names.has(n)) continue;
      for (const ix of list) {
        const l = links.get(ix)!;
        const ne = nameExpr(n);
        if (l.index >= 0) l.parent[l.key][l.index] = ne; else l.parent[l.key] = ne;
        links.set(ne, l);
      }
    }
    // literal unpack ranges -> slot lists
    const slotRead = (n: number): A.Expr => names.has(n) ? nameExpr(n) : { type: 'IndexExpr', obj: { type: 'NameExpr', name: b.name } as A.NameExpr, index: n < 0 ? { type: 'UnExpr', op: '-', expr: { type: 'NumberLit', value: -n, raw: String(-n) } } as A.UnExpr : { type: 'NumberLit', value: n, raw: String(n) } as A.NumberLit } as A.IndexExpr;
    for (const u of unpacks) {
      let anyPromoted = false;
      for (let n = u.a; n <= u.b; n++) if (names.has(n)) { anyPromoted = true; break; }
      if (!anyPromoted) continue;
      const l = links.get(u.call)!;
      const list: A.Expr[] = [];
      for (let n = u.a; n <= u.b; n++) list.push(slotRead(n));
      const inList = l.index >= 0 && ['args', 'values', 'init'].includes(l.key) && Array.isArray(l.parent[l.key]);
      const last = inList && l.index === l.parent[l.key].length - 1;
      const inTableLast = l.key === 'value' && l.parent.kind === 'item';
      if (last) l.parent[l.key].splice(l.index, 1, ...list);
      else if (inTableLast) {
        const tl = links.get(l.parent)!; const tab = tl.parent as A.TableExpr;
        const fi = tab.fields.indexOf(l.parent);
        if (fi === tab.fields.length - 1) tab.fields.splice(fi, 1, ...list.map(v => ({ kind: 'item' as const, value: v })));
        else l.parent.value = list[0] ?? { type: 'NilLit' };
      } else {
        const one: A.Expr = list[0] ?? { type: 'NilLit' };
        if (l.index >= 0) l.parent[l.key][l.index] = one; else l.parent[l.key] = one;
      }
    }
    // declare the new locals right after the table
    const decl = b.decl as A.LocalStat;
    const dl = links.get(decl);
    if (!dl || dl.index < 0) continue;
    const body = dl.parent[dl.key] as A.Stat[];
    const at = body.indexOf(decl);
    const ns = slots.map(n => names.get(n)!);
    const stmts: A.Stat[] = [];
    for (let i = 0; i < ns.length; i += 50) stmts.push({ type: 'LocalStat', names: ns.slice(i, i + 50), init: [] } as A.LocalStat);
    body.splice(at + 1, 0, ...stmts);
    // calls that receive the register table: write the promoted slots back before, reload them after
    if (escapes.size) {
      const tab = (): A.NameExpr => ({ type: 'NameExpr', name: b.name });
      const slotOf = (n: number): A.IndexExpr => { const ix: A.IndexExpr = { type: 'IndexExpr', obj: tab(), index: { type: 'NumberLit', value: n, raw: String(n) } as A.NumberLit } as A.IndexExpr; (ix as any)[SYNC] = true; return ix; };
      for (const st of escapes) {
        const sl = links.get(st); if (!sl || sl.index < 0) continue;
        const list = sl.parent[sl.key] as A.Stat[];
        const at2 = list.indexOf(st); if (at2 < 0) continue;
        const assigned = new Set<string>();
        if (st.type === 'AssignStat') for (const t of st.targets) { const u = unparen(t); if (u.type === 'NameExpr') assigned.add(u.name); }
        const spill: A.Stat[] = [];
        for (let i = 0; i < slots.length; i += 8) {
          const part = slots.slice(i, i + 8);
          spill.push({ type: 'AssignStat', targets: part.map(slotOf), values: part.map(nameExpr) } as A.AssignStat);
        }
        const reload: A.Stat[] = st.type === 'ReturnStat' ? [] : slots.filter(n => !assigned.has(names.get(n)!)).map(n => ({ type: 'AssignStat', targets: [nameExpr(n)], values: [slotOf(n)] } as A.AssignStat));
        list.splice(at2 + 1, 0, ...reload);
        list.splice(at2, 0, ...spill);
      }
      res.notes.push(`register table ${b.name}: passed to ${escapes.size} call statement(s) — the promoted slots are written back before and reloaded after each (the callee is assumed not to keep the table for later use)`);
    }
    res.promoted += slots.length; res.tables++;
    res.notes.push(`register table ${b.name}: ${slots.length} slot(s) promoted to locals${unsafe.size || minRange < Infinity ? ` (kept in the table: ${unsafe.size} cell/closing slot(s)${minRange < Infinity ? `, slots >= ${minRange} (dynamic ranges)` : ''})` : ''}`);
  }
  return res;

  function analyzeTable(b: Binding): string | { uses: Map<number, A.IndexExpr[]>; unsafe: Set<number>; minRange: number; unpacks: Array<{ call: A.CallExpr; a: number; b: number }>; escapes: Set<A.Stat> } {
    const uses = new Map<number, A.IndexExpr[]>();
    const unsafe = new Set<number>();
    let minRange = Infinity;
    const unpacks: Array<{ call: A.CallExpr; a: number; b: number }> = [];
    const escapes = new Set<A.Stat>();
    let selfStores = 0;
    const isR = (e: A.Expr | undefined): boolean => { const u = e && unparen(e); return !!u && u.type === 'NameExpr' && scope.refOf.get(u) === b; };
    for (const r of b.refs) {
      const l = links.get(r); if (!l) return 'unlinked reference';
      const p = l.parent;
      if (p.type === 'IndexExpr' && l.key === 'obj') {
        const n = intLit(p.index);
        if (n !== null) { if (isSync(p)) { unsafe.add(n); continue; } if (!uses.has(n)) uses.set(n, []); uses.get(n)!.push(p); continue; }
        const ix = unparen(p.index);
        if (ix.type === 'NameExpr') {
          const ib = scope.refOf.get(ix);
          if (ib && ib.kind === 'for' && ib.decl?.type === 'NumericForStat' && !ib.writeRefs.length) {
            const f = ib.decl as A.NumericForStat;
            const a = intLit(f.from), z = intLit(f.to), st = f.step ? intLit(f.step) : 1;
            if (a !== null && st === 1) { if (z !== null) { for (let q = a; q <= z && q - a < 4096; q++) unsafe.add(q); } else minRange = Math.min(minRange, a); continue; }
          }
          if (ib && ib.kind === 'for' && ib.decl?.type === 'GenericForStat' && ib.index === 0) {
            const keys = literalKeysOfIter(ib.decl as A.GenericForStat);
            if (keys) { for (const k of keys) unsafe.add(k); continue; }
          }
        }
        if (isTarget(p)) return 'store with a computed index: ' + shortExpr(p.index);
        return 'read with a computed index: ' + shortExpr(p.index);
      }
      if (p.type === 'CallExpr' && l.key === 'args' && l.index === 0 && /^(?:table\.)?unpack$/.test(calleeName(p.callee))) {
        const a = intLit(p.args[1]); const z = p.args.length > 2 ? intLit(p.args[2]) : null;
        if (a === null) return 'unpack from a computed index';
        if (z !== null && p.args.length === 3) { if (z - a > 250) return 'huge unpack range'; unpacks.push({ call: p, a, b: z }); continue; }
        minRange = Math.min(minRange, a); continue;
      }
      if (p.type === 'CallExpr' && l.key === 'args' && calleeName(p.callee) === 'table.move' && (l.index === 0 || l.index === 4)) {
        // table.move(src, a, b, t [, dst]): reads src[a..b], writes dst[t..t+b-a]
        const a = intLit(p.args[1]), z = intLit(p.args[2]), t = intLit(p.args[3]);
        const mark = (lo: number | null, n: number | null) => { if (lo === null) return false; if (n === null) { minRange = Math.min(minRange, lo); return true; } for (let q = lo; q <= lo + n && q - lo < 4096; q++) unsafe.add(q); return true; };
        const n = a !== null && z !== null ? z - a : null;
        let okm = true;
        if (l.index === 0) okm = mark(a, n);
        if (okm && (l.index === 4 || p.args.length < 5)) okm = mark(t, n);
        if (okm) continue;
        return 'table.move with computed bounds';
      }
      if (l.key === 'value' && p.kind === 'keyed') {
        // upvalue cell {[1] = n, [2] = R}
        const tl = links.get(p); const tab = tl?.parent as A.TableExpr | undefined;
        if (tab && tab.type === 'TableExpr') {
          const kv = intLit(p.key);
          const other = tab.fields.find(f => f !== p && f.kind === 'keyed' && intLit(f.key) !== null && intLit(f.key) !== kv);
          const slot = other ? intLit(other.value) : null;
          if (tab.fields.length === 2 && kv !== null && other && slot !== null) { unsafe.add(slot); continue; }
          if (tab.fields.length === 2 && kv !== null && other) return 'cell for a computed slot: ' + shortExpr(other.value);
        }
        return 'stored in a table';
      }
      // `R[n] = R`: slot n holds the table (followed by the may-alias analysis below)
      if (p.type === 'AssignStat' && l.key === 'values' && !p.op) {
        const t = p.targets[l.index] ? unparen(p.targets[l.index]) : null;
        if (t && t.type === 'IndexExpr' && isR(t.obj) && intLit(t.index) !== null) { selfStores++; continue; }
      }
      // alias `t = R`: harmless when overwritten before any read; a live local alias is followed like a slot
      if ((p.type === 'AssignStat' && l.key === 'values') || (p.type === 'LocalStat' && l.key === 'init')) {
        if (deadAlias(p, l.index)) continue;
        const tb = aliasTarget(p, l.index);
        if (tb && tb.fn === b.fn) { selfStores++; continue; }
        return 'live alias';
      }
      // passed to a call: the statement making the call syncs the promoted slots
      if ((p.type === 'CallExpr' || p.type === 'MethodCallExpr') && l.key === 'args') {
        const st = callStatement(p);
        if (st) { escapes.add(st); continue; }
        return 'passed to a call inside an expression';
      }
      return 'escapes (' + (p.type ?? p.kind ?? '?') + '.' + l.key + ')';
    }
    if (selfStores) {
      const reads = selfAliasReads(b, isR);
      if (typeof reads === 'string') return reads;
      for (const ix of reads) {
        const l = links.get(ix); if (!l) return 'unlinked alias read';
        const p = l.parent;
        if (p.type === 'AssignStat' && l.key === 'values' && !p.op) {
          const t = p.targets[l.index] ? unparen(p.targets[l.index]) : null;
          if (t && t.type === 'IndexExpr' && isR(t.obj) && intLit(t.index) !== null) continue;   // copied to another slot
          const tb = aliasTarget(p, l.index); if (tb && tb.fn === b.fn) continue;                  // … or local
          return 'a slot holding the table is copied elsewhere';
        }
        if (p.type === 'LocalStat' && l.key === 'init') { const tb = aliasTarget(p, l.index); if (tb && tb.fn === b.fn) continue; return 'a slot holding the table is copied elsewhere'; }
        if ((p.type === 'CallExpr' || p.type === 'MethodCallExpr') && l.key === 'args') {
          const st = callStatement(p);
          if (st) { escapes.add(st); continue; }
          return 'a slot holding the table is passed to a call inside an expression';
        }
        if (p.type === 'IndexExpr' && l.key === 'obj') {
          const k = intLit(p.index);
          if (k !== null) { unsafe.add(k); continue; }
          return 'the table is indexed with a computed key through a slot holding it';
        }
        return 'a slot holding the table is used as ' + (p.type ?? p.kind ?? '?') + '.' + l.key;
      }
    }
    for (const st of escapes) { const sl = links.get(st); if (!sl || sl.index < 0 || !Array.isArray(sl.parent[sl.key])) return 'passed to a call outside a statement list'; }
    return { uses, unsafe, minRange, unpacks, escapes };
  }
  /** the local (of any function) receiving value #idx of an assignment / local statement, when it is an uncaptured local */
  function aliasTarget(stmt: any, idx: number): Binding | null {
    let tb: Binding | undefined;
    if (stmt.type === 'AssignStat') { if (stmt.op) return null; const t = stmt.targets[idx] ? unparen(stmt.targets[idx]) : null; if (!t || t.type !== 'NameExpr') return null; if (idx === stmt.values.length - 1 && stmt.targets.length > stmt.values.length) return null; tb = scope.refOf.get(t); }
    else if (stmt.type === 'LocalStat') { if (idx === stmt.init.length - 1 && stmt.names.length > stmt.init.length) return null; tb = scope.bindings.find(x => x.decl === stmt && x.index === idx); }
    if (!tb || tb.kind !== 'local' || tb.captured) return null;
    return tb;
  }
  /** the statement whose evaluation is exactly this call (call statement, `x = f(…)`, `local x = f(…)`, `return f(…)`) */
  function callStatement(call: any): A.Stat | null {
    const l = links.get(call); if (!l) return null;
    const p = l.parent;
    if (p.type === 'CallStat' && l.key === 'expr') return p;
    if (p.type === 'AssignStat' && l.key === 'values' && p.values.length === 1 && !p.op) return p;
    if (p.type === 'LocalStat' && l.key === 'init' && p.init.length === 1) return p;
    if (p.type === 'ReturnStat' && l.key === 'args') return p;
    return null;
  }
  /**
   * Forward may-alias analysis over the statement graph of the function declaring R: which literal slots
   * may hold R itself (`R[n] = R`, `R[m] = R[n]`). Returns the slot reads `R[n]` that may yield R.
   */
  function selfAliasReads(b: Binding, isR: (e: A.Expr | undefined) => boolean): Array<A.IndexExpr | A.NameExpr> | string {
    const fn = b.fn;
    const body = (fn as any).body as A.Stat[];
    // tracked places: literal slots of R (numbers) and uncaptured locals of the function (bindings)
    const slotBits = new Map<number | Binding, number>();
    const bit = (k: number | Binding) => { let i = slotBits.get(k); if (i === undefined) { i = slotBits.size; slotBits.set(k, i); } return i; };
    const slotOf = (e: any): number | null => { const u = unparen(e); if (u && u.type === 'IndexExpr' && isR(u.obj)) { const n = intLit(u.index); if (n !== null) { bit(n); return n; } } return null; };
    const localOf = (e: any): Binding | null => { const u = unparen(e); if (u && u.type === 'NameExpr') { const lb = scope.refOf.get(u); if (lb && lb !== b && lb.kind === 'local' && !lb.captured && lb.fn === fn) { bit(lb); return lb; } } return null; };
    const placeOf = (e: any): number | Binding | null => slotOf(e) ?? localOf(e);
    interface FN { exprs: any[]; assign?: A.AssignStat; local?: A.LocalStat; kills?: Binding[]; succ: number[]; }
    const nodes: FN[] = [];
    const mk = (exprs: any[], assign?: A.AssignStat): number => { nodes.push({ exprs, assign, succ: [] }); return nodes.length - 1; };
    const forKills = (s: A.Stat): Binding[] => scope.bindings.filter(x => x.decl === s);
    interface Loop { brk: number; cont: number; }
    let bad: string | null = null;
    const seq = (stmts: A.Stat[], next: number, L: Loop | null): number => { let cur = next; for (let i = stmts.length - 1; i >= 0; i--) cur = stat(stmts[i], cur, L); return cur; };
    const stat = (s: A.Stat, next: number, L: Loop | null): number => {
      switch (s.type) {
        case 'AssignStat': {
          const ex: any[] = [...s.values];
          for (const t of s.targets) { const u = unparen(t); if (u.type === 'IndexExpr') { if (slotOf(u) === null) ex.push(u.obj, u.index); } else if (s.op) ex.push(u); }
          const n = mk(ex, s); nodes[n].succ.push(next); return n;
        }
        case 'LocalStat': { const n = mk(s.init); nodes[n].local = s; nodes[n].succ.push(next); return n; }
        case 'CallStat': { const n = mk([s.expr]); nodes[n].succ.push(next); return n; }
        case 'DoStat': return seq(s.body, next, L);
        case 'IfStat': {
          let alt = s.elseBody ? seq(s.elseBody, next, L) : next;
          for (let i = s.clauses.length - 1; i >= 0; i--) { const c = s.clauses[i]; const n = mk([c.cond]); nodes[n].succ.push(seq(c.body, next, L), alt); alt = n; }
          return alt;
        }
        case 'WhileStat': { const h = mk([s.cond]); const bd = seq(s.body, h, { brk: next, cont: h }); nodes[h].succ.push(bd, next); return h; }
        case 'RepeatStat': { const c = mk([s.cond]); const bd = seq(s.body, c, { brk: next, cont: c }); nodes[c].succ.push(next, bd); return bd; }
        case 'NumericForStat': { const init = mk([s.from, s.to, s.step]); const h = mk([]); nodes[h].kills = forKills(s); const bd = seq(s.body, h, { brk: next, cont: h }); nodes[h].succ.push(bd, next); nodes[init].succ.push(h); return init; }
        case 'GenericForStat': { const init = mk(s.iters); const h = mk([]); nodes[h].kills = forKills(s); const bd = seq(s.body, h, { brk: next, cont: h }); nodes[h].succ.push(bd, next); nodes[init].succ.push(h); return init; }
        case 'ReturnStat': return mk(s.args);
        case 'BreakStat': { const n = mk([]); if (L) nodes[n].succ.push(L.brk); return n; }
        case 'ContinueStat': { const n = mk([]); if (L) nodes[n].succ.push(L.cont); return n; }
        case 'GotoStat': case 'LabelStat': bad = 'goto in the function'; return mk([]);
        case 'FunctionStat': case 'LocalFunctionStat': { const n = mk([]); nodes[n].succ.push(next); return n; }
        default: { const n = mk([s]); nodes[n].succ.push(next); return n; }
      }
    };
    const exit = mk([]);
    const entry = seq(body, exit, null);
    if (bad) return bad;
    // all literal slots get a bit
    const visitExprs = (roots: any[], f: (ix: A.IndexExpr | A.NameExpr, k: number | Binding) => void) => {
      const v = (m: any) => {
        if (!m || typeof m !== 'object') return;
        if (Array.isArray(m)) { for (const x of m) v(x); return; }
        if (m.type === 'FunctionExpr') return;
        if (m.type === 'IndexExpr') { const n = slotOf(m); if (n !== null) { f(m, n); return; } }
        if (m.type === 'NameExpr') { const lb = localOf(m); if (lb) f(m, lb); return; }
        for (const k of Object.keys(m)) if (k !== 'loc') v(m[k]);
      };
      v(roots);
    };
    for (const nd of nodes) { visitExprs(nd.exprs, () => {}); if (nd.assign) for (const t of nd.assign.targets) placeOf(t); if (nd.local) for (const x of scope.bindings.filter(y => y.decl === nd.local)) if (x.kind === 'local' && !x.captured) bit(x); }
    const W = Math.max(1, Math.ceil(slotBits.size / 32));
    const N = nodes.length;
    const inS = Array.from({ length: N }, () => new Uint32Array(W));
    const hasBit = (bs: Uint32Array, n: number | Binding) => { const i = slotBits.get(n); return i !== undefined && (bs[i >>> 5] & (1 << (i & 31))) !== 0; };
    const valIsR = (v: A.Expr | undefined, st: Uint32Array): boolean => { if (!v) return false; if (isR(v)) return true; const n = placeOf(v); return n !== null && hasBit(st, n); };
    const put = (out: Uint32Array, k: number | Binding, on: boolean) => { const bi = slotBits.get(k); if (bi === undefined) return; out[bi >>> 5] &= ~(1 << (bi & 31)); if (on) out[bi >>> 5] |= 1 << (bi & 31); };
    const transfer = (nd: FN, st: Uint32Array): Uint32Array => {
      if (nd.assign) {
        const out = st.slice();
        const s = nd.assign;
        s.targets.forEach((t, i) => { const k = placeOf(t); if (k !== null) put(out, k, !s.op && i < s.values.length && !(i === s.values.length - 1 && s.targets.length > s.values.length) && valIsR(s.values[i], st)); });
        return out;
      }
      if (nd.local) {
        const out = st.slice(); const s = nd.local;
        for (const x of scope.bindings) if (x.decl === s) put(out, x, x.index < s.init.length && !(x.index === s.init.length - 1 && s.names.length > s.init.length) && valIsR(s.init[x.index], st));
        return out;
      }
      if (nd.kills) { const out = st.slice(); for (const x of nd.kills) put(out, x, false); return out; }
      return st;
    };
    const work: number[] = [entry]; const inWork = new Uint8Array(N); inWork[entry] = 1;
    const seen = new Uint8Array(N); seen[entry] = 1;
    let guard = 0;
    while (work.length) {
      if (++guard > 5_000_000) return 'alias analysis too large';
      const i = work.pop()!; inWork[i] = 0;
      const out = transfer(nodes[i], inS[i]);
      for (const sx of nodes[i].succ) {
        const t = inS[sx]; let ch = !seen[sx];
        for (let w = 0; w < W; w++) { const v = (t[w] | out[w]) >>> 0; if (v !== t[w]) { t[w] = v; ch = true; } }
        seen[sx] = 1;
        if (ch && !inWork[sx]) { inWork[sx] = 1; work.push(sx); }
      }
    }
    const reads: Array<A.IndexExpr | A.NameExpr> = [];
    for (let i = 0; i < N; i++) {
      if (!seen[i]) continue;
      const st = inS[i];
      visitExprs(nodes[i].exprs, (e, k) => { if (hasBit(st, k)) reads.push(e); });
    }
    return reads;
  }
  /** keys of `for k in L` / `pairs(L)` / `next, L` where L is a local table only ever stored at literal keys */
  function literalKeysOfIter(f: A.GenericForStat): number[] | null {
    let it = f.iters.length === 1 ? unparen(f.iters[0]) : f.iters.length >= 2 && calleeName(f.iters[0]) === 'next' ? unparen(f.iters[1]) : null;
    if (it && it.type === 'CallExpr' && /^(?:pairs|ipairs)$/.test(calleeName(it.callee)) && it.args.length === 1) it = unparen(it.args[0]);
    if (!it || it.type !== 'NameExpr') return null;
    const lb = scope.refOf.get(it); if (!lb || lb.kind === 'global' || lb.captured) return null;
    const keys = new Set<number>();
    for (const w of lb.writeRefs) {
      const l = links.get(w); if (!l) return null;
      const stmt = l.parent;
      const v = stmt.type === 'AssignStat' ? stmt.values[l.index] : undefined;
      const u = v ? unparen(v) : null;
      if (!u || !(u.type === 'TableExpr' && u.fields.length === 0) && u.type !== 'NilLit') { if (devEnv('PRISM_PROMOTE_TRACE')) console.error('[promote] iter table written with', u?.type); return null; }
    }
    if (lb.init && !(unparen(lb.init).type === 'TableExpr' && (unparen(lb.init) as A.TableExpr).fields.length === 0) && unparen(lb.init).type !== 'NilLit') return null;
    for (const r of lb.refs) {
      if (lb.writeRefs.includes(r)) continue;
      const l = links.get(r); if (!l) return null;
      const p = l.parent;
      if (p.type === 'IndexExpr' && l.key === 'obj') {
        if (isTarget(p)) {
          const n = intLit(p.index);
          if (n === null) {
            // `L[k] = …` with k a key of a traversal of L itself: an existing key
            const ix = unparen(p.index);
            if (ix.type === 'NameExpr') { const ib = scope.refOf.get(ix); if (ib && ib.kind === 'for' && ib.index === 0 && ib.decl?.type === 'GenericForStat' && iterates(ib.decl, lb)) continue; }
            return null;
          }
          keys.add(n);
        }
        continue;   // reads of L[k]
      }
      if (p.type === 'GenericForStat' && l.key === 'iters') continue;
      if (p.type === 'CallExpr' && /^(?:pairs|ipairs|next)$/.test(calleeName(p.callee))) continue;
      if (p.type === 'UnExpr' && p.op === 'not') continue;
      if (p.type === 'IfStat' || (p.type === 'BinExpr' && (p.op === 'and' || p.op === 'or'))) continue;
      if (l.key === 'cond') continue;
      if (devEnv('PRISM_PROMOTE_TRACE')) console.error('[promote] iter table ref not understood:', p.type ?? p.kind, l.key);
      return null;
    }
    return [...keys];
  }
  /** the generic-for traverses the table bound to lb */
  function iterates(f: A.GenericForStat, lb: Binding): boolean {
    let it = f.iters.length === 1 ? unparen(f.iters[0]) : f.iters.length >= 2 && calleeName(f.iters[0]) === 'next' ? unparen(f.iters[1]) : null;
    if (it && it.type === 'CallExpr' && /^(?:pairs|ipairs)$/.test(calleeName(it.callee)) && it.args.length === 1) it = unparen(it.args[0]);
    return !!it && it.type === 'NameExpr' && scope.refOf.get(it) === lb;
  }
  /** `t = R` (or `local t = R`) where t is written again before it is read on every path inside its list */
  function deadAlias(stmt: any, idx: number): boolean {
    const tgt = stmt.type === 'AssignStat' ? unparen(stmt.targets[idx]) : null;
    let tb: Binding | undefined;
    if (tgt) { if (tgt.type !== 'NameExpr') return false; tb = scope.refOf.get(tgt); }
    else tb = scope.bindings.find(x => x.decl === stmt && x.index === idx);
    if (!tb || tb.kind === 'global' || tb.captured) return false;
    const l = links.get(stmt); if (!l || l.index < 0) return false;
    const list = l.parent[l.key] as A.Stat[];
    const reads = new Set(tb.refs.filter(r => !tb!.writeRefs.includes(r)));
    const readsIn = (node: any): boolean => { let hit = false; const v = (m: any) => { if (hit || !m || typeof m !== 'object') return; if (m.type === 'NameExpr' && reads.has(m)) { hit = true; return; } for (const k of Object.keys(m)) if (k !== 'loc') { const x = m[k]; if (Array.isArray(x)) x.forEach(v); else if (x && typeof x === 'object') v(x); } }; v(node); return hit; };
    // the statement itself (other values) must not read t
    for (let j = list.indexOf(stmt) + 1; j < list.length; j++) {
      const s = list[j];
      if (s.type === 'AssignStat' && !s.op && s.targets.length === 1 && unparen(s.targets[0]).type === 'NameExpr' && scope.refOf.get(unparen(s.targets[0]) as A.NameExpr) === tb) return !readsIn(s.values);
      if (readsIn(s)) return false;
      if (s.type === 'ReturnStat') return true;
      if (s.type === 'BreakStat' || s.type === 'ContinueStat' || s.type === 'GotoStat') return false;
    }
    // end of the list: dead only if nothing after the enclosing statement can read t
    return !tb.refs.some(r => reads.has(r) && !inside(r, stmt) && after(r, stmt));
  }
  function inside(node: any, root: any): boolean { let x = links.get(node); while (x) { if (x.parent === root) return true; x = links.get(x.parent); } return false; }
  /** conservative: t is read anywhere after the statement in a later position or in an enclosing loop */
  function after(_r: any, _stmt: any): boolean { return true; }
}
function shortExpr(e: A.Expr): string { const u: any = unparen(e); return u.type === 'NameExpr' ? u.name : u.type; }

/** most locals in scope at once in a function body (the Luau limit is on active locals, not on declarations) */
function maxActiveLocals(list: A.Stat[], base: number): number {
  let cur = base, best = base;
  for (const s of list) {
    switch (s.type) {
      case 'LocalStat': cur += s.names.length; if (cur > best) best = cur; break;
      case 'LocalFunctionStat': cur += 1; if (cur > best) best = cur; break;
      case 'DoStat': case 'WhileStat': case 'RepeatStat': best = Math.max(best, maxActiveLocals(s.body, cur)); break;
      case 'NumericForStat': best = Math.max(best, maxActiveLocals(s.body, cur + 1)); break;
      case 'GenericForStat': best = Math.max(best, maxActiveLocals(s.body, cur + s.names.length)); break;
      case 'IfStat': for (const c of s.clauses) best = Math.max(best, maxActiveLocals(c.body, cur)); if (s.elseBody) best = Math.max(best, maxActiveLocals(s.elseBody, cur)); break;
    }
  }
  return best;
}
