import { createHash } from 'node:crypto';
import { readFile, lstat, mkdir } from 'node:fs/promises';
import { closeSync, lstatSync, openSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
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
// All participants hold the short SQLite writer lock while inspecting/replacing
// the PID file. A second reaper therefore cannot unlink the successor of a
// dead owner. The OS releases the writer lock if a process dies mid-publication.
function deadWorktreeOwner(filename) {
  const info = lstatSync(filename, { throwIfNoEntry: false });
  if (!info) return false;
  if (!info.isFile() || info.size > 32) throw new Error('Invalid worktree lock file');
  const owner = readFileSync(filename, 'utf8');
  // A crash can leave an incomplete PID record. Give a fresh record time to
  // settle, but recover an abandoned one within the caller's wait budget.
  if (!/^[1-9]\d{0,9}$/.test(owner) || Number(owner) > 0x7fffffff) return Date.now() - info.mtimeMs >= 10000;
  try {
    process.kill(Number(owner), 0);
    return false;
  } catch (error) {
    if (error.code === 'EPERM') return false;
    if (error.code === 'ESRCH') return true;
    throw error;
  }
}

function tryWorktreeLock(guard, filename) {
  try {
    guard.exec('BEGIN IMMEDIATE');
  } catch (error) {
    if (error.errcode === 5) return false; // SQLITE_BUSY: another publisher or reaper.
    throw error;
  }
  try {
    if (deadWorktreeOwner(filename)) unlinkSync(filename);
    const fd = openSync(filename, 'wx', 0o600);
    try {
      writeFileSync(fd, String(process.pid));
    } catch (error) {
      unlinkSync(filename);
      throw error;
    } finally {
      closeSync(fd);
    }
    return true;
  } catch (error) {
    // The previous owner can release while we read its PID.
    if (error.code === 'EEXIST' || error.code === 'ENOENT') return false;
    throw error;
  } finally {
    guard.exec('ROLLBACK');
  }
}

/**
 * Serialize repository-wide worktree registration across checkouts and processes.
 * @template T
 * @param {string} project
 * @param {() => Promise<T>} action
 * @param {AbortSignal} [signal]
 */
export async function withWorktreeLock(project, action, signal = undefined) {
  const waitMs = 30000,
    until = performance.now() + waitMs;
  let filename,
    owned = false;
  try {
    signal?.throwIfAborted();
    const { stdout } = await execute('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], {
      cwd: project,
      signal,
      rawOutput: true,
      timeoutMs: waitMs,
    });
    const common = stdout.replace(/\r?\n$/, '');
    if (!path.isAbsolute(common)) throw new Error('Git returned a relative common directory');
    filename = path.join(common, 'kodo-worktree.lock');
    const { DatabaseSync } = await import('node:sqlite');
    const guard = new DatabaseSync(path.join(common, 'kodo-worktree-guard.sqlite'));
    try {
      while (!owned) {
        signal?.throwIfAborted();
        const remaining = until - performance.now();
        if (remaining <= 0)
          throw Object.assign(new Error('Timed out waiting for worktree registration'), { code: 'timeout' });
        owned = tryWorktreeLock(guard, filename);
        if (!owned) await delay(Math.min(35, remaining), undefined, { signal });
      }
    } finally {
      guard.close();
    }
    signal?.throwIfAborted();
    return await action();
  } catch (error) {
    if (signal?.aborted && (error === signal.reason || error?.code === 'ABORT_ERR'))
      throw Object.assign(new Error('Worktree registration cancelled', { cause: error }), { code: 'cancelled' });
    throw error;
  } finally {
    if (owned) unlinkSync(filename);
  }
}

/** @param {{signal?: AbortSignal}} [options] */
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
