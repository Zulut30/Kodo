# Контекст и бюджеты: манифест сессии, быстрый путь, явные лимиты

Этап 08 добавляет три вещи к существующим ограниченным упаковщикам контекста ([EFFICIENCY](EFFICIENCY.md)) и режимам исполнения ([RUNTIME](RUNTIME.md)). Решения описаны в [ADR-0010](decisions/0010-context-manifest-fast-path-budgets.md).

## ContextManifest

Перед каждой нативной сессией Engine записывает манифест: что именно получила сессия. Манифест хранит только размеры, флаги и ссылки на неизменяемые evidence. Текста prompt, приватных путей и секретов в нём нет по построению.

```json
{
  "schemaVersion": 1,
  "kind": "context-manifest",
  "runId": "…",
  "stage": "developer",
  "node": "feature",
  "headSha": "…",
  "limitBytes": null,
  "totalBytes": 6700,
  "mandatory": { "contract": { "kind": "node-contract", "file": "node-contract-<sha256>.json", "sha256": "…", "bytes": 120, "headSha": "…" } },
  "sections": [
    { "name": "guidance", "bytes": 900, "mandatory": true },
    { "name": "instructions", "bytes": 300, "mandatory": true },
    { "name": "task-context", "bytes": 1500, "mandatory": true },
    { "name": "evidence", "bytes": 4000, "mandatory": false, "originalBytes": 52000, "truncated": true, "omitted": [{ "field": "analysis.files", "items": 40 }] }
  ],
  "references": [{ "kind": "analysis", "file": "analysis-<sha256>.json", "sha256": "…", "bytes": 120, "headSha": "…" }]
}
```

Манифест хранится вместе с записью сессии: `run.sessionAttempts[].manifest`, его SHA-256 — в `manifestSha256`. Отдельным файлом evidence он не сохраняется: подготовка защищённого каталога evidence на каждую сессию стоила бы дороже самой подготовки сессии. `totalBytes` равен `metrics.promptBytes` той же сессии.

Правила:

- Обязательные секции (`guidance`, `instructions`, `task-context`, `gates`) не сокращаются. Манифест с сокращённой обязательной секцией не строится.
- Сессия с `task-context` обязана ссылаться на свой `node-contract`. Контракт содержит полные acceptance-критерии узла.
- Сокращённая секция обязана перечислить, что она потеряла (`omitted`). Молчаливого сокращения нет.
- Ссылка без корректного SHA-256 записывается как непроверяемая (`sha256: null`) и никогда не считается контрактом.

`manifestFreshness(manifest, { headSha, hashes })` отвечает, описывает ли манифест текущие входы:

| Статус | Когда |
| --- | --- |
| `fresh` | Evidence на месте с теми же хэшами, head не изменился |
| `stale` | Evidence цело, но head ушёл вперёд |
| `invalidated` | Файл evidence пропал или его хэш изменился |
| `unknown` | Текущее состояние не наблюдалось или версия манифеста не поддерживается |

## Быстрый путь

До обращения к Jev Engine локально, без модели, проверяет, является ли задача доказанно маленькой правкой стилей. Доказательство требует всего сразу:

1. Текст задачи не длиннее 800 байт, без URL, абсолютных путей и `..`.
2. Задача называет от одного до трёх путей, и все они — стили: `.css`, `.scss`, `.sass`, `.less`, `.styl`, `.pcss`. Любой другой путь вида `name.ext` в тексте — сомнение.
3. Каждый названный файл существует, отслеживается Git, является обычным файлом не больше 64 КБ и не лежит в скрытом каталоге.
4. В тексте нет слов о поведении, данных и доставке (auth, login, password, token, migration, deploy, release, delete, install, script, api, refactor и русские аналоги).
5. Явно не запрошен режим `standard` или `deep`.

При доказательстве выбирается профиль `quick` с `executionMode.source: "fast-path"`: без Jev, Gemini и research, один исполнитель. Проверки проекта, включённые gates и независимое ревью выполняются как обычно.

Любое сомнение возвращает обычный маршрут: оценка Jev, затем `quick`, `standard` или `deep`. Причина сомнения — код из списка: `mode_requested`, `task_too_long`, `url`, `path_not_relative`, `risk_marker`, `no_paths`, `non_style_path`, `too_many_files`, `path_hidden`, `path_untracked`, `path_missing`, `path_not_file`, `file_too_large`.

Доказательство сверяется с планом. Если план пишет что-либо кроме названных файлов (включая glob), быстрый путь отзывается: бюджеты проекта восстанавливаются, выполняется обычная оценка и план строится заново. Цена отзыва — одна лишняя сессия планировщика. В `run.fastPath` остаются `files`, исходные `budgets` и `revoked: "plan_outside_proof"`.

Список слов-маркеров — страховка, а не доказательство безопасности. Он не распознаёт рискованную задачу, описанную без этих слов; от неё защищают область записи узла, проверки и ревью.

## Явные лимиты запуска

```json
{ "budgets": { "sessions": 12, "contextBytes": 65536 } }
```

Ключ `budgets` в `kodo.config.json` необязателен. Без него лимитов нет, и поведение прежнее.

| Ключ | Диапазон | Что ограничивает |
| --- | --- | --- |
| `sessions` | 1–1000 | Число начатых нативных сессий одного Run, включая неудачные |
| `contextBytes` | 4096–4194304 | Размер контекста одной сессии по манифесту |

Лимит сохраняется в Run при создании. `resume`, новый цикл `--retry-failed` и параллельные исполнители его не расширяют: счётчик — это `run.sessionAttempts`, проверка и запись сессии выполняются одним синхронным шагом. Project retry создаёт новый Run с лимитами не больше прежних. Чтобы поднять лимит, нужен новый запуск.

Исчерпанный лимит сессий останавливает Run со статусом `blocked` и кодом `budget`. Контекст больше `contextBytes` останавливает Run с кодом `context_budget` до отправки: обязательный контекст не сокращается, чтобы уложиться.

Существующие лимиты `researchBudget`, `repairRounds`, `maxTasks` и `concurrency` не изменились.

## Что не измеряется

Байты контекста — не токены. Usage берётся только из того, что отдал нативный клиент; отсутствующий usage остаётся `null`, а не нулём ([metrics](../runtime/metrics.mjs)). Экономия токенов, квоты, денег и времени этим этапом не измерялась и не заявляется.

## Проверка

```powershell
node scripts/run-tests.mjs tests/fast-path.test.mjs tests/context-manifest.test.mjs tests/fast-path-engine.test.mjs
```

Все проверки offline: fake providers, настоящие Git и SQLite. Модели и платные вызовы не используются.
