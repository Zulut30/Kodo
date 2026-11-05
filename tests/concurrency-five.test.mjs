import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Engine } from '../runtime/engine.mjs';
import { Store } from '../runtime/store.mjs';
import { readConfig } from '../runtime/config.mjs';
import { resolveMode } from '../runtime/modes.mjs';
import { workerEnvironment } from '../runtime/security.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const model = { client: 'codex', model: 'gpt-6.1-sol' };
const deferred = () => Promise.withResolvers();
const turn = () => new Promise(resolve => setImmediate(resolve));
function observeAdmissions(store) {
  const tried = deferred(), tokens = [], acquire = store.acquireLease.bind(store);
  store.acquireLease = (name, owner, options) => {
    const token = acquire(name, owner, options);
    if (name === 'subscription:codex') { tokens.push(token); if (tokens.length === 5) tried.resolve(); }
    return token;
  };
  return { tried, tokens };
}
const task = (id, writePaths = [`${id}.txt`], dependsOn = []) => ({ id, role: 'developer', description: `Task ${id}`, acceptance: [`${id} is verified`], parallel: true, writePaths, dependsOn });
async function fixture(t, concurrency = 5) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'kodo-five-'));
  const project = path.join(directory, 'project'); await mkdir(project);
  const store = new Store(path.join(directory, 'state'));
  t.after(async () => {
    store.close();
    assert.equal(path.dirname(directory), path.resolve(os.tmpdir()));
    assert.ok(path.basename(directory).startsWith('kodo-five-'));
    await rm(directory, { recursive: true, force: true });
  });
  const provider = { runSession: async () => ({ output: { complete: true } }) };
  const engine = new Engine({ store, provider });
  // Keep the actual scheduler, session admission, cancellation and shared SQLite
  // leases. Policy/tool/environment and optional knowledge I/O are unrelated
  // to pool capacity; real knowledge integration is covered separately.
  engine.policy = async () => ''; engine.toolContext = async () => '';
  engine.resolveWorkerTools = async () => ({}); engine.executionEnvironment = async () => ({});
  engine.nativeKnowledge = async () => ({ text: '', references: [], metrics: {} });
  engine.save = run => store.updateRun(run.id, run, { preserveCancellation: true });
  const run = store.createRun({ task: 'Five independent sessions', project, cwd: project, state: 'implementing',
    config: { concurrency, delivery: { enabled: false } }, models: [model], fixedModel: model,
    plan: { tasks: [] }, sessionAttempts: [] });
  const session = (run, signal, id = 'probe') => engine.session(run, { ...model, cwd: project, prompt: id, readOnly: true }, signal);
  return { directory, project, store, engine, run, provider, session };
}

test('Concurrency config accepts 1 through 5 and rejects zero six fractional and string values', async t => {
  const fx = await fixture(t);
  assert.equal((await readConfig(fx.project)).concurrency, 2);
  for (const concurrency of [1, 2, 3, 4, 5]) {
    await writeFile(path.join(fx.project, 'kodo.config.json'), JSON.stringify({ concurrency }));
    assert.equal((await readConfig(fx.project)).concurrency, concurrency);
  }
  for (const concurrency of [0, 6, 1.5, '5', null]) {
    await writeFile(path.join(fx.project, 'kodo.config.json'), JSON.stringify({ concurrency }));
    await assert.rejects(readConfig(fx.project));
  }
});

test('Explicit concurrency survives every selected mode while other lower budgets stay bounded', () => {
  for (const requested of ['quick', 'standard', 'deep']) {
    const profile = resolveMode({ requested, config: { concurrency: 5, researchBudget: 0, repairRounds: 1, maxTasks: 2 } }).profile;
    assert.equal(profile.concurrency, 5);
    assert.equal(profile.researchBudget, 0); assert.equal(profile.repairRounds, 1); assert.equal(profile.maxTasks, 2);
    assert.equal(resolveMode({ requested, config: { concurrency: 1 } }).profile.concurrency, 1);
  }
  assert.equal(resolveMode({ requested: 'quick' }).profile.concurrency, 1);
  assert.equal(resolveMode({ requested: 'standard' }).profile.concurrency, 2);
  for (const concurrency of [0, 6, 1.5, '5']) assert.throws(() => resolveMode({ config: { concurrency } }));
});

