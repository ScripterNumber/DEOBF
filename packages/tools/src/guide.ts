// Shared workflow guide: MCP server instructions, the prism_guide tool, MCP prompts and the web Help panel.
export const GUIDE = `AFTER ANY LIFT: lift_audit {script_id} (BREAK = lost constants / run-time slots to fix, noise = readability leftovers, with line numbers) then luau_run {script_id, append, compare_path} for the real first error + output diff. MULTI-STAGE LOADERS (stage 1 only decodes the next chunk and runs it: Luraph and co): vm_chain {script_id:<clean script>, compare_path} dumps the next stage with its lazy constants resolved (pending-record maps + key-stream ciphers, auto-detected), lifts, audits and runs it; auto_lift does this automatically. A lift full of x[nil] / nil .. means unresolved constants in the DUMP, not a lifter bug. Full walkthrough: docs/LURAPH-TUTORIAL.md

PRISM — static reverse-engineering toolkit for obfuscated Lua 5.1 / Luau (Roblox) scripts.
STATIC ONLY: user scripts are never executed. Works for any obfuscator (generic passes + heuristics, nothing hardcoded per family).

INPUT: every analysis tool accepts exactly one of script_id (stored in the workspace), path (file on the server) or source (inline text).
OUTPUT: plain copyable text by default; format:"json" (where offered) returns structured data. Long output is cut at max_chars (default 60000) —
raise max_chars or pass save_as:"name.txt" to keep the full result in workspace outputs/ (read back with workspace_read_output).
Derived scripts (deobfuscate/rename_symbols/opcode_map save_script_as) keep lineage; workspace_list shows the tree.

RECOMMENDED WORKFLOW
0. One call: auto_lift {path|script_id} — the whole static pipeline: clean copy → VM lift (when an interpreter VM is recognised) →
              readable view → lift_report scorecard → protos / upvalues / constants / strings / behaviour; one report with every
              artifact, how to read it and what is left. lift_report {script_id} after any change shows progress as one score.
1. Load:      workspace_add_script {path|source, name}  → script_id
2. Overview:  auto_triage {script_id}  (analyze + deobfuscate copy + decoder/key candidates + VM anatomy + opcode map + bytecode + IOCs)
              or individually: analyze, fingerprint, vm_detect, list_functions, call_graph (text|json|dot|mermaid)
3. Junk:      deobfuscate {script_id, save_script_as} — constant folding, number/bit32/MBA simplification, opaque predicates,
              dead code, proxy/alias inlining, string decoding, renaming (rename: none|obfuscated|all). simplify_expression for one expression.
4. Unpacker:  constants {section:"decoders"|"keys"|"strings"|"numbers"|"arrays"} → get_function {query:<name|line>} → xrefs {name, line}
              → python_transpile {function} to port the constant/bytecode decoder to Python (keys usually derive from data inside the file).
              The port is a runnable program: its __main__ evaluates every call site with static arguments and prints ONE JSON object
              {"L<line>:<col>": value}. The user runs \`python3 file.py out.json\` (PRISM never executes scripts itself), then
              inline_values {script_id, values_path|values} puts the decoded constants back into the Lua (deobfuscate again to fold).
              decode_bundle {script_id} does it for ALL decoders at once: one program (python | lua), one JSON for every call site.
              lua_slice {function} is the exact alternative: the ORIGINAL Lua of the function + its dependency closure + the same
              JSON harness (\`luau slice.lua > out.json\`) — use it when the Python port hits an exotic construct, or to cross-check.
              Blobs: strings, blob_info, blob_auto (guess the layer stack), blob_transform (base64/hex/xor/rc4/LZW/zlib/… pipeline),
              blob_xor (known-plaintext / repeating-key recovery).
5. VM:        ONE CLICK: vm_lift {script_id} — cleans if needed, decoded chunk via vm_boot_dump (the loader ported to Python runs on
              its own payload and stops at the VM closure factory — no format reversing), helper library + wrapper slots inlined,
              devirtualised + structured Lua for every proto, saved as a new script; then vm_protos {lifted id} — per proto:
              constants, upvalues (what the creator puts in each), nested protos, constant pools (the luac -l -l view). Step by step:
              vm_anatomy {script_id} — boot chain (payload → deserializer → wrapper → interpreter → exits → entry) + main chunks
              opcode_map {script_id, save_opmap_as} (dispatch trees → handler classes → guessed mnemonics) → opmap_get / opmap_set to fix names
              → vm_disasm {instructions, opmap} on decoded instruction arrays (lua_literal_to_json converts Lua tables to JSON).
              Whole chunk: python_transpile {function:<deserializer line from vm_anatomy>} → user runs it → chunk_disasm {chunk_path|chunk,
              script_id} infers the proto layout (instructions / constants / nested protos), disassembles every proto, lists all strings.
6. Bytecode:  find_embedded_bytecode → bytecode_disasm (Luau v3–v14, Roblox op*227 encoding, Lua 5.1; rich or reference listing + lifted pseudo-Lua)
              luau_compile (reference compiler: prism|text|remarks|constants|summary|codegen…) to learn what real handlers compile to;
              luau_analyze (type/lint), luau_ast (JSON AST).
7. Behaviour: behavior_report {script_id | strings | chunk_path} — network / webhooks / remote loaders / file system / hooks /
              anti-debug / remotes / fingerprinting, every URL classified. Best on the inlined copy or a dumped chunk (decoded strings).
8. Navigate:  find_text (literal/regex), pattern_search (AST patterns), get_lines, tokenize, xrefs.
9. Record:    rename_symbols {renames:[{name,to,line?}], save_script_as} (scope-aware, formatting preserved), workspace_note, workspace_save_output.

TIPS
- Run deobfuscate first; most other tools give far better results on the cleaned script.
- Decoder candidates scored "constant-accessor" are pool lookups (fn(-46645)); "string-decoder"/"deserializer" are the unpackers to port.
- Opcode numbers in CFF/if-tree VMs are ranges ([lo..hi]); the opmap keys are the leaf ids shown by opcode_map.
- Keep everything in the workspace so a later session (or the web UI at the same server) sees the same scripts, opmaps and outputs.`;

