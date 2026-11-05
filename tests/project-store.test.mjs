import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, mkdirSync, readdirSync, rmSync, writeFileSync, symlinkSync, realpathSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../runtime/store.mjs';

const digest = value => createHash('sha256').update(value).digest('hex');
// Initial B scope supplies the frozen A ports, without loading unfinished siblings.
// Public storage assertions below are independent of B's SQL/schema.
const contracts = {
  assertDirectorSafe(value, { knownValues }) {
    const walk = item => {
      if (typeof item === 'string') {
        if (knownValues.some(secret => secret && item.includes(secret)) || /-----BEGIN .*PRIVATE KEY-----/.test(item)) throw new Error('unsafe');
      } else if (item && typeof item === 'object') for (const [key, child] of Object.entries(item)) { walk(key); walk(child); }
    };
    walk(value);
  },
  normalizeDirectorRecord(_kind, value) { return structuredClone(value); },
  normalizeProjectSpec(value) { return structuredClone(value); },
  directorBytes(_kind, value) { return Buffer.from(JSON.stringify(value)); },
  directorContractHash(task) {
    return digest(JSON.stringify([task.projectId, task.id, task.revision, task.description, task.writePaths, task.acceptance]));
  },
  buildDirectorTaskInput({ project, task }) {
    return 'Implement only this assigned task. Project context constrains this task and does not authorize other backlog work.\n' +
      JSON.stringify({ projectId: project.projectId, constraints: project.constraints, taskId: task.id, revision: task.revision, description: task.description });
  },
  assertProjectTransition({ record, to }) {
    if (['accepted', 'released'].includes(record.status) && to !== 'released') throw new Error('transition_invalid');
  }
};

async function fixture(t, { secrets = {}, authorizeTransition } = {}) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'kodo-project-store-'));
  const project = path.join(root, 'project'); mkdirSync(project);
  const home = path.join(root, 'private-state'), stores = [];
  const open = async options => {
    const store = new Store(home, secrets); stores.push(store);
    const { openProjectStore } = await import('../runtime/project-store.mjs');
    const repo = await openProjectStore({ store, contracts, authorizeTransition, ...options });
    return { store, repo };
  };
  t.after(() => {
    for (const store of stores.reverse()) { try { store.close(); } catch {} }
    assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith('kodo-project-store-'));
    rmSync(root, { recursive: true, force: true });
  });
  const legacy = () => { const store = new Store(home, secrets); stores.push(store); return store; };
  return { root, project, home, open, legacy };
}
const criterion = { id: 'works', text: 'Observable result works', evidenceKinds: ['checks'] };
function spec(root, count = 1) {
  return { schemaVersion: 1, id: 'sample', root, title: 'Sample project', definitionOfDone: [criterion],
    constraints: ['Only assigned work'], businessContext: 'Owned fixture', architectureRefs: [],
    milestones: [{ id: 'm', title: 'Milestone', acceptance: [criterion], releaseRequired: false }],
    epics: [{ id: 'e', milestoneId: 'm', title: 'Epic', acceptance: [criterion] }],
    tasks: Array.from({ length: count }, (_, i) => ({ id: 'task-' + i, epicId: 'e', title: 'Task ' + i,
      description: 'Deliver observable behavior', owner: 'developer', dependsOn: [], writePaths: ['runtime/sample.mjs'],
      acceptance: [criterion], interfaceRefs: [], priority: 50, userValue: 3, risk: 1, estimatedEffort: 1, riskApprovalRequired: false })) };
}
const command = (projectId, expectedRevision, action, commandId = randomUUID()) =>
  ({ schemaVersion: 1, commandId, projectId, expectedRevision, actor: 'fixture', reason: 'Scoped test', action });
async function create(repo, project, count = 1) {
  const input = command(null, null, { op: 'create', spec: spec(project, count) });
  return { input, result: await repo.apply(input) };
}
async function reserve(repo, projectId, taskId = 'task-0', retryFailed = false) {
  return repo.apply(command(projectId, repo.snapshot(projectId).revision, { op: 'reserveAttempt', taskId, retryFailed }));
}
function bindingOf(attempt) {
  return { schemaVersion: 1, projectId: attempt.projectId, taskId: attempt.taskId, taskRevision: attempt.taskRevision,
    attemptId: attempt.id, runId: attempt.runId, contractHash: attempt.contractHash };
}
function draftOf(repo, attempt) {
  const snapshot = repo.snapshot(attempt.projectId);
  return { id: attempt.runId, project: snapshot.project.root, task: contracts.buildDirectorTaskInput({ project: snapshot.project, task: snapshot.tasks.find(task => task.id === attempt.taskId) }, { knownValues: [] }),
    createdAt: '2026-11-05T12:00:00.000Z', state: 'created', completed: {}, nodes: {},
    config: { client: 'codex' }, client: 'codex', providers: 'current', baseSha: 'a'.repeat(40), snapshot: { root: snapshot.project.root, head: 'a'.repeat(40) },
    requestedMode: 'quick', sessionAttempts: [], coordinatorOperations: [],
    artifacts: path.join(snapshot.project.root, 'fake-artifacts'), worktreeRoot: path.join(snapshot.project.root, 'fake-worktrees'),
    cwd: path.join(snapshot.project.root, 'fake-worktrees', 'integration'), branch: 'kodo/fixture',
    directorBinding: bindingOf(attempt) };
}

