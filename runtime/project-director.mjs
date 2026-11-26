import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import {
  fail,
  requireValue,
  settled,
  retryable,
  stages,
  bindingFor,
  canonical,
  control,
  storedRun,
  contractsFor,
  evidenceFor,
  verifyRef,
  validateRun,
} from './project-director-proofs.mjs';
import {
  optionsFor,
  apply,
  snapshotFor,
  ports,
  plan,
  admission,
  frontier,
  priorRetryRun,
  retrySettings,
} from './project-director-scheduling.mjs';
import { containerResult, advanceContainers, advance } from './project-director-progress.mjs';

/** @param {{repo?: any, engine?: any, planner?: any, evaluator?: any, clock?: () => string}} [options] */
export function createProjectDirector({
  repo,
  engine,
  planner,
  evaluator,
  clock = () => new Date().toISOString(),
} = {}) {
  const store = engine.store;
  const ctx = { repo, engine, planner, evaluator, clock, store };
  return {
    plan: (...args) => plan(ctx, ...args),
    run: (...args) => foreground(ctx, ...args),
    resume: (...args) => resume(ctx, ...args),
    drain: (...args) => drainProject(ctx, ...args),
    cancel: (...args) => cancel(ctx, ...args),
    pause: (...args) => pause(ctx, ...args),
    reprioritize: (...args) => reprioritize(ctx, ...args),
    approveRisk: (...args) => approveRisk(ctx, ...args),
  };
}

async function foreground(ctx, id, options = {}) {
  let snapshot = await snapshotFor(ctx, id);
  await refuseWave(snapshot);
  if (snapshot.project.status === 'released') return { status: 'succeeded', projectStatus: 'released' };
  control(snapshot);
  const token = ctx.store.acquireLease(`project:${id}`, randomUUID(), { ttlMs: 60000, limit: 1 });
  requireValue(token, 'busy');
  const controller = new AbortController(),
    abort = () => controller.abort();
  options.signal?.addEventListener('abort', abort, { once: true });
  if (options.signal?.aborted) abort();
  let leaseLost = false;
  const renew = () => {
    try {
      if (ctx.store.renewLease(token)) return;
    } catch {
      /* A failed renewal also loses ownership. */
    }
    leaseLost = true;
    abort();
  };
  const timer = setInterval(renew, ctx.engine.leaseHeartbeatMs || 10000);
  timer.unref();
  let pollingBusy = false;
  const polling = setInterval(async () => {
    if (pollingBusy) return;
    pollingBusy = true;
    // Pause gates later starts/advancement through guard; admitted Engine work
    // keeps its session. Abort retains its cancellation meaning for Engine.
    try {
      const s = await ctx.repo.snapshot(id);
      if (s.project.status === 'cancelled') abort();
    } catch {
      abort();
    } finally {
      pollingBusy = false;
    }
  }, 250);
  polling.unref();
  const guard = async (revision, attempt, allowReleased = false) => {
    renew();
    requireValue(!leaseLost, 'lease_lost');
    requireValue(!controller.signal.aborted, 'control_blocked');
    const before = await snapshotFor(ctx, id);
    requireValue((await canonical(before.project.root)) === before.project.projectKey, 'root_changed');
    const s = await snapshotFor(ctx, id);
    control(s, allowReleased);
    renew();
    requireValue(!leaseLost, 'lease_lost');
    requireValue(s.revision === before.revision, 'revision_conflict');
    requireValue(revision === undefined || s.revision === revision, 'revision_conflict');
    if (attempt)
      requireValue(
        isDeepStrictEqual(
          s.currentAttempts.find(row => row.taskId === attempt.taskId),
          attempt,
        ),
        'binding_changed',
      );
    return s;
  };
  try {
    snapshot = await guard(snapshot.revision);
    const selected = await selectWork(ctx, id, options, guard, snapshot);
    if ('result' in selected) return selected.result;
    const admitted = await admitWork(ctx, options, guard, selected);
    if ('result' in admitted) return admitted.result;
    await executeWork(ctx, guard, controller.signal, admitted);
    return await settleWork(ctx, id, guard, admitted);
  } finally {
    clearInterval(timer);
    clearInterval(polling);
    options.signal?.removeEventListener('abort', abort);
    ctx.store.releaseLease(token);
  }
}

