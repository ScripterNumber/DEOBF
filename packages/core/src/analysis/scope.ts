// PRISM scope resolver — binds every identifier occurrence to its declaration.
// Lua block scoping rules: `local` names become visible after their statement,
// `local function` is visible inside its own body, `repeat ... until cond` sees
// the body's locals, for-loop variables live in the loop scope.
import type * as A from '../ast.js';

export type BindingKind = 'local' | 'localfn' | 'param' | 'for' | 'global';

export interface Binding {
  id: number;
  name: string;
  kind: BindingKind;
  line: number;
  /** declaring node: LocalStat | LocalFunctionStat | FunctionExpr | NumericForStat | GenericForStat */
  decl: any;
  /** position inside the declaring node's name/param list */
  index: number;
  /** the initializer expression for `local x = <init>` (single-value position), if any */
  init?: A.Expr;
  /** true when the init is the last expression of a multi-value init (call/vararg) */
  initMulti?: boolean;
  reads: number;
  writes: number;
  refs: A.NameExpr[];
  writeRefs: A.NameExpr[];
  /** referenced from a function nested inside the declaring function */
  captured: boolean;
  capturedWrite: boolean;
  fn: A.FunctionExpr | A.Chunk;
  /** functions containing assignments to this binding */
  writeFns: Set<A.FunctionExpr | A.Chunk>;
}

export interface ScopeInfo {
  bindings: Binding[];
  globals: Map<string, Binding>;
  refOf: Map<A.NameExpr, Binding>;
  /** bindings declared directly by each function (params + body locals) */
  fnBindings: Map<A.FunctionExpr | A.Chunk, Binding[]>;
  /** names of any binding (local or global) — for collision-free renaming */
  allNames: Set<string>;
}

