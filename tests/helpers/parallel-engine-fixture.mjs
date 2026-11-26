import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Store } from '../../runtime/store.mjs';
import { Engine } from '../../runtime/engine.mjs';
import * as contracts from '../../runtime/project-contracts.mjs';
import { openProjectStore } from '../../runtime/project-store.mjs';
import { completeTask, nextWave } from '../../runtime/project-external.mjs';
import { createProjectTransitionAuthorizer } from '../../runtime/project-director.mjs';
import * as waves from '../../runtime/project-director-waves.mjs';
import { ensureIntegration, mergeTask } from '../../runtime/project-integration.mjs';

export function git(cwd, ...args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true });
  assert.equal(result.status, 0, `${args.join(' ')}\n${result.stderr}`);
  return result.stdout.trim();
}
export const write = async (cwd, name, text) => {
  await mkdir(path.dirname(path.join(cwd, name)), { recursive: true });
  await writeFile(path.join(cwd, name), text);
};
export const commit = async (cwd, files, message = 'Worker change') => {
  for (const [name, text] of Object.entries(files)) await write(cwd, name, text);
  git(cwd, 'add', '-A');
  git(cwd, 'commit', '-m', message);
  return git(cwd, 'rev-parse', 'HEAD');
};
export const testFile = name =>
  `import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { ${name} } from '../src/${name}.mjs';\ntest('${name} is positive', () => assert.ok(${name} > 0));\n`;
export const criterion = { id: 'works', text: 'Observable behaviour works', evidenceKinds: ['checks'] };
export const taskSpec = (id, extra = {}) => ({
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
export async function fixture(t, { count = 2, projectFields = () => ({}) } = {}) {
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
        ...projectFields(root, home),
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

// Lease names of machine-build requests made while `work` runs.
export async function buildLeases(f, work) {
  const requested = [];
  const acquire = f.store.acquireLease.bind(f.store);
  f.store.acquireLease = (name, owner, options) => {
    if (name.startsWith('machine-build:')) requested.push([name, options?.limit]);
    return acquire(name, owner, options);
  };
  try {
    await work();
  } finally {
    f.store.acquireLease = acquire;
  }
  return requested;
}

export async function remoteFixture(t, projectFields) {
  const f = await fixture(t, { count: 1, projectFields });
  const bare = path.join(f.temp, 'transport.git');
  const clone = path.join(f.temp, 'remote');
  git(f.temp, 'init', '--bare', bare);
  git(f.root, 'remote', 'add', 'origin', bare);
  const machine = { id: 'remote', kind: 'ssh', maxWorkers: 1, maxHeavyBuilds: 1 };
  const profile = {
    subscriptions: [{ id: 'pool', slots: 1, provider: 'codex', model: 'gpt', tier: 'fast' }],
    machines: [machine],
  };
  f.repo.setProfile(f.projectId, profile);
  const pull = () => nextWave(f.ctx, { projectId: f.projectId, host: 't3', ports: f.ports });
  const checkout = brief => {
    git(f.temp, 'clone', bare, clone);
    git(clone, 'config', 'user.name', 'Remote');
    git(clone, 'config', 'user.email', 'remote@example.invalid');
    git(clone, 'fetch', 'origin', brief.baseRef);
    git(clone, 'checkout', '-b', brief.branch, 'FETCH_HEAD');
  };
  return { ...f, bare, clone, pull, checkout, profile, machine };
}

export function assertNoLocalPath(brief, paths) {
  const bytes = JSON.stringify(brief);
  for (let value of paths) {
    for (let depth = 0; depth <= 2; depth++) {
      assert.ok(!bytes.includes(value), 'private path in serialized brief');
      value = JSON.stringify(value).slice(1, -1);
    }
  }
}

// A "dead" process: its promise settles only when the test ends (with an error that its caller
// swallows), never while the test runs; no promise is left pending forever.
export function frozen(t) {
  return new Promise((resolve, reject) =>
    t.after(() => reject(Object.assign(new Error('The process died'), { code: 'injected_crash' }))),
  );
}

// Wait for `condition` (polled every 20 ms) with a deadline of its own: a broken build fails here.
export async function until(condition, label, ms = 120000) {
  const deadline = Date.now() + ms;
  while (!(await condition())) {
    assert.ok(Date.now() < deadline, `timed out waiting for ${label}`);
    await delay(20);
  }
}

export const queueOf = async f => {
  const { openIntegrationQueue } = await import('../../runtime/project-integration-queue.mjs');
  return openIntegrationQueue(f.store);
};
export const queued = (queue, f) => queue.list(f.projectId).filter(row => row.status === 'queued').length;

// Light ports for the queue's own behaviour: task-fast passes on the worktree head, and the
// integration is a real Git merge into the integration branch without evidence or transitions.
export function lightPorts(f) {
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

// The private worktree of the integration branch (where Kodo merges).
export function integrationWorktree(f) {
  const list = git(f.root, 'worktree', 'list', '--porcelain').split(/\r?\n\r?\n/);
  const block = list.find(item => item.includes(`branch refs/heads/kodo/project/${f.projectId}`));
  return block.split(/\r?\n/)[0].slice('worktree '.length);
}
