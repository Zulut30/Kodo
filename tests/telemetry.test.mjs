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
  assert.deepEqual(report.models, [{ client: 'codex', model: 'gpt-x', sessions: 3, observedSessions: 3 }]);
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
  assert.match(stages.verification.source, /check-executions/);
  assert.equal(report.generatedAt, undefined);
  assert.equal(report.provenance.source, 'kodo-state');
  assert.equal(report.provenance.generatedAt, iso(NOW));
  assert.equal(report.provenance.complete, true, JSON.stringify(report.provenance.notes));
  assert.ok(report.provenance.limitations.includes('prompt_bytes_are_not_tokens'));
  assert.ok(report.provenance.limitations.includes('elapsed_is_not_llm_latency'));
  assert.ok(report.provenance.limitations.includes('check_duration_not_recorded'));
  assert.deepEqual(report.checks.runs, [{ kind: 'test', executable: 'npm', durationMs: null, exitCode: 0 }]);
  assert.equal(report.checks.totalMs, null);
  assert.deepEqual(report.attempts, {
    sessions: 3,
    failedSessions: 0,
    pendingSessions: 0,
    observedSessions: 3,
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
    measuredMs: null,
    sessions: 0,
    operations: 0,
    known: 0,
    total: 0,
    source: null,
  });
  assert.deepEqual(stages.release, {
    durationMs: null,
    measuredMs: null,
    sessions: 0,
    operations: 0,
    known: 0,
    total: 0,
    source: null,
  });
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
  assert.deepEqual(none.queue.delivery, { waitMs: null, measuredMs: null, polls: 0, known: 0, total: 0, source: null });
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
    { kind: 'test', executable: 'npm', durationMs: null, exitCode: 0 },
    { kind: 'build', executable: 'npm', durationMs: null, exitCode: null },
  ]);
  assert.deepEqual([report.checks.executions, report.checks.reused], [3, 1]);
  // The poll that saw the checks ready is not saved: the wait has no end, only a measured part.
  assert.deepEqual(report.checks.ci, {
    waitMs: null,
    measuredMs: 10_000,
    polls: 2,
    known: 0,
    total: 1,
    source: 'delivery-events',
  });
  assert.equal(report.timing.finishedAt, iso(T0 + 30_000));
  assert.deepEqual(report.failures, [
    { code: 'node_failed', scope: 'node:b', at: iso(T0 + 1000) },
    { code: 'repair_required', scope: 'verification', at: iso(T0 + 3000) },
    { code: 'repair_required', scope: 'verification', at: iso(T0 + 5000) },
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
  assert.deepEqual(report.checks.ci, {
    waitMs: null,
    measuredMs: 0,
    polls: 1,
    known: 0,
    total: 1,
    source: 'delivery-events',
  });
  assert.ok(report.provenance.notes.includes('ci_wait_open'));
  assert.deepEqual(report.failures[0], { code: 'node_failed', scope: 'node:unknown', at: iso(T0 + 500) });
});

test('check results expose only the kind and the executable name, never paths or arguments', () => {
  const run = finishedRun({
    checks: {
      schemaVersion: 2,
      complete: true,
      results: [
        {
          kind: 'test',
          command: {
            command: '/opt/private-tools/bin/node',
            args: ['/home/owner/private-repo/test/secret.test.mjs', '--password', 'hunter2-password-value'],
          },
          exitCode: 0,
        },
        { kind: 'lint', command: 'C:\\Users\\owner\\tools\\lint.cmd --token legacy-token-value', exitCode: 1 },
        { kind: 'build', command: { args: ['orphan-argument-value'] }, exitCode: 0 },
      ],
    },
  });
  const report = buildRunReport(run, finishedEvents(), { now: NOW });
  assert.deepEqual(report.checks.runs, [
    { kind: 'test', executable: 'node', durationMs: null, exitCode: 0 },
    // An unquoted legacy path followed by more text is ambiguous: no name is guessed.
    { kind: 'lint', executable: null, durationMs: null, exitCode: 1 },
    { kind: 'build', executable: null, durationMs: null, exitCode: 0 },
  ]);
  const text = JSON.stringify(report);
  for (const value of [
    'private-tools',
    'private-repo',
    'secret.test.mjs',
    '--password',
    'hunter2-password-value',
    'owner',
    '--token',
    'legacy-token-value',
    'orphan-argument-value',
  ])
    assert.ok(!text.includes(value), value);
});

