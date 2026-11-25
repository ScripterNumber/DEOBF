// Scope-aware cleanup passes: constant/alias propagation, dead-local removal,
// smart renaming. All universal — they rely only on Lua scoping semantics.
import type * as A from '../ast.js';
import { analyzeScopes, renameBinding, Binding, ScopeInfo } from '../analysis/scope.js';
import { KEYWORDS } from '../lexer.js';

const LIT = new Set(['NumberLit', 'StringLit', 'TrueLit', 'FalseLit', 'NilLit']);

function unparen(e: A.Expr): A.Expr { while (e.type === 'ParenExpr') e = e.expr; return e; }

function cloneLit(e: A.Expr): A.Expr { const c: any = { ...e }; delete c.loc; return c; }
function cloneExpr<T>(e: T): T { return structuredClone(e); }

/** member chain rooted at a global name: string.byte / math.floor / bit32.bxor */
function globalChain(e: A.Expr, scope: ScopeInfo): { root: string; chain: string[] } | null {
  const parts: string[] = [];
  let cur: A.Expr = e;
  while (cur.type === 'MemberExpr') { parts.unshift(cur.name); cur = cur.obj; }
  if (cur.type !== 'NameExpr') return null;
  const b = scope.refOf.get(cur);
  if (!b || b.kind !== 'global' || b.writes > 0) return null;
  return { root: cur.name, chain: parts };
}

export interface PropStats { propagated: number; aliases: number; }

/** Inline literal-valued, never-reassigned locals and pure global/local aliases. */
export function propagateConstants(chunk: A.Chunk, opts: { maxString?: number } = {}): PropStats {
  const maxStr = opts.maxString ?? 64;
  const scope = analyzeScopes(chunk);
  const nameCount = new Map<string, number>();
  for (const b of scope.bindings) nameCount.set(b.name, (nameCount.get(b.name) ?? 0) + 1);
  const localNames = new Set(scope.bindings.filter(b => b.kind !== 'global').map(b => b.name));
  let propagated = 0, aliases = 0;
  for (const b of scope.bindings) {
    if (b.kind !== 'local' || b.writes > 0 || !b.init || b.initMulti || b.reads === 0) continue;
    const init = unparen(b.init);
    if (LIT.has(init.type)) {
      if (init.type === 'StringLit' && init.value.length > maxStr) continue;
      if (init.type === 'NumberLit' && !Number.isFinite(init.value)) continue;
      for (const r of b.refs) { const lit = cloneLit(init); for (const k of Object.keys(r)) if (k !== 'loc') delete (r as any)[k]; Object.assign(r, lit); }
      propagated += b.refs.length; b.reads = 0; b.refs = [];
      continue;
    }
    // alias of a never-written, uniquely named local
    if (init.type === 'NameExpr') {
      const c = scope.refOf.get(init);
      if (!c) continue;
      if (c.kind === 'global') {
        if (c.writes > 0 || localNames.has(c.name)) continue;
      } else {
        if (c.writes > 0 || (nameCount.get(c.name) ?? 0) !== 1) continue;
      }
      for (const r of b.refs) { r.name = c.name; c.refs.push(r); scope.refOf.set(r, c); }
      aliases += b.refs.length; b.reads = 0; b.refs = [];
      continue;
    }
    // alias of a global member chain: local f = string.byte
    if (init.type === 'MemberExpr') {
      const g = globalChain(init, scope);
      if (!g || localNames.has(g.root)) continue;
      for (const r of b.refs) { const e: any = cloneExpr(init); for (const k of Object.keys(r)) if (k !== 'loc') delete (r as any)[k]; Object.assign(r, e, { loc: r.loc }); }
      aliases += b.refs.length; b.reads = 0; b.refs = [];
    }
  }
  return { propagated, aliases };
}

function isPure(e: A.Expr): boolean {
  switch (e.type) {
    case 'NumberLit': case 'StringLit': case 'TrueLit': case 'FalseLit': case 'NilLit': case 'VarargLit':
    case 'NameExpr': case 'FunctionExpr': return true;
    case 'ParenExpr': return isPure(e.expr);
    case 'UnExpr': return isPure(e.expr);
    case 'BinExpr': return isPure(e.left) && isPure(e.right);
    case 'MemberExpr': return e.obj.type === 'NameExpr';
    case 'IndexExpr': return e.obj.type === 'NameExpr' && isPure(e.index);
    case 'TableExpr': return e.fields.every(f => (!f.key || isPure(f.key)) && isPure(f.value));
    default: return false;
  }
}

