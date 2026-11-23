import { createHash } from 'node:crypto';
import { readFile, lstat, mkdir, realpath } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import path from 'node:path';
import { execute } from './command.mjs';
import { secretFile, redact, stateHome, worktreeHome } from './security.mjs';
export async function git(cwd, args, options = {}) {
  return (await execute('git', args, { cwd, ...options })).stdout.trim();
}
export async function diffHash(cwd, baseSha, headSha = 'HEAD') {
  return createHash('sha256')
    .update(
      (
        await execute('git', ['diff', '--binary', `${baseSha}...${headSha}`], { cwd, rawOutput: true })
      ).stdout.trimEnd(),
    )
    .digest('hex');
}
// Private run worktrees never live in the user's checkout. An explicit
// KODO_WORKTREE_HOME wins; a state home inside Git keeps worktrees beside its
// temporary artifact home; the default state home uses the default worktree home.
/** @param {{ storeHome: string, stateInGit?: boolean, artifactHome?: string }} options */
export function worktreeHomeFor({ storeHome, stateInGit = false, artifactHome }) {
  return (
    process.env.KODO_WORKTREE_HOME ||
    (stateInGit
      ? `${artifactHome}-worktrees`
      : path.resolve(storeHome) === stateHome()
        ? worktreeHome()
        : `${storeHome}-worktrees`)
  );
}
export async function inspectProject(project) {
  const root = await git(project, ['rev-parse', '--show-toplevel']);
  const head = await git(root, ['rev-parse', 'HEAD']);
  const dirty = await git(root, ['status', '--porcelain=v1']);
  const branches = await git(root, ['worktree', 'list', '--porcelain']);
  return { root, head, dirty, worktrees: branches };
}
// Hand the next local caller its turn directly; only the head polls SQLite.
const worktreeQueues = new Map();

async function withLocalWorktreeTurn(key, action, remaining, timeoutError, signal) {
  const queue = worktreeQueues.get(key) ?? new Set();
  const turn = Promise.withResolvers();
  queue.add(turn);
  worktreeQueues.set(key, queue);
  try {
    if (queue.size > 1) {
      const timeout = setTimeout(() => turn.reject(timeoutError()), Math.max(0, remaining()));
      const abort = () => turn.reject(signal.reason);
      signal?.addEventListener('abort', abort, { once: true });
      try {
        await turn.promise;
      } finally {
        clearTimeout(timeout);
        signal?.removeEventListener('abort', abort);
      }
    }
    signal?.throwIfAborted();
    return await action();
  } finally {
    const wasHead = queue.values().next().value === turn;
    queue.delete(turn);
    if (!queue.size) worktreeQueues.delete(key);
    else if (wasHead) queue.values().next().value.resolve();
  }
}

/**
 * Serialize repository-wide worktree changes across checkouts and processes.
 * @template T
 * @param {string} project
 * @param {() => Promise<T>} action
 * @param {AbortSignal} [signal]
 * @param {number} [waitMs] Maximum time to acquire the lock, independent of action duration.
 */
export async function withWorktreeLock(project, action, signal = undefined, waitMs = 120000) {
  const started = performance.now();
  const remaining = () => waitMs - (performance.now() - started);
  try {
    signal?.throwIfAborted();
    const { stdout } = await execute('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], {
      cwd: project,
      signal,
      rawOutput: true,
      timeoutMs: waitMs,
    });
    const directory = stdout.replace(/\r?\n$/, '');
    if (!path.isAbsolute(directory)) throw new Error('Git returned a relative common directory');
    const common = await realpath(directory);
    const key = process.platform === 'win32' ? common.toLowerCase() : common;
    const timeoutError = () => {
      const elapsed = Math.round(performance.now() - started);
      return Object.assign(
        new Error(`Timed out waiting for worktree lock in ${common} after ${elapsed} ms (limit ${waitMs} ms)`),
        {
          code: 'timeout',
        },
      );
    };
    signal?.throwIfAborted();
    return await withLocalWorktreeTurn(
      key,
      async () => {
        const { DatabaseSync } = await import('node:sqlite');
        const guard = new DatabaseSync(path.join(common, 'kodo-worktree-guard.sqlite'), { timeout: 0 });
        try {
          for (;;) {
            signal?.throwIfAborted();
            try {
              guard.exec('BEGIN IMMEDIATE');
              break;
            } catch (error) {
              if ((error.errcode & 0xff) !== 5) throw error;
            }
            const left = remaining();
            if (left <= 0) throw timeoutError();
            await delay(Math.min(35, left), undefined, { signal });
          }
          return await action();
        } finally {
          // Closing rolls back the transaction. Process death releases the same OS lock.
          guard.close();
        }
      },
      remaining,
      timeoutError,
      signal,
    );
  } catch (error) {
    if (signal?.aborted && (error === signal.reason || error?.code === 'ABORT_ERR'))
      throw Object.assign(new Error('Worktree registration cancelled', { cause: error }), { code: 'cancelled' });
    throw error;
  }
}

