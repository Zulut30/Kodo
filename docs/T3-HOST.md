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
kodo project next-wave PROJECT_ID --host t3|orca [--limit 1..5] [--retry-failed] [--json]
kodo project complete-task PROJECT_ID TASK_ID --head SHA [--defer-gate] [--attempt UUID] [--command-id UUID] [--json]
kodo project complete-task PROJECT_ID TASK_ID --head SHA --abandon --attempt UUID [--command-id UUID] [--json]
kodo project gates PROJECT_ID [--retry-failed] [--json]
```

Аргументы разбираются строго до чтения учётных данных, состояния и Git; любая ошибка — exit 1, `project_arguments`. `kodo project --help` и `kodo project <действие> --help` (или `-h`) печатают справку проектных команд (с `--json` — `result.status: "help"`, `result.usage`) с exit 0 ещё до разбора, без ключей и состояния. `--abandon` без `--attempt` — тоже `project_arguments`. `--limit` по умолчанию 3.

| Команда | Результат | Exit |
| --- | --- | --- |
| `next-wave` | `{projectId, revision, cli, briefs, blocked:[{taskId, code}]}` | 0 — есть брифы, 2 — пусто |
| `complete-task` | `integrated` (`integration`, при встроенном проходе также `gates`), `abandoned` | 0 |
| `complete-task` | `checks_failed` (`code`, `message`), `blocked` (`code`) | 2 |
| `gates` | `passed` (`gates`) | 0 |
| `gates` | `blocked` (`gates` с заблокированными гейтами или `code`) | 2 |

Ошибки отчёта — константные коды: собственные коды протокола (`project_wave_required`, `project_host_unsupported`, `project_busy`, `project_attempt_not_external` и др.) или `project_invalid`/`project_blocked`. Пути, аргументы и вывод провайдеров в ошибки не попадают.

### Проверки complete-task

Дефект, который воркер может исправить, даёт `checks_failed`; попытка остаётся `running`, воркер присылает новый head.

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

## Идемпотентность

- Повтор `next-wave` возвращает те же брифы и не создаёт попыток: идущие попытки хоста подхватываются первыми, лимит добирается только свободными задачами. Назначен ли бриф чату, Kodo не знает: главный чат ведёт соответствие `attemptId → чат` сам и второй чат на ту же попытку не открывает (навык `kodo-project-director`).
- Владение резервом (`attemptExecutor`): у установленного Run — его `executor`, у резерва без Run (сбой между `reserveAttempt` и установкой) — actor события резерва. Такой резерв подхватывает только его владелец: `next-wave` того же хоста, а резерв `drain` (actor `project-director`) — только `drain`. Чужие попытки `next-wave` не трогает, `drain` не исполняет внешние попытки, а лишь считает их writePaths занятыми.
- Ошибка одной задачи не прерывает пачку: она попадает в `blocked` с кодом, следующий вызов продолжит её.
- Повтор `complete-task` с тем же head после интеграции возвращает сохранённый `externalCompletion` с `replayed: true` без проверки, слияния и гейтов. Отложенные и прерванные гейты диспетчер запускает через `project gates`. Первый повтор сдачи без `--defer-gate` тоже проверит ожидающие гейты, если в квитанции сдачи `gates: null`. Перед ответом повтор под lease `project-integration:<id>` сверяет, что записанный merge-коммит достижим из головы интеграционной ветки и его родители — записанный `before` и проверенный head; иначе (ветку откатили или переписали) ответ — `blocked`, `project_integration_missing`, `replayed: true`: это блокер восстановления, не `integrated`. Та же сверка — в `integrateAndAdvance` для всех путей восстановления: если сбой случился после переходов attempt и task в `integrated`, но до записи `externalCompletion`, повтор после отката ветки тоже отвечает `blocked`, `project_integration_missing`.
- Уже проверенный head после отказа интеграции повторно не проверяется; если сбой прервал интеграцию проверенного head (слияние `pending` или `merged` без `externalCompletion`), повтор продолжает её без новой проверки и без второго merge-коммита.
- `--abandon` переводит попытку в `blocked` и отменяет Run (`cancelRequested`, `cancelled`), записывая в Run `externalAbandon: {schemaVersion: 1, attemptId, headSha}`; ответ содержит `attemptId`. Отказ привязан к попытке: `--abandon` требует `--attempt <attemptId>` (поле `abandonCommand` брифа, `<SHA>` — последний SHA воркера или `brief.baseSha`); CLI без `--attempt` — `project_arguments`. Библиотечный вызов `completeTask` без `attemptId` допустим только как однозначный повтор уже записанного отказа: ровно один Run задачи с `externalAbandon.headSha = --head` — его результат с `replayed: true` без изменений; иначе `project_arguments`, текущая попытка не останавливается. Повтор возвращает `abandoned` с `replayed: true` и `attemptId` той попытки и не трогает текущую (новую после `next-wave --retry-failed`); `--attempt` не текущей и не отменённой попытки — `project_attempt_stale`. Чтобы отменить новую попытку с той же базой, укажи её `--attempt`. Новую попытку создаёт только `next-wave --retry-failed` того же хоста, со своим Run и worktree. Повтор идёт тем же исполнителем, что и прошлая попытка: `next-wave --retry-failed` пропускает неудачные попытки `drain` и других хостов (`project_retry_executor` в `blocked`), а `drain --retry-failed` не исполняет нативно задачу, брошенную внешним чатом (`wave_retry_executor`).

## Ограничения

- Конфликт при интеграции оставляет попытку `running` со статусом `blocked`. Rebase на новую голову интеграционной ветки протоколом не поддерживается: diff от старой базы захватит чужие изменения и не пройдёт проверку scope. Выход — `--abandon` и `next-wave --retry-failed`.
- `next-wave` и `complete-task` держат lease `project:<id>`, как `drain` и foreground-директор: пока его держит другой контроллер (например, идущий `drain`), ответ — `project_busy`, команду повторяют позже. Проверку дополнительно сериализует lease `run:<id>`, слияния и переходы, чьё доказательство читает интеграционную ветку (`integrated`, `accepted`), — lease `project-integration:<id>`, который держится до фиксации перехода ([PROJECTS.md](PROJECTS.md), «Lease до фиксации»).
- `--command-id` используется только для перехода `--abandon`; команды интеграции директор строит сам.
- Gate Run эпика и принятие задач (`accepted`) выполняет директор (`runPendingGates`) внутри `complete-task`, `gates` или `drain`.
- У отдельного прохода `project gates` есть собственный lease `project-gates:<id>`. Он исключает второй проход, `drain` и сдачу со встроенным гейтом. На время проверки и ремонта в worktree gate Run проход освобождает `project:<id>` для `next-wave` и сдач с `--defer-gate`. Перед приёмкой он вновь получает проектный lease. Резерв, интеграция и приёмка по-прежнему сериализованы.
- Для `waiting_limits` обычная команда `gates` продолжит тот же Run после восстановления лимита. Гейт в состоянии `blocked`, `failed` или `cancelled` требует явного повтора. Восстановив окружение или доступ к подписочному клиенту, диспетчер вызывает `project gates PROJECT_ID --retry-failed --json`. При `project_integration_conflict` во время возврата ремонта результат соседней задачи уже находится в интеграционной ветке. Тот же явный повтор проверит эту голову заново. Директор резервирует новый гейт на текущей интеграционной голове, с проверками и ограниченным ремонтом в путях покрытых задач. У интегрированной задачи `--abandon` даст `project_attempt_not_running`, а `next-wave --retry-failed` её пропустит. Добавление майлстоуна требует принятого или выпущенного проекта. Если нужен патч сверх возможностей ремонта гейта, покажи пользователю причину и останови повторы. Проект на паузе, отменённый, проваленный или заблокированный — `blocked`, `project_control_blocked` (те же состояния отклоняет `complete-task`); отменённый проход — `blocked`, `project_cancelled`, даже если гейты не успели заблокироваться; не-wave проект — `project_wave_required`.
- Если проверки прошли, а приёмка отклонила доказательство, gate Run сохраняет `blocked` и `error.code`. Например, `wave_gate_proof_missing` у критерия с единственным видом `delivery` означает, что гейт не выпускает требуемое доказательство доставки. Обычный `project gates` возвращает сохранённый отказ. Явный повтор резервирует новый Run на текущей голове и проверяет условие снова. Если требование по-прежнему невыполнимо, сообщи пользователю критерий и код отказа.
- Kodo не создаёт, не читает и не архивирует чаты хоста; это делает главный чат своими инструментами: в T3 — `delegate_task`, правки в тот же чат — `t3_thread_send`, архив — `t3_thread_organize` с `action: "archive"` и `childThreadId` из ответа `delegate_task` сразу после итога задачи (`integrated` или `abandoned`), а не в конце проекта (навык `kodo-project-director`).
- Orca использует тот же протокол (`--host orca`), но с Orca он не проверялся.
- Функции директора (`selectWave`, `createWaveContext`, `integrateAndAdvance`, `runPendingGates`) берутся из `runtime/project-director-waves.mjs`; модульные тесты протокола подменяют их fake-портами, сквозной `tests/project-wave-e2e.test.mjs` идёт без подмен.

## Проверка

```powershell
node --test tests/project-external.test.mjs tests/project-external-cli.test.mjs tests/project-wave-e2e.test.mjs
```
