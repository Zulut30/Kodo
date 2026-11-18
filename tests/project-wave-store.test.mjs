import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../runtime/store.mjs';
import * as contracts from '../runtime/project-contracts.mjs';
import { openProjectStore } from '../runtime/project-store.mjs';

const sha = value => createHash('sha256').update(value).digest('hex');
const options = { knownValues: [] };
const criterion = { id: 'works', text: 'Observable result works', evidenceKinds: ['checks'] };
const ref = {
  kind: 'checks',
  runId: null,
  headSha: null,
  path: '/srv/kodo-evidence/checks.json',
  sha256: 'a'.repeat(64),
};
const mapping = { criterionId: 'works', refs: [ref.sha256], actor: 'reviewer', reason: 'Checked result' };
const wave = { cadence: 'wave', integration: 'branch' };
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
// Same fixture as tests/project-wave-contracts.test.mjs; its store-level
// canonical hashes were captured on main 55fc4ba before the wave data layer.
function legacySpec(root) {
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
function canonical(value, { root, projectKey }) {
  const ids = new Map();
  const walk = (item, key) => {
    if (typeof item === 'string') {
      if (item === root) return '<root>';
      if (item === projectKey) return '<key>';
      if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(item)) return '<time>';
      if (['contractHash', 'previousHash', 'nextHash'].includes(key)) return '<hash>';
      if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(item)) {
        if (!ids.has(item)) ids.set(item, '<uuid-' + ids.size + '>');
        return ids.get(item);
      }
      return item;
    }
    if (Array.isArray(item)) return item.map(entry => walk(entry));
    if (item && typeof item === 'object')
      return Object.fromEntries(Object.entries(item).map(([k, v]) => [k, walk(v, k)]));
    return item;
  };
  return walk(value);
}
const golden = {
  storeSnapshot: '9d6d52beac145cd633cadb9018d5200efdbca56ffc1fb08aa24c03bb1d78d4f1',
  storeHistory: '0e02a47b2d9f6c05c1cba7e0e0e2fb27bee60b9a75192f8293cde44c26386152',
  storeResults: 'db25b98a1f50ecee2abb856a4de59f06705c927e899882c73f42523f1a042a10',
  migration: '950591186348824e77e191eda3839c502a138d23b87c6408cd7d5d21557695f1',
};

