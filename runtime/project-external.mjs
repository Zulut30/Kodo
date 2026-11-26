/**
 * Pull protocol for external worker chats (PULL_HOSTS: T3 Code, Orca). The host's
 * main chat calls `nextWave` to reserve a batch of non-overlapping wave tasks:
 * each gets its own worktree on branch `kodo/<runId>` from the head of the
 * project's integration branch and a brief for one visible worker chat. The chat
 * works only in that worktree and commits; the main chat then calls
 * `completeTask`, which checks the commit, runs the `task-fast` profile once and
 * hands the verified head to the wave director for integration and epic gates.
 *
 * Transitions go through the one production authorizer
 * (`createProjectTransitionAuthorizer`, wave branch `validateWaveRun`). Attempts
 * are reserved as `project-external:<host>` and their Runs carry
 * `executor: {kind:'external', host}`: the drain never executes them and this
 * protocol never adopts the drain's attempts (`attemptExecutor`).
 *
 * The director's wave functions are ports (`selectWave`, `createWaveContext`,
 * `integrateAndAdvance`, `runPendingGates`), by default from
 * `project-director-waves.mjs`. Kodo never starts or archives the host's chats.
 */
import { assertRemoteBriefPaths, privateBriefRoots } from './remote-brief-paths.mjs';
import { cleanupRemoteRefs, remoteRefs } from './project-remote-transport.mjs';
import { plannedWorktreeHome } from './workspace.mjs';
import { isPullHost } from './job-contracts.mjs';
import { ensureIntegration } from './project-integration.mjs';
import { known } from './project-director.mjs';
import * as waves from './project-director-waves.mjs';
import {
  acquireLeaseWaiting,
  withGateController,
  withHeldLease,
  withProjectSection,
  withWaveAdmissionLeases,
} from './project-controller-lease.mjs';
import { awaitIntegration, openIntegrationQueue } from './project-integration-queue.mjs';
import { DEFAULT_CLI, assertCliPrefix, quotePath } from './cli-command.mjs';
import { MAX_WORKERS, waveCapacity } from './execution-profile.mjs';
import { buildApiCards } from './api-cards.mjs';
import { createApiCardCache } from './wave-context.mjs';
import {
  contractsOf,
  controlOf,
  logEvent,
  need,
  settled,
  shaPattern,
  snapshotOf,
  storeOf,
  uuidPattern,
  wavePorts,
} from './project-external-shared.mjs';
import {
  explainWave,
  initializePlacements,
  reserveRetries,
  reserveSelected,
  resumeInFlight,
  watchWorkers,
} from './project-external-wave.mjs';
import {
  abandonTarget,
  admitSubmission,
  captureConflictDiff,
  externalAttempt,
  replayedMerge,
  verificationFailureStatus,
  verifySubmission,
} from './project-external-submission.mjs';
import { finishCompletion, passStop, runGates, sectionedContext, tryDrain } from './project-external-integration.mjs';

/** The largest batch one `nextWave` call returns. */
export const MAX_WAVE_LIMIT = MAX_WORKERS;
/**
 * Reserve the next wave for an external host: the briefs of this host's running
 * attempts, then new non-overlapping tasks up to the project's available capacity. `cli` is the command
 * prefix of the brief commands and is returned with them (default `kodo`). `blocked` names why
 * the rest waits: task rows `{taskId, code}` and gate rows `{code, kind, id, gateId?, runId?}`
 * (`gateHolds`). An accepted project returns `code: 'project_accepted'` and no briefs.
 * @param {{ repo: any, engine: any, store?: any, contracts?: any, clock?: () => string, buildApiCards?: any }} ctx
 * @param {{ projectId: string, host: string, limit?: number, retryFailed?: boolean, stallMinutes?: number, ports?: any, cli?: string, signal?: AbortSignal }} input
 */
