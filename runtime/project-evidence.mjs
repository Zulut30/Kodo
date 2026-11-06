import { isDeepStrictEqual } from 'node:util';

// This module consumes proof. It never executes providers, commands or gates.
// verifyRef and validateRun are trusted read-only, throw-on-invalid ports. In
// production the coordinator supplies current HEAD/config/pin/evidence checks.
const lifecycle = ['proposed', 'ready', 'running', 'verifying', 'integrated', 'accepted', 'released'];
const settled = new Set(['accepted', 'released']);
const sets = ['milestones', 'epics', 'tasks', 'currentAttempts', 'riskApprovals'];
const sha = value => typeof value === 'string' && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value);
const digest = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const result = (eligibleStates = [], blockers = [], evidence = []) => ({
  schemaVersion: 1,
  eligibleStates: [...new Set(eligibleStates)],
  blockers: [...new Set(blockers)],
  evidence,
});
const history = record => (settled.has(record?.status) ? [record.status] : []);
const blocked = (record, code) => result(history(record), [code]);
const forward = (record, states) =>
  states.filter(state => lifecycle.indexOf(state) >= lifecycle.indexOf(record.status));
function immutable(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const nested of Object.values(value)) immutable(nested);
  }
  return value;
}
async function prepare(snapshot, ports) {
  const contracts = ports.contracts || (await import('./project-contracts.mjs'));
  const options = { knownValues: ports.knownValues ?? [] };
  if (typeof contracts.normalizeDirectorRecord !== 'function' || typeof contracts.assertDirectorSafe !== 'function')
    throw Error('contracts');
  contracts.assertDirectorSafe(snapshot, options);
  const normalized = contracts.normalizeDirectorRecord('snapshot', snapshot, options);
  assertComplete(normalized);
  return { snapshot: immutable(structuredClone(normalized)), contracts, options };
}
function assertComplete(snapshot) {
  if (snapshot?.schemaVersion !== 1 || !snapshot.project?.projectId || snapshot.revision !== snapshot.project.revision)
    throw Error('snapshot');
  const projectId = snapshot.project.projectId;
  for (const key of sets) {
    const rows = snapshot[key],
      count = snapshot.completeness?.[key];
    if (
      !Array.isArray(rows) ||
      !count ||
      count.complete !== true ||
      !Number.isSafeInteger(count.total) ||
      count.total < 0 ||
      count.total !== rows.length ||
      count.returned !== rows.length
    )
      throw Error('incomplete');
    const ids = new Set();
    for (const row of rows) {
      const id = ['currentAttempts', 'riskApprovals'].includes(key) ? row.taskId : row.id;
      if (!id || row.projectId !== projectId || ids.has(id)) throw Error('identity');
      ids.add(id);
    }
  }
  if (
    snapshot.epics.some(row => !snapshot.milestones.some(parent => parent.id === row.milestoneId)) ||
    snapshot.tasks.some(row => !snapshot.epics.some(parent => parent.id === row.epicId))
  )
    throw Error('parent');
  if (
    snapshot.currentAttempts.some(row => !snapshot.tasks.some(task => task.id === row.taskId)) ||
    snapshot.riskApprovals.some(
      row => !snapshot.tasks.some(task => task.id === row.taskId && task.revision === row.taskRevision),
    )
  )
    throw Error('current');
}
async function verify(port, value) {
  if (typeof port !== 'function' || (await port(value)) !== undefined) throw Error('unverified');
}
async function references(refs, ports, run) {
  if (!Array.isArray(refs)) throw Error('refs');
  const unique = new Map();
  for (const ref of refs) {
    if (!digest(ref?.sha256)) throw Error('ref');
    if (unique.has(ref.sha256)) {
      if (!isDeepStrictEqual(unique.get(ref.sha256), ref)) throw Error('conflict');
      continue;
    }
    const expectedHead = ['delivery', 'release'].includes(ref.kind) ? run?.delivery?.mergeCommit : run?.headSha;
    if (
      run &&
      ref.kind !== 'interface' &&
      ((ref.runId !== null && ref.runId !== run.id) || (ref.headSha !== null && ref.headSha !== expectedHead))
    )
      throw Error('stale');
    const copy = immutable(structuredClone(ref));
    await verify(ports.verifyRef, copy);
    unique.set(ref.sha256, copy);
  }
  return [...unique.values()];
}
function mapped(criteria, mappings, evidence) {
  if (!Array.isArray(criteria) || !criteria.length || !Array.isArray(mappings)) return false;
  const byHash = new Map(evidence.map(ref => [ref.sha256, ref]));
  const ids = new Set(criteria.map(item => item.id));
  if (
    mappings.some(mapping => !ids.has(mapping.criterionId)) ||
    new Set(mappings.map(mapping => mapping.criterionId)).size !== mappings.length
  )
    return false;
  return criteria.every(criterion => {
    const mapping = mappings.find(item => item.criterionId === criterion.id);
    if (
      !mapping ||
      !Array.isArray(mapping.refs) ||
      !mapping.refs.length ||
      !mapping.actor?.trim() ||
      !mapping.reason?.trim() ||
      mapping.refs.some(hash => !byHash.has(hash))
    )
      return false;
    return (
      Array.isArray(criterion.evidenceKinds) &&
      criterion.evidenceKinds.length > 0 &&
      criterion.evidenceKinds.every(kind => mapping.refs.some(hash => byHash.get(hash).kind === kind))
    );
  });
}
function hasProof(evidence, kind, run) {
  const expectedHead = ['delivery', 'release'].includes(kind) ? run?.delivery?.mergeCommit : run?.headSha;
  return evidence.some(
    ref =>
      ref.kind === kind &&
      sha(ref.headSha) &&
      (!run || (ref.headSha === expectedHead && (ref.runId === null || ref.runId === run.id))),
  );
}
function checksCurrent(run) {
  const commands = run.config?.commands;
  if (!Array.isArray(commands?.test) || !commands.test.length || !Array.isArray(commands.build)) return false;
  const expected = ['test', 'build'].flatMap(kind => commands[kind].map(command => ({ kind, command })));
  const receipt = run.checks;
  return (
    receipt?.schemaVersion === 2 &&
    receipt.complete === true &&
    receipt.headSha === run.headSha &&
    Array.isArray(receipt.results) &&
    receipt.results.length === expected.length &&
    receipt.results.every(
      (row, i) =>
        row.exitCode === 0 && row.kind === expected[i].kind && isDeepStrictEqual(row.command, expected[i].command),
    )
  );
}
function gatesCurrent(run) {
  for (const [field, config] of [
    ['uiVerification', 'uiVerification'],
    ['securityChecks', 'security'],
    ['architectureChecks', 'architecture'],
  ]) {
    const setting = run.config?.[config];
    // Missing configuration is unknown. Disabled is neutral, never a pass.
    if (typeof setting?.enabled !== 'boolean') return false;
    if (!setting.enabled) continue;
    if (run[field]?.status !== 'passed' || run[field]?.passed !== true || run[field]?.headSha !== run.headSha)
      return false;
  }
  return true;
}
function integrated(run) {
  return (
    ['testing', 'verifying', 'delivering', 'releasing', 'succeeded'].includes(run.state) &&
    Array.isArray(run.plan?.tasks) &&
    run.plan.tasks.length > 0 &&
    run.plan.tasks.every(task => run.nodes?.[task.id]?.status === 'integrated') &&
    checksCurrent(run)
  );
}
function publication(run, evidence) {
  return (
    run.release?.published === true &&
    sha(run.delivery?.mergeCommit) &&
    run.release.commit === run.delivery.mergeCommit &&
    digest(run.release.sha256) &&
    hasProof(evidence, 'delivery', run) &&
    hasProof(evidence, 'release', run)
  );
}
function ready(task, snapshot) {
  return (
    Array.isArray(task.dependsOn) &&
    task.dependsOn.every(id => snapshot.tasks.some(dep => dep.id === id && settled.has(dep.status))) &&
    (!task.riskApprovalRequired ||
      snapshot.riskApprovals.some(row => row.taskId === task.id && row.taskRevision === task.revision))
  );
}
function controls(snapshot, record, run) {
  return (
    snapshot.project.paused === true ||
    ['cancelled', 'failed', 'blocked'].includes(snapshot.project.status) ||
    ['cancelled', 'failed', 'blocked'].includes(record.status) ||
    run?.cancelRequested === true ||
    ['cancelled', 'failed', 'blocked', 'waiting_limits'].includes(run?.state)
  );
}
function bindingMatches(snapshot, attempt, run) {
  const task = snapshot.tasks.find(row => row.id === attempt.taskId);
  const current = snapshot.currentAttempts.find(row => row.taskId === attempt.taskId);
  const binding = run?.directorBinding;
  return (
    task &&
    current &&
    isDeepStrictEqual(current, attempt) &&
    task.revision === attempt.taskRevision &&
    attempt.projectId === snapshot.project.projectId &&
    run?.id === attempt.runId &&
    binding?.projectId === attempt.projectId &&
    binding?.taskId === attempt.taskId &&
    binding?.taskRevision === attempt.taskRevision &&
    binding?.attemptId === attempt.id &&
    binding?.runId === attempt.runId &&
    binding?.contractHash === attempt.contractHash &&
    sha(run.headSha) &&
    (attempt.headSha === null || attempt.headSha === run.headSha)
  );
}
async function evaluateAttempt(input, ports, prepared, commandEvidence = [], target, requestedState) {
  const { snapshot } = prepared;
  prepared.contracts.assertDirectorSafe(input.attempt, prepared.options);
  prepared.contracts.assertDirectorSafe(input.run, prepared.options);
  prepared.contracts.assertDirectorSafe(input.mappings, prepared.options);
  const mappings = immutable(structuredClone(input.mappings));
  const attempt = immutable(
    structuredClone(prepared.contracts.normalizeDirectorRecord('attempt', input.attempt, prepared.options)),
  );
  target ??= snapshot.currentAttempts.find(row => row.id === attempt.id && row.taskId === attempt.taskId);
  if (!bindingMatches(snapshot, attempt, input.run)) return blocked(target, 'attempt_binding_invalid');
  if (controls(snapshot, attempt, input.run) || controls(snapshot, target, input.run))
    return blocked(target, 'project_control_blocked');
  const task = snapshot.tasks.find(row => row.id === attempt.taskId);
  if (!ready(task, snapshot)) return blocked(target, 'task_readiness_blocked');
  const run = immutable(structuredClone(input.run));
  let evidence;
  try {
    await verify(ports.validateRun, run);
    await references(task.interfaceRefs, ports);
    evidence = await references([...attempt.evidence, ...commandEvidence], ports, run);
  } catch {
    return blocked(target, 'trusted_proof_invalid');
  }
  const states = [],
    blockers = [];
  if (['executing', 'testing', 'verifying', 'delivering', 'releasing', 'succeeded'].includes(run.state))
    states.push('running');
  if (['testing', 'verifying', 'delivering', 'releasing', 'succeeded'].includes(run.state)) states.push('verifying');
  if (integrated(run) && hasProof(evidence, 'checks', run)) states.push('integrated');
  else blockers.push('integration_or_checks_missing');
  const accepted =
    states.includes('integrated') &&
    run.review?.passed === true &&
    run.review.headSha === run.headSha &&
    gatesCurrent(run) &&
    hasProof(evidence, 'review', run) &&
    mapped(task.acceptance, mappings, evidence);
  if (accepted) states.push('accepted');
  else blockers.push('acceptance_proof_missing');
  if (accepted && publication(run, evidence)) states.push('released');
  else if (requestedState === 'released') blockers.push('publication_proof_missing');
  return result([...history(target), ...forward(target, states)], blockers, evidence);
}