test('mirrored delivery and release events never close a CI or delivery queue wait', () => {
  // The Engine stores each delivery event and then a `delivery`/`release` copy of it.
  const mirror = (seq, type, at, data = {}) => event(seq, 'delivery', T0 + at, { type, ...data });
  const events = [
    event(1, 'created', T0),
    event(2, 'delivery.queue_waiting', T0 + 1000, { queue: 'q' }),
    mirror(3, 'delivery.queue_waiting', 1001, { queue: 'q' }),
    event(4, 'delivery.queue_waiting', T0 + 6000, { queue: 'q' }),
    mirror(5, 'delivery.queue_waiting', 6001, { queue: 'q' }),
    event(6, 'delivery.checks_waiting', T0 + 10_000, { checks: {} }),
    mirror(7, 'delivery.checks_waiting', 10_001),
    event(8, 'delivery.checks_waiting', T0 + 20_000, { checks: {} }),
    mirror(9, 'delivery.checks_waiting', 20_001),
    event(10, 'delivery.operation', T0 + 26_000, { operation: 'merge', phase: 'intent' }),
    mirror(11, 'delivery.operation', 26_001, { operation: 'merge', phase: 'intent' }),
    event(12, 'delivery.operation', T0 + 28_000, { operation: 'merge', phase: 'outcome', status: 'confirmed' }),
    mirror(13, 'delivery.operation', 28_001, { operation: 'merge', phase: 'outcome', status: 'confirmed' }),
    event(14, 'succeeded', T0 + 30_000),
  ];
  const report = buildRunReport(finishedRun(), events, { now: NOW });
  // Copies neither split a streak of polls nor end it.
  const window = (measuredMs, polls) => ({
    waitMs: null,
    measuredMs,
    polls,
    known: 0,
    total: 1,
    source: 'delivery-events',
  });
  assert.deepEqual(report.checks.ci, window(10_000, 2));
  assert.deepEqual(report.queue.delivery, window(5000, 2));
  assert.deepEqual([report.timing.stages.delivery.durationMs, report.timing.stages.delivery.operations], [2000, 1]);
  // Polls followed only by their copies have no confirmed end: the wait stays open.
  const open = buildRunReport(
    finishedRun({ state: 'delivering' }),
    [
      event(1, 'created', T0),
      event(2, 'delivery.checks_waiting', T0 + 1000),
      event(3, 'release', T0 + 1001, { type: 'delivery.checks_waiting' }),
    ],
    { now: NOW },
  );
  assert.deepEqual(open.checks.ci, window(0, 1));
  assert.ok(open.provenance.notes.includes('ci_wait_open'));
});

test('every delivery attempt keeps its own intent, outcome and failure', () => {
  const merge = (seq, at, data) => event(seq, 'delivery.operation', T0 + at, { operation: 'merge', ...data });
  const absentThenMerged = [
    event(1, 'created', T0),
    merge(2, 1000, { phase: 'intent' }),
    merge(3, 4000, { phase: 'outcome', status: 'absent' }),
    merge(4, 10_000, { phase: 'intent' }),
    merge(5, 12_000, { phase: 'outcome', status: 'confirmed' }),
    event(6, 'succeeded', T0 + 20_000),
  ];
  const report = buildRunReport(finishedRun(), absentThenMerged, { now: NOW });
  const pick = ({ durationMs, operations, known, total }) => ({ durationMs, operations, known, total });
  assert.deepEqual(pick(report.timing.stages.delivery), { durationMs: 5000, operations: 2, known: 2, total: 2 });
  assert.deepEqual(
    report.failures.filter(item => item.scope.startsWith('delivery')),
    [{ code: 'delivery_absent', scope: 'delivery:merge', at: iso(T0 + 4000) }],
  );
  assert.equal(report.provenance.complete, true, JSON.stringify(report.provenance.notes));

  // An intent superseded by a retry was never read back: unknown duration, still in the denominator.
  const retried = [
    event(1, 'created', T0),
    merge(2, 1000, { phase: 'intent' }),
    merge(3, 5000, { phase: 'intent' }),
    merge(4, 7000, { phase: 'outcome', status: 'confirmed' }),
    // A later read-back without a new intent changes no attempt.
    merge(5, 9000, { phase: 'outcome', status: 'reconciled' }),
    event(6, 'succeeded', T0 + 20_000),
  ];
  const second = buildRunReport(finishedRun(), retried, { now: NOW });
  assert.deepEqual(pick(second.timing.stages.delivery), { durationMs: null, operations: 2, known: 1, total: 2 });
  assert.deepEqual(
    second.failures.filter(item => item.scope.startsWith('delivery')),
    [{ code: 'delivery_uncertain', scope: 'delivery:merge', at: iso(T0 + 1000) }],
  );
  assert.ok(second.provenance.notes.includes('delivery_operation_open'));
});

