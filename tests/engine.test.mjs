import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Engine } from '../runtime/engine.mjs';
import {
  read,
  exists,
  git,
  fixture,
  node,
  fakeServices,
  integrationConflict,
  combinedModule,
} from './helpers/engine-fixture.mjs';

test('Engine gates checks before review persists disabled receipts and rebuilds progress on resume', async t => {
  const fx = await fixture(t),
    services = fakeServices(),
    engine = new Engine({ store: fx.openStore(), ...services });
  const run = await engine.create('Gate the feature', { project: fx.project });
  const result = await engine.run(run.id);
  assert.equal(result.state, 'succeeded', result.error?.message);
  assert.equal(result.uiVerification.status, 'disabled');
  assert.equal(result.uiVerification.passed, null);
  assert.equal(result.securityChecks.status, 'disabled');
  assert.equal(result.securityChecks.passed, null);
  assert.equal(result.uiVerification.headSha, result.review.headSha);
  assert.equal(result.securityChecks.headSha, result.review.headSha);
  for (const request of services.calls.worker) {
    assert.doesNotMatch(request.prompt, /Kodo default skill policy v1, stage analyze/);
    assert.match(request.prompt, /Kodo optional tools/);
  }
  const progress = path.join(result.artifacts, 'progress.md');
  assert.match(await read(progress), /succeeded/);
  await writeFile(progress, 'stale recovery file');
  const workers = services.calls.worker.length;
  await engine.run(run.id);
  assert.match(await read(progress), /succeeded/);
  assert.equal(services.calls.worker.length, workers);
});

test('Engine durably resumes pending verification repair after subscription interruption', async t => {
  for (const code of ['quota', 'auth', 'cancelled', 'lease_lost'])
    await t.test(code, async subtest => {
      const fx = await fixture(subtest, {
        config: { repairRounds: 2, researchBudget: 0 },
        testScript:
          "import assert from 'node:assert/strict'; import {value} from './src/value.mjs'; assert.equal(value, 3);\n",
      });
      const services = fakeServices({
        plan: { summary: 'value three', tasks: [node('feature', 'developer', ['src/value.mjs'])] },
      });
      const original = services.provider.runSession,
        repairs = [];
      let controller = new AbortController();
      services.provider.runSession = async request => {
        if (!/Repair confirmed failures/.test(request.prompt)) return original(request);
        repairs.push(request);
        if (repairs.length > 1) assert.equal(request.sessionId, 'pending-verification-session');
        request.onEvent({ sessionId: 'pending-verification-session' });
        if (repairs.length <= 2) {
          assert.equal(
            await read(path.join(request.cwd, 'src/value.mjs')),
            'export const value = 2;\n',
            'interruption occurs before repair writes',
          );
          if (code === 'cancelled') controller.abort();
          throw Object.assign(new Error(`fixture repair ${code}`), { code });
        }
        await writeFile(path.join(request.cwd, 'src/value.mjs'), 'export const value = 3;\n');
        return {
          sessionId: 'pending-verification-session',
          output: { complete: true, summary: 'value repaired', checks: [] },
        };
      };
      let store = fx.openStore(),
        engine = new Engine({ store, ...services });
      const run = await engine.create('Implement value three', { project: fx.project });
      let completed;
      for (let interruption = 1; interruption <= 2; interruption++) {
        const paused = await engine.run(run.id, { signal: controller.signal, resumeCancelled: code === 'cancelled' });
        assert.equal(
          paused.state,
          code === 'quota' ? 'waiting_limits' : code === 'cancelled' ? 'cancelled' : 'blocked',
          paused.error?.message,
        );
        assert.equal(
          paused.error.code,
          code,
          'ordinary resume must reach the unfinished repair instead of a budget/no-progress blocker',
        );
        assert.equal(repairs.length, interruption);
        assert.equal(paused.verification.attempt, 1, 'interruption must not consume another verification round');
        assert.equal(paused.verification.stopped, undefined);
        assert.equal(paused.controllerAssessment, undefined);
        assert.equal(paused.completed.implementation, true);
        assert.equal(paused.nodes.feature.status, 'integrated');
        if (completed) assert.deepEqual(paused.completed, completed);
        else completed = paused.completed;
        assert.equal(git(paused.cwd, 'status', '--porcelain'), '');
        fx.closeStore(store);
        store = fx.openStore();
        engine = new Engine({ store, ...services });
        controller = new AbortController();
      }
      const result = await engine.run(run.id, { resumeCancelled: code === 'cancelled' });
      assert.equal(result.state, 'succeeded', result.error?.message);
      assert.equal(repairs.length, 3);
      assert.equal(result.verification.attempt, 1);
      assert.equal(result.verification.cycle, 1);
      assert.equal(result.verification.pendingRepair, undefined);
      assert.equal(result.verification.previousCycles, undefined);
      assert.deepEqual(result.completed, completed);
      assert.equal(services.calls.analysis, 1);
      assert.equal(services.calls.planner, 1);
      assert.equal(services.calls.worker.length, 1);
      assert.equal(services.calls.review.length, 1, 'review runs only after local checks pass on the repaired head');
      assert.equal(result.checks.headSha, result.headSha);
      assert.equal(result.review.headSha, result.headSha);
      assert.equal(result.uiVerification.headSha, result.headSha);
      assert.equal(result.securityChecks.headSha, result.headSha);
      assert.equal(result.error, null);
      assert.equal(git(result.cwd, 'status', '--porcelain'), '');
      assert.equal(await read(path.join(result.cwd, 'src/value.mjs')), 'export const value = 3;\n');
      assert.equal(store.events(run.id).filter(event => event.type === 'retry_requested').length, 0);
      assert.equal(
        store.events(run.id).filter(event => event.type === 'check_started').length,
        2,
        'checks rerun on the completed repair, with no cached passing result',
      );
      assert.equal(git(fx.project, 'rev-parse', 'HEAD'), fx.base);
    });
});

