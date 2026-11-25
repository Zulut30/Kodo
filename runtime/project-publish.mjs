import { refusedPublish, updateRefsAtomically } from './project-integration.mjs';

// Fenced publish of project refs. A compare-and-swap on a SHA alone does not stop a holder whose
// lease passed on before the new holder moved the branch: that stale holder would still win the
// swap. So the ref change runs inside ONE SQLite write transaction (BEGIN IMMEDIATE) that first
// checks the holder's lease tokens (`expires > now`, one `now`) and then runs the synchronous
// `git update-ref --stdin` transaction. Taking a lease is a write to the same database, so no other
// process can take the lease between the check and the ref change.

/**
 * Publish ref changes fenced by the lease tokens `tokens` and those of the async context:
 * `project_lease_lost` when a token is gone or another holder moved the branch,
 * `project_submission_stale` when a `verify` row (the worker's branch) moved.
 * @param {any} store the legacy Store (its lease table and `withFence`)
 * @param {string[]} tokens
 * @param {string} cwd
 * @param {{ verify?: { ref: string, sha: string }[], update: { ref: string, next: string, expected: string }[] }} commands
 * @param {{ timeoutMs?: number }} [options]
 */
export function publishRefs(store, tokens, cwd, commands, options = {}) {
  try {
    return store.withFence(tokens, () => updateRefsAtomically(cwd, commands, options));
  } catch (error) {
    // Classified after the transaction ended: no Git call while the write lock is held.
    throw refusedPublish(error, cwd, commands.verify);
  }
}

/**
 * The `publish` port of mergeTask/mergeBackGate for a holder whose leases fence its writes.
 * @param {any} store
 */
export const fencedPublisher =
  store =>
  async ({ cwd, verify, update }) =>
    publishRefs(store, [], cwd, { verify, update });
