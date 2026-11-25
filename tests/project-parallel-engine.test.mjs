// Stage 15B: asynchronous task verification, the integration queue and parallel epic gates.
// Every wait here is driven by events (barriers, lease refusals), never by wall-clock sleeps.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { tracingChannel } from 'node:diagnostics_channel';
import { projectSectionHeld } from '../runtime/project-controller-lease.mjs';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Store } from '../runtime/store.mjs';
import { Engine } from '../runtime/engine.mjs';
import * as contracts from '../runtime/project-contracts.mjs';
import { openProjectStore } from '../runtime/project-store.mjs';
import { completeTask, nextWave, runProjectGates } from '../runtime/project-external.mjs';
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
async function fixture(t, { count = 2, projectFields = () => ({}) } = {}) {
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

// Lease names of machine-build requests made while `work` runs.
async function buildLeases(f, work) {
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

async function remoteFixture(t, projectFields) {
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

function assertNoLocalPath(brief, paths) {
  const bytes = JSON.stringify(brief);
  for (let value of paths) {
    for (let depth = 0; depth <= 2; depth++) {
      assert.ok(!bytes.includes(value), 'private path in serialized brief');
      value = JSON.stringify(value).slice(1, -1);
    }
  }
}

test('round4 T1 long TypeError stays actionable before trimming on replay and retry', async t => {
  const f = await remoteFixture(t);
  const [brief] = (await f.pull()).briefs;
  f.checkout(brief);
  const head = await commit(f.clone, {
    'src/t0.mjs':
      "export const t0 = { valueOf() { throw new TypeError('detail '.repeat(31) + '(' + import.meta.url + ')'); } };\n",
  });
  git(f.clone, 'push', 'origin', 'HEAD:' + brief.workRef);
  assert.equal((await f.complete(brief, head)).status, 'checks_failed');
  const failed = f.store.getRun(brief.runId);
  assert.ok(failed.lastDiagnostics.items.some(item => item.message.includes('detail (src/t0.mjs)')));
  // Simulate a pack persisted by an older Kodo which cut through this Run's directory name.
  const legacy = structuredClone(failed.lastDiagnostics);
  const partial = failed.cwd.slice(0, failed.cwd.indexOf(failed.id) + 8);
  legacy.items.push({ ...legacy.items[0], message: 'older stack (' + partial + '\u2026)' });
  f.store.updateRun(brief.runId, { lastDiagnostics: legacy });
  const check = pull => {
    assert.equal(pull.briefs.length, 1, JSON.stringify(pull.blocked));
    const [row] = pull.briefs;
    assert.ok(row.prompt.includes('older stack (<local-path>)'));
    assert.match(row.prompt, /detail \(src\/t0\.mjs\)/);
    assert.ok(row.diagnostics.items.some(item => item.message.includes('detail (src/t0.mjs)')));
    assertNoLocalPath(row, [f.store.getRun(brief.runId).cwd, f.home, os.homedir()]);
    return row;
  };
  check(await f.pull());
  assert.equal((await f.complete(brief, head, { abandon: true, deferGate: false })).status, 'abandoned');
  assert.notEqual(
    check(await nextWave(f.ctx, { projectId: f.projectId, host: 't3', ports: f.ports, retryFailed: true })).attemptId,
    brief.attemptId,
  );
});

test('round4 T1 masks stored local paths and truncated checkout prefixes in diagnostics only', async () => {
  const { portableDiagnostics, assertRemoteBriefPaths } = await import('../runtime/remote-brief-paths.mjs');
  const cwd = 'C:/Users/worker/state-worktrees/31f76caf-3333/integration';
  const roots = ['C:/Users/worker', 'D:/private/state'];
  const pack = {
    items: [
      {
        message: 'at (file:///c:/Users/worker/state-worktrees/31f76caf-33\u2026)',
        file: 'D:/private/state/errors/log',
      },
      { message: 'before home (file:///C:/Us\u2026)', file: cwd + '/src/ok.mjs' },
    ],
  };
  const result = portableDiagnostics(pack, [cwd], 'win32', roots);
  assert.deepEqual(result.items, [
    { message: 'at (<local-path>)', file: '<local-path>' },
    { message: 'before home (<local-path>)', file: 'src/ok.mjs' },
  ]);
  assert.throws(
    () => assertRemoteBriefPaths({ prompt: 'outside diagnostics: D:/private/state/errors/log' }, roots, 'win32'),
    { code: 'project_brief_path_leak' },
  );
});

test('round4 T2 recognizes decorated local paths and skips short roots and relative paths', async () => {
  const { assertRemoteBriefPaths } = await import('../runtime/remote-brief-paths.mjs');
  const roots = ['/home/worker', '/'];
  for (const text of [
    '**/home/worker/state**',
    '\x1b[31m/home/worker/state\x1b[0m',
    'x|/home/worker/state',
    'x>/home/worker/state',
    'x@/home/worker/state',
  ])
    assert.throws(() => assertRemoteBriefPaths({ prompt: text }, roots, 'linux'), { code: 'project_brief_path_leak' });
  assert.throws(
    () => assertRemoteBriefPaths({ prompt: '\u00abC:\\Users\\worker\\state\u00bb' }, ['C:\\Users\\worker'], 'win32'),
    { code: 'project_brief_path_leak' },
  );
  assert.doesNotThrow(() =>
    assertRemoteBriefPaths(
      { prompt: 'root /; app/root.tsx; src/home/worker/file; https://site/home/worker/file' },
      roots,
      'linux',
    ),
  );
  assert.doesNotThrow(() => assertRemoteBriefPaths({ prompt: 'volume C:\\' }, ['C:\\'], 'win32'));
});

test('round3 N1 remote pull and retry receive portable task-fast diagnostics from the failing worktree', async t => {
  const f = await remoteFixture(t);
  const [brief] = (await f.pull()).briefs;
  f.checkout(brief);
  const head = await commit(f.clone, {
    'src/t0.mjs': 'export const t0 = { valueOf() { throw new TypeError(import.meta.url); } };\n',
  });
  git(f.clone, 'push', 'origin', 'HEAD:' + brief.workRef);
  assert.equal((await f.complete(brief, head)).status, 'checks_failed');
  const failed = f.store.getRun(brief.runId);
  assert.match(JSON.stringify(failed.lastDiagnostics), /src\/t0\.mjs/);
  const check = pull => {
    assert.equal(pull.briefs.length, 1, JSON.stringify(pull.blocked));
    const [row] = pull.briefs;
    assert.match(JSON.stringify(row.diagnostics), /src\/t0\.mjs/);
    assert.match(row.prompt, /src\/t0\.mjs/);
    assertNoLocalPath(row, [failed.cwd, f.home, f.root]);
    assert.ok(!JSON.stringify(row.diagnostics).includes(failed.id));
    return row;
  };
  assert.equal(check(await f.pull()).attemptId, brief.attemptId);
  assert.equal((await f.complete(brief, head, { abandon: true, deferGate: false })).status, 'abandoned');
  const retry = check(await nextWave(f.ctx, { projectId: f.projectId, host: 't3', ports: f.ports, retryFailed: true }));
  assert.notEqual(retry.attemptId, brief.attemptId);
  assert.deepEqual(f.store.getRun(brief.runId).lastDiagnostics, failed.lastDiagnostics);
});

test('round3 N1 maps drive paths and file URLs from both known worktrees', async () => {
  const { portableDiagnostics } = await import('../runtime/remote-brief-paths.mjs');
  const roots = ['C:\\Kodo Work\\attempt\\integration', 'D:\\Kodo Work\\project-integration'];
  const pack = {
    items: [
      {
        file: 'c:/Kodo Work\\attempt/integration\\src\\t0.mjs',
        message: 'at (file:///c:/Kodo%20Work/attempt/integration/src/t0.mjs:5:2)',
      },
      {
        file: '/d:/Kodo%20Work/project-integration/lib/check.mjs',
        message: 'location=D:\\Kodo Work/project-integration\\lib\\check.mjs',
      },
      { file: 'C:\\Kodo Work\\attempt\\integration-other\\module.mjs', message: 'Unrelated worktree' },
    ],
    bytes: 0,
  };
  const result = portableDiagnostics(pack, roots, 'win32');
  assert.deepEqual(result.items, [
    { file: 'src/t0.mjs', message: 'at (src/t0.mjs:5:2)' },
    { file: 'lib/check.mjs', message: 'location=lib/check.mjs' },
    pack.items[2],
  ]);
  assert.equal(result.bytes, Buffer.byteLength(JSON.stringify(result)));
});

test('round3 N2 POSIX guard accepts relative paths and URLs and refuses an absolute state path', async () => {
  const { assertRemoteBriefPaths } = await import('../runtime/remote-brief-paths.mjs');
  const brief = {
    writePaths: ['app/root.tsx', 'src/app/page.tsx'],
    prompt: 'See https://example.test/apple/ and app/readme.md',
  };
  for (const home of ['/root', '/']) {
    const roots = ['/app', '/srv/kodo/state', home];
    assert.doesNotThrow(() => assertRemoteBriefPaths(brief, roots, 'linux'));
    for (const value of [
      '/srv/kodo/state',
      'at (/srv/kodo/state/file)',
      'location=file:///srv/kodo/state/file',
      'path:/srv/kodo/state/file',
    ]) {
      assert.throws(() => assertRemoteBriefPaths({ ...brief, prompt: value }, roots, 'linux'), {
        code: 'project_brief_path_leak',
      });
    }
  }
});

test('round3 abandon returns its recorded verdict when the verifier holds its lease', async t => {
  const f = await remoteFixture(t);
  const [brief] = (await f.pull()).briefs;
  const name = 'project-verify:' + brief.runId;
  const held = f.store.acquireLease(name, 'held-by-verifier');
  const acquire = f.store.acquireLease.bind(f.store);
  let tries = 0;
  f.store.acquireLease = (key, owner, options) => {
    if (key === name && ++tries > 1) throw new Error('cleanup waited for the verifier after recording abandon');
    return acquire(key, owner, options);
  };
  try {
    assert.equal((await f.complete(brief, brief.baseSha, { abandon: true, deferGate: false })).status, 'abandoned');
    assert.equal(tries, 1);
  } finally {
    f.store.releaseLease(held);
  }
});

test('round3 GC lists project refs once per remote and preserves live attempts', async t => {
  const f = await remoteFixture(t);
  const [first] = (await f.pull()).briefs;
  const retry = async () =>
    (await nextWave(f.ctx, { projectId: f.projectId, host: 't3', ports: f.ports, retryFailed: true })).briefs[0];
  const abandon = brief => f.complete(brief, brief.baseSha, { abandon: true, deferGate: false });
  await abandon(first);
  const second = await retry();
  await abandon(second);
  const live = await retry();
  for (const brief of [first, second]) git(f.bare, 'update-ref', brief.workRef, brief.baseSha);
  const requests = [];
  const channel = tracingChannel('child_process.spawn').start;
  const observe = ({ options }) => {
    if (options.args.includes('ls-remote')) requests.push(options.args.slice(options.args.indexOf('ls-remote')));
  };
  channel.subscribe(observe);
  try {
    const { gcProjectWorktrees } = await import('../runtime/project-worktree-gc.mjs');
    await gcProjectWorktrees(f.store, await f.snapshot());
  } finally {
    channel.unsubscribe(observe);
  }
  assert.deepEqual(requests, [['ls-remote', '--refs', 'origin', 'refs/kodo/' + f.projectId + '/*']]);
  assert.equal(git(f.bare, 'for-each-ref', '--format=%(refname)', 'refs/kodo'), live.baseRef);
});

test('round2 R1 R2 architecture references use relative paths and digests even in nested JSON', async t => {
  const f = await remoteFixture(t, (root, home) => ({
    architectureRefs: [root, home].map((dir, i) => ({
      path: path.join(dir, 'architecture.md'),
      sha256: String(i + 1).repeat(64),
      kind: 'contract',
      headSha: null,
      runId: null,
    })),
  }));
  const {
    briefs: [brief],
  } = await f.pull();
  assertNoLocalPath(brief, [f.root, f.home, os.homedir()]);
  assert.match(brief.prompt, /"path":"architecture.md"/);
  assert.ok(brief.prompt.includes('sha256:' + '2'.repeat(64)));
});

test('round2 R1 refuses private paths embedded in free text', async t => {
  const f = await remoteFixture(t, (_root, home) => ({ businessContext: 'Read notes at ' + path.join(home, 'notes') }));
  const pull = await f.pull();
  assert.equal(pull.blocked[0]?.code, 'project_brief_path_leak');
  assert.equal(pull.briefs.length, 0);
});

test('round2 R3 replaces only a rejected remote head after amend', async t => {
  const f = await remoteFixture(t);
  const [brief] = (await f.pull()).briefs;
  f.checkout(brief);
  const bad = await f.change({ ...brief, worktree: f.clone }, -1);
  git(f.clone, 'push', 'origin', 'HEAD:' + brief.workRef);
  assert.equal((await f.complete(brief, bad)).status, 'checks_failed');
  await write(f.clone, 'src/t0.mjs', 'export const t0 = 2;\n');
  git(f.clone, 'commit', '-am', 'Fixed', '--amend');
  git(f.clone, 'push', 'origin', '+HEAD:' + brief.workRef);
  assert.equal((await f.complete(brief, git(f.clone, 'rev-parse', 'HEAD'))).status, 'integrated');
  assert.equal((await f.complete(brief, bad)).code, 'project_submission_locked');
});

test('round2 R4 requires attempt and successful command exit codes', async t => {
  const f = await remoteFixture(t);
  f.machine.trustedBuilds = true;
  f.repo.setProfile(f.projectId, f.profile);
  const [brief] = (await f.pull()).briefs;
  f.checkout(brief);
  const head = await f.change({ ...brief, worktree: f.clone });
  git(f.clone, 'push', 'origin', 'HEAD:' + brief.workRef);
  const receipt = path.join(f.temp, 'receipt.json');
  await f.complete(brief, head, { receipt });
  const { receiptBinding } = await import('../runtime/remote-task-receipt.mjs');
  const proof = await receiptBinding(f.store.getRun(brief.runId), head);
  assert.equal(proof.attemptId, brief.attemptId);
  assert.ok(proof.commands.every(row => row.exitCode === 0));
  for (const patch of [
    { attemptId: randomUUID() },
    { commands: proof.commands.map(row => ({ ...row, exitCode: 1 })) },
  ]) {
    await writeFile(receipt, JSON.stringify({ ...proof, ...patch }));
    assert.equal((await f.complete(brief, head, { receipt })).code, 'project_receipt_mismatch');
  }
});

test('round2 R5 cleans transport refs on integration, abandon and later GC', async t => {
  const { gcProjectWorktrees } = await import('../runtime/project-worktree-gc.mjs');
  for (const abandon of [false, true]) {
    const f = await remoteFixture(t);
    const [brief] = (await f.pull()).briefs;
    f.checkout(brief);
    const head = await f.change({ ...brief, worktree: f.clone });
    git(f.clone, 'push', 'origin', 'HEAD:' + brief.workRef);
    const tracking = 'refs/kodo/fetched/' + brief.runId;
    const empty = () => {
      assert.equal(git(f.bare, 'for-each-ref', '--format=%(refname)', brief.baseRef, brief.workRef), '');
      assert.equal(git(f.root, 'for-each-ref', '--format=%(refname)', tracking), '');
    };
    assert.equal(
      (await f.complete(brief, head, { abandon, deferGate: !abandon })).status,
      abandon ? 'abandoned' : 'integrated',
    );
    empty();
    git(f.bare, 'update-ref', brief.baseRef, brief.baseSha);
    git(f.root, 'update-ref', tracking, brief.baseSha);
    await gcProjectWorktrees(f.store, await f.snapshot());
    empty();
  }
});

test('round2 R6 refuses oversized remote objects before checkout', async t => {
  const f = await remoteFixture(t);
  const [brief] = (await f.pull()).briefs;
  f.checkout(brief);
  const head = await commit(f.clone, { 'src/t0.mjs': '//' + 'a'.repeat(64 * 1024 * 1024 + 1) });
  git(f.clone, 'push', 'origin', 'HEAD:' + brief.workRef);
  const lockObservations = [];
  const channel = tracingChannel('child_process.spawn').start;
  const observe = ({ options }) => {
    if (options.args.includes('fetch') && options.args.includes('origin'))
      lockObservations.push(projectSectionHeld(f.store, f.projectId));
  };
  channel.subscribe(observe);
  let result;
  try {
    result = await f.complete(brief, head);
  } finally {
    channel.unsubscribe(observe);
  }
  assert.deepEqual(lockObservations, [false], 'fetch runs outside the project section');

  assert.equal(result.code, 'project_transport_too_large');
  assert.equal(git(f.store.getRun(brief.runId).cwd, 'rev-parse', 'HEAD'), brief.baseSha);
});

test('round2 R6 losing the submission lease during fetch leaves the attempt checkout untouched', async t => {
  const f = await remoteFixture(t);
  const [brief] = (await f.pull()).briefs;
  f.checkout(brief);
  const head = await f.change({ ...brief, worktree: f.clone });
  git(f.clone, 'push', 'origin', 'HEAD:' + brief.workRef);
  const acquire = f.store.acquireLease.bind(f.store);
  let token;
  f.store.acquireLease = (name, owner, options) => {
    const lease = acquire(name, owner, options);
    if (name === 'project-verify:' + brief.runId) token = lease;
    return lease;
  };
  const channel = tracingChannel('child_process.spawn').start;
  const revoke = ({ options }) => {
    if (token && options.args.includes('fetch') && options.args.includes('origin')) f.store.releaseLease(token);
  };
  channel.subscribe(revoke);
  try {
    await assert.rejects(f.complete(brief, head), { code: 'project_lease_lost' });
    assert.equal(git(f.store.getRun(brief.runId).cwd, 'rev-parse', 'HEAD'), brief.baseSha);
  } finally {
    channel.unsubscribe(revoke);
  }
});

test('round2 R7 keeps a pending integration when its worker goes down', async t => {
  const f = await remoteFixture(t);
  const [brief] = (await f.pull()).briefs;
  const { openIntegrationQueue } = await import('../runtime/project-integration-queue.mjs');
  const queue = openIntegrationQueue(f.store);
  const entry = queue.enqueue({
    projectId: f.projectId,
    taskId: brief.taskId,
    attemptId: brief.attemptId,
    runId: brief.runId,
    baseSha: brief.baseSha,
    headSha: brief.baseSha,
    priority: 0,
  });
  f.store.updateRun(brief.runId, { state: 'succeeded', integration: { status: 'pending' } });
  f.machine.down = true;
  f.repo.setProfile(f.projectId, f.profile);
  const result = await f.pull();
  assert.ok(!result.blocked.some(row => row.code === 'project_machine_down'));
  assert.deepEqual(result.briefs, []);
  assert.equal(queue.get(entry.seq).status, 'queued');
  assert.equal((await f.complete(brief, 'a'.repeat(40))).code, 'project_submission_locked');
});
test('16A fetches remote results and verifies untrusted builds in the slot of this PC', async t => {
  const f = await fixture(t, { count: 2 });
  const bare = path.join(f.temp, 'transport.git');
  const clone = path.join(f.temp, 'worker');
  git(f.temp, 'init', '--bare', bare);
  git(f.root, 'remote', 'add', 'origin', bare);
  git(f.temp, 'clone', bare, clone);
  git(clone, 'config', 'user.name', 'Remote worker');
  git(clone, 'config', 'user.email', 'worker@example.invalid');
  f.repo.setProfile(f.projectId, {
    subscriptions: [{ id: 'a', slots: 2, provider: 'codex', model: 'gpt', tier: 'fast' }],
    machines: [
      { id: 'remote', kind: 'ssh', maxWorkers: 1, maxHeavyBuilds: 1 },
      { id: 'pc', kind: 'local', maxWorkers: 1, maxHeavyBuilds: 1 },
    ],
  });
  const briefs = [...(await f.briefs()).values()];
  assert.deepEqual(briefs.map(brief => brief.machine?.id).sort(), ['pc', 'remote']);
  const results = [];
  const requested = await buildLeases(f, async () => {
    for (const brief of briefs) {
      if (brief.machine.kind === 'local') {
        results.push(await f.complete(brief, await f.change(brief)));
        continue;
      }
      assertNoLocalPath(brief, [f.root, f.home]);
      assert.equal(brief.worktree, undefined);
      git(clone, 'fetch', 'origin', brief.baseRef);
      assert.equal(git(clone, 'rev-parse', 'FETCH_HEAD'), brief.baseSha);
      git(clone, 'checkout', '-b', brief.branch, 'FETCH_HEAD');
      const head = await f.change({ ...brief, worktree: clone });
      await assert.rejects(f.complete(brief, head), { code: 'project_transport_failed' });
      const unrelated = git(clone, 'commit-tree', 'HEAD^{tree}', '-m', 'Independent root');
      git(clone, 'push', 'origin', unrelated + ':' + brief.workRef);
      assert.equal((await f.complete(brief, unrelated)).code, 'external_not_descendant');
      git(clone, 'push', 'origin', '+HEAD:' + brief.workRef);
      assert.equal((await f.complete(brief, brief.baseSha)).code, 'project_transport_head_mismatch');
      results.push(await f.complete(brief, head, { receipt: 'ignored' }));
    }
  });
  assert.deepEqual(
    results.map(row => row.status),
    ['integrated', 'integrated'],
    JSON.stringify(results),
  );
  assert.deepEqual(requested, [
    ['machine-build:pc', 1],
    ['machine-build:pc', 1],
  ]);
});

test('16A accepts only a bound receipt for a trusted remote build', async t => {
  const f = await fixture(t, { count: 1 });
  const bare = path.join(f.temp, 'transport.git');
  git(f.temp, 'init', '--bare', bare);
  git(f.root, 'remote', 'add', 'transport', bare);
  const machine = {
    id: 'remote',
    kind: 't3-env',
    gitRemote: 'transport',
    trustedBuilds: true,
    maxWorkers: 1,
    maxHeavyBuilds: 1,
  };
  const profile = {
    subscriptions: [{ id: 'a', slots: 1, provider: 'codex', model: 'gpt', tier: 'fast' }],
    machines: [machine],
  };
  f.repo.setProfile(f.projectId, profile);
  const brief = [...(await f.briefs()).values()][0];
  machine.down = true;
  f.repo.setProfile(f.projectId, profile);
  const pull = await nextWave(f.ctx, { projectId: f.projectId, host: 't3', ports: f.ports });
  assert.ok(pull.blocked.some(row => row.code === 'project_machine_down'));
  machine.down = false;
  f.repo.setProfile(f.projectId, profile);
  const clone = path.join(f.temp, 'worker');
  git(f.temp, 'clone', bare, clone);
  git(clone, 'config', 'user.name', 'Remote worker');
  git(clone, 'config', 'user.email', 'worker@example.invalid');
  git(clone, 'fetch', 'origin', brief.baseRef);
  git(clone, 'checkout', '-b', brief.branch, 'FETCH_HEAD');
  const head = await f.change({ ...brief, worktree: clone });
  git(clone, 'push', 'origin', 'HEAD:' + brief.workRef);
  const receipt = path.join(f.temp, 'receipt.json');
  await writeFile(receipt, '{}');
  assert.equal((await f.complete(brief, head, { receipt })).code, 'project_receipt_mismatch');
  const { receiptBinding } = await import('../runtime/remote-task-receipt.mjs');
  await writeFile(receipt, JSON.stringify(await receiptBinding(f.store.getRun(brief.runId), head)));
  const result = await f.complete(brief, head, { receipt });
  assert.equal(result.status, 'integrated', JSON.stringify(result));
  assert.equal(f.store.getRun(brief.runId).checks.source, 'remote');
});

test('16A retries an abandoned attempt on the remaining available machine', async t => {
  const f = await fixture(t, { count: 1 });
  const profile = {
    subscriptions: [{ id: 'pool', provider: 'codex', model: 'gpt', tier: 'fast', slots: 1 }],
    machines: ['a', 'b'].map(id => ({ id, kind: 'local', maxWorkers: 1, maxHeavyBuilds: 1 })),
  };
  f.repo.setProfile(f.projectId, profile);
  const brief = [...(await f.briefs()).values()][0];
  // A local placement adds its assignment to the legacy local brief and changes no other byte.
  const stored = f.store.getRun(brief.runId);
  const { subscription, machine, ...localBrief } = brief;
  f.store.updateRun(stored.id, { workerPlacement: null });
  const legacy = [...(await f.briefs()).values()][0];
  assert.equal(JSON.stringify(localBrief), JSON.stringify(legacy));
  f.store.updateRun(stored.id, { workerPlacement: { subscription, machine } });
  profile.machines[0].down = true;
  f.repo.setProfile(f.projectId, profile);
  const pull = retryFailed => nextWave(f.ctx, { projectId: f.projectId, host: 't3', ports: f.ports, retryFailed });
  assert.equal((await pull(false)).blocked[0].code, 'project_machine_down');
  assert.equal((await f.complete(brief, brief.baseSha, { deferGate: false, abandon: true })).status, 'abandoned');
  const retry = (await pull(true)).briefs[0];
  assert.equal(retry.machine.id, 'b');
  assert.notEqual(retry.attemptId, brief.attemptId);
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

// A "dead" process: its promise settles only when the test ends (with an error that its caller
// swallows), never while the test runs; no promise is left pending forever.
function frozen(t) {
  return new Promise((resolve, reject) =>
    t.after(() => reject(Object.assign(new Error('The process died'), { code: 'injected_crash' }))),
  );
}

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
  const secondHead = await f.change(briefs[1]);
  const second = await f.complete(briefs[1], secondHead, { deferGate: false });
  assert.deepEqual([second.status, second.code], ['blocked', 'project_control_blocked']);
  assert.ok(second.integration, 'the answer shows the merge is done');
  assert.equal(f.store.getRun(briefs[1].runId).externalCompletion.gates, null, 'a repeat may run them');
  const unpause = async () =>
    f.repo.apply({
      schemaVersion: 1,
      commandId: randomUUID(),
      projectId: f.projectId,
      expectedRevision: (await f.snapshot()).revision,
      actor: 'owner',
      reason: 'Resume after the pause',
      action: { op: 'setPaused', paused: false },
    });
  await unpause();
  // The pass stopped on a pause that was lifted before it returned: the pass itself says so.
  f.ports.runPendingGates = async () => ({ gates: [], accepted: [], blocked: [], stopped: 'project_control_blocked' });
  const lifted = await f.complete(briefs[1], secondHead, { deferGate: false });
  assert.deepEqual([lifted.status, lifted.code], ['blocked', 'project_control_blocked']);
  assert.equal(f.store.getRun(briefs[1].runId).externalCompletion.gates, null);
  // After the pause the dispatcher repeats the submission: the gates run once and are recorded.
  f.ports.runPendingGates = async (waveCtx, input) => {
    passes.push(input.projectId);
    return { gates: [], accepted: [], blocked: [] };
  };
  const resumed = await f.complete(briefs[1], secondHead, { deferGate: false });
  assert.deepEqual([resumed.status, resumed.replayed], ['integrated', true]);
  assert.deepEqual(f.store.getRun(briefs[1].runId).externalCompletion.gates, { gates: [], accepted: [], blocked: [] });
  assert.equal(passes.length, 2);
});

test('A verdict is not written once the build slot of its check was lost', async t => {
  const f = await fixture(t, { count: 1 });
  lightPorts(f);
  const [brief] = (await f.briefs()).values();
  const head = await f.change(brief);
  const verify = f.ports.verifyTaskFast;
  f.ports.verifyTaskFast = async input => {
    const verdict = await verify(input);
    // The slot's TTL expired during task-fast and another build took it.
    f.store.db.prepare("DELETE FROM leases WHERE name LIKE 'machine-build:%'").run();
    return verdict;
  };
  const result = await f.complete(brief, head);
  assert.deepEqual([result.status, result.code], ['blocked', 'project_lease_lost']);
  const run = f.store.getRun(brief.runId);
  assert.notEqual(run.state, 'succeeded', 'the fenced verdict was not written');
  assert.deepEqual(f.calls.integrate, []);
});

test('A gate pass whose controller lease is lost is blocked, never passed', async t => {
  const f = await fixture(t, { count: 1 });
  f.engine.leaseHeartbeatMs = 5;
  f.ports.runPendingGates = async (waveCtx, input) => {
    f.store.db.prepare('DELETE FROM leases WHERE name=?').run(`project-gates:${f.projectId}`);
    await new Promise(resolve => input.signal.addEventListener('abort', resolve, { once: true }));
    return { gates: [], accepted: [], blocked: [] };
  };
  const result = await runProjectGates(f.ctx, { projectId: f.projectId, ports: f.ports });
  assert.deepEqual([result.status, result.code], ['blocked', 'project_lease_lost']);
});

test('A pending merge that never reached the branch is checked again: a moved worker branch is refused', async t => {
  const f = await fixture(t, { count: 1 });
  lightPorts(f);
  const [brief] = (await f.briefs()).values();
  const head = await f.change(brief);
  let died;
  const dead = new Promise(resolve => (died = resolve));
  const integrate = f.ports.integrateAndAdvance;
  // The drain recorded `pending` (savePending) and its process died before the merge.
  f.ports.integrateAndAdvance = async (waveCtx, input) => {
    f.calls.integrate.push(input.taskId);
    f.store.updateRun(input.run.id, {
      integration: { branch: `kodo/project/${f.projectId}`, before: f.integrationHead(), status: 'pending' },
    });
    died();
    await frozen(t);
  };
  const background = new AbortController();
  void f.complete(brief, head, { signal: background.signal }).catch(() => {});
  await dead;
  background.abort();
  f.store.db.prepare("DELETE FROM leases WHERE name LIKE 'project%'").run();
  f.ports.integrateAndAdvance = integrate;
  // The worker commits again before the host repeats the old submission.
  const next = await f.change(brief, 9);
  const result = await f.complete(brief, head);
  assert.deepEqual([result.status, result.code], ['blocked', 'project_submission_stale']);
  assert.deepEqual(f.calls.integrate, ['t0'], 'the old head is never merged');
  assert.equal(f.merges().length, 0);
  assert.notEqual(f.store.getRun(brief.runId).integration.status, 'pending', 'the pending record is released');
  // The attempt is not bricked: the worker's new head is verified and merged.
  const resumed = await f.complete(brief, next);
  assert.equal(resumed.status, 'integrated', JSON.stringify(resumed));
  assert.deepEqual(f.calls.integrate, ['t0', 't0']);
  assert.equal(f.merges().length, 1);
});

test('A publish refused for a moved worker branch never bricks the attempt: the new head merges', async t => {
  const f = await fixture(t, { count: 1 });
  const [brief] = (await f.briefs()).values();
  const first = await f.change(brief);
  let next;
  const integrate = f.ports.integrateAndAdvance;
  // The worker commits again after the drain checked its branch and before the ref transaction.
  f.ports.integrateAndAdvance = async (waveCtx, input) => {
    if (!next) next = await f.change(brief, 7);
    return integrate(waveCtx, input);
  };
  const refused = await f.complete(brief, first);
  assert.deepEqual([refused.status, refused.code], ['blocked', 'project_submission_stale']);
  assert.equal(f.merges().length, 0, 'nothing was published');
  const run = f.store.getRun(brief.runId);
  assert.equal(run.integration.status, 'failed', 'the pending record of the old head is released');
  const merged = await f.complete(brief, next);
  assert.equal(merged.status, 'integrated', JSON.stringify(merged));
  assert.equal(f.merges().length, 1);
  assert.equal(f.store.getRun(brief.runId).headSha, next);
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
      await frozen(t);
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

test('next-wave reserves and installs nothing once its project lease passed on', async t => {
  const f = await fixture(t, { count: 2 });
  const name = `project:${f.projectId}`;
  // The TTL of next-wave's lease expired and another controller took project:<id>.
  const handOff = () => {
    f.store.db.prepare('DELETE FROM leases WHERE name=?').run(name);
    f.store.acquireLease(name, 'other', { ttlMs: 60000 });
  };
  const wave = repo => nextWave({ ...f.ctx, repo }, { projectId: f.projectId, host: 't3', ports: f.ports, limit: 2 });
  const beforeReserve = Object.create(f.repo, {
    apply: {
      value: async command => {
        if (command.action.op === 'reserveAttempt') handOff();
        return f.repo.apply(command);
      },
    },
  });
  // The admission checks its leases after every task: a lost lease stops the whole batch (15A).
  await assert.rejects(wave(beforeReserve), { code: 'project_lease_lost' });
  assert.deepEqual((await f.snapshot()).currentAttempts, [], 'no attempt was reserved');
  f.store.db.prepare('DELETE FROM leases WHERE name=?').run(name);
  // Before the Run install of a reserved attempt.
  const beforeInstall = Object.create(f.repo, {
    installRun: {
      value: async value => {
        handOff();
        return f.repo.installRun(value);
      },
    },
  });
  await assert.rejects(wave(beforeInstall), { code: 'project_lease_lost' });
  for (const attempt of (await f.snapshot()).currentAttempts)
    assert.throws(() => f.store.getRun(attempt.runId), 'no Run was installed');
});

test('A lost lease inside task-fast is reported as such, never as a failed check', async t => {
  const f = await fixture(t, { count: 1 });
  const [brief] = (await f.briefs()).values();
  await f.change(brief);
  t.mock.method(f.engine, 'behaviorGate', async () => {
    throw Object.assign(new Error('Project lease lost'), { code: 'project_lease_lost' });
  });
  await assert.rejects(verifyTaskFastOnce({ engine: f.engine, run: brief.runId }), { code: 'project_lease_lost' });
});
