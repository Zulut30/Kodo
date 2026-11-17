import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Engine } from '../runtime/engine.mjs';
import { makeWorktree } from '../runtime/workspace.mjs';
import { createGateRunDraft, gateMergesHash, runEpicGate, verifyTaskFastOnce } from '../runtime/wave-verifier.mjs';
import { fixture, fakeServices, git } from './helpers/engine-fixture.mjs';

const done = { sessionId: 'worker', output: { summary: 'done', checks: [], complete: true } };
const isRepair = call => /Repair confirmed failures/.test(call.prompt);
const smoke = { command: process.execPath, args: ['smoke.mjs'] };
const write = async (cwd, name, text) => {
  await mkdir(path.dirname(path.join(cwd, name)), { recursive: true });
  await writeFile(path.join(cwd, name), text);
};
const commit = async (cwd, name, text) => {
  await write(cwd, name, text);
  git(cwd, 'add', '-A');
  git(cwd, 'commit', '-m', `Change ${name}`);
  return git(cwd, 'rev-parse', 'HEAD');
};
const projectTask = (id, writePaths) => ({
  id,
  title: `Task ${id}`,
  description: `Implement ${id}.`,
  writePaths,
  acceptance: [{ id: `${id}-proof`, text: `${id} works`, evidenceKinds: ['acceptance'] }],
});

/** An epic whose two tasks were merged on main after the epic base, ready for one gate run. */
async function epic(t, { testScript = 'process.exit(0);\n', onWorker } = {}) {
  const fx = await fixture(t, {
    config: {
      repairRounds: 5,
      researchBudget: 0,
      commands: { test: [{ command: process.execPath, args: ['verify.mjs'] }], build: [], deploy: [], smoke: [smoke] },
    },
    testScript,
  });
  await commit(fx.project, 'smoke.mjs', "console.log('smoke ok');\n");
  const baseSha = git(fx.project, 'rev-parse', 'HEAD');
  const first = await commit(fx.project, 'src/a.mjs', 'export const a = 1;\n');
  const second = await commit(fx.project, 'src/b.mjs', 'export const b = 2;\n');
  const services = fakeServices({ onWorker: onWorker ? async call => onWorker(call, services.calls) : undefined });
  const store = fx.openStore(),
    engine = new Engine({ store, ...services });
  const projectId = randomUUID(),
    now = new Date().toISOString();
  const gate = (overrides = {}) => ({
    schemaVersion: 1,
    id: 'gate-epic-1',
    projectId,
    number: 1,
    containers: [{ kind: 'epic', id: 'epic' }],
    runId: randomUUID(),
    baseSha,
    headSha: second,
    merges: [
      { taskId: 'task-a', attemptId: randomUUID(), runId: randomUUID(), mergeCommit: first },
      { taskId: 'task-b', attemptId: randomUUID(), runId: randomUUID(), mergeCommit: second },
    ],
    installed: false,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  });
  const tasks = [projectTask('task-a', ['src/a.mjs']), projectTask('task-b', ['src/b.mjs'])];
  const installed = [];
  const installGateRun =
    (adjust = () => {}) =>
    async draft => {
      adjust(draft);
      installed.push(structuredClone(draft));
      return store.createRun(draft);
    };
  return {
    fx,
    services,
    store,
    engine,
    project: { projectId, root: fx.project },
    gate,
    tasks,
    installed,
    installGateRun,
    first,
    second,
    baseSha,
  };
}

