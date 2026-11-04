# Этап 03 — быстрые проверки, CI и параллельная работа

2026-11-04. **DRAFT, NOT ACCEPTED; pending full/review/CI.** Phase02 принят: [PR #11](https://github.com/Zulut30/Kodo/pull/11), merge `dabecb7bec7514116e3b2870c04270bb4f83ee77`. На `f72ca96f5e60a7bbc760cd2aa2ce6eb06b2c5cf2` local full: 870 tests /864 PASS/6 SKIP; [CI41877990343](https://github.com/Zulut30/Kodo/actions/runs/41877990343): Linux872/854 PASS/18 SKIP, Windows870/864 PASS/6 SKIP, без failures. Это evidence phase02, не phase03. Пользователь выбрал [MVP всех13этапов](MVP-SCOPE.md); расширенные benchmark и системная инструментализация перенесены после MVP. Приёмка и доставка этапов сохраняют порядок.

`kodo ci plan|run|profile` предоставляет L0–L3 через существующие quality/process/security boundaries. Отдельный `kodo ci feedback --base SHA --json` даёт короткую обратную связь: при доказанном графе выполняются affected tests; при ambiguity полный набор откладывается в обязательный exact-head L2. `feedback_ready` всегда означает `complete:false`, `requiresFullCheck:true`. Strict L1 сохраняет broad fallback. Missing/disabled/unsupported не становятся PASS.

Отдельные coordinator-owned workers подготовили pool, Windows test split, profiler, graph/private cache и CI. Provenance компонентов сохранён координатором в `run.coordinatorComponentManifests` и приватном `phase03-adoption.json`; эти исполнители не являются пятью Native plan nodes текущего run. Четыре feature-компонента приняты в интеграцию; split уже включён в phase02 и повторно не объединяется. Новые runs поддерживают capacity1–5; без явной ёмкости quick остаётся1, а его routing всегда последовательный. Нижние saved budgets и explicit model сохраняются. Project capacity5 не меняет сохранённый run02.

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

## Проверка совместимости 2026-11-04

Назначенный чистый worktree `validate-ci-integration`, ветка `kodo/3bd9a27c-4f34-4ccb-b5ee-6540be8a732a-validate-ci-integration`, исходный HEAD `8c24da1b6e1183030528f3cc3478f73b4af17855`, base `dabecb7bec7514116e3b2870c04270bb4f83ee77`. Сверены только component diff и прямые callers: graph→CI/cache, profiler→CI/reporter/script, package asset URL, config/modes→Engine/CLI. Подтверждённого interoperability-дефекта нет; runtime/tests/package не изменялись этим worker. После scoped прогона координатор поручил только opt-in условие нового optional `fast` job и документацию.

Точная offline команда:

```powershell
node --test --test-concurrency=4 tests/ci-cli.test.mjs tests/ci-graph.test.mjs tests/ci-cache.test.mjs tests/ci-profiler.test.mjs tests/ci-package.test.mjs tests/concurrency-five.test.mjs tests/runtime.test.mjs
```

Итог: **91 tests /91 PASS/0 FAIL/0 cancelled/0 SKIP/0 TODO**, 32788.265ms. Семь файлов дали соответственно 33, 9, 9, 14, 1, 15 и 10 PASS (включая вложенные subtests). Windows x64, Node24.19.0, V8 `13.6.233.17-node.51`, ABI137, npm12.0.2. Это один локальный scoped прогон; wall не является benchmark, сравнением с baseline или оценкой ускорения.

Fingerprint чистого проверенного HEAD через публичный `planAffected`:

| Поле | SHA-256 |
| --- | --- |
| `sourceHash` | `0a4b4d89f71e197fda205a0ce5da7f76626051c19b9f49b6dcea24b7f0860ac0` |
| `dependencyHash` | `6fcf55271b7f9f0a3a4f10ba07bd4c93e29c04d2b951ed34723fe0b0fc681a6e` |

Метод sourceHash — SHA-256 JSON отсортированного Git inventory `[file,mode,GitBlobOID]`; dependencyHash — manifests/locks и resolved graph edges по [контракту](../AFFECTED-CACHE.md). Хеши относятся к указанному HEAD до этого docs-only отчёта, не к будущему merged/frozen head; это не reusable PASS receipt. В данном Windows app environment logical `%LOCALAPPDATA%` alias отличается от Git toplevel: планирование через alias отклонено `Affected project must be the repository root`. Для наблюдения использован фактический Git toplevel того же worktree (`Packages/OpenAI.Codex_2p2nqsd0c76g0/LocalCache/Local/Kodo-Worktrees/...`); root/noLinks проверки не ослаблялись.

Дополнительная offline probe связала реальные ci-cli/graph/profiler/process и поставленный reporter на owned Git fixture с путём `project space #`: исполнен только `dependent.test.mjs`, 1 PASS/0 FAIL и ровно одно file-summary; независимый намеренно падающий тест не запускался, HEAD неизменен. Quality detect/plan/run подставлены как `not_applicable`, поэтому probe не сертифицирует quality tools или gates. Packaging suite действительно создала offline tarball и выполнила reporter из распакованного runtime URL; полный установленный CLI smoke остаётся отдельным gate.

Точные regression names дополнительно к таблице требований:

| Контракт | Test name |
| --- | --- |
| Feedback affected tests | `CI feedback runs only proven affected tests without broad fallback` |
| Неизвестный source | `CI acceptance never passes when current source state cannot be verified` |
| Context invalidation | `Command cache fingerprints invalidate source dependency lock HEAD runtime tools arguments environment and gates` |
| Node file events | `Node24 real events distinguish file duration from deceptive test name and retain failed TAP` |
| Saved budgets, quick default и CLI precedence | `New run CLI concurrency beats project config and saved lower concurrency survives resume preparation` |
| Jev threshold и fixed model | `Five-slot capacity obeys actual Jev routing threshold without bypassing serial decisions`; `Fixed-model scheduling retries and Jev failure retain the exact model without escalation` |
| Неизменность workflow gates | `CI workflow keeps required full platform contexts smoke lock cache and PR cancellation` |

На том же clean source реальный L1 **план**, без исполнения checks: 33 changed paths, 53 test files, `fallback:true`, 156 ambiguity reasons (12 unsupported-syntax, 9 причин внутри pinned upstream). Broad tests сохраняются; quality-plan **blocked**: `unambiguous_csproj_required`, `tsconfig_required`, `htmlvalidate_project_config_required`. Source/vendor ownership остаётся нерешённым; exclusions и policy не менялись. Private cache API не подключён к пропуску команд CI CLI: проверен его публичный контракт, автоматическое ускорение через reuse не заявляется.

По уточнению координатора новый optional Actions `fast` получил `${{ vars.KODO_FAST_CI_ENABLED == 'true' }}`: absent variable означает skipped/neutral, не PASS. Включение — только координатором после подготовки и проверки source ownership. Локальная проверка условия дала meaningful RED (отсутствует opt-in) → GREEN; отдельно проверены отсутствие этого условия у required `check`, matrix Windows/Linux, L2, security, installed smoke и неизменный `scripts.check`. Семь suites не перезапускались после этой YAML/docs-only правки по поручению координатора; их 91 PASS относятся к указанному исходному HEAD. Реальные Actions остаются pending на окончательном head.

## Следующий gate и ограничения

Full integrated `npm run check`, fresh enabled security gates, independent differential review и required Windows/Linux CI phase03-head — **PENDING у координатора**, worker их не запускал. UI **disabled / not-applicable**, не PASS; live native/provider checks, полный installed CLI smoke, published artifact и deployment этим worker не проверялись. Выпуска/deployment phase03 нет. Required names `check (ubuntu-latest, 24)` и `check (windows-latest, 24)`, `npm run check`, security и package smoke сохранены. Broad quality требует проектного source ownership для vendored snippets/auxiliary fixtures; исключений ради зелёного CI нет. Fast job пока нельзя делать обязательным gate неподготовленного проекта. Пользовательский checkout не изменён. Метрики native HTTP, точный subscription USD, pure LLM latency и measured benchmark winner не наблюдались и не заявляются.