async function fixture(t) {
  const temp = mkdtempSync(path.join(os.tmpdir(), 'kodo-wave-store-'));
  const stores = [];
  t.after(() => {
    for (const store of stores.reverse()) {
      try {
        store.close();
      } catch {}
    }
    rmSync(temp, { recursive: true, force: true });
  });
  const home = path.join(temp, 'state');
  // Fixture SHAs are not Git objects: the Git range of a reservation is a fake port here
  // (tests/wave-verifier.test.mjs covers the real Git one).
  const ranges = { refused: new Set() };
  const gateRange = async ({ baseSha, headSha }) => !ranges.refused.has(`${baseSha}..${headSha}`);
  const open = async () => {
    const store = new Store(home, {});
    stores.push(store);
    return {
      store,
      repo: await openProjectStore({ store, contracts, authorizeTransition: async () => undefined, gateRange }),
    };
  };
  const { store, repo } = await open();
  let roots = 0;
  const root = () => {
    const directory = path.join(temp, 'project-' + roots++);
    mkdirSync(directory);
    return directory;
  };
  const command = (projectId, expectedRevision, action, commandId = randomUUID()) => ({
    schemaVersion: 1,
    commandId,
    projectId,
    expectedRevision,
    actor: 'owner',
    reason: 'Wave store test',
    action,
  });
  const run = (projectId, action, commandId) =>
    repo.apply(command(projectId, repo.snapshot(projectId).revision, action, commandId));
  const create = async (spec, commandId) =>
    (await repo.apply(command(null, null, { op: 'create', spec }, commandId))).projectId;
  // Real forward transitions through the permissive test authorizer.
  const drive = async (projectId, kind, id, states) => {
    for (const to of states) {
      const proof = to === 'accepted' ? { evidence: [ref], mappings: [mapping] } : { evidence: [], mappings: [] };
      await run(projectId, { op: 'transition', kind, id, to, ...proof });
    }
  };
  const current = (projectId, taskId) => repo.snapshot(projectId).currentAttempts.find(a => a.taskId === taskId);
  const integrate = async (projectId, taskId) => {
    await run(projectId, { op: 'reserveAttempt', taskId, retryFailed: false });
    const attempt = current(projectId, taskId);
    await drive(projectId, 'task', taskId, ['ready', 'running', 'verifying', 'integrated']);
    await drive(projectId, 'attempt', attempt.id, ['running', 'verifying', 'integrated']);
    return attempt;
  };
  const accept = async (projectId, taskId) => {
    const attempt = current(projectId, taskId);
    await drive(projectId, 'attempt', attempt.id, ['accepted']);
    await drive(projectId, 'task', taskId, ['accepted']);
  };
  const forward = ['ready', 'running', 'verifying', 'integrated', 'accepted'];
  return {
    temp,
    home,
    store,
    repo,
    open,
    root,
    command,
    run,
    create,
    drive,
    integrate,
    accept,
    current,
    forward,
    ranges,
  };
}
const waveSpec = (root, tasks = [taskSpec('a'), taskSpec('b', { dependsOn: ['a'] })]) => ({
  ...legacySpec(root),
  tasks,
  execution: { ...wave },
});
const append = (extra = {}) => ({
  op: 'appendMilestone',
  milestone: milestoneSpec('m2'),
  epics: [epicSpec('e2', 'm2')],
  tasks: [taskSpec('c', { epicId: 'e2', dependsOn: ['a'] }), taskSpec('d', { epicId: 'e2', dependsOn: ['c'] })],
  ...extra,
});
const mergeOf = (attempt, mergeCommit = '4'.repeat(40)) => ({
  taskId: attempt.taskId,
  attemptId: attempt.id,
  runId: attempt.runId,
  mergeCommit,
});
// A gate Run draft of the shape createGateRunDraft builds: the covered tasks are
// planned and integrated at their merge commits; the Run starts on the gate head.
function gateDraft(repo, projectId, gate) {
  const s = repo.snapshot(projectId);
  const tasks = gate.merges.map(m => s.tasks.find(t => t.id === m.taskId));
  return {
    id: gate.runId,
    project: s.project.root,
    task: contracts.buildGateInput(
      { project: s.project, gate, tasks, containers: contracts.gateContainerCriteria(s, gate) },
      options,
    ),
    createdAt: '2026-11-17T12:00:00.000Z',
    state: 'created',
    completed: { implementation: true },
    nodes: Object.fromEntries(
      gate.merges.map(m => [
        m.taskId,
        {
          id: m.taskId,
          attempt: 0,
          status: 'integrated',
          headSha: m.mergeCommit,
          sourceRunId: m.runId,
          attemptId: m.attemptId,
        },
      ]),
    ),
    plan: {
      summary: 'Gate over the covered tasks',
      tasks: tasks.map(t => ({
        id: t.id,
        role: 'developer',
        description: t.description,
        dependsOn: [],
        writePaths: [...t.writePaths],
        acceptance: ['works'],
        parallel: false,
      })),
    },
    planSource: 'gate',
    config: { client: 'codex', delivery: { enabled: false } },
    client: 'codex',
    providers: 'current',
    baseSha: gate.baseSha,
    headSha: gate.headSha,
    snapshot: { root: s.project.root, head: gate.headSha },
    requestedMode: 'quick',
    sessionAttempts: [],
    coordinatorOperations: [],
    artifacts: path.join(s.project.root, 'fake-artifacts'),
    worktreeRoot: path.join(s.project.root, 'fake-worktrees'),
    cwd: path.join(s.project.root, 'fake-worktrees', 'integration'),
    branch: 'kodo/wave-gate',
    directorBinding: contracts.gateBindingFor(gate, options),
    gateManifest: {
      path: path.join(s.project.root, 'fake-artifacts', 'evidence', `gate-manifest-${'a'.repeat(64)}.json`),
      sha256: 'a'.repeat(64),
      bytes: 10,
      headSha: gate.headSha,
    },
  };
}
const rows = (store, projectId) =>
  store.db
    .prepare('SELECT kind,id FROM kodo_project_records WHERE project_id=? ORDER BY kind,id')
    .all(projectId)
    .map(row => row.kind + ':' + row.id);
