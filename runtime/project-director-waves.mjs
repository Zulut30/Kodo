/**
 * Wave execution of a project with `execution: {cadence: 'wave', integration: 'branch'}`.
 *
 * A wave is a set of ready tasks with disjoint write paths. Each task runs as a
 * native Engine Run with the `task-fast` profile (no delivery, quick mode) from
 * the head of the integration branch `kodo/project/<id>`. A finished task is
 * merged into that branch under the `project-integration:<id>` lease and is
 * advanced at most to `integrated`. One gate Run per epic then verifies the
 * integrated result fully; only that gate accepts tasks, the epic and, when it
 * covers them, the milestone and the project.
 *
 * Context (`createWaveContext`): `{ repo, engine, store, contracts, clock,
 * worktreeHome }`. `repo` is the project store (`openProjectStore`) with the
 * production transition authorizer, `engine` the shared Engine, `store` its
 * legacy Store, `contracts` the project contracts namespace, `clock` an ISO
 * timestamp source and `worktreeHome` the directory of the private
 * integration worktree (outside the user's checkout; by default resolved like
 * Engine run worktrees, see `integrationHome`).
 */
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { makeWorktree } from './workspace.mjs';
import { markTaskWorktree } from './project-worktree-gc.mjs';
import { scopesOverlap } from './contracts.mjs';
import * as projectContracts from './project-contracts.mjs';
import { freeWorkerSlots, waveCapacity, waveHorizon } from './execution-profile.mjs';
import { planProjectHorizon } from './project-planner.mjs';
import { waveFrontier } from './project-integration.mjs';
import { withGateController } from './project-controller-lease.mjs';
import { fencedBy } from './lease-fence.mjs';
import { GATE_WATCHDOG } from './wave-verifier.mjs';
import { normalizeWatchdogConfig } from './watchdog.mjs';
import { applyWavePolicy } from './wave-policy.mjs';
import { createApiCardCache, prepareWaveTaskContext } from './wave-context.mjs';
import { bindingFor, priorRetryRun, retrySettings, storedRun, verifyRef } from './project-director.mjs';
import {
  EXTERNAL_RESERVER,
  NATIVE_RESERVER,
  blockerOf,
  childrenOf,
  commandFor,
  controlState,
  currentOf,
  fail,
  finishedRun,
  portsFor,
  reached,
  requireValue,
  retryStates,
  settled,
  snapshotOf,
  taskOf,
  transitionAction,
  waveProject,
  withIntegrationLease,
} from './project-wave-shared.mjs';
import { integrateAndAdvance, integrationOf } from './project-wave-integration.mjs';
import { gateCandidate, runPendingGates } from './project-wave-gates.mjs';

export { integrationHome, integrationOf, releasePending, integrateAndAdvance } from './project-wave-integration.mjs';
export { NATIVE_RESERVER, externalReserver } from './project-wave-shared.mjs';
export { gateLeaseName, runPendingGates, gateHolds } from './project-wave-gates.mjs';

/**
 * @param {{ repo: any, engine: any, store?: any, contracts?: any, clock?: () => string, worktreeHome?: string }} ports
 */
