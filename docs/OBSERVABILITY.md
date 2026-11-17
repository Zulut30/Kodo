# Операционный отчёт по Run и Project

`kodo report` показывает, как прошёл сохранённый Run или Project: сколько заняло времени, где ждали, сколько было попыток и сессий, сколько фактически потрачено токенов, насколько полны наблюдения, что сломалось и что блокирует сейчас. Отчёт собирается из уже сохранённых данных Kodo. Отдельного сборщика, демона или новой таблицы нет.

```powershell
kodo report RUN_ID [--json]
kodo report --project PROJECT_ID [--json]
kodo project report PROJECT_ID [--json]   # алиас второй формы
```

Без `--json` печатается короткая сводка, с `--json` — один JSON-объект (схема 1). Для дерева исходников: `node cli/index.mjs report RUN_ID --json`.

## Граница чтения

- Аргументы разбираются строго до чтения ключей и состояния. `RUN_ID` и `PROJECT_ID` — UUID в нижнем регистре, `--json` и `--project` допускаются один раз, ровно одна цель.
- `state.sqlite` из `KODO_HOME` открывается только для чтения (`readOnly: true`, `query_only`). Если в WAL нет непримененных кадров, файл открывается как `immutable`, поэтому не появляются `-wal`/`-shm`. `Store` не открывается, миграции не выполняются, leases не берутся, файлы в каталоге состояния не создаются и не меняются. Если WAL содержит кадры без файла `-shm`, отчёт отказывает с `report_unavailable`, а не восстанавливает базу.
- Ключи загружаются так же, как в `kodo jobs`, только для redaction вывода. Как и там, загрузка может создать пустой каталог учётных данных вне `KODO_HOME`.
- Модели, провайдеры, Git и сеть не вызываются. Тест `tests/report-cli.test.mjs` запускает CLI под offline-guard и проверяет 0 сетевых и 0 провайдерских попыток, а также что содержимое каталога состояния не изменилось ни в одном байте.
- В вывод попадают только числа, время и фиксированный словарь: коды ошибок, стадии, id узлов и задач, имена клиентов и моделей, команды проверок. Тексты ошибок, сообщения блокеров, задачи, промпты и пути не выводятся. Весь отчёт проходит `redact` с известными ключами.

| Код | Выход | Когда |
| --- | --- | --- |
| — | 0 | Отчёт построен, даже если наблюдения неполные |
| `report_arguments` | 1 | Неверные аргументы; состояние не открывалось |
| `report_not_found` | 1 | Нет базы, Run или Project |
| `report_unavailable` | 2 | База повреждена, нужна writer recovery, ошибка чтения или ключей |

Ошибка — это `{ "schemaVersion": 1, "kind": "error", "status": "invalid" \| "blocked", "code": "..." }`. Аргументы и пути в ней не повторяются.

## Семантика неизвестного

- **Неизвестное — `null`, никогда не `0`.** Сумма известна, только если известно каждое слагаемое. Это то же правило, что у `aggregateMetrics`. Рядом всегда стоят `known` и `total`: сколько наблюдений известно и сколько их было.
- **Неудачи и незавершённые наблюдения входят в знаменатель.** Сессия со статусом `failed` или `started` (идёт или прервана) считается в `sessions`, `failedSessions`/`pendingSessions` и в `total` каждого поля. Её неизвестная длительность делает сумму неизвестной.
- **Prompt bytes ≠ tokens.** `promptBytes`, `context.originalBytes` и `context.sentBytes` — это локальные UTF-8 размеры. Токены берутся только из usage, который сообщил native-клиент.
- **Elapsed ≠ чистая LLM latency.** Длительность сессии включает клиент, инструменты, сеть и ожидание. Wall time включает простои, паузы и ожидание повторов.
- **Платформы не сравниваются.** Платформа записывается только в квитанции release smoke (`release.smoke.platform/node`). Отчёт перечисляет её в `provenance.platforms`, а при нескольких платформах в Project добавляет заметку `mixed_platforms`. Отчёт ничего не ранжирует и не выбирает «победителя».
- `provenance.complete` равно `true`, только когда Run завершён и известны все наблюдения по сессиям (число, длительность, токены, prompt bytes), а окна ожидания закрыты. Иначе `provenance.notes` перечисляет пробелы. `provenance.limitations` — постоянные оговорки, которые не зависят от конкретного Run.

