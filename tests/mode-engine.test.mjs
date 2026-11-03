import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile, rm, stat, utimes } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Engine } from '../runtime/engine.mjs';
import { Store } from '../runtime/store.mjs';
import { readConfig } from '../runtime/config.mjs';
import { runUIVerification } from '../runtime/ui-verification.mjs';
import { runSecurityChecks } from '../runtime/security-gates.mjs';

function git(cwd, ...args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true });
  assert.equal(result.status, 0, result.stderr); return result.stdout.trim();
}
const choice = (options, selected) => ({ type: 'choice', choice: selected, confidence: .9, probabilities: Object.fromEntries(options.map(option => [option, option === selected ? .9 : .05])) });
const low = () => ({ fallback: false, complexity: choice(['low','medium','high'], 'low'), risk: choice(['low','medium','high'], 'low'), scope: choice(['local','module','cross-cutting'], 'local'), requests: 1 });
const high = () => ({ ...low(), risk: choice(['low','medium','high'], 'high') });
const task = id => ({ id, role: 'developer', description: 'Set exported value to one with its checks', writePaths: ['value.mjs'], dependsOn: [], acceptance: ['Export equals one; test and build pass'], parallel: false });
const onePlan = () => ({ summary: 'One localized deliverable including verification', tasks: [task('fix')] });
const metrics = () => ({ durationMs: 2, toolSteps: 1, nativeRequestCount: null, usage: { inputTokens: 10, cachedInputTokens: 4, outputTokens: 2, cacheReadTokens: null, cacheWriteTokens: null, totalTokens: 12, semantics: 'input-includes-cached', source: 'codex.usage' } });

async function fixture(t, { config = {}, assessment = low, plan = onePlan, failedCheck = false, failedReview = false, failedWorker = false } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'kodo-mode-engine-')), project = path.join(root, 'project');
  await mkdir(project);
  await writeFile(path.join(project, 'value.mjs'), 'export const value = 0;\n');
  await writeFile(path.join(project, 'verify.mjs'), `import assert from 'node:assert/strict'; import {value} from './value.mjs'; assert.equal(value, ${failedCheck ? 2 : 1});\n`);
  await writeFile(path.join(project, 'build.mjs'), "import {value} from './value.mjs'; if(value!==1) process.exit(1);\n");
  await writeFile(path.join(project, 'kodo.config.json'), JSON.stringify({ commands: { test: [{ command: process.execPath, args: ['verify.mjs'] }], build: [{ command: process.execPath, args: ['build.mjs'] }] }, ...config }));
  git(project, 'init', '-b', 'main'); git(project, 'config', 'user.name', 'Mode Engine Test'); git(project, 'config', 'user.email', 'mode@example.invalid'); git(project, 'config', 'core.autocrlf', 'false'); git(project, 'add', '.'); git(project, 'commit', '-m', 'Initial fixture');
  const store = new Store(path.join(root, 'state'));
  t.after(async () => { store.close(); assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir())); assert.ok(path.basename(root).startsWith('kodo-mode-engine-')); await rm(root, { recursive: true, force: true }); });
  const calls = [], sessions = [];
  const provider = {
    assessTask: async request => { calls.push('assessment'); assert.ok(request.files.length <= 32); return assessment(request); },
    analyzeGemini: async () => { calls.push('analysis'); return { summary: 'Fixture analysis', model: 'offline-gemini', files: [], limitations: [] }; },
    discoverProviders: async () => { calls.push('discovery'); return [ { id: 'sol', client: 'codex', model: 'gpt-6.1-sol', available: true }, { id: 'astra', client: 'codex', model: 'gpt-6-astra', available: true } ]; },
    decideJev: async () => { calls.push('routing'); return { model: 'astra', confidence: .1, parallel: true }; },
    runSession: async request => {
      sessions.push(request);
      const stage = request.schema.properties.tasks ? 'plan' : request.schema.properties.passed ? 'review' : 'worker'; calls.push(stage);
      const sessionId = `session-${sessions.length}`; request.onEvent?.({ sessionId });
      if (stage === 'plan') return { sessionId, metrics: metrics(), output: plan() };
      if (stage === 'review') {
        assert.equal(request.readOnly, true); assert.equal(request.sessionId, undefined, 'independent fresh review');
        return { sessionId, metrics: metrics(), output: { passed: !failedReview, findings: failedReview ? [{ file: 'value.mjs', severity: 'major', problem: 'Confirmed missing edge case', fix: 'Preserve the edge case' }] : [] } };
      }
      if (failedWorker) throw Object.assign(new Error('Native fixture failure'), { code: 'quota', metrics: metrics() });
      await writeFile(path.join(request.cwd, 'value.mjs'), 'export const value = 1;\n');
      return { sessionId, metrics: metrics(), output: { complete: true, summary: 'Export updated', checks: ['targeted value assertion'] } };
    }
  };
  const engine = new Engine({ store, provider, researcher: async () => { calls.push('research'); return { requests: 0, items: [], errors: [], cache: [] }; } });
  return { root, project, store, engine, calls, sessions, provider };
}

