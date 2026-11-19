# Независимая проверка поведения

Этап 09 добавляет к локальным проверкам, gates и ревью детерминированную проверку итогового commit, которую отчёт модели не может отменить. Решения описаны в [ADR-0011](decisions/0011-behavior-gate.md).

Порядок проверки одного head не изменился, в него добавлен один шаг:

```
локальные проверки (test, build) → behaviour gate → UI / security / architecture → независимое ревью
```

Ревью запускается, только когда всё до него прошло. Сбой behaviour gate обрабатывается как сбой проверки: ограниченный ремонт в пределах `repairRounds`, затем `blocked`.

## Настройка

```json
{
  "verification": {
    "baseline": false,
    "testProtection": true,
    "strictGates": false,
    "oracles": [
      { "id": "git-blob", "command": "node", "args": ["oracle/git-blob.mjs"], "protect": ["oracle/**"] }
    ]
  }
}
```

Блок необязателен. Без него действует только защита тестов. Неизвестные ключи отклоняются.

| Ключ | По умолчанию | Смысл |
| --- | --- | --- |
| `testProtection` | `true` | Запретить удаление и выключение существующих тест-кейсов (сверка по именам) |
| `testRemovalAllowed` | `[]` | Пути тестов (glob), которые этому запуску разрешено удалить или сократить |
| `oracles` | `[]` | До 8 команд-оракулов проекта с защищёнными путями |
| `baseline` | `false` | Прогнать команды проверки на базовом commit до правок |
| `strictGates` | `false` | Считать сбоем gate, который нужен изменению, но выключен |

## Защита тестов

Защита сверяет тест-кейсы по именам. Для каждого изменённого файла тестов, который существовал на базе, читаются обе версии. Исходник разбирается с учётом строк и комментариев: закомментированный тест кодом не считается, `/*` внутри строки комментарий не открывает, а код тестов, процитированный в строке (fixture), тестом не является.

| Правило | Когда срабатывает |
| --- | --- |
| `test_deleted` | Файл с тест-кейсами удалён или переименован в путь, который не похож на тест, и его кейсов больше нет ни в одном изменённом файле тестов |
| `tests_removed` | Кейс с таким именем был на базе, а в изменённых файлах тестов его больше нет |
| `test_skipped` | Кейс, который выполнялся на базе, больше не выполняется. Пропуск стоит на нём самом: `.skip`, `.only`, `.todo`, `.fixme`, `xit`, `test.skipIf(…)`, объект опций с `skip:` или `todo:` (кроме `false`), сокращение `{ skip }`, декоратор `skip`/`xfail`/`expectedFailure`, атрибут `#[ignore]`, `@Disabled`. Или на его группе, классе, модуле: `describe.skip`, `xdescribe`, `describe('…', { skip: true })`, `test.describe.skip`, декоратор над классом Python, `pytestmark` с пропуском на уровне модуля или класса (в том числе список на нескольких строках), `@Disabled` над классом. Также: в файл с существующими кейсами добавлен `.only` на кейс или группу; в файл, не получивший новых кейсов, добавлен вызов пропуска внутри теста (`t.skip()`, `pytest.skip()`, `t.Skip()`, в Playwright `test.skip(условие, 'причина')` и `test.fixme()`) |

Что из этого следует:

- **Перенос, разделение и переименование файла** не удаление: кейс с тем же именем нашёлся в другом изменённом файле.
- **Удаление нельзя прикрыть новыми тестами.** Кейс `subtracts` считается удалённым, сколько бы других кейсов ни добавили.
- **Новый тест с пропуском** (например, `{ skip: process.platform !== 'win32' }`) не нарушение: на базе его не было. Слово `skip` в данных теста пропуском не считается: смотрится только объект опций сразу после имени кейса.
- **Включение теста** не нарушение: снятие `.skip`, `skipIf` или пропуска с группы проходит. Пропущенный тёзка работающего кейса (новый `it.todo` с тем же именем) тоже.
- **`.only` в файле, где все кейсы новые**, не отклоняется: существующие тесты от него не останавливаются.
- **Переименованный кейс** выглядит как удалённый старый и добавленный новый, и это отклоняется. Отличить честное переименование от замены теста по именам нельзя.
- Кейсы с именем-выражением (`test(name, …)`) считаются поштучно по всем изменённым файлам; их число не должно уменьшиться.

Меньшее число утверждений запуск не останавливает: оно записывается в `warnings` квитанции.

Чтобы удалить устаревший тест вместе с удалённым кодом или переименовать кейс, запуск создают с явным разрешением для конкретных путей:

```json
{ "verification": { "testRemovalAllowed": ["tests/legacy/**"] } }
```

Удаление по разрешению не останавливает запуск, но остаётся в квитанции в списке `allowed`. Разрешение относится только к удалению: добавленный пропуск по-прежнему отклоняется. Путь в разрешении — путь файла на базе.

Чего защита не видит:

