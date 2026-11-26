// Shared helpers of wave execution (`project-director-waves.mjs`): lifecycle
// predicates, snapshot lookups, command and transition drafts, reservers and
// the integration lease used by integration, gates and the drain.

import { randomUUID } from 'node:crypto';
import { withIntegrationLease as withLease } from './project-integration-lease.mjs';
import { known } from './project-director.mjs';

export const fail = code => {
  throw Object.assign(new Error(`Project ${code}`), { code: `project_${code}` });
};
export const requireValue = (value, code = 'proof_invalid') => {
  if (!value) fail(code);
};
const lifecycle = ['proposed', 'ready', 'running', 'verifying', 'integrated', 'accepted', 'released'];
export const retryStates = ['blocked', 'failed', 'cancelled'];
export const finishedRun = ['succeeded', 'blocked', 'failed', 'cancelled'];
export const nextState = {
  proposed: 'ready',
  ready: 'running',
  reserved: 'running',
  running: 'verifying',
  verifying: 'integrated',
};
export const reached = (status, state) =>
  lifecycle.includes(status) && lifecycle.indexOf(status) >= lifecycle.indexOf(state);
export const settled = status => status === 'accepted' || status === 'released';
export const gateKinds = ['acceptance', 'contract', 'checks', 'review'];
export const taskKinds = ['acceptance', 'contract', 'checks'];
const INTEGRATION_WAIT_MS = 120000;
// --- snapshot and command helpers -------------------------------------------------------------

function assertComplete(snapshot) {
  requireValue(snapshot?.completeness?.tasks, 'snapshot_incomplete');
  for (const [name, count] of Object.entries(snapshot.completeness))
    requireValue(
      count?.complete === true && count.total === snapshot[name]?.length && count.returned === count.total,
      'snapshot_incomplete',
    );
}
export async function snapshotOf(ctx, projectId) {
  const snapshot = await ctx.repo.snapshot(projectId);
  assertComplete(snapshot);
  return snapshot;
}
export const waveProject = (ctx, snapshot) =>
  typeof ctx.contracts.isWaveProject === 'function' && ctx.contracts.isWaveProject(snapshot.project) === true;
export const taskOf = (snapshot, id) => snapshot.tasks.find(row => row.id === id);
export const currentOf = (snapshot, taskId) => snapshot.currentAttempts.find(row => row.taskId === taskId);
export const recordOf = (snapshot, kind, id) =>
  kind === 'project' ? snapshot.project : snapshot[`${kind}s`].find(row => row.id === id);
export function childrenOf(snapshot, kind, id) {
  if (kind === 'project') return snapshot.milestones;
  if (kind === 'milestone') return snapshot.epics.filter(row => row.milestoneId === id);
  return snapshot.tasks.filter(row => row.epicId === id);
}
// Why a gate pass stopped short (`out.stopped`): a pause, cancel or block of the project
// (`project_control_blocked`) or a cancelled signal (`project_cancelled`); null to go on. The pass
// reports it itself, so a caller never infers it from a later snapshot.
export function stopReason(snapshot, signal) {
  // A lost lease is never reported as a cancel or a pause (its signal carries the reason).
  if (signal?.aborted && signal.reason?.code === 'project_lease_lost') return 'project_lease_lost';
  if (controlState(snapshot)) return 'project_control_blocked';
  return signal?.aborted ? 'project_cancelled' : null;
}
export function controlState(snapshot) {
  if (snapshot.project.status === 'cancelled') return 'cancelled';
  if (snapshot.project.paused) return 'paused';
  if (['failed', 'blocked'].includes(snapshot.project.status)) return 'blocked';
  return null;
}
/** The actor of the drain's commands; its `reserveAttempt` events mark native attempts. */
export const NATIVE_RESERVER = 'project-director';
export const EXTERNAL_RESERVER = 'project-external:';
/** The actor with which pull host `host` reserves an attempt (project-external). */
export const externalReserver = host => `${EXTERNAL_RESERVER}${host}`;
export const commandFor = (snapshot, action, options = {}) => ({
  schemaVersion: 1,
  commandId: options.commandId || randomUUID(),
  projectId: snapshot.project.projectId,
  expectedRevision: snapshot.revision,
  actor: NATIVE_RESERVER,
  reason: options.reason || 'Wave project command',
  action,
});
export const transitionAction = (kind, id, to, evidence = [], mappings = []) => ({
  op: 'transition',
  kind,
  id,
  to,
  evidence,
  mappings,
});
export const portsFor = ctx => ({ contracts: ctx.contracts, knownValues: known(ctx.engine) });
export const blockerOf = run => run.blocker?.current?.code ?? run.error?.code ?? `run_${run.state}`;
// --- leases -----------------------------------------------------------------------------------

/**
 * Serialize merges, frontier reads and every transition whose proof reads the integration
 * branch (`project-integration:<id>`, reentrant): the authorizer requires it for
 * task/attempt → integrated and for every acceptance, and it is held until the store commits.
 * A caller that does not hold `project:<id>` itself (complete-task, `kodo project gates`) passes
 * `ctx.exclusive`: each such section then also runs in that short project section (taken first).
 */
export const withIntegrationLease = (ctx, projectId, signal, work) => {
  const leased = () =>
    withLease(ctx.store, projectId, work, {
      signal,
      waitMs: INTEGRATION_WAIT_MS,
      heartbeatMs: ctx.engine.leaseHeartbeatMs || 10000,
    });
  return typeof ctx.exclusive === 'function' ? ctx.exclusive(leased) : leased();
};
