// Proto / function inventory — universal: nothing obfuscator- or sample-specific.
// The luac -l -l view of a script, recovered from source:
//   * every function — or, in a PRISM VM residual program (vm_lift / vm_specialize output: protos as
//     `T[n] = function(upvalues, …) … end` makers, closures made by `T[m](array)`), every proto;
//   * the constants each one uses: strings, numbers, globals and global paths (`string.format`), methods;
//   * its upvalues — free locals, or the upvalue array's slots and how each one is read (`k[1][157]`);
//   * the protos / functions it creates and, per creation site, what goes into each upvalue slot of the
//     new closure (a shared register box, a register value, one of the creator's own upvalues, any expression);
//   * the constant pools it fills (a table getting >= 8 literal-keyed stores of literals / global paths,
//     or a table constructor of >= 8 constant fields);
//   * the creation tree, and what every proto has in common (the VM's own scaffolding).
import type * as A from '../ast.js';
import { analyzeScopes } from './scope.js';
import type { Binding } from './scope.js';
import { printExpr } from '../vm/specialize.js';

export interface InvCapture { slot: string; kind: 'box' | 'value' | 'upvalue' | 'expr'; register?: number; upvalue?: string; text: string }
export interface InvChild { id: string; line: number; captures: InvCapture[] }
export interface InvUpvalue { name: string; reads: number; writes: number; fields: Array<[string, number]> }
export interface InvPool { name: string; line: number; entries: Array<[string, string]> }
export interface InvUnit {
  id: string; name: string; line: number; endLine: number; header?: string;
  params: string[]; vararg: boolean; parents: string[];
  /** [value, uses] in first-use order */
  strings: Array<[string, number]>; numbers: Array<[string, number]>; globals: Array<[string, number]>; methods: Array<[string, number]>;
  upvalues: InvUpvalue[]; children: InvChild[]; pools: InvPool[]; calls: number;
  /** register table name (VM protos: the local indexed most by integer literals) */
  registers?: string;
}
export interface Inventory {
  mode: 'protos' | 'functions';
  protoTable?: string;
  units: InvUnit[];
  /** used by every proto / function (when there are >= 4): the VM's own scaffolding */
  common: { globals: string[]; strings: string[]; upvalues: string[] };
  tree: string[];
  notes: string[];
}

const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;
type Ctx = { list: A.Stat[]; index: number } | null;
const keyText = (e: A.Expr | undefined): string | null =>
  !e ? null : e.type === 'NumberLit' ? String(e.value) : e.type === 'StringLit' ? JSON.stringify(e.value) : null;
const bump = (m: Map<string, number>, k: string) => m.set(k, (m.get(k) ?? 0) + 1);
const reEsc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

interface Work {
  u: InvUnit; fn: A.FunctionExpr | A.Chunk; upParam?: Binding;
  strings: Map<string, number>; numbers: Map<string, number>; globals: Map<string, number>; methods: Map<string, number>;
  ups: Map<string, { reads: number; writes: number; fields: Map<string, number> }>;
  idx: Map<string, number>;
  gfields: Map<string, { reads: number; writes: number; fields: Map<string, number> }>;
  poolCand: Map<Binding | A.TableExpr, { name: string; line: number; stores: number; consts: number; dup: number; entries: Map<string, string> }>;
}

/** the PRISM residual proto table: the table getting the most top-level `T[lit] = function … end` makers */
function findProtoTable(chunk: A.Chunk): { name: string; makers: Array<{ id: string; fn: A.FunctionExpr }> } | null {
  const by = new Map<string, Array<{ id: string; fn: A.FunctionExpr }>>();
  for (const s of chunk.body) {
    if (s.type !== 'AssignStat' || s.targets.length !== 1 || s.values.length !== 1 || s.op) continue;
    const t = s.targets[0], v = s.values[0];
    if (t.type !== 'IndexExpr' || t.obj.type !== 'NameExpr' || v.type !== 'FunctionExpr') continue;
    const id = keyText(t.index);
    if (id === null) continue;
    if (!by.has(t.obj.name)) by.set(t.obj.name, []);
    by.get(t.obj.name)!.push({ id: id.replace(/^"|"$/g, ''), fn: v });
  }
  let best: { name: string; makers: Array<{ id: string; fn: A.FunctionExpr }> } | null = null;
  for (const [name, makers] of by) if (makers.length >= 2 && (!best || makers.length > best.makers.length)) best = { name, makers };
  return best;
}

