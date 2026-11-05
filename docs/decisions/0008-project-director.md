# ADR-0008: durable Project Director рядом с legacy Run

Статус: frozen решение для MVP06; реализация интегрирована локально, общие full/security/review/CI gates **pending**. Приёмка и доставка06 этим ADR не утверждаются. Предпосылка05 принята через [PR14](https://github.com/Zulut30/Kodo/pull/14), merge `72215c821ea8d2be32123e8212bdc3d22cd526f1`.

## Контекст

Один Run имеет ограниченный план и собственные worktrees/sessions/budgets/gates. Для длинного проекта нужны backlog, зависимости, повторные попытки и восстановление без превращения1000 Task в один prompt. При этом нельзя переписывать legacy state или принимать результат по модельному «completed». [CLI, API и ограничения](../PROJECTS.md), [приёмка06](../kodo-roadmap/phase-06.md).

## Решение и альтернативы

| Выбор | Альтернатива и причина отказа | Последствие |
| --- | --- | --- |
| Versioned Project/Milestone/Epic/Task/Attempt в additive namespaced SQLite tables существующего Store | Отдельная DB/новый scheduler потребовали бы второй atomic boundary; замена legacy Run нарушила бы прямых callers | Свой migration registry без `user_version`; Node SQLite WAL-consistent backup до atomic migration, legacy bodies/default I/O сохранены |
| Общие strict normalizers и schema-order bytes/hash в `project-contracts` | Отдельные похожие схемы/канонизаторы расходятся на ключах/порядке и связывают разные task inputs с одним binding | Recursive raw known-key/value/PEM/redaction safety до hash/write/output; фиксированная TaskContract и immutable Project context;12000-byte cap требует split |
| CAS/idempotent commands и атомарный reservation→legacy Run install | Создать Run до binding либо доверять новому runId после restart — риск orphan jobs/двойного исполнения | Повтор одинаковой команды возвращает историю; изменённый payload отвергается; revision/task hash/binding/control проверяются внутри BEGIN IMMEDIATE |
| Полный coherent snapshot и bounded pure DAG horizon | LIMIT без total/complete создаёт ложную полноту; один огромный план расширяет бюджеты | До1000 backlog records, горизонт1–24 с меньшим mode/config cap, complete counts в той же read transaction, risk approval привязан к Task revision |
| Trusted asynchronous transition authorizer до transaction плюс синхронная повторная проверка Store | `eligibleStates`, `verified:true`, structural Ref или completion prose не доказывают filesystem/current-head/gates | Default-deny external-fact forward transitions; validate фактический bound Run, exact-head checks/review, awaited enabled gates; нет await внутри write transaction |
| Own mapped proof каждого контейнера; verified publication chain для released | Автоматически принять parent по числу accepted children или Task success receipt — подмена его требований | Все children должны быть приняты, собственные mappings обязательны; disabled нейтрален. CLI без container-proof input может остаться blocked после всех Task |
| Один foreground Task→существующий Engine, отдельная project lease | Daemon/универсальный orchestration framework расширяют MVP, модели процессов и security scope | Нет background drain. Pause останавливает последующий admission/advancement, сохраняя active Run/session; cancel/lease loss сохраняют abort semantics. Quota/restart используют тот же Attempt; explicit retry создаёт следующий с прежними меньшими limits |

## Проверка и границы

Координатор зафиксировал и исправил ранние runtime регрессии: freshness risk/interfaces повторяется перед reserve/install/dispatch, pause не отменяет активную подписочную session. Scoped группы A20/B34/C21/D67/E14, oracle23, legacy3, F16, correction retry5 и selected oracle/CLI28 пересекаются; это не сумма уникальных тестов и не общий PASS06. Полные evidence остаются приватными.

Documenter проверил две source templates через14 actual offline create/status/plan observations на `3817af8…`, с temporary owned Git roots и изолированными пустыми credential/state homes: schema valid, deterministic blocked dependencies, replay без дубликата, revision/Attempts неизменны после plan. Exact reproduction и ограничения — [PROJECTS](../PROJECTS.md#два-шаблона-и-воспроизведённый-smoke). Реальные Rust/Hearthstone продукты, providers, native/UI, full gates, публикация и deployment не проверялись.

Цена решения — ручные evidence mappings и консервативный blocked при недоказанных interfaces/head/config/children. CLI не предоставляет произвольный importer/edit API контейнеров. Sophisticated priority UI, daemon, автоматический importer и swarm оставлены следующим этапам; никакого API fallback для GPT/Claude.

Урок: свежая проверка при первоначальном plan не разрешает более поздний reserve/dispatch, а pause не является cancel. Сохранять эти границы отдельными runtime regression checks и проверять актуальные criteria/ref/Task revision перед каждой сменой владения. Исторический успешный check/instruction audit не заменяет текущие head-bound gates.
