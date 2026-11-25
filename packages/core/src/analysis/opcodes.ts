// PRISM opcode mapper — universal VM handler extraction + semantic guessing.
//
// 1. Finds dispatch trees: nested if/elseif chains that compare ONE variable with
//    numeric constants (linear chains, binary-search trees, mixed), flattens them
//    into leaves with exact opcode sets using interval constraints.
// 2. Recovers VM roles from the fetch/decode prologue (inst = code[pc]; op = inst[k])
//    with frequency-based fallbacks (stack = most operand-indexed table, ...).
// 3. Lifts every handler into register notation (R[A] = R[B][C]) and classifies it
//    against Lua/Luau instruction semantics. Super-instructions (fused handlers
//    separated by pc = pc + 1; inst = code[pc]) are split into micro-ops.
// 4. For control-flow-flattening state machines (state = <const> transitions) the
//    same trees yield blocks + transition edges (CFF unflattening view).
import type * as A from '../ast.js';
import { walk } from '../ast.js';
import { print } from '../printer.js';
import { analyzeScopes, renameBinding } from './scope.js';

/** NameExpr nodes in a statement list that are bound by a local declared inside it */
function localRefSet(stmts: A.Stat[]): Set<A.NameExpr> {
  const sc = analyzeScopes({ type: 'Chunk', body: stmts });
  const out = new Set<A.NameExpr>();
  for (const [n, b] of sc.refOf) if (b.kind !== 'global') out.add(n);
  return out;
}

export interface HandlerInfo {
  index: number;
  opcodes: number[];
  rangeText: string;
  line: number;
  /** source offset of the handler body (for jump-to-source) */
  pos: number;
  stmts: number;
  shape: string;
  code: string;
  lifted: string;
  guess: string;
  confidence: number;
  segments: string[];
  successors?: number[];
}

export interface VmRoles {
  inst?: string; code?: string; pc?: string; stack?: string; opField?: string;
  fields: Record<string, string>;
  tables: Array<{ name: string; reads: number; writes: number; role: string }>;
}

export interface DispatchTree {
  id: number;
  line: number;
  var: string;
  kind: 'vm' | 'cff' | 'switch';
  leaves: number;
  minOp: number;
  maxOp: number;
  inLoop: boolean;
  score: number;
  roles: VmRoles;
  handlers: HandlerInfo[];
  entryState?: number;
}

export interface OpcodeReport {
  trees: DispatchTree[];
  notes: string[];
}

interface Constraint { lo: number; hi: number; excl: Set<number>; }
interface Cmp { op: '<' | '<=' | '>' | '>=' | '==' | '~='; k: number; }

const unparen = (e: A.Expr): A.Expr => { while (e && e.type === 'ParenExpr') e = e.expr; return e; };
const FLIP: Record<string, Cmp['op']> = { '<': '>', '<=': '>=', '>': '<', '>=': '<=', '==': '==', '~=': '~=' };
const NEG: Record<string, Cmp['op']> = { '<': '>=', '<=': '>', '>': '<=', '>=': '<', '==': '~=', '~=': '==' };

function numVal(e: A.Expr): number | null {
  e = unparen(e);
  if (e.type === 'NumberLit') return e.value;
  if (e.type === 'UnExpr' && e.op === '-') { const v = numVal(e.expr); return v === null ? null : -v; }
  return null;
}

/** `V op K` (either side) -> normalized comparison on V, else null */
function cmpOn(cond: A.Expr, v: string): Cmp | null {
  const c = unparen(cond);
  // `not (V >= K)` → `V < K` (dispatch trees are over numbers, so the NaN corner does not matter)
  if (c.type === 'UnExpr' && c.op === 'not') { const p = cmpOn(c.expr, v); return p ? { op: NEG[p.op], k: p.k } : null; }
  if (c.type !== 'BinExpr' || !(c.op in FLIP)) return null;
  const l = unparen(c.left), r = unparen(c.right);
  if (l.type === 'NameExpr' && l.name === v) { const k = numVal(r); return k === null ? null : { op: c.op as Cmp['op'], k }; }
  if (r.type === 'NameExpr' && r.name === v) { const k = numVal(l); return k === null ? null : { op: FLIP[c.op], k }; }
  return null;
}
function cmpVar(cond: A.Expr): string | null {
  const c = unparen(cond);
  if (c.type === 'UnExpr' && c.op === 'not') return cmpVar(c.expr);
  if (c.type !== 'BinExpr' || !(c.op in FLIP)) return null;
  const l = unparen(c.left), r = unparen(c.right);
  if (l.type === 'NameExpr' && numVal(r) !== null) return l.name;
  if (r.type === 'NameExpr' && numVal(l) !== null) return r.name;
  return null;
}

function apply(c: Constraint, p: Cmp): Constraint {
  const n: Constraint = { lo: c.lo, hi: c.hi, excl: new Set(c.excl) };
  const k = p.k;
  switch (p.op) {
    case '<': n.hi = Math.min(n.hi, Math.ceil(k) - 1); break;
    case '<=': n.hi = Math.min(n.hi, Math.floor(k)); break;
    case '>': n.lo = Math.max(n.lo, Math.floor(k) + 1); break;
    case '>=': n.lo = Math.max(n.lo, Math.ceil(k)); break;
    case '==': if (Number.isInteger(k)) { n.lo = Math.max(n.lo, k); n.hi = Math.min(n.hi, k); } else { n.lo = 1; n.hi = 0; } break;
    case '~=': if (Number.isInteger(k)) n.excl.add(k); break;
  }
  return n;
}

interface RawLeaf { c: Constraint; body: A.Stat[]; line: number; pos?: number; locals?: Set<A.NameExpr>; }
const leafLocals = (lf: RawLeaf) => lf.locals ??= localRefSet(lf.body);

