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
| `project-director`: `createProjectTransitionAuthorizer({store,engine,contracts,evaluator})` | Свежая проверка фактического Run/head/config/gates/evidence перед разрешением перехода; wave-проект (`isWaveProject`) идёт в `evaluateWaveTransition`, остальные — прежним путём |
| `project-director`: `createProjectDirector({repo,engine,planner,evaluator,clock})` | `plan/run/resume/cancel/pause/reprioritize/approveRisk`, переиспользование Engine; `run`/`resume` wave-проекта — `project_wave_drain_required` |
| `project-progress`: `buildProjectProgress(snapshot)`; `project-cli`: `projectCli(argv,ports)` | Bounded counts-only сводка; strict CLI и `{report,exitCode,output}` |

Snapshot: `{schemaVersion,project,revision,milestones,epics,tasks,currentAttempts,riskApprovals,completeness}`. Каждая count-запись содержит `total/returned/complete` из одной SQL read transaction; incomplete не доказывает полноту. `currentAttempts` включает последнюю settled попытку каждой задачи; старые попытки/approvals сохранены в истории, current approvals соответствуют Task.revision. Events читаются отдельно: history возвращает `events,total,complete,nextAfter` после cursor, limit1–1000.

Command: `{schemaVersion:1,commandId,projectId,expectedRevision,actor,reason,action}`. Create использует null projectId/revision; остальные записи — CAS. Action ops: `create/insert/amend/transition/setPaused/approveRisk/reserveAttempt`; это не дополнительные CLI-команды. Идентичный command ID+payload replay возвращает прежний результат; изменённый payload отклоняется. Reprioritize меняет Task revision и тем самым инвалидирует старое risk approval; active Task не переопределяется. Immutable Project context не имеет amend в MVP.

Хранилище использует additive namespaced tables/version registry в существующем `Store.db`, без захвата `user_version` и переписывания legacy Run. Перед первой миграцией — Node24 SQLite consistent backup с WAL, затем atomic migration; резервная копия остаётся вне Git в `project-backups/migration-*`. Offline restore требует закрытых handles и защиты более новых записей. Reserve фиксирует Attempt/runId/Task revision/contractHash; install атомарно связывает полный legacy Run и binding. Повтор после crash согласует ту же reservation, не создаёт второй Run. Legacy прямые callers сохраняют прежний default I/O.

## Волновой режим: данные

Слой данных для больших проектов: задачи интегрируются в ветку волнами, а общий gate Run проверяет их вместе. Здесь описаны только данные и проверки Store. Исполнение волн принадлежит директору.

**`execution`.** ProjectSpec и запись Project принимают необязательное `execution: {cadence, integration, watchdog?}`. Допустимы только `{task, frontier}` (эквивалент legacy) и `{wave, branch}`, иначе `project_execution_unsupported`; неизвестный ключ — `project_schema`. `watchdog: {stalledRounds: 1..5|null, rejectUnchanged}` хранится как задан. Значение wave по умолчанию `{stalledRounds:2, rejectUnchanged:true}` подставляет директор при запуске. Необязательные поля пишутся после обязательных. Проект без `execution` даёт прежние байты spec, record, snapshot, events и command; это закреплено golden-хэшами в `tests/project-wave-contracts.test.mjs` и `tests/project-wave-store.test.mjs`. `buildDirectorTaskInput` и `directorContractHash` от `execution` не зависят.

**Зависимости.** `dependencySatisfied(project, status)`: для wave (`isWaveProject(project)`) — `integrated|accepted|released`, иначе — `accepted|released`. Правило используют `assertProjectTransition` (переход в ready/running) и planner (блокировка и critical path). Строки причин прежние: `dependency_not_accepted:<id>`.

**`appendMilestone {milestone, epics:[1..], tasks:[1..]}`** — единственный способ добавить работу в закрытый wave-проект. Чистая проверка `assertProjectReopen({snapshot, action})` требует:

- wave-проект в accepted|released, не на паузе, полный snapshot, все текущие попытки settled, иначе `project_append_blocked`;
- только новые id, иначе `project_identity_conflict`;
- новые эпики только под новым milestone, новые задачи только под новыми эпиками, иначе `project_parent_invalid`;
- зависимости только на новые задачи (без циклов) или на существующие accepted|released, иначе `project_dependency_invalid`. Integrated не подходит.