export function createWaveContext({ repo, engine, store, contracts, clock, worktreeHome } = /** @type {any} */ ({})) {
  const legacy = store ?? engine?.store;
  requireValue(repo && engine && legacy, 'wave_context_invalid');
  return {
    repo,
    engine,
    store: legacy,
    contracts: contracts ?? projectContracts,
    clock: clock ?? (() => new Date().toISOString()),
    worktreeHome,
  };
}
/** The foreground lease `project:<id>` with heartbeat and cancellation polling, as in `resume`. */
async function withProjectControl(ctx, projectId, signal, work) {
  const token = ctx.store.acquireLease(`project:${projectId}`, randomUUID(), { ttlMs: 60000, limit: 1 });
  requireValue(token, 'busy');
  const controller = new AbortController(),
    abort = () => controller.abort();
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) abort();
  let leaseLost = false,
    pollingBusy = false;
  const renew = () => {
    try {
      if (ctx.store.renewLease(token)) return;
    } catch {
      /* A failed renewal also loses ownership. */
    }
    leaseLost = true;
    controller.abort(Object.assign(new Error('Project lease lost'), { code: 'project_lease_lost' }));
  };
  const timer = setInterval(renew, ctx.engine.leaseHeartbeatMs || 10000);
  timer.unref();
  // Pause gates later starts and advancement; admitted Engine work keeps its session.
  const polling = setInterval(async () => {
    if (pollingBusy) return;
    pollingBusy = true;
    try {
      if ((await ctx.repo.snapshot(projectId)).project.status === 'cancelled') abort();
    } catch {
      abort();
    } finally {
      pollingBusy = false;
    }
  }, 250);
  polling.unref();
  const control = {
    signal: controller.signal,
    check() {
      renew();
      requireValue(!leaseLost, 'lease_lost');
    },
  };
  try {
    // Writes of the foreground director are fenced by its lease (runtime/lease-fence.mjs).
    return await fencedBy([token], () => work(control));
  } finally {
    clearInterval(timer);
    clearInterval(polling);
    signal?.removeEventListener('abort', abort);
    ctx.store.releaseLease(token);
  }
}
// --- wave selection ---------------------------------------------------------------------------

/**
 * Task ids of the next wave in horizon order (planProjectHorizon): at most `limit`, with write
 * paths disjoint from each other and from the in-flight tasks (`inFlight`, e.g. external chats).
 * Optional `availability` (planner rows) and `now`; by default every task is available with
 * verified interfaces.
 * @param {any} snapshot
 * @param {{ limit: number, profiledWave?: boolean, windowSize?:number, inFlight?: string[], availability?: any[], now?: string }} options
 */
export function selectWave(
  snapshot,
  { limit, profiledWave = false, windowSize, inFlight = [], availability, now } = /** @type {any} */ ({}),
) {
  requireValue(Number.isSafeInteger(limit) && limit >= 1 && limit <= (profiledWave ? 64 : 24), 'limit_invalid');
  requireValue(Array.isArray(inFlight), 'limit_invalid');
  const rows =
    availability ??
    snapshot.tasks.map(task => ({ taskId: task.id, available: true, interfacesVerified: true, reason: null }));
  const horizon = planProjectHorizon(
    {
      snapshot,
      profiledWave,
      limit: profiledWave ? waveHorizon(limit, inFlight.length, windowSize) : 24,
      availability: rows,
      now: now ?? new Date().toISOString(),
    },
    { contracts: projectContracts, knownValues: [] },
  );
  const scopes = id => taskOf(snapshot, id)?.writePaths ?? [];
  const taken = inFlight.map(scopes).filter(list => list.length);
  const selected = [];
  for (const id of horizon.taskIds) {
    if (selected.length >= limit) break;
    const own = scopes(id);
    if (taken.some(other => scopesOverlap(own, other))) continue;
    selected.push(id);
    taken.push(own);
  }
  return selected;
}
/**
 * Planner availability rows of a wave snapshot: a task not yet integrated is available only with
 * verified interface proofs (`interface_proof_invalid` otherwise). Used by drain and next-wave.
 * @param {{ engine: any }} ctx
 * @param {any} snapshot
 */
export async function waveAvailability(ctx, snapshot) {
  const rows = [];
  for (const task of snapshot.tasks) {
    let verified = true;
    if (!reached(task.status, 'integrated'))
      try {
        for (const ref of task.interfaceRefs) await verifyRef(ctx.engine, ref);
      } catch {
        verified = false;
      }
    rows.push({
      taskId: task.id,
      available: true,
      interfacesVerified: verified,
      reason: verified ? null : 'interface_proof_invalid',
    });
  }
  return rows;
}
const horizonOf = async (ctx, snapshot, options, slots, active) =>
  planProjectHorizon(
    {
      snapshot,
      profiledWave: options.profiledWave,
      limit: options.profiledWave ? waveHorizon(slots, active.external.length, options.windowSize) : 24,
      availability: await waveAvailability(ctx, snapshot),
      now: ctx.clock(),
    },
    portsFor(ctx),
  );
