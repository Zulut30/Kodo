# Прогресс Kodo roadmap

Снимок: 2026-11-04. Авторитетные run state и receipts хранятся вне Git в SQLite Kodo. Этот документ отражает состояние до итоговых gates текущего commit. Пользователь выбрал [рабочий MVP всех13этапов](MVP-SCOPE.md), расширенные проверки и benchmark после него; целевой бюджет10часов от15:36UTC.

Пользователь отдельно потребовал пять одновременных задач. Разработка независимых worktree выполняется параллельно; приёмка и merge этапов сохраняют порядок. Пять drafts ускорения получили реальные scoped результаты: pool53+3, Windows61, profiler14, graph17, CI18. Совместимость компонентов проверяется отдельно; это не общий PASS этапа03.

| Фаза | Статус | Следующий проверяемый шаг |
| --- | --- | --- |
| 01 Baseline/plan | ACCEPTED; PR #10 MERGED `ef38109e`; обе ОС CI PASS | Исторический baseline сохранён |
| 02 Language quality | f72: full870/864PASS/6SKIP, security и независимое review PASS. Go findings устранены и conversations resolved; один старый fixture guard приведён к общему integrationTimeoutMs | Exact-head CI41877990343 ожидает GitHub runners; [PR #11](https://github.com/Zulut30/Kodo/pull/11) ещё не merged |
| 03 CI/cache/concurrency | Пять drafts собраны; scoped85/85PASS наb69 и CI clean-source regression33/33PASS. Real Kodo small-JS feedback4.29s, completefalse/L2required; свежий Go repair включён | После02acceptance: integrated full check/review/requiredCI; broad quality покаblocked |
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