test('Gate run draft covers the merged tasks on its own branch and is installed through the port', async t => {
  const e = await epic(t);
  const gate = e.gate();
  const run = await createGateRunDraft({
    engine: e.engine,
    project: e.project,
    gate,
    tasks: e.tasks,
    input: { mode: 'deep' },
    installGateRun: e.installGateRun(),
  });
  assert.equal(e.installed.length, 1);
  const [draft] = e.installed;
  assert.equal(run.id, gate.runId);
  assert.equal(draft.branch, `kodo/${gate.runId}`);
  assert.equal(path.basename(draft.cwd), 'integration');
  assert.deepEqual(draft.directorBinding, {
    schemaVersion: 1,
    kind: 'gate',
    projectId: e.project.projectId,
    gateId: gate.id,
    number: 1,
    runId: gate.runId,
    baseSha: gate.baseSha,
    headSha: gate.headSha,
    mergesHash: gateMergesHash(gate.merges),
  });
  assert.match(draft.directorBinding.mergesHash, /^[a-f0-9]{64}$/);
  assert.notEqual(gateMergesHash(gate.merges), gateMergesHash([...gate.merges].reverse()));
  assert.equal(draft.baseSha, gate.baseSha);
  assert.equal(draft.headSha, gate.headSha);
  assert.deepEqual(
    draft.plan.tasks.map(task => [task.id, task.writePaths, task.acceptance]),
    [
      ['task-a', ['src/a.mjs'], ['task-a works']],
      ['task-b', ['src/b.mjs'], ['task-b works']],
    ],
  );
  assert.deepEqual(
    Object.values(draft.nodes).map(node => [node.id, node.status, node.headSha, node.sourceRunId]),
    gate.merges.map(merge => [merge.taskId, 'integrated', merge.mergeCommit, merge.runId]),
  );
  assert.equal(draft.completed.implementation, true);
  assert.equal(draft.executionMode.selected, 'deep');
  assert.equal(draft.config.repairRounds, 5);
  assert.deepEqual(draft.config.watchdog, { stalledRounds: 2, rejectUnchanged: true });
  assert.equal(draft.verificationProfile, undefined, 'the gate run uses the full verification');
  assert.equal(e.store.getRun(gate.runId).directorBinding.kind, 'gate');
  await assert.rejects(() => e.engine.run(gate.runId), { code: 'project_run_not_native' });

  const custom = await createGateRunDraft({
    engine: e.engine,
    project: { ...e.project, execution: { watchdog: { stalledRounds: 3 } } },
    gate: e.gate(),
    tasks: e.tasks,
    installGateRun: e.installGateRun(),
  });
  assert.deepEqual(custom.config.watchdog, { stalledRounds: 3, rejectUnchanged: false });

  for (const [label, invalid, tasks] of [
    ['unknown task', e.gate(), e.tasks.slice(0, 1)],
    ['merge outside the head', e.gate({ headSha: e.first }), e.tasks],
    ['other project', e.gate({ projectId: randomUUID() }), e.tasks],
    ['bad run id', e.gate({ runId: '../escape' }), e.tasks],
  ])
    await assert.rejects(
      () =>
        createGateRunDraft({
          engine: e.engine,
          project: e.project,
          gate: invalid,
          tasks,
          installGateRun: e.installGateRun(),
        }),
      { code: 'gate_invalid' },
      label,
    );
  assert.equal(e.installed.length, 2, 'an invalid gate never reaches the installer');
});

test('Epic gate verifies once with review, executes smoke and records it', async t => {
  const e = await epic(t);
  const run = await createGateRunDraft({
    engine: e.engine,
    project: e.project,
    gate: e.gate(),
    tasks: e.tasks,
    installGateRun: e.installGateRun(),
  });
  const result = await runEpicGate({ engine: e.engine, run });
  assert.equal(result.state, 'succeeded', result.error?.message);
  assert.equal(e.services.calls.review.length, 1, 'one independent review of the whole epic diff');
  assert.equal(result.review.passed, true);
  assert.equal(result.checks.profile, undefined);
  assert.equal(result.checks.complete, true);
  assert.equal(result.headSha, e.second);
  assert.equal(git(result.cwd, 'rev-parse', 'HEAD'), e.second);
  assert.equal(git(result.cwd, 'rev-parse', '--abbrev-ref', 'HEAD'), `kodo/${run.id}`);
  assert.equal(result.smoke.schemaVersion, 1);
  assert.equal(result.smoke.headSha, result.headSha);
  assert.equal(result.smoke.configured, true);
  assert.equal(result.smoke.complete, true);
  assert.deepEqual(
    result.smoke.results.map(row => [row.command, row.args, row.exitCode]),
    [[smoke.command, smoke.args, 0]],
  );
  const evidence = JSON.parse(await readFile(result.smoke.results[0].outputPath, 'utf8'));
  assert.equal(evidence.kind, 'smoke');
  assert.match(evidence.value.stdout, /smoke ok/);
  assert.equal(e.store.getRun(run.id).smoke.complete, true, 'the smoke receipt is saved with the Run');
  assert.equal((await runEpicGate({ engine: e.engine, run })).state, 'succeeded', 'a finished gate is returned as is');
  assert.equal(e.services.calls.review.length, 1);

  const empty = await runEpicGate({
    engine: e.engine,
    run: await createGateRunDraft({
      engine: e.engine,
      project: e.project,
      gate: e.gate(),
      tasks: e.tasks,
      installGateRun: e.installGateRun(draft => {
        draft.config.commands = { ...draft.config.commands, smoke: [] };
      }),
    }),
  });
  assert.equal(empty.state, 'succeeded', empty.error?.message);
  assert.deepEqual(
    { ...empty.smoke, headSha: null },
    { schemaVersion: 1, headSha: null, configured: false, complete: true, results: [] },
  );

  const failing = await runEpicGate({
    engine: e.engine,
    run: await createGateRunDraft({
      engine: e.engine,
      project: e.project,
      gate: e.gate(),
      tasks: e.tasks,
      installGateRun: e.installGateRun(draft => {
        draft.config.commands = {
          ...draft.config.commands,
          smoke: [{ command: process.execPath, args: ['-e', 'process.exit(3)'] }],
        };
      }),
    }),
  });
  assert.equal(failing.state, 'blocked');
  assert.equal(failing.error.code, 'smoke_failed');
  assert.equal(failing.smoke.complete, false);
  assert.equal(failing.smoke.results[0].exitCode, 3);
  assert.equal(failing.blocker.current.code, 'smoke_failed');
});

