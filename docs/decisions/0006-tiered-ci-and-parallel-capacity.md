# ADR-0006: ступени CI и явная ёмкость пяти сессий

Статус: локальный draft phase03, pending full/review/CI. Phase02 принят: PR #11, merge `dabecb7bec7514116e3b2870c04270bb4f83ee77`; его evidence не заменяет общие проверки phase03.

## Контекст

Пользователь запросил пять параллельных задач и сокращение времени проверок. Ускорение должно сохранять полноту обязательных проверок, точную выбранную модель, изоляцию scopes и честные границы измерений. Один большой Windows test file создавал длинный критический путь; его tests-only split уже включён в maintenance phase02 и повторно в phase03 не объединяется.

## Решение

CI получает четыре ступени: L0 проверяет применимые format/lint для изменения; L1 добавляет syntax/lint/typecheck и доказанно затронутые тесты; L2 выполняет полный `npm run check` и свежий обязательный security gate на Windows/Linux Node24; L3 сохраняет smoke установленного пакета. Оба существующих required `check` contexts и branch protections сохраняются. Только устаревшие PR heads отменяются; main/release runs не отменяются этой политикой.

Новый optional Actions job `fast` является opt-in: job-level `if: ${{ vars.KODO_FAST_CI_ENABLED == 'true' }}`. При отсутствующей переменной job skipped/neutral, не PASS. Воспроизведённый blocked broad feedback требует сначала подготовить и проверить source/vendor ownership; скрытых exclusions нет. Затем координатор может включить repository variable `KODO_FAST_CI_ENABLED=true`. Required Windows/Linux `check` не получает этого условия и сохраняет полный L2, security и installed smoke. Локальный feedback на подготовленной области работает независимо; одиночные 4.29s не являются Actions benchmark. Worker не меняет repository variables или branch protection.

Для bounded parallelism split test files `scripts.test` явно задаёт `node --test --test-concurrency=4`. Node24 не принимает `--test-concurrency` в `NODE_OPTIONS`; поэтому значение передаётся непосредственно test runner. `scripts.check` остаётся ровно `npm run validate && npm test`, L2 вызывает `npm run check`, required matrix job names и все тесты сохраняются. Lock-файл не дублирует scripts и ради этой настройки не меняется. Это ограничение конкуренции процессов файлов, отдельное от ёмкости пяти Kodo workers.

`ci-graph` строит обратные транзитивные зависимости через закреплённый Acorn 8.15.0. Неизвестный config, public API, lock/CI, неподдерживаемый язык, вычисляемые или неразрешённые зависимости приводят к broad fallback с причиной. `ci-profiler` хранит фактические Node test events и ограниченный отчёт; ненаблюдаемые интервалы и model/HTTP/cost metrics остаются `null`.

`ci-cache` — отдельный private command-cache контракт, а не разрешение доверять публичному cache как PASS. Повторное использование возможно только для успешной полной квитанции точного чистого HEAD, исходников/dependencies/lock, команд, runtime/tools, платформы и конфигурации gates, с проверкой приватных путей и целостности evidence. UI/security observations всегда свежие. npm tarball cache в workflow хранит данные; `npm ci` заново проверяет lock integrity. Наличие cache API не означает, что CI CLI уже использует его для пропуска команд.

Новое project-значение `concurrency:5` явно задаёт ёмкость для новых запусков. Без явного выбора остаются defaults standard/deep 2 и quick 1. Сохранённые меньшие бюджеты и resume/retry не расширяются. Quick routing остаётся последовательным. В standard/deep фиксированная `--model` ограничивает provider/model во всех сессиях и повторах; scheduling по-прежнему требует `task.parallel`, независимые scopes/dependencies и Jev `parallelConfidence >= 0.75`. Низкая уверенность и serial-решение не обходятся ёмкостью. Интеграция остаётся последовательной; GPT/Claude работают через подписочные клиенты без API fallback.

## Альтернативы и последствия

Один обязательный fullcheck для каждой локальной правки сохраняется как broad fallback и L2, но не даёт быстрой обратной связи. Выбор тестов по имени каталога или доверие public PASS-cache отвергнуты: они не доказывают полноту и актуальность. Безусловные пять workers отвергнуты: ёмкость не отменяет ограничения модели, routing, scope, leases, quota и cancellation.

Цена решения — отдельные контракты graph/cache/profiler и консервативный fallback; неизвестные проекты могут получать полный набор тестов. Local fake-provider barrier подтверждает admission peak5, а маленький Windows cross-port fixture — реальные graph/profiler/process и одно file-timing observation. Это не измеренный speedup всего CI и не проверка пяти живых подписочных сессий. Перед delivery нужны чистый интегрированный HEAD, `npm run check`, включённые свежие gates, независимое differential review и required CI; перед release — установленный artifact smoke. Ограничения веток не обходятся.

Урок интеграции: расширение числового предела не должно ломать сохранённый контракт config-ошибки. RED старого negative case и subsequent 112/113 scoped result сохранены; root-owned исправление меняет только TypeError message, сохраняя диапазон 1–5 и все assertions.

Текущее ограничение L1: причины broad fallback собираются для всего дерева, включая независимые runtime I/O dependencies и неподдерживаемые upstream languages. Такое консервативное поведение может свести affected-план Kodo к полному набору тестов, а broad quality scope — обнаружить существующий debt. Наличие ступеней и успех маленького fixture не доказывают быстрый feedback для репозитория Kodo; это остаётся отдельной задачей после измерения реального плана.
