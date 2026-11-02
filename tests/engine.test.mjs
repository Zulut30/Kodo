import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile, rm, access } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Engine } from '../runtime/engine.mjs';
import { Store } from '../runtime/store.mjs';
import { makeWorktree, diffHash } from '../runtime/workspace.mjs';
import { createHash } from 'node:crypto';

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

test('Engine saves cannot overwrite cancellation from another coordinator connection', async t => {
  const fx = await fixture(t);
  const store = fx.openStore(), other = fx.openStore();
  const engine = new Engine({ store });
  const run = await engine.create('cancel persisted work', { project: fx.project });
  run.cancelRequested = false;
  other.updateRun(run.id, { cancelRequested: true, state: 'cancelled' });
  run.state = 'implementing';
  engine.save(run);
  assert.equal(other.getRun(run.id).cancelRequested, true);
  assert.equal(other.getRun(run.id).state, 'cancelled');
});

test('Engine allows credential-handling source text and hashes its exact Git diff while rejecting actual secrets', async t => {
  const fx = await fixture(t);
  const secret = 'fixture-configured-private-value';
  const engine = new Engine({ store: fx.openStore(), secrets: { GEMINI_API_KEY: secret } });
  const file = path.join(fx.project, 'src/value.mjs');
  await writeFile(file, 'export const auth = token => `Bearer ${token}`;\n');
  assert.deepEqual(await engine.checkScope(fx.project, fx.base, ['src/value.mjs']), ['src/value.mjs']);
  git(fx.project, 'add', '.'); git(fx.project, 'commit', '-m', 'credential handling source');
  const native = git(fx.project, 'diff', '--binary', `${fx.base}...HEAD`);
  assert.equal(await diffHash(fx.project, fx.base), createHash('sha256').update(native.trimEnd()).digest('hex'));
  await writeFile(file, `export const accidental = '${secret}';\n`);
  await assert.rejects(engine.checkScope(fx.project, fx.base, ['src/value.mjs']), /Секрет обнаружен/);
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
    return { model: 'codex-sol', parallel: true, confidence: 0.95, sessionMode: 'fresh' };
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

test('Engine keeps the per run research ceiling when two failures request research concurrently', async t => {
  const fx = await fixture(t, { testScript: 'process.exit(0);\n' });
  const services = fakeServices();
  services.researcher = async ({ budget }) => {
    await new Promise(resolve => setImmediate(resolve));
    return { items: [], requests: budget, errors: [], cache: [] };
  };
  const engine = new Engine({ store: fx.openStore(), ...services });
  const run = await engine.create('Concurrent research fixture', { project: fx.project });
  run.research = { items: [], requests: 1, errors: [], cache: [] };
  engine.save(run);
  await Promise.all([engine.moreResearch(run, 'first failed node'), engine.moreResearch(run, 'second failed node')]);
  assert.equal(run.research.requests, run.config.researchBudget);
  assert.equal(engine.store.getRun(run.id).research.requests, run.config.researchBudget);
});

test('Engine reruns checks and independent review after repairing a confirmed review finding', async t => {
  const fx = await fixture(t, { config: { repairRounds: 2 }, testScript: "import assert from 'node:assert/strict'; import {value} from './src/value.mjs'; assert.equal(value, 2);\n" });
  const plan = { summary: 'Set value two.', tasks: [node('feature', 'developer', ['src/value.mjs'])] };
  let repairs = 0, firstReviewedHead;
  const services = fakeServices({ plan, onWorker: async request => {
    if (request.role === 'developer') await writeFile(path.join(request.cwd, 'src/value.mjs'), 'export const value = 2;\n');
    else {
      assert.match(request.prompt, /Repair confirmed failures/);
      repairs++;
      await writeFile(path.join(request.cwd, 'src/value.mjs'), 'export const value = 2;\nexport const reviewFix = true;\n');
    }
    return { sessionId: `review-repair-${services.calls.worker.length}`, output: { summary: 'implemented', checks: [], complete: true } };
  }, onReview: async (request, calls) => {
    const head = git(request.cwd, 'rev-parse', 'HEAD');
    if (calls.review.length === 1) {
      firstReviewedHead = head;
      return { sessionId: 'review-finding', output: { passed: false, findings: [{ file: 'src/value.mjs', severity: 'major', problem: 'Required reviewFix marker is absent', fix: 'Add reviewFix=true export' }] } };
    }
    assert.notEqual(head, firstReviewedHead);
    assert.match(request.prompt, /"headSha":"[a-f0-9]+"/);
    assert.match(await read(path.join(request.cwd, 'src/value.mjs')), /reviewFix = true/);
    return { sessionId: 'review-after-repair', output: { passed: true, findings: [] } };
  } });
  const store = fx.openStore(), engine = new Engine({ store, ...services });
  const run = await engine.create('Implement value two and the reviewFix marker', { project: fx.project });
  const result = await engine.run(run.id);
  assert.equal(result.state, 'succeeded', result.error?.message);
  assert.equal(repairs, 1);
  assert.equal(services.calls.review.length, 2);
  assert.equal(result.review.sessionId, 'review-after-repair');
  assert.equal(result.checks.headSha, result.headSha);
  assert.equal(result.review.headSha, result.headSha);
  assert.notEqual(result.headSha, firstReviewedHead);
  assert.equal(store.events(run.id).filter(event => event.type === 'check_started').length, 2);
  assert.equal(await read(path.join(fx.project, 'src/value.mjs')), 'export const value = 0;\n');
});

test('Engine honours persisted cancellation after merge and does not publish a release', async t => {
  const fx = await fixture(t, { remote: true });
  const services = fakeServices(), store = fx.openStore();
  services.delivery.deliver = async ({ run }) => {
    services.calls.delivery++;
    store.updateRun(run.id, { cancelRequested: true, state: 'cancelled' });
    return { pr: { number: 1, url: 'https://example.invalid/pull/1' }, mergeCommit: run.headSha };
  };
  const engine = new Engine({ store, ...services });
  const run = await engine.create('Implement value two', { project: fx.project });
  const result = await engine.run(run.id);
  assert.equal(result.state, 'cancelled', result.error?.message);
  assert.equal(result.delivery.mergeCommit, result.headSha, 'cancellation must retain the already completed merge receipt');
  assert.equal(services.calls.release, 0, 'cancellation must stop the next external mutation');
  assert.equal(store.getRun(run.id).cancelRequested, true);
});

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

test('Engine coordinator stages resolver edits before completing a node merge conflict', async t => {
  let resolutions = 0;
  const fx = await integrationConflict(t, async request => {
    resolutions++;
    assert.match(request.prompt, /conflict/i);
    await writeFile(path.join(request.cwd, 'src/value.mjs'), combinedModule);
    // The resolver deliberately does not stage or commit; the coordinator owns Git.
    return { sessionId: 'edit-only-resolver', output: { summary: 'preserved both changes', checks: [], complete: true } };
  });
  await fx.engine.integrateNode(fx.run, fx.tasks[1]);
  assert.equal(resolutions, 1);
  assert.equal(fx.run.nodes.second.status, 'integrated');
  assert.equal(await read(path.join(fx.run.cwd, 'src/value.mjs')), combinedModule);
  assert.equal(git(fx.run.cwd, 'status', '--porcelain'), '');
  assert.equal(git(fx.run.cwd, 'rev-parse', 'HEAD'), fx.run.headSha);
  assert.equal(await exists(path.join(fx.project, 'src/value.mjs')), true);
  assert.equal(await read(path.join(fx.project, 'src/value.mjs')), 'export const value = 0;\n');
});

test('Engine resumes a staged resolved node merge without rerunning the resolver', async t => {
  let resolutions = 0;
  const fx = await integrationConflict(t, async () => {
    resolutions++;
    throw new Error('resolved staged merge must not need another resolver session');
  });
  const merge = spawnSync('git', ['merge', '--no-ff', '--no-edit', fx.run.nodes.second.branch], { cwd: fx.run.cwd, encoding: 'utf8', windowsHide: true });
  assert.equal(merge.status, 1, merge.stderr);
  assert.match(git(fx.run.cwd, 'diff', '--name-only', '--diff-filter=U'), /src\/value.mjs/);
  await writeFile(path.join(fx.run.cwd, 'src/value.mjs'), combinedModule);
  git(fx.run.cwd, 'add', 'src/value.mjs');
  assert.equal(git(fx.run.cwd, 'diff', '--name-only', '--diff-filter=U'), '');
  const resumed = fx.store.getRun(fx.run.id);
  await fx.engine.integrateNode(resumed, fx.tasks[1]);
  assert.equal(resolutions, 0);
  assert.equal(resumed.nodes.second.status, 'integrated');
  assert.equal(await read(path.join(resumed.cwd, 'src/value.mjs')), combinedModule);
  assert.equal(git(resumed.cwd, 'status', '--porcelain'), '');
  assert.equal(git(resumed.cwd, 'rev-parse', 'HEAD'), resumed.headSha);
});

test('Engine rejects resolver scope violations and secret writes before merge commit', async t => {
  const cases = [
    { id: 'outside-scope', secret: false, expected: /вне области задачи: untouched.txt/ },
    { id: 'secret-in-owned-file', secret: true, expected: /Секрет обнаружен/ }
  ];
  for (const entry of cases) await t.test(entry.id, async subtest => {
    const secret = 'fixture-private-secret-for-resolver-only';
    const fx = await integrationConflict(subtest, async request => {
      await writeFile(path.join(request.cwd, 'src/value.mjs'), combinedModule + (entry.secret ? `export const accidentalKey = '${secret}';\n` : ''));
      if (!entry.secret) await writeFile(path.join(request.cwd, 'untouched.txt'), 'unauthorized resolver edit\n');
      return { sessionId: 'invalid-resolver', output: { summary: 'resolved', checks: [], complete: true } };
    }, { GEMINI_API_KEY: secret });
    const before = git(fx.run.cwd, 'rev-parse', 'HEAD');
    await assert.rejects(fx.engine.integrateNode(fx.run, fx.tasks[1]), entry.expected);
    assert.equal(git(fx.run.cwd, 'rev-parse', 'HEAD'), before);
    assert.notEqual(fx.run.nodes.second.status, 'integrated');
    assert.equal(await read(path.join(fx.project, 'untouched.txt')), 'committed content\n');
  });
});

test('Engine scopes review repairs to the repair starting head instead of earlier coordinator release edits', async t => {
  const fx = await fixture(t, { remote: true, config: { repairRounds: 2 }, testScript: "import assert from 'node:assert/strict'; import {value} from './src/value.mjs'; assert.equal(value, 2);\n" });
  const plan = { summary: 'Set value two.', tasks: [node('feature', 'developer', ['src/value.mjs'])] };
  let repairs = 0;
  const services = fakeServices({ plan, onWorker: async request => {
    if (request.role === 'developer') await writeFile(path.join(request.cwd, 'src/value.mjs'), 'export const value = 2;\n');
    else {
      assert.match(request.prompt, /Repair confirmed failures/);
      repairs++;
      await writeFile(path.join(request.cwd, 'src/value.mjs'), 'export const value = 2;\nexport const reviewFix = true;\n');
    }
    return { sessionId: `versioned-repair-${services.calls.worker.length}`, output: { summary: 'implemented', checks: [], complete: true } };
  }, onReview: async (_request, calls) => ({
    sessionId: `versioned-review-${calls.review.length}`,
    output: calls.review.length === 1
      ? { passed: false, findings: [{ file: 'src/value.mjs', severity: 'major', problem: 'reviewFix marker missing', fix: 'Add the marker' }] }
      : { passed: true, findings: [] }
  }) });
  services.delivery.prepareReleaseVersion = async ({ cwd }) => {
    await writeFile(path.join(cwd, 'registry.json'), '{"version":"0.2.0"}\n');
  };
  const engine = new Engine({ store: fx.openStore(), ...services });
  const run = await engine.create('Implement value two with reviewFix', { project: fx.project });
  const result = await engine.run(run.id);
  assert.equal(result.state, 'succeeded', result.error?.message);
  assert.equal(repairs, 1);
  assert.equal(services.calls.review.length, 2);
  assert.equal(JSON.parse(await read(path.join(result.cwd, 'registry.json'))).version, '0.2.0');
  assert.match(await read(path.join(result.cwd, 'src/value.mjs')), /reviewFix = true/);
  assert.equal(result.checks.headSha, result.headSha);
  assert.equal(result.review.headSha, result.headSha);
  assert.equal(await exists(path.join(fx.project, 'registry.json')), false);
});

test('Engine refreshes a retried node from integrated upstream while preserving its scoped unfinished tests', async t => {
  const fx = await fixture(t, { testScript: 'process.exit(0);\n' });
  const task = node('tests', 'tester', ['tests/retained.mjs']);
  const services = fakeServices({ plan: { summary: 'Preserve pending test', tasks: [task] }, onWorker: async request => {
    assert.equal(await read(path.join(request.cwd, 'upstream-fix.txt')), 'fixed baseline\n');
    assert.equal(await read(path.join(request.cwd, 'tests/retained.mjs')), 'unfinished test content\n');
    return { sessionId: 'refreshed-test', output: { summary: 'preserved and checked', checks: ['baseline observed'], complete: true } };
  } });
  const store = fx.openStore(), engine = new Engine({ store, ...services });
  const run = await engine.create('Refresh a retried test', { project: fx.project });
  await engine.prepare(run); run.plan = { summary: 'Preserve pending test', tasks: [task] }; run.models = await services.provider.discoverProviders();
  const cwd = path.join(store.home, 'worktrees', run.id, task.id), branch = `kodo/${run.id}-${task.id}`;
  await makeWorktree(fx.project, cwd, branch, fx.base);
  await mkdir(path.join(cwd, 'tests')); await writeFile(path.join(cwd, 'tests/retained.mjs'), 'unfinished test content\n');
  run.nodes[task.id] = { id: task.id, status: 'pending', attempt: 0, cwd, branch, baseSha: fx.base };
  await writeFile(path.join(run.cwd, 'upstream-fix.txt'), 'fixed baseline\n'); git(run.cwd, 'add', '.'); git(run.cwd, 'commit', '-m', 'Integrated baseline fix');
  engine.save(run); const head = git(run.cwd, 'rev-parse', 'HEAD');
  await engine.performNode(run, task);
  assert.equal(run.nodes.tests.status, 'completed'); assert.equal(run.nodes.tests.baseSha, head);
  assert.deepEqual(run.nodes.tests.changedFiles, ['tests/retained.mjs']);
  assert.equal(await exists(path.join(fx.project, 'tests/retained.mjs')), false);
});

test('Engine reassigns a stale release version and repeats checks and review before retrying delivery', async t => {
  const fx = await fixture(t, { remote: true, testScript: 'process.exit(0);\n' });
  const plan = { summary: 'Set value two', tasks: [node('feature', 'developer', ['src/value.mjs'])] };
  const services = fakeServices({ plan }); let assignments = 0;
  services.delivery.prepareReleaseVersion = async ({ cwd }) => {
    assignments++; await writeFile(path.join(cwd, 'registry.json'), JSON.stringify({ version: `0.2.${assignments}` }));
  };
  services.delivery.deliver = async ({ run, review }) => {
    services.calls.delivery++;
    if (services.calls.delivery === 1) throw Object.assign(new Error('Version claimed by another task'), { code: 'stale_base' });
    assert.equal(assignments, 2); assert.equal(JSON.parse(await read(path.join(run.cwd, 'registry.json'))).version, '0.2.2');
    assert.equal(review.headSha, git(run.cwd, 'rev-parse', 'HEAD')); assert.equal(run.checks.headSha, review.headSha);
    return { mergeCommit: review.headSha, pr: { number: 1 } };
  };
  const engine = new Engine({ store: fx.openStore(), ...services });
  const run = await engine.create('Release version refresh', { project: fx.project }); const result = await engine.run(run.id);
  assert.equal(result.state, 'succeeded', result.error?.message); assert.equal(assignments, 2);
  assert.equal(services.calls.review.length, 2); assert.equal(services.calls.release, 1);
});

test('Engine follows Jev fresh session decisions after a defect and uses the configured primary model on fallback', async t => {
  const fx = await fixture(t, { config: { repairRounds: 2 }, testScript: 'process.exit(0);\n' });
  const task = node('feature', 'developer', ['src/value.mjs']);
  const services = fakeServices({ plan: { summary: 'Repair with a fresh session', tasks: [task] }, onWorker: async (request, calls) => {
    assert.equal(request.sessionId, undefined, 'a confirmed defect with Jev=fresh must get a new session');
    return { sessionId: `attempt-${calls.worker.length}`, output: { summary: 'attempt', checks: [], complete: calls.worker.length > 1 } };
  } });
  services.provider.decideJev = async ({ node: candidate, attempt }) => {
    if (attempt > 0) assert.equal(candidate.sessionId, 'attempt-1');
    return { model: 'codex-sol', parallel: false, confidence: 0.95, sessionMode: 'fresh' };
  };
  const engine = new Engine({ store: fx.openStore(), ...services });
  const run = await engine.create('Fresh session after a defect', { project: fx.project }); const result = await engine.run(run.id);
  assert.equal(result.state, 'succeeded', result.error?.message); assert.equal(services.calls.worker.length, 2);
  result.config.primaryModel = 'gpt-6-astra';
  services.provider.decideJev = async () => ({ model: 'codex-sol', fallback: true, confidence: 0, parallel: false });
  const selected = await engine.route(result, task, { attempt: 0 });
  assert.equal(selected.id, 'codex-astra');
  services.provider.decideJev = async () => ({ model: 'codex-sol', parallel: 'yes', confidence: 1.5 });
  await assert.rejects(engine.route(result, task, { attempt: 0 }), { code: 'invalid_output' });
});

test('Engine resumes scoped interrupted repair only after committing and rechecking its exact head', async t => {
  const fx = await fixture(t, { testScript: "import assert from 'node:assert/strict';import{value}from'./src/value.mjs';assert.equal(value,2);\n" });
  const services = fakeServices({ plan: { summary: 'value two', tasks: [node('feature', 'developer', ['src/value.mjs'])] } });
  const store = fx.openStore(), engine = new Engine({ store, ...services });
  const run = await engine.create('Recover interrupted repair', { project: fx.project }); await engine.prepare(run);
  run.plan = { summary: 'value two', tasks: [node('feature', 'developer', ['src/value.mjs'])] }; run.completed.implementation = true; run.state = 'cancelled';
  await writeFile(path.join(run.cwd, 'src/value.mjs'), 'export const value = 2;\n');
  engine.save(run);
  const result = await engine.run(run.id, { resumeCancelled: true });
  assert.equal(result.state, 'succeeded', result.error?.message);
  assert.notEqual(result.headSha, fx.base); assert.equal(result.checks.headSha, result.headSha); assert.equal(result.review.headSha, result.headSha);
  assert.equal(git(run.cwd, 'status', '--porcelain'), ''); assert.equal(services.calls.worker.length, 0);
  assert.equal(store.events(run.id).filter(e => e.type === 'repair_recovered').length, 1);
});

test('Engine refuses interrupted out of scope edits and dirty commit checks before any review', async t => {
  const fx = await fixture(t, { testScript: 'process.exit(0);\n' });
  const services = fakeServices(); const store = fx.openStore(), engine = new Engine({ store, ...services });
  const run = await engine.create('Recover edits safely', { project: fx.project }); await engine.prepare(run);
  run.plan = featurePlan(); run.completed.implementation = true; engine.save(run);
  await writeFile(path.join(run.cwd, 'untouched.txt'), 'unexpected interrupted edit\n');
  await assert.rejects(engine.checks(run), { code: 'dirty_worktree' });
  const result = await engine.run(run.id);
  assert.equal(result.state, 'blocked'); assert.equal(result.error.code, 'scope_conflict');
  assert.equal(git(run.cwd, 'rev-parse', 'HEAD'), fx.base); assert.equal(services.calls.review.length, 0);
});

test('Engine refuses to finish a node merge whose MERGE_HEAD belongs to another node', async t => {
  const fx = await integrationConflict(t, async () => { throw new Error('wrong resolver must not be called'); });
  const merge = spawnSync('git', ['merge', '--no-ff', '--no-edit', fx.run.nodes.second.branch], { cwd: fx.run.cwd, encoding: 'utf8', windowsHide: true });
  assert.equal(merge.status, 1);
  fx.run.nodes.first.status = 'completed';
  await assert.rejects(fx.engine.integrateNode(fx.run, fx.tasks[0]), { code: 'merge_state' });
  assert.equal(git(fx.run.cwd, 'rev-parse', 'MERGE_HEAD'), fx.run.nodes.second.headSha);
});

test('Engine recovers interrupted version metadata only when all other fields are unchanged', async t => {
  for (const tampered of [false, true]) await t.test(tampered ? 'extra-field-rejected' : 'version-only-recovered', async subtest => {
    const fx = await fixture(subtest, { testScript: 'process.exit(0);\n' });
    await writeFile(path.join(fx.project, 'package.json'), JSON.stringify({ name: 'fixture-kodo', version: '0.1.0' }));
    git(fx.project, 'add', '.'); git(fx.project, 'commit', '-m', 'Version baseline');
    const services = fakeServices(), engine = new Engine({ store: fx.openStore(), ...services });
    const run = await engine.create('Recover version assignment', { project: fx.project }); await engine.prepare(run);
    run.plan = { summary: 'value two', tasks: [node('feature', 'developer', ['src/value.mjs'])] };
    run.config.delivery.release = true; run.releaseAssignment = { version: '0.2.0', prepared: false };
    const value = { name: 'fixture-kodo', version: '0.2.0', ...(tampered ? { scripts: { preinstall: 'unexpected executable' } } : {}) };
    await writeFile(path.join(run.cwd, 'package.json'), JSON.stringify(value));
    const before = git(run.cwd, 'rev-parse', 'HEAD');
    if (tampered) {
      await assert.rejects(engine.recoverIntegrationEdits(run), { code: 'scope_conflict' });
      assert.equal(git(run.cwd, 'rev-parse', 'HEAD'), before);
    } else {
      await engine.recoverIntegrationEdits(run);
      assert.notEqual(git(run.cwd, 'rev-parse', 'HEAD'), before);
      assert.equal(JSON.parse(git(run.cwd, 'show', 'HEAD:package.json')).version, '0.2.0');
      assert.equal(git(run.cwd, 'status', '--porcelain'), '');
    }
  });
});

test('Engine aborts a worker action when its subscription lease is lost and releases the old token', async t => {
  const fx = await fixture(t); const store = fx.openStore();
  const engine = new Engine({ store, leaseHeartbeatMs: 1 });
  const run = await engine.create('Guard subscription lease', { project: fx.project });
  let aborted = false, released = 0;
  const release = store.releaseLease.bind(store);
  store.renewLease = () => false;
  store.releaseLease = token => { released++; release(token); };
  await assert.rejects(engine.withLease(run, 'subscription:fixture', 1, async signal => {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(resolve, 1000);
      signal.addEventListener('abort', () => { aborted = true; clearTimeout(timer); reject(new Error('action aborted')); }, { once: true });
    });
  }), { code: 'lease_lost' });
  assert.equal(aborted, true); assert.equal(released, 1);
});