export async function nextWave(ctx, input) {
  const { projectId, host, retryFailed = false, ports, cli = DEFAULT_CLI, signal } = input;
  if (signal?.aborted) throw Object.assign(new Error('Wave cancelled'), { code: 'cancelled' });
  need(isPullHost(host), 'host_unsupported');
  need(
    input.limit === undefined ||
      (Number.isSafeInteger(input.limit) && input.limit >= 1 && input.limit <= MAX_WAVE_LIMIT),
    'limit_invalid',
  );
  assertCliPrefix(cli);
  const C = await contractsOf(ctx),
    store = storeOf(ctx);
  const options = { knownValues: known(ctx.engine) };
  C.assertDirectorSafe(cli, options);
  const snapshot = await snapshotOf(ctx, projectId);
  need(C.isWaveProject(snapshot.project), 'wave_required');
  // An accepted project has nothing left to hand out (and needs no worktree): its own code,
  // never a pause or a stop.
  if (settled.has(snapshot.project.status)) {
    const done = {
      projectId,
      revision: snapshot.revision,
      cli,
      code: `project_${snapshot.project.status}`,
      watch: [],
      briefs: [],
      blocked: [],
    };
    C.assertDirectorSafe(done, options);
    return done;
  }
  controlOf(snapshot);
  // Every brief command names its worktree: the directory new Runs get (the Engine's own
  // priority, KODO_WORKTREE_HOME first) is refused before the lease or any reservation.
  const home = (ctx.engine.store ?? store)?.home;
  if (typeof home === 'string') quotePath(await plannedWorktreeHome(home));
  const stallMinutes = input.stallMinutes ?? 30;
  need(Number.isSafeInteger(stallMinutes) && stallMinutes > 0, 'arguments');
  const pendingDiffs = new Map();
  const result = await withWaveAdmissionLeases(store, projectId, async (checkLease, admissionLost) => {
    const now = Date.parse((ctx.clock ?? (() => new Date().toISOString()))());
    const profile = ctx.repo.getProfile(projectId);
    const maximum = waveCapacity(profile, now);
    need(profile || (input.limit ?? 3) <= maximum, 'limit_invalid');
    const limit = Math.min(input.limit ?? 3, maximum);
    const integration = await ensureIntegration({
      root: snapshot.project.root,
      projectId,
      worktreeHome: await waves.integrationHome(store),
    });
    const state = {
      pendingDiffs,
      ctx,
      C,
      host,
      cli,
      checkLease,
      integration,
      options,
      snapshot: await snapshotOf(ctx, projectId),
      profile,
      maximum,
      now,
      limit,
      inFlight: new Set(),
      briefs: [],
      blocked: [],
      apiCardCache: createApiCardCache(),
      buildApiCards: ctx.buildApiCards ?? buildApiCards,
      signal: signal ? AbortSignal.any([signal, admissionLost]) : admissionLost,
    };

    const canPlan = initializePlacements(state);
    await resumeInFlight(state, !canPlan);
    if (canPlan) {
      await reserveRetries(state, retryFailed);
      await reserveSelected(state, ports);
    }
    const final = await snapshotOf(ctx, projectId);
    if (canPlan) await explainWave(state, final);
    checkLease();
    const revision = final.revision;
    const result = {
      projectId,
      revision,
      cli,
      briefs: state.briefs,
      blocked: state.blocked,
      ...(!maximum && { code: 'waiting_limits' }),
    };
    return result;
  });
  for (const brief of result.briefs) {
    const pending = pendingDiffs.get(brief.attemptId);
    if (pending) {
      brief.previousAttempt = pending.portablePrevious(
        await captureConflictDiff(ctx, pending.priorId, brief.writePaths),
      );
      if (brief.baseRef)
        assertRemoteBriefPaths(brief, privateBriefRoots(storeOf(ctx).getRun(brief.runId), storeOf(ctx).home));
    }
  }
  const watch = await watchWorkers(ctx, result.briefs, stallMinutes, signal);
  const report = { ...result, watch };
  C.assertDirectorSafe(report, options);
  return report;
}
/**
 * Run the pending epic gates of a wave project outside a task completion. A blocked gate is
 * retried (a new gate reservation) only with `retryFailed`: the T3 host's way to continue after
 * the cause of a blocked gate was fixed. One gate pass runs at a time (`project-gates:<id>`,
 * `project_busy` otherwise); its state changes run in short sections under `project:<id>` and the
 * integration lease, while gate Runs of independent epics verify concurrently in their own worktrees
 * and leave the pull protocol available.
 * @param {{ repo: any, engine: any, store?: any, contracts?: any }} ctx
 * @param {{ projectId: string, retryFailed?: boolean, ports?: any, signal?: AbortSignal }} input
 */
