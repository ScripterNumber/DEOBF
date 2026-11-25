// PRISM Luau bytecode reader + disassembler.
// Supports bytecode versions 3..14 (+ experimental 100), type-info versions 1..3,
// and the Roblox opcode encoding (op * 227 mod 256), auto-detected.
// Static only: parses bytes, never loads or executes them.
export const LUAU_OPS = [
  'NOP', 'BREAK', 'LOADNIL', 'LOADB', 'LOADN', 'LOADK', 'MOVE', 'GETGLOBAL', 'SETGLOBAL', 'GETUPVAL', 'SETUPVAL', 'CLOSEUPVALS',
  'GETIMPORT', 'GETTABLE', 'SETTABLE', 'GETTABLEKS', 'SETTABLEKS', 'GETTABLEN', 'SETTABLEN', 'NEWCLOSURE', 'NAMECALL', 'CALL',
  'RETURN', 'JUMP', 'JUMPBACK', 'JUMPIF', 'JUMPIFNOT', 'JUMPIFEQ', 'JUMPIFLE', 'JUMPIFLT', 'JUMPIFNOTEQ', 'JUMPIFNOTLE',
  'JUMPIFNOTLT', 'ADD', 'SUB', 'MUL', 'DIV', 'MOD', 'POW', 'ADDK', 'SUBK', 'MULK', 'DIVK', 'MODK', 'POWK', 'AND', 'OR',
  'ANDK', 'ORK', 'CONCAT', 'NOT', 'MINUS', 'LENGTH', 'NEWTABLE', 'DUPTABLE', 'SETLIST', 'FORNPREP', 'FORNLOOP', 'FORGLOOP',
  'FORGPREP_INEXT', 'FASTCALL3', 'FORGPREP_NEXT', 'NATIVECALL', 'GETVARARGS', 'DUPCLOSURE', 'PREPVARARGS', 'LOADKX', 'JUMPX',
  'FASTCALL', 'COVERAGE', 'CAPTURE', 'SUBRK', 'DIVRK', 'FASTCALL1', 'FASTCALL2', 'FASTCALL2K', 'FORGPREP', 'JUMPXEQKNIL',
  'JUMPXEQKB', 'JUMPXEQKN', 'JUMPXEQKS', 'IDIV', 'IDIVK', 'GETUDATAKS', 'SETUDATAKS', 'NAMECALLUDATA', 'NEWCLASSMEMBER',
  'CALLFB', 'CMPPROTO', 'FASTPCALL', 'NEWCLASS', 'CONSTRUCT', 'FINCONSTRUCT', 'GETPRIVATEFIELD', 'SETPRIVATEFIELD',
];
export const LUAU_OP: Record<string, number> = Object.fromEntries(LUAU_OPS.map((n, i) => [n, i]));
const AUX_OPS = new Set(['GETGLOBAL', 'SETGLOBAL', 'GETIMPORT', 'GETTABLEKS', 'SETTABLEKS', 'NAMECALL', 'JUMPIFEQ', 'JUMPIFLE', 'JUMPIFLT',
  'JUMPIFNOTEQ', 'JUMPIFNOTLE', 'JUMPIFNOTLT', 'NEWTABLE', 'SETLIST', 'FORGLOOP', 'LOADKX', 'FASTCALL2', 'FASTCALL2K', 'FASTCALL3',
  'JUMPXEQKNIL', 'JUMPXEQKB', 'JUMPXEQKN', 'JUMPXEQKS', 'GETUDATAKS', 'SETUDATAKS', 'NAMECALLUDATA', 'NEWCLASSMEMBER', 'CALLFB',
  'CMPPROTO', 'NEWCLASS', 'CONSTRUCT', 'GETPRIVATEFIELD', 'SETPRIVATEFIELD']);
const JUMPD_OPS = new Set(['JUMP', 'JUMPIF', 'JUMPIFNOT', 'JUMPIFEQ', 'JUMPIFLE', 'JUMPIFLT', 'JUMPIFNOTEQ', 'JUMPIFNOTLE', 'JUMPIFNOTLT',
  'FORNPREP', 'FORNLOOP', 'FORGPREP', 'FORGLOOP', 'FORGPREP_INEXT', 'FORGPREP_NEXT', 'JUMPBACK', 'JUMPXEQKNIL', 'JUMPXEQKB', 'JUMPXEQKN',
  'JUMPXEQKS', 'CMPPROTO']);
const FASTCALL_OPS = new Set(['FASTCALL', 'FASTCALL1', 'FASTCALL2', 'FASTCALL2K', 'FASTCALL3', 'FASTPCALL', 'FINCONSTRUCT']);
const NOFALL_OPS = new Set(['RETURN', 'JUMP', 'JUMPBACK', 'JUMPX', 'FORGPREP', 'FORGPREP_NEXT', 'FORGPREP_INEXT']);
export const LUAU_BUILTINS = ['none', 'assert', 'math.abs', 'math.acos', 'math.asin', 'math.atan2', 'math.atan', 'math.ceil', 'math.cosh', 'math.cos', 'math.deg', 'math.exp', 'math.floor', 'math.fmod', 'math.frexp', 'math.ldexp', 'math.log10', 'math.log', 'math.max', 'math.min', 'math.modf', 'math.pow', 'math.rad', 'math.sinh', 'math.sin', 'math.sqrt', 'math.tanh', 'math.tan', 'bit32.arshift', 'bit32.band', 'bit32.bnot', 'bit32.bor', 'bit32.bxor', 'bit32.btest', 'bit32.extract', 'bit32.lrotate', 'bit32.lshift', 'bit32.replace', 'bit32.rrotate', 'bit32.rshift', 'type', 'string.byte', 'string.char', 'string.len', 'typeof', 'string.sub', 'math.clamp', 'math.sign', 'math.round', 'rawset', 'rawget', 'rawequal', 'table.insert', 'table.unpack', 'vector.create', 'bit32.countlz', 'bit32.countrz', 'select', 'rawlen', 'bit32.extractk', 'getmetatable', 'setmetatable', 'tonumber', 'tostring', 'bit32.byteswap', 'buffer.readi8', 'buffer.readu8', 'buffer.writeu8', 'buffer.readi16', 'buffer.readu16', 'buffer.writeu16', 'buffer.readi32', 'buffer.readu32', 'buffer.writeu32', 'buffer.readf32', 'buffer.writef32', 'buffer.readf64', 'buffer.writef64', 'vector.magnitude', 'vector.normalize', 'vector.cross', 'vector.dot', 'vector.floor', 'vector.ceil', 'vector.abs', 'vector.sign', 'vector.clamp', 'vector.min', 'vector.max', 'math.lerp', 'vector.lerp', 'math.isnan', 'math.isinf', 'math.isfinite', 'integer.create', 'integer.tonumber', 'integer.neg', 'integer.add', 'integer.sub', 'integer.mul', 'integer.div', 'integer.min', 'integer.max', 'integer.rem', 'integer.idiv', 'integer.udiv', 'integer.urem', 'integer.mod', 'integer.clamp', 'integer.band', 'integer.bor', 'integer.bnot', 'integer.bxor', 'integer.lt', 'integer.le', 'integer.ult', 'integer.ule', 'integer.gt', 'integer.ge', 'integer.ugt', 'integer.uge', 'integer.lshift', 'integer.rshift', 'integer.arshift', 'integer.lrotate', 'integer.rrotate', 'integer.extract', 'integer.btest', 'integer.countrz', 'integer.countlz', 'integer.bswap', 'buffer.readinteger', 'buffer.writeinteger', 'table.create', 'table.clear'];

