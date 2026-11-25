// Recover numeric for-loops:  i = A; while i <= B do BODY; i = i + K end  ->  for i = A, B, K do BODY end
// Checked: i is a local/param of this function that no nested function sees; BODY never writes,
// redeclares or shadows i and has no continue/goto (they would skip the increment); B is a literal
// or an uncaptured local BODY never writes (a for evaluates its limit once); K is a non-zero literal
// whose sign matches the comparison; i is dead after the loop (a for variable does not survive it).
import type * as A from '../ast.js';
import { visit, mentions, deadAfter, type Ctx } from './inlinetemps.js';

export function recoverForLoops(chunk: A.Chunk): number {
  let total = 0;
  const doFunc = (body: A.Stat[], params: string[]) => {
    const decl = new Set<string>(params);
    const scanDecl = (n: any) => { if (!n || typeof n !== 'object') return; if (Array.isArray(n)) { n.forEach(scanDecl); return; } if (n.type === 'FunctionExpr') return; if (n.type === 'LocalStat') n.names.forEach((q: string) => decl.add(q)); for (const k of Object.keys(n)) { if (k !== 'loc' && n[k] && typeof n[k] === 'object') scanDecl(n[k]); } };
    scanDecl(body);
    let gotos = false; visit(body, n => { if (n.type === 'GotoStat' || n.type === 'LabelStat') gotos = true; });
    if (gotos) return;
    const captured = new Set<string>();
    visit(body, n => { if (n.type === 'FunctionExpr') { const own = new Set<string>(n.params); visit(n.body, m => { if (m.type === 'NameExpr' && !own.has(m.name)) captured.add(m.name); }); } });
    const writes = (n: any, x: string) => { let r = false; visit(n, m => { if (m.type === 'AssignStat' && m.targets.some((t: any) => t.type === 'NameExpr' && t.name === x)) r = true; if (m.type === 'LocalStat' && m.names.includes(x)) r = true; if ((m.type === 'NumericForStat' && m.var === x) || (m.type === 'GenericForStat' && m.names.includes(x)) || (m.type === 'LocalFunctionStat' && m.name === x) || (m.type === 'FunctionExpr' && m.params.includes(x))) r = true; }); return r; };
    const jumps = (n: any) => { let r = false; const go = (m: any) => { if (!m || typeof m !== 'object') return; if (Array.isArray(m)) { m.forEach(go); return; } if (m.type === 'FunctionExpr') return; if (m.type === 'ContinueStat' || m.type === 'GotoStat') r = true; for (const k of Object.keys(m)) { if (k !== 'loc' && m[k] && typeof m[k] === 'object') go(m[k]); } }; go(n); return r; };
    const block = (stmts: any[], ctx: Ctx) => {
      stmts.forEach((s: any, idx) => {
        const sub = (b: any[] | undefined, kind: Ctx['kind']) => { if (b) block(b, { stmts: b, kind, owner: s, parent: ctx, idx }); };
        if (s.type === 'IfStat') { s.clauses.forEach((c: any) => sub(c.body, 'other')); sub(s.elseBody, 'other'); }
        else if (['WhileStat', 'RepeatStat', 'NumericForStat', 'GenericForStat'].includes(s.type)) sub(s.body, 'loop');
        else if (s.type === 'DoStat') sub(s.body, 'other');
      });
      for (let k = 1; k < stmts.length; k++) {
        const w = stmts[k], init = stmts[k - 1];
        if (w.type !== 'WhileStat' || w.cond.type !== 'BinExpr' || !['<=', '>='].includes(w.cond.op) || w.cond.left.type !== 'NameExpr') continue;
        const x = w.cond.left.name, lim = w.cond.right;
        if (!decl.has(x) || captured.has(x)) continue;
        const isAssign = init.type === 'AssignStat' && !init.op && init.targets.length === 1 && init.values.length === 1 && init.targets[0].type === 'NameExpr' && init.targets[0].name === x && !mentions(init.values[0], x);
        const isLocal = init.type === 'LocalStat' && init.names.length === 1 && init.names[0] === x && init.init.length === 1 && !(init.attribs ?? []).some((a: any) => a) && !mentions(init.init[0], x);
        if (!isAssign && !isLocal) continue;
        const from = isAssign ? init.values[0] : init.init[0];
        const last = w.body[w.body.length - 1];
        if (!(last && last.type === 'AssignStat' && !last.op && last.targets.length === 1 && last.targets[0].type === 'NameExpr' && last.targets[0].name === x && last.values.length === 1)) continue;
        const inc = last.values[0];
        let step: number | null = null;
        if (inc.type === 'BinExpr' && inc.left.type === 'NameExpr' && inc.left.name === x && inc.right.type === 'NumberLit') step = inc.op === '+' ? inc.right.value : inc.op === '-' ? -inc.right.value : null;
        if (step === null || step === 0 || (w.cond.op === '<=') !== (step > 0)) continue;
        const rest = w.body.slice(0, -1);
        if (writes(rest, x) || jumps(rest)) continue;
        const limOk = lim.type === 'NumberLit' || (lim.type === 'UnExpr' && lim.op === '-' && lim.expr.type === 'NumberLit') || (lim.type === 'NameExpr' && decl.has(lim.name) && !captured.has(lim.name) && !writes(rest, lim.name) && lim.name !== x);
        if (!limOk) continue;
        if (isLocal ? stmts.slice(k + 1).some((q: any) => mentions(q, x)) : !deadAfter(ctx, k, x)) continue;
        const stepAbs = Math.abs(step);
        const stepExpr: any = step === 1 ? undefined : step > 0 ? { type: 'NumberLit', value: step, raw: String(step) } : { type: 'UnExpr', op: '-', expr: { type: 'NumberLit', value: stepAbs, raw: String(stepAbs) } };
        stmts[k] = { type: 'NumericForStat', var: x, from, to: lim, step: stepExpr, body: rest, loc: w.loc };
        stmts.splice(k - 1, 1); k--; total++;
      }
    };
    block(body, { stmts: body, kind: 'func' });
  };
  doFunc(chunk.body, []);
  visit(chunk.body, n => { if (n.type === 'FunctionExpr') doFunc(n.body, n.params); });
  return total;
}