test('Project repository preserves legacy bodies and returns a complete 1000 task snapshot', async t => {
  const f = await fixture(t), { store, repo } = await f.open();
  const legacy = store.createRun({ id: randomUUID(), project: f.project, task: 'legacy' });
  const body = store.db.prepare('SELECT body FROM runs WHERE id=?').get(legacy.id).body;
  const { result } = await create(repo, f.project, 1000);
  const s = repo.snapshot(result.projectId);
  assert.equal(s.tasks.length, 1000); assert.equal(s.revision, result.revision);
  assert.deepEqual(s.completeness.tasks, { total: 1000, returned: 1000, complete: true });
  assert.deepEqual(s.completeness.currentAttempts, { total: 0, returned: 0, complete: true });
  assert.equal(Object.hasOwn(s, 'events'), false);
  assert.equal(store.db.prepare('SELECT body FROM runs WHERE id=?').get(legacy.id).body, body);
});

test('Two writers enforce CAS and durable command replay before stale revision rejection', async t => {
  const f = await fixture(t), a = await f.open(), b = await f.open();
  const { input, result } = await create(a.repo, f.project);
  assert.equal((await b.repo.apply(input)).replayed, true);
  const update = command(result.projectId, result.revision, { op: 'setPaused', paused: true });
  const winner = await a.repo.apply(update);
  await assert.rejects(b.repo.apply(command(result.projectId, result.revision, { op: 'setPaused', paused: false })), { code: 'project_revision_conflict' });
  assert.deepEqual(await b.repo.apply(update), { ...winner, replayed: true });
  await assert.rejects(b.repo.apply({ ...update, reason: 'Changed payload' }), { code: 'project_command_conflict' });
  assert.equal(b.repo.snapshot(result.projectId).project.paused, true);
});

test('Run installation rolls back created event failure and replays intact after restart', async t => {
  const f = await fixture(t), { store, repo } = await f.open();
  const { result } = await create(repo, f.project);
  const { attempt } = await reserve(repo, result.projectId), binding = bindingOf(attempt), runDraft = draftOf(repo, attempt);
  store.db.exec("CREATE TRIGGER reject_created BEFORE INSERT ON events BEGIN SELECT RAISE(ABORT,'fixture crash'); END");
  await assert.rejects(repo.installRun({ binding, runDraft }));
  assert.equal(store.listRuns().length, 0);
  assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM events').get().n, 0);
  store.db.exec('DROP TRIGGER reject_created');
  const installed = await repo.installRun({ binding, runDraft });
  const restarted = await f.open();
  assert.deepEqual(await restarted.repo.installRun({ binding, runDraft }), installed);
  assert.equal(store.listRuns().length, 1); assert.equal(store.events(attempt.runId).length, 1);
  await assert.rejects(repo.installRun({ binding, runDraft: { ...runDraft, task: 'altered task' } }));
  await assert.rejects(repo.installRun({ binding: { ...binding, contractHash: 'b'.repeat(64) }, runDraft }));
  assert.equal((await reserve(repo, result.projectId)).attempt.id, attempt.id);
});

test('Forward advancement requires trusted void authorization and rechecks competing writes', async t => {
  const f = await fixture(t), a = await f.open(), b = await f.open();
  const { result } = await create(a.repo, f.project);
  const advance = command(result.projectId, result.revision, { op: 'transition', kind: 'task', id: 'task-0', to: 'ready', evidence: [], mappings: [] });
  await assert.rejects(a.repo.apply(advance), { code: 'project_authorization_required' });
  const forged = await f.open({ authorizeTransition: async () => true });
  await assert.rejects(forged.repo.apply(advance), { code: 'project_authorization_denied' });
  const racing = await f.open({ authorizeTransition: async ({ snapshot }) => {
    assert.equal(racing.store.db.isTransaction, false);
    await b.repo.apply(command(result.projectId, snapshot.revision, { op: 'setPaused', paused: true }));
  } });
  await assert.rejects(racing.repo.apply(advance), { code: 'project_revision_conflict' });
  assert.equal(a.repo.snapshot(result.projectId).tasks[0].status, 'proposed');
});

