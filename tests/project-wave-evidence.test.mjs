import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { BEHAVIOR_GATE_VERSION, verificationConfigHash } from '../runtime/behavior-gate.mjs';

const P = '11111111-1111-4111-8111-111111111111';
const [R1, R2, G1, G2] = ['2', '4', '6', '8'].map(
  d => `${d.repeat(8)}-${d.repeat(4)}-4${d.repeat(3)}-8${d.repeat(3)}-${d.repeat(12)}`,
);
const [A1, A2] = ['3', '5'].map(d => `${d.repeat(8)}-${d.repeat(4)}-4${d.repeat(3)}-8${d.repeat(3)}-${d.repeat(12)}`);
const [base, head1, head2, merge1, merge2, gateHead] = ['0', '1', '2', '3', '4', '9'].map(d => d.repeat(40));
const command = { command: 'node', args: ['--test'], timeoutMs: 1000 };
const criterion = id => ({ id, text: 'Observable result', evidenceKinds: ['acceptance'] });
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const contracts = {
  normalizeDirectorRecord: (_kind, value) => structuredClone(value),
  assertDirectorSafe() {},
  isWaveProject: project => project.execution?.cadence === 'wave' && project.execution.integration === 'branch',
  dependencySatisfied: (project, status) =>
    (project.execution?.cadence === 'wave'
      ? ['integrated', 'accepted', 'released']
      : ['accepted', 'released']
    ).includes(status),
  gateBindingFor: gate => ({
    schemaVersion: 1,
    kind: 'gate',
    projectId: gate.projectId,
    gateId: gate.id,
    number: gate.number,
    runId: gate.runId,
    baseSha: gate.baseSha,
    headSha: gate.headSha,
    mergesHash: digest(gate.merges),
  }),
};
let serial = 0;
const ref = (kind, runId, headSha) => ({
  kind,
  runId,
  headSha,
  path: `C:/isolated-evidence/${kind}-${serial}.json`,
  sha256: (++serial).toString(16).padStart(64, '0'),
});
const config = {
  commands: { test: [command], build: [] },
  uiVerification: { enabled: false },
  security: { enabled: true },
  architecture: { enabled: false },
};

function taskRun(id, taskId, attemptId, headSha, mergeCommit, before) {
  return {
    id,
    project: 'C:/isolated-project',
    state: 'succeeded',
    headSha,
    baseSha: before,
    verificationProfile: 'task-fast',
    directorBinding: {
      schemaVersion: 1,
      projectId: P,
      taskId,
      taskRevision: 1,
      attemptId,
      runId: id,
      contractHash: 'c'.repeat(64),
    },
    config: structuredClone(config),
    checks: {
      schemaVersion: 2,
      profile: 'task-fast',
      headSha,
      fingerprint: 'f'.repeat(64),
      plan: [{ kind: 'test', command }],
      complete: true,
      results: [{ kind: 'test', command, exitCode: 0 }],
    },
    behavior: {
      schemaVersion: BEHAVIOR_GATE_VERSION,
      headSha,
      baseSha: before,
      configHash: verificationConfigHash(undefined),
      status: 'passed',
      passed: true,
      findings: [],
    },
    integration: { branch: `kodo/project/${P}`, before, mergeCommit, mergedHead: headSha, status: 'merged' },
  };
}

function gateFor(id, runId, number, containers, merges) {
  return {
    schemaVersion: 1,
    id,
    projectId: P,
    number,
    containers,
    runId,
    baseSha: merge2,
    headSha: gateHead,
    merges,
    installed: true,
    createdAt: '2026-11-17T00:00:00.000Z',
    updatedAt: '2026-11-17T00:00:00.000Z',
  };
}

function gateRun(gate) {
  return {
    id: gate.runId,
    project: 'C:/isolated-project',
    state: 'succeeded',
    headSha: gate.headSha,
    baseSha: gate.baseSha,
    directorBinding: contracts.gateBindingFor(gate),
    plan: { tasks: [{ id: 'gate' }] },
    nodes: { gate: { status: 'integrated', headSha: gate.headSha } },
    config: structuredClone(config),
    checks: {
      schemaVersion: 2,
      complete: true,
      headSha: gate.headSha,
      results: [{ kind: 'test', command, exitCode: 0 }],
    },
    review: { passed: true, headSha: gate.headSha },
    securityChecks: { status: 'passed', passed: true, headSha: gate.headSha },
    smoke: {
      schemaVersion: 1,
      headSha: gate.headSha,
      configured: true,
      complete: true,
      results: [{ command, exitCode: 0 }],
    },
  };
}