// --- drain ------------------------------------------------------------------------------------

const takeCommandId = options => {
  const commandId = options.commandId;
  options.commandId = undefined;
  return commandId;
};
async function readyTask(ctx, projectId, taskId) {
  const snapshot = await snapshotOf(ctx, projectId);
  if (['proposed', 'blocked', 'failed'].includes(taskOf(snapshot, taskId).status))
    await ctx.repo.apply(commandFor(snapshot, transitionAction('task', taskId, 'ready')));
}
async function admitTask(ctx, projectId, taskId, options, control, retry = false) {
  control.check();
  const snapshot = await snapshotOf(ctx, projectId);
  requireValue(!controlState(snapshot), 'control_blocked');
  await readyTask(ctx, projectId, taskId);
  const reserved = await ctx.repo.apply(
    commandFor(
      await snapshotOf(ctx, projectId),
      { op: 'reserveAttempt', taskId, retryFailed: retry },
      { commandId: takeCommandId(options) },
    ),
  );
  return reserved.attempt;
}
async function frontierOf(ctx, snapshot) {
  const mergeCommits = [];
  for (const task of snapshot.tasks.filter(row => reached(row.status, 'integrated'))) {
    const run = storedRun(ctx.store, currentOf(snapshot, task.id)?.runId);
    if (run?.integration?.status === 'merged') mergeCommits.push(run.integration.mergeCommit);
  }
  return withIntegrationLease(ctx, snapshot.project.projectId, undefined, async () => {
    const { worktree } = await integrationOf(ctx, snapshot);
    return waveFrontier({ worktree, mergeCommits });
  });
}
// Install (or find) the native task Run of an attempt and create its worktree.
async function installTaskRun(ctx, projectId, attempt, options, control, apiCardCache = null) {
  let snapshot = await snapshotOf(ctx, projectId);
  const task = taskOf(snapshot, attempt.taskId),
    project = snapshot.project;
  const input = ctx.contracts.buildDirectorTaskInput({ project, task }, portsFor(ctx));
  let run = storedRun(ctx.store, attempt.runId);
  if (!run) {
    const previous = await priorRetryRun(ctx, snapshot, attempt);
    const retry = await retrySettings(ctx, snapshot, previous);
    const concurrency = Math.min(5, options.concurrency, previous?.config.concurrency ?? options.concurrency);
    const baseSha = await frontierOf(ctx, snapshot);
    run = await ctx.engine.createReserved(
      input,
      {
        project: project.root,
        providers: retry?.providers || 'current',
        ...(retry?.client ? { client: retry.client } : {}),
        ...(retry?.model ? { model: retry.model } : {}),
        mode: 'quick',
        delivery: 'none',
        concurrency,
        baseSha,
      },
      {
        binding: bindingFor(attempt),
        installRun: async value => {
          const draft = value.runDraft;
          draft.verificationProfile = 'task-fast';
          // The task verifies under the policy of its base commit, not of the user's checkout.
          await applyWavePolicy(draft, draft.baseSha, { secrets: ctx.engine.secrets });
          draft.config.watchdog = normalizeWatchdogConfig(project.execution?.watchdog ?? GATE_WATCHDOG);
          draft.config.concurrency = concurrency;
          draft.config.delivery = { ...draft.config.delivery, enabled: false, release: false };
          // A retry never widens a saved cap.
          for (const field of ['researchBudget', 'repairRounds', 'maxTasks']) {
            const limit = previous?.config[field];
            if (limit !== undefined) draft.config[field] = Math.min(draft.config[field] ?? limit, limit);
          }
          for (const [key, cap] of Object.entries(previous?.config.budgets ?? {})) {
            const budgets = (draft.config.budgets ??= {});
            budgets[key] = Math.min(budgets[key] ?? cap, cap);
          }
          control.check();
          snapshot = await snapshotOf(ctx, projectId);
          requireValue(!controlState(snapshot), 'control_blocked');
          return ctx.repo.installRun(value);
        },
      },
    );
  }
  requireValue(run.task === input && isDeepStrictEqual(run.directorBinding, bindingFor(attempt)), 'binding_invalid');
  // Worktrees are created one by one; Engine reuses an existing one.
  await makeWorktree(run.project, run.cwd, run.branch, run.baseSha, {
    signal: control.signal,
    onCreated: () => markTaskWorktree(run),
  });
  if (project.execution?.cadence === 'wave') {
    const waveContext = await prepareWaveTaskContext({
      ctx,
      snapshot,
      attempt,
      task,
      run,
      apiCardCache,
      buildApiCardsImpl: ctx.buildApiCards,
      signal: control.signal,
    });
    run = ctx.store.updateRun(run.id, { waveContext });
  }
  return run;
}
async function settleTaskRun(ctx, projectId, runId, control) {
  const run = ctx.store.getRun(runId),
    taskId = run.directorBinding.taskId;
  if (run.state === 'succeeded') {
    const result = await integrateAndAdvance(ctx, { projectId, taskId, run, signal: control.signal });
    if (result.status === 'integrated') return { taskId, status: 'integrated' };
    const stop = controlState(await snapshotOf(ctx, projectId));
    return { taskId, status: ['paused', 'cancelled'].includes(stop) ? stop : 'blocked', code: result.code, runId };
  }
  if (run.state === 'waiting_limits')
    return {
      taskId,
      status: 'waiting_limits',
      code: 'quota',
      runId,
      ...(run.error?.retryAt ? { retryAt: run.error.retryAt } : {}),
    };
  if (retryStates.includes(run.state)) {
    const snapshot = await snapshotOf(ctx, projectId);
    const attempt = snapshot.currentAttempts.find(row => row.runId === runId);
    if (
      snapshot.project.status !== 'cancelled' &&
      attempt &&
      !retryStates.includes(attempt.status) &&
      !reached(attempt.status, 'integrated')
    )
      await ctx.repo.apply(commandFor(snapshot, transitionAction('attempt', attempt.id, run.state)));
    const cancelled = run.state === 'cancelled' && (control.signal.aborted || snapshot.project.status === 'cancelled');
    return { taskId, status: cancelled ? 'cancelled' : 'blocked', code: blockerOf(run), runId };
  }
  return { taskId, status: control.signal.aborted ? 'cancelled' : 'blocked', code: 'run_incomplete', runId };
}
// All task Runs of a wave execute in parallel; finished ones integrate one at a time.
async function runWave(ctx, projectId, runs, control) {
  /** @type {Promise<unknown>} */
  let chain = Promise.resolve();
  const settle = run => {
    const settledRun = chain.then(() => settleTaskRun(ctx, projectId, run.id, control));
    chain = settledRun.catch(() => {});
    return settledRun;
  };
  const results = await Promise.allSettled(
    runs.map(async run => {
      if (!finishedRun.includes(ctx.store.getRun(run.id).state) && !control.signal.aborted)
        await ctx.engine.run(run.id, { signal: control.signal });
      return settle(run);
    }),
  );
  const rejected = results.find(row => row.status === 'rejected');
  if (rejected) throw /** @type {PromiseRejectedResult} */ (rejected).reason;
  return results.map(row => /** @type {PromiseFulfilledResult<any>} */ (row).value);
}
async function executeWave(ctx, projectId, attempts, options, control, state) {
  const runs = [];
  const apiCardCache = createApiCardCache();
  for (const attempt of attempts)
    runs.push(await installTaskRun(ctx, projectId, attempt, options, control, apiCardCache));
  state.waves++;
  const outcomes = await runWave(ctx, projectId, runs, control);
  control.check();
  for (const outcome of outcomes) {
    if (outcome.status === 'integrated') state.integrated.push(outcome.taskId);
    else
      state.blockers.push({
        code: outcome.code,
        kind: 'task',
        id: outcome.taskId,
        ...(outcome.runId ? { runId: outcome.runId } : {}),
        ...(outcome.retryAt ? { retryAt: outcome.retryAt } : {}),
      });
  }
  for (const status of ['cancelled', 'paused', 'blocked', 'waiting_limits'])
    if (outcomes.some(outcome => outcome.status === status)) return status;
  return null;
}
// The actor of the attempt's own reservation event (null when none is recorded).
async function reservationActor(repo, projectId, attemptId) {
  let after = 0;
  for (let page = 0; page < 64; page++) {
    const history = await repo.history(projectId, { after, limit: 1000 });
    const event = history.events.find(
      row => row.type === 'reserveAttempt' && row.entity.kind === 'attempt' && row.entity.id === attemptId,
    );
    if (event) return event.actor;
    if (history.complete || history.nextAfter <= after) return null;
    after = history.nextAfter;
  }
  return null;
}
/**
 * Who executes a wave attempt: `{kind:'native'}` (the drain), `{kind:'external', host}`
 * (a pull host) or `{kind:'unknown'}`. An installed Run decides by its `executor`; a
 * reservation without a Run (an interrupted install) by the actor of its reservation
 * event, so only its owner ever resumes it.
 * @param {{ repo: any, store: any }} ports
 * @param {any} snapshot
 * @param {any} attempt
 */
