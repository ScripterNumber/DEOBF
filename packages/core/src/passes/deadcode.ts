// PRISM dead-code / opaque-predicate elimination.
// Prunes `if <const>` branches, removes unreachable code after return/break,
// and drops no-op statements. Runs after folding (so conditions are literals).
import type * as A from '../ast.js';
import { walk } from '../ast.js';

export interface DeadStats { prunedBranches: number; removedStmts: number; }

export function eliminateDeadCode(chunk: A.Chunk): DeadStats {
  const stats: DeadStats = { prunedBranches: 0, removedStmts: 0 };

  function truthy(e: A.Expr): boolean | null {
    if (e.type === 'TrueLit') return true;
    if (e.type === 'FalseLit' || e.type === 'NilLit') return false;
    if (e.type === 'NumberLit' || e.type === 'StringLit') return true;
    return null;
  }

  /** control never reaches the statement after s (return / break / continue / goto, also as the last
   *  statement of a do-block or of every branch of an if with an else) */
  function exits(s: A.Stat | undefined): boolean {
    if (!s) return false;
    if (s.type === 'ReturnStat' || s.type === 'BreakStat' || s.type === 'ContinueStat' || s.type === 'GotoStat') return true;
    if (s.type === 'DoStat') return exits(s.body[s.body.length - 1]);
    if (s.type === 'IfStat') return !!s.elseBody && s.clauses.every(c => exits(c.body[c.body.length - 1])) && exits(s.elseBody[s.elseBody.length - 1]);
    return false;
  }
  function processBody(body: A.Stat[]): A.Stat[] {
    const out: A.Stat[] = [];
    for (let i = 0; i < body.length; i++) {
      const s = body[i];
      const r = processStat(s);
      if (Array.isArray(r)) out.push(...r);
      else if (r) out.push(r);
      // unreachable after terminator (up to a label, which a goto may target)
      if (exits(out[out.length - 1])) {
        let j = i + 1;
        while (j < body.length && body[j].type !== 'LabelStat') j++;
        if (j > i + 1) stats.removedStmts += j - i - 1;
        i = j - 1;
      }
    }
    return out;
  }

  function processStat(s: A.Stat): A.Stat | A.Stat[] | null {
    switch (s.type) {
      case 'IfStat': {
        const clauses: A.IfClause[] = [];
        for (const c of s.clauses) {
          const t = truthy(c.cond);
          if (t === false) { stats.prunedBranches++; continue; } // drop
          c.body = processBody(c.body);
          clauses.push(c);
          if (t === true) {
            // this clause always runs; drop the rest + else
            if (clauses.length === 1) {
              // becomes a plain do-block
              return { type: 'DoStat', body: c.body, loc: s.loc };
            }
            s.clauses = clauses; s.elseBody = undefined;
            return s;
          }
        }
        s.clauses = clauses;
        if (s.elseBody) s.elseBody = processBody(s.elseBody);
        if (clauses.length === 0) {
          if (s.elseBody) { stats.prunedBranches++; return { type: 'DoStat', body: s.elseBody, loc: s.loc }; }
          stats.removedStmts++; return null;
        }
        return s;
      }
      case 'WhileStat': {
        const t = truthy(s.cond);
        if (t === false) { stats.removedStmts++; return null; }
        s.body = processBody(s.body); return s;
      }
      case 'RepeatStat': s.body = processBody(s.body); return s;
      case 'DoStat': s.body = processBody(s.body); return s;
      case 'NumericForStat': s.body = processBody(s.body); return s;
      case 'GenericForStat': s.body = processBody(s.body); return s;
      case 'FunctionStat': s.func.body = processBody(s.func.body); return s;
      case 'LocalFunctionStat': s.func.body = processBody(s.func.body); return s;
      default: return s;
    }
  }

  chunk.body = processBody(chunk.body);
  // function expressions anywhere (closures assigned / passed as values)
  const fns: A.FunctionExpr[] = [];
  walk(chunk, (m: any) => { if (m.type === 'FunctionExpr') fns.push(m); });
  for (const f of fns) f.body = processBody(f.body);
  return stats;
}