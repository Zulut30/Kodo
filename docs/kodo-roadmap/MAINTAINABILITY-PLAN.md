# План: сопровождаемость Kodo после PR #16

Статус: черновик, 2026-11-06. Опирается на повторный анализ ветки `quality/maintainability` (`c2d3940`, CI зелёный на ubuntu и windows).

## Цель

Убрать долг, который остался после PR #16: гигантские функции-фабрики, типы, которые почти ничего не проверяют, неизвестное покрытие и плавающие версии зависимостей. Каждый шаг сделать измеримым храповиком, чтобы долг не возвращался.

## Не цели

- Менять поведение, протоколы, форматы хранилища, CLI или публичный API модулей.
- Переписывать на TypeScript или включать `strict` целиком.
- Ускорять suite вслепую. Медленно идёт только Windows (около 21 мин, а на ubuntu 2.5 мин). Решать это можно только после данных о покрытии из T2.
- Выносить промпты из кода. Длинные строки там безвредны, пользы мало.
- Трогать замороженные файлы `tests/*-oracle.test.mjs` и `tests/*-acceptance.test.mjs`. Они должны оставаться байт в байт такими же и проходить.

## Границы и правила

- Корень: `D:\AIToolkit`. Каждая задача делается в отдельном worktree на ветке `quality/<slug>` от свежего `main`, один PR на задачу.
- Перед работой прочитать `AGENTS.md`, `docs/ARCHITECTURE.md` и `docs/README.md` (раздел «Разработка Kodo»).
- Не трогать: `prompts/` (пользовательский, неотслеживаемый), `skills/**`, фикстуры, `runtime/tool-catalog.json` и замороженные oracle/acceptance-файлы.
- Перед PR выполнить полный `npm run check`. Для быстрой обратной связи при правке — `npm run test:fast`.
- Новый модуль в `runtime/` обязательно добавить в `pins()` в `runtime/architecture-gate.mjs`. Если этот модуль читает Engine, он нужен ещё и в `metadata().sources` в `runtime/benchmark.mjs`.
- При рефакторинге тела функций переносятся без изменения логики. Если по ходу нашёлся настоящий баг, он идёт отдельным коммитом с RED-тестом.

## Порядок и зависимости

```
PR #16 (merge) ─┬─ T1 версии зависимостей
                ├─ T2 покрытие ──────────────┐
                ├─ T3 храповик сложности ────┼─ T5 project-store
                └─ T4 типы (4a → 4b → 4c)    ├─ T6 project-director
                                             ├─ T7 quality-runner
                                             └─ T8 Engine.run и engine-core
```

T1–T4 независимы друг от друга. T5–T8 начинаются только после T2 (по покрытию решаем, где сначала нужны характеризационные тесты) и после T3 (храповик фиксирует результат). T5–T8 между собой независимы.

---

## T1. Точные версии runtime-зависимостей (S) — сделано

**Проблема.** В `package.json` указаны `"ajv": "^8.17.1"` и `"smol-toml": "^1.9.1"`, а остальные зависимости закреплены точно. Для разработчиков lockfile держит `ajv@8.20.0` и `smol-toml@1.9.1`, но пакет, установленный из релизного `.tgz`, разрешит диапазоны заново. Диапазоны появились ещё в `ffa742d` (первый коммит Engine), обоснования в ADR нет.

**Файлы**
- `package.json`: `"ajv": "8.20.0"`, `"smol-toml": "1.9.1"` (версии из `package-lock.json`).
- `package-lock.json`: пересобрать через `npm install --package-lock-only`.
- `tests/package-pins.test.mjs` (новый): каждое значение в `dependencies` и `devDependencies` соответствует `/^\d+\.\d+\.\d+$/`.
- `scripts/run-tests.mjs`: добавить `tests/package-pins.test.mjs` в `fastTests`.

**RED → GREEN.** До правки `package.json` новый тест падает, его сообщение называет `ajv` и `smol-toml`. После правки тест зелёный.

**Приёмка.** `node scripts/run-tests.mjs tests/package-pins.test.mjs tests/test-schedule.test.mjs` проходит. `npm run check` проходит.

**Допущение.** Если владелец намеренно оставил диапазоны для дедупликации у потребителей, T1 снимается, а решение записывается в ADR.

---

## T2. Измерение покрытия (S–M) — сделано

**Проблема.** Неизвестно, что именно проверяют 1817 тестов. Без этого рефакторинг в T5–T8 вслепую рискует сломать непокрытые ветки.

