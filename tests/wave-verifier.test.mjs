import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Engine } from '../runtime/engine.mjs';
import { makeWorktree } from '../runtime/workspace.mjs';
import { createGateRunDraft, gateMergesHash, runEpicGate, verifyTaskFastOnce } from '../runtime/wave-verifier.mjs';
import * as contracts from '../runtime/project-contracts.mjs';
import { openProjectStore } from '../runtime/project-store.mjs';
import { ensureIntegration, mergeBackGate, mergeTask } from '../runtime/project-integration.mjs';
import { evaluateWaveTransition } from '../runtime/project-wave-evidence.mjs';
import { isCurrentBehaviorReceipt } from '../runtime/behavior-gate.mjs';
import { fixture, fakeServices, git } from './helpers/engine-fixture.mjs';

const { buildGateInput, buildGateManifest, gateBindingFor } = contracts;
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
const criterion = { id: 'works', text: 'Observable result works', evidenceKinds: ['checks'] };
const taskSpec = (id, writePath) => ({
  id,
  epicId: 'epic',
  title: `Task ${id}`,
  description: `Implement ${id}.`,
  owner: 'developer',
  dependsOn: [],
  writePaths: [writePath],
  acceptance: [criterion],
  interfaceRefs: [],
  priority: 50,
  userValue: 3,
  risk: 1,
  estimatedEffort: 2,
  riskApprovalRequired: false,
});
const waveSpec = root => ({
  schemaVersion: 1,
  id: 'wave-gate',
  root,
  title: 'Wave gate project',
  definitionOfDone: [criterion],
  constraints: ['Only assigned work'],
  businessContext: 'Owned fixture',
  architectureRefs: [],
  milestones: [{ id: 'milestone', title: 'Milestone', acceptance: [criterion], releaseRequired: false }],
  epics: [{ id: 'epic', milestoneId: 'milestone', title: 'Epic', acceptance: [criterion] }],
  tasks: [taskSpec('task-a', 'src/a.mjs'), taskSpec('task-b', 'src/b.mjs')],
  execution: { cadence: 'wave', integration: 'branch' },
});

/**
 * A wave project in the real project store (SQLite) whose two tasks were merged into the
 * real integration branch by their own task Runs; the epic is ready for one gate.
 */
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
  const services = fakeServices({ onWorker: onWorker ? async call => onWorker(call, services.calls) : undefined });
  const store = fx.openStore(),
    engine = new Engine({ store, ...services });
  const repo = await openProjectStore({ store, contracts, authorizeTransition: async () => undefined });
  const command = (projectId, action) => ({
    schemaVersion: 1,
    commandId: randomUUID(),
    projectId,
    expectedRevision: projectId ? repo.snapshot(projectId).revision : null,
    actor: 'coordinator',
    reason: 'Wave gate test',
    action,
  });
  const apply = (projectId, action) => repo.apply(command(projectId, action));
  const { projectId } = await apply(null, { op: 'create', spec: waveSpec(fx.project) });
  const integration = await ensureIntegration({
    root: fx.project,
    projectId,
    worktreeHome: path.join(fx.directory, 'integration-home'),
  });
  const baseSha = integration.head;
  const merges = [];
  for (const [taskId, file] of [
    ['task-a', 'src/a.mjs'],
    ['task-b', 'src/b.mjs'],
  ]) {
    await apply(projectId, { op: 'reserveAttempt', taskId, retryFailed: false });
    const attempt = repo.snapshot(projectId).currentAttempts.find(row => row.taskId === taskId);
    for (const to of ['ready', 'running', 'verifying', 'integrated'])
      await apply(projectId, { op: 'transition', kind: 'task', id: taskId, to, evidence: [], mappings: [] });
    for (const to of ['running', 'verifying', 'integrated'])
      await apply(projectId, { op: 'transition', kind: 'attempt', id: attempt.id, to, evidence: [], mappings: [] });
    // The task Run committed on its own branch and recorded its merge into the integration branch.
    const worktree = path.join(fx.directory, 'tasks', taskId);
    git(fx.project, 'worktree', 'add', '-b', `kodo/${attempt.runId}`, worktree, baseSha);
    const taskHead = await commit(worktree, file, `export const ${taskId.at(-1)} = 1;\n`);
    const merged = await mergeTask({
      worktree: integration.worktree,
      taskId,
      taskHead,
      writePaths: [file],
      savePending: async () => {},
    });
    store.createRun({ id: attempt.runId, project: fx.project, headSha: taskHead, integration: merged });
    merges.push({ taskId, attemptId: attempt.id, runId: attempt.runId, mergeCommit: merged.mergeCommit });
  }
  const headSha = git(integration.worktree, 'rev-parse', 'HEAD');
  const reserve = async (extra = {}) => {
    const reserved = await apply(projectId, {
      op: 'reserveGate',
      containers: [{ kind: 'epic', id: 'epic' }],
      baseSha,
      headSha,
      merges,
      retry: false,
      ...extra,
    });
    return repo.snapshot(projectId).gates.find(gate => gate.id === reserved.entity.id);
  };
  const draft = (gate, extra = {}) =>
    createGateRunDraft({
      engine,
      project: repo.snapshot(projectId).project,
      gate,
      tasks: repo.snapshot(projectId).tasks,
      containers: contracts.gateContainerCriteria(repo.snapshot(projectId), gate),
      installGateRun: repo.installGateRun,
      leaseHeld: true,
      ...extra,
    });
  return { fx, services, store, engine, repo, apply, projectId, integration, baseSha, headSha, merges, reserve, draft };
}

