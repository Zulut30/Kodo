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

// Light ports for the queue's own behaviour: task-fast passes on the worktree head, and the
// integration is a real Git merge into the integration branch without evidence or transitions.
function lightPorts(f) {
  f.ports.verifyTaskFast = async ({ engine, run }) => {
    const stored = engine.store.getRun(typeof run === 'string' ? run : run.id);
    const headSha = git(stored.cwd, 'rev-parse', 'HEAD');
    engine.store.updateRun(stored.id, { headSha });
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
  // Hold the integration lease until all ten are verified and queued, so one drain sees them all.
  const holder = f.store.acquireLease(`project-integration:${f.projectId}`, 'test', { ttlMs: 600000 });
  const machine = { id: 'local', maxHeavyBuilds: 4 };
  const pending = briefs.map(brief =>
    f.complete(brief, heads.get(brief.taskId), { machine, priority: priority[brief.taskId] }),
  );
  const { openIntegrationQueue } = await import('../runtime/project-integration-queue.mjs');
  const queue = openIntegrationQueue(f.store);
  while (queue.list(f.projectId).filter(row => row.status === 'queued').length < 10) await delay(20);
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

// The private worktree of the integration branch (where Kodo merges).
const integrationWorktree = f => {
  const list = git(f.root, 'worktree', 'list', '--porcelain').split(/\r?\n\r?\n/);
  const block = list.find(item => item.includes(`branch refs/heads/kodo/project/${f.projectId}`));
  return block.split(/\r?\n/)[0].slice('worktree '.length);
};

test('A merge conflict refuses only its own task and leaves the integration branch intact', async t => {
  const f = await fixture(t, { count: 3 });
  const briefs = await f.briefs();
  // A repair on the integration branch changed t1 after its worktree was made.
  const worktree = integrationWorktree(f);
  await commit(worktree, { 'src/t1.mjs': 'export const t1 = 7;\n' }, 'Repair t1 on the integration branch');
  const repaired = f.integrationHead();
  const results = await Promise.all(
    [...briefs.values()].map(async brief =>
      f.complete(brief, await f.change(brief, 3), { machine: { id: 'local', maxHeavyBuilds: 3 } }),
    ),
  );
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
  for (const brief of briefs.values())
    void f
      .complete(brief, heads.get(brief.taskId), {
        machine: { id: 'local', maxHeavyBuilds: 3 },
        priority: priority[brief.taskId],
      })
      .catch(() => {});
  const { openIntegrationQueue } = await import('../runtime/project-integration-queue.mjs');
  const queue = openIntegrationQueue(f.store);
  while (queue.list(f.projectId).filter(row => row.status === 'queued').length < 3) await delay(20);
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
