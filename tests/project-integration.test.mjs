import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, lstat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { configureGitTestEnvironment } from '../scripts/git-test-environment.mjs';
import { execute } from '../runtime/command.mjs';
import { git, worktreeHomeFor } from '../runtime/workspace.mjs';
import { stateHome, worktreeHome } from '../runtime/security.mjs';
import {
  integrationBranch,
  ensureIntegration,
  waveFrontier,
  mergeTask,
  mergeBackGate,
  gateRepairInScope,
} from '../runtime/project-integration.mjs';

configureGitTestEnvironment();
const projectId = '11111111-1111-4111-8111-111111111111';
const keys = ['HOME', 'USERPROFILE', 'GIT_CONFIG_NOSYSTEM', 'GIT_CONFIG_GLOBAL', 'GIT_TERMINAL_PROMPT'];

async function fixture(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'kodo-project-integration-'));
  const root = path.join(directory, 'repo'),
    isolated = path.join(directory, 'empty-home');
  await mkdir(root);
  await mkdir(isolated);
  await writeFile(path.join(isolated, 'gitconfig'), '');
  const previous = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  Object.assign(process.env, {
    HOME: isolated,
    USERPROFILE: isolated,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: path.join(isolated, 'gitconfig'),
    GIT_TERMINAL_PROMPT: '0',
  });
  t.after(async () => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    assert.equal(path.dirname(directory), path.resolve(os.tmpdir()));
    assert.match(path.basename(directory), /^kodo-project-integration-/);
    await rm(directory, { recursive: true, force: true });
  });
  await writeFile(path.join(root, 'shared.txt'), 'base\n');
  for (const args of [
    ['init', '-b', 'main'],
    ['config', 'user.name', 'Owned Integration'],
    ['config', 'user.email', 'integration@example.invalid'],
    ['config', 'core.autocrlf', 'false'],
    ['config', 'commit.gpgSign', 'false'],
    ['add', '.'],
    ['commit', '-m', 'Owned fixture baseline'],
  ])
    await git(root, args);
  const user = async () => ({
    head: await git(root, ['rev-parse', 'HEAD']),
    branch: await git(root, ['branch', '--show-current']),
    status: await git(root, ['status', '--porcelain=v1', '--untracked-files=all']),
  });
  // A task run commits on its own branch from the integration head it started on.
  const taskHead = async (name, base, files) => {
    const worktree = path.join(directory, 'tasks', name);
    await git(root, ['worktree', 'add', '-b', `kodo/${name}`, worktree, base]);
    for (const [file, content] of Object.entries(files)) {
      await mkdir(path.dirname(path.join(worktree, file)), { recursive: true });
      await writeFile(path.join(worktree, file), content);
    }
    await git(worktree, ['add', '-A']);
    await git(worktree, ['commit', '-m', `Task ${name}`]);
    return git(worktree, ['rev-parse', 'HEAD']);
  };
  return { directory, root, worktreeHome: path.join(directory, 'worktrees'), user, taskHead };
}

const code = async (promise, expected) => assert.rejects(promise, error => error.code === expected);
const parents = async (worktree, commit = 'HEAD') =>
  (await git(worktree, ['rev-list', '--parents', '-n', '1', commit])).split(' ').slice(1);
const pendingRecorder = worktree => {
  const calls = [];
  return {
    calls,
    savePending: async value => {
      // The pending record is durable before Git creates the merge.
      calls.push({ ...value, headAtSave: await git(worktree, ['rev-parse', 'HEAD']) });
    },
  };
};

test('worktreeHomeFor keeps the Engine worktree directory rules', () => {
  const previous = process.env.KODO_WORKTREE_HOME;
  try {
    delete process.env.KODO_WORKTREE_HOME;
    const owned = path.join(os.tmpdir(), 'kodo-owned-state');
    assert.equal(worktreeHomeFor({ storeHome: owned }), `${owned}-worktrees`);
    assert.equal(worktreeHomeFor({ storeHome: stateHome() }), worktreeHome());
    assert.equal(
      worktreeHomeFor({ storeHome: owned, stateInGit: true, artifactHome: path.join(owned, 'artifacts') }),
      `${path.join(owned, 'artifacts')}-worktrees`,
    );
    process.env.KODO_WORKTREE_HOME = path.join(owned, 'explicit');
    assert.equal(worktreeHomeFor({ storeHome: owned, stateInGit: true }), path.join(owned, 'explicit'));
  } finally {
    if (previous === undefined) delete process.env.KODO_WORKTREE_HOME;
    else process.env.KODO_WORKTREE_HOME = previous;
  }
});

