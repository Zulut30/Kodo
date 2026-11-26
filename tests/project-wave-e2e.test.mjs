import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { createProjectDirector } from '../runtime/project-director.mjs';
import { NATIVE_RESERVER, externalReserver } from '../runtime/project-director-waves.mjs';
import { confirmedCriteria } from './helpers/gate-review.mjs';
import { task, git, fixture, editConfig, authorizeByGate } from './helpers/wave-e2e-fixture.mjs';

test(
  'drain accepts two epics: wave 0, two parallel tasks and an epic gate that repairs the combined result',
  { timeout: 900000 },
  async t => {
    const f = await fixture(t, {
      epics: ['e0', 'e1'],
      tasks: [
        task('base', { epicId: 'e0' }),
        task('left', { dependsOn: ['base'] }),
        task('right', { dependsOn: ['base'] }),
      ],
      hooks: {
        // Both tasks of the second wave stay inside a session until the other one arrives.
        onWorker: async (id, calls) => {
          if (id === 'base') return;
          for (let i = 0; i < 400 && calls.active < 2; i++) await delay(25);
        },
        onRepair: request => writeFile(path.join(request.cwd, 'left.txt'), 'left fixed\n'),
      },
    });
    const user = git(f.root, 'rev-parse', 'HEAD');
    const result = await createProjectDirector({ repo: f.repo, engine: f.engine }).drain(f.id, { concurrency: 2 });
    assert.equal(result.status, 'accepted', JSON.stringify(result));
    assert.equal(result.waves, 2, 'wave 0 (base), then left and right together');
    assert.equal(result.integrated[0], 'base');
    assert.deepEqual([...result.integrated].sort(), ['base', 'left', 'right']);
    assert.equal(f.calls.maxActive, 2, 'left and right overlapped in time');
    assert.equal(f.calls.repair.length, 1, 'one repair round inside the epic gate');

    const snapshot = f.repo.snapshot(f.id);
    assert.equal(snapshot.project.status, 'accepted');
    assert.deepEqual(f.statuses(snapshot.milestones), { m1: 'accepted' });
    assert.deepEqual(f.statuses(snapshot.epics), { e0: 'accepted', e1: 'accepted' });
    assert.deepEqual(f.statuses(snapshot.tasks), { base: 'accepted', left: 'accepted', right: 'accepted' });
    assert.ok(snapshot.currentAttempts.every(row => row.status === 'accepted'));
    assert.deepEqual(
      snapshot.gates.map(gate => gate.containers.map(row => `${row.kind}:${row.kind === 'project' ? '' : row.id}`)),
      [['epic:e0'], ['epic:e1', 'milestone:m1', 'project:']],
    );
    const [first, second] = snapshot.gates.map(gate => f.store.getRun(gate.runId));
    assert.equal(first.state, 'succeeded');
    assert.equal(first.headSha, snapshot.gates[0].headSha, 'the first gate needed no repair');
    assert.equal(second.state, 'succeeded');
    assert.notEqual(second.headSha, snapshot.gates[1].headSha, 'the repair moved the verified head');
    assert.equal(second.directorBinding.headSha, snapshot.gates[1].headSha, 'the binding keeps the gate head');
    assert.equal(f.branchHead(), second.headSha, 'the repaired head was fast-forwarded into the branch');
    assert.equal(git(f.root, 'show', `${f.branchHead()}:left.txt`), 'left fixed');
    assert.equal(git(f.root, 'show', `${f.branchHead()}:right.txt`), 'right implemented');
    // Wave 1 started from the head that already contains the wave 0 merge.
    const runs = f.taskRuns();
    const base = runs.find(run => run.directorBinding.taskId === 'base');
    for (const id of ['left', 'right']) {
      const run = runs.find(row => row.directorBinding.taskId === id);
      assert.equal(git(f.root, 'merge-base', '--is-ancestor', base.integration.mergeCommit, run.baseSha), '');
      assert.equal(run.verificationProfile, 'task-fast');
    }
    assert.equal(git(f.root, 'rev-parse', 'HEAD'), user, "the user's checkout is untouched");
    const again = await createProjectDirector({ repo: f.repo, engine: f.engine }).drain(f.id);
    assert.deepEqual([again.status, again.waves], ['accepted', 0]);
  },
);

