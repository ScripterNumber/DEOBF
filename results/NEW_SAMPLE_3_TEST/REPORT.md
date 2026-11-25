# NEW_SAMPLE_3_TEST — статический разбор (Superflow VM)

Итог: sample разобран до уровня структуры VM и полностью очищен статически.
Payload — custom-байткод Superflow; он не исполнялся. Готовый читаемый Lua
(интерпретатор), отчёты с дизассемблером и все константы — рядом, score 100/100.

## 1. Что это за sample

- 798 741 байт, фактически одна строка: `superflow_bytecode = { ... }` + фабрика VM.
- Семейство: **Superflow** (register-VM, dup-param handlers). Маркер — глобал
  `superflow_bytecode`, строки `"LPH:"`, `"[ -&|-~]"`.
- Полезная нагрузка: строковый литерал **644 620 байт** (второй, 644 616 байт —
  его копия/продолжение), собирается через `_bsdata0[8] .. ... .. _bsdata0[5]`.
- VM: таблица из **109 именованных методов** + **18 числовых** фабрик; это
  «расплющенный» интерпретатор, разбитый на чанки. Каждый метод вызывается как
  `r[K](r, ...)` и возвращает следующее состояние (CPS-подобно).
- Диспетчеризация: `while true do local H = T[I] ... I = I + 1 end`.
  После очистки: **174 handler'а, opcodes 1..175**, дерево `vm` на `H`,
  роли `code=T`, `pc=I`, `stack=p`; в исходнике дерево на 152 листа.
- Дополнительные деревья: `H` 145/119 листьев, `rB` 83, `t` 82, `z` 53,
  `K` 36/31 — это чанки того же интерпретатора/стейт-машины.
  Всего `opcode_map` показывает 92 dispatch-дерева, 2 CFF.

## 2. Что восстановлено

| Артефакт | Файл | Содержимое |
|---|---|---|
| Чистый Lua | `NEW_SAMPLE_3_TEST.clean.lua` | 8 762 строки, 1 619 062 символа, 166 функций |
| Readable view | `NEW_SAMPLE_3_TEST.readable.lua` | 8 741 строка, `makeReadable` + inline temps, 0 ошибок парсинга |
| VM anatomy | `05_vm_anatomy.txt`, `06_vm_anatomy_clean.txt` | boot → payload → unpack → wrap → run → exit, entry, fetch, pc-advance |
| Opcode map | `07_opcodes.txt` | 12 крупнейших деревьев, 174 handler'а с псевдокодом и confidence |
| Protos | `08_protos.txt` | 166 функций: константы, upvalue, вложенные функции, пулы |
| Constants | `09_constants.txt` | 39 строк (35 уникальных), 7 763 числа (362 уникальных), 14 decoder-кандидатов |
| Strings | `10_strings.txt` | все строки, включая payload-блобы и служебные `LPH:` / `[ -&|-~]` |
| Behavior | `11_behavior.txt` | только anti-tamper (`setfenv`/`getfenv`), сетевых/файловых IOC нет |
| Scorecard | `12_score_clean.txt`, `14_score_readable.txt` | **100/100**, 166/166 creation sites, 0 untraced captures |
| vm_lift | `13_lift.txt` | ограничение: см. §4 |

Очистка (deobfuscate) сворачивает: 219 констант, 108 propagations, 168 alias,
38 мёртвых локалов, 231 константный слот outline-таблицы, 3 CFF-машины,
23 loop→if, 27 flatten do, 62 if-expr, 40 dead stores. Ошибок парсинга — 0.

### Как читать дерево VM

```
while true do
  local H = T[I]              -- fetch: code[T], pc=I
  if H < 88 then ... end      -- 174 обработчика, opcodes 1..175
  I = I + 1                   -- pc advance
end
```

`W` — регистровый файл (stack), `T` — код, `I` — pc, `S/u/p/x/l` — операнды
текущей инструкции, `L` — окружение/константы. `07_opcodes.txt` даёт
псевдокод каждого handler'а (CALL, RETURN, SETUPVAL, COND-JMP, …), включая
RETURN-выходы (ops 51/58/80/89/96/99/100/129/141).

