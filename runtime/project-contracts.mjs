import { createHash } from 'node:crypto';
import {
  MAX_BYTES,
  MAX_TASK_BYTES,
  MAX_ITEMS,
  states,
  settledStates,
  PREFIX,
  MAX_GATE_BYTES,
  MAX_REOPENED,
  GATE_PREFIX,
  fail,
  plain,
  assertDirectorSafe,
  object,
  member,
  list,
  refs,
  mappings,
  gateContainerCriteriaRow,
  mapped,
  assertContainersFilled,
  assertEpicsAcyclic,
  snapshot,
  action,
  normalize,
  normalizeDirectorRecord,
  isWaveProject,
} from './project-contracts-normalize.mjs';
export {
  assertDirectorSafe,
  epicCycle,
  emptyContainers,
  normalizeDirectorRecord,
  normalizeProjectSpec,
  isWaveProject,
} from './project-contracts-normalize.mjs';

export function directorBytes(kind, input, options) {
  const bytes = Buffer.from(JSON.stringify(normalizeDirectorRecord(kind, input, options)), 'utf8');
  if (bytes.length > MAX_BYTES) fail('project_limit');
  if (
    ['taskContract', 'taskRunInput'].includes(kind) &&
    bytes.length + (kind === 'taskRunInput' ? Buffer.byteLength(PREFIX) : 0) > MAX_TASK_BYTES
  )
    fail('project_task_too_large');
  if (kind === 'gateRunInput' && bytes.length + Buffer.byteLength(GATE_PREFIX) > MAX_GATE_BYTES)
    fail('project_gate_too_large');
  return bytes;
}
/** Whether a prerequisite in `status` admits dependants to ready/running. */
export function dependencySatisfied(project, status) {
  return (isWaveProject(project) ? ['integrated', 'accepted', 'released'] : ['accepted', 'released']).includes(status);
}
function contract(task) {
  return {
    schemaVersion: 1,
    projectId: task.projectId,
    taskId: task.id,
    taskRevision: task.revision,
    description: task.description,
    owner: task.owner,
    dependsOn: task.dependsOn,
    writePaths: task.writePaths,
    acceptance: task.acceptance,
    interfaceRefs: task.interfaceRefs,
  };
}
export function directorContractHash(storedTask, options) {
  const task = normalizeDirectorRecord('task', storedTask, options);
  return createHash('sha256')
    .update(directorBytes('taskContract', contract(task), options))
    .digest('hex');
}
export function buildDirectorTaskInput(input, options) {
  assertDirectorSafe(input, options);
  const { project, task } = object(input, {
    project: v => normalizeDirectorRecord('project', v, options),
    task: v => normalizeDirectorRecord('task', v, options),
  });
  if (project.projectId !== task.projectId) fail('project_identity');
  const projectContext = contextOf(project);
  return (
    PREFIX +
    directorBytes('taskRunInput', { schemaVersion: 1, projectContext, task: contract(task) }, options).toString('utf8')
  );
}
// The frozen Run input is already validated. Only the worker-facing copy changes location.
export function portableDirectorTaskInput(input, referencePath) {
  if (!input.startsWith(PREFIX)) fail('project_binding_invalid');
  const payload = JSON.parse(input.slice(PREFIX.length));
  payload.projectContext.root = '.';
  for (const ref of [...payload.projectContext.architectureRefs, ...payload.task.interfaceRefs])
    ref.path = referencePath(ref);
  return PREFIX + JSON.stringify(payload);
}

/** The frozen ProjectTask writePaths of a task Run input (`buildDirectorTaskInput`). */
export function directorTaskWritePaths(text, options) {
  if (typeof text !== 'string' || !text.startsWith(PREFIX)) fail('project_binding_invalid');
  const input = normalizeDirectorRecord('taskRunInput', JSON.parse(text.slice(PREFIX.length)), options);
  return [...input.task.writePaths];
}
// Immutable project context shared by task and gate inputs; never `execution`.
function contextOf(project) {
  return {
    projectId: project.projectId,
    id: project.id,
    root: project.root,
    title: project.title,
    definitionOfDone: project.definitionOfDone,
    constraints: project.constraints,
    businessContext: project.businessContext,
    architectureRefs: project.architectureRefs,
  };
}
/** The gate manifest: frozen contracts of every covered task in `gate.merges` order with the
 * project context, the gate range and the acceptance criteria of the covered containers
 * (input `{project, gate, tasks, containers: gateContainerCriteria(snapshot, gate)}`, schema 2).
 * It is kept as an immutable evidence artifact of the
 * gate Run (kind `gate-manifest`); `sha256` covers its canonical bytes and is bound into
 * the gate input. Returns `{ manifest, sha256, bytes }`. */