test(
  'T3 pull path: next-wave, a worker commit, complete-task, the epic gate, a replay, and drain leaves the external attempt alone',
  { timeout: 900000 },
  async t => {
    const f = await fixture(t, { epics: ['e1'], tasks: [task('alpha', { priority: 90 }), task('beta')] });
    const next = await f.cli(['next-wave', f.id, '--host', 't3', '--limit', '1']);
    assert.equal(next.exitCode, 0, next.output);
    const [brief] = next.report.result.briefs;
    assert.equal(brief.taskId, 'alpha');
    assert.equal(brief.baseSha, f.branchHead());

    // The drain executes beta natively and never touches the external alpha attempt.
    const drained = await f.cli(['drain', f.id]);
    assert.equal(drained.report.result.status, 'blocked', drained.output);
    assert.deepEqual(drained.report.result.integrated, ['beta']);
    assert.deepEqual(f.calls.worker, ['beta']);
    let snapshot = f.repo.snapshot(f.id);
    const alphaAttempt = snapshot.currentAttempts.find(row => row.taskId === 'alpha');
    assert.equal(alphaAttempt.runId, brief.runId);
    assert.equal(alphaAttempt.status, 'running');
    const external = f.store.getRun(brief.runId);
    assert.deepEqual([external.state, external.checks ?? null], ['executing', null]);
    assert.deepEqual(external.executor, { kind: 'external', host: 't3' });

    // The worker chat commits in its own worktree and reports the SHA.
    await writeFile(path.join(brief.worktree, 'alpha.txt'), 'alpha by the worker chat\n');
    git(brief.worktree, 'add', '-A');
    git(brief.worktree, 'commit', '-m', 'Implement alpha');
    const head = git(brief.worktree, 'rev-parse', 'HEAD');
    const completed = await f.cli(['complete-task', f.id, 'alpha', '--head', head]);
    assert.equal(completed.exitCode, 0, completed.output);
    const result = completed.report.result;
    assert.equal(result.status, 'integrated');
    assert.deepEqual(result.gates.blocked, []);
    assert.equal(result.gates.gates.length, 1);
    assert.equal(result.gates.gates[0].state, 'succeeded');
    snapshot = f.repo.snapshot(f.id);
    assert.equal(snapshot.project.status, 'accepted');
    assert.deepEqual(f.statuses(snapshot.tasks), { alpha: 'accepted', beta: 'accepted' });
    assert.deepEqual(f.statuses(snapshot.epics), { e1: 'accepted' });
    const alphaRun = f.store.getRun(brief.runId);
    assert.equal(alphaRun.headSha, head);
    assert.equal(alphaRun.checks.profile, 'task-fast');
    assert.equal(git(f.root, 'merge-base', '--is-ancestor', head, f.branchHead()), '');
    assert.equal(git(f.root, 'show', `${f.branchHead()}:alpha.txt`), 'alpha by the worker chat');

    const replay = await f.cli(['complete-task', f.id, 'alpha', '--head', head]);
    assert.equal(replay.exitCode, 0, replay.output);
    assert.equal(replay.report.result.replayed, true);
    assert.deepEqual(replay.report.result.integration, result.integration);
    assert.equal(replay.report.result.revision, snapshot.revision, 'a replay writes nothing');
    assert.equal(f.repo.snapshot(f.id).gates.length, 1, 'no second gate');
  },
);

test('drain --retry-failed never executes natively a task an external chat abandoned', { timeout: 900000 }, async t => {
  // F2 open question: the retry went to the drain, which re-ran the external task natively.
  const f = await fixture(t, { epics: ['e1'], tasks: [task('ext')] });
  const next = await f.cli(['next-wave', f.id, '--host', 't3']);
  assert.equal(next.exitCode, 0, next.output);
  const [brief] = next.report.result.briefs;
  const abandoned = await f.cli([
    'complete-task',
    f.id,
    'ext',
    '--head',
    brief.baseSha,
    '--abandon',
    '--attempt',
    brief.attemptId,
  ]);
  assert.equal(abandoned.report.result.status, 'abandoned', abandoned.output);
  const drained = await f.cli(['drain', f.id, '--retry-failed']);
  assert.equal(drained.report.result.status, 'blocked', drained.output);
  assert.ok(
    drained.report.result.blockers.some(row => row.code === 'wave_retry_executor' && row.id === 'ext'),
    drained.output,
  );
  assert.deepEqual(f.calls.worker, [], 'the drain never executed the external task');
  assert.equal(f.taskRuns().length, 1, 'no native Run was installed');
  const retried = await f.cli(['next-wave', f.id, '--host', 't3', '--retry-failed']);
  assert.equal(retried.exitCode, 0, retried.output);
  assert.deepEqual(
    retried.report.result.briefs.map(row => row.taskId),
    ['ext'],
  );
  assert.notEqual(retried.report.result.briefs[0].runId, brief.runId);
  assert.deepEqual(f.store.getRun(retried.report.result.briefs[0].runId).executor, { kind: 'external', host: 't3' });
});

