import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Engine } from '../runtime/engine.mjs';
import {
  read,
  exists,
  git,
  fixture,
  node,
  featurePlan,
  fakeServices,
  integrationConflict,
  combinedModule,
} from './helpers/engine-fixture.mjs';

test('Engine completes pending verification repair before upstream main synchronization and release metadata', async t => {
  const fx = await fixture(t, {
    remote: true,
    config: { repairRounds: 2, researchBudget: 0 },
    testScript:
      "import assert from 'node:assert/strict'; import {value} from './src/value.mjs'; assert.ok([2, 3].includes(value));\n",
  });
  const services = fakeServices({
    plan: { summary: 'value three', tasks: [node('feature', 'developer', ['src/value.mjs'])] },
    onReview: async (request, calls) => {
      if (calls.review.length === 1)
        return {
          output: {
            passed: false,
            findings: [
              { severity: 'major', file: 'src/value.mjs', problem: 'Expected value three', fix: 'Export three' },
            ],
          },
        };
      assert.equal(await read(path.join(request.cwd, 'src/value.mjs')), 'export const value = 3;\n');
      assert.equal(await read(path.join(request.cwd, 'untouched.txt')), 'incoming upstream content\n');
      return { output: { passed: true, findings: [] } };
    },
  });
  const original = services.provider.runSession,
    repairHeads = [],
    releaseSnapshots = [],
    gateHeads = { ui: [], security: [] };
  services.provider.runSession = async request => {
    if (!/Repair confirmed failures/.test(request.prompt)) return original(request);
    repairHeads.push(git(request.cwd, 'rev-parse', 'HEAD'));
    if (repairHeads.length > 1) assert.equal(request.sessionId, 'upstream-verification-session');
    request.onEvent({ sessionId: 'upstream-verification-session' });
    if (repairHeads.length === 1) throw Object.assign(new Error('fixture repair quota'), { code: 'quota' });
    await writeFile(path.join(request.cwd, 'src/value.mjs'), 'export const value = 3;\n');
    return {
      sessionId: 'upstream-verification-session',
      output: { complete: true, summary: 'value repaired', checks: [] },
    };
  };
  services.delivery.prepareReleaseVersion = async ({ run, cwd }) => {
    releaseSnapshots.push({
      pending: Boolean(run.verification?.pendingRepair),
      value: git(cwd, 'show', 'HEAD:src/value.mjs'),
      baseSha: run.baseSha,
    });
    await writeFile(path.join(cwd, 'registry.json'), '{"version":"0.2.0"}\n');
  };
  const observeGates = engine => {
    for (const [method, key] of [
      ['runUIVerification', 'ui'],
      ['runSecurityChecks', 'security'],
    ]) {
      const gate = engine.gates[method];
      engine.gates[method] = async options => {
        gateHeads[key].push(options.headSha);
        return gate(options);
      };
    }
  };
  const firstStore = fx.openStore(),
    firstEngine = new Engine({ store: firstStore, ...services });
  observeGates(firstEngine);
  const run = await firstEngine.create('Resume repair before updating main', { project: fx.project });
  const paused = await firstEngine.run(run.id);
  assert.equal(paused.state, 'waiting_limits', paused.error?.message);
  const failedHead = git(paused.cwd, 'rev-parse', 'HEAD');
  assert.equal(paused.verification.pendingRepair.headSha, failedHead);
  assert.equal(paused.verification.pendingRepair.sessionId, 'upstream-verification-session');
  assert.notEqual(paused.verification.pendingRepair.complete, true);
  fx.closeStore(firstStore);
  const other = path.join(fx.directory, 'other-client');
  git(fx.directory, 'clone', '--branch', 'main', path.join(fx.directory, 'origin.git'), other);
  git(other, 'config', 'user.name', 'Other Kodo Task');
  git(other, 'config', 'user.email', 'other@example.invalid');
  await writeFile(path.join(other, 'untouched.txt'), 'incoming upstream content\n');
  git(other, 'add', 'untouched.txt');
  git(other, 'commit', '-m', 'Concurrent out of scope main update');
  git(other, 'push', 'origin', 'main');
  const upstreamSha = git(other, 'rev-parse', 'HEAD');
  const store = fx.openStore(),
    engine = new Engine({ store, ...services });
  observeGates(engine);
  const result = await engine.run(run.id);
  assert.equal(result.state, 'succeeded', result.error?.message);
  assert.deepEqual(
    repairHeads,
    [failedHead, failedHead],
    'the exact repair session must finish against its saved scope baseline',
  );
  assert.equal(result.baseSha, upstreamSha);
  assert.notEqual(result.headSha, failedHead);
  assert.equal(git(result.cwd, 'merge-base', upstreamSha, result.headSha), upstreamSha);
  assert.equal(git(result.cwd, 'show', 'HEAD:untouched.txt'), 'incoming upstream content');
  assert.equal(releaseSnapshots.length, 2);
  assert.deepEqual(releaseSnapshots[1], { pending: false, value: 'export const value = 3;', baseSha: upstreamSha });
  assert.deepEqual(gateHeads, { ui: [failedHead, result.headSha], security: [failedHead, result.headSha] });
  assert.equal(services.calls.review.length, 2);
  assert.equal(services.calls.worker.length, 1);
  assert.equal(result.checks.headSha, result.headSha);
  assert.equal(result.checks.results[0].exitCode, 0);
  assert.equal(result.review.headSha, result.headSha);
  assert.equal(result.uiVerification.headSha, result.headSha);
  assert.equal(result.securityChecks.headSha, result.headSha);
  assert.equal(result.verification.pendingRepair, undefined);
  assert.equal(result.verification.attempt, 1);
  assert.equal(result.verification.cycle, 1);
  assert.equal(result.verification.previousCycles, undefined);
  assert.equal(result.controllerAssessment, undefined);
  assert.equal(store.events(run.id).filter(event => event.type === 'check_started').length, 2);
  assert.equal(store.events(run.id).filter(event => event.type === 'retry_requested').length, 0);
  assert.equal(git(result.cwd, 'status', '--porcelain'), '');
  assert.equal(git(fx.project, 'rev-parse', 'HEAD'), fx.base);
});

