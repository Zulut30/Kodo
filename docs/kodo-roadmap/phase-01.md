# Этап 01 — baseline и план

Дата: 2026-11-04. **Baseline PASS; локальная документационная приёмка PASS.** Финальные independent review/PR/exact-final-head CI ещё PENDING у координатора. Исходный HEAD `d2654f12b1da21dfa3523fa9b1aea72b51a050ba`, версия 0.2.6. Изменения ограничены `docs/kodo-roadmap/` и JSON-данными `tests/fixtures/roadmap-baseline/`; runtime/config/CI/tests executable и пользовательские prompts сохранены.

Подготовлен [BASELINE](BASELINE.md): исходные SHA/tree, команды и измерения, module/trust map, риски, требования всех 12 следующих фаз и последовательные PR-срезы. Прочитаны master/01–13, AGENTS и основные docs; inspect опирается на реальные runtime/CLI/contracts/tests. Использованы действующие Kodo adapters ADR/worktrees/Spec Kit/ce-compound; нового архитектурного решения и ADR нет.

| Приёмка | Факт / доказательство |
| --- | --- |
| Чистый исходный worktree и идентичность | Worker HEAD `d2654f1`; tree `6839577d42a792b2fda83a87007b29be67b4e306`, совпадает с CI-tested `c19157b` |
| Local install | Координатор: `npm ci --ignore-scripts --no-audit --no-fund`, exit 0, 3454.1352 ms; [receipt](../../tests/fixtures/roadmap-baseline/local-baseline.json) |
| Local check | Координатор: `npm run check`, exit 0, 579186.6849 ms; runner 577586.0121 ms, 731 tests / 729 pass / 0 fail / 0 cancelled / 2 skip |
| Local package smoke | Координатор: `node scripts/package-smoke.mjs`, exit 0, 7878.8475 ms. `.tgz` 0.2.6 SHA-256 `4b53673c308d73413bb3c4e82541ec0128dcbe6f576486579efd2cceca725650`, installed bin/help/validate/list/pins, 33/13/183 PASS |
| Local total wall | 590524 ms по start/end receipt; worker не дублировал repository-wide suite |
| CI Linux/Windows | [run 41813816870](https://github.com/Zulut30/Kodo/actions/runs/41813816870), success на `c19157b`; jobs 119/669 с, check 97/612 с, package 3/34 с; [receipt](../../tests/fixtures/roadmap-baseline/ci-baseline.json) |
| Exact-main / exact-final CI | Не заявлен; старый CI tree-identical, новый PR требует актуальных checks точного HEAD |
| JSON/docs validation | PASS: JSON parse/allowlist/hash/цифры receipts, Markdown links/anchors и scope; существующие tracked-файлы не менялись |
| Независимое review / PR | Следующий этап координатора, PENDING; этот worker не выполняет delivery |

UI disabled (`passed:null`), native CLI inference и benchmark в этой фазе NOT RUN. Оба официальных CLI auth-status сегодня OK (`doctor live:false`); сам documenter работает в реальной подписочной сессии видимого Codex desktop чата. Эти уровни не подменяют друг друга. Security gates включены, свежие scanner receipts перед review/delivery остаются у координатора. Публичный release 0.2.6 скачан/установлен координатором до этого поручения — отдельное историческое evidence; новой проверки remote asset здесь нет. Deployment NOT CONFIGURED; этап 01 **без нового release**.

Внешний риск: PR9 после HTTP 504 остаётся OPEN по последнему read-back, хотя main tree совпадает с протестированным commit; merge PR9 не объявлен. Полный [risk register](BASELINE.md#risk-register) сохраняет эту несогласованность. Known-current flaky не установлен; долгие tests отмечены как кандидаты профилирования, без ослабления.

Следующий шаг: coordinator integrated gates → независимое differential review → PR с required checks точного итогового HEAD. Baseline/scoped docs готовы, delivery и merge не объявлены; до приёмки этапа 01 фаза 02 не начинается. [Прогресс](progress.md).