test('Engine has five actually active fake native sessions behind one subscription barrier', { timeout: 10000 }, async t => {
  const fx = await fixture(t), allStarted = deferred(), release = deferred(), controller = new AbortController();
  const admission = observeAdmissions(fx.store);
  const active = new Set(); let peak = 0;
  fx.provider.runSession = async request => {
    assert.equal(request.client, model.client); assert.equal(request.model, model.model);
    active.add(request.prompt); peak = Math.max(peak, active.size);
    if (active.size === 5) allStarted.resolve();
    try { await release.promise; return { output: { complete: true } }; }
    finally { active.delete(request.prompt); }
  };
  const running = Array.from({ length: 5 }, (_, i) => fx.session(fx.run, controller.signal, `session-${i}`));
  t.signal.addEventListener('abort', () => { controller.abort(); release.resolve(); }, { once: true });
  try {
    await admission.tried.promise; assert.equal(admission.tokens.filter(Boolean).length, 5);
    await allStarted.promise;
    assert.equal(active.size, 5); assert.equal(peak, 5);
    const peer = new Store(fx.store.home);
    try { assert.equal(peer.acquireLease('subscription:codex', 'sixth', { limit: 5 }), null); }
    finally { peer.close(); }
  } finally { controller.abort(); release.resolve(); await Promise.allSettled(running); }
  assert.equal(active.size, 0);
  assert.equal(fx.run.sessionAttempts.filter(row => row.status === 'completed').length, 5);
  assert.equal(fx.store.db.prepare('SELECT count(*) AS count FROM leases').get().count, 0);
});

test('Five-slot Engine scheduler serializes conflicting scopes dependencies and integrations', { timeout: 10000 }, async t => {
  const fx = await fixture(t), allStarted = deferred(), release = deferred();
  const admission = observeAdmissions(fx.store);
  fx.run.plan.tasks = [task('a', ['src']), ...['b', 'c', 'd', 'e'].map(id => task(id)), task('overlap', ['src/child.mjs']), task('dependent', ['dependent.txt'], ['a'])];
  for (const item of fx.run.plan.tasks) fx.run.nodes[item.id] = { id: item.id, status: 'pending', routing: { parallel: true } };
  fx.engine.recoverIntegrationEdits = async () => {};
  const active = new Set(), starts = []; let peak = 0, integrating = 0;
  fx.provider.runSession = async request => {
    const id = request.prompt.split('\n').at(-1); starts.push(id); active.add(id); peak = Math.max(peak, active.size);
    if (['overlap', 'dependent'].includes(id)) assert.equal(fx.run.nodes.a.status, 'integrated');
    if (active.size === 5) allStarted.resolve();
    try { if (['a', 'b', 'c', 'd', 'e'].includes(id)) await release.promise; return { output: { complete: true } }; }
    finally { active.delete(id); }
  };
  fx.engine.performNode = async (run, item, signal) => { await fx.session(run, signal, item.id); run.nodes[item.id].status = 'completed'; };
  fx.engine.integrateNode = async (run, item) => { assert.equal(++integrating, 1); await turn(); run.nodes[item.id].status = 'integrated'; integrating--; };
  const running = fx.engine.executeTasks(fx.run, t.signal);
  t.signal.addEventListener('abort', () => release.resolve(), { once: true });
  try { await admission.tried.promise; assert.equal(admission.tokens.filter(Boolean).length, 5); await allStarted.promise; assert.equal(active.size, 5); assert.deepEqual(starts, ['a', 'b', 'c', 'd', 'e']); }
  finally { release.resolve(); await running; }
  assert.equal(peak, 5); assert.equal(integrating, 0);
  assert.ok(fx.run.plan.tasks.every(item => fx.run.nodes[item.id].status === 'integrated'));
});

