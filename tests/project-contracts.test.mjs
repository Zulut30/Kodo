import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  assertDirectorSafe,
  normalizeProjectSpec,
  normalizeDirectorRecord,
  directorBytes,
  directorContractHash,
  buildDirectorTaskInput,
  assertProjectTransition,
} from '../runtime/project-contracts.mjs';

const options = { knownValues: [] };
const pid = '11111111-1111-4111-8111-111111111111';
const aid = '22222222-2222-4222-8222-222222222222';
const rid = '33333333-3333-4333-8333-333333333333';
const at = '2026-11-05T00:00:00.000Z';
const digest = 'a'.repeat(64),
  sha = 'b'.repeat(40);
const criterion = () => ({ id: 'works', text: 'Public behavior works', evidenceKinds: ['acceptance'] });
const ref = () => ({
  kind: 'acceptance',
  runId: rid,
  headSha: sha,
  path: 'C:/owned/evidence/proof.json',
  sha256: digest,
});
const taskSpec = (id = 'task-a') => ({
  id,
  epicId: 'epic-a',
  title: 'Implement behavior',
  description: 'Implement the assigned behavior',
  owner: 'developer',
  dependsOn: [],
  writePaths: ['runtime/example.mjs'],
  acceptance: [criterion()],
  interfaceRefs: [],
  priority: 50,
  userValue: 3,
  risk: 1,
  estimatedEffort: 1,
  riskApprovalRequired: false,
});
const spec = () => ({
  schemaVersion: 1,
  id: 'project-a',
  root: 'C:/projects/example',
  title: 'Example',
  definitionOfDone: [criterion()],
  constraints: ['Preserve subscription-only clients'],
  businessContext: 'Useful project',
  architectureRefs: [],
  milestones: [{ id: 'milestone-a', title: 'First milestone', acceptance: [criterion()], releaseRequired: true }],
  epics: [{ id: 'epic-a', milestoneId: 'milestone-a', title: 'First epic', acceptance: [criterion()] }],
  tasks: [taskSpec()],
});
const meta = () => ({
  schemaVersion: 1,
  projectId: pid,
  revision: 1,
  status: 'proposed',
  createdAt: at,
  updatedAt: at,
  evidence: [],
  mappings: [],
});
const task = () => ({ ...taskSpec(), ...meta() });
const project = () => {
  const { milestones, epics, tasks, ...header } = spec();
  return { ...header, ...meta(), projectKey: digest, paused: false };
};
const count = n => ({ total: n, returned: n, complete: true });
const snapshot = () => ({
  schemaVersion: 1,
  project: project(),
  revision: 1,
  milestones: spec().milestones.map(x => ({ ...x, ...meta() })),
  epics: spec().epics.map(x => ({ ...x, ...meta() })),
  tasks: [task()],
  currentAttempts: [],
  riskApprovals: [],
  completeness: {
    milestones: count(1),
    epics: count(1),
    tasks: count(1),
    currentAttempts: count(0),
    riskApprovals: count(0),
  },
});
const binding = () => ({
  schemaVersion: 1,
  projectId: pid,
  taskId: 'task-a',
  taskRevision: 1,
  attemptId: aid,
  runId: rid,
  contractHash: digest,
});
const attempt = () => ({
  schemaVersion: 1,
  id: aid,
  projectId: pid,
  taskId: 'task-a',
  taskRevision: 1,
  number: 1,
  runId: rid,
  contractHash: digest,
  status: 'reserved',
  baseSha: sha,
  headSha: null,
  evidence: [],
  reason: null,
  createdAt: at,
  updatedAt: at,
});
const command = action => ({
  schemaVersion: 1,
  commandId: aid,
  projectId: pid,
  expectedRevision: 1,
  actor: 'coordinator',
  reason: 'Requested action',
  action,
});
const rejects = fn =>
  assert.throws(fn, error => typeof error.code === 'string' && !error.message.includes('FAKE-CREDENTIAL'));

