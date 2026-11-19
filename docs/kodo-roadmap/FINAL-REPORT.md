# Kodo 1.0.0: итог требований и доказательств

Дата: 2026-11-19. Программа: этапы 01–13 roadmap и фабрика проектов F1–F3 (решения пользователя 2026-11-17, см. [phase-13](phase-13.md)). Отчёт различает уровни доказательства: **local** (Windows 11, Node 24.19, эта машина), **CI** (GitHub Actions, Linux и Windows), **native** (реальные подписочные клиенты), **installed** (установленный `.tgz`), **published** (GitHub Release), **deployed**. Нет наблюдения — `NOT RUN` или `unknown`, а не PASS.

Квитанции выпуска внесены после публикации: PR #24 влит в `main` как `3708333` (дерево идентично проверенной голове PR `4e7f973`), тег `v1.0.0` указывает на `3708333`, GitHub Release `v1.0.0` опубликован, скачанный архив проверен и установлен.

## Требования

| Требование | Статус | Где доказано |
| --- | --- | --- |
| Этапы 01–11 (baseline, качество, CI/кэш, архитектура, знания, Project Director, оркестрация, проверки, behaviour gate, сторож прогресса, журнал доставки) | ACCEPTED | PR #10–#21, CI обеих ОС; [progress.md](progress.md) |
| 12 Операционный отчёт `kodo report` | ACCEPTED | PR #22 (`a72326f`), CI обеих ОС; гейты волнового режима — исправление 5 этапа 13 |
| F1–F3 Фабрика проектов: волны, интеграционная ветка, gate Run, хост T3, чертёж, extend | ACCEPTED | PR #23 (`b12eed4`), 15 раундов независимого ревью, CI обеих ОС |
| 13① Офлайн-сценарии A, C, E, F | PASS local; PASS CI | `tests/final-scenarios.mjs` — отдельная команда `npm run test:final`, не входит в `npm run check` и L2. Local: 7/7 на `45092e0` (1274 с и 1337 с), E4 на `8a52f91`, `1cf84db` и `4e7f973` (240–272 с). CI: отдельный шаг на Linux и Windows — 8/8 (7 сценариев и проверка песочницы) на `3fadb71`, success на `4e7f973` (run 44598107494) |
| 13① B (mini Rust/Git), D (Hearthstone) | NOT RUN | Исключены решением пользователя |
| 13② Нативные Codex и Claude | PASS native | Run `cfb6ffba` (Codex, после исправлений 1–2), `19a9b9ff` (Claude) |
| 13② Отмена и продолжение | PASS native | Run `346684f0`: `cancelled` за ~1 с, `resume` → `succeeded` |
| 13② Обе подписки (`--providers both`) | PARTIAL | Run `b55b367f` `succeeded`, но все сессии — Codex; участие Claude не наблюдалось |
| 13② Квота подписки | NOT RUN | Лимит не наступил; поведение `waiting_limits` — только в тестах |
| 13③ Живой пилот фабрики в T3 | PARTIAL | Волна 0 принята вживую; эпик модулей заблокирован дефектом продукта (гейт верно не пропустил); эпик CLI интегрирован, не принят; [phase-13 ③](phase-13.md) |
| 13③ `extend` вживую | NOT RUN | Нужен принятый проект; сценарий F — PASS local |
| Orca | NOT RUN | Протокол общий с T3, хост не проверялся |
| TokenEconomizer (hooks/injection, экономия) | unknown | Нет наблюдения поддерживаемого пути |
| Лицензии | PASS local на `f42ffca` | 13 закреплённых навыков: 12 MIT, 1 CC-BY-SA-4.0 (`skills/differential-review`, trailofbits/skills); файлы лицензий на месте, SHA-256 совпадают с `third-party-skills.lock.json`. Пакет Kodo `private: true`, без поля `license` |
| Выпуск: GitHub Release `.tgz` + SHA-256 | PASS published, installed | [Release v1.0.0](https://github.com/Zulut30/Kodo/releases/tag/v1.0.0): `zulut30-kodo-1.0.0.tgz` (1 194 353 байт), SHA-256 `13d56ff42d7b0ed897921edf6dd083c2ae7bee7cd24430d4149d9984ee70c99e`, `SHA256SUMS`; публикации в npm нет (решение) |
| Развёртывание | not_configured | У Kodo нет целевой среды развёртывания |

## Матрица доказательств

| Уровень | Наблюдение и его источник |
| --- | --- |
| local | Windows 11, Node 24.19: `npm run check` на `3fadb71` — exit 0, 2381 тестов, 2370 pass, 0 fail, 11 skipped (44 мин); `4e7f973` отличается файлом сценариев (вне `npm run check`), текстом справки и документацией. Целевые тесты исправлений 1–5 и находок ревью падали на прежнем коде и проходили после правки. Local L2 через `scripts/ci.mjs`: security — `tool_missing` (Semgrep и Gitleaks на машине не установлены), на загруженной машине полный check прервался по пределу 40 мин без упавших тестов |
| CI | Голова PR `4e7f973`, run 44598107494: `check (ubuntu-latest, 24)` и `check (windows-latest, 24)` — success; в каждом L2 (`npm run check` + Semgrep и Gitleaks — passed), шаг `npm run test:final` и проверка установленного пакета — success. Windows L2 на `3fadb71` — 38 мин 46 с из предела 40 мин |
| native | Codex CLI 0.170.0 и Claude Code по подпискам: 5 Run (`kodo run`) и 5 gate Run пилота (19 сессий Codex, ~82 мин сессий, 11,65 млн токенов, из них 10,17 млн из кэша) |
| installed | Архив выпуска `v1.0.0` (собран из `3708333`), скачанный `gh release download`: SHA-256 совпал с `SHA256SUMS` и с архивом, проверенным перед публикацией; `npm install -g --prefix <чистый каталог> --ignore-scripts`: `kodo --help` — exit 0; `validate --json` — exit 0, version 1.0.0, 34 компонента; `doctor --json` — Codex и Claude Code по подписке `ok`, exit 2 из-за ненастроенных необязательных ключей исследования; `report --project <пилот>` — exit 0 (5 гейтов, 1 блокер); `report <неизвестный Run>` — `report_not_found`. Справка проектных команд — в `kodo --help` (есть `project gates`); `kodo project --help` отвечает `project_arguments` |
| published | GitHub Release `v1.0.0` (тег на `3708333`), ассеты `zulut30-kodo-1.0.0.tgz` и `SHA256SUMS`; digest ассета в GitHub — `sha256:13d56ff4…c99e` |
| deployed | not_configured |

## Найдено и исправлено в этапе 13

Шесть дефектов, выявленных живым пилотом и нативными прогонами (изоляция MCP Codex, доступ песочницы Codex к evidence, повтор гейта в T3, ревью отремонтированной головы гейта, гейты в отчёте проекта, справка `--client`) — исправления 1–5 с регрессионными тестами, 6 (справка `--client`) без теста; таблица — в [phase-13](phase-13.md#исправления-по-итогам-пилота). Без исправлений 1–2 нативные прогоны Codex на этой машине (Windows, Codex CLI 0.170.0) не проходили.

## Не заявляется

- Чистая задержка LLM, число нативных HTTP-запросов, точная стоимость подписки в USD, победитель benchmark.
- Принятие всего проекта пилота, участие Claude в Run `--providers both`, поведение при реальной квоте, Orca, экономия TokenEconomizer.
- Развёртывание.
