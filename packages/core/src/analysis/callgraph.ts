// PRISM call graph + function inventory. Universal: identifies functions by
// their binding name (local f / function a.b / table field / assignment target)
// and builds caller->callee edges from CallExpr/MethodCallExpr.
import type * as A from '../ast.js';

export interface FnInfo {
  id: string;            // stable id f0, f1, ...
  name: string;          // best-effort name
  params: string[];
  vararg: boolean;
  line: number;
  start: number;
  end: number;
  stmts: number;         // body statement count
  calls: string[];       // callee display names
  depth: number;
}

export interface CallGraph {
  functions: FnInfo[];
  edges: Array<{ from: string; to: string; label: string }>;
  externalCalls: Array<{ name: string; count: number }>;
}

export function buildCallGraph(chunk: A.Chunk): CallGraph {
  const functions: FnInfo[] = [];
  const externalCalls = new Map<string, number>();
  let idc = 0;

  const ROOT: FnInfo = {
    id: 'main', name: '<main chunk>', params: [], vararg: true,
    line: 1, start: 0, end: 0, stmts: chunk.body.length, calls: [], depth: 0,
  };
  functions.push(ROOT);

  function displayName(e: A.Expr): string {
    switch (e.type) {
      case 'NameExpr': return e.name;
      case 'MemberExpr': return displayName(e.obj) + '.' + e.name;
      case 'IndexExpr': {
        const idx = e.index.type === 'StringLit' ? JSON.stringify(e.index.value)
          : e.index.type === 'NumberLit' ? String(e.index.value) : '?';
        return displayName(e.obj) + '[' + idx + ']';
      }
      case 'CallExpr': return displayName(e.callee) + '()';
      case 'MethodCallExpr': return displayName(e.obj) + ':' + e.method + '()';
      case 'ParenExpr': return displayName(e.expr);
      default: return '<expr>';
    }
  }

  function registerFn(f: A.FunctionExpr, name: string, depth: number): FnInfo {
    const info: FnInfo = {
      id: 'f' + (idc++), name, params: f.params, vararg: f.vararg,
      line: f.loc?.line ?? 0, start: f.loc?.start ?? 0, end: f.loc?.end ?? 0,
      stmts: f.body.length, calls: [], depth,
    };
    functions.push(info);
    return info;
  }

  function visitExpr(e: A.Expr | undefined, cur: FnInfo, depth: number, bindName?: string) {
    if (!e) return;
    switch (e.type) {
      case 'FunctionExpr': {
        const info = registerFn(e, bindName ?? ('<anon@L' + (e.loc?.line ?? '?') + '>'), depth + 1);
        visitBody(e.body, info, depth + 1);
        return;
      }
      case 'CallExpr': {
        const nm = displayName(e.callee);
        cur.calls.push(nm);
        externalCalls.set(nm, (externalCalls.get(nm) ?? 0) + 1);
        visitExpr(e.callee, cur, depth);
        e.args.forEach(a => visitExpr(a, cur, depth));
        return;
      }
      case 'MethodCallExpr': {
        const nm = displayName(e.obj) + ':' + e.method;
        cur.calls.push(nm);
        externalCalls.set(nm, (externalCalls.get(nm) ?? 0) + 1);
        visitExpr(e.obj, cur, depth);
        e.args.forEach(a => visitExpr(a, cur, depth));
        return;
      }
      case 'BinExpr': visitExpr(e.left, cur, depth); visitExpr(e.right, cur, depth); return;
      case 'UnExpr': visitExpr(e.expr, cur, depth); return;
      case 'ParenExpr': visitExpr(e.expr, cur, depth); return;
      case 'IndexExpr': visitExpr(e.obj, cur, depth); visitExpr(e.index, cur, depth); return;
      case 'MemberExpr': visitExpr(e.obj, cur, depth); return;
      case 'TableExpr':
        for (const fld of e.fields) {
          if (fld.key) visitExpr(fld.key, cur, depth);
          const bn = fld.kind === 'named' ? fld.name : (fld.kind === 'keyed' && fld.key && fld.key.type === 'StringLit' ? fld.key.value : undefined);
          visitExpr(fld.value, cur, depth, bn);
        }
        return;
      case 'InterpExpr': for (const p of e.parts) if (p.kind === 'expr') visitExpr(p.expr, cur, depth); return;
      case 'IfExpr': for (const c of e.clauses) { visitExpr(c.cond, cur, depth); visitExpr(c.value, cur, depth); } visitExpr(e.elseValue, cur, depth); return;
      default: return;
    }
  }

  function visitBody(body: A.Stat[], cur: FnInfo, depth: number) {
    for (const s of body) visitStat(s, cur, depth);
  }

  function visitStat(s: A.Stat, cur: FnInfo, depth: number) {
    switch (s.type) {
      case 'LocalStat':
        s.names.forEach((nm, i) => visitExpr(s.init[i], cur, depth, nm));
        for (let i = s.names.length; i < s.init.length; i++) visitExpr(s.init[i], cur, depth);
        break;
      case 'AssignStat':
        s.targets.forEach((t, i) => {
          const bn = t.type === 'NameExpr' ? t.name
            : t.type === 'MemberExpr' ? displayName(t) : undefined;
          visitExpr(s.values[i], cur, depth, bn);
        });
        for (let i = s.targets.length; i < s.values.length; i++) visitExpr(s.values[i], cur, depth);
        s.targets.forEach(t => { if (t.type !== 'NameExpr') visitExpr(t, cur, depth); });
        break;
      case 'CallStat': visitExpr(s.expr, cur, depth); break;
      case 'DoStat': visitBody(s.body, cur, depth); break;
      case 'WhileStat': visitExpr(s.cond, cur, depth); visitBody(s.body, cur, depth); break;
      case 'RepeatStat': visitBody(s.body, cur, depth); visitExpr(s.cond, cur, depth); break;
      case 'IfStat':
        for (const c of s.clauses) { visitExpr(c.cond, cur, depth); visitBody(c.body, cur, depth); }
        if (s.elseBody) visitBody(s.elseBody, cur, depth);
        break;
      case 'NumericForStat': visitExpr(s.from, cur, depth); visitExpr(s.to, cur, depth); if (s.step) visitExpr(s.step, cur, depth); visitBody(s.body, cur, depth); break;
      case 'GenericForStat': s.iters.forEach(e => visitExpr(e, cur, depth)); visitBody(s.body, cur, depth); break;
      case 'FunctionStat': {
        const nm = displayName(s.target);
        const info = registerFn(s.func, nm, depth + 1);
        visitBody(s.func.body, info, depth + 1);
        break;
      }
      case 'LocalFunctionStat': {
        const info = registerFn(s.func, s.name, depth + 1);
        visitBody(s.func.body, info, depth + 1);
        break;
      }
      case 'ReturnStat': s.args.forEach(e => visitExpr(e, cur, depth)); break;
    }
  }

  visitBody(chunk.body, ROOT, 0);

  // edges: function -> function by matching call display names to known fn names
  const nameToId = new Map<string, string>();
  for (const f of functions) if (f.name && !f.name.startsWith('<')) nameToId.set(f.name, f.id);
  const edges: Array<{ from: string; to: string; label: string }> = [];
  const seen = new Set<string>();
  for (const f of functions) {
    for (const c of f.calls) {
      const base = c.replace(/\(\)$/, '');
      const to = nameToId.get(base);
      if (to) {
        const key = f.id + '->' + to;
        if (!seen.has(key)) { seen.add(key); edges.push({ from: f.id, to, label: base }); }
      }
    }
  }

  const ext = [...externalCalls.entries()]
    .filter(([name]) => !nameToId.has(name.replace(/\(\)$/, '')))
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count);

  return { functions, edges, externalCalls: ext };
}