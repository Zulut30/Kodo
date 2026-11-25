import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { fencedBy } from './lease-fence.mjs';

// Lease `project-integration:<projectId>` serializes every change of a wave project's
// integration branch and every transition whose proof reads that branch. The holder's
// async context carries the token: nested calls of the same holder reuse it, and the
// transition authorizer confirms that its caller still holds it while the project store
// commits the transition (the store commits inside the caller's `apply`).
const held = new AsyncLocalStorage();
const fail = code => {
  throw Object.assign(new Error(`Project ${code}`), { code: `project_${code}` });
};

/** @param {string} projectId */
export const integrationLeaseName = projectId => `project-integration:${projectId}`;

/**
 * Run `work` holding lease `project-integration:<projectId>` (waits up to `waitMs`).
 * Reentrant within one async context; the lease is renewed every `heartbeatMs`.
 * @template T
 * @param {any} store the legacy Store
 * @param {string} projectId
 * @param {() => Promise<T>} work
 * @param {{ signal?: AbortSignal, waitMs?: number, heartbeatMs?: number }} [options]
 * @returns {Promise<T>}
 */
export async function withIntegrationLease(store, projectId, work, options = {}) {
  const { signal, waitMs = 120000, heartbeatMs = 10000 } = options;
  const name = integrationLeaseName(projectId),
    outer = held.getStore();
  if (integrationLeaseHeld(store, projectId)) return work();
  // A nested call whose outer holder lost the lease stops at once: it never waits to take the
  // lease again inside work that the outer holder no longer owns.
  if (outer?.has(name)) fail('lease_lost');
  const deadline = Date.now() + waitMs;
  let token;
  while (!(token = store.acquireLease(name, randomUUID(), { ttlMs: 60000, limit: 1 }))) {
    if (signal?.aborted) fail(signal.reason?.code === 'project_lease_lost' ? 'lease_lost' : 'control_blocked');
    if (Date.now() >= deadline) fail('integration_busy');
    await delay(50);
  }
  const timer = setInterval(() => {
    try {
      store.renewLease(token);
    } catch {
      /* A lost renewal surfaces in integrationLeaseHeld or on the next acquisition. */
    }
  }, heartbeatMs);
  timer.unref();
  try {
    // Writes inside are fenced by the token (runtime/lease-fence.mjs): a holder whose lease expired
    // and passed to another holder cannot record a merge or a transition.
    return await held.run(new Map([...(outer ?? []), [name, token]]), () => fencedBy([token], work));
  } finally {
    clearInterval(timer);
    store.releaseLease(token);
  }
}

/**
 * Whether the current async context holds lease `project-integration:<projectId>` in `store`
 * (the lease row still exists; checking renews it).
 * @param {any} store
 * @param {string} projectId
 */
export function integrationLeaseHeld(store, projectId) {
  const token = held.getStore()?.get(integrationLeaseName(projectId));
  if (!token) return false;
  try {
    return store.renewLease(token) === true;
  } catch {
    return false;
  }
}
