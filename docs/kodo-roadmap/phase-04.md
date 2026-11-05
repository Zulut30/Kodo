# Этап 04 — Architecture Guardian

2026-11-05. **ACCEPTED**: [PR #13](https://github.com/Zulut30/Kodo/pull/13) merged в `a6740910373186f823c6c207804762f333c26031`; проверенный source head `afbbe68aea2ac9d3e3e4535b0bfd41660c489c84`. Это историческая приёмка04, не evidence следующего этапа.

## Результат MVP

Versioned module/layer/import policy, ESM graph, declared public contracts/migrations и exact old-debt baseline связаны с реальными CLI/Engine/delivery gates. Запрещённый import блокируется независимо от claimed LLM approval; unsupported executable code не получает PASS. First enrollment не выдумывает старый долг и сохраняет broad verification/review. [Форматы и примеры](../ARCHITECTURE.md), [решение при реализации](../decisions/0007-architecture-guardian.md).

Поддержаны ESM .mjs/.js type=module. Пять presets — manual data-only, без auto-selection/--preset. Native Rust/C#/Go/PHP/TSX/JSX/CJS analyzers, advanced duplication/complexity и platform/SDK matrix отложены; примеры этих проектов не доказывают их исполнение.

## Принятые доказательства

Авторитетный private checkpoint: `C:/Users/zulut/AppData/Local/Temp/kodo-roadmap-20261104/speed-five/coordination/phase04-acceptance-checkpoint.json`, observedAt `2026-11-05T00:39:18.698Z`. Документатор прочитал сохранённые receipts; эти проверки здесь повторно не запускались.

| Уровень | Подтверждено |
| --- | --- |
| Локальный clean source | npm run check exit0: 1276 tests, 1270 PASS, 0 FAIL/cancelled, 6 SKIP, 0 TODO; 979677.2867ms, head afbbe68 |
| Gates/review | Configured security passed и independent review passed на afbbe68, findings0; review diffHash b368293cc2de1cd8b31cdc99400f064638966e27b5c8812e53ffeeb36f08b6ca |
| Required CI | [41937874907](https://github.com/Zulut30/Kodo/actions/runs/41937874907): Linux success, Windows success после одного bounded exact-head retry; финальные CI Node counts не наблюдались и остаются null |
| Installed artifact | Обе ОС: npm pack, isolated install --ignore-scripts, bin/launcher/help/validate/list/default-skill pins smoke passed. Одинаковый archive SHA-256 b17084cf206206d60088e61e8b6284af43fed2efa21593bb11f53236fdd83cb0 |
| Delivery | PR13 merged; checkpoint integrationClean:true. Новый release/tag/deployment отсутствует; CI artifact не опубликован |
| Нейтральные gates | UI disabled/passed:null; selfhost architecture disabled/passed:null. Enabled architecture fixtures проверены отдельно; disabled не означает PASS |

Первый Windows job того же CI остаётся **failure**: 1276/1269 PASS/1 FAIL/6 SKIP, существующий localhost credential Git fixture превысил неизменённые 10000ms. Один повтор прошёл без изменения source/config/tests/timeouts. Причина на уровне source и механизм нестабильности не подтверждены; успешный retry не переписывает первый результат.

Scoped oracle/CLI и enabled Engine fixtures сохранены отдельно от общего PASS. Исторические H owned offline examples: девять CLI observations, включая фактический assertion RED→GREEN, forbidden import и неподдерживаемые языки; это source fixtures, не installed/native SDK acceptance.

Обновлённый private `phase04-audit-final-refreshed.json` подтверждает все восемь записанных стадий (`analyze/plan/developer/tester/documenter/review/repair/complete`), у каждой valid:true и 13 решений. `skills.complete:true`, missingStages пуст, evidenceLevel **recorded-instructions**. Это полнота записанных инструкций, не доказательство исполнения всех upstream-методик.

## Уроки и ограничения

На Windows используйте native canonical paths для owned TEMP/evidence, сохраняя отдельную 8.3 regression. Private owner/protected ACL задаются при доверенном создании; acceptance отвергает изменённые permissions и не чинит их. Новый neutral gate меняет exact review envelope: все прежние redaction/template assertions и порядок UI/security/architecture должны сохраняться.

Не смешивайте local counts с неизвестными CI counts, disabled с PASS или installed smoke с публикацией. Failed/cancelled/partial попытки остаются в истории. Native provider/HTTP counts, точный subscription USD, универсальные SDK и deployment этим checkpoint не доказаны. Следующий этап — [05](phase-05.md).
