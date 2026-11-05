import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Engine } from '../runtime/engine.mjs';
import { Store } from '../runtime/store.mjs';
import * as A from '../runtime/project-contracts.mjs';
import * as D from '../runtime/project-evidence.mjs';
import { openProjectStore } from '../runtime/project-store.mjs';
import { createProjectDirector, createProjectTransitionAuthorizer } from '../runtime/project-director.mjs';
import { makeWorktree, git, diffHash } from '../runtime/workspace.mjs';
import { execute } from '../runtime/command.mjs';

const proof = id => ({ id, text: 'The assigned file exists and passes its independent check.', evidenceKinds: ['acceptance'] });
const task = (id, dependsOn = []) => ({ id, epicId: 'epic', title: id, description: `Implement ${id}.`, owner: 'developer',
  dependsOn, writePaths: [`${id}.txt`], acceptance: [proof(`${id}-proof`)], interfaceRefs: [], priority: 50,
  userValue: 1, risk: 1, estimatedEffort: 1, riskApprovalRequired: false });
async function fixture(t, { tasks = [task('first')], trusted = false, security = false } = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'kodo-project-e-'));
  const root = path.join(directory, 'repo'), home = path.join(directory, 'state'), isolated = path.join(directory, 'empty-home');
  await mkdir(root); await mkdir(isolated); await writeFile(path.join(isolated, 'gitconfig'), '');
  const environment = { ...process.env, HOME: isolated, USERPROFILE: isolated, KODO_HOME: home,
    KODO_CREDENTIAL_HOME: path.join(isolated, 'empty-credentials'), KODO_WORKTREE_HOME: path.join(directory, 'worktrees'), GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: path.join(isolated, 'gitconfig'), GIT_TERMINAL_PROMPT: '0' };
  const previous = Object.fromEntries(['HOME', 'USERPROFILE', 'KODO_HOME', 'KODO_CREDENTIAL_HOME', 'KODO_WORKTREE_HOME', 'GIT_CONFIG_NOSYSTEM', 'GIT_CONFIG_GLOBAL', 'GIT_TERMINAL_PROMPT'].map(key => [key, process.env[key]]));
  for (const key of Object.keys(previous)) process.env[key] = environment[key];
  const stores = new Set();
  t.after(async () => {
    for (const store of stores) store.close();
    for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    assert.equal(path.dirname(directory), path.resolve(os.tmpdir())); assert.match(path.basename(directory), /^kodo-project-e-/);
    await rm(directory, { recursive: true, force: true });
  });
  const config = { schemaVersion: 1, client: 'codex', executionMode: 'quick', maxTasks: 1, concurrency: 1,
    researchBudget: 0, repairRounds: 1, commands: { test: [{ command: process.execPath, args: ['check.mjs'] }], build: [], deploy: [], smoke: [] },
    delivery: { enabled: false, release: false }, uiVerification: { enabled: false }, security: { enabled: security }, architecture: { enabled: false } };
  await writeFile(path.join(root, 'kodo.config.json'), JSON.stringify(config));
  await writeFile(path.join(root, 'check.mjs'), "import {existsSync} from 'node:fs'; import assert from 'node:assert/strict'; assert.ok(existsSync('first.txt'));\n");
  for (const args of [['init', '-b', 'main'], ['config', 'user.name', 'Owned Project E'], ['config', 'user.email', 'project-e@example.invalid'],
    ['config', 'core.autocrlf', 'false'], ['config', 'commit.gpgSign', 'false'], ['add', '.'], ['commit', '-m', 'Owned fixture baseline']])
    await execute('git', args, { cwd: root, env: environment });
  const store = new Store(home, {}); stores.add(store);
  const engine = new Engine({ store, secrets: {}, leaseHeartbeatMs: 10 });
  if (security) engine.gates.isCurrentSecurityReceipt = async () => true;
  const contract = await engine.persistEvidence({ artifacts: path.join(home, 'interfaces') }, 'interface', { taskBoundary: 'Owned assigned file' }, { headSha: null });
  tasks = tasks.map(row => ({ ...row, interfaceRefs: [{ kind: 'interface', runId: null, headSha: null, path: contract.path, sha256: contract.sha256 }] }));
  const authorizer = createProjectTransitionAuthorizer({ store, engine, contracts: A, evaluator: D });
  const repo = await openProjectStore({ store, contracts: A, authorizeTransition: trusted ? authorizer : async () => {} });
  const spec = { schemaVersion: 1, id: 'owned', root, title: 'Owned Project E', definitionOfDone: [proof('project-proof')],
    constraints: ['Only assigned paths.'], businessContext: 'Subscription-free fixture.', architectureRefs: [],
    milestones: [{ id: 'milestone', title: 'Owned milestone', acceptance: [proof('milestone-proof')], releaseRequired: false }],
    epics: [{ id: 'epic', milestoneId: 'milestone', title: 'Owned epic', acceptance: [proof('epic-proof')] }], tasks };
  const c = (snapshot, action, overrides = {}) => ({ schemaVersion: 1, projectId: snapshot?.project.projectId ?? null,
    expectedRevision: snapshot?.revision ?? null, commandId: randomUUID(), actor: 'owned-test', reason: 'Observe the public requirement', action, ...overrides });
  const created = await repo.apply(c(null, { op: 'create', spec })), id = created.projectId;
  const apply = async action => repo.apply(c(repo.snapshot(id), action));
  const transition = (kind, entity, to, evidence = [], mappings = []) => apply({ op: 'transition', kind, id: entity, to, evidence, mappings });
  const ready = async taskId => transition('task', taskId, 'ready');
  const director = createProjectDirector({ repo, engine, clock: () => new Date().toISOString() });
  return { root, home, directory, store, stores, engine, repo, id, c, apply, transition, ready, director, config, authorizer };
}

