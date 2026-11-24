import test from 'node:test';
import assert from 'node:assert/strict';
import * as contracts from '../runtime/project-contracts.mjs';
import { planProjectHorizon } from '../runtime/project-planner.mjs';

const projectId = '11111111-1111-4111-8111-111111111111';
const at = '2026-11-17T00:00:00.000Z';
const criterion = { id: 'works', text: 'Observable result works', evidenceKinds: ['checks'] };
const meta = (status, revision = 1) => ({
  schemaVersion: 1,
  projectId,
  revision,
  status,
  createdAt: at,
  updatedAt: at,
  evidence: [],
  mappings: [],
});
const task = (id, status = 'proposed', extra = {}) => ({
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
  ...meta(status),
  ...extra,
});
const attempt = (taskId, status, n) => ({
  schemaVersion: 1,
  id: `${String(n).repeat(8)}-0000-4000-8000-000000000000`,
  projectId,
  taskId,
  taskRevision: 1,
  number: 1,
  runId: `${String(n).repeat(8)}-1111-4111-8111-111111111111`,
  contractHash: 'd'.repeat(64),
  status,
  baseSha: null,
  headSha: null,
  evidence: [],
  reason: null,
  createdAt: at,
  updatedAt: at,
});
function snapshot(tasks, { execution, attempts = [] } = {}) {
  const value = {
    schemaVersion: 1,
    project: {
      schemaVersion: 1,
      projectId,
      id: 'sample',
      root: '/srv/kodo-fixture',
      projectKey: '/srv/kodo-fixture',
      title: 'Sample project',
      definitionOfDone: [criterion],
      constraints: [],
      businessContext: '',
      architectureRefs: [],
      status: 'running',
      paused: false,
      revision: 3,
      createdAt: at,
      updatedAt: at,
      evidence: [],
      mappings: [],
      ...(execution ? { execution } : {}),
    },
    revision: 3,
    milestones: [{ id: 'm', title: 'Milestone', acceptance: [criterion], releaseRequired: false, ...meta('running') }],
    epics: [{ id: 'e', milestoneId: 'm', title: 'Epic', acceptance: [criterion], ...meta('running') }],
    tasks,
    currentAttempts: attempts,
    riskApprovals: [],
    completeness: {},
  };
  if (execution?.cadence === 'wave') value.gates = [];
  for (const key of [
    'milestones',
    'epics',
    'tasks',
    'currentAttempts',
    'riskApprovals',
    ...(value.gates ? ['gates'] : []),
  ])
    value.completeness[key] = { total: value[key].length, returned: value[key].length, complete: true };
  return value;
}
const wave = { cadence: 'wave', integration: 'branch' };
const available = s => s.tasks.map(t => ({ taskId: t.id, available: true, interfacesVerified: true, reason: null }));
const plan = (s, ports = { contracts, knownValues: [] }) =>
  planProjectHorizon({ snapshot: s, limit: 24, availability: available(s), now: at }, ports);
const reasons = (result, id) => result.blocked.find(row => row.taskId === id)?.reasons ?? [];
// Pure fake ports, as in tests/project-planner.test.mjs: the rule must not depend on them.
const fakePorts = {
  knownValues: [],
  contracts: {
    assertDirectorSafe() {},
    normalizeDirectorRecord: (_kind, value) => structuredClone(value),
    buildDirectorTaskInput: ({ task: value }) => value.description,
  },
};

test('Wave planning treats integrated prerequisites as satisfied; legacy keeps requiring acceptance', () => {
  const tasks = () => [
    task('a', 'integrated'),
    task('b', 'proposed', { dependsOn: ['a'] }),
    task('c', 'proposed', { dependsOn: ['b'] }),
  ];
  const attempts = [attempt('a', 'integrated', 1)];
  for (const ports of [undefined, fakePorts]) {
    const waved = plan(snapshot(tasks(), { execution: wave, attempts }), ports);
    assert.deepEqual(waved.taskIds, ['b']);
    assert.deepEqual(reasons(waved, 'c'), ['dependency_not_accepted:b']);
    assert.deepEqual(reasons(waved, 'a'), ['task_integrated', 'attempt_exists']);
    for (const execution of [undefined, { cadence: 'task', integration: 'frontier' }]) {
      const legacy = plan(snapshot(tasks(), { execution, attempts }), ports);
      assert.deepEqual(legacy.taskIds, []);
      assert.deepEqual(reasons(legacy, 'b'), ['dependency_not_accepted:a']);
      assert.deepEqual(reasons(legacy, 'c'), ['dependency_not_accepted:a']);
    }
  }
  // Only integrated|accepted|released unlock wave dependants; reason strings are unchanged.
  for (const status of ['verifying', 'running', 'blocked', 'failed', 'cancelled']) {
    const s = snapshot([task('a', status), task('b', 'proposed', { dependsOn: ['a'] })], { execution: wave });
    assert.deepEqual(reasons(plan(s), 'b'), ['dependency_not_accepted:a'], status);
  }
  for (const status of ['accepted', 'released']) {
    const s = snapshot([task('a', status), task('b', 'proposed', { dependsOn: ['a'] })], { execution: wave });
    assert.deepEqual(plan(s).taskIds, ['b'], status);
  }
});