const events = (store, projectId) =>
  store.db.prepare('SELECT COUNT(*) AS n FROM kodo_project_events WHERE project_id=?').get(projectId).n;

test('Legacy store bytes, snapshot keys and migration digest stay golden; wave ops are refused', async t => {
  const f = await fixture(t);
  const root = f.root();
  const ids = [5, 6, 7, 8, 9].map(
    n =>
      `${String(n).repeat(8)}-${String(n).repeat(4)}-4${String(n).repeat(3)}-8${String(n).repeat(3)}-${String(n).repeat(12)}`,
  );
  const cmd = (index, projectId, expectedRevision, action) => ({
    schemaVersion: 1,
    commandId: ids[index],
    projectId,
    expectedRevision,
    actor: 'owner',
    reason: 'Golden step ' + index,
    action,
  });
  const results = [];
  const created = await f.repo.apply(cmd(0, null, null, { op: 'create', spec: legacySpec(root) }));
  results.push(created);
  const pid = created.projectId;
  results.push(await f.repo.apply(cmd(1, pid, 1, { op: 'approveRisk', taskId: 'b', taskRevision: 1 })));
  results.push(await f.repo.apply(cmd(2, pid, 2, { op: 'reserveAttempt', taskId: 'a', retryFailed: false })));
  results.push(await f.repo.apply(cmd(3, pid, 3, { op: 'setPaused', paused: true })));
  results.push(await f.repo.apply(cmd(4, pid, 4, { op: 'setPaused', paused: false })));
  results.push(await f.repo.apply(cmd(4, pid, 4, { op: 'setPaused', paused: false })));
  const snapshot = f.repo.snapshot(pid);
  const c = value => sha(JSON.stringify(canonical(value, { root, projectKey: snapshot.project.projectKey })));
  assert.deepEqual(
    {
      storeSnapshot: c(snapshot),
      storeHistory: c(f.repo.history(pid)),
      storeResults: c(results),
      migration: f.store.db.prepare('SELECT digest FROM kodo_project_migrations WHERE version=1').get().digest,
    },
    golden,
  );
  assert.deepEqual(Object.keys(snapshot), [
    'schemaVersion',
    'project',
    'revision',
    'milestones',
    'epics',
    'tasks',
    'currentAttempts',
    'riskApprovals',
    'completeness',
  ]);
  assert.deepEqual(Object.keys(snapshot.completeness), [
    'milestones',
    'epics',
    'tasks',
    'currentAttempts',
    'riskApprovals',
  ]);
  const before = f.repo.snapshot(pid).revision;
  const attempt = f.current(pid, 'a');
  await assert.rejects(
    f.run(pid, {
      op: 'reserveGate',
      containers: [{ kind: 'epic', id: 'e' }],
      baseSha: '1'.repeat(40),
      headSha: '3'.repeat(40),
      merges: [mergeOf(attempt)],
      retry: false,
    }),
    { code: 'project_gate_unsupported' },
  );
  await assert.rejects(f.run(pid, append()), { code: 'project_append_blocked' });
  assert.equal(f.repo.snapshot(pid).revision, before);
  const legacyRows = rows(f.store, pid);
  assert.equal(
    legacyRows.some(row => row.startsWith('gate:') || ['milestone:m2', 'epic:e2', 'task:c'].includes(row)),
    false,
  );

  // Explicit task/frontier execution is stored as given and behaves as legacy.
  const explicit = await f.create({
    ...legacySpec(f.root()),
    tasks: [taskSpec('a'), taskSpec('b', { dependsOn: ['a'] })],
    execution: { cadence: 'task', integration: 'frontier' },
  });
  const explicitSnapshot = f.repo.snapshot(explicit);
  assert.deepEqual(explicitSnapshot.project.execution, { cadence: 'task', integration: 'frontier' });
  assert.equal(Object.hasOwn(explicitSnapshot, 'gates'), false);
  await f.integrate(explicit, 'a');
  await assert.rejects(f.drive(explicit, 'task', 'b', ['ready']), { code: 'project_dependency' });
  await assert.rejects(
    f.run(explicit, {
      op: 'reserveGate',
      containers: [{ kind: 'epic', id: 'e' }],
      baseSha: '1'.repeat(40),
      headSha: '3'.repeat(40),
      merges: [mergeOf(f.current(explicit, 'a'))],
      retry: false,
    }),
    {
      code: 'project_gate_unsupported',
    },
  );
});

