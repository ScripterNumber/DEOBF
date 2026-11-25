# PRISM auto_lift — TEST-PRISM3.lua
12 steps in 166.9 s — original test-prism3-df4fbd → clean test-prism3.clean-ca5e0e → lifted test-prism3.lifted-8703f1 → next stage test-prism3.clean.stage2.lifted-3e9a9c
VM: yes — devirtualised — score 96/100

## steps
#   step                                                          tool             ms      status  full output
--  ------------------------------------------------------------  ---------------  ------  ------  -----------------------------------------------
1   clean copy                                                    deobfuscate      750     ok      outputs/TEST-PRISM3.auto.01_deobfuscate.txt
2   VM detection                                                  vm_detect        72      ok      outputs/TEST-PRISM3.auto.02_vm_detect.txt
3   devirtualise (boot dump + every proto)                        vm_lift          55868   ok      outputs/TEST-PRISM3.auto.03_vm_lift.txt
4   next VM stage: the chunk stage 1 decodes — dump, lazy consta…  vm_chain         109979  ok      outputs/TEST-PRISM3.auto.04_vm_chain.txt
5   scorecard                                                     lift_report      97      ok      outputs/TEST-PRISM3.auto.05_lift_report.txt
6   scorecard of the next stage                                   lift_report      13      ok      outputs/TEST-PRISM3.auto.06_lift_report.txt
7   lift audit: run-time breakers + manual-fix list with line nu…  lift_audit       4       ok      outputs/TEST-PRISM3.auto.07_lift_audit.txt
8   protos / functions: constants, upvalues, nested               vm_protos        19      ok      outputs/TEST-PRISM3.auto.08_vm_protos.txt
9   constants                                                     constants        25      ok      outputs/TEST-PRISM3.auto.09_constants.txt
10  strings                                                       strings          13      ok      outputs/TEST-PRISM3.auto.10_strings.txt
11  behaviour / IOCs of the program (next stage)                  behavior_report  32      ok      outputs/TEST-PRISM3.auto.11_behavior_report.txt
12  behaviour / IOCs of stage 1 (the loader)                      behavior_report  14      ok      outputs/TEST-PRISM3.auto.12_behavior_report.txt

## scorecard
# lift_report — TEST-PRISM3.lifted.lua [test-prism3.lifted-8703f1] — protos mode
score: 96/100  (-4 unresolved captures (11/132))
size: 5958 lines, 145242 chars, 76 function literal(s)
structure: 35 proto(s), 34 creation site(s), deepest chain 4
captures: 132 total — 59 box, 49 by-value, 13 pass-through, 11 untraced → 92% resolved
scaffolding globals: table.create, getfenv
untraced captures (11):
  proto 250 @5121 slot 3: PROTOS[260](A)
  proto 250 @5121 slot 4: h_1
  proto 327 @5443 slot 0: string.byte
  proto 327 @5443 slot 1: h_4
  proto 327 @5443 slot 2: h_5
  proto 327 @5451 slot 0: h_7
  proto 327 @5451 slot 1: h_6
  proto 327 @5458 slot 0: h_7
  proto 327 @5458 slot 1: h_5
  proto 327 @5458 slot 2: h_8
  proto 327 @5458 slot 3: h_6
note: residual VM program: PROTOS[n] makers, closures built by PROTOS[m](upvalues)
note: 11 capture(s) still read at run time / untraced — these are the slots to resolve next

