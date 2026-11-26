// Integration of finished wave tasks (`project-director-waves.mjs`): the private
// integration worktree, merges into `kodo/project/<id>` under the integration
// lease and the advance of tasks and their containers up to `integrated`.

import os from 'node:os';
import path from 'node:path';
import { realpath } from 'node:fs/promises';
import { isDeepStrictEqual } from 'node:util';
import { execute } from './command.mjs';
import { worktreeHomeFor } from './workspace.mjs';
import { ensureIntegration, integrationHeadOf, mergeOnBranch, mergeTask } from './project-integration.mjs';
import { fencedPublisher } from './project-publish.mjs';
import { assertWavePolicy } from './wave-policy.mjs';
import { bindingFor, observation, storedRun } from './project-director.mjs';
import {
  childrenOf,
  commandFor,
  controlState,
  currentOf,
  nextState,
  reached,
  recordOf,
  requireValue,
  retryStates,
  snapshotOf,
  taskKinds,
  taskOf,
  transitionAction,
  waveProject,
  withIntegrationLease,
} from './project-wave-shared.mjs';

/**
 * The directory of integration worktrees: beside Run worktrees, never inside a Git
 * checkout that holds the state (same rule as Engine.initializeRun).
 * @param {{ home: string }} store
 */
export async function integrationHome(store) {
  const inGit =
    (await execute('git', ['rev-parse', '--show-toplevel'], { cwd: store.home, allowFailure: true })).code === 0;
  return worktreeHomeFor({
    storeHome: store.home,
    stateInGit: inGit,
    artifactHome: path.join(await realpath(os.tmpdir()), 'kodo-integration'),
  });
}
// --- integration of one task ------------------------------------------------------------------

export async function persistRefs(ctx, run, kinds) {
  requireValue(typeof ctx.engine.persistEvidence === 'function', 'evidence_unavailable');
  const refs = [];
  for (const kind of kinds) {
    const ref = await ctx.engine.persistEvidence(run, `project-${kind}`, observation(run, kind), {
      headSha: run.headSha,
    });
    refs.push({ kind, runId: run.id, headSha: run.headSha, path: ref.path, sha256: ref.sha256 });
  }
  return refs;
}
/** The project's integration branch and its private worktree (created on first use). */
export async function integrationOf(ctx, snapshot) {
  ctx.worktreeHome ??= await integrationHome(ctx.store);
  return ensureIntegration({
    root: snapshot.project.root,
    projectId: snapshot.project.projectId,
    worktreeHome: ctx.worktreeHome,
  });
}
// Whether the merge a task Run recorded is still on the integration branch with its recorded
// parents: a crash, reset or rewrite may have removed it. The caller holds the integration lease.
async function recordedMergePresent(snapshot, run) {
  const integration = run.integration,
    cwd = snapshot.project.root;
  if (integration?.status !== 'merged' || integration.mergedHead !== run.headSha) return false;
  return mergeOnBranch({
    cwd,
    branchHead: await integrationHeadOf({ cwd, projectId: snapshot.project.projectId }),
    mergeCommit: integration.mergeCommit,
    before: integration.before,
    mergedHead: run.headSha,
  });
}
const integrationFailures = [
  'project_integration_conflict',
  'project_integration_scope',
  'project_integration_history',
  'project_integration_history_unverifiable',
  'project_integration_unverified_signature',
];
/**
 * Release the `pending` integration record of `headSha` once it is known that its merge never
 * reached the branch (a refused publish, or a head that is not on the branch under the
 * integration lease). Fenced and conditional: only a `pending` record of this very head changes.
 * @param {any} store
 * @param {string} runId
 * @param {string} headSha
 * @param {string} code
 */
