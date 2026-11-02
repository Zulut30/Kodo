import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile, rm, access } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Engine } from '../runtime/engine.mjs';
import { Store } from '../runtime/store.mjs';

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
      return { model: 'codex-sol', parallel: true, confidence: 0.95, sessionMode: 'separate' };
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

test('Engine integrates developer tester and documenter work with independent review and preserves dirty input', async t => {
  const fx = await fixture(t, { remote: true });
  await writeFile(path.join(fx.project, 'untouched.txt'), 'user local edit\n');
  await writeFile(path.join(fx.project, 'notes.txt'), 'user untracked note\n');
  const originalStatus = git(fx.project, 'status', '--porcelain');
  const services = fakeServices(), store = fx.openStore();
  const engine = new Engine({ store, ...services });
  const run = await engine.create('Implement value two', { project: fx.project });
  const result = await engine.run(run.id);
  assert.equal(result.state, 'succeeded', result.error?.message);
  assert.deepEqual(Object.values(result.nodes).map(item => item.status), ['integrated', 'integrated', 'integrated']);
  assert.equal(await read(path.join(result.cwd, 'src/value.mjs')), 'export const value = 2;\n');
  assert.match(await read(path.join(result.cwd, 'tests/check.mjs')), /assert.equal\(value, 2\)/);
  assert.equal(await read(path.join(result.cwd, 'docs/usage.md')), 'The value export is 2.\n');
  assert.equal(result.checks.results[0].exitCode, 0);
  assert.deepEqual(services.calls.worker.map(item => item.role).sort(), ['developer', 'documenter', 'tester']);
  assert.equal(services.calls.review.length, 1);
  assert.equal(services.calls.review[0].readOnly, true);
  assert.equal(services.calls.review[0].model, 'gpt-6-astra');
  assert.equal(services.calls.review[0].sessionId, undefined);
  assert.equal(result.review.headSha, result.headSha);
  assert.equal(services.calls.delivery, 1);
  assert.equal(services.calls.release, 1);
  assert.equal(result.release.commit, result.headSha);
  assert.equal(git(fx.project, 'rev-parse', 'HEAD'), fx.base);
  assert.equal(git(fx.project, 'status', '--porcelain'), originalStatus);
  assert.equal(await read(path.join(fx.project, 'untouched.txt')), 'user local edit\n');
  assert.equal(await read(path.join(fx.project, 'notes.txt')), 'user untracked note\n');
  assert.equal(await read(path.join(fx.project, 'src/value.mjs')), 'export const value = 0;\n');
});

test('Engine prepares once and resumes a host plan after reopening state without repeating completed work', async t => {
  const fx = await fixture(t), services = fakeServices();
  const firstStore = fx.openStore();
  const firstEngine = new Engine({ store: firstStore, ...services });
  const run = await firstEngine.create('Implement value two', { project: fx.project });
  const prepared = await firstEngine.run(run.id, { prepare: true });
  assert.equal(prepared.state, 'awaiting_plan');
  assert.equal(services.calls.analysis, 1);
  assert.equal(services.calls.research, 1);
  assert.equal(services.calls.planner, 0);
  assert.equal(services.calls.worker.length, 0);
  assert.equal(await exists(path.join(prepared.artifacts, 'plan.schema.json')), true);
  const planFile = path.join(prepared.artifacts, 'host-plan.json');
  await writeFile(planFile, JSON.stringify(featurePlan()));
  fx.closeStore(firstStore);
  const engine = new Engine({ store: fx.openStore(), ...services });
  const result = await engine.run(run.id, { planFile });
  assert.equal(result.state, 'succeeded', result.error?.message);
  assert.equal(result.planSource, 'host');
  assert.equal(services.calls.planner, 0);
  assert.equal(services.calls.analysis, 1);
  assert.equal(services.calls.research, 1);
  assert.equal(services.calls.worker.length, 3);
  const before = { workers: services.calls.worker.length, review: services.calls.review.length };
  const repeated = await engine.run(run.id);
  assert.equal(repeated.headSha, result.headSha);
  assert.equal(services.calls.worker.length, before.workers);
  assert.equal(services.calls.review.length, before.review);
  assert.equal(services.calls.analysis, 1);
});

