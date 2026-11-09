import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Store } from '../runtime/store.mjs';
import { openJobStore } from '../runtime/job-store.mjs';
import { runJobQueue } from '../runtime/job-scheduler.mjs';

const Q = 'project:swarm';
const spec = (key, extra = {}) => ({ key, role: 'developer', writePaths: [`src/${key}.mjs`], ...extra });

function fixture(t) {
  const home = mkdtempSync(path.join(os.tmpdir(), 'kodo-swarm-'));
  const clock = { offset: 0 };
  const store = new Store(home);
  const jobs = openJobStore({ store, now: () => Date.now() + clock.offset });
  t.after(() => {
    store.close();
    rmSync(home, { recursive: true, force: true });
  });
  /** Fake provider: records every call and the observed overlap. */
  const probe = { log: [], executed: [], integrated: [], running: 0, maxRunning: 0, merging: 0, maxMerging: 0 };
  const ports = (behaviour = {}) => ({
    async execute(job, context) {
      probe.executed.push(job.key);
      probe.log.push(`start:${job.key}`);
      probe.maxRunning = Math.max(probe.maxRunning, ++probe.running);
      try {
        return (await behaviour.execute?.(job, context)) ?? { headSha: `sha-${job.key}-${job.attempt}` };
      } finally {
        probe.running--;
        probe.log.push(`end:${job.key}`);
      }
    },
    async integrate(job, context) {
      probe.maxMerging = Math.max(probe.maxMerging, ++probe.merging);
      try {
        const receipt = (await behaviour.integrate?.(job, context)) ?? { commit: `merge-${job.key}` };
        probe.integrated.push(job.key);
        probe.log.push(`integrated:${job.key}`);
        return receipt;
      } finally {
        probe.merging--;
      }
    },
  });
  const run = (behaviour, extra = {}) =>
    runJobQueue({
      jobs,
      queue: Q,
      owner: 'coordinator',
      limits: { workers: 4, pools: {} },
      now: () => Date.now() + clock.offset,
      heartbeatMs: 5,
      ...ports(behaviour),
      ...extra,
    });
  return { jobs, clock, probe, run };
}
const states = jobs => Object.fromEntries(jobs.list(Q).map(job => [job.key, job.state]));

for (const workers of [1, 2, 4, 8])
  test(`Fake providers overlap exactly ${workers} worker slot(s) and integrate one at a time`, async t => {
    const { jobs, probe, run } = fixture(t);
    jobs.enqueue(
      Q,
      Array.from({ length: 8 }, (_, i) => spec(`j${i}`)),
    );
    // Barrier: a batch is released only once every available slot is occupied.
    let waiters = [];
    const execute = () =>
      new Promise(resolve => {
        waiters.push(resolve);
        if (waiters.length === workers) {
          const batch = waiters;
          waiters = [];
          setImmediate(() => batch.forEach(release => release()));
        }
      });
    const summary = await run({ execute, integrate: () => delay(2) }, { limits: { workers, pools: {} } });
    assert.deepEqual(summary, { status: 'integrated', counts: { integrated: 8 } });
    assert.equal(probe.maxRunning, workers, 'controlled overlap equals the configured slots');
    assert.equal(probe.maxMerging, 1, 'integration is serialized');
    assert.deepEqual([...probe.executed].sort(), [...new Set(probe.executed)].sort(), 'no job ran twice');
    assert.equal(probe.integrated.length, 8);
  });

test('Parallel independent jobs shorten wall time on a controlled fixture', async t => {
  const elapsed = {};
  for (const workers of [1, 4]) {
    const { jobs, run } = fixture(t);
    jobs.enqueue(
      Q,
      Array.from({ length: 8 }, (_, i) => spec(`j${i}`)),
    );
    const started = performance.now();
    await run({ execute: () => delay(40) }, { limits: { workers, pools: {} } });
    elapsed[workers] = performance.now() - started;
  }
  assert.ok(elapsed[1] >= 8 * 40, `sequential run took ${elapsed[1]} ms`);
  assert.ok(elapsed[4] < elapsed[1] * 0.6, `4 slots: ${elapsed[4]} ms, 1 slot: ${elapsed[1]} ms`);
});

test('C waits for the integration of A while independent B runs alongside', async t => {
  const { jobs, probe, run } = fixture(t);
  jobs.enqueue(Q, [spec('a'), spec('b'), spec('c', { dependsOn: ['a'], priority: 100 })]);
  const summary = await run({ execute: () => delay(15), integrate: () => delay(15) });
  assert.equal(summary.status, 'integrated');
  const at = name => probe.log.indexOf(name);
  assert.ok(at('integrated:a') < at('start:c'), probe.log.join(' '));
  assert.ok(at('start:b') < at('end:a'), 'independent work overlaps the prerequisite');
});

