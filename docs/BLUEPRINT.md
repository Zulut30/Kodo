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
2. **Параллельные задачи не пересекаются; общие файлы — через интегратора.** Две задачи без пути по `dependsOn` могут исполняться одновременно, поэтому их `writePaths` не должны пересекаться (`scopesOverlap` из `runtime/contracts.mjs`: равные пути, вложенность и glob). Отчёт — по парам, до 100 пар. Если пересечение двух задач одной волны затрагивает общие файлы интеграции (корневые манифесты `Cargo.toml`, `Cargo.lock`, `package.json`, `package-lock.json`, `pnpm-workspace.yaml`, `tsconfig.json`, `kodo.config.json` или точки входа `src/main.*`, `src/lib.rs`, `src/index.*`, `src/app.*`, `main.*`, `index.*`, `app.*`, `cli/index.*`), линтер выдаёт `integrator_required`: правку общих файлов нужно вынести в отдельную задачу-интегратор (`owner: "integrator"`) после параллельной волны.
3. **Ограниченный размер задачи (`split_required`).** Задача отклоняется с `split_required`, если:
   - вход задачи, построенный настоящим `buildDirectorTaskInput` на нормализованном spec (с консервативной максимальной revision), превышает `MAX_TASK_INPUT_BYTES` (12000 байт UTF-8);
   - число путей записи `writePaths` превышает `MAX_TASK_WRITE_PATHS` (24) или задача затрагивает больше `MAX_TASK_MODULES` (3) различных модулей (`src/<m>`, `crates/<m>`, `packages/<m>`, `modules/<m>`, `libs/<m>`, `services/<m>`, `apps/<m>`, `runtime/<m>`). Например, 9 файлов внутри одного модуля `src/search/*.js` допускаются. Задачи с ролью `integrator` освобождены от `split_required` по общим файлам интеграции (корневые и workspace-манифесты `Cargo.toml`/`package.json` и точки входа).
4. **Роли и однозначный владелец модуля.** Роль задаётся полем `owner`: `architect`, `developer`, `integrator`, `ui-qa`, `performance`, `security`, `reviewer`. Кроме того, каждая задача должна иметь однозначную область записи (`blueprint_owner_ambiguous`): запрещены корневые/контейнерные шаблоны (`.`, `**`, `**/*`, `src`, `src/**`, `crates/**`, `packages/**`, `modules/**`, `libs/**`) и владение одним и тем же модулем из задач разных эпиков (вне Волны 0 `foundation`; задачи `integrator` по общим файлам интеграции владельца модуля не перехватывают).
   Все эти правила (`integrator_required`, `blueprint_owner_ambiguous`, `split_required`) применяются одинаково в `apply-spec` и `append-milestone` (`lintMilestone`). В `append-milestone` активными владельцами модулей считаются только незакрытые задачи (не `accepted`/`released`/`cancelled`): они блокируют захват того же модуля, а последовательно расширять можно только уже принятые модули (зависимость на незакрытого владельца отклоняется правилом `milestone_dependency_not_accepted`). Две новые задачи из разных эпиков, пишущие в один и тот же модуль, также отклоняются по правилу «один модуль — один эпик»; уже принятые вехи не перелинтовываются.
5. **Интерфейсы.** Каждый Ref в `interfaceRefs` имеет `kind: "interface"` и указывает на существующий `interfaces/*.md` с совпадающим sha256.
6. **root** в `spec.json` — этот каталог проекта (сравнение после realpath; в результате — канонический путь).
7. **Эпики без циклов.** Граф эпиков — ребро X → Y, если задача эпика X зависит от задачи другого эпика Y. Задачи могут быть ацикличны, а эпики — нет (A1 → B1 → A2 → B2); такой волновой проект Store отклоняет (`project_epic_cycle`), поэтому lint сообщает об этом раньше: одна находка на каждую сильно связную группу эпиков, эпики — в сообщении, в `taskIds` — задачи, чьи зависимости ведут в другой эпик той же группы.

