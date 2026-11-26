// Stage 15B: asynchronous task verification and the integration queue.
import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { verifyTaskFastOnce } from '../runtime/wave-verifier.mjs';
import {
  git,
  fixture,
  buildLeases,
  until,
  queueOf,
  queued,
  lightPorts,
  integrationWorktree,
} from './helpers/parallel-engine-fixture.mjs';

test('Two completions verify task-fast at the same time with two build slots', { timeout: 180000 }, async t => {
  const f = await fixture(t, { count: 2 });
  const briefs = await f.briefs();
  const submissions = [];
  for (const brief of briefs.values()) submissions.push({ brief, head: await f.change(brief) });
  const together = Promise.withResolvers();
  const acquire = f.store.acquireLease.bind(f.store);
  t.mock.method(f.store, 'acquireLease', (name, owner, options) => {
    const token = acquire(name, owner, options);
    if (!token && name === 'machine-build:local') together.resolve(false);
    return token;
  });
  t.signal.addEventListener('abort', () => together.resolve(false), { once: true });
  const overlapped = [];
  let arrivals = 0;
  f.ports.verifyTaskFast = async input => {
    if (++arrivals === 2) together.resolve(true);
    overlapped.push(await together.promise);
    return verifyTaskFastOnce(input);
  };
  const machine = { id: 'local', maxHeavyBuilds: 2 };
  const results = await Promise.all(
    submissions.map(({ brief, head }) =>
      f.complete(brief, head, { machine, signal: t.signal }).finally(() => together.resolve(false)),
    ),
  );
  assert.deepEqual(
    results.map(row => row.status),
    ['integrated', 'integrated'],
    JSON.stringify(results),
  );
  assert.deepEqual(overlapped, [true, true], 'both task-fast runs were in progress at once');
  assert.equal(f.merges().length, 2);
});

test('A submission takes the build slot of the machine its profile placement named', async t => {
  const f = await fixture(t, { count: 1 });
  f.repo.setProfile(f.projectId, {
    subscriptions: [{ id: 'a', slots: 2, provider: 'codex', model: 'gpt', tier: 'fast' }],
    machines: [{ id: 'pc', kind: 'local', maxWorkers: 2, maxHeavyBuilds: 2 }],
  });
  const [brief] = (await f.briefs()).values();
  assert.equal(brief.machine?.id, 'pc');
  const requested = [];
  const acquire = f.store.acquireLease.bind(f.store);
  f.store.acquireLease = (name, owner, options) => {
    if (name.startsWith('machine-build:')) requested.push([name, options?.limit]);
    return acquire(name, owner, options);
  };
  const seen = [];
  f.ports.verifyTaskFast = async input => {
    seen.push(input.maxHeavyBuilds);
    return verifyTaskFastOnce(input);
  };
  // No library `machine` override: the CLI never passes one.
  const result = await f.complete(brief, await f.change(brief));
  assert.equal(result.status, 'integrated', JSON.stringify(result));
  assert.deepEqual(requested, [['machine-build:pc', 2]]);
  assert.deepEqual(seen, [2]);
});

test('A profile machine id the build semaphore cannot name still gets one stable slot', async t => {
  const f = await fixture(t, { count: 1 });
  const id = 'team/pc-' + 'x'.repeat(70);
  f.repo.setProfile(f.projectId, {
    subscriptions: [{ id: 'a', slots: 1, provider: 'codex', model: 'gpt', tier: 'fast' }],
    machines: [{ id, kind: 'local', maxWorkers: 2, maxHeavyBuilds: 2 }],
  });
  const [brief] = (await f.briefs()).values();
  assert.equal(brief.machine?.id, id);
  let result;
  const requested = await buildLeases(f, async () => {
    result = await f.complete(brief, await f.change(brief));
  });
  assert.equal(result.status, 'integrated', JSON.stringify(result));
  assert.equal(requested.length, 1);
  assert.match(requested[0][0], /^machine-build:m-[0-9a-f]{24}$/);
  assert.equal(requested[0][1], 2);
});

test('One build slot serializes task-fast across concurrent completions', async t => {
  const f = await fixture(t, { count: 2 });
  const briefs = await f.briefs();
  const events = [];
  f.ports.verifyTaskFast = async input => {
    const id = typeof input.run === 'string' ? input.run : input.run.id;
    events.push(['start', id]);
    try {
      return await verifyTaskFastOnce(input);
    } finally {
      events.push(['end', id]);
    }
  };
  const results = await Promise.all(
    [...briefs.values()].map(async brief =>
      f.complete(brief, await f.change(brief), { machine: { id: 'local', maxHeavyBuilds: 1 } }),
    ),
  );
  assert.deepEqual(
    results.map(row => row.status),
    ['integrated', 'integrated'],
    JSON.stringify(results),
  );
  assert.equal(events.length, 4);
  assert.deepEqual(
    events.map(row => row[0]),
    ['start', 'end', 'start', 'end'],
    'the second task-fast starts after the first ended',
  );
});

test('A verified completion waits for a busy integration lease beyond the old 120 s limit', async t => {
  const f = await fixture(t, { count: 1 });
  const [brief] = (await f.briefs()).values();
  const head = await f.change(brief);
  const name = `project-integration:${f.projectId}`;
  // A long integration elsewhere: a lease that outlives the simulated waiting time.
  const holder = f.store.acquireLease(name, 'elsewhere', { ttlMs: 24 * 3600000 });
  assert.ok(holder);
  const realNow = Date.now.bind(Date),
    acquire = f.store.acquireLease.bind(f.store);
  let offset = 0,
    refusals = 0;
  t.mock.method(Date, 'now', () => realNow() + offset);
  // Every refused poll of the integration lease advances the clock by 10 s; after 300 s the
  // other holder finishes. The waiting submission must still integrate (no integration_busy).
  t.mock.method(f.store, 'acquireLease', (lease, owner, options) => {
    const token = acquire(lease, owner, options);
    if (!token && lease === name) {
      offset += 10000;
      if (++refusals === 30) f.store.releaseLease(holder);
    }
    return token;
  });
  const result = await f.complete(brief, head);
  assert.equal(result.status, 'integrated', JSON.stringify(result));
  assert.ok(refusals >= 30, 'the submission waited for the other holder');
  assert.equal(f.merges().length, 1);
});

test('Ten concurrent completions integrate in priority order without integration_busy', async t => {
  const f = await fixture(t, { count: 10 });
  lightPorts(f);
  const briefs = [...(await f.briefs()).values()];
  const heads = new Map();
  for (const brief of briefs) heads.set(brief.taskId, await f.change(brief));
  // Priorities are a permutation; submissions start in task order.
  const priority = Object.fromEntries(briefs.map((brief, index) => [brief.taskId, (index * 7) % 10]));
  // Hold the integration lease until all ten are verified and queued, so the drains see them all.
  const holder = f.store.acquireLease(`project-integration:${f.projectId}`, 'test', { ttlMs: 600000 });
  const machine = { id: 'local', maxHeavyBuilds: 4 };
  const pending = briefs.map(brief =>
    f.complete(brief, heads.get(brief.taskId), { machine, priority: priority[brief.taskId] }),
  );
  const queue = await queueOf(f);
  await until(() => queued(queue, f) === 10, 'ten queued rows');
  f.store.releaseLease(holder);
  const results = await Promise.all(pending);
  assert.deepEqual(
    results.map(row => row.status),
    Array(10).fill('integrated'),
    JSON.stringify(results.filter(row => row.status !== 'integrated')),
  );
  const expected = [...briefs].sort((a, b) => priority[b.taskId] - priority[a.taskId]).map(row => row.taskId);
  assert.deepEqual(f.calls.integrate, expected, 'higher priority integrates first');
  assert.equal(f.merges().length, 10);
});

test('One drain holds the project and integration leases for at most four rows', async t => {
  const f = await fixture(t, { count: 5 });
  lightPorts(f);
  const briefs = [...(await f.briefs()).values()];
  const heads = new Map();
  for (const brief of briefs) heads.set(brief.taskId, await f.change(brief));
  const holder = f.store.acquireLease(`project-integration:${f.projectId}`, 'test', { ttlMs: 600000 });
  const tokens = [];
  const integrate = f.ports.integrateAndAdvance;
  f.ports.integrateAndAdvance = async (waveCtx, input) => {
    const lease = name => f.store.db.prepare('SELECT token FROM leases WHERE name=?').get(name)?.token;
    tokens.push([lease(`project:${f.projectId}`), lease(`project-integration:${f.projectId}`)]);
    return integrate(waveCtx, input);
  };
  const pending = briefs.map(brief =>
    f.complete(brief, heads.get(brief.taskId), { machine: { id: 'local', maxHeavyBuilds: 5 } }),
  );
  const queue = await queueOf(f);
  await until(() => queued(queue, f) === 5, 'five queued rows');
  f.store.releaseLease(holder);
  const results = await Promise.all(pending);
  assert.deepEqual(
    results.map(row => row.status),
    Array(5).fill('integrated'),
  );
  assert.equal(tokens.length, 5);
  assert.equal(new Set(tokens.slice(0, 4).map(row => row.join())).size, 1, 'the first four rows share one hold');
  assert.notEqual(tokens[4][0], tokens[0][0], 'the fifth row comes after the project lease was released');
  assert.notEqual(tokens[4][1], tokens[0][1], 'and after the integration lease was released');
});

test('A duplicate submission of one head waits for the first verification and integrates once', async t => {
  const f = await fixture(t, { count: 1 });
  lightPorts(f);
  const [brief] = (await f.briefs()).values();
  const head = await f.change(brief);
  // The first verification holds until the duplicate waits for it (its refused dedupe lease).
  let duplicateWaits;
  const waiting = new Promise(resolve => (duplicateWaits = resolve));
  const acquire = f.store.acquireLease.bind(f.store);
  t.mock.method(f.store, 'acquireLease', (name, owner, options) => {
    const token = acquire(name, owner, options);
    if (!token && name.startsWith('project-verify:')) duplicateWaits();
    return token;
  });
  const verify = f.ports.verifyTaskFast;
  // A failsafe for a broken build only; it is cancelled as soon as the race is decided.
  const failsafe = new AbortController();
  t.after(() => failsafe.abort());
  f.ports.verifyTaskFast = async input => {
    await Promise.race([waiting, delay(3000, undefined, { signal: failsafe.signal }).catch(() => {})]);
    failsafe.abort();
    return verify(input);
  };
  const results = await Promise.all([f.complete(brief, head), f.complete(brief, head)]);
  assert.deepEqual(
    results.map(row => row.status),
    ['integrated', 'integrated'],
    JSON.stringify(results),
  );
  assert.equal(f.calls.verify.length, 1, 'task-fast ran once');
  assert.deepEqual(f.calls.integrate, ['t0']);
  assert.equal(f.merges().length, 1);
  assert.equal(f.store.getRun(brief.runId).state, 'succeeded');
});

test('An abandon during task-fast wins: the submission is stale and the Run stays cancelled', async t => {
  const f = await fixture(t, { count: 1 });
  lightPorts(f);
  const [brief] = (await f.briefs()).values();
  const head = await f.change(brief);
  let verifying, abandoned;
  const started = new Promise(resolve => (verifying = resolve));
  const done = new Promise(resolve => (abandoned = resolve));
  const verify = f.ports.verifyTaskFast;
  f.ports.verifyTaskFast = async input => {
    verifying();
    await done;
    return verify(input);
  };
  const submission = f.complete(brief, head);
  await started;
  const abandon = await f.complete(brief, head, { abandon: true, deferGate: false });
  assert.equal(abandon.status, 'abandoned');
  abandoned();
  const result = await submission;
  assert.deepEqual([result.status, result.code], ['blocked', 'project_submission_stale']);
  const run = f.store.getRun(brief.runId);
  assert.equal(run.state, 'cancelled');
  assert.equal(run.externalCompletion, undefined);
  assert.deepEqual(f.calls.integrate, []);
  assert.equal(f.merges().length, 0);
});

test('A worker that moved its branch after task-fast is refused before any merge', async t => {
  const f = await fixture(t, { count: 1 });
  lightPorts(f);
  const [brief] = (await f.briefs()).values();
  const verified = await f.change(brief);
  const holder = f.store.acquireLease(`project-integration:${f.projectId}`, 'test', { ttlMs: 600000 });
  const submission = f.complete(brief, verified);
  const queue = await queueOf(f);
  await until(() => queued(queue, f) === 1, 'the verified head queued');
  // The worker commits again on its branch while the verified head waits in the queue.
  await f.change(brief, 5);
  f.store.releaseLease(holder);
  const result = await submission;
  assert.deepEqual([result.status, result.code], ['blocked', 'project_submission_stale']);
  assert.deepEqual(f.calls.integrate, [], 'nothing was merged');
  assert.equal(f.merges().length, 0);
});

test('A replay finishes the live queue row of its completion and never answers a lost merge', async t => {
  const f = await fixture(t, { count: 1 });
  lightPorts(f);
  const [brief] = (await f.briefs()).values();
  const head = await f.change(brief);
  const first = await f.complete(brief, head);
  assert.equal(first.status, 'integrated');
  const queue = await queueOf(f);
  const [row] = queue.list(f.projectId);
  // A drain recorded the completion and stopped before it finished its row.
  const reopen = () =>
    f.store.db.prepare("UPDATE kodo_integration_queue SET status='merging' WHERE seq=?").run(row.seq);
  reopen();
  const replay = await f.complete(brief, head);
  assert.deepEqual([replay.status, replay.replayed], ['integrated', true]);
  assert.equal(queue.get(row.seq).status, 'integrated');
  // The branch lost the merge (reset): a replay is a recovery blocker, and so is its row.
  reopen();
  const worktree = integrationWorktree(f);
  git(worktree, 'reset', '--hard', 'HEAD~1');
  const lost = await f.complete(brief, head);
  assert.deepEqual([lost.status, lost.code], ['blocked', 'project_integration_missing']);
  assert.equal(queue.get(row.seq).status, 'rejected');
  assert.equal(queue.get(row.seq).outcome.code, 'project_integration_missing');
});