test('an unfinished coordinator operation makes the observations incomplete', () => {
  const run = finishedRun({
    coordinatorOperations: [
      { kind: 'assessment', status: 'completed', durationMs: 300 },
      { kind: 'analysis', status: 'started' },
    ],
  });
  const report = buildRunReport(run, finishedEvents(), { now: NOW });
  const { analysis } = report.timing.stages;
  assert.deepEqual([analysis.durationMs, analysis.known, analysis.total], [null, 0, 1]);
  assert.equal(report.provenance.complete, false);
  assert.ok(report.provenance.notes.includes('coordinator_operation_incomplete'));
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
    // ...and the usage total too: only the sum of what was observed is reported, under its own name.
    usage: null,
    observedUsage: report.totals.observedUsage,
    waits: report.totals.waits,
  });
  assert.equal(report.totals.observedUsage.sessions, 7);
  assert.equal(report.totals.observedUsage.usage.totalTokens, 840);
  assert.equal(report.gates, undefined);
  assert.deepEqual(report.blockers, [
    { taskId: 'broken', runId: 'r-failed', code: 'quota', scope: 'run', occurrences: 1 },
    { taskId: 'stuck', runId: null, code: 'task_blocked', scope: 'task', occurrences: null },
  ]);
  assert.deepEqual(report.completeness.runs, { known: 3, total: 4, complete: false });
  assert.equal(report.provenance.complete, false);
  assert.ok(report.provenance.notes.includes('runs_missing'));
});

test('project report names an abandoned attempt of an open task as a blocker', () => {
  // Audit finding 4d: an external chat's abandon leaves the attempt blocked and its Run cancelled
  // without a blocker record, while the task stays running; the report showed no blocker at all.
  const abandoned = finishedRun({
    id: 'r-abandoned',
    state: 'cancelled',
    error: { code: 'external_abandoned', message: 'External worker abandoned the task' },
  });
  const tasks = [task('dropped', 'running'), task('working', 'running'), task('merged', 'integrated')];
  const current = [
    attempt('dropped', 1, 'r-abandoned', 'blocked'),
    attempt('working', 1, 'r-working', 'running'),
    attempt('merged', 1, 'r-merged', 'integrated'),
  ];
  const runs = {
    'r-abandoned': abandoned,
    'r-working': finishedRun({ id: 'r-working', state: 'executing' }),
    'r-merged': finishedRun({ id: 'r-merged' }),
  };
  const report = buildProjectReport(deepFreeze(projectSnapshot(tasks, current)), runs, {}, { now: NOW });
  assert.deepEqual(report.blockers, [
    { taskId: 'dropped', runId: 'r-abandoned', code: 'attempt_blocked', scope: 'attempt', occurrences: null },
  ]);
});

test('project usage is unknown when the attempt history is incomplete; the observed sum is named apart', () => {
  const sixty = finishedRun({
    id: 'r1',
    sessionAttempts: [session('developer', 'completed', measured(900, usage(50, 10)))],
  });
  const snapshot = projectSnapshot([task('t1', 'running')], [attempt('t1', 2, 'r2', 'running')]);
  const all = [attempt('t1', 1, 'r1', 'blocked'), attempt('t1', 2, 'r2', 'running')];
  // The second attempt has no saved Run.
  const report = buildProjectReport(snapshot, { r1: sixty }, { r1: finishedEvents() }, { now: NOW, attempts: all });
  assert.equal(report.totals.sessions, null);
  assert.equal(report.totals.usage, null);
  assert.equal(report.totals.observedUsage.sessions, 1);
  assert.equal(report.totals.observedUsage.usage.totalTokens, 60);
  assert.equal(report.provenance.complete, false);
  assert.ok(report.provenance.notes.includes('runs_missing'));

  // A legacy Run without session receipts: the number of sessions, so the usage total, is unknown.
  const { sessionAttempts: _s, ...legacy } = finishedRun({ id: 'r2' });
  const both = buildProjectReport(
    snapshot,
    { r1: sixty, r2: legacy },
    { r1: finishedEvents(), r2: finishedEvents() },
    { now: NOW, attempts: all },
  );
  assert.equal(both.completeness.runs.complete, true);
  assert.equal(both.totals.sessions, null);
  assert.equal(both.totals.usage, null);
  assert.equal(both.totals.observedUsage.usage.totalTokens, 60);

  // Complete history: the total is the observed sum.
  const complete = buildProjectReport(
    projectSnapshot([task('t1', 'accepted')], [attempt('t1', 1, 'r1', 'accepted')]),
    { r1: sixty },
    { r1: finishedEvents() },
    { now: NOW },
  );
  assert.equal(complete.totals.usage.usage.totalTokens, 60);
  assert.deepEqual(complete.totals.usage, complete.totals.observedUsage);
});

