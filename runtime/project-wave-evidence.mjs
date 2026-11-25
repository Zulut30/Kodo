import { remoteProof } from './remote-task-receipt.mjs';
import { isDeepStrictEqual } from 'node:util';
import { isCurrentBehaviorReceipt } from './behavior-gate.mjs';
import { integrationBranch } from './project-integration.mjs';
import {
  lifecycle,
  settled,
  sha,
  result,
  history,
  blocked,
  forward,
  immutable,
  prepare,
  verify,
  references,
  mapped,
  hasProof,
  gatesCurrent,
  integrated,
  controls,
  bindingMatches,
} from './project-evidence.mjs';

// Wave cadence: a task run proves only `integrated` (fast checks, behavior and
// its merge into the project integration branch). `accepted` comes only from a
// gate run that verified the integration head for its containers. Like
// evaluateProjectTransition this consumes proof; it never runs Git or commands.
const reached = (record, state) => lifecycle.indexOf(record?.status) >= lifecycle.indexOf(state);
const containerKey = container => `${container?.kind}:${container?.id}`;
const covers = (gate, kind, id) => gate.containers.some(container => container?.kind === kind && container.id === id);
const currentOf = (snapshot, taskId) => snapshot.currentAttempts.find(row => row.taskId === taskId);
const mergeOf = (gate, attempt) =>
  gate.merges.some(
    entry => entry?.taskId === attempt.taskId && entry.attemptId === attempt.id && entry.runId === attempt.runId,
  );
const approved = (task, snapshot) =>
  !task.riskApprovalRequired ||
  snapshot.riskApprovals.some(row => row.taskId === task.id && row.taskRevision === task.revision);

function childrenOf(snapshot, kind, record) {
  if (kind === 'project') return snapshot.milestones;
  if (kind === 'milestone') return snapshot.epics.filter(row => row.milestoneId === record.id);
  if (kind === 'epic') return snapshot.tasks.filter(row => row.epicId === record.id);
  return null;
}

function recordFor(snapshot, action) {
  if (action.kind === 'project') return snapshot.project;
  if (action.kind === 'attempt') return snapshot.currentAttempts.find(row => row.id === action.id);
  return snapshot[`${action.kind}s`]?.find(row => row.id === action.id);
}

// Gate records travel in the same coherent snapshot. A bounded list is
// accepted only as complete; a missing later gate would hide supersession.
function gatesOf(snapshot) {
  const gates = snapshot.gates ?? [],
    count = snapshot.completeness?.gates;
  if (
    !Array.isArray(gates) ||
    (count !== undefined &&
      (count?.complete !== true || count.total !== gates.length || count.returned !== gates.length))
  )
    throw Error('gates');
  const ids = new Set();
  for (const gate of gates) {
    if (!gate?.id || gate.projectId !== snapshot.project.projectId || ids.has(gate.id)) throw Error('gate');
    ids.add(gate.id);
  }
  return gates;
}

function waveReady(task, snapshot, contracts) {
  const satisfied =
    typeof contracts.dependencySatisfied === 'function'
      ? status => contracts.dependencySatisfied(snapshot.project, status) === true
      : status => settled.has(status);
  return (
    Array.isArray(task?.dependsOn) &&
    task.dependsOn.every(id => snapshot.tasks.some(dep => dep.id === id && satisfied(dep.status))) &&
    approved(task, snapshot)
  );
}

function runStates(run) {
  const states = [];
  if (['executing', 'testing', 'verifying', 'delivering', 'releasing', 'succeeded'].includes(run.state))
    states.push('running');
  if (['testing', 'verifying', 'delivering', 'releasing', 'succeeded'].includes(run.state)) states.push('verifying');
  return states;
}

function fastProof(run) {
  const checks = run.checks;
  return (
    run.state === 'succeeded' &&
    run.verificationProfile === 'task-fast' &&
    (remoteProof(run) ||
      (checks?.schemaVersion === 2 &&
        checks.profile === 'task-fast' &&
        checks.complete === true &&
        checks.headSha === run.headSha &&
        Boolean(checks.fingerprint) &&
        checks.plan != null &&
        Array.isArray(checks.results) &&
        checks.results.length > 0 &&
        (!Array.isArray(checks.plan) || checks.plan.length === checks.results.length) &&
        checks.results.every(row => row?.exitCode === 0))) &&
    isCurrentBehaviorReceipt(run.behavior, { headSha: run.headSha, baseSha: run.baseSha, config: run.config })
  );
}

