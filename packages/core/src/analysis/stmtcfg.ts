// Statement-level control-flow graph of a structured function body (no goto) — shared by the forward
// data-flow analyses. Nested functions are not entered.
import type * as A from '../ast.js';

export interface CfgNode {
  /** the simple statement (assign / local / call / return / function decl / other) or the loop / if owning a test */
  stmt?: A.Stat;
  /** what the node is: a statement, an if-clause test, a loop test, a for-loop header (initialisers / variables) */
  kind: 'stmt' | 'cond' | 'loop' | 'forinit' | 'forvars' | 'jump' | 'exit';
  /** expression roots evaluated at the node */
  exprs: any[];
  succ: number[];
}
export interface StmtCfg { nodes: CfgNode[]; entry: number; exit: number; nodeOf: Map<A.Stat, number>; }

export function buildStmtCfg(body: A.Stat[]): StmtCfg | null {
  const nodes: CfgNode[] = [];
  const nodeOf = new Map<A.Stat, number>();
  let bad = false;
  const mk = (kind: CfgNode['kind'], exprs: any[], stmt?: A.Stat): number => { nodes.push({ kind, exprs, stmt, succ: [] }); return nodes.length - 1; };
  interface Loop { brk: number; cont: number; }
  const seq = (stmts: A.Stat[], next: number, L: Loop | null): number => { let cur = next; for (let i = stmts.length - 1; i >= 0; i--) cur = stat(stmts[i], cur, L); return cur; };
  const simple = (s: A.Stat, exprs: any[], next: number): number => { const n = mk('stmt', exprs, s); nodes[n].succ.push(next); nodeOf.set(s, n); return n; };
  const stat = (s: A.Stat, next: number, L: Loop | null): number => {
    switch (s.type) {
      case 'AssignStat': {
        const ex: any[] = [...s.values];
        for (const t of s.targets) { if (t.type === 'IndexExpr') ex.push(t.obj, t.index); else if (t.type === 'MemberExpr') ex.push(t.obj); else if (s.op) ex.push(t); }
        return simple(s, ex, next);
      }
      case 'LocalStat': return simple(s, s.init, next);
      case 'CallStat': return simple(s, [s.expr], next);
      case 'DoStat': return seq(s.body, next, L);
      case 'IfStat': {
        let alt = s.elseBody ? seq(s.elseBody, next, L) : next;
        for (let i = s.clauses.length - 1; i >= 0; i--) { const c = s.clauses[i]; const n = mk('cond', [c.cond], s); nodes[n].succ.push(seq(c.body, next, L), alt); alt = n; }
        nodeOf.set(s, alt);
        return alt;
      }
      case 'WhileStat': { const h = mk('loop', [s.cond], s); nodeOf.set(s, h); const bd = seq(s.body, h, { brk: next, cont: h }); nodes[h].succ.push(bd, next); return h; }
      case 'RepeatStat': { const c = mk('loop', [s.cond], s); const bd = seq(s.body, c, { brk: next, cont: c }); nodes[c].succ.push(next, bd); nodeOf.set(s, bd); return bd; }
      case 'NumericForStat': { const init = mk('forinit', [s.from, s.to, s.step], s); const h = mk('forvars', [], s); const bd = seq(s.body, h, { brk: next, cont: h }); nodes[h].succ.push(bd, next); nodes[init].succ.push(h); nodeOf.set(s, init); return init; }
      case 'GenericForStat': { const init = mk('forinit', s.iters, s); const h = mk('forvars', [], s); const bd = seq(s.body, h, { brk: next, cont: h }); nodes[h].succ.push(bd, next); nodes[init].succ.push(h); nodeOf.set(s, init); return init; }
      case 'ReturnStat': { const n = mk('stmt', s.args, s); nodeOf.set(s, n); return n; }
      case 'BreakStat': { const n = mk('jump', [], s); if (L) nodes[n].succ.push(L.brk); return n; }
      case 'ContinueStat': { const n = mk('jump', [], s); if (L) nodes[n].succ.push(L.cont); return n; }
      case 'GotoStat': case 'LabelStat': bad = true; return mk('jump', [], s);
      default: return simple(s, [s], next);
    }
  };
  const exit = mk('exit', []);
  const entry = seq(body, exit, null);
  return bad ? null : { nodes, entry, exit, nodeOf };
}

/** expression visitor that does not enter nested functions */
export function visitExpr(root: any, f: (node: any, parent: any, key: string, index: number) => boolean | void) {
  const v = (m: any, parent: any, key: string, index: number) => {
    if (!m || typeof m !== 'object') return;
    if (Array.isArray(m)) { m.forEach((x, i) => v(x, parent, key, i)); return; }
    if (m.type === 'FunctionExpr') return;
    if (f(m, parent, key, index) === false) return;
    for (const k of Object.keys(m)) if (k !== 'loc') { const x = m[k]; if (x && typeof x === 'object') { if (Array.isArray(x)) x.forEach((y, i) => v(y, m, k, i)); else v(x, m, k, -1); } }
  };
  if (Array.isArray(root)) root.forEach((x, i) => v(x, null, '', i)); else v(root, null, '', -1);
}
