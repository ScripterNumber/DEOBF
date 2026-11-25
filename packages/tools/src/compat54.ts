// Line-preserving Luau -> Lua 5.4 shim, used ONLY for QA runs (luau_run engine "lua54") when no Luau binary
// is available. Deobfuscation itself never executes anything.
//   * every `continue` becomes `goto __continueN` with `::__continueN::` placed right before the loop's `end`
//     (a label that is the last statement of a block is outside all local scopes in 5.4, so the jump is legal)
//   * a loop body that ends in `return` gets that return wrapped in `do ... end` so the label can follow it
//   * Luau generalized iteration (`for k, v in t do` over a table) goes through __prism_iter(...), which falls
//     back to next/__iter exactly like Luau does
//   * a one-line prelude adds the Luau library extras (table.create/find/clear/clone, bit32, getfenv, math.round,
//     string.split, task, typeof) and Luau-style number printing (5 instead of 5.0)
// Nothing adds or removes a newline, so error line numbers match the input script.
import { lex, parse, T, AST, decodeNumber } from '@prism/core';

// Luau numbers are doubles; Lua 5.4 integers are exact 64-bit. A hash/LCG like (s * 1103515245 + 12345) % 2^32
// rounds in Luau but not in 5.4, so big integer literals (>= 2^24, the ones used for hashing / RNG / bit masks)
// are written as floats: the arithmetic they feed then rounds exactly like Luau. Luau-only literals
// (1_000, 0b101) are rewritten to plain decimals.
function floatLit(n: number): string {
  const s = String(n);
  return /[.eE]/.test(s) || !Number.isFinite(n) ? s : s + '.0';
}