- тело теста, опустошённое под прежним именем; ранний `return`, `if (false)`, `assert.ok(true)`, утверждение, заменённое более слабым;
- формы пропуска, которых нет в таблице выше: пользовательские обёртки, опции в переменной (`test('имя', options, …)`), объект опций с вложенными фигурными скобками, `fit` и `fdescribe`, `t.Run` в Go;
- кейсы с именем-выражением: они сверяются только числом по всем изменённым файлам, поэтому удалённый можно прикрыть добавленным;
- пропуск существующего кейса, рядом с которым добавлен работающий тёзка (`test('adds', …)` и `test.skip('adds', …)`): имя по-прежнему выполняется;
- редкие формы группового пропуска: опции у группы с именем-выражением (`describe(name, { skip: true }, …)`), `{ only: true }` в опциях, `describe.skip.each(…)`, `.only` в файле, где все кейсы названы выражениями;
- файлы тестов, которые не узнаются по пути. Тестом считается файл в каталоге `test/`, `tests/`, `__tests__/` или `spec/`, либо с именем `*.test.*`, `*.spec.*` (JS/TS), `*_test.go`, `*_test.py`, `*_test.rs`, `test_*.py`. Тесты Rust внутри `src/*.rs`, файлы `*.cy.ts`, каталоги `e2e/` и `integration/` не проверяются;
- код, на котором разбор JS/TS ошибается: регулярное выражение сразу после `)` (`if (x) /re/.test(y)`) и JSX с обратной кавычкой в тексте могут скрыть от разбора остаток файла;
- подтесты и параметризованные кейсы, чьё имя не литерал сразу после `test(`/`it(`/`t.test(`: `it.each([...])('имя', …)`, обёртки над runner;
- файлы тестов на языках, кроме JS/TS, Python, Rust, Go, Java и Kotlin. Если такой файл назван как тест (`*.test.*`, `*_test.*`, `test_*`), он попадает в `unchecked`;
- файлы больше 256 КБ и нечитаемые: они перечислены в `unchecked`. Удаление такого файла всё равно даёт `test_deleted`;
- переименование внутри каталога тестов в имя, которое runner не подхватывает;
- конфигурацию runner и скрипт `test` в `package.json`.

Защита также бывает строже нужного. Удалённый файл с кодом тестов в каталоге тестов считается удалённым тестом, даже если это fixture: для него нужно разрешение `testRemovalAllowed`. `@Disabled` над любым классом файла Java или Kotlin читается как пропуск всех тестов файла. Новый пропущенный кейс с именем-выражением (`test.skip(title, …)`), добавленный в файл без других новых кейсов, неотличим от вызова пропуска в теле теста и отклоняется. Разрешение `testRemovalAllowed` не снимает `test_skipped`: если у кейса, удаляемого по разрешению, есть пропущенный тёзка в другом изменённом файле, запуск остановится. В файле с JSX апостроф или `//` в тексте разметки могут сбить разбор, и тогда новая пропущенная группа считается охватывающей остаток файла. В Rust функция под `#[cfg(test)]` считается тестом, а `]` внутри строки атрибута и блочный комментарий между `#[test]` и `fn` скрывают тест от разбора: его правка выглядит как удаление.

Эти случаи остаются на проверках проекта, оракулах и ревью. Для Rust и Go имена ищутся по исходному тексту без удаления комментариев, поэтому закомментированный там тест считается существующим. В Java и Kotlin, как и в JS/TS и Python, строки и комментарии кодом не считаются; имена тестов Kotlin в обратных кавычках читаются. Аннотации относятся к ближайшему следующему объявлению `void имя(` или, только в Kotlin, `fun имя(`, а `;`, `{`, `}`, `val` и `var` их сбрасывают. Аргументы аннотации пропускаются до парной скобки; если после `@` в коде осталась непарная `(` (например, `this@T.check("… ${f("(")} …")` в Kotlin), остаток файла не читается.

## Оракулы поведения

Оракул — команда проекта, которая проверяет поведение независимо от реализации: контрактные тесты, сравнение с эталонным инструментом, защищённые fixtures. Координатор запускает её на итоговом commit в чистом worktree.

- Ненулевой код возврата — сбой с выводом оракула в причине ремонта.
- Оракул, который не завершился (таймаут, не найден исполняемый файл), — тоже сбой, и его evidence сохраняется. Незавершённая проверка ничего не доказывает.
- Оракул только наблюдает. Если после него рабочее дерево изменилось, это сбой `oracle_dirty_worktree`, и следующие оракулы не запускаются.
- Пути из `protect` обязаны совпадать с базой байт в байт. Если реализация изменила оракул, он не запускается, а изменение даёт сбой `oracle_modified`.
- Вывод сохраняется как evidence `oracle-<sha256>.json`.
- `protect` должен покрывать всё, от чего зависит вердикт оракула: его скрипты, fixtures, конфигурацию runner и npm-скрипты, которые он вызывает. Kodo защищает только перечисленные пути.

Пример из тестов: оракул вызывает установленный `git hash-object --stdin` и сравнивает результат с функцией проекта. Реализация без заголовка `blob <size>\0` компилируется, проходит ревью-заглушку, но оракул её останавливает; после одного ремонта запуск завершается успешно.

## Политика по типу изменения

Тип изменения выводится из изменённых путей, без модели:

