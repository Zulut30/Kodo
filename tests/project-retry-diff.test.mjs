import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { retryDiff } from '../runtime/project-retry-diff.mjs';
import { captureConflictDiff } from '../runtime/project-external-submission.mjs';

function git(cwd, ...args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}

async function repository(t) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'kodo-retry-diff-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  git(root, 'init');
  git(root, 'config', 'user.name', 'Kodo Diff');
  git(root, 'config', 'user.email', 'diff@example.invalid');
  const commit = async (name, content) => {
    await writeFile(path.join(root, name), content);
    git(root, 'add', '--all');
    git(root, 'commit', '-m', name);
    return git(root, 'rev-parse', 'HEAD').trim();
  };
  const baseSha = await commit('base.txt', 'base\n');
  const head = await commit('a.txt', 'changed\n');
  return { root, baseSha, head };
}

test('A failing git diff degrades to a structured truncated capture instead of throwing', async t => {
  const { root, baseSha } = await repository(t);
  const missing = 'f'.repeat(40);
  const failed = await retryDiff({ project: root, baseSha }, ['**'], missing, {});
  assert.deepEqual(failed, { diff: '', omittedFiles: [], truncated: true, reason: 'git_diff_failed' });

  const thrown = await retryDiff({ project: root, baseSha }, ['**'], missing, {}, async () => {
    throw Object.assign(new Error('git exited 128'), { code: 128 });
  });
  assert.deepEqual(thrown, { diff: '', omittedFiles: [], truncated: true, reason: 'git_diff_failed' });

  // A failure after streaming part of the patch never leaks the partial diff.
  const partial = await retryDiff({ project: root, baseSha }, ['**'], missing, {}, async (_cmd, _args, options) => {
    options.consumeStdout('1\t0\ta.txt\0\0diff --git a/a.txt b/a.txt\n+partial\n');
    throw new Error('killed');
  });
  assert.equal(partial.diff, '');
  assert.equal(partial.reason, 'git_diff_failed');

  // Signal termination resolves with `code: null` and must also degrade cleanly without partial diff.
  const signalled = await retryDiff({ project: root, baseSha }, ['**'], missing, {}, async (_cmd, _args, options) => {
    options.consumeStdout('1\t0\ta.txt\0\0diff --git a/a.txt b/a.txt\n+partial\n');
    return { stdout: '', stderr: '', code: null };
  });
  assert.deepEqual(signalled, { diff: '', omittedFiles: [], truncated: true, reason: 'git_diff_failed' });
});

test('The happy path keeps its fields and has no failure reason', async t => {
  const { root, baseSha, head } = await repository(t);
  const clean = await retryDiff({ project: root, baseSha }, ['a.txt'], head, {});
  assert.equal(clean.truncated, false);
  assert.deepEqual(clean.omittedFiles, []);
  assert.equal(clean.reason, undefined);
  assert.match(clean.diff, /^diff --git a\/a\.txt b\/a\.txt\n[\s\S]*\+changed\n$/);
});

test('A failed capture is persisted as truncated and keeps the conflict reason of the attempt', async t => {
  const { root, baseSha } = await repository(t);
  const runs = new Map([
    [
      'run-1',
      {
        project: root,
        baseSha,
        externalConflict: {
          writePaths: ['**'],
          previousAttempt: { attemptId: 'a1', headSha: 'f'.repeat(40), reason: 'project_integration_conflict' },
        },
      },
    ],
  ]);
  const store = {
    getRun: id => runs.get(id),
    updateRun: (id, patch) => runs.set(id, { ...runs.get(id), ...patch }),
  };
  const captured = await captureConflictDiff({ store, engine: { secrets: {} } }, 'run-1', ['**']);
  assert.deepEqual(captured, {
    attemptId: 'a1',
    headSha: 'f'.repeat(40),
    reason: 'project_integration_conflict',
    diff: '',
    omittedFiles: [],
    truncated: true,
    diffReason: 'git_diff_failed',
  });
  assert.deepEqual(runs.get('run-1').externalConflict.previousAttempt, captured);
});
