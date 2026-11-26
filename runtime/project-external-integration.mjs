// Integration of verified external submissions (`project-external.mjs`): the
// integration queue drain, epic gate passes and completion of the project
// once the wave director has advanced the integrated tasks.

import { cleanupRemoteRefs } from './project-remote-transport.mjs';
import { headOnIntegrationBranch } from './project-integration.mjs';
import { integrationLeaseHeld, withIntegrationLease } from './project-integration-lease.mjs';
import * as waves from './project-director-waves.mjs';
import { projectSectionHeld, withGateController, withProjectSection } from './project-controller-lease.mjs';
import { drainIntegrationQueue, openIntegrationQueue } from './project-integration-queue.mjs';
import {
  cancelled,
  clockIso,
  clockMs,
  controlledProject,
  logEvent,
  need,
  snapshotOf,
  storeOf,
  wavePorts,
} from './project-external-shared.mjs';
import {
  externalAttempt,
  mergeRecorded,
  scheduleConflictRetry,
  workerStateDefect,
} from './project-external-submission.mjs';

export async function runGates(W, waveCtx, projectId, signal, retryFailed = false) {
  const gates = await W.runPendingGates(waveCtx, { projectId, signal, retryFailed });
  need(gates && typeof gates === 'object', 'wave_ports_invalid');
  return gates;
}
function waveContextOf(ctx, C, W) {
  return W.createWaveContext({
    repo: ctx.repo,
    engine: ctx.engine,
    store: storeOf(ctx),
    contracts: C,
    clock: ctx.clock ?? (() => new Date().toISOString()),
  });
}
// The wave context of a caller that holds no `project:<id>`: every integration-lease section of
// the director also runs in a short project section (`withProjectSection`, taken first).
export function sectionedContext(ctx, C, W, projectId, signal) {
  const store = storeOf(ctx);
  return {
    ...waveContextOf(ctx, C, W),
    exclusive: work => withProjectSection(store, projectId, work, { signal }),
  };
}
// Whether `headSha` is on the project's integration branch (Git decides, not a record; false when
// the branch does not exist).
const headOnBranch = (projectId, run, headSha) =>
  headOnIntegrationBranch({ cwd: run.project, projectId, head: headSha });