test('Engine detects no progress only after a resumed verification repair completes', async t => {
  const fx = await fixture(t, { config: { repairRounds: 3, researchBudget: 0 }, testScript: 'process.exit(0);\n' });
  const services = fakeServices({
    plan: { summary: 'one feature', tasks: [node('feature', 'developer', ['src/value.mjs'])] },
    onReview: async () => ({
      output: {
        passed: false,
        findings: [
          {
            severity: 'major',
            file: 'src/value.mjs',
            problem: 'Requirement still missing',
            fix: 'Implement the requirement',
          },
        ],
      },
    }),
  });
  const original = services.provider.runSession;
  let repairs = 0;
  services.provider.runSession = async request => {
    if (!/Repair confirmed failures/.test(request.prompt)) return original(request);
    repairs++;
    if (repairs === 1) throw Object.assign(new Error('fixture repair quota'), { code: 'quota' });
    return { output: { complete: true, summary: 'Finished without resolving the finding', checks: [] } };
  };
  const firstStore = fx.openStore(),
    firstEngine = new Engine({ store: firstStore, ...services });
  const run = await firstEngine.create('Keep verification bounded', { project: fx.project });
  const paused = await firstEngine.run(run.id);
  assert.equal(paused.state, 'waiting_limits');
  assert.equal(paused.verification.attempt, 1);
  const failedHead = git(paused.cwd, 'rev-parse', 'HEAD');
  fx.closeStore(firstStore);
  const store = fx.openStore(),
    engine = new Engine({ store, ...services });
  const blocked = await engine.run(run.id);
  assert.equal(repairs, 2, 'the pending repair must actually finish before identical failure can mean no progress');
  assert.equal(blocked.state, 'blocked');
  assert.equal(blocked.verification.attempt, 2);
  assert.equal(blocked.verification.stopped, 'no_progress');
  assert.equal(blocked.verification.pendingRepair, undefined);
  assert.equal(blocked.controllerAssessment.reason, 'no_progress');
  assert.equal(blocked.controllerAssessment.attempts, 2);
  assert.equal(services.calls.review.length, 2);
  assert.equal(git(blocked.cwd, 'rev-parse', 'HEAD'), failedHead);
  await engine.run(run.id);
  assert.equal(repairs, 2);
  assert.equal(services.calls.review.length, 2, 'ordinary resume cannot reset the completed repair budget');
});

