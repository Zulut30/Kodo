// Stage 15B: asynchronous task verification, the integration queue and parallel epic gates.
// Every wait here is driven by events (barriers, lease refusals), never by wall-clock sleeps.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Store } from '../runtime/store.mjs';
import { Engine } from '../runtime/engine.mjs';
import * as contracts from '../runtime/project-contracts.mjs';
import { openProjectStore } from '../runtime/project-store.mjs';
import { completeTask, nextWave } from '../runtime/project-external.mjs';
import { createProjectTransitionAuthorizer } from '../runtime/project-director.mjs';
import * as waves from '../runtime/project-director-waves.mjs';
import { verifyTaskFastOnce } from '../runtime/wave-verifier.mjs';
import { ensureIntegration, mergeTask } from '../runtime/project-integration.mjs';

function git(cwd, ...args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true });
  assert.equal(result.status, 0, `${args.join(' ')}\n${result.stderr}`);
  return result.stdout.trim();
}
const write = async (cwd, name, text) => {
  await mkdir(path.dirname(path.join(cwd, name)), { recursive: true });
  await writeFile(path.join(cwd, name), text);
};
const commit = async (cwd, files, message = 'Worker change') => {
  for (const [name, text] of Object.entries(files)) await write(cwd, name, text);
  git(cwd, 'add', '-A');
  git(cwd, 'commit', '-m', message);
  return git(cwd, 'rev-parse', 'HEAD');
};
const testFile = name =>
  `import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { ${name} } from '../src/${name}.mjs';\ntest('${name} is positive', () => assert.ok(${name} > 0));\n`;
const criterion = { id: 'works', text: 'Observable behaviour works', evidenceKinds: ['checks'] };
const taskSpec = (id, extra = {}) => ({
  id,
  epicId: 'e',
  title: 'Task ' + id,
  description: 'Implement ' + id,
  owner: 'developer',
  dependsOn: [],
  writePaths: [`src/${id}.mjs`, `tests/${id}.test.mjs`],
  acceptance: [criterion],
  interfaceRefs: [],
  priority: 50,
  userValue: 3,
  risk: 1,
  estimatedEffort: 1,
  riskApprovalRequired: false,
  ...extra,
});

// A wave project of `count` independent tasks t0..t<count-1>, each owning src/tN.mjs and its test.
// The production director ports integrate (real merges, evidence and authorized transitions);
// gates are a recording stub unless a test replaces them.
async function fixture(t, { count = 2 } = {}) {
  const temp = await realpath(await mkdtemp(path.join(os.tmpdir(), 'kodo-parallel-')));
  const stores = [];
  t.after(async () => {
    for (const store of stores) store.close();
    await rm(temp, { recursive: true, force: true });
  });
  const root = path.join(temp, 'project');
  await mkdir(root, { recursive: true });
  const config = {
    schemaVersion: 1,
    repository: 'fixture/Kodo',
    client: 'codex',
    baseBranch: 'main',
    concurrency: 1,
    repairRounds: 3,
    researchBudget: 0,
    commands: { test: [{ command: process.execPath, args: ['--test'] }], build: [], deploy: [], smoke: [] },
    checks: [],
    delivery: { enabled: false, release: false, firstVersion: '0.2.0' },
  };
  const ids = Array.from({ length: count }, (_, index) => `t${index}`);
  await write(root, '.gitattributes', '* text=auto eol=lf\n');
  await write(root, 'kodo.config.json', JSON.stringify(config, null, 2));
  for (const id of ids) {
    await write(root, `src/${id}.mjs`, `export const ${id} = 1;\n`);
    await write(root, `tests/${id}.test.mjs`, testFile(id));
  }
  git(root, 'init', '-b', 'main');
  git(root, 'config', 'user.name', 'Kodo Parallel Test');
  git(root, 'config', 'user.email', 'kodo-parallel@example.invalid');
  git(root, 'config', 'core.autocrlf', 'false');
  git(root, 'add', '.');
  git(root, 'commit', '-m', 'Fixture baseline');
  const home = path.join(temp, 'state');
  const store = new Store(home);
  stores.push(store);
  const engine = new Engine({ store });
  const repo = await openProjectStore({
    store,
    contracts,
    authorizeTransition: createProjectTransitionAuthorizer({ store, engine, contracts }),
  });
  const created = await repo.apply({
    schemaVersion: 1,
    commandId: randomUUID(),
    projectId: null,
    expectedRevision: null,
    actor: 'test',
    reason: 'Create the parallel fixture',
    action: {
      op: 'create',
      spec: {
        schemaVersion: 1,
        id: 'parallel',
        root,
        title: 'Parallel sample',
        definitionOfDone: [criterion],
        constraints: ['Only assigned work'],
        businessContext: 'Owned fixture',
        architectureRefs: [],
        execution: { cadence: 'wave', integration: 'branch' },
        milestones: [{ id: 'm', title: 'Milestone', acceptance: [criterion], releaseRequired: false }],
        epics: [{ id: 'e', milestoneId: 'm', title: 'Epic', acceptance: [criterion] }],
        tasks: ids.map(id => taskSpec(id)),
      },
    },
  });
  const f = { temp, root, home, store, engine, repo, projectId: created.projectId, ids };
  f.calls = { integrate: [], verify: [] };
  f.ports = {
    selectWave: waves.selectWave,
    createWaveContext: waves.createWaveContext,
    integrateAndAdvance: async (waveCtx, input) => {
      f.calls.integrate.push(input.taskId);
      return waves.integrateAndAdvance(waveCtx, input);
    },
    runPendingGates: async () => ({ gates: [], accepted: [], blocked: [] }),
  };
  f.ctx = { repo, engine, store, contracts };
  f.snapshot = () => repo.snapshot(f.projectId);
  f.integrationHead = () => git(root, 'rev-parse', `refs/heads/kodo/project/${f.projectId}`);
  // Briefs for every task: one host holds at most five in flight (next-wave's limit), so a
  // second pull host takes the rest.
  f.briefs = async () => {
    const briefs = new Map();
    for (const host of ['t3', 'orca']) {
      if (briefs.size >= count) break;
      const result = await nextWave(f.ctx, { projectId: f.projectId, host, ports: f.ports, limit: 5 });
      for (const brief of result.briefs) briefs.set(brief.taskId, brief);
    }
    assert.equal(briefs.size, count);
    return briefs;
  };
  f.change = (brief, value = 2) =>
    commit(brief.worktree, { [`src/${brief.taskId}.mjs`]: `export const ${brief.taskId} = ${value};\n` });
  f.complete = (brief, head, input = {}) =>
    completeTask(f.ctx, {
      projectId: f.projectId,
      taskId: brief.taskId,
      head,
      attemptId: brief.attemptId,
      deferGate: true,
      ports: f.ports,
      ...input,
    });
  // The merge commits of the integration branch per task (subject `Kodo: integrate <taskId>`).
  f.merges = () =>
    git(root, 'log', '--merges', '--format=%s', `refs/heads/kodo/project/${f.projectId}`).split('\n').filter(Boolean);
  return f;
}