test('project report keeps queue and CI waits and the failure codes of every attempt', () => {
  const runs = {
    r1: finishedRun({ id: 'r1', state: 'blocked' }),
    r2: finishedRun({ id: 'r2' }),
  };
  const events = {
    r1: [
      event(1, 'created', T0),
      event(2, 'delivery.checks_waiting', T0 + 10_000),
      event(3, 'delivery', T0 + 10_001, { type: 'delivery.checks_waiting' }),
      event(4, 'delivery.checks_waiting', T0 + 20_000),
      event(5, 'delivery', T0 + 20_001, { type: 'delivery.checks_waiting' }),
      event(6, 'blocked', T0 + 30_000, { code: 'checks_failed', message: 'private' }),
    ],
    r2: [event(1, 'created', T0), event(2, 'succeeded', T0 + 5000)],
  };
  const job = (jobId, seq, state, at) => ({ jobId, seq, type: 'state', data: { state }, time: iso(T0 + at) });
  const jobEvents = new Map([
    ['r1', [job('j1', 1, 'queued', 0), job('j1', 2, 'running', 3000)]],
    ['r2', [job('j2', 3, 'queued', 0), job('j2', 4, 'running', 1000)]],
  ]);
  const snapshot = projectSnapshot(
    [task('t1', 'accepted'), task('t2', 'running')],
    [attempt('t1', 2, 'r2', 'accepted'), attempt('t2', 1, 'r-missing', 'running')],
  );
  const all = [attempt('t1', 1, 'r1', 'blocked'), ...snapshot.currentAttempts];
  const report = buildProjectReport(snapshot, runs, events, { now: NOW, attempts: all, jobEvents });
  const wait = (waitMs, measuredMs, known, total) => ({ waitMs, measuredMs, known, total });
  assert.deepEqual(report.attempts, [
    {
      taskId: 't1',
      number: 1,
      runId: 'r1',
      state: 'blocked',
      wallMs: 30_000,
      // The CI wait has no saved end: unknown, with its measured part apart.
      waits: { queue: wait(3000, 3000, 1, 1), deliveryQueue: wait(null, null, 0, 0), ci: wait(null, 10_000, 0, 1) },
      failures: [{ code: 'checks_failed', scope: 'run', at: iso(T0 + 30_000) }],
    },
    {
      taskId: 't1',
      number: 2,
      runId: 'r2',
      state: 'succeeded',
      wallMs: 5000,
      waits: { queue: wait(1000, 1000, 1, 1), deliveryQueue: wait(null, null, 0, 0), ci: wait(null, null, 0, 0) },
      failures: [],
    },
    // Without a saved Run nothing about the attempt is known: null, never 0 or [].
    {
      taskId: 't2',
      number: 1,
      runId: 'r-missing',
      state: null,
      wallMs: null,
      waits: {
        queue: wait(null, null, 0, null),
        deliveryQueue: wait(null, null, 0, null),
        ci: wait(null, null, 0, null),
      },
      failures: null,
    },
  ]);
  assert.deepEqual(report.totals.waits, {
    queue: { waitMs: null, measuredMs: 4000, known: 2, total: null, complete: false },
    deliveryQueue: { waitMs: null, measuredMs: null, known: 0, total: null, complete: false },
    ci: { waitMs: null, measuredMs: 10_000, known: 0, total: null, complete: false },
  });
  const settled = buildProjectReport(
    projectSnapshot([task('t1', 'accepted')], [attempt('t1', 2, 'r2', 'accepted')]),
    runs,
    events,
    { now: NOW, attempts: all.slice(0, 2), jobEvents },
  );
  // Only the job queue waits have explicit ends; an attempt without observations is unknown, not 0.
  assert.deepEqual(settled.totals.waits, {
    queue: { waitMs: 4000, measuredMs: 4000, known: 2, total: 2, complete: true },
    deliveryQueue: { waitMs: null, measuredMs: null, known: 0, total: 0, complete: false },
    ci: { waitMs: null, measuredMs: 10_000, known: 0, total: 1, complete: false },
  });
  assert.ok(!JSON.stringify(report).includes('private'));
});

test('project report keeps future wave gates only when the snapshot has them', () => {
  const gates = [{ id: 'wave-1', status: 'passed', extra: { nested: 'dropped' } }];
  const snapshot = projectSnapshot([], [], { gates, project: { projectId: 'p-1', status: 'proposed', paused: true } });
  const report = buildProjectReport(snapshot, new Map(), {}, { now: NOW });
  // A gate without a Run keeps a status of its own record; nested data never leaks.
  assert.deepEqual(report.gates, [{ id: 'wave-1', status: 'passed', runId: null, containers: [], sessions: null }]);
  assert.deepEqual(
    { gates: report.totals.gates.gates, runs: report.totals.gates.runs, sessions: report.totals.gates.sessions },
    { gates: 1, runs: 0, sessions: null },
  );
  assert.deepEqual(report.totals.tasks, 0);
  assert.equal(report.totals.wallMs, null);
  assert.equal(report.totals.usage.sessions, 0);
  assert.deepEqual(report.blockers, [
    { taskId: null, runId: null, code: 'project_paused', scope: 'project', occurrences: null },
  ]);
});