test('appendMilestone reopens a closed wave project in one atomic, replayable event', async t => {
  const f = await fixture(t);
  const pid = await f.create(waveSpec(f.root(), [taskSpec('a')]));
  assert.deepEqual(f.repo.snapshot(pid).gates, []);
  await f.integrate(pid, 'a');
  await f.accept(pid, 'a');
  for (const [kind, id] of [
    ['epic', 'e'],
    ['milestone', 'm'],
    ['project', pid],
  ])
    await f.drive(pid, kind, id, f.forward);
  const closed = f.repo.snapshot(pid);
  assert.equal(closed.project.status, 'accepted');
  assert.deepEqual(closed.project.evidence, [ref]);

  // Ordinary inserts under accepted parents are still refused.
  await assert.rejects(f.run(pid, { op: 'insert', kind: 'task', record: taskSpec('x') }), {
    code: 'project_insertion_blocked',
  });
  await assert.rejects(f.run(pid, { op: 'insert', kind: 'milestone', record: milestoneSpec('m9') }), {
    code: 'project_insertion_blocked',
  });
  // CAS on the project revision.
  await assert.rejects(f.repo.apply(f.command(pid, closed.revision - 1, append())), {
    code: 'project_revision_conflict',
  });
  // Identity collisions leave no partial rows and no event.
  const rowsBefore = rows(f.store, pid),
    eventsBefore = events(f.store, pid);
  for (const action of [
    append({ tasks: [taskSpec('c', { epicId: 'e2' }), taskSpec('a', { epicId: 'e2' })] }),
    append({ milestone: milestoneSpec('m') }),
    append({ epics: [epicSpec('e2', 'm2'), epicSpec('e', 'm2')] }),
  ])
    await assert.rejects(f.run(pid, action), { code: 'project_identity_conflict' });
  await assert.rejects(f.run(pid, append({ epics: [epicSpec('e2', 'm')] })), { code: 'project_parent_invalid' });
  await assert.rejects(f.run(pid, append({ tasks: [taskSpec('c', { epicId: 'e2', dependsOn: ['c'] })] })), {
    code: 'project_dependency_invalid',
  });
  assert.deepEqual(rows(f.store, pid), rowsBefore);
  assert.equal(events(f.store, pid), eventsBefore);
  assert.equal(f.repo.snapshot(pid).revision, closed.revision);

  const commandId = randomUUID();
  const input = f.command(pid, closed.revision, append(), commandId);
  const result = await f.repo.apply(input);
  assert.equal(result.revision, closed.revision + 1);
  assert.deepEqual(result.entity, { kind: 'project', id: pid });
  assert.equal(result.replayed, false);
  const opened = f.repo.snapshot(pid);
  assert.equal(opened.project.status, 'running');
  assert.deepEqual(opened.project.evidence, []);
  assert.deepEqual(opened.project.mappings, []);
  assert.deepEqual(opened.project.execution, wave);
  assert.equal(opened.project.reopened.length, 1);
  const [entry] = opened.project.reopened;
  assert.deepEqual(
    { ...entry, reopenedAt: undefined },
    { status: 'accepted', revision: closed.revision, reopenedAt: undefined, evidence: [ref], mappings: [mapping] },
  );
  assert.equal(entry.reopenedAt, opened.project.updatedAt);
  // Closed children are untouched; new records start proposed at revision 1.
  for (const key of ['milestones', 'epics', 'tasks'])
    for (const row of closed[key])
      assert.deepEqual(
        opened[key].find(r => r.id === row.id),
        row,
      );
  for (const [key, id] of [
    ['milestones', 'm2'],
    ['epics', 'e2'],
    ['tasks', 'c'],
    ['tasks', 'd'],
  ]) {
    const row = opened[key].find(r => r.id === id);
    assert.equal(row.status, 'proposed');
    assert.equal(row.revision, 1);
  }
  const history = f.repo.history(pid, { after: 0, limit: 1000 });
  const appended = history.events.filter(e => e.type === 'appendMilestone');
  assert.equal(appended.length, 1);
  assert.equal(history.events.at(-1).type, 'appendMilestone');
  assert.equal(events(f.store, pid), eventsBefore + 1);

  // Replay returns the stored result; a changed payload under the same ID conflicts.
  assert.deepEqual(await f.repo.apply(input), { ...result, replayed: true });
  await assert.rejects(f.repo.apply({ ...input, reason: 'Different payload' }), { code: 'project_command_conflict' });
  assert.equal(events(f.store, pid), eventsBefore + 1);
  // The project is running again: a second append is blocked until it closes.
  await assert.rejects(
    f.run(
      pid,
      append({
        milestone: milestoneSpec('m3'),
        epics: [epicSpec('e3', 'm3')],
        tasks: [taskSpec('z', { epicId: 'e3' })],
      }),
    ),
    { code: 'project_append_blocked' },
  );
  // Closed dependencies admit the new work; the accepted->running edge itself stays forbidden.
  await f.drive(pid, 'task', 'c', ['ready']);
  await assert.rejects(f.drive(pid, 'milestone', 'm', ['running']), { code: 'project_transition' });
  // Reopened history survives a restart byte-for-byte.
  const reopened = await f.open();
  assert.deepEqual(reopened.repo.snapshot(pid).project, f.repo.snapshot(pid).project);
});

