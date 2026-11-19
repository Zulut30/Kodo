# Этап 12: операционный отчёт по Run и Project

Статус: **ACCEPTED** — [PR #22](https://github.com/Zulut30/Kodo/pull/22) влит в `main` коммитом `a72326f` 2026-11-18; CI Windows и Linux и `kodo/review` — SUCCESS. Проверки, раунды независимого ревью и ограничения — в описании PR.

## Что сделано

| Scope из [плана](NEXT-STAGES.md) | Реализация | Проверка |
| --- | --- | --- |
| ① агрегация, схема, provenance | `runtime/telemetry.mjs`: `buildRunReport`, `buildProjectReport` поверх сохранённых Run, событий, `sessionAttempts`, операций координатора и доставки, событий очереди jobs и снапшота проекта | `tests/telemetry.test.mjs` |
| ② CLI, экспорт, документация | `runtime/report-cli.mjs`: `kodo report RUN_ID [--json]`, `kodo report --project PROJECT_ID [--json]`, алиас `kodo project report PROJECT_ID [--json]`; [OBSERVABILITY.md](../OBSERVABILITY.md) | `tests/report-cli.test.mjs`: неверные аргументы до открытия состояния, `KODO_HOME` не меняется ни в одном байте, подпроцесс под offline-guard без сетевых и провайдерских попыток |

## Правила отчёта

- Только чтение: SQLite открывается read-only (без незаписанного WAL — `immutable`), `Store` не открывается, миграций нет, провайдеры не запускаются.
- Неизвестное остаётся `null`; рядом с суммами — `known`/`total`. Неудачные и незавершённые попытки входят в знаменатель.
- Prompt bytes не токены, elapsed не чистая задержка модели; наблюдения с разных платформ перечисляются, «победитель» не выбирается.
- Ошибки и блокеры — только коды, без текстов и путей.

## Ограничения

- Engine не сохраняет длительность команд проверки, поэтому стадия verification и `verificationShare` обычно `null` (`provenance.limitations: check_duration_not_recorded`).
- Ожидание в очереди jobs наблюдается только при `scheduler: durable`.
- Kodo не сохраняет момент готовности проверок CI, поэтому `waitMs` ожидания CI и очереди доставки — `null`; время между первым и последним сохранённым опросом выводится отдельно в `measuredMs` и в итог не входит.

## Что не сделано

Benchmark-кампании plain-vs-Kodo, статистические победители и точная стоимость подписок — отложены пользователем (MVP-SCOPE).