function flatten(ifs: A.IfStat, v: string, c0: Constraint, leaves: RawLeaf[], consumed: Set<any>, ks: number[]) {
  consumed.add(ifs);
  let c = c0;
  for (let i = 0; i < ifs.clauses.length; i++) {
    const cl = ifs.clauses[i];
    const p = cmpOn(cl.cond, v);
    if (!p) {
      // the rest is not a dispatch comparison: keep it as one opaque leaf
      const rest: A.IfStat = { type: 'IfStat', clauses: ifs.clauses.slice(i), elseBody: ifs.elseBody, loc: ifs.loc };
      leaves.push({ c, body: [rest], line: cl.cond.loc?.line ?? ifs.loc?.line ?? 0 });
      return;
    }
    ks.push(p.k);
    body(cl.body, v, apply(c, p), leaves, consumed, ks, cl.cond.loc?.line ?? ifs.loc?.line ?? 0);
    c = apply(c, { op: NEG[p.op], k: p.k });
  }
  if (ifs.elseBody && ifs.elseBody.length) body(ifs.elseBody, v, c, leaves, consumed, ks, ifs.elseBody[0]?.loc?.line ?? 0);
}
function body(stmts: A.Stat[], v: string, c: Constraint, leaves: RawLeaf[], consumed: Set<any>, ks: number[], line: number) {
  if (stmts.length === 1 && stmts[0].type === 'IfStat' && cmpOn(stmts[0].clauses[0].cond, v)) {
    flatten(stmts[0], v, c, leaves, consumed, ks); return;
  }
  leaves.push({ c, body: stmts, line: stmts[0]?.loc?.line ?? line });
}

function enumerate(c: Constraint, minK: number, maxK: number): { ops: number[]; text: string } {
  let lo = c.lo, hi = c.hi;
  if (lo === -Infinity) lo = Math.min(0, Math.floor(minK));
  if (hi === Infinity) hi = Math.floor(maxK) + 1;
  if (lo > hi) return { ops: [], text: '∅' };
  const ops: number[] = [];
  if (hi - lo <= 512) for (let x = lo; x <= hi; x++) if (!c.excl.has(x)) ops.push(x);
  let text: string;
  if (ops.length === 1) text = String(ops[0]);
  else if (ops.length && ops.length === hi - lo + 1) text = lo + '..' + hi;
  else if (ops.length) text = ops.length <= 6 ? ops.join(',') : lo + '..' + hi + ' (\\' + [...c.excl].join(',') + ')';
  else text = (c.lo === -Infinity ? '≤' + hi : c.hi === Infinity ? '≥' + lo : lo + '..' + hi);
  return { ops, text };
}

function shapeHash(stmts: A.Stat[]): string {
  const sh = (s: A.Stat): string => {
    switch (s.type) {
      case 'IfStat': return 'I(' + s.clauses.map(c => s2(c.body)).join('|') + (s.elseBody ? ';' + s2(s.elseBody) : '') + ')';
      case 'WhileStat': return 'W(' + s2(s.body) + ')';
      case 'RepeatStat': return 'R(' + s2(s.body) + ')';
      case 'NumericForStat': case 'GenericForStat': return 'F(' + s2((s as any).body) + ')';
      case 'DoStat': return 'D(' + s2(s.body) + ')';
      case 'LocalStat': return 'l';
      case 'AssignStat': return 'a';
      case 'CallStat': return 'c';
      case 'ReturnStat': return 'r';
      default: return s.type[0];
    }
  };
  const s2 = (b: A.Stat[]) => b.map(sh).join(',');
  const str = s2(stmts);
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return (h >>> 0).toString(16).padStart(8, '0');
}

// ---------------------------------------------------------------- roles ----
function stmtsDeep(stmts: A.Stat[], fn: (s: A.Stat) => void) {
  for (const s of stmts) {
    fn(s);
    switch (s.type) {
      case 'DoStat': case 'WhileStat': case 'RepeatStat': case 'NumericForStat': case 'GenericForStat': stmtsDeep((s as any).body, fn); break;
      case 'IfStat': for (const c of s.clauses) stmtsDeep(c.body, fn); if (s.elseBody) stmtsDeep(s.elseBody, fn); break;
    }
  }
}
const nameOf = (e: A.Expr | undefined): string | null => { const u = e && unparen(e); return u && u.type === 'NameExpr' ? u.name : null; };
function assignPairs(s: A.Stat): Array<{ t: A.Expr | string; v: A.Expr }> {
  if (s.type === 'AssignStat' && !s.op) return s.targets.map((t, i) => ({ t, v: s.values[i] })).filter(p => p.v);
  if (s.type === 'LocalStat') return s.names.map((n, i) => ({ t: n, v: s.init[i] })).filter(p => p.v);
  return [];
}
const tname = (t: A.Expr | string) => typeof t === 'string' ? t : nameOf(t);

