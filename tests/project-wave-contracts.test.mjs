import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import * as C from '../runtime/project-contracts.mjs';
import { buildProjectProgress } from '../runtime/project-progress.mjs';
import { planProjectHorizon } from '../runtime/project-planner.mjs';

const sha = value => createHash('sha256').update(value).digest('hex');
const options = { knownValues: [] };
const clone = value => structuredClone(value);

// Legacy fixtures. The golden hashes below were captured on main 55fc4ba before
// the wave data layer existed; legacy bytes must never move.
const projectId = '11111111-1111-4111-8111-111111111111';
const commandId = '22222222-2222-4222-8222-222222222222';
const attemptId = '33333333-3333-4333-8333-333333333333';
const runId = '44444444-4444-4444-8444-444444444444';
const at = '2026-11-17T00:00:00.000Z';
const later = '2026-11-17T00:00:01.000Z';
const fixtureRoot = '/srv/kodo-fixture';
const criterion = { id: 'works', text: 'Observable result works', evidenceKinds: ['checks'] };
const ref = {
  kind: 'checks',
  runId: null,
  headSha: null,
  path: '/srv/kodo-evidence/checks.json',
  sha256: 'a'.repeat(64),
};
const mapping = { criterionId: 'works', refs: [ref.sha256], actor: 'reviewer', reason: 'Checked result' };
const milestoneSpec = (id = 'm', extra = {}) => ({
  id,
  title: 'Milestone ' + id,
  acceptance: [criterion],
  releaseRequired: false,
  ...extra,
});
const epicSpec = (id = 'e', milestoneId = 'm', extra = {}) => ({
  id,
  milestoneId,
  title: 'Epic ' + id,
  acceptance: [criterion],
  ...extra,
});
const taskSpec = (id, extra = {}) => ({
  id,
  epicId: 'e',
  title: 'Task ' + id,
  description: 'Deliver observable behavior ' + id,
  owner: 'developer',
  dependsOn: [],
  writePaths: ['runtime/' + id + '.mjs'],
  acceptance: [criterion],
  interfaceRefs: [],
  priority: 50,
  userValue: 3,
  risk: 1,
  estimatedEffort: 2,
  riskApprovalRequired: false,
  ...extra,
});
function legacySpec(root = fixtureRoot) {
  return {
    schemaVersion: 1,
    id: 'sample',
    root,
    title: 'Sample project',
    definitionOfDone: [criterion],
    constraints: ['Only assigned work'],
    businessContext: 'Owned fixture',
    architectureRefs: [ref],
    milestones: [milestoneSpec()],
    epics: [epicSpec()],
    tasks: [taskSpec('a'), taskSpec('b', { dependsOn: ['a'], riskApprovalRequired: true })],
  };
}
const meta = (revision, status, extra = {}) => ({
  schemaVersion: 1,
  projectId,
  revision,
  status,
  createdAt: at,
  updatedAt: later,
  evidence: [],
  mappings: [],
  ...extra,
});
function legacyProject(extra = {}) {
  const { milestones, epics, tasks, ...header } = legacySpec();
  return {
    ...header,
    projectId,
    projectKey: fixtureRoot,
    status: 'running',
    paused: false,
    revision: 5,
    createdAt: at,
    updatedAt: later,
    evidence: [ref],
    mappings: [mapping],
    ...extra,
  };
}
function legacySnapshot(projectExtra = {}) {
  const spec = legacySpec();
  const project = legacyProject(projectExtra);
  const tasks = [
    { ...spec.tasks[0], ...meta(2, 'accepted', { evidence: [ref], mappings: [mapping] }) },
    { ...spec.tasks[1], ...meta(1, 'proposed') },
  ];
  const currentAttempts = [
    {
      schemaVersion: 1,
      id: attemptId,
      projectId,
      taskId: 'a',
      taskRevision: 2,
      number: 1,
      runId,
      contractHash: 'd'.repeat(64),
      status: 'accepted',
      baseSha: '1'.repeat(40),
      headSha: '2'.repeat(40),
      evidence: [ref],
      reason: null,
      createdAt: at,
      updatedAt: later,
    },
  ];
  const riskApprovals = [
    { schemaVersion: 1, projectId, taskId: 'b', taskRevision: 1, actor: 'owner', reason: 'Approve', approvedAt: at },
  ];
  const value = {
    schemaVersion: 1,
    project,
    revision: project.revision,
    milestones: [{ ...spec.milestones[0], ...meta(1, 'running') }],
    epics: [{ ...spec.epics[0], ...meta(1, 'running') }],
    tasks,
    currentAttempts,
    riskApprovals,
    completeness: {},
  };
  for (const key of ['milestones', 'epics', 'tasks', 'currentAttempts', 'riskApprovals'])
    value.completeness[key] = { total: value[key].length, returned: value[key].length, complete: true };
  return value;
}
const legacyEvent = () => ({
  schemaVersion: 1,
  seq: 3,
  projectId,
  at,
  commandId,
  actor: 'owner',
  reason: 'Move work',
  entity: { kind: 'task', id: 'b' },
  type: 'transition',
  previousHash: 'b'.repeat(64),
  nextHash: 'c'.repeat(64),
});
const legacyCommand = (action, extra = {}) => ({
  schemaVersion: 1,
  commandId,
  projectId,
  expectedRevision: 5,
  actor: 'owner',
  reason: 'Move work',
  action,
  ...extra,
});
const legacyCommands = () => ({
  create: legacyCommand({ op: 'create', spec: legacySpec() }, { projectId: null, expectedRevision: null }),
  transition: legacyCommand({ op: 'transition', kind: 'task', id: 'b', to: 'ready', evidence: [], mappings: [] }),
  reserveAttempt: legacyCommand({ op: 'reserveAttempt', taskId: 'b', retryFailed: false }),
  insert: legacyCommand({ op: 'insert', kind: 'task', record: taskSpec('c') }),
  setPaused: legacyCommand({ op: 'setPaused', paused: true }),
});
const legacyBinding = () => ({
  schemaVersion: 1,
  projectId,
  taskId: 'b',
  taskRevision: 1,
  attemptId,
  runId,
  contractHash: 'd'.repeat(64),
});
const golden = {
  projectSpec: 'e94222afc32c0ba9057e38257af80c45fa3a488c84e73ed94b17120062bdf0b3',
  project: 'e783aa553d6abfccec5f59d2c8dfb5837645c0a4f4afd3523d596816ada210ba',
  snapshot: '04aeacccee8a489f084d626d6cb84d0294edad276df716b39dc105e5eef9be20',
  event: '1f4b24a6c3789bf6e4d0fa621fce05fd13061b0bc9b1db9e4a53c0bbaf6e84f6',
  'command.create': '8de555ea33fe67c2fa7fde81225472508eda1cf8a66b57273344dc8b73d4c348',
  'command.transition': '25f76abd5a921d7934eab02b1f1e25c950116c09f323c68567b164bd0a063b3c',
  'command.reserveAttempt': '4833a268b1ec119b91575b0b3d58e17951456dad0afaead423ebf57bfcbc7b5d',
  'command.insert': 'fb72546c069bc24fe986ec1157f5288bc7e272ce992eba6fa0e6b03644c6fa8f',
  'command.setPaused': '7b2ba2634e610f28ebc637831ba1de909baa29808c894544bb22e2e64bddf305',
  installBinding: '9e6e9e2b7448f2f4ea9832a5c11eff9058ac56ecfc0cc6b15e937de9a3ad6b97',
  taskInput: 'f0d7bb1d16eafefeaa01a908d9e435b6b22a0bf8c5b7b2d73a30146fa74e65de',
  contractHash: '3a89ed19bafe15c5c0cd1cdc35e6229138a2a19da273c1e678884b623d2f2780',
  progress: 'd3e2329495b120e2f05b3a12deb52b25ffbe0c904ea26a52e6aeed8a22ae601d',
  plan: 'c3dcf571b41f27c1b56a6b8aabdffd1b2856c0c6b4805dcf7be0321fe538fb46',
};