test('A reservation without a Run is resumed only by its own executor', { timeout: 900000 }, async t => {
  const f = await fixture(t, { epics: ['e1'], tasks: [task('ext'), task('own')] });
  // Crashes between reserveAttempt and the Run install: one for host t3, one for the drain.
  for (const [id, actor] of [
    ['ext', externalReserver('t3')],
    ['own', NATIVE_RESERVER],
  ]) {
    await f.repo.apply(
      f.command(f.repo.snapshot(f.id), { op: 'transition', kind: 'task', id, to: 'ready', evidence: [], mappings: [] }),
    );
    await f.repo.apply(
      f.command(f.repo.snapshot(f.id), { op: 'reserveAttempt', taskId: id, retryFailed: false }, actor),
    );
  }
  const attempts = () => Object.fromEntries(f.repo.snapshot(f.id).currentAttempts.map(row => [row.taskId, row.runId]));
  const reserved = attempts();

  const orca = await f.cli(['next-wave', f.id, '--host', 'orca']);
  assert.equal(orca.exitCode, 2, orca.output);
  assert.deepEqual(orca.report.result.briefs, [], "another host adopts neither t3's nor the drain's reservation");
  assert.equal(f.taskRuns().length, 0);

  const drained = await f.cli(['drain', f.id, '--max-waves', '1']);
  assert.equal(drained.report.result.status, 'max_waves', drained.output);
  assert.deepEqual(drained.report.result.integrated, ['own']);
  assert.deepEqual(f.calls.worker, ['own'], 'the drain resumed only its own reservation');
  assert.equal(f.taskRuns().length, 1);
  assert.deepEqual(attempts(), reserved, 'no attempt was replaced');

  const t3 = await f.cli(['next-wave', f.id, '--host', 't3']);
  assert.equal(t3.exitCode, 0, t3.output);
  assert.deepEqual(
    t3.report.result.briefs.map(row => [row.taskId, row.runId]),
    [['ext', reserved.ext]],
  );
  assert.deepEqual(f.store.getRun(reserved.ext).executor, { kind: 'external', host: 't3' });
});

test(
  'A behavioural oracle a task adds to kodo.config.json runs in the epic gate: its exit 19 never accepts the project',
  { timeout: 900000 },
  async t => {
    // Review finding (blocker): the gate took its policy from the user's checkout and ran no oracle.
    const f = await fixture(t, {
      epics: ['e1'],
      tasks: [task('policy', { writePaths: ['kodo.config.json', 'policy.txt'] })],
      hooks: {
        writePaths: { policy: ['kodo.config.json', 'policy.txt'] },
        onWorker: (id, calls, request) =>
          editConfig(request.cwd, config => ({
            ...config,
            verification: {
              oracles: [
                {
                  id: 'exit-nineteen',
                  command: process.execPath,
                  args: ['-e', 'process.exit(19)'],
                  protect: ['oracle-guard/**'],
                },
              ],
            },
          })),
      },
    });
    const result = await createProjectDirector({ repo: f.repo, engine: f.engine }).drain(f.id);
    assert.equal(result.status, 'blocked', JSON.stringify(result));
    const snapshot = f.repo.snapshot(f.id);
    assert.notEqual(snapshot.project.status, 'accepted');
    assert.equal(snapshot.epics[0].status, 'integrated');
    assert.equal(snapshot.tasks[0].status, 'integrated', 'the task verified under the policy of its base');
    const [taskRun] = f.taskRuns();
    assert.equal(taskRun.config.verification, undefined, 'the task Run verifies under the policy of its base');
    assert.equal(taskRun.wavePolicy.commit, taskRun.baseSha);
    const gate = f.store.getRun(snapshot.gates[0].runId);
    assert.notEqual(gate.state, 'succeeded');
    assert.equal(gate.wavePolicy.commit, snapshot.gates[0].headSha, 'the gate executes the policy of its head');
    assert.deepEqual(
      gate.config.verification.oracles.map(row => row.id),
      ['exit-nineteen'],
    );
    assert.ok(
      gate.behavior?.oracles?.some(row => row.id === 'exit-nineteen' && row.exitCode === 19),
      JSON.stringify(gate.behavior?.oracles),
    );
  },
);