// The same answer where only a confirmed one may act: when Git could not read the branch (a locked
// or unreadable object), a published merge must not be taken for an absent one — its `pending`
// record and queue row stay for a later drain instead of being released.
async function headOnBranchKnown(projectId, run, headSha) {
  const on = await headOnBranch(projectId, run, headSha);
  if (on === null)
    throw Object.assign(new Error('Integration branch unreadable'), { code: 'project_integration_unreadable' });
  return on;
}
// Integrate one queued head; the drain holds `project:<id>` and the integration lease. Before any
// Git change the row is checked against the current state: the attempt binding, the verified head
// and base, no abandon or cancel, and the worker's branch and worktree still clean on that head
// (`project_submission_stale` otherwise, nothing merged). A recorded completion is accepted only
// while its merge is on the branch (`project_integration_missing` otherwise). A merge whose
// transitions were refused is `failed`, never `rejected`: a repeated submission continues it.
// The completion is recorded on the Run before the row finishes.
async function integrateQueued(ctx, C, W, waveCtx, entry, signal) {
  const store = storeOf(ctx),
    { projectId, taskId, headSha } = entry;
  const { attempt, run, task, snapshot } = await externalAttempt(ctx, C, projectId, taskId);
  const stale = { status: 'rejected', code: 'project_submission_stale' };
  if (attempt.id !== entry.attemptId || run.id !== entry.runId) return stale;
  if (run.externalConflict?.previousAttempt.headSha === headSha)
    return {
      status: 'rejected',
      code: 'project_integration_conflict_retry',
      retry: run.externalConflict.retry,
      integration: run.externalConflict.integration,
      reason: run.externalConflict.reason,
    };
  if (run.externalCompletion?.headSha === headSha)
    return (await mergeRecorded(projectId, run))
      ? { status: 'integrated', integration: run.externalCompletion.integration }
      : { status: 'rejected', code: 'project_integration_missing' };
  if (run.state !== 'succeeded' || run.headSha !== headSha || run.checks?.headSha !== headSha) return stale;
  if (run.baseSha !== entry.baseSha) return stale;
  if (attempt.status === 'blocked' && run.integration?.code === 'project_integration_conflict' && !cancelled(run))
    return scheduleConflictRetry(ctx, snapshot, task, attempt, run, headSha, run.integration);
  // Git first, then the Run's record: a recorded merge that left the branch is missing.
  if (run.integration?.status === 'merged' && run.integration.mergedHead === headSha) {
    if (!(await mergeRecorded(projectId, run))) return { status: 'rejected', code: 'project_integration_missing' };
  } else if (!(await headOnBranchKnown(projectId, run, headSha))) {
    // A new merge — also after a `pending` record whose merge never reached the branch: the full
    // check of the normal path (attempt, no abandon, the worker's branch and worktree on this head).
    const refused =
      cancelled(run) || !['running', 'verifying'].includes(attempt.status) || (await workerStateDefect(run, headSha));
    if (refused) {
      // Under the integration lease this head is not on the branch: its `pending` record (a merge
      // that never reached the branch) is released, so a new head of the attempt can go on.
      waves.releasePending(store, run.id, headSha, stale.code);
      return stale;
    }
  }
  logEvent(
    store,
    run.id,
    'integration_dequeued',
    { seq: entry.seq, attemptId: entry.attemptId, headSha },
    clockMs(ctx),
  );
  let integration;
  try {
    integration = await W.integrateAndAdvance(waveCtx, { projectId, taskId, run: store.getRun(run.id), signal });
  } catch (error) {
    // The ref transaction found the worker's branch off its verified head: nothing was published.
    if (error?.code === 'project_submission_stale') return stale;
    throw error;
  }
  if (integration?.status !== 'integrated') {
    const code = integration?.code ?? 'project_integration_blocked';
    const after = store.getRun(run.id);
    // A merge that is on the branch but whose transitions were refused is `failed`: a repeated
    // submission continues it. Without a merge on the branch the head is refused.
    const failedMerge =
      code !== 'project_integration_missing' &&
      after.integration?.status === 'merged' &&
      after.integration.mergedHead === headSha &&
      (await mergeRecorded(projectId, after));
    // Fenced like the integrated outcome: a drain that lost its lease records no outcome (the row
    // stays `merging` for the next holder), so telemetry never counts an unfinished merge.
    store.withFence([], () =>
      logEvent(
        store,
        run.id,
        'integration_finished',
        { seq: entry.seq, attemptId: entry.attemptId, headSha, status: failedMerge ? 'failed' : 'rejected', code },
        clockMs(ctx),
      ),
    );
    if (failedMerge) return { status: 'failed', code, merged: true, integration: integration ?? null };
    if (code === 'project_integration_conflict')
      return scheduleConflictRetry(ctx, await snapshotOf(ctx, projectId), task, attempt, after, headSha, integration);
    return { status: 'rejected', code, integration: integration ?? null };
  }
  // Fenced (runtime/lease-fence.mjs) in one transaction: a stale drain writes nothing, and a
  // completion already recorded for this head keeps its gates.
  const integratedAt = clockIso(ctx);
  store.withFence([], () => {
    const recorded = store.getRun(run.id).externalCompletion;
    const gates = recorded?.headSha === headSha ? (recorded.gates ?? null) : null;
    store.updateRun(run.id, {
      externalCompletion: { schemaVersion: 1, headSha, integration, gates, integratedAt },
    });
    logEvent(
      store,
      run.id,
      'integration_finished',
      { seq: entry.seq, attemptId: entry.attemptId, headSha, status: 'integrated' },
      Date.parse(integratedAt),
    );
  });
  return { status: 'integrated', integration };
}
// Drain the integration queue when this caller can take `project:<id>` and the integration lease
// at once (never waiting for them): true after a drain, false while another holder has either.
// The caller's own cancel and deadline (`expired`) end the drain between rows; they never reach
// the integration of rows other callers queued. A lost lease stops the drain, and a row's outcome
// is recorded only while both leases are still owned.
export async function tryDrain(ctx, C, W, input, expired) {
  const { projectId, signal } = input,
    store = storeOf(ctx);
  const waveCtx = sectionedContext(ctx, C, W, projectId, undefined);
  let entered = false;
  try {
    await withProjectSection(
      store,
      projectId,
      lost =>
        withIntegrationLease(
          store,
          projectId,
          async () => {
            entered = true;
            const owned = () =>
              !lost.aborted && projectSectionHeld(store, projectId) && integrationLeaseHeld(store, projectId);
            const snapshot = await snapshotOf(ctx, projectId);
            const scopeOf = entry => snapshot.tasks.find(row => row.id === entry.taskId)?.writePaths ?? null;
            await drainIntegrationQueue({
              queue: openIntegrationQueue(store, { clock: ctx.clock }),
              projectId,
              scopeOf,
              stop: () => signal?.aborted === true || expired() || !owned(),
              integrate: entry => integrateQueued(ctx, C, W, waveCtx, entry, lost),
            });
          },
          { waitMs: 0 },
        ),
      { waitMs: 0 },
    );
    return true;
  } catch (error) {
    if (entered) throw error;
    if (['project_busy', 'project_integration_busy'].includes(error?.code)) return false;
    throw error;
  }
}
const stopCodes = new Set(['project_control_blocked', 'project_cancelled', 'project_lease_lost']);
// Why a gate pass stopped short: its own `stopped` reason, a lost lease, or a blocked row that
// names a stop (never inferred from a later snapshot, which may show the pause already lifted).
export function passStop(gates, lost) {
  if (lost?.aborted) return 'project_lease_lost';
  if (typeof gates?.stopped === 'string') return gates.stopped;
  return (gates?.blocked ?? []).find(row => stopCodes.has(row?.code))?.code ?? null;
}
// After an integration: the pending gates unless deferred, in one gate pass (`project-gates:<id>`;
// `project_busy` while another pass runs — a repeated completion runs them later). The receipt is
// read again inside the pass: recorded gates never run twice. A pass that a cancel, a pause, a
// project stop or a block cut short records nothing (`gates` stays null for a safe repeat) and
// answers `blocked` with that code.
export async function finishCompletion(ctx, C, input, run, replayed) {
  const store = storeOf(ctx),
    { projectId, signal } = input;
  await cleanupRemoteRefs(run, signal);
  const receipt = () => store.getRun(run.id).externalCompletion;
  let completion = receipt(),
    gates = completion.gates,
    code = null;
  if (gates === null && !input.deferGate) {
    const W = wavePorts(input.ports, ['createWaveContext', 'runPendingGates']);
    ({ gates, code } = await withGateController(
      store,
      projectId,
      async (_, lost) => {
        completion = receipt();
        if (completion.gates !== null) return { gates: completion.gates, code: null };
        // The control states and a cancel stop the pass before it starts, as in `project gates`.
        if (signal?.aborted) return { gates: null, code: 'project_cancelled' };
        if (controlledProject((await snapshotOf(ctx, projectId)).project))
          return { gates: null, code: 'project_control_blocked' };
        const passSignal = signal ? AbortSignal.any([signal, lost]) : lost;
        let result;
        try {
          result = await runGates(W, sectionedContext(ctx, C, W, projectId, passSignal), projectId, passSignal);
        } catch (error) {
          if (error?.code !== 'project_cancelled' && error?.code !== 'project_lease_lost') throw error;
          return { gates: null, code: lost.aborted ? 'project_lease_lost' : error.code };
        }
        // The pass reports why it stopped short (a control state still in force is a stop as well);
        // then nothing is recorded and a repeat runs the gates.
        const stopped =
          passStop(result, lost) ??
          (signal?.aborted ? 'project_cancelled' : null) ??
          (controlledProject((await snapshotOf(ctx, projectId)).project) ? 'project_control_blocked' : null);
        if (stopped) return { gates: null, code: stopped };
        // Fenced by the gate controller's lease, and only over a receipt without gates.
        try {
          return store.withFence([], () => {
            const current = receipt();
            if (current.gates !== null) return { gates: current.gates, code: null };
            store.updateRun(run.id, { externalCompletion: { ...current, gates: result } });
            return { gates: result, code: null };
          });
        } catch (error) {
          if (error?.code !== 'project_lease_lost') throw error;
          return { gates: null, code: error.code };
        }
      },
      { heartbeatMs: ctx.engine?.leaseHeartbeatMs },
    ));
  }
  const revision = (await snapshotOf(ctx, projectId)).revision;
  return {
    status: code ? 'blocked' : 'integrated',
    ...(code ? { code } : {}),
    integration: completion.integration,
    ...(gates ? { gates } : {}),
    revision,
    ...(replayed ? { replayed: true } : {}),
  };
}
