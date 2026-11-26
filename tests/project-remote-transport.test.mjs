// Stage 16A: remote Git transport, trusted receipts and machine-down retry.
import test from 'node:test';
import assert from 'node:assert/strict';
import { tracingChannel } from 'node:diagnostics_channel';
import { projectSectionHeld } from '../runtime/project-controller-lease.mjs';
import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { nextWave } from '../runtime/project-external.mjs';
import {
  git,
  write,
  commit,
  fixture,
  buildLeases,
  remoteFixture,
  assertNoLocalPath,
} from './helpers/parallel-engine-fixture.mjs';

test('round2 R3 replaces only a rejected remote head after amend', async t => {
  const f = await remoteFixture(t);
  const [brief] = (await f.pull()).briefs;
  f.checkout(brief);
  const bad = await f.change({ ...brief, worktree: f.clone }, -1);
  git(f.clone, 'push', 'origin', 'HEAD:' + brief.workRef);
  assert.equal((await f.complete(brief, bad)).status, 'checks_failed');
  await write(f.clone, 'src/t0.mjs', 'export const t0 = 2;\n');
  git(f.clone, 'commit', '-am', 'Fixed', '--amend');
  git(f.clone, 'push', 'origin', '+HEAD:' + brief.workRef);
  assert.equal((await f.complete(brief, git(f.clone, 'rev-parse', 'HEAD'))).status, 'integrated');
  assert.equal((await f.complete(brief, bad)).code, 'project_submission_locked');
});

test('round2 R4 requires attempt and successful command exit codes', async t => {
  const f = await remoteFixture(t);
  f.machine.trustedBuilds = true;
  f.repo.setProfile(f.projectId, f.profile);
  const [brief] = (await f.pull()).briefs;
  f.checkout(brief);
  const head = await f.change({ ...brief, worktree: f.clone });
  git(f.clone, 'push', 'origin', 'HEAD:' + brief.workRef);
  const receipt = path.join(f.temp, 'receipt.json');
  await f.complete(brief, head, { receipt });
  const { receiptBinding } = await import('../runtime/remote-task-receipt.mjs');
  const proof = await receiptBinding(f.store.getRun(brief.runId), head);
  assert.equal(proof.attemptId, brief.attemptId);
  assert.ok(proof.commands.every(row => row.exitCode === 0));
  for (const patch of [
    { attemptId: randomUUID() },
    { commands: proof.commands.map(row => ({ ...row, exitCode: 1 })) },
  ]) {
    await writeFile(receipt, JSON.stringify({ ...proof, ...patch }));
    assert.equal((await f.complete(brief, head, { receipt })).code, 'project_receipt_mismatch');
  }
});

test('round2 R5 cleans transport refs on integration, abandon and later GC', async t => {
  const { gcProjectWorktrees } = await import('../runtime/project-worktree-gc.mjs');
  for (const abandon of [false, true]) {
    const f = await remoteFixture(t);
    const [brief] = (await f.pull()).briefs;
    f.checkout(brief);
    const head = await f.change({ ...brief, worktree: f.clone });
    git(f.clone, 'push', 'origin', 'HEAD:' + brief.workRef);
    const tracking = 'refs/kodo/fetched/' + brief.runId;
    const empty = () => {
      assert.equal(git(f.bare, 'for-each-ref', '--format=%(refname)', brief.baseRef, brief.workRef), '');
      assert.equal(git(f.root, 'for-each-ref', '--format=%(refname)', tracking), '');
    };
    assert.equal(
      (await f.complete(brief, head, { abandon, deferGate: !abandon })).status,
      abandon ? 'abandoned' : 'integrated',
    );
    empty();
    git(f.bare, 'update-ref', brief.baseRef, brief.baseSha);
    git(f.root, 'update-ref', tracking, brief.baseSha);
    await gcProjectWorktrees(f.store, await f.snapshot());
    empty();
  }
});

test('round2 R6 refuses oversized remote objects before checkout', async t => {
  const f = await remoteFixture(t);
  const [brief] = (await f.pull()).briefs;
  f.checkout(brief);
  const head = await commit(f.clone, { 'src/t0.mjs': '//' + 'a'.repeat(64 * 1024 * 1024 + 1) });
  git(f.clone, 'push', 'origin', 'HEAD:' + brief.workRef);
  const lockObservations = [];
  const channel = tracingChannel('child_process.spawn').start;
  const observe = ({ options }) => {
    if (options.args.includes('fetch') && options.args.includes('origin'))
      lockObservations.push(projectSectionHeld(f.store, f.projectId));
  };
  channel.subscribe(observe);
  let result;
  try {
    result = await f.complete(brief, head);
  } finally {
    channel.unsubscribe(observe);
  }
  assert.deepEqual(lockObservations, [false], 'fetch runs outside the project section');

  assert.equal(result.code, 'project_transport_too_large');
  assert.equal(git(f.store.getRun(brief.runId).cwd, 'rev-parse', 'HEAD'), brief.baseSha);
});

