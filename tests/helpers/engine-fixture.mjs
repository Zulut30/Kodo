import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile, rm, access } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Engine } from '../../runtime/engine.mjs';
import { Store } from '../../runtime/store.mjs';
import { makeWorktree } from '../../runtime/workspace.mjs';

const read = filename => readFile(filename, 'utf8');

async function exists(filename) { try { await access(filename); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; } }

function git(cwd, ...args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true });
  assert.equal(result.status, 0, `${args.join(' ')}\n${result.stderr}`);
  return result.stdout.trim();
}

async function fixture(t, { config: overrides = {}, testScript, remote = false } = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'kodo-engine-test-'));
  const project = path.join(directory, 'project');
  const home = path.join(directory, 'state');
  const stores = new Set();
  t.after(async () => {
    for (const store of stores) store.close();
    const resolved = path.resolve(directory);
    assert.equal(path.dirname(resolved), path.resolve(os.tmpdir()));
    assert.ok(path.basename(resolved).startsWith('kodo-engine-test-'));
    await rm(resolved, { recursive: true, force: true });
  });
  await mkdir(path.join(project, 'src'), { recursive: true });
  // Mock workers assert exact LF bytes after Git checks out dependent worktrees.
  await writeFile(path.join(project, '.gitattributes'), '* text=auto eol=lf\n');
  await writeFile(path.join(project, 'src/value.mjs'), 'export const value = 0;\n');
  await writeFile(path.join(project, 'untouched.txt'), 'committed content\n');
  await writeFile(path.join(project, 'shared.txt'), 'base\n');
  await writeFile(path.join(project, 'verify.mjs'), testScript || "import './tests/check.mjs';\n");
  const config = {
    schemaVersion: 1, repository: 'fixture/Kodo', client: 'codex', baseBranch: 'main', concurrency: 2, repairRounds: 1,
    researchBudget: 4, commands: { test: [{ command: process.execPath, args: ['verify.mjs'] }], build: [], deploy: [], smoke: [] },
    checks: [], delivery: { enabled: remote, release: remote, firstVersion: '0.2.0' }, ...overrides
  };
  await writeFile(path.join(project, 'kodo.config.json'), JSON.stringify(config, null, 2));
  git(project, 'init', '-b', 'main');
  git(project, 'config', 'user.name', 'Kodo Engine Test');
  git(project, 'config', 'user.email', 'kodo-engine@example.invalid');
  git(project, 'config', 'core.autocrlf', 'false');
  git(project, 'add', '.');
  git(project, 'commit', '-m', 'Fixture baseline');
  const base = git(project, 'rev-parse', 'HEAD');
  if (remote) {
    const origin = path.join(directory, 'origin.git');
    git(directory, 'init', '--bare', origin);
    git(project, 'remote', 'add', 'origin', origin);
    git(project, 'push', '-u', 'origin', 'main');
  }
  const openStore = () => { const store = new Store(home); stores.add(store); return store; };
  const closeStore = store => { store.close(); stores.delete(store); };
  return { directory, project, home, base, openStore, closeStore };
}

function node(id, role, writePaths, dependsOn = [], description = id) {
  return { id, role, writePaths, dependsOn, description, acceptance: [`${id} meets its public requirement`], parallel: true };
}

const featurePlan = () => ({
  summary: 'Expose value two with a meaningful test and usage documentation.',
  tasks: [
    node('feature', 'developer', ['src/value.mjs']),
    node('feature-tests', 'tester', ['tests/check.mjs'], ['feature']),
    node('feature-docs', 'documenter', ['docs/usage.md'], ['feature'])
  ]
});

