import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

const busy = () => Object.assign(new Error('Project busy'), { code: 'project_busy' });
const coded = code => Object.assign(new Error(`Project ${code}`), { code });

/**
 * Acquire lease `name` (at most `limit` holders), polling every `pollMs` until `waitMs` passed
 * (`busyCode`) or `signal` aborted (`project_cancelled`). `waitMs: 0` tries exactly once.
 * The lease row carries a TTL and the holder's pid: a crashed holder never blocks for long.
 * @param {any} store
 * @param {string} name
 * @param {{ limit?: number, ttlMs?: number, waitMs?: number, pollMs?: number, signal?: AbortSignal,
 *   busyCode?: string, now?: () => number }} [options]
 * @returns {Promise<string>} the lease token
 */
export async function acquireLeaseWaiting(store, name, options = {}) {
  const {
    limit = 1,
    ttlMs = 60000,
    waitMs = 120000,
    pollMs = 25,
    signal,
    busyCode = 'project_busy',
    now = () => Date.now(),
  } = options;
  const owner = randomUUID(),
    deadline = now() + waitMs;
  for (;;) {
    if (signal?.aborted) throw coded('project_cancelled');
    const token = store.acquireLease(name, owner, { ttlMs, limit });
    if (token) return token;
    if (now() >= deadline) throw coded(busyCode);
    try {
      await delay(pollMs, undefined, signal ? { signal } : undefined);
    } catch (error) {
      if (signal?.aborted) throw coded('project_cancelled');
      throw error;
    }
  }
}

/**
 * Run `work` holding the lease `token`, renewed every `heartbeatMs`; release it afterwards.
 * @template T
 * @param {any} store
 * @param {string} token
 * @param {() => Promise<T>} work
 * @param {number} [heartbeatMs]
 * @returns {Promise<T>}
 */
export async function withHeldLease(store, token, work, heartbeatMs = 10000) {
  const timer = setInterval(() => {
    try {
      store.renewLease(token);
    } catch {
      // A transient Store failure must not throw from the timer.
    }
  }, heartbeatMs);
  timer.unref();
  try {
    return await work();
  } finally {
    clearInterval(timer);
    store.releaseLease(token);
  }
}

// Short critical sections under `project:<id>`, reentrant within one async context.
const sections = new AsyncLocalStorage();

/**
 * Run `work` in a short critical section under lease `project:<id>`: waits for the lease (unlike
 * the pull controllers, which refuse at once) up to `waitMs`, then `project_busy`; a cancelled
 * `signal` stops the wait with `project_cancelled`. Nested sections of one holder reuse the lease.
 * Used for the parts of complete-task, the integration queue drain and external gate passes
 * that change project state; long work (task-fast, gate Runs) stays outside.
 * @template T
 * @param {any} store
 * @param {string} projectId
 * @param {() => Promise<T>} work
 * @param {{ signal?: AbortSignal, waitMs?: number, pollMs?: number, heartbeatMs?: number }} [options]
 * @returns {Promise<T>}
 */
export async function withProjectSection(store, projectId, work, options = {}) {
  const name = `project:${projectId}`,
    outer = sections.getStore();
  if (outer?.has(name)) return work();
  const token = await acquireLeaseWaiting(store, name, options);
  return withHeldLease(store, token, () => sections.run(new Set([...(outer ?? []), name]), work), options.heartbeatMs);
}

// Gate-producing controllers exclude each other even while a standalone gate releases
// the project lease for tests, independent review and repair in its private worktree.
export const withGateController = (store, projectId, work) =>
  withControllerLease(store, `project-gates:${projectId}`, work);

export function withPullLease(store, projectId, runsGates, work) {
  const run = () => withControllerLease(store, `project:${projectId}`, work);
  return runsGates ? withGateController(store, projectId, run) : run();
}

async function withControllerLease(store, name, work) {
  const owner = randomUUID();
  const acquire = () => store.acquireLease(name, owner, { ttlMs: 60000, limit: 1 });
  let token = acquire();
  if (!token) throw busy();
  const timer = setInterval(() => {
    try {
      if (token) store.renewLease(token);
    } catch {
      // A transient Store failure must not throw from the timer.
    }
  }, 10000);
  timer.unref();
  // Only the standalone gate uses this callback, around the private Run. Rejoin
  // the serialized protocol before inspecting state, merging or accepting anything.
  const outsideLease = async (operation, signal) => {
    store.releaseLease(token);
    token = null;
    const result = await operation();
    const deadline = Date.now() + 120000;
    const cancelled = () => Object.assign(new Error('Project cancelled'), { code: 'project_cancelled' });
    while (!signal?.aborted) {
      token = acquire();
      if (token) return result;
      if (Date.now() >= deadline) throw busy();
      try {
        await delay(50, undefined, { signal });
      } catch (error) {
        if (signal?.aborted) throw cancelled();
        throw error;
      }
    }
    throw cancelled();
  };
  try {
    return await work(outsideLease);
  } finally {
    clearInterval(timer);
    if (token) store.releaseLease(token);
  }
}