8. **Нет пустых контейнеров.** В каждом майлстоуне есть эпик, в каждом эпике — задача. Пустой эпик никогда не получит гейт и остался бы `proposed`; такой волновой проект Store отклоняет (`project_container_empty`), lint сообщает раньше: одна находка со списком пустых контейнеров в сообщении.
9. **Контрактный крейт и toolchain Волны 0 для Rust.** Для любого Rust-проекта (в том числе при `language: "rust"` в политике) Волна 0 (`foundation`) должна содержать задачу, чьи `writePaths` покрывают `rust-toolchain.toml` с точной версией (`channel = "1.x.y"`, компоненты `clippy` и `rustfmt`), если ближайший закоммиченный `rust-toolchain.toml` в каталоге проекта или его предках до корня Git ещё не задаёт такую версию и оба компонента (`rust_toolchain_required`). Крейты группируются по общему корню Cargo workspace (корневой `Cargo.toml` в `writePaths`, явная строка `workspaceRoot: <path>` вне блоков кода Markdown, либо существующая политика v2; свободный текст вроде «No Cargo workspace» и независимые утилиты со своими `Cargo.toml` без общего корня не считаются одним workspace). В едином workspace с ≥ 3 крейтами (включая корневой `[package]` с `src/**/*.rs`, `src/lib.rs`/`src/main.rs` или `rootPackage: <path>`, отличая его от виртуального корня и не-Rust `src/**`) Волна 0 (`foundation`) должна содержать задачу, чьи `writePaths` покрывают `Cargo.toml` и `src/**` компилируемого контрактного крейта своего workspace (по имени `*-contracts` или по явной строке `contractCrate: crates/<name>` вне блоков кода Markdown; при наличии политики v2 сверяется с её `contractCrates` с учётом фактического `[package].name` существующих манифестов), а также `architecture.policy.json` (`schemaVersion: 2, language: "rust"`): остальные задачи Волны 0 должны зависеть от задачи создания политики или совпадать с ней (`architecture_policy_required` / `architecture_policy_order`, а к первому гейту с политикой уже должны существовать `Cargo.toml` и контрактный крейт). В Волне 0 задача создаёт корневой `Cargo.toml` с `members = ["crates/*"]` и `[workspace.dependencies]`, заготовки всех крейтов карты модулей (`Cargo.toml` и `src/lib.rs` с заглушкой), коммитит `Cargo.lock`, `rust-toolchain.toml` и `.gitignore` с `target/`, заранее вносит в `layers` политики все крейты карты модулей (включая будущие крейты Волны 1+, иначе они получат `ownership.unowned`) и заранее перечисляет нужные внешние крейты в `allowedExternalCrates`/`allowedDevExternalCrates`. Задачи Волн 1+ наполняют `src/` своих крейтов; новая внешняя зависимость добавляется отдельной задачей-интегратором, у которой в `writePaths` есть корневой `Cargo.toml`, `Cargo.toml` крейта-потребителя (для добавления `dep.workspace = true`), `Cargo.lock` и `architecture.policy.json`. Координатор включает `"architecture": {"enabled": true}` в `kodo.config.json` в исходном коммите до `apply-spec` (иначе архитектурный гейт остаётся `disabled`, а после исправления Волны 0 с нуля отсутствие `Cargo.toml` на базе не блокирует проверку). Обычным задачам запрещено накрывать контрактный крейт широкой маской (`crates/**`, `crates/game-contracts*/**`, `{crates/game-contracts,crates/world}/src/**`, `crates/*/src/types.rs` → `contract_scope_too_broad`); без компилируемого контрактного крейта в Волне 0 возвращается `contract_crate_required`.

   В пороге трёх крейтов каждый запланированный пакет учитывается один раз. Обе записи `native/{codec,control}/Cargo.toml` и `native/@(codec|control)/Cargo.toml` выбирают два манифеста. Если третьему пакету задача меняет только файл схемы `crates/events/schemas/event.proto`, число запланированных Rust-крейтов остаётся равным двум.

   Если в `crates/exporter` уже лежит README, задача может добавить этот пакет в workspace, изменив корневой манифест и создав библиотеку и манифест пакета. Области `crates/exporter/Cargo.{toml,lock}` и `crates/exporter/Cargo.@(toml|lock)` обе выбирают будущий `Cargo.toml`. Сам файл манифеста относится к каталогу, в котором его создают. Например, пакеты из `members = ["src/rust/crates/*"]`, явно привязанные к внешнему workspace через `package.workspace`, остаются его членами при создании `src/rust/crates/Cargo.toml` для отдельного вложенного workspace.

   Каталог пакета может называться `exporter.rs`. При `members = ["vendor/*.rs"]` область `vendor/exporter.rs` учитывает будущий пакет уже до создания каталога. При общем `members = ["vendor/*"]` тип такого пути уточняет запись потомка, например `vendor/exporter.rs/src/lib.rs`. Маска `vendor/exporter.{rs,v2}/docs/*.md` тоже выбирает потомка `vendor/exporter.rs`. У существующего пути учитывается его тип в проверяемом дереве.

   Маска `Cargo.*` выбирает манифест workspace. У существующего обычного модуля запись `{crates/format/**,docs/format.md}` имеет тот же эффект для подсчёта пакетов, что и две раздельные области. Чтобы запланировать манифест внутри этого модуля, добавьте `crates/format/Cargo.toml` или маску его имени, например `crates/format/Cargo.*`. Для выбора имени действует тот же glob, что и в `writePaths`. На Windows `@(cargo.toml|README*.md)` выбирает `Cargo.toml`.

   Когда план добавляет вложенный пакет `crates/host/plugins/exporter`, ветвь `toml` в маске `Cargo.?({toml,lock*})` выбирает его будущий манифест для подсчёта пакетов Волны 0. Фигурные скобки раскрываются до разбора `?()` и `@()`. Например, `Cargo.?({toml,lock|bak})` выбирает те же имена, что и две маски `Cargo.?(toml)` и `Cargo.?(lock|bak)`. Если несколько альтернатив дают одинаковый путь к манифесту, этот путь учитывается в лимите раскрытия один раз.

   Модуль `crates/engine/src/crates/resolve/mod.rs` учитывается за `engine`. Это относится и к исходнику, который пакет подключает через `#[path]` за пределами `src`, в том числе при одновременной правке корневого `Cargo.toml`. Чтобы запланировать отдельный вложенный пакет, укажите его собственный манифест, например `crates/host/plugins/exporter/Cargo.toml`. Задача с этим манифестом и исходником плагина учитывается за `exporter`. Отдельная правка исходников `host` добавляет в счёт родительский пакет.

   Для каждого объявленного `workspaceRoot` проверка читает `members`, `exclude` и локальные зависимости из манифестов этого workspace. Например, при `workspaceRoot: examples/snapshot` строка `contractCrate: message-schema` выбирает пакет с этим именем среди его членов. Исключённая архивная копия относится к отдельному workspace. Для будущего крейта учитываются совпадение с `members` и возможность добавить его при запланированной правке манифеста. Явно перечисленный член имеет приоритет перед `exclude`.

   В виртуальном workspace с `members = ["src/rust/crates/*"]` область записи `src/rust/crates/exporter` учитывает будущий пакет ещё до появления его манифеста. То же правило действует для каталога с точкой, например `src/rust/crates/exporter.v2`. Если по указанному пути уже лежит обычный файл, его правка сама по себе не добавляет крейт. Черновик определяет тип пути по рабочей копии, а регистрация — по выбранному коммиту. Если и корневой, и вложенный workspace перечисляют будущий пакет в `members`, каждый учитывает его при проверке порога трёх крейтов.

   Вложенная декларация `workspaceRoot: native/examples` сохраняет защиту корневого контракта `native/examples/protocol`, если корневой пакет подключает его через `path`. Проверка считает членов для каждого объявленного workspace отдельно. Пакет в соседнем каталоге проекта, например `common/message` с `package.workspace = "../../engines/ingest"`, учитывается в `engines/ingest`, когда входит в `members` или достижим по локальным зависимостям этого workspace.

   При регистрации лимит 64 КиБ действует на манифесты, которые проверка читает для определения членства или имени пакета. Например, для правки одного исходника в исключённом `archive/codegen` декларация независимого `workspaceRoot: tools/format` сама по себе не требует чтения имени архивного пакета. Если `tools/format` подключает его по локальной зависимости и имя нужно для проверки контрактной схемы, регистрация читает манифест и применяет лимит.

   Политика проверяет имя пакета в своём Cargo workspace. Если корневой workspace исключает примеры, одноимённый пакет в их отдельном workspace можно менять обычной задачей. Если чертёж отдельно объявляет для него `workspaceRoot` и `contractCrate`, правило явного пути действует и для этого контракта. Для существующего пакета имя в `policy.contractCrates` сверяется с `[package].name` в его манифесте. Например, если пакет `native/codec` называется `wire-contracts` и защищён политикой, задача может явно указать `native/codec/src/schema.rs`. Маска `native/*/src/schema.rs` даёт `contract_scope_too_broad`, даже когда это единственный путь задачи. Правило распространяется и на файлы схем внутри пакета. Для изменения `native/codec/schemas/api.proto` укажите каталог `native/codec` буквально. Маски `native/{codec,control}/schemas/api.proto` и `native/@(codec|control)/schemas/api.proto` охватывают защищённый пакет и дают тот же код.

   Если скобки окружают весь путь к защищённому пакету, как в `{native/codec}/schemas/api.proto`, линтер также выдаёт `contract_scope_too_broad`. В записи `native/{codec}/schemas/api.proto` одиночное слово в скобках обозначает каталог с буквальным именем `{codec}`.

   Компилятор читает toolchain и манифесты Cargo из одного коммита Git. Для нового файла `.rs` он проверяет ближайший к будущему пути `Cargo.toml`. Если маска охватывает несколько каталогов, достаточно одного подходящего пути `.rs` в Cargo-пакете, чтобы потребовался пин. Область `src/parser/**` внутри собственного `src` крейта охватывает и будущие исходники. Область `frontend/src/components/**` с одними файлами TypeScript во вложенном JS-проекте проходит проверку. То же верно для отдельной JS-фикстуры с расширением `.rs` под виртуальным `[workspace]` вне его пакетов.

   Тип существующего пути определяется по тому же коммиту. Например, область `src/parser.v2` охватывает будущие исходники в одноимённом каталоге крейта. Область `src/Makefile` даёт доступ к обычному файлу и сама по себе проходит проверку пина. Для будущего каталога с точкой в имени укажите `src/parser.v2/**`. Если в Git есть крейты `native/[client]` и `native/c`, область `native/[client]/src/model/[id].rs` охватывает буквальное имя `[id].rs` в первом крейте и `i.rs` или `d.rs` во втором. Эти файлы могут ещё отсутствовать в Git.

   В разделе «Стек» фраза «Сервер написан на Rust (пока не используется напрямую браузером)» требует пин для сервера. Фразы «Rust не используется ни в одном из существующих модулей проекта» и «Rust (не используется нигде в существующих модулях проекта)» описывают весь проект и сами по себе проходят проверку пина.

