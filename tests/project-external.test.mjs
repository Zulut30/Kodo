import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { withPullLease } from '../runtime/project-controller-lease.mjs';
import { Store } from '../runtime/store.mjs';
import { Engine } from '../runtime/engine.mjs';
import * as contracts from '../runtime/project-contracts.mjs';
import { openProjectStore } from '../runtime/project-store.mjs';
import { scopesOverlap } from '../runtime/contracts.mjs';
import { ensureIntegration, mergeTask } from '../runtime/project-integration.mjs';
import { withIntegrationLease } from '../runtime/project-integration-lease.mjs';
import { completeTask, nextWave, runProjectGates } from '../runtime/project-external.mjs';
import { createProjectTransitionAuthorizer } from '../runtime/project-director.mjs';
import { gateHolds } from '../runtime/project-director-waves.mjs';
import { workerRole, WORKER_ROLES } from '../runtime/worker-roles.mjs';

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
  writePaths: ['src/' + id + '.mjs'],
  acceptance: [criterion],
  interfaceRefs: [],
  priority: 50,
  userValue: 3,
  risk: 1,
  estimatedEffort: 1,
  riskApprovalRequired: false,
  ...extra,
});

// The pure part of the director's wave selection: open tasks by priority whose
// dependencies are integrated and whose write paths overlap nothing in flight.
function selectWave(snapshot, { limit, inFlight = [] }) {
  const busy = snapshot.tasks.filter(task => inFlight.includes(task.id)),
    picked = [];
  for (const task of [...snapshot.tasks].sort((a, b) => b.priority - a.priority)) {
    if (picked.length >= limit) break;
    if (!['proposed', 'ready'].includes(task.status) || inFlight.includes(task.id)) continue;
    const deps = task.dependsOn.every(id =>
      ['integrated', 'accepted', 'released'].includes(snapshot.tasks.find(row => row.id === id)?.status),
    );
    if (!deps || [...busy, ...picked].some(other => scopesOverlap(other.writePaths, task.writePaths))) continue;
    picked.push(task);
  }
  return picked.map(task => task.id);
}

// A fake director step with the real Git and Store effects: merge into the
// integration branch, persist the checks observation, advance attempt and task.
// It holds the integration lease like the director: the authorizer requires it for `integrated`.
async function integrate(f, input) {
  return withIntegrationLease(f.store, input.projectId, () => integrateLeased(f, input));
}
async function integrateLeased(f, { projectId, taskId, run }) {
  const snapshot = await f.repo.snapshot(projectId);
  const task = snapshot.tasks.find(row => row.id === taskId);
  const branch = await ensureIntegration({
    root: snapshot.project.root,
    projectId,
    worktreeHome: f.home + '-worktrees',
  });
  const merged = await mergeTask({
    worktree: branch.worktree,
    taskId,
    taskHead: run.headSha,
    writePaths: task.writePaths,
    savePending: () => {},
  });
  f.store.updateRun(run.id, { integration: merged });
  const stored = f.store.getRun(run.id);
  const ref = await f.engine.persistEvidence(stored, 'project-checks', stored.checks, { headSha: stored.headSha });
  const evidence = [{ kind: 'checks', runId: run.id, headSha: stored.headSha, path: ref.path, sha256: ref.sha256 }];
  for (const kind of ['attempt', 'task'])
    for (const to of ['verifying', 'integrated']) {
      const s = await f.repo.snapshot(projectId);
      const record =
        kind === 'attempt'
          ? s.currentAttempts.find(row => row.taskId === taskId)
          : s.tasks.find(row => row.id === taskId);
      if (['verifying', 'integrated'].indexOf(record.status) >= ['verifying', 'integrated'].indexOf(to)) continue;
      await f.repo.apply({
        schemaVersion: 1,
        commandId: randomUUID(),
        projectId,
        expectedRevision: s.revision,
        actor: 'fake-director',
        reason: 'Integrate a verified external task',
        action: { op: 'transition', kind, id: record.id, to, evidence, mappings: [] },
      });
    }
  return {
    status: 'integrated',
    mergeCommit: merged.mergeCommit,
    revision: (await f.repo.snapshot(projectId)).revision,
  };
}

async function fixture(t, { wave = true, stateInGit = false, edit = () => {} } = {}) {
  const temp = await realpath(await mkdtemp(path.join(os.tmpdir(), 'kodo-external-')));
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
  await write(root, '.gitattributes', '* text=auto eol=lf\n');
  await write(root, 'kodo.config.json', JSON.stringify(config, null, 2));
  for (const name of ['a', 'b']) {
    await write(root, `src/${name}.mjs`, `export const ${name} = 1;\n`);
    await write(root, `tests/${name}.test.mjs`, testFile(name));
  }
  git(root, 'init', '-b', 'main');
  git(root, 'config', 'user.name', 'Kodo External Test');
  git(root, 'config', 'user.email', 'kodo-external@example.invalid');
  git(root, 'config', 'core.autocrlf', 'false');
  git(root, 'add', '.');
  git(root, 'commit', '-m', 'Fixture baseline');
  const interfaces = path.join(temp, 'interfaces');
  await mkdir(interfaces, { recursive: true });
  const text = JSON.stringify({
    schemaVersion: 1,
    kind: 'interface',
    headSha: null,
    value: 'b exports a positive number',
  });
  const digest = createHash('sha256').update(text).digest('hex');
  const iface = {
    kind: 'interface',
    runId: null,
    headSha: null,
    path: path.join(interfaces, `interface-${digest}.json`),
  };
  await writeFile(iface.path, text, { mode: 0o600 });
  const home = path.join(temp, 'state');
  const store = new Store(home);
  stores.push(store);
  const engine = new Engine({ store });
  const repo = await openProjectStore({
    store,
    contracts,
    authorizeTransition: createProjectTransitionAuthorizer({ store, engine, contracts }),
  });
  const spec = {
    schemaVersion: 1,
    id: 'sample',
    root,
    title: 'Wave sample',
    definitionOfDone: [criterion],
    constraints: ['Only assigned work'],
    businessContext: 'Owned fixture',
    architectureRefs: [],
    ...(wave ? { execution: { cadence: 'wave', integration: 'branch' } } : {}),
    milestones: [{ id: 'm', title: 'Milestone', acceptance: [criterion], releaseRequired: false }],
    epics: [{ id: 'e', milestoneId: 'm', title: 'Epic', acceptance: [criterion] }],
    tasks: [
      taskSpec('task-a', { writePaths: ['src/a.mjs', 'tests/a.test.mjs'], priority: 90 }),
      taskSpec('task-b', {
        owner: 'security',
        writePaths: ['src/b.mjs', 'tests/b.test.mjs'],
        priority: 80,
        interfaceRefs: [{ ...iface, sha256: digest }],
      }),
      taskSpec('task-c', { owner: 'mystery', writePaths: ['src/a.mjs'], priority: 70 }),
      taskSpec('task-d', { dependsOn: ['task-a'], writePaths: ['src/d.mjs'], priority: 60 }),
    ],
  };
  edit(spec);
  const created = await repo.apply({
    schemaVersion: 1,
    commandId: randomUUID(),
    projectId: null,
    expectedRevision: null,
    actor: 'test',
    reason: 'Create the wave fixture',
    action: { op: 'create', spec },
  });
  const f = {
    temp,
    root,
    home,
    store,
    engine,
    repo,
    projectId: created.projectId,
    iface: { ...iface, sha256: digest },
  };
  f.calls = { select: [], integrate: [], gates: [], contexts: [] };
  f.ports = {
    selectWave: (snapshot, options) => {
      f.calls.select.push(options);
      return selectWave(snapshot, options);
    },
    createWaveContext: input => {
      f.calls.contexts.push(input);
      return { ...input };
    },
    integrateAndAdvance: async (waveCtx, input) => {
      assert.equal(waveCtx.repo, repo);
      f.calls.integrate.push(input.taskId);
      return integrate(f, input);
    },
    runPendingGates: async (waveCtx, input) => {
      f.calls.gates.push(input);
      return { gates: [], accepted: [], blocked: [] };
    },
  };
  f.ctx = { repo, engine, store, contracts };
  f.wave = (input = {}) => nextWave(f.ctx, { projectId: f.projectId, host: 't3', ports: f.ports, ...input });
  f.complete = (taskId, head, input = {}) =>
    completeTask(f.ctx, { projectId: f.projectId, taskId, head, ports: f.ports, ...input });
  f.snapshot = () => repo.snapshot(f.projectId);
  // A state home that became a Git work tree after its project store was created: the Engine
  // then keeps Run artifacts and worktrees beside a temporary home unless KODO_WORKTREE_HOME is set.
  if (stateInGit) git(home, 'init', '-b', 'main');
  f.integrationHead = () => git(root, 'rev-parse', `refs/heads/kodo/project/${f.projectId}`);
  return f;
}