test('New run CLI concurrency beats project config and saved lower concurrency survives resume preparation', async t => {
  const fx = await fixture(t);
  for (const args of [['init', '-b', 'main'], ['config', 'user.name', 'Pool fixture'], ['config', 'user.email', 'pool@example.invalid']]) {
    assert.equal(spawnSync('git', args, { cwd: fx.project, encoding: 'utf8', windowsHide: true }).status, 0);
  }
  await writeFile(path.join(fx.project, 'kodo.config.json'), JSON.stringify({ concurrency: 1, executionMode: 'quick', researchBudget: 0 }));
  assert.equal(spawnSync('git', ['add', '.'], { cwd: fx.project, windowsHide: true }).status, 0);
  assert.equal(spawnSync('git', ['commit', '-m', 'fixture'], { cwd: fx.project, windowsHide: true }).status, 0);
  const created = await fx.engine.create('Explicit new pool', { project: fx.project, concurrency: 5, mode: 'quick', model: model.model });
  assert.equal(created.config.concurrency, 5); assert.deepEqual(created.fixedModel, model);
  // Exercise mode selection without provider calls or worktree setup.
  fx.provider.assessTask = async () => ({ fallback: true });
  await fx.engine.prepare(created);
  assert.equal(created.config.concurrency, 5); assert.equal(created.executionMode.selected, 'quick');
  const lower = await fx.engine.create('Saved smaller pool', { project: fx.project });
  await fx.engine.prepare(lower); assert.equal(lower.config.concurrency, 1);
  const saved = fx.store.getRun(lower.id), previous = structuredClone(saved.executionMode);
  await writeFile(path.join(fx.project, 'kodo.config.json'), JSON.stringify({ concurrency: 5, executionMode: 'deep' }));
  await fx.engine.prepare(saved);
  assert.equal(saved.config.concurrency, 1); assert.deepEqual(saved.executionMode, previous);
  const projectFive = await fx.engine.create('Project explicit pool', { project: fx.project, mode: 'quick' });
  await fx.engine.prepare(projectFive); assert.equal(projectFive.config.concurrency, 5);
  const cliLower = await fx.engine.create('Explicit lower new pool', { project: fx.project, mode: 'quick', concurrency: 1 });
  await fx.engine.prepare(cliLower); assert.equal(cliLower.config.concurrency, 1);
  const env = { ...workerEnvironment(), KODO_HOME: path.join(fx.directory, 'cli-state'), KODO_CREDENTIAL_HOME: path.join(fx.directory, 'cli-credentials'), KODO_WORKTREE_HOME: path.join(fx.directory, 'cli-worktrees') };
  const cli = spawnSync(process.execPath, ['cli/index.mjs', 'run', 'Prepare an explicit five session pool', '--project', fx.project, '--mode', 'quick', '--concurrency', '5', '--prepare', '--json'], { cwd: root, env, encoding: 'utf8', windowsHide: true });
  assert.equal(cli.status, 0, cli.stderr || cli.stdout);
  const cliRun = JSON.parse(cli.stdout);
  assert.equal(cliRun.state, 'awaiting_plan'); assert.equal(cliRun.config.concurrency, 5); assert.equal(cliRun.executionMode.profile.concurrency, 5);
  const defaultsProject = path.join(fx.directory, 'defaults'); await mkdir(defaultsProject);
  for (const args of [['init', '-b', 'main'], ['config', 'user.name', 'Pool fixture'], ['config', 'user.email', 'pool@example.invalid'], ['commit', '--allow-empty', '-m', 'fixture']]) {
    assert.equal(spawnSync('git', args, { cwd: defaultsProject, windowsHide: true }).status, 0);
  }
  const defaultQuick = await fx.engine.create('Default quick pool', { project: defaultsProject, mode: 'quick' });
  await fx.engine.prepare(defaultQuick); assert.equal(defaultQuick.config.concurrency, 1);
  const legacy = await fx.engine.create('Legacy unselected quick pool', { project: defaultsProject, mode: 'quick' });
  delete legacy.requestedConcurrency;
  await fx.engine.prepare(legacy); assert.equal(legacy.config.concurrency, 1);
});

