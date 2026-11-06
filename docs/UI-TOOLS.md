# Инструменты UI и локальной проверки

Kodo управляет шестнадцатью необязательными инструментами через `runtime/tools.mjs`. Каталог `runtime/tool-catalog.json` закрепляет версии, Git-ревизии, npm integrity и SHA-256 нативных архивов. Это отдельный механизм: в registry остаются 33 компонента, в политике — 13 стандартных навыков. Базовый CLI, чтение конфигурации и обычные тесты не устанавливают инструменты и не обращаются к моделям.

## Роли, версии и лицензии

| ID | Pin | Лицензия | Роль в Kodo |
| --- | --- | --- | --- |
| `agent-desktop` | npm `1.0.2`, `060c83af4be63096de33fc22d79fb9c4d02f528e` | Apache-2.0 | Accessibility выбранного приложения/окна, семантические действия и свежий readback |
| `browser-use` | Python `0.13.14`, `b49a68e4060acb226da8f784194fef301c53a6d7` | MIT | Браузерный агент с Google `gemini-4-argon` |
| `browser-harness` | Python `0.1.13`, `6e69c7fbe97edded9934e3fb305d9af3536f941f` | MIT | Управление собственным CDP-браузером, отдельный daemon на сценарий |
| `vibetest` | `0.1.0`, Git `fe0b90ac9d6a129ce06f5b53074241a9f205015b` | MIT, декларация upstream README | Настоящий upstream scout/QA pool из двух QA-агентов через Python bridge |
| `jev-ultrafast` | `0.1.0`, Git `8251e272398011cdef648965204d1c20cd838333` | MIT | Настоящий `Agent` с TypeSafe dynamic choose; текстовый helper заменён на Google |
| `chrome-devtools-mcp` | npm `1.12.0` | Apache-2.0 | Настоящий MCP stdio через официальный SDK `1.32.2`, собственный CDP endpoint |
| `semgrep` | Python `1.183.0` | LGPL-2.1-or-later | Локальные правила опасных exec/eval-паттернов JS/Python |
| `gitleaks` | native `8.30.1` | MIT | Поиск секретов в текущем tracked source; ограниченная история по явной настройке |
| `ripgrep` | native `15.2.0` | MIT OR Unlicense | Поиск кода по явным путям/glob с ограниченным выводом |
| `rtk` | OSS native `1.1.0`, `753a3b0e939f2e4490fc24e3a1984010f40a103c` | Apache-2.0 | Необязательная явная фильтрация поддерживаемого человекочитаемого shell-вывода |
| `oxlint` | npm `1.91.0` | MIT | Проверка JS/TS lint без исправления файлов |
| `oxfmt` | npm `0.76.0` | MIT | Проверка форматирования поддерживаемых исходников |
| `typescript` | npm `7.0.2`, `2bd066d87f5bafd315be9f40889d0a60b9e58e0b` | Apache-2.0 | `tsc` для проверки типов без emit |
| `stylelint` | npm `18.0.0`, `7c49e1828311b9d413826cb47703ef1c6ccae4ef` | MIT | CSS lint с конфигурацией проекта |
| `html-validate` | npm `11.18.0`, `eb0f0df1a6062e783bc5505d899cdaf5c2fdcac7` | MIT | HTML validation с конфигурацией проекта |
| `sqlfluff` | Python `4.5.0` | MIT | SQL lint с явно указанным dialect |