test('Jobs writing the same files never overlap and wait for integration', async t => {
  const { jobs, probe, run } = fixture(t);
  jobs.enqueue(Q, [spec('a', { writePaths: ['src/shared'] }), spec('b', { writePaths: ['src/shared/x.mjs'] })]);
  await run({ execute: () => delay(10) });
  assert.equal(probe.maxRunning, 1);
  assert.ok(probe.log.indexOf('integrated:a') < probe.log.indexOf('start:b'), probe.log.join(' '));
});

test('A throwing worker is retried within bounds and never reported as success', async t => {
  const { jobs, probe, run } = fixture(t);
  jobs.enqueue(Q, [spec('flaky'), spec('broken'), spec('after', { dependsOn: ['broken'] }), spec('fine')]);
  const summary = await run({
    execute(job) {
      if (job.key === 'flaky' && job.attempt === 1) throw new Error('transient');
      if (job.key === 'broken') throw Object.assign(new Error('contract violated'), { retryable: false });
    },
  });
  assert.deepEqual(summary, { status: 'blocked', counts: { integrated: 2, failed: 1, blocked: 1 } });
  assert.deepEqual(states(jobs), { flaky: 'integrated', broken: 'failed', after: 'blocked', fine: 'integrated' });
  assert.deepEqual(probe.executed.filter(key => key === 'flaky').length, 2);
  assert.deepEqual(probe.executed.filter(key => key === 'broken').length, 1);
  assert.ok(!probe.executed.includes('after'), 'a dependent of a failed job never starts');
  assert.deepEqual(probe.integrated.sort(), ['fine', 'flaky']);
});

test('Quota pauses one job with its progress while the rest finish, then resumes', async t => {
  const { jobs, clock, probe, run } = fixture(t);
  jobs.enqueue(Q, [spec('limited'), spec('free')]);
  const seen = [];
  const behaviour = {
    execute(job) {
      seen.push(job.checkpoint);
      if (job.key === 'limited' && !job.checkpoint)
        throw Object.assign(new Error('provider limit'), {
          code: 'quota',
          retryAt: new Date(Date.now() + clock.offset + 600_000).toISOString(),
          checkpoint: { sessionId: 'resume-me' },
        });
    },
  };
  const paused = await run(behaviour);
  assert.equal(paused.status, 'waiting_quota');
  assert.ok(paused.retryAt > Date.now() + clock.offset);
  assert.deepEqual(states(jobs), { limited: 'waiting_quota', free: 'integrated' });
  assert.deepEqual(await run(behaviour), paused, 'nothing restarts before the quota window');
  clock.offset += 600_001;
  assert.equal((await run(behaviour)).status, 'integrated');
  assert.deepEqual(seen.at(-1), { sessionId: 'resume-me' });
  assert.equal(probe.executed.filter(key => key === 'limited').length, 2);
});

test('Stop hands running jobs back; resume finishes without repeating recorded work', async t => {
  const { jobs, probe, run } = fixture(t);
  jobs.enqueue(Q, [spec('quick'), spec('slow')]);
  const controller = new AbortController();
  const behaviour = {
    async execute(job, { signal }) {
      if (job.key === 'quick') return;
      await new Promise((resolve, reject) => {
        signal.addEventListener('abort', () => reject(Object.assign(new Error('stopped'), { code: 'cancelled' })));
        setTimeout(() => controller.abort(), 20);
      });
    },
  };
  const stopped = await run(behaviour, { signal: controller.signal });
  assert.equal(stopped.status, 'stopped');
  const slow = jobs.list(Q).find(job => job.key === 'slow');
  assert.deepEqual([slow.state, slow.attempt, slow.reason], ['queued', 0, 'stopped'], 'a stop is not a failed attempt');
  assert.ok(['verifying', 'integrated'].includes(states(jobs).quick), 'recorded work survives the stop');
  const resumed = await run({});
  assert.equal(resumed.status, 'integrated');
  assert.equal(probe.executed.filter(key => key === 'quick').length, 1, 'recorded work is not executed again');
  assert.deepEqual(probe.integrated.sort(), ['quick', 'slow']);
});

test('An uncertain integration is reconciled, never blindly repeated', async t => {
  const { jobs, clock, probe, run } = fixture(t);
  jobs.enqueue(Q, [spec('a'), spec('b')]);
  let merges = 0;
  const behaviour = {
    integrate(job) {
      if (job.key === 'a' && ++merges === 1) throw new Error('connection reset after push');
    },
  };
  await assert.rejects(run(behaviour, { ttlMs: 1000 }), /connection reset/);
  assert.equal(states(jobs).a, 'integrating', 'the outcome is unknown, so ownership is kept');
  const busy = await run(behaviour, { ttlMs: 1000 });
  assert.equal(busy.status, 'busy', 'nothing is integrated behind an unresolved merge');
  assert.equal(merges, 1);
  clock.offset += 5000;
  await assert.rejects(run(behaviour, { ttlMs: 1000 }), error => error.code === 'job_reconcile_required');
  clock.offset += 5000;
  const reconciled = [];
  const summary = await run(behaviour, {
    ttlMs: 1000,
    reconcile: async job => {
      reconciled.push(job.key);
      return { integrated: true, receipt: { commit: 'found-on-remote' } };
    },
  });
  assert.equal(summary.status, 'integrated');
  assert.deepEqual(reconciled, ['a']);
  assert.equal(merges, 1, 'the merge that may have landed is not run again');
  assert.deepEqual(jobs.list(Q)[0].integration, { commit: 'found-on-remote' });
  assert.deepEqual(probe.integrated, ['b']);
});