const wave = { cadence: 'wave', integration: 'branch' };
function waveSnapshot(projectExtra = {}, gates = []) {
  const value = legacySnapshot({ execution: clone(wave), ...projectExtra });
  value.gates = gates;
  value.completeness.gates = { total: gates.length, returned: gates.length, complete: true };
  return value;
}
// A closed (accepted) wave project whose every child and attempt is settled.
function closedWave(projectExtra = {}) {
  const value = waveSnapshot({ status: 'accepted', ...projectExtra });
  for (const key of ['milestones', 'epics', 'tasks']) for (const row of value[key]) row.status = 'accepted';
  value.tasks[1].evidence = [ref];
  value.tasks[1].mappings = [mapping];
  return value;
}
const append = (extra = {}) => ({
  op: 'appendMilestone',
  milestone: milestoneSpec('m2'),
  epics: [epicSpec('e2', 'm2')],
  tasks: [taskSpec('c', { epicId: 'e2', dependsOn: ['a'] }), taskSpec('d', { epicId: 'e2', dependsOn: ['c'] })],
  ...extra,
});
const gateRecord = (extra = {}) => ({
  schemaVersion: 1,
  id: '55555555-5555-4555-8555-555555555555',
  projectId,
  number: 1,
  containers: [
    { kind: 'epic', id: 'e' },
    { kind: 'milestone', id: 'm' },
    { kind: 'project', id: projectId },
  ],
  runId: '66666666-6666-4666-8666-666666666666',
  baseSha: '1'.repeat(40),
  headSha: '3'.repeat(40),
  merges: [
    {
      taskId: 'b',
      attemptId: '77777777-7777-4777-8777-777777777777',
      runId: '88888888-8888-4888-8888-888888888888',
      mergeCommit: '5'.repeat(40),
    },
    { taskId: 'a', attemptId, runId, mergeCommit: '4'.repeat(40) },
  ],
  installed: false,
  createdAt: at,
  updatedAt: at,
  ...extra,
});