const brief = (result, taskId) => result.briefs.find(row => row.taskId === taskId);

test('next-wave reserves non-overlapping tasks on the integration head; a repeat returns the same briefs', async t => {
  const f = await fixture(t);
  const first = await f.wave({ limit: 1 });
  assert.deepEqual(
    first.briefs.map(row => row.taskId),
    ['task-a'],
  );
  assert.deepEqual(first.blocked, []);
  const second = await f.wave({ limit: 3 });
  assert.deepEqual(
    second.briefs.map(row => row.taskId),
    ['task-a', 'task-b'],
    'task-c overlaps task-a and task-d waits for task-a',
  );
  assert.deepEqual(brief(second, 'task-a'), first.briefs[0], 'an in-flight attempt keeps its brief');
  const { availability, now, ...selection } = f.calls.select.at(-1);
  assert.deepEqual(selection, { limit: 2, inFlight: ['task-a'] });
  assert.ok(Date.parse(now));
  assert.deepEqual(
    availability.map(row => [row.taskId, row.interfacesVerified]),
    [
      ['task-a', true],
      ['task-b', true],
      ['task-c', true],
      ['task-d', true],
    ],
  );

  const head = f.integrationHead();
  const snapshot = await f.snapshot();
  const projectRoot = snapshot.project.root;
  for (const row of second.briefs) {
    const attempt = snapshot.currentAttempts.find(item => item.taskId === row.taskId);
    const task = snapshot.tasks.find(item => item.id === row.taskId);
    assert.equal(attempt.status, 'running');
    assert.equal(task.status, 'running');
    assert.equal(row.attemptId, attempt.id);
    assert.equal(row.runId, attempt.runId);
    assert.equal(row.baseSha, head, 'the worktree starts at the integration head');
    assert.equal(git(row.worktree, 'rev-parse', 'HEAD'), head);
    assert.equal(git(row.worktree, 'branch', '--show-current'), `kodo/${row.runId}`);
    assert.equal(row.branch, `kodo/${row.runId}`);
    assert.equal(row.chatTitle, `Kodo · [e] Task ${row.taskId} · попытка 1`);
    assert.deepEqual(row.writePaths, task.writePaths);
    assert.equal(
      row.completeCommand,
      `kodo project complete-task ${f.projectId} ${row.taskId} --head <SHA> --attempt ${row.attemptId} --defer-gate`,
    );
    assert.equal(row.selfCheck, `kodo ci feedback --base ${head} --project "${row.worktree}" --json`);
    assert.ok(
      row.prompt.startsWith(contracts.buildDirectorTaskInput({ project: snapshot.project, task }, { knownValues: [] })),
    );
    assert.match(row.prompt, /Do not delete, skip or weaken existing tests/);
    assert.ok(row.prompt.includes(row.selfCheck));
    const run = f.store.getRun(row.runId);
    assert.deepEqual(run.executor, { kind: 'external', host: 't3' });
    assert.equal(run.verificationProfile, 'task-fast');
    assert.equal(run.config.repairRounds, 1);
    assert.equal(run.config.delivery.enabled, false);
    assert.equal(run.state, 'executing');
    assert.equal(run.cwd, row.worktree);
    // Apart from the worktree itself, no private state, artifacts or other worktrees leak into the brief.
    const escaped = value => JSON.stringify(value).slice(1, -1);
    const text = JSON.stringify(row).replaceAll(escaped(row.worktree), '<worktree>');
    for (const hidden of [f.home, run.artifacts, `project-${f.projectId}`])
      assert.ok(!text.includes(escaped(hidden)), hidden);
    assert.ok(!text.includes(escaped(path.join(f.temp, 'interfaces'))) || row.taskId === 'task-b');
  }
  assert.ok(projectRoot);
  assert.equal(brief(second, 'task-a').role, 'developer');
  assert.equal(brief(second, 'task-b').role, 'security');
  assert.equal(brief(second, 'task-b').roleInstructions, workerRole('security').instructions);
  assert.deepEqual(brief(second, 'task-a').interfaces, []);
  assert.deepEqual(brief(second, 'task-b').interfaces, [f.iface.path], 'only the task’s own interfaces');

  const before = (await f.snapshot()).revision;
  const repeat = await f.wave({ limit: 3 });
  assert.deepEqual(repeat.briefs, second.briefs);
  assert.equal(repeat.revision, before, 'a repeat writes nothing');
  const attempts = (await f.snapshot()).currentAttempts;
  assert.deepEqual(
    attempts.map(row => row.number),
    [1, 1],
  );
});

test('next-wave briefs call the CLI of their caller; a library call keeps the kodo default', async t => {
  const f = await fixture(t);
  const cli = `node "${fileURLToPath(new URL('../cli/index.mjs', import.meta.url))}"`;
  const result = await f.wave({ limit: 1, cli });
  assert.equal(result.cli, cli);
  const [row] = result.briefs;
  assert.equal(row.selfCheck, `${cli} ci feedback --base ${row.baseSha} --project "${row.worktree}" --json`);
  assert.equal(
    row.completeCommand,
    `${cli} project complete-task ${f.projectId} ${row.taskId} --head <SHA> --attempt ${row.attemptId} --defer-gate`,
  );
  assert.equal(
    row.abandonCommand,
    `${cli} project complete-task ${f.projectId} ${row.taskId} --head <SHA> --abandon --attempt ${row.attemptId}`,
  );
  assert.ok(row.prompt.includes(row.selfCheck));
  contracts.assertDirectorSafe(row, { knownValues: [] });
  // The same attempt without a CLI context: the library default prefix.
  const plain = await f.wave({ limit: 1 });
  assert.equal(plain.cli, 'kodo');
  assert.equal(plain.briefs[0].attemptId, row.attemptId);
  assert.equal(plain.briefs[0].selfCheck, row.selfCheck.replace(cli, 'kodo'));
  // An unusable prefix is refused before the lease or any reservation.
  const before = (await f.snapshot()).revision;
  for (const bad of ['', ' ', 'node "x"\nkodo', 42, null, 'npx kodo', 'kodo --x', `node ${cli.slice(6, -1)}`])
    await assert.rejects(f.wave({ cli: bad }), { code: 'project_cli_invalid' }, String(bad));
  assert.equal((await f.snapshot()).revision, before);
});

