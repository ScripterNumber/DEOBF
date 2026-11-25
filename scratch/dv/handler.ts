// Select a constant opcode branch from parsed Lua syntax; no target code is run.
// Usage: node --import tsx scratch/dv/handler.ts <wrapper> <chunk-local> <slot> <field> <field-value> <opcode-var> <opcode>
import { readFileSync } from 'node:fs';
import { parse } from '../../packages/core/src/parser.js';
import { walk } from '../../packages/core/src/ast.js';
import { print } from '../../packages/core/src/printer.js';

const [path, localName, slot, field, fieldValueText, opcodeVar, opcodeText] = process.argv.slice(2);
if (!path || !localName || !slot || !field || !fieldValueText || !opcodeVar || !opcodeText) throw new Error('missing arguments');
const fieldValue = Number(fieldValueText);
const interval = /^(\d+):(\d+)$/.exec(opcodeText);
const first = Number(interval ? interval[1] : opcodeText), last = Number(interval ? interval[2] : opcodeText);
if (!Number.isSafeInteger(fieldValue) || !Number.isSafeInteger(first) || !Number.isSafeInteger(last) || first > last || last - first > 4095) throw new Error('invalid field value or opcode interval');
const wrapper = parse(new TextDecoder('utf-8', { fatal: true }).decode(readFileSync(path)));
if (wrapper.errors.length) throw new Error('wrapper parse errors');
const locals = wrapper.chunk.body.filter((node: any) => node.type === 'LocalStat' && node.names.includes(localName));
if (locals.length !== 1 || locals[0].type !== 'LocalStat') throw new Error('expected one local');
const literal = locals[0].init[locals[0].names.indexOf(localName)];
if (!literal || literal.type !== 'StringLit' || !literal.long) throw new Error('expected long literal');
const source = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.from(literal.value, 'latin1'));
const parsed = parse(source);
if (parsed.errors.length) throw new Error('chunk parse errors');
const funcs: any[] = [];
walk(parsed.chunk, (node: any) => {
  if (node.type !== 'TableExpr') return;
  for (const entry of node.fields) {
    if (entry.kind === 'keyed' && entry.key?.type === 'NumberLit' && String(entry.key.value) === slot && entry.value.type === 'FunctionExpr') funcs.push(entry.value);
  }
});
if (funcs.length !== 1) throw new Error('expected one slot function');
const matches: any[] = [];
walk(funcs[0], (node: any) => {
  if (node.type !== 'IfStat') return;
  for (const clause of node.clauses) {
    const c = clause.cond;
    if (c.type === 'BinExpr' && c.op === '==' && c.left?.type === 'NameExpr' && c.left.name === field && c.right?.type === 'NumberLit' && c.right.value === fieldValue) matches.push(clause);
  }
});
if (matches.length !== 1) throw new Error('expected one field branch');
const loops = matches[0].body.filter((node: any) => node.type === 'WhileStat');
if (loops.length !== 1) throw new Error('expected one dispatch loop');
const loop = loops[0];
if (loop.body[0]?.type !== 'LocalStat' || !loop.body[0].names.includes(opcodeVar)) throw new Error('expected opcode fetch as first statement');
for (const statement of loop.body.slice(1)) {
  walk(statement, (node: any) => {
    if (node.type === 'AssignStat' && node.targets.some((target: any) => target.type === 'NameExpr' && target.name === opcodeVar)) {
      throw new Error('opcode variable may be reassigned');
    }
  });
}

function predicate(expr: any, opcode: number): boolean | null {
  if (expr.type === 'ParenExpr') return predicate(expr.expr, opcode);
  if (expr.type !== 'BinExpr' || expr.left?.type !== 'NameExpr' || expr.left.name !== opcodeVar || expr.right?.type !== 'NumberLit') return null;
  const n = expr.right.value;
  switch (expr.op) {
    case '<': return opcode < n; case '<=': return opcode <= n; case '>': return opcode > n;
    case '>=': return opcode >= n; case '==': return opcode === n; case '~=': return opcode !== n;
    default: return null;
  }
}
function select(stats: any[], opcode: number, shadowed = false): string[] {
  const out: string[] = [];
  for (const statement of stats) {
    if (statement.type !== 'IfStat') {
      out.push(print(statement));
      if ((statement.type === 'LocalStat' && statement.names.includes(opcodeVar)) ||
          (statement.type === 'LocalFunctionStat' && statement.name === opcodeVar)) shadowed = true;
      continue;
    }
    if (shadowed) { out.push(print(statement)); continue; }
    let branch: any[] | undefined;
    let unknown = false;
    for (const clause of statement.clauses) {
      const result = predicate(clause.cond, opcode);
      if (result === null) { unknown = true; break; }
      if (result) { branch = clause.body; break; }
    }
    if (unknown) out.push(print(statement));
    else out.push(...select(branch ?? statement.elseBody ?? [], opcode, shadowed));
  }
  return out;
}
const common = { _provenance: { generator: 'CodeRabbit', version: 1 }, slot, field, fieldValue, opcodeVar,
  fetch: print(loop.body[0]), limitations: 'Syntactic branch selection only; unrelated conditions and state mutations remain in the output.' };
const output = interval
  ? { ...common, handlers: Array.from({ length: last - first + 1 }, (_, i) => ({ opcode: first + i, statements: select(loop.body.slice(1), first + i) })) }
  : { ...common, opcode: first, statements: select(loop.body.slice(1), first) };
console.log(JSON.stringify(output, null, 2));
