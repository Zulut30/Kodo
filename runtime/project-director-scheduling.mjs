import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { git } from './workspace.mjs';
import { execute } from './command.mjs';
import { readConfig } from './config.mjs';
import { resolveMode } from './modes.mjs';
import {
  fail,
  requireValue,
  settled,
  retryable,
  known,
  bindingFor,
  canonical,
  complete,
  storedRun,
  contractsFor,
  verifyRef,
} from './project-director-proofs.mjs';

export const optionsFor = (ctx, options) => ({
  actor: options.actor || 'project-director',
  reason: options.reason || 'Foreground Project command',
});

export const command = (ctx, snapshot, action, options = {}) => ({
  schemaVersion: 1,
  commandId: options.commandId || randomUUID(),
  projectId: snapshot.project.projectId,
  expectedRevision: snapshot.revision,
  ...optionsFor(ctx, options),
  action,
});

export const apply = (ctx, snapshot, action, options) => ctx.repo.apply(command(ctx, snapshot, action, options));

export const snapshotFor = async (ctx, id) => {
  const snapshot = await ctx.repo.snapshot(id);
  complete(snapshot);
  return snapshot;
};

export const ports = async ctx => ({ contracts: await contractsFor(), knownValues: known(ctx.engine) });

async function horizonFor(ctx, snapshot, options = {}) {
  const A = await ports(ctx);
  const config = await readConfig(
    snapshot.project.root,
    options.mode === undefined ? {} : { executionMode: options.mode },
  );
  requireValue(
    Number.isSafeInteger(options.limit ?? 24) && (options.limit ?? 24) >= 1 && (options.limit ?? 24) <= 24,
    'limit_invalid',
  );
  const limit = Math.min(options.limit ?? 24, resolveMode({ requested: options.mode, config }).profile.maxTasks);
  const availability = [];
  for (const task of snapshot.tasks) {
    let verified = true,
      reason = null;
    try {
      for (const ref of task.interfaceRefs) await verifyRef(ctx.engine, ref);
    } catch {
      verified = false;
      reason = 'interface_proof_invalid';
    }
    availability.push({ taskId: task.id, available: true, interfacesVerified: verified, reason });
  }
  const planHorizon =
    typeof ctx.planner === 'function'
      ? ctx.planner
      : ctx.planner?.planProjectHorizon || (await import('./project-planner.mjs')).planProjectHorizon;
  return planHorizon({ snapshot, limit, availability, now: ctx.clock() }, A);
}

export async function plan(ctx, id, options = {}) {
  return horizonFor(ctx, await snapshotFor(ctx, id), options);
}

export async function admission(ctx, snapshot, task, options, retry = false, recovery = false) {
  // C evaluates the actual snapshot, including current approvals and immutable
  // interfaces. Only the existing reservation's scheduling exclusions are
  // waived: recovery/retry is not selection of another horizon task.
  const horizon = await horizonFor(ctx, snapshot, options);
  requireValue(horizon.revision === snapshot.revision, 'revision_conflict');
  const blocked = horizon.blocked.find(row => row.taskId === task.id);
  requireValue(blocked || horizon.taskIds.includes(task.id), 'admission_invalid');
  const expected = new Set(['horizon_limit', retry ? 'retry_required' : 'attempt_exists']);
  if (retry) {
    expected.add('attempt_revision_mismatch');
    if (retryable(task.status)) expected.add(`task_${task.status}`);
  } else if (['running', 'verifying', 'integrated'].includes(task.status)) expected.add(`task_${task.status}`);
  if (recovery && task.status === 'accepted') expected.add('task_accepted');
  const reasons = blocked?.reasons.filter(reason => !expected.has(reason)) || [];
  return reasons.length ? { status: 'blocked', blockers: [{ taskId: task.id, reasons }] } : null;
}

