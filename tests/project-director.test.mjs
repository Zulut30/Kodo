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
async function fixture(t, { tasks = [task('first')], trusted = false } = {}) {
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
    delivery: { enabled: false, release: false }, uiVerification: { enabled: false }, security: { enabled: false }, architecture: { enabled: false } };
  await writeFile(path.join(root, 'kodo.config.json'), JSON.stringify(config));
  await writeFile(path.join(root, 'check.mjs'), "import {existsSync} from 'node:fs'; import assert from 'node:assert/strict'; assert.ok(existsSync('first.txt'));\n");
  for (const args of [['init', '-b', 'main'], ['config', 'user.name', 'Owned Project E'], ['config', 'user.email', 'project-e@example.invalid'],
    ['config', 'core.autocrlf', 'false'], ['config', 'commit.gpgSign', 'false'], ['add', '.'], ['commit', '-m', 'Owned fixture baseline']])
    await execute('git', args, { cwd: root, env: environment });
  const store = new Store(home, {}); stores.add(store);
  const engine = new Engine({ store, secrets: {}, leaseHeartbeatMs: 10 });
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
  assert.equal((await restarted.resume(f.id)).status, 'succeeded');
  snapshot = f.repo.snapshot(f.id);
  const second = snapshot.currentAttempts.find(row => row.taskId === 'second'), secondRun = f.store.getRun(second.runId);
  assert.equal(secondRun.baseSha, firstRun.headSha);
  assert.equal(await readFile(path.join(secondRun.cwd, 'first.txt'), 'utf8'), 'accepted dependency\n');
  assert.equal(snapshot.tasks.find(row => row.id === 'second').status, 'accepted');
  // Existing direct create still uses the actual user checkout, not a hidden frontier.
  assert.equal((await f.engine.create('Legacy caller', { project: f.root })).baseSha, await git(f.root, ['rev-parse', 'HEAD']));
});

test('Production authorizer awaits enabled gate freshness and rejects stale logs or changed actual HEAD', async t => {
  const f = await fixture(t, { trusted: true }); await f.ready('first');
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
  stored.config.security.enabled = true; stored.securityChecks = { status: 'passed', passed: true, headSha: stored.headSha };
  f.store.updateRun(stored.id, stored);
  f.engine.gates.isCurrentSecurityReceipt = async () => { entered(); await gate; return false; };
  let finished = false;
  const authorization = f.authorizer({ command: c, snapshot }).finally(() => { finished = true; });
  await Promise.race([waiting, authorization]); assert.equal(finished, false); release();
  await assert.rejects(() => authorization, { code: 'project_transition_blocked' });
  stored.config.security.enabled = false; f.store.updateRun(stored.id, stored);
  const log = await readFile(stored.checks.results[0].outputPath);
  await writeFile(stored.checks.results[0].outputPath, '{}');
  await assert.rejects(() => f.authorizer({ command: c, snapshot }), { code: 'project_transition_blocked' });
  await writeFile(stored.checks.results[0].outputPath, log);
  await writeFile(path.join(stored.cwd, 'unreviewed.txt'), 'Unreviewed change\n');
  await git(stored.cwd, ['add', 'unreviewed.txt']); await git(stored.cwd, ['commit', '-m', 'Owned stale-head observation']);
  await assert.rejects(() => f.authorizer({ command: c, snapshot }), { code: 'project_transition_blocked' });
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