test('Director reservation installs real Engine descriptors, preserves quota identity after reopen, and cancels before forwarding', async t => {
  const f = await fixture(t); await f.ready('first');
  let created = 0, ran = 0;
  const original = f.engine.createReserved.bind(f.engine);
  f.engine.createReserved = async (...args) => { created++; return original(...args); };
  f.engine.run = async id => { ran++; return f.store.updateRun(id, { state: 'waiting_limits' }); };
  const result = await f.director.resume(f.id, { mode: 'quick', model: 'gpt-6.1-sol' });
  const reserved = f.repo.snapshot(f.id).currentAttempts[0];
  assert.equal(result.status, 'waiting_limits'); assert.equal(created, 1); assert.equal(ran, 1);
  assert.equal(f.store.getRun(reserved.runId).task, A.buildDirectorTaskInput({ project: f.repo.snapshot(f.id).project, task: f.repo.snapshot(f.id).tasks[0] }, { knownValues: [] }));
  f.store.close(); f.stores.delete(f.store);
  const store = new Store(f.home, {}); f.stores.add(store);
  const repo = await openProjectStore({ store, contracts: A, authorizeTransition: async () => {} });
  const engine = new Engine({ store, secrets: {} });
  engine.createReserved = async () => { assert.fail('Reopen must reconcile the existing reserved Run'); };
  engine.run = async id => { assert.equal(id, reserved.runId); assert.equal(store.getRun(id).fixedModel.model, 'gpt-6.1-sol'); return store.getRun(id); };
  let cancelled = 0;
  engine.cancel = async id => {
    cancelled++; assert.equal(repo.snapshot(f.id).project.status, 'cancelled');
    assert.equal(repo.snapshot(f.id).currentAttempts[0].status, 'cancelled'); assert.equal(store.getRun(id).cancelRequested, true);
  };
  const resumed = createProjectDirector({ repo, engine });
  await resumed.resume(f.id, { mode: 'deep', model: 'gpt-6-astra' });
  assert.equal(repo.snapshot(f.id).currentAttempts[0].number, 1);
  await resumed.cancel(f.id); assert.equal(cancelled, 1);
  await assert.rejects(() => resumed.resume(f.id), { code: 'project_control_blocked' });
  assert.equal(store.db.prepare('SELECT count(*) AS n FROM runs').get().n, 1);
});