test('round2 R6 losing the submission lease during fetch leaves the attempt checkout untouched', async t => {
  const f = await remoteFixture(t);
  const [brief] = (await f.pull()).briefs;
  f.checkout(brief);
  const head = await f.change({ ...brief, worktree: f.clone });
  git(f.clone, 'push', 'origin', 'HEAD:' + brief.workRef);
  const acquire = f.store.acquireLease.bind(f.store);
  let token;
  f.store.acquireLease = (name, owner, options) => {
    const lease = acquire(name, owner, options);
    if (name === 'project-verify:' + brief.runId) token = lease;
    return lease;
  };
  const channel = tracingChannel('child_process.spawn').start;
  const revoke = ({ options }) => {
    if (token && options.args.includes('fetch') && options.args.includes('origin')) f.store.releaseLease(token);
  };
  channel.subscribe(revoke);
  try {
    await assert.rejects(f.complete(brief, head), { code: 'project_lease_lost' });
    assert.equal(git(f.store.getRun(brief.runId).cwd, 'rev-parse', 'HEAD'), brief.baseSha);
  } finally {
    channel.unsubscribe(revoke);
  }
});

test('round2 R7 keeps a pending integration when its worker goes down', async t => {
  const f = await remoteFixture(t);
  const [brief] = (await f.pull()).briefs;
  const { openIntegrationQueue } = await import('../runtime/project-integration-queue.mjs');
  const queue = openIntegrationQueue(f.store);
  const entry = queue.enqueue({
    projectId: f.projectId,
    taskId: brief.taskId,
    attemptId: brief.attemptId,
    runId: brief.runId,
    baseSha: brief.baseSha,
    headSha: brief.baseSha,
    priority: 0,
  });
  f.store.updateRun(brief.runId, { state: 'succeeded', integration: { status: 'pending' } });
  f.machine.down = true;
  f.repo.setProfile(f.projectId, f.profile);
  const result = await f.pull();
  assert.ok(!result.blocked.some(row => row.code === 'project_machine_down'));
  assert.deepEqual(result.briefs, []);
  assert.equal(queue.get(entry.seq).status, 'queued');
  assert.equal((await f.complete(brief, 'a'.repeat(40))).code, 'project_submission_locked');
});
test('16A fetches remote results and verifies untrusted builds in the slot of this PC', async t => {
  const f = await fixture(t, { count: 2 });
  const bare = path.join(f.temp, 'transport.git');
  const clone = path.join(f.temp, 'worker');
  git(f.temp, 'init', '--bare', bare);
  git(f.root, 'remote', 'add', 'origin', bare);
  git(f.temp, 'clone', bare, clone);
  git(clone, 'config', 'user.name', 'Remote worker');
  git(clone, 'config', 'user.email', 'worker@example.invalid');
  f.repo.setProfile(f.projectId, {
    subscriptions: [{ id: 'a', slots: 2, provider: 'codex', model: 'gpt', tier: 'fast' }],
    machines: [
      { id: 'remote', kind: 'ssh', maxWorkers: 1, maxHeavyBuilds: 1 },
      { id: 'pc', kind: 'local', maxWorkers: 1, maxHeavyBuilds: 1 },
    ],
  });
  const briefs = [...(await f.briefs()).values()];
  assert.deepEqual(briefs.map(brief => brief.machine?.id).sort(), ['pc', 'remote']);
  const results = [];
  const requested = await buildLeases(f, async () => {
    for (const brief of briefs) {
      if (brief.machine.kind === 'local') {
        results.push(await f.complete(brief, await f.change(brief)));
        continue;
      }
      assertNoLocalPath(brief, [f.root, f.home]);
      assert.equal(brief.worktree, undefined);
      git(clone, 'fetch', 'origin', brief.baseRef);
      assert.equal(git(clone, 'rev-parse', 'FETCH_HEAD'), brief.baseSha);
      git(clone, 'checkout', '-b', brief.branch, 'FETCH_HEAD');
      const head = await f.change({ ...brief, worktree: clone });
      await assert.rejects(f.complete(brief, head), { code: 'project_transport_failed' });
      const unrelated = git(clone, 'commit-tree', 'HEAD^{tree}', '-m', 'Independent root');
      git(clone, 'push', 'origin', unrelated + ':' + brief.workRef);
      assert.equal((await f.complete(brief, unrelated)).code, 'external_not_descendant');
      git(clone, 'push', 'origin', '+HEAD:' + brief.workRef);
      assert.equal((await f.complete(brief, brief.baseSha)).code, 'project_transport_head_mismatch');
      results.push(await f.complete(brief, head, { receipt: 'ignored' }));
    }
  });
  assert.deepEqual(
    results.map(row => row.status),
    ['integrated', 'integrated'],
    JSON.stringify(results),
  );
  assert.deepEqual(requested, [
    ['machine-build:pc', 1],
    ['machine-build:pc', 1],
  ]);
});

