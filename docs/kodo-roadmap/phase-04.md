# Этап 04 — Architecture Guardian

2026-11-04. **IN PROGRESS, NOT ACCEPTED**. Предыдущий этап принят: [PR #12](https://github.com/Zulut30/Kodo/pull/12), merge `b3304b47ae47fdc8f626e692523761bad7535fa6`; его [evidence](phase-03.md) не переносится на этап 04. Здесь зафиксирован локальный checkpoint A–E и документация H; G работает параллельно. Full/security/independent review/required CI этапа 04 ещё **pending**; публикации и deployment нет.

## Пользовательский результат и границы

MVP должен детерминированно блокировать запрещённый import независимо от LLM approval, проверять заявленные public contracts и migrations, отличать точный старый долг от нового нарушения. [Policy/CLI/registry/examples](../ARCHITECTURE.md), [ADR-0007](../decisions/0007-architecture-guardian.md). Frozen ports v1 SHA-256 `0231856f3304ffb4fdfeeeaccaf6144cbe2a67b281d33ba712fe56054bc4e399`; финальные root clarifications приоритетнее старых proposal labels.

| Требование MVP | Реализация / проверяемый сценарий |
| --- | --- |
| Product ownership/layer/allow/public/forbidden/module cycles | Immutable ESM graph A и pure policy B; unowned src блокируется, outside docs/tests только inventory; unsupported product code blocked |
| Versioned contracts | C требует один contract на public entry, exact AST exports, declared shapeHash и tracked tests; breaking/retirement — append-only migration и изменённые consumers с mapped tests |
| Bounded affected tests | Implementation-only JS выбирает producer/transitive registered consumer tests; CSS-only не запускает unrelated tests; C не исполняет процессы |
| Exact debt/protection | D принимает только unchanged/unexpired eligible base findings; invalid entries блокируют; old/new protected union требует broad L2/review |
| Реальный CLI | E: plan read-only; check — actual clean-head fence, реальные per-file Node TAP, private redacted evidence и deadline120000ms |
| Независимый oracle | Frozen F: permitted ESM принимается; forbidden import блокируется даже при claimed LLM approval; файл не изменялся E/H |
| Engine/delivery | Контракт G frozen, окончательная интеграция и enabled Engine fixtures **pending**; default disabled нейтрален, не PASS |

Пять presets manual/data-only, без auto-selection и --preset. ESM .mjs/.js type=module — единственная анализируемая executable область. Rust/C#/Go/PHP/TSX/JSX/CJS native architecture, advanced duplication/complexity и полная platform/SDK matrix отложены. Примеры Hearthstone сайта, Rust VCS, Windows desktop и WordPress plugin не расширяют поддержку.

## Фактическая локальная проверка

E интегрирован как dependency `bf2e84747bdcced0a2356590fc3a4b62ac969076`; docs worktree source head `846638ce5b9a4c4fb4941bc22b710205ea21d7c0`. Прочитан private completion и raw TAP E: `node --test --test-reporter=tap -- tests/architecture-cli.test.mjs tests/architecture-acceptance.test.mjs` — **26 tests/26 PASS/0 FAIL/0 cancelled/0 SKIP/0 TODO**, 123048.1181ms. Ранее frozen oracle дал meaningful RED2 FAIL при двух успешных независимых contract preflights. Эти suites H повторно не запускал.

Сверены точные байты: runtime/architecture-cli.mjs SHA-256 `b2868a5dd4a8b87acadc9a36f56217af70ed815b9ead622c7b7c5b2891c0ab15`; frozen tests/architecture-acceptance.test.mjs `0130c15d0e39ab61407ce524f80565a98c8a5d7da670c8cd6a809e373432a774`. Это scoped E evidence, не интегрированный PASS всей фазы.

H исполнил независимые owned offline Git fixtures через настоящий CLI (Windows x64, Node24.19.0/ABI137). Private harness command, cwd — назначенный architecture-docs worktree:

```powershell
node C:/Users/zulut/AppData/Local/Temp/kodo-roadmap-20261104/phase04-receipts/architecture-docs/validate-examples.mjs .
```

Девять CLI observations: no-policy neutral; read-only plan с неизменным Git index; настоящий registered assertion RED **1 FAIL/exit1** при value=2 → GREEN **1 PASS/exit0** при value=1; forbidden import — failed/exit1 с dependency.forbidden; .rs/.cs/.php product files — три blocked/exit1 unsupported-language; --preset — arguments/exit1. Пять реальных starter JSON отдельно прошли B validation, без утверждения об исполнении пяти приложений. First enrollment GREEN сохранил basePolicyState:absent, baseRulesEvaluated:false, requiresReview:true, fullVerificationRequired:true.

SourceHash положительного fixture `48f84f10f2e91dc52177956d2a40da80f88e943a2c3c972ced2aae4c8a66f561` относится к временному проекту, не к Kodo. Exact argv/base/head/source/policy/registry hashes, raw stdout/stderr и receipt counts сохранены вне Git: private `phase04-receipts/architecture-docs/validation.json` и соседние captures. Git fixtures удалены после containment-проверки; evidence сохранены. Первая попытка harness с относительным путём CLI дала MODULE_NOT_FOUND до запуска продукта; ошибка сохранена отдельно и исправлена абсолютным source path, не объявлена product RED.

## Приёмка и урок

Для завершения координатору нужны интегрированный текущий clean head, проверка enabled G/Engine/delivery и stale/tampered/expired cases, один полный `npm run check`, fresh configured security, независимое differential review и required Windows/Linux CI. Installed artifact acceptance этапа 04 не получена; CLI из source не считается установленным или опубликованным пакетом. Реальных provider/native SDK/UI checks H не запускал; UI disabled остаётся neutral. GPT/Claude subscription-only, credentials не входят в policy, workers или receipts.

Урок границ: genuine absent base не позволяет придумать old debt. Локальный PASS первого enrollment подтверждает текущие declared tests, но не прежний compliance или право доставки; protection/L2/review сохраняются. Test registry plan не равен выполнению теста: actual failing assertion в отдельном Git fixture должен приводить к failed receipt. Short reports сохраняют результат и пределы; расширенные benchmark/native анализаторы остаются после MVP.
