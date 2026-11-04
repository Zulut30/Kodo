# Этап 02 — исполняемые языковые профили

2026-11-04. **Приёмка PENDING.** Run `808911c7-3e2a-4c7a-8003-d9aa99e5910c`, [PR #11](https://github.com/Zulut30/Kodo/pull/11). Фаза 01 принята через PR #10 / `ef38109e`. Новый выпуск запланирован на фазе 13.

`kodo quality detect|plan|run` выполняет проверки C#, Rust, Go, TypeScript, JavaScript, CSS, HTML, PHP и SQL без LLM. Шесть точных pins добавлены в существующий installer; всего 16 optional tools, 13 default skills, 33 компонента. [Контракт и примеры](../QUALITY.md), [ADR-0005](../decisions/0005-language-quality-profiles.md). Missing/unknown не становятся PASS. Quick сохраняет узкие source scopes, изменения manifest/config/lock активируют owning project, неизвестная область требует явного affected scope. Проверяются pins, dialect, старый долг, источник, HEAD и целостность независимых capability receipts.

| Requirement | Evidence |
| --- | --- |
| Девять языков, good/bad/missing/unsupported | `QACC-01 csharp good bad missing unsupported public matrix`; `QACC-02 rust good bad missing unsupported public matrix`; `QACC-03 go good bad missing unsupported public matrix`; `QACC-04 typescript good bad missing unsupported public matrix`; `QACC-05 javascript good bad missing unsupported public matrix`; `QACC-06 css good bad missing unsupported public matrix`; `QACC-07 html good bad missing unsupported public matrix`; `QACC-08 php good bad missing unsupported public matrix`; `QACC-09 sql good bad missing unsupported public matrix` |
| Версия, output и scope | `QACC-12 exact pins complete versions and complete outputs are mandatory`; `QACC-13 quick scope manifest mismatches and filesystem escapes fail closed`; `QACC-19 gofmt version observation must identify the checked executable`; `QACC-20 dotnet warning summary cannot become a clean typecheck`; `QACC-21 HTML validator source text is not a diagnostic file path` |
| Долг и новые нарушения | `QACC-15 old debt cannot hide changed new duplicate or worsened violations` |
| Config invalidation | `Quality quick config changes cannot hide failing TypeScript behind passing JavaScript` |
| Source closure / alias | `Quality TypeScript reference directives stay inside the inventoried project`; `Quality Windows short names inside the root map only to inventoried diagnostic files` |
| Фактическое TSC coverage | `Quality TypeScript checks every receipt root despite files exclude and noCheck`; `Quality TypeScript private config binds exact roots options and tamper-sensitive receipts`; `Quality TypeScript generated config mutation during compiler execution blocks PASS`; `Quality TypeScript unsupported project references never execute or receive PASS` |
| Реальный Windows teardown | `Windows owned teardown exit at kill boundary`; `Windows owned teardown access denied during handle acquisition`; `Windows owned teardown rejects an owned tree that remains alive after shutdown` |

## Выполненные проверки

Обычные suites используют offline fixtures, fake provider/tool ports и настоящие локальные Git/Node процессы; платных запросов в них нет. Координатор запускает полный `npm run check` на объединённом чистом commit. Scoped команда:

```powershell
node --test --test-reporter=tap tests/quality-profiles.test.mjs tests/quality-runner.test.mjs tests/quality-cli.test.mjs tests/quality-acceptance.test.mjs
```

Независимый oracle зафиксирован SHA-256 `7101c8462ca38870282720b5f759ec55a50ecaeae0705bc682fc6606a139db73`; исходный RED и тесты сохранены. Он обнаружил gofmt identity, .NET warning summary и HTML source/filePath. Последующие реальные прогоны обнаружили Windows 8.3 spelling и пропуск TSC после изменения config. После ремонта оба scoped-прогона — обычный и настоящий 8.3 TEMP/TMP — дали **98/98 PASS, 0 SKIP**. External/excluded TS reference и внутренний short-name дополнительно проверены **2/2**, frozen QACC-12/13/14/21 — **4/4**; 102 PASS промежуточного broad run не приписываются финальной excluded guard.

На `32783ce` local full check: **844 / 842 PASS / 2 SKIP / 0 FAIL**, 607156.4364 ms; security PASS, UI disabled, независимый review PASS. [Linux CI 41846581622](https://github.com/Zulut30/Kodo/actions/runs/41846581622): **846 / 839 PASS / 7 SKIP / 0 FAIL** и package smoke PASS. Windows CI того же HEAD: **844 / 841 PASS / 2 SKIP / 1 FAIL** — существующая гонка завершения процессов; это не успешная приёмка.

Гонка `HasExited → Kill` воспроизведена реальным owned process. Узкий ремонт принимает только подтверждённый exit; access/live/survivor failures остаются блокирующими, enumeration/WaitForExit и прежняя taskkill semantics сохранены. Scoped **10/10 PASS** включает исходный stdout-cap failure и отрицательные контроли. Исторические неудачи и диагностические ошибки fixtures сохранены.

По новому указанию пользователя пять изолированных задач ускорения выполнены параллельно. Только проверенное test maintenance уже включено в эту фазу: 43 исходных engine-сценария и 10 helpers перенесены побайтно, 446 assert-вхождений сохранены. Четыре файла дали **61/61 PASS**, wall **137420.1356 ms**; сопоставимого полного before нет, коэффициент ускорения неизвестен. [Подробности](../WINDOWS-TEST-SPEED.md). Остальные четыре изменения фазы 03 ожидают отдельной интеграции.

На `c4f1ba7` local full check: **851 / 849 PASS / 2 SKIP / 0 FAIL**, 312828.98 ms: один наблюдаемый прогон примерно на 48% короче `32783ce`, без контролируемого benchmark. Windows CI 41851622322 прошёл с package smoke (689 s job wall), ускорение CI пока не подтверждено. Linux того же HEAD остановился на тестовой гонке `/proc` после завершения процесса. Переносимый RED воспроизвёл ESRCH; исправленная fixture принимает только ENOENT/ESRCH или zombie, живой процесс и EACCES остаются ошибками, **10/10 PASS**.

Независимый review `c4f1ba7` обнаружил ещё один false PASS: `tsconfig.files` исключал ошибочный файл, указанный в receipt. Реальный TSC воспроизвёл проблему. Приватная check-only конфигурация теперь перечисляет все receipt roots, запрещает `noCheck`/пропуск library checks и связывается с evidence по хешу. Inventoried local extends сохраняются; project references явно BLOCKED. Scoped **42/42 PASS**, неизменённый frozen oracle **9/9 PASS**; настоящий TSC: пять ошибочных проектов FAILED, три корректных PASSED, references BLOCKED. После конкретного ремонта запускается официальный новый цикл с прежними лимитами и сохранённой историей трёх неудачных review-попыток.

## Границы доказательств и следующий gate

Private receipts вне Git: `%TEMP%/kodo-roadmap-20261104/` — `acceptance/`, `repair01/`, `repair02-validation/`, `teardown-race-receipts/`, manifests `coordinator-*-adoption.json`. Они связывают реальные logs, source hashes и попытки; неудачи не перезаписаны.

Native Windows: 6 точных tool-version probes PASS; 14 реальных good/bad source-CLI сценариев для JS/TS/CSS/HTML/SQL/PHP дали ожидаемые результаты. Ошибка config scope подтверждена настоящими TSC/Oxlint. C#/Rust/Go compilation остаётся NOT VERIFIED; .NET/Rust/PHP version observation не заменяет SDK conformance. Codex Desktop worker/review sessions реальны; native subscription CLI end-to-end и Claude/both acceptance относятся к фазе 13.

Локальный прежний installed `.tgz` прошёл новые quality команды; это исторический artifact `4042edd9`, не финальный пакет текущего ремонта. После последних repairs нужны **новый чистый HEAD → full check → fresh security/UI evidence → независимый review → exact-head Windows/Linux CI → merge**. UI disabled нейтрален. Public release не опубликован, deployment не запускался. Авторитетное состояние — SQLite/receipt Kodo; этот документ является снимком до итоговой приёмки.
