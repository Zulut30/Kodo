/** Read-only operational report of a Run and of a Project, built only from
 * state Kodo already saves: Run receipts (session attempts, coordinator
 * operations, checks, blocker, watchdog), Run events and durable job receipts.
 * Pure: no clock, file, database, network or provider access; the caller
 * passes `now` and the rows it read.
 *
 * Unknown stays null and is never 0. A failed or unfinished observation stays
 * in the denominator (`known` of `total`). Prompt bytes are local UTF-8 sizes,
 * not tokens. Elapsed time includes process, tool and queue time and is not
 * pure LLM latency. Observations from different platforms are listed, never
 * ranked against each other. See docs/OBSERVABILITY.md.
 */
import { aggregateMetrics } from './metrics.mjs';
import { DELIVERY_OPERATIONS, OPERATION_EVENT } from './delivery-operations.mjs';

export const REPORT_SCHEMA_VERSION = 1;
export const REPORT_STAGES = Object.freeze([
  'assessment',
  'analysis',
  'planning',
  'implementation',
  'verification',
  'review',
  'delivery',
  'release',
]);
/** Session stage (Engine `session()`: task role, `plan`, `review`, `repair`) to report stage. */
const sessionStages = {
  plan: 'planning',
  developer: 'implementation',
  tester: 'implementation',
  documenter: 'implementation',
  repair: 'verification',
  review: 'review',
};
/** Coordinator operation kinds (Engine `logical()`) to report stage. */
const operationStages = {
  assessment: 'assessment',
  analysis: 'analysis',
  research: 'analysis',
  discovery: 'analysis',
  routing: 'analysis',
};
/** States whose Engine stop logs an event of the same type. */
const terminalStates = new Set(['succeeded', 'blocked', 'cancelled', 'waiting_limits']);
const failureStates = new Set(['blocked', 'cancelled', 'waiting_limits']);
const waitingJobStates = new Set(['queued', 'blocked']);
const pendingTaskStates = ['proposed', 'ready', 'reserved', 'running', 'verifying'];
const LIMITATIONS = Object.freeze([
  'prompt_bytes_are_not_tokens',
  'elapsed_is_not_llm_latency',
  'cross_platform_not_comparable',
  'native_request_count_unavailable',
]);
const MAX_FAILURES = 200;
const deliveryOutcomes = new Set(['confirmed', 'reconciled', 'absent']);
/** `normalizeUsage` and `aggregateMetrics` vocabulary (metrics.mjs). Anything else is unknown: null. */
const usageSemantics = new Set([
  'input-includes-cached',
  'cache-read-and-write-separate-from-input',
  'unknown',
  'mixed',
]);

const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const list = value => (Array.isArray(value) ? value : []);
const duration = value => (typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null);
const integer = value => (Number.isSafeInteger(value) && value >= 0 ? value : null);
/** Fixed vocabulary only: codes, stages, ids. Free text never crosses the report boundary. */
const code = (value, fallback = 'error') =>
  typeof value === 'string' && /^[A-Za-z][\w.:-]{0,63}$/.test(value) ? value : fallback;
const slug = value => (typeof value === 'string' && /^[A-Za-z0-9][\w.-]{0,63}$/.test(value) ? value : 'unknown');
const token = value => (typeof value === 'string' && /^[\w.:+/@-]{1,128}$/.test(value) ? value : null);

function millis(value) {
  const parsed = typeof value === 'number' ? value : typeof value === 'string' ? Date.parse(value) : NaN;
  return Number.isFinite(parsed) && Math.abs(parsed) <= 8.64e15 ? parsed : null;
}
const iso = value => {
  const parsed = millis(value);
  return parsed === null ? null : new Date(parsed).toISOString();
};
const interval = (start, end) => (start !== null && end !== null && end >= start ? end - start : null);

/** Sum of samples: null unless every sample is known, the rule of `aggregateMetrics`. */
function total(samples) {
  const known = samples.filter(value => value !== null);
  return {
    value: samples.length > 0 && known.length === samples.length ? known.reduce((sum, value) => sum + value, 0) : null,
    known: known.length,
    total: samples.length,
  };
}
/** Sum of the known samples only: a measured part, never a total. Null when none is known. */
function measured(samples) {
  const known = samples.filter(value => value !== null);
  return known.length ? known.reduce((sum, value) => sum + value, 0) : null;
}