## Коды findings

Finding — `{ code, taskIds?, message }`; сообщения не содержат содержимого файлов. Порядок детерминирован: чтение, root/ссылки, execution, схема, разделы, роли, Волна 0, пустые контейнеры, циклы эпиков, пары, размер, интерфейсы; у `apply-spec` затем — Git.

| Код | Когда |
| --- | --- |
| `blueprint_missing` | нет root, `.kodo/blueprint`, `PROJECT.md` или `spec.json` |
| `blueprint_unsafe_path` | ссылка, junction, жёсткая ссылка, не обычный файл, подмена при чтении, выход за каталог |
| `blueprint_too_large` | превышен лимит размера или числа файлов |
| `blueprint_encoding` | файл не UTF-8 |
| `blueprint_invalid_json` | `spec.json` не JSON |
| `blueprint_cargo_evidence_unavailable` | компилятору не удалось подтвердить коммит `HEAD` или прочитать его дерево и нужные метаданные. Проверьте путь worktree, ссылку ветки и наличие объектов Git. Для `apply-spec` политика архитектуры и выбранные манифесты Cargo должны быть обычными файлами с корректным UTF-8 и синтаксисом JSON или TOML. Лимит политики — 16 МиБ, одного выбранного манифеста — 64 КиБ |
| `blueprint_interface_name` | в `interfaces/` файл не вида `<slug>.md` |
| `blueprint_root_mismatch` | `root` в `spec.json` — другой каталог |
| `blueprint_execution_invalid` | `execution` не `{cadence:'wave', integration:'branch'}` |
| `blueprint_spec_invalid` | строгий `normalizeProjectSpec` отклонил spec (код `project_*` в сообщении; сообщение называет запись — `spec.json`, майлстоун, эпик или задачу — и поле: лишнее, отсутствующее, неверное или ссылку на неизвестный id; для задачи — `taskIds`) или вход задачи не прошёл safety |
| `blueprint_section_missing`, `blueprint_section_empty` | раздел `PROJECT.md` отсутствует или пуст |
| `blueprint_owner_unknown` | `owner` не из списка ролей |
| `blueprint_wave0_missing` | нет `foundation` или в нём нет задач |
| `blueprint_wave0_bypassed` | задача вне Волны 0 не зависит от неё транзитивно |
| `blueprint_wave0_order` | задача Волны 0 зависит от задачи вне неё |
| `rust_toolchain_required` | Rust-чертёж требует `rust-toolchain.toml` в `writePaths` задачи Волны 0. Условие также выполняет ближайший закоммиченный `rust-toolchain.toml` от каталога проекта до корня Git с точным `channel` и компонентами `clippy` и `rustfmt` (правило 9) |
| `contract_crate_required` | единый Rust workspace с ≥ 3 крейтами (включая корневой `[package]`, если он не виртуальный) без задачи Волны 0, покрывающей `Cargo.toml` и `src/**` контрактного крейта (правило 9) |
| `architecture_policy_required` | единый Rust workspace с ≥ 3 крейтами без задачи Волны 0, создающей `architecture.policy.json` (если политика v2 ещё не существует в репозитории) |
| `architecture_policy_order` | задача Волны 0 не зависит от задачи Волны 0, создающей `architecture.policy.json` (иначе гейт её эпика при `architecture.enabled` будет `blocked`) |
| `contract_scope_too_broad` | путь записи обычной задачи накрывает контрактный крейт широкой маской без явного указания его каталога (правило 9) |
| `blueprint_container_empty` | майлстоун без эпиков или эпик без задач (правило 8) |
| `blueprint_epic_cycle` | эпики зависят друг от друга по кругу через задачи (правило 7) |
| `blueprint_parallel_overlap` | пара параллельных задач с пересекающимися `writePaths` |
| `integrator_required` | пара задач одной волны с пересечением по общим файлам (`Cargo.toml` корня, `package.json`, точка входа): нужна отдельная задача-интегратор |
| `blueprint_owner_ambiguous` | задача без однозначного владельца модуля/области записи (корневой/контейнерный шаблон или запись в один модуль из разных эпиков) |
| `split_required` | вход задачи больше 12000 байт UTF-8, либо `writePaths` > 24, либо затронуто > 3 модулей (для роли `integrator` общие файлы интеграции не учитываются) |
| `blueprint_interface_missing` | Ref не указывает на существующий `interfaces/*.md` |
| `blueprint_interface_stale` | sha256 в Ref не совпадает с файлом |
| `blueprint_git_required` | Для `apply-spec` нужен корень рабочего дерева с коммитом и чистыми путями вне `.kodo/blueprint/`. Этот же код возвращается, если при регистрации коммит сменился или Git не смог подтвердить и удержать его. |
| `blueprint_config_missing` | (apply-spec) в коммите HEAD нет `kodo.config.json`: создать по шаблону пакета bootstrap (или проверить существующий) и закоммитить |
| `blueprint_session_scope` | (generate) сессия изменила файлы вне `.kodo/blueprint` |
| `blueprint_session_output`, `blueprint_session_blocked` | (generate) сессия не вернула статус или сообщила, что чертёж составить нельзя |
| `milestone_session_output`, `milestone_session_blocked` | (extend) сессия не вернула майлстоун или сообщила, что описать фичу нельзя |

