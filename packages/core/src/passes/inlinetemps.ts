// Inline single-use temporaries:   x = E ; S(x)   ->   S(E)
// Conditions (all checked, otherwise the pair is left alone):
//  * x is a local declared exactly once in the enclosing function, is not a for-variable and is not
//    referenced from any nested function (no capture); the function has no goto/labels.
//  * stmt i is a plain single assignment `x = E`; stmt i+1 reads x exactly once, in a position that
//    is evaluated immediately and unconditionally (not inside a nested function, not on the right of
//    and/or unless E is trivially pure, not in a loop condition, not in a nested block).
//  * no call completes in stmt i+1 before the use, unless E is a literal (calls could change what E reads).
//  * x is dead after stmt i+1 (next mention is a plain overwrite, or the function returns / ends).
//  * a multi-value E (call / ...) placed in a multi-value slot is wrapped in ( ) to keep truncation.
import type * as A from '../ast.js';

const SINGLE = new Set(['tostring', 'tonumber', 'type', 'typeof', 'setmetatable', 'getmetatable', 'rawget', 'rawlen', 'rawequal', 'string.rep', 'string.sub', 'string.upper', 'string.lower', 'string.format', 'string.len', 'string.reverse', 'string.char', 'table.concat', 'table.create', 'math.floor', 'math.ceil', 'math.abs', 'math.max', 'math.min', 'math.sqrt', 'math.random', 'math.clamp', 'math.round', 'math.sin', 'math.cos', 'math.pow', 'math.log', 'math.exp', 'math.fmod', 'math.sign', 'math.noise', 'Vector3.new', 'Vector2.new', 'UDim2.new', 'UDim.new', 'Color3.new', 'Color3.fromRGB', 'CFrame.new', 'Instance.new']);

// builtins without side effects (no callbacks, no global writes); assumed not reassigned by the script
export const PURE = new Set(['tostring', 'tonumber', 'type', 'typeof', 'rawequal', 'rawlen', 'select', 'string.rep', 'string.sub', 'string.upper', 'string.lower', 'string.format', 'string.len', 'string.reverse', 'string.char', 'string.byte', 'math.floor', 'math.ceil', 'math.abs', 'math.max', 'math.min', 'math.sqrt', 'math.clamp', 'math.round', 'math.sin', 'math.cos', 'math.tan', 'math.pow', 'math.log', 'math.exp', 'math.fmod', 'math.sign', 'math.huge', 'bit32.band', 'bit32.bor', 'bit32.bxor', 'bit32.bnot', 'bit32.lshift', 'bit32.rshift', 'bit32.arshift', 'utf8.char', 'Vector3.new', 'Vector2.new', 'UDim2.new', 'UDim.new', 'Color3.new', 'Color3.fromRGB', 'CFrame.new']);
const STDG = new Set(['print', 'warn', 'error', 'assert', 'pcall', 'xpcall', 'tostring', 'tonumber', 'type', 'typeof', 'pairs', 'ipairs', 'next', 'select', 'unpack', 'rawget', 'rawset', 'rawequal', 'rawlen', 'setmetatable', 'getmetatable', 'require', 'string', 'table', 'math', 'bit32', 'utf8', 'coroutine', 'os', 'task', 'debug', 'game', 'workspace', 'script', 'Instance', 'Vector3', 'Vector2', 'CFrame', 'Color3', 'UDim', 'UDim2', 'Enum', 'wait', 'spawn', 'delay', 'tick', 'time']);
const calleeName = (e: any): string | null => e.type === 'NameExpr' ? e.name : e.type === 'MemberExpr' ? (calleeName(e.obj) ? calleeName(e.obj) + '.' + e.name : null) : null;
const isMulti = (e: any) => e.type === 'VarargLit' || e.type === 'MethodCallExpr' || (e.type === 'CallExpr' && !SINGLE.has(calleeName(e.callee) ?? ''));
const isLit = (e: any) => ['NilLit', 'TrueLit', 'FalseLit', 'NumberLit', 'StringLit'].includes(e.type);
const hasCallOrIndex = (e: any): boolean => { let r = false; visit(e, n => { if (['CallExpr', 'MethodCallExpr', 'IndexExpr', 'MemberExpr', 'FunctionExpr', 'VarargLit'].includes(n.type)) r = true; }); return r; };