test('CLI rejects invalid pool limits and resume overrides before startup', () => {
  for (const args of [['run', 'task', '--concurrency', '0'], ['run', 'task', '--concurrency', '6'], ['run', 'task', '--concurrency', '1.5'], ['run', 'task', '--concurrency', '5', '--concurrency', '3'], ['resume', 'saved', '--concurrency', '5']]) {
    const result = spawnSync(process.execPath, ['cli/index.mjs', ...args, '--json'], { cwd: root, encoding: 'utf8', windowsHide: true });
    assert.notEqual(result.status, 0);
    assert.match(result.stdout + result.stderr, /concurrency|параметр/i);
    assert.doesNotMatch(result.stdout + result.stderr, /DPAPI|credentials|ENOENT|SQLITE/i);
  }
});

test('Five-slot sessions preserve fixed model boundary and release all leases on quota and cancellation', async t => {
  const fx = await fixture(t), quota = Object.assign(new Error('subscription quota'), { code: 'quota' });
  let calls = 0;
  fx.provider.runSession = async () => { calls++; throw quota; };
  for (const override of [{ client: 'claude-code', model: 'opus' }, { model: 'gpt-6-astra' }]) {
    await assert.rejects(fx.engine.session(fx.run, { ...model, ...override, cwd: fx.project, prompt: 'fixed boundary', readOnly: true }), { code: 'fixed_model' });
  }
  assert.equal(calls, 0);
  const settled = await Promise.allSettled(Array.from({ length: 5 }, () => fx.session(fx.run)));
  assert.ok(settled.every(row => row.status === 'rejected' && row.reason === quota));
  assert.equal(calls, 5); assert.equal(fx.run.sessionAttempts.length, 5);
  assert.ok(fx.run.sessionAttempts.every(row => row.status === 'failed' && row.errorCode === 'quota'));
  const controller = new AbortController(); controller.abort();
  await assert.rejects(fx.session(fx.run, controller.signal), { code: 'cancelled' });
  assert.equal(calls, 5);
  assert.equal(fx.store.db.prepare('SELECT count(*) AS count FROM leases').get().count, 0);
  const peer = new Store(fx.store.home);
  try {
    const token = fx.store.acquireLease(`run:${fx.run.id}`, fx.run.id);
    assert.ok(token); assert.equal(peer.acquireLease(`run:${fx.run.id}`, 'other-owner'), null);
    fx.store.releaseLease(token);
  } finally { peer.close(); }
});