| Тип | Примеры путей | Нужный gate | Риск |
| --- | --- | --- | --- |
| `style` | `*.css`, `*.scss` | `ui` | низкий |
| `content` | `*.md`, `*.rst`, `LICENSE` | — | низкий |
| `tests` | `tests/`, `*.test.*` | — | низкий |
| `code` | всё остальное | — | средний |
| `api` | `api/`, `routes/`, `*.proto`, `openapi*.yaml` | `architecture` | средний |
| `config` | `package.json`, lock-файлы, `kodo.config.json` | `security` | средний |
| `schema` | `migrations/`, `*.sql` | `oracle` | высокий |
| `security` | `auth*`, `crypto*`, `permissions`, `secrets` | `security` | высокий |
| `ci`, `release` | `.github/workflows/`, `CHANGELOG`, `scripts/release*` | `security` | высокий |

Локальные проверки и ревью нужны всегда. Нужный, но выключенный gate записывается в `policy.gaps` как пробел: `disabled` не равен PASS. По умолчанию пробел только отражается в квитанции; при `strictGates: true` он останавливает запуск правилом `required_gate_disabled`. Такую остановку не может исправить сессия ремонта, поэтому запуск останавливается сразу с кодом `behavior_blocked`, без расхода раундов, даже если вместе с ней найдены исправимые находки. Конфигурация запуска зафиксирована при его создании: чтобы продолжить, нужен новый запуск с включённым gate или без `strictGates`.

Политика знает только пути. При `strictGates` учитываются и изменения самого координатора: релизный commit версии меняет `package.json`, это тип `config`, которому нужен security gate.

## Базовый прогон

При `baseline: true` команды `test` и `build` один раз выполняются на нетронутом базовом commit до первой правки. Результат сохраняется в `run.baseline` и используется только для пометки:

| Пометка | База | Итог |
| --- | --- | --- |
| `regression` | прошла | упала |
| `pre_existing` | упала | упала |
| `fixed` | упала | прошла |
| `unchanged` | прошла | прошла |

Команда базы, которая не завершилась, ничего не говорит о базе: пометки нет (`no_baseline`). Если база запуска изменилась после синхронизации с целевой веткой, прежний базовый прогон к ней не относится и пометок не даёт.

Пометка добавляется в текст сбоя и в `run.checks.comparison`. Старая ошибка не игнорируется: проверка по-прежнему не пройдена, но причина ремонта говорит, внесена ли она изменением. Сравнение идёт на уровне команды, а не отдельного теста. Базовый прогон удваивает время проверок, поэтому выключен по умолчанию.

## Квитанция

`run.behavior` привязана к точным head, базе и хэшу блока `verification`:

```json
{
  "schemaVersion": 1,
  "headSha": "…",
  "baseSha": "…",
  "configHash": "…",
  "status": "passed",
  "passed": true,
  "policy": { "risk": "low", "types": ["style"], "required": ["checks", "review", "ui"], "gaps": [{ "gate": "ui", "reason": "disabled" }] },
  "repairable": true,
  "findings": [],
  "allowed": [],
  "warnings": [],
  "unchecked": [],
  "oracles": [{ "id": "git-blob", "status": "passed", "exitCode": 0, "outputHash": "…" }]
}
```

`isCurrentBehaviorReceipt` принимает квитанцию только для того же head, той же базы и той же конфигурации. Каждый раунд проверки строит её заново.

## Профили task-fast и gate run

Большой «волновой» проект проверяется на двух уровнях. Мелкая задача проходит быстрый профиль `task-fast`; полная проверка (все команды, behaviour gate, UI/security/architecture, одно независимое ревью всего diff и `commands.smoke`) выполняется один раз на границе эпика, в отдельном gate run.

```
задача:  быстрые проверки затронутого → behaviour gate
гейт:    test + build → behaviour gate → UI / security / architecture → ревью всего diff эпика → smoke
```

Поля Run:

| Поле | Смысл |
| --- | --- |
| `verificationProfile: 'task-fast'` | Быстрый профиль. Нет поля — прежняя проверка без изменений |
| `fastChecks: { timeoutMs }` | Жёсткий таймаут каждой быстрой команды, по умолчанию 120000 мс |
| `executor: { kind: 'external', host: 't3' \| 'orca' }` | Задачу делает внешний чат, не Engine |
| `directorBinding.kind: 'gate'` | Gate run эпика |

### task-fast

План строится как L1 у `kodo ci` (`runtime/task-fast-checks.mjs`, `planFastChecks`): `node --check` каждого затронутого JS-файла и `node --test` затронутых тест-файлов по графу `planAffected`. Полный `commands.test` выполняется вместо узкого плана, если:

| Причина | Когда |
| --- | --- |
| причины графа (`config-change:…`, `package-change:…`, `unknown-file-or-config:…`, `dirty-worktree` и др.) | Граф не может сузить набор тестов |
| `graph-error` | Граф не построен |
| `no-affected-tests` | Изменение не затронуло ни одного теста |
| `runner-not-node-test` | `commands.test` — не `node --test` |
| `runner-multiple-commands`, `runner-not-configured` | Команд проверки не одна |
| `runner-selection` | У `node --test` есть опция отбора тестов (`--test-shard`, `--test-name-pattern`, `--test-skip-pattern`, `--test-only`): после сужения она может не оставить ни одного теста |
| `runner-options` | У `node --test` есть опция без `=` или glob в пути: сузить без потери смысла нельзя |
| `no-tests-executed` | Узкий прогон завершился с кодом 0, но не прошёл ни одного теста (по событиям репортёра Kodo 0 — только `skip`/`todo` или нет тестов — либо счёт неизвестен) |

Позиционный путь у `node --test` (например, `tests/unit`) ограничивает узкий набор этим каталогом; опции вида `--name=value` сохраняются. Опции репортёра сужению не мешают: Kodo заменяет их при исполнении (см. «Подсчёт тестов `node --test`»). Сборка (`commands.build`), гейты и ревью в этом профиле не выполняются.

#### Подсчёт тестов `node --test`

Каждую засчитываемую команду `node --test` волнового проекта (узкий прогон и полный fallback `task-fast`, полные проверки gate Run), а также npm-скрипт, разрешённый в такую команду (см. «npm-скрипт `node --test`»), Kodo исполняет с нормализованными репортёрами (`countingArguments` в `runtime/task-fast-checks.mjs`): опции репортёра команды (`--test-reporter`, `--test-reporter-destination`, в обеих формах) удаляются, впереди добавляются `--test-reporter=<spec|tap> --test-reporter-destination=stdout --test-reporter=<file URL runtime/test-count-reporter.mjs> --test-reporter-destination=<файл событий>`, остальные аргументы сохраняют порядок. Диагностический репортёр на stdout — единственный `spec` или `tap` команды, иначе `spec`. Файл событий создаётся в новом приватном каталоге `kodo-test-events-*` системного временного каталога (вне проекта), читается после завершения команды (не больше 64 MiB) и удаляется.

Репортёр Kodo (`runtime/test-count-reporter.mjs`) пишет по одной JSON-строке на событие `test:pass`/`test:fail`: `type`, `kind` (`details.type`: `test` или `suite`), `nesting`, `line`, `column`, `skip`, `todo` — без имён тестов и путей (маскирование журнала не может изменить запись), и последней строкой `{"type":"end"}`, когда поток событий закончился. Счёт (`countTestEvents`, версия `TEST_COUNT_VERSION = 4`) — число событий `test:pass` с `kind: 'test'`, без `skip`/`todo` и без заглушки Node для файла или каталога без тестов: верхний уровень (`nesting` 0) в позиции 1:1, как бы ни был указан путь (включая `../` из подкаталога). Ограничение: настоящий тест верхнего уровня, объявленный ровно в позиции 1:1, тоже не считается — счёт может только уменьшиться. Файл событий создаётся в собственном каталоге Kodo (`<KODO_HOME>/test-events/run-*`), а не во временном каталоге команды: `TEMP` тестов (в том числе внутри проекта или относительный) не затрагивается; если каталог состояния Kodo внутри проекта — рабочего дерева проверки или исходного checkout, по реальным путям (с учётом junction и симлинков, до и после создания каталога) — отказ `fast_check_events_location`. Файл событий отсутствует, битый, неполный (нет строки `end`) или больше лимита — счёт неизвестен (`tests: null`). Текст stdout для счёта не используется.

Строка квитанции хранит и настроенную, и исполненную команду: `command`/`args` — как в плане (узкий план или `commands.test`), по ним сверяются fingerprint, план и журналы; `executed: { command, args }` — фактически исполненная команда с репортёрами Kodo (в `args` — путь уже удалённого файла событий). Ещё в строке — `countVersion` и `tests`; журнал evidence строки хранит `executed`, `countVersion` и содержимое файла событий (`testEvents`). `nodeTestOutcome(step, observed)` пересчитывает итог по журналу: `null` для не-`node --test`, `{ tests: null }` для команды, которую нельзя подсчитать (опции отбора, неизвестные опции) или чьё `executed` не равно `countingArguments(step.args, <записанный файл событий>)`, иначе `countTestEvents(testEvents)`.

После каждой засчитываемой команды число пишется в строку (`tests`).

