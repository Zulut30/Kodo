# Architecture Guardian: ограниченный MVP

Этап 04 добавляет offline-проверку объявленных границ модулей и контрактов. Локальные A–E и независимый CLI oracle интегрированы; общая приёмка этапа, интеграция gate G, fresh security/review и required CI ещё **pending**. Принятое разделение ответственности описано в [ADR-0007](decisions/0007-architecture-guardian.md); состояние доказательств — в [phase-04](kodo-roadmap/phase-04.md).

## Поддерживаемая область

Нужны Node.js 24+, Git, исходный commit и чистое фактическое дерево на текущем HEAD. Анализатор читает immutable Git objects base/head; проверка текущих байтов не ограничивается porcelain и обнаруживает изменения под assume-unchanged/skip-worktree. Ссылки и небезопасные пути отвергаются до канонизации; физические Windows aliases сохраняются.

В MVP анализируются product ESM `.mjs` и `.js` при `package.json type=module`. TypeScript/TSX/JSX, CJS, Rust, C#, Go, PHP и другие executable product languages дают явный unsupported/blocked. Неопределённые loaders, imports/exports и package resolution не превращаются в соответствие архитектуре. CSS/data остаются ресурсами. Builtin IO сам по себе допустим; неизвестные зависимости блокируют.

`productRoots` задаёт полную анализируемую область продукта. JS внутри неё без module owner — нарушение. Тесты, docs, scripts, vendored examples вне неё входят в source inventory/hash, но не получают архитектурный PASS. Импорт product-кода в локальный файл вне productRoots блокируется `out-of-product-import`. Нельзя выводить общую корректность проекта из проверки его небольшой JS-части. [Language quality](QUALITY.md) — отдельный механизм с собственными SDK/tool pins, offline dependencies и ограничениями; его девять профилей не являются девятью архитектурными анализаторами.

## CLI

Из checkout Kodo вместо `kodo` используй `node cli/index.mjs`. `--project` указывает корень целевого Git-репозитория; без него берётся cwd. Base обязателен: полный 40/64-значный lowercase Git SHA существующего commit. Head определяется внутри команды.

```powershell
$project = 'D:\Projects\hearthstone-site'
$base = git -C $project rev-parse HEAD~1
kodo architecture plan --project $project --base $base --json
kodo architecture check --project $project --base $base --evidence-dir 'C:\PrivateEvidence\hearthstone-architecture' --json
```

Перед запуском собственные policy, registry, исходники и тесты должны быть зафиксированы в назначенном worktree. Evidence — абсолютный приватный путь вне Git; ссылки, общий корень, home и пересечение evidence/project запрещены. Если путь опущен, check создаёт приватный подкаталог системного temp. Plan ничего не исполняет и не создаёт evidence, не меняет Git index, state или credentials.

Доступны только `plan|check`, `--base`, `--project`, `--json` и check-only `--evidence-dir`. Нет `--head`, `--preset`, генератора baseline или CLI approval-флага. Unknown/duplicate/inapplicable flags возвращают exit1 и один JSON:

```json
{"schemaVersion":1,"status":"blocked","passed":false,"reason":"arguments","headSha":null}
```

Ранние причины: `arguments|configuration|unsafe_path|dirty_head|changed_head|scope_limit|cancelled|timeout|evidence_integrity`; произвольный текст исключения не экспортируется. Нормальные `failed|blocked` дают exit1, `passed|planned|not_applicable` — exit0. Нейтральный exit0 не означает приёмку.

## ArchitecturePolicy v1

Фиксированный файл — `architecture.policy.json`. Все top-level поля обязательны; unknown keys и старый alias `protected` отвергаются. `schemaVersion=1`, `version` — положительное целое. Пример для `src/core/index.mjs` с `export const value = 1;` и `src/app/main.mjs`, импортирующего value:

```json
{
  "schemaVersion": 1,
  "version": 1,
  "productRoots": ["src"],
  "modules": [
    {"id":"app","roots":["src/app"],"layer":"app","public":[],"allow":["core"]},
    {"id":"core","roots":["src/core"],"layer":"core","public":["src/core/index.mjs"],"allow":[]}
  ],
  "layers": {"app":["core"],"core":[]},
  "forbiddenImports": [{"from":"core","to":"app"}],
  "cycles": "forbid",
  "contracts": "architecture.contracts.json",
  "baseline": [],
  "exceptions": [],
  "protectedPaths": ["architecture.contracts.json","architecture.policy.json","tests/core-contract.test.mjs"]
}
```