function detectRoles(v: string, prologue: A.Stat[], leaves: RawLeaf[]): VmRoles {
  const roles: VmRoles = { fields: {}, tables: [] };
  // fetch/decode prologue. Two common shapes:
  //   flat code array:  op = code[pc]          -> code/pc roles, the opcode IS the element
  //   instruction table: op = ins[3] / ins.k  -> inst/opField roles
  //   cached instruction: ins = code[pc]; op = ins[3]
  stmtsDeep(prologue, (s) => {
    for (const { t, v: val } of assignPairs(s)) {
      const tn = tname(t); const u = unparen(val);
      if (tn !== v) continue;
      if (u.type === 'IndexExpr' && nameOf(u.obj)) {
        if (u.index.type === 'NameExpr') { roles.code = nameOf(u.obj)!; roles.pc = u.index.name; }
        else { roles.inst = nameOf(u.obj)!; const k = numVal(u.index); roles.opField = k !== null ? String(k) : u.index.type === 'StringLit' ? u.index.value : undefined; }
      } else if (u.type === 'MemberExpr' && nameOf(u.obj)) { roles.inst = nameOf(u.obj)!; roles.opField = u.name; }
      else if (u.type === 'CallExpr') { const a = u.args.map(nameOf).find(Boolean); if (a) { roles.inst = a; roles.opField = 'bits'; } }
    }
  });
  if (roles.inst) stmtsDeep(prologue, (s) => {
    for (const { t, v: val } of assignPairs(s)) {
      const u = unparen(val);
      if (tname(t) === roles.inst && u.type === 'IndexExpr' && nameOf(u.obj) && nameOf(u.index)) { roles.code = nameOf(u.obj)!; roles.pc = nameOf(u.index)!; }
    }
  });
  // frequency fallbacks over the handler bodies
  const instCount = new Map<string, number>(), idxCount = new Map<string, number>();
  const pcCand = new Map<string, number>();
  for (const lf of leaves) { const loc = leafLocals(lf); walk(lf.body, (n: any) => {
    if (n.type === 'IndexExpr' && n.obj.type === 'NameExpr' && !loc.has(n.obj)) {
      if (numVal(n.index) !== null) instCount.set(n.obj.name, (instCount.get(n.obj.name) ?? 0) + 1);
      idxCount.set(n.obj.name, (idxCount.get(n.obj.name) ?? 0) + 1);
    }
    if (n.type === 'AssignStat' && n.targets.length === 1 && n.targets[0].type === 'NameExpr') {
      const val = unparen(n.values[0]);
      if (!loc.has(n.targets[0]) && val?.type === 'BinExpr' && val.op === '+' && nameOf(val.left) === n.targets[0].name) pcCand.set(n.targets[0].name, (pcCand.get(n.targets[0].name) ?? 0) + 1);
    }
  }); }
  const argmax = (m: Map<string, number>, skip: Set<string>) => { let best: string | undefined, bc = 0; for (const [k, c] of m) if (!skip.has(k) && c > bc) { best = k; bc = c; } return best; };
  // a flat code array has no instruction-table role: operands live in separate arrays
  if (!roles.inst && !roles.code) roles.inst = argmax(instCount, new Set([v]));
  if (!roles.pc) roles.pc = argmax(pcCand, new Set([v, roles.inst ?? '']));
  // the dispatch variable itself may be the instruction object (op = ins; ins[1], ins.k)
  if (!roles.inst) {
    let selfIdx = 0;
    for (const lf of leaves) { const loc = leafLocals(lf); walk(lf.body, (n: any) => {
      if ((n.type === 'IndexExpr' || n.type === 'MemberExpr') && nameOf(n.obj) === v && !loc.has(n.obj as any)) selfIdx++;
    }); }
    if (selfIdx >= 2 && roles.code && roles.pc) roles.inst = v;
  }
  // operand fields: inst[1] / inst.A / inst["x"] / inst[KEY] (KEY = free, never-written name)
  const fieldCount = new Map<string, number>();
  const written = new Set<string>();
  for (const lf of leaves) walk(lf.body, (n: any) => { if (n.type === 'AssignStat') for (const t of n.targets) { const nm = nameOf(t); if (nm) written.add(nm); } });
  const bump = (k: string) => fieldCount.set(k, (fieldCount.get(k) ?? 0) + 1);
  if (roles.inst) for (const lf of leaves) { const loc = leafLocals(lf); walk(lf.body, (n: any) => {
    if ((n.type === 'IndexExpr' || n.type === 'MemberExpr') && loc.has(n.obj)) return;
    if (n.type === 'IndexExpr' && nameOf(n.obj) === roles.inst) {
      const k = numVal(n.index);
      if (k !== null) bump(String(k));
      else if (n.index.type === 'StringLit') bump(n.index.value);
      else if (n.index.type === 'NameExpr' && !loc.has(n.index) && !written.has(n.index.name) && n.index.name !== roles.pc) bump('$' + n.index.name);
    }
    if (n.type === 'MemberExpr' && nameOf(n.obj) === roles.inst) bump(n.name);
  }); }
  if (roles.opField) fieldCount.delete(roles.opField);
  for (const [k, c] of fieldCount) if (k.startsWith('$') && c < 2) fieldCount.delete(k);
  // numeric keys keep their order (inst[2] = A, inst[3] = B ...); named keys by frequency
  const keys = [...fieldCount.keys()];
  const numeric = keys.filter(k => k !== '' && !isNaN(Number(k))).sort((a, b) => Number(a) - Number(b));
  const named = keys.filter(k => k === '' || isNaN(Number(k))).sort((a, b) => fieldCount.get(b)! - fieldCount.get(a)!);
  const used = new Set<string>();
  // short readable member names (A, B, C, f, s ...) are kept verbatim
  for (const k of named) if (/^[A-Za-z]\w?$/.test(k) && !['R', 'K', 'OP', 'pc'].includes(k)) { roles.fields[k] = k; used.add(k); }
  const LET = 'ABCDEFGHIJKLMNOPQSTUVWXYZ'.split('');
  let li = 0;
  const nextLetter = () => { while (li < LET.length && used.has(LET[li])) li++; const l = li < LET.length ? LET[li++] : 'F' + (li++); used.add(l); return l; };
  for (const k of [...numeric, ...named]) if (!roles.fields[k]) roles.fields[k] = nextLetter();
  // stack = table most often indexed by an operand-bearing expression
  const isOpRef = (e: any): boolean => { let hit = false; walk(e, (m: any) => { if (m.type === 'IndexExpr' && nameOf(m.obj) === roles.inst) hit = true; if (m.type === 'MemberExpr' && nameOf(m.obj) === roles.inst) hit = true; }); return hit; };
  const stackCount = new Map<string, number>();
  const tabStats = new Map<string, { reads: number; writes: number; handlers: Set<number> }>();
  leaves.forEach((lf, li) => {
    const loc = leafLocals(lf);
    walk(lf.body, (n: any, parent: any, key: any) => {
      if (n.type === 'IndexExpr' && n.obj.type === 'NameExpr' && !loc.has(n.obj) && n.obj.name !== roles.inst && n.obj.name !== roles.code) {
        const opIdx = isOpRef(n.index) || n.index.type === 'NameExpr' || n.index.type === 'BinExpr';
        if (opIdx) stackCount.set(n.obj.name, (stackCount.get(n.obj.name) ?? 0) + 1);
        if (isOpRef(n.index)) {
          const st = tabStats.get(n.obj.name) ?? { reads: 0, writes: 0, handlers: new Set<number>() };
          if (parent && parent.type === 'AssignStat' && key === 'targets') st.writes++; else st.reads++;
          st.handlers.add(li);
          tabStats.set(n.obj.name, st);
        }
      }
    });
  });
  roles.stack = argmax(stackCount, new Set([v, roles.inst ?? '', roles.code ?? '', roles.pc ?? '']));
  for (const [name, st] of tabStats) {
    if (name === roles.stack) continue;
    // read+write -> globals/upvalues; read-only used by few handlers -> env (GETGLOBAL); else constants
    const role = st.writes > 0 ? 'Env' : st.handlers.size <= 2 ? 'Env' : 'K';
    roles.tables.push({ name, reads: st.reads, writes: st.writes, role });
  }
  roles.tables.sort((a, b) => (b.reads + b.writes) - (a.reads + a.writes));
  return roles;
}