Исходники: [Agent Desktop](https://github.com/vercel-labs/agent-desktop), [Browser Use](https://github.com/browser-use/browser-use), [Browser Harness](https://github.com/browser-use/browser-harness), [Vibetest](https://github.com/browser-use/vibetest-use), [Jev Ultrafast](https://github.com/browser-use/jev-ultrafast), [Chrome DevTools MCP](https://github.com/ChromeDevTools/chrome-devtools-mcp), [Semgrep](https://github.com/semgrep/semgrep), [Gitleaks](https://github.com/gitleaks/gitleaks), [ripgrep](https://github.com/BurntSushi/ripgrep), [RTK pinned source](https://github.com/rtk-ai/rtk/tree/753a3b0e939f2e4490fc24e3a1984010f40a103c). [Oxlint/Oxfmt](https://github.com/oxc-project/oxc), [TypeScript](https://github.com/microsoft/TypeScript), [Stylelint](https://github.com/stylelint/stylelint), [HTML-Validate](https://gitlab.com/html-validate/html-validate), [SQLFluff](https://github.com/sqlfluff/sqlfluff). Pin и лицензия относятся к конкретному инструменту, а не ко всему Kodo. Полные digest и платформенные assets находятся в каталоге, а не подбираются по `latest` во время установки.

## Управляемая установка и doctor

Из checkout используй `node cli/index.mjs` вместо `kodo`. Поддержка команд в исходниках не означает их наличие в ранее выпущенном пакете.

```powershell
kodo tools list --json
kodo tools doctor --json
kodo tools doctor --live --json
kodo tools install browser-harness --json
kodo tools install typescript --json
kodo tools install sqlfluff --json
kodo tools install all --json
kodo ui verify --project "D:\Projects\my-app" --json
kodo security verify --project "D:\Projects\my-app" --json
```

`list` возвращает метаданные. `doctor`, включая `--live`, проверяет управляемые файлы и версии/import metadata; он не подключается к личному браузеру, не открывает UI и не вызывает модель. Это отличается от общего `kodo doctor --live`, проверяющего провайдеров. Отсутствующие, неподдерживаемые или повреждённые установки имеют явный статус и `ready: false`; doctor/install возвращают ненулевой код, если запрошенные инструменты не готовы. Неизвестные ID, лишние аргументы и неподходящие флаги отклоняются.

Нужны Node.js 24/npm; для всех новых npm pins подходит Node.js 24.15.0+ (точные engines сохранены в каталоге, установка проверяет их через `--engine-strict`); Python-инструментам также нужны уже доступные `uv`, Python 3.12 и Git для двух Git pins. Kodo не устанавливает uv и не обновляет системный Python. Четыре браузерных Python-пакета ставятся в общий закрытый venv, Semgrep и SQLFluff — в отдельные venv. SQLFluff получает requirements-файл с SHA-256 wheel/sdist из закреплённой PyPI metadata; uv проверяет эти hashes, затем inventory фиксирует все файлы зависимостей. Наличие hash у основного пакета не означает заранее закреплённые версии всех его transitive dependencies. Проверяются версии, Git pins и необходимые browser assets, включая Jev `snapshot.js`. Наличие зависимостей сторонних провайдеров в venv не разрешает API fallback.

Инструменты находятся вне Git: `KODO_TOOL_HOME` либо соседний с каталогом состояния `Kodo-Tools`. Принимается только отдельный безопасный каталог, без ссылок и пересечения с проектом. Установки сериализуются, повторно используются только точные pins с проверенной квитанцией и хешами файлов. npm lifecycle scripts отключены; общие npm entrypoints запускаются через текущий Node только после совпадения pinned `binName`/`entry` с package metadata, проверки безопасного относительного пути, отсутствия symlinks и полного inventory. Python `entryModule` — проверенное имя модуля, запускаемое через `-I -B -m`, с проверкой наличия entrypoint и точной CLI-версии; Agent Desktop использует комплектный бинарник с соседним `.sha256`. Нативные архивы проверяются до безопасной распаковки. Глобальные инструменты и исследовательские окружения не изменяются. Установка происходит по явной `tools install` либо по `autoInstall: true` у включённого gate; doctor никогда не устанавливает.

Для UI нужен установленный Chrome/Chromium, при необходимости абсолютный `uiVerification.executablePath`, либо доступное собственное desktop-приложение. Матрица пакетов охватывает Windows/Linux/macOS x64/arm64, но зависит от инструмента: Semgrep pin объявлен для Windows x64, Linux x64/arm64 и macOS arm64; RTK — только Windows x64/Linux x64. Доступность пакета на платформе не доказывает работу её accessibility API или UI-сценария.

## RTK и вывод shell

Координатор устанавливает `rtk` тем же managed installer, с проверкой SHA-256 до распаковки, лицензии, версии и полного inventory. Pin OSS 1.1.0 использует `rtk-oss-x86_64-pc-windows-msvc.zip` и `rtk-oss-x86_64-unknown-linux-musl.tar.gz`; checksum и executable path заданы в `runtime/tool-catalog.json`. Это локальный output-фильтр, без model API routing/`rtk-proxy`. Пользовательский global RTK 0.50.0 не заменяется.

После lease Engine проверяет ready tool один раз для сессии и использует результат в guidance/env; новая сессия перепроверяет файлы. Managed binary находится перед inherited PATH только native worker, с private `RTK_DB_PATH`, `RTK_RECALL=0`, `RTK_TEE=0`, `RTK_TELEMETRY_DISABLED=1`. Native HOME/auth остаются прежними. App-host/видимый чат не наследует native env автоматически: shell-вызову нужны точный managed binary и приватные overrides координатора. Не следует проверять это через произвольный global `rtk`.

Применять явно к проверенным человекочитаемым командам, например `rtk git status` и `rtk git diff --stat`; неизвестная поддержка, missing/unsupported — исходная команда без фильтра и per-session install. JSON, porcelain, `-z`/NUL, протоколы и любой parsed output остаются сырыми. Node `node:test`/TAP и generic `rtk test` не совмещаются: реальная fixture сохранила exit 1, но потеряла полезную причину неуспеха. Checks координатора, CI, UI/security и delivery также выполняются сырыми.

Сохраняй исходный exit code и полную диагностику. При потерях повтори raw command и сохрани полный redacted evidence вне Git; потеря ошибок не считается экономией. Не запускать `init`/config-save, не добавлять global hooks и не обходить trust. RTK может читать существующий global config; Kodo не сохраняет его изменения и отдельно задаёт private tracking/recall/tee/telemetry. [Измерения и ограничения](EFFICIENCY.md), [приватность](SECURITY.md#приватные-evidence-и-rtk).

## Конфигурация UI

Пример для собственного приложения с HTTP-сервером. Команда и селекторы должны соответствовать этому проекту; пример сам по себе ничего не запускает:

```json
{
  "uiVerification": {
    "enabled": true,
    "autoInstall": true,
    "maxSteps": 12,
    "timeoutMs": 180000,
    "start": {"command": "node", "args": ["server.mjs"]},
    "cases": [{
      "id": "save-name",
      "tool": "browser-harness",
      "url": "http://127.0.0.1:4173/",
      "steps": [
        {"action": "fill", "selector": "#name", "value": "Kodo"},
        {"action": "click", "selector": "button[type=submit]"}
      ],
      "assertions": [{"selector": "#result", "text": "Saved: Kodo"}]
    }]
  }
}
```

Без настройки нормализация даёт `{enabled:false,cases:[],autoInstall:true,maxSteps:12,timeoutMs:180000}`. Включённый gate требует 1–20 сценариев с уникальными безопасными ID и непустыми assertions. `maxSteps` принимает 1–30, `timeoutMs` — 1000–600000 мс. `start` необязателен: это executable + массив аргументов, без shell; занятый endpoint не присваивается себе. Запущенный Kodo сервер останавливается после проверки, в том числе при ошибке.

Браузер принимает только HTTP(S) URL без userinfo, действия `fill`/`click` с CSS selector и assertions `{selector,text?,value?,exists?}`. `text` сравнивается с trim текста DOM, `value` — со значением поля, по умолчанию `exists:true`. Положительный selector должен находить ровно один элемент; отсутствие проверяется через `exists:false` на загруженной странице нужного origin. Для `browser-use`, `vibetest`, `jev-ultrafast` дополнительно обязателен `goal`. Это недоверенные данные сценария, не команды для координатора.

Desktop-сценарий вместо URL задаёт приложение и при необходимости ID окна из Agent Desktop `list-windows`:

```json
{
  "id": "desktop-save",
  "tool": "agent-desktop",
  "app": "Kodo Test Form",
  "windowId": "w-example",
  "steps": [
    {"action": "set-value", "name": "Name", "role": "textbox", "value": "Kodo"},
    {"action": "click", "name": "Save", "role": "button"}
  ],
  "assertions": [{"text": "Saved: Kodo"}]
}
```

`w-example` — заменяемый пример, не HWND. Неоднозначное приложение, окно или элемент блокирует действие. Используется `ref_id` из свежего accessibility snapshot. Если финальный click вернул uncertain/delivered_unverified, успех допустим только после свежих независимых assertions; повторять click нельзя. Неопределённая доставка промежуточного действия блокирует дальнейшие изменения. Автоматического перехода к физическому вводу нет.

Независимый QA выявил и documenter воспроизвёл на старом срезе два дефекта: принятие результата bridge выше `maxSteps` и преждевременный `no_progress` при новых байтах одного незакоммиченного файла. Актуальный контракт координатора подтверждает исправления в integration: нормализованный config участвует в live/persisted UI validation, fingerprint учитывает tracked и ограниченное untracked-содержимое; 25 целевых проверок и отдельная untracked-регрессия прошли. Это отдельное свидетельство координатора, не зелёный повтор на старом worktree documenter и не общий check/CI. [Точные проверки](archive/VALIDATION.md#интеграция-ui-security-и-контекста).

## Шесть исполняемых адаптеров

| Адаптер | Реальный путь и ограничения |
| --- | --- |
| Agent Desktop | Нативный JSON envelope 2.5 пакета 1.0.2; семантические find/set-value/click/get, scope приложения/окна; bundled help/skills соответствующей версии |
| Browser Harness | Публичные upstream helpers и собственный CDP endpoint; уникальные `BU_NAME`, `BH_HOME`, `BH_RUNTIME_DIR`, `BH_AGENT_WORKSPACE`, `BH_TMP_DIR`; `BH_RECORD=0`, `BH_TAB_MARKER=0`, `BH_OPEN_LIVE_URL=0`; shutdown только своего daemon с проверкой состояния |
| Browser Use | Настоящий `Agent.run(max_steps=...)` + `ChatGoogle(gemini-4-argon)`; успешная history и независимый DOM readback из той же финальной сессии; cleanup через актуальные stop/kill/close |
| Vibetest | `vibetest.agents.run_pool`, scout и два QA-агента; Google factory адаптирована к настроенному Gemini, сессии изолированы, aclose-wrapper использует текущий BrowserSession API; оба наблюдаемых состояния и QA-результат проверяются. Старый MCP entry несовместим с mcp2 и не используется |
| Jev Ultrafast | Upstream `Agent` и TypeSafe dynamic choose, конечный бюджет; только текстовый helper заменён на Google JSON; `screenshots=False`, `record_dir=None`; DONE без независимых DOM assertions не проходит |
| Chrome DevTools MCP | Официальный SDK `@modelcontextprotocol/sdk@1.32.2`, stdio, собственный Chrome/CDP; navigate/snapshot/fill/click и фиксированная функция DOM assertions, затем закрытие transport; `--no-usage-statistics`, `--no-performance-crux`, `NO_UPDATE_CHECKS=1`, `CHROME_DEVTOOLS_MCP_NO_UPDATE_CHECKS=1` |

Координатор владеет процессами, временными профилями, endpoint и временем проверки. Python bridge получает JSON в stdin и возвращает один валидируемый JSON в stdout. Он не ищет личный Chrome при сбое. Google-ключ получают только три модельных bridge; TypeSafe — только Jev. Workers, запускаемое приложение и браузерные процессы ключей не получают. GPT/Claude продолжают работать исключительно через подписочные клиенты; OpenAI/Anthropic/DeepSeek/Browser Use Cloud API fallback отсутствует.

## Квитанции и границы доказательств

`kodo ui verify` и `kodo security verify` используют локальный config и чистый неизменный Git HEAD, сохраняют квитанции вне Git и возвращают ненулевой код при включённом неуспешном gate. В движке gates идут после build/test, до независимого review и доставки. Квитанции находятся в `run.uiVerification` и `run.securityChecks`; аудит схемы 1 от этого не расширяется.

UI receipt схемы 1 содержит `headSha`, `configHash`, `pinsHash`, `status`, `passed`, сценарии, assertions и evidence `{path,sha256,bytes}`. `disabled` означает `passed:null`; это нейтральная запись. Включённая проверка проходит только после всех сценариев и независимых наблюдений. Отсутствующий инструмент/ключ, неподдерживаемая платформа, timeout, неоднозначность, ошибки провайдера, неверный JSON или провал assertions не означают успех. Сохранённое `passed:true` не заменяет повторную проверку head/config/pins и байтов evidence; gate нельзя обойти прямым вызовом delivery.

Запись экрана по умолчанию выключена. Профили, snapshots, история и сырые traces остаются приватно вне Git; журналы и квитанции ограничены и редактируются. Cleanup затрагивает только принадлежащие проверке ресурсы. Если штатное удаление собственного профиля заблокировано, сохраняй его как приватный артефакт и сообщай фактический результат; нельзя удалять чужие профили или подменять подтверждение cleanup. Настройка MCP-клиента отдельно описана в [mcp/browser](../mcp/browser/README.md); наличие шаблона не доказывает установку или подключение.

На 3 ноября 2026 года контракт run9fc фиксирует отдельные успешные реальные проверки всех шести драйверов. Первый общий запуск выявил реальный дефект пустого имени в fixture через Vibetest; общий PASS того запуска отсутствует. Точные квитанции, HEAD и ограничения приведены в [VALIDATION.md](archive/VALIDATION.md#реальные-квитанции-run9fc). Эти результаты не удостоверяют текущий объединённый HEAD, опубликованный пакет или deployment.
