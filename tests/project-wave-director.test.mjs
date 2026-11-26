import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import * as A from '../runtime/project-contracts.mjs';
import { selectWave } from '../runtime/project-director-waves.mjs';
import { nextWave } from '../runtime/project-external.mjs';
import { proof, task, git, fixture, statuses } from './helpers/wave-director-fixture.mjs';

test(
  'Three disjoint tasks run in parallel, integrate into the project branch and one gate accepts the chain',
  { timeout: 900000 },
  async t => {
    const f = await fixture(t, {
      hooks: {
        // Each worker waits until all three are inside a session: proves overlapping execution.
        onWorker: async (_request, _id, calls) => {
          for (let i = 0; i < 400 && calls.active < 3; i++) await delay(25);
        },
      },
    });
    const before = f.user();
    const result = await f.director.drain(f.id, { concurrency: 3 });
    assert.equal(result.status, 'accepted', JSON.stringify(result));
    assert.equal(result.waves, 1);
    assert.deepEqual([...result.integrated].sort(), ['alpha', 'beta', 'gamma']);
    assert.equal(f.calls.maxActive, 3, 'three task sessions overlapped in time');
    assert.equal(f.calls.analysis, 0, 'quick mode: no Gemini analysis');
    assert.equal(f.calls.review, 1, 'one independent review: the gate');
    const snapshot = f.repo.snapshot(f.id);
    assert.equal(snapshot.project.status, 'accepted');
    assert.deepEqual(statuses(snapshot.milestones), { m1: 'accepted' });
    assert.deepEqual(statuses(snapshot.epics), { e1: 'accepted' });
    assert.deepEqual(statuses(snapshot.tasks), { alpha: 'accepted', beta: 'accepted', gamma: 'accepted' });
    assert.ok(snapshot.currentAttempts.every(row => row.status === 'accepted'));
    assert.equal(snapshot.gates.length, 1);
    const [gate] = snapshot.gates;
    assert.deepEqual(
      new Set(gate.provenance.map(entry => entry.commit)),
      new Set(gate.merges.map(entry => entry.mergeCommit)),
    );
    for (const entry of gate.provenance) {
      const attempt = snapshot.currentAttempts.find(row => row.id === entry.ref);
      assert.equal(entry.kind, 'task');
      assert.deepEqual(entry.writePaths, snapshot.tasks.find(task => task.id === attempt.taskId).writePaths);
    }
    assert.deepEqual(f.store.getRun(gate.runId).directorBinding.provenance, gate.provenance);
    assert.deepEqual(snapshot.gates[0].containers, [
      { kind: 'epic', id: 'e1' },
      { kind: 'milestone', id: 'm1' },
      { kind: 'project', id: f.id },
    ]);
    assert.deepEqual(result.gates, [
      { gateId: snapshot.gates[0].id, runId: snapshot.gates[0].runId, state: 'succeeded' },
    ]);
    // Task runs: task-fast, quick, no delivery, the wave watchdog and the drain concurrency.
    const taskRuns = f.runs().filter(run => run.directorBinding?.kind !== 'gate');
    assert.equal(taskRuns.length, 3);
    for (const run of taskRuns) {
      assert.equal(run.verificationProfile, 'task-fast');
      assert.equal(run.checks.profile, 'task-fast');
      assert.equal(run.executionMode.selected, 'quick');
      assert.equal(run.config.delivery.enabled, false);
      assert.deepEqual(run.config.watchdog, { stalledRounds: 2, rejectUnchanged: true });
      assert.equal(run.config.concurrency, 3);
      assert.equal(run.integration.status, 'merged');
      assert.equal(run.integration.branch, `kodo/project/${f.id}`);
    }
    assert.deepEqual(f.merges().sort(), ['Kodo: integrate alpha', 'Kodo: integrate beta', 'Kodo: integrate gamma']);
    for (const name of ['alpha', 'beta', 'gamma'])
      assert.equal(git(f.root, 'show', `refs/heads/kodo/project/${f.id}:${name}.txt`), `${name} implemented`);
    assert.deepEqual(f.user(), before, "the user's HEAD, branch and working tree are untouched");
    const again = await f.director.drain(f.id);
    assert.equal(again.status, 'accepted');
    assert.equal(again.waves, 0);
  },
);

