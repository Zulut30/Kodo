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
kodo project complete-task --head ►  проверка commit, task-fast,
                                    интеграция, gate Run эпика
            ◄──────────────────────  integrated | checks_failed | blocked
```

1. `next-wave` под lease `project:<id>` создаёт или находит интеграционную ветку `kodo/project/<id>` (`ensureIntegration`) и сначала возвращает брифы уже идущих внешних попыток этого хоста. Затем добирает пачку до `--limit` через `selectWave(snapshot, {limit, inFlight})` директора: задачи без пересечения `writePaths` с идущими. Для каждой новой задачи: `task → ready`, `reserveAttempt`, черновик Run через `engine.createReserved` и `repo.installRun`, worktree на ветке `kodo/<runId>` от головы интеграционной ветки (`waveFrontier`), Run в `executing`, переходы `attempt/task → running`.
2. Главный чат открывает по брифу один воркер-чат с заголовком `brief.chatTitle`. Второй worktree хост не создаёт: чат запускается в общей папке проекта и работает по абсолютному пути `brief.worktree`.
3. Воркер коммитит в `brief.branch`, запускает `brief.selfCheck` и возвращает полный SHA.
4. `complete-task` проверяет коммит, один раз выполняет `task-fast` (`verifyTaskFastOnce`), переводит Run в `succeeded` и передаёт его `integrateAndAdvance` директора. Если не задан `--defer-gate`, затем вызывается `runPendingGates`.

## Run внешней задачи

| Поле | Значение |
| --- | --- |
| `executor` | `{kind: 'external', host}` — `Engine.run()` такой Run не исполняет (`project_run_not_native`) |
| `verificationProfile` | `'task-fast'` |
| `config.repairRounds` | `1`; ремонта при `complete-task` нет |
| `config.delivery.enabled` | `false`; доставку делает координатор |
| `baseSha` | голова интеграционной ветки на момент резерва |
| `state` | `executing` после резерва, `succeeded` после пройденной проверки |
| `externalCompletion` | `{schemaVersion, headSha, integration, gates}` после интеграции; `gates: null` при `--defer-gate` |

Переходы волновых задач авторизует `createExternalTransitionAuthorizer`: authorizer директора с evaluator `evaluateWaveTransition` и проверкой Run профиля `task-fast` (Run совпадает с сохранённым, binding и frozen task прежние, корень проекта не сменился; у `succeeded` — чистый worktree на проверенном head, неизменные `commands` и целые evidence быстрых проверок). Принятие (`accepted`) gate Run'ом этот authorizer не покрывает.

## Бриф

| Поле | Смысл |
| --- | --- |
| `projectId`, `taskId`, `attemptId`, `runId` | Идентичность попытки |
| `chatTitle` | `Kodo · [<epicId>] <task.title>` |
| `role`, `roleInstructions` | Роль из `task.owner`; профиль из `worker-roles.mjs` |
| `writePaths` | Единственные пути, которые можно менять |
| `worktree`, `branch`, `baseSha` | Рабочая копия, её ветка и база |
| `interfaces` | Пути `interfaceRefs` самой задачи (неизменяемые evidence-файлы) |
| `prompt` | Точный `buildDirectorTaskInput` задачи и контракт воркера |
| `selfCheck` | `kodo ci feedback --base <baseSha> --project "<worktree>" --json` |
| `completeCommand` | `kodo project complete-task <projectId> <taskId> --head <SHA>` |

Контракт воркера в `prompt`: работать только в worktree и только в `writePaths`; не удалять, не пропускать и не ослаблять тесты; закоммитить в свою ветку без push, PR, merge и rebase; запустить `selfCheck`; закончить с чистым worktree и вернуть полный SHA. Бриф проходит `assertDirectorSafe` (известные секреты, PEM, redaction). Из абсолютных путей он содержит только worktree, пути `interfaces` и `projectContext.root` внутри замороженного входа задачи; state home, артефакты Run и интеграционный worktree в бриф не попадают.

## Роли

`architect`, `developer`, `ui-qa`, `performance`, `security`, `reviewer` — короткие профили (до 1 КБ) без путей и данных проекта. Неизвестная роль получает профиль `developer`.

## Команды

```text
kodo project next-wave PROJECT_ID --host t3|orca [--limit 1..5] [--retry-failed] [--json]
kodo project complete-task PROJECT_ID TASK_ID --head SHA [--defer-gate|--abandon] [--command-id UUID] [--json]
```

Аргументы разбираются строго до чтения учётных данных, состояния и Git; любая ошибка — exit 1, `project_arguments`. `--limit` по умолчанию 3.

| Команда | Результат | Exit |
| --- | --- | --- |
| `next-wave` | `{projectId, revision, briefs, blocked:[{taskId, code}]}` | 0 — есть брифы, 2 — пусто |
| `complete-task` | `integrated` (`integration`, `gates`), `abandoned` | 0 |
| `complete-task` | `checks_failed` (`code`, `message`), `blocked` (`code`) | 2 |

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
| `external_symlink` | В diff есть симлинк или submodule |
| `external_scope`, `external_unsafe_change` | Файлы вне `writePaths`, секретные имена или содержимое (`engine.checkScope`) |
| код быстрой проверки | `task-fast` или behaviour gate не прошли (например, `check_failed`, `behavior_failed` при удалённом тесте) |

`blocked`: попытка не внешняя, не идёт или уже интегрирована (`project_attempt_not_running`), проект на паузе или остановлен (`project_control_blocked`), отказ `integrateAndAdvance` (его код).

## Идемпотентность

- Повтор `next-wave` возвращает те же брифы и не создаёт попыток: идущие попытки хоста подхватываются первыми, лимит добирается только свободными задачами. Резерв без установленного Run (сбой между записями) подхватывается тем же вызовом.
- Ошибка одной задачи не прерывает пачку: она попадает в `blocked` с кодом, следующий вызов продолжит её.
- Повтор `complete-task` с тем же head после интеграции возвращает сохранённый `externalCompletion` с `replayed: true` без проверки, слияния и гейтов. Отложенные `--defer-gate` гейты выполнит первый повтор без этого флага.
- Уже проверенный head после отказа интеграции повторно не проверяется.
- `--abandon` переводит попытку в `blocked` и отменяет Run (`cancelRequested`, `cancelled`); повтор возвращает `abandoned` с `replayed: true`. Новую попытку создаёт только `next-wave --retry-failed`, со своим Run и worktree.

## Ограничения

- Конфликт при интеграции оставляет попытку `running` со статусом `blocked`. Rebase на новую голову интеграционной ветки протоколом не поддерживается: diff от старой базы захватит чужие изменения и не пройдёт проверку scope. Выход — `--abandon` и `next-wave --retry-failed`.
- `next-wave` держит lease `project:<id>`, как foreground-директор: пока его держит другой контроллер, ответ — `project_busy`. `complete-task` этот lease не берёт; проверку сериализует lease `run:<id>`, слияния — директор.
- `--command-id` используется только для перехода `--abandon`; команды интеграции директор строит сам.
- Gate Run эпика и принятие задач (`accepted`) выполняет директор (`runPendingGates`); переходы принятия этот authorizer не авторизует.
- Kodo не создаёт, не читает и не архивирует чаты хоста; это делает главный чат своими инструментами.
- Orca использует тот же протокол (`--host orca`), но с Orca он не проверялся.
- Функции директора (`selectWave`, `createWaveContext`, `integrateAndAdvance`, `runPendingGates`) берутся из `runtime/project-director-waves.mjs`; тесты протокола подменяют их fake-портами.

## Проверка

```powershell
node --test tests/project-external.test.mjs tests/project-external-cli.test.mjs
```
