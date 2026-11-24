import { AsyncLocalStorage } from 'node:async_hooks';

// Fencing for TTL leases. A lease holder that stalls past its TTL may still run after another
// holder took the lease; a check before a write would race with that. Instead every state write a
// holder makes checks, inside the write's own SQLite transaction (BEGIN IMMEDIATE), that each lease
// token of its async context still names a live row (`expires > now`). A stale holder's write
// fails with `project_lease_lost` and changes nothing. Git refs are fenced separately by
// compare-and-swap updates (runtime/project-integration.mjs).

const fences = new AsyncLocalStorage();

const lost = () => Object.assign(new Error('Project lease lost'), { code: 'project_lease_lost' });

/**
 * Run `work` with `tokens` added to the fence of its async context: every fenced write inside it
 * (Store.updateRun, Store.withFence, project store commands, queue rows) first checks them.
 * A token entry may be a string or a function returning the current token (null: none held).
 * @template T
 * @param {Array<string | (() => string | null)>} tokens
 * @param {() => T} work
 * @returns {T}
 */
export function fencedBy(tokens, work) {
  const outer = fences.getStore() ?? [];
  return fences.run([...outer, ...tokens], work);
}

/** The lease tokens that fence writes in the current async context. */
export function currentFence() {
  return (fences.getStore() ?? [])
    .map(entry => (typeof entry === 'function' ? entry() : entry))
    .filter(token => typeof token === 'string');
}

/**
 * Inside an open transaction of `db`: throw `project_lease_lost` unless every token of the current
 * fence (and `extra`) names a lease row that has not expired.
 * @param {any} db
 * @param {string[]} [extra]
 */
export function assertFence(db, extra = []) {
  const tokens = [...currentFence(), ...extra];
  if (!tokens.length) return;
  const live = db.prepare('SELECT 1 FROM leases WHERE token=? AND expires>?');
  const now = Date.now();
  for (const token of tokens) if (!live.get(token, now)) throw lost();
}