export const opName = (op: number) => LUAU_OPS[op] ?? 'OP_' + op;
export const opLength = (op: number) => AUX_OPS.has(LUAU_OPS[op]) ? 2 : 1;
export const insA = (i: number) => (i >>> 8) & 255;
export const insB = (i: number) => (i >>> 16) & 255;
export const insC = (i: number) => (i >>> 24) & 255;
export const insD = (i: number) => i >> 16;
export const insE = (i: number) => i >> 8;
/** Jump target pc of the instruction at pc, or -1 (mirrors Luau's getJumpTarget). */
export function jumpTarget(ins: number, pc: number): number {
  const n = LUAU_OPS[ins & 255];
  if (JUMPD_OPS.has(n)) return pc + insD(ins) + 1;
  if (FASTCALL_OPS.has(n)) return pc + insC(ins) + 2;
  if (n === 'LOADB' && insC(ins)) return pc + insC(ins) + 1;
  if (n === 'JUMPX') return pc + insE(ins) + 1;
  return -1;
}
export const isFallthrough = (op: number) => !NOFALL_OPS.has(LUAU_OPS[op]);

export type LuauConst =
  | { type: 'nil' } | { type: 'boolean'; value: boolean } | { type: 'number'; value: number; negNaN?: boolean } | { type: 'string'; value: string }
  | { type: 'import'; id: number; path: string } | { type: 'table'; keys: number[]; values?: number[] } | { type: 'closure'; proto: number }
  | { type: 'vector'; value: number[] } | { type: 'integer'; value: bigint }
  | { type: 'class'; name: number; fields: number[]; methods: number[]; privateFields: number; privateMethods: number };

export interface LuauProto {
  id: number; maxStack: number; numParams: number; numUpvalues: number; isVararg: boolean; flags: number; typeInfo: number[];
  code: number[]; consts: LuauConst[]; children: number[]; lineDefined: number; debugName: string | null;
  lineInfo?: number[]; locals?: Array<{ name: string; startPc: number; endPc: number; reg: number }>; upvalueNames?: string[];
  feedback?: Array<{ kind: number; value: number }>; cost?: number; byteOffset: number; byteLength: number;
}
export interface LuauChunk {
  version: number; typesVersion: number; strings: string[]; protos: LuauProto[]; main: number;
  encoding: 'plain' | 'roblox'; userdataTypes?: string[]; trailing: number; warnings: string[];
}

class Reader {
  pos = 0;
  constructor(public b: Uint8Array) {}
  need(n: number) { if (this.pos + n > this.b.length) throw new Error(`unexpected end of bytecode at byte ${this.pos} (need ${n})`); }
  u8() { this.need(1); return this.b[this.pos++]; }
  u32() { this.need(4); const p = this.pos; this.pos += 4; return (this.b[p] | (this.b[p + 1] << 8) | (this.b[p + 2] << 16) | (this.b[p + 3] << 24)) >>> 0; }
  i32() { return this.u32() | 0; }
  f64() { this.need(8); const v = new DataView(this.b.buffer, this.b.byteOffset + this.pos, 8).getFloat64(0, true); this.pos += 8; return v; }
  f32() { this.need(4); const v = new DataView(this.b.buffer, this.b.byteOffset + this.pos, 4).getFloat32(0, true); this.pos += 4; return v; }
  varint() { let r = 0, s = 0, b: number; do { b = this.u8(); r += (b & 127) * 2 ** s; s += 7; } while (b & 128 && s < 63); return r; }
  varint64() { let r = 0n, s = 0n, b: number; do { b = this.u8(); r |= BigInt(b & 127) << s; s += 7n; } while (b & 128 && s < 70n); return r; }
  bytes(n: number) { this.need(n); const s = this.b.subarray(this.pos, this.pos + n); this.pos += n; return s; }
}
const latin1 = (b: Uint8Array) => { let s = ''; for (let i = 0; i < b.length; i += 8192) s += String.fromCharCode(...b.subarray(i, i + 8192)); return s; };

/** Decode the opcode byte of every instruction word (AUX words untouched). */
function decodeOps(code: number[], map: (op: number) => number) {
  const out = code.slice();
  for (let pc = 0; pc < out.length;) {
    const op = map(out[pc] & 255);
    out[pc] = ((out[pc] & ~255) | op) >>> 0;
    pc += opLength(op);
  }
  return out;
}
function invalidOps(protos: LuauProto[], map: (op: number) => number) {
  let bad = 0, total = 0;
  for (const p of protos) for (let pc = 0; pc < p.code.length && total < 4000;) {
    const op = map(p.code[pc] & 255); total++;
    if (op >= LUAU_OPS.length || op === LUAU_OP.NATIVECALL) bad++;
    pc += opLength(op < LUAU_OPS.length ? op : 0);
  }
  return bad;
}
export const robloxDecodeOp = (op: number) => (op * 203) & 255;
export const robloxEncodeOp = (op: number) => (op * 227) & 255;