test('Engine retry-failed preserves pending verification repair before resetting its cycle', async t => {
  for (const complete of [false, true])
    await t.test(complete ? 'completed-before-commit' : 'quota-with-partial-writes', async subtest => {
      const fx = await fixture(subtest, {
        config: { repairRounds: 2, researchBudget: 0 },
        testScript:
          "import assert from 'node:assert/strict'; import {value} from './src/value.mjs'; assert.equal(value, 3);\n",
      });
      const services = fakeServices({
        plan: { summary: 'value three', tasks: [node('feature', 'developer', ['src/value.mjs'])] },
      });
      const original = services.provider.runSession,
        controller = new AbortController(),
        repairSnapshots = [];
      let store = fx.openStore();
      services.provider.runSession = async request => {
        if (!/Repair confirmed failures/.test(request.prompt)) return original(request);
        repairSnapshots.push({
          sessionId: request.sessionId,
          headSha: git(request.cwd, 'rev-parse', 'HEAD'),
          committed: git(request.cwd, 'show', 'HEAD:src/value.mjs'),
          working: await read(path.join(request.cwd, 'src/value.mjs')),
        });
        request.onEvent({ sessionId: 'retry-pending-verification-session' });
        if (!complete && repairSnapshots.length <= 2) {
          await writeFile(path.join(request.cwd, 'src/value.mjs'), 'export const value = 99;\n');
          throw Object.assign(new Error('fixture quota after partial repair write'), { code: 'quota' });
        }
        await writeFile(path.join(request.cwd, 'src/value.mjs'), 'export const value = 3;\n');
        if (complete) controller.abort();
        return {
          sessionId: 'retry-pending-verification-session',
          output: { complete: true, summary: 'repair completed', checks: [] },
        };
      };
      let engine = new Engine({ store, ...services });
      const run = await engine.create('Retry the reserved verification repair', { project: fx.project });
      const history = [{ attempt: 2, cycle: 1, stopped: 'repair_budget_exhausted' }];
      run.verification = { attempt: 0, cycle: 2, previousCycles: history };
      engine.save(run);
      let reserved;
      for (let interruption = 1; interruption <= (complete ? 1 : 2); interruption++) {
        const paused = await engine.run(run.id, { signal: controller.signal, retryFailed: interruption > 1 });
        reserved ||= structuredClone(paused.verification);
        assert.equal(
          git(paused.cwd, 'rev-parse', 'HEAD'),
          reserved.pendingRepair.headSha,
          'retry-failed must leave unfinished writes out of HEAD',
        );
        assert.equal(git(paused.cwd, 'show', 'HEAD:src/value.mjs'), 'export const value = 2;');
        assert.equal(paused.state, complete ? 'cancelled' : 'waiting_limits', paused.error?.message);
        assert.equal(paused.error.code, complete ? 'cancelled' : 'quota');
        assert.deepEqual(
          paused.verification,
          reserved,
          'retry-failed must retain the entire reserved round and its history',
        );
        assert.equal(paused.verification.attempt, 1);
        assert.equal(paused.verification.cycle, 2);
        assert.deepEqual(paused.verification.previousCycles, history);
        assert.equal(paused.verification.pendingRepair.sessionId, 'retry-pending-verification-session');
        assert.equal(paused.verification.pendingRepair.complete === true, complete);
        assert.equal(
          await read(path.join(paused.cwd, 'src/value.mjs')),
          complete ? 'export const value = 3;\n' : 'export const value = 99;\n',
        );
        assert.equal(services.calls.review.length, 0);
        fx.closeStore(store);
        store = fx.openStore();
        engine = new Engine({ store, ...services });
      }
      const result = await engine.run(run.id, { retryFailed: true, resumeCancelled: complete });
      assert.equal(result.state, 'succeeded', result.error?.message);
      assert.equal(
        repairSnapshots.length,
        complete ? 1 : 3,
        'completed output must not reopen the session; unfinished output must resume it',
      );
      assert.deepEqual(
        repairSnapshots.map(snapshot => snapshot.sessionId),
        complete
          ? [undefined]
          : [undefined, 'retry-pending-verification-session', 'retry-pending-verification-session'],
      );
      for (const snapshot of repairSnapshots) {
        assert.equal(snapshot.headSha, reserved.pendingRepair.headSha);
        assert.equal(snapshot.committed, 'export const value = 2;');
      }
      assert.deepEqual(
        repairSnapshots.map(snapshot => snapshot.working),
        complete
          ? ['export const value = 2;\n']
          : ['export const value = 2;\n', 'export const value = 99;\n', 'export const value = 99;\n'],
      );
      assert.equal(result.verification.pendingRepair, undefined);
      assert.equal(result.verification.attempt, 1);
      assert.equal(result.verification.cycle, 2);
      assert.deepEqual(result.verification.previousCycles, history);
      assert.equal(result.verification.lastFailure, reserved.lastFailure);
      assert.equal(git(result.cwd, 'show', 'HEAD:src/value.mjs'), 'export const value = 3;');
      assert.equal(git(result.cwd, 'rev-list', '--count', `${reserved.pendingRepair.headSha}..HEAD`), '1');
      assert.equal(git(result.cwd, 'log', '-1', '--format=%s'), 'Kodo repair checks 1');
      assert.equal(store.events(run.id).filter(event => event.type === 'repair_recovered').length, 0);
      assert.equal(store.events(run.id).filter(event => event.type === 'check_started').length, 2);
      assert.equal(store.events(run.id).filter(event => event.type === 'retry_requested').length, complete ? 1 : 2);
      assert.equal(services.calls.worker.length, 1);
      assert.equal(services.calls.review.length, 1);
      assert.equal(result.checks.headSha, result.headSha);
      assert.equal(result.review.headSha, result.headSha);
      assert.equal(result.uiVerification.headSha, result.headSha);
      assert.equal(result.securityChecks.headSha, result.headSha);
      assert.equal(git(result.cwd, 'status', '--porcelain'), '');
      assert.equal(git(fx.project, 'rev-parse', 'HEAD'), fx.base);
    });
});