## Run: `kind: "run"`

| Поле | Источник | Смысл |
| --- | --- | --- |
| `runId`, `state`, `client` | `runs.body` | Как в сохранённом Run |
| `mode` | `executionMode.selected` | Выбранный режим или `null` |
| `models[]` | `sessionAttempts[].client/model` | `{client, model, sessions}`. `null`, если Run не сохранил попытки сессий |
| `timing.createdAt` | `createdAt`, иначе время события `created` | ISO |
| `timing.finishedAt` | время последнего события, тип которого равен конечному `state` (`succeeded`, `blocked`, `cancelled`, `waiting_limits`) | `null`, пока Run не завершён |
| `timing.wallMs` | `finishedAt − createdAt` | Включает простои и паузы. `null`, если нет одного из концов |
| `timing.stages.<stage>` | см. ниже | `{durationMs, sessions, operations, known, total, source}` |
| `queue` | `kodo_job_events` очередей `run:<RUN_ID>:*` | `{jobs, waitMs, known, total, source}`. Ожидание — время в `queued`/`blocked` до выхода из этих состояний. Без durable scheduler заданий нет: `jobs: 0`, `waitMs: null` |
| `queue.delivery` | события `delivery.queue_waiting` | Ожидание lease очереди доставки, `{waitMs, polls, known, total, source}` |
| `checks.runs[]` | `checks.results` | `{kind, command, durationMs, exitCode}` последнего раунда проверок |
| `checks.totalMs` | `checks.results[].durationMs` | Engine не сохраняет длительность команд проверки, поэтому обычно `null` (ограничение `check_duration_not_recorded`) |
| `checks.executions`, `checks.reused` | события `check_started`, `checks_reused` | Сколько команд запускалось за всю историю и сколько раз проверки переиспользовались |
| `checks.ci` | события `delivery.checks_waiting` | Ожидание CI перед merge |
| `attempts` | `sessionAttempts`, `nodes[].attempt`, события | `{sessions, failedSessions, pendingSessions, nodeAttempts, verificationRounds, repairRounds}` |
| `usage` | `aggregateMetrics(sessionAttempts)` | Полный агрегат `metrics.mjs` с `completeness`. У Run без `sessionAttempts` поле `sessions` равно `null` |
| `context` | `usage.contextOriginalBytes/contextSentBytes` | Локальные байты, не токены |
| `failures[]` | события `node_failed`, `delivery.command_failed`, `blocked`/`cancelled`/`waiting_limits`; неуспешные сессии и проверки; операции доставки без read-back | `{code, scope, at}`. `at` равно `null`, если у источника нет времени. Не более 200 записей |
| `blocker` | `blocker.current` | `{code, scope, firstSeen, lastSeen, occurrences, resolved}` без текста сообщения. `null`, если блокера нет |
| `watchdog` | `watchdog` | `{stalled, rounds, progressedRounds, stopped}` |
| `provenance` | — | `{source: "kodo-state", generatedAt, platforms, complete, notes, limitations}` |

### Стадии и их источники

| Стадия | Наблюдения | `source` |
| --- | --- | --- |
| `assessment` | `coordinatorOperations` вида `assessment` | `coordinator-operations` |
| `analysis` | `coordinatorOperations` видов `analysis`, `research`, `discovery`, `routing` | `coordinator-operations` |
| `planning` | сессии стадии `plan` | `session-attempts` |
| `implementation` | сессии ролей `developer`, `tester`, `documenter` | `session-attempts` |
| `verification` | сессии `repair` и `checks.results[].durationMs` | `session-attempts+check-results` |
| `review` | сессии `review` | `session-attempts` |
| `delivery` | операции `pr`, `merge` журнала доставки: от intent до read-back | `delivery-operation-journal` |
| `release` | операция `release` журнала доставки | `delivery-operation-journal` |

