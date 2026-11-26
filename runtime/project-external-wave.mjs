// Wave admission for external worker chats (`nextWave` in `project-external.mjs`):
// slot placement, reservation of ready and retried tasks, worktree and brief
// preparation, the explanation of an empty wave and the worker watchdog.

import path from 'node:path';
import { assertRemoteBriefPaths, portableDiagnostics, privateBriefRoots } from './remote-brief-paths.mjs';
import { previousAttemptRef, pushBase, remoteRefs, transport } from './project-remote-transport.mjs';
import { portableDirectorTaskInput } from './project-contracts.mjs';
import { isDeepStrictEqual } from 'node:util';
import { execute } from './command.mjs';
import { git, makeWorktree } from './workspace.mjs';
import { ownsPath, scopesOverlap } from './contracts.mjs';
import { markTaskWorktree } from './project-worktree-gc.mjs';
import { waveFrontier } from './project-integration.mjs';
import { bindingFor, storedRun, verifyRef } from './project-director.mjs';
import * as waves from './project-director-waves.mjs';
import { workerRole } from './worker-roles.mjs';
import { applyWavePolicy } from './wave-policy.mjs';
import { quotePath } from './cli-command.mjs';
import { assignWorker, chargedBriefs, freeWorkerSlots, waveHorizon } from './execution-profile.mjs';
import { planProjectHorizon, waveRanks } from './project-planner.mjs';
import { enrichExternalWaveBrief, latestPriorTaskRun } from './wave-context.mjs';
import {
  cancelled,
  clockMs,
  command,
  currentOf,
  inFlightStates,
  integrationStarted,
  logEvent,
  need,
  retryable,
  settled,
  shaPattern,
  snapshotOf,
  storeOf,
  transition,
  wavePorts,
} from './project-external-shared.mjs';