/** `aggregateMetrics` with its `semantics` string limited to the known vocabulary. */
function usageOf(sessions) {
  const result = aggregateMetrics(sessions);
  if (!usageSemantics.has(result.usage.semantics)) result.usage.semantics = null;
  return result;
}

/**
 * The Engine stores each delivery event, then a `delivery` or `release` copy of
 * it whose `data.type` names the original. A copy is not a new observation: it
 * would close every wait it follows.
 */
const mirrored = event =>
  (event.type === 'delivery' || event.type === 'release') && typeof event.data?.type === 'string';

function ordered(events) {
  return list(events)
    .filter(record)
    .map((event, index) => ({ event, index }))
    .sort((a, b) => (integer(a.event.seq) ?? a.index) - (integer(b.event.seq) ?? b.index))
    .map(item => item.event)
    .filter(event => !mirrored(event));
}

/**
 * Every attempt of a remote delivery effect: each journal intent starts one,
 * the next read-back of the same operation closes it. `absent` is a failed
 * attempt; an intent without a read-back (superseded by a retry or still open)
 * stays `uncertain` with an unknown duration. A read-back without an open
 * intent (a later reconciliation) changes no attempt.
 */
function deliveryAttempts(events) {
  const rows = [],
    open = new Map();
  for (const event of events) {
    const operation = event.data?.operation;
    if (event.type !== OPERATION_EVENT || !DELIVERY_OPERATIONS.includes(operation)) continue;
    if (event.data.phase === 'intent') {
      const row = { operation, status: 'uncertain', intentAt: millis(event.time), outcomeAt: null };
      rows.push(row);
      open.set(operation, row);
    } else if (event.data.phase === 'outcome' && deliveryOutcomes.has(event.data.status) && open.has(operation)) {
      Object.assign(open.get(operation), { status: event.data.status, outcomeAt: millis(event.time) });
      open.delete(operation);
    }
  }
  return rows;
}

/**
 * Check executions, one per `check_started`. Only the last round keeps its result
 * rows (`checks.results`, in execution order). A check of an earlier round was
 * closed (a later round started), but its receipt was replaced: its duration is
 * unknown. A started check of the last round without a result row is unclosed:
 * still running, or stopped before its receipt (for example `dirty_worktree`).
 */
function checkExecutions(run, events) {
  const rows = list(run.checks?.results).filter(record);
  const rounds = [];
  let streak = false,
    closed = false;
  for (const event of events) {
    if (event.type === 'check_started') {
      if (!streak) rounds.push([]);
      rounds.at(-1).push(event);
      closed = false;
    } else if (event.type === 'repair_required' && rounds.length) closed = true;
    streak = event.type === 'check_started';
  }
  // After repair_required the round has ended and Engine resets the receipt on the
  // repair commit: its checks without a row are closed with an unknown duration.
  const last = rounds.at(-1) ?? [];
  const unclosed = closed ? [] : last.slice(rows.length);
  const reset = closed ? last.slice(rows.length) : [];
  const samples = [
    ...rounds
      .slice(0, -1)
      .flat()
      .map(() => null),
    ...rows.map(row => duration(row.durationMs)),
    ...reset.map(() => null),
    ...unclosed.map(() => null),
  ];
  return { rows, unclosed, samples };
}

