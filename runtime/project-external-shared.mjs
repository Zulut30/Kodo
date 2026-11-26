// Shared helpers of the external worker pull protocol (`project-external.mjs`):
// argument checks, store/snapshot access, command and transition drafts and
// the run state predicates used by wave admission, submission and integration.

import { randomUUID } from 'node:crypto';
import { execute } from './command.mjs';
import * as waves from './project-director-waves.mjs';

export const shaPattern = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
export const uuidPattern = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
export const settled = new Set(['accepted', 'released']);
export const retryable = new Set(['blocked', 'failed', 'cancelled']);
export const inFlightStates = new Set(['reserved', 'running', 'verifying']);
export const fail = code => {
  throw Object.assign(new Error(`Project ${code}`), { code: `project_${code}` });
};
export const need = (value, code) => {
  if (!value) fail(code);
};
export const storeOf = ctx => ctx.store ?? ctx.engine.store;
export const currentOf = (snapshot, taskId) => snapshot.currentAttempts.find(row => row.taskId === taskId);
export const clockIso = ctx => (typeof ctx?.clock === 'function' ? ctx.clock() : new Date().toISOString());
export const clockMs = ctx => {
  const parsed = typeof ctx?.clock === 'function' ? Date.parse(ctx.clock()) : Date.now();
  return Number.isFinite(parsed) ? parsed : Date.now();
};
export const logEvent = (store, runId, type, data, time) => {
  if (typeof store?.event === 'function') store.event(runId, type, data, time);
};
export async function contractsOf(ctx) {
  return ctx.contracts || (await import('./project-contracts.mjs'));
}
export function wavePorts(ports, names) {
  const loaded = ports ?? waves;
  for (const name of names) need(typeof loaded?.[name] === 'function', 'wave_ports_invalid');
  return loaded;
}
export async function snapshotOf(ctx, projectId) {
  const snapshot = await ctx.repo.snapshot(projectId);
  for (const name of ['milestones', 'epics', 'tasks', 'currentAttempts', 'riskApprovals']) {
    const count = snapshot.completeness?.[name];
    need(count?.complete === true && count.total === snapshot[name]?.length, 'snapshot_incomplete');
  }
  return snapshot;
}
export const command = (snapshot, action, options = {}) => ({
  schemaVersion: 1,
  commandId: options.commandId || randomUUID(),
  projectId: snapshot.project.projectId,
  expectedRevision: snapshot.revision,
  actor: options.actor || 'project-external',
  reason: options.reason || 'External worker pull protocol',
  action,
});
export const transition = (kind, id, to) => ({ op: 'transition', kind, id, to, evidence: [], mappings: [] });
export function controlOf(snapshot) {
  need(
    !snapshot.project.paused &&
      !['cancelled', 'failed', 'blocked', 'accepted', 'released'].includes(snapshot.project.status),
    'control_blocked',
  );
}
export async function ancestor(cwd, base, head) {
  const result = await execute('git', ['merge-base', '--is-ancestor', base, head], { cwd, allowFailure: true });
  need([0, 1].includes(result.code), 'git_invalid');
  return result.code === 0;
}
export const integrationStarted = run => ['merged', 'pending'].includes(run.integration?.status);
export const cancelled = run =>
  Boolean(run.externalAbandon) || run.cancelRequested === true || run.state === 'cancelled';
export const controlledProject = project =>
  project.paused || ['cancelled', 'failed', 'blocked'].includes(project.status);
