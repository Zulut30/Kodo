// Epic and project gates of wave execution (`project-director-waves.mjs`): gate
// reservation and installation, gate Runs under gate leases, acceptance of the
// integrated result and the gate holds reported to the drain and external hosts.

import { randomUUID } from 'node:crypto';
import { redact } from './security.mjs';
import { gateBase, inspectHistory, integrationHeadOf, mergeBackGate, waveFrontier } from './project-integration.mjs';
import { fencedBy } from './lease-fence.mjs';
import { fencedPublisher } from './project-publish.mjs';
import { createGateRunDraft, runEpicGate } from './wave-verifier.mjs';
import { arbitrationBlockerFields } from './gate-arbiter.mjs';
import { recordBlocker } from './watchdog.mjs';
import { storedRun } from './project-director.mjs';
import {
  blockerOf,
  childrenOf,
  commandFor,
  currentOf,
  gateKinds,
  reached,
  recordOf,
  requireValue,
  retryStates,
  settled,
  snapshotOf,
  stopReason,
  taskOf,
  transitionAction,
  waveProject,
  withIntegrationLease,
} from './project-wave-shared.mjs';
import { advanceContainers, integrationOf, persistRefs } from './project-wave-integration.mjs';

// --- epic gates -------------------------------------------------------------------------------

