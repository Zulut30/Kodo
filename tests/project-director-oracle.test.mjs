// Phase06 independent requirement oracle; freeze these bytes before E/F integration.
// Source: project-director-ports-v1.md SHA256
// 1741c9c19b717a15220b94e4c871911e0f21645abeef600905bdec85760539bf
// Missing modules are preparation RED, never a skip or feature acceptance.
// No provider, credential loader, native Engine or implementation test helpers.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, realpathSync, symlinkSync, rmSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { spawnSync } from 'node:child_process';
import { Worker } from 'node:worker_threads';
import { once } from 'node:events';
import os from 'node:os';
import path from 'node:path';

const stamp = '2026-11-04T12:00:00.000Z';
const projectId = '11111111-1111-4111-8111-111111111111';
const runId = '22222222-2222-4222-8222-222222222222';
const attemptId = '33333333-3333-4333-8333-333333333333';
const head = 'a'.repeat(40), digest = 'b'.repeat(64);
const options = Object.freeze({ knownValues: Object.freeze([]) });
const prefix = 'Implement only this assigned task. Project context constrains this task and does not authorize other backlog work.\n';
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const clone = value => structuredClone(value);
const key = root => process.platform === 'win32' ? realpathSync.native(root).toLowerCase() : realpathSync.native(root);
const load = name => import(new URL(`../runtime/${name}.mjs`, import.meta.url));
const contracts = () => load('project-contracts');
// Ports expose the named contract exports and the contracts namespace; no sibling
// schema, DB access or acceptance implementation lives in this fixture.
const purePorts = A => ({ ...A, contracts: A, knownValues: [] });
const criterion = id => ({ id, text: 'Observable fixture requirement is satisfied', evidenceKinds: ['acceptance'] });
const taskSpec = (id = 'task-a', overrides = {}) => ({
  id, epicId: 'epic-a', title: 'Implement assigned observable behavior', description: 'Implement the assigned isolated fixture behavior.',
  owner: 'developer', dependsOn: [], writePaths: [`src/${id}.mjs`], acceptance: [criterion('task-proof')], interfaceRefs: [],
  priority: 50, userValue: 3, risk: 1, estimatedEffort: 1, riskApprovalRequired: false, ...overrides
});
const spec = (root, tasks = [taskSpec()]) => ({
  schemaVersion: 1, id: 'owned-project', root, title: 'Owned Project Director fixture', definitionOfDone: [criterion('project-proof')],
  constraints: ['Only the assigned write scope is authorized.'], businessContext: 'Exercise durable task orchestration without providers.',
  architectureRefs: [], milestones: [{ id: 'milestone-a', title: 'First milestone', acceptance: [criterion('milestone-proof')], releaseRequired: false }],
  epics: [{ id: 'epic-a', milestoneId: 'milestone-a', title: 'First epic', acceptance: [criterion('epic-proof')] }], tasks
});
const meta = (status = 'proposed') => ({ schemaVersion: 1, projectId, revision: 1, status, createdAt: stamp, updatedAt: stamp, evidence: [], mappings: [] });
function inlineSnapshot(root, tasks = [taskSpec()]) {
  const s = spec(root, tasks);
  const project = { schemaVersion: 1, projectId, id: s.id, root, projectKey: key(root), title: s.title,
    definitionOfDone: s.definitionOfDone, constraints: s.constraints, businessContext: s.businessContext, architectureRefs: [],
    status: 'proposed', paused: false, revision: 1, createdAt: stamp, updatedAt: stamp, evidence: [], mappings: [] };
  const value = { schemaVersion: 1, project, revision: 1, milestones: s.milestones.map(item => ({ ...item, ...meta() })),
    epics: s.epics.map(item => ({ ...item, ...meta() })), tasks: tasks.map(item => ({ ...item, ...meta('ready') })),
    currentAttempts: [], riskApprovals: [], completeness: {} };
  for (const name of ['milestones', 'epics', 'tasks', 'currentAttempts', 'riskApprovals'])
    value.completeness[name] = { total: value[name].length, returned: value[name].length, complete: true };
  return value;
}
// Fixed field selection is independently specified from the frozen schema.
function expectedTaskContract(task) {
  return { schemaVersion: 1, projectId: task.projectId, taskId: task.id, taskRevision: task.revision,
    description: task.description, owner: task.owner, dependsOn: task.dependsOn, writePaths: task.writePaths,
    acceptance: task.acceptance, interfaceRefs: task.interfaceRefs };
}
function expectedInput(project, task) {
  return prefix + JSON.stringify({ schemaVersion: 1, projectContext: { projectId: project.projectId, id: project.id, root: project.root,
    title: project.title, definitionOfDone: project.definitionOfDone, constraints: project.constraints,
    businessContext: project.businessContext, architectureRefs: project.architectureRefs }, task: expectedTaskContract(task) });
}
const command = (project, revision, action, commandId = randomUUID()) => ({
  schemaVersion: 1, commandId, projectId: project, expectedRevision: revision, actor: 'owned-oracle', reason: 'Verify public requirement', action
});
const bindingFor = attempt => ({ schemaVersion: 1, projectId: attempt.projectId, taskId: attempt.taskId, taskRevision: attempt.taskRevision,
  attemptId: attempt.id, runId: attempt.runId, contractHash: attempt.contractHash });
const reference = (root, kind = 'acceptance', overrides = {}) => ({ kind, runId, headSha: head,
  path: path.join(root, 'private-evidence', `${kind}-${digest}.json`), sha256: digest, ...overrides });