// Shells expand these even inside double quotes: $ and backtick (PowerShell, bash), % and ! (cmd);
// a quote ends the argument. A path a brief command would carry is refused before any state change.
const unsafeNames = ['wt $(calc)', 'wt $x', 'wt %PATH%', 'wt `id`', 'wt !x!'];

test('next-wave refuses a worktree home or CLI path a shell would expand, before any state change', async t => {
  const f = await fixture(t);
  const before = await f.snapshot();
  const saved = process.env.KODO_WORKTREE_HOME;
  t.after(() => {
    if (saved === undefined) delete process.env.KODO_WORKTREE_HOME;
    else process.env.KODO_WORKTREE_HOME = saved;
  });
  for (const name of unsafeNames) {
    process.env.KODO_WORKTREE_HOME = path.join(f.temp, name);
    await assert.rejects(f.wave(), { code: 'project_path_unsafe' }, name);
  }
  if (saved === undefined) delete process.env.KODO_WORKTREE_HOME;
  else process.env.KODO_WORKTREE_HOME = saved;
  for (const name of [...unsafeNames, 'relative'])
    await assert.rejects(
      f.wave({ cli: `node "${name === 'relative' ? 'cli/index.mjs' : path.join(f.temp, name, 'index.mjs')}"` }),
      { code: 'project_path_unsafe' },
      name,
    );
  await assert.rejects(f.wave({ cli: `node "${path.join(f.temp, 'wt "q', 'index.mjs')}"` }), {
    code: 'project_cli_invalid',
  });
  // Windows: only a fully qualified local path (drive letter, colon, separator); a network share, a drive root or a path
  // without a drive letter is refused with the advice to move the project below a local drive.
  if (process.platform === 'win32')
    for (const location of [
      '/tools/cli/index.mjs',
      path.win32.join('//server/share', 'cli', 'index.mjs'),
      path.win32.resolve('C:/'),
    ])
      await assert.rejects(
        f.wave({ cli: `node "${location}"` }),
        error => error.code === 'project_path_unsafe' && /подкаталог локального диска/.test(error.message),
        location,
      );
  const after = await f.snapshot();
  assert.equal(after.revision, before.revision);
  assert.deepEqual(after.currentAttempts, []);
  // A path with spaces and Cyrillic is an ordinary quoted argument.
  process.env.KODO_WORKTREE_HOME = path.join(f.temp, 'рабочие копии');
  const wave = await f.wave({ limit: 1 });
  assert.ok(wave.briefs[0].selfCheck.includes(`--project "${wave.briefs[0].worktree}" --json`));
  assert.ok(wave.briefs[0].worktree.startsWith(path.join(f.temp, 'рабочие копии')));
});

test('next-wave checks an explicit KODO_WORKTREE_HOME of a state home inside Git before any reservation', async t => {
  const f = await fixture(t, { stateInGit: true });
  const saved = process.env.KODO_WORKTREE_HOME;
  t.after(() => {
    if (saved === undefined) delete process.env.KODO_WORKTREE_HOME;
    else process.env.KODO_WORKTREE_HOME = saved;
  });
  const before = await f.snapshot();
  // The Engine puts worktrees in an explicit KODO_WORKTREE_HOME first, even for a state home in Git.
  process.env.KODO_WORKTREE_HOME = path.join(f.temp, 'wt %PATH%');
  await assert.rejects(f.wave(), { code: 'project_path_unsafe' });
  const after = await f.snapshot();
  assert.equal(after.revision, before.revision);
  assert.deepEqual(after.currentAttempts, []);
  process.env.KODO_WORKTREE_HOME = path.join(f.temp, 'рабочие копии');
  const wave = await f.wave({ limit: 1 });
  assert.ok(wave.briefs[0].worktree.startsWith(path.join(f.temp, 'рабочие копии')));
});

test('next-wave checks the CLI against known values before the lease and guards its whole result', async t => {
  const f = await fixture(t);
  const cli = `node "${fileURLToPath(new URL('../cli/index.mjs', import.meta.url))}"`;
  const calls = [];
  const C = {
    ...contracts,
    assertDirectorSafe: (value, options) => {
      calls.push(typeof value === 'string' ? value : Object.keys(value).sort().join());
      return contracts.assertDirectorSafe(value, options);
    },
  };
  const acquire = f.store.acquireLease;
  f.store.acquireLease = (...args) => {
    calls.push('lease');
    return acquire.apply(f.store, args);
  };
  t.after(() => {
    f.store.acquireLease = acquire;
  });
  const input = { projectId: f.projectId, host: 't3', ports: f.ports, limit: 1 };
  await nextWave({ ...f.ctx, contracts: C }, { ...input, cli });
  assert.equal(calls[0], cli, 'the prefix is checked first');
  assert.ok(calls.indexOf('lease') > 0);
  assert.equal(calls.at(-1), 'blocked,briefs,cli,projectId,revision', 'the whole result is guarded');
  // A prefix carrying a known secret value is refused before the lease.
  calls.length = 0;
  const secrets = f.engine.secrets;
  f.engine.secrets = { FIXTURE_TOKEN: 'knownfixturevalue42' };
  t.after(() => {
    f.engine.secrets = secrets;
  });
  await assert.rejects(
    nextWave({ ...f.ctx, contracts: C }, { ...input, cli: `node "${path.join(f.temp, 'knownfixturevalue42.mjs')}"` }),
    { code: 'project_unsafe' },
  );
  assert.ok(!calls.includes('lease'));
});

