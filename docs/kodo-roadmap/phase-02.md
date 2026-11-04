# Этап 02 — исполняемые языковые профили

2026-11-04. **ACCEPTED.** [PR #11](https://github.com/Zulut30/Kodo/pull/11) merged в `dabecb7bec7514116e3b2870c04270bb4f83ee77`. Проверенный head: `f72ca96f5e60a7bbc760cd2aa2ce6eb06b2c5cf2`, run `808911c7-3e2a-4c7a-8003-d9aa99e5910c`. Новый выпуск запланирован на этапе 13; прежний published0.2.6 не является выпуском этих изменений.

`kodo quality detect|plan|run` предоставляет независимые capability receipts для C#, Rust, Go, TypeScript, JavaScript, CSS, HTML, PHP и SQL. Определение основано на исходниках, manifest/config/lock, без LLM. Шесть точных pins включены в существующий installer: всего16 optional tools,13 default skills,33 компонента. Missing/unsupported/disabled не становятся PASS. [Контракт](../QUALITY.md), [ADR-0005](../decisions/0005-language-quality-profiles.md).

| Requirement | Evidence |
| --- | --- |
| C# good/bad/missing/unsupported | `QACC-01 csharp good bad missing unsupported public matrix` |
| Rust good/bad/missing/unsupported | `QACC-02 rust good bad missing unsupported public matrix` |
| Go good/bad/missing/unsupported | `QACC-03 go good bad missing unsupported public matrix` |
| TypeScript good/bad/missing/unsupported | `QACC-04 typescript good bad missing unsupported public matrix` |
| JavaScript good/bad/missing/unsupported | `QACC-05 javascript good bad missing unsupported public matrix` |
| CSS good/bad/missing/unsupported | `QACC-06 css good bad missing unsupported public matrix` |
| HTML good/bad/missing/unsupported | `QACC-07 html good bad missing unsupported public matrix` |
| PHP good/bad/missing/unsupported | `QACC-08 php good bad missing unsupported public matrix` |
| SQL good/bad/missing/unsupported | `QACC-09 sql good bad missing unsupported public matrix` |
| Pins, output и filesystem scope | `QACC-12 exact pins complete versions and complete outputs are mandatory`; `QACC-13 quick scope manifest mismatches and filesystem escapes fail closed` |
| Непроверенные TypeScript roots не получают PASS | `Quality TypeScript checks every receipt root despite files exclude and noCheck`; `Quality native TypeScript compiler seals dependency closure` |
| Go dependency closure и offline vendor | `Quality native Go ignores parent workspace and never certifies sibling dependency bytes`; `Quality native Go prepared vendor works offline and tracks dependency errors and quick scope` |
| Сохранность работы при конфликте | `Engine drains workers after real Git merge interruption and recovers the owning conflict before other integrations` |

Обычный CI использует offline fixtures, fake tool/provider ports и настоящие Git/Node процессы, без платных запросов. Независимый frozen oracle SHA-256: `7101c8462ca38870282720b5f759ec55a50ecaeae0705bc682fc6606a139db73`. Он не изменялся при ремонтах. История исходных failures сохранена в Git и приватных immutable receipts.

## Проверенная ревизия

На точном `f72ca96` полный локальный `npm run check`: **870 tests /864 PASS/6 SKIP/0 FAIL/0 cancelled**, 538408.7494ms. Semgrep1.183.0 и Gitleaks8.30.1 PASS; UI disabled (`passed:null`). Независимое read-only review PASS, findings=[]; `kodo/review` связан с этим head и diff `e9c8dab3564db8d344f84ceaec77aeeb1200d1befdcaa5c2a89c5420a025f33d`.

[CI41877990343](https://github.com/Zulut30/Kodo/actions/runs/41877990343): Linux **872/854 PASS/18 SKIP/0 FAIL**, 107180.680555ms; Windows **870/864 PASS/6 SKIP/0 FAIL**, 642967.0379ms. Wall jobs121s/704s. Обе ОС проверили установленный CLI-пакет; одинаковый `.tgz` SHA-256: `c49844f634255a0cc09654fafeb5a6de43794a2a49168b6302e36c17d800f817`. Пропуски явно отмечены, не включены в PASS. Защита main и required conversations сохранены; после подтверждённых исправлений оба Go review threads разрешены, merge выполнил Kodo.

## Реальные SDK и ограничения

Настоящий managed TSC7.0.2 подтвердил закрытие dependency closure, явных ambient types и coverage всех roots:14 PASS. Настоящий Go1.24.0 воспроизвёл внешний parent workspace и игнорирование vendor, затем подтвердил stdlib/vendor PASS, ошибку типа зависимости FAIL, stale receipt и quick owner recheck:4 PASS. Финальный scoped набор с Go:118 PASS/2 SKIP; выбранные frozen QACC:12 PASS. Go запускается с отключёнными GOWORK/GOENV и приватными offline caches; все vendor bytes входят в fingerprint без создания дополнительных project profiles. Все Go replacements и подготовка внешнего module cache явно unsupported в MVP.

Native Windows version probes и14 good/bad CLI-сценариев JS/TS/CSS/HTML/SQL/PHP сохранены отдельно. Native compilation C#/Rust и полная SDK/platform matrix остаются NOT VERIFIED. Подписочные Codex/Claude CLI E2E и выпуск относятся к этапу13. Deployment не выполнялся.

Локальный полный прогон однажды отменил старый scheduler fixture после26.404s при отдельном лимите25s. Этот единственный guard приведён к уже существующему `integrationTimeoutMs=60000`; handshake, drain, реальные Git-конфликты и все assertions сохранены. Целевой сценарий прошёл, затем полный f72 и обе ОС CI прошли. Лимиты попыток/режим сохранённого run не расширялись. Остальные исходные дефекты — output parsing, Windows aliases, compiler roots и teardown race — описаны в [QUALITY](../QUALITY.md) и сохранённой истории.
