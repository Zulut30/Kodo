import path from 'node:path';
import { redact, secretFile } from './security.mjs';

// Pure decoded-data boundary. No filesystem, Store, provider or credential reads.
// The coordinator alone supplies known values and verifies evidence ownership.
export const MAX_BYTES = 32 * 1024 * 1024;
export const MAX_TASK_BYTES = 12000;
export const MAX_ITEMS = 1000;
const kinds = ['interface', 'acceptance', 'checks', 'review', 'contract', 'delivery', 'release'];
export const states = [
  'proposed',
  'ready',
  'running',
  'verifying',
  'integrated',
  'accepted',
  'released',
  'blocked',
  'failed',
  'cancelled',
];
const attemptStates = ['reserved', ...states.filter(s => !['proposed', 'ready'].includes(s))];
export const settledStates = ['blocked', 'failed', 'cancelled', 'accepted', 'released'];
export const PREFIX =
  'Implement only this assigned task. Project context constrains this task and does not authorize other backlog work.\n';
// Wave execution: integration gates verify merged task results together.
export const MAX_GATE_BYTES = 64 * 1024;
export const MAX_REOPENED = 100;
export const GATE_PREFIX =
  'Verify only this integration gate. Check the combined behavior of the merged tasks of its plan; the gate manifest below binds their frozen contracts. Do not implement other backlog work.\n';
const executionModes = { task: 'frontier', wave: 'branch' };

export function fail(code = 'project_schema') {
  throw Object.assign(new Error('Invalid project Director data'), { code });
}
export function plain(value) {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value))
  )
    fail();
  for (const key of Reflect.ownKeys(value)) {
    const d = Object.getOwnPropertyDescriptor(value, key);
    if (typeof key !== 'string' || !d.enumerable || !Object.hasOwn(d, 'value')) fail();
  }
  return value;
}
function dense(value, max = MAX_ITEMS) {
  if (
    !Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Array.prototype ||
    value.length > max ||
    Reflect.ownKeys(value).length !== value.length + 1
  )
    fail('project_limit');
  for (let i = 0; i < value.length; i++) {
    const d = Object.getOwnPropertyDescriptor(value, String(i));
    if (!d || !d.enumerable || !Object.hasOwn(d, 'value')) fail();
  }
  return value;
}

/** Inspect decoded keys AND values before normalization, encoding or hashing.
 * Legacy Run dictionaries are permitted here; typed normalizers remain strict.
 * Error messages never interpolate data or the matching credential. */
export function assertDirectorSafe(value, options) {
  plain(options);
  const known = dense(options.knownValues, 10000);
  if (known.some(v => typeof v !== 'string')) fail('project_unsafe');
  let bytes = 0,
    nodes = 0;
  const ancestors = new Set();
  function string(s) {
    if (!s.isWellFormed()) fail();
    for (const secret of known) if (secret && s.includes(secret)) fail('project_unsafe');
    if (/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/i.test(s) || redact(s, {}) !== s) fail('project_unsafe');
    // Count JSON's UTF8 size without serializing raw input.
    bytes += 2 + Buffer.byteLength(s, 'utf8');
    for (const ch of s) {
      if (ch === '"' || ch === '\\' || /[\b\f\n\r\t]/.test(ch)) bytes++;
      else if (ch.charCodeAt(0) < 32) bytes += 5;
    }
  }
  function visit(item, depth) {
    if (depth > 16 || ++nodes > 2000000 || bytes > MAX_BYTES) fail('project_limit');
    if (typeof item === 'string') string(item);
    else if (item === null || typeof item === 'boolean') bytes += 5;
    else if (typeof item === 'number' && Number.isFinite(item)) bytes += 24;
    else {
      if (!item || typeof item !== 'object' || ancestors.has(item)) fail();
      ancestors.add(item);
      bytes += 2;
      if (Array.isArray(item)) {
        dense(item, 2000000);
        for (const entry of item) {
          bytes++;
          visit(entry, depth + 1);
        }
      } else {
        plain(item);
        for (const key of Object.keys(item)) {
          string(key);
          bytes += 2;
          visit(item[key], depth + 1);
        }
      }
      ancestors.delete(item);
    }
    if (bytes > MAX_BYTES) fail('project_limit');
  }
  visit(value, 0);
}