test('complete-task rejects a commit outside its write paths, a foreign branch, a dirty or unrelated worktree and a deleted test', async t => {
  const f = await fixture(t);
  const wave = await f.wave({ limit: 3 });
  const a = brief(wave, 'task-a'),
    b = brief(wave, 'task-b');
  const expectFailure = async (head, code) => {
    const result = await f.complete('task-a', head);
    assert.equal(result.status, 'checks_failed', JSON.stringify(result));
    if (code instanceof RegExp) assert.match(result.code, code);
    else assert.equal(result.code, code);
    // Every refusal tells the worker chat what to fix (docs/T3-HOST.md: checks_failed has `message`).
    if (result.code.startsWith('external_'))
      assert.ok(typeof result.message === 'string' && result.message.trim(), JSON.stringify(result));
    const snapshot = await f.snapshot();
    assert.equal(snapshot.currentAttempts.find(row => row.taskId === 'task-a').status, 'running');
    return result;
  };
  const outside = await commit(a.worktree, {
    'src/a.mjs': 'export const a = 2;\n',
    'src/b.mjs': 'export const b = 9;\n',
  });
  const scope = await expectFailure(outside, 'external_scope');
  assert.match(scope.message, /src\/b\.mjs/);
  git(a.worktree, 'reset', '--hard', a.baseSha);

  const foreign = await commit(b.worktree, { 'src/b.mjs': 'export const b = 2;\n' });
  await expectFailure(foreign, 'external_branch_mismatch');

  const good = await commit(a.worktree, { 'src/a.mjs': 'export const a = 2;\n' });
  await write(a.worktree, 'notes.txt', 'scratch\n');
  await expectFailure(good, 'external_worktree_dirty');
  await rm(path.join(a.worktree, 'notes.txt'));
  git(a.worktree, 'checkout', '-q', '--detach');
  await expectFailure(good, 'external_worktree_mismatch');
  git(a.worktree, 'checkout', '-q', a.branch);

  const orphan = git(a.worktree, 'commit-tree', `${good}^{tree}`, '-m', 'Unrelated history');
  git(a.worktree, 'reset', '--hard', orphan);
  await expectFailure(orphan, 'external_not_descendant');
  git(a.worktree, 'reset', '--hard', a.baseSha);
  await expectFailure(a.baseSha, 'external_no_changes');

  git(a.worktree, 'rm', '-q', 'tests/a.test.mjs');
  const deleted = await commit(a.worktree, { 'src/a.mjs': 'export const a = 3;\n' }, 'Drop the test');
  await expectFailure(deleted, /^behavior_/);
  // Review finding (minor): a deleted worktree directory made git throw ENOENT (project_blocked).
  await rm(a.worktree, { recursive: true, force: true });
  await expectFailure(deleted, 'external_worktree_missing');
  assert.deepEqual(f.calls.integrate, [], 'nothing reached integration');
  assert.equal(f.store.getRun(a.runId).state, 'executing');
});

test('complete-task integrates once, runs pending gates unless deferred and replays a repeated head', async t => {
  const f = await fixture(t);
  const wave = await f.wave({ limit: 3 });
  const a = brief(wave, 'task-a'),
    b = brief(wave, 'task-b');
  const headA = await commit(a.worktree, { 'src/a.mjs': 'export const a = 2;\n' });
  const done = await f.complete('task-a', headA);
  assert.equal(done.status, 'integrated', JSON.stringify(done));
  assert.deepEqual(done.gates, { gates: [], accepted: [], blocked: [] });
  assert.deepEqual(f.calls.integrate, ['task-a']);
  assert.equal(f.calls.gates.length, 1);
  assert.equal(f.calls.gates[0].projectId, f.projectId);
  let snapshot = await f.snapshot();
  assert.equal(snapshot.currentAttempts.find(row => row.taskId === 'task-a').status, 'integrated');
  assert.equal(snapshot.tasks.find(row => row.id === 'task-a').status, 'integrated');
  const run = f.store.getRun(a.runId);
  assert.equal(run.state, 'succeeded');
  assert.equal(run.headSha, headA);
  assert.equal(run.checks.profile, 'task-fast');
  assert.equal(git(f.root, 'merge-base', '--is-ancestor', headA, f.integrationHead()), '');

  const repeat = await f.complete('task-a', headA);
  assert.equal(repeat.status, 'integrated');
  assert.equal(repeat.replayed, true);
  assert.deepEqual(repeat.integration, done.integration);
  assert.deepEqual(f.calls.integrate, ['task-a'], 'no second integration');
  assert.equal(f.calls.gates.length, 1, 'no second gate pass');
  assert.deepEqual(f.store.getRun(a.runId).checks, run.checks, 'no second verification');

  const headB = await commit(b.worktree, { 'src/b.mjs': 'export const b = 2;\n' });
  const deferred = await f.complete('task-b', headB, { deferGate: true });
  assert.equal(deferred.status, 'integrated', JSON.stringify(deferred));
  assert.equal(deferred.gates, undefined);
  assert.deepEqual(f.calls.integrate, ['task-a', 'task-b']);
  assert.equal(f.calls.gates.length, 1, '--defer-gate leaves gates to a later call');
  const later = await f.complete('task-b', headB);
  assert.equal(later.replayed, true);
  assert.equal(f.calls.gates.length, 2, 'a repeat without --defer-gate runs the deferred gates once');
  await f.complete('task-b', headB);
  assert.equal(f.calls.gates.length, 2);

  const next = await f.wave({ limit: 3 });
  assert.deepEqual(
    next.briefs.map(row => row.taskId),
    ['task-c', 'task-d'],
    'task-d starts after task-a is integrated',
  );
  const head = f.integrationHead();
  for (const row of next.briefs) {
    assert.equal(row.baseSha, head);
    assert.equal(git(row.worktree, 'rev-parse', 'HEAD'), head);
    assert.equal(git(row.worktree, 'merge-base', '--is-ancestor', headA, 'HEAD'), '');
  }
  snapshot = await f.snapshot();
  assert.equal(snapshot.tasks.find(row => row.id === 'task-d').status, 'running');
});

test('A task-fast receipt is integrated only with the test count its own event log proves', async t => {
  // Review finding (major): node --test was counted from the text of its summary. The validator of a
  // wave task Run recounts each node --test row from the event file of Kodo's reporter in its log.
  const f = await fixture(t);
  const cut = text => `${text.split('\n').slice(0, -2).join('\n')}\n`;
  const forgeries = {
    // A receipt row that claims one more test than its events.
    'task-a': async (run, row) => ({ ...row, tests: row.tests + 1 }),
    // A new log whose stdout claims more tests while its events are incomplete.
    'task-b': async (run, row) => {
      const log = JSON.parse(await readFile(row.outputPath, 'utf8'));
      const value = { ...log.value, stdout: '# tests 9\n# pass 9\n', testEvents: cut(log.value.testEvents) };
      const evidence = await f.engine.persistEvidence(run, 'fast-check', value, { headSha: run.headSha });
      const reference = { path: evidence.path, sha256: evidence.sha256, bytes: evidence.bytes, headSha: run.headSha };
      return { ...row, tests: 9, evidence: reference, outputPath: evidence.path, outputHash: evidence.sha256 };
    },
  };
  // The production authorizer with an evaluator that only runs its trusted validator
  // (validateWaveRun), so the validator's own refusal code is observable.
  const authorize = createProjectTransitionAuthorizer({
    store: f.store,
    engine: f.engine,
    contracts,
    evaluator: {
      evaluateWaveTransition: async (input, ports) => {
        await ports.validateRun(input.run);
        return { eligibleStates: [input.command.action.to] };
      },
    },
  });
  const validated = async (taskId, run) => {
    const snapshot = await f.snapshot();
    const ref = { kind: 'checks', runId: run.id, headSha: run.headSha, path: run.checks.results[0].outputPath };
    const action = { op: 'transition', kind: 'task', id: taskId, to: 'verifying', mappings: [] };
    const command = {
      schemaVersion: 1,
      commandId: randomUUID(),
      projectId: f.projectId,
      expectedRevision: snapshot.revision,
      actor: 'test',
      reason: 'Validate a task-fast receipt',
      action: { ...action, evidence: [{ ...ref, sha256: 'a'.repeat(64) }] },
    };
    return authorize({ command, snapshot }).then(
      () => 'valid',
      error => error.code,
    );
  };
  const codes = [];
  f.ports.integrateAndAdvance = async (waveCtx, input) => {
    f.calls.integrate.push(input.taskId);
    const stored = f.store.getRun(input.run.id);
    assert.equal(stored.checks.results.filter(row => row.kind === 'test' && row.tests > 0).length, 1);
    const genuine = await validated(input.taskId, stored);
    const results = [];
    for (const row of stored.checks.results)
      results.push(row.kind === 'test' ? await forgeries[input.taskId](stored, row) : row);
    f.store.updateRun(stored.id, { checks: { ...stored.checks, results } });
    codes.push([input.taskId, genuine, await validated(input.taskId, f.store.getRun(stored.id))]);
    return integrate(f, { ...input, run: f.store.getRun(stored.id) });
  };
  const wave = await f.wave({ limit: 3 });
  for (const [taskId, change] of [
    ['task-a', { 'src/a.mjs': 'export const a = 2;\n' }],
    ['task-b', { 'src/b.mjs': 'export const b = 2;\n' }],
  ]) {
    const head = await commit(brief(wave, taskId).worktree, change);
    await assert.rejects(() => f.complete(taskId, head), { code: 'project_transition_blocked' }, taskId);
    const snapshot = await f.snapshot();
    assert.notEqual(snapshot.tasks.find(row => row.id === taskId).status, 'integrated');
  }
  assert.deepEqual(codes, [
    ['task-a', 'valid', 'project_fast_tests_uncounted'],
    ['task-b', 'valid', 'project_fast_tests_uncounted'],
  ]);
  assert.deepEqual(f.calls.integrate, ['task-a', 'task-b']);
});

