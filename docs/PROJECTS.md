# Project Director: offline backlog и foreground execution

MVP06 добавляет durable `Project → Milestone → Epic → Task → Attempt` рядом с legacy Run. SQLite Kodo остаётся источником состояния; `status` — ограниченная сводка, не доказательство приёмки. Реализация интегрирована локально; общая приёмка06 ещё pending. [Статус и evidence](kodo-roadmap/phase-06.md), [ADR-0008](decisions/0008-project-director.md).

## CLI и конфигурация

Нужны Node.js 24 и существующий owned абсолютный `root`; для выполнения — Git с исходным commit и настроенный проект. В исходном checkout заменяй `kodo` на `node <путь-к-Kodo>/cli/index.mjs`.

```text
kodo project create --file SPEC [--command-id UUID] [--json]
kodo project status PROJECT_ID [--json]
kodo project plan PROJECT_ID [--limit 1..24] [--dry-run] [--json]
kodo project resume PROJECT_ID [--retry-failed] [--command-id UUID] [--json]
kodo project cancel|pause PROJECT_ID [--command-id UUID] [--json]
kodo project reprioritize PROJECT_ID TASK_ID --priority 0..100 [--command-id UUID] [--json]
kodo project approve-risk PROJECT_ID TASK_ID --reason TEXT [--command-id UUID] [--json]
```

`PROJECT_ID` — возвращённый UUID, а `Task.id` — slug. Лишние/повторные флаги и аргументы отклоняются до чтения credentials/state. JSON имеет форму `{schemaVersion:1, projectId, revision, result}`. Exit0 означает успешное выполнение команды, exit1 — invalid input, exit2 — blocked/неуспешное foreground выполнение. Ошибки содержат только безопасные постоянные коды. Успешный `status` не означает accepted; `plan` возвращает exit2 при пустом `taskIds`, даже если все задачи уже завершены.

`plan` всегда dry-run, с флагом `--dry-run` и без него: не резервирует Attempt и не запускает Engine. Команды offline/control не открывают provider sessions. Они лениво создают Project composition и могут инициализировать Store/миграцию: это не обещание filesystem read-only. Coordinator-only known values загружаются перед hash/write/output; нужны явные отдельные `KODO_HOME` и `KODO_CREDENTIAL_HOME` для безопасной проверки примеров.