// Each schema is an ordered field list expressed as an object, never a generic
// canonical dictionary. Arrays carry semantic order and are never sorted.
export function object(value, schema) {
  plain(value);
  const keys = Object.keys(schema);
  if (Object.keys(value).length !== keys.length || keys.some(k => !Object.hasOwn(value, k))) fail();
  return Object.fromEntries(keys.map(k => [k, schema[k](value[k])]));
}
// Like object(), plus optional fields emitted after the required ones and only
// when present. Unknown keys are still rejected, so absent optionals keep bytes.
function extended(value, required, optional) {
  plain(value);
  const keys = Object.keys(required),
    present = Object.keys(optional).filter(k => Object.hasOwn(value, k));
  if (Object.keys(value).length !== keys.length + present.length || keys.some(k => !Object.hasOwn(value, k))) fail();
  return Object.fromEntries([
    ...keys.map(k => [k, required[k](value[k])]),
    ...present.map(k => [k, optional[k](value[k])]),
  ]);
}
function text(value, max = 65536, empty = false) {
  if (
    typeof value !== 'string' ||
    !value.isWellFormed() ||
    (!empty && !value.trim()) ||
    Buffer.byteLength(value) > max ||
    /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value)
  )
    fail();
  return value;
}
const short = v => text(v, 512);
const contextText = v => text(v, 65536, true);
const bool = v => {
  if (typeof v !== 'boolean') fail();
  return v;
};
const int = (v, min = 1, max = Number.MAX_SAFE_INTEGER) => {
  if (!Number.isSafeInteger(v) || v < min || v > max) fail();
  return v;
};
const one = v => {
  if (v !== 1) fail();
  return v;
};
const pattern = re => v => {
  if (typeof v !== 'string' || !re.test(v)) fail();
  return v;
};
const slug = pattern(/^[a-z][a-z0-9-]{0,47}$/);
const uuid = pattern(/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/);
const digest = pattern(/^[a-f0-9]{64}$/);
const sha = pattern(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/);
const nullable = parse => v => (v === null ? null : parse(v));
export const member = list => v => {
  if (!list.includes(v)) fail();
  return v;
};
function timestamp(v) {
  if (
    typeof v !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(v) ||
    !Number.isFinite(Date.parse(v)) ||
    new Date(v).toISOString() !== v
  )
    fail();
  return v;
}
export function list(value, parse, identity = v => v, min = 0) {
  const result = dense(value).map(v => parse(v));
  if (result.length < min || new Set(result.map(identity)).size !== result.length) fail();
  return result;
}
function absolute(value) {
  text(value, 4096);
  if (
    /[\x00-\x1f\x7f]/.test(value) ||
    !(path.posix.isAbsolute(value) || path.win32.isAbsolute(value)) ||
    /^\\\\[?.]\\/.test(value) ||
    /^[A-Za-z]:[^\\/]/.test(value)
  )
    fail('project_path');
  // A single Windows root-relative slash is not an absolute owned location.
  if (value.startsWith('\\') && !value.startsWith('\\\\')) fail('project_path');
  if (
    value
      .replaceAll('\\', '/')
      .split('/')
      .some(p => p === '.' || p === '..')
  )
    fail('project_path');
  return value;
}
function privatePath(value) {
  absolute(value);
  const normalized = value.replaceAll('\\', '/');
  if (
    normalized.split('/').some(p => /^(?:\.git|\.ssh|\.aws|\.azure|Kodo-Credentials)$/i.test(p)) ||
    secretFile(normalized) ||
    /(?:^|\/)(?:id_(?:rsa|dsa|ecdsa|ed25519)|[^/]*\.(?:p12|pfx|ppk))(?:\.pub)?$/i.test(normalized)
  )
    fail('project_path');
  return value;
}
function scope(value) {
  text(value, 4096);
  if (
    /[\\:\x00-\x1f\x7f]/.test(value) ||
    value.startsWith('/') ||
    value.split('/').some(p => !p || p === '.' || p === '..' || /^(?:\.git|\.env[^/]*|\.ssh)$/i.test(p)) ||
    secretFile(value)
  )
    fail('project_scope');
  return value;
}
const reference = v =>
  object(v, { kind: member(kinds), runId: nullable(uuid), headSha: nullable(sha), path: privatePath, sha256: digest });
export const refs = v => list(v, reference, r => r.sha256);
const criterion = v => object(v, { id: slug, text, evidenceKinds: v => list(v, member(kinds), x => x, 1) });
const criteria = v => list(v, criterion, c => c.id, 1);
const mapping = v =>
  object(v, { criterionId: slug, refs: v => list(v, digest, x => x, 1), actor: short, reason: text });
