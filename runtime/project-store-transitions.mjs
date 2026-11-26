import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { assertFence } from './lease-fence.mjs';
import {
  metadata,
  identity,
  retryStates,
  settledStates,
  children,
  mergeBy,
  transaction,
  port,
  isWave,
  bytes,
  body,
  get,
  put,
  attemptRecord,
  currentAttempt,
  writeAttempt,
  readSnapshot,
  complete,
  control,
  frozenAttempt,
} from './project-store-records.mjs';
import { fail, requireValue } from './project-store-validation.mjs';

function applySetPaused(ctx, { action, project }, change) {
  change.kind = 'project';
  change.previous = project;
  change.record = { ...project, paused: action.paused };
}

function applyRecordEdit(ctx, { action, project, projectId, now }, change) {
  requireValue(children.includes(change.kind), 'record_invalid');
  control(ctx, project);
  if (action.op === 'insert') {
    const ancestors = [project];
    if (change.kind === 'task') ancestors.push(get(ctx, projectId, 'epic', action.record.epicId));
    if (change.kind !== 'milestone')
      ancestors.push(
        get(ctx, projectId, 'milestone', change.kind === 'epic' ? action.record.milestoneId : ancestors[1].milestoneId),
      );
    requireValue(
      ancestors.every(parent => !['accepted', 'released'].includes(parent.status)),
      'insertion_blocked',
    );
  }
  if (action.op === 'amend') {
    change.previous = get(ctx, projectId, change.kind, action.id);
    requireValue(action.record.id === action.id, 'identity_conflict');
    requireValue(!['accepted', 'released'].includes(change.previous.status), 'amendment_blocked');
    if (change.kind === 'task') {
      requireValue(action.record.epicId === change.previous.epicId, 'reparent_blocked');
      const active = currentAttempt(ctx, projectId, action.id);
      requireValue(!active || settledStates.has(active.status), 'active_attempt');
    } else if (change.kind === 'epic')
      requireValue(action.record.milestoneId === change.previous.milestoneId, 'reparent_blocked');
  }
  change.record = {
    ...action.record,
    ...metadata(ctx, projectId, now),
    revision: change.previous ? change.previous.revision + 1 : 1,
    createdAt: change.previous?.createdAt ?? now,
  };
  put(ctx, change.kind, change.record, action.op === 'insert');
}

function applyRiskApproval(ctx, { command, action, project, projectId, now }, change) {
  control(ctx, project);
  change.kind = 'task';
  change.record = get(ctx, projectId, change.kind, action.taskId);
  requireValue(change.record.revision === action.taskRevision, 'revision_conflict');
  const approval = {
    schemaVersion: 1,
    projectId,
    taskId: change.record.id,
    taskRevision: change.record.revision,
    actor: command.actor,
    reason: command.reason,
    approvedAt: now,
  };
  ctx.db
    .prepare(
      'INSERT INTO kodo_project_approvals VALUES(?,?,?,?) ON CONFLICT(project_id,task_id,task_revision) DO UPDATE SET body=excluded.body',
    )
    .run(projectId, change.record.id, change.record.revision, body(ctx, 'riskApproval', approval));
  change.previous = change.record;
}

