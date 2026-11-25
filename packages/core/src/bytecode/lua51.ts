// PRISM Lua 5.1 bytecode reader + disassembler (the format consumed by in-Lua VMs such as
// FiOne / Rerubi / LBI / Yueliang-style interpreters). Static only — never executes anything.
export const LUA51_OPS = ['MOVE', 'LOADK', 'LOADBOOL', 'LOADNIL', 'GETUPVAL', 'GETGLOBAL', 'GETTABLE', 'SETGLOBAL', 'SETUPVAL', 'SETTABLE',
  'NEWTABLE', 'SELF', 'ADD', 'SUB', 'MUL', 'DIV', 'MOD', 'POW', 'UNM', 'NOT', 'LEN', 'CONCAT', 'JMP', 'EQ', 'LT', 'LE', 'TEST', 'TESTSET',
  'CALL', 'TAILCALL', 'RETURN', 'FORLOOP', 'FORPREP', 'TFORLOOP', 'SETLIST', 'CLOSE', 'CLOSURE', 'VARARG'];
type ArgMode = 'N' | 'U' | 'R' | 'K';
// [mode, B mode, C mode]
const MODES: Array<['ABC' | 'ABx' | 'AsBx', ArgMode, ArgMode]> = [
  ['ABC', 'R', 'N'], ['ABx', 'K', 'N'], ['ABC', 'U', 'U'], ['ABC', 'R', 'N'], ['ABC', 'U', 'N'], ['ABx', 'K', 'N'], ['ABC', 'R', 'K'],
  ['ABx', 'K', 'N'], ['ABC', 'U', 'N'], ['ABC', 'K', 'K'], ['ABC', 'U', 'U'], ['ABC', 'R', 'K'], ['ABC', 'K', 'K'], ['ABC', 'K', 'K'],
  ['ABC', 'K', 'K'], ['ABC', 'K', 'K'], ['ABC', 'K', 'K'], ['ABC', 'K', 'K'], ['ABC', 'R', 'N'], ['ABC', 'R', 'N'], ['ABC', 'R', 'N'],
  ['ABC', 'R', 'R'], ['AsBx', 'R', 'N'], ['ABC', 'K', 'K'], ['ABC', 'K', 'K'], ['ABC', 'K', 'K'], ['ABC', 'R', 'U'], ['ABC', 'R', 'U'],
  ['ABC', 'U', 'U'], ['ABC', 'U', 'U'], ['ABC', 'U', 'N'], ['AsBx', 'R', 'N'], ['AsBx', 'R', 'N'], ['ABC', 'N', 'U'], ['ABC', 'U', 'U'],
  ['ABC', 'N', 'N'], ['ABx', 'U', 'N'], ['ABC', 'U', 'N'],
];
export type Lua51Const = { type: 'nil' } | { type: 'boolean'; value: boolean } | { type: 'number'; value: number } | { type: 'string'; value: string };
export interface Lua51Proto {
  id: number; source: string | null; lineDefined: number; lastLineDefined: number; numUpvalues: number; numParams: number;
  isVararg: number; maxStack: number; code: number[]; consts: Lua51Const[]; protos: Lua51Proto[];
  lineInfo: number[]; locals: Array<{ name: string; startPc: number; endPc: number }>; upvalueNames: string[]; path: string;
}
export interface Lua51Chunk {
  version: number; format: number; littleEndian: boolean; sizeInt: number; sizeSizeT: number; sizeInstr: number; sizeNumber: number;
  integral: boolean; main: Lua51Proto; all: Lua51Proto[]; trailing: number;
}
export function detectLuaBytecode(b: Uint8Array): { lua: string; version: number } | null {
  if (b.length < 5 || b[0] !== 0x1b || b[1] !== 0x4c || b[2] !== 0x75 || b[3] !== 0x61) return null;
  const v = b[4];
  return { lua: `Lua ${v >> 4}.${v & 15}`, version: v };
}

