import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm, utimes } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { readConfig } from '../runtime/config.mjs';
import { Engine } from '../runtime/engine.mjs';
import { Store } from '../runtime/store.mjs';

test('Repair budget defaults to five preserves explicit lower limits and rejects outside one through five', async t => {
  const project = await mkdtemp(path.join(os.tmpdir(), 'kodo-budget-'));
  t.after(async () => {
    assert.equal(path.dirname(project), path.resolve(os.tmpdir()));
    await rm(project, { recursive: true, force: true });
  });
  const initial = await readConfig(project);
  assert.equal(initial.repairRounds, 5);
  assert.equal(initial.uiVerification.enabled, false);
  assert.equal(initial.security.enabled, false);
  for (const budget of [1, 2, 3, 4, 5]) {
    await writeFile(path.join(project, 'kodo.config.json'), JSON.stringify({ repairRounds: budget }));
    assert.equal((await readConfig(project)).repairRounds, budget);
  }
  for (const budget of [0, 6, 1.5, '5', null]) {
    await writeFile(path.join(project, 'kodo.config.json'), JSON.stringify({ repairRounds: budget }));
    await assert.rejects(readConfig(project), /конфигурация/);
  }
});

async function nodeBudgetFixture(t, limit, { untracked = false } = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'kodo-node-budget-'));
  const project = path.join(directory, 'project'),
    home = path.join(directory, 'state');
  let store;
  t.after(async () => {
    store?.close();
    assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(directory).startsWith('kodo-node-budget-'));
    await rm(directory, { recursive: true, force: true });
  });
  await mkdir(path.join(project, 'src'), { recursive: true });
  await writeFile(path.join(project, 'src/value.mjs'), 'export const value = 0;\n');
  await writeFile(
    path.join(project, 'kodo.config.json'),
    JSON.stringify({
      repairRounds: limit,
      researchBudget: 0,
      commands: { test: [{ command: process.execPath, args: ['-e', 'process.exit(0)'] }] },
    }),
  );
  const git = (...args) => {
    const result = spawnSync('git', args, { cwd: project, encoding: 'utf8', windowsHide: true });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  git('init', '-b', 'main');
  git('config', 'user.name', 'Budget Fixture');
  git('config', 'user.email', 'budget@example.invalid');
  git('config', 'commit.gpgSign', 'false');
  git('add', '.');
  git('commit', '-m', 'Baseline');
  const baseSha = git('rev-parse', 'HEAD'),
    config = await readConfig(project);
  const secret = 'budget-provider-private-fixture';
  store = new Store(home, { GEMINI_API_KEY: secret });
  const workerFile = untracked ? 'src/new.mjs' : 'src/value.mjs';
  const requests = [],
    task = {
      id: 'feature',
      role: 'developer',
      description: 'Implement ' + workerFile,
      writePaths: [workerFile],
      acceptance: ['Keep the value finite', 'Interface: value is a number', 'Constraint: Subscription only'],
      dependsOn: [],
      parallel: false,
    };
  const provider = {
    discoverProviders: async () => [
      { id: 'subscription-fixture', client: 'codex', model: 'gpt-6.1-sol', available: true },
    ],
    decideJev: async () => ({ model: 'subscription-fixture', parallel: false, confidence: 1, sessionMode: 'fresh' }),
    runSession: async request => {
      requests.push(request);
      assert.equal(request.readOnly, undefined, 'incomplete nodes must never reach review');
      await writeFile(path.join(request.cwd, workerFile), `export const value = ${requests.length};\n`);
      return {
        sessionId: `budget-fixture-${requests.length}`,
        output: { summary: 'The same acceptance requirement remains unresolved', checks: [], complete: false },
      };
    },
  };
  const run = store.createRun({
    task: 'Complete the value feature',
    project,
    config,
    baseSha,
    client: 'codex',
    providers: 'current',
    completed: { analysis: true },
    analysis: {
      summary: 'Value feature',
      standards: 'INHERITED_STANDARDS_SENTINEL'.repeat(4000),
      history: 'RAW_HISTORY_SENTINEL',
    },
    research: {
      requests: 0,
      cache: [],
      errors: [],
      items: [{ title: 'src/value.mjs', url: 'https://example.invalid/src/value.mjs', body: 'RAW_RESEARCH_SENTINEL' }],
    },
    plan: { summary: 'Implement the finite value', tasks: [task] },
    nodes: {},
  });
  const worktreeRoot = path.join(directory, 'worktrees');
  Object.assign(run, {
    artifacts: path.join(home, 'runs', run.id),
    worktreeRoot,
    cwd: path.join(worktreeRoot, 'integration'),
    branch: `kodo/${run.id}`,
  });
  store.updateRun(run.id, run);
  const engine = new Engine({
    store,
    provider,
    secrets: { GEMINI_API_KEY: secret },
    researcher: async () => {
      throw new Error('No research budget: no service may be contacted');
    },
    tools: { resolveTool: async id => ({ id, ready: false }) },
  });
  return { engine, store, run, requests, project, baseSha, secret, git };
}

