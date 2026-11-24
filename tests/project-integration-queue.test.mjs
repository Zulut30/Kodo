import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../runtime/store.mjs';
import {
  awaitIntegration,
  drainIntegrationQueue,
  openIntegrationQueue,
} from '../runtime/project-integration-queue.mjs';
import { acquireLeaseWaiting, projectSectionHeld, withProjectSection } from '../runtime/project-controller-lease.mjs';
import { fencedBy } from '../runtime/lease-fence.mjs';
import { machineBuildLeaseName, machineBuildSettings, withMachineBuild } from '../runtime/machine-build-lease.mjs';

const projectId = randomUUID();
const sha = index => String(index).padStart(40, '0');

async function home(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'kodo-queue-'));
  const stores = [];
  t.after(async () => {
    for (const store of stores)
      try {
        store.close();
      } catch {
        /* Already closed by the test. */
      }
    await rm(directory, { recursive: true, force: true });
  });
  const open = () => {
    const store = new Store(directory);
    stores.push(store);
    return store;
  };
  return { directory, open };
}

const row = (taskId, priority = 0, head = 1) => ({
  projectId,
  taskId,
  attemptId: `attempt-${taskId}`,
  runId: `run-${taskId}`,
  baseSha: sha(0),
  headSha: sha(head),
  priority,
});
const scopes = { a: ['src/a.mjs'], b: ['src/b.mjs'], c: ['src/a.mjs'], d: ['src/d.mjs'] };
const scopeOf = entry => scopes[entry.taskId] ?? null;

test('The queue is a versioned migration of its own and survives a reopened state home', async t => {
  const h = await home(t);
  const first = h.open();
  const queue = openIntegrationQueue(first);
  const a = queue.enqueue(row('a', 0));
  assert.equal(a.status, 'queued');
  assert.deepEqual(queue.enqueue(row('a', 5)), a, 'a repeat returns the queued row unchanged');
  queue.enqueue(row('b', 2));
  first.close();
  const reopened = openIntegrationQueue(h.open());
  assert.deepEqual(
    reopened.list(projectId).map(entry => [entry.taskId, entry.priority, entry.status]),
    [
      ['b', 2, 'queued'],
      ['a', 0, 'queued'],
    ],
  );
  const db = h.open().db;
  assert.deepEqual(
    db
      .prepare('SELECT version FROM kodo_integration_queue_migrations')
      .all()
      .map(item => item.version),
    [1],
  );
  db.prepare('UPDATE kodo_integration_queue_migrations SET digest=?').run('f'.repeat(64));
  assert.throws(() => openIntegrationQueue({ db }), { code: 'project_integration_queue_unsupported' });
  assert.throws(() => reopened.enqueue({ ...row('x'), priority: 1.5 }), { code: 'project_integration_queue_invalid' });
});

test('A drain keeps priority and FIFO order: a claim ends at the first overlapping row', async t => {
  const queue = openIntegrationQueue((await home(t)).open());
  for (const [taskId, priority] of [
    ['a', 1],
    ['b', 1],
    ['c', 3],
    ['d', 0],
  ])
    queue.enqueue(row(taskId, priority));
  const order = [],
    batches = [];
  const finished = await drainIntegrationQueue({
    queue,
    projectId,
    scopeOf,
    integrate: async entry => {
      order.push(entry.taskId);
      // Which rows are claimed while this one integrates.
      batches.push(
        queue
          .list(projectId)
          .filter(row => row.status === 'merging')
          .map(row => row.taskId)
          .sort()
          .join(''),
      );
      if (entry.taskId === 'b') return { status: 'rejected', code: 'project_integration_conflict' };
      if (entry.taskId === 'd') throw Object.assign(new Error('boom'), { code: 'project_transition_blocked' });
      return { status: 'integrated' };
    },
  });
  // c (priority 3) first; a overlaps c, so c's claim ends there and a heads the next one.
  assert.deepEqual(order, ['c', 'a', 'b', 'd']);
  assert.deepEqual(batches, ['c', 'abd', 'bd', 'd'], 'c alone; then a, b and d are claimed together');
  assert.deepEqual(
    finished.map(entry => [entry.taskId, entry.status, entry.outcome.code ?? null]),
    [
      ['c', 'integrated', null],
      ['a', 'integrated', null],
      ['b', 'rejected', 'project_integration_conflict'],
      ['d', 'failed', 'project_transition_blocked'],
    ],
  );
  // A finished row stays for its readers; a new submission of the same head gets a new row.
  const again = queue.enqueue(row('b', 1));
  assert.equal(again.status, 'queued');
  assert.ok(again.seq > finished.at(-1).seq);
  assert.equal(queue.get(finished[2].seq).status, 'rejected', 'the refused row is kept');
  assert.deepEqual(queue.enqueue(row('b', 1)), again, 'one live row per Run and head');
  assert.equal(queue.enqueue(row('a', 1)).seq, finished[1].seq, 'an integrated head answers with its row');
});

