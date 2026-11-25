// PRISM Lua slice — the exact ORIGINAL code of one function plus everything it statically depends on
// (helper functions, upvalues with static initializers, globals assigned once, table populators),
// re-assembled as a standalone Lua/Luau program with a harness that evaluates every call site with static
// arguments and prints ONE JSON object {"L<line>:<col>": value} — the same contract as the Python port, so
// inline_values / chunk_disasm consume either. No transpilation: when the Python port struggles with an
// exotic construct, the slice still runs unchanged in the user's own Lua 5.1 / Luau. PRISM never runs it.
import type * as A from '../ast.js';
import { print } from '../printer.js';
import { renameBinding, Binding } from '../analysis/scope.js';
import { sliceClosure, PyOptions, FnSite } from './python.js';

export interface LuaSliceResult { code: string; name: string; line: number; deps: string[]; freeNames: string[]; renamed: Array<{ from: string; to: string; line: number }>; sites: number; warnings: string[]; /** slice statements only (for bundles) */ body: string; /** the __site(...) harness calls */ calls: string[]; locals: number }

export const LUA_COMPAT = String.raw`-- ---- compat (only fills what the host lacks: Lua 5.1 / 5.2 / 5.3+ / Luau) ----
unpack = unpack or table.unpack
loadstring = loadstring or load
if not bit32 then -- pure-arithmetic bit32 for hosts without it
  local M = 4294967296
  local function n32(x) return math.floor(x) % M end
  local function op(a, b, f) a, b = n32(a), n32(b) local r, p = 0, 1 for _ = 1, 32 do local x, y = a % 2, b % 2 if f(x, y) then r = r + p end a, b, p = (a - x) / 2, (b - y) / 2, p * 2 end return r end
  local function fold(f, init) return function(...) local r = init for i = 1, select('#', ...) do r = op(r, (select(i, ...)), f) end return r end end
  bit32 = {}
  bit32.band = fold(function(x, y) return x == 1 and y == 1 end, M - 1)
  bit32.bor = fold(function(x, y) return x == 1 or y == 1 end, 0)
  bit32.bxor = fold(function(x, y) return x ~= y end, 0)
  bit32.btest = function(...) return bit32.band(...) ~= 0 end
  bit32.bnot = function(x) return M - 1 - n32(x) end
  bit32.lshift = function(x, n) if n < 0 then return bit32.rshift(x, -n) end if n >= 32 then return 0 end return n32(n32(x) * 2 ^ n) end
  bit32.rshift = function(x, n) if n < 0 then return bit32.lshift(x, -n) end if n >= 32 then return 0 end return math.floor(n32(x) / 2 ^ n) end
  bit32.arshift = function(x, n) x = n32(x) if n <= 0 then return bit32.lshift(x, -n) end if n >= 32 then return x >= 2 ^ 31 and M - 1 or 0 end local r = math.floor(x / 2 ^ n) if x >= 2 ^ 31 then r = r + (M - 2 ^ (32 - n)) end return r end
  bit32.lrotate = function(x, n) n = n % 32 return n32(bit32.lshift(x, n) + bit32.rshift(x, 32 - n)) end
  bit32.rrotate = function(x, n) return bit32.lrotate(x, (-n) % 32) end
  bit32.extract = function(x, f, w) w = w or 1 return bit32.band(bit32.rshift(x, f), 2 ^ w - 1) end
  bit32.replace = function(x, v, f, w) w = w or 1 local m = 2 ^ w - 1 return bit32.bor(bit32.band(x, bit32.bnot(bit32.lshift(m, f))), bit32.lshift(bit32.band(v, m), f)) end
  bit32.countlz = function(x) x = n32(x) local c = 0 for i = 31, 0, -1 do if x >= 2 ^ i then return c end c = c + 1 end return 32 end
  bit32.countrz = function(x) x = n32(x) if x == 0 then return 32 end local c = 0 while x % 2 == 0 do x = x / 2 c = c + 1 end return c end
  bit32.byteswap = function(x) x = n32(x) local a, b, c, d = x % 256, math.floor(x / 256) % 256, math.floor(x / 65536) % 256, math.floor(x / 16777216) return ((a * 256 + b) * 256 + c) * 256 + d end
end
`;