// A durable branch/head is a frontier only when all accepted code is present.
// Compare Git ancestry rather than timestamps or the user's unchanged checkout.
export async function frontier(ctx, snapshot, task) {
  const root = snapshot.project.root;
  requireValue((await canonical(root)) === snapshot.project.projectKey, 'root_changed');
  const current = await git(root, ['rev-parse', 'HEAD']);
  const relevant = snapshot.currentAttempts.filter(attempt =>
    settled(snapshot.tasks.find(row => row.id === attempt.taskId)?.status),
  );
  const heads = [];
  for (const attempt of relevant) {
    const run = storedRun(ctx.store, attempt.runId);
    requireValue(
      run &&
        isDeepStrictEqual(run.directorBinding, bindingFor(attempt)) &&
        run.state === 'succeeded' &&
        (await canonical(run.project)) === snapshot.project.projectKey,
      'frontier_binding_invalid',
    );
    let head;
    if (run.config.delivery?.enabled) {
      requireValue(
        run.delivery?.mergeCommit && run.delivery.reviewedHead === run.headSha,
        'frontier_publication_missing',
      );
      head = run.delivery.mergeCommit;
    } else {
      requireValue(
        run.branch &&
          run.headSha &&
          (await git(root, ['rev-parse', '--verify', `refs/heads/${run.branch}`])) === run.headSha,
        'frontier_head_changed',
      );
      head = run.headSha;
    }
    requireValue(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(head), 'frontier_head_invalid');
    heads.push(head);
  }
  for (const dependency of task.dependsOn)
    requireValue(
      relevant.some(row => row.taskId === dependency),
      'frontier_dependency_missing',
    );
  const ancestor = async (base, head) => {
    const result = await execute('git', ['merge-base', '--is-ancestor', base, head], {
      cwd: root,
      allowFailure: true,
    });
    requireValue([0, 1].includes(result.code), 'frontier_invalid');
    return result.code === 0;
  };
  let selected = current;
  for (const head of new Set(heads)) {
    if (await ancestor(selected, head)) selected = head;
  }
  for (const head of [current, ...heads])
    requireValue(await ancestor(head, selected), 'frontier_reconciliation_required');
  return selected;
}

export async function priorRetryRun(ctx, snapshot, attempt) {
  if (attempt.number === 1) return null;
  // Only metadata is examined. Never replay old provider/gate sessions. The
  // atomic reservation events order predecessors even across an install crash.
  const runs = new Map(
    ctx.store
      .listRuns(snapshot.project.root)
      .filter(
        run =>
          run.directorBinding?.projectId === attempt.projectId &&
          run.directorBinding.taskId === attempt.taskId &&
          run.id !== attempt.runId,
      )
      .map(run => [run.directorBinding.attemptId, run]),
  );
  let after = 0,
    previous = null;
  for (let page = 0; page < 64; page++) {
    const history = await ctx.repo.history(attempt.projectId, { after, limit: 1000 });
    requireValue(history.revision === snapshot.revision, 'revision_conflict');
    for (const event of history.events)
      if (event.type === 'reserveAttempt' && event.entity.kind === 'attempt') {
        if (event.entity.id === attempt.id) {
          requireValue(previous, 'retry_policy_missing');
          return previous;
        }
        if (runs.has(event.entity.id)) previous = runs.get(event.entity.id);
      }
    if (history.complete) break;
    requireValue(history.nextAfter > after, 'retry_history_incomplete');
    after = history.nextAfter;
  }
  fail('retry_history_incomplete');
}

export async function retrySettings(ctx, snapshot, previous) {
  if (!previous) return null;
  (await ports(ctx)).contracts.assertDirectorSafe(previous, { knownValues: known(ctx.engine) });
  requireValue((await canonical(previous.project)) === snapshot.project.projectKey, 'retry_binding_invalid');
  const model = previous.fixedModel?.model || previous.config.primaryModel || undefined;
  const current = await readConfig(snapshot.project.root, { client: previous.client });
  requireValue(!model || current.models[previous.client]?.includes(model), 'retry_model_unavailable');
  return {
    client: previous.client,
    ...(model ? { model } : {}),
    providers: previous.providers,
    mode: previous.requestedMode || previous.executionMode?.selected || previous.config.executionMode || 'standard',
    concurrency: Math.min(current.concurrency, previous.config.concurrency),
  };
}
