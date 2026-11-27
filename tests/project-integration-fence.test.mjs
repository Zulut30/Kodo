// Stage 15B review round 2: fencing for TTL leases. A holder that stalls past its TTL may still run
// after another holder took the lease: the integration branch moves only by compare-and-swap, and
// every state write a holder makes is checked against its live lease tokens in its own transaction.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { Store } from '../runtime/store.mjs';
import { lstat } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import {
  atomicPublisher,
  refusedPublish,
  ensureIntegration,
  headOnIntegrationBranch,
  mergeBackGate,
  mergeTask,
} from '../runtime/project-integration.mjs';
import { integrationLeaseName, withIntegrationLease } from '../runtime/project-integration-lease.mjs';
import { fencedPublisher } from '../runtime/project-publish.mjs';
import { acquireLeaseWaiting, withGateController } from '../runtime/project-controller-lease.mjs';
import { updateRefsAtomically } from '../runtime/project-integration.mjs';
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
  // Production publishes fenced by the holder's leases (runtime/project-publish.mjs).
  const merge = (taskId, taskHead, savePending = () => {}, options = {}) =>
    mergeTask({
      worktree: integration.worktree,
      taskId,
      taskHead,
      writePaths: [`${taskId}.txt`],
      savePending,
      publish: fencedPublisher(store),
      ...options,
    });
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

test('A stale holder whose branch did not move yet cannot publish its merge', async t => {
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
  // The new holder has not moved the branch: a compare-and-swap alone would let the stale holder
  // win. The fenced publish checks the tokens in the same SQLite write transaction first.
  await assert.rejects(stale, { code: 'project_lease_lost' });
  assert.deepEqual(f.merges(), [], 'nothing was published');
  assert.equal(f.store.getRun(run.id).integration, undefined, 'and nothing recorded');
  f.store.releaseLease(other);
  const merged = await withIntegrationLease(f.store, f.projectId, () => f.merge('alpha', alpha));
  assert.equal(merged.mergeCommit, f.branchHead());
  assert.deepEqual(f.merges(), ['Kodo: integrate alpha']);
});

test('A worker branch that left its verified head is refused in the same ref transaction', async t => {
  const f = await fixture(t);
  const alpha = await f.task('alpha');
  const before = f.branchHead();
  // The worker commits again after its head was verified.
  const worker = path.join(f.temp, 'tasks', 'alpha');
  await writeFile(path.join(worker, 'alpha.txt'), 'alpha again\n');
  git(worker, 'commit', '-q', '-am', 'Again');
  await assert.rejects(
    withIntegrationLease(f.store, f.projectId, () =>
      f.merge('alpha', alpha, () => {}, { verify: [{ ref: 'refs/heads/kodo/alpha', sha: alpha }] }),
    ),
    { code: 'project_submission_stale' },
  );
  assert.equal(f.branchHead(), before, 'the integration branch did not move');
  assert.equal(git(f.integration.worktree, 'status', '--porcelain'), '');
});

test('Returning a gate head is fenced: a lost lease or a moved branch publishes nothing', async t => {
  const f = await fixture(t);
  const gateHead = await (async () => {
    // A gate repair commit on top of the integration head (a fast-forward candidate).
    const worktree = path.join(f.temp, 'tasks', 'gate');
    git(f.root, 'worktree', 'add', '-q', '-b', 'kodo/gate', worktree, f.branchHead());
    await writeFile(path.join(worktree, 'gate.txt'), 'gate\n');
    git(worktree, 'add', '-A');
    git(worktree, 'commit', '-q', '-m', 'Gate repair');
    return git(worktree, 'rev-parse', 'HEAD');
  })();
  const expectedHead = f.branchHead();
  const name = integrationLeaseName(f.projectId);
  const back = () =>
    mergeBackGate({ worktree: f.integration.worktree, expectedHead, gateHead, publish: fencedPublisher(f.store) });
  // The lease expired (its row is still there) before the gate head was returned.
  await assert.rejects(
    withIntegrationLease(f.store, f.projectId, async () => {
      f.store.db.prepare('UPDATE leases SET expires=? WHERE name=?').run(Date.now() - 1, name);
      return back();
    }),
    { code: 'project_lease_lost' },
  );
  assert.equal(f.branchHead(), expectedHead);
  f.store.db.prepare('DELETE FROM leases WHERE name=?').run(name);
  // Another holder moved the branch between the check and the publish: the swap fails.
  const beta = await f.task('beta');
  const moved = await withIntegrationLease(f.store, f.projectId, async () => {
    const publish = async commands => {
      await f.merge('beta', beta, () => {}, { publish: atomicPublisher });
      return fencedPublisher(f.store)(commands);
    };
    return mergeBackGate({ worktree: f.integration.worktree, expectedHead, gateHead, publish }).catch(
      error => error.code,
    );
  });
  assert.equal(moved, 'project_lease_lost');
  assert.deepEqual(f.merges(), ['Kodo: integrate beta']);
});

