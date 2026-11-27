import { spawn, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { gitBoundary } from './command.mjs';
import { stopOwnedTree } from './delivery-process.mjs';

const entry = fileURLToPath(import.meta.url);
const lockSettings = ['core.filesRefLockTimeout', 'core.packedRefsTimeout', 'reftable.lockTimeout'];

async function deadline(ms, signal) {
  // Node timers take signed 32-bit delays. spawnSync also accepts longer timeouts.
  const max = 2 ** 31 - 1;
  while (ms > max) {
    await delay(max, undefined, { signal });
    ms -= max;
  }
  return delay(ms, 'timeout', { signal });
}

async function supervise(input, timeoutMs) {
  // Git must be able to finish a pending prepare and clean up locks acquired
  // earlier in the same transaction, even in a repo configured to wait forever.
  const lockBudget = Math.min(timeoutMs, 2 ** 31 - 1);
  const config = lockSettings.flatMap(key => ['-c', `${key}=${lockBudget}`]);
  const { args, env } = gitBoundary([...config, 'update-ref', '--stdin'], process.env);
  const git = spawn('git', args, { env, windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] });
  const timer = new AbortController();
  const expires = performance.now() + timeoutMs;
  let phase = 'preparing';
  const replies = createInterface({ input: git.stdout });
  const closed = new Promise(resolve => {
    git.once('error', () => resolve('unknown'));
    git.once('close', (code, signal) => {
      if (signal || code === null) resolve('unknown');
      else if (code === 0 && phase === 'committed') resolve('committed');
      else resolve(code !== 0 && phase === 'preparing' ? 'refused' : 'unknown');
    });
  });
  replies.on('line', line => {
    if (phase === 'committing' && line === 'commit: ok') phase = 'committed';
    if (phase === 'preparing' && line === 'prepare: ok' && !git.stdin.writableEnded && performance.now() < expires) {
      phase = 'committing';
      git.stdin.end('commit\n');
    }
  });
  git.stdin.on('error', () => {});
  git.stdin.write(input + 'prepare\n');
  try {
    const result = await Promise.race([closed, deadline(timeoutMs, timer.signal)]);
    if (result !== 'timeout') return result;
    // A queued abort lets Git release earlier verify/update locks itself.
    const committing = phase !== 'preparing';
    if (!committing) git.stdin.end('abort\n');
    const grace = committing ? 250 : Math.min(lockBudget + 250, 2 ** 31 - 1);
    if ((await Promise.race([closed, deadline(grace, timer.signal)])) === 'timeout') {
      try {
        await stopOwnedTree(git);
      } catch (error) {
        // If commit was sent, release the SQLite fence only once the writer is gone.
        if (committing) await closed;
        throw error;
      }
    }
    return 'unknown';
  } finally {
    timer.abort();
    replies.close();
  }
}

/**
 * Keep the caller's SQLite fence until the Git writer has stopped. Git for
 * Windows may start a second git.exe which survives a timeout of its launcher.
 * @param {string} cwd
 * @param {string} input
 * @param {number} timeoutMs
 */
export function runRefTransaction(cwd, input, timeoutMs) {
  const { args, env } = gitBoundary(['update-ref', '--stdin'], process.env);
  const options = { cwd, env, input, encoding: /** @type {const} */ ('utf8'), windowsHide: true };
  if (process.platform !== 'win32' || !Number.isInteger(timeoutMs) || timeoutMs <= 0) {
    const result = spawnSync('git', args, { ...options, input: input + 'commit\n', timeout: timeoutMs });
    if (result.error || result.status === null) return 'unknown';
    return result.status === 0 ? 'committed' : 'refused';
  }
  // The supervisor owns the deadline. Killing it here would release the fence
  // while it is still waiting for a descendant of the Git launcher.
  for (const key of Object.keys(env))
    if (/^NODE_(?:OPTIONS|PATH|TEST_CONTEXT|TEST_WORKER_ID)$/i.test(key)) delete env[key];
  const result = spawnSync(process.execPath, [entry, String(timeoutMs)], options);
  if (result.error || result.status !== 0) return 'unknown';
  return result.stdout === 'committed' || result.stdout === 'refused' ? result.stdout : 'unknown';
}

if (process.argv[1] && path.resolve(process.argv[1]) === entry) {
  try {
    const result = await supervise(readFileSync(0, 'utf8'), Number(process.argv[2]));
    process.stdout.write(result);
  } catch {
    process.exitCode = 1;
  }
}