test('Actual Node SQLite backup includes live WAL and failed additive migration rolls back', async t => {
  const f = await fixture(t);
  const store = f.legacy();
  const legacy = store.createRun({ project: f.project, task: 'WAL-only legacy record' });
  store.db.exec('PRAGMA user_version=37; CREATE TABLE kodo_project_records(incompatible TEXT)');
  const { openProjectStore } = await import('../runtime/project-store.mjs');
  await assert.rejects(openProjectStore({ store, contracts }));
  assert.equal(store.db.prepare('PRAGMA user_version').get().user_version, 37);
  assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name='kodo_project_migrations'").get().n, 0);
  const backupDir = path.join(f.home, 'project-backups');
  const backups = readdirSync(backupDir, { recursive: true }).filter(name => String(name).endsWith('.sqlite'));
  assert.equal(backups.length, 1);
  const backup = new DatabaseSync(path.join(backupDir, backups[0]), { readOnly: true });
  try { assert.equal(JSON.parse(backup.prepare('SELECT body FROM runs WHERE id=?').get(legacy.id).body).task, legacy.task); }
  finally { backup.close(); }
  store.db.exec('DROP TABLE kodo_project_records');
  const newer = store.createRun({ project: f.project, task: 'New write after failed migration' });
  await openProjectStore({ store, contracts });
  assert.equal(store.getRun(legacy.id).task, legacy.task);
  assert.equal(store.getRun(newer.id).task, newer.task);
});

test('Snapshot counts records and revision retain one SQLite read snapshot across another commit', async t => {
  const f = await fixture(t), writer = await f.open();
  const { result } = await create(writer.repo, f.project);
  const reader = f.legacy(), realDb = reader.db;
  let armed = false, pending;
  reader.db = new Proxy(realDb, { get(target, name) {
    if (name === 'prepare') return sql => {
      const statement = target.prepare(sql);
      if (sql.startsWith('SELECT COUNT(*) AS total FROM (SELECT id,body')) return new Proxy(statement, { get(stmt, method) {
        if (method === 'get') return (...args) => {
          const count = stmt.get(...args);
          if (armed && args[1] === 'task') {
            armed = false;
            const record = { ...spec(f.project).tasks[0], id: 'task-added' };
            pending = writer.repo.apply(command(result.projectId, result.revision, { op: 'insert', kind: 'task', record }));
          }
          return count;
        };
        return typeof stmt[method] === 'function' ? stmt[method].bind(stmt) : stmt[method];
      } });
      return statement;
    };
    return typeof target[name] === 'function' ? target[name].bind(target) : target[name];
  } });
  const { openProjectStore } = await import('../runtime/project-store.mjs');
  const repo = await openProjectStore({ store: reader, contracts });
  armed = true;
  const observed = repo.snapshot(result.projectId);
  assert.equal(observed.revision, result.revision);
  assert.equal(observed.tasks.length, 1);
  assert.deepEqual(observed.completeness.tasks, { total: 1, returned: 1, complete: true });
  assert.ok(pending); await pending;
  const fresh = repo.snapshot(result.projectId);
  assert.equal(fresh.tasks.length, 2); assert.equal(fresh.revision, result.revision + 1);
});

test('History reports remaining counts cursor completeness and provenance without snapshot events', async t => {
  const f = await fixture(t), { repo } = await f.open();
  const { result } = await create(repo, f.project);
  await repo.apply(command(result.projectId, result.revision, { op: 'setPaused', paused: true }));
  await repo.apply(command(result.projectId, result.revision + 1, { op: 'setPaused', paused: false }));
  const first = repo.history(result.projectId, { after: 0, limit: 2 });
  assert.equal(first.total, 3); assert.equal(first.complete, false); assert.equal(first.events.length, 2);
  assert.equal(first.nextAfter, first.events[1].seq);
  assert.equal(first.events[0].previousHash, null); assert.match(first.events[0].nextHash, /^[a-f0-9]{64}$/);
  assert.equal(first.events[1].previousHash, first.events[0].nextHash);
  const rest = repo.history(result.projectId, { after: first.nextAfter, limit: 2 });
  assert.equal(rest.total, 1); assert.equal(rest.complete, true);
  assert.equal(rest.events[0].type, 'setPaused');
  const empty = repo.history(result.projectId, { after: rest.nextAfter, limit: 1 });
  assert.equal(empty.total, 0); assert.equal(empty.nextAfter, rest.nextAfter); assert.equal(empty.complete, true);
  for (const options of [{ after: -1 }, { limit: 0 }, { limit: 1001 }, { after: 0.1 }]) assert.throws(() => repo.history(result.projectId, options));
});

