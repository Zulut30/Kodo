const sets = ['milestones', 'epics', 'tasks', 'currentAttempts', 'riskApprovals'];
const accepted = status => status === 'accepted' || status === 'released';
const compareId = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const invalid = () => Object.assign(new Error('Invalid project horizon input or pure contract ports'), { code: 'invalid_project_horizon' });
const timestamp = value => typeof value === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{3})?Z$/.test(value) && Number.isFinite(Date.parse(value));
const synchronous = value => {
  if (value && typeof value.then === 'function') throw invalid();
  return value;
};

/**
 * Pure planning over one coherent, frozen Snapshot. The caller supplies actual
 * current availability/interface checks, the lower run limit and an explicit
 * clock. This function does not read Store, verify files, query providers, or
 * authorize lifecycle transitions. `order` ranks the entire bounded backlog;
 * only `taskIds` is the next horizon. No selected prerequisite unlocks a child.
 *
 * ports = { contracts: { assertDirectorSafe, normalizeDirectorRecord,
 *                       buildDirectorTaskInput }, knownValues: string[] }
 * All ports are synchronous pure A contracts, explicitly injected so importing
 * the planner never loads absent siblings or introduces default I/O.
 */
export function planProjectHorizon(input, ports) {
  const contracts = ports?.contracts;
  if (!Array.isArray(ports?.knownValues) || ports.knownValues.some(value => typeof value !== 'string')
    || !['assertDirectorSafe', 'normalizeDirectorRecord', 'buildDirectorTaskInput'].every(key => typeof contracts?.[key] === 'function')) throw invalid();
  const options = { knownValues: ports.knownValues };
  synchronous(contracts.assertDirectorSafe(input, options));
  if (!input || !Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 24 || !timestamp(input.now)) throw invalid();
  let snapshot, snapshotFailure;
  try {
    snapshot = synchronous(contracts.normalizeDirectorRecord('snapshot', input.snapshot, options));
  } catch (error) {
    if (error?.code !== 'project_revision') throw error;
    // A validates the full snapshot shape before its semantic revision checks.
    // Raw safety already passed; retain IDs only for a bounded denial projection.
    // Never filter approvals, repair revisions or plan from this invalid snapshot.
    snapshot = input.snapshot;
    snapshotFailure = 'snapshot_invalid:project_revision';
  }
  if (!snapshot || snapshot.schemaVersion !== 1 || !snapshot.project || !Number.isSafeInteger(snapshot.revision)
    || snapshot.revision < 1 || sets.some(key => !Array.isArray(snapshot[key])) || snapshot.tasks.length > 1000) throw invalid();
  const { project, tasks } = snapshot;
  const byId = new Map();
  for (const task of tasks) {
    if (!task || typeof task.id !== 'string' || !task.id || byId.has(task.id) || !Array.isArray(task.dependsOn)
      || !Number.isSafeInteger(task.estimatedEffort) || task.estimatedEffort < 1
      || !Number.isInteger(task.priority) || task.priority < 0 || task.priority > 100
      || !Number.isInteger(task.userValue) || task.userValue < 0 || task.userValue > 5
      || !Number.isInteger(task.risk) || task.risk < 0 || task.risk > 5) throw invalid();
    byId.set(task.id, task);
  }
  const result = { schemaVersion: 1, projectId: project.projectId, revision: snapshot.revision,
    taskIds: [], blocked: [], order: [], dryRun: true };
  const finish = () => {
    synchronous(contracts.assertDirectorSafe(result, options));
    return result;
  };
  const allBlocked = reasons => {
    result.order = [...byId.keys()].sort(compareId);
    result.blocked = result.order.map(taskId => ({ taskId, reasons: [...new Set(reasons)].sort(compareId) }));
    return finish();
  };
  if (snapshotFailure) return allBlocked([snapshotFailure]);
  const globalReasons = [];
  for (const key of sets) {
    const count = snapshot.completeness?.[key];
    // A coherent declaration of truncation is not a complete planning input.
    if (count?.complete === false && Number.isSafeInteger(count.total) && Number.isSafeInteger(count.returned)
      && count.returned === snapshot[key].length && count.total > count.returned) throw invalid();
    if (!count || count.complete !== true || !Number.isSafeInteger(count.total) || !Number.isSafeInteger(count.returned)
      || count.total !== count.returned || count.returned !== snapshot[key].length) globalReasons.push('snapshot_incomplete:' + key);
  }
  if (snapshot.revision !== project.revision) globalReasons.push('snapshot_revision_mismatch');
  const milestones = new Map(snapshot.milestones.map(value => [value.id, value]));
  const epics = new Map(snapshot.epics.map(value => [value.id, value]));
  if (milestones.size !== snapshot.milestones.length || epics.size !== snapshot.epics.length) globalReasons.push('snapshot_duplicate_parent');
  for (const key of ['milestones', 'epics', 'tasks', 'currentAttempts', 'riskApprovals']) {
    if (snapshot[key].some(value => value.projectId !== project.projectId)) globalReasons.push('snapshot_project_mismatch');
  }
  for (const epic of epics.values()) if (!milestones.has(epic.milestoneId)) globalReasons.push('milestone_missing:' + epic.milestoneId);
  for (const task of tasks) if (!epics.has(task.epicId)) globalReasons.push('epic_missing:' + task.epicId);
  if (globalReasons.length) return allBlocked(globalReasons);

  // Kahn ordering validates the complete graph before any task is considered.
  // Iteration is bounded by the complete <=1000-task snapshot, never a query.
  const children = new Map(tasks.map(task => [task.id, []]));
  const incoming = new Map(tasks.map(task => [task.id, task.dependsOn.length]));
  for (const task of tasks) {
    if (new Set(task.dependsOn).size !== task.dependsOn.length) globalReasons.push('dependency_duplicate:' + task.id);
    for (const id of task.dependsOn) {
      if (!byId.has(id)) globalReasons.push('dependency_missing:' + id);
      else children.get(id).push(task.id);
    }
  }
  if (globalReasons.length) return allBlocked(globalReasons.sort(compareId));
  const topological = tasks.filter(task => incoming.get(task.id) === 0).map(task => task.id);
  for (let index = 0; index < topological.length; index++) {
    for (const id of children.get(topological[index])) {
      incoming.set(id, incoming.get(id) - 1);
      if (incoming.get(id) === 0) topological.push(id);
    }
  }
  if (topological.length !== tasks.length) return allBlocked(['dependency_cycle']);
  const path = new Map(), unaccepted = new Map();
  for (const id of topological) {
    // Retain one stable witness of an unsatisfied transitive prerequisite.
    const witnesses = byId.get(id).dependsOn.flatMap(parent => [
      ...(!accepted(byId.get(parent).status) ? [parent] : []),
      ...(unaccepted.has(parent) ? [unaccepted.get(parent)] : [])
    ]).sort(compareId);
    if (witnesses.length) unaccepted.set(id, witnesses[0]);
  }
  for (const id of [...topological].reverse()) {
    let downstream = 0n;
    for (const child of children.get(id)) if (path.get(child) > downstream) downstream = path.get(child);
    // Individual efforts are safe integers; a whole path can exceed that range.
    path.set(id, (accepted(byId.get(id).status) ? 0n : BigInt(byId.get(id).estimatedEffort)) + downstream);
  }
  const ranked = [...tasks].sort((a, b) => compareId(path.get(b.id), path.get(a.id))
    || b.priority - a.priority || b.userValue - a.userValue || b.risk - a.risk
    || a.estimatedEffort - b.estimatedEffort || compareId(a.id, b.id));
  result.order = ranked.map(task => task.id);
  if (!Array.isArray(input.availability) || input.availability.length > 1000) throw invalid();
  const availability = new Map();
  for (const row of input.availability) {
    if (!row || Object.keys(row).sort().join(',') !== 'available,interfacesVerified,reason,taskId'
      || !byId.has(row.taskId) || availability.has(row.taskId) || typeof row.available !== 'boolean'
      || typeof row.interfacesVerified !== 'boolean' || !(row.reason === null || typeof row.reason === 'string')) throw invalid();
    availability.set(row.taskId, row);
  }
  const attempts = new Map();
  for (const attempt of snapshot.currentAttempts) {
    if (!byId.has(attempt.taskId) || attempts.has(attempt.taskId)) return allBlocked(['attempt_set_invalid']);
    attempts.set(attempt.taskId, attempt);
  }
  const approvals = new Map();
  for (const approval of snapshot.riskApprovals) {
    if (approvals.has(approval.taskId)) return allBlocked(['risk_approval_set_invalid']);
    approvals.set(approval.taskId, approval);
  }
  for (const task of ranked) {
    const reasons = [];
    if (project.paused) reasons.push('project_paused');
    if (!['proposed', 'ready', 'running', 'verifying', 'integrated'].includes(project.status)) reasons.push('project_' + project.status);
    const epic = epics.get(task.epicId), milestone = milestones.get(epic.milestoneId);
    if (['blocked', 'failed', 'cancelled', 'accepted', 'released'].includes(epic.status)) reasons.push('epic_' + epic.status);
    if (['blocked', 'failed', 'cancelled', 'accepted', 'released'].includes(milestone.status)) reasons.push('milestone_' + milestone.status);
    if (!['proposed', 'ready'].includes(task.status)) reasons.push('task_' + task.status);
    if (unaccepted.has(task.id)) reasons.push('dependency_not_accepted:' + unaccepted.get(task.id));
    const attempt = attempts.get(task.id);
    if (attempt) reasons.push(attempt.taskRevision !== task.revision ? 'attempt_revision_mismatch'
      : ['blocked', 'failed', 'cancelled'].includes(attempt.status) ? 'retry_required' : 'attempt_exists');
    // No required interfaces is valid; availability must still verify that set.
    if (!Array.isArray(task.interfaceRefs)) reasons.push('interfaces_missing');
    const row = availability.get(task.id);
    if (!row) reasons.push('availability_missing');
    else {
      if (!row.available) reasons.push('availability:' + (row.reason || 'unavailable'));
      if (!row.interfacesVerified) reasons.push('interfaces_unverified');
    }
    if (task.riskApprovalRequired) {
      const approval = approvals.get(task.id);
      if (!approval || approval.projectId !== project.projectId || approval.taskRevision !== task.revision
        || !timestamp(approval.approvedAt) || Date.parse(approval.approvedAt) > Date.parse(input.now)
        || !approval.actor?.trim() || !approval.reason?.trim()) reasons.push('risk_approval_required');
    }
    if (reasons.length === 0) {
      try {
        const text = synchronous(contracts.buildDirectorTaskInput({ project, task }, options));
        if (typeof text !== 'string') throw invalid();
        // Same mandatory 12,000-byte ceiling as task-context; full shared A
        // projection includes immutable project context, never just Task fields.
        if (Buffer.byteLength(text, 'utf8') > 12000) reasons.push('split_required');
      } catch (error) {
        if (['project_task_too_large', 'task_contract_too_large', 'split_required'].includes(error?.code)) reasons.push('split_required');
        else throw error;
      }
    }
    if (reasons.length === 0 && result.taskIds.length < input.limit) result.taskIds.push(task.id);
    else result.blocked.push({ taskId: task.id, reasons: reasons.length ? reasons : ['horizon_limit'] });
  }
  return finish();
}
