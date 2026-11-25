# Ступени CI

Acceptance-команды strict L1/L2/L3 требуют чистого рабочего дерева перед запуском и после проверок. Неизменившегося HEAD недостаточно: dirty/untracked source или неизвестное состояние Git блокируют `complete`. Локальный `feedback` сохраняет поддержку незакоммиченной работы и всегда оставляет `complete:false` и обязательный L2.

Статус phase03: **draft, not accepted**. Phase02 принят: [PR #11](https://github.com/Zulut30/Kodo/pull/11), merge `dabecb7bec7514116e3b2870c04270bb4f83ee77`; его проверенные результаты перечислены в [phase-02](kodo-roadmap/phase-02.md). Текущая проверка совместимости семи scoped suites дала 91 PASS/0 FAIL/0 cancelled/0 SKIP на `8c24da1`; она не заменяет полный `npm run check`, независимое ревью и актуальный GitHub Actions run phase03 на Windows/Linux. [Контекст, source fingerprint и ограничения](kodo-roadmap/phase-03.md#проверка-совместимости-2026-11-04).

Из checkout:

```powershell
node cli/index.mjs ci plan --tier L0 --base FULL_BASE_SHA --project D:/Projects/example --json
node cli/index.mjs ci run --tier L1 --base FULL_BASE_SHA --project D:/Projects/example --json
node cli/index.mjs ci feedback --base FULL_BASE_SHA --project D:/Projects/example --json
node scripts/ci.mjs profile --tier L1 --base FULL_BASE_SHA --json
node scripts/ci.mjs run --tier L2 --json
node scripts/ci.mjs run --tier L3 --json
```

`FULL_BASE_SHA` заменяется полным immutable SHA (40 или 64 lowercase hex). Для L0/L1 `--base` обязателен; tier по умолчанию L1. Неизвестные, повторные, лишние параметры и символические Git refs отклоняются с ненулевым exit code; `--json` возвращает единственный JSON-документ. Dispatch `ci` выполняется до runtime SQLite/credential/provider startup. Команды не вызывают GPT/Claude, не устанавливают инструменты и не запускают доставку.

`feedback` — отдельный частичный результат, только tier L1. Исходные `run/profile L1` сохраняют строгий broad fallback и не заменяются этой командой. Feedback делает syntax и quick lint/typecheck changed source; если граф доказал affected scope, добавляет его и соответствующие tests. При fallback сохраняет все причины ambiguity, проверяет только известные changed файлы и явно откладывает tests к обязательному L2 на том же head. Рабочие изменения `git diff HEAD` и untracked paths передаются в существующий graph как `changedPaths`; scope не выдаётся за полный dependency graph.

Успешная частичная проверка имеет `status:feedback_ready`, `complete:false`, `requiresFullCheck:true`, exit 0. Это не PASS полного L1 и не основание для delivery. Полностью нейтральный docs-only scope имеет `status:not_applicable` и `codeChecksObserved:false`; neutral receipts сохраняются. Failed/missing/unsupported/disabled/blocked, отмена и смена HEAD дают exit 1. `deferredChecks` указывает tests при fallback и обязательный Windows/Linux L2 с checked head; после локальных незакоммиченных изменений доставка всё равно требует новый clean final head и свежий L2.

Feedback не обходит quality ownership: manifest/lock/CI/config paths остаются в quick scope. Если API требует более широкий owner check, config или tool pin отсутствует либо ownership неизвестен, результат остаётся blocked. У Kodo broad phase03 diff сейчас блокируется этой политикой (включая vendored language examples); тихих excludes, подмены missing на PASS и изменения проектной quality policy здесь нет. Fast job остаётся необязательным; обязательные contexts относятся к двум полным matrix jobs. Неизвестный comparison base возвращает честный blocked JSON (`base_required`); второй полный suite в fast job не запускается.

| Tier | Обязательное поведение | Граница доказательства |
| --- | --- | --- |
| L0 | Phase02 quality API: format/lint по changed scope, отдельные applicable/missing/neutral receipts | Локальные исходники; цель 1–5 s **NOT VERIFIED** |
| L1 | Quality lint/typecheck, Node syntax и транзитивно affected unit/contract tests из графа | При неизвестных зависимостях standard quality и полный `node --test`; цель 30–60 s **NOT VERIFIED** |
| L2 | Полный `npm run check`, затем свежая включённая security-проверка | Один запуск проверяет только текущую ОС; обязательная матрица Windows/Linux остаётся в Actions |
| L3 | Существующий `node scripts/package-smoke.mjs`: pack, install, запуск установленного CLI | Требует checkout со smoke script. Не выполняет publish/deploy и не доказывает deployment |

Format/lint/typecheck используют действующий `QualityProfileRegistry`/`runQuality`, включая pins, inventory, read-only команды и приватные evidence. Нужные управляемые инструменты заранее устанавливает координатор. `missing`, `unsupported`, `disabled`, неизвестный skip и повреждённый протокол блокируют выполнение; `failed` сохраняет неуспех. Явный `no_changed_or_affected_source` и `not_applicable` остаются нейтральными, не превращаются в passed. Полностью нейтральный запуск имеет `complete:false`. Quality scope исключает отсутствующие/deleted файлы, сохраняя исходный graph для решений о зависимостях. При graph fallback формат/линт охватывают всю обнаруженную область.

`runtime/ci-cli.mjs` вызывает публичный `planAffected({project,baseSha,headSha})` из `runtime/ci-graph.mjs`; собственной конкурирующей модели зависимостей нет. Некорректный graph/небезопасный путь блокируется до исполнения. Модули graph/profiler интегрированы; отсутствующий модуль даёт blocked, а не успешную заглушку. Контрактные scoped-тесты подставляют порты. Дополнительная offline fixture на `8c24da1` связала настоящие ci-cli/graph/profiler/reporter/process: один dependent test PASS, независимый намеренно падающий тест не запускался, одно file-summary. Только quality detect/plan/run были заглушены как neutral; это не проверка quality tools/gates или полного проекта.

Для настоящих command runs используется `runProfiledCommand` из `runtime/ci-profiler.mjs`: raw redacted stdout/stderr и ошибки сохраняются в отдельном приватном каталоге вне Git. JSON CI содержит exit codes, длительности и ссылки на profile. Только завершившаяся команда с ненулевым кодом добавляет в receipt `diagnostic`: `stdoutTail`/`stderrTail` максимум по 4096 UTF-8 байт и признаки `stdoutTruncated`/`stderrTruncated`. Весь capture маскируется через `security.redact` с известными секретными значениями до обрезки, граница сохраняет целые Unicode-символы. Это ограниченная публичная диагностика, а не полный raw log; environment/argv snapshots не добавляются. Passing receipts и infrastructure errors без завершённого процесса diagnostic не получают; timeout/cancel остаются типизированными blocked errors. Полные приватные логи и существующий `profilePath` сохраняются, загрузка raw artifacts не добавляется. `profile L1` дополнительно подключает Node event reporter рядом с development scripts и TAP; при отсутствии development reporter command timing остаётся, file timings неизвестны. Quality и security сохраняют свои receipts. Ошибка/timeout/cancel не подменяются нулевым кодом; HEAD проверяется повторно. Ни один результат этого CLI не является cache-reusable PASS.

`profile L2` сохраняет command span для существующего npm check; file timings полного L2 пока **BLOCKED**, workflow остаётся на `run L2`. Исследованный статический `NODE_OPTIONS` с reporters успешно прошёл простой npm fixture (включая exit 0/1, путь с пробелом/`#` и невыполнение user hook). Однако targeted существующий тест `Node24 real events distinguish file duration from deceptive test name and retain failed TAP` выявил наследование опций вложенным Node runner: custom reporter оказался подключён дважды, observed file count стал 2 вместо 1. Вариант отклонён и не оставлен в runtime/workflow; чужие тесты и profiler не ослаблялись. Нужна отдельная граница передачи reporter только верхнему test runner. Простой npm fixture не доказывает совместимость полного Kodo check; security в нём также оставался явно непроверенным.

На Node 24 для двух reporters обязательны два matching `--test-reporter-destination=stdout`. Путь custom reporter передаётся как `file://` URL: Windows drive, пробелы и `#` должны сохраняться при загрузке ESM. Это подтверждено отдельным RED/GREEN-тестом с настоящим Node. Cross-port precheck на owned tiny Git fixture также использовал реальные sibling graph/profiler/process и установленный managed Oxlint: transitive affected test исполнился, независимый намеренно падающий тест не запускался, profile получил ровно одно file observation. Для reporter path staging копировал только собственный неизменённый CI module; sibling modules подключались импортами. Frozen API не расширен. Это ограниченное Windows fixture evidence; full repository integration, Linux CI и выпуск по-прежнему не подтверждены.

Отчёты профилировщика содержат p50/p90 только для реально наблюдённых выборок; queue/setup/tool/ACL/worktree/package observations без событий остаются неизвестными. Общего измеренного ускорения, flaky-статистики или сравнения с baseline эта задача не заявляет. Исторические ~500 s Windows/~118 s Linux и phase02 606507 ms не являются текущим сопоставимым измерением.

В Actions новый необязательный `fast` включается только job-level условием `${{ vars.KODO_FAST_CI_ENABLED == 'true' }}`. Пока source/vendor ownership не подготовлен и не проверен, переменная отсутствует: job skipped/neutral, не PASS. После подготовки области координатор может установить repository variable `KODO_FAST_CI_ENABLED=true`; worker не меняет variables или branch protection. Причина opt-in — воспроизведённый blocked broad feedback, а не silent exclusion исходников. Локальный CLI feedback остаётся доступен для подготовленной области; его 4.29s observation не является Actions benchmark.

`fast` и required `check` независимы: `check` не имеет этого условия и сохраняет matrix `{os:[ubuntu-latest,windows-latest],node:[24]}`, без `needs: fast`, `continue-on-error` и исключения обязательных проверок. Fast использует частичный `feedback`; matrix L2 сохраняет `run L2`, вызывает `npm run check` внутри CLI ровно один раз, затем mandatory security. Сквозные наборы фабрики волн (`npm run test:waves`: `tests/project-wave-director.test.mjs`, `tests/project-wave-e2e.test.mjs` и набор параллельного движка этапа 15B `tests/project-parallel-engine.test.mjs` — реальные `task-fast`, слияния и одновременные сдачи, 45–100 с на кейс), тяжёлые наборы (`npm run test:heavy`, см. ниже) и финальные сценарии (`npm run test:final`) идут отдельными обязательными шагами той же matrix вне фиксированного предела одной команды L2 (`CI_COMMAND_TIMEOUT_MS`); обычное обнаружение тестов `npm run check` их не включает. Полное локальное покрытие — `npm run check`, `npm run test:heavy`, `npm run test:waves` и `npm run test:final`. Существующий installed CLI package smoke остаётся отдельным обязательным шагом каждого matrix job. Названия требуемых contexts остаются `check (ubuntu-latest, 24)` и `check (windows-latest, 24)`; изменения branch protection выполняет только координатор.

### Тяжёлые наборы — `npm run test:heavy` (16E)

После этапа 15 команда L2 `npm run check` на Windows CI шла 1 479 745–2 325 940 мс (медиана семи прогонов — 2 032 659 мс) и на медленном раннере упёрлась в фиксированный предел 2 400 000 мс (`status: blocked`, `reason: timeout`). Предел закреплён `tests/windows-speed-oracle.test.mjs` и не меняется. Поэтому 19 самых долгих файлов (список `heavySuites` в `scripts/run-tests.mjs`) идут отдельным обязательным шагом `Heavy integration suites` обеих ОС сразу после L2. Стандартное обнаружение их пропускает, `--coverage` включает. `tests/test-schedule.test.mjs` проверяет, что каждый файл стандартного шаблона Node идёт ровно в одном шаге: L2, `test:heavy` или `test:waves`.

Замер: этот Windows-ПК, Node 24.19.0. Каждый файл шёл отдельно и последовательно через `node scripts/run-tests.mjs <файл>` — это `node --test` с Git-окружением `npm test`. Параллельно на ПК шли чужие прогоны, поэтому числа — наблюдение, а не квитанция.

| Вынесено в `test:heavy` | мс |
| --- | ---: |
| `tests/delivery.test.mjs` | 445 075 |
| `tests/architecture-rust.test.mjs` | 319 540 |
| `tests/project-director.test.mjs` | 274 403 |
| `tests/wave-context-integration.test.mjs` | 270 006 |
| `tests/task-fast-checks.test.mjs` | 250 077 |
| `tests/behavior-rust.test.mjs` | 234 389 |
| `tests/architecture-gate-integration.test.mjs` | 207 942 |
| `tests/project-integration.test.mjs` | 171 110 |
| `tests/engine-2.test.mjs` | 138 395 |
| `tests/engine-4.test.mjs` | 133 341 |
| `tests/engine-3.test.mjs` | 123 189 |
| `tests/benchmark.test.mjs` | 119 250 |
| `tests/engine.test.mjs` | 117 653 |
| `tests/architecture-cli.test.mjs` | 112 324 |
| `tests/ci-graph.test.mjs` | 109 399 |
| `tests/knowledge-refresh.test.mjs` | 99 970 |
| `tests/knowledge-cli.test.mjs` | 82 864 |
| `tests/cargo-fetch-recovery.test.mjs` | 60 640 |
| `tests/project-integration-fence.test.mjs` | 52 467 |
| **Сумма** | **3 322 034** |

Остались в L2 как короткие: `cargo-workspace` — 25 053 мс, `project-worktree-gc` — 21 074, `cargo-slots` — 6 414, `api-cards` — 4 650, `cargo-fast-scope` — 3 713, `project-integration-queue` — 1 564, `project-parallel-gates` — 350, `cargo-lock-coordination` — 254, `diagnostic-pack` — 205, `execution-profile` — 163.

Оценка опирается на мерило `tests/project-parallel-engine.test.mjs`. Локально этот файл шёл 730 399 мс. В шаге `test:waves` на Windows CI сумма его кейсов составила 363 114–518 214 мс, то есть CI ≈ 0,50–0,71 × локального времени. При concurrency 4 L2 короче примерно на 0,50–0,71 × 3 322 034 / 4 мс, то есть на 413–589 с. По семи прогонам (45645526524, 45630500497, 45652087454, 45630658446, 45605431480, 45592552608, 45615441102) медиана L2 снижается с ≈ 33,9 до ≈ 25,0 мин. Самый долгий прошедший прогон даёт ≈ 29 мин вместо 38,8. Сам `test:heavy` — это ≈ 413–589 с работы на четырёх потоках плюс хвост упаковки. Самый долгий файл, `delivery`, стартует первым по списку `priority`. Локально на том же загруженном ПК `npm run test:heavy` прошёл 650/650 за 1 880 701 мс. Четыре тяжёлых файла одновременно шли в ~2,3 раза дольше, чем по одному. Если на CI замедление такое же, шаг займёт ≈ 0,50–0,71 × 1 880 701 мс, то есть ≈ 940–1 335 с. Даже такая пессимистичная оценка оставляет запас до 2 400 000 мс. Это оценка, а не квитанция: подтверждением служат длительности шагов на CI.

Предел отдельных кейсов волновых наборов задаётся в самих тестах. Ни файл, ни runner, ни `run()` в `scripts/run-tests.mjs` своего предела не ставят. Раньше в `tests/project-wave-director.test.mjs` каждый кейс имел `{ timeout: 300000 }`, а в `tests/project-wave-e2e.test.mjs` — `{ timeout: 600000 }`. На медленных раннерах предел 300 с остановил «Three disjoint tasks run in parallel…» (runs 45605431480, 45652087454), «Tasks with overlapping write paths never share a wave» (45630500497, 45652087454), «appendMilestone reopens…» (45605431480, 45630500497) и «drain replaces a gate reservation…» (45652087454). На прошедших прогонах они шли 130–278 с. В e2e «drain accepts two epics…» занял 497 с из 600 (45605431480). Теперь у всех кейсов обоих файлов общий предел 900 000 мс, а пояснение вынесено в комментарий в начале файла. Шаг `test:waves` не подчиняется `CI_COMMAND_TIMEOUT_MS`: это обычный шаг без `timeout-minutes`. Его длительность (1 420 044–2 605 425 мс) задаёт самый долгий из параллельных файлов. На медленном раннере каждый из двух волновых файлов в одиночку занимает ~2 300–2 500 с: director — 1 283–2 419 с, e2e — 1 289–2 492 с суммы кейсов. Поэтому разбиение шага на два ни один из них не укоротит, а последовательные шаги только удлинят job. Сократить шаг можно, разделив сами волновые файлы. Это отдельное решение.

Concurrency отменяет только устаревшие PR runs; main/release события используют уникальный `run_id` и `cancel-in-progress:false`. `setup-node cache:npm` хранит npm tarballs с ключом package-lock; `npm ci --ignore-scripts` снова проверяет lock/integrity. Кэш успешных checks, UI/security receipts, node_modules и чужие приватные данные в Actions не восстанавливаются. Публичный tarball cache не становится доказательством PASS. Частные command-cache policies реализует отдельный `ci-cache`, этот CLI не обходит их и не переиспользует receipts.

Успешное прохождение L2 на одной ОС имеет `crossPlatformVerified:false`; успешный L3 — `deploymentVerified:false`. Живой Windows/Linux CI, установку optional tools на runners, smoke опубликованного артефакта и configured deployment проверяет координатор после интеграции phase03. `disabled` security никогда не даёт успешный L2.

Наблюдения feedback на Windows/Node 24.19.0, финальный проверочный запуск: tiny Git fixture — 2,78 s с настоящими graph/profiler/process/Oxlint и affected test; копия реального Kodo head `24ba7e7` с одним изменённым JS — 4,29 s, 142 сохранённые ambiguity reasons, одна syntax-команда и deferred tests; broad phase03 diff — 11,86 s, blocked quality ownership, 157 сохранённых причин. Это wall одного CLI invocation, без подготовки fixtures; зависимости использованы read-only из ранее установленного дерева через private probe loader. Нет сравнимого baseline, статистики ускорения или подтверждения целевых секунд. Полный suite ни в одном feedback не запускался; tiny fixture запускал только доказанный affected test.

Проверка этой области: `node --test tests/ci-cli.test.mjs`. Урок регрессии: частичная обратная связь должна явно сохранять debt полного L2; отсутствие инструмента или неизвестный ownership нельзя прятать ради скорости. Контрольные символы пути проверяются по кодам символов с сохранением исходных ASCII boundaries, без lint-warning `no-control-regex`.