export async function runProjectGates(ctx, input) {
  const { projectId, retryFailed = false, signal } = input;
  const C = await contractsOf(ctx);
  need(C.isWaveProject((await snapshotOf(ctx, projectId)).project), 'wave_required');
  const heartbeat = { heartbeatMs: ctx.engine?.leaseHeartbeatMs };
  return withGateController(
    storeOf(ctx),
    projectId,
    async (_, lost) => {
      // The same control states complete-task refuses: a gate pass never reports success for them.
      const controlled = project => project.paused || ['cancelled', 'failed', 'blocked'].includes(project.status);
      const snapshot = await snapshotOf(ctx, projectId);
      if (controlled(snapshot.project))
        return { status: 'blocked', code: 'project_control_blocked', revision: snapshot.revision };
      if (signal?.aborted) return { status: 'blocked', code: 'project_cancelled', revision: snapshot.revision };
      const W = wavePorts(input.ports, ['createWaveContext', 'runPendingGates']);
      const passSignal = signal ? AbortSignal.any([signal, lost]) : lost;
      const waveCtx = sectionedContext(ctx, C, W, projectId, passSignal);
      let gates;
      try {
        gates = await runGates(W, waveCtx, projectId, passSignal, retryFailed === true);
      } catch (error) {
        if (error?.code !== 'project_cancelled' && error?.code !== 'project_lease_lost') throw error;
        const code = lost.aborted ? 'project_lease_lost' : error.code;
        return { status: 'blocked', code, revision: (await snapshotOf(ctx, projectId)).revision };
      }
      // The pass's own stop reason (or a lost controller lease) is never a success.
      const stopped = passStop(gates, lost);
      if (stopped)
        return { status: 'blocked', code: stopped, gates, revision: (await snapshotOf(ctx, projectId)).revision };
      // A pause, cancel or block during the pass (`project pause` takes no gate lease) or an
      // interrupted pass may stop the gates before any ran: never `passed`.
      const after = await snapshotOf(ctx, projectId);
      if (controlled(after.project))
        return { status: 'blocked', code: 'project_control_blocked', gates, revision: after.revision };
      if (signal?.aborted) return { status: 'blocked', code: 'project_cancelled', gates, revision: after.revision };
      const status = Array.isArray(gates.blocked) && gates.blocked.length ? 'blocked' : 'passed';
      return { status, gates, revision: after.revision };
    },
    heartbeat,
  );
}
/**
 * Accept the commit of an external worker: check it, run `task-fast` once and integrate it
 * through the project's integration queue (`integrateAndAdvance`), then run pending epic gates
 * unless deferred. `abandon` blocks the attempt and cancels its Run instead; it requires
 * `attemptId` (CLI `--attempt`), except as an unambiguous repeat of an abandon already recorded
 * with this head (`project_arguments` otherwise). `attemptId` binds the call to one attempt (a
 * stale one is `project_attempt_stale`), and a late abandon of an earlier attempt replays its
 * result without touching the current one.
 *
 * For remote attempts the project section admits the submission. The per-Run verification
 * lease covers fetch, checkout, scope checks and receipt planning. Task-fast runs in a build slot of
 * the machine (`machine`: `{ id, maxHeavyBuilds }`, default one local slot), once per Run at a
 * time. The verified head is queued (`priority`, default 0) and merged by whichever submission
 * drains the queue; this call waits for its row (`integrationWaitMs`, then
 * `project_integration_queue_timeout`; `project_integration_queue_cancelled` on `signal` — the
 * row stays queued for a repeat).
 * @param {{ repo: any, engine: any, store?: any, contracts?: any, clock?: () => string, buildApiCards?: any }} ctx
 * @param {{ projectId: string, taskId: string, head: string, deferGate?: boolean, abandon?: boolean,
 *   commandId?: string, attemptId?: string, receipt?: string, ports?: any, signal?: AbortSignal, priority?: number,
 *   machine?: { id?: string, maxHeavyBuilds?: number }, integrationWaitMs?: number }} input
 */