test('Engine waits for quota then resumes the exact recorded worker session', async t => {
  const fx = await fixture(t, { testScript: "import assert from 'node:assert/strict'; import {value} from './src/value.mjs'; assert.equal(value, 2);\n" });
  const plan = { summary: 'Set value two.', tasks: [node('feature', 'developer', ['src/value.mjs'])] };
  let quota = true;
  const services = fakeServices({ plan, onWorker: async request => {
    if (quota) {
      quota = false;
      request.onEvent({ sessionId: 'quota-worker-exact-session' });
      throw Object.assign(new Error('fixture quota reached'), { code: 'quota', retryAt: '2030-01-01T00:00:00Z' });
    }
    assert.equal(request.sessionId, 'quota-worker-exact-session');
    await writeFile(path.join(request.cwd, 'src/value.mjs'), 'export const value = 2;\n');
    return { sessionId: request.sessionId, output: { summary: 'value implemented', checks: [], complete: true } };
  } });
  const store = fx.openStore(), engine = new Engine({ store, ...services });
  const run = await engine.create('Implement value two', { project: fx.project });
  const waiting = await engine.run(run.id);
  assert.equal(waiting.state, 'waiting_limits');
  assert.equal(waiting.nodes.feature.sessionId, 'quota-worker-exact-session');
  assert.equal(waiting.nodes.feature.attempt, 0);
  assert.equal(services.calls.review.length, 0);
  const resumed = await engine.run(run.id);
  assert.equal(resumed.state, 'succeeded', resumed.error?.message);
  assert.equal(services.calls.analysis, 1);
  assert.equal(services.calls.planner, 1);
  assert.equal(services.calls.worker.length, 2);
  assert.equal(resumed.nodes.feature.sessionId, 'quota-worker-exact-session');
  assert.equal(resumed.error, null, 'a resumed successful run must clear the old quota error');
});

test('Engine rejects out of scope edits before integration and preserves the original project', async t => {
  const fx = await fixture(t, { testScript: 'process.exit(0);\n' });
  const plan = { summary: 'Set value two.', tasks: [node('feature', 'developer', ['src/value.mjs'])] };
  const services = fakeServices({ plan, onWorker: async request => {
    await writeFile(path.join(request.cwd, 'forbidden.txt'), 'outside owned files\n');
    return { sessionId: 'out-of-scope-session', output: { summary: 'done', checks: [], complete: true } };
  } });
  const store = fx.openStore(), engine = new Engine({ store, ...services });
  const run = await engine.create('Implement value two', { project: fx.project });
  const result = await engine.run(run.id);
  assert.equal(result.state, 'blocked');
  assert.match(result.error.message, /вне области задачи: forbidden.txt/);
  assert.notEqual(result.nodes.feature.status, 'integrated');
  assert.equal(services.calls.review.length, 0);
  assert.equal(services.calls.delivery, 0);
  assert.equal(await exists(path.join(result.cwd, 'forbidden.txt')), false);
  assert.equal(await exists(path.join(fx.project, 'forbidden.txt')), false);
  assert.equal(git(fx.project, 'rev-parse', 'HEAD'), fx.base);
  assert.equal(git(fx.project, 'status', '--porcelain'), '');
});

test('Engine cancellation interrupts a running worker without starting review or delivery', async t => {
  const fx = await fixture(t, { testScript: 'process.exit(0);\n' }), controller = new AbortController();
  const plan = { summary: 'Set value two.', tasks: [node('feature', 'developer', ['src/value.mjs'])] };
  const services = fakeServices({ plan, onWorker: async request => {
    request.onEvent({ sessionId: 'cancelled-worker-session' });
    controller.abort();
    assert.equal(request.signal.aborted, true);
    throw Object.assign(new Error('fixture cancelled'), { code: 'cancelled' });
  } });
  const store = fx.openStore(), engine = new Engine({ store, ...services });
  const run = await engine.create('Implement value two', { project: fx.project });
  const result = await engine.run(run.id, { signal: controller.signal });
  assert.equal(result.state, 'cancelled');
  assert.equal(result.error.code, 'cancelled');
  assert.equal(services.calls.worker.length, 1);
  assert.equal(services.calls.review.length, 0);
  assert.equal(services.calls.delivery, 0);
  const again = await engine.run(run.id);
  assert.equal(again.state, 'cancelled');
  assert.equal(services.calls.worker.length, 1);
  assert.equal(git(fx.project, 'rev-parse', 'HEAD'), fx.base);
  assert.equal(await read(path.join(fx.project, 'src/value.mjs')), 'export const value = 0;\n');
});

