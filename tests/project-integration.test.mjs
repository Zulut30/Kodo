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

test('A gate head merges back by fast-forward when possible and by a merge commit otherwise', async t => {
  const f = await fixture(t);
  const integration = await ensureIntegration({ root: f.root, projectId, worktreeHome: f.worktreeHome });
  const gate = await f.taskHead('gate-one', integration.head, { 'gate.txt': 'gate\n' });
  assert.equal(await mergeBackGate({ worktree: integration.worktree, gateHead: gate }), gate);
  assert.equal(await mergeBackGate({ worktree: integration.worktree, gateHead: gate }), gate);
  const laterGate = await f.taskHead('gate-two', gate, { 'gate.txt': 'gate two\n' });
  const task = await f.taskHead('first', gate, { 'first.txt': 'first\n' });
  const merged = await mergeTask({
    worktree: integration.worktree,
    taskId: 'first',
    taskHead: task,
    writePaths: ['first.txt'],
    savePending: async () => {},
  });
  const head = await mergeBackGate({ worktree: integration.worktree, gateHead: laterGate });
  assert.deepEqual(await parents(integration.worktree, head), [merged.mergeCommit, laterGate]);
  assert.equal(await git(integration.worktree, ['rev-parse', 'HEAD']), head);
});
