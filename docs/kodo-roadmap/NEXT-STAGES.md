# План Kodo 07–13 после завершения06

**PLAN ONLY. Код07 не начинается.** Основа: [согласованный MVP](MVP-SCOPE.md) и исходные сценарии07–13. Частные scope T3/Orca и OpenCodeReview/ai-memory изложены ниже; это планы адаптеров, не доказательство доступности. Draft07 сверяется с merged06.

**Вход:**06 принят и PR15 merged; сохранены история остановленных попыток, pending repair и бюджеты. До этого — только подготовка. Этапы07→13 принимаются последовательно. Для07 после merge — анализ Gemini и контракты.

**Общий gate каждого этапа:** scoped RED/GREEN без API → один интегрированный `npm run check` замороженного head → свежие включённые security/прочие gates и независимое ревью → обязательные Windows/Linux CI и установленный CLI smoke того же кандидата → защищённый PR/merge. До13 доставка только через PR, без Release. Проверки допускается переиспользовать только при точном совпадении clean head/команд/runtime/config/pins; disabled/unknown не PASS.

Стек Node24/ESM/SQLite/node:test; без второго оркестратора. Внутри этапа —2–5 независимых scopes, один владелец Engine/CLI wiring. Предикаты проверяются fixtures, Git/SQLite/Engine — на необходимых границах. Полные проверки и доставка принадлежат координатору.

## 07. Надёжные jobs и управляемая параллельность

**Результат:** durable jobs поверх существующих очереди, worktrees и subscription leases; явные состояния/ownership, scoped admission, recovery и запрет двойной интеграции. Host — отдельная сущность от модели.

**Независимые scopes:**① JobSpec/admission + read-only jobs CLI;② SQLite jobs/leases/CAS/receipts;③ адаптер существующей очереди и последующее wiring Engine;④ независимые защищённые concurrency/recovery fixtures. T3/Orca пока только capabilities/identity: неподключённый host возвращает unavailable, не молча native fallback.

**Зависимость:** accepted06; сохранить Project binding, legacy native путь, fixed/both и меньшие сохранённые лимиты.

**Быстро:** fake-provider barriers1/2/4/8, одна реальная Git/SQLite цепочка. **Приёмка + общий gate:** prerequisite именно integrated перед dependent; конфликтующие scopes сериализованы; lost lease/cancel/quota/restart и uncertain merge не дублируют исполнение/интеграцию. Управляемое перекрытие подтверждено fixture, без общего заявления об ускорении. **Позже:** adaptive load/CI scaling, daemon, распределённый fleet.

## 08. Контекст, бюджеты и host adapters

**Результат:** bounded ContextManifest с обязательным contract/acceptance, freshness/head/provenance; простой low-risk fast path; устойчивые лимиты sessions/attempts/research. Настоящие T3 Code/Orca адаптеры и управляемый TokenEconomizer.

**Независимые scopes:**① manifest/interface cards/invalidation;② fast path + persisted budget admission, один Engine bridge;③ T3 install/launch/lifecycle adapter;④ Orca adapter;⑤ перенос уже staged TokenEconomizer с текущими receipts и точечной повторной проверкой. Готовое переносится без переписывания.

**Зависимость:**07 jobs/backend boundary. Hosts используют существующий worktree, официальные интерфейсы, явные host/native IDs и только signed-in Codex/Claude; без GUI, клиентских БД и дублирующей изоляции.

**Быстро:** offline protocol fixtures, обязательный текст переживает truncation, injection/invalidation/secret negatives; доказанно локальная CSS-задача обходится без Gemini/Jev/research, сомнение возвращает обычный маршрут. **Приёмка + общий gate:** resume/параллельность не расширяют caps; usage отсутствует→null. Координатор проводит ограниченный host/utility pilot; окончательный lifecycle —13. TokenEconomizer сначала observation: envfacts/propose/loopguard off, history/repomap off; активные hooks/injection заявлять только после наблюдения поддерживаемого пути, без скрытых model jobs. **Позже:** learned routing, широкое semantic indexing, cost/token benchmark campaigns.

## 09. Независимая проверка поведения

**Результат:** компактная risk/QualityPolicy, baseline→final evidence и независимый behavioral oracle; подтверждённый дефект запускает ограниченное исправление. OCR лишь готовит материалы существующему подписочному reviewer.

**Независимые scopes:**① policy/head/config/pin identity;② защищённые behavioral/negative fixtures;③ baseline + repair wiring;④ pinned OpenCodeReview `delegate preview/rule` JSON adapter с telemetry off и приватным config/env.

**Зависимость:**08 manifest/budgets; существующие проверки остаются обязательными. **Быстро:** компилируется-но-неправильно, ослабленный oracle, stale receipt, фальшивый review и невыполненный gate дают отказ; маленький Git oracle использует установленный Git. **Приёмка + общий gate:** независимый oracle действительно RED до исправления; reviewer/read-only и oracle различаются; OCR не вызывает upstream review/scan/API/OAuth и не публикует комментарии. **Позже:** большие mutation/fuzz кампании, универсальная матрица языков, дорогие evolution gates на каждый PR.

