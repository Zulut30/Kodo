import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../runtime/store.mjs';
import { openJobReader, openJobStore } from '../runtime/job-store.mjs';
import { STARVATION_BYPASSES } from '../runtime/job-contracts.mjs';

const Q = 'project:demo';
const limits = { workers: 4, pools: {} };
const spec = (key, extra = {}) => ({ key, role: 'developer', writePaths: [`src/${key}.mjs`], ...extra });
const code = (fn, expected) => assert.throws(fn, error => error.code === expected, expected);

function fixture(t, secrets = {}) {
  const home = mkdtempSync(path.join(os.tmpdir(), 'kodo-jobs-'));
  const clock = { now: 1_800_000_000_000 };
  const stores = [];
  const open = () => {
    const store = new Store(home, secrets);
    stores.push(store);
    return { store, jobs: openJobStore({ store, now: () => clock.now }) };
  };
  t.after(() => {
    for (const store of stores) store.close();
    rmSync(home, { recursive: true, force: true });
  });
  return { ...open(), open, clock, home };
}
const claim = (jobs, extra = {}) => jobs.claim(Q, { owner: 'worker', limits, ...extra });
/** Claim, complete and integrate one job; returns its key. */
function finish(jobs, extra = {}) {
  const claimed = claim(jobs, extra);
  assert.ok(claimed.job, JSON.stringify(claimed.waiting));
  jobs.complete(claimed.job.id, claimed.token, { headSha: 'a'.repeat(40) });
  const integration = jobs.beginIntegration(Q, { owner: 'coordinator' });
  assert.equal(integration.job.id, claimed.job.id);
  jobs.finishIntegration(integration.job.id, integration.token, { commit: 'b'.repeat(40) });
  return claimed.job.key;
}

test('Enqueue is idempotent by key and rejects a changed request, unknown or cyclic dependencies', t => {
  const { jobs } = fixture(t);
  const first = jobs.enqueue(Q, [spec('a'), spec('c', { dependsOn: ['a'] })]);
  assert.equal(first.created, 2);
  assert.deepEqual(
    first.jobs.map(job => [job.key, job.state, job.attempt, job.seq]),
    [
      ['a', 'queued', 0, 1],
      ['c', 'queued', 0, 2],
    ],
  );
  const again = jobs.enqueue(Q, [spec('a')]);
  assert.equal(again.created, 0);
  assert.equal(again.jobs[0].id, first.jobs[0].id);
  code(() => jobs.enqueue(Q, [spec('a', { priority: 70 })]), 'job_idempotency_conflict');
  code(() => jobs.enqueue(Q, [spec('x', { dependsOn: ['missing'] })]), 'job_dependency_unknown');
  code(
    () => jobs.enqueue(Q, [spec('p', { dependsOn: ['q'] }), spec('q', { dependsOn: ['p'] })]),
    'job_dependency_cycle',
  );
  code(() => jobs.enqueue('bad queue', [spec('z')]), 'job_queue_invalid');
  assert.equal(jobs.list(Q).length, 2, 'a rejected batch inserts nothing');
  assert.equal(jobs.enqueue('project:other', [spec('a')]).created, 1, 'keys are scoped to a queue');
});

test('Secrets never enter job specifications, results or reasons', t => {
  const { jobs } = fixture(t, { TOKEN: 'super-secret-value' });
  code(
    () => jobs.enqueue(Q, [spec('a', { payload: { note: 'uses super-secret-value' } })]),
    'job_secret_redaction_required',
  );
  jobs.enqueue(Q, [spec('a')]);
  const { job, token } = claim(jobs);
  code(() => jobs.complete(job.id, token, { log: 'super-secret-value' }), 'job_secret_redaction_required');
  const failed = jobs.fail(job.id, token, { reason: 'leaked super-secret-value', retryable: false });
  assert.ok(!JSON.stringify(failed).includes('super-secret-value'));
  assert.ok(!JSON.stringify(jobs.events(job.id)).includes('super-secret-value'));
});