Store в той же `BEGIN IMMEDIATE` переводит Project в running без lifecycle transition. Evidence и mappings Project переносятся в `reopened[]`: до 100 записей `{status, revision, reopenedAt, evidence, mappings}`, только у wave-записи. Так старые и новые refs не дают неоднозначного bound Run. Закрытые дочерние записи не меняются, новые вставляются proposed. Пишется одно событие `appendMilestone`, CAS и replay работают как у прочих команд. `insert` под accepted родителем по-прежнему `project_insertion_blocked`, transition accepted→running по-прежнему запрещён.

**Gate record** хранится в `kodo_project_records` с `kind:'gate'` и uuid id: `{schemaVersion, id, projectId, number, containers, runId, baseSha, headSha, merges, installed, createdAt, updatedAt}`. `containers` — непрерывная цепочка от узкого контейнера к широкому: epic ⊂ milestone ⊂ project. `merges` — 1–1000 записей `{taskId, attemptId, runId, mergeCommit}`.

`reserveGate {containers, baseSha, headSha, merges, retry}` работает только для wave, иначе `project_gate_unsupported`. Цепочка должна существовать и быть открытой. Milestone или project входит в цепочку только если все его дети вне цепочки уже accepted|released на момент резервации; для milestone/project в `containers[0]` — все его дети. Так гейт эпика A не захватывает общий milestone, пока соседний эпик B открыт. `merges` покрывают ровно задачи самого широкого контейнера, каждая в integrated|accepted с текущей попыткой (`attemptId`, `runId`). Каждый `mergeCommit` сверяется с доверенным `run.integration` Run этой попытки: `status:'merged'`, тот же `mergeCommit`, `mergedHead === run.headSha`; заявленный старый или чужой коммит отклоняется. Нарушение — `project_gate_invalid`. Если для `containers[0]` уже есть гейт, новый допускается только с `retry:true` и только когда Run последнего гейта blocked/failed/cancelled, иначе `project_gate_exists`. Store генерирует id и runId, `number` = максимум по проекту + 1, событие `reserveGate` имеет entity `{kind:'gate', id}`.

`installGateRun({binding, runDraft})` проверяет, что `binding` байт-в-байт равен `gateBindingFor(gate)` (`{schemaVersion, kind:'gate', projectId, gateId, number, runId, baseSha, headSha, mergesHash}`, `mergesHash` — sha256 канонического JSON merges). `runDraft.task` должен совпадать с `buildGateInput({project, gate, tasks})`: префикс и JSON `{schemaVersion, projectContext, gate, tasks}` до 64 KiB, иначе `project_gate_too_large`. `runDraft.directorBinding` равен binding. Форма черновика gate Run своя (`validGateRunDraft`): поля legacy-черновика как в `installRun`, но `baseSha`/`headSha` равны гейту, `plan.tasks` — покрытые задачи в порядке merges с их `writePaths` и `dependsOn: []`, `nodes` — ровно эти задачи `{id, attempt:0, status:'integrated', headSha: mergeCommit, sourceRunId, attemptId}`, `completed = {implementation:true}`, без `verificationProfile`/`executor` и с выключенной доставкой; иначе `project_run_draft_invalid`. Свежая установка требует, чтобы гейт был последним для своего контейнера и его merges оставались текущими (с той же сверкой `run.integration`). Install ставит `installed` и повышает revision; повтор возвращает сохранённый Run. Штатный путь — `createGateRunDraft` ([VERIFICATION.md](VERIFICATION.md)).

Snapshot wave-проекта содержит `gates` (все гейты по `number`) и `completeness.gates`, прочитанные в той же транзакции. У legacy-проекта этих ключей нет, а contracts отклоняют их несоответствие режиму. Progress добавляет строку `gates` только при наличии ключа. Миграция SQLite не менялась, её дайджест закреплён тестом.

## Волновой режим: интеграционная ветка и доказательства

