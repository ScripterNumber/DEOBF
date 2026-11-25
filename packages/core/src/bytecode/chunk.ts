// Chunk explorer — auto-infers the layout of a decoded VM chunk and disassembles every proto with an editable opcode map.
// Input: any JSON (e.g. the lua_dump() output of a Python-ported deserializer) or a Lua table literal.
// Layouts recognised generically (nothing obfuscator-specific):
//   • proto records holding an instruction array (tuples {op,A,B,C} / records {op=…} / packed 32-bit words),
//     struct-of-arrays protos (parallel opcode/operand integer arrays), a constant array, nested protos of the same shape;
//   • lists are addressed with Lua keys (first element = "1"), dicts keep their keys — the same keys the Opcode Map roles use.
import { vmDisassemble, type OpMap } from './customvm.js';

type J = unknown;
type Obj = Record<string, J>;
const isBytes = (v: J): v is { $bytes: string } => !!v && typeof v === 'object' && !Array.isArray(v) && typeof (v as Obj).$bytes === 'string' && Object.keys(v as Obj).length === 1;
const hexLatin1 = (h: string) => { let s = ''; for (let i = 0; i + 1 < h.length; i += 2) s += String.fromCharCode(parseInt(h.slice(i, i + 2), 16)); return s; };
/** {"$bytes": hex} (lua_dump's encoding of non-text strings) → latin1 string */
export const unbytes = (v: J): J => isBytes(v) ? hexLatin1(v.$bytes) : v;
const isScalar = (v: J) => v === null || typeof v !== 'object' || isBytes(v);
const isCont = (v: J): v is Obj | J[] => !!v && typeof v === 'object' && !isBytes(v);
const isInt = (v: J) => typeof v === 'number' && Number.isInteger(v);
/** entries with Lua keys: list index i → "i+1" */
function ents(v: J): Array<[string, J]> { if (Array.isArray(v)) return v.map((x, i) => [String(i + 1), x]); if (isCont(v)) return Object.entries(v as Obj); return []; }
const sizeOf = (v: J) => Array.isArray(v) ? v.length : isCont(v) ? Object.keys(v).length : 0;
/** ordered elements of an array-like container (list, or dict with integer keys — holes become null) */
function elems(v: J): { items: J[]; base: number } | null {
  if (Array.isArray(v)) return { items: v, base: 1 };
  if (!isCont(v)) return null;
  const ks = Object.keys(v);
  if (!ks.length) return { items: [], base: 1 };
  if (!ks.every(k => /^-?\d+$/.test(k))) return null;
  const nums = ks.map(Number).sort((a, b) => a - b);
  const base = nums[0], span = nums[nums.length - 1] - base + 1;
  if (span > nums.length * 2 + 8) return null;
  const items: J[] = new Array(span).fill(null);
  for (const n of nums) items[n - base] = (v as Obj)[String(n)];
  return { items, base };
}

export interface ChunkLayout {
  kind: 'tuple' | 'soa' | 'packed';
  /** key of the instruction array inside a proto (tuple/packed) or the parallel arrays (soa) */
  instr: string | string[];
  protos?: string;
  consts?: string;
  opField: string;
  fields: Record<string, string>;
  bits?: Array<{ name: string; shift: number; width: number }>;
}
export interface ChunkProto { id: string; depth: number; instructions: number; children: number; consts: number; scalars: Record<string, J>; other: Record<string, string>; }
export interface ChunkDisasmOptions {
  opField?: string | number;
  fields?: Record<string, string>;
  /** packed words: "op:0:8 A:8:8 B:16:8 C:24:8" or preset "luau" | "lua51" */
  bits?: string;
  /** JSON path (dot or / separated keys, Lua keys for lists) to the root proto when auto-detection picks the wrong node */
  select?: string;
  /** instructions shown per proto (default 4000) */
  max?: number;
  /** only this proto id (e.g. "F.2.0") */
  proto?: string;
  maxProtos?: number;
  pcBase?: number;
}
export interface ChunkDisasmResult {
  text: string;
  layout: ChunkLayout;
  rootPath: string[];
  protos: ChunkProto[];
  totalInstructions: number;
  histogram: Array<{ op: string; name: string; count: number }>;
  unknown: string[];
  strings: Array<{ value: string; count: number; first: string }>;
  notes: string[];
}

