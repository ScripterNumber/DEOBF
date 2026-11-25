// PRISM AST — a compact, complete Luau AST.
export type Node =
  | Chunk | Block
  // statements
  | LocalStat | AssignStat | CallStat | DoStat | WhileStat | RepeatStat
  | IfStat | NumericForStat | GenericForStat | FunctionStat | LocalFunctionStat
  | ReturnStat | BreakStat | ContinueStat | GotoStat | LabelStat
  // expressions
  | NilLit | TrueLit | FalseLit | NumberLit | StringLit | VarargLit
  | NameExpr | IndexExpr | MemberExpr | CallExpr | MethodCallExpr
  | FunctionExpr | TableExpr | BinExpr | UnExpr | ParenExpr | InterpExpr | IfExpr;

export interface Pos { start: number; end: number; line: number; endLine?: number; }

interface Base { type: string; loc?: Pos; }

export interface Chunk extends Base { type: 'Chunk'; body: Stat[]; }
export interface Block extends Base { type: 'Block'; body: Stat[]; }

export type Stat =
  | LocalStat | AssignStat | CallStat | DoStat | WhileStat | RepeatStat
  | IfStat | NumericForStat | GenericForStat | FunctionStat | LocalFunctionStat
  | ReturnStat | BreakStat | ContinueStat | GotoStat | LabelStat;

export type Expr =
  | NilLit | TrueLit | FalseLit | NumberLit | StringLit | VarargLit
  | NameExpr | IndexExpr | MemberExpr | CallExpr | MethodCallExpr
  | FunctionExpr | TableExpr | BinExpr | UnExpr | ParenExpr | InterpExpr | IfExpr;

export interface LocalStat extends Base { type: 'LocalStat'; names: string[]; attribs?: (string|null)[]; init: Expr[]; }
export interface AssignStat extends Base { type: 'AssignStat'; targets: Expr[]; values: Expr[]; op?: string; } // op for compound (+=, ..=)
export interface CallStat extends Base { type: 'CallStat'; expr: CallExpr | MethodCallExpr; }
export interface DoStat extends Base { type: 'DoStat'; body: Stat[]; }
export interface WhileStat extends Base { type: 'WhileStat'; cond: Expr; body: Stat[]; }
export interface RepeatStat extends Base { type: 'RepeatStat'; body: Stat[]; cond: Expr; }
export interface IfClause { cond: Expr; body: Stat[]; }
export interface IfStat extends Base { type: 'IfStat'; clauses: IfClause[]; elseBody?: Stat[]; }
export interface NumericForStat extends Base { type: 'NumericForStat'; var: string; from: Expr; to: Expr; step?: Expr; body: Stat[]; }
export interface GenericForStat extends Base { type: 'GenericForStat'; names: string[]; iters: Expr[]; body: Stat[]; }
export interface FunctionStat extends Base { type: 'FunctionStat'; target: Expr; isMethod: boolean; func: FunctionExpr; }
export interface LocalFunctionStat extends Base { type: 'LocalFunctionStat'; name: string; func: FunctionExpr; }
export interface ReturnStat extends Base { type: 'ReturnStat'; args: Expr[]; }
export interface BreakStat extends Base { type: 'BreakStat'; }
export interface ContinueStat extends Base { type: 'ContinueStat'; }
export interface GotoStat extends Base { type: 'GotoStat'; label: string; }
export interface LabelStat extends Base { type: 'LabelStat'; name: string; }

export interface NilLit extends Base { type: 'NilLit'; }
export interface TrueLit extends Base { type: 'TrueLit'; }
export interface FalseLit extends Base { type: 'FalseLit'; }
export interface NumberLit extends Base { type: 'NumberLit'; value: number; raw: string; }
export interface StringLit extends Base { type: 'StringLit'; value: string; raw: string; long?: boolean; }
export interface VarargLit extends Base { type: 'VarargLit'; }
export interface NameExpr extends Base { type: 'NameExpr'; name: string; }
export interface IndexExpr extends Base { type: 'IndexExpr'; obj: Expr; index: Expr; }
export interface MemberExpr extends Base { type: 'MemberExpr'; obj: Expr; name: string; }
export interface CallExpr extends Base { type: 'CallExpr'; callee: Expr; args: Expr[]; }
export interface MethodCallExpr extends Base { type: 'MethodCallExpr'; obj: Expr; method: string; args: Expr[]; }
export interface FunctionExpr extends Base { type: 'FunctionExpr'; params: string[]; vararg: boolean; body: Stat[]; }
export interface TableField { kind: 'item' | 'named' | 'keyed'; key?: Expr; name?: string; value: Expr; }
export interface TableExpr extends Base { type: 'TableExpr'; fields: TableField[]; }
export interface BinExpr extends Base { type: 'BinExpr'; op: string; left: Expr; right: Expr; }
export interface UnExpr extends Base { type: 'UnExpr'; op: string; expr: Expr; }
export interface ParenExpr extends Base { type: 'ParenExpr'; expr: Expr; }
export interface InterpExpr extends Base { type: 'InterpExpr'; parts: Array<{ kind: 'str'; value: string } | { kind: 'expr'; expr: Expr }>; }
/** Luau `if c then a {elseif c then a} else b` expression (each branch yields exactly one value) */
export interface IfExpr extends Base { type: 'IfExpr'; clauses: Array<{ cond: Expr; value: Expr }>; elseValue: Expr; }

// Generic visitor: calls fn on every node; children discovered structurally.
export function walk(node: any, fn: (n: any, parent: any, key: string | null) => void, parent: any = null, key: string | null = null) {
  if (!node || typeof node !== 'object') return;
  if (typeof node.type === 'string') fn(node, parent, key);
  for (const k of Object.keys(node)) {
    if (k === 'loc' || k === 'type') continue;
    const v = (node as any)[k];
    if (Array.isArray(v)) { for (const el of v) walk(el, fn, node, k); }
    else if (v && typeof v === 'object') walk(v, fn, node, k);
  }
}
