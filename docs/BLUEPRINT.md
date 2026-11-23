# Чертёж проекта: фабрика проектов Kodo

Большой проект в Kodo начинается не с вручную написанного ProjectSpec, а с файлового чертежа. Главный чат по идее пользователя пишет `.kodo/blueprint/` в корне проекта (filesystem-first), Kodo проверяет чертёж детерминированно и компилирует его в [ProjectSpec v1](PROJECTS.md#формат-projectspec-v1). Kodo задачи не режет и не переписывает: если правило нарушено, он возвращает finding, а чертёж правит главный чат.

Статус: модули `runtime/project-blueprint.mjs`, `runtime/project-bootstrap.mjs` и CLI `runtime/project-cli-blueprint.mjs` (`kodo project bootstrap|apply-spec|extend|append-milestone`), их тесты и фикстуры. Compile нормализует spec вместе с `execution` строгим `normalizeProjectSpec` (F1). С F3 CLI фабрики собран поверх исполнения волн F2 и входит в пины Architecture Guardian; решение — [ADR-0014](decisions/0014-wave-factory.md).

## Формат

```text
<root>/.kodo/blueprint/PROJECT.md             — видение, карта модулей, стек, критерии готовности
<root>/.kodo/blueprint/interfaces/<module>.md — замороженные контракты между модулями
<root>/.kodo/blueprint/spec.json              — ProjectSpec v1 + execution
```

- `PROJECT.md` — обязательные непустые разделы «Цель», «Модули», «Стек», «Критерии готовности». Распознаются ATX- (`#`…`######`) и setext-заголовки вне блоков кода; допускаются нумерация (`## 2.`), выделение, эмодзи в начале, уточнение после названия (`## Модули и интерфейсы`, `## Цель проекта`) и английские названия (Goal, Modules, Stack, Definition of done). «Целевая аудитория» разделом «Цель» не считается. Раздел непуст, если до следующего заголовка того же или более высокого уровня есть текст (подзаголовки считаются).
- `interfaces/<module>.md` — имя файла — slug `[a-z][a-z0-9-]{0,47}`. Других файлов и подкаталогов в `interfaces/` быть не должно.
- `spec.json` — строгий ProjectSpec v1 плюс `"execution": { "cadence": "wave", "integration": "branch" }`. Без поля (или без `cadence`/`integration` в нём) применяется это значение; другие cadence/integration и неизвестные ключи дают `blueprint_execution_invalid`. Необязательный `watchdog` проверяет строгий `normalizeProjectSpec`.

Короткая форма ссылки на интерфейс в `interfaceRefs`: `{ "kind": "interface", "path": "interfaces/<module>.md" }`. При компиляции Kodo подставляет абсолютный путь `<root>/.kodo/blueprint/interfaces/<module>.md`, `runId`/`headSha` = `null` (если не заданы) и sha256 текущего файла. Явный sha256 должен совпадать с файлом. Полная абсолютная форма Ref тоже принимается.

Лимиты чтения: `PROJECT.md` и каждый интерфейс — до 64 КиБ, до 64 интерфейсов и 1 МиБ на все, `spec.json` — до 16 МиБ. Файлы — обычные, без символических и жёстких ссылок, строгий UTF-8 (BOM допустим). `.kodo` и `.kodo/blueprint` — настоящие каталоги внутри root, не ссылки и не junction.

## Правила проверки

1. **Волна 0.** Есть майлстоун или эпик с id `foundation`: каркас, линтеры, стенд проверки, общие интерфейсы. Задачи Волны 0 — задачи эпика `foundation` и всех эпиков майлстоуна `foundation`. Каждая задача вне Волны 0 транзитивно зависит хотя бы от одной её задачи; задачи Волны 0 не зависят от задач вне неё.
2. **Параллельные задачи не пересекаются.** Две задачи без пути по `dependsOn` могут исполняться одновременно, поэтому их `writePaths` не должны пересекаться (`scopesOverlap` из `runtime/contracts.mjs`: равные пути, вложенность и glob). Отчёт — по парам, до 100 пар.
3. **Не больше 12000 байт на задачу.** Вход задачи строится настоящим `buildDirectorTaskInput` на нормализованном spec (с консервативной максимальной revision). Превышение — `split_required` со списком задач.
4. **Роли** задаются полем `owner`: `architect`, `developer`, `ui-qa`, `performance`, `security`, `reviewer`.
5. **Интерфейсы.** Каждый Ref в `interfaceRefs` имеет `kind: "interface"` и указывает на существующий `interfaces/*.md` с совпадающим sha256.
6. **root** в `spec.json` — этот каталог проекта (сравнение после realpath; в результате — канонический путь).
7. **Эпики без циклов.** Граф эпиков — ребро X → Y, если задача эпика X зависит от задачи другого эпика Y. Задачи могут быть ацикличны, а эпики — нет (A1 → B1 → A2 → B2); такой волновой проект Store отклоняет (`project_epic_cycle`), поэтому lint сообщает об этом раньше: одна находка на каждую сильно связную группу эпиков, эпики — в сообщении, в `taskIds` — задачи, чьи зависимости ведут в другой эпик той же группы.

8. **Нет пустых контейнеров.** В каждом майлстоуне есть эпик, в каждом эпике — задача. Пустой эпик никогда не получит гейт и остался бы `proposed`; такой волновой проект Store отклоняет (`project_container_empty`), lint сообщает раньше: одна находка со списком пустых контейнеров в сообщении.

## Коды findings

Finding — `{ code, taskIds?, message }`; сообщения не содержат содержимого файлов. Порядок детерминирован: чтение, root/ссылки, execution, схема, разделы, роли, Волна 0, пустые контейнеры, циклы эпиков, пары, размер, интерфейсы; у `apply-spec` затем — Git.

| Код | Когда |
| --- | --- |
| `blueprint_missing` | нет root, `.kodo/blueprint`, `PROJECT.md` или `spec.json` |
| `blueprint_unsafe_path` | ссылка, junction, жёсткая ссылка, не обычный файл, подмена при чтении, выход за каталог |
| `blueprint_too_large` | превышен лимит размера или числа файлов |
| `blueprint_encoding` | файл не UTF-8 |
| `blueprint_invalid_json` | `spec.json` не JSON |
| `blueprint_interface_name` | в `interfaces/` файл не вида `<slug>.md` |
| `blueprint_root_mismatch` | `root` в `spec.json` — другой каталог |
| `blueprint_execution_invalid` | `execution` не `{cadence:'wave', integration:'branch'}` |
| `blueprint_spec_invalid` | строгий `normalizeProjectSpec` отклонил spec (код `project_*` в сообщении) или вход задачи не прошёл safety |
| `blueprint_section_missing`, `blueprint_section_empty` | раздел `PROJECT.md` отсутствует или пуст |
| `blueprint_owner_unknown` | `owner` не из списка ролей |
| `blueprint_wave0_missing` | нет `foundation` или в нём нет задач |
| `blueprint_wave0_bypassed` | задача вне Волны 0 не зависит от неё транзитивно |
| `blueprint_wave0_order` | задача Волны 0 зависит от задачи вне неё |
| `blueprint_container_empty` | майлстоун без эпиков или эпик без задач (правило 8) |
| `blueprint_epic_cycle` | эпики зависят друг от друга по кругу через задачи (правило 7) |
| `blueprint_parallel_overlap` | пара параллельных задач с пересекающимися `writePaths` |
| `split_required` | вход задачи больше 12000 байт UTF-8 |
| `blueprint_interface_missing` | Ref не указывает на существующий `interfaces/*.md` |
| `blueprint_interface_stale` | sha256 в Ref не совпадает с файлом |
| `blueprint_git_required` | (apply-spec) root — не корень Git-репозитория, нет коммита или есть незакоммиченные изменения вне `.kodo/blueprint/` |
| `blueprint_session_scope` | (generate) сессия изменила файлы вне `.kodo/blueprint` |
| `blueprint_session_output`, `blueprint_session_blocked` | (generate) сессия не вернула статус или сообщила, что чертёж составить нельзя |
| `milestone_session_output`, `milestone_session_blocked` | (extend) сессия не вернула майлстоун или сообщила, что описать фичу нельзя |

Проверка нового майлстоуна (`lintMilestone`): `milestone_shape`, `milestone_task_count` (1–6 задач), `milestone_id_conflict`, `milestone_foreign_parent` (эпик не в новом майлстоуне или задача не в новом эпике), `milestone_dependency_unknown`, `milestone_dependency_not_accepted` (зависимость не на новую и не на accepted/released задачу), `milestone_snapshot_invalid`, `milestone_snapshot_incomplete`, `milestone_spec_invalid`, а также `blueprint_owner_unknown`, `blueprint_container_empty` (новый эпик без своей задачи), `blueprint_epic_cycle` (граф существующих и новых задач; сообщаются только циклы с новым эпиком), `blueprint_parallel_overlap` (между новыми задачами и с незакрытыми существующими: всё, кроме accepted/released/cancelled) и `split_required` (с реальным контекстом проекта из снапшота). Ошибки `readMilestoneFile`: `milestone_missing`, `milestone_unsafe_path`, `milestone_too_large` (1 МиБ), `milestone_encoding`, `milestone_invalid_json`.

## API

`runtime/project-blueprint.mjs` (чистая логика и чтение файлов, без записи):

- `readBlueprint(root, { specFile? })` → `{ root, dir, project: { path, sha256, bytes, text }, spec: { path, sha256, bytes, value }, interfaces: [{ module, path, sha256, bytes }] }`; ошибки с кодами `blueprint_*`. `specFile` заменяет `spec.json` другим файлом с теми же лимитами и правилами ссылок; `PROJECT.md` и интерфейсы по-прежнему из `.kodo/blueprint`.
- `lintFactorySpec(spec, { contracts, knownValues = [], interfaces = [], projectMarkdown = '' })` → `{ ok, findings }`. Пропущенные `interfaces`/`projectMarkdown` считаются пустыми, а не пройденными.
- `compileBlueprint(root, { contracts, knownValues = [], specFile? })` → `{ ok, spec, interfaces, findings }`. `spec` — нормализованный ProjectSpec с `execution` (или `null`, если схема отклонена); принимать его можно только при `ok`. На диск ничего не пишется.
- `bindInterfaceEvidence(compiled, { persist })` → `{ ok, spec, interfaces: [{ module, source, path, sha256 }], findings }` — только для `ok`-результата compile. Перечитывает используемые интерфейсы (изменение после compile → `blueprint_interface_stale`, ничего не сохраняется), сохраняет каждый через порт `persist(value)` как конверт `{ schemaVersion, module, source, sha256, bytes, text }` и заменяет ссылки задач на проверяемые Ref `{ kind: 'interface', runId: null, headSha: null, path, sha256 }` этого конверта. Запись делает вызывающий (CLI — `engine.persistEvidence(..., 'interface', value, { headSha: null })`).

`runtime/project-bootstrap.mjs`:

- `prepareBootstrap({ prompt, root, home, now, architecture?, knowledge?, contracts?, knownValues? })` → `{ id, dir, files, summary }`. Пишет только в `<home>/bootstrap/<id>/`: `context.md` (идея, стек по манифестам, карта файлов до 400 строк без `.git`/зависимостей/сборки/`.kodo`, без каталогов клиентов агентов (`.agents`, `.claude`, `.codex`, `.opencode`: установленные навыки и роли) и без ссылок, архитектурный граф, знания), `rules.md`, `templates/PROJECT.md`, `templates/interfaces/module.md`, `templates/spec.json`. Root обязан существовать, пустой допустим; home внутри root отклоняется (`bootstrap_home_inside_root`). `architecture` — граф (`readArchitectureGraph`) или async-функция, `knowledge` — оценка для `projectKnowledge`; их читает координатор.
- **Секреты в контексте.** Контекст собирается из метаданных репозитория (имена файлов, `package.json`, архитектурный граф, знания) и может содержать учётные данные. До записи любого файла пакета и до передачи промпта провайдеру Kodo заменяет на `[REDACTED]` известные значения `knownValues` (CLI передаёт значения своего хранилища учётных данных), PEM-блоки приватных ключей и значения, которые редактирует `security.redact` (`sk-…`, `AIza…`, `Bearer …`, `?token=…`). Затем текст обязан пройти `assertDirectorSafe`; иначе — отказ `bootstrap_context_unsafe`, и ничего не пишется и не отправляется. Выбрано редактирование, а не отказ: совпадение с шаблоном в имени файла не должно блокировать чертёж, а значение всё равно не покидает Kodo. `summary.redacted: true` — в пакете есть замены. Так же работают `prepareExtend`, `generateBlueprint` и `generateMilestone` (промпт сессии проверяется целиком).
- `generateBlueprint({ provider, client, model, root, home, prompt, signal, ... })` — одна нативная сессия `provider.runSession` (client `codex` или `claude-code`, read-write в root, контекст-пакет в prompt), затем `compileBlueprint`. Ошибка провайдера пробрасывается: ни повтора, ни API-fallback. Изменения вне `.kodo/blueprint` (по размеру и mtime, в пределах обхода) дают `blueprint_session_scope`.
- `prepareExtend({ snapshot, prompt, root, home, now, ... })` → `{ id, dir, files, summary }` — контекст новой фичи из снапшота проекта без пересканирования кода: карта майлстоунов → эпиков → задач с `writePaths` и интерфейсами, принятые задачи, шаблон `templates/milestone.json`.
- `generateMilestone({ provider, client, model, snapshot, prompt, root, home, signal, ... })` → `{ id, dir, file, session, ok, findings }` — `prepareExtend`, затем одна нативная сессия `provider.runSession` только для чтения в root. Сессия возвращает майлстоун JSON-строкой, Kodo эксклюзивно пишет его в `<bundle>/milestone.json` (вне репозитория). Ошибка провайдера пробрасывается, API-fallback нет. Проверку и добавление делает вызывающий.
- `readMilestoneFile(file)` и `lintMilestone(milestone, snapshot, { contracts, knownValues })` → `{ ok, findings }` — проверка файла `{ milestone, epics, tasks }` до op `appendMilestone`.

## CLI

```text
kodo project bootstrap "IDEA" --root PATH [--prepare] [--client codex|claude-code] [--model MODEL] [--json]
kodo project apply-spec --root PATH [--file SPEC_JSON] [--command-id UUID] [--json]
kodo project extend PROJECT_ID "FEATURE" [--prepare] [--client codex|claude-code] [--model MODEL] [--command-id UUID] [--json]
kodo project append-milestone PROJECT_ID --file MILESTONE_JSON [--command-id UUID] [--json]
```

`kodo project --help` и `kodo project <действие> --help` печатают справку с exit 0 без ключей и состояния. `runtime/project-cli.mjs` передаёт эти действия в `runtime/project-cli-blueprint.mjs`. Разбор строгий и идёт до учётных данных, состояния, файлов и провайдеров: неизвестный или повторный флаг, лишний позиционный аргумент, не-UUID, клиент кроме `codex`/`claude-code`, идея длиннее 64 КиБ или аргумент, начинающийся с `-`, дают exit 1 и `project_arguments`. С `--prepare` флаги `--client`, `--model` и `--command-id` не принимаются. Без `--client` используется `codex`.

Ответ — тот же конверт, что у `kodo project`: `{ schemaVersion: 1, projectId, revision, result }`. Коды выхода:

- **0** — `result.status`: `prepared`, `compiled`, `created`, `replayed` или `appended`.
- **1** — неверные аргументы (`project_arguments`), данные (`project_invalid`) или findings: `result.code = "blueprint_findings"`, `result.findings = [{ code, taskIds?, message }]`. Сообщения — шаблоны Kodo без содержимого файлов и абсолютных путей; весь ответ проверяется на известные секреты.
- **2** — состояние или провайдер (`project_blocked`). Если причина — известный код Kodo, он в `result.reason`, иначе диагностики нет.

Действия:

- `bootstrap --prepare` — `prepareBootstrap`: пакет в `<KODO_HOME>/bootstrap/<id>/`, репозиторий не меняется. В ответе `bundle.dir`, файлы, `blueprint` (куда писать чертёж) и `next` — шаги для главного чата: прочитать пакет, написать `.kodo/blueprint/`, вызвать `apply-spec`. Команды в `next` всех действий вызывают тот же CLI: из `kodo` и `node cli/index.mjs` — `node "<абсолютный путь к cli/index.mjs>" project …`, при библиотечном вызове — `kodo project …` ([T3-HOST.md](T3-HOST.md#бриф)).
- `bootstrap` без `--prepare` — `generateBlueprint`: одна нативная сессия подписочного клиента через провайдер Engine, затем compile. Проект не регистрируется: следующий шаг — `apply-spec`.
- `apply-spec` — compile (по умолчанию `.kodo/blueprint/spec.json`, иначе `--file`) и проверка Git: `root` — корень рабочего дерева Git (realpath `git rev-parse --show-toplevel` совпадает с ним, подкаталог репозитория не подходит), `HEAD` указывает на коммит, а `git status --porcelain --untracked-files=all` (игнорируемые файлы не считаются) не показывает ничего вне `.kodo/blueprint/`. Иначе — `blueprint_git_required`: интеграционная ветка и worktree задач начинаются от коммита `HEAD`, и незакоммиченная работа в них не попала бы. Сам чертёж может быть не закоммичен; `--file` внутри репозитория должен быть закоммичен, игнорироваться или лежать в `.kodo/blueprint/`. Findings → exit 1 до открытия состояния. Иначе интерфейсы сохраняются как конверты evidence в `<KODO_HOME>/project-interfaces/evidence/` (`bindInterfaceEvidence`, одна пакетная подготовка ACL), ссылки задач заменяются на проверяемые Ref, а проект создаётся op `create`, как в `kodo project create`. В ответе `execution`, интерфейсы (`module`, `sha256` конверта), карта `modules`: майлстоуны → эпики → id задач и `waveZero`, и `next`: установка управляемого oxlint для самопроверки воркеров (`tools install oxlint --project "<root>"`, один раз на машину, нужна сеть; для TypeScript ещё `typescript`) и первая волна `next-wave`. Без oxlint `ci feedback` воркера в JS/TS-проекте отвечает `blocked`, а не `passed`: устанавливает инструмент координатор, воркер — нет. Повтор с тем же `--command-id` возвращает `replayed`, если чертёж не менялся: конверты адресуются содержимым.
- `extend --prepare` — `prepareExtend` по снапшоту проекта, без пересканирования кода. В ответе пакет, `template` (`templates/milestone.json`) и `next`: записать майлстоун в `<bundle>/milestone.json`, затем `append-milestone`.
- `extend` без `--prepare` — `generateMilestone` (одна сессия только для чтения), затем всё, что делает `append-milestone`. В ответе также `session`.
- `append-milestone` — `readMilestoneFile` и `lintMilestone` по текущему снапшоту. Ошибки файла и findings → exit 1. Иначе op `appendMilestone` с CAS по текущей ревизии: проект должен быть волновым и принятым (`accepted`/`released`), иначе exit 2 с `reason: project_append_blocked`. Прежние майлстоуны, эпики и задачи не меняются, закрытое состояние проекта сохраняется в `project.reopened`. Повторное добавление того же файла отклоняется проверкой (`milestone_id_conflict`): дважды майлстоун не добавляется.

Контекст-пакеты получают архитектурный граф HEAD (`architecture.policy.json` в коммите и `readArchitectureGraph`) и оценку знаний (`knowledgeSnapshot`), если они доступны. Без Git, политики или контекста знаний пакет честно помечает их как недоступные.

## Сквозной сценарий

1. **Идея → контекст.** `kodo project bootstrap "Сервис заметок с поиском" --root D:\notes --prepare --json`. Главный чат читает `context.md`, `rules.md` и шаблоны из `bundle.dir`.
2. **Чертёж.** Главный чат пишет `D:\notes\.kodo\blueprint\PROJECT.md`, `interfaces\*.md` и `spec.json`. Или без `--prepare` их пишет одна нативная сессия: `kodo project bootstrap "…" --root D:\notes --client claude-code`.
3. **Регистрация.** `D:\notes` — корень Git-репозитория с коммитом, всё вне `.kodo/blueprint/` закоммичено или в `.gitignore`. `kodo project apply-spec --root D:\notes --command-id <UUID> --json`. При findings главный чат правит чертёж и повторяет команду. При успехе есть `projectId`, Волна 0 в `modules.waveZero`, а `kodo project plan <projectId>` предлагает задачи Волны 0 без зависимостей. Остальные задачи ждут зависимостей (`dependency_not_accepted:<id>`).
4. **Исполнение волн.** Без T3: `kodo project drain <projectId> --concurrency 2 --json` — Волна 0, затем параллельные задачи, интеграция в `kodo/project/<projectId>` и gate Run эпиков до `accepted`. В T3 главный чат повторяет `kodo project next-wave <projectId> --host t3 --limit 3 --json`, открывает по брифу воркер-чат (`delegate_task`) и сдаёт каждый коммит `kodo project complete-task <projectId> <taskId> --head <SHA> --json`; гейт эпика запускается автоматически ([T3-HOST.md](T3-HOST.md)). Алгоритм главного чата — навык [`kodo-project-director`](../skills/kodo-project-director/SKILL.md).
5. **Новая фича.** `kodo project extend <projectId> "Теги заметок" --prepare --json`. Главный чат пишет `<bundle>/milestone.json` по шаблону. Или без `--prepare`: сессия предлагает майлстоун, и Kodo сразу его добавляет.
6. **Добавление.** `kodo project append-milestone <projectId> --file <bundle>/milestone.json --json`. Проект открывается заново (`running`) с новым майлстоуном, история прежних цела. Дальше снова шаг 4.

Сценарий целиком — чертёж с Волной 0 и двумя параллельными задачами, `apply-spec`, `drain` до `accepted`, `extend --prepare`, `append-milestone` и второй `drain` до `accepted` без изменения прежних майлстоунов — проверяет `tests/project-factory-e2e.test.mjs` (реальные Store, project store, авторизатор и Engine с fake-провайдерами, временный Git, только CLI).

## Пример: заметки (3 модуля + Волна 0)

Полный рабочий чертёж — [tests/fixtures/blueprint/valid](../tests/fixtures/blueprint/valid); некорректные варианты — в `tests/fixtures/blueprint/invalid/`.

```text
.kodo/blueprint/PROJECT.md            ## Цель / ## Модули (storage, api, web) / ## Стек / ## Критерии готовности
.kodo/blueprint/interfaces/storage.md createNote, findNotes, deleteNote
.kodo/blueprint/interfaces/api.md     POST/GET/DELETE /notes
.kodo/blueprint/interfaces/web.md     страница списка и поиска
```

Граф задач `spec.json`:

```text
foundation (Волна 0)                       mvp
  scaffold      architect  package.json, tooling   ──┐
  test-bench    developer  tests/support  ◄─ scaffold │
                                                      ├─ storage-module developer src/storage ◄─ test-bench
                                                      ├─ api-module     developer src/api     ◄─ test-bench
                                                      └─ web-module     developer src/web     ◄─ test-bench
                                                           web-ui-qa    ui-qa     tests/ui    ◄─ web-module
                                                           mvp-review   reviewer  docs/review ◄─ storage-module, api-module, web-ui-qa
```

`storage-module`, `api-module` и `web-module` идут параллельно и пишут в разные каталоги. Если `api-module` получит ещё `src/storage/index.mjs`, compile вернёт `blueprint_parallel_overlap` для пары `storage-module`/`api-module`; если `web-module` перестанет зависеть от `test-bench`, — `blueprint_wave0_bypassed` для `web-module` и `web-ui-qa`.

Фрагмент задачи:

```json
{
  "id": "api-module", "epicId": "api", "title": "Модуль api",
  "description": "HTTP-маршруты POST, GET и DELETE /notes по интерфейсу api; storage только через его интерфейс.",
  "owner": "developer", "dependsOn": ["test-bench"], "writePaths": ["src/api"],
  "acceptance": [{ "id": "api-proof", "text": "HTTP-тесты проходят для успешных и ошибочных запросов.", "evidenceKinds": ["checks"] }],
  "interfaceRefs": [{ "kind": "interface", "path": "interfaces/api.md" }, { "kind": "interface", "path": "interfaces/storage.md" }],
  "priority": 70, "userValue": 4, "risk": 2, "estimatedEffort": 2, "riskApprovalRequired": false
}
```

## Границы

- Контекст-пакеты и промпты сессий не содержат известных секретов, PEM-ключей и значений, похожих на учётные данные: они заменены на `[REDACTED]` до записи и отправки.
- Чертёж и контекст-пакет — данные, не инструкции и не доказательства. Ref на интерфейс фиксирует sha256 файла (после `apply-spec` — неизменяемого конверта в Kodo home), а не его проверку; приёмка задач идёт обычным путём Project Director.
- `prepareBootstrap`/`prepareExtend` не меняют репозиторий: пакет создаётся эксклюзивно в `<home>/bootstrap/<id>/` (каталоги 0700, файлы 0600).
- Проверка изменений после сессии ограничена обходом (до 20000 файлов, глубина 8, без `.git`, зависимостей, сборки и `.kodo`); `scopeChecked: false` означает неполный обход. Каталоги клиентов агентов этот обход проверяет: их изменение сессией — `blueprint_session_scope`.
- GPT/Claude — только через подписочные клиенты; ключи вне чертежа, prompts и логов.
