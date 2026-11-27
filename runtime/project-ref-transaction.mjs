import { spawn, spawnSync } from 'node:child_process';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { gitBoundary } from './command.mjs';

const lockSettings = ['core.filesRefLockTimeout', 'core.packedRefsTimeout', 'reftable.lockTimeout'];
const preparing = 0,
  committing = 1,
  aborting = 2,
  committed = 3,
  refused = 4,
  unknown = 5;

/** @param {{ cwd: string, args: string[], input: string, state: Int32Array, expires: number }} request */
async function supervise({ cwd, args, input, state, expires }) {
  if (Atomics.load(state, 0) !== preparing) return unknown;
  // A cancelled Git must be able to see abort/EOF and clean up its own locks,
  // including when the caller exits before a slow prepare drains.
  const git = spawn('git', args, { cwd, detached: true, windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] });
  let started = false,
    confirmed = false;
  /** @type {Promise<number>} */
  const closed = new Promise(resolve => {
    git.once('spawn', () => {
      started = true;
    });
    git.once('error', () => {}); // A failed spawn also emits close.
    git.once('close', (code, signal) => {
      if (confirmed) resolve(committed);
      else if (started && !signal && code !== null && code !== 0 && Atomics.load(state, 0) === preparing)
        resolve(refused);
      else resolve(unknown);
    });
  });
  const abort = () => {
    if (!git.stdin.writableEnded) git.stdin.end('abort\n');
  };
  parentPort.once('message', abort);
  const replies = createInterface({ input: git.stdout, crlfDelay: Infinity });
  replies.once('error', abort);
  replies.on('line', line => {
    if (line === 'commit: ok' && Atomics.load(state, 0) === committing) confirmed = true;
    if (line !== 'prepare: ok' || git.stdin.writableEnded) return;
    if (performance.now() < expires && Atomics.compareExchange(state, 0, preparing, committing) === preparing) {
      Atomics.notify(state, 0);
      git.stdin.end('commit\n');
    } else abort();
  });
  git.stdin.on('error', () => {});
  git.stdin.write(input + 'prepare\n');
  try {
    return await closed;
  } finally {
    replies.close();
    parentPort.off('message', abort);
  }
}

/**
 * Synchronous inside the caller's SQLite write transaction. The Git protocol
 * runs on a thread of the same process as the fence owner.
 * @param {string} cwd
 * @param {string} input
 * @param {number} timeoutMs
 */
export function runRefTransaction(cwd, input, timeoutMs) {
  const windows = process.platform === 'win32';
  const supervised = windows && Number.isInteger(timeoutMs) && timeoutMs >= 0;
  const lockBudget = Math.min(timeoutMs, 2 ** 31 - 1);
  const config = supervised && lockBudget > 0 ? lockSettings.flatMap(key => ['-c', key + '=' + lockBudget]) : [];
  const { args, env } = gitBoundary([...config, 'update-ref', '--stdin'], process.env);
  // mingw consults this helper before checking whether stdin/stderr are TTYs.
  if (windows) {
    for (const key of Object.keys(env)) if (key.toUpperCase() === 'GIT_ASK_YESNO') delete env[key];
  }
  if (!supervised) {
    const result = spawnSync('git', args, {
      cwd,
      env,
      input: input + 'commit\n',
      timeout: timeoutMs,
      windowsHide: true,
    });
    if (result.error || result.status === null) return 'unknown';
    return result.status === 0 ? 'committed' : 'refused';
  }
  for (const key of Object.keys(env))
    if (/^NODE_(?:OPTIONS|PATH|TEST_CONTEXT|TEST_WORKER_ID)$/i.test(key)) delete env[key];

  const state = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));
  const expires = timeoutMs > 0 ? performance.now() + timeoutMs : Infinity;
  let worker;
  try {
    worker = new Worker(new URL(import.meta.url), {
      env,
      execArgv: [],
      workerData: { cwd, input, args, state, expires },
    });
  } catch {
    return 'unknown';
  }
  worker.on('error', () => {}); // Startup failure cannot authorize a commit.
  Atomics.wait(state, 0, preparing, expires - performance.now());
  if (Atomics.compareExchange(state, 0, preparing, aborting) === preparing) {
    worker.postMessage('abort');
    // Bound the caller's wait for cleanup. A late prepare can only abort.
    if (Atomics.wait(state, 0, aborting, lockBudget + 250) === 'timed-out') {
      // Close the protocol pipes. Only the thread stops; Git owns its cleanup.
      void worker.terminate();
      worker.unref();
    }
    return 'unknown';
  }
  // The worker won permission to send commit or has already finished. Once
  // granted, wait for the real Git writer to close even past the prepare deadline.
  Atomics.wait(state, 0, committing);
  const result = Atomics.load(state, 0);
  return result === committed ? 'committed' : result === refused ? 'refused' : 'unknown';
}

if (!isMainThread && process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let result = unknown;
  try {
    result = await supervise(workerData);
  } finally {
    Atomics.store(workerData.state, 0, result);
    Atomics.notify(workerData.state, 0);
  }
}
