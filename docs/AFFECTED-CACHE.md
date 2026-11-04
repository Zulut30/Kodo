# Affected graph и приватный кеш команд

Phase 03 draft. Этот модуль не меняет обязательные `npm run check`, UI/security,
Windows/Linux CI, package smoke или release gates. Интеграция разрешена только
после приёмки phase 02. Локальные тесты не доказывают native/provider, CI,
опубликованный artifact или deployment.

## Граф

```js
const plan = await planAffected({ project, baseSha, headSha, changedPaths: [] });
// {schemaVersion:1, changedFiles, affectedFiles, testFiles, fallback,
//  reasons, sourceHash, dependencyHash}
```

`project` — корень Git-проекта без symlink; SHA — полный commit ID. По умолчанию
`headSha` равен текущему HEAD, `baseSha` — head. Изменения берутся из настоящего
`git diff --name-status -z --find-renames base head`; переданные относительные
POSIX `changedPaths` только дополняют diff и не могут скрыть изменения. Для rename
учитываются оба имени. Нельзя передавать абсолютные пути, `..`, `.` или backslash.

Граф читает неизменные Git blobs base и head, а не исполняет проект. Acorn разбирает
JS/MJS/CJS import, export-from, literal import() и require/require.resolve.
Обратный обход транзитивен и использует обе ревизии, включая удалённые рёбра.
Workspace package names сопоставляются с package.json и простыми exports/main;
относительные межпакетные зависимости тоже учитываются. Node builtin определяется
через `isBuiltin` (включая `node:test`); объявленные внешние dependencies отдельно
участвуют в графе и dependency hash. Они не подменяются локальными файлами.

`fallback:true` обязывает вызывающий код запускать полный штатный test runner,
а не считать `testFiles` исчерпывающим списком произвольной конфигурации runner.
`testFiles` содержит известные test/spec/test-* и test/__tests__ файлы текущего
head. При fallback `affectedFiles` содержит весь текущий tracked inventory.
Без fallback возвращаются только изменения и обратные транзитивные зависимости.
Проверка не утверждает, что тест не зависит от файла, только по имени каталога.