test('Quick performs one executor and fresh independent review with actual test build and head-bound gates', async t => {
  const fx = await fixture(t, { assessment: high });
  const created = await fx.engine.create('Set value to one', { project: fx.project, mode: 'quick' });
  const result = await fx.engine.run(created.id);
  assert.equal(result.state, 'succeeded', result.error?.message);
  assert.equal(result.executionMode.selected, 'quick'); assert.equal(result.executionMode.source, 'explicit');
  assert.equal(result.executionMode.risk.choice, 'high', 'assessment remains visible');
  assert.deepEqual(fx.calls, ['assessment','discovery','plan','worker','review']);
  assert.equal(fx.sessions.filter(r => !r.readOnly).length, 1);
  assert.ok(fx.sessions.every(r => r.model === 'gpt-6.1-sol'));
  assert.match(fx.sessions[0].prompt, /single developer task/i);
  assert.doesNotMatch(fx.sessions[0].prompt, /Include separate developer, tester and documenter/);
  assert.deepEqual(result.checks.results.map(row => [row.kind,row.exitCode]), [['test',0],['build',0]]);
  for (const receipt of [result.checks,result.review,result.uiVerification,result.securityChecks]) assert.equal(receipt.headSha, result.headSha);
  assert.equal(result.config.researchBudget, 0); assert.equal(result.config.concurrency, 1); assert.equal(result.config.repairRounds, 1);
  assert.equal(result.metrics.sessions, 3); assert.equal(result.metrics.toolSteps, 3); assert.equal(result.metrics.usage.totalTokens, 36); assert.equal(result.metrics.nativeRequestCount, null);
  assert.deepEqual(result.metrics.coordinatorLogicalCalls, { assessment: 1, analysis: 0, research: 0, routing: 0, discovery: 1 });
  assert.equal(result.metrics.researchRequests, 0);
  const before = fx.calls.length; await fx.engine.run(created.id); assert.equal(fx.calls.length, before);
  assert.equal(await readFile(path.join(fx.project, 'value.mjs'), 'utf8'), 'export const value = 0;\n');
});

test('Quick sessions share two account slots across Store connections and the third waits for release', async t => {
  const fx = await fixture(t);
  const runs = [];
  for (let index = 0; index < 2; index++) {
    const created = await fx.engine.create('Check independent native workflow admission', { project: fx.project, mode: 'quick' });
    runs.push(await fx.engine.run(created.id, { prepare: true }));
  }
  assert.ok(runs.every(run => run.config.concurrency === 1));
  const peer = new Store(fx.store.home), controller = new AbortController();
  let occupied = peer.acquireLease('subscription:codex', 'other-chat', { limit: 2 });
  assert.ok(occupied);
  const attempts = runs.map(() => Promise.withResolvers()), started = runs.map(() => Promise.withResolvers());
  const finish = Promise.withResolvers(), calls = [], operations = [];
  const acquire = fx.store.acquireLease.bind(fx.store);
  fx.store.acquireLease = (name, owner, options) => {
    const token = acquire(name, owner, options);
    if (name === 'subscription:codex') attempts[runs.findIndex(run => run.id === owner)]?.resolve(token);
    return token;
  };
  fx.provider.runSession = async request => {
    const index = runs.findIndex(run => run.cwd === request.cwd); calls.push(index); started[index].resolve();
    assert.equal(peer.acquireLease('subscription:codex', 'fourth-chat', { limit: 2 }), null, 'both account slots must be held at the provider boundary');
    await finish.promise;
    return { metrics: metrics(), output: { complete: true } };
  };
  try {
    operations.push(fx.engine.session(runs[0], { client: 'codex', model: 'gpt-6.1-sol', cwd: runs[0].cwd, prompt: 'Independent workflow 0', readOnly: true }, controller.signal));
    assert.ok(await attempts[0].promise, 'one occupied account slot must still admit a quick session');
    await started[0].promise;
    operations.push(fx.engine.session(runs[1], { client: 'codex', model: 'gpt-6.1-sol', cwd: runs[1].cwd, prompt: 'Independent workflow 1', readOnly: true }, controller.signal));
    assert.equal(await attempts[1].promise, null, 'the third session must wait on the shared Store');
    assert.deepEqual(calls, [0]);
    peer.releaseLease(occupied); occupied = null;
    await started[1].promise;
    assert.deepEqual(calls, [0, 1], 'release must wake the waiting workflow while the other workflow remains active');
    finish.resolve(); await Promise.all(operations);
    const available = peer.acquireLease('subscription:codex', 'after-completion', { limit: 1 });
    assert.ok(available, 'Engine sessions must release their shared leases'); peer.releaseLease(available);
  } finally {
    controller.abort(); finish.resolve();
    await Promise.allSettled(operations);
    if (occupied) peer.releaseLease(occupied);
    peer.close();
  }
});