test('abandon blocks the attempt and cancels its Run; retry-failed reserves a new attempt', async t => {
  const f = await fixture(t);
  const wave = await f.wave({ limit: 1 });
  const a = wave.briefs[0];
  const abandoned = await f.complete('task-a', a.baseSha, { abandon: true, attemptId: a.attemptId });
  assert.equal(abandoned.status, 'abandoned');
  let snapshot = await f.snapshot();
  assert.equal(snapshot.currentAttempts[0].status, 'blocked');
  const run = f.store.getRun(a.runId);
  assert.equal(run.state, 'cancelled');
  assert.equal(run.cancelRequested, true);
  const again = await f.complete('task-a', a.baseSha, { abandon: true });
  assert.deepEqual([again.status, again.replayed], ['abandoned', true]);
  assert.equal((await f.snapshot()).revision, snapshot.revision);
  const late = await f.complete('task-a', a.baseSha);
  assert.deepEqual([late.status, late.code], ['blocked', 'project_attempt_not_running']);

  const plain = await f.wave({ limit: 1 });
  assert.ok(!plain.briefs.some(row => row.taskId === 'task-a'), 'no silent retry');
  const retried = await f.wave({ limit: 2, retryFailed: true });
  const fresh = brief(retried, 'task-a');
  assert.ok(fresh, JSON.stringify(retried));
  assert.notEqual(fresh.attemptId, a.attemptId);
  assert.equal(fresh.chatTitle, 'Kodo · [e] Task task-a · попытка 2');
  assert.notEqual(fresh.runId, a.runId);
  assert.notEqual(fresh.worktree, a.worktree);
  snapshot = await f.snapshot();
  const attempt = snapshot.currentAttempts.find(row => row.taskId === 'task-a');
  assert.deepEqual([attempt.number, attempt.status], [2, 'running']);
});

test('An abandon without an attempt id never stops the current attempt; only a recorded one is replayed', async t => {
  // Review finding (major): a late --abandon without --attempt cancelled the NEW attempt of a retry.
  const f = await fixture(t);
  const a = brief(await f.wave({ limit: 1 }), 'task-a');
  // A first abandon must name its attempt.
  await assert.rejects(f.complete('task-a', a.baseSha, { abandon: true }), { code: 'project_arguments' });
  assert.equal((await f.snapshot()).currentAttempts[0].status, 'running', 'nothing was stopped');
  assert.equal(f.store.getRun(a.runId).state, 'executing');
  const first = await f.complete('task-a', a.baseSha, { abandon: true, attemptId: a.attemptId });
  assert.equal(first.status, 'abandoned');
  const fresh = brief(await f.wave({ limit: 2, retryFailed: true }), 'task-a');
  assert.notEqual(fresh.attemptId, a.attemptId);
  const current = async () => (await f.snapshot()).currentAttempts.find(row => row.taskId === 'task-a');
  // A late repeat with another head names no recorded abandon: refused, the retry keeps running.
  await assert.rejects(f.complete('task-a', 'b'.repeat(40), { abandon: true }), { code: 'project_arguments' });
  assert.deepEqual([(await current()).id, (await current()).status], [fresh.attemptId, 'running']);
  assert.notEqual(f.store.getRun(fresh.runId).state, 'cancelled');
  // The same head as the recorded abandon is its unambiguous repeat: the earlier result, unchanged state.
  const revision = (await f.snapshot()).revision;
  const repeat = await f.complete('task-a', a.baseSha, { abandon: true });
  assert.deepEqual([repeat.status, repeat.attemptId, repeat.replayed], ['abandoned', a.attemptId, true]);
  assert.deepEqual([(await current()).status, (await f.snapshot()).revision], ['running', revision]);
  // Two recorded abandons with the same head are ambiguous without an attempt id.
  assert.equal(
    (await f.complete('task-a', a.baseSha, { abandon: true, attemptId: fresh.attemptId })).status,
    'abandoned',
  );
  await assert.rejects(f.complete('task-a', a.baseSha, { abandon: true }), { code: 'project_arguments' });
  const named = await f.complete('task-a', a.baseSha, { abandon: true, attemptId: a.attemptId });
  assert.deepEqual([named.attemptId, named.replayed], [a.attemptId, true]);
});

test('next-wave never hands out a task whose interface proofs do not verify', async t => {
  // F2 open question: next-wave chose its wave without the interface check drain and horizon use.
  const f = await fixture(t);
  await writeFile(f.iface.path, JSON.stringify({ tampered: true }));
  // The director's selection (default ports) skips it: task-c overlaps task-a, task-d waits for it.
  const selected = await f.wave({ limit: 3, ports: undefined });
  assert.deepEqual(
    selected.briefs.map(row => row.taskId),
    ['task-a'],
  );
  // It was never selected, so no attempt was reserved for it; the wave still names why it waits.
  assert.deepEqual(selected.blocked, [{ taskId: 'task-b', code: 'project_interface_unverified' }]);
  // Even a selector that ignores availability cannot reserve it.
  const forced = await f.wave({ limit: 3 });
  assert.deepEqual(forced.blocked, [{ taskId: 'task-b', code: 'project_interface_unverified' }]);
  assert.equal(
    (await f.snapshot()).currentAttempts.some(row => row.taskId === 'task-b'),
    false,
  );
});

