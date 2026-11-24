import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdir, rename, symlink, readFile, writeFile, unlink, lstat } from 'node:fs/promises';
import { fixture, windowsShortPath } from './fixtures/quality/helpers.mjs';
import { git, makeWorktree } from '../runtime/workspace.mjs';
import { gcProjectWorktrees, markTaskWorktree } from '../runtime/project-worktree-gc.mjs';

test('GC removes only marked, clean terminal task worktrees and keeps branch history', async t => {
  const { base, project: root } = await fixture(t, { '.gitignore': 'scratch\ntarget/\nnode_modules/\n' });
  const projectId = 'project',
    head = await git(root, ['rev-parse', 'HEAD']);
  const runs = [];
  for (const id of [
    'done',
    'native',
    'abandoned',
    'active',
    'foreign',
    'cache',
    'linked',
    'empty-link',
    'leased',
    'replaced',
    'missing',
    'hidden-edit',
    'dirty',
  ]) {
    const worktreeRoot = path.join(base, 'trees', id),
      cwd = path.join(worktreeRoot, 'integration'),
      branch = 'kodo/' + id;
    const run = {
      id,
      project: root,
      branch,
      cwd,
      worktreeRoot,
      executor: { kind: 'external' },
      directorBinding: { projectId, attemptId: id },
      state: 'succeeded',
      externalCompletion: { integration: { status: 'integrated' }, headSha: head },
    };
    if (id === 'native') {
      delete run.executor;
      run.integration = { status: 'merged', mergedHead: head };
    }
    if (['native', 'abandoned', 'active'].includes(id)) delete run.externalCompletion;
    if (id === 'abandoned')
      Object.assign(run, { state: 'cancelled', externalAbandon: { attemptId: id, headSha: head } });
    await makeWorktree(root, cwd, branch, head, id === 'foreign' ? {} : { onCreated: () => markTaskWorktree(run) });
    if (id === 'hidden-edit') {
      await git(cwd, ['update-index', '--assume-unchanged', '.gitignore']);
      await writeFile(path.join(cwd, '.gitignore'), 'uncommitted changes');
    }
    if (id === 'empty-link') {
      const outside = path.join(base, 'empty-outside');
      await mkdir(outside);
      await symlink(outside, path.join(cwd, 'empty'), process.platform === 'win32' ? 'junction' : 'dir');
    }
    if (id === 'dirty') await writeFile(path.join(cwd, 'scratch'), 'keep');
    if (id === 'cache' || id === 'linked') {
      await mkdir(path.join(cwd, 'target'));
      if (id === 'linked') {
        await mkdir(path.join(base, 'outside'));
        await writeFile(path.join(base, 'outside', 'keep'), 'safe');
        await symlink(
          path.join(base, 'outside'),
          path.join(cwd, 'target', 'foreign'),
          process.platform === 'win32' ? 'junction' : 'dir',
        );
      } else await writeFile(path.join(cwd, 'target', 'compiled'), 'binary');
    }
    if (id === 'missing' || id === 'replaced') await rename(cwd, cwd + '-old');
    if (id === 'replaced') {
      await mkdir(cwd);
      await writeFile(path.join(cwd, '.git'), await readFile(path.join(cwd + '-old', '.git')));
    }
    if (id === 'cache') {
      await mkdir(path.join(cwd, 'node_modules'));
      await writeFile(path.join(cwd, 'node_modules', 'built'), 'data');
    }
    runs.push(run);
  }
  const gc = () =>
    gcProjectWorktrees(
      {
        listRuns: () => runs,
        acquireLease: name => (name === 'run:leased' ? null : 'token'),
        renewLease: () => true,
        releaseLease() {},
      },
      {
        project: { root, projectId },
        currentAttempts: [{ runId: 'native', id: 'native', taskId: 'build', status: 'integrated' }],
        tasks: [{ id: 'build', status: 'integrated' }],
      },
    );
  assert.deepEqual(await gc(), {
    removed: ['done', 'native', 'abandoned', 'cache'],
    incomplete: ['foreign', 'replaced', 'missing'],
    retained: ['linked', 'empty-link', 'leased', 'hidden-edit', 'dirty'],
  });
  for (const run of runs) {
    assert.equal(await git(root, ['rev-parse', run.branch]), head);
    assert.equal(
      Boolean(await lstat(run.cwd).catch(() => null)),
      !['done', 'native', 'abandoned', 'cache', 'missing'].includes(run.id),
    );
  }
  assert.ok(!(await lstat(runs[0].worktreeRoot).catch(() => null)));
  assert.equal(await readFile(path.join(base, 'outside', 'keep'), 'utf8'), 'safe');
  await unlink(path.join(runs.at(-1).cwd, 'scratch'));
  assert.deepEqual(await gc(), {
    removed: ['dirty'],
    retained: ['linked', 'empty-link', 'leased', 'hidden-edit'],
    incomplete: ['foreign', 'replaced', 'missing'],
  });
});