test('Quick DAG keeps independent parallel-eligible nodes sequential with two subscription slots', async t => {
  const fx = await fixture(t);
  const created = await fx.engine.create('Implement two independent scoped nodes', { project: fx.project, mode: 'quick' });
  const run = await fx.engine.run(created.id, { prepare: true });
  run.models = await fx.provider.discoverProviders();
  run.plan = { summary: 'Two independent nodes', tasks: [
    { ...task('first'), parallel: true },
    { ...task('second'), writePaths: ['second.mjs'], parallel: true }
  ] };
  for (const node of run.plan.tasks) run.nodes[node.id] = { id: node.id, attempt: 0, status: 'pending', routing: { model: 'sol', parallel: true } };
  fx.engine.save(run);
  const order = []; let active = 0, peak = 0;
  fx.provider.runSession = async request => {
    const id = /Assigned node: (first|second) /.exec(request.prompt)?.[1];
    assert.ok(id); order.push(id); peak = Math.max(peak, ++active);
    try {
      if (id === 'second') {
        assert.equal(fx.store.getRun(run.id).nodes.first.status, 'integrated', 'independent nodes must remain sequential even when both permit parallel execution');
        assert.equal(await readFile(path.join(request.cwd, 'value.mjs'), 'utf8'), 'export const value = 1;\n');
      }
      await writeFile(path.join(request.cwd, id === 'first' ? 'value.mjs' : 'second.mjs'), 'export const value = 1;\n');
      return { metrics: metrics(), output: { complete: true, summary: 'Scoped node implemented', checks: [] } };
    } finally { active--; }
  };
  await fx.engine.executeTasks(run);
  assert.equal(run.config.concurrency, 1); assert.equal(peak, 1); assert.deepEqual(order, ['first', 'second']);
  assert.ok(run.plan.tasks.every(node => run.nodes[node.id].status === 'integrated'));
});

test('Independent task routing separates parallel confidence from model uncertainty and sends the prepared graph', async t => {
  const fx = await fixture(t);
  const run = await fx.engine.create('Implement independent module contracts', { project: fx.project, mode: 'deep' });
  await fx.engine.prepare(run);
  run.models = await fx.provider.discoverProviders();
  run.plan = { summary: 'Two isolated module deliverables', tasks: [
    { ...task('first'), writePaths: ['first.mjs'], parallel: true },
    { ...task('second'), writePaths: ['second.mjs'], parallel: true }
  ] };
  const state = run.nodes.first = { id: 'first', attempt: 0 };
  fx.engine.save(run);
  fx.provider.decideJev = async request => {
    assert.deepEqual(request.node.coordination.map(n => n.id), ['first','second']);
    assert.deepEqual(request.node.coordination.map(n => n.writePaths), [['first.mjs'],['second.mjs']]);
    return { model: 'sol', parallel: true, confidence: .1, modelConfidence: .2, parallelConfidence: .95, sessionConfidence: .1 };
  };
  const selected = await fx.engine.route(run, run.plan.tasks[0], state);
  assert.equal(selected.id, 'astra'); assert.equal(state.routing.parallel, true);
  fx.provider.decideJev = async () => ({ model: 'sol', parallel: true, confidence: .9, modelConfidence: .9, parallelConfidence: .2 });
  await fx.engine.route(run, run.plan.tasks[0], state);
  assert.equal(state.routing.parallel, false);
  fx.provider.decideJev = async () => ({ model: 'sol', parallel: true, confidence: .9, parallelConfidence: 2 });
  await assert.rejects(fx.engine.route(run, run.plan.tasks[0], state), /контракт/i);
});

test('Automatic assessment precedes expensive analysis and project mode is overridden by explicit mode', async t => {
  const fx = await fixture(t, { config: { executionMode: 'deep', researchBudget: 2, repairRounds: 2, concurrency: 1 } });
  const explicit = await fx.engine.create('Set value to one', { project: fx.project, mode: 'standard' });
  const result = await fx.engine.run(explicit.id, { prepare: true });
  assert.equal(result.state, 'awaiting_plan'); assert.equal(result.executionMode.selected, 'standard');
  assert.deepEqual(fx.calls, ['assessment','analysis','research']);
  assert.equal(result.config.researchBudget, 2); assert.equal(result.config.repairRounds, 2); assert.equal(result.config.concurrency, 1);
  assert.equal(result.executionMode.profile.maxTasks, 12);
  const auto = await fixture(t); const run = await auto.engine.create('Set value to one', { project: auto.project });
  const prepared = await auto.engine.run(run.id, { prepare: true });
  assert.equal(prepared.executionMode.selected, 'quick'); assert.equal(prepared.executionMode.source, 'jev');
  assert.deepEqual(auto.calls, ['assessment']);
});