test('A crash between publishing a merge and syncing the worktree is recovered on retry', async t => {
  const f = await fixture(t);
  const alpha = await f.task('alpha');
  const before = f.branchHead();
  let pending = null;
  // The process dies right after the ref transaction, before the worktree follows.
  const crash = async commands => {
    await atomicPublisher(commands);
    throw Object.assign(new Error('Injected crash after update-ref'), { code: 'injected_crash' });
  };
  await assert.rejects(
    f.merge('alpha', alpha, value => (pending = value), { publish: crash }),
    { code: 'injected_crash' },
  );
  assert.equal(pending.before, before);
  assert.equal(f.branchHead(), pending.mergeCommit, 'the merge is published');
  assert.notEqual(git(f.integration.worktree, 'status', '--porcelain'), '', 'the worktree still shows before');
  // A held index.lock stops the sync: the retry fails and changes nothing.
  const lock = path.join(git(f.integration.worktree, 'rev-parse', '--absolute-git-dir'), 'index.lock');
  await writeFile(lock, '');
  await assert.rejects(f.merge('alpha', alpha, () => {}, { pending }));
  assert.equal(f.branchHead(), pending.mergeCommit);
  await rm(lock);
  // The retry syncs exactly that state and recovers the published merge: never a second merge.
  const recovered = await f.merge('alpha', alpha, () => assert.fail('no new merge'), { pending });
  assert.equal(recovered.mergeCommit, pending.mergeCommit);
  assert.equal(git(f.integration.worktree, 'status', '--porcelain'), '');
  assert.deepEqual(f.merges(), ['Kodo: integrate alpha']);
  // Any other dirty state is refused, never synced away.
  const beta = await f.task('beta');
  let betaPending = null;
  await assert.rejects(f.merge('beta', beta, value => (betaPending = value), { publish: crash }));
  await writeFile(path.join(f.integration.worktree, 'shared.txt'), 'edited by hand\n');
  await assert.rejects(
    f.merge('beta', beta, () => {}, { pending: betaPending }),
    {
      code: 'project_integration_worktree_invalid',
    },
  );
  assert.equal(await lstat(lock).catch(() => null), null);
});

test('An expired lease is never renewed, and a nested integration lease after a loss stops at once', async t => {
  const f = await fixture(t);
  const token = f.store.acquireLease('renew:test', 'holder', { ttlMs: 60000 });
  assert.equal(f.store.renewLease(token), true);
  f.store.db.prepare('UPDATE leases SET expires=? WHERE token=?').run(Date.now() - 1, token);
  assert.equal(f.store.renewLease(token), false, 'an expired row is not revived');
  const name = integrationLeaseName(f.projectId);
  const started = Date.now();
  const nested = await withIntegrationLease(f.store, f.projectId, async () => {
    f.store.db.prepare('DELETE FROM leases WHERE name=?').run(name);
    f.store.acquireLease(name, 'other', { ttlMs: 60000 });
    return withIntegrationLease(f.store, f.projectId, async () => 'ran').catch(error => error.code);
  });
  assert.equal(nested, 'project_lease_lost');
  assert.ok(Date.now() - started < 30000, 'no wait for the lease');
});

test('A failed fenced write reports its own error, never a ROLLBACK failure', async t => {
  const f = await fixture(t);
  assert.throws(
    () =>
      f.store.withFence([], () => {
        f.store.db.exec('ROLLBACK');
        throw new Error('the original failure');
      }),
    /the original failure/,
  );
  assert.equal(f.store.db.isTransaction, false);
});

