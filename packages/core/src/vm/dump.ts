// Reader for runtime/table dumps (JSON) — the format written by PRISM's Python-port dump hooks:
//   table   {"$id": n, "$arr": [v1, v2, …], "$map": {"key": v, …}, "$meta": t}
//   ref     {"$ref": n}          function {"$fn": "string.byte"}
//   bytes   {"$bytes": "hex"}    buffer   {"$buffer": "hex"}
//   number  {"$num": "inf" | "-inf" | "nan"}   function with its Lua source offset {"$fn": "_fn12", "$at": 1234}
// Plain JSON (lists = 1-based Lua arrays, objects = maps) is accepted as well.
import type * as A from '../ast.js';

export type DumpVal = unknown;
type Obj = Record<string, any>;
const isObj = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v);
const hexLatin1 = (h: string) => { let s = ''; for (let i = 0; i + 1 < h.length; i += 2) s += String.fromCharCode(parseInt(h.slice(i, i + 2), 16)); return s; };
const utf8Latin1 = (s: string) => { if (/^[\x00-\x7f]*$/.test(s)) return s; return Array.from(new TextEncoder().encode(s), b => String.fromCharCode(b)).join(''); };
const NUMKEY = /^-?(\d+(\.\d+)?|\.\d+)(e[+-]?\d+)?$/i;

export type Scalar =
  | { kind: 'nil' } | { kind: 'bool'; value: boolean } | { kind: 'num'; value: number } | { kind: 'str'; value: string }
  | { kind: 'fn'; name: string } | { kind: 'buffer'; hex: string } | { kind: 'table'; id: string };