/** Visit every statement list in the tree (chunk, blocks, function bodies). */
export function forEachStatList(node: any, fn: (list: A.Stat[]) => void) {
  const seen = new Set<any>();
  const visit = (n: any) => {
    if (!n || typeof n !== 'object' || seen.has(n)) return;
    seen.add(n);
    if (Array.isArray(n)) { for (const x of n) visit(x); return; }
    for (const k of Object.keys(n)) {
      if (k === 'loc') continue;
      const v = n[k];
      if ((k === 'body' || k === 'elseBody') && Array.isArray(v)) { fn(v); }
      if (v && typeof v === 'object') visit(v);
    }
  };
  visit(node);
}

export interface DeadLocalStats { removedLocals: number; removedAssigns: number; }

/** Remove locals that are never read (keeping side-effecting calls). */
export function removeDeadLocals(chunk: A.Chunk): DeadLocalStats {
  const scope = analyzeScopes(chunk);
  let removedLocals = 0, removedAssigns = 0;
  // reads that only feed the variable itself (x = x + 1, x -= x) do not keep it alive
  const selfReads = new Map<Binding, number>();
  const countSelf = (n: any) => {
    if (!n || typeof n !== 'object') return;
    if (Array.isArray(n)) { for (const x of n) countSelf(x); return; }
    if (n.type === 'AssignStat' && n.targets.length && n.targets.every((t: A.Expr) => t.type === 'NameExpr')) {
      const b0 = scope.refOf.get(n.targets[0]);
      if (b0 && b0.kind !== 'global' && n.targets.every((t: A.NameExpr) => scope.refOf.get(t) === b0)) {
        let c = n.op ? n.targets.length : 0;
        const cnt = (m: any) => { if (!m || typeof m !== 'object') return; if (Array.isArray(m)) { for (const y of m) cnt(y); return; } if (m.type === 'NameExpr' && scope.refOf.get(m) === b0) c++; if (m.type === 'FunctionExpr') return; for (const k of Object.keys(m)) if (k !== 'loc') cnt(m[k]); };
        cnt(n.values);
        if (c) selfReads.set(b0, (selfReads.get(b0) ?? 0) + c);
      }
    }
    for (const k of Object.keys(n)) if (k !== 'loc') countSelf(n[k]);
  };
  countSelf(chunk);
  const liveReads = (b: Binding) => b.reads - (selfReads.get(b) ?? 0);
  const deadWrite = new Set<A.NameExpr>();
  for (const b of scope.bindings) if ((b.kind === 'local' || b.kind === 'localfn') && liveReads(b) === 0) for (const w of b.writeRefs) deadWrite.add(w);
  // phase 1: drop pure assignments whose targets are all dead locals
  const removedWrites = new Set<A.NameExpr>();
  forEachStatList(chunk, (list) => {
    for (let i = list.length - 1; i >= 0; i--) {
      const s = list[i];
      if (s.type === 'AssignStat' && s.targets.every(t => t.type === 'NameExpr' && deadWrite.has(t)) && s.values.every(isPure)) {
        for (const t of s.targets) removedWrites.add(t as A.NameExpr);
        list.splice(i, 1); removedAssigns++;
      }
    }
  });
  // phase 2: drop declarations whose bindings are unread and have no surviving writes
  const byDecl = new Map<any, Binding[]>();
  for (const b of scope.bindings) if (b.decl) { const a = byDecl.get(b.decl) ?? []; a.push(b); byDecl.set(b.decl, a); }
  const gone = (b: Binding) => liveReads(b) === 0 && b.writeRefs.every(w => removedWrites.has(w));
  forEachStatList(chunk, (list) => {
    for (let i = list.length - 1; i >= 0; i--) {
      const s = list[i];
      if (s.type === 'LocalStat') {
        const bs = byDecl.get(s) ?? [];
        if (bs.length !== s.names.length || !bs.every(gone)) continue;
        if (s.init.every(isPure)) { list.splice(i, 1); removedLocals++; continue; }
        if (s.init.length === 1 && (s.init[0].type === 'CallExpr' || s.init[0].type === 'MethodCallExpr')) {
          list[i] = { type: 'CallStat', expr: s.init[0] as any, loc: s.loc }; removedLocals++; continue;
        }
      } else if (s.type === 'LocalFunctionStat') {
        const bs = byDecl.get(s) ?? [];
        if (bs.length && bs.every(b => b.reads === 0 && b.writes === 0)) { list.splice(i, 1); removedLocals++; }
      }
    }
  });
  return { removedLocals, removedAssigns };
}