test('One drain integrates at most four rows, stopped drains keep their merging rows', async t => {
  const store = (await home(t)).open();
  const queue = openIntegrationQueue(store);
  for (let index = 0; index < 6; index++) queue.enqueue(row(`t${index}`, 0, index + 1));
  // A crash left t0 merging (claimed, never finished).
  const [orphan] = queue.claim(projectId, { maxBatch: 1 });
  assert.equal(orphan.taskId, 't0');
  // A cancelled drain never touches it: the orphan stays merging for the next holder.
  assert.deepEqual(
    await drainIntegrationQueue({ queue, projectId, stop: () => true, integrate: async () => assert.fail('stopped') }),
    [],
  );
  assert.equal(queue.get(orphan.seq).status, 'merging');
  // A drain whose lease expired during the row (and passed on) records nothing: its fenced
  // write fails and the row stays merging for the current holder.
  const token = store.acquireLease(`project-integration:${projectId}`, 'stale', { ttlMs: 60000 });
  const lost = await fencedBy([token], () =>
    drainIntegrationQueue({
      queue,
      projectId,
      integrate: async () => {
        store.db.prepare('UPDATE leases SET expires=0 WHERE token=?').run(token);
        return { status: 'integrated' };
      },
    }),
  );
  assert.deepEqual(lost, []);
  assert.equal(queue.get(orphan.seq).status, 'merging');
  store.releaseLease(token);
  // A stale drain cannot finish or release a row another drain took over (claim).
  let taken;
  const stale = await drainIntegrationQueue({
    queue,
    projectId,
    maxRows: 1,
    integrate: async entry => {
      const staleClaim = queue.get(entry.seq).claim;
      // Meanwhile another drain adopts the same merging row and finishes it.
      taken = await drainIntegrationQueue({
        queue,
        projectId,
        maxRows: 1,
        integrate: async () => ({ status: 'rejected', code: 'project_submission_stale' }),
      });
      queue.release(entry.seq, staleClaim);
      return { status: 'integrated' };
    },
  });
  assert.deepEqual(stale, [], 'the stale drain finished nothing');
  assert.deepEqual(
    taken.map(entry => [entry.taskId, entry.status]),
    [['t0', 'rejected']],
  );
  assert.equal(queue.get(orphan.seq).outcome.code, 'project_submission_stale', 'the new outcome stays');
  // The row is queued again for the rest of the test.
  store.db.prepare("UPDATE kodo_integration_queue SET status='merging' WHERE seq=?").run(orphan.seq);
  const seen = [];
  const finished = await drainIntegrationQueue({
    queue,
    projectId,
    integrate: async entry => {
      seen.push(entry.taskId);
      return { status: 'integrated' };
    },
  });
  assert.deepEqual(seen, ['t0', 't1', 't2', 't3'], 'the orphan first, four rows in all');
  assert.equal(finished.length, 4);
  assert.deepEqual(
    queue
      .list(projectId)
      .filter(entry => entry.status === 'queued')
      .map(entry => entry.taskId),
    ['t4', 't5'],
  );
  // A stop between rows returns the claimed rows that never started; nothing else.
  let rows = 0;
  await drainIntegrationQueue({
    queue,
    projectId,
    stop: () => rows > 0,
    integrate: async () => {
      rows++;
      return { status: 'integrated' };
    },
  });
  assert.deepEqual(
    queue.list(projectId).map(entry => [entry.taskId, entry.status]),
    [
      ['t0', 'integrated'],
      ['t1', 'integrated'],
      ['t2', 'integrated'],
      ['t3', 'integrated'],
      ['t4', 'integrated'],
      ['t5', 'queued'],
    ],
  );
});