test('Tasks with overlapping write paths never share a wave', { timeout: 900000 }, async t => {
  const f = await fixture(t, {
    tasks: [
      task('wide', { writePaths: ['notes/**'] }),
      task('narrow', { writePaths: ['notes/narrow.txt'] }),
      task('other', { writePaths: ['other.txt'] }),
    ],
    files: { wide: 'notes/wide.txt', narrow: 'notes/narrow.txt' },
  });
  const snapshot = f.repo.snapshot(f.id);
  assert.deepEqual(selectWave(snapshot, { limit: 3 }), ['narrow', 'other']);
  assert.deepEqual(selectWave(snapshot, { limit: 3, inFlight: ['narrow'] }), ['other']);
  assert.deepEqual(selectWave(snapshot, { limit: 1 }), ['narrow']);
  assert.throws(() => selectWave(snapshot, { limit: 0 }), { code: 'project_limit_invalid' });
  const result = await f.director.drain(f.id, { concurrency: 3 });
  assert.equal(result.status, 'accepted', JSON.stringify(result));
  assert.equal(result.waves, 2);
  const runs = f.runs().filter(run => run.directorBinding?.kind !== 'gate');
  const wide = runs.find(run => run.directorBinding.taskId === 'wide'),
    narrow = runs.find(run => run.directorBinding.taskId === 'narrow');
  // The second wave starts from the integration head that already contains the first merge.
  const ancestor = spawnSync('git', ['merge-base', '--is-ancestor', narrow.integration.mergeCommit, wide.baseSha], {
    cwd: f.root,
  });
  assert.equal(ancestor.status, 0);
});

test(
  'The watchdog stops a gate on its second round without progress; --retry-failed creates a new gate',
  { timeout: 900000 },
  async t => {
    let round = 0;
    const f = await fixture(t, {
      tasks: [task('alpha'), task('beta')],
      config: { executionMode: 'deep', repairRounds: 5 },
      failTogether: ['alpha.txt', 'beta.txt'],
      hooks: {
        onRepair: async request => writeFile(path.join(request.cwd, 'alpha.txt'), `repair ${++round}\n`),
      },
    });
    await writeFile(f.flag, 'fail\n');
    const blocked = await f.director.drain(f.id, { concurrency: 2 });
    assert.equal(blocked.status, 'blocked', JSON.stringify(blocked));
    assert.equal(blocked.code, 'no_verified_progress');
    assert.equal(f.calls.repair.length, 2, 'the watchdog stopped on the second round without progress');
    let snapshot = f.repo.snapshot(f.id);
    assert.deepEqual(statuses(snapshot.tasks), { alpha: 'integrated', beta: 'integrated' });
    assert.equal(snapshot.epics[0].status, 'integrated');
    assert.equal(snapshot.gates.length, 1);
    assert.equal(f.store.getRun(snapshot.gates[0].runId).state, 'blocked');
    // Audit finding 8a: a gate blocker names its gate and gate Run, the place of its findings.
    const named = { gateId: snapshot.gates[0].id, runId: snapshot.gates[0].runId };
    const gateRows = result =>
      result.blockers.filter(row => row.kind === 'epic').map(({ gateId, runId }) => ({ gateId, runId }));
    assert.deepEqual(gateRows(blocked), [named]);
    // Audit finding 4a: the pull protocol names the stopped gate instead of an empty wave.
    const ctx = { repo: f.repo, engine: f.engine, store: f.store, contracts: A };
    const waiting = await nextWave(ctx, { projectId: f.id, host: 't3' });
    assert.deepEqual(waiting.briefs, []);
    assert.deepEqual(waiting.blocked, [
      { code: 'no_verified_progress', kind: 'epic', id: 'e1', ...named, state: 'blocked' },
    ]);
    await rm(f.flag);
    const still = await f.director.drain(f.id);
    assert.equal(still.status, 'blocked', 'a failed gate is retried only explicitly');
    assert.deepEqual(gateRows(still), [named]);
    assert.equal(f.repo.snapshot(f.id).gates.length, 1);
    const accepted = await f.director.drain(f.id, { retryFailed: true });
    assert.equal(accepted.status, 'accepted', JSON.stringify(accepted));
    snapshot = f.repo.snapshot(f.id);
    assert.deepEqual(
      snapshot.gates.map(gate => gate.number),
      [1, 2],
    );
    assert.equal(f.store.getRun(snapshot.gates[1].runId).state, 'succeeded');
    assert.equal(snapshot.project.status, 'accepted');
  },
);