export function parseLuauBytecode(bytes: Uint8Array, opts: { encoding?: 'auto' | 'plain' | 'roblox' } = {}): LuauChunk {
  const r = new Reader(bytes);
  const warnings: string[] = [];
  const version = r.u8();
  if (version === 0) throw new Error('bytecode contains a compile error: ' + latin1(bytes.subarray(1)));
  if ((version < 3 || version > 14) && version !== 100) throw new Error('unsupported Luau bytecode version ' + version + ' (expected 3..14)');
  const typesVersion = version >= 4 ? r.u8() : 0;
  if (version >= 4 && (typesVersion < 1 || typesVersion > 3)) warnings.push('unexpected types version ' + typesVersion);
  const nstr = r.varint();
  if (nstr > bytes.length) throw new Error('string count ' + nstr + ' exceeds input size — not Luau bytecode?');
  const strings: string[] = [];
  for (let i = 0; i < nstr; i++) strings.push(latin1(r.bytes(r.varint())));
  const sref = (i: number) => i === 0 ? null : strings[i - 1] ?? `<str#${i}>`;
  let userdataTypes: string[] | undefined;
  if (typesVersion === 3) { userdataTypes = []; let idx = r.u8(); while (idx !== 0) { userdataTypes.push(sref(r.varint()) ?? '?'); idx = r.u8(); } }
  const nproto = r.varint();
  if (nproto > bytes.length) throw new Error('proto count ' + nproto + ' exceeds input size');
  const protos: LuauProto[] = [];
  for (let p = 0; p < nproto; p++) {
    const protoSize = version >= 12 ? r.varint() : 0;
    const start = r.pos;
    const maxStack = r.u8(), numParams = r.u8(), numUpvalues = r.u8(), isVararg = r.u8() !== 0;
    let flags = 0, typeInfo: number[] = [];
    if (version >= 4) { flags = r.u8(); const n = r.varint(); typeInfo = Array.from(r.bytes(n)); }
    const ncode = r.varint();
    if (ncode * 4 > bytes.length) throw new Error(`proto ${p}: code size ${ncode} exceeds input`);
    const code: number[] = [];
    for (let i = 0; i < ncode; i++) code.push(r.u32());
    const nk = r.varint();
    if (nk > bytes.length) throw new Error(`proto ${p}: constant count ${nk} exceeds input`);
    const consts: LuauConst[] = [];
    for (let i = 0; i < nk; i++) {
      const t = r.u8();
      switch (t) {
        case 0: consts.push({ type: 'nil' }); break;
        case 1: consts.push({ type: 'boolean', value: r.u8() !== 0 }); break;
        case 2: { const hi = bytes[r.pos + 7]; const v = r.f64(); consts.push(Number.isNaN(v) && hi & 128 ? { type: 'number', value: v, negNaN: true } : { type: 'number', value: v }); break; }
        case 3: consts.push({ type: 'string', value: sref(r.varint()) ?? '' }); break;
        case 4: consts.push({ type: 'import', id: r.u32(), path: '' }); break;
        case 5: { const n = r.varint(); const keys: number[] = []; for (let j = 0; j < n; j++) keys.push(r.varint()); consts.push({ type: 'table', keys }); break; }
        case 6: consts.push({ type: 'closure', proto: r.varint() }); break;
        case 7: consts.push({ type: 'vector', value: [r.f32(), r.f32(), r.f32(), r.f32()] }); break;
        case 8: { const n = r.varint(); const keys: number[] = [], values: number[] = []; for (let j = 0; j < n; j++) { keys.push(r.varint()); values.push(r.i32()); } consts.push({ type: 'table', keys, values }); break; }
        case 9: { const neg = r.u8() !== 0; const mag = r.varint64(); consts.push({ type: 'integer', value: BigInt.asIntN(64, neg ? -mag : mag) }); break; }
        case 10: {
          const name = r.varint(); const privateFields = r.u8(), privateMethods = r.u8();
          const nprops = r.varint(), nmeth = r.varint();
          const fields: number[] = [], methods: number[] = [];
          for (let j = 0; j < nprops - privateFields; j++) fields.push(r.varint());
          for (let j = 0; j < nmeth - privateMethods; j++) methods.push(r.varint());
          consts.push({ type: 'class', name, fields, methods, privateFields, privateMethods }); break;
        }
        case 11: consts.push({ type: 'vector', value: [r.f64(), r.f64(), r.f64(), r.f64()] }); break;
        default: throw new Error(`unknown constant type ${t} (proto ${p}, K${i}, byte ${r.pos - 1})`);
      }
    }
    const np = r.varint();
    const children: number[] = [];
    for (let i = 0; i < np; i++) children.push(r.varint());
    const lineDefined = r.varint();
    const debugName = sref(r.varint());
    const proto: LuauProto = { id: p, maxStack, numParams, numUpvalues, isVararg, flags, typeInfo, code, consts, children, lineDefined, debugName, byteOffset: start, byteLength: 0 };
    if (r.u8()) {
      const gap = r.u8();
      const intervals = ((ncode - 1) >> gap) + 1;
      const deltas: number[] = []; let last = 0;
      for (let i = 0; i < ncode; i++) { last = (last + r.u8()) & 255; deltas.push(last); }
      const abs: number[] = []; let line = 0;
      for (let i = 0; i < intervals; i++) { line = (line + r.i32()) | 0; abs.push(line); }
      proto.lineInfo = deltas.map((d, i) => abs[i >> gap] + d);
    }
    if (r.u8()) {
      const nl = r.varint(); proto.locals = [];
      for (let i = 0; i < nl; i++) proto.locals.push({ name: sref(r.varint()) ?? '?', startPc: r.varint(), endPc: r.varint(), reg: r.u8() });
      const nu = r.varint(); proto.upvalueNames = [];
      for (let i = 0; i < nu; i++) proto.upvalueNames.push(sref(r.varint()) ?? '?');
    }
    if (version >= 11) {
      const nfb = r.varint(); proto.feedback = [];
      for (let i = 0; i < nfb; i++) { const kind = r.u8(); proto.feedback.push({ kind, value: kind <= 1 ? r.varint() : 0 }); }
    }
    if (version >= 12 && (flags & 8)) proto.cost = Number(r.varint64());
    if (version >= 12) {
      if (r.pos > start + protoSize) warnings.push(`proto ${p}: parsed past declared size (${r.pos - start} > ${protoSize})`);
      r.pos = start + protoSize;
    }
    proto.byteLength = r.pos - start;
    protos.push(proto);
  }
  const main = r.varint();
  if (main >= protos.length) throw new Error('main proto id ' + main + ' out of range');
  const trailing = bytes.length - r.pos;
  if (trailing) warnings.push(trailing + ' trailing bytes after bytecode');
  // resolve import paths
  for (const p of protos) for (const k of p.consts) if (k.type === 'import') {
    const n = k.id >>> 30; const ids = [(k.id >>> 20) & 1023, (k.id >>> 10) & 1023, k.id & 1023].slice(0, n);
    k.path = ids.map(i => { const c = p.consts[i]; return c && c.type === 'string' ? c.value : '?'; }).join('.');
  }
  // opcode encoding: main chunk always starts with PREPVARARGS; Roblox stores op*227 (mod 256)
  let encoding: 'plain' | 'roblox' = opts.encoding === 'roblox' ? 'roblox' : 'plain';
  if (opts.encoding !== 'plain' && opts.encoding !== 'roblox') {
    const first = protos[main].code[0] & 255;
    if (first === robloxEncodeOp(LUAU_OP.PREPVARARGS)) encoding = 'roblox';
    else if (first !== LUAU_OP.PREPVARARGS && invalidOps(protos, robloxDecodeOp) < invalidOps(protos, x => x)) encoding = 'roblox';
  }
  if (encoding === 'roblox') for (const p of protos) p.code = decodeOps(p.code, robloxDecodeOp);
  return { version, typesVersion, strings, protos, main, encoding, userdataTypes, trailing, warnings };
}

