/** Read-only `kodo jobs` reports: queue states, reasons, budgets and the
 * dependency graph. Nothing here claims, sweeps or cancels; the coordinator
 * that owns a queue is the only writer.
 */
import { JOB_HOSTS, admission } from './job-contracts.mjs';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const queuePattern = /^[A-Za-z][\w.:-]{0,119}$/;
const invalid = () => {
  throw Object.assign(new Error('Invalid jobs arguments'), { code: 'jobs_arguments' });
};

function argumentsFor(argv) {
  if (!Array.isArray(argv) || argv.some(arg => typeof arg !== 'string' || !arg.isWellFormed())) invalid();
  const [action, ...args] = argv;
  if (!['list', 'status'].includes(action)) invalid();
  const options = { action, json: false, queue: null, id: null };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--json' && !options.json) options.json = true;
    else if (arg === '--queue' && action === 'list' && options.queue === null && queuePattern.test(args[i + 1] ?? ''))
      options.queue = args[++i];
    else if (!arg.startsWith('-') && action === 'status' && options.id === null && uuid.test(arg)) options.id = arg;
    else invalid();
  }
  if (action === 'status' && options.id === null) invalid();
  return options;
}

const counts = jobs => {
  const result = {};
  for (const job of jobs) result[job.state] = (result[job.state] ?? 0) + 1;
  return result;
};

/**
 * Why a queued job cannot start, as far as the queue itself shows: dependencies,
 * scopes and locks. Hosts, worker capabilities and limits belong to whichever
 * coordinator drives the queue, so a report assumes them satisfied instead of
 * inventing a reason. Pure, no sweep.
 */
function waitingFor(job, jobs) {
  if (job.state !== 'queued') return null;
  const decision = admission(job, {
    jobs,
    limits: { workers: 8, pools: {} },
    hosts: Object.fromEntries(JOB_HOSTS.map(id => [id, { available: true }])),
    worker: {
      capabilities: jobs.flatMap(item => item.spec.capabilities),
      tools: jobs.flatMap(item => item.spec.requiredTools),
    },
  });
  if (decision.admit || !['dependency', 'scope', 'lock', 'yield'].some(kind => decision.reason.startsWith(kind)))
    return null;
  return decision.detail === undefined ? decision.reason : `${decision.reason}:${decision.detail}`;
}

/** Status row without payload, result bodies or lease tokens. */
const row = (job, jobs) => ({
  id: job.id,
  key: job.key,
  role: job.spec.role,
  state: job.state,
  reason: job.reason,
  waitingFor: waitingFor(job, jobs),
  priority: job.priority,
  attempt: job.attempt,
  maxAttempts: job.spec.retry.maxAttempts,
  dependsOn: job.spec.dependsOn,
  writePaths: job.spec.writePaths,
  host: job.spec.host,
  pool: job.spec.pool,
  leaseOwner: job.leaseOwner,
  retryAt: job.retryAt,
  updatedAt: job.updatedAt,
});

function human(report) {
  const { result } = report;
  if (result.queues)
    return result.queues.map(item => `${item.queue}: ${JSON.stringify(item.counts)}`).join('\n') || 'No job queues';
  if (result.jobs)
    return [
      `Queue ${report.queue}: ${JSON.stringify(result.counts)}`,
      ...result.jobs.map(job =>
        [job.key, job.state, job.reason ?? job.waitingFor ?? '', job.dependsOn.length ? `after ${job.dependsOn}` : '']
          .filter(Boolean)
          .join('  '),
      ),
    ].join('\n');
  if (result.job)
    return [
      `${result.job.key}  ${result.job.state}  ${result.job.reason ?? result.job.waitingFor ?? ''}`.trimEnd(),
      ...result.events.map(event => `${event.time}  ${event.type}`),
    ].join('\n');
  return `Jobs: ${result.status} (${result.code})`;
}

/**
 * @param {string[]} argv
 * @param {{ home?: string, secrets?: Record<string, string>, loadSecrets?: () => Promise<Record<string, string>> }} [ports]
 *   Supplied by the coordinator or a test harness, never by decoded CLI data.
 */
export async function jobsCli(argv, ports = {}) {
  let options,
    jobs,
    report,
    exitCode = 0,
    phase = 'arguments';
  try {
    options = argumentsFor(argv); // No credentials or state before strict parsing.
    phase = 'state';
    const security = await import('./security.mjs');
    const secrets = ports.secrets === undefined ? await (ports.loadSecrets || security.loadSecrets)() : ports.secrets;
    // Strictly read-only: no Store, no migration, no write lock, nothing created.
    const { openJobReader } = await import('./job-store.mjs');
    jobs = openJobReader({ home: ports.home || security.stateHome() });
    let result;
    if (options.action === 'status') {
      const job = jobs.get(options.id),
        all = jobs.list(job.queue);
      result = {
        status: 'ok',
        job: { ...row(job, all), readPaths: job.spec.readPaths, locks: job.spec.locks },
        events: jobs.events(job.id).slice(-50),
      };
      report = { schemaVersion: 1, queue: job.queue, result };
    } else if (options.queue) {
      const all = jobs.list(options.queue);
      result = { status: 'ok', counts: counts(all), jobs: all.map(job => row(job, all)) };
      report = { schemaVersion: 1, queue: options.queue, result };
    } else {
      result = { status: 'ok', queues: jobs.queues().map(queue => ({ queue, counts: counts(jobs.list(queue)) })) };
      report = { schemaVersion: 1, queue: null, result };
    }
    report = security.redact(report, secrets);
  } catch (error) {
    const known = phase === 'arguments' || error?.code === 'job_not_found';
    exitCode = known ? 1 : 2;
    // Constant diagnostics only: never echo arguments, paths or state.
    const code = phase === 'arguments' ? 'jobs_arguments' : known ? 'jobs_not_found' : 'jobs_blocked';
    report = { schemaVersion: 1, queue: null, result: { status: known ? 'invalid' : 'blocked', code } };
  } finally {
    jobs?.close();
  }
  const json = options?.json || (Array.isArray(argv) && argv.includes('--json'));
  return { report, exitCode, output: json ? JSON.stringify(report, null, 2) : human(report) };
}