test('Quick prepare persists selection across config changes and resumes without repeated assessment or analysis', async t => {
  const fx = await fixture(t); const run = await fx.engine.create('Set value to one', { project: fx.project, mode: 'quick' });
  const prepared = await fx.engine.run(run.id, { prepare: true });
  assert.equal(prepared.state, 'awaiting_plan'); assert.equal(prepared.analysis.kind, 'local');
  assert.ok(prepared.analysis.files.includes('value.mjs')); assert.equal(prepared.research.requests, 0);
  await writeFile(path.join(fx.project, 'kodo.config.json'), JSON.stringify({ executionMode: 'deep' }));
  const result = await fx.engine.run(run.id);
  assert.equal(result.state, 'succeeded', result.error?.message); assert.equal(result.executionMode.selected, 'quick');
  assert.equal(fx.calls.filter(c => c === 'assessment').length, 1); assert.equal(fx.calls.includes('analysis'), false);
  assert.equal(fx.store.events(run.id).filter(e => e.type === 'mode_selected').length, 1);
});

test('Malformed or unavailable assessment records honest standard fallback and abort is propagated', async t => {
  for (const assessment of [() => ({ fallback: false, complexity: 'bad', requests: 1 }), () => { throw new Error('offline'); }]) {
    const fx = await fixture(t, { assessment }); const run = await fx.engine.create('Set value to one', { project: fx.project });
    const result = await fx.engine.run(run.id, { prepare: true });
    assert.equal(result.state, 'awaiting_plan'); assert.equal(result.executionMode.selected, 'standard'); assert.equal(result.executionMode.fallback, true);
    assert.equal(result.executionMode.confidence, null); assert.deepEqual(fx.calls, ['assessment','analysis','research']);
  }
  const fx = await fixture(t, { assessment: () => { throw Object.assign(new Error('aborted'), { name: 'AbortError' }); } });
  const run = await fx.engine.create('Set value to one', { project: fx.project }); const result = await fx.engine.run(run.id);
  assert.equal(result.state, 'cancelled'); assert.deepEqual(fx.calls, ['assessment']);
});

test('Legacy saved analysis receives compatibility standard policy without repeating completed analysis', async t => {
  const fx = await fixture(t); const run = await fx.engine.create('Set value to one', { project: fx.project });
  run.completed.analysis = { baseSha: run.baseSha, inputHash: 'legacy' }; run.analysis = { summary: 'Saved old analysis' }; run.research = { items: [], errors: [], cache: [], requests: 0 }; delete run.executionMode; delete run.requestedMode; fx.engine.save(run);
  const result = await fx.engine.run(run.id, { prepare: true });
  assert.equal(result.state, 'awaiting_plan'); assert.equal(result.executionMode.selected, 'standard'); assert.equal(result.executionMode.source, 'compatibility');
  assert.deepEqual(fx.calls, []); assert.equal(result.analysis.summary, 'Saved old analysis');
});

test('Mode plan limits reject oversized host and native plans before any executor', async t => {
  for (const mode of ['quick','standard']) {
    const maxTasks = mode === 'quick' ? 2 : 12;
    const oversized = () => ({ summary: 'Too many tasks', tasks: Array.from({ length: maxTasks + 1 }, (_, i) => task(`task-${i}`)) });
    const fx = await fixture(t, { plan: oversized }); const run = await fx.engine.create('Set value to one', { project: fx.project, mode });
    const result = await fx.engine.run(run.id); assert.equal(result.state, 'blocked'); assert.equal(result.error.code, 'invalid_plan'); assert.equal(fx.calls.includes('worker'), false);
    const file = path.join(fx.root, 'host-plan.json'); await writeFile(file, JSON.stringify(oversized()));
    const hostRun = await fx.engine.create('Set value to one', { project: fx.project, mode });
    const hostResult = await fx.engine.run(hostRun.id, { planFile: file }); assert.equal(hostResult.state, 'blocked'); assert.equal(hostResult.error.code, 'invalid_plan');
  }
});

test('Explicit model stays fixed for planner worker reviewer and retries despite uncertain strongest routing', async t => {
  for (const mode of ['quick','standard','deep']) {
    const fx = await fixture(t, { config: { primaryModel: 'gpt-6-astra' } }); let rejected = false;
    const original = fx.provider.runSession;
    fx.provider.runSession = async request => {
      const result = await original(request);
      if (mode !== 'quick' && request.schema.properties.passed && !rejected) { rejected = true; result.output = { passed: false, findings: [{ file: 'value.mjs', severity: 'major', problem: 'Confirmed missing condition', fix: 'Check the required condition' }] }; }
      return result;
    };
    const run = await fx.engine.create('Set value to one', { project: fx.project, mode, model: 'gpt-6.1-sol' });
    // create() normalizes primaryModel to the explicit model; preserve a
    // different saved default so every later stage must honor fixedModel.
    run.config.primaryModel = 'gpt-6-astra'; fx.engine.save(run);
    const result = await fx.engine.run(run.id); assert.equal(result.state, 'succeeded', result.error?.message);
    assert.ok(fx.sessions.every(r => r.model === 'gpt-6.1-sol')); assert.equal(fx.calls.includes('routing'), false);
    if (mode !== 'quick') assert.equal(fx.calls.filter(c => c === 'review').length, 2, 'confirmed review failure triggers a fixed-model repair and fresh review');
  }
});

