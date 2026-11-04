# Прогресс Kodo roadmap

Снимок: 2026-11-04. Авторитетные run state и receipts хранятся вне Git в SQLite Kodo. Этот документ отражает состояние до итоговых gates текущего commit. Пользователь выбрал [рабочий MVP всех13этапов](MVP-SCOPE.md), расширенные проверки и benchmark после него; целевой бюджет10часов от15:36UTC.

Пользователь отдельно потребовал пять одновременных задач. Разработка независимых worktree выполняется параллельно; приёмка и merge этапов сохраняют порядок. Компоненты ускорения пришли от отдельных coordinator-owned workers; provenance сохранён в `run.coordinatorComponentManifests` и приватном `phase03-adoption.json`, это не пять Native plan nodes текущего run. Их прежние scoped результаты — исторические. Текущая проверка совместимости семи suites: 91 PASS/0 FAIL/0 cancelled/0 SKIP на `8c24da1`; это не общий PASS этапа03.

| Фаза | Статус | Следующий проверяемый шаг |
| --- | --- | --- |
| 01 Baseline/plan | ACCEPTED; PR #10 MERGED `ef38109e`; обе ОС CI PASS | Исторический baseline сохранён |
| 02 Language quality | ACCEPTED; [PR #11](https://github.com/Zulut30/Kodo/pull/11) MERGED `dabecb7`; f72 local870/864 PASS/6 SKIP, security/review PASS | CI41877990343 завершён: Linux872/854 PASS/18 SKIP, Windows870/864 PASS/6 SKIP; installed CLI smoke обеих ОС PASS. Evidence историческое для phase02 |
| 03 CI/cache/concurrency | DRAFT, NOT ACCEPTED; 7 scoped suites91/91 PASS на `8c24da1`, offline tarball reporter и real cross-port fixture PASS; UI disabled/N/A. [Команда, test names, source/dependency hashes и ограничения](phase-03.md#проверка-совместимости-2026-11-04) | Pending frozen-head full `npm run check`, fresh enabled security, independent review, required Windows/Linux CI и отдельный full installed CLI smoke. L1 plan156 ambiguity reasons, source/vendor quality ownership blocked; optional fast opt-in, default skipped/neutral |
| 04 Architecture | NOT STARTED | После03: forbidden imports/contracts |
| 05 Research knowledge | NOT STARTED | После04: claims/provenance/invalidation |
| 06 Project Director | NOT STARTED | После05: versioned DB/legacy compatibility |
| 07 Swarm | NOT STARTED | После06: durable jobs/leases/idempotency |
| 08 Context/budget | NOT STARTED | После07: deterministic fast path |
| 09 Verification/evolution | NOT STARTED | После08: independent oracles/risk policy |
| 10 Progress/maintenance | NOT STARTED | После09: watchdog/acceptance progress |
| 11 Merge/release | NOT STARTED | После10: immutable queue/recovery/smoke |
| 12 Observability | NOT STARTED; benchmark campaigns отложены пользователем | После11: реальные operational metrics/JSON; неизвестные метрики null |
| 13 Final acceptance | NOT STARTED | После12: реальные сценарии и проверенный выпуск |

[Baseline](BASELINE.md), [приёмка01](phase-01.md), [изменения и evidence02](phase-02.md). Исторические [local](../../tests/fixtures/roadmap-baseline/local-baseline.json) и [CI](../../tests/fixtures/roadmap-baseline/ci-baseline.json) receipts не перезаписываются. Published0.2.6 является прежним выпуском; новый release запланирован на фазе13.
