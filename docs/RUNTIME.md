# Исполнение задач Kodo

## Подготовка проекта

Нужны Node.js 24, Git и хотя бы один авторизованный клиент: Codex с ChatGPT login или Claude Code с активной подпиской. Для доставки нужен GitHub-доступ. `kodo init` создаёт `kodo.config.json` без секретов. `kodo doctor` проверяет локальные предпосылки; `kodo doctor --live` отдельно проверяет подключения.

Сначала должен существовать исходный Git commit. Kodo сохраняет его SHA и состояние рабочего каталога, после чего работает в собственных worktree. Незакоммиченные изменения пользователя не становятся частью задачи автоматически и не должны включаться в commit исполнителя.

Конфигурация проекта:

```json
{
  "schemaVersion": 1,
  "repository": "Zulut30/Kodo",
  "baseBranch": "main",
  "client": "codex",
  "primaryModel": null,
  "models": {
    "codex": ["gpt-6.1-sol", "gpt-6-astra", "gpt-6.1-terra"],
    "claude-code": ["opus", "sonnet"]
  },
  "concurrency": 2,
  "repairRounds": 5,
  "uiVerification": {"enabled": false},
  "security": {"enabled": true, "autoInstall": true, "tools": ["semgrep", "gitleaks"]},
  "researchBudget": 40,
  "commands": {
    "test": [{"command": "npm", "args": ["test"]}],
    "build": [],
    "deploy": [],
    "smoke": []
  },
  "checks": ["check (ubuntu-latest, 24)", "check (windows-latest, 24)"],
  "delivery": {"enabled": true, "release": true, "firstVersion": "0.2.0"}
}
```

Для другого проекта укажи его репозиторий, обязательные CI-checks и штатные команды. Пустой список deploy/smoke не доказывает успешное развёртывание. Имена требуемых checks должны совпадать с фактически настроенными проверками GitHub.

В примере показана настройка репозитория Kodo с доставкой и локальными security gates. Общие значения `init` оставляют `repository: null`, выключенную доставку и оба gate выключенными; настрой их для целевого проекта. UI самого Kodo выключен, поскольку продукт — CLI. `--delivery` переопределяет настройку доставки только текущей задачи. `repairRounds` принимает 1–5, исходная настройка `init` — 5; выбранный профиль ограничивает её до 1/3/5, явное меньшее значение сохраняется.

Секреты загружаются из пользовательского хранилища Kodo или окружения координатора. Нужны ключи Gemini, TypeSafe, Scrape.do, Reddit API и GetXAPI для соответствующих интеграций. Они не входят в проектный JSON, аргументы рабочих сессий, планы и отчёты.

Переменные окружения: `KODO_GEMINI_API_KEY`, `KODO_TYPESAFE_API_KEY`, `KODO_SCRAPEDO_TOKEN`, `KODO_REDDIT_API_KEY`, `KODO_GETX_API_KEY`. Состояние находится в `%LOCALAPPDATA%\Kodo` в Windows и `~/.local/state/Kodo` в Linux; `KODO_HOME` переопределяет этот каталог. Ключи хранятся отдельно в `%LOCALAPPDATA%\Kodo-Credentials` с шифрованием DPAPI или `$XDG_CONFIG_HOME/kodo/credentials` (`~/.config/kodo/credentials`) с правами `0600`; путь задаётся через `KODO_CREDENTIAL_HOME`. Старый `secrets.json` переносится после проверки защищённой копии. Каталоги ключей и состояния не помещают внутрь Git-проекта. [Хранение и границы доверия](SECURITY.md).

## Project Director: MVP06

Для backlog из нескольких Run существует отдельный `kodo project`: durable Project/Milestone/Epic/Task/Attempt поверх прежнего Store/Engine. [PROJECTS](PROJECTS.md) содержит strict ProjectSpec v1, CLI/API, config, собственные offline примеры и evidence limits; [ADR-0008](decisions/0008-project-director.md) — решения и альтернативы. Реализация интегрирована локально, общая приёмка06 ещё pending.

`project create --file SPEC` импортирует явную спецификацию с существующим абсолютным root. `status PROJECT_ID` возвращает bounded counts/completeness; `plan PROJECT_ID [--limit 1..24] [--dry-run]` всегда dry-run, не создаёт Attempt и не запускает provider. Lazy Project composition может открыть Store/выполнить additive migration с consistent SQLite backup; offline не означает отсутствие state I/O. До hash/write/output координатор загружает known values и проверяет raw decoded keys/values. Для экспериментов обязательны отдельные empty/fake `KODO_HOME`/`KODO_CREDENTIAL_HOME`; ключи не входят в спецификации.

`project resume PROJECT_ID` выполняется foreground, обрабатывает одну Task/Attempt через существующий Engine и возвращается. Нет daemon/drain всего backlog. Project CLI не принимает `--mode`, `--model`, `--concurrency` или `--project`: root сохранён в Project, `executionMode`/`primaryModel`/доступные models/gates/commands/delivery задаются в root `kodo.config.json`. Уже созданный Run сохраняет mode/model/sessions/budgets/quota; explicit Project `--retry-failed` создаёт следующую Attempt, сохраняя прежний режим/модель и меньшие research/repair/concurrency/maxTasks. Это не новый цикл legacy Run. GPT/Claude — только подписочные клиенты, без API fallback.

`project pause` блокирует следующие admission/advancement, сохраняя active Run/session; `resume` снимает pause. `cancel` сохраняет отмену до forwarding unfinished Runs; отменённый Project не возобновляется. Admission повторно проверяет актуальные dependencies/risk/interfaces до reserve/install/dispatch. `reprioritize` изменяет Task revision, поэтому старое risk approval не действует; `approve-risk ... --reason TEXT` относится к текущей revision. CAS/idempotency и atomic reservation→Run binding не допускают повторного создания Run при restart.

Accepted требует actual current-head checks/review и fresh enabled gates, verified criterion mappings и frozen task. Accepted children не заменяют собственное proof Epic/Milestone/Project; CLI пока не предоставляет container evidence/mapping importer, и Project может остаться blocked после всех Task. Released дополнительно требует проверенную publication chain. Disabled нейтрален. Offline template smoke не доказывает native продукт, реального провайдера, опубликованный пакет или deployment. [Текущая граница06](kodo-roadmap/phase-06.md).

## Два способа планирования