Причины полного прогона: TS/JSX/другие обнаруженные языки исходников (например,
Python/PowerShell/Go/C#), неподдержанный синтаксис, parse error, вычисляемый
import/require, aliased loader/eval, unresolved imports, package imports/непонятные
exports, submodule/symlink, грязное дерево или несовпадающий HEAD, изменение
package/lock/CI/config/объявленной публичной точки входа и неизвестный тип файла.
`fs`, `child_process`, `vm`, `worker_threads` и `module` также требуют fallback:
они могут читать/запускать локальный код без import-ребра. Это намеренное ограничение
первой версии; такой проект пока не получает ускорения за счёт сужения тестов.
Невалидный SHA/путь или ошибка Git прекращают планирование с ошибкой, а не PASS.

`sourceHash` — SHA-256 JSON массива `[file,mode,GitBlobOID]` всего head inventory.
`dependencyHash` — SHA-256 JSON `{manifests,edges}` текущего head: package/lock
`[file,GitBlobOID]` и отсортированные `[file,resolvedDependencies]`. Хеши не содержат
байты source/секреты. Порядок детерминирован и не зависит от locale.

Parser: ровно **acorn 8.15.0**, MIT, [исходник](https://github.com/acornjs/acorn),
[npm metadata](https://registry.npmjs.org/acorn/8.15.0).
Проверенный npm integrity:
`sha512-NZyJarBfL7nWwIq+FDL6Zp/yHEhePMNnnJ0y3qfieCrmNvYct8uvtiV41UvlSe6apAfk0fY1FbWx+NwfmpvtTg==`.
Установка dependency выполнялась с `--save-exact --ignore-scripts`; npm scripts
не изменялись. Никакого eval/import пользовательского исходника нет.

## Контракт кеша

```js
const input = {
  project, headSha, sourceHash: plan.sourceHash, dependencyHash: plan.dependencyHash,
  lockHash, envHash,
  runtimeVersions: { node: process.versions.node, v8: process.versions.v8,
    modules: process.versions.modules },
  toolVersions: { node: process.versions.node }, // Все фактически используемые tools/pins.
  platform: process.platform, arch: process.arch,
  command: process.execPath, args: ['--test', ...plan.testFiles],
  kind: 'test', gateConfig: effectiveGateConfig
};
const fingerprint = cacheFingerprint(input); // synchronous, 64-char SHA-256
const previous = await readCheckCache({home, fingerprint, project, headSha, input});
if (!previous) {
  // Выполнить ТОЧНУЮ command/args и сохранить настоящие полные результаты.
  await writeCheckCache({home, fingerprint, project, headSha, input, receipt});
}
```

Контекст обязателен полностью; недостающие поля не получают пустые «безопасные»
значения. `envHash` вычисляет координатор по эффективному окружению команды, без
публикации переменных/ключей. `lockHash` — SHA-256 JSON отсортированного массива
`[relativeFile,GitBlobOID]` всех package-lock.json/npm-shrinkwrap.json/yarn.lock/
pnpm-lock.yaml/bun.lock/bun.lockb в head (`SHA256('[]')`, когда их нет). Хеши source,
dependencies и lock, Node/V8/ABI, OS/arch, project, HEAD, tools/pins, env, точные
command/args и effective gate config участвуют в ключе.

Ключ надо **заново вычислять из текущих наблюдений** перед каждым read. Хранить
старый ключ после смены tools/env/config запрещено. `input` при каждом read обязателен:
без полного свежего контекста lookup возвращает miss. Его fingerprint всегда
проверяется. Read дополнительно сам перепроверяет настоящий чистый HEAD,
tracked source/dependency/lock hashes и runtime/OS/arch. Он не запускает внешние
tools для определения версий: их актуальные наблюдения — ответственность caller.
Изменение tools в node_modules должно отражаться в freshly observed toolVersions/
pins; это не считается проверенным только по package-lock.

Успешная квитанция имеет `kind:test|build|lint|typecheck`, `status:'passed'`,
`exitCode:0`, `complete:true`, точные `headSha`, `command`, `args` и непустой
`evidence:[{path,bytes,sha256}]` полного вывода. Kind UI/security/unknown,
disabled/skipped, неполная квитанция, неизвестный exit и публичный trust не
принимаются. Caller обязан передавать только настоящую квитанцию локальной
команды; API не является подписью произвольного утверждения об исполнении.
UI/security квитанции всегда выполняются и проверяются заново через свои gates.

`home` — абсолютный отдельный приватный каталог вне любого Git-дерева. Записи:
`home/ci-check-cache-v1/<fingerprint>.json`. Повреждённый/неизвестный/missing кеш
даёт `null`; отказ записи — `false`; это требует реальной проверки, не PASS.
Хранятся только разрешённые метаданные, хеши args/config/tools/env и пути evidence,
без stdout, сырого окружения или конфигурации. Envelope и referenced evidence
проверяются по hash/bytes, regular-file/nlink и noLinks. Изменённый или отсутствующий
полный вывод делает квитанцию непригодной. SHA-256 обеспечивает целостность,
а не защиту от намеренной подделки кодом того же владельца.

Запись — exclusive временный файл, затем atomic rename. POSIX: каталог 0700,
receipt 0600 с проверкой владельца/прав при read. Windows: ACL только текущего
владельца и SYSTEM, защищённое наследование каталога, повторная проверка ACL
каталога и файла при read. Используется фиксированный .NET/PowerShell скрипт,
путь передаётся через stdin. Он не меняет ACL родительского home/чужих файлов.
Производитель evidence отвечает за приватность собственных raw logs.
Symlink/junction/hardlink и storage внутри Git отвергаются. Публичный кеш можно
использовать для данных/downloads, но он никогда не является trusted PASS.

## Проверки и уроки

```powershell
node --test tests/ci-graph.test.mjs tests/ci-cache.test.mjs
```

| Requirement | Evidence |
| --- | --- |
| Транзитивность и детерминизм | `Affected graph follows transitive re-exports and excludes independent tests deterministically` |
| Workspace, builtins, external и literal loaders | `Affected graph parses literal dynamic imports require and workspace package boundaries` |
| Старые рёбра | `Affected graph retains old reverse edges for deleted and renamed files` |
| Неизвестные зависимости/синтаксис | `Affected graph fails broad for computed dependencies unsupported syntax and undeclared imports` |
| Config/lock/CI/public API | `Affected graph config lock CI and public entry changes invalidate narrow plans` |
| Полный diff и грязное дерево | `Affected graph never trusts incomplete changed paths or a dirty tree` |
| Runtime I/O не теряет тесты | `Affected graph recognizes node-only builtins and fails broad on runtime file and process dependencies` |
| Git root и relative config | `Affected graph requires the repository root and ignores relative diff configuration` |
| Неподдержанные языки | `Affected graph cannot narrow tests in a project with unsupported source languages` |
| Первый miss и настоящее повторное чтение | `Command cache first run misses and exact successful complete private receipt can be reused` |
| Полнота fingerprint | `Command cache fingerprints invalidate source dependency lock HEAD runtime tools arguments environment and gates` |
| Непригодные квитанции | `Command cache rejects failures missing evidence gates unknown and public trust` |
| Порча/пропажа evidence | `Command cache detects tampered envelope missing output and changed output bytes` |
| HEAD/runtime/hash и грязные source | `Command cache dirty tree wrong current HEAD runtime and forged hashes cannot pass` |
| Untracked после записи | `Command cache rechecks dirty untracked files after a successful write` |
| Приватная граница | `Command cache rejects repository storage symlink home hardlinked output and public envelopes` |
| Права после записи | `Command cache refuses receipt permissions widened after a successful write` |

RED/GREEN, точный исходный head, команды, имена тестов и raw receipts сохраняются
координатору вне Git. Полный интеграционный `npm run check` и независимое ревью
принадлежат координатору. Время этих fixture-тестов не является сравнением скорости
CI или измеренным выигрышем affected selection.

Уроки: import-only граф не доказывает отсутствие runtime I/O зависимостей;
`builtinModules` не перечисляет все node-only builtins, нужен `isBuiltin`;
Windows `Get-Acl` зависит от module search окружения, прямой .NET ACL API сохраняет
проверку в очищенном worker environment без загрузки пользовательских modules.