export function releasePending(store, runId, headSha, code) {
  store.withFence([], () => {
    const current = store.getRun(runId);
    const integration = current.integration;
    if (
      integration?.status === 'pending' &&
      current.headSha === headSha &&
      (integration.headSha === undefined || integration.headSha === headSha)
    )
      store.updateRun(runId, { integration: { ...integration, status: 'failed', code } });
  });
}
// Merge the task head once; a recorded or recovered merge is never repeated. A recorded merge
// that left the branch is `project_integration_missing`, never a replayed success.
async function mergeRun(ctx, snapshot, task, run, signal) {
  if (run.integration?.status === 'merged' && run.integration.mergedHead === run.headSha)
    return (await recordedMergePresent(snapshot, run))
      ? run.integration
      : { status: 'failed', code: 'project_integration_missing' };
  const { branch, worktree } = await integrationOf(ctx, snapshot);
  try {
    const merged = await mergeTask({
      signal,
      worktree,
      taskId: task.id,
      taskHead: run.headSha,
      writePaths: task.writePaths,
      // Every commit of the task enters the branch: each one is inspected, not only the result.
      secrets: ctx.engine.secrets,
      savePending: ({ before, mergeCommit }) =>
        ctx.store.updateRun(run.id, {
          integration: { branch, before, mergeCommit, headSha: run.headSha, status: 'pending' },
        }),
      // A crash after savePending may have published the merge without syncing the worktree.
      pending:
        run.integration?.status === 'pending'
          ? {
              before: run.integration.before,
              ...(run.integration.mergeCommit ? { mergeCommit: run.integration.mergeCommit } : {}),
            }
          : null,
      // Published under the holder's lease fence; an external worker's branch must still be on
      // its verified head in the same ref transaction.
      publish: fencedPublisher(ctx.store),
      verify:
        run.executor?.kind === 'external' && typeof run.branch === 'string'
          ? [{ ref: `refs/heads/${run.branch}`, sha: run.headSha }]
          : [],
    });
    const integration = {
      branch: merged.branch,
      before: merged.before,
      mergeCommit: merged.mergeCommit,
      mergedHead: merged.mergedHead,
      status: 'merged',
      mergedAt: ctx.clock(),
    };
    ctx.store.updateRun(run.id, { integration });
    return integration;
  } catch (error) {
    // The ref transaction refused the publish (the worker's branch left its verified head): nothing
    // reached the branch, so this head's `pending` record is released (fenced, this head only) and a
    // new submission of the attempt can be verified and merged.
    if (error?.code === 'project_submission_stale') {
      releasePending(ctx.store, run.id, run.headSha, error.code);
      throw error;
    }
    if (!integrationFailures.includes(error?.code)) throw error;
    const failure = { status: 'failed', code: error.code, ...(error.reason ? { reason: error.reason } : {}) };
    ctx.store.updateRun(run.id, { integration: { branch, before: run.integration?.before ?? null, ...failure } });
    return failure;
  }
}
// attempt and task through running → verifying → integrated, each edge authorized.
async function advanceTask(ctx, projectId, runId, refs) {
  for (const kind of ['attempt', 'task']) {
    for (let step = 0; step < 5; step++) {
      const snapshot = await snapshotOf(ctx, projectId);
      const attempt = snapshot.currentAttempts.find(row => row.runId === runId),
        task = taskOf(snapshot, attempt?.taskId);
      const record = kind === 'attempt' ? attempt : task;
      if (!record || reached(record.status, 'integrated')) break;
      const to = ['blocked', 'failed'].includes(record.status) && kind === 'task' ? 'ready' : nextState[record.status];
      if (!to) return `wave_${kind}_state_invalid`;
      try {
        await ctx.repo.apply(commandFor(snapshot, transitionAction(kind, record.id, to, to === 'ready' ? [] : refs)));
      } catch (error) {
        return error?.code || 'project_transition_blocked';
      }
    }
  }
  return null;
}
/** Containers move through ready..integrated once every child reached that state. */
export async function advanceContainers(ctx, projectId) {
  const blockers = [];
  const first = await snapshotOf(ctx, projectId);
  const entities = [
    ...first.epics.map(row => ['epic', row.id]),
    ...first.milestones.map(row => ['milestone', row.id]),
    ['project', first.project.projectId],
  ];
  for (const [kind, id] of entities) {
    for (let step = 0; step < 4; step++) {
      const snapshot = await snapshotOf(ctx, projectId);
      if (controlState(snapshot)) return blockers;
      const record = recordOf(snapshot, kind, id);
      const to = record ? nextState[record.status] : undefined;
      if (!to) break;
      const children = childrenOf(snapshot, kind, id);
      if (!children.length || !children.every(child => reached(child.status, to))) break;
      try {
        await ctx.repo.apply(commandFor(snapshot, transitionAction(kind, id, to)));
      } catch (error) {
        blockers.push({ code: error?.code || 'project_transition_blocked', kind, id });
        break;
      }
    }
  }
  return blockers;
}
// `wave_policy_mismatch` when the task Run did not verify under the policy of its base, or its head
// changes the policy outside its write paths; `wave_policy_unsafe` when a policy holds a known
// secret or a value the Store would redact; null otherwise.
async function taskPolicy(ctx, run, task) {
  try {
    await assertWavePolicy({
      run,
      policyCommit: run.baseSha,
      headSha: run.headSha,
      writePaths: task.writePaths,
      secrets: ctx.engine.secrets,
    });
    return null;
  } catch (error) {
    if (error?.code === 'project_wave_policy_unsafe') return 'wave_policy_unsafe';
    if (!['project_wave_policy_mismatch', 'project_wave_policy_invalid'].includes(error?.code)) throw error;
    return 'wave_policy_mismatch';
  }
}
/**
 * Merge a finished task Run into the integration branch and advance its attempt and task to
 * `integrated`. Idempotent: a repeat after a crash recovers the recorded or existing merge.
 * @param {any} ctx
 * @param {{ projectId: string, taskId: string, run?: any, signal?: AbortSignal }} input
 */
