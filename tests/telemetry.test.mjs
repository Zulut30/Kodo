import test from 'node:test';
import assert from 'node:assert/strict';
import { buildRunReport, buildProjectReport } from '../runtime/telemetry.mjs';

const T0 = Date.parse('2026-11-01T10:00:00.000Z');
const NOW = T0 + 3_600_000;
const iso = ms => new Date(ms).toISOString();
const usage = (input, output) => ({
  inputTokens: input,
  cachedInputTokens: 0,
  outputTokens: output,
  cacheReadTokens: null,
  cacheWriteTokens: null,
  totalTokens: input + output,
  semantics: 'input-includes-cached',
  source: 'codex.usage',
});
const session = (stage, status, metrics, extra = {}) => ({
  stage,
  node: stage === 'developer' ? 'a' : null,
  client: 'codex',
  model: 'gpt-x',
  status,
  ...(metrics === undefined ? {} : { metrics }),
  ...extra,
});
const measured = (durationMs, value = usage(100, 20)) => ({
  durationMs,
  toolSteps: 2,
  promptBytes: 4000,
  contextOriginalBytes: 9000,
  contextSentBytes: 3000,
  nativeRequestCount: null,
  usage: value,
});
const event = (seq, type, time, data = {}) => ({ seq, run_id: 'run-1', type, data, time });
const deepFreeze = value => {
  if (value && typeof value === 'object') {
    for (const item of Object.values(value)) deepFreeze(item);
    Object.freeze(value);
  }
  return value;
};

function finishedRun(extra = {}) {
  return {
    id: 'run-1',
    state: 'succeeded',
    client: 'codex',
    createdAt: iso(T0),
    executionMode: { selected: 'standard' },
    config: { commands: { test: [{ command: 'npm', args: ['test'] }], build: [] } },
    nodes: { a: { status: 'integrated', attempt: 2 } },
    coordinatorOperations: [
      { kind: 'assessment', status: 'completed', durationMs: 300 },
      { kind: 'analysis', status: 'completed', durationMs: 700 },
    ],
    sessionAttempts: [
      session('plan', 'completed', measured(1000)),
      session('developer', 'completed', measured(5000)),
      session('review', 'completed', measured(2000)),
    ],
    checks: {
      schemaVersion: 2,
      complete: true,
      results: [{ kind: 'test', command: { command: 'npm', args: ['test'] }, exitCode: 0 }],
    },
    ...extra,
  };
}
const finishedEvents = () => [
  event(1, 'created', T0),
  event(2, 'check_started', T0 + 10_000, { kind: 'test', command: { command: 'npm', args: ['test'] } }),
  event(3, 'session', T0 + 11_000, { type: 'turn' }),
  event(4, 'succeeded', T0 + 60_000),
];

