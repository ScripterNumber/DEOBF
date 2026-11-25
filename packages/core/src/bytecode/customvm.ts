// PRISM custom-VM disassembler: turn an extracted instruction list (JSON or Lua table literal)
// plus a user-editable opcode map into a readable listing. Works for any obfuscator VM.
import { parse } from '../parser.js';
import type * as A from '../ast.js';
import type { DispatchTree } from '../analysis/opcodes.js';

export interface OpEntry { name: string; lua?: string; args?: string; notes?: string }
export type OpMap = Record<string, OpEntry | string>;
export interface VmInsnIn { [k: string]: unknown }
export interface VmDisasmOptions {
  /** key/position of the opcode inside each instruction (auto: 'op' | 'opcode' | '1' | 0) */
  opField?: string | number;
  /** operand keys → letters, e.g. {"2":"A","3":"B","4":"C"} (auto: remaining keys in order → A,B,C,D…) */
  fields?: Record<string, string>;
  constants?: unknown[];
  /** index base of the constant table (Lua tables are usually 1-based) */
  kBase?: number;
  /** index base of instruction numbering for jump display */
  pcBase?: number;
  max?: number;
  /** index base used for array-shaped instructions: 0 = JS/JSON positions (default), 1 = Lua keys (inst[1] is the first element, as in Opcode Map roles) */
  keyBase?: number;
}
export interface VmDisasmResult { text: string; count: number; histogram: Array<{ op: string; name: string; count: number }>; unknown: string[]; fields: Record<string, string>; opField: string }

/** Static evaluation of a Lua literal (numbers, strings, booleans, nil, nested table constructors). */
export function luaLiteralToJson(src: string): unknown {
  const text = src.trim().replace(/^return\s+/, '');
  const { chunk } = parse('return ' + text);
  const st = chunk.body[0] as A.ReturnStat | undefined;
  if (!st || st.type !== 'ReturnStat' || st.args.length !== 1) throw new Error('expected a single Lua literal expression');
  const ev = (e: A.Expr): unknown => {
    switch (e.type) {
      case 'NumberLit': return e.value;
      case 'StringLit': return e.value;
      case 'TrueLit': return true;
      case 'FalseLit': return false;
      case 'NilLit': return null;
      case 'ParenExpr': return ev(e.expr);
      case 'UnExpr': if (e.op === '-') { const v = ev(e.expr); if (typeof v === 'number') return -v; } break;
      case 'TableExpr': {
        const arr: unknown[] = []; const obj: Record<string, unknown> = {}; let hasKeys = false;
        for (const it of e.fields) {
          if (it.kind === 'item') arr.push(ev(it.value));
          else { hasKeys = true; const k = it.kind === 'named' ? it.name : ev(it.key as A.Expr); obj[String(k)] = ev(it.value); }
        }
        if (!hasKeys) return arr;
        arr.forEach((v, i) => { obj[String(i + 1)] = v; });
        return obj;
      }
    }
    throw new Error(`non-literal expression at line ${(e as { loc?: { line: number } }).loc?.line ?? '?'} (${e.type}) — static literal evaluation only`);
  };
  return ev(st.args[0]);
}

export function opmapFromTree(tree: DispatchTree): Record<string, OpEntry> {
  const map: Record<string, OpEntry> = {};
  for (const h of tree.handlers) {
    const lua = h.lifted.split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('--')).join(' ').replace(/;\s*/g, '; ').replace(/;\s*$/, '');
    for (const op of h.opcodes) map[String(op)] = { name: h.guess || `OP_${op}`, lua: lua.length > 200 ? lua.slice(0, 200) + '…' : lua };
  }
  return map;
}

const entry = (m: OpMap, op: string): OpEntry | null => { const e = m[op]; return e === undefined ? null : typeof e === 'string' ? { name: e } : e; };
const show = (v: unknown): string => typeof v === 'string' ? JSON.stringify(v).length > 60 ? JSON.stringify(v.slice(0, 50)) + '…' : JSON.stringify(v) : v === null || v === undefined ? 'nil' : typeof v === 'object' ? (Array.isArray(v) ? `{…${v.length}}` : '{…}') : String(v);

