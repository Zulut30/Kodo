// Stage 15B review round 2: fencing for TTL leases. A holder that stalls past its TTL may still run
// after another holder took the lease: the integration branch moves only by compare-and-swap, and
// every state write a holder makes is checked against its live lease tokens in its own transaction.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../runtime/store.mjs';
import { ensureIntegration, mergeTask } from '../runtime/project-integration.mjs';
import { integrationLeaseName, withIntegrationLease } from '../runtime/project-integration-lease.mjs';
import { withGateController } from '../runtime/project-controller-lease.mjs';
import { fencedBy } from '../runtime/lease-fence.mjs';

function git(cwd, ...args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true });
  assert.equal(result.status, 0, `${args.join(' ')}\n${result.stderr}`);
  return result.stdout.trim();
}

async function fixture(t) {
  const temp = await realpath(await mkdtemp(path.join(os.tmpdir(), 'kodo-fence-')));
  const store = new Store(path.join(temp, 'state'));
  t.after(async () => {
    store.close();
    await rm(temp, { recursive: true, force: true });
  });
  const root = path.join(temp, 'repo');
  await mkdir(root, { recursive: true });
  await writeFile(path.join(root, 'shared.txt'), 'base\n');
  git(root, 'init', '-b', 'main');
  git(root, 'config', 'user.name', 'Fence Test');
  git(root, 'config', 'user.email', 'fence@example.invalid');
  git(root, 'config', 'core.autocrlf', 'false');
  git(root, 'add', '.');
  git(root, 'commit', '-m', 'Baseline');
  const projectId = randomUUID();
  const integration = await ensureIntegration({ root, projectId, worktreeHome: path.join(temp, 'worktrees') });
  const task = async name => {
    const worktree = path.join(temp, 'tasks', name);
    git(root, 'worktree', 'add', '-q', '-b', `kodo/${name}`, worktree, integration.head);
    await writeFile(path.join(worktree, `${name}.txt`), `${name}\n`);
    git(worktree, 'add', '-A');
    git(worktree, 'commit', '-q', '-m', `Task ${name}`);
    return git(worktree, 'rev-parse', 'HEAD');
  };
  const merge = (taskId, taskHead, savePending = () => {}) =>
    mergeTask({ worktree: integration.worktree, taskId, taskHead, writePaths: [`${taskId}.txt`], savePending });
  const branchHead = () => git(root, 'rev-parse', `refs/heads/${integration.branch}`);
  const merges = () =>
    git(root, 'log', '--merges', '--format=%s', `refs/heads/${integration.branch}`).split('\n').filter(Boolean);
  return { temp, store, root, projectId, integration, task, merge, branchHead, merges };
}

// The holder pauses in savePending; the test hands its lease to another holder from outside its
// async context (the TTL expired and another process acquired the lease).
function pausedSavePending() {
  let paused, resume;
  const reached = new Promise(resolve => (paused = resolve));
  const gate = new Promise(resolve => (resume = resolve));
  return { reached, resume, savePending: async () => (paused(), gate) };
}

test('A stale integration holder whose branch another holder moved cannot merge or record it', async t => {
  const f = await fixture(t);
  const [alpha, beta] = [await f.task('alpha'), await f.task('beta')];
  const run = f.store.createRun({ project: f.root, task: 'alpha' });
  const name = integrationLeaseName(f.projectId);
  const pause = pausedSavePending();
  const stale = withIntegrationLease(f.store, f.projectId, async () => {
    const merged = await f.merge('alpha', alpha, async pending => {
      f.store.updateRun(run.id, { integration: { ...pending, status: 'pending' } });
      await pause.savePending();
    });
    f.store.updateRun(run.id, { integration: merged });
  });
  await pause.reached;
  // The lease passes on: the stale row is gone and another holder merges beta.
  f.store.db.prepare('DELETE FROM leases WHERE name=?').run(name);
  const other = await withIntegrationLease(f.store, f.projectId, () => f.merge('beta', beta));
  pause.resume();
  await assert.rejects(stale, { code: 'project_lease_lost' });
  assert.equal(f.branchHead(), other.mergeCommit, 'the branch keeps the other holder merge');
  assert.deepEqual(f.merges(), ['Kodo: integrate beta']);
  assert.equal(git(f.integration.worktree, 'status', '--porcelain'), '');
  assert.equal(f.store.getRun(run.id).integration.status, 'pending', 'the stale holder recorded no merge');
});

