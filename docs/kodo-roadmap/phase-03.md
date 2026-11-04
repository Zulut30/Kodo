# Этап 03 — быстрые проверки, CI и параллельная работа

2026-11-04. **DRAFT, NOT ACCEPTED.** Phase02 / PR11 ещё не принят. Пользователь выбрал [MVP всех13этапов](MVP-SCOPE.md); расширенные benchmark и системная инструментализация перенесены после MVP. Worktree реализуются параллельно, приёмка и доставка этапов сохраняют порядок.

`kodo ci plan|run|profile` предоставляет L0–L3 через существующие quality/process/security boundaries. Отдельный `kodo ci feedback --base SHA --json` даёт короткую обратную связь: при доказанном графе выполняются affected tests; при ambiguity полный набор откладывается в обязательный exact-head L2. `feedback_ready` всегда означает `complete:false`, `requiresFullCheck:true`. Strict L1 сохраняет broad fallback. Missing/disabled/unsupported не становятся PASS.

Пять реальных scoped чатов подготовили pool, Windows test split, profiler, graph/private cache и CI. Четыре feature-компонента объединены в owned preview; split уже включён в maintenance02 и повторно не объединяется. Новые runs поддерживают capacity1–5, quick остаётся1, нижние saved budgets и explicit model сохраняются. Project capacity5 не меняет сохранённый run02.

`npm test` теперь использует `node --test --test-concurrency=4`; `npm run check` остаётся `npm run validate && npm test`, набор сохранён. Node24 не разрешает test-concurrency в NODE_OPTIONS. Required Windows/Linux job names и installed package smoke сохранены; PR concurrency отменяет только устаревшие PR runs. Actions cache хранит npm tarballs, не successful checks. [ADR-0006](../decisions/0006-tiered-ci-and-parallel-capacity.md), [CI](../CI.md), [граф/cache](../AFFECTED-CACHE.md), [профилировщик](../CI-PROFILER.md).

| Requirement | Evidence |
| --- | --- |
| Быстрый feedback сохраняет ambiguity и L2 | `CI feedback fallback keeps ambiguity defers full tests and never claims complete L1`; `CI feedback runs only proven affected tests without broad fallback` |
| Полные проверки остаются обязательными | `CI graph fallback runs broad tests and full quality scope`; `CI L2 always runs full check and fresh security with platform scope` |
| Cache требует свежий контекст и intact evidence | `Command cache requires freshly supplied complete context on every read`; `Command cache detects tampered envelope missing output and changed output bytes` |
| Strict CI проверяет фактическое чистое дерево | `CI acceptance blocks dirty source before execution and mutation under an unchanged HEAD`; `CI acceptance never passes when current source state cannot be verified` |
| Пакет содержит работоспособный reporter asset | `Packed CI reporter loads by installed runtime file URL and observes one real passing test` |
| Пять сессий и корректные зависимости | `Engine has five actually active fake native sessions behind one subscription barrier`; `Five-slot Engine scheduler serializes conflicting scopes dependencies and integrations` |

## Наблюдения

После композиции на `b69e344` suites ci-cli/ci-graph/ci-cache/ci-profiler/concurrency-five/runtime дали **85 PASS /0 FAIL/0 SKIP**, 28456.1407ms, concurrency4. Предыдущие scoped receipts: pool53+3, Windows61, profiler14, graph/cache17; новый CI28. Это не полный repository gate. Сохранён composition RED112/113: исправлен только совместимый config error message; отрицательный предел3→6 сохраняет assertions.

Настоящий Node/Git/Oxlint feedback: tiny fixture **2781.1951ms**, только dependent test; малая JS-правка реального Kodo **4294.7858ms**, 142 ambiguity reasons сохранены, tests deferred. Большой diff03: **11860.8778ms**, **blocked** из-за существующего quality scope, 157 reasons. Это одиночные локальные наблюдения, не benchmark или ускорение Actions. Global graph reasons раньше приводили к повторению L2; feedback больше не запускает второй fullsuite, strict L1 остаётся консервативным.

Private cache требует полный freshly supplied input при каждом read; иначе miss. Регрессия RED1→GREEN9. UI/security не кэшируются. L2 file timings через inherited NODE_OPTIONS сломали nested reporter test (`2 != 1`): вариант удалён, raw failure сохранён. MVP наблюдает L1 file events и L2 command wall; остальные system/file timings остаются null.

Strict L1–L3 дополнительно проверяют чистое фактическое дерево до/после исполнения; стабильного HEAD недостаточно. Сценарии с настоящим Git дали RED3→GREEN33; partial feedback по-прежнему complete:false. Проверка настоящего offline `.tgz` выявила отсутствовавший `scripts/ci-reporter.mjs`: Node завершался с `ERR_MODULE_NOT_FOUND`, exit7. Теперь поставляется только необходимый asset; regression и пять соседних CI/profile tests PASS. Node загрузил reporter по URL распакованного пакета в пути с пробелом и `#`, наблюдал TAP и два реальных summary events. Это scoped artifact execution, не полный installed CLI smoke или опубликованный выпуск.

## Следующий gate и ограничения

Full integrated check, fresh enabled gates, independent review и live required Windows/Linux CI feature-head — **NOT VERIFIED**. Release/deployment не выполнялся. Broad quality требует проектного source ownership для vendored snippets/auxiliary fixtures; исключений ради зелёного CI нет. Fast job пока нельзя делать обязательным gate неподготовленного проекта. Phase02 fixes должны войти в итоговую интеграцию до приёмки. Private receipts сохраняют hashes, commands и failures; пользовательский checkout не изменён.