/** Heuristic: does this byte string look like Luau bytecode? */
export function looksLikeLuauBytecode(bytes: Uint8Array): boolean {
  if (bytes.length < 8) return false;
  const v = bytes[0];
  if (!((v >= 3 && v <= 14) || v === 100)) return false;
  try { parseLuauBytecode(bytes); return true; } catch { return false; }
}

// ───────────────────────────── disassembler ─────────────────────────────
/** printf("%.17g")-compatible number formatting (luau-compile style). */
export function fmtG(v: number, p = 17): string {
  if (Number.isNaN(v)) return 'nan';
  if (!Number.isFinite(v)) return v > 0 ? 'inf' : '-inf';
  if (v === 0) return Object.is(v, -0) ? '-0' : '0';
  const [mant, expS] = v.toExponential(p - 1).split('e');
  const x = parseInt(expS, 10);
  const trim = (t: string) => t.includes('.') ? t.replace(/0+$/, '').replace(/\.$/, '') : t;
  if (x < -4 || x >= p) return trim(mant) + 'e' + (x < 0 ? '-' : '+') + String(Math.abs(x)).padStart(2, '0');
  return trim(v.toFixed(Math.max(0, p - 1 - x)));
}
const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;
const KEYWORDS = new Set('and break do else elseif end false for function if in local nil not or repeat return then true until while continue'.split(' '));
export function luaQuote(s: string, max = Infinity): string {
  let out = '"';
  const n = Math.min(s.length, max);
  for (let i = 0; i < n; i++) {
    const c = s.charCodeAt(i);
    if (c === 34) out += '\\"'; else if (c === 92) out += '\\\\';
    else if (c === 10) out += '\\n'; else if (c === 13) out += '\\r'; else if (c === 9) out += '\\t';
    else if (c < 32 || c === 127 || c > 255) out += '\\' + String(c & 255).padStart(3, '0');
    else if (c >= 128) out += '\\x' + c.toString(16).padStart(2, '0');
    else out += s[i];
  }
  out += '"';
  if (s.length > n) out += `…(${s.length} bytes)`;
  return out;
}

export interface LuauInsn {
  pc: number; opcode: number; op: string; raw: number; aux?: number;
  a: number; b: number; c: number; d: number; e: number;
  target: number; label?: number; line?: number;
  /** luau-compile compatible operand text, e.g. "LOADK R1 K0 ['x']" */
  asm: string;
  /** pseudo-Lua meaning of the instruction */
  lua: string;
}
export interface LuauDisasmOptions {
  /** 'rich' (default): pc, labels, constants, pseudo-Lua comments. 'luau': mimic `luau-compile --text` (no source lines). */
  style?: 'rich' | 'luau';
  hex?: boolean; lift?: boolean; constants?: boolean; debug?: boolean;
  /** only these proto ids */
  protos?: number[];
  maxInsns?: number;
}