function latestGate(snapshot, kind, id) {
  return (snapshot.gates ?? [])
    .filter(gate => gate.containers[0].kind === kind && gate.containers[0].id === id)
    .reduce((latest, gate) => (!latest || gate.number > latest.number ? gate : latest), null);
}
// An epic is ready for its gate when every task is integrated and dependencies outside it are accepted.
export function gateCandidate(snapshot, epic) {
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
    // The first install is refused like a later one (installOrReplace): the caller reports it.
    try {
      return { gate, run: await installGate(ctx, projectId, gate) };
    } catch (error) {
      return { gate, refused: installRefusal(ctx, gate, containers, error) };
    }
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
    containers: ctx.contracts.gateContainerCriteria(snapshot, gate),
    installGateRun: input => ctx.repo.installGateRun(input),
    withLease: work => withIntegrationLease(ctx, projectId, undefined, work),
  });
}
// A refused install of a reserved gate (gate_invalid) as a blocker row; any other error is thrown.
// No gate Run exists yet: the row names the reserved Run, the stage and the install's own
// diagnosis (the gate checks of wave-verifier name fields and task ids, never file contents).
function installRefusal(ctx, gate, containers, error) {
  if (error?.code !== 'gate_invalid') throw error;
  return {
    code: error.code,
    kind: containers[0].kind,
    id: containers[0].id,
    gateId: gate.id,
    ...(typeof gate.runId === 'string' ? { runId: gate.runId } : {}),
    stage: 'install',
    message: redact(String(error.message), ctx.engine.secrets ?? {}).slice(0, 500),
  };
}
// A reservation whose install was interrupted is installed now; when the branch has moved past
// its head, a new reservation on the current head replaces it (the store marks it superseded).
async function installOrReplace(ctx, snapshot, gate, containers, out) {
  try {
    return { gate, run: await installGate(ctx, snapshot.project.projectId, gate) };
  } catch (error) {
    if (error?.code === 'gate_head_stale') return reserveGate(ctx, snapshot, containers, false);
    out.blocked.push(installRefusal(ctx, gate, containers, error));
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
  const missing = mappings.find(row => !row.refs.length);
  if (missing)
    return {
      code: 'wave_gate_proof_missing',
      kind,
      id,
      message: `Gate evidence does not cover criterion ${missing.criterionId} of ${kind} ${id}`,
    };
  try {
    await ctx.repo.apply(commandFor(snapshot, transitionAction(kind, id, 'accepted', refs, mappings)));
  } catch (error) {
    // The branch moved while the project proof was checked: the project gate follows.
    if (kind === 'project' && (await projectHeadMoved(snapshot, refs[0]?.headSha))) return;
    return { code: error?.code || 'project_transition_blocked', kind, id };
  }
  out.accepted.push({ kind, id });
}
const projectHeadMoved = async (snapshot, verifiedHead) =>
  (await integrationHeadOf({ cwd: snapshot.project.root, projectId: snapshot.project.projectId })) !== verifiedHead;
// Every repair commit of a gate (`gate.headSha..run.headSha`), not only the verified result, would
// enter the branch: each must stay inside the covered tasks' write paths, without secret files,
// links or known secret values (`inspectHistory`). A defect blocks the gate Run (a retry reserves a
// new gate on the branch head). Return its code and diagnostic, or null for clean history.
async function gateHistoryDefect(ctx, snapshot, gate, run, worktree) {
  if (run.headSha === gate.headSha) return null;
  const writePaths = gate.merges.flatMap(merge => taskOf(snapshot, merge.taskId)?.writePaths ?? []);
  const found = writePaths.length
    ? await inspectHistory({
        cwd: worktree,
        base: gate.headSha,
        head: run.headSha,
        writePaths,
        secrets: ctx.engine.secrets,
      })
    : { kind: 'scope' };
  if (!found) return null;
  const code =
    found.kind === 'unverifiable' ? 'project_integration_history_unverifiable' : 'project_integration_history';
  const where = found.commit ? `commit ${found.commit.slice(0, 12)}` : 'the repair history';
  return { code, message: `Gate repair history is unsafe (${found.kind}) in ${where}` };
}
// Bring the verified gate head back, then accept the covered tasks and containers, all under one
// integration lease held until each acceptance commits: the authorizer's Git proof (merges,
// range, verified head on the branch) cannot go stale in between. The project is accepted only
// while the branch head is the gate's verified head; otherwise a project gate follows.
async function acceptGate(ctx, projectId, gate, run, out, signal) {
  return withIntegrationLease(ctx, projectId, signal, async () => {
    const before = await snapshotOf(ctx, projectId);
    const { worktree } = await integrationOf(ctx, before);
    const unsafe = await gateHistoryDefect(ctx, before, gate, run, worktree);
    if (unsafe) return { ...unsafe, ...gate.containers[0] };
    // Fast-forward while the branch still stands on the gate head; otherwise the
    // in-scope repairs are merged `--no-ff`.
    const stopped = stopReason(await snapshotOf(ctx, projectId), signal);
    if (stopped) {
      out.stopped ??= stopped;
      return;
    }
    // The return is recorded on the gate Run before it is published: a crash between the ref
    // transaction and the worktree sync is recovered by the next acceptance of this gate.
    const saved = storedRun(ctx.store, run.id)?.gateReturn;
    await mergeBackGate({
      worktree,
      expectedHead: gate.headSha,
      gateHead: run.headSha,
      publish: fencedPublisher(ctx.store),
      pending: saved?.status === 'pending' ? { before: saved.before, target: saved.target } : null,
      savePending: ({ before, target }) =>
        ctx.store.updateRun(run.id, { gateReturn: { before, target, status: 'pending' } }),
    });
    const refs = await persistRefs(ctx, run, gateKinds);
    const acceptedTasks = [];
    for (const merge of gate.merges)
      for (const kind of ['attempt', 'task']) {
        const snapshot = await snapshotOf(ctx, projectId);
        const task = taskOf(snapshot, merge.taskId),
          record = kind === 'attempt' ? currentOf(snapshot, merge.taskId) : task;
        if (settled(record.status)) continue;
        const refusal = await accept(ctx, snapshot, kind, record, task.acceptance, refs, out);
        if (refusal) return refusal;
        if (kind === 'task') acceptedTasks.push(merge.taskId);
      }
    if (acceptedTasks.length && typeof ctx.store.event === 'function') {
      const parsed = Date.parse(ctx.clock());
      ctx.store.event(
        run.id,
        'gate_accepted',
        { gateId: gate.id, taskIds: acceptedTasks },
        Number.isFinite(parsed) ? parsed : Date.now(),
      );
    }
    const blockers = await advanceContainers(ctx, projectId);
    const blocked = blockers.find(row =>
      gate.containers.some(container => container.kind === row.kind && container.id === row.id),
    );
    if (blocked) return blocked;
    for (const container of gate.containers) {
      const snapshot = await snapshotOf(ctx, projectId);
      const record = recordOf(snapshot, container.kind, container.id);
      if (settled(record.status)) continue;
      if (container.kind === 'project' && (await projectHeadMoved(snapshot, run.headSha))) return;
      const criteria = container.kind === 'project' ? record.definitionOfDone : record.acceptance;
      const refusal = await accept(ctx, snapshot, container.kind, record, criteria, refs, out);
      if (refusal) return refusal;
    }
  });
}
// Acceptance commits children before parents. If a wider container refused this gate,
// finish the same chain even though the epic itself is already accepted.
function unfinishedEpicGate(ctx, snapshot, epic) {
  if (!settled(epic.status)) return false;
  const gate = latestGate(snapshot, 'epic', epic.id);
  const open = gate?.containers.find(item => !settled(recordOf(snapshot, item.kind, item.id).status));
  if (
    !open ||
    snapshot.gates.some(
      other =>
        other.number > gate.number && other.containers.some(item => item.kind === open.kind && item.id === open.id),
    )
  )
    return false;
  // When only the project head moved, the normal project gate follows. An extension
  // also reopens the project, but its tasks are outside the old gate's coverage.
  return (
    open.kind !== 'project' ||
    (gate.merges.length === snapshot.tasks.length && storedRun(ctx.store, gate.runId)?.state !== 'succeeded')
  );
}
// The current gate of an epic and its Run: the latest one, a new one, or a retry.
async function epicGate(ctx, snapshot, epic, retryFailed, out) {
  const gate = latestGate(snapshot, 'epic', epic.id),
    run = gate && storedRun(ctx.store, gate.runId);
  const containers = settled(epic.status) ? gate.containers : gateContainers(snapshot, epic);
  if (gate && run && retryStates.includes(run.state)) {
    if (retryFailed) return reserveGate(ctx, snapshot, containers, true);
    out.gates.push({ gateId: gate.id, runId: run.id, state: run.state });
    out.blocked.push({
      code: blockerOf(run),
      kind: 'epic',
      id: epic.id,
      gateId: gate.id,
      runId: run.id,
      ...arbitrationBlockerFields(run),
    });
    return null;
  }
  if (!gate) return reserveGate(ctx, snapshot, containers, false);
  if (run) return { gate, run };
  return installOrReplace(ctx, snapshot, gate, containers, out);
}
// Failures of Git merge-back and immutable evidence publication that invalidate this Run.
const gateReturnErrors = {
  project_integration_conflict: 'Verified gate repairs conflict with the current integration head',
  project_integration_unverified_signature:
    'The verified gate head has no valid signature while merge.verifySignatures is set',
  project_integration_invalid: 'The gate head cannot be integrated on the current branch history',
  evidence_integrity: 'The immutable acceptance evidence of this gate failed its integrity check',
};
const temporaryAcceptanceCodes = new Set([
  'project_revision_conflict',
  'project_control_blocked',
  'project_busy',
  'project_cancelled',
  'project_integration_busy',
  'project_integration_branch_busy',
  'project_integration_worktree_invalid',
  'project_snapshot_incomplete',
  'project_database_corrupt',
  'project_integration_lease_required',
  'project_lease_lost',
]);
// Execute an installed gate Run once, then accept what it verified. Every blocker of this gate
// names it (`gateId`, `runId`): the host reads the gate Run behind the code.
async function runAndAccept(ctx, projectId, { gate, run }, signal, out, entity) {
  // The gate arbiter (16B1) takes a subscription of the project's execution profile.
  const arbitration = { profile: ctx.repo.getProfile?.(projectId) ?? null, now: Date.parse(ctx.clock()) };
  if (run.state !== 'succeeded')
    run = await (ctx.runGate ?? runEpicGate)({ engine: ctx.engine, run, signal, arbitration });
  if (run.state !== 'succeeded') {
    out.gates.push({ gateId: gate.id, runId: run.id, state: run.state });
    out.blocked.push({
      code: run.state === 'waiting_limits' ? 'quota' : blockerOf(run),
      ...entity,
      gateId: gate.id,
      runId: run.id,
      state: run.state,
      ...arbitrationBlockerFields(run),
    });
    return;
  }
  const before = out.blocked.length;
  let refusal;
  try {
    refusal = await acceptGate(ctx, projectId, gate, run, out, signal);
  } catch (error) {
    const code = error?.code;
    if (!Object.hasOwn(gateReturnErrors, code)) throw error;
    refusal = { ...entity, code, message: gateReturnErrors[code] };
  }
  if (refusal) {
    const { code, kind, id } = refusal;
    out.blocked.push({ code, kind, id });
    // A control/lease race or a storage error can resume the same verified proof.
    // A rejected transition or invalid immutable proof needs a new reservation.
    if (/^[a-z][a-z0-9_]*$/.test(code) && !temporaryAcceptanceCodes.has(code)) {
      const message = refusal.message ?? `Gate acceptance of ${kind} ${id} failed (${code})`;
      run = ctx.store.updateRun(run.id, {
        state: 'blocked',
        error: { code, message },
        blocker: recordBlocker(run.blocker, {
          code,
          message,
          scope: 'integration',
          headSha: run.headSha,
          at: ctx.clock(),
        }),
      });
    }
  }
  // Acceptance may still block the Run (for example a repair history defect): report the saved state.
  const saved = storedRun(ctx.store, run.id) ?? run;
  out.gates.push({ gateId: gate.id, runId: saved.id, state: saved.state });
  for (const row of out.blocked.slice(before)) Object.assign(row, { gateId: gate.id, runId: saved.id });
}
async function gateEpic(ctx, snapshot, epic, { signal, retryFailed }, out) {
  const current = await epicGate(ctx, snapshot, epic, retryFailed, out);
  if (current?.refused) out.blocked.push(current.refused);
  else if (current)
    await runAndAccept(ctx, snapshot.project.projectId, current, signal, out, { kind: 'epic', id: epic.id });
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
  out.blocked.push({
    code: blockerOf(run),
    kind: 'project',
    id: projectId,
    gateId: gate.id,
    runId: run.id,
    ...arbitrationBlockerFields(run),
  });
  return null;
}
/**
 * The project gate: once every milestone is accepted but the project is not (the integration
 * branch moved past the verified head of the gate that covered the project), one gate over the
 * whole project verifies the current integration head and accepts the project. A branch that
 * moves again during that gate leaves `wave_project_head_mismatch`.
 * @param {any} ctx
 * @param {{ projectId: string, signal?: AbortSignal, retryFailed?: boolean }} input
 * @param {{ gates: any[], accepted: any[], blocked: any[], stopped?: string }} out
 */
async function gateProject(ctx, { projectId, signal, retryFailed }, out) {
  for (const stale of [false, true]) {
    const snapshot = await snapshotOf(ctx, projectId);
    const stopped = stopReason(snapshot, signal);
    if (stopped && !settled(snapshot.project.status)) out.stopped ??= stopped;
    if (
      settled(snapshot.project.status) ||
      stopped ||
      !reached(snapshot.project.status, 'integrated') ||
      !snapshot.milestones.every(row => settled(row.status))
    )
      return;
    const blocked = out.blocked.length;
    const current = await projectGateRun(ctx, snapshot, { retryFailed, stale }, out);
    if (!current) return;
    if (current.refused) {
      out.blocked.push(current.refused);
      return;
    }
    await runAndAccept(ctx, projectId, current, signal, out, { kind: 'project', id: projectId });
    if (out.blocked.length > blocked) return;
  }
  if (!settled((await snapshotOf(ctx, projectId)).project.status))
    out.blocked.push({ code: 'wave_project_head_mismatch', kind: 'project', id: projectId });
}
// --- gate leases -------------------------------------------------------------------------------

/**
 * The lease of one gate container: `project-gate:<projectId>:<epicId>` for an epic,
 * `project-gate:<projectId>:<kind>:<id>` for a milestone or the project.
 * @param {string} projectId
 * @param {{ kind: string, id: string }} item
 */
export const gateLeaseName = (projectId, item) =>
  item.kind === 'epic' ? `project-gate:${projectId}:${item.id}` : `project-gate:${projectId}:${item.kind}:${item.id}`;
// The leases of a gate over `containers`: each container's own and, for a milestone or the project,
// those of every epic (and milestone) inside it. A gate that accepts a milestone or the project is
// therefore exclusive to the gates of its epics; gates of independent epics share no lease.
function gateLeaseNames(snapshot, containers) {
  const projectId = snapshot.project.projectId,
    names = new Set();
  for (const item of containers) {
    names.add(gateLeaseName(projectId, item));
    if (item.kind === 'epic') continue;
    for (const epic of snapshot.epics)
      if (item.kind === 'project' || epic.milestoneId === item.id)
        names.add(gateLeaseName(projectId, { kind: 'epic', id: epic.id }));
    if (item.kind === 'project')
      for (const milestone of snapshot.milestones)
        names.add(gateLeaseName(projectId, { kind: 'milestone', id: milestone.id }));
  }
  return [...names].sort();
}
// Every container the epic's next gate may cover: its current gate's chain and a new reservation's.
function plannedContainers(snapshot, epic) {
  const gate = latestGate(snapshot, 'epic', epic.id);
  const chains = [
    ...(gate ? [gate.containers] : []),
    ...(settled(epic.status) ? [] : [gateContainers(snapshot, epic)]),
  ];
  return chains.flat();
}
// Take every lease in `names` (sorted, all or none, never waiting); null when one is held elsewhere.
async function withGateLeases(ctx, names, work) {
  const tokens = [];
  for (const name of names) {
    const token = ctx.store.acquireLease(name, randomUUID(), { ttlMs: 60000, limit: 1 });
    if (!token) {
      for (const held of tokens) ctx.store.releaseLease(held);
      return null;
    }
    tokens.push(token);
  }
  // A renewal that finds a lease row gone (TTL expired; another holder may have it) aborts `lost`:
  // the gate stops at its next check (Run, acceptance) and never accepts without its leases.
  const lost = new AbortController();
  const timer = setInterval(() => {
    for (const token of tokens) {
      let renewed;
      try {
        renewed = ctx.store.renewLease(token);
      } catch {
        continue; // A transient Store failure must not throw from the timer; the next beat retries.
      }
      if (renewed === false) lost.abort(Object.assign(new Error('Project lease lost'), { code: 'project_lease_lost' }));
    }
  }, ctx.engine.leaseHeartbeatMs || 10000);
  timer.unref();
  try {
    // Writes of the gate are fenced by its leases (runtime/lease-fence.mjs).
    return { value: await fencedBy(tokens, () => work(lost.signal)) };
  } finally {
    clearInterval(timer);
    for (const token of tokens) ctx.store.releaseLease(token);
  }
}
const gateRunning = (kind, id) => ({ code: 'project_gate_running', kind, id });
// One epic's gate under its leases, on a snapshot read after they were taken. A gate held by
// another holder (`project_gate_running`) is reported, not waited for.
async function gateEpicLeased(ctx, projectId, epicId, options, out) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const before = await snapshotOf(ctx, projectId);
    const names = gateLeaseNames(before, plannedContainers(before, recordOf(before, 'epic', epicId)));
    const held = await withGateLeases(ctx, names, async lost => {
      const snapshot = await snapshotOf(ctx, projectId);
      const epic = recordOf(snapshot, 'epic', epicId);
      const signal = options.signal ? AbortSignal.any([options.signal, lost]) : lost;
      if (lost.aborted) {
        out.blocked.push({ code: 'project_lease_lost', kind: 'epic', id: epicId });
        return 'done';
      }
      const stopped = stopReason(snapshot, signal);
      if (stopped) {
        out.stopped ??= stopped;
        return 'done';
      }
      if (!gateCandidate(snapshot, epic) && !unfinishedEpicGate(ctx, snapshot, epic)) return 'done';
      // Another epic settled meanwhile and the chain now reaches its milestone: take those leases too.
      if (gateLeaseNames(snapshot, plannedContainers(snapshot, epic)).some(name => !names.includes(name)))
        return 'widened';
      await gateEpic(ctx, snapshot, epic, { ...options, signal }, out);
      if (lost.aborted) out.blocked.push({ code: 'project_lease_lost', kind: 'epic', id: epicId });
      return 'done';
    });
    if (held?.value === 'done') return;
    if (!held) break;
  }
  out.blocked.push(gateRunning('epic', epicId));
}
// The epics whose gates run together: every candidate, except that the last open epic of a
// milestone waits while a sibling's gate runs. Its own gate then also accepts the milestone; two
// sibling gates that ran together would leave the milestone to no gate. Likewise, when the chosen
// epics are all the open epics of the project, the last one waits: its gate would widen to the
// project and collide with the leases of the gates running beside it.
function concurrentEpics(snapshot, candidates) {
  const chosen = new Set(candidates.map(row => row.id));
  const deferLast = open => {
    const together = open.filter(row => chosen.has(row.id));
    if (together.length > 1 && together.length === open.length) chosen.delete(together.at(-1).id);
  };
  for (const milestone of snapshot.milestones)
    deferLast(snapshot.epics.filter(row => row.milestoneId === milestone.id && !settled(row.status)));
  deferLast(snapshot.epics.filter(row => !settled(row.status)));
  return candidates.filter(row => chosen.has(row.id));
}
/**
 * Run the gates of every epic whose tasks are all integrated and not covered by its current
 * gate, then accept what a successful gate verified; then the project gate when only the
 * project is left. A failed gate is retried only with `retryFailed`. Gates of independent epics
 * run concurrently, each under its epic lease (`gateLeaseName`); their Git and state changes stay
 * serialized by the integration lease.
 * @param {any} ctx
 * @param {{ projectId: string, signal?: AbortSignal, retryFailed?: boolean }} input
 */