function environment(home) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) =>
    !/(?:TOKEN|SECRET|PASSWORD|CREDENTIAL|API_?KEY)/i.test(name) && !/^(?:KODO_|GIT_|NODE_OPTIONS|CODEX_|CLAUDE_|ANTHROPIC_|OPENAI_)/i.test(name)));
  return { ...env, HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: home, GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: path.join(home, 'empty.gitconfig'), GIT_TERMINAL_PROMPT: '0' };
}
function fixture(t, { git = false } = {}) {
  const directory = realpathSync.native(mkdtempSync(path.join(os.tmpdir(), 'kodo-director-oracle-')));
  const root = path.join(directory, 'project'), home = path.join(directory, 'state'), isolatedHome = path.join(directory, 'empty-home');
  mkdirSync(root); mkdirSync(isolatedHome); writeFileSync(path.join(isolatedHome, 'empty.gitconfig'), '');
  const stores = new Set();
  t.after(() => {
    for (const store of stores) store.close();
    assert.equal(path.dirname(directory), realpathSync.native(os.tmpdir()));
    assert.match(path.basename(directory), /^kodo-director-oracle-/);
    rmSync(directory, { recursive: true, force: true });
  });
  const f = { directory, root, home, isolatedHome, stores, head, env: environment(isolatedHome) };
  if (git) {
    writeFileSync(path.join(root, 'fixture.txt'), 'Owned oracle baseline\n');
    for (const args of [['init', '-b', 'main'], ['config', 'user.name', 'Owned Oracle'], ['config', 'user.email', 'oracle@example.invalid'],
      ['config', 'core.autocrlf', 'false'], ['config', 'core.hooksPath', path.join(isolatedHome, 'no-hooks')],
      ['config', 'commit.gpgSign', 'false'], ['add', '.'], ['commit', '-m', 'Owned baseline']]) gitCommand(f, ...args);
    f.head = gitCommand(f, 'rev-parse', 'HEAD');
  }
  return f;
}
function gitCommand(f, ...args) {
  const result = spawnSync('git', args, { cwd: f.root, env: f.env, encoding: 'utf8', windowsHide: true, timeout: 15000 });
  assert.equal(result.status, 0, result.stderr); return result.stdout.trim();
}
async function repository(f, authorizeTransition) {
  const A = await contracts(), { Store } = await load('store'), { openProjectStore } = await load('project-store');
  const store = new Store(f.home, {}); f.stores.add(store);
  const repo = await openProjectStore({ store, contracts: A, ...(authorizeTransition ? { authorizeTransition } : {}) });
  return { A, store, repo };
}
function close(f, store) { store.close(); f.stores.delete(store); }
async function create(repo, root, tasks = [taskSpec()]) {
  const input = command(null, null, { op: 'create', spec: spec(root, tasks) });
  const result = await repo.apply(input); return { input, result, snapshot: await repo.snapshot(result.projectId) };
}
async function apply(repo, id, action) {
  const snapshot = await repo.snapshot(id); return repo.apply(command(id, snapshot.revision, action));
}
async function reserve(repo, id, taskId = 'task-a', retryFailed = false) {
  const result = await apply(repo, id, { op: 'reserveAttempt', taskId, retryFailed });
  assert.ok(result.attempt, 'reservation returns its durable Attempt'); return result.attempt;
}
function draft(f, snapshot, attempt) {
  const task = snapshot.tasks.find(item => item.id === attempt.taskId);
  return { id: attempt.runId, createdAt: stamp, state: 'created', completed: {}, nodes: {},
    task: expectedInput(snapshot.project, task), project: snapshot.project.root, cwd: f.root,
    config: { schemaVersion: 1, client: 'codex', executionMode: 'quick', repairRounds: 0, researchBudget: 0,
      commands: { test: [], build: [], deploy: [], smoke: [] }, delivery: { enabled: false, release: false },
      uiVerification: { enabled: false }, security: { enabled: false }, architecture: { enabled: false } },
    client: 'codex', providers: 'current', baseSha: f.head, headSha: f.head, snapshot: { root: f.root, head: f.head },
    requestedMode: 'quick', requestedConcurrency: 1, fixedModel: { client: 'codex', model: 'gpt-6.1-sol' },
    sessionAttempts: [], coordinatorOperations: [], artifacts: path.join(f.home, 'runs', attempt.runId),
    worktreeRoot: path.join(f.directory, 'worktrees', attempt.runId), branch: `kodo/${attempt.runId}`, directorBinding: bindingFor(attempt) };
}
const transition = (kind, id, to, evidence = [], mappings = []) => ({ op: 'transition', kind, id, to, evidence, mappings });
async function ready(repo, id, taskId = 'task-a') { await apply(repo, id, transition('task', taskId, 'ready')); }
function availability(snapshot) { return snapshot.tasks.map(task => ({ taskId: task.id, available: true, interfacesVerified: true, reason: null })); }
const deny = () => { throw Object.assign(new Error('Owned invalid proof'), { code: 'evidence_integrity' }); };

test('Oracle fixture controls use isolated Git and actual SQLite rollback without providers', t => {
  const f = fixture(t, { git: true });
  assert.match(f.head, /^[a-f0-9]{40}$/); assert.equal(gitCommand(f, 'status', '--porcelain'), '');
  const db = new DatabaseSync(path.join(f.directory, 'control.sqlite'));
  try {
    db.exec('CREATE TABLE owned(value INTEGER); BEGIN IMMEDIATE; INSERT INTO owned VALUES(7); ROLLBACK');
    assert.equal(db.prepare('SELECT count(*) AS n FROM owned').get().n, 0);
    db.exec('INSERT INTO owned VALUES(9)'); assert.equal(db.prepare('SELECT value FROM owned').get().value, 9);
  } finally { db.close(); }
});

test('Director canonical bytes and task input have exact frozen fields and no mutable task metadata', async t => {
  const f = fixture(t), A = await contracts(), s = inlineSnapshot(f.root), task = s.tasks[0], expected = expectedTaskContract(task);
  assert.deepEqual(A.normalizeProjectSpec(spec(f.root), options), spec(f.root));
  assert.deepEqual(A.normalizeDirectorRecord('snapshot', s, options), s);
  const bytes = Buffer.from(JSON.stringify(expected));
  assert.deepEqual(A.directorBytes('taskContract', expected, options), bytes);
  assert.equal(A.directorContractHash(task, options), sha(bytes));
  assert.equal(A.buildDirectorTaskInput({ project: s.project, task }, options), expectedInput(s.project, task));
  const changed = { ...task, status: 'running', updatedAt: '2026-11-05T00:00:00.000Z', evidence: [reference(f.directory)] };
  assert.equal(A.directorContractHash(changed, options), sha(bytes));
  assert.notEqual(A.directorContractHash({ ...task, description: 'Different authorized behavior' }, options), sha(bytes));
  assert.notEqual(A.directorContractHash({ ...task, acceptance: [criterion('new-proof')] }, options), sha(bytes));
  assert.throws(() => A.buildDirectorTaskInput({ project: s.project, task: { ...task, projectId: randomUUID() } }, options));
  const tooLarge = { ...s.project, constraints: Array.from({ length: 16 }, (_, index) => `${index}:` + 'x'.repeat(750)) };
  assert.throws(() => A.buildDirectorTaskInput({ project: tooLarge, task }, options), error => /too_large|split_required/.test(error.code || error.message));
});