test('Director explicit retry creates a new Run and preserves failed attempt history', async t => {
  const f = await fixture(t); await f.ready('first');
  f.engine.run = async id => f.store.updateRun(id, { state: 'blocked', error: { code: 'blocked', message: 'Owned exhausted cycle' } });
  assert.equal((await f.director.run(f.id)).status, 'blocked');
  const first = f.repo.snapshot(f.id).currentAttempts[0];
  assert.equal((await f.director.resume(f.id)).status, 'blocked');
  f.engine.run = async id => f.store.updateRun(id, { state: 'waiting_limits' });
  await f.director.resume(f.id, { retryFailed: true });
  const second = f.repo.snapshot(f.id).currentAttempts[0];
  assert.notEqual(first.runId, second.runId); assert.equal(second.number, 2);
  assert.equal(f.store.getRun(first.runId).state, 'blocked');
  assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM runs').get().n, 2);
  assert.ok(f.repo.history(f.id, { after: 0, limit: 1000 }).events.some(event => event.entity.id === first.id));
});

test('Same-task retry after reservation crash keeps the fixed model provider and lower budgets with fresh config', async t => {
  const f = await fixture(t); await f.ready('first');
  f.engine.run = async id => f.store.updateRun(id, { state: 'blocked' });
  await f.director.run(f.id, { mode: 'quick', model: 'gpt-6.1-sol', providers: 'current' });
  const prior = f.repo.snapshot(f.id).currentAttempts[0], priorRun = f.store.getRun(prior.runId);
  await writeFile(path.join(f.root, 'kodo.config.json'), JSON.stringify({ ...f.config, executionMode: 'deep', maxTasks: 24,
    concurrency: 5, researchBudget: 40, repairRounds: 5, security: { enabled: true } }));
  // A restart between B reservation and E install must recover old limits from
  // durable state, rather than depending on a variable in the previous process.
  await f.apply({ op: 'reserveAttempt', taskId: 'first', retryFailed: true });
  f.engine.run = async id => f.store.updateRun(id, { state: 'waiting_limits' });
  const restarted = createProjectDirector({ repo: f.repo, engine: f.engine });
  await restarted.resume(f.id, { mode: 'deep', model: 'gpt-6-astra', providers: 'both', concurrency: 5 });
  const current = f.repo.snapshot(f.id).currentAttempts[0], run = f.store.getRun(current.runId);
  assert.equal(current.number, 2); assert.notEqual(run.id, priorRun.id);
  assert.deepEqual(run.fixedModel, priorRun.fixedModel); assert.equal(run.providers, 'current'); assert.equal(run.requestedMode, 'quick');
  for (const key of ['researchBudget', 'repairRounds', 'concurrency', 'maxTasks']) assert.equal(run.config[key], priorRun.config[key]);
  assert.equal(run.config.security.enabled, true, 'Fresh policy cannot inherit a disabled gate or old PASS');
});

test('Retry blocks before installing when the prior fixed model was removed from current allowlist', async t => {
  const f = await fixture(t); await f.ready('first');
  f.engine.run = async id => f.store.updateRun(id, { state: 'blocked' });
  await f.director.run(f.id, { mode: 'quick', model: 'gpt-6.1-sol' });
  await writeFile(path.join(f.root, 'kodo.config.json'), JSON.stringify({ ...f.config, models: { codex: ['gpt-6-astra'] } }));
  await assert.rejects(() => f.director.resume(f.id, { retryFailed: true }), { code: 'project_retry_model_unavailable' });
  assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM runs').get().n, 1);
});