Roots — канонические относительные directory prefixes, без glob, dot, traversal и overlap; module roots лежат внутри productRoots. Public — точные пути entry-файлов. `allow` перечисляет module IDs, `layers` — разрешённые направления между слоями. Каждое cross-module ребро должно одновременно удовлетворять allow, layer, public-entry и forbidden правилам. Self-module private imports допустимы; cycles проверяются между модулями. Пустой public не требует контракта. Нормализатор возвращает сам policy, deep copy с отсортированными sets/modules; порядок baseline/exceptions сохраняется для индексов.

## Контракты, изменения и тесты

Файл registry задаётся полем contracts. Для каждого public entry нужен ровно один контракт; exports — отсортированный точный набор имён из AST. shapeHash — явно объявленный SHA-256 формы, без вывода семантической совместимости. Для приведённого value hash от канонического `{"exports":["value"]}` равен:

```json
{
  "schemaVersion": 1,
  "contracts": [{
    "id":"core-api","module":"core","version":1,"entry":"src/core/index.mjs",
    "exports":["value"],
    "shapeHash":"72244b441fcd9be65f320eebe3187a87f7590e9d68ecafea8e1924a22f61d7df",
    "tests":["tests/core-contract.test.mjs"]
  }],
  "migrations": []
}
```

Зарегистрированный tracked regular `tests/core-contract.test.mjs`:

```javascript
import test from 'node:test';
import assert from 'node:assert/strict';
import { value } from '../src/core/index.mjs';
test('registered core value equals one', () => assert.equal(value, 1));
```

Изменение реализации product JS зарегистрированного модуля выбирает его текущие contract tests и тесты зарегистрированных транзитивных consumers даже без изменения интерфейса. Version bump/migration тогда не нужен; plan может иметь changes=[] и непустой requiredTests. CSS-only изменение не запускает посторонние contract tests.

Изменение entry/module/exports/declared shape или версии считается breaking консервативно: требуется увеличение версии и одна append-only migration от старой версии к новой. Consumers — объединение транзитивных reverse module dependencies base/head; каждый consumer должен иметь изменённый product JS и mapped tests. Пример записи при core-api 1→2 и consumer app (добавляется в migrations; полный registry также содержит актуальный контракт версии 2):

```json
{
  "contractId":"core-api","fromVersion":1,"toVersion":2,
  "plan":"docs/migrations/core-api-v2.md","consumers":["app"],
  "tests":[
    {"module":"core","files":["tests/core-contract.test.mjs"]},
    {"module":"app","files":["tests/app-contract.test.mjs"]}
  ]
}
```

Plan и tests должны существовать как tracked regular files в head; tests имеют suffix `.test.mjs|.test.js`. Retirement использует toVersion:null, требует replacement tests producer и consumers в head; retired ID не возвращается. Старую migration history нельзя переписывать. Новое добавление/первое enrollment требует producer tests, но не миграции потребителей. Registry только планирует и формирует findings, сам тесты не запускает.

Check запускает каждый required file отдельно через реальный Node: `node --test --test-reporter=tap -- ABSOLUTE_FILE`, shell=false, очищенное worker environment, без NODE_TEST_CONTEXT/NODE_OPTIONS, общий deadline максимум 120000ms. Для PASS нужны exit0, полный TAP summary, tests≥1, ноль fail/cancelled/skipped/todo, неизменные HEAD/actual bytes/runtime и intact private evidence. Exit0, fake/imported receipts, пустой или truncated TAP недостаточны. Raw captures редактируются до сохранения; redactions — только ephemeral metadata координатора, не поля policy/registry/плана.

## Долг, защита и первое включение

Baseline и exception имеют одинаковую форму и одинаковые права: `{"findingId":"<64 lowercase hex>","owner":"team","reason":"tracked debt","reviewAfter":"2026-12-01T00:00:00Z"}`. Placeholder ID нужно заменить ID реально существующего base finding. Автоматического snapshot-all нет. Допустимы только точные неизменённые, неистёкшие base findings семейств ownership/dependency/layer/private-entry. Severity остаётся error. Любой changed participating path или новый source hash запрещает перенос. Contract, unsupported и protection ошибки не погашаются.

Невалидные записи блокируют: `duplicate|expired|not-in-base|changed-source|ineligible`; exceptions не дают более широкой индульгенции. В report.debt сохраняется весь результат `{schemaVersion,activeFindings,debt,invalidEntries}`; каждый debt row содержит finding, source baseline|exception и исходный index.