test('Epic gate repairs only inside the covered tasks and the watchdog stops the second round without progress', async t => {
  let round = 0;
  const e = await epic(t, {
    testScript: "console.error('epic check still fails');\nprocess.exit(1);\n",
    onWorker: async call => {
      assert.ok(isRepair(call));
      await write(call.cwd, 'src/a.mjs', `export const a = ${++round + 1};\n`);
      return done;
    },
  });
  const run = await createGateRunDraft({
    engine: e.engine,
    project: e.project,
    gate: e.gate(),
    tasks: e.tasks,
    input: { mode: 'deep' },
    installGateRun: e.installGateRun(),
  });
  const result = await runEpicGate({ engine: e.engine, run });
  assert.equal(result.state, 'blocked');
  assert.equal(result.verification.stopped, 'no_verified_progress');
  assert.equal(result.blocker.current.code, 'no_verified_progress');
  assert.equal(result.watchdog.stalled, 2);
  const repairs = e.services.calls.worker.filter(isRepair);
  assert.equal(repairs.length, 2, 'the baseline round and two rounds without progress');
  for (const call of repairs) assert.ok(call.prompt.includes(JSON.stringify(['src/a.mjs', 'src/b.mjs'])), call.prompt);
  assert.equal(e.services.calls.review.length, 0);
  assert.equal(result.smoke, undefined, 'smoke runs only after a passing verification');
});

test('An external task is verified once by fast checks and the behaviour gate without repair', async t => {
  const fx = await fixture(t, {
    config: { commands: { test: [{ command: process.execPath, args: ['--test'] }], build: [], deploy: [], smoke: [] } },
    testScript: 'process.exit(0);\n',
  });
  await write(fx.project, 'src/a.mjs', 'export const a = 1;\n');
  await commit(
    fx.project,
    'tests/a.test.mjs',
    "import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { a } from '../src/a.mjs';\ntest('a is positive', () => assert.ok(a > 0));\n",
  );
  const services = fakeServices();
  const store = fx.openStore(),
    engine = new Engine({ store, ...services });
  const created = await engine.create('External chat task', { project: fx.project });
  store.updateRun(created.id, { executor: { kind: 'external', host: 't3' }, verificationProfile: 'task-fast' });
  await makeWorktree(created.project, created.cwd, created.branch, created.baseSha);
  const good = await commit(created.cwd, 'src/a.mjs', 'export const a = 2;\n');
  const passed = await verifyTaskFastOnce({ engine, run: store.getRun(created.id) });
  assert.equal(passed.passed, true, passed.message);
  assert.equal(passed.headSha, good);
  assert.equal(passed.checks.profile, 'task-fast');
  assert.deepEqual(passed.checks.plan.testFiles, ['tests/a.test.mjs']);
  assert.equal(passed.behavior.passed, true);
  assert.equal(store.getRun(created.id).headSha, good);

  const bad = await commit(created.cwd, 'src/a.mjs', 'export const a = -1;\n');
  const failed = await verifyTaskFastOnce({ engine, run: store.getRun(created.id) });
  assert.equal(failed.passed, false);
  assert.equal(failed.code, 'check_failed');
  assert.equal(failed.headSha, bad);
  const stored = store.getRun(created.id);
  assert.equal(stored.headSha, good, 'a failed pass never advances the verified head');
  assert.equal(stored.verification, undefined, 'no repair cycle is started');
  assert.equal(stored.state, 'created');
  assert.equal(services.calls.worker.length + services.calls.review.length, 0);
});