В CLI команда `kodo run "<задача>" --client codex` выбирает режим, выполняет соответствующий анализ и вызывает планировщик через указанный клиент. `--mode quick|standard|deep` задаёт режим явно. `--model` имеет приоритет над настроенной основной моделью и фиксирует модель для всех native-этапов, включая ревью и повторы. `--providers both` разрешает обе подписки, но не снимает явную фиксацию модели.

В чате навык `kodo-build-feature` вызывает подготовительный запуск с `--prepare`. После анализа Kodo возвращает объект запуска: `id`, `project`, `artifacts`, `state`, `analysis`, `research`. В состоянии `awaiting_plan` каталог `artifacts` содержит `analysis.json`, `plan.schema.json` и `plan-context.md`. Последний файл, также доступный как `planningContext` в состоянии запуска, содержит выбранные по умолчанию инженерные навыки для планирования. Текущая основная модель читает эти материалы и записывает `plan.json` в тот же каталог вне репозитория, затем передаёт его:

```text
kodo resume <runId> --plan <абсолютный-путь-к-plan.json>
```

Так план составляет текущая модель чата. Если чат прервался до передачи плана, подготовленный запуск остаётся доступен через `status` и `resume`.

## Режимы исполнения

```powershell
# Автоматический выбор, если executionMode также отсутствует в проекте
kodo run "<задача>" --client codex --prepare --json
# Явный выбор текущего запуска и фиксированной модели
kodo run "<локальная задача>" --client codex --mode quick --model gpt-6.1-sol --prepare --json
```

В `kodo.config.json` необязательное `"executionMode":"standard"` задаёт явный проектный режим. Приоритет: `run --mode` → проектный `executionMode` → автоматический выбор. Строка `auto` не является допустимым значением; для автоматики свойство и флаг нужно опустить. Оценка Jev сохраняется и при явном выборе, но не может его переопределить.

До Gemini и исследования координатор передаёт ограниченную карту проекта и относящиеся к задаче файлы в один логический batch TypeSafe Jev `/v1/systemone`. Три независимых typed choice-вопроса оценивают `complexity` и `risk` (`low/medium/high`), `scope` (`local/module/cross-cutting`). Ответ содержит выбор, числовую `confidence` и вероятности всех вариантов; суммы, диапазоны и соответствие выбранного варианта проверяются. Jev не пишет анализ или план. Один batch не означает ровно один HTTP-запрос: общий клиент допускает до двух повторов временного сбоя. Отмена распространяется дальше, а не превращается в fallback.

- Автоматический `quick`: `low` complexity, `low` risk и `local` scope, у каждого выбора одновременно `confidence >= 0.75` и вероятность выбранного ответа `>= 0.75`, без усечения относящегося к задаче контекста.
- Автоматический `deep`: хотя бы один выбор high complexity, high risk или cross-cutting scope. Для этого условия отдельный порог 0.75 не применяется.
- Остальные валидные оценки дают `standard`. При отсутствии ключа, недоступном Jev или некорректном ответе сохраняется явный fallback `standard` с причиной и неизвестными измерениями оценки; явный режим всё равно побеждает. Другой модельный API для классификации не подключается.

`run.executionMode` содержит `requested`, `selected`, `source`, `reason`, эффективный `profile` и квитанцию оценки. `source` различает `explicit`, `jev`, `fallback`, `fast-path`; старые запуски могут иметь `compatibility`. Выбор записывается событием `mode_selected`.

| Профиль | `gemini` | `researchBudget` | `maxTasks` | `repairRounds` | `concurrency` |
| --- | --- | --- | --- | --- | --- |
| `quick` | false | 0 | 2 | 1 | 1 |
| `standard` | true | 10 | 12 | 3 | 2 |
| `deep` | true | 40 | 24 | 5 | 2 |

Для research, repair и maxTasks применяется минимум профиля и явно заданного проектного значения. Проект принимает `researchBudget` 0–40, `repairRounds` 1–5, `concurrency` 1–5 и необязательный `maxTasks` 1–24. Предел не является требуемым объёмом работы. `repairRounds` ограничивает попытки узла и раунды проверки/ревью; значение 1 в `quick` не обещает дополнительный ремонт после первого провала.

У нового запуска `--concurrency 1|2|3|4|5` имеет приоритет над проектным `concurrency`, затем используется значение профиля: 2 для standard/deep, 1 для quick. Явный CLI или проектный выбор сохраняется и при `--mode quick`; режим не уменьшает выбранные 5. Остальные бюджеты и лимит задач quick остаются прежними: пять слотов не создают пять задач автоматически. `requestedConcurrency` хранит явный выбор либо `null` для значения профиля; эффективный предел сохраняется в `config.concurrency` и `executionMode.profile.concurrency`. `resume` не принимает `--concurrency`, не перечитывает изменённый проектный предел и не расширяет сохранённый пул, включая новый цикл `--retry-failed`. Для изменения нужен новый `run`.

```powershell
kodo run "<пять независимых задач с отдельными scopes>" --concurrency 5 --mode standard --prepare --json
```

Эти бюджеты ограничивают логическую работу координатора, а не точное число HTTP-вызовов провайдера: транспортные retries учитываются отдельно от выбора профиля.

В `quick` `analysis.kind` равен `local`, Gemini и researcher не вызываются ни перед планом, ни при блокере. `--prepare` всё равно сохраняет структурированные материалы и возвращает `awaiting_plan`. Планировщик получает инструкцию сделать одно developer-задание с нужными тестами и документацией в его scope; ограничение валидатора — не более двух задач. Отдельные tester/documenter не назначаются безусловно. В standard/deep такие роли выделяют только при необходимости по требованиям. Каждый узел сохраняет зависимости, write scope и acceptance.

В quick используется выбранная основная модель без отдельных Jev-вызовов маршрутизации узлов и автоматического выбора самой сильной модели. `primaryModel` задаёт основную модель; `--model` дополнительно фиксирует её для всех native-этапов при любом режиме. В standard/deep без `--model` остаётся маршрутизация по разрешённому доступному пулу, и ревью может использовать другую модель. Недоступная явно фиксированная модель не подменяется другой.

После реализации обязательны настроенные test/build, включённые UI/security gates и свежее независимое read-only review в отдельной сессии. В quick ревью может выполняться той же моделью, но не сессией реализации. Модельное `complete:true` не заменяет эти проверки. Противоречивое `passed:true` с blocker/major findings не принимается. Изоляция, все 13 default skills, десять optional tools, head-bound receipts и ограничения доставки сохраняются.