test('appendMilestone is refused while attempts are unsettled or the project is paused', async t => {
  const f = await fixture(t);
  const pid = await f.create(waveSpec(f.root(), [taskSpec('a')]));
  await assert.rejects(f.run(pid, append()), { code: 'project_append_blocked' });
  await f.run(pid, { op: 'setPaused', paused: true });
  await assert.rejects(f.run(pid, append()), { code: 'project_append_blocked' });
  assert.equal(rows(f.store, pid).includes('milestone:m2'), false);
});

// The task Run of an attempt records its merge into the integration branch.
function recordMerge(store, attempt, mergeCommit, headSha = 'b'.repeat(40)) {
  store.createRun({
    id: attempt.runId,
    headSha,
    integration: {
      branch: 'kodo/project/x',
      before: '0'.repeat(40),
      mergeCommit,
      mergedHead: headSha,
      status: 'merged',
    },
  });
}

test('reserveGate validates scope, merges and retries; installGateRun binds exactly one Run', async t => {
  const f = await fixture(t);
  const pid = await f.create(waveSpec(f.root()));
  const a = await f.integrate(pid, 'a');
  // Wave dependency rule in the store: an integrated prerequisite unlocks ready.
  const b = await f.integrate(pid, 'b');
  recordMerge(f.store, a, '4'.repeat(40));
  recordMerge(f.store, b, '5'.repeat(40), 'c'.repeat(40));
  const containers = [
    { kind: 'epic', id: 'e' },
    { kind: 'milestone', id: 'm' },
    { kind: 'project', id: pid },
  ];
  const reserve = (extra = {}) => ({
    op: 'reserveGate',
    containers,
    baseSha: '0'.repeat(40),
    headSha: '3'.repeat(40),
    merges: [mergeOf(a), mergeOf(b, '5'.repeat(40))],
    retry: false,
    ...extra,
  });
  const before = f.repo.snapshot(pid).revision;
  for (const action of [
    reserve({ merges: [mergeOf(a)] }),
    reserve({ merges: [mergeOf(a), { ...mergeOf(b), attemptId: a.id }] }),
    reserve({ merges: [mergeOf(a), { ...mergeOf(b), runId: a.runId }] }),
    reserve({ merges: [mergeOf(a), mergeOf(b), { ...mergeOf(b), taskId: 'x' }] }),
    reserve({ containers: [{ kind: 'epic', id: 'missing' }] }),
    reserve({
      containers: [
        { kind: 'epic', id: 'e' },
        { kind: 'milestone', id: 'other' },
      ],
    }),
  ])
    await assert.rejects(f.run(pid, action), { code: 'project_gate_invalid' });
  assert.equal(f.repo.snapshot(pid).revision, before);

  const reserved = await f.run(pid, reserve());
  assert.equal(reserved.entity.kind, 'gate');
  assert.equal(reserved.revision, before + 1);
  const s = f.repo.snapshot(pid);
  assert.deepEqual(Object.keys(s).slice(-2), ['completeness', 'gates']);
  assert.deepEqual(s.completeness.gates, { total: 1, returned: 1, complete: true });
  const [gate] = s.gates;
  assert.equal(gate.id, reserved.entity.id);
  assert.equal(gate.number, 1);
  assert.equal(gate.installed, false);
  assert.deepEqual(gate.containers, containers);
  assert.deepEqual(gate.merges, reserve().merges);
  assert.ok(![a.runId, b.runId].includes(gate.runId));
  assert.equal(f.repo.history(pid).events.at(-1).type, 'reserveGate');

  // The latest gate for containers[0] blocks a duplicate until its Run fails.
  await assert.rejects(f.run(pid, reserve()), { code: 'project_gate_exists' });
  await assert.rejects(f.run(pid, reserve({ retry: true })), { code: 'project_gate_exists' });

  const binding = contracts.gateBindingFor(gate, options);
  const runDraft = gateDraft(f.repo, pid, gate);
  for (const foreign of [
    { ...binding, mergesHash: 'f'.repeat(64) },
    { ...binding, gateId: randomUUID() },
    { ...binding, headSha: '9'.repeat(40) },
    { ...binding, number: 2 },
  ])
    await assert.rejects(
      f.repo.installGateRun({ binding: foreign, runDraft: { ...runDraft, directorBinding: foreign } }),
      {
        code: 'project_binding_conflict',
      },
    );
  await assert.rejects(f.repo.installGateRun({ binding, runDraft: { ...runDraft, task: 'altered gate input' } }), {
    code: 'project_binding_conflict',
  });
  await assert.rejects(
    f.repo.installGateRun({ binding, runDraft: { ...runDraft, directorBinding: { ...binding, number: 2 } } }),
    {
      code: 'project_binding_conflict',
    },
  );
  // The gate draft has its own shape: covered plan, integrated nodes, the full verification.
  const [firstNode] = Object.values(runDraft.nodes);
  for (const [label, draft] of [
    ['running state', { ...runDraft, state: 'running' }],
    ['task-fast profile', { ...runDraft, verificationProfile: 'task-fast' }],
    ['external executor', { ...runDraft, executor: { kind: 'external', host: 't3' } }],
    ['empty nodes', { ...runDraft, nodes: {} }],
    ['empty completed', { ...runDraft, completed: {} }],
    ['stale node head', { ...runDraft, nodes: { ...runDraft.nodes, a: { ...firstNode, headSha: '7'.repeat(40) } } }],
    ['missing plan', { ...runDraft, plan: { summary: 'none', tasks: [] } }],
    [
      'other write paths',
      {
        ...runDraft,
        plan: {
          ...runDraft.plan,
          tasks: [{ ...runDraft.plan.tasks[0], writePaths: ['README.md'] }, runDraft.plan.tasks[1]],
        },
      },
    ],
    ['other head', { ...runDraft, headSha: '9'.repeat(40) }],
    ['other base', { ...runDraft, baseSha: '9'.repeat(40) }],
    ['delivery', { ...runDraft, config: { ...runDraft.config, delivery: { enabled: true } } }],
  ])
    await assert.rejects(
      f.repo.installGateRun({ binding, runDraft: draft }),
      { code: 'project_run_draft_invalid' },
      label,
    );
  await assert.rejects(f.repo.installGateRun({ binding, runDraft, extra: true }), { code: 'project_record_invalid' });
  const installedRevision = f.repo.snapshot(pid).revision;
  const saved = await f.repo.installGateRun({ binding, runDraft });
  assert.equal(saved.id, gate.runId);
  assert.equal(saved.verificationProfile, undefined);
  assert.deepEqual(saved.completed, { implementation: true });
  assert.deepEqual(saved.directorBinding, binding);
  const afterInstall = f.repo.snapshot(pid);
  assert.equal(afterInstall.revision, installedRevision + 1);
  assert.equal(afterInstall.gates[0].installed, true);
  // Replays, including after a restart, return the same saved Run without a new revision.
  assert.deepEqual(await f.repo.installGateRun({ binding, runDraft }), saved);
  const restarted = await f.open();
  assert.deepEqual(await restarted.repo.installGateRun({ binding, runDraft }), saved);
  assert.equal(f.repo.snapshot(pid).revision, installedRevision + 1);
  assert.deepEqual(f.store.getRun(gate.runId), saved);

  // A running gate still blocks retries; a failed gate admits exactly one retry.
  await assert.rejects(f.run(pid, reserve({ retry: true })), { code: 'project_gate_exists' });
  f.store.updateRun(gate.runId, { state: 'failed' });
  await assert.rejects(f.run(pid, reserve()), { code: 'project_gate_exists' });
  const retried = await f.run(pid, reserve({ retry: true, headSha: '6'.repeat(40) }));
  const gates = f.repo.snapshot(pid).gates;
  assert.deepEqual(
    gates.map(g => [g.number, g.installed]),
    [
      [1, true],
      [2, false],
    ],
  );
  assert.equal(gates[1].id, retried.entity.id);
  assert.notEqual(gates[1].runId, gate.runId);
  // An uninstalled reservation on the same head is not duplicated.
  await assert.rejects(f.run(pid, reserve({ retry: true, headSha: '6'.repeat(40) })), { code: 'project_gate_exists' });
  // The installed, superseded gate still replays its own (now failed) Run and nothing else.
  const replayed = await f.repo.installGateRun({ binding, runDraft });
  assert.deepEqual([replayed.id, replayed.state], [gate.runId, 'failed']);

  // Review finding F1-3: an uninstalled reservation whose head went stale is replaced atomically
  // by a reservation on the current head; the stale one names its successor and never installs.
  const stale = gates[1];
  const replacing = await f.run(pid, reserve({ headSha: '7'.repeat(40) }));
  const replaced = f.repo.snapshot(pid).gates;
  assert.deepEqual(
    replaced.map(g => [g.number, g.installed, g.supersededBy ?? null, g.headSha.slice(0, 1)]),
    [
      [1, true, null, '3'],
      [2, false, replacing.entity.id, '6'],
      [3, false, null, '7'],
    ],
  );
  assert.equal(f.repo.history(pid).events.at(-1).type, 'reserveGate');
  await assert.rejects(
    f.repo.installGateRun({
      binding: contracts.gateBindingFor(stale, options),
      runDraft: gateDraft(f.repo, pid, stale),
    }),
    { code: 'project_binding_conflict' },
    'a superseded reservation is never installed',
  );
  const current = replaced[2];
  const installed = await f.repo.installGateRun({
    binding: contracts.gateBindingFor(current, options),
    runDraft: gateDraft(f.repo, pid, current),
  });
  assert.equal(installed.id, current.runId);

  // A milestone-first gate needs every epic of the milestone accepted.
  await assert.rejects(f.run(pid, reserve({ containers: [{ kind: 'milestone', id: 'm' }] })), {
    code: 'project_gate_invalid',
  });
});

