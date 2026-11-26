// Stage 15B: parallel epic gates, lease fencing, conflicts and crash recovery.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { nextWave, runProjectGates } from '../runtime/project-external.mjs';
import * as waves from '../runtime/project-director-waves.mjs';
import { verifyTaskFastOnce } from '../runtime/wave-verifier.mjs';
import {
  git,
  commit,
  fixture,
  frozen,
  until,
  queueOf,
  queued,
  lightPorts,
  integrationWorktree,
} from './helpers/parallel-engine-fixture.mjs';

test('Gates of a completion without --defer-gate run once, and never record a stopped pass', async t => {
  const f = await fixture(t, { count: 2 });
  lightPorts(f);
  const briefs = [...(await f.briefs()).values()];
  const passes = [];
  f.ports.runPendingGates = async (waveCtx, input) => {
    passes.push(input.projectId);
    return { gates: [], accepted: [], blocked: [] };
  };
  // Another gate pass runs: the completion integrates, then answers project_busy for its gates.
  const controller = f.store.acquireLease(`project-gates:${f.projectId}`, 'other', { ttlMs: 600000 });
  const head = await f.change(briefs[0]);
  await assert.rejects(f.complete(briefs[0], head, { deferGate: false }), { code: 'project_busy' });
  assert.equal(f.store.getRun(briefs[0].runId).externalCompletion.gates, null);
  f.store.releaseLease(controller);
  const repeat = await f.complete(briefs[0], head, { deferGate: false });
  assert.deepEqual([repeat.status, repeat.replayed], ['integrated', true]);
  assert.deepEqual(repeat.gates, { gates: [], accepted: [], blocked: [] });
  await f.complete(briefs[0], head, { deferGate: false });
  assert.equal(passes.length, 1, 'recorded gates never run twice');

  // A pass that a pause cut short records nothing and answers blocked.
  f.ports.runPendingGates = async () => {
    await f.repo.apply({
      schemaVersion: 1,
      commandId: randomUUID(),
      projectId: f.projectId,
      expectedRevision: (await f.snapshot()).revision,
      actor: 'owner',
      reason: 'Pause during a gate pass',
      action: { op: 'setPaused', paused: true },
    });
    return { gates: [], accepted: [], blocked: [] };
  };
  const secondHead = await f.change(briefs[1]);
  const second = await f.complete(briefs[1], secondHead, { deferGate: false });
  assert.deepEqual([second.status, second.code], ['blocked', 'project_control_blocked']);
  assert.ok(second.integration, 'the answer shows the merge is done');
  assert.equal(f.store.getRun(briefs[1].runId).externalCompletion.gates, null, 'a repeat may run them');
  const unpause = async () =>
    f.repo.apply({
      schemaVersion: 1,
      commandId: randomUUID(),
      projectId: f.projectId,
      expectedRevision: (await f.snapshot()).revision,
      actor: 'owner',
      reason: 'Resume after the pause',
      action: { op: 'setPaused', paused: false },
    });
  await unpause();
  // The pass stopped on a pause that was lifted before it returned: the pass itself says so.
  f.ports.runPendingGates = async () => ({ gates: [], accepted: [], blocked: [], stopped: 'project_control_blocked' });
  const lifted = await f.complete(briefs[1], secondHead, { deferGate: false });
  assert.deepEqual([lifted.status, lifted.code], ['blocked', 'project_control_blocked']);
  assert.equal(f.store.getRun(briefs[1].runId).externalCompletion.gates, null);
  // After the pause the dispatcher repeats the submission: the gates run once and are recorded.
  f.ports.runPendingGates = async (waveCtx, input) => {
    passes.push(input.projectId);
    return { gates: [], accepted: [], blocked: [] };
  };
  const resumed = await f.complete(briefs[1], secondHead, { deferGate: false });
  assert.deepEqual([resumed.status, resumed.replayed], ['integrated', true]);
  assert.deepEqual(f.store.getRun(briefs[1].runId).externalCompletion.gates, { gates: [], accepted: [], blocked: [] });
  assert.equal(passes.length, 2);
});