test('Integration worktree lives outside the checkout and leaves the user branch and HEAD untouched', async t => {
  const f = await fixture(t);
  const before = await f.user();
  assert.equal(integrationBranch(projectId), `kodo/project/${projectId}`);
  assert.throws(
    () => integrationBranch('../main'),
    error => error.code === 'project_integration_invalid',
  );
  const integration = await ensureIntegration({ root: f.root, projectId, worktreeHome: f.worktreeHome });
  assert.deepEqual(integration, {
    branch: `kodo/project/${projectId}`,
    worktree: path.join(f.worktreeHome, `project-${projectId}`, 'integration'),
    head: before.head,
  });
  assert.equal(await git(integration.worktree, ['branch', '--show-current']), integration.branch);
  assert.deepEqual(await f.user(), before);
  assert.deepEqual(await ensureIntegration({ root: f.root, projectId, worktreeHome: f.worktreeHome }), integration);
  await code(
    ensureIntegration({ root: f.root, projectId: '22222222-2222-4222-8222-222222222222', worktreeHome: f.root }),
    'project_integration_worktree_invalid',
  );
  await code(
    ensureIntegration({
      root: f.root,
      projectId: '33333333-3333-4333-8333-333333333333',
      worktreeHome: path.join(f.root, 'nested', 'worktrees'),
    }),
    'project_integration_worktree_invalid',
  );
  assert.deepEqual(await f.user(), before);
});

test('Task merges record before and task head as parents and form the wave frontier', async t => {
  const f = await fixture(t);
  const user = await f.user();
  const integration = await ensureIntegration({ root: f.root, projectId, worktreeHome: f.worktreeHome });
  const first = await f.taskHead('first', integration.head, { 'src/first.txt': 'first\n' });
  const second = await f.taskHead('second', integration.head, { 'src/second.txt': 'second\n' });
  const recorder = pendingRecorder(integration.worktree);
  const one = await mergeTask({
    worktree: integration.worktree,
    taskId: 'first',
    taskHead: first,
    writePaths: ['src/first.txt'],
    savePending: recorder.savePending,
  });
  assert.deepEqual(recorder.calls, [{ before: integration.head, headAtSave: integration.head }]);
  assert.deepEqual(one, {
    branch: integration.branch,
    before: integration.head,
    mergeCommit: await git(integration.worktree, ['rev-parse', 'HEAD']),
    mergedHead: first,
    status: 'merged',
  });
  assert.deepEqual(await parents(integration.worktree), [integration.head, first]);
  assert.equal(await git(integration.worktree, ['log', '-1', '--format=%s']), 'Kodo: integrate first');
  let leases = 0;
  const two = await mergeTask({
    worktree: integration.worktree,
    taskId: 'second',
    taskHead: second,
    writePaths: ['src/**'],
    savePending: async () => {},
    withLease: async work => {
      leases++;
      return work();
    },
  });
  assert.equal(leases, 1);
  assert.deepEqual(await parents(integration.worktree, two.mergeCommit), [one.mergeCommit, second]);
  assert.equal(
    await waveFrontier({ worktree: integration.worktree, mergeCommits: [one.mergeCommit, two.mergeCommit] }),
    two.mergeCommit,
  );
  assert.deepEqual(await f.user(), user);
});