// -------------------------------------------------------------- lifting ----
const NAME = (name: string): A.NameExpr => ({ type: 'NameExpr', name });

/** rewrite a cloned handler body into register notation (scope-aware: only
 *  free names are role names; handler-local temporaries become t1, t2, ...) */
function liftBody(stmts: A.Stat[], roles: VmRoles): A.Stat[] {
  const body: A.Stat[] = structuredClone(stmts);
  const tabRename = new Map<string, string>();
  const roleSeen = new Map<string, number>();
  for (const t of roles.tables) { const c = roleSeen.get(t.role) ?? 0; roleSeen.set(t.role, c + 1); tabRename.set(t.name, c ? t.role + c : t.role); }
  const locals = localRefSet(body);
  const fieldName = (k: string) => roles.fields[k] ?? ('I' + k);
  const rewrite = (n: any): any => {
    if (!n || typeof n !== 'object') return n;
    if (Array.isArray(n)) { for (let i = 0; i < n.length; i++) n[i] = rewrite(n[i]); return n; }
    if ((n.type === 'IndexExpr' || n.type === 'MemberExpr') && locals.has(n.obj)) { if (n.type === 'IndexExpr') n.index = rewrite(n.index); return n; }
    if (n.type === 'IndexExpr' && nameOf(n.obj) === roles.inst) {
      const k = numVal(n.index);
      if (k !== null) return NAME(String(k) === roles.opField ? 'OP' : fieldName(String(k)));
      if (n.index.type === 'StringLit') return NAME(n.index.value === roles.opField ? 'OP' : fieldName(n.index.value));
      if (n.index.type === 'NameExpr' && !locals.has(n.index)) {
        const key = '$' + n.index.name;
        if (key === roles.opField) return NAME('OP');
        if (roles.fields[key]) return NAME(roles.fields[key]);
      }
    }
    if (n.type === 'MemberExpr' && nameOf(n.obj) === roles.inst) return NAME(n.name === roles.opField ? 'OP' : fieldName(n.name));
    if (n.type === 'NameExpr') {
      if (locals.has(n)) return n;
      if (n.name === roles.stack) return NAME('R');
      if (n.name === roles.pc) return NAME('pc');
      if (n.name === roles.code) return NAME('Code');
      if (n.name === roles.inst) return NAME('Inst');
      const t = tabRename.get(n.name); if (t) return NAME(t);
      return n;
    }
    for (const k of Object.keys(n)) if (k !== 'loc' && k !== 'type') n[k] = rewrite(n[k]);
    return n;
  };
  rewrite(body);
  const sc = analyzeScopes({ type: 'Chunk', body }); let k = 0;
  for (const b of sc.bindings) if (b.kind !== 'global') renameBinding(b, 't' + (++k));
  return body;
}

/** split lifted fused handlers at `pc = pc + 1; Inst = Code[pc]` advance points */
function splitSegments(body: A.Stat[]): A.Stat[][] {
  const segs: A.Stat[][] = [[]];
  for (const s of body) {
    const v0 = s.type === 'AssignStat' && s.targets.length === 1 && nameOf(s.targets[0]) === 'Inst' ? unparen(s.values[0]) : null;
    if (v0 && v0.type === 'IndexExpr' && nameOf(v0.obj) === 'Code') {
      const cur = segs[segs.length - 1];
      const last = cur[cur.length - 1];
      if (last && last.type === 'AssignStat' && nameOf(last.targets[0]) === 'pc') cur.pop();
      segs.push([]);
      continue;
    }
    segs[segs.length - 1].push(s);
  }
  return segs.filter(x => x.length);
}