test(
  'commands.smoke a task adds runs in its epic gate, the task never hangs, and the validator binds the commit policy and every criterion',
  { timeout: 900000 },
  async t => {
    // Review finding (blocker, reverse failure): a task that added smoke stayed running with a recorded merge.
    const f = await fixture(t, {
      epics: ['e1'],
      tasks: [task('smoke', { writePaths: ['kodo.config.json', 'smoke.txt'] })],
      hooks: {
        writePaths: { smoke: ['kodo.config.json', 'smoke.txt'] },
        onWorker: (id, calls, request) =>
          editConfig(request.cwd, config => ({
            ...config,
            commands: {
              ...config.commands,
              smoke: [{ command: process.execPath, args: ['-e', "console.log('smoke ran')"] }],
            },
          })),
      },
    });
    const result = await createProjectDirector({ repo: f.repo, engine: f.engine }).drain(f.id);
    assert.equal(result.status, 'accepted', JSON.stringify(result));
    const snapshot = f.repo.snapshot(f.id);
    assert.deepEqual(f.statuses(snapshot.tasks), { smoke: 'accepted' });
    const gate = f.store.getRun(snapshot.gates[0].runId);
    assert.equal(gate.smoke.results.length, 1, 'the gate executed the smoke command of its head');
    assert.equal(gate.smoke.results[0].exitCode, 0);
    assert.match(JSON.parse(await readFile(gate.smoke.results[0].outputPath, 'utf8')).value.stdout, /smoke ran/);
    assert.deepEqual(
      gate.review.criteria.map(row => [row.id, row.met]),
      [
        ['epic:e1:e1-proof', true],
        ['milestone:m1:m1-proof', true],
        [`project:${f.id}:project-proof`, true],
        ['task:smoke:smoke-proof', true],
      ],
    );

    // The trusted validator accepts this gate Run as it is ...
    await authorizeByGate(f, gate);
    // ... but not with a policy that differs from the one of its verified commit ...
    f.store.updateRun(gate.id, { config: { ...gate.config, commands: { ...gate.config.commands, smoke: [] } } });
    await assert.rejects(() => authorizeByGate(f, f.store.getRun(gate.id)), { code: 'project_wave_policy_mismatch' });
    f.store.updateRun(gate.id, { config: gate.config });
    // ... nor with a review that does not confirm every covered criterion.
    const unmet = gate.review.criteria.map(row => (row.id === 'epic:e1:e1-proof' ? { ...row, met: false } : row));
    for (const criteria of [unmet, gate.review.criteria.slice(1)]) {
      f.store.updateRun(gate.id, { review: { ...gate.review, criteria } });
      await assert.rejects(() => authorizeByGate(f, f.store.getRun(gate.id)), { code: 'project_gate_criteria_unmet' });
    }
  },
);

test(
  'An epic gate confirms the epic criteria: a reviewer that finds them unmet never accepts the epic',
  { timeout: 900000 },
  async t => {
    // Review finding (major): an epic "keep scores across restarts" was accepted by a commit of one text file.
    const scores = { id: 'scores-persist', text: 'Scores persist between restarts', evidenceKinds: ['acceptance'] };
    const f = await fixture(t, {
      epics: ['e1'],
      tasks: [task('notes')],
      epicAcceptance: { e1: scores },
      hooks: {
        onReview: request =>
          request.schema.properties.criteria
            ? {
                passed: true,
                findings: [],
                ...confirmedCriteria(request.schema, { unmet: ['epic:e1:scores-persist'] }),
              }
            : undefined,
      },
    });
    const result = await createProjectDirector({ repo: f.repo, engine: f.engine }).drain(f.id);
    assert.equal(result.status, 'blocked', JSON.stringify(result));
    const snapshot = f.repo.snapshot(f.id);
    assert.notEqual(snapshot.project.status, 'accepted');
    assert.notEqual(snapshot.epics[0].status, 'accepted');
    assert.deepEqual(f.statuses(snapshot.tasks), { notes: 'integrated' });
    const gateReviews = f.calls.reviews.filter(request => request.schema.properties.criteria);
    assert.ok(gateReviews.length >= 1, 'the gate review confirms criteria');
    assert.match(
      gateReviews[0].prompt,
      /Scores persist between restarts/,
      "the reviewer's input holds the epic criterion",
    );
    assert.ok(gateReviews[0].schema.properties.criteria.items.properties.id.enum.includes('epic:e1:scores-persist'));
    const gate = f.store.getRun(snapshot.gates[0].runId);
    assert.notEqual(gate.state, 'succeeded');
    const manifest = JSON.parse(await readFile(gate.gateManifest.path, 'utf8')).value;
    assert.deepEqual(manifest.containers[0], { kind: 'epic', id: 'e1', criteria: [scores] });
  },
);