test('A conflicting merge is aborted with a stable code and the integration head is unchanged', async t => {
  const f = await fixture(t);
  const integration = await ensureIntegration({ root: f.root, projectId, worktreeHome: f.worktreeHome });
  const first = await f.taskHead('first', integration.head, { 'shared.txt': 'first\n' });
  const second = await f.taskHead('second', integration.head, { 'shared.txt': 'second\n' });
  const merged = await mergeTask({
    worktree: integration.worktree,
    taskId: 'first',
    taskHead: first,
    writePaths: ['shared.txt'],
    savePending: async () => {},
  });
  await code(
    mergeTask({
      worktree: integration.worktree,
      taskId: 'second',
      taskHead: second,
      writePaths: ['shared.txt'],
      savePending: async () => {},
    }),
    'project_integration_conflict',
  );
  assert.equal(await git(integration.worktree, ['rev-parse', 'HEAD']), merged.mergeCommit);
  assert.equal(await git(integration.worktree, ['status', '--porcelain=v1', '--untracked-files=all']), '');
  const mergeHead = await execute('git', ['rev-parse', '-q', '--verify', 'MERGE_HEAD'], {
    cwd: integration.worktree,
    allowFailure: true,
  });
  assert.notEqual(mergeHead.code, 0);
});

test('Retrying an already integrated task returns the original merge without a second commit', async t => {
  const f = await fixture(t);
  const integration = await ensureIntegration({ root: f.root, projectId, worktreeHome: f.worktreeHome });
  const first = await f.taskHead('first', integration.head, { 'first.txt': 'first\n' });
  const input = { worktree: integration.worktree, taskId: 'first', taskHead: first, writePaths: ['first.txt'] };
  const merged = await mergeTask({ ...input, savePending: async () => {} });
  // The coordinator crashed before recording `merged`; the retry must not merge again.
  const recorder = pendingRecorder(integration.worktree);
  assert.deepEqual(await mergeTask({ ...input, savePending: recorder.savePending }), merged);
  assert.deepEqual(recorder.calls, []);
  assert.equal(await git(integration.worktree, ['rev-parse', 'HEAD']), merged.mergeCommit);
  assert.equal(await git(integration.worktree, ['rev-list', '--count', `${integration.head}..HEAD`]), '2');
});

test('Files outside the task write paths roll the merge back with a scope code', async t => {
  const f = await fixture(t);
  const user = await f.user();
  const integration = await ensureIntegration({ root: f.root, projectId, worktreeHome: f.worktreeHome });
  const escaped = await f.taskHead('first', integration.head, { 'first.txt': 'first\n', 'other.txt': 'other\n' });
  const recorder = pendingRecorder(integration.worktree);
  await code(
    mergeTask({
      worktree: integration.worktree,
      taskId: 'first',
      taskHead: escaped,
      writePaths: ['first.txt'],
      savePending: recorder.savePending,
    }),
    'project_integration_scope',
  );
  assert.equal(recorder.calls.length, 1);
  assert.equal(await git(integration.worktree, ['rev-parse', 'HEAD']), integration.head);
  assert.equal(await git(integration.worktree, ['status', '--porcelain=v1', '--untracked-files=all']), '');
  // A crash between Git's merge and the scope check leaves an unverified merge;
  // the retry checks that recovered merge instead of reporting it as merged.
  await git(integration.worktree, ['merge', '--no-ff', '--no-edit', '-m', 'Kodo: integrate first', escaped]);
  await code(
    mergeTask({
      worktree: integration.worktree,
      taskId: 'first',
      taskHead: escaped,
      writePaths: ['first.txt'],
      savePending: async () => {},
    }),
    'project_integration_scope',
  );
  assert.equal(await git(integration.worktree, ['rev-parse', 'HEAD']), integration.head);
  await code(
    mergeTask({
      worktree: integration.worktree,
      taskId: 'first',
      taskHead: 'e'.repeat(40),
      writePaths: ['first.txt'],
      savePending: async () => assert.fail('an unknown commit is never merged'),
    }),
    'project_integration_invalid',
  );
  // The user's checkout is never a merge target, even for a well scoped task.
  const scoped = await f.taskHead('scoped', integration.head, { 'first.txt': 'first\n' });
  await code(
    mergeTask({
      worktree: f.root,
      taskId: 'scoped',
      taskHead: scoped,
      writePaths: ['first.txt'],
      savePending: async () => {},
    }),
    'project_integration_worktree_invalid',
  );
  assert.deepEqual(await f.user(), user);
});