test('Director pause or lost lease during reserved initialization prevents atomic install and dispatch', async t => {
  for (const interruption of ['pause', 'lease']) await t.test(interruption, async sub => {
    const f = await fixture(sub); await f.ready('first');
    const initialize = f.engine.initializeRun.bind(f.engine); let starts = 0;
    f.engine.initializeRun = async run => {
      await initialize(run);
      if (interruption === 'pause') await f.director.pause(f.id);
      else { const renew = f.store.renewLease.bind(f.store); f.store.renewLease = token => false; sub.after(() => { f.store.renewLease = renew; }); }
    };
    f.engine.run = async () => { starts++; };
    await assert.rejects(() => f.director.run(f.id), error => /project_(control_blocked|lease_lost)/.test(error.code));
    assert.equal(starts, 0); assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM runs').get().n, 0);
    assert.equal(f.repo.snapshot(f.id).currentAttempts[0].number, 1);
  });
});

async function checkedRun(f, id, file) {
  const run = f.store.getRun(id);
  await makeWorktree(run.project, run.cwd, run.branch, run.baseSha);
  if (file === 'second') assert.equal(await readFile(path.join(run.cwd, 'first.txt'), 'utf8'), 'accepted dependency\n');
  await writeFile(path.join(run.cwd, `${file}.txt`), file === 'first' ? 'accepted dependency\n' : 'dependent implementation\n');
  await git(run.cwd, ['add', `${file}.txt`]); await git(run.cwd, ['commit', '-m', `Owned ${file}`]);
  run.headSha = await git(run.cwd, ['rev-parse', 'HEAD']);
  run.plan = { summary: 'One scoped fixture change', tasks: [{ id: 'implementation', role: 'developer', description: 'Owned file',
    writePaths: [`${file}.txt`], dependsOn: [], acceptance: ['Independent file check passes'], parallel: false }] };
  run.nodes = { implementation: { status: 'integrated' } }; run.completed.implementation = true;
  await f.engine.checks(run);
  run.review = { passed: true, findings: [], sessionId: 'owned-independent-review', headSha: run.headSha,
    diffHash: await diffHash(run.cwd, run.baseSha) };
  if (run.config.security.enabled) run.securityChecks = { status: 'passed', passed: true, headSha: run.headSha };
  run.state = 'succeeded'; f.engine.save(run); return run;
}

test('Trusted acceptance and owned Git restart preserve the first local task file in the second reserved base', async t => {
  const f = await fixture(t, { tasks: [task('first'), task('second', ['first'])], trusted: true });
  await f.ready('first');
  f.engine.run = id => checkedRun(f, id, 'first');
  assert.equal((await f.director.resume(f.id)).status, 'succeeded');
  let snapshot = f.repo.snapshot(f.id);
  assert.equal(snapshot.tasks[0].status, 'accepted'); assert.equal(snapshot.currentAttempts[0].status, 'accepted');
  const firstRun = f.store.getRun(snapshot.currentAttempts[0].runId);
  assert.notEqual(await git(f.root, ['rev-parse', 'HEAD']), firstRun.headSha);
  await assert.rejects(() => readFile(path.join(f.root, 'first.txt')));
  // Fresh foreground adapter reads durable accepted Runs; it does not remember a
  // transient base or re-run historical provider/gate sessions to build ancestry.
  const restarted = createProjectDirector({ repo: f.repo, engine: f.engine });
  f.engine.run = id => checkedRun(f, id, 'second');
  await f.ready('second');
  const finalTask = await restarted.resume(f.id);
  assert.equal(finalTask.status, 'blocked');
  assert.ok(finalTask.blockers.includes('epic:epic:own_proof_missing'));
  snapshot = f.repo.snapshot(f.id);
  const second = snapshot.currentAttempts.find(row => row.taskId === 'second'), secondRun = f.store.getRun(second.runId);
  assert.equal(secondRun.baseSha, firstRun.headSha);
  assert.equal(await readFile(path.join(secondRun.cwd, 'first.txt'), 'utf8'), 'accepted dependency\n');
  assert.equal(snapshot.tasks.find(row => row.id === 'second').status, 'accepted');
  // Completed task counts alone cannot accept a container. Explicit own proof
  // may arrive later; foreground resume must then advance without any new Run.
  const totalRuns = f.store.db.prepare('SELECT count(*) AS n FROM runs').get().n;
  const own = await f.engine.persistEvidence(secondRun, 'acceptance', {
    observed: { first: await readFile(path.join(secondRun.cwd, 'first.txt'), 'utf8'),
      second: await readFile(path.join(secondRun.cwd, 'second.txt'), 'utf8') },
    criteria: ['epic-proof', 'milestone-proof', 'project-proof']
  }, { headSha: secondRun.headSha });
  const ownRef = { kind: 'acceptance', runId: secondRun.id, headSha: secondRun.headSha, path: own.path, sha256: own.sha256 };
  const checksReview = snapshot.tasks.find(row => row.id === 'second').evidence.filter(ref => ['checks', 'review'].includes(ref.kind));
  for (const [kind, entity, criterionId] of [['epic', 'epic', 'epic-proof'], ['milestone', 'milestone', 'milestone-proof'], ['project', f.id, 'project-proof']]) {
    await f.transition(kind, entity, 'ready', [ownRef, ...checksReview], [{ criterionId, refs: [ownRef.sha256],
      actor: 'owned-container-reviewer', reason: 'Observed both required files through explicit own criterion evidence' }]);
  }
  f.engine.run = async () => { assert.fail('Container-only resume cannot restart a task Run'); };
  const completed = await restarted.resume(f.id);
  assert.equal(completed.status, 'succeeded'); assert.equal(completed.projectStatus, 'accepted');
  snapshot = f.repo.snapshot(f.id);
  assert.equal(snapshot.epics[0].status, 'accepted'); assert.equal(snapshot.milestones[0].status, 'accepted');
  assert.equal(snapshot.project.status, 'accepted');
  assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM runs').get().n, totalRuns);
  // Existing direct create still uses the actual user checkout, not a hidden frontier.
  assert.equal((await f.engine.create('Legacy caller', { project: f.root })).baseSha, await git(f.root, ['rev-parse', 'HEAD']));
});