// A barrier that opens once `parties` callers arrived; a failsafe opens it late so a serial
// implementation fails its assertion instead of hanging (only reached by a failing build).
function barrier(parties, failsafeMs = 4000) {
  let open;
  const opened = new Promise(resolve => (open = resolve));
  const timer = setTimeout(() => open(false), failsafeMs);
  timer.unref();
  let arrived = 0;
  return async () => {
    if (++arrived === parties) {
      clearTimeout(timer);
      open(true);
    }
    return opened;
  };
}

test('Two completions verify task-fast at the same time with two build slots', async t => {
  const f = await fixture(t, { count: 2 });
  const briefs = await f.briefs();
  const together = barrier(2);
  const overlapped = [];
  f.ports.verifyTaskFast = async input => {
    overlapped.push(await together());
    return verifyTaskFastOnce(input);
  };
  const machine = { id: 'local', maxHeavyBuilds: 2 };
  const results = await Promise.all(
    [...briefs.values()].map(async brief => f.complete(brief, await f.change(brief), { machine })),
  );
  assert.deepEqual(
    results.map(row => row.status),
    ['integrated', 'integrated'],
    JSON.stringify(results),
  );
  assert.deepEqual(overlapped, [true, true], 'both task-fast runs were in progress at once');
  assert.equal(f.merges().length, 2);
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

// Wait for `condition` (polled every 20 ms) with a deadline of its own: a broken build fails here.
async function until(condition, label, ms = 120000) {
  const deadline = Date.now() + ms;
  while (!(await condition())) {
    assert.ok(Date.now() < deadline, `timed out waiting for ${label}`);
    await delay(20);
  }
}

const queueOf = async f => {
  const { openIntegrationQueue } = await import('../runtime/project-integration-queue.mjs');
  return openIntegrationQueue(f.store);
};
const queued = (queue, f) => queue.list(f.projectId).filter(row => row.status === 'queued').length;

// Light ports for the queue's own behaviour: task-fast passes on the worktree head, and the
// integration is a real Git merge into the integration branch without evidence or transitions.
function lightPorts(f) {
  f.ports.verifyTaskFast = async ({ engine, run }) => {
    const stored = engine.store.getRun(typeof run === 'string' ? run : run.id);
    const headSha = git(stored.cwd, 'rev-parse', 'HEAD');
    f.calls.verify.push(stored.id);
    engine.store.updateRun(stored.id, { headSha, checks: { profile: 'task-fast', headSha, complete: true } });
    return { passed: true, headSha };
  };
  f.ports.integrateAndAdvance = async (waveCtx, { projectId, taskId, run }) => {
    f.calls.integrate.push(taskId);
    const snapshot = await f.snapshot();
    const { worktree } = await ensureIntegration({
      root: f.root,
      projectId,
      worktreeHome: await waves.integrationHome(f.store),
    });
    const merged = await mergeTask({
      worktree,
      taskId,
      taskHead: run.headSha,
      writePaths: snapshot.tasks.find(row => row.id === taskId).writePaths,
      savePending: () => {},
    });
    f.store.updateRun(run.id, { integration: { ...merged, status: 'merged' } });
    return { status: 'integrated', mergeCommit: merged.mergeCommit, revision: snapshot.revision };
  };
}

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
  f.ports.verifyTaskFast = async input => {
    await Promise.race([waiting, delay(3000)]);
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
  const second = await f.complete(briefs[1], await f.change(briefs[1]), { deferGate: false });
  assert.deepEqual([second.status, second.code], ['blocked', 'project_control_blocked']);
  assert.equal(f.store.getRun(briefs[1].runId).externalCompletion.gates, null, 'a repeat may run them');
});

// The private worktree of the integration branch (where Kodo merges).
function integrationWorktree(f) {
  const list = git(f.root, 'worktree', 'list', '--porcelain').split(/\r?\n\r?\n/);
  const block = list.find(item => item.includes(`branch refs/heads/kodo/project/${f.projectId}`));
  return block.split(/\r?\n/)[0].slice('worktree '.length);
}

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
  assert.deepEqual([byTask.t1.status, byTask.t1.code], ['blocked', 'project_integration_conflict']);
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
      await new Promise(() => {});
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
