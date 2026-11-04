# Этап 01 — baseline и план

Дата: 2026-11-04. **Этап 01 принят.** [PR #10](https://github.com/Zulut30/Kodo/pull/10) merged: `ef38109e4bc8dc0f8528fc2ee0439c8590d9a734`. Координатор подтвердил integrated local checks, свежее independent review и оба security scanner gates. [CI 41822569460](https://github.com/Zulut30/Kodo/actions/runs/41822569460) успешно проверил обе ОС на итоговом PR HEAD `74bcddae735303cd009fdcad240674b63f07fd49`; его tree и merge tree совпадают: `63d13cbbc5625b7287e62fcc7c29e65b50565094`. Это PR-head CI, а не отдельный post-merge запуск. Исходный baseline HEAD `d2654f12b1da21dfa3523fa9b1aea72b51a050ba`, версия 0.2.6. Изменения фазы 01 ограничены документацией/данными baseline; runtime/config/CI/tests executable и пользовательские prompts сохранены.

Подготовлен [BASELINE](BASELINE.md): исходные SHA/tree, команды и измерения, module/trust map, риски, требования всех 12 следующих фаз и последовательные PR-срезы. Прочитаны master/01–13, AGENTS и основные docs; inspect опирается на реальные runtime/CLI/contracts/tests. Использованы действующие Kodo adapters ADR/worktrees/Spec Kit/ce-compound; нового архитектурного решения и ADR нет.

| Приёмка | Факт / доказательство |
| --- | --- |
| Чистый исходный worktree и идентичность | Worker HEAD `d2654f1`; tree `6839577d42a792b2fda83a87007b29be67b4e306`, совпадает с CI-tested `c19157b` |
| Local install | Координатор: `npm ci --ignore-scripts --no-audit --no-fund`, exit 0, 3454.1352 ms; [receipt](../../tests/fixtures/roadmap-baseline/local-baseline.json) |
| Local check | Координатор: `npm run check`, exit 0, 579186.6849 ms; runner 577586.0121 ms, 731 tests / 729 pass / 0 fail / 0 cancelled / 2 skip |
| Local package smoke | Координатор: `node scripts/package-smoke.mjs`, exit 0, 7878.8475 ms. `.tgz` 0.2.6 SHA-256 `4b53673c308d73413bb3c4e82541ec0128dcbe6f576486579efd2cceca725650`, installed bin/help/validate/list/pins, 33/13/183 PASS |
| Local total wall | 590524 ms по start/end receipt; worker не дублировал repository-wide suite |
| Исходный CI baseline | [run 41813816870](https://github.com/Zulut30/Kodo/actions/runs/41813816870), success на `c19157b`; jobs 119/669 с, check 97/612 с, package 3/34 с; [receipt](../../tests/fixtures/roadmap-baseline/ci-baseline.json) |
| Итоговый CI Linux/Windows | [run 41822569460](https://github.com/Zulut30/Kodo/actions/runs/41822569460), success на `74bcddae`; Linux 733 tests / 731 pass / 0 fail / 2 skip; Windows 731 / 729 / 0 / 2. Private coordinator receipts: `phase01-linux-ci.json`, `phase01-windows-ci.json` |
| Итоговый package smoke в CI | Обе ОС: isolated install/bin/help/validate/list/pins PASS; `.tgz` 0.2.6 SHA-256 `2dd50f8309ef72d226de97db98df678f753c878a01536988f70d9d2eba032d4c`, 33 components / 13 skills / 183 upstream files. Это CI package evidence, без нового public release |
| JSON/docs validation | PASS: JSON parse/allowlist/hash/цифры receipts, Markdown links/anchors и scope; существующие tracked-файлы не менялись |
| Независимое review / scanners / PR | PASS по подтверждению координатора; PR #10 merged `ef38109e`. Worker приёмки фазы 02 проверил локальную запись merge и совпадение tree; scanners/review не повторял |

UI disabled (`passed:null`), native CLI inference и benchmark в этой фазе NOT RUN. Оба официальных CLI auth-status на исходном baseline были OK (`doctor live:false`); documenter работал в подписочной сессии видимого Codex desktop чата. Эти уровни не подменяют друг друга. Итоговые scanner receipts принадлежат координатору. Публичный release 0.2.6 скачан/установлен координатором до этого поручения — отдельное историческое evidence; новой проверки remote asset здесь нет. Deployment NOT CONFIGURED; этап 01 **без нового release**.

Исторический риск baseline: PR9 после HTTP 504 был OPEN; его прежний read-back не является текущим статусом и не отменяет подтверждённый merge PR10. Исходный [risk register](BASELINE.md#risk-register) сохранён. Known-current flaky не установлен; долгие tests отмечены как кандидаты профилирования, без ослабления.

Предпосылка фазы 02 выполнена. Текущий срез языковых профилей и его независимая приёмка описаны в [phase-02](phase-02.md); фазы 03–13 не начаты. [Прогресс](progress.md).