// Acceptance of a task by the gate Run: refs of that Run on its verified head.
async function acceptByGate(e, run) {
  const snapshot = e.repo.snapshot(e.projectId);
  const gate = snapshot.gates.find(row => row.runId === run.id);
  const refs = ['checks', 'review'].map((kind, index) => ({
    kind,
    runId: run.id,
    headSha: run.headSha,
    path: path.join(run.artifacts, 'evidence', `${kind}.json`),
    sha256: String(index + 1).repeat(64),
  }));
  return evaluateWaveTransition(
    {
      command: {
        schemaVersion: 1,
        commandId: randomUUID(),
        projectId: e.projectId,
        expectedRevision: snapshot.revision,
        actor: 'coordinator',
        reason: 'Gate verified',
        action: {
          op: 'transition',
          kind: 'task',
          id: 'task-a',
          to: 'accepted',
          evidence: refs,
          mappings: [{ criterionId: 'works', refs: [refs[0].sha256], actor: 'reviewer', reason: 'Gate checks' }],
        },
      },
      snapshot,
      run,
      gate,
    },
    { contracts, knownValues: [], verifyRef: async () => {}, validateRun: async () => {} },
  );
}

test('reserveGate → createGateRunDraft → installGateRun installs one gate Run in the real project store', async t => {
  const e = await epic(t);
  const gate = await e.reserve();
  await assert.rejects(() => e.draft(gate, { leaseHeld: false }), { code: 'gate_lease_required' });
  await assert.rejects(() => e.draft(gate, { installGateRun: undefined }), { code: 'gate_install_unavailable' });
  let leased = 0;
  const run = await e.draft(gate, {
    leaseHeld: false,
    input: { mode: 'deep' },
    withLease: async work => {
      leased++;
      return work();
    },
  });
  assert.equal(leased, 1, 'the head check and the install run inside the integration lease');
  const snapshot = e.repo.snapshot(e.projectId);
  assert.equal(snapshot.gates[0].installed, true);
  assert.deepEqual(e.store.getRun(gate.runId), run, 'the store saved exactly the installed draft');
  assert.equal(run.id, gate.runId);
  assert.equal(run.branch, `kodo/${gate.runId}`);
  assert.equal(path.basename(run.cwd), 'integration');
  assert.equal(
    run.task,
    buildGateInput({
      project: snapshot.project,
      gate,
      tasks: snapshot.tasks,
      containers: contracts.gateContainerCriteria(snapshot, gate),
    }),
    'the Run task is the exact gate input',
  );
  assert.equal(JSON.stringify(run.directorBinding), JSON.stringify(gateBindingFor(gate)));
  assert.equal(run.directorBinding.mergesHash, gateMergesHash(gate.merges));
  assert.notEqual(gateMergesHash(gate.merges), gateMergesHash([...gate.merges].reverse()));
  assert.equal(run.baseSha, gate.baseSha);
  assert.equal(run.headSha, gate.headSha);
  assert.deepEqual(
    run.plan.tasks.map(task => [task.id, task.writePaths, task.acceptance]),
    [
      ['task-a', ['src/a.mjs'], ['Observable result works']],
      ['task-b', ['src/b.mjs'], ['Observable result works']],
    ],
  );
  assert.deepEqual(
    Object.values(run.nodes).map(node => [node.id, node.status, node.headSha, node.sourceRunId]),
    gate.merges.map(merge => [merge.taskId, 'integrated', merge.mergeCommit, merge.runId]),
  );
  assert.deepEqual(run.completed, { implementation: true });
  assert.equal(run.executionMode.selected, 'deep');
  assert.equal(run.config.repairRounds, 5);
  assert.deepEqual(run.config.watchdog, { stalledRounds: 2, rejectUnchanged: true });
  assert.equal(run.verificationProfile, undefined, 'the gate run uses the full verification');
  await assert.rejects(() => e.engine.run(gate.runId), { code: 'project_run_not_native' });
  // A repeat (after a crash) returns the stored Run and installs nothing new.
  const revision = e.repo.snapshot(e.projectId).revision;
  assert.deepEqual(await e.draft(gate), run);
  assert.equal(e.repo.snapshot(e.projectId).revision, revision);
});