test('Engine reconciles a real squash merge before changing its reviewed head after a missing receipt', async t => {
  for (const code of ['command_failed', 'stale_base']) await t.test(code, async subtest => {
    const fx = await fixture(subtest, { remote: true, testScript: "import assert from 'node:assert/strict';import{value}from'./src/value.mjs';assert.equal(value,2);\n" });
    const plan = { summary: 'Value two through squash merge', tasks: [node('feature', 'developer', ['src/value.mjs'])] };
    let discovered = 0, merged, reviewed;
    const services = fakeServices({ plan, onDiscover: async () => { if (++discovered > 1) throw new Error('Merged recovery must not require a new model discovery'); } });
    const store = fx.openStore(), engine = new Engine({ store, ...services });
    services.delivery.reconcileDelivery = async ({ run }) => {
      if (!merged) return null;
      assert.equal(run.delivery.reviewedHead, reviewed);
      assert.equal(git(run.cwd, 'rev-parse', 'HEAD'), reviewed, 'do not merge our own squash back into the reviewed branch');
      return { ...run.delivery, mergeCommit: merged };
    };
    services.delivery.deliver = async ({ run, review }) => {
      services.calls.delivery++;
      if (merged) return { ...run.delivery, mergeCommit: merged };
      reviewed = review.headSha;
      const other = path.join(fx.directory, 'squash-client');
      git(fx.directory, 'clone', '--branch', 'main', path.join(fx.directory, 'origin.git'), other);
      git(other, 'config', 'user.name', 'Squash Coordinator'); git(other, 'config', 'user.email', 'squash@example.invalid');
      git(other, 'fetch', fx.project, run.branch); git(other, 'merge', '--squash', 'FETCH_HEAD');
      git(other, 'commit', '-m', 'Real squash commit with different history'); git(other, 'push', 'origin', 'main');
      merged = git(other, 'rev-parse', 'HEAD'); assert.notEqual(merged, reviewed);
      run.delivery = { pr: { number: 1, url: 'https://example.invalid/pull/1' }, reviewedHead: reviewed };
      store.updateRun(run.id, { delivery: run.delivery });
      throw Object.assign(new Error('Interrupted before merge receipt was saved'), { code });
    };
    const run = await engine.create('Squash receipt recovery', { project: fx.project });
    let result = await engine.run(run.id);
    if (code === 'command_failed') { assert.equal(result.state, 'blocked'); result = await engine.run(run.id); }
    assert.equal(result.state, 'succeeded', result.error?.message);
    assert.equal(result.delivery.mergeCommit, merged); assert.equal(result.review.headSha, reviewed);
    assert.equal(services.calls.review.length, 1); assert.equal(services.calls.release, 1); assert.equal(discovered, 1);
  });
});