**`runtime/project-integration.mjs`.** Ветка `kodo/project/<projectId>` живёт в собственном worktree `<worktreeHome>/project-<projectId>/integration` вне checkout пользователя (`ensureIntegration`); ветку и HEAD пользователя Kodo не трогает. `mergeTask` вызывает `savePending({before})` до слияния, сливает голову задачи `--no-ff` с сообщением `Kodo: integrate <taskId>`, проверяет родителей (`HEAD^1 = before`, `HEAD^2 = голова задачи`) и что diff слияния лежит внутри writePaths задачи; конфликт → `merge --abort` и `project_integration_conflict`, выход за writePaths → откат и `project_integration_scope`. Повтор после сбоя восстанавливает уже сделанное слияние и заново проверяет scope. Повтор после сбоя до merge commit (есть `MERGE_HEAD`, изменённый индекс) получает в `pending` значение, сохранённое `savePending` (`{before}`): если `HEAD = pending.before` и `MERGE_HEAD = taskHead`, это наше слияние — `git merge --abort` и слияние заново; чужое незавершённое слияние или повтор без `pending` по-прежнему `project_integration_worktree_invalid`, `MERGE_HEAD` не трогается. Сериализацию слияний (lease `project-integration:<id>`) держит вызывающий. `waveFrontier` возвращает голову ветки и требует, чтобы все переданные merge-коммиты были её предками (`project_frontier_integration_missing`).

`gateRepairInScope({worktree, from, to, writePaths})` — истина, если `to` (проверенный head gate Run) — потомок `from` (head гейта) и diff `from..to` лежит в `writePaths` покрытых задач. `mergeBackGate({worktree, expectedHead, gateHead})` возвращает проверенный head гейта (`gateHead = run.headSha`) в интеграционную ветку; `expectedHead = gate.headSha`. Если ветка всё ещё на `expectedHead` — fast-forward до `gateHead`; если её продвинули другие слияния — `--no-ff` слияние ремонтных коммитов (`Kodo: integrate gate repairs`). Уже слитый `gateHead` возвращает текущую голову. `gateHead` не потомок `expectedHead` или ветка без `expectedHead` — `project_integration_invalid`; конфликт — откат и `project_integration_conflict`. Вызывающий держит lease `project-integration:<id>`.

**`runtime/project-wave-evidence.mjs`.** `evaluateWaveTransition({command, snapshot, run, gate?, integrationHead?}, ports)` — чистый evaluator волновых переходов с результатом той же формы, что `evaluateProjectTransition`. Run задачи доводит attempt/task максимум до `integrated`: квитанция `task-fast` на голове Run, behaviour gate на том же head, `integration.status = merged` с `mergedHead = run.headSha`, ref `checks`. `accepted` задач и контейнеров даёт только текущий gate Run:

- гейт installed, binding Run байт-в-байт равен `gateBindingFor(gate)` и хранит исходный `gate.headSha`; `run.headSha` — проверенный итоговый head (сам `gate.headSha` или его потомок после ремонта; Git-сверку потомка и writePaths делает доверенный `validateRun`), иначе `wave_gate_missing`;
- гейт G вытеснен для контейнера C, только если есть более новый гейт, тоже содержащий C (`wave_gate_superseded`). Для задачи C — её эпик, для контейнера — он сам: гейт `[B, M]` не вытесняет `[A, M]` для эпика A и его задач;
- `gate.merges` указывают на текущие попытки (`wave_merges_mismatch`);
- gate Run `succeeded`, полные checks без маркера профиля, ревью, behaviour receipt и включённые гейты — все на `run.headSha`; smoke на `run.headSha`, `complete`, `configured` ⇔ `config.commands.smoke` не пуст, ровно одна строка на каждую команду smoke в том же порядке с тем же `command`/`args`, exit 0 и журналом (`evidence` с `headSha = run.headSha`, `outputPath`/`outputHash`); refs — gate Run на `run.headSha`. Иначе `wave_gate_proof_missing`.

Правило голов: приёмка задач и эпика относится к проверенному head гейта. Приёмка **проекта** дополнительно требует `integrationHead === run.headSha`, где `integrationHead` — голова `refs/heads/kodo/project/<id>`, прочитанная доверенным вызывающим на момент приёмки (иначе `wave_project_head_mismatch`). Итоговый продукт всегда проверен целиком: после `--no-ff` слияния ремонта нужен новый гейт на голове ветки. Контейнер переходит в состояние S, когда все его дети уже в S. `released` в волновом режиме не поддерживается. Блокеры: `wave_not_enabled`, `wave_fast_proof_missing`, `wave_integration_missing`, `wave_gate_missing`, `wave_gate_superseded`, `wave_merges_mismatch`, `wave_gate_proof_missing`, `wave_dependency_unaccepted`, `wave_project_head_mismatch`.