function applyReserveAttempt(ctx, { action, project, projectId, now }, change) {
  control(ctx, project);
  change.kind = 'attempt';
  const task = get(ctx, projectId, 'task', action.taskId),
    current = currentAttempt(ctx, projectId, task.id);
  requireValue(
    !['accepted', 'released'].includes(task.status) && (task.status !== 'cancelled' || action.retryFailed),
    'reservation_blocked',
  );
  if (current && !retryStates.has(current.status)) {
    requireValue(!settledStates.has(current.status), 'reservation_blocked');
    frozenAttempt(ctx, current, task);
    change.attempt = current;
    change.previous = current;
    change.record = current;
  } else {
    requireValue(!current || action.retryFailed, 'retry_required');
    const number = ctx.db
      .prepare('SELECT COALESCE(MAX(number),0)+1 AS n FROM kodo_project_attempts WHERE project_id=? AND task_id=?')
      .get(projectId, task.id).n;
    const contractHash = ctx.contracts.directorContractHash(task, ctx.options);
    ctx.validation.safe(ctx.contracts.buildDirectorTaskInput({ project, task }, ctx.options));
    change.attempt = {
      schemaVersion: 1,
      id: randomUUID(),
      projectId,
      taskId: task.id,
      taskRevision: task.revision,
      number,
      runId: randomUUID(),
      contractHash,
      status: 'reserved',
      baseSha: null,
      headSha: null,
      evidence: [],
      reason: null,
      createdAt: now,
      updatedAt: now,
    };
    writeAttempt(ctx, change.attempt, true);
    ctx.db
      .prepare(
        'INSERT INTO kodo_project_current VALUES(?,?,?) ON CONFLICT(project_id,task_id) DO UPDATE SET attempt_id=excluded.attempt_id',
      )
      .run(projectId, task.id, change.attempt.id);
    change.record = change.attempt;
  }
}

function applyTransition(ctx, { action, projectId, now }, change) {
  requireValue(['project', ...children, 'attempt'].includes(change.kind), 'record_invalid');
  change.previous =
    change.kind === 'attempt'
      ? attemptRecord(
          ctx,
          ctx.db.prepare('SELECT * FROM kodo_project_attempts WHERE id=? AND project_id=?').get(action.id, projectId),
        )
      : get(ctx, projectId, change.kind, action.id);
  requireValue(change.previous, 'entity_not_found');
  if (change.kind === 'attempt') {
    requireValue(currentAttempt(ctx, projectId, change.previous.taskId)?.id === change.previous.id, 'binding_conflict');
    frozenAttempt(ctx, change.previous, get(ctx, projectId, 'task', change.previous.taskId));
  }
  const s = readSnapshot(ctx, projectId);
  complete(ctx, s);
  ctx.contracts.assertProjectTransition({
    record: change.previous,
    to: action.to,
    snapshot: s,
    evidence: action.evidence,
    mappings: action.mappings,
  });
  change.record = {
    ...change.previous,
    status: action.to,
    evidence: mergeBy(change.previous.evidence, action.evidence, 'sha256'),
    updatedAt: now,
  };
  if (change.kind !== 'attempt')
    change.record.mappings = mergeBy(change.previous.mappings, action.mappings, 'criterionId');
  else change.attempt = change.record;
  if (change.kind === 'attempt') writeAttempt(ctx, change.record);
  else if (change.kind !== 'project') put(ctx, change.kind, change.record);
}

// Reopen a closed wave project with one new milestone. The project moves to
// running without a lifecycle transition; its closed-state proof moves to
// `reopened` so old and new project refs never bind ambiguously. Closed
// children stay untouched and the new records start proposed.
function applyAppendMilestone(ctx, { action, project, projectId, now }, change) {
  const s = readSnapshot(ctx, projectId);
  complete(ctx, s);
  port(ctx, 'assertProjectReopen')({ snapshot: s, action });
  for (const [kind, records] of [
    ['milestone', [action.milestone]],
    ['epic', action.epics],
    ['task', action.tasks],
  ])
    for (const record of records) put(ctx, kind, { ...record, ...metadata(ctx, projectId, now) }, true);
  change.kind = 'project';
  change.previous = project;
  change.record = {
    ...project,
    status: 'running',
    evidence: [],
    mappings: [],
    reopened: [
      ...(project.reopened ?? []),
      {
        status: project.status,
        revision: project.revision,
        reopenedAt: now,
        evidence: project.evidence,
        mappings: project.mappings,
      },
    ],
  };
}

const closedStates = new Set(['accepted', 'released']);
const containerChildren = (s, item) =>
  item.kind === 'project' ? s.milestones : s.epics.filter(epic => epic.milestoneId === item.id);

