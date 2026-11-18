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
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import { isDeepStrictEqual } from 'node:util';
import { execute } from './command.mjs';
import { makeWorktree, worktreeHomeFor } from './workspace.mjs';
import { scopesOverlap } from './contracts.mjs';
import * as projectContracts from './project-contracts.mjs';
import { planProjectHorizon } from './project-planner.mjs';
import {
  ensureIntegration,
  gateBase,
  integrationHeadOf,
  mergeBackGate,
  mergeTask,
  waveFrontier,
} from './project-integration.mjs';
import { withIntegrationLease as withLease } from './project-integration-lease.mjs';
import { GATE_WATCHDOG, createGateRunDraft, runEpicGate } from './wave-verifier.mjs';
import { normalizeWatchdogConfig } from './watchdog.mjs';
import {
  bindingFor,
  known,
  observation,
  priorRetryRun,
  retrySettings,
  storedRun,
  verifyRef,
} from './project-director.mjs';

const fail = code => {
  throw Object.assign(new Error(`Project ${code}`), { code: `project_${code}` });
};
const requireValue = (value, code = 'proof_invalid') => {
  if (!value) fail(code);
};
const lifecycle = ['proposed', 'ready', 'running', 'verifying', 'integrated', 'accepted', 'released'];
const retryStates = ['blocked', 'failed', 'cancelled'];
const finishedRun = ['succeeded', 'blocked', 'failed', 'cancelled'];
const nextState = {
  proposed: 'ready',
  ready: 'running',
  reserved: 'running',
  running: 'verifying',
  verifying: 'integrated',
};
const reached = (status, state) => lifecycle.includes(status) && lifecycle.indexOf(status) >= lifecycle.indexOf(state);
const settled = status => status === 'accepted' || status === 'released';
const gateKinds = ['acceptance', 'contract', 'checks', 'review'];
const taskKinds = ['acceptance', 'contract', 'checks'];
const INTEGRATION_WAIT_MS = 120000;

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

// --- snapshot and command helpers -------------------------------------------------------------

function assertComplete(snapshot) {
  requireValue(snapshot?.completeness?.tasks, 'snapshot_incomplete');
  for (const [name, count] of Object.entries(snapshot.completeness))
    requireValue(
      count?.complete === true && count.total === snapshot[name]?.length && count.returned === count.total,
      'snapshot_incomplete',
    );
}
async function snapshotOf(ctx, projectId) {
  const snapshot = await ctx.repo.snapshot(projectId);
  assertComplete(snapshot);
  return snapshot;
}
const waveProject = (ctx, snapshot) =>
  typeof ctx.contracts.isWaveProject === 'function' && ctx.contracts.isWaveProject(snapshot.project) === true;
const taskOf = (snapshot, id) => snapshot.tasks.find(row => row.id === id);
const currentOf = (snapshot, taskId) => snapshot.currentAttempts.find(row => row.taskId === taskId);
const recordOf = (snapshot, kind, id) =>
  kind === 'project' ? snapshot.project : snapshot[`${kind}s`].find(row => row.id === id);
function childrenOf(snapshot, kind, id) {
  if (kind === 'project') return snapshot.milestones;
  if (kind === 'milestone') return snapshot.epics.filter(row => row.milestoneId === id);
  return snapshot.tasks.filter(row => row.epicId === id);
}
function controlState(snapshot) {
  if (snapshot.project.status === 'cancelled') return 'cancelled';
  if (snapshot.project.paused) return 'paused';
  if (['failed', 'blocked'].includes(snapshot.project.status)) return 'blocked';
  return null;
}
/** The actor of the drain's commands; its `reserveAttempt` events mark native attempts. */
export const NATIVE_RESERVER = 'project-director';
const EXTERNAL_RESERVER = 'project-external:';
/** The actor with which pull host `host` reserves an attempt (project-external). */
export const externalReserver = host => `${EXTERNAL_RESERVER}${host}`;

const commandFor = (snapshot, action, options = {}) => ({
  schemaVersion: 1,
  commandId: options.commandId || randomUUID(),
  projectId: snapshot.project.projectId,
  expectedRevision: snapshot.revision,
  actor: NATIVE_RESERVER,
  reason: options.reason || 'Wave project command',
  action,
});
const transitionAction = (kind, id, to, evidence = [], mappings = []) => ({
  op: 'transition',
  kind,
  id,
  to,
  evidence,
  mappings,
});
const portsFor = ctx => ({ contracts: ctx.contracts, knownValues: known(ctx.engine) });
const blockerOf = run => run.blocker?.current?.code ?? run.error?.code ?? `run_${run.state}`;

