// Fold `x = {} / table.create(N)` followed by field stores into one constructor:
//   x = {}; x.a = 1; x[2] = f(); x[k] = v   ->   x = { a = 1, [2] = f(), [k] = v }
// Safe because the fresh table has no metatable (stores are raw), keys and values are evaluated in
// the same order, values must not mention x, keys must be literals or plain names not equal to x,
// duplicate literal keys stop the fold, and if a value contains a call x must not be visible to any
// nested function of the enclosing function (a callee could otherwise observe the half-built table).
import type * as A from '../ast.js';

function visit(n: any, fn: (n: any) => void) {
  if (!n || typeof n !== 'object') return;
  if (Array.isArray(n)) { for (const x of n) visit(x, fn); return; }
  if (typeof n.type === 'string') fn(n);
  for (const k of Object.keys(n)) { if (k === 'loc' || k === 'type') continue; const v = n[k]; if (v && typeof v === 'object') visit(v, fn); }
}
const mentions = (n: any, x: string) => { let r = false; visit(n, m => { if (m.type === 'NameExpr' && m.name === x) r = true; }); return r; };
const hasCall = (n: any) => { let r = false; visit(n, m => { if (m.type === 'CallExpr' || m.type === 'MethodCallExpr') r = true; }); return r; };
const isFresh = (e: any) => (e.type === 'TableExpr') ||
  (e.type === 'CallExpr' && e.callee.type === 'MemberExpr' && e.callee.name === 'create' && e.callee.obj.type === 'NameExpr' && e.callee.obj.name === 'table' && e.args.length >= 1 && e.args.length <= 2 && e.args.every((a: any) => a.type === 'NumberLit') && e.args.length === 1);

export function foldTables(chunk: A.Chunk): number {
  let total = 0;
  const doFunc = (body: A.Stat[]) => {
    const captured = new Set<string>();
    visit(body, n => { if (n.type === 'FunctionExpr') visit(n.body, m => { if (m.type === 'NameExpr') captured.add(m.name); }); });
    const block = (stmts: any[]) => {
      for (const s of stmts) {
        if (s.type === 'IfStat') { s.clauses.forEach((c: any) => block(c.body)); if (s.elseBody) block(s.elseBody); }
        else if (['WhileStat', 'RepeatStat', 'NumericForStat', 'GenericForStat', 'DoStat'].includes(s.type)) block(s.body);
      }
      for (let i = 0; i < stmts.length; i++) {
        const s = stmts[i];
        let x: string | null = null, init: any = null, set: ((e: any) => void) | null = null;
        if (s.type === 'AssignStat' && !s.op && s.targets.length === 1 && s.values.length === 1 && s.targets[0].type === 'NameExpr') { x = s.targets[0].name; init = s.values[0]; set = e => s.values[0] = e; }
        else if (s.type === 'LocalStat' && s.names.length === 1 && s.init.length === 1) { x = s.names[0]; init = s.init[0]; set = e => s.init[0] = e; }
        if (!x || !init || !isFresh(init)) continue;
        if (init.type === 'TableExpr' && init.fields.some((f: any) => mentions(f, x!))) continue;
        const tbl: any = init.type === 'TableExpr' ? init : { type: 'TableExpr', fields: [] };
        const keys = new Set<string>();
        let items = 0, dynamicKeys = false;
        for (const f of tbl.fields) {
          if (f.kind === 'item') items++;
          else if (f.kind === 'named') keys.add('s:' + f.name);
          else if (f.key.type === 'StringLit') keys.add('s:' + f.key.value);
          else if (f.key.type === 'NumberLit') keys.add('n:' + f.key.value);
          else dynamicKeys = true;
        }
        // items occupy 1..items (a trailing multi-value item could occupy more: then stop numeric keys)
        const lastItem = [...tbl.fields].reverse().find((f: any) => f.kind === 'item');
        const openTail = lastItem && ['CallExpr', 'MethodCallExpr', 'VarargLit'].includes(lastItem.value.type) && tbl.fields[tbl.fields.length - 1] === lastItem;
        for (let k = 1; k <= items; k++) keys.add('n:' + k);
        const add: any[] = [];
        let j = i + 1;
        for (; j < stmts.length; j++) {
          const t = stmts[j];
          if (!(t.type === 'AssignStat' && !t.op && t.targets.length === 1 && t.values.length === 1)) break;
          const tg = t.targets[0], v = t.values[0];
          if (!((tg.type === 'MemberExpr' || tg.type === 'IndexExpr') && tg.obj.type === 'NameExpr' && tg.obj.name === x)) break;
          if (mentions(v, x)) break;
          if (hasCall(v) && captured.has(x)) break;
          let field: any, key: string | null = null;
          if (tg.type === 'MemberExpr') { key = 's:' + tg.name; field = { kind: 'named', name: tg.name, value: v }; }
          else {
            const ix = tg.index;
            if (ix.type === 'StringLit') key = 's:' + ix.value;
            else if (ix.type === 'NumberLit') { if (openTail) break; key = 'n:' + ix.value; }
            else if (ix.type === 'NameExpr' && ix.name !== x) { if (keys.size || dynamicKeys) { /* unknown key may collide */ } dynamicKeys = true; }
            else break;
            field = { kind: 'keyed', key: ix, value: v };
          }
          if (key) { if (keys.has(key) || dynamicKeys) break; keys.add(key); }
          else if (keys.size > 0 && add.length + tbl.fields.length > 0) {
            // a dynamic key after literal keys could overwrite one; Lua stores in order either way,
            // and a constructor applies fields left to right, so ordering is preserved.
          }
          add.push(field);
        }
        if (!add.length) continue;
        // numeric keys that continue the item sequence become positional items when no gap and value is single
        for (const f of add) {
          if (f.kind === 'keyed' && f.key.type === 'NumberLit' && f.key.value === items + 1 && !['CallExpr', 'MethodCallExpr', 'VarargLit'].includes(f.value.type) && tbl.fields.every((g: any) => g.kind === 'item') ) { f.kind = 'item'; delete f.key; items++; }
          tbl.fields.push(f);
        }
        set!(tbl);
        stmts.splice(i + 1, j - i - 1);
        total += add.length;
      }
    };
    block(body);
  };
  doFunc(chunk.body);
  visit(chunk.body, n => { if (n.type === 'FunctionExpr') doFunc(n.body); });
  return total;
}
