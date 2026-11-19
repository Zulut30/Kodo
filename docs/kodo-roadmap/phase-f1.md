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

## Исправления по независимому ревью

Ревью F1 вернуло FAIL (2 blocker, 6 major, 1 minor). Все находки исправлены, у каждой — регрессионный тест, падавший на `95a7c24` и проходящий после исправления.

| Находка | Исправление | Тест |
| --- | --- | --- |
| `resume` принимал wave-задачу по её собственному Run | Авторизатор маршрутизирует по `isWaveProject` в `evaluateWaveTransition`; `run`/`resume` wave-проекта — `project_wave_drain_required` | `tests/task-fast-checks.test.mjs` («A wave project is never run…») |
| Черновик gate Run нельзя было установить | Единый контракт `installGateRun({binding: gateBindingFor(gate), runDraft})`, `runDraft.task = buildGateInput(...)`, отдельная форма черновика в Store | `tests/wave-verifier.test.mjs` (сквозная связка на SQLite), `tests/project-wave-store.test.mjs` |
| SHA слияний не сверялись | `reserveGate` сверяет `mergeCommit` с `run.integration` попытки; `createGateRunDraft` проверяет второго родителя и голову интеграционной ветки под lease | те же |
| `accepted` без обязательных доказательств гейта | installed, `succeeded`, behaviour receipt, точный smoke с журналами | `tests/project-wave-evidence.test.mjs` |
| Ремонт в gate Run вёл в тупик | Квитанции на проверенном потомке `gate.headSha` в пределах writePaths; `mergeBackGate` с `expectedHead`; приёмка проекта — только на голове интеграционной ветки | `tests/project-wave-evidence.test.mjs`, `tests/wave-verifier.test.mjs`, `tests/project-integration.test.mjs` |
| Соседний эпик вытеснял гейт через общий milestone | Вытеснение по контейнеру перехода; milestone/project в цепочке — только при accepted соседях | `tests/project-wave-evidence.test.mjs`, `tests/project-wave-store.test.mjs` |
| `task-fast` зеленел при нуле тестов | Опции отбора и репортёра → полный fallback; счёт выполненных тестов, ноль → полный `commands.test` | `tests/task-fast-checks.test.mjs` |
| Повтор после сбоя до merge commit оставлял `MERGE_HEAD` | `mergeTask({pending})` прерывает только своё незавершённое слияние | `tests/project-integration.test.mjs` |
| Полные валидаторы пропускали профилированную квитанцию | `checksCurrent` и `validateRun` отвергают любой `profile` и `verificationProfile` | `tests/task-fast-checks.test.mjs` |

## Замеченные границы

- Дочерний `node --test` быстрых проверок не наследует `NODE_TEST_CONTEXT`: с ней вложенный запуск пропускает все файлы и даёт ложный PASS.
- Кэш быстрых проверок срабатывает только в том же worktree (путь проекта входит в ключ).
- Gate Run, остановленный на smoke, при повторе заново проходит полный `verify()`, включая ревью.
- `released` в волновом режиме не поддерживается; доставка волновых задач выключается директором (F2).
- Снапшот содержит все гейты проекта с лимитом 1000.

## Что не сделано в F1

Исполнение волн (`kodo project drain`), внешние воркер-чаты T3 (`next-wave`/`complete-task`), чертёж проекта и `bootstrap`/`extend` — этапы F2 и F3.