/** @param {{signal?: AbortSignal, waitMs?: number}} [options] */
export async function makeWorktree(project, directory, branch, base, options = {}) {
  const { signal } = options;
  return withWorktreeLock(
    project,
    async () => {
      await mkdir(path.dirname(directory), { recursive: true });
      const exists = await lstat(directory).catch(() => null);
      if (exists) {
        if ((await git(directory, ['branch', '--show-current'], { signal })) !== branch)
          throw new Error('Несоответствие ветки существующего worktree');
        return directory;
      }
      const branchExists =
        (
          await execute('git', ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`], {
            cwd: project,
            allowFailure: true,
            signal,
          })
        ).code === 0;
      await git(
        project,
        branchExists ? ['worktree', 'add', directory, branch] : ['worktree', 'add', '-b', branch, directory, base],
        { signal },
      );
      return directory;
    },
    signal,
    options.waitMs,
  );
}
export async function collectFiles(cwd, task, secrets = {}) {
  const names = (await git(cwd, ['ls-files', '-z'])).split('\0').filter(Boolean);
  const terms = task
    .toLowerCase()
    .split(/\W+/)
    .filter(word => word.length > 3);
  const eligible = names.filter(
    name =>
      !secretFile(name) &&
      !/(^|\/)(node_modules|dist|build|coverage|\.git|vendor)\//.test(name) &&
      !/^skills\/[^/]+\/references\/upstream\//.test(name) &&
      !/(lock\.json|lock\.yaml|\.lock)$/.test(name),
  );
  eligible.sort((a, b) => score(b) - score(a) || a.localeCompare(b));
  function score(name) {
    return (
      (/(package\.json|README|AGENTS|kodo.config)/.test(name) ? 20 : 0) +
      terms.filter(term => name.toLowerCase().includes(term)).length * 5
    );
  }
  const files = [];
  let size = 0;
  for (const name of eligible) {
    if (files.length >= 150 || size >= 450000) break;
    const filename = path.join(cwd, name),
      stat = await lstat(filename);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 50000) continue;
    const data = await readFile(filename);
    if (data.includes(0)) continue;
    files.push({ path: name, content: redact(data.toString('utf8'), secrets) });
    size += data.length;
  }
  return { files, omitted: names.length - files.length, bytes: size };
}
export async function changedFiles(cwd, base) {
  // NUL-separated raw names: Git quotes non-ASCII names in line mode, and redaction must not
  // rewrite a path before it is matched against the task's write scope. Never trimmed: a
  // NUL-separated name may begin with whitespace or U+FEFF.
  const { stdout } = await execute('git', ['diff', '--no-renames', '--name-only', '-z', base], {
    cwd,
    rawOutput: true,
  });
  return stdout.split('\0').filter(Boolean);
}
export async function commitChanges(cwd, message, paths) {
  if (paths === undefined) await git(cwd, ['add', '-A']);
  else {
    if (!Array.isArray(paths)) throw new Error('Commit paths must be an array');
    const selected = paths.map(name => {
      if (
        typeof name !== 'string' ||
        /[\x00-\x1f:]/.test(name) ||
        path.win32.isAbsolute(name) ||
        path.posix.isAbsolute(name)
      )
        throw new Error('Unsafe commit path');
      const relative = name.replaceAll('\\', '/');
      if (relative.split('/').some(part => !part || part === '.' || part === '..'))
        throw new Error('Unsafe commit path');
      return relative;
    });
    const allowed = new Set(selected);
    const staged = (await git(cwd, ['diff', '--cached', '--no-renames', '--name-only', '-z']))
      .split('\0')
      .filter(Boolean);
    if (staged.some(name => !allowed.has(name)))
      throw new Error('Unrelated files are already staged; refusing metadata commit');
    const existing = [];
    for (const name of allowed) {
      const stat = await lstat(path.join(cwd, name)).catch(error => {
        if (error.code === 'ENOENT') return null;
        throw error;
      });
      if (!stat) continue;
      if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`Commit metadata must be a regular file: ${name}`);
      existing.push(name);
    }
    if (existing.length) await git(cwd, ['--literal-pathspecs', 'add', '--all', '--', ...existing]);
  }
  const result = await execute('git', ['diff', '--cached', '--quiet'], { cwd, allowFailure: true });
  if (result.code === 1) await git(cwd, ['commit', '-m', message]);
  else if (result.code !== 0) throw new Error('Не удалось проверить staged changes');
  return git(cwd, ['rev-parse', 'HEAD']);
}
