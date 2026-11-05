# Прогресс Kodo roadmap

Снимок: 2026-11-05. Авторитетные run state и receipts хранятся вне Git в SQLite Kodo. Этап04 принят; этап05 имеет scoped local evidence, общие gates ещё pending. Пользователь выбрал [рабочий MVP всех13этапов](MVP-SCOPE.md), расширенные проверки и benchmark после него; целевой бюджет10часов от15:36UTC не отменяет acceptance.

Пользователь отдельно потребовал пять одновременных задач. Разработка независимых worktree выполняется параллельно; приёмка и merge этапов сохраняют порядок. Компоненты ускорения03 пришли от отдельных coordinator-owned workers; provenance сохранён в `run.coordinatorComponentManifests` и приватном `phase03-adoption.json`, это не пять Native plan nodes старого run. Исторические scoped results не заменяют итоговый coordinator checkpoint. Задачи05 используют frozen interfaces и ограниченные write scopes; concurrency5/maxTasks12/repair3/research10 и меньшие сохранённые limits не расширяются.

| Фаза | Статус | Следующий проверяемый шаг |
| --- | --- | --- |
| 01 Baseline/plan | ACCEPTED; PR #10 MERGED `ef38109e`; обе ОС CI PASS | Исторический baseline сохранён |
| 02 Language quality | ACCEPTED; [PR #11](https://github.com/Zulut30/Kodo/pull/11) MERGED `dabecb7`; f72 local870/864 PASS/6 SKIP, security/review PASS | CI41877990343 завершён: Linux872/854 PASS/18 SKIP, Windows870/864 PASS/6 SKIP; installed CLI smoke обеих ОС PASS. Evidence историческое для phase02 |
| 03 CI/cache/concurrency | **ACCEPTED**, [PR #12](https://github.com/Zulut30/Kodo/pull/12) MERGED `b3304b47ae47fdc8f626e692523761bad7535fa6`; source `2c9e957`: local1031/1025 PASS/6 SKIP, security/review PASS | [CI41907865119](https://github.com/Zulut30/Kodo/actions/runs/41907865119) обе ОС PASS, installed CLI smoke PASS, одинаковый archive SHA-256 `1c429465fc0d816284e932c4ca2b7a457acf06dc11b412ee57cccf7c6c52effa`. CI Node counts неизвестны. [Приёмка и ограничения](phase-03.md); нового release/deployment нет |
| 04 Architecture | **ACCEPTED**, [PR13](https://github.com/Zulut30/Kodo/pull/13) merged a674091; afbbe68 local1276/1270 PASS/6 SKIP, security/review PASS | [CI41937874907](https://github.com/Zulut30/Kodo/actions/runs/41937874907) Linux/Windows success; первый Windows Git10000ms timeout сохранён, один exact-head retry без правок. Installed artifact SHA-256 b17084cf206206d60088e61e8b6284af43fed2efa21593bb11f53236fdd83cb0, не опубликован. UI/architecture selfhost disabled neutral. [Приёмка04 и audit recorded-instructions](phase-04.md) |
| 05 Research knowledge | **IN PROGRESS, NOT ACCEPTED**; A/B/C/D/E scoped checks и H18 offline CLI observations, requests0 | [Phase05](phase-05.md), [форматы/CLI/ограничения](../KNOWLEDGE.md). Root fake-only probe выявил default CLI known-credential gap; bounded repair и integrated full/security/independent review/required CI pending. E48+5 пересекаются, не53 unique; F4→8 static only, speedup не доказан. UI/architecture selfhost disabled neutral; native client/artifact/release/deploy05 не проверены |
| 06 Project Director | NOT STARTED | После05: versioned DB/legacy compatibility |
| 07 Swarm | NOT STARTED | После06: durable jobs/leases/idempotency |
| 08 Context/budget | NOT STARTED | После07: deterministic fast path |
| 09 Verification/evolution | NOT STARTED | После08: independent oracles/risk policy |
| 10 Progress/maintenance | NOT STARTED | После09: watchdog/acceptance progress |
| 11 Merge/release | NOT STARTED | После10: immutable queue/recovery/smoke |
| 12 Observability | NOT STARTED; benchmark campaigns отложены пользователем | После11: реальные operational metrics/JSON; неизвестные метрики null |
| 13 Final acceptance | NOT STARTED | После12: реальные сценарии и проверенный выпуск |

[Baseline](BASELINE.md), [приёмка01](phase-01.md), [изменения и evidence02](phase-02.md). Исторические [local](../../tests/fixtures/roadmap-baseline/local-baseline.json) и [CI](../../tests/fixtures/roadmap-baseline/ci-baseline.json) receipts не перезаписываются. Published0.2.6 является прежним выпуском; новый release запланирован на фазе13.