Выбранный режим и эффективные бюджеты фиксируются в состоянии запуска. `resume` не принимает `--mode`/`--model` и не перечитывает их из изменённого проектного config. Автоматического повышения режима или расширения budget нет. Для более широкого профиля нужен новый `run`; `resume --retry-failed` открывает только новый явный цикл в прежних пределах. Уже завершённые стадии того же запуска не повторяются. Старый сохранённый анализ получает `standard` с `source:compatibility`, прежними бюджетами и `historyComplete:false`, без повторного анализа и ретроактивного ограничения уже начатого плана стандартными 12 задачами.

## Контракт плана

Пример ниже содержит три самостоятельных результата для standard/deep. В quick включи необходимую проверку и документацию в одно developer-задание с явными путями; такой трёхузловой план превысит его предел.

```json
{
  "summary": "Добавить экспорт выбранных строк без изменения фильтров.",
  "tasks": [
    {
      "id": "export",
      "role": "developer",
      "description": "Реализовать экспорт по существующему контракту списка.",
      "dependsOn": [],
      "writePaths": ["src/export/**"],
      "acceptance": ["Экспорт содержит выбранные строки и корректно экранирует CSV."],
      "parallel": false
    },
    {
      "id": "export-tests",
      "role": "tester",
      "description": "Добавить и выполнить проверки экспорта по требованиям.",
      "dependsOn": ["export"],
      "writePaths": ["tests/export/**"],
      "acceptance": ["Проверены пустой выбор, специальные символы и сохранение фильтров."],
      "parallel": false
    },
    {
      "id": "export-docs",
      "role": "documenter",
      "description": "Обновить инструкцию экспорта и ограничения формата.",
      "dependsOn": ["export"],
      "writePaths": ["docs/export.md"],
      "acceptance": ["Пример соответствует реализации и существующим командам."],
      "parallel": true
    }
  ]
}
```

Идентификаторы уникальны, зависимости существуют, циклов нет. `writePaths` определяет область записи относительно корня проекта; внешние и обходящие корень пути недопустимы. План ограничивается поручением пользователя. Роли: `developer`, `tester`, `documenter`. Финальное независимое ревью организует координатор.

Для объёмной работы в standard/deep выделяются небольшие связные результаты по модулям с явными интерфейсами и узкими областями записи. Тесты и документация могут начинаться после своих непосредственных предпосылок; общей зависимости от всей реализации без необходимости нет. Небольшая правка не требует искусственного дробления. Новое обязательное ядро узла ограничено 12000 UTF-8 байт сериализованного `taskContract`; превышение даёт `task_contract_too_large` с требованием разбиения без потери критериев.

## Маршрутизация и работа

Jev выбирает из допустимых моделей и вариантов исполнения, подготовленных планировщиком. Ограничения применяются кодом: зависимости должны быть готовы, а пересекающиеся области записи выполняются последовательно.

По умолчанию Codex использует свой доступный пул Sol/Astra/Terra, Claude Code — Opus/Sonnet. С `both` пул расширяется до обеих подписок. Модель, которой аккаунт не может пользоваться, не должна попадать в исполняемый выбор.

При ненулевом эффективном `researchBudget` исследование проходит до плана и может повторяться при выборе зависимости или подтверждённом блокере. Общий предел задаётся режимом и меньшей настройкой проекта: 0/10/40 для quick/standard/deep. Кэшированные результаты не считаются новыми внешними research-запросами. Исчерпание использует уже собранные материалы; отказ источника фиксируется отдельно от отсутствия подходящего решения и не повышает режим.

### Структурированное knowledge: offline MVP05

Отдельные `research status`, `research refresh --input REL_JSON` и `knowledge inspect` работают с claims и возвращают requests0. Фиксированные `research.policy.json`/`research.context.json` читаются из исходного project root; HEAD/source — из фактического owned worktree. Defaults off; отсутствие policy сохраняет prompt bytes/metrics и не открывает knowledge Store. Это не глобальный выключатель legacy discovery research выше. [Полные форматы, prerequisites и реальные offline-примеры](KNOWLEDGE.md).

Current versions не выводятся из старого capture. Unknown/mismatched/expired/conflicted/untrusted claims не становятся authoritative; одинаковый replay сохраняет прежнее время наблюдения. Только механически проверенный local codebase или явно matching synthetic fixture допускается как typed UNTRUSTED reference. Snapshot/evidence проверяются перед prompt; immutable evidence — также после сессии. Source edits после старта могут быть законной работой агента.

Engine добавляет отдельный bounded JSON после renderSessionPrompt и до итогового byte accounting, не изменяя caller envelope/reference array. Меньшие byte limits сохраняются; dirty repair или непоместившаяся optional knowledge исключается с явным unavailable, обязательные task/skills/gates остаются. Native всегда перечитывает fixed files; CLI --context не сохраняется. Mode/model, quick research0 и меньшие сохранённые budgets не повышаются. Scoped provider fixtures не являются real native-client acceptance; [pending gates05](kodo-roadmap/phase-05.md).

Текущий checkpoint05 не является security acceptance: fake-only probe координатора выявил known-credential gap в default CLI refresh/inspect. Bounded repair остаётся pending; raw диагностика приватная, реальные ключи/API не использовались.

Задачи получают отдельные worktree и сессии. Начальный общий пул — две одновременные native-сессии на подписку; запуск с явно сохранённым `concurrency` 3–5 может получить соответственно до 3–5 общих слотов. Счётчик SQLite общий для запусков и соединений, а не отдельный пул каждого worker. Сохранённый меньший запуск не расширяет собственный планировщик; quick по умолчанию исполняет один узел, но сохраняет совместимость с общим двухслотовым пулом подписки для независимых запусков. Продолжение использует сохранённый session ID. Фактический diff сверяется с областью записи; после объединения изменений проверки повторяются на общем результате. Уже назначенное изолированное дерево не требует вложенного worktree.

`runReadyQueue` допускает узлы непрерывно: после интеграции A готовый C стартует, даже если независимый B ещё выполняется. Лимит запуска и глобальные subscription leases сохраняются. Совместная работа требует parallel в плане и routing и непересекающихся scopes; scope удерживается до конца последовательной интеграции. Jev получает bounded snapshot готовых/активных peers, без завершённых предков и заблокированных потомков. Подготовленный routing переиспользуется, сохранённый serial-выбор не переигрывается ради скорости.