export const PROMPTS: Array<{ name: string; title: string; description: string; args: Record<string, string>; render: (a: Record<string, string | undefined>) => string }> = [
  {
    name: 'deobfuscate_script', title: 'Deobfuscate a script end-to-end',
    description: 'Full static deobfuscation workflow driven by PRISM tools.',
    args: { script: 'script_id from the workspace or a file path' },
    render: a => `Deobfuscate the Lua/Luau script "${a.script ?? '<script>'}" using only PRISM's static tools (never execute it).
1. If it is a path, workspace_add_script {path}. Then auto_lift on the script_id (the whole pipeline in one call; auto_triage for a quick overview).
2. deobfuscate {save_script_as} and work on the cleaned copy from now on.
3. Identify the constant/string decoder and bytecode deserializer (constants section:"decoders", get_function, xrefs, call_graph).
4. Port them with python_transpile and decode the constant pool / bytecode statically (blob_* tools for encoded blobs).
5. If a VM is present: opcode_map {save_opmap_as}, fix mnemonics with opmap_set, disassemble with vm_disasm / bytecode_disasm.
6. Rename what you understood (rename_symbols), record findings (workspace_note) and finish with a short report: family, layers, keys, decoded constants, opcode map, remaining unknowns.`,
  },
  {
    name: 'recover_opcodes', title: 'Recover a custom VM opcode map',
    description: 'Map dispatcher handlers of a custom Lua VM to mnemonics.',
    args: { script: 'script_id (preferably the cleaned copy)', opmap: 'name to store the opcode map under' },
    render: a => `Recover the custom VM opcode map of "${a.script ?? '<script>'}" statically.
1. vm_detect, then opcode_map {script_id:"${a.script ?? ''}", clean:false, code:true, save_opmap_as:"${a.opmap ?? 'vm'}"}.
2. For every low-confidence handler read its code (get_lines / get_function) and compare with what luau_compile emits for the equivalent Lua.
3. Correct the names with opmap_set; group duplicates (same shape hash = same semantics).
4. Decode an instruction array (constants section:"arrays" or lua_literal_to_json) and verify with vm_disasm {opmap:"${a.opmap ?? 'vm'}"}.
5. Report the final table: opcode → mnemonic → operand layout → confidence.`,
  },
  {
    name: 'extract_constants', title: 'Extract the constant pool',
    description: 'Find and statically decode encrypted strings/constants.',
    args: { script: 'script_id or path' },
    render: a => `Extract every constant of "${a.script ?? '<script>'}" without executing it.
1. deobfuscate (save_script_as) → constants {section:"decoders"} and {section:"keys"} on the cleaned copy.
2. get_function on the best decoder; xrefs on its name to see every call site and literal argument.
3. Several decoders? decode_bundle {script_id} makes ONE program for all of them (lang:"lua" = exact original slices). One decoder: python_transpile {function} (or lua_slice) → the program's __main__ already evaluates every static call site; ask the user to run \`python3 file.py out.json\` (never execute it yourself) or decode simple layers directly with blob_auto / blob_transform / blob_xor.
4. inline_values {script_id, values|values_path, save_script_as} puts the decoded values back into the script; deobfuscate the result to fold what is now constant.
5. Output a table: call site → encoded literal → decoded value, and save it with workspace_save_output.`,
  },
  {
    name: 'port_to_python', title: 'Port a decoder to Python',
    description: 'Translate a Lua decoder/unpacker function into standalone Python.',
    args: { script: 'script_id or path', function: 'function name or line number' },
    render: a => `Port the function "${a.function ?? '<fn>'}" of "${a.script ?? '<script>'}" to standalone Python 3.
1. get_function {query:"${a.function ?? ''}"} to read it; xrefs for the helpers and upvalues it uses.
2. python_transpile {function:"${a.function ?? ''}"} — then fix anything flagged (1-based indexing, integer division, bit32 semantics, string bytes).
3. The generated program already includes the helpers, static upvalues/tables it needs and a __main__ that calls the function at its static call sites, printing {"L<line>:<col>": result} as JSON (lua_dump).
4. Explain how to run it (\`python3 file.py out.json\`) and what to do with the result: inline_values (constants back into Lua) or chunk_disasm (a dumped VM chunk).`,
  },
  {
    name: 'unpack_vm', title: 'Unpack a VM-protected script',
    description: 'Boot chain → deserializer port → decoded chunk → full disassembly, statically.',
    args: { script: 'script_id or path' },
    render: a => `Unpack the VM of "${a.script ?? '<script>'}" statically (never execute it).
1. workspace_add_script (if a path) → deobfuscate {save_script_as} → vm_anatomy on the cleaned copy: payload, deserializer, closure factory, interpreter, exits, entry, main chunks.
2. vm_boot_dump {script_id:<cleaned id>} (or straight vm_lift) — the loader ported to Python decodes its own payload and stops at the VM closure factory, which writes the chunk; needs python3 on the PRISM host (run:false → the program for the user). Fallback: python_transpile {function:<deserializer line>} — the program decodes the payload and lua_dump()s the chunk; ask the user to run \`python3 file.py chunk.json\` and give you the JSON (or its path on the PRISM host).
3. chunk_disasm {chunk_path|chunk, script_id:<cleaned id>} — layout is inferred, the opcode map + operand roles come from the interpreter; check the unmapped opcodes and the STRINGS list (real constants).
4. Fix mnemonics: opcode_map {code:true, save_opmap_as:"vm"} → opmap_set → chunk_disasm {opmap:"vm"} again.
5. Report: layout, protos, opcode table, constants, what the program does.`,
  },
  {
    name: 'assess_behavior', title: 'What does this script do? (IOCs)',
    description: 'Static behaviour / risk assessment: decode strings, then classify network, loaders, webhooks, hooks, file access.',
    args: { script: 'script_id or path' },
    render: a => `Assess what "${a.script ?? '<script>'}" does, statically (never execute it).
1. behavior_report on the original and on the deobfuscated copy (deobfuscate {save_script_as} first) — names and plain strings.
2. Most strings are usually encrypted: constants {section:"decoders"} → python_transpile {function} → the user runs it → inline_values {values_path} → behavior_report on the inlined copy (or behavior_report {chunk_path} on a dumped VM chunk).
3. For every URL: say its kind (webhook, ip lookup, code host, roblox asset) and where it is used (get_lines / xrefs around the line).
4. Verdict: what data is collected, where it is sent, what code is fetched and run, how it protects itself. Quote the evidence lines.`,
  },
];
