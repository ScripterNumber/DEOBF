# PRISM static technique catalog

> Каталог статических техник PRISM (для людей и для ИИ через ресурс `prism://docs/static-techniques`).
> Everything below is generic Lua/Luau semantics — no rule is keyed to a specific obfuscator. Nothing is executed.

## 1. Front end
- **Lexer / parser**: Lua 5.1 + Luau (types, `continue`, compound assignment, `if`-expressions, interpolated strings,
  `0b`/`_` numbers, long brackets) with error recovery; round-trip printer. Latin-1 safe (binary strings survive).
- **Scope analysis**: every binding with reads/writes/captures, used by renaming, slicing, inlining and xrefs.

## 2. Junk removal (`deobfuscate`)
| Pass | What it removes |
|---|---|
| constant folding | arithmetic, string concatenation, `#"lit"`, comparisons, `not`, `and`/`or` on constants |
| bit32 / MBA | `bit32.*` and Luau bit ops on constants; mixed boolean-arithmetic identities over literals (`bor(a,b)+band(a,b)`, `bxor(a,b)+2*band(a,b)` → `a+b` …) |
| string recovery | `string.char(…)`, `("\x41"):rep`, escaped bytes, concat chains → plain literals |
| opaque predicates | branches whose condition folds to a constant; guard folding / merging |
| dead code | unreachable statements, empty blocks, unused locals, write-only assignments |
| alias / proxy inlining | `local f = string.char`, wrapper functions that only forward, constant propagation |
| control flow | `while true do … break end` loops that run once, `do` flattening, switch-loop unrolling |
| renaming | `rename: obfuscated` (only junk-looking names) or `all`; names from usage (`arr1`, `obj1`, `str1`, `num1`, `fn1`, `idx1`…), scope-aware |

## 3. Finding the unpacker
- **constants / decoders**: functions ranked by evidence (byte loops, `% 256`, xor/bit ops, `string.char/byte`, `table.concat`,
  literal-argument call sites). Kinds: `string-decoder`, `constant-accessor` (pool lookup `fn(-46645)`), `deserializer`, `bit-helper`.
- **keys**: strings/numbers used next to xor / byte arithmetic.
- **blobs**: long literals with entropy / alphabet statistics → Blob Lab (`blob_auto` guesses the layer stack).

## 4. Static decoding loop (the user runs the generated program)
1. `python_transpile {function}` — the function + its dependency closure (helpers, upvalues with static initializers,
   globals assigned once, statements that fill its tables, read-only aliases) as Python with a faithful Lua prelude.
   `__main__` evaluates every call site with static arguments (identical argument lists once).
2. `lua_slice {function}` — the same closure as the ORIGINAL Lua (source order, clashing names renamed, compat shims).
3. `decode_bundle` — all decoders in one program (Python namespaces / Lua `do…end` blocks).
4. Output contract: ONE JSON object `{"L<line>:<col>": value}`; non-text strings as `{"$bytes": hex}`, failures `{"$error"}`,
   multiple returns `{"$multi": [...]}`.
5. `inline_values` replaces each call expression at that position with the literal (token-exact, parenthesised where needed),
   then `deobfuscate` folds what became constant.

## 5. VM reverse engineering
- **vm_detect**: dispatch kinds (if-chains / binary if-trees on an opcode variable, table dispatch, CFF state machines),
  trampolines, handler clusters, opcode estimate.
- **vm_anatomy** (VM Map): boot chain by code shape — payload literal → deserializer (byte reader + loops building
  instruction/constant/proto tables) → string decoders → closure factory (function returning a closure over the proto) →
  interpreter (loop + dispatch over `inst[op]`) → exits (returns inside the interpreter loop = RETURN/TAILCALL handlers, or the
  CFF terminator) → entry call;
  **main chunks** = largest functions with their roles.
- **opcode_map**: every dispatch tree → leaves (opcode ranges) → handler bodies → class (MOVE, LOADK, GETTABLE, CALL, JMP,
  EQ/LT/LE, FORPREP/FORLOOP, CLOSURE, VARARG, RETURN …) by data flow on the register array, plus operand roles
  (which `inst[k]` is A/B/C/op). Editable opmaps with `$meta` are stored in the workspace.
- **vm_disasm**: decoded instruction arrays → listing with mnemonics, `R[A] = K[B]` pseudo-code, inline constants.
- **chunk_disasm** (chunk explorer): a dumped chunk (JSON / Lua literal) → auto layout (instruction arrays as tuples,
  records, packed 32-bit words with bit presets, struct-of-arrays), nested protos, constants, op field; full listing,
  strings, histogram, IOC scan.

## 6. Real bytecode
- Luau bytecode v3–v14 (plain or Roblox `op × 227` encoding) and Lua 5.1: reference-quality listing + lifted pseudo-Lua.
- `find_embedded_bytecode` scans literals for `\27Lua` / Luau headers (raw, escaped, base64, hex).
- Native `luau-compile` shows what real handlers compile to (learn the VM by comparison).

## 7. Blob Lab
Pipelines of Lua-escape / base64 (±encode) / hex (±encode) / decimal lists / url / utf8 / strip-ws / slice / xor (key,
rolling, previous-byte) / add / sub / not / nibble-swap / reverse / rc4 / LZW (base36 or bit-packed) / zlib inflate /
raw deflate / gunzip; `blob_auto` searches the layer stack; `blob_xor` recovers keys by known plaintext or repeating-key
analysis.

## 8. Behaviour / IOCs (`behavior_report`)
Identifiers, method names, strings (incl. decoded values and dumped chunks) → categories: network, remote loaders,
executor file system, clipboard, identity/fingerprinting, hooks & metatables, executor introspection, anti-debug,
game remotes, kick/teleport, UI, crypto. URLs classified: discord-webhook, telegram-bot, webhook, ip-lookup, ip-logger,
code-host, discord-invite, roblox, `require(<asset id>)`. Verdict lines summarise the risk.
