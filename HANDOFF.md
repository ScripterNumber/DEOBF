# HANDOFF — NEW_SAMPLE_3_TEST (Superflow) — ЗАВЕРШЕНО

Дата: 17.11.2026. Sample `samples/NEW_SAMPLE_3_TEST.lua` пройден до конца в
статическом режиме: структура VM восстановлена, код очищен и сделан читаемым,
все константы/строки/прототипы собраны. Payload не исполнялся.

## Результат

- `results/NEW_SAMPLE_3_TEST/NEW_SAMPLE_3_TEST.clean.lua` — очищенный Lua
  (8 762 строки, 1 619 062 символа, 166 функций), **lift_report 100/100**.
- `results/NEW_SAMPLE_3_TEST/NEW_SAMPLE_3_TEST.readable.lua` — вариант после
  `makeReadable` + `inlineTemps` (8 741 строка), **100/100**, 0 ошибок парсинга.
- Отчёты: `04_vm_detect`, `05/06_vm_anatomy`, `07_opcodes` (174 handler'а,
  opcodes 1..175), `08_protos`, `09_constants` (39 строк / 7 763 числа),
  `10_strings`, `11_behavior` (только anti-tamper), `12/14_score`, `13_lift`,
  общий `REPORT.md`.

## Что было исправлено в PRISM (upd10)

1. `packages/core/src/analysis/opcodes.ts` — `detectRoles`: прямой fetch
   `op = code[pc]` даёт роли `code/pc`; `inst` только для инструкций-полей;
   VM-классификация при `fetch && stack && leaves >= 8`. Тест: `rB` → vm,
   83 листа, `code=S`, `pc=I`.
2. `packages/core/src/passes/outline.ts` — инлайн только при замкнутом
   пространстве методов; иначе определения остаются и вывод дублируется
   (0.80 → 2.37 МБ). Плюс `entryOnly`: обрабатываются только таблицы,
   сразу вызываемые как конструктор. Итог: 1.62 МБ без дублей, 231 слот свёрнут.
3. `packages/core/src/index.ts` — `reinlineOutlined` встроен в `clean()`
   (опция `outline`, поля статистики `outlineInlined/Slots/Removed`).
4. `packages/tools/src/tools/deob.ts` — проброс `outline`, описание.

## Проверки

- `npx tsc -p packages/core/tsconfig.json --noEmit` и tools — без новых ошибок.
- `npx tsx packages/core/test/pipeline.ts` — **18/18** реальных обфускаторов,
  round-trip reparse 0 ошибок (`out/pipeline-regress.log`).
- `npx tsx tools/readable_cli.ts ...` — `parseErrorsOut: 0`.
- `npx tsx scratch/score_file.ts ...readable.lua` — 100/100.

## Известное ограничение

Payload — custom-байткод Superflow (644 620 байт, `LPH-`), сериализация
разбирается только исполнением loader'а. `vm_lift` не находит форму:
`findVmShape` ожидает `op = proto.field[pc]`, а у Superflow `code/pc/stack`
передаются позиционными аргументами «расплющенных» методов таблицы.
`vm_anatomy` / `opcode_map` при этом VM видят (работают от dispatch-дерева).
Бизнес-логику payload без отдельного devirtualizer'а Superflow статически не
достать; это зафиксировано в `REPORT.md`. PRISM не исполняет анализируемые
скрипты — так и задумано.

## Воспроизведение

```bash
$env:PRISM_WORKSPACE='out/ws-final3'
npx tsx scratch/pipeline3.ts samples/NEW_SAMPLE_3_TEST.lua results/NEW_SAMPLE_3_TEST
npx tsx tools/readable_cli.ts results/NEW_SAMPLE_3_TEST/NEW_SAMPLE_3_TEST.clean.lua \
  results/NEW_SAMPLE_3_TEST/NEW_SAMPLE_3_TEST.readable.lua
npx tsx scratch/score_file.ts results/NEW_SAMPLE_3_TEST/NEW_SAMPLE_3_TEST.readable.lua
```

Бэкап правок и артефактов: `backups/prism-upd10-superflow-test3.zip`.
