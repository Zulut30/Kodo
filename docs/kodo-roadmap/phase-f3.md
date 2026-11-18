# Этап F3: фабрика проектов из главного чата

Статус на 2026-11-18: **реализация собрана, кандидат на ревью.** Ветка — сведение исполнения волн F1+F2 (`13ef8c1`) и CLI чертежа (`t3/project-blueprint-cli`, `b370240`). Проверки замороженного head, ревью и CI — в описании PR этапа.

Этап завершает фабрику проектов: [F1](phase-f1.md) дал данные волн, профили проверки и интеграционную ветку, [F2](phase-f2.md) — исполнение волн (`drain`) и pull-протокол воркер-чатов T3, F3 — файловый чертёж, регистрацию проекта из него, добавление фич и алгоритм постоянного главного чата.

## Что сделано

| Часть | Реализация | Проверка |
| --- | --- | --- |
| CLI фабрики поверх F1+F2 | `project-cli-blueprint.mjs` (`bootstrap`, `apply-spec`, `extend`, `append-milestone`) подключён через `waveCommand` в `project-cli.mjs` и добавлен в пины Architecture Guardian (`architecture-gate.mjs`) | `tests/project-cli-blueprint.test.mjs`, `tests/project-blueprint.test.mjs`, `tests/project-bootstrap.test.mjs` |
| Сквозной сценарий | Чертёж (Волна 0 + две параллельные задачи) → `apply-spec` → `drain` → `accepted`; `extend --prepare` → `append-milestone` → `drain` → снова `accepted`, прежние майлстоуны, эпики и задачи не изменены | `tests/project-factory-e2e.test.mjs` (реальные Store, project store, авторизатор и Engine с fake-провайдерами, временный Git, только CLI) |
| Навык главного чата | `skills/kodo-project-director/SKILL.md`: чертёж, `apply-spec`, цикл `next-wave`/`delegate_task`/`complete-task`, архивирование своих воркер-чатов, `drain` без T3, новые фичи | `node cli/index.mjs validate`, `tests/toolkit.test.mjs` |
| Регистрация навыка | `registry.json` (requires `skills/kodo-build-feature`), `kodo init` ставит оба навыка, `scripts/package-smoke.mjs` проверяет его в установленном каталоге, ссылки из `kodo-build-feature` и `AGENTS.md` | `tests/registry-stats.test.mjs`, `tests/default-init.test.mjs`, `tests/rtk.test.mjs`, package smoke |
| Решения | [ADR-0014](../decisions/0014-wave-factory.md) — волновая фабрика, [ADR-0015](../decisions/0015-t3-pull-host.md) — pull-хост T3 | — |

Описание: [BLUEPRINT.md](../BLUEPRINT.md) («Сквозной сценарий»), [T3-HOST.md](../T3-HOST.md), [RUNTIME.md](../RUNTIME.md) («Фабрика проектов и волны»), README («Фабрика проектов»).

## Сведение веток

`t3/project-blueprint-cli` писалась поверх F1 до ревью (`95a7c24`). Конфликты — только в общих списках, разрешены объединением: справка `cli/index.mjs`, пины `architecture-gate.mjs`, `priority` в `scripts/run-tests.mjs`. Делегирование blueprint-действий встроено в `waveCommand` (`project-cli.mjs`), как `drain` и pull-команды. Код чертежа после сведения не менялся: его тесты и сквозной сценарий проходят на контрактах F1+F2 без правок.

Каталог вырос до 34 компонентов (19 навыков, 52 ссылки `requires`); счётчики в тестах и документах обновлены. Локальный навык не входит в `third-party-skills.lock.json`, поэтому закреплённые стандартные навыки (13) и `tests/skill-pin-batch-oracle.test.mjs` не меняются.

## Исправления по ревью

Независимое ревью фабрики; каждая находка закрыта регрессионным тестом (RED до исправления, GREEN после).

| Находка | Исправление | Тест |
| --- | --- | --- |
| major: контекст `bootstrap` писался без проверки на известные секреты; значение из хранилища учётных данных в имени файла попадало в `context.md` и в промпт нативной сессии | Перед записью каждого файла пакета и перед `provider.runSession` (`prepareBootstrap`, `prepareExtend`, `generateBlueprint`, `generateMilestone`) известные значения, PEM-ключи и значения `security.redact` заменяются на `[REDACTED]`; результат проходит `assertDirectorSafe`, иначе отказ `bootstrap_context_unsafe` без записи и отправки; `summary.redacted`. CLI передаёт `knownValues` и в `bootstrap --prepare` | `tests/project-bootstrap.test.mjs` (prepare, extend, нативные пути с fake-провайдером, отказ), `tests/project-cli-blueprint.test.mjs` (секрет CLI в имени файла и в архитектурном графе) |
| minor: `apply-spec` регистрировал проект без Git-коммита, и `next-wave`/`drain` затем отвечали общим `project_blocked` | До открытия состояния `apply-spec` требует: `root` — корень рабочего дерева Git, `HEAD` — коммит, вне `.kodo/blueprint/` нет незакоммиченных и неигнорируемых неотслеживаемых файлов; иначе finding `blueprint_git_required`, exit 1. Шаг — в навыке и BLUEPRINT.md | `tests/project-cli-blueprint.test.mjs`: каталог без Git, репозиторий без коммита, подкаталог репозитория, грязное дерево, вместе с findings чертежа; игнорируемые файлы и незакоммиченный чертёж не мешают |
| Циклы эпиков: Store отклоняет волновой проект с циклическим графом эпиков (`project_epic_cycle`), а lint этого не видел | `epicCycleFindings`: в `lintFactorySpec`/`compileBlueprint` и `lintMilestone` (по существующим и новым задачам, только циклы с новым эпиком) — finding `blueprint_epic_cycle` с перечнем эпиков | `tests/project-blueprint.test.mjs`, `tests/project-bootstrap.test.mjs` |
| minor: навык не различал уже назначенные брифы, повтор `next-wave` вёл ко второму чату на тот же worktree | Журнал `attemptId → делегат, threadId` в истории чата диспетчера; `delegate_task` только для брифов без записи; после перезапуска — разовая сверка `t3_thread_list`/`task_status`, ненайденный бриф считается назначенным; переназначение — только `--abandon` + `next-wave --retry-failed`. Сверено с AGENTS.md и T3-HOST.md | `node cli/index.mjs validate`, `tests/toolkit.test.mjs` |

## Границы

- Kodo не создаёт, не ждёт и не архивирует чаты T3: это делает главный чат своими инструментами по навыку. Kodo не знает id чатов и не проверяет их архивирование.
- `kodo report --project` из навыка появится со сведением этапа 12; на этой ветке команды нет, навык указывает запасной `kodo project status`.
- Сквозной тест покрывает путь `drain`; путь T3 (`next-wave`/`complete-task`) покрыт `tests/project-wave-e2e.test.mjs` на проекте из `create`, а не из чертежа. Чертёж даёт тот же волновой проект, поэтому отдельного сквозного T3-теста из чертежа нет.
- Настоящие чаты T3 и подписочные провайдеры в тестах не участвуют: fake-провайдеры и сымитированный коммит воркера.
- Ограничения волн F1/F2 сохраняются: задачи только в quick, `released` для wave-проекта не поддерживается, rebase внешней задачи не поддерживается.

## Что не сделано в F3

Реальный прогон фабрики в T3 с подписочными клиентами; восстановление после `wave_project_head_mismatch`; доставка и релиз волнового проекта; проверка протокола с Orca.