Необязательный ключ `"scheduler": "durable"` в `kodo.config.json` исполняет узлы плана через [durable jobs](JOBS.md): те же лимиты и запреты параллельности, плюс очередь в SQLite, видимая через `kodo jobs`, и сверка merge после сбоя. Без ключа или с `"legacy"` работает прежний диспетчер.

Перед ревью координатор выполняет детерминированный behaviour gate: существующие тест-кейсы нельзя удалить или выключить (кейсы сверяются по именам; семантическое ослабление этот шаг не распознаёт), а оракулы проекта (блок `verification`) имеют приоритет над отчётом ревью. Подробности — [VERIFICATION](VERIFICATION.md).

Задача, которая называет только существующие файлы стилей, выбирает `quick` без обращения к Jev (`executionMode.source: "fast-path"`); необязательный ключ `budgets` задаёт сохраняемые лимиты сессий и размера контекста. Подробности — [CONTEXT](CONTEXT.md).

`concurrency:5` — ёмкость, а не обещание пяти одновременно активных workers. Реальный допуск сохраняет `task.parallel` и решение Jev: `parallelConfidence` ниже 0.75 (например 0.72) оставляет узлы последовательными даже при пяти слотах. При отсутствии отдельного поля проверяется общая `confidence`. Quick сохраняет serial routing policy. В standard/deep `--model` фиксирует точные provider/model, а существующий Jev оценивает scheduling/session с единственной разрешённой моделью; model-вопрос для неё не отправляется. Смена модели и model escalation запрещены, включая повторы и fallback при недоступном Jev. Низкая уверенность, `parallel:false`, пересечение scopes и незавершённые зависимости не обходятся флагом concurrency.

Локальные проверки `tests/concurrency-five.test.mjs` доказывают пик 5 на fake native-provider barrier и на настоящем `Engine.route` с подменённым ответом Jev 0.75, включая fixed-model standard/deep; для 0.72 пик равен 1. Это проверка локального admission-контракта; реальные подписки и текущий опубликованный пакет этим не проверены. Урок изменения: merged default `concurrency:2` нельзя считать явным запросом пользователя, иначе quick теряет default 1; происхождение выбора нужно сохранить при создании run, а старые запуски без него продолжают прежний clamp. Фиксация модели ограничивает модельный пул и не подменяет решение о безопасной параллельности.

При сбое новый допуск прекращается, начатые prepare/execute/integrate дожидаются завершения; успешные результаты сохраняются. Failed pending merge восстанавливается прежде других интеграций. При отмене следующая интеграция не начинается. Completed nodes интегрируются без повторной сессии, исходные typed errors сохраняются; конечный тупик даёт `scheduler_deadlock`. [Сценарии очереди и evidence](EFFICIENCY.md).

### Контекст и восстановление

`runtime/task-context.mjs` строит контекст конкретного узла через `buildTaskContext(run, task, {contractPath})`. Обязательные description, write scope, acceptance, interfaces, constraints и dependency IDs передаются полностью. Для старого saved oversized-контракта используется явная обязательная ссылка на полный приватный файл, который worker должен прочитать до работы. Необязательные краткие результаты прямых зависимостей, цель/анализ и релевантные ссылки имеют отдельный предел 3000 UTF-8 байт. Skill policy и tool guidance передаются отдельно. `analysis.standards`, полная история, прежние промпты, сырые research bodies и ключи туда не копируются.

`compactPlanEvidence` по умолчанию ограничен 12000 байт (worker planning evidence — 4000), `compactReviewEvidence` — 16000. Сводки сохраняют корректный Unicode/JSON, head/base, commands/exits, failed/skipped/unknown и явные omissions, а не создают PASS из отсутствующих данных. До трёх кратких verified lessons допускаются при успешных checks/review того же head. Полные REDACTED snapshots, contracts, diff и command logs сохраняются до compaction в приватном content-addressed `runs/<runId>/evidence/` вне Git; ссылки и hash/head проверяются до/после native-сессии и перед reuse check logs. Повреждение даёт `evidence_integrity`, не расходуя repair/research на код. Старая строка check без `outputPath` не имеет восстановленного полного вывода. [Контракты compaction и RTK](EFFICIENCY.md).