const PRELUDE = [
  'do local tc, mt, fl, sf, sel, unp = tostring, math.type, math.floor, string.format, select, table.unpack;',
  'unpack = unpack or unp; loadstring = loadstring or load; typeof = typeof or type;',
  'getfenv = getfenv or function() return _G end; setfenv = setfenv or function(f) return f end;',
  'newproxy = newproxy or function() return setmetatable({}, {}) end;',
  "__prism_iter = function(f, s, c) if type(f) == 'table' then local m = getmetatable(f); if m and m.__iter then return m.__iter(f) end; if not (m and m.__call) then return next, f, nil end end; return f, s, c end;",
  "local function fmt(v) if mt(v) == 'float' then if v ~= v then return 'nan' end; if v == math.huge then return 'inf' end;",
  "if v == -math.huge then return '-inf' end; if v == fl(v) and v > -1e15 and v < 1e15 then return sf('%d', v) end; return sf('%.14g', v) end; return tc(v) end;",
  'tostring = fmt; local pr = print;',
  "print = function(...) local n = sel('#', ...); local t = {...}; for i = 1, n do t[i] = fmt(t[i]) end; return pr(unp(t, 1, n)) end;",
  "warn = function(...) local n = sel('#', ...); local t = {...}; for i = 1, n do t[i] = fmt(t[i]) end; io.stderr:write(table.concat(t, ' '), '\\n') end;",
  'table.create = table.create or function(n, v) local t = {}; if v ~= nil then for i = 1, n do t[i] = v end end; return t end;',
  'table.find = table.find or function(t, v, i) for j = i or 1, #t do if t[j] == v then return j end end; return nil end;',
  'table.clear = table.clear or function(t) for k in next, t do t[k] = nil end end;',
  'table.clone = table.clone or function(t) local r = {}; for k, v in next, t do r[k] = v end; return setmetatable(r, getmetatable(t)) end;',
  'table.freeze = table.freeze or function(t) return t end; table.isfrozen = table.isfrozen or function() return false end;',
  'math.clamp = math.clamp or function(x, a, b) if x < a then return a elseif x > b then return b end; return x end;',
  'math.round = math.round or function(x) if x >= 0 then return fl(x + 0.5) end; return -fl(-x + 0.5) end;',
  'math.sign = math.sign or function(x) if x > 0 then return 1 elseif x < 0 then return -1 end; return 0 end;',
  "string.split = string.split or function(s, sep) sep = sep or ','; local r, i = {}, 1; if sep == '' then for c in s:gmatch('.') do r[#r + 1] = c end; return r end;",
  'while true do local a, b = s:find(sep, i, true); if not a then r[#r + 1] = s:sub(i); return r end; r[#r + 1] = s:sub(i, a - 1); i = b + 1 end end;',
  "task = task or { wait = function() return 0 end, spawn = function(f, ...) if type(f) == 'thread' then return coroutine.resume(f, ...) end; return coroutine.wrap(f)(...) end,",
  'defer = function(f, ...) return coroutine.wrap(f)(...) end, delay = function(_, f, ...) return coroutine.wrap(f)(...) end }; wait = wait or task.wait;',
  'if not bit32 then local M = 0xFFFFFFFF; local function u(x) return fl(x) % 4294967296 end;',
  "local function fold(op, r, ...) for i = 1, sel('#', ...) do r = op(r, u((sel(i, ...)))) end; return r end;",
  'bit32 = {}; bit32.band = function(...) return fold(function(a, b) return a & b end, M, ...) end;',
  'bit32.bor = function(...) return fold(function(a, b) return a | b end, 0, ...) end;',
  'bit32.bxor = function(...) return fold(function(a, b) return a ~ b end, 0, ...) end;',
  'bit32.btest = function(...) return bit32.band(...) ~= 0 end; bit32.bnot = function(x) return ~u(x) & M end;',
  'bit32.lshift = function(x, n) if n < 0 then return bit32.rshift(x, -n) end; if n >= 32 then return 0 end; return (u(x) << n) & M end;',
  'bit32.rshift = function(x, n) if n < 0 then return bit32.lshift(x, -n) end; if n >= 32 then return 0 end; return u(x) >> n end;',
  'bit32.arshift = function(x, n) x = u(x); if n < 0 then return bit32.lshift(x, -n) end; local neg = x >= 0x80000000; if n >= 32 then return neg and M or 0 end;',
  'local r = x >> n; if neg then r = r | ((M << (32 - n)) & M) end; return r end;',
  'bit32.lrotate = function(x, n) n = fl(n) % 32; x = u(x); return ((x << n) | (x >> (32 - n))) & M end;',
  'bit32.rrotate = function(x, n) n = fl(n) % 32; x = u(x); return ((x >> n) | (x << (32 - n))) & M end;',
  'bit32.extract = function(x, f, w) w = w or 1; return (u(x) >> f) & ((1 << w) - 1) end;',
  'bit32.replace = function(x, v, f, w) w = w or 1; local m = ((1 << w) - 1) << f; return ((u(x) & ~m) | ((u(v) << f) & m)) & M end;',
  'bit32.countlz = function(x) x = u(x); if x == 0 then return 32 end; local n = 0; while x & 0x80000000 == 0 do x = x << 1; n = n + 1 end; return n end;',
  'bit32.countrz = function(x) x = u(x); if x == 0 then return 32 end; local n = 0; while x & 1 == 0 do x = x >> 1; n = n + 1 end; return n end;',
  'bit32.byteswap = function(x) x = u(x); return ((x & 0xFF) << 24) | ((x & 0xFF00) << 8) | ((x >> 8) & 0xFF00) | (x >> 24) end end end;',
].join(' ');

export const LUA54_PRELUDE = PRELUDE;

export interface Compat54Result { code: string; continues: number; iterators: number; floats: number; notes: string[] }

// tokens after which `if` starts an if-expression (no `end`) rather than an if-statement
const EXPR_BEFORE = new Set(['=', '(', ',', '{', '[', 'return', 'and', 'or', 'not', '+', '-', '*', '/', '//', '%', '^', '..', '==', '~=', '<', '>', '<=', '>=', '#']);

