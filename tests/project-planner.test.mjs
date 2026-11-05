import test from 'node:test';
import assert from 'node:assert/strict';
import { planProjectHorizon } from '../runtime/project-planner.mjs';
import * as contracts from '../runtime/project-contracts.mjs';

const projectId = '10000000-0000-4000-8000-000000000001';
const now = '2026-11-05T10:00:00.000Z';
const digest = 'a'.repeat(64);
const ref = { kind: 'interface', runId: null, headSha: 'b'.repeat(40), path: 'C:/isolated-evidence/interface.json', sha256: digest };
const meta = { schemaVersion: 1, projectId, revision: 1, status: 'proposed', createdAt: now, updatedAt: now, evidence: [], mappings: [] };
const criterion = { id: 'works', text: 'Observable result', evidenceKinds: ['checks'] };
function task(id, extra = {}) {
  return { ...meta, id, epicId: 'epic', title: id, description: 'Implement scoped result', owner: 'developer',
    dependsOn: [], writePaths: ['runtime/example.mjs'], acceptance: [criterion], interfaceRefs: [ref],
    priority: 50, userValue: 3, risk: 1, estimatedEffort: 1, riskApprovalRequired: false, ...extra };
}
function fixture(tasks = [task('one')]) {
  const snapshot = { schemaVersion: 1,
    project: { ...meta, id: 'project', root: 'C:/isolated-project', projectKey: digest, title: 'Project',
      definitionOfDone: [criterion], constraints: [], businessContext: 'Fixture only', architectureRefs: [], paused: false },
    revision: 1,
    milestones: [{ ...meta, id: 'milestone', title: 'Milestone', acceptance: [criterion], releaseRequired: false }],
    epics: [{ ...meta, id: 'epic', milestoneId: 'milestone', title: 'Epic', acceptance: [criterion] }],
    tasks, currentAttempts: [], riskApprovals: [], completeness: {} };
  recount(snapshot);
  return { snapshot, availability: tasks.map(t => ({ taskId: t.id, available: true, interfacesVerified: true, reason: null })), limit: 24, now };
}
function recount(snapshot) {
  for (const key of ['milestones', 'epics', 'tasks', 'currentAttempts', 'riskApprovals']) {
    snapshot.completeness[key] = { total: snapshot[key].length, returned: snapshot[key].length, complete: true };
  }
}
// A's public pure ports are injected while its sibling module is independently built.
// No provider/state/credential module is loaded; all known values are explicit fakes or empty.
function ports(overrides = {}) {
  return { knownValues: [], contracts: {
    assertDirectorSafe() {},
    normalizeDirectorRecord(kind, input, options) {
      assert.equal(kind, 'snapshot'); assert.deepEqual(options, { knownValues: [] });
      return structuredClone(input);
    },
    buildDirectorTaskInput({ task: value }, options) {
      assert.deepEqual(options, { knownValues: [] });
      return value.description;
    }, ...overrides
  } };
}
const plan = (input, injected = ports()) => planProjectHorizon(input, injected);
const reasons = (result, id) => result.blocked.find(row => row.taskId === id)?.reasons ?? [];
const actualPorts = { contracts, knownValues: [] };

test('Actual contracts select 24 of 1000 tasks with no required interfaces and preserve lower limits', () => {
  const tasks = Array.from({ length: 1000 }, (_, i) => task('task-' + String(i).padStart(4, '0'), { interfaceRefs: [] }));
  const input = fixture(tasks), before = structuredClone(input);
  assert.equal(contracts.normalizeDirectorRecord('snapshot', input.snapshot, { knownValues: [] }).tasks.length, 1000);
  const result = plan(input, actualPorts);
  assert.deepEqual(result.taskIds, tasks.slice(0, 24).map(t => t.id));
  assert.equal(result.order.length, 1000);
  assert.equal(result.blocked.length, 976);
  assert.ok(result.blocked.every(row => row.reasons.length === 1 && row.reasons[0] === 'horizon_limit'));
  assert.equal(result.dryRun, true);
  assert.deepEqual(plan({ ...input, limit: 7 }, actualPorts).taskIds, tasks.slice(0, 7).map(t => t.id));
  assert.deepEqual(input, before);
});