export function buildGateManifest(input, options = { knownValues: [] }) {
  const body = gateManifestBody(input, options);
  const encoded = directorBytes('gateManifest', body, options);
  return {
    manifest: JSON.parse(encoded.toString('utf8')),
    sha256: createHash('sha256').update(encoded).digest('hex'),
    bytes: encoded.length,
  };
}
/** Exact Run task text for a wave integration gate: a compact summary (containers, task count,
 * base/head) bound to the gate manifest by its SHA-256. Options default to no known values. */
export function buildGateInput(input, options = { knownValues: [] }) {
  const { manifest, sha256, bytes } = buildGateManifest(input, options);
  const body = {
    schemaVersion: 2,
    projectId: manifest.projectContext.projectId,
    gate: manifest.gate,
    taskCount: manifest.tasks.length,
    manifest: { kind: 'gate-manifest', sha256, bytes },
  };
  return GATE_PREFIX + directorBytes('gateRunInput', body, options).toString('utf8');
}
function gateManifestBody(input, options) {
  assertDirectorSafe(input, options);
  const { project, gate, tasks, containers } = object(input, {
    project: v => normalizeDirectorRecord('project', v, options),
    gate: v => normalizeDirectorRecord('gate', v, options),
    tasks: v =>
      list(
        v,
        x => normalizeDirectorRecord('task', x, options),
        t => t.id,
        1,
      ),
    containers: v => list(v, gateContainerCriteriaRow, c => c.kind, 1),
  });
  if (!isWaveProject(project)) fail('project_gate_unsupported');
  const byId = new Map(tasks.map(t => [t.id, t]));
  if (
    gate.projectId !== project.projectId ||
    tasks.some(t => t.projectId !== project.projectId) ||
    byId.size !== gate.merges.length ||
    gate.merges.some(m => !byId.has(m.taskId)) ||
    containers.some(
      (c, i) =>
        c.kind !== gate.containers[i]?.kind ||
        c.id !== gate.containers[i].id ||
        (c.kind === 'project' && JSON.stringify(c.criteria) !== JSON.stringify(project.definitionOfDone)),
    ) ||
    containers.length !== gate.containers.length
  )
    fail('project_identity');
  return {
    schemaVersion: 2,
    projectContext: contextOf(project),
    ...(gate.provenance ? { provenance: gate.provenance } : {}),
    gate: { containers: gate.containers, baseSha: gate.baseSha, headSha: gate.headSha },
    containers,
    tasks: gate.merges.map(m => contract(byId.get(m.taskId))),
  };
}
/** The acceptance criteria of a gate's containers from the snapshot records, narrowest first
 * (`containers` of buildGateManifest/buildGateInput): an epic's and a milestone's `acceptance`,
 * the project's `definitionOfDone`. A missing record leaves `criteria` undefined (refused). */
export function gateContainerCriteria(snapshot, gate) {
  return gate.containers.map(c => ({
    kind: c.kind,
    id: c.id,
    criteria:
      c.kind === 'project'
        ? snapshot.project.definitionOfDone
        : snapshot[`${c.kind}s`]?.find(row => row.id === c.id)?.acceptance,
  }));
}
/** The criteria a gate review confirms one by one (`review.criteria[].id`): every criterion of
 * the covered containers (`<kind>:<id>:<criterion>`) and tasks (`task:<taskId>:<criterion>`). */
