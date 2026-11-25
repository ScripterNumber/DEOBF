// PRISM — primitive-table resolution and dispatch linearisation.
//
// Two things this module adds, both distilled from the double-VM sample:
//
//  * resolvePrimitives: a table literal whose keys are numbers and whose values
//    are host functions (`buffer.readu8`, `bit32.band`, ...) is an indirection
//    layer. Every `d[63](buf, i)` in the program is really `buffer.readu8`.
//    Recovering the map is the difference between "calls an index" and "reads a
//    byte of the bytecode stream".
//
//  * linearizeDispatch: Luraph-style dispatch is an interval tree over a counter
//    (`if F <= 17 then if F <= 8 then ...`). The leaves are the states; the
//    ranges are implicit. This walks the tree, intersects the constraints and
//    reports which states map to which leaf, which is what turns 36 nested
//    branches into a 10-row table.
import type * as A from '../ast.js';
import { walk } from '../ast.js';
import { print } from '../printer.js';

export interface PrimitiveEntry {
  key: number;
  expr: string;
  symbol: string | null;
  category: string;
}

export interface PrimitiveTable {
  /** name of the local that holds the table, when it can be determined */
  tableName: string | null;
  /** number of keyed numeric fields */
  size: number;
  /** numeric keys that resolve to a host symbol */
  resolved: number;
  entries: PrimitiveEntry[];
  /** keys absent inside the dense head — runtime-assigned slots */
  gaps: number[];
  maxKey: number;
  /** keys <= 1023, i.e. inside the practical index domain */
  denseKeys: number;
  line: number;
  score: number;
}

export interface PrimitivesReport {
  tables: PrimitiveTable[];
  best: PrimitiveTable | null;
  notes: string[];
}

const HOST_PREFIXES = ['buffer', 'bit32', 'table', 'string', 'coroutine', 'math', 'utf8', 'os'];

/** Host globals that are functions but never a prefix member. */
const HOST_NAMES = new Set([
  'unpack', 'next', 'error', 'type', 'typeof', 'pairs', 'ipairs', 'rawget', 'rawset',
  'rawlen', 'rawequal', 'select', 'tostring', 'tonumber', 'setmetatable', 'getmetatable',
  'getfenv', 'setfenv', 'pcall', 'xpcall', 'assert', 'print', 'require', 'load',
  'loadstring', 'collectgarbage', 'newproxy',
]);

function exprText(e: any): string {
  try { return print(e as A.Expr).trim(); } catch { return ''; }
}

function symbolOf(e: any): string | null {
  if (!e) return null;
  if (e.type === 'NameExpr') return HOST_NAMES.has(e.name) ? e.name : null;
  if (e.type === 'MemberExpr') {
    const obj = e.obj && e.obj.type === 'NameExpr' ? e.obj.name : null;
    if (obj && HOST_PREFIXES.includes(obj)) return `${obj}.${e.name}`;
    return null;
  }
  if (e.type === 'IndexExpr' && e.obj && e.obj.type === 'NameExpr' && e.index && e.index.type === 'StringLit') {
    const obj = e.obj.name;
    if (HOST_PREFIXES.includes(obj)) return `${obj}.${e.index.value}`;
  }
  return null;
}

function categoryOf(sym: string | null): string {
  if (!sym) return 'unknown';
  const dot = sym.indexOf('.');
  return dot < 0 ? 'global' : sym.slice(0, dot);
}

function numericKey(f: A.TableField): number | null {
  if (f.kind !== 'keyed' || !f.key) return null;
  const k: any = f.key;
  if (k.type === 'NumberLit' && Number.isFinite(k.value)) return k.value;
  return null;
}

/** Find the local/global name a table expression is assigned to, if any. */
function nameOfTable(chunk: A.Chunk, target: any): string | null {
  if (!target) return null;
  let found: string | null = null;
  walk(chunk as any, (n: any) => {
    if (found) return;
    if (n.type === 'LocalStat') {
      for (let i = 0; i < n.init.length; i++) {
        if (n.init[i] === target) { found = n.names[i] ?? null; return; }
      }
    }
    if (n.type === 'AssignStat') {
      for (let i = 0; i < n.values.length; i++) {
        if (n.values[i] === target) {
          const t = n.targets[i];
          if (t && t.type === 'NameExpr') found = t.name;
          return;
        }
      }
    }
  });
  return found;
}