function fixture() {
  const record = (id, extra) => ({ id, projectId: P, evidence: [], mappings: [], ...extra });
  const task = (id, dependsOn = []) =>
    record(id, {
      epicId: 'epic',
      revision: 1,
      status: 'integrated',
      dependsOn,
      interfaceRefs: [],
      acceptance: [criterion(`${id}-done`)],
      riskApprovalRequired: false,
    });
  const attempt = (id, taskId, runId, headSha) => ({
    id,
    projectId: P,
    taskId,
    taskRevision: 1,
    number: 1,
    runId,
    contractHash: 'c'.repeat(64),
    status: 'integrated',
    headSha,
    evidence: [],
  });
  const merges = [
    { taskId: 'first', attemptId: A1, runId: R1, mergeCommit: merge1 },
    { taskId: 'second', attemptId: A2, runId: R2, mergeCommit: merge2 },
  ];
  const gate = gateFor(
    G1,
    G1,
    1,
    [
      { kind: 'epic', id: 'epic' },
      { kind: 'milestone', id: 'milestone' },
      { kind: 'project', id: P },
    ],
    merges,
  );
  const snapshot = {
    schemaVersion: 1,
    project: {
      id: 'project',
      projectId: P,
      revision: 7,
      status: 'integrated',
      paused: false,
      execution: { cadence: 'wave', integration: 'branch' },
      definitionOfDone: [criterion('project-done')],
      evidence: [],
      mappings: [],
    },
    revision: 7,
    milestones: [
      record('milestone', { status: 'integrated', releaseRequired: false, acceptance: [criterion('milestone-done')] }),
    ],
    epics: [record('epic', { milestoneId: 'milestone', status: 'integrated', acceptance: [criterion('epic-done')] })],
    tasks: [task('first'), task('second', ['first'])],
    currentAttempts: [attempt(A1, 'first', R1, head1), attempt(A2, 'second', R2, head2)],
    riskApprovals: [],
    gates: [gate],
    completeness: {},
  };
  const f = {
    snapshot,
    gate,
    runs: {
      first: taskRun(R1, 'first', A1, head1, merge1, base),
      second: taskRun(R2, 'second', A2, head2, merge2, merge1),
    },
    calls: { refs: 0, runs: 0 },
  };
  f.ports = {
    knownValues: [],
    contracts,
    verifyRef: async () => {
      await new Promise(resolve => setImmediate(resolve));
      f.calls.refs++;
    },
    validateRun: async () => {
      await new Promise(resolve => setImmediate(resolve));
      f.calls.runs++;
    },
  };
  return f;
}
function counts(snapshot) {
  for (const key of ['milestones', 'epics', 'tasks', 'currentAttempts', 'riskApprovals'])
    snapshot.completeness[key] = { total: snapshot[key].length, returned: snapshot[key].length, complete: true };
  return snapshot;
}
const transition = (f, kind, id, to, evidence = [], mappings = []) => ({
  schemaVersion: 1,
  commandId: '44444444-4444-4444-8444-444444444444',
  projectId: P,
  expectedRevision: 7,
  actor: 'coordinator',
  reason: 'Verified wave transition',
  action: { op: 'transition', kind, id, to, evidence, mappings },
});
// Evidence of the gate run on the gate head, mapped to the given criterion.
function gateProof(run, criterionId) {
  const evidence = ['acceptance', 'checks', 'review'].map(kind => ref(kind, run.id, run.headSha));
  return {
    evidence,
    mappings: [{ criterionId, refs: [evidence[0].sha256], actor: 'reviewer', reason: 'Gate verified the result' }],
  };
}
async function evaluate(f, { command, run = null, gate }) {
  const { evaluateWaveTransition } = await import('../runtime/project-wave-evidence.mjs');
  return evaluateWaveTransition({ command, snapshot: counts(f.snapshot), run, gate }, f.ports);
}
async function accept(f, kind, id, criterionId, { gate = f.gate, run = gateRun(gate), proof } = {}) {
  const { evidence, mappings } = proof ?? gateProof(run, criterionId);
  return evaluate(f, { command: transition(f, kind, id, 'accepted', evidence, mappings), run, gate });
}
const setStatus = (f, kind, id, status) => {
  f.snapshot[kind].find(row => row.id === id || row.taskId === id).status = status;
};

