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
- `state.sqlite` из `KODO_HOME` читается через один снапшот (`runtime/report-state.mjs`). Живые файлы базы никогда не открываются с блокировкой или индексом shared memory:
  - Если в `-wal` нет кадров (файла нет или он пустой), основной файл открывается как `immutable` (`mode=ro`, `query_only`). SQLite тогда не берёт блокировок, не читает WAL и не создаёт `-wal`/`-shm`. Если основной файл изменился во время чтения (checkpoint writer'а), прочитанное отбрасывается и чтение повторяется.
  - Если в `-wal` есть кадры, `state.sqlite` и `state.sqlite-wal` копируются в приватный временный каталог `kodo-report-snapshot-*` в `os.tmpdir()`. Копия восстанавливается и проверяется там же (`PRAGMA quick_check`, checkpoint), затем открывается как `immutable`. Если файлы изменились во время копирования (по размеру и времени изменения) или копия не прошла проверку, попытка повторяется. После 3 неудачных попыток отчёт отказывает с `report_unavailable`. Через копию читается и WAL без `-shm` после аварии writer'а; оригинал не восстанавливается.
  - **Отчёт — согласованный снимок на момент копирования.** Недописанные или повреждённые кадры WAL не учитываются, как и для любого читателя SQLite: восстановление копии берёт кадры до последнего целого commit, у которого сходятся контрольные суммы, и отбрасывает хвост. Отчёт не проверяет кадры сам и не сравнивает снимок с тем, что видит writer через свой индекс `-shm`.
  - Временный каталог выбирается после `realpath` трёх путей: `os.tmpdir()`, каталога состояния (`KODO_HOME`) и каталога учётных данных (`credentialRoot()` из `runtime/security.mjs`; у ещё не созданного каталога — `realpath` ближайшего существующего предка). Если временный каталог лежит внутри одного из них или содержит один из них (в том числе совпадает, например `TEMP=KODO_HOME`), отчёт отказывает с `report_unavailable` до создания любого файла. Проверка нужна только для копии: при чтении через `immutable` файлов не создаётся.
  - После отчёта каталог копии удаляется. Если Windows ещё держит файл копии (`EPERM`/`EBUSY` после закрытия SQLite), удаление повторяется до 5 раз с паузой 100 мс. Если каталог так и не удалился, отчёт отказывает с `report_unavailable`: копия не остаётся молча.
  - Способ чтения записан в `provenance.snapshot`: `{method: "immutable" | "wal-copy", attempts}`, где `attempts` — номер попытки, давшей отчёт (1–3).
  - Writer, закрывшийся между проверкой файлов и открытием, ничего не меняет. Файл `-wal` либо исчезает до копирования (тогда следующая попытка идёт через `immutable`), либо копия не совпадает с проверенным состоянием (тогда попытка повторяется).
  - Run, его события, квитанции durable jobs и Project читаются из одного снапшота. Отдельный job store не открывается, у таблиц заданий проверяется только версия схемы `1`.
- `Store` не открывается, leases не берутся, файлы в каталоге состояния не создаются и не меняются. Мигратор Project не пишет. `openProjectStore` всегда вызывает мигратор, а `project-store.mjs` не экспортирует чтение снапшота без него. Поэтому отчёт сначала требует строку версии `1` в `kodo_project_migrations`: при пустой таблице или другой версии возвращается `report_unavailable`. С этой строкой мигратор только читает: сверяет дайджест и таблицы, при несовпадении — `report_unavailable`. Кроме того, порт базы, который отчёт передаёт репозиторию, не сообщает путь к файлу. Поэтому ветка записи мигратора (каталог `project-backups`, резервная копия, DDL) остановилась бы на проверке пути до любой записи.
- Ключи только читаются, для redaction вывода (`readRedactionSecrets`). Берутся значения из окружения (`KODO_<NAME>` и `<NAME>`), из хранилища учётных данных (`credentialRoot()`) и из старого `KODO_HOME/secrets.json`. Старый файл читается как есть, без миграции и без удаления. Каталоги не создаются, права не меняются. Конверт хранилища разбирается и на Windows расшифровывается тем же примитивом, что и у `loadSecrets`: `decodeCredentials` и `decryptWindowsCredentials` из `runtime/security.mjs` (DPAPI в дочернем PowerShell, только `Unprotect`). Миграция, проверка и смена прав из `loadSecrets` при этом не вызываются. Если хранилище или старый файл есть, но прочитать их нельзя (повреждён формат, ошибка DPAPI), отчёт отказывает с `report_unavailable` и не печатает вывод без нужной redaction. Отсутствие файлов — не ошибка.
- Модели, провайдеры, Git и сеть не вызываются. Тест `tests/report-cli.test.mjs` запускает CLI под offline-guard и проверяет 0 сетевых и 0 провайдерских попыток. Он также проверяет, что каталог состояния и каталог учётных данных не изменились ни в одном байте, в том числе при старом `secrets.json` и при writer'е, который закрывается между проверкой и открытием.
- В вывод попадают только числа, время и фиксированный словарь: коды ошибок, стадии, id узлов и задач, имена клиентов и моделей, вид проверки и базовое имя её исполняемого файла. Аргументы и пути команд, тексты ошибок, сообщения блокеров, задачи и промпты не выводятся. Весь отчёт проходит `redact` с известными ключами.

| Код | Выход | Когда |
| --- | --- | --- |
| — | 0 | Отчёт построен, даже если наблюдения неполные |
| `report_arguments` | 1 | Неверные аргументы; состояние не открывалось |
| `report_not_found` | 1 | Нет базы, Run или Project |
| `report_unavailable` | 2 | База повреждена или менялась во время каждой из 3 попыток снапшота; временный каталог внутри или вокруг каталога состояния или ключей; копию не удалось удалить; схема Project или заданий не та (в том числе нет строки версии); ошибка чтения или ключей |

Ошибка — это `{ "schemaVersion": 1, "kind": "error", "status": "invalid" \| "blocked", "code": "..." }`. Аргументы и пути в ней не повторяются.

## Семантика неизвестного

- **Неизвестное — `null`, никогда не `0`.** Сумма известна, только если известно каждое слагаемое. Это то же правило, что у `aggregateMetrics`. Рядом всегда стоят `known` и `total`: сколько наблюдений известно и сколько их было.
- **Неудачи и незавершённые наблюдения входят в знаменатель.** Сессия со статусом `failed` или `started` (идёт или прервана) считается в `sessions`, `failedSessions`/`pendingSessions` и в `total` каждого поля. Её неизвестная длительность делает сумму неизвестной.
- **Prompt bytes ≠ tokens.** `promptBytes`, `context.originalBytes` и `context.sentBytes` — это локальные UTF-8 размеры. Токены берутся только из usage, который сообщил native-клиент.
- **Elapsed ≠ чистая LLM latency.** Длительность сессии включает клиент, инструменты, сеть и ожидание. Wall time включает простои, паузы и ожидание повторов.
- **Платформы не сравниваются.** Платформа записывается только в квитанции release smoke (`release.smoke.platform/node`). Отчёт перечисляет её в `provenance.platforms`, а при нескольких платформах в Project добавляет заметку `mixed_platforms`. Отчёт ничего не ранжирует и не выбирает «победителя».
- **Измеренная часть — отдельно от итога.** Если итог неизвестен, но часть измерена, она лежит в отдельном поле (`measuredMs`, `observedUsage`) и никогда не попадает в итоговое поле (`waitMs`, `usage`).
- `provenance.complete` равно `true`, только когда Run завершён, история Run полна, известны все наблюдения по сессиям (число, длительность, токены, prompt bytes) и длительности всех операций координатора, у каждой начатой проверки последнего раунда есть результат, а окна ожидания и попытки доставки закрыты. Иначе `provenance.notes` перечисляет пробелы. `provenance.limitations` — постоянные оговорки, которые не зависят от конкретного Run.

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
| `queue` | `kodo_job_events` очередей `run:<RUN_ID>:*` | `{jobs, waitMs, measuredMs, known, total, source}`. Ожидание — время в `queued`/`blocked` до выхода из этих состояний: обе границы — сохранённые квитанции состояния. `measuredMs` — сумма закрытых ожиданий, если открытое делает `waitMs` неизвестным. Без durable scheduler заданий нет: `jobs: 0`, `waitMs: null` |
| `queue.delivery` | события `delivery.queue_waiting` | Ожидание lease очереди доставки, `{waitMs, measuredMs, polls, known, total, source}`. Серии опросов разных очередей (merge, release) — разные ожидания. См. «Окна ожидания по опросам» |
| `checks.runs[]` | `checks.results` | `{kind, executable, durationMs, exitCode}` последнего раунда проверок. `executable` — базовое имя исполняемого файла вместе с расширением (`node`, `npm`, `lint.cmd`) без каталога и аргументов; `null`, если имени нет или его нельзя выделить однозначно (см. ниже) |
| `checks.total`, `checks.known`, `checks.totalMs` | события `check_started`, `checks.results[].durationMs` | Знаменатель — каждый запуск проверки (`check_started`) за всю историю. Длительность известна только из строки результата последнего раунда; Engine её не сохраняет, поэтому `totalMs` обычно `null` (ограничение `check_duration_not_recorded`) |
| `checks.executions`, `checks.unclosed`, `checks.reused` | события `check_started`, `checks_reused` | Сколько команд запускалось, сколько начатых проверок последнего раунда остались без результата и сколько раз проверки переиспользовались |
| `checks.ci` | события `delivery.checks_waiting` | Ожидание CI перед merge, `{waitMs, measuredMs, polls, known, total, source}`. См. «Окна ожидания по опросам» |
| `attempts` | `sessionAttempts`, `nodes[].attempt`, события | `{sessions, failedSessions, pendingSessions, observedSessions, nodeAttempts, verificationRounds, repairRounds}`. При `metrics.historyComplete: false` (Run продолжен без ранних сессий) `sessions`, `failedSessions`, `pendingSessions` равны `null`, сохранённое число — в `observedSessions`; длительности стадий из сессий — `null`, сохранённая часть — в `measuredMs` стадии |
| `usage` | `aggregateMetrics(sessionAttempts)` | Итоговый агрегат `metrics.mjs` с `completeness`. `null`, если Run продолжен из старого без прежних сессий (`metrics.historyComplete: false`, заметка `history_incomplete`). У Run без `sessionAttempts` поле `sessions` равно `null` |
| `observedUsage` | `aggregateMetrics(sessionAttempts)` | Всегда только наблюдённое: агрегат сохранённых сессий. Совпадает с `usage`, когда история полна |
| `usage.usage.semantics` | `usage.semantics` сессий | Только словарь `metrics.mjs`: `input-includes-cached`, `cache-read-and-write-separate-from-input`, `unknown`, `mixed`. Любое другое значение — `null` |
| `context` | `usage.contextOriginalBytes/contextSentBytes` | Локальные байты, не токены. `null`, если `usage` равно `null` |
| `failures[]` | события `node_failed`, `repair_required`, `delivery.command_failed`, `blocked`/`cancelled`/`waiting_limits`; неуспешные сессии и проверки; попытки доставки | `{code, scope, at}`. Попытка доставки с read-back `absent` даёт `delivery_absent` (время read-back). Попытка без read-back даёт `delivery_uncertain` (время intent), в том числе если её сменил повтор. Каждое `repair_required` даёт `repair_required@verification` со временем события: неудачный раунд проверки (проверки, gate или ревью) остаётся виден и после успешного ремонта, хотя его строки результатов заменил следующий раунд. Текст проблемы из события не выводится. `at` равно `null`, если у источника нет времени. Не более 200 записей |
| `blocker` | `blocker.current` | `{code, scope, firstSeen, lastSeen, occurrences, resolved}` без текста сообщения. `null`, если блокера нет |
| `watchdog` | `watchdog` | `{stalled, rounds, progressedRounds, stopped}` |
| `provenance` | — | `{source: "kodo-state", generatedAt, platforms, complete, notes, limitations, snapshot}`. `snapshot` добавляет CLI (см. «Граница чтения») |

Имя исполняемого файла. У команды-объекта (`{command, args}`) имя берётся из `command` целиком. Старая строка команды разбирается так: если она начинается с кавычки, программа — текст до парной кавычки (без пары или со склеенным за кавычкой текстом — `null`). Без кавычек программа — первый токен до пробела; если он содержит кавычку — `null`. Если в строке без кавычек есть и пробел, и разделитель пути (в любом месте), путь мог содержать пробел: `null`. Так `"C:/Private Account/bin/lint.cmd" --arg` даёт `lint.cmd`, а `C:/Private Account/bin/lint.cmd --arg`, `Customer Files/tools/lint.cmd --fix` и `C:\Customer Label.exe` — `null`; `npm test` даёт `npm`. Из полного токена берётся последний сегмент пути, он должен соответствовать `^[A-Za-z0-9][\w.-]{0,63}$`.

### Стадии и их источники

| Стадия | Наблюдения | `source` |
| --- | --- | --- |
| `assessment` | `coordinatorOperations` вида `assessment` | `coordinator-operations` |
| `analysis` | `coordinatorOperations` видов `analysis`, `research`, `discovery`, `routing` | `coordinator-operations` |
| `planning` | сессии стадии `plan` | `session-attempts` |
| `implementation` | сессии ролей `developer`, `tester`, `documenter` | `session-attempts` |
| `verification` | сессии `repair` и каждый запуск проверки (`check_started`) | `session-attempts+check-executions` |
| `review` | сессии `review` | `session-attempts` |
| `delivery` | попытки `pr`, `merge` журнала доставки: от intent до read-back | `delivery-operation-journal` |
| `release` | попытки `release` журнала доставки | `delivery-operation-journal` |

Каждый intent журнала доставки — отдельная попытка. Её закрывает ближайший read-back той же операции (`confirmed`, `reconciled` или `absent`). Поэтому неудачная попытка (`absent`) и успешный повтор дают две операции, обе длительности и одну неудачу. Intent без read-back (прерванный или сменённый повтором) остаётся в знаменателе с неизвестной длительностью: `durationMs` стадии равно `null`, заметка `delivery_operation_open`. Read-back без открытого intent (поздняя сверка) попытку не создаёт.

`durationMs` стадии — это сумма измеренных длительностей её наблюдений, а не интервал между событиями. Параллельные сессии складываются, поэтому сумма может превышать wall time. Время между наблюдениями (подготовка worktree, слияние, простои) в стадии не попадает. Стадия без наблюдений даёт `durationMs: null`, `total: 0`, `source: null`.

Раунд проверки — это одна непрерывная серия событий `check_started` или одно событие `checks_reused`. Ремонтный раунд — событие `repair_required`.

Проверки в знаменателе. Engine заменяет `checks.results` в каждом раунде, поэтому строки результатов есть только у последнего раунда, в порядке запуска. Каждый `check_started` — запуск проверки в знаменателе стадии `verification` и `checks.total`. Запуск прежнего раунда закрыт (начался следующий раунд), но его квитанция заменена: длительность неизвестна. Запуск последнего раунда без строки результата (команда ещё идёт, или Run остановился до квитанции, например с `dirty_worktree`) — незакрытая попытка: `checks.unclosed`, заметка `check_unclosed`, `provenance.complete: false`. Исключение: если после последнего раунда пришёл `repair_required`, раунд закончен, а Engine сбрасывает квитанцию на ремонтном коммите. Его запуски без строки результата закрыты: они остаются в знаменателе с неизвестной длительностью, но в `checks.unclosed` не входят.

### Окна ожидания по опросам

`checks.ci` и `queue.delivery` строятся только по явным границам. `awaitChecks` (`runtime/delivery.mjs`) сохраняет `delivery.checks_waiting` при каждом опросе, который увидел ожидающие проверки. Опрос, который увидел итоговый статус (проверки готовы или упали), события не сохраняет. Так же lease очереди доставки сохраняет `delivery.queue_waiting` только при неудачной попытке захвата, а успешный захват события не оставляет. Поэтому у окна ожидания нет сохранённого конца:

- `waitMs` всегда `null`, `known: 0`. Окно не закрывается следующим событием: между последним опросом CI и merge intent идут lease, `git fetch` и повторный опрос, и их время не относится к CI.
- `measuredMs` — сумма по сериям времени от первого до последнего сохранённого опроса серии. Это измеренная часть, а не итог; одна запись опроса даёт 0. Серия — опросы одного типа (для `queue.delivery` — одной очереди) без других событий между ними. Если CI снова стал ожидающим при повторной проверке после lease и между опросами нет другого сохранённого события, две серии неотличимы и `measuredMs` включает время между ними.
- `total` — число серий, `polls` — число опросов. Если опросов нет, `waitMs` и `measuredMs` равны `null`, `total: 0`: ожидание не наблюдалось. Либо его не было, либо проверки были готовы при первом опросе.
- Серия опросов даёт заметку `ci_wait_open` или `delivery_queue_wait_open`: конец ожидания не сохранён.

Engine сохраняет каждое событие доставки дважды: само событие и его копию типа `delivery` или `release` с исходным типом в `data.type`. Отчёт пропускает такие копии везде: копия не разрывает серию опросов и не создаёт новую попытку доставки.

### Заметки `provenance.notes` для Run

`run_not_finished`, `wall_time_unknown`, `session_attempts_missing`, `coordinator_operations_missing`, `coordinator_operation_incomplete` (у операции координатора нет длительности: она начата и не завершена или сохранена без неё), `history_incomplete` (`usage` равно `null`), `session_duration_incomplete`, `token_usage_incomplete`, `prompt_bytes_incomplete`, `unmapped_session_stage`, `check_unclosed` (начатая проверка последнего раунда без результата), `queue_wait_open`, `delivery_queue_wait_open`, `ci_wait_open` (конец ожидания не сохранён), `delivery_operation_open`, `failures_truncated`.

Постоянные ограничения в `provenance.limitations`: `prompt_bytes_are_not_tokens`, `elapsed_is_not_llm_latency`, `cross_platform_not_comparable`, `native_request_count_unavailable`. Если они относятся к Run, добавляются ещё `check_duration_not_recorded` и `platform_not_recorded`.

## Project: `kind: "project"`

Снапшот читается через тот же репозиторий и с той же валидацией, что и `kodo project status`, поверх снапшота базы (см. «Граница чтения»). Run всех попыток (`kodo_project_attempts.run_id`, включая прежние попытки задачи) вместе с их событиями и квитанциями durable jobs отчитываются той же функцией, что и одиночный Run.

| Поле | Смысл |
| --- | --- |
| `projectId`, `status`, `revision` | Из снапшота |
| `progress` | Число записей по статусам для `milestones`, `epics`, `tasks` |
| `tasks[]` | `{id, epicId, status, attempts, sessions, wallMs, implementationMs, verificationMs, lastRunState}`. `attempts` — максимум из номера текущей попытки, номеров уцелевших строк истории попыток и их количества, поэтому неудачные и отменённые попытки входят в знаменатель. Пропуск номера в 1..`attempts` (строка попытки не сохранилась) делает итоги задачи и проекта неполными: `completeness.runs.complete: false`, суммы — `null`, измеренное — только в `measuredMs`/`observedUsage`. Если у какой-то попытки задачи нет сохранённого Run, её `sessions`/`wallMs`/стадии равны `null`. У задачи без попыток `sessions: 0`, а время `null` |
| `attempts[]` | Каждая попытка каждой задачи: `{taskId, number, runId, state, wallMs, waits: {queue, deliveryQueue, ci}, failures}`. Ожидание — `{waitMs, measuredMs, known, total}` из отчёта Run попытки: очередь durable jobs, lease очереди доставки, CI. `failures` — коды неудач Run попытки, как `failures[]` у Run. Так прежняя попытка, которая ждала CI и упала, видна и после успешного повтора. У попытки без сохранённого Run `state`, `wallMs` и `waitMs` равны `null`, `total` ожиданий равно `null`, `failures` равно `null`, а не `[]` |
| `totals` | `{tasks, accepted (accepted+released), integrated, failed, blocked, cancelled, pending (proposed/ready/reserved/running/verifying), attempts, sessions, wallMs, verificationShare, usage, observedUsage, waits}`. `wallMs` — сумма по задачам с попытками. `verificationShare` = verification ÷ wall, `null`, если неизвестна одна из частей. `observedUsage` — `aggregateMetrics` по сессиям найденных Run, то есть только наблюдённое. `usage` равно `observedUsage`, только если история попыток полна: у каждой попытки есть Run, число сессий известно (`sessions` не `null`) и ни один Run не продолжен без прежней истории (`metrics.historyComplete: false`). Иначе `usage` равно `null`. `waits.{queue, deliveryQueue, ci}` — `{waitMs, measuredMs, known, total, complete}`. `complete` равно `true`, только если у каждой попытки есть Run и её `waitMs` известно. Попытка с `waitMs: null` — открытое окно, окно без сохранённого конца или отсутствие наблюдений (например, нет заданий durable scheduler) — делает итог неполным: `complete: false`, `waitMs: null`. `measuredMs` — сумма `measuredMs` найденных попыток, только измеренная часть, в `waitMs` не входит. Если Run какой-то попытки нет, `total` равно `null` |
| `gates[]` | `{id, status}`. Появляется, только если в снапшоте есть поле `gates` (будущий волновой режим) |
| `blockers[]` | `{taskId, runId, code, scope, occurrences}`: текущий блокер последнего Run задачи, `task_blocked` для заблокированной задачи без такого блокера, `project_paused` для приостановленного Project |
| `completeness` | Полнота наборов снапшота и `runs: {known, total, complete}`: найдено ли по Run на каждую попытку |
| `provenance` | Как у Run. `notes` включает заметки всех Run и `runs_missing`, `snapshot_incomplete`, `mixed_platforms`, `wall_time_unknown` |

Текстовая сводка Project показывает итоговые токены и отдельно наблюдённые (`total tokens unknown (observed N)`). Строка `Waits:` показывает ожидания очереди, очереди доставки и CI с полнотой (`known/total`) и отдельно измеренную часть (`measured …`), если она есть. Текстовая сводка Run так же показывает итоговые и наблюдённые токены и измеренную часть ожиданий. Затем идёт строка на каждую попытку: состояние Run, ожидания и коды неудач (`code@scope`), `unknown` для попытки без Run.

## Чего отчёт не делает

Отчёт не запускает benchmark-кампании plain-vs-Kodo и не сравнивает модели и бюджеты. Он не считает статистических победителей и не выводит стоимость подписки в USD. Отчёт не заменяет `kodo audit` (политика навыков и квитанции) и `kodo jobs` (состояние очереди сейчас). Число backend HTTP-запросов native-клиентов не наблюдается и всегда равно `null`.