test('run report: wall time from the saved creation to the terminal event, stage sources named', () => {
  const run = deepFreeze(finishedRun()),
    events = deepFreeze(finishedEvents());
  const report = buildRunReport(run, events, { now: NOW });
  assert.equal(report.schemaVersion, 1);
  assert.equal(report.kind, 'run');
  assert.equal(report.runId, 'run-1');
  assert.equal(report.state, 'succeeded');
  assert.equal(report.mode, 'standard');
  assert.equal(report.client, 'codex');
  assert.deepEqual(report.models, [{ client: 'codex', model: 'gpt-x', sessions: 3 }]);
  assert.deepEqual(
    [report.timing.createdAt, report.timing.finishedAt, report.timing.wallMs],
    [iso(T0), iso(T0 + 60_000), 60_000],
  );
  const { stages } = report.timing;
  assert.deepEqual(Object.keys(stages), [
    'assessment',
    'analysis',
    'planning',
    'implementation',
    'verification',
    'review',
    'delivery',
    'release',
  ]);
  assert.deepEqual(
    [stages.assessment.durationMs, stages.assessment.sessions, stages.assessment.source],
    [300, 0, 'coordinator-operations'],
  );
  assert.deepEqual([stages.planning.durationMs, stages.planning.source], [1000, 'session-attempts']);
  assert.deepEqual([stages.implementation.durationMs, stages.implementation.sessions], [5000, 1]);
  assert.deepEqual([stages.review.durationMs, stages.review.sessions], [2000, 1]);
  // Check durations are not saved by the Engine: verification stays unknown, never 0.
  assert.equal(stages.verification.durationMs, null);
  assert.match(stages.verification.source, /check-results/);
  assert.equal(report.generatedAt, undefined);
  assert.equal(report.provenance.source, 'kodo-state');
  assert.equal(report.provenance.generatedAt, iso(NOW));
  assert.equal(report.provenance.complete, true, JSON.stringify(report.provenance.notes));
  assert.ok(report.provenance.limitations.includes('prompt_bytes_are_not_tokens'));
  assert.ok(report.provenance.limitations.includes('elapsed_is_not_llm_latency'));
  assert.ok(report.provenance.limitations.includes('check_duration_not_recorded'));
  assert.deepEqual(report.checks.runs, [{ kind: 'test', command: 'npm test', durationMs: null, exitCode: 0 }]);
  assert.equal(report.checks.totalMs, null);
  assert.deepEqual(report.attempts, {
    sessions: 3,
    failedSessions: 0,
    pendingSessions: 0,
    nodeAttempts: 2,
    verificationRounds: 1,
    repairRounds: 0,
  });
  assert.equal(report.usage.usage.totalTokens, 360);
  assert.deepEqual(report.context, { originalBytes: 27000, sentBytes: 9000 });
});

test('stage without data is null; delivery and release use the operation journal', () => {
  const run = finishedRun({ coordinatorOperations: [] });
  const events = [
    event(1, 'created', T0),
    event(2, 'delivery.operation', T0 + 1000, { operation: 'pr', phase: 'intent' }),
    event(3, 'delivery.operation', T0 + 1500, { operation: 'pr', phase: 'outcome', status: 'confirmed' }),
    event(4, 'delivery.operation', T0 + 2000, { operation: 'merge', phase: 'intent' }),
    event(5, 'succeeded', T0 + 9000),
  ];
  const { stages } = buildRunReport(run, events, { now: NOW }).timing;
  assert.deepEqual(stages.assessment, {
    durationMs: null,
    sessions: 0,
    operations: 0,
    known: 0,
    total: 0,
    source: null,
  });
  assert.deepEqual(stages.release, { durationMs: null, sessions: 0, operations: 0, known: 0, total: 0, source: null });
  // The merge intent has no read-back: its duration is unknown, so the stage total is unknown.
  assert.deepEqual(
    [stages.delivery.durationMs, stages.delivery.operations, stages.delivery.known, stages.delivery.source],
    [null, 2, 1, 'delivery-operation-journal'],
  );
  const failures = buildRunReport(run, events, { now: NOW }).failures;
  assert.ok(failures.some(item => item.code === 'delivery_uncertain' && item.scope === 'delivery:merge'));
});

test('mixed historical and null usage stays unknown; failed and pending sessions count in the denominator', () => {
  const run = finishedRun({
    state: 'implementing',
    sessionAttempts: [
      session('plan', 'completed', measured(1000)),
      // Historical session saved before metrics existed.
      session('developer', 'completed', undefined),
      session(
        'developer',
        'failed',
        { ...measured(1200), usage: { totalTokens: null, semantics: 'unknown' } },
        {
          errorCode: 'timeout',
        },
      ),
      // Started and never finished: in flight or interrupted.
      session('developer', 'started', { ...measured(null), usage: { totalTokens: null, semantics: 'unknown' } }),
    ],
  });
  const report = buildRunReport(run, [event(1, 'created', T0)], { now: NOW });
  assert.equal(report.timing.finishedAt, null);
  assert.equal(report.timing.wallMs, null);
  assert.deepEqual(
    [report.attempts.sessions, report.attempts.failedSessions, report.attempts.pendingSessions],
    [4, 1, 1],
  );
  assert.equal(report.usage.sessions, 4);
  assert.equal(report.usage.durationMs, null);
  assert.equal(report.usage.usage.totalTokens, null);
  assert.deepEqual(report.usage.completeness.usage.totalTokens, { known: 1, total: 4, complete: false });
  assert.deepEqual(report.usage.completeness.durationMs, { known: 2, total: 4, complete: false });
  assert.equal(report.usage.promptBytes, null);
  assert.deepEqual(report.context, { originalBytes: null, sentBytes: null });
  const implementation = report.timing.stages.implementation;
  assert.deepEqual([implementation.durationMs, implementation.sessions, implementation.known], [null, 3, 1]);
  assert.equal(report.timing.stages.planning.durationMs, 1000);
  assert.equal(report.provenance.complete, false);
  for (const note of ['run_not_finished', 'session_duration_incomplete', 'token_usage_incomplete'])
    assert.ok(report.provenance.notes.includes(note), note);
  assert.deepEqual(report.failures, [{ code: 'timeout', scope: 'session:developer', at: null }]);
  const text = JSON.stringify(report);
  assert.doesNotMatch(text, /"totalTokens":0/);
  assert.doesNotMatch(text, /"durationMs":0/);
});