test('16A accepts only a bound receipt for a trusted remote build', async t => {
  const f = await fixture(t, { count: 1 });
  const bare = path.join(f.temp, 'transport.git');
  git(f.temp, 'init', '--bare', bare);
  git(f.root, 'remote', 'add', 'transport', bare);
  const machine = {
    id: 'remote',
    kind: 't3-env',
    gitRemote: 'transport',
    trustedBuilds: true,
    maxWorkers: 1,
    maxHeavyBuilds: 1,
  };
  const profile = {
    subscriptions: [{ id: 'a', slots: 1, provider: 'codex', model: 'gpt', tier: 'fast' }],
    machines: [machine],
  };
  f.repo.setProfile(f.projectId, profile);
  const brief = [...(await f.briefs()).values()][0];
  machine.down = true;
  f.repo.setProfile(f.projectId, profile);
  const pull = await nextWave(f.ctx, { projectId: f.projectId, host: 't3', ports: f.ports });
  assert.ok(pull.blocked.some(row => row.code === 'project_machine_down'));
  machine.down = false;
  f.repo.setProfile(f.projectId, profile);
  const clone = path.join(f.temp, 'worker');
  git(f.temp, 'clone', bare, clone);
  git(clone, 'config', 'user.name', 'Remote worker');
  git(clone, 'config', 'user.email', 'worker@example.invalid');
  git(clone, 'fetch', 'origin', brief.baseRef);
  git(clone, 'checkout', '-b', brief.branch, 'FETCH_HEAD');
  const head = await f.change({ ...brief, worktree: clone });
  git(clone, 'push', 'origin', 'HEAD:' + brief.workRef);
  const receipt = path.join(f.temp, 'receipt.json');
  await writeFile(receipt, '{}');
  assert.equal((await f.complete(brief, head, { receipt })).code, 'project_receipt_mismatch');
  const { receiptBinding } = await import('../runtime/remote-task-receipt.mjs');
  await writeFile(receipt, JSON.stringify(await receiptBinding(f.store.getRun(brief.runId), head)));
  const result = await f.complete(brief, head, { receipt });
  assert.equal(result.status, 'integrated', JSON.stringify(result));
  assert.equal(f.store.getRun(brief.runId).checks.source, 'remote');
});

test('16A retries an abandoned attempt on the remaining available machine', async t => {
  const f = await fixture(t, { count: 1 });
  const profile = {
    subscriptions: [{ id: 'pool', provider: 'codex', model: 'gpt', tier: 'fast', slots: 1 }],
    machines: ['a', 'b'].map(id => ({ id, kind: 'local', maxWorkers: 1, maxHeavyBuilds: 1 })),
  };
  f.repo.setProfile(f.projectId, profile);
  const brief = [...(await f.briefs()).values()][0];
  // A local placement adds its assignment to the legacy local brief and changes no other byte.
  const stored = f.store.getRun(brief.runId);
  const { subscription, machine, ...localBrief } = brief;
  f.store.updateRun(stored.id, { workerPlacement: null });
  const legacy = [...(await f.briefs()).values()][0];
  assert.equal(JSON.stringify(localBrief), JSON.stringify(legacy));
  f.store.updateRun(stored.id, { workerPlacement: { subscription, machine } });
  profile.machines[0].down = true;
  f.repo.setProfile(f.projectId, profile);
  const pull = retryFailed => nextWave(f.ctx, { projectId: f.projectId, host: 't3', ports: f.ports, retryFailed });
  assert.equal((await pull(false)).blocked[0].code, 'project_machine_down');
  assert.equal((await f.complete(brief, brief.baseSha, { deferGate: false, abandon: true })).status, 'abandoned');
  const retry = (await pull(true)).briefs[0];
  assert.equal(retry.machine.id, 'b');
  assert.notEqual(retry.attemptId, brief.attemptId);
});