const PRESETS: Record<string, string> = { luau: 'op:0:8 A:8:8 B:16:8 C:24:8 D:16:16', lua51: 'op:0:6 A:6:8 C:14:9 B:23:9 Bx:14:18' };
function parseBits(s: string) {
  const spec = PRESETS[s.trim().toLowerCase()] ?? s;
  const out = spec.split(/[\s,;]+/).filter(Boolean).map(p => { const [name, sh, w] = p.split(':'); return { name, shift: Number(sh), width: Number(w) }; });
  if (!out.length || out.some(b => !b.name || !Number.isFinite(b.shift) || !Number.isFinite(b.width) || b.width < 1 || b.width > 32)) throw new Error(`bad bits spec "${s}" — use e.g. "op:0:8 A:8:8 B:16:8 C:24:8" or a preset (luau, lua51)`);
  return out;
}

/** score a container as an instruction array; returns op-field candidates (keys that are integers in ~every instruction) */
function insnArray(v: J): { n: number; kind: 'tuple' | 'packed'; cands: string[]; keys: string[]; score: number } | null {
  const e = elems(v);
  if (!e || !e.items.length) return null;
  const items = e.items.filter(x => x !== null);
  if (!items.length) return null;
  if (items.every(isInt)) {
    if (items.length < 4 || !items.some(x => (x as number) > 0xffff)) return null; // a plain int list (line info, sizes…) is not code
    return { n: items.length, kind: 'packed', cands: ['op'], keys: [], score: items.length * 0.6 };
  }
  const sample = items.length > 3000 ? items.filter((_, i) => i % Math.ceil(items.length / 3000) === 0) : items;
  let recs = 0, scal = 0, tot = 0;
  const keyN = new Map<string, number>(), intN = new Map<string, number>();
  for (const r of sample) {
    if (!isCont(r)) continue;
    const es = ents(r);
    if (es.length > 24) return null;
    recs++;
    for (const [k, x] of es) { tot++; if (isScalar(x)) scal++; keyN.set(k, (keyN.get(k) ?? 0) + 1); if (isInt(x)) intN.set(k, (intN.get(k) ?? 0) + 1); }
  }
  if (recs < sample.length * 0.9 || !tot || scal < tot * 0.85) return null;
  const order = (a: string, b: string) => (/^\d+$/.test(a) && /^\d+$/.test(b) ? +a - +b : a.localeCompare(b));
  const keys = [...keyN.keys()].sort(order);
  const cands = keys.filter(k => (intN.get(k) ?? 0) >= recs * 0.97);
  if (!cands.length) return null;
  const named = cands.find(k => /^(op|opcode|OP|Op|Opcode|code)$/.test(k));
  if (named) cands.unshift(...cands.splice(cands.indexOf(named), 1));
  return { n: items.length, kind: 'tuple', cands, keys, score: items.length * (scal / tot) + (named ? 50 : 0) };
}

interface ProtoShape { instr: string | string[]; kind: 'tuple' | 'soa' | 'packed'; n: number; cands: string[]; keys: string[] }
/** does this container look like a proto (holds an instruction array or parallel int arrays)? */
function protoShape(v: J, prefer?: string | string[]): ProtoShape | null {
  if (!isCont(v)) return null;
  const es = ents(v);
  if (prefer && typeof prefer === 'string') { const x = es.find(([k]) => k === prefer); if (x) { const ia = insnArray(x[1]); if (ia) return { instr: prefer, kind: ia.kind, n: ia.n, cands: ia.cands, keys: ia.keys }; if (sizeOf(x[1]) === 0) return { instr: prefer, kind: 'tuple', n: 0, cands: [], keys: [] }; } }
  let best: ProtoShape & { score: number } | null = null;
  for (const [k, x] of es) { const ia = insnArray(x); if (ia && (!best || ia.score > best.score)) best = { instr: k, kind: ia.kind, n: ia.n, cands: ia.cands, keys: ia.keys, score: ia.score }; }
  if (best) return best;
  // struct of arrays: ≥ 2 integer arrays of the same length
  const intArrays = es.filter(([, x]) => { const e = elems(x); return !!e && e.items.length >= 3 && e.items.every(y => y === null || isInt(y)); });
  const byLen = new Map<number, string[]>();
  for (const [k, x] of intArrays) { const n = elems(x)!.items.length; byLen.set(n, [...(byLen.get(n) ?? []), k]); }
  const grp = [...byLen.entries()].filter(([, ks]) => ks.length >= 2).sort((a, b) => b[1].length - a[1].length || b[0] - a[0])[0];
  if (grp) return { instr: grp[1], kind: 'soa', n: grp[0], cands: grp[1], keys: grp[1] };
  return null;
}