test('project report reads wave gates from their gate Runs; only a current blocked gate is a blocker', () => {
  const gateRun = (id, state, extra = {}) =>
    finishedRun({
      id,
      state,
      sessionAttempts: [session('review', 'completed', measured(3000)), session('repair', 'completed', measured(4000))],
      ...extra,
    });
  const blocked = { current: { code: 'repair_budget_exhausted', scope: 'run', occurrences: 1 }, history: [] };
  const runs = new Map([
    ['gate-run-1', gateRun('gate-run-1', 'blocked', { blocker: blocked })],
    ['gate-run-2', gateRun('gate-run-2', 'succeeded')],
    ['gate-run-3', gateRun('gate-run-3', 'blocked', { blocker: blocked })],
  ]);
  const gate = (id, number, runId, epic) => ({
    id,
    number,
    runId,
    containers: [{ kind: 'epic', id: epic }],
    installed: true,
  });
  const gates = [
    gate('g-1', 1, 'gate-run-1', 'foundation'),
    gate('g-2', 2, 'gate-run-2', 'foundation'),
    gate('g-3', 3, 'gate-run-3', 'core'),
    gate('g-4', 4, 'gate-run-missing', 'cli'),
  ];
  const report = buildProjectReport(projectSnapshot([], [], { gates }), runs, {}, { now: NOW });
  assert.deepEqual(
    report.gates.map(row => [row.id, row.status, row.runId, row.containers, row.sessions]),
    [
      ['g-1', 'blocked', 'gate-run-1', ['epic:foundation'], 2],
      ['g-2', 'succeeded', 'gate-run-2', ['epic:foundation'], 2],
      ['g-3', 'blocked', 'gate-run-3', ['epic:core'], 2],
      ['g-4', 'unknown', 'gate-run-missing', ['epic:cli'], null],
    ],
  );
  // A blocked gate a later gate of the same container replaced is history, not a blocker.
  assert.deepEqual(report.blockers, [
    {
      taskId: null,
      runId: 'gate-run-3',
      gateId: 'g-3',
      code: 'repair_budget_exhausted',
      scope: 'gate',
      occurrences: 1,
    },
  ]);
  assert.deepEqual(
    { gates: report.totals.gates.gates, runs: report.totals.gates.runs, sessions: report.totals.gates.sessions },
    { gates: 4, runs: 3, sessions: null },
    'a gate without its Run makes the session total unknown',
  );
  assert.equal(report.totals.gates.complete, false);
  assert.equal(report.totals.gates.observedUsage.sessions, 6, 'observed sessions of the found Runs');
  const found = buildProjectReport(projectSnapshot([], [], { gates: gates.slice(0, 3) }), runs, {}, { now: NOW });
  assert.deepEqual([found.totals.gates.sessions, found.totals.gates.complete], [6, true]);
  const none = buildProjectReport(projectSnapshot([], [], { gates: [] }), runs, {}, { now: NOW });
  assert.equal(none.totals.gates.sessions, 0, 'no gates: zero, not unknown');
  assert.equal(report.totals.sessions, 0, 'task totals keep their meaning');

  // A gate waiting for subscription limits or cancelled has not accepted anything: a blocker too,
  // with its Run blocker code when there is one and a state code otherwise.
  const quota = { current: { code: 'quota', scope: 'run', occurrences: 2 }, history: [] };
  const stopped = new Map([
    ['gate-run-5', gateRun('gate-run-5', 'waiting_limits', { blocker: quota })],
    ['gate-run-6', gateRun('gate-run-6', 'cancelled')],
  ]);
  const halted = buildProjectReport(
    projectSnapshot([], [], { gates: [gate('g-5', 1, 'gate-run-5', 'core'), gate('g-6', 2, 'gate-run-6', 'cli')] }),
    stopped,
    {},
    { now: NOW },
  );
  assert.deepEqual(halted.blockers, [
    { taskId: null, runId: 'gate-run-5', gateId: 'g-5', code: 'quota', scope: 'gate', occurrences: 2 },
    { taskId: null, runId: 'gate-run-6', gateId: 'g-6', code: 'gate_cancelled', scope: 'gate', occurrences: null },
  ]);
});

