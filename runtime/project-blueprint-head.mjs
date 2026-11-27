import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { execute, gitBoundary } from './command.mjs';
import { readBlueprintCommit } from './project-blueprint-io.mjs';

/** Hold the compiled commit through registration, including the Store's SQLite COMMIT.
 * Check HEAD^{commit} under Git's prepared ref locks before entering the Store.
 * @template T
 * @param {string} root
 * @param {string | null} headSha
 * @param {() => Promise<T>} register
 * @returns {Promise<T | null>} null when Git could not lock HEAD at the compiled commit.
 */
export async function withVerifiedBlueprintHead(root, headSha, register) {
  if (!headSha) return null;
  const format = await execute('git', ['rev-parse', '--show-ref-format'], { cwd: root, timeoutMs: 10000 }).catch(
    () => null,
  );
  if (format?.code !== 0) return null;
  // A verify can lock only the linked worktree's private reftable, leaving its
  // shared branch writable. Preparing a deletion locks the actual referent too.
  // Keep the files backend's verify, which does not need the packed-refs lock.
  const operation = format.stdout.trim() === 'reftable' ? 'delete' : 'verify';
  // A repository can configure infinite lock retries. Bound contention so Git
  // can service abort/EOF itself and remove its own locks, on either backend.
  const { args, env } = gitBoundary(
    [
      '-c',
      'core.filesRefLockTimeout=1000',
      '-c',
      'core.packedRefsTimeout=1000',
      '-c',
      'reftable.lockTimeout=1000',
      'update-ref',
      '--stdin',
    ],
    process.env,
  );
  const child = spawn('git', args, { cwd: root, env, windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] });
  const closed = new Promise(resolve => child.once('close', resolve));
  const replies = createInterface({ input: child.stdout, crlfDelay: Infinity });
  const unavailable = () => replies.close();
  child.once('error', unavailable);
  child.stdin.on('error', unavailable);
  const deadline = setTimeout(unavailable, 10000);
  try {
    // Verify the raw ref value first: an annotated tag's object id differs from its commit.
    child.stdin.write(`start\n${operation} HEAD HEAD\nprepare\n`);
    for await (const reply of replies) {
      if (reply !== 'prepare: ok') continue;
      clearTimeout(deadline);
      const commit = await readBlueprintCommit(root).catch(() => null);
      if (commit !== headSha || child.exitCode !== null || child.signalCode !== null) return null;
      return await register();
    }
    return null;
  } finally {
    clearTimeout(deadline);
    // Never commit the prepared operation. Explicit start also makes Git abort
    // on EOF if the caller exits while holding the locks.
    child.stdin.end('abort\n');
    await closed;
  }
}
