# PRISM static pipeline — NEW_SAMPLE_3_TEST.lua
- 01_add (workspace_add_script): 76 chars, 55 ms
- 02_deob (deobfuscate): 100106 chars, 2817 ms
- 04_vm_detect (vm_detect): 3786 chars, 194 ms
- 05_vm_anatomy (vm_anatomy): 5976 chars, 994 ms
- 06_vm_anatomy_clean (vm_anatomy): 6731 chars, 783 ms
- 07_opcodes (opcode_map): 100103 chars, 431 ms
- 08_protos (vm_protos): 43518 chars, 258 ms
- 09_constants (constants): 10341 chars, 353 ms
- 10_strings (strings): 1961 chars, 313 ms
- 11_behavior (behavior_report): 560 chars, 88 ms
- 12_score (lift_report): 313 chars, 169 ms
- 13_lift (vm_lift): 188 chars, 3440 ms
clean script: new_sample_3_test.clean-edb8a4
source: new_sample_3_test-2c0307

## итог
- clean: NEW_SAMPLE_3_TEST.clean.lua — 8 762 строки, lift_report 100/100, 0 ошибок парсинга.
- readable: NEW_SAMPLE_3_TEST.readable.lua — 8 741 строка, lift_report 100/100, 0 ошибок парсинга.
- ограничение: payload Superflow не дизассемблирован (vm_lift), см. REPORT.md.