test('next-wave --retry-failed retries only attempts of its own host', async t => {
  const f = await fixture(t);
  const wave = await f.wave({ limit: 1 });
  const a = brief(wave, 'task-a');
  assert.equal((await f.complete('task-a', a.baseSha, { abandon: true, attemptId: a.attemptId })).status, 'abandoned');
  const other = await nextWave(f.ctx, {
    projectId: f.projectId,
    host: 'orca',
    ports: f.ports,
    retryFailed: true,
    limit: 1,
  });
  assert.ok(!other.briefs.some(row => row.taskId === 'task-a'), 'another host never takes over the attempt');
  assert.deepEqual(
    other.blocked.filter(row => row.taskId === 'task-a'),
    [{ taskId: 'task-a', code: 'project_retry_executor' }],
  );
  const own = await f.wave({ limit: 1, retryFailed: true });
  assert.deepEqual(
    own.briefs.map(row => row.taskId),
    ['task-a'],
  );
  assert.notEqual(brief(own, 'task-a').runId, a.runId);
});

test('next-wave names why open tasks wait: a missing risk approval and an abandoned attempt', async t => {
  // Audit finding 4a: the director's selection dropped the planner's reasons, so an empty or short
  // wave came back with `blocked: []` and the host could not tell what to do next.
  const f = await fixture(t, {
    edit(spec) {
      spec.tasks.find(row => row.id === 'task-b').riskApprovalRequired = true;
    },
  });
  const sorted = rows => [...rows].sort((x, y) => (x.taskId < y.taskId ? -1 : 1));
  const first = await f.wave({ limit: 3, ports: undefined });
  assert.deepEqual(
    first.briefs.map(row => row.taskId),
    ['task-a'],
  );
  assert.deepEqual(first.blocked, [{ taskId: 'task-b', code: 'project_risk_unapproved' }]);
  assert.equal(
    (await f.snapshot()).currentAttempts.some(row => row.taskId === 'task-b'),
    false,
    'an explanation reserves nothing',
  );
  const a = brief(first, 'task-a');
  assert.equal((await f.complete('task-a', a.baseSha, { abandon: true, attemptId: a.attemptId })).status, 'abandoned');
  const second = await f.wave({ limit: 3, ports: undefined });
  assert.deepEqual(
    second.briefs.map(row => row.taskId),
    ['task-c'],
  );
  assert.deepEqual(sorted(second.blocked), [
    { taskId: 'task-a', code: 'project_retry_required' },
    { taskId: 'task-b', code: 'project_risk_unapproved' },
  ]);
  // Waiting for a dependency, an in-flight attempt or the wave limit is not a blocker.
  const repeat = await f.wave({ limit: 1, ports: undefined });
  assert.deepEqual(sorted(repeat.blocked), sorted(second.blocked));
});

test('next-wave names a pending epic gate and answers an accepted project with its own code', async t => {
  // Audit finding 4a/4b: every task integrated with deferred gates left an empty wave without a
  // reason, and an accepted project was refused as project_control_blocked like a paused one.
  const f = await fixture(t, {
    edit(spec) {
      spec.tasks = spec.tasks.filter(row => ['task-a', 'task-b'].includes(row.id));
    },
  });
  const wave = await f.wave({ limit: 3, ports: undefined });
  for (const [taskId, file] of [
    ['task-a', 'src/a.mjs'],
    ['task-b', 'src/b.mjs'],
  ]) {
    const head = await commit(brief(wave, taskId).worktree, { [file]: `export const ${taskId.at(-1)} = 2;\n` });
    assert.equal((await f.complete(taskId, head, { deferGate: true })).status, 'integrated');
  }
  const pending = await f.wave({ limit: 3, ports: undefined });
  assert.deepEqual(pending.briefs, []);
  assert.deepEqual(pending.blocked, [{ code: 'project_gate_pending', kind: 'epic', id: 'e' }]);

  const real = f.repo.snapshot.bind(f.repo);
  const as = (status, paused = false) =>
    Object.create(f.repo, {
      snapshot: { value: id => ({ ...real(id), project: { ...real(id).project, status, paused } }) },
    });
  const accepted = await nextWave({ ...f.ctx, repo: as('accepted') }, { projectId: f.projectId, host: 't3' });
  assert.deepEqual(accepted, {
    projectId: f.projectId,
    revision: real(f.projectId).revision,
    cli: 'kodo',
    code: 'project_accepted',
    briefs: [],
    blocked: [],
  });
  await assert.rejects(
    nextWave({ ...f.ctx, repo: as('running', true) }, { projectId: f.projectId, host: 't3' }),
    { code: 'project_control_blocked' },
    'a pause stays a control stop',
  );
  // Review finding (minor): the worktree home is checked only when work may be handed out; a
  // settled project needs no worktree, so an unusable KODO_WORKTREE_HOME never hides its code.
  const saved = process.env.KODO_WORKTREE_HOME;
  const restore = () => {
    if (saved === undefined) delete process.env.KODO_WORKTREE_HOME;
    else process.env.KODO_WORKTREE_HOME = saved;
  };
  t.after(restore);
  process.env.KODO_WORKTREE_HOME = path.join(f.temp, unsafeNames[0]);
  for (const status of ['accepted', 'released'])
    assert.equal(
      (await nextWave({ ...f.ctx, repo: as(status) }, { projectId: f.projectId, host: 't3' })).code,
      `project_${status}`,
    );
  await assert.rejects(
    nextWave({ ...f.ctx, repo: as('running') }, { projectId: f.projectId, host: 't3' }),
    { code: 'project_path_unsafe' },
    'an open project still refuses it before the lease',
  );
  restore();
});

test('next-wave names a stopped task or epic instead of an empty wave', async t => {
  // Review finding (major): a task failed before any reservation or a blocked epic left
  // briefs: [] and blocked: [] — the planner's task_failed and epic_blocked were skipped.
  const f = await fixture(t, {
    edit(spec) {
      spec.epics.push({ id: 'e2', milestoneId: 'm', title: 'Second epic', acceptance: [criterion] });
      spec.tasks = spec.tasks.filter(row => ['task-a', 'task-b'].includes(row.id));
      spec.tasks.find(row => row.id === 'task-b').epicId = 'e2';
    },
  });
  const stop = async (kind, id, to) =>
    f.repo.apply({
      schemaVersion: 1,
      commandId: randomUUID(),
      projectId: f.projectId,
      expectedRevision: (await f.snapshot()).revision,
      actor: 'owner',
      reason: 'Stop a record for the test',
      action: { op: 'transition', kind, id, to, evidence: [], mappings: [] },
    });
  await stop('task', 'task-a', 'failed');
  await stop('epic', 'e2', 'blocked');
  const wave = await f.wave({ limit: 3, ports: undefined });
  assert.deepEqual(wave.briefs, []);
  assert.deepEqual(wave.blocked, [
    { taskId: 'task-a', code: 'project_task_failed' },
    { code: 'project_epic_blocked', kind: 'epic', id: 'e2' },
  ]);
  assert.deepEqual((await f.snapshot()).currentAttempts, [], 'an explanation reserves nothing');
});

test('next-wave reads interface evidence once when nothing was reserved', async t => {
  // Review finding (minor): the explanation read every interface proof again at the same revision.
  const f = await fixture(t);
  const first = await f.wave({ limit: 3 });
  assert.deepEqual(
    first.briefs.map(row => row.taskId),
    ['task-a', 'task-b'],
  );
  const reads = [];
  const assertEvidence = f.engine.assertEvidence.bind(f.engine);
  f.engine.assertEvidence = async ref => {
    reads.push(ref.path);
    return assertEvidence(ref);
  };
  const revision = (await f.snapshot()).revision;
  const repeat = await f.wave({ limit: 3 });
  assert.equal(repeat.revision, revision, 'nothing new was reserved');
  assert.deepEqual(reads, [f.iface.path], 'one availability pass for the selection and the explanation');
});