test('A drain stopped mid-row resumes its rows first and never finishes a row twice', async t => {
  const h = await home(t);
  const queue = openIntegrationQueue(h.open());
  for (const taskId of ['a', 'b', 'd']) queue.enqueue(row(taskId));
  const integrated = [];
  let crash;
  const stopped = new Promise(resolve => (crash = resolve));
  // The first drain "dies" inside b: its promise never settles, the rows stay merging.
  void drainIntegrationQueue({
    queue,
    projectId,
    scopeOf,
    integrate: async entry => {
      integrated.push(entry.taskId);
      if (entry.taskId === 'b') {
        crash();
        await new Promise(() => {});
      }
      return { status: 'integrated' };
    },
  });
  await stopped;
  const resumed = openIntegrationQueue(h.open());
  assert.deepEqual(
    resumed.list(projectId).map(entry => [entry.taskId, entry.status]),
    [
      ['a', 'integrated'],
      ['b', 'merging'],
      ['d', 'merging'],
    ],
  );
  const again = [];
  await drainIntegrationQueue({
    queue: resumed,
    projectId,
    scopeOf,
    integrate: async entry => {
      again.push(entry.taskId);
      return { status: 'integrated' };
    },
  });
  assert.deepEqual(again, ['b', 'd'], 'only the unfinished rows, in queue order');
  assert.deepEqual(integrated, ['a', 'b']);
  assert.ok(resumed.list(projectId).every(entry => entry.status === 'integrated'));
  assert.deepEqual(
    await drainIntegrationQueue({ queue: resumed, projectId, integrate: async () => assert.fail('nothing left') }),
    [],
  );
  // A replay that found the recorded completion finishes the live row of its head.
  const live = resumed.enqueue(row('e'));
  resumed.claim(projectId);
  resumed.settle(projectId, 'run-e', sha(1), { status: 'integrated' });
  assert.equal(resumed.get(live.seq).status, 'integrated');
});

test('A waiting submission drains when it can and stops with its own codes', async t => {
  const queue = openIntegrationQueue((await home(t)).open());
  const entry = queue.enqueue(row('a'));
  let busy = 3;
  const done = await awaitIntegration({
    queue,
    seq: entry.seq,
    pollMs: 1,
    tryDrain: async () => {
      if (busy-- > 0) return false;
      await drainIntegrationQueue({ queue, projectId, integrate: async () => ({ status: 'integrated' }) });
      return true;
    },
  });
  assert.equal(done.status, 'integrated');
  assert.equal(busy, -1, 'it waited for three busy polls');

  const waiting = queue.enqueue(row('b'));
  let clock = 0;
  await assert.rejects(
    awaitIntegration({
      queue,
      seq: waiting.seq,
      waitMs: 1000,
      pollMs: 1,
      now: () => (clock += 400),
      tryDrain: async () => false,
    }),
    { code: 'project_integration_queue_timeout' },
  );
  // The deadline is absolute: drains that end without this row never extend it.
  clock = 0;
  let drains = 0;
  await assert.rejects(
    awaitIntegration({
      queue,
      seq: waiting.seq,
      waitMs: 1000,
      pollMs: 1,
      now: () => (clock += 300),
      tryDrain: async () => {
        assert.ok(++drains < 5, 'the deadline ends the loop');
        return true;
      },
    }),
    { code: 'project_integration_queue_timeout' },
  );
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    awaitIntegration({ queue, seq: waiting.seq, signal: controller.signal, tryDrain: async () => false }),
    { code: 'project_integration_queue_cancelled' },
  );
  assert.equal(queue.get(waiting.seq).status, 'queued', 'a stopped wait leaves the row queued');
  // A finished row wins over the deadline: the drain that finished it ran past the deadline.
  const late = queue.enqueue(row('late'));
  clock = 0;
  const finished = await awaitIntegration({
    queue,
    seq: late.seq,
    waitMs: 1000,
    pollMs: 1,
    now: () => (clock += 600),
    tryDrain: async () => {
      await drainIntegrationQueue({
        queue,
        projectId,
        integrate: async entry => ({ status: entry.taskId === 'late' ? 'integrated' : 'rejected', code: 'x' }),
      });
      return true;
    },
  });
  assert.equal(finished.status, 'integrated');
});