test('createGateRunDraft checks the merges and the integration head with Git before the store', async t => {
  const e = await epic(t);
  const gate = await e.reserve();
  let installs = 0;
  const counted = async input => {
    installs++;
    return e.repo.installGateRun(input);
  };
  for (const [label, invalid, tasks] of [
    ['unknown task', gate, e.repo.snapshot(e.projectId).tasks.slice(0, 1)],
    ['merge outside the head', { ...gate, headSha: e.merges[0].mergeCommit }, undefined],
    ['other project', { ...gate, projectId: randomUUID() }, undefined],
    ['bad run id', { ...gate, runId: '../escape' }, undefined],
  ])
    await assert.rejects(
      () => e.draft(invalid, { ...(tasks ? { tasks } : {}), installGateRun: counted }),
      { code: 'gate_invalid' },
      label,
    );
  // Each recorded merge commit must merge the head of its attempt (its second parent).
  const [first] = e.merges;
  const taskRun = e.store.getRun(first.runId);
  e.store.updateRun(first.runId, {
    headSha: e.baseSha,
    integration: { ...taskRun.integration, mergedHead: e.baseSha },
  });
  await assert.rejects(() => e.draft(gate, { installGateRun: counted }), { code: 'gate_invalid' }, 'second parent');
  e.store.updateRun(first.runId, { headSha: taskRun.headSha, integration: taskRun.integration });
  // The gate head must still be the head of the integration branch.
  await commit(e.integration.worktree, 'src/late.mjs', 'export const late = true;\n');
  await assert.rejects(() => e.draft(gate, { installGateRun: counted }), { code: 'gate_head_stale' });
  assert.equal(installs, 0, 'an invalid gate never reaches the installer');
});

