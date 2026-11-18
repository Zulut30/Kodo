import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../runtime/store.mjs';
import { Engine } from '../runtime/engine.mjs';
import * as contracts from '../runtime/project-contracts.mjs';
import { openProjectStore } from '../runtime/project-store.mjs';
import { scopesOverlap } from '../runtime/contracts.mjs';
import { ensureIntegration, mergeTask } from '../runtime/project-integration.mjs';
import { withIntegrationLease } from '../runtime/project-integration-lease.mjs';
import { completeTask, nextWave } from '../runtime/project-external.mjs';
import { createProjectTransitionAuthorizer } from '../runtime/project-director.mjs';
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

async function fixture(t, { wave = true } = {}) {
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
    assert.equal(row.chatTitle, `Kodo · [e] Task ${row.taskId}`);
    assert.deepEqual(row.writePaths, task.writePaths);
    assert.equal(row.completeCommand, `kodo project complete-task ${f.projectId} ${row.taskId} --head <SHA>`);
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

  const orphan = git(a.worktree, 'commit-tree', `${good}^{tree}`, '-m', 'Unrelated history');
  git(a.worktree, 'reset', '--hard', orphan);
  await expectFailure(orphan, 'external_not_descendant');
  git(a.worktree, 'reset', '--hard', a.baseSha);
  await expectFailure(a.baseSha, 'external_no_changes');

  git(a.worktree, 'rm', '-q', 'tests/a.test.mjs');
  const deleted = await commit(a.worktree, { 'src/a.mjs': 'export const a = 3;\n' }, 'Drop the test');
  await expectFailure(deleted, /^behavior_/);
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
  assert.deepEqual(selected.blocked, [], 'it was never selected, so no attempt was reserved for it');
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