test(
  'complete-task inspects every commit: a credentials file committed and deleted later is never integrated',
  { timeout: 900000 },
  async t => {
    // Review finding (major): only the final diff was checked; the secret stayed reachable on the branch.
    const f = await fixture(t, { epics: ['e1'], tasks: [task('alpha', { writePaths: ['alpha/**'] })] });
    const next = await f.cli(['next-wave', f.id, '--host', 't3']);
    assert.equal(next.exitCode, 0, next.output);
    const [brief] = next.report.result.briefs;
    await mkdir(path.join(brief.worktree, 'alpha'));
    await writeFile(path.join(brief.worktree, 'alpha', 'credentials.json'), '{"token":"leaked"}\n');
    git(brief.worktree, 'add', '-A');
    git(brief.worktree, 'commit', '-m', 'Add credentials by mistake');
    const leaked = git(brief.worktree, 'rev-parse', 'HEAD');
    git(brief.worktree, 'rm', '-q', 'alpha/credentials.json');
    await mkdir(path.join(brief.worktree, 'alpha'), { recursive: true });
    await writeFile(path.join(brief.worktree, 'alpha', 'alpha.txt'), 'alpha\n');
    git(brief.worktree, 'add', '-A');
    git(brief.worktree, 'commit', '-m', 'Implement alpha');
    const head = git(brief.worktree, 'rev-parse', 'HEAD');
    const completed = await f.cli(['complete-task', f.id, 'alpha', '--head', head]);
    assert.equal(completed.exitCode, 2, completed.output);
    assert.equal(completed.report.result.status, 'checks_failed');
    assert.equal(completed.report.result.code, 'external_scope');
    assert.match(completed.report.result.message, /credentials\.json/);
    assert.equal(f.branchHead(), brief.baseSha, 'nothing was merged');
    const reachable = spawnSync('git', ['merge-base', '--is-ancestor', leaked, f.branchHead()], { cwd: f.root });
    assert.equal(reachable.status, 1, 'the commit with the secret is not on the integration branch');
    assert.equal(f.repo.snapshot(f.id).currentAttempts[0].status, 'running');
  },
);

test(
  'A replayed complete-task reports a merge that left the integration branch as a recovery blocker',
  { timeout: 900000 },
  async t => {
    // Review finding (major): the replay answered `integrated` after the merge was rolled back.
    const f = await fixture(t, { epics: ['e1'], tasks: [task('alpha')] });
    const [brief] = (await f.cli(['next-wave', f.id, '--host', 't3'])).report.result.briefs;
    await writeFile(path.join(brief.worktree, 'alpha.txt'), 'alpha\n');
    git(brief.worktree, 'add', '-A');
    git(brief.worktree, 'commit', '-m', 'Implement alpha');
    const head = git(brief.worktree, 'rev-parse', 'HEAD');
    const complete = ['complete-task', f.id, 'alpha', '--head', head, '--defer-gate'];
    const done = await f.cli(complete);
    assert.equal(done.report.result.status, 'integrated', done.output);
    const replay = await f.cli(complete);
    assert.deepEqual(
      [replay.exitCode, replay.report.result.status, replay.report.result.replayed],
      [0, 'integrated', true],
    );
    // The merge leaves the branch (a manual reset of the integration worktree).
    const { integration } = f.store.getRun(brief.runId);
    const block = git(f.root, 'worktree', 'list', '--porcelain')
      .split(/\r?\n\r?\n/)
      .find(row => row.includes(`branch refs/heads/kodo/project/${f.id}`));
    git(/^worktree (.+)$/m.exec(block)[1], 'reset', '-q', '--hard', integration.before);
    const late = await f.cli(complete);
    assert.equal(late.exitCode, 2, late.output);
    assert.equal(late.report.result.status, 'blocked');
    assert.equal(late.report.result.code, 'project_integration_missing');
  },
);

