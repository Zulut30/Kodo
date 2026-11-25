# Pull-хост: внешние воркер-чаты T3 Code

Главный чат T3 Code («Kodo · Диспетчер задач») сам раздаёт работу видимым воркер-чатам своим инструментом `delegate_task`. Kodo CLI не вызывает инструменты T3, поэтому для волнового проекта он даёт pull-протокол: хост забирает пачку задач, раздаёт брифы чатам и сдаёт результат обратно. Kodo проверяет работу, вливает её в интеграционную ветку проекта и запускает gate Run эпика.

Протокол работает только для волнового проекта (`execution: {cadence:'wave', integration:'branch'}`, см. [PROJECTS.md](PROJECTS.md)). Хосты — `PULL_HOSTS = ['t3', 'orca']` из `runtime/job-contracts.mjs`. Реализация — `runtime/project-external.mjs`, CLI — `runtime/project-cli-external.mjs`, профили ролей — `runtime/worker-roles.mjs`.

## Цикл

```text
главный чат                         Kodo                                   воркер-чат
kodo project next-wave ──────────►  резерв попыток, worktree, брифы
            ◄──────────────────────  briefs[]
delegate_task(brief) ────────────────────────────────────────────────────►  работа в brief.worktree,
                                                                            selfCheck, commit
            ◄────────────────────────────────────────────────────────────  SHA коммита
brief.completeCommand ───────────►  проверка commit, task-fast,
                                    интеграция
            ◄──────────────────────  integrated | checks_failed | blocked
kodo project gates ──────────────►  проверки, ревью и приёмка готовых эпиков
```

1. `next-wave` под lease `project:<id>` создаёт или находит интеграционную ветку `kodo/project/<id>` (`ensureIntegration`) и сначала возвращает брифы уже идущих внешних попыток этого хоста. Затем добирает пачку до `--limit` через `selectWave(snapshot, {limit, inFlight, availability, now})` директора: задачи без пересечения `writePaths` с идущими. Как у `drain`, `availability` (`waveAvailability`) учитывает проверку интерфейсов: задача, у которой ref из `interfaceRefs` не проходит проверку evidence, не выбирается; если её всё же вернул подменённый селектор, резерв отказывает с `project_interface_unverified`. Для каждой новой задачи: `task → ready`, `reserveAttempt` с actor `project-external:<host>` (владелец резерва), черновик Run через `engine.createReserved` и `repo.installRun`, worktree на ветке `kodo/<runId>` от головы интеграционной ветки (`waveFrontier`), Run в `executing`, переходы `attempt/task → running`.
2. Главный чат открывает по брифу один воркер-чат с заголовком `brief.chatTitle`. Второй worktree хост не создаёт: чат запускается в общей папке проекта и работает по абсолютному пути `brief.worktree`.
3. Воркер коммитит в `brief.branch`, запускает `brief.selfCheck` и возвращает полный SHA.
4. `complete-task` под тем же lease `project:<id>` проверяет коммит, один раз выполняет `task-fast` (`verifyTaskFastOnce`), переводит Run в `succeeded` и передаёт его `integrateAndAdvance` директора. Результат интеграции сразу записывается в `externalCompletion` (`gates: null`); если не задан `--defer-gate`, затем вызывается `runPendingGates` и его итог дописывается туда же. Гейт эпика с ремонтом принимает задачи, эпик и, если покрывает, milestone и проект.
5. Бриф откладывает гейт. После сдачи диспетчер архивирует чат и запускает отдельный проход `project gates PROJECT_ID --json` в сеансе команды с возвратом управления. После новых сдач во время прохода, перезапуска диспетчера или пустой волны без воркеров он проверяет готовые гейты той же командой. Итог отдельного прохода находится в его ответе.

## Run внешней задачи