Проверка нового майлстоуна (`lintMilestone`): `milestone_shape`, `milestone_task_count` (1–80 задач (до 400 в проекте)), `milestone_id_conflict`, `milestone_foreign_parent` (эпик не в новом майлстоуне или задача не в новом эпике), `milestone_dependency_unknown`, `milestone_dependency_not_accepted` (зависимость не на новую и не на accepted/released задачу), `milestone_interface_unbound` (в `interfaceRefs` короткая форма, изменённый или неизвестный Ref: разрешены только `[]` и полный Ref, точно совпадающий с уже привязанным Ref задачи проекта; новые ссылки привязывает только `apply-spec`; `append-milestone` ещё проверяет evidence такого Ref, как `next-wave`), `milestone_snapshot_invalid`, `milestone_snapshot_incomplete`, `milestone_spec_invalid`, а также `blueprint_owner_unknown`, `blueprint_owner_ambiguous` (активные незакрытые владельцы модулей блокируют захват модуля — расширять в `append-milestone` можно только уже принятые модули, так как зависимость на незакрытую задачу отклоняется с `milestone_dependency_not_accepted`; две новые задачи из разных эпиков на один модуль также отклоняются по правилу «один модуль — один эпик»), `blueprint_container_empty` (новый эпик без своей задачи), `blueprint_epic_cycle` (граф существующих и новых задач; сообщаются только циклы с новым эпиком), `blueprint_parallel_overlap` и `integrator_required` (между новыми задачами и с незакрытыми существующими: всё, кроме accepted/released/cancelled) и `split_required` (с реальным контекстом проекта из снапшота и лимитами 24 пути / 3 модуля; старые принятые вехи не перелинтовываются). Ошибки `readMilestoneFile`: `milestone_missing`, `milestone_unsafe_path`, `milestone_too_large` (1 МиБ), `milestone_encoding`, `milestone_invalid_json`.