test('a legacy run without session receipts reports unknown counts, never zero', () => {
  const { sessionAttempts: _s, coordinatorOperations: _c, ...legacy } = finishedRun();
  const report = buildRunReport(legacy, finishedEvents(), { now: NOW });
  assert.equal(report.attempts.sessions, null);
  assert.equal(report.attempts.failedSessions, null);
  assert.equal(report.usage.sessions, null);
  assert.equal(report.models, null);
  assert.equal(report.timing.stages.planning.sessions, null);
  assert.equal(report.timing.stages.assessment.operations, null);
  assert.equal(report.timing.wallMs, 60_000);
  assert.ok(report.provenance.notes.includes('session_attempts_missing'));
  assert.equal(report.provenance.complete, false);
});

test('queue waits come from job state receipts; an open wait makes the total unknown', () => {
  const job = (jobId, seq, type, state, at) => ({ jobId, seq, type, data: { state }, time: iso(T0 + at) });
  const closed = [
    job('a', 1, 'enqueued', 'queued', 0),
    job('a', 3, 'claimed', 'running', 1000),
    job('a', 4, 'completed', 'completed', 4000),
    job('b', 2, 'enqueued', 'queued', 0),
    job('b', 5, 'blocked', 'blocked', 100),
    job('b', 6, 'unblocked', 'queued', 2000),
    job('b', 7, 'claimed', 'running', 3000),
  ];
  const run = finishedRun();
  const report = buildRunReport(run, finishedEvents(), { now: NOW, jobEvents: closed });
  const pick = ({ jobs, waitMs, known, total, source }) => ({ jobs, waitMs, known, total, source });
  assert.deepEqual(pick(report.queue), { jobs: 2, waitMs: 4000, known: 2, total: 2, source: 'job-events' });
  const open = buildRunReport(run, finishedEvents(), {
    now: NOW,
    jobEvents: [...closed, job('c', 8, 'enqueued', 'queued', 5000)],
  });
  assert.deepEqual(pick(open.queue), { jobs: 3, waitMs: null, known: 2, total: 3, source: 'job-events' });
  assert.ok(open.provenance.notes.includes('queue_wait_open'));
  const none = buildRunReport(run, finishedEvents(), { now: NOW });
  assert.deepEqual(pick(none.queue), { jobs: 0, waitMs: null, known: 0, total: 0, source: null });
  assert.deepEqual(none.queue.delivery, { waitMs: null, polls: 0, known: 0, total: 0, source: null });
});