export function fmtLuauConst(chunk: LuauChunk, p: LuauProto, k: number, style: 'rich' | 'luau' = 'rich'): string {
  const c = p.consts[k];
  if (!c) return `<K${k}?>`;
  switch (c.type) {
    case 'nil': return 'nil';
    case 'boolean': return String(c.value);
    case 'number': return (c.negNaN ? '-' : '') + (style === 'luau' ? fmtG(c.value) : (Object.is(c.value, -0) ? '-0' : Number.isNaN(c.value) ? '(0/0)' : c.value === Infinity ? 'math.huge' : c.value === -Infinity ? '-math.huge' : String(c.value)));
    case 'integer': return c.value.toString() + (style === 'rich' ? 'i' : '');
    case 'vector': {
      const v = c.value[3] === 0 ? c.value.slice(0, 3) : c.value;
      return style === 'luau' ? v.map(x => fmtG(x, 9)).join(', ') : `vector(${v.join(', ')})`;
    }
    case 'string': {
      if (style === 'rich') return luaQuote(c.value, 120);
      const s = c.value; let out = "'";
      for (let i = 0; i < s.length && i < 32; i++) { const ch = s.charCodeAt(i); out += ch < 32 ? '\\x' + ch.toString(16).toUpperCase().padStart(2, '0') : s[i]; }
      return out + (s.length >= 32 ? "'..." : "'");
    }
    case 'import': return c.path;
    case 'table': {
      if (style === 'luau') return '{...}';
      return '{' + c.keys.map((key, i) => {
        const kc = p.consts[key]; const kn = kc?.type === 'string' && IDENT.test(kc.value) && !KEYWORDS.has(kc.value) ? kc.value : '[' + fmtLuauConst(chunk, p, key, style) + ']';
        const v = c.values && c.values[i] >= 0 ? fmtLuauConst(chunk, p, c.values[i], style) : '_';
        return kn + ' = ' + v;
      }).join(', ') + '}';
    }
    case 'closure': {
      const name = chunk.protos[c.proto]?.debugName;
      return style === 'luau' ? (name ? `'${name}'` : '') : `function<P${c.proto}${name ? ' ' + name : ''}>`;
    }
    case 'class': {
      const nm = p.consts[c.name]; const n = nm?.type === 'string' ? nm.value : '?';
      return `class ${n} (public fields: ${c.fields.length}, public methods: ${c.methods.length}, private fields: ${c.privateFields}, private methods: ${c.privateMethods})`;
    }
  }
}