test('A gate range is never empty: the store and createGateRunDraft refuse a base other than the first parent of the earliest covered merge', async t => {
  // Review finding F1-1: base = head after all merges installed a gate over an empty diff.
  const e = await epic(t);
  for (const [label, baseSha] of [
    ['base = head', e.headSha],
    ['base after the earliest merge', e.merges[0].mergeCommit],
  ])
    await assert.rejects(e.reserve({ baseSha }), { code: 'project_gate_invalid' }, label);
  assert.deepEqual(e.repo.snapshot(e.projectId).gates, []);
  const gate = await e.reserve();
  let installs = 0;
  const counted = async input => {
    installs++;
    return e.repo.installGateRun(input);
  };
  // Forged gate records never reach the installer either.
  for (const [label, forged] of [
    ['base = head', { ...gate, baseSha: gate.headSha }],
    ['base after the earliest merge', { ...gate, baseSha: e.merges[0].mergeCommit }],
  ])
    await assert.rejects(e.draft(forged, { installGateRun: counted }), { code: 'gate_invalid' }, label);
  // The first parent of each merge must be the `before` its task Run recorded.
  const [first] = e.merges;
  const recorded = e.store.getRun(first.runId);
  e.store.updateRun(first.runId, { integration: { ...recorded.integration, before: e.headSha } });
  await assert.rejects(e.draft(gate, { installGateRun: counted }), { code: 'gate_invalid' }, 'first parent');
  e.store.updateRun(first.runId, { integration: recorded.integration });
  assert.equal(installs, 0);
  const run = await e.draft(gate, { installGateRun: counted });
  assert.deepEqual([run.baseSha, run.headSha], [e.baseSha, e.headSha], 'the range holds both merges');
  // The full contracts of the covered tasks are the gate manifest artifact the input binds.
  const snapshot = e.repo.snapshot(e.projectId);
  const envelope = JSON.parse(await readFile(run.gateManifest.path, 'utf8'));
  assert.deepEqual(
    envelope.value,
    buildGateManifest({
      project: snapshot.project,
      gate,
      tasks: snapshot.tasks,
      containers: contracts.gateContainerCriteria(snapshot, gate),
    }).manifest,
  );
});

test('An exact repeat of an installed gate returns its Run after the branch moved', async t => {
  // Review finding F1-3b: the repeat checked the head first and failed with gate_head_stale.
  const e = await epic(t);
  const gate = await e.reserve();
  const run = await e.draft(gate);
  await commit(e.integration.worktree, 'src/late.mjs', 'export const late = true;\n');
  assert.deepEqual(await e.draft(gate), run);
  assert.deepEqual(await e.draft(e.repo.snapshot(e.projectId).gates[0]), run);
});

test('A quick-mode gate Run keeps two repair rounds: a repair is verified again', async t => {
  const e = await epic(t);
  const run = await e.draft(await e.reserve(), { input: { mode: 'quick' } });
  assert.equal(run.executionMode.selected, 'quick');
  assert.equal(run.executionMode.profile.repairRounds, 1, 'the quick profile alone allows one');
  assert.equal(run.config.repairRounds, 2);
});

test('A reservation whose head went stale before its install is replaced by one on the current head', async t => {
  // Review finding F1-3a: the stale reservation blocked every new one with project_gate_exists.
  const e = await epic(t);
  const stale = await e.reserve();
  await commit(e.integration.worktree, 'src/late.mjs', 'export const late = true;\n');
  await assert.rejects(e.draft(stale), { code: 'gate_head_stale' });
  const head = git(e.integration.worktree, 'rev-parse', 'HEAD');
  const fresh = await e.reserve({ headSha: head });
  const gates = e.repo.snapshot(e.projectId).gates;
  assert.deepEqual(
    gates.map(row => [row.number, row.installed, row.supersededBy ?? null]),
    [
      [1, false, fresh.id],
      [2, false, null],
    ],
  );
  await assert.rejects(e.draft(gates[0]), { code: 'gate_head_stale' });
  const run = await e.draft(fresh);
  assert.deepEqual([run.id, run.headSha], [fresh.runId, head]);
  assert.equal(e.repo.snapshot(e.projectId).gates[1].installed, true);
});