export async function runPendingGates(ctx, { projectId, signal, retryFailed = false }) {
  /** @type {{ gates: any[], accepted: any[], blocked: any[], stopped?: string }} */
  const out = { gates: [], accepted: [], blocked: [] };
  const handled = new Set();
  for (;;) {
    await withIntegrationLease(ctx, projectId, signal, () => advanceContainers(ctx, projectId));
    const snapshot = await snapshotOf(ctx, projectId);
    requireValue(waveProject(ctx, snapshot), 'wave_not_enabled');
    const stopped = stopReason(snapshot, signal);
    if (stopped) {
      out.stopped ??= stopped;
      return out;
    }
    const candidates = snapshot.epics.filter(
      row => !handled.has(row.id) && (gateCandidate(snapshot, row) || unfinishedEpicGate(ctx, snapshot, row)),
    );
    if (!candidates.length) break;
    const batch = concurrentEpics(snapshot, candidates);
    for (const epic of batch) handled.add(epic.id);
    // Each gate reports into its own rows; they are joined in epic order.
    const parts = batch.map(() => ({ gates: [], accepted: [], blocked: [] }));
    const results = await Promise.allSettled(
      batch.map((epic, index) => gateEpicLeased(ctx, projectId, epic.id, { signal, retryFailed }, parts[index])),
    );
    for (const part of parts) {
      for (const key of ['gates', 'accepted', 'blocked']) out[key].push(...part[key]);
      if (part.stopped) out.stopped ??= part.stopped;
    }
    const failure = results.find(result => result.status === 'rejected');
    if (failure) throw failure.reason;
  }
  if (out.blocked.length || out.stopped) return out;
  // The project gate (when only the project is left) holds every gate lease of the project.
  const snapshot = await snapshotOf(ctx, projectId);
  if (
    settled(snapshot.project.status) ||
    !reached(snapshot.project.status, 'integrated') ||
    !snapshot.milestones.every(row => settled(row.status))
  )
    return out;
  const held = await withGateLeases(ctx, gateLeaseNames(snapshot, [{ kind: 'project', id: projectId }]), async lost => {
    await gateProject(ctx, { projectId, signal: signal ? AbortSignal.any([signal, lost]) : lost, retryFailed }, out);
    // A lost lease ended the project gate early: never a clean pass.
    if (lost.aborted) out.blocked.push({ code: 'project_lease_lost', kind: 'project', id: projectId });
  });
  if (!held) out.blocked.push(gateRunning('project', projectId));
  return out;
}
const heldGateStates = [...retryStates, 'waiting_limits'];
/**
 * Read-only: the gates that hold a wave project, rows like `runPendingGates().blocked`. A gate whose
 * Run stopped without acceptance (blocked, failed, cancelled; `quota` for waiting_limits) names the
 * first not yet accepted container of its chain (an epic, or its milestone or the project when the
 * epic was accepted first), unless a later gate covers that container. An epic or the project that
 * is ready for a gate that has not run or finished yet is `project_gate_pending` (`kodo project
 * gates` runs it). Used by next-wave.
 * @param {{ store: any }} ctx
 * @param {any} snapshot
 */