test('A quota stop returns waiting_limits and the next drain resumes the same Run', { timeout: 900000 }, async t => {
  let quota = true;
  const f = await fixture(t, {
    tasks: [task('alpha')],
    hooks: {
      onWorker: async () => {
        if (!quota) return;
        quota = false;
        throw Object.assign(new Error('fixture quota'), { code: 'quota' });
      },
    },
  });
  const waiting = await f.director.drain(f.id);
  assert.equal(waiting.status, 'waiting_limits', JSON.stringify(waiting));
  assert.deepEqual(
    waiting.blockers.map(row => [row.code, row.id]),
    [['quota', 'alpha']],
  );
  const [run] = f.runs();
  assert.equal(run.state, 'waiting_limits');
  assert.equal(f.repo.snapshot(f.id).currentAttempts[0].status, 'reserved');
  const accepted = await f.director.drain(f.id);
  assert.equal(accepted.status, 'accepted', JSON.stringify(accepted));
  const snapshot = f.repo.snapshot(f.id);
  assert.equal(snapshot.currentAttempts[0].runId, run.id, 'the same reservation and Run continue');
  assert.equal(snapshot.currentAttempts[0].number, 1);
  assert.equal(f.runs().filter(row => row.directorBinding?.kind !== 'gate').length, 1);
});

test(
  'A write outside writePaths blocks the wave task with scope_conflict without a repair round',
  { timeout: 900000 },
  async t => {
    const f = await fixture(t, {
      tasks: [task('alpha'), task('beta')],
      config: { executionMode: 'deep', repairRounds: 5 },
      hooks: {
        onWorker: async (request, id) => {
          if (id === 'alpha') await writeFile(path.join(request.cwd, 'stray.txt'), 'outside the task\n');
        },
      },
    });
    const result = await f.director.drain(f.id, { concurrency: 2 });
    assert.equal(result.status, 'blocked', JSON.stringify(result));
    assert.deepEqual(
      result.blockers.map(row => [row.kind, row.id, row.code]),
      [['task', 'alpha', 'scope_conflict']],
    );
    assert.deepEqual(
      f.calls.worker.filter(id => id === 'alpha'),
      ['alpha'],
      'the scope violation spends no repair session',
    );
    const run = f.runs().find(row => row.directorBinding?.taskId === 'alpha');
    assert.equal(run.state, 'blocked');
    assert.equal(run.blocker.current.code, 'scope_conflict');
    assert.equal(run.nodes.implementation.attempt, 1);
    const snapshot = f.repo.snapshot(f.id);
    assert.equal(snapshot.tasks.find(row => row.id === 'beta').status, 'integrated');
    assert.equal(
      spawnSync('git', ['cat-file', '-e', `${f.branchHead()}:stray.txt`], { cwd: f.root }).status !== 0,
      true,
      'the stray file never reaches the integration branch',
    );
  },
);

test('A missing risk approval blocks the drain before any reservation', async t => {
  const f = await fixture(t, {
    tasks: [task('alpha', { riskApprovalRequired: true }), task('beta', { dependsOn: ['alpha'] })],
  });
  const result = await f.director.drain(f.id);
  assert.equal(result.status, 'blocked');
  assert.equal(result.code, 'risk_approval_required');
  assert.equal(result.waves, 0);
  assert.equal(f.repo.snapshot(f.id).currentAttempts.length, 0);
  assert.equal(f.runs().length, 0);
  await f.director.approveRisk(f.id, 'alpha', { reason: 'Reviewed fixture risk' });
  assert.deepEqual(selectWave(f.repo.snapshot(f.id), { limit: 3 }), ['alpha']);
});

test('resume of a wave project executes exactly one task', { timeout: 900000 }, async t => {
  const f = await fixture(t, { tasks: [task('alpha'), task('beta')] });
  const first = await f.director.resume(f.id);
  assert.equal(first.status, 'succeeded', JSON.stringify(first));
  assert.equal(first.drainStatus, 'max_waves');
  assert.equal(first.integrated.length, 1);
  let snapshot = f.repo.snapshot(f.id);
  assert.equal(snapshot.currentAttempts.length, 1);
  assert.equal(f.runs().length, 1);
  assert.equal(f.calls.worker.length, 1);
  const second = await f.director.resume(f.id);
  assert.equal(second.status, 'succeeded', JSON.stringify(second));
  assert.equal(second.drainStatus, 'accepted');
  snapshot = f.repo.snapshot(f.id);
  assert.equal(snapshot.currentAttempts.length, 2);
  assert.equal(snapshot.project.status, 'accepted');
});