function getPath(root: J, path: string[]): J {
  let cur = root;
  for (const k of path) { const e = ents(cur).find(([kk]) => kk === k); if (!e) throw new Error(`select: key "${k}" not found (available: ${ents(cur).slice(0, 20).map(x => x[0]).join(', ')})`); cur = e[1]; }
  return cur;
}

/** infer the chunk layout and disassemble every proto */
export function chunkDisassemble(json: J, opmap: OpMap = {}, opts: ChunkDisasmOptions = {}): ChunkDisasmResult {
  const notes: string[] = [];
  // ---- locate the root proto (shallowest container holding code; the root itself may be a bare instruction array)
  let rootPath: string[] = [];
  let root: J = json, shape: ProtoShape | null = null;
  if (opts.select) { rootPath = opts.select.split(/[./]/).filter(Boolean); root = getPath(json, rootPath); }
  const bare = insnArray(root);
  if (bare && !opts.select) { root = { '1': root }; shape = { instr: '1', kind: bare.kind, n: bare.n, cands: bare.cands, keys: bare.keys }; notes.push('input is a bare instruction array (one proto)'); }
  else {
    const queue: Array<{ v: J; path: string[]; d: number }> = [{ v: root, path: rootPath, d: 0 }];
    let found: { v: J; path: string[]; s: ProtoShape; d: number } | null = null;
    while (queue.length) {
      const q = queue.shift()!;
      const s = protoShape(q.v);
      if (s && s.n > 0) { if (!found || (q.d === found.d && s.n > found.s.n)) found = { ...q, s }; if (found.d < q.d) break; }
      if (q.d < 5 && !found) for (const [k, x] of ents(q.v)) if (isCont(x) && sizeOf(x) > 0) queue.push({ v: x, path: [...q.path, k], d: q.d + 1 });
      if (queue.length > 20000) break;
    }
    if (!found) throw new Error('no instruction array found — expected a list of instruction tuples/records ({op, A, B, C}), packed integer words, or parallel opcode/operand arrays. Use select to point at the proto');
    root = found.v; rootPath = found.path; shape = found.s;
  }
  // ---- layout: op field + operand letters
  const sh = shape!;
  let opField = opts.opField !== undefined ? String(opts.opField) : '';
  const mapKeys = new Set(Object.keys(opmap).filter(k => k !== '$meta'));
  const instrRecords = (p: J, s: ProtoShape): Obj[] => {
    if (s.kind === 'soa') {
      const arrs = (s.instr as string[]).map(k => [k, elems(ents(p).find(([kk]) => kk === k)?.[1])?.items ?? []] as const);
      const n = Math.max(0, ...arrs.map(([, a]) => a.length));
      return Array.from({ length: n }, (_, i) => Object.fromEntries(arrs.map(([k, a]) => [k, a[i] ?? null])));
    }
    const arr = elems(ents(p).find(([kk]) => kk === s.instr)?.[1])?.items ?? [];
    if (s.kind === 'packed') return arr.map(w => { const o: Obj = { word: w }; if (isInt(w)) for (const b of bits!) o[b.name] = Math.floor(Number(w) / 2 ** b.shift) % 2 ** b.width; return o; });
    return arr.map(r => Object.fromEntries(ents(r).map(([k, x]) => [k, unbytes(x)])));
  };
  let bits: ChunkLayout['bits'];
  if (sh.kind === 'packed') {
    bits = parseBits(opts.bits ?? 'luau');
    if (!opts.bits) notes.push('packed instruction words decoded with the Luau-style layout op:0:8 A:8:8 B:16:8 C:24:8 D:16:16 — pass bits (e.g. "lua51" or "op:0:6 A:6:8 …") if the handlers extract fields differently');
    opField = opField || (bits.find(b => /^op/i.test(b.name))?.name ?? bits[0].name);
  }
  if (!opField) {
    const sample = instrRecords(root, sh).slice(0, 3000);
    if (mapKeys.size && sh.cands.length > 1) {
      // the opcode field is the one whose values the opcode map knows best
      const hit = (k: string) => sample.reduce((n, r) => n + (mapKeys.has(String(r[k])) ? 1 : 0), 0);
      opField = [...sh.cands].sort((a, b) => hit(b) - hit(a))[0];
    } else opField = sh.cands[0] ?? '1';
  }
  let fields = opts.fields;
  if (!fields) {
    fields = {};
    const letters = 'ABCDEFGHIJKLMN';
    let li = 0;
    const ks = sh.kind === 'packed' ? bits!.map(b => b.name) : sh.keys;
    for (const k of ks) if (k !== opField) fields[k] = sh.kind === 'packed' || /^[A-Za-z]{1,3}$/.test(k) ? k : letters[li++] ?? k;
  }
  // ---- nested protos + constants keys (decided on the root, reused for every proto)
  const rootEnts = ents(root);
  const instrKeys = new Set(Array.isArray(sh.instr) ? sh.instr : [sh.instr]);
  let protosKey: string | undefined, constsKey: string | undefined;
  let bestP = 0, bestC = -1;
  for (const [k, x] of rootEnts) {
    if (instrKeys.has(k) || !isCont(x)) continue;
    const items = elems(x)?.items ?? ents(x).map(e => e[1]);
    const protoLike = items.filter(it => protoShape(it, sh.kind === 'soa' ? undefined : (sh.instr as string)) !== null).length;
    if (protoLike > 0 && protoLike >= items.length * 0.5 && protoLike > bestP) { bestP = protoLike; protosKey = k; continue; }
    const e = elems(x);
    if (e && e.items.length && e.items.every(isScalar)) {
      const strs = e.items.filter(y => typeof y === 'string' || isBytes(y)).length, nonInt = e.items.filter(y => y !== null && !isInt(y)).length;
      const sc = strs * 3 + nonInt + e.items.length * 0.01;
      if (nonInt > 0 && sc > bestC) { bestC = sc; constsKey = k; }
    }
  }
  // sub-protos without children store an empty table under the protos key: find it via a second proto if the root had none
  const layout: ChunkLayout = { kind: sh.kind, instr: sh.instr, protos: protosKey, consts: constsKey, opField, fields, bits };

  // ---- walk all protos
  const protos: ChunkProto[] = [];
  const out: string[] = [];
  const hist = new Map<string, number>(), unknown = new Set<string>();
  const strings = new Map<string, { count: number; first: string }>();
  const max = opts.max ?? 4000, maxProtos = opts.maxProtos ?? 5000;
  let total = 0;
  const addStr = (v: J, where: string) => { if (typeof v === 'string' && v.length) { const s = strings.get(v); if (s) s.count++; else strings.set(v, { count: 1, first: where }); } };
  const visit = (p: J, id: string, depth: number) => {
    if (protos.length >= maxProtos) return;
    const s = protoShape(p, sh.kind === 'soa' ? undefined : (sh.instr as string)) ?? { ...sh, n: 0 };
    const recs = s.n ? instrRecords(p, s.kind === sh.kind ? s : sh) : [];
    const pe = ents(p);
    const cv = constsKey ? pe.find(([k]) => k === constsKey)?.[1] : undefined;
    const ce = cv !== undefined ? elems(cv) : null;
    const consts = ce ? ce.items.map(unbytes) : [];
    const kids = protosKey ? pe.find(([k]) => k === protosKey)?.[1] : undefined;
    const kidEnts = kids !== undefined ? ents(kids) : [];
    const scalars: Record<string, J> = {}, other: Record<string, string> = {};
    for (const [k, x] of pe) {
      if (instrKeys.has(k) || k === protosKey || k === constsKey) continue;
      if (isScalar(x)) scalars[k] = unbytes(x); else other[k] = `${Array.isArray(x) ? 'list' : 'dict'}[${sizeOf(x)}]`;
    }
    protos.push({ id, depth, instructions: recs.length, children: kidEnts.length, consts: consts.length, scalars, other });
    total += recs.length;
    for (const r of recs) for (const v of Object.values(r)) addStr(v, id);
    for (const c of consts) addStr(c, id + ' K');
    if (!opts.proto || opts.proto === id) {
      const meta = [`${recs.length} instructions`, kidEnts.length ? `${kidEnts.length} child protos` : '', consts.length ? `${consts.length} constants` : '',
        Object.keys(scalars).length ? 'fields ' + Object.entries(scalars).map(([k, v]) => `[${k}]=${JSON.stringify(v)}`).join(' ') : '',
        Object.keys(other).length ? Object.entries(other).map(([k, v]) => `[${k}]=${v}`).join(' ') : ''].filter(Boolean).join(' · ');
      out.push('', `; ======== proto ${id}${depth ? '' : ' (main)'} — ${meta}`);
      if (consts.length) out.push('; constants: ' + consts.slice(0, 40).map((c, i) => `K${i + (ce?.base ?? 1)}=${typeof c === 'string' ? JSON.stringify(c.length > 40 ? c.slice(0, 40) + '…' : c) : String(c)}`).join(' ') + (consts.length > 40 ? ` … (+${consts.length - 40})` : ''));
      if (recs.length) {
        const r = vmDisassemble(recs, opmap, { opField, fields, constants: consts.length ? consts : undefined, kBase: ce?.base ?? 1, pcBase: opts.pcBase ?? 1, max });
        out.push(...r.text.split('\n').filter(l => !l.startsWith('; PRISM custom-VM listing') && !l.startsWith('; unmapped opcodes')).filter((l, i) => !(i === 0 && !l)));
      }
    }
    for (const r of recs) { const op = String(r[opField]); hist.set(op, (hist.get(op) ?? 0) + 1); if (!mapKeys.has(op)) unknown.add(op); }
    for (const [k, c] of kidEnts) if (isCont(c)) visit(c, `${id}.${k}`, depth + 1);
  };
  visit(root, 'F', 0);
  if (protos.length >= maxProtos) notes.push(`stopped after ${maxProtos} protos`);
  const histogram = [...hist].sort((a, b) => b[1] - a[1]).map(([op, count]) => { const e = opmap[op]; return { op, name: e === undefined ? `OP_${op}` : typeof e === 'string' ? e : e.name, count }; });
  const strs = [...strings].sort((a, b) => b[1].count - a[1].count).map(([value, s]) => ({ value, ...s }));
  const lay = `${sh.kind === 'soa' ? 'parallel arrays ' + (sh.instr as string[]).map(k => `[${k}]`).join(',') : sh.kind === 'packed' ? `packed words [${sh.instr}] (${bits!.map(b => `${b.name}:${b.shift}:${b.width}`).join(' ')})` : `instructions [${sh.instr}]`}` +
    `${protosKey ? `, nested protos [${protosKey}]` : ''}${constsKey ? `, constants [${constsKey}]` : ', constants inline (no constant array)'}`;
  const head = [
    `; PRISM chunk disassembly — root ${rootPath.length ? rootPath.map(k => `[${k}]`).join('') : '(top level)'} · ${protos.length} protos · ${total.toLocaleString('en-US')} instructions`,
    `; layout: ${lay}`,
    `; opcode field [${opField}] · operands ${Object.entries(fields).map(([k, l]) => `[${k}]→${l}`).join(' ') || '(none)'} · opcode map ${mapKeys.size ? mapKeys.size + ' entries' : 'empty (OP_n names) — build one in Opcode Map'}`,
  ];
  if (unknown.size && mapKeys.size) head.push(`; unmapped opcodes (${unknown.size}): ${[...unknown].sort((a, b) => +a - +b).slice(0, 80).join(' ')}`);
  for (const n of notes) head.push('; note: ' + n);
  return { text: head.join('\n') + '\n' + out.join('\n') + '\n', layout, rootPath, protos, totalInstructions: total, histogram, unknown: [...unknown], strings: strs, notes };
}