test('A stale holder whose branch did not move publishes the merge but cannot record it', async t => {
  const f = await fixture(t);
  const alpha = await f.task('alpha');
  const run = f.store.createRun({ project: f.root, task: 'alpha' });
  const name = integrationLeaseName(f.projectId);
  const pause = pausedSavePending();
  const stale = withIntegrationLease(f.store, f.projectId, async () => {
    const merged = await f.merge('alpha', alpha, pause.savePending);
    f.store.updateRun(run.id, { integration: merged });
  });
  await pause.reached;
  f.store.db.prepare('DELETE FROM leases WHERE name=?').run(name);
  const other = f.store.acquireLease(name, 'other', { ttlMs: 60000 });
  pause.resume();
  await assert.rejects(stale, { code: 'project_lease_lost' });
  assert.equal(f.store.getRun(run.id).integration, undefined, 'the fenced record failed');
  // The current holder recovers the merge from the branch history: never a second merge.
  f.store.releaseLease(other);
  const recovered = await withIntegrationLease(f.store, f.projectId, () => f.merge('alpha', alpha));
  assert.equal(recovered.mergeCommit, f.branchHead());
  assert.deepEqual(f.merges(), ['Kodo: integrate alpha']);
});

test('Fenced writes check the live lease tokens in their own transaction', async t => {
  const f = await fixture(t);
  const run = f.store.createRun({ project: f.root, task: 'fenced' });
  const token = f.store.acquireLease('fence:test', 'holder', { ttlMs: 60000 });
  fencedBy([token], () => f.store.updateRun(run.id, { note: 'live' }));
  assert.equal(f.store.getRun(run.id).note, 'live');
  f.store.withFence([token], () => f.store.updateRun(run.id, { note: 'in one transaction' }));
  assert.equal(f.store.getRun(run.id).note, 'in one transaction');
  // Expired (the row is still there but its TTL passed): nothing is written.
  f.store.db.prepare('UPDATE leases SET expires=? WHERE token=?').run(Date.now() - 1, token);
  assert.throws(() => fencedBy([token], () => f.store.updateRun(run.id, { note: 'stale' })), {
    code: 'project_lease_lost',
  });
  assert.throws(
    () =>
      f.store.withFence([token], () => {
        f.store.updateRun(run.id, { note: 'stale' });
      }),
    { code: 'project_lease_lost' },
  );
  assert.equal(f.store.getRun(run.id).note, 'in one transaction');
  assert.equal(f.store.db.isTransaction, false);
});

test('The gate controller aborts its pass and fences its writes once its lease is lost', async t => {
  const f = await fixture(t);
  const run = f.store.createRun({ project: f.root, task: 'gates' });
  const outcome = await withGateController(
    f.store,
    f.projectId,
    async (_, lost) => {
      f.store.db.prepare('DELETE FROM leases WHERE name=?').run(`project-gates:${f.projectId}`);
      await new Promise(resolve => lost.addEventListener('abort', resolve, { once: true }));
      try {
        f.store.updateRun(run.id, { externalCompletion: { gates: { gates: [] } } });
        return 'written';
      } catch (error) {
        return error.code;
      }
    },
    { heartbeatMs: 5 },
  );
  assert.equal(outcome, 'project_lease_lost');
  assert.equal(f.store.getRun(run.id).externalCompletion, undefined);
});