test('A verdict is not written once the build slot of its check was lost', async t => {
  const f = await fixture(t, { count: 1 });
  lightPorts(f);
  const [brief] = (await f.briefs()).values();
  const head = await f.change(brief);
  const verify = f.ports.verifyTaskFast;
  f.ports.verifyTaskFast = async input => {
    const verdict = await verify(input);
    // The slot's TTL expired during task-fast and another build took it.
    f.store.db.prepare("DELETE FROM leases WHERE name LIKE 'machine-build:%'").run();
    return verdict;
  };
  const result = await f.complete(brief, head);
  assert.deepEqual([result.status, result.code], ['blocked', 'project_lease_lost']);
  const run = f.store.getRun(brief.runId);
  assert.notEqual(run.state, 'succeeded', 'the fenced verdict was not written');
  assert.deepEqual(f.calls.integrate, []);
});

test('A gate pass whose controller lease is lost is blocked, never passed', async t => {
  const f = await fixture(t, { count: 1 });
  f.engine.leaseHeartbeatMs = 5;
  f.ports.runPendingGates = async (waveCtx, input) => {
    f.store.db.prepare('DELETE FROM leases WHERE name=?').run(`project-gates:${f.projectId}`);
    await new Promise(resolve => input.signal.addEventListener('abort', resolve, { once: true }));
    return { gates: [], accepted: [], blocked: [] };
  };
  const result = await runProjectGates(f.ctx, { projectId: f.projectId, ports: f.ports });
  assert.deepEqual([result.status, result.code], ['blocked', 'project_lease_lost']);
});

test('A pending merge that never reached the branch is checked again: a moved worker branch is refused', async t => {
  const f = await fixture(t, { count: 1 });
  lightPorts(f);
  const [brief] = (await f.briefs()).values();
  const head = await f.change(brief);
  let died;
  const dead = new Promise(resolve => (died = resolve));
  const integrate = f.ports.integrateAndAdvance;
  // The drain recorded `pending` (savePending) and its process died before the merge.
  f.ports.integrateAndAdvance = async (waveCtx, input) => {
    f.calls.integrate.push(input.taskId);
    f.store.updateRun(input.run.id, {
      integration: { branch: `kodo/project/${f.projectId}`, before: f.integrationHead(), status: 'pending' },
    });
    died();
    await frozen(t);
  };
  const background = new AbortController();
  void f.complete(brief, head, { signal: background.signal }).catch(() => {});
  await dead;
  background.abort();
  f.store.db.prepare("DELETE FROM leases WHERE name LIKE 'project%'").run();
  f.ports.integrateAndAdvance = integrate;
  // The worker commits again before the host repeats the old submission.
  const next = await f.change(brief, 9);
  const result = await f.complete(brief, head);
  assert.deepEqual([result.status, result.code], ['blocked', 'project_submission_stale']);
  assert.deepEqual(f.calls.integrate, ['t0'], 'the old head is never merged');
  assert.equal(f.merges().length, 0);
  assert.notEqual(f.store.getRun(brief.runId).integration.status, 'pending', 'the pending record is released');
  // The attempt is not bricked: the worker's new head is verified and merged.
  const resumed = await f.complete(brief, next);
  assert.equal(resumed.status, 'integrated', JSON.stringify(resumed));
  assert.deepEqual(f.calls.integrate, ['t0', 't0']);
  assert.equal(f.merges().length, 1);
});

