import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { writeFile, unlink, lstat } from 'node:fs/promises';
import { fixture } from './fixtures/quality/helpers.mjs';
import { git, makeWorktree } from '../runtime/workspace.mjs';
import { gcProjectWorktrees, markTaskWorktree } from '../runtime/project-worktree-gc.mjs';

test('GC removes only marked, clean terminal task worktrees and keeps branch history', async t => {
  const { base, project: root } = await fixture(t, { '.gitignore': 'scratch\n' });
  const projectId = 'project',
    head = await git(root, ['rev-parse', 'HEAD']);
  const runs = [];
  for (const id of ['done', 'native', 'abandoned', 'active', 'foreign', 'hidden-edit', 'dirty']) {
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
    if (id === 'dirty') await writeFile(path.join(cwd, 'scratch'), 'keep');
    runs.push(run);
  }
  const gc = () =>
    gcProjectWorktrees(
      { listRuns: () => runs },
      {
        project: { root, projectId },
        currentAttempts: [{ runId: 'native', id: 'native', taskId: 'build', status: 'integrated' }],
        tasks: [{ id: 'build', status: 'integrated' }],
      },
    );
  assert.deepEqual(await gc(), {
    removed: ['done', 'native', 'abandoned'],
    retained: ['foreign', 'hidden-edit', 'dirty'],
  });
  for (const run of runs) {
    assert.equal(await git(root, ['rev-parse', run.branch]), head);
    assert.equal(Boolean(await lstat(run.cwd).catch(() => null)), !['done', 'native', 'abandoned'].includes(run.id));
  }
  await unlink(path.join(runs.at(-1).cwd, 'scratch'));
  assert.deepEqual(await gc(), { removed: ['dirty'], retained: ['foreign', 'hidden-edit'] });
});
