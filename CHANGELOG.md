# Журнал изменений

Выпуски Kodo распространяются через [GitHub Releases](https://github.com/Zulut30/Kodo/releases) архивом `zulut30-kodo-<версия>.tgz` с `SHA256SUMS`; в npm пакет не публикуется. Подробные квитанции этапов — в [прогрессе roadmap](docs/kodo-roadmap/progress.md).

## Не выпущено

- **CI: 12 параллельных ног** ([PR #33](https://github.com/Zulut30/Kodo/pull/33), `85619f5`, в `main`). По шесть отдельных jobs на Linux и Windows: `ci-l2`, `ci-heavy`, `ci-waves-director`, `ci-waves-e2e`, `ci-waves-parallel`, `ci-final`. Обязательные contexts `check (ubuntu-latest, 24)` и `check (windows-latest, 24)` проверяют каждую ногу через `verify_leg`. Три волновых тестовых файла разделены на восемь в трёх шардах (`test:waves:director`, `test:waves:e2e`, `test:waves:parallel`). Run 45857094167 — 26 мин 10 с против 141 мин в PR #32 (≈ 5,4×). [Замеры](docs/CI.md#параллельный-ci-12-ног-pr-33).
- **Сопровождаемость.** В `main` вошёл коммит `46fffa2`. Типизирован `KodoRun` (baseline `tsc` 143 → 108), разделены Project Store, Project Director и Engine (T4c, T5, T6, T8), разбиты крупные модули этапов 15–16, включён храповик `max-lines: 900`. [PR #34](https://github.com/Zulut30/Kodo/pull/34) · [План](docs/kodo-roadmap/MAINTAINABILITY-PLAN.md).

## [1.2.0] — 2026-11-26

Этап 16: удалённые машины, автономность, телеметрия. [PR #32](https://github.com/Zulut30/Kodo/pull/32), merge `39ef196`.

- **16A. Удалённые машины.** Git-транспорт попыток `refs/kodo/<projectId>/base|work/<runId>`, брифы без локальных путей для `t3-env`/`ssh`, квитанция `task-fast` удалённой машины, привязанная к `headSha` и хэшу политики, проверка доступности машин и переназначение задач.
- **16B. Автономность.** Арбитр гейта на подписке другого провайдера (`confirm_pass`, `confirm_defect`, `split_needed`); автоповтор `project_integration_conflict` от свежей головы; сторож внешних воркеров; волновые проекты до 400 задач.
- **16C. Телеметрия и диспетчер T3.** `kodo report --project`: задач в час, p50/p95, разбивка времени, First-Pass Yield, арбитражи, вмешательства, загрузка подписок и машин.
- **16D. Бэклог пилота Rust.** Правило Волны 0 `rust_toolchain_required`. При нехватке точного пина применимые Rust-проверки `lint` и `typecheck` в `ci feedback` могут пройти с предупреждением `toolchain_unpinned`. Для `task-fast` и гейтов действуют строгие пины. Выбор затронутых крейтов использует граф Cargo и общий резолвер `resolveCargoWorkspace`.
- **16E. Запас Windows CI.** 19 самых долгих тестовых файлов вынесены в `npm run test:heavy`; волновые кейсы получили предел 900 с.

[GitHub Actions 45707798608](https://github.com/Zulut30/Kodo/actions/runs/45707798608) завершил `check (ubuntu-latest, 24)` за 17 минут и `check (windows-latest, 24)` за 141 минуту. Координатор записал [`kodo/review` со статусом `success` на `33f5b7d`](https://api.github.com/repos/Zulut30/Kodo/commits/33f5b7dd418bc48c1971fdf8151b3171a0747e0d/statuses). Скачанный архив `zulut30-kodo-1.2.0.tgz` с SHA-256 `ef476061fe3d3eac9bd7de3eaab7374046debb1544cd3c61cc083106f52faeae` сверен с `SHA256SUMS`. Проверка `node scripts/package-smoke.mjs` прошла для 34 компонентов, 13 навыков по умолчанию и 183 upstream-файлов. В глобальном CLI 1.2.0 проверены `registry stats`, `validate` и `doctor`.

Известные границы: удалённые машины проверены только локальной эмуляцией (bare-репозиторий и второй клон), живой прогон SSH/T3-машины — NOT RUN; большой пилот контрольной точки 2 (50–80 задач) — NOT RUN. [Все ограничения](docs/kodo-roadmap/phase-15.md#известные-ограничения-120).

## [1.1.2] — 2026-11-25

- Гейт эпика Rust проверяет каждый коммит диапазона правами его источника: ремонт контрактного крейта Волны 0 больше не блокирует гейты соседних эпиков (`contract_change_not_allowed`). [PR #30](https://github.com/Zulut30/Kodo/pull/30).
- Пилот Voxa (Rust, 17 задач, 8 крейтов) принят на этой версии — контрольная точка 1 ACCEPTED.

## [1.1.1] — 2026-11-25

- Слот `CARGO_TARGET_DIR` в `task-fast` начинается пустым при смене worktree, а `CARGO_BUILD_BUILD_DIR` указывает внутрь слота: задача больше не получает артефакты чужого worktree. [PR #29](https://github.com/Zulut30/Kodo/pull/29).

## [1.1.0] — 2026-11-25

Этап 15: движок большого проекта. [PR #28](https://github.com/Zulut30/Kodo/pull/28), [ADR-0017](docs/decisions/0017-parallel-engine.md).

- Профиль подписок и машин, критический путь, очередь интеграции с fencing.
- Rust и Cargo workspace: затронутые крейты в `task-fast`, слоты `CARGO_TARGET_DIR`, необязательный `sccache`.
- Карты публичного API зависимостей и пакет диагностик для брифа ремонта.
- Architecture Guardian для Cargo workspace (политика v2) и Behaviour Gate для Rust.
- Координация `Cargo.lock` между параллельными задачами с офлайн-регенерацией.
- `kodo project bootstrap --prepare` принимает `--client` ([#27](https://github.com/Zulut30/Kodo/pull/27)).

## [1.0.1] — 2026-11-24

Этап 14. [PR #26](https://github.com/Zulut30/Kodo/pull/26), [ADR-0016](docs/decisions/0016-small-tasks.md).

- Быстрый путь маленьких задач: две сессии вместо полного конвейера.
- Хост T3 из коробки, видимые причины остановки, запас времени Windows CI.

## [1.0.0] — 2026-11-19

Этап 13: сквозная приёмка. [PR #24](https://github.com/Zulut30/Kodo/pull/24), [итоговый отчёт](docs/kodo-roadmap/FINAL-REPORT.md). Выпуск включает этапы 01–13 и фабрику проектов F1–F3:

- профили качества для девяти языков ([#11](https://github.com/Zulut30/Kodo/pull/11)); ступени CI L0–L3, приватный кэш и до пяти задач одновременно ([#12](https://github.com/Zulut30/Kodo/pull/12)); Architecture Guardian ([#13](https://github.com/Zulut30/Kodo/pull/13)); локальные знания и история источников ([#14](https://github.com/Zulut30/Kodo/pull/14)); Project Director ([#15](https://github.com/Zulut30/Kodo/pull/15));
- Prettier, oxlint, `tsc`-храповик и `test:fast` ([#16](https://github.com/Zulut30/Kodo/pull/16));
- durable jobs ([#17](https://github.com/Zulut30/Kodo/pull/17)), манифест контекста и лимиты ([#18](https://github.com/Zulut30/Kodo/pull/18)), behaviour gate ([#19](https://github.com/Zulut30/Kodo/pull/19)), сторож прогресса ([#20](https://github.com/Zulut30/Kodo/pull/20)), журнал операций доставки ([#21](https://github.com/Zulut30/Kodo/pull/21)), `kodo report` ([#22](https://github.com/Zulut30/Kodo/pull/22));
- волновая фабрика проектов, pull-хост T3, чертёж и `extend` ([#23](https://github.com/Zulut30/Kodo/pull/23)).

## [0.2.6] — 2026-11-04

- Непрерывная очередь независимых задач в worktree, компактный контекст и управляемый RTK ([#8](https://github.com/Zulut30/Kodo/pull/8)).
- Контракты проверок; исправлены границы тайм-аутов, завершение дочерних процессов и редактирование секретов ([#9](https://github.com/Zulut30/Kodo/pull/9)).

## [0.2.4] — 2026-11-03

- MVP: режимы `quick`/`standard`/`deep`, ранняя оценка Jev, возобновляемые задачи, обязательные проверки и независимое ревью ([#7](https://github.com/Zulut30/Kodo/pull/7)).

## [0.2.2] — 2026-11-02

- Read-only `kodo audit RUN_ID [--json]`: покрытие навыков по умолчанию и квитанции доставки сохранённого запуска ([#5](https://github.com/Zulut30/Kodo/pull/5)).

## [0.2.1] — 2026-11-02

- Первый выпуск CLI: навыки по умолчанию с пинами, `kodo list --search`, `kodo registry stats --json`, восстановленное исполнение задач ([#1](https://github.com/Zulut30/Kodo/pull/1)–[#4](https://github.com/Zulut30/Kodo/pull/4)).

[1.2.0]: https://github.com/Zulut30/Kodo/releases/tag/v1.2.0
[1.1.2]: https://github.com/Zulut30/Kodo/releases/tag/v1.1.2
[1.1.1]: https://github.com/Zulut30/Kodo/releases/tag/v1.1.1
[1.1.0]: https://github.com/Zulut30/Kodo/releases/tag/v1.1.0
[1.0.1]: https://github.com/Zulut30/Kodo/releases/tag/v1.0.1
[1.0.0]: https://github.com/Zulut30/Kodo/releases/tag/v1.0.0
[0.2.6]: https://github.com/Zulut30/Kodo/releases/tag/v0.2.6
[0.2.4]: https://github.com/Zulut30/Kodo/releases/tag/v0.2.4
[0.2.2]: https://github.com/Zulut30/Kodo/releases/tag/v0.2.2
[0.2.1]: https://github.com/Zulut30/Kodo/releases/tag/v0.2.1