export function gateHolds(ctx, snapshot) {
  const rows = [],
    held = new Set();
  const key = item => `${item.kind}:${item.id}`;
  const gates = snapshot.gates ?? [];
  // A gate holds the first container of its chain (epic → milestone → project) that is not
  // accepted yet, until a later gate covers that container (a retry or a replacement).
  for (const gate of gates) {
    const open = gate.containers.find(item => !settled(recordOf(snapshot, item.kind, item.id)?.status));
    if (
      !open ||
      gates.some(other => other.number > gate.number && other.containers.some(item => key(item) === key(open)))
    )
      continue;
    const run = storedRun(ctx.store, gate.runId);
    // A verified gate whose acceptance stopped mid-chain (for example after a crash between the
    // epic and its milestone): `kodo project gates` resumes the chain, so the host is told to run it.
    // Only while that container is still integrated: after append-milestone the project is
    // running again and an old finished chain is no longer resumable. The project itself is never
    // resumed from an epic's chain: its own gate is reported by pending('project') below.
    if (
      run?.state === 'succeeded' &&
      open.kind !== 'project' &&
      reached(recordOf(snapshot, open.kind, open.id)?.status, 'integrated')
    ) {
      for (const item of gate.containers) held.add(key(item));
      rows.push({ code: 'project_gate_pending', kind: open.kind, id: open.id, gateId: gate.id, runId: run.id });
      continue;
    }
    if (!run || !heldGateStates.includes(run.state)) continue;
    for (const item of gate.containers) held.add(key(item));
    rows.push({
      code: run.state === 'waiting_limits' ? 'quota' : blockerOf(run),
      kind: open.kind,
      id: open.id,
      gateId: gate.id,
      runId: run.id,
      state: run.state,
    });
  }
  const pending = (kind, id) => {
    if (!held.has(key({ kind, id }))) rows.push({ code: 'project_gate_pending', kind, id });
  };
  for (const epic of snapshot.epics)
    if (!settled(epic.status) && gateCandidate(snapshot, epic)) pending('epic', epic.id);
  const project = snapshot.project;
  if (
    !settled(project.status) &&
    snapshot.milestones.every(row => settled(row.status)) &&
    reached(project.status, 'integrated')
  )
    pending('project', project.projectId);
  return rows;
}