## API

`runtime/project-blueprint.mjs` (чистая логика и чтение файлов, без записи):

- `readBlueprint(root, { specFile? })` → `{ root, dir, project: { path, sha256, bytes, text }, spec: { path, sha256, bytes, value }, interfaces: [{ module, path, sha256, bytes }] }`; ошибки с кодами `blueprint_*`. `specFile` заменяет `spec.json` другим файлом с теми же лимитами и правилами ссылок; `PROJECT.md` и интерфейсы по-прежнему из `.kodo/blueprint`.
- `lintFactorySpec(spec, { contracts, knownValues = [], interfaces = [], projectMarkdown = '' })` → `{ ok, findings }`. Пропущенные `interfaces`/`projectMarkdown` считаются пустыми, а не пройденными.
- `compileBlueprint(root, { contracts, knownValues = [], specFile?, forRegistration? })` → `{ ok, headSha, spec, interfaces, findings }`. При `ok` можно принять нормализованный ProjectSpec с `execution`. При отклонении схемы `spec` равен `null`. В `headSha` возвращается SHA коммита, выбранного для проверки Cargo и toolchain, либо `null` при компиляции без чтения коммита. По умолчанию компилятор читает необязательную политику и имена Cargo-пакетов из рабочего каталога, поэтому может проверить черновик до первого коммита. Режим `forRegistration` используется в `apply-spec`.
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

