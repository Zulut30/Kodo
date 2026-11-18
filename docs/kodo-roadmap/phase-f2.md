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

## Границы

- Все мутации wave-проекта (`drain`, `next-wave`, `complete-task`) сериализует lease `project:<id>`; pull-команды во время `drain` отвечают `project_busy`.
- Задачи всегда идут в режиме quick; гейт берёт `executionMode` проекта. В quick `repairRounds: 1` не оставляет повторной проверки после ремонта — ремонт в гейте требует standard/deep и `repairRounds ≥ 2`.
- Резерв гейта, установка которого прервалась, а голова ветки затем сдвинулась, остаётся с блокером `gate_head_stale` (Store не даёт зарезервировать новый гейт, пока прежний Run не остановлен).
- Приёмка проекта при сдвиге ветки после резерва гейта проекта оставляет проект `integrated` (`wave_project_head_mismatch`); штатно не возникает.
- `released` в волновом режиме не поддерживается (`project_wave_delivery_unsupported`).
- Orca использует тот же протокол, но с Orca не проверялся.

## Что не сделано в F2

Чертёж проекта и `bootstrap`/`extend` (F3); отдельный гейт уровня проекта для восстановления после `wave_project_head_mismatch`; замена устаревшего неустановленного резерва гейта; доставка и релиз волнового проекта; реальные провайдеры и чаты хоста в тестах (только fake-провайдеры и сымитированный воркер-коммит).