test('project report names a gate Run blocked by its acceptance with its gate and error code', () => {
  // Review finding (major): a gate Run blocked after a failed acceptance has only `error.code`
  // (no blocker record); the report showed `gate_blocked` and no gate id.
  const run = finishedRun({
    id: 'gate-run-7',
    state: 'blocked',
    error: { code: 'wave_gate_proof_missing', message: 'The acceptance proof is missing' },
  });
  const gates = [{ id: 'g-7', number: 1, runId: 'gate-run-7', containers: [{ kind: 'epic', id: 'core' }] }];
  const report = buildProjectReport(
    projectSnapshot([], [], { gates }),
    new Map([['gate-run-7', run]]),
    {},
    { now: NOW },
  );
  assert.deepEqual(report.blockers, [
    {
      taskId: null,
      runId: 'gate-run-7',
      gateId: 'g-7',
      code: 'wave_gate_proof_missing',
      scope: 'gate',
      occurrences: null,
    },
  ]);
});

test('reports are pure: same input and clock give the same report', () => {
  const run = deepFreeze(finishedRun());
  const events = deepFreeze(finishedEvents());
  assert.deepEqual(buildRunReport(run, events, { now: NOW }), buildRunReport(run, events, { now: NOW }));
  assert.throws(() => buildRunReport(null, [], { now: NOW }), TypeError);
  assert.throws(() => buildProjectReport(null, {}, {}, { now: NOW }), TypeError);
});

test('CI and delivery queue waits end only at a saved boundary; lease and fetch time is never CI time', () => {
  // awaitChecks saves a poll only while checks are pending; the poll that saw them ready is not
  // saved. What follows (lease polls, fetch, the merge intent) is not part of the CI wait.
  const events = [
    event(1, 'created', T0),
    event(2, 'delivery.checks_waiting', T0 + 10_000, { checks: {} }),
    event(3, 'delivery.checks_waiting', T0 + 20_000, { checks: {} }),
    event(4, 'delivery.queue_waiting', T0 + 50_000, { queue: 'merge:o/r:main' }),
    event(5, 'delivery.queue_waiting', T0 + 55_000, { queue: 'merge:o/r:main' }),
    // The release lease is another wait, even with no other event in between.
    event(6, 'delivery.queue_waiting', T0 + 70_000, { queue: 'release:o/r:main' }),
    event(7, 'delivery.queue_waiting', T0 + 72_000, { queue: 'release:o/r:main' }),
    event(8, 'delivery.operation', T0 + 200_000, { operation: 'merge', phase: 'intent' }),
    event(9, 'delivery.operation', T0 + 201_000, { operation: 'merge', phase: 'outcome', status: 'confirmed' }),
    event(10, 'succeeded', T0 + 210_000),
  ];
  const report = buildRunReport(finishedRun(), events, { now: NOW });
  assert.deepEqual(report.checks.ci, {
    waitMs: null,
    measuredMs: 10_000,
    polls: 2,
    known: 0,
    total: 1,
    source: 'delivery-events',
  });
  assert.deepEqual(report.queue.delivery, {
    waitMs: null,
    measuredMs: 7000,
    polls: 4,
    known: 0,
    total: 2,
    source: 'delivery-events',
  });
  for (const note of ['ci_wait_open', 'delivery_queue_wait_open']) assert.ok(report.provenance.notes.includes(note));
  assert.equal(report.provenance.complete, false);
});

test('project waits are complete only when every attempt has a known wait; measured parts stay apart', () => {
  const job = (jobId, seq, state, at) => ({ jobId, seq, type: 'state', data: { state }, time: iso(T0 + at) });
  const runs = { r1: finishedRun({ id: 'r1' }), r2: finishedRun({ id: 'r2' }) };
  const events = {
    r1: [event(1, 'created', T0), event(2, 'succeeded', T0 + 9000)],
    r2: [
      event(1, 'created', T0),
      event(2, 'delivery.checks_waiting', T0 + 1000),
      event(3, 'delivery.checks_waiting', T0 + 4000),
      event(4, 'succeeded', T0 + 9000),
    ],
  };
  // r1 has a closed job wait, r2 has no job receipts at all: its queue wait is unknown, not 0.
  const jobEvents = { r1: [job('j1', 1, 'queued', 0), job('j1', 2, 'running', 2500)] };
  const snapshot = projectSnapshot(
    [task('t1', 'accepted'), task('t2', 'accepted')],
    [attempt('t1', 1, 'r1', 'accepted'), attempt('t2', 1, 'r2', 'accepted')],
  );
  const report = buildProjectReport(snapshot, runs, events, { now: NOW, jobEvents });
  assert.deepEqual(report.totals.waits, {
    queue: { waitMs: null, measuredMs: 2500, known: 1, total: 1, complete: false },
    deliveryQueue: { waitMs: null, measuredMs: null, known: 0, total: 0, complete: false },
    ci: { waitMs: null, measuredMs: 3000, known: 0, total: 1, complete: false },
  });
  assert.deepEqual(report.attempts[1].waits.ci, { waitMs: null, measuredMs: 3000, known: 0, total: 1 });
});