test('Quick failure keeps actual failed checks and independent review findings without extra research or repair', async t => {
  for (const options of [{ failedCheck: true }, { failedReview: true }]) {
    const fx = await fixture(t, options); const run = await fx.engine.create('Set value to one', { project: fx.project, mode: 'quick' });
    const result = await fx.engine.run(run.id); assert.equal(result.state, 'blocked'); assert.equal(result.controllerAssessment.attempts, 1);
    if (options.failedCheck) { assert.equal(result.checks.results[0].exitCode, 1); assert.equal(fx.calls.includes('review'), false); }
    else { assert.equal(result.review.passed, false); assert.equal(result.review.findings[0].severity, 'major'); assert.equal(result.review.headSha, result.headSha); }
    assert.equal(fx.calls.includes('research'), false); assert.equal(fx.calls.filter(c => c === 'worker').length, 1);
    await fx.engine.moreResearch(result, 'Confirmed blocker'); assert.equal(fx.calls.includes('research'), false);
  }
});

test('Quick retains configured UI and security gates and missing tools block delivery without escalation', async t => {
  const fx = await fixture(t, { config: {
    uiVerification: { enabled: true, autoInstall: false, cases: [{ id: 'button', tool: 'browser-harness', url: 'http://127.0.0.1:1', assertions: [{ selector: 'button', text: 'Ready' }] }] },
    security: { enabled: true, autoInstall: false, tools: ['gitleaks'] }
  } });
  fx.engine.gates.runUIVerification = request => runUIVerification({ ...request, toolHome: path.join(fx.root, 'missing-tools') });
  fx.engine.gates.runSecurityChecks = request => runSecurityChecks({ ...request, toolHome: path.join(fx.root, 'missing-tools') });
  const run = await fx.engine.create('Set value to one', { project: fx.project, mode: 'quick' }); const result = await fx.engine.run(run.id);
  assert.equal(result.state, 'blocked'); assert.equal(result.executionMode.selected, 'quick');
  assert.equal(result.uiVerification.passed, false); assert.equal(result.securityChecks.passed, false);
  assert.equal(result.uiVerification.headSha, result.checks.headSha); assert.equal(result.securityChecks.headSha, result.checks.headSha);
  assert.equal(result.securityChecks.tools[0].reason, 'tool_missing'); assert.equal(fx.calls.includes('review'), false);
  assert.equal(fx.calls.includes('research'), false); assert.equal(fx.store.events(run.id).filter(e => e.type === 'model_escalated').length, 0);
});

test('Truncated assessment context cannot auto-select quick and lower configured task caps are enforced', async t => {
  const fx = await fixture(t, { config: { maxTasks: 1 } });
  await writeFile(path.join(fx.project, 'large.txt'), 'x'.repeat(2049)); git(fx.project, 'add', '.'); git(fx.project, 'commit', '-m', 'Larger classifier context');
  const run = await fx.engine.create('Set value to one; inspect large.txt', { project: fx.project }); const prepared = await fx.engine.run(run.id, { prepare: true });
  assert.equal(prepared.executionMode.contextTruncated, true); assert.equal(prepared.executionMode.selected, 'standard'); assert.equal(prepared.executionMode.profile.maxTasks, 1);
  const planFile = path.join(fx.root, 'two-tasks.json'); await writeFile(planFile, JSON.stringify({ summary: 'Too many', tasks: [task('one'), task('two')] }));
  const result = await fx.engine.run(run.id, { planFile }); assert.equal(result.state, 'blocked'); assert.equal(result.error.code, 'invalid_plan'); assert.equal(fx.calls.includes('worker'), false);
});

test('Automatic quick for a named local CSS change ignores unrelated project size without hiding focused truncation', async t => {
  const fx = await fixture(t); await mkdir(path.join(fx.project, 'src')); await mkdir(path.join(fx.project, 'unrelated'));
  await writeFile(path.join(fx.project, 'src/button.css'), 'button { color: blue; }\nbutton:focus { outline: auto; }\n');
  for (let index = 0; index < 80; index++) await writeFile(path.join(fx.project, 'unrelated', `module-${index}.mjs`), `// unrelated ${index}\n${'x'.repeat(3000)}`);
  git(fx.project, 'add', '.'); git(fx.project, 'commit', '-m', 'Large project with a localized button');
  const original = fx.provider.assessTask; let map;
  fx.provider.assessTask = request => { map = request.files; return original(request); };
  const run = await fx.engine.create('Change src/button.css button color from blue to red preserving focus', { project: fx.project });
  const result = await fx.engine.run(run.id, { prepare: true });
  assert.equal(result.state, 'awaiting_plan'); assert.equal(result.executionMode.selected, 'quick'); assert.equal(result.executionMode.contextTruncated, false);
  assert.deepEqual(fx.calls, ['assessment']); assert.ok(map.length <= 32);
  assert.match(map.find(file => file.path === 'src/button.css').content, /color: blue/);
  assert.ok(map.every(file => !file.path.startsWith('unrelated/') || file.content === undefined), 'unrelated source is not task context');
});

