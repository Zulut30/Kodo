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

/**
 * Redact every string value; keys stay. Report keys are a fixed vocabulary, so a
 * credential that happens to equal a field name never renames a schema field.
 * Values match by the same policy as security.redact (longer than five characters).
 */
const redactValues = (value, secrets, redact) =>
  typeof value === 'string'
    ? redact(value, secrets)
    : Array.isArray(value)
      ? value.map(item => redactValues(item, secrets, redact))
      : value && typeof value === 'object'
        ? Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redactValues(item, secrets, redact)]))
        : value;

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

// A report validates the installed project schema on its private read-only snapshot.
async function projectRepository(state) {
  if (!['kodo_project_migrations', ...projectTables].every(name => state.tables.has(name))) fail('report_not_found');
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
    // Structural validation only: keys mask printed values after the build, so a key
    // equal to a record field name never makes a valid snapshot unreadable.
    skipMigration: true,
    store: { db: port, secrets: {}, createRun: () => fail('report_unavailable') },
    contracts,
  });
}

function readIntegrationQueue(state, projectId) {
  if (!state.tables.has('kodo_integration_queue')) return [];
  return state.db
    .prepare('SELECT * FROM kodo_integration_queue WHERE project_id=? ORDER BY seq')
    .all(projectId)
    .map(row => ({
      seq: Number(row.seq),
      projectId: String(row.project_id),
      taskId: String(row.task_id),
      attemptId: String(row.attempt_id),
      runId: String(row.run_id),
      baseSha: String(row.base_sha),
      headSha: String(row.head_sha),
      priority: Number(row.priority),
      status: String(row.status),
      enqueuedAt: String(row.enqueued_at),
      updatedAt: String(row.updated_at),
      outcome: JSON.parse(String(row.outcome)),
    }));
}