function fakeServices({ plan = featurePlan(), onWorker, onReview, onDiscover } = {}) {
  const calls = { analysis: 0, research: 0, planner: 0, worker: [], review: [], delivery: 0, release: 0, decisions: [] };
  const provider = {
    analyzeGemini: async ({ files }) => { calls.analysis++; return { summary: 'Fixture exposes a value module.', files: files.map(file => file.path), limitations: [], model: 'gemini-fixture' }; },
    discoverProviders: async (...args) => {
      if (onDiscover) await onDiscover(...args);
      return [
        { id: 'codex-sol', client: 'codex', model: 'gpt-6.1-sol', available: true },
        { id: 'codex-astra', client: 'codex', model: 'gpt-6-astra', available: true }
      ];
    },
    decideJev: async ({ node: task, attempt }) => {
      calls.decisions.push({ id: task.id, attempt });
      return { model: 'codex-sol', parallel: true, confidence: 0.95, sessionMode: 'fresh' };
    },
    runSession: async request => {
      if (request.schema.properties.tasks) { calls.planner++; return { sessionId: 'planner-fixture', output: plan }; }
      if (request.schema.properties.passed) {
        calls.review.push(request);
        return onReview ? onReview(request, calls) : { sessionId: `review-${calls.review.length}`, output: { passed: true, findings: [] } };
      }
      const role = /Complete this (developer|tester|documenter) task/.exec(request.prompt)?.[1];
      const call = { ...request, role };
      calls.worker.push(call);
      if (onWorker) return onWorker(call, calls);
      if (role === 'developer') await writeFile(path.join(request.cwd, 'src/value.mjs'), 'export const value = 2;\n');
      if (role === 'tester') {
        assert.equal(await read(path.join(request.cwd, 'src/value.mjs')), 'export const value = 2;\n', 'tester must observe the integrated developer result');
        await mkdir(path.join(request.cwd, 'tests'), { recursive: true });
        await writeFile(path.join(request.cwd, 'tests/check.mjs'), "import assert from 'node:assert/strict';\nimport { value } from '../src/value.mjs';\nassert.equal(value, 2);\n");
      }
      if (role === 'documenter') {
        assert.equal(await read(path.join(request.cwd, 'src/value.mjs')), 'export const value = 2;\n', 'documenter must describe the implemented behavior');
        await mkdir(path.join(request.cwd, 'docs'), { recursive: true });
        await writeFile(path.join(request.cwd, 'docs/usage.md'), 'The value export is 2.\n');
      }
      const sessionId = `worker-${role}-${calls.worker.length}`;
      request.onEvent({ sessionId });
      return { sessionId, output: { summary: `${role} completed`, checks: ['fixture requirement checked'], complete: true } };
    }
  };
  const researcher = async () => { calls.research++; return { items: [], requests: 1, errors: [], cache: [] }; };
  const delivery = {
    deliver: async ({ run, review }) => {
      calls.delivery++;
      assert.equal(review.headSha, run.headSha);
      assert.equal(review.passed, true);
      assert.equal(run.checks.headSha, run.headSha);
      return { pr: { number: 1, url: 'https://example.invalid/pull/1' }, mergeCommit: run.headSha };
    },
    releasePackage: async ({ mergeCommit }) => { calls.release++; return { version: '0.2.0', commit: mergeCommit, url: 'https://example.invalid/releases/v0.2.0' }; }
  };
  return { provider, researcher, delivery, calls };
}

async function integrationConflict(t, resolver, secrets = {}) {
  const fx = await fixture(t, { testScript: 'process.exit(0);\n' });
  const tasks = [node('first', 'developer', ['src/value.mjs']), node('second', 'developer', ['src/value.mjs'])];
  const plan = { summary: 'Preserve both independent changes to the value module.', tasks };
  const services = fakeServices({ plan, onWorker: resolver });
  const store = fx.openStore(), engine = new Engine({ store, secrets, ...services });
  const run = await engine.create('Preserve both changes', { project: fx.project });
  await engine.prepare(run);
  run.plan = plan;
  run.models = await services.provider.discoverProviders();
  for (const [index, task] of tasks.entries()) {
    const cwd = path.join(store.home, 'worktrees', run.id, task.id);
    const branch = `kodo/${run.id}-${task.id}`;
    await makeWorktree(fx.project, cwd, branch, fx.base);
    await writeFile(path.join(cwd, 'src/value.mjs'), `export const value = ${index + 2};\nexport const ${task.id}Change = true;\n`);
    git(cwd, 'add', 'src/value.mjs'); git(cwd, 'commit', '-m', `${task.id} independent change`);
    run.nodes[task.id] = { id: task.id, attempt: 1, status: 'completed', cwd, branch, baseSha: fx.base, headSha: git(cwd, 'rev-parse', 'HEAD') };
  }
  engine.save(run);
  await engine.integrateNode(run, tasks[0]);
  return { ...fx, engine, store, run, tasks, services };
}

const combinedModule = 'export const value = 2;\nexport const firstChange = true;\nexport const secondChange = true;\n';

async function refreshFixture(t, onWorker, conflict = false) {
  const fx = await fixture(t, { testScript: 'process.exit(0);\n' });
  const task = node('feature', 'developer', ['src/value.mjs']);
  const services = fakeServices({ plan: { summary: 'Retain own change and upstream', tasks: [task] }, onWorker });
  const store = fx.openStore(), engine = new Engine({ store, ...services });
  const run = await engine.create('Refresh interrupted task safely', { project: fx.project }); await engine.prepare(run);
  run.plan = { summary: 'Retain own change and upstream', tasks: [task] }; run.models = await services.provider.discoverProviders();
  const cwd = path.join(path.dirname(run.cwd), task.id), branch = `kodo/${run.id}-${task.id}`;
  await makeWorktree(fx.project, cwd, branch, fx.base);
  await writeFile(path.join(cwd, 'src/value.mjs'), 'export const value = 2;\n'); git(cwd, 'add', '.'); git(cwd, 'commit', '-m', 'Scoped pending work');
  if (conflict) await writeFile(path.join(run.cwd, 'src/value.mjs'), 'export const value = 4;\nexport const upstream = true;\n');
  await writeFile(path.join(run.cwd, 'upstream-fix.txt'), 'incoming outside task scope\n'); git(run.cwd, 'add', '.'); git(run.cwd, 'commit', '-m', 'Upstream integrated fix');
  const target = git(run.cwd, 'rev-parse', 'HEAD');
  run.nodes.feature = { id: task.id, attempt: 0, status: 'pending', cwd, branch, baseSha: fx.base };
  engine.save(run); return { ...fx, task, services, store, engine, run, target, cwd };
}

export { read, exists, git, fixture, node, featurePlan, fakeServices, integrationConflict, combinedModule, refreshFixture };