test('A late repeat of --abandon replays its own attempt and never blocks the retry', { timeout: 900000 }, async t => {
  // Review finding (major): the original command repeated after next-wave --retry-failed blocked the NEW attempt.
  const f = await fixture(t, { epics: ['e1'], tasks: [task('ext')] });
  const [brief] = (await f.cli(['next-wave', f.id, '--host', 't3'])).report.result.briefs;
  const abandon = ['complete-task', f.id, 'ext', '--head', brief.baseSha, '--abandon'];
  const first = await f.cli([...abandon, '--attempt', brief.attemptId]);
  assert.equal(first.report.result.status, 'abandoned', first.output);
  const [retry] = (await f.cli(['next-wave', f.id, '--host', 't3', '--retry-failed'])).report.result.briefs;
  assert.notEqual(retry.attemptId, brief.attemptId);
  const current = () => f.repo.snapshot(f.id).currentAttempts[0];
  // Without --attempt the CLI refuses the abandon before touching any state.
  const unnamed = await f.cli(abandon);
  assert.deepEqual([unnamed.exitCode, unnamed.report.result.code], [1, 'project_arguments']);
  assert.deepEqual([current().id, current().status], [retry.attemptId, 'running']);
  for (const argv of [[...abandon, '--attempt', brief.attemptId]]) {
    const late = await f.cli(argv);
    assert.deepEqual([current().id, current().status], [retry.attemptId, 'running'], 'the retry keeps running');
    assert.equal(f.store.getRun(retry.runId).state, 'executing');
    assert.equal(late.exitCode, 0, late.output);
    assert.deepEqual(
      [late.report.result.status, late.report.result.attemptId, late.report.result.replayed],
      ['abandoned', brief.attemptId, true],
    );
  }
  assert.equal(first.report.result.attemptId, brief.attemptId);
  assert.equal(
    retry.abandonCommand,
    `kodo project complete-task ${f.id} ext --head <SHA> --abandon --attempt ${retry.attemptId}`,
  );
  const stale = await f.cli(['complete-task', f.id, 'ext', '--head', brief.baseSha, '--attempt', brief.attemptId]);
  assert.deepEqual([stale.exitCode, stale.report.result.code], [2, 'project_attempt_stale']);
  const own = await f.cli([...abandon, '--attempt', retry.attemptId]);
  assert.deepEqual([own.report.result.status, own.report.result.attemptId], ['abandoned', retry.attemptId]);
  assert.equal(own.report.result.replayed, undefined);
  assert.equal(current().status, 'blocked');
});

// --- Second review of the project factory: regression tests ------------------------------------

test(
  'A policy the Store would record redacted is refused: a command that exits 19 intact never accepts the project',
  { timeout: 900000 },
  async t => {
    // Review finding (blocker): the policy was read through the redacting runner; `?key=intact-value`
    // became `?key=[REDACTED]`, so the gate executed a command that exits 0 instead of 19.
    const f = await fixture(t, {
      epics: ['e1'],
      tasks: [task('redacted', { writePaths: ['kodo.config.json', 'redacted.txt'] })],
      hooks: {
        writePaths: { redacted: ['kodo.config.json', 'redacted.txt'] },
        onWorker: (id, calls, request) =>
          editConfig(request.cwd, config => ({
            ...config,
            commands: {
              ...config.commands,
              test: [
                {
                  command: process.execPath,
                  args: ['-e', "process.exit(process.argv[1].includes('REDACTED') ? 0 : 19)", '?key=intact-value'],
                },
              ],
            },
          })),
      },
    });
    const base = git(f.root, 'rev-parse', 'HEAD');
    const result = await createProjectDirector({ repo: f.repo, engine: f.engine }).drain(f.id);
    assert.equal(result.status, 'blocked', JSON.stringify(result));
    assert.match(JSON.stringify(result), /wave_policy_unsafe/);
    const snapshot = f.repo.snapshot(f.id);
    assert.notEqual(snapshot.project.status, 'accepted');
    assert.ok(!['integrated', 'accepted'].includes(snapshot.tasks[0].status), snapshot.tasks[0].status);
    assert.equal(f.branchHead(), base, 'nothing was merged');
    assert.deepEqual(snapshot.gates, [], 'no gate executed the policy');
  },
);