async function selectWork(ctx, id, options, guard, snapshot) {
  const active = snapshot.currentAttempts.filter(row => {
    const task = snapshot.tasks.find(task => task.id === row.taskId);
    // A durable Attempt may precede its Task projection across a crash.
    // Select that same reservation before scheduling any further work.
    return (
      (!settled(row.status) && !retryable(row.status)) ||
      (settled(row.status) && stages.includes(task?.status) && stages.indexOf(task.status) < stages.indexOf(row.status))
    );
  });
  requireValue(active.length <= 1, 'multiple_active_attempts');
  let attempt = active[0],
    task,
    previous = null;
  if (!attempt && options.retryFailed) {
    const candidates = snapshot.currentAttempts.filter(row => retryable(row.status));
    if (candidates.length) {
      requireValue(candidates.length === 1, 'retry_ambiguous');
      task = snapshot.tasks.find(row => row.id === candidates[0].taskId);
      previous = storedRun(ctx.store, candidates[0].runId) || (await priorRetryRun(ctx, snapshot, candidates[0]));
      await retrySettings(ctx, snapshot, previous);
      const denied = await admission(ctx, snapshot, task, options, true);
      await guard(snapshot.revision);
      if (denied) return { result: denied };
      attempt = (await apply(ctx, snapshot, { op: 'reserveAttempt', taskId: task.id, retryFailed: true }, options))
        .attempt;
      snapshot = await guard();
    }
  }
  if (!attempt) {
    const horizon = await plan(ctx, id, options);
    snapshot = await guard(horizon.revision);
    if (!horizon.taskIds.length) {
      if (snapshot.tasks.every(task => settled(task.status)))
        return { result: containerResult(ctx, await advanceContainers(ctx, guard)) };
      return { result: { status: 'blocked', blockers: horizon.blocked } };
    }
    task = snapshot.tasks.find(row => row.id === horizon.taskIds[0]);
    if (task.status !== 'ready') {
      await guard(snapshot.revision);
      await apply(ctx, snapshot, {
        op: 'transition',
        kind: 'task',
        id: task.id,
        to: 'ready',
        evidence: [],
        mappings: [],
      });
      snapshot = await guard();
      task = snapshot.tasks.find(row => row.id === task.id);
    }
    const denied = await admission(ctx, snapshot, task, options);
    await guard(snapshot.revision);
    if (denied) return { result: denied };
    attempt = (await apply(ctx, snapshot, { op: 'reserveAttempt', taskId: task.id, retryFailed: false }, options))
      .attempt;
    snapshot = await guard();
  }
  return { snapshot, attempt, previous };
}
async function admitWork(ctx, options, guard, { snapshot, attempt, previous }) {
  const task = snapshot.tasks.find(row => row.id === attempt.taskId);
  const recovery = settled(attempt.status);
  const denied = await admission(ctx, snapshot, task, options, false, recovery);
  await guard(snapshot.revision, attempt);
  if (denied) return { result: denied };
  const A = await ports(ctx),
    input = A.contracts.buildDirectorTaskInput({ project: snapshot.project, task }, A);
  let run = storedRun(ctx.store, attempt.runId);
  if (recovery) requireValue(run?.state === 'succeeded', 'recovery_run_invalid');
  if (!run) {
    previous ||= await priorRetryRun(ctx, snapshot, attempt);
    const retry = await retrySettings(ctx, snapshot, previous);
    const baseSha = await frontier(ctx, snapshot, task);
    snapshot = await guard(snapshot.revision, attempt);
    run = await ctx.engine.createReserved(
      input,
      { ...options, project: snapshot.project.root, providers: options.providers || 'current', ...retry, baseSha },
      {
        binding: bindingFor(attempt),
        installRun: async value => {
          const denied = await admission(ctx, snapshot, task, options);
          await guard(snapshot.revision, attempt);
          requireValue(!denied, 'admission_blocked');
          if (previous)
            for (const field of ['researchBudget', 'repairRounds', 'concurrency', 'maxTasks']) {
              const limit = previous.config[field] ?? previous.executionMode?.profile[field];
              if (limit !== undefined)
                value.runDraft.config[field] = Math.min(value.runDraft.config[field] ?? limit, limit);
            }
          // Explicit run caps follow the same rule: a retry never widens a saved cap.
          for (const [key, cap] of Object.entries(previous?.config.budgets ?? {})) {
            const budgets = (value.runDraft.config.budgets ??= {});
            budgets[key] = Math.min(budgets[key] ?? cap, cap);
          }
          const revision = snapshot.revision,
            installed = await ctx.repo.installRun(value);
          snapshot = await guard(revision + 1, attempt);
          return installed;
        },
      },
    );
  }
  requireValue(run.task === input && isDeepStrictEqual(run.directorBinding, bindingFor(attempt)), 'binding_invalid');
  const dispatchDenied = await admission(ctx, snapshot, task, options, false, recovery);
  await guard(snapshot.revision, attempt);
  if (dispatchDenied) return { result: dispatchDenied };
  return { snapshot, task, attempt, run, A, recovery };
}
async function executeWork(ctx, guard, signal, { snapshot, task, attempt, run, A, recovery }) {
  if (recovery) {
    const D = await evidenceFor(ctx.evaluator);
    // Validate the existing terminal proof before advance can persist any
    // observations. Attempts store refs, while criterion mappings belong to
    // Tasks; map only those existing refs against the frozen Task criteria.
    const mappings = task.acceptance.map(criterion => ({
      criterionId: criterion.id,
      refs: attempt.evidence.filter(ref => criterion.evidenceKinds.includes(ref.kind)).map(ref => ref.sha256),
      actor: 'project-director',
      reason: 'Revalidate existing Attempt proof before recovering its Task projection',
    }));
    const proof = await D.evaluateProjectAttempt(
      { snapshot, attempt, run, mappings },
      {
        ...A,
        verifyRef: ref => verifyRef(ctx.engine, ref, run),
        validateRun: value =>
          validateRun({
            store: ctx.store,
            engine: ctx.engine,
            contracts: A.contracts,
            snapshot,
            run: value,
            publication: attempt.status === 'released',
          }),
      },
    );
    requireValue(
      proof.blockers.length === 0 && proof.eligibleStates.includes(attempt.status),
      'recovery_proof_invalid',
    );
    // The evaluator preserves terminal history even when publication is no
    // longer eligible. Require its verified release chain explicitly.
    if (attempt.status === 'released')
      requireValue(
        /^[a-f0-9]{64}$/.test(run.release?.sha256) &&
          ['delivery', 'release'].every(kind => proof.evidence.some(ref => ref.kind === kind)),
        'recovery_proof_invalid',
      );
    await guard(snapshot.revision, attempt);
  }
  if (!settled(attempt.status) && !['succeeded', 'blocked', 'failed', 'cancelled'].includes(run.state)) {
    // Resume preserves Engine's fixed mode/model, quota, budget and sessions.
    // Project retry reserves a NEW Run; it never resets a saved Engine cycle.
    await ctx.engine.run(run.id, { signal });
  }
}
async function settleWork(ctx, id, guard, { snapshot, attempt }) {
  snapshot = await guard(snapshot.revision, attempt);
  const run = ctx.store.getRun(attempt.runId);
  if (retryable(run.state)) {
    await apply(ctx, snapshot, {
      op: 'transition',
      kind: 'attempt',
      id: attempt.id,
      to: run.state,
      evidence: [],
      mappings: [],
    });
    return { status: run.state, runId: run.id };
  }
  if (run.state !== 'succeeded') return { status: run.state, runId: run.id };
  await advance(ctx, id, run, guard);
  snapshot = await guard();
  const accepted = snapshot.tasks.find(row => row.id === attempt.taskId);
  if (settled(accepted.status) && snapshot.tasks.every(task => settled(task.status)))
    return { ...containerResult(ctx, await advanceContainers(ctx, guard)), runId: run.id };
  return {
    status: settled(accepted.status) ? 'succeeded' : 'blocked',
    runId: run.id,
    ...(settled(accepted.status) ? {} : { blockers: ['task_acceptance_unverified'] }),
  };
}
async function cancel(ctx, id, options = {}) {
  let snapshot = await snapshotFor(ctx, id);
  if (snapshot.project.status !== 'cancelled')
    await apply(
      ctx,
      snapshot,
      { op: 'transition', kind: 'project', id, to: 'cancelled', evidence: [], mappings: [] },
      options,
    );
  snapshot = await snapshotFor(ctx, id);
  for (const attempt of snapshot.currentAttempts.filter(row => !settled(row.status))) {
    if (!retryable(attempt.status)) {
      await apply(ctx, snapshot, {
        op: 'transition',
        kind: 'attempt',
        id: attempt.id,
        to: 'cancelled',
        evidence: [],
        mappings: [],
      });
      snapshot = await snapshotFor(ctx, id);
    }
    const run = storedRun(ctx.store, attempt.runId);
    if (run) {
      ctx.store.updateRun(run.id, { cancelRequested: true });
      if (typeof ctx.engine.cancel === 'function') await ctx.engine.cancel(run.id);
    }
  }
  // Wave gates: unfinished gate Runs are cancelled too. Legacy snapshots have no gates.
  for (const gate of snapshot.gates ?? []) {
    const run = storedRun(ctx.store, gate.runId);
    if (run && !['succeeded', 'blocked', 'failed', 'cancelled'].includes(run.state)) {
      ctx.store.updateRun(run.id, { cancelRequested: true });
      if (typeof ctx.engine.cancel === 'function') await ctx.engine.cancel(run.id);
    }
  }
  return { status: 'cancelled' };
}