test('ProjectSpec supports one thousand tasks and rejects a larger backlog', () => {
  const input = spec();
  input.tasks = Array.from({ length: 1000 }, (_, i) => ({
    ...taskSpec(`task-${i}`),
    dependsOn: i ? [`task-${i - 1}`] : [],
  }));
  const actual = normalizeProjectSpec(input, options);
  assert.equal(actual.tasks.length, 1000);
  assert.deepEqual(actual.tasks[999].dependsOn, ['task-998']);
  input.tasks.push(taskSpec('overflow'));
  rejects(() => normalizeProjectSpec(input, options));
});

test('Hierarchy rejects missing parents duplicate IDs missing dependencies and cycles', () => {
  for (const change of [
    s => {
      s.epics[0].milestoneId = 'missing';
    },
    s => {
      s.tasks[0].epicId = 'missing';
    },
    s => {
      s.tasks.push(taskSpec());
    },
    s => {
      s.tasks[0].dependsOn = ['missing'];
    },
    s => {
      s.tasks[0].dependsOn = ['task-a'];
    },
    s => {
      s.tasks.push({ ...taskSpec('task-b'), dependsOn: ['task-a'] });
      s.tasks[0].dependsOn = ['task-b'];
    },
  ]) {
    const input = spec();
    change(input);
    rejects(() => normalizeProjectSpec(input, options));
  }
});

test('Fixed schema order and independent TaskContract SHA oracle bind immutable requirements', () => {
  const input = task();
  const expected = {
    schemaVersion: 1,
    projectId: pid,
    taskId: 'task-a',
    taskRevision: 1,
    description: input.description,
    owner: 'developer',
    dependsOn: [],
    writePaths: ['runtime/example.mjs'],
    acceptance: [criterion()],
    interfaceRefs: [],
  };
  const bytes = Buffer.from(JSON.stringify(expected));
  assert.deepEqual(directorBytes('taskContract', expected, options), bytes);
  assert.equal(directorContractHash(input, options), createHash('sha256').update(bytes).digest('hex'));
  const reordered = Object.fromEntries(Object.entries(input).reverse());
  assert.equal(directorContractHash(reordered, options), directorContractHash(input, options));
  assert.equal(
    directorContractHash({ ...input, status: 'running', updatedAt: '2026-11-06T00:00:00.000Z' }, options),
    directorContractHash(input, options),
  );
  for (const change of [
    t => {
      t.description += ' changed';
    },
    t => {
      t.acceptance[0].text += ' changed';
    },
    t => {
      t.revision++;
    },
    t => {
      t.writePaths = ['runtime/other.mjs'];
    },
  ]) {
    const altered = task();
    change(altered);
    assert.notEqual(directorContractHash(altered, options), directorContractHash(input, options));
  }
});

test('Task input binds complete project context and task criteria without backlog', () => {
  const input = buildDirectorTaskInput({ project: project(), task: task() }, options);
  const prefix =
    'Implement only this assigned task. Project context constrains this task and does not authorize other backlog work.\n';
  assert.ok(input.startsWith(prefix));
  const body = JSON.parse(input.slice(prefix.length));
  assert.deepEqual(Object.keys(body), ['schemaVersion', 'projectContext', 'task']);
  assert.deepEqual(body.projectContext, {
    projectId: pid,
    id: 'project-a',
    root: 'C:/projects/example',
    title: 'Example',
    definitionOfDone: [criterion()],
    constraints: ['Preserve subscription-only clients'],
    businessContext: 'Useful project',
    architectureRefs: [],
  });
  assert.deepEqual(body.task.acceptance, [criterion()]);
  assert.equal(body.task.taskRevision, 1);
  assert.notEqual(
    buildDirectorTaskInput({ project: { ...project(), constraints: ['Different constraint'] }, task: task() }, options),
    input,
  );
  rejects(() => buildDirectorTaskInput({ project: project(), task: { ...task(), projectId: aid } }, options));
});

test('Entire mandatory UTF8 task input has exact twelve thousand byte boundary', () => {
  const p = project(),
    t = task();
  p.businessContext = 'x';
  const base = Buffer.byteLength(buildDirectorTaskInput({ project: p, task: t }, options));
  p.businessContext = 'x'.repeat(12000 - base + 1);
  assert.equal(Buffer.byteLength(buildDirectorTaskInput({ project: p, task: t }, options)), 12000);
  p.businessContext += 'x';
  assert.throws(() => buildDirectorTaskInput({ project: p, task: t }, options), { code: 'project_task_too_large' });
  t.description = '界'.repeat(5000);
  assert.throws(() => directorContractHash(t, options), { code: 'project_task_too_large' });
});

