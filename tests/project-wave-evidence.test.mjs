import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { BEHAVIOR_GATE_VERSION, verificationConfigHash } from '../runtime/behavior-gate.mjs';

const P = '11111111-1111-4111-8111-111111111111';
const [R1, R2, G1, G2] = ['2', '4', '6', '8'].map(
  d => `${d.repeat(8)}-${d.repeat(4)}-4${d.repeat(3)}-8${d.repeat(3)}-${d.repeat(12)}`,
);
const [A1, A2] = ['3', '5'].map(d => `${d.repeat(8)}-${d.repeat(4)}-4${d.repeat(3)}-8${d.repeat(3)}-${d.repeat(12)}`);
const [base, head1, head2, merge1, merge2, gateHead, repairedHead] = ['0', '1', '2', '3', '4', '9', '7'].map(d =>
  d.repeat(40),
);
const command = { command: 'node', args: ['--test'], timeoutMs: 1000 };
const smokeCommand = { command: 'node', args: ['smoke.mjs'] };
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
  commands: { test: [command], build: [], smoke: [smokeCommand] },
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

// A finished gate Run; `headSha` is its verified head (the gate head, or a repaired descendant).
function gateRun(gate, headSha = gate.headSha) {
  const log = { path: 'C:/isolated-evidence/smoke.json', sha256: 'e'.repeat(64), bytes: 10, headSha };
  return {
    id: gate.runId,
    project: 'C:/isolated-project',
    state: 'succeeded',
    headSha,
    baseSha: gate.baseSha,
    directorBinding: contracts.gateBindingFor(gate),
    plan: { tasks: [{ id: 'gate' }] },
    nodes: { gate: { status: 'integrated', headSha: gate.headSha } },
    config: structuredClone(config),
    checks: {
      schemaVersion: 2,
      complete: true,
      headSha,
      results: [{ kind: 'test', command, exitCode: 0 }],
    },
    review: { passed: true, headSha, diffHash: 'd'.repeat(64) },
    behavior: {
      schemaVersion: BEHAVIOR_GATE_VERSION,
      headSha,
      baseSha: gate.baseSha,
      configHash: verificationConfigHash(undefined),
      status: 'passed',
      passed: true,
      findings: [],
    },
    securityChecks: { status: 'passed', passed: true, headSha },
    smoke: {
      schemaVersion: 1,
      headSha,
      configured: true,
      complete: true,
      results: [{ ...smokeCommand, exitCode: 0, evidence: log, outputPath: log.path, outputHash: log.sha256 }],
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
async function evaluate(f, { command, run = null, gate, integrationHead }) {
  const { evaluateWaveTransition } = await import('../runtime/project-wave-evidence.mjs');
  return evaluateWaveTransition(
    { command, snapshot: counts(f.snapshot), run, gate, ...(integrationHead ? { integrationHead } : {}) },
    f.ports,
  );
}
// The integration head defaults to the gate's verified head (the project head rule holds).
async function accept(
  f,
  kind,
  id,
  criterionId,
  { gate = f.gate, run = gateRun(gate), proof, integrationHead = run?.headSha } = {},
) {
  const { evidence, mappings } = proof ?? gateProof(run, criterionId);
  return evaluate(f, { command: transition(f, kind, id, 'accepted', evidence, mappings), run, gate, integrationHead });
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
    // Review finding F1: a gate whose base is its head reviewed an empty diff.
    'a gate with an empty range (base = head)',
    f => {
      f.gate.baseSha = f.gate.headSha;
      return accept(f, 'task', 'first', 'first-done');
    },
    'wave_gate_missing',
  ],
  [
    'a gate whose review covered an empty diff',
    f => {
      const run = gateRun(f.gate);
      run.review.diffHash = createHash('sha256').update('').digest('hex');
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

// Review F1: acceptance requires every mandatory gate proof, exactly.
const gateWith = mutate => f => {
  const run = gateRun(f.gate);
  mutate(run, f);
  return accept(f, 'task', 'first', 'first-done', { run });
};
for (const [name, act, blocker] of [
  [
    'an uninstalled gate',
    f => {
      f.gate.installed = false;
      return accept(f, 'task', 'first', 'first-done');
    },
    'wave_gate_missing',
  ],
  ['an unfinished gate run', gateWith(run => (run.state = 'verifying')), 'wave_gate_proof_missing'],
  ['a gate run without a behaviour receipt', gateWith(run => delete run.behavior), 'wave_gate_proof_missing'],
  ['a behaviour receipt of another head', gateWith(run => (run.behavior.headSha = head1)), 'wave_gate_proof_missing'],
  ['a failed behaviour receipt', gateWith(run => (run.behavior.passed = false)), 'wave_gate_proof_missing'],
  [
    'an empty smoke receipt while smoke commands are configured',
    gateWith(run => Object.assign(run.smoke, { configured: false, results: [] })),
    'wave_gate_proof_missing',
  ],
  [
    'a configured smoke receipt without configured commands',
    gateWith(run => (run.config.commands.smoke = [])),
    'wave_gate_proof_missing',
  ],
  [
    'a smoke result for another command',
    gateWith(run => (run.smoke.results[0].args = ['other.mjs'])),
    'wave_gate_proof_missing',
  ],
  [
    'a missing smoke result',
    gateWith(run => run.config.commands.smoke.push({ command: 'node', args: ['second.mjs'] })),
    'wave_gate_proof_missing',
  ],
  ['a smoke result without its log', gateWith(run => delete run.smoke.results[0].evidence), 'wave_gate_proof_missing'],
  [
    'a smoke log of another head',
    gateWith(run => (run.smoke.results[0].evidence.headSha = head1)),
    'wave_gate_proof_missing',
  ],
  ['a failed smoke command', gateWith(run => (run.smoke.results[0].exitCode = 1)), 'wave_gate_proof_missing'],
])
  test(`Wave acceptance requires the mandatory gate proof: rejects ${name}`, async () => {
    const f = fixture();
    const result = await act(f);
    assert.ok(!result.eligibleStates.includes('accepted'));
    assert.deepEqual(result.blockers, [blocker]);
  });

test('A gate without configured smoke commands is accepted with an empty, unconfigured smoke receipt', async () => {
  const f = fixture();
  const run = gateRun(f.gate);
  run.config.commands.smoke = [];
  Object.assign(run.smoke, { configured: false, results: [] });
  const result = await accept(f, 'task', 'first', 'first-done', { run });
  assert.deepEqual(result.blockers, []);
  assert.ok(result.eligibleStates.includes('accepted'));
});

test('A repaired gate run is accepted on its verified head, never on the original gate head', async () => {
  const f = fixture();
  const repaired = gateRun(f.gate, repairedHead);
  assert.equal(repaired.directorBinding.headSha, gateHead, 'the binding keeps the gate head');
  const accepted = await accept(f, 'task', 'first', 'first-done', { run: repaired });
  assert.deepEqual(accepted.blockers, []);
  assert.ok(accepted.eligibleStates.includes('accepted'));
  // Refs and receipts of the gate head do not prove the repaired head.
  const stale = await accept(f, 'task', 'first', 'first-done', {
    run: repaired,
    proof: gateProof(gateRun(f.gate), 'first-done'),
  });
  assert.deepEqual(stale.blockers, ['wave_gate_proof_missing']);
  for (const field of ['checks', 'review', 'behavior', 'smoke']) {
    const run = gateRun(f.gate, repairedHead);
    run[field].headSha = gateHead;
    const result = await accept(f, 'task', 'first', 'first-done', { run, proof: gateProof(repaired, 'first-done') });
    assert.deepEqual(result.blockers, ['wave_gate_proof_missing'], field);
  }
});

test('The project is accepted only by a gate whose verified head is the integration head', async () => {
  const f = fixture();
  for (const id of ['first', 'second']) setStatus(f, 'tasks', id, 'accepted');
  setStatus(f, 'epics', 'epic', 'accepted');
  setStatus(f, 'milestones', 'milestone', 'accepted');
  const repaired = gateRun(f.gate, repairedHead);
  for (const integrationHead of [gateHead, merge2, null]) {
    const result = await accept(f, 'project', P, 'project-done', { run: repaired, integrationHead });
    assert.deepEqual(result.blockers, ['wave_project_head_mismatch'], String(integrationHead));
  }
  const merged = await accept(f, 'project', P, 'project-done', { run: repaired, integrationHead: repairedHead });
  assert.deepEqual(merged.blockers, []);
  assert.ok(merged.eligibleStates.includes('accepted'));
  // An epic is accepted on its verified gate head whatever the branch head is now.
  setStatus(f, 'epics', 'epic', 'integrated');
  const epic = await accept(f, 'epic', 'epic', 'epic-done', { run: repaired, integrationHead: merge2 });
  assert.deepEqual(epic.blockers, []);
});

test('A sibling epic gate sharing the milestone supersedes the gate only for the milestone', async () => {
  const f = fixture();
  // A second epic of the same milestone with its own integrated task and gate [other, milestone].
  const [A3, R3, G3] = ['a', 'b', 'c'].map(
    d => `${d.repeat(8)}-${d.repeat(4)}-4${d.repeat(3)}-8${d.repeat(3)}-${d.repeat(12)}`,
  );
  f.snapshot.epics.push({
    id: 'other',
    projectId: P,
    milestoneId: 'milestone',
    status: 'integrated',
    acceptance: [criterion('other-done')],
    evidence: [],
    mappings: [],
  });
  f.snapshot.tasks.push({
    ...structuredClone(f.snapshot.tasks[0]),
    id: 'third',
    epicId: 'other',
    acceptance: [criterion('third-done')],
  });
  f.snapshot.currentAttempts.push({
    ...structuredClone(f.snapshot.currentAttempts[0]),
    id: A3,
    taskId: 'third',
    runId: R3,
  });
  f.gate.containers = [
    { kind: 'epic', id: 'epic' },
    { kind: 'milestone', id: 'milestone' },
  ];
  const sibling = gateFor(
    G3,
    G3,
    2,
    [
      { kind: 'epic', id: 'other' },
      { kind: 'milestone', id: 'milestone' },
    ],
    [{ taskId: 'third', attemptId: A3, runId: R3, mergeCommit: merge2 }],
  );
  f.snapshot.gates.push(sibling);
  // The newer sibling gate does not replace the first gate for its own epic and tasks.
  for (const [kind, id] of [
    ['task', 'first'],
    ['attempt', A1],
  ])
    assert.deepEqual((await accept(f, kind, id, 'first-done')).blockers, [], kind);
  for (const id of ['first', 'second']) setStatus(f, 'tasks', id, 'accepted');
  assert.deepEqual((await accept(f, 'epic', 'epic', 'epic-done')).blockers, []);
  // For the shared milestone only the newest gate containing it counts.
  setStatus(f, 'epics', 'epic', 'accepted');
  setStatus(f, 'tasks', 'third', 'accepted');
  setStatus(f, 'epics', 'other', 'accepted');
  assert.deepEqual((await accept(f, 'milestone', 'milestone', 'milestone-done')).blockers, ['wave_gate_superseded']);
  const newest = await accept(f, 'milestone', 'milestone', 'milestone-done', { gate: sibling });
  assert.deepEqual(newest.blockers, []);
});