test('Unknown native usage stays null and an unavailable explicit model never switches to another model', async t => {
  const fx = await fixture(t); const original = fx.provider.runSession;
  fx.provider.runSession = async request => { const result = await original(request); delete result.metrics; return result; };
  const run = await fx.engine.create('Set value to one', { project: fx.project, mode: 'quick' }); const result = await fx.engine.run(run.id);
  assert.equal(result.state, 'succeeded', result.error?.message); assert.equal(result.metrics.sessions, 3); assert.equal(result.metrics.usage.totalTokens, null); assert.equal(result.metrics.toolSteps, null); assert.equal(result.metrics.completeness.usage.totalTokens.complete, false);
  assert.ok(result.metrics.durationMs >= 0);
  const unavailable = await fixture(t); unavailable.provider.discoverProviders = async () => [{ id: 'astra', client: 'codex', model: 'gpt-6-astra', available: true }];
  const fixed = await unavailable.engine.create('Set value to one', { project: unavailable.project, mode: 'quick', model: 'gpt-6.1-sol' });
  const blocked = await unavailable.engine.run(fixed.id); assert.equal(blocked.state, 'blocked'); assert.equal(blocked.error.code, 'auth'); assert.equal(unavailable.sessions.length, 0);
});

test('Native failed attempts retain metrics and logical research requests exclude cache reuse', async t => {
  const fx = await fixture(t, { failedWorker: true }); const run = await fx.engine.create('Set value to one', { project: fx.project, mode: 'quick' });
  const result = await fx.engine.run(run.id); assert.equal(result.state, 'waiting_limits');
  assert.equal(result.metrics.sessions, 2); assert.equal(result.metrics.usage.totalTokens, 24); assert.equal(result.metrics.toolSteps, 2);
  assert.equal(result.sessionAttempts[1].status, 'failed'); assert.equal(result.sessionAttempts[1].errorCode, 'quota');
  const standard = await fixture(t); standard.engine.researcher = async () => ({ requests: 0, items: [{ source: 'cache' }], errors: [], cache: ['cached'] });
  const next = await standard.engine.create('Set value to one', { project: standard.project, mode: 'standard' });
  const prepared = await standard.engine.run(next.id, { prepare: true }); assert.equal(prepared.metrics.coordinatorLogicalCalls.research, 1); assert.equal(prepared.metrics.researchRequests, 0);
});

test('Execution mode config accepts only public modes and rejects invalid mode before provider startup', async t => {
  const fx = await fixture(t);
  for (const value of ['quick','standard','deep']) { await writeFile(path.join(fx.project, 'kodo.config.json'), JSON.stringify({ executionMode: value })); assert.equal((await readConfig(fx.project)).executionMode, value); }
  for (const value of ['auto','QUICK',null,3]) { await writeFile(path.join(fx.project, 'kodo.config.json'), JSON.stringify({ executionMode: value })); await assert.rejects(readConfig(fx.project), /mode|режим/i); }
  await writeFile(path.join(fx.project, 'kodo.config.json'), '{}'); await assert.rejects(fx.engine.create('Task', { project: fx.project, mode: 'invalid' }), /mode|режим/i);
});

test('Top-level benchmark parser runs before project provider and SQLite startup', () => {
  const result = spawnSync(process.execPath, ['cli/index.mjs','benchmark','report'], { cwd: path.resolve(import.meta.dirname, '..'), encoding: 'utf8', windowsHide: true, env: { ...process.env, KODO_HOME: 'Z:\\missing\\private' } });
  assert.equal(result.status, 1); assert.match(result.stderr, /requires one PATH/); assert.doesNotMatch(result.stderr, /SQLite|credential|подпис|Неизвестн/);
});

test('Node no-progress detection distinguishes changed tracked and untracked contents with identical porcelain', async t => {
  for (const untracked of [false,true]) {
    const fx = await fixture(t, { config: { executionMode: 'deep', repairRounds: 4, researchBudget: 0 }, plan: () => ({ summary: 'Continue real content progress', tasks: [{ ...task('fix'), writePaths: ['value.mjs','notes.txt'] }] }) });
    const original = fx.provider.runSession; let attempts = 0;
    fx.provider.runSession = async request => {
      if (!request.schema.properties.tasks && !request.schema.properties.passed) {
        attempts++;
        if (attempts < 3) {
          await writeFile(path.join(request.cwd, untracked ? 'notes.txt' : 'value.mjs'), untracked ? `progress ${attempts}\n` : `export const value = 0; // progress ${attempts}\n`);
          return { metrics: metrics(), output: { complete: false, summary: 'Same remaining requirement', checks: [] } };
        }
      }
      return original(request);
    };
    const run = await fx.engine.create('Set value to one', { project: fx.project }); const result = await fx.engine.run(run.id);
    assert.equal(result.state, 'succeeded', `${untracked ? 'untracked' : 'tracked'} content: ${result.error?.message}`); assert.equal(attempts, 3);
    assert.equal(result.nodes.fix.attempt, 3); assert.equal(result.nodes.fix.stopped, undefined);
  }
});

