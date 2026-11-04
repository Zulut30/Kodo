# Прогресс Kodo roadmap

Снимок: 2026-11-04. Фаза 01 принята: PR #10, merge `ef38109e4bc8dc0f8528fc2ee0439c8590d9a734`, CI `41822569460` на итоговом PR HEAD с идентичным merge tree. Фаза 02: независимый RED исходного `977f9767ee9b56c8789b1b67b5e9a482d57a8887` сохранён; coordinator repair `f704586c6fe0c5cc6cb163b3a3998d85eb0e511b` прошёл scoped GREEN и интегрирован как `ac225c8b7eb4945ec32a8a5a15a74aeb24d3dd58`. Более поздний `4042edd9` прошёл local/Linux, но Windows CI `41836243161` упал на realpath; независимо подтверждён ложный Quick PASS при изменении конфигурации смешанного JS/TS проекта. Текущий worker repair этих двух дефектов выполняется поверх `4042edd9`, без commit/delivery; его новые проверки перечислены в [phase-02](phase-02.md). Это версия плана в Git; авторитетное состояние run хранится в приватном SQLite, его `progress.md` создаёт runtime. Этот документ не меняет состояние run.

| Фаза | Статус выполнения | Следующий проверяемый шаг |
| --- | --- | --- |
| 01 Baseline/plan | ACCEPTED; PR #10 MERGED `ef38109e`; обе ОС CI PASS | Предпосылка 02 выполнена; нового release нет |
| 02 Language quality | RED 977f и 4042 сохранены; Windows paths/Quick metadata repair scoped GREEN 98/98 normal + 98/98 real 8.3 TEMP/TMP; frozen acceptance oracle неизменён; repair01/receipt.json | Новый full integrated check, fresh gates, independent review и exact-head Linux/Windows CI PENDING; этап ещё не принят |
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

Результаты и пределы: [BASELINE](BASELINE.md), [phase-01](phase-01.md), [phase-02](phase-02.md). GREEN 91/91 за 53081.6305 ms подтверждён manifest `coordinator-runner-repair-adoption.json`, неизменным acceptance SHA `7101c8462ca38870282720b5f759ec55a50ecaeae0705bc682fc6606a139db73` и raw `runner-fixes-green.tap` SHA `2b3fcc2f1b34a56fd4698c3b0e60cc5d4021ed53019f211d0939a1fb825d7b79`; private receipts находятся в `%TEMP%/kodo-roadmap-20261104/`. Это отдельная coordinator scoped-проверка исправленного кода, не full integrated check и не CI.

Публичные [local receipt](../../tests/fixtures/roadmap-baseline/local-baseline.json) и [исходный CI receipt](../../tests/fixtures/roadmap-baseline/ci-baseline.json) сохраняют исторический baseline. Итоговый [CI 41822569460](https://github.com/Zulut30/Kodo/actions/runs/41822569460) относится к [PR #10](https://github.com/Zulut30/Kodo/pull/10); фазе 02 эти результаты не приписываются. Published/installed 0.2.6 не является выпуском roadmap. Фазы 03–13 не начаты; следующий release — только после фазы 13.
