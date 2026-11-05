# Этап 05 — Research knowledge

2026-11-05. **IN PROGRESS, NOT ACCEPTED**. Предпосылка04 принята: [PR13](https://github.com/Zulut30/Kodo/pull/13), merge `a6740910373186f823c6c207804762f333c26031`. Здесь только scoped local evidence05; общий check/security/independent review/required Windows/Linux CI ещё **pending**.

## Результат и критерии MVP

| Требование | Реализация / проверяемый сценарий |
| --- | --- |
| Структурированные domain/product/technical/codebase claims | A: strict records, canonical id/fingerprint, provenance, latest revision, TTL/version/HEAD invalidation, сопоставимые конфликты |
| Durable provenance/history | B: atomic SQLite captures/revisions, source.id→locator, replay без нового capturedAt, readonly reader без создания legacy DB/tables |
| Owned offline refresh | C: fixed current files, clean tracked sources, JSON Pointer/hash/ESM exports, standard Engine evidence вне Git, requests0 |
| Bounded typed references | D: whole-record UTF-8 budget, deterministic relevance, excluded/omitted counts; текст остаётся untrusted data |
| Реальные CLI/Engine callers | E: status/refresh/inspect с actual A/B/C/D; fresh context/evidence, off byte identity, legacy envelope и lower budgets |
| Воспроизведение | H: временный Git fixture, отдельный KODO_HOME, 18 actual CLI observations без внешних вызовов |

Frozen ports v1 SHA-256 `72f8670725e0217b67b619c24ed822ecf2f0452231e0c628cc58eece0990a52d`; final root clarifications приоритетнее proposal. [Policy/context, схемы, команды, доверие и решение](../KNOWLEDGE.md), [runtime](../RUNTIME.md#структурированное-knowledge-offline-mvp05).

MVP не добавляет broad live market/domain study, embeddings, универсальный semantic fact checker или новую parser dependency. Legacy discovery research остаётся отдельным. Hearthstone Standard/Wild/BG и Rust VCS — **synthetic fixtures**, без настоящих статистик; sample/population/window неизвестны. Rust fixture проверяет JSON, не native Rust.

## Scoped evidence и текущая граница

Прочитаны actual completions/coordinator records в private `speed-five/coordination/phase05`. A:62/62 PASS; B:14/14 плюс2 legacy Store/lease; C:21/21; D:16/16. E интегрирован как dependency `5257806e4dc2ccef500ef8621aee34d1401bdc72`: scoped48/48, затем post-integration5/5 с пересечением — **не53 уникальных теста**. Это результаты scoped workers, не новый прогон H и не общий PASS05. Provider в E — fixture.

H worktree source head `19bab3c32d5e496687b2c5db037cff495fc5471c`; Windows x64, Node24.19.0/ABI137. CLI продемонстрировал disabled без Store, refreshed/replayed с прежним capturedAt, changed replay blocked, TTL stale, conflict, version mismatch/missing current version, malformed metadata/dirty source blocked и tamper excluded. Все18 наблюдений: requests0; private Node network guard: attempts0. Hearthstone в matching format остался unknown/references0, synthetic Rust JSON дал одну synthetic-reference до намеренного tamper.

Exact argv/raw outputs/exits/source hashes и fixture сохранены вне Git: `C:/Users/zulut/AppData/Local/Temp/kodo-roadmap-20261104/phase05-receipts/knowledge-docs/observations.json`. В [KNOWLEDGE](../KNOWLEDGE.md#воспроизведённые-offline-команды-и-ограничения) указаны private reproduction и первая ошибка harness до старта продукта; она не засчитана как product RED. Репозиторные tests/full suites H не запускал.

F условно изменил test-file ceiling4→8. В полном прогоне координатора обнаружены FAIL в неизменённых setup и concurrency-five; проба консервативно отменена до 4. Причинная связь порядка стартов scheduler с ресурсами/потолком не установлена. Native workers 5, тела/assertions/timeouts/skips старых тестов сохранены; ускорение не заявляется. Диагностика и границы — [EFFICIENCY](../EFFICIENCY.md).

Bounded repair от исходного `86608056288d64f49a01e1ef380bb7bf2bf09386`: missing original project оставляет optional KB off без подстановки cwd; default-absent policy не проверяет worker snapshot; добавочная bounded page связывает total/complete и не более limit тел одним SQL-снимком до оценки/проекции; числовые version keys хешируются лексически как в claims/Store. `maxClaims:1` допускает singleton, но два отдельных конфликтующих captures блокируют inspect/проекцию с `knowledge_incomplete`, сохраняя меньший cap. Шесть новых регрессий: исходный RED 0/6, после ремонта GREEN 6/6. Приватные команды, raw stdout/stderr, исходные snapshots и hashes: `C:/Users/zulut/AppData/Local/Temp/kodo-roadmap-20261104/phase05-receipts/integration-repair-1`. Это scoped local evidence, не общий PASS05.

После ремонта один scoped прогон `node --test --test-concurrency=4 tests/knowledge-cli.test.mjs tests/knowledge-integration.test.mjs tests/knowledge-refresh.test.mjs tests/knowledge-store.test.mjs tests/setup.test.mjs tests/concurrency-five.test.mjs`: 74 теста, 73 PASS, 0 FAIL, 1 прежний POSIX-only SKIP, exit0; Windows x64, Node24.19.0/ABI137. Исходные setup/concurrency-five byte-identical, включая порядок/assertions/timeouts; fake native sessions и CLI с isolated credential homes/empty ports не доказывают живой подписочный клиент. Новые 6 тестов входят в эти 74, результаты не складываются. Полный suite, enabled security, Windows/Linux CI и artifact smoke этим ремонтом не запускались; UI disabled — neutral.

## Оставшаяся приёмка и урок

Координатору нужны integrated clean head после всех deliverables, полный `npm run check`, fresh configured security, независимый differential review и required Windows/Linux CI с artifact smoke на том же кандидате. UI и selfhost architecture disabled — neutral, не PASS. Installed/published artifact05, real native subscription client, release/tag/deployment здесь не доказаны; historical04 evidence на05 не переносится.

Known-credential gap исправлен локально. Root independent `C:/Users/zulut/AppData/Local/Temp/kodo-roadmap-20261104/phase05-known-secret-green.json` и соседний `phase05-known-secret-verification.log` привязаны к `5e9ae584cc5c63df4ca85078f74ca0f3a1a7eeb0`: known-at-refresh → blocked/knowledge_secret, stored claims0; ранее неизвестное значение после признания credential → inspect blocked; оба leak=false, прежняя запись истории сохранена1. CLI лениво получает coordinator-only credentials после arguments/enabled-policy checks; inspect отвергает строки до evidence/evaluation/вывода, не переписывая историю и hashes. Это только fake-only local CLI/SQLite proof, без реальных ключей/API; raw externalRequests0 был константой, не измерением HTTP. H18 остаются историческими наблюдениями `19bab3c…`, без повторного запуска. Current-source full check/security/independent review/CI всё ещё pending; native client, UI (disabled), published artifact/release/deployment не подтверждены.

Явный standard и сохранённые concurrency5/maxTasks12/repair3/research10 остаются верхними границами; меньшие project/run/byte limits не расширяются, resume/retry не повышает режим. GPT/Claude — только подписочные клиенты, без API fallback; workers не получают ключей.

Урок: capture replay не обновляет наблюдение, успешный inspect не означает authoritative claim. Проверяйте state/reasons/projection и missing sample/population/window отдельно; записанная instruction policy не доказывает семантическое применение методики. [Прогресс roadmap](progress.md).
