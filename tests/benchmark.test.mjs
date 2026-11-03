import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, writeFile, mkdir, rm, access } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runBenchmark, resumeBenchmark, reportBenchmark, isolatedBenchmarkInvocation, buildBenchmarkReport, normalizeBenchmarkOptions } from '../runtime/benchmark.mjs';
import { defaultFixtures, materializeFixture, evaluateFixture } from '../runtime/benchmark-fixtures.mjs';
import { Store } from '../runtime/store.mjs';

const solution = "function extension(filename) { const name = filename.replaceAll('\\\\', '/').split('/').at(-1); const dot = name.lastIndexOf('.'); return dot > 0 && dot < name.length - 1 ? name.slice(dot + 1).toLowerCase() : ''; }\nmodule.exports = { extension };\n";
const metric = { durationMs: 3, toolSteps: 2, usage: { inputTokens: 10, cachedInputTokens: 4, outputTokens: 2, cacheReadTokens: null, cacheWriteTokens: null, totalTokens: 12, semantics: 'input-includes-cached', source: 'codex.usage' } };
const resources = new Map();
async function temp(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'kodo-bench-test-'));
  resources.set(root, []);
  t.after(async () => { for (const store of resources.get(root)) store.close(); resources.delete(root); await rm(root, { recursive: true, force: true }); });
  return root;
}
async function fix(cwd) {
  try { await writeFile(path.join(cwd, 'src/extension.cjs'), solution, { flag: 'r+' }); }
  catch (error) { if (error.code !== 'ENOENT') throw error; const file = path.join(cwd, 'src/button.css'); await writeFile(file, (await readFile(file, 'utf8')).replace('#2563eb', '#7c3aed')); }
}
function services(root, overrides = {}) {
  const calls = [], creates = [];
  const accountStore = new Store(path.join(root, 'account'));
  resources.get(root).push(accountStore);
  const provider = {
    discoverProviders: async ({ client }, { config }) => config.models[client].map(model => ({ id: `${client}:${model}`, client, model, available: model !== 'unsupported', verified: true })),
    runSession: async request => { calls.push(request); await fix(request.cwd); return { output: { complete: false, summary: 'PRIVATE RAW OUTPUT', checks: [] }, model: request.model, metrics: metric }; },
    ...overrides.provider
  };
  class ControlledEngine {
    constructor(options) { this.options = options; }
    async create(task, options) { creates.push({ task, ...options }); return this.options.store.createRun({ task, cwd: options.project, project: options.project, model: options.model }); }
    async run(id) {
      const run = this.options.store.getRun(id);
      const token = this.options.store.acquireLease('subscription:codex', id, { limit: 1 });
      assert.ok(token);
      try { await this.options.provider.runSession({ client: 'codex', model: run.model, cwd: run.cwd, prompt: run.task }); }
      finally { this.options.store.releaseLease(token); }
      return { ...run, state: 'succeeded' };
    }
  }
  return { provider, Engine: overrides.Engine || ControlledEngine, accountStore, clientVersion: async () => 'test-client-1', calls, creates, secrets: {} };
}
const options = output => ({ output, client: 'codex', models: ['test-model'], repeats: 1, seed: 17 });

test('Windows benchmark rejects oversized execution roots before any native subscription probe', () => {
  const long = path.join(os.tmpdir(), 'x'.repeat(90));
  assert.throws(() => normalizeBenchmarkOptions(options(long), { platform: 'win32' }), /short execution root/i);
  assert.equal(normalizeBenchmarkOptions(options(long), { platform: 'linux' }).mode, 'quick');
});

test('Benchmark reports authoritative Engine assessment counters without doubling wrapped operations', async t => {
  const root = await temp(t), deps = services(root);
  class MeasuredEngine extends deps.Engine {
    async run(id) {
      const run = await super.run(id);
      return { ...run, metrics: { coordinatorLogicalCalls: { assessment: 1, analysis: 0, research: 0, routing: 0, discovery: 1 } } };
    }
  }
  const report = await runBenchmark(options(path.join(root, 'out')), { ...deps, Engine: MeasuredEngine });
  for (const trial of report.trials) {
    if (trial.condition === 'plain') assert.equal(trial.metrics.coordinatorLogicalCalls, null);
    else assert.deepEqual(trial.metrics.coordinatorLogicalCalls, { assessment: 1, analysis: 0, research: 0, routing: 0, discovery: 1 });
  }
});