async function pause(ctx, id, options = {}) {
  const snapshot = await snapshotFor(ctx, id);
  return apply(ctx, snapshot, { op: 'setPaused', paused: options.paused ?? true }, options);
}

const isWave = async snapshot => (await contractsFor()).isWaveProject(snapshot.project) === true;

// Wave projects never run through this one-task foreground loop, whose acceptance
// comes from the task's own Run: `run` refuses, `resume` drains one wave.
async function refuseWave(snapshot) {
  if (await isWave(snapshot)) fail('wave_drain_required');
}

const waveContext = (ctx, W) =>
  W.createWaveContext({ repo: ctx.repo, engine: ctx.engine, store: ctx.store, clock: ctx.clock });

// `resume` of a wave project is a drain of exactly one wave of one task.
async function waveResume(ctx, id, options) {
  const W = await import('./project-director-waves.mjs');
  const result = await W.drain(waveContext(ctx, W), id, {
    maxWaves: 1,
    concurrency: 1,
    retryFailed: options.retryFailed === true,
    signal: options.signal,
    commandId: options.commandId,
  });
  return {
    ...result,
    status: ['accepted', 'max_waves'].includes(result.status) ? 'succeeded' : result.status,
    drainStatus: result.status,
  };
}

async function drainProject(ctx, id, options = {}) {
  const W = await import('./project-director-waves.mjs');
  return W.drain(waveContext(ctx, W), id, options);
}