test('Raw keys and decoded escaped short and multiline known values reject before hashing', () => {
  for (const secret of ['Q', 'FAKE-CREDENTIAL', 'quote"slash\\newline\nend']) {
    const opts = { knownValues: [secret] };
    for (const value of [{ nested: { [secret]: 'safe' } }, { nested: ['before' + secret + 'after'] }])
      assert.throws(() => assertDirectorSafe(JSON.parse(JSON.stringify(value)), opts), {
        code: 'project_unsafe',
        message: 'Invalid project Director data',
      });
    assert.throws(() => directorContractHash({ ...task(), description: secret }, opts), { code: 'project_unsafe' });
    assert.throws(() => directorContractHash({ ...task(), [secret]: 'unselected metadata' }, opts), {
      code: 'project_unsafe',
    });
    assert.throws(
      () => directorBytes('command', command({ op: 'setPaused', paused: false, [secret]: 'hidden' }), opts),
      { code: 'project_unsafe' },
    );
  }
  assertDirectorSafe({ text: 'safe', empty: '' }, { knownValues: [''] });
  rejects(() => assertDirectorSafe({}, undefined));
  assertDirectorSafe({ arbitraryLegacyRun: { properties: [null, false, 1] } }, options);
});

test('PEM and generic redaction changes reject but typed Git hashes remain intact', () => {
  for (const value of [
    '-----BEGIN PRIVATE KEY-----\nZmFrZQ==\n-----END PRIVATE KEY-----',
    'Bearer fake-opaque-value',
    '?token=fake-opaque-value',
    'sk-' + 'x'.repeat(24),
    'AIza' + 'x'.repeat(30),
  ]) {
    assert.throws(() => assertDirectorSafe({ value }, options), { code: 'project_unsafe' });
    assert.throws(() => directorContractHash({ ...task(), description: value }, options), { code: 'project_unsafe' });
  }
  for (const head of [sha, digest]) {
    const a = { ...attempt(), headSha: head };
    assert.equal(normalizeDirectorRecord('attempt', a, options).headSha, head);
  }
  rejects(() => directorBytes('attempt', { ...attempt(), headSha: 'b'.repeat(41) }, options));
  rejects(() => directorBytes('attempt', { ...attempt(), headSha: sha.toUpperCase() }, options));
  rejects(() => directorBytes('attempt', attempt(), { knownValues: ['bbb'] }));
});

test('Strict data rejects accessors symbols metadata cycles sparse arrays and exotic objects', () => {
  let invoked = false;
  const accessor = {};
  Object.defineProperty(accessor, 'secret', {
    enumerable: true,
    get() {
      invoked = true;
      throw Error('never');
    },
  });
  const cyclic = {};
  cyclic.self = cyclic;
  for (const value of [
    accessor,
    { [Symbol('hidden')]: true },
    Object.defineProperty({}, 'hidden', { value: 1 }),
    cyclic,
    { x: NaN },
    { x: Infinity },
    { x: undefined },
    { x: 1n },
    { x: new Date() },
    // oxlint-disable-next-line no-sparse-arrays -- a hole is the rejected input
    { x: [, 1] },
    { x: Object.assign([], { extra: 1 }) },
  ])
    rejects(() => assertDirectorSafe(value, options));
  assert.equal(invoked, false);
  rejects(() => normalizeDirectorRecord('task', { ...task(), extra: 1 }, options));
  rejects(() => normalizeDirectorRecord('unknown', {}, options));
});

test('Malformed field types schema versions UTC dates criteria and scopes reject', () => {
  for (const patch of [
    { schemaVersion: 2 },
    { priority: 101 },
    { risk: -1 },
    { estimatedEffort: 0 },
    { riskApprovalRequired: 1 },
    { owner: '' },
    { id: 'Upper' },
    { revision: 0 },
    { updatedAt: '2026-02-30T00:00:00.000Z' },
    { status: 'completed' },
    { acceptance: [] },
    { writePaths: ['../escape'] },
    { writePaths: ['C:/escape'] },
    { writePaths: ['runtime\\bad'] },
    { writePaths: ['.git/config'] },
    { writePaths: ['auth.json'] },
    { writePaths: ['runtime/.env.local'] },
  ])
    rejects(() => normalizeDirectorRecord('task', { ...task(), ...patch }, options));
  rejects(() => normalizeProjectSpec({ ...spec(), root: 'relative/path' }, options));
  rejects(() => normalizeDirectorRecord('task', { ...task(), acceptance: [criterion(), criterion()] }, options));
});