test('Revision-bound approvals expire after amendment and old attempts remain historical', async t => {
  const f = await fixture(t), { repo, store } = await f.open();
  const { result } = await create(repo, f.project);
  const projectId = result.projectId;
  const approval = command(projectId, repo.snapshot(projectId).revision, { op: 'approveRisk', taskId: 'task-0', taskRevision: 1 });
  await repo.apply(approval);
  const first = (await reserve(repo, projectId)).attempt;
  assert.equal(repo.snapshot(projectId).riskApprovals.length, 1);
  await assert.rejects(repo.apply(command(projectId, repo.snapshot(projectId).revision,
    { op: 'amend', kind: 'task', id: 'task-0', record: { ...spec(f.project).tasks[0], priority: 80 } })), { code: 'project_active_attempt' });
  await repo.apply(command(projectId, repo.snapshot(projectId).revision,
    { op: 'transition', kind: 'attempt', id: first.id, to: 'failed', evidence: [], mappings: [] }));
  assert.equal(repo.snapshot(projectId).currentAttempts[0].status, 'failed');
  await repo.apply(command(projectId, repo.snapshot(projectId).revision,
    { op: 'amend', kind: 'task', id: 'task-0', record: { ...spec(f.project).tasks[0], priority: 80 } }));
  assert.equal(repo.snapshot(projectId).tasks[0].revision, 2);
  assert.equal(repo.snapshot(projectId).riskApprovals.length, 0);
  await assert.rejects(repo.apply(command(projectId, repo.snapshot(projectId).revision,
    { op: 'approveRisk', taskId: 'task-0', taskRevision: 1 })), { code: 'project_revision_conflict' });
  await assert.rejects(reserve(repo, projectId), { code: 'project_retry_required' });
  const second = (await reserve(repo, projectId, 'task-0', true)).attempt;
  assert.equal(second.number, 2); assert.equal(second.taskRevision, 2); assert.notEqual(second.runId, first.runId);
  const snapshot = repo.snapshot(projectId);
  assert.deepEqual(snapshot.currentAttempts.map(item => item.id), [second.id]);
  assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM kodo_project_attempts').get().n, 2);
  assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM kodo_project_approvals').get().n, 1);
  assert.equal((await repo.apply(approval)).replayed, true);
});

test('Reservations survive quota-style resume and both controls block first installation', async t => {
  const f = await fixture(t), { repo, store } = await f.open();
  const { result } = await create(repo, f.project);
  const first = (await reserve(repo, result.projectId)).attempt;
  const secondWriter = await f.open();
  const resumed = (await reserve(secondWriter.repo, result.projectId)).attempt;
  assert.equal(resumed.id, first.id); assert.equal(resumed.runId, first.runId);
  assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM kodo_project_attempts').get().n, 1);
  const input = { binding: bindingOf(first), runDraft: draftOf(repo, first) };
  await repo.apply(command(result.projectId, repo.snapshot(result.projectId).revision, { op: 'setPaused', paused: true }));
  await assert.rejects(repo.installRun(input), { code: 'project_control_blocked' });
  await repo.apply(command(result.projectId, repo.snapshot(result.projectId).revision, { op: 'setPaused', paused: false }));
  await repo.apply(command(result.projectId, repo.snapshot(result.projectId).revision,
    { op: 'transition', kind: 'project', id: result.projectId, to: 'cancelled', evidence: [], mappings: [] }));
  await assert.rejects(repo.installRun(input), { code: 'project_control_blocked' });
  assert.equal(store.listRuns().length, 0);
});

test('DAG missing parents cross-project dependencies and amendment cycles roll back atomically', async t => {
  const f = await fixture(t), { repo } = await f.open();
  const { result } = await create(repo, f.project);
  const initial = repo.snapshot(result.projectId), events = repo.history(result.projectId).total;
  for (const record of [
    { ...spec(f.project).tasks[0], id: 'bad-parent', epicId: 'absent' },
    { ...spec(f.project).tasks[0], id: 'bad-dependency', dependsOn: ['another-project-task'] },
    { ...spec(f.project).tasks[0], id: 'self-cycle', dependsOn: ['self-cycle'] }
  ]) await assert.rejects(repo.apply(command(result.projectId, initial.revision, { op: 'insert', kind: 'task', record })));
  assert.deepEqual(repo.snapshot(result.projectId), initial);
  assert.equal(repo.history(result.projectId).total, events);
  await repo.apply(command(result.projectId, initial.revision,
    { op: 'insert', kind: 'task', record: { ...spec(f.project).tasks[0], id: 'second', dependsOn: ['task-0'] } }));
  const before = repo.snapshot(result.projectId);
  await assert.rejects(repo.apply(command(result.projectId, before.revision,
    { op: 'amend', kind: 'task', id: 'task-0', record: { ...spec(f.project).tasks[0], dependsOn: ['second'] } })),
    error => ['project_dependency_cycle', 'project_dag'].includes(error.code));
  assert.deepEqual(repo.snapshot(result.projectId), before);
});