/** display cleanup: inline temporaries that only hold operand expressions */
function inlineOps(segs: A.Stat[][], fieldNames: Set<string>): A.Stat[][] {
  const fields = new Set([...fieldNames, 'OP']);
  const opOnly = (e: A.Expr): boolean => { const u = unparen(e); return (u.type === 'NameExpr' && fields.has(u.name)) || u.type === 'NumberLit' || (u.type === 'BinExpr' && ['+', '-'].includes(u.op) && opOnly(u.left) && opOnly(u.right)); };
  const firstUse = (nm: string, stmts: A.Stat[]): 'read' | 'write' | null => {
    let res: 'read' | 'write' | null = null;
    for (const st of stmts) {
      if (res) break;
      if (st.type === 'AssignStat') {
        let read = false;
        walk(st.values, (m: any) => { if (m.type === 'NameExpr' && m.name === nm) read = true; });
        for (const t of st.targets) if (t.type !== 'NameExpr') walk(t, (m: any) => { if (m.type === 'NameExpr' && m.name === nm) read = true; });
        if (read) res = 'read'; else if (st.targets.some(t => nameOf(t) === nm)) res = 'write';
      } else { let hit = false; walk(st, (m: any) => { if (m.type === 'NameExpr' && m.name === nm) hit = true; }); if (hit) res = 'read'; }
    }
    return res;
  };
  segs.forEach((seg, si) => {
    for (let i = 0; i < seg.length; i++) {
      const s = seg[i];
      let nm: string | null = null, init: A.Expr | null = null;
      if (s.type === 'LocalStat' && s.names.length === 1 && s.init.length === 1 && opOnly(s.init[0])) { nm = s.names[0]; init = s.init[0]; }
      else if (s.type === 'AssignStat' && !s.op && s.targets.length === 1 && s.values.length === 1 && s.targets[0].type === 'NameExpr' && /^t\d+$/.test(s.targets[0].name) && opOnly(s.values[0])) { nm = s.targets[0].name; init = s.values[0]; }
      if (!nm || !init) continue;
      const rest = seg.slice(i + 1);
      let rewritten = false;
      walk(rest, (m: any) => { if (m.type === 'AssignStat') for (const t of m.targets) if (nameOf(t) === nm) rewritten = true; });
      if (rewritten) continue;
      // later instructions must not read the temp before redefining it
      let safe = true;
      for (const later of segs.slice(si + 1)) { const u = firstUse(nm, later); if (u === 'read') { safe = false; break; } if (u === 'write') break; }
      if (!safe) continue;
      const sub = (n: any): any => {
        if (!n || typeof n !== 'object') return n;
        if (Array.isArray(n)) { for (let j = 0; j < n.length; j++) n[j] = sub(n[j]); return n; }
        if (n.type === 'NameExpr' && n.name === nm) return structuredClone(init);
        for (const k of Object.keys(n)) if (k !== 'loc' && k !== 'type') n[k] = sub(n[k]);
        return n;
      };
      for (let j = i + 1; j < seg.length; j++) seg[j] = sub(seg[j]);
      seg.splice(i, 1); i--;
    }
    // drop bare `local t1, t2` declarations (display noise)
    for (let i = seg.length - 1; i >= 0; i--) { const s = seg[i]; if (s.type === 'LocalStat' && !s.init.length && s.names.every(n => /^t\d+$/.test(n))) seg.splice(i, 1); }
  });
  return segs.filter(x => x.length);
}

// ------------------------------------------------------- classification ----
const ARITH: Record<string, string> = { '+': 'ADD', '-': 'SUB', '*': 'MUL', '/': 'DIV', '%': 'MOD', '^': 'POW', '..': 'CONCAT', '//': 'IDIV' };
const CMPN: Record<string, string> = { '==': 'EQ', '~=': 'EQ', '<': 'LT', '>': 'LT', '<=': 'LE', '>=': 'LE' };

