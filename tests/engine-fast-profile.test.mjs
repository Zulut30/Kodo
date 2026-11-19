import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Engine } from '../runtime/engine.mjs';
import { fixture, fakeServices, node } from './helpers/engine-fixture.mjs';

const done = { sessionId: 'worker', output: { summary: 'done', checks: [], complete: true } };
const isRepair = call => /Repair confirmed failures/.test(call.prompt);
const write = async (cwd, name, text) => {
  await mkdir(path.dirname(path.join(cwd, name)), { recursive: true });
  await writeFile(path.join(cwd, name), text);
};

/** Count the UI, security and architecture gate invocations while keeping their real behaviour. */
function spyGates(engine) {
  const calls = [];
  for (const name of ['runUIVerification', 'runSecurityChecks', 'runArchitectureChecks']) {
    const original = engine.gates[name];
    engine.gates[name] = async (...args) => {
      calls.push(name);
      return original(...args);
    };
  }
  return calls;
}

/**
 * One developer node whose first attempt breaks the project check; the repair session fixes it.
 * The fixture project check (`verify.mjs`) imports `tests/check.mjs`, which asserts value 2.
 */
async function repairScenario(t, profile) {
  const fx = await fixture(t, { config: { repairRounds: 2, researchBudget: 4 } });
  const services = fakeServices({
    plan: { summary: 'Expose value two', tasks: [node('feature', 'developer', ['src/value.mjs', 'tests/check.mjs'])] },
    onWorker: async call => {
      if (!isRepair(call))
        await write(
          call.cwd,
          'tests/check.mjs',
          "import assert from 'node:assert/strict';\nimport { value } from '../src/value.mjs';\nassert.equal(value, 2);\n",
        );
      await write(call.cwd, 'src/value.mjs', `export const value = ${isRepair(call) ? 2 : 3};\n`);
      return done;
    },
  });
  const store = fx.openStore(),
    engine = new Engine({ store, ...services });
  const gates = spyGates(engine);
  const run = await engine.create('Expose value two', { project: fx.project });
  if (profile) {
    run.verificationProfile = profile;
    engine.save(run);
  }
  const result = await engine.run(run.id);
  return { services, gates, result, store };
}

test('A task-fast Run is verified by fast checks and the behaviour gate only, and repairs without research', async t => {
  const { services, gates, result, store } = await repairScenario(t, 'task-fast');
  assert.equal(result.state, 'succeeded', result.error?.message);
  assert.equal(services.calls.review.length, 0, 'no review session is opened');
  assert.deepEqual(gates, [], 'UI, security and architecture gates are not invoked');
  assert.equal(result.review, null);
  assert.equal(result.checks.profile, 'task-fast');
  assert.equal(result.checks.complete, true);
  assert.equal(result.headSha, result.checks.headSha);
  assert.equal(result.behavior.passed, true, 'the behaviour gate still checks the final head');
  assert.equal(result.behavior.headSha, result.headSha);
  assert.equal(services.calls.worker.filter(isRepair).length, 1, 'the ordinary bounded repair loop is kept');
  assert.equal(services.calls.research, 1, 'only planning researched; the task-fast repair asks for no more');
  const events = store.events(result.id).map(row => row.type);
  assert.ok(!events.includes('check_started'), 'the full check commands are not executed');
});

test('A legacy Run keeps full checks, gates, research before repair and the independent review', async t => {
  const { services, gates, result, store } = await repairScenario(t);
  assert.equal(result.state, 'succeeded', result.error?.message);
  assert.equal(services.calls.review.length, 1);
  assert.deepEqual(gates, ['runUIVerification', 'runSecurityChecks', 'runArchitectureChecks']);
  assert.equal(result.review.passed, true);
  assert.equal(result.checks.profile, undefined);
  assert.equal(services.calls.worker.filter(isRepair).length, 1);
  assert.equal(services.calls.research, 2, 'the repair is preceded by additional research as before');
  assert.ok(store.events(result.id).some(row => row.type === 'check_started'));
});

test('Engine.run refuses external and gate Runs before taking the Run lease', async t => {
  const fx = await fixture(t);
  const services = fakeServices();
  const store = fx.openStore(),
    engine = new Engine({ store, ...services });
  const gate = {
    schemaVersion: 1,
    kind: 'gate',
    projectId: '00000000-0000-4000-8000-000000000001',
    gateId: 'gate-1',
    number: 1,
    runId: 'unused',
    baseSha: 'a'.repeat(40),
    headSha: 'b'.repeat(40),
    mergesHash: 'c'.repeat(64),
  };
  for (const patch of [{ executor: { kind: 'external', host: 't3' } }, { directorBinding: gate }]) {
    const run = await engine.create('Work done elsewhere', { project: fx.project });
    store.updateRun(run.id, patch);
    // Another owner holds the lease: a refusal that came after the lease would report a busy Run instead.
    const held = store.acquireLease(`run:${run.id}`, 'other-owner');
    assert.ok(held);
    await assert.rejects(() => engine.run(run.id), { code: 'project_run_not_native' });
    store.releaseLease(held);
    await assert.rejects(() => engine.run(run.id), { code: 'project_run_not_native' });
    const after = store.getRun(run.id);
    assert.equal(after.state, 'created');
    assert.equal(after.error, undefined);
  }
  assert.equal(services.calls.worker.length + services.calls.review.length + services.calls.planner, 0);
});