test('Legacy spec, record, snapshot, event, command, prompt, progress and plan bytes stay golden', () => {
  const bytes = (kind, value) => sha(C.directorBytes(kind, value, options));
  const actual = {
    projectSpec: bytes('projectSpec', legacySpec()),
    project: bytes('project', legacyProject()),
    snapshot: bytes('snapshot', legacySnapshot()),
    event: bytes('event', legacyEvent()),
    installBinding: bytes('installBinding', legacyBinding()),
  };
  for (const [name, command] of Object.entries(legacyCommands())) actual['command.' + name] = bytes('command', command);
  const snap = C.normalizeDirectorRecord('snapshot', legacySnapshot(), options);
  actual.taskInput = sha(C.buildDirectorTaskInput({ project: snap.project, task: snap.tasks[1] }, options));
  actual.contractHash = C.directorContractHash(snap.tasks[1], options);
  actual.progress = sha(buildProjectProgress(snap));
  const availability = snap.tasks.map(t => ({ taskId: t.id, available: true, interfacesVerified: true, reason: null }));
  actual.plan = sha(
    JSON.stringify(
      planProjectHorizon(
        { snapshot: legacySnapshot(), limit: 24, availability, now: later },
        { contracts: C, knownValues: [] },
      ),
    ),
  );
  assert.deepEqual(actual, golden);
  assert.equal(Object.hasOwn(snap, 'gates'), false);
  assert.equal(Object.hasOwn(snap.completeness, 'gates'), false);
  assert.equal(Object.hasOwn(snap.project, 'execution'), false);
  assert.doesNotMatch(buildProjectProgress(snap), /^gates:/m);
});

test('Execution accepts only task/frontier and wave/branch and is emitted after the required fields', () => {
  for (const execution of [
    { cadence: 'task', integration: 'frontier' },
    { cadence: 'wave', integration: 'branch' },
    { cadence: 'wave', integration: 'branch', watchdog: { stalledRounds: null, rejectUnchanged: false } },
    { cadence: 'wave', integration: 'branch', watchdog: { stalledRounds: 5, rejectUnchanged: true } },
  ]) {
    const spec = C.normalizeProjectSpec({ ...legacySpec(), execution }, options);
    assert.deepEqual(Object.keys(spec).slice(-4), ['milestones', 'epics', 'tasks', 'execution']);
    assert.deepEqual(spec.execution, execution);
    const project = C.normalizeDirectorRecord('project', legacyProject({ execution }), options);
    assert.deepEqual(Object.keys(project).slice(-3), ['evidence', 'mappings', 'execution']);
  }
  for (const execution of [
    { cadence: 'wave', integration: 'frontier' },
    { cadence: 'task', integration: 'branch' },
    { cadence: 'drain', integration: 'branch' },
  ]) {
    assert.throws(() => C.normalizeProjectSpec({ ...legacySpec(), execution }, options), {
      code: 'project_execution_unsupported',
    });
    assert.throws(() => C.normalizeDirectorRecord('project', legacyProject({ execution }), options), {
      code: 'project_execution_unsupported',
    });
  }
  for (const execution of [
    { ...wave, parallel: 4 },
    { cadence: 'wave' },
    { ...wave, watchdog: { stalledRounds: 6, rejectUnchanged: true } },
    { ...wave, watchdog: { stalledRounds: 0, rejectUnchanged: true } },
    { ...wave, watchdog: { stalledRounds: 2, rejectUnchanged: true, extra: true } },
    { ...wave, watchdog: { stalledRounds: 2 } },
    null,
  ])
    assert.throws(() => C.normalizeProjectSpec({ ...legacySpec(), execution }, options), { code: 'project_schema' });
  // reopened belongs only to a stored wave project record, never to a ProjectSpec.
  const reopened = [{ status: 'accepted', revision: 4, reopenedAt: at, evidence: [ref], mappings: [mapping] }];
  assert.throws(() => C.normalizeProjectSpec({ ...legacySpec(), execution: wave, reopened }, options), {
    code: 'project_schema',
  });
  assert.throws(() => C.normalizeDirectorRecord('project', legacyProject({ reopened }), options), {
    code: 'project_schema',
  });
  const stored = C.normalizeDirectorRecord('project', legacyProject({ execution: wave, reopened }), options);
  assert.deepEqual(stored.reopened, reopened);
  assert.deepEqual(Object.keys(stored).slice(-2), ['execution', 'reopened']);
  assert.throws(
    () =>
      C.normalizeDirectorRecord(
        'project',
        legacyProject({
          execution: wave,
          reopened: [{ ...reopened[0], mappings: [{ ...mapping, refs: ['f'.repeat(64)] }] }],
        }),
        options,
      ),
    { code: 'project_mapping' },
  );
  assert.throws(() =>
    C.normalizeDirectorRecord(
      'project',
      legacyProject({ execution: wave, reopened: Array(101).fill(reopened[0]) }),
      options,
    ),
  );
});