export function gateReviewCriteria(manifest) {
  return [
    ...manifest.containers.flatMap(c => c.criteria.map(x => ({ id: `${c.kind}:${c.id}:${x.id}`, text: x.text }))),
    ...manifest.tasks.flatMap(t => t.acceptance.map(x => ({ id: `task:${t.taskId}:${x.id}`, text: x.text }))),
  ];
}
/** Install binding for a gate Run; mergesHash covers the canonical merges JSON. */
export function gateBindingFor(input, options = { knownValues: [] }) {
  const gate = normalizeDirectorRecord('gate', input, options);
  return normalizeDirectorRecord(
    'gateBinding',
    {
      schemaVersion: 1,
      kind: 'gate',
      projectId: gate.projectId,
      gateId: gate.id,
      number: gate.number,
      runId: gate.runId,
      baseSha: gate.baseSha,
      headSha: gate.headSha,
      ...(gate.provenance ? { provenance: gate.provenance } : {}),
      mergesHash: createHash('sha256').update(JSON.stringify(gate.merges)).digest('hex'),
    },
    options,
  );
}

/** Whether appendMilestone may reopen the project of a snapshot: a closed (accepted/released),
 * unpaused wave project with a complete snapshot, settled current attempts and reopens left.
 * Shared by assertProjectReopen and the early check of `kodo project extend`. */
export function projectReopenable(s) {
  const p = s.project;
  return (
    isWaveProject(p) &&
    ['accepted', 'released'].includes(p.status) &&
    !p.paused &&
    Object.values(s.completeness).every(c => c.complete) &&
    s.currentAttempts.every(r => settledStates.includes(r.status)) &&
    (p.reopened?.length ?? 0) < MAX_REOPENED
  );
}

/** Pure appendMilestone check: a closed wave project accepts one new milestone
 * whose epics/tasks are new and whose dependencies are new or closed tasks. */
export function assertProjectReopen(input) {
  assertDirectorSafe(input, { knownValues: [] });
  const { snapshot: s, action: a } = object(input, { snapshot, action });
  if (a.op !== 'appendMilestone') fail();
  if (!projectReopenable(s)) fail('project_append_blocked');
  const taken = key => new Set(s[key].map(r => r.id));
  const [milestones, epics, tasks] = ['milestones', 'epics', 'tasks'].map(taken);
  if (milestones.has(a.milestone.id) || a.epics.some(e => epics.has(e.id)) || a.tasks.some(t => tasks.has(t.id)))
    fail('project_identity_conflict');
  const added = new Set(a.epics.map(e => e.id));
  if (a.epics.some(e => e.milestoneId !== a.milestone.id) || a.tasks.some(t => !added.has(t.epicId)))
    fail('project_parent_invalid');
  const fresh = new Map(a.tasks.map(t => [t.id, t]));
  const closed = id => s.tasks.some(d => d.id === id && ['accepted', 'released'].includes(d.status));
  if (a.tasks.some(t => t.dependsOn.some(id => !fresh.has(id) && !closed(id)))) fail('project_dependency_invalid');
  const state = new Map();
  const visit = id => {
    if (state.get(id) === 'active') fail('project_dependency_invalid');
    if (state.has(id) || !fresh.has(id)) return;
    state.set(id, 'active');
    for (const dep of fresh.get(id).dependsOn) visit(dep);
    state.set(id, 'done');
  };
  for (const id of fresh.keys()) visit(id);
  // The new milestone and each new epic hold work: an empty one would never be gated.
  assertContainersFilled([a.milestone], a.epics, a.tasks);
  assertEpicsAcyclic([...s.epics, ...a.epics], [...s.tasks, ...a.tasks]);
  if (s.tasks.length + a.tasks.length > MAX_ITEMS || s.epics.length + a.epics.length > MAX_ITEMS) fail('project_limit');
}

/** Structural lifecycle checks are NOT trusted evidence authorization. Store
 * additionally invokes the coordinator's authorizer for every forward edge. */
