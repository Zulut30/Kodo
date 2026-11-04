# Языковые проверки качества

`quality` — детерминированный локальный CLI без LLM, API и запуска Engine. Обнаружение и планирование читают проект и проверяют конфигурацию; они не запускают процессы, не устанавливают инструменты, не открывают SQLite и не инициализируют credentials. `run` проверяет версии и выполняет проверки через существующий `delivery.execute`, с `shell: false`, общим deadline и бюджетом вывода на capability, отменой и завершением принадлежащего ему дерева процессов.

```powershell
kodo quality detect --project D:\Projects\app --json
kodo quality plan --project D:\Projects\app --mode quick --changed src/main.ts --json
kodo quality run --project D:\Projects\app --mode quick --changed src/main.ts --affected src/consumer.ts --capability lint --json
```

Из исходников используйте `node cli/index.mjs quality ...`. `--changed`, `--affected`, `--capability` можно повторять с разными значениями. `detect` принимает только `--project` и `--json`; `plan` также принимает mode/scope/capability; только `run` принимает `--evidence-dir`, `--timeout-ms` (1–1800000) и `--max-output-bytes` (1–16777216). Неизвестные, лишние, повторные одиночные флаги и неправильные значения отвергаются. JSON stdout содержит один объект; ошибки аргументов также представлены одним объектом `status: "blocked"`. `failed` и `blocked` дают exit 1, в том числе у заблокированного плана.

## Обнаружение и поддерживаемые проверки

Реестр `QualityProfileRegistry` ищет исходники, реальные manifest/config/lock файлы и зависимости. Имена каталогов не являются доказательством стека. Вложенные проекты получают собственные профили и владельцев файлов. `package.json`, согласованный `package-lock.json`, Cargo TOML, `go.mod`, `.csproj`, `global.json`, Composer JSON/lock, TS JSON/JSONC, CSS/HTML config входят в inventory. React/Next/Astro определяются по package dependencies/config; `.astro` также является индикатором Astro. WordPress определяется по PHP plugin/theme headers, hook API или Composer dependencies. Наличие индикатора не доказывает UI/E2E покрытие; `.astro` SFC требует отдельной проектной проверки, встроенный HTML validator проверяет `.html`/`.htm`.

| Язык | format | lint | typecheck |
| --- | --- | --- | --- |
| C# | `dotnet format whitespace --verify-no-changes --no-restore --include ...` | `dotnet format analyzers --verify-no-changes --no-restore` | `dotnet build --no-restore`, warnings as errors, output в private evidence |
| Rust | `rustfmt --check --edition ...` выбранных файлов | `cargo clippy --offline --locked --message-format=json -- -D warnings` | `cargo check --offline --locked --message-format=json` |
| Go | `gofmt -l` выбранных файлов | `go vet ./...` | `go build -o PRIVATE_DIR ./...` |
| TypeScript | `oxfmt --check` | Oxlint JSON, warnings блокируют | `tsc --noEmit --incremental false --pretty false --project tsconfig.json` |
| JavaScript | `oxfmt --check` | Oxlint JSON | `not_applicable` |
| CSS | `oxfmt --check` | Stylelint JSON с config проекта | `not_applicable` |
| HTML | `oxfmt --check` | HTML-Validate JSON с config проекта | `not_applicable` |
| PHP | PHPCS JSON, PSR12 либо WordPress standard, без PHPCBF | `php -n -l` для каждого файла | PHPStan JSON |
| SQL | SQLFluff `lint` проверяет правила форматирования, без `fix` | SQLFluff `lint` | `not_applicable` |

Capabilities `test`, `security`, `architecture`, `release` отделены от этих проверок. Без явной проектной команды они возвращают `skipped: explicit_configured_check_required`; они не означают успешные тесты, сканирование, архитектурную проверку или выпуск. Эта фаза не добавляет архитектурный движок и не запускает shipping. Существующие security/UI/release gates продолжают работать самостоятельно.

Oxlint включает React/JSX accessibility и Next plugins при обнаруженных индикаторах. Stylelint JSON может поступать в stderr; обе смешанные JSON streams считаются ошибкой. У HTML-Validate чистый ответ — `[]`; до запуска проверяются реальные имена/наличие файлов и config. Проекты с `.htmlvalidateignore` блокируются для этого встроенного адаптера: используйте явную проектную проверку с coverage receipt. Oxfmt должен сообщить точное количество проверенных файлов; Oxlint — `number_of_files`. Для Stylelint/SQLFluff требуются результаты по каждому выбранному файлу. Произвольный текст/пустой или частичный JSON не считается успехом. Непустой список файлов от `gofmt -l` означает `failed`, даже при exit 0.