test('Actual contracts still require availability and interface verification when required interfaces are empty', () => {
  const input = fixture([task('one', { interfaceRefs: [] })]);
  assert.deepEqual(plan(input, actualPorts).taskIds, ['one']);
  input.availability = [];
  assert.deepEqual(reasons(plan(input, actualPorts), 'one'), ['availability_missing']);
  input.availability = [{ taskId: 'one', available: false, interfacesVerified: true, reason: 'quota' }];
  assert.deepEqual(reasons(plan(input, actualPorts), 'one'), ['availability:quota']);
  input.availability[0].available = true; input.availability[0].interfacesVerified = false;
  assert.deepEqual(reasons(plan(input, actualPorts), 'one'), ['interfaces_unverified']);
  input.snapshot.tasks[0].interfaceRefs = [ref];
  assert.deepEqual(reasons(plan(input, actualPorts), 'one'), ['interfaces_unverified']);
  input.availability[0].interfacesVerified = true;
  assert.deepEqual(plan(input, actualPorts).taskIds, ['one']);
  input.snapshot.tasks[0].interfaceRefs[0] = { ...ref, sha256: 'invalid-proof' };
  assert.throws(() => plan(input, actualPorts), { code: 'project_schema' });
});

test('Actual stale and future revision approvals block the entire horizon without weakening the snapshot contract', () => {
  const input = fixture([task('risky', { revision: 3, riskApprovalRequired: true }), task('unrelated')]);
  input.snapshot.revision = input.snapshot.project.revision = 3;
  const approval = { schemaVersion: 1, projectId, taskId: 'risky', taskRevision: 3, actor: 'owner', reason: 'Reviewed risk', approvedAt: now };
  let builds = 0;
  const injected = { knownValues: [], contracts: { ...contracts, buildDirectorTaskInput(value, options) {
    builds++; return contracts.buildDirectorTaskInput(value, options);
  } } };
  for (const taskRevision of [2, 4]) {
    input.snapshot.riskApprovals = [{ ...approval, taskRevision }]; recount(input.snapshot);
    const before = structuredClone(input);
    assert.throws(() => contracts.normalizeDirectorRecord('snapshot', input.snapshot, { knownValues: [] }), { code: 'project_revision' });
    const result = plan(input, injected);
    assert.deepEqual(result, { schemaVersion: 1, projectId, revision: 3, taskIds: [],
      blocked: ['risky', 'unrelated'].map(taskId => ({ taskId, reasons: ['snapshot_invalid:project_revision'] })),
      order: ['risky', 'unrelated'], dryRun: true });
    assert.equal(builds, 0);
    assert.deepEqual(input, before);
  }
  input.snapshot.riskApprovals = [approval]; recount(input.snapshot);
  assert.deepEqual(plan(input, actualPorts).taskIds, ['risky', 'unrelated']);
  input.snapshot.riskApprovals[0].approvedAt = '2026-11-06T10:00:00.000Z';
  assert.deepEqual(plan(input, actualPorts).taskIds, ['unrelated']);
  assert.deepEqual(reasons(plan(input, actualPorts), 'risky'), ['risk_approval_required']);
});

