# Этап 06 — Project Director

Функциональный MVP реализован. Окончательная приёмка и актуальные checks конкретного кандидата отражены в [PR15](https://github.com/Zulut30/Kodo/pull/15) и связанных Windows/Linux CI. Этот отчёт описывает поведение и границы; исторические receipts ниже не переносят PASS на новый head. [Следующие этапы 07–13](NEXT-STAGES.md) — только план; код 07 начинается после принятия 06.

## Реализовано

- Durable `Project → Milestone → Epic → Task → Attempt` рядом с legacy Run: additive SQLite migration, WAL-consistent backup, coherent snapshots/history, CAS и idempotent replay.
- Bounded DAG horizon учитывает принятые зависимости, проверенные interfaces и актуальное revision-bound risk approval. `plan` — dry-run без резервирования Attempt и запуска Engine.
- Foreground-выполнение одной Task через существующий Engine; reservation/atomic Run install переживают restart без дубликата Run. Lease исключает второго controller. Saved mode/fixed model, provider/session/quota и меньшие бюджеты сохраняются при resume/retry.
- Pause блокирует новые starts/advancement, сохраняя active session. Cancel сначала сохраняет control и owned Run flag, затем передаёт отмену Engine; исторические blocked/failed/cancelled Attempts сохраняют revision, contractHash и evidence после reprioritize. Accepted/released history не переписывается.
- Trusted authorizer проверяет actual bindings, source/head/config, checks, review, criterion mappings и enabled gates; Store повторяет CAS/control/binding checks в write transaction. Prose и `verified:true` не заменяют proof.

CLI: `create/status/plan/resume/cancel/pause/reprioritize/approve-risk`; strict args, bounded безопасный вывод. Config задаёт mode/model/concurrency; новых Project CLI flags для них нет. [PROJECTS: API и примеры](../PROJECTS.md), [ADR-0008](../decisions/0008-project-director.md).

## Ограничения

Typed collections ≤1000, глубина ≤16, raw safety budget 32 MiB; horizon 1–24 с меньшим mode/project cap. Обязательный task input ≤12000 UTF-8 bytes, иначе `split_required`, без обрезания acceptance. GPT/Claude — подписочные клиенты; credentials вне Git/prompts/workers/logs.

Source fences проверяют tracked bytes, включая hidden edits, links/stat/size и HEAD; fresh filter-config guards и обе границы сохранены. Все 183 pinned skill resources проверяются заново без success cache. Timeout/cancel дают очищенное partial evidence и incomplete receipt, не PASS.

Принятые Task **не принимают контейнеры автоматически**: Epic/Milestone/Project требуют собственные criterion mappings/evidence. CLI пока не импортирует container proof — его предоставляет trusted coordinator integration. Даже после всех Task возможен `own_proof_missing`; Released дополнительно требует publication chain. Daemon и сложный priority UI вне MVP. Rust Git CLI и Hearthstone analytics — source-only synthetic orchestration examples, не готовые продукты и не bundled package resources; offline observations не подтверждают native/domain behavior.

## Доказательства и приёмка

**Датированный BASELINE до ресурсной коррекции, 5 ноября 2026:** source `6dfedcad…` имел Windows/Linux SUCCESS в [CI42042356804](https://github.com/Zulut30/Kodo/actions/runs/42042356804), но локальный full остановился по timeout 1200479 ms с incomplete receipt. Это история кандидата, а не текущий verdict.

Одна неизменённая восьмифайловая подвыборка дала 30/30 PASS при 4 за 180896 ms и при 8 за 113540 ms. Добавлен небольшой test-file selector: 8 при конечных parallelism≥16/freeMemory≥4GiB, иначе 4; explicit 1–8 приоритетен. Независимые проверки: RED 3 PASS/28 FAIL → GREEN 31/31; восемь разных child PID, 11 файлов ровно по одному разу, bounded admission/drain. Это не whole-suite/model benchmark. Полный набор, порядок, isolation, assertions, frozen oracles, failure/cancel и 20-минутный deadline сохранены. [Контракт и scoped evidence](../WINDOWS-TEST-SPEED.md).

Процесс приёмки через PR15 требует exact-head full check, fresh enabled gates, независимое review, required Windows/Linux CI/installed smoke и protected merge. Актуальный результат фиксируют PR и его checks, а не этот исторический снимок. UI disabled нейтрален. Native client, опубликованный артефакт, release/tag/deployment этим scoped исправлением не подтверждаются; финальный Release предусмотрен только этапом 13.

Урок: terminal history независима от текущей revision; container proof проверяется отдельно от task count. Реальные CPU/memory boundaries и PID barrier не заменяют полную приёмку.