## Pins и конфигурация

Добавляйте только объект `quality` в существующий `kodo.config.json`; остальные настройки Kodo сохраняются. Точка входа quality валидирует этот объект отдельно, без изменения legacy config loader.

```json
{
  "quality": {
    "enabled": true,
    "mode": "quick",
    "strictness": "strict",
    "dialect": "postgres",
    "tools": { "php": { "version": "8.4.21" } },
    "capabilities": { "release": false },
    "changedPaths": ["src/main.ts"],
    "affectedPaths": ["src/consumer.ts"],
    "timeoutMs": 120000,
    "maxOutputBytes": 1048576,
    "baseline": []
  }
}
```

Шесть managed tools используют единственный существующий installer/`resolveTool`: `oxlint` 1.91.0, `oxfmt` 0.76.0, `typescript` 7.0.2, `stylelint` 18.0.0, `html-validate` 11.18.0, `sqlfluff` 4.5.0. Quality не устанавливает их, не вызывает npm/npx/composer install и не принимает другой managed pin. Явная установка координатором: `kodo tools install oxlint --json`, аналогично остальные ID; [пины и системные prerequisites](UI-TOOLS.md).

Нативные инструменты уже должны быть установлены в проектной среде/PATH. Принимаются точные `X.Y.Z`, без диапазонов. SDK pin берётся из ближайшего родительского `global.json`; Rust cargo/rustc — из точного `rust-toolchain.toml`; Go — из `toolchain goX.Y.Z` либо точного `go X.Y.Z` в `go.mod`; PHP — из точного Composer require или `quality.tools.php.version`. Явный pin, противоречащий точному manifest pin, отвергается. Для `rustfmt` и Clippy задайте собственные точные версии: они отличаются от версии Rust. Cargo lint/typecheck требуют существующий `Cargo.lock` и проверяют Rust compiler, cargo и, для lint, Clippy. Go formatter проверяется командой `go version ABSOLUTE_GOFMT_BINARY`; версия соседнего произвольного `go` сама по себе не доказывает версию gofmt.

PHPCS/PHPStan берут pin из Composer lock либо `quality.tools.phpcs/phpstan.version`, дополнительно проверяются версия PHP и `php ENTRY --version`. Entrypoint по умолчанию — `vendor/squizlabs/php_codesniffer/bin/phpcs` / `vendor/phpstan/phpstan/phpstan`; `path` можно изменить только на безопасный путь внутри `vendor/`. Symlink/hardlink entrypoint запрещён. WPCS должен быть заранее установлен проектом; при отсутствии WordPress standard PHPCS не пройдёт.

SQL dialect обязателен. В этом срезе разрешены `ansi`, `postgres`, `mysql`, `sqlite`, `tsql`, `snowflake`, `bigquery`, `duckdb`, `redshift`; другие дают `unsupported`, даже если SQLFluff поддерживает дополнительные dialect. Format и lint SQL используют один фактический read-only lint при одинаковых argv, inputs, версии и identities в пределах одного `run`. У capabilities отдельные receipts и применение baseline; второй receipt содержит `reusedFrom` и hash наблюдения первого, без выдуманной длительности второго процесса. При разных входах результат не переиспользуется. Преобразования SQL/миграций и обращения к БД отсутствуют.

`strict` блокирует все новые warnings/errors, не принимает baseline, принудительно включает TS `--strict`. `standard` сохраняет strict-настройку TypeScript проекта, но также блокирует нарушения. Только `adopt` принимает явно записанные старые наблюдения. Baseline entry содержит `language`, `capability`, `tool`, `file`, `line`, `ruleId`, `severity`, `fingerprint` и `sourceHash` файла из прежней проверенной квитанции. Совпадать должны все поля, каждая запись погашает не более одного наблюдения. Изменённый source hash, новая/ухудшившаяся диагностика, changed/affected файл или файл, который Git наблюдает как новый/изменённый, блокирует проверку. При неизвестном changed scope baseline не скрывает текущие ошибки. Генерации baseline из всех текущих ошибок нет. Принятый долг отражён в `debtCount`, оригинальная диагностика и диагностический exit code сохранены в evidence; произвольный ненулевой exit/crash не превращается в PASS.