test('Native invocation disables shared memory without changing subscription auth tools or credential homes', () => {
  const invocation = { command: 'codex', args: ['--no-daemon', 'exec', '--json', '--model', 'test-model'], env: { CODEX_HOME: '/signed-in-home' }, input: 'task' };
  const value = isolatedBenchmarkInvocation('codex', invocation);
  for (const setting of ['features.memories=false', 'features.memory_tool=false', 'memories.generate_memories=false', 'memories.use_memories=false']) {
    assert.ok(value.args.includes(setting)); assert.ok(value.args.indexOf(setting) < value.args.indexOf('exec'));
  }
  assert.equal(value.env.CODEX_HOME, '/signed-in-home'); assert.equal(value.input, 'task');
  assert.deepEqual(invocation.args, ['--no-daemon', 'exec', '--json', '--model', 'test-model']);
  const auth = isolatedBenchmarkInvocation('codex', { args: ['login', 'status'], env: invocation.env });
  assert.deepEqual(auth.args, ['login', 'status']);
  const claude = isolatedBenchmarkInvocation('claude-code', { args: ['-p', '--tools', 'Read,Write,Bash'], env: { CLAUDE_CONFIG_DIR: '/signed-in-home' } });
  assert.equal(claude.env.CLAUDE_CODE_DISABLE_AUTO_MEMORY, '1');
  assert.deepEqual(claude.args, ['-p', '--tools', 'Read,Write,Bash']); assert.equal(claude.env.CLAUDE_CONFIG_DIR, '/signed-in-home');
});

test('Fixtures use identical initial commits and hidden oracle rejects wrong code and auxiliary tampering', async t => {
  const root = await temp(t);
  for (const fixture of defaultFixtures) {
    const a = await materializeFixture({ directory: path.join(root, fixture.id, 'a'), fixture, client: 'codex', model: 'test-model', mode: 'quick' });
    const b = await materializeFixture({ directory: path.join(root, fixture.id, 'b'), fixture, client: 'codex', model: 'test-model', mode: 'quick' });
    assert.equal(a.initialCommit, b.initialCommit);
    assert.deepEqual(a.baseline, b.baseline);
    assert.equal((await evaluateFixture({ fixture, cwd: a.directory, baseline: a.baseline })).correctness.passed, false);
    await fix(a.directory);
    let result = await evaluateFixture({ fixture, cwd: a.directory, baseline: a.baseline });
    assert.equal(result.correctness.passed, true); assert.equal(result.scope.passed, true);
    await writeFile(path.join(a.directory, 'verify.cjs'), 'process.exit(0)');
    await writeFile(path.join(a.directory, '.env'), 'PRIVATE-SECRET');
    result = await evaluateFixture({ fixture, cwd: a.directory, baseline: a.baseline });
    assert.equal(result.correctness.passed, true); assert.equal(result.scope.passed, false);
    assert.equal(JSON.stringify(result).includes('PRIVATE-SECRET'), false);
  }
});

test('Paired benchmark uses Engine create/run with fixed models mode shared leases and fresh stores', async t => {
  const root = await temp(t), deps = services(root);
  const report = await runBenchmark({ ...options(path.join(root, 'out')), models: ['test-model', 'unsupported'] }, deps);
  assert.equal(report.complete, true); assert.equal(report.trials.length, 4);
  assert.equal(report.excludedModels[0].model, 'unsupported');
  assert.equal(deps.creates.length, 2);
  for (const request of deps.creates) { assert.equal(request.mode, 'quick'); assert.equal(request.model, 'test-model'); assert.equal(request.delivery, 'none'); }
  assert.equal(new Set(deps.calls.map(call => call.cwd)).size, 4);
  for (const request of deps.calls) { assert.equal(request.sessionId, undefined); assert.equal(request.model, 'test-model'); assert.equal(request.prompt.includes('oracle'), false); }
  for (const record of report.trials) { assert.equal(record.passed, true); assert.equal(record.metrics.usage.totalTokens, 12); assert.equal(record.metrics.nativeRequestCount, null); }
  assert.equal(report.pairedDeltas.length, 2);
  assert.equal(JSON.stringify(report).includes('PRIVATE RAW OUTPUT'), false);
});

