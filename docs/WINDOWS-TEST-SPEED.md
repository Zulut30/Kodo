# Тесты и диагностика затрат на Windows

## Планирование полной suite: scoped коррекция06, 5 ноября

`npm test` теперь вызывает `scripts/run-tests.mjs`: официальный Node24
[`node:test.run`](https://nodejs.org/docs/latest-v24.x/api/test.html#runoptions)
с `files`, `concurrency: 4`, `isolation: 'process'` и встроенным TAP reporter.
Прямой `node --test` сортирует explicit files, поэтому перестановка аргументов
CLI сама по себе не меняет стартовый порядок. Programmatic API сохраняет
переданный порядок; это проверено короткими реальными child-процессами.

Обнаружение в `scripts/run-tests.mjs` повторяет default pattern из встроенного
Node `v24.19.0`: `**/{test,test/**/*,test-*,*[._-]test}.{js,mjs,cjs,ts,mts,cts}`.
При отключённом strip-types остаются `js,mjs,cjs`. Рекурсивный обход не следует
ссылкам, не выходит из checkout, исключает `node_modules`, `.git` и скрытые
каталоги, как default glob. Новые подходящие файлы включаются автоматически;
это не allowlist только для `tests/*.test.mjs`. Сам runner не соответствует
шаблону и не находится под `test/`.

Приоритет теперь следует убыванию фактических длительностей завершённых файлов
из receipt, переданных контрактом Run `1548713d-1cc5-4262-8ed3-fcd048485d75`.
Это `duration_ms` файлов, а не `observedAtMs` доставки reporter events.
Все имена ниже обозначают `tests/<имя>.test.mjs`:

| Файл | Наблюдавшаяся длительность, ms |
| --- | ---: |
| delivery | 588139.3066 |
| project-director | 566770.1329 |
| architecture-gate-integration | 432286.6863 |
| engine-4 | 315828.7805 |
| engine-2 | 310021.1643 |
| engine-3 | 298955.3369 |
| engine | 290212.1408 |
| ci-graph | 239140.7966 |
| mode-engine-4 | 199378.0839 |
| ci-cache | 188462.5517 |
| mode-engine-3 | 182728.3893 |
| mode-engine-2 | 170410.8459 |
| mode-engine | 165308.6285 |
| ci-cli | 120844.2919 |
| architecture-acceptance | 30060.7548 |
| project-director-oracle | 25141.873 |

Отдельное исключение по уточнению координатора: `tests/benchmark.test.mjs`
расположен сразу после `engine` и перед `ci-graph` по prior lower-bound heuristic.
В сохранённом `check-28c5a1ab8c8d4a693b9d2e4de7f1c744698fe56526a0a45cee8a422de19929a8.json`,
source88, Node `v24.19.0`, hermetic, наблюдались 16 завершённых top-level benchmark
cases 563–578 с суммой case work 255773.4331 ms без повторного учёта детей.
Координатор подтвердил исходные данные через отдельный read-only speed worker;
здесь benchmark повторно не запускался. Это нижняя граница работы кейсов,
не измеренный file elapsed, не длительность на текущем Node `v24.22.1` и
не вес в таблице измеренных файлов. Его реальная длительность файла неизвестна.

Для остальных файлов длительности не назначены: они идут лексически после
этих 17 приоритетных; дубликаты удаляются. Наблюдения зависят от окружения и
перекрывающейся нагрузки. Их сумма не является elapsed time; ускорение не
измерено и не обещано. По контракту исходный полный локальный check на source
`88a9fadae1d226539802dfc7f788df47a39ae7ca`, Node `v24.22.1`, остановился через
1200492 ms; это исходный неуспех, а не AFTER данной перестановки. Успешные
Windows/Linux CI того же исходника не доказывают локальный AFTER.

Time limits, assertions, frozen oracles, process isolation и общий потолок4
сохранены. Cancellation использует AbortSignal штатного runner; CLI SIGINT/SIGTERM
запрашивают abort и дренирование. Принудительное OS-завершение процесса не даёт
выполнить JS cleanup; Windows tree termination остаётся границей координатора.

Поддерживаемый CLI:

```powershell
npm test
npm test -- tests/test-schedule.test.mjs
npm test -- --test-name-pattern='Scheduler starts' tests/test-schedule.test.mjs
npm test -- --test-concurrency=1 tests/test-schedule.test.mjs
```

Оба флага принимают `=value` или отдельное значение; повторные name patterns
передаются Node как массив. Concurrency разрешена от1 до4, default4. Explicit
paths — только существующие literal-файлы внутри checkout, без ссылок,
`node_modules`/`.git`; повторения запускаются один раз. Globs, каталоги и остальные
флаги явно отклоняются с nonzero exit, а не меняют выбор тестов незаметно.
Для более широкого CLI остаётся прямой `node --test`. Поиск существующих scripts
не выявил npm-вызовов с дополнительными флагами; прямые Node scoped-команды
остаются самостоятельными. Runner нужен только checkout разработчика и не входит в установочный CLI-пакет; shipped script asset остаётся `ci-reporter.mjs`. Существующий пакетный regression test проверяет этот состав.

Локальное доказательство ограничено `tests/test-schedule.test.mjs` с короткими
фикстурами: default discovery (включая TypeScript/strip-types), exclusions/links,
детерминированный duplicate-free порядок, фактический старт при concurrency1,
readiness barrier с четырьмя отдельными PID, exit0 и реальные assertion/import/
cancel failures, abort owned child, explicit paths/name patterns и явный отказ
для неподдерживаемого CLI. RED сначала показал старый лексический старт.
Сырые RED/GREEN и receipts находятся вне Git в
`C:/Users/zulut/AppData/Local/Kodo/runs/ad175403-61c1-49d2-9fd2-f1f8f04656f5/scheduler-evidence`.

Полный `npm run check`, Windows/Linux CI, независимое review и приёмку выполняет
координатор на интегрированном head. Полный AFTER, ускорение и общий PASS здесь
не заявлены. UI disabled — neutral; security gates остаются координатору.
Native provider, installed/published artifact и deployment не проверялись.
Урок: наблюдать порядок child-start, а не считать порядок CLI-аргументов
доказательством планирования; локальный barrier не заменяет полный speed test.

### Scoped проверка порядка по длительностям: 5 ноября 2026

В назначенном worktree `duration-order`, base
`88a9fadae1d226539802dfc7f788df47a39ae7ca`, Windows, Node `v24.19.0`,
до изменения priority добавлена независимая регрессия
`Scheduler orders observed file durations longest first and retains every discovered file once`.
Она передаёт все 17 приоритетных файлов (16 с измерениями и benchmark с отдельной
эвристикой) в перемешанном порядке, два неизвестных
файла и повторения абсолютного/относительного пути. Проверяются полный набор,
отсутствие дубликатов, неизменность input, default discovery, убывание известных
длительностей и лексический fallback. Ожидаемый порядок не читается из runner.

Фактически выполнены команды:

```powershell
node scripts/run-tests.mjs --test-name-pattern='Scheduler orders observed file durations' tests/test-schedule.test.mjs
node scripts/run-tests.mjs tests/test-schedule.test.mjs tests/ci-package.test.mjs
```

Первая команда до изменения priority: exit1, 0 PASS / 1 FAIL,
TAP duration 148.6661 ms; failure — несовпадение старого порядка с заданным.
После изменения priority та же команда: exit0, 1 PASS / 0 FAIL,
136.1799 ms. Это короткий RED/GREEN для новой регрессии, не замер полной suite.

Первый запуск второй команды: exit1, 11 PASS / 2 FAIL, 4740.7416 ms. Прошли новая регрессия,
package test, default discovery/strip-types, links, concurrency4/разные PID,
assertion/import/cancellation diagnostics, explicit selection, caps и abort.
Два существующих теста — `Scheduler starts heuristic heavy files before lexical files in real isolated children`
и `Scheduler deduplicates priorities and preserves deterministic lexical fallback` —
жёстко ожидали прежний порядок. После явного узкого уточнения координатора
обновлены только два literal expected-order arrays. Assertions, inputs,
child execution, проверки уникальности/полного набора и все остальные тела
существующих тестов сохранены. Исходный failure сохранён в `focused.tap`.
Это изменение ожидаемого порядка вслед за требованием, без ослабления проверки.

Повтор той же второй команды: exit0, 13 PASS / 0 FAIL / 0 cancelled /
0 skipped, 5945.5787 ms (`focused-green.tap`). Все существующие scheduler
assertions и package regression прошли. Полная suite и общий PASS по-прежнему
не заявлены; различие времени коротких прогонов не является speedup evidence.

После дополнительного уточнения про benchmark регрессия расширена до 17
приоритетных файлов. До добавления benchmark в priority первая команда снова
дала exit1, 0 PASS / 1 FAIL, 145.5035 ms (`benchmark-red.tap`): файл был
в лексическом хвосте вместо согласованной позиции. После минимального изменения
priority вторая команда дала exit0, 13 PASS / 0 FAIL / 0 cancelled / 0 skipped,
5582.7569 ms (`focused-benchmark-green.tap`). Два старых expected-массива больше
не менялись: их inputs не содержат benchmark. Первый GREEN сохранён отдельно.
Это проверка порядка короткими фикстурами; полный benchmark и speed test
не запускались, overall speed неизвестна.

Сырые `red.tap`, `green.tap`, `focused.tap`, `focused-green.tap`,
`benchmark-red.tap`, `focused-benchmark-green.tap` и JSON receipts с командами,
cwd, Node, source HEAD и exit codes сохранены вне Git:
`C:/Users/zulut/AppData/Local/Kodo/runs/1548713d-1cc5-4262-8ed3-fcd048485d75/duration-order-evidence`.
Изменены только priority/comment, новая регрессия, два согласованных expected
arrays и эта документация;
discovery/runTests/options/failure/cancellation, concurrency4, deadlines и
frozen oracles не менялись. Полная suite, модели, native provider, внешняя
публикация и deployment не запускались. Локальная упаковка в package regression
не является опубликованным артефактом. UI disabled — neutral; security и
интегрированные проверки остаются координатору.
Урок: при смене scheduling policy отдельно согласовать старые order literals;
сохранение assertions не делает противоречащие порядки одновременно истинными.

## Коррекция Phase06: текущая граница

Снимок 2026-11-05: corrective Run `7a424d6f-6392-483c-b1f8-6918824f0baf`,
исходный baseline `3c39de09eaca16997834c3de07f2e936072915a5`, интегрированный
source `0ee548b74413fba1c917eab4a49e12f6235869be` до этой документации.
Родительский Run `cf04d9ae-e733-48d6-8d7e-c29220084ef0` остаётся остановленным
на `verification3/cycle1`; его бюджет не сбрасывался. Это исправление blocker
приёмки06, не начало07 и не общий PASS. [Состояние приёмки](kodo-roadmap/phase-06.md).

### Что действительно наблюдалось

Один неизменённый сценарий `Trusted acceptance and owned Git restart preserve
the first local task file in the second reserved base` из
`tests/project-director.test.mjs` прошёл на baseline, Windows, Node `v24.19.0`.
Тело теста заняло 106764.2793 ms, TAP — 107045.5535 ms, внешняя команда —
107157.4236 ms. Наблюдались 1238 вызовов Git и 13 PowerShell; это число запусков,
не уникальных PID. Instrumentation overhead включён. Exposure sums вложенных
границ могут пересекаться и не складываются в wall time или экономию.
Распределение startup/Git work и причина общего timeout не установлены.

| Граница | Baseline | После коррекции | Уровень доказательства |
| --- | --- | --- | --- |
| Один успешный `inspectCurrentSource` | 8 Git-процессов: 6 основных + 2 защитных | 6: 4 основных + 2 защитных; scoped assertion требует ≤6 | Baseline RED, source и scoped Git-regressions; не замер полной suite |
| Тот же Director case целиком | PASS, 107157.4236 ms; 1238 Git, 13 PowerShell | PENDING | Нужен один сопоставимый coordinator-owned AFTER со всеми Git children |
| Общие Windows checks родителя | Две попытки остановлены по 20-минутному deadline | PENDING | Нет завершённого сопоставимого before/after |

Первоначальные «≤4 TOTAL» были ошибкой учёта координатора: он пропустил два
обязательных запроса имён filter config. Исправленный критерий — ≤4 CORE +
2 свежих protective queries = ≤6 TOTAL, baseline 8. Защитные запросы входят
в стоимость. Исходный frozen ports SHA-256
`ef35b50b39d5464dd63b50eaffc3822601709d8a470daba7a4f99d5b3fa173f9`;
уточнение `windows-perf-process-accounting-addendum-v1.md`, SHA-256
`8d988b9a7288094bea9f0a264337ebc3603b1727f098951346f20d81cd757372`,
меняет только числовой учёт, а не guards или бюджеты.

### Фактические изменения модулей

`runtime/ci-graph.mjs`: `inspectCurrentSource({project, headSha})` сохраняет
результаты `clean`/`dirty`/`unknown`. В каждом из двух наблюдений HEAD и dirty
status читаются вместе через `status --porcelain=v2 --branch -z`. Авторитетен
ровно один полный 40/64-символьный `branch.oid`; missing/duplicate/unborn/malformed
не становятся clean. Перед каждым status заново запрашиваются только имена
filter config и отключаются project filter drivers для этого child. Root/realpath,
hidden tracked-byte edits при assume-unchanged/skip-worktree, link/stat/size,
binary/mode/CRLF и обе source fences сохранены. Успешная проверка не кэшируется.
`runtime/project-director.mjs` удаляет только два отдельных дублирующих HEAD-вызова
в `validateRun`; обе полные source fences и lifecycle остаются.

`runtime/command.mjs`: `execute` фиксирует первую причину остановки:
`timeout`, `cancelled` или `invalid_output` с `reason: 'output_limit'`.
Поздний abort её не заменяет. На close ошибка получает очищенный `error.result`
с `stdout`, `stderr` (до 24000 символов каждый), nullable actual `code`,
`durationMs`, `outputTruncated`, `reason`. Полные и перекрывающиеся known secrets,
а также незавершённый известный prefix в конце capture очищаются до обрезки.
`rawOutput:true` не выдаёт сырой остановленный вывод; success/stdin поведение
сохранено. Потолки stdout `16 * 1024 * 1024` и stderr `4 * 1024 * 1024`
не увеличены; фактическая единица в этом executor — длина JS-строки, не UTF-8 байты.
Штатное завершение/дренирование owned child и Windows tree kill сохранены.

`Engine.checks`: execution failure добавляет failed row с `reason`,
`exitCode:null` и nullable actual `processExitCode`; сохраняет очищенное immutable
evidence с `outputPath`/`outputHash`, `complete:false` и предыдущие успешные rows,
затем пробрасывает исходную типизированную ошибку без следующей команды.
Сбой persistence не маскирует исходную ошибку; файл evidence/новая row тогда
не гарантированы, но неполная receipt не становится reusable/PASS.
Fresh source checks и exact-head/commands/runtime fingerprint для reuse сохранены.

`runtime/ci-cli.mjs`: фактический workflow использует `runCi`, чей catch теперь
публикует allowlisted profiler metadata и `diagnostic.stdoutTail`/`stderrTail`
до 4096 UTF-8 байт каждый, с отдельными `stdoutTruncated`/`stderrTruncated`.
Known secrets очищаются по всему capture до tail; строки остаются валидным UTF-8.
Метаданные: nullable nonnegative integer `exitCode`, nonnegative `durationMs`
(иначе elapsed fallback), boolean `outputTruncated` при наличии и ограниченный
очищенный `profilePath`. Catch receipt для timeout/cancel/overflow остаётся
`blocked`; общий результат имеет `complete:false`, даже при actual exit 0.
При другой failed receipt общий status может быть `failed`, но не `passed`;
отсутствующие результаты не выдумываются.
Profiler и `scripts/ci-profiler.mjs` не переписывались. Deadline `1200000` ms,
индивидуальные timeouts, file concurrency4, native capacity5 и меньшие saved
budgets сохранены. GPT/Claude по-прежнему работают через подписочные клиенты.

### Scoped checks и оставшиеся gates

Прямые зависимости сообщили: A — Git graph 54 PASS и один выбранный Director
regression; B — 32 targeted и 18 existing regressions PASS; C — 75 scoped CI CLI
tests PASS. Это локальные проверки, не required Windows/Linux CI.
Это отдельные scoped группы, не unique/full total; documenter их не перезапускал.
Независимый `tests/windows-speed-oracle.test.mjs` заморожен с SHA-256
`ad4033f1f7eb8084ec0201c083d460d69b4607e89a55e751054b3062c3a93bcc`.
Его baseline RED: 23 tests, 10 PASS, 13 FAIL, без skip/cancel, exit1 — подготовка
оракула, не feature PASS. Старый Director oracle `fa0a150b…` сохранён.
Root выполнил этот frozen oracle против clean code HEAD
`0ee548b74413fba1c917eab4a49e12f6235869be` до docs: actual scoped composite
23/23 PASS, 0 fail/skip/cancel, 36995.3723 ms, Node `v24.19.0`, Windows `win32`.
HEAD/source до и после неизменны. Приватная receipt:
`C:/Users/zulut/AppData/Local/Temp/kodo-roadmap-20261104/windows-perf-composite-0ee.json`;
TAP output SHA-256 `9e911063af851a31042fe86f8fe66c687f3b5249c9542d51ab8501f58e1d9c61`.
Это PRE-DOCS component proof, не полный check, общий PASS или основание reuse
на будущем HEAD после H. Documenter oracle не перезапускал.
Performance AFTER того же cost case выполняет только Root после стабилизации
H/native boundary; наблюдения AFTER пока нет. Полный `npm run check`, required
Windows/Linux CI, fresh configured security и независимое итоговое review
остаются PENDING. UI verification disabled — neutral, не PASS. Native provider,
installed/published artifact, merge/release/deployment здесь не подтверждаются.

Приватная provenance: `speed-five/windows-perf/diagnosis.md` и
`windows-perf-receipts/{git-observations,stopped-check-evidence,windows-speed-oracle}`
в `C:/Users/zulut/AppData/Local/Temp/kodo-roadmap-20261104/`; frozen ports/addendum
находятся в `C:/Users/zulut/AppData/Local/Kodo/runs/7a424d6f-6392-483c-b1f8-6918824f0baf/`.
Наблюдения сокращения процессов не доказывают глобальное ускорение, pure LLM
latency, HTTP/token/quota расход или subscription USD. Benchmark не проводился.

Урок: считать защитные subprocesses вместе с основными; оптимизировать повторные
наблюдения без ослабления fences. При остановке сохранять очищенный partial
вывод и первую причину, сохраняя incomplete/nonpassing статус.

## Историческое разбиение Engine-тестов Phase03

Далее сохранён scoped draft и измерения 4 ноября; его границы относятся к тому
прогону, а не к текущей приёмке06. [Позднейшая приёмка03](kodo-roadmap/phase-03.md).

## Требования и границы

Исходный `tests/engine.test.mjs` содержит 43 независимых верхнеуровневых теста.
Node выполняет их последовательно внутри одного файла. Разбиение на четыре
обнаруживаемых файла позволяет штатному runner выполнять разные файлы параллельно.
Порядок сценариев внутри каждого файла сохранён относительно исходного файла.
Распределение использует частичные наблюдения исходного scoped-прогона: 40 из
43 сценариев завершились до отмены по решению координатора для освобождения
heavy-слота. Для трёх ещё не наблюдённых сценариев при распределении использована
медиана наблюдавшихся длительностей. Это эвристика распределения, не измерение
ускорения. Число сценариев по файлам: 9, 12, 11, 11.

Общая фикстура находится в `tests/helpers/engine-fixture.mjs`. Модуль не импортирует
`node:test`, не регистрирует тесты и не создаёт временные проекты при импорте.
Его имя не соответствует стандартному шаблону `*.test.mjs`. Каждый вызов фикстуры
по-прежнему создаёт собственный временный Git-проект и Store, регистрирует исходный
`t.after`, закрывает Store и удаляет только проверенный временный каталог.

Переносятся точные тела тестов и определения helper-функций. Имена, assertions,
вложенные `t.test`, setup/teardown, сценарии прерывания, задержки и таймауты не
меняются. Runtime, package scripts, skips и правила отбора тестов не меняются.
Существующий `tests/engine-delivery-contract.test.mjs` остаётся отдельной проверкой.

## Scoped-команда

Из корня worktree, Node 24:

```powershell
node --test --test-concurrency=4 tests/engine.test.mjs tests/engine-2.test.mjs tests/engine-3.test.mjs tests/engine-4.test.mjs
```

Это все четыре части исходного файла, без фильтрации по именам тестов.
В историческом прогоне `npm test` использовал `node --test` и автоматически
обнаруживал новые `*.test.mjs`. Текущий runner и потолок4 описаны в начале
документа; изменение общей concurrency CI требует полного gate координатора.

## Проверка сохранности и измерения

Приватные receipts сохраняются вне Git. Инвентарь содержит исходное literal-имя,
файл/строку, SHA-256 точного исходного блока и число вызовов `assert.*`. Сравниваются
полные блоки, а не только количество тестов: так учитываются также вложенные
сценарии и assertions внутри записываемых fixture-скриптов. Исходный инвентарь
содержит 43 верхнеуровневых блока и 446 вхождений вызовов `assert.*` в этих блоках;
это статический счётчик вхождений, а не число runtime assertions. Определения десяти
общих helpers сравниваются побайтно отдельно, включая cleanup и fake providers.
Проверяется, что весь исходный код вне импортов учтён этими блоками.

Структурная RED-проверка до переноса ожидает четыре файла и получает один.
GREEN требует одновременно совпадения инвентаря, сохранения helpers и четырёх
файлов. Raw TAP и события штатного Node test runner сохраняются отдельно для
исходной попытки и итогового прогона; обёртка сохраняет command/args, HEAD, Node,
OS/arch, время начала/окончания, wall time и настоящий exit code.

Исходная попытка на Windows с concurrency 4 отменена после 40 из 43 сценариев
из-за contention с обязательным phase-02 `npm run check`. Частичные TAP/events и
отдельная cancellation receipt сохранены; эта попытка не является PASS или полным
before baseline. Итоговый scoped-прогон выполнен после освобождения heavy-слота.
Сравнимого завершённого before/after замера нет, поэтому ускорение не заявляется.
CPU и I/O всего дерева дочерних процессов не собраны: такие значения остаются
неизвестными.
Тайминги отдельных тестов сами по себе не доказывают причину затрат на ACL,
антивирус, Git или SQLite.

Исторические 606507 ms всей phase-02 suite — только контекст. Они не являются
baseline этого scoped-прогона и не используются для расчёта ускорения.

## Наблюдавшийся AFTER

4 ноября 2026, Node `v24.19.0`, Windows `win32/x64`, исходный HEAD
`1574a3c1b022e9e746326ca297cf89f0bf0d43a6` с изолированными изменениями тестов.
После отдельного разрешения координатора на heavy-слот выполнен один scoped-прогон
с concurrency 4. Начало: `14:32:54.487 UTC`, окончание: `14:35:11.918 UTC`.
`after.start.json` и `after.receipt.json` содержат SHA-256 входных файлов и имена
сценариев для точной привязки к фактически проверенному worktree.

| Файл | Верхнеуровневые сценарии | С вложенными тестами | File wall time, s |
| --- | ---: | ---: | ---: |
| `tests/engine.test.mjs` | 9 | 13 | 131.449 |
| `tests/engine-2.test.mjs` | 12 | 16 | 132.861 |
| `tests/engine-3.test.mjs` | 11 | 17 | 127.700 |
| `tests/engine-4.test.mjs` | 11 | 15 | 137.136 |

Длительности взяты из четырёх событий Node `test:summary` с фактическим `file`,
а не из суммы durations отдельных тестов. Наблюдавшийся критический путь файлов —
137.136 s; wall time команды — 137.420 s. Raw итог: 61 tests, 61 pass,
0 fail/cancelled/skipped/todo; exit 0. Все 43 исходных верхнеуровневых имени
выполнены ровно по одному разу. Это абсолютные локальные наблюдения AFTER,
без утверждения о коэффициенте ускорения.

В приватном каталоге receipts сохранены `after.tap`, `after.events.jsonl`,
`after.receipt.json`, `run-validation.json`, `inventory.before.json`,
`inventory.after.json`, `inventory.equality.json`, `before-ready.cancelled.json`,
частичные исходные TAP/events и исходная копия файла. Проверка инвентаря прошла;
пробные удаление assertion/сценария/cleanup и переименование literal-имени были
обнаружены. Синтаксис всех пяти JS-модулей и `git diff --check` также прошли.

## Приёмка

Это изолированный phase-03 draft. Полный интегрированный `npm run check`,
независимое differential review, Windows/Linux CI, package smoke, native provider
checks, публикация и deployment здесь не выполняются. Интеграция и доставка
остаются последовательными; phase-03 нельзя принимать до приёмки phase-02.

Урок: для уменьшения критического пути сначала измерять длительности файлов и
сценариев, затем распределять независимые тесты по времени. Размер исходника и
историческое время всей suite не заменяют scoped before/after evidence.
