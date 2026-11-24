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
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { stat } from 'node:fs/promises';
import { execute } from './command.mjs';
import { git, makeWorktree, plannedWorktreeHome } from './workspace.mjs';
import { scopesOverlap } from './contracts.mjs';
import { redact } from './security.mjs';
import { isPullHost } from './job-contracts.mjs';
import {
  ensureIntegration,
  inspectHistory,
  integrationHeadOf,
  mergeOnBranch,
  waveFrontier,
} from './project-integration.mjs';
import { integrationLeaseHeld, withIntegrationLease } from './project-integration-lease.mjs';
import { bindingFor, known, storedRun, verifyRef } from './project-director.mjs';
import * as waves from './project-director-waves.mjs';
import {
  acquireLeaseWaiting,
  leaseOwned,
  projectSectionHeld,
  withGateController,
  withHeldLease,
  withProjectSection,
} from './project-controller-lease.mjs';
import { withMachineBuild } from './machine-build-lease.mjs';
import { awaitIntegration, drainIntegrationQueue, openIntegrationQueue } from './project-integration-queue.mjs';
import { verifyTaskFastOnce } from './wave-verifier.mjs';
import { workerRole } from './worker-roles.mjs';
import { applyWavePolicy } from './wave-policy.mjs';
import { DEFAULT_CLI, assertCliPrefix, quotePath } from './cli-command.mjs';
import { planProjectHorizon } from './project-planner.mjs';

/** The largest batch one `nextWave` call returns. */
export const MAX_WAVE_LIMIT = 5;
const shaPattern = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const uuidPattern = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const settled = new Set(['accepted', 'released']);
const retryable = new Set(['blocked', 'failed', 'cancelled']);
const inFlightStates = new Set(['reserved', 'running', 'verifying']);
const fail = code => {
  throw Object.assign(new Error(`Project ${code}`), { code: `project_${code}` });
};
const need = (value, code) => {
  if (!value) fail(code);
};
const storeOf = ctx => ctx.store ?? ctx.engine.store;
const currentOf = (snapshot, taskId) => snapshot.currentAttempts.find(row => row.taskId === taskId);

async function contractsOf(ctx) {
  return ctx.contracts || (await import('./project-contracts.mjs'));
}

function wavePorts(ports, names) {
  const loaded = ports ?? waves;
  for (const name of names) need(typeof loaded?.[name] === 'function', 'wave_ports_invalid');
  return loaded;
}

async function snapshotOf(ctx, projectId) {
  const snapshot = await ctx.repo.snapshot(projectId);
  for (const name of ['milestones', 'epics', 'tasks', 'currentAttempts', 'riskApprovals']) {
    const count = snapshot.completeness?.[name];
    need(count?.complete === true && count.total === snapshot[name]?.length, 'snapshot_incomplete');
  }
  return snapshot;
}

const command = (snapshot, action, options = {}) => ({
  schemaVersion: 1,
  commandId: options.commandId || randomUUID(),
  projectId: snapshot.project.projectId,
  expectedRevision: snapshot.revision,
  actor: options.actor || 'project-external',
  reason: options.reason || 'External worker pull protocol',
  action,
});

const transition = (kind, id, to) => ({ op: 'transition', kind, id, to, evidence: [], mappings: [] });

function controlOf(snapshot) {
  need(
    !snapshot.project.paused &&
      !['cancelled', 'failed', 'blocked', 'accepted', 'released'].includes(snapshot.project.status),
    'control_blocked',
  );
}

async function ancestor(cwd, base, head) {
  const result = await execute('git', ['merge-base', '--is-ancestor', base, head], { cwd, allowFailure: true });
  need([0, 1].includes(result.code), 'git_invalid');
  return result.code === 0;
}

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