test('Benchmark probes plain and trial Store workflows share two account slots while trials stay sequential', async t => {
  const root = await temp(t), deps = services(root), peer = new Store(deps.accountStore.home);
  const controller = new AbortController(), blocked = Promise.withResolvers(), admitted = Promise.withResolvers();
  const occupied = peer.acquireLease('subscription:codex', 'other-chat', { limit: 2 });
  let released = false, second = peer.acquireLease('subscription:codex', 'third-chat', { limit: 2 });
  assert.ok(occupied); assert.ok(second);
  const acquire = deps.accountStore.acquireLease.bind(deps.accountStore);
  deps.accountStore.acquireLease = (name, owner, options) => {
    const token = acquire(name, owner, options);
    if (name === 'subscription:codex') (released ? admitted : blocked).resolve(token);
    return token;
  };
  deps.provider.discoverProviders = async ({ client }, { config, sessionImpl }) => {
    if (sessionImpl) await sessionImpl({ client, model: config.models[client][0], cwd: root, readOnly: true, prompt: 'Capability probe' });
    return config.models[client].map(model => ({ client, model, available: true, verified: true }));
  };
  const TrialEngine = deps.Engine;
  deps.Engine = class extends TrialEngine {
    async run(id) {
      const token = peer.acquireLease('subscription:codex', 'temporary-full-pool', { limit: 2 });
      assert.ok(token);
      try {
        const overflow = this.options.store.acquireLease('subscription:codex', 'overflow-trial', { limit: 3 });
        if (overflow) this.options.store.releaseLease(overflow);
        assert.equal(overflow, null, 'trial Store must enforce the account cap even for a higher caller limit');
      } finally { peer.releaseLease(token); }
      return super.run(id);
    }
  };
  const calls = []; let active = 0, peak = 0;
  deps.provider.runSession = async request => {
    peak = Math.max(peak, ++active); calls.push(request);
    try {
      assert.equal(peer.acquireLease('subscription:codex', 'fourth-chat', { limit: 2 }), null, 'probe plain and trial Store sessions must all hold the shared second slot');
      if (!request.readOnly) {
        const receipt = JSON.parse(await readFile(path.join(root, 'out', 'benchmark.json'), 'utf8'));
        assert.equal(receipt.trials.filter(cell => cell.attempts.at(-1)?.status === 'running').length, 1, 'only the current trial may be running');
        await fix(request.cwd);
      }
      return { model: request.model, metrics: metric, output: { complete: true } };
    } finally { active--; }
  };
  const operation = runBenchmark({ ...options(path.join(root, 'out')), signal: controller.signal }, deps);
  try {
    assert.equal(await blocked.promise, null, 'a full account pool must block before any native workflow');
    assert.equal(calls.length, 0);
    peer.releaseLease(second); second = null; released = true;
    assert.ok(await admitted.promise, 'releasing one slot must admit the benchmark alongside the other chat');
    const report = await operation;
    assert.equal(report.complete, true); assert.ok(report.trials.every(cell => cell.passed));
    // ControlledEngine requests limit:1, independently exercising trialStore's
    // account capacity rather than relying on Engine.session to pass limit:2.
    assert.equal(report.probeMetrics.sessions, 1); assert.equal(deps.creates.length, 2);
    assert.equal(calls.length, 5); assert.equal(peak, 1, 'benchmark cells and probes must stay sequential');
    assert.equal(peer.renewLease(occupied), true, 'the unrelated chat lease must survive benchmark completion');
    const available = peer.acquireLease('subscription:codex', 'after-benchmark', { limit: 2 });
    assert.ok(available, 'benchmark must release its account slot'); peer.releaseLease(available);
  } finally {
    controller.abort(); await operation;
    if (second) peer.releaseLease(second);
    peer.releaseLease(occupied); peer.close();
  }
});

test('Quota and interrupted attempts resume without duplicating completed trials', async t => {
  const root = await temp(t), output = path.join(root, 'out'); let attempted = 0;
  const deps = services(root, { provider: { runSession: async request => { attempted++; if (attempted === 2) throw Object.assign(new Error('SECRET quota payload'), { code: 'quota', metrics: metric }); await fix(request.cwd); return { metrics: metric, model: request.model }; } } });
  const first = await runBenchmark(options(output), deps);
  assert.equal(first.complete, false); assert.equal(first.trials.filter(item => item.status === 'completed').length, 1);
  assert.equal(first.trials.filter(item => item.status === 'pending').length, 3);
  assert.equal(first.trials.flatMap(item => item.attempts).some(item => item.error?.code === 'quota'), true);
  // An interrupted writer has a started attempt and no final metrics. Resume
  // must retain that uncertainty, including in paired wall-time deltas.
  const interrupted = JSON.parse(await readFile(path.join(output, 'benchmark.json'), 'utf8'));
  const pending = interrupted.trials.find(item => item.status === 'pending' && item.attempts.length);
  pending.attempts.at(-1).status = 'running'; delete pending.attempts.at(-1).durationMs;
  pending.sessions[pending.sessions.length - 1] = { durationMs: null, toolSteps: null, nativeRequestCount: null };
  await writeFile(path.join(output, 'benchmark.json'), JSON.stringify(interrupted));
  const second = await resumeBenchmark(output, deps);
  assert.equal(second.complete, true); assert.equal(attempted, 5);
  const recovered = second.trials.find(item => item.trialId === pending.trialId);
  assert.equal(recovered.wallMs, null); assert.equal(recovered.metrics.usage.totalTokens, null);
  assert.equal(recovered.attempts[0].status, 'interrupted');
  const completedId = first.trials.find(item => item.status === 'completed').trialId;
  assert.equal(second.trials.find(item => item.trialId === completedId).attempts.length, 1);
  const bytes = await readFile(path.join(output, 'benchmark.json'), 'utf8');
  assert.equal((await reportBenchmark(output)).trials.length, 4);
  assert.equal(await readFile(path.join(output, 'benchmark.json'), 'utf8'), bytes, 'report must be read only');
  assert.equal(JSON.stringify(second).includes('SECRET quota payload'), false);
  const injected = JSON.parse(bytes);
  injected.trials[0].attempts[0].rawProviderOutput = 'SECRET-RAW-PAYLOAD';
  injected.trials[0].execution.rawProviderOutput = 'SECRET-RAW-PAYLOAD';
  injected.trials[0].reportedModels.push('SECRET-RAW-PAYLOAD');
  await writeFile(path.join(output, 'benchmark.json'), JSON.stringify(injected));
  assert.equal(JSON.stringify(await reportBenchmark(output)).includes('SECRET-RAW-PAYLOAD'), false);
});