test('Actual contract safety schema and dependency errors propagate instead of becoming revision blockers', () => {
  for (const [mutate, code] of [
    [input => { input.snapshot.tasks[0].extra = true; }, 'project_schema'],
    [input => { input.snapshot.tasks[0].writePaths = ['../escape']; }, 'project_scope'],
    [input => { input.snapshot.tasks[0].dependsOn = ['missing']; }, 'project_dag'],
    [input => { input.snapshot.tasks[0].interfaceRefs = [{ ...ref, path: 'relative/proof.json' }]; }, 'project_path'],
    [input => { input.snapshot.tasks[0].description = 'Contains owned-test-credential'; }, 'project_unsafe']
  ]) {
    const input = fixture([task('one', { riskApprovalRequired: true })]);
    input.snapshot.riskApprovals = [{ schemaVersion: 1, projectId, taskId: 'one', taskRevision: 2,
      actor: 'owner', reason: 'Reviewed risk', approvedAt: now }]; recount(input.snapshot);
    mutate(input);
    assert.throws(() => plan(input, { contracts, knownValues: ['owned-test-credential'] }), { code });
  }
  const input = fixture(); let reads = 0;
  Object.defineProperty(input.snapshot, 'riskApprovals', { enumerable: true, get() { reads++; return []; } });
  assert.throws(() => plan(input, actualPorts), { code: 'project_schema' });
  assert.equal(reads, 0);
});

test('Actual coherent incomplete task attempt or approval sets are rejected before planning', () => {
  for (const key of ['tasks', 'currentAttempts', 'riskApprovals']) {
    const input = fixture();
    input.snapshot.completeness[key].total++;
    input.snapshot.completeness[key].complete = false;
    assert.doesNotThrow(() => contracts.normalizeDirectorRecord('snapshot', input.snapshot, { knownValues: [] }));
    assert.throws(() => plan(input, actualPorts), { code: 'invalid_project_horizon' });
  }
});

test('Revision denial is bounded to 1000 task IDs and passes the output safety boundary', () => {
  const input = fixture(Array.from({ length: 1000 }, (_, i) => task('task-' + String(i).padStart(4, '0'))));
  input.snapshot.project.revision = 2;
  const result = plan(input, actualPorts);
  assert.deepEqual(result.taskIds, []);
  assert.deepEqual(result.order, input.snapshot.tasks.map(t => t.id));
  assert.deepEqual(result.blocked, result.order.map(taskId => ({ taskId, reasons: ['snapshot_invalid:project_revision'] })));
  assert.throws(() => plan(input, { contracts, knownValues: ['snapshot_invalid:project_revision'] }), { code: 'project_unsafe' });
});

test('A thousand-task backlog has a stable bounded horizon and preserves every lower limit', () => {
  const tasks = Array.from({ length: 1000 }, (_, i) => task('task-' + String(i).padStart(4, '0')));
  const input = fixture(tasks);
  const expected = tasks.slice(0, 24).map(t => t.id);
  assert.deepEqual(plan(input).taskIds, expected);
  input.snapshot.tasks.reverse(); input.availability.reverse();
  assert.deepEqual(plan(input).taskIds, expected);
  assert.equal(plan(input).order.length, 1000);
  for (const limit of [1, 2, 7, 23, 24]) assert.deepEqual(plan({ ...input, limit }).taskIds, expected.slice(0, limit));
  for (const limit of [0, 25, -1, 1.5, '2', undefined]) assert.throws(() => plan({ ...input, limit }), { code: 'invalid_project_horizon' });
});

test('Dependencies must already be accepted or released and are never added as hidden prerequisites', () => {
  const input = fixture([task('parent'), task('child', { dependsOn: ['parent'], priority: 100 })]);
  assert.deepEqual(plan(input).taskIds, ['parent']);
  assert.ok(reasons(plan(input), 'child').includes('dependency_not_accepted:parent'));
  for (const status of ['integrated', 'verifying', 'running', 'failed', 'cancelled']) {
    input.snapshot.tasks[0].status = status;
    assert.ok(!plan(input).taskIds.includes('child'));
  }
  for (const status of ['accepted', 'released']) {
    input.snapshot.tasks[0].status = status;
    assert.deepEqual(plan(input).taskIds, ['child']);
  }
  input.snapshot.tasks.push(task('grandchild', { dependsOn: ['child'] }));
  input.snapshot.tasks[1].status = 'accepted'; input.snapshot.tasks[0].status = 'proposed';
  input.availability.push({ taskId: 'grandchild', available: true, interfacesVerified: true, reason: null }); recount(input.snapshot);
  assert.ok(reasons(plan(input), 'grandchild').includes('dependency_not_accepted:parent'));
});