function mergedIntoBranch(run, snapshot) {
  const merge = run.integration;
  return (
    merge?.status === 'merged' &&
    merge.mergedHead === run.headSha &&
    sha(merge.before) &&
    sha(merge.mergeCommit) &&
    merge.mergeCommit !== merge.before &&
    merge.branch === integrationBranch(snapshot.project.projectId)
  );
}

async function readyTask({ snapshot, contracts, record, ports }) {
  if (!waveReady(record, snapshot, contracts)) return blocked(record, 'task_readiness_blocked');
  await references(record.interfaceRefs, ports);
  return result(['ready']);
}

// attempt/task → running, verifying or integrated from the task's own run.
async function integrateTask({ snapshot, contracts, options, action, record, input, ports }) {
  const current = action.kind === 'attempt' ? record : currentOf(snapshot, record.id);
  if (!current) return blocked(record, 'current_attempt_missing');
  contracts.assertDirectorSafe(input.run, options);
  if (!bindingMatches(snapshot, current, input.run)) return blocked(record, 'attempt_binding_invalid');
  if (controls(snapshot, current, input.run)) return blocked(record, 'project_control_blocked');
  const task = snapshot.tasks.find(row => row.id === current.taskId);
  if (!waveReady(task, snapshot, contracts)) return blocked(record, 'task_readiness_blocked');
  const run = immutable(structuredClone(input.run));
  let evidence;
  try {
    await verify(ports.validateRun, run);
    await references(task.interfaceRefs, ports);
    evidence = await references([...current.evidence, ...action.evidence], ports, run);
  } catch {
    return blocked(record, 'trusted_proof_invalid');
  }
  const states = runStates(run);
  let blocker = null;
  if (!fastProof(run) || !hasProof(evidence, 'checks', run)) blocker = 'wave_fast_proof_missing';
  else if (!mergedIntoBranch(run, snapshot)) blocker = 'wave_integration_missing';
  else states.push('integrated');
  const eligible = [...history(record), ...forward(record, states)];
  return result(eligible, eligible.includes(action.to) ? [] : [blocker || 'wave_fast_proof_missing'], evidence);
}

// Containers advance through ready..integrated only when every child already
// reached that state; their children's transitions carried the actual proof.
function containerProgress({ snapshot, action, record }) {
  const children = childrenOf(snapshot, action.kind, record);
  if (!children?.length) return blocked(record, 'container_children_missing');
  const states = ['ready', 'running', 'verifying', 'integrated'].filter(state =>
    children.every(child => reached(child, state)),
  );
  const eligible = [...history(record), ...forward(record, states)];
  return result(eligible, eligible.includes(action.to) ? [] : ['container_progress_unverified']);
}

// SHA-256 of an empty diff: a review receipt with it reviewed nothing.
const EMPTY_DIFF = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

// The binding keeps the gate head; repairs may move run.headSha to a verified
// descendant (checked with Git by the trusted validateRun port). Every receipt
// below is about that verified head, over the non-empty range gate.baseSha..run.headSha.
function boundGate(gate, run, gates, snapshot, contracts) {
  if (!gate || !run || typeof contracts.gateBindingFor !== 'function') return false;
  const stored = gates.find(row => row.id === gate.id);
  return (
    isDeepStrictEqual(stored, gate) &&
    gate.schemaVersion === 1 &&
    gate.installed === true &&
    gate.projectId === snapshot.project.projectId &&
    Number.isSafeInteger(gate.number) &&
    Array.isArray(gate.containers) &&
    gate.containers.length > 0 &&
    Array.isArray(gate.merges) &&
    gate.runId === run.id &&
    sha(gate.baseSha) &&
    sha(gate.headSha) &&
    sha(run.headSha) &&
    run.baseSha === gate.baseSha &&
    gate.baseSha !== gate.headSha &&
    run.headSha !== gate.baseSha &&
    gate.supersededBy === undefined &&
    // Byte-for-byte: the same schema-order binding the gate run was installed with.
    JSON.stringify(run.directorBinding) === JSON.stringify(contracts.gateBindingFor(gate))
  );
}

// The container whose acceptance this transition decides: a task's epic or the container itself.
function decidedContainer(snapshot, action, record) {
  if (!['attempt', 'task'].includes(action.kind)) return { kind: action.kind, id: action.id };
  const taskId = action.kind === 'attempt' ? record.taskId : record.id;
  const task = snapshot.tasks.find(row => row.id === taskId);
  return task ? { kind: 'epic', id: task.epicId } : null;
}