export const LUA_HARNESS = String.raw`-- ---- harness: one JSON object {"L<line>:<col>": value}; non-text strings as {"$bytes": hex} ----
local __NULL, __sites, __keys = {}, {}, {}
local function __json(v, seen)
  local t = type(v)
  if v == __NULL or t == 'nil' then return 'null' end
  if t == 'boolean' then return v and 'true' or 'false' end
  if t == 'number' then
    if v ~= v or v == math.huge or v == -math.huge then return 'null' end
    if v == math.floor(v) and v >= -2 ^ 53 and v <= 2 ^ 53 then return string.format('%.0f', v) end
    return string.format('%.17g', v)
  end
  if t == 'string' then
    if v:find('[^\9\10\13\32-\126]') then return '{"$bytes":"' .. (v:gsub('.', function(c) return string.format('%02x', c:byte()) end)) .. '"}' end
    return '"' .. (v:gsub('[%c"\\]', function(c) return ({ ['"'] = '\\"', ['\\'] = '\\\\', ['\n'] = '\\n', ['\r'] = '\\r', ['\t'] = '\\t' })[c] or string.format('\\u%04x', c:byte()) end)) .. '"'
  end
  if t == 'table' then
    seen = seen or {}
    if seen[v] then return '"<cycle>"' end
    seen[v] = true
    local n, count, parts = #v, 0, {}
    for _ in pairs(v) do count = count + 1 end
    local arr = n > 0 and count == n
    if arr then for i = 1, n do if v[i] == nil then arr = false break end end end
    if arr then for i = 1, n do parts[i] = __json(v[i], seen) end
    else for k, x in pairs(v) do parts[#parts + 1] = __json(type(k) == 'table' and '<table>' or tostring(k)) .. ':' .. __json(x, seen) end end
    seen[v] = nil
    return arr and '[' .. table.concat(parts, ',') .. ']' or '{' .. table.concat(parts, ',') .. '}'
  end
  return '"<' .. t .. '>"'
end
local function __pack(...) return { n = select('#', ...), ... } end
local function __site(keys, f) -- one failing call must not hide the others
  local r, v = __pack(pcall(f))
  if not r[1] then v = { ['$error'] = tostring(r[2]) }
  elseif r.n <= 1 then v = __NULL
  elseif r.n == 2 then v = r[2] == nil and __NULL or r[2]
  else v = { ['$multi'] = {} } for i = 2, r.n do v['$multi'][i - 1] = r[i] == nil and __NULL or r[i] end end
  for _, k in ipairs(keys) do if __sites[k] == nil then __keys[#__keys + 1] = k end __sites[k] = v end
end
`;

export const LUA_OUTPUT = String.raw`local __parts = {}
for i, k in ipairs(__keys) do __parts[i] = __json(k) .. ': ' .. __json(__sites[k]) end
local __out = '{\n ' .. table.concat(__parts, ',\n ') .. '\n}'
local __path = arg and arg[1]
if __path and io and io.open then
  local f = assert(io.open(__path, 'w')) f:write(__out) f:close()
  print('saved ' .. #__keys .. ' call-site results to ' .. __path)
else
  print(__out)
end
`;

const ident = (s: string) => s.replace(/[^A-Za-z0-9_]+/g, '_').replace(/^(\d)/, '_$1') || 'fn';
const luaStr = (s: string) => JSON.stringify(s);

