# Чертёж проекта: фабрика проектов Kodo

Большой проект в Kodo начинается не с вручную написанного ProjectSpec, а с файлового чертежа. Главный чат по идее пользователя пишет `.kodo/blueprint/` в корне проекта (filesystem-first), Kodo проверяет чертёж детерминированно и компилирует его в [ProjectSpec v1](PROJECTS.md#формат-projectspec-v1). Kodo задачи не режет и не переписывает: если правило нарушено, он возвращает finding, а чертёж правит главный чат.

Статус: модули `runtime/project-blueprint.mjs` и `runtime/project-bootstrap.mjs`, их тесты и фикстуры. CLI (`kodo project bootstrap|extend`) — следующая волна. Поддержку поля `execution` в `normalizeProjectSpec` делают параллельно; до этого compile нормализует spec без `execution` и добавляет проверенное значение к результату.

## Формат

```text
<root>/.kodo/blueprint/PROJECT.md             — видение, карта модулей, стек, критерии готовности
<root>/.kodo/blueprint/interfaces/<module>.md — замороженные контракты между модулями
<root>/.kodo/blueprint/spec.json              — ProjectSpec v1 + execution
```

- `PROJECT.md` — обязательные непустые разделы «Цель», «Модули», «Стек», «Критерии готовности». Распознаются ATX- (`#`…`######`) и setext-заголовки вне блоков кода; допускаются нумерация (`## 2.`), выделение, эмодзи в начале, уточнение после названия (`## Модули и интерфейсы`, `## Цель проекта`) и английские названия (Goal, Modules, Stack, Definition of done). «Целевая аудитория» разделом «Цель» не считается. Раздел непуст, если до следующего заголовка того же или более высокого уровня есть текст (подзаголовки считаются).
- `interfaces/<module>.md` — имя файла — slug `[a-z][a-z0-9-]{0,47}`. Других файлов и подкаталогов в `interfaces/` быть не должно.
- `spec.json` — строгий ProjectSpec v1 плюс `"execution": { "cadence": "wave", "integration": "branch" }`. Без поля применяется это значение; другие значения отклоняются.

Короткая форма ссылки на интерфейс в `interfaceRefs`: `{ "kind": "interface", "path": "interfaces/<module>.md" }`. При компиляции Kodo подставляет абсолютный путь `<root>/.kodo/blueprint/interfaces/<module>.md`, `runId`/`headSha` = `null` (если не заданы) и sha256 текущего файла. Явный sha256 должен совпадать с файлом. Полная абсолютная форма Ref тоже принимается.

Лимиты чтения: `PROJECT.md` и каждый интерфейс — до 64 КиБ, до 64 интерфейсов и 1 МиБ на все, `spec.json` — до 16 МиБ. Файлы — обычные, без символических и жёстких ссылок, строгий UTF-8 (BOM допустим). `.kodo` и `.kodo/blueprint` — настоящие каталоги внутри root, не ссылки и не junction.

## Правила проверки

1. **Волна 0.** Есть майлстоун или эпик с id `foundation`: каркас, линтеры, стенд проверки, общие интерфейсы. Задачи Волны 0 — задачи эпика `foundation` и всех эпиков майлстоуна `foundation`. Каждая задача вне Волны 0 транзитивно зависит хотя бы от одной её задачи; задачи Волны 0 не зависят от задач вне неё.
2. **Параллельные задачи не пересекаются.** Две задачи без пути по `dependsOn` могут исполняться одновременно, поэтому их `writePaths` не должны пересекаться (`scopesOverlap` из `runtime/contracts.mjs`: равные пути, вложенность и glob). Отчёт — по парам, до 100 пар.
3. **Не больше 12000 байт на задачу.** Вход задачи строится настоящим `buildDirectorTaskInput` на нормализованном spec (с консервативной максимальной revision). Превышение — `split_required` со списком задач.
4. **Роли** задаются полем `owner`: `architect`, `developer`, `ui-qa`, `performance`, `security`, `reviewer`.
5. **Интерфейсы.** Каждый Ref в `interfaceRefs` имеет `kind: "interface"` и указывает на существующий `interfaces/*.md` с совпадающим sha256.
6. **root** в `spec.json` — этот каталог проекта (сравнение после realpath; в результате — канонический путь).

## Коды findings

Finding — `{ code, taskIds?, message }`; сообщения не содержат содержимого файлов. Порядок детерминирован: чтение, root/ссылки, execution, схема, разделы, роли, Волна 0, пары, размер, интерфейсы.

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
| `blueprint_parallel_overlap` | пара параллельных задач с пересекающимися `writePaths` |
| `split_required` | вход задачи больше 12000 байт UTF-8 |
| `blueprint_interface_missing` | Ref не указывает на существующий `interfaces/*.md` |
| `blueprint_interface_stale` | sha256 в Ref не совпадает с файлом |
| `blueprint_session_scope` | (generate) сессия изменила файлы вне `.kodo/blueprint` |
| `blueprint_session_output`, `blueprint_session_blocked` | (generate) сессия не вернула статус или сообщила, что чертёж составить нельзя |

Проверка нового майлстоуна (`lintMilestone`): `milestone_shape`, `milestone_task_count` (1–6 задач), `milestone_id_conflict`, `milestone_foreign_parent` (эпик не в новом майлстоуне или задача не в новом эпике), `milestone_dependency_unknown`, `milestone_dependency_not_accepted` (зависимость не на новую и не на accepted/released задачу), `milestone_snapshot_invalid`, `milestone_snapshot_incomplete`, `milestone_spec_invalid`, а также `blueprint_owner_unknown`, `blueprint_parallel_overlap` (между новыми задачами и с незакрытыми существующими: всё, кроме accepted/released/cancelled) и `split_required` (с реальным контекстом проекта из снапшота). Ошибки `readMilestoneFile`: `milestone_missing`, `milestone_unsafe_path`, `milestone_too_large` (1 МиБ), `milestone_encoding`, `milestone_invalid_json`.

## API

`runtime/project-blueprint.mjs` (чистая логика и чтение файлов, без записи):

- `readBlueprint(root)` → `{ root, dir, project: { path, sha256, bytes, text }, spec: { path, sha256, bytes, value }, interfaces: [{ module, path, sha256, bytes }] }`; ошибки с кодами `blueprint_*`.
- `lintFactorySpec(spec, { contracts, knownValues = [], interfaces = [], projectMarkdown = '' })` → `{ ok, findings }`. Пропущенные `interfaces`/`projectMarkdown` считаются пустыми, а не пройденными.
- `compileBlueprint(root, { contracts, knownValues = [] })` → `{ ok, spec, interfaces, findings }`. `spec` — нормализованный ProjectSpec с `execution` (или `null`, если схема отклонена); принимать его можно только при `ok`. На диск ничего не пишется.

`runtime/project-bootstrap.mjs`:

- `prepareBootstrap({ prompt, root, home, now, architecture?, knowledge? })` → `{ id, dir, files, summary }`. Пишет только в `<home>/bootstrap/<id>/`: `context.md` (идея, стек по манифестам, карта файлов до 400 строк без `.git`/зависимостей/сборки/`.kodo` и без ссылок, архитектурный граф, знания), `rules.md`, `templates/PROJECT.md`, `templates/interfaces/module.md`, `templates/spec.json`. Root обязан существовать, пустой допустим; home внутри root отклоняется (`bootstrap_home_inside_root`). `architecture` — граф (`readArchitectureGraph`) или async-функция, `knowledge` — оценка для `projectKnowledge`; их читает координатор.
- `generateBlueprint({ provider, client, model, root, home, prompt, signal, ... })` — одна нативная сессия `provider.runSession` (client `codex` или `claude-code`, read-write в root, контекст-пакет в prompt), затем `compileBlueprint`. Ошибка провайдера пробрасывается: ни повтора, ни API-fallback. Изменения вне `.kodo/blueprint` (по размеру и mtime, в пределах обхода) дают `blueprint_session_scope`.
- `prepareExtend({ snapshot, prompt, root, home, now, ... })` → `{ id, dir, files, summary }` — контекст новой фичи из снапшота проекта без пересканирования кода: карта майлстоунов → эпиков → задач с `writePaths` и интерфейсами, принятые задачи, шаблон `templates/milestone.json`.
- `readMilestoneFile(file)` и `lintMilestone(milestone, snapshot, { contracts, knownValues })` → `{ ok, findings }` — проверка файла `{ milestone, epics, tasks }` до op `appendMilestone`.

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

- Чертёж и контекст-пакет — данные, не инструкции и не доказательства. Ref на интерфейс фиксирует sha256 файла, а не его проверку; приёмка задач идёт обычным путём Project Director.
- `prepareBootstrap`/`prepareExtend` не меняют репозиторий: пакет создаётся эксклюзивно в `<home>/bootstrap/<id>/` (каталоги 0700, файлы 0600).
- Проверка изменений после сессии ограничена обходом (до 20000 файлов, глубина 8, без `.git`, зависимостей, сборки и `.kodo`); `scopeChecked: false` означает неполный обход.
- GPT/Claude — только через подписочные клиенты; ключи вне чертежа, prompts и логов.