`kodo project --help`, `kodo project help <действие>` и `kodo project <действие> --help` печатают справку с exit 0 без ключей и состояния. Пути, которые подсказки `next` берут в кавычки (`--root`, `--project`, `--file` пакета в Kodo home), проверяются до записи пакета, evidence или проекта, как в брифах ([T3-HOST.md](T3-HOST.md#бриф)): иначе exit 1, `reason: project_path_unsafe` и подсказка переименовать или переместить каталог. Порт `cli`, отличный от `kodo` или `node "<путь>"` (в том числе `null`), — `project_cli_invalid`. `runtime/project-cli.mjs` передаёт эти действия в `runtime/project-cli-blueprint.mjs`. Разбор строгий и идёт до учётных данных, состояния, файлов и провайдеров: неизвестный или повторный флаг, лишний позиционный аргумент, не-UUID, клиент кроме `codex`/`claude-code`, идея длиннее 64 КиБ или аргумент, начинающийся с `-`, дают exit 1 и `project_arguments`. С `--prepare` флаги `--client`, `--model` и `--command-id` не принимаются. Без `--client` используется `codex`.

Ответ — тот же конверт, что у `kodo project`: `{ schemaVersion: 1, projectId, revision, result }`. Коды выхода:

- **0** — `result.status`: `prepared`, `compiled`, `created`, `replayed` или `appended`.
- **1** — неверные аргументы (`project_arguments`), данные (`project_invalid`) или findings: `result.code = "blueprint_findings"`, `result.findings = [{ code, taskIds?, message }]`. Сообщения — шаблоны Kodo без содержимого файлов и абсолютных путей; весь ответ проверяется на известные секреты.
- **2** — состояние или провайдер (`project_blocked`). Если причина — известный код Kodo, он в `result.reason`, иначе диагностики нет.

Действия:

- `bootstrap --prepare` — `prepareBootstrap`: пакет в `<KODO_HOME>/bootstrap/<id>/`, репозиторий не меняется. В ответе `bundle.dir`, файлы, `blueprint` (куда писать чертёж) и `next` — шаги для главного чата: прочитать пакет, написать `.kodo/blueprint/`, создать и закоммитить `kodo.config.json` по `templates/kodo.config.json`, вызвать `apply-spec`. Шаблон конфигурации — `client` (подписочный клиент гейтов: `--client` команды `bootstrap` — с `--prepare` и без, — иначе `codex`) и `commands.test`: пустой каталог — `npm test` (новый Node-проект); один стек с манифестом в корне — его команда (Node — `npm test` только при `scripts.test` в package.json; Python — `python -m pytest`, Rust — `cargo test`, Go — `go test ./...`, .NET — `dotnet test` (в том числе `.slnx`), Maven, Gradle, Deno); манифест только во вложенном каталоге, несколько стеков, package.json без `scripts.test` или нераспознанный стек, а также неполный обход каталога (лимиты сканирования) — `commands.test: []`, и `next` требует задать команду. Конфиг создаёт главный чат после чертежа: шаблон не входит в промпт нативной сессии чертежа. Политика проверки волн берётся из закоммиченного файла базы, поэтому `apply-spec` без `kodo.config.json` в коммите HEAD отвечает `blueprint_config_missing`; существующий файл Kodo не меняет. Шаблон `spec.json` даёт первой задаче Волны 0 путь минимального теста и критерий «commands.test выполняет хотя бы один проходящий тест» и не содержит хвостовой задачи `reviewer` — ревью делает gate Run эпика. Команды подсказок всех действий вызывают тот же CLI: из `kodo` и `node cli/index.mjs` — `node "<абсолютный путь к cli/index.mjs>" project …`, при библиотечном вызове — `kodo project …` ([T3-HOST.md](T3-HOST.md#бриф)). `next` — строки для чтения (пояснение и команда вместе), а машинное поле `commands: [{command, why}]` (`bootstrap`, `apply-spec`, `extend --prepare`) содержит только сами команды: оболочке передаётся `command` как есть, `why` объясняет, когда она нужна.
- `bootstrap` без `--prepare` — `generateBlueprint`: одна нативная сессия подписочного клиента через провайдер Engine, затем compile. Проект не регистрируется: следующий шаг — `apply-spec`.
- `apply-spec` — compile (по умолчанию `.kodo/blueprint/spec.json`, иначе `--file`) и проверка Git: `root` — корень рабочего дерева Git (realpath `git rev-parse --show-toplevel` совпадает с ним, подкаталог репозитория не подходит), `HEAD` указывает на коммит, а `git status --porcelain --untracked-files=all` (игнорируемые файлы не считаются) не показывает ничего вне `.kodo/blueprint/`. Иначе — `blueprint_git_required`: интеграционная ветка и worktree задач начинаются от коммита `HEAD`, и незакоммиченная работа в них не попала бы. Если в коммите `HEAD` нет `kodo.config.json` обычным файлом (режим 100644/100755 по `git ls-tree`; каталог или ссылка с таким именем не считаются) — `blueprint_config_missing` (политика проверки волн берётся из коммита). Сам чертёж может быть не закоммичен; `--file` внутри репозитория должен быть закоммичен, игнорироваться или лежать в `.kodo/blueprint/`. При ошибке компиляции или первичной проверки Git команда завершается с кодом 1 до открытия состояния. Иначе интерфейсы сохраняются как конверты evidence в `<KODO_HOME>/project-interfaces/evidence/` (`bindInterfaceEvidence`, одна пакетная подготовка ACL), ссылки задач заменяются на проверяемые Ref, а проект создаётся op `create`, как в `kodo project create`. В ответе `execution`, интерфейсы (`module`, `sha256` конверта), карта `modules`: майлстоуны → эпики → id задач и `waveZero`, и `next`: установка управляемого oxlint для самопроверки воркеров (`tools install oxlint --project "<root>"`, один раз на машину, нужна сеть; для TypeScript ещё `typescript`) и первая волна `next-wave`; те же три команды (oxlint, typescript только для TypeScript, `next-wave`) — в `commands`. Без oxlint `ci feedback` воркера в JS/TS-проекте отвечает `blocked`, а не `feedback_ready`: устанавливает инструмент координатор, воркер — нет. Повтор с тем же `--command-id` возвращает `replayed`, если чертёж не менялся: конверты адресуются содержимым.

  `apply-spec` выбирает коммит перед чтением чертежа. Из его дерева берутся политика архитектуры, имена выбранных Cargo-пакетов и данные для проверки toolchain. Политика и манифесты могут отсутствовать. Для `kodo.config.json` регистрация проверяет, что в коммите есть обычный файл и Git видит его объект. При отсутствии файла или объекта команда возвращает `blueprint_config_missing` до открытия Store. Настройки из файла читает проверка волны. Сам чертёж в `.kodo/blueprint` и файл, переданный через `--file`, читаются с диска. После подготовки evidence Git сверяет выбранный SHA под блокировкой `HEAD`. Если `HEAD` указывает на ветку, Git удерживает и её до `COMMIT` или `ROLLBACK` в SQLite. При форматах `files` и `reftable` эта блокировка действует и для записи в ту же ветку из другого worktree. Если к этому моменту `HEAD` указывает на другой коммит, команда возвращает `blueprint_git_required` с кодом 1. При таком позднем отказе в `KODO_HOME` могут сохраниться конверты интерфейсов. Повторный вызов проверяет чертёж на текущем коммите.

- `extend` (с `--prepare` и без) сначала проверяет то же правило, что `append-milestone` (`projectReopenable` в `runtime/project-contracts.mjs`: волновой проект `accepted`/`released`, не на паузе, полный снапшот, без незакрытых текущих попыток, лимит повторных открытий не исчерпан): иначе exit 2 с `reason: project_append_blocked` до пакета и сессии.
- `extend --prepare` — `prepareExtend` по снапшоту проекта, без пересканирования кода; интерфейсы задач в `context.md` названы по модулю (`<module>.md` из конверта evidence), а не по имени файла конверта; раздел «Привязанные интерфейсы» перечисляет полные Ref проекта для копирования в `interfaceRefs` нового майлстоуна. В ответе пакет, `template` (`templates/milestone.json`) и `next`: записать майлстоун в `<bundle>/milestone.json`, затем `append-milestone`.
- `extend` без `--prepare` — `generateMilestone` (одна сессия только для чтения), затем всё, что делает `append-milestone`. В ответе также `session`.
- `append-milestone` — `readMilestoneFile` и `lintMilestone` по текущему снапшоту. Ошибки файла и findings → exit 1. Иначе op `appendMilestone` с CAS по текущей ревизии: проект должен быть волновым и принятым (`accepted`/`released`), иначе exit 2 с `reason: project_append_blocked`. Прежние майлстоуны, эпики и задачи не меняются, закрытое состояние проекта сохраняется в `project.reopened`. Повторное добавление того же файла отклоняется проверкой (`milestone_id_conflict`): дважды майлстоун не добавляется.

Контекст-пакеты получают архитектурный граф HEAD (`architecture.policy.json` в коммите и `readArchitectureGraph`) и оценку знаний (`knowledgeSnapshot`), если они доступны. Без Git, политики или контекста знаний пакет честно помечает их как недоступные.

## Сквозной сценарий

1. **Идея → контекст.** `kodo project bootstrap "Сервис заметок с поиском" --root D:\notes --prepare --json`. Главный чат читает `context.md`, `rules.md` и шаблоны из `bundle.dir`.
2. **Чертёж.** Главный чат пишет `D:\notes\.kodo\blueprint\PROJECT.md`, `interfaces\*.md` и `spec.json`. Или без `--prepare` их пишет одна нативная сессия: `kodo project bootstrap "…" --root D:\notes --client claude-code`.
3. **Регистрация.** `D:\notes` — корень Git-репозитория с коммитом, в котором есть `kodo.config.json` (`client`, `commands.test`) по шаблону пакета, всё вне `.kodo/blueprint/` закоммичено или в `.gitignore`. `kodo project apply-spec --root D:\notes --command-id <UUID> --json`. При findings главный чат правит чертёж и повторяет команду. При успехе есть `projectId`, Волна 0 в `modules.waveZero`, а `kodo project plan <projectId>` предлагает задачи Волны 0 без зависимостей. Остальные задачи ждут зависимостей (`dependency_not_accepted:<id>`).
4. **Исполнение волн.** Без T3: `kodo project drain <projectId> --concurrency 2 --json` — Волна 0, затем параллельные задачи, интеграция в `kodo/project/<projectId>` и gate Run эпиков до `accepted`. В T3 главный чат повторяет `kodo project next-wave <projectId> --host t3 --limit 3 --json`, открывает по брифу воркер-чат (`delegate_task`) и сдаёт каждый коммит командой из `brief.completeCommand`: `kodo project complete-task <projectId> <taskId> --head <SHA> --attempt <attemptId> --defer-gate --json`. После `integrated` диспетчер архивирует чат и запускает отдельный проход `kodo project gates <projectId> --json`. Во время проверок и ревью он продолжает принимать сдачи и выдавать брифы ([T3-HOST.md](T3-HOST.md)). Алгоритм главного чата — навык [`kodo-project-director`](../skills/kodo-project-director/SKILL.md).
5. **Новая фича.** `kodo project extend <projectId> "Теги заметок" --prepare --json`. Главный чат пишет `<bundle>/milestone.json` по шаблону. Или без `--prepare`: сессия предлагает майлстоун, и Kodo сразу его добавляет.
6. **Добавление.** `kodo project append-milestone <projectId> --file <bundle>/milestone.json --command-id <UUID> --json`. Проект открывается заново (`running`) с новым майлстоуном, история прежних цела. Дальше снова шаг 4.

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

### 15F. Координация Cargo.lock

Параллельные задачи владеют манифестами своих крейтов. Изменение такого манифеста позволяет обновить список зависимостей в корневом Cargo.lock своего workspace, добавить или удалить пакет. Для смены версии, источника или checksum существующего пакета и для неизвестного формата нужен явный путь к lock в writePaths. Две задачи с таким явным путём выполняются последовательно.

Если конфликтуют только Cargo.lock, интеграция берёт lock первого родителя и запускает cargo metadata offline во временной копии дерева. После locked-проверки и сверки пакетов с обоими родителями merge-коммит получает trailer Kodo-Lock-Regenerated. При нехватке локального кэша или ошибке манифеста интеграция завершается с cargo_lock_unresolved до публикации. При конфликте других файлов действует обычный отказ. Для package-lock.json регенерация не предусмотрена.