test('marking wrong ownership fails, rejects linked project roots and accepts Windows aliases', async t => {
  const { base, project } = await fixture(t);
  const worktreeRoot = path.join(base, 'trees with spaces', 'alias');
  const run = { id: 'alias', project, worktreeRoot, cwd: path.join(worktreeRoot, 'integration'), branch: 'kodo/alias' };
  await makeWorktree(project, run.cwd, run.branch, 'HEAD');
  await assert.rejects(markTaskWorktree({ ...run, id: 'wrong' }));
  const alias = path.join(base, 'project-link');
  await symlink(project, alias, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(markTaskWorktree({ ...run, project: alias }));
  if (process.platform === 'win32') {
    run.worktreeRoot = (await windowsShortPath(worktreeRoot)).toUpperCase();
    run.cwd = run.cwd.toLowerCase();
  }
  await markTaskWorktree(run);
  const admin = await git(run.cwd, ['rev-parse', '--absolute-git-dir']);
  assert.ok(await lstat(path.join(admin, 'kodo-task-worktree')));
  const candidate = {
    ...run,
    executor: { kind: 'external' },
    directorBinding: { projectId: 'aliases', attemptId: 'a' },
    externalCompletion: { headSha: await git(project, ['rev-parse', 'HEAD']), integration: { status: 'integrated' } },
  };
  const report = await gcProjectWorktrees(
    { listRuns: () => [candidate], acquireLease: () => 1, renewLease: () => true, releaseLease() {} },
    { project: { root: project, projectId: 'aliases' } },
  );
  assert.deepEqual(report.removed, [run.id]);
});

test('GC neutralizes configured Git filters for ignored status and removal', async t => {
  const { base, project } = await fixture(t);
  const worktreeRoot = path.join(base, 'trees', 'filters');
  const run = {
    id: 'filters',
    project,
    worktreeRoot,
    cwd: path.join(worktreeRoot, 'integration'),
    branch: 'kodo/filters',
    executor: { kind: 'external' },
    directorBinding: { projectId: 'p', attemptId: 'a' },
  };
  const head = await git(project, ['rev-parse', 'HEAD']);
  run.externalCompletion = { headSha: head, integration: { status: 'integrated' } };
  await makeWorktree(project, run.cwd, run.branch, head, { onCreated: () => markTaskWorktree(run) });
  await git(project, ['config', 'filter.fixture.clean', 'cat']);
  const trace = path.join(base, 'trace');
  const saved = process.env.GIT_TRACE2_EVENT;
  process.env.GIT_TRACE2_EVENT = trace;
  try {
    await gcProjectWorktrees(
      { listRuns: () => [run], acquireLease: () => 1, releaseLease() {}, renewLease: () => true },
      { project: { root: project, projectId: 'p' } },
    );
  } finally {
    if (saved === undefined) delete process.env.GIT_TRACE2_EVENT;
    else process.env.GIT_TRACE2_EVENT = saved;
  }
  const calls = (await readFile(trace, 'utf8'))
    .trim()
    .split(/\r?\n/)
    .map(line => JSON.parse(line))
    .filter(e => e.event === 'start')
    .map(e => e.argv);
  for (const predicate of [
    args => args.includes('status') && args.some(a => a.startsWith('--ignored')),
    args => args.includes('worktree') && args.includes('remove'),
  ]) {
    const args = calls.find(predicate);
    assert.ok(args?.includes('filter.fixture.clean='));
  }
});

test('GC lists a half-removed copy with a missing gitfile as incomplete', async t => {
  const { project, base } = await fixture(t);
  const head = await git(project, ['rev-parse', 'HEAD']);
  const worktreeRoot = path.join(base, 'trees', 'partial');
  const run = {
    id: 'partial',
    project,
    worktreeRoot,
    cwd: path.join(worktreeRoot, 'integration'),
    branch: 'kodo/partial',
    directorBinding: { projectId: 'p', attemptId: 'a' },
    executor: { kind: 'external' },
    externalCompletion: { headSha: head, integration: { status: 'integrated' } },
  };
  await makeWorktree(project, run.cwd, run.branch, head, { onCreated: () => markTaskWorktree(run) });
  await unlink(path.join(run.cwd, '.git'));
  const report = await gcProjectWorktrees(
    { listRuns: () => [run], acquireLease: () => 1, renewLease: () => true, releaseLease() {} },
    { project: { root: project, projectId: 'p' } },
  );
  assert.deepEqual(report, { removed: [], retained: [], incomplete: ['partial'] });
});
