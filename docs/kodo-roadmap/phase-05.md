# Этап 05 — Research knowledge

2026-11-05. **ACCEPTED** по фактическому coordinator checkpoint: [PR14](https://github.com/Zulut30/Kodo/pull/14), merge `72215c821ea8d2be32123e8212bdc3d22cd526f1`. Проверенный и независимо reviewed source head — `a126ffc931ff94939459b54020cd1e2af3f2f6d8`. Это историческая приёмка05, не evidence06 и не новый release/deployment.

## Результат MVP

| Требование | Реализация / проверяемый сценарий |
| --- | --- |
| Structured domain/product/technical/codebase claims | Strict records, canonical identity/fingerprint, provenance, latest revisions, TTL/version/HEAD invalidation и сопоставимые конфликты |
| Durable source/history | Atomic SQLite captures/revisions, source.id→locator; replay сохраняет capturedAt; readonly reader не создаёт legacy DB/tables |
| Owned offline refresh | Fixed clean tracked files, JSON Pointer/hash/ESM exports, evidence вне Git; без broad live research |
| Bounded context | Whole-record UTF-8 budget, deterministic relevance и coherent total/complete; untrusted references не становятся инструкциями |
| CLI/Engine | status/refresh/inspect, fresh context/evidence, off byte identity, сохранение legacy envelope и меньших budgets |

[Форматы, команды, доверие и ограничения](../KNOWLEDGE.md), [runtime](../RUNTIME.md#структурированное-knowledge-offline-mvp05). Frozen ports SHA-256 `72f8670725e0217b67b619c24ed822ecf2f0452231e0c628cc58eece0990a52d`, capture-head amendment `c6b9b5f253cfdd5b10b227169ba441bc408896ea1d86ac23ab1df9c0537cd48e`. Нет embeddings, универсального semantic fact checker или новой parser dependency. Rust и Hearthstone — synthetic fixtures; реальные game statistics/sample/population/window неизвестны.

## Фактическая приёмка

Источник: private `C:/Users/zulut/AppData/Local/Temp/kodo-roadmap-20261104/speed-five/coordination/phase05-acceptance-checkpoint.json`, SHA-256 `60e7a10766b2dc31a47877b3ddf88f08c00ecf9b896679054f1c5af11efc2568`. Documenter06 прочитал и сверил hash checkpoint, не повторял эти проверки.

| Уровень | Наблюдение checkpoint |
| --- | --- |
| Local integrated | `npm run check`, timeout1200000ms, exit0:1433 tests,1427 PASS,6 SKIP,0 FAIL, duration829634.8292ms |
| Security / review | Enabled security passed; fresh evidence integrity подтверждена при official bind. Independent review attempt3: passed, findings[], тот же `a126…`, diffHash `4687b1471bd551f6b43666e0c28499a1b698ea259c337a70a6d3f3006e54d434` |
| Required CI | [Run41967085286](https://github.com/Zulut30/Kodo/actions/runs/41967085286): Linux job127046475668 и Windows127046475829 success, fullcheck exit0 и security passed. CI test counts не наблюдались и не подменяются local counts |
| Installed artifact | Обе ОС: CI-local `npm pack`/isolated install `--ignore-scripts`, bin/launcher/help/validate/list/default-skill pins passed;33 components,13 skills,183 upstream files. Одинаковый archive SHA-256 `0b1f0a60b060808e306974611effa71883ab034d39866275d0408bbd3b8021a5` |
| Native orchestration / Git | Run `08735cee-3537-4e71-a84a-6a8b0d3ea4ca` succeeded; recorded delivery.merged и succeeded, root process exit0, PR14 merged |
| Instruction audit | Восемь valid стадий: analyze/plan/developer/tester/documenter/review/repair/complete, по13 skills; missingStages[]. Уровень только `recorded-instructions`, не semantic compliance |

UI и selfhost architecture disabled — neutral. Installed artifact — локальный CI archive, не опубликованный выпуск. Live product provider smoke и отдельная проверка real native subscription client не выполнялись/не подтверждены; точные HTTP counts, subscription USD и measured performance winner неизвестны. Нового tag/release/deployment нет.

## Сохранённая история и lessons

Ранние scoped результаты и ошибки предшествовали приёмке и не переписаны в PASS. H18 actual offline CLI observations на `19bab3c…` дали disabled/refreshed/replayed/stale/conflict/version/dirty/tamper сценарии, requests0 и guard attempts0; replay не обновлял capture. Они не перезапускались для финальной приёмки. Приватные argv/raw/hashes: `phase05-receipts/knowledge-docs/observations.json` под тем же temp root. Worker counts пересекаются с последующими прогонами; их нельзя складывать в общий total.

Проба test-file ceiling4→8 отменена обратно до4 после full failures в setup/concurrency-five. Позднейший Windows CI41955171373 воспроизвёл порядок a,c,b при ceiling4; причинность потолка не установлена. Исправлена fixture-зависимость optional `nativeKnowledge` I/O, без изменения production scheduler/assertions/timeouts/skips: controlled RED0/1→GREEN1/1, файл15/15. Native concurrency5 сохранена, speedup не заявляется.

Bounded repairs сохранили raw RED/GREEN и snapshots в `C:/Users/zulut/AppData/Local/Temp/kodo-roadmap-20261104/phase05-receipts/`:

- `integration-repair-1`: coherent completeness и lower caps,6 новых регрессий RED0/6→GREEN6/6; scoped74/73 PASS/1 прежний SKIP.
- `knowledge-secret-boundary`, `knowledge-secret-before-evidence`: известные строки/ключи проверяются до normalization/hash/evidence; короткие escaped fake values блокируются, writer0/claims0/evidence0. Root actual default-CLI repro green; старые claims/history не переписываются.
- `knowledge-capture-head`: immutable capture HEAD отделён от current context HEAD; product observation переживает посторонний commit, codebase observation сохраняет current-head fence; scoped59/59.
- `whole-document-selector`: JSON Pointer `""` допустим для whole document, непустые URL/path/ID guards сохранены; synthetic RED0/2→GREEN2/2, scoped28/28.
- `concurrency-fixture-isolation`: подтверждённая fixture correction выше; Git longpath false-dirty проверен по pinned bytes, а не скрыт восстановлением файлов.

Исторические cancelled/failed checks, superseded9bdb review, actual286e review failure и bounded amendments остаются в coordinator history. Успешный current-head checkpoint завершает эти gates, не меняя старые наблюдения.

Сохранены standard/concurrency5/maxTasks12/research10/repair3 и меньшие limits; resume/retry не повышает режим и не сбрасывает историю. GPT/Claude — только подписочные клиенты; workers не получают ключей. Уроки: replay не освежает источник, bounded read не доказывает completeness без total, instruction audit не доказывает поведение, current-head checks не заменяются историческим PASS. [Прогресс](progress.md), [следующий этап06](phase-06.md).