test('Production authorizer awaits enabled gate freshness and rejects stale logs or changed actual HEAD', async t => {
  const f = await fixture(t, { trusted: true, security: true }); await f.ready('first');
  f.engine.run = id => checkedRun(f, id, 'first');
  await f.director.run(f.id);
  const snapshot = f.repo.snapshot(f.id), attempt = snapshot.currentAttempts[0], stored = f.store.getRun(attempt.runId);
  const refs = snapshot.tasks[0].evidence, mappings = snapshot.tasks[0].mappings;
  // Evaluate the production trusted callback against the real current binding
  // and evidence, using a preceding lifecycle stage in the detached snapshot.
  snapshot.tasks[0].status = 'integrated'; snapshot.currentAttempts[0].status = 'integrated';
  const c = f.c(snapshot, { op: 'transition', kind: 'task', id: 'first', to: 'accepted', evidence: refs, mappings });
  let entered, release;
  const waiting = new Promise(resolve => { entered = resolve; }), gate = new Promise(resolve => { release = resolve; });
  f.engine.gates.isCurrentSecurityReceipt = async () => { entered(); await gate; return false; };
  let finished = false;
  const authorization = f.authorizer({ command: c, snapshot }).finally(() => { finished = true; });
  await Promise.race([waiting, authorization]); assert.equal(finished, false); release();
  await assert.rejects(() => authorization, { code: 'project_transition_blocked' });
  f.engine.gates.isCurrentSecurityReceipt = async () => true;
  const configText = await readFile(path.join(f.root, 'kodo.config.json'), 'utf8');
  await writeFile(path.join(f.root, 'kodo.config.json'), JSON.stringify({ ...f.config, commands: {
    ...f.config.commands, test: [{ command: process.execPath, args: ['new-required-check.mjs'] }]
  } }));
  await assert.rejects(() => f.authorizer({ command: c, snapshot }), { code: 'project_transition_blocked' });
  await writeFile(path.join(f.root, 'kodo.config.json'), configText);
  const log = await readFile(stored.checks.results[0].outputPath);
  await writeFile(stored.checks.results[0].outputPath, '{}');
  await assert.rejects(() => f.authorizer({ command: c, snapshot }), { code: 'project_transition_blocked' });
  await writeFile(stored.checks.results[0].outputPath, log);
  await writeFile(path.join(stored.cwd, 'unreviewed.txt'), 'Unreviewed change\n');
  await git(stored.cwd, ['add', 'unreviewed.txt']); await git(stored.cwd, ['commit', '-m', 'Owned stale-head observation']);
  await assert.rejects(() => f.authorizer({ command: c, snapshot }), { code: 'project_transition_blocked' });
});

