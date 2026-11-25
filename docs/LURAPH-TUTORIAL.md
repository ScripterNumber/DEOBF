# How Luraph 14.7 (TEST-PRISM3) was deobfuscated with PRISM, and the recommended order of work

This is universal: none of the steps depends on this sample. The sample is only an example.

## 0. Environment
- `npm install` (offline: link tsx/typescript/zod into node_modules; `@prism/core` and `@prism/tools` are symlinks to packages/*).
- Luau: `npm run fetch-luau` or set `PRISM_LUAU=/path/luau` (a file or the folder that contains it). Python 3 is needed for boot dumps.
- No Luau? `luau_run` falls back to Lua 5.4 (`lua5.4` on PATH, `PRISM_LUA54`, or the tiny runner in `tools/lua54`, auto-built from `runner.c` when gcc + liblua5.4 exist) through a line-preserving Luau shim: `continue` -> `goto`, generalized `for k, v in t`, `bit32`, `table.create/find/clear/clone`, `math.round/clamp/sign`, `string.split`, Luau-style number printing, and big integer literals as doubles so hashes/LCGs round exactly like Luau. QA only - the lift itself is never executed during deobfuscation. Force an engine with `engine: "luau" | "lua54"`.
- A run that crashes or prints nothing is reported as `NOT VERIFIED`, never as `OUTPUT IDENTICAL`.
- Plain Luau will not run the obfuscated file on its own: Luraph expects the Roblox environment (e.g. `X.new`). That is normal; the lift does not need it.

## 1. One command for layer 1
`tsx scratch/auto.ts file.lua outdir` (the auto_lift tool) runs deobfuscate → vm_detect → vm_lift → lift_report → vm_protos → constants → strings → behavior_report.
The result is the loader/anti-tamper layer: dozens of protos with a score around 96/100.

## 2. Luraph structure (what the reports show)
- Payload is a long string `[=[...]=]`, decoded with ASCII85 LE (decoder `jX`) and read with Luau `buffer`.
- Dispatch table: 256 handlers (`rX`/`_X`); instruction reader `mX`, PC += 2; opcode = byte[1] >> 3.
- Constants are LEB128-encoded; protos come in two formats (4-byte and 2-byte instructions).
- The interpreter runs inside pcall; the closure factory sits in a helper slot (E[57]); bytecode patches itself (self-modifying slots).
- **Two stages**: the stage-1 VM decrypts a second chunk out of the same buffer, and that chunk is the real program.

## 3. Stage 2 (the real program): one call, `vm_chain`
`vm_chain {script_id:<clean script>, compare_path:"original.lua"}`. auto_lift runs it automatically after the stage-1 lift (`chain:"off"` skips it).
1. It takes the stage-1 boot program `outputs/<name>.clean.boot.py`, written by vm_boot_dump / vm_lift. If it is missing, it is generated.
2. It builds a chain program with `tools/chain/mkchain.py` (boot program + chain runtime + lazy-constant resolver) and lets stage 1 run.
3. It finds the payload buffer and its read cursor, scans offsets with every chunk reader, and keeps the one whose result has the shape of the stage-1 chunk.
4. It resolves the lazy constants (see 3a) and writes `outputs/<name>.stage2.json`, plus `.report.json` and `.chain.log`.
5. It lifts the dump (vm_lift), audits it (lift_audit) and runs it in Luau (luau_run, with a diff against compare_path).

By hand: `python3 tools/chain/mkchain.py <boot.py> chain.py && PRISM_CHAIN_OUT=stage2.json python3 chain.py`, then `tsx scratch/lift_dump.ts <clean script_id> stage2.json out.txt name.lua`.

### 3a. Lazy constants (why the first stage-2 lift was full of `x[nil]` / `nil ..`)
- Luraph does not keep stage-2 constants in the constant arrays.
  - Each constant is a pending record `{value, type, proto, pc, field, ...}` in a map behind an `__index` metamethod.
  - The operand array holds a handle (the map key) in a paired field.
  - The first time an instruction reads the constant, the metamethod decodes the value, writes it to `proto[field][pc]`, and clears the handle in the paired field.
- Encoding:
  - Strings are encrypted with a key stream `key = (a*key + c) % 256`, where the first byte is the seed, plus a constant output xor.
  - Booleans and numbers are stored negated.
- So a static dump taken before the program runs has EMPTY constant arrays, and every constant reads as nil.
- The resolver (`tools/chain/lazy_rt.py`) fixes this before the dump is written:
  - it finds the pending map by structure: a map whose values are records `[value, 'string'|'number'|'boolean', table, ...]`;
  - it recovers `a` and `c` with a printable-text search, and the xor with a text-alphabet search;
  - it votes the paired handle fields;
  - it writes every constant into its slot.
- vm_chain prints the detected config and a sample of decoded strings. To override it: `lazy:'{"table":...,"pending":...,"a":...,"c":...,"x":...,"pair":{...}}'`.
- TEST-PRISM3 values:
  - pending map E.7.4; a=65, c=197; xor=81 (the `bit32.bxor(key, 81)` from the stage-1 S-box setup);
  - pairs {10→6, 3→2, 5→1};
  - 251 records → 567 slots (133 strings, 118 numbers); confidence 99.7%.

## 4. Getting to runnable Luau (the main goal)
1. `lift_audit {script_id}` shows two kinds of findings:
   - **BREAK**: `x[nil]`, `nil ..`, `nil(`, runtime-patched slots. These are lost constants.
     - First check the vm_chain result line `lazy constants: N records`. If it is missing, or the dump's constant arrays are empty, the lazy resolver failed; fix it, not the lifter.
     - Only then put the literal back by hand from `vm_protos` / `constants` / the dump K list of that proto, in the same position.
   - **noise**: state machine, frame tables, `h[N]`, `table.create`, `t["k"]`, `not not`, PROTOS makers. These only affect readability.
2. `luau_run {script_id, append:"PROTOS[1](false)()", compare_path: original.lua}` gives the first real error with its line, plus an output diff when you have a reference.
3. Repeat: fix → luau_run, until the diff reaches N/N.

## 5. Manual readability (in this order)
1. The state machine: each `if W < N` leaf is one basic block, and `W = M` is an edge. Draw the graph and rebuild if/while from it.
2. A frame table `{[5]=L,[1]=M,...}` … `L = L[5]` is the prologue/epilogue of a for loop; the saved registers are its counters.
3. `h[N]` → locals by live range; `PROTOS[n](A)` → `local function` at the creation site (box rN = a shared upvalue).
4. `table.create` + stores → `{}`; `t["x"]` → `t.x`; drop `not not` inside conditions.

## 6. What works best
- Check the output after every step (luau_run + compare). Without a reference, compare against the previous version of the lift.
- Rank by BREAK first, then noise. lift_audit gives a score; track that it goes up.
- If the state machine does not unflatten, the problem is the CFG (an irreducible cycle). Look at the notes in vm_lift and do not edit manually until the BREAK lines are fixed.
- Do not hardcode: fix the pass, not the sample.
- When a lift is full of nil, look at the dump first (empty constant arrays mean lazy constants), and only then at the lifter. That is how the stage-2 nils were found: the lifter was right, the dump was taken before the constants existed.

## Known status (TEST-PRISM3)
- Stage 1 (loader + anti-tamper): lifted, 96/100.
- Stage 2 (the program): constants are restored automatically. The lift is 790 lines, all 3 protos are structured, there are **0 run-time breakers**, and the Luau output is **104/104 identical** to the original.
- Only readability is left (lift_audit noise): temp names `h_N`, register-table reads `h[N]`, for-loop frame tables, `table.create` + stores, `t["k"]`, `not not`, and the PROTOS makers.