test('Epic gate verifies once with review, executes smoke and records it', async t => {
  const e = await epic(t);
  const run = await e.draft(await e.reserve());
  const result = await runEpicGate({ engine: e.engine, run });
  assert.equal(result.state, 'succeeded', result.error?.message);
  assert.equal(e.services.calls.review.length, 1, 'one independent review of the whole epic diff');
  assert.equal(result.review.passed, true);
  assert.equal(result.checks.profile, undefined);
  assert.equal(result.checks.complete, true);
  assert.equal(result.headSha, e.headSha);
  assert.equal(git(result.cwd, 'rev-parse', 'HEAD'), e.headSha);
  assert.equal(git(result.cwd, 'rev-parse', '--abbrev-ref', 'HEAD'), `kodo/${run.id}`);
  assert.equal(
    isCurrentBehaviorReceipt(result.behavior, {
      headSha: result.headSha,
      baseSha: result.baseSha,
      config: result.config,
    }),
    true,
  );
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
  // The real gate Run carries every receipt wave acceptance requires.
  const accepted = await acceptByGate(e, e.store.getRun(run.id));
  assert.deepEqual(accepted.blockers, []);
  assert.ok(accepted.eligibleStates.includes('accepted'));
});

test('A failing smoke command blocks the gate', async t => {
  const e = await epic(t);
  // The integration head the gate verifies now carries a failing smoke script.
  await write(e.integration.worktree, 'smoke.mjs', 'process.exit(3);\n');
  git(e.integration.worktree, 'add', '-A');
  git(e.integration.worktree, 'commit', '-m', 'Failing smoke');
  const headSha = git(e.integration.worktree, 'rev-parse', 'HEAD');
  const gate = await e.reserve({ headSha });
  const failing = await runEpicGate({ engine: e.engine, run: await e.draft(gate) });
  assert.equal(failing.state, 'blocked');
  assert.equal(failing.error.code, 'smoke_failed');
  assert.equal(failing.smoke.complete, false);
  assert.equal(failing.smoke.results[0].exitCode, 3);
  assert.equal(failing.blocker.current.code, 'smoke_failed');
});

test('A repaired gate is accepted on its verified head and merges back to the integration branch', async t => {
  const e = await epic(t, {
    testScript: "const { a } = await import('./src/a.mjs');\nprocess.exit(a === 5 ? 0 : 1);\n",
    onWorker: async call => {
      assert.ok(isRepair(call));
      await write(call.cwd, 'src/a.mjs', 'export const a = 5;\n');
      return done;
    },
  });
  const gate = await e.reserve();
  const result = await runEpicGate({ engine: e.engine, run: await e.draft(gate) });
  assert.equal(result.state, 'succeeded', result.error?.message);
  assert.notEqual(result.headSha, gate.headSha, 'the repair moved the verified head');
  assert.equal(result.directorBinding.headSha, gate.headSha, 'the binding keeps the gate head');
  assert.equal(git(result.cwd, 'merge-base', '--is-ancestor', gate.headSha, result.headSha), '');
  assert.equal(result.smoke.headSha, result.headSha);
  const accepted = await acceptByGate(e, e.store.getRun(result.id));
  assert.deepEqual(accepted.blockers, []);
  assert.ok(
    accepted.eligibleStates.includes('accepted'),
    'checks, review, behaviour and smoke are on the repaired head',
  );
  const head = await mergeBackGate({
    worktree: e.integration.worktree,
    expectedHead: gate.headSha,
    gateHead: result.headSha,
  });
  assert.equal(head, result.headSha, 'an unchanged integration branch fast-forwards to the verified head');
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
  const run = await e.draft(await e.reserve(), { input: { mode: 'deep' } });
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