test('appendMilestone reopens an accepted project and drain accepts it again', { timeout: 900000 }, async t => {
  const f = await fixture(t, { tasks: [task('alpha')] });
  assert.equal((await f.director.drain(f.id)).status, 'accepted');
  const reopened = await f.repo.apply(
    f.command(f.repo.snapshot(f.id), {
      op: 'appendMilestone',
      milestone: { id: 'm2', title: 'Second', acceptance: [proof('m2-proof')], releaseRequired: false },
      epics: [{ id: 'e2', milestoneId: 'm2', title: 'Second epic', acceptance: [proof('e2-proof')] }],
      tasks: [task('delta', { epicId: 'e2', dependsOn: ['alpha'] })],
    }),
  );
  assert.equal(f.repo.snapshot(f.id).project.status, 'running', JSON.stringify(reopened));
  const result = await f.director.drain(f.id);
  assert.equal(result.status, 'accepted', JSON.stringify(result));
  const snapshot = f.repo.snapshot(f.id);
  assert.equal(snapshot.project.reopened.length, 1);
  assert.deepEqual(statuses(snapshot.tasks), { alpha: 'accepted', delta: 'accepted' });
  assert.deepEqual(
    snapshot.gates.map(gate => gate.containers.map(row => row.kind)),
    [
      ['epic', 'milestone', 'project'],
      ['epic', 'milestone', 'project'],
    ],
  );
  assert.deepEqual(
    snapshot.gates[1].merges.map(row => row.taskId),
    ['alpha', 'delta'],
  );
  const delta = f.runs().find(run => run.directorBinding?.taskId === 'delta');
  assert.equal(
    spawnSync('git', ['merge-base', '--is-ancestor', snapshot.gates[0].headSha, delta.baseSha], { cwd: f.root }).status,
    0,
    'the new task starts from the accepted integration head',
  );
});

test('cancel during a gate cancels its Run and the drain', { timeout: 900000 }, async t => {
  let director;
  const f = await fixture(t, {
    tasks: [task('alpha')],
    hooks: {
      onReview: async () => {
        assert.deepEqual(await director.cancel(f.id), { status: 'cancelled' });
      },
    },
  });
  director = f.director;
  const result = await f.director.drain(f.id);
  assert.equal(result.status, 'cancelled', JSON.stringify(result));
  const snapshot = f.repo.snapshot(f.id);
  assert.equal(snapshot.project.status, 'cancelled');
  const gate = f.store.getRun(snapshot.gates[0].runId);
  assert.equal(gate.cancelRequested, true);
  assert.equal(gate.state, 'cancelled');
  assert.equal(snapshot.tasks[0].status, 'integrated', 'no acceptance without a finished gate');
});

test('A repeated drain after a crash mid-wave never duplicates merges', { timeout: 900000 }, async t => {
  const f = await fixture(t, { tasks: [task('alpha'), task('beta')] });
  const updateRun = f.store.updateRun.bind(f.store);
  let crashed = false;
  f.store.updateRun = (id, patch, options) => {
    if (!crashed && patch.integration?.status === 'merged') {
      crashed = true;
      throw Object.assign(new Error('Owned crash after the merge commit'), { code: 'fixture_crash' });
    }
    return updateRun(id, patch, options);
  };
  await assert.rejects(f.director.drain(f.id, { concurrency: 2 }), /Owned crash after the merge commit/);
  f.store.updateRun = updateRun;
  const pending = f.runs().filter(run => run.integration?.status === 'pending');
  assert.equal(pending.length, 1, 'the merge happened, its record did not');
  assert.equal(f.merges().length >= 1, true);
  const result = await f.director.drain(f.id, { concurrency: 2 });
  assert.equal(result.status, 'accepted', JSON.stringify(result));
  assert.deepEqual(f.merges().sort(), ['Kodo: integrate alpha', 'Kodo: integrate beta']);
  assert.equal(f.runs().filter(run => run.directorBinding?.kind !== 'gate').length, 2, 'no new Run');
  assert.equal(f.calls.worker.length, 2, 'no task executed twice');
});