export const mappings = v => list(v, mapping, m => m.criterionId);
const milestoneFields = { id: slug, title: short, acceptance: criteria, releaseRequired: bool };
const epicFields = { id: slug, milestoneId: slug, title: short, acceptance: criteria };
const taskFields = {
  id: slug,
  epicId: slug,
  title: short,
  description: text,
  owner: short,
  dependsOn: v => list(v, slug),
  writePaths: v => list(v, scope, x => x, 1),
  acceptance: criteria,
  interfaceRefs: refs,
  priority: v => int(v, 0, 100),
  userValue: v => int(v, 0, 5),
  risk: v => int(v, 0, 5),
  estimatedEffort: int,
  riskApprovalRequired: bool,
};
const metaFields = {
  schemaVersion: one,
  projectId: uuid,
  revision: int,
  status: member(states),
  createdAt: timestamp,
  updatedAt: timestamp,
  evidence: refs,
  mappings,
};
const projectHeader = {
  schemaVersion: one,
  id: slug,
  root: absolute,
  title: short,
  definitionOfDone: criteria,
  constraints: v => list(v, text),
  businessContext: contextText,
  architectureRefs: refs,
};
const projectFields = {
  schemaVersion: one,
  projectId: uuid,
  id: slug,
  root: absolute,
  projectKey: short,
  title: short,
  definitionOfDone: criteria,
  constraints: v => list(v, text),
  businessContext: contextText,
  architectureRefs: refs,
  status: member(states),
  paused: bool,
  revision: int,
  createdAt: timestamp,
  updatedAt: timestamp,
  evidence: refs,
  mappings,
};
const attemptFields = {
  schemaVersion: one,
  id: uuid,
  projectId: uuid,
  taskId: slug,
  taskRevision: int,
  number: int,
  runId: uuid,
  contractHash: digest,
  status: member(attemptStates),
  baseSha: nullable(sha),
  headSha: nullable(sha),
  evidence: refs,
  reason: nullable(text),
  createdAt: timestamp,
  updatedAt: timestamp,
};
const approvalFields = {
  schemaVersion: one,
  projectId: uuid,
  taskId: slug,
  taskRevision: int,
  actor: short,
  reason: text,
  approvedAt: timestamp,
};
const bindingFields = {
  schemaVersion: one,
  projectId: uuid,
  taskId: slug,
  taskRevision: int,
  attemptId: uuid,
  runId: uuid,
  contractHash: digest,
};
const taskContractFields = {
  schemaVersion: one,
  projectId: uuid,
  taskId: slug,
  taskRevision: int,
  description: text,
  owner: short,
  dependsOn: v => list(v, slug),
  writePaths: v => list(v, scope, x => x, 1),
  acceptance: criteria,
  interfaceRefs: refs,
};
const projectContextFields = {
  projectId: uuid,
  id: slug,
  root: absolute,
  title: short,
  definitionOfDone: criteria,
  constraints: v => list(v, text),
  businessContext: contextText,
  architectureRefs: refs,
};
// Only task/frontier (the legacy behavior) and wave/branch are executable.
function execution(value) {
  const e = extended(
    value,
    { cadence: short, integration: short },
    { watchdog: v => object(v, { stalledRounds: nullable(v => int(v, 1, 5)), rejectUnchanged: bool }) },
  );
  if (!Object.hasOwn(executionModes, e.cadence) || executionModes[e.cadence] !== e.integration)
    fail('project_execution_unsupported');
  return e;
}
function reopenedHistory(value) {
  dense(value, MAX_REOPENED);
  return list(
    value,
    v =>
      object(v, {
        status: member(['accepted', 'released']),
        revision: int,
        reopenedAt: timestamp,
        evidence: refs,
        mappings,
      }),
    e => e.revision,
  );
}
const containerKinds = ['epic', 'milestone', 'project'];
const container = v => {
  const c = object(v, { kind: member(containerKinds), id: short });
  (c.kind === 'project' ? uuid : slug)(c.id);
  return c;
};
// Narrowest first: a contiguous epic ⊂ milestone ⊂ project chain.
function gateContainers(value) {
  const chain = list(value, container, c => c.kind, 1);
  const start = containerKinds.indexOf(chain[0].kind);
  if (chain.some((c, i) => c.kind !== containerKinds[start + i])) fail('project_gate_invalid');
  return chain;
}
const merges = v =>
  list(
    v,
    x => object(x, { taskId: slug, attemptId: uuid, runId: uuid, mergeCommit: sha }),
    m => m.taskId,
    1,
  );