test('Every complete-set claim is required and must match both counts and actual bodies', () => {
  for (const key of ['milestones', 'epics', 'tasks', 'currentAttempts', 'riskApprovals']) {
    for (const mutation of ['false', 'missing', 'total', 'returned']) {
      const input = fixture(); const count = input.snapshot.completeness[key];
      if (mutation === 'false') count.complete = false;
      if (mutation === 'missing') delete input.snapshot.completeness[key];
      if (mutation === 'total') count.total++;
      if (mutation === 'returned') count.returned++;
      const result = plan(input);
      assert.deepEqual(result.taskIds, [], key + ':' + mutation);
      assert.ok(reasons(result, 'one').includes('snapshot_incomplete:' + key));
    }
  }
});

test('An invalid DAG or missing parent blocks the whole horizon including unrelated work', () => {
  for (const tasks of [
    [task('one', { dependsOn: ['missing'] }), task('unrelated')],
    [task('one', { dependsOn: ['two'] }), task('two', { dependsOn: ['one'] }), task('unrelated')],
    [task('one', { dependsOn: ['one'] }), task('unrelated')],
    [task('one', { epicId: 'missing' }), task('unrelated')]
  ]) assert.deepEqual(plan(fixture(tasks)).taskIds, []);
  const input = fixture(); input.snapshot.revision++;
  assert.deepEqual(plan(input).taskIds, []);
});

test('Missing availability, quota and stale or missing interfaces fail closed', () => {
  const input = fixture();
  input.availability = [];
  assert.deepEqual(plan(input).taskIds, []);
  assert.ok(reasons(plan(input), 'one').includes('availability_missing'));
  input.availability = [{ taskId: 'one', available: false, interfacesVerified: true, reason: 'quota' }];
  assert.deepEqual(reasons(plan(input), 'one'), ['availability:quota']);
  input.availability[0].available = true; input.availability[0].interfacesVerified = false;
  assert.ok(reasons(plan(input), 'one').includes('interfaces_unverified'));
  input.availability[0].interfacesVerified = true; input.snapshot.tasks[0].interfaceRefs = undefined;
  assert.ok(reasons(plan(input), 'one').includes('interfaces_missing'));
  input.availability.push({ ...input.availability[0] });
  assert.throws(() => plan(input), { code: 'invalid_project_horizon' });
});

test('Risk approval matches exact project task revision and cannot come from the future', () => {
  const input = fixture([task('one', { riskApprovalRequired: true, revision: 3 })]);
  assert.ok(reasons(plan(input), 'one').includes('risk_approval_required'));
  const approval = { schemaVersion: 1, projectId, taskId: 'one', taskRevision: 3, actor: 'owner', reason: 'Reviewed risk', approvedAt: now };
  for (const change of [{ taskRevision: 2 }, { projectId: '20000000-0000-4000-8000-000000000001' }, { taskId: 'other' }, { approvedAt: '2026-11-06T10:00:00.000Z' }]) {
    input.snapshot.riskApprovals = [{ ...approval, ...change }]; recount(input.snapshot);
    assert.deepEqual(plan(input).taskIds, []);
  }
  input.snapshot.riskApprovals = [approval]; recount(input.snapshot);
  assert.deepEqual(plan(input).taskIds, ['one']);
});

