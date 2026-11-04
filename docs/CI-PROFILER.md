# CI profiler (phase 03 draft)

Профайлер измеряет локально выполненную команду через существующий owned-process port `runtime/delivery.mjs`. Он не запускает провайдеров и не заменяет обязательные checks. Phase02 принят (PR #11 / `dabecb7`); phase03 остаётся pending full/review/CI у координатора. Этот документ не подтверждает CI, публикацию или deployment.

## Контракт для CI task 5

```js
import { runProfiledCommand, summarizeProfile } from './runtime/ci-profiler.mjs';

const result = await runProfiledCommand({
  command: process.execPath,
  args: ['--test', 'tests/example.test.mjs'],
  cwd: project,
  env: process.env,                 // complete input environment, not an overlay
  timeoutMs: 120000,
  evidenceDir: privateEvidenceRoot, // dedicated path outside every Git checkout
  phase: 'unit',
  tier: 'L1',
  signal
});
// { exitCode: number|null, durationMs: number, stdout, stderr, profilePath }
```

Обычный ненулевой exit возвращается без исключения, с исходным кодом. Вызывающий CI обязан сделать его своим ненулевым результатом. Timeout, отмена, ошибка запуска, переполнение вывода и ошибка teardown выбрасывают исключение с `code`, `exitCode`, `durationMs`, `stdout`, `stderr`, `profilePath`, `outputTruncated`. Они никогда не являются успешным check. Ошибка конфигурации или создания приватного каталога до запуска может не иметь `profilePath`.

`execute` сохраняет `shell: false`, очищает environment через штатную границу Kodo и владеет остановкой дерева процессов. Лимит stdout+stderr — 20 MiB, как у этого port; переполнение останавливает процесс, помечает `outputTruncated: true` и сохраняет захваченный префикс. Ретраи не выполняются. `timeoutMs` — целое число 1..2147483647; default 120000. Это deadline owned command: приватный setup/ACL и завершение дерева не включены в него и могут увеличить общее время вызова.

`durationMs`/`wallMs` измеряют elapsed command time через monotonic clock, включая ожидание owned teardown, но без создания каталога/ACL и записи отчёта. Отдельные command spans в нескольких jobs нужно собирать явно; локальный профайлер не знает время очереди GitHub runner.

## Настоящие тайминги Node 24

Используй два репортёра: TAP в stdout и типизированные события в stderr. Для относительного пути Node разрешает `./scripts/ci-reporter.mjs`; абсолютный путь на Windows должен быть `file://` URL (`pathToFileURL(...).href`).

```powershell
node scripts/ci-profiler.mjs run --cwd . --evidence-dir "$env:LOCALAPPDATA/Kodo/ci-profiles" --tier L2 --phase integration -- node --test --test-reporter=tap --test-reporter-destination=stdout --test-reporter=./scripts/ci-reporter.mjs --test-reporter-destination=stderr tests/ci-profiler.test.mjs
```

Для `cwd` другого проекта вычисли URL репортёра относительно установленного модуля `runtime/ci-cli.mjs`: `new URL('../scripts/ci-reporter.mjs', runtimeModuleUrl).href`, и передай его в `args`. Пакет включает `scripts/ci-reporter.mjs` как необходимый asset для `kodo ci profile`; остальные скрипты из `scripts/` предназначены для исходного checkout. Публичный runtime export доступен из `runtime/ci-profiler.mjs`.

Репортёр принимает async iterable Node `TestsStream` и выдаёт JSONL только для валидных `test:summary`: `data.file`, `duration_ms`, `success`, и числовые `counts.{tests,passed,failed,cancelled,skipped,todo}`. Поля исключений/произвольные тестовые данные не копируются. Официальный контракт: [Node 24 test:summary](https://nodejs.org/docs/latest-v24.x/api/test.html#event-testsummary).

При process isolation Node создаёт summary каждого файла плюс общую summary без `file`. Используются именно эти события. Название теста, расположение assertion, regex имени файла или сумма вложенных тестов не подменяют длительность файла. `duration_ms` файла — наблюдение Node внутри test process; оно не является измерением всей занятости scheduler slot, загрузки интерпретатора или CPU/I/O. При отключённой isolation per-file events могут отсутствовать: тогда `testFile` остаётся `null`.

Если профайлер вызывается из `node:test`, вызывающая fixture должна удалить `NODE_TEST_CONTEXT` из передаваемого полного `env`, чтобы вложенный Node test runner не наследовал IPC-протокол родительского runner. Производственное окружение автоматически не изменяется сверх штатной очистки Kodo.

## Публичный JSON schemaVersion 1

`summarizeProfile(records, options = {})` — чистая функция. Принимает массив типизированных Node summary events либо явных spans:

```js
const report = summarizeProfile([
  { kind: 'span', id: 'setup', bucket: 'setup', durationMs: 24,
    startMs: 0, status: 'passed', dependsOn: [] },
  { kind: 'span', id: 'checks', bucket: 'command', durationMs: 100,
    startMs: 24, status: 'failed', dependsOn: ['setup'], attempt: 1 }
]);
```

`bucket`: `command`, `test`, `testFile`, `setup`, `queue`, `toolInstall`, `powershell`, `acl`, `gitWorktree`, `packageSmoke`. `status`: `passed`, `failed`, `cancelled`, `skipped`, `todo`. Интервалы в миллисекундах должны быть конечными неотрицательными числами не больше MAX_SAFE_INTEGER. `id` — строка 1..4096 символов; публичный JSON содержит только её SHA-256. Raw span args/env/error/file/произвольные labels не экспортируются. ID Node файла — SHA-256 точного `data.file`; приватный JSONL в журнале позволяет сопоставить хеш с файлом. Хеш идентификатора не является анонимизацией: не публикуй логи вместе с отчётом.

Каждый наблюдаемый bucket содержит `count`, `failures` (failed+cancelled spans), `cancelled`, `skipped` (skipped+todo), nearest-rank `p50Ms`/`p90Ms`, `minMs`, `maxMs`, `totalMs`, `retries`, `flakyObserved`, `flakyLabelled`. `totalMs` — сумма sample durations, не wall time; вложенные/параллельные samples могут пересекаться. Для наблюдения retry нужны одинаковые `id`/bucket и разные положительные целые `attempt`. Считаются только наблюдаемые повторные попытки; одна запись attempt 4 не доказывает три предыдущих запуска. `flakyObserved` требует failed attempt, затем passed attempt с большим номером. Явное `flaky: true` учитывается отдельно в `flakyLabelled`, не доказывает восстановление и не разрешает пропускать release checks. Без attempt metadata `retries`/`flakyObserved` равны `null`.

Неизмеренные buckets — `null`, включая setup/queue/tool/PowerShell/ACL/Git/package. Их сборщик передаёт явными spans, когда такие операции действительно измерены. Профайлер не угадывает category по тексту команды.

`tests` содержит totals Node summary, а при её отсутствии — сумму counts наблюдаемых per-file summaries. Наличие этих counts не создаёт вымышленные individual-test duration samples: `buckets.test` остаётся `null`, пока не получены явные spans.

`wallMs`: явно измеренный `options.wallMs`, единственная cumulative Node summary или envelope всех spans с `startMs`; иначе `null`. Все startMs должны относиться к одной monotonic epoch. `criticalPathMs` вычисляется только из явного полного ацикличного `dependsOn` для каждого span, с уникальными ID и всеми зависимостями в наборе; иначе `null`. Это сумма длительностей вдоль самого длинного пути DAG, без неизвестного scheduler idle. Вложенные spans нельзя одновременно включать в такой DAG как независимую работу. Для одного profiled command критический путь — измеренный command span. Максимальная длительность файла не объявляется критическим путём всего CI.

`observedRecords`, `malformedRecords`, `ignoredRecords`, `omittedRecords` показывают объём входа и потери. Неизвестные событийные сообщения игнорируются; неподдерживаемые pass/fail и повреждённые summary/span считаются malformed. Частичные events без окончательной summary не превращаются в успешные measurements. `details` содержит только хеш ID, bucket, durationMs, status; `omittedDetails` явно отмечает ограничение. По умолчанию максимум 100000 входных записей и 200 details; `options.maxRecords` может только уменьшить 100000, `maxDetails` — максимум 2000. Отсутствующие/повреждённые записи не интерпретируются как нулевые длительности или PASS. Профиль не является cache receipt или доказательством проверки gates.

## CLI и приватность

```powershell
node scripts/ci-profiler.mjs summary path/to/private/profile.json
node scripts/ci-profiler.mjs summary path/to/private/events.jsonl
```

`summary` принимает report, JSON array или JSONL событий, максимум 16 MiB; заново применяет allowlist при чтении готового отчёта. Неизвестные/повторные flags отклоняются. `run` печатает компактную JSON-квитанцию с exit/duration/profilePath; сырые потоки доступны в приватных файлах, не в публичной сводке.

Каждый запуск создаёт уникальный `profile-*` вне проекта и всех Git ancestors. Symlink/junction paths отвергаются. POSIX: directory 0700, files 0600. Windows: перед записью файлов каталог получает protected inherited ACL текущего пользователя и SYSTEM. `stdout.log`, `stderr.log` и при инфраструктурной ошибке `error.log` сохраняют полную доступную диагностику после redaction; `profile.json` не содержит raw stdout/stderr/команд/args/environment/путей файлов. Используются известные значения удалённых переменных environment и штатные credential patterns. Произвольный неизвестный секрет в обычном тексте не может быть автоматически распознан; сохранять/публиковать приватные логи как публичный artifact нельзя.

## Проверки и урок

Scoped command: `node --test tests/ci-profiler.test.mjs`. Проверяется статистика, empty/partial/malformed input, ограничение details, attempts/flaky, DAG, реальные события Node 24 с failing TAP, сохранение exit/stderr, redaction, timeout/output-limit/pre-cancel/active cancel, запрет evidence в Git/links, CLI и вложенная allowlist публичного summary.

Packaging regression: `node --test tests/ci-package.test.mjs`. Настоящий `npm pack --offline --ignore-scripts --json` создаёт tarball вне Git; системный `tar` распаковывает собственный доверенный пакет. Node запускает поставленный репортёр по file URL относительно распакованного runtime на fixture с одним проходящим тестом. Проверяются exit 0, TAP и реальные file/overall summary events. Зависимости из сети не устанавливаются. Это scoped-проверка asset из tarball, а не полный установленный CLI smoke или доказательство публикации.

Урок: Node test names и `test:pass.data.file` относятся к отдельным assertions, а не к полному file run. Измерять файл нужно по `test:summary.data.file`; raw TAP и typed timing metadata сохраняются параллельно. На Windows absolute reporter path обязательно преобразуется в file URL. Локальное прохождение этих тестов не является cross-platform CI или сравнительным benchmark Windows/Linux.