// A gate is superseded for container C only by a later gate that also contains C;
// a gate of a sibling epic sharing the milestone never replaces it for its own epic.
function superseded(gate, gates, container) {
  const key = containerKey(container);
  const contains = row => (row.containers || []).some(item => containerKey(item) === key);
  return (
    Boolean(container) &&
    contains(gate) &&
    gates.some(other => other.id !== gate.id && !(other.number < gate.number) && contains(other))
  );
}

// Every merge the gate verified must still be its task's current attempt.
function mergesCurrent(gate, snapshot) {
  const seen = new Set();
  return gate.merges.every(entry => {
    const current = currentOf(snapshot, entry?.taskId);
    if (!current || seen.has(entry.taskId)) return false;
    seen.add(entry.taskId);
    return entry.attemptId === current.id && entry.runId === current.runId && sha(entry.mergeCommit);
  });
}

// `configured` iff commands.smoke is non-empty; one passing row with its own
// log on the verified head for every configured command, in order.
function smokeComplete(run) {
  const smoke = run.smoke,
    commands = run.config?.commands?.smoke ?? [];
  if (
    !Array.isArray(commands) ||
    smoke?.schemaVersion !== 1 ||
    smoke.headSha !== run.headSha ||
    smoke.complete !== true ||
    smoke.configured !== commands.length > 0 ||
    !Array.isArray(smoke.results) ||
    smoke.results.length !== commands.length
  )
    return false;
  return commands.every((command, index) => {
    const row = smoke.results[index],
      log = row?.evidence;
    return (
      row?.exitCode === 0 &&
      row.command === command?.command &&
      isDeepStrictEqual(row.args, command.args ?? []) &&
      typeof log?.path === 'string' &&
      /^[a-f0-9]{64}$/.test(log.sha256) &&
      log.headSha === run.headSha &&
      row.outputPath === log.path &&
      row.outputHash === log.sha256
    );
  });
}

function gateRunCurrent(run) {
  return (
    run.state === 'succeeded' &&
    run.verificationProfile === undefined &&
    run.checks != null &&
    !Object.hasOwn(run.checks, 'profile') &&
    integrated(run) &&
    run.review?.passed === true &&
    run.review.headSha === run.headSha &&
    typeof run.review.diffHash === 'string' &&
    run.review.diffHash !== EMPTY_DIFF &&
    isCurrentBehaviorReceipt(run.behavior, { headSha: run.headSha, baseSha: run.baseSha, config: run.config }) &&
    gatesCurrent(run) &&
    smokeComplete(run)
  );
}

async function gateAcceptance({ action, record, ports }, run, criteria) {
  // Every presented ref must come from the gate run on the gate head; a task
  // run's checks/review never accept anything in wave cadence.
  if (!action.evidence.every(ref => ref?.runId === run.id && ref.headSha === run.headSha))
    return blocked(record, 'wave_gate_proof_missing');
  let evidence;
  try {
    await verify(ports.validateRun, run);
    evidence = await references(action.evidence, ports, run);
  } catch {
    return blocked(record, 'trusted_proof_invalid');
  }
  if (
    !gateRunCurrent(run) ||
    !hasProof(evidence, 'checks', run) ||
    !hasProof(evidence, 'review', run) ||
    !mapped(criteria, action.mappings, evidence)
  )
    return blocked(record, 'wave_gate_proof_missing');
  return result([...history(record), ...forward(record, ['accepted'])], [], evidence);
}

function dependencyCovered(id, snapshot, gate) {
  const dependency = snapshot.tasks.find(row => row.id === id);
  if (!dependency) return false;
  if (settled.has(dependency.status)) return true;
  const attempt = currentOf(snapshot, id);
  return Boolean(
    attempt && covers(gate, 'epic', dependency.epicId) && mergeOf(gate, attempt) && reached(dependency, 'integrated'),
  );
}

async function acceptTask(context, gate, run) {
  const { snapshot, action, record } = context;
  const attempt = action.kind === 'attempt' ? record : currentOf(snapshot, record.id);
  const task = snapshot.tasks.find(row => row.id === attempt?.taskId);
  if (!attempt || !task) return blocked(record, 'current_attempt_missing');
  if (!covers(gate, 'epic', task.epicId)) return blocked(record, 'wave_gate_missing');
  if (!mergesCurrent(gate, snapshot) || !mergeOf(gate, attempt)) return blocked(record, 'wave_merges_mismatch');
  if (!reached(attempt, 'integrated') || !reached(task, 'integrated'))
    return blocked(record, 'wave_integration_missing');
  if (!approved(task, snapshot)) return blocked(record, 'task_readiness_blocked');
  if (!task.dependsOn.every(id => dependencyCovered(id, snapshot, gate)))
    return blocked(record, 'wave_dependency_unaccepted');
  return gateAcceptance(context, run, task.acceptance);
}