- Узкий прогон с нулём или неизвестным счётом не даёт зелёной квитанции и не попадает в кэш: квитанция пересоздаётся с `fallback: true, reasons: ['no-tests-executed']` и полным `commands.test`, в журнал Run пишется событие `fast_checks_no_tests`.
- Полный прогон (любой fallback, включая `no-tests-executed`): если все команды `commands.test` — засчитываемые `node --test` и вместе они не прошли ни одного теста (подтверждённая сумма 0), квитанция остаётся `complete: false`, а проверка падает с кодом `fast_check_no_tests` — обычный сбой проверки, который чинится циклом ремонта. Для нескольких команд считается сумма: команда, где всё пропущено, допустима, если другая прошла тесты.
- Полный прогон, где команда `node --test` завершилась с кодом 0, но её счёт неизвестен (журнал событий отсутствует, битый или неполный), тоже не даёт зелёной квитанции: `complete: false`, код `fast_check_summary_unknown`. Опции отбора (`--test-name-pattern`, `--test-skip-pattern`, `--test-only`, `--test-shard`) делают счёт ненадёжным — фильтр без совпадений может засчитать сам файл как пройденный тест, — поэтому такие команды в волновом проекте счёта не дают (`fast_check_summary_unknown` / `gate_check_summary_unknown`). Аргументы `node` разбираются как в самом Node: имена опций нормализуются (`_` как `-`), опции со значением забирают следующий аргумент (`--test-reporter tap`, `--import x`), разбор останавливается на скрипте или `--`, а аргументы после скрипта принадлежат ему (`node verify.mjs --test=true` — не тестовый раннер). Тестовым раннером считается любой `--test` или `--test=<значение>`, включая `--test=false`: Node 24 запускает раннер и для него. Засчитывается только команда из известных и разрешённых опций (`countableOptions` в `runtime/task-fast-checks.mjs`: опции репортёра — их Kodo заменяет, порядок и таймауты, загрузчики, покрытие и т. п.); любая неизвестная опция, фильтр (`--test-name-pattern`, `--test-skip-pattern`, `--test-only`, `--test-shard`, `--experimental-test-tag-filter`, `--test-rerun-failures`) или watch-режим дают неизвестный счёт. Если после неизвестной опции встречается `--test`, команда считается тестовым раннером с неизвестным счётом. Команда с опциями покрытия не сужается до затронутых файлов: порог покрытия относится ко всему набору. `--env-file` счёта не даёт (файл может задать `NODE_OPTIONS`), а `NODE_OPTIONS` окружения в проверки волнового проекта не передаётся: действуют только опции, записанные в команде.
- Ограничение: вывод других раннеров (произвольная команда `commands.test`, npm-скрипт, который не разрешается в `node --test`, vitest и т. п.) не разбирается. Если среди команд полного прогона есть хотя бы одна такая, решает её код выхода, как раньше; строки `node --test` рядом с ней получают `tests`, подтверждённый ноль такой строки квитанцию не валит, а неизвестный счёт валит (`fast_check_summary_unknown`).

#### npm-скрипт `node --test`

Команда проверки волнового проекта, которая запускает один скрипт `package.json`, — `npm test` (`npm t`, `npm tst`) или `npm run <имя>` (`run-script`, `rum`, `urn`), на Windows также `npm.cmd`, без опций npm и аргументов для скрипта — разрешается в эквивалентную команду Node (`resolveNpmScript` в `runtime/task-fast-checks.mjs`). `package.json` читается сырыми байтами из Git в проверяемом коммите (`git ls-tree` и `git cat-file`, как `kodo.config.json` в политике волнового Run), а не из рабочего дерева; файл, который не является обычным файлом, не разрешается. Условия:

- скрипт `<имя>` — строка `node <аргументы>`: слова через пробелы из символов `A–Z a–z 0–9 _ @ + = : , . / -`, без пробелов в начале и в конце. Кавычки, `\`, `$`, `%`, `~`, `*`, `?`, `[`, `]`, `{`, `}`, `&`, `|`, `;`, `<`, `>`, обратная кавычка, скобки, `!`, `^`, `#`, табуляция и перевод строки исключают разрешение: sh и cmd.exe толкуют их по-разному;
- нет скриптов `pre<имя>` и `post<имя>` (npm запускает их вокруг основного);
- команда `node` с аргументами скрипта засчитывается (`countedRunner`): тестовый раннер, только разрешённые опции, без отбора тестов, watch-режима и `--env-file`.

Тогда Kodo не запускает npm: он исполняет `process.execPath` с аргументами скрипта и своими репортёрами (`countingArguments`), как прямой `node --test`, и считает тесты по событиям. Строка квитанции хранит настроенную команду (`npm test`: в task-fast — `command`/`args`, в gate Run — `command`), `resolved: { script, text }` (имя и строка скрипта), `executed`, `countVersion` и `tests`; журнал evidence — также `resolved` и `testEvents`. Ноль и неизвестный счёт обрабатываются как у прямого `node --test`: `fast_check_no_tests` / `fast_check_summary_unknown` в task-fast, `gate_check_no_tests` / `gate_check_summary_unknown` в gate Run. Сужение task-fast к npm-скрипту не применяется (`runner-not-node-test`): выполняется полный `commands.test`.

Валидатор волнового Run (`assertTestCounts` в `runtime/project-director.mjs`) читает `package.json` проверенного коммита (`run.headSha`) сырыми байтами из Git и разрешает настроенную команду по тем же правилам. `resolved` строки и её журнала должен совпасть с результатом (или отсутствовать, если скрипт не разрешается), `executed` журнала должен быть ровно `countingArguments` разрешённой команды с `process.execPath`, а `tests` пересчитывается по `testEvents`. Расхождение — `project_gate_tests_uncounted` / `project_fast_tests_uncounted`. Повторное использование квитанции gate Run требует той же `resolved`, `tests > 0` и текущего `countVersion`; квитанции прежних версий (npm-скрипт по коду выхода) не переиспользуются.

Ограничения:

- Скрипт любого другого вида — другой раннер (`vitest`, `jest`), цепочка shell (`node --test && …`), подстановки, кавычки, `pre`/`post`-скрипты, опции отбора или неизвестные опции — по-прежнему исполняется через npm и оценивается только по коду выхода: число тестов не проверяется, `tests` в строке нет.
- Разрешённая команда исполняется без npm: переменные `npm_*`, настройки `.npmrc` (`node-options`, `script-shell`) и `node_modules/.bin` в `PATH` на неё не действуют, `node` — тот Node, под которым работает Kodo.
- `executed` разрешённой команды содержит `process.execPath`: валидатор, запущенный другим исполняемым файлом Node, её не подтвердит (так же `fingerprint` полной квитанции привязан к версии Node).

Квитанция `run.checks`:

```json
{
  "schemaVersion": 2,
  "profile": "task-fast",
  "headSha": "…",
  "fingerprint": "…",
  "plan": { "changed": ["src/a.mjs"], "affected": ["src/a.mjs", "tests/a.test.mjs"], "testFiles": ["tests/a.test.mjs"], "fallback": false, "reasons": [] },
  "complete": true,
  "results": [{ "kind": "test", "command": "…/node", "args": ["--test", "tests/a.test.mjs"], "exitCode": 0, "durationMs": 812, "executed": { "command": "…/node", "args": ["--test-reporter=spec", "--test-reporter-destination=stdout", "--test-reporter=file:///…/runtime/test-count-reporter.mjs", "--test-reporter-destination=…/kodo-test-events-…/events.jsonl", "--test", "tests/a.test.mjs"] }, "countVersion": 4, "tests": 2, "evidence": { "path": "…", "sha256": "…", "bytes": 1234, "headSha": "…" } }]
}
```

- Каждая команда ограничена `fastChecks.timeoutMs`; превышение — сбой `fast_check_timeout` с сохранённым выводом. Заданный у команды меньший `timeoutMs` сохраняется.
- Вывод каждой команды — evidence `fast-check-<sha256>.json`; у засчитываемой `node --test` в нём также `executed`, `countVersion` и `testEvents`. `fingerprint` квитанции включает `countVersion`.
- Повторное использование: только при `fallback: false` и чистом дереве, через приватный кэш `ci-cache` (`home` = каталог хранилища), для команды `node --test`, прошедшей хотя бы один тест без skip/todo. Ключ кэша содержит `countVersion` (`TEST_COUNT_VERSION`): записи прежних алгоритмов (`passedTests: true`, `executedTests: true`) не совпадают. Перед повтором Kodo пересчитывает тесты по `testEvents` кэшированного журнала (`nodeTestOutcome`); журнал без полного файла событий или с нулём не переиспользуется. Строка из кэша помечена `cached: true`, получает `executed`, `countVersion`, `tests` из журнала и ссылается на исходный полный вывод. Проверки синтаксиса дешёвые и выполняются всегда.
- Дочерний runner не наследует `NODE_TEST_CONTEXT`: иначе вложенный `node --test` пропускает все файлы и завершается с кодом 0.
- Квитанция `task-fast` никогда не заменяет полную. Её `fingerprint` вычисляется в своём домене, evidence имеет kind `fast-check`, а строки — другую форму. Все полные валидаторы отвергают любую профилированную квитанцию (ключ `profile` с любым значением) и Run с `verificationProfile`, даже с полными журналами и legacy-fingerprint: повторное использование в `verify()`, `validateRun` директора проекта и `checksCurrent` в `project-evidence`.

`verify()` для Run с `verificationProfile: 'task-fast'` выполняет быстрые проверки и behaviour gate. При успехе `run.headSha` — проверенный head, `run.review = null`. Сбой чинится прежним циклом в пределах `repairRounds`, но без дополнительного исследования перед ремонтом.

### Внешние задачи

`Engine.run()` до взятия lease отказывает Run с `executor.kind === 'external'` или `directorBinding.kind === 'gate'` кодом `project_run_not_native`. Задачу внешнего чата проверяет `verifyTaskFastOnce({ engine, run })` (`runtime/wave-verifier.mjs`): один проход быстрых проверок и behaviour gate под lease `run:<id>`, без ремонта. Результат `{ passed, headSha, checks, behavior }` или `{ passed: false, code, message, … }`; при успехе записывается `run.headSha`. Хосты внешних чатов — `PULL_HOSTS = ['t3', 'orca']` (`isPullHost`) в `runtime/job-contracts.mjs`.

### Gate run

`createGateRunDraft({ engine, project, gate, tasks, containers, input, installGateRun, withLease?, leaseHeld? })` строит черновик Run гейта и устанавливает его вызовом `installGateRun({ binding: gateBindingFor(gate), runDraft })` — порт проектного хранилища (`projectStore.installGateRun`, у `engine.store` установщика нет; без порта — `gate_install_unavailable`). `project` и `tasks` — записи снапшота, `containers` — критерии контейнеров гейта (`gateContainerCriteria(snapshot, gate)`); `input` — опции Run `client`, `model`, `providers`, `mode`, `concurrency`. Черновик:

- `task = buildGateInput({ project, gate, tasks: покрытые задачи в порядке merges, containers })` — те же байты, что сверяет Store: компактная сводка (контейнеры, число задач, база и голова, `manifest: { kind: 'gate-manifest', sha256, bytes }`);
- `gateManifest` — ссылка `{ path, sha256, bytes, headSha }` на неизменяемый evidence-артефакт `gate-manifest` в `<artifacts>/evidence`: значение — `buildGateManifest(...)` (схема 2): полный перечень и замороженные контракты покрытых задач и `containers` — критерии приёмки каждого покрытого контейнера (`acceptance` эпика и майлстоуна, `definitionOfDone` проекта); его SHA-256 по каноническим байтам — тот, что в `task`. Валидатор приёмки (`validateWaveRun`) проверяет артефакт по хэшу и сравнивает с пересчитанным манифестом;
- `gateCriteria = gateReviewCriteria(manifest)` — критерии, которые подтверждает независимое ревью: `<kind>:<id>:<criterion>` каждого контейнера и `task:<taskId>:<criterion>` каждой задачи, с текстом;
- политика проверок (`commands`, `verification`, `security`, `uiVerification`, `architecture`) — из `kodo.config.json` коммита `gate.headSha`, `wavePolicy = { schemaVersion: 1, commit: gate.headSha, hash }` (см. «Политика проверок волнового Run»);
- id — `gate.runId`, собственный worktree на ветке `kodo/<gate.runId>` от `gate.headSha`; база Run — `gate.baseSha`, `headSha = gate.headSha`, доставка выключена;
- план — покрытые задачи гейта с их `writePaths`, узлы `integrated` на своих `mergeCommit`, `completed = { implementation: true }` (форма, которую проверяет Store);
- режим исполнения — `input.mode`, иначе режим проекта, иначе `standard`; бюджеты из профиля режима, но `repairRounds` не меньше 2 (`GATE_MIN_REPAIR_ROUNDS`): у quick один раунд, и ремонт без повторной проверки был бы невозможен;
- `config.watchdog` — `project.execution.watchdog`, иначе `{ stalledRounds: 2, rejectUnchanged: true }`;
- `directorBinding = gateBindingFor(gate) = { schemaVersion: 1, kind: 'gate', projectId, gateId, number, runId, baseSha, headSha, mergesHash }`, где `mergesHash` (`gateMergesHash`) — SHA-256 JSON-массива `{ taskId, attemptId, runId, mergeCommit }` в порядке слияний.

До установки Git проверяет диапазон одним вызовом (`gateRange`): каждый `mergeCommit` лежит на first-parent истории `gate.headSha` после `gate.baseSha`, а у самого раннего из них первый родитель — `gate.baseSha`; значит, `baseSha ≠ headSha` и diff `baseSha..headSha` (его видят ревью и behaviour gate) содержит все покрытые слияния. У каждого `mergeCommit` ровно два родителя: первый — записанный `integration.before`, второй — голова попытки (`headSha` Run задачи, чей `run.integration` записал этот `mergeCommit` с `mergedHead = run.headSha`). Нарушение — `gate_invalid` (также задача вне `tasks`, другой проект, недопустимый `runId`). `gate.headSha` должен быть головой `refs/heads/kodo/project/<projectId>` в `project.root`, иначе `gate_head_stale`. Вызывающий держит lease `project-integration:<projectId>`: либо передаёт `withLease(work)` — проверка головы и установка выполняются внутри него, — либо `leaseHeld: true`; иначе `gate_lease_required`. Точный повтор установки уже установленного гейта (Run с `gate.runId` есть) возвращает его Run через `installGateRun` до проверок головы и диапазона: ветка могла уйти дальше.

`runEpicGate({ engine, run, signal })` под lease `run:<id>` выбирает модели (`selectModels`), выполняет полный `verify()` и затем `commands.smoke` на проверенном head. Ремонт ограничен объединением `writePaths` покрытых задач. Binding хранит исходный `gate.headSha`; ремонт может сдвинуть проверенный `run.headSha` на потомка. Перед smoke `gateRepairInScope` проверяет, что `run.headSha` — потомок `gate.headSha` и меняет только `writePaths` покрытых задач, иначе блокер `gate_scope`. Квитанции (checks, ревью, behaviour, гейты, smoke) относятся к итоговому `run.headSha`; приёмка — по нему (см. [PROJECTS.md](PROJECTS.md), правило голов), возврат в ветку — `mergeBackGate({ worktree, expectedHead: gate.headSha, gateHead: run.headSha })`. Результат smoke — `run.smoke = { schemaVersion: 1, headSha, configured, complete, results }`, строка на каждую команду с журналом `smoke`; без настроенных команд `configured: false, complete: true, results: []`. Итог — `succeeded` или `blocked` с текущим блокером (`smoke_failed`, `gate_scope`, `wave_policy_mismatch` — ремонт изменил политику проверок проверенного head, `no_verified_progress` и др.). Сторож по умолчанию останавливает гейт после двух раундов ремонта подряд без прогресса.

