import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Store } from '../runtime/store.mjs';
import { high, task, metrics, fixture } from './helpers/mode-engine-fixture.mjs';

test('Quick performs one executor and fresh independent review with actual test build and head-bound gates', async t => {
  const fx = await fixture(t, { assessment: high });
  const created = await fx.engine.create('Set value to one', { project: fx.project, mode: 'quick' });
  const result = await fx.engine.run(created.id);
  assert.equal(result.state, 'succeeded', result.error?.message);
  assert.equal(result.executionMode.selected, 'quick');
  assert.equal(result.executionMode.source, 'explicit');
  assert.equal(result.executionMode.risk.choice, 'high', 'assessment remains visible');
  assert.deepEqual(fx.calls, ['assessment', 'discovery', 'plan', 'worker', 'review']);
  assert.equal(fx.sessions.filter(r => !r.readOnly).length, 1);
  assert.ok(fx.sessions.every(r => r.model === 'gpt-6.1-sol'));
  assert.match(fx.sessions[0].prompt, /single developer task/i);
  assert.doesNotMatch(fx.sessions[0].prompt, /Include separate developer, tester and documenter/);
  assert.deepEqual(
    result.checks.results.map(row => [row.kind, row.exitCode]),
    [
      ['test', 0],
      ['build', 0],
    ],
  );
  for (const receipt of [result.checks, result.review, result.uiVerification, result.securityChecks])
    assert.equal(receipt.headSha, result.headSha);
  assert.equal(result.config.researchBudget, 0);
  assert.equal(result.config.concurrency, 1);
  assert.equal(result.config.repairRounds, 1);
  assert.equal(result.metrics.sessions, 3);
  assert.equal(result.metrics.toolSteps, 3);
  assert.equal(result.metrics.usage.totalTokens, 36);
  assert.equal(result.metrics.nativeRequestCount, null);
  assert.deepEqual(result.metrics.coordinatorLogicalCalls, {
    assessment: 1,
    analysis: 0,
    research: 0,
    routing: 0,
    discovery: 1,
  });
  assert.equal(result.metrics.researchRequests, 0);
  const before = fx.calls.length;
  await fx.engine.run(created.id);
  assert.equal(fx.calls.length, before);
  assert.equal(await readFile(path.join(fx.project, 'value.mjs'), 'utf8'), 'export const value = 0;\n');
});

test('Quick sessions share two account slots across Store connections and the third waits for release', async t => {
  const fx = await fixture(t);
  const runs = [];
  for (let index = 0; index < 2; index++) {
    const created = await fx.engine.create('Check independent native workflow admission', {
      project: fx.project,
      mode: 'quick',
    });
    runs.push(await fx.engine.run(created.id, { prepare: true }));
  }
  assert.ok(runs.every(run => run.config.concurrency === 1));
  const peer = new Store(fx.store.home),
    controller = new AbortController();
  let occupied = peer.acquireLease('subscription:codex', 'other-chat', { limit: 2 });
  assert.ok(occupied);
  const attempts = runs.map(() => Promise.withResolvers()),
    started = runs.map(() => Promise.withResolvers());
  const finish = Promise.withResolvers(),
    calls = [],
    operations = [];
  const acquire = fx.store.acquireLease.bind(fx.store);
  fx.store.acquireLease = (name, owner, options) => {
    const token = acquire(name, owner, options);
    if (name === 'subscription:codex') attempts[runs.findIndex(run => run.id === owner)]?.resolve(token);
    return token;
  };
  fx.provider.runSession = async request => {
    const index = runs.findIndex(run => run.cwd === request.cwd);
    calls.push(index);
    started[index].resolve();
    assert.equal(
      peer.acquireLease('subscription:codex', 'fourth-chat', { limit: 2 }),
      null,
      'both account slots must be held at the provider boundary',
    );
    await finish.promise;
    return { metrics: metrics(), output: { complete: true } };
  };
  try {
    operations.push(
      fx.engine.session(
        runs[0],
        { client: 'codex', model: 'gpt-6.1-sol', cwd: runs[0].cwd, prompt: 'Independent workflow 0', readOnly: true },
        controller.signal,
      ),
    );
    assert.ok(await attempts[0].promise, 'one occupied account slot must still admit a quick session');
    await started[0].promise;
    operations.push(
      fx.engine.session(
        runs[1],
        { client: 'codex', model: 'gpt-6.1-sol', cwd: runs[1].cwd, prompt: 'Independent workflow 1', readOnly: true },
        controller.signal,
      ),
    );
    assert.equal(await attempts[1].promise, null, 'the third session must wait on the shared Store');
    assert.deepEqual(calls, [0]);
    peer.releaseLease(occupied);
    occupied = null;
    await started[1].promise;
    assert.deepEqual(calls, [0, 1], 'release must wake the waiting workflow while the other workflow remains active');
    finish.resolve();
    await Promise.all(operations);
    const available = peer.acquireLease('subscription:codex', 'after-completion', { limit: 1 });
    assert.ok(available, 'Engine sessions must release their shared leases');
    peer.releaseLease(available);
  } finally {
    controller.abort();
    finish.resolve();
    await Promise.allSettled(operations);
    if (occupied) peer.releaseLease(occupied);
    peer.close();
  }
});