/**
 * When the table is anonymous (passed straight into setmetatable), the program
 * still reaches it through a name — usually the first parameter of its methods.
 * Pick the name whose `X[n]` indexes hit the primitive keys most often.
 */
function guessTableName(chunk: A.Chunk, keys: Set<number>): string | null {
  const hits = new Map<string, number>();
  walk(chunk as any, (n: any) => {
    if (n.type !== 'IndexExpr' && !(n.type === 'CallExpr')) return;
    const idx = n.type === 'IndexExpr' ? n : null;
    const target = idx ?? null;
    if (target && target.obj?.type === 'NameExpr' && target.index?.type === 'NumberLit' && keys.has(target.index.value)) {
      const nm = target.obj.name;
      hits.set(nm, (hits.get(nm) ?? 0) + 1);
    }
  });
  let best: string | null = null;
  let bestN = 0;
  for (const [k, v] of hits) if (v > bestN) { best = k; bestN = v; }
  return bestN >= 3 ? best : null;
}

export function resolvePrimitives(chunk: A.Chunk, opts: { minKeys?: number; limit?: number } = {}): PrimitivesReport {
  const minKeys = opts.minKeys ?? 8;
  const notes: string[] = [];
  const tables: PrimitiveTable[] = [];

  walk(chunk as any, (n: any) => {
    if (n.type !== 'TableExpr') return;
    const fields: A.TableField[] = n.fields || [];
    const numeric: Array<{ key: number; value: any }> = [];
    for (const f of fields) {
      const k = numericKey(f);
      if (k !== null) numeric.push({ key: k, value: f.value });
    }
    if (numeric.length < minKeys) return;

    const entries: PrimitiveEntry[] = [];
    let resolved = 0;
    for (const { key, value } of numeric.sort((a, b) => a.key - b.key)) {
      const sym = symbolOf(value);
      if (sym) resolved++;
      entries.push({ key, expr: exprText(value), symbol: sym, category: categoryOf(sym) });
    }
    const maxKey = entries.length ? entries[entries.length - 1].key : 0;
    const denseKeys = entries.filter((e) => e.key <= 1023).length;
    const present = new Set(entries.map((e) => e.key));
    const gapCap = Math.min(maxKey, 1023);
    const gaps: number[] = [];
    for (let k = 0; k <= gapCap; k++) if (!present.has(k)) gaps.push(k);

    // a primitive table is dense, numeric and mostly resolves to host API
    const score = resolved * 2 + entries.length - Math.floor(gaps.length / 4);
    tables.push({
      tableName: null,
      size: entries.length,
      resolved,
      entries,
      gaps,
      maxKey,
      denseKeys,
      line: n.loc?.line ?? 0,
      score,
    });
  });

  tables.sort((a, b) => b.score - a.score);
  const limited = opts.limit ? tables.slice(0, opts.limit) : tables;

  const best = limited[0] ?? null;
  if (best) {
    const node = findTableNode(chunk, best);
    best.tableName = nameOfTable(chunk, node) ?? guessTableName(chunk, new Set(best.entries.map((e) => e.key)));
    if (best.gaps.length) {
      const head = best.gaps.slice(0, 12).join(', ');
      notes.push(`${best.gaps.length} key(s) inside 0..${Math.min(best.maxKey, 1023)} are absent from the literal (${head}${best.gaps.length > 12 ? ', ...' : ''}) — assigned at runtime`);
    }
    const unknown = best.entries.filter((e) => !e.symbol).length;
    if (unknown) notes.push(`${unknown} entr(ies) do not resolve to a known host symbol`);
  } else {
    notes.push('no table with numeric keys onto host functions was found');
  }

  return { tables: limited, best, notes };
}

function findTableNode(chunk: A.Chunk, entry: PrimitiveTable): any {
  let hit: any = null;
  walk(chunk as any, (n: any) => {
    if (hit || n.type !== 'TableExpr') return;
    if ((n.loc?.line ?? 0) !== entry.line) return;
    let numeric = 0;
    for (const f of n.fields || []) if (numericKey(f) !== null) numeric++;
    if (numeric === entry.size) hit = n;
  });
  return hit;
}