test('Engine serializes two ready tasks with overlapping write scopes even when Jev permits parallel work', async t => {
  const script = "import assert from 'node:assert/strict'; import {readFileSync} from 'node:fs'; assert.equal(readFileSync('shared.txt','utf8'), 'base\\nfirst\\nsecond\\n');\n";
  const fx = await fixture(t, { testScript: script });
  const plan = { summary: 'Append two lines in order.', tasks: [
    node('first', 'developer', ['shared.txt'], [], 'append first'),
    node('second', 'developer', ['shared.txt'], [], 'append second')
  ] };
  let active = 0, maxActive = 0;
  const sequence = [];
  const services = fakeServices({ plan, onWorker: async request => {
    const label = /Your task: append (first|second)/.exec(request.prompt)?.[1];
    assert.ok(label);
    active++; maxActive = Math.max(maxActive, active); sequence.push(`start-${label}`);
    try {
      await new Promise(resolve => setImmediate(resolve));
      const filename = path.join(request.cwd, 'shared.txt');
      const before = await read(filename);
      assert.equal(before, label === 'first' ? 'base\n' : 'base\nfirst\n');
      await writeFile(filename, `${before}${label}\n`);
      sequence.push(`finish-${label}`);
      return { sessionId: `append-${label}`, output: { summary: `appended ${label}`, checks: [], complete: true } };
    } finally { active--; }
  } });
  const engine = new Engine({ store: fx.openStore(), ...services });
  const run = await engine.create('Append first and second', { project: fx.project });
  const result = await engine.run(run.id);
  assert.equal(result.state, 'succeeded', result.error?.message);
  assert.equal(maxActive, 1);
  assert.deepEqual(sequence, ['start-first', 'finish-first', 'start-second', 'finish-second']);
  assert.equal(await read(path.join(result.cwd, 'shared.txt')), 'base\nfirst\nsecond\n');
  assert.equal(await read(path.join(fx.project, 'shared.txt')), 'base\n');
});

test('Engine rejects a staged rename that deletes an unowned source path', async t => {
  const fx = await fixture(t, { testScript: 'process.exit(0);\n' });
  git(fx.project, 'mv', 'untouched.txt', 'src/renamed.txt');
  const engine = new Engine({ store: fx.openStore() });
  await assert.rejects(engine.checkScope(fx.project, fx.base, ['src/renamed.txt']), /вне области задачи: untouched.txt/);
});

test('Engine uses one routing decision per attempt so parallel admission matches execution', async t => {
  const fx = await fixture(t, { testScript: "import assert from 'node:assert/strict'; import {readFileSync} from 'node:fs'; assert.equal(readFileSync('first.txt','utf8'),'first\\n'); assert.equal(readFileSync('second.txt','utf8'),'second\\n');\n" });
  const plan = { summary: 'Create two independent files.', tasks: [
    node('first', 'developer', ['first.txt'], [], 'write first'),
    node('second', 'developer', ['second.txt'], [], 'write second')
  ] };
  const decisions = new Map();
  let active = 0, maxActive = 0;
  const services = fakeServices({ plan, onWorker: async request => {
    const label = /Your task: write (first|second)/.exec(request.prompt)?.[1];
    active++; maxActive = Math.max(maxActive, active);
    try {
      await new Promise(resolve => setImmediate(resolve));
      await writeFile(path.join(request.cwd, `${label}.txt`), `${label}\n`);
      return { sessionId: `independent-${label}`, output: { summary: `created ${label}`, checks: [], complete: true } };
    } finally { active--; }
  } });
  services.provider.decideJev = async ({ node: task }) => {
    const count = (decisions.get(task.id) || 0) + 1;
    decisions.set(task.id, count);
    if (count > 1) throw Object.assign(new Error('routing is unavailable after admission'), { code: 'unavailable' });
    return { model: 'codex-sol', parallel: true, confidence: 0.95, sessionMode: 'separate' };
  };
  const engine = new Engine({ store: fx.openStore(), ...services });
  const run = await engine.create('Create two independent files', { project: fx.project });
  const result = await engine.run(run.id);
  assert.equal(result.state, 'succeeded', result.error?.message);
  const fallbackNodes = Object.values(result.nodes).filter(item => item.routing.fallback);
  assert.ok(!fallbackNodes.length || maxActive === 1, 'fallback serial routing must not run an already admitted concurrent batch');
  assert.deepEqual(Object.fromEntries(decisions), { first: 1, second: 1 });
});