test('The machine build semaphore admits its limit and waits for a free slot', async t => {
  const store = (await home(t)).open();
  assert.deepEqual(machineBuildSettings(undefined), { id: 'local', maxHeavyBuilds: 1 });
  for (const bad of [{ id: 'a b' }, { maxHeavyBuilds: 0 }, { maxHeavyBuilds: 65 }, []])
    assert.throws(() => machineBuildSettings(bad), { code: 'project_machine_invalid' });
  let running = 0,
    peak = 0;
  const release = [];
  const build = () =>
    withMachineBuild(
      store,
      async () => {
        peak = Math.max(peak, ++running);
        await new Promise(resolve => release.push(resolve));
        running--;
      },
      { machine: { id: 'box', maxHeavyBuilds: 2 }, pollMs: 1 },
    );
  const until = async condition => {
    const deadline = Date.now() + 30000;
    while (!condition()) {
      assert.ok(Date.now() < deadline, 'timed out waiting for the build slots');
      await new Promise(resolve => setImmediate(resolve));
    }
  };
  const builds = [build(), build(), build()];
  await until(() => release.length === 2);
  const count = () =>
    store.db.prepare('SELECT count(*) AS n FROM leases WHERE name=?').get(machineBuildLeaseName('box')).n;
  assert.equal(count(), 2, 'the third build waits for a slot');
  release.shift()();
  await until(() => release.length === 2);
  for (const resolve of release.splice(0)) resolve();
  await Promise.all(builds);
  assert.equal(peak, 2);
  assert.equal(count(), 0, 'every slot is released');
});

test('A short project section waits for the lease, is reentrant and stops on cancel', async t => {
  const store = (await home(t)).open();
  const name = `project:${projectId}`;
  const other = store.acquireLease(name, 'other', { ttlMs: 60000 });
  let entered = false;
  const section = withProjectSection(
    store,
    projectId,
    async () => {
      entered = true;
      return withProjectSection(store, projectId, async () => 'nested', { waitMs: 0 });
    },
    { pollMs: 1 },
  );
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(entered, false, 'it waits while another holder has the lease');
  store.releaseLease(other);
  assert.equal(await section, 'nested');
  const held = store.acquireLease(name, 'other', { ttlMs: 60000 });
  await assert.rejects(
    withProjectSection(store, projectId, async () => {}, { waitMs: 0 }),
    { code: 'project_busy' },
  );
  const controller = new AbortController();
  const cancelled = acquireLeaseWaiting(store, name, { signal: controller.signal, pollMs: 1 });
  controller.abort();
  await assert.rejects(cancelled, { code: 'project_cancelled' });
  store.releaseLease(held);
});

test('A lost lease aborts its holder, and a nested project section refuses to go on', async t => {
  const store = (await home(t)).open();
  const name = `project:${projectId}`;
  const aborted = signal => new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }));
  let nested;
  await withProjectSection(
    store,
    projectId,
    async lost => {
      assert.equal(projectSectionHeld(store, projectId), true);
      // The TTL expired and another holder took the lease (limit 1): two holders for a moment.
      store.db.prepare('DELETE FROM leases WHERE name=?').run(name);
      const other = store.acquireLease(name, 'other', { ttlMs: 60000 });
      assert.ok(other);
      await aborted(lost);
      assert.equal(projectSectionHeld(store, projectId), false);
      nested = await withProjectSection(store, projectId, async () => 'ran').catch(error => error.code);
      store.releaseLease(other);
    },
    { heartbeatMs: 5 },
  );
  assert.equal(nested, 'project_lease_lost');
  // The same for a build slot: its work learns that the slot is gone.
  const slot = await withMachineBuild(
    store,
    async lost => {
      store.db.prepare('DELETE FROM leases WHERE name=?').run(machineBuildLeaseName('local'));
      await aborted(lost);
      return lost.aborted;
    },
    { heartbeatMs: 5 },
  );
  assert.equal(slot, true);
});