/** Decode every instruction of a proto with luau-style asm text and a pseudo-Lua reading. */
export function decodeLuauProto(chunk: LuauChunk, p: LuauProto, style: 'rich' | 'luau' = 'rich'): LuauInsn[] {
  const code = p.code;
  const labels = new Map<number, number>();
  const targets: number[] = [];
  for (let pc = 0; pc < code.length;) {
    const t = jumpTarget(code[pc], pc);
    if (t >= 0 && t < code.length) targets.push(t);
    pc += opLength(code[pc] & 255);
  }
  [...new Set(targets)].sort((x, y) => x - y).forEach((t, i) => labels.set(t, i));
  const K = (k: number) => fmtLuauConst(chunk, p, k, style);
  const KR = (k: number) => fmtLuauConst(chunk, p, k, 'rich');
  const local = (r: number, pc: number) => {
    if (p.locals) for (const l of p.locals) if (l.reg === r && l.startPc <= pc && pc < l.endPc) return l.name;
    return null;
  };
  const out: LuauInsn[] = [];
  for (let pc = 0; pc < code.length;) {
    const raw = code[pc] >>> 0, opcode = raw & 255, op = opName(opcode);
    const len = opLength(opcode);
    const aux = len === 2 ? code[pc + 1] >>> 0 : undefined;
    const A = insA(raw), B = insB(raw), C = insC(raw), D = insD(raw), E = insE(raw);
    const target = jumpTarget(raw, pc);
    const L = target >= 0 ? `L${labels.get(target) ?? '?'}` : 'L?';
    const R = (r: number) => local(r, pc) ?? `R${r}`;
    const U = (u: number) => p.upvalueNames?.[u] ?? `U${u}`;
    const field = (k: number) => { const c = p.consts[k]; return c?.type === 'string' && IDENT.test(c.value) && !KEYWORDS.has(c.value) ? '.' + c.value : '[' + KR(k) + ']'; };
    const range = (from: number, n: number) => n <= 0 ? '' : Array.from({ length: n }, (_, i) => R(from + i)).join(', ');
    const args = (from: number, nb: number) => nb === 0 ? `${R(from)}, ...` : range(from, nb - 1);
    const rets = (from: number, nc: number) => nc === 0 ? `${R(from)}, ... = ` : nc === 1 ? '' : range(from, nc - 1) + ' = ';
    let asm = op, lua = '';
    const ar = (sym: string) => { asm = `${op} R${A} R${B} R${C}`; lua = `${R(A)} = ${R(B)} ${sym} ${R(C)}`; };
    const ak = (sym: string) => { asm = `${op} R${A} R${B} K${C} [${K(C)}]`; lua = `${R(A)} = ${R(B)} ${sym} ${KR(C)}`; };
    const cmp = (sym: string, neg: boolean) => { asm = `${op} R${A} R${aux} ${L}`; lua = `if ${neg ? 'not (' : ''}${R(A)} ${sym} ${R(aux!)}${neg ? ')' : ''} then goto ${L}`; };
    const not = aux !== undefined && aux >>> 31 ? ' NOT' : '';
    switch (op) {
      case 'NOP': asm = 'NOP'; lua = '-- nop'; break;
      case 'BREAK': asm = 'BREAK'; lua = '-- debugger break'; break;
      case 'LOADNIL': asm = `LOADNIL R${A}`; lua = `${R(A)} = nil`; break;
      case 'LOADB': asm = C ? `LOADB R${A} ${B} +${C}` : `LOADB R${A} ${B}`; lua = `${R(A)} = ${B ? 'true' : 'false'}${C ? `; goto ${L}` : ''}`; break;
      case 'LOADN': asm = `LOADN R${A} ${D}`; lua = `${R(A)} = ${D}`; break;
      case 'LOADK': asm = `LOADK R${A} K${D} [${K(D)}]`; lua = `${R(A)} = ${KR(D)}`; break;
      case 'MOVE': asm = `MOVE R${A} R${B}`; lua = `${R(A)} = ${R(B)}`; break;
      case 'GETGLOBAL': asm = `GETGLOBAL R${A} K${aux} [${K(aux!)}]`; lua = `${R(A)} = ${globalName(p, aux!)}`; break;
      case 'SETGLOBAL': asm = `SETGLOBAL R${A} K${aux} [${K(aux!)}]`; lua = `${globalName(p, aux!)} = ${R(A)}`; break;
      case 'GETUPVAL': asm = `GETUPVAL R${A} U${B}`; lua = `${R(A)} = ${U(B)}`; break;
      case 'SETUPVAL': asm = `SETUPVAL R${A} U${B}`; lua = `${U(B)} = ${R(A)}`; break;
      case 'CLOSEUPVALS': asm = `CLOSEUPVALS R${A}`; lua = `-- close upvalues >= ${R(A)}`; break;
      case 'GETIMPORT': asm = `GETIMPORT R${A} ${D} [${K(D)}]`; lua = `${R(A)} = ${K(D) || 'import(' + aux + ')'}`; break;
      case 'GETTABLE': asm = `GETTABLE R${A} R${B} R${C}`; lua = `${R(A)} = ${R(B)}[${R(C)}]`; break;
      case 'SETTABLE': asm = `SETTABLE R${A} R${B} R${C}`; lua = `${R(B)}[${R(C)}] = ${R(A)}`; break;
      case 'GETTABLEKS': case 'GETUDATAKS': { const k = op === 'GETUDATAKS' ? aux! & 0xffff : aux!; asm = `${op} R${A} R${B} K${k} [${K(k)}]`; lua = `${R(A)} = ${R(B)}${field(k)}`; break; }
      case 'SETTABLEKS': case 'SETUDATAKS': { const k = op === 'SETUDATAKS' ? aux! & 0xffff : aux!; asm = `${op} R${A} R${B} K${k} [${K(k)}]`; lua = `${R(B)}${field(k)} = ${R(A)}`; break; }
      case 'GETTABLEN': asm = `GETTABLEN R${A} R${B} ${C + 1}`; lua = `${R(A)} = ${R(B)}[${C + 1}]`; break;
      case 'SETTABLEN': asm = `SETTABLEN R${A} R${B} ${C + 1}`; lua = `${R(B)}[${C + 1}] = ${R(A)}`; break;
      case 'NEWCLOSURE': { const id = p.children[D]; const nm = chunk.protos[id]?.debugName; asm = `NEWCLOSURE R${A} P${D}`; lua = `${R(A)} = function<P${id ?? '?'}${nm ? ' ' + nm : ''}>`; break; }
      case 'NAMECALL': case 'NAMECALLUDATA': { const k = op === 'NAMECALLUDATA' ? aux! & 0xffff : aux!; asm = `${op} R${A} R${B} K${k} [${K(k)}]`; lua = `${R(A + 1)} = ${R(B)}; ${R(A)} = ${R(B)}${field(k)}  -- ${R(B)}:${p.consts[k]?.type === 'string' ? (p.consts[k] as { value: string }).value : '?'}(...)`; break; }
      case 'CALL': asm = `CALL R${A} ${B - 1} ${C - 1}`; lua = `${rets(A, C)}${R(A)}(${args(A + 1, B)})`; break;
      case 'CALLFB': asm = `CALLFB R${A} ${B - 1} ${C - 1} [${aux! | 0}]`; lua = `${rets(A, C)}${R(A)}(${args(A + 1, B)})`; break;
      case 'RETURN': asm = `RETURN R${A} ${B - 1}`; lua = B === 0 ? `return ${R(A)}, ...` : `return ${range(A, B - 1)}`.trimEnd(); break;
      case 'JUMP': case 'JUMPBACK': case 'JUMPX': asm = `${op} ${L}`; lua = `goto ${L}`; break;
      case 'JUMPIF': asm = `JUMPIF R${A} ${L}`; lua = `if ${R(A)} then goto ${L}`; break;
      case 'JUMPIFNOT': asm = `JUMPIFNOT R${A} ${L}`; lua = `if not ${R(A)} then goto ${L}`; break;
      case 'JUMPIFEQ': cmp('==', false); break; case 'JUMPIFLE': cmp('<=', false); break; case 'JUMPIFLT': cmp('<', false); break;
      case 'JUMPIFNOTEQ': cmp('~=', false); break; case 'JUMPIFNOTLE': cmp('<=', true); break; case 'JUMPIFNOTLT': cmp('<', true); break;
      case 'ADD': ar('+'); break; case 'SUB': ar('-'); break; case 'MUL': ar('*'); break; case 'DIV': ar('/'); break;
      case 'IDIV': ar('//'); break; case 'MOD': ar('%'); break; case 'POW': ar('^'); break;
      case 'ADDK': ak('+'); break; case 'SUBK': ak('-'); break; case 'MULK': ak('*'); break; case 'DIVK': ak('/'); break;
      case 'IDIVK': ak('//'); break; case 'MODK': ak('%'); break; case 'POWK': ak('^'); break;
      case 'SUBRK': case 'DIVRK': asm = `${op} R${A} K${B} [${K(B)}] R${C}`; lua = `${R(A)} = ${KR(B)} ${op === 'SUBRK' ? '-' : '/'} ${R(C)}`; break;
      case 'AND': ar('and'); break; case 'OR': ar('or'); break;
      case 'ANDK': ak('and'); break; case 'ORK': ak('or'); break;
      case 'CONCAT': asm = `CONCAT R${A} R${B} R${C}`; lua = `${R(A)} = ${Array.from({ length: Math.max(1, C - B + 1) }, (_, i) => R(B + i)).join(' .. ')}`; break;
      case 'NOT': asm = `NOT R${A} R${B}`; lua = `${R(A)} = not ${R(B)}`; break;
      case 'MINUS': asm = `MINUS R${A} R${B}`; lua = `${R(A)} = -${R(B)}`; break;
      case 'LENGTH': asm = `LENGTH R${A} R${B}`; lua = `${R(A)} = #${R(B)}`; break;
      case 'NEWTABLE': asm = `NEWTABLE R${A} ${B === 0 ? 0 : 1 << (B - 1)} ${aux}`; lua = `${R(A)} = {}  -- hash ${B === 0 ? 0 : 1 << (B - 1)}, array ${aux}`; break;
      case 'DUPTABLE': asm = `DUPTABLE R${A} ${D}`; lua = `${R(A)} = ${KR(D)}`; break;
      case 'SETLIST': asm = `SETLIST R${A} R${B} ${C - 1} [${aux}]`; lua = C === 0 ? `${R(A)}[${aux}...] = ${R(B)}, ...` : `${R(A)}[${aux}..${aux! + C - 2}] = ${range(B, C - 1)}`; break;
      case 'FORNPREP': asm = `FORNPREP R${A} ${L}`; lua = `for ${R(A + 2)} = ${R(A + 2)}, ${R(A)}, ${R(A + 1)} do  -- exit: ${L}`; break;
      case 'FORNLOOP': asm = `FORNLOOP R${A} ${L}`; lua = `${R(A + 2)} += ${R(A + 1)}; if ${R(A + 2)} <= ${R(A)} then goto ${L}`; break;
      case 'FORGPREP': case 'FORGPREP_NEXT': case 'FORGPREP_INEXT': asm = `${op} R${A} ${L}`; lua = `for ... in ${R(A)}, ${R(A + 1)}, ${R(A + 2)} do  -- ${op === 'FORGPREP_NEXT' ? 'pairs/next' : op === 'FORGPREP_INEXT' ? 'ipairs' : 'generic'}; goto ${L}`; break;
      case 'FORGLOOP': { const n = aux! & 255; asm = `FORGLOOP R${A} ${L} ${n}${(aux! | 0) < 0 ? ' [inext]' : ''}`; lua = `${range(A + 3, n)} = ${R(A)}(${R(A + 1)}, ${R(A + 2)}); if ${R(A + 3)} ~= nil then goto ${L}`; break; }
      case 'GETVARARGS': asm = `GETVARARGS R${A} ${B - 1}`; lua = B === 0 ? `${R(A)}, ... = ...` : `${range(A, B - 1)} = ...`; break;
      case 'DUPCLOSURE': asm = `DUPCLOSURE R${A} K${D} [${K(D)}]`; lua = `${R(A)} = ${KR(D)}`; break;
      case 'PREPVARARGS': asm = `PREPVARARGS ${A}`; lua = `-- vararg function, ${A} fixed params`; break;
      case 'LOADKX': asm = `LOADKX R${A} K${aux} [${K(aux!)}]`; lua = `${R(A)} = ${KR(aux!)}`; break;
      case 'FASTCALL': asm = `FASTCALL ${A} ${L}`; lua = `-- fastcall ${LUAU_BUILTINS[A] ?? A}(...) → ${L}`; break;
      case 'FASTCALL1': asm = `FASTCALL1 ${A} R${B} ${L}`; lua = `-- fastcall ${LUAU_BUILTINS[A] ?? A}(${R(B)}) → ${L}`; break;
      case 'FASTCALL2': asm = `FASTCALL2 ${A} R${B} R${aux} ${L}`; lua = `-- fastcall ${LUAU_BUILTINS[A] ?? A}(${R(B)}, ${R(aux!)}) → ${L}`; break;
      case 'FASTCALL2K': asm = `FASTCALL2K ${A} R${B} K${aux} ${L} [${K(aux!)}]`; lua = `-- fastcall ${LUAU_BUILTINS[A] ?? A}(${R(B)}, ${KR(aux!)}) → ${L}`; break;
      case 'FASTCALL3': asm = `FASTCALL3 ${A} R${B} R${aux! & 255} R${(aux! >> 8) & 255} ${L}`; lua = `-- fastcall ${LUAU_BUILTINS[A] ?? A}(${R(B)}, ${R(aux! & 255)}, ${R((aux! >> 8) & 255)}) → ${L}`; break;
      case 'FASTPCALL': asm = `FASTPCALL ${A === 0 ? 'pcall' : 'xpcall'} ${L}`; lua = `-- fast ${A === 0 ? 'pcall' : 'xpcall'} (${B} args) → ${L}`; break;
      case 'COVERAGE': asm = 'COVERAGE'; lua = '-- coverage'; break;
      case 'CAPTURE': { const t = A === 0 ? 'VAL' : A === 1 ? 'REF' : A === 2 ? 'UPVAL' : ''; asm = `CAPTURE ${t} ${A === 2 ? 'U' : 'R'}${B}`; lua = `-- capture ${t.toLowerCase()} ${A === 2 ? U(B) : R(B)}`; break; }
      case 'JUMPXEQKNIL': asm = `JUMPXEQKNIL R${A} ${L}${not}`; lua = `if ${R(A)} ${not ? '~=' : '=='} nil then goto ${L}`; break;
      case 'JUMPXEQKB': asm = `JUMPXEQKB R${A} ${aux! & 1} ${L}${not}`; lua = `if ${R(A)} ${not ? '~=' : '=='} ${aux! & 1 ? 'true' : 'false'} then goto ${L}`; break;
      case 'JUMPXEQKN': case 'JUMPXEQKS': { const k = aux! & 0xffffff; asm = `${op} R${A} K${k} ${L}${not} [${K(k)}]`; lua = `if ${R(A)} ${not ? '~=' : '=='} ${KR(k)} then goto ${L}`; break; }
      case 'CMPPROTO': asm = `CMPPROTO R${A} #${aux} ${L}`; lua = `if not (${R(A)} is closure of P${aux}) then goto ${L}`; break;
      case 'NEWCLASSMEMBER': asm = B === 1 ? `NEWCLASSMEMBER R${A} R${C} ${aux! & 255} [private]` : `NEWCLASSMEMBER R${A} R${C} [public] [${K(aux!)}]`; lua = `-- class ${R(A)} member = ${R(C)}`; break;
      case 'NEWCLASS': asm = `NEWCLASS R${A} ${B === 255 ? 'no_base' : 'R' + B} K${aux} ${C} [${K(aux!)}]`; lua = `${R(A)} = class ${KR(aux!)}`; break;
      case 'CONSTRUCT': asm = `CONSTRUCT R${A} R${B} slot ${aux}`; lua = `${R(A)} = new ${R(B)}`; break;
      case 'FINCONSTRUCT': asm = `FINCONSTRUCT R${A} ${L}`; lua = `-- finish construct ${R(A)}`; break;
      case 'GETPRIVATEFIELD': asm = `GETPRIVATEFIELD R${A} R${B} U${C} ${aux! & 255}`; lua = `${R(A)} = ${R(B)}.<private ${aux! & 255}>`; break;
      case 'SETPRIVATEFIELD': asm = `SETPRIVATEFIELD R${A} R${B} U${C} ${aux! & 255}`; lua = `${R(B)}.<private ${aux! & 255}> = ${R(A)}`; break;
      default: asm = `${op} A=${A} B=${B} C=${C} D=${D}`; lua = `-- unknown opcode ${opcode}`;
    }
    out.push({ pc, opcode, op, raw, aux, a: A, b: B, c: C, d: D, e: E, target, label: labels.get(pc), line: p.lineInfo?.[pc], asm, lua });
    pc += len;
  }
  return out;
}
function globalName(p: LuauProto, k: number) {
  const c = p.consts[k];
  return c?.type === 'string' ? (IDENT.test(c.value) && !KEYWORDS.has(c.value) ? c.value : `_ENV[${luaQuote(c.value)}]`) : `_ENV[K${k}]`;
}

