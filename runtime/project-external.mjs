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
import { execute } from './command.mjs';
import { git, makeWorktree } from './workspace.mjs';
import { scopesOverlap } from './contracts.mjs';
import { redact } from './security.mjs';
import { isPullHost } from './job-contracts.mjs';
import { ensureIntegration, waveFrontier } from './project-integration.mjs';
import { bindingFor, known, storedRun } from './project-director.mjs';
import * as waves from './project-director-waves.mjs';
import { verifyTaskFastOnce } from './wave-verifier.mjs';
import { workerRole } from './worker-roles.mjs';

/** The largest batch one `nextWave` call returns. */
export const MAX_WAVE_LIMIT = 5;
const shaPattern = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
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

// Lease `project:<id>` held for one protocol call, renewed while long checks run.
async function withProjectLease(store, projectId, work) {
  const token = store.acquireLease(`project:${projectId}`, randomUUID(), { ttlMs: 60000, limit: 1 });
  need(token, 'busy');
  const timer = setInterval(() => {
    try {
      store.renewLease(token);
    } catch {
      /* A lost renewal surfaces on the next acquisition. */
    }
  }, 10000);
  timer.unref();
  try {
    return await work(token);
  } finally {
    clearInterval(timer);
    store.releaseLease(token);
  }
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

const quote = value => `"${value.replaceAll('"', '\\"')}"`;

function workerContract(run, writePaths, selfCheck) {
  return [
    'Worker contract (Kodo external task):',
    `- Work only inside the worktree ${run.cwd} on branch ${run.branch}. projectContext.root names the main checkout for reference only; never modify it or any other worktree.`,
    `- Change only files inside these write paths: ${JSON.stringify(writePaths)}.`,
    '- Do not delete, skip or weaken existing tests; add tests for new behaviour.',
    `- Commit your work on ${run.branch}. Do not push, open pull requests, merge or rebase onto other branches.`,
    `- Before finishing run the self-check: ${selfCheck}`,
    '- Finish with a clean worktree and report the full SHA of the final commit (git rev-parse HEAD).',
  ].join('\n');
}

function briefFor(state, attempt, task, run) {
  const { C, options } = state,
    project = state.snapshot.project;
  const input = C.buildDirectorTaskInput({ project, task }, options);
  need(run.task === input, 'binding_invalid');
  const { role, instructions } = workerRole(task.owner);
  const selfCheck = `kodo ci feedback --base ${run.baseSha} --project ${quote(run.cwd)} --json`;
  const brief = {
    projectId: project.projectId,
    taskId: task.id,
    attemptId: attempt.id,
    runId: run.id,
    chatTitle: `Kodo · [${task.epicId}] ${task.title}`,
    role,
    roleInstructions: instructions,
    writePaths: [...task.writePaths],
    worktree: run.cwd,
    branch: run.branch,
    baseSha: run.baseSha,
    interfaces: task.interfaceRefs.map(ref => ref.path),
    prompt: `${input}\n\n${workerContract(run, task.writePaths, selfCheck)}`,
    selfCheck,
    completeCommand: `kodo project complete-task ${project.projectId} ${task.id} --head <SHA>`,
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

async function reserve(state, task, retryFailed) {
  const reason = admissible(state, task);
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

async function reserveRetries(state, limit) {
  const candidates = state.snapshot.tasks
    .filter(task => !settled.has(task.status) && task.status !== 'integrated' && task.status !== 'cancelled')
    .filter(task => retryable.has(currentOf(state.snapshot, task.id)?.status))
    .sort(byPriority);
  for (const candidate of candidates) {
    if (state.briefs.length >= limit) return;
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
  const selected = W.selectWave(state.snapshot, { limit: remaining, inFlight: [...state.inFlight] });
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

/**
 * Reserve the next wave for an external host: the briefs of this host's running
 * attempts, then new non-overlapping tasks up to `limit` (1..5).
 * @param {{ repo: any, engine: any, store?: any, contracts?: any, clock?: () => string }} ctx
 * @param {{ projectId: string, host: string, limit?: number, retryFailed?: boolean, ports?: any }} input
 */
export async function nextWave(ctx, input) {
  const { projectId, host, limit = 3, retryFailed = false, ports } = input;
  need(isPullHost(host), 'host_unsupported');
  need(Number.isSafeInteger(limit) && limit >= 1 && limit <= MAX_WAVE_LIMIT, 'limit_invalid');
  const C = await contractsOf(ctx),
    store = storeOf(ctx);
  const snapshot = await snapshotOf(ctx, projectId);
  need(C.isWaveProject(snapshot.project), 'wave_required');
  controlOf(snapshot);
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
      token,
      integration,
      options: { knownValues: known(ctx.engine) },
      snapshot: await snapshotOf(ctx, projectId),
      inFlight: new Set(),
      briefs: [],
      blocked: [],
    };
    await resumeInFlight(state);
    if (retryFailed) await reserveRetries(state, limit);
    await reserveSelected(state, limit, ports);
    const revision = (await snapshotOf(ctx, projectId)).revision;
    return { projectId, revision, briefs: state.briefs, blocked: state.blocked };
  } finally {
    store.releaseLease(token);
  }
}

// Symbolic links and submodules never enter the integration branch.
async function specialEntries(cwd, base, head) {
  const raw = await git(cwd, ['diff', '--raw', '--no-renames', '--no-abbrev', base, head]);
  return raw
    .split(/\r?\n/)
    .filter(Boolean)
    .filter(line => /^:\d{6} (?:120000|160000) /.test(line));
}

const problem = (code, error, secrets = {}) => ({
  code,
  ...(error ? { message: redact(String(error.message), secrets).slice(0, 2000) } : {}),
});

// Worker-fixable defects of the submitted commit, before any check runs.
async function inspectSubmission(engine, run, task, head) {
  const branch = await execute('git', ['rev-parse', '--verify', '--quiet', `refs/heads/${run.branch}`], {
    cwd: run.project,
    allowFailure: true,
  });
  if (branch.code !== 0 || branch.stdout.trim() !== head) return problem('external_branch_mismatch');
  const worktreeHead = await execute('git', ['rev-parse', 'HEAD'], { cwd: run.cwd, allowFailure: true });
  if (worktreeHead.code !== 0) return problem('external_worktree_missing');
  if (worktreeHead.stdout.trim() !== head || (await git(run.cwd, ['branch', '--show-current'])) !== run.branch)
    return problem('external_worktree_mismatch');
  if (await git(run.cwd, ['status', '--porcelain=v1', '--untracked-files=all']))
    return problem('external_worktree_dirty');
  if (head === run.baseSha) return problem('external_no_changes');
  if (!(await ancestor(run.project, run.baseSha, head))) return problem('external_not_descendant');
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

async function abandonAttempt(ctx, snapshot, attempt, run, commandId) {
  const store = storeOf(ctx);
  if (attempt.status === 'blocked') {
    if (run.state !== 'cancelled') store.updateRun(run.id, { cancelRequested: true, state: 'cancelled' });
    return { status: 'abandoned', revision: snapshot.revision, replayed: true };
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
  });
  return { status: 'abandoned', revision: (await snapshotOf(ctx, snapshot.project.projectId)).revision };
}

async function runGates(W, waveCtx, projectId, signal) {
  const gates = await W.runPendingGates(waveCtx, { projectId, signal, retryFailed: false });
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

// A completion already recorded for this head is returned, not repeated; deferred gates may still run.
async function replayCompletion(ctx, C, input, run) {
  const completion = run.externalCompletion,
    store = storeOf(ctx);
  let gates = completion.gates;
  if (gates === null && !input.deferGate) {
    const W = wavePorts(input.ports, ['createWaveContext', 'runPendingGates']);
    gates = await runGates(W, waveContextOf(ctx, C, W), input.projectId, input.signal);
    store.updateRun(run.id, { externalCompletion: { ...completion, gates } });
  }
  const revision = (await snapshotOf(ctx, input.projectId)).revision;
  return {
    status: 'integrated',
    integration: completion.integration,
    ...(gates ? { gates } : {}),
    revision,
    replayed: true,
  };
}

// Verify the submitted head once; a pass leaves the Run succeeded on that head.
async function verifySubmission(ctx, run, task, head, signal) {
  const store = storeOf(ctx);
  if (run.state === 'succeeded' && run.headSha === head && run.checks?.headSha === head && run.checks.complete)
    return null;
  const verdict = await verifyTaskFastOnce({ engine: ctx.engine, run: run.id, signal });
  if (!verdict.passed || verdict.headSha !== head) {
    store.updateRun(run.id, { state: 'executing' });
    return verdict.passed ? problem('external_head_changed') : { code: verdict.code, message: verdict.message };
  }
  store.updateRun(run.id, { state: 'succeeded', error: null });
  return null;
}

// Integrate a verified head, record the completion, then run pending gates unless deferred.
async function integrateCompletion(ctx, C, input, run) {
  const { projectId, taskId, head, deferGate, signal } = input,
    store = storeOf(ctx);
  const W = wavePorts(input.ports, ['createWaveContext', 'integrateAndAdvance', 'runPendingGates']);
  const waveCtx = waveContextOf(ctx, C, W);
  const integration = await W.integrateAndAdvance(waveCtx, { projectId, taskId, run: store.getRun(run.id), signal });
  if (integration?.status !== 'integrated')
    return {
      status: 'blocked',
      code: integration?.code ?? 'project_integration_blocked',
      integration,
      revision: integration?.revision ?? (await snapshotOf(ctx, projectId)).revision,
    };
  // Recorded before the gates: a failed gate pass never hides the integration from a replay.
  const completion = { schemaVersion: 1, headSha: head, integration, gates: null };
  store.updateRun(run.id, { externalCompletion: completion });
  const gates = deferGate ? null : await runGates(W, waveCtx, projectId, signal);
  if (gates) store.updateRun(run.id, { externalCompletion: { ...completion, gates } });
  const revision = (await snapshotOf(ctx, projectId)).revision;
  return { status: 'integrated', integration, ...(gates ? { gates } : {}), revision };
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

/**
 * Accept the commit of an external worker: check it, run `task-fast` once and
 * integrate it (`integrateAndAdvance`), then run pending epic gates unless deferred.
 * `abandon` blocks the attempt and cancels its Run instead. The whole call holds lease
 * `project:<id>` (as `nextWave` and the drain do): `project_busy` while another holds it.
 * @param {{ repo: any, engine: any, store?: any, contracts?: any, clock?: () => string }} ctx
 * @param {{ projectId: string, taskId: string, head: string, deferGate?: boolean, abandon?: boolean,
 *   commandId?: string, ports?: any, signal?: AbortSignal }} input
 */
export async function completeTask(ctx, input) {
  const { projectId, taskId, head, deferGate = false, abandon = false, commandId, signal } = input;
  need(typeof head === 'string' && shaPattern.test(head), 'head_invalid');
  need(!(deferGate && abandon), 'arguments');
  const C = await contractsOf(ctx);
  await externalAttempt(ctx, C, projectId, taskId);
  return withProjectLease(storeOf(ctx), projectId, async () => {
    const { snapshot, task, attempt, run } = await externalAttempt(ctx, C, projectId, taskId);
    if (abandon) return abandonAttempt(ctx, snapshot, attempt, run, commandId);
    if (run.externalCompletion?.headSha === head) return replayCompletion(ctx, C, { ...input, deferGate }, run);
    const blocked = code => ({ status: 'blocked', code, revision: snapshot.revision });
    if (snapshot.project.paused || ['cancelled', 'failed', 'blocked'].includes(snapshot.project.status))
      return blocked('project_control_blocked');
    // A verified head whose integration was interrupted (crash) continues where it stopped.
    const interrupted =
      run.state === 'succeeded' && run.headSha === head && ['merged', 'pending'].includes(run.integration?.status);
    if (!interrupted) {
      if (!['running', 'verifying'].includes(attempt.status) || run.integration?.status === 'merged')
        return blocked('project_attempt_not_running');
      const defect =
        (await inspectSubmission(ctx.engine, run, task, head)) ??
        (await verifySubmission(ctx, run, task, head, signal));
      if (defect) return { status: 'checks_failed', ...defect, revision: snapshot.revision };
    }
    return integrateCompletion(ctx, C, { ...input, deferGate }, run);
  });
}