test('Snapshot enforces coherent counts revision current identities approvals and parents', () => {
  assert.deepEqual(normalizeDirectorRecord('snapshot', snapshot(), options), snapshot());
  for (const change of [
    s => {
      s.tasks[0].projectId = aid;
    },
    s => {
      s.revision = 2;
    },
    s => {
      s.completeness.tasks.returned = 0;
    },
    s => {
      s.completeness.tasks.total = 2;
    },
    s => {
      s.tasks[0].epicId = 'missing';
    },
    s => {
      s.currentAttempts = [attempt()];
      s.completeness.currentAttempts = count(1);
      s.currentAttempts[0].taskRevision = 2;
    },
    s => {
      s.riskApprovals = [
        {
          schemaVersion: 1,
          projectId: pid,
          taskId: 'task-a',
          taskRevision: 2,
          actor: 'coordinator',
          reason: 'Explicit risk',
          approvedAt: at,
        },
      ];
      s.completeness.riskApprovals = count(1);
    },
  ]) {
    const s = snapshot();
    change(s);
    rejects(() => normalizeDirectorRecord('snapshot', s, options));
  }
  const partial = snapshot();
  partial.completeness.tasks = { total: 2, returned: 1, complete: false };
  assert.equal(normalizeDirectorRecord('snapshot', partial, options).completeness.tasks.complete, false);
});

test('Every frozen record kind encodes only the exact schema vocabulary', () => {
  const taskRunInput = JSON.parse(
    buildDirectorTaskInput({ project: project(), task: task() }, options).split('\n').slice(1).join('\n'),
  );
  const s = snapshot();
  const fixtures = {
    projectSpec: spec(),
    project: project(),
    milestone: s.milestones[0],
    epic: s.epics[0],
    task: task(),
    attempt: attempt(),
    riskApproval: {
      schemaVersion: 1,
      projectId: pid,
      taskId: 'task-a',
      taskRevision: 1,
      actor: 'coordinator',
      reason: 'Explicit risk',
      approvedAt: at,
    },
    event: {
      schemaVersion: 1,
      seq: 1,
      projectId: pid,
      at,
      commandId: aid,
      actor: 'coordinator',
      reason: 'Audit action',
      entity: { kind: 'task', id: 'task-a' },
      type: 'transition',
      previousHash: null,
      nextHash: digest,
    },
    snapshot: s,
    command: command({ op: 'setPaused', paused: false }),
    installBinding: binding(),
    taskContract: taskRunInput.task,
    taskRunInput,
  };
  for (const [kind, value] of Object.entries(fixtures)) {
    assert.deepEqual(JSON.parse(directorBytes(kind, value, options)), normalizeDirectorRecord(kind, value, options));
    rejects(() => directorBytes(kind, { ...value, unexpected: true }, options));
  }
});

test('Command union validates create insert amend transition controls risk and reservation', () => {
  const create = { ...command({ op: 'create', spec: spec() }), projectId: null, expectedRevision: null };
  for (const c of [
    create,
    command({ op: 'insert', kind: 'task', record: taskSpec() }),
    command({ op: 'amend', kind: 'task', id: 'task-a', record: taskSpec() }),
    command({ op: 'transition', kind: 'task', id: 'task-a', to: 'ready', evidence: [], mappings: [] }),
    command({ op: 'setPaused', paused: true }),
    command({ op: 'approveRisk', taskId: 'task-a', taskRevision: 1 }),
    command({ op: 'reserveAttempt', taskId: 'task-a', retryFailed: false }),
  ])
    assert.equal(normalizeDirectorRecord('command', c, options).action.op, c.action.op);
  for (const c of [
    command({ op: 'create', spec: spec() }),
    { ...create, expectedRevision: 1 },
    command({ op: 'delete', id: 'task-a' }),
    command({ op: 'reserveAttempt', taskId: 'task-a', retryFailed: 'yes' }),
    command({ op: 'amend', kind: 'task', id: 'other', record: taskSpec() }),
  ])
    rejects(() => directorBytes('command', c, options));
});

