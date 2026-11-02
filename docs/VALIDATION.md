# Проверки Kodo

Состояние на 2 ноября 2026 года. Результаты разделены на автоматические проверки, реальные подписочные сессии и проверку выпуска.

## Автоматические проверки

```powershell
npm run check
node scripts/package-smoke.mjs
```

[CI Windows/Linux с Node.js 24](https://github.com/Zulut30/Kodo/actions/workflows/ci.yml) выполняет эти команды. Smoke упаковывает сам Kodo, устанавливает `.tgz` в изолированный каталог, запускает установленный CLI и проверяет 13 закреплённых навыков, 183 оригинальных файла и 33 компонента каталога. Точные итоги каждого commit находятся в его CI; локальный Windows-прогон не подменяет Linux-проверку.

Обычные тесты используют фикстуры, локальные Git/npm-пакеты и контролируемые ответы провайдеров. Платных API-запросов и подписочных модельных вызовов в CI нет. Платформенные проверки DPAPI и Unix permissions запускаются на соответствующей ОС.

| Требование | Регрессионная проверка |
| --- | --- |
| Все навыки включены по умолчанию для трёх клиентов | `CLI init installs all default skills and the chat entry for Codex Claude Code and OpenCode` |
| Все 13 навыков рассматриваются на каждом этапе | `Default policy evaluates all thirteen pinned skills at every runtime stage without network calls` |
| Изменённый upstream не используется незаметно | `Default policy rejects altered pinned source and invalid provenance before building a prompt` |
| Продолжение точной сессии после лимита | `Engine waits for quota then resumes the exact recorded worker session` |
| Восстановление после squash merge без сохранённой квитанции | `Engine reconciles a real squash merge before changing its reviewed head after a missing receipt` |
| Версии не пересекаются с ещё не опубликованным merge | `Second assigned run bumps past a merged but unpublished target version` |
| Новые зависимости устанавливаются после изменения lock | `Setup installs missing dependencies despite legacy Ajv and refreshes changed locks while reusing unchanged installs after reopen` |
| Известные ключи не попадают в рабочий промпт | `Worker prompts remove known credentials from analysis and host plans while preserving credential-handling code examples` |
| Выпуск устанавливается и восстанавливается без повторной публикации | `Release packages exact merged commit installs artifact and reconciles without republishing` |

Также проверяются отмена, неверные контракты, недоступность Jev и источника исследования, пересекающиеся области записи, сохранность пользовательских файлов, повторные проверки после ревью и изменения main, Git hooks/окружение, свежесть тегов, права хранилища и подмена артефактов. Все три пресета включают стандартные навыки и чат-вход Kodo; dry-run не создаёт целевой каталог.

## Целевые проверки аудита

```powershell
node --test --test-reporter=spec tests/audit.test.mjs tests/audit-cli.test.mjs
```

В документирующем worktree на базе `14d724a1d65865150c9abe8c797a48fd75bd547b` 2 ноября 2026 года выполнен локальный прогон на Windows, Node.js `v24.19.0`: **127 passed, 0 failed, 0 skipped**. Проверены существующая реализация и независимые контрактные тесты; код и тесты в этом этапе не менялись. Это целевая локальная проверка, а не результат общего CI, native-клиента, опубликованного пакета или развёртывания. Полные `npm run check`, упаковку и выпуск после интеграции выполняет координатор.

`tests/audit.test.mjs` проверяет публичный `buildAuditReport(run)` на самостоятельно заданных фикстурах. `tests/audit-cli.test.mjs` запускает реальный CLI отдельным процессом с временной SQLite-базой, без проекта и доступных Git-команд. Сетевые обращения, дочерние процессы и чтение файлов ключей/конфигурации перехватываются как ошибки. Отдельный subprocess запускает CLI без права записи файлов. Неизменность проверяется для логических таблиц состояния и файлов вне SQLite; для старой базы также сравниваются байты, список файлов и схема. Это не обращение к реальным провайдерам.

Ниже точные имена ключевых тестов; параметризованные варианты дополнительно проверяют все этапы, допустимые подмножества ролей, типы полей и неверные флаги.

| Требование | Точное имя теста |
| --- | --- |
| Синхронный отчёт и точная схема | `Audit report exports a synchronous allowlisted schema with canonical complete coverage` |
| Все ID совпадают с публичным набором | `Audit fixtures cover all 13 public default skill IDs` |
| Перестановка решений не нарушает полноту | `Audit normalizes shuffled stage records and skill decisions deterministically` |
| Только роли текущего плана, без дубликатов | `Audit derives expected stages from subset roles tester,tester` |
| Отсутствующая стадия | `Audit detects missing expected stage tester` |
| Отсутствующий или пустой план исключает полноту | `Audit cannot claim completeness with missing tasks`; `Audit cannot claim completeness with empty tasks` |
| Необязательный repair проверяется при наличии | `Audit includes repair only when recorded and validates it` |
| Лишний известный этап тоже проверяется | `Audit validates recorded known stages even when their roles are not required` |
| Неизвестный этап не даёт полного покрытия | `Audit rejects unknown recorded stages without leaking their payload` |
| Формат хеша, уникальность ID и revision | `Audit invalidates uppercase hash`; `Audit invalidates duplicate default skill`; `Audit invalidates uppercase revision for applicable and non-applicable skills` |
| Неприменимость учитывается, семантика не доказана | `Audit accepts valid non-applicable decisions without claiming semantic compliance` |
| Квитанции фильтруются, полнота не равна успеху | `Audit allowlists receipts and omits tasks prompts source paths config and provider output` |
| Вложенные значения не обходят список полей | `Audit does not copy nested arbitrary values through malformed allowlisted receipt fields` |
| `false` и `0` сохраняются без приведения типов | `Audit preserves false receipt booleans and zero exit codes without coercing malformed scalars` |
| Вложенный вход остаётся неизменным | `Audit never mutates nested input including shuffled arrays malformed policies and receipts` |
| Чистая функция не требует записи или subprocess | `Audit pure builder succeeds with filesystem writes and child processes forbidden` |
| CLI работает вне проекта | `Audit CLI JSON reads a saved run from an unrelated no-config cwd` |
| Ключи и конфигурация не читаются, состояние сохраняется | `Audit CLI ignores broken credentials and configs without changing saved state or worktrees` |
| CLI работает при запрете записи | `Audit CLI reads saved state with filesystem writes forbidden` |
| Отсутствующая база не создаётся | `Audit CLI unknown run does not initialize a missing state home` |
| Старая база остаётся без миграции | `Audit CLI reads a legacy saved run without changing database bytes or adding schema` |
| Старый запуск читается с кодом 0 и неполным покрытием | `Audit CLI returns exit zero and incomplete JSON for old saved runs` |
| Некорректная политика не превращается в ошибку чтения | `Audit CLI returns exit zero with invalid recorded policy flagged` |
| Текст объясняет пределы доказательств | `Audit CLI text explains coverage missing and invalid stages applied skills and evidence limits` |
| Неизвестный ID даёт ошибку без изменения состояния | `Audit CLI rejects an unknown run in JSON mode without state changes` |
| Неверные аргументы отклоняются | `Audit CLI rejects missing ID`; `Audit CLI rejects duplicate JSON flag`; `Audit CLI rejects unknown flag` |
| Команда видна в справке | `Audit CLI help advertises audit RUN_ID and optional JSON output` |

Красная фаза TDD и последующая зелёная проверка другим тестовым узлом требуют отдельных свидетельств координатора; этот прогон документации подтверждает только текущее зелёное состояние. Наличие в тесте комментария о RED не доказывает прежнее падение. Для приёмки текущего запуска также нужны независимое ревью, protected PR, merge и проверка выпущенного пакета. Их успех здесь не заявлен. [Граница отчёта](decisions/0001-run-audit-evidence.md).

## Реальная приёмка пайплайна

| Прогон | Наблюдаемый результат |
| --- | --- |
| Codex: `dd933f2f-4208-430f-9064-2bbcad9d614b` | Статистика каталога, отдельные тестовый и документирующий агенты, независимое ревью, CI и [merge PR №3](https://github.com/Zulut30/Kodo/pull/3). |
| Claude Code: `224b5631-9e3e-40f7-aece-2a619bdc49b3` | Поиск каталога, отдельные тесты и документация, независимое ревью, CI и [merge PR №2](https://github.com/Zulut30/Kodo/pull/2). |
| Обе подписки: `4de87393-1087-4e57-94d0-6c012f2d9099` | В отдельном временном проекте Jev выбрал Codex Sol для реализации и Claude Sonnet для тестов. Документирование и независимое read-only ревью завершены; 9 тестов прошли без ошибок и пропусков. |

В смешанном прогоне подготовка и продолжение выполнялись разными процессами с одним runId; анализ выполнялся один раз. В прогонах самого Kodo выполнены отмена и продолжение, сохранён единственный PR каждого запуска. Поиск попал в main раньше статистики; при обновлении второй ветки возник реальный конфликт CLI. После его разрешения обе команды прошли совместные 46 целевых проверок, затем общие проверки, новое независимое ревью и CI перед merge.

Начальные ошибки ядра, устаревшие зависимости и позднее обнаружение изменения main были обнаружены во время этих прогонов. Исправления подготовлены с регрессиями. Ключи не передавались исполнителям; GPT и Claude выполнялись через авторизованные подписочные клиенты.

## Реальные внешние сервисы

Gemini `gemini-4-argon` выполнил анализ проекта; TypeSafe Jev вернул структурированные решения. Получены реальные результаты Reddit API, GetXAPI и Scrape.do для X, GitHub, Hacker News и документации. Отдельная проверка Reddit вернула 8 ссылок за один запрос без ошибки источника. Смешанный прогон получил результаты всех пяти источников без ошибок и использовал Jev без fallback.

Результат поиска остаётся источником идей: ссылка не подтверждает лицензию библиотеки, совместимость или воспроизведение её поведения. Короткое обращение к сервису не доказывает стабильность его будущих лимитов.

## Проверка выпуска

Для [выпуска CLI 0.2.1](https://github.com/Zulut30/Kodo/releases/tag/v0.2.1) координатор проверяет точный merged commit, выполняет тесты, создаёт `.tgz` и SHA-256, устанавливает пакет в изолированное окружение и запускает команды установленного `kodo`. После загрузки проверяются удалённый тег и скачанные байты assets. Публикация в npm не выполняется.

Итоговая квитанция запуска `6ea17f8f-5709-499c-80f0-8e5c5899f63e` содержит PR, merge commit, версию, URL архива, SHA-256, платформу и результаты installed smoke. Выпуск считается опубликованным только после успешного подтверждения этих действий; push не называется деплоем.

MCP-шаблоны проверены как конфигурации. Это не является доказательством живого соединения с произвольным GitHub MCP, браузером или базой данных. Хранение ключей и границы доверия описаны в [SECURITY.md](SECURITY.md).