test('Engine rejects out of scope edits before integration and preserves the original project', async t => {
  const fx = await fixture(t, { testScript: 'process.exit(0);\n' });
  const plan = { summary: 'Set value two.', tasks: [node('feature', 'developer', ['src/value.mjs'])] };
  const services = fakeServices({
    plan,
    onWorker: async request => {
      await writeFile(path.join(request.cwd, 'forbidden.txt'), 'outside owned files\n');
      return { sessionId: 'out-of-scope-session', output: { summary: 'done', checks: [], complete: true } };
    },
  });
  const store = fx.openStore(),
    engine = new Engine({ store, ...services });
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

test('Engine uses one routing decision per attempt so parallel admission matches execution', async t => {
  const fx = await fixture(t, {
    testScript:
      "import assert from 'node:assert/strict'; import {readFileSync} from 'node:fs'; assert.equal(readFileSync('first.txt','utf8'),'first\\n'); assert.equal(readFileSync('second.txt','utf8'),'second\\n');\n",
  });
  const plan = {
    summary: 'Create two independent files.',
    tasks: [
      node('first', 'developer', ['first.txt'], [], 'write first'),
      node('second', 'developer', ['second.txt'], [], 'write second'),
    ],
  };
  const decisions = new Map();
  let active = 0,
    maxActive = 0;
  const services = fakeServices({
    plan,
    onWorker: async request => {
      const label = /Your task: write (first|second)/.exec(request.prompt)?.[1];
      active++;
      maxActive = Math.max(maxActive, active);
      try {
        await new Promise(resolve => setImmediate(resolve));
        await writeFile(path.join(request.cwd, `${label}.txt`), `${label}\n`);
        return {
          sessionId: `independent-${label}`,
          output: { summary: `created ${label}`, checks: [], complete: true },
        };
      } finally {
        active--;
      }
    },
  });
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
  assert.ok(
    !fallbackNodes.length || maxActive === 1,
    'fallback serial routing must not run an already admitted concurrent batch',
  );
  assert.deepEqual(Object.fromEntries(decisions), { first: 1, second: 1 });
});

test('Engine honours persisted cancellation after merge and does not publish a release', async t => {
  const fx = await fixture(t, { remote: true });
  const services = fakeServices(),
    store = fx.openStore();
  services.delivery.deliver = async ({ run }) => {
    services.calls.delivery++;
    store.updateRun(run.id, { cancelRequested: true, state: 'cancelled' });
    return { pr: { number: 1, url: 'https://example.invalid/pull/1' }, mergeCommit: run.headSha };
  };
  const engine = new Engine({ store, ...services });
  const run = await engine.create('Implement value two', { project: fx.project });
  const result = await engine.run(run.id);
  assert.equal(result.state, 'cancelled', result.error?.message);
  assert.equal(
    result.delivery.mergeCommit,
    result.headSha,
    'cancellation must retain the already completed merge receipt',
  );
  assert.equal(services.calls.release, 0, 'cancellation must stop the next external mutation');
  assert.equal(store.getRun(run.id).cancelRequested, true);
});

test('Engine resumes scoped interrupted repair only after committing and rechecking its exact head', async t => {
  const fx = await fixture(t, {
    testScript: "import assert from 'node:assert/strict';import{value}from'./src/value.mjs';assert.equal(value,2);\n",
  });
  const services = fakeServices({
    plan: { summary: 'value two', tasks: [node('feature', 'developer', ['src/value.mjs'])] },
  });
  const store = fx.openStore(),
    engine = new Engine({ store, ...services });
  const run = await engine.create('Recover interrupted repair', { project: fx.project });
  await engine.prepare(run);
  run.plan = { summary: 'value two', tasks: [node('feature', 'developer', ['src/value.mjs'])] };
  run.completed.implementation = true;
  run.state = 'cancelled';
  await writeFile(path.join(run.cwd, 'src/value.mjs'), 'export const value = 2;\n');
  engine.save(run);
  const result = await engine.run(run.id, { resumeCancelled: true });
  assert.equal(result.state, 'succeeded', result.error?.message);
  assert.notEqual(result.headSha, fx.base);
  assert.equal(result.checks.headSha, result.headSha);
  assert.equal(result.review.headSha, result.headSha);
  assert.equal(git(run.cwd, 'status', '--porcelain'), '');
  assert.equal(services.calls.worker.length, 0);
  assert.equal(store.events(run.id).filter(e => e.type === 'repair_recovered').length, 1);
});

test('Engine refuses to finish a node merge whose MERGE_HEAD belongs to another node', async t => {
  const fx = await integrationConflict(t, async () => {
    throw new Error('wrong resolver must not be called');
  });
  const merge = spawnSync('git', ['merge', '--no-ff', '--no-edit', fx.run.nodes.second.branch], {
    cwd: fx.run.cwd,
    encoding: 'utf8',
    windowsHide: true,
  });
  assert.equal(merge.status, 1);
  fx.run.nodes.first.status = 'completed';
  await assert.rejects(fx.engine.integrateNode(fx.run, fx.tasks[0]), { code: 'merge_state' });
  assert.equal(git(fx.run.cwd, 'rev-parse', 'MERGE_HEAD'), fx.run.nodes.second.headSha);
});

test('Engine completes the owning pending node merge before scheduling earlier ready nodes without delivery', async t => {
  let owningRun,
    thirdStarted = false;
  const fx = await integrationConflict(t, async request => {
    if (request.role === 'developer') {
      assert.equal(owningRun.nodes.second.status, 'integrated');
      thirdStarted = true;
      await writeFile(path.join(request.cwd, 'src/third.mjs'), 'export const third = true;\n');
    } else await writeFile(path.join(request.cwd, 'src/value.mjs'), combinedModule);
    return { sessionId: 'pending-owner-recovery', output: { summary: 'completed', checks: [], complete: true } };
  });
  owningRun = fx.run;
  const third = node('third', 'developer', ['src/third.mjs'], ['first']);
  fx.run.plan.tasks.splice(1, 0, third);
  fx.engine.save(fx.run);
  const merge = spawnSync('git', ['merge', '--no-ff', '--no-edit', fx.run.nodes.second.branch], {
    cwd: fx.run.cwd,
    encoding: 'utf8',
    windowsHide: true,
  });
  assert.equal(merge.status, 1);
  await fx.engine.executeTasks(fx.run);
  assert.equal(thirdStarted, true);
  assert.ok(Object.values(fx.run.nodes).every(node => node.status === 'integrated'));
  assert.equal(await read(path.join(fx.run.cwd, 'src/value.mjs')), combinedModule);
  assert.equal(git(fx.run.cwd, 'status', '--porcelain'), '');
});