const gateFields = {
  schemaVersion: one,
  id: uuid,
  projectId: uuid,
  number: int,
  containers: gateContainers,
  runId: uuid,
  baseSha: sha,
  headSha: sha,
  merges,
  installed: bool,
  createdAt: timestamp,
  updatedAt: timestamp,
};
// A reservation replaced before its install (its head went stale) names its successor.
const provenance = v =>
  list(
    v,
    x => object(x, { commit: sha, kind: member(['task', 'gate']), writePaths: v => list(v, scope), ref: uuid }),
    x => x.commit,
  );
const gateOptional = { supersededBy: uuid, provenance };
// The acceptance criteria of one covered container, as the gate manifest carries them.
export const gateContainerCriteriaRow = v => object(v, { kind: member(containerKinds), id: short, criteria });
function gateRecord(value) {
  const g = dated(extended(value, gateFields, gateOptional));
  if (g.supersededBy !== undefined && (g.installed || g.supersededBy === g.id)) fail('project_gate_invalid');
  if (g.containers.some(c => c.kind === 'project' && c.id !== g.projectId)) fail('project_identity');
  return g;
}
const gateBindingFields = {
  schemaVersion: one,
  kind: member(['gate']),
  projectId: uuid,
  gateId: uuid,
  number: int,
  runId: uuid,
  baseSha: sha,
  headSha: sha,
  mergesHash: digest,
};
const entity = v => {
  const e = object(v, { kind: member(['project', 'milestone', 'epic', 'task', 'attempt', 'gate']), id: short });
  (['project', 'attempt', 'gate'].includes(e.kind) ? uuid : slug)(e.id);
  return e;
};
function dated(v) {
  if (Date.parse(v.updatedAt) < Date.parse(v.createdAt)) fail();
  return v;
}
export function mapped(record, ownCriteria) {
  const allowed = new Set(ownCriteria.map(c => c.id)),
    available = new Set(record.evidence.map(r => r.sha256));
  for (const m of record.mappings)
    if (!allowed.has(m.criterionId) || m.refs.some(r => !available.has(r))) fail('project_mapping');
  return record;
}
function projectRecord(value) {
  const record = mapped(
    dated(extended(value, projectFields, { execution, reopened: reopenedHistory })),
    value.definitionOfDone,
  );
  if (!Object.hasOwn(record, 'reopened')) return record;
  // Closed-state proof moved aside by appendMilestone; wave projects only.
  if (!isWaveProject(record)) fail();
  let previous = 0;
  for (const entry of record.reopened) {
    mapped(entry, record.definitionOfDone);
    if (entry.revision <= previous || entry.revision >= record.revision) fail('project_revision');
    previous = entry.revision;
  }
  return record;
}
function stored(kind, value) {
  if (kind === 'project') return projectRecord(value);
  const fields = { milestone: milestoneFields, epic: epicFields, task: taskFields }[kind];
  const record = dated(object(value, { ...fields, ...metaFields }));
  if (kind === 'task' && record.dependsOn.includes(record.id)) fail('project_dag');
  return mapped(record, record.acceptance);
}
function hierarchy({ milestones, epics, tasks }, complete = { milestones: true, epics: true, tasks: true }) {
  const ms = new Map(milestones.map(v => [v.id, v])),
    es = new Map(epics.map(v => [v.id, v])),
    ts = new Map(tasks.map(v => [v.id, v]));
  for (const e of epics) if (complete.milestones && !ms.has(e.milestoneId)) fail('project_parent');
  for (const t of tasks) {
    if (complete.epics && !es.has(t.epicId)) fail('project_parent');
    if (t.dependsOn.includes(t.id) || (complete.tasks && t.dependsOn.some(id => !ts.has(id)))) fail('project_dag');
  }
  const seen = new Set(),
    active = new Set();
  function visit(id) {
    if (active.has(id)) fail('project_dag');
    if (seen.has(id) || !ts.has(id)) return;
    active.add(id);
    for (const dep of ts.get(id).dependsOn) visit(dep);
    active.delete(id);
    seen.add(id);
  }
  for (const t of tasks) visit(t.id);
}
/**
 * The first cycle of the epic dependency graph (epic X → epic Y when a task of X depends on a task
 * of Y), as the epic ids along it, or null. A wave epic is gated only after the epics it depends on
 * are accepted, so a cycle (A1 → B1 → A2 → B2) would leave every epic of it integrated forever.
 * @param {{ id: string }[]} epics
 * @param {{ id: string, epicId: string, dependsOn: string[] }[]} tasks
 */