export function formatPrimitives(r: PrimitivesReport, opts: { full?: boolean } = {}): string {
  const out: string[] = [];
  const b = r.best;
  if (!b) return 'primitives: none found\n';
  out.push(`primitive table${b.tableName ? ` "${b.tableName}"` : ''}: ${b.size} numeric keys (${b.denseKeys} <= 1023), ${b.resolved} resolve to host API, max key ${b.maxKey}`);
  if (b.gaps.length) out.push(`gaps in dense domain: ${b.gaps.slice(0, 40).join(' ')}${b.gaps.length > 40 ? ' ...' : ''}`);
  out.push('');
  const byCat = new Map<string, number>();
  for (const e of b.entries) byCat.set(e.category, (byCat.get(e.category) ?? 0) + 1);
  out.push('by category: ' + [...byCat.entries()].map(([c, n]) => `${c}=${n}`).join(' '));
  out.push('');
  const show = opts.full ? b.entries : b.entries.filter((e) => e.symbol);
  const width = String(Math.max(...show.map((e) => e.key))).length;
  for (const e of show) {
    out.push(`  [${String(e.key).padStart(width)}] ${(e.symbol ?? e.expr).padEnd(24)} ${e.category}`);
  }
  if (!opts.full && show.length < b.entries.length) out.push(`  (${b.entries.length - show.length} unresolved entries hidden)`);
  for (const n of r.notes) out.push('note: ' + n);
  return out.join('\n') + '\n';
}

/** Count call sites of `name[key](...)` for keys in the map. */
export function primitiveCallSites(chunk: A.Chunk, tableName: string, byKey: Map<number, string>): Array<{ key: number; symbol: string; count: number; lines: number[] }> {
  const acc = new Map<number, { count: number; lines: number[] }>();
  walk(chunk as any, (n: any) => {
    if (n.type !== 'CallExpr' && n.type !== 'MethodCallExpr') return;
    const callee = n.type === 'CallExpr' ? n.callee : null;
    if (!callee || callee.type !== 'IndexExpr') return;
    if (!callee.obj || callee.obj.type !== 'NameExpr' || callee.obj.name !== tableName) return;
    if (!callee.index || callee.index.type !== 'NumberLit') return;
    const k = callee.index.value;
    if (!byKey.has(k)) return;
    const e = acc.get(k) ?? { count: 0, lines: [] };
    e.count++;
    if (e.lines.length < 6) e.lines.push(n.loc?.line ?? 0);
    acc.set(k, e);
  });
  return [...acc.entries()]
    .map(([key, v]) => ({ key, symbol: byKey.get(key)!, count: v.count, lines: v.lines }))
    .sort((a, b) => b.count - a.count);
}

// ---------------------------------------------------------------------------
// dispatch linearisation
// ---------------------------------------------------------------------------

export interface DispatchLeaf {
  states: number[];
  /** number of states in the leaf range */
  count: number;
  line: number;
  calls: string[];
  returns: boolean;
}

export interface IntervalDispatch {
  varName: string;
  /** highest state mentioned in a comparison */
  maxState: number;
  leaves: DispatchLeaf[];
  line: number;
  loopKind: 'while' | 'repeat';
}

export interface LinearizeReport {
  trees: IntervalDispatch[];
  notes: string[];
}

type Range = { lo: number; hi: number };

function intersect(r: Range[], lo: number, hi: number): Range[] {
  const out: Range[] = [];
  for (const a of r) {
    const l = Math.max(a.lo, lo);
    const h = Math.min(a.hi, hi);
    if (l <= h) out.push({ lo: l, hi: h });
  }
  return out;
}

function subtract(r: Range[], lo: number, hi: number): Range[] {
  const out: Range[] = [];
  for (const a of r) {
    if (hi < a.lo || lo > a.hi) { out.push(a); continue; }
    if (lo > a.lo) out.push({ lo: a.lo, hi: Math.min(lo - 1, a.hi) });
    if (hi < a.hi) out.push({ lo: Math.max(hi + 1, a.lo), hi: a.hi });
  }
  return out;
}

