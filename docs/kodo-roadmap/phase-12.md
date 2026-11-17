# Этап 12: операционный отчёт по Run и Project

Статус на 2026-11-17: **реализация завершена, кандидат на приёмку.** Ветка `kodo/12-observability`. Проверки замороженного head, ревью и CI — в описании PR этапа.

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
- Окно ожидания CI, прерванное процессом, включает простой до следующего события.

## Что не сделано

Benchmark-кампании plain-vs-Kodo, статистические победители и точная стоимость подписок — отложены пользователем (MVP-SCOPE).