test('reserveGate binds only the merge commits the attempts recorded for their verified heads', async t => {
  const f = await fixture(t);
  const pid = await f.create(waveSpec(f.root()));
  const a = await f.integrate(pid, 'a');
  const b = await f.integrate(pid, 'b');
  const reserve = merges => ({
    op: 'reserveGate',
    containers: [{ kind: 'epic', id: 'e' }],
    baseSha: '0'.repeat(40),
    headSha: '3'.repeat(40),
    merges,
    retry: false,
  });
  // Without a task Run recording the merge nothing can be bound.
  await assert.rejects(f.run(pid, reserve([mergeOf(a), mergeOf(b, '5'.repeat(40))])), {
    code: 'project_gate_invalid',
  });
  recordMerge(f.store, a, '4'.repeat(40));
  recordMerge(f.store, b, '5'.repeat(40), 'c'.repeat(40));
  const before = f.repo.snapshot(pid).revision;
  // An older (or any other) commit than the recorded merge of the current attempt is refused.
  await assert.rejects(f.run(pid, reserve([mergeOf(a, '7'.repeat(40)), mergeOf(b, '5'.repeat(40))])), {
    code: 'project_gate_invalid',
  });
  const recorded = f.store.getRun(b.runId);
  for (const integration of [
    { ...recorded.integration, status: 'pending' },
    { ...recorded.integration, mergedHead: 'd'.repeat(40) },
  ]) {
    f.store.updateRun(b.runId, { integration });
    await assert.rejects(f.run(pid, reserve([mergeOf(a), mergeOf(b, '5'.repeat(40))])), {
      code: 'project_gate_invalid',
    });
  }
  assert.equal(f.repo.snapshot(pid).revision, before);
  f.store.updateRun(b.runId, { integration: recorded.integration });
  await f.run(pid, reserve([mergeOf(a), mergeOf(b, '5'.repeat(40))]));
  assert.equal(f.repo.snapshot(pid).gates.length, 1);
});