function classify(seg: A.Stat[], fieldNames: Set<string>): { name: string; conf: number } {
  const isReg = (e: A.Expr | undefined) => { const u = e && unparen(e); return !!u && u.type === 'IndexExpr' && nameOf(u.obj) === 'R'; };
  const isOp = (e: A.Expr | undefined): boolean => { const u = e && unparen(e); if (!u) return false; if (u.type === 'NameExpr') return fieldNames.has(u.name); if (u.type === 'BinExpr' && (u.op === '+' || u.op === '-')) return isOp(u.left) || isOp(u.right); return false; };
  const isK = (e: A.Expr | undefined) => { const u = e && unparen(e); return !!u && (isOp(u) || u.type === 'NumberLit' || u.type === 'StringLit' || (u.type === 'IndexExpr' && /^K\d*$/.test(nameOf(u.obj) ?? ''))); };
  const has = (pred: (n: any) => boolean) => { let hit = false; walk(seg, (n: any) => { if (!hit && pred(n)) hit = true; }); return hit; };
  const callOnReg = (n: any) => (n.type === 'CallExpr' && isReg(n.callee)) || (n.type === 'MethodCallExpr' && isReg(n.obj));
  const pcWrite = (stmts: A.Stat[]) => { let hit = false; stmtsDeep(stmts, s => { if (s.type === 'AssignStat' && s.targets.some(t => nameOf(t) === 'pc')) hit = true; }); return hit; };
  const top = seg;
  // returns
  const ret = top.find(s => s.type === 'ReturnStat') as A.ReturnStat | undefined;
  let retDeep: A.ReturnStat | undefined; stmtsDeep(top, s => { if (!retDeep && s.type === 'ReturnStat') retDeep = s; });
  if (ret || (retDeep && !pcWrite(top))) {
    const r = (ret ?? retDeep)!;
    if (r.args.length === 1 && callOnReg(unparen(r.args[0]))) return { name: 'TAILCALL', conf: 0.8 };
    return { name: 'RETURN', conf: ret ? 0.85 : 0.6 };
  }
  // conditional jumps / loops
  const ifs = top.find(s => s.type === 'IfStat' && (pcWrite(s.clauses.flatMap(c => c.body)) || pcWrite(s.elseBody ?? []))) as A.IfStat | undefined;
  if (ifs) {
    const forStep = top.some(s => s.type === 'AssignStat' && isReg(s.targets[0]) && unparen(s.values[0])?.type === 'BinExpr' && (unparen(s.values[0]) as A.BinExpr).op === '+' && isReg((unparen(s.values[0]) as A.BinExpr).left));
    if (forStep) return { name: 'FORLOOP', conf: 0.75 };
    if (has(callOnReg)) return { name: 'TFORLOOP', conf: 0.65 };
    let c = unparen(ifs.clauses[0].cond); let neg = false;
    if (c.type === 'UnExpr' && c.op === 'not') { c = unparen(c.expr); neg = true; }
    if (c.type === 'BinExpr' && CMPN[c.op]) {
      const k = isK(c.left) || isK(c.right);
      return { name: CMPN[c.op] + (k ? 'K' : '') + (c.op === '~=' ? ' (not)' : ''), conf: 0.8 };
    }
    if (isReg(c)) {
      const sets = ifs.clauses[0].body.some(s => s.type === 'AssignStat' && isReg(s.targets[0]));
      return { name: (sets ? 'TESTSET' : 'TEST') + (neg ? ' (not)' : ''), conf: 0.75 };
    }
    return { name: 'COND-JMP', conf: 0.45 };
  }
  if (has(callOnReg)) return { name: 'CALL', conf: 0.8 };
  // SELF: R[A+1] = R[B]; R[A] = R[B][C]   (possibly through a temp local)
  const assigns = top.filter(s => s.type === 'AssignStat' || (s.type === 'LocalStat' && s.init.length)) as Array<A.AssignStat | A.LocalStat>;
  if (assigns.length >= 2 && assigns.length <= 4) {
    const regT = assigns.filter(s => s.type === 'AssignStat' && isReg(s.targets[0])) as A.AssignStat[];
    const plus1 = regT.some(s => { const i = unparen((s.targets[0] as A.IndexExpr).index); return i.type === 'BinExpr' && i.op === '+' && numVal(i.right) === 1; });
    const getIdx = regT.some(s => unparen(s.values[0]).type === 'IndexExpr');
    if (plus1 && getIdx && regT.length === 2) return { name: 'SELF', conf: 0.8 };
  }
  // loops
  const loop = top.find(s => s.type === 'NumericForStat' || s.type === 'WhileStat' || s.type === 'GenericForStat') as any;
  if (loop) {
    let setlist = false, nilfill = false, vararg = false, pcInc = false;
    stmtsDeep(loop.body, s => {
      if (s.type === 'AssignStat') {
        const t = unparen(s.targets[0]); const v = unparen(s.values[0]);
        if (t.type === 'IndexExpr' && isReg(t.obj)) setlist = true;
        if (isReg(t) && v?.type === 'NilLit') nilfill = true;
        if (isReg(t) && v?.type === 'IndexExpr' && !isReg(v)) vararg = true;
        if (nameOf(t) === 'pc') pcInc = true;
      }
    });
    if (pcInc || has((n: any) => n.type === 'FunctionExpr')) return { name: 'CLOSURE', conf: 0.65 };
    if (setlist) return { name: 'SETLIST', conf: 0.7 };
    if (nilfill) return { name: 'LOADNIL', conf: 0.75 };
    if (vararg) return { name: 'VARARG', conf: 0.55 };
  }
  if (has((n: any) => n.type === 'FunctionExpr')) return { name: 'CLOSURE', conf: 0.7 };
  if (has((n: any) => n.type === 'VarargLit')) return { name: 'VARARG', conf: 0.6 };
  // main effect: last assignment
  const main = [...assigns].reverse().find(s => s.type === 'AssignStat') as A.AssignStat | undefined;
  if (main) {
    const t = unparen(main.targets[0]); const v = unparen(main.values[main.values.length - 1] ?? main.values[0]);
    if (nameOf(t) === 'pc') return { name: 'JMP', conf: 0.85 };
    if (isReg(t) && v) {
      if (isReg(v)) return { name: 'MOVE', conf: 0.9 };
      if (v.type === 'TrueLit' || v.type === 'FalseLit') return { name: 'LOADBOOL', conf: 0.8 };
      if (v.type === 'NilLit') return { name: 'LOADNIL', conf: 0.8 };
      if (v.type === 'NumberLit' || v.type === 'StringLit' || isOp(v)) return { name: 'LOADK', conf: 0.75 };
      if (v.type === 'IndexExpr') {
        if (isReg(v.obj)) return { name: 'GETTABLE' + (isK(v.index) ? 'K' : ''), conf: 0.85 };
        const tn = nameOf(v.obj) ?? '';
        if (/^K\d*$/.test(tn)) return { name: 'LOADK', conf: 0.6 };
        if (/^Env\d*$/.test(tn)) return { name: 'GETGLOBAL', conf: 0.6 };
        return { name: 'GETUPVAL', conf: 0.45 };
      }
      if (v.type === 'MemberExpr' && isReg(v.obj)) return { name: 'GETTABLEK', conf: 0.8 };
      if (v.type === 'BinExpr' && ARITH[v.op]) return { name: ARITH[v.op] + ((isK(v.left) || isK(v.right)) ? 'K' : ''), conf: 0.85 };
      if (v.type === 'BinExpr' && CMPN[v.op]) return { name: 'CMP→BOOL', conf: 0.5 };
      if (v.type === 'UnExpr') return { name: v.op === '-' ? 'UNM' : v.op === 'not' ? 'NOT' : v.op === '#' ? 'LEN' : 'UNOP', conf: 0.85 };
      if (v.type === 'TableExpr') return { name: 'NEWTABLE', conf: 0.85 };
      if (v.type === 'CallExpr' || v.type === 'MethodCallExpr') return { name: 'CALL?', conf: 0.4 };
    }
    if (t.type === 'IndexExpr' && isReg(t.obj)) return { name: 'SETTABLE' + (isK(t.index) ? 'K' : ''), conf: 0.85 };
    if (t.type === 'MemberExpr' && isReg(t.obj)) return { name: 'SETTABLEK', conf: 0.8 };
    if (t.type === 'IndexExpr') {
      const tn = nameOf(t.obj) ?? '';
      if (/^Env\d*$/.test(tn)) return { name: 'SETGLOBAL', conf: 0.6 };
      return { name: 'SETUPVAL', conf: 0.45 };
    }
  }
  if (top.some(s => s.type === 'CallStat')) return { name: 'CALL?', conf: 0.35 };
  return { name: '?', conf: 0.1 };
}

// ----------------------------------------------------------------- main ----
const printStats = (stmts: A.Stat[], cap = 6000) => { const s = print({ type: 'Chunk', body: stmts }); return s.length > cap ? s.slice(0, cap) + '\n-- …truncated (' + s.length + ' chars)' : s; };