test('The wave frontier rejects a merge commit missing from the integration branch', async t => {
  const f = await fixture(t);
  const integration = await ensureIntegration({ root: f.root, projectId, worktreeHome: f.worktreeHome });
  const first = await f.taskHead('first', integration.head, { 'first.txt': 'first\n' });
  const merged = await mergeTask({
    worktree: integration.worktree,
    taskId: 'first',
    taskHead: first,
    writePaths: ['first.txt'],
    savePending: async () => {},
  });
  const unmerged = await f.taskHead('second', integration.head, { 'second.txt': 'second\n' });
  assert.equal(
    await waveFrontier({ worktree: integration.worktree, mergeCommits: [merged.mergeCommit] }),
    merged.mergeCommit,
  );
  await code(
    waveFrontier({ worktree: integration.worktree, mergeCommits: [merged.mergeCommit, unmerged] }),
    'project_frontier_integration_missing',
  );
  await code(
    waveFrontier({ worktree: integration.worktree, mergeCommits: ['f'.repeat(40)] }),
    'project_frontier_integration_missing',
  );
});

test('An integration branch without a worktree is attached again without resetting it', async t => {
  const f = await fixture(t);
  const user = await f.user();
  const integration = await ensureIntegration({ root: f.root, projectId, worktreeHome: f.worktreeHome });
  const first = await f.taskHead('first', integration.head, { 'first.txt': 'first\n' });
  const merged = await mergeTask({
    worktree: integration.worktree,
    taskId: 'first',
    taskHead: first,
    writePaths: ['first.txt'],
    savePending: async () => {},
  });
  await git(f.root, ['worktree', 'remove', integration.worktree]);
  assert.equal(await lstat(integration.worktree).catch(() => null), null);
  const attached = await ensureIntegration({ root: f.root, projectId, worktreeHome: f.worktreeHome });
  assert.deepEqual(attached, { ...integration, head: merged.mergeCommit });
  // A directory deleted behind Git's back leaves a prunable registration.
  await rm(attached.worktree, { recursive: true, force: true });
  assert.deepEqual(await ensureIntegration({ root: f.root, projectId, worktreeHome: f.worktreeHome }), attached);
  assert.deepEqual(await f.user(), user);
});

test('A gate head fast-forwards from an unchanged gate head and merges its repairs after other merges', async t => {
  const f = await fixture(t);
  const integration = await ensureIntegration({ root: f.root, projectId, worktreeHome: f.worktreeHome });
  const worktree = integration.worktree;
  // The gate started at the integration head; its repair committed on top of it.
  const repaired = await f.taskHead('gate-one', integration.head, { 'gate.txt': 'gate\n' });
  assert.equal(await mergeBackGate({ worktree, expectedHead: integration.head, gateHead: repaired }), repaired);
  assert.equal(await mergeBackGate({ worktree, expectedHead: integration.head, gateHead: repaired }), repaired);
  // A second gate started at `repaired`; meanwhile another task merge advanced the branch.
  const laterGate = await f.taskHead('gate-two', repaired, { 'gate.txt': 'gate two\n' });
  const task = await f.taskHead('first', repaired, { 'first.txt': 'first\n' });
  const merged = await mergeTask({
    worktree,
    taskId: 'first',
    taskHead: task,
    writePaths: ['first.txt'],
    savePending: async () => {},
  });
  const head = await mergeBackGate({ worktree, expectedHead: repaired, gateHead: laterGate });
  assert.deepEqual(await parents(worktree, head), [merged.mergeCommit, laterGate]);
  assert.equal(await git(worktree, ['rev-parse', 'HEAD']), head);
  // The verified head must descend from the gate head, which the branch must still contain.
  const unrelated = await f.taskHead('gate-three', integration.head, { 'other.txt': 'other\n' });
  await code(mergeBackGate({ worktree, expectedHead: head, gateHead: unrelated }), 'project_integration_invalid');
  await code(mergeBackGate({ worktree, gateHead: laterGate }), 'project_integration_invalid');
  const foreignBase = await f.taskHead('gate-four', unrelated, { 'other.txt': 'four\n' });
  await code(
    mergeBackGate({ worktree, expectedHead: unrelated, gateHead: foreignBase }),
    'project_integration_invalid',
  );
  assert.equal(await git(worktree, ['rev-parse', 'HEAD']), head, 'a refused merge-back never moves the branch');
});