test('reserveGate refuses an empty or misplaced gate range: base = head, base not a recorded first parent, merges outside base..head', async t => {
  // Review finding F1-1: a gate with baseSha = headSha reviewed an empty diff and was accepted.
  const f = await fixture(t);
  const pid = await f.create(waveSpec(f.root()));
  const a = await f.integrate(pid, 'a');
  const b = await f.integrate(pid, 'b');
  recordMerge(f.store, a, '4'.repeat(40));
  recordMerge(f.store, b, '5'.repeat(40), 'c'.repeat(40));
  const reserve = (extra = {}) => ({
    op: 'reserveGate',
    containers: [{ kind: 'epic', id: 'e' }],
    baseSha: '0'.repeat(40),
    headSha: '5'.repeat(40),
    merges: [mergeOf(a), mergeOf(b, '5'.repeat(40))],
    retry: false,
    ...extra,
  });
  const before = f.repo.snapshot(pid).revision;
  for (const [label, action] of [
    ['base = head', reserve({ headSha: '0'.repeat(40) })],
    ['base is not the recorded first parent of a covered merge', reserve({ baseSha: '1'.repeat(40) })],
    ['base is a covered merge', reserve({ baseSha: '4'.repeat(40) })],
  ])
    await assert.rejects(f.run(pid, action), { code: 'project_gate_invalid' }, label);
  // Git: the covered merges are not all strict descendants of the base inside the head.
  f.ranges.refused.add(`${'0'.repeat(40)}..${'5'.repeat(40)}`);
  await assert.rejects(f.run(pid, reserve()), { code: 'project_gate_invalid' }, 'Git range');
  assert.equal(f.repo.snapshot(pid).revision, before);
  f.ranges.refused.clear();
  await f.run(pid, reserve());
  assert.deepEqual(
    f.repo.snapshot(pid).gates.map(gate => [gate.baseSha, gate.headSha]),
    [['0'.repeat(40), '5'.repeat(40)]],
  );
});