test('Rewriting identical untracked bytes with a new timestamp stops at no progress before the repair cap', async t => {
  const fx = await fixture(t, {
    config: { executionMode: 'deep', repairRounds: 4, researchBudget: 0 },
    plan: () => ({ summary: 'One scoped deliverable', tasks: [{ ...task('fix'), writePaths: ['value.mjs', 'notes.txt'] }] })
  });
  const original = fx.provider.runSession;
  let attempts = 0, previousTimestamp;
  fx.provider.runSession = async request => {
    if (request.schema.properties.tasks || request.schema.properties.passed) return original(request);
    attempts++;
    const file = path.join(request.cwd, 'notes.txt');
    await writeFile(file, 'Same unfinished work\n');
    await utimes(file, 1700000000 + attempts, 1700000000 + attempts);
    const timestamp = (await stat(file)).mtimeMs;
    if (previousTimestamp !== undefined) assert.notEqual(timestamp, previousTimestamp, 'the witness changes metadata but preserves bytes');
    previousTimestamp = timestamp;
    return { metrics: metrics(), output: { complete: false, summary: 'Still missing the same requirement', checks: [] } };
  };
  const run = await fx.engine.create('Set value to one', { project: fx.project });
  const blocked = await fx.engine.run(run.id);
  assert.equal(blocked.state, 'blocked');
  assert.equal(blocked.nodes.fix.stopped, 'no_progress');
  assert.equal(blocked.nodes.fix.attempt, 2);
  assert.equal(blocked.controllerAssessment.reason, 'no_progress');
  assert.equal(attempts, 2);
  assert.equal(fx.calls.includes('research'), false);
  assert.equal((await fx.engine.run(run.id)).state, 'blocked');
  assert.equal(attempts, 2, 'ordinary resume cannot reset a stopped cycle');
});

test('Review quota recovery reuses successful checks only while their exact head is unchanged', async t => {
  const cases = [
    { name: 'unchanged head reuses checks' },
    { name: 'changed head reruns checks', changedHead: true },
    { name: 'changed test command reruns checks', changedCommand: 'test' },
    { name: 'changed build command reruns checks', changedCommand: 'build' }
  ];
  for (const { name, changedHead = false, changedCommand } of cases) await t.test(name, async subtest => {
    const fx = await fixture(subtest, { config: {
      uiVerification: { enabled: true, autoInstall: false, cases: [{ id: 'ready', tool: 'browser-harness', url: 'http://127.0.0.1:1', assertions: [{ selector: 'body', text: 'Ready' }] }] }
    } });
    let uiCalls = 0, securityCalls = 0;
    fx.engine.gates.runUIVerification = request => runUIVerification({ ...request, caseRunner: async () => {
      uiCalls++;
      return { schemaVersion: 1, status: 'completed', observations: [{ exists: true, count: 1, text: 'Ready', value: null }] };
    } });
    fx.engine.gates.runSecurityChecks = request => { securityCalls++; return runSecurityChecks(request); };
    const log = path.join(fx.root, 'check-executions.txt');
    for (const [file, label] of [['verify.mjs', 'test'], ['build.mjs', 'build']]) {
      const source = await readFile(path.join(fx.project, file), 'utf8');
      await writeFile(path.join(fx.project, file), source + `import { appendFileSync } from 'node:fs'; appendFileSync(${JSON.stringify(log)}, ${JSON.stringify(label + '\n')});\n`);
    }
    git(fx.project, 'add', '.'); git(fx.project, 'commit', '-m', 'Observe actual check command executions');
    const original = fx.provider.runSession;
    let quota = true;
    fx.provider.runSession = async request => {
      const response = await original(request);
      if (request.schema.properties.passed && quota) {
        quota = false;
        throw Object.assign(new Error('Review quota fixture'), { code: 'quota', metrics: metrics() });
      }
      return response;
    };
    const created = await fx.engine.create('Set value to one', { project: fx.project, mode: 'quick', model: 'gpt-6.1-sol' });
    const waiting = await fx.engine.run(created.id);
    assert.equal(waiting.state, 'waiting_limits');
    assert.deepEqual(waiting.checks.results.map(row => [row.kind, row.exitCode]), [['test', 0], ['build', 0]]);
    assert.equal(waiting.uiVerification.passed, true);
    assert.equal(uiCalls, 1); assert.equal(securityCalls, 1);
    const checkedHead = waiting.checks.headSha;
    if (changedHead) {
      await writeFile(path.join(waiting.cwd, 'value.mjs'), 'export const value = 1; // new scoped head\n');
      git(waiting.cwd, 'add', 'value.mjs'); git(waiting.cwd, 'commit', '-m', 'Change the checked implementation head');
    }
    if (changedCommand) {
      const saved = fx.store.getRun(created.id);
      saved.config.commands[changedCommand][0].args.unshift(`--conditions=kodo-${changedCommand}-config-change`);
      fx.store.updateRun(created.id, { config: saved.config });
    }
    const resumed = await fx.engine.run(created.id);
    assert.equal(resumed.state, 'succeeded', resumed.error?.message);
    assert.equal(resumed.executionMode.selected, 'quick');
    assert.equal(resumed.metrics.sessions, 4, 'the failed native review remains in metrics');
    assert.equal(fx.calls.filter(call => call === 'assessment').length, 1);
    assert.equal(fx.calls.filter(call => call === 'plan').length, 1);
    assert.equal(fx.calls.filter(call => call === 'worker').length, 1);
    assert.equal(fx.calls.filter(call => call === 'review').length, 2);
    assert.ok(fx.sessions.every(request => request.model === 'gpt-6.1-sol'));
    assert.equal(uiCalls, 2, 'enabled UI observations must be fresh even when local checks are reused');
    assert.equal(securityCalls, 2, 'security gate invocation remains separate from local check reuse');
    for (const receipt of [resumed.checks, resumed.review, resumed.uiVerification, resumed.securityChecks]) assert.equal(receipt.headSha, resumed.headSha);
    if (changedHead) assert.notEqual(resumed.headSha, checkedHead);
    else assert.equal(resumed.headSha, checkedHead);
    if (changedCommand) assert.deepEqual(resumed.checks.results.find(row => row.kind === changedCommand).command.args, [`--conditions=kodo-${changedCommand}-config-change`, changedCommand === 'test' ? 'verify.mjs' : 'build.mjs']);
    assert.deepEqual((await readFile(log, 'utf8')).trim().split('\n'), changedHead || changedCommand ? ['test', 'build', 'test', 'build'] : ['test', 'build'], 'unchanged successful checks must be reused, while a new head or check configuration requires actual commands');
  });
});