// Merge commits of integrated tasks; the frontier must contain each of them.
function integratedMerges(snapshot, store) {
  const merges = [];
  for (const attempt of snapshot.currentAttempts) {
    if (!['integrated', ...settled].includes(attempt.status)) continue;
    const commit = storedRun(store, attempt.runId)?.integration?.mergeCommit;
    if (typeof commit === 'string' && shaPattern.test(commit)) merges.push(commit);
  }
  return merges;
}
function workerContract(run, writePaths, selfCheck) {
  return [
    'Worker contract (Kodo external task):',
    `- Work only inside the worktree ${run.cwd} on branch ${run.branch}. projectContext.root names the main checkout for reference only; never modify it or any other worktree.`,
    `- Change only files inside these write paths: ${JSON.stringify(writePaths)}.`,
    '- Do not delete, skip or weaken existing tests; add tests for new behaviour.',
    `- Commit your work on ${run.branch}. Do not push, open pull requests, merge or rebase onto other branches.`,
    `- Before finishing run the self-check: ${selfCheck}`,
    `- Finish with a clean worktree and report the full SHA of the final commit (git -C ${quotePath(run.cwd)} rev-parse HEAD).`,
  ].join('\n');
}
async function briefFor(state, attempt, task, run) {
  const { C, options, cli } = state,
    project = state.snapshot.project;
  const input = C.buildDirectorTaskInput({ project, task }, options);
  need(run.task === input, 'binding_invalid');
  const { role, instructions } = workerRole(task.owner);
  // The caller's CLI (`cli`): a chat runs the same Kodo package that issued the brief.
  const remote = remoteRefs(project.projectId, run);
  if (remote) await pushBase(run, remote, state.signal);
  const dispatcher = remote ? 'kodo' : cli;
  const selfCheck = remote
    ? 'kodo ci feedback --base ' + run.baseSha + ' --json'
    : `${cli} ci feedback --base ${run.baseSha} --project ${quotePath(run.cwd)} --json`;
  const prior = await latestPriorTaskRun({ store: storeOf(state.ctx), project, task, run, attempt });
  const previousAttempt = prior?.externalConflict?.previousAttempt;
  const previousRef = remote && previousAttempt && previousAttemptRef(project.projectId, run.id);
  if (previousRef) {
    await transport(
      run.project,
      ['push', remote.repository, previousAttempt.headSha + ':' + previousRef],
      state.signal,
    );
    if (!prior.retryRefPublished) storeOf(state.ctx).updateRun(prior.id, { retryRefPublished: true });
  } else if (previousAttempt && !remote && !prior.retryRefPublished) {
    // A local retry reads the earlier head from this repository: the earlier run's transport
    // refs are no longer needed, and GC may remove them (the flag releases them).
    storeOf(state.ctx).updateRun(prior.id, { retryRefPublished: true });
  }
  const portablePrevious = value =>
    remote
      ? {
          ...portableDiagnostics(
            value,
            [prior.cwd, run.cwd, state.integration.worktree],
            process.platform,
            privateBriefRoots(run, storeOf(state.ctx).home),
          ),
          ref: previousRef,
        }
      : value;
  let carry = previousAttempt ? '\nPort the changes in previousAttempt.diff onto the fresh baseSha.' : '';
  if (previousAttempt) {
    carry +=
      ' If truncated is true the diff is incomplete. Recover omittedFiles from previousAttempt.headSha in this repository.';
    if (previousAttempt.truncated === undefined)
      state.pendingDiffs.set(attempt.id, { priorId: prior.id, portablePrevious });
  }
  const referencePath = ref => {
    if (!remote || !path.isAbsolute(ref.path)) return ref.path;
    const relative = path.relative(project.root, ref.path);
    return relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)
      ? 'sha256:' + ref.sha256
      : relative.split(path.sep).join('/');
  };
  const interfaces = task.interfaceRefs.map(referencePath);
  const workerInput = remote ? portableDirectorTaskInput(input, referencePath) : input;
  const taskPrompt = remote
    ? [
        workerInput,
        'In your clone, run:',
        'git fetch ' + remote.repository + ' ' + remote.baseRef,
        ...(previousRef ? ['git fetch ' + remote.repository + ' ' + previousRef] : []),
        'git worktree add -b ' + run.branch + ' ' + run.id + ' ' + run.baseSha,
        'cd ' + run.id,
        'Implement only the assigned write paths. Preserve existing tests and add tests for new behaviour.',
        'Stage the assigned changes with git add.',
        'git commit -m "Implement assigned task"',
        selfCheck,
        'git push ' + remote.repository + ' HEAD:' + remote.workRef,
        'Report the full commit SHA.',
      ].join('\n')
    : `${input}\n\n${workerContract(run, task.writePaths, selfCheck)}`;
  // An automatic retry after an integration conflict (16B2) carries the earlier attempt's diff.
  const basePrompt = taskPrompt + carry;
  const { prompt, extra } = await enrichExternalWaveBrief({
    state,
    attempt,
    task,
    run,
    basePrompt,
    roleInstructions: instructions,
    diagnosticWorktrees: remote ? [run.cwd, state.integration.worktree] : null,
  });
  const brief = {
    ...run.workerPlacement,
    projectId: project.projectId,
    taskId: task.id,
    attemptId: attempt.id,
    runId: run.id,
    chatTitle: `Kodo · [${task.epicId}] ${task.title} · попытка ${attempt.number}`,
    role,
    roleInstructions: instructions,
    writePaths: [...task.writePaths],
    ...(remote ?? { worktree: run.cwd }),
    branch: run.branch,
    baseSha: run.baseSha,
    interfaces,
    prompt,
    ...(previousAttempt && { previousAttempt: portablePrevious(previousAttempt) }),
    selfCheck,
    completeCommand: `${dispatcher} project complete-task ${project.projectId} ${task.id} --head <SHA> --attempt ${attempt.id} --defer-gate`,
    abandonCommand: `${dispatcher} project complete-task ${project.projectId} ${task.id} --head <SHA> --abandon --attempt ${attempt.id}`,
    ...extra,
  };
  if (remote) assertRemoteBriefPaths(brief, privateBriefRoots(run, storeOf(state.ctx).home));
  C.assertDirectorSafe(brief, options);
  return brief;
}
async function installExternalRun(state, attempt, task) {
  const { ctx, C, options, host, integration } = state;
  const snapshot = state.snapshot;
  const baseSha = await waveFrontier({
    worktree: integration.worktree,
    mergeCommits: integratedMerges(snapshot, storeOf(ctx)),
  });
  const input = C.buildDirectorTaskInput({ project: snapshot.project, task }, options);
  return ctx.engine.createReserved(
    input,
    { project: snapshot.project.root, providers: 'current', baseSha, delivery: 'none' },
    {
      binding: bindingFor(attempt),
      installRun: async value => {
        // External chats implement; Kodo only verifies once (task-fast) and never delivers.
        if (state.profile) {
          const placement = placementFor(state, task, attempt.id);
          need(placement, 'pool_unavailable');
          value.runDraft.workerPlacement = placement;
          if (placement.machine.kind !== 'local') {
            value.runDraft.remoteIntegrationWorktree = integration.worktree;
            value.runDraft.transportRemote =
              state.profile.machines.find(m => m.id === placement.machine.id)?.gitRemote ?? 'origin';
          }
        }
        value.runDraft.executor = { kind: 'external', host };
        value.runDraft.verificationProfile = 'task-fast';
        // The policy of the base commit, not of the user's checkout (runtime/wave-policy.mjs).
        await applyWavePolicy(value.runDraft, value.runDraft.baseSha, { secrets: ctx.engine.secrets });
        value.runDraft.config.repairRounds = 1;
        // No independent review of its own (the epic gate reviews): an explicit null keeps the
        // persisted acceptance observation equal to the Run's (JSON drops undefined fields).
        value.runDraft.review = null;
        state.checkLease();
        return ctx.repo.installRun(value);
      },
    },
  );
}
// reserved → running for the attempt; proposed/blocked/failed → ready → running for the task.
async function advanceToRunning(state, taskId) {
  const { ctx } = state,
    projectId = state.snapshot.project.projectId;
  for (let step = 0; step < 4; step++) {
    const snapshot = (state.snapshot = await snapshotOf(ctx, projectId));
    const attempt = currentOf(snapshot, taskId),
      task = snapshot.tasks.find(row => row.id === taskId);
    let action = null;
    if (attempt.status === 'reserved') action = transition('attempt', attempt.id, 'running');
    else if (['proposed', 'blocked', 'failed'].includes(task.status)) action = transition('task', task.id, 'ready');
    else if (task.status === 'ready') action = transition('task', task.id, 'running');
    if (!action) return;
    state.checkLease();
    await ctx.repo.apply(command(snapshot, action));
  }
}
async function prepareAttempt(state, attempt) {
  const { ctx, host } = state,
    store = storeOf(ctx);
  const task = state.snapshot.tasks.find(row => row.id === attempt.taskId);
  let run = storedRun(store, attempt.runId) ?? (await installExternalRun(state, attempt, task));
  if (state.profile && run.workerPlacement) state.placements.set(attempt.id, run.workerPlacement);
  need(run.executor?.kind === 'external' && run.executor.host === host, 'attempt_not_external');
  need(isDeepStrictEqual(run.directorBinding, bindingFor(attempt)), 'binding_invalid');
  await makeWorktree(run.project, run.cwd, run.branch, run.baseSha, {
    signal: state.signal,
    onCreated: () => markTaskWorktree(run),
  });
  if (run.state === 'created') {
    need((await git(run.cwd, ['rev-parse', 'HEAD'])) === run.baseSha, 'worktree_mismatch');
    state.checkLease();
    run = store.updateRun(run.id, { state: 'executing', headSha: run.baseSha });
    logEvent(
      store,
      run.id,
      'brief_issued',
      {
        attemptId: attempt.id,
        host,
        ...(run.workerPlacement
          ? {
              subscriptionId: run.workerPlacement.subscription?.id ?? null,
              machineId: run.workerPlacement.machine?.id ?? null,
            }
          : {}),
      },
      clockMs(ctx),
    );
  }
  await advanceToRunning(state, attempt.taskId);
  const current = currentOf(state.snapshot, attempt.taskId);
  state.briefs.push(
    await briefFor(
      state,
      current,
      state.snapshot.tasks.find(row => row.id === task.id),
      run,
    ),
  );
  state.inFlight.add(task.id);
}
// One task's failure is reported, never fatal to the batch; the next call resumes it.
async function guarded(state, taskId, work) {
  try {
    await work();
  } catch (error) {
    if (state.signal?.aborted || error?.code === 'cancelled') throw error;
    state.blocked.push({ taskId, code: typeof error?.code === 'string' ? error.code : 'project_blocked' });
  } finally {
    state.checkLease();
  }
}
function admissible(state, task) {
  const { C, snapshot } = state;
  if (
    !task.dependsOn.every(id =>
      snapshot.tasks.some(row => row.id === id && C.dependencySatisfied(snapshot.project, row.status)),
    )
  )
    return 'project_dependency_unsatisfied';
  if (
    task.riskApprovalRequired &&
    !snapshot.riskApprovals.some(row => row.taskId === task.id && row.taskRevision === task.revision)
  )
    return 'project_risk_unapproved';
  const busy = snapshot.tasks.filter(row => row.id !== task.id && state.inFlight.has(row.id));
  if (busy.some(row => scopesOverlap(row.writePaths, task.writePaths))) return 'project_write_conflict';
  return null;
}
// In-flight attempts of this host first: a repeated call returns the same briefs.
export async function resumeInFlight(state, replayOnly) {
  const store = storeOf(state.ctx);
  for (const attempt of state.snapshot.currentAttempts)
    if (inFlightStates.has(attempt.status)) state.inFlight.add(attempt.taskId);
  for (const attempt of state.snapshot.currentAttempts.filter(row => inFlightStates.has(row.status))) {
    // Only this host's own attempts are resumed, a reservation without a Run included
    // (by its reservation actor); the drain's and other hosts' attempts are left alone.
    const executor = await waves.attemptExecutor({ repo: state.ctx.repo, store }, state.snapshot, attempt);
    if (executor.kind !== 'external' || executor.host !== state.host) continue;
    const run = storedRun(store, attempt.runId);
    if ((replayOnly && !run) || run?.integration?.status === 'merged') continue;
    if (state.profile?.machines.some(m => m.down && m.id === run?.workerPlacement?.machine?.id)) {
      if (run?.state === 'succeeded' || integrationStarted(run)) continue;
      state.blocked.push({
        taskId: attempt.taskId,
        attemptId: attempt.id,
        code: 'project_machine_down',
        hint: 'Abandon the attempt and use next-wave --retry-failed.',
      });
      continue;
    }
    await guarded(state, attempt.taskId, () => prepareAttempt(state, currentOf(state.snapshot, attempt.taskId)));
  }
}
async function interfacesVerified(state, task) {
  try {
    for (const ref of task.interfaceRefs) await verifyRef(state.ctx.engine, ref);
    return true;
  } catch {
    return false;
  }
}
export function initializePlacements(state) {
  if (!state.profile) return true;
  const { tasks, currentAttempts } = state.snapshot;
  state.placements = new Map();
  for (const attempt of currentAttempts) {
    if (inFlightStates.has(attempt.status))
      state.placements.set(attempt.id, storedRun(storeOf(state.ctx), attempt.runId)?.workerPlacement);
  }
  try {
    state.ranks = waveRanks(tasks);
  } catch (error) {
    if (
      !['project_dependency_missing', 'project_dependency_duplicate', 'project_dependency_cycle'].includes(error.code)
    )
      throw error;
    state.blocked.push({ kind: 'project', id: state.snapshot.project.projectId, code: error.code });
    return false;
  }
  state.maxDepth = Math.max(0, ...tasks.filter(openTask).map(t => state.ranks.get(t.id).depth));
  return true;
}
function placementFor(state, task, reservationId = null) {
  const { snapshot, ranks } = state;
  const depth = ranks.get(task.id).depth;
  const foundation = snapshot.epics.some(
    e => e.id === task.epicId && (e.id === 'foundation' || e.milestoneId === 'foundation'),
  );
  const heavy = foundation || (depth > 0 && depth >= state.maxDepth);
  const tiers = heavy
    ? ['heavy', 'standard', 'fast']
    : depth
      ? ['standard', 'heavy', 'fast']
      : ['fast', 'standard', 'heavy'];
  const occupied = [...state.placements].filter(([id]) => id !== reservationId).map(([, placement]) => placement);
  return assignWorker(state.profile, state.now, occupied, tiers);
}
function freeSlots(state) {
  if (!state.profile) return state.limit - state.briefs.length;
  const batch = state.limit - chargedBriefs(state.profile, state.now, state.briefs);
  return Math.min(batch, freeWorkerSlots(state.profile, state.now, [...state.placements.values()]));
}
async function reserve(state, task, retryFailed) {
  if (freeSlots(state) <= 0) return;
  const reason =
    admissible(state, task) ?? ((await interfacesVerified(state, task)) ? null : 'project_interface_unverified');
  if (reason) {
    state.blocked.push({ taskId: task.id, code: reason });
    return;
  }
  await guarded(state, task.id, async () => {
    const { ctx } = state;
    if (task.status === 'proposed') {
      state.checkLease();
      await ctx.repo.apply(command(state.snapshot, transition('task', task.id, 'ready')));
      state.snapshot = await snapshotOf(ctx, task.projectId);
    }
    state.checkLease();
    // The reservation names its executor: only this host may later resume it.
    const { attempt } = await ctx.repo.apply(
      command(
        state.snapshot,
        { op: 'reserveAttempt', taskId: task.id, retryFailed },
        { actor: waves.externalReserver(state.host) },
      ),
    );
    state.inFlight.add(task.id);
    state.placements?.set(attempt.id, undefined);
    state.snapshot = await snapshotOf(ctx, task.projectId);
    await prepareAttempt(state, attempt);
  });
}
const byPriority = (a, b) => b.priority - a.priority || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
// A retry goes to the executor of the failed attempt: this host retries only its own attempts;
// the drain's (native) and other hosts' failed attempts are left to them.
export async function reserveRetries(state, manual) {
  const store = storeOf(state.ctx);
  const candidates = state.snapshot.tasks
    .filter(task => !settled.has(task.status) && task.status !== 'integrated' && task.status !== 'cancelled')
    .filter(task => retryable.has(currentOf(state.snapshot, task.id)?.status))
    .sort(byPriority);
  for (const candidate of candidates) {
    const current = currentOf(state.snapshot, candidate.id);
    if (!manual && !storedRun(store, current.runId)?.externalConflict) continue;

    if (freeSlots(state) <= 0) return;
    const executor = await waves.attemptExecutor(
      { repo: state.ctx.repo, store },
      state.snapshot,
      currentOf(state.snapshot, candidate.id),
    );
    if (executor.kind !== 'external' || executor.host !== state.host) {
      if (manual) state.blocked.push({ taskId: candidate.id, code: 'project_retry_executor' });
      continue;
    }
    await reserve(
      state,
      state.snapshot.tasks.find(row => row.id === candidate.id),
      true,
    );
  }
}
export async function reserveSelected(state, ports) {
  const remaining = freeSlots(state);
  if (remaining <= 0) return;
  const W = wavePorts(ports, ['selectWave']);
  // Like drain: a task whose interface proofs do not verify is never selected. The rows are kept
  // for the explanation of the same revision; a reservation still checks its proofs right before.
  const availability = await waves.waveAvailability(state.ctx, state.snapshot);
  state.availability = { revision: state.snapshot.revision, rows: availability };
  const selected = W.selectWave(state.snapshot, {
    ...(state.profile && { profiledWave: true, windowSize: state.maximum }),
    limit: remaining,
    inFlight: [...state.inFlight],
    availability,
    now: (state.ctx.clock ?? (() => new Date().toISOString()))(),
  });
  need(Array.isArray(selected), 'wave_ports_invalid');
  for (const taskId of selected) {
    if (freeSlots(state) <= 0) return;
    const task = state.snapshot.tasks.find(row => row.id === taskId);
    if (!task || state.inFlight.has(task.id) || !['proposed', 'ready'].includes(task.status)) continue;
    if (state.blocked.some(row => row.taskId === task.id)) continue;
    const current = currentOf(state.snapshot, task.id);
    if (current && retryable.has(current.status)) {
      state.blocked.push({ taskId: task.id, code: 'project_retry_required' });
      continue;
    }
    if (current) continue;
    await reserve(state, task, false);
  }
}
// Planner reasons of a task the host can act on, in next-wave's codes and in this order of
// preference (a failed task with a failed attempt is retried). Waiting for a dependency, for work in
// flight or for the wave limit is not a blocker.
const actionable = [
  ['retry_required', 'project_retry_required'],
  ['attempt_revision_mismatch', 'project_retry_required'],
  ['risk_approval_required', 'project_risk_unapproved'],
  ['interfaces_unverified', 'project_interface_unverified'],
  ['split_required', 'project_split_required'],
  ['task_failed', 'project_task_failed'],
  ['task_blocked', 'project_task_blocked'],
];
const stoppedStates = ['blocked', 'failed', 'cancelled'];
const openTask = task => !['integrated', 'cancelled', ...settled].includes(task.status);
// Stopped epics and milestones, one row each, straight from the snapshot (even when every task of
// the epic is integrated): blocked or failed, or cancelled while it still holds a live task.
function stoppedContainers(snapshot) {
  const live = epicId => snapshot.tasks.some(task => task.epicId === epicId && task.status !== 'cancelled');
  const holds = {
    epic: epic => live(epic.id),
    milestone: milestone => snapshot.epics.some(epic => epic.milestoneId === milestone.id && live(epic.id)),
  };
  return [
    ['epic', snapshot.epics],
    ['milestone', snapshot.milestones],
  ].flatMap(([kind, rows]) =>
    rows
      .filter(row => stoppedStates.includes(row.status) && (row.status !== 'cancelled' || holds[kind](row)))
      .map(row => ({ code: `project_${kind}_${row.status}`, kind, id: row.id })),
  );
}
// The nearest cancelled task among the unmet transitive dependencies of `task`: a requirement that
// is never met. A dependency still on its way is ordinary waiting (null).
function cancelledPredecessor(C, snapshot, task) {
  const seen = new Set(),
    queue = [...task.dependsOn];
  while (queue.length) {
    const id = queue.shift();
    const dependency = snapshot.tasks.find(row => row.id === id);
    if (seen.has(id) || !dependency) continue;
    seen.add(id);
    if (dependency.status === 'cancelled') return dependency.id;
    if (!C.dependencySatisfied(snapshot.project, dependency.status)) queue.push(...dependency.dependsOn);
  }
  return null;
}
// The selection's proof checks at the same revision are reused; a refused proof may have been
// restored since, so it is checked again before it is named.
async function explanationAvailability(state, snapshot) {
  if (state.availability?.revision !== snapshot.revision) return waves.waveAvailability(state.ctx, snapshot);
  const rows = [];
  for (const row of state.availability.rows) {
    const task = !row.interfacesVerified && snapshot.tasks.find(item => item.id === row.taskId);
    const verified = row.interfacesVerified || (Boolean(task) && (await interfacesVerified(state, task)));
    rows.push(verified === row.interfacesVerified ? row : { ...row, interfacesVerified: true, reason: null });
  }
  return rows;
}
// Why open tasks are not handed out and which containers and gates hold the project, so that a
// short or empty wave always names its cause. Read-only: nothing is reserved or run here.
export async function explainWave(state, snapshot) {
  const { ctx, C } = state;
  const horizon = planProjectHorizon(
    {
      snapshot,
      limit: state.profile ? waveHorizon(Math.max(0, freeSlots(state)), state.inFlight.size, state.maximum) : 24,
      profiledWave: Boolean(state.profile),
      availability: await explanationAvailability(state, snapshot),
      now: (ctx.clock ?? (() => new Date().toISOString()))(),
    },
    { contracts: C, knownValues: state.options.knownValues },
  );
  const named = new Set([...state.blocked.map(row => row.taskId), ...state.briefs.map(row => row.taskId)]);
  for (const row of horizon.blocked) {
    const task = snapshot.tasks.find(item => item.id === row.taskId);
    if (!task || !openTask(task) || named.has(task.id)) continue;
    if (inFlightStates.has(currentOf(snapshot, task.id)?.status)) continue;
    const cancelled = cancelledPredecessor(C, snapshot, task);
    if (cancelled) {
      state.blocked.push({ taskId: task.id, code: 'project_dependency_cancelled', dependencyId: cancelled });
      continue;
    }
    const found = actionable.find(([reason]) => row.reasons.includes(reason));
    if (found) state.blocked.push({ taskId: task.id, code: found[1] });
  }
  state.blocked.push(...stoppedContainers(snapshot), ...waves.gateHolds({ store: storeOf(ctx) }, snapshot));
}
export async function watchWorkers(ctx, briefs, stallMinutes, signal) {
  const watch = [];
  const now = Date.parse((ctx.clock ?? (() => new Date().toISOString()))());
  for (const brief of briefs) {
    const run = storeOf(ctx).getRun(brief.runId);
    const add = (code, hint, since) =>
      watch.push({ attemptId: brief.attemptId, taskId: brief.taskId, code, hint, since });
    if (cancelled(run) || run.externalCompletion) continue;
    if (run.externalFailure?.repeated)
      add('worker_repeated_failure', 'Forward the first diagnostic to the worker.', run.externalFailure.since);
    if (brief.baseRef) {
      if (run.externalFailure?.code === 'external_scope')
        add(
          'worker_scope_violation',
          'Ask the worker to revert out-of-scope changes or abandon and reassign.',
          run.externalFailure.since,
        );
      continue;
    }
    const observe = async args => {
      try {
        const result = await execute('git', ['--no-optional-locks', ...args], {
          cwd: run.cwd,
          rawOutput: true,
          allowFailure: true,
          signal,
        });
        return result.code === 0 ? result.stdout : null;
      } catch (error) {
        if (error?.code === 'ENOENT') return null;
        throw error;
      }
    };
    const status = await observe(['status', '--no-renames', '--porcelain=v1', '-z', '--untracked-files=all']);
    if (status === null) continue;
    const dirty = status
      .split('\0')
      .filter(Boolean)
      .map(entry => entry.slice(3));
    const head = (await observe(['rev-parse', '--verify', 'refs/heads/' + run.branch]))?.trim();
    if (!head) continue;
    const changed =
      head !== run.baseSha ? await observe(['diff', '--name-only', '--no-renames', '-z', run.baseSha, head]) : '';
    if (dirty.concat((changed ?? '').split('\0').filter(Boolean)).some(file => !ownsPath(brief.writePaths, file)))
      add(
        'worker_scope_violation',
        'Ask the worker to revert out-of-scope changes or abandon and reassign.',
        new Date(now).toISOString(),
      );
    if (!dirty.length && head === run.baseSha && now - Date.parse(run.createdAt) > stallMinutes * 60000)
      add('worker_no_progress', 'Remind the worker to start or abandon and reassign.', run.createdAt);
  }
  return watch;
}
