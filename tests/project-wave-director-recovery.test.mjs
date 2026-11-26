import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createWaveContext } from '../runtime/project-director-waves.mjs';
import { withIntegrationLease } from '../runtime/project-integration-lease.mjs';
import { evaluateWaveTransition } from '../runtime/project-wave-evidence.mjs';
import {
  task,
  git,
  fixture,
  statuses,
  reviewProfile,
  reserveFixtureAttempts,
  placeExternalRuns,
} from './helpers/wave-director-fixture.mjs';

test('drain refuses a legacy project and invalid bounds', async t => {
  const f = await fixture(t, { tasks: [task('alpha')], execution: null });
  await assert.rejects(f.director.drain(f.id), { code: 'project_wave_not_enabled' });
  await assert.rejects(f.director.drain(f.id, { concurrency: 8 }), { code: 'project_wave_not_enabled' });
  const ctx = createWaveContext({ repo: f.repo, engine: f.engine });
  assert.equal(ctx.store, f.store);
  for (const options of [{ maxWaves: 0 }, { maxWaves: 101 }, { concurrency: 65 }, { concurrency: 1.5 }])
    await assert.rejects(f.director.drain(f.id, options), { code: 'project_drain_invalid' });
});

test(
  'integrated is authorized only under the integration lease, by a merge still on the branch with its recorded parents',
  { timeout: 900000 },
  async t => {
    // Review finding F1-2a: a stored merge receipt was enough after the branch had moved; the
    // Git checks ran outside the lease and the first parent was never compared.
    let captured = null;
    const f = await fixture(t, {
      tasks: [task('alpha')],
      wrapRepo: repo => ({
        ...repo,
        apply: async command => {
          const action = command.action;
          if (!captured && action.op === 'transition' && action.kind === 'attempt' && action.to === 'integrated') {
            captured = command;
            throw Object.assign(new Error('Owned stop before the integrated transition'), { code: 'fixture_stop' });
          }
          return repo.apply(command);
        },
      }),
    });
    const stopped = await f.director.drain(f.id);
    assert.equal(stopped.status, 'blocked', JSON.stringify(stopped));
    const run = f.store.getRun(captured.action.evidence[0].runId);
    const integration = run.integration;
    assert.equal(integration.status, 'merged');
    const again = () => ({ ...captured, commandId: randomUUID(), expectedRevision: f.repo.snapshot(f.id).revision });
    const leased = work => withIntegrationLease(f.store, f.id, work);
    // Outside the lease a merge or merge-back may move the branch before the commit.
    await assert.rejects(f.repo.apply(again()), { code: 'project_integration_lease_required' });
    // A receipt whose `before` is not the merge's first parent proves nothing.
    f.store.updateRun(run.id, { integration: { ...integration, before: run.headSha } });
    await assert.rejects(
      leased(() => f.repo.apply(again())),
      { code: 'project_transition_blocked' },
      'first parent',
    );
    f.store.updateRun(run.id, { integration });
    // After the merge is rolled back the saved receipt proves nothing either.
    const worktree = f.integrationWorktree();
    git(worktree, 'reset', '--hard', integration.before);
    await assert.rejects(
      leased(() => f.repo.apply(again())),
      { code: 'project_transition_blocked' },
      'rollback',
    );
    git(worktree, 'reset', '--hard', integration.mergeCommit);
    // Under the lease, with the merge on the branch, the transition commits.
    await leased(() => f.repo.apply(again()));
    assert.equal(f.repo.snapshot(f.id).currentAttempts[0].status, 'integrated');
    const result = await f.director.drain(f.id);
    assert.equal(result.status, 'accepted', JSON.stringify(result));
  },
);

test(
  'The project is accepted only on a head still current after every check; a moved branch gets a project gate',
  { timeout: 900000 },
  async t => {
    // Review finding F1-2c: the integration head was read before the asynchronous proof, so a
    // branch moved during the check let the project be accepted on a stale head.
    let moved = null,
      f;
    f = await fixture(t, {
      tasks: [task('alpha')],
      evaluator: {
        evaluateWaveTransition: async (input, ports) => {
          const result = await evaluateWaveTransition(input, ports);
          const action = input.command.action;
          if (!moved && action.kind === 'project' && action.to === 'accepted')
            moved = await f.commitOnBranch('late.txt', 'late writer\n');
          return result;
        },
      },
    });
    const result = await f.director.drain(f.id);
    assert.equal(result.status, 'accepted', JSON.stringify(result));
    assert.ok(moved, 'the branch moved while the project proof was checked');
    const snapshot = f.repo.snapshot(f.id);
    assert.deepEqual(
      snapshot.gates.map(gate => gate.containers.map(row => row.kind)),
      [['epic', 'milestone', 'project'], ['project']],
    );
    const projectGate = snapshot.gates[1];
    assert.equal(projectGate.headSha, moved, 'the project gate verified the moved head');
    assert.equal(f.store.getRun(projectGate.runId).headSha, f.branchHead());
    assert.equal(git(f.root, 'show', `${f.branchHead()}:late.txt`), 'late writer');
  },
);

