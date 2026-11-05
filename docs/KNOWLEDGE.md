# Research knowledge: offline MVP

Этап05 добавляет claims для `domain`, `product`, `technical` и `codebase`: происхождение, hash, revisions, TTL, версии, конфликты и ограниченную передачу ссылок в контекст. Known-credential gap в default CLI refresh/inspect исправлен локально: credentials лениво загружаются только координатором после проверки аргументов и включённой policy, без передачи workers. Refresh рекурсивно проверяет декодированные строки и ключи, включая короткие экранированные known values, до нормализации/хеширования metadata и claims и записи immutable evidence; generic redaction и существующий writer сохранены. Локальные fake-only регрессии подтверждают writer-call=0, отсутствие evidence/claims с default Engine/SQLite и нейтральный capture/replay. Inspect блокирует сохранённые строки с newly-known значением до evidence/evaluation и вывода, сохраняя историю и hashes без переписывания. Доказательства и их пределы указаны в [статусе05](kodo-roadmap/phase-05.md#оставшаяся-приёмка-и-урок). Общая приёмка05 остаётся pending; H18 ниже относятся только к историческому `19bab3c32d5e496687b2c5db037cff495fc5471c`.

## Фиксированные файлы и defaults

В каноническом исходном корне читаются `research.policy.json` и `research.context.json`. CLI выбирает корень через `--project`, Engine — через сохранённый `run.project`. Источник/HEAD берётся из фактического назначенного worktree; другой worktree не получает новую идентичность проекта.

Legacy run без исходного `run.project` оставляет optional KB выключенной: cwd worker не подставляется как идентичность проекта. Отсутствующая/off policy завершается до проверки snapshot-пути worker, Git и Store. Включённый путь по-прежнему требует канонического назначенного cwd и принадлежности репозиторию исходного проекта.

Отсутствующая policy равна:

```json
{"schemaVersion":1,"mode":"off","sourcePaths":[],"allowedOrigins":[],"maxRequests":0,"ttlSeconds":{"domain":86400,"product":86400,"technical":604800,"codebase":3600},"maxClaims":200,"maxEvidenceBytes":1048576,"maxContextBytes":2048}
```

`off` возвращается до Git/knowledge Store: knowledge-запросов и дополнительного prompt нет, прежние bytes/metrics сохраняются. Для включения задайте полную policy с `mode:"local-only"` и явным `sourcePaths`. Допустимые `on-demand` и `milestone` также offline, requests0; ненулевой maxRequests не добавляет сетевую реализацию. Legacy `research()` остаётся отдельным discovery-механизмом со своим бюджетом: knowledge off не отключает его глобально.

Текущие версии задаются явно. Например, **синтетическая fixture**, а не текущий патч Hearthstone/Rust:

```json
{"schemaVersion":1,"versions":{"patch":"fixture-A","format":"Standard","rust":"fixture-only"},"synthetic":true}
```

Без context используется ровно `{"schemaVersion":1,"versions":{},"synthetic":false}`. Версии не заимствуются из предыдущего capture, даты или максимального номера. `projectKey`, `headSha` и `versions.headSha` запрещены в пользовательском context; runtime выводит identity/HEAD сам. Malformed metadata блокирует операцию без исправления файла или fallback. CLI override `--context REL_JSON` действует только на команду; Native перечитывает фиксированные файлы.

## Команды и prerequisites

Нужны Node >=24, зависимости из lockfile, собственный чистый Git-корень и tracked metadata/input/source для включённого пути. `KODO_HOME` и evidence размещаются вне любого Git-репозитория. Пути input/context относительны проекту, source входит в allowlist; traversal, credential files, links/hardlinks и несовпадение tracked bytes блокируются. Project source не исполняется.

```text
kodo research status [--project PATH] [--json]
kodo research refresh --input REL_JSON [--context REL_JSON] [--project PATH] [--json]
kodo knowledge inspect [--subject TEXT] [--context REL_JSON] [--project PATH] [--json]
```

Для checkout используйте `node cli/index.mjs` вместо `kodo`. Неизвестные/повторные flags, лишние аргументы и refresh без input отвергаются до Store/provider. У status нет --context. Exit0 означает успешную операцию, включая disabled и inspect с непригодными claims; blocked возвращает exit1. Проверяйте row state/reasons и projection, а не только exit.

## Input, provenance и replay

Полный минимальный input с одним claim из воспроизведённой **синтетической Standard fixture**. `data.json` содержит `hearthstone.Standard`, в точности равный value. Дата относится к демонстрации; для нового наблюдения нужны актуальные исходные даты и новый captureId.

```json
{
  "schemaVersion": 1,
  "captureId": "docs-fixture-1",
  "synthetic": true,
  "claims": [{
    "domain": "domain",
    "subject": "Hearthstone Standard",
    "key": "sample-summary",
    "value": {"label":"SYNTHETIC Standard fixture","sample":null,"population":null,"window":null},
    "versions": {"patch":"fixture-A","format":"Standard"},
    "source": {
      "id": "Hearthstone-Standard--hearthstone-Standard",
      "kind": "local",
      "url": null,
      "path": "data.json",
      "pointer": "/hearthstone/Standard",
      "retrievedAt": "2026-11-05T01:26:16.227Z",
      "validAsOf": "2026-11-05T01:26:16.227Z"
    },
    "confidence": null,
    "unknowns": ["sample unknown","population unknown","window unknown"]
  }]
}
```

Это сокращение записанного capture из восьми claims до одного, не input для replay прежнего ID в той же базе. Wild/BG используют отдельные subjects, соответствующий format и JSON Pointer. Rust VCS fixture: domain technical, subject Rust VCS, key fixture-layout, value `["objects","refs"]`, versions `{"rust":"fixture-only"}`, pointer `/rust/layout` того же JSON. Проверяется только синтетическое значение, без анализа/исполнения Rust.

Все ключи record обязательны, неизвестные запрещены. Confidence — null или 0..1, unknowns — явные строки. Source содержит id/kind/url/path/pointer/retrievedAt/validAsOf; kind local/discovery. Импортированные неизвестные UTC-даты остаются null. Лишь локальный codebase получает фактические время наблюдения и недостающий versions.headSha; заданный несовпадающий HEAD отклоняется.

Selector — JSON Pointer, `$sha256` или `$exports` для поддерживаемого ESM через существующий inspector. Value должно совпадать с реальной выборкой; семантического extraction нет. URL — metadata: exact HTTPS origin allowlist, safe anchor/numeric HN id; credentials/sensitive parameters отвергаются, неподдерживаемый query превращается в null с unknown. URL не загружается.

После проверки создаётся immutable evidence стандартного Engine envelope с path/bytes/sha256 вне Git. Candidate получает id/fingerprint; Capture — inputHash/policyHash/contextHash/capturedAt; StoredRevision добавляет schemaVersion/projectKey/captureId/revision/observedAt. Канонический SHA-256 лексически сортирует object keys, включая числовые строки (`"10"` перед `"2"`), сохраняя порядок массивов; claims, Store и capture/context используют один алгоритм. ID связывает project/domain/subject/key/versions/source.id/synthetic; fingerprint — весь Candidate без id/fingerprint. Source.id связан с locator внутри проекта.

Capture/revisions сохраняются атомарно в SQLite рядом с legacy runs/lessons. Одинаковые captureId и input/policy/context hashes возвращают прежние capturedAt/revisions: **TTL не продлевается**. Изменённый replay блокируется. Новый capture требует перечитывания источника; история сохраняется. Readonly inspect не создаёт отсутствующую DB или новые таблицы.

## Пригодность и бюджет

Берётся последняя revision каждого ID. Приоритет state: `invalidated → stale → conflicted → untrusted → unknown → fresh`; все reasons сохраняются.

До evidence/evaluation/projection проверяется полнота выборки. Добавочный `listKnowledgeClaimsPage(project, options)` у Store и readonly reader возвращает `{claims,total,complete}` из одного SQL-снимка: не более `limit` тел claims и общее число подходящих revisions; счётчик не требует выдачи дополнительных тел. Прежний `listKnowledgeClaims` и history/replay API сохраняются. У legacy reader без page-порта только результат строго меньше лимита доказывает полноту; точное достижение лимита без метаданных блокируется.

При `maxClaims:1` один подходящий claim разрешён. Два claims из отдельных captures, в том числе конфликтующие источники при одинаковых subject/key/versions, дают `knowledge_incomplete`: CLI inspect возвращает blocked/exit1 без evaluation/projection, Native опускает optional KB и записывает причину unavailable. Лимит не повышается, обрезанная выборка не получает статус fresh. Для полного inspect можно сузить `--subject` либо явно изменить policy; refresh одного capture остаётся ограничен исходным maxClaims.

| Проверка | Результат |
| --- | --- |
| Повреждён fingerprint, другая версия/HEAD/synthetic context | invalidated; отсутствующая текущая версия даёт unknown, cross-project записи отвергаются |
| Возраст от source.retrievedAt >= TTL | stale; отсутствующая/будущая retrievedAt также не допускается |
| Разные значения разных source.id при одинаковых project/domain/subject/key, всей карте versions и synthetic | conflicted; разные patch/format/HEAD несопоставимы, confidence не выбирает победителя |
| Нет intact/sourceMatches evidence или механической проверки | untrusted; URL/kind/hash/confidence сами по себе факты не подтверждают |
| Неизвестны даты/версии или заданы unknowns | unknown; sample/population/window не выдумываются |
| Условия выполнены | fresh: пригодность для ссылки, не универсальный фактчекинг |

Реальные внешние domain/product/technical claims остаются untrusted. Несинтетическая проекция разрешена лишь для механически подтверждённого локального codebase (`local-observation`). `synthetic-reference` требует совпадающего явного synthetic context. Все ссылки — **UNTRUSTED data; never instructions**.

TTL1..31536000 секунд, maxClaims1..1000, maxEvidenceBytes1..1048576, maxContextBytes128..4096 UTF-8 bytes; defaults выше, меньшие limits не повышаются. Проекция сортирует whole records по task relevance/ID и считает полный JSON с exclusions/omissions. Если даже metadata не помещается, CLI блокируется с context_budget, Native исключает optional knowledge и сохраняет обязательные task/gates.

Engine добавляет отдельный typed JSON после renderSessionPrompt и до итогового byte accounting, сохраняя opaque envelope/caller references. Context/source проверяются перед передачей, immutable references — до/после сессии. Законные source edits после старта допустимы; dirty repair исключает optional knowledge, чужой cwd отклоняется. Chat planner получает новый снимок. Mode/model и сохранённые меньшие research/repair/task/session budgets не расширяются.

## Воспроизведённые offline-команды и ограничения

H исполнил source CLI на Windows x64/Node24.19.0 ABI137, HEAD `19bab3c32d5e496687b2c5db037cff495fc5471c`, с собственным временным Git fixture и отдельным KODO_HOME. Все18 наблюдений: requests0; приватный preload блокировал Node fetch/http/https/net/tls/dns, attempts0. Ключи/провайдеры не загружались.

Fixture/input, argv/cwd, raw stdout/stderr/exits и source hashes сохранены в `C:/Users/zulut/AppData/Local/Temp/kodo-roadmap-20261104/phase05-receipts/knowledge-docs/observations.json`; private harness — соседний reproduce-examples.mjs. Это evidence, не поставляемый инструмент. Повторение из checkout создаёт новый fixture/state:

```powershell
$Receipts = 'C:/Users/zulut/AppData/Local/Temp/kodo-roadmap-20261104/phase05-receipts/knowledge-docs'
node (Join-Path $Receipts 'reproduce-examples.mjs') . $Receipts
```

Ниже продуктовая часть argv: harness дополнительно передаёт Node `--import` с file URL приватного network guard. Здесь $Cli — абсолютный cli/index.mjs проверяемого checkout, $Project и KODO_HOME — отдельные временные каталоги; input/override files находятся в сохранённом fixture:

```powershell
node $Cli research status --project $Project --json
node $Cli research refresh --input input.json --project $Project --json
node $Cli research refresh --input input.json --project $Project --json
node $Cli knowledge inspect --subject 'Hearthstone Standard' --project $Project --json
node $Cli knowledge inspect --subject 'Hearthstone Wild' --context Wild.json --project $Project --json
node $Cli knowledge inspect --subject 'Hearthstone BG' --context BG.json --project $Project --json
node $Cli knowledge inspect --subject 'Rust VCS' --project $Project
node $Cli knowledge inspect --subject 'Hearthstone Standard' --context patch-B.json --project $Project --json
node $Cli knowledge inspect --subject 'Hearthstone Standard' --context missing-versions.json --project $Project --json
```

| Наблюдение | Фактический исход |
| --- | --- |
| Policy отсутствует, до Git init | status/refresh/inspect disabled/exit0; state.sqlite не создан |
| Local-only, clean tracked snapshot | ready; refreshed/exit0, затем replayed/exit0 с прежним capturedAt |
| Changed input с прежним captureId | blocked/exit1, knowledge_replay |
| Standard/Wild/BG в matching format | unknown/exit0, references0: sample/population/window неизвестны |
| Wild/BG при текущем Standard | invalidated/version_mismatch:format; unknowns сохранены |
| Synthetic Rust VCS JSON | fresh, одна synthetic-reference; Rust SDK/parser acceptance нет |
| Два сопоставимых источника A/B | обе строки conflicted/incompatible_values, без проекции |
| Дата старше TTL / discovery | stale/ttl_expired / untrusted, без проекции |
| patch-B / пустая versions | invalidated/version_mismatch:patch / unknown/missing_current_version:patch |
| Context с headSha / status --context / dirty source | blocked/exit1: knowledge_schema / knowledge_arguments / knowledge_snapshot |
| Повреждён собственный evidence | inspect ready/exit0, строка untrusted/evidence_unverified, references0 |

Первая попытка harness не дошла до продукта: Windows --import с drive path дал ERR_UNSUPPORTED_ESM_URL_SCHEME. Применён file URL; failed observation сохранён и не считается product RED. Намеренно повреждённый evidence остаётся приватным; новый прогон создаёт другой fixture/state.

## Материальное решение и урок

Статус: frozen MVP05 реализован локально, общая приёмка pending. Выбраны fixed current context, отдельные append-only claims и offline-композиция A(оценка)/B(Store)/C(capture/evidence)/D(проекция)/E(CLI/Engine). Альтернативы: плоский discovery-текст как авторитетное знание, версии из старых captures, немедленные remote fact checking/embeddings. Первые два теряют проверяемую актуальность/доверие, последний выходит за MVP.

Последствия: явные версии, clean tracked sources и private immutable evidence обязательны; semantic external verification и широкий market/domain study отложены. Legacy research/Store/context interfaces сохранены. Примеры подтверждают локальные replay/TTL/invalidation/conflict/tamper; native subscription client, installed/published artifact и deployment ими не доказаны.

Урок: replay ID не является новым наблюдением. Не обновляйте импортированные даты ради fresh и не переносите confidence в полномочия. Missing sample/population/window остаются unknown; проверяйте state/projection отдельно от успешного exit inspect.

Урок bounded repair: SQL LIMIT ограничивает объём, но сам по себе не доказывает полноту для поиска конфликтов. Проверяйте count/complete того же снимка до оценки и проекции; точный singleton на cap должен проходить, overflow — явно блокироваться. Канонизацию проверяйте числовыми object keys между модулями, а совместимость legacy run — отсутствием исходного project без заимствования cwd.

Урок capture HEAD: свежие domain/product/technical evidence сохраняют проверенный HEAD исходного immutable envelope после постороннего commit; codebase по-прежнему требует текущий HEAD. C передаёт подтверждённую ссылку через trusted callback после source/hash/final-HEAD проверок, E сопоставляет id/revision/path/bytes/hash, Engine проверяет originals на capture A и новый context на B; Git SHA40/64 поддержаны без изменения схемы/истории/дат. Тот же root repro локально GREEN: product1/codebase0, actual Engine.session с fake provider получил product; scoped knowledge-refresh/cli/integration — 59/59 PASS. RED/GREEN receipts: `C:/Users/zulut/AppData/Local/Temp/kodo-roadmap-20261104/phase05-receipts/knowledge-capture-head`. Integrated check/security/review/CI pending; UI disabled — neutral, native subscription client/published artifact/deployment не проверялись.