// Tasks covered by the widest container of a valid epic ⊂ milestone ⊂ project chain.
// A milestone or project joins the chain only when every child outside the chain
// is already accepted: one gate never verifies a sibling it does not merge.
function gateTasks(ctx, s, containers, merges) {
  for (const [index, item] of containers.entries()) {
    const next = containers[index + 1],
      inner = containers[index - 1];
    if (item.kind === 'project')
      requireValue(item.id === s.project.projectId && !closedStates.has(s.project.status), 'gate_invalid');
    else {
      const record = (item.kind === 'epic' ? s.epics : s.milestones).find(row => row.id === item.id);
      requireValue(record, 'gate_invalid');
      if (closedStates.has(record.status)) {
        // A failed gate may already have accepted the inner container. Only the
        // same verified task set and chain, with an open parent, may retry it.
        const previous = s.gates.findLast(
          gate => gate.installed && isDeepStrictEqual(gate.containers[0], containers[0]),
        );
        requireValue(
          next &&
            previous &&
            isDeepStrictEqual(previous.containers, containers) &&
            isDeepStrictEqual(previous.merges, merges) &&
            retryStates.has(runState(ctx, previous.runId)),
          'gate_invalid',
        );
      }
      if (item.kind === 'epic' && next) requireValue(record.milestoneId === next.id, 'gate_invalid');
    }
    if (item.kind !== 'epic')
      requireValue(
        containerChildren(s, item).every(child => child.id === inner?.id || closedStates.has(child.status)),
        'gate_invalid',
      );
  }
  const widest = containers.at(-1);
  if (widest.kind === 'project') return s.tasks;
  if (widest.kind === 'epic') return s.tasks.filter(task => task.epicId === widest.id);
  const epics = new Set(s.epics.filter(epic => epic.milestoneId === widest.id).map(epic => epic.id));
  return s.tasks.filter(task => epics.has(task.epicId));
}

// Merges cover exactly the gate's tasks, each integrated|accepted at its current
// attempt, and each mergeCommit is the one the attempt's own Run recorded for
// its verified head (never a caller-chosen older commit).
function assertGateMerges(ctx, s, containers, merges) {
  const tasks = gateTasks(ctx, s, containers, merges);
  const covered = new Map(tasks.map(task => [task.id, task]));
  requireValue(merges.length === covered.size, 'gate_invalid');
  for (const merge of merges) {
    const task = covered.get(merge.taskId),
      attempt = s.currentAttempts.find(item => item.taskId === merge.taskId);
    requireValue(
      task &&
        ['integrated', 'accepted'].includes(task.status) &&
        attempt?.id === merge.attemptId &&
        attempt.runId === merge.runId,
      'gate_invalid',
    );
    const run = storedRun(ctx, merge.runId),
      integration = run?.integration;
    requireValue(
      integration?.status === 'merged' &&
        integration.mergeCommit === merge.mergeCommit &&
        typeof run.headSha === 'string' &&
        integration.mergedHead === run.headSha,
      'gate_invalid',
    );
  }
}

function latestGate(s, first) {
  return s.gates
    .filter(gate => gate.containers[0].kind === first.kind && gate.containers[0].id === first.id)
    .reduce((latest, gate) => (!latest || gate.number > latest.number ? gate : latest), null);
}

function storedRun(ctx, runId) {
  try {
    return ctx.store.getRun(runId) ?? null;
  } catch {
    return null;
  }
}
const runState = (ctx, runId) => storedRun(ctx, runId)?.state ?? null;

// The gate range is never empty: its base is the recorded first parent (`integration.before`)
// of a covered merge, and Git ancestry (checked before the transaction) makes every covered
// merge a strict descendant of it, so the base precedes the earliest covered merge.
function assertGateBase(ctx, action) {
  const befores = new Set(action.merges.map(merge => storedRun(ctx, merge.runId)?.integration?.before));
  requireValue(
    action.baseSha !== action.headSha &&
      befores.has(action.baseSha) &&
      action.merges.every(merge => merge.mergeCommit !== action.baseSha),
    'gate_invalid',
  );
}

