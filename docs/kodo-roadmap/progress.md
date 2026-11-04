# Прогресс Kodo roadmap

Снимок: 2026-11-04, baseline HEAD `d2654f12b1da21dfa3523fa9b1aea72b51a050ba`. Это версия плана в Git; авторитетное состояние конкретного execution run по-прежнему хранится в приватном SQLite, а его `progress.md` создаёт runtime. Этот документ не меняет состояние run.

| Фаза | Статус выполнения | Следующий проверяемый шаг |
| --- | --- | --- |
| 01 Baseline/plan | BASELINE PASS; SCOPED DOCS PASS; delivery PENDING | Coordinator integrated gates → independent review → PR с exact-head CI, без release |
| 02 Language quality | NOT STARTED | После 01: detection/status/profile fixtures |
| 03 CI/cache | NOT STARTED | После 02: timing profiler, затем affected/cache |
| 04 Architecture | NOT STARTED | После 03: forbidden-import policy fixture |
| 05 Research knowledge | NOT STARTED | После 04: typed claims/provenance/invalidation |
| 06 Project Director | NOT STARTED | После 05: versioned DB + legacy compatibility |
| 07 Swarm | NOT STARTED | После 06: durable job/lease/idempotency |
| 08 Context/budget | NOT STARTED | После 07: deterministic local fast path |
| 09 Verification/evolution | NOT STARTED | После 08: risk policy + independent oracles |
| 10 Progress/maintenance | NOT STARTED | После 09: acceptance-based progress/watchdog |
| 11 Merge/release | NOT STARTED | После 10: immutable integration queue; deployment requires configured target |
| 12 Benchmark | NOT STARTED | После 11: сохранить 9/24 PAUSED pilot; новый bounded experiment отдельно |
| 13 Final acceptance | NOT STARTED | После 12 или явно записанных blockers: сценарии A–F |

Результаты baseline и ограничения: [BASELINE](BASELINE.md), [phase-01](phase-01.md); публичные [local receipt](../../tests/fixtures/roadmap-baseline/local-baseline.json) и [CI receipt](../../tests/fixtures/roadmap-baseline/ci-baseline.json). CI на `c19157b`, tree-identical `d2654f1`, не exact-main checks. PR9 OPEN — внешний risk; published/installed 0.2.6 не является выпуском roadmap. Фазы 02–13 этим PR не реализуются.