**Файлы**
- `scripts/run-tests.mjs`:
  - новый флаг `--coverage`, совместимый с `--fast`;
  - `runTests({ coverage })` передаёт в `run()` параметры `coverage: true`, `coverageIncludeGlobs: ['adapters/**/*.mjs', 'cli/**/*.mjs', 'runtime/**/*.mjs', 'scripts/**/*.mjs']` и `coverageExcludeGlobs: ['**/fixtures/**']`.
- `package.json`: скрипт `"test:coverage": "node scripts/run-tests.mjs --coverage"`.
- `tests/test-schedule.test.mjs`: тест «`--coverage` принимается, сочетается с `--fast`, а неизвестные флаги по-прежнему отвергаются». Сделать его по образцу существующего теста `Scheduler --fast …`.
- `docs/README.md`, раздел «Разработка Kodo»: команда и первые измеренные числа (line/branch/funcs по всему коду и по модулям из T5–T7).

**Шаг 0 (spike).** Проверить на Node 24.19, что `run({ coverage: true, isolation: 'process' })` собирает покрытие из дочерних процессов и что TAP-репортёр печатает таблицу `# all files | line % | branch % | funcs %`. Если не печатает, используется запасной путь: `node --test --experimental-test-coverage` со списком файлов от `discoverTests()`. Новых зависимостей (c8 и т. п.) не добавлять.

**RED → GREEN.** Сейчас `--coverage` отвергается как `Unsupported test runner option`, после правки флаг принимается.

**Приёмка.** `npm run test:coverage -- --fast` печатает таблицу покрытия. Полный `npm run test:coverage` выполнен один раз, и его цифры записаны в `docs/README.md`. Гейтом покрытие пока не становится.

---

## T3. Храповик сложности функций (S) — сделано

**Проблема.** 47 функций длиннее 100 строк, 16 — длиннее 200. Ничто не мешает появляться новым.

**Проверено.** oxlint 1.91.0 поддерживает `max-lines-per-function` и `complexity`. С порогами 150 и 40 на `runtime/` сейчас 23 и 26 нарушений.

**Решение.** Если отключать правило для целого файла, храповик выйдет слабым: в таком файле можно будет добавить новую гигантскую функцию. Поэтому исключения ставятся точечно, на каждую функцию.

**Файлы**
- `.oxlintrc.json`: `"max-lines-per-function": ["error", { "max": 150, "skipBlankLines": true, "skipComments": true }]` и `"complexity": ["error", { "max": 40 }]`. Для `tests/**` оба правила выключены через `overrides`.
- `package.json`: `lint` = `oxlint --deny-warnings --report-unused-disable-directives .`.
- Над каждой из 34 функций, нарушающих правила сегодня (50 нарушений в 23 файлах), стоит `// oxlint-disable-next-line <rule> -- debt: docs/kodo-roadmap/MAINTAINABILITY-PLAN.md`.
- `docs/README.md`: описание храповика сложности рядом с храповиком типов.

**Проверено.**
- Новая функция на 160 строк роняет lint.
- Удалённая метка роняет lint.
- Метка над функцией, которая уже не нарушает правила, роняет lint с кодом 1: `--report-unused-disable-directives` вместе с `--deny-warnings`.

**Приёмка.** `npm run lint` проходит. Задачи T5–T8 удаляют метки со своих функций, и если метка устарела, lint сам потребует её удалить.

---

## T4. Типы, которые проверяют (M, три PR)

**Проблема.** В baseline 302 диагностики, из них 268 — TS2339 и TS2353. Они возникают из-за того, что `tsc` выводит тип из `options = {}` и из узких сигнатур по умолчанию. Вот откуда берётся шум:
- исполнитель команд `execute(command, args, { cwd, env, signal, input, timeoutMs, allowFailure, secrets, rawOutput })` в `runtime/command.mjs`. Подменяемые `runner` получают более узкий выведенный тип, отсюда минимум 25 случаев TS2353;
- `options` в модулях: `runtime/providers.mjs` (33), `runtime/tools.mjs` (18), `runtime/modes.mjs` (14), `runtime/architecture-gate.mjs` (13);
- объект `run` в `runtime/engine-*.mjs`: `engine-execution` (18), `engine-core` (17).

**Правило для всех подзадач.** Меняются только JSDoc-комментарии, исполняемый код не трогается. Всё, что сокращает baseline, проходит через `npm run typecheck -- --update`. В `git diff scripts/typecheck-baseline.json` допустимы только удаления и уменьшение `count`, новых записей быть не должно.