export async function evaluateProjectAttempt(input, ports = {}) {
  try {
    return await evaluateAttempt(input, ports, await prepare(input.snapshot, ports));
  } catch {
    return blocked(null, 'project_evidence_invalid');
  }
}

// Evaluate the actual command against a coherent stored snapshot. No eligibility
// or verification flags from the command are consumed.
export async function evaluateProjectTransition(input, ports = {}) {
  let record;
  try {
    const prepared = await prepare(input.snapshot, ports),
      { snapshot, contracts, options } = prepared;
    contracts.assertDirectorSafe(input.command, options);
    const command = immutable(structuredClone(contracts.normalizeDirectorRecord('command', input.command, options)));
    const action = command.action;
    if (
      command.projectId !== snapshot.project.projectId ||
      command.expectedRevision !== snapshot.revision ||
      action.op !== 'transition'
    )
      return blocked(null, 'transition_identity_invalid');
    record =
      action.kind === 'project'
        ? snapshot.project
        : action.kind === 'attempt'
          ? snapshot.currentAttempts.find(row => row.id === action.id)
          : snapshot[`${action.kind}s`]?.find(row => row.id === action.id);
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
    if (!lifecycle.includes(action.to)) return blocked(record, 'unsupported_evidence_transition');
    if (action.kind === 'task' && action.to === 'ready') {
      if (!ready(record, snapshot)) return blocked(record, 'task_readiness_blocked');
      await references(record.interfaceRefs, ports);
      return result(['ready']);
    }
    if (['attempt', 'task'].includes(action.kind)) {
      const current =
        action.kind === 'attempt' ? record : snapshot.currentAttempts.find(row => row.taskId === record.id);
      if (!current) return blocked(record, 'current_attempt_missing');
      // Command evidence is checked as part of this authorization, never saved
      // as a new attempt or mistaken for a different current reservation.
      return await evaluateAttempt(
        { ...input, attempt: current, mappings: action.mappings },
        ports,
        prepared,
        action.evidence,
        record,
        action.to,
      );
    }
    const children =
      action.kind === 'project'
        ? snapshot.milestones
        : action.kind === 'milestone'
          ? snapshot.epics.filter(row => row.milestoneId === record.id)
          : action.kind === 'epic'
            ? snapshot.tasks.filter(row => row.epicId === record.id)
            : null;
    if (!children?.length) return blocked(record, 'container_children_missing');
    const allAccepted = children.every(child => settled.has(child.status));
    if (['accepted', 'released'].includes(action.to) && !allAccepted) return blocked(record, 'children_not_accepted');
    contracts.assertDirectorSafe(input.run, options);
    const run = immutable(structuredClone(input.run));
    const attempt = snapshot.currentAttempts.find(row => row.runId === run?.id);
    const task = snapshot.tasks.find(row => row.id === attempt?.taskId);
    const epic = snapshot.epics.find(row => row.id === task?.epicId);
    const inSubtree =
      task &&
      (action.kind === 'project' ||
        (action.kind === 'milestone' && epic?.milestoneId === record.id) ||
        (action.kind === 'epic' && task.epicId === record.id));
    if (!attempt || !bindingMatches(snapshot, attempt, run) || !inSubtree)
      return blocked(record, 'attempt_binding_invalid');
    await verify(ports.validateRun, run);
    const evidence = await references([...record.evidence, ...action.evidence], ports, run);
    const states = [];
    if (children.every(child => lifecycle.indexOf(child.status) >= lifecycle.indexOf('ready'))) states.push('ready');
    if (['executing', 'testing', 'verifying', 'delivering', 'releasing', 'succeeded'].includes(run.state))
      states.push('running');
    if (['testing', 'verifying', 'delivering', 'releasing', 'succeeded'].includes(run.state)) states.push('verifying');
    if (
      children.every(child => lifecycle.indexOf(child.status) >= lifecycle.indexOf('integrated')) &&
      integrated(run) &&
      hasProof(evidence, 'checks', run)
    )
      states.push('integrated');
    if (!['accepted', 'released'].includes(action.to))
      return result(
        [...history(record), ...forward(record, states)],
        states.includes(action.to) ? [] : ['container_progress_unverified'],
        evidence,
      );
    if (!integrated(run) || run.review?.passed !== true || run.review.headSha !== run.headSha || !gatesCurrent(run))
      return blocked(record, 'current_run_proof_missing');
    const criteria = action.kind === 'project' ? record.definitionOfDone : record.acceptance;
    if (
      !mapped(criteria, action.mappings, evidence) ||
      !hasProof(evidence, 'checks', run) ||
      !hasProof(evidence, 'review', run)
    )
      return blocked(record, 'container_own_proof_missing');
    states.push('accepted');
    const required =
      action.kind === 'project'
        ? snapshot.milestones.filter(row => row.releaseRequired)
        : action.kind === 'milestone' && record.releaseRequired
          ? [record]
          : [];
    const requiredReleased = required.every(
      row => (row.id === record.id && action.kind === 'milestone') || row.status === 'released',
    );
    if (requiredReleased && publication(run, evidence)) states.push('released');
    return result(
      [...history(record), ...forward(record, states)],
      states.includes(action.to) ? [] : ['publication_proof_missing'],
      evidence,
    );
  } catch {
    return blocked(record, 'project_transition_evidence_invalid');
  }
}