test('A task run proves integrated through fast checks and its merge, and never acceptance', async () => {
  const f = fixture();
  setStatus(f, 'tasks', 'first', 'verifying');
  setStatus(f, 'currentAttempts', 'first', 'verifying');
  const run = f.runs.first;
  const checks = [ref('checks', R1, head1)];
  const integrated = await evaluate(f, { command: transition(f, 'task', 'first', 'integrated', checks), run });
  assert.ok(integrated.eligibleStates.includes('integrated'));
  assert.ok(!integrated.eligibleStates.includes('accepted'));
  assert.deepEqual(integrated.blockers, []);
  assert.equal(f.calls.runs, 1);
  assert.equal(f.calls.refs, 1);
  setStatus(f, 'tasks', 'first', 'integrated');
  setStatus(f, 'currentAttempts', 'first', 'integrated');
  // The task's own run never accepts, even with complete review and mappings.
  const reviewed = { ...structuredClone(run), review: { passed: true, headSha: head1 } };
  const proof = gateProof(reviewed, 'first-done');
  for (const gate of [undefined, f.gate]) {
    const result = await accept(f, 'task', 'first', 'first-done', { run: reviewed, gate, proof });
    assert.ok(!result.eligibleStates.includes('accepted'));
    assert.deepEqual(result.blockers, ['wave_gate_missing']);
  }
});

for (const [name, mutate, blocker] of [
  ['full checks instead of task-fast', run => delete run.checks.profile, 'wave_fast_proof_missing'],
  ['incomplete fast checks', run => (run.checks.complete = false), 'wave_fast_proof_missing'],
  ['fast checks of another head', run => (run.checks.headSha = head2), 'wave_fast_proof_missing'],
  ['failed fast command', run => (run.checks.results[0].exitCode = 1), 'wave_fast_proof_missing'],
  ['missing behavior receipt', run => delete run.behavior, 'wave_fast_proof_missing'],
  ['behavior of another head', run => (run.behavior.headSha = head2), 'wave_fast_proof_missing'],
  ['unfinished run', run => (run.state = 'verifying'), 'wave_fast_proof_missing'],
  ['pending merge', run => (run.integration.status = 'pending'), 'wave_integration_missing'],
  ['merge of another head', run => (run.integration.mergedHead = head2), 'wave_integration_missing'],
  ['merge into another branch', run => (run.integration.branch = 'kodo/project/other'), 'wave_integration_missing'],
  ['missing integration', run => delete run.integration, 'wave_integration_missing'],
])
  test(`A task is not integrated with ${name}`, async () => {
    const f = fixture();
    setStatus(f, 'tasks', 'first', 'verifying');
    setStatus(f, 'currentAttempts', 'first', 'verifying');
    mutate(f.runs.first);
    const command = transition(f, 'attempt', A1, 'integrated', [ref('checks', R1, head1)]);
    const result = await evaluate(f, { command, run: f.runs.first });
    assert.ok(!result.eligibleStates.includes('integrated'));
    assert.deepEqual(result.blockers, [blocker]);
  });

test('A task without its own checks reference or binding is not integrated', async () => {
  const f = fixture();
  setStatus(f, 'tasks', 'first', 'verifying');
  setStatus(f, 'currentAttempts', 'first', 'verifying');
  const missing = await evaluate(f, { command: transition(f, 'task', 'first', 'integrated'), run: f.runs.first });
  assert.deepEqual(missing.blockers, ['wave_fast_proof_missing']);
  const command = transition(f, 'task', 'first', 'integrated', [ref('checks', R1, head1)]);
  const other = await evaluate(f, { command, run: f.runs.second });
  assert.deepEqual(other, {
    schemaVersion: 1,
    eligibleStates: [],
    blockers: ['attempt_binding_invalid'],
    evidence: [],
  });
});