test('verification rounds, repairs, CI waits, failures, blocker and watchdog come from saved receipts', () => {
  const run = finishedRun({
    state: 'blocked',
    nodes: { a: { status: 'integrated', attempt: 1 }, b: { status: 'retrying', attempt: 3 } },
    checks: {
      schemaVersion: 2,
      complete: false,
      results: [
        { kind: 'test', command: { command: 'npm', args: ['test'] }, exitCode: 0 },
        {
          kind: 'build',
          command: { command: 'npm', args: ['run', 'build'] },
          status: 'failed',
          reason: 'timeout',
          exitCode: null,
        },
      ],
    },
    blocker: {
      current: {
        code: 'no_progress',
        scope: 'verification',
        message: 'private diagnostic text',
        firstSeen: iso(T0 + 50_000),
        lastSeen: iso(T0 + 70_000),
        occurrences: 2,
        headSha: 'a'.repeat(40),
      },
      history: [{ code: 'quota', outcome: 'resumed' }],
    },
    watchdog: {
      schemaVersion: 1,
      stalled: 2,
      rounds: [
        { key: 'v:1:0', progressed: true },
        { key: 'v:1:1', progressed: false },
        { key: 'v:1:2', progressed: false },
      ],
      stopped: { reason: 'no_verified_progress', stalled: 2, limit: 2, key: 'v:1:2' },
    },
  });
  const test = { kind: 'test', command: { command: 'npm', args: ['test'] } };
  const events = [
    event(1, 'created', T0),
    event(2, 'node_failed', T0 + 1000, { node: 'b', attempt: 1, error: 'secret-ish message' }),
    event(3, 'check_started', T0 + 2000, test),
    event(4, 'check_started', T0 + 2500, { kind: 'build', command: {} }),
    event(5, 'repair_required', T0 + 3000, { attempt: 0, problem: 'free text' }),
    event(6, 'checks_reused', T0 + 4000, { checks: 2 }),
    event(7, 'repair_required', T0 + 5000, { attempt: 1, problem: 'free text' }),
    event(8, 'check_started', T0 + 6000, test),
    event(9, 'delivery.checks_waiting', T0 + 10_000, { checks: {} }),
    event(10, 'delivery.checks_waiting', T0 + 20_000, { checks: {} }),
    event(11, 'delivery.operation', T0 + 26_000, { operation: 'merge', phase: 'intent' }),
    event(12, 'delivery.command_failed', T0 + 27_000, { code: 'command_failed', stdout: 'out' }),
    event(13, 'blocked', T0 + 30_000, { code: 'blocked', message: 'private message' }),
  ];
  const report = buildRunReport(deepFreeze(run), deepFreeze(events), { now: NOW });
  assert.deepEqual(
    [report.attempts.nodeAttempts, report.attempts.verificationRounds, report.attempts.repairRounds],
    [4, 3, 2],
  );
  assert.deepEqual(report.checks.runs, [
    { kind: 'test', command: 'npm test', durationMs: null, exitCode: 0 },
    { kind: 'build', command: 'npm run build', durationMs: null, exitCode: null },
  ]);
  assert.deepEqual([report.checks.executions, report.checks.reused], [3, 1]);
  assert.deepEqual(report.checks.ci, { waitMs: 16_000, polls: 2, known: 1, total: 1, source: 'delivery-events' });
  assert.equal(report.timing.finishedAt, iso(T0 + 30_000));
  assert.deepEqual(report.failures, [
    { code: 'node_failed', scope: 'node:b', at: iso(T0 + 1000) },
    { code: 'command_failed', scope: 'delivery', at: iso(T0 + 27_000) },
    { code: 'blocked', scope: 'run', at: iso(T0 + 30_000) },
    { code: 'timeout', scope: 'check:build', at: null },
    { code: 'delivery_uncertain', scope: 'delivery:merge', at: iso(T0 + 26_000) },
  ]);
  assert.deepEqual(report.blocker, {
    code: 'no_progress',
    scope: 'verification',
    firstSeen: iso(T0 + 50_000),
    lastSeen: iso(T0 + 70_000),
    occurrences: 2,
    resolved: 1,
  });
  assert.deepEqual(report.watchdog, {
    stalled: 2,
    rounds: 3,
    progressedRounds: 1,
    stopped: { reason: 'no_verified_progress', limit: 2 },
  });
  const text = JSON.stringify(report);
  for (const secret of ['private diagnostic text', 'private message', 'secret-ish message', 'free text'])
    assert.ok(!text.includes(secret), secret);
});