Ревью gate Run подтверждает критерии по одному: схема ответа расширена только для gate Run (`reviewContract`) полем `criteria: [{ id, met, evidence }]` — ровно по одной строке на каждый id `run.gateCriteria` (enum), `evidence` — непустая строка до 4000 символов; критерии с текстом входят в промпт ревьюера. Невыполненный критерий (`met: false`) проваливает ревью: `passed: false` и находка `major` с текстом критерия для раунда ремонта. Ответ без `criteria` или с повтором id — `invalid_output`. Валидатор приёмки требует `run.gateCriteria = gateReviewCriteria(manifest)` и `met: true` с evidence для каждого критерия, иначе `project_gate_criteria_unmet`; кроме того — behaviour-квитанцию политики гейта на `run.headSha` (`project_behavior_stale`) и полный `run.smoke` по `commands.smoke` этой политики (`project_smoke_stale`).

Полные проверки gate Run считают тесты Node так же, как полный fallback `task-fast` — по событиям репортёра Kodo (см. «Подсчёт тестов `node --test`»): для каждой команды `commands.test` вида `node --test` и каждого npm-скрипта, разрешённого в такую команду, нужен известный ненулевой счёт (`nodeTestOutcome`). Ноль пройденных тестов — `gate_check_no_tests`, счёт неизвестен (опция отбора, неизвестная опция, журнал событий отсутствует, битый или неполный) — `gate_check_summary_unknown`; оба — провал проверки и раунд ремонта, exit 0 раннера их не отменяет. Строка квитанции хранит настроенную команду (`command`), исполненную (`executed`), версию алгоритма (`countVersion`) и число (`tests`); журнал evidence строки — `executed`, `countVersion` и файл событий (`testEvents`). Повторное использование квитанции требует `tests > 0` и `countVersion` текущего алгоритма, а доверенный валидатор приёмки пересчитывает `tests` по `testEvents` журнала этой строки, а не по stdout, и сверяет `executed` с нормализованной командой (`project_gate_tests_uncounted`). Проверки gate Run запускаются без унаследованного `NODE_TEST_CONTEXT`/`NODE_TEST_WORKER_ID` (`fastEnvironment`). Legacy Run — без изменений: его команды исполняются как записаны, без репортёров Kodo и подсчёта.

### Политика проверок волнового Run

`kodo.config.json` коммита читается сырым (`git show` с `rawOutput`, без редактирования): разбирается и хэшируется ровно та политика, которая будет исполнена. Run хранится в Store отредактированным, поэтому политика, в строке которой есть известный секрет или значение, которое `redact` заменил бы (ключ формата провайдера, `Bearer …`, `?token=`/`?key=`/`&api_key=`), отвергается до записи и исполнения: `project_wave_policy_unsafe` (`wavePolicyAt(cwd, commit, {secrets})`); задача с такой головой не сливается (`wave_policy_unsafe`), gate Run — `blocked` с `wave_policy_unsafe`. Шаблонные ссылки `${NAME}` допустимы.

Run волнового проекта проверяется политикой из `kodo.config.json` проверяемого коммита, а не из checkout пользователя (`runtime/wave-policy.mjs`). Политика — поля `commands`, `verification`, `security`, `uiVerification`, `architecture` после той же нормализации, что у `readConfig` (`normalizeConfig`); остальные настройки (`client`, модели, режим, бюджеты, `checks`, `repository`, `baseBranch`) берутся из checkout, как раньше. `wavePolicy = { schemaVersion: 1, commit, hash }`, `hash` — SHA-256 канонического JSON политики (ключи отсортированы).

| Run | Политика | Правило головы |
| --- | --- | --- |
| Задача (нативная и внешнего чата) | коммита `run.baseSha` (фронтир интеграционной ветки) | Голова может изменить политику, только если `kodo.config.json` входит в `writePaths` задачи; иначе `wave_policy_mismatch` до слияния (попытка `blocked`) |
| Gate run | коммита `gate.headSha` (содержит все покрытые слияния, в том числе новые оракулы и smoke задач) | Проверенный `run.headSha` обязан сохранить политику; иначе гейт `blocked` с `wave_policy_mismatch` |

Задача не исполняет добавленную ею политику на себе: новые оракулы, `commands.smoke` и прочее исполняет гейт эпика на своей голове, и падающий оракул не даёт принять эпик и проект. Валидатор (`validateWaveRun`) пересчитывает политику проверенного коммита и сверяет хэш с Run; расхождение (Run или коммит изменены, невалидный `kodo.config.json` коммита) — `project_wave_policy_mismatch` / `project_wave_policy_invalid`, а не зависшая задача. Для волнового Run `assertRunSource` сравнивает с checkout только неполитические поля и только в корне проекта. Legacy Run и legacy-проекты не меняются.

## Проверка

```powershell
node scripts/run-tests.mjs tests/behavior-gate.test.mjs tests/behavior-engine.test.mjs
node scripts/run-tests.mjs tests/task-fast-checks.test.mjs tests/test-count-events.test.mjs tests/engine-fast-profile.test.mjs tests/wave-verifier.test.mjs tests/job-pull-hosts.test.mjs
```

Проверки offline: fake providers, настоящие Git и SQLite, установленный Git как эталон оракула.