/** Extract one function (name | line inside it) + its static dependency closure as runnable Lua. */
export function functionToLua(src: string, query: string | number, opts: PyOptions = {}): LuaSliceResult | null {
  const cl = sliceClosure(src, query, opts);
  if (!cl) return null;
  const { em, site, fnSites, values, gValues, gFns, populate, callSites, totalSites, skippedSites } = cl;
  const sc = em.sc;
  const warnings: string[] = [];
  // ---- unique, global-safe names for every binding that becomes top level in the slice ----
  const tops: Binding[] = [];
  const addTop = (b?: Binding) => { if (b && !tops.includes(b)) tops.push(b); };
  fnSites.forEach(s => addTop(s.binding));
  values.forEach(v => addTop(v.b));
  tops.sort((a, b) => a.line - b.line);
  const taken = new Set<string>(['__NULL', '__sites', '__keys', '__json', '__pack', '__site', '__parts', '__out', '__path']); const renamed: LuaSliceResult['renamed'] = [];
  const globalsUsed = new Set(sc.globals.keys());
  for (const b of tops) {
    let n = b.name;
    if (taken.has(n) || (globalsUsed.has(n) && b.kind !== 'global')) {
      let i = 2; while (taken.has(`${b.name}_${i}`) || sc.allNames.has(`${b.name}_${i}`)) i++;
      n = `${b.name}_${i}`;
    }
    taken.add(n);
    if (n !== b.name) { renamed.push({ from: b.name, to: n, line: b.line }); renameBinding(b, n); }
  }
  const fresh = (base: string) => { let n = ident(base), i = 2; const b0 = n; while (taken.has(n) || sc.allNames.has(n)) n = `${b0}_${i++}`; taken.add(n); return n; };
  // ---- entries in source order (lexical order of the original keeps every upvalue reference valid) ----
  const entries: Array<{ line: number; ord: number; text: string }> = [];
  let ord = 0;
  const add = (line: number, text: string) => entries.push({ line, ord: ord++, text });
  const P = (n: A.Stat | A.Expr) => print(n).replace(/\n+$/, '');
  const declared = new Set<Binding>();
  const declare = (b: Binding) => { if (declared.has(b)) return; declared.add(b); add(b.line, `local ${b.name} -- L${b.line}`); };
  const fnName = new Map<FnSite, string>();
  const deps: string[] = [];
  for (const s of fnSites) {
    const st = s.stat as any;
    let text: string; let nm: string;
    if (st && st.type === 'LocalFunctionStat' && st.func === s.f) { text = P(st); nm = st.name; if (s.binding) declared.add(s.binding); }
    else if (st && st.type === 'LocalStat' && st.init?.[0] === s.f && st.names.length === 1) { text = `local ${st.names[0]} = ${P(s.f)}`; nm = st.names[0]; if (s.binding) declared.add(s.binding); }
    else if (st && st.type === 'FunctionStat' && st.func === s.f && st.target.type === 'NameExpr') {
      nm = st.target.name;
      if (s.binding && s.binding.kind !== 'global') declare(s.binding);
      text = P(st);
    } else {
      nm = fresh(s.name === '<anonymous>' ? 'fn_L' + s.line : s.name);
      text = `local ${nm} = ${P(s.f)}`;
      if (s !== site) warnings.push(`helper at L${s.line} has no local name — emitted as ${nm}; calls to it through other expressions are kept as in the original`);
    }
    fnName.set(s, nm);
    if (s !== site) deps.push(nm);
    const gf = gFns.find(x => x.site === s);
    add(s.line, `-- L${s.line}${s === site ? '  ◀ TARGET' : ''}${gf ? ' (global function)' : ''}\n${text}`);
  }
  const freeNames: string[] = [];
  for (const { b, init } of values) {
    if (init && b.init) add(b.line, `local ${b.name} = ${P(init)} -- L${b.line}${b.writes ? ` (initial value; reassigned ${b.writes}x)` : ''}`);
    else if (init) { declare(b); add(init.loc?.line ?? b.line, `${b.name} = ${P(init)} -- L${init.loc?.line ?? b.line} (assigned once after its declaration)`); }
    else { freeNames.push(b.name); add(b.line, `local ${b.name} = nil -- TODO: upvalue \`${b.name}\` (L${b.line}, written ${b.writes}x) — set it before the calls`); declared.add(b); }
  }
  for (const g of gValues) add(g.line, `${g.name} = ${P(g.init)} -- L${g.line} global, assigned once`);
  for (const st of populate) add(st.loc?.line ?? 0, `-- L${st.loc?.line ?? '?'}: fills a table used above\n${P(st)}`);
  entries.sort((a, b) => a.line - b.line || a.ord - b.ord);
  const target = fnName.get(site) ?? 'target';
  const out: string[] = [];
  out.push(`-- PRISM Lua slice: ${target} (L${site.line})${deps.length ? ` + ${deps.length} helper(s)` : ''}${values.length ? ` + ${values.length} upvalue(s)` : ''} — the ORIGINAL code, extracted statically.`,
    `-- Run it yourself (PRISM never executes scripts):  lua5.1 slice.lua out.json   |   luau slice.lua > out.json`,
    `-- then: inline_values {values_path:"out.json"} puts every decoded value back into the script (or open it in Python → Results → Lua).`);
  if (renamed.length) out.push(`-- renamed to avoid clashes in one scope: ${renamed.map(r => `${r.from}→${r.to} (L${r.line})`).join(', ')}`);
  if (freeNames.length) out.push(`-- free upvalues without a static value: ${freeNames.join(', ')} (calls that need them report $error)`);
  out.push('');
  if (opts.prelude !== false) out.push(LUA_COMPAT);
  out.push('-- ---- slice (source order) ----');
  const body = entries.map(e => e.text + '\n').join('\n');
  out.push(body);
  const nSites = callSites.reduce((n, c) => n + c.keys.length, 0);
  const calls = callSites.length ? [`-- ${nSites} of ${totalSites} call site(s) of ${target} have statically known arguments (${callSites.length} distinct argument lists${skippedSites ? `, ${skippedSites} more skipped — raise max_calls` : ''})`,
    ...callSites.map(c => `__site({${c.keys.map(luaStr).join(', ')}}, function() return ${target}(${c.call.args.map(a => P(a)).join(', ')}) end)`)] : [];
  if (callSites.length) out.push(LUA_HARNESS, ...calls, '', LUA_OUTPUT);
  else out.push(`-- no call site with static arguments found — call it yourself, e.g. print(${target}(...))`);
  const locals = entries.filter(e => /^(-- [^\n]*\n)?local /.test(e.text)).length;
  if (locals > 190) warnings.push(`${locals} top-level locals — Lua allows 200 active locals per function; if the host complains, split the slice`);
  return { code: out.join('\n'), name: target, line: site.line, deps, freeNames, renamed, sites: nSites, warnings, body, calls, locals };
}
