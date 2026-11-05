# Этап 06 — Project Director

2026-11-05. **IN PROGRESS, NOT ACCEPTED**. Предпосылка05 принята: [PR14](https://github.com/Zulut30/Kodo/pull/14), merge `72215c821ea8d2be32123e8212bdc3d22cd526f1`. Code/CLI и admission/pause correction интегрированы в source `3817af81796803fe3311e44e7d3e3b4a79425c4f`. Общие full checks, enabled security, final independent review и required CI06 остаются **pending**.

## Результат и критерии MVP

| Требование | Реализация / проверяемый сценарий |
| --- | --- |
| Durable hierarchy рядом с legacy Run | Strict Project/Milestone/Epic/Task/Attempt, revision-bound risk approval, общие schema-order bytes/contract hash; legacy callers без нового default I/O |
| Recovery/idempotency | Additive SQLite migration с actual consistent WAL backup; coherent complete snapshots/history, CAS/replay, atomic reserved Run install; crash не дублирует Run |
| Ограниченный следующий горизонт | Полный DAG до1000 Task,1–24 horizon с меньшим mode/project cap; accepted dependencies, verified interfaces, approval; mandatory task input≤12000 UTF-8 bytes или split_required |
| Evidence-based acceptance | Trusted awaited authorizer, current bound Run/head/config/checks/review/gates, own criterion mappings; нет JSON eligibility bypass, incomplete не принимается |
| Lifecycle/control | Foreground одна Task→Engine, lease/restart/quota; pause сохраняет active Run/session, cancel сохраняется до forwarding, fresh admission перед reserve/install/dispatch |
| CLI | create/status/plan/resume/cancel/pause/reprioritize/approve-risk; strict args, bounded safe output и exit0/1/2 |
| Примеры | Два source-only synthetic ProjectSpec: Rust Git CLI и Hearthstone analytics; actual owned offline create/status/plan, без реализации продуктов |

Frozen ports SHA-256 `1741c9c19b717a15220b94e4c871911e0f21645abeef600905bdec85760539bf`, включая Root final clarifications. [PROJECTS: схемы/API/config/точные команды/ограничения](../PROJECTS.md), [ADR-0008: решения и альтернативы](../decisions/0008-project-director.md), [runtime](../RUNTIME.md#project-director-mvp06).

MVP не добавляет daemon, sophisticated priority UI или generic framework. Project CLI не принимает mode/model/concurrency flags: config задаётся отдельно, saved Run сохраняет свой выбор; retry не расширяет limits. GPT/Claude остаются subscription-only, keys вне workers/Git/prompts/logs. Released требует проверенную publication chain и нужные released milestones; disabled gate нейтрален.

## Scoped evidence и текущая граница

Координатор сообщил actual scoped группы A20/B34/C21/D67/E14, oracle23, legacy3, F16, correction retry5 и selected oracle/CLI28. Группы **пересекаются**, не суммируются как unique/full tests и не являются общим PASS06. Ранние core runtime regressions сохранены как исторические: исправлены freshness risk/interfaces до reserve/install/dispatch и pause, который сохраняет active Run/session; explicit cancel/lease-loss semantics сохранены. Documenter не повторял эти scoped suites.

H на source `3817af8…`: Windows x64, Node24.19.0/ABI137;14 actual CLI subprocess observations, по7 на шаблон. Сначала absent owned root→exit1/invalid; затем actual temporary Git root: create/replay/status/plan-dry/plan-default/status→exit0. Revision1, Task3, currentAttempts0, status до/после идентичен; Rust выбирает `cli-contract`, Hearthstone — `data-contract`, две зависимые Task blocked. Network/provider guard: attempts0. Это input-validation/offline evidence, не regression suite или native product proof.

Только собственные JSON copies, отдельные empty credential/state/client homes и allowlisted environment, явные knownValues[]/secrets{}. Fixture config quick/maxTasks1/research0/repair1/concurrency1; commands пустые, gates/delivery disabled только у fixtures. Actual Kodo enabled security этим не изменяется. Resume/provider/session/реальные keys не использовались.

Private `C:/Users/zulut/AppData/Local/Temp/kodo-roadmap-20261104/phase06-receipts/project-docs/`: `offline-examples.mjs`, `observations.json` с exact argv/env/raw outputs/exits/source hashes, `offline-run.log`, `source-snapshots/`, `manifest.json`. Первая ошибка harness до CLI (`--import` Windows path вместо file URL) сохранена отдельно, не засчитана product RED. Schema/scope/link проверки documenter записаны в `documentation-check.json`.

Принятые Task **не принимают автоматически контейнеры**: Epic/Milestone/Project требуют own mapped proof. В CLI нет importer/amend evidence/mappings контейнера, поэтому все Task могут быть accepted при blocked Project (`own_proof_missing` и др.). Шаблоны это ограничение сохраняют; empty refs не выдают себя за frozen interfaces. Ни Rust native behavior, ни Hearthstone patch/source/sample/statistics не проверены и не утверждаются.

## Оставшаяся приёмка и урок

Координатору нужны интеграция docs/examples в clean candidate head, полный `npm run check`, fresh configured Semgrep/Gitleaks, независимый differential review и required Windows/Linux CI с installed artifact smoke на том же кандидате. UI verification disabled — neutral; selfhost architecture policy/gates оцениваются по фактическому config, disabled не PASS. Published artifact, release/tag/deployment06 и real provider/native-client check здесь не доказаны. Historical05 receipts на06 не переносятся.

Урок: admission и terminal authorization требуют свежих фактов после plan/restart; pause и cancel различаются по влиянию на active session. Проверяйте критерии/refs/revision на каждой границе, а container proof отдельно от task count. Наличие адаптеров skills остаётся recorded instructions, не semantic compliance. [Прогресс roadmap](progress.md).