test('A confirmed absent or conflicting integration follows the bounded retry policy', async t => {
  const { jobs, clock, run } = fixture(t);
  jobs.enqueue(Q, [spec('absent'), spec('conflict')]);
  const calls = { absent: 0, conflict: 0 };
  const behaviour = {
    integrate(job) {
      calls[job.key]++;
      if (job.key === 'absent' && calls.absent === 1)
        throw Object.assign(new Error('merge aborted cleanly'), { integrated: false });
      if (job.key === 'conflict')
        throw Object.assign(new Error('git conflict'), { integrated: false, retryable: false });
    },
  };
  const summary = await run(behaviour);
  assert.deepEqual(states(jobs), { absent: 'integrated', conflict: 'blocked' });
  assert.deepEqual(calls, { absent: 2, conflict: 1 });
  assert.equal(summary.status, 'blocked');
  // Reconciliation that finds no merge retries the same recorded result.
  jobs.enqueue(Q, [spec('lost')]);
  let lostMerges = 0;
  const lost = {
    integrate(job) {
      if (job.key === 'lost' && ++lostMerges === 1) throw new Error('crash');
    },
  };
  await assert.rejects(run(lost, { ttlMs: 1000 }), /crash/);
  clock.offset += 5000;
  await run(lost, { ttlMs: 1000, reconcile: async () => ({ integrated: false }) });
  assert.equal(states(jobs).lost, 'integrated');
  assert.equal(lostMerges, 2);
  assert.equal(jobs.list(Q).find(job => job.key === 'lost').attempt, 1, 'the job itself was executed once');
});

test('A durable cancel stops the worker and discards its late result', { timeout: 15000 }, async t => {
  const { jobs, probe, run } = fixture(t);
  jobs.enqueue(Q, [spec('doomed'), spec('kept')]);
  let aborted = false;
  const summary = await run({
    async execute(job, { signal }) {
      if (job.key !== 'doomed') return;
      jobs.cancel(job.id, { reason: 'user' });
      await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }));
      aborted = true;
      return { headSha: 'too-late' };
    },
  });
  assert.equal(aborted, true, 'the heartbeat reported the cancellation');
  assert.deepEqual(states(jobs), { doomed: 'cancelled', kept: 'integrated' });
  assert.equal(jobs.list(Q)[0].result, null);
  assert.deepEqual(probe.integrated, ['kept']);
  assert.equal(summary.status, 'blocked');
});

test('A worker that lost its lease cannot record or integrate a second result', { timeout: 15000 }, async t => {
  const { jobs, clock, probe, run } = fixture(t);
  jobs.enqueue(Q, [spec('a')]);
  let releaseFirst;
  const first = run(
    { execute: () => new Promise(resolve => (releaseFirst = () => resolve({ headSha: 'stale' }))) },
    { ttlMs: 1000, heartbeatMs: 3_600_000, owner: 'coordinator-1' },
  );
  await delay(20);
  clock.offset += 5000;
  const second = await run({}, { owner: 'coordinator-2' });
  assert.equal(second.status, 'integrated');
  releaseFirst();
  const late = await first;
  assert.equal(late.status, 'integrated', 'the stale worker ends quietly');
  const [job] = jobs.list(Q);
  assert.deepEqual([job.attempt, job.result.headSha], [2, 'sha-a-2']);
  assert.deepEqual(probe.integrated, ['a'], 'one integration');
});

test('Jobs for an unconnected host are reported, not run natively', async t => {
  const { jobs, probe, run } = fixture(t);
  jobs.enqueue(Q, [spec('remote', { host: 'orca' }), spec('needs-gpu', { capabilities: ['gpu'] })]);
  const summary = await run({});
  assert.deepEqual(probe.executed, []);
  assert.equal(summary.status, 'stalled');
  assert.deepEqual(summary.waiting, [{ key: 'needs-gpu', reason: 'worker_mismatch' }]);
  assert.deepEqual(
    jobs.list(Q).map(job => [job.key, job.state, job.reason]),
    [
      ['remote', 'blocked', 'host_unavailable:orca'],
      ['needs-gpu', 'queued', null],
    ],
  );
});