export function epicCycle(epics, tasks) {
  const epicOf = new Map(tasks.map(t => [t.id, t.epicId]));
  const edges = new Map(epics.map(e => [e.id, []]));
  for (const t of tasks)
    for (const dep of t.dependsOn) {
      const to = epicOf.get(dep);
      const out = edges.get(t.epicId);
      if (to !== undefined && to !== t.epicId && out && !out.includes(to)) out.push(to);
    }
  const state = new Map(),
    path = [];
  const visit = id => {
    if (state.get(id) === 'active') return path.slice(path.indexOf(id));
    if (state.has(id) || !edges.has(id)) return null;
    state.set(id, 'active');
    path.push(id);
    for (const next of edges.get(id)) {
      const cycle = visit(next);
      if (cycle) return cycle;
    }
    path.pop();
    state.set(id, 'done');
    return null;
  };
  for (const e of epics) {
    const cycle = visit(e.id);
    if (cycle) return cycle;
  }
  return null;
}
/**
 * The containers of a wave project without children: milestones with no epic and epics with no
 * task, as `{kind, id}`. Such an epic never gets a gate (it has no task to integrate), so it and
 * its milestone would stay `proposed` forever.
 * @param {{ id: string }[]} milestones
 * @param {{ id: string, milestoneId: string }[]} epics
 * @param {{ epicId: string }[]} tasks
 */
