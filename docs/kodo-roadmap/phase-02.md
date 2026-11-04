# Этап 02 — Language Quality Engine

2026-11-04. **Второй repair scoped GREEN на `1574a3c`; весь этап ещё не принят, full check/CI нового head PENDING.** Исходный integration HEAD `977f9767ee9b56c8789b1b67b5e9a482d57a8887` остаётся RED; исправления координатора отдельно прошли scoped-проверки с неизменённым acceptance oracle. Node `v24.19.0`, Windows x64. [Фаза 01](phase-01.md) принята через PR #10 / merge `ef38109e` / CI `41822569460`. Фазы 03–13 не начаты. PR фазы 02: **PENDING**; exact-head Linux/Windows CI: **PENDING**; нового release нет.

Публичный контракт: [QUALITY](../QUALITY.md), [ADR-0005](../decisions/0005-language-quality-profiles.md). Девять языков, offline detect/plan/run, отдельные capability receipts, strict pins/debt/scope. Используются существующие installer/managed `resolveTool` и owned-process `delivery.execute`; credential/provider startup не нужен. Архитектурный движок, CI/cache и автоматическая доставка не добавлены.

## Ремонт Windows-путей и Quick metadata scope

Следующий проверенный base — `4042edd9cb74cb4b7f798549d0997d229d68a6bc`: coordinator local и Linux CI PASS, Windows CI [41836243161](https://github.com/Zulut30/Kodo/actions/runs/41836243161) FAIL на строковом `realpath(root) !== root`. Независимый managed TSC/Oxlint probe также обнаружил ложный Quick PASS при изменённых `tsconfig.json` + JS и ошибке в TS. Эти исторические результаты не являются приёмкой ремонта.

Worker исправляет только разрешённый scoped diff поверх `4042edd9`, без commit/доставки: directory/noLinks проверяются до канонизации; канонический root используется для inventory, diagnostic mapping и evidence containment, включая повторную проверку квитанций. Windows drive case, 8.3 и перенаправленные пути допускаются; внешние пути и symlink diagnostics отвергаются. Известные manifest/config/lock активируют owning checks с причиной, неизвестные metadata требуют явного affected scope. CSS/JS source-only fast path и границы siblings сохранены. Configured checks также активируются изменением metadata своего проекта.

| Requirement | Evidence |
| --- | --- |
| Windows aliases | `Quality Windows drive case and short aliases preserve safe discovery and planning` |
| directory/noLinks | `Quality canonical discovery still rejects linked and non-directory roots` |
| Scope всех девяти языков | `Quality quick manifest and config changes select all nine language profiles` |
| Owning project, siblings, CSS/JS, unknown scope | `Quality quick metadata changes widen owning checks and preserve sibling and source scopes` |
| Configured checks | `Quality quick metadata changes activate configured checks without crossing sibling projects` |
| Ложный смешанный JS/TS PASS | `Quality quick config changes cannot hide failing TypeScript behind passing JavaScript` |
| Evidence containment | `Quality Windows aliases keep evidence outside the canonical project`; `Quality Windows receipt containment rejects relocated evidence through aliases` |
| Diagnostic paths | `Quality Windows aliases map absolute diagnostics only inside the inventoried root`; неизменённый `QACC-21 HTML validator source text is not a diagnostic file path` |

Private raw evidence: `%TEMP%/kodo-roadmap-20261104/repair01/`. `red.tap`: все три первоначальные регрессии RED (unsafe_path, skipped typecheck, ложный passed). После канонизации дополнительный `alias-scoped.tap`: 93 PASS / 1 FAIL, frozen QACC-21 подтвердил несовпадение diagnostic namespace; `red-alias-diagnostics.tap` и `red-receipt-alias.tap` сохраняют отдельные RED. Последний targeted `green-final-regressions.tap`: 9/9 PASS. Итоговый scoped GREEN: **98/98 PASS, 0 fail/cancelled/skip** в обычном окружении (`final-normal-green.tap`, 43287.963 ms) и **98/98 PASS, 0 fail/cancelled/skip** с реальным 8.3 TEMP/TMP (`final-alias-green.tap`, 43916.322 ms). Полные scoped команды, хеши файлов/логов и точный alias фиксируются в `receipt.json`; full integrated check, fresh scanners/review и новый exact-head Linux/Windows CI **PENDING**.

```powershell
node --test --test-reporter=tap tests/quality-profiles.test.mjs tests/quality-runner.test.mjs tests/quality-cli.test.mjs tests/quality-acceptance.test.mjs
```

Эта команда повторяется с дочерними `TEMP/TMP`, указывающими на owned 8.3 scratch; `alias-tmp.txt` хранит точный путь. Frozen acceptance SHA-256 остаётся `7101c8462ca38870282720b5f759ec55a50ecaeae0705bc682fc6606a139db73`. Уроки: строковая идентичность пути не доказывает filesystem identity; source-only пересечение теряет изменения конфигурации; после смены namespace все проверки containment и diagnostics должны использовать тот же канонический корень. Наличие Windows scoped GREEN не заменяет Windows CI и fresh review.

## Второй repair: TypeScript references и внутренние Windows 8.3 diagnostics

2026-11-04. Проверен только diff `dfc69bf679a3330359f53ee3702bc7773d5b1512..1574a3c1b022e9e746326ca297cf89f0bf0d43a6`: два runtime-файла и две регрессии; все четыре SHA-256 совпали с `coordinator-scope-repair-adoption.json`, original plan неизменён. Runtime/test source worker не менял. TypeScript reference проходит containment/noLinks и проверку inventory до компилятора; внешняя и исключённая зависимости отклоняются, внутренняя разрешена. Windows diagnostic alias внутри канонического root теперь проходит link-free canonicalization при несовпадении с inventory; внешняя диагностика по-прежнему отклоняется.

Сохранённый actual TSC probe на `dfc69bf` подтверждает причину major finding: первая проверка PASS, после внешней мутации прежний receipt всё ещё current, повторный TSC FAIL. `scope-repair-red.tap`: **0 PASS / 2 FAIL** (`Missing expected rejection`, `invalid_output`). `scope-repair-green.tap`: **102 PASS**, но до финального excluded-reference guard; этот результат не удостоверяет точный финальный source. `scope-repair-final-targeted.tap`: **2 PASS** на финальном source.

Независимый worker повторил на `1574a3c`:

```powershell
node --test --test-reporter=tap --test-name-pattern '^Quality (TypeScript reference directives|Windows short names inside)' tests/quality-profiles.test.mjs tests/quality-runner.test.mjs
node --test --test-reporter=tap --test-name-pattern '^QACC-(12|13|14|21) ' tests/quality-acceptance.test.mjs
```

Точные регрессии: `Quality TypeScript reference directives stay inside the inventoried project` — external/excluded отказ и valid internal ref; `Quality Windows short names inside the root map only to inventoried diagnostic files` — реальный вложенный 8.3 alias внутри root и outside отказ. Первый запуск **2 PASS**, 913.9677 ms; второй **4 PASS**, 5447.3893 ms; оба exit 0, без fail/cancelled/skip. Frozen acceptance SHA-256 `7101c8462ca38870282720b5f759ec55a50ecaeae0705bc682fc6606a139db73` неизменён. Private scoped receipt и raw TAP: `%TEMP%/kodo-roadmap-20261104/repair02-validation/`.

Full `npm run check`, fresh security gates/review и Linux/Windows CI для нового head **PENDING**, их выполняет координатор. Исторические coordinator local `dfc69bf` **842 tests / 840 PASS / 2 SKIP** и обе ОС CI `41841801700` PASS не являются PASS нового head. UI disabled/not-applicable; новые native provider checks не запускались, published artifact/deployment evidence отсутствует. Урок: неучтённый compiler input делает receipt ненадёжным; строковое containment ещё не сопоставляет DOS alias с inventoried файлом. Фазы 03–13 не начаты.

## Независимые проверки

Тесты: [quality-acceptance.test.mjs](../../tests/quality-acceptance.test.mjs). Все имена фиксированы; source/output не попадают в имена. Fixture-инструменты — искусственные offline процессы/порты; fake npm полностью заменяет package manager, сети/реальных установок нет. Временные Git-проекты и evidence изолированы вне checkout. Assertions проверяют публичный результат, файлы и квитанции; внутренние функции реализации не вызываются.

| Requirement | Evidence |
| --- | --- |
| 9 языков × good/bad/missing/unsupported | Точные имена `QACC-01 csharp good bad missing unsupported public matrix`, `QACC-02 rust good bad missing unsupported public matrix`, `QACC-03 go good bad missing unsupported public matrix`, `QACC-04 typescript good bad missing unsupported public matrix`, `QACC-05 javascript good bad missing unsupported public matrix`, `QACC-06 css good bad missing unsupported public matrix`, `QACC-07 html good bad missing unsupported public matrix`, `QACC-08 php good bad missing unsupported public matrix`, `QACC-09 sql good bad missing unsupported public matrix`; дочерние `good`, `bad`, `missing`, `unsupported` |
| A+B / managed port / integrity | `QACC-10 registry and real managed resolver compose without installation`; `QACC-11 installed fixture entrypoints compose through real managed resolver and subprocess` — 5 npm fixture entrypoints; SQL missing/unsupported через реальный resolver |
| Pin/version/output fail closed | `QACC-12 exact pins complete versions and complete outputs are mandatory` |
| Quick scope, manifest, symlink/escape | `QACC-13 quick scope manifest mismatches and filesystem escapes fail closed` |
| Source mutation / evidence integrity | `QACC-14 real source mutation blocks clean output and invalidates receipts` |
| Старый долг и новые нарушения | `QACC-15 old debt cannot hide changed new duplicate or worsened violations` |
| Capability separation / dialect / dedup | `QACC-16 distinct capabilities and SQL reuse never manufacture test security or release proof` |
| CLI JSON без startup, старый CLI smoke | `QACC-17 CLI JSON and legacy commands work without provider or runtime startup` — detect/plan/run, malformed flags, help/list/tools-list, пустой PATH, отсутствие state/credentials/tool-home |
| React/Next/Astro/WP indicators | `QACC-18 detected framework evidence comes from manifests and source` |
| Дефект gofmt identity | **RED 977f → coordinator GREEN:** `QACC-19 gofmt version observation must identify the checked executable`; children `unrelated executable`, `multiline corruption` |
| Дефект .NET warnings | **RED 977f → coordinator GREEN:** `QACC-20 dotnet warning summary cannot become a clean typecheck` |
| HTML-Validate actual JSON / scope | **RED 977f → coordinator GREEN:** `QACC-21 HTML validator source text is not a diagnostic file path` — `filePath` и raw `source` имеют разные роли |

Команды из назначенного worktree:

```powershell
node --test --test-reporter=tap tests/quality-acceptance.test.mjs
node --test --test-name-pattern '^QACC-(19|20) ' tests/quality-acceptance.test.mjs
node --test --test-name-pattern '^Quality (process port bounds output and kills the owned tree on deadline|active cancellation stops a real configured process and retains cancellation evidence)$' tests/quality-runner.test.mjs
```

Первый запуск до добавления QACC-19/20/21: **54 pass, 0 fail/skip**, exit 0, 37.223 s. Он подтверждает отрицательные controls, но не является финальным GREEN. Финальный полный scoped run: **59 tests / 54 pass / 5 fail / 0 cancelled/skip**, exit 1, 41.254 s; 21 top-level test, два дочерних fail и их parent в QACC-19. SHA-256 test snapshot: `7101c8462ca38870282720b5f759ec55a50ecaeae0705bc682fc6606a139db73`.

Настоящие owned-process regressions: **2 pass, 0 fail/skip**, exit 0, 6.199 s. Проверены output overflow, timeout и исчезновение дочернего PID; активная отмена сохраняет `cancelled` evidence. Точные имена — две альтернативы последнего regex в команде выше. Эти существующие тесты уже напрямую покрывают процессный контракт, дубликаты не добавлены.

Private receipts: `%TEMP%/kodo-roadmap-20261104/acceptance/` — `acceptance-final-red.tap`, `red-acceptance.tap` (первые 54 GREEN), `red-gofmt-identity.tap`, `red-version-build.tap`, `owned-process.tap`, `scoped-receipt.json`. В Git они не входят. RED: gofmt принимал чужую identity/многострочный мусор по suffix; .NET принимал неполную сводку с ненулевыми warnings; HTML-Validate raw `source` ошибочно считался путём вместо `filePath`. Исходный RED сохранён; runtime worker не менял.

**Отдельный coordinator GREEN:** неизменённый acceptance snapshot с указанным SHA-256 скопирован в repair worktree и проверен вместе с `quality-profiles`, `quality-runner`, `quality-cli` и новыми protocol regressions: **91 tests / 91 pass / 0 fail/cancelled/skip**, **53081.6305 ms**. Source fix commit: `f704586c6fe0c5cc6cb163b3a3998d85eb0e511b`; затем интегрирован как `ac225c8b7eb4945ec32a8a5a15a74aeb24d3dd58`. Manifest: `%TEMP%/kodo-roadmap-20261104/coordinator-runner-repair-adoption.json`; raw `runner-fixes-green.tap`, SHA-256 `2b3fcc2f1b34a56fd4698c3b0e60cc5d4021ed53019f211d0939a1fb825d7b79`. Worker сверил manifest, hash лога, итоговые counts и hash собственного testfile; тесты/ветку/base не менял и suite повторно не запускал. Это scoped evidence исправленного кода, а не PASS исходного `977f` или полного integrated gate.

## Границы доказательств

**Local/CI:** worker запускал только перечисленные scoped tests. Полный `npm run check`, fresh scanners, independent differential review и exact-final-head CI принадлежат координатору и здесь **PENDING**. Security configured/enabled, worker scanners unavailable; UI **disabled / not applicable**, это не PASS.

**Native:** coordinator receipts `quality-tools-live-recheck.json` — 6 version PASS; `native-quality-tool-probes.json` — 6 good/bad tool-CLI пар PASS. Они проверяют сами инструменты на Windows, не девять профилей через Kodo API. Исходный setup `5 pass / 1 error` сохранён отдельно. `native-sdk-versions.json`: .NET 10.0.302, Rust 1.96.0, PHP 8.4.21 наблюдались только как версии; Go/gofmt missing. Полный native SDK behavior, UI и живые model/provider calls этим worker **NOT VERIFIED / NOT RUN**.

**Package/release/deployment:** phase-02 installed-package smoke **NOT VERIFIED**; PR/CI **PENDING**; public artifact **NOT PUBLISHED**, deployment **NOT RUN**. Исторические package/CI фазы 01 сюда не переносятся. Урок: точный pin и exit 0 не заменяют полную диагностику и подтверждение identity выбранного executable.