async function projectReport(state, projectId, secrets, now) {
  const repo = await projectRepository(state);
  const snapshot = repo.snapshot(projectId);
  const attempts = state.db
    .prepare(
      'SELECT id,task_id,number,run_id,body FROM kodo_project_attempts WHERE project_id=? ORDER BY task_id,number',
    )
    .all(projectId)
    .map(row => {
      const parsed = JSON.parse(String(row.body));
      return {
        id: row.id,
        taskId: row.task_id,
        number: row.number,
        runId: row.run_id,
        status: parsed?.status ?? null,
        createdAt: parsed?.createdAt ?? null,
        updatedAt: parsed?.updatedAt ?? null,
      };
    });
  const integrationQueue = readIntegrationQueue(state, projectId);
  const profile = state.tables.has('kodo_project_profiles') ? repo.getProfile(projectId) : null;
  const runs = new Map(),
    events = new Map(),
    jobEvents = new Map();
  // Task attempt Runs and, in a wave project, the gate Runs of its gates.
  const gateRuns = (snapshot.gates ?? [])
    .map(gate => ({ runId: gate.runId }))
    .filter(row => typeof row.runId === 'string');
  for (const { runId } of [...attempts, ...gateRuns]) {
    if (runs.has(runId)) continue;
    const row = state.tables.has('runs') && state.db.prepare('SELECT body FROM runs WHERE id=?').get(runId);
    if (!row) continue;
    runs.set(runId, JSON.parse(String(row.body)));
    events.set(runId, readEvents(state, runId));
    jobEvents.set(runId, readJobEvents(state, runId));
  }
  return buildProjectReport(snapshot, runs, events, { now, attempts, jobEvents, integrationQueue, profile });
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
      // A stage with observations is shown even when its denominator is unknown (incomplete history).
      .filter(([, stage]) => stage.total > 0 || stage.known > 0 || stage.source !== null)
      .map(
        ([name, stage]) =>
          `  ${name}: ${time(stage.durationMs)} (${stage.known}/${value(stage.total)} known${measuredPart(stage)}; ${value(stage.sessions)} sessions; ${value(stage.source)})`,
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

const statusCounts = counts => {
  const rows = Object.entries(counts ?? {}).sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
  return rows.length ? rows.map(([status, count]) => `${status} ${count}`).join(', ') : 'none';
};
// Wave gates only: a legacy project report has no `gates`. Arbitrations of the gate arbiter
// (16B1) are listed when a gate recorded one.
const arbitrationLine = totals =>
  totals?.arbitrations?.total
    ? [
        `Arbitrations: ${totals.arbitrations.total} (confirm_pass ${totals.arbitrations.confirm_pass}, confirm_defect ${totals.arbitrations.confirm_defect}, split_needed ${totals.arbitrations.split_needed})`,
      ]
    : [];
const gateLines = (gates, totals) =>
  Array.isArray(gates)
    ? [
        `Gates: ${gates.length || 'none'}`,
        ...gates.map(
          row =>
            `  ${row.id} ${row.status} ${row.containers.join(', ') || 'none'} run ${row.runId ?? 'none'}${row.arbitration ? ` arbiter ${row.arbitration}` : ''}`,
        ),
        ...arbitrationLine(totals),
      ]
    : [];

const bucket = item =>
  item ? `${time(item.durationMs)} (${item.known}/${value(item.total)} known${measuredPart(item)})` : 'unknown';
const rateText = item =>
  item?.tasksPerHour === null || item?.tasksPerHour === undefined ? 'unknown' : `${item.tasksPerHour} tasks/h`;
const percentText = item =>
  item?.rate === null || item?.rate === undefined ? 'unknown' : `${Math.round(item.rate * 1000) / 10}%`;
const arbitrationLines = item => {
  if (!item) return [];
  const entries = Object.entries(item.decisions ?? {}).sort(([a], [b]) => a.localeCompare(b));
  const detail = entries.length ? ` (${entries.map(([k, v]) => `${k} ${v}`).join(', ')})` : '';
  return [`Arbitrations: ${value(item.count)}${detail}`];
};
const utilizationLines = item => {
  if (!item) return [];
  const cap = item.overall.capacity === null ? '' : `/${item.overall.capacity}`;
  return [
    `Utilization: slots median ${value(item.overall.median)}, peak ${value(item.overall.peak)}${cap} (${item.overall.known}/${value(item.overall.total)} known)`,
    ...item.subscriptions.map(
      sub =>
        `  subscription ${sub.id} (${value(sub.provider)}/${value(sub.model)}): median ${value(sub.median)}, peak ${value(sub.peak)}/${value(sub.slots)}`,
    ),
    ...item.machines.map(
      m =>
        `  machine ${m.id} (${value(m.kind)}): median ${value(m.median)}, peak ${value(m.peak)}/${value(m.maxWorkers)}`,
    ),
  ];
};
const telemetryLines = report => {
  if (!report.throughput) return [];
  const { throughput, taskDuration, breakdown, firstPassYield, arbitrations, interventions, utilization } = report;
  return [
    `Throughput: integrated ${rateText(throughput.integrated)} (${throughput.integrated.count}, window ${time(throughput.integrated.windowMs)}), accepted ${rateText(throughput.accepted)} (${throughput.accepted.count}, window ${time(throughput.accepted.windowMs)})`,
    `Task duration: p50 ${time(taskDuration.p50Ms)}, p95 ${time(taskDuration.p95Ms)} (${taskDuration.known}/${value(taskDuration.total)} known)`,
    `Breakdown: agent ${bucket(breakdown.agent)}, task-fast ${bucket(breakdown.taskFast)}, queue wait ${bucket(breakdown.integrationQueue.wait)} (p95 ${time(breakdown.integrationQueue.wait.p95Ms)}), queue merge ${bucket(breakdown.integrationQueue.merge)}, gate verify ${bucket(breakdown.gates.verify)}, gate review ${bucket(breakdown.gates.review)}, gate repair ${bucket(breakdown.gates.repair)}, quota ${bucket(breakdown.quota)}, human ${bucket(breakdown.human)}`,
    `First-pass yield: task-fast ${percentText(firstPassYield.taskFast)} (${firstPassYield.taskFast.passed}/${firstPassYield.taskFast.total}), gate ${percentText(firstPassYield.gate)} (${firstPassYield.gate.passed}/${firstPassYield.gate.total})`,
    ...arbitrationLines(arbitrations),
    `Interventions: abandon ${value(interventions.abandon)}, retry-failed ${value(interventions.retryFailed)}, rejections ${value(interventions.rejections)}`,
    ...utilizationLines(utilization),
  ];
};

/** The text summary of a project report (`kodo report --project` without `--json`). */
export function humanProject(report) {
  const { totals } = report;
  return [
    `Project ${report.projectId} | status ${report.status} | revision ${value(report.revision)}`,
    `Tasks: ${totals.tasks} (accepted ${totals.accepted}, integrated ${totals.integrated}, failed ${totals.failed}, blocked ${totals.blocked}, cancelled ${totals.cancelled}, pending ${totals.pending}); attempts ${totals.attempts}; sessions ${value(totals.sessions)}`,
    `Epics: ${statusCounts(report.progress?.epics)}`,
    `Wall time: ${time(totals.wallMs)}; verification share: ${value(totals.verificationShare)}; total tokens ${value(totals.usage?.usage.totalTokens)} (observed ${value(totals.observedUsage.usage.totalTokens)})`,
    `Waits: queue ${wait(totals.waits.queue)}, delivery queue ${wait(totals.waits.deliveryQueue)}, CI ${wait(totals.waits.ci)}`,
    ...telemetryLines(report),
    ...report.tasks.map(
      row =>
        `  ${row.id}  ${row.status}  attempts ${row.attempts}  wall ${time(row.wallMs)}  last run ${value(row.lastRunState)}`,
    ),
    'Attempts:',
    ...report.attempts.map(
      row =>
        `  ${row.taskId} #${value(row.number)} ${value(row.state)}: queue ${wait(row.waits.queue)}, delivery queue ${wait(row.waits.deliveryQueue)}, CI ${wait(row.waits.ci)}; failures ${failureCodes(row.failures)}`,
    ),
    ...gateLines(report.gates, totals.gates),
    `Blockers: ${report.blockers.length ? report.blockers.map(item => `${item.code}@${item.taskId ?? item.scope}`).join(', ') : 'none'}`,
    observations(report.provenance),
    caveat,
  ].join('\n');
}

// The view comes from the parsed arguments, never from a (possibly redacted) report value.
const human = (report, view) =>
  view === 'run' ? humanRun(report) : view === 'project' ? humanProject(report) : `Report: ${report.code}`;

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
 *   removeDirectory?: (directory: string, options: { recursive: boolean, force: boolean }) => void,
 *   createDirectory?: (root: string) => Promise<string> }} [ports]
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
      createDirectory: ports.createDirectory,
    });
    report = redactValues(report, secrets, security.redact);
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
  const view = exitCode !== 0 ? 'error' : options?.projectId ? 'project' : 'run';
  return { report, exitCode, output: json ? JSON.stringify(report, null, 2) : human(report, view) };
}