const hex8 = (n: number) => (n >>> 0).toString(16).padStart(8, '0');
export function protoTitle(chunk: LuauChunk, p: LuauProto) {
  return p.id === chunk.main ? 'main' : p.debugName || `anon_${p.id}`;
}
/** Text disassembly of a whole chunk. */
export function disassembleLuau(chunk: LuauChunk, opts: LuauDisasmOptions = {}): string {
  const style = opts.style ?? 'rich';
  const lift = opts.lift ?? true, showK = opts.constants ?? true, dbg = opts.debug ?? true;
  const lines: string[] = [];
  const only = opts.protos ? new Set(opts.protos) : null;
  let budget = opts.maxInsns ?? Infinity;
  if (style === 'rich') {
    lines.push(`; PRISM Luau disassembly — bytecode v${chunk.version}${chunk.typesVersion ? `, types v${chunk.typesVersion}` : ''}, ${chunk.encoding} opcodes`);
    lines.push(`; ${chunk.protos.length} functions, ${chunk.strings.length} strings, main = P${chunk.main}${chunk.userdataTypes?.length ? `, userdata types: ${chunk.userdataTypes.join(', ')}` : ''}`);
    for (const w of chunk.warnings) lines.push('; warning: ' + w);
    lines.push('');
  }
  for (const p of chunk.protos) {
    if (only && !only.has(p.id)) continue;
    const insns = decodeLuauProto(chunk, p, style);
    if (style === 'luau') {
      lines.push(`Function ${p.id} (${p.debugName ?? '??'}):`);
      for (const i of insns) {
        if (i.op === 'PREPVARARGS') continue;
        lines.push((i.label !== undefined ? `L${i.label}: ` : '') + i.asm);
      }
      lines.push('');
      continue;
    }
    const flags: string[] = [];
    if (p.flags & 1) flags.push('native-module'); if (p.flags & 2) flags.push('native-cold'); if (p.flags & 4) flags.push('native');
    if (p.flags & 8) flags.push('inlinable'); if (p.flags & 16) flags.push('uses-export');
    lines.push(`; ${'─'.repeat(70)}`);
    lines.push(`function P${p.id} ${protoTitle(chunk, p)}(${[...Array.from({ length: p.numParams }, (_, i) => p.locals?.find(l => l.reg === i && l.startPc === 0)?.name ?? 'a' + i), ...(p.isVararg ? ['...'] : [])].join(', ')})`);
    lines.push(`; line ${p.lineDefined}, params ${p.numParams}${p.isVararg ? ' + vararg' : ''}, upvalues ${p.numUpvalues}, maxstack ${p.maxStack}, ${insns.length} instructions (${p.code.length} words), ${p.consts.length} constants${p.children.length ? `, children: ${p.children.map(c => 'P' + c).join(' ')}` : ''}${flags.length ? ', flags: ' + flags.join(' ') : ''}`);
    if (dbg && p.upvalueNames?.length) lines.push(`; upvalues: ${p.upvalueNames.map((n, i) => `U${i}=${n}`).join(' ')}`);
    if (showK && p.consts.length) {
      lines.push('; constants:');
      p.consts.forEach((_, k) => lines.push(`;   K${k} ${p.consts[k].type.padEnd(7)} ${fmtLuauConst(chunk, p, k, 'rich')}`));
    }
    if (dbg && p.locals?.length) lines.push('; locals: ' + p.locals.map(l => `${l.name}=R${l.reg}@${l.startPc}-${l.endPc}`).join(' '));
    let lastLine = -1;
    for (const i of insns) {
      if (budget-- <= 0) { lines.push('; … truncated (maxInsns)'); break; }
      if (i.label !== undefined) lines.push(`L${i.label}:`);
      let s = '  ' + String(i.pc).padStart(4, '0');
      if (opts.hex) s += '  ' + hex8(i.raw) + (i.aux !== undefined ? ' ' + hex8(i.aux) : '         ');
      s += '  ' + i.asm;
      if (lift && i.lua) s = s.padEnd(opts.hex ? 74 : 56) + ' ; ' + i.lua;
      if (i.line !== undefined && i.line !== lastLine) { s += (lift ? '  ' : ' ; ') + `@${i.line}`; lastLine = i.line; }
      lines.push(s);
    }
    lines.push('');
  }
  return lines.join('\n');
}