export function parseLua51Bytecode(bytes: Uint8Array): Lua51Chunk {
  const det = detectLuaBytecode(bytes);
  if (!det) throw new Error('missing Lua bytecode signature (\\27Lua)');
  if (det.version !== 0x51) throw new Error(`${det.lua} bytecode detected — only Lua 5.1 is supported by this parser`);
  let pos = 5;
  const u8 = () => { if (pos >= bytes.length) throw new Error('unexpected end of bytecode at ' + pos); return bytes[pos++]; };
  const format = u8(), endian = u8(), sizeInt = u8(), sizeSizeT = u8(), sizeInstr = u8(), sizeNumber = u8(), integral = u8() !== 0;
  if (sizeInstr !== 4) throw new Error('unsupported instruction size ' + sizeInstr);
  const le = endian === 1;
  const uint = (n: number) => {
    if (pos + n > bytes.length) throw new Error('unexpected end of bytecode at ' + pos);
    let v = 0;
    for (let i = 0; i < n; i++) v += bytes[pos + (le ? i : n - 1 - i)] * 2 ** (8 * i);
    pos += n; return v;
  };
  const int = () => { const v = uint(sizeInt); return sizeInt === 4 && v >= 2 ** 31 ? v - 2 ** 32 : v; };
  const num = () => {
    if (pos + sizeNumber > bytes.length) throw new Error('unexpected end of bytecode at ' + pos);
    const sl = bytes.slice(pos, pos + sizeNumber); if (!le) sl.reverse(); pos += sizeNumber;
    const dv = new DataView(sl.buffer);
    if (integral) return sizeNumber === 8 ? Number(dv.getBigInt64(0, true)) : dv.getInt32(0, true);
    return sizeNumber === 8 ? dv.getFloat64(0, true) : dv.getFloat32(0, true);
  };
  const str = (): string | null => {
    const n = uint(sizeSizeT);
    if (n === 0) return null;
    if (pos + n > bytes.length) throw new Error(`string of length ${n} runs past end of input at ${pos}`);
    let s = ''; for (let i = 0; i < n - 1; i++) s += String.fromCharCode(bytes[pos + i]);
    pos += n; return s;
  };
  const all: Lua51Proto[] = [];
  const fn = (parentSource: string | null, path: string): Lua51Proto => {
    const source = str() ?? parentSource;
    const lineDefined = int(), lastLineDefined = int();
    const numUpvalues = u8(), numParams = u8(), isVararg = u8(), maxStack = u8();
    const ncode = int(); if (ncode < 0 || ncode * 4 > bytes.length) throw new Error('bad code size ' + ncode);
    const code: number[] = []; for (let i = 0; i < ncode; i++) code.push(uint(4));
    const nk = int(); if (nk < 0 || nk > bytes.length) throw new Error('bad constant count ' + nk);
    const consts: Lua51Const[] = [];
    for (let i = 0; i < nk; i++) {
      const t = u8();
      if (t === 0) consts.push({ type: 'nil' });
      else if (t === 1) consts.push({ type: 'boolean', value: u8() !== 0 });
      else if (t === 3) consts.push({ type: 'number', value: num() });
      else if (t === 4) consts.push({ type: 'string', value: str() ?? '' });
      else throw new Error(`unknown constant type ${t} at byte ${pos - 1}`);
    }
    const proto: Lua51Proto = { id: all.length, source, lineDefined, lastLineDefined, numUpvalues, numParams, isVararg, maxStack, code, consts, protos: [], lineInfo: [], locals: [], upvalueNames: [], path };
    all.push(proto);
    const np = int(); if (np < 0 || np > bytes.length) throw new Error('bad proto count ' + np);
    for (let i = 0; i < np; i++) proto.protos.push(fn(source, path + '.' + i));
    const nl = int(); for (let i = 0; i < nl; i++) proto.lineInfo.push(int());
    const nloc = int(); for (let i = 0; i < nloc; i++) proto.locals.push({ name: str() ?? '?', startPc: int(), endPc: int() });
    const nup = int(); for (let i = 0; i < nup; i++) proto.upvalueNames.push(str() ?? '?');
    return proto;
  };
  const main = fn(null, '0');
  return { version: 0x51, format, littleEndian: le, sizeInt, sizeSizeT, sizeInstr, sizeNumber, integral, main, all, trailing: bytes.length - pos };
}