test('Engine saves cannot overwrite cancellation from another coordinator connection', async t => {
  const fx = await fixture(t);
  const store = fx.openStore(),
    other = fx.openStore();
  const engine = new Engine({ store });
  const run = await engine.create('cancel persisted work', { project: fx.project });
  run.cancelRequested = false;
  other.updateRun(run.id, { cancelRequested: true, state: 'cancelled' });
  run.state = 'implementing';
  engine.save(run);
  assert.equal(other.getRun(run.id).cancelRequested, true);
  assert.equal(other.getRun(run.id).state, 'cancelled');
});

test('Engine integrates developer tester and documenter work with independent review and preserves dirty input', async t => {
  const fx = await fixture(t, { remote: true });
  await writeFile(path.join(fx.project, 'untouched.txt'), 'user local edit\n');
  await writeFile(path.join(fx.project, 'notes.txt'), 'user untracked note\n');
  const originalStatus = git(fx.project, 'status', '--porcelain');
  const services = fakeServices(),
    store = fx.openStore();
  const engine = new Engine({ store, ...services });
  const run = await engine.create('Implement value two', { project: fx.project });
  const result = await engine.run(run.id);
  assert.equal(result.state, 'succeeded', result.error?.message);
  assert.deepEqual(
    Object.values(result.nodes).map(item => item.status),
    ['integrated', 'integrated', 'integrated'],
  );
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
  const fx = await fixture(t),
    services = fakeServices();
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
  const fx = await fixture(t, {
    testScript:
      "import assert from 'node:assert/strict'; import {value} from './src/value.mjs'; assert.equal(value, 2);\n",
  });
  const plan = { summary: 'Set value two.', tasks: [node('feature', 'developer', ['src/value.mjs'])] };
  let quota = true;
  const services = fakeServices({
    plan,
    onWorker: async request => {
      if (quota) {
        quota = false;
        request.onEvent({ sessionId: 'quota-worker-exact-session' });
        throw Object.assign(new Error('fixture quota reached'), { code: 'quota', retryAt: '2030-01-01T00:00:00Z' });
      }
      assert.equal(request.sessionId, 'quota-worker-exact-session');
      await writeFile(path.join(request.cwd, 'src/value.mjs'), 'export const value = 2;\n');
      return { sessionId: request.sessionId, output: { summary: 'value implemented', checks: [], complete: true } };
    },
  });
  const store = fx.openStore(),
    engine = new Engine({ store, ...services });
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

test('Engine treats cancellation during the final check attempt as cancellation instead of a repair blocker', async t => {
  const fx = await fixture(t, { testScript: 'setTimeout(() => process.exit(0), 10000);\n' });
  const plan = { summary: 'Set value two.', tasks: [node('feature', 'developer', ['src/value.mjs'])] };
  const services = fakeServices({ plan }),
    controller = new AbortController();
  const engine = new Engine({
    store: fx.openStore(),
    ...services,
    onEvent: event => {
      if (event.type === 'check_started') controller.abort();
    },
  });
  const run = await engine.create('Implement value two', { project: fx.project });
  const result = await engine.run(run.id, { signal: controller.signal });
  assert.equal(result.state, 'cancelled', result.error?.message);
  assert.equal(result.error.code, 'cancelled');
  assert.equal(services.calls.review.length, 0);
  assert.equal(services.calls.worker.length, 1);
  assert.equal(services.calls.delivery, 0);
});

test('Engine reruns checks and independent review after repairing a confirmed review finding', async t => {
  const fx = await fixture(t, {
    config: { repairRounds: 2 },
    testScript:
      "import assert from 'node:assert/strict'; import {value} from './src/value.mjs'; assert.equal(value, 2);\n",
  });
  const plan = { summary: 'Set value two.', tasks: [node('feature', 'developer', ['src/value.mjs'])] };
  let repairs = 0,
    firstReviewedHead;
  const services = fakeServices({
    plan,
    onWorker: async request => {
      if (request.role === 'developer')
        await writeFile(path.join(request.cwd, 'src/value.mjs'), 'export const value = 2;\n');
      else {
        assert.match(request.prompt, /Repair confirmed failures/);
        repairs++;
        await writeFile(
          path.join(request.cwd, 'src/value.mjs'),
          'export const value = 2;\nexport const reviewFix = true;\n',
        );
      }
      return {
        sessionId: `review-repair-${services.calls.worker.length}`,
        output: { summary: 'implemented', checks: [], complete: true },
      };
    },
    onReview: async (request, calls) => {
      const head = git(request.cwd, 'rev-parse', 'HEAD');
      if (calls.review.length === 1) {
        firstReviewedHead = head;
        return {
          sessionId: 'review-finding',
          output: {
            passed: false,
            findings: [
              {
                file: 'src/value.mjs',
                severity: 'major',
                problem: 'Required reviewFix marker is absent',
                fix: 'Add reviewFix=true export',
              },
            ],
          },
        };
      }
      assert.notEqual(head, firstReviewedHead);
      assert.match(request.prompt, /"headSha":"[a-f0-9]+"/);
      assert.match(await read(path.join(request.cwd, 'src/value.mjs')), /reviewFix = true/);
      return { sessionId: 'review-after-repair', output: { passed: true, findings: [] } };
    },
  });
  const store = fx.openStore(),
    engine = new Engine({ store, ...services });
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

test('Engine coordinator stages resolver edits before completing a node merge conflict', async t => {
  let resolutions = 0;
  const fx = await integrationConflict(t, async request => {
    resolutions++;
    assert.match(request.prompt, /conflict/i);
    await writeFile(path.join(request.cwd, 'src/value.mjs'), combinedModule);
    // The resolver deliberately does not stage or commit; the coordinator owns Git.
    return {
      sessionId: 'edit-only-resolver',
      output: { summary: 'preserved both changes', checks: [], complete: true },
    };
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

test('Engine refuses interrupted out of scope edits and dirty commit checks before any review', async t => {
  const fx = await fixture(t, { testScript: 'process.exit(0);\n' });
  const services = fakeServices();
  const store = fx.openStore(),
    engine = new Engine({ store, ...services });
  const run = await engine.create('Recover edits safely', { project: fx.project });
  await engine.prepare(run);
  run.plan = featurePlan();
  run.completed.implementation = true;
  engine.save(run);
  await writeFile(path.join(run.cwd, 'untouched.txt'), 'unexpected interrupted edit\n');
  await assert.rejects(engine.checks(run), { code: 'dirty_worktree' });
  const result = await engine.run(run.id);
  assert.equal(result.state, 'blocked');
  assert.equal(result.error.code, 'scope_conflict');
  assert.equal(git(run.cwd, 'rev-parse', 'HEAD'), fx.base);
  assert.equal(services.calls.review.length, 0);
});

test('Engine reconciles a real squash merge before changing its reviewed head after a missing receipt', async t => {
  for (const code of ['command_failed', 'stale_base'])
    await t.test(code, async subtest => {
      const fx = await fixture(subtest, {
        remote: true,
        testScript:
          "import assert from 'node:assert/strict';import{value}from'./src/value.mjs';assert.equal(value,2);\n",
      });
      const plan = {
        summary: 'Value two through squash merge',
        tasks: [node('feature', 'developer', ['src/value.mjs'])],
      };
      let discovered = 0,
        merged,
        reviewed;
      const services = fakeServices({
        plan,
        onDiscover: async () => {
          if (++discovered > 1) throw new Error('Merged recovery must not require a new model discovery');
        },
      });
      const store = fx.openStore(),
        engine = new Engine({ store, ...services });
      services.delivery.reconcileDelivery = async ({ run }) => {
        if (!merged) return null;
        assert.equal(run.delivery.reviewedHead, reviewed);
        assert.equal(
          git(run.cwd, 'rev-parse', 'HEAD'),
          reviewed,
          'do not merge our own squash back into the reviewed branch',
        );
        return { ...run.delivery, mergeCommit: merged };
      };
      services.delivery.deliver = async ({ run, review }) => {
        services.calls.delivery++;
        if (merged) return { ...run.delivery, mergeCommit: merged };
        reviewed = review.headSha;
        const other = path.join(fx.directory, 'squash-client');
        git(fx.directory, 'clone', '--branch', 'main', path.join(fx.directory, 'origin.git'), other);
        git(other, 'config', 'user.name', 'Squash Coordinator');
        git(other, 'config', 'user.email', 'squash@example.invalid');
        git(other, 'fetch', fx.project, run.branch);
        git(other, 'merge', '--squash', 'FETCH_HEAD');
        git(other, 'commit', '-m', 'Real squash commit with different history');
        git(other, 'push', 'origin', 'main');
        merged = git(other, 'rev-parse', 'HEAD');
        assert.notEqual(merged, reviewed);
        run.delivery = { pr: { number: 1, url: 'https://example.invalid/pull/1' }, reviewedHead: reviewed };
        store.updateRun(run.id, { delivery: run.delivery });
        throw Object.assign(new Error('Interrupted before merge receipt was saved'), { code });
      };
      const run = await engine.create('Squash receipt recovery', { project: fx.project });
      let result = await engine.run(run.id);
      if (code === 'command_failed') {
        assert.equal(result.state, 'blocked');
        result = await engine.run(run.id);
      }
      assert.equal(result.state, 'succeeded', result.error?.message);
      assert.equal(result.delivery.mergeCommit, merged);
      assert.equal(result.review.headSha, reviewed);
      assert.equal(services.calls.review.length, 1);
      assert.equal(services.calls.release, 1);
      assert.equal(discovered, 1);
    });
});