test('Model success claims do not determine correctness and failures stay in summary denominator', async t => {
  const root = await temp(t), deps = services(root, { provider: { runSession: async () => ({ output: { complete: true }, metrics: metric }) } });
  const report = await runBenchmark(options(path.join(root, 'out')), deps);
  assert.equal(report.complete, true);
  assert.ok(report.trials.every(item => item.passed === false && item.correctness.passed === false && item.scope.passed === true));
  assert.ok(report.summaries.every(item => item.total === 2 && item.failed === 2 && item.passRate === 0 && item.medianPassingWallMs === null));
});

test('Resume rejects changed methodology identity and seeded order is reproducible', async t => {
  const root = await temp(t), deps = services(root);
  const a = await runBenchmark({ ...options(path.join(root, 'a')), repeats: 2 }, deps);
  const b = await runBenchmark({ ...options(path.join(root, 'b')), repeats: 2 }, deps);
  const keys = report => report.trials.map(({ fixture, model, repeat, condition }) => [fixture, model, repeat, condition]);
  assert.deepEqual(keys(a), keys(b)); assert.notEqual(a.trials[0].trialId, b.trials[0].trialId);
  const file = path.join(root, 'a', 'benchmark.json'), saved = JSON.parse(await readFile(file, 'utf8'));
  saved.identity.methodology = 'modified'; await writeFile(file, JSON.stringify(saved));
  await assert.rejects(resumeBenchmark(path.join(root, 'a'), deps), /identity|Identity/);
  const otherFile = path.join(root, 'b', 'benchmark.json'), other = JSON.parse(await readFile(otherFile, 'utf8'));
  const originalWorkspace = other.trials[0].workspace;
  other.trials[0].workspace = '../outside'; await writeFile(otherFile, JSON.stringify(other));
  await assert.rejects(resumeBenchmark(path.join(root, 'b'), deps), /identity|workspace/);
  other.trials[0].workspace = originalWorkspace;
  other.trials[0].baseline['verify.cjs'].hash = '0'.repeat(64); await writeFile(otherFile, JSON.stringify(other));
  await assert.rejects(resumeBenchmark(path.join(root, 'b'), deps), /identity|workspace/);
});