test('a Run continued without its earlier history has no usage total, only the observed usage', () => {
  const continued = finishedRun({ id: 'r1', metrics: { historyComplete: false } });
  const run = buildRunReport(continued, finishedEvents(), { now: NOW });
  assert.equal(run.usage, null);
  assert.equal(run.observedUsage.sessions, 3);
  assert.equal(run.observedUsage.usage.totalTokens, 360);
  assert.deepEqual(run.context, { originalBytes: null, sentBytes: null });
  assert.ok(run.provenance.notes.includes('history_incomplete'));
  assert.equal(run.provenance.complete, false);
  // The saved sessions are only a part: counts and session-stage totals are unknown, the part is named.
  assert.deepEqual(
    [run.attempts.sessions, run.attempts.failedSessions, run.attempts.pendingSessions, run.attempts.observedSessions],
    [null, null, null, 3],
  );
  const implementation = run.timing.stages.implementation;
  assert.deepEqual([implementation.durationMs, implementation.sessions, implementation.total], [null, null, null]);
  // How many sessions are missing is unknown: no stage invents a denominator.
  assert.deepEqual([run.timing.stages.planning.total, run.timing.stages.planning.durationMs], [null, null]);
  assert.deepEqual(
    run.models.map(row => [row.sessions, row.observedSessions]),
    [[null, 3]],
  );
  assert.equal(typeof implementation.measuredMs, 'number');
  assert.equal(buildRunReport(finishedRun(), finishedEvents(), { now: NOW }).usage.usage.totalTokens, 360);

  const project = buildProjectReport(
    projectSnapshot([task('t1', 'accepted')], [attempt('t1', 1, 'r1', 'accepted')]),
    { r1: continued },
    { r1: finishedEvents() },
    { now: NOW },
  );
  assert.equal(project.completeness.runs.complete, true);
  assert.equal(project.totals.sessions, null);
  assert.equal(project.tasks[0].implementationMs, null);
  assert.equal(project.totals.usage, null);
  assert.equal(project.totals.observedUsage.usage.totalTokens, 360);
  assert.ok(project.provenance.notes.includes('history_incomplete'));
});

test('a legacy command string yields a whole executable name or null, and usage semantics a known value', () => {
  const run = finishedRun({
    sessionAttempts: [
      session('developer', 'completed', measured(100, { ...usage(1, 1), semantics: '/home/owner/private-semantics' })),
    ],
    checks: {
      schemaVersion: 2,
      complete: true,
      results: [
        '"C:/Private Account/bin/lint.cmd" --arg',
        "'/opt/My Tools/bin/test-runner' --flag",
        'C:/Private Account/bin/lint.cmd --arg',
        '"C:/Private Account/bin/lint.cmd',
        '"C:/Private Account/bin/"lint.cmd --arg',
        'C:/Pri"vate/lint.cmd',
        '/usr/local/bin/node --test',
        'C:\Customer Label.exe',
        'Customer Files/tools/lint.cmd --fix',
        'npm test',
        { command: 'C:/Private Account/bin/build.cmd', args: [] },
      ].map(command => ({ kind: 'test', command, exitCode: 0 })),
    },
  });
  const report = buildRunReport(run, finishedEvents(), { now: NOW });
  assert.deepEqual(
    report.checks.runs.map(row => row.executable),
    ['lint.cmd', 'test-runner', null, null, null, null, null, null, null, 'npm', 'build.cmd'],
  );
  assert.equal(report.usage.usage.semantics, null);
  const text = JSON.stringify(report);
  for (const value of ['Private', 'Account', 'Customer', 'My Tools', 'private-semantics', 'owner'])
    assert.ok(!text.includes(value), value);
  const known = buildRunReport(finishedRun(), finishedEvents(), { now: NOW });
  assert.equal(known.usage.usage.semantics, 'input-includes-cached');
});