/** Parse `X <= N`, `X < N`, `X >= N`, `X > N`, `X == N`, `X ~= N`. */
function parsePredicate(cond: any, varName: string): Range | null {
  if (!cond || cond.type !== 'BinExpr') return null;
  const { op, left, right } = cond;
  const isVar = (e: any) => e && e.type === 'NameExpr' && e.name === varName;
  const numOf = (e: any) => (e && e.type === 'NumberLit' && Number.isFinite(e.value) ? e.value : null);
  let n: number | null = null;
  let flipped = false;
  if (isVar(left)) n = numOf(right);
  else if (isVar(right)) { n = numOf(left); flipped = true; }
  if (n === null) return null;
  const o = flipped ? flip(op) : op;
  switch (o) {
    case '<=': return { lo: -Infinity, hi: n };
    case '<': return { lo: -Infinity, hi: n - 1 };
    case '>=': return { lo: n, hi: Infinity };
    case '>': return { lo: n + 1, hi: Infinity };
    case '==': return { lo: n, hi: n };
    case '~=': return { lo: n, hi: n };
    default: return null;
  }
}

function flip(op: string): string {
  switch (op) {
    case '<': return '>';
    case '<=': return '>=';
    case '>': return '<';
    case '>=': return '<=';
    default: return op;
  }
}

function callNamesIn(body: any[]): string[] {
  const names = new Set<string>();
  for (const st of body) {
    walk(st as any, (n: any) => {
      if (n.type === 'MethodCallExpr') names.add(':' + n.method);
      else if (n.type === 'CallExpr' && n.callee) {
        if (n.callee.type === 'NameExpr') names.add(n.callee.name);
        else if (n.callee.type === 'MemberExpr') names.add(n.callee.name);
        else if (n.callee.type === 'IndexExpr' && n.callee.index?.type === 'NumberLit') names.add('[' + n.callee.index.value + ']');
      }
    });
  }
  return [...names];
}

interface WalkCtx { varName: string; out: DispatchLeaf[]; maxState: { v: number } }

function step(body: any[], ctx: WalkCtx, range: Range[]) {
  const meaningful = (body || []).filter((s: any) => s && s.type !== 'EmptyStat');
  if (!meaningful.length) return;
  if (meaningful.length === 1 && meaningful[0].type === 'IfStat') {
    collectLeaves(meaningful[0], ctx, range);
    return;
  }
  const states: number[] = [];
  let count = 0;
  for (const r of range) {
    const lo = Math.max(r.lo, 0);
    const hi = r.hi;
    if (lo > hi) continue;
    count += hi - lo + 1;
    if (states.length < 64) for (let s = lo; s <= hi && states.length < 64; s++) states.push(s);
  }
  if (!count) return;
  ctx.out.push({
    states,
    count,
    line: meaningful[0]?.loc?.line ?? 0,
    calls: callNamesIn(meaningful),
    returns: meaningful.some((s: any) => s.type === 'ReturnStat' || s.type === 'BreakStat'),
  });
}

function collectLeaves(node: any, ctx: WalkCtx, range: Range[]) {
  if (!node || !range.length) return;
  if (node.type !== 'IfStat') { step([node], ctx, range); return; }

  let rest = range;
  for (const clause of node.clauses || []) {
    const pred = parsePredicate(clause.cond, ctx.varName);
    if (!pred) continue;
    if (Number.isFinite(pred.hi)) ctx.maxState.v = Math.max(ctx.maxState.v, pred.hi);
    if (Number.isFinite(pred.lo) && pred.lo > 0) ctx.maxState.v = Math.max(ctx.maxState.v, pred.lo);
    const op = clause.cond.op;
    let sub: Range[];
    if (op === '~=') {
      sub = subtract(rest, pred.lo, pred.hi);
      rest = intersect(rest, pred.lo, pred.hi);
    } else if (op === '==') {
      sub = intersect(rest, pred.lo, pred.hi);
      rest = subtract(rest, pred.lo, pred.hi);
    } else {
      sub = intersect(rest, pred.lo, pred.hi);
      rest = subtract(rest, pred.lo, pred.hi);
    }
    if (sub.length) step(clause.body, ctx, sub);
    // keep walking even when rest is empty: later clauses still widen the domain
  }
  if (node.elseBody && node.elseBody.length) step(node.elseBody, ctx, rest);
}

