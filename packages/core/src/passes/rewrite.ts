// Generic AST rewriting helpers — universal (rules come from the caller, nothing is built in).
//  * astRewrite: expression rules `from -> to` with metavariables: any identifier that starts
//    with "__" (e.g. __a, __t) matches an arbitrary sub-expression; repeated metavariables must
//    match structurally equal expressions. Example:
//        { from: "H[25](__last, __t, __first)", to: "table.unpack(__t, __first, __last)" }
//  * globalsFromEnv: `E.name` / `E["name"]` -> `name` where E is a never-reassigned local holding
//    getfenv() / getfenv(0|1) and no local called `name` exists in the enclosing functions.
import type * as A from '../ast.js';
import { walk } from '../ast.js';
import { parse } from '../parser.js';
import { analyzeScopes } from '../analysis/scope.js';

export interface RewriteRule {
  from: string; to: string;
  /** `to` reorders, duplicates or drops metavariables: the rule only matches side-effect-free sub-expressions (names, literals, field reads, operators) */
  pure?: boolean;
}
interface Compiled { from: A.Expr; to: A.Expr; text: string; pure?: boolean; }

const META = /^__[A-Za-z0-9_]*$/;
function parseExpr(src: string): A.Expr {
  const r = parse('return ' + src);
  if (r.errors.length) throw new Error('bad rewrite pattern: ' + src + ' (' + (r.errors[0] as any).message + ')');
  const st = r.chunk.body[0];
  if (!st || st.type !== 'ReturnStat' || st.args.length !== 1) throw new Error('rewrite pattern must be one expression: ' + src);
  return st.args[0];
}
export function compileRules(rules: RewriteRule[]): Compiled[] { return rules.map(r => ({ from: parseExpr(r.from), to: parseExpr(r.to), text: r.from, pure: !!r.pure })); }

const unparen = (e: A.Expr): A.Expr => { while (e && e.type === 'ParenExpr') e = e.expr; return e; };
export function sameExpr(a: any, b: any): boolean {
  if (a === b) return true;
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object') return a === b;
  if (Array.isArray(a) || Array.isArray(b)) { if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false; return a.every((x, i) => sameExpr(x, b[i])); }
  if (a.type !== b.type) return false;
  for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
    if (k === 'loc' || k === 'raw' || k.startsWith('__')) continue;
    if (!sameExpr(a[k], b[k])) return false;
  }
  return true;
}
function match(p: any, e: any, env: Map<string, A.Expr>): boolean {
  if (p && p.type === 'NameExpr' && META.test(p.name)) {
    const prev = env.get(p.name);
    if (prev) return sameExpr(prev, e);
    env.set(p.name, e); return true;
  }
  if (p && p.type === 'ParenExpr' && !(e && e.type === 'ParenExpr')) return match(p.expr, e, env);
  if (e && e.type === 'ParenExpr' && !(p && p.type === 'ParenExpr')) return match(p, e.expr, env);
  if (!p || !e || typeof p !== 'object' || typeof e !== 'object') return p === e;
  if (Array.isArray(p)) { if (!Array.isArray(e) || p.length !== e.length) return false; return p.every((x, i) => match(x, e[i], env)); }
  if (p.type !== e.type) return false;
  for (const k of Object.keys(p)) {
    if (k === 'loc' || k === 'raw' || k.startsWith('__')) continue;
    if (!match(p[k], e[k], env)) return false;
  }
  return true;
}
function instantiate(t: any, env: Map<string, A.Expr>): any {
  if (!t || typeof t !== 'object') return t;
  if (Array.isArray(t)) return t.map(x => instantiate(x, env));
  if (t.type === 'NameExpr' && META.test(t.name) && env.has(t.name)) return structuredClone(env.get(t.name));
  const o: any = {};
  for (const k of Object.keys(t)) o[k] = k === 'loc' ? undefined : instantiate(t[k], env);
  return o;
}
const ASSIGNABLE = new Set(['NameExpr', 'IndexExpr', 'MemberExpr']);
const isExpr = (x: any) => x && typeof x === 'object' && typeof x.type === 'string' && !/Stat$/.test(x.type) && x.type !== 'Chunk';

