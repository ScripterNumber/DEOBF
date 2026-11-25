# PRISM — статический реверс-инжиниринг обфусцированных Lua / Luau (Roblox) скриптов

**Только статический анализ.** PRISM никогда не запускает пользовательские скрипты. Всё, что «нужно выполнить»
(порт декодера на Python, Lua-срез, пакет декодеров), PRISM только *генерирует* — запускаете вы сами, где хотите.

**Универсальность.** Ни одного правила «под конкретный обфускатор»: все проходы — обобщённая семантика Lua
(свёртка констант, MBA/bit32, непрозрачные предикаты, мёртвый код, алиасы, CFF-машины состояний, деревья диспетчеризации VM,
поиск десериализатора/интерпретатора по форме кода). Образцы Hercules / IronBrew2 / Luraph / MoonSec / Prometheus / luaobf
в `apps/web/public/samples` — только тестовые данные.

Один процесс = веб-интерфейс + HTTP API + MCP-сервер (ИИ может управлять всеми 54 инструментами) + общий workspace.

---

## Быстрый старт

```bash
npm install            # зависимости (Node ≥ 20.10)
npm run fetch-luau     # (опц.) нативные luau-compile / luau-analyze / luau-ast в tools/luau
npm run build          # собрать веб-интерфейс (apps/web/dist)
npm start              # → http://127.0.0.1:7777   (UI + /api + /mcp)
```

Или одной командой: `./start.sh` (Linux/macOS) / `start.bat` (Windows). Параметры:
`--port 7777 --host 127.0.0.1 --workspace DIR --luau DIR` (или `PRISM_PORT`, `PRISM_WORKSPACE`).

Проверки: `npm run typecheck`, `npm test` (лексер/парсер на 18 образцах, round-trip, smoke всех 54 инструментов, MCP),
`npm run test:e2e -- http://127.0.0.1:7777/` (все вкладки UI в headless Chromium, 0 ошибок консоли).

---

## Веб-интерфейс (фиолетовый неон, всё копируется)

Слева — исходник (Input / Cleaned), справа — вкладки. Любой результат: **Copy / Download / JSON**, номера строк кликабельны.

| Группа | Вкладка | Что делает |
|---|---|---|
| Analyze | **Overview** | семейство обфускатора с причинами, метрики, VM, алиасы, **Behaviour / IOCs** (что делает скрипт: сеть, вебхуки, загрузчики, хуки, файлы, все URL) |
| | **Deobfuscate** | очистка мусора: свёртка, MBA, предикаты, мёртвый код, алиасы, строки, переименование; diff |
| | **Call Graph** | граф вызовов (force-layout), Mermaid / DOT |
| | Strings / Tokens | все литералы и токены |
| Reverse | **VM Map** | анатомия VM: payload → десериализатор → декодеры строк → фабрика замыканий → интерпретатор → выходы → точка входа; **главные чанки** |
| | VM | диспетчеризация и CFF |
| | **Opcode Map** | деревья диспетчеризации → хендлеры → угаданные мнемоники, редактирование, экспорт, роли операндов |
| | **Disassembly** | Luau v3–v14 / Lua 5.1 байткод · кастомные VM-инструкции · **VM chunk explorer** (декодированный чанк → протоза, инструкции, константы, IOC) |
| | **Constants** | кандидаты в декодеры/ключи/строки/числа/массивы + **Decode kit** (все декодеры → одна программа) |
| | Search & Xrefs | текст/regex, AST-шаблоны, перекрёстные ссылки |
| Extract | **Python** | порт функции (+зависимости) или всего скрипта; **Lua slice (exact)**; **Results → Lua** (JSON обратно в код) |
| | **Blob Lab** | конвейер Lua-escape/base64/hex/decimal/xor/rc4/LZW/zlib…, авто-подбор слоёв, восстановление XOR-ключа |
| Server | All Tools | каждый инструмент бэкенда с автоформой |
| | Workspace | сохранённые скрипты (с родословной), opmaps, outputs; адрес MCP |

---

## Главный статический цикл: «декодировать все константы, не запуская скрипт»

1. **Constants → Decode kit** (или `decode_bundle`) — все функции-декодеры, вызываемые с литералами, собираются в **одну** программу:
   - **Python**: каждый декодер портирован со всей цепочкой зависимостей поверх общего прелюда с семантикой Lua;
   - **Lua**: точные *оригинальные* срезы кода, каждый в своём `do … end`, + совместимость (bit32 на чистой арифметике для Lua 5.1/5.3).
2. Вы запускаете: `python3 bundle.py out.json` (или `luau bundle.lua > out.json`) → один JSON `{"L<строка>:<колонка>": значение}`.
3. **Python → Results → Lua** (или `inline_values`) — значения подставляются обратно в *тот же* скрипт, затем Deobfuscate сворачивает остальное.
4. **Behaviour / IOCs** на получившемся коде — URL, вебхуки, загрузчики, HWID, хуки.

Для VM: **VM Map** → десериализатор «→ Python» → вы запускаете → `out.json` → **VM chunk explorer** (раскладка определяется сама,
опкоды и роли операндов берутся из интерпретатора) → листинг всех протозов + строки + IOC.

Python-порт и Lua-срез проверены друг против друга: на тестовых Prometheus-образцах результаты совпали по всем ключам.

---

## MCP (ИИ управляет всеми инструментами)

- **HTTP** (вместе с сервером): `http://127.0.0.1:7777/mcp` (Streamable HTTP).
- **stdio**: `node --import tsx apps/mcp/src/server.ts --workspace ./workspace`

Claude Code: `claude mcp add prism -- node --import tsx /путь/к/prism/apps/mcp/src/server.ts`
или по HTTP: `claude mcp add --transport http prism http://127.0.0.1:7777/mcp`.

Claude Desktop (`claude_desktop_config.json`):
```json
{ "mcpServers": { "prism": { "command": "node", "args": ["--import", "tsx", "/путь/к/prism/apps/mcp/src/server.ts"], "cwd": "/путь/к/prism" } } }
```
Подробно — [docs/MCP.md](docs/MCP.md): 54 инструментов, ресурсы `prism://…`, промпты-сценарии.

---

## Безопасность

- По умолчанию сервер слушает только `127.0.0.1`; защита от DNS-rebinding (чужой `Host` → 403).
- Аргументы `path` / `chunk_path` / `file` читают файлы **на машине сервера** — не открывайте порт в сеть.
- Скрипты не выполняются; генерируемые программы запускайте сами (лучше в песочнице).

## Структура

```
packages/core    — лексер, парсер (Lua 5.1 + Luau), принтер, проходы очистки, анализ (VM, opcodes, anatomy, constants,
                   behaviour), байткод Luau/Lua 5.1, кастомные VM и чанки, Blob Lab, Python-транспилятор, Lua-срезы, bundle
packages/tools   — реестр 54 инструментов (общий для UI, HTTP API и MCP), workspace, guide/prompts
apps/server      — HTTP: UI + /api + /mcp     apps/mcp — MCP stdio/HTTP     apps/web — React + Monaco UI
docs/            — MCP.md, STATIC-TECHNIQUES.md
```