test('an open CI wait and malformed codes stay explicit', () => {
  const run = finishedRun({ state: 'delivering' });
  const events = [
    event(1, 'created', T0),
    event(2, 'node_failed', T0 + 500, { node: 'not a slug/../x', attempt: 1 }),
    event(3, 'delivery.checks_waiting', T0 + 1000),
  ];
  const report = buildRunReport(run, events, { now: NOW });
  assert.deepEqual(report.checks.ci, { waitMs: null, polls: 1, known: 0, total: 1, source: 'delivery-events' });
  assert.ok(report.provenance.notes.includes('ci_wait_open'));
  assert.deepEqual(report.failures[0], { code: 'node_failed', scope: 'node:unknown', at: iso(T0 + 500) });
});

test('observations from different platforms are listed, never compared', () => {
  const runs = new Map([
    ['r1', finishedRun({ id: 'r1', release: { smoke: { platform: 'linux', node: 'v24.1.0', passed: true } } })],
    ['r2', finishedRun({ id: 'r2', release: { smoke: { platform: 'win32', node: 'v24.1.0', passed: true } } })],
  ]);
  const snapshot = projectSnapshot(
    [task('t1', 'accepted'), task('t2', 'accepted')],
    [attempt('t1', 1, 'r1', 'accepted'), attempt('t2', 1, 'r2', 'accepted')],
  );
  const report = buildProjectReport(snapshot, runs, { r1: finishedEvents(), r2: finishedEvents() }, { now: NOW });
  assert.deepEqual(report.provenance.platforms, [
    { platform: 'linux', node: 'v24.1.0', source: 'release.smoke' },
    { platform: 'win32', node: 'v24.1.0', source: 'release.smoke' },
  ]);
  assert.ok(report.provenance.notes.includes('mixed_platforms'));
  assert.doesNotMatch(JSON.stringify(report), /winner|fastest|best/i);
  const single = buildRunReport(runs.get('r1'), finishedEvents(), { now: NOW });
  assert.deepEqual(single.provenance.platforms, [{ platform: 'linux', node: 'v24.1.0', source: 'release.smoke' }]);
  assert.equal(buildRunReport(finishedRun(), finishedEvents(), { now: NOW }).provenance.platforms, null);
});

function task(id, status, epicId = 'epic') {
  return { id, epicId, status, title: 'Task ' + id };
}
function attempt(taskId, number, runId, status) {
  return { id: `${taskId}-${number}`, taskId, number, runId, status };
}
function projectSnapshot(tasks, current, extra = {}) {
  return {
    schemaVersion: 1,
    project: { projectId: 'p-1', status: 'running', paused: false, revision: 7 },
    revision: 7,
    milestones: [{ id: 'm', status: 'running' }],
    epics: [{ id: 'epic', status: 'running' }],
    tasks,
    currentAttempts: current,
    riskApprovals: [],
    completeness: {
      milestones: { total: 1, returned: 1, complete: true },
      epics: { total: 1, returned: 1, complete: true },
      tasks: { total: tasks.length, returned: tasks.length, complete: true },
      currentAttempts: { total: current.length, returned: current.length, complete: true },
      riskApprovals: { total: 0, returned: 0, complete: true },
    },
    ...extra,
  };
}