test('Ranking uses remaining critical path then priority value risk effort and binary ID', () => {
  const input = fixture([
    task('low', { priority: 0, estimatedEffort: 1 }),
    task('descendant', { dependsOn: ['low'], estimatedEffort: 20 }),
    task('p', { priority: 100 }), task('v', { priority: 100, userValue: 5 }),
    task('r', { priority: 100, userValue: 5, risk: 5 }),
    task('z'), task('a')
  ]);
  assert.deepEqual(plan(input).taskIds, ['low', 'r', 'v', 'p', 'a', 'z']);
  // Equal critical path and priority/value/risk: less own effort wins.
  const tied = fixture([task('short', { estimatedEffort: 1 }), task('tail'), task('long', { estimatedEffort: 2 })]);
  tied.snapshot.tasks[1].dependsOn = ['short'];
  assert.deepEqual(plan(tied).taskIds, ['short', 'long']);
});

test('Oversized frozen input only proposes a split and never trims or mutates task acceptance', () => {
  const input = fixture([task('huge', { description: 'x'.repeat(13000) }), task('small')]);
  const before = structuredClone(input);
  const result = plan(input);
  assert.deepEqual(result.taskIds, ['small']);
  assert.ok(reasons(result, 'huge').includes('split_required'));
  assert.deepEqual(input, before);
  const throwing = ports({ buildDirectorTaskInput() { throw Object.assign(new Error('too large'), { code: 'project_task_too_large' }); } });
  assert.ok(reasons(plan(fixture(), throwing), 'one').includes('split_required'));
  assert.throws(() => plan(fixture(), ports({ buildDirectorTaskInput() { throw new Error('invalid contract'); } })), /invalid contract/);
});

test('Project controls and existing attempts prevent accidental restarts or implicit retries', () => {
  for (const status of ['cancelled', 'failed', 'blocked', 'accepted', 'released']) {
    const input = fixture(); input.snapshot.project.status = status;
    assert.deepEqual(plan(input).taskIds, []);
  }
  const input = fixture(); input.snapshot.project.paused = true;
  assert.ok(reasons(plan(input), 'one').includes('project_paused'));
  input.snapshot.project.paused = false;
  for (const status of ['reserved', 'running', 'verifying', 'integrated', 'failed', 'blocked', 'cancelled']) {
    input.snapshot.currentAttempts = [{ schemaVersion: 1, id: '30000000-0000-4000-8000-000000000001', projectId,
      taskId: 'one', taskRevision: 1, number: 1, runId: '40000000-0000-4000-8000-000000000001', contractHash: digest,
      status, baseSha: null, headSha: null, evidence: [], reason: null, createdAt: now, updatedAt: now }]; recount(input.snapshot);
    assert.deepEqual(plan(input).taskIds, [], status);
  }
});

test('Injected pure contracts receive explicit safety options without ambient I/O or a clock', () => {
  const input = fixture(); const seen = [];
  const injected = ports({ assertDirectorSafe(value, options) { seen.push(options); },
    buildDirectorTaskInput({ task: value }, options) { assert.deepEqual(options, { knownValues: [] }); return value.description; } });
  const before = structuredClone(input);
  const result = plan(input, injected);
  assert.deepEqual(result, { schemaVersion: 1, projectId, revision: 1, taskIds: ['one'], blocked: [], order: ['one'], dryRun: true });
  assert.ok(seen.length > 0); assert.deepEqual(seen[0], { knownValues: [] });
  assert.deepEqual(input, before);
  assert.throws(() => planProjectHorizon(input), { code: 'invalid_project_horizon' });
  assert.throws(() => planProjectHorizon(input, { ...injected, knownValues: undefined }), { code: 'invalid_project_horizon' });
  assert.throws(() => plan({ ...input, now: undefined }), { code: 'invalid_project_horizon' });
  assert.throws(() => plan(input, ports({ normalizeDirectorRecord: async () => input.snapshot })), { code: 'invalid_project_horizon' });
});