**Авторизатор и директор.** `createProjectTransitionAuthorizer` маршрутизирует по `isWaveProject(snapshot.project)`: wave → `evaluateWaveTransition` (инжектированный `evaluator.evaluateWaveTransition`, иначе модуль), остальное — прежний путь без изменений. Для wave Run выбирается так: `task → ready` — без Run; `accepted` — единственный гейт снапшота, чей `runId` назван в `evidence`, и его Run (иначе `project_binding_invalid`), для `project` ещё и `integrationHead` из Git; attempt/task до `integrated` — Run текущей попытки; контейнеры до `integrated` — без Run. Доверенный `validateRun` wave: Run совпадает с сохранённым, binding (задачи — как в legacy; гейта — `gateBindingFor` + `buildGateInput`), root/config, чистый head; у задачи — журналы `fast-check` каждой строки; у гейта — полные checks/ревью/гейты как в legacy, журналы `smoke` и `gateRepairInScope(gate.headSha → run.headSha)` (порт бросает `project_gate_scope`, evaluator даёт `trusted_proof_invalid`). Прежние `run`/`resume` для wave-проекта отказывают кодом `project_wave_drain_required` (до снятия паузы и без старта Run): волновое исполнение — следующий этап.

**Профили проверки.** Задача волны проходит `task-fast` (затронутые тесты, behaviour gate, без гейтов и LLM-ревью), эпик — один gate Run с полной проверкой, smoke и ревью: [VERIFICATION.md](VERIFICATION.md). Исполнение волн (`drain`, внешние чаты T3) — следующий этап.

## Lifecycle и текущие ограничения

`proposed → ready → running → verifying → integrated → accepted → released`, плюс blocked/failed/cancelled; Attempt начинается с reserved. Ни текст «completed», ни `verified:true`, ни переданные `eligibleStates` не заменяют trusted authorizer. Он await-ит доказательства до write transaction; Store повторяет CAS/control/binding checks внутри неё, без await. Safety проверяет декодированные ключи и значения до hash/write/output, включая короткие known values, PEM и изменения от redaction; ошибки не раскрывают совпавший секрет.

Accepted требует exact frozen task, фактические checks и независимый review текущего clean head, criterion mappings и свежие enabled gates. Disabled — neutral. Released дополнительно требует проверенную publication chain; Project release требует released у `releaseRequired` milestones. Accepted history не понижается.

Epic/Milestone/Project требуют полный набор принятых children **и собственные** criterion evidence/mappings. Автоматическая Task success observation не является собственным proof контейнера. В текущем CLI нет ввода/amend evidence и mappings контейнера или произвольных backlog edits; это trusted repository integration. Поэтому даже все принятые Task могут оставить `resume` blocked (`own_proof_missing`, неоднозначный bound Run и другие причины). Шаблоны ниже не обходят эту границу и не обещают end-to-end project acceptance.

`resume` — явная foreground команда: обрабатывает одну Task/Attempt через существующий Engine и возвращается; не постоянный daemon и не drain-loop всего backlog. Единственная project lease не допускает второго foreground controller. Restart/quota возобновляют ту же reservation/Run с прежними sessions и limits; `--retry-failed` явно создаёт следующую попытку для blocked/failed/cancelled Attempt, сохраняя историю. Это не `--retry-failed` цикла legacy Run. Несколько retry candidates требуют разрешения неоднозначности; отменённый Project не возобновляется.

`pause` сохраняет флаг и блокирует следующие starts/advancement, сохраняя уже активный Run/session; `resume` снимает pause. `cancel` сначала сохраняет Project как cancelled, переводит активные Attempts в cancelled и устанавливает `cancelRequested` связанного Run до передачи отмены Engine. Исторические blocked/failed/cancelled Attempts сохраняют статус, Task revision, contractHash и evidence даже после reprioritize Task; accepted/released не затрагиваются. Повторный cancel, включая повтор после открытия SQLite, возвращает cancelled и повторно передаёт отмену связанного Run без переписывания terminal history. Явная отмена/потеря lease/abort сохраняют cancellation semantics. Sophisticated prioritization UI, daemon, generic framework и автоматический container evidence importer отложены.

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