test('Raw short escaped key and provider-shaped secrets reject before any persistence', async t => {
  const f = await fixture(t, { secrets: { fake: 'Q', escaped: 'quote"slash\\line\n' } }), { repo, store } = await f.open();
  const before = store.db.prepare('SELECT COUNT(*) AS n FROM kodo_project_records').get().n;
  const base = command(null, null, { op: 'create', spec: spec(f.project) });
  for (const input of [
    { ...base, reason: 'Q' },
    { ...base, 'Q': 'value' },
    { ...base, reason: 'quote"slash\\line\n' },
    { ...base, reason: 'sk-proj-' + 'a'.repeat(30) },
    { ...base, reason: '-----BEGIN PRIVATE KEY-----\nfake\n-----END PRIVATE KEY-----' }
  ]) await assert.rejects(repo.apply(input));
  assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM kodo_project_records').get().n, before);
  assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM kodo_project_commands').get().n, 0);
});

test('Corrupt database and malformed persisted record fail closed without rewriting legacy data', async t => {
  const f = await fixture(t), { repo, store } = await f.open();
  const { result } = await create(repo, f.project);
  store.db.prepare("UPDATE kodo_project_records SET body='invalid-json' WHERE kind='task'").run();
  assert.throws(() => repo.snapshot(result.projectId), { code: 'project_database_corrupt' });
  assert.equal(store.db.prepare("SELECT body FROM kodo_project_records WHERE kind='task'").get().body, 'invalid-json');
  const badHome = path.join(f.root, 'corrupt'); mkdirSync(badHome);
  writeFileSync(path.join(badHome, 'state.sqlite'), 'not a sqlite database');
  const corrupted = new DatabaseSync(path.join(badHome, 'state.sqlite'));
  try {
    const { openProjectStore } = await import('../runtime/project-store.mjs');
    await assert.rejects(openProjectStore({ store: { db: corrupted, secrets: {}, createRun() { throw new Error('unreachable'); } }, contracts }));
  } finally { corrupted.close(); }
});

test('Authorized forward transitions commit once and historical replay does not reauthorize', async t => {
  let calls = 0;
  const f = await fixture(t, { authorizeTransition: async () => { calls++; } }), { repo } = await f.open();
  const { result } = await create(repo, f.project);
  const input = command(result.projectId, result.revision,
    { op: 'transition', kind: 'task', id: 'task-0', to: 'ready', evidence: [], mappings: [] });
  await repo.apply(input); assert.equal(calls, 1);
  const bare = await f.open({ authorizeTransition: undefined });
  assert.equal((await bare.repo.apply(input)).replayed, true); assert.equal(calls, 1);
  for (const to of ['running', 'verifying', 'integrated', 'accepted', 'released']) {
    await assert.rejects(bare.repo.apply(command(result.projectId, bare.repo.snapshot(result.projectId).revision,
      { op: 'transition', kind: 'task', id: 'task-0', to, evidence: [], mappings: [] })), { code: 'project_authorization_required' });
  }
  assert.equal(repo.snapshot(result.projectId).tasks[0].status, 'ready');
  assert.equal(repo.snapshot(result.projectId).tasks[0].revision, 1);
});

test('Snapshot includes all 1000 latest attempts and approvals including a settled latest result', async t => {
  const f = await fixture(t), { repo, store } = await f.open();
  const { result } = await create(repo, f.project, 1000), s = repo.snapshot(result.projectId);
  const stamp = new Date().toISOString();
  store.db.exec('BEGIN IMMEDIATE');
  try {
    for (const task of s.tasks) {
      const attempt = { schemaVersion: 1, id: randomUUID(), projectId: result.projectId, taskId: task.id, taskRevision: 1,
        number: 1, runId: randomUUID(), contractHash: contracts.directorContractHash(task, { knownValues: [] }),
        status: task.id === 'task-0' ? 'failed' : 'reserved', baseSha: null, headSha: null, evidence: [],
        reason: null, createdAt: stamp, updatedAt: stamp };
      store.db.prepare('INSERT INTO kodo_project_attempts(id,project_id,task_id,number,run_id,body) VALUES(?,?,?,?,?,?)')
        .run(attempt.id, result.projectId, task.id, 1, attempt.runId, JSON.stringify(attempt));
      store.db.prepare('INSERT INTO kodo_project_current VALUES(?,?,?)').run(result.projectId, task.id, attempt.id);
      const approval = { schemaVersion: 1, projectId: result.projectId, taskId: task.id, taskRevision: 1, actor: 'fixture', reason: 'Fixture approval', approvedAt: stamp };
      store.db.prepare('INSERT INTO kodo_project_approvals VALUES(?,?,?,?)').run(result.projectId, task.id, 1, JSON.stringify(approval));
    }
    store.db.exec('COMMIT');
  } catch (error) { store.db.exec('ROLLBACK'); throw error; }
  const observed = repo.snapshot(result.projectId);
  for (const key of ['tasks', 'currentAttempts', 'riskApprovals']) {
    assert.equal(observed[key].length, 1000);
    assert.deepEqual(observed.completeness[key], { total: 1000, returned: 1000, complete: true });
  }
  assert.equal(observed.currentAttempts.find(item => item.taskId === 'task-0').status, 'failed');
  const corruptSlot = store.db.prepare('SELECT attempt_id FROM kodo_project_current WHERE task_id=?').get('task-0').attempt_id;
  store.db.prepare('UPDATE kodo_project_current SET task_id=? WHERE attempt_id=?').run('wrong-slot', corruptSlot);
  assert.throws(() => repo.snapshot(result.projectId), { code: 'project_database_corrupt' });
});