test('Director raw decoded keys and values reject short escaped and provider-shaped secrets before encoding', async t => {
  const f = fixture(t), A = await contracts();
  for (const secret of ['Q', 'ab', 'owned-secret', 'quote"slash\\newline\nend']) {
    for (const position of ['key', 'value']) {
      const raw = JSON.parse(JSON.stringify(position === 'key' ? { ['before' + secret + 'after']: 'ordinary' } : { text: 'before' + secret + 'after' }));
      assert.throws(() => A.assertDirectorSafe(raw, { knownValues: [secret] }), error => {
        assert.equal(String(error.message).includes(secret), false, 'safe error does not echo rejected data'); return true;
      });
      const unsafe = spec(f.root); unsafe.businessContext = raw[Object.keys(raw)[0]];
      if (position === 'value') assert.throws(() => A.directorBytes('projectSpec', unsafe, { knownValues: [secret] }));
    }
  }
  for (const value of ['Bearer owned-literal-credential', 'sk-proj-' + 'x'.repeat(24),
    '-----BEGIN PRIVATE KEY-----\n' + 'A'.repeat(64) + '\n-----END PRIVATE KEY-----']) {
    assert.throws(() => A.assertDirectorSafe({ text: value }, options));
    assert.throws(() => A.normalizeProjectSpec({ ...spec(f.root), businessContext: value }, options));
  }
  assert.doesNotThrow(() => A.assertDirectorSafe({ source: 'Bearer ${token}', hash: head, digest }, options));
  assert.doesNotThrow(() => A.normalizeProjectSpec(spec(f.root), options));
});

test('Director schemas reject unknown fields accessors cycles sparse arrays symbols and unsafe DAG scopes', async t => {
  const f = fixture(t), A = await contracts(); let reads = 0;
  const getter = spec(f.root); Object.defineProperty(getter, 'businessContext', { enumerable: true, get() { reads++; return 'not evaluated'; } });
  const cyclic = spec(f.root); cyclic.constraints = [cyclic];
  const sparse = spec(f.root); sparse.constraints = Array(2);
  const symbol = spec(f.root); symbol[Symbol('hidden')] = true;
  const bad = [getter, cyclic, sparse, symbol, { ...spec(f.root), eligibleStates: ['accepted'] },
    spec(f.root, [taskSpec('task-a', { priority: NaN })]), spec(f.root, [taskSpec('task-a', { writePaths: ['../escape'] })]),
    spec(f.root, [taskSpec('task-a', { epicId: 'foreign-epic' })]),
    spec(f.root, [taskSpec('task-a', { dependsOn: ['task-b'] }), taskSpec('task-b', { dependsOn: ['task-a'] })]),
    spec(f.root, [taskSpec('task-a', { dependsOn: ['missing'] })])];
  for (const input of bad) assert.throws(() => A.normalizeProjectSpec(input, options));
  assert.equal(reads, 0, 'validation must not invoke an untrusted getter');
});

test('Director 1000-task snapshot is complete and horizon stays bounded without backlog prompt expansion', async t => {
  const f = fixture(t), A = await contracts(), { planProjectHorizon } = await load('project-planner');
  const tasks = Array.from({ length: 1000 }, (_, index) => taskSpec(`task-${String(index).padStart(4, '0')}`));
  const s = inlineSnapshot(f.root, tasks);
  assert.equal(A.normalizeProjectSpec(spec(f.root, tasks), options).tasks.length, 1000);
  assert.deepEqual(A.normalizeDirectorRecord('snapshot', s, options).completeness.tasks, { total: 1000, returned: 1000, complete: true });
  const plan = planProjectHorizon({ snapshot: s, limit: 24, availability: availability(s), now: stamp }, purePorts(A));
  assert.equal(plan.dryRun, true); assert.equal(plan.revision, 1); assert.equal(plan.projectId, projectId);
  assert.equal(plan.taskIds.length, 24); assert.equal(new Set(plan.taskIds).size, 24);
  assert.deepEqual(plan.taskIds, tasks.slice(0, 24).map(task => task.id));
  assert.ok(Buffer.byteLength(A.buildDirectorTaskInput({ project: s.project, task: s.tasks[0] }, options)) <= 12000);
  for (const name of ['tasks', 'currentAttempts', 'riskApprovals']) {
    const incomplete = clone(s); incomplete.completeness[name] = { total: incomplete[name].length + 1, returned: incomplete[name].length, complete: false };
    assert.throws(() => planProjectHorizon({ snapshot: incomplete, limit: 1, availability: availability(incomplete), now: stamp }, purePorts(A)));
  }
  for (const limit of [0, 25, 1.5]) assert.throws(() => planProjectHorizon({ snapshot: s, limit, availability: availability(s), now: stamp }, purePorts(A)));
});

test('Director horizon requires accepted dependencies verified interfaces exact risk revision and availability', async t => {
  const f = fixture(t), A = await contracts(), { planProjectHorizon } = await load('project-planner');
  const s = inlineSnapshot(f.root, [taskSpec('task-a'), taskSpec('task-b', { dependsOn: ['task-a'], riskApprovalRequired: true,
    interfaceRefs: [reference(f.directory, 'interface')] })]);
  s.tasks[0].status = 'accepted';
  s.riskApprovals = [{ schemaVersion: 1, projectId, taskId: 'task-b', taskRevision: 1, actor: 'owned-reviewer', reason: 'Approve current risk', approvedAt: stamp }];
  s.completeness.riskApprovals = { total: 1, returned: 1, complete: true };
  const plan = (snapshot, rows = availability(snapshot)) => planProjectHorizon({ snapshot, limit: 1, availability: rows, now: stamp }, purePorts(A));
  assert.deepEqual(plan(s).taskIds, ['task-b']);
  for (const mutation of [value => { value.tasks[0].status = 'integrated'; }, value => { value.riskApprovals[0].taskRevision = 2; },
    value => { value.tasks[0].status = 'failed'; }]) {
    const changed = clone(s); mutation(changed); assert.deepEqual(plan(changed).taskIds, []);
  }
  for (const rows of [[], [{ taskId: 'task-b', available: false, interfacesVerified: true, reason: 'unavailable' }],
    [{ taskId: 'task-b', available: true, interfacesVerified: false, reason: 'interface proof changed' }]])
    assert.deepEqual(plan(s, rows).taskIds, []);
  const big = clone(s); big.tasks[1].acceptance = Array.from({ length: 16 }, (_, index) => ({
    id: `large-proof-${index}`, text: 'x'.repeat(750), evidenceKinds: ['acceptance'] }));
  const blocked = plan(big); assert.deepEqual(blocked.taskIds, []);
  assert.ok(blocked.blocked.some(row => row.taskId === 'task-b' && row.reasons.some(reason => /split_required|too_large/.test(reason))));
});