test('Claims follow priority, hold an owned lease and never expose its token', t => {
  const { jobs } = fixture(t);
  jobs.enqueue(Q, [spec('low', { priority: 10 }), spec('high', { priority: 90 })]);
  const first = claim(jobs, { owner: 'w1' });
  assert.equal(first.job.key, 'high');
  assert.equal(first.job.state, 'running');
  assert.equal(first.job.attempt, 1);
  assert.equal(first.job.leaseOwner, 'w1');
  assert.match(first.token, /^[0-9a-f-]{36}$/);
  assert.ok(!JSON.stringify(jobs.list(Q)).includes(first.token));
  assert.ok(!JSON.stringify(jobs.events(first.job.id)).includes(first.token));
  assert.equal(claim(jobs, { owner: 'w2' }).job.key, 'low');
  const none = claim(jobs);
  assert.equal(none.job, null);
  assert.equal(none.token, null);
});

test('A dependent starts only after its prerequisite is integrated, not merely completed', t => {
  const { jobs } = fixture(t);
  jobs.enqueue(Q, [spec('a'), spec('b'), spec('c', { dependsOn: ['a'], priority: 99 })]);
  const a = claim(jobs);
  assert.equal(a.job.key, 'a', 'the dependent cannot be claimed first despite its priority');
  assert.equal(claim(jobs).job.key, 'b');
  const blocked = claim(jobs);
  assert.equal(blocked.job, null);
  assert.deepEqual(blocked.waiting, [{ key: 'c', reason: 'dependency_pending', detail: 'a' }]);
  jobs.complete(a.job.id, a.token, { headSha: '1'.repeat(40) });
  assert.equal(claim(jobs).job, null, 'verifying is not integrated');
  const integration = jobs.beginIntegration(Q, { owner: 'coordinator' });
  assert.equal(claim(jobs).job, null, 'integrating is not integrated');
  jobs.finishIntegration(integration.job.id, integration.token, { commit: '2'.repeat(40) });
  assert.equal(claim(jobs).job.key, 'c');
});

test('Conflicting write scopes run one after another', t => {
  const { jobs } = fixture(t);
  jobs.enqueue(Q, [spec('a', { writePaths: ['src/shared.mjs'] }), spec('b', { writePaths: ['src/shared.mjs'] })]);
  assert.equal(finishFirstThenProbe(jobs), 'b');
  function finishFirstThenProbe(store) {
    const a = claim(store);
    assert.equal(a.job.key, 'a');
    assert.deepEqual(claim(store).waiting, [{ key: 'b', reason: 'scope_conflict', detail: 'a' }]);
    store.complete(a.job.id, a.token, {});
    assert.equal(claim(store).job, null, 'unintegrated work still owns its scope');
    const integration = store.beginIntegration(Q, { owner: 'coordinator' });
    store.finishIntegration(integration.job.id, integration.token, {});
    return claim(store).job.key;
  }
});

test('A lost lease is re-run by another worker and the old worker cannot report', t => {
  const { jobs, clock } = fixture(t);
  jobs.enqueue(Q, [spec('a')]);
  const first = claim(jobs, { owner: 'w1', ttlMs: 1000 });
  assert.deepEqual(jobs.heartbeat(first.job.id, first.token, { ttlMs: 1000 }), { ok: true });
  clock.now += 5000;
  const second = claim(jobs, { owner: 'w2', ttlMs: 1000 });
  assert.equal(second.job.id, first.job.id);
  assert.equal(second.job.attempt, 2);
  assert.notEqual(second.token, first.token);
  assert.deepEqual(jobs.heartbeat(first.job.id, first.token), { ok: false, reason: 'lease_lost' });
  code(() => jobs.complete(first.job.id, first.token, { headSha: 'old' }), 'job_lease_lost');
  code(() => jobs.fail(first.job.id, first.token, { reason: 'late' }), 'job_lease_lost');
  assert.equal(jobs.complete(second.job.id, second.token, { headSha: 'new' }).result.headSha, 'new');
});

test('Lost leases are bounded by the retry policy', t => {
  const { jobs, clock } = fixture(t);
  jobs.enqueue(Q, [spec('a', { retry: { maxAttempts: 2 } }), spec('c', { dependsOn: ['a'] })]);
  for (let attempt = 1; attempt <= 2; attempt++) {
    assert.equal(claim(jobs, { ttlMs: 1000 }).job.attempt, attempt);
    clock.now += 5000;
  }
  const exhausted = claim(jobs);
  assert.equal(exhausted.job, null);
  const [a, c] = jobs.list(Q);
  assert.deepEqual([a.state, a.reason], ['failed', 'lease_lost']);
  assert.deepEqual([c.state, c.reason], ['blocked', 'dependency:a']);
});