test('Complete exact-cap snapshots remain valid but truncation at the cap never authorizes work', () => {
  const input = fixture(Array.from({ length: 1000 }, (_, i) => task('task-' + i)));
  assert.equal(plan(input).taskIds.length, 24);
  input.snapshot.completeness.tasks.complete = false;
  assert.deepEqual(plan(input).taskIds, []);
  input.snapshot.completeness.tasks.complete = true; input.snapshot.completeness.tasks.total = 1001;
  assert.deepEqual(plan(input).taskIds, []);
  const empty = plan(fixture([]));
  assert.deepEqual(empty.taskIds, []); assert.deepEqual(empty.blocked, []); assert.deepEqual(empty.order, []);
  assert.throws(() => plan(fixture(Array.from({ length: 1001 }, (_, i) => task('task-' + i)))), { code: 'invalid_project_horizon' });
});

test('The shared frozen projection enforces the exact UTF-8 byte ceiling including project context', () => {
  const input = fixture(); const before = structuredClone(input);
  let bytes = 12000;
  const injected = ports({ buildDirectorTaskInput({ project, task: value }) {
    assert.deepEqual(project, input.snapshot.project); assert.deepEqual(value, input.snapshot.tasks[0]);
    return 'я'.repeat(bytes / 2);
  } });
  assert.deepEqual(plan(input, injected).taskIds, ['one']);
  bytes = 12002;
  assert.deepEqual(plan(input, injected).taskIds, []);
  assert.deepEqual(reasons(plan(input, injected), 'one'), ['split_required']);
  assert.deepEqual(input, before);
});

test('Raw data is guarded before access and generated output is guarded before return', () => {
  const input = fixture(); let touched = false;
  Object.defineProperty(input, 'limit', { get() { touched = true; return 24; }, enumerable: true });
  const denial = new Error('unsafe');
  assert.throws(() => plan(input, ports({ assertDirectorSafe() { throw denial; } })), error => error === denial);
  assert.equal(touched, false);
  const safe = fixture(); safe.availability = [];
  assert.throws(() => plan(safe, ports({ assertDirectorSafe(value) {
    if (value.dryRun === true) throw denial;
  } })), error => error === denial);
});

test('Duplicate or foreign current sets and stale reservations cannot create execution authority', () => {
  const input = fixture();
  input.snapshot.epics[0].projectId = '20000000-0000-4000-8000-000000000001';
  assert.deepEqual(plan(input).taskIds, []);
  const duplicate = fixture(); duplicate.snapshot.tasks.push(task('one')); recount(duplicate.snapshot);
  assert.throws(() => plan(duplicate), { code: 'invalid_project_horizon' });
  for (const key of ['epics', 'milestones']) {
    const parents = fixture(); parents.snapshot[key].push({ ...parents.snapshot[key][0] }); recount(parents.snapshot);
    assert.deepEqual(plan(parents).taskIds, []);
  }
  for (const key of ['epics', 'milestones']) {
    for (const status of ['cancelled', 'blocked', 'failed', 'accepted', 'released']) {
      const parents = fixture(); parents.snapshot[key][0].status = status;
      assert.deepEqual(plan(parents).taskIds, []);
    }
  }
  const stale = fixture(); stale.snapshot.currentAttempts = [{ projectId, taskId: 'one', taskRevision: 2, status: 'reserved' }]; recount(stale.snapshot);
  assert.deepEqual(reasons(plan(stale), 'one'), ['attempt_revision_mismatch']);
  stale.snapshot.currentAttempts.push({ ...stale.snapshot.currentAttempts[0] }); recount(stale.snapshot);
  assert.deepEqual(plan(stale).taskIds, []);
});

test('Critical-path ranking remains exact for safe-integer effort values', () => {
  const input = fixture([
    task('shorter', { estimatedEffort: Number.MAX_SAFE_INTEGER, priority: 100 }),
    task('short-tail', { dependsOn: ['shorter'], estimatedEffort: 1 }),
    task('longer', { estimatedEffort: Number.MAX_SAFE_INTEGER, priority: 0 }),
    task('long-tail', { dependsOn: ['longer'], estimatedEffort: 2 })
  ]);
  assert.deepEqual(plan(input).taskIds, ['longer', 'shorter']);
});