test('a started check without a result stays in the denominator and failed rounds stay in the failures', () => {
  const testCommand = { kind: 'test', command: { command: 'npm', args: ['test'] } };
  const buildCommand = { kind: 'build', command: { command: 'npm', args: ['run', 'build'] } };
  // The build command ran and changed the worktree: the Run stopped before its result was saved.
  const dirty = finishedRun({
    state: 'blocked',
    checks: { schemaVersion: 2, complete: false, results: [{ ...testCommand, exitCode: 0 }] },
  });
  const report = buildRunReport(
    dirty,
    [
      event(1, 'created', T0),
      event(2, 'check_started', T0 + 1000, testCommand),
      event(3, 'check_started', T0 + 2000, buildCommand),
      event(4, 'blocked', T0 + 9000, { code: 'dirty_worktree', message: 'private' }),
    ],
    { now: NOW },
  );
  const { verification } = report.timing.stages;
  assert.deepEqual([verification.durationMs, verification.known, verification.total], [null, 0, 2]);
  assert.deepEqual([report.checks.executions, report.checks.unclosed, report.checks.total], [2, 1, 2]);
  assert.ok(report.provenance.notes.includes('check_unclosed'));
  assert.equal(report.provenance.complete, false);

  // A failed round, repaired, then a passing round: the failure stays visible after the repair.
  const repaired = buildRunReport(
    finishedRun({ checks: { schemaVersion: 2, complete: true, results: [{ ...testCommand, exitCode: 0 }] } }),
    [
      event(1, 'created', T0),
      event(2, 'check_started', T0 + 1000, testCommand),
      event(3, 'repair_required', T0 + 2000, { attempt: 0, problem: 'private check output' }),
      event(4, 'session', T0 + 3000, { type: 'turn' }),
      event(5, 'check_started', T0 + 4000, testCommand),
      event(6, 'succeeded', T0 + 9000),
    ],
    { now: NOW },
  );
  assert.deepEqual(repaired.failures, [{ code: 'repair_required', scope: 'verification', at: iso(T0 + 2000) }]);
  const stage = repaired.timing.stages.verification;
  assert.deepEqual([stage.known, stage.total], [0, 2]);
  assert.equal(repaired.checks.unclosed, 0);
  assert.ok(!repaired.provenance.notes.includes('check_unclosed'));
  assert.ok(!JSON.stringify(repaired).includes('private check output'));
});

test('a gap in the attempt numbers makes the project waits incomplete; the measured part stays apart', () => {
  const runs = {
    r2: finishedRun({ id: 'r2' }),
  };
  const events = {
    r2: [
      event(1, 'created', T0),
      event(2, 'delivery.checks_waiting', T0 + 1000),
      event(3, 'delivery.checks_waiting', T0 + 1015),
      event(4, 'succeeded', T0 + 9000),
    ],
  };
  // The current attempt is number 2, but the row of attempt 1 is missing from the history.
  const snapshot = projectSnapshot([task('t1', 'accepted')], [attempt('t1', 2, 'r2', 'accepted')]);
  const report = buildProjectReport(snapshot, runs, events, { now: NOW });
  for (const wait of Object.values(report.totals.waits)) {
    assert.equal(wait.complete, false);
    assert.equal(wait.waitMs, null);
  }
  assert.equal(report.totals.waits.ci.measuredMs, 15);
});

test('checks of a round closed by repair_required are closed, not unclosed, after the receipt reset', () => {
  const testCommand = { kind: 'test', command: { command: 'npm', args: ['test'] } };
  // Engine cleared run.checks on the repair commit; the next round has not started yet.
  const report = buildRunReport(
    finishedRun({ state: 'running', checks: null }),
    [
      event(1, 'created', T0),
      event(2, 'check_started', T0 + 1000, testCommand),
      event(3, 'repair_required', T0 + 2000, { attempt: 0, problem: 'private' }),
      event(4, 'session', T0 + 3000, { type: 'turn' }),
    ],
    { now: NOW },
  );
  assert.equal(report.checks.unclosed, 0);
  assert.ok(!report.provenance.notes.includes('check_unclosed'));
  const stage = report.timing.stages.verification;
  assert.deepEqual([stage.durationMs, stage.known, stage.total], [null, 0, 1]);
});

test('a surviving history row above a missing one counts the gap even without a current pointer', () => {
  const job = (seq, state, at) => ({ jobId: 'j2', seq, type: 'state', data: { state }, time: iso(T0 + at) });
  const runs = { r2: finishedRun({ id: 'r2' }) };
  const events = { r2: [event(1, 'created', T0), event(2, 'succeeded', T0 + 9000)] };
  // No current pointer and no row 1: only the history row of attempt 2 survived.
  const snapshot = projectSnapshot([task('t1', 'blocked')], []);
  const report = buildProjectReport(snapshot, runs, events, {
    now: NOW,
    attempts: [attempt('t1', 2, 'r2', 'blocked')],
    jobEvents: { r2: [job(1, 'queued', 0), job(2, 'running', 9)] },
  });
  assert.equal(report.tasks[0].attempts, 2);
  assert.deepEqual(report.completeness.runs, { known: 1, total: 2, complete: false });
  assert.equal(report.totals.waits.queue.waitMs, null);
  assert.equal(report.totals.waits.queue.measuredMs, 9);
  assert.equal(report.totals.waits.queue.complete, false);
});
