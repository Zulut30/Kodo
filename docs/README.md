# Документация Kodo

Документация разделена на три части: **руководство** (как пользоваться и что гарантируется), **решения** (ADR: почему так) и **архив** (квитанции проверок, замеры и журнал разработки). Руководство не требует читать архив; архив нужен, чтобы проверить конкретное утверждение по сохранённым доказательствам.

## Руководство

### Начало работы

- [Совместимость](COMPATIBILITY.md) — куда ставятся навыки и роли, как запускаются клиенты.
- [Переход на Kodo](MIGRATION.md) — с AI Toolkit (`.ai-toolkit`, `aitk-`) на `.kodo` и `kodo-`.
- [Навыки по умолчанию](DEFAULT-SKILLS.md) — 13 стандартных навыков и когда они применяются.
- [Поиск по каталогу](CATALOG-SEARCH.md) — `kodo list --search`.
- [Добавление компонентов](COMPONENTS.md) — формат `registry.json` и новые компоненты каталога.

### Исполнение задач

- [Исполнение задач](RUNTIME.md) — подготовка проекта, режимы, план, маршрутизация, сбои, аудит и доставка.
- [Project Director](PROJECTS.md) — offline backlog и foreground execution.
- [Контекст, вывод и очередь](EFFICIENCY.md) — компактный контекст и непрерывная очередь готовых задач.
- [Research knowledge](KNOWLEDGE.md) — локальные знания и история источников.
- [Парный benchmark](BENCHMARK.md) — сравнение Kodo и native-клиента.

### Проверки и безопасность

- [Ступени CI](CI.md) — L0–L3 и обязательная полная проверка.
- [Affected graph и кеш](AFFECTED-CACHE.md) — выбор затронутых проверок и приватный кеш команд.
- [CI profiler](CI-PROFILER.md) — измерение локально выполненных команд.
- [Языковые проверки качества](QUALITY.md) — профили для поддерживаемых языков.
- [Architecture Guardian](ARCHITECTURE.md) — границы модулей и проверяемые контракты.
- [Ключи и границы доверия](SECURITY.md) — подписки, секреты и изоляция workers.
- [Инструменты UI и локальной проверки](UI-TOOLS.md) — пины, лицензии и setup.
- [Статистика registry](REGISTRY-STATS.md) — контракт JSON и счётчики.

## Решения (ADR)

- [0001 — аудит инструкций и квитанций запуска](decisions/0001-run-audit-evidence.md)
- [0002 — UI/security gates и ограниченный контекст](decisions/0002-ui-security-and-progress.md)
- [0003 — режимы исполнения и парное измерение](decisions/0003-execution-modes-and-benchmarks.md)
- [0004 — компактный контекст и непрерывная очередь](decisions/0004-context-output-and-ready-queue.md)
- [0005 — профили качества](decisions/0005-language-quality-profiles.md)
- [0006 — ступени CI и ёмкость пяти сессий](decisions/0006-tiered-ci-and-parallel-capacity.md)
- [0007 — границы Architecture Guardian](decisions/0007-architecture-guardian.md)
- [0008 — durable Project Director](decisions/0008-project-director.md)

## Архив проверок и журнал разработки

Исторические квитанции: SHA, run ID, тайминги и точные команды. Они фиксируют, что и когда было проверено, но не описывают текущее поведение лучше руководства.

- [Проверки Kodo](archive/VALIDATION.md) — квитанции проверок, release lifecycle и интеграционные прогоны.
- [Тесты и затраты на Windows](archive/WINDOWS-TEST-SPEED.md) — замеры полной suite и обоснование порядка файлов.
- [Roadmap](kodo-roadmap/progress.md) — прогресс этапов, [baseline](kodo-roadmap/BASELINE.md), [MVP scope](kodo-roadmap/MVP-SCOPE.md), [следующие этапы](kodo-roadmap/NEXT-STAGES.md) и отчёты этапов `kodo-roadmap/phase-*.md`.

## Разработка Kodo

```powershell
npm ci
npm run test:fast     # быстрые модульные тесты, меньше минуты
npm run format        # Prettier для собственного JavaScript
npm run lint          # oxlint, предупреждения запрещены
npm run typecheck     # tsc --checkJs против baseline известных диагностик
npm run check         # validate + format:check + lint + typecheck + полная suite
```

`npm run check` — обязательная проверка, её выполняет CI на Linux и Windows. Полная suite в основном интеграционная и идёт около 20 минут; `test:fast` даёт обратную связь при правке, но не заменяет её.

`typecheck` работает как храповик: новые диагностики `tsc --checkJs` валят проверку, а исправленные требуют `npm run typecheck -- --update`, чтобы baseline (`scripts/typecheck-baseline.json`) только уменьшался.