## next stage (vm_chain)
chain run: 89.5 s, exit 0 — full log outputs/TEST-PRISM3.clean.chain.log
  payload buffer E[31] 73404 bytes; cursor candidates {'22': 60901}
  cursor slot 22 = 60901 (remaining 12503 bytes)
  chunk-reader candidates (arg #): [2, 3, 4, 5, 12]
  arg 2 scanned 275 offsets in 85.5 s; valid [265] ; failures {'OverflowError': 68, 'MemoryError': 55, 'LuaError': 55, 'timeout': 9}
  next chunk: arg 2 at cursor 61166 (stage-1 end + 265 ) -> {'kind': 'table', 'sim': 1.0, 'end': 73402, 'protos': 3}
  stage-2 dump written to /data/work/ws-auto/outputs/TEST-PRISM3.clean.stage2.json

lazy constants: 251 pending record(s) resolved → 567 constant slot(s) (133 strings, 118 numbers, 0 booleans, 0 other)
  resolver auto-detected: pending map E.7.4, key stream key = (a*key + c) % 256 with a=65 c=197, output xor 81, confidence 99.7%, paired handle fields {"3":2,"5":1,"10":6}
  override: vm_chain {lazy:'{"table":"E","pending":"7.4","a":65,"c":197,"x":81,"pair":{"3":2,"5":1,"10":6}}'}
  samples: "dmg", "insert", "Reference: https://create.roblox.com/docs/luau", "MINI RPG WORLD GENERATOR", " vs ", "]", "sym", "Rexar", "COMBAT SIMULATION:", " at (", "Mage", "Arthas", "Water", "f", "Mountains", " gold)"
dump: outputs/TEST-PRISM3.clean.stage2.json

## lift
lifted 3 proto(s): 790 lines, 21201 chars — saved as script_id "test-prism3.clean.stage2.lifted-3e9a9c"
proto  instrs  blocks  structured  lines
-----  ------  ------  ----------  -----
1      1118    290     yes         678
10     6       3       yes         33
19     36      11      yes         16

## audit
readability 56/100 · 725 code lines · 6 function literal(s) · 0 run-time breaker(s) · 639 readability leftover(s)
kind   check           count  meaning
-----  --------------  -----  ------------------------------------------------------------
noise  frame_save      10     VM loop frame save/restore table ({ [5] = L, [1] = M, ... })
noise  register_table  49     register-table access (h[N]) — register not promoted to a lo…
noise  table_create    10     table.create(n) + indexed stores instead of a constructor
noise  string_key      67     t["name"] instead of t.name
noise  not_not         12     not not x (truthiness coercion from VM TEST ops)
noise  temp_name       486    generated temporary h_N / __aN
noise  protos_table    2      PROTOS[n](upvalues) closure maker instead of a local functio…
noise  getfenv         3      getfenv() environment table — globals read through it

## run (Luau)
entry: PROTOS[1](false)()
exit null; 0 output line(s)
error: Error: spawnSync /data/proj/prism/tools/luau EACCES
compare with TEST-PRISM3-ORIGINAL.lua: 0/0 identical line(s) — OUTPUT IDENTICAL

next:
- read it: workspace_get_script {script_id:"test-prism3.clean.stage2.lifted-3e9a9c"} — the decoded program; lift_audit lists what is left to fix by hand, with line numbers
- raw layout of this stage: chunk_disasm {script_id:"test-prism3.clean-ca5e0e", chunk_output:"TEST-PRISM3.clean.stage2.json"}
- run / diff it: luau_run {script_id:"test-prism3.clean.stage2.lifted-3e9a9c", append:"PROTOS[1](false)()", compare_path:"<original>"}

## scorecard — next stage
# lift_report — TEST-PRISM3.clean.stage2.lifted.lua [test-prism3.clean.stage2.lifted-3e9a9c] — protos mode
score: 100/100
size: 790 lines, 21201 chars, 6 function literal(s)
structure: 3 proto(s), 2 creation site(s), deepest chain 2
captures: 1 total — 1 box, 0 by-value, 0 pass-through, 0 untraced → 100% resolved
note: residual VM program: PROTOS[n] makers, closures built by PROTOS[m](upvalues)

## audit of the final stage (lift_audit)
readability 56/100 · 725 code lines · 6 function literal(s) · 0 run-time breaker(s) · 639 readability leftover(s)

kind   check           count  meaning
-----  --------------  -----  ------------------------------------------------------------
noise  frame_save      10     VM loop frame save/restore table ({ [5] = L, [1] = M, ... })
noise  register_table  49     register-table access (h[N]) — register not promoted to a lo…
noise  table_create    10     table.create(n) + indexed stores instead of a constructor
noise  string_key      67     t["name"] instead of t.name
noise  not_not         12     not not x (truthiness coercion from VM TEST ops)
noise  temp_name       486    generated temporary h_N / __aN
noise  protos_table    2      PROTOS[n](upvalues) closure maker instead of a local functio…
noise  getfenv         3      getfenv() environment table — globals read through it

## frame_save (10) — fix: this is a for-loop prologue/epilogue: the saved regs are the loop counters — rewrite as for i = a, b do
  L116: L = { [5] = nil, [1] = nil, [3] = nil, [4] = nil };
  L151: L = { [5] = L, [1] = M, [3] = T, [4] = i };
  L165: L = { [5] = L, [1] = M, [3] = T, [4] = i };

## lift
# interpreter runs inside a protected call (E[33]()); handler returns are routed through its 1-statement epilogue
# interpreter: fetch t = s[W] @L1406; proto param 'R', fields X=[9] x=[4] j=[2] U=[1] I=[10] o=[3] N=[6] s=[11] y=[5]; closure maker stored in E[57]
# closure factory L1395 function(R, k, K) stored in E[57]; tables it reads: E (202 reads, 27 calls, 0 in the loop); helper table E
# helper table E: 1 helper function slot(s) summarised and inlined — E[25](__a0, __a1, __a2) → table.unpack(__a1, __a2 or 1, __a0 or #__a1) [its alternative implementation for b - X + 1 > 7997 taken as equivalent] (rules that reorder / duplicate arguments only fire on side-effect-free arguments)
# interpreter runs inside a protected call (E[33]()); handler returns are routed through its 1-statement epilogue
# interpreter: fetch t = s[W] @L1406; proto param 'R', fields X=[9] x=[4] j=[2] U=[1] I=[10] o=[3] N=[6] s=[11] y=[5]; closure maker stored in E[57]
# 35 proto(s) in the dump: #1(415) #10(4900) #30(136) #43(36) #54(7) #66(331) #79(104) #90(31) #101(308) #112(94) #124(60) #135(35) #147(88) #158(275) #173(76) #184(49) #194(68) #209(247) #223(371) #237(6) #250(72) #260(101) #276(381) #287(6) #298(61) #308(106) #318(85) #327(73) #336(85) #346(107) #356(76) #366(137) #377(216) #390(157) #400(195)
# helper table E: 37 library function slot(s) resolved
# self-modifying bytecode: 704 written slot(s); 949 patched-slot read(s) resolved statically (4 phase(s)), 54 selected at run time, 254 one-time patch trampoline(s) folded (the patching chain always runs; its stores are idempotent, its scratch registers are dead at the join), 95 unreachable block(s) removed
# 3 self-modifying opcode store(s) removed (the patched opcode has the same meaning)
# helper slots written by the program (not aliased): E[7][4], E[7][1]
# 65 helper-table read(s) replaced by library functions
# patch round 1: 460 written slot(s) of dump records (10 with computed values)
# patch round 2: 570 written slot(s) of dump records (3 with computed values)

## behaviour (top)
BEHAVIOUR / IOC REPORT — TEST-PRISM3.clean.stage2.lifted.lua [test-prism3.clean.stage2.lifted-3e9a9c]  (static: 1,457 identifiers, 247 strings scanned)

VERDICT
- anti-tamper / anti-debug checks (debug.getinfo / traceback / getfenv)

URLS / ASSETS (1)
  [roblox] https://create.roblox.com/docs/luau  (L78)

NOTICE Anti-tamper / anti-debug — 3 hit(s): getfenv
    L66     getfenv            local S, w, m, i = 0, 1, (getfenv());
    L744    getfenv            local S, w, m, i = 0, 1, (getfenv());
    L779    getfenv            local S, w, m, i = 0, 1, (getfenv());

## behaviour of the loader (top)
BEHAVIOUR / IOC REPORT — TEST-PRISM3.lifted.lua [test-prism3.lifted-8703f1]  (static: 10,718 identifiers, 449 strings scanned)

VERDICT
- loader: downloads code (HttpGet / code host URL) and runs it with loadstring — the real payload is remote
- anti-tamper / anti-debug checks (debug.getinfo / traceback / getfenv)

WARN   Network access — 12 hit(s): GetAsync, PostAsync, HttpService, RequestAsync
    L468    GetAsync           h_14[120] = "GetAsync";
    L483    PostAsync          h_14[121] = "PostAsync";
    L507    HttpService        h_14[119] = "HttpService";
    L571    RequestAsync       h_14[122] = "RequestAsync";
    L3036   HttpService        h[101] = "HttpService";
    L3041   HttpService        h[101] = "HttpService";
    L3054   GetAsync           h[101] = "GetAsync";
    L3056   GetAsync           h[100](h[101], "GetAsync");

## how to read
- PROTOS[n] = function(k, K) … end — proto n of the decoded chunk; k is its upvalue array, the inner function is the closure body
- p = PROTOS[n](A) followed by `if A then … A[i] = … end` — closure creation; each A[i] is one captured upvalue:
    box rN — by reference: a shared cell for register N of the creator (read / written through the cell)
    rN — by value (k[i] is the value itself); upvalue N — the creator passes its own upvalue N through
- registers promoted to locals carry the register-table name + _N; registers captured by reference stay as <table>[N]
- K_n — records (tables) of the decoded chunk; the helper table keeps the VM's own name

## next
- read: workspace_get_script {script_id:"test-prism3.lifted-8703f1"} · get_function / xrefs / find_text on it
- name what you understood: rename_symbols {script_id:"test-prism3.lifted-8703f1", renames:[…], save_script_as:"…"} → lift_report again to see the score move
- untraced captures and run-time patched slots (scorecard / vm_lift output) are the next targets
- the program is the NEXT stage test-prism3.clean.stage2.lifted-3e9a9c (stage 1 only decoded and started it) — read it first; run / diff it: luau_run {script_id:"test-prism3.clean.stage2.lifted-3e9a9c", append:"PROTOS[1](false)()", compare_path:"<original>"}