test('A missing integration branch is not on any head, never a Git error', async t => {
  const f = await fixture(t);
  const alpha = await f.task('alpha');
  assert.equal(await headOnIntegrationBranch({ cwd: f.root, projectId: f.projectId, head: f.branchHead() }), true);
  assert.equal(await headOnIntegrationBranch({ cwd: f.root, projectId: f.projectId, head: alpha }), false);
  // Git that cannot answer (an object it cannot read) is not "absent": null, never false.
  assert.equal(
    await headOnIntegrationBranch({ cwd: f.root, projectId: f.projectId, head: 'a'.repeat(40) }),
    null,
    'an unreadable head is unknown',
  );
  git(f.root, 'update-ref', '-d', `refs/heads/${f.integration.branch}`);
  assert.equal(await headOnIntegrationBranch({ cwd: f.root, projectId: f.projectId, head: alpha }), false);
  // A refused publish whose worker ref cannot be read back keeps its lost-publish error.
  const notRepo = await mkdtemp(path.join(os.tmpdir(), 'kodo-not-repo-'));
  t.after(() => rm(notRepo, { recursive: true, force: true }));
  const refused = Object.assign(new Error('refused'), { code: 'project_lease_lost', refused: true });
  assert.equal(refusedPublish(refused, notRepo, [{ ref: 'refs/heads/kodo/x', sha: alpha }]).code, 'project_lease_lost');
});