async function acceptContainer(context, gate, run) {
  const { snapshot, action, record } = context;
  const children = childrenOf(snapshot, action.kind, record);
  if (!children?.length) return blocked(record, 'container_children_missing');
  if (!covers(gate, action.kind, action.id)) return blocked(record, 'wave_gate_missing');
  // An epic's tasks are accepted by this gate; milestone/project children may
  // have been accepted by earlier gates.
  if (
    !mergesCurrent(gate, snapshot) ||
    (action.kind === 'epic' &&
      !children.every(task => {
        const attempt = currentOf(snapshot, task.id);
        return attempt && mergeOf(gate, attempt);
      }))
  )
    return blocked(record, 'wave_merges_mismatch');
  if (!children.every(child => settled.has(child.status))) return blocked(record, 'children_not_accepted');
  // The finished product is always verified as a whole: the project is accepted
  // only by a gate whose verified head is the integration branch head now.
  if (action.kind === 'project' && context.input.integrationHead !== run.headSha)
    return blocked(record, 'wave_project_head_mismatch');
  return gateAcceptance(context, run, action.kind === 'project' ? record.definitionOfDone : record.acceptance);
}

async function acceptByGate(context) {
  const { snapshot, contracts, options, action, record, input, gates } = context;
  contracts.assertDirectorSafe({ run: input.run ?? null, gate: input.gate ?? null }, options);
  const run = input.run ? immutable(structuredClone(input.run)) : null;
  const gate = immutable(
    structuredClone(input.gate ?? gates.find(row => row.id === run?.directorBinding?.gateId) ?? null),
  );
  if (!boundGate(gate, run, gates, snapshot, contracts)) return blocked(record, 'wave_gate_missing');
  if (superseded(gate, gates, decidedContainer(snapshot, action, record)))
    return blocked(record, 'wave_gate_superseded');
  return ['attempt', 'task'].includes(action.kind)
    ? acceptTask(context, gate, run)
    : acceptContainer(context, gate, run);
}

// Same input/ports and result shape as evaluateProjectTransition, plus the
// optional gate record and `integrationHead` (the integration branch head the
// trusted caller read; required for project acceptance). Legacy (non-wave)
// snapshots authorize nothing here.
export async function evaluateWaveTransition(input, ports = {}) {
  let record;
  try {
    const prepared = await prepare(input.snapshot, ports),
      { snapshot, contracts, options } = prepared;
    if (typeof contracts.isWaveProject !== 'function' || contracts.isWaveProject(snapshot.project) !== true)
      return result([], ['wave_not_enabled']);
    const gates = gatesOf(snapshot);
    contracts.assertDirectorSafe(input.command, options);
    const command = immutable(structuredClone(contracts.normalizeDirectorRecord('command', input.command, options)));
    const action = command.action;
    if (
      command.projectId !== snapshot.project.projectId ||
      command.expectedRevision !== snapshot.revision ||
      action.op !== 'transition'
    )
      return blocked(null, 'transition_identity_invalid');
    record = recordFor(snapshot, action);
    if (!record || (action.kind === 'project' ? record.projectId : record.id) !== action.id)
      return blocked(null, 'transition_entity_missing');
    if (
      settled.has(record.status) &&
      ((record.status === 'released' && action.to !== 'released') || !settled.has(action.to))
    )
      return blocked(record, 'history_preserved');
    if (typeof contracts.assertProjectTransition === 'function')
      contracts.assertProjectTransition({
        record,
        to: action.to,
        snapshot,
        evidence: action.evidence,
        mappings: action.mappings,
      });
    if (controls(snapshot, record, input.run)) return blocked(record, 'project_control_blocked');
    // Wave publication is not defined yet; released stays with its own proof chain.
    if (!lifecycle.includes(action.to) || action.to === 'released')
      return blocked(record, 'unsupported_evidence_transition');
    const context = { ...prepared, action, record, input, ports, gates };
    if (action.to === 'accepted') return await acceptByGate(context);
    if (action.kind === 'task' && action.to === 'ready') return await readyTask(context);
    if (['attempt', 'task'].includes(action.kind)) return await integrateTask(context);
    return containerProgress(context);
  } catch {
    return blocked(record, 'project_transition_evidence_invalid');
  }
}