export async function completeTask(ctx, input) {
  const { projectId, taskId, head, deferGate = false, abandon = false, commandId, signal, attemptId } = input;
  need(typeof head === 'string' && shaPattern.test(head), 'head_invalid');
  need(!(deferGate && abandon), 'arguments');
  need(attemptId === undefined || uuidPattern.test(attemptId), 'arguments');
  const C = await contractsOf(ctx),
    store = storeOf(ctx);
  await externalAttempt(ctx, C, projectId, taskId);
  const section = work => withProjectSection(store, projectId, work, { signal });
  if (abandon) {
    const { result, run } = await section(async () => {
      const target = await externalAttempt(ctx, C, projectId, taskId);
      const result = await abandonTarget(ctx, target, { head, attemptId, commandId });
      return { result, run: target.run };
    });
    if (
      result.status === 'abandoned' &&
      result.attemptId === run.directorBinding.attemptId &&
      remoteRefs(projectId, run)
    ) {
      try {
        const token = await acquireLeaseWaiting(store, 'project-verify:' + run.id, { signal, waitMs: 0 });
        await withHeldLease(store, token, lost =>
          cleanupRemoteRefs(run, signal ? AbortSignal.any([signal, lost]) : lost),
        );
      } catch {
        // Abandon is already durable. GC retries cleanup after the verifier releases the Run.
      }
    }
    return result;
  }
  const step = await section(() => admitSubmission(ctx, C, input));
  if (step.result) {
    if (step.conflictRunId) await captureConflictDiff(ctx, step.conflictRunId, step.task.writePaths);
    return step.result;
  }
  const completion = { ...input, deferGate };
  if (step.replay) return finishCompletion(ctx, C, completion, step.replay, true);
  const { snapshot, attempt, run } = step;
  if (!step.verified) {
    const defect = await verifySubmission(ctx, C, step, input);
    if (defect && 'blocked' in defect)
      return { status: 'blocked', code: defect.blocked, revision: (await snapshotOf(ctx, projectId)).revision };
    // A dependency download failure is the environment, not the submission (15C): blocked.
    if (defect)
      return {
        status: verificationFailureStatus(defect.code),
        ...defect,
        revision: snapshot.revision,
      };
    // A duplicate submission may find this head integrated by the first one: a replay then.
    const replay = await section(async () => {
      const now = await externalAttempt(ctx, C, projectId, taskId);
      if (now.run.externalCompletion?.headSha !== head) return null;
      return (await replayedMerge(ctx, input, now.run)) ?? { replay: now.run };
    });
    if (replay?.replay) return finishCompletion(ctx, C, completion, replay.replay, true);
    if (replay) return replay;
  }
  const W = wavePorts(input.ports, ['createWaveContext', 'integrateAndAdvance', 'runPendingGates']);
  const queue = openIntegrationQueue(store, { clock: ctx.clock });
  const entry = queue.enqueue({
    projectId,
    taskId,
    attemptId: attempt.id,
    runId: run.id,
    baseSha: run.baseSha,
    headSha: head,
    priority: input.priority ?? 0,
  });
  if (entry.status === 'queued') {
    const existing =
      typeof store.events === 'function' &&
      store.events(run.id).some(event => event.type === 'integration_enqueued' && event.data?.seq === entry.seq);
    if (!existing) {
      logEvent(
        store,
        run.id,
        'integration_enqueued',
        { seq: entry.seq, attemptId: attempt.id, headSha: head },
        Date.parse(entry.enqueuedAt),
      );
    }
  }
  const done = await awaitIntegration({
    queue,
    seq: entry.seq,
    signal,
    waitMs: input.integrationWaitMs,
    tryDrain: expired => tryDrain(ctx, C, W, input, expired),
  });
  const outcome = done.outcome;
  if (done.status === 'failed') throw Object.assign(new Error(`Project ${outcome.code}`), { code: outcome.code });
  if (outcome.retry) await captureConflictDiff(ctx, run.id, step.task.writePaths);
  if (done.status === 'rejected')
    return {
      status: outcome.retry ? 'abandoned' : 'blocked',
      ...(outcome.retry && { retry: outcome.retry, reason: outcome.reason }),
      code: outcome.code,
      integration: outcome.integration ?? null,
      revision: outcome.integration?.revision ?? (await snapshotOf(ctx, projectId)).revision,
    };
  return finishCompletion(ctx, C, completion, run, false);
}