test('The gate classification names a gate Run blocked by its acceptance with its code', () => {
  // Review finding (major): a gate Run blocked after a failed acceptance (error.code only, no
  // blocker record) must still name its gate, its Run and that code in next-wave's blocked.
  const snapshot = {
    project: { projectId: 'p', status: 'integrated' },
    milestones: [{ id: 'm', status: 'integrated' }],
    epics: [{ id: 'e', milestoneId: 'm', status: 'integrated' }],
    tasks: [{ id: 't', epicId: 'e', status: 'integrated', dependsOn: [] }],
    currentAttempts: [],
    gates: [{ id: 'g1', number: 1, runId: 'r1', containers: [{ kind: 'epic', id: 'e' }] }],
  };
  const runs = { r1: { id: 'r1', state: 'blocked', error: { code: 'wave_gate_proof_missing', message: 'no proof' } } };
  const store = {
    getRun: id => {
      if (runs[id]) return runs[id];
      throw new Error(`Запуск не найден: ${id}`);
    },
  };
  assert.deepEqual(gateHolds({ store }, snapshot), [
    { code: 'wave_gate_proof_missing', kind: 'epic', id: 'e', gateId: 'g1', runId: 'r1', state: 'blocked' },
  ]);
});

test('The gate classification follows the chain past an accepted epic and honours a replacing gate', () => {
  // Review finding (major): a gate over epic → milestone → project accepted its epic, then the
  // milestone lacked proof; the Run stayed blocked with that code, but the accepted epic hid it.
  const chain = [
    { kind: 'epic', id: 'e' },
    { kind: 'milestone', id: 'm' },
    { kind: 'project', id: 'p' },
  ];
  const base = {
    project: { projectId: 'p', status: 'integrated' },
    milestones: [{ id: 'm', status: 'integrated' }],
    epics: [{ id: 'e', milestoneId: 'm', status: 'accepted' }],
    tasks: [{ id: 't', epicId: 'e', status: 'accepted', dependsOn: [] }],
    currentAttempts: [],
  };
  const runs = {
    r1: { id: 'r1', state: 'blocked', error: { code: 'wave_gate_proof_missing', message: 'no milestone proof' } },
    r2: { id: 'r2', state: 'executing' },
    r3: { id: 'r3', state: 'blocked', error: { code: 'wave_gate_proof_missing', message: 'still none' } },
  };
  const store = {
    getRun: id => {
      if (runs[id]) return runs[id];
      throw new Error(`Запуск не найден: ${id}`);
    },
  };
  const gate = (id, number, runId) => ({ id, number, runId, containers: chain });
  const holds = gates => gateHolds({ store }, { ...base, gates });
  assert.deepEqual(holds([gate('g1', 1, 'r1')]), [
    { code: 'wave_gate_proof_missing', kind: 'milestone', id: 'm', gateId: 'g1', runId: 'r1', state: 'blocked' },
  ]);
  // A retry of the chain replaces the stopped gate: while it runs nothing is held, and a stop of
  // the retry is named by its own gate and Run.
  assert.deepEqual(holds([gate('g1', 1, 'r1'), gate('g2', 2, 'r2')]), []);
  assert.deepEqual(holds([gate('g1', 1, 'r1'), gate('g3', 2, 'r3')]), [
    { code: 'wave_gate_proof_missing', kind: 'milestone', id: 'm', gateId: 'g3', runId: 'r3', state: 'blocked' },
  ]);
});

test('The gate classification names a verified gate whose acceptance stopped mid-chain as pending', () => {
  // Review finding (minor): a stop after the epic's acceptance and before the milestone's left a
  // succeeded gate Run; `project gates` resumes the chain, but next-wave gave no reason at all.
  const snapshot = {
    project: { projectId: 'p', status: 'integrated' },
    milestones: [{ id: 'm', status: 'integrated' }],
    epics: [{ id: 'e', milestoneId: 'm', status: 'accepted' }],
    tasks: [{ id: 't', epicId: 'e', status: 'accepted', dependsOn: [] }],
    currentAttempts: [],
    gates: [
      {
        id: 'g1',
        number: 1,
        runId: 'r1',
        containers: [
          { kind: 'epic', id: 'e' },
          { kind: 'milestone', id: 'm' },
          { kind: 'project', id: 'p' },
        ],
      },
    ],
  };
  const store = { getRun: id => ({ id, state: 'succeeded' }) };
  assert.deepEqual(gateHolds({ store }, snapshot), [
    { code: 'project_gate_pending', kind: 'milestone', id: 'm', gateId: 'g1', runId: 'r1' },
  ]);
});

test('next-wave names a blocked epic whose tasks are all integrated and a cancelled predecessor', async t => {
  // Review finding (major): the epic's rows came only from its open tasks, so a blocked epic with
  // every task integrated vanished; a cancelled required predecessor looked like ordinary waiting.
  const f = await fixture(t, {
    edit(spec) {
      spec.epics.push({ id: 'e2', milestoneId: 'm', title: 'Second epic', acceptance: [criterion] });
      spec.tasks.find(row => row.id === 'task-b').epicId = 'e2';
    },
  });
  const transition = async (kind, id, to) =>
    f.repo.apply({
      schemaVersion: 1,
      commandId: randomUUID(),
      projectId: f.projectId,
      expectedRevision: (await f.snapshot()).revision,
      actor: 'owner',
      reason: 'Stop a record for the test',
      action: { op: 'transition', kind, id, to, evidence: [], mappings: [] },
    });
  const first = await f.wave({ limit: 2, ports: undefined });
  const b = brief(first, 'task-b');
  const head = await commit(b.worktree, { 'src/b.mjs': 'export const b = 2;\n' });
  assert.equal((await f.complete('task-b', head, { deferGate: true })).status, 'integrated');
  await transition('epic', 'e2', 'blocked');
  // task-a is cancelled before it ran; task-d needs it and can never start.
  const a = brief(first, 'task-a');
  assert.equal((await f.complete('task-a', a.baseSha, { abandon: true, attemptId: a.attemptId })).status, 'abandoned');
  await transition('task', 'task-a', 'cancelled');
  const wave = await f.wave({ limit: 3, ports: undefined });
  assert.deepEqual(
    wave.briefs.map(row => row.taskId),
    ['task-c'],
  );
  assert.deepEqual(wave.blocked, [
    { taskId: 'task-d', code: 'project_dependency_cancelled', dependencyId: 'task-a' },
    { code: 'project_epic_blocked', kind: 'epic', id: 'e2' },
  ]);
});

test('next-wave checks a refused interface proof again before it names it', async t => {
  // Review finding (minor): a reused negative proof check can be stale without a new revision
  // (the evidence file was restored); only a fresh refusal is reported.
  const f = await fixture(t, {
    edit(spec) {
      spec.tasks = spec.tasks.filter(row => row.id === 'task-b');
    },
  });
  const reads = [];
  const assertEvidence = f.engine.assertEvidence.bind(f.engine);
  f.engine.assertEvidence = async ref => {
    reads.push(ref.path);
    if (reads.length === 1)
      throw Object.assign(new Error('Fixture: evidence briefly unreadable'), { code: 'evidence' });
    return assertEvidence(ref);
  };
  const wave = await f.wave({ limit: 1, ports: undefined });
  assert.deepEqual(wave.briefs, [], 'the selection saw the refusal');
  assert.deepEqual(wave.blocked, [], 'the proof verifies again before it would be named');
  assert.deepEqual(reads, [f.iface.path, f.iface.path]);
});

