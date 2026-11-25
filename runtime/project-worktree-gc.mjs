import { cleanupRemoteRefs } from './project-remote-transport.mjs';
import path from 'node:path';
import { realpath as fsRealpath } from 'node:fs';
import { promisify } from 'node:util';
import { lstat, readdir, rmdir, readFile, writeFile } from 'node:fs/promises';
import { gitWithoutFilters, inspectCurrentSource } from './ci-graph.mjs';
import { git, withWorktreeLock } from './workspace.mjs';
import { noLinks, inside } from './toolchains.mjs';

const raw = (cwd, args) => git(cwd, args, { rawOutput: true });
const realpath = promisify(fsRealpath.native);
const fold = name => (process.platform === 'win32' ? name.toLowerCase() : name);
const same = (a, b) => fold(path.resolve(a)) === fold(path.resolve(b));
const marker = 'kodo-task-worktree';

async function registration(run) {
  await noLinks(run.project);
  await noLinks(run.worktreeRoot);
  await noLinks(path.join(run.cwd, '.git'));
  const root = await realpath(run.project);
  const cwd = await realpath(run.cwd);
  if (
    inside(root, cwd) ||
    fold(path.basename(cwd)) !== 'integration' ||
    fold(path.basename(path.dirname(cwd))) !== fold(run.id) ||
    !same(await realpath(path.join(run.worktreeRoot, 'integration')), cwd) ||
    run.branch !== `kodo/${run.id}`
  )
    return null;
  const admin = await realpath(await raw(cwd, ['rev-parse', '--absolute-git-dir']));
  const common = await realpath(await raw(root, ['rev-parse', '--path-format=absolute', '--git-common-dir']));
  if (!same(path.dirname(admin), path.join(common, 'worktrees'))) return null;
  const pointer = (await readFile(path.join(admin, 'gitdir'), 'utf8')).trim();
  await noLinks(path.join(cwd, '.git'));
  if (!same(await realpath(path.resolve(admin, pointer)), path.join(cwd, '.git'))) return null;
  return path.join(admin, marker);
}

async function ownershipRecord(run) {
  const dir = await lstat(run.cwd, { bigint: true });
  return [run.id, dir.dev, dir.ino, dir.birthtimeNs].join(':');
}

// Called inside makeWorktree's repository lock only after a successful git worktree add.
export async function markTaskWorktree(run) {
  const file = await registration(run);
  if (!file)
    throw Object.assign(new Error('Не удалось подтвердить регистрацию Git для отметки рабочей копии Kodo'), {
      code: 'worktree_ownership',
    });
  await writeFile(file, await ownershipRecord(run), { flag: 'wx', mode: 0o600 });
}

// Git status can omit empty trees or collapse an entire ignored cache to one record.
async function regularTree(directory) {
  const pending = [directory];
  while (pending.length) {
    const current = pending.pop();
    await noLinks(current);
    for (const entry of await readdir(current, { withFileTypes: true })) {
      if (entry.isDirectory()) pending.push(path.join(current, entry.name));
      else if (!entry.isFile()) return false;
    }
  }
  return true;
}

async function disposableStatus(cwd) {
  const status = await gitWithoutFilters(cwd, [
    'status',
    '--porcelain=v1',
    '--ignored=matching',
    '--untracked-files=normal',
    '-z',
  ]);
  const dirs = new Set();
  for (const record of status.split('\0').filter(Boolean)) {
    if (!record.startsWith('!! ')) return false;
    const file = record.slice(3).replace(/\/$/, '');
    const parts = file.split('/');
    if (parts.some(part => !part || part === '.' || part === '..' || part.includes('\\') || part.includes(':')))
      return false;
    const cache = parts.findIndex(part => part === 'target' || part === 'node_modules');
    if (cache < 0) return false;
    dirs.add(path.join(cwd, ...parts.slice(0, cache + 1)));
  }
  for (const dir of dirs) {
    await noLinks(dir);
    if (!(await lstat(dir)).isDirectory()) return false;
  }
  return regularTree(cwd);
}

async function removeOwned(run, head, renew) {
  await noLinks(path.dirname(run.cwd));
  const existing = await lstat(run.cwd).catch(error => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (!existing) {
    const records = (await raw(run.project, ['worktree', 'list', '--porcelain', '-z'])).split('\0');
    return records.some(record => record.startsWith('worktree ') && same(record.slice(9), run.cwd))
      ? 'incomplete'
      : null;
  }
  if (!existing.isDirectory() || existing.isSymbolicLink()) return 'incomplete';
  if (!(await lstat(path.join(run.cwd, '.git')).catch(() => null))?.isFile()) return 'incomplete';
  const file = await registration(run).catch(() => null);
  if (
    !file ||
    !(await lstat(file).catch(() => null))?.isFile() ||
    (await readFile(file, 'utf8')) !== (await ownershipRecord(run))
  )
    return 'incomplete';
  const cwd = await realpath(run.cwd);
  if (
    (await raw(cwd, ['branch', '--show-current'])) !== run.branch ||
    (await inspectCurrentSource({ project: cwd, headSha: head })) !== 'clean' ||
    !(await disposableStatus(cwd))
  )
    return 'retained';
  if (!renew() || (await readFile(file, 'utf8')) !== (await ownershipRecord(run))) return 'retained';
  await gitWithoutFilters(run.project, ['worktree', 'remove', '--', cwd]);
  await rmdir(path.dirname(cwd)).catch(error => {
    if (!['ENOTEMPTY', 'ENOENT', 'EEXIST'].includes(error.code)) throw error;
  });
  return 'removed';
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
  const gcListings = new Map();
  const report = { removed: [], retained: [], incomplete: [] };
  for (const run of store.listRuns(project.root)) {
    if (run.directorBinding?.projectId !== project.projectId || !run.directorBinding.attemptId) continue;
    const head = terminalHead(run, snapshot);
    if (!head) continue;
    const token = store.acquireLease('run:' + run.id, 'gc-worktrees');
    if (!token) {
      report.retained.push(run.id);
      continue;
    }
    const controller = new AbortController();
    let lost = false;
    const renew = () => !lost && store.renewLease(token);
    const timer = setInterval(() => {
      try {
        lost = !renew();
        if (lost) controller.abort();
      } catch {
        lost = true;
      }
    }, 10000);
    try {
      await noLinks(run.project);
      await cleanupRemoteRefs(run, controller.signal, gcListings);
      const result = await withWorktreeLock(run.project, () => removeOwned(run, head, renew));
      if (result) report[result].push(run.id);
    } catch {
      report.retained.push(run.id);
    } finally {
      clearInterval(timer);
      store.releaseLease(token);
    }
  }
  return report;
}