test('A throwing worker retries within bounds; an explicit retry unblocks dependents', t => {
  const { jobs } = fixture(t);
  jobs.enqueue(Q, [spec('a'), spec('c', { dependsOn: ['a'] }), spec('d', { dependsOn: ['c'] })]);
  let run = claim(jobs);
  assert.equal(jobs.fail(run.job.id, run.token, { reason: 'boom' }).state, 'queued');
  run = claim(jobs);
  assert.equal(run.job.attempt, 2);
  const failed = jobs.fail(run.job.id, run.token, { reason: 'boom again' });
  assert.deepEqual([failed.state, failed.reason], ['failed', 'boom again']);
  assert.equal(claim(jobs).job, null);
  assert.deepEqual(
    jobs.list(Q).map(job => [job.key, job.state, job.reason]),
    [
      ['a', 'failed', 'boom again'],
      ['c', 'blocked', 'dependency:a'],
      ['d', 'blocked', 'dependency:c'],
    ],
  );
  assert.equal(jobs.retry(failed.id).state, 'queued');
  run = claim(jobs);
  assert.deepEqual([run.job.key, run.job.attempt], ['a', 1]);
  assert.deepEqual(
    jobs.list(Q).map(job => job.state),
    ['running', 'queued', 'queued'],
    'dependents return to the queue',
  );
  const fatal = jobs.fail(run.job.id, run.token, { reason: 'contract violated', retryable: false });
  assert.equal(fatal.state, 'failed');
});

test('Quota pauses a job with its progress, keeps its scope and frees the worker slot', t => {
  const { jobs, clock } = fixture(t);
  jobs.enqueue(Q, [spec('a'), spec('same', { writePaths: ['src/a.mjs'] }), spec('other')]);
  const one = { workers: 1, pools: {} };
  const a = claim(jobs, { limits: one });
  const waiting = jobs.waitQuota(a.job.id, a.token, {
    retryAt: clock.now + 60_000,
    reason: 'codex quota',
    checkpoint: { sessionId: 's-1', done: ['plan'] },
  });
  assert.deepEqual(
    [waiting.state, waiting.retryAt, waiting.reason],
    ['waiting_quota', clock.now + 60_000, 'codex quota'],
  );
  code(() => jobs.complete(a.job.id, a.token, {}), 'job_lease_lost');
  const next = claim(jobs, { limits: one });
  assert.equal(next.job.key, 'other', 'the slot is free, the conflicting scope is not');
  jobs.complete(next.job.id, next.token, {});
  assert.deepEqual(claim(jobs, { limits: one }).waiting, [{ key: 'same', reason: 'scope_conflict', detail: 'a' }]);
  clock.now += 60_000;
  const resumed = claim(jobs, { limits: one });
  assert.deepEqual([resumed.job.key, resumed.job.attempt], ['a', 1], 'a quota wait is not a failed attempt');
  assert.deepEqual(resumed.job.checkpoint, { sessionId: 's-1', done: ['plan'] });
});

test('Repeated quota waits are bounded', t => {
  const { jobs, clock } = fixture(t);
  jobs.enqueue(Q, [spec('a')]);
  let last;
  for (let i = 0; i < 12; i++) {
    const run = claim(jobs);
    last = jobs.waitQuota(run.job.id, run.token, { retryAt: clock.now + 1000 });
    clock.now += 1000;
  }
  assert.deepEqual([last.state, last.reason], ['blocked', 'quota_exhausted']);
});