test('Director returns final confirmed release and repeated resume is read-only without restarting a Run', async t => {
  const f = await fixture(t); await f.ready('first');
  const attempt = (await f.apply({ op: 'reserveAttempt', taskId: 'first', retryFailed: false })).attempt;
  const snapshot = f.repo.snapshot(f.id), head = await git(f.root, ['rev-parse', 'HEAD']);
  snapshot.currentAttempts[0].status = 'released'; snapshot.tasks[0].status = 'released';
  for (const record of [snapshot.epics[0], snapshot.milestones[0], snapshot.project]) record.status = 'accepted';
  const refs = ['acceptance', 'checks', 'review', 'release'].map((kind, index) => ({ kind, runId: attempt.runId, headSha: head,
    path: path.join(f.home, 'owned-evidence', `${kind}-${String(index + 1).repeat(64)}.json`), sha256: String(index + 1).repeat(64) }));
  for (const record of [snapshot.epics[0], snapshot.milestones[0], snapshot.project]) {
    record.evidence = refs;
    record.mappings = [{ criterionId: (record.definitionOfDone || record.acceptance)[0].id, refs: [refs[0].sha256],
      actor: 'owned-publication-test', reason: 'Trusted repository transition fixture' }];
  }
  let transitions = 0;
  const repo = { snapshot: () => structuredClone(snapshot), async apply(c) {
    const record = c.action.kind === 'project' ? snapshot.project : snapshot[`${c.action.kind}s`].find(row => row.id === c.action.id);
    record.status = c.action.to; snapshot.revision++; snapshot.project.revision = snapshot.revision; transitions++;
  } };
  // Fake only the already trusted acceptance boundary for this control-flow unit;
  // this does not claim that any remote artifact was actually published.
  const engine = { store: f.store, secrets: {}, run: async () => assert.fail('Settled tasks cannot restart') };
  const original = f.store.getRun.bind(f.store);
  f.store.getRun = id => id === attempt.runId ? { id, state: 'succeeded' } : original(id);
  const director = createProjectDirector({ repo, engine, evaluator: {
    evaluateProjectTransition: async ({ command: c }) => ({ schemaVersion: 1, eligibleStates: [c.action.to], blockers: [], evidence: refs })
  } });
  assert.deepEqual(await director.resume(f.id), { status: 'succeeded', projectStatus: 'released' });
  assert.equal(transitions, 3);
  assert.deepEqual(await director.resume(f.id), { status: 'succeeded', projectStatus: 'released' });
  assert.equal(transitions, 3);
});

test('Project plan preserves lower limits and verifies actual immutable interfaces before offering work', async t => {
  const f = await fixture(t, { tasks: [task('first'), task('other')] });
  const ref = await f.engine.persistEvidence({ artifacts: path.join(f.home, 'interfaces') }, 'interface', { contract: 'Owned interface' }, { headSha: null });
  const first = task('first'); first.interfaceRefs = [{ kind: 'interface', runId: null, headSha: null, path: ref.path, sha256: ref.sha256 }];
  await f.apply({ op: 'amend', kind: 'task', id: 'first', record: first });
  assert.deepEqual((await f.director.plan(f.id, { limit: 24, mode: 'deep' })).taskIds, ['first']);
  await writeFile(ref.path, '{}');
  const result = await f.director.plan(f.id);
  assert.equal(result.taskIds.includes('first'), false);
  assert.ok(result.blocked.find(row => row.taskId === 'first').reasons.includes('interfaces_unverified'));
  assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM runs').get().n, 0);
});