Project CLI **не принимает** `--project`, `--mode`, `--model`, `--prepare` или `--concurrency`. Root берётся из ProjectSpec. `executionMode`, `client`, `primaryModel`, разрешённые `models`, команды, gates и delivery задаются в `<root>/kodo.config.json`, по [правилам runtime](RUNTIME.md#режимы-исполнения). Режим исполнения quick/standard/deep не является игровым форматом Standard/Wild/Battlegrounds. Пример отдельного ограничения для offline planning:

```json
{"schemaVersion":1,"client":"codex","executionMode":"quick","maxTasks":1,"researchBudget":0,"repairRounds":1,"concurrency":1}
```

Это не готовый execution config: перед `resume` нужны реальные обязательные test/build команды и настройки gates/delivery целевого проекта. GPT/Claude исполняются только через авторизованные подписочные клиенты. Ключи остаются у координатора вне Git, ProjectSpec, prompts, workers и logs; API fallback отсутствует. Сохранённые mode/model/budgets/quota/session границы существующего Run сохраняются. Новый Project retry переносит прежний режим/модель и меньшие research/repair/concurrency/maxTasks; расширение требует отдельного нового запуска.

## Формат ProjectSpec v1

Авторитетный strict parser — [project-contracts.mjs](../runtime/project-contracts.mjs), отдельного JSON Schema для Director нет. Неизвестные поля отклоняются; перечисленные поля обязательны, пустые reference arrays допустимы.

| Запись | Поля |
| --- | --- |
| ProjectSpec | `schemaVersion:1, id, root, title, definitionOfDone, constraints, businessContext, architectureRefs, milestones, epics, tasks` |
| MilestoneSpec | `id, title, acceptance, releaseRequired` |
| EpicSpec | `id, milestoneId, title, acceptance` |
| TaskSpec | `id, epicId, title, description, owner, dependsOn, writePaths, acceptance, interfaceRefs, priority, userValue, risk, estimatedEffort, riskApprovalRequired` |
| Criterion | `id, text, evidenceKinds` (непустой список) |
| Ref | `kind, runId:null\|UUID, headSha:null\|SHA, path, sha256` |
| Mapping | `criterionId, refs:[sha256], actor, reason` |

`id` — slug `[a-z][a-z0-9-]{0,47}`; родители и зависимости принадлежат одному Project, DAG не содержит циклов. `writePaths` — непустые безопасные repository-relative scopes. `priority` 0–100, `userValue`/`risk` 0–5, `estimatedEffort` — положительное safe integer. Ref kinds: `interface`, `acceptance`, `checks`, `review`, `contract`, `delivery`, `release`; path указывает на owned private immutable evidence вне Git, не на credentials. Создание записи с Ref не подтверждает её истинность.

Bounds: до1000 элементов в typed collections, глубина16 и raw safety budget32MiB. Полный обязательный task input с immutable Project context ограничен12000 UTF-8 bytes; превышение требует разделить задачу (`split_required`), а не обрезать acceptance/constraints. План выбирает горизонт1–24 с учётом меньшего mode/project cap; весь backlog не помещается в prompt одного Run. Ранжирование: critical path, priority, value, risk по убыванию, затем effort и id. Непринятые зависимости, непроверенные interfaces, отсутствие актуального risk approval, pause/control или существующая попытка блокируют выбор.

## Внутренние порты и durable boundaries

Это ESM interfaces для доверенной coordinator composition, не JSON-флаги полномочий:

| Модуль / export | Ответственность |
| --- | --- |
| `project-contracts`: `normalizeProjectSpec`, `normalizeDirectorRecord`, `directorBytes`, `directorContractHash`, `buildDirectorTaskInput`, `assertDirectorSafe`, `assertProjectTransition` | Общие схемы, порядок байтов/hash и safety; options содержат явный `knownValues` |
| `project-store`: `await openProjectStore({store,contracts,authorizeTransition})` | Возвращает `apply(command)`, `snapshot(projectId)`, `history(projectId,{after,limit})`, `installRun({binding,runDraft})` |
| `project-planner`: `planProjectHorizon({snapshot,limit,availability,now},ports)` | Чистый bounded DAG plan, `{schemaVersion,projectId,revision,taskIds,blocked,order,dryRun:true}` |
| `project-evidence`: `evaluateProjectAttempt`, `evaluateProjectTransition` | Await trusted `verifyRef`/`validateRun`; eligibility/blockers не дают права записывать terminal state |
| `project-director`: `createProjectTransitionAuthorizer({store,engine,contracts,evaluator})` | Свежая проверка фактического Run/head/config/gates/evidence перед разрешением перехода |
| `project-director`: `createProjectDirector({repo,engine,planner,evaluator,clock})` | `plan/run/resume/cancel/pause/reprioritize/approveRisk`, переиспользование Engine |
| `project-progress`: `buildProjectProgress(snapshot)`; `project-cli`: `projectCli(argv,ports)` | Bounded counts-only сводка; strict CLI и `{report,exitCode,output}` |

Snapshot: `{schemaVersion,project,revision,milestones,epics,tasks,currentAttempts,riskApprovals,completeness}`. Каждая count-запись содержит `total/returned/complete` из одной SQL read transaction; incomplete не доказывает полноту. `currentAttempts` включает последнюю settled попытку каждой задачи; старые попытки/approvals сохранены в истории, current approvals соответствуют Task.revision. Events читаются отдельно: history возвращает `events,total,complete,nextAfter` после cursor, limit1–1000.

Command: `{schemaVersion:1,commandId,projectId,expectedRevision,actor,reason,action}`. Create использует null projectId/revision; остальные записи — CAS. Action ops: `create/insert/amend/transition/setPaused/approveRisk/reserveAttempt`; это не дополнительные CLI-команды. Идентичный command ID+payload replay возвращает прежний результат; изменённый payload отклоняется. Reprioritize меняет Task revision и тем самым инвалидирует старое risk approval; active Task не переопределяется. Immutable Project context не имеет amend в MVP.

Хранилище использует additive namespaced tables/version registry в существующем `Store.db`, без захвата `user_version` и переписывания legacy Run. Перед первой миграцией — Node24 SQLite consistent backup с WAL, затем atomic migration; резервная копия остаётся вне Git в `project-backups/migration-*`. Offline restore требует закрытых handles и защиты более новых записей. Reserve фиксирует Attempt/runId/Task revision/contractHash; install атомарно связывает полный legacy Run и binding. Повтор после crash согласует ту же reservation, не создаёт второй Run. Legacy прямые callers сохраняют прежний default I/O.

## Lifecycle и текущие ограничения

`proposed → ready → running → verifying → integrated → accepted → released`, плюс blocked/failed/cancelled; Attempt начинается с reserved. Ни текст «completed», ни `verified:true`, ни переданные `eligibleStates` не заменяют trusted authorizer. Он await-ит доказательства до write transaction; Store повторяет CAS/control/binding checks внутри неё, без await. Safety проверяет декодированные ключи и значения до hash/write/output, включая короткие known values, PEM и изменения от redaction; ошибки не раскрывают совпавший секрет.

Accepted требует exact frozen task, фактические checks и независимый review текущего clean head, criterion mappings и свежие enabled gates. Disabled — neutral. Released дополнительно требует проверенную publication chain; Project release требует released у `releaseRequired` milestones. Accepted history не понижается.

Epic/Milestone/Project требуют полный набор принятых children **и собственные** criterion evidence/mappings. Автоматическая Task success observation не является собственным proof контейнера. В текущем CLI нет ввода/amend evidence и mappings контейнера или произвольных backlog edits; это trusted repository integration. Поэтому даже все принятые Task могут оставить `resume` blocked (`own_proof_missing`, неоднозначный bound Run и другие причины). Шаблоны ниже не обходят эту границу и не обещают end-to-end project acceptance.

`resume` — явная foreground команда: обрабатывает одну Task/Attempt через существующий Engine и возвращается; не постоянный daemon и не drain-loop всего backlog. Единственная project lease не допускает второго foreground controller. Restart/quota возобновляют ту же reservation/Run с прежними sessions и limits; `--retry-failed` явно создаёт следующую попытку для blocked/failed/cancelled Attempt, сохраняя историю. Это не `--retry-failed` цикла legacy Run. Несколько retry candidates требуют разрешения неоднозначности; отменённый Project не возобновляется.

`pause` сохраняет флаг и блокирует следующие starts/advancement, сохраняя уже активный Run/session; `resume` снимает pause. `cancel` сначала сохраняет control, затем помечает и отменяет unfinished Runs. Явная отмена/потеря lease/abort сохраняют cancellation semantics. Sophisticated prioritization UI, daemon, generic framework и автоматический container evidence importer отложены.

## Два шаблона и воспроизведённый smoke

В source checkout: `examples/projects/rust-git-cli.json` и `examples/projects/hearthstone-analytics.json`. Для установленного пакета исходники доступны в [Rust template](https://github.com/Zulut30/Kodo/blob/main/examples/projects/rust-git-cli.json) и [Hearthstone template](https://github.com/Zulut30/Kodo/blob/main/examples/projects/hearthstone-analytics.json) после доставки соответствующего commit; до merge используйте candidate checkout координатора. npm `files` не включает `examples`: эти JSON не заявлены bundled resources. Берите шаблоны из той же проверяемой ревизии, не из случайной версии main.

Оба — synthetic orchestration specifications, не реализованные продукты. В Rust неизвестны toolchain/library/platform guarantees; в Hearthstone неизвестны patch/source/license/window/population/sample, форматы Standard/Wild/Battlegrounds разделены. Пустые refs не изображают frozen interfaces. Root-пути — заглушки; CLI не выполняет подстановку env в JSON.

Проверка05.11.2026: Windows x64, Node24.19.0/ABI137, Kodo source `3817af81796803fe3311e44e7d3e3b4a79425c4f`. Собственные копии обоих JSON получили реальные temporary Git roots с исходным commit, отдельные empty credentials/state/client homes и allowlisted environment без provider keys. Config: quick/maxTasks1/research0/repair1/concurrency1, пустые commands, delivery/security/UI/architecture disabled **только у fixtures**. Это не ослабляет configured gates Kodo.

Для каждой копии фактически выполнено (`$Cli`, `$Guard`, `$Spec` — абсолютные пути; guard передаётся file URL, `$Id` — UUID create):

```powershell
node --import $Guard $Cli project create --file $Spec --json
node --import $Guard $Cli project create --file $Spec --command-id $CommandId --json
# Предыдущая строка повторена с тем же CommandId: replayed=true.
node --import $Guard $Cli project status $Id --json
node --import $Guard $Cli project plan $Id --limit 24 --dry-run --json
node --import $Guard $Cli project plan $Id --limit 1 --json
node --import $Guard $Cli project status $Id --json
```

Первая команда использовала отсутствующий owned root: exit1/invalid. После замены только root на созданный Git root: create/replay/status/оба plan/status exit0. Итого14 subprocess observations; revision1, Task3, currentAttempts0, before/after status идентичны. Rust выбирает `cli-contract`, Hearthstone — `data-contract`; две зависимые Task заблокированы `dependency_not_accepted`. Plan с `--dry-run` и без него совпал. Guard наблюдал network/provider entry attempts0 во всех14 командах; это не измерение native HTTP или подписочной стоимости.

Private reproduction: `C:/Users/zulut/AppData/Local/Temp/kodo-roadmap-20261104/phase06-receipts/project-docs/offline-examples.mjs`; запуск `node <этот-script> <project-docs-worktree>`. `observations.json` хранит exact argv/env/exits/stdout/stderr, roots, hashes исходных JSON и fixture heads; `offline-run.log`, snapshots и `manifest.json` сохраняют источник/границы проверки. Первая ошибка самого harness (Windows absolute path в `--import`, `ERR_UNSUPPORTED_ESM_URL_SCHEME`) сохранена в `harness-initial-failure.log`; исправлена на file URL до product observations. Она не считается product RED. Missing-root→owned-root — проверка входа, не red/green регрессия исполняемого кода.

Не запускались resume, providers/sessions, Rust binary, live Hearthstone, UI/security gates, repository-wide tests/build/pack/release/deploy. Эти наблюдения доказывают только schema/owned offline CLI behavior шаблонов. Общие full checks, enabled security, independent review, CI и artifact smoke06 принадлежат координатору.