## 10. Прогресс, остановка и полезная память

**Результат:** durable verified progress/watchdog с конкретным текущим blocker и recovery summary; cosmetic/no-progress не закрывает acceptance. ai-memory — необязательная поисковая проекция проверенных lessons.

**Независимые scopes:**① критерии прогресса/watchdog state;② восстановимые summaries/status, отделение старого error от текущего blocker;③ coordinator-only ai-memory MCP query/read/write adapter с provenance/CAS и ограниченным выводом.

**Зависимость:**09 evidence policy и существующая SQLite authority. **Быстро:** повторяющийся анализ не даёт прогресса; порог/бюджет переживает restart; независимая задача продолжает работать; восстановленный старый error не стирает историю. **Приёмка + общий gate:** watchdog не меняет код/доставку сам; ai-memory не заменяет Run/Project/Attempt, использует явный project scope, private authenticated endpoint, `embedding_provider=none`; без setup/run/autowire/history capture, клиентских auth-файлов и любого model backend. **Позже:** maintenance fleet, автоматические dependency upgrades, dashboards/health scoring.

## 11. Доставка без повторных внешних действий

**Результат:** усиление существующих merge/release queues: job→operation receipt, recovery после uncertain remote side effect, точное соответствие commit/tag/package/checksum/installed smoke. Сначала аудит существующего; реализовать только отсутствующее.

**Независимые scopes:**① ownership/head/dependency admission;② remote reconciliation/idempotency и fixtures;③ immutable package/migration-backup contracts и документация восстановления.

**Зависимость:**10 recovery; coordinator delivery ownership. **Быстро:** локальные Git/HTTP fixtures для timeout-after-upload, double-publish, stale CI/tag/checksum, failing installed CLI и несовместимой миграции. **Приёмка + общий gate:** read-back прежде повтора; защиты веток сохранены, более старый результат не заменяет новый. Реальный Release здесь не публикуется. Deployment без adapter→not_configured. **Позже:** generic canary/rollback/multi-environment deployments, сложный batch merge.

## 12. Операционный отчёт вместо новой benchmark-кампании

**Результат:** read-only CLI/JSON отчёт по Project/Run/stage: wall/queue/CI waits, attempts/sessions, фактический usage и полнота наблюдений, неудачи и блокеры.

**Независимые scopes:**① агрегация/schema/provenance;② CLI/экспорт/документация. **Зависимость:**11 сохранённые operation receipts; использовать существующие metrics/events, не новый сборщик с daemon.

**Быстро:** mixed historical/null usage, failed/pending в знаменателе, неполные samples и разные OS/runtime не смешиваются в «победителя». **Приёмка + общий gate:** отчёт не запускает модель/провайдера; prompt bytes ≠ tokens, elapsed ≠ чистая LLM latency; unknown не превращается в0. **Позже:** все plain-vs-Kodo/model/budget/cost benchmark campaigns, статистические победители и точные subscription USD.

## 13. Сквозная приёмка и единственный финальный выпуск

**Результат:** проверенный CLI-пакет GitHub Release и честный итог требований/evidence, без имитации deployment.

**Независимые scopes:**① bounded исполняемые A–F smoke/negative fixtures исходных prompts: CSS, mini Rust/Git и milestone backlog>24 с малым окном, Hearthstone seed/provenance, плохие изменения/сбои/совместимое расширение;② coordinator-owned native acceptance/receipts: Codex, Claude, both, restart/quota и существующие T3/Orca IDs без второго worktree;③ package/Windows/Linux installed acceptance;④ лицензии/README/FINAL-REPORT. Синтетические evolution изменения не мерджить.

**Зависимость:**01–12 приняты; исходные сценарии ограничены MVP, обязательные недоступные возможности остаются BLOCKED/NOT RUN, не скрываются. **Быстро:** заранее готовые offline fixtures, без новых платных benchmarks. **Приёмка:** общий gate точного final head; ограниченные реальные подписочные/host smokes и поддерживаемые TokenEconomizer hooks/injection с наблюдаемыми receipts; чужую историю не трогать, архивировать только собственные worker chats поддерживаемым способом. Неподдерживаемый Orca archive не заменять удалением worktree.

Только координатор после этих gates делает protected merge, версию/tag, `.tgz`+SHA256+notes, read-back GitHub Release и smoke именно скачанного/установленного артефакта. В npm не публиковать. Отчёт различает local/CI/native/installed/published/deployed; отсутствующий deployment→not_configured, отсутствие доказательства hooks/экономии→unknown. **Позже:** extended soak, native SDK/platform matrices, полные доменные системы, benchmark campaigns.

План не запускает работу и не меняет приёмку.