export async function attemptExecutor({ repo, store }, snapshot, attempt) {
  const run = storedRun(store, attempt.runId);
  if (run)
    return run.executor?.kind === 'external' ? { kind: 'external', host: run.executor.host } : { kind: 'native' };
  const actor = await reservationActor(repo, snapshot.project.projectId, attempt.id);
  if (actor === NATIVE_RESERVER) return { kind: 'native' };
  if (typeof actor === 'string' && actor.startsWith(EXTERNAL_RESERVER))
    return { kind: 'external', host: actor.slice(EXTERNAL_RESERVER.length) };
  return { kind: 'unknown' };
}
// Native attempts still open (crash or quota mid-wave) and tasks in flight elsewhere
// (external chats, or a reservation of an unknown owner): never executed by the drain.
async function activeAttempts(ctx, snapshot) {
  const native = [],
    external = [],
    externalPlacements = [];
  for (const attempt of snapshot.currentAttempts) {
    const task = taskOf(snapshot, attempt.taskId);
    const open =
      attempt.status === 'integrated'
        ? !reached(task.status, 'integrated')
        : !settled(attempt.status) && !retryStates.includes(attempt.status);
    if (!open) continue;
    if ((await attemptExecutor(ctx, snapshot, attempt)).kind === 'native') native.push(attempt);
    else {
      external.push(attempt.taskId);
      externalPlacements.push(storedRun(ctx.store, attempt.runId)?.workerPlacement);
    }
  }
  return { native, external, externalPlacements };
}
function nativeSlots(options, active) {
  return options.profile
    ? Math.min(options.concurrency, freeWorkerSlots(options.profile, options.now, active.externalPlacements))
    : options.concurrency;
}
// `--retry-failed`: one new attempt per failed task, disjoint scopes, at most `concurrency`.
// A retry goes to the executor of the failed attempt: the drain retries only its own native
// attempts; a task an external chat abandoned is retried by `next-wave --retry-failed`.
async function reserveRetries(ctx, projectId, options, control, state) {
  let snapshot = await snapshotOf(ctx, projectId);
  const active = await activeAttempts(ctx, snapshot);
  const slots = nativeSlots(options, active);
  const horizon = await horizonOf(ctx, snapshot, options, slots, active);
  const taken = [...active.native.map(row => row.taskId), ...active.external].map(
    id => taskOf(snapshot, id).writePaths,
  );
  const available = options.profile ? slots - active.native.length : options.concurrency;
  let count = 0;
  for (const attempt of snapshot.currentAttempts.filter(row => retryStates.includes(row.status))) {
    const task = taskOf(snapshot, attempt.taskId);
    if (count >= available || reached(task.status, 'integrated') || task.status === 'cancelled') continue;
    const executor = await attemptExecutor(ctx, snapshot, attempt);
    if (executor.kind !== 'native') {
      state.blockers.push({
        code: 'wave_retry_executor',
        kind: 'task',
        id: task.id,
        ...(executor.host ? { host: executor.host } : {}),
      });
      continue;
    }
    const allowed = new Set(['horizon_limit', 'retry_required', 'attempt_revision_mismatch', `task_${task.status}`]);
    const reasons = horizon.blocked.find(row => row.taskId === task.id)?.reasons.filter(r => !allowed.has(r)) ?? [];
    if (reasons.length) {
      state.blockers.push({ code: reasons[0], kind: 'task', id: task.id, reasons });
      continue;
    }
    if (taken.some(scopes => scopesOverlap(scopes, task.writePaths))) continue;
    await admitTask(ctx, projectId, task.id, options, control, true);
    taken.push(task.writePaths);
    count++;
    snapshot = await snapshotOf(ctx, projectId);
  }
}
async function noProgress(ctx, snapshot, state, options, slots, active) {
  const horizon = await horizonOf(ctx, snapshot, options, slots, active);
  const rows = horizon.blocked.filter(row => !reached(taskOf(snapshot, row.taskId).status, 'integrated'));
  for (const row of rows)
    state.blockers.push({ code: row.reasons[0], kind: 'task', id: row.taskId, reasons: row.reasons });
  for (const epic of snapshot.epics)
    if (
      !settled(epic.status) &&
      childrenOf(snapshot, 'epic', epic.id).every(task => reached(task.status, 'integrated')) &&
      !gateCandidate(snapshot, epic)
    )
      state.blockers.push({ code: 'wave_dependency_unaccepted', kind: 'epic', id: epic.id });
  const primary = rows
    .flatMap(row => row.reasons)
    .filter(r => !r.startsWith('dependency_not_accepted:') && r !== 'horizon_limit');
  state.code =
    primary.length && primary.every(reason => reason === 'risk_approval_required')
      ? 'risk_approval_required'
      : state.blockers[0]?.code || 'wave_no_progress';
  return 'blocked';
}
async function finish(ctx, projectId, state, status) {
  const snapshot = await ctx.repo.snapshot(projectId);
  const seen = new Set(),
    blockers = state.blockers.filter(row => {
      const key = JSON.stringify(row);
      return !seen.has(key) && seen.add(key);
    });
  return {
    status,
    waves: state.waves,
    integrated: [...state.integrated],
    gates: [...state.gates],
    blockers,
    revision: snapshot.revision,
    ...(status === 'blocked' ? { code: state.code ?? blockers[0]?.code ?? 'wave_no_progress' } : {}),
  };
}
function drainWindow(ctx, projectId, requested) {
  const profile = ctx.repo.getProfile(projectId);
  const now = Date.parse(ctx.clock());
  const maximum = waveCapacity(profile, now);
  requireValue(profile || requested <= maximum, 'drain_invalid');
  return {
    profile,
    now,
    profiledWave: Boolean(profile),
    windowSize: maximum,
    concurrency: Math.min(requested, maximum),
  };
}
async function drainLoop(ctx, projectId, options, control, state) {
  let pending = null,
    retry = options.retryFailed;
  for (;;) {
    control.check();
    let snapshot = await snapshotOf(ctx, projectId);
    let stop = controlState(snapshot);
    if (stop) return finish(ctx, projectId, state, stop);
    Object.assign(options, drainWindow(ctx, projectId, options.requested));
    if (!options.concurrency) return finish(ctx, projectId, state, pending || 'waiting_limits');
    if (retry) {
      retry = false;
      await reserveRetries(ctx, projectId, options, control, state);
      snapshot = await snapshotOf(ctx, projectId);
    }
    const recovering = await activeAttempts(ctx, snapshot);
    if (!pending && recovering.native.length) {
      const slots = nativeSlots(options, recovering);
      if (!slots) return finish(ctx, projectId, state, 'waiting_limits');
      if (state.waves >= options.maxWaves) return finish(ctx, projectId, state, 'max_waves');
      pending = await executeWave(ctx, projectId, recovering.native.slice(0, slots), options, control, state);
      continue;
    }
    if (['cancelled', 'paused'].includes(pending)) return finish(ctx, projectId, state, pending);
    const gates = await runPendingGates(ctx, { projectId, signal: control.signal, retryFailed: options.retryFailed });
    state.gates.push(...gates.gates);
    state.blockers.push(...gates.blocked);
    snapshot = await snapshotOf(ctx, projectId);
    if (settled(snapshot.project.status)) return finish(ctx, projectId, state, 'accepted');
    stop = controlState(snapshot);
    // A lost project lease is a blocker of its own, never a cancel.
    if (control.signal.aborted && control.signal.reason?.code === 'project_lease_lost') {
      state.code = 'project_lease_lost';
      return finish(ctx, projectId, state, 'blocked');
    }
    if (stop || control.signal.aborted) return finish(ctx, projectId, state, stop || 'cancelled');
    if (gates.blocked.length)
      return finish(
        ctx,
        projectId,
        state,
        gates.blocked.every(row => row.code === 'quota') ? 'waiting_limits' : 'blocked',
      );
    if (pending) return finish(ctx, projectId, state, pending);
    if (state.waves >= options.maxWaves) return finish(ctx, projectId, state, 'max_waves');
    // A gate can run long enough for another connection to change the profile.
    Object.assign(options, drainWindow(ctx, projectId, options.requested));
    const active = await activeAttempts(ctx, snapshot);
    const slots = nativeSlots(options, active);
    if (!slots) return finish(ctx, projectId, state, 'waiting_limits');
    const taskIds = selectWave(snapshot, {
      limit: slots,
      windowSize: options.windowSize,
      profiledWave: options.profiledWave,
      inFlight: active.external,
      availability: await waveAvailability(ctx, snapshot),
      now: ctx.clock(),
    });
    if (!taskIds.length)
      return finish(ctx, projectId, state, await noProgress(ctx, snapshot, state, options, slots, active));
    const attempts = [];
    for (const taskId of taskIds) attempts.push(await admitTask(ctx, projectId, taskId, options, control));
    pending = await executeWave(ctx, projectId, attempts, options, control, state);
  }
}
/**
 * Execute a wave project until it is accepted or a stop: waves of disjoint ready tasks run in
 * parallel through the Engine, integrate one by one, then pending epic gates run.
 * `status`: accepted | waiting_limits | blocked | paused | cancelled | max_waves.
 * @param {any} ctx
 * @param {string} projectId
 * @param {{ maxWaves?: number, concurrency?: number, retryFailed?: boolean, signal?: AbortSignal, commandId?: string }} [options]
 */