export function visit(n: any, fn: (n: any) => void, intoFns = true) {
  if (!n || typeof n !== 'object') return;
  if (Array.isArray(n)) { for (const x of n) visit(x, fn, intoFns); return; }
  if (typeof n.type === 'string') { fn(n); if (!intoFns && n.type === 'FunctionExpr') return; }
  for (const k of Object.keys(n)) { if (k === 'loc' || k === 'type') continue; const v = n[k]; if (v && typeof v === 'object') visit(v, fn, intoFns); }
}

// reads of x inside node (plain `x = ...` targets are writes, not reads)
export function reads(node: any, x: string): number {
  let c = 0;
  const go = (n: any) => {
    if (!n || typeof n !== 'object') return;
    if (Array.isArray(n)) { n.forEach(go); return; }
    if (n.type === 'NameExpr') { if (n.name === x) c++; return; }
    if (n.type === 'AssignStat') { for (const t of n.targets) { if (t.type === 'NameExpr') { if (n.op && t.name === x) c++; } else go(t); } go(n.values); return; }
    for (const k of Object.keys(n)) { if (k === 'loc' || k === 'type') continue; const v = n[k]; if (v && typeof v === 'object') go(v); }
  };
  go(node); return c;
}
export const mentions = (node: any, x: string) => { let c = 0; visit(node, n => { if (n.type === 'NameExpr' && n.name === x) c++; if ((n.type === 'LocalStat' || n.type === 'GenericForStat') && n.names.includes(x)) c++; if ((n.type === 'NumericForStat' && n.var === x) || (n.type === 'LocalFunctionStat' && n.name === x)) c++; if (n.type === 'FunctionExpr' && n.params.includes(x)) c++; }); return c; };
export const hasJump = (node: any) => { let r = false; visit(node, n => { if (n.type === 'BreakStat' || n.type === 'ContinueStat' || n.type === 'GotoStat') r = true; }, false); return r; };
export const writesPlain = (s: any, x: string) => s.type === 'AssignStat' && !s.op && s.targets.some((t: any) => t.type === 'NameExpr' && t.name === x);

export interface Ctx { stmts: A.Stat[]; kind: 'func' | 'loop' | 'other'; owner?: any; parent?: Ctx; idx?: number; }

// is x dead after statement j of ctx?
export function deadAfter(ctx: Ctx, j: number, x: string, depth = 0): boolean {
  if (depth > 12) return false;
  for (let k = j + 1; k < ctx.stmts.length; k++) {
    const s: any = ctx.stmts[k];
    if (!mentions(s, x)) { if (s.type === 'ReturnStat') return true; if (s.type === 'BreakStat' || s.type === 'ContinueStat' || s.type === 'GotoStat' || hasJump(s)) return false; continue; }
    return writesPlain(s, x) && reads(s, x) === 0 && !['IfStat', 'WhileStat', 'RepeatStat', 'NumericForStat', 'GenericForStat', 'DoStat'].includes(s.type);
  }
  return deadAtEnd(ctx, x, depth + 1);
}
function deadAtEnd(ctx: Ctx, x: string, depth: number): boolean {
  if (ctx.kind === 'func') return true;
  if (!ctx.parent || ctx.idx === undefined) return false;
  if (ctx.kind === 'loop') {
    const o = ctx.owner;
    if ((o.type === 'WhileStat' || o.type === 'RepeatStat') && mentions(o.cond, x)) return false;
    // next iteration: the body must overwrite x before reading it
    let ok = false;
    for (const s of ctx.stmts as any[]) { if (!mentions(s, x)) { if (hasJump(s)) break; continue; } ok = writesPlain(s, x) && reads(s, x) === 0 && s.type === 'AssignStat'; break; }
    if (!ok) return false;
  }
  return deadAfter(ctx.parent, ctx.idx, x, depth);
}

type Use = { set: (e: A.Expr) => void; callsBefore: boolean; condRight: boolean; multiSlot: boolean };

