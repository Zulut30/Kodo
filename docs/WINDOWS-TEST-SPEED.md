# Тесты и диагностика затрат на Windows

## Планирование полной suite: scoped коррекция06, 5 ноября

`npm test` теперь вызывает `scripts/run-tests.mjs`: официальный Node24
[`node:test.run`](https://nodejs.org/docs/latest-v24.x/api/test.html#runoptions)
с `files`, консервативным default concurrency 4, `isolation: 'process'` и встроенным TAP reporter.
Прямой `node --test` сортирует explicit files, поэтому перестановка аргументов
CLI сама по себе не меняет стартовый порядок. Programmatic API сохраняет
переданный порядок; это проверено короткими реальными child-процессами.

Обнаружение в `scripts/run-tests.mjs` повторяет default pattern из встроенного
Node `v24.19.0`: `**/{test,test/**/*,test-*,*[._-]test}.{js,mjs,cjs,ts,mts,cts}`.
При отключённом strip-types остаются `js,mjs,cjs`. Рекурсивный обход не следует
ссылкам, не выходит из checkout, исключает `node_modules`, `.git` и скрытые
каталоги, как default glob. Новые подходящие файлы включаются автоматически;
это не allowlist только для `tests/*.test.mjs`. Сам runner не соответствует
шаблону и не находится под `test/`.

Коррекция Run `504262c6-2d03-448b-905d-55189698bffe` заменяет устаревший порядок
данными полного локального check source `821eec5a81b4e20715cc7c99a129a8be00d604d8`,
Windows, Node `v24.22.1`, concurrency4. Receipt
`check-c9b54c3c3b46dab3ccfb7042da6116fbebe7cc62641948a24dfb0cd720231816.json`
содержит 66 успешных completed-file observations из 83 обнаруженных файлов;
полный check остановился по timeout1200535ms, остальные17 не имеют финального
наблюдения. Это incomplete/nonpassing full, не AFTER новой перестановки.
SHA-256 read-only анализа `runner-makespan-821-observation.md`:
`5c80cda835a06d39004850a9fb7ea35b4a54117c9e35d000fed77d1082d6bd9c`.

Статический список начинает с **всех 19 завершённых файлов ≥90000ms** по убыванию
`durationMs`, а не `observedAtMs` доставки reporter events. Затем идёт явно
отделённая lower-bound эвристика scheduling и три прежних лёгких приоритета,
также упорядоченных по текущему receipt. Это literal names/comments, без весов,
динамического сбора таймингов и cache.
Все имена ниже обозначают `tests/<имя>.test.mjs`:

| Файл | Наблюдавшаяся длительность, ms |
| --- | ---: |
| delivery | 434779.5897 |
| project-director | 375928.3714 |
| architecture-gate-integration | 314342.0235 |
| architecture-cli | 220780.7633 |
| engine-2 | 219297.3218 |
| engine-4 | 210502.2130 |
| engine-3 | 204285.3006 |
| benchmark | 200519.1471 |
| engine | 197217.0646 |
| knowledge-cli | 187586.6471 |
| ci-graph | 162527.6399 |
| knowledge-refresh | 158457.3852 |
| mode-engine-2 | 125502.3442 |
| ci-cache | 124490.6677 |
| efficiency-engine | 124346.2806 |
| mode-engine | 123214.6159 |
| mode-engine-4 | 119188.7387 |
| quality-runner | 114368.0009 |
| mode-engine-3 | 110802.8659 |

После них `scheduling-engine`: сумма11 из12 последовательных top-level cases
100233.5395ms — **только нижняя граница работы случаев**, не completed-file
duration; неизвестный остаток не выдумывается. Сохранённые лёгкие приоритеты:
`ci-cli`62405.4714ms, `project-director-oracle`22760.5585ms,
`architecture-acceptance`17840.1058ms. Прочие файлы идут лексически после23
приоритетных, включая измеренные ниже90s файлы без прежнего приоритета;
все83 обнаруживаются по прежнему правилу, дубликаты удаляются.

Исторические receipts source88 и benchmark case-work255773.4331ms больше не
задают текущий порядок: у benchmark теперь есть completed-file observation.
Наблюдения зависят от окружения и перекрывающейся нагрузки. Их сумма не является
elapsed time; полного AFTER нет, whole-suite gain и укладывание в20min не
измерены и не обещаны. Прежние Windows/Linux CI не принимают этот кандидат.

Time limits, assertions, frozen oracles и process isolation сохранены. Потолок
тестовых файлов ограничен 8 по политике ниже. Cancellation использует AbortSignal штатного runner; CLI SIGINT/SIGTERM
запрашивают abort и дренирование. Принудительное OS-завершение процесса не даёт
выполнить JS cleanup; Windows tree termination остаётся границей координатора.

### Консервативный default 4: 5 ноября 2026

Automatic8 отозван: полный локальный check source `e69797cc…` остановился
по 20-минутному timeout; Director дал 37 PASS/1 CANCELLED (`testTimeoutFailure`
в неизменённом pause case с deadline60s). Это не feature PASS. `runTests` снова
всегда использует default4 независимо от CPU/памяти. Selector удалён вместе
только с новыми obsolete pure-resource tests; исходный default4 barrier
восстановлен с прежними assertions/deadline. Explicit `--test-concurrency=1..8`
остаётся opt-in, hard max8, negative cap9 и реальный восьми-PID barrier сохранены.
Discovery/порядок, process isolation, старые тесты, три frozen oracle,
failure/cancel/drain, общий deadline, native/model/saved budgets не меняются.
Новых env/settings нет.

Историческое основание отозванного эксперимента — один опыт на неизменённом source
`6dfedcad39d1efed5b31c77a036375a90487219d`, Windows, Node `v24.22.1`, 32 CPU:
одни и те же 30 cases в восьми Engine/mode-engine файлах прошли 30/30 при 4
за 180896.4247 ms, затем при 8 за 113540.1556 ms. Это последовательная
подвыборка одного host, без статистических повторов, не whole-suite speedup,
не model/provider benchmark и не объяснение причины прежнего timeout.

Исторически, до auto8 source-изменения boundary/default/CLI/barrier проверки дали
3 PASS / 28 FAIL; после — 31 PASS / 0 FAIL/cancel/skip, exit0, Windows,
Node `v24.19.0`. Barrier удерживает восемь разных child PID до release,
проверяет верхнюю границу, выполнение всех 11 файлов ровно по одному разу
и drain. Default wiring проверяется с контролируемыми OS readings, настоящим
filesystem и Node children, без зависимости от текущей свободной памяти host.
Тогда старый barrier стал explicit4; теперь его исходный default4 восстановлен.
Cap-negative изменён только с 5 на 9. Остальные старые тела и frozen oracles сохранены.
Сырые `resource-red.tap`, `resource-green.tap`, команды, exit codes и source hashes
сохранены приватно вне Git в Run `d44ff299-c1df-4c21-a3c2-74fcd8d768cf`,
`throughput-evidence`. Полный check, fresh gates, review и CI точного кандидата
выполняет координатор; [окончательная приёмка06](https://github.com/Zulut30/Kodo/pull/15).
Новая regression с mock32 CPU/8 GiB и настоящими child PID дала RED `8 !== 4`
на e697 → GREEN после восстановления default4. Low-resource default4 и explicit
overrides сохранены. Урок: удачная подвыборка не заменяет полный check.

### Dev CLI: Git той же установки

Только CLI-вход `scripts/run-tests.mjs` вызывает `configureGitTestEnvironment()`
из dev-only `scripts/git-test-environment.mjs`; импорт/programmatic `runTests`
окружение не меняет. На Windows можно заменить только первый Git в PATH вида
`.../cmd/git.exe` на sibling `.../mingw64/bin/git.exe` той же установки.
Реальные обычные файлы без file symlink, native canonical paths в одном root
и точное совпадение непустых `--version`/`--exec-path` обязательны. Четыре
абсолютных metadata probes: no shell, windowsHide, timeout≤5s, maxBuffer≤64KiB.
Их env ограничен OS/path/locale allowlist: PATH, SystemRoot/WINDIR/COMSPEC,
PATHEXT, TEMP/TMP, HOME/USERPROFILE/HOMEDRIVE/HOMEPATH/SystemDrive,
GIT_EXEC_PATH, LANG/LC_ALL. Имена и значения сохранены; provider/GitHub/API
tokens и GIT_CONFIG_VALUE_* не передаются. Родительский env не очищается.
Custom Git в CWD, ранняя ссылка/другой launcher в PATH, missing/mismatch/error или выход через
directory symlink оставляют env неизменным. При успехе core directory добавляется
только в PATH runner/children, с прежними key casing/tail и без Path/PATH дублей.
User/Machine PATH, HOME/auth/config, runtime.command/gitBoundary и guards прежние.
Другие ОС — no-op; helper не входит в `package.files`. CLI загружает его динамически
после argument/recursive validation; отсутствие helper сохраняет окружение и
работоспособность отдельной копии runner. Regression такой копии с tiny fixture
сначала дала module-load RED, затем import/CLI GREEN.

Профиль одного неизменённого pause case на e697: 255 Git заняли25722.423ms
из TAP total31350.598ms; тот же core —255 Git17050.328ms из23071.035ms.
Оба case PASS, version/exec-path совпали. Это startup hot path observation,
не whole-suite benchmark и не объяснение полного timeout. Текущие scoped
scheduler/Git/package tests: 56 PASS, 0 FAIL/cancel, 2 file-symlink SKIP из-за прав Windows;
directory-junction escape и реальный установленный Git metadata/status прошли.
Built-in mocks probes изолированы в child, filesystem настоящий. Сырые RED/GREEN,
команды и exit codes вне Git:
`C:/Users/zulut/AppData/Local/Kodo/runs/bc5444e9-6e90-4b9c-8a1f-f5a13834e5a6/git-throughput-evidence`.
Full check, fresh gates, независимое review и CI текущего head остаются у Root.

Поддерживаемый CLI:

```powershell
npm test
npm test -- tests/test-schedule.test.mjs
npm test -- --test-name-pattern='Scheduler starts' tests/test-schedule.test.mjs
npm test -- --test-concurrency=1 tests/test-schedule.test.mjs
```

Оба флага принимают `=value` или отдельное значение; повторные name patterns
передаются Node как массив. Concurrency разрешена от1 до8, default всегда4. Explicit
paths — только существующие literal-файлы внутри checkout, без ссылок,
`node_modules`/`.git`; повторения запускаются один раз. Globs, каталоги и остальные
флаги явно отклоняются с nonzero exit, а не меняют выбор тестов незаметно.
Для более широкого CLI остаётся прямой `node --test`. Поиск существующих scripts
не выявил npm-вызовов с дополнительными флагами; прямые Node scoped-команды
остаются самостоятельными. Runner нужен только checkout разработчика и не входит в установочный CLI-пакет; shipped script asset остаётся `ci-reporter.mjs`. Существующий пакетный regression test проверяет этот состав.

Локальное доказательство ограничено `tests/test-schedule.test.mjs` с короткими
фикстурами (историческая коррекция порядка, до ресурсного default): default discovery (включая TypeScript/strip-types), exclusions/links,
детерминированный duplicate-free порядок, фактический старт при concurrency1,
readiness barrier с четырьмя отдельными PID, exit0 и реальные assertion/import/
cancel failures, abort owned child, explicit paths/name patterns и явный отказ
для неподдерживаемого CLI. RED сначала показал старый лексический старт.
Сырые RED/GREEN и receipts находятся вне Git в
`C:/Users/zulut/AppData/Local/Kodo/runs/ad175403-61c1-49d2-9fd2-f1f8f04656f5/scheduler-evidence`.

Полный `npm run check`, Windows/Linux CI, независимое review и приёмку выполняет
координатор на интегрированном head. Полный AFTER, ускорение и общий PASS здесь
не заявлены. UI disabled — neutral; security gates остаются координатору.
Native provider, installed/published artifact и deployment не проверялись.
Урок: наблюдать порядок child-start, а не считать порядок CLI-аргументов
доказательством планирования; локальный barrier не заменяет полный speed test.

### Metadata overlap sourcef0: 5 ноября 2026, приёмка pending

В `inspectCurrentSource` после прежней проверки входа, links и канонического
project одновременно запускаются root `rev-parse`, `ls-tree` закреплённого
supplied HEAD и первая guarded state. `Promise.allSettled` дожидается всех
ветвей; решения принимаются в прежнем порядке root → state → tree. Неверный
root остаётся unknown, а dirty state сохраняет приоритет над ошибкой tree.
Tracked bytes читаются только после валидных root и первой границы; весь
bounded byte loop и последующая state со своим новым config guard сохранены.
Это metadata-only overlap: status может обновлять Git index.

Новая регрессия `Source inspection overlaps real Git processes with exactly six commands and two fresh guards`
наблюдает настоящие PID/start/close без задержек или timing-only assertions.
На старом `f0c06014…`: RED exit1, peak1, ровно6 команд/config2; после узкой
коррекции: GREEN exit0, peak3, те же6/config2. Отдельные случаи проверяют
drainage отклонённых ветвей, root/dirty/tree precedence, malformed responses,
nonrepository, отсутствие раннего чтения bytes и свежую финальную границу.
Удержание close notification применяется только в изолированных built-in mocks;
оно не является benchmark или production injection port.

Единственная итоговая scoped команда на Node `v24.22.1`:

```powershell
node --test --test-reporter=tap tests/ci-graph.test.mjs tests/source-inspection-overlap.test.mjs tests/windows-speed-oracle.test.mjs tests/skill-pin-batch-oracle.test.mjs tests/project-director-oracle.test.mjs
```

Raw TAP/stderr, exit/command receipts, PID/process counts/drainage и SHA-256
четырёх файлов изменения и трёх frozen oracles сохраняются вне Git:
`C:/Users/zulut/AppData/Local/Kodo/runs/a54a324e-462b-4655-adc5-159f15a37ad3/source-overlap-evidence`.
Все83 прежних тестовых файла/тела и frozen3 сохранены; новый файл даёт84.
Default4, explicit1..8/hard8, Director60s, full1200000ms/20min, native/model
и меньшие saved budgets не изменены. Cache и сокращение числа запросов отсутствуют.

Парный BEFORE pilot координатора на f0: pause case1 PASS,19343.4761ms wall,
255 Git calls/13626.0221ms summed process wall, исходные60s сохранены.
Сумма child wall не является critical path. Прежний full на f0 завершился
20-минутным timeout и не превращается в PASS. Сокращение metadata critical
path с шести до примерно четырёх волн — гипотеза; whole-suite gain, завершённый
full AFTER и приёмка06 не заявлены. Paired AFTER pilot, integrated full,
fresh security/architecture, независимое review, CI и protected PR15 — у Root.
UI disabled — neutral; native client, published artifact и deployment не проверены.
Этапы07–13 остаются PLAN. Урок: доказывать overlap реальными start/close,
сохраняя порядок авторитетных решений и полный drain даже при ранней ошибке.

### Историческая scoped коррекция source821: 5 ноября 2026

В назначенном worktree `full-suite-order` независимый literal expected order
зафиксирован **до** изменения runner по полным66 файловым наблюдениям receipt.
Регрессия `Scheduler orders observed file durations longest first and retains every discovered file once`
содержит23 приоритетных имени, два неизвестных, перемешивание и дубликаты;
все проверки полного набора, discovery, input immutability и fallback сохранены.
На неизменённом runner821 получен assertion RED (`ERR_ASSERTION`, exit1,
0 PASS/1 FAIL), после правки только static priority/comments — GREEN (exit0,
1 PASS/0 FAIL). Raw TAP подтверждает различие порядка, а не setup failure.

Реальная child-start фикстура дополнена `architecture-cli`, `knowledge-cli`,
`knowledge-refresh`, `efficiency-engine`, `quality-runner`, `scheduling-engine`;
прежние имена, включая ранний лексический `tests/a.test.mjs`, сохранены.
Фикстуры короткие, их тела и deadline15s прежние; дорогие suite не запускаются.
Ожидания независимы от production priority; concurrency1 проверяет точный старт.

После узкого RED/GREEN выполнена ровно одна scoped suite, Node `v24.22.1`:

```powershell
node --test --test-reporter=tap tests/test-schedule.test.mjs tests/test-git-environment.test.mjs tests/ci-package.test.mjs
```

Результат: exit0, 58 tests, **56 PASS / 0 FAIL / 0 cancelled / 2 SKIP**,
25644.5634ms. Два существующих file-symlink SKIP обусловлены правами Windows;
directory-junction escape, Git metadata/status, package и child-start PASS.
Это доказательство scoped порядка и регрессий, не whole-suite gain.
Сырые TAP/stderr, команды, exit codes, полный mapping и current4/frozen3 SHA-256
сохранены вне Git:
`C:/Users/zulut/AppData/Local/Kodo/runs/504262c6-2d03-448b-905d-55189698bffe/full-suite-order-evidence`.

Все83 файла, default4, explicit1..8/hard8, isolation, draining/events/failures,
исходный Director60s и full deadline20min сохранены; cache не добавлен.
Root ещё должен выполнить integrated full, fresh security и architecture gates,
независимое review, CI и protected PR15. UI disabled — neutral.
Native client, published artifact и deployment здесь не проверялись.
Приёмка06 pending; этапы07–13 остаются **PLAN**, их реализация не начата.
Урок: текущие completed-file durations заменяют старый порядок, но нижнюю
границу случаев нельзя выдавать за длительность файла или обещание full PASS.

### Историческая scoped проверка порядка source88: 5 ноября 2026

В назначенном worktree `duration-order`, base
`88a9fadae1d226539802dfc7f788df47a39ae7ca`, Windows, Node `v24.19.0`,
до изменения priority добавлена независимая регрессия
`Scheduler orders observed file durations longest first and retains every discovered file once`.
Она передаёт все 17 приоритетных файлов (16 с измерениями и benchmark с отдельной
эвристикой) в перемешанном порядке, два неизвестных
файла и повторения абсолютного/относительного пути. Проверяются полный набор,
отсутствие дубликатов, неизменность input, default discovery, убывание известных
длительностей и лексический fallback. Ожидаемый порядок не читается из runner.

Фактически выполнены команды:

```powershell
node scripts/run-tests.mjs --test-name-pattern='Scheduler orders observed file durations' tests/test-schedule.test.mjs
node scripts/run-tests.mjs tests/test-schedule.test.mjs tests/ci-package.test.mjs
```

Первая команда до изменения priority: exit1, 0 PASS / 1 FAIL,
TAP duration 148.6661 ms; failure — несовпадение старого порядка с заданным.
После изменения priority та же команда: exit0, 1 PASS / 0 FAIL,
136.1799 ms. Это короткий RED/GREEN для новой регрессии, не замер полной suite.

Первый запуск второй команды: exit1, 11 PASS / 2 FAIL, 4740.7416 ms. Прошли новая регрессия,
package test, default discovery/strip-types, links, concurrency4/разные PID,
assertion/import/cancellation diagnostics, explicit selection, caps и abort.
Два существующих теста — `Scheduler starts heuristic heavy files before lexical files in real isolated children`
и `Scheduler deduplicates priorities and preserves deterministic lexical fallback` —
жёстко ожидали прежний порядок. После явного узкого уточнения координатора
обновлены только два literal expected-order arrays. Assertions, inputs,
child execution, проверки уникальности/полного набора и все остальные тела
существующих тестов сохранены. Исходный failure сохранён в `focused.tap`.
Это изменение ожидаемого порядка вслед за требованием, без ослабления проверки.

Повтор той же второй команды: exit0, 13 PASS / 0 FAIL / 0 cancelled /
0 skipped, 5945.5787 ms (`focused-green.tap`). Все существующие scheduler
assertions и package regression прошли. Полная suite и общий PASS по-прежнему
не заявлены; различие времени коротких прогонов не является speedup evidence.

После дополнительного уточнения про benchmark регрессия расширена до 17
приоритетных файлов. До добавления benchmark в priority первая команда снова
дала exit1, 0 PASS / 1 FAIL, 145.5035 ms (`benchmark-red.tap`): файл был
в лексическом хвосте вместо согласованной позиции. После минимального изменения
priority вторая команда дала exit0, 13 PASS / 0 FAIL / 0 cancelled / 0 skipped,
5582.7569 ms (`focused-benchmark-green.tap`). Два старых expected-массива больше
не менялись: их inputs не содержат benchmark. Первый GREEN сохранён отдельно.
Это проверка порядка короткими фикстурами; полный benchmark и speed test
не запускались, overall speed неизвестна.

Сырые `red.tap`, `green.tap`, `focused.tap`, `focused-green.tap`,
`benchmark-red.tap`, `focused-benchmark-green.tap` и JSON receipts с командами,
cwd, Node, source HEAD и exit codes сохранены вне Git:
`C:/Users/zulut/AppData/Local/Kodo/runs/1548713d-1cc5-4262-8ed3-fcd048485d75/duration-order-evidence`.
Изменены только priority/comment, новая регрессия, два согласованных expected
arrays и эта документация;
discovery/runTests/options/failure/cancellation, concurrency4, deadlines и
frozen oracles не менялись. Полная suite, модели, native provider, внешняя
публикация и deployment не запускались. Локальная упаковка в package regression
не является опубликованным артефактом. UI disabled — neutral; security и
интегрированные проверки остаются координатору.
Урок: при смене scheduling policy отдельно согласовать старые order literals;
сохранение assertions не делает противоречащие порядки одновременно истинными.

## Коррекция Phase06: текущая граница

Снимок 2026-11-05: corrective Run `7a424d6f-6392-483c-b1f8-6918824f0baf`,
исходный baseline `3c39de09eaca16997834c3de07f2e936072915a5`, интегрированный
source `0ee548b74413fba1c917eab4a49e12f6235869be` до этой документации.
Родительский Run `cf04d9ae-e733-48d6-8d7e-c29220084ef0` остаётся остановленным
на `verification3/cycle1`; его бюджет не сбрасывался. Это исправление blocker
приёмки06, не начало07 и не общий PASS. [Состояние приёмки](kodo-roadmap/phase-06.md).

### Что действительно наблюдалось

Один неизменённый сценарий `Trusted acceptance and owned Git restart preserve
the first local task file in the second reserved base` из
`tests/project-director.test.mjs` прошёл на baseline, Windows, Node `v24.19.0`.
Тело теста заняло 106764.2793 ms, TAP — 107045.5535 ms, внешняя команда —
107157.4236 ms. Наблюдались 1238 вызовов Git и 13 PowerShell; это число запусков,
не уникальных PID. Instrumentation overhead включён. Exposure sums вложенных
границ могут пересекаться и не складываются в wall time или экономию.
Распределение startup/Git work и причина общего timeout не установлены.

| Граница | Baseline | После коррекции | Уровень доказательства |
| --- | --- | --- | --- |
| Один успешный `inspectCurrentSource` | 8 Git-процессов: 6 основных + 2 защитных | 6: 4 основных + 2 защитных; scoped assertion требует ≤6 | Baseline RED, source и scoped Git-regressions; не замер полной suite |
| Тот же Director case целиком | PASS, 107157.4236 ms; 1238 Git, 13 PowerShell | PENDING | Нужен один сопоставимый coordinator-owned AFTER со всеми Git children |
| Общие Windows checks родителя | Две попытки остановлены по 20-минутному deadline | PENDING | Нет завершённого сопоставимого before/after |

Первоначальные «≤4 TOTAL» были ошибкой учёта координатора: он пропустил два
обязательных запроса имён filter config. Исправленный критерий — ≤4 CORE +
2 свежих protective queries = ≤6 TOTAL, baseline 8. Защитные запросы входят
в стоимость. Исходный frozen ports SHA-256
`ef35b50b39d5464dd63b50eaffc3822601709d8a470daba7a4f99d5b3fa173f9`;
уточнение `windows-perf-process-accounting-addendum-v1.md`, SHA-256
`8d988b9a7288094bea9f0a264337ebc3603b1727f098951346f20d81cd757372`,
меняет только числовой учёт, а не guards или бюджеты.

### Фактические изменения модулей

`runtime/ci-graph.mjs`: `inspectCurrentSource({project, headSha})` сохраняет
результаты `clean`/`dirty`/`unknown`. В каждом из двух наблюдений HEAD и dirty
status читаются вместе через `status --porcelain=v2 --branch -z`. Авторитетен
ровно один полный 40/64-символьный `branch.oid`; missing/duplicate/unborn/malformed
не становятся clean. Перед каждым status заново запрашиваются только имена
filter config и отключаются project filter drivers для этого child. Root/realpath,
hidden tracked-byte edits при assume-unchanged/skip-worktree, link/stat/size,
binary/mode/CRLF и обе source fences сохранены. Успешная проверка не кэшируется.
`runtime/project-director.mjs` удаляет только два отдельных дублирующих HEAD-вызова
в `validateRun`; обе полные source fences и lifecycle остаются.

`runtime/command.mjs`: `execute` фиксирует первую причину остановки:
`timeout`, `cancelled` или `invalid_output` с `reason: 'output_limit'`.
Поздний abort её не заменяет. На close ошибка получает очищенный `error.result`
с `stdout`, `stderr` (до 24000 символов каждый), nullable actual `code`,
`durationMs`, `outputTruncated`, `reason`. Полные и перекрывающиеся known secrets,
а также незавершённый известный prefix в конце capture очищаются до обрезки.
`rawOutput:true` не выдаёт сырой остановленный вывод; success/stdin поведение
сохранено. Потолки stdout `16 * 1024 * 1024` и stderr `4 * 1024 * 1024`
не увеличены; фактическая единица в этом executor — длина JS-строки, не UTF-8 байты.
Штатное завершение/дренирование owned child и Windows tree kill сохранены.

`Engine.checks`: execution failure добавляет failed row с `reason`,
`exitCode:null` и nullable actual `processExitCode`; сохраняет очищенное immutable
evidence с `outputPath`/`outputHash`, `complete:false` и предыдущие успешные rows,
затем пробрасывает исходную типизированную ошибку без следующей команды.
Сбой persistence не маскирует исходную ошибку; файл evidence/новая row тогда
не гарантированы, но неполная receipt не становится reusable/PASS.
Fresh source checks и exact-head/commands/runtime fingerprint для reuse сохранены.

`runtime/ci-cli.mjs`: фактический workflow использует `runCi`, чей catch теперь
публикует allowlisted profiler metadata и `diagnostic.stdoutTail`/`stderrTail`
до 4096 UTF-8 байт каждый, с отдельными `stdoutTruncated`/`stderrTruncated`.
Known secrets очищаются по всему capture до tail; строки остаются валидным UTF-8.
Метаданные: nullable nonnegative integer `exitCode`, nonnegative `durationMs`
(иначе elapsed fallback), boolean `outputTruncated` при наличии и ограниченный
очищенный `profilePath`. Catch receipt для timeout/cancel/overflow остаётся
`blocked`; общий результат имеет `complete:false`, даже при actual exit 0.
При другой failed receipt общий status может быть `failed`, но не `passed`;
отсутствующие результаты не выдумываются.
Profiler и `scripts/ci-profiler.mjs` не переписывались. Deadline `1200000` ms,
индивидуальные timeouts, file concurrency4, native capacity5 и меньшие saved
budgets сохранены. GPT/Claude по-прежнему работают через подписочные клиенты.

### Scoped checks и оставшиеся gates

Прямые зависимости сообщили: A — Git graph 54 PASS и один выбранный Director
regression; B — 32 targeted и 18 existing regressions PASS; C — 75 scoped CI CLI
tests PASS. Это локальные проверки, не required Windows/Linux CI.
Это отдельные scoped группы, не unique/full total; documenter их не перезапускал.
Независимый `tests/windows-speed-oracle.test.mjs` заморожен с SHA-256
`ad4033f1f7eb8084ec0201c083d460d69b4607e89a55e751054b3062c3a93bcc`.
Его baseline RED: 23 tests, 10 PASS, 13 FAIL, без skip/cancel, exit1 — подготовка
оракула, не feature PASS. Старый Director oracle `fa0a150b…` сохранён.
Root выполнил этот frozen oracle против clean code HEAD
`0ee548b74413fba1c917eab4a49e12f6235869be` до docs: actual scoped composite
23/23 PASS, 0 fail/skip/cancel, 36995.3723 ms, Node `v24.19.0`, Windows `win32`.
HEAD/source до и после неизменны. Приватная receipt:
`C:/Users/zulut/AppData/Local/Temp/kodo-roadmap-20261104/windows-perf-composite-0ee.json`;
TAP output SHA-256 `9e911063af851a31042fe86f8fe66c687f3b5249c9542d51ab8501f58e1d9c61`.
Это PRE-DOCS component proof, не полный check, общий PASS или основание reuse
на будущем HEAD после H. Documenter oracle не перезапускал.
Performance AFTER того же cost case выполняет только Root после стабилизации
H/native boundary; наблюдения AFTER пока нет. Полный `npm run check`, required
Windows/Linux CI, fresh configured security и независимое итоговое review
остаются PENDING. UI verification disabled — neutral, не PASS. Native provider,
installed/published artifact, merge/release/deployment здесь не подтверждаются.

Приватная provenance: `speed-five/windows-perf/diagnosis.md` и
`windows-perf-receipts/{git-observations,stopped-check-evidence,windows-speed-oracle}`
в `C:/Users/zulut/AppData/Local/Temp/kodo-roadmap-20261104/`; frozen ports/addendum
находятся в `C:/Users/zulut/AppData/Local/Kodo/runs/7a424d6f-6392-483c-b1f8-6918824f0baf/`.
Наблюдения сокращения процессов не доказывают глобальное ускорение, pure LLM
latency, HTTP/token/quota расход или subscription USD. Benchmark не проводился.

Урок: считать защитные subprocesses вместе с основными; оптимизировать повторные
наблюдения без ослабления fences. При остановке сохранять очищенный partial
вывод и первую причину, сохраняя incomplete/nonpassing статус.

## Историческое разбиение Engine-тестов Phase03

Далее сохранён scoped draft и измерения 4 ноября; его границы относятся к тому
прогону, а не к текущей приёмке06. [Позднейшая приёмка03](kodo-roadmap/phase-03.md).

## Требования и границы

Исходный `tests/engine.test.mjs` содержит 43 независимых верхнеуровневых теста.
Node выполняет их последовательно внутри одного файла. Разбиение на четыре
обнаруживаемых файла позволяет штатному runner выполнять разные файлы параллельно.
Порядок сценариев внутри каждого файла сохранён относительно исходного файла.
Распределение использует частичные наблюдения исходного scoped-прогона: 40 из
43 сценариев завершились до отмены по решению координатора для освобождения
heavy-слота. Для трёх ещё не наблюдённых сценариев при распределении использована
медиана наблюдавшихся длительностей. Это эвристика распределения, не измерение
ускорения. Число сценариев по файлам: 9, 12, 11, 11.

Общая фикстура находится в `tests/helpers/engine-fixture.mjs`. Модуль не импортирует
`node:test`, не регистрирует тесты и не создаёт временные проекты при импорте.
Его имя не соответствует стандартному шаблону `*.test.mjs`. Каждый вызов фикстуры
по-прежнему создаёт собственный временный Git-проект и Store, регистрирует исходный
`t.after`, закрывает Store и удаляет только проверенный временный каталог.

Переносятся точные тела тестов и определения helper-функций. Имена, assertions,
вложенные `t.test`, setup/teardown, сценарии прерывания, задержки и таймауты не
меняются. Runtime, package scripts, skips и правила отбора тестов не меняются.
Существующий `tests/engine-delivery-contract.test.mjs` остаётся отдельной проверкой.

## Scoped-команда

Из корня worktree, Node 24:

```powershell
node --test --test-concurrency=4 tests/engine.test.mjs tests/engine-2.test.mjs tests/engine-3.test.mjs tests/engine-4.test.mjs
```

Это все четыре части исходного файла, без фильтрации по именам тестов.
В историческом прогоне `npm test` использовал `node --test` и автоматически
обнаруживал новые `*.test.mjs`. Текущий runner и потолок4 описаны в начале
документа; изменение общей concurrency CI требует полного gate координатора.

## Проверка сохранности и измерения

Приватные receipts сохраняются вне Git. Инвентарь содержит исходное literal-имя,
файл/строку, SHA-256 точного исходного блока и число вызовов `assert.*`. Сравниваются
полные блоки, а не только количество тестов: так учитываются также вложенные
сценарии и assertions внутри записываемых fixture-скриптов. Исходный инвентарь
содержит 43 верхнеуровневых блока и 446 вхождений вызовов `assert.*` в этих блоках;
это статический счётчик вхождений, а не число runtime assertions. Определения десяти
общих helpers сравниваются побайтно отдельно, включая cleanup и fake providers.
Проверяется, что весь исходный код вне импортов учтён этими блоками.

Структурная RED-проверка до переноса ожидает четыре файла и получает один.
GREEN требует одновременно совпадения инвентаря, сохранения helpers и четырёх
файлов. Raw TAP и события штатного Node test runner сохраняются отдельно для
исходной попытки и итогового прогона; обёртка сохраняет command/args, HEAD, Node,
OS/arch, время начала/окончания, wall time и настоящий exit code.

Исходная попытка на Windows с concurrency 4 отменена после 40 из 43 сценариев
из-за contention с обязательным phase-02 `npm run check`. Частичные TAP/events и
отдельная cancellation receipt сохранены; эта попытка не является PASS или полным
before baseline. Итоговый scoped-прогон выполнен после освобождения heavy-слота.
Сравнимого завершённого before/after замера нет, поэтому ускорение не заявляется.
CPU и I/O всего дерева дочерних процессов не собраны: такие значения остаются
неизвестными.
Тайминги отдельных тестов сами по себе не доказывают причину затрат на ACL,
антивирус, Git или SQLite.

Исторические 606507 ms всей phase-02 suite — только контекст. Они не являются
baseline этого scoped-прогона и не используются для расчёта ускорения.

## Наблюдавшийся AFTER

4 ноября 2026, Node `v24.19.0`, Windows `win32/x64`, исходный HEAD
`1574a3c1b022e9e746326ca297cf89f0bf0d43a6` с изолированными изменениями тестов.
После отдельного разрешения координатора на heavy-слот выполнен один scoped-прогон
с concurrency 4. Начало: `14:32:54.487 UTC`, окончание: `14:35:11.918 UTC`.
`after.start.json` и `after.receipt.json` содержат SHA-256 входных файлов и имена
сценариев для точной привязки к фактически проверенному worktree.

| Файл | Верхнеуровневые сценарии | С вложенными тестами | File wall time, s |
| --- | ---: | ---: | ---: |
| `tests/engine.test.mjs` | 9 | 13 | 131.449 |
| `tests/engine-2.test.mjs` | 12 | 16 | 132.861 |
| `tests/engine-3.test.mjs` | 11 | 17 | 127.700 |
| `tests/engine-4.test.mjs` | 11 | 15 | 137.136 |

Длительности взяты из четырёх событий Node `test:summary` с фактическим `file`,
а не из суммы durations отдельных тестов. Наблюдавшийся критический путь файлов —
137.136 s; wall time команды — 137.420 s. Raw итог: 61 tests, 61 pass,
0 fail/cancelled/skipped/todo; exit 0. Все 43 исходных верхнеуровневых имени
выполнены ровно по одному разу. Это абсолютные локальные наблюдения AFTER,
без утверждения о коэффициенте ускорения.

В приватном каталоге receipts сохранены `after.tap`, `after.events.jsonl`,
`after.receipt.json`, `run-validation.json`, `inventory.before.json`,
`inventory.after.json`, `inventory.equality.json`, `before-ready.cancelled.json`,
частичные исходные TAP/events и исходная копия файла. Проверка инвентаря прошла;
пробные удаление assertion/сценария/cleanup и переименование literal-имени были
обнаружены. Синтаксис всех пяти JS-модулей и `git diff --check` также прошли.

## Приёмка

Это изолированный phase-03 draft. Полный интегрированный `npm run check`,
независимое differential review, Windows/Linux CI, package smoke, native provider
checks, публикация и deployment здесь не выполняются. Интеграция и доставка
остаются последовательными; phase-03 нельзя принимать до приёмки phase-02.

Урок: для уменьшения критического пути сначала измерять длительности файлов и
сценариев, затем распределять независимые тесты по времени. Размер исходника и
историческое время всей suite не заменяют scoped before/after evidence.
