# Этап 03 — быстрые проверки, CI и параллельная работа

2026-11-04. **ACCEPTED**, [PR #12](https://github.com/Zulut30/Kodo/pull/12) merged: `b3304b47ae47fdc8f626e692523761bad7535fa6`. Проверенный source head: `2c9e957c64d7a1b40ac4b51c3ead7ba311340efe`. Основание — coordinator checkpoint `phase03-acceptance-checkpoint.json` из private `speed-five/coordination`; это историческая приёмка этапа 03, не evidence этапа 04. Предпосылка: [PR #11](https://github.com/Zulut30/Kodo/pull/11), phase02 merge `dabecb7bec7514116e3b2870c04270bb4f83ee77`.

## Результат MVP

`kodo ci plan|run|profile` даёт L0–L3; `ci feedback --base SHA --json` отделяет быстрый affected feedback от полной приёмки. `feedback_ready` всегда complete:false/requiresFullCheck:true. Неопределённые зависимости сохраняют причины; strict L1 использует broad fallback, L2 выполняет полный check и fresh security, L3 — installed package smoke. Optional Actions fast включается только `vars.KODO_FAST_CI_ENABLED == 'true'`; skipped/disabled — neutral. Required Windows/Linux names, branch protections и installed smoke сохранены.

Новые runs поддерживают capacity1–5, но task.parallel, независимые scopes/dependencies, Jev threshold, выбранная модель и меньшие saved budgets остаются обязательными. Quick default1 и последовательный routing сохранены. Project capacity5 не расширяет старый run. `npm test` использует `node --test --test-concurrency=4`; `npm run check` остаётся `npm run validate && npm test`. Cache exact-context private и требует свежих входов/evidence; UI/security не кэшируются. Наличие cache API не означает пропуск CI-команд.

[ADR-0006](../decisions/0006-tiered-ci-and-parallel-capacity.md) сохраняет исходную мотивацию и исторический draft-статус решения; фактическая приёмка зафиксирована здесь. [CI](../CI.md), [graph/cache](../AFFECTED-CACHE.md), [profiler](../CI-PROFILER.md).

## Принятая проверка

| Уровень | Наблюдение |
| --- | --- |
| Local integrated | `npm run check`, exit0: **1031 tests /1025 PASS/0 FAIL/0 cancelled/6 SKIP**, duration 886302.51ms; check receipt SHA-256 `71bdf488062d5a423694f98a4dfbdbc3030146b23626db0cb38304e0f40b4130` |
| Required CI | [Run 41907865119](https://github.com/Zulut30/Kodo/actions/runs/41907865119): `check (ubuntu-latest, 24)` и `check (windows-latest, 24)` success; L2 exit0, fresh security passed на обеих ОС |
| CI identity | Source head выше; фактический checkout merge-ref `bd695f0318f8596ade9c44b4cd2aaffe25a8a739`. Это отдельный SHA, не merge commit PR12 |
| Installed package | Обе ОС: @zulut30/kodo 0.2.6, isolated install --ignore-scripts, bin/launcher/help/validate/list/default-skill pins PASS; 33 components, 13 skills, 183 upstream files |
| Same archive | SHA-256 обеих ОС **1c429465fc0d816284e932c4ca2b7a457acf06dc11b412ee57cccf7c6c52effa** |
| Independent review | PASS, findings=[], тот же source head; diff hash `353137be7caecb66ba49e88ea000888f2edec32a3298e5ea0b81f5a6aaa01305` |
| Local security | Semgrep1.183.0 и Gitleaks8.30.1 passed, findings=[], current source/config/pins и private evidence сохранены |
| UI/native/release | UI disabled/passed:null; живые подписочные provider/native UI проверки этой приёмкой не заявлены; **нового release/deployment нет** |

CI public logs показывают exit/wall/security/install smoke, но **не счётчики Node tests**: они остаются null, локальные 1031/1025/6 на CI не переносятся. Наблюдаемые L2 wall: Linux120018.482609ms, Windows856498.7808ms; job wall152/970s. Это одиночные observation, без benchmark winner, causal speedup, native HTTP или точной subscription USD.

## Регрессии и проверенные уроки

| Требование | Реальные test names / evidence |
| --- | --- |
| Partial feedback не становится acceptance | `CI feedback fallback keeps ambiguity defers full tests and never claims complete L1`; `CI feedback runs only proven affected tests without broad fallback` |
| Actual bytes важнее одного HEAD | `CI acceptance blocks dirty source before execution and mutation under an unchanged HEAD`; `CI acceptance never passes when current source state cannot be verified` |
| Exact-context cache не доверяет claimed успеху | `Command cache requires freshly supplied complete context on every read`; `Command cache detects tampered envelope missing output and changed output bytes` |
| Полный affected test discovery | `Affected graph includes exact test basenames discovered by default Node runner`; `L1 runs exact basename affected test and rejects its real failing assertion` |
| Пакет и bounded scheduler | `Packed CI reporter loads by installed runtime file URL and observes one real passing test`; `Engine has five actually active fake native sessions behind one subscription barrier`; `Five-slot Engine scheduler serializes conflicting scopes dependencies and integrations` |

Исторический scoped composition: 91/91 PASS семи suites на `8c24da1b6e1183030528f3cc3478f73b4af17855`, sourceHash `0a4b4d89f71e197fda205a0ce5da7f76626051c19b9f49b6dcea24b7f0860ac0`, dependencyHash `6fcf55271b7f9f0a3a4f10ba07bd4c93e29c04d2b951ed34723fe0b0fc681a6e`. Это не reusable PASS будущего head. Private receipts сохраняют предыдущий failed cycle, component provenance и новый успешный цикл без переписывания истории.

Подтверждённая ошибка discovery: test.js/test.mjs/test.cjs вне test/ входили в dependency closure, но терялись при классификации testFiles. Реальные Node assertions дали RED9 PASS/6 FAIL→GREEN15 PASS. Урок — проверять запуск падающего теста через L1, а не только closure. Packed reporter отсутствовал в tgz и давал ERR_MODULE_NOT_FOUND/exit7; regression выполняет настоящий reporter из распакованного URL с пробелом/#. Inherited L2 NODE_OPTIONS reporter давал 2!=1, вариант удалён; ненаблюдаемые spans остаются null.

Broad quality/source ownership для vendor snippets остаётся отдельной настройкой проекта; исторический L1 plan был blocked с unambiguous_csproj_required/tsconfig_required/htmlvalidate_project_config_required. Исключений ради зелёного feedback нет. Первые tiny/real feedback observations ~2.78/4.29s и blocked large diff ~11.86s не являются измеренным ускорением Actions. Native SDK/platform matrix и benchmark campaigns отложены после MVP; следующая фаза — [Architecture Guardian](phase-04.md).