export function emptyContainers(milestones, epics, tasks) {
  const parents = new Set(epics.map(e => e.milestoneId)),
    filled = new Set(tasks.map(t => t.epicId));
  return [
    ...milestones.filter(m => !parents.has(m.id)).map(m => ({ kind: 'milestone', id: m.id })),
    ...epics.filter(e => !filled.has(e.id)).map(e => ({ kind: 'epic', id: e.id })),
  ];
}
export function assertContainersFilled(milestones, epics, tasks) {
  const empty = emptyContainers(milestones, epics, tasks);
  if (empty.length)
    throw Object.assign(
      new Error(`Invalid project Director data: empty ${empty.map(c => `${c.kind} ${c.id}`).join(', ')}`),
      { code: 'project_container_empty', containers: empty },
    );
}
export function assertEpicsAcyclic(epics, tasks) {
  const cycle = epicCycle(epics, tasks);
  if (cycle)
    throw Object.assign(new Error(`Invalid project Director data: epic dependency cycle ${cycle.join(' -> ')}`), {
      code: 'project_epic_cycle',
      epics: cycle,
    });
}
function projectSpec(value) {
  const s = extended(
    value,
    {
      ...projectHeader,
      milestones: v =>
        list(
          v,
          x => object(x, milestoneFields),
          x => x.id,
        ),
      epics: v =>
        list(
          v,
          x => object(x, epicFields),
          x => x.id,
        ),
      tasks: v =>
        list(
          v,
          x => object(x, taskFields),
          x => x.id,
        ),
    },
    { execution },
  );
  hierarchy(s);
  return s;
}
function count(value) {
  const c = object(value, { total: v => int(v, 0), returned: v => int(v, 0, MAX_ITEMS), complete: bool });
  if (c.returned > c.total || c.complete !== (c.returned === c.total)) fail('project_completeness');
  return c;
}
const snapshotSets = ['milestones', 'epics', 'tasks', 'currentAttempts', 'riskApprovals'];
// Gate runs are distinct from each other and from current task runs.
function gateIdentity(s) {
  const runs = new Set(s.currentAttempts.map(a => a.runId)),
    numbers = new Set();
  for (const g of s.gates) {
    if (runs.has(g.runId) || numbers.has(g.number)) fail('project_identity');
    runs.add(g.runId);
    numbers.add(g.number);
  }
}
export function snapshot(value) {
  const s = extended(
    value,
    {
      schemaVersion: one,
      project: v => stored('project', v),
      revision: int,
      milestones: v =>
        list(
          v,
          x => stored('milestone', x),
          x => x.id,
        ),
      epics: v =>
        list(
          v,
          x => stored('epic', x),
          x => x.id,
        ),
      tasks: v =>
        list(
          v,
          x => stored('task', x),
          x => x.id,
        ),
      currentAttempts: v =>
        list(
          v,
          x => dated(object(x, attemptFields)),
          x => x.taskId,
        ),
      riskApprovals: v =>
        list(
          v,
          x => object(x, approvalFields),
          x => x.taskId,
        ),
      completeness: v =>
        extended(v, Object.fromEntries(snapshotSets.map(k => [k, count])), {
          gates: count,
        }),
    },
    { gates: v => list(v, gateRecord, g => g.id) },
  );
  // Wave snapshots always carry their gate set; legacy snapshots never do.
  const wave = isWaveProject(s.project);
  if (wave !== Object.hasOwn(s, 'gates') || wave !== Object.hasOwn(s.completeness, 'gates')) fail();
  if (s.project.revision !== s.revision) fail('project_revision');
  for (const key of wave ? [...snapshotSets, 'gates'] : snapshotSets) {
    if (s[key].length !== s.completeness[key].returned || s[key].some(r => r.projectId !== s.project.projectId))
      fail('project_identity');
    if (['milestones', 'epics', 'tasks'].includes(key) && s[key].some(r => r.revision > s.revision))
      fail('project_revision');
  }
  hierarchy(s, {
    milestones: s.completeness.milestones.complete,
    epics: s.completeness.epics.complete,
    tasks: s.completeness.tasks.complete,
  });
  const tasks = new Map(s.tasks.map(t => [t.id, t]));
  const runIds = new Set(),
    attemptIds = new Set();
  for (const a of s.currentAttempts) {
    if (runIds.has(a.runId) || attemptIds.has(a.id)) fail('project_identity');
    runIds.add(a.runId);
    attemptIds.add(a.id);
  }
  for (const r of s.currentAttempts) {
    const t = tasks.get(r.taskId);
    if (
      (!t && s.completeness.tasks.complete) ||
      (t &&
        (r.taskRevision > t.revision ||
          (r.taskRevision !== t.revision &&
            !['blocked', 'failed', 'cancelled', 'accepted', 'released'].includes(r.status))))
    )
      fail('project_revision');
  }
  for (const r of s.riskApprovals) {
    const t = tasks.get(r.taskId);
    if ((!t && s.completeness.tasks.complete) || (t && r.taskRevision !== t.revision)) fail('project_revision');
  }
  if (wave) gateIdentity(s);
  return s;
}
export function action(value) {
  plain(value);
  if (value.op === 'create') {
    const created = object(value, { op: member(['create']), spec: projectSpec });
    // Wave epics are gated in dependency order, each over its tasks; legacy projects keep their rules.
    if (isWaveProject(created.spec)) {
      assertContainersFilled(created.spec.milestones, created.spec.epics, created.spec.tasks);
      assertEpicsAcyclic(created.spec.epics, created.spec.tasks);
    }
    return created;
  }
  if (['insert', 'amend'].includes(value.op)) {
    const fields = { milestone: milestoneFields, epic: epicFields, task: taskFields }[value.kind];
    if (!fields) fail();
    const a = object(value, {
      op: member(['insert', 'amend']),
      kind: member(['milestone', 'epic', 'task']),
      ...(value.op === 'amend' ? { id: slug } : {}),
      record: v => object(v, fields),
    });
    if (a.op === 'amend' && a.id !== a.record.id) fail('project_identity');
    if (a.kind === 'task' && a.record.dependsOn.includes(a.record.id)) fail('project_dag');
    return a;
  }
  if (value.op === 'transition') {
    const a = object(value, {
      op: member(['transition']),
      kind: member(['project', 'milestone', 'epic', 'task', 'attempt']),
      id: short,
      to: member(value.kind === 'attempt' ? attemptStates : states),
      evidence: refs,
      mappings,
    });
    entity({ kind: a.kind, id: a.id });
    return a;
  }
  if (value.op === 'setPaused') return object(value, { op: member(['setPaused']), paused: bool });
  if (value.op === 'approveRisk')
    return object(value, { op: member(['approveRisk']), taskId: slug, taskRevision: int });
  if (value.op === 'reserveAttempt')
    return object(value, { op: member(['reserveAttempt']), taskId: slug, retryFailed: bool });
  if (value.op === 'appendMilestone')
    return object(value, {
      op: member(['appendMilestone']),
      milestone: v => object(v, milestoneFields),
      epics: v =>
        list(
          v,
          x => object(x, epicFields),
          x => x.id,
          1,
        ),
      tasks: v =>
        list(
          v,
          x => object(x, taskFields),
          x => x.id,
          1,
        ),
    });
  if (value.op === 'reserveGate')
    return object(value, {
      op: member(['reserveGate']),
      containers: gateContainers,
      baseSha: sha,
      headSha: sha,
      merges,
      retry: bool,
    });
  fail();
}
export const normalize = {
  projectSpec,
  project: v => stored('project', v),
  milestone: v => stored('milestone', v),
  epic: v => stored('epic', v),
  task: v => stored('task', v),
  attempt: v => dated(object(v, attemptFields)),
  riskApproval: v => object(v, approvalFields),
  event: v =>
    object(v, {
      schemaVersion: one,
      seq: int,
      projectId: uuid,
      at: timestamp,
      commandId: uuid,
      actor: short,
      reason: text,
      entity,
      type: short,
      previousHash: nullable(digest),
      nextHash: digest,
    }),
  snapshot,
  command: v => {
    const c = object(v, {
      schemaVersion: one,
      commandId: uuid,
      projectId: nullable(uuid),
      expectedRevision: nullable(int),
      actor: short,
      reason: text,
      action,
    });
    if (
      c.action.op === 'create'
        ? c.projectId !== null || c.expectedRevision !== null
        : c.projectId === null || c.expectedRevision === null
    )
      fail('project_revision');
    if (c.action.op === 'transition' && c.action.kind === 'project' && c.action.id !== c.projectId)
      fail('project_identity');
    if (c.action.op === 'reserveGate' && c.action.containers.some(x => x.kind === 'project' && x.id !== c.projectId))
      fail('project_identity');
    return c;
  },
  installBinding: v => object(v, bindingFields),
  gate: gateRecord,
  gateBinding: v => extended(v, gateBindingFields, { provenance }),
  taskContract: v => {
    const c = object(v, taskContractFields);
    if (c.dependsOn.includes(c.taskId)) fail('project_dag');
    return c;
  },
  taskRunInput: v => {
    const input = object(v, {
      schemaVersion: one,
      projectContext: v => object(v, projectContextFields),
      task: v => normalize.taskContract(v),
    });
    if (input.projectContext.projectId !== input.task.projectId) fail('project_identity');
    return input;
  },
  gateManifest: v => {
    const input = extended(
      v,
      {
        schemaVersion: v => int(v, 2, 2),
        projectContext: v => object(v, projectContextFields),
        gate: v => object(v, { containers: gateContainers, baseSha: sha, headSha: sha }),
        containers: v => list(v, gateContainerCriteriaRow, c => c.kind, 1),
        tasks: v =>
          list(
            v,
            x => normalize.taskContract(x),
            t => t.taskId,
            1,
          ),
      },
      { provenance },
    );
    if (
      input.tasks.some(t => t.projectId !== input.projectContext.projectId) ||
      input.containers.length !== input.gate.containers.length ||
      input.containers.some((c, i) => c.kind !== input.gate.containers[i].kind || c.id !== input.gate.containers[i].id)
    )
      fail('project_identity');
    return input;
  },
  gateRunInput: v =>
    object(v, {
      schemaVersion: v => int(v, 2, 2),
      projectId: uuid,
      gate: v => object(v, { containers: gateContainers, baseSha: sha, headSha: sha }),
      taskCount: v => int(v, 1, MAX_ITEMS),
      manifest: v => object(v, { kind: member(['gate-manifest']), sha256: digest, bytes: v => int(v, 1, MAX_BYTES) }),
    }),
};

export function normalizeDirectorRecord(kind, input, options) {
  assertDirectorSafe(input, options);
  if (typeof kind !== 'string' || !Object.hasOwn(normalize, kind)) fail();
  const value = normalize[kind](input);
  assertDirectorSafe(value, options);
  return value;
}
export function normalizeProjectSpec(input, options) {
  return normalizeDirectorRecord('projectSpec', input, options);
}
/** Wave cadence with branch integration; every other project keeps legacy semantics. */
export function isWaveProject(project) {
  return project?.execution?.cadence === 'wave' && project.execution.integration === 'branch';
}