## Scope, безопасность и квитанции

Quick передаёт formatter/linter только changed/affected исходники. Пустой известный scope даёт `skipped`. Если scope не задан, план явно пишет `unknown changed paths; inspect all discovered source files`. Компилятор, Go vet и Cargo analyzer могут расширить проверку до owning project: причина `compiler/analyzer dependency graph is project-wide...` записана отдельно. Это консервативная проектная граница, а не вычисление точного графа всех monorepo зависимостей. Указанные в config paths и относительные compiler imports/references не могут выходить за корень; неизвестные динамические MSBuild пути блокируются. Сложные custom SDK/генераторы требуют отдельного явного проектного check.

Запрещены выход за root, symlinks в source и выбранных entrypoints, option-like имена, glob-входы CLI, отсутствующие paths и secret-файлы. `.git`, build/dependency directories (`node_modules`, `vendor`, `target`, `bin`, `obj`, `.next`, `.astro`, `dist`, `.venv`, coverage) исключены из исходного inventory; секретные `.env`, ключи, auth и `wp-config.php` не читаются. Inventory ограничен 20000 файлами / 256 MiB, один файл — 32 MiB. Source/config hash проверяется до и после каждого выполняемого check, HEAD — после; изменения блокируют результат и не откатываются автоматически.

Исходники не форматируются и не исправляются. Компиляторы могут создавать generated artifacts/cache; Cargo/Go output и caches направлены в private directory, .NET output — туда же, существующий `obj`/assets может потребоваться. Restore/download/install не выполняется; offline dependency/cache miss означает неуспешную проверку. Project code, compiler plugins и configured scripts остаются доверенным исполняемым кодом: это не OS sandbox и не гарантия невозможности внешних побочных эффектов. Подготовкой SDK/dependencies, live-проверками и security gates управляет координатор.

`applicable` означает выбранную, ещё не выполненную проверку; `not_applicable` — отсутствие встроенной capability у языка; `missing` — нет pin/tool; `unsupported` — неизвестная платформа/dialect; `blocked` — повреждённые output/evidence, version/scope/timeout/cancel/mutation; `failed` — нарушения либо диагностический failure; `passed` — завершённая проверка; `disabled`/`skipped` — нейтральные состояния. В общий PASS не превращаются missing/unsupported/disabled/unknown; когда нет ни одной успешной выполняемой проверки, общий `passed` равен `null`.

Каждая capability имеет отдельный receipt: actual duration, tool/version и проверенная actualVersion, binary/installation identity, HEAD, config/source/pin hashes, files/scope reason, findings, debt count и SHA-256/размер evidence. Полные ограниченные stdout/stderr, argv, версии и длительности процессов сохраняются только в новой private папке вне Git — `--evidence-dir` либо `stateHome()/quality`. Процессы получают allowlisted environment без ключей, provider env, NODE_OPTIONS и пользовательских startup hooks. Известные значения credentials и типовые credential patterns редактируются перед сохранением; public findings не содержат snippets/source. `isCurrentQualityReceipt` заново сравнивает source/config/head, pins/installation identity и байты evidence; старые квитанции не являются запуском новых checks и не интегрируются в Engine автоматически.

## Примеры проектов

Next.js: обычные `package.json` с `next`/`react`/`typescript`, согласованный lock и `tsconfig.json`; managed tools устанавливает координатор. Для проверки изменённого компонента и whole-project typecheck:

```powershell
kodo quality run --project D:\Projects\web --changed app/page.tsx --capability lint --capability typecheck --json
```

Strict TS может выявить проблемы в соседних модулях, потому что проверяется реальный `tsconfig.json`. Проверка не запускает Next server/browser; UI gate остаётся отдельным.

.NET desktop: в корне `global.json` с `{"sdk":{"version":"10.0.302"}}`, в `src/Desktop/Desktop.csproj` — реальный WPF/WinForms/Avalonia проект; dependencies/assets заранее подготовлены. Pin замените на точную версию своей установленной SDK.

```powershell
kodo quality run --project D:\Projects\desktop --changed src/Desktop/MainWindow.cs --capability format --capability typecheck --json
```

Это CLI/компиляторная проверка; запуска окна, UI accessibility и smoke она не доказывает. Несколько `.csproj` в одном каталоге требуют явного project check, автоматический выбор неоднозначного manifest запрещён.