test('Engine completes the owning pending node merge before scheduling earlier ready nodes without delivery', async t => {
  let owningRun, thirdStarted = false;
  const fx = await integrationConflict(t, async request => {
    if (request.role === 'developer') {
      assert.equal(owningRun.nodes.second.status, 'integrated'); thirdStarted = true;
      await writeFile(path.join(request.cwd, 'src/third.mjs'), 'export const third = true;\n');
    } else await writeFile(path.join(request.cwd, 'src/value.mjs'), combinedModule);
    return { sessionId: 'pending-owner-recovery', output: { summary: 'completed', checks: [], complete: true } };
  });
  owningRun = fx.run;
  const third = node('third', 'developer', ['src/third.mjs'], ['first']);
  fx.run.plan.tasks.splice(1, 0, third); fx.engine.save(fx.run);
  const merge = spawnSync('git', ['merge', '--no-ff', '--no-edit', fx.run.nodes.second.branch], { cwd: fx.run.cwd, encoding: 'utf8', windowsHide: true });
  assert.equal(merge.status, 1);
  await fx.engine.executeTasks(fx.run);
  assert.equal(thirdStarted, true); assert.ok(Object.values(fx.run.nodes).every(node => node.status === 'integrated'));
  assert.equal(await read(path.join(fx.run.cwd, 'src/value.mjs')), combinedModule);
  assert.equal(git(fx.run.cwd, 'status', '--porcelain'), '');
});

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