test('Engine treats cancellation during the final check attempt as cancellation instead of a repair blocker', async t => {
  const fx = await fixture(t, { testScript: 'setTimeout(() => process.exit(0), 10000);\n' });
  const plan = { summary: 'Set value two.', tasks: [node('feature', 'developer', ['src/value.mjs'])] };
  const services = fakeServices({ plan }), controller = new AbortController();
  const engine = new Engine({ store: fx.openStore(), ...services, onEvent: event => { if (event.type === 'check_started') controller.abort(); } });
  const run = await engine.create('Implement value two', { project: fx.project });
  const result = await engine.run(run.id, { signal: controller.signal });
  assert.equal(result.state, 'cancelled', result.error?.message);
  assert.equal(result.error.code, 'cancelled');
  assert.equal(services.calls.review.length, 0);
  assert.equal(services.calls.worker.length, 1);
  assert.equal(services.calls.delivery, 0);
});

test('Engine resolves target branch conflicts then invalidates checks and review before redelivery', async t => {
  const fx = await fixture(t, { remote: true, config: { repairRounds: 2, delivery: { enabled: true, release: false } }, testScript: "import assert from 'node:assert/strict'; import {value} from './src/value.mjs'; assert.equal(value, 2);\n" });
  const plan = { summary: 'Set value two.', tasks: [node('feature', 'developer', ['src/value.mjs'])] };
  let conflictResolutions = 0, upstreamSha;
  const services = fakeServices({ plan, onWorker: async request => {
    if (request.role === 'developer') await writeFile(path.join(request.cwd, 'src/value.mjs'), 'export const value = 2;\n');
    else {
      assert.match(request.prompt, /conflict/i);
      conflictResolutions++;
      await writeFile(path.join(request.cwd, 'src/value.mjs'), "export const value = 2;\nexport const remoteAddition = 'kept';\n");
      git(request.cwd, 'add', 'src/value.mjs');
    }
    return { sessionId: `target-merge-${services.calls.worker.length}`, output: { summary: 'changes preserved', checks: [], complete: true } };
  } });
  services.delivery.deliver = async ({ run, review }) => {
    services.calls.delivery++;
    if (services.calls.delivery === 1) {
      const other = path.join(fx.directory, 'other-client');
      git(fx.directory, 'clone', '--branch', 'main', path.join(fx.directory, 'origin.git'), other);
      git(other, 'config', 'user.name', 'Other Kodo Task'); git(other, 'config', 'user.email', 'other@example.invalid');
      git(other, 'config', 'core.autocrlf', 'false');
      await writeFile(path.join(other, 'src/value.mjs'), "export const value = 4;\nexport const remoteAddition = 'kept';\n");
      git(other, 'add', '.'); git(other, 'commit', '-m', 'Concurrent main update'); git(other, 'push', 'origin', 'main');
      upstreamSha = git(other, 'rev-parse', 'HEAD');
      throw Object.assign(new Error('target moved before merge'), { code: 'stale_base' });
    }
    assert.equal(run.baseSha, upstreamSha);
    assert.equal(review.headSha, run.headSha);
    assert.equal(run.checks.headSha, run.headSha);
    return { pr: { number: 1, url: 'https://example.invalid/pull/1' }, mergeCommit: run.headSha };
  };
  const engine = new Engine({ store: fx.openStore(), ...services });
  const run = await engine.create('Implement value two', { project: fx.project });
  const result = await engine.run(run.id);
  assert.equal(result.state, 'succeeded', result.error?.message);
  assert.equal(conflictResolutions, 1);
  assert.equal(services.calls.delivery, 2);
  assert.equal(services.calls.review.length, 2);
  assert.notEqual(result.headSha, result.nodes.feature.headSha);
  assert.equal(result.review.headSha, result.headSha);
  assert.match(await read(path.join(result.cwd, 'src/value.mjs')), /remoteAddition = 'kept'/);
  assert.equal(git(fx.project, 'rev-parse', 'HEAD'), fx.base);
});