/** names, literals, field reads and operators only — no calls, varargs, functions or table constructors */
export function sideEffectFree(e: unknown): boolean {
  if (!e || typeof e !== 'object') return true;
  if (Array.isArray(e)) return e.every(sideEffectFree);
  const t = (e as { type?: unknown }).type;
  if (typeof t === 'string' && /Call|Function|Vararg|Table/.test(t)) return false;
  for (const [k, v] of Object.entries(e)) if (k !== 'loc' && !sideEffectFree(v)) return false;
  return true;
}

/** apply the rules bottom-up everywhere (repeat until stable, max 8 passes); returns #rewrites */
export function astRewrite(root: A.Chunk, rules: RewriteRule[] | Compiled[]): number {
  const cs: Compiled[] = (rules as any[]).map(r => (r.from && typeof r.from === 'object') ? r as Compiled : compileRules([r as RewriteRule])[0]);
  if (!cs.length) return 0;
  let total = 0;
  for (let pass = 0; pass < 8; pass++) {
    let n = 0;
    const visit = (node: any, target: boolean): any => {
      if (!node || typeof node !== 'object') return node;
      if (Array.isArray(node)) { for (let i = 0; i < node.length; i++) node[i] = visit(node[i], target); return node; }
      for (const k of Object.keys(node)) {
        if (k === 'loc') continue;
        const tgt = (node.type === 'AssignStat' && k === 'targets') || (node.type === 'FunctionStat' && k === 'target');
        node[k] = visit(node[k], tgt);
      }
      if (isExpr(node)) {
        for (const c of cs) {
          const env = new Map<string, A.Expr>();
          if (match(c.from, node, env)) {
            if (c.pure && ![...env.values()].every(sideEffectFree)) continue;
            const r = instantiate(c.to, env);
            if (target && !ASSIGNABLE.has(r.type)) continue;
            n++; return r;
          }
        }
      }
      return node;
    };
    visit(root, false);
    total += n;
    if (!n) break;
  }
  return total;
}

const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;
const KEYWORDS = new Set(['and', 'break', 'do', 'else', 'elseif', 'end', 'false', 'for', 'function', 'if', 'in', 'local', 'nil', 'not', 'or', 'repeat', 'return', 'then', 'true', 'until', 'while', 'continue', 'goto', 'type', 'export']);
/** `E.x` / `E["x"]` -> global `x` for never-reassigned locals E = getfenv() */
export function globalsFromEnv(chunk: A.Chunk): number {
  const scope = analyzeScopes(chunk);
  const envs = new Set<any>();
  for (const b of scope.bindings) {
    if (b.kind === 'global' || b.writes > 0 || !b.init) continue;
    const u = unparen(b.init);
    if (u.type !== 'CallExpr' || u.callee.type !== 'NameExpr' || u.callee.name !== 'getfenv') continue;
    const cb = scope.globals.get('getfenv'); if (!cb || scope.refOf.get(u.callee) !== cb) continue;
    if (u.args.length > 1) continue;
    if (u.args.length === 1) { const a = unparen(u.args[0]); if (a.type !== 'NumberLit' || (a.value !== 0 && a.value !== 1)) continue; }
    envs.add(b);
  }
  if (!envs.size) return 0;
  // every local name declared anywhere (conservative shadowing check)
  const localNames = new Set<string>(); for (const b of scope.bindings) if (b.kind !== 'global') localNames.add(b.name);
  let n = 0;
  const key = (e: A.Expr): string | null => { if (e.type === 'MemberExpr') return e.name; if (e.type === 'IndexExpr') { const k = unparen(e.index); if (k.type === 'StringLit') return k.value; } return null; };
  const conv = (e: any): any => {
    if (!e || (e.type !== 'IndexExpr' && e.type !== 'MemberExpr')) return null;
    const o = unparen(e.obj); if (o.type !== 'NameExpr') return null;
    const b = scope.refOf.get(o); if (!b || !envs.has(b)) return null;
    const k = key(e); if (k === null || !IDENT.test(k) || KEYWORDS.has(k) || localNames.has(k)) return null;
    n++; return { type: 'NameExpr', name: k };
  };
  const visit = (node: any) => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) { for (let i = 0; i < node.length; i++) { const r = conv(node[i]); if (r) node[i] = r; else visit(node[i]); } return; }
    for (const k of Object.keys(node)) { if (k === 'loc') continue; const v = node[k]; const r = conv(v); if (r) node[k] = r; else visit(v); }
  };
  visit(chunk);
  void walk;
  return n;
}