Если policy действительно отсутствовала в immutable base, `basePolicyState="absent"`, `baseRulesEvaluated=false`, baseFindings=[], registry base=null. Head policy используется для поиска области/consumers в base, но это не доказывает прежнее соответствие и не создаёт старый долг. Malformed/unreadable base блокирует, а не считается отсутствующим. После настоящих producer tests первое enrollment может локально дать passed:true; одновременно requiresReview/fullVerificationRequired=true, нужны broad L2 и независимое current-head review.

Изменения policy/roots/contracts/baseline/exceptions, protected paths, CI/golden/tool pins требуют full verification и review. Учитывается union старой/новой защиты, поэтому удаление правила не снимает gate. Отсутствие policy в base/head нейтрально; удаление enrolled policy блокируется. Caller-supplied approval boolean не предусмотрен.

## Ручные presets

Пять data-only starter policies находятся в `presets/architecture/`. Выбор явный: скопируй нужный JSON в architecture.policy.json назначенного проекта и адаптируй к реальным boundaries, затем добавь registry/tests и проверь diff. Автовыбора, CLI `--preset` и новых catalog IDs нет. Preset не создаёт layout или contracts; отсутствующие файлы/roots блокируют.

| Preset | Пример layout и направления |
| --- | --- |
| modular-monolith | src/app → src/core |
| plugin-host | src/plugins/example → src/host |
| library | src/api → src/internal |
| desktop-app | src/main → src/shared; src/renderer → src/shared |
| headless-web | src/routes → src/services → src/domain |

У каждого starter-модуля public entry — index.mjs в его root; productRoots=["src"], cycles=forbid, baseline/exceptions пусты, защищены policy/registry. Это шаблоны заявленных границ, не архитектура, автоматически обнаруженная у пользователя.

| Иллюстративный проект | Применение MVP и предел |
| --- | --- |
| Hearthstone-сайт | headless-web для подготовленных ESM routes/services/domain; статистика колод, достоверность источников и браузерный UX требуют отдельных проверок. Next.js TSX/JSX этим AST MVP не сертифицируется |
| VCS на Rust | library показывает направление API→internal концептуально; .rs внутри productRoots даёт unsupported/blocked. Cargo/Clippy относятся к quality, native Rust architecture пока отложен |
| Windows desktop app | desktop-app подходит ESM main/renderer/shared. WPF/Avalonia C# и .NET SDK этим preset не анализируются; native UI smoke остаётся отдельным наблюдением |
| WordPress plugin | plugin-host иллюстрирует ESM plugin→host, либо отдельно заданную JS-часть. PHP hooks/permissions/plugin lifecycle не анализируются; PHP/WPCS/PHPStan и установленный WordPress smoke проверяются отдельно |

## Отчёт и gate

Нормальный JSON schemaVersion=1 содержит status, passed, headSha, basePolicyState, baseRulesEvaluated, hashes:{source,policy,registry}, findings, unsupported, debt, requiredTests, receipts, requiresReview, fullVerificationRequired. passed=true только у passed; false у failed/blocked; null у planned/not_applicable. requiredTests rows: `{file,forContracts,forModules}`. Findings имеют id, ruleId, severity:error, nullable file/offset/fromModule/toModule, relatedFiles и sourceHashes; id привязан к остальным полям.

Фиксированные rule IDs: ownership.unowned/overlap; dependency.forbidden/not-allowed/cycle; layer.direction; entry.private; contract.exports/version/migration/dependent/tests. Неподдержанные элементы возвращаются отдельно с scope/file/reason/offset/id и блокируют анализируемую область.

Receipt содержит id/file/status/exitCode/durationMs/headSha/sourceHash/policyHash/registryHash, runtime:{node,abi,platform,arch}, counts:{tests,pass,fail,cancelled,skipped,todo}, evidence:[{path,bytes,sha256}]. Null exitCode/counts означает незавершённое наблюдение, а не PASS. Приватные captures вне Git не публикуют environment, prompts или provider output.

Замороженный интеграционный контракт G: config ровно `"architecture":{"enabled":false}`, default false; disabled нейтрален. Enabled gate связывает base/head/source, normalized policy/registry/config, Node/runtime, checker/parser pins и intact private evidence, повторно проверяет waiver expiry. Freshness асинхронна и должна await-иться; source/repair/integration invalidates receipt, delivery проверяет его снова. Старые runs не получают enabled задним числом. На этом docs-checkpoint G ещё не принят: наличие контракта не доказывает работу Engine/delivery. Full checks и независимое review остаются обязательными.

Windows offline-примеры не доказывают всю platform/native SDK matrix. GPT/Claude остаются подписочными клиентами; архитектурный CLI не запускает их и не имеет API fallback. UI disabled — neutral, не PASS; release/deployment этапа 04 не заявлены.