test('A gate repair is in scope only as a descendant of the gate head inside the covered write paths', async t => {
  const f = await fixture(t);
  const integration = await ensureIntegration({ root: f.root, projectId, worktreeHome: f.worktreeHome });
  const start = integration.head,
    worktree = integration.worktree;
  const scoped = await f.taskHead('repair', start, { 'first.txt': 'repaired\n' });
  const escaped = await f.taskHead('repair-out', start, { 'other.txt': 'escaped\n' });
  assert.equal(await gateRepairInScope({ worktree, from: start, to: start, writePaths: ['first.txt'] }), true);
  assert.equal(await gateRepairInScope({ worktree, from: start, to: scoped, writePaths: ['first.txt'] }), true);
  assert.equal(await gateRepairInScope({ worktree, from: start, to: escaped, writePaths: ['first.txt'] }), false);
  assert.equal(await gateRepairInScope({ worktree, from: scoped, to: escaped, writePaths: ['other.txt'] }), false);
  await code(gateRepairInScope({ worktree, from: start, to: scoped, writePaths: [] }), 'project_integration_invalid');
});

test('A retry after a crash before the merge commit aborts only its own interrupted merge', async t => {
  const f = await fixture(t);
  const integration = await ensureIntegration({ root: f.root, projectId, worktreeHome: f.worktreeHome });
  const worktree = integration.worktree;
  const mergeHead = async () =>
    (
      await execute('git', ['rev-parse', '-q', '--verify', 'MERGE_HEAD'], { cwd: worktree, allowFailure: true })
    ).stdout.trim();
  const first = await f.taskHead('first', integration.head, { 'first.txt': 'first\n' });
  // The coordinator saved `before`, Git staged the merge, and the process died before the commit.
  const pending = { before: integration.head };
  await git(worktree, ['merge', '--no-ff', '--no-commit', first]);
  assert.equal(await mergeHead(), first);
  assert.notEqual(await git(worktree, ['status', '--porcelain=v1']), '');
  const merged = await mergeTask({
    worktree,
    taskId: 'first',
    taskHead: first,
    writePaths: ['first.txt'],
    savePending: async () => {},
    pending,
  });
  assert.deepEqual(await parents(worktree, merged.mergeCommit), [integration.head, first]);
  assert.equal(merged.before, integration.head);
  assert.equal(await mergeHead(), '');
  assert.equal(await git(worktree, ['status', '--porcelain=v1', '--untracked-files=all']), '');
  // An interrupted merge of another head, or without a saved `before`, is someone else's: refused, kept.
  const second = await f.taskHead('second', merged.mergeCommit, { 'second.txt': 'second\n' });
  const foreign = await f.taskHead('foreign', merged.mergeCommit, { 'foreign.txt': 'foreign\n' });
  await git(worktree, ['merge', '--no-ff', '--no-commit', foreign]);
  const input = {
    worktree,
    taskId: 'second',
    taskHead: second,
    writePaths: ['second.txt'],
    savePending: async () => {},
  };
  await code(mergeTask({ ...input, pending: { before: merged.mergeCommit } }), 'project_integration_worktree_invalid');
  await code(mergeTask(input), 'project_integration_worktree_invalid');
  await code(mergeTask({ ...input, pending: { before: 'not-a-sha' } }), 'project_integration_invalid');
  assert.equal(await mergeHead(), foreign, 'a foreign merge is never aborted');
});