function stageTimings(run, deliveries, sessions, executions) {
  const historyIncomplete = run.metrics?.historyComplete === false;
  const operations = Array.isArray(run.coordinatorOperations) ? run.coordinatorOperations : null;
  const stages = Object.fromEntries(
    REPORT_STAGES.map(stage => [stage, { samples: [], sessions: sessions ? 0 : null, operations: 0, sources: [] }]),
  );
  if (!operations) stages.assessment.operations = stages.analysis.operations = null;
  const add = (stage, sample, source, kind) => {
    stage.samples.push(sample);
    if (!stage.sources.includes(source)) stage.sources.push(source);
    if (kind) stage[kind]++;
  };
  let unmapped = 0;
  for (const attempt of sessions || []) {
    const stage = stages[sessionStages[attempt?.stage]];
    if (stage) add(stage, duration(attempt.metrics?.durationMs), 'session-attempts', 'sessions');
    else unmapped++;
  }
  // A Run continued without its earlier sessions: every session stage may miss some. Its
  // total and session count are unknown; what was saved stays in `measuredMs`.
  if (historyIncomplete)
    for (const name of new Set(Object.values(sessionStages))) {
      stages[name].samples.push(null);
      stages[name].sessions = null;
    }
  let openOperations = 0;
  for (const operation of operations || []) {
    const stage = stages[operationStages[operation?.kind]];
    const sample = duration(operation?.durationMs);
    if (sample === null) openOperations++; // Started and unfinished, or saved without a duration.
    if (stage) add(stage, sample, 'coordinator-operations', 'operations');
  }
  for (const sample of executions.samples) add(stages.verification, sample, 'check-executions', null);
  // Remote delivery effects only: intent to read-back. Local preparation and CI waits are reported elsewhere.
  for (const item of deliveries)
    add(
      stages[item.operation === 'release' ? 'release' : 'delivery'],
      interval(item.intentAt, item.outcomeAt),
      'delivery-operation-journal',
      'operations',
    );
  const result = {};
  for (const [name, stage] of Object.entries(stages)) {
    const sum = total(stage.samples);
    result[name] = {
      durationMs: sum.value,
      // The saved part when the total is unknown; never part of a total.
      measuredMs: sum.value === null ? measured(stage.samples) : null,
      sessions: stage.sessions,
      operations: stage.operations,
      known: sum.known,
      total: sum.total,
      source: stage.sources.join('+') || null,
    };
  }
  return { stages: result, unmapped, openOperations };
}

/** Time each job spent queued or blocked before it left that state, from job state receipts. */
function jobWaits(jobEvents) {
  const jobs = new Map();
  for (const row of list(jobEvents)) {
    if (!record(row) || typeof row.jobId !== 'string') continue;
    if (!jobs.has(row.jobId)) jobs.set(row.jobId, []);
    jobs.get(row.jobId).push(row);
  }
  const samples = [];
  for (const rows of jobs.values()) {
    let since; // undefined: not waiting; null: waiting since an unknown time.
    for (const row of ordered(rows)) {
      const waiting = waitingJobStates.has(row.data?.state),
        at = millis(row.time);
      if (waiting && since === undefined) since = at;
      else if (!waiting && since !== undefined) {
        samples.push(interval(since, at));
        since = undefined;
      }
    }
    if (since !== undefined) samples.push(null); // Still waiting: the wait is open.
  }
  const sum = total(samples);
  return {
    jobs: jobs.size,
    waitMs: sum.value,
    measuredMs: measured(samples),
    known: sum.known,
    total: sum.total,
    source: jobs.size ? 'job-events' : null,
  };
}

/**
 * Waits seen only as pending polls: `delivery.checks_waiting` (awaitChecks) and
 * `delivery.queue_waiting` (queue lease). A streak of polls (of one queue) is one
 * wait. Kodo saves the polls that saw a pending state, but not the poll that saw
 * the final one (checks ready or failed, lease acquired): no wait has an explicit
 * end, so `waitMs` stays null. `measuredMs` is the time from the first to the last
 * saved poll of each streak: a measured part, never a total.
 * @param {any[]} events
 * @param {string} type
 * @param {(event: any) => string | null} [group] Streaks of different groups are different waits.
 */
function pollWindows(events, type, group = () => null) {
  const spans = [];
  let polls = 0,
    current = null;
  for (const event of events) {
    if (event.type !== type) {
      current = null;
      continue;
    }
    polls++;
    const key = group(event),
      at = millis(event.time);
    if (current?.key === key) current.last = at;
    else spans.push((current = { key, first: at, last: at }));
  }
  return {
    waitMs: null,
    measuredMs: measured(spans.map(span => interval(span.first, span.last))),
    polls,
    known: 0,
    total: spans.length,
    source: polls ? 'delivery-events' : null,
  };
}

