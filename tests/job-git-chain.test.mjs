import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../runtime/store.mjs';
import { openJobStore } from '../runtime/job-store.mjs';
import { runJobQueue } from '../runtime/job-scheduler.mjs';

// One real Git + SQLite chain: every worker commits in its own worktree and
// only the coordinator merges. Proves the prerequisite is integrated before its
// dependent starts, and that a restart never merges a result twice.
const Q = 'project:git-chain';
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true }).trim();

function fixture(t) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'kodo-job-git-'));
  const repo = path.join(root, 'repo'),
    home = path.join(root, 'home');
  git(root, 'init', '-q', '--initial-branch=main', 'repo');
  git(repo, 'config', 'user.email', 'fixture@example.invalid');
  git(repo, 'config', 'user.name', 'Fixture');
  writeFileSync(path.join(repo, 'README.md'), 'fixture\n');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-qm', 'base');
  const stores = [];
  // Close SQLite before removing the directory: Windows keeps open files locked.
  t.after(() => {
    for (const store of stores) store.close();
    rmSync(root, { recursive: true, force: true, maxRetries: 5 });
  });
  const open = () => {
    const store = new Store(home);
    stores.push(store);
    return openJobStore({ store });
  };
  const seenAtStart = {};
  const ports = {
    /** Worker: an isolated worktree from the current integrated head; commits, never merges. */
    async execute(job) {
      const branch = `job/${job.key}-${job.attempt}`,
        worktree = path.join(root, `wt-${job.key}-${job.attempt}`);
      git(repo, 'worktree', 'add', '-q', '-b', branch, worktree, 'main');
      seenAtStart[job.key] = job.spec.dependsOn.map(key => existsSync(path.join(worktree, `${key}.txt`)));
      writeFileSync(path.join(worktree, `${job.key}.txt`), `${job.key}\n`);
      git(worktree, 'add', '-A');
      git(worktree, 'commit', '-qm', `job ${job.key}`);
      return { branch, headSha: git(worktree, 'rev-parse', 'HEAD') };
    },
    /** Coordinator: the only writer of main. */
    async integrate(job) {
      git(repo, 'merge', '-q', '--no-ff', '-m', `integrate ${job.key}`, job.result.headSha);
      return { commit: git(repo, 'rev-parse', 'HEAD'), merged: job.result.headSha };
    },
    /** Did an interrupted merge of this result reach main? */
    async reconcile(job) {
      try {
        git(repo, 'merge-base', '--is-ancestor', job.result.headSha, 'main');
        return { integrated: true, receipt: { commit: git(repo, 'rev-parse', 'main'), merged: job.result.headSha } };
      } catch {
        return { integrated: false };
      }
    },
  };
  const run = (jobs, extra = {}) =>
    runJobQueue({ jobs, queue: Q, owner: 'coordinator', limits: { workers: 2, pools: {} }, ...ports, ...extra });
  const merges = () => git(repo, 'log', '--merges', '--format=%s', 'main').split('\n').filter(Boolean);
  return { repo, open, run, ports, seenAtStart, merges };
}
const spec = (key, extra = {}) => ({ key, role: 'developer', writePaths: [`${key}.txt`], ...extra });

test('Real Git chain: prerequisite is merged before its dependent starts', { timeout: 60000 }, async t => {
  const { repo, open, run, seenAtStart, merges } = fixture(t);
  const jobs = open();
  jobs.enqueue(Q, [spec('a'), spec('b'), spec('c', { dependsOn: ['a'], priority: 100 })]);
  const summary = await run(jobs);
  assert.deepEqual(summary, { status: 'integrated', counts: { integrated: 3 } });
  assert.deepEqual(seenAtStart.c, [true], "the dependent's worktree already contains the prerequisite");
  for (const key of ['a', 'b', 'c']) assert.ok(existsSync(path.join(repo, `${key}.txt`)), key);
  assert.deepEqual(merges().sort(), ['integrate a', 'integrate b', 'integrate c']);
  assert.equal(git(repo, 'status', '--porcelain'), '');
  for (const job of jobs.list(Q)) {
    git(repo, 'merge-base', '--is-ancestor', job.result.headSha, 'main');
    assert.equal(job.integration.merged, job.result.headSha);
  }
});

test('Real Git chain: a crash after the merge is reconciled without a second merge', { timeout: 60000 }, async t => {
  const { open, run, ports, merges } = fixture(t);
  const jobs = open();
  jobs.enqueue(Q, [spec('a'), spec('c', { dependsOn: ['a'] })]);
  // The merge lands, then the coordinator dies before recording its receipt.
  const crashing = {
    async integrate(job) {
      await ports.integrate(job);
      throw new Error('process killed after merge');
    },
  };
  await assert.rejects(run(jobs, crashing), /process killed/);
  assert.deepEqual(merges(), ['integrate a']);
  assert.equal(jobs.list(Q)[0].state, 'integrating');
  // A new process (a second connection) takes the queue over, finds the merge on main and only records it.
  // No short lease and no waiting: a real clock on a slow machine must not decide this test.
  const successor = open();
  successor.takeOver(Q);
  const summary = await run(successor, { owner: 'coordinator-2' });
  assert.equal(summary.status, 'integrated');
  assert.deepEqual(merges().sort(), ['integrate a', 'integrate c'], 'a was merged exactly once');
  assert.ok(
    jobs.list(Q).every(job => job.attempt === 1),
    'no job was executed twice',
  );
});
