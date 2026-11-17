/** Read-only `kodo report`: operational report of a saved Run or Project.
 *
 * Arguments are parsed strictly before credentials or state are touched. The
 * state database is opened read-only (no Store, no migration, no lease and no
 * file created), no model or provider is started, and only redacted,
 * fixed-vocabulary data is printed. Diagnostics are constant codes that never
 * echo arguments or paths. See docs/OBSERVABILITY.md.
 */
import path from 'node:path';
import { statSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { buildRunReport, buildProjectReport } from './telemetry.mjs';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const fail = code => {
  throw Object.assign(new Error(code), { code });
};
const notFound = new Set(['report_not_found', 'project_entity_not_found', 'project_query_invalid']);

function argumentsFor(argv) {
  if (!Array.isArray(argv) || argv.some(arg => typeof arg !== 'string' || !arg.isWellFormed()))
    fail('report_arguments');
  const options = { json: false, runId: null, projectId: null };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--json' && !options.json) options.json = true;
    else if (arg === '--project' && options.projectId === null && uuid.test(argv[i + 1] ?? ''))
      options.projectId = argv[++i];
    else if (!arg.startsWith('-') && options.runId === null && uuid.test(arg)) options.runId = arg;
    else fail('report_arguments');
  }
  if ((options.runId === null) === (options.projectId === null)) fail('report_arguments');
  return options;
}

/**
 * A strictly read-only connection. A cleanly closed WAL database has no sidecar
 * files and a plain read-only open would create them, so without pending WAL
 * frames the file is opened immutable. Pending frames without their shared
 * memory file need writer recovery, which a report never performs.
 */
function openState(home) {
  const filename = path.join(home, 'state.sqlite');
  if (!statSync(filename, { throwIfNoEntry: false })?.isFile()) fail('report_not_found');
  const wal = statSync(`${filename}-wal`, { throwIfNoEntry: false }),
    shared = statSync(`${filename}-shm`, { throwIfNoEntry: false });
  if (wal?.size && !shared?.isFile()) fail('report_unavailable');
  let db;
  if (wal?.size) db = new DatabaseSync(filename, { readOnly: true });
  else {
    const uri = pathToFileURL(path.resolve(filename));
    uri.searchParams.set('mode', 'ro');
    uri.searchParams.set('immutable', '1');
    db = new DatabaseSync(uri.href, { readOnly: true });
  }
  try {
    db.exec('PRAGMA query_only=ON; PRAGMA busy_timeout=5000');
    const tables = new Set(
      db
        .prepare("SELECT name FROM sqlite_master WHERE type='table'")
        .all()
        .map(row => String(row.name)),
    );
    return { db, tables };
  } catch (error) {
    db.close();
    throw error;
  }
}

function readRun(state, id) {
  if (!state.tables.has('runs')) fail('report_not_found');
  const row = state.db.prepare('SELECT body FROM runs WHERE id=?').get(id);
  if (!row) fail('report_not_found');
  return JSON.parse(String(row.body));
}

function readEvents(state, id) {
  if (!state.tables.has('events')) return [];
  // Streamed session output is not reported and can be large: keep its type and time only.
  return state.db
    .prepare(
      "SELECT seq,type,time,CASE WHEN type='session' THEN '{}' ELSE data END AS data FROM events WHERE run_id=? ORDER BY seq",
    )
    .all(id)
    .map(row => ({ seq: row.seq, type: row.type, time: row.time, data: JSON.parse(String(row.data)) }));
}

/** State receipts of the durable jobs of this Run's plans (`run:<id>:<plan>` queues). */
async function readJobEvents(home, runId) {
  const { openJobReader } = await import('./job-store.mjs');
  const jobs = openJobReader({ home });
  try {
    const rows = [];
    for (const queue of jobs.queues().filter(name => name.startsWith(`run:${runId}:`)))
      for (const job of jobs.list(queue))
        for (const event of jobs.events(job.id))
          rows.push({
            jobId: job.id,
            seq: event.seq,
            type: event.type,
            data: { state: event.data?.state },
            time: event.time,
          });
    return rows;
  } finally {
    jobs.close();
  }
}

async function projectReport(state, projectId, secrets, now) {
  if (
    !['kodo_project_migrations', 'kodo_project_records', 'kodo_project_attempts'].every(name => state.tables.has(name))
  )
    fail('report_not_found');
  const contracts = await import('./project-contracts.mjs');
  const { openProjectStore } = await import('./project-store.mjs');
  // The repository validates each record exactly as `kodo project status` does. Its Store
  // port is this read-only connection: the migration already exists, so opening only
  // verifies it, and the port cannot create a Run.
  const repo = await openProjectStore({
    store: { db: state.db, secrets, createRun: () => fail('report_unavailable') },
    contracts,
  });
  const snapshot = repo.snapshot(projectId);
  const attempts = state.db
    .prepare('SELECT task_id,number,run_id FROM kodo_project_attempts WHERE project_id=? ORDER BY task_id,number')
    .all(projectId)
    .map(row => ({ taskId: row.task_id, number: row.number, runId: row.run_id }));
  const runs = new Map(),
    events = new Map();
  for (const { runId } of attempts) {
    const row = state.tables.has('runs') && state.db.prepare('SELECT body FROM runs WHERE id=?').get(runId);
    if (!row) continue;
    runs.set(runId, JSON.parse(String(row.body)));
    events.set(runId, readEvents(state, runId));
  }
  return buildProjectReport(snapshot, runs, events, { now, attempts });
}