После получения subscription lease ready managed RTK разрешается вместе с ripgrep один раз для session guidance/environment; новая сессия проверяет integrity снова. RTK идёт перед inherited PATH только worker-сессии, с приватным tracking DB и recall/tee/telemetry overrides. Установка не выполняется на каждую сессию; missing/unsupported использует raw commands. Machine-readable данные, Node/TAP и координаторские checks/CI/gates/delivery остаются сырыми. App-host не наследует этот env автоматически. [Подробности](UI-TOOLS.md#rtk-и-вывод-shell).

`runtime/progress.mjs` строит `progress.md` в `<KODO_HOME>/runs/<runId>/` — фактическом каталоге артефактов запуска вне Git. Файл атомарно заменяется при сохранении переходов, ограничен 64 KiB и редактируется по известным секретам. Он показывает stage/node statuses, commits, checks, review, delivery и blockers. SQLite остаётся источником состояния: resume восстанавливает сводку, а завершённые/интегрированные узлы не повторяет. Сводка не является журналом сырых промптов или заменой квитанций.

### UI/security gates

После команд build/test координатор выполняет нормализованные `uiVerification` и `security`, затем независимое review. Квитанции сохраняются в `run.uiVerification` и `run.securityChecks`. Перед review/delivery нужны неизменный чистый head, актуальные config/pins и проверенные байты evidence. Отсутствующий, ошибочный или неполный включённый gate блокирует доставку, включая прямой вызов delivery. `disabled` — явный нейтральный статус с `passed:null`.

Standalone-команды `kodo ui verify [--project PATH] [--json]` и `kodo security verify [--project PATH] [--json]` читают локальную конфигурацию, проверяют Git HEAD до/после и записывают приватные receipts вне Git. Включённая неуспешная проверка возвращает ненулевой код. Установка инструментов допускается по явной `tools install` или `autoInstall:true` включённого gate; model credentials остаются у координатора. [Точный JSON, pins, adapters и prerequisites](UI-TOOLS.md), [локальные scanners](SECURITY.md#локальные-security-gates).

### Architecture Guardian

Offline-команды не запускают Engine или подписочных провайдеров:

```powershell
kodo architecture plan --project D:\Projects\example --base FULL_COMMIT_SHA --json
kodo architecture check --project D:\Projects\example --base FULL_COMMIT_SHA --evidence-dir C:\PrivateEvidence\architecture --json
```

Подставь полный SHA base commit; head берётся из текущего чистого Git-дерева. Plan read-only, без тестов/evidence; check запускает только выбранные registry contract tests реальным Node TAP с общим deadline 120000ms. Fixed policy — architecture.policy.json; --head/--preset отсутствуют. Успех требует актуальных actual bytes, полного TAP без fail/cancel/skip/todo и intact private captures; exit0 без тестов не заменяет test receipt. При поддержанной policy CSS-only static check может пройти без unrelated tests.

[Policy/registry schema, ручные presets, migration/debt и примеры](ARCHITECTURE.md), [ADR-0007](decisions/0007-architecture-guardian.md). MVP анализирует только product ESM .mjs/.js type=module; Rust/C#/Go/PHP/TSX/JSX/CJS не получают native architecture PASS. Language quality и SDK/platform checks остаются отдельными. Отсутствие policy в base/head даёт not_applicable/passed:null; malformed base или удаление enrolled policy блокирует. Первое enrollment может локально пройти producer tests при baseRulesEvaluated:false, но всегда требует full verification и независимого review.

Замороженный config-контракт интеграции G — только `{"architecture":{"enabled":false}}`, default false, без настраиваемого policy path. На docs-checkpoint этапа 04 интеграция G и её окончательные проверки ещё pending; этот JSON описывает целевой контракт, а не завершённое подключение gate к Engine. Disabled нейтрален, не PASS; старые saved runs не включаются задним числом. Enabled gate должен привязывать receipt к source/base/head, normalized policy/registry/config, Node/runtime, checker/parser pins и байтам private evidence, await-ить freshness/expiry перед review/delivery и сбрасывать receipt при source/repair/integration changes. Full checks, свежие security и независимое review сохраняются.

### Повторное использование локальных checks

При продолжении координатор может повторно использовать только полный успешный список локальных test/build-команд. Квитанция `run.checks` схемы 2 требует `complete:true`, точного HEAD, чистого integration worktree, непустого настроенного списка test и совпадающего fingerprint: упорядоченные test/build-команды с аргументами, версия Node, ABI, платформа и архитектура. Все результаты должны соответствовать полному ожидаемому списку по порядку и иметь `exitCode:0`. При выполнении каждой команды проверяется, что HEAD и чистота дерева сохранились. Запись `checks_reused` показывает факт повторного использования, а не новый прогон.

Изменённый HEAD, команды или окружение, частичный/неуспешный список и старая квитанция без fingerprint не подходят. Перед проверками `setup` остаётся обязательным; повторная установка зависимостей регулируется его отдельным checkpoint. UI/security каждый раз выполняются со свежими наблюдениями перед ревью: прежний UI PASS не заменяет новый провал, даже при прежнем HEAD. Ревью также создаётся свежим. Это ограниченная экономия при восстановлении, не общий кэш произвольных результатов. Поправка checks сверена с integration-деревом координатора; границы локальной проверки документирующего worktree приведены в [VALIDATION](archive/VALIDATION.md#режимы-метрики-и-парный-benchmark).

### Кэш зависимостей

Для npm координатор и рабочие сессии повторно используют закрытый кэш в каноническом OS temp: `<os.tmpdir()>/kodo-npm-cache-<hash домашнего каталога>-<случайный суффикс>`. Каталог создаётся атомарно через `mkdtemp`; в POSIX проверяются владелец и отсутствие групповых/общих прав (`0700`), ссылки не принимаются. Указатель `<KODO_HOME>/npm-cache.json` имеет права `0600` и позволяет всем запускам и worktree одного хранилища повторно использовать кэш. Небезопасный или повреждённый указатель заменяется новым; прежний каталог не удаляется. Создание указателя сериализуется блокировкой Kodo.

`NPM_CONFIG_CACHE` указывает на этот каталог, доступный из native workspace-write сессий. npm сохраняет пакеты по содержимому и поддерживает параллельные обращения; новые задачи используют уже загруженные зависимости. Завершение запуска не удаляет общий кэш. Его обычное обслуживание выполняет пользователь средствами npm, например `npm cache verify --cache "<путь из npm-cache.json>"`.

## Сбои и продолжение

- Бюджет попыток узла и раундов проверки/ревью — 1/3/5 для quick/standard/deep, с сохранением меньшего `repairRounds` проекта. Повтор одинаковой ошибки без изменения рабочего результата может остановить цикл раньше как `no_progress`. При допустимом повторе фиксированная модель и режим сохраняются.
- При исчерпании бюджета сохраняются `controllerAssessment` и история оценок: scope, attempts, limit, reason, summary, `automaticRetries:false`. Запуск блокируется с нерешёнными требованиями. Fingerprint узла учитывает tracked diff и ограниченное содержимое untracked-файлов; зелёная проверка исправления зафиксирована координатором отдельно от более раннего красного среза documenter в [VALIDATION](archive/VALIDATION.md#интеграция-ui-security-и-контекста).
- При лимите подписки состояние сохраняется и запуск ждёт восстановления. Смена подписки допустима только при `both`; перехода на API GPT/Claude нет.
- Недоступная ранняя оценка Jev даёт записанный fallback standard, кроме явного режима. Недоступная маршрутизация узла в standard/deep использует основной допустимый вариант последовательно и отмечается отдельно. В quick отдельных routing-вызовов нет.
- Незавершённый verification repair сохраняется вместе с занятым раундом и ID сессии, если провайдер его сообщил. После quota/auth/cancelled/lease_lost обычный resume продолжает этот repair без нового раунда; преждевременная запись сигнатуры ошибки не должна считаться доказательством `no_progress`. Завершение repair сохраняется до проверки scope и commit; этот шаг выполняется относительно сохранённого HEAD до общего восстановления integration, синхронизации main и назначения release metadata, чтобы частичные записи не коммитились, а чужие upstream-изменения не попадали в scope repair. Затем локальные проверки, gates и ревью выполняются заново для итогового HEAD после обновления базы и metadata. Повтор той же ошибки на том же HEAD после завершённого repair по-прежнему останавливает цикл.
- При блокере сохраняются точная причина и выполненные результаты. Такой запуск не считается успешно завершённым.
- `cancel` отменяет дальнейшее исполнение и останавливает управляемые сессии. Уже выполненный merge нельзя выдавать за автоматически отменённый.

Явная команда `kodo resume <runId>` снимает отмену этого запуска и продолжает с сохранённого результата, в том числе после частично выполненной доставки. Это новое поручение продолжить; предыдущий merge не откатывается и не выполняется повторно. Если исчерпаны попытки незавершённых узлов и причина устранена, `kodo resume <runId> --retry-failed` открывает новый цикл попыток для этих узлов. История прежних попыток сохраняется, а завершённые и интегрированные задачи не сбрасываются. При сохранённом `pendingRepair` флаг `--retry-failed` продолжает его штатное завершение и commit, сохраняя занятый раунд, цикл, историю, ID сессии и признак `complete`, а новый verification cycle открывается только при отсутствии такого repair.

Перед повторением push, создания PR, merge и выпуска проверяется внешнее состояние. Возобновление не должно создавать дубликат, если предыдущий процесс завершился до записи локального результата.

## Метрики исполнения

`run.sessionAttempts` сохраняет попытки native-сессий, включая неуспех. `run.metrics` агрегирует `sessions`, `durationMs`, `toolSteps`, `usage`, `completeness`, `nativeRequestCount:null`, `historyComplete`, `coordinatorLogicalCalls` и `researchRequests`. Длительности измеряются монотонными часами. Длительность native-сессии включает клиент, инструменты и ожидание его результата; это не чистая LLM inference latency. В сумме учитываются также планирование, ревью и повторы, если они вызвали native-сессию.

`promptBytes` измеряет окончательный redacted `request.prompt` в UTF-8 после policy/tool guidance по каждой попытке, включая typed provider failures. `contextOriginalBytes`/`contextSentBytes` измеряют известную исходную часть compaction и отправленную JSON-сводку. Старые/отсутствующие измерения — `null`; агрегат становится известным только при полной истории соответствующего поля и сообщает `completeness`. Байты не включают всю native-переписку и скрытый контекст клиента, не меняют token/cache semantics и не являются квотой, ценой подписки или HTTP-счётчиком. [Фиксированные локальные измерения](EFFICIENCY.md#что-измерено-локально).

`toolSteps` считает наблюдаемые завершённые tool/command events с устранением повторов по ID; старты, обновления и текст ответа не являются дополнительными шагами. Число реальных backend HTTP-запросов native-клиентов не наблюдается и остаётся `null`. `coordinatorLogicalCalls` отдельно считает операции `assessment`, `analysis`, `research`, `routing`, `discovery`, включая неуспешные; это не число сетевых запросов. Engine — источник этих счётчиков: benchmark не прибавляет повторно операции обёртки. `researchRequests` отражает новые запросы исследования, без использования кэша, и не включает классификацию Jev.

Usage нормализуется в nullable `inputTokens`, `cachedInputTokens`, `outputTokens`, `cacheReadTokens`, `cacheWriteTokens`, `totalTokens`, со `source` и `semantics`. У Codex input уже включает cached input, поэтому total = input + output. У Claude cache read/write отдельны: total = input + cacheRead + cacheWrite + output только при известных компонентах. Невалидные, отсутствующие и не предоставленные host-клиентом значения остаются `null`. Агрегат не заменяет неизвестные нулями и показывает полноту каждого поля; смешанная семантика помечается `mixed`. Стоимость подписки в USD не выводится из токенов. [Парное измерение полного времени и ограничения](BENCHMARK.md).

## Аудит сохранённого запуска

`kodo audit RUN_ID [--json]` позволяет проверить сохранённую политику стандартных навыков и краткие квитанции проверок, ревью и доставки. Требуется только установленный CLI с этой командой и локальное состояние запуска; подготовка проекта из начала документа к аудиту не относится.

```powershell
$runId = "идентификатор-сохранённого-запуска"
kodo audit $runId
$audit = kodo audit $runId --json | ConvertFrom-Json
$audit.skills.complete
$audit.skills.missingStages
$audit.skills.stages | Where-Object { -not $_.valid }
```

Для текущего дерева исходников используй `node cli/index.mjs audit $runId --json`. `RUN_ID` обязателен; единственный допустимый флаг — один `--json` после ID. `--project`, `--live`, `--model`, `--json=true`, повторный флаг и лишний аргумент отклоняются. Справка: `kodo --help`.

Успешное чтение возвращает код 0, в том числе при `skills.complete: false`. Неизвестный запуск, отсутствующее хранилище, неверные аргументы или ошибка чтения дают ненулевой код, сообщение в stderr и пустой stdout. JSON в stdout — один объект без текстовой сводки. Для автоматической проверки полноты нужно читать `skills.complete`, а не только код выхода.

### Граница чтения

Команда использует `state.sqlite` из пользовательского каталога состояния (`KODO_HOME`, если задан) и может выполняться из постороннего каталога без `kodo.config.json`. Ранняя ветка `audit` в `runtimeCli` работает до `loadSecrets` и `openEngine`: она не читает ключи и конфигурацию проекта, не обращается к моделям, Git или сети и не изменяет worktree, события, leases либо знания. SQLite открывается с `readOnly: true` напрямую, поскольку конструктор `Store` создаёт таблицы и настраивает журнал. Отсутствующая база не создаётся; миграция схемы и новые зависимости не нужны.

`runtime/audit.mjs` экспортирует чистую синхронную функцию `buildAuditReport(run)`: без I/O и изменения входного объекта, включая вложенные массивы и квитанции. Старые записи и повреждённые вложенные данные остаются доступными для просмотра. Некорректный корень (например, `null`, массив или строка вместо объекта запуска) вызывает `TypeError`.

### JSON: схема 1

Верхний уровень содержит только следующие поля:

| Поле | Тип и смысл |
| --- | --- |
| `schemaVersion` | Число `1` |
| `runId`, `state` | Сохранённые строки, иначе `null` |
| `baseSha`, `headSha` | Сохранённые строки, иначе `null`; актуальность Git не проверяется |
| `evidenceLevel` | Всегда строка `recorded-instructions` |
| `skills` | `{ expectedStages, recordedStages, missingStages, complete, stages }` |
| `checks`, `review`, `delivery`, `release` | Ограниченные квитанции ниже; при отсутствии — `null` |

`expectedStages`, `recordedStages`, `missingStages` — массивы имён этапов. Канонический порядок: `analyze`, `plan`, `developer`, `tester`, `documenter`, `review`, `repair`, `complete`.

- Ожидаются `analyze`, `plan`, уникальные допустимые роли из `plan.tasks`, затем `review` и `complete`. Например, для задач только роли `tester`: `analyze, plan, tester, review, complete`. Роли не добавляются только потому, что они существуют в Kodo.
- `repair` ожидается только при наличии этой записи в `defaultSkills`, даже если сама запись некорректна. Остальные записанные известные этапы тоже проверяются, включая роли вне текущего плана.
- Неизвестные записанные этапы идут после известных в сортированном порядке, имеют `valid: false` и делают покрытие неполным. Их содержимое не копируется.
- `missingStages` перечисляет отсутствующие ожидаемые записи. Некорректная существующая запись отмечается через `stages[].valid: false`, а не как отсутствующая.
- `complete` — boolean. Для `true` нужны непустой массив `plan.tasks`, допустимая роль (`developer`, `tester` или `documenter`) у каждой задачи, все ожидаемые записи и валидность всех записанных этапов. Отсутствующий, пустой или повреждённый план не позволяет объявить полноту, даже если `missingStages` пуст.

Запись этапа имеет вид `{ stage, hash, valid, skills: [{ id, applies, reason, revision }] }`; некорректная запись также содержит диагностический массив строк `issues`. Для `valid: true` необходимы:

1. `hash` — ровно 64 шестнадцатеричных символа в нижнем регистре.
2. Ровно 13 уникальных `id` из `defaultSkillIds` в `runtime/skill-policy.mjs`, без пропусков, дубликатов или посторонних ID.
3. У каждого решения: boolean `applies`, строка `reason` с непробельным содержимым и `revision` из ровно 40 шестнадцатеричных символов в нижнем регистре. Это требуется и при `applies: false`.

Переставленные корректные решения принимаются и выводятся в порядке `defaultSkillIds`. При повреждении сохраняются только известные ID и разрешённые поля: значения неверного типа заменяются на `null`, некорректные строки могут остаться для диагностики. Поля `source` и любые дополнительные свойства не экспортируются.

Квитанции копируют только перечисленные поля подходящего типа:

| Квитанция | Разрешённые поля |
| --- | --- |
| `checks` | `headSha`: строка; `results`: массив объектов с `exitCode` (безопасное целое число) |
| `review` | `passed`: boolean; `headSha`, `diffHash`: строки |
| `delivery` | `pr: { number, url }`, где `number` — безопасное целое, `url` — строка; `reviewedHead`, `mergeCommit`: строки |
| `release` | Строки `version`, `tag`, `commit`, `url`, `artifact`, `artifactUrl`, `sha256`; boolean `published`; `smoke: { passed, node, platform }`, где `passed` — boolean, остальные — строки |

Отсутствующая квитанция или значение вместо объекта даёт `null`. В существующем объекте отсутствующие поля и поля неверного типа опускаются, поэтому возможен `{}`; неверный элемент `checks.results` становится `{}`, а некорректный присутствующий `pr` или `smoke` — `null`. Значения `false` и `0` сохраняются без преобразования строк. Вложенный произвольный объект не проходит через разрешённое скалярное поле.

Полные задачи и план, `config`, `nodes`, `analysis`, `research`, промпты, ключи, окружение и поля путей проекта в отчёт не входят. У проверок нет команд, аргументов или stdout/stderr, у ревью — findings и ответов провайдера. Это проекция по списку разрешённых полей, а не выгрузка `status` с удалением нескольких известных секретов; содержимое разрешённых строк не является универсально обезличенным.

Пример для условной старой записи `{ "id": "old-run", "state": "awaiting_plan" }` без политики и квитанций:

```json
{
  "schemaVersion": 1,
  "runId": "old-run",
  "state": "awaiting_plan",
  "baseSha": null,
  "headSha": null,
  "evidenceLevel": "recorded-instructions",
  "skills": {
    "expectedStages": ["analyze", "plan", "review", "complete"],
    "recordedStages": [],
    "missingStages": ["analyze", "plan", "review", "complete"],
    "complete": false,
    "stages": []
  },
  "checks": null,
  "review": null,
  "delivery": null,
  "release": null
}
```

Без `--json` выводятся ID и состояние, полнота, отсутствующие и некорректные этапы, применимые навыки с числом из 13 и хешем, а также имеющиеся краткие сведения о проверках, PR и релизе. Сводка явно называет уровень `recorded-instructions` и указывает, что семантическое соблюдение инструкций моделью не доказано.

`valid` проверяет структуру записи: аудит не пересчитывает хеш исходного промпта, не сверяет сохранённую revision с текущими pin и не проверяет обоснованность `applies`/`reason`. Наличие инструкций в промпте не доказывает их прочтение или исполнение. `skills.complete` независимо от `state`, exit codes, ревью и публикации. Квитанции отражают сохранённые значения; доступность PR/релиза, свежесть checks и байты артефакта онлайн не перепроверяются. [ADR о границе отчёта](decisions/0001-run-audit-evidence.md), [регрессионные проверки](archive/VALIDATION.md#целевые-проверки-аудита).

## Доставка

`--delivery none` ограничивает запуск локальными изменениями и проверками. `--delivery pr` предусматривает доставку через PR. `--delivery release` включает выпуск. Стадия, не выполненная в выбранном режиме, обозначается как непроведённая.

Очередь merge применяется к репозиторию и целевой ветке, очередь выпуска — к каналу выпуска. Проверки и ревью привязываются к актуальному head. Изменение `main` требует обновления ветки и повторной проверки. Пропущенный check, устаревшее ревью или отсутствие проверок не означают успех.

Для Kodo выпуск — GitHub Release с `.tgz`, SHA-256 и release notes после изолированной установки пакета и проверки CLI. Перед публикацией проверяется исходный commit; старый запуск не заменяет более новый результат. Публикация в npm не выполняется.

### Deadline, завершение процессов и cleanup выпуска

У self-project команды `npm run check` задан `timeoutMs: 1200000` (20 минут). В `releasePackage` тот же ограниченный fallback действует отдельно для каждой test/build-команды; явно заданный `timeoutMs` имеет приоритет. Остальные delivery-команды сохраняют свой deadline, по умолчанию 120000 мс.

Обычный `Engine.checks` также передаёт `command.timeoutMs` каждой test/build-команде. Без этого поля сохраняется default общего executor — 1800000 мс (30 минут); `0` означает немедленный deadline. Для test/build/deploy/smoke принимаются только целые числовые значения от 0 до 2147483647 включительно. Отрицательные, дробные, строковые, `null`, нечисловые и бесконечные значения, а также превышение предела дают `configuration` с путём `commands.<kind>[<index>].timeoutMs`. Проверка выполняется при чтении config и повторно для saved run до подготовки/доставки; `checks` проверяет её до setup и reuse квитанций. Это исключает приведение и переполнение Node timer в старых сохранённых запусках.

При timeout, abort или превышении вывода `delivery.execute` сначала завершает принадлежащее вызову дерево и дожидается `close` процесса и каналов. Windows-helper без профиля и видимого окна удерживает handles обнаруженных потомков, вызывает `taskkill /PID <owned-pid> /T /F` и ожидает их выхода. POSIX-вызов получает отдельную группу: SIGTERM, ограниченные 250 мс на штатное завершение, SIGKILL и проверка отсутствия работающих процессов этой группы. Zombies уже освобождают ресурсы; их reap выполняет OS-parent. Helpers ограничены deadline и очищенным окружением. Ошибка подтверждения teardown добавляется как `teardownError`; source сохраняется для восстановления, lease освобождается.

Общий объём stdout/stderr ограничен 20 MiB UTF-8 (`maxOutputBytes`), превышение даёт `invalid_output` и `result.outputTruncated: true`. У ошибок сохраняются redacted `stdout`, `stderr`, `exitCode` и `result`; сообщение содержит начало и конец обоих потоков, до 12000 символов на поток. Перед cleanup полный ограниченный вывод сохраняется отдельно в событие `delivery.command_failed`, без argv и окружения. Это позволяет найти исходную assertion даже при длинной сводке runner.

Проверенный урок redaction: значения удаляемых env-переменных нужно сохранить до передачи очищенного окружения runner. Они объединяются с `options.secrets` без потери одноимённых значений; тот же набор скрывает данные в runner, fallback-ошибке, событии и выбрасываемой ошибке, включая уже вычисленный `stack`, `cause` и вложенный `result`. Очистка одного события не защищает Engine от утечки через `message`.

Engine передаёт свою приватную карту секретов в `reconcileDelivery`, `prepareReleaseVersion`, `deliver` и `releasePackage`, включая обе ветки reconciliation и подготовки версии при `stale_base`. Карта используется только для redaction; она не добавляется в child env, worker prompts, config или saved run. Причина исправления: redaction полного ключа в Engine уже не может скрыть его префикс, если delivery ранее усекла raw output без знания ключа.

`tests/engine-delivery-contract.test.mjs` проверяет все шесть вызовов через настоящий `Engine.run` → delivery context → `delivery.execute` с локальным subprocess и синтетическим ключом вне env. SQLite run/error/events должны сохранять полезную диагностику без частичного ключа. Другие тесты этого файла наблюдают готовность test/build-subprocess и его остановку по явному deadline до позднего успешного завершения; watchdog не засчитывается как timeout. Также проверяются omitted/zero/max deadline и отказ для повреждённых config/saved run. Предыдущие стадии и внешние GitHub-команды в этих scoped проверках подменены; это локальные интеграционные доказательства, без native-provider, публикации или deployment. Общий `npm run check`, scanners и независимое ревью выполняет координатор после интеграции.

На границе лимита capture прекращает дописывать оба потока, включая поздние chunks при teardown; неполный UTF-8 code point отбрасывается, корректный U+FFFD сохраняется. До формирования ошибки в raw capture каждого потока определяется суффикс, совпадающий с незавершённым префиксом известного секрета: это защищает также timeout/cancel и разделённые chunks. Из redacted вывода сохраняется общий безопасный префикс полной строки и строки до найденной границы: короткое known value не скрывает начало длинного совпадения, а пересекающая границу полная замена не раскрывается при обрезке. Длинный или повторяющийся ключ обрабатывается линейным prefix matcher с таблицей не длиннее сохранённого потока; неограниченное продолжение вывода не читается в память и не сохраняется. Совпадения короче 10 символов заменяются `*` той же длины, остальные — `[REDACTED]`. Поэтому край диагностического текста может быть скрыт и при случайном совпадении; успешный raw machine output не проходит эту обработку. Тип первичной ошибки, exit и `outputTruncated` сохраняются. [Регрессии границ вывода](archive/VALIDATION.md#output-boundary-redaction-repair).

Удаление проверяет абсолютный непосредственный temp-path, точный разрешённый prefix, identity каталога (device/inode), canonical parent и отсутствие подмены root/source ссылкой. Для EBUSY/EPERM/EACCES/ENOTEMPTY выполняются максимум четыре попытки с паузами 50/100/200 мс и повторной проверкой принадлежности. Изменяемая первичная ошибка остаётся исходным объектом и типом; неизменяемая ошибка runner получает очищенную копию того же типа. Сведения об удалении добавляются в `cleanupErrors` и событие `delivery.cleanup_failed`. Уже подтверждённая квитанция `published: true` сохраняется при ошибке локального cleanup. Успешная публикация требует прежнего remote-confirmation и проверки байтов артефакта.

Проверенный урок: EBUSY в `finally` может быть следствием преждевременного reject и живых потомков. Поэтому диагностику и закрытие собственного дерева проверяют до удаления каталога; увеличение deadline само по себе этот сбой не устраняет. [Целевые RED/GREEN-проверки и ограничения](archive/VALIDATION.md#release-lifecycle).

Финальный отчёт различает реализацию, тесты, ревью, PR, merge, упаковку и проверку установленного/развёрнутого результата. «Задеплоено» относится к проверенному развёртыванию, а не только к push или сборке.

## Проверенные знания проекта

После успешной проверки результата Kodo сохраняет в пользовательском SQLite запись с runId, задачей, проверенным head, результатами команд, ревью, исправлениями и источниками. Следующий запуск того же Git-проекта получает последние записи до планирования в `analysis.priorLessons`. Это сведения о конкретных проверенных ревизиях; их нужно сопоставлять с текущим кодом, а не превращать автоматически в универсальные правила.

Неуспешный или только подготовленный запуск не должен становиться проверенным знанием. Методика ce-compound помогает выбирать полезный устойчивый урок; исходные материалы, ключи и сырые приватные ответы сервисов в эту запись не копируются.
