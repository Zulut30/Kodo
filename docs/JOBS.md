# Durable jobs: очередь заданий с арендами и однократной интеграцией

Задание (job) — одна ограниченная единица работы worker, результат которой координатор интегрирует отдельно и не более одного раза. Очередь живёт в SQLite состояния Kodo рядом с Project Director и legacy Run и переживает перезапуск процесса. Решения описаны в [ADR-0009](decisions/0009-durable-jobs.md).

**Статус.** Контракты, хранилище, планировщик и read-only CLI реализованы. Project Director и Engine пока **не** ставят задания в эту очередь: wiring — следующий шаг этапа07. До него `kodo jobs` показывает только очереди, созданные через API.

## Состояния

```
queued → running → verifying → integrating → integrated
            │  ↘ waiting_quota → queued
            ↘ queued (повтор) / failed / blocked / cancelled
```

| Состояние | Смысл |
| --- | --- |
| `queued` | Ждёт допуска |
| `running` | Исполняется worker под арендой с heartbeat |
| `waiting_quota` | Пауза по квоте провайдера; scope удержан, слот свободен |
| `verifying` | Результат записан, ждёт интеграции; повторно не исполняется |
| `integrating` | Координатор интегрирует; слот интеграции один на очередь |
| `integrated` | Результат интегрирован, квитанция записана |
| `blocked` | Ждёт внешнего решения: сбой зависимости, неподключённый host, конфликт интеграции, исчерпанные квоты |
| `failed` | Исполнение исчерпало retry policy |
| `cancelled` | Отменено |

## Правила допуска

Задание стартует, только если выполнено всё:

1. Каждая зависимость `integrated`. Завершённая, но не интегрированная зависимость не считается.
2. Host доступен. Неподключённый `t3`/`orca` даёт `blocked`, а не нативный запуск.
3. Worker предлагает требуемые `capabilities` и `requiredTools`.
4. Нет пересечения с начатыми и ещё не интегрированными заданиями: ни его `writePaths` с их `writePaths`, ни его `readPaths` с их `writePaths`, ни общих `locks`.
5. Есть свободный слот: `workers` (1–8) и, если задан, лимит подписочного `pool` (0–8).

Порядок: `priority` плюс число проигранных claim, затем возраст. После 8 проигрышей готовое задание резервирует свои scopes: конфликтующая с ним новая работа ждёт.

## Восстановление

| Событие | Что происходит |
| --- | --- |
| Аренда истекла (процесс умер) | Задание возвращается в очередь; при исчерпании попыток — `failed: lease_lost`. Старый worker получает `job_lease_lost` и его результат отбрасывается |
| Worker бросил ошибку | Повтор в пределах `retry.maxAttempts` (1–5, по умолчанию 2), иначе `failed`; `retryable: false` — сразу `failed` |
| Квота | `waiting_quota` до `retryAt` с сохранённым `checkpoint`; попытка не расходуется; не более 12 пауз |
| Сбой между записью результата и интеграцией | Задание остаётся `verifying` и интегрируется после перезапуска без исполнения |
| Сбой во время интеграции | Задание остаётся `integrating`. После истечения аренды оно возвращается первым с `recovery: true`: координатор сверяет, попал ли merge, и только записывает квитанцию либо повторяет интеграцию того же результата (не более 3 раз) |
| Остановка координатора | Исполняемые задания возвращаются в очередь без расхода попытки |
| Отмена | `queued`/`running`/`verifying` → `cancelled`. Во время интеграции отмена только помечается: merge мог уже состояться |
| Сбой зависимости | Зависимые каскадно `blocked: dependency:<key>` и автоматически возвращаются после `retry` |

## API

```js
import { Store } from './runtime/store.mjs';
import { openJobStore } from './runtime/job-store.mjs';
import { runJobQueue } from './runtime/job-scheduler.mjs';

const jobs = openJobStore({ store: new Store() });
jobs.enqueue('project:demo', [
  { key: 'api', role: 'developer', writePaths: ['src/api'] },
  { key: 'docs', role: 'documentation', writePaths: ['docs/api.md'], dependsOn: ['api'] },
]);
const summary = await runJobQueue({
  jobs,
  queue: 'project:demo',
  owner: 'coordinator',
  limits: { workers: 2, pools: { codex: 1 } },
  execute: async (job, { signal }) => ({ headSha }), // изолированный worker
  integrate: async job => ({ commit }), // только координатор
  reconcile: async job => ({ integrated, receipt }), // попал ли прерванный merge
});
```

`summary.status`: `integrated`, `waiting_quota` (с `retryAt`), `blocked`, `stalled` (с причинами), `busy` (работа принадлежит другому процессу или ждёт сверки) или `stopped`. Сбой задания не превращается в успех и не бросает исключение; исключение означает интеграцию с неизвестным исходом.

`enqueue` идемпотентен по `key`: тот же запрос возвращает существующее задание, изменённый — `job_idempotency_conflict`. Спецификации, результаты и квитанции с настроенными секретами отклоняются; тексты ошибок редактируются.

## CLI

```powershell
kodo jobs list [--queue QUEUE] [--json]   # очереди или задания одной очереди
kodo jobs status JOB_ID [--json]          # одно задание и последние 50 событий
```

Команды только читают: не захватывают задания, не продлевают аренды и не пишут события. Для задания в очереди `waitingFor` показывает причину ожидания (`dependency_pending:api`, `scope_conflict:api`, …). Токены аренды и `payload` не печатаются.

## Проверка

```powershell
node scripts/run-tests.mjs tests/job-contracts.test.mjs tests/job-store.test.mjs tests/job-scheduler.test.mjs tests/job-cli.test.mjs tests/job-git-chain.test.mjs
```

Fixtures управляемые: fake providers с барьером на 1/2/4/8 слотов и одна настоящая цепочка Git + SQLite с worktree на задание. Это offline evidence. Утверждений о реальном ускорении, работе подписочных клиентов или числе реально работавших агентов оно не даёт.