export function analyzeScopes(chunk: A.Chunk): ScopeInfo {
  const bindings: Binding[] = [];
  const globals = new Map<string, Binding>();
  const refOf = new Map<A.NameExpr, Binding>();
  const fnBindings = new Map<A.FunctionExpr | A.Chunk, Binding[]>();
  const allNames = new Set<string>();
  const scopes: Array<Map<string, Binding>> = [];
  const fnStack: Array<A.FunctionExpr | A.Chunk> = [];

  const cur = () => fnStack[fnStack.length - 1];
  function declare(name: string, kind: BindingKind, decl: any, index: number, line: number): Binding {
    const b: Binding = { id: bindings.length, name, kind, line, decl, index, reads: 0, writes: 0, refs: [], writeRefs: [], captured: false, capturedWrite: false, fn: cur(), writeFns: new Set() };
    bindings.push(b);
    scopes[scopes.length - 1].set(name, b);
    fnBindings.get(cur())!.push(b);
    allNames.add(name);
    return b;
  }
  function resolve(n: A.NameExpr, write: boolean) {
    let b: Binding | undefined;
    for (let i = scopes.length - 1; i >= 0; i--) { const hit = scopes[i].get(n.name); if (hit) { b = hit; break; } }
    if (!b) {
      b = globals.get(n.name);
      if (!b) {
        b = { id: bindings.length, name: n.name, kind: 'global', line: n.loc?.line ?? 0, decl: null, index: 0, reads: 0, writes: 0, refs: [], writeRefs: [], captured: false, capturedWrite: false, fn: chunk, writeFns: new Set() };
        bindings.push(b); globals.set(n.name, b); allNames.add(n.name);
      }
    }
    refOf.set(n, b);
    b.refs.push(n);
    if (write) { b.writes++; b.writeRefs.push(n); b.writeFns.add(cur()); } else b.reads++;
    if (b.kind !== 'global' && b.fn !== cur()) { b.captured = true; if (write) b.capturedWrite = true; }
  }

  function block(body: A.Stat[]) { scopes.push(new Map()); for (const s of body) stat(s); scopes.pop(); }
  function func(f: A.FunctionExpr) {
    fnStack.push(f); fnBindings.set(f, []); scopes.push(new Map());
    f.params.forEach((p, i) => declare(p, 'param', f, i, f.loc?.line ?? 0));
    for (const s of f.body) stat(s);
    scopes.pop(); fnStack.pop();
  }
  function target(t: A.Expr, alsoRead: boolean) {
    if (t.type === 'NameExpr') { if (alsoRead) resolve(t, false); resolve(t, true); }
    else expr(t);
  }

  function stat(s: A.Stat) {
    switch (s.type) {
      case 'LocalStat': {
        for (const e of s.init) expr(e);
        s.names.forEach((nm, i) => {
          const b = declare(nm, 'local', s, i, s.loc?.line ?? 0);
          const last = s.init.length - 1;
          if (i < s.init.length) {
            const e = s.init[i];
            const multi = i === last && (e.type === 'CallExpr' || e.type === 'MethodCallExpr' || e.type === 'VarargLit');
            if (i === last || !multi) { b.init = e; b.initMulti = multi && s.names.length > s.init.length; }
          }
        });
        break;
      }
      case 'LocalFunctionStat': declare(s.name, 'localfn', s, 0, s.loc?.line ?? 0); func(s.func); break;
      case 'FunctionStat': target(s.target, false); func(s.func); break;
      case 'AssignStat': {
        for (const v of s.values) expr(v);
        for (const t of s.targets) target(t, !!s.op);
        break;
      }
      case 'CallStat': expr(s.expr); break;
      case 'DoStat': block(s.body); break;
      case 'WhileStat': expr(s.cond); block(s.body); break;
      case 'RepeatStat': scopes.push(new Map()); for (const b of s.body) stat(b); expr(s.cond); scopes.pop(); break;
      case 'IfStat': for (const c of s.clauses) { expr(c.cond); block(c.body); } if (s.elseBody) block(s.elseBody); break;
      case 'NumericForStat': {
        expr(s.from); expr(s.to); if (s.step) expr(s.step);
        scopes.push(new Map()); declare(s.var, 'for', s, 0, s.loc?.line ?? 0);
        for (const b of s.body) stat(b); scopes.pop(); break;
      }
      case 'GenericForStat': {
        for (const e of s.iters) expr(e);
        scopes.push(new Map()); s.names.forEach((nm, i) => declare(nm, 'for', s, i, s.loc?.line ?? 0));
        for (const b of s.body) stat(b); scopes.pop(); break;
      }
      case 'ReturnStat': for (const e of s.args) expr(e); break;
      default: break;
    }
  }

  function expr(e: A.Expr | undefined) {
    if (!e) return;
    switch (e.type) {
      case 'NameExpr': resolve(e, false); break;
      case 'IndexExpr': expr(e.obj); expr(e.index); break;
      case 'MemberExpr': expr(e.obj); break;
      case 'CallExpr': expr(e.callee); for (const a of e.args) expr(a); break;
      case 'MethodCallExpr': expr(e.obj); for (const a of e.args) expr(a); break;
      case 'FunctionExpr': func(e); break;
      case 'TableExpr': for (const f of e.fields) { if (f.key) expr(f.key); expr(f.value); } break;
      case 'BinExpr': expr(e.left); expr(e.right); break;
      case 'UnExpr': expr(e.expr); break;
      case 'ParenExpr': expr(e.expr); break;
      case 'InterpExpr': for (const p of e.parts) if (p.kind === 'expr') expr(p.expr); break;
      case 'IfExpr': for (const c of e.clauses) { expr(c.cond); expr(c.value); } expr(e.elseValue); break;
      default: break;
    }
  }

  fnStack.push(chunk); fnBindings.set(chunk, []); scopes.push(new Map());
  for (const s of chunk.body) stat(s);
  scopes.pop(); fnStack.pop();
  return { bindings, globals, refOf, fnBindings, allNames };
}

/** Rename a binding everywhere (declaration + every reference). */
export function renameBinding(b: Binding, to: string) {
  const d = b.decl;
  if (d) {
    switch (d.type) {
      case 'LocalStat': d.names[b.index] = to; break;
      case 'LocalFunctionStat': d.name = to; break;
      case 'FunctionExpr': d.params[b.index] = to; break;
      case 'NumericForStat': d.var = to; break;
      case 'GenericForStat': d.names[b.index] = to; break;
    }
  }
  for (const r of b.refs) r.name = to;
  b.name = to;
}