test('A foreign unfinished Git operation with a clean status is refused before any merge and kept intact', async t => {
  const f = await fixture(t);
  const integration = await ensureIntegration({ root: f.root, projectId, worktreeHome: f.worktreeHome });
  const worktree = integration.worktree;
  const state = async name =>
    (await execute('git', ['rev-parse', '-q', '--verify', name], { cwd: worktree, allowFailure: true })).stdout.trim();
  const first = await f.taskHead('first', integration.head, { 'first.txt': 'first\n' });
  const merged = await mergeTask({
    worktree,
    taskId: 'first',
    taskHead: first,
    writePaths: ['first.txt'],
    savePending: async () => {},
  });
  const head = merged.mergeCommit;
  // Someone else merges a branch with the same change: MERGE_HEAD exists while the status is empty.
  const twin = await f.taskHead('twin', integration.head, { 'first.txt': 'first\n' });
  await git(worktree, ['merge', '--no-ff', '--no-commit', twin]);
  assert.equal(await state('MERGE_HEAD'), twin);
  assert.equal(await git(worktree, ['status', '--porcelain=v1', '--untracked-files=all']), '');
  const second = await f.taskHead('second', head, { 'second.txt': 'second\n' });
  const input = {
    worktree,
    taskId: 'second',
    taskHead: second,
    writePaths: ['second.txt'],
    savePending: async () => assert.fail('a refused merge never saves pending'),
  };
  const gateHead = await f.taskHead('gate', head, { 'gate.txt': 'gate\n' });
  for (const attempt of [
    () => mergeTask(input),
    () => mergeTask({ ...input, pending: { before: head } }),
    () => mergeTask({ ...input, pending: { before: integration.head } }),
    () => mergeBackGate({ worktree, expectedHead: head, gateHead }),
  ]) {
    await code(attempt(), 'project_integration_worktree_invalid');
    assert.equal(await state('MERGE_HEAD'), twin, 'a foreign merge is never aborted');
    assert.equal(await git(worktree, ['rev-parse', 'HEAD']), head);
  }
  await git(worktree, ['merge', '--abort']);
  // An empty cherry-pick keeps CHERRY_PICK_HEAD with a clean status as well.
  const picked = await f.taskHead('picked', integration.head, { 'first.txt': 'first\n' });
  const cherry = await execute('git', ['cherry-pick', picked], { cwd: worktree, allowFailure: true });
  assert.notEqual(cherry.code, 0);
  assert.equal(await state('CHERRY_PICK_HEAD'), picked);
  assert.equal(await git(worktree, ['status', '--porcelain=v1', '--untracked-files=all']), '');
  await code(mergeTask({ ...input, pending: { before: head } }), 'project_integration_worktree_invalid');
  await code(mergeBackGate({ worktree, expectedHead: head, gateHead }), 'project_integration_worktree_invalid');
  assert.equal(await state('CHERRY_PICK_HEAD'), picked, 'a foreign cherry-pick is never aborted');
  await git(worktree, ['cherry-pick', '--abort']);
  // A rebase in progress (its state directory) is refused too.
  const rebase = await git(worktree, ['rev-parse', '--path-format=absolute', '--git-path', 'rebase-merge']);
  await mkdir(rebase);
  await code(mergeTask(input), 'project_integration_worktree_invalid');
  await code(mergeBackGate({ worktree, expectedHead: head, gateHead }), 'project_integration_worktree_invalid');
  assert.ok((await lstat(rebase)).isDirectory());
  await rm(rebase, { recursive: true });
  assert.equal(await git(worktree, ['rev-parse', 'HEAD']), head);
  // Once the worktree is free, the same task merges normally.
  const done = await mergeTask({ ...input, savePending: async () => {} });
  assert.deepEqual(await parents(worktree, done.mergeCommit), [head, second]);
});

test('A linked checkout of the integration branch outside the canonical path is busy and never moved', async t => {
  // Review finding (major): ensureIntegration adopted any worktree of kodo/project/<id> and moved its HEAD.
  const f = await fixture(t);
  const before = await f.user();
  const foreign = path.join(f.directory, 'my-checkout');
  await git(f.root, ['worktree', 'add', '-b', integrationBranch(projectId), foreign, before.head]);
  const scoped = await f.taskHead('first', before.head, { 'first.txt': 'first\n' });
  await code(
    ensureIntegration({ root: f.root, projectId, worktreeHome: f.worktreeHome }),
    'project_integration_branch_busy',
  );
  assert.equal(await git(foreign, ['rev-parse', 'HEAD']), before.head, "the user's linked checkout keeps its HEAD");
  assert.equal(await git(foreign, ['branch', '--show-current']), integrationBranch(projectId));
  assert.equal(await lstat(path.join(f.worktreeHome, `project-${projectId}`)).catch(() => null), null);
  assert.ok(scoped);
  // Once the user's checkout leaves the branch, Kodo attaches it at its own canonical path.
  await git(foreign, ['switch', '-q', '--detach']);
  const integration = await ensureIntegration({ root: f.root, projectId, worktreeHome: f.worktreeHome });
  assert.equal(integration.worktree, path.join(f.worktreeHome, `project-${projectId}`, 'integration'));
  assert.deepEqual(await f.user(), before);
});