export interface Lua51Insn { pc: number; raw: number; opcode: number; op: string; a: number; b: number; c: number; bx: number; sbx: number; target: number; line?: number; label?: number; asm: string; lua: string; data?: boolean }
const fmt14 = (v: number) => {
  // printf("%.14g")
  if (Number.isNaN(v)) return v.toString() === 'NaN' ? 'nan' : 'nan';
  if (!Number.isFinite(v)) return v > 0 ? 'inf' : '-inf';
  if (v === 0) return Object.is(v, -0) ? '-0' : '0';
  const [m, e] = v.toExponential(13).split('e'); const x = parseInt(e, 10);
  const trim = (t: string) => t.includes('.') ? t.replace(/0+$/, '').replace(/\.$/, '') : t;
  if (x < -4 || x >= 14) return trim(m) + 'e' + (x < 0 ? '-' : '+') + String(Math.abs(x)).padStart(2, '0');
  return trim(v.toFixed(Math.max(0, 13 - x)));
};
const isprint = (c: number) => c >= 32 && c < 127;
export function luacString(s: string) {
  let o = '"';
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    const esc: Record<number, string> = { 34: '\\"', 92: '\\\\', 7: '\\a', 8: '\\b', 12: '\\f', 10: '\\n', 13: '\\r', 9: '\\t', 11: '\\v' };
    o += esc[c] ?? (isprint(c) ? s[i] : '\\' + String(c & 255).padStart(3, '0'));
  }
  return o + '"';
}
export function fmtLua51Const(k: Lua51Const | undefined, style: 'rich' | 'luac' = 'rich'): string {
  if (!k) return '?';
  switch (k.type) {
    case 'nil': return 'nil';
    case 'boolean': return String(k.value);
    case 'number': return style === 'luac' ? fmt14(k.value) : String(k.value);
    case 'string': return style === 'luac' ? luacString(k.value) : luacString(k.value.length > 120 ? k.value.slice(0, 120) : k.value) + (k.value.length > 120 ? `…(${k.value.length} bytes)` : '');
  }
}
const IDENT51 = /^[A-Za-z_][A-Za-z0-9_]*$/;
export function decodeLua51Proto(p: Lua51Proto, style: 'rich' | 'luac' = 'rich'): Lua51Insn[] {
  const out: Lua51Insn[] = [];
  const labels = new Map<number, number>();
  const tg: number[] = [];
  const dec = (i: number) => ({ op: i & 63, a: (i >>> 6) & 255, c: (i >>> 14) & 511, b: (i >>> 23) & 511, bx: (i >>> 14) & 0x3ffff, sbx: ((i >>> 14) & 0x3ffff) - 131071 });
  for (let pc = 0; pc < p.code.length; pc++) {
    const d = dec(p.code[pc]); const n = LUA51_OPS[d.op];
    if (n === 'JMP' || n === 'FORLOOP' || n === 'FORPREP') tg.push(pc + 1 + d.sbx);
    if (n === 'EQ' || n === 'LT' || n === 'LE' || n === 'TEST' || n === 'TESTSET' || n === 'TFORLOOP' || (n === 'LOADBOOL' && d.c)) tg.push(pc + 2);
    if (n === 'SETLIST' && d.c === 0) pc++;
  }
  [...new Set(tg)].filter(t => t >= 0 && t <= p.code.length).sort((x, y) => x - y).forEach((t, i) => labels.set(t, i));
  const local = (r: number, pc: number) => { let best: string | null = null; let n = 0; for (const l of p.locals) { if (l.startPc <= pc && pc < l.endPc) { if (n === r) best = l.name; n++; } } return best; };
  for (let pc = 0; pc < p.code.length; pc++) {
    const raw = p.code[pc] >>> 0; const { op: opcode, a, b, c, bx, sbx } = dec(raw);
    const op = LUA51_OPS[opcode] ?? `OP_${opcode}`;
    const mode = MODES[opcode] ?? ['ABC', 'U', 'U'];
    const R = (r: number) => (style === 'rich' ? local(r, pc) : null) ?? `R${r}`;
    const K = (k: number) => fmtLua51Const(p.consts[k], style === 'luac' ? 'luac' : 'rich');
    const RK = (x: number) => x & 256 ? K(x & 255) : R(x);
    const U = (u: number) => p.upvalueNames[u] ?? `U${u}`;
    let target = -1;
    if (op === 'JMP' || op === 'FORLOOP' || op === 'FORPREP') target = pc + 1 + sbx;
    else if (['EQ', 'LT', 'LE', 'TEST', 'TESTSET', 'TFORLOOP'].includes(op) || (op === 'LOADBOOL' && c)) target = pc + 2;
    const L = (t: number) => labels.has(t) ? `L${labels.get(t)}` : `pc${t}`;
    // luac-style operand text
    let asm = op.padEnd(9) + '\t';
    if (mode[0] === 'ABC') { asm += `${a}`; if (mode[1] !== 'N') asm += ` ${b & 256 ? -1 - (b & 255) : b}`; if (mode[2] !== 'N') asm += ` ${c & 256 ? -1 - (c & 255) : c}`; }
    else if (mode[0] === 'ABx') asm += mode[1] === 'K' ? `${a} ${-1 - bx}` : `${a} ${bx}`;
    else asm += op === 'JMP' ? `${sbx}` : `${a} ${sbx}`;
    let note = '';
    switch (op) {
      case 'LOADK': note = K(bx); break;
      case 'GETUPVAL': case 'SETUPVAL': note = p.upvalueNames.length ? p.upvalueNames[b] ?? '?' : '-'; break;
      case 'GETGLOBAL': case 'SETGLOBAL': note = p.consts[bx]?.type === 'string' ? (p.consts[bx] as { value: string }).value : '?'; break;
      case 'GETTABLE': case 'SELF': if (c & 256) note = K(c & 255); break;
      case 'SETTABLE': case 'ADD': case 'SUB': case 'MUL': case 'DIV': case 'POW': case 'EQ': case 'LT': case 'LE':
        if (b & 256 || c & 256) note = (b & 256 ? K(b & 255) : '-') + ' ' + (c & 256 ? K(c & 255) : '-'); break;
      case 'JMP': case 'FORLOOP': case 'FORPREP': note = `to ${sbx + pc + 2}`; break;
      case 'CLOSURE': note = `P${p.protos[bx]?.path ?? bx}`; break;
      case 'SETLIST': note = c === 0 ? String(p.code[pc + 1] >>> 0) : String(c); break;
    }
    if (note) asm += '\t; ' + note;
    // pseudo-Lua
    const nextT = (() => { const n = p.code[pc + 1]; if (n === undefined) return 'next'; const d = dec(n); return LUA51_OPS[d.op] === 'JMP' ? L(pc + 2 + d.sbx) : 'pc' + (pc + 1); })();
    const bin = (s: string) => `${R(a)} = ${RK(b)} ${s} ${RK(c)}`;
    const range = (from: number, n: number) => Array.from({ length: Math.max(0, n) }, (_, i) => R(from + i)).join(', ');
    let lua = '';
    switch (op) {
      case 'MOVE': lua = `${R(a)} = ${R(b)}`; break;
      case 'LOADK': lua = `${R(a)} = ${K(bx)}`; break;
      case 'LOADBOOL': lua = `${R(a)} = ${b ? 'true' : 'false'}${c ? `; goto ${L(pc + 2)}` : ''}`; break;
      case 'LOADNIL': lua = `${range(a, b - a + 1)} = nil`; break;
      case 'GETUPVAL': lua = `${R(a)} = ${U(b)}`; break;
      case 'GETGLOBAL': { const k = p.consts[bx]; lua = `${R(a)} = ${k?.type === 'string' && IDENT51.test(k.value) ? k.value : `_G[${K(bx)}]`}`; break; }
      case 'SETGLOBAL': { const k = p.consts[bx]; lua = `${k?.type === 'string' && IDENT51.test(k.value) ? k.value : `_G[${K(bx)}]`} = ${R(a)}`; break; }
      case 'GETTABLE': lua = `${R(a)} = ${R(b)}${fieldOf(p, c, RK)}`; break;
      case 'SETUPVAL': lua = `${U(b)} = ${R(a)}`; break;
      case 'SETTABLE': lua = `${R(a)}${fieldOf(p, b, RK)} = ${RK(c)}`; break;
      case 'NEWTABLE': lua = `${R(a)} = {}  -- array ${fb2int(b)}, hash ${fb2int(c)}`; break;
      case 'SELF': lua = `${R(a + 1)} = ${R(b)}; ${R(a)} = ${R(b)}${fieldOf(p, c, RK)}`; break;
      case 'ADD': lua = bin('+'); break; case 'SUB': lua = bin('-'); break; case 'MUL': lua = bin('*'); break;
      case 'DIV': lua = bin('/'); break; case 'MOD': lua = bin('%'); break; case 'POW': lua = bin('^'); break;
      case 'UNM': lua = `${R(a)} = -${R(b)}`; break; case 'NOT': lua = `${R(a)} = not ${R(b)}`; break; case 'LEN': lua = `${R(a)} = #${R(b)}`; break;
      case 'CONCAT': lua = `${R(a)} = ${Array.from({ length: c - b + 1 }, (_, i) => R(b + i)).join(' .. ')}`; break;
      case 'JMP': lua = `goto ${L(pc + 1 + sbx)}`; break;
      case 'EQ': lua = `if ${RK(b)} ${a ? '==' : '~='} ${RK(c)} then goto ${nextT}  -- else skip`; break;
      case 'LT': lua = `if ${a ? '' : 'not '}(${RK(b)} < ${RK(c)}) then goto ${nextT}  -- else skip`; break;
      case 'LE': lua = `if ${a ? '' : 'not '}(${RK(b)} <= ${RK(c)}) then goto ${nextT}  -- else skip`; break;
      case 'TEST': lua = `if ${c ? '' : 'not '}${R(a)} then goto ${nextT}  -- else skip`; break;
      case 'TESTSET': lua = `if ${c ? '' : 'not '}${R(b)} then ${R(a)} = ${R(b)}; goto ${nextT}  -- else skip`; break;
      case 'CALL': lua = `${c === 0 ? `${R(a)}, ... = ` : c === 1 ? '' : range(a, c - 1) + ' = '}${R(a)}(${b === 0 ? `${R(a + 1)}, ...` : range(a + 1, b - 1)})`; break;
      case 'TAILCALL': lua = `return ${R(a)}(${b === 0 ? `${R(a + 1)}, ...` : range(a + 1, b - 1)})`; break;
      case 'RETURN': lua = b === 0 ? `return ${R(a)}, ...` : `return ${range(a, b - 1)}`.trimEnd(); break;
      case 'FORLOOP': lua = `${R(a)} += ${R(a + 2)}; if ${R(a)} <= ${R(a + 1)} then ${R(a + 3)} = ${R(a)}; goto ${L(pc + 1 + sbx)}`; break;
      case 'FORPREP': lua = `${R(a)} -= ${R(a + 2)}; goto ${L(pc + 1 + sbx)}  -- for ${R(a + 3)} = ${R(a)}, ${R(a + 1)}, ${R(a + 2)}`; break;
      case 'TFORLOOP': lua = `${range(a + 3, c)} = ${R(a)}(${R(a + 1)}, ${R(a + 2)}); if ${R(a + 3)} ~= nil then ${R(a + 2)} = ${R(a + 3)} else skip`; break;
      case 'SETLIST': { const cc = c === 0 ? p.code[pc + 1] >>> 0 : c; const base = (cc - 1) * 50; lua = b === 0 ? `${R(a)}[${base + 1}...] = ${R(a + 1)}, ...` : `${R(a)}[${base + 1}..${base + b}] = ${range(a + 1, b)}`; break; }
      case 'CLOSE': lua = `-- close upvalues >= ${R(a)}`; break;
      case 'CLOSURE': { const cp = p.protos[bx]; lua = `${R(a)} = function<P${cp?.path ?? bx}>${cp ? ` (${cp.numUpvalues} upvalues from next ${cp.numUpvalues} insns)` : ''}`; break; }
      case 'VARARG': lua = b === 0 ? `${R(a)}, ... = ...` : `${range(a, b - 1)} = ...`; break;
      default: lua = `-- unknown opcode ${opcode}`;
    }
    out.push({ pc, raw, opcode, op, a, b, c, bx, sbx, target, line: p.lineInfo[pc], label: labels.get(pc), asm, lua });
    if (op === 'SETLIST' && c === 0 && pc + 1 < p.code.length) { pc++; out.push({ pc, raw: p.code[pc] >>> 0, opcode: -1, op: 'DATA', a: 0, b: 0, c: 0, bx: 0, sbx: 0, target: -1, asm: `DATA ${p.code[pc] >>> 0}`, lua: '-- SETLIST block number', data: true }); }
  }
  return out;
}
function fieldOf(p: Lua51Proto, x: number, RK: (x: number) => string) {
  if (x & 256) { const k = p.consts[x & 255]; if (k?.type === 'string' && IDENT51.test(k.value)) return '.' + k.value; }
  return '[' + RK(x) + ']';
}
const fb2int = (x: number) => { const e = (x >> 3) & 31; return e === 0 ? x : ((x & 7) + 8) * 2 ** (e - 1); };