test('project report: tasks in every status, retries and missing runs stay in the denominator', () => {
  const failedRun = finishedRun({
    id: 'r-failed',
    state: 'blocked',
    sessionAttempts: [session('developer', 'failed', measured(800), { errorCode: 'quota' })],
    blocker: { current: { code: 'quota', scope: 'run', firstSeen: iso(T0), lastSeen: iso(T0), occurrences: 1 } },
  });
  const runs = {
    'r-ok-1': finishedRun({ id: 'r-ok-1', state: 'blocked' }),
    'r-ok-2': finishedRun({ id: 'r-ok-2' }),
    'r-failed': failedRun,
  };
  const events = {
    'r-ok-1': [event(1, 'created', T0), event(2, 'blocked', T0 + 10_000, { code: 'quota' })],
    'r-ok-2': finishedEvents(),
    'r-failed': [event(1, 'created', T0), event(2, 'blocked', T0 + 5000, { code: 'quota' })],
  };
  const tasks = [
    task('done', 'accepted'),
    task('merged', 'integrated'),
    task('broken', 'failed'),
    task('stuck', 'blocked'),
    task('next', 'ready'),
  ];
  const current = [
    attempt('done', 2, 'r-ok-2', 'accepted'),
    attempt('broken', 1, 'r-failed', 'failed'),
    // Reserved, its Run never installed.
    attempt('stuck', 1, 'r-missing', 'blocked'),
  ];
  const all = [attempt('done', 1, 'r-ok-1', 'blocked'), ...current];
  const snapshot = deepFreeze(projectSnapshot(tasks, current));
  const report = buildProjectReport(snapshot, runs, events, { now: NOW, attempts: all });
  assert.equal(report.schemaVersion, 1);
  assert.equal(report.kind, 'project');
  assert.deepEqual([report.projectId, report.status, report.revision], ['p-1', 'running', 7]);
  assert.deepEqual(report.progress.tasks, { accepted: 1, integrated: 1, failed: 1, blocked: 1, ready: 1 });
  const byId = Object.fromEntries(report.tasks.map(row => [row.id, row]));
  assert.deepEqual(byId.done, {
    id: 'done',
    epicId: 'epic',
    status: 'accepted',
    attempts: 2,
    sessions: 6,
    wallMs: 70_000,
    implementationMs: 10_000,
    verificationMs: null,
    lastRunState: 'succeeded',
  });
  assert.deepEqual([byId.broken.attempts, byId.broken.wallMs, byId.broken.lastRunState], [1, 5000, 'blocked']);
  assert.deepEqual(
    [byId.stuck.attempts, byId.stuck.sessions, byId.stuck.wallMs, byId.stuck.lastRunState],
    [1, null, null, null],
  );
  assert.deepEqual([byId.next.attempts, byId.next.sessions, byId.next.wallMs], [0, 0, null]);
  assert.deepEqual(report.totals, {
    tasks: 5,
    accepted: 1,
    integrated: 1,
    failed: 1,
    blocked: 1,
    cancelled: 0,
    pending: 1,
    attempts: 4,
    // The reserved attempt without a saved Run makes the session total unknown.
    sessions: null,
    wallMs: null,
    verificationShare: null,
    usage: report.totals.usage,
  });
  assert.equal(report.totals.usage.sessions, 7);
  assert.equal(report.totals.usage.usage.totalTokens, 840);
  assert.equal(report.gates, undefined);
  assert.deepEqual(report.blockers, [
    { taskId: 'broken', runId: 'r-failed', code: 'quota', scope: 'run', occurrences: 1 },
    { taskId: 'stuck', runId: null, code: 'task_blocked', scope: 'task', occurrences: null },
  ]);
  assert.deepEqual(report.completeness.runs, { known: 3, total: 4, complete: false });
  assert.equal(report.provenance.complete, false);
  assert.ok(report.provenance.notes.includes('runs_missing'));
});

test('project report keeps future wave gates only when the snapshot has them', () => {
  const gates = [{ id: 'wave-1', status: 'passed', extra: { nested: 'dropped' } }];
  const snapshot = projectSnapshot([], [], { gates, project: { projectId: 'p-1', status: 'proposed', paused: true } });
  const report = buildProjectReport(snapshot, new Map(), {}, { now: NOW });
  assert.deepEqual(report.gates, [{ id: 'wave-1', status: 'passed' }]);
  assert.deepEqual(report.totals.tasks, 0);
  assert.equal(report.totals.wallMs, null);
  assert.equal(report.totals.usage.sessions, 0);
  assert.deepEqual(report.blockers, [
    { taskId: null, runId: null, code: 'project_paused', scope: 'project', occurrences: null },
  ]);
});

test('reports are pure: same input and clock give the same report', () => {
  const run = deepFreeze(finishedRun());
  const events = deepFreeze(finishedEvents());
  assert.deepEqual(buildRunReport(run, events, { now: NOW }), buildRunReport(run, events, { now: NOW }));
  assert.throws(() => buildRunReport(null, [], { now: NOW }), TypeError);
  assert.throws(() => buildProjectReport(null, {}, {}, { now: NOW }), TypeError);
});