test('Each result is integrated at most once', t => {
  const { jobs } = fixture(t);
  jobs.enqueue(Q, [spec('a'), spec('b')]);
  const a = claim(jobs),
    b = claim(jobs);
  jobs.complete(a.job.id, a.token, { headSha: 'a' });
  assert.equal(
    jobs.complete(a.job.id, a.token, { headSha: 'a' }).state,
    'verifying',
    'a repeated report is idempotent',
  );
  code(() => jobs.complete(a.job.id, a.token, { headSha: 'changed' }), 'job_result_conflict');
  jobs.complete(b.job.id, b.token, { headSha: 'b' });
  const first = jobs.beginIntegration(Q, { owner: 'coordinator' });
  assert.equal(first.job.key, 'a', 'integration follows completion order');
  assert.equal(first.recovery, false);
  assert.equal(jobs.beginIntegration(Q, { owner: 'other' }), null, 'one integration at a time');
  const done = jobs.finishIntegration(first.job.id, first.token, { commit: 'c1' });
  assert.deepEqual([done.state, done.integration], ['integrated', { commit: 'c1' }]);
  assert.equal(jobs.finishIntegration(first.job.id, first.token, { commit: 'c1' }).state, 'integrated');
  code(() => jobs.finishIntegration(first.job.id, first.token, { commit: 'c2' }), 'job_integration_conflict');
  code(() => jobs.abortIntegration(first.job.id, first.token, { reason: 'late' }), 'job_lease_lost');
  const second = jobs.beginIntegration(Q, { owner: 'coordinator' });
  assert.equal(second.job.key, 'b');
  jobs.finishIntegration(second.job.id, second.token, { commit: 'c3' });
  assert.equal(jobs.beginIntegration(Q, { owner: 'coordinator' }), null);
  assert.equal(jobs.events(first.job.id).filter(event => event.type === 'integrated').length, 1);
});

test('A crash between result and integration never re-executes the job', t => {
  const { jobs, open, clock } = fixture(t);
  jobs.enqueue(Q, [spec('a')]);
  const a = claim(jobs, { ttlMs: 1000 });
  jobs.complete(a.job.id, a.token, { headSha: 'a' });
  clock.now += 3_600_000;
  const restarted = open().jobs;
  assert.equal(claim(restarted).job, null, 'a recorded result is not executed again');
  const integration = restarted.beginIntegration(Q, { owner: 'coordinator' });
  assert.deepEqual([integration.job.key, integration.recovery, integration.job.result], ['a', false, { headSha: 'a' }]);
});

test('An interrupted integration must be reconciled before anything else is integrated', t => {
  const { jobs, open, clock } = fixture(t);
  jobs.enqueue(Q, [spec('a'), spec('b')]);
  for (const key of ['a', 'b']) {
    const run = claim(jobs);
    assert.equal(run.job.key, key);
    jobs.complete(run.job.id, run.token, { headSha: key });
  }
  const crashed = jobs.beginIntegration(Q, { owner: 'coordinator', ttlMs: 1000 });
  clock.now += 5000;
  const restarted = open().jobs;
  const recovery = restarted.beginIntegration(Q, { owner: 'coordinator-2', ttlMs: 1000 });
  assert.deepEqual([recovery.job.key, recovery.recovery], ['a', true], 'the uncertain merge is returned first');
  assert.notEqual(recovery.token, crashed.token);
  code(() => jobs.finishIntegration(crashed.job.id, crashed.token, { commit: 'late' }), 'job_lease_lost');
  // Reconciliation found no merge: the same result is integrated again, not re-executed.
  assert.equal(
    restarted.abortIntegration(recovery.job.id, recovery.token, { reason: 'merge absent' }).state,
    'verifying',
  );
  assert.equal(claim(restarted).job, null);
  const retry = restarted.beginIntegration(Q, { owner: 'coordinator-2' });
  assert.deepEqual([retry.job.key, retry.recovery], ['a', false]);
  restarted.finishIntegration(retry.job.id, retry.token, { commit: 'c1' });
  assert.equal(restarted.beginIntegration(Q, { owner: 'coordinator-2' }).job.key, 'b');
});

test('Integration retries are bounded and a conflict blocks without losing the queue', t => {
  const { jobs } = fixture(t);
  jobs.enqueue(Q, [spec('a'), spec('b')]);
  for (const key of ['a', 'b']) {
    const run = claim(jobs);
    jobs.complete(run.job.id, run.token, { headSha: key });
  }
  let last;
  for (let i = 0; i < 3; i++) {
    const integration = jobs.beginIntegration(Q, { owner: 'coordinator' });
    assert.equal(integration.job.key, 'a');
    last = jobs.abortIntegration(integration.job.id, integration.token, { reason: 'transient' });
  }
  assert.deepEqual([last.state, last.reason], ['blocked', 'integration_exhausted']);
  const b = jobs.beginIntegration(Q, { owner: 'coordinator' });
  assert.equal(b.job.key, 'b');
  const conflict = jobs.abortIntegration(b.job.id, b.token, { reason: 'git_conflict', retry: false });
  assert.deepEqual([conflict.state, conflict.reason], ['blocked', 'git_conflict']);
});

