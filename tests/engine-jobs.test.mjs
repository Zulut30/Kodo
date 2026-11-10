import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Engine } from '../runtime/engine.mjs';
import { readConfig } from '../runtime/config.mjs';
import { jobQueueFor } from '../runtime/engine-jobs.mjs';
import { openJobReader, openJobStore } from '../runtime/job-store.mjs';
import { read, git, fixture, node, fakeServices } from './helpers/engine-fixture.mjs';

const durable = { scheduler: 'durable' };
const done = role => ({ sessionId: `worker-${role}`, output: { summary: `${role} done`, checks: [], complete: true } });
const states = (store, run) =>
  Object.fromEntries(
    openJobStore({ store })
      .list(jobQueueFor(run))
      .map(job => [job.key, job.reason ? `${job.state}:${job.reason}` : job.state]),
  );
const merges = (run, id) =>
  git(run.cwd, 'log', '--merges', '--format=%s')
    .split('\n')
    .filter(subject => subject.includes(`-${id}'`) || subject.endsWith(`integrate ${id}`)).length;

/** Independent tasks writing their own file; `gate` lets a test hold workers. */
async function independent(t, { ids = ['one', 'two'], config = {}, parallel = true, onWorker } = {}) {
  const fx = await fixture(t, { config: { ...durable, ...config }, testScript: 'process.exit(0);\n' });
  const tasks = ids.map(id => ({ ...node(id, 'developer', [`out/${id}.txt`]), parallel }));
  const plan = { summary: 'Write independent files.', tasks };
  const probe = { active: 0, peak: 0, started: [] };
  const services = fakeServices({
    plan,
    onWorker: async call => {
      const id = /out\/([a-z]+)\.txt/.exec(call.prompt)?.[1] ?? ids.find(item => call.cwd.endsWith(item));
      probe.started.push(id);
      probe.peak = Math.max(probe.peak, ++probe.active);
      try {
        const custom = await onWorker?.(id, call, probe);
        if (custom) return custom;
        await mkdir(path.join(call.cwd, 'out'), { recursive: true });
        await writeFile(path.join(call.cwd, `out/${id}.txt`), `${id}\n`);
        return done(id);
      } finally {
        probe.active--;
      }
    },
  });
  return { fx, services, probe, plan };
}

test('The scheduler flag is optional and only accepts legacy or durable', async t => {
  const fx = await fixture(t);
  assert.equal((await readConfig(fx.project)).scheduler, undefined, 'absent means the legacy dispatcher');
  assert.equal((await readConfig(fx.project, durable)).scheduler, 'durable');
  await assert.rejects(readConfig(fx.project, { scheduler: 'swarm' }), /scheduler must be/);
});

test('The legacy dispatcher stays the default and creates no job queue', async t => {
  const fx = await fixture(t),
    services = fakeServices(),
    store = fx.openStore(),
    engine = new Engine({ store, ...services });
  const result = await engine.run((await engine.create('Legacy path', { project: fx.project })).id);
  assert.equal(result.state, 'succeeded', result.error?.message);
  fx.closeStore(store);
  const reader = openJobReader({ home: fx.home });
  try {
    assert.deepEqual(reader.queues(), []);
  } finally {
    reader.close();
  }
});

test('A durable run integrates every node once, in dependency order, and a resume repeats nothing', async t => {
  const fx = await fixture(t, { config: durable }),
    services = fakeServices(),
    store = fx.openStore(),
    engine = new Engine({ store, ...services });
  const run = await engine.create('Durable feature', { project: fx.project });
  const result = await engine.run(run.id);
  assert.equal(result.state, 'succeeded', result.error?.message);
  // The fixture's tester and documenter assert that they see the integrated developer change.
  assert.deepEqual(services.calls.worker.map(call => call.role).sort(), ['developer', 'documenter', 'tester']);
  assert.equal(services.calls.worker[0].role, 'developer', 'dependents wait for the integrated prerequisite');
  assert.deepEqual(states(store, result), {
    feature: 'integrated',
    'feature-tests': 'integrated',
    'feature-docs': 'integrated',
  });
  const jobs = openJobStore({ store });
  for (const job of jobs.list(jobQueueFor(result))) {
    assert.deepEqual(job.integration, { node: job.key, headSha: result.nodes[job.key].headSha });
    assert.equal(job.attempt, 1);
    assert.equal(merges(result, job.key), 1, `${job.key} is merged exactly once`);
  }
  assert.equal(await read(path.join(result.cwd, 'docs/usage.md')), 'The value export is 2.\n');
  await engine.run(run.id);
  assert.equal(services.calls.worker.length, 3, 'a finished run starts no session');
});

test('Independent parallel nodes overlap up to the limit; one node marked not parallel runs alone', async t => {
  await t.test('parallel', async subtest => {
    const both = Promise.withResolvers();
    const { fx, services, probe } = await independent(subtest, {
      onWorker: async (id, call, state) => {
        if (state.active === 2) both.resolve();
        await Promise.race([both.promise, delay(15000).then(() => assert.fail('workers never overlapped'))]);
      },
    });
    const engine = new Engine({ store: fx.openStore(), ...services });
    const result = await engine.run((await engine.create('Two files', { project: fx.project })).id);
    assert.equal(result.state, 'succeeded', result.error?.message);
    assert.equal(probe.peak, 2);
  });
  await t.test('plan forbids parallel', async subtest => {
    const { fx, services, probe } = await independent(subtest, { parallel: false, onWorker: () => delay(30) });
    const engine = new Engine({ store: fx.openStore(), ...services });
    const result = await engine.run((await engine.create('Two files', { project: fx.project })).id);
    assert.equal(result.state, 'succeeded', result.error?.message);
    assert.equal(probe.peak, 1);
  });
  await t.test('router forbids parallel', async subtest => {
    const { fx, services, probe } = await independent(subtest, { onWorker: () => delay(30) });
    services.provider.decideJev = async () => ({
      model: 'codex-sol',
      parallel: false,
      confidence: 0.95,
      sessionMode: 'fresh',
    });
    const engine = new Engine({ store: fx.openStore(), ...services });
    const result = await engine.run((await engine.create('Two files', { project: fx.project })).id);
    assert.equal(result.state, 'succeeded', result.error?.message);
    assert.equal(probe.peak, 1);
  });
});

test('Nodes writing the same file run one after another and the second sees the first integrated', async t => {
  const fx = await fixture(t, { config: durable, testScript: 'process.exit(0);\n' });
  const tasks = [node('first', 'developer', ['shared.txt']), node('second', 'developer', ['shared.txt'])];
  let active = 0,
    peak = 0;
  const services = fakeServices({
    plan: { summary: 'Append two lines to the shared file.', tasks },
    onWorker: async call => {
      peak = Math.max(peak, ++active);
      const id = call.cwd.endsWith('first') ? 'first' : 'second';
      const before = await read(path.join(call.cwd, 'shared.txt'));
      if (id === 'second') assert.equal(before, 'base\nfirst\n', 'the second node starts from the integrated first');
      await delay(20);
      await writeFile(path.join(call.cwd, 'shared.txt'), `${before}${id}\n`);
      active--;
      return done(id);
    },
  });
  const engine = new Engine({ store: fx.openStore(), ...services });
  const result = await engine.run((await engine.create('Shared file', { project: fx.project })).id);
  assert.equal(result.state, 'succeeded', result.error?.message);
  assert.equal(peak, 1);
  assert.equal(await read(path.join(result.cwd, 'shared.txt')), 'base\nfirst\nsecond\n');
});

test('A quota pause starts nothing new, respects the retry time and resumes the same node', async t => {
  let limited = true,
    retryAt;
  const { fx, services, probe } = await independent(t, {
    ids: ['one', 'two', 'three'],
    config: { concurrency: 1 },
    onWorker: async id => {
      if (id === 'two' && limited) {
        retryAt = new Date(Date.now() + 3_600_000).toISOString();
        throw Object.assign(new Error('fixture quota'), { code: 'quota', retryAt });
      }
    },
  });
  const store = fx.openStore(),
    engine = new Engine({ store, ...services });
  const run = await engine.create('Quota', { project: fx.project });
  const paused = await engine.run(run.id);
  assert.deepEqual([paused.state, paused.error.code, paused.error.retryAt], ['waiting_limits', 'quota', retryAt]);
  assert.deepEqual(probe.started, ['one', 'two'], 'after the first failure no further node starts');
  assert.deepEqual(states(store, paused), {
    one: 'integrated',
    two: 'waiting_quota:fixture quota',
    three: 'queued',
  });
  limited = false;
  const early = await engine.run(run.id);
  assert.deepEqual(
    [early.state, early.error.code, early.error.retryAt],
    ['waiting_limits', 'quota', retryAt],
    'the retry time is respected and reported',
  );
  assert.deepEqual(probe.started, ['one', 'two', 'three'], 'the limited node gets no session before its retry time');
  // The provider's retry time passes.
  store.db.prepare("UPDATE kodo_jobs SET retry_at=1 WHERE key='two'").run();
  const result = await engine.run(run.id);
  assert.equal(result.state, 'succeeded', result.error?.message);
  assert.deepEqual(probe.started, ['one', 'two', 'three', 'two']);
  assert.deepEqual(Object.values(states(store, result)), ['integrated', 'integrated', 'integrated']);
});

test('A node out of repair budget blocks its dependents until an explicit retry cycle', async t => {
  let broken = true;
  const fx = await fixture(t, { config: durable });
  const services = fakeServices({
    onWorker: async call => {
      if (call.role === 'developer') {
        if (broken) return { sessionId: 'dev', output: { summary: 'cannot finish', checks: [], complete: false } };
        await writeFile(path.join(call.cwd, 'src/value.mjs'), 'export const value = 2;\n');
      }
      if (call.role === 'tester') {
        await mkdir(path.join(call.cwd, 'tests'), { recursive: true });
        await writeFile(path.join(call.cwd, 'tests/check.mjs'), "import '../src/value.mjs';\n");
      }
      if (call.role === 'documenter') {
        await mkdir(path.join(call.cwd, 'docs'), { recursive: true });
        await writeFile(path.join(call.cwd, 'docs/usage.md'), 'The value export is 2.\n');
      }
      return done(call.role);
    },
  });
  const store = fx.openStore(),
    engine = new Engine({ store, ...services });
  const run = await engine.create('Blocked feature', { project: fx.project });
  const blocked = await engine.run(run.id);
  assert.deepEqual([blocked.state, blocked.error.code], ['blocked', 'blocked']);
  assert.equal(services.calls.worker.length, 1, 'dependents never start');
  const after = states(store, blocked);
  assert.match(after.feature, /^failed:/);
  assert.deepEqual(
    [after['feature-tests'], after['feature-docs']],
    ['blocked:dependency:feature', 'blocked:dependency:feature'],
  );
  broken = false;
  const again = await engine.run(run.id);
  assert.deepEqual([again.state, again.error.code], ['blocked', 'blocked'], 'a plain resume does not reset the budget');
  assert.equal(services.calls.worker.length, 1);
  const result = await engine.run(run.id, { retryFailed: true });
  assert.equal(result.state, 'succeeded', result.error?.message);
  assert.equal(services.calls.worker.length, 4);
  assert.deepEqual(Object.values(states(store, result)), ['integrated', 'integrated', 'integrated']);
});

test('A stop hands running work back and a new process finishes it without repeating integrated nodes', async t => {
  const controller = new AbortController();
  let stopOnce = true;
  const { fx, services, probe } = await independent(t, {
    ids: ['one', 'two', 'three'],
    config: { concurrency: 1 },
    onWorker: async id => {
      if (id === 'two' && stopOnce) {
        stopOnce = false;
        controller.abort();
        throw Object.assign(new Error('stopped'), { code: 'cancelled' });
      }
    },
  });
  const first = fx.openStore(),
    engine = new Engine({ store: first, ...services });
  const run = await engine.create('Stop and resume', { project: fx.project });
  const stopped = await engine.run(run.id, { signal: controller.signal });
  assert.equal(stopped.state, 'cancelled');
  assert.deepEqual(states(first, stopped), { one: 'integrated', two: 'queued:stopped', three: 'queued' });
  assert.equal(openJobStore({ store: first }).list(jobQueueFor(stopped))[1].attempt, 0, 'a stop spends no attempt');
  fx.closeStore(first);

  const second = fx.openStore(),
    restarted = new Engine({ store: second, ...services });
  const result = await restarted.run(run.id, { resumeCancelled: true });
  assert.equal(result.state, 'succeeded', result.error?.message);
  // Order after the stop is the queue's (the bypassed node aged); only the set of sessions is fixed.
  assert.deepEqual(probe.started.toSorted(), ['one', 'three', 'two', 'two']);
  for (const id of ['one', 'two', 'three']) assert.equal(merges(result, id), 1, `${id} is merged exactly once`);
});

test('A crash right after a merge is reconciled on restart instead of merging again', async t => {
  const { fx, services, probe } = await independent(t, { config: { concurrency: 1 } });
  const first = fx.openStore(),
    engine = new Engine({ store: first, ...services });
  const integrate = engine.integrateNode.bind(engine);
  let crash = true;
  engine.integrateNode = async (run, task, signal) => {
    await integrate(run, task, signal);
    if (crash) {
      crash = false;
      throw new Error('process died after the merge');
    }
  };
  const run = await engine.create('Crash after merge', { project: fx.project });
  const broken = await engine.run(run.id);
  assert.deepEqual([broken.state, broken.error.message], ['blocked', 'process died after the merge']);
  assert.equal(states(first, broken).one, 'integrating', 'the outcome is unknown to the queue');
  fx.closeStore(first);

  const second = fx.openStore(),
    restarted = new Engine({ store: second, ...services });
  const result = await restarted.run(run.id);
  assert.equal(result.state, 'succeeded', result.error?.message);
  assert.deepEqual(probe.started, ['one', 'two'], 'the merged node is not executed again');
  assert.equal(merges(result, 'one'), 1);
  const events = openJobStore({ store: second })
    .events(openJobStore({ store: second }).list(jobQueueFor(result))[0].id)
    .map(event => event.type);
  assert.ok(events.includes('integration_orphaned') && events.includes('integration_recovery'), events.join());
});