test('mergeTask inspects every commit of the task: secrets and paths outside scope in the history roll it back', async t => {
  // Review finding (major): only the merged result was checked; a file committed and deleted later
  // stayed reachable from the integration branch.
  const f = await fixture(t);
  const integration = await ensureIntegration({ root: f.root, projectId, worktreeHome: f.worktreeHome });
  const history = async (name, first) => {
    const head = await f.taskHead(name, integration.head, { ...first, [`${name}/${name}.txt`]: `${name}\n` });
    const worktree = path.join(f.directory, 'tasks', name);
    // The next commit undoes the first one's extra files: the merged result alone is clean.
    for (const file of Object.keys(first))
      if (file === 'shared.txt') await git(worktree, ['checkout', integration.head, '--', file]);
      else await git(worktree, ['rm', '-q', file]);
    await git(worktree, ['commit', '-q', '-m', `Clean ${name}`]);
    return { leaked: head, head: await git(worktree, ['rev-parse', 'HEAD']) };
  };
  const secrets = { token: 'kodo-owned-secret-value' };
  for (const [name, first] of [
    ['credentials', { 'credentials/credentials.json': '{"token":"x"}\n' }],
    ['outside', { 'shared.txt': 'escaped\n' }],
    ['content', { 'content/notes.txt': `token ${secrets.token}\n` }],
  ]) {
    const task = await history(name, first);
    await code(
      mergeTask({
        worktree: integration.worktree,
        taskId: name,
        taskHead: task.head,
        writePaths: [`${name}/**`],
        savePending: async () => {},
        secrets,
      }),
      'project_integration_history',
    );
    assert.equal(await git(integration.worktree, ['rev-parse', 'HEAD']), integration.head, name);
    const reachable = await execute('git', ['merge-base', '--is-ancestor', task.leaked, integration.head], {
      cwd: f.root,
      allowFailure: true,
    });
    assert.equal(reachable.code, 1, `${name}: the leaked commit is not on the branch`);
  }
  // A clean history merges as before.
  const clean = await f.taskHead('clean', integration.head, { 'clean/clean.txt': 'clean\n' });
  const merged = await mergeTask({
    worktree: integration.worktree,
    taskId: 'clean',
    taskHead: clean,
    writePaths: ['clean/**'],
    savePending: async () => {},
    secrets,
  });
  assert.equal(merged.status, 'merged');
});

test('A second checkout of the integration branch next to the canonical one is busy before any Git operation', async t => {
  // Review finding (major): only the first worktree of kodo/project/<id> was checked; a second one
  // (git switch --ignore-other-worktrees) was merged into and its HEAD moved.
  const f = await fixture(t);
  const integration = await ensureIntegration({ root: f.root, projectId, worktreeHome: f.worktreeHome });
  // Listed after the canonical worktree, so a check of the first holder alone misses it.
  const second = path.join(f.directory, 'zz-second-checkout');
  await git(f.root, ['worktree', 'add', '--detach', second, integration.head]);
  await git(second, ['switch', '-q', '--ignore-other-worktrees', integrationBranch(projectId)]);
  await code(
    ensureIntegration({ root: f.root, projectId, worktreeHome: f.worktreeHome }),
    'project_integration_branch_busy',
  );
  assert.equal(await git(second, ['rev-parse', 'HEAD']), integration.head, 'the second checkout keeps its HEAD');
  assert.equal(await git(integration.worktree, ['rev-parse', 'HEAD']), integration.head);
  // Once it leaves the branch, the canonical worktree is used again.
  await git(second, ['switch', '-q', '--detach']);
  assert.equal(
    (await ensureIntegration({ root: f.root, projectId, worktreeHome: f.worktreeHome })).worktree,
    integration.worktree,
  );
});