test('Cancellation is safe in every state, including mid-integration', t => {
  const { jobs } = fixture(t);
  jobs.enqueue(Q, [spec('queued'), spec('running'), spec('merging'), spec('merged')]);
  assert.equal(jobs.cancel(jobs.list(Q)[0].id, { reason: 'user' }).state, 'cancelled');
  const running = claim(jobs);
  assert.equal(running.job.key, 'running');
  assert.equal(jobs.cancel(running.job.id).state, 'cancelled');
  assert.deepEqual(jobs.heartbeat(running.job.id, running.token), { ok: false, reason: 'cancelled' });
  code(() => jobs.complete(running.job.id, running.token, {}), 'job_lease_lost');
  assert.equal(jobs.cancel(running.job.id).state, 'cancelled', 'cancel is idempotent');

  const merging = claim(jobs);
  jobs.complete(merging.job.id, merging.token, {});
  const integration = jobs.beginIntegration(Q, { owner: 'coordinator' });
  const requested = jobs.cancel(merging.job.id);
  assert.deepEqual([requested.state, requested.cancelRequested], ['integrating', true], 'a merge may already exist');
  assert.equal(
    jobs.abortIntegration(integration.job.id, integration.token, { reason: 'merge absent' }).state,
    'cancelled',
  );

  const merged = claim(jobs);
  jobs.complete(merged.job.id, merged.token, {});
  const second = jobs.beginIntegration(Q, { owner: 'coordinator' });
  jobs.cancel(merged.job.id);
  const done = jobs.finishIntegration(second.job.id, second.token, { commit: 'c' });
  assert.deepEqual([done.state, done.reason], ['integrated', 'cancel_after_integration']);
  code(() => jobs.cancel(merged.job.id), 'job_transition_invalid');
});

test('A low-priority job is not starved by a stream of urgent work', t => {
  const { jobs } = fixture(t);
  jobs.enqueue(Q, [spec('patient', { priority: 0 })]);
  const one = { workers: 1, pools: {} };
  let rounds = 0;
  for (; rounds < 200; rounds++) {
    jobs.enqueue(Q, [spec(`urgent-${rounds}`, { priority: 100 })]);
    if (finish(jobs, { limits: one }) === 'patient') break;
  }
  assert.ok(rounds > 0 && rounds <= 101, `patient ran after ${rounds} urgent jobs`);
});

test('A wide scope is not starved by a stream of narrow conflicting jobs', t => {
  const { jobs } = fixture(t);
  jobs.enqueue(Q, [spec('n-seed', { writePaths: ['src/seed.mjs'] })]);
  const holder = claim(jobs);
  jobs.enqueue(Q, [spec('wide', { writePaths: ['src'] })]);
  let wide = null;
  for (let i = 0; i < 3 * STARVATION_BYPASSES && !wide; i++) {
    jobs.enqueue(Q, [spec(`n-${i}`, { writePaths: [`src/n-${i}.mjs`], priority: 90 })]);
    const next = claim(jobs);
    if (next.job?.key === 'wide') wide = next;
    else if (next.job) {
      jobs.complete(next.job.id, next.token, {});
      const integration = jobs.beginIntegration(Q, { owner: 'coordinator' });
      jobs.finishIntegration(integration.job.id, integration.token, {});
    } else {
      // Narrow work now yields; the wide job starts once the active holder is integrated.
      assert.ok(next.waiting.some(row => row.reason === 'yield_to_starved' && row.detail === 'wide'));
      jobs.complete(holder.job.id, holder.token, {});
      const integration = jobs.beginIntegration(Q, { owner: 'coordinator' });
      jobs.finishIntegration(integration.job.id, integration.token, {});
    }
  }
  assert.ok(wide, 'the wide job eventually runs');
});

test('An unconnected host blocks its job and a later connection releases it', t => {
  const { jobs } = fixture(t);
  jobs.enqueue(Q, [spec('remote', { host: 't3' }), spec('local')]);
  assert.equal(claim(jobs).job.key, 'local', 'no silent native fallback');
  const [remote] = jobs.list(Q);
  assert.deepEqual([remote.state, remote.reason], ['blocked', 'host_unavailable:t3']);
  const connected = claim(jobs, { hosts: { t3: { available: true } } });
  assert.equal(connected.job.key, 'remote');
});