test(
  'When the branch moves after an epic gate covering the project, drain reserves a project gate on the current head',
  { timeout: 900000 },
  async t => {
    // F2 open question: the project stayed `integrated` with wave_project_head_mismatch.
    let moved = null,
      f;
    f = await fixture(t, {
      tasks: [task('alpha'), task('beta')],
      hooks: {
        onReview: async () => {
          if (!moved) moved = await f.commitOnBranch('late.txt', 'late writer\n');
        },
      },
    });
    const result = await f.director.drain(f.id, { concurrency: 2 });
    assert.equal(result.status, 'accepted', JSON.stringify(result));
    const snapshot = f.repo.snapshot(f.id);
    assert.equal(snapshot.project.status, 'accepted');
    assert.deepEqual(statuses(snapshot.tasks), { alpha: 'accepted', beta: 'accepted' });
    const [epicGate, projectGate] = snapshot.gates;
    assert.deepEqual(
      epicGate.containers.map(row => row.kind),
      ['epic', 'milestone', 'project'],
    );
    assert.notEqual(f.store.getRun(epicGate.runId).headSha, moved, 'the epic gate verified the earlier head');
    assert.deepEqual(projectGate.containers, [{ kind: 'project', id: f.id }]);
    assert.equal(projectGate.headSha, moved);
    assert.equal(projectGate.baseSha, epicGate.baseSha, 'the project gate reviews the whole project range');
    assert.equal(projectGate.merges.length, 2);
    assert.equal(f.calls.review, 2, 'the epic gate and the project gate');
  },
);

test(
  'A gate whose install is refused names its reserved Run, the install stage and the diagnosis',
  { timeout: 900000 },
  async t => {
    // Review findings (minor): gate_invalid carried no runId, stage or diagnosis, although the
    // reservation already names its Run; and the first install (right after the reservation)
    // threw past the handler of a later install, so the CLI showed only project_blocked.
    const refusal = 'Некорректный гейт эпика: owned install refusal';
    const f = await fixture(t, {
      tasks: [task('alpha')],
      wrapRepo: repo => ({
        ...repo,
        installGateRun: async () => {
          throw Object.assign(new Error(refusal), { code: 'gate_invalid' });
        },
      }),
    });
    const first = await f.director.drain(f.id);
    assert.equal(first.status, 'blocked', JSON.stringify(first));
    const [gate] = f.repo.snapshot(f.id).gates;
    assert.equal(gate.installed, false);
    assert.equal(typeof gate.runId, 'string');
    const named = row => row.kind === 'epic';
    // The first install (with the reservation) and a later one (the next pass) are reported alike.
    const result = await f.director.drain(f.id);
    assert.equal(result.status, 'blocked', JSON.stringify(result));
    assert.deepEqual(first.blockers.filter(named), result.blockers.filter(named));
    assert.equal(f.repo.snapshot(f.id).gates.length, 1, 'the refused reservation is not replaced');
    assert.deepEqual(result.blockers.filter(named), [
      {
        code: 'gate_invalid',
        kind: 'epic',
        id: 'e1',
        gateId: gate.id,
        runId: gate.runId,
        stage: 'install',
        message: refusal,
      },
    ]);
  },
);

test(
  'drain replaces a gate reservation whose install was interrupted and whose head went stale',
  { timeout: 900000 },
  async t => {
    // Review finding F1-3a: the stale reservation stayed blocked with gate_head_stale.
    let crash = true;
    const f = await fixture(t, {
      tasks: [task('alpha')],
      wrapRepo: repo => ({
        ...repo,
        installGateRun: async input => {
          if (crash) {
            crash = false;
            throw Object.assign(new Error('Owned crash before the gate install'), { code: 'fixture_crash' });
          }
          return repo.installGateRun(input);
        },
      }),
    });
    await assert.rejects(f.director.drain(f.id), /Owned crash before the gate install/);
    assert.deepEqual(
      f.repo.snapshot(f.id).gates.map(gate => gate.installed),
      [false],
    );
    const moved = await f.commitOnBranch('late.txt', 'late writer\n');
    const result = await f.director.drain(f.id);
    assert.equal(result.status, 'accepted', JSON.stringify(result));
    const gates = f.repo.snapshot(f.id).gates;
    assert.deepEqual(
      gates.map(gate => [gate.number, gate.installed, gate.supersededBy ?? null]),
      [
        [1, false, gates[1].id],
        [2, true, null],
      ],
    );
    assert.equal(gates[1].headSha, moved);
  },
);