test('Five-slot capacity obeys actual Jev routing threshold without bypassing serial decisions', async t => {
  const cases = [
    ...[0.72, 0.75].map(parallelConfidence => ({ mode: 'standard', fixed: false, parallelConfidence })),
    ...['standard', 'deep'].flatMap(mode => [0.72, 0.75].map(parallelConfidence => ({ mode, fixed: true, parallelConfidence })))
  ];
  for (const { mode, fixed, parallelConfidence } of cases) await t.test(`${mode} fixed ${fixed} parallelConfidence ${parallelConfidence}`, { timeout: 10000 }, async subtest => {
    const fx = await fixture(subtest), firstStarted = deferred(), allStarted = deferred(), release = deferred();
    if (!fixed) delete fx.run.fixedModel;
    fx.run.client = 'codex'; fx.run.config.client = 'codex';
    fx.run.executionMode = { selected: mode }; fx.run.models = [{ id: 'sol', ...model }, { id: 'astra', client: 'codex', model: 'gpt-6-astra' }];
    fx.run.plan.tasks = ['a', 'b', 'c', 'd', 'e'].map(id => task(id));
    const routed = [], routingModels = [], active = new Set(); let peak = 0;
    fx.provider.decideJev = async request => {
      routed.push(request.node.id);
      routingModels.push(request.models);
      if (fixed) assert.deepEqual(request.models, [{ id: 'sol', ...model }], 'scheduling receives only the exact fixed model');
      assert.equal(request.node.parallelismFacts.taskReady, true);
      assert.equal(request.node.parallelismFacts.planAllowsParallel, true);
      return { model: 'sol', confidence: 0.1, modelConfidence: fixed ? 0.1 : 0.9, parallelConfidence, parallel: true, sessionMode: 'fresh' };
    };
    fx.engine.recoverIntegrationEdits = async () => {};
    fx.provider.runSession = async request => {
      assert.equal(request.client, model.client); assert.equal(request.model, model.model);
      active.add(request.prompt); peak = Math.max(peak, active.size);
      firstStarted.resolve();
      if (active.size === 5) allStarted.resolve();
      try {
        if (parallelConfidence >= 0.75) await release.promise;
        else await turn();
        return { output: { complete: true } };
      } finally { active.delete(request.prompt); }
    };
    fx.engine.performNode = async (run, item, signal) => { await fx.session(run, signal, item.id); run.nodes[item.id].status = 'completed'; };
    fx.engine.integrateNode = async (run, item) => { run.nodes[item.id].status = 'integrated'; };
    const running = fx.engine.executeTasks(fx.run, subtest.signal);
    subtest.signal.addEventListener('abort', () => { release.resolve(); allStarted.resolve(); }, { once: true });
    try { await firstStarted.promise; assert.ok(routed.length > 0, 'standard/deep fixed model must still assess scheduling'); if (parallelConfidence >= 0.75) { await allStarted.promise; assert.equal(active.size, 5); } }
    finally { release.resolve(); await running; }
    assert.equal(peak, parallelConfidence >= 0.75 ? 5 : 1);
    assert.deepEqual(routed, ['a', 'b', 'c', 'd', 'e']);
    if (fixed) for (const models of routingModels) assert.deepEqual(models, [{ id: 'sol', ...model }]);
    assert.equal(fx.run.config.concurrency, 5);
    assert.ok(fx.run.plan.tasks.every(item => fx.run.nodes[item.id].routing.parallel === (parallelConfidence >= 0.75)));
    assert.ok(fx.run.plan.tasks.every(item => fx.run.nodes[item.id].routing.model === 'sol' && !fx.run.nodes[item.id].escalation));
  });
});

test('Fixed-model scheduling retries and Jev failure retain the exact model without escalation', async t => {
  const fx = await fixture(t), item = task('retry');
  fx.run.client = 'codex'; fx.run.config.primaryModel = 'gpt-6-astra';
  fx.run.executionMode = { selected: 'deep' }; fx.run.plan.tasks = [item];
  fx.run.models = [{ id: 'sol', ...model }, { id: 'astra', client: 'codex', model: 'gpt-6-astra' }];
  const requests = [], sessions = [], state = fx.run.nodes.retry = { id: 'retry', attempt: 0 };
  fx.provider.decideJev = async request => {
    requests.push(request);
    return { model: 'sol', parallel: true, confidence: 0.1, modelConfidence: 0.1, parallelConfidence: 0.95 };
  };
  fx.provider.runSession = async request => { sessions.push([request.client, request.model]); return { output: { complete: true } }; };
  for (const attempt of [0, 1]) {
    state.attempt = attempt;
    const selected = await fx.engine.route(fx.run, item, state);
    assert.equal(selected.id, 'sol'); assert.equal(state.routing.parallel, true); assert.equal(state.escalation, undefined);
    await fx.engine.session(fx.run, { ...selected, cwd: fx.project, prompt: `attempt ${attempt}`, readOnly: true });
  }
  assert.deepEqual(requests.map(request => request.attempt), [0, 1]);
  for (const request of requests) assert.deepEqual(request.models, [{ id: 'sol', ...model }]);
  fx.provider.decideJev = async () => { throw Object.assign(new Error('Jev unavailable'), { code: 'unavailable' }); };
  assert.equal((await fx.engine.route(fx.run, item, state)).id, 'sol');
  assert.equal(state.routing.parallel, false); assert.equal(state.escalation, undefined);
  await fx.session(fx.run);
  fx.provider.decideJev = async () => ({ model: 'astra', confidence: 1, parallel: true });
  await assert.rejects(fx.engine.route(fx.run, item, state), /недоступную модель/);
  assert.deepEqual(sessions, Array.from({ length: 3 }, () => ['codex', 'gpt-6.1-sol']));
  assert.equal(fx.store.events(fx.run.id).filter(event => event.type === 'model_escalated').length, 0);
});