export function protoInventory(chunk: A.Chunk, src = ''): Inventory {
  const sc = analyzeScopes(chunk);
  const srcLines = src ? src.split('\n') : [];
  const pt = findProtoTable(chunk);
  const mode: Inventory['mode'] = pt ? 'protos' : 'functions';
  const notes: string[] = [];
  const parentOf = new Map<object, [any, string | null]>();
  const fnWork = new Map<A.FunctionExpr | A.Chunk, Work>();
  const works: Work[] = [];
  const lastLine = srcLines.length || 1;
  const newWork = (u: InvUnit, fn: A.FunctionExpr | A.Chunk): Work => {
    const w: Work = { u, fn, strings: new Map(), numbers: new Map(), globals: new Map(), methods: new Map(), ups: new Map(), idx: new Map(), gfields: new Map(), poolCand: new Map() };
    works.push(w);
    return w;
  };
  const unit = (id: string, name: string, f: A.FunctionExpr | null, line: number, endLine: number): InvUnit => ({
    id, name, line, endLine, params: f ? f.params : [], vararg: f ? f.vararg : true, parents: [],
    strings: [], numbers: [], globals: [], methods: [], upvalues: [], children: [], pools: [], calls: 0,
  });
  const main = newWork(unit('main', 'main chunk', null, 1, lastLine), chunk);
  fnWork.set(chunk, main);
  const makerWork = new Map<A.FunctionExpr, Work>();
  if (pt) {
    for (const m of pt.makers) {
      const line = m.fn.loc?.line ?? 0;
      const u = unit(m.id, 'proto ' + m.id, m.fn, line, m.fn.loc?.endLine ?? line);
      const h = line >= 2 ? srcLines[line - 2]?.trim() : undefined;
      if (h && h.startsWith('--')) u.header = h.replace(/^--+\s*/, '');
      const w = newWork(u, m.fn);
      const p0 = m.fn.params[0];
      if (p0) w.upParam = (sc.fnBindings.get(m.fn) ?? []).find(b => b.name === p0);
      makerWork.set(m.fn, w);
    }
  }
  const fnName = (f: A.FunctionExpr, parent: any, key: string | null): string => {
    if (parent?.type === 'LocalFunctionStat') return parent.name;
    if (parent?.type === 'FunctionStat') { const t = printExpr(parent.target); return parent.isMethod ? t.replace(/\.([A-Za-z_][A-Za-z0-9_]*)$/, ':$1') : t; }
    if (parent?.type === 'AssignStat' && key === 'values') { const i = parent.values.indexOf(f); if (parent.targets[i]) return printExpr(parent.targets[i]); }
    if (parent?.type === 'LocalStat' && key === 'init') { const i = parent.init.indexOf(f); if (parent.names[i]) return parent.names[i]; }
    if (parent && !parent.type && parent.kind === 'named' && parent.name) return '.' + parent.name;
    return 'function';
  };
  const pending: Array<{ w: Work; call: A.CallExpr; ctx: Ctx; id: string }> = [];
  const gstat = new Map<string, { int: number; other: number }>();
  const pathRoot = (e: any, depth = 0): string | null => {
    if (depth > 6) return null;
    if (e.type === 'NameExpr') { const b = sc.refOf.get(e); return b && b.kind === 'global' && e.name !== pt?.name ? e.name : null; }
    if (e.type === 'MemberExpr') { const p = pathRoot(e.obj, depth + 1); return p ? p + '.' + e.name : null; }
    if (e.type === 'IndexExpr' && e.index.type === 'StringLit' && IDENT.test(e.index.value)) { const p = pathRoot(e.obj, depth + 1); return p ? p + '.' + e.index.value : null; }
    return null;
  };
  const constLike = (v: A.Expr): boolean =>
    v.type === 'NilLit' || v.type === 'TrueLit' || v.type === 'FalseLit' || v.type === 'NumberLit' || v.type === 'StringLit'
    || (v.type === 'UnExpr' && v.op === '-' && v.expr.type === 'NumberLit') || pathRoot(v) !== null;
  const upOf = (w: Work, name: string) => {
    let e = w.ups.get(name);
    if (!e) { e = { reads: 0, writes: 0, fields: new Map() }; w.ups.set(name, e); }
    return e;
  };
  const isWrite = (node: any) => { const p = parentOf.get(node); return !!p && p[0]?.type === 'AssignStat' && p[1] === 'targets'; };
  const fieldOf = (node: any): string | null => { const p = parentOf.get(node); return p && p[0]?.type === 'IndexExpr' && p[1] === 'obj' ? keyText(p[0].index) ?? '?' : null; };

  const onNode = (n: any, parent: any, key: string | null, w: Work, ctx: Ctx) => {
    switch (n.type) {
      case 'StringLit':
        if (parent?.type === 'IndexExpr' && key === 'index' && IDENT.test(n.value) && pathRoot(parent.obj)) break; // part of a global path
        bump(w.strings, n.value);
        break;
      case 'NumberLit':
        if ((parent?.type === 'IndexExpr' && key === 'index') || key === 'key') break; // table subscripts / keys
        bump(w.numbers, (parent?.type === 'UnExpr' && parent.op === '-' ? '-' : '') + String(n.value));
        break;
      case 'NameExpr': {
        const b = sc.refOf.get(n);
        if (!b) break;
        if (b.kind === 'global') {
          if (n.name === pt?.name) break;
          let top: any = n, path = n.name;
          for (let d = 1; d < 4; d++) {
            const p = parentOf.get(top);
            if (!p || p[1] !== 'obj') break;
            const par = p[0];
            if (par.type === 'MemberExpr') path += '.' + par.name;
            else if (par.type === 'IndexExpr' && par.index.type === 'StringLit' && IDENT.test(par.index.value)) path += '.' + par.index.value;
            else break;
            top = par;
          }
          bump(w.globals, path);
          let ge = w.gfields.get(n.name);
          if (!ge) { ge = { reads: 0, writes: 0, fields: new Map() }; w.gfields.set(n.name, ge); }
          if (isWrite(n)) ge.writes++; else ge.reads++;
          const gf = fieldOf(n);
          if (gf !== null) bump(ge.fields, gf);
          let gs = gstat.get(n.name);
          if (!gs) { gs = { int: 0, other: 0 }; gstat.set(n.name, gs); }
          const pp = parentOf.get(n);
          // subscripted (t[1], t[i]) vs used like an API (t.name, t["name"], t:method())
          if (pp && pp[1] === 'obj' && pp[0]?.type === 'IndexExpr' && pp[0].index.type !== 'StringLit') gs.int++;
          else if (pp && pp[1] === 'obj' && (pp[0]?.type === 'MemberExpr' || pp[0]?.type === 'IndexExpr' || pp[0]?.type === 'MethodCallExpr')) gs.other++;
          break;
        }
        if (w.upParam && b === w.upParam) {
          const p = parentOf.get(n);
          if (p && p[0]?.type === 'IndexExpr' && p[1] === 'obj') {
            const slot = keyText(p[0].index) ?? '?';
            const e = upOf(w, `${n.name}[${slot}]`);
            if (isWrite(p[0])) e.writes++; else e.reads++;
            const f = fieldOf(p[0]);
            if (f !== null) bump(e.fields, f);
          } else upOf(w, n.name).reads++;
          break;
        }
        if (fnWork.get(b.fn) !== w && b.name !== pt?.name) {
          const e = upOf(w, b.name);
          if (isWrite(n)) e.writes++; else e.reads++;
          const f = fieldOf(n);
          if (f !== null) bump(e.fields, f);
        }
        break;
      }
      case 'IndexExpr':
        if (n.obj.type === 'NameExpr' && n.index.type === 'NumberLit' && Number.isInteger(n.index.value)) bump(w.idx, n.obj.name);
        break;
      case 'CallExpr':
        w.u.calls++;
        if (pt && n.callee.type === 'IndexExpr' && n.callee.obj.type === 'NameExpr' && n.callee.obj.name === pt.name) {
          const id = keyText(n.callee.index);
          if (id !== null) pending.push({ w, call: n, ctx, id: id.replace(/^"|"$/g, '') });
        }
        break;
      case 'MethodCallExpr':
        w.u.calls++;
        bump(w.methods, n.method);
        break;
      case 'AssignStat':
        if (n.op || n.targets.length !== n.values.length) break;
        n.targets.forEach((t: A.Expr, i: number) => {
          if (t.type !== 'IndexExpr' || t.obj.type !== 'NameExpr') return;
          const k = keyText(t.index);
          const b = sc.refOf.get(t.obj);
          if (k === null || !b || b.kind === 'global') return;
          let pc = w.poolCand.get(b);
          if (!pc) { pc = { name: t.obj.name, line: n.loc?.line ?? 0, stores: 0, consts: 0, dup: 0, entries: new Map() }; w.poolCand.set(b, pc); }
          pc.stores++;
          const v = n.values[i];
          if (constLike(v)) { pc.consts++; if (pc.entries.has(k)) pc.dup++; pc.entries.set(k, printExpr(v)); }
        });
        break;
      case 'TableExpr': {
        if (n.fields.length < 8) break;
        const ent = new Map<string, string>();
        let item = 0, consts = 0;
        for (const f of n.fields as A.TableField[]) {
          const k = f.kind === 'item' ? String(++item) : f.kind === 'named' ? JSON.stringify(f.name) : keyText(f.key);
          if (k !== null && constLike(f.value)) { consts++; ent.set(k, printExpr(f.value)); }
        }
        if (consts < 8 || consts < 0.9 * n.fields.length) break;
        let name = 'table';
        if (parent?.type === 'LocalStat' && key === 'init') name = parent.names[parent.init.indexOf(n)] ?? name;
        else if (parent?.type === 'AssignStat' && key === 'values') { const t = parent.targets[parent.values.indexOf(n)]; if (t) name = printExpr(t); }
        w.poolCand.set(n, { name, line: n.loc?.line ?? 0, stores: consts, consts, dup: 0, entries: ent });
        break;
      }
    }
  };

  const visit = (node: any, parent: any, key: string | null, w: Work, ctx: Ctx) => {
    if (!node || typeof node !== 'object') return;
    if (typeof node.type === 'string') {
      parentOf.set(node, [parent, key]);
      if (node.type === 'FunctionExpr') {
        const mw = makerWork.get(node);
        if (mw) w = mw;
        else if (mode === 'functions') {
          const line = node.loc?.line ?? 0;
          const name = fnName(node, parent, key);
          const nw = newWork(unit(`${name}@${line}`, name, node, line, node.loc?.endLine ?? line), node);
          w.u.children.push({ id: nw.u.id, line, captures: [] });
          w = nw;
        }
        fnWork.set(node, w);
      }
      onNode(node, parent, key, w, ctx);
    }
    for (const k of Object.keys(node)) {
      if (k === 'loc' || k === 'type') continue;
      const v = node[k];
      if (Array.isArray(v)) {
        const list = k === 'body' || k === 'elseBody';
        for (let i = 0; i < v.length; i++) visit(v[i], node, k, w, list ? { list: v, index: i } : ctx);
      } else if (v && typeof v === 'object') visit(v, node, k, w, ctx);
    }
  };
  visit(chunk, null, null, main, null);

  // registers: PRISM's promoted registers are named <table>_<n>, so the table with the most promoted
  // siblings is the register table; else the local indexed most by integer literals that is neither the
  // upvalue array nor a constant pool
  const qualifies = (pc: { entries: Map<string, string>; stores: number; consts: number; dup: number }) =>
    pc.entries.size >= 8 && pc.consts >= 0.9 * pc.stores && pc.dup <= 0.1 * pc.consts;
  const promoted = new Map<Work, Map<string, number>>();
  for (const [fn, bs] of sc.fnBindings) {
    const w = fnWork.get(fn);
    if (!w) continue;
    for (const b of bs) {
      const m = /^(.+)_(\d+)$/.exec(b.name);
      if (!m) continue;
      let pm = promoted.get(w);
      if (!pm) promoted.set(w, pm = new Map());
      bump(pm, m[1]);
    }
  }
  for (const w of works) {
    const pools = new Set([...w.poolCand.values()].filter(qualifies).map(pc => pc.name));
    let best = '', bn = 0;
    for (const [name, c] of promoted.get(w) ?? []) if (c > bn && w.idx.has(name) && !pools.has(name)) { best = name; bn = c; }
    if (bn >= 2) { w.u.registers = best; continue; }
    bn = 0;
    for (const [name, c] of w.idx) if (c > bn && name !== w.upParam?.name && !pools.has(name)) { best = name; bn = c; }
    if (bn >= 8) w.u.registers = best;
  }

  // closure creation sites: what goes into each upvalue slot of the new closure
  const assigns = (s: any, name: string) =>
    (s?.type === 'AssignStat' && !s.op && s.targets.some((t: any) => t.type === 'NameExpr' && t.name === name))
    || (s?.type === 'LocalStat' && s.names.includes(name));
  for (const p of pending) {
    const caps = new Map<string, InvCapture>();
    const arg = p.call.args[0];
    const reg = p.w.u.registers;
    const upName = p.w.upParam?.name;
    const regRe = reg ? new RegExp('^' + reEsc(reg) + '_(\\d+)$') : null;
    const last = new Map<string, A.Expr>();
    const describe = (slot: string, v0: A.Expr): InvCapture => {
      let v = v0;
      const seen = new Set<string>();
      while (v.type === 'NameExpr' && last.has(v.name) && !seen.has(v.name) && !(regRe && regRe.test(v.name))) { seen.add(v.name); v = last.get(v.name)!; }
      if (v.type === 'TableExpr') {
        const num = v.fields.find(f => f.value.type === 'NumberLit');
        const tab = v.fields.find(f => f.value.type === 'NameExpr');
        if (num && tab) return { slot, kind: 'box', register: (num.value as A.NumberLit).value, text: printExpr(v) };
      }
      if (v.type === 'IndexExpr' && v.obj.type === 'NameExpr' && v.index.type === 'NumberLit') {
        if (upName && v.obj.name === upName) return { slot, kind: 'upvalue', upvalue: String(v.index.value), text: printExpr(v) };
        if (reg && v.obj.name === reg) return { slot, kind: 'value', register: v.index.value, text: printExpr(v) };
      }
      if (v.type === 'NameExpr' && regRe) { const m = regRe.exec(v.name); if (m) return { slot, kind: 'value', register: Number(m[1]), text: v.name }; }
      return { slot, kind: 'expr', text: printExpr(v) };
    };
    if (arg?.type === 'TableExpr') {
      let item = 0;
      for (const f of arg.fields) {
        const k = f.kind === 'item' ? String(++item) : f.kind === 'named' ? JSON.stringify(f.name) : keyText(f.key);
        if (k !== null) caps.set(k, describe(k, f.value));
      }
    } else if (arg?.type === 'NameExpr' && p.ctx) {
      const name = arg.name, L = p.ctx.list;
      let start = p.ctx.index, end = L.length - 1;
      for (let i = p.ctx.index - 1; i >= 0 && p.ctx.index - i <= 400; i--) if (assigns(L[i], name)) { start = i; break; }
      for (let i = p.ctx.index + 1; i < L.length; i++) if (assigns(L[i], name)) { end = i - 1; break; }
      const step = (s: any) => {
        switch (s?.type) {
          case 'LocalStat': s.names.forEach((nm: string, i: number) => { if (s.init[i]) last.set(nm, s.init[i]); else last.delete(nm); }); break;
          case 'AssignStat':
            if (s.op) break;
            s.targets.forEach((t: any, i: number) => {
              const v = s.values[i];
              if (!v) return;
              if (t.type === 'NameExpr') last.set(t.name, v);
              else if (t.type === 'IndexExpr' && t.obj.type === 'NameExpr' && t.obj.name === name) { const slot = keyText(t.index); if (slot !== null) caps.set(slot, describe(slot, v)); }
            });
            break;
          case 'IfStat': for (const c of s.clauses) c.body.forEach(step); if (s.elseBody) s.elseBody.forEach(step); break;
          case 'DoStat': s.body.forEach(step); break;
        }
      };
      for (let i = start; i <= end; i++) step(L[i]);
    }
    const sorted = [...caps.values()].sort((a, b) => (Number(a.slot) - Number(b.slot)) || (a.slot < b.slot ? -1 : a.slot > b.slot ? 1 : 0));
    p.w.u.children.push({ id: p.id, line: p.call.loc?.line ?? 0, captures: sorted });
  }

  // finish units. A global the script assigns, or only ever subscripts (never t.name / t:method()), is the
  // program's own state (a data / record / helper table) — listed with the free locals, not as an API global
  const isState = (name: string) => {
    const g = sc.globals.get(name), st = gstat.get(name);
    return (!!g && g.writes > 0) || (!!st && st.int > 0 && st.other === 0);
  };
  for (const w of works) {
    const u = w.u;
    u.strings = [...w.strings]; u.numbers = [...w.numbers]; u.methods = [...w.methods];
    u.globals = [...w.globals].filter(([path]) => !isState(path.split('.')[0]));
    u.upvalues = [...w.ups].map(([name, e]) => ({ name, reads: e.reads, writes: e.writes, fields: [...e.fields] }));
    for (const [name, e] of w.gfields) if (isState(name)) u.upvalues.push({ name, reads: e.reads, writes: e.writes, fields: [...e.fields] });
    for (const pc of w.poolCand.values()) if (qualifies(pc)) u.pools.push({ name: pc.name, line: pc.line, entries: [...pc.entries] });
  }
  const units = works.map(w => w.u);
  if (mode === 'protos') units.sort((a, b) => (a.id === 'main' ? -1 : b.id === 'main' ? 1 : a.line - b.line));
  const byId = new Map(units.map(u => [u.id, u]));
  for (const u of units) for (const c of u.children) { const cu = byId.get(c.id); if (cu && !cu.parents.includes(u.id)) cu.parents.push(u.id); }
  const missing = new Set<string>();
  for (const u of units) for (const c of u.children) if (!byId.has(c.id)) missing.add(c.id);
  if (missing.size) notes.push(`created but not defined here: ${[...missing].join(', ')}`);

  // what every proto / function has in common — the VM's own scaffolding
  const rest = units.filter(u => u.id !== 'main');
  const common = { globals: [] as string[], strings: [] as string[], upvalues: [] as string[] };
  if (rest.length >= 4) {
    const all = (pick: (u: InvUnit) => string[]) => { const [f, ...o] = rest.map(u => new Set(pick(u))); return [...(f ?? [])].filter(x => o.every(s => s.has(x))); };
    common.globals = all(u => u.globals.map(g => g[0]));
    common.strings = all(u => u.strings.map(s => s[0]));
    common.upvalues = all(u => u.upvalues.map(x => x.name).filter(n => !/\[/.test(n)));
  }

  // creation tree
  const tree: string[] = [];
  const shown = new Set<string>();
  const label = (u: InvUnit, times: number) => {
    const ins = /(\d+) instructions?/.exec(u.header ?? '')?.[1];
    const entry = mode === 'protos' && u.id !== 'main' && !u.parents.length ? '  ← entry (created outside the protos)' : '';
    return `${u.name}${ins ? `  (${ins} instr)` : ''}${times > 1 ? `  ×${times}` : ''}${entry}`;
  };
  const dfs = (u: InvUnit, prefix: string, last: boolean, times: number, depth: number) => {
    const again = shown.has(u.id);
    tree.push(`${prefix}${depth ? (last ? '└─ ' : '├─ ') : ''}${label(u, times)}${again ? '  (see above)' : ''}`);
    if (again) return;
    shown.add(u.id);
    const kids = new Map<string, number>();
    for (const c of u.children) if (byId.has(c.id)) kids.set(c.id, (kids.get(c.id) ?? 0) + 1);
    const ks = [...kids];
    ks.forEach(([id, n], i) => dfs(byId.get(id)!, prefix + (depth ? (last ? '   ' : '│  ') : ''), i === ks.length - 1, n, depth + 1));
  };
  const skip = (u: InvUnit) => u.id === 'main' && !u.children.length;
  for (const u of units) if (!u.parents.length && !skip(u)) dfs(u, '', true, 1, 0);
  for (const u of units) if (!shown.has(u.id) && !skip(u)) dfs(u, '', true, 1, 0); // creation cycles
  return { mode, protoTable: pt?.name, units, common, tree, notes };
}

const q = (s: string, n = 60) => { const j = JSON.stringify(s); return j.length > n ? j.slice(0, n - 1) + '…"' : j; };
const list = (xs: string[], max: number) => xs.length <= max ? xs.join(', ') : xs.slice(0, max).join(', ') + `, … +${xs.length - max} more`;
const counted = (xs: Array<[string, number]>, fmt: (s: string) => string, max: number) => list(xs.map(([s, n]) => fmt(s) + (n > 1 ? ` ×${n}` : '')), max);

export function formatCapture(c: InvCapture): string {
  if (c.kind === 'box') return `${c.slot}=box r${c.register}`;
  if (c.kind === 'value') return `${c.slot}=r${c.register}`;
  if (c.kind === 'upvalue') return `${c.slot}=upvalue ${c.upvalue}`;
  return `${c.slot}=${c.text.length > 40 ? c.text.slice(0, 39) + '…' : c.text}`;
}

/** readable inventory: tree, scaffolding, then one section per proto / function */
export function formatInventory(inv: Inventory, o: { max?: number; only?: string[] } = {}): string {
  const max = o.max ?? 60;
  const out: string[] = [];
  const n = inv.units.filter(u => u.id !== 'main').length;
  out.push(inv.mode === 'protos'
    ? `# proto inventory — ${n} proto(s) of a VM residual program (${inv.protoTable}[n] makers; closures made by ${inv.protoTable}[m](upvalues))`
    : `# function inventory — main chunk + ${n} function(s)`);
  out.push('', 'creation tree:', ...inv.tree);
  const cg = new Set(inv.common.globals), cs = new Set(inv.common.strings), cu = new Set(inv.common.upvalues);
  if (cg.size || cs.size || cu.size) {
    out.push('', `common to every ${inv.mode === 'protos' ? 'proto' : 'function'} (scaffolding — not repeated below):`);
    if (cg.size) out.push(`  globals: ${list([...cg], max)}`);
    if (cu.size) out.push(`  free locals: ${list([...cu], max)}`);
    if (cs.size) out.push(`  strings: ${list([...cs].map(s => q(s)), max)}`);
  }
  for (const w of inv.notes) out.push('# ' + w);
  const only = o.only?.length ? new Set(o.only) : null;
  const site = new Map<string, { c: InvChild; n: number }>();
  for (const u of inv.units) for (const c of u.children) { const e = site.get(c.id); if (e) e.n++; else site.set(c.id, { c, n: 1 }); }
  for (const u of inv.units) {
    if (only && !only.has(u.id) && !only.has(u.name)) continue;
    const own = u.id === 'main';
    if (own && !u.children.length && !u.strings.length && !u.globals.length && !u.pools.length && !u.calls) continue;
    out.push('', `## ${u.name}${u.header ? ' — ' + u.header.replace(/^proto \S+:\s*/, '') : ''} — lines ${u.line}–${u.endLine}${u.parents.length ? ' — created by ' + u.parents.map(p => p === 'main' ? 'main' : (inv.mode === 'protos' ? 'proto ' + p : p)).join(', ') : ''}`);
    { const f = site.get(u.id); if (inv.mode === 'protos' && !own && f && f.c.captures.length) out.push(`upvalue map${f.n > 1 ? ` (first of ${f.n} creation sites)` : ''}: ${list(f.c.captures.map(formatCapture), max)}`); }
    if (!own && inv.mode === 'functions') out.push(`params: (${[...u.params, ...(u.vararg ? ['...'] : [])].join(', ')})`);
    const ups = u.upvalues.filter(x => !cu.has(x.name));
    const slots = ups.filter(x => /\[/.test(x.name)), free = ups.filter(x => !/\[/.test(x.name));
    const from = site.get(u.id);
    const src = (x: InvUpvalue) => {
      const m = /\[([^\]]+)\]$/.exec(x.name);
      const c = m && from ? from.c.captures.find(k => k.slot === m[1]) : undefined;
      return c ? ' ← ' + formatCapture(c).replace(/^[^=]*=/, '') : '';
    };
    const upText = (x: InvUpvalue) => `${x.name}${x.reads + x.writes > 1 ? ` ×${x.reads + x.writes}` : ''}${src(x)}${x.writes ? ` (${x.writes} write${x.writes > 1 ? 's' : ''})` : ''}${x.fields.length ? ` [fields ${list(x.fields.map(([f, c]) => f + (c > 1 ? '×' + c : '')), 12)}]` : ''}`;
    if (inv.mode === 'protos' && !own) out.push(`upvalues read: ${slots.length ? list(slots.map(upText), max) : 'none'}`);
    if (free.length) out.push(`${inv.mode === 'protos' ? 'locals of the residual program used' : 'upvalues (free locals)'}: ${list(free.map(upText), max)}`);
    if (u.children.length) {
      out.push(`creates (${u.children.length}):`);
      for (const c of u.children.slice(0, max)) out.push(`  ${inv.mode === 'protos' ? 'proto ' + c.id : c.id} @${c.line}${c.captures.length ? ` — upvalues ${list(c.captures.map(formatCapture), 40)}` : ''}`);
      if (u.children.length > max) out.push(`  … +${u.children.length - max} more`);
    }
    for (const p of u.pools.slice(0, own ? 3 : 20)) out.push(`constant pool ${p.name} @${p.line}: ${p.entries.length} entries — ${list(p.entries.map(([k, v]) => `[${k}]=${v.length > 30 ? v.slice(0, 29) + '…' : v}`), own ? 8 : max)}`);
    if (u.pools.length > (own ? 3 : 20)) out.push(`  … +${u.pools.length - (own ? 3 : 20)} more constant pools`);
    const g = u.globals.filter(x => !cg.has(x[0])), s = u.strings.filter(x => !cs.has(x[0]));
    if (g.length) out.push(`globals (${g.length}): ${counted(g, x => x, max)}`);
    if (u.methods.length) out.push(`methods (${u.methods.length}): ${counted(u.methods, x => ':' + x, max)}`);
    if (s.length) out.push(`strings (${s.length}): ${counted(s, x => q(x), max)}`);
    if (u.numbers.length) out.push(`numbers (${u.numbers.length}): ${counted(u.numbers, x => x, max)}`);
    out.push(`calls: ${u.calls}`);
  }
  return out.join('\n');
}