// locate the single read of x inside the immediately-evaluated part of statement s
function findUse(s: any, x: string): Use | null {
  let calls = 0; let found: Use | null = null;
  const ex = (n: any, set: (e: any) => void, condRight: boolean, multiSlot: boolean) => {
    if (found || !n) return;
    switch (n.type) {
      case 'NameExpr': if (n.name === x) found = { set, callsBefore: calls > 0, condRight, multiSlot }; return;
      case 'FunctionExpr': return;
      case 'CallExpr': ex(n.callee, e => n.callee = e, condRight, false); n.args.forEach((a: any, i: number) => ex(a, e => n.args[i] = e, condRight, i === n.args.length - 1)); if (!found && !PURE.has(calleeName(n.callee) ?? '')) calls++; return;
      case 'MethodCallExpr': ex(n.obj, e => n.obj = e, condRight, false); n.args.forEach((a: any, i: number) => ex(a, e => n.args[i] = e, condRight, i === n.args.length - 1)); if (!found) calls++; return;
      case 'IndexExpr': ex(n.obj, e => n.obj = e, condRight, false); ex(n.index, e => n.index = e, condRight, false); return;
      case 'MemberExpr': ex(n.obj, e => n.obj = e, condRight, false); return;
      case 'BinExpr': { const sc = n.op === 'and' || n.op === 'or'; ex(n.left, e => n.left = e, condRight, false); ex(n.right, e => n.right = e, condRight || sc, false); return; }
      case 'UnExpr': ex(n.expr, e => n.expr = e, condRight, false); return;
      case 'ParenExpr': ex(n.expr, e => n.expr = e, condRight, false); return;
      case 'TableExpr': n.fields.forEach((f: any, i: number) => { if (f.key) ex(f.key, e => f.key = e, condRight, false); ex(f.value, e => f.value = e, condRight, f.kind === 'item' && i === n.fields.length - 1); }); return;
      case 'InterpExpr': n.parts.forEach((p: any) => { if (p.kind === 'expr') ex(p.expr, e => p.expr = e, condRight, false); }); return;
      case 'IfExpr': n.clauses.forEach((c: any, i: number) => { ex(c.cond, e => c.cond = e, condRight || i > 0, false); ex(c.value, e => c.value = e, true, false); }); ex(n.elseValue, e => n.elseValue = e, true, false); return;
    }
  };
  const list = (arr: any[], multi: boolean) => arr.forEach((a, i) => ex(a, e => arr[i] = e, false, multi && i === arr.length - 1));
  switch (s.type) {
    case 'AssignStat': if (s.op) return null; for (const t of s.targets) if (t.type !== 'NameExpr') ex(t, () => { throw new Error('target'); }, false, false); if (found) return null; list(s.values, true); break;
    case 'LocalStat': list(s.init, true); break;
    case 'CallStat': ex(s.expr, () => { throw new Error('stmt'); }, false, false); break;
    case 'ReturnStat': list(s.args, true); break;
    case 'IfStat': ex(s.clauses[0].cond, e => s.clauses[0].cond = e, false, false); break;
    case 'NumericForStat': ex(s.from, e => s.from = e, false, false); ex(s.to, e => s.to = e, false, false); if (s.step) ex(s.step, e => s.step = e, false, false); break;
    case 'GenericForStat': list(s.iters, true); break;
    default: return null;
  }
  return found;
}