const time = value => {
  if (typeof value !== 'number') return 'unknown';
  if (value < 1000) return `${Math.round(value)} ms`;
  if (value < 60000) return `${(value / 1000).toFixed(1)} s`;
  return `${Math.floor(value / 60000)} min ${Math.round((value % 60000) / 1000)} s`;
};
const value = item => (item === null || item === undefined ? 'unknown' : String(item));
const caveat = 'Prompt bytes are not tokens; elapsed time is not pure LLM latency; platforms are not compared.';
const observations = provenance =>
  `Observations: ${provenance.complete ? 'complete' : `incomplete (${provenance.notes.join(', ')})`}`;

function humanRun(report) {
  const { timing, queue, checks, attempts, usage } = report;
  return [
    `Run ${report.runId} | state ${report.state} | mode ${value(report.mode)} | client ${value(report.client)}`,
    `Wall time: ${time(timing.wallMs)} (created ${value(timing.createdAt)}, finished ${timing.finishedAt ?? 'not finished'})`,
    'Stages (sum of measured durations):',
    ...Object.entries(timing.stages)
      .filter(([, stage]) => stage.total > 0)
      .map(
        ([name, stage]) =>
          `  ${name}: ${time(stage.durationMs)} (${stage.known}/${stage.total} known; ${value(stage.sessions)} sessions; ${stage.source})`,
      ),
    `Queue wait: ${time(queue.waitMs)} (${queue.jobs} jobs, ${queue.known}/${queue.total} waits known); CI wait: ${time(checks.ci.waitMs)} (${checks.ci.polls} polls)`,
    `Checks: ${checks.runs.length} saved results, ${checks.executions} started, ${checks.reused} reused; duration ${time(checks.totalMs)}`,
    `Attempts: ${value(attempts.sessions)} sessions (failed ${value(attempts.failedSessions)}, pending ${value(attempts.pendingSessions)}); node attempts ${value(attempts.nodeAttempts)}; verification rounds ${attempts.verificationRounds}; repairs ${attempts.repairRounds}`,
    `Usage: total tokens ${value(usage.usage.totalTokens)} (${usage.completeness.usage.totalTokens.known}/${usage.completeness.usage.totalTokens.total} sessions known); prompt bytes ${value(usage.promptBytes)}`,
    `Failures: ${report.failures.length ? report.failures.map(item => `${item.code}@${item.scope}`).join(', ') : 'none'}`,
    `Blocker: ${report.blocker ? `${report.blocker.code} (${report.blocker.scope}, seen ${value(report.blocker.occurrences)}x)` : 'none'}`,
    observations(report.provenance),
    caveat,
  ].join('\n');
}

function humanProject(report) {
  const { totals } = report;
  return [
    `Project ${report.projectId} | status ${report.status} | revision ${value(report.revision)}`,
    `Tasks: ${totals.tasks} (accepted ${totals.accepted}, integrated ${totals.integrated}, failed ${totals.failed}, blocked ${totals.blocked}, cancelled ${totals.cancelled}, pending ${totals.pending}); attempts ${totals.attempts}; sessions ${value(totals.sessions)}`,
    `Wall time: ${time(totals.wallMs)}; verification share: ${value(totals.verificationShare)}; total tokens ${value(totals.usage.usage.totalTokens)}`,
    ...report.tasks.map(
      row =>
        `  ${row.id}  ${row.status}  attempts ${row.attempts}  wall ${time(row.wallMs)}  last run ${value(row.lastRunState)}`,
    ),
    `Blockers: ${report.blockers.length ? report.blockers.map(item => `${item.code}@${item.taskId ?? item.scope}`).join(', ') : 'none'}`,
    observations(report.provenance),
    caveat,
  ].join('\n');
}

const human = report =>
  report.kind === 'run'
    ? humanRun(report)
    : report.kind === 'project'
      ? humanProject(report)
      : `Report: ${report.code}`;

/**
 * @param {string[]} argv
 * @param {{ home?: string, secrets?: Record<string, string>, loadSecrets?: () => Promise<Record<string, string>> }} [ports]
 *   Supplied by the coordinator or a test harness, never by decoded CLI data.
 */
export async function reportCli(argv, ports = {}) {
  let options,
    state,
    report,
    exitCode = 0,
    phase = 'arguments';
  try {
    options = argumentsFor(argv); // No credentials or state before strict parsing.
    phase = 'state';
    const security = await import('./security.mjs');
    const secrets = ports.secrets === undefined ? await (ports.loadSecrets || security.loadSecrets)() : ports.secrets;
    const home = ports.home || security.stateHome();
    state = openState(home);
    const now = Date.now();
    if (options.runId) {
      const run = readRun(state, options.runId);
      report = buildRunReport(run, readEvents(state, options.runId), {
        jobEvents: await readJobEvents(home, options.runId),
        now,
      });
    } else report = await projectReport(state, options.projectId, secrets, now);
    report = security.redact(report, secrets);
  } catch (error) {
    const code =
      phase === 'arguments'
        ? 'report_arguments'
        : notFound.has(error?.code)
          ? 'report_not_found'
          : 'report_unavailable';
    exitCode = code === 'report_unavailable' ? 2 : 1;
    // Constant diagnostics only: never echo arguments, paths or state.
    report = { schemaVersion: 1, kind: 'error', status: exitCode === 1 ? 'invalid' : 'blocked', code };
  } finally {
    state?.db.close();
  }
  const json = options?.json || (Array.isArray(argv) && argv.includes('--json'));
  return { report, exitCode, output: json ? JSON.stringify(report, null, 2) : human(report) };
}