export function disassembleLua51(chunk: Lua51Chunk, opts: { style?: 'rich' | 'luac'; hex?: boolean; lift?: boolean; constants?: boolean } = {}): string {
  const style = opts.style ?? 'rich'; const lift = opts.lift ?? true;
  const out: string[] = [];
  if (style === 'rich') {
    out.push(`; PRISM Lua 5.1 disassembly — ${chunk.littleEndian ? 'little' : 'big'}-endian, int ${chunk.sizeInt}, size_t ${chunk.sizeSizeT}, number ${chunk.sizeNumber}${chunk.integral ? ' (integral)' : ''}`);
    out.push(`; ${chunk.all.length} functions${chunk.trailing ? `, ${chunk.trailing} trailing bytes` : ''}`, '');
  }
  for (const p of chunk.all) {
    const insns = decodeLua51Proto(p, style);
    if (style === 'luac') {
      out.push(`${p.lineDefined === 0 ? 'main' : 'function'} <${p.lineDefined},${p.lastLineDefined}> (${p.code.length} instructions)`);
      for (const i of insns) if (!i.data) out.push(`\t${i.pc + 1}\t${i.line ? `[${i.line}]` : '[-]'}\t${i.asm}`);
      out.push('');
      continue;
    }
    out.push(`; ${'─'.repeat(70)}`);
    out.push(`function P${p.path}${p.source ? ` <${p.source.replace(/^[@=]/, '')}:${p.lineDefined},${p.lastLineDefined}>` : ` <${p.lineDefined},${p.lastLineDefined}>`}`);
    out.push(`; params ${p.numParams}${p.isVararg ? ' + vararg' : ''}, upvalues ${p.numUpvalues}, maxstack ${p.maxStack}, ${p.code.length} instructions, ${p.consts.length} constants, ${p.protos.length} children`);
    if (p.upvalueNames.length) out.push('; upvalues: ' + p.upvalueNames.map((n, i) => `U${i}=${n}`).join(' '));
    if ((opts.constants ?? true) && p.consts.length) { out.push('; constants:'); p.consts.forEach((k, i) => out.push(`;   K${i} ${k.type.padEnd(7)} ${fmtLua51Const(k)}`)); }
    if (p.locals.length) out.push('; locals: ' + p.locals.map(l => `${l.name}@${l.startPc}-${l.endPc}`).join(' '));
    let lastLine = -1;
    for (const i of insns) {
      if (i.label !== undefined) out.push(`L${i.label}:`);
      let s = '  ' + String(i.pc).padStart(4, '0');
      if (opts.hex) s += '  ' + i.raw.toString(16).padStart(8, '0');
      s += '  ' + i.asm.replace(/\s*\t; .*$/, '').replace(/\s+/g, ' ');
      if (lift) s = s.padEnd(opts.hex ? 50 : 40) + ' ; ' + i.lua;
      if (i.line && i.line !== lastLine) { s += `  @${i.line}`; lastLine = i.line; }
      out.push(s);
    }
    out.push('');
  }
  return out.join('\n');
}