function briefFor(state, attempt, task, run) {
  const { C, options, cli } = state,
    project = state.snapshot.project;
  const input = C.buildDirectorTaskInput({ project, task }, options);
  need(run.task === input, 'binding_invalid');
  const { role, instructions } = workerRole(task.owner);
  // The caller's CLI (`cli`): a chat runs the same Kodo package that issued the brief.
  const selfCheck = `${cli} ci feedback --base ${run.baseSha} --project ${quotePath(run.cwd)} --json`;
  const brief = {
    projectId: project.projectId,
    taskId: task.id,
    attemptId: attempt.id,
    runId: run.id,
    chatTitle: `Kodo · [${task.epicId}] ${task.title} · попытка ${attempt.number}`,
    role,
    roleInstructions: instructions,
    writePaths: [...task.writePaths],
    worktree: run.cwd,
    branch: run.branch,
    baseSha: run.baseSha,
    interfaces: task.interfaceRefs.map(ref => ref.path),
    prompt: `${input}\n\n${workerContract(run, task.writePaths, selfCheck)}`,
    selfCheck,
    completeCommand: `${cli} project complete-task ${project.projectId} ${task.id} --head <SHA> --attempt ${attempt.id} --defer-gate`,
    abandonCommand: `${cli} project complete-task ${project.projectId} ${task.id} --head <SHA> --abandon --attempt ${attempt.id}`,
  };
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
        value.runDraft.executor = { kind: 'external', host };
        value.runDraft.verificationProfile = 'task-fast';
        // The policy of the base commit, not of the user's checkout (runtime/wave-policy.mjs).
        await applyWavePolicy(value.runDraft, value.runDraft.baseSha, { secrets: ctx.engine.secrets });
        value.runDraft.config.repairRounds = 1;
        // No independent review of its own (the epic gate reviews): an explicit null keeps the
        // persisted acceptance observation equal to the Run's (JSON drops undefined fields).
        value.runDraft.review = null;
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
    await ctx.repo.apply(command(snapshot, action));
  }
}