test('A legacy snapshot is not a wave project and authorizes nothing', async () => {
  const f = fixture();
  setStatus(f, 'tasks', 'first', 'verifying');
  setStatus(f, 'currentAttempts', 'first', 'verifying');
  delete f.snapshot.project.execution;
  delete f.snapshot.gates;
  const command = transition(f, 'task', 'first', 'integrated', [ref('checks', R1, head1)]);
  const expected = { schemaVersion: 1, eligibleStates: [], blockers: ['wave_not_enabled'], evidence: [] };
  assert.deepEqual(await evaluate(f, { command, run: f.runs.first }), expected);
  assert.deepEqual(await accept(f, 'project', P, 'project-done'), expected);
  f.snapshot.project.execution = { cadence: 'task', integration: 'frontier' };
  assert.deepEqual(await evaluate(f, { command, run: f.runs.first }), expected);
  // Contracts without the wave predicate cannot enable the evaluator either.
  f.snapshot.project.execution = { cadence: 'wave', integration: 'branch' };
  f.ports.contracts = { ...contracts, isWaveProject: undefined };
  assert.deepEqual(await evaluate(f, { command, run: f.runs.first }), expected);
  assert.equal(f.calls.runs + f.calls.refs, 0);
});

test('A wave task becomes ready once its dependency is integrated', async () => {
  const f = fixture();
  setStatus(f, 'tasks', 'second', 'proposed');
  const ready = await evaluate(f, { command: transition(f, 'task', 'second', 'ready') });
  assert.deepEqual(ready.eligibleStates, ['ready']);
  setStatus(f, 'tasks', 'first', 'verifying');
  const blocked = await evaluate(f, { command: transition(f, 'task', 'second', 'ready') });
  assert.deepEqual(blocked.blockers, ['task_readiness_blocked']);
});

test('One current gate accepts tasks, then the epic, milestone and project', async () => {
  const f = fixture();
  const first = await accept(f, 'task', 'first', 'first-done');
  assert.ok(first.eligibleStates.includes('accepted'));
  assert.deepEqual(first.blockers, []);
  assert.equal(f.calls.runs, 1);
  assert.equal(f.calls.refs, 3);
  // The dependency is still only integrated but is covered by the same gate.
  const second = await accept(f, 'attempt', A2, 'second-done');
  assert.ok(second.eligibleStates.includes('accepted'));
  const early = await accept(f, 'epic', 'epic', 'epic-done');
  assert.deepEqual(early.blockers, ['children_not_accepted']);
  for (const id of ['first', 'second']) setStatus(f, 'tasks', id, 'accepted');
  for (const [kind, collection, id] of [
    ['epic', 'epics', 'epic'],
    ['milestone', 'milestones', 'milestone'],
    ['project', null, P],
  ]) {
    const result = await accept(f, kind, id, `${kind}-done`);
    assert.ok(result.eligibleStates.includes('accepted'), kind);
    assert.deepEqual(result.blockers, []);
    if (collection) setStatus(f, collection, id, 'accepted');
  }
});

test('A milestone gate may rely on epics accepted by an earlier gate', async () => {
  const f = fixture();
  f.gate.containers = [{ kind: 'epic', id: 'epic' }];
  const later = gateFor(G2, G2, 2, [{ kind: 'milestone', id: 'milestone' }], []);
  f.snapshot.gates.push(later);
  for (const id of ['first', 'second']) setStatus(f, 'tasks', id, 'accepted');
  assert.deepEqual((await accept(f, 'epic', 'epic', 'epic-done')).blockers, []);
  setStatus(f, 'epics', 'epic', 'accepted');
  const uncovered = await accept(f, 'milestone', 'milestone', 'milestone-done');
  assert.deepEqual(uncovered.blockers, ['wave_gate_missing']);
  const covered = await accept(f, 'milestone', 'milestone', 'milestone-done', { gate: later });
  assert.ok(covered.eligibleStates.includes('accepted'));
  assert.deepEqual((await accept(f, 'project', P, 'project-done', { gate: later })).blockers, ['wave_gate_missing']);
});