test('gates runs the pending epic gates outside a completion and retries a blocked gate only on request', async t => {
  const f = await fixture(t);
  const gates = input => runProjectGates(f.ctx, { projectId: f.projectId, ports: f.ports, ...input });
  const passed = await gates();
  assert.equal(passed.status, 'passed', JSON.stringify(passed));
  assert.deepEqual(passed.gates, { gates: [], accepted: [], blocked: [] });
  assert.equal(passed.revision, (await f.snapshot()).revision);
  assert.deepEqual(
    f.calls.gates.map(row => [row.projectId, row.retryFailed]),
    [[f.projectId, false]],
  );

  const blocked = {
    gates: [{ gateId: 'g', runId: 'r', state: 'blocked' }],
    accepted: [],
    blocked: [{ code: 'error' }],
  };
  f.ports.runPendingGates = async (waveCtx, input) => {
    f.calls.gates.push(input);
    return blocked;
  };
  const stopped = await gates({ retryFailed: true });
  assert.equal(stopped.status, 'blocked');
  assert.deepEqual(stopped.gates, blocked);
  assert.equal(f.calls.gates.at(-1).retryFailed, true, 'only an explicit retry reserves a new gate');
  assert.deepEqual(f.calls.integrate, [], 'a gate pass integrates no task');

  await f.repo.apply({
    schemaVersion: 1,
    commandId: randomUUID(),
    projectId: f.projectId,
    expectedRevision: (await f.snapshot()).revision,
    actor: 'owner',
    reason: 'Pause before a gate pass',
    action: { op: 'setPaused', paused: true },
  });
  const paused = await gates({ retryFailed: true });
  assert.deepEqual([paused.status, paused.code], ['blocked', 'project_control_blocked']);
  assert.equal(f.calls.gates.length, 2, 'a paused project runs no gate');
});

test('gates never reports success for a blocked project or an aborted pass', async t => {
  const f = await fixture(t);
  f.ports.runPendingGates = async (waveCtx, input) => {
    f.calls.gates.push(input);
    return { gates: [], accepted: [], blocked: [] };
  };
  // A project whose own status is blocked (as complete-task refuses it).
  const real = f.repo.snapshot.bind(f.repo);
  const blockedRepo = Object.create(f.repo, {
    snapshot: { value: id => ({ ...real(id), project: { ...real(id).project, status: 'blocked' } }) },
  });
  const refused = await runProjectGates({ ...f.ctx, repo: blockedRepo }, { projectId: f.projectId, ports: f.ports });
  assert.deepEqual([refused.status, refused.code], ['blocked', 'project_control_blocked']);
  assert.deepEqual(f.calls.gates, [], 'a blocked project runs no gate');

  const before = new AbortController();
  before.abort();
  const early = await runProjectGates(f.ctx, { projectId: f.projectId, ports: f.ports, signal: before.signal });
  assert.deepEqual([early.status, early.code], ['blocked', 'project_cancelled']);
  assert.deepEqual(f.calls.gates, [], 'an aborted pass starts no gate');

  // Aborted while the gates ran: the pass returned without a blocked gate but is not a success.
  const during = new AbortController();
  f.ports.runPendingGates = async (waveCtx, input) => {
    f.calls.gates.push(input);
    during.abort();
    return { gates: [], accepted: [], blocked: [] };
  };
  const late = await runProjectGates(f.ctx, { projectId: f.projectId, ports: f.ports, signal: during.signal });
  assert.deepEqual([late.status, late.code], ['blocked', 'project_cancelled']);
  assert.equal(f.calls.gates.length, 1);

  // Paused during the pass (`project pause` takes no gate lease): the gates stop, never `passed`.
  f.ports.runPendingGates = async (waveCtx, input) => {
    f.calls.gates.push(input);
    await f.repo.apply({
      schemaVersion: 1,
      commandId: randomUUID(),
      projectId: f.projectId,
      expectedRevision: f.repo.snapshot(f.projectId).revision,
      actor: 'owner',
      reason: 'Pause during a gate pass',
      action: { op: 'setPaused', paused: true },
    });
    return { gates: [], accepted: [], blocked: [] };
  };
  const pausedDuring = await runProjectGates(f.ctx, { projectId: f.projectId, ports: f.ports });
  assert.deepEqual([pausedDuring.status, pausedDuring.code], ['blocked', 'project_control_blocked']);
  assert.equal(f.calls.gates.length, 2);
});

test('gates requires a wave project', async t => {
  const f = await fixture(t, { wave: false });
  await assert.rejects(
    runProjectGates(f.ctx, { projectId: f.projectId, ports: f.ports }),
    error => error.code === 'project_wave_required',
  );
  assert.deepEqual(f.calls.gates, []);
});

test('next-wave and complete-task require a pull host, a bound limit and a wave project', async t => {
  const f = await fixture(t, { wave: false });
  for (const [input, code] of [
    [{ host: 'codex' }, 'project_host_unsupported'],
    [{ limit: 6 }, 'project_limit_invalid'],
    [{ limit: 0 }, 'project_limit_invalid'],
    [{}, 'project_wave_required'],
  ])
    await assert.rejects(f.wave(input), error => error.code === code);
  await assert.rejects(f.complete('task-a', 'a'.repeat(40)), error => error.code === 'project_wave_required');
  await assert.rejects(f.complete('task-a', 'HEAD'), error => error.code === 'project_head_invalid');
  assert.deepEqual(f.calls.select, []);
});

test('Worker roles are short profiles; an unknown owner gets the developer profile', () => {
  assert.deepEqual(WORKER_ROLES, ['architect', 'developer', 'ui-qa', 'performance', 'security', 'reviewer']);
  for (const role of WORKER_ROLES) {
    const profile = workerRole(role);
    assert.equal(profile.role, role);
    assert.ok(Buffer.byteLength(profile.instructions) <= 1024, role);
  }
  assert.deepEqual(workerRole('mystery'), workerRole('developer'));
  assert.deepEqual(workerRole(undefined), workerRole('developer'));
});

test('Cancellation interrupts project lease reacquisition after a private gate run', async () => {
  for (const abortDuringWait of [false, true]) {
    const controller = new AbortController();
    let attempts = 0;
    const released = [];
    const store = {
      acquireLease(name) {
        if (name === 'project:p' && ++attempts > 1 && attempts < 4) {
          setTimeout(() => controller.abort(), 5);
          return null;
        }
        return name;
      },
      renewLease: () => true,
      releaseLease: token => released.push(token),
    };
    await assert.rejects(
      withPullLease(store, 'p', true, outsideLease =>
        outsideLease(async () => {
          if (!abortDuringWait) controller.abort();
        }, controller.signal),
      ),
      { code: 'project_cancelled' },
    );
    assert.equal(attempts, abortDuringWait ? 2 : 1);
    assert.deepEqual(released, ['project:p', 'project-gates:p']);
  }
});