test('A crash reported after COMMIT reconciles saved Run and created event on a new connection', async t => {
  const f = await fixture(t), { repo: setup } = await f.open();
  const { result } = await create(setup, f.project), { attempt } = await reserve(setup, result.projectId);
  const store = f.legacy(), realDb = store.db;
  let crash = false;
  store.db = new Proxy(realDb, { get(target, name) {
    if (name === 'exec') return sql => {
      const value = target.exec(sql);
      if (crash && sql === 'COMMIT') { crash = false; throw new Error('fixture crash after commit before caller receipt'); }
      return value;
    };
    return typeof target[name] === 'function' ? target[name].bind(target) : target[name];
  } });
  const { openProjectStore } = await import('../runtime/project-store.mjs');
  const repo = await openProjectStore({ store, contracts });
  const input = { binding: bindingOf(attempt), runDraft: draftOf(repo, attempt) };
  crash = true;
  await assert.rejects(repo.installRun(input), /fixture crash after commit/);
  const restarted = await f.open();
  const saved = await restarted.repo.installRun(input);
  assert.equal(saved.id, attempt.runId);
  assert.equal(restarted.store.listRuns().length, 1);
  assert.equal(restarted.store.events(attempt.runId).length, 1);
  assert.equal(restarted.repo.snapshot(result.projectId).currentAttempts.length, 1);
});

test('Installation rejects incomplete drafts foreign projects and superseded reservations', async t => {
  const f = await fixture(t), { repo, store } = await f.open();
  const { result } = await create(repo, f.project), { attempt } = await reserve(repo, result.projectId);
  const binding = bindingOf(attempt), runDraft = draftOf(repo, attempt);
  await assert.rejects(repo.installRun({ binding, runDraft: { ...runDraft, config: undefined } }));
  await assert.rejects(repo.installRun({ binding, runDraft: { ...runDraft, project: f.root } }), { code: 'project_binding_conflict' });
  assert.equal(store.listRuns().length, 0);
  await repo.apply(command(result.projectId, repo.snapshot(result.projectId).revision,
    { op: 'transition', kind: 'attempt', id: attempt.id, to: 'cancelled', evidence: [], mappings: [] }));
  const next = (await reserve(repo, result.projectId, 'task-0', true)).attempt;
  assert.notEqual(next.id, attempt.id);
  await assert.rejects(repo.installRun({ binding, runDraft }), { code: 'project_binding_conflict' });
  const saved = await repo.installRun({ binding: bindingOf(next), runDraft: draftOf(repo, next) });
  assert.equal(saved.id, next.runId); assert.equal(store.listRuns().length, 1);
});

test('Authorizer is a Promise of void contract and cannot mutate the command being persisted', async t => {
  const f = await fixture(t), { repo } = await f.open(), { result } = await create(repo, f.project);
  const input = command(result.projectId, result.revision,
    { op: 'transition', kind: 'task', id: 'task-0', to: 'ready', evidence: [], mappings: [] });
  for (const authorizeTransition of [() => undefined, async () => false, async () => ({ verified: true }), async () => { throw new Error('denied'); }]) {
    const other = await f.open({ authorizeTransition });
    await assert.rejects(other.repo.apply(input));
    assert.equal(repo.snapshot(result.projectId).revision, result.revision);
  }
  const trusted = await f.open({ authorizeTransition: async ({ command, snapshot }) => {
    command.action.to = 'released'; snapshot.project.status = 'released';
  } });
  await trusted.repo.apply(input);
  assert.equal(repo.snapshot(result.projectId).tasks[0].status, 'ready');
});

test('Creation identity canonicalizes aliases before shared hashing and retains the display root', async t => {
  const f = await fixture(t), { repo } = await f.open();
  const alias = path.join(f.root, 'project-alias');
  symlinkSync(f.project, alias, process.platform === 'win32' ? 'junction' : 'dir');
  const { input, result } = await create(repo, alias);
  const snapshot = repo.snapshot(result.projectId);
  assert.equal(snapshot.project.root, alias);
  const native = realpathSync.native(f.project);
  assert.equal(snapshot.project.projectKey, process.platform === 'win32' ? native.toLowerCase() : native);
  const replay = await repo.apply({ ...input, action: { op: 'create', spec: { ...input.action.spec, root: f.project } } });
  assert.equal(replay.projectId, result.projectId); assert.equal(replay.replayed, true);
  if (process.platform === 'win32') {
    const casing = await repo.apply({ ...input, action: { op: 'create', spec: { ...input.action.spec, root: f.project.toUpperCase() } } });
    assert.equal(casing.projectId, result.projectId); assert.equal(casing.replayed, true);
  }
  await assert.rejects(repo.apply(command(null, null, { op: 'create', spec: spec('relative-project') })));
});