/** numeric values an expression can evaluate to (`c and K1 or K2` -> K1, K2) */
function constResults(e: A.Expr, out: number[]): void {
  const u = unparen(e);
  const k = numVal(u);
  if (k !== null) { out.push(k); return; }
  if (u.type === 'BinExpr' && u.op === 'and') { constResults(u.right, out); return; }
  if (u.type === 'BinExpr' && u.op === 'or') { constResults(u.left, out); constResults(u.right, out); return; }
}
function mentionsName(e: A.Expr, v: string): boolean { let hit = false; walk(e, (n: any) => { if (n.type === 'NameExpr' && n.name === v) hit = true; }); return hit; }
function assignsConst(stmts: A.Stat[], v: string): number[] {
  const out: number[] = [];
  walk(stmts, (n: any) => {
    if (n.type === 'AssignStat') n.targets.forEach((t: A.Expr, i: number) => { if (nameOf(t) === v && n.values[i]) constResults(n.values[i], out); });
  });
  return out;
}

function buildTree(id: number, root: A.IfStat, v: string, leaves: RawLeaf[], ks: number[], prologue: A.Stat[], inLoop: boolean, preLoop: A.Stat[], loopCond?: A.Expr): DispatchTree {
  const minK = Math.min(...ks), maxK = Math.max(...ks);
  const roles = detectRoles(v, prologue, leaves);
  const fetch = !!(roles.code && roles.pc);
  const cffLeaves = leaves.filter(l => assignsConst(l.body, v).length > 0).length;
  const fieldCount = Object.keys(roles.fields).length;
  let kind: DispatchTree['kind'] = 'switch';
  if (fetch && roles.stack && fieldCount >= 1) kind = 'vm';
  else if (cffLeaves >= Math.max(2, leaves.length * 0.4)) kind = 'cff';
  else if (loopCond && cffLeaves >= Math.max(2, leaves.length * 0.1) && mentionsName(loopCond, v)) kind = 'cff';
  else if (roles.inst && roles.stack && fieldCount >= 2) kind = 'vm';
  // flat bytecode arrays (`op = code[pc]`, operands in separate tables) have no instruction-table
  // fields; a loop dispatch on a freshly fetched element is still an interpreter
  else if (fetch && roles.stack && leaves.length >= 8) kind = 'vm';
  if (kind !== 'vm') roles.fields = {};
  if (kind === 'cff') { roles.inst = roles.code = roles.pc = roles.stack = roles.opField = undefined; roles.tables = []; }
  const fieldNames = new Set(Object.values(roles.fields));
  const handlers: HandlerInfo[] = leaves.map((lf, index) => {
    const { ops, text } = enumerate(lf.c, minK, maxK);
    const h: HandlerInfo = { index, opcodes: ops, rangeText: text, line: lf.line, pos: lf.body[0]?.loc?.start ?? 0, stmts: lf.body.length, shape: shapeHash(lf.body), code: printStats(lf.body), lifted: '', guess: '', confidence: 0, segments: [] };
    if (kind === 'vm') {
      const lifted = inlineOps(splitSegments(liftBody(lf.body, roles)), fieldNames);
      const cls = lifted.map(l => classify(l, fieldNames));
      h.segments = cls.map(c => c.name);
      h.guess = cls.length > 1 ? 'SUPER[' + cls.map(c => c.name).join(' + ') + ']' : (cls[0]?.name ?? '?');
      h.confidence = cls.length ? Math.round(Math.min(...cls.map(c => c.conf)) * 100) / 100 : 0;
      h.lifted = lifted.map((l, i) => (lifted.length > 1 ? '-- [' + (i + 1) + '] ' + h.segments[i] + '\n' : '') + printStats(l, 3000)).join(lifted.length > 1 ? '-- next instruction\n' : '');
    } else if (kind === 'cff') {
      h.successors = [...new Set(assignsConst(lf.body, v))];
      h.guess = h.successors.length === 0 ? 'EXIT/NOSTATE' : h.successors.length === 1 ? 'GOTO ' + h.successors[0] : 'BRANCH ' + h.successors.join('|');
      h.confidence = 0.7;
    } else { h.guess = 'case'; h.confidence = 0.3; }
    return h;
  });
  let entryState: number | undefined;
  if (kind === 'cff') for (let i = preLoop.length - 1; i >= 0 && entryState === undefined; i--) {
    for (const { t, v: val } of assignPairs(preLoop[i])) if (tname(t) === v) { const ks: number[] = []; constResults(val, ks); if (ks.length) entryState = ks[0]; }
  }
  const score = leaves.length * (inLoop ? 2 : 1) * (kind === 'vm' ? 3 : kind === 'cff' ? 2 : 1);
  return { id, line: root.loc?.line ?? 0, var: v, kind, leaves: leaves.length, minOp: minK, maxOp: maxK, inLoop, score, roles, handlers, entryState };
}