// A new gate for the same narrowest container replaces the latest one only when it is
// a retry of a settled failure, an uninstalled reservation whose head went stale, or a
// project gate whose verified head the integration branch has since moved past.
function replaceable(ctx, latest, action) {
  const state = runState(ctx, latest.runId);
  if (!latest.installed) return state === null && latest.headSha !== action.headSha;
  if (action.retry && retryStates.has(state)) return true;
  return latest.containers[0].kind === 'project' && state === 'succeeded' && latest.headSha !== action.headSha;
}

function recordedOrigins(ctx, snapshot, history) {
  const tasks = new Map(snapshot.tasks.map(task => [task.id, task.writePaths]));
  const origins = new Map();
  const attempts = ctx.db
    .prepare('SELECT id, task_id, run_id FROM kodo_project_attempts WHERE project_id=?')
    .all(snapshot.project.projectId);
  for (const attempt of attempts) {
    const integration = storedRun(ctx, attempt.run_id)?.integration;
    const parents = history.get(integration?.mergeCommit);
    // Only a merge that passed the integration checks (published or awaiting publication) is
    // attributed; a released pending record keeps its commit fields but proves nothing.
    if (
      ['merged', 'pending'].includes(integration?.status) &&
      parents?.length === 2 &&
      parents[0] === integration.before &&
      parents[1] === (integration.mergedHead ?? integration.headSha)
    )
      origins.set(integration.mergeCommit, { kind: 'task', ref: attempt.id, writePaths: tasks.get(attempt.task_id) });
  }
  for (const gate of snapshot.gates) {
    const run = storedRun(ctx, gate.runId);
    const saved = run?.gateReturn;
    if (!saved || !history.has(saved.target)) continue;
    const parents = history.get(saved.target);
    const fastForward = saved.before === gate.headSha && saved.target === run.headSha;
    const mergeBack = parents.length === 2 && parents[0] === saved.before && parents[1] === run.headSha;
    if (!fastForward && !mergeBack) continue;
    const writePaths = [...new Set(gate.merges.flatMap(m => tasks.get(m.taskId)))];
    // A fast-forward return may publish several repair commits; they are attributed only when
    // their first-parent chain actually reaches the recorded base.
    const chain = [];
    let commit = saved.target;
    while (history.has(commit) && commit !== saved.before) {
      chain.push(commit);
      commit = history.get(commit)[0];
    }
    if (commit !== saved.before) continue;
    for (const repair of chain) origins.set(repair, { kind: 'gate', ref: gate.id, writePaths });
  }
  return [...history.keys()]
    .reverse()
    .filter(commit => origins.has(commit))
    .map(commit => ({ commit, ...origins.get(commit) }));
}
function applyReserveGate(ctx, { action, project, projectId, now, history }, change) {
  requireValue(isWave(ctx, project), 'gate_unsupported');
  control(ctx, project);
  const s = readSnapshot(ctx, projectId);
  complete(ctx, s);
  assertGateMerges(ctx, s, action.containers, action.merges);
  assertGateBase(ctx, action);
  const latest = latestGate(s, action.containers[0]);
  if (latest) requireValue(replaceable(ctx, latest, action), 'gate_exists');
  change.kind = 'gate';
  change.record = {
    schemaVersion: 1,
    id: randomUUID(),
    projectId,
    number: s.gates.reduce((max, gate) => Math.max(max, gate.number), 0) + 1,
    containers: action.containers,
    runId: randomUUID(),
    baseSha: action.baseSha,
    headSha: action.headSha,
    merges: action.merges,
    provenance: history instanceof Map ? recordedOrigins(ctx, s, history) : [],
    installed: false,
    createdAt: now,
    updatedAt: now,
  };
  // The stale reservation stays in history, marked with its successor; it is never installed.
  if (latest && !latest.installed) put(ctx, 'gate', { ...latest, supersededBy: change.record.id, updatedAt: now });
  put(ctx, 'gate', change.record, true);
}