| Поле | Значение |
| --- | --- |
| `executor` | `{kind: 'external', host}` — `Engine.run()` такой Run не исполняет (`project_run_not_native`) |
| `verificationProfile` | `'task-fast'` |
| `config.repairRounds` | `1`; ремонта при `complete-task` нет |
| `config.delivery.enabled` | `false`; доставку делает координатор |
| `review` | `null`: собственного ревью нет, ревью — у gate Run эпика |
| `baseSha` | голова интеграционной ветки на момент резерва |
| `config` (политика проверок), `wavePolicy` | `commands`, `verification`, `security`, `uiVerification`, `architecture` — из `kodo.config.json` коммита `baseSha`, не из checkout пользователя; `wavePolicy: {schemaVersion, commit: baseSha, hash}` ([VERIFICATION.md](VERIFICATION.md#политика-проверок-волнового-run)) |
| `externalAbandon` | `{schemaVersion, attemptId, headSha}` после `--abandon` |
| `state` | `executing` после резерва, `succeeded` после пройденной проверки |
| `externalCompletion` | `{schemaVersion, headSha, integration, gates}` после интеграции; `gates: null` до прохода гейтов и при `--defer-gate` |

Все переходы авторизует один production-authorizer `createProjectTransitionAuthorizer` (ветка wave → `evaluateWaveTransition`, доверенная проверка `validateWaveRun`), тот же, что у `drain`. Run внешней задачи проверяется как любой Run задачи волны: совпадает с сохранённым, binding и frozen task прежние, `verificationProfile: 'task-fast'`, корень и конфигурация проверки не сменились, worktree чист на `run.headSha`. Пока Run `executing`, этим проверка ограничена и разрешено не больше `running`; у `succeeded` — журналы `fast-check` каждой строки и Git-сверка записанного слияния. Принятие (`accepted`) даёт только gate Run эпика ([PROJECTS.md](PROJECTS.md), «Волновой режим»).

## Бриф

| Поле | Смысл |
| --- | --- |
| `projectId`, `taskId`, `attemptId`, `runId` | Идентичность попытки |
| `chatTitle` | `Kodo · [<epicId>] <task.title> · попытка <attempt.number>` |
| `role`, `roleInstructions` | Роль из `task.owner`; профиль из `worker-roles.mjs` |
| `writePaths` | Единственные пути, которые можно менять |
| `worktree`, `branch`, `baseSha` | Рабочая копия, её ветка и база |
| `interfaces` | Пути `interfaceRefs` самой задачи (неизменяемые evidence-файлы) |
| `prompt` | Точный `buildDirectorTaskInput` задачи и контракт воркера |
| `selfCheck` | `<cli> ci feedback --base <baseSha> --project "<worktree>" --json` |
| `completeCommand` | `<cli> project complete-task <projectId> <taskId> --head <SHA> --attempt <attemptId> --defer-gate` |
| `abandonCommand` | `<cli> project complete-task <projectId> <taskId> --head <SHA> --abandon --attempt <attemptId>` — отказ привязан к этой попытке |

`<cli>` — префикс CLI, выдавшего бриф (поле `cli` ответа `next-wave`, `runtime/cli-command.mjs`). Из `kodo` и `node cli/index.mjs` это `node "<абсолютный путь к cli/index.mjs этого пакета>"`: путь берётся из `import.meta.url` точки входа, `node` без пути находят PowerShell, cmd и bash. Поэтому воркер и главный чат вызывают тот же пакет Kodo, даже если на PATH другая версия `kodo` (например, 0.2.6 без `project`). Библиотечный вызов `nextWave` без CLI-контекста сохраняет `kodo`. Префикс — строго `kodo` или `node "<путь>"`, иначе `project_cli_invalid`; он проверяется (и на известные секреты) до lease и резерва, а в CLI — ещё до открытия Store. Путь в команде (префикс CLI, `--project` самопроверки) — абсолютный, без кавычек, `` ` ``, `$`, `%`, `!`, управляющих символов, двойного или конечного обратного слеша, а на Windows — полный локальный путь с буквой диска (сетевой путь, корень диска и путь без буквы диска отклоняются с советом перенести проект в подкаталог локального диска): только такой аргумент в двойных кавычках одинаково буквален в PowerShell, cmd и bash. Иначе — `project_path_unsafe` с подсказкой переименовать или переместить каталог; каталог будущих worktree проверяется до lease и резерва по тому же правилу, что у Engine (`plannedWorktreeHome` и `worktreeHomeFor` в `runtime/workspace.mjs`: явный `KODO_WORKTREE_HOME` первым, в том числе для state home внутри Git). Пробелы и кириллица допустимы. Весь ответ `next-wave` проходит `assertDirectorSafe`.

Контракт воркера в `prompt`: работать только в worktree и только в `writePaths`; не удалять, не пропускать и не ослаблять тесты; закоммитить в свою ветку без push, PR, merge и rebase; запустить `selfCheck`; закончить с чистым worktree и вернуть полный SHA. Бриф проходит `assertDirectorSafe` (известные секреты, PEM, redaction). Из абсолютных путей он содержит только worktree, пути `interfaces`, `projectContext.root` внутри замороженного входа задачи и путь `cli/index.mjs` пакета Kodo в префиксе команд; state home, артефакты Run и интеграционный worktree в бриф не попадают.

## Роли

`architect`, `developer`, `ui-qa`, `performance`, `security`, `reviewer` — короткие профили (до 1 КБ) без путей и данных проекта. Неизвестная роль получает профиль `developer`.

## Команды

```text
kodo project next-wave PROJECT_ID --host t3|orca [--limit N] [--retry-failed] [--json]
kodo project complete-task PROJECT_ID TASK_ID --head SHA [--defer-gate] [--attempt UUID] [--command-id UUID] [--json]
kodo project complete-task PROJECT_ID TASK_ID --head SHA --abandon --attempt UUID [--command-id UUID] [--json]
kodo project gates PROJECT_ID [--retry-failed] [--json]
```

Аргументы разбираются строго до чтения учётных данных, состояния и Git; любая ошибка — exit 1, `project_arguments`. `kodo project --help` и `kodo project <действие> --help` (или `-h`) печатают справку проектных команд (с `--json` — `result.status: "help"`, `result.usage`) с exit 0 ещё до разбора, без ключей и состояния. `--abandon` без `--attempt` — тоже `project_arguments`. Без профиля `--limit` по умолчанию равен 3, максимум 5. С профилем `--limit` в диапазоне 1–64 автоматически уменьшается до доступной ёмкости. Если все подписки на паузе, ответ содержит `result.code: "waiting_limits"` и брифы уже установленных попыток этого хоста. Продолжай принимать их работу. Следующий запрос после снятия паузы снова выдаст новые задачи.

Диспетчер задаёт ресурсы командой `kodo project profile set PROJECT_ID --file profile.json`. Формат файла и команды просмотра и паузы описаны в [RUNTIME](RUNTIME.md#профиль-исполнения-волн). При планировании сначала идут готовые задачи с самой длинной цепочкой потомков, затем с наибольшим числом прямых потомков.

При профиле занятые попытки всех хостов расходуют общую ёмкость проекта. `--limit` ограничивает выборку текущего хоста для активных ресурсов. Повторные брифы без назначения или с удалённой машиной либо подпиской входят в лимит. Брифы уже идущих задач на известной машине из приостановленного пула хост получает дополнительно. При ошибке графа зависимостей проекта с профилем хост получает брифы уже запущенных попыток и причину в `blocked`. После интеграции одной задачи сразу запроси `next-wave`, даже если другие чаты продолжают работу. До интеграции зарезервированная, исполняемая или проверяемая попытка занимает слот. В новом брифе `subscription` содержит `id/provider/model/tier`, а `machine` — `id/kind` и указанный пользователем `environmentId`. Назначение хранится в Run и повторяется при повторной выдаче. Без профиля оба поля отсутствуют. Выбор клиента и запуск чата на указанной машине выполняет хост.

### Удалённый воркер волны

Хост размещает чат на указанной машине. В её клоне должен быть настроен remote с именем из `repository` и доступен `kodo` в PATH. Диспетчер публикует `baseRef`. Воркер получает базу, создаёт worktree, выполняет задание и selfCheck, отправляет HEAD в `workRef` и сообщает SHA. Диспетчер вызывает complete-task с этим SHA. Доступ к Git настраивается отдельно на каждой машине через credential helper или SSH agent.

Хост отмечает потерю связи командой `kodo project profile machine-down PROJECT_ID --machine ID`. Для остановленной попытки диспетчер вызывает complete-task с --abandon и идентификатором попытки, затем next-wave с --retry-failed. После восстановления связи используется machine-up.

| Команда | Результат | Exit |
| --- | --- | --- |
| `next-wave` | `{projectId, revision, cli, code?, briefs, blocked}` (см. «Почему задачи ждут») | 0 — есть брифы, 2 — пусто |
| `complete-task` | `integrated` (`integration`, при встроенном проходе также `gates`), `abandoned` | 0 |
| `complete-task` | `checks_failed` (`code`, `message`), `blocked` (`code`) | 2 |
| `gates` | `passed` (`gates`) | 0 |
| `gates` | `blocked` (`gates` с заблокированными гейтами или `code`) | 2 |

Ошибки отчёта — константные коды: собственные коды протокола (`project_wave_required`, `project_host_unsupported`, `project_busy`, `project_build_busy`, `project_task_busy`, `project_integration_queue_timeout`, `project_integration_queue_cancelled`, `project_integration_queue_missing`, `project_lease_lost`, `project_attempt_not_external` и др.) или `project_invalid`/`project_blocked`. Пути, аргументы и вывод провайдеров в ошибки не попадают.

Строки `gates.blocked` (ответы `complete-task` и `gates`) — `{code, kind, id, gateId?, runId?, state?, stage?, message?}`: `gateId` и `runId` называют гейт и его gate Run, `state` — его состояние, если Run остановился. Необязательные поля отсутствуют, когда их нет: у `wave_project_head_mismatch` одного гейта нет; у `gate_invalid` (установка зарезервированного гейта отклонена — и сразу после резерва, и при повторной установке) есть `gateId`, зарезервированный `runId` (Run ещё не создан, `kodo status` его не покажет), `stage: "install"` и `message` — диагностика проверки гейта (`wave-verifier`). Если gate Run есть, причину читают в `kodo status <runId> --json`: `blocker.current` (`code`, `message`), упавшие проверки `checks.results[]` с `exitCode` ≠ 0 (`kind`, хвост `output`, журнал `outputPath`) и `review.findings` — только если ревью дошло до конца (при провале проверок `review: null`). У `wave_project_head_mismatch` одного гейта нет.

### Почему задачи ждут

`blocked` ответа `next-wave` называет, почему остальные задачи не выданы; пустой список означает, что ждать нечего, кроме идущих попыток.

- Задачи — `{taskId, code}`: отказ резерва (`project_write_conflict`, `project_dependency_unsatisfied`, `project_retry_executor` и др.) и причины планировщика, по которым хост может действовать: `project_risk_unapproved` — нужно одобрение риска (`kodo project approve-risk`, решение пользователя), `project_retry_required` — попытка брошена или упала, новую создаёт `next-wave --retry-failed`, `project_interface_unverified` — evidence интерфейса не проверяется, `project_split_required` — вход задачи больше лимита, `project_task_failed`/`project_task_blocked` — задача остановлена сама, `project_dependency_cancelled` с `dependencyId` — среди невыполненных (в том числе транзитивных) предшественников задачи есть отменённая задача, поэтому сама она не начнётся. Отказ проверки evidence перед тем, как назвать его, проверяется заново. Ожидание выполняющегося предшественника, идущей работы или лимита пачки блокером не считается.
- Остановленный эпик или майлстоун — одна строка `{code: "project_<kind>_<состояние>", kind, id}` прямо из снимка, даже если все задачи эпика уже интегрированы: `blocked` и `failed` всегда, `cancelled` — пока в нём есть неотменённая задача.
- Гейты — `{code, kind, id, gateId?, runId?, state?}` (`gateHolds` директора, только чтение): остановленный gate Run называет первый ещё не принятый контейнер своей цепочки эпик → майлстоун → проект (эпик может быть уже принят, а майлстоуну не хватило доказательства), пока более поздний гейт этого контейнера (повтор, замена) его не заменил (код блокера Run, иначе `error.code` — например, `wave_gate_proof_missing`, если не прошла приёмка после успешного Run; `quota` при `waiting_limits`; после устранения причины — `kodo project gates PROJECT_ID --retry-failed`) или `project_gate_pending` — гейт готов, но не выполнен (например, после `--defer-gate`): его выполняет `kodo project gates PROJECT_ID`.

Принятый проект отвечает `code: "project_accepted"` (`project_released`) с пустыми `briefs` и `blocked`, exit 2, без lease, Git и проверки каталога worktree (`KODO_WORKTREE_HOME` проверяется только для открытого проекта, до lease и резерва). Пауза, отмена, провал и блокировка проекта — по-прежнему ошибка `project_control_blocked`.

### Проверки complete-task

Дефект, который воркер может исправить, даёт `checks_failed`; попытка остаётся `running`, воркер присылает новый head. У каждого отказа `external_*` есть `message` — что исправить; главный чат передаёт `code` и `message` в тот же воркер-чат.

| Код | Условие |
| --- | --- |
| `external_branch_mismatch` | `refs/heads/<branch>` не равен `--head` (коммит из чужой ветки) |
| `external_worktree_missing`, `external_worktree_mismatch` | Worktree отсутствует, не на `--head` или не на своей ветке |
| `external_worktree_dirty` | Есть незакоммиченные или неотслеживаемые файлы |
| `external_no_changes` | `--head` равен базе |
| `external_not_descendant` | База не предок `--head` |
| `external_symlink` | В diff или в любом коммите `base..head` есть симлинк или submodule |
| `external_scope`, `external_unsafe_change` | Файлы вне `writePaths`, секретные имена или содержимое (`engine.checkScope`) — в итоговом diff и в каждом коммите `base..head` (`inspectHistory`): файл, добавленный одним коммитом и удалённый следующим, тоже отказ, `message` называет коммит и путь |
| `external_history_too_long` | В `base..head` больше 1000 коммитов (`HISTORY_LIMIT`) |
| `external_history_unverifiable` | Blob истории нельзя сравнить с известными секретами в пределах бюджета (больше 16 МиБ или вместе больше 128 МиБ): перепиши историю без него |
| код быстрой проверки | `task-fast` или behaviour gate не прошли (например, `check_failed`, `behavior_failed` при удалённом тесте) |

`blocked`: попытка не внешняя, не идёт или уже интегрирована (`project_attempt_not_running`), `--attempt` называет не текущую попытку (`project_attempt_stale`), проект на паузе или остановлен (`project_control_blocked`), отказ `integrateAndAdvance` (его код, например `wave_policy_mismatch` — голова меняет политику проверок `kodo.config.json` вне `writePaths`, или `project_integration_history` при слиянии).

### Параллельные сдачи

Много воркер-чатов сдают задачи одновременно; `complete-task` не держит `project:<id>` во время `task-fast` и не падает `project_integration_busy`.

1. Короткая секция `project:<id>` (ожидание до 120 с): попытка, повтор, состояние проекта и проверки Git, области записи, истории и секретов.
2. `task-fast` — вне `project:<id>`. Сначала аренда `project-verify:<runId>`: одна проверка Run за раз, дубликат той же сдачи ждёт первую и затем находит head уже проверенным (повторного `task-fast` нет). Потом слот семафора машины `machine-build:<machineId>` (`runtime/machine-build-lease.mjs`): по умолчанию машина `local` с одним слотом; библиотечный вызов принимает `machine: {id, maxHeavyBuilds}` (1–64, иначе `project_machine_invalid`), профиль запуска этапа 15A передаст их сам; ожидание слота — до 2 ч (`project_build_busy`). После получения слота состояние перечитывается: этот head уже проверен или интегрирован — проверка не запускается; другой head, `--abandon` или отмена — `blocked`, `project_submission_stale`. `verifyTaskFastOnce` не обнуляет доказательства Run, у которого началась интеграция, и не проверяет сдвинувшийся worktree (`external_head_changed`). Итог пишется в короткой секции `project:<id>` с повторной сверкой (`externalAbandon`, `externalCompletion`, `integration`, head); отмена не перезаписывается.
3. Проверенный head ставится в очередь интеграции (`runtime/project-integration-queue.mjs`) — таблица `kodo_integration_queue` в SQLite состояния с собственной версионной миграцией (`kodo_integration_queue_migrations`). Порядок: `priority` (выше — раньше; по умолчанию 0, 15A передаст вес критического пути), затем порядок постановки. Живая строка (`queued`, `merging`) одна на Run и head; завершённые строки сохраняются для читателей, повторная сдача после `rejected`/`failed` получает новую строку.
4. Сливает очередь тот ожидающий, кто первым получил `project:<id>` и `project-integration:<id>` (без ожидания): не больше 4 строк за одно удержание обеих аренд, включая восстановление строк `merging`; затем аренды освобождаются (`next-wave` снова доступен), остальные строки сливает следующий дренаж. Захват идёт по порядку очереди и заканчивается на первой строке, чья область записи пересекается с уже взятой: она открывает следующий захват, так что приоритет и FIFO сохраняются. Перед слиянием, до изменения Git, строка сверяется с текущим состоянием: привязка попытки, проверенный head и база, нет `--abandon`/отмены, ветка и worktree воркера чисто стоят на этом head. Расхождение — `blocked`, `project_submission_stale`, слияния нет. Конфликт слияния — `blocked`, `project_integration_conflict` только для этой задачи; ветка проекта остаётся чистой, остальные строки сливаются. Если слияние прошло, а переход задачи отказал, строка — `failed` с кодом отказа (не «слит, но отклонён»): повтор сдачи продолжает с записанного слияния. Квитанция `externalCompletion` пишется в Run до завершения строки. Сигнал отмены дренирующего вызывающего останавливает дренаж только между строками и не передаётся в интеграцию чужих строк.
5. Остальные сдачи ждут свою строку (по умолчанию до 30 мин, библиотечный параметр `integrationWaitMs`). Дедлайн абсолютный: проверяется перед каждым дренажом, между строками и после него; по истечении текущая Git-операция завершается, аренды освобождаются, ответ — `project_integration_queue_timeout`. Уже записанный терминальный итог своей строки выигрывает у дедлайна: если строка завершилась (в том числе в последнем дренаже), сдача получает этот итог, а не таймаут. Отмена — `project_integration_queue_cancelled`. Строка остаётся в очереди; повтор той же сдачи ждёт её же.

Очередь переживает перезапуск: строки, которые упавший дренаж оставил в `merging`, следующий дренаж забирает первыми под своим `claim` (токен захвата строки), а `integrateAndAdvance` узнаёт уже сделанное слияние — второго merge-коммита нет. Отменённый дренаж строки `merging` не трогает (в очередь возвращаются только взятые им и не начатые строки). При восстановлении сначала Git решает, есть ли слияние: записанное слияние, которого нет на ветке, — `blocked`, `project_integration_missing` (не `failed`); запись `pending` без слияния на ветке — новое слияние с полной сверкой попытки, head, базы, ветки и чистоты worktree воркера. Квитанция принимается только при достижимом merge-коммите с обоими записанными родителями, а повтор, нашедший квитанцию, завершает оставшуюся живую строку тем же итогом. Одновременная вторая проверка того же Run другим путём — `blocked`, `project_task_busy`.

**Потеря аренды (fencing).** Аренды с TTL сами не дают взаимного исключения, если держатель «уснул» дольше TTL. Поэтому:

- ветку проекта Kodo сдвигает только **fenced publish** (`runtime/project-publish.mjs`): дерево и коммит слияния готовятся заранее (`merge-tree`/`commit-tree`, ветка не трогается), затем в одной транзакции SQLite `BEGIN IMMEDIATE` проверяются живые токены аренд держателя (`expires > now`, одно `now`) и синхронно выполняется `git update-ref --stdin` с атомарной группой `start` / `verify refs/heads/<ветка воркера> <проверенный SHA>` / `update refs/heads/kodo/project/<id> <новый> <ожидаемый>` / `commit` (таймаут git 5 с). Захват аренды — запись в ту же БД, поэтому между проверкой и сдвигом ветки аренду никто не перехватит. Так же публикуются откат дефектного слияния и возврат гейта (`mergeBackGate`). Отказ токенов или сдвинутая другим держателем ветка — `project_lease_lost`; ветка воркера сошла с проверенного head — `project_submission_stale` (ничего не опубликовано);
- каждая запись итога под арендой (Run, переход попытки и задачи, строка очереди, `externalCompletion`, квитанция гейтов) идёт одной транзакцией `BEGIN IMMEDIATE`, которая сначала проверяет, что токены аренд держателя ещё живы (`expires > now`, `runtime/lease-fence.mjs`, `store.withFence`); иначе — `project_lease_lost`, ничего не записано;
- строка очереди привязана к захвату (`claim`): `finish`/`release` меняют её только при своём `claim`, поэтому устаревший дренаж не завершит и не вернёт в очередь строку, которую забрал другой;
- продление, не нашедшее своей строки, отменяет работу держателя (секция проекта, слот машины, аренды эпиков, контроллер гейтов `project-gates:<id>`); гейт эпика или проекта, потерявший аренду, даёт строку `project_lease_lost` в `blocked`, проход `project gates` — `blocked`, а не `passed`.
- продление (`renewLease`) не воскрешает истёкшую аренду: `UPDATE … WHERE token=? AND expires>now`, ноль строк — потеря; повторный вход в `withIntegrationLease` после потери внешней аренды сразу даёт `project_lease_lost`; `next-wave`, нативный `drain` (`withProjectControl`), `installRun` и `installGateRun` тоже идут под fencing своей аренды `project:<id>`;
- до публикации в `pending` Run сохраняются `before` и коммит слияния. Обрыв между `update-ref` и синхронизацией worktree (`reset --hard`) восстанавливается при повторе: ветка уже на коммите слияния, а индекс и файлы точно равны `before` (нет незавершённых операций и неотслеживаемых файлов, `git write-tree` равен дереву `before`) — worktree синхронизируется под `withWorktreeLock`; любое другое грязное состояние — `project_integration_worktree_invalid`.
- отказ публикации из-за сдвинутой ветки воркера (`project_submission_stale`) и «головы нет на ветке» под арендой интеграции снимают `pending` именно этой сдачи (условная fenced-запись по SHA): попытка не «окирпичивается», новый head той же попытки проверяется и сливается;
- возврат гейта (`mergeBackGate`) так же записывает `before`/`target` на gate Run до публикации (`gateReturn`), и следующая приёмка гейта восстанавливает точно совпавшее прерванное состояние worktree; `merge.verifySignatures` проверяет голову гейта в обоих вариантах возврата (fast-forward и merge-коммит), отказ — `project_integration_unverified_signature` структурированным `blocked`;
- `renewLease` берёт `now` уже под блокировкой записи (`BEGIN IMMEDIATE`): продление, ждавшее другого писателя дольше TTL, не проходит; Git, который не запустился или превысил таймаут при публикации, — сразу `project_lease_lost`, без второго вызова Git внутри транзакции (классификация `project_submission_stale` — после её завершения).

**Настройки Git при слиянии.** Kodo сливает задачи через `merge-tree --write-tree` (тот же алгоритм ort, что `git merge`) и `commit-tree`, а не `git merge`. Поэтому интеграционная ветка `kodo/project/<id>`, принадлежащая Kodo, не использует `branch.<ветка>.mergeOptions`. `merge.verifySignatures=true` сохраняет смысл: перед публикацией голова задачи проверяется `git verify-commit`, отказ — `project_integration_unverified_signature`. Ограничение: пользовательский драйвер слияния из `.gitattributes` вызывается `merge-tree` с другим значением плейсхолдера `%X` (имя временного файла), чем при `git merge`; драйверы, зависящие от него, не поддерживаются. Хуки Git (в том числе `reference-transaction`) при публикации отключены, как и во всех вызовах Git Kodo.

Сдача без `--defer-gate` после интеграции запускает гейты в одном проходе (`project-gates:<id>`); занятый проход — `project_busy`, квитанция хранит `gates: null`, и повтор сдачи запустит гейты один раз. Отмена, пауза, остановка или блокировка проекта проверяются до прохода; если они прервали проход, причину возвращает сам проход (`stopped`), а не следующий снимок: ничего не записывается (`gates` остаётся `null`), ответ — `blocked` с кодом `project_cancelled`, `project_control_blocked` или `project_lease_lost`, а `integration` в ответе показывает, что слияние уже сделано. Диспетчер после снятия паузы (или восстановления) повторяет ту же `complete-task` без `--defer-gate` либо вызывает `project gates PROJECT_ID`: гейты запустятся один раз.

## Идемпотентность

- Повтор `next-wave` возвращает те же брифы и не создаёт попыток: идущие попытки хоста подхватываются первыми, лимит добирается только свободными задачами. Назначен ли бриф чату, Kodo не знает: главный чат ведёт соответствие `attemptId → чат` сам и второй чат на ту же попытку не открывает (навык `kodo-project-director`).
- Владение резервом (`attemptExecutor`): у установленного Run — его `executor`, у резерва без Run (сбой между `reserveAttempt` и установкой) — actor события резерва. Такой резерв подхватывает только его владелец: `next-wave` того же хоста, а резерв `drain` (actor `project-director`) — только `drain`. Чужие попытки `next-wave` не трогает, `drain` не исполняет внешние попытки, а лишь считает их writePaths занятыми.
- Ошибка одной задачи не прерывает пачку: она попадает в `blocked` с кодом, следующий вызов продолжит её.
- Повтор `complete-task` с тем же head после интеграции возвращает сохранённый `externalCompletion` с `replayed: true` без проверки, слияния и гейтов. Отложенные и прерванные гейты диспетчер запускает через `project gates`. Первый повтор сдачи без `--defer-gate` тоже проверит ожидающие гейты, если в квитанции сдачи `gates: null`. Перед ответом повтор под lease `project-integration:<id>` сверяет, что записанный merge-коммит достижим из головы интеграционной ветки и его родители — записанный `before` и проверенный head; иначе (ветку откатили или переписали) ответ — `blocked`, `project_integration_missing`, `replayed: true`: это блокер восстановления, не `integrated`. Та же сверка — в `integrateAndAdvance` для всех путей восстановления: если сбой случился после переходов attempt и task в `integrated`, но до записи `externalCompletion`, повтор после отката ветки тоже отвечает `blocked`, `project_integration_missing`.
- Уже проверенный head после отказа интеграции повторно не проверяется; если сбой прервал интеграцию проверенного head (слияние `pending` или `merged` без `externalCompletion`), повтор продолжает её без новой проверки и без второго merge-коммита.
- `--abandon` переводит попытку в `blocked` и отменяет Run (`cancelRequested`, `cancelled`), записывая в Run `externalAbandon: {schemaVersion: 1, attemptId, headSha}`; ответ содержит `attemptId`. Отказ привязан к попытке: `--abandon` требует `--attempt <attemptId>` (поле `abandonCommand` брифа, `<SHA>` — последний SHA воркера или `brief.baseSha`); CLI без `--attempt` — `project_arguments`. Библиотечный вызов `completeTask` без `attemptId` допустим только как однозначный повтор уже записанного отказа: ровно один Run задачи с `externalAbandon.headSha = --head` — его результат с `replayed: true` без изменений; иначе `project_arguments`, текущая попытка не останавливается. Повтор возвращает `abandoned` с `replayed: true` и `attemptId` той попытки и не трогает текущую (новую после `next-wave --retry-failed`); `--attempt` не текущей и не отменённой попытки — `project_attempt_stale`. Чтобы отменить новую попытку с той же базой, укажи её `--attempt`. Новую попытку создаёт только `next-wave --retry-failed` того же хоста, со своим Run и worktree. Повтор идёт тем же исполнителем, что и прошлая попытка: `next-wave --retry-failed` пропускает неудачные попытки `drain` и других хостов (`project_retry_executor` в `blocked`), а `drain --retry-failed` не исполняет нативно задачу, брошенную внешним чатом (`wave_retry_executor`).

## Ограничения

- Конфликт при интеграции (`blocked`, `project_integration_conflict`) переводит попытку в `blocked`; Run остаётся `succeeded` на проверенном head, задача — `running`. Rebase на новую голову интеграционной ветки протоколом не поддерживается: diff от старой базы захватит чужие изменения и не пройдёт проверку scope. Выход — `--abandon --attempt` этой попытки (ответ `abandoned` с `replayed: true`, Run отменяется) и `next-wave --retry-failed`; до повтора `next-wave` показывает задачу как `project_retry_required`.
- `next-wave` держит lease `project:<id>` всё время вызова, как `drain` и foreground-директор: пока его держит другой контроллер (например, идущий `drain`), ответ — `project_busy`, команду повторяют позже. `complete-task` берёт `project:<id>` только на короткие секции и ждёт его (до 120 с, затем `project_busy`) — см. «Параллельные сдачи». Проверку одного Run сериализует lease `run:<id>`, слияния и переходы, чьё доказательство читает интеграционную ветку (`integrated`, `accepted`), — lease `project-integration:<id>`, который держится до фиксации перехода ([PROJECTS.md](PROJECTS.md), «Lease до фиксации»).
- `--command-id` используется только для перехода `--abandon`; команды интеграции директор строит сам.
- Gate Run эпика и принятие задач (`accepted`) выполняет директор (`runPendingGates`) внутри `complete-task`, `gates` или `drain`.
- У отдельного прохода `project gates` есть собственный lease `project-gates:<id>`. Он исключает второй проход, `drain` и сдачу со встроенным гейтом (такая сдача после интеграции отвечает `project_busy`; её повтор запустит гейты). Сам проход не держит `project:<id>`: резерв, установка и приёмка гейта идут короткими секциями `project:<id>` + `project-integration:<id>`, а проверка и ремонт в worktree gate Run — вне них, так что `next-wave` и сдачи с `--defer-gate` работают параллельно. Резерв, интеграция и приёмка по-прежнему сериализованы.
- Гейты независимых эпиков выполняются одновременно внутри одного прохода. Каждый гейт держит lease своего эпика `project-gate:<projectId>:<epicId>`; гейт, который принимает майлстоун или проект, дополнительно держит `project-gate:<projectId>:milestone:<id>` / `project-gate:<projectId>:project:<id>` и lease всех эпиков внутри — он эксклюзивен относительно гейтов своих эпиков. Последний открытый эпик майлстоуна ждёт, пока идут гейты его соседей, чтобы его гейт принял и майлстоун; так же ждёт последний открытый эпик всего проекта (иначе его гейт расширился бы до проекта и столкнулся с арендами соседей). Если нужный lease держит другой процесс, гейт не ждёт: строка `blocked` с кодом `project_gate_running` (повтори `project gates` позже). Правила `gateHolds` и `project_gate_pending` в `next-wave` не меняются.
- Для `waiting_limits` обычная команда `gates` продолжит тот же Run после восстановления лимита. Гейт в состоянии `blocked`, `failed` или `cancelled` требует явного повтора. Восстановив окружение или доступ к подписочному клиенту, диспетчер вызывает `project gates PROJECT_ID --retry-failed --json`. При `project_integration_conflict` во время возврата ремонта результат соседней задачи уже находится в интеграционной ветке. Тот же явный повтор проверит эту голову заново. Директор резервирует новый гейт на текущей интеграционной голове, с проверками и ограниченным ремонтом в путях покрытых задач. У интегрированной задачи `--abandon` даст `project_attempt_not_running`, а `next-wave --retry-failed` её пропустит. Добавление майлстоуна требует принятого или выпущенного проекта. Если нужен патч сверх возможностей ремонта гейта, покажи пользователю причину и останови повторы. Проект на паузе, отменённый, проваленный или заблокированный — `blocked`, `project_control_blocked` (те же состояния отклоняет `complete-task`); отменённый проход — `blocked`, `project_cancelled`, даже если гейты не успели заблокироваться; не-wave проект — `project_wave_required`.
- Если проверки прошли, а приёмка отклонила доказательство, gate Run сохраняет `blocked` и `error.code`. Например, `wave_gate_proof_missing` у критерия с единственным видом `delivery` означает, что гейт не выпускает требуемое доказательство доставки. Обычный `project gates` возвращает сохранённый отказ. Явный повтор резервирует новый Run на текущей голове и проверяет условие снова. Если требование по-прежнему невыполнимо, сообщи пользователю критерий и код отказа.
- Kodo не создаёт, не читает и не архивирует чаты хоста; это делает главный чат своими инструментами: в T3 — `delegate_task`, правки в тот же чат — `t3_thread_send`, архив — `t3_thread_organize` с `action: "archive"` и `childThreadId` из ответа `delegate_task` сразу после итога задачи (`integrated` или `abandoned`), а не в конце проекта (навык `kodo-project-director`).
- Orca использует тот же протокол (`--host orca`), но с Orca он не проверялся.
- Функции директора (`selectWave`, `createWaveContext`, `integrateAndAdvance`, `runPendingGates`) берутся из `runtime/project-director-waves.mjs`; модульные тесты протокола подменяют их fake-портами, сквозной `tests/project-wave-e2e.test.mjs` идёт без подмен.

## Проверка

```powershell
node --test tests/project-external.test.mjs tests/project-external-cli.test.mjs tests/project-wave-e2e.test.mjs
```

### Уборка каталогов завершённых задач

После проверки доказательств выполните `kodo project gc-worktrees PROJECT_ID --json`. Команда обрабатывает рабочие копии задач нативных и внешних воркеров со статусом `integrated` или `abandoned`. Для удаления нужна отметка Kodo, записанная в служебный каталог Git при создании новой рабочей копии. Kodo сверяет канонический путь, регистрацию Git, идентичность каталога, ветку и сохранённый HEAD. Запуск с занятой арендой `run:<id>` пропускается. Из игнорируемых файлов допускаются только обычные файлы в каталогах сборки `target/` и `node_modules/`. Ссылка или junction внутри такого каталога останавливает уборку. Git удаляет проверенную копию и сохраняет ветку. Kodo также удаляет опустевший родительский каталог задачи.

В ответе `removed` содержит идентификаторы удалённых копий, `retained` — занятых или сохранённых из-за состояния файлов. В `incomplete` попадают незавершённые регистрации, копии без отметки Kodo и подменённые каталоги. Их можно осмотреть вручную.