Rust library: реальные `Cargo.toml` с edition, `Cargo.lock`, `src/lib.rs`, `rust-toolchain.toml` с `[toolchain] channel="1.85.0"`; установленные `rustfmt`/Clippy и cache/dependencies подготовлены отдельно. Пример quality: `{"tools":{"rustfmt":{"version":"1.8.0"},"clippy":{"version":"0.1.85"}}}`. Pins должны соответствовать своим фактически установленным инструментам.

```powershell
kodo quality run --project D:\Projects\rust-lib --changed src/lib.rs --capability format --capability lint --capability typecheck --json
```

Cargo compiler outputs направлены в private target, network выключен. Отсутствующие offline dependencies не выдаются за успех.

WordPress plugin: PHP plugin header/hook source, `composer.json` и `composer.lock`, заранее установленный vendor с PHPCS/WPCS/PHPStan. В `quality.tools.php.version` задайте фактическую точную PHP CLI (`8.4.21` — пример), остальные pins берутся из lock либо указаны явно.

```powershell
kodo quality run --project D:\Projects\wp-plugin --changed plugin.php --capability lint --capability format --capability typecheck --json
```

`php -n -l` не загружает WordPress и не делает HTTP-запросы; PHPCS проверяет WordPress standard, PHPStan использует существующую настройку проекта. Здесь нет подтверждения работающего сайта или успешного релиза плагина.

## Явная интеграция с существующими commands

Engine не переписан. Чтобы сделать quality обязательным локальным gate, добавьте обычную существующую `commands.test` запись в config; путь к CLI должен быть установленным/проверенным файлом проекта. Пример для проекта с dev dependency `@zulut30/kodo`, добавляется к существующим командам:

```json
{
  "commands": {
    "test": [
      {"command":"node","args":["node_modules/@zulut30/kodo/cli/index.mjs","quality","run","--project",".","--mode","standard","--capability","lint","--capability","typecheck","--json"]},
      {"command":"npm","args":["test"]}
    ]
  }
}
```

Не добавляйте эту команду в `quality.checks`: это рекурсивный вызов себя. Существующие security gates/config и `commands.build/deploy/smoke` остаются координаторскими. Quality release capability означает проверку готовности, она не публикует артефакт.

Для собственного read-only test/security/architecture/release validator задайте `quality.checks`. Команда разрешает только известный runtime (`node`, `dotnet`, `cargo`, `go`, `php`), точную проверяемую версию, `readOnly:true`, явные `files`. Для quick расширение за changed/affected требует `scopeReason`. Команда не получает secrets, не может просить shell/eval/install/publish/fix. Она должна выдать один законченный JSON, а не произвольное успешное сообщение:

```json
{
  "quality": {
    "checks": [{
      "id": "architecture-policy",
      "capability": "architecture",
      "command": "node",
      "args": ["scripts/architecture-check.mjs"],
      "version": "24.19.0",
      "versionOutput": "v24.19.0",
      "readOnly": true,
      "files": ["src/main.js", "src/dependency.js"],
      "scopeReason": "module boundary validation needs both dependent source files"
    }]
  }
}
```

Выход проверяющего скрипта при реально завершённой чистой проверке:

```json
{"schemaVersion":1,"complete":true,"status":"passed","scannedFiles":["src/main.js","src/dependency.js"],"findings":[]}
```

При нарушении: `status:"failed"`, непустые findings с `file`, `line`, `ruleId`, `severity`, `message`, ненулевой exit. Нельзя заменить настоящие тесты скриптом, который всегда печатает этот пример. `scannedFiles` должен точно покрыть объявленные paths. Собственные validators — доверенный код проекта; built-in security scanner receipts имеют свой отдельный контракт и не подменяются этим JSON.

## Проверка этого среза

```powershell
node --test tests/quality-profiles.test.mjs tests/quality-runner.test.mjs tests/quality-cli.test.mjs
```

Эти scoped tests используют настоящие temp Git-проекты, fake managed/native tool ports для языковых контрактов и настоящий Node process port для configured checks, deadline/tree/output/cancel. Это offline evidence, а не proof работы девяти установленных SDK или UI. Координатор отдельно выполняет integrated `npm run check`, security gates, live tool/profile проверки и CI. [ADR-0005](decisions/0005-language-quality-profiles.md).