// Git facts of a reservation, checked before its transaction (commits are immutable): every
// covered merge lies on the first-parent history of the head after the base, and the earliest
// one has the base as its first parent, so every merge strictly descends from the base.
export async function assertGateAncestry(ctx, command) {
  let project;
  try {
    project = get(ctx, command.projectId, 'project', command.projectId);
  } catch {
    return; // The transaction reports a missing project.
  }
  if (!isWave(ctx, project)) return; // The transaction refuses it (gate_unsupported).
  const { baseSha, headSha, merges } = command.action;
  const history = await ctx.gateRange({
    root: project.root,
    baseSha,
    headSha,
    mergeCommits: merges.map(merge => merge.mergeCommit),
  });
  requireValue(baseSha !== headSha && (history === true || history instanceof Map), 'gate_invalid');
  return history;
}

export const operations = {
  setPaused: applySetPaused,
  insert: applyRecordEdit,
  amend: applyRecordEdit,
  approveRisk: applyRiskApproval,
  reserveAttempt: applyReserveAttempt,
  transition: applyTransition,
  appendMilestone: applyAppendMilestone,
  reserveGate: applyReserveGate,
};

export async function installRun(ctx, input) {
  // Installs are fenced like commands: a holder whose lease passed on installs nothing.
  ctx.validation.safe(input);
  requireValue(
    input && Object.keys(input).length === 2 && Object.hasOwn(input, 'binding') && Object.hasOwn(input, 'runDraft'),
    'record_invalid',
  );
  const binding = ctx.validation.normalize('installBinding', input.binding),
    runDraft = structuredClone(input.runDraft);
  return transaction(ctx.db, 'BEGIN IMMEDIATE', () => {
    assertFence(ctx.db);
    const s = readSnapshot(ctx, binding.projectId);
    complete(ctx, s);
    const task = s.tasks.find(item => item.id === binding.taskId);
    const attempt = currentAttempt(ctx, binding.projectId, binding.taskId);
    requireValue(
      task &&
        attempt &&
        attempt.id === binding.attemptId &&
        attempt.runId === binding.runId &&
        attempt.taskRevision === binding.taskRevision &&
        attempt.contractHash === binding.contractHash,
      'binding_conflict',
    );
    frozenAttempt(ctx, attempt, task);
    requireValue(
      runDraft.id === binding.runId &&
        identity(runDraft.project) === s.project.projectKey &&
        runDraft.task === ctx.contracts.buildDirectorTaskInput({ project: s.project, task }, ctx.options) &&
        bytes(ctx, 'installBinding', ctx.validation.normalize('installBinding', runDraft.directorBinding)).equals(
          bytes(ctx, 'installBinding', binding),
        ),
      'binding_conflict',
    );
    const row = ctx.db.prepare('SELECT body FROM runs WHERE id=?').get(binding.runId);
    const installed = ctx.db
      .prepare('SELECT installed FROM kodo_project_attempts WHERE id=?')
      .get(attempt.id).installed;
    if (row) {
      requireValue(installed === 1, 'binding_conflict');
      const saved = savedRun(ctx, row);
      requireValue(
        saved.id === binding.runId &&
          identity(saved.project) === s.project.projectKey &&
          saved.task === runDraft.task &&
          bytes(ctx, 'installBinding', ctx.validation.normalize('installBinding', saved.directorBinding)).equals(
            bytes(ctx, 'installBinding', binding),
          ),
        'binding_conflict',
      );
      return saved;
    }
    requireValue(installed === 0 && attempt.status === 'reserved', 'binding_conflict');
    control(ctx, s.project);
    requireValue(validRunDraft(runDraft), 'run_draft_invalid');
    ctx.validation.safe(runDraft);
    const saved = ctx.store.createRun(runDraft);
    requireValue(saved && typeof saved.then !== 'function' && isDeepStrictEqual(saved, runDraft), 'run_draft_invalid');
    ctx.db.prepare('UPDATE kodo_project_attempts SET installed=1 WHERE id=?').run(attempt.id);
    put(ctx, 'project', { ...s.project, revision: s.revision + 1, updatedAt: ctx.clock() });
    return saved;
  });
}