test('Wave critical path stops counting integrated work', () => {
  const tasks = () => [
    task('a', 'integrated', { estimatedEffort: 100 }),
    task('b', 'proposed', { dependsOn: ['a'], estimatedEffort: 1 }),
    task('x', 'proposed', { estimatedEffort: 5 }),
  ];
  const attempts = [attempt('a', 'integrated', 1)];
  const legacy = plan(snapshot(tasks(), { attempts }));
  assert.deepEqual(legacy.order, ['a', 'x', 'b']);
  assert.deepEqual(legacy.taskIds, ['x']);
  const waved = plan(snapshot(tasks(), { execution: wave, attempts }));
  assert.deepEqual(waved.order, ['x', 'b', 'a']);
  assert.deepEqual(waved.taskIds, ['x', 'b']);
});

test('Wave planning input still requires complete gate sets', () => {
  const s = snapshot([task('a')], { execution: wave });
  delete s.gates;
  delete s.completeness.gates;
  assert.throws(() => plan(s), { code: 'project_schema' });
});

test('Wave admission ranks depth then direct successors before effort and stable ties', () => {
  const tasks = [
    task('expensive', 'ready', { estimatedEffort: 99 }),
    task('fork'),
    task('single'),
    task('chain'),
    task('f-one', 'proposed', { dependsOn: ['fork'] }),
    task('f-two', 'proposed', { dependsOn: ['fork'] }),
    task('s-one', 'proposed', { dependsOn: ['single'] }),
    task('c-one', 'proposed', { dependsOn: ['chain'] }),
    task('c-two', 'proposed', { dependsOn: ['c-one'] }),
  ];
  for (const order of [tasks, [...tasks].reverse()])
    assert.deepEqual(plan(snapshot(order, { execution: wave })).taskIds, ['chain', 'fork', 'single', 'expensive']);
});

test('A profiled wave can see 64 ready tasks beyond the legacy horizon', async () => {
  const { selectWave } = await import('../runtime/project-director-waves.mjs');
  const s = snapshot(
    Array.from({ length: 70 }, (_, i) => task('task-' + i)),
    { execution: wave },
  );
  assert.equal(selectWave(s, { profiledWave: true, limit: 64, now: at }).length, 64);
  assert.throws(() => selectWave(s, { limit: 64, now: at }), { code: 'project_limit_invalid' });
});

test('A2 a single vacancy searches past 24 conflicting candidates', async () => {
  const { selectWave } = await import('../runtime/project-director-waves.mjs');
  const busy = Array.from({ length: 63 }, (_, i) => task('busy-' + i, 'running'));
  const conflict = Array.from({ length: 25 }, (_, i) => task('a-' + i, 'proposed', { writePaths: busy[i].writePaths }));
  const s = snapshot([...busy, ...conflict, task('z')], { execution: wave });
  assert.deepEqual(selectWave(s, { profiledWave: true, limit: 1, inFlight: busy.map(t => t.id), now: at }), ['z']);
  assert.deepEqual(
    selectWave(s, { profiledWave: true, windowSize: 1, limit: 1, inFlight: busy.map(t => t.id), now: at }),
    ['z'],
  );
});
test('A4 ranks a chain of 5000 tasks without recursion', async () => {
  const { waveRanks } = await import('../runtime/project-planner.mjs');
  const nodes = Array.from({ length: 5000 }, (_, i) => ({ id: String(i), dependsOn: i ? [String(i - 1)] : [] }));
  assert.deepEqual(waveRanks(nodes).get('0'), { depth: 4999, children: 1 });
});
test('A4 rejects malformed graphs with distinct errors', async () => {
  const { waveRanks } = await import('../runtime/project-planner.mjs');
  for (const [deps, code] of [
    [['b'], 'project_dependency_cycle'],
    [['x'], 'project_dependency_missing'],
    [['b', 'b'], 'project_dependency_duplicate'],
  ])
    assert.throws(
      () =>
        waveRanks([
          { id: 'a', dependsOn: deps },
          { id: 'b', dependsOn: ['a'] },
        ]),
      { code },
    );
});
test('A10 unprofiled waves rank live chains and exclude cancelled branches', async () => {
  const { selectWave } = await import('../runtime/project-director-waves.mjs');
  const tasks = [
    task('a'),
    task('b'),
    task('live', 'proposed', { dependsOn: ['b'] }),
    task('gone', 'cancelled', { dependsOn: ['a'] }),
    task('also-gone', 'cancelled', { dependsOn: ['gone'] }),
  ];
  assert.deepEqual(selectWave(snapshot(tasks, { execution: wave }), { limit: 1, now: at }), ['b']);
});