test('A lease lost during the wait for the integration lease never starts the work', async t => {
  const f = await fixture(t);
  const name = integrationLeaseName(f.projectId);
  const other = f.store.acquireLease(name, 'other', { ttlMs: 60000, limit: 1 });
  const controller = new AbortController();
  let ran = false;
  const waiting = withIntegrationLease(
    f.store,
    f.projectId,
    async () => {
      ran = true;
    },
    { signal: controller.signal },
  );
  await delay(20);
  // Both at once: the lease is lost and the integration lease becomes free.
  controller.abort(Object.assign(new Error('Project lease lost'), { code: 'project_lease_lost' }));
  f.store.releaseLease(other);
  await assert.rejects(waiting, { code: 'project_lease_lost' });
  assert.equal(ran, false);
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

// A gate repair commit on top of the current integration head (a fast-forward candidate).
async function gateRepair(f, name = 'gate') {
  const worktree = path.join(f.temp, 'tasks', name);
  git(f.root, 'worktree', 'add', '-q', '-b', `kodo/${name}`, worktree, f.branchHead());
  await writeFile(path.join(worktree, `${name}.txt`), `${name}\n`);
  git(worktree, 'add', '-A');
  git(worktree, 'commit', '-q', '-m', 'Gate repair');
  return git(worktree, 'rev-parse', 'HEAD');
}

test('A crash between returning a gate head and syncing the worktree is recovered on the next acceptance', async t => {
  const f = await fixture(t);
  const gateHead = await gateRepair(f);
  const expectedHead = f.branchHead();
  let pending = null;
  const crash = async commands => {
    await atomicPublisher(commands);
    throw Object.assign(new Error('Injected crash after update-ref'), { code: 'injected_crash' });
  };
  const back = options =>
    mergeBackGate({ worktree: f.integration.worktree, expectedHead, gateHead, publish: atomicPublisher, ...options });
  await assert.rejects(back({ publish: crash, savePending: value => (pending = value) }), { code: 'injected_crash' });
  assert.deepEqual(pending, { before: expectedHead, target: gateHead });
  assert.equal(f.branchHead(), gateHead, 'the return is published');
  // Without the record the interrupted state is refused (it blocked every later gate and merge).
  await assert.rejects(back({}), { code: 'project_integration_worktree_invalid' });
  // A held index.lock stops the sync: the repeat fails and changes nothing.
  const lock = path.join(git(f.integration.worktree, 'rev-parse', '--absolute-git-dir'), 'index.lock');
  await writeFile(lock, '');
  await assert.rejects(back({ pending }));
  await rm(lock);
  assert.equal(await back({ pending }), gateHead);
  assert.equal(git(f.integration.worktree, 'status', '--porcelain'), '');
});

test('merge.verifySignatures refuses an unsigned gate head in both forms of the return', async t => {
  const f = await fixture(t);
  git(f.root, 'config', 'merge.verifySignatures', 'true');
  const expectedHead = f.branchHead();
  const gateHead = await gateRepair(f);
  const back = () =>
    mergeBackGate({ worktree: f.integration.worktree, expectedHead, gateHead, publish: atomicPublisher });
  // Fast-forward.
  await assert.rejects(back(), { code: 'project_integration_unverified_signature' });
  assert.equal(f.branchHead(), expectedHead);
  // Merge commit: another merge moved the branch first.
  git(f.root, 'config', 'merge.verifySignatures', 'false');
  await f.merge('alpha', await f.task('alpha'), () => {}, { publish: atomicPublisher });
  git(f.root, 'config', 'merge.verifySignatures', 'true');
  const moved = f.branchHead();
  await assert.rejects(back(), { code: 'project_integration_unverified_signature' });
  assert.equal(f.branchHead(), moved);
});

test('A renewal that waited for another writer past the TTL does not revive the lease', async t => {
  const f = await fixture(t);
  const token = f.store.acquireLease('renew:boundary', 'holder', { ttlMs: 400 });
  // Another process holds the write lock longer than the lease has left.
  const child = spawn(
    process.execPath,
    [
      '-e',
      `const { DatabaseSync } = require('node:sqlite');
const db = new DatabaseSync(process.argv[1]);
db.exec('PRAGMA busy_timeout=5000; BEGIN IMMEDIATE');
process.stdout.write('locked\\n');
Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 900);
db.exec('COMMIT');
db.close();`,
      path.join(f.temp, 'state', 'state.sqlite'),
    ],
    { stdio: ['ignore', 'pipe', 'inherit'] },
  );
  const exited = new Promise(resolve => child.on('exit', resolve));
  await new Promise((resolve, reject) => {
    child.stdout.on('data', data => String(data).includes('locked') && resolve());
    child.on('exit', code => reject(new Error(`writer exited early: ${code}`)));
  });
  assert.equal(f.store.renewLease(token), false, 'the TTL passed while the renewal waited');
  assert.equal(await exited, 0);
});

test('A lost lease keeps its code while waiting', async t => {
  const f = await fixture(t);
  const lostLease = Object.assign(new Error('Project lease lost'), { code: 'project_lease_lost' });
  const controller = new AbortController();
  controller.abort(lostLease);
  f.store.acquireLease('wait:test', 'other', { ttlMs: 60000 });
  await assert.rejects(acquireLeaseWaiting(f.store, 'wait:test', { signal: controller.signal, pollMs: 1 }), {
    code: 'project_lease_lost',
  });
  f.store.acquireLease(integrationLeaseName(f.projectId), 'other', { ttlMs: 60000 });
  await assert.rejects(
    withIntegrationLease(f.store, f.projectId, async () => assert.fail('never held'), { signal: controller.signal }),
    { code: 'project_lease_lost' },
  );
});

test('A Git ref update that cannot start or times out is a lost publish', async t => {
  const f = await fixture(t);
  const head = f.branchHead();
  const next = await f.task('publish');
  const ref = `refs/heads/${f.integration.branch}`;
  const first = 'refs/heads/aaa-worker';
  git(f.root, 'update-ref', first, head);
  const commands = { verify: [{ ref: first, sha: head }], update: [{ ref, next, expected: head }] };
  const lostPublish = error => {
    assert.equal(error.code, 'project_lease_lost');
    assert.equal(error.refused, undefined, 'never classified by a second Git call');
    return true;
  };
  assert.throws(() => updateRefsAtomically(path.join(f.temp, 'missing'), commands), lostPublish);

  // Keep Git waiting for this ref beyond the process deadline on either ref backend.
  git(f.root, 'config', 'core.filesRefLockTimeout', '5000');
  git(f.root, 'config', 'reftable.lockTimeout', '5000');
  const holder = spawn('git', ['update-ref', '--stdin'], { cwd: f.root, windowsHide: true });
  const closed = once(holder, 'close');
  const replies = createInterface({ input: holder.stdout, crlfDelay: Infinity })[Symbol.asyncIterator]();
  try {
    holder.stdin.write(`start\nupdate ${ref} ${next} ${head}\nprepare\n`);
    assert.equal((await replies.next()).value, 'start: ok');
    assert.equal((await replies.next()).value, 'prepare: ok');
    assert.throws(() => updateRefsAtomically(f.root, commands, { timeoutMs: 100 }), lostPublish);
    assert.equal(f.branchHead(), head);
  } finally {
    holder.stdin.end('abort\n');
    assert.deepEqual(await closed, [0, null]);
  }
  assert.equal(f.branchHead(), head);
  updateRefsAtomically(f.root, commands);
  assert.equal(f.branchHead(), next, 'Git also released the lock on the earlier verify ref');
});