export function inlineTemps(chunk: A.Chunk): number {
  let total = 0;
  const doFunc = (body: A.Stat[], params: string[]) => {
    // locals of this function (not nested functions)
    const decl = new Map<string, number>(); const bad = new Set<string>(params);
    let gotos = false;
    const scan = (n: any, top: boolean) => {
      if (!n || typeof n !== 'object') return;
      if (Array.isArray(n)) { n.forEach(m => scan(m, top)); return; }
      if (n.type === 'FunctionExpr') { if (!top) return; }
      if (n.type === 'GotoStat' || n.type === 'LabelStat') gotos = true;
      if (n.type === 'LocalStat') for (const nm of n.names) decl.set(nm, (decl.get(nm) ?? 0) + 1);
      if (n.type === 'LocalFunctionStat') bad.add(n.name);
      if (n.type === 'NumericForStat') bad.add(n.var);
      if (n.type === 'GenericForStat') n.names.forEach((m: string) => bad.add(m));
      for (const k of Object.keys(n)) { if (k === 'loc' || k === 'type') continue; const v = n[k]; if (v && typeof v === 'object') scan(v, false); }
    };
    scan(body, false);
    if (gotos) return;
    // captured names: referenced inside a nested function (nested params too, to be safe)
    const captured = new Set<string>();
    visit(body, n => { if (n.type === 'FunctionExpr') { n.params.forEach((q: string) => captured.add(q)); visit(n.body, m => { if (m.type === 'NameExpr') captured.add(m.name); if (m.type === 'LocalStat') m.names.forEach((q: string) => captured.add(q)); }); } });
    // E is stable if a side-effecting call cannot change its value: literals, uncaptured locals,
    // standard globals (and their fields), pure builtin calls over stable arguments, operators.
    const isLocal = (nm: string) => decl.has(nm) || params.includes(nm);
    const stable = (e: any): boolean => {
      switch (e.type) {
        case 'NilLit': case 'TrueLit': case 'FalseLit': case 'NumberLit': case 'StringLit': return true;
        case 'NameExpr': return isLocal(e.name) ? !captured.has(e.name) : STDG.has(e.name);
        case 'MemberExpr': return e.obj.type === 'NameExpr' && !isLocal(e.obj.name) && STDG.has(e.obj.name);
        case 'BinExpr': return e.op !== '..' || true ? stable(e.left) && stable(e.right) : false;
        case 'UnExpr': return e.op !== '#' && stable(e.expr);
        case 'ParenExpr': return stable(e.expr);
        case 'CallExpr': return PURE.has(calleeName(e.callee) ?? '') && !(e.callee.type === 'NameExpr' && isLocal(e.callee.name)) && e.args.every(stable);
        default: return false;
      }
    };
    const ok = (x: string) => decl.get(x) === 1 && !bad.has(x) && !captured.has(x);

    const block = (stmts: A.Stat[], ctx: Ctx) => {
      stmts.forEach((s: any, idx) => {
        const sub = (b: A.Stat[] | undefined, kind: Ctx['kind']) => { if (b) block(b, { stmts: b, kind, owner: s, parent: ctx, idx }); };
        switch (s.type) {
          case 'IfStat': s.clauses.forEach((c: any) => sub(c.body, 'other')); sub(s.elseBody, 'other'); break;
          case 'WhileStat': case 'RepeatStat': case 'NumericForStat': case 'GenericForStat': sub(s.body, 'loop'); break;
          case 'DoStat': sub(s.body, 'other'); break;
        }
      });
      let i = 0;
      while (i < stmts.length - 1) {
        const s: any = stmts[i], n: any = stmts[i + 1];
        let done = false;
        if (s.type === 'AssignStat' && !s.op && s.targets.length === 1 && s.values.length === 1 && s.targets[0].type === 'NameExpr' && ok(s.targets[0].name)) {
          const x = s.targets[0].name, E = s.values[0];
          if (reads(n, x) === 1 && mentions(n, x) === 1 + (writesPlain(n, x) ? 1 : 0)) {
            const use = findUse(n, x);
            const st = stable(E);
            if (use && !(use.callsBefore && !isLit(E) && !st) && !(use.condRight && hasCallOrIndex(E))) {
              const dead = writesPlain(n, x) || n.type === 'ReturnStat' || deadAfter(ctx, i + 1, x);
              if (dead) {
                use.set(use.multiSlot && isMulti(E) ? ({ type: 'ParenExpr', expr: E } as any) : E);
                stmts.splice(i, 1); total++; done = true;
              }
            }
          }
        }
        // non-adjacent: x = E ; (stable assignments not touching x or E's names)* ; S(x)
        if (!done && s.type === 'AssignStat' && !s.op && s.targets.length === 1 && s.values.length === 1 && s.targets[0].type === 'NameExpr' && ok(s.targets[0].name) && stable(s.values[0])) {
          const x = s.targets[0].name, E = s.values[0];
          const names = new Set<string>(); visit(E, m => { if (m.type === 'NameExpr') names.add(m.name); });
          let j = i + 1;
          while (j < stmts.length - 1) {
            const t: any = stmts[j];
            if (!(t.type === 'AssignStat' && !t.op && t.targets.every((g: any) => g.type === 'NameExpr' && g.name !== x && !names.has(g.name)) && t.values.every(stable) && !mentions(t, x))) break;
            j++;
          }
          const n: any = stmts[j];
          if (j > i + 1 && n && reads(n, x) === 1 && mentions(n, x) === 1 + (writesPlain(n, x) ? 1 : 0)) {
            const use = findUse(n, x);
            if (use && !(use.condRight && hasCallOrIndex(E)) && (writesPlain(n, x) || n.type === 'ReturnStat' || deadAfter(ctx, j, x))) {
              use.set(use.multiSlot && isMulti(E) ? ({ type: 'ParenExpr', expr: E } as any) : E);
              stmts.splice(i, 1); total++; done = true;
            }
          }
        }
        if (done) i = Math.max(i - 1, 0); else i++;
      }
    };
    block(body, { stmts: body, kind: 'func' });
  };

  for (let round = 0; round < 20; round++) {
    const before = total;
    doFunc(chunk.body, []);
    visit(chunk.body, n => { if (n.type === 'FunctionExpr') doFunc(n.body, n.params); });
    if (total === before) break;
  }
  return total;
}