**4a. Исполнитель команд**
- `runtime/command.mjs`: `@typedef {object} CommandOptions` (все восемь полей), `@typedef {object} CommandResult`, `@typedef {(command: string, args?: string[], options?: CommandOptions) => Promise<CommandResult>} CommandRunner`; `@param` для `execute`.
- Каждый параметр `runner = …` (их найдёт `rg -n "runner =" runtime`) аннотировать как `@param {import('./command.mjs').CommandRunner} [runner]`.
- Приёмка: в baseline нет диагностик с типом `{ allowFailure?: boolean; env?: ProcessEnv; rawOutput?: boolean; … }`, общее число не больше 275.

**4b. Options модулей.** `@typedef` для `options` в `providers.mjs`, `tools.mjs`, `modes.mjs` и `architecture-gate.mjs`. Приёмка: в этих четырёх файлах суммарно не больше 15 диагностик (было 78).

**4c. Запись запуска.** `@typedef {object} KodoRun` в `runtime/store.mjs` (там создаются записи `run`). Аннотировать `run` в методах `EngineCore`, `EnginePlanning`, `EngineExecution` и `EngineVerification`. Приёмка: baseline не больше 150.

**Проверка каждой подзадачи.** `npm run typecheck`, `npm run lint`, `npm run test:fast`, затем `npm run check` перед PR.

**Rollback.** Это только комментарии, поэтому достаточно `git revert` и `npm run typecheck -- --update`.

---

## T5. Декомпозиция `openProjectStore` (L)

**Сейчас.** `runtime/project-store.mjs`: функция `openProjectStore({ store, contracts, authorizeTransition })` на 696 строк, 156 ветвлений, 25 внутренних функций. Состояние: `options`, `db`, кэш валидации (`validationCache`, `validationLimit`, `validationBytes`, `validationSecrets`). Возвращает `{ apply, snapshot, history, installRun }`. Модуль загружается только из `runtime/project-cli.mjs:121` через `await import()`.

**Шаги** (каждый отдельным коммитом, после каждого `node scripts/run-tests.mjs tests/project-store.test.mjs tests/project-director.test.mjs tests/project-director-oracle.test.mjs`):

1. **Характеризация.** По отчёту T2 найти непокрытые ветки `apply` и `installRun` и добавить тесты в `tests/project-store.test.mjs`, пока branch-покрытие `project-store.mjs` не станет не ниже 85 % (или пока не будет записано, почему конкретная ветка недостижима).
2. **Функции без состояния.** `assertGraph`, `attemptRecord`, `metadata`, `complete`, `control`, `decode`, `recordHash` и `body` вынести на уровень модуля, а затем в `runtime/project-store-records.mjs`.
3. **Кэш валидации.** `validated`, `refreshValidationContext` и четыре переменные кэша превратить в `createValidationCache(options)` в `runtime/project-store-validation.mjs`, возвращающий `{ validated, refresh }`.
4. **`apply` (238 строк).** Разбить по типам переходов на функции `(db, options, event)` в `runtime/project-store-transitions.mjs`. Сама `apply` остаётся тонким диспетчером в `project-store.mjs`.
5. **`installRun` (102 строки).** Перенести в `project-store-transitions.mjs` с явными параметрами.
6. Добавить три новых модуля в `pins()` и убрать `project-store.mjs` из `overrides` из T3.

**Приёмка**
- Ни одна функция в `runtime/project-store*.mjs` не длиннее 150 строк и не сложнее 40. Lint с удалённым override проходит.
- Публичный API `openProjectStore` не изменился.
- Oracle-тест Project Director проходит, его SHA-256 не изменился.
- Покрытие модуля не ниже, чем после шага 1.
- `npm run check` проходит.

**Rollback.** Шаги отдельными коммитами, поэтому откатывается последний шаг через `git revert`.

---

## T6. Декомпозиция `createProjectDirector` (L)

**Сейчас.** `runtime/project-director.mjs`: функция `createProjectDirector({ repo, engine, planner, evaluator, clock })` на 657 строк, 143 ветвления, 20 внутренних функций. Единственное состояние — `store`. Возвращает `{ plan, run, resume, cancel, pause, reprioritize, approveRisk }`. Самая большая внутренняя функция — `foreground` (242 строки).

