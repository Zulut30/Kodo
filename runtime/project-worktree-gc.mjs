import path from 'node:path';
import { lstat, readFile, realpath, writeFile } from 'node:fs/promises';
import { inspectCurrentSource } from './ci-graph.mjs';
import { git, withWorktreeLock } from './workspace.mjs';
import { noLinks, inside } from './toolchains.mjs';

const raw = (cwd, args) => git(cwd, args, { rawOutput: true });
const marker = 'kodo-task-worktree';

async function registration(run) {
  await noLinks(run.cwd);
  const root = await realpath(run.project);
  const cwd = await realpath(run.cwd);
  if (
    inside(root, cwd) ||
    path.basename(cwd) !== 'integration' ||
    path.basename(path.dirname(cwd)) !== run.id ||
    path.resolve(run.worktreeRoot, 'integration') !== path.resolve(run.cwd) ||
    run.branch !== `kodo/${run.id}`
  )
    return null;
  const admin = await realpath(await raw(cwd, ['rev-parse', '--absolute-git-dir']));
  const common = await realpath(await raw(root, ['rev-parse', '--path-format=absolute', '--git-common-dir']));
  if (path.dirname(path.dirname(admin)) !== common || path.basename(path.dirname(admin)) !== 'worktrees') return null;
  if ((await realpath((await readFile(path.join(admin, 'gitdir'), 'utf8')).trim())) !== path.join(cwd, '.git'))
    return null;
  return path.join(admin, marker);
}

async function ownershipRecord(run) {
  const dir = await lstat(run.cwd, { bigint: true });
  return [run.id, dir.dev, dir.ino, dir.birthtimeNs].join(':');
}

// Called inside makeWorktree's repository lock only after a successful git worktree add.
export async function markTaskWorktree(run) {
  const file = await registration(run);
  if (file) await writeFile(file, await ownershipRecord(run), { flag: 'wx', mode: 0o600 });
}

async function removeOwned(run, head) {
  const file = await registration(run);
  if (
    !file ||
    !(await lstat(file).catch(() => null))?.isFile() ||
    (await readFile(file, 'utf8')) !== (await ownershipRecord(run))
  )
    return false;
  if (
    (await raw(run.cwd, ['branch', '--show-current'])) !== run.branch ||
    (await inspectCurrentSource({ project: run.cwd, headSha: head })) !== 'clean'
  )
    return false;
  if (await raw(run.cwd, ['status', '--porcelain=v1', '--ignored', '--untracked-files=all'])) return false;
  await raw(run.project, ['worktree', 'remove', '--', run.cwd]);
  return true;
}

function terminalHead(run, snapshot) {
  if (run.executor?.kind === 'external') {
    if (run.externalCompletion?.integration?.status === 'integrated') return run.externalCompletion.headSha;
    if (run.state === 'cancelled' && run.externalAbandon?.attemptId === run.directorBinding.attemptId)
      return run.externalAbandon?.headSha;
    return null;
  }
  const integrated = row => ['integrated', 'accepted', 'released'].includes(row?.status);
  const attempt = snapshot.currentAttempts.find(
    row => row.runId === run.id && row.id === run.directorBinding.attemptId,
  );
  if (
    run.state === 'succeeded' &&
    run.integration?.status === 'merged' &&
    integrated(attempt) &&
    integrated(snapshot.tasks.find(row => row.id === attempt.taskId))
  )
    return run.integration.mergedHead;
  return null;
}

export async function gcProjectWorktrees(store, snapshot) {
  const { project } = snapshot;
  const removed = [],
    retained = [];
  for (const run of store.listRuns(project.root)) {
    if (run.directorBinding?.projectId !== project.projectId || !run.directorBinding.attemptId) continue;
    const head = terminalHead(run, snapshot);
    if (!head || !(await lstat(run.cwd).catch(() => null))) continue;
    try {
      const done = await withWorktreeLock(run.project, () => removeOwned(run, head));
      (done ? removed : retained).push(run.id);
    } catch {
      retained.push(run.id);
    }
  }
  return { removed, retained };
}