test('Review quota recovery cannot reuse a previous enabled UI pass after observations fail', async t => {
  const fx = await fixture(t, { config: {
    uiVerification: { enabled: true, autoInstall: false, cases: [{ id: 'ready', tool: 'browser-harness', url: 'http://127.0.0.1:1', assertions: [{ selector: 'body', text: 'Ready' }] }] }
  } });
  let observations = 0, quota = true;
  fx.engine.gates.runUIVerification = request => runUIVerification({ ...request, caseRunner: async () => {
    observations++;
    return { schemaVersion: 1, status: 'completed', observations: [{ exists: true, count: 1, text: observations === 1 ? 'Ready' : 'Broken', value: null }] };
  } });
  const original = fx.provider.runSession;
  fx.provider.runSession = async request => {
    const response = await original(request);
    if (request.schema.properties.passed && quota) {
      quota = false;
      throw Object.assign(new Error('Review quota fixture'), { code: 'quota', metrics: metrics() });
    }
    return response;
  };
  const created = await fx.engine.create('Set value to one', { project: fx.project, mode: 'quick' });
  const waiting = await fx.engine.run(created.id);
  assert.equal(waiting.state, 'waiting_limits'); assert.equal(waiting.uiVerification.passed, true);
  const checkedHead = waiting.checks.headSha;
  const resumed = await fx.engine.run(created.id);
  assert.equal(resumed.state, 'blocked');
  assert.equal(resumed.checks.headSha, checkedHead);
  assert.equal(resumed.uiVerification.headSha, checkedHead);
  assert.equal(observations, 2);
  assert.equal(resumed.uiVerification.passed, false);
  assert.equal(resumed.uiVerification.cases[0].assertions[0].passed, false);
  assert.equal(resumed.review, null);
  assert.equal(fx.calls.filter(call => call === 'review').length, 1, 'newly failed UI evidence must prevent another review success');
});

test('Quick rejects contradictory passing review receipts with blocker or major findings', async t => {
  for (const severity of ['blocker', 'major']) await t.test(severity, async subtest => {
    const fx = await fixture(subtest);
    const original = fx.provider.runSession;
    fx.provider.runSession = async request => {
      const response = await original(request);
      if (request.schema.properties.passed) response.output = {
        passed: true,
        findings: [{ file: 'value.mjs', severity, problem: 'A confirmed acceptance condition is missing', fix: 'Implement the missing condition' }]
      };
      return response;
    };
    const run = await fx.engine.create('Set value to one', { project: fx.project, mode: 'quick' });
    const result = await fx.engine.run(run.id);
    assert.equal(result.state, 'blocked');
    assert.deepEqual(result.checks.results.map(row => row.exitCode), [0, 0]);
    assert.equal(result.review.passed, false, 'severity overrides the reviewer success boolean');
    assert.equal(result.review.findings[0].severity, severity);
    assert.equal(result.review.headSha, result.headSha);
    assert.equal(result.controllerAssessment.attempts, 1);
    assert.deepEqual(fx.calls, ['assessment', 'discovery', 'plan', 'worker', 'review']);
  });
});