async function resume(ctx, id, options = {}) {
  const snapshot = await snapshotFor(ctx, id);
  requireValue(!['cancelled', 'failed'].includes(snapshot.project.status), 'control_blocked');
  if (snapshot.project.paused) await apply(ctx, snapshot, { op: 'setPaused', paused: false }, optionsFor(ctx, options));
  return (await isWave(snapshot)) ? waveResume(ctx, id, options) : foreground(ctx, id, options);
}

async function reprioritize(ctx, id, taskId, options = {}) {
  const snapshot = await snapshotFor(ctx, id),
    task = snapshot.tasks.find(row => row.id === taskId);
  requireValue(task, 'task_missing');
  const { schemaVersion, projectId, revision, status, createdAt, updatedAt, evidence, mappings, ...spec } = task;
  return apply(
    ctx,
    snapshot,
    { op: 'amend', kind: 'task', id: taskId, record: { ...spec, priority: options.priority } },
    options,
  );
}

async function approveRisk(ctx, id, taskId, options = {}) {
  const snapshot = await snapshotFor(ctx, id),
    task = snapshot.tasks.find(row => row.id === taskId);
  requireValue(task, 'task_missing');
  return apply(ctx, snapshot, { op: 'approveRisk', taskId, taskRevision: task.revision }, options);
}

export { known } from './project-director-proofs.mjs';

export { bindingFor } from './project-director-proofs.mjs';

export { storedRun } from './project-director-proofs.mjs';

export { verifyRef } from './project-director-proofs.mjs';

export { observation } from './project-director-proofs.mjs';

export { assertArbitrableReceipts } from './project-director-proofs.mjs';

export { createProjectTransitionAuthorizer } from './project-director-proofs.mjs';

export { priorRetryRun } from './project-director-scheduling.mjs';

export { retrySettings } from './project-director-scheduling.mjs';
