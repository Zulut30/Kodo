import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

const busy = () => Object.assign(new Error('Project busy'), { code: 'project_busy' });

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