export async function integrateAndAdvance(ctx, { projectId, taskId, run, signal }) {
  return withIntegrationLease(ctx, projectId, signal, async () => {
    let snapshot = await snapshotOf(ctx, projectId);
    requireValue(waveProject(ctx, snapshot), 'wave_not_enabled');
    const task = taskOf(snapshot, taskId),
      attempt = currentOf(snapshot, taskId);
    requireValue(task, 'task_missing');
    requireValue(attempt && (!run || run.id === attempt.runId), 'binding_invalid');
    let stored = storedRun(ctx.store, attempt.runId);
    requireValue(stored && isDeepStrictEqual(stored.directorBinding, bindingFor(attempt)), 'binding_invalid');
    const blocked = async code => ({ status: 'blocked', code, revision: (await snapshotOf(ctx, projectId)).revision });
    if (reached(attempt.status, 'integrated') && reached(task.status, 'integrated')) {
      // A repeat (crash recovery) is `integrated` only while the recorded merge is on the branch.
      if (!(await recordedMergePresent(snapshot, stored))) return blocked('project_integration_missing');
      await advanceContainers(ctx, projectId);
      return {
        status: 'integrated',
        mergeCommit: stored.integration?.mergeCommit,
        revision: (await snapshotOf(ctx, projectId)).revision,
      };
    }
    if (controlState(snapshot)) return blocked('project_control_blocked');
    if (stored.state !== 'succeeded') return blocked('run_not_succeeded');
    if (stored.verificationProfile !== 'task-fast' || stored.checks?.profile !== 'task-fast')
      return blocked('wave_fast_proof_missing');
    // The task verified under the policy of its base; its head may change it only in its write paths.
    const policy = await taskPolicy(ctx, stored, task);
    const merged = policy ? { status: 'failed', code: policy } : await mergeRun(ctx, snapshot, task, stored, signal);
    if (merged.status !== 'merged') {
      // The result cannot be integrated; an explicit retry starts from the current frontier.
      snapshot = await snapshotOf(ctx, projectId);
      const current = currentOf(snapshot, taskId);
      if (!retryStates.includes(current.status) && !reached(current.status, 'integrated'))
        await ctx.repo.apply(commandFor(snapshot, transitionAction('attempt', current.id, 'blocked')));
      return { ...(await blocked(merged.code)), ...(merged.reason ? { reason: merged.reason } : {}) };
    }
    stored = ctx.store.getRun(stored.id);
    const stop = await advanceTask(ctx, projectId, stored.id, await persistRefs(ctx, stored, taskKinds));
    await advanceContainers(ctx, projectId);
    snapshot = await snapshotOf(ctx, projectId);
    const done = reached(taskOf(snapshot, taskId).status, 'integrated');
    return {
      status: done ? 'integrated' : 'blocked',
      ...(done ? {} : { code: stop ?? 'wave_integration_unverified' }),
      mergeCommit: merged.mergeCommit,
      revision: snapshot.revision,
    };
  });
}
