# Этап F2: исполнение волн и внешние воркер-чаты

Статус на 2026-11-18: **реализация сведена, кандидат на ревью.** Ветка — интеграция двух веток F2 поверх исправлений ревью F1 (`2c7e836`): исполнение волн (`kodo project drain`) и pull-протокол внешних воркер-чатов T3 (`next-wave`/`complete-task`). Проверки замороженного head, ревью и CI — в описании PR этапа.

Этап продолжает [F1](phase-f1.md): F1 дал данные, профили проверки, интеграционную ветку и evaluator волн; F2 исполняет волновой проект до приёмки — сам (`drain`) или руками видимых чатов хоста.

## Что сделано

| Часть | Реализация | Проверка |
| --- | --- | --- |
| Исполнение волн | `project-director-waves.mjs`: `drain` (волны непересекающихся задач параллельно через Engine, интеграция по одной, гейты эпиков), `resume` wave-проекта = `drain` одной волны одной задачи, `cancel` останавливает gate Run; CLI `project-cli-wave.mjs` | `tests/project-wave-director.test.mjs`, `tests/project-wave-cli.test.mjs` |
| Pull-протокол T3/Orca | `project-external.mjs` (`nextWave`, `completeTask`), `worker-roles.mjs`, CLI `project-cli-external.mjs` | `tests/project-external.test.mjs`, `tests/project-external-cli.test.mjs` |
| Один авторизатор | `createProjectTransitionAuthorizer` → `evaluateWaveTransition` + `validateWaveRun` F1 для нативных задач, задач внешних чатов (профиль `task-fast`, `executor.kind === 'external'`) и gate Run | `tests/task-fast-checks.test.mjs`, сквозной тест |
| Владение резервом | actor события `reserveAttempt` (`project-director` / `project-external:<host>`) и `executor` Run; `attemptExecutor` в обоих путях | `tests/project-wave-e2e.test.mjs` |
| Сквозной сценарий | Реальные Store, project store, authorizer, Engine с fake-провайдерами, временный Git, без fake-портов | `tests/project-wave-e2e.test.mjs` |

Описание: [PROJECTS.md](../PROJECTS.md) («Волновой режим: исполнение (drain)»), [T3-HOST.md](../T3-HOST.md).

## Сведение веток

Обе ветки писались поверх `95a7c24` (F1 до ревью) и адаптированы к контрактам после ревью:

- Авторизатор. Дубли (`authorizeWaveTransition`/`validateWaveRun` директора и `createExternalTransitionAuthorizer` хоста) удалены, остался `authorizeWave`/`validateWaveRun` F1. Добавлено: у задачи — `verificationProfile: 'task-fast'`; Run, ещё не `succeeded` (внешний чат работает), проверяется только по binding и источнику (evaluator даёт не больше `running`/`verifying`); у `succeeded` — Git-сверка записанного слияния (merge-коммит в ветке, второй родитель — `run.headSha`); у гейта — `run.headSha` уже в интеграционной ветке. Ref приёмки контейнера сверяется с наблюдением gate Run точно: `verifyRef` в режиме контейнера отвергал `project-acceptance`, и ни один контейнер не мог быть принят.
- `run` wave-проекта по-прежнему отказывает `project_wave_drain_required`; `resume` снимает паузу и исполняет `drain` одной волны (`status: succeeded` при `accepted`/`max_waves`, исходный — в `drainStatus`).
- Гейт ставится штатным `createGateRunDraft({..., installGateRun, leaseHeld|withLease})`; обход директора (установка без `nodes`/`completed` и их восстановление) удалён. Резерв и установка — под одним lease `project-integration:<id>`.
- `mergeBackGate({expectedHead: gate.headSha, gateHead: run.headSha})`; блокер `wave_gate_head_changed` удалён — гейт с ремонтом принимает задачи, эпик и покрытые контейнеры.
- `mergeTask` получает `pending` из `run.integration` (`status: 'pending'`).
- Рабочая папка интеграции — общая `integrationHome(store)` (как у Engine: вне Git-checkout со state).
- Внешний Run получает `review: null`: иначе наблюдение `acceptance` с `review: undefined` не совпадало с JSON-конвертом evidence и интеграция внешней задачи блокировалась.
- `complete-task` держит lease `project:<id>` (с продлением), записывает `externalCompletion` до гейтов и продолжает прерванную интеграцию проверенного head.
- `tests/task-fast-checks.test.mjs`: `resume` больше не отказывает; из `tests/project-wave-director.test.mjs` удалён дубль теста F1 про профилированную квитанцию (`assertFullChecks` директора слит в `assertFullReceipts` F1).

## Исправления по ревью

Оставшиеся находки независимого ревью F1 и открытые вопросы сборки F2. У каждой — регрессионный тест, падавший на `13ef8c1` (runtime базы, тесты новые) и проходящий после исправления.