test('Engine resumes an interrupted conflicted node refresh against its recorded incoming head and exact repair session', async t => {
  let repairs = 0;
  const fx = await refreshFixture(t, async request => {
    if (!request.role) {
      repairs++;
      if (repairs === 1) { request.onEvent({ sessionId: 'refresh-repair-session' }); throw Object.assign(new Error('quota in refresh resolver'), { code: 'quota' }); }
      assert.equal(request.sessionId, 'refresh-repair-session');
      await writeFile(path.join(request.cwd, 'src/value.mjs'), 'export const value = 2;\nexport const upstream = true;\n');
    }
    return { sessionId: request.role ? 'worker-after-refresh' : 'refresh-repair-session', output: { summary: 'preserved both', checks: [], complete: true } };
  }, true);
  await assert.rejects(fx.engine.performNode(fx.run, fx.task), { code: 'quota' });
  const resumed = fx.store.getRun(fx.run.id);
  assert.equal(resumed.nodes.feature.pendingRefresh.headSha, fx.target);
  await fx.engine.performNode(resumed, fx.task);
  assert.equal(resumed.nodes.feature.status, 'completed'); assert.equal(resumed.nodes.feature.baseSha, fx.target);
  assert.equal(resumed.nodes.feature.pendingRefresh, undefined); assert.deepEqual(resumed.nodes.feature.changedFiles, ['src/value.mjs']);
  assert.equal(await read(path.join(fx.cwd, 'upstream-fix.txt')), 'incoming outside task scope\n');
  assert.match(await read(path.join(fx.cwd, 'src/value.mjs')), /upstream = true/);
});

test('Engine recovers a completed node refresh merge when its base receipt was not saved', async t => {
  const fx = await refreshFixture(t, async () => ({ sessionId: 'recovered-refresh-worker', output: { summary: 'done', checks: [], complete: true } }));
  fx.run.nodes.feature.pendingRefresh = { headSha: fx.target, model: 'codex-sol' }; fx.engine.save(fx.run);
  git(fx.cwd, 'merge', '--no-edit', fx.target); // Crash after merge, before updating baseSha.
  const resumed = fx.store.getRun(fx.run.id);
  await fx.engine.performNode(resumed, fx.task);
  assert.equal(resumed.nodes.feature.status, 'completed'); assert.equal(resumed.nodes.feature.baseSha, fx.target);
  assert.deepEqual(resumed.nodes.feature.changedFiles, ['src/value.mjs']);
});