function savedRun(ctx, row) {
  let saved;
  try {
    saved = JSON.parse(row.body);
    ctx.validation.safe(saved);
  } catch {
    fail('database_corrupt');
  }
  return saved;
}

// Shape of a fresh legacy Run draft; gate drafts extend it (validGateRunDraft).
function validRunDraft(runDraft) {
  return (
    runDraft.state === 'created' &&
    typeof runDraft.createdAt === 'string' &&
    Number.isFinite(Date.parse(runDraft.createdAt)) &&
    runDraft.config &&
    typeof runDraft.config === 'object' &&
    !Array.isArray(runDraft.config) &&
    typeof runDraft.client === 'string' &&
    ['current', 'both'].includes(runDraft.providers) &&
    typeof runDraft.baseSha === 'string' &&
    /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(runDraft.baseSha) &&
    runDraft.snapshot &&
    typeof runDraft.snapshot === 'object' &&
    !Array.isArray(runDraft.snapshot) &&
    (runDraft.requestedMode === null || typeof runDraft.requestedMode === 'string') &&
    Array.isArray(runDraft.sessionAttempts) &&
    runDraft.sessionAttempts.length === 0 &&
    Array.isArray(runDraft.coordinatorOperations) &&
    runDraft.coordinatorOperations.length === 0 &&
    runDraft.completed &&
    !Array.isArray(runDraft.completed) &&
    Object.keys(runDraft.completed).length === 0 &&
    runDraft.nodes &&
    !Array.isArray(runDraft.nodes) &&
    Object.keys(runDraft.nodes).length === 0 &&
    typeof runDraft.artifacts === 'string' &&
    path.isAbsolute(runDraft.artifacts) &&
    typeof runDraft.worktreeRoot === 'string' &&
    path.isAbsolute(runDraft.worktreeRoot) &&
    typeof runDraft.cwd === 'string' &&
    path.isAbsolute(runDraft.cwd) &&
    typeof runDraft.branch === 'string' &&
    runDraft.branch.length > 0
  );
}

const nodeOf = merge => ({
  id: merge.taskId,
  attempt: 0,
  status: 'integrated',
  headSha: merge.mergeCommit,
  sourceRunId: merge.runId,
  attemptId: merge.attemptId,
});

// The gate manifest artifact lies in the Run's own evidence directory, content-addressed
// (`gate-manifest-<sha256>.json`) and bound to the gate head; validators check its bytes.
function validManifestRef(runDraft, gate) {
  const ref = runDraft.gateManifest;
  return Boolean(
    ref &&
    typeof ref === 'object' &&
    typeof ref.path === 'string' &&
    path.isAbsolute(ref.path) &&
    typeof ref.sha256 === 'string' &&
    /^[a-f0-9]{64}$/.test(ref.sha256) &&
    path.dirname(ref.path) === path.join(runDraft.artifacts, 'evidence') &&
    path.basename(ref.path) === `gate-manifest-${ref.sha256}.json` &&
    ref.headSha === gate.headSha,
  );
}

