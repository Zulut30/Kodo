# Этап 06 — Project Director

Функциональный MVP реализован; приёмка06 после текущей коррекции порядка pending. Окончательная приёмка и актуальные checks конкретного кандидата фиксируются в [PR15](https://github.com/Zulut30/Kodo/pull/15) и связанных Windows/Linux CI. Этот отчёт описывает поведение и границы; исторические receipts ниже не переносят PASS на новый head. [Следующие этапы 07–13](NEXT-STAGES.md) — только PLAN; их реализация не начата, код 07 начинается после принятия 06.

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

Одна неизменённая восьмифайловая подвыборка дала 30/30 PASS при4 за180896ms и при8 за113540ms. Automatic8 selector имел scoped RED3 PASS/28 FAIL → GREEN31/31 и восьми-PID barrier, но полный локальный check source `e69797cc…` остановился по 20-минутному timeout: Director37 PASS/1 CANCELLED (`testTimeoutFailure` неизменённого pause case60s). Automatic8 отозван, default всегда4; explicit1–8 остаётся opt-in. Selector и только новые obsolete pure-resource tests удалены, исходный default4 barrier восстановлен. Новая mock-high-resource regression с реальными PID дала RED `8 !== 4` → GREEN; восьми-PID opt-in, CLI range, полный набор/порядок, isolation, старые assertions, три frozen oracle, failure/cancel/deadlines и native/model/saved limits сохранены.

Dev CLI использует same-install core Git только после native canonical/regular-file checks и bounded совпадающих metadata probes; custom Git/links/missing/mismatch/error сохраняют env. Меняется лишь PATH runner/children, с прежними casing/tail; global PATH/auth/config, runtime gitBoundary и guards прежние. Helper не поставляется в пакете. Один неизменённый pause case:255 Git25.722s из31.351s → тот же core255 Git17.050s из23.071s, обаPASS. Это startup hot path observation, не whole-suite benchmark. Текущие scheduler/Git/package scoped tests:56 PASS,0 FAIL/cancel,2 file-symlink SKIP из-за прав Windows; directory-junction escape и реальный установленный Git metadata/status PASS. Full текущего head/gates/review/CI остаются у Root; общего PASS нет. [Контракт и сырые scoped evidence](../WINDOWS-TEST-SPEED.md).

**Текущая коррекция порядка source821:** прежний full `821eec5a81b4e20715cc7c99a129a8be00d604d8` остановился по timeout1200535ms: 66/83 completed-file observations, остальные17 без финальной длительности. Новый статический порядок использует все19 фактически завершённых файлов ≥90s из receipt `c9b54c3c…` по убыванию, затем scheduling100233.5395ms как отдельную **нижнюю границу11/12 случаев**, затем три сохранённых лёгких приоритета. Benchmark теперь имеет текущий file observation200519.1471ms; прежние измерения — история. Независимое expected order зафиксировано до runner: assertion RED exit1 → GREEN exit0. Реальный старт коротких child-фикстур включает поздние major files и ранний лексический light file. Одна scoped scheduler/Git/package suite на Node24.22.1:56 PASS,0 FAIL/cancel,2 существующих file-symlink SKIP из-за прав Windows, exit0. Все83 файла/default4/explicit1..8/hard8/isolation/assertions/deadlines и frozen3 сохранены; cache отсутствует. [Mapping, команды и private evidence](../WINDOWS-TEST-SPEED.md#текущая-scoped-коррекция-source821-5-ноября-2026). Actual ordering proof ограничен scoped fixtures; полного AFTER, whole-suite gain и принятия06 нет.

Процесс приёмки через PR15 требует exact-head full check, fresh enabled security/architecture gates, независимое review, required Windows/Linux CI/installed smoke и protected merge; это pending у Root. Актуальный результат фиксируют PR и его checks, а не этот исторический снимок. UI disabled нейтрален. Native client, опубликованный артефакт, release/tag/deployment этим scoped исправлением не подтверждаются; финальный Release предусмотрен только этапом 13, этапы07–13 остаются PLAN.

Урок: terminal history независима от текущей revision; container proof проверяется отдельно от task count. Успех подвыборки и PID barrier не заменяет полную приёмку default; Git startup оптимизируется только внутри проверенной той же установки.