test('Production benchmark executes actual Engine worktrees review and checks using offline provider boundaries', async t => {
  const root = await temp(t), deps = services(root), stages = [];
  const previous = process.env.KODO_WORKTREE_HOME;
  process.env.KODO_WORKTREE_HOME = path.join(root, 'global-worktrees-must-not-be-used');
  t.after(() => { if (previous === undefined) delete process.env.KODO_WORKTREE_HOME; else process.env.KODO_WORKTREE_HOME = previous; });
  delete deps.Engine;
  const homes = new Set();
  deps.Store = class extends Store { constructor(home, secrets) { super(home, secrets); homes.add(home); } };
  deps.researcher = async () => ({ items: [], requests: 0, cache: [], errors: [] });
  deps.provider.analyzeGemini = async () => ({ summary: 'offline fixture analysis', files: [], limitations: [] });
  deps.provider.decideJev = async () => ({ model: 'codex:test-model', parallel: false, confidence: 1, sessionMode: 'fresh' });
  deps.provider.runSession = async request => {
    assert.equal(deps.accountStore.acquireLease('subscription:codex', 'other', { limit: 1 }), null, 'both conditions must hold the account lease during the session');
    assert.equal(request.model, 'test-model');
    assert.equal(Object.keys(request.env).some(key => /API_KEY|TOKEN|SECRET|^KODO_/i.test(key)), false);
    assert.ok(request.env.NPM_CONFIG_CACHE);
    if (request.schema?.properties.tasks) {
      stages.push('plan');
      const implementation = request.prompt.includes('src/button.css') ? 'src/button.css' : 'src/extension.cjs';
      return { sessionId: 'offline-plan', metrics: metric, output: { summary: 'Implement the assigned localized change', tasks: [{ id: 'fix', role: 'developer', description: 'Fix the behavior', dependsOn: [], writePaths: [implementation], acceptance: ['public checks pass and auxiliary files remain unchanged'], parallel: false }] } };
    }
    if (request.schema?.properties.passed) { stages.push('review'); return { sessionId: 'offline-review', metrics: metric, output: { passed: true, findings: [] } }; }
    stages.push(request.schema ? 'developer' : 'plain');
    await fix(request.cwd);
    return { sessionId: 'offline-worker', metrics: metric, output: { summary: 'Changed implementation', checks: [], complete: true }, model: request.model };
  };
  const report = await runBenchmark(options(path.join(root, 'out')), deps);
  assert.equal(report.complete, true); assert.deepEqual(report.trials.map(item => item.execution?.error), [null, null, null, null]);
  assert.ok(report.trials.every(item => item.passed));
  assert.equal(stages.filter(item => item === 'review').length, 2);
  assert.equal(stages.filter(item => item === 'developer').length, 2);
  assert.equal(homes.size, 2);
  assert.ok(report.trials.filter(item => item.condition === 'kodo').every(item => item.metrics.sessions === 3));
  await assert.rejects(access(process.env.KODO_WORKTREE_HOME), { code: 'ENOENT' });
});

test('Unavailable plain and real Engine developer sessions remain pending and resume without repeating completed trials', async t => {
  for (const condition of ['plain', 'kodo']) await t.test(condition, async t => {
    const root = await temp(t), output = path.join(root, 'out'), deps = services(root), sessions = [];
    delete deps.Engine; // Exercise production Engine.create/run, including persisted node budgets.
    deps.provider.assessTask = async () => ({ fallback: true, code: 'auth', requests: 0 });
    deps.provider.analyzeGemini = async () => { throw new Error('Quick must not invoke Gemini'); };
    deps.researcher = async () => { throw new Error('Quick must not invoke research'); };
    let subjects = 0;
    deps.provider.runSession = async request => {
      const stage = request.schema?.properties.tasks ? 'plan' : request.schema?.properties.passed ? 'review' : request.schema ? 'developer' : 'plain';
      sessions.push({ stage, cwd: request.cwd, sessionId: request.sessionId });
      if (stage === 'plan') {
        const implementation = request.prompt.includes('src/button.css') ? 'src/button.css' : 'src/extension.cjs';
        return { sessionId: 'offline-plan', metrics: metric, output: { summary: 'Fix the assigned behavior', tasks: [{ id: 'fix', role: 'developer', description: 'Fix behavior', dependsOn: [], writePaths: [implementation], acceptance: ['public checks pass'], parallel: false }] } };
      }
      if (stage === 'review') return { sessionId: 'offline-review', metrics: metric, output: { passed: true, findings: [] } };
      await fix(request.cwd);
      if (stage === (condition === 'kodo' ? 'developer' : 'plain') && ++subjects === 2) {
        request.onEvent?.({ sessionId: 'interrupted-developer' });
        throw Object.assign(new Error('PRIVATE unavailable payload'), { code: 'unavailable', metrics: metric });
      }
      return { sessionId: 'offline-worker', model: request.model, metrics: metric, output: { summary: 'Changed implementation', checks: [], complete: true } };
    };
    const first = await runBenchmark(options(output), deps);
    assert.equal(first.complete, false);
    assert.deepEqual(first.pause, { code: 'unavailable' });
    const paused = first.trials.find(cell => cell.attempts.at(-1)?.error?.code === 'unavailable');
    assert.equal(paused.condition, condition); assert.equal(paused.status, 'pending');
    assert.equal(paused.passed, null); assert.equal(paused.execution, null);
    assert.equal(first.summaries.find(row => row.condition === condition).failed, 0);
    const completed = first.trials.filter(cell => cell.status === 'completed');
    assert.ok(completed.length > 0, 'resume must have completed trials to preserve');
    const manifest = JSON.parse(await readFile(path.join(output, 'benchmark.json'), 'utf8'));
    const savedCell = manifest.trials.find(cell => cell.trialId === paused.trialId);
    const readRun = () => {
      const store = new Store(path.join(output, savedCell.workspace, 'state'));
      try { return store.getRun(savedCell.engineRunId); } finally { store.close(); }
    };
    let pendingRun;
    if (condition === 'kodo') {
      pendingRun = readRun();
      assert.equal(pendingRun.error.code, 'unavailable');
      assert.equal(pendingRun.config.repairRounds, 1);
      assert.equal(pendingRun.nodes.fix.attempt, 0);
      assert.equal(pendingRun.nodes.fix.status, 'pending');
      assert.equal(pendingRun.nodes.fix.stopped, undefined);
      assert.equal(pendingRun.nodes.fix.resumeRequired, true);
      assert.equal(pendingRun.controllerAssessment, undefined);
      assert.equal(pendingRun.sessionAttempts.at(-1).errorCode, 'unavailable');
    }
    const beforeResume = sessions.length;
    const resumed = await resumeBenchmark(output, deps);
    assert.equal(resumed.complete, true); assert.equal(resumed.pause, null);
    assert.equal(resumed.benchmarkId, first.benchmarkId);
    assert.ok(resumed.trials.every(cell => cell.passed && cell.correctness.passed && cell.scope.passed));
    for (const cell of completed) assert.deepEqual(resumed.trials.find(row => row.trialId === cell.trialId), cell);
    const recovered = resumed.trials.find(cell => cell.trialId === paused.trialId);
    assert.deepEqual(recovered.attempts.map(row => row.status), ['pending', 'completed']);
    if (condition === 'kodo') {
      const finalRun = readRun();
      assert.equal(finalRun.id, pendingRun.id); assert.equal(finalRun.nodes.fix.cwd, pendingRun.nodes.fix.cwd);
      assert.equal(finalRun.nodes.fix.attempt, 1); assert.equal(finalRun.nodes.fix.stopped, undefined);
      assert.deepEqual(sessions.slice(beforeResume, beforeResume + 2), [
        { stage: 'developer', cwd: pendingRun.nodes.fix.cwd, sessionId: 'interrupted-developer' },
        { stage: 'review', cwd: pendingRun.cwd, sessionId: undefined }
      ]);
    }
    assert.equal(JSON.stringify(resumed).includes('PRIVATE unavailable payload'), false);
    const calls = sessions.length;
    assert.equal((await resumeBenchmark(output, deps)).complete, true);
    assert.equal(sessions.length, calls, 'completed resume cannot invoke any subject again');
  });
});