export function vmDisassemble(instructions: unknown[], opmap: OpMap = {}, opts: VmDisasmOptions = {}): VmDisasmResult {
  if (!Array.isArray(instructions)) throw new Error('instructions must be an array');
  const kb = opts.keyBase ?? 0;
  const norm = instructions.map(ins => Array.isArray(ins) ? Object.fromEntries(ins.map((v, i) => [String(i + kb), v])) : typeof ins === 'object' && ins !== null ? ins as VmInsnIn : { [String(kb)]: ins });
  const keys = new Map<string, number>();
  for (const i of norm.slice(0, 500)) for (const k of Object.keys(i)) keys.set(k, (keys.get(k) ?? 0) + 1);
  const arrays = instructions.length > 0 && Array.isArray(instructions[0]);
  const opField = opts.opField !== undefined ? String(opts.opField) : arrays ? String(kb) : ['op', 'opcode', 'OP', 'Op', 'Opcode', '1', '0'].find(k => keys.has(k)) ?? [...keys.keys()][0] ?? '0';
  let fields = opts.fields;
  if (!fields) {
    fields = {}; let li = 0; const letters = 'ABCDEFGHIJ';
    const ks = [...keys.keys()].filter(k => k !== opField).sort((a, b) => (+a - +b) || a.localeCompare(b));
    for (const k of ks) fields[k] = /^[A-Za-z]{1,3}$/.test(k) && !/^\d+$/.test(k) ? k : letters[li++] ?? k;
  }
  const kBase = opts.kBase ?? 1, pcBase = opts.pcBase ?? 1;
  const hist = new Map<string, number>(); const unknown = new Set<string>();
  const lines: string[] = [];
  const max = opts.max ?? Infinity;
  norm.forEach((ins, idx) => {
    if (idx >= max) return;
    const op = String(ins[opField]);
    hist.set(op, (hist.get(op) ?? 0) + 1);
    const e = entry(opmap, op);
    if (!e) unknown.add(op);
    const vals: Record<string, unknown> = {};
    for (const [k, letter] of Object.entries(fields!)) if (k in ins) vals[letter] = ins[k];
    const operands = Object.entries(vals).map(([l, v]) => `${l}=${show(v)}`).join(' ');
    let lua = e?.lua ?? '';
    if (lua) {
      lua = lua.replace(/\bK\[\s*([A-Z])\s*\]/g, (m, l) => {
        const v = vals[l];
        if (typeof v === 'string' || typeof v === 'boolean') return show(v); // constant stored inline in the instruction
        if (typeof v !== 'number' || !opts.constants) return m.replace(l, show(v));
        return show(opts.constants[v - kBase]);
      }).replace(/\b([A-Z])\b/g, (m, l) => l in vals ? show(vals[l]) : m);
    }
    const name = e?.name ?? `OP_${op}`;
    let s = `${String(idx + pcBase).padStart(5, ' ')}  [${op.padStart(3)}] ${name.length > 28 ? name.slice(0, 27) + '…' : name.padEnd(28)} ${operands}`;
    if (lua) s = s.padEnd(78) + ' ; ' + lua;
    lines.push(s);
  });
  if (norm.length > max) lines.push(`; … ${norm.length - max} more instructions`);
  const histogram = [...hist].sort((a, b) => b[1] - a[1]).map(([op, count]) => ({ op, name: entry(opmap, op)?.name ?? `OP_${op}`, count }));
  const head = [`; PRISM custom-VM listing — ${norm.length} instructions, opcode field "${opField}", operands ${Object.entries(fields).map(([k, l]) => `${k}→${l}`).join(' ') || '(none)'}`];
  if (unknown.size) head.push(`; unmapped opcodes: ${[...unknown].sort((a, b) => +a - +b).join(' ')}`);
  return { text: head.join('\n') + '\n\n' + lines.join('\n'), count: norm.length, histogram, unknown: [...unknown], fields, opField };
}