test('A milestone joins a gate chain only when its other epics are already accepted', async t => {
  const f = await fixture(t);
  const pid = await f.create({
    ...waveSpec(f.root(), [taskSpec('a'), taskSpec('c', { epicId: 'e2' })]),
    epics: [epicSpec('e'), epicSpec('e2')],
  });
  const a = await f.integrate(pid, 'a');
  const c = await f.integrate(pid, 'c');
  recordMerge(f.store, a, '4'.repeat(40));
  recordMerge(f.store, c, '5'.repeat(40), 'c'.repeat(40));
  const merges = [mergeOf(a), mergeOf(c, '5'.repeat(40))];
  const reserve = (containers, gateMerges = merges) => ({
    op: 'reserveGate',
    containers,
    baseSha: '0'.repeat(40),
    headSha: '3'.repeat(40),
    merges: gateMerges,
    retry: false,
  });
  const epic = id => ({ kind: 'epic', id }),
    milestone = { kind: 'milestone', id: 'm' },
    project = { kind: 'project', id: pid };
  // Neither sibling may pull the shared milestone (or the project) into its gate while the other is open.
  for (const containers of [
    [epic('e'), milestone],
    [epic('e2'), milestone],
    [epic('e'), milestone, project],
    [milestone],
    [milestone, project],
  ])
    await assert.rejects(f.run(pid, reserve(containers)), { code: 'project_gate_invalid' }, JSON.stringify(containers));
  assert.equal(f.repo.snapshot(pid).gates.length, 0);
  // Once e2 is accepted, e's gate may verify the milestone and the project too.
  await f.accept(pid, 'c');
  await f.drive(pid, 'epic', 'e2', f.forward);
  await assert.rejects(f.run(pid, reserve([epic('e2'), milestone])), { code: 'project_gate_invalid' });
  await f.run(pid, reserve([epic('e'), milestone, project]));
  assert.deepEqual(
    f.repo.snapshot(pid).gates.map(gate => gate.containers),
    [[epic('e'), milestone, project]],
  );
});