export function extractOpcodes(chunk: A.Chunk, opts: { minLeaves?: number; maxTrees?: number } = {}): OpcodeReport {
  const minLeaves = opts.minLeaves ?? 4;
  const consumed = new Set<any>();
  const trees: DispatchTree[] = [];
  const notes: string[] = [];
  interface Ctx { loopBody: A.Stat[] | null; loopIdx: { i: number }; preLoop: A.Stat[]; loopCond?: A.Expr; }

  function visitList(list: A.Stat[], ctx: Ctx, isLoopBody: boolean) {
    for (let i = 0; i < list.length; i++) {
      if (isLoopBody) ctx.loopIdx.i = i;
      const s = list[i];
      if (s.type === 'IfStat' && !consumed.has(s)) {
        const v = cmpVar(s.clauses[0].cond);
        if (v) {
          const leaves: RawLeaf[] = []; const ks: number[] = []; const local = new Set<any>();
          flatten(s, v, { lo: -Infinity, hi: Infinity, excl: new Set() }, leaves, local, ks);
          if (leaves.length >= minLeaves) {
            for (const x of local) consumed.add(x);
            const prologue = ctx.loopBody ? ctx.loopBody.slice(0, ctx.loopIdx.i) : list.slice(0, i);
            trees.push(buildTree(trees.length, s, v, leaves, ks, prologue, !!ctx.loopBody, ctx.preLoop, ctx.loopCond));
          }
        }
      }
      visitStat(s, ctx, list, i);
    }
  }
  function visitStat(s: A.Stat, ctx: Ctx, list: A.Stat[], i: number) {
    const loopCtx = (body: A.Stat[]): Ctx => ({ loopBody: body, loopIdx: { i: 0 }, preLoop: list.slice(0, i), loopCond: (s as any).cond });
    switch (s.type) {
      case 'WhileStat': case 'RepeatStat': case 'NumericForStat': case 'GenericForStat':
        visitExprs(s); visitList((s as any).body, loopCtx((s as any).body), true); break;
      case 'DoStat': visitList(s.body, ctx, false); break;
      case 'IfStat': for (const c of s.clauses) visitList(c.body, ctx, false); if (s.elseBody) visitList(s.elseBody, ctx, false); visitExprs(s); break;
      case 'LocalFunctionStat': case 'FunctionStat': visitFn(s.func); break;
      default: visitExprs(s);
    }
  }
  function visitFn(f: A.FunctionExpr) { visitList(f.body, { loopBody: null, loopIdx: { i: 0 }, preLoop: [] }, false); }
  function visitExprs(s: any) {
    // find function expressions inside expressions (not inside nested statement lists)
    const scan = (n: any) => {
      if (!n || typeof n !== 'object') return;
      if (Array.isArray(n)) { for (const x of n) scan(x); return; }
      if (n.type === 'FunctionExpr') { visitFn(n); return; }
      for (const k of Object.keys(n)) { if (k === 'loc' || k === 'body' || k === 'elseBody' || k === 'clauses') continue; scan(n[k]); }
      if (n.type === 'IfStat') for (const c of n.clauses) scan(c.cond);
    };
    scan(s);
  }
  visitList(chunk.body, { loopBody: null, loopIdx: { i: 0 }, preLoop: [] }, false);

  // table-of-functions dispatch: { [1] = function .. end, ... } / T[k] = function
  walk(chunk, (n: any) => {
    if (n.type !== 'TableExpr' || n.fields.length < 8) return;
    const fns = n.fields.filter((f: A.TableField) => f.value.type === 'FunctionExpr');
    if (fns.length < 8 || fns.length < n.fields.length * 0.8) return;
    const leaves: RawLeaf[] = []; const ks: number[] = [];
    let pos = 0;
    for (const f of n.fields as A.TableField[]) {
      if (f.kind === 'item') pos++;
      if (f.value.type !== 'FunctionExpr') continue;
      const k = f.kind === 'item' ? pos : f.kind === 'keyed' ? numVal(f.key!) : null;
      if (k === null) continue;
      ks.push(k);
      leaves.push({ c: { lo: k, hi: k, excl: new Set() }, body: (f.value as A.FunctionExpr).body, line: f.value.loc?.line ?? 0 });
    }
    if (leaves.length >= 8) {
      const fake: A.IfStat = { type: 'IfStat', clauses: [], loc: n.loc };
      const t = buildTree(trees.length, fake, '<table>', leaves, ks, [], true, []);
      if (t.kind === 'switch') { t.kind = 'vm'; }
      trees.push(t);
    }
  });

  trees.sort((a, b) => b.score - a.score);
  const max = opts.maxTrees ?? 40;
  if (trees.length > max) { notes.push(`${trees.length} dispatch trees found, showing top ${max}`); trees.length = max; }
  trees.forEach((t, i) => t.id = i);
  const vm = trees.find(t => t.kind === 'vm');
  if (vm) notes.push(`VM dispatcher @L${vm.line} on '${vm.var}': ${vm.leaves} handlers, opcodes ${vm.minOp}..${vm.maxOp}; roles inst=${vm.roles.inst ?? '?'} stack=${vm.roles.stack ?? '?'} pc=${vm.roles.pc ?? '?'}`);
  const cff = trees.filter(t => t.kind === 'cff');
  if (cff.length) notes.push(`${cff.length} control-flow-flattening state machine(s); largest has ${cff[0].leaves} blocks`);
  if (!trees.length) notes.push('no numeric dispatch trees found (try lowering minLeaves, or the VM dispatches via a table/function list)');
  return { trees, notes };
}

/** Compact, copy-friendly text rendering of one dispatch tree. */
export function formatOpcodeTree(t: DispatchTree, opts: { code?: boolean; lifted?: boolean } = {}): string {
  const lines: string[] = [];
  lines.push(`-- dispatch tree #${t.id} @L${t.line} var=${t.var} kind=${t.kind} handlers=${t.leaves} range=${t.minOp}..${t.maxOp}` + (t.entryState !== undefined ? ` entry=${t.entryState}` : ''));
  const r = t.roles;
  lines.push(`-- roles: inst=${r.inst ?? '?'} code=${r.code ?? '?'} pc=${r.pc ?? '?'} stack=${r.stack ?? '?'} opField=${r.opField ?? '?'} fields=${Object.entries(r.fields).map(([k, v]) => k + '→' + v).join(',')}`);
  for (const tb of r.tables) lines.push(`--   table ${tb.name}: reads=${tb.reads} writes=${tb.writes} → ${tb.role}`);
  for (const h of t.handlers) {
    lines.push(`[${h.rangeText}] ${h.guess} (conf ${h.confidence}) L${h.line} stmts=${h.stmts} shape=${h.shape}` + (h.successors ? ' → ' + h.successors.join(',') : ''));
    if (opts.lifted && h.lifted) lines.push(h.lifted.replace(/^/gm, '    '));
    if (opts.code) lines.push(h.code.replace(/^/gm, '    '));
  }
  return lines.join('\n');
}