// Shape of a fresh gate Run draft: the legacy draft fields, but it starts on the
// gate head with exactly the covered tasks planned and integrated at their
// recorded merge commits, and it runs the full (unprofiled) verification.
function validGateRunDraft(runDraft, gate, tasks) {
  const { completed, nodes, plan, ...rest } = runDraft;
  return Boolean(
    validRunDraft({ ...rest, completed: {}, nodes: {} }) &&
    validManifestRef(runDraft, gate) &&
    runDraft.baseSha === gate.baseSha &&
    runDraft.headSha === gate.headSha &&
    runDraft.verificationProfile === undefined &&
    runDraft.executor === undefined &&
    runDraft.config.delivery?.enabled !== true &&
    isDeepStrictEqual(completed, { implementation: true }) &&
    Array.isArray(plan?.tasks) &&
    plan.tasks.length === gate.merges.length &&
    nodes &&
    typeof nodes === 'object' &&
    !Array.isArray(nodes) &&
    Object.keys(nodes).length === gate.merges.length &&
    gate.merges.every(
      (merge, index) =>
        plan.tasks[index]?.id === merge.taskId &&
        isDeepStrictEqual(plan.tasks[index].writePaths, tasks[index].writePaths) &&
        isDeepStrictEqual(plan.tasks[index].dependsOn, []) &&
        isDeepStrictEqual(nodes[merge.taskId], nodeOf(merge)),
    ),
  );
}

/** Atomically bind a reserved wave gate to its legacy Run. The binding must
 * equal gateBindingFor(gate) byte for byte and the draft task must equal
 * buildGateInput; a repeat after install returns the stored Run. */
export async function installGateRun(ctx, input) {
  ctx.validation.safe(input);
  requireValue(
    input && Object.keys(input).length === 2 && Object.hasOwn(input, 'binding') && Object.hasOwn(input, 'runDraft'),
    'record_invalid',
  );
  const bindingFor = port(ctx, 'gateBindingFor'),
    gateInput = port(ctx, 'buildGateInput'),
    criteriaOf = port(ctx, 'gateContainerCriteria');
  const binding = ctx.validation.normalize('gateBinding', input.binding),
    runDraft = structuredClone(input.runDraft);
  const bound = value =>
    bytes(ctx, 'gateBinding', ctx.validation.normalize('gateBinding', value)).equals(
      bytes(ctx, 'gateBinding', binding),
    );
  return transaction(ctx.db, 'BEGIN IMMEDIATE', () => {
    assertFence(ctx.db);
    const s = readSnapshot(ctx, binding.projectId);
    complete(ctx, s);
    requireValue(isWave(ctx, s.project), 'gate_unsupported');
    const gate = s.gates.find(item => item.id === binding.gateId);
    requireValue(gate && bound(bindingFor(gate, ctx.options)), 'binding_conflict');
    const tasks = gate.merges.map(merge => s.tasks.find(task => task.id === merge.taskId));
    requireValue(tasks.every(Boolean), 'binding_conflict');
    requireValue(
      runDraft.id === binding.runId &&
        identity(runDraft.project) === s.project.projectKey &&
        runDraft.task ===
          gateInput({ project: s.project, gate, tasks, containers: criteriaOf(s, gate) }, ctx.options) &&
        bound(runDraft.directorBinding),
      'binding_conflict',
    );
    const row = ctx.db.prepare('SELECT body FROM runs WHERE id=?').get(binding.runId);
    if (row) {
      requireValue(gate.installed, 'binding_conflict');
      const saved = savedRun(ctx, row);
      requireValue(
        saved.id === binding.runId &&
          identity(saved.project) === s.project.projectKey &&
          saved.task === runDraft.task &&
          bound(saved.directorBinding),
        'binding_conflict',
      );
      return saved;
    }
    // Fresh install: still the latest gate for its container, with current merges.
    requireValue(
      !gate.installed && gate.supersededBy === undefined && latestGate(s, gate.containers[0])?.id === gate.id,
      'binding_conflict',
    );
    assertGateMerges(ctx, s, gate.containers, gate.merges);
    control(ctx, s.project);
    requireValue(validGateRunDraft(runDraft, gate, tasks), 'run_draft_invalid');
    ctx.validation.safe(runDraft);
    const saved = ctx.store.createRun(runDraft);
    requireValue(saved && typeof saved.then !== 'function' && isDeepStrictEqual(saved, runDraft), 'run_draft_invalid');
    const now = ctx.clock();
    put(ctx, 'gate', { ...gate, installed: true, updatedAt: now });
    put(ctx, 'project', { ...s.project, revision: s.revision + 1, updatedAt: now });
    return saved;
  });
}