async function prepareAttempt(state, attempt) {
  const { ctx, host } = state,
    store = storeOf(ctx);
  const task = state.snapshot.tasks.find(row => row.id === attempt.taskId);
  let run = storedRun(store, attempt.runId) ?? (await installExternalRun(state, attempt, task));
  need(run.executor?.kind === 'external' && run.executor.host === host, 'attempt_not_external');
  need(isDeepStrictEqual(run.directorBinding, bindingFor(attempt)), 'binding_invalid');
  await makeWorktree(run.project, run.cwd, run.branch, run.baseSha);
  if (run.state === 'created') {
    need((await git(run.cwd, ['rev-parse', 'HEAD'])) === run.baseSha, 'worktree_mismatch');
    run = store.updateRun(run.id, { state: 'executing', headSha: run.baseSha });
  }
  await advanceToRunning(state, attempt.taskId);
  const current = currentOf(state.snapshot, attempt.taskId);
  state.briefs.push(
    briefFor(
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
    state.blocked.push({ taskId, code: typeof error?.code === 'string' ? error.code : 'project_blocked' });
  } finally {
    storeOf(state.ctx).renewLease(state.token);
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
async function resumeInFlight(state) {
  const store = storeOf(state.ctx);
  for (const attempt of state.snapshot.currentAttempts)
    if (inFlightStates.has(attempt.status)) state.inFlight.add(attempt.taskId);
  for (const attempt of state.snapshot.currentAttempts.filter(row => inFlightStates.has(row.status))) {
    // Only this host's own attempts are resumed, a reservation without a Run included
    // (by its reservation actor); the drain's and other hosts' attempts are left alone.
    const executor = await waves.attemptExecutor({ repo: state.ctx.repo, store }, state.snapshot, attempt);
    if (executor.kind !== 'external' || executor.host !== state.host) continue;
    if (storedRun(store, attempt.runId)?.integration?.status === 'merged') continue;
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

async function reserve(state, task, retryFailed) {
  const reason =
    admissible(state, task) ?? ((await interfacesVerified(state, task)) ? null : 'project_interface_unverified');
  if (reason) {
    state.blocked.push({ taskId: task.id, code: reason });
    return;
  }
  await guarded(state, task.id, async () => {
    const { ctx } = state;
    if (task.status === 'proposed') {
      await ctx.repo.apply(command(state.snapshot, transition('task', task.id, 'ready')));
      state.snapshot = await snapshotOf(ctx, task.projectId);
    }
    // The reservation names its executor: only this host may later resume it.
    const { attempt } = await ctx.repo.apply(
      command(
        state.snapshot,
        { op: 'reserveAttempt', taskId: task.id, retryFailed },
        { actor: waves.externalReserver(state.host) },
      ),
    );
    state.snapshot = await snapshotOf(ctx, task.projectId);
    await prepareAttempt(state, attempt);
  });
}

const byPriority = (a, b) => b.priority - a.priority || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

// A retry goes to the executor of the failed attempt: this host retries only its own attempts;
// the drain's (native) and other hosts' failed attempts are left to them.
async function reserveRetries(state, limit) {
  const store = storeOf(state.ctx);
  const candidates = state.snapshot.tasks
    .filter(task => !settled.has(task.status) && task.status !== 'integrated' && task.status !== 'cancelled')
    .filter(task => retryable.has(currentOf(state.snapshot, task.id)?.status))
    .sort(byPriority);
  for (const candidate of candidates) {
    if (state.briefs.length >= limit) return;
    const executor = await waves.attemptExecutor(
      { repo: state.ctx.repo, store },
      state.snapshot,
      currentOf(state.snapshot, candidate.id),
    );
    if (executor.kind !== 'external' || executor.host !== state.host) {
      state.blocked.push({ taskId: candidate.id, code: 'project_retry_executor' });
      continue;
    }
    await reserve(
      state,
      state.snapshot.tasks.find(row => row.id === candidate.id),
      true,
    );
  }
}

async function reserveSelected(state, limit, ports) {
  const remaining = limit - state.briefs.length;
  if (remaining <= 0) return;
  const W = wavePorts(ports, ['selectWave']);
  // Like drain: a task whose interface proofs do not verify is never selected. The rows are kept
  // for the explanation of the same revision; a reservation still checks its proofs right before.
  const availability = await waves.waveAvailability(state.ctx, state.snapshot);
  state.availability = { revision: state.snapshot.revision, rows: availability };
  const selected = W.selectWave(state.snapshot, {
    limit: remaining,
    inFlight: [...state.inFlight],
    availability,
    now: (state.ctx.clock ?? (() => new Date().toISOString()))(),
  });
  need(Array.isArray(selected), 'wave_ports_invalid');
  for (const taskId of selected) {
    if (state.briefs.length >= limit) return;
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
async function explainWave(state, snapshot) {
  const { ctx, C } = state;
  const horizon = planProjectHorizon(
    {
      snapshot,
      limit: 24,
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

/**
 * Reserve the next wave for an external host: the briefs of this host's running
 * attempts, then new non-overlapping tasks up to `limit` (1..5). `cli` is the command
 * prefix of the brief commands and is returned with them (default `kodo`). `blocked` names why
 * the rest waits: task rows `{taskId, code}` and gate rows `{code, kind, id, gateId?, runId?}`
 * (`gateHolds`). An accepted project returns `code: 'project_accepted'` and no briefs.
 * @param {{ repo: any, engine: any, store?: any, contracts?: any, clock?: () => string }} ctx
 * @param {{ projectId: string, host: string, limit?: number, retryFailed?: boolean, ports?: any, cli?: string }} input
 */
export async function nextWave(ctx, input) {
  const { projectId, host, limit = 3, retryFailed = false, ports, cli = DEFAULT_CLI } = input;
  need(isPullHost(host), 'host_unsupported');
  need(Number.isSafeInteger(limit) && limit >= 1 && limit <= MAX_WAVE_LIMIT, 'limit_invalid');
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
  const token = store.acquireLease(`project:${projectId}`, randomUUID(), { ttlMs: 60000, limit: 1 });
  need(token, 'busy');
  try {
    const integration = await ensureIntegration({
      root: snapshot.project.root,
      projectId,
      worktreeHome: await waves.integrationHome(store),
    });
    const state = {
      ctx,
      C,
      host,
      cli,
      token,
      integration,
      options,
      snapshot: await snapshotOf(ctx, projectId),
      inFlight: new Set(),
      briefs: [],
      blocked: [],
    };
    await resumeInFlight(state);
    if (retryFailed) await reserveRetries(state, limit);
    await reserveSelected(state, limit, ports);
    const final = await snapshotOf(ctx, projectId);
    await explainWave(state, final);
    const revision = final.revision;
    const result = { projectId, revision, cli, briefs: state.briefs, blocked: state.blocked };
    C.assertDirectorSafe(result, options);
    return result;
  } finally {
    store.releaseLease(token);
  }
}

// Symbolic links and submodules never enter the integration branch (raw output: never redacted).
async function specialEntries(cwd, base, head) {
  const raw = await git(cwd, ['diff', '--raw', '--no-renames', '--no-abbrev', base, head], { rawOutput: true });
  return raw
    .split(/\r?\n/)
    .filter(Boolean)
    .filter(line => /^:\d{6} (?:120000|160000) /.test(line));
}

// What the worker chat has to fix for each refusal of the submitted commit (constant text).
const submissionMessages = {
  external_branch_mismatch: 'The brief branch does not point at --head: commit on brief.branch and submit its head.',
  external_worktree_missing: 'The brief worktree is missing or is not a Git work tree.',
  external_worktree_mismatch:
    'The brief worktree is not on brief.branch at --head: check out brief.branch there and submit its head.',
  external_worktree_dirty: 'The brief worktree has uncommitted or untracked files: commit or remove them.',
  external_no_changes: '--head equals brief.baseSha: commit the change before submitting.',
  external_not_descendant: 'brief.baseSha is not an ancestor of --head: commit on top of brief.baseSha without rebase.',
  external_symlink: 'The change adds a symbolic link or a submodule: replace it with regular files.',
  external_head_changed: 'The worktree head moved while the checks ran: submit the current head again.',
};

const problem = (code, error, secrets = {}) => ({
  code,
  ...(error
    ? { message: redact(String(error.message), secrets).slice(0, 2000) }
    : submissionMessages[code]
      ? { message: submissionMessages[code] }
      : {}),
});

const historyCodes = {
  scope: 'external_scope',
  secret_path: 'external_scope',
  special: 'external_symlink',
  secret: 'external_unsafe_change',
  unverifiable: 'external_history_unverifiable',
  too_long: 'external_history_too_long',
};

// Every commit of base..head, not only the result: a secret committed and deleted later is still
// in the history the merge would bring into the integration branch.
async function historyDefect(engine, run, task, head) {
  const found = await inspectHistory({
    cwd: run.project,
    base: run.baseSha,
    head,
    writePaths: task.writePaths,
    secrets: engine.secrets,
  });
  if (!found) return null;
  const where = found.commit ? `commit ${found.commit.slice(0, 12)}: ${found.file}` : `more than the commit limit`;
  return {
    code: historyCodes[found.kind],
    message: redact(`Unsafe history (${found.kind}) in ${where}`, engine.secrets).slice(0, 2000),
  };
}

// The worker's branch and worktree still stand clean on `head`; the first defect otherwise. Checked
// on submission and again by the queue drain right before the merge.
async function workerStateDefect(run, head) {
  const branch = await execute('git', ['rev-parse', '--verify', '--quiet', `refs/heads/${run.branch}`], {
    cwd: run.project,
    allowFailure: true,
  });
  if (branch.code !== 0 || branch.stdout.trim() !== head) return problem('external_branch_mismatch');
  // A deleted worktree directory: git cannot even start there (ENOENT), so it is checked first.
  const directory = await stat(run.cwd).catch(() => null);
  if (!directory?.isDirectory()) return problem('external_worktree_missing');
  const worktreeHead = await execute('git', ['rev-parse', 'HEAD'], { cwd: run.cwd, allowFailure: true });
  if (worktreeHead.code !== 0) return problem('external_worktree_missing');
  if (
    worktreeHead.stdout.trim() !== head ||
    (await git(run.cwd, ['branch', '--show-current'], { rawOutput: true })) !== run.branch
  )
    return problem('external_worktree_mismatch');
  if (await git(run.cwd, ['status', '--porcelain=v1', '--untracked-files=all']))
    return problem('external_worktree_dirty');
  return null;
}

// Worker-fixable defects of the submitted commit, before any check runs.
async function inspectSubmission(engine, run, task, head) {
  const state = await workerStateDefect(run, head);
  if (state) return state;
  if (head === run.baseSha) return problem('external_no_changes');
  if (!(await ancestor(run.project, run.baseSha, head))) return problem('external_not_descendant');
  const history = await historyDefect(engine, run, task, head);
  if (history) return history;
  if ((await specialEntries(run.project, run.baseSha, head)).length) return problem('external_symlink');
  try {
    await engine.checkScope(run.cwd, run.baseSha, task.writePaths);
  } catch (error) {
    return problem(
      error.code === 'scope_conflict' ? 'external_scope' : 'external_unsafe_change',
      error,
      engine.secrets,
    );
  }
  return null;
}

async function abandonAttempt(ctx, snapshot, attempt, run, { head, commandId }) {
  const store = storeOf(ctx);
  // The abandon names its attempt and head: a late repeat replays it and never stops a retry.
  const abandoned = run.externalAbandon ?? { schemaVersion: 1, attemptId: attempt.id, headSha: head };
  if (attempt.status === 'blocked') {
    if (run.state !== 'cancelled' || !run.externalAbandon)
      store.updateRun(run.id, { cancelRequested: true, state: 'cancelled', externalAbandon: abandoned });
    return { status: 'abandoned', attemptId: attempt.id, revision: snapshot.revision, replayed: true };
  }
  if (!inFlightStates.has(attempt.status) || run.integration?.status === 'merged')
    return { status: 'blocked', code: 'project_attempt_not_running', revision: snapshot.revision };
  await ctx.repo.apply(
    command(snapshot, transition('attempt', attempt.id, 'blocked'), {
      commandId,
      reason: 'External worker abandoned the task',
    }),
  );
  store.updateRun(run.id, {
    cancelRequested: true,
    state: 'cancelled',
    error: { code: 'external_abandoned', message: 'External worker abandoned the task' },
    externalAbandon: abandoned,
  });
  return {
    status: 'abandoned',
    attemptId: attempt.id,
    revision: (await snapshotOf(ctx, snapshot.project.projectId)).revision,
  };
}

// The Runs of this task's attempts that an abandon already stopped with `head`.
function recordedAbandons(ctx, snapshot, taskId, head) {
  return storeOf(ctx)
    .listRuns(snapshot.project.root)
    .filter(
      row =>
        row.directorBinding?.projectId === snapshot.project.projectId &&
        row.directorBinding.taskId === taskId &&
        row.executor?.kind === 'external' &&
        row.externalAbandon?.schemaVersion === 1 &&
        row.externalAbandon.attemptId === row.directorBinding.attemptId &&
        row.externalAbandon.headSha === head,
    );
}

// The Run of an earlier attempt of this task that an abandon already stopped (`attemptId`). Null
// when the current attempt is meant or the named attempt was never abandoned.
function earlierAbandon(ctx, snapshot, attempt, attemptId) {
  if (attemptId === attempt.id) return null;
  return (
    storeOf(ctx)
      .listRuns(snapshot.project.root)
      .find(
        row =>
          row.directorBinding?.projectId === snapshot.project.projectId &&
          row.directorBinding.taskId === attempt.taskId &&
          row.directorBinding.attemptId === attemptId &&
          row.executor?.kind === 'external' &&
          row.externalAbandon?.schemaVersion === 1,
      ) ?? null
  );
}

const replayedAbandon = (row, snapshot) => ({
  status: 'abandoned',
  attemptId: row.directorBinding.attemptId,
  revision: snapshot.revision,
  replayed: true,
});

// `--abandon` stops exactly the attempt it names (`attemptId`): a repeat for an earlier attempt
// returns that result and leaves the current attempt (a retry) alone; a named attempt that is
// not current is stale. Without an attempt id only an unambiguous repeat of an abandon already
// recorded with this head is answered (its result, nothing changes); anything else is
// `project_arguments` and never stops the current attempt.
async function abandonTarget(ctx, { snapshot, attempt, run }, input) {
  if (input.attemptId === undefined) {
    const recorded = recordedAbandons(ctx, snapshot, attempt.taskId, input.head);
    need(recorded.length === 1, 'arguments');
    return replayedAbandon(recorded[0], snapshot);
  }
  const earlier = earlierAbandon(ctx, snapshot, attempt, input.attemptId);
  if (earlier) return replayedAbandon(earlier, snapshot);
  if (input.attemptId !== attempt.id)
    return { status: 'blocked', code: 'project_attempt_stale', revision: snapshot.revision };
  return abandonAttempt(ctx, snapshot, attempt, run, input);
}

async function runGates(W, waveCtx, projectId, signal, retryFailed = false) {
  const gates = await W.runPendingGates(waveCtx, { projectId, signal, retryFailed });
  need(gates && typeof gates === 'object', 'wave_ports_invalid');
  return gates;
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
  return withGateController(storeOf(ctx), projectId, async () => {
    // The same control states complete-task refuses: a gate pass never reports success for them.
    const controlled = project => project.paused || ['cancelled', 'failed', 'blocked'].includes(project.status);
    const snapshot = await snapshotOf(ctx, projectId);
    if (controlled(snapshot.project))
      return { status: 'blocked', code: 'project_control_blocked', revision: snapshot.revision };
    if (signal?.aborted) return { status: 'blocked', code: 'project_cancelled', revision: snapshot.revision };
    const W = wavePorts(input.ports, ['createWaveContext', 'runPendingGates']);
    const waveCtx = sectionedContext(ctx, C, W, projectId, signal);
    let gates;
    try {
      gates = await runGates(W, waveCtx, projectId, signal, retryFailed === true);
    } catch (error) {
      if (error?.code !== 'project_cancelled') throw error;
      return { status: 'blocked', code: error.code, revision: (await snapshotOf(ctx, projectId)).revision };
    }
    // A pause, cancel or block during the pass (`project pause` takes no gate lease) or an
    // interrupted pass may stop the gates before any ran: never `passed`.
    const after = await snapshotOf(ctx, projectId);
    if (controlled(after.project))
      return { status: 'blocked', code: 'project_control_blocked', gates, revision: after.revision };
    if (signal?.aborted) return { status: 'blocked', code: 'project_cancelled', gates, revision: after.revision };
    const status = Array.isArray(gates.blocked) && gates.blocked.length ? 'blocked' : 'passed';
    return { status, gates, revision: after.revision };
  });
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
function sectionedContext(ctx, C, W, projectId, signal) {
  const store = storeOf(ctx);
  return {
    ...waveContextOf(ctx, C, W),
    exclusive: work => withProjectSection(store, projectId, work, { signal }),
  };
}

// Whether the merge the Run recorded is still on the integration branch with its recorded parents.
async function mergeRecorded(projectId, run) {
  const integration = run.integration;
  return (
    integration?.status === 'merged' &&
    integration.mergedHead === run.headSha &&
    (await mergeOnBranch({
      cwd: run.project,
      branchHead: await integrationHeadOf({ cwd: run.project, projectId }),
      mergeCommit: integration.mergeCommit,
      before: integration.before,
      mergedHead: run.headSha,
    }))
  );
}

// A completion already recorded for this head is returned, not repeated; deferred gates may still
// run (`finishCompletion`). The recorded merge is checked first under lease
// `project-integration:<id>` (reachable from the branch head with both recorded parents): a merge
// that left the branch (reset, rewrite) is a recovery blocker, never a replayed `integrated`. A
// queue row that a stopped drain left live for this head is finished with the same verdict.
// Runs in the caller's project section.
async function replayedMerge(ctx, input, run) {
  const store = storeOf(ctx),
    { projectId } = input;
  const present = await withIntegrationLease(store, projectId, () => mergeRecorded(projectId, run), {
    signal: input.signal,
  });
  const queue = openIntegrationQueue(store);
  if (present) {
    queue.settle(projectId, run.id, input.head, {
      status: 'integrated',
      integration: run.externalCompletion.integration,
    });
    return null;
  }
  queue.settle(projectId, run.id, input.head, { status: 'rejected', code: 'project_integration_missing' });
  return {
    status: 'blocked',
    code: 'project_integration_missing',
    integration: run.externalCompletion.integration,
    revision: (await snapshotOf(ctx, projectId)).revision,
    replayed: true,
  };
}

const integrationStarted = run => ['merged', 'pending'].includes(run.integration?.status);
const cancelled = run => Boolean(run.externalAbandon) || run.cancelRequested === true || run.state === 'cancelled';

// Where a submission of `head` stands now: `verified` (this head passed or is integrated), `stale`
// (another attempt or Run, an abandon or cancel, another head integrated, the attempt stopped) or
// `go` (verify it). Read in a project section.
async function verificationState(ctx, C, input, attemptId, runId) {
  const { attempt, run } = await externalAttempt(ctx, C, input.projectId, input.taskId);
  const head = input.head;
  if (attempt.id !== attemptId || run.id !== runId || cancelled(run)) return 'stale';
  if (run.externalCompletion?.headSha === head) return 'verified';
  if (integrationStarted(run))
    return run.integration.mergedHead === head || run.headSha === head ? 'verified' : 'stale';
  if (run.externalCompletion) return 'stale';
  if (run.state === 'succeeded' && run.headSha === head && run.checks?.headSha === head && run.checks.complete)
    return 'verified';
  return ['running', 'verifying'].includes(attempt.status) ? 'go' : 'stale';
}

// Verify the submitted head once. One verification per Run at a time (`project-verify:<runId>`,
// taken before the machine slot): a duplicate submission waits for the first and then finds the
// head verified. In one build slot of the machine (`machine-build:<id>`) the state is read again,
// `task-fast` runs outside `project:<id>`, and the verdict is written in a short project section
// that checks again for an abandon, a cancel, a recorded completion, an integration or another
// head; a cancel is never overwritten (`preserveCancellation`). A lost lease stops the check.
async function verifySubmission(ctx, C, step, input) {
  const store = storeOf(ctx),
    { projectId, head, signal } = input,
    { attempt, run } = step;
  const verify = typeof input.ports?.verifyTaskFast === 'function' ? input.ports.verifyTaskFast : verifyTaskFastOnce;
  const section = work => withProjectSection(store, projectId, work, { signal });
  const state = () => section(() => verificationState(ctx, C, input, attempt.id, run.id));
  const stale = { blocked: 'project_submission_stale' };
  const dedupe = await acquireLeaseWaiting(store, `project-verify:${run.id}`, { signal, waitMs: 2 * 3600000 });
  return withHeldLease(store, dedupe, async dedupeLost => {
    const before = await state();
    if (before !== 'go') return before === 'verified' ? null : stale;
    return withMachineBuild(
      store,
      async slotLost => {
        const now = await state();
        if (now !== 'go') return now === 'verified' ? null : stale;
        const checked = AbortSignal.any([dedupeLost, slotLost, ...(signal ? [signal] : [])]);
        let verdict;
        try {
          verdict = await verify({ engine: ctx.engine, run: run.id, signal: checked, expectedHeadSha: head });
        } catch (error) {
          // Another call verifies the same Run right now (its lease `run:<id>`).
          if (error?.code === 'run_busy') return { blocked: 'project_task_busy' };
          if (dedupeLost.aborted || slotLost.aborted) return { blocked: 'project_lease_lost' };
          if (cancelled(store.getRun(run.id))) return stale;
          throw error;
        }
        if (dedupeLost.aborted || slotLost.aborted || !leaseOwned(store, dedupe))
          return { blocked: 'project_lease_lost' };
        if (verdict.skipped)
          return verdict.code === 'head_changed'
            ? problem('external_head_changed')
            : (await state()) === 'verified'
              ? null
              : stale;
        return section(async () => {
          const current = await verificationState(ctx, C, input, attempt.id, run.id);
          const written = store.getRun(run.id);
          if (current === 'stale' || integrationStarted(written) || written.externalCompletion) return stale;
          if (!verdict.passed || verdict.headSha !== head) {
            store.updateRun(run.id, { state: 'executing' }, { preserveCancellation: true });
            return verdict.passed ? problem('external_head_changed') : { code: verdict.code, message: verdict.message };
          }
          store.updateRun(run.id, { state: 'succeeded', error: null }, { preserveCancellation: true });
          return null;
        });
      },
      { machine: input.machine, signal },
    );
  });
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
  const { attempt, run } = await externalAttempt(ctx, C, projectId, taskId);
  const stale = { status: 'rejected', code: 'project_submission_stale' };
  if (attempt.id !== entry.attemptId || run.id !== entry.runId) return stale;
  if (run.externalCompletion?.headSha === headSha)
    return (await mergeRecorded(projectId, run))
      ? { status: 'integrated', integration: run.externalCompletion.integration }
      : { status: 'rejected', code: 'project_integration_missing' };
  if (run.state !== 'succeeded' || run.headSha !== headSha || run.checks?.headSha !== headSha) return stale;
  if (run.baseSha !== entry.baseSha) return stale;
  // A merge that a stopped drain started continues (integrateAndAdvance recovers it).
  if (!integrationStarted(run)) {
    if (cancelled(run) || !['running', 'verifying'].includes(attempt.status)) return stale;
    if (await workerStateDefect(run, headSha)) return stale;
  }
  const integration = await W.integrateAndAdvance(waveCtx, { projectId, taskId, run: store.getRun(run.id), signal });
  if (integration?.status !== 'integrated') {
    const code = integration?.code ?? 'project_integration_blocked';
    const after = store.getRun(run.id);
    if (after.integration?.status === 'merged' && after.integration.mergedHead === headSha)
      return { status: 'failed', code, merged: true, integration: integration ?? null };
    return { status: 'rejected', code, integration: integration ?? null };
  }
  store.updateRun(run.id, { externalCompletion: { schemaVersion: 1, headSha, integration, gates: null } });
  return { status: 'integrated', integration };
}

// Drain the integration queue when this caller can take `project:<id>` and the integration lease
// at once (never waiting for them): true after a drain, false while another holder has either.
// The caller's own cancel and deadline (`expired`) end the drain between rows; they never reach
// the integration of rows other callers queued. A lost lease stops the drain, and a row's outcome
// is recorded only while both leases are still owned.
async function tryDrain(ctx, C, W, input, expired) {
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
              queue: openIntegrationQueue(store),
              projectId,
              scopeOf,
              stop: () => signal?.aborted === true || expired() || !owned(),
              owned,
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

const controlledProject = project => project.paused || ['cancelled', 'failed', 'blocked'].includes(project.status);

// After an integration: the pending gates unless deferred, in one gate pass (`project-gates:<id>`;
// `project_busy` while another pass runs — a repeated completion runs them later). The receipt is
// read again inside the pass: recorded gates never run twice. A pass that a cancel, a pause, a
// project stop or a block cut short records nothing (`gates` stays null for a safe repeat) and
// answers `blocked` with that code.
async function finishCompletion(ctx, C, input, run, replayed) {
  const store = storeOf(ctx),
    { projectId, signal } = input;
  const receipt = () => store.getRun(run.id).externalCompletion;
  let completion = receipt(),
    gates = completion.gates,
    code = null;
  if (gates === null && !input.deferGate) {
    const W = wavePorts(input.ports, ['createWaveContext', 'runPendingGates']);
    ({ gates, code } = await withGateController(store, projectId, async () => {
      completion = receipt();
      if (completion.gates !== null) return { gates: completion.gates, code: null };
      let result;
      try {
        result = await runGates(W, sectionedContext(ctx, C, W, projectId, signal), projectId, signal);
      } catch (error) {
        if (error?.code !== 'project_cancelled') throw error;
        return { gates: null, code: error.code };
      }
      if (signal?.aborted) return { gates: null, code: 'project_cancelled' };
      if (controlledProject((await snapshotOf(ctx, projectId)).project))
        return { gates: null, code: 'project_control_blocked' };
      store.updateRun(run.id, { externalCompletion: { ...receipt(), gates: result } });
      return { gates: result, code: null };
    }));
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

// The external Run of the task's current attempt, or a constant refusal.
async function externalAttempt(ctx, C, projectId, taskId) {
  const snapshot = await snapshotOf(ctx, projectId);
  need(C.isWaveProject(snapshot.project), 'wave_required');
  const task = snapshot.tasks.find(row => row.id === taskId);
  need(task, 'task_missing');
  const attempt = currentOf(snapshot, taskId);
  need(attempt, 'attempt_missing');
  const run = storedRun(storeOf(ctx), attempt.runId);
  need(
    run?.executor?.kind === 'external' && isDeepStrictEqual(run.directorBinding, bindingFor(attempt)),
    'attempt_not_external',
  );
  return { snapshot, task, attempt, run };
}

// The checks of a submission that need consistent project state, in one short project section:
// a decided result, a replay of a recorded completion, or the attempt to verify and integrate.
async function admitSubmission(ctx, C, input) {
  const { projectId, taskId, head, attemptId } = input;
  const current = await externalAttempt(ctx, C, projectId, taskId);
  const { snapshot, task, attempt, run } = current;
  const blocked = code => ({ result: { status: 'blocked', code, revision: snapshot.revision } });
  if (attemptId !== undefined && attemptId !== attempt.id) return blocked('project_attempt_stale');
  if (run.externalCompletion?.headSha === head) {
    const missing = await replayedMerge(ctx, input, run);
    return missing ? { result: missing } : { replay: run };
  }
  if (controlledProject(snapshot.project)) return blocked('project_control_blocked');
  // A verified head whose integration was interrupted (crash) continues where it stopped.
  const interrupted = run.state === 'succeeded' && run.headSha === head && integrationStarted(run);
  if (interrupted) return { ...current, verified: true };
  if (!['running', 'verifying'].includes(attempt.status) || run.integration?.status === 'merged')
    return blocked('project_attempt_not_running');
  const defect = await inspectSubmission(ctx.engine, run, task, head);
  if (defect) return { result: { status: 'checks_failed', ...defect, revision: snapshot.revision } };
  return { ...current, verified: false };
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
 * Concurrency: the Git, scope and secret checks run in a short section under `project:<id>`
 * (waited for; `project_busy` after the wait); `task-fast` runs outside it in one build slot of
 * the machine (`machine`: `{ id, maxHeavyBuilds }`, default one local slot), once per Run at a
 * time. The verified head is queued (`priority`, default 0) and merged by whichever submission
 * drains the queue; this call waits for its row (`integrationWaitMs`, then
 * `project_integration_queue_timeout`; `project_integration_queue_cancelled` on `signal` — the
 * row stays queued for a repeat).
 * @param {{ repo: any, engine: any, store?: any, contracts?: any, clock?: () => string }} ctx
 * @param {{ projectId: string, taskId: string, head: string, deferGate?: boolean, abandon?: boolean,
 *   commandId?: string, attemptId?: string, ports?: any, signal?: AbortSignal, priority?: number,
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
  if (abandon)
    return section(async () =>
      abandonTarget(ctx, await externalAttempt(ctx, C, projectId, taskId), { head, attemptId, commandId }),
    );
  const step = await section(() => admitSubmission(ctx, C, input));
  if (step.result) return step.result;
  const completion = { ...input, deferGate };
  if (step.replay) return finishCompletion(ctx, C, completion, step.replay, true);
  const { snapshot, attempt, run } = step;
  if (!step.verified) {
    const defect = await verifySubmission(ctx, C, step, input);
    if (defect && 'blocked' in defect)
      return { status: 'blocked', code: defect.blocked, revision: (await snapshotOf(ctx, projectId)).revision };
    if (defect) return { status: 'checks_failed', ...defect, revision: snapshot.revision };
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
  const queue = openIntegrationQueue(store);
  const entry = queue.enqueue({
    projectId,
    taskId,
    attemptId: attempt.id,
    runId: run.id,
    baseSha: run.baseSha,
    headSha: head,
    priority: input.priority ?? 0,
  });
  const done = await awaitIntegration({
    queue,
    seq: entry.seq,
    signal,
    waitMs: input.integrationWaitMs,
    tryDrain: expired => tryDrain(ctx, C, W, input, expired),
  });
  const outcome = done.outcome;
  if (done.status === 'failed') throw Object.assign(new Error(`Project ${outcome.code}`), { code: outcome.code });
  if (done.status === 'rejected')
    return {
      status: 'blocked',
      code: outcome.code,
      integration: outcome.integration ?? null,
      revision: outcome.integration?.revision ?? (await snapshotOf(ctx, projectId)).revision,
    };
  return finishCompletion(ctx, C, completion, run, false);
}