const separator = /[\\/]/;
/** The first token of a legacy command string; null when quoting or spacing make it ambiguous. */
function programToken(command) {
  const text = command.trim();
  if (text[0] === '"' || text[0] === "'") {
    const end = text.indexOf(text[0], 1);
    // Unclosed, or glued to more text: where the program ends is unknown.
    if (end < 0 || (end + 1 < text.length && !/\s/.test(text[end + 1]))) return null;
    return text.slice(1, end);
  }
  const [first, ...rest] = text.split(/\s+/);
  if (/["']/.test(first)) return null;
  // Unquoted text with both a space and a path separator may hold one path with spaces
  // (`C:\Customer Label.exe`, `Customer Files/tools/lint.cmd --fix`): never guessed.
  if (rest.length && separator.test(text)) return null;
  return first;
}

/** The executable's base name with its extension: directories and arguments can hold paths and secrets. */
function executable(command) {
  const program = typeof command === 'string' ? programToken(command) : command?.command;
  if (typeof program !== 'string') return null;
  const name = program.split(separator).pop();
  return /^[A-Za-z0-9][\w.-]{0,63}$/.test(name) ? name : null;
}

function checks(events, executions) {
  const runs = executions.rows.map(row => ({
    kind: slug(row.kind),
    executable: executable(row.command),
    durationMs: duration(row.durationMs),
    exitCode: Number.isSafeInteger(row.exitCode) ? row.exitCode : null,
  }));
  const sum = total(executions.samples);
  return {
    runs,
    totalMs: sum.value,
    known: sum.known,
    total: sum.total,
    executions: events.filter(event => event.type === 'check_started').length,
    unclosed: executions.unclosed.length,
    reused: events.filter(event => event.type === 'checks_reused').length,
    ci: pollWindows(events, 'delivery.checks_waiting'),
    source: runs.length ? 'run.checks' : null,
  };
}

/** A verification round runs its checks in one uninterrupted streak, or reuses them. */
function verificationRounds(events) {
  let rounds = 0,
    streak = false;
  for (const event of events) {
    if (event.type === 'check_started') {
      if (!streak) rounds++;
      streak = true;
    } else {
      streak = false;
      if (event.type === 'checks_reused') rounds++;
    }
  }
  return rounds;
}

function attempts(run, events, sessions) {
  const nodes = record(run.nodes) ? Object.values(run.nodes).map(node => integer(node?.attempt)) : null;
  // A Run continued without its earlier sessions: the saved ones are only a part.
  const all = run.metrics?.historyComplete === false ? null : sessions;
  return {
    sessions: all ? all.length : null,
    failedSessions: all ? all.filter(item => item?.status === 'failed').length : null,
    // Started and not finished: in flight, or interrupted before its receipt.
    pendingSessions: all ? all.filter(item => item?.status === 'started').length : null,
    observedSessions: sessions ? sessions.length : null,
    nodeAttempts: nodes ? (total(nodes).value ?? (nodes.length ? null : 0)) : null,
    verificationRounds: verificationRounds(events),
    repairRounds: events.filter(event => event.type === 'repair_required').length,
  };
}

function failures(run, events, sessions, deliveries) {
  const rows = [];
  for (const event of events) {
    const at = iso(event.time);
    if (event.type === 'node_failed') rows.push({ code: 'node_failed', scope: `node:${slug(event.data?.node)}`, at });
    // A failed verification round (checks, gates or review) whose results a later round replaced.
    // Its saved problem is free text: only the event's own type is reported.
    else if (event.type === 'repair_required') rows.push({ code: 'repair_required', scope: 'verification', at });
    else if (event.type === 'delivery.command_failed')
      rows.push({ code: code(event.data?.code, 'command_failed'), scope: 'delivery', at });
    else if (failureStates.has(event.type)) rows.push({ code: code(event.data?.code, event.type), scope: 'run', at });
  }
  for (const attempt of sessions || [])
    if (attempt?.status === 'failed')
      rows.push({ code: code(attempt.errorCode), scope: `session:${slug(attempt.stage)}`, at: null });
  for (const row of list(run.checks?.results))
    if (record(row) && row.exitCode !== 0)
      rows.push({ code: code(row.reason, 'check_failed'), scope: `check:${slug(row.kind)}`, at: null });
  for (const item of deliveries)
    if (item.status === 'absent')
      rows.push({ code: 'delivery_absent', scope: `delivery:${item.operation}`, at: iso(item.outcomeAt) });
    else if (item.status === 'uncertain')
      rows.push({ code: 'delivery_uncertain', scope: `delivery:${item.operation}`, at: iso(item.intentAt) });
  return { rows: rows.slice(0, MAX_FAILURES), truncated: rows.length > MAX_FAILURES };
}

function blocker(run) {
  const current = run.blocker?.current;
  if (!record(current)) return null;
  return {
    code: code(current.code),
    scope: code(current.scope, 'unknown'),
    firstSeen: iso(current.firstSeen),
    lastSeen: iso(current.lastSeen),
    occurrences: integer(current.occurrences),
    resolved: list(run.blocker.history).length,
  };
}

function watchdog(run) {
  const state = run.watchdog;
  if (!record(state)) return null;
  const rounds = list(state.rounds);
  return {
    stalled: integer(state.stalled),
    rounds: rounds.length,
    progressedRounds: rounds.filter(round => round?.progressed === true).length,
    stopped: record(state.stopped) ? { reason: code(state.stopped.reason), limit: integer(state.stopped.limit) } : null,
  };
}

function models(sessions) {
  if (!sessions) return null;
  const counts = new Map();
  for (const attempt of sessions) {
    const key = JSON.stringify([token(attempt?.client), token(attempt?.model)]);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts]
    .map(([key, count]) => {
      const [client, model] = JSON.parse(key);
      return { client, model, sessions: count };
    })
    .sort((a, b) => String(a.client).localeCompare(String(b.client)) || String(a.model).localeCompare(String(b.model)));
}

/** Platforms are recorded only by a release smoke receipt. Listed, never compared. */
function platforms(runs) {
  const seen = new Map();
  for (const run of runs) {
    const smoke = run?.release?.smoke;
    if (!record(smoke) || !token(smoke.platform)) continue;
    const item = { platform: token(smoke.platform), node: token(smoke.node), source: 'release.smoke' };
    seen.set(JSON.stringify(item), item);
  }
  if (!seen.size) return null;
  return [...seen.values()].sort(
    (a, b) => a.platform.localeCompare(b.platform) || String(a.node).localeCompare(String(b.node)),
  );
}

function timing(run, events, stages) {
  const created = millis(run.createdAt) ?? millis(events.find(event => event.type === 'created')?.time);
  let finished = null;
  if (terminalStates.has(run.state))
    for (const event of events) if (event.type === run.state) finished = millis(event.time) ?? finished;
  return { createdAt: iso(created), finishedAt: iso(finished), wallMs: interval(created, finished), stages };
}

function runNotes(run, report, { sessions, unmapped, openOperations, truncated }) {
  const notes = [];
  const add = (condition, note) => condition && notes.push(note);
  add(!terminalStates.has(run.state), 'run_not_finished');
  add(terminalStates.has(run.state) && report.timing.wallMs === null, 'wall_time_unknown');
  add(!sessions, 'session_attempts_missing');
  add(!Array.isArray(run.coordinatorOperations), 'coordinator_operations_missing');
  add(openOperations > 0, 'coordinator_operation_incomplete');
  add(run.metrics?.historyComplete === false, 'history_incomplete');
  const observed = sessions?.length > 0,
    completeness = report.observedUsage.completeness;
  add(observed && !completeness.durationMs.complete, 'session_duration_incomplete');
  add(observed && !completeness.usage.totalTokens.complete, 'token_usage_incomplete');
  add(observed && !completeness.promptBytes.complete, 'prompt_bytes_incomplete');
  add(unmapped > 0, 'unmapped_session_stage');
  add(report.checks.unclosed > 0, 'check_unclosed');
  add(report.queue.known < report.queue.total, 'queue_wait_open');
  add(report.queue.delivery.known < report.queue.delivery.total, 'delivery_queue_wait_open');
  add(report.checks.ci.known < report.checks.ci.total, 'ci_wait_open');
  const { delivery, release } = report.timing.stages;
  add(delivery.known < delivery.total || release.known < release.total, 'delivery_operation_open');
  add(truncated, 'failures_truncated');
  return notes;
}

function runLimitations(report) {
  const limitations = [...LIMITATIONS];
  if (report.checks.known < report.checks.total) limitations.push('check_duration_not_recorded');
  if (report.provenance.platforms === null) limitations.push('platform_not_recorded');
  return limitations;
}

/**
 * Operational report of one saved Run.
 * @param {any} run Saved Run body.
 * @param {any[]} events Saved Run events `{ seq, type, data, time }` (time in ms).
 * @param {{ jobEvents?: any[], now?: number }} [options] `jobEvents`: `{ jobId, seq, type, data: { state }, time }`.
 */
export function buildRunReport(run, events, { jobEvents = [], now = null } = {}) {
  if (!record(run)) throw new TypeError('Run report requires a saved run object');
  const sorted = ordered(events);
  const sessions = Array.isArray(run.sessionAttempts) ? run.sessionAttempts : null;
  const deliveries = deliveryAttempts(sorted);
  const executions = checkExecutions(run, sorted);
  const { stages, unmapped, openOperations } = stageTimings(run, deliveries, sessions, executions);
  /** @type {any} The byte fields are spread from a computed object. */
  const observedUsage = usageOf(sessions || []);
  if (!sessions) observedUsage.sessions = null;
  // A Run continued from an older one (`historyComplete: false`) lacks the earlier sessions: no total.
  const usage = run.metrics?.historyComplete === false ? null : observedUsage;
  const failed = failures(run, sorted, sessions, deliveries);
  const report = {
    schemaVersion: REPORT_SCHEMA_VERSION,
    kind: 'run',
    runId: typeof run.id === 'string' ? run.id : null,
    state: code(run.state, 'unknown'),
    mode: token(run.executionMode?.selected),
    client: token(run.client),
    models: models(sessions),
    timing: timing(run, sorted, stages),
    queue: {
      ...jobWaits(jobEvents),
      // Grouped by queue name (never reported): the merge and the release lease are separate waits.
      delivery: pollWindows(sorted, 'delivery.queue_waiting', event =>
        typeof event.data?.queue === 'string' ? event.data.queue : null,
      ),
    },
    checks: checks(sorted, executions),
    attempts: attempts(run, sorted, sessions),
    usage,
    observedUsage,
    context: { originalBytes: usage?.contextOriginalBytes ?? null, sentBytes: usage?.contextSentBytes ?? null },
    failures: failed.rows,
    blocker: blocker(run),
    watchdog: watchdog(run),
    provenance: {
      source: 'kodo-state',
      generatedAt: iso(now),
      platforms: platforms([run]),
      complete: false,
      notes: [],
      limitations: [],
    },
  };
  report.provenance.notes = runNotes(run, report, {
    sessions,
    unmapped,
    openOperations,
    truncated: failed.truncated,
  });
  report.provenance.complete = report.provenance.notes.length === 0;
  report.provenance.limitations = runLimitations(report);
  return report;
}

function countBy(rows) {
  const counts = {};
  for (const row of list(rows)) {
    const status = code(row?.status, 'unknown');
    counts[status] = (counts[status] ?? 0) + 1;
  }
  return counts;
}

const lookup = (source, id) =>
  source instanceof Map ? source.get(id) : record(source) && Object.hasOwn(source, id) ? source[id] : undefined;

/** Sum of known values; null when there is nothing to sum or any value is unknown. */
const known = values => (values.length ? total(values).value : null);

const waitOf = window => ({
  waitMs: window.waitMs,
  measuredMs: window.measuredMs,
  known: window.known,
  total: window.total,
});
const waitKinds = Object.freeze({
  queue: report => report.queue,
  deliveryQueue: report => report.queue.delivery,
  ci: report => report.checks.ci,
});

/** One attempt with its own Run: waits and failure codes stay visible after a retry succeeded. */
function attemptRow(item, report) {
  return {
    taskId: slug(item.taskId),
    number: integer(item.number),
    runId: token(item.runId),
    state: report?.state ?? null,
    wallMs: report?.timing.wallMs ?? null,
    // Without a saved Run neither the waits nor how many there were are known.
    waits: Object.fromEntries(
      Object.entries(waitKinds).map(([key, pick]) => [
        key,
        report ? waitOf(pick(report)) : { waitMs: null, measuredMs: null, known: 0, total: null },
      ]),
    ),
    failures: report ? report.failures : null,
  };
}

/**
 * Waits summed over every attempt. Complete only when each attempt has a Run and
 * a known wait: an attempt without observations (`waitMs: null`) is unknown, not
 * 0. What was measured anyway is summed apart in `measuredMs`, never in `waitMs`.
 */
function waitTotals(reports, expected = reports.length) {
  return Object.fromEntries(
    Object.entries(waitKinds).map(([key, pick]) => {
      const found = reports.filter(Boolean).map(pick);
      // An attempt number without a saved row (a gap) is as unknown as a row without a Run.
      const all = found.length === reports.length && reports.length >= expected;
      const complete = all && found.every(wait => wait.waitMs !== null);
      return [
        key,
        {
          waitMs: complete ? known(found.map(wait => wait.waitMs)) : null,
          measuredMs: measured(found.map(wait => wait.measuredMs)),
          known: found.reduce((sum, wait) => sum + wait.known, 0),
          total: all ? found.reduce((sum, wait) => sum + wait.total, 0) : null,
          complete,
        },
      ];
    }),
  );
}

function taskRow(task, own, current, reportOf) {
  const runs = own.map(attempt => reportOf(attempt.runId));
  const numbers = own.map(attempt => integer(attempt.number) ?? 0);
  // The highest number seen in the history or the current pointer: either may be the one left.
  const count = Math.max(integer(current?.number) ?? 0, ...numbers, own.length);
  // A reserved attempt without a saved Run, or an attempt absent from the rows (any gap in
  // 1..count), is unknown.
  const missing =
    runs.some(report => report === null) || count > own.length || numbers.some((number, index) => number !== index + 1);
  const sum = pick => (missing ? null : known(runs.map(pick)));
  return {
    row: {
      id: slug(task.id),
      epicId: typeof task.epicId === 'string' ? slug(task.epicId) : null,
      status: code(task.status, 'unknown'),
      attempts: count,
      sessions: missing ? null : runs.length ? total(runs.map(report => report.attempts.sessions)).value : 0,
      wallMs: sum(report => report.timing.wallMs),
      implementationMs: sum(report => report.timing.stages.implementation.durationMs),
      verificationMs: sum(report => report.timing.stages.verification.durationMs),
      lastRunState: runs.at(-1)?.state ?? null,
    },
    last: runs.at(-1) ?? null,
    attempts: own.map((attempt, index) => ({ row: attemptRow(attempt, runs[index]), report: runs[index] })),
  };
}

function projectBlockers(snapshot, rows) {
  const blockers = [];
  if (snapshot.project.paused === true)
    blockers.push({ taskId: null, runId: null, code: 'project_paused', scope: 'project', occurrences: null });
  for (const { row, last } of rows) {
    if (last?.blocker)
      blockers.push({
        taskId: row.id,
        runId: last.runId,
        code: last.blocker.code,
        scope: last.blocker.scope,
        occurrences: last.blocker.occurrences,
      });
    else if (row.status === 'blocked')
      blockers.push({ taskId: row.id, runId: null, code: 'task_blocked', scope: 'task', occurrences: null });
  }
  return blockers;
}

function projectTotals(rows, runs, attemptReports) {
  const count = statuses => rows.filter(row => statuses.includes(row.status)).length;
  const tried = rows.filter(row => row.attempts > 0);
  const wallMs = known(tried.map(row => row.wallMs));
  const verificationMs = known(tried.map(row => row.verificationMs));
  return {
    tasks: rows.length,
    accepted: count(['accepted', 'released']),
    integrated: count(['integrated']),
    failed: count(['failed']),
    blocked: count(['blocked']),
    cancelled: count(['cancelled']),
    pending: count(pendingTaskStates),
    attempts: rows.reduce((sum, row) => sum + row.attempts, 0),
    sessions: total(rows.map(row => row.sessions)).value ?? (rows.length ? null : 0),
    wallMs,
    // Verification time over wall time, both summed over attempted tasks; unknown when either is.
    verificationShare: wallMs && verificationMs !== null ? Math.round((verificationMs / wallMs) * 10000) / 10000 : null,
    usage: null,
    // Sum over the sessions of the Runs that were found; complete only when `usage` is not null.
    observedUsage: usageOf(runs.flatMap(run => list(run.sessionAttempts))),
    waits: waitTotals(
      attemptReports,
      rows.reduce((sum, row) => sum + row.attempts, 0),
    ),
  };
}

function snapshotCompleteness(snapshot) {
  const result = {};
  for (const [key, value] of Object.entries(record(snapshot.completeness) ? snapshot.completeness : {}))
    if (record(value))
      result[slug(key)] = {
        total: integer(value.total),
        returned: integer(value.returned),
        complete: value.complete === true,
      };
  return result;
}

/**
 * Operational report of a Project from its validated snapshot and the Runs of its attempts.
 * @param {any} snapshot Project snapshot (`repo.snapshot`).
 * @param {Map<string, any> | Record<string, any>} runsById Saved Runs by id.
 * @param {Map<string, any[]> | Record<string, any[]>} eventsByRun Saved Run events by Run id.
 * @param {{ now?: number, attempts?: any[], jobEvents?: Map<string, any[]> | Record<string, any[]> }} [options]
 *   `attempts`: every attempt `{ taskId, number, runId }` of the Project; defaults to the snapshot's
 *   current attempts. `jobEvents`: durable job receipts by Run id (see `buildRunReport`).
 */
export function buildProjectReport(
  snapshot,
  runsById,
  eventsByRun,
  { now = null, attempts = undefined, jobEvents = {} } = {},
) {
  if (!record(snapshot) || !record(snapshot.project)) throw new TypeError('Project report requires a snapshot');
  const current = new Map(
    list(snapshot.currentAttempts)
      .filter(record)
      .map(item => [item.taskId, item]),
  );
  const all = (Array.isArray(attempts) ? attempts : [...current.values()]).filter(record);
  const reports = new Map();
  const reportOf = runId => {
    if (!reports.has(runId)) {
      const run = typeof runId === 'string' ? lookup(runsById, runId) : undefined;
      reports.set(
        runId,
        record(run)
          ? buildRunReport(run, list(lookup(eventsByRun, runId)), { now, jobEvents: list(lookup(jobEvents, runId)) })
          : null,
      );
    }
    return reports.get(runId);
  };
  const rows = list(snapshot.tasks)
    .filter(record)
    .map(task =>
      taskRow(
        task,
        all.filter(item => item.taskId === task.id).sort((a, b) => (integer(a.number) ?? 0) - (integer(b.number) ?? 0)),
        current.get(task.id),
        reportOf,
      ),
    );
  const found = [...reports.values()].filter(Boolean);
  const runs = [...reports.keys()].map(id => lookup(runsById, id)).filter(record);
  const attemptRows = rows.flatMap(item => item.attempts);
  const totals = projectTotals(
    rows.map(item => item.row),
    runs,
    attemptRows.map(item => item.report),
  );
  // A total over an incomplete attempt history (a missing Run, an unknown session count, or a Run
  // continued from an older one without its earlier sessions) is unknown.
  if (totals.sessions !== null && found.every(report => report.usage !== null)) totals.usage = totals.observedUsage;
  const attemptsTotal = totals.attempts;
  const completeness = {
    ...snapshotCompleteness(snapshot),
    runs: { known: found.length, total: attemptsTotal, complete: found.length === attemptsTotal },
  };
  const seenPlatforms = platforms(runs);
  const notes = new Set();
  if (!completeness.runs.complete) notes.add('runs_missing');
  if (Object.entries(completeness).some(([key, value]) => key !== 'runs' && !value.complete))
    notes.add('snapshot_incomplete');
  if (seenPlatforms && seenPlatforms.length > 1) notes.add('mixed_platforms');
  if (attemptsTotal > 0 && totals.wallMs === null) notes.add('wall_time_unknown');
  for (const report of found) for (const note of report.provenance.notes) notes.add(note);
  const limitations = new Set(LIMITATIONS);
  for (const report of found) for (const item of report.provenance.limitations) limitations.add(item);
  if (!seenPlatforms) limitations.add('platform_not_recorded');
  return {
    schemaVersion: REPORT_SCHEMA_VERSION,
    kind: 'project',
    projectId: typeof snapshot.project.projectId === 'string' ? snapshot.project.projectId : null,
    status: code(snapshot.project.status, 'unknown'),
    revision: integer(snapshot.revision),
    progress: {
      milestones: countBy(snapshot.milestones),
      epics: countBy(snapshot.epics),
      tasks: countBy(snapshot.tasks),
    },
    tasks: rows.map(item => item.row),
    attempts: attemptRows.map(item => item.row),
    totals,
    ...(Object.hasOwn(snapshot, 'gates')
      ? {
          gates: list(snapshot.gates)
            .filter(record)
            .map(gate => ({ id: slug(gate.id), status: code(gate.status, 'unknown') })),
        }
      : {}),
    blockers: projectBlockers(snapshot, rows),
    completeness,
    provenance: {
      source: 'kodo-state',
      generatedAt: iso(now),
      platforms: seenPlatforms,
      complete: notes.size === 0,
      notes: [...notes],
      limitations: [...limitations],
    },
  };
}
