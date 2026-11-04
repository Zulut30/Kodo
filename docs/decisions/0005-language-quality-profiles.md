# ADR-0005: Детерминированные профили качества и граница процесса

Дата: 2026-11-04. Статус: принято для этапа 02.

## Контекст

Kodo уже имеет managed optional tool installer/resolver, bounded owned-process port, coordinator gates и configured commands. Языковые проверки нужны без LLM и credential startup. Новые installer/Engine/release механизмы размыли бы текущие границы и не доказали бы проверку исходников. Exit 0 сам по себе недостаточен: gofmt возвращает его и для неформатированных файлов, некоторые reporters возвращают пустые/частичные результаты, а tool pin ещё не означает фактически проверенную версию.

## Решение

`runtime/quality.mjs` владеет offline inventory, строгой per-project quality config и декларативным планом для девяти языков. `QualityProfileRegistry.detect/plan` не запускают процессы. Язык и framework выводятся из source/manifests/config/locks, а не имени каталога. Quick scope явный; project-wide analyzer/compiler widening имеет записанную причину. Неизвестные compiler scopes и небезопасные paths блокируются.

`runtime/quality-runner.mjs` использует существующий `resolveTool` для шести managed tools и существующий `delivery.execute` для всех процессов. Installer остаётся единственным. Native SDK/Composer tools требуют точных project pins и отдельных version observations. Runner задаёт bounded per-capability deadline/output, credential-free environment, read-only check flags, проверяет output contract, source/head mutation и сохраняет независимые receipts с полными bounded/redacted process logs вне Git. `delivery.execute` остаётся владельцем timeout/cancel/tree teardown; собственного kill/process-tree механизма нет.

`runtime/quality-cli.mjs` подключён до runtime startup. JSON stdout — один результат, blocked/failed — ненулевой exit. Test/security/architecture/release имеют отдельные neutral receipts до явного подключения проектного validator. Интеграция в обязательные checks происходит через существующий `commands.test`; Engine и текущие security/delivery gates не изменяются. Release validator не публикует артефакт.

Strictness различает strict TS enforcement, обычную настройку проекта и explicit debt adoption. Только точно совпадающее старое наблюдение на неизменённом файле может быть принято как debt; новые/изменённые файлы дополнительно определяются Git, независимо от supplied changed paths. Автоматического snapshot всех нынешних ошибок нет. Известный diagnostic exit code с полностью погашенными старыми наблюдениями сохраняется в evidence; crashes/unknown failures не разрешаются baseline.

## Последствия и пределы

Профили полезны без моделей и без установленного инструмента показывают честные missing/blocked состояния. Native dependency restore/cache preparation и реальные framework/UI/SDK проверки остаются отдельной coordinator работой. Это не OS sandbox для недоверенного project code: компиляторы, plugins и явно разрешённые scripts могут выполнять код; generated build/cache files отделены от исходного inventory. У .NET заранее существующий obj/assets может быть необходим. Cargo/Go сети и silent installation отключены, отсутствие offline dependencies блокирует check.

Точные cross-project dependency graphs, дополнительная архитектурная политика, benchmarks/cache и automatic release hooks не добавлены в эту фазу. Neutral disabled/skipped evidence не считается PASS. Публичный receipt содержит safe findings/identities, private evidence — ограниченные отредактированные process outputs; reuse требует current source/head/config/pins/tool installation и целых evidence bytes. Поддерживаемые SQL dialect и ограничения HTML ignore описаны в [QUALITY](../QUALITY.md).

## Проверка и урок

Requirement-first RED/GREEN tests проверяют выбор девяти языков, framework indicators, версии/dialect/config/debt, процесс/scope/mutation/полноту и CLI без startup. Node process integration проверяет фактический deadline и завершение child tree, а не только mock exception. Независимое review, integrated checks, scanners, CI и live tools принадлежат координатору; один worker не объявляет published/deployed или native SDK coverage.

Реальные tool outputs могут отличаться от ожидаемых обёрткой: Stylelint пишет JSON в stderr, HTML-Validate чистый JSON — `[]`, версии Oxc и Python `-m` имеют разные prefixes. Сначала фиксируйте observation/негативный regression, затем корректируйте parser, сохраняя проверку полноты и диагностический failure. Приписывать PASS отсутствующему JSON или баннеру нельзя.