**Шаги**
1. Характеризация по отчёту T2 для `foreground`, `advanceContainers` и `cancel`.
2. Планирование. `frontier` (57), `horizonFor`, `admission`, `retrySettings` и `priorRetryRun` получают `store` явным параметром и переезжают в `runtime/project-director-scheduling.mjs`.
3. `advance` и `advanceContainers` переезжают в `runtime/project-director-progress.mjs`.
4. `foreground` разбивается на фазы `selectWork`, `admitWork`, `executeWork` и `settleWork`, которые получают объект контекста `{ store, engine, evaluator, clock, signal }`. Сама `foreground` — цикл не длиннее 80 строк.
5. Обновить `pins()`, убрать `project-director.mjs` из overrides.

**Приёмка.** Ни одна функция не длиннее 150 строк, `foreground` не длиннее 80. API и oracle неизменны. `npm run check` проходит.

---

## T7. Декомпозиция `quality-runner` (M)

**Сейчас.** В `runtime/quality-runner.mjs` две проблемные функции:
- `parseQualityOutput(check, result, project)`: 241 строка, 152 ветвления. Это цепочка `else if (id === '<tool>')` по 12 инструментам: `oxlint`, `gofmt`, `oxfmt`, `typescript`, `rustfmt`, `cargo`, `go`, `dotnet`, `php`, `phpcs`, `phpstan` и т. д.;
- `runQuality(options)`: 438 строк, 12 переменных состояния, 377 строк инлайн-кода.

**Шаги**
1. Добавить в `tests/quality-runner.test.mjs` (34 теста) недостающие тесты, чтобы у каждого инструмента был хотя бы один случай с находкой и один чистый. Список инструментов взять из цепочки.
2. Ветки парсера вынести в `runtime/quality-parsers.mjs` как `const parsers = { oxlint: parseOxlint, … }`. `parseQualityOutput` остаётся диспетчером: общая проверка `result`, путь для configured-инструментов и `parsers[id]`.
3. `runQuality` разбить на `prepareQualityRun(options)` (возвращает контекст с `plan`, `timeoutMs`, `maxOutputBytes`, `evidenceRoot`, `env`, `secrets`), `runQualityCheck(context, check)` и `finalizeQualityReceipt(context)`.
4. Обновить `pins()`, убрать файл из overrides.

**Приёмка**
- Функция `parseQualityOutput` не длиннее 40 строк, каждый парсер не длиннее 60.
- `runQuality` не длиннее 80 строк.
- `tests/quality-runner.test.mjs` и `tests/quality-protocol-regressions.test.mjs` проходят.
- `npm run check` проходит.

---

## T8. `Engine.run` и связность `engine-core` (M)

**Сейчас.** `Engine.run` в `runtime/engine.mjs` занимает 271 строку. `runtime/engine-core.mjs` импортирует 21 локальный модуль и остаётся центром, через который проходит всё.

**Шаги**
1. Подготовку окружения worker (`executionEnvironment`: npm cache, rtk, PATH) перенести из `EngineCore` в `runtime/worker-environment.mjs` как функцию с явными параметрами `(store, run, cwd, tools)`. В `EngineCore` остаётся тонкая обёртка.
2. `Engine.run` разбить на фазы `prepareRunPhase`, `planPhase`, `executePhase` и `verifyPhase`, которые становятся методами того слоя, которому они принадлежат.
3. Обновить `pins()` и `metadata().sources`, убрать файлы из overrides.

**Приёмка**
- `engine-core.mjs` импортирует не больше 15 локальных модулей.
- `Engine.run` не длиннее 100 строк.
- `tests/engine*.test.mjs` и `tests/engine-delivery-contract.test.mjs` проходят.
- `npm run check` проходит на ubuntu и windows в CI.

---

## Итоговые критерии плана

- В `.oxlintrc.json` блок `overrides` из T3 пуст или содержит только файлы с записанным обоснованием.
- Baseline типов не больше 150 (было 302).
- Покрытие измерено, а цифры по модулям из T5–T7 не ниже исходных.
- Публичный API модулей, формат хранилища и замороженные oracle/acceptance-файлы не изменились.
- Каждый PR прошёл `npm run check` локально и в CI.

## Нерешённые вопросы

- Диапазоны в T1 могли быть намеренными. Нужно решение владельца.
- В шаге 0 T2 нужно подтвердить, что покрытие собирается при `isolation: 'process'`.
- Сокращать ли время Windows-suite (около 21 мин): это решается после T2 отдельным планом.
