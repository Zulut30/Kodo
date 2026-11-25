import { acquireLeaseWaiting, withHeldLease } from './project-controller-lease.mjs';

// The heavy builds of one machine (task-fast verification) share the semaphore
// `machine-build:<machineId>`: at most `maxHeavyBuilds` run at once across every Kodo process of
// the state home. The lease rows carry a TTL and the holder's pid, so a crashed holder frees its
// slot. A run profile may later name the machine and its limit; the defaults keep one local build.

/** The machine of a build when no run profile names one. */
export const DEFAULT_MACHINE_ID = 'local';
/** Heavy builds that run at once on one machine when no run profile sets a limit. */
export const DEFAULT_MAX_HEAVY_BUILDS = 1;
/** The safety ceiling of any configured limit. */
export const MAX_HEAVY_BUILDS = 64;
const DEFAULT_BUILD_WAIT_MS = 2 * 3600000;

const invalid = () => Object.assign(new Error('Project machine invalid'), { code: 'project_machine_invalid' });

/** @param {string} machineId */
export const machineBuildLeaseName = machineId => `machine-build:${machineId}`;

/**
 * The machine and build limit of `machine` (`{ id?, maxHeavyBuilds? }`) with the defaults;
 * `project_machine_invalid` for anything else.
 * @param {{ id?: string, maxHeavyBuilds?: number } | undefined} machine
 */
export function machineBuildSettings(machine) {
  if (machine === undefined) return { id: DEFAULT_MACHINE_ID, maxHeavyBuilds: DEFAULT_MAX_HEAVY_BUILDS };
  if (!machine || typeof machine !== 'object' || Array.isArray(machine)) throw invalid();
  const { id = DEFAULT_MACHINE_ID, maxHeavyBuilds = DEFAULT_MAX_HEAVY_BUILDS } = machine;
  if (typeof id !== 'string' || !/^[a-z0-9][a-z0-9._-]{0,63}$/i.test(id)) throw invalid();
  if (!Number.isSafeInteger(maxHeavyBuilds) || maxHeavyBuilds < 1 || maxHeavyBuilds > MAX_HEAVY_BUILDS) throw invalid();
  return { id, maxHeavyBuilds };
}

/**
 * Run `work` in one build slot of the machine: waits for a free slot (`project_build_busy` after
 * `waitMs`, `project_cancelled` on `signal`); the slot is renewed while `work` runs, and `work`
 * receives the signal that aborts when a renewal finds the slot gone (TTL expired).
 * @template T
 * @param {any} store the legacy Store (its lease table is shared by the state home)
 * @param {(lost: AbortSignal) => Promise<T>} work
 * @param {{ machine?: { id?: string, maxHeavyBuilds?: number }, signal?: AbortSignal, waitMs?: number,
 *   pollMs?: number, heartbeatMs?: number }} [options]
 * @returns {Promise<T>}
 */
export async function withMachineBuild(store, work, options = {}) {
  const { id, maxHeavyBuilds } = machineBuildSettings(options.machine);
  const token = await acquireLeaseWaiting(store, machineBuildLeaseName(id), {
    limit: maxHeavyBuilds,
    waitMs: options.waitMs ?? DEFAULT_BUILD_WAIT_MS,
    pollMs: options.pollMs ?? 50,
    signal: options.signal,
    busyCode: 'project_build_busy',
  });
  return withHeldLease(store, token, work, options.heartbeatMs);
}