`durationMs` стадии — это сумма измеренных длительностей её наблюдений, а не интервал между событиями. Параллельные сессии складываются, поэтому сумма может превышать wall time. Время между наблюдениями (подготовка worktree, слияние, простои) в стадии не попадает. Стадия без наблюдений даёт `durationMs: null`, `total: 0`, `source: null`.

Раунд проверки — это одна непрерывная серия событий `check_started` или одно событие `checks_reused`. Ремонтный раунд — событие `repair_required`.

Окно ожидания по событиям (`queue.delivery`, `checks.ci`) начинается с первого события опроса в серии и закрывается ближайшим событием другого типа. Если после серии опросов других событий нет, окно остаётся открытым (`waitMs: null`, заметка `ci_wait_open` или `delivery_queue_wait_open`). Если процесс прервался во время ожидания, окно включает простой до следующего события. Если событий опроса нет, `waitMs` равно `null`: ожидание не наблюдалось. Либо его не было, либо проверки были готовы при первом опросе.

### Заметки `provenance.notes` для Run

`run_not_finished`, `wall_time_unknown`, `session_attempts_missing`, `coordinator_operations_missing`, `history_incomplete`, `session_duration_incomplete`, `token_usage_incomplete`, `prompt_bytes_incomplete`, `unmapped_session_stage`, `queue_wait_open`, `delivery_queue_wait_open`, `ci_wait_open`, `delivery_operation_open`, `failures_truncated`.

Постоянные ограничения в `provenance.limitations`: `prompt_bytes_are_not_tokens`, `elapsed_is_not_llm_latency`, `cross_platform_not_comparable`, `native_request_count_unavailable`. Если они относятся к Run, добавляются ещё `check_duration_not_recorded` и `platform_not_recorded`.

## Project: `kind: "project"`

Снапшот читается через тот же репозиторий и с той же валидацией, что и `kodo project status`, поверх read-only соединения. Run всех попыток (`kodo_project_attempts.run_id`, включая прежние попытки задачи) отчитываются той же функцией, что и одиночный Run.

| Поле | Смысл |
| --- | --- |
| `projectId`, `status`, `revision` | Из снапшота |
| `progress` | Число записей по статусам для `milestones`, `epics`, `tasks` |
| `tasks[]` | `{id, epicId, status, attempts, sessions, wallMs, implementationMs, verificationMs, lastRunState}`. `attempts` берётся из номера текущей попытки, поэтому неудачные и отменённые попытки входят в знаменатель. Если у какой-то попытки задачи нет сохранённого Run, её `sessions`/`wallMs`/стадии равны `null`. У задачи без попыток `sessions: 0`, а время `null` |
| `totals` | `{tasks, accepted (accepted+released), integrated, failed, blocked, cancelled, pending (proposed/ready/reserved/running/verifying), attempts, sessions, wallMs, verificationShare, usage}`. `wallMs` — сумма по задачам с попытками. `verificationShare` = verification ÷ wall, `null`, если неизвестна одна из частей. `usage` — `aggregateMetrics` по всем сессиям найденных Run |
| `gates[]` | `{id, status}`. Появляется, только если в снапшоте есть поле `gates` (будущий волновой режим) |
| `blockers[]` | `{taskId, runId, code, scope, occurrences}`: текущий блокер последнего Run задачи, `task_blocked` для заблокированной задачи без такого блокера, `project_paused` для приостановленного Project |
| `completeness` | Полнота наборов снапшота и `runs: {known, total, complete}`: найдено ли по Run на каждую попытку |
| `provenance` | Как у Run. `notes` включает заметки всех Run и `runs_missing`, `snapshot_incomplete`, `mixed_platforms`, `wall_time_unknown` |

## Чего отчёт не делает

Отчёт не запускает benchmark-кампании plain-vs-Kodo и не сравнивает модели и бюджеты. Он не считает статистических победителей и не выводит стоимость подписки в USD. Отчёт не заменяет `kodo audit` (политика навыков и квитанции) и `kodo jobs` (состояние очереди сейчас). Число backend HTTP-запросов native-клиентов не наблюдается и всегда равно `null`.