test('Transitions enforce state edges membership complete child sets and mapped evidence', () => {
  const s = snapshot(),
    input = { record: s.tasks[0], to: 'ready', snapshot: s, evidence: [], mappings: [] };
  assertProjectTransition(input);
  rejects(() => assertProjectTransition({ ...input, to: 'accepted' }));
  rejects(() => assertProjectTransition({ ...input, record: { ...s.tasks[0], projectId: aid } }));
  const proof = ref(),
    mapped = { criterionId: 'works', refs: [digest], actor: 'reviewer', reason: 'Observed behavior' };
  s.tasks[0].status = 'integrated';
  assertProjectTransition({ ...input, to: 'accepted', evidence: [proof], mappings: [mapped] });
  rejects(() => assertProjectTransition({ ...input, to: 'accepted', evidence: [proof], mappings: [] }));
  rejects(() =>
    assertProjectTransition({
      ...input,
      to: 'accepted',
      evidence: [proof],
      mappings: [{ ...mapped, refs: ['c'.repeat(64)] }],
    }),
  );
  const container = snapshot();
  container.project.status = 'integrated';
  rejects(() =>
    assertProjectTransition({
      record: container.project,
      to: 'accepted',
      snapshot: container,
      evidence: [proof],
      mappings: [mapped],
    }),
  );
  for (const rows of [container.milestones, container.epics, container.tasks])
    for (const row of rows) row.status = 'accepted';
  assertProjectTransition({
    record: container.project,
    to: 'accepted',
    snapshot: container,
    evidence: [proof],
    mappings: [mapped],
  });
  container.project.status = 'accepted';
  rejects(() =>
    assertProjectTransition({
      record: container.project,
      to: 'released',
      snapshot: container,
      evidence: [{ ...proof, kind: 'release' }],
      mappings: [mapped],
    }),
  );
  container.milestones[0].status = 'released';
  assertProjectTransition({
    record: container.project,
    to: 'released',
    snapshot: container,
    evidence: [{ ...proof, kind: 'release' }],
    mappings: [mapped],
  });
  rejects(() => assertProjectTransition({ ...input, record: { ...s.tasks[0], status: 'accepted' }, to: 'failed' }));
});

test('Incomplete transitions and unbound mappings cannot authorize terminal states', () => {
  const s = snapshot();
  s.tasks[0].status = 'integrated';
  const proof = ref(),
    mapped = { criterionId: 'works', refs: [digest], actor: 'reviewer', reason: 'Observed behavior' };
  const input = { record: s.tasks[0], to: 'accepted', snapshot: s, evidence: [proof], mappings: [mapped] };
  s.completeness.epics = { total: 2, returned: 1, complete: false };
  rejects(() => assertProjectTransition(input));
  s.completeness.epics = count(1);
  rejects(() => assertProjectTransition({ ...input, mappings: [mapped, { ...mapped, criterionId: 'invented' }] }));
  rejects(() => assertProjectTransition({ ...input, evidence: [{ ...proof, kind: 'review' }] }));
  const container = snapshot();
  container.milestones[0].status = 'integrated';
  container.epics[0].status = 'accepted';
  rejects(() => assertProjectTransition({ ...input, record: container.milestones[0], snapshot: container }));
});

test('Ready transitions require accepted dependencies risk approval and active project', () => {
  const s = snapshot();
  s.tasks.push({ ...task(), id: 'dependency' });
  s.completeness.tasks = count(2);
  s.tasks[0].dependsOn = ['dependency'];
  s.tasks[0].riskApprovalRequired = true;
  const input = { record: s.tasks[0], to: 'ready', snapshot: s, evidence: [], mappings: [] };
  rejects(() => assertProjectTransition(input));
  s.tasks[1].status = 'accepted';
  rejects(() => assertProjectTransition(input));
  s.riskApprovals = [
    {
      schemaVersion: 1,
      projectId: pid,
      taskId: 'task-a',
      taskRevision: 1,
      actor: 'coordinator',
      reason: 'Explicit risk',
      approvedAt: at,
    },
  ];
  s.completeness.riskApprovals = count(1);
  assertProjectTransition(input);
  s.project.paused = true;
  rejects(() => assertProjectTransition(input));
});