test('Engine preserves an explicit two-round node budget and retry history without rerunning on ordinary resume', async t => {
  const fx = await nodeBudgetFixture(t, 2);
  const blocked = await fx.engine.run(fx.run.id);
  assert.equal(blocked.state, 'blocked');
  assert.equal(fx.requests.length, 2);
  assert.equal(blocked.nodes.feature.attempt, 2);
  assert.equal(blocked.nodes.feature.stopped, 'repair_budget_exhausted');
  assert.equal(blocked.controllerAssessment.attempts, 2);
  assert.equal(blocked.controllerAssessment.limit, 2);
  assert.equal(blocked.controllerAssessment.automaticRetries, false);
  assert.match(blocked.controllerAssessment.summary, /acceptance requirement remains unresolved/);
  const workerCwd = blocked.nodes.feature.cwd;
  assert.equal(await readFile(path.join(workerCwd, 'src/value.mjs'), 'utf8'), 'export const value = 2;\n');
  await fx.engine.run(fx.run.id);
  assert.equal(fx.requests.length, 2);
  const retried = await fx.engine.run(fx.run.id, { retryFailed: true });
  assert.equal(fx.requests.length, 4);
  assert.equal(retried.nodes.feature.cwd, workerCwd);
  assert.equal(retried.nodes.feature.previousAttempts, 2);
  assert.equal(retried.nodes.feature.previousCycles[0].attempt, 2);
  assert.equal(retried.nodes.feature.previousCycles[0].stopped, 'repair_budget_exhausted');
  assert.equal(fx.store.events(fx.run.id).filter(event => event.type === 'retry_requested').length, 1);
  assert.equal(await readFile(path.join(workerCwd, 'src/value.mjs'), 'utf8'), 'export const value = 4;\n');
  assert.equal(fx.git('rev-parse', 'HEAD'), fx.baseSha, 'the caller repository must stay unchanged');
});

test('Engine counts changed contents of the same uncommitted file as progress through the fifth node round', async t => {
  const fx = await nodeBudgetFixture(t, 5);
  const blocked = await fx.engine.run(fx.run.id);
  assert.equal(blocked.state, 'blocked');
  const saved = fx.store.getRun(fx.run.id);
  assert.deepEqual(
    { workers: fx.requests.length, attempts: saved.nodes.feature.attempt, reason: saved.controllerAssessment.reason },
    { workers: 5, attempts: 5, reason: 'repair_budget_exhausted' },
    'different file contents are progress even when HEAD, porcelain status and unresolved requirement are identical',
  );
  assert.equal(saved.nodes.feature.attempt, 5);
  assert.equal(saved.nodes.feature.stopped, 'repair_budget_exhausted');
  assert.equal(saved.controllerAssessment.attempts, 5);
  assert.equal(saved.controllerAssessment.reason, 'repair_budget_exhausted');
  assert.equal(saved.controllerAssessment.automaticRetries, false);
  assert.equal(
    await readFile(path.join(saved.nodes.feature.cwd, 'src/value.mjs'), 'utf8'),
    'export const value = 5;\n',
  );
  await fx.engine.run(fx.run.id);
  assert.equal(fx.requests.length, 5);
});

test('Engine worker requests preserve scoped acceptance while omitting inherited histories and provider keys', async t => {
  const fx = await nodeBudgetFixture(t, 1);
  const blocked = await fx.engine.run(fx.run.id);
  assert.equal(blocked.state, 'blocked');
  assert.equal(fx.requests.length, 1);
  const request = fx.requests[0];
  for (const expected of ['src/value.mjs', 'Keep the value finite', 'value is a number', 'Subscription only'])
    assert.ok(request.prompt.includes(expected), expected);
  for (const excluded of ['INHERITED_STANDARDS_SENTINEL', 'RAW_HISTORY_SENTINEL', 'RAW_RESEARCH_SENTINEL', fx.secret])
    assert.ok(!request.prompt.includes(excluded), excluded);
  for (const key of [
    'GEMINI_API_KEY',
    'TYPESAFE_API_KEY',
    'OPENAI_API_KEY',
    'ANTHROPIC_API_KEY',
    'BROWSER_USE_API_KEY',
  ])
    assert.equal(request.env[key], undefined, key);
  assert.equal(fx.store.getRun(fx.run.id).controllerAssessment.reason, 'repair_budget_exhausted');
});

test('Engine counts changing contents of a new untracked file as progress within the explicit budget', async t => {
  const fx = await nodeBudgetFixture(t, 3, { untracked: true });
  const blocked = await fx.engine.run(fx.run.id);
  assert.equal(blocked.state, 'blocked');
  assert.equal(fx.requests.length, 3);
  assert.equal(blocked.nodes.feature.stopped, 'repair_budget_exhausted');
  assert.equal(
    await readFile(path.join(blocked.nodes.feature.cwd, 'src/new.mjs'), 'utf8'),
    'export const value = 3;\n',
  );
});

test('Engine progress fingerprint ignores timestamp-only rewrites but detects changed untracked bytes', async t => {
  const fx = await nodeBudgetFixture(t, 3, { untracked: true });
  const file = path.join(fx.project, 'src/new.mjs');
  await writeFile(file, 'export const value = 1;\n');
  const first = await fx.engine.failureFingerprint(fx.project);
  await utimes(file, new Date(0), new Date(1000));
  assert.deepEqual(await fx.engine.failureFingerprint(fx.project), first);
  await writeFile(file, 'export const value = 2;\n');
  await utimes(file, new Date(0), new Date(1000));
  assert.notDeepEqual(await fx.engine.failureFingerprint(fx.project), first);
});
