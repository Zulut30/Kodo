# Проверки Kodo

Состояние на 3 ноября 2026 года. Исторические результаты 2 ноября сохранены; новая интеграция UI/security имеет отдельные свидетельства ниже. Локальные/CI, реальные подписочные/UI проверки, опубликованный артефакт и deployment оцениваются раздельно.

## Автоматические проверки

```powershell
npm run check
node scripts/package-smoke.mjs
```

[CI Windows/Linux с Node.js 24](https://github.com/Zulut30/Kodo/actions/workflows/ci.yml) выполняет эти команды. Smoke упаковывает сам Kodo, устанавливает `.tgz` в изолированный каталог, запускает установленный CLI и проверяет 13 закреплённых навыков, 183 оригинальных файла и 33 компонента каталога. Точные итоги каждого commit находятся в его CI; локальный Windows-прогон не подменяет Linux-проверку.

Обычные тесты используют фикстуры, локальные Git/npm-пакеты и контролируемые ответы провайдеров. Платных API-запросов и подписочных модельных вызовов в CI нет. Платформенные проверки DPAPI и Unix permissions запускаются на соответствующей ОС.

| Требование | Регрессионная проверка |
| --- | --- |
| Все навыки включены по умолчанию для трёх клиентов | `CLI init installs all default skills and the chat entry for Codex Claude Code and OpenCode` |
| Все 13 навыков рассматриваются на каждом этапе | `Default policy evaluates all thirteen pinned skills at every runtime stage without network calls` |
| Изменённый upstream не используется незаметно | `Default policy rejects altered pinned source and invalid provenance before building a prompt` |
| Продолжение точной сессии после лимита | `Engine waits for quota then resumes the exact recorded worker session` |
| Восстановление после squash merge без сохранённой квитанции | `Engine reconciles a real squash merge before changing its reviewed head after a missing receipt` |
| Версии не пересекаются с ещё не опубликованным merge | `Second assigned run bumps past a merged but unpublished target version` |
| Новые зависимости устанавливаются после изменения lock | `Setup installs missing dependencies despite legacy Ajv and refreshes changed locks while reusing unchanged installs after reopen` |
| Известные ключи не попадают в рабочий промпт | `Worker prompts remove known credentials from analysis and host plans while preserving credential-handling code examples` |
| Выпуск устанавливается и восстанавливается без повторной публикации | `Release packages exact merged commit installs artifact and reconciles without republishing` |

Также проверяются отмена, неверные контракты, недоступность Jev и источника исследования, пересекающиеся области записи, сохранность пользовательских файлов, повторные проверки после ревью и изменения main, Git hooks/окружение, свежесть тегов, права хранилища и подмена артефактов. Все три пресета включают стандартные навыки и чат-вход Kodo; dry-run не создаёт целевой каталог.

## Контекст, очередь и RTK

Изменение run `16877cd8-f73a-43de-ab00-5c098211c20e`: [поведение и локальные измерения](EFFICIENCY.md), [ADR-0004](decisions/0004-context-output-and-ready-queue.md). Узел F сверяет интегрированные A/B/C/D и E на исходном HEAD `6a21156d8da652d7b5437e5ced13e2b1bf775854`, изменяет только README/docs и не запускает повторно provider/tool install или общий check. Исторические разделы ниже относятся к своим прежним срезам.

Координатор передал актуальные целевые результаты D: **144 passed, 0 failed, 0 skipped**, Windows, Node.js `v24.19.0`. Команда из приватной квитанции `kodo-engine-efficiency-D/status.md` и `final-scoped.txt`:

```powershell
node --test tests/efficiency-engine.test.mjs tests/task-context.test.mjs tests/metrics.test.mjs tests/providers.test.mjs tests/context-pack.test.mjs tests/rtk.test.mjs tests/runtime.test.mjs tests/scheduling-engine.test.mjs tests/task-scheduler.test.mjs tests/efficiency-acceptance.test.mjs
```

Это результат исполнителя D на текущем исходном срезе, прочитанный F, не новый прогон documenter. Предыдущие **168 PASS / 1 POSIX-only skip** относятся к более раннему broad regression до последних snapshot/lease follow-ups; они не складываются с 144 и не подменяют итоговый check. D сохранил RED-воспроизведения mandatory boundaries, immutable evidence, metrics, Unicode paths, typed evidence, snapshot и tool lease; критерии не ослаблялись.

Независимый E: **26/26 PASS** и **13 killed in-memory mutations**, по результату координатора. Его область — A/B public APIs и bounded verified lessons, без утверждения о проверке последующей D wiring самим E. Отдельная provider-регрессия формулировки ready/active routing прошла RED → GREEN вместе с confidence/fallback, **3/3**. Сохранённый typed serial-выбор D оставлен в силе; дополнительного live rerouting не было.

| Публичное требование | Точное имя целевой регрессии |
| --- | --- |
| C стартует до конца независимого B, worktree различны, исходный checkout сохранён | `Engine admits downstream before slow sibling finishes using distinct exact Git worktrees` |
| Completed/pending merge recovery, serial routing, глобальная capacity | `Engine recovers completed work without routing or executing it again`; `Engine recovers the recorded pending merge owner before earlier completed nodes even without MERGE_HEAD`; `Engine honors both plan and Jev serial decisions until prior integration is finished`; `Engine retains the global subscription capacity across two continuously scheduled runs` |
| Сбой/отмена безопасно дожидаются уже начатой работы | `Acceptance A keeps the first typed failure and drains a sibling when cancellation follows failure`; `Acceptance A cancellation drains pending routing and execution without admitting their dependents` |
| Unicode, unknown/failed, явные потери и mandatory budget | `Acceptance B measures Unicode bytes and bounds both compactors without corrupting input`; `Acceptance B never promotes stale partial malformed or contradictory check evidence to pass`; `Acceptance B rejects an impossible mandatory boundary instead of clipping commands or evidence paths` |
| Полезные проверенные знания без raw history | `Acceptance B carries only bounded verified knowledge with matching review and check heads` |
| Компактный реальный prompt и один сохранённый snapshot | `Engine planner sends compact redacted evidence with readable private immutable head-bound originals`; `Engine compacts one captured evidence snapshot even when research changes during artifact persistence` |
| Полные criteria, check logs и evidence integrity | `Engine rejects oversized new plans but resumes saved node contracts without dropping late requirements`; `Engine review compacts full diff and check logs while preserving readable command diagnostics and all required criteria`; `Engine rejects evidence changed during a successful review and refuses damaged cached check logs` |
| Raw failures и bytes при неуспехе | `Engine coordinator checks keep raw Node diagnostics and retain the full failed command output privately`; `Engine retains measured prompt bytes on typed provider failures without inventing native usage` |
| RTK после lease, приватный env, проверка между сессиями | `Engine session uses verified managed RTK only in a private worker environment and rechecks each new session`; `Engine resolves worker tool integrity only after obtaining the subscription lease and reuses it within that session` |
| Missing/unsupported, неверный archive и неизменные counts | `RTK missing and unsupported resolution stays raw without installation`; `RTK official archive digest mismatch stops before extraction or native execution`; `RTK pins only verified OSS archives without changing component or skill counts` |
| Routing соответствует ready frontier | `Routing supplies concrete ready frontier and ignores blocked descendants without overriding Jev`; `Jev scheduling question distinguishes active work from completed ancestors and blocked descendants` |

Тесты Engine используют настоящие временные Git/worktree/filesystem и Windows ACL fixtures при подменённых native providers. Это не живой inference, POSIX permission run, UI/security gate или опубликованный пакет. Policy integrity остаётся отдельным контрактом `tests/skill-policy.test.mjs`: все 13 решений и проверки pinned resources, полный адаптер и resolvable references без длинных upstream excerpts. Catalog содержит 10 tools; registry 33/default skills 13 не менялись.

Собственная проверка F на Node.js `v24.19.0`: `git diff --check` и статическая сверка восьми разрешённых файлов прошли. Проверены 65 локальных Markdown-ссылок/якорей, 6 JSON-примеров, наличие всех 25 названных регрессий в tests, 7 строк измерений с пересчётом процентов по квитанции, RTK pin/platforms и counts 10/33/13. SHA-256 шести production/test файлов совпали с `source-receipt.json` D. Это проверка документации и соответствия исходникам, без повторного выполнения D/E tests.

Локальная квитанция координатора `<OS temp>/kodo-efficiency-20261103/efficiency-measurements.json` содержит фактические UTF-8 размеры одинаковых сохранённых входов, `modelsCalled:0`: policy −51,74…59,36%, inline plan/review −89,15%/−91,79%, managed RTK Git log −63,65% с обоими exit 0 и сохранёнными семью commit IDs. Полные числа и различие исторического baseline/runtime metrics — в EFFICIENCY. Части не складываются в экономию всей сессии. Отрицательная Node/TAP fixture (`rtk-fixture/receipt.json`, `raw.txt`, `rtk.txt` того же scratch) потеряла sentinel при обоих exit 1; её уменьшение 4253 → 100 байт исключено из принятой экономии. Подписочная quota, total native tokens и USD этим способом не измерены.

Отдельный `<KODO_HOME>/runs/<runId>/native-environment-check.json` проверил новый фактический Engine worker environment: Codex/Claude Code subscription auth доступны, managed `rtk 1.1.0 --version` exit 0, private DB/recall0/tee0/telemetry-off. `modelsCalled:0`; это auth/env probe, не новый Claude task run и не E2E всей задачи. Managed install/Git-output проверены отдельно координатором, global RTK 0.50.0 оставлен прежним. F RTK и providers не запускал.

Матрица моделей по-прежнему отложена; новых результатов скорости/победителя нет. **Общий `npm run check`, свежие enabled UI/security gates, независимое финальное review, CI, package/installed release smoke и deployment этого изменения на этапе F ещё не подтверждены.** UI в конфигурации Kodo выключен и нейтрален (`passed:null`), security включён и требует актуальных evidence. Реальная работа в видимых чатах относится к текущему частному host-adapter координатора; generic desktop backend CLI не заявляется.

## Режимы, метрики и парный benchmark

Контракт режима и методики: [RUNTIME](RUNTIME.md#режимы-исполнения), [BENCHMARK](BENCHMARK.md), [ADR-0003](decisions/0003-execution-modes-and-benchmarks.md). Документирующий worktree основан на `e179d369fe664fa4a2b055eb26c8577f4f41eb6f`; production-код и тесты в нём не менялись. Исправление повторного использования checks координатор добавляет отдельно в integration того же run, поэтому уровни доказательств нельзя объединять в один GREEN.

Целевой офлайн-прогон на Windows с Node.js `v24.19.0`:

```powershell
node --test --test-reporter=spec tests/modes.test.mjs tests/mode-engine.test.mjs tests/metrics.test.mjs tests/benchmark.test.mjs tests/benchmark-cli.test.mjs
node --test --test-reporter=spec --test-name-pattern="Catalog validates all shipped components|Preset installs for all clients with self-contained pipelines" tests/toolkit.test.mjs
```

Первая команда завершилась с exit 1: **73 tests, 71 passed, 2 failed, 0 cancelled, 0 skipped**, длительность 186228 ms. Одна самостоятельная причина — известный `unchanged head reuses checks`; второе failed — его родительский тест. Фактически записано `test, build, test, build` вместо `test, build`: старый snapshot повторяет успешные команды после quota-review. Production-исправление не переносилось в этот worktree. Остальные сценарии, включая changed-head, changed test/build-команды и свежий failed UI после quota, прошли.

Вторая команда проверила каталог и установку самодостаточных pipeline/skills для всех клиентов: **2 passed, 0 failed**. Дополнительная локальная проверка подтвердила 35 Markdown-ссылок/anchors, оба pipeline JSON, 33 registry-компонента, 13 default-skill IDs, 9 optional tools и неизменность защищённых production/tests/lock/UI/security путей; `git diff --check` прошёл. Dispatcher-workflow сохранён. Первая команда проверяет следующие публичные требования на настоящих временных Git-worktree с подменёнными provider boundaries:

| Требование | Точное имя теста |
| --- | --- |
| Три конечных профиля и меньшие проектные бюджеты | `Modes accept only three public names and keep frozen bounded profiles`; `Profiles clamp smaller explicit project budgets without mutating defaults or config` |
| Ранняя typed оценка и уверенность auto quick | `Assessment sends one typed atomic Jev batch with task as bounded data`; `Automatic quick requires all low local dimensions at both confidence and probability boundary` |
| Explicit mode и fallback | `Explicit run mode overrides assessment and project mode while retaining typed receipt`; `Unavailable Jev is honest standard fallback and explicit mode still wins` |
| Quick: одна реализация, реальный test/build и свежее независимое review | `Quick performs one executor and fresh independent review with actual test build and head-bound gates` |
| Оценка раньше дорогого анализа, сохранение режима при resume | `Automatic assessment precedes expensive analysis and project mode is overridden by explicit mode`; `Quick prepare persists selection across config changes and resumes without repeated assessment or analysis` |
| Legacy recovery и предел плана | `Legacy saved analysis receives compatibility standard policy without repeating completed analysis`; `Mode plan limits reject oversized host and native plans before any executor` |
| Фиксированная модель для всех native-этапов | `Explicit model stays fixed for planner worker reviewer and retries despite uncertain strongest routing` |
| Провал quick/gates без лишнего research и escalation | `Quick failure keeps actual failed checks and independent review findings without extra research or repair`; `Quick retains configured UI and security gates and missing tools block delivery without escalation` |
| Противоречивый PASS с серьёзными findings отклоняется | `Quick rejects contradictory passing review receipts with blocker or major findings` |
| Nullable metrics и разная семантика cache | `Codex totals include cached input once and expose absent cache fields as unknown`; `Claude totals add separate cache reads and writes only when all components are known`; `Aggregation preserves partial and absent evidence instead of fabricating zeros` |
| Assessment считается один раз | `Benchmark reports authoritative Engine assessment counters without doubling wrapped operations` |
| Настоящий Engine, модель, lease и свежие состояния пары | `Paired benchmark uses Engine create/run with fixed models mode shared leases and fresh stores`; `Production benchmark executes actual Engine worktrees review and checks using offline provider boundaries` |
| Скрытый oracle и независимый scope | `Fixtures use identical initial commits and hidden oracle rejects wrong code and auxiliary tampering`; `Held-out scope rejects ignored new files and changed auxiliary declarations independently of correctness` |
| Quota/abort, продолжение и версия методики | `Quota and interrupted attempts resume without duplicating completed trials`; `Resume rejects changed methodology identity and seeded order is reproducible` |
| Заверение модели не определяет правильность | `Model success claims do not determine correctness and failures stay in summary denominator` |
| Полное время, native duration, failures и неизвестные | `Paired reports separate native duration from wall time and keep failed and unknown cells in their denominators` |
| CLI и отсутствие скрытого paid-прогона | `Benchmark CLI parses selected native client models modes seed and repeats without provider calls`; `Dedicated CLI entry rejects invalid invocation offline and fixture assets belong to the package` |

Поправка local checks сверена чтением фактического `checks()` в integration: exact HEAD, чистота worktree, полный упорядоченный список test/build с exit 0, Node version/ABI/platform/arch входят в условия повторного использования. Это не изменение production документирующим worker. По сообщению координатора same-head регрессия с исправлением уже GREEN; финальное повторение changed-head/config и свежего failed UI в integration — отдельное свидетельство координатора. Эти сведения не являются собственным зелёным повтором исправления на старом срезе. Контрактные тесты — `Review quota recovery reuses successful checks only while their exact head is unchanged` и `Review quota recovery cannot reuse a previous enabled UI pass after observations fail`.

Полный 24-trial native pilot не завершён: 3 ноября пользователь отложил бенчмарки ради MVP после 9 испытаний. Частичные квитанции и замороженные исходники сохранены; победитель или ускорение не заявлены. Отложенная матрица — 2 fixture × 3 доступные Codex-модели × plain/Kodo × 2 повтора. Недоступность модели сокращает фактическую матрицу и отражается в excluded, quota/abort — в pending. В будущем отчёте обязательны условия окружения, версии/hashes, raw trial records, failures и знаменатели; unknown usage/HTTP counts остаются null. Чистое LLM latency и точная цена подписки не наблюдаются. Публикация MVP требует отдельных проверок пайплайна и установленного CLI, а не завершения отложенного сравнения.

Полный интегрированный `npm run check`, независимое ревью документации, CI Windows/Linux, реальные provider/UI/security, package smoke/установленный release и deployment принадлежат отдельным этапам координатора. Целевые офлайн результаты их не удостоверяют. Новых registry-компонентов, default-skill IDs или автоматических paid-вызовов этот этап не добавляет.

## Целевые проверки аудита

```powershell
node --test --test-reporter=spec tests/audit.test.mjs tests/audit-cli.test.mjs
```

В документирующем worktree на базе `14d724a1d65865150c9abe8c797a48fd75bd547b` 2 ноября 2026 года выполнен локальный прогон на Windows, Node.js `v24.19.0`: **127 passed, 0 failed, 0 skipped**. Проверены существующая реализация и независимые контрактные тесты; код и тесты в этом этапе не менялись. Это целевая локальная проверка, а не результат общего CI, native-клиента, опубликованного пакета или развёртывания. Полные `npm run check`, упаковку и выпуск после интеграции выполняет координатор.

`tests/audit.test.mjs` проверяет публичный `buildAuditReport(run)` на самостоятельно заданных фикстурах. `tests/audit-cli.test.mjs` запускает реальный CLI отдельным процессом с временной SQLite-базой, без проекта и доступных Git-команд. Сетевые обращения, дочерние процессы и чтение файлов ключей/конфигурации перехватываются как ошибки. Отдельный subprocess запускает CLI без права записи файлов. Неизменность проверяется для логических таблиц состояния и файлов вне SQLite; для старой базы также сравниваются байты, список файлов и схема. Это не обращение к реальным провайдерам.

Ниже точные имена ключевых тестов; параметризованные варианты дополнительно проверяют все этапы, допустимые подмножества ролей, типы полей и неверные флаги.

| Требование | Точное имя теста |
| --- | --- |
| Синхронный отчёт и точная схема | `Audit report exports a synchronous allowlisted schema with canonical complete coverage` |
| Все ID совпадают с публичным набором | `Audit fixtures cover all 13 public default skill IDs` |
| Перестановка решений не нарушает полноту | `Audit normalizes shuffled stage records and skill decisions deterministically` |
| Только роли текущего плана, без дубликатов | `Audit derives expected stages from subset roles tester,tester` |
| Отсутствующая стадия | `Audit detects missing expected stage tester` |
| Отсутствующий или пустой план исключает полноту | `Audit cannot claim completeness with missing tasks`; `Audit cannot claim completeness with empty tasks` |
| Необязательный repair проверяется при наличии | `Audit includes repair only when recorded and validates it` |
| Лишний известный этап тоже проверяется | `Audit validates recorded known stages even when their roles are not required` |
| Неизвестный этап не даёт полного покрытия | `Audit rejects unknown recorded stages without leaking their payload` |
| Формат хеша, уникальность ID и revision | `Audit invalidates uppercase hash`; `Audit invalidates duplicate default skill`; `Audit invalidates uppercase revision for applicable and non-applicable skills` |
| Неприменимость учитывается, семантика не доказана | `Audit accepts valid non-applicable decisions without claiming semantic compliance` |
| Квитанции фильтруются, полнота не равна успеху | `Audit allowlists receipts and omits tasks prompts source paths config and provider output` |
| Вложенные значения не обходят список полей | `Audit does not copy nested arbitrary values through malformed allowlisted receipt fields` |
| `false` и `0` сохраняются без приведения типов | `Audit preserves false receipt booleans and zero exit codes without coercing malformed scalars` |
| Вложенный вход остаётся неизменным | `Audit never mutates nested input including shuffled arrays malformed policies and receipts` |
| Чистая функция не требует записи или subprocess | `Audit pure builder succeeds with filesystem writes and child processes forbidden` |
| CLI работает вне проекта | `Audit CLI JSON reads a saved run from an unrelated no-config cwd` |
| Ключи и конфигурация не читаются, состояние сохраняется | `Audit CLI ignores broken credentials and configs without changing saved state or worktrees` |
| CLI работает при запрете записи | `Audit CLI reads saved state with filesystem writes forbidden` |
| Отсутствующая база не создаётся | `Audit CLI unknown run does not initialize a missing state home` |
| Старая база остаётся без миграции | `Audit CLI reads a legacy saved run without changing database bytes or adding schema` |
| Старый запуск читается с кодом 0 и неполным покрытием | `Audit CLI returns exit zero and incomplete JSON for old saved runs` |
| Некорректная политика не превращается в ошибку чтения | `Audit CLI returns exit zero with invalid recorded policy flagged` |
| Текст объясняет пределы доказательств | `Audit CLI text explains coverage missing and invalid stages applied skills and evidence limits` |
| Неизвестный ID даёт ошибку без изменения состояния | `Audit CLI rejects an unknown run in JSON mode without state changes` |
| Неверные аргументы отклоняются | `Audit CLI rejects missing ID`; `Audit CLI rejects duplicate JSON flag`; `Audit CLI rejects unknown flag` |
| Команда видна в справке | `Audit CLI help advertises audit RUN_ID and optional JSON output` |

Красная фаза TDD и последующая зелёная проверка другим тестовым узлом требуют отдельных свидетельств координатора; этот прогон документации подтверждает только текущее зелёное состояние. Наличие в тесте комментария о RED не доказывает прежнее падение. Для приёмки текущего запуска также нужны независимое ревью, protected PR, merge и проверка выпущенного пакета. Их успех здесь не заявлен. [Граница отчёта](decisions/0001-run-audit-evidence.md).

## Интеграция UI, security и контекста

Задание документации run `9fc232f4-c2fc-4d21-8822-9dcca700c309`, отдельный `integration-docs` worktree на исходном `bd6c06fed5092cb7f78550986270e27263858a49`. Production-код, registry/defaultskill IDs, исследовательские окружения и глобальные инструменты не изменялись. Full `npm run check`, package/build/release suites выполняет координатор на объединённом результате, не этот worker.

В начальной RED-проверке требуемые `docs/UI-TOOLS.md` и ADR-0002 отсутствовали: assertion на первый файл завершился с exit 1. После добавления документационный контракт прошёл: 5 JSON-примеров нормализованы настоящими config ports, 3 MCP-шаблона разобраны JSON/TOML parser, Chrome pins/изоляция/telemetry flags проверены, прежние Playwright-секции совпали с HEAD. Также прошли 4 pipeline JSON, 33 registry-компонента, 13 skill pins, локальные ссылки и scope всех 20 изменённых файлов. Это проверка документации и конфигурации, отдельно от runtime-регрессий.

Локальные целевые прогоны documenter без GUI, установки инструментов и платных вызовов:

```powershell
node --test --test-name-pattern='Catalog validates|Adapters emit|Preset installs' tests/toolkit.test.mjs
node --test tests/task-context.test.mjs tests/progress.test.mjs tests/ui-bridge.test.mjs
node --test --test-name-pattern='Default policy evaluates|Context is bounded|Catalog exposes|Import, missing resolve|Chrome MCP accepts|Semgrep invokes|Python installs' tests/skill-policy.test.mjs tests/tools.test.mjs
```

Результаты: **3/3**, **15/15** и **7/7** соответственно. В 15 входит offline Python compatibility/failure wrapper и настоящий SDK stdio с локальной protocol fixture; это не живой Chrome и не провайдер. Установка для трёх клиентов проверяет обнаруживаемые навыки и самодостаточные pipeline bundles.

| Требование | Точное имя прошедшей локальной проверки |
| --- | --- |
| 13 навыков не заменены tool policy | `Default policy evaluates all thirteen pinned skills at every runtime stage without network calls` |
| Девять закреплённых инструментов | `Catalog exposes exactly the approved pins and immutable native digests` |
| Метаданные не запускают UI/install | `Import, missing resolve and doctor do not install or contact browsers` |
| Tool guidance ограничен и приватен | `Context is bounded, capability-specific and never reflects arbitrary private input` |
| Pins Python и отдельный Semgrep venv | `Python installs the four compatible pins together and Semgrep separately, never into user/global environments` |
| Реальные особенности пакетов | `Chrome MCP accepts the pinned package relative bin spelling and rejects traversal`; `Semgrep invokes its supported console entry and uv Git uses invocation-local long paths` |
| Scoped context без истории | `Task context preserves scope acceptance interfaces and direct dependencies without nested history`; `Task context bounds oversized optional data and redacts credential URLs` |
| Восстановление progress из состояния | `Progress is bounded allowlisted recovery evidence and atomically replaced from authoritative state`; `Progress refuses repository destinations and unsafe run identifiers` |
| Trim/nonempty имя fixture | `Owned form rejects whitespace names and verifies only a trimmed nonempty name` |
| Windows Chrome env без ложного профиля | `Windows owned Chrome omits fabricated account folders without inheriting personal state or keys` |
| Desktop uncertain delivery | `desktop observes uncertain final delivery once and requires independent state assertions`; `desktop does not continue mutations after uncertain intermediate delivery` |
| Независимый readback через MCP | `Chrome MCP navigates and acts on observed UIDs, reads DOM independently and closes transport`; `Chrome adapter exercises the official SDK stdio transport against an offline protocol fixture` |
| Сохранение клиентских bundles | `Catalog validates all shipped components and resolves unique dependencies before consumers`; `Adapters emit the documented layout and role format for each client`; `Preset installs for all clients with self-contained pipelines and repeatable files` |

Отдельно documenter воспроизвёл **2/2 RED** на исходном дереве:

```powershell
node --test --test-name-pattern='UI rejects bridge results above|Engine counts changed contents' tests/ui-verification.test.mjs tests/repair-budget.test.mjs
```

`Engine counts changed contents of the same uncommitted file as progress through the fifth node round` завершился на второй попытке с `no_progress` вместо пятой с `repair_budget_exhausted`. `UI rejects bridge results above the configured step budget despite passing independent observations` принял 3 шага при `maxSteps:2` и признал квитанцию актуальной. Тесты и ожидания не ослаблялись.

Последнее `QA FIX RESULTS` integration-contract фиксирует последующее исправление координатором: fingerprint tracked diff + ограниченных untracked bytes и передача normalized config в live/persisted UI result validation. **25 целевых тестов PASS**, затем **`Engine counts changing contents of a new untracked file as progress within the explicit budget` PASS**. Documenter прочитал исправленные исходники на integration `e85240c53a5059e0e19212ced2f841fea58441fc`, но не переносил production в свой worktree и не выдаёт прежний RED за новый локальный GREEN. Это свидетельство координатора; общий `npm run check`, CI и выпуск ещё не подтверждены.

Контракт также записывает прежние 79 targeted UI/security/delivery PASS и 10 bridge compatibility PASS до последних QA-исправлений. Они относятся к своим срезам, не подменяют итоговые проверки объединённой ревизии. Существующие tests дополнительно описывают требования gates: `Both pinned scanners scan tracked runtime and tests with isolated offline environments`, `Findings fail with only typed locations and no secret match snippets or raw output`, `Receipts reject changed head configuration pins missing evidence and tampered bytes`, `Direct delivery rejects missing forged or stale enabled gate receipts before publishing`. Этот worker их отдельный полный прогон не заявляет.

## Реальные квитанции run9fc

Источник — актуальный `integration-contract.md` каталога запуска run9fc; пути ниже указаны от приватного scratch координатора, вне Git. Документационный worker не выполнял GUI/API-проверки и не переносил сырые traces.

| Проверка | Подтверждённый результат и границы |
| --- | --- |
| Browser Harness, Chrome DevTools MCP, Agent Desktop, Browser Use | Успешные реальные cases в `live-all-ui/ui-smoke-e960aca82d6a.json`, HEAD `edc657d`. Первый общий batch не прошёл: Vibetest выявил настоящий empty-name дефект fixture. |
| Исправленная fixture и Vibetest | required+trim в `0605cec`, сохранено в integration `1ad830e`; успешный Vibetest в `live-vibetest-fixed/ui-smoke-014391624527.json` на `1ad830e`. |
| Jev Ultrafast | Отдельный реальный recheck `live-jev-diagnostic.json`: два действия, daemon очищен. Точный HEAD этого диагностического файла в контракте не указан; не приписывается общий batch PASS. |
| Независимая видимая UI QA | `visible-ui-qa/receipt.json`: реальные формы Browser Harness/Agent Desktop прошли, собственные процессы/endpoint закрыты. Удаление тестового Chrome-профиля было заблокировано автоматической проверкой разрешений; профиль оставлен приватно, полное удаление не заявляется. |
| Реальные scanner gates | На `b3f1cf7866792e5682d1d63e896938e8dbbe1833` Semgrep 1.183.0 просканировал 53 поддерживаемых файла, Gitleaks 8.30.1 получил scope 120; оба прошли. Ранее независимая QA воспроизвела Semgrep RPC failure при длинном Windows TEMP; короткий собственный temp устранил сбой без изменения global TEMP/WSL. |

Все шесть UI-драйверов имеют отдельные реальные успешные свидетельства. Это не общий PASS первого batch, не fresh gate текущего объединённого HEAD и не проверка всех поддерживаемых ОС. Два собственных видимых QA-чата завершены, результаты проверены координатором и чаты архивированы штатным механизмом; постоянный диспетчер сохранён. CLI-native sessions не объявляются видимыми чатами.

Урок fixture: exploratory QA оценивает и само тестовое приложение. Подтверждённую ошибку сохраняют, исправляют required/trim и повторяют сценарий; результат QA нельзя отбрасывать для зелёного summary. [ADR-0002](decisions/0002-ui-security-and-progress.md), [pins и публичный JSON](UI-TOOLS.md).

Для новой интеграции **общий check/CI, PR/merge, опубликованный пакет, installed smoke выпуска и deployment пока не заявлены**. Исторический выпуск 0.2.1 ниже относится к прежней функциональности и не является доказательством поставки этих adapters.

## Реальная приёмка пайплайна

| Прогон | Наблюдаемый результат |
| --- | --- |
| Codex: `dd933f2f-4208-430f-9064-2bbcad9d614b` | Статистика каталога, отдельные тестовый и документирующий агенты, независимое ревью, CI и [merge PR №3](https://github.com/Zulut30/Kodo/pull/3). |
| Claude Code: `224b5631-9e3e-40f7-aece-2a619bdc49b3` | Поиск каталога, отдельные тесты и документация, независимое ревью, CI и [merge PR №2](https://github.com/Zulut30/Kodo/pull/2). |
| Обе подписки: `4de87393-1087-4e57-94d0-6c012f2d9099` | В отдельном временном проекте Jev выбрал Codex Sol для реализации и Claude Sonnet для тестов. Документирование и независимое read-only ревью завершены; 9 тестов прошли без ошибок и пропусков. |

В смешанном прогоне подготовка и продолжение выполнялись разными процессами с одним runId; анализ выполнялся один раз. В прогонах самого Kodo выполнены отмена и продолжение, сохранён единственный PR каждого запуска. Поиск попал в main раньше статистики; при обновлении второй ветки возник реальный конфликт CLI. После его разрешения обе команды прошли совместные 46 целевых проверок, затем общие проверки, новое независимое ревью и CI перед merge.

Начальные ошибки ядра, устаревшие зависимости и позднее обнаружение изменения main были обнаружены во время этих прогонов. Исправления подготовлены с регрессиями. Ключи не передавались исполнителям; GPT и Claude выполнялись через авторизованные подписочные клиенты.

## Реальные внешние сервисы

Gemini `gemini-4-argon` выполнил анализ проекта; TypeSafe Jev вернул структурированные решения. Получены реальные результаты Reddit API, GetXAPI и Scrape.do для X, GitHub, Hacker News и документации. Отдельная проверка Reddit вернула 8 ссылок за один запрос без ошибки источника. Смешанный прогон получил результаты всех пяти источников без ошибок и использовал Jev без fallback.

Результат поиска остаётся источником идей: ссылка не подтверждает лицензию библиотеки, совместимость или воспроизведение её поведения. Короткое обращение к сервису не доказывает стабильность его будущих лимитов.

## Проверка выпуска

Для [выпуска CLI 0.2.1](https://github.com/Zulut30/Kodo/releases/tag/v0.2.1) координатор проверяет точный merged commit, выполняет тесты, создаёт `.tgz` и SHA-256, устанавливает пакет в изолированное окружение и запускает команды установленного `kodo`. После загрузки проверяются удалённый тег и скачанные байты assets. Публикация в npm не выполняется.

Итоговая квитанция запуска `6ea17f8f-5709-499c-80f0-8e5c5899f63e` содержит PR, merge commit, версию, URL архива, SHA-256, платформу и результаты installed smoke. Выпуск считается опубликованным только после успешного подтверждения этих действий; push не называется деплоем.

MCP-шаблоны проверены как конфигурации. Это не является доказательством живого соединения с произвольным GitHub MCP, браузером или базой данных. Хранение ключей и границы доверия описаны в [SECURITY.md](SECURITY.md).

### Регрессии после общего прогона

Первый полный прогон выявил повреждение безопасного `Bearer ${token}` и ресурсный timeout причинного scheduling-теста. Общий редактор сохраняет только полные буквальные ссылки на переменную/свойство, а известные значения, реальные ключи и смешанные токены по-прежнему скрывает. Optional summary и previous error очищаются до сокращения: проверяется отсутствие префикса ключа на границе. Неизменённый критерий release-finalization прошёл red/green.

Подготовка Windows ACL выполняется один раз на ограниченный пакет evidence: три записи узла используют один защищённый каталог; следующий пакет применяет защиту заново. Истёкший writer и замена/удаление каталога отклоняются; проверки bytes/hash/head сохраняются. Scheduling fixture дожидается остановки активных задач до закрытия БД. Его guard60с учитывает реальные Git/ACL/pin операции под нагрузкой; ordering assertions и handshake сохранены. На финальных байтах24/24 сценария прошли; искусственный wave barrier провалил тот же handshake. Это проверка надёжности и причинного порядка, не гарантия времени произвольной задачи.

Целевой repair-прогон:109 tests,108PASS,1 штатный Unix-onlySKIP на Windows. Дополнительно quota-resume и lease-lost:2/2PASS. Общий check, свежие gates/review, CI и release проверяются отдельно координатором.