## 3. Ограничение: payload не дизассемблирован

`vm_lift` для этого sample пишет:

> no VM interpreter recognised (a dispatch loop over decoded instructions +
> the closure factory that creates VM closures), not even after cleaning

Причина: `findVmShape` ищет канонический вид `local op = proto[3][pc]`, где
массив кода — поле proto. У Superflow интерпретатор «расплющен» в методы
таблицы, и `code/pc/stack` передаются **позиционными аргументами** метода
(`[24] = function(r, x, H, H, T, l, u, ...)`), а не лежат в proto. Поэтому
`vm_anatomy` и `opcode_map` VM видят (они работают от dispatch-дерева), а
`vm_lift` — нет. Это осознанно не расширялось: даже при найденной форме
`vm_lift` должен был бы исполнить loader, чтобы распаковать custom-байткод,
а PRISM не исполняет анализируемые скрипты.

Следствие: **бизнес-логика payload статически не восстановлена** — для этого
нужен отдельный devirtualizer формата Superflow (парсер payload +
семантика 174 handler'ов). Всё, что восстанавливается без исполнения —
структура VM, дизассемблер, константы/строки/прототипы и очищенный код —
собрано в этой папке.

## 4. Изменения в PRISM (upd10)

1. `analysis/opcodes.ts`, `detectRoles`: прямая загрузка `op = code[pc]`
   теперь даёт роли `code/pc` (раньше `inst=code`, `pc='$pc'`, и VM не
   классифицировалась). `inst` выставляется только для инструкций-полей.
   Классификация `vm`: `fetch && stack && leaves >= 8`.
   Проверка: `rB` стал `vm` с 83 листьями, роли `code=S`, `pc=I`.
2. `passes/outline.ts`: инлайн методов разрешён только когда пространство
   методов замкнуто (`!selfEscapes && !(dynReadKinds & K_STR) &&
   !(dynWriteKinds & K_STR)`); иначе 100 инлайнов дублировали тела и раздували
   вывод 0.80 → 2.37 МБ. Добавлен `entryOnly` (по умолчанию true): таблица
   обрабатывается, только если она сразу вызывается как конструктор
   (`({...}):entry()`), обычные классы/модули не трогаются.
3. `index.ts`: `reinlineOutlined` встроен в `clean()` (опция `outline`,
   статистика `outlineInlined/outlineSlots/outlineRemoved`).
4. `tools/deob.ts`: проброс `outline` и обновлённое описание.

Регрессия: typecheck чистый; 18 реальных обфускаторов из
`apps/web/public/samples` проходят `clean()` с 0 ошибок парсинга
(`out/pipeline-regress.log`).

## 5. Воспроизведение

```bash
# полный статический pipeline (clean → detect → anatomy → opcodes → protos →
# constants → strings → behavior → score → vm_lift)
$env:PRISM_WORKSPACE='out/ws-final3'
npx tsx scratch/pipeline3.ts samples/NEW_SAMPLE_3_TEST.lua results/NEW_SAMPLE_3_TEST

# readable view
npx tsx tools/readable_cli.ts results/NEW_SAMPLE_3_TEST/NEW_SAMPLE_3_TEST.clean.lua \
  results/NEW_SAMPLE_3_TEST/NEW_SAMPLE_3_TEST.readable.lua

# score
npx tsx scratch/score_file.ts results/NEW_SAMPLE_3_TEST/NEW_SAMPLE_3_TEST.readable.lua
```

## 6. Файлы

- `NEW_SAMPLE_3_TEST.clean.lua` — основной результат (читаемый Lua).
- `NEW_SAMPLE_3_TEST.readable.lua` — вариант после `makeReadable`/`inlineTemps`.
- `01_add` … `14_score_readable` — полные отчёты инструментов (txt + json).
- `SUMMARY.md` — тайминги шагов.
- `../../CHANGES.md` (upd10) — журнал правок PRISM.
