# ADR-0007: границы Architecture Guardian

Статус: решение frozen для реализации MVP этапа 04; A–E интегрированы локально, интеграционная приёмка G/full/security/review/required CI **pending**. Это не release acceptance. Предпосылка: этап 03 принят через [PR #12](https://github.com/Zulut30/Kodo/pull/12), merge `b3304b47ae47fdc8f626e692523761bad7535fa6`.

## Контекст

LLM review не обеспечивает детерминированного соблюдения module ownership, public API, направлений зависимостей и миграций. При этом MVP всех 13 этапов не включает универсальные native-анализаторы или переписывание Engine. Нужен небольшой offline-контракт, который различает старый долг, неподдерживаемую область, план и реально исполненные проверки. [Публичный формат и примеры](../ARCHITECTURE.md), [границы MVP](../kodo-roadmap/MVP-SCOPE.md).

## Решение

Разделить модуль на пять узких портов и отдельный интеграционный gate:

| Граница | Реализация и ответственность |
| --- | --- |
| A: immutable graph | [architecture-graph](../../runtime/architecture-graph.mjs), shared [javascript-dependencies](../../runtime/javascript-dependencies.mjs): Git snapshots, AST ESM, inventory и uncertainty; historical base не обязан совпадать с checkout |
| B: pure policy | [architecture-policy](../../runtime/architecture-policy.mjs): strict versioned policy, ownership/layers/allow/public/forbidden/module cycles, стабильные findings; отдельного JSON Schema файла нет |
| C: declared contracts | [contract-registry](../../runtime/contract-registry.mjs): exports/shape/version/migration history, reverse consumers и требуемые tests; никаких execution/PASS |
| D: debt/protection | [architecture-debt](../../runtime/architecture-debt.mjs): точные unchanged base waivers, injected UTC clock и old/new protected paths; никаких approval полномочий |
| E: composition/runner | [architecture-cli](../../runtime/architecture-cli.mjs), early route в [CLI](../../cli/index.mjs): clean/current actual-byte fence, base/head документы, реальный bounded TAP и private redacted evidence |
| G: integration contract | Engine/config/delivery gate проектируется отдельно от A–E; текущее принятие ещё pending. Enabled freshness связывает source/config/runtime/checker pins/evidence; disabled нейтрален |

A–D не зависят от E/Engine/providers/credentials. E переиспользует существующие delivery.execute, workerEnvironment и source inspector. AST использует существующий Acorn 8.15.0; B валидирует policy собственным strict-нормализатором, без новой зависимости. Policy фиксирована как architecture.policy.json; productRoots отделяет анализируемый продукт от inventory-only tests/docs/vendor. Нельзя ограничиться union module roots: тогда unowned product code был бы невидимым.

Реально поддержаны ESM .mjs/.js type=module. Иные executable languages/loaders и неразрешённые границы явно unsupported/blocked; универсальная AST/native семантика отложена. Пять data-only presets выбираются вручную, не меняют stack проекта и не создают контракты.

Первое enrollment не получает выдуманную старую policy или debt: basePolicyState=absent, baseRulesEvaluated=false. Локальный check может пройти после producer tests, но fullVerificationRequired/requiresReview остаются true. Malformed base не равна отсутствию. Никакой shapeHash не доказывает семантическую совместимость; breaking требует версии/append-only migration и изменённых consumers с тестами. Implementation-only JS выбирает текущие producer/consumer tests без лишней migration, CSS не вызывает unrelated contract tests.

Baseline/exceptions погашают только точный eligible unchanged base finding с owner/reason/reviewAfter; severity не понижается. Контракты, unsupported и protection не погашаются. Union старой/новой защиты не даёт снять review удалением policy. Успешное исполнение требует полного nonzero TAP, exit0 без skip/todo/cancel/fail, текущего clean source и intact evidence; чужая квитанция не заменяет процесс. G должен повторно await-ить freshness и expiry перед review/delivery; это дополняет full checks, security и независимое review.

## Альтернативы и последствия

Универсальный анализатор .NET/Rust/Go/PHP/TSX дал бы больший охват, но требует отдельных parsers/SDK/resolution semantics и platform evidence после MVP. Пропуск неподдерживаемого кода с зелёным статусом отвергнут. Только LLM approval не обеспечивает воспроизводимость; один монолитный Engine checker увеличивает доступ к secrets/state и затрудняет независимую проверку. Snapshot-all baseline превращал бы новые нарушения в разрешённые, поэтому его нет.

Цена решения — ручные policy/registry/tests и консервативные blocked состояния, особенно в смешанных проектах. Нужны реальные native SDK/quality/UI проверки отдельно; узкая JS-проверка не свидетельствует о корректности PHP hooks, Rust VCS или C# UI.

## Связь с проверками

Точные существующие test names (это ссылки на проверяемое поведение, не заявление о новом прогоне всех suites):

- [graph](../../tests/architecture-graph.test.mjs): `Historical graph reads the requested commit while checkout and source differ`; `Product roots include unowned JS while outside tracked sources are inventory only`.
- [policy](../../tests/architecture-policy.test.mjs): `All independent cross-module violations remain visible together`; `Five manual layout starters are normalized valid data with explicit public entries`.
- [registry](../../tests/contract-registry.test.mjs): `Implementation-only producer edits select producer and transitive registered consumer tests without a version bump`; `Complete breaking migration maps transitive consumers and exact frozen required test records`; `Retirement requires existing producer and consumer replacement tests in head`.
- [debt](../../tests/architecture-debt.test.mjs): `Debt cannot manufacture history when the base policy was genuinely absent`; `Protection uses both old and new explicit prefixes and contract paths on additions and deletions`.
- [CLI](../../tests/architecture-cli.test.mjs): `real CLI plan leaves Git index and runtime credential evidence state untouched`; `dirty actual bytes hidden by assume-unchanged and changed explicit head fail closed`; `post execution source mutation and tampered prior evidence block acceptance`.
- Независимый frozen [oracle](../../tests/architecture-acceptance.test.mjs): `Architecture CLI accepts permitted ESM fixture`; `Architecture CLI blocks forbidden import with structured finding despite LLM approval`.

E передал meaningful oracle RED2→GREEN и общий scoped GREEN26/26; H отдельно проверяет настоящие offline-примеры CLI, не запускает repository suite или gate G. [Phase-04](../kodo-roadmap/phase-04.md) фиксирует точные наблюдения и оставшиеся gates.

Урок: immutable historical graph и current checkout fence решают разные задачи. Смешение границ либо запрещает сравнение base/head, либо позволяет принять изменённые фактические байты при неизменном HEAD. Отдельные отрицательные fixtures нужны для обоих случаев; local PASS первого enrollment не следует переносить в утверждение о прежнем compliance или delivery.