test('Abort while account lease is busy saves pending data without invoking a native session', async t => {
  const root = await temp(t), deps = services(root), controller = new AbortController();
  const tokens = ['existing-coordinator', 'other-coordinator'].map(owner => deps.accountStore.acquireLease('subscription:codex', owner, { limit: 2 }));
  assert.ok(tokens.every(Boolean));
  const operation = runBenchmark({ ...options(path.join(root, 'out')), signal: controller.signal }, deps);
  setTimeout(() => controller.abort(), 100);
  const report = await operation;
  for (const token of tokens) deps.accountStore.releaseLease(token);
  assert.equal(report.complete, false); assert.equal(report.pause.code, 'cancelled'); assert.equal(deps.calls.length, 0);
  const final = await resumeBenchmark(path.join(root, 'out'), deps);
  assert.equal(final.complete, true); assert.equal(deps.calls.length, 4);
});

test('Held-out scope rejects ignored new files and changed auxiliary declarations independently of correctness', async t => {
  const root = await temp(t), fixture = defaultFixtures[0];
  const fx = await materializeFixture({ directory: path.join(root, 'fixture'), fixture, client: 'codex', model: 'test-model' });
  await fix(fx.directory);
  await writeFile(path.join(fx.directory, '.gitignore'), 'secret.tmp\n');
  await writeFile(path.join(fx.directory, 'secret.tmp'), 'PRIVATE');
  let result = await evaluateFixture({ fixture, cwd: fx.directory, baseline: fx.baseline });
  assert.equal(result.correctness.passed, true); assert.equal(result.scope.passed, false);
  const file = path.join(fx.directory, fixture.implementation);
  await writeFile(file, (await readFile(file, 'utf8')).replace('#1d4ed8', '#000000'));
  result = await evaluateFixture({ fixture, cwd: fx.directory, baseline: fx.baseline });
  assert.equal(result.correctness.passed, false); assert.equal(result.scope.passed, false);
});

test('Wrong reported model is a failed subject with independently correct code and preserved metrics', async t => {
  const root = await temp(t), deps = services(root, { provider: { runSession: async request => { await fix(request.cwd); return { model: 'other-model', metrics: metric, output: { complete: true } }; } } });
  const report = await runBenchmark(options(path.join(root, 'out')), deps);
  assert.equal(report.complete, true);
  for (const cell of report.trials) {
    assert.equal(cell.passed, false); assert.equal(cell.execution.error.code, 'fixed_model');
    assert.equal(cell.correctness.passed, true); assert.equal(cell.scope.passed, true);
    assert.equal(cell.metrics.usage.totalTokens, 12);
  }
});

