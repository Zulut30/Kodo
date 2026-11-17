/** Read-only `kodo report`: operational report of a saved Run or Project.
 *
 * Arguments are parsed strictly before credentials or state are touched. Keys
 * are only read for redaction (never migrated), the state database is read
 * through one immutable snapshot (`report-state.mjs`: no Store, no migration,
 * no lease, no sidecar and no file created or changed), no model or provider
 * is started, and only redacted, fixed-vocabulary data is printed. Diagnostics
 * are constant codes that never echo arguments or paths. See docs/OBSERVABILITY.md.
 */
import { buildRunReport, buildProjectReport } from './telemetry.mjs';
import { readRedactionSecrets, readReportState } from './report-state.mjs';

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

/**
 * State receipts of the durable jobs of a Run's plans (`run:<id>:<plan>` queues),
 * read from the same snapshot as the Run. No job store is opened: a second
 * connection could see another state of the files or race a writer.
 */
function readJobEvents(state, runId) {
  if (!['kodo_jobs', 'kodo_job_events', 'kodo_job_migrations'].every(name => state.tables.has(name))) return [];
  const version = state.db.prepare('SELECT version FROM kodo_job_migrations ORDER BY version DESC LIMIT 1').get();
  if (version?.version !== 1) fail('report_unavailable');
  const prefix = `run:${runId}:`;
  return state.db
    .prepare('SELECT seq,job_id,type,data,time FROM kodo_job_events WHERE substr(queue,1,?)=? ORDER BY seq')
    .all(prefix.length, prefix)
    .map(row => ({
      jobId: String(row.job_id),
      seq: row.seq,
      type: String(row.type),
      data: { state: JSON.parse(String(row.data))?.state },
      time: row.time,
    }));
}

const projectTables = ['records', 'attempts', 'current', 'approvals', 'commands', 'events'].map(
  name => `kodo_project_${name}`,
);

/**
 * The Project repository validates each record exactly as `kodo project status`
 * does, but opening it runs its migrator. The migrator only reads when a version
 * row exists (it then verifies the digest and the tables); it writes (backup
 * directory, backup file, DDL) only when the row is missing. A report therefore
 * requires the row first, and its database port reports no file location, so
 * the migrator's write branch stops at its location check before any write.
 */
async function projectRepository(state, secrets) {
  if (!['kodo_project_migrations', ...projectTables].every(name => state.tables.has(name))) fail('report_not_found');
  const version = state.db.prepare('SELECT version FROM kodo_project_migrations ORDER BY version DESC LIMIT 1').get();
  if (version?.version !== 1) fail('report_unavailable');
  const { db } = state;
  const port = {
    prepare: sql => db.prepare(sql),
    exec: sql => db.exec(sql),
    get isTransaction() {
      return db.isTransaction;
    },
    location: () => null,
  };
  const contracts = await import('./project-contracts.mjs');
  const { openProjectStore } = await import('./project-store.mjs');
  return openProjectStore({
    store: { db: port, secrets, createRun: () => fail('report_unavailable') },
    contracts,
  });
}

async function projectReport(state, projectId, secrets, now) {
  const repo = await projectRepository(state, secrets);
  const snapshot = repo.snapshot(projectId);
  const attempts = state.db
    .prepare('SELECT task_id,number,run_id FROM kodo_project_attempts WHERE project_id=? ORDER BY task_id,number')
    .all(projectId)
    .map(row => ({ taskId: row.task_id, number: row.number, runId: row.run_id }));
  const runs = new Map(),
    events = new Map(),
    jobEvents = new Map();
  for (const { runId } of attempts) {
    const row = state.tables.has('runs') && state.db.prepare('SELECT body FROM runs WHERE id=?').get(runId);
    if (!row) continue;
    runs.set(runId, JSON.parse(String(row.body)));
    events.set(runId, readEvents(state, runId));
    jobEvents.set(runId, readJobEvents(state, runId));
  }
  return buildProjectReport(snapshot, runs, events, { now, attempts, jobEvents });
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

const measuredPart = item => (item.measuredMs === null ? '' : `, measured ${time(item.measuredMs)}`);

function humanRun(report) {
  const { timing, queue, checks, attempts, usage, observedUsage } = report;
  const tokens = observedUsage.completeness.usage.totalTokens;
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
    `Queue wait: ${time(queue.waitMs)} (${queue.jobs} jobs, ${queue.known}/${queue.total} waits known${measuredPart(queue)}); CI wait: ${time(checks.ci.waitMs)} (${checks.ci.polls} polls${measuredPart(checks.ci)})`,
    `Checks: ${checks.runs.length} saved results, ${checks.executions} started (${checks.unclosed} without result), ${checks.reused} reused; duration ${time(checks.totalMs)}`,
    `Attempts: ${value(attempts.sessions)} sessions (failed ${value(attempts.failedSessions)}, pending ${value(attempts.pendingSessions)}); node attempts ${value(attempts.nodeAttempts)}; verification rounds ${attempts.verificationRounds}; repairs ${attempts.repairRounds}`,
    `Usage: total tokens ${value(usage?.usage.totalTokens)} (observed ${value(observedUsage.usage.totalTokens)}, ${tokens.known}/${tokens.total} sessions known); prompt bytes ${value(usage?.promptBytes)}`,
    `Failures: ${report.failures.length ? report.failures.map(item => `${item.code}@${item.scope}`).join(', ') : 'none'}`,
    `Blocker: ${report.blocker ? `${report.blocker.code} (${report.blocker.scope}, seen ${value(report.blocker.occurrences)}x)` : 'none'}`,
    observations(report.provenance),
    caveat,
  ].join('\n');
}