for (const [name, act, blocker] of [
  [
    'a superseded gate',
    f => {
      f.snapshot.gates.push(gateFor(G2, G2, 2, [{ kind: 'epic', id: 'epic' }], f.gate.merges));
      return accept(f, 'task', 'first', 'first-done');
    },
    'wave_gate_superseded',
  ],
  [
    'a gate without review',
    f => {
      const run = gateRun(f.gate);
      delete run.review;
      return accept(f, 'task', 'first', 'first-done', { run });
    },
    'wave_gate_proof_missing',
  ],
  [
    'a review of another head',
    f => {
      const run = gateRun(f.gate);
      run.review.headSha = head2;
      return accept(f, 'task', 'first', 'first-done', { run });
    },
    'wave_gate_proof_missing',
  ],
  [
    'a gate with incomplete smoke',
    f => {
      const run = gateRun(f.gate);
      run.smoke.complete = false;
      return accept(f, 'task', 'first', 'first-done', { run });
    },
    'wave_gate_proof_missing',
  ],
  [
    'task-fast checks on the gate',
    f => {
      const run = gateRun(f.gate);
      run.checks.profile = 'task-fast';
      return accept(f, 'task', 'first', 'first-done', { run });
    },
    'wave_gate_proof_missing',
  ],
  [
    'a failing enabled security gate',
    f => {
      const run = gateRun(f.gate);
      run.securityChecks.passed = false;
      return accept(f, 'task', 'first', 'first-done', { run });
    },
    'wave_gate_proof_missing',
  ],
  [
    'task refs instead of gate refs',
    f => {
      const proof = gateProof(f.runs.first, 'first-done');
      return accept(f, 'task', 'first', 'first-done', { proof });
    },
    'wave_gate_proof_missing',
  ],
  [
    'unmapped criteria',
    f => {
      const proof = gateProof(gateRun(f.gate), 'second-done');
      return accept(f, 'task', 'first', 'first-done', { proof });
    },
    'wave_gate_proof_missing',
  ],
  [
    'a gate run binding that is not byte-for-byte',
    f => {
      const run = gateRun(f.gate);
      const { schemaVersion, ...rest } = run.directorBinding;
      run.directorBinding = { ...rest, schemaVersion };
      return accept(f, 'task', 'first', 'first-done', { run });
    },
    'wave_gate_missing',
  ],
  [
    'a gate missing from the snapshot',
    f => {
      const gate = gateFor(G2, G2, 2, f.gate.containers, f.gate.merges);
      return accept(f, 'task', 'first', 'first-done', { gate });
    },
    'wave_gate_missing',
  ],
  [
    'an uncovered milestone',
    f => {
      f.gate.containers = [{ kind: 'epic', id: 'epic' }];
      setStatus(f, 'epics', 'epic', 'accepted');
      return accept(f, 'milestone', 'milestone', 'milestone-done');
    },
    'wave_gate_missing',
  ],
  [
    'a stale attempt in the gate merges',
    f => {
      f.gate.merges[0].attemptId = A2;
      return accept(f, 'task', 'first', 'first-done');
    },
    'wave_merges_mismatch',
  ],
  [
    'a task the gate did not merge',
    f => {
      f.gate.merges = f.gate.merges.slice(1);
      return accept(f, 'task', 'first', 'first-done');
    },
    'wave_merges_mismatch',
  ],
  [
    'an unaccepted dependency outside the gate',
    f => {
      f.gate.merges = f.gate.merges.slice(1);
      return accept(f, 'task', 'second', 'second-done');
    },
    'wave_dependency_unaccepted',
  ],
  [
    'a task that is not integrated yet',
    f => {
      setStatus(f, 'currentAttempts', 'first', 'verifying');
      return accept(f, 'task', 'first', 'first-done');
    },
    'wave_integration_missing',
  ],
  [
    'an incomplete gate list',
    f => {
      f.snapshot.completeness.gates = { total: 2, returned: 1, complete: false };
      return accept(f, 'task', 'first', 'first-done');
    },
    'project_transition_evidence_invalid',
  ],
])
  test(`Wave acceptance rejects ${name}`, async () => {
    const f = fixture();
    const result = await act(f);
    assert.ok(!result.eligibleStates.includes('accepted'));
    assert.deepEqual(result.blockers, [blocker]);
  });

test('A container advances through integrated only behind all of its children', async () => {
  const f = fixture();
  setStatus(f, 'epics', 'epic', 'verifying');
  const integrated = await evaluate(f, { command: transition(f, 'epic', 'epic', 'integrated') });
  assert.ok(integrated.eligibleStates.includes('integrated'));
  assert.deepEqual(integrated.blockers, []);
  setStatus(f, 'tasks', 'second', 'verifying');
  const blocked = await evaluate(f, { command: transition(f, 'epic', 'epic', 'integrated') });
  assert.ok(!blocked.eligibleStates.includes('integrated'));
  assert.deepEqual(blocked.blockers, ['container_progress_unverified']);
  const released = await evaluate(f, { command: transition(f, 'task', 'first', 'released') });
  assert.deepEqual(released.blockers, ['unsupported_evidence_transition']);
});