test('Exact persisted snapshot validation is reused without sharing mutable results or trusting revisions', async t => {
  const A = await import('../runtime/project-contracts.mjs');
  let validations = 0;
  const f = await fixture(t), { repo, store } = await f.open({ contracts: { ...A,
    normalizeDirectorRecord(...args) { validations++; return A.normalizeDirectorRecord(...args); }
  } });
  const { result } = await create(repo, f.project, 1000), id = result.projectId;
  const first = repo.snapshot(id), count = validations;
  first.tasks[0].acceptance[0].text = 'Caller mutation'; first.tasks.pop(); first.completeness.tasks.total = 0;
  const next = repo.snapshot(id);
  assert.equal(validations, count, 'unchanged DB bytes do not repeat pure normalization');
  assert.equal(next.tasks.length, 1000); assert.equal(next.tasks[0].acceptance[0].text, criterion.text);
  assert.deepEqual(next.completeness.tasks, { total: 1000, returned: 1000, complete: true });
  const row = store.db.prepare("SELECT body FROM kodo_project_records WHERE kind='task' AND id='task-0'").get();
  const changed = { ...JSON.parse(row.body), priority: 81 };
  store.db.prepare("UPDATE kodo_project_records SET body=? WHERE kind='task' AND id='task-0'").run(JSON.stringify(changed));
  const fresh = repo.snapshot(id);
  assert.equal(fresh.revision, next.revision); assert.equal(fresh.tasks.find(task => task.id === 'task-0').priority, 81);
  assert.ok(validations > count, 'changed body with unchanged revision must be validated');
  store.db.prepare("UPDATE kodo_project_records SET body=? WHERE kind='task' AND id='task-0'").run(JSON.stringify({ ...changed, writePaths: ['../escape'] }));
  assert.throws(() => repo.snapshot(id), { code: 'project_database_corrupt' });
  store.db.prepare("UPDATE kodo_project_records SET body=? WHERE kind='task' AND id='task-0'").run(row.body);
  assert.equal(repo.snapshot(id).tasks.find(task => task.id === 'task-0').priority, 50);
  store.db.prepare("UPDATE kodo_project_records SET id='wrong-row' WHERE kind='task' AND id='task-0'").run();
  assert.throws(() => repo.snapshot(id), { code: 'project_database_corrupt' });
  store.db.prepare("UPDATE kodo_project_records SET id='task-0' WHERE kind='task' AND id='wrong-row'").run();
  store.db.prepare("DELETE FROM kodo_project_records WHERE kind='task' AND id='task-0'").run();
  assert.deepEqual(repo.snapshot(id).completeness.tasks, { total: 999, returned: 999, complete: true });
});

test('Cached persisted bytes are revalidated when known secrets change and never hide new unsafe bytes', async t => {
  const A = await import('../runtime/project-contracts.mjs');
  const f = await fixture(t), { repo, store } = await f.open({ contracts: A });
  const { result } = await create(repo, f.project), id = result.projectId;
  repo.snapshot(id);
  store.secrets.fixture = 'Observable result works';
  assert.throws(() => repo.snapshot(id), { code: 'project_database_corrupt' });
  delete store.secrets.fixture;
  repo.snapshot(id);
  const row = store.db.prepare("SELECT body FROM kodo_project_records WHERE kind='task'").get();
  const task = JSON.parse(row.body);
  for (const description of ['sk-proj-' + 'a'.repeat(30), '-----BEGIN PRIVATE KEY-----\nfixture\n-----END PRIVATE KEY-----']) {
    store.db.prepare("UPDATE kodo_project_records SET body=? WHERE kind='task'").run(JSON.stringify({ ...task, description }));
    assert.throws(() => repo.snapshot(id), { code: 'project_database_corrupt' });
  }
  store.db.prepare("UPDATE kodo_project_records SET body=? WHERE kind='task'").run(row.body);
  assert.equal(repo.snapshot(id).tasks[0].description, task.description);
});