test('A publish refused for a moved worker branch never bricks the attempt: the new head merges', async t => {
  const f = await fixture(t, { count: 1 });
  const [brief] = (await f.briefs()).values();
  const first = await f.change(brief);
  let next;
  const integrate = f.ports.integrateAndAdvance;
  // The worker commits again after the drain checked its branch and before the ref transaction.
  f.ports.integrateAndAdvance = async (waveCtx, input) => {
    if (!next) next = await f.change(brief, 7);
    return integrate(waveCtx, input);
  };
  const refused = await f.complete(brief, first);
  assert.deepEqual([refused.status, refused.code], ['blocked', 'project_submission_stale']);
  assert.equal(f.merges().length, 0, 'nothing was published');
  const run = f.store.getRun(brief.runId);
  assert.equal(run.integration.status, 'failed', 'the pending record of the old head is released');
  const merged = await f.complete(brief, next);
  assert.equal(merged.status, 'integrated', JSON.stringify(merged));
  assert.equal(f.merges().length, 1);
  assert.equal(f.store.getRun(brief.runId).headSha, next);
});

test('A merge conflict refuses only its own task and leaves the integration branch intact', async t => {
  const f = await fixture(t, { count: 3 });
  const briefs = await f.briefs();
  // A repair on the integration branch changed t1 after its worktree was made.
  const worktree = integrationWorktree(f);
  await commit(worktree, { 'src/t1.mjs': 'export const t1 = 7;\n' }, 'Repair t1 on the integration branch');
  const repaired = f.integrationHead();
  // All three are verified and queued before one drain merges them.
  const holder = f.store.acquireLease(`project-integration:${f.projectId}`, 'test', { ttlMs: 600000 });
  const pending = [...briefs.values()].map(async brief =>
    f.complete(brief, await f.change(brief, 3), { machine: { id: 'local', maxHeavyBuilds: 3 } }),
  );
  const queue = await queueOf(f);
  await until(() => queued(queue, f) === 3, 'three queued rows');
  f.store.releaseLease(holder);
  const results = await Promise.all(pending);
  const byTask = Object.fromEntries([...briefs.keys()].map((taskId, index) => [taskId, results[index]]));
  assert.deepEqual([byTask.t1.status, byTask.t1.code], ['abandoned', 'project_integration_conflict_retry']);
  assert.equal(byTask.t0.status, 'integrated', JSON.stringify(byTask.t0));
  assert.equal(byTask.t2.status, 'integrated', JSON.stringify(byTask.t2));
  assert.equal(git(worktree, 'status', '--porcelain'), '', 'no half-merged files');
  assert.equal(
    spawnSync('git', ['rev-parse', '-q', '--verify', 'MERGE_HEAD'], { cwd: worktree }).status,
    1,
    'no merge in progress',
  );
  assert.equal(git(worktree, 'merge-base', '--is-ancestor', repaired, 'HEAD'), '');
  assert.equal(git(worktree, 'show', 'HEAD:src/t1.mjs'), 'export const t1 = 7;');
  assert.deepEqual(f.merges().length, 2);
  const snapshot = await f.snapshot();
  assert.equal(snapshot.currentAttempts.find(row => row.taskId === 't1').status, 'blocked');
  const retry = await nextWave(f.ctx, { projectId: f.projectId, host: 't3', ports: f.ports, limit: 1 });
  assert.equal(retry.briefs[0].baseSha, f.integrationHead());
  assert.equal(retry.briefs[0].previousAttempt.attemptId, briefs.get('t1').attemptId);
});