export async function drain(ctx, projectId, options = {}) {
  const { maxWaves = 10, retryFailed = false, signal, commandId } = options;
  requireValue(Number.isSafeInteger(maxWaves) && maxWaves >= 1 && maxWaves <= 100, 'drain_invalid');
  if (options.concurrency !== undefined)
    requireValue(
      Number.isSafeInteger(options.concurrency) && options.concurrency >= 1 && options.concurrency <= 64,
      'drain_invalid',
    );
  const snapshot = await snapshotOf(ctx, projectId);
  requireValue(waveProject(ctx, snapshot), 'wave_not_enabled');
  if (snapshot.project.status === 'released') fail('wave_delivery_unsupported');
  const state = { waves: 0, integrated: [], gates: [], blockers: [], code: undefined };
  const early = settled(snapshot.project.status) ? 'accepted' : controlState(snapshot);
  if (early) {
    requireValue(early !== 'blocked', 'control_blocked');
    return finish(ctx, projectId, state, early);
  }
  return withGateController(ctx.store, projectId, () =>
    withProjectControl(ctx, projectId, signal, control =>
      drainLoop(
        ctx,
        projectId,
        {
          maxWaves,
          requested: options.concurrency ?? 3,
          retryFailed: retryFailed === true,
          commandId,
        },
        control,
        state,
      ),
    ),
  );
}