test('Task prompts and contract hashes do not depend on execution', () => {
  const legacy = C.normalizeDirectorRecord('snapshot', legacySnapshot(), options);
  const waved = C.normalizeDirectorRecord('snapshot', waveSnapshot(), options);
  for (const index of [0, 1]) {
    assert.equal(
      C.buildDirectorTaskInput({ project: waved.project, task: waved.tasks[index] }, options),
      C.buildDirectorTaskInput({ project: legacy.project, task: legacy.tasks[index] }, options),
    );
    assert.equal(
      C.directorContractHash(waved.tasks[index], options),
      C.directorContractHash(legacy.tasks[index], options),
    );
  }
});

test('Wave dependency rule admits integrated prerequisites only for wave projects', () => {
  assert.equal(C.isWaveProject(legacyProject()), false);
  assert.equal(C.isWaveProject(legacyProject({ execution: { cadence: 'task', integration: 'frontier' } })), false);
  assert.equal(C.isWaveProject(legacyProject({ execution: wave })), true);
  for (const status of ['accepted', 'released']) {
    assert.equal(C.dependencySatisfied(legacyProject(), status), true);
    assert.equal(C.dependencySatisfied(legacyProject({ execution: wave }), status), true);
  }
  assert.equal(C.dependencySatisfied(legacyProject(), 'integrated'), false);
  assert.equal(C.dependencySatisfied(legacyProject({ execution: wave }), 'integrated'), true);
  for (const status of ['proposed', 'ready', 'running', 'verifying', 'blocked', 'failed', 'cancelled']) {
    assert.equal(C.dependencySatisfied(legacyProject({ execution: wave }), status), false, status);
    assert.equal(C.dependencySatisfied(legacyProject(), status), false, status);
  }
  const transition = s =>
    C.assertProjectTransition({ record: s.tasks[1], to: 'ready', snapshot: s, evidence: [], mappings: [] });
  const integratedWave = waveSnapshot();
  integratedWave.tasks[0].status = 'integrated';
  assert.doesNotThrow(() => transition(integratedWave));
  const integratedLegacy = legacySnapshot();
  integratedLegacy.tasks[0].status = 'integrated';
  assert.throws(() => transition(integratedLegacy), { code: 'project_dependency' });
  const verifyingWave = waveSnapshot();
  verifyingWave.tasks[0].status = 'verifying';
  assert.throws(() => transition(verifyingWave), { code: 'project_dependency' });
  assert.doesNotThrow(() => transition(legacySnapshot()));
});

test('Accepted projects still cannot transition back to running; reopening is a separate operation', () => {
  const s = closedWave();
  assert.throws(
    () => C.assertProjectTransition({ record: s.project, to: 'running', snapshot: s, evidence: [], mappings: [] }),
    { code: 'project_transition' },
  );
});