test('History inspection compares raw paths and bytes; content it cannot compare blocks the merge', async t => {
  // Review finding (major): `git cat-file` redacted a provider-shaped known value before the
  // comparison, and a blob of 2 000 000 bytes or more was skipped entirely.
  const f = await fixture(t);
  const integration = await ensureIntegration({ root: f.root, projectId, worktreeHome: f.worktreeHome });
  const providerShaped = `sk-proj-${'A1b2C3d4'.repeat(4)}`;
  const secrets = { openai: providerShaped, other: 'kodo-owned-history-secret' };
  // Commit `files`, delete them in the next commit and finish with a clean file.
  const history = async (name, files) => {
    const leaked = await f.taskHead(name, integration.head, files);
    const worktree = path.join(f.directory, 'tasks', name);
    await git(worktree, ['rm', '-q', '-r', '--', ...Object.keys(files)]);
    await mkdir(path.join(worktree, name), { recursive: true });
    await writeFile(path.join(worktree, name, 'done.txt'), `${name}\n`);
    await git(worktree, ['add', '-A']);
    await git(worktree, ['commit', '-q', '-m', `Clean ${name}`]);
    return { leaked, head: await git(worktree, ['rev-parse', 'HEAD']) };
  };
  const big = Buffer.alloc(16 * 1024 * 1024 + 1, 'x');
  big.write(secrets.other, 1024);
  const cases = [
    ['shaped', { 'shaped/config.txt': `key ${providerShaped}\n` }, 'project_integration_history'],
    ['big', { 'big/blob.bin': big }, 'project_integration_history_unverifiable'],
    // A redacted name (`a&key=[REDACTED]`) hid the secret file name from the path checks.
    ['named', { 'named/a&key=b/credentials.json': '{}\n' }, 'project_integration_history'],
  ];
  for (const [name, files, expected] of cases) {
    const task = await history(name, files);
    await code(
      mergeTask({
        worktree: integration.worktree,
        taskId: name,
        taskHead: task.head,
        writePaths: [`${name}/**`],
        savePending: async () => {},
        secrets,
      }),
      expected,
    );
    assert.equal(await git(integration.worktree, ['rev-parse', 'HEAD']), integration.head, name);
    const reachable = await execute('git', ['merge-base', '--is-ancestor', task.leaked, integration.head], {
      cwd: f.root,
      allowFailure: true,
    });
    assert.equal(reachable.code, 1, `${name}: the leaked commit is not on the branch`);
  }
  // Without known values there is nothing to compare: a large file merges.
  const plain = await f.taskHead('plain', integration.head, { 'plain/blob.bin': Buffer.alloc(3 * 1024 * 1024, 'y') });
  const merged = await mergeTask({
    worktree: integration.worktree,
    taskId: 'plain',
    taskHead: plain,
    writePaths: ['plain/**'],
    savePending: async () => {},
  });
  assert.equal(merged.status, 'merged');
});

test('Changed paths are raw names: a non-ASCII file inside the write scope is owned, not a quoted Git name', async t => {
  const f = await fixture(t);
  const base = await git(f.root, ['rev-parse', 'HEAD']);
  const head = await f.taskHead('unicode', base, { 'docs/заметка.md': 'note\n' });
  const worktree = path.join(f.directory, 'tasks', 'unicode');
  assert.equal(await git(worktree, ['rev-parse', 'HEAD']), head);
  const { changedFiles } = await import('../runtime/workspace.mjs');
  const { ownsPath } = await import('../runtime/contracts.mjs');
  const files = await changedFiles(worktree, base);
  assert.deepEqual(files, ['docs/заметка.md']);
  assert.equal(ownsPath(['docs'], files[0]), true);
});

test('A changed name that begins with U+FEFF is kept whole: NUL-separated names are never trimmed', async t => {
  const f = await fixture(t);
  const base = await git(f.root, ['rev-parse', 'HEAD']);
  await f.taskHead('bom', base, { '﻿ordinary.txt': 'x\n' });
  const worktree = path.join(f.directory, 'tasks', 'bom');
  const { changedFiles } = await import('../runtime/workspace.mjs');
  const { ownsPath } = await import('../runtime/contracts.mjs');
  const files = await changedFiles(worktree, base);
  assert.deepEqual(files, ['﻿ordinary.txt']);
  // A scope for the trimmed name does not own the real file.
  assert.equal(ownsPath(['ordinary.txt'], files[0]), false);
});