| Находка | Исправление | Тест |
| --- | --- | --- |
| blocker: гейт с `baseSha === headSha` проверял и принимал пустой diff | База — first-parent родитель самого раннего покрытого merge-коммита (`gateBase`/`gateRange` в `project-integration.mjs`). Store при `reserveGate`: база ≠ голова, база — записанный `integration.before` покрытого слияния, порт `gateRange` (Git) подтверждает, что каждое слияние — строгий потомок базы внутри головы. `createGateRunDraft`: тот же диапазон и первый родитель каждого слияния = `integration.before`. Evaluator: `gate.baseSha ≠ gate.headSha`, `run.headSha ≠ gate.baseSha`, ревью не по пустому diff; `validateWaveRun`: диапазон и непустой `git diff gate.baseSha run.headSha` | `tests/project-wave-store.test.mjs`, `tests/wave-verifier.test.mjs`, `tests/project-wave-evidence.test.mjs` |
| blocker: `integrated`/`accepted` расходились с Git (откат слияния, приёмка без слияния в ветке, сдвиг головы во время проверки проекта) | `runtime/project-integration-lease.mjs`: реентерабельный lease `project-integration:<id>` в асинхронном контексте; авторизатор требует его для `integrated` и `accepted` (`project_integration_lease_required`), вызывающий держит его до фиксации. Git-сверка: merge-коммит достижим из текущей головы, родители `[integration.before, run.headSha]`; у гейта — каждое покрытое слияние на ветке, проверенная голова в ветке; голова проекта перечитывается после проверок (`project_integration_head_changed`). `acceptGate` (mergeBack и все приёмки) — под одним lease | `tests/project-wave-director.test.mjs` («integrated is authorized only under the integration lease…», «The project is accepted only on a head still current…»), `tests/task-fast-checks.test.mjs` |
| major: устаревший неустановленный резерв гейта нельзя заменить; повтор установки после сдвига ветки давал `gate_head_stale` | Store: новый резерв того же `containers[0]` при `installed:false` и другой голове разрешён, прежний помечается `supersededBy` (необязательное поле записи гейта) и не ставится. `createGateRunDraft` возвращает Run установленного гейта через `installGateRun` до проверки головы. Drain на `gate_head_stale` резервирует гейт на текущей голове | `tests/project-wave-store.test.mjs`, `tests/wave-verifier.test.mjs`, `tests/project-wave-director.test.mjs` («drain replaces a gate reservation…») |
| major: 240 задач в 24 эпиках — `project_gate_too_large` у гейта проекта | Контракты покрытых задач — в манифесте `buildGateManifest` (evidence-артефакт `gate-manifest` Run, ссылка `run.gateManifest`); текст Run — компактная сводка с SHA-256 манифеста; `validateWaveRun` проверяет артефакт по хэшу | `tests/project-wave-large-gate.test.mjs`, `tests/project-wave-contracts.test.mjs` |
| вопрос F2: `drain --retry-failed` перевыполнял нативно задачу внешнего чата | Повтор — тем же исполнителем: drain только свои нативные (`wave_retry_executor`), `next-wave --retry-failed` — только своего хоста (`project_retry_executor`) | `tests/project-wave-e2e.test.mjs`, `tests/project-external.test.mjs` |
| вопрос F2: `next-wave` выдавал задачу с непроверенными `interfaceRefs` | `selectWave` получает `availability` (`waveAvailability`, как drain/horizon); резерв дополнительно проверяет интерфейсы (`project_interface_unverified`) | `tests/project-external.test.mjs`, `tests/project-external-cli.test.mjs` |
| вопрос F2: в quick gate Run без перепроверки ремонта | `repairRounds = max(2, профиль)` (`GATE_MIN_REPAIR_ROUNDS`) | `tests/wave-verifier.test.mjs` |
| вопрос F2: `wave_project_head_mismatch` оставлял проект `integrated` | `runPendingGates` резервирует гейт `[project]` на текущей голове; Store разрешает новый гейт проекта при `succeeded` прежнем с другой головой | `tests/project-wave-director.test.mjs` («When the branch moves after an epic gate…») |

Изменённые контракты: `buildGateInput` → `{schemaVersion: 2, projectId, gate, taskCount, manifest}` (+ `buildGateManifest`), gate record `supersededBy?`, черновик gate Run `gateManifest`, `openProjectStore({..., gateRange})`, `createProjectTransitionAuthorizer` требует lease для `integrated`/`accepted`. Новые коды: `project_integration_lease_required`, `project_integration_head_changed`, `project_gate_range_invalid`, `project_gate_manifest_invalid`, `project_interface_unverified`, `project_retry_executor`, `wave_retry_executor`. Legacy-проекты и golden-хэши без изменений.

## Границы

- Все мутации wave-проекта (`drain`, `next-wave`, `complete-task`) сериализует lease `project:<id>`; pull-команды во время `drain` отвечают `project_busy`. Переходы, чьё доказательство читает интеграционную ветку, — ещё и lease `project-integration:<id>` до фиксации.
- Задачи всегда идут в режиме quick; гейт берёт `executionMode` проекта, но не меньше двух раундов ремонта.
- Lease защищает только от записей Kodo; ручной сдвиг ветки ловят повторные Git-проверки авторизатора. Откат содержимого через `git revert -m 1` (merge-коммит в истории остаётся) сверка графа не видит — его ловит следующий гейт.
- Гейт проекта повторяется в одном проходе не больше двух раз подряд, затем `wave_project_head_mismatch`.
- `released` в волновом режиме не поддерживается (`project_wave_delivery_unsupported`).
- Orca использует тот же протокол, но с Orca не проверялся.

## Что не сделано в F2

Чертёж проекта и `bootstrap`/`extend` (F3); доставка и релиз волнового проекта; реальные провайдеры и чаты хоста в тестах (только fake-провайдеры и сымитированный воркер-коммит).