test('Wave snapshots carry gates, legacy snapshots must not', () => {
  const normalized = C.normalizeDirectorRecord('snapshot', waveSnapshot({}, [gateRecord()]), options);
  assert.deepEqual(Object.keys(normalized).slice(-2), ['completeness', 'gates']);
  assert.deepEqual(Object.keys(normalized.completeness).at(-1), 'gates');
  assert.equal(normalized.gates[0].id, gateRecord().id);
  const missing = waveSnapshot();
  delete missing.gates;
  delete missing.completeness.gates;
  assert.throws(() => C.normalizeDirectorRecord('snapshot', missing, options), { code: 'project_schema' });
  const extra = legacySnapshot();
  extra.gates = [];
  extra.completeness.gates = { total: 0, returned: 0, complete: true };
  assert.throws(() => C.normalizeDirectorRecord('snapshot', extra, options), { code: 'project_schema' });
  const foreign = waveSnapshot({}, [gateRecord({ projectId: '99999999-9999-4999-8999-999999999999' })]);
  assert.throws(() => C.normalizeDirectorRecord('snapshot', foreign, options));
  const duplicateRun = waveSnapshot({}, [
    gateRecord(),
    gateRecord({ id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', number: 2 }),
  ]);
  assert.throws(() => C.normalizeDirectorRecord('snapshot', duplicateRun, options), { code: 'project_identity' });
  const incomplete = waveSnapshot({}, [gateRecord()]);
  incomplete.completeness.gates = { total: 2, returned: 1, complete: false };
  assert.throws(
    () =>
      C.assertProjectTransition({
        record: incomplete.tasks[1],
        to: 'ready',
        snapshot: incomplete,
        evidence: [],
        mappings: [],
      }),
    { code: 'project_completeness' },
  );
});

test('Gate records validate the epic-milestone-project chain and merges', () => {
  assert.deepEqual(C.normalizeDirectorRecord('gate', gateRecord(), options), gateRecord());
  for (const containers of [
    [{ kind: 'project', id: projectId }],
    [{ kind: 'milestone', id: 'm' }],
    [{ kind: 'epic', id: 'e' }],
    [
      { kind: 'milestone', id: 'm' },
      { kind: 'project', id: projectId },
    ],
  ])
    assert.doesNotThrow(() => C.normalizeDirectorRecord('gate', gateRecord({ containers }), options));
  for (const containers of [
    [],
    [
      { kind: 'milestone', id: 'm' },
      { kind: 'epic', id: 'e' },
    ],
    [
      { kind: 'epic', id: 'e' },
      { kind: 'project', id: projectId },
    ],
    [
      { kind: 'epic', id: 'e' },
      { kind: 'epic', id: 'e2' },
    ],
    [{ kind: 'task', id: 'a' }],
    [{ kind: 'project', id: 'not-a-uuid' }],
    [{ kind: 'epic', id: projectId }],
  ])
    assert.throws(
      () => C.normalizeDirectorRecord('gate', gateRecord({ containers }), options),
      JSON.stringify(containers),
    );
  assert.throws(
    () =>
      C.normalizeDirectorRecord(
        'gate',
        gateRecord({ containers: [{ kind: 'project', id: '99999999-9999-4999-8999-999999999999' }] }),
        options,
      ),
    { code: 'project_identity' },
  );
  assert.throws(() => C.normalizeDirectorRecord('gate', gateRecord({ merges: [] }), options));
  const twice = gateRecord().merges[1];
  assert.throws(() => C.normalizeDirectorRecord('gate', gateRecord({ merges: [twice, twice] }), options));
  assert.throws(() => C.normalizeDirectorRecord('gate', gateRecord({ merges: Array(1001).fill(twice) }), options));
  assert.throws(() => C.normalizeDirectorRecord('gate', gateRecord({ installed: 0 }), options));
  assert.throws(() =>
    C.normalizeDirectorRecord('gate', gateRecord({ updatedAt: '2026-11-16T00:00:00.000Z' }), options),
  );
  // A reservation replaced before its install names its successor; absent, the bytes are unchanged.
  const successor = '99999999-9999-4999-8999-999999999990';
  const superseded = gateRecord({ supersededBy: successor });
  assert.deepEqual(C.normalizeDirectorRecord('gate', superseded, options), superseded);
  assert.equal(JSON.stringify(C.normalizeDirectorRecord('gate', gateRecord(), options)), JSON.stringify(gateRecord()));
  for (const bad of [
    gateRecord({ installed: true, supersededBy: successor }),
    gateRecord({ supersededBy: gateRecord().id }),
  ])
    assert.throws(() => C.normalizeDirectorRecord('gate', bad, options), { code: 'project_gate_invalid' });
});

test('Gate binding hashes canonical merges and gate input is bounded and execution-free', () => {
  const gate = gateRecord();
  const binding = C.gateBindingFor(gate);
  assert.deepEqual(binding, {
    schemaVersion: 1,
    kind: 'gate',
    projectId,
    gateId: gate.id,
    number: 1,
    runId: gate.runId,
    baseSha: gate.baseSha,
    headSha: gate.headSha,
    mergesHash: sha(JSON.stringify(gate.merges)),
  });
  assert.deepEqual(C.gateBindingFor(gate, options), binding);
  // Key order of the caller's merge objects is canonicalized before hashing.
  const reordered = gateRecord({
    merges: gate.merges.map(({ mergeCommit, runId: r, attemptId: a, taskId }) => ({
      mergeCommit,
      runId: r,
      attemptId: a,
      taskId,
    })),
  });
  assert.equal(C.gateBindingFor(reordered).mergesHash, binding.mergesHash);
  assert.notEqual(C.gateBindingFor(gateRecord({ merges: [...gate.merges].reverse() })).mergesHash, binding.mergesHash);
  assert.deepEqual(C.normalizeDirectorRecord('gateBinding', binding, options), binding);
  assert.throws(() => C.normalizeDirectorRecord('gateBinding', { ...binding, kind: 'task' }, options));
  assert.throws(() => C.normalizeDirectorRecord('gateBinding', { ...binding, extra: 1 }, options));

  const s = C.normalizeDirectorRecord('snapshot', waveSnapshot(), options);
  const containers = C.gateContainerCriteria(s, gate);
  const text = C.buildGateInput({ project: s.project, gate, tasks: s.tasks, containers });
  assert.equal(
    C.buildGateInput({ project: s.project, gate, tasks: [...s.tasks].reverse(), containers }, options),
    text,
  );
  const newline = text.indexOf('\n');
  assert.ok(newline > 0);
  // The Run text is a compact summary bound to the gate manifest by its SHA-256.
  const body = JSON.parse(text.slice(newline + 1));
  assert.deepEqual(Object.keys(body), ['schemaVersion', 'projectId', 'gate', 'taskCount', 'manifest']);
  assert.equal(body.schemaVersion, 2);
  assert.equal(body.projectId, projectId);
  assert.deepEqual(body.gate, { containers: gate.containers, baseSha: gate.baseSha, headSha: gate.headSha });
  assert.equal(body.taskCount, 2);
  const built = C.buildGateManifest({ project: s.project, gate, tasks: s.tasks, containers });
  assert.deepEqual(body.manifest, { kind: 'gate-manifest', sha256: built.sha256, bytes: built.bytes });
  assert.equal(built.sha256, sha(JSON.stringify(built.manifest)));
  assert.equal(built.bytes, Buffer.byteLength(JSON.stringify(built.manifest)));
  // The manifest holds the frozen contracts of every covered task in merge order and the
  // acceptance criteria of every covered container (review finding: epic criteria were missing).
  const manifest = built.manifest;
  assert.deepEqual(Object.keys(manifest), ['schemaVersion', 'projectContext', 'gate', 'containers', 'tasks']);
  assert.equal(manifest.schemaVersion, 2);
  assert.deepEqual(manifest.containers, [
    { kind: 'epic', id: 'e', criteria: s.epics[0].acceptance },
    { kind: 'milestone', id: 'm', criteria: s.milestones[0].acceptance },
    { kind: 'project', id: projectId, criteria: s.project.definitionOfDone },
  ]);
  assert.deepEqual(manifest.gate, body.gate);
  assert.deepEqual(
    manifest.tasks.map(t => t.taskId),
    ['b', 'a'],
  );
  const taskInput = JSON.parse(
    C.buildDirectorTaskInput({ project: s.project, task: s.tasks[1] }, options).split('\n')[1],
  );
  assert.deepEqual(manifest.projectContext, taskInput.projectContext);
  assert.deepEqual(manifest.tasks[0], taskInput.task);
  assert.doesNotMatch(text, /execution|wave/);
  assert.doesNotMatch(JSON.stringify(manifest), /execution|wave/);
  assert.throws(() => C.buildGateInput({ project: s.project, gate, tasks: [s.tasks[0]], containers }), {
    code: 'project_identity',
  });
  const legacy = C.normalizeDirectorRecord('snapshot', legacySnapshot(), options);
  assert.throws(() => C.buildGateInput({ project: legacy.project, gate, tasks: legacy.tasks, containers }), {
    code: 'project_gate_unsupported',
  });
  assert.throws(() => C.buildGateInput({ project: s.project, gate, tasks: s.tasks, containers, extra: 1 }));
  // Containers must be the gate's own, in order, with the project's definition of done.
  for (const bad of [containers.slice(1), [...containers].reverse(), containers.slice(0, 2)])
    assert.throws(() => C.buildGateInput({ project: s.project, gate, tasks: s.tasks, containers: bad }), {
      code: 'project_identity',
    });
  assert.throws(() => C.buildGateInput({ project: s.project, gate, tasks: s.tasks }));
  assert.throws(
    () =>
      C.buildGateInput({ project: s.project, gate, tasks: s.tasks, containers }, { knownValues: ['Owned fixture'] }),
    {
      code: 'project_unsafe',
    },
  );

  // Review finding F1-4: the size of the covered contracts no longer bounds the gate input;
  // tasks that overflowed the 64 KiB Run text are carried by the manifest.
  const ids = Array.from({ length: 7 }, (_, i) => 'big-' + i);
  const tasks = ids.map(id => ({ ...taskSpec(id, { description: 'x'.repeat(11000) }), ...meta(1, 'integrated') }));
  const merges = ids.map((taskId, i) => ({
    taskId,
    attemptId: `${String(i + 1).padStart(8, '0')}-0000-4000-8000-000000000000`,
    runId: `${String(i + 1).padStart(8, '0')}-1111-4111-8111-111111111111`,
    mergeCommit: String(i + 1).repeat(40),
  }));
  const big = C.buildGateInput({ project: s.project, gate: gateRecord({ merges }), tasks, containers });
  assert.ok(Buffer.byteLength(big) < 2048, 'a compact summary');
  const bigManifest = C.buildGateManifest({ project: s.project, gate: gateRecord({ merges }), tasks, containers });
  assert.ok(bigManifest.bytes > 7 * 11000);
  assert.equal(bigManifest.manifest.tasks.length, 7);
  assert.equal(JSON.parse(big.slice(big.indexOf('\n') + 1)).manifest.sha256, bigManifest.sha256);
});

test('appendMilestone and reserveGate actions normalize strictly; events accept gate entities', () => {
  const command = action => legacyCommand(action);
  const normalized = C.normalizeDirectorRecord('command', command(append()), options);
  assert.deepEqual(normalized.action, append());
  for (const bad of [
    append({ epics: [] }),
    append({ tasks: [] }),
    append({ extra: true }),
    append({ epics: [epicSpec('e2', 'm2'), epicSpec('e2', 'm2')] }),
    { op: 'appendMilestone', milestone: milestoneSpec('m2'), epics: [epicSpec('e2', 'm2')] },
  ])
    assert.throws(() => C.normalizeDirectorRecord('command', command(bad), options));
  const reserve = {
    op: 'reserveGate',
    containers: gateRecord().containers,
    baseSha: '1'.repeat(40),
    headSha: '3'.repeat(40),
    merges: gateRecord().merges,
    retry: false,
  };
  assert.deepEqual(C.normalizeDirectorRecord('command', command(reserve), options).action, reserve);
  for (const bad of [
    { ...reserve, retry: 'yes' },
    { ...reserve, merges: [] },
    { ...reserve, baseSha: 'main' },
    { ...reserve, containers: [...reserve.containers].reverse() },
    { ...reserve, extra: 1 },
  ])
    assert.throws(() => C.normalizeDirectorRecord('command', command(bad), options));
  assert.throws(
    () =>
      C.normalizeDirectorRecord(
        'command',
        legacyCommand(reserve, { projectId: '99999999-9999-4999-8999-999999999999' }),
        options,
      ),
    { code: 'project_identity' },
  );
  const event = { ...legacyEvent(), type: 'reserveGate', entity: { kind: 'gate', id: gateRecord().id } };
  assert.deepEqual(C.normalizeDirectorRecord('event', event, options).entity, event.entity);
  assert.throws(() =>
    C.normalizeDirectorRecord('event', { ...event, entity: { kind: 'gate', id: 'slug-id' } }, options),
  );
  // Transitions never target gate records.
  assert.throws(() =>
    C.normalizeDirectorRecord(
      'command',
      command({ op: 'transition', kind: 'gate', id: gateRecord().id, to: 'accepted', evidence: [], mappings: [] }),
      options,
    ),
  );
});

test('assertProjectReopen admits only new closed-dependency work under a new milestone', () => {
  const reopen = (snapshot, action = append()) => C.assertProjectReopen({ snapshot, action });
  assert.doesNotThrow(() => reopen(closedWave()));
  assert.doesNotThrow(() => reopen(closedWave({ status: 'released' })));
  assert.doesNotThrow(() => reopen(closedWave({ reopened: [] })));
  // Project state.
  for (const snapshot of [
    closedWave({ status: 'running' }),
    closedWave({ status: 'integrated' }),
    closedWave({ paused: true }),
    (() => {
      const s = closedWave({ status: 'accepted' });
      delete s.project.execution;
      delete s.gates;
      delete s.completeness.gates;
      return s;
    })(),
    (() => {
      const s = closedWave();
      s.currentAttempts[0].status = 'integrated';
      return s;
    })(),
    (() => {
      const s = closedWave();
      s.completeness.tasks = { total: 3, returned: 2, complete: false };
      return s;
    })(),
  ])
    assert.throws(() => reopen(snapshot), { code: 'project_append_blocked' });
  for (const status of ['cancelled', 'failed'])
    assert.throws(() => reopen(closedWave({ status })), { code: 'project_append_blocked' });
  // Identity.
  for (const action of [
    append({ milestone: milestoneSpec('m') }),
    append({ epics: [epicSpec('e', 'm2')], tasks: [taskSpec('c', { epicId: 'e' })] }),
    append({ tasks: [taskSpec('a', { epicId: 'e2' })] }),
  ])
    assert.throws(() => reopen(closedWave(), action), { code: 'project_identity_conflict' });
  // Foreign parents.
  for (const action of [
    append({ epics: [epicSpec('e2', 'm')] }),
    append({ tasks: [taskSpec('c', { epicId: 'e' })] }),
    append({ tasks: [taskSpec('c', { epicId: 'missing' })] }),
  ])
    assert.throws(() => reopen(closedWave(), action), { code: 'project_parent_invalid' });
  // Dependencies: cycles, missing work and work that is not closed.
  for (const tasks of [
    [taskSpec('c', { epicId: 'e2', dependsOn: ['d'] }), taskSpec('d', { epicId: 'e2', dependsOn: ['c'] })],
    [taskSpec('c', { epicId: 'e2', dependsOn: ['c'] })],
    [taskSpec('c', { epicId: 'e2', dependsOn: ['missing'] })],
  ])
    assert.throws(() => reopen(closedWave(), append({ tasks })), { code: 'project_dependency_invalid' });
  for (const status of ['integrated', 'verifying', 'cancelled', 'blocked']) {
    const s = closedWave();
    s.tasks[0].status = status;
    assert.throws(() => reopen(s), { code: 'project_dependency_invalid' }, status);
  }
  const released = closedWave();
  released.tasks[0].status = 'released';
  assert.doesNotThrow(() => reopen(released));
  // History is bounded: the 101st reopen is refused before any write.
  const full = closedWave({
    reopened: Array.from({ length: 100 }, (_, i) => ({
      status: 'accepted',
      revision: i + 1,
      reopenedAt: at,
      evidence: [],
      mappings: [],
    })),
    revision: 200,
  });
  full.revision = 200;
  assert.throws(() => reopen(full), { code: 'project_append_blocked' });
  assert.throws(() => reopen(closedWave(), { ...append(), op: 'insert' }));
});

test('Progress adds a counts-only gates line only for snapshots that carry gates', () => {
  const s = C.normalizeDirectorRecord(
    'snapshot',
    waveSnapshot({}, [
      gateRecord(),
      gateRecord({
        id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        number: 2,
        runId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        installed: true,
      }),
    ]),
    options,
  );
  const text = buildProjectProgress(s);
  assert.match(text, /^gates: returned 2 \/ total 2; completeness: complete\n {2}installed 1; reserved 1$/m);
  assert.doesNotMatch(text, new RegExp(gateRecord().id + '|' + gateRecord().runId + '|' + '3'.repeat(40)));
  // The wave lines are inserted before the fixed evidence footer; legacy text is otherwise identical.
  const legacy = buildProjectProgress(C.normalizeDirectorRecord('snapshot', legacySnapshot(), options));
  assert.equal(text.replace(/^gates:.*\n.*\n/m, ''), legacy);
  const truncated = { ...s, completeness: { ...s.completeness, gates: { total: 3, returned: 2, complete: false } } };
  assert.match(buildProjectProgress(truncated), /^gates: returned 2 \/ total 3; completeness: unknown \(blocked\)$/m);
  assert.match(
    buildProjectProgress({ ...s, gates: null }),
    /^gates: returned unknown \/ total unknown; completeness: unknown \(blocked\)\n {2}installed unknown; reserved unknown$/m,
  );
});

test('A wave project refuses an epic dependency cycle at create and appendMilestone; legacy keeps its rules', () => {
  // Review finding (major): tasks A1 → B1 → A2 → B2 (letters are epics) left both epics integrated
  // with wave_dependency_unaccepted and no gate at all.
  const create = spec =>
    C.normalizeDirectorRecord(
      'command',
      legacyCommand({ op: 'create', spec }, { projectId: null, expectedRevision: null }),
      options,
    );
  const interleaved = {
    ...legacySpec(),
    epics: [epicSpec('a'), epicSpec('b')],
    tasks: [
      taskSpec('a1', { epicId: 'a' }),
      taskSpec('b1', { epicId: 'b', dependsOn: ['a1'] }),
      taskSpec('a2', { epicId: 'a', dependsOn: ['b1'] }),
      taskSpec('b2', { epicId: 'b', dependsOn: ['a2'] }),
    ],
  };
  assert.throws(
    () => create({ ...interleaved, execution: clone(wave) }),
    error => error.code === 'project_epic_cycle' && JSON.stringify(error.epics) === '["a","b"]',
  );
  assert.deepEqual(C.epicCycle(interleaved.epics, interleaved.tasks), ['a', 'b']);
  assert.doesNotThrow(() => create(interleaved), 'a legacy project keeps its rules');
  // An acyclic epic graph (b after a) is admitted.
  const ordered = {
    ...interleaved,
    tasks: [
      taskSpec('a1', { epicId: 'a' }),
      taskSpec('a2', { epicId: 'a', dependsOn: ['a1'] }),
      taskSpec('b1', { epicId: 'b', dependsOn: ['a2'] }),
      taskSpec('b2', { epicId: 'b', dependsOn: ['b1', 'a1'] }),
    ],
    execution: clone(wave),
  };
  assert.doesNotThrow(() => create(ordered));
  assert.equal(C.epicCycle(ordered.epics, ordered.tasks), null);
  // appendMilestone: two new epics whose tasks depend on each other form a cycle.
  const reopen = action => C.assertProjectReopen({ snapshot: closedWave(), action });
  const epics = [epicSpec('e2', 'm2'), epicSpec('e3', 'm2')];
  assert.throws(
    () =>
      reopen(
        append({
          epics,
          tasks: [
            taskSpec('c', { epicId: 'e2', dependsOn: ['a'] }),
            taskSpec('d', { epicId: 'e3', dependsOn: ['c'] }),
            taskSpec('f', { epicId: 'e2', dependsOn: ['d'] }),
          ],
        }),
      ),
    error => error.code === 'project_epic_cycle' && JSON.stringify(error.epics) === '["e2","e3"]',
  );
  assert.doesNotThrow(() =>
    reopen(
      append({
        epics,
        tasks: [taskSpec('c', { epicId: 'e2', dependsOn: ['a'] }), taskSpec('d', { epicId: 'e3', dependsOn: ['c'] })],
      }),
    ),
  );
});