test('Missing native usage and tools remain unknown and capability probe overhead stays separate', async t => {
  const root = await temp(t), deps = services(root);
  deps.provider.discoverProviders = async ({ client }, { config, sessionImpl }) => {
    await access(path.join(config.project, '.git'));
    if (sessionImpl) await sessionImpl({ client, model: config.models[client][0], cwd: root, readOnly: true, prompt: 'Capability only' });
    return config.models[client].map(model => ({ client, model, available: true, verified: true }));
  };
  deps.provider.runSession = async request => {
    const extra = deps.accountStore.acquireLease('subscription:codex', 'other', { limit: 1 });
    if (extra) deps.accountStore.releaseLease(extra);
    assert.equal(extra, null);
    if (!request.readOnly) await fix(request.cwd);
    return { model: request.model };
  };
  const report = await runBenchmark(options(path.join(root, 'out')), deps);
  assert.equal(report.probeMetrics.sessions, 1);
  assert.equal(report.complete, true);
  for (const cell of report.trials) {
    assert.equal(cell.metrics.sessions, 1); assert.equal(cell.metrics.usage.totalTokens, null);
    assert.equal(cell.metrics.toolSteps, null); assert.equal(cell.metrics.nativeRequestCount, null);
  }
});

test('Held-out oracle rejects smoke-passing filename and CSS regressions within the allowed write scope', async t => {
  const root = await temp(t);
  const [css, js] = defaultFixtures;
  const cssSource = css.files[css.implementation].replace('#2563eb', '#7c3aed');
  const filename = "const name = filename.replaceAll('\\\\', '/').split('/').at(-1); const dot = name.lastIndexOf('.'); ";
  const suffix = "return dot > 0 && dot < name.length - 1 ? name.slice(dot + 1).toLowerCase() : '';";
  const regressions = [
    { name: 'directory dots', fixture: js, source: 'const name = filename; const dot = name.lastIndexOf(\'.\'); ' + suffix },
    { name: 'backslash directories', fixture: js, source: "const name = filename.split('/').at(-1); const dot = name.lastIndexOf('.'); " + suffix },
    { name: 'leading hidden dot', fixture: js, source: filename + suffix.replace('dot > 0', 'dot >= 0') },
    { name: 'hidden name with later dot', fixture: js, source: filename + "if (name.startsWith('.')) return ''; " + suffix },
    { name: 'extensionless name', fixture: js, source: filename + suffix.replace(": '';", ': name.toLowerCase();') },
    { name: 'trailing dot', fixture: js, source: filename + "if (name.endsWith('.')) return '.'; " + suffix },
    { name: 'focus outline', fixture: css, source: cssSource.replace('outline-offset: 2px', 'outline-offset: 0px') },
    { name: 'disabled behavior', fixture: css, source: cssSource.replace('cursor: not-allowed', 'cursor: pointer') },
    { name: 'unrelated declaration', fixture: css, source: cssSource.replace('border-radius: 4px', 'border-radius: 0px') }
  ];
  for (const [index, regression] of regressions.entries()) await t.test(regression.name, async () => {
    const fx = await materializeFixture({ directory: path.join(root, `oracle-${index}`), fixture: regression.fixture, client: 'codex', model: 'test-model' });
    const source = regression.fixture === js ? `function extension(filename) { ${regression.source} }\nmodule.exports = { extension };\n` : regression.source;
    await writeFile(path.join(fx.directory, regression.fixture.implementation), source);
    const smoke = spawnSync(process.execPath, ['verify.cjs'], { cwd: fx.directory, encoding: 'utf8', windowsHide: true });
    assert.equal(smoke.status, 0, 'the public smoke must pass so only the held-out requirement distinguishes the subject');
    const result = await evaluateFixture({ fixture: regression.fixture, cwd: fx.directory, baseline: fx.baseline });
    assert.deepEqual(result.scope, { passed: true, violations: 0 });
    assert.deepEqual(result.correctness, { passed: false, code: 'heldout_failed' });
  });
});