// --- leases -----------------------------------------------------------------------------------

/**
 * Serialize merges, frontier reads and every transition whose proof reads the integration
 * branch (`project-integration:<id>`, reentrant): the authorizer requires it for
 * task/attempt → integrated and for every acceptance, and it is held until the store commits.
 */
const withIntegrationLease = (ctx, projectId, signal, work) =>
  withLease(ctx.store, projectId, work, {
    signal,
    waitMs: INTEGRATION_WAIT_MS,
    heartbeatMs: ctx.engine.leaseHeartbeatMs || 10000,
  });

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
    abort();
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
    return await work(control);
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
 * @param {{ limit: number, inFlight?: string[], availability?: any[], now?: string }} options
 */
export function selectWave(snapshot, { limit, inFlight = [], availability, now } = /** @type {any} */ ({})) {
  requireValue(Number.isSafeInteger(limit) && limit >= 1 && limit <= 24, 'limit_invalid');
  requireValue(Array.isArray(inFlight), 'limit_invalid');
  const rows =
    availability ??
    snapshot.tasks.map(task => ({ taskId: task.id, available: true, interfacesVerified: true, reason: null }));
  const horizon = planProjectHorizon(
    { snapshot, limit: 24, availability: rows, now: now ?? new Date().toISOString() },
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

const horizonOf = async (ctx, snapshot) =>
  planProjectHorizon(
    { snapshot, limit: 24, availability: await waveAvailability(ctx, snapshot), now: ctx.clock() },
    portsFor(ctx),
  );

// --- integration of one task ------------------------------------------------------------------

async function persistRefs(ctx, run, kinds) {
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

// Merge the task head once; a recorded or recovered merge is never repeated.
async function mergeRun(ctx, snapshot, task, run) {
  if (run.integration?.status === 'merged' && run.integration.mergedHead === run.headSha) return run.integration;
  const { branch, worktree } = await integrationOf(ctx, snapshot);
  try {
    const merged = await mergeTask({
      worktree,
      taskId: task.id,
      taskHead: run.headSha,
      writePaths: task.writePaths,
      savePending: ({ before }) => ctx.store.updateRun(run.id, { integration: { branch, before, status: 'pending' } }),
      // A crash after savePending may have left this merge unfinished (MERGE_HEAD).
      pending: run.integration?.status === 'pending' ? { before: run.integration.before } : null,
    });
    const integration = {
      branch: merged.branch,
      before: merged.before,
      mergeCommit: merged.mergeCommit,
      mergedHead: merged.mergedHead,
      status: 'merged',
    };
    ctx.store.updateRun(run.id, { integration });
    return integration;
  } catch (error) {
    if (!['project_integration_conflict', 'project_integration_scope'].includes(error?.code)) throw error;
    ctx.store.updateRun(run.id, {
      integration: { branch, before: run.integration?.before ?? null, status: 'failed', code: error.code },
    });
    return { status: 'failed', code: error.code };
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
async function advanceContainers(ctx, projectId) {
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
    const merged = await mergeRun(ctx, snapshot, task, stored);
    if (merged.status !== 'merged') {
      // The result cannot be integrated; an explicit retry starts from the current frontier.
      snapshot = await snapshotOf(ctx, projectId);
      const current = currentOf(snapshot, taskId);
      if (!retryStates.includes(current.status) && !reached(current.status, 'integrated'))
        await ctx.repo.apply(commandFor(snapshot, transitionAction('attempt', current.id, 'blocked')));
      return blocked(merged.code);
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

// --- epic gates -------------------------------------------------------------------------------

function latestGate(snapshot, kind, id) {
  return (snapshot.gates ?? [])
    .filter(gate => gate.containers[0].kind === kind && gate.containers[0].id === id)
    .reduce((latest, gate) => (!latest || gate.number > latest.number ? gate : latest), null);
}

// An epic is ready for its gate when every task is integrated and dependencies outside it are accepted.
function gateCandidate(snapshot, epic) {
  if (settled(epic.status) || retryStates.includes(epic.status)) return false;
  const tasks = childrenOf(snapshot, 'epic', epic.id);
  return (
    tasks.length > 0 &&
    tasks.every(task => reached(task.status, 'integrated')) &&
    tasks.every(task =>
      task.dependsOn.every(id => {
        const dependency = taskOf(snapshot, id);
        return dependency?.epicId === epic.id || settled(dependency?.status);
      }),
    )
  );
}

function gateContainers(snapshot, epic) {
  const containers = [{ kind: 'epic', id: epic.id }];
  const milestone = recordOf(snapshot, 'milestone', epic.milestoneId);
  const others = snapshot.epics.filter(row => row.id !== epic.id);
  if (
    settled(milestone.status) ||
    !others.filter(row => row.milestoneId === milestone.id).every(row => settled(row.status))
  )
    return containers;
  containers.push({ kind: 'milestone', id: milestone.id });
  if (!settled(snapshot.project.status) && others.every(row => settled(row.status)))
    containers.push({ kind: 'project', id: snapshot.project.projectId });
  return containers;
}

// The merges of the covered tasks at their current attempts, as their task Runs recorded them.
function coveredMerges(ctx, snapshot, tasks) {
  return tasks.map(task => {
    const attempt = currentOf(snapshot, task.id),
      run = attempt && storedRun(ctx.store, attempt.runId);
    requireValue(run?.integration?.status === 'merged', 'wave_integration_missing');
    return { taskId: task.id, attemptId: attempt.id, runId: attempt.runId, mergeCommit: run.integration.mergeCommit };
  });
}

// The tasks a gate over `containers` covers: those of its widest container.
function containerTasks(snapshot, containers) {
  const widest = containers.at(-1);
  if (widest.kind === 'project') return snapshot.tasks;
  if (widest.kind === 'milestone')
    return snapshot.tasks.filter(task => recordOf(snapshot, 'epic', task.epicId).milestoneId === widest.id);
  return childrenOf(snapshot, 'epic', widest.id);
}

// Reserve a gate over `containers` on the current integration head and install its Run, both
// under one integration lease: no merge moves the branch head between them. The base is the
// first parent of the earliest covered merge on the branch history (never the head itself).
async function reserveGate(ctx, snapshot, containers, retry) {
  const projectId = snapshot.project.projectId;
  const merges = coveredMerges(ctx, snapshot, containerTasks(snapshot, containers));
  return withIntegrationLease(ctx, projectId, undefined, async () => {
    const { worktree } = await integrationOf(ctx, snapshot);
    const mergeCommits = merges.map(merge => merge.mergeCommit);
    const headSha = await waveFrontier({ worktree, mergeCommits });
    const baseSha = await gateBase({ cwd: worktree, headSha, mergeCommits });
    const result = await ctx.repo.apply(
      commandFor(await snapshotOf(ctx, projectId), { op: 'reserveGate', containers, baseSha, headSha, merges, retry }),
    );
    const gate = (await snapshotOf(ctx, projectId)).gates.find(row => row.id === result.entity.id);
    return { gate, run: await installGate(ctx, projectId, gate) };
  });
}

// The gate Run through the store's own contract (installGateRun with gateBindingFor and
// buildGateInput); an installed gate keeps its Run. Runs inside the (reentrant) integration lease.
async function installGate(ctx, projectId, gate) {
  const stored = storedRun(ctx.store, gate.runId);
  if (stored) return stored;
  const snapshot = await snapshotOf(ctx, projectId);
  return createGateRunDraft({
    engine: ctx.engine,
    project: snapshot.project,
    gate,
    tasks: snapshot.tasks,
    installGateRun: input => ctx.repo.installGateRun(input),
    withLease: work => withIntegrationLease(ctx, projectId, undefined, work),
  });
}

// A reservation whose install was interrupted is installed now; when the branch has moved past
// its head, a new reservation on the current head replaces it (the store marks it superseded).
async function installOrReplace(ctx, snapshot, gate, containers, out) {
  try {
    return { gate, run: await installGate(ctx, snapshot.project.projectId, gate) };
  } catch (error) {
    if (error?.code === 'gate_head_stale') return reserveGate(ctx, snapshot, containers, false);
    if (error?.code !== 'gate_invalid') throw error;
    out.blocked.push({ code: error.code, kind: containers[0].kind, id: containers[0].id });
    return null;
  }
}

async function accept(ctx, snapshot, kind, record, criteria, refs, out) {
  const id = kind === 'project' ? record.projectId : record.id;
  const mappings = criteria.map(criterion => ({
    criterionId: criterion.id,
    refs: refs.filter(ref => criterion.evidenceKinds.includes(ref.kind)).map(ref => ref.sha256),
    actor: 'project-director',
    reason: 'The wave gate verified the integrated result',
  }));
  if (mappings.some(row => !row.refs.length)) {
    out.blocked.push({ code: 'wave_gate_proof_missing', kind, id });
    return false;
  }
  try {
    await ctx.repo.apply(commandFor(snapshot, transitionAction(kind, id, 'accepted', refs, mappings)));
  } catch (error) {
    // The branch moved while the project proof was checked: the project gate follows.
    if (kind === 'project' && (await projectHeadMoved(snapshot, refs[0]?.headSha))) return false;
    out.blocked.push({ code: error?.code || 'project_transition_blocked', kind, id });
    return false;
  }
  out.accepted.push({ kind, id });
  return true;
}

const projectHeadMoved = async (snapshot, verifiedHead) =>
  (await integrationHeadOf({ cwd: snapshot.project.root, projectId: snapshot.project.projectId })) !== verifiedHead;

// Bring the verified gate head back, then accept the covered tasks and containers, all under one
// integration lease held until each acceptance commits: the authorizer's Git proof (merges,
// range, verified head on the branch) cannot go stale in between. The project is accepted only
// while the branch head is the gate's verified head; otherwise a project gate follows.
async function acceptGate(ctx, projectId, gate, run, out) {
  await withIntegrationLease(ctx, projectId, undefined, async () => {
    const before = await snapshotOf(ctx, projectId);
    const { worktree } = await integrationOf(ctx, before);
    // Fast-forward while the branch still stands on the gate head; otherwise the
    // in-scope repairs are merged `--no-ff`.
    await mergeBackGate({ worktree, expectedHead: gate.headSha, gateHead: run.headSha });
    const refs = await persistRefs(ctx, run, gateKinds);
    for (const merge of gate.merges)
      for (const kind of ['attempt', 'task']) {
        const snapshot = await snapshotOf(ctx, projectId);
        const task = taskOf(snapshot, merge.taskId),
          record = kind === 'attempt' ? currentOf(snapshot, merge.taskId) : task;
        if (settled(record.status)) continue;
        if (!(await accept(ctx, snapshot, kind, record, task.acceptance, refs, out))) return;
      }
    await advanceContainers(ctx, projectId);
    for (const container of gate.containers) {
      const snapshot = await snapshotOf(ctx, projectId);
      const record = recordOf(snapshot, container.kind, container.id);
      if (settled(record.status)) continue;
      if (container.kind === 'project' && (await projectHeadMoved(snapshot, run.headSha))) return;
      const criteria = container.kind === 'project' ? record.definitionOfDone : record.acceptance;
      if (!(await accept(ctx, snapshot, container.kind, record, criteria, refs, out))) return;
    }
  });
}

// The current gate of an epic and its Run: the latest one, a new one, or a retry.
async function epicGate(ctx, snapshot, epic, retryFailed, out) {
  const gate = latestGate(snapshot, 'epic', epic.id),
    run = gate && storedRun(ctx.store, gate.runId);
  if (gate && run && retryStates.includes(run.state)) {
    if (retryFailed) return reserveGate(ctx, snapshot, gateContainers(snapshot, epic), true);
    out.gates.push({ gateId: gate.id, runId: run.id, state: run.state });
    out.blocked.push({ code: blockerOf(run), kind: 'epic', id: epic.id });
    return null;
  }
  if (!gate) return reserveGate(ctx, snapshot, gateContainers(snapshot, epic), false);
  if (run) return { gate, run };
  return installOrReplace(ctx, snapshot, gate, gateContainers(snapshot, epic), out);
}

// Execute an installed gate Run once, then accept what it verified.
async function runAndAccept(ctx, projectId, { gate, run }, signal, out, entity) {
  if (run.state !== 'succeeded') run = await runEpicGate({ engine: ctx.engine, run, signal });
  out.gates.push({ gateId: gate.id, runId: run.id, state: run.state });
  if (run.state !== 'succeeded') {
    out.blocked.push({
      code: run.state === 'waiting_limits' ? 'quota' : blockerOf(run),
      ...entity,
      state: run.state,
    });
    return;
  }
  try {
    await acceptGate(ctx, projectId, gate, run, out);
  } catch (error) {
    if (!['project_integration_conflict', 'project_integration_invalid'].includes(error?.code)) throw error;
    out.blocked.push({ code: error.code, ...entity });
  }
}

async function gateEpic(ctx, snapshot, epic, { signal, retryFailed }, out) {
  const current = await epicGate(ctx, snapshot, epic, retryFailed, out);
  if (current) await runAndAccept(ctx, snapshot.project.projectId, current, signal, out, { kind: 'epic', id: epic.id });
}

// The project gate's Run: the latest one, a new one (none yet, a stale reservation, or a verified
// gate whose head the branch has since left) or a retry.
async function projectGateRun(ctx, snapshot, { retryFailed, stale }, out) {
  const projectId = snapshot.project.projectId,
    containers = [{ kind: 'project', id: projectId }];
  const gate = latestGate(snapshot, 'project', projectId),
    run = gate && storedRun(ctx.store, gate.runId);
  if (!gate || (stale && run?.state === 'succeeded')) return reserveGate(ctx, snapshot, containers, false);
  if (!run) return installOrReplace(ctx, snapshot, gate, containers, out);
  if (!retryStates.includes(run.state)) return { gate, run };
  if (retryFailed) return reserveGate(ctx, snapshot, containers, true);
  out.gates.push({ gateId: gate.id, runId: run.id, state: run.state });
  out.blocked.push({ code: blockerOf(run), kind: 'project', id: projectId });
  return null;
}

/**
 * The project gate: once every milestone is accepted but the project is not (the integration
 * branch moved past the verified head of the gate that covered the project), one gate over the
 * whole project verifies the current integration head and accepts the project. A branch that
 * moves again during that gate leaves `wave_project_head_mismatch`.
 * @param {any} ctx
 * @param {{ projectId: string, signal?: AbortSignal, retryFailed?: boolean }} input
 * @param {{ gates: any[], accepted: any[], blocked: any[] }} out
 */
async function gateProject(ctx, { projectId, signal, retryFailed }, out) {
  for (const stale of [false, true]) {
    const snapshot = await snapshotOf(ctx, projectId);
    if (
      settled(snapshot.project.status) ||
      controlState(snapshot) ||
      signal?.aborted ||
      !reached(snapshot.project.status, 'integrated') ||
      !snapshot.milestones.every(row => settled(row.status))
    )
      return;
    const blocked = out.blocked.length;
    const current = await projectGateRun(ctx, snapshot, { retryFailed, stale }, out);
    if (!current) return;
    await runAndAccept(ctx, projectId, current, signal, out, { kind: 'project', id: projectId });
    if (out.blocked.length > blocked) return;
  }
  if (!settled((await snapshotOf(ctx, projectId)).project.status))
    out.blocked.push({ code: 'wave_project_head_mismatch', kind: 'project', id: projectId });
}

/**
 * Run the gates of every epic whose tasks are all integrated and not covered by its current
 * gate, then accept what a successful gate verified; then the project gate when only the
 * project is left. A failed gate is retried only with `retryFailed`.
 * @param {any} ctx
 * @param {{ projectId: string, signal?: AbortSignal, retryFailed?: boolean }} input
 */
export async function runPendingGates(ctx, { projectId, signal, retryFailed = false }) {
  const out = { gates: [], accepted: [], blocked: [] };
  const handled = new Set();
  for (;;) {
    await advanceContainers(ctx, projectId);
    const snapshot = await snapshotOf(ctx, projectId);
    requireValue(waveProject(ctx, snapshot), 'wave_not_enabled');
    if (controlState(snapshot) || signal?.aborted) return out;
    const epic = snapshot.epics.find(row => !handled.has(row.id) && gateCandidate(snapshot, row));
    if (!epic) break;
    handled.add(epic.id);
    await gateEpic(ctx, snapshot, epic, { signal, retryFailed }, out);
  }
  if (!out.blocked.length) await gateProject(ctx, { projectId, signal, retryFailed }, out);
  return out;
}

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
async function installTaskRun(ctx, projectId, attempt, options, control) {
  let snapshot = await snapshotOf(ctx, projectId);
  const task = taskOf(snapshot, attempt.taskId),
    project = snapshot.project;
  const input = ctx.contracts.buildDirectorTaskInput({ project, task }, portsFor(ctx));
  let run = storedRun(ctx.store, attempt.runId);
  if (!run) {
    const previous = await priorRetryRun(ctx, snapshot, attempt);
    const retry = await retrySettings(ctx, snapshot, previous);
    const concurrency = Math.min(options.concurrency, previous?.config.concurrency ?? options.concurrency);
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
  await makeWorktree(run.project, run.cwd, run.branch, run.baseSha);
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
  for (const attempt of attempts) runs.push(await installTaskRun(ctx, projectId, attempt, options, control));
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
async function activeAttempts(ctx, projectId) {
  const snapshot = await snapshotOf(ctx, projectId);
  const native = [],
    external = [];
  for (const attempt of snapshot.currentAttempts) {
    const task = taskOf(snapshot, attempt.taskId);
    const open =
      attempt.status === 'integrated'
        ? !reached(task.status, 'integrated')
        : !settled(attempt.status) && !retryStates.includes(attempt.status);
    if (!open) continue;
    if ((await attemptExecutor(ctx, snapshot, attempt)).kind === 'native') native.push(attempt);
    else external.push(attempt.taskId);
  }
  return { native, external };
}

// `--retry-failed`: one new attempt per failed task, disjoint scopes, at most `concurrency`.
// A retry goes to the executor of the failed attempt: the drain retries only its own native
// attempts; a task an external chat abandoned is retried by `next-wave --retry-failed`.
async function reserveRetries(ctx, projectId, options, control, state) {
  let snapshot = await snapshotOf(ctx, projectId);
  const horizon = await horizonOf(ctx, snapshot);
  const active = await activeAttempts(ctx, projectId);
  const taken = [...active.native.map(row => row.taskId), ...active.external].map(
    id => taskOf(snapshot, id).writePaths,
  );
  let count = 0;
  for (const attempt of snapshot.currentAttempts.filter(row => retryStates.includes(row.status))) {
    const task = taskOf(snapshot, attempt.taskId);
    if (count >= options.concurrency || reached(task.status, 'integrated') || task.status === 'cancelled') continue;
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

async function noProgress(ctx, projectId, state) {
  const snapshot = await snapshotOf(ctx, projectId);
  const horizon = await horizonOf(ctx, snapshot);
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

async function drainLoop(ctx, projectId, options, control, state) {
  let pending = null,
    retry = options.retryFailed;
  for (;;) {
    control.check();
    let stop = controlState(await snapshotOf(ctx, projectId));
    if (stop) return finish(ctx, projectId, state, stop);
    if (retry) {
      retry = false;
      await reserveRetries(ctx, projectId, options, control, state);
    }
    const active = await activeAttempts(ctx, projectId);
    if (!pending && active.native.length) {
      if (state.waves >= options.maxWaves) return finish(ctx, projectId, state, 'max_waves');
      pending = await executeWave(ctx, projectId, active.native.slice(0, options.concurrency), options, control, state);
      continue;
    }
    if (['cancelled', 'paused'].includes(pending)) return finish(ctx, projectId, state, pending);
    const gates = await runPendingGates(ctx, { projectId, signal: control.signal, retryFailed: options.retryFailed });
    state.gates.push(...gates.gates);
    state.blockers.push(...gates.blocked);
    const snapshot = await snapshotOf(ctx, projectId);
    if (settled(snapshot.project.status)) return finish(ctx, projectId, state, 'accepted');
    stop = controlState(snapshot);
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
    const taskIds = selectWave(snapshot, {
      limit: options.concurrency,
      inFlight: active.external,
      availability: await waveAvailability(ctx, snapshot),
      now: ctx.clock(),
    });
    if (!taskIds.length) return finish(ctx, projectId, state, await noProgress(ctx, projectId, state));
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
  const { maxWaves = 10, concurrency = 3, retryFailed = false, signal, commandId } = options;
  requireValue(Number.isSafeInteger(maxWaves) && maxWaves >= 1 && maxWaves <= 100, 'drain_invalid');
  requireValue(Number.isSafeInteger(concurrency) && concurrency >= 1 && concurrency <= 5, 'drain_invalid');
  const snapshot = await snapshotOf(ctx, projectId);
  requireValue(waveProject(ctx, snapshot), 'wave_not_enabled');
  if (snapshot.project.status === 'released') fail('wave_delivery_unsupported');
  const state = { waves: 0, integrated: [], gates: [], blockers: [], code: undefined };
  const early = settled(snapshot.project.status) ? 'accepted' : controlState(snapshot);
  if (early) {
    requireValue(early !== 'blocked', 'control_blocked');
    return finish(ctx, projectId, state, early);
  }
  return withProjectControl(ctx, projectId, signal, control =>
    drainLoop(ctx, projectId, { maxWaves, concurrency, retryFailed: retryFailed === true, commandId }, control, state),
  );
}