test('Director SQLite CAS and idempotency replay precede stale revision checks and share canonical command hashing', async t => {
  const f = fixture(t), { A, store, repo } = await repository(f), created = await create(repo, f.root);
  const id = created.result.projectId, s = created.snapshot;
  assert.deepEqual(s.completeness.tasks, { total: 1, returned: 1, complete: true });
  const c = command(id, s.revision, { op: 'setPaused', paused: true });
  const bytes = A.directorBytes('command', c, options), first = await repo.apply(c);
  assert.equal(first.replayed, false); assert.equal(first.revision, s.revision + 1);
  const reordered = Object.fromEntries(Object.entries(c).reverse());
  assert.deepEqual(A.directorBytes('command', reordered, options), bytes);
  const replay = await repo.apply(reordered); assert.equal(replay.replayed, true); assert.equal(replay.revision, first.revision);
  await assert.rejects(() => repo.apply({ ...c, action: { op: 'setPaused', paused: false } }));
  await assert.rejects(() => repo.apply(command(id, s.revision, { op: 'setPaused', paused: false })));
  const history = await repo.history(id, { after: 0, limit: 1 });
  assert.equal(history.complete, false); assert.equal(history.events.length, 1); assert.ok(history.total >= 2);
  const next = await repo.history(id, { after: history.nextAfter, limit: 1000 });
  assert.ok(next.events.every(event => event.seq > history.nextAfter)); assert.equal(next.complete, true);
  assert.equal((await repo.snapshot(id)).revision, first.revision);
  const before = store.db.prepare('SELECT count(*) AS n FROM runs').get().n;
  assert.equal(before, 0, 'project control commands create no legacy Runs');
});

test('Director actual SQLite snapshot counts bodies and revision stay coherent during concurrent amendments', { timeout: 30000 }, async t => {
  const f = fixture(t), { repo } = await repository(f);
  const tasks = Array.from({ length: 1000 }, (_, index) => taskSpec(`task-${String(index).padStart(4, '0')}`, { priority: 0 }));
  const created = await create(repo, f.root, tasks), id = created.result.projectId, start = created.snapshot.revision;
  const workerSource = `import { parentPort, workerData } from 'node:worker_threads';
    const { Store } = await import(workerData.storeUrl);
    const contracts = await import(workerData.contractUrl);
    const { openProjectStore } = await import(workerData.repoUrl);
    const store = new Store(workerData.home, {});
    try { const repo = await openProjectStore({store,contracts}); parentPort.postMessage('ready');
      await new Promise(resolve => parentPort.once('message', resolve));
      for (let n=1;n<=30;n++) { const s=await repo.snapshot(workerData.id);
        await repo.apply({schemaVersion:1,commandId:crypto.randomUUID(),projectId:workerData.id,expectedRevision:s.revision,
          actor:'owned-oracle',reason:'Coherent read race',action:{op:'amend',kind:'task',id:workerData.task.id,record:{...workerData.task,priority:n}}}); }
    } finally { store.close(); }`;
  const worker = new Worker(new URL('data:text/javascript,' + encodeURIComponent(workerSource)), { workerData: { home: f.home, id, task: tasks[0],
    storeUrl: new URL('../runtime/store.mjs', import.meta.url).href, contractUrl: new URL('../runtime/project-contracts.mjs', import.meta.url).href,
    repoUrl: new URL('../runtime/project-store.mjs', import.meta.url).href }, env: f.env });
  t.after(() => worker.terminate());
  const exited = once(worker, 'exit').then(([code]) => ({ code }), error => ({ error }));
  const [message] = await once(worker, 'message'); assert.equal(message, 'ready'); worker.postMessage('go');
  for (let index = 0; index < 60; index++) {
    const s = await repo.snapshot(id);
    assert.equal(s.revision, s.project.revision);
    assert.equal(s.tasks.find(task => task.id === tasks[0].id).priority, s.revision - start, 'body and project revision belong to one commit');
    assert.equal(s.tasks.length, 1000); assert.deepEqual(s.completeness.tasks, { total: 1000, returned: 1000, complete: true });
    await new Promise(resolve => setImmediate(resolve));
  }
  const exit = await exited; assert.ifError(exit.error); assert.equal(exit.code, 0);
  assert.equal((await repo.snapshot(id)).revision, start + 30);
});

test('Director create replay uses canonical root and cross-project IDs cannot satisfy parents or dependencies', async t => {
  const f = fixture(t), { repo } = await repository(f), first = await create(repo, f.root);
  const alias = path.join(f.directory, 'owned-root-alias'); symlinkSync(f.root, alias, process.platform === 'win32' ? 'junction' : 'dir');
  const replay = await repo.apply({ ...first.input, action: { op: 'create', spec: { ...first.input.action.spec, root: alias } } });
  assert.equal(replay.projectId, first.result.projectId); assert.equal(replay.replayed, true);
  const otherRoot = path.join(f.directory, 'other-project'); mkdirSync(otherRoot);
  const other = await create(repo, otherRoot, [taskSpec('foreign-task')]);
  assert.notEqual(other.result.projectId, first.result.projectId);
  await assert.rejects(() => apply(repo, first.result.projectId, { op: 'insert', kind: 'task', record: taskSpec('new-task', { dependsOn: ['foreign-task'] }) }));
  await assert.rejects(() => apply(repo, first.result.projectId, { op: 'insert', kind: 'task', record: taskSpec('new-task', { epicId: 'unknown-epic' }) }));
  assert.equal((await repo.snapshot(first.result.projectId)).tasks.length, 1);
});

function backupFiles(directory) {
  const found = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) found.push(...backupFiles(file));
    else if (entry.isFile() && entry.name !== 'state.sqlite' && !/-wal$|-shm$/.test(entry.name)) {
      if (readFileSync(file).subarray(0, 16).equals(Buffer.from('SQLite format 3\0'))) found.push(file);
    }
  }
  return found;
}