export function toLua54(src: string): Compat54Result {
  const notes: string[] = [];
  const { chunk, errors } = parse(src);
  if (errors.length) notes.push(`parse: ${errors.length} error(s), first at line ${errors[0].line}: ${errors[0].message}`);
  const contAt = new Set<number>();
  const lastReturn = new Map<number, number>(); // loop keyword offset -> offset of a trailing `return` in its body
  let compound = 0, interp = 0;
  AST.walk(chunk, (n: any) => {
    if (n.type === 'ContinueStat' && n.loc) contAt.add(n.loc.start);
    else if (n.type === 'AssignStat' && n.op) compound++;
    else if (n.type === 'InterpExpr') interp++;
    if ((n.type === 'WhileStat' || n.type === 'NumericForStat' || n.type === 'GenericForStat') && n.loc) {
      const last = n.body[n.body.length - 1];
      if (last?.type === 'ReturnStat' && last.loc) lastReturn.set(n.loc.start, last.loc.start);
    }
  });
  if (compound) notes.push(`${compound} compound assignment(s) (+= etc.) are not converted — Lua 5.4 will reject them`);
  if (interp) notes.push(`${interp} interpolated string(s) are not converted — Lua 5.4 will reject them`);
  const { tokens } = lex(src);
  type Frame = { kind: 'loop' | 'repeat' | 'func' | 'block'; at: number; awaitDo?: boolean; iter?: boolean; label?: string };
  let iters = 0, floats = 0;
  const st: Frame[] = [];
  const edits: Array<{ at: number; end: number; text: string }> = [];
  let k = 0, prev: { type: T; value: string } | undefined;
  for (const t of tokens) {
    if (t.type === T.Eof) break;
    const v = t.type === T.Keyword ? t.value : '';
    if (t.type === T.Number) {
      const raw = t.value, num = t.num ?? decodeNumber(raw);
      const isInt = /^(0[xX][0-9a-fA-F_]+|0[bB][01_]+|[0-9_]+)$/.test(raw);
      if (isInt && Math.abs(num) >= 16777216) { edits.push({ at: t.start, end: t.end, text: floatLit(num) }); floats++; }
      else if (/_|^0[bB]/.test(raw)) edits.push({ at: t.start, end: t.end, text: String(num) });
    } else if (contAt.has(t.start)) {
      let i = st.length - 1;
      while (i >= 0 && st[i].kind === 'block') i--;
      if (i >= 0 && st[i].kind !== 'func') {
        const f = st[i];
        f.label ??= `__continue${++k}`;
        edits.push({ at: t.start, end: t.end, text: `goto ${f.label}` });
      } else notes.push(`continue at line ${t.line} is not inside a loop — left as is`);
    } else if (v === 'function') st.push({ kind: 'func', at: t.start });
    else if (v === 'if') {
      const isExpr = prev && (prev.type === T.Punct || prev.type === T.Keyword) && EXPR_BEFORE.has(prev.value);
      if (!isExpr) st.push({ kind: 'block', at: t.start });
    } else if (v === 'while' || v === 'for') st.push({ kind: 'loop', at: t.start, awaitDo: true });
    else if (v === 'in') {
      const top = st[st.length - 1];
      if (top?.kind === 'loop' && top.awaitDo && !top.iter) { top.iter = true; edits.push({ at: t.end, end: t.end, text: ' __prism_iter(' }); iters++; }
    } else if (v === 'do') {
      const top = st[st.length - 1];
      if (top?.awaitDo) { top.awaitDo = false; if (top.iter) edits.push({ at: t.start, end: t.start, text: ') ' }); }
      else st.push({ kind: 'block', at: t.start });
    } else if (v === 'repeat') st.push({ kind: 'repeat', at: t.start });
    else if (v === 'end' || v === 'until') {
      const f = st.pop();
      if (f?.label) {
        const ret = lastReturn.get(f.at);
        if (ret !== undefined && f.kind === 'loop') { edits.push({ at: ret, end: ret, text: 'do ' }); edits.push({ at: t.start, end: t.start, text: `end ::${f.label}:: ` }); }
        else edits.push({ at: t.start, end: t.start, text: `::${f.label}:: ` });
        if (f.kind === 'repeat') notes.push(`continue inside repeat…until near offset ${f.at}: Lua 5.4 rejects it if the body declares locals after the continue`);
      }
    }
    prev = t;
  }
  if (st.length) notes.push(`block scanner ended with ${st.length} open block(s) — continue rewriting may be off`);
  let out = src;
  for (const e of edits.sort((a, b) => b.at - a.at || b.end - a.end)) out = out.slice(0, e.at) + e.text + out.slice(e.end);
  // prelude on line 1 (no newline added); a shebang line is replaced so the line count stays the same
  if (out.startsWith('#')) { const nl = out.indexOf('\n'); out = PRELUDE + (nl < 0 ? '' : out.slice(nl)); }
  else out = PRELUDE + ' ' + out;
  return { code: out, continues: contAt.size, iterators: iters, floats, notes };
}