export class LuaDump {
  readonly ids = new Map<number, Obj>();
  private synth = new WeakMap<object, string>();
  private nextSynth = 1;
  constructor(readonly root: unknown) { this.index(root, 0); }
  private index(x: unknown, depth: number) {
    if (depth > 4000) return;
    if (Array.isArray(x)) { for (const v of x) this.index(v, depth + 1); return; }
    if (!isObj(x)) return;
    if (typeof x.$id === 'number') this.ids.set(x.$id, x);
    for (const [k, v] of Object.entries(x)) {
      if (k === '$ref' || k === '$fn' || k === '$bytes' || k === '$buffer' || k === '$id') continue;
      this.index(v, depth + 1);
    }
  }
  deref(v: unknown): unknown { return isObj(v) && typeof v.$ref === 'number' ? this.ids.get(v.$ref) : v; }
  isTable(v: unknown): boolean {
    const d = this.deref(v);
    if (Array.isArray(d)) return true;
    return isObj(d) && d.$fn === undefined && d.$bytes === undefined && d.$buffer === undefined && d.$num === undefined;
  }
  /** stable identity of a table value */
  tableId(v: unknown): string {
    const d = this.deref(v) as any;
    if (isObj(d) && typeof d.$id === 'number') return String(d.$id);
    let s = this.synth.get(d); if (!s) { s = 's' + this.nextSynth++; this.synth.set(d, s); } return s;
  }
  scalar(v: unknown): Scalar {
    const d = this.deref(v);
    if (d === null || d === undefined) return { kind: 'nil' };
    if (typeof d === 'boolean') return { kind: 'bool', value: d };
    if (typeof d === 'number') return { kind: 'num', value: d };
    if (typeof d === 'string') return { kind: 'str', value: utf8Latin1(d) };
    if (isObj(d)) {
      if (typeof d.$num === 'string') return { kind: 'num', value: d.$num === 'inf' ? Infinity : d.$num === '-inf' ? -Infinity : NaN };
      if (typeof d.$bytes === 'string') return { kind: 'str', value: hexLatin1(d.$bytes) };
      if (typeof d.$fn === 'string') return { kind: 'fn', name: d.$fn };
      if (typeof d.$buffer === 'string') return { kind: 'buffer', hex: d.$buffer };
    }
    return { kind: 'table', id: this.tableId(d) };
  }
  /** Lua t[key] */
  get(t: unknown, key: number | string | boolean): unknown {
    const d = this.deref(t) as any;
    if (Array.isArray(d)) { if (typeof key === 'number' && Number.isInteger(key) && key >= 1 && key <= d.length) return d[key - 1]; return undefined; }
    if (!isObj(d)) return undefined;
    if (typeof key === 'number') {
      const arr = d.$arr as unknown[] | undefined;
      if (arr && Number.isInteger(key) && key >= 1 && key <= arr.length) return arr[key - 1];
      const m = d.$map as Obj | undefined;
      if (m) { const s = String(key); if (s in m) return m[s]; if (Number.isInteger(key) && (s + '.0') in m) return m[s + '.0']; }
      if (!('$id' in d) && !('$arr' in d) && !('$map' in d) && String(key) in d) return d[String(key)];
      return undefined;
    }
    const k = String(key);
    const m = d.$map as Obj | undefined;
    if (m && k in m && !NUMKEY.test(k)) return m[k];
    if (!('$id' in d) && !('$arr' in d) && !('$map' in d) && !k.startsWith('$') && k in d) return d[k];
    return undefined;
  }
  /** border of the array part (#t for a proper sequence) */
  len(t: unknown): number {
    const d = this.deref(t) as any;
    if (Array.isArray(d)) { let n = d.length; while (n > 0 && (d[n - 1] === null || d[n - 1] === undefined)) n--; return n; }
    if (!isObj(d)) return 0;
    let n = Array.isArray(d.$arr) ? d.$arr.length : 0;
    while (n > 0 && (d.$arr[n - 1] === null || d.$arr[n - 1] === undefined)) n--;
    if (n === (Array.isArray(d.$arr) ? d.$arr.length : 0)) { while (this.get(d, n + 1) !== undefined && this.get(d, n + 1) !== null) n++; }
    return n;
  }
  /** all entries as [luaKey, value] */
  entries(t: unknown): Array<[number | string, unknown]> {
    const d = this.deref(t) as any;
    const out: Array<[number | string, unknown]> = [];
    if (Array.isArray(d)) { d.forEach((v, i) => { if (v !== null && v !== undefined) out.push([i + 1, v]); }); return out; }
    if (!isObj(d)) return out;
    if (Array.isArray(d.$arr)) d.$arr.forEach((v: unknown, i: number) => { if (v !== null && v !== undefined) out.push([i + 1, v]); });
    if (isObj(d.$map)) for (const [k, v] of Object.entries(d.$map)) out.push([NUMKEY.test(k) ? Number(k) : k, v]);
    if (!('$id' in d) && !('$arr' in d) && !('$map' in d)) for (const [k, v] of Object.entries(d)) if (!k.startsWith('$')) out.push([NUMKEY.test(k) ? Number(k) : k, v]);
    return out;
  }
  /** every table reachable from v (deduplicated by identity) */
  tables(v: unknown = this.root): unknown[] {
    const out: unknown[] = []; const seen = new Set<unknown>();
    const st: unknown[] = [v];
    while (st.length) {
      const x = this.deref(st.pop());
      if (!this.isTable(x) || seen.has(x)) continue;
      seen.add(x); out.push(x);
      for (const [, e] of this.entries(x)) st.push(e);
      if (isObj(x) && x.$meta) st.push(x.$meta);
    }
    return out;
  }
}

const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;
/** AST literal for a scalar; tables / functions go through nameOf */
export function literalExpr(s: Scalar, nameOf: (s: Scalar) => A.Expr): A.Expr {
  switch (s.kind) {
    case 'nil': return { type: 'NilLit' };
    case 'bool': return s.value ? { type: 'TrueLit' } : { type: 'FalseLit' };
    case 'num': {
      const v = s.value;
      if (v < 0 || Object.is(v, -0)) return { type: 'UnExpr', op: '-', expr: { type: 'NumberLit', value: -v, raw: numRaw(-v) } };
      return { type: 'NumberLit', value: v, raw: numRaw(v) };
    }
    case 'str': return { type: 'StringLit', value: s.value, raw: JSON.stringify(s.value) };
    default: return nameOf(s);
  }
}
export function numRaw(v: number): string {
  if (Number.isInteger(v) && Math.abs(v) < 2 ** 53) return String(v);
  if (!Number.isFinite(v)) return v > 0 ? '(1/0)' : v < 0 ? '(-1/0)' : '(0/0)';
  return String(v);
}
/** dotted library path -> expression (`bit32.bxor` -> MemberExpr) when it is a plain identifier path */
export function pathExpr(path: string): A.Expr | null {
  const parts = path.split('.');
  if (!parts.every(p => IDENT.test(p))) return null;
  let e: A.Expr = { type: 'NameExpr', name: parts[0] };
  for (const p of parts.slice(1)) e = { type: 'MemberExpr', obj: e, name: p };
  return e;
}