test('Director additive migration backs up actual WAL data and preserves legacy bodies and user_version', async t => {
  const f = fixture(t), A = await contracts(), { Store } = await load('store'), { openProjectStore } = await load('project-store');
  const store = new Store(f.home, {}); f.stores.add(store);
  store.db.exec('PRAGMA user_version=71');
  const legacy = store.createRun({ id: randomUUID(), task: 'Existing legacy task', project: f.root, state: 'waiting_limits',
    completed: {}, nodes: {}, legacyExtension: { preserve: 'opaque legacy value' } });
  const body = store.db.prepare('SELECT body FROM runs WHERE id=?').get(legacy.id).body;
  assert.ok(readFileSync(path.join(f.home, 'state.sqlite-wal')).length > 32, 'committed WAL frames exist before migration');
  const repo = await openProjectStore({ store, contracts: A });
  assert.equal(store.db.prepare('PRAGMA user_version').get().user_version, 71);
  assert.equal(store.db.prepare('SELECT body FROM runs WHERE id=?').get(legacy.id).body, body);
  const backups = backupFiles(f.directory); assert.ok(backups.length > 0, 'migration retains an owned consistent SQLite backup');
  let backedUp = false;
  for (const file of backups) {
    const db = new DatabaseSync(file, { readOnly: true });
    try {
      assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
      if (db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='runs'").get())
        backedUp ||= db.prepare('SELECT body FROM runs WHERE id=?').get(legacy.id)?.body === body;
    } finally { db.close(); }
  }
  assert.equal(backedUp, true, 'backup includes committed legacy rows that were in WAL');
  const created = await create(repo, f.root); close(f, store);
  const reopened = await repository(f);
  assert.equal((await reopened.repo.snapshot(created.result.projectId)).tasks.length, 1);
  assert.equal(reopened.store.db.prepare('SELECT body FROM runs WHERE id=?').get(legacy.id).body, body);
});

test('Director failed additive migration rolls schema back and corruption fails closed', async t => {
  const f = fixture(t), A = await contracts(), { Store } = await load('store'), { openProjectStore } = await load('project-store');
  const store = new Store(f.home, {}); f.stores.add(store);
  const schema = () => store.db.prepare("SELECT type,name,sql FROM sqlite_master ORDER BY type,name").all();
  const before = schema(), pages = store.db.prepare('PRAGMA page_count').get().page_count;
  assert.equal(store.db.prepare('PRAGMA freelist_count').get().freelist_count, 0);
  store.db.exec(`PRAGMA max_page_count=${pages}`);
  await assert.rejects(() => openProjectStore({ store, contracts: A }));
  assert.deepEqual(schema(), before); assert.ok(backupFiles(f.directory).length > 0, 'failure preserves recovery backup');
  store.db.exec('PRAGMA max_page_count=1073741823');
  const recovered = await openProjectStore({ store, contracts: A });
  assert.equal((await create(recovered, f.root)).snapshot.tasks.length, 1);
  const corruptHome = path.join(f.directory, 'corrupt-state'); mkdirSync(corruptHome);
  const filename = path.join(corruptHome, 'state.sqlite'), corrupt = Buffer.from('Owned intentionally invalid SQLite bytes'); writeFileSync(filename, corrupt);
  await assert.rejects(async () => {
    let db;
    try {
      db = new DatabaseSync(filename);
      // Use Store's actual methods without its constructor trying to initialize
      // the corrupt database before the migration boundary is exercised.
      const damaged = Object.assign(Object.create(Store.prototype), { home: corruptHome, secrets: {}, db });
      await openProjectStore({ store: damaged, contracts: A });
    } finally { db?.close(); }
  });
  assert.deepEqual(readFileSync(filename), corrupt);
});

test('Director first install validates binding and exact immutable project task text before any legacy write', async t => {
  const f = fixture(t, { git: true }), { store, repo } = await repository(f, async () => {}), created = await create(repo, f.root);
  const id = created.result.projectId; await ready(repo, id);
  const attempt = await reserve(repo, id), s = await repo.snapshot(id), binding = bindingFor(attempt), good = draft(f, s, attempt);
  for (const change of [value => { value.task += '\nImplement an unauthorized sibling.'; }, value => { value.id = randomUUID(); },
    value => { value.project = f.directory; }, value => { value.directorBinding.contractHash = 'c'.repeat(64); },
    value => { value.directorBinding.projectId = randomUUID(); }, value => { value.directorBinding.taskId = 'foreign-task'; },
    value => { value.directorBinding.taskRevision++; }, value => { value.directorBinding.attemptId = randomUUID(); }]) {
    const bad = clone(good); change(bad);
    await assert.rejects(() => repo.installRun({ binding, runDraft: bad }));
    assert.throws(() => store.getRun(attempt.runId));
    assert.equal(store.db.prepare('SELECT count(*) AS n FROM events WHERE run_id=?').get(attempt.runId).n, 0);
  }
  const installed = await repo.installRun({ binding, runDraft: good });
  assert.equal(installed.id, attempt.runId); assert.equal(installed.task, expectedInput(s.project, s.tasks[0]));
  store.updateRun(installed.id, { state: 'waiting_limits', retained: 'after-install-crash' });
  const replay = await repo.installRun({ binding, runDraft: good });
  assert.equal(replay.state, 'waiting_limits'); assert.equal(replay.retained, 'after-install-crash');
  assert.equal(store.db.prepare('SELECT count(*) AS n FROM runs WHERE id=?').get(installed.id).n, 1);
  assert.equal(store.db.prepare("SELECT count(*) AS n FROM events WHERE run_id=? AND type='created'").get(installed.id).n, 1);
});

test('Director crash before install rolls back Run event and binding then restarts same reserved runId', async t => {
  const f = fixture(t), first = await repository(f, async () => {}), created = await create(first.repo, f.root), id = created.result.projectId;
  await ready(first.repo, id); const attempt = await reserve(first.repo, id), s = await first.repo.snapshot(id), good = draft(f, s, attempt);
  const original = first.store.event;
  first.store.event = function (...args) { original.apply(this, args); throw new Error('Owned crash after created event'); };
  await assert.rejects(() => first.repo.installRun({ binding: bindingFor(attempt), runDraft: good }));
  first.store.event = original;
  assert.throws(() => first.store.getRun(attempt.runId));
  assert.equal(first.store.db.prepare('SELECT count(*) AS n FROM events WHERE run_id=?').get(attempt.runId).n, 0);
  close(f, first.store); const second = await repository(f, async () => {});
  const resumed = await reserve(second.repo, id); assert.equal(resumed.id, attempt.id); assert.equal(resumed.runId, attempt.runId); assert.equal(resumed.number, 1);
  assert.equal((await second.repo.installRun({ binding: bindingFor(resumed), runDraft: good })).id, attempt.runId);
});

test('Director pause and cancel persist before first install and explicit retry creates a new attempt only', async t => {
  const f = fixture(t), { store, repo } = await repository(f, async () => {}), created = await create(repo, f.root), id = created.result.projectId;
  await ready(repo, id); const attempt = await reserve(repo, id), s = await repo.snapshot(id), good = draft(f, s, attempt);
  await apply(repo, id, { op: 'setPaused', paused: true });
  await assert.rejects(() => repo.installRun({ binding: bindingFor(attempt), runDraft: good }));
  await apply(repo, id, { op: 'setPaused', paused: false });
  await apply(repo, id, transition('attempt', attempt.id, 'cancelled'));
  await assert.rejects(() => repo.installRun({ binding: bindingFor(attempt), runDraft: good }));
  assert.throws(() => store.getRun(attempt.runId));
  await assert.rejects(() => reserve(repo, id));
  const retry = await reserve(repo, id, 'task-a', true);
  assert.equal(retry.number, 2); assert.notEqual(retry.runId, attempt.runId); assert.notEqual(retry.id, attempt.id);
  const latest = await repo.snapshot(id); assert.equal(latest.currentAttempts.length, 1); assert.equal(latest.currentAttempts[0].id, retry.id);
  assert.ok((await repo.history(id, { after: 0, limit: 1000 })).events.length >= 6);
});

test('Director risk approval is task-revision bound and active task amendment cannot rewrite a reservation', async t => {
  const f = fixture(t), { repo } = await repository(f, async () => {}), task = taskSpec('task-a', { riskApprovalRequired: true });
  const created = await create(repo, f.root, [task]), id = created.result.projectId;
  let s = await repo.snapshot(id);
  await apply(repo, id, { op: 'approveRisk', taskId: task.id, taskRevision: s.tasks[0].revision });
  assert.equal((await repo.snapshot(id)).riskApprovals.length, 1);
  await apply(repo, id, { op: 'amend', kind: 'task', id: task.id, record: { ...task, priority: 60 } });
  s = await repo.snapshot(id); assert.equal(s.riskApprovals.length, 0);
  await assert.rejects(() => apply(repo, id, { op: 'approveRisk', taskId: task.id, taskRevision: created.snapshot.tasks[0].revision }));
  await apply(repo, id, { op: 'approveRisk', taskId: task.id, taskRevision: s.tasks[0].revision });
  await ready(repo, id); s = await repo.snapshot(id);
  // A structural transition may advance Task.revision; approval must match the
  // current stored task, never a title/priority copied from an earlier version.
  if (!(s.riskApprovals.some(row => row.taskRevision === s.tasks[0].revision)))
    await apply(repo, id, { op: 'approveRisk', taskId: task.id, taskRevision: s.tasks[0].revision });
  const attempt = await reserve(repo, id);
  await assert.rejects(() => apply(repo, id, { op: 'amend', kind: 'task', id: task.id, record: { ...task, priority: 70 } }));
  assert.equal((await repo.snapshot(id)).currentAttempts[0].contractHash, attempt.contractHash);
});

test('Director trusted authorization is awaited and decision tokens or stale authorization cannot persist advancement', async t => {
  const f = fixture(t), { repo } = await repository(f), created = await create(repo, f.root), id = created.result.projectId;
  await assert.rejects(() => ready(repo, id));
  assert.equal((await repo.snapshot(id)).tasks[0].status, 'proposed');
  for (const returned of [true, { eligibleStates: ['ready'], verified: true }]) {
    const other = await repository(f, async () => returned); await assert.rejects(() => ready(other.repo, id));
  }
  let enter, release;
  const entered = new Promise(resolve => { enter = resolve; }), gate = new Promise(resolve => { release = resolve; });
  const authorized = await repository(f, async () => { enter(); await gate; });
  const pending = ready(authorized.repo, id); await entered;
  // A second SQLite connection can commit while the authorizer awaits: no await
  // is allowed inside B's transaction. Authorization then becomes stale.
  await apply(repo, id, { op: 'setPaused', paused: true }); release();
  await assert.rejects(() => pending);
  assert.equal((await repo.snapshot(id)).tasks[0].status, 'proposed');
  await apply(repo, id, { op: 'setPaused', paused: false });
  const trusted = await repository(f, async () => {}); await ready(trusted.repo, id);
  assert.equal((await repo.snapshot(id)).tasks[0].status, 'ready');
  for (const state of ['accepted', 'released']) await assert.rejects(() => apply(repo, id, transition('task', 'task-a', state)));
});

function proofFixture(root) {
  const s = inlineSnapshot(root); s.tasks[0].status = 'integrated';
  const refs = ['acceptance', 'checks', 'review'].map((kind, index) => reference(root, kind, { sha256: String(index + 1).repeat(64) }));
  const attempt = { schemaVersion: 1, id: attemptId, projectId, taskId: 'task-a', taskRevision: 1, number: 1, runId,
    contractHash: sha(JSON.stringify(expectedTaskContract(s.tasks[0]))), status: 'integrated', baseSha: head, headSha: head,
    evidence: refs, reason: null, createdAt: stamp, updatedAt: stamp };
  s.currentAttempts = [attempt]; s.completeness.currentAttempts = { total: 1, returned: 1, complete: true };
  const mappings = [{ criterionId: 'task-proof', refs: [refs[0].sha256], actor: 'owned-reviewer', reason: 'Observed fixture requirement' }];
  const run = { id: runId, project: root, cwd: root, task: expectedInput(s.project, s.tasks[0]), state: 'succeeded',
    baseSha: head, headSha: head, directorBinding: bindingFor(attempt),
    completed: { implementation: true }, nodes: { 'task-a': { status: 'integrated', baseSha: head, headSha: head } },
    plan: { summary: 'Owned observable requirement', tasks: [{ id: 'task-a', role: 'developer', description: s.tasks[0].description,
      dependsOn: [], writePaths: s.tasks[0].writePaths, acceptance: ['Observable fixture requirement is satisfied'], parallel: false }] },
    config: { commands: { test: [{ command: 'node', args: ['owned-check.mjs'] }], build: [], deploy: [], smoke: [] },
      delivery: { enabled: false, release: false }, uiVerification: { enabled: false }, security: { enabled: false }, architecture: { enabled: false } },
    checks: { schemaVersion: 2, headSha: head, complete: true,
      results: [{ kind: 'test', command: { command: 'node', args: ['owned-check.mjs'] }, exitCode: 0 }] },
    review: { headSha: head, passed: true, findings: [] },
    uiVerification: { status: 'disabled', passed: null }, securityChecks: { status: 'disabled', passed: null }, architectureChecks: { status: 'disabled', passed: null } };
  return { s, attempt, refs, mappings, run };
}

test('Director evidence awaits real proof ports and rejects forged stale mismatched or unmapped acceptance', async t => {
  const f = fixture(t), A = await contracts(), { evaluateProjectAttempt } = await load('project-evidence'), p = proofFixture(f.root);
  let verified = 0, validated = 0;
  const ports = { ...purePorts(A), verifyRef: async () => { await Promise.resolve(); verified++; }, validateRun: async () => { await Promise.resolve(); validated++; } };
  const evaluate = (value = p, proofPorts = ports) => evaluateProjectAttempt({ snapshot: value.s, attempt: value.attempt, run: value.run, mappings: value.mappings }, proofPorts);
  const positive = await evaluate(); assert.ok(positive.eligibleStates.includes('accepted')); assert.deepEqual(positive.blockers, []);
  assert.ok(verified >= 3); assert.ok(validated >= 1);
  for (const mutation of [value => { value.run.headSha = 'c'.repeat(40); }, value => { value.run.directorBinding.taskRevision = 2; },
    value => { value.run.id = randomUUID(); }, value => { value.mappings = []; }, value => { value.mappings[0].refs = ['d'.repeat(64)]; },
    value => { value.run.review.passed = false; }, value => { value.run.review.headSha = 'c'.repeat(40); },
    value => { value.run.checks.complete = false; }, value => { value.run.checks.results[0].exitCode = 1; },
    value => { value.run.config.security.enabled = true; }, value => { value.run.config.uiVerification.enabled = true; },
    value => { value.run.config.architecture.enabled = true; }, value => { value.run.checks.headSha = 'c'.repeat(40); }]) {
    const changed = clone(p); mutation(changed); const result = await evaluate(changed);
    assert.equal(result.eligibleStates.includes('accepted'), false); assert.ok(result.blockers.length > 0);
  }
  for (const failedPort of ['verifyRef', 'validateRun']) {
    const result = await evaluate(p, { ...ports, [failedPort]: async () => { await Promise.resolve(); deny(); } });
    assert.equal(result.eligibleStates.includes('accepted'), false); assert.ok(result.blockers.length > 0);
  }
  const noPublication = await evaluate(); assert.equal(noPublication.eligibleStates.includes('released'), false);
  const forged = clone(p); forged.run.release = { published: true, tag: 'v0.0.1' };
  assert.equal((await evaluate(forged)).eligibleStates.includes('released'), false, 'publication prose has no verified chain');
});

test('Director complete accepted children plus own mapped proof permit container acceptance', async t => {
  const f = fixture(t), A = await contracts(), { evaluateProjectTransition } = await load('project-evidence');
  for (const kind of ['epic', 'milestone', 'project']) {
    const p = proofFixture(f.root); p.s.tasks[0].status = 'accepted'; p.s.epics[0].status = 'accepted'; p.s.milestones[0].status = 'accepted';
    const record = kind === 'project' ? p.s.project : p.s[`${kind}s`][0]; record.status = 'integrated';
    const proofId = `${kind}-proof`, mappings = [{ criterionId: proofId, refs: [p.refs[0].sha256], actor: 'owned-reviewer', reason: 'Own container proof' }];
    record.evidence = p.refs; record.mappings = mappings;
    const result = await evaluateProjectTransition({ snapshot: p.s,
      command: command(projectId, 1, transition(kind, kind === 'project' ? projectId : record.id, 'accepted', p.refs, mappings)), run: p.run },
    { ...purePorts(A), verifyRef: async () => {}, validateRun: async () => {} });
    assert.ok(result.eligibleStates.includes('accepted'), `${kind} complete children and own verified criterion`);
    assert.deepEqual(result.blockers, []);
  }
});

test('Director container acceptance cannot be forged through incomplete children or completed prose', async t => {
  const f = fixture(t), A = await contracts(), { evaluateProjectTransition } = await load('project-evidence'), p = proofFixture(f.root);
  const ports = { ...purePorts(A), verifyRef: async () => {}, validateRun: async () => {} };
  for (const kind of ['epic', 'milestone', 'project']) {
    const id = kind === 'project' ? projectId : `${kind}-a`, c = command(projectId, 1, transition(kind, id, 'accepted'));
    const result = await evaluateProjectTransition({ snapshot: p.s, command: c, run: { ...p.run, summary: 'Everything completed and verified' } }, ports);
    assert.equal(result.eligibleStates.includes('accepted'), false); assert.ok(result.blockers.length > 0);
  }
  const incomplete = clone(p.s); incomplete.tasks = []; incomplete.completeness.tasks = { total: 1, returned: 0, complete: false };
  const result = await evaluateProjectTransition({ snapshot: incomplete,
    command: command(projectId, 1, transition('epic', 'epic-a', 'accepted')), run: p.run }, ports);
  assert.equal(result.eligibleStates.includes('accepted'), false); assert.ok(result.blockers.length > 0);
});

test('Director accepted history cannot be demoted by a later failure', async t => {
  const f = fixture(t), A = await contracts(), { evaluateProjectTransition } = await load('project-evidence'), p = proofFixture(f.root);
  p.s.tasks[0].status = 'accepted';
  assert.throws(() => A.assertProjectTransition({ record: p.s.tasks[0], to: 'ready', snapshot: p.s, evidence: [], mappings: [] }));
  const result = await evaluateProjectTransition({ snapshot: p.s,
    command: command(projectId, 1, transition('task', 'task-a', 'failed')), run: { ...p.run, state: 'blocked' } },
  { ...purePorts(A), verifyRef: async () => {}, validateRun: async () => {} });
  assert.equal(result.eligibleStates.includes('failed'), false);
});

test('Director production authorizer refuses caller eligibleStates without a bound actual Run', async t => {
  const f = fixture(t), A = await contracts(), { createProjectTransitionAuthorizer } = await load('project-director');
  const { Store } = await load('store'), store = new Store(f.home, {}); f.stores.add(store);
  let evaluations = 0;
  const evaluator = { evaluateProjectAttempt: async () => { evaluations++; deny(); }, evaluateProjectTransition: async () => { evaluations++; deny(); } };
  const authorize = createProjectTransitionAuthorizer({ store, contracts: A, evaluator, engine: { store, secrets: {} } });
  const s = inlineSnapshot(f.root), c = command(projectId, 1, transition('task', 'task-a', 'accepted'));
  await assert.rejects(() => authorize({ command: c, snapshot: s, eligibleStates: ['accepted'], verified: true }));
  assert.equal(store.db.prepare('SELECT count(*) AS n FROM runs').get().n, 0);
  assert.ok(evaluations <= 1, 'failure is bounded and cannot start another orchestration loop');
});

// A fake subscription-free Engine stands only at the documented adapter seam.
// It persists real Runs through installRun and records reservation identity;
// the Director under test still owns cancellation, retries and reconciliation.
function fakeEngine(f, store) {
  const calls = { created: [], runs: [], cancelled: [] }; let quota = true;
  const engine = { store, secrets: {},
    async createReserved(task, settings, { binding, installRun }) {
      calls.created.push(binding.runId);
      const value = { ...draft(f, inlineSnapshot(f.root), { ...binding, id: binding.attemptId }),
        id: binding.runId, task, project: settings.project || f.root, directorBinding: binding };
      mkdirSync(value.artifacts, { recursive: true });
      return installRun({ binding, runDraft: value });
    },
    async run(id) {
      calls.runs.push(id); const value = store.getRun(id);
      if (value.cancelRequested) return store.updateRun(id, { state: 'cancelled' });
      if (quota) return store.updateRun(id, { state: 'waiting_limits', error: { code: 'quota', message: 'Owned quota interruption' } });
      return value;
    },
    async cancel(id) {
      calls.cancelled.push(id); return store.updateRun(id, { state: 'cancelled', cancelRequested: true });
    }
  };
  return { engine, calls, setQuota(value) { quota = value; } };
}

test('Director quota restart and cancel reuse one reserved Run while explicit retry gets a new identity', async t => {
  const f = fixture(t, { git: true }), A = await contracts(), { createProjectDirector } = await load('project-director');
  const { planProjectHorizon } = await load('project-planner'), evaluator = await load('project-evidence');
  const first = await repository(f, async () => {}), created = await create(first.repo, f.root), id = created.result.projectId;
  await ready(first.repo, id); const fake = fakeEngine(f, first.store);
  const director = createProjectDirector({ repo: first.repo, engine: fake.engine, planner: planProjectHorizon, evaluator, clock: () => stamp });
  // Method argument convention is the existing CLI/Engine convention: id, options.
  // No novel request schema or caller-provided acceptance decision is introduced.
  try { await director.resume(id, { mode: 'quick', model: 'gpt-6.1-sol' }); } catch (error) { assert.equal(error.code, 'quota'); }
  const afterQuota = await first.repo.snapshot(id); assert.equal(afterQuota.currentAttempts.length, 1);
  const reserved = afterQuota.currentAttempts[0]; assert.equal(reserved.number, 1);
  assert.equal(first.store.getRun(reserved.runId).state, 'waiting_limits');
  assert.deepEqual(fake.calls.created, [reserved.runId]);
  close(f, first.store); const second = await repository(f, async () => {}), restarted = fakeEngine(f, second.store);
  restarted.setQuota(false);
  const resumed = createProjectDirector({ repo: second.repo, engine: restarted.engine, planner: planProjectHorizon, evaluator, clock: () => stamp });
  await resumed.resume(id);
  assert.deepEqual(restarted.calls.created, []); assert.deepEqual(restarted.calls.runs, [reserved.runId]);
  assert.equal((await second.repo.snapshot(id)).currentAttempts[0].runId, reserved.runId);
  await resumed.cancel(id);
  const cancelled = await second.repo.snapshot(id); assert.equal(cancelled.project.status, 'cancelled');
  assert.equal(second.store.getRun(reserved.runId).cancelRequested, true);
  const [blocked] = await Promise.allSettled([resumed.resume(id)]);
  if (blocked.status === 'rejected') assert.match(blocked.reason.code || '', /blocked|cancelled|canceled/);
  assert.deepEqual(restarted.calls.runs, [reserved.runId], 'cancelled project never forwards another Engine start');
  assert.equal(second.store.db.prepare('SELECT count(*) AS n FROM runs').get().n, 1);
  // Repository explicit retry is separately asserted above; project cancellation
  // may not be silently undone by an ordinary resume.
  assert.equal(typeof A.directorContractHash, 'function');
});

test('Director Store repeats decoded secret guard before any project write and rejects transformed raw Run data', async t => {
  const f = fixture(t), A = await contracts(), { Store } = await load('store'), { openProjectStore } = await load('project-store');
  const secret = 'owned"slash\\line\nprivate';
  const store = new Store(f.home, { FIXTURE: secret, SHORT: '\u2603' }); f.stores.add(store);
  const repo = await openProjectStore({ store, contracts: A, authorizeTransition: async () => {} });
  for (const raw of [{ ...spec(f.root), businessContext: secret }, { ...spec(f.root), businessContext: '\u2603' },
    { ...spec(f.root), ['raw-' + secret]: 'ordinary' }]) {
    await assert.rejects(() => repo.apply(command(null, null, { op: 'create', spec: raw })), error => {
      assert.equal(String(error.message).includes(secret), false); return true;
    });
  }
  const created = await create(repo, f.root), id = created.result.projectId; await ready(repo, id);
  const attempt = await reserve(repo, id), s = await repo.snapshot(id), good = draft(f, s, attempt);
  for (const extra of [{ ['raw-' + secret]: 'ordinary' }, { sourceText: 'Bearer owned-literal-credential' }]) {
    await assert.rejects(() => repo.installRun({ binding: bindingFor(attempt), runDraft: { ...good, ...extra } }));
    assert.throws(() => store.getRun(attempt.runId));
  }
  const saved = await repo.installRun({ binding: bindingFor(attempt), runDraft: good }); assert.equal(saved.task, good.task);
  const texts = store.db.prepare("SELECT body FROM runs").all().map(row => row.body).join('');
  assert.equal(texts.includes(secret), false); assert.equal(texts.includes('owned-literal-credential'), false);
});