test('Two connections never claim or integrate the same job twice', t => {
  const { jobs, open } = fixture(t);
  const other = open().jobs;
  jobs.enqueue(
    Q,
    Array.from({ length: 12 }, (_, i) => spec(`j${i}`)),
  );
  const claimed = [],
    seen = new Set();
  for (let i = 0; i < 12; i++) {
    const side = i % 2 ? jobs : other;
    const run = side.claim(Q, { owner: `w${i % 2}`, limits: { workers: 8, pools: {} } });
    if (!run.job) {
      // Eight slots are busy: report one result through the *other* connection.
      const [id, token] = claimed.shift();
      (i % 2 ? other : jobs).complete(id, token, {});
      i--;
      continue;
    }
    assert.ok(!seen.has(run.job.id), 'a job is handed out once');
    seen.add(run.job.id);
    claimed.push([run.job.id, run.token]);
  }
  assert.ok(
    jobs.list(Q).every(job => job.attempt === 1),
    'every job was claimed exactly once',
  );
  const first = jobs.beginIntegration(Q, { owner: 'c1' });
  assert.ok(first);
  assert.equal(other.beginIntegration(Q, { owner: 'c2' }), null);
});

test('The job schema is additive, versioned and refuses an unknown version', t => {
  const { store, open, jobs } = fixture(t);
  store.createRun({ id: 'legacy-run', cwd: process.cwd(), state: 'created' });
  jobs.enqueue(Q, [spec('a')]);
  const reopened = open();
  assert.equal(reopened.jobs.list(Q).length, 1);
  assert.equal(reopened.store.getRun('legacy-run').id, 'legacy-run', 'legacy state is untouched');
  assert.deepEqual(reopened.jobs.queues(), [Q]);
  reopened.store.db.prepare('UPDATE kodo_job_migrations SET digest=?').run('tampered');
  code(() => openJobStore({ store: reopened.store }), 'job_migration_unsupported');
});

test('Integration never blocks jobs of a connected host', t => {
  const { jobs } = fixture(t);
  const hosts = { t3: { available: true } };
  jobs.enqueue(Q, [spec('local'), spec('remote', { host: 't3' }), spec('after', { dependsOn: ['remote'] })]);
  const one = { workers: 1, pools: {} };
  assert.equal(claim(jobs, { hosts, limits: one }).job.key, 'local');
  assert.equal(jobs.beginIntegration(Q, { owner: 'coordinator' }), null);
  jobs.recover(Q);
  assert.deepEqual(
    jobs.list(Q).map(job => job.state),
    ['running', 'queued', 'queued'],
    'a sweep without host knowledge leaves host decisions alone',
  );
  assert.deepEqual(
    jobs.events(jobs.list(Q)[1].id).map(event => event.type),
    ['enqueued'],
  );
});

test('A job waiting for quota keeps its scope and locks until it actually resumes', t => {
  const { jobs, clock } = fixture(t);
  jobs.enqueue(Q, [
    spec('paused', { pool: 'codex', locks: ['api:public'] }),
    spec('same-lock', { locks: ['api:public'] }),
    spec('same-file', { writePaths: ['src/paused.mjs'] }),
  ]);
  const paused = claim(jobs);
  jobs.waitQuota(paused.job.id, paused.token, { retryAt: clock.now + 1000, checkpoint: { step: 2 } });
  clock.now += 5000;
  // Due, but its pool is closed: nothing that conflicts with its progress may start.
  const closed = claim(jobs, { limits: { workers: 4, pools: { codex: 0 } } });
  assert.equal(closed.job, null);
  assert.deepEqual(closed.waiting, [
    { key: 'paused', reason: 'pool_full', detail: 'codex' },
    { key: 'same-lock', reason: 'lock_conflict', detail: 'api:public' },
    { key: 'same-file', reason: 'scope_conflict', detail: 'paused' },
  ]);
  assert.equal(jobs.list(Q)[0].state, 'waiting_quota');
  const resumed = claim(jobs);
  assert.deepEqual([resumed.job.key, resumed.job.attempt, resumed.job.checkpoint], ['paused', 1, { step: 2 }]);
});

test('A read-only reader reports jobs without creating or changing any state', t => {
  const { jobs, home, store } = fixture(t);
  jobs.enqueue(Q, [spec('a')]);
  const tables = () =>
    JSON.stringify(store.db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all());
  const before = tables();
  const reader = openJobReader({ home });
  assert.deepEqual(reader.queues(), [Q]);
  assert.deepEqual(
    reader.list(Q).map(job => job.key),
    ['a'],
  );
  assert.equal(reader.get(jobs.list(Q)[0].id).state, 'queued');
  assert.equal(reader.events(jobs.list(Q)[0].id).length, 1);
  assert.equal(tables(), before);
  jobs.enqueue(Q, [spec('b')]);
  assert.equal(reader.list(Q).length, 2, 'the reader sees later commits');
  reader.close(); // Before the fixture removes the directory: Windows locks open files.

  const empty = path.join(home, 'never-created');
  const none = openJobReader({ home: empty });
  assert.deepEqual([none.queues(), none.list(Q)], [[], []]);
  code(() => none.get('00000000-0000-4000-8000-000000000000'), 'job_not_found');
  none.close();
  assert.equal(existsSync(empty), false, 'a report never creates a state directory');
});

test('A reader on a pre-jobs database adds no tables', t => {
  const home = mkdtempSync(path.join(os.tmpdir(), 'kodo-jobs-legacy-'));
  const store = new Store(home);
  t.after(() => {
    store.close();
    rmSync(home, { recursive: true, force: true });
  });
  store.createRun({ id: 'legacy-run', cwd: process.cwd() });
  const reader = openJobReader({ home });
  assert.deepEqual(reader.queues(), []);
  reader.close();
  const names = store.db
    .prepare("SELECT name FROM sqlite_master WHERE type='table'")
    .all()
    .map(row => row.name);
  assert.ok(!names.some(name => name.startsWith('kodo_job')), names.join(','));
});

test('A new queue owner voids stale leases at once without spending attempts or repeating recorded work', t => {
  const { jobs } = fixture(t);
  jobs.enqueue(Q, [spec('a'), spec('b'), spec('c')]);
  const first = claim(jobs),
    second = claim(jobs),
    third = claim(jobs);
  jobs.complete(first.job.id, first.token, { headSha: 'a' });
  const crashed = jobs.beginIntegration(Q, { owner: 'coordinator-1' });
  jobs.complete(second.job.id, second.token, { headSha: 'b' });
  assert.equal(jobs.beginIntegration(Q, { owner: 'coordinator-2' }), null, 'a live integration lease is respected');

  jobs.takeOver(Q);
  assert.deepEqual(
    jobs.list(Q).map(job => [job.key, job.state, job.attempt, job.reason]),
    [
      ['a', 'integrating', 1, null],
      ['b', 'verifying', 1, null],
      ['c', 'queued', 0, 'owner_replaced'],
    ],
    'only the running job returns to the queue, without a spent attempt',
  );
  code(() => jobs.complete(third.job.id, third.token, { headSha: 'late' }), 'job_lease_lost');
  assert.deepEqual(jobs.heartbeat(third.job.id, third.token), { ok: false, reason: 'lease_lost' });
  const recovery = jobs.beginIntegration(Q, { owner: 'coordinator-2' });
  assert.deepEqual([recovery.job.key, recovery.recovery], ['a', true], 'the orphaned integration is reconciled first');
  code(() => jobs.finishIntegration(crashed.job.id, crashed.token, { commit: 'x' }), 'job_lease_lost');
  jobs.takeOver(Q);
  assert.equal(jobs.events(recovery.job.id).filter(event => event.type === 'integration_orphaned').length, 2);
  code(() => jobs.takeOver('not a queue'), 'job_queue_invalid');
});

test('A reader refuses WAL frames without their shared-memory file instead of creating sidecars', t => {
  const home = mkdtempSync(path.join(os.tmpdir(), 'kodo-jobs-orphan-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const store = new Store(home);
  openJobStore({ store }).enqueue(Q, [spec('a')]);
  store.close();
  // A writer died: frames are left in the WAL and the shared-memory file is gone.
  writeFileSync(path.join(home, 'state.sqlite-wal'), Buffer.alloc(4096, 1));
  rmSync(path.join(home, 'state.sqlite-shm'), { force: true });
  code(() => openJobReader({ home }), 'job_recovery_required');
  assert.equal(existsSync(path.join(home, 'state.sqlite-shm')), false, 'a report creates no sidecar file');
});