test('A3 recovering native reservations respects external occupancy, including zero vacancies', async t => {
  const ids = ['e-one', 'e-two', 'e-three', 'n-one', 'n-two'];
  const f = await fixture(t, { tasks: ids.map(id => task(id)) });
  await reserveFixtureAttempts(f, ids);
  f.repo.setProfile(f.id, reviewProfile(3));
  const wait = await f.director.drain(f.id, { concurrency: 3, maxWaves: 1 });
  assert.deepEqual([wait.status, wait.waves, f.calls.worker.length], ['waiting_limits', 0, 0]);
  f.repo.setProfile(f.id, reviewProfile(4));
  const partial = await f.director.drain(f.id, { concurrency: 4, maxWaves: 1 });
  assert.equal(partial.waves, 1);
  assert.equal(f.calls.worker.length, 1);
});
test('A8 pause during a native wave takes effect on the next iteration; A5 resume waits', async t => {
  const { projectCli } = await import('../runtime/project-cli.mjs');
  let paused;
  const f = await fixture(t, {
    tasks: [task('alpha'), task('beta')],
    hooks: {
      onWorker: async () => {
        paused = await projectCli(
          ['profile', 'pause-pool', f.id, '--subscription', 'p', '--until', '2099-01-01T00:00:00Z'],
          { home: f.home, secrets: {} },
        );
      },
    },
  });
  f.repo.setProfile(f.id, reviewProfile(1));
  const result = await f.director.drain(f.id, { concurrency: 1 });
  assert.equal(paused.exitCode, 0, paused.output);
  assert.deepEqual([result.status, result.waves, f.calls.worker.length], ['waiting_limits', 1, 1]);
  assert.equal((await f.director.resume(f.id)).status, 'waiting_limits');
});

for (const mode of ['legacy', 'profile-default', 'profile-resume']) {
  test('B1 external attempts leave native capacity for ' + mode, async t => {
    const ids = ['e-one', 'e-two', 'e-three', 'n-one', 'n-two'];
    const f = await fixture(t, { tasks: ids.map(id => task(id)) });
    await reserveFixtureAttempts(f, ids);
    if (mode !== 'legacy') {
      const profile = reviewProfile(8);
      if (mode === 'profile-resume') {
        profile.subscriptions[0].slots = 5;
        profile.subscriptions.push({
          ...profile.subscriptions[0],
          id: 'paused',
          slots: 3,
          cooldownUntil: '2099-01-01T00:00:00Z',
        });
        placeExternalRuns(f, ids.slice(0, 3), 'paused');
      }
      f.repo.setProfile(f.id, profile);
    }
    const result =
      mode === 'profile-resume'
        ? await f.director.resume(f.id)
        : await f.director.drain(f.id, mode === 'legacy' ? { concurrency: 3, maxWaves: 1 } : { maxWaves: 1 });
    assert.equal(result.waves, 1, result.status);
    assert.equal(f.calls.worker.length, mode === 'profile-resume' ? 1 : 2);
  });
}
test('B3a a pause inside an epic gate applies before the next admission', async t => {
  let paused;
  const f = await fixture(t, {
    tasks: [task('alpha', { epicId: 'first' }), task('beta', { epicId: 'second', dependsOn: ['alpha'] })],
    hooks: {
      onReview: async () => {
        const { projectCli } = await import('../runtime/project-cli.mjs');
        paused = await projectCli(
          ['profile', 'pause-pool', f.id, '--subscription', 'p', '--until', '2099-01-01T00:00:00Z'],
          { home: f.home, secrets: {} },
        );
      },
    },
  });
  f.repo.setProfile(f.id, reviewProfile(1));
  const result = await f.director.drain(f.id);
  assert.equal(paused.exitCode, 0, paused.output);
  assert.deepEqual(f.calls.worker, ['alpha']);
  assert.equal(result.status, 'waiting_limits');
  assert.equal(
    f.repo.snapshot(f.id).currentAttempts.some(a => a.taskId === 'beta'),
    false,
  );
});
test('B6 drain blockers use the same horizon as a one-slot selection', async t => {
  const busy = Array.from({ length: 14 }, (_, i) => 'e-' + i);
  const tasks = [
    ...busy.map(id => task(id)),
    ...Array.from({ length: 29 }, (_, i) => task('waiting-' + i, { writePaths: [busy[0] + '.txt'] })),
  ];
  const f = await fixture(t, { tasks });
  await reserveFixtureAttempts(f, busy);
  const profile = reviewProfile(1);
  profile.machines[0].maxWorkers = 15;
  profile.subscriptions.push({
    ...profile.subscriptions[0],
    id: 'paused',
    slots: 14,
    cooldownUntil: '2099-01-01T00:00:00Z',
  });
  f.repo.setProfile(f.id, profile);
  placeExternalRuns(f, busy, 'paused');
  const result = await f.director.drain(f.id, { concurrency: 64 });
  assert.equal(result.status, 'blocked');
  assert.ok(!result.blockers.some(row => row.code === 'horizon_limit'), JSON.stringify(result.blockers));
});