const wait = item => `${time(item.waitMs)} (${item.known}/${value(item.total)} known${measuredPart(item)})`;
const failureCodes = rows =>
  rows === null ? 'unknown' : rows.length ? rows.map(item => `${item.code}@${item.scope}`).join(', ') : 'none';

function humanProject(report) {
  const { totals } = report;
  return [
    `Project ${report.projectId} | status ${report.status} | revision ${value(report.revision)}`,
    `Tasks: ${totals.tasks} (accepted ${totals.accepted}, integrated ${totals.integrated}, failed ${totals.failed}, blocked ${totals.blocked}, cancelled ${totals.cancelled}, pending ${totals.pending}); attempts ${totals.attempts}; sessions ${value(totals.sessions)}`,
    `Wall time: ${time(totals.wallMs)}; verification share: ${value(totals.verificationShare)}; total tokens ${value(totals.usage?.usage.totalTokens)} (observed ${value(totals.observedUsage.usage.totalTokens)})`,
    `Waits: queue ${wait(totals.waits.queue)}, delivery queue ${wait(totals.waits.deliveryQueue)}, CI ${wait(totals.waits.ci)}`,
    ...report.tasks.map(
      row =>
        `  ${row.id}  ${row.status}  attempts ${row.attempts}  wall ${time(row.wallMs)}  last run ${value(row.lastRunState)}`,
    ),
    'Attempts:',
    ...report.attempts.map(
      row =>
        `  ${row.taskId} #${value(row.number)} ${value(row.state)}: queue ${wait(row.waits.queue)}, delivery queue ${wait(row.waits.deliveryQueue)}, CI ${wait(row.waits.ci)}; failures ${failureCodes(row.failures)}`,
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

/** Build the report from one consistent read-only view of the state and name that view. */
async function buildReport(state, options, secrets) {
  const now = Date.now();
  const report = options.runId
    ? buildRunReport(readRun(state, options.runId), readEvents(state, options.runId), {
        jobEvents: readJobEvents(state, options.runId),
        now,
      })
    : await projectReport(state, options.projectId, secrets, now);
  report.provenance.snapshot = { method: state.snapshot.method, attempts: state.snapshot.attempts };
  return report;
}

/**
 * @param {string[]} argv
 * @param {{ home?: string, secrets?: Record<string, string>, loadSecrets?: () => Promise<Record<string, string>>,
 *   stateProbed?: () => unknown, temporaryRoot?: string, credentialHome?: string,
 *   removeDirectory?: (directory: string, options: { recursive: boolean, force: boolean }) => void }} [ports]
 *   Supplied by the coordinator or a test harness, never by decoded CLI data. `stateProbed`,
 *   `temporaryRoot`, `credentialHome` and `removeDirectory` are seams of the state snapshot
 *   (see `readReportState`).
 */
export async function reportCli(argv, ports = {}) {
  let options,
    report,
    exitCode = 0,
    phase = 'arguments';
  try {
    options = argumentsFor(argv); // No credentials or state before strict parsing.
    phase = 'state';
    const security = await import('./security.mjs');
    const home = ports.home || security.stateHome();
    // Keys are read for redaction only: no credential store is created and no legacy file migrated.
    const secrets =
      ports.secrets === undefined
        ? await (ports.loadSecrets || (() => readRedactionSecrets({ home })))()
        : ports.secrets;
    report = await readReportState(home, state => buildReport(state, options, secrets), {
      probed: ports.stateProbed,
      temporaryRoot: ports.temporaryRoot,
      // A private copy is never placed inside or around the state or the credential home.
      credentialHome: ports.credentialHome || security.credentialRoot(),
      removeDirectory: ports.removeDirectory,
    });
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
  }
  const json = options?.json || (Array.isArray(argv) && argv.includes('--json'));
  return { report, exitCode, output: json ? JSON.stringify(report, null, 2) : human(report) };
}