test('A drain that dies after a merge never merges that task twice', async t => {
  const f = await fixture(t, { count: 3 });
  const briefs = await f.briefs();
  const heads = new Map();
  for (const brief of briefs.values()) heads.set(brief.taskId, await f.change(brief));
  const name = `project-integration:${f.projectId}`;
  const holder = f.store.acquireLease(name, 'test', { ttlMs: 600000 });
  let died;
  const dead = new Promise(resolve => (died = resolve));
  // The drain integrates t1 (merge, transitions) and then its process "dies": the promise never
  // settles, the queue rows stay `merging` and no completion is recorded on the Run.
  f.ports.integrateAndAdvance = async (waveCtx, input) => {
    f.calls.integrate.push(input.taskId);
    const result = await waves.integrateAndAdvance(waveCtx, input);
    if (input.taskId === 't1' && f.calls.integrate.filter(id => id === 't1').length === 1) {
      died();
      await frozen(t);
    }
    return result;
  };
  const priority = { t0: 3, t1: 2, t2: 1 };
  // The waiting submissions of the "dead" process are cancelled before its leases end.
  const background = new AbortController();
  for (const brief of briefs.values())
    void f
      .complete(brief, heads.get(brief.taskId), {
        machine: { id: 'local', maxHeavyBuilds: 3 },
        priority: priority[brief.taskId],
        signal: background.signal,
      })
      .catch(() => {});
  const queue = await queueOf(f);
  await until(() => queued(queue, f) === 3, 'three queued rows');
  f.store.releaseLease(holder);
  await dead;
  assert.deepEqual(
    queue.list(f.projectId).map(row => [row.taskId, row.status]),
    [
      ['t0', 'integrated'],
      ['t1', 'merging'],
      ['t2', 'merging'],
    ],
  );
  background.abort();
  // The dead process's leases end (TTL or a dead pid in production; removed here).
  f.store.db.prepare("DELETE FROM leases WHERE name LIKE 'project%'").run();
  // Every task is submitted again (the host's retry): the queue resumes the stopped drain.
  const again = [];
  for (const brief of briefs.values()) again.push(await f.complete(brief, heads.get(brief.taskId)));
  assert.deepEqual(
    again.map(row => row.status),
    ['integrated', 'integrated', 'integrated'],
    JSON.stringify(again),
  );
  assert.deepEqual(f.calls.integrate, ['t0', 't1', 't1', 't2'], 't1 is resumed once, never merged again');
  assert.equal(f.merges().length, 3, 'one merge commit per task');
  assert.ok(queue.list(f.projectId).every(row => row.status === 'integrated'));
});

test('next-wave reserves and installs nothing once its project lease passed on', async t => {
  const f = await fixture(t, { count: 2 });
  const name = `project:${f.projectId}`;
  // The TTL of next-wave's lease expired and another controller took project:<id>.
  const handOff = () => {
    f.store.db.prepare('DELETE FROM leases WHERE name=?').run(name);
    f.store.acquireLease(name, 'other', { ttlMs: 60000 });
  };
  const wave = repo => nextWave({ ...f.ctx, repo }, { projectId: f.projectId, host: 't3', ports: f.ports, limit: 2 });
  const beforeReserve = Object.create(f.repo, {
    apply: {
      value: async command => {
        if (command.action.op === 'reserveAttempt') handOff();
        return f.repo.apply(command);
      },
    },
  });
  // The admission checks its leases after every task: a lost lease stops the whole batch (15A).
  await assert.rejects(wave(beforeReserve), { code: 'project_lease_lost' });
  assert.deepEqual((await f.snapshot()).currentAttempts, [], 'no attempt was reserved');
  f.store.db.prepare('DELETE FROM leases WHERE name=?').run(name);
  // Before the Run install of a reserved attempt.
  const beforeInstall = Object.create(f.repo, {
    installRun: {
      value: async value => {
        handOff();
        return f.repo.installRun(value);
      },
    },
  });
  await assert.rejects(wave(beforeInstall), { code: 'project_lease_lost' });
  for (const attempt of (await f.snapshot()).currentAttempts)
    assert.throws(() => f.store.getRun(attempt.runId), 'no Run was installed');
});

test('A lost lease inside task-fast is reported as such, never as a failed check', async t => {
  const f = await fixture(t, { count: 1 });
  const [brief] = (await f.briefs()).values();
  await f.change(brief);
  t.mock.method(f.engine, 'behaviorGate', async () => {
    throw Object.assign(new Error('Project lease lost'), { code: 'project_lease_lost' });
  });
  await assert.rejects(verifyTaskFastOnce({ engine: f.engine, run: brief.runId }), { code: 'project_lease_lost' });
});