test('Snapshot retains settled earlier revision attempts while active stale attempts reject', () => {
  const s = snapshot();
  s.revision = s.project.revision = 2;
  s.tasks[0].revision = 2;
  s.currentAttempts = [{ ...attempt(), status: 'failed' }];
  s.completeness.currentAttempts = count(1);
  assert.equal(normalizeDirectorRecord('snapshot', s, options).currentAttempts[0].taskRevision, 1);
  s.currentAttempts[0].status = 'running';
  rejects(() => normalizeDirectorRecord('snapshot', s, options));
});

test('Raw safety bounds depth and payload size without reading getters', () => {
  let value = 'safe';
  for (let i = 0; i < 16; i++) value = [value];
  assertDirectorSafe(value, options);
  rejects(() => assertDirectorSafe([value], options));
  rejects(() => assertDirectorSafe({ value: 'x'.repeat(32 * 1024 * 1024) }, options));
  let invoked = false;
  const opts = {};
  Object.defineProperty(opts, 'knownValues', {
    enumerable: true,
    get() {
      invoked = true;
      return [];
    },
  });
  rejects(() => assertDirectorSafe({}, opts));
  assert.equal(invoked, false);
});

test('Evidence paths exclude credential stores private keys and relative locations', () => {
  for (const path of [
    'relative/proof',
    'C:/owned/credentials.json',
    'C:/owned/.ssh/id_ed25519',
    'C:/owned/key.pem',
    'C:/owned/Kodo-Credentials/proof.json',
    'C:/owned/../escape',
    'C:/owned/.git/proof.json',
  ])
    rejects(() =>
      directorBytes(
        'taskContract',
        {
          schemaVersion: 1,
          projectId: pid,
          taskId: 'task-a',
          taskRevision: 1,
          description: 'Implement',
          owner: 'developer',
          dependsOn: [],
          writePaths: ['runtime/example.mjs'],
          acceptance: [criterion()],
          interfaceRefs: [{ ...ref(), kind: 'interface', path }],
        },
        options,
      ),
    );
  const t = task();
  t.interfaceRefs = [{ ...ref(), kind: 'interface' }];
  assert.equal(
    JSON.parse(
      directorBytes(
        'taskContract',
        {
          schemaVersion: 1,
          projectId: pid,
          taskId: t.id,
          taskRevision: t.revision,
          description: t.description,
          owner: t.owner,
          dependsOn: t.dependsOn,
          writePaths: t.writePaths,
          acceptance: t.acceptance,
          interfaceRefs: t.interfaceRefs,
        },
        options,
      ),
    ).interfaceRefs[0].sha256,
    digest,
  );
});

test('Equivalent command key order preserves payload bytes while changed payload differs', () => {
  const c = command({ op: 'setPaused', paused: false });
  const reordered = { ...Object.fromEntries(Object.entries(c).reverse()), action: { paused: false, op: 'setPaused' } };
  assert.deepEqual(directorBytes('command', reordered, options), directorBytes('command', c, options));
  assert.notDeepEqual(
    directorBytes('command', command({ op: 'setPaused', paused: true }), options),
    directorBytes('command', c, options),
  );
});

test('Empty incremental backlog numeric edges and POSIX roots remain valid', () => {
  const p = { ...spec(), root: '/owned/project', milestones: [], epics: [], tasks: [] };
  assert.deepEqual(normalizeProjectSpec(p, options), p);
  for (const patch of [
    { priority: 0, userValue: 0, risk: 0, estimatedEffort: 1 },
    { priority: 100, userValue: 5, risk: 5, estimatedEffort: Number.MAX_SAFE_INTEGER },
  ])
    assert.equal(normalizeDirectorRecord('task', { ...task(), ...patch }, options).priority, patch.priority);
  for (const patch of [
    { priority: -1 },
    { userValue: 6 },
    { risk: 6 },
    { estimatedEffort: Number.MAX_SAFE_INTEGER + 1 },
  ])
    rejects(() => normalizeDirectorRecord('task', { ...task(), ...patch }, options));
});