export interface LuauSummary {
  version: number; typesVersion: number; encoding: string; main: number; strings: number; warnings: string[];
  protos: Array<{ id: number; name: string; line: number; params: number; vararg: boolean; upvalues: number; instructions: number; constants: number; children: number[] }>;
  opcodeHistogram: Record<string, number>;
  imports: string[]; stringConstants: string[];
}
export function summarizeLuau(chunk: LuauChunk): LuauSummary {
  const hist: Record<string, number> = {};
  const imports = new Set<string>(); const strs = new Set<string>();
  const protos = chunk.protos.map(p => {
    let n = 0;
    for (let pc = 0; pc < p.code.length;) { const op = p.code[pc] & 255; hist[opName(op)] = (hist[opName(op)] ?? 0) + 1; n++; pc += opLength(op); }
    for (const k of p.consts) { if (k.type === 'import') imports.add(k.path); if (k.type === 'string') strs.add(k.value); }
    return { id: p.id, name: protoTitle(chunk, p), line: p.lineDefined, params: p.numParams, vararg: p.isVararg, upvalues: p.numUpvalues, instructions: n, constants: p.consts.length, children: p.children };
  });
  return { version: chunk.version, typesVersion: chunk.typesVersion, encoding: chunk.encoding, main: chunk.main, strings: chunk.strings.length, warnings: chunk.warnings, protos, opcodeHistogram: hist, imports: [...imports], stringConstants: [...strs] };
}