test('Capability quota resumes only the pending model probe before scheduling either paired condition', async t => {
  const root = await temp(t), deps = services(root), output = path.join(root, 'out'), probes = [];
  let quota = true;
  deps.provider.discoverProviders = async ({ client }, { config }) => {
    const model = config.models[client][0]; probes.push(model);
    if (model === 'retry-model' && quota) { quota = false; return [{ client, model, available: false, code: 'quota' }]; }
    return [{ client, model, available: true, verified: true }];
  };
  const first = await runBenchmark({ ...options(output), models: ['test-model', 'retry-model'] }, deps);
  assert.equal(first.complete, false); assert.equal(first.pause.code, 'quota');
  assert.deepEqual(first.trials, []); assert.equal(deps.calls.length, 0);
  assert.deepEqual(probes, ['test-model', 'retry-model']);
  const second = await resumeBenchmark(output, deps);
  assert.equal(second.complete, true); assert.equal(second.pause, null);
  assert.equal(second.identityHash, first.identityHash); assert.equal(second.benchmarkId, first.benchmarkId);
  assert.deepEqual(probes, ['test-model', 'retry-model', 'retry-model']);
  assert.equal(second.trials.length, 8); assert.equal(deps.calls.length, 8);
  assert.ok(second.trials.every(cell => cell.passed && cell.attempts.length === 1));
  const before = await readFile(path.join(output, 'benchmark.json'), 'utf8');
  await assert.rejects(resumeBenchmark(output, { ...deps, clientVersion: async () => 'different-client-2' }), /identity changed/i);
  assert.equal(await readFile(path.join(output, 'benchmark.json'), 'utf8'), before);
  assert.equal(deps.calls.length, 8, 'identity rejection cannot invoke subjects');
  assert.equal((await resumeBenchmark(output, deps)).complete, true);
  assert.equal(deps.calls.length, 8, 'completed cells remain idempotent on resume');
});

test('Paired reports separate native duration from wall time and keep failed and unknown cells in their denominators', () => {
  const session = (durationMs, toolSteps, totalTokens) => ({ ...metric, durationMs, toolSteps, usage: { ...metric.usage, inputTokens: totalTokens - 2, totalTokens } });
  const cell = (pairKey, condition, wallMs, sessions, passed) => ({
    trialId: `${pairKey}-${condition}`, pairKey, fixture: 'filename-extension', fixtureHash: 'fixture-hash', model: 'test-model', repeat: pairKey === 'known' ? 1 : 2, condition,
    status: 'completed', wallMs, wallIncomplete: wallMs === null, sessions, reportedModels: [],
    attempts: [{ number: 1, status: 'completed', durationMs: wallMs }],
    execution: { succeeded: true, error: null }, correctness: { passed, code: passed ? 'passed' : 'heldout_failed' }, scope: { passed: true, violations: 0 }, passed
  });
  const report = buildBenchmarkReport({
    id: 'offline-report', identityHash: 'offline-identity', complete: true, capabilities: { 'test-model': { available: true } }, probeMetrics: [],
    identity: { options: { client: 'codex', models: ['test-model'], mode: 'quick', repeats: 2, seed: 17 }, engine: {}, clientVersion: 'offline-1' },
    // Pairing must use identity rather than array adjacency. A completed
    // failure remains measured, and a lost receipt stays unknown.
    trials: [
      cell('known', 'kodo', 170, [session(20.25, 2, 12), session(40.5, 3, 20)], false),
      cell('unknown', 'plain', 50, [session(30, 1, 10)], true),
      cell('known', 'plain', 100, [session(40, 2, 12)], true),
      cell('unknown', 'kodo', null, [{ durationMs: null, toolSteps: null }], true)
    ]
  });
  const kodo = report.trials.find(row => row.trialId === 'known-kodo');
  assert.equal(kodo.wallMs, 170); assert.equal(kodo.metrics.durationMs, 60.75);
  assert.equal(kodo.metrics.sessions, 2); assert.equal(kodo.metrics.nativeRequestCount, null);
  const known = report.pairedDeltas.find(row => row.pairKey === 'known');
  assert.equal(known.complete, true); assert.equal(known.plainPassed, true); assert.equal(known.kodoPassed, false);
  assert.equal(known.kodoMinusPlainWallMs, 70); assert.equal(known.kodoMinusPlainToolSteps, 3); assert.equal(known.kodoMinusPlainTotalTokens, 20);
  const unknown = report.pairedDeltas.find(row => row.pairKey === 'unknown');
  assert.equal(unknown.complete, true);
  assert.equal(unknown.kodoMinusPlainWallMs, null); assert.equal(unknown.kodoMinusPlainToolSteps, null); assert.equal(unknown.kodoMinusPlainTotalTokens, null);
  assert.deepEqual(report.summaries.map(({ condition, total, completed, passed, failed, pending, passRate, knownWallCount, medianWallMs, medianPassingWallMs }) => ({ condition, total, completed, passed, failed, pending, passRate, knownWallCount, medianWallMs, medianPassingWallMs })), [
    { condition: 'plain', total: 2, completed: 2, passed: 2, failed: 0, pending: 0, passRate: 1, knownWallCount: 2, medianWallMs: 75, medianPassingWallMs: 75 },
    { condition: 'kodo', total: 2, completed: 2, passed: 1, failed: 1, pending: 0, passRate: .5, knownWallCount: 1, medianWallMs: 170, medianPassingWallMs: null }
  ]);
});
