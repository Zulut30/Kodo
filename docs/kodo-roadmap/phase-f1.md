# Этап F1: основы волнового исполнения больших проектов

Статус на 2026-11-17: **реализация завершена, кандидат на приёмку.** Ветка `kodo/f1-wave-foundations`. Проверки замороженного head, ревью и CI — в описании PR этапа.

Этап — первая часть «фабрики проектов» (план v1.0, см. [progress](progress.md)): большой проект исполняется волнами, задачи сливаются в общую ветку проекта после быстрой проверки, а эпик целиком принимает одна полная проверка. Всё новое включается только полем `execution: {cadence:'wave', integration:'branch'}`; проекты без него ведут себя и сериализуются как раньше (golden-хэши байтов).

## Что сделано

| Часть | Реализация | Проверка |
| --- | --- | --- |
| Данные | `project-contracts.mjs`, `project-store.mjs`, `project-planner.mjs`, `project-progress.mjs`: поле `execution`, правило зависимостей wave (`integrated` достаточно), `appendMilestone` для закрытого проекта, записи гейтов `reserveGate`/`installGateRun`, `gates` в снапшоте | `tests/project-wave-contracts.test.mjs`, `tests/project-wave-store.test.mjs`, `tests/project-wave-planner.test.mjs` |
| Быстрые проверки | `task-fast-checks.mjs`, профиль `task-fast` в `verify()`, `selectModels`, отказ external/gate Run в `Engine.run`, `wave-verifier.mjs` (черновик и прогон gate Run со smoke, однопроходная проверка внешней задачи), `PULL_HOSTS` | `tests/task-fast-checks.test.mjs`, `tests/engine-fast-profile.test.mjs`, `tests/wave-verifier.test.mjs`, `tests/job-pull-hosts.test.mjs` |
| Интеграция и доказательства | `project-integration.mjs` (ветка `kodo/project/<id>`, слияния с проверкой scope и восстановлением), `project-wave-evidence.mjs` (evaluator: задача — до `integrated`, `accepted` — только от gate Run) | `tests/project-integration.test.mjs`, `tests/project-wave-evidence.test.mjs` |

Описание: [PROJECTS.md](../PROJECTS.md) (разделы «Волновой режим»), [VERIFICATION.md](../VERIFICATION.md) («Профили task-fast и gate run»).

## Замеченные границы

- Дочерний `node --test` быстрых проверок не наследует `NODE_TEST_CONTEXT`: с ней вложенный запуск пропускает все файлы и даёт ложный PASS.
- Кэш быстрых проверок срабатывает только в том же worktree (путь проекта входит в ключ).
- Gate Run, остановленный на smoke, при повторе заново проходит полный `verify()`, включая ревью.
- `released` в волновом режиме не поддерживается; доставка волновых задач выключается директором (F2).
- Снапшот содержит все гейты проекта с лимитом 1000.

## Что не сделано в F1

Исполнение волн (`kodo project drain`), внешние воркер-чаты T3 (`next-wave`/`complete-task`), чертёж проекта и `bootstrap`/`extend` — этапы F2 и F3.