/** Find the dispatch variable of an if-chain by counting comparisons per name. */
function dispatchVarOf(ifStat: any): string | null {
  const counts = new Map<string, number>();
  let depth = 0;
  const visit = (node: any) => {
    if (!node || depth > 64) return;
    depth++;
    if (node.type === 'IfStat') {
      for (const c of node.clauses || []) {
        const cond = c.cond;
        if (cond && cond.type === 'BinExpr') {
          for (const side of [cond.left, cond.right]) {
            if (side && side.type === 'NameExpr') counts.set(side.name, (counts.get(side.name) ?? 0) + 1);
          }
        }
        for (const s of c.body || []) visit(s);
      }
      if (node.elseBody) for (const s of node.elseBody) visit(s);
    }
    depth--;
  };
  visit(ifStat);
  let best: string | null = null;
  let bestN = 0;
  for (const [k, v] of counts) if (v > bestN) { best = k; bestN = v; }
  return bestN >= 3 ? best : null;
}

export function linearizeDispatch(chunk: A.Chunk, opts: { maxTrees?: number; minLeaves?: number } = {}): LinearizeReport {
  const maxTrees = opts.maxTrees ?? 8;
  const minLeaves = opts.minLeaves ?? 6;
  const trees: IntervalDispatch[] = [];
  const notes: string[] = [];

  walk(chunk as any, (n: any) => {
    if (trees.length >= maxTrees) return;
    let body: any[] | null = null;
    let loopKind: IntervalDispatch['loopKind'] = 'while';
    if (n.type === 'WhileStat' && n.cond && (n.cond.type === 'TrueLit' || n.cond.type === 'NameExpr')) { body = n.body; loopKind = 'while'; }
    else if (n.type === 'RepeatStat') { body = n.body; loopKind = 'repeat'; }
    if (!body || !body.length) return;

    // a loop may split its dispatch across sibling if-chains, so walk them all
    const heads = body.filter((s: any) => s && s.type === 'IfStat');
    if (!heads.length) return;
    const varName = dispatchVarOf(heads[0]);
    if (!varName) return;

    const ctx: WalkCtx = { varName, out: [], maxState: { v: 0 } };
    for (const h of heads) {
      if (!dispatchVarOf(h)) continue;
      collectLeaves(h, ctx, [{ lo: 0, hi: 1023 }]);
    }
    const maxState = ctx.maxState.v;
    const leaves = ctx.out.filter((l) => l.count > 0).sort((a, b) => (a.states[0] ?? 0) - (b.states[0] ?? 0));
    if (!maxState || leaves.length < minLeaves) return;

    trees.push({ varName, maxState, leaves, line: n.loc?.line ?? 0, loopKind });
  });

  trees.sort((a, b) => b.leaves.length - a.leaves.length);
  if (!trees.length) notes.push('no interval-tree dispatch loop found');
  return { trees, notes };
}

export function formatDispatch(r: LinearizeReport): string {
  const out: string[] = [];
  if (!r.trees.length) {
    out.push('dispatch: none found');
    for (const n of r.notes) out.push('note: ' + n);
    return out.join('\n') + '\n';
  }
  for (const t of r.trees) {
    const covered = t.leaves.reduce((a, l) => a + l.count, 0);
    out.push(`dispatch on "${t.varName}" at line ${t.line} (${t.loopKind}): ${t.leaves.length} leaves, ${covered} states of 0..${t.maxState}`);
    const width = String(t.maxState).length;
    for (const l of t.leaves) {
      const last = l.states[l.states.length - 1];
      const range = l.count === 1 ? String(l.states[0]) : `${l.states[0]}..${last}${l.count > l.states.length ? '+' : ''}`;
      const flags = [l.returns ? 'exit' : '', ...l.calls].filter(Boolean).join(' ');
      out.push(`  [${range.padEnd(width + 6)}] n=${String(l.count).padStart(4)}  ${flags}`);
    }
  }
  for (const n of r.notes) out.push('note: ' + n);
  return out.join('\n') + '\n';
}