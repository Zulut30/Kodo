import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Engine } from '../runtime/engine.mjs';
import { Store } from '../runtime/store.mjs';
import { makeWorktree } from '../runtime/workspace.mjs';

const deferred = () => Promise.withResolvers();
const turn = () => new Promise(resolve => setImmediate(resolve));
const read = file => readFile(file, 'utf8');
const node = (id, dependsOn = []) => ({ id, role: 'developer', description: `write ${id}`, writePaths: [`${id}.txt`], dependsOn, parallel: true, acceptance: [`${id} exists`] });
function git(cwd, ...args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true });
  assert.equal(result.status, 0, `${args.join(' ')}\n${result.stderr}`);
  return result.stdout.trim();
}
async function fixture(t, tasks, worker) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'kodo-scheduler-test-'));
  const project = path.join(directory, 'project'); await mkdir(project);
  let store;
  t.after(async () => {
    store?.close();
    const resolved = path.resolve(directory);
    assert.equal(path.dirname(resolved), path.resolve(os.tmpdir()));
    assert.ok(path.basename(resolved).startsWith('kodo-scheduler-test-'));
    await rm(resolved, { recursive: true, force: true });
  });
  await writeFile(path.join(project, '.gitattributes'), '* text=auto eol=lf\n');
  await writeFile(path.join(project, 'original.txt'), 'original committed bytes\n');
  await writeFile(path.join(project, 'kodo.config.json'), JSON.stringify({ schemaVersion: 1, client: 'codex', concurrency: 2, repairRounds: 2, researchBudget: 0, commands: { test: [], build: [], deploy: [], smoke: [] }, delivery: { enabled: false } }));
  git(project, 'init', '-b', 'main'); git(project, 'config', 'user.name', 'Kodo Scheduler Test'); git(project, 'config', 'user.email', 'scheduler@example.invalid');
  git(project, 'config', 'core.autocrlf', 'false'); git(project, 'add', '.'); git(project, 'commit', '-m', 'Fixture baseline');
  const base = git(project, 'rev-parse', 'HEAD');
  await writeFile(path.join(project, 'original.txt'), 'user work in progress\n');
  await writeFile(path.join(project, 'untracked.txt'), 'user untracked bytes\n');
  const dirty = git(project, 'status', '--porcelain=v1');
  const decisions = [], sessions = [], concurrency = { active: 0, maxActive: 0 };
  const provider = {
    decideJev: async ({ node, attempt }) => {
      decisions.push({ id: node.id, attempt });
      return { model: 'sol', parallel: true, confidence: 0.95, sessionMode: 'fresh' };
    },
    runSession: async request => {
      const id = /Assigned node: ([\w-]+)/.exec(request.prompt)?.[1];
      assert.ok(id, 'fixture expects only assigned worker sessions');
      sessions.push({ id, cwd: request.cwd });
      concurrency.active++; concurrency.maxActive = Math.max(concurrency.maxActive, concurrency.active);
      try { await worker(id, request); } finally { concurrency.active--; }
      return { sessionId: `session-${id}`, output: { summary: `wrote ${id}`, checks: [], complete: true } };
    }
  };
  store = new Store(path.join(directory, 'state'));
  const engine = new Engine({ store, provider, tools: { resolveTool: async () => ({ id: 'ripgrep', ready: false }) } });
  const run = await engine.create('Continuously schedule scoped tasks', { project });
  await makeWorktree(project, run.cwd, run.branch, base);
  run.executionMode = { selected: 'standard' };
  run.models = [{ id: 'sol', client: 'codex', model: 'gpt-6.1-sol' }];
  run.plan = { summary: 'Scoped scheduling fixture', tasks }; engine.save(run);
  const assertUserUnchanged = async () => {
    assert.equal(git(project, 'rev-parse', 'HEAD'), base);
    assert.equal(git(project, 'branch', '--show-current'), 'main');
    assert.equal(git(project, 'status', '--porcelain=v1'), dirty);
    assert.equal(await read(path.join(project, 'original.txt')), 'user work in progress\n');
    assert.equal(await read(path.join(project, 'untracked.txt')), 'user untracked bytes\n');
  };
  return { directory, project, base, store, engine, run, decisions, sessions, concurrency, assertUserUnchanged };
}

test('Engine admits downstream before slow sibling finishes using distinct exact Git worktrees', { timeout: 20000 }, async t => {
  const slowStarted = deferred(), downstreamStarted = deferred(), releaseSlow = deferred();
  t.signal.addEventListener('abort', () => releaseSlow.resolve(), { once: true });
  const tasks = [node('A'), node('B'), node('C', ['A'])];
  let slowFinished = false;
  const fx = await fixture(t, tasks, async (id, request) => {
    assert.equal(request.cwd, path.join(fx.run.worktreeRoot, id));
    assert.notEqual(request.cwd, fx.run.cwd); assert.notEqual(request.cwd, fx.project);
    if (id === 'A') await slowStarted.promise;
    if (id === 'B') { slowStarted.resolve(); await releaseSlow.promise; slowFinished = true; }
    if (id === 'C') {
      assert.equal(slowFinished, false); assert.equal(fx.run.nodes.A.status, 'integrated');
      assert.equal(await read(path.join(request.cwd, 'A.txt')), 'A\n');
      downstreamStarted.resolve();
    }
    await writeFile(path.join(request.cwd, `${id}.txt`), `${id}\n`);
  });
  const running = fx.engine.executeTasks(fx.run);
  // The only release of B comes from C's admission, never from a speed threshold.
  const outcome = running.then(() => null, error => { downstreamStarted.reject(error); return error; });
  try { await downstreamStarted.promise; assert.equal(fx.run.nodes.B.status, 'running'); }
  finally { releaseSlow.resolve(); }
  const error = await outcome; if (error) throw error;
  for (const id of ['A', 'B', 'C']) {
    assert.equal(fx.run.nodes[id].status, 'integrated');
    assert.equal(await read(path.join(fx.run.cwd, `${id}.txt`)), `${id}\n`);
    assert.equal(fx.run.nodes[id].cwd, path.join(fx.run.worktreeRoot, id));
  }
  assert.equal(new Set(fx.sessions.map(session => session.cwd)).size, 3);
  assert.equal(fx.concurrency.maxActive, 2); assert.equal(fx.concurrency.active, 0);
  assert.deepEqual(fx.decisions, [{ id: 'A', attempt: 0 }, { id: 'B', attempt: 0 }, { id: 'C', attempt: 0 }]);
  assert.equal(git(fx.run.cwd, 'status', '--porcelain'), '');
  await fx.assertUserUnchanged();
});

test('Engine recovers completed work without routing or executing it again', async t => {
  const fx = await fixture(t, [node('saved'), node('next', ['saved'])], async (id, request) => {
    assert.equal(id, 'next'); assert.equal(await read(path.join(request.cwd, 'saved.txt')), 'saved\n');
    await writeFile(path.join(request.cwd, 'next.txt'), 'next\n');
  });
  const cwd = path.join(fx.run.worktreeRoot, 'saved'), branch = `kodo/${fx.run.id}-saved`;
  await makeWorktree(fx.project, cwd, branch, fx.base);
  await writeFile(path.join(cwd, 'saved.txt'), 'saved\n'); git(cwd, 'add', '.'); git(cwd, 'commit', '-m', 'Already completed fixture task');
  fx.run.nodes.saved = { id: 'saved', status: 'completed', attempt: 1, cwd, branch, baseSha: fx.base, headSha: git(cwd, 'rev-parse', 'HEAD') };
  fx.engine.save(fx.run); await fx.engine.executeTasks(fx.run);
  assert.deepEqual(fx.decisions, [{ id: 'next', attempt: 0 }]);
  assert.deepEqual(fx.sessions.map(session => session.id), ['next']);
  assert.equal(fx.run.nodes.saved.cwd, cwd); assert.equal(fx.run.nodes.saved.attempt, 1);
  assert.equal(await read(path.join(fx.run.cwd, 'saved.txt')), 'saved\n');
  await fx.assertUserUnchanged();
});

test('Engine retains retry routing boundaries and never starts dependents of a retrying node', async t => {
  let attempts = 0;
  const fx = await fixture(t, [node('A'), node('C', ['A'])], async (id, request) => {
    if (id === 'A' && ++attempts === 1) throw new Error('first bounded attempt failed');
    if (id === 'C') { assert.equal(attempts, 2); assert.equal(fx.run.nodes.A.status, 'integrated'); }
    await writeFile(path.join(request.cwd, `${id}.txt`), `${id}\n`);
  });
  await fx.engine.executeTasks(fx.run);
  assert.deepEqual(fx.decisions, [{ id: 'A', attempt: 0 }, { id: 'A', attempt: 1 }, { id: 'C', attempt: 0 }]);
  assert.equal(fx.run.nodes.A.attempt, 2); assert.equal(fx.run.nodes.C.status, 'integrated');
  await fx.assertUserUnchanged();
});

async function completeTask(fx, id) {
  const cwd = path.join(fx.run.worktreeRoot, id), branch = `kodo/${fx.run.id}-${id}`;
  await makeWorktree(fx.project, cwd, branch, fx.base);
  await writeFile(path.join(cwd, `${id}.txt`), `${id}\n`); git(cwd, 'add', '.'); git(cwd, 'commit', '-m', `Completed fixture ${id}`);
  fx.run.nodes[id] = { id, status: 'completed', attempt: 1, cwd, branch, baseSha: fx.base, headSha: git(cwd, 'rev-parse', 'HEAD') };
}

test('Engine recovers the recorded pending merge owner before earlier completed nodes even without MERGE_HEAD', async t => {
  const fx = await fixture(t, [node('earlier'), node('owner')], async () => { assert.fail('completed tasks must not execute'); });
  await completeTask(fx, 'earlier'); await completeTask(fx, 'owner');
  fx.run.pendingMerge = { kind: 'node', nodeId: 'owner', sha: fx.run.nodes.owner.headSha }; fx.engine.save(fx.run);
  const order = []; fx.engine.onEvent = event => { if (event.type === 'integrated') order.push(event.data.node); };
  await fx.engine.executeTasks(fx.run);
  assert.deepEqual(order, ['owner', 'earlier']); assert.deepEqual(fx.decisions, []); assert.deepEqual(fx.sessions, []);
  assert.equal(fx.run.pendingMerge, null); assert.equal(await read(path.join(fx.run.cwd, 'owner.txt')), 'owner\n');
  assert.equal(await read(path.join(fx.run.cwd, 'earlier.txt')), 'earlier\n');
  await fx.assertUserUnchanged();
});

test('Engine rejects a mismatched pending merge receipt before dispatching other completed work', async t => {
  const fx = await fixture(t, [node('saved')], async () => { assert.fail('must not execute'); });
  await completeTask(fx, 'saved');
  fx.run.pendingMerge = { kind: 'node', nodeId: 'missing', sha: fx.run.nodes.saved.headSha }; fx.engine.save(fx.run);
  await assert.rejects(fx.engine.executeTasks(fx.run), { code: 'merge_state' });
  assert.equal(fx.run.nodes.saved.status, 'completed'); assert.deepEqual(fx.decisions, []);
  assert.equal(git(fx.run.cwd, 'rev-parse', 'HEAD'), fx.base);
  await fx.assertUserUnchanged();
});

test('Engine refuses to overwrite an unresolved base merge receipt when delivery is disabled', async t => {
  const fx = await fixture(t, [node('A')], async () => { assert.fail('unresolved merge must block dispatch'); });
  fx.run.pendingMerge = { kind: 'base', sha: fx.base }; fx.engine.save(fx.run);
  await assert.rejects(fx.engine.executeTasks(fx.run), { code: 'merge_state' });
  assert.deepEqual(fx.decisions, []); assert.deepEqual(fx.sessions, []);
  assert.deepEqual(fx.run.pendingMerge, { kind: 'base', sha: fx.base });
  await fx.assertUserUnchanged();
});

test('Engine drains workers after real Git merge interruption and recovers the owning conflict before other integrations', { timeout: 25000 }, async t => {
  const slowStarted = deferred(), conflictReached = deferred(), releaseSlow = deferred();
  t.signal.addEventListener('abort', () => releaseSlow.resolve(), { once: true });
  const original = Object.assign(new Error('quota in merge resolver'), { code: 'quota' });
  let repairing = false, finished = false;
  const fx = await fixture(t, [node('A'), node('B'), node('never')], async (id, request) => {
    if (id === 'never') assert.equal(repairing, true, 'must stop admission once A merge fails');
    if (id === 'A') await slowStarted.promise;
    if (id === 'B') { slowStarted.resolve(); await releaseSlow.promise; }
    await writeFile(path.join(request.cwd, `${id}.txt`), `${id}\n`);
  });
  const providerSession = fx.engine.provider.runSession;
  fx.engine.provider.runSession = async request => {
    if (/Resolve these Git merge conflicts/.test(request.prompt)) {
      assert.equal(request.cwd, fx.run.cwd);
      if (!repairing) { conflictReached.resolve(); throw original; }
      await writeFile(path.join(request.cwd, 'A.txt'), 'incoming\nA\n');
      return { sessionId: 'resolved-owner', output: { summary: 'preserved both lines', checks: [], complete: true } };
    }
    return providerSession(request);
  };
  const integrate = fx.engine.integrateNode.bind(fx.engine); let injected = false;
  fx.engine.integrateNode = async (run, task, signal) => {
    if (task.id === 'A' && !injected) {
      // Emulate a coordinator change after A branched; workers only write in
      // their own worktrees. The production merge and recovery remain real.
      injected = true; await writeFile(path.join(run.cwd, 'A.txt'), 'incoming\n');
      git(run.cwd, 'add', '.'); git(run.cwd, 'commit', '-m', 'Incoming coordinator change');
    }
    return integrate(run, task, signal);
  };
  const running = fx.engine.executeTasks(fx.run);
  const rejection = assert.rejects(running, error => error === original).then(() => { finished = true; });
  await conflictReached.promise; await turn(); assert.equal(finished, false);
  releaseSlow.resolve(); await rejection;
  assert.equal(fx.run.nodes.A.status, 'completed'); assert.equal(fx.run.nodes.B.status, 'completed');
  assert.equal(fx.run.nodes.never, undefined);
  assert.equal(fx.run.pendingMerge.nodeId, 'A');
  assert.equal(git(fx.run.cwd, 'rev-parse', 'MERGE_HEAD'), fx.run.nodes.A.headSha);
  repairing = true;
  const order = []; fx.engine.onEvent = event => { if (event.type === 'integrated') order.push(event.data.node); };
  await fx.engine.executeTasks(fx.run);
  assert.equal(order[0], 'A'); assert.equal(fx.run.pendingMerge, null);
  assert.equal(await read(path.join(fx.run.cwd, 'A.txt')), 'incoming\nA\n');
  assert.equal(await read(path.join(fx.run.cwd, 'B.txt')), 'B\n');
  assert.equal(git(fx.run.cwd, 'status', '--porcelain'), '');
  assert.deepEqual(fx.decisions.filter(row => row.id !== 'never'), [{ id: 'A', attempt: 0 }, { id: 'B', attempt: 0 }]);
  await fx.assertUserUnchanged();
});

test('Engine resumes a saved retry in its exact recorded worktree without losing partial changes', async t => {
  let recorded;
  const fx = await fixture(t, [node('A')], async (id, request) => {
    assert.equal(id, 'A'); assert.equal(request.cwd, recorded);
    assert.equal(await read(path.join(request.cwd, 'A.txt')), 'partial saved work\n');
    await writeFile(path.join(request.cwd, 'A.txt'), 'partial saved work\nfinished\n');
  });
  recorded = path.join(fx.run.worktreeRoot, 'recorded-retry-location');
  const branch = `kodo/${fx.run.id}-recorded-retry`;
  await makeWorktree(fx.project, recorded, branch, fx.base);
  await writeFile(path.join(recorded, 'A.txt'), 'partial saved work\n');
  fx.run.nodes.A = { id: 'A', status: 'retrying', attempt: 1, cwd: recorded, branch, baseSha: fx.base, error: 'interrupted bounded retry' };
  fx.engine.save(fx.run); await fx.engine.executeTasks(fx.run);
  assert.equal(fx.run.nodes.A.cwd, recorded); assert.equal(fx.run.nodes.A.branch, branch);
  assert.equal(fx.run.nodes.A.attempt, 2); assert.equal(fx.run.nodes.A.status, 'integrated');
  assert.deepEqual(fx.decisions, [{ id: 'A', attempt: 1 }]);
  assert.equal(await read(path.join(fx.run.cwd, 'A.txt')), 'partial saved work\nfinished\n');
  await fx.assertUserUnchanged();
});

test('Engine observes persisted cancellation after routing before executing admitted work', async t => {
  const fx = await fixture(t, [node('A')], async () => { assert.fail('cancelled task must not execute'); });
  const route = fx.engine.route.bind(fx.engine);
  fx.engine.route = async (...args) => {
    const selected = await route(...args);
    fx.store.updateRun(fx.run.id, { cancelRequested: true }); return selected;
  };
  await assert.rejects(fx.engine.executeTasks(fx.run), { code: 'cancelled' });
  assert.equal(fx.sessions.length, 0); assert.deepEqual(fx.decisions, [{ id: 'A', attempt: 0 }]);
  assert.equal(git(fx.run.cwd, 'rev-parse', 'HEAD'), fx.base);
  await fx.assertUserUnchanged();
});

test('Engine preserves completed work on persisted cancellation and resumes integration without another session', async t => {
  const fx = await fixture(t, [node('A')], async (id, request) => { await writeFile(path.join(request.cwd, `${id}.txt`), `${id}\n`); });
  const perform = fx.engine.performNode.bind(fx.engine);
  fx.engine.performNode = async (...args) => {
    await perform(...args); fx.store.updateRun(fx.run.id, { cancelRequested: true });
  };
  await assert.rejects(fx.engine.executeTasks(fx.run), { code: 'cancelled' });
  assert.equal(fx.run.nodes.A.status, 'completed'); assert.equal(git(fx.run.cwd, 'rev-parse', 'HEAD'), fx.base);
  const cwd = fx.run.nodes.A.cwd; fx.store.updateRun(fx.run.id, { cancelRequested: false });
  await fx.engine.executeTasks(fx.run);
  assert.equal(fx.run.nodes.A.cwd, cwd); assert.equal(fx.run.nodes.A.status, 'integrated');
  assert.equal(fx.sessions.length, 1); assert.equal(fx.decisions.length, 1);
  assert.equal(await read(path.join(fx.run.cwd, 'A.txt')), 'A\n');
  await fx.assertUserUnchanged();
});

test('Engine honors both plan and Jev serial decisions until prior integration is finished', async t => {
  const tasks = [node('planSerial'), node('routeSerial'), node('follower')]; tasks[0].parallel = false;
  const fx = await fixture(t, tasks, async (id, request) => {
    if (id === 'routeSerial') assert.equal(fx.run.nodes.planSerial.status, 'integrated');
    if (id === 'follower') assert.equal(fx.run.nodes.routeSerial.status, 'integrated');
    await writeFile(path.join(request.cwd, `${id}.txt`), `${id}\n`);
  });
  const decide = fx.engine.provider.decideJev;
  fx.engine.provider.decideJev = async request => ({ ...await decide(request), parallel: request.node.id !== 'routeSerial' });
  await fx.engine.executeTasks(fx.run);
  assert.equal(fx.concurrency.maxActive, 1);
  assert.deepEqual(fx.decisions, [{ id: 'planSerial', attempt: 0 }, { id: 'routeSerial', attempt: 0 }, { id: 'follower', attempt: 0 }]);
  await fx.assertUserUnchanged();
});

test('Engine retains the global subscription capacity across two continuously scheduled runs', { timeout: 20000 }, async t => {
  const twoStarted = deferred(), release = deferred(); let started = 0;
  t.signal.addEventListener('abort', () => release.resolve(), { once: true });
  const fx = await fixture(t, [node('A'), node('B')], async (id, request) => {
    assert.ok(fx.concurrency.active <= 2, 'shared subscription leases must cap both runs together');
    if (++started === 2) twoStarted.resolve();
    await release.promise;
    await writeFile(path.join(request.cwd, `${id}.txt`), `${id}\n`);
  });
  const other = await fx.engine.create('Second continuous scheduling fixture', { project: fx.project });
  await makeWorktree(fx.project, other.cwd, other.branch, fx.base);
  other.executionMode = { selected: 'standard' }; other.models = fx.run.models;
  other.plan = { summary: 'Second scoped run', tasks: [node('C'), node('D')] }; fx.engine.save(other);
  const running = [fx.engine.executeTasks(fx.run), fx.engine.executeTasks(other)];
  // Attach rejection handlers immediately, and drain both runs on a test error.
  const results = Promise.allSettled(running);
  try { await twoStarted.promise; assert.equal(fx.concurrency.active, 2); }
  finally { release.resolve(); }
  for (const result of await results) if (result.status === 'rejected') throw result.reason;
  assert.equal(started, 4); assert.equal(fx.concurrency.maxActive, 2); assert.equal(fx.concurrency.active, 0);
  for (const run of [fx.run, other]) for (const task of run.plan.tasks) {
    assert.equal(run.nodes[task.id].status, 'integrated');
    assert.equal(run.nodes[task.id].cwd, path.join(run.worktreeRoot, task.id));
  }
  await fx.assertUserUnchanged();
});
