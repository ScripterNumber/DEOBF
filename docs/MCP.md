# PRISM MCP

Один реестр инструментов обслуживает веб-интерфейс, HTTP API (`GET /api/tools`, `POST /api/tool/<name>` с JSON-аргументами) и MCP. Всё статическое.

## Подключение

| Транспорт | Команда / адрес |
|---|---|
| HTTP вместе с UI | `npm start` → `http://127.0.0.1:7777/mcp` |
| отдельный HTTP | `node --import tsx apps/mcp/src/server.ts --http 7778` → `http://127.0.0.1:7778/mcp` |
| stdio | `node --import tsx apps/mcp/src/server.ts [--workspace DIR] [--luau DIR]` |

Workspace общий: скрипты, opcode maps и outputs, созданные ИИ, сразу видны в UI (вкладка Workspace) и наоборот.

## Ввод / вывод

- Любой инструмент анализа принимает ровно одно из: `script_id` (workspace), `path` (файл на сервере), `source` (текст).
- По умолчанию — читаемый копируемый текст; `format:"json"` — структурированные данные.
- Длинный вывод режется по `max_chars` (60000); `save_as:"name.txt"` сохраняет полный результат в outputs.
- `save_script_as` у преобразующих инструментов сохраняет новый скрипт с родословной.

## Ресурсы

`prism://guide` · `prism://tools` (JSON-схемы) · `prism://workspace` · `prism://scripts/{id}` · `prism://outputs/{name}` ·
`prism://opmaps/{name}` · `prism://docs/static-techniques`

## Промпты-сценарии

`deobfuscate_script` · `recover_opcodes` · `extract_constants` · `port_to_python` · `unpack_vm` · `assess_behavior`

## Инструменты (46)

| Категория | Инструменты |
|---|---|
| workspace | `prism_guide`, `workspace_list`, `workspace_add_script`, `workspace_get_script`, `workspace_note`, `workspace_delete`, `workspace_read_output`, `workspace_save_output` |
| analysis | `auto_triage` (всё за один вызов), `analyze`, `fingerprint`, `call_graph` (text/json/dot/mermaid), `list_functions`, `behavior_report` (IOC), `tokenize` |
| deobfuscation | `deobfuscate`, `simplify_expression`, `rename_symbols`, `inline_values` |
| search | `get_lines`, `find_text`, `pattern_search` (AST-шаблоны `$X`, `$$$`), `xrefs`, `get_function`, `constants`, `strings` |
| vm | `auto_lift` (весь путь за один вызов: чистка → лифт → читаемый вид → оценка → отчёт), `vm_lift`, `vm_boot_dump`, `vm_readable` (вложенные замыкания, имена апвалуе), `vm_protos`, `lift_report` (оценка 0–100), `vm_detect`, `vm_anatomy` (вход/выходы/главные чанки), `opcode_map`, `opmap_get`, `opmap_set`, `vm_disasm`, `chunk_disasm` |
| bytecode | `bytecode_disasm` (Luau v3–v14, Roblox op×227, Lua 5.1), `find_embedded_bytecode` |
| luau (нативные) | `luau_compile`, `luau_analyze`, `luau_ast` |
| blob | `blob_transform`, `blob_info`, `blob_auto`, `blob_xor` |
| transpile | `python_transpile`, `lua_slice`, `decode_bundle`, `lua_literal_to_json` |

## Типовой сценарий для ИИ

```
auto_lift {path}                       → всё сразу: чистая копия, лифт VM, читаемый вид, прото/апвалуе/константы, оценка, отчёт
workspace_add_script {path}            → script_id
auto_triage {script_id}                → чистая копия, декодеры, VM-анатомия, opcode map, байткод, IOC
decode_bundle {script_id:<clean>}      → программа; пользователь запускает → out.json
inline_values {script_id:<clean>, values_path:"out.json", save_script_as:"x.inlined.lua"}
deobfuscate {script_id:<inlined>}      → свёртка того, что стало константой
behavior_report {script_id:<inlined>}  → что делает скрипт
vm_anatomy → python_transpile {function:<десериализатор>} → пользователь запускает → chunk_disasm {chunk_path, script_id}
```