test('Inserting under accepted or released containers rejects atomically with actual contracts', async t => {
  const A = await import('../runtime/project-contracts.mjs');
  for (const parentKind of ['epic', 'milestone', 'project']) for (const status of ['accepted', 'released']) {
    const f = await fixture(t), { repo, store } = await f.open({ contracts: A, authorizeTransition: async () => {} });
    const initial = spec(f.project, 0);
    if (parentKind !== 'epic') initial.epics = [];
    if (parentKind === 'project') initial.milestones = [];
    const { projectId: id } = await repo.apply(command(null, null, { op: 'create', spec: initial }));
    const parentId = parentKind === 'project' ? id : parentKind === 'milestone' ? 'm' : 'e';
    const proof = { kind: 'checks', runId: null, headSha: null, path: path.join(f.root, 'proof.json'), sha256: 'a'.repeat(64) };
    const mapping = { criterionId: 'works', refs: [proof.sha256], actor: 'fixture', reason: 'Owned acceptance evidence' };
    for (const to of ['ready', 'running', 'verifying', 'integrated', 'accepted', ...(status === 'released' ? ['released'] : [])]) {
      const evidence = to === 'accepted' ? [proof] : to === 'released' ? [{ ...proof, kind: 'release', sha256: 'b'.repeat(64) }] : [];
      await repo.apply(command(id, repo.snapshot(id).revision,
        { op: 'transition', kind: parentKind, id: parentId, to, evidence, mappings: to === 'accepted' ? [mapping] : [] }));
    }
    const childKind = parentKind === 'project' ? 'milestone' : parentKind === 'milestone' ? 'epic' : 'task';
    const child = spec(f.project)[childKind + 's'][0];
    // Compare every durable table, not just the user-visible revision.
    const durable = () => Object.fromEntries(['records', 'attempts', 'current', 'approvals', 'commands', 'events'].map(name =>
      [name, store.db.prepare('SELECT * FROM kodo_project_' + name + ' ORDER BY rowid').all()]));
    const before = durable();
    const insert = command(id, repo.snapshot(id).revision, { op: 'insert', kind: childKind, record: child });
    await assert.rejects(repo.apply(insert), error => ['project_insertion_blocked', 'project_control_blocked'].includes(error.code), `${parentKind} ${status}`);
    assert.deepEqual(durable(), before, `${parentKind} ${status}: no rows, events or command replay survive rejection`);
    if (parentKind !== 'project') {
      await assert.rejects(repo.apply(command(id, repo.snapshot(id).revision, { op: 'amend', kind: parentKind,
        id: parentId, record: { ...spec(f.project)[parentKind + 's'][0], title: 'Changed accepted contract' } })),
      { code: 'project_amendment_blocked' });
      assert.deepEqual(durable(), before, `${parentKind} ${status}: rejected amendment is atomic`);
    }
  }
});

test('Persisted validation reuse evicts old byte content within a bounded cache', async t => {
  let taskValidations = 0;
  const f = await fixture(t), { repo, store } = await f.open({ contracts: { ...contracts,
    normalizeDirectorRecord(kind, value) { if (kind === 'task') taskValidations++; return structuredClone(value); }
  } });
  const { result } = await create(repo, f.project), id = result.projectId;
  const row = store.db.prepare("SELECT body FROM kodo_project_records WHERE kind='task'").get();
  const first = { ...JSON.parse(row.body), description: 'Owned large fixture ' + 'x'.repeat(60000) };
  const update = store.db.prepare("UPDATE kodo_project_records SET body=? WHERE kind='task'");
  update.run(JSON.stringify(first)); repo.snapshot(id);
  for (let n = 0; n < 80; n++) {
    update.run(JSON.stringify({ ...first, description: first.description + n })); repo.snapshot(id);
  }
  const before = taskValidations;
  update.run(JSON.stringify(first));
  assert.equal(repo.snapshot(id).tasks[0].description, first.description);
  assert.ok(taskValidations > before, 'old validated bytes must be evicted rather than retained without a bound');
});

test('Warm validation cache never lets raw secrets or accessors reach canonical encoding', async t => {
  const A = await import('../runtime/project-contracts.mjs');
  let encodings = 0, reads = 0;
  const f = await fixture(t), { repo, store } = await f.open({ contracts: { ...A,
    directorBytes(...args) { encodings++; return A.directorBytes(...args); }
  } });
  const { result } = await create(repo, f.project), id = result.projectId;
  const base = command(id, repo.snapshot(id).revision, { op: 'setPaused', paused: true });
  store.secrets.fixture = 'quote"slash\\line\n';
  const getter = { ...base };
  Object.defineProperty(getter, 'reason', { enumerable: true, get() { reads++; return 'not evaluated'; } });
  const before = encodings;
  for (const input of [getter, { ...base, reason: store.secrets.fixture }, { ...base, [store.secrets.fixture]: 'ordinary' }]) {
    await assert.rejects(repo.apply(input));
    assert.equal(encodings, before, 'unsafe raw data must fail before canonical bytes or hashing');
  }
  assert.equal(reads, 0);
  assert.equal(repo.snapshot(id).revision, result.revision);
});