// oxlint-disable-next-line complexity -- debt: docs/kodo-roadmap/MAINTAINABILITY-PLAN.md
export function assertProjectTransition(input) {
  // This API has no credential options; external callers guard the full command
  // with their known values before invoking structural transition validation.
  assertDirectorSafe(input, { knownValues: [] });
  const v = object(input, { record: plain, to: member([...states, 'reserved']), snapshot, evidence: refs, mappings });
  const s = v.snapshot,
    raw = v.record;
  let kind, current;
  if (raw.projectId !== s.project.projectId) fail('project_identity');
  if (Object.hasOwn(raw, 'projectKey')) {
    kind = 'project';
    current = s.project;
  } else if (Object.hasOwn(raw, 'taskRevision')) {
    kind = 'attempt';
    current = s.currentAttempts.find(r => r.id === raw.id);
  } else if (Object.hasOwn(raw, 'epicId')) {
    kind = 'task';
    current = s.tasks.find(r => r.id === raw.id);
  } else if (Object.hasOwn(raw, 'milestoneId')) {
    kind = 'epic';
    current = s.epics.find(r => r.id === raw.id);
  } else {
    kind = 'milestone';
    current = s.milestones.find(r => r.id === raw.id);
  }
  const r = normalize[kind](raw);
  if (!current || JSON.stringify(r) !== JSON.stringify(current)) fail('project_revision');
  const next = {
    proposed: 'ready',
    ready: 'running',
    reserved: 'running',
    running: 'verifying',
    verifying: 'integrated',
    integrated: 'accepted',
    accepted: 'released',
  };
  const exceptional = ['blocked', 'failed', 'cancelled'];
  if (r.status === v.to || r.status === 'released' || (r.status === 'accepted' && v.to !== 'released'))
    fail('project_transition');
  if (
    next[r.status] !== v.to &&
    !(exceptional.includes(v.to) && !['accepted', 'released', 'cancelled'].includes(r.status)) &&
    !(exceptional.includes(r.status) && r.status !== 'cancelled' && v.to === (kind === 'attempt' ? 'running' : 'ready'))
  )
    fail('project_transition');
  if (
    ['ready', 'running', 'verifying', 'integrated', 'accepted', 'released'].includes(v.to) &&
    (s.project.paused || ['cancelled', 'failed'].includes(s.project.status))
  )
    fail('project_control');
  const t = kind === 'task' ? r : kind === 'attempt' ? s.tasks.find(t => t.id === r.taskId) : null;
  if (['ready', 'running', 'verifying', 'integrated', 'accepted', 'released'].includes(v.to)) {
    if (Object.values(s.completeness).some(c => !c.complete)) fail('project_completeness');
    if (kind === 'attempt' && (!t || r.taskRevision !== t.revision)) fail('project_revision');
  }
  const ownCriteria = kind === 'project' ? r.definitionOfDone : kind === 'attempt' ? t?.acceptance || [] : r.acceptance;
  mapped({ evidence: [...r.evidence, ...v.evidence], mappings: v.mappings }, ownCriteria);
  if (['ready', 'running'].includes(v.to) && t) {
    if (
      !s.completeness.tasks.complete ||
      t.dependsOn.some(id => !s.tasks.some(d => d.id === id && dependencySatisfied(s.project, d.status)))
    )
      fail('project_dependency');
    if (t.riskApprovalRequired && !s.riskApprovals.some(a => a.taskId === t.id && a.taskRevision === t.revision))
      fail('project_risk');
  }
  if (!['accepted', 'released'].includes(v.to)) return;
  if (Object.values(s.completeness).some(c => !c.complete)) fail('project_completeness');
  const milestoneEpics = kind === 'milestone' ? s.epics.filter(e => e.milestoneId === r.id) : [];
  const children =
    kind === 'project'
      ? [...s.milestones, ...s.epics, ...s.tasks]
      : kind === 'milestone'
        ? [...milestoneEpics, ...s.tasks.filter(t => milestoneEpics.some(e => e.id === t.epicId))]
        : kind === 'epic'
          ? s.tasks.filter(t => t.epicId === r.id)
          : [];
  if (children.some(c => !['accepted', 'released'].includes(c.status))) fail('project_children');
  if (v.to === 'released' && kind === 'project' && s.milestones.some(m => m.releaseRequired && m.status !== 'released'))
    fail('project_children');
  const evidence = new Map([...r.evidence, ...v.evidence].map(ref => [ref.sha256, ref]));
  const ownMappings = new Map([...(r.mappings || []), ...v.mappings].map(m => [m.criterionId, m]));
  if (v.to === 'accepted')
    for (const c of ownCriteria) {
      const m = ownMappings.get(c.id);
      if (
        !m ||
        m.refs.some(id => !evidence.has(id)) ||
        c.evidenceKinds.some(k => !m.refs.some(id => evidence.get(id)?.kind === k))
      )
        fail('project_mapping');
    }
  if (v.to === 'released' && ![...evidence.values()].some(r => r.kind === 'release')) fail('project_evidence');
}