test('Quick DAG keeps independent parallel-eligible nodes sequential with two subscription slots', async t => {
  const fx = await fixture(t);
  const created = await fx.engine.create('Implement two independent scoped nodes', {
    project: fx.project,
    mode: 'quick',
  });
  const run = await fx.engine.run(created.id, { prepare: true });
  run.models = await fx.provider.discoverProviders();
  run.plan = {
    summary: 'Two independent nodes',
    tasks: [
      { ...task('first'), parallel: true },
      { ...task('second'), writePaths: ['second.mjs'], parallel: true },
    ],
  };
  for (const node of run.plan.tasks)
    run.nodes[node.id] = { id: node.id, attempt: 0, status: 'pending', routing: { model: 'sol', parallel: true } };
  fx.engine.save(run);
  const order = [];
  let active = 0,
    peak = 0;
  fx.provider.runSession = async request => {
    const id = /Assigned node: (first|second) /.exec(request.prompt)?.[1];
    assert.ok(id);
    order.push(id);
    peak = Math.max(peak, ++active);
    try {
      if (id === 'second') {
        assert.equal(
          fx.store.getRun(run.id).nodes.first.status,
          'integrated',
          'independent nodes must remain sequential even when both permit parallel execution',
        );
        assert.equal(await readFile(path.join(request.cwd, 'value.mjs'), 'utf8'), 'export const value = 1;\n');
      }
      await writeFile(path.join(request.cwd, id === 'first' ? 'value.mjs' : 'second.mjs'), 'export const value = 1;\n');
      return { metrics: metrics(), output: { complete: true, summary: 'Scoped node implemented', checks: [] } };
    } finally {
      active--;
    }
  };
  await fx.engine.executeTasks(run);
  assert.equal(run.config.concurrency, 1);
  assert.equal(peak, 1);
  assert.deepEqual(order, ['first', 'second']);
  assert.ok(run.plan.tasks.every(node => run.nodes[node.id].status === 'integrated'));
});

test('Legacy saved analysis receives compatibility standard policy without repeating completed analysis', async t => {
  const fx = await fixture(t);
  const run = await fx.engine.create('Set value to one', { project: fx.project });
  run.completed.analysis = { baseSha: run.baseSha, inputHash: 'legacy' };
  run.analysis = { summary: 'Saved old analysis' };
  run.research = { items: [], errors: [], cache: [], requests: 0 };
  delete run.executionMode;
  delete run.requestedMode;
  fx.engine.save(run);
  const result = await fx.engine.run(run.id, { prepare: true });
  assert.equal(result.state, 'awaiting_plan');
  assert.equal(result.executionMode.selected, 'standard');
  assert.equal(result.executionMode.source, 'compatibility');
  assert.deepEqual(fx.calls, []);
  assert.equal(result.analysis.summary, 'Saved old analysis');
});

test('Explicit model stays fixed for planner worker reviewer and retries despite uncertain strongest routing', async t => {
  for (const mode of ['quick', 'standard', 'deep']) {
    const fx = await fixture(t, { config: { primaryModel: 'gpt-6-astra' } });
    let rejected = false;
    const original = fx.provider.runSession;
    fx.provider.decideJev = async request => {
      fx.calls.push('routing');
      assert.deepEqual(
        request.models.map(({ client, model }) => ({ client, model })),
        [{ client: 'codex', model: 'gpt-6.1-sol' }],
      );
      return {
        model: request.models[0].id,
        confidence: 0.1,
        modelConfidence: 0.1,
        parallelConfidence: 0.95,
        parallel: true,
      };
    };
    fx.provider.runSession = async request => {
      const result = await original(request);
      if (mode !== 'quick' && request.schema.properties.passed && !rejected) {
        rejected = true;
        result.output = {
          passed: false,
          findings: [
            {
              file: 'value.mjs',
              severity: 'major',
              problem: 'Confirmed missing condition',
              fix: 'Check the required condition',
            },
          ],
        };
      }
      return result;
    };
    const run = await fx.engine.create('Set value to one', { project: fx.project, mode, model: 'gpt-6.1-sol' });
    // create() normalizes primaryModel to the explicit model; preserve a
    // different saved default so every later stage must honor fixedModel.
    run.config.primaryModel = 'gpt-6-astra';
    fx.engine.save(run);
    const result = await fx.engine.run(run.id);
    assert.equal(result.state, 'succeeded', result.error?.message);
    assert.ok(fx.sessions.every(r => r.model === 'gpt-6.1-sol'));
    assert.equal(fx.calls.includes('routing'), mode !== 'quick');
    assert.equal(fx.store.events(run.id).filter(event => event.type === 'model_escalated').length, 0);
    if (mode !== 'quick')
      assert.equal(
        fx.calls.filter(c => c === 'review').length,
        2,
        'confirmed review failure triggers a fixed-model repair and fresh review',
      );
  }
});

test('Unknown native usage stays null and an unavailable explicit model never switches to another model', async t => {
  const fx = await fixture(t);
  const original = fx.provider.runSession;
  fx.provider.runSession = async request => {
    const result = await original(request);
    delete result.metrics;
    return result;
  };
  const run = await fx.engine.create('Set value to one', { project: fx.project, mode: 'quick' });
  const result = await fx.engine.run(run.id);
  assert.equal(result.state, 'succeeded', result.error?.message);
  assert.equal(result.metrics.sessions, 3);
  assert.equal(result.metrics.usage.totalTokens, null);
  assert.equal(result.metrics.toolSteps, null);
  assert.equal(result.metrics.completeness.usage.totalTokens.complete, false);
  assert.ok(result.metrics.durationMs >= 0);
  const unavailable = await fixture(t);
  unavailable.provider.discoverProviders = async () => [
    { id: 'astra', client: 'codex', model: 'gpt-6-astra', available: true },
  ];
  const fixed = await unavailable.engine.create('Set value to one', {
    project: unavailable.project,
    mode: 'quick',
    model: 'gpt-6.1-sol',
  });
  const blocked = await unavailable.engine.run(fixed.id);
  assert.equal(blocked.state, 'blocked');
  assert.equal(blocked.error.code, 'auth');
  assert.equal(unavailable.sessions.length, 0);
});
