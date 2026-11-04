# Прогресс Kodo roadmap

Снимок: 2026-11-04. Авторитетные run state и receipts хранятся вне Git в SQLite Kodo. Этап03 принят; этап04 находится до интегрированных gates. Пользователь выбрал [рабочий MVP всех13этапов](MVP-SCOPE.md), расширенные проверки и benchmark после него; целевой бюджет10часов от15:36UTC не отменяет acceptance.

Пользователь отдельно потребовал пять одновременных задач. Разработка независимых worktree выполняется параллельно; приёмка и merge этапов сохраняют порядок. Компоненты ускорения пришли от отдельных coordinator-owned workers; provenance сохранён в `run.coordinatorComponentManifests` и приватном `phase03-adoption.json`, это не пять Native plan nodes старого run. Исторические scoped results не заменяют итоговый coordinator checkpoint. Текущие задачи этапа04 используют frozen interfaces, ограниченные write scopes и независимый CLI oracle.

| Фаза | Статус | Следующий проверяемый шаг |
| --- | --- | --- |
| 01 Baseline/plan | ACCEPTED; PR #10 MERGED `ef38109e`; обе ОС CI PASS | Исторический baseline сохранён |
| 02 Language quality | ACCEPTED; [PR #11](https://github.com/Zulut30/Kodo/pull/11) MERGED `dabecb7`; f72 local870/864 PASS/6 SKIP, security/review PASS | CI41877990343 завершён: Linux872/854 PASS/18 SKIP, Windows870/864 PASS/6 SKIP; installed CLI smoke обеих ОС PASS. Evidence историческое для phase02 |
| 03 CI/cache/concurrency | **ACCEPTED**, [PR #12](https://github.com/Zulut30/Kodo/pull/12) MERGED `b3304b47ae47fdc8f626e692523761bad7535fa6`; source `2c9e957`: local1031/1025 PASS/6 SKIP, security/review PASS | [CI41907865119](https://github.com/Zulut30/Kodo/actions/runs/41907865119) обе ОС PASS, installed CLI smoke PASS, одинаковый archive SHA-256 `1c429465fc0d816284e932c4ca2b7a457acf06dc11b412ee57cccf7c6c52effa`. CI Node counts неизвестны. [Приёмка и ограничения](phase-03.md); нового release/deployment нет |
| 04 Architecture | **IN PROGRESS, NOT ACCEPTED**; локальные A–E интегрированы, E scoped26/26 PASS, H offline CLI examples проверены; G параллельно/pending | [Phase04](phase-04.md), [форматы/примеры](../ARCHITECTURE.md), [ADR0007](../decisions/0007-architecture-guardian.md). Pending enabled Engine gate, integrated full/security/independent review и required CI. UI disabled/neutral; artifact/release/deployment не проверены |
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
