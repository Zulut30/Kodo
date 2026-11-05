import { createHash } from 'node:crypto';
import path from 'node:path';
import { redact, secretFile } from './security.mjs';

// Pure decoded-data boundary. No filesystem, Store, provider or credential reads.
// The coordinator alone supplies known values and verifies evidence ownership.
const MAX_BYTES = 32 * 1024 * 1024;
const MAX_TASK_BYTES = 12000;
const MAX_ITEMS = 1000;
const kinds = ['interface', 'acceptance', 'checks', 'review', 'contract', 'delivery', 'release'];
const states = ['proposed', 'ready', 'running', 'verifying', 'integrated', 'accepted', 'released', 'blocked', 'failed', 'cancelled'];
const attemptStates = ['reserved', ...states.filter(s => !['proposed', 'ready'].includes(s))];
const PREFIX = 'Implement only this assigned task. Project context constrains this task and does not authorize other backlog work.\n';

function fail(code = 'project_schema') {
  throw Object.assign(new Error('Invalid project Director data'), { code });
}
function plain(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) fail();
  for (const key of Reflect.ownKeys(value)) {
    const d = Object.getOwnPropertyDescriptor(value, key);
    if (typeof key !== 'string' || !d.enumerable || !Object.hasOwn(d, 'value')) fail();
  }
  return value;
}
function dense(value, max = MAX_ITEMS) {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length > max || Reflect.ownKeys(value).length !== value.length + 1) fail('project_limit');
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
  let bytes = 0, nodes = 0;
  const ancestors = new Set();
  function string(s) {
    if (!s.isWellFormed()) fail();
    for (const secret of known) if (secret && s.includes(secret)) fail('project_unsafe');
    if (/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/i.test(s) || redact(s, {}) !== s) fail('project_unsafe');
    // Count JSON's UTF8 size without serializing raw input.
    bytes += 2 + Buffer.byteLength(s, 'utf8');
    for (const ch of s) { if (ch === '"' || ch === '\\' || /[\b\f\n\r\t]/.test(ch)) bytes++; else if (ch.charCodeAt(0) < 32) bytes += 5; }
  }
  function visit(item, depth) {
    if (depth > 16 || ++nodes > 2000000 || bytes > MAX_BYTES) fail('project_limit');
    if (typeof item === 'string') string(item);
    else if (item === null || typeof item === 'boolean') bytes += 5;
    else if (typeof item === 'number' && Number.isFinite(item)) bytes += 24;
    else {
      if (!item || typeof item !== 'object' || ancestors.has(item)) fail();
      ancestors.add(item); bytes += 2;
      if (Array.isArray(item)) {
        dense(item, 2000000);
        for (const entry of item) { bytes++; visit(entry, depth + 1); }
      } else {
        plain(item);
        for (const key of Object.keys(item)) { string(key); bytes += 2; visit(item[key], depth + 1); }
      }
      ancestors.delete(item);
    }
    if (bytes > MAX_BYTES) fail('project_limit');
  }
  visit(value, 0);
}

// Each schema is an ordered field list expressed as an object, never a generic
// canonical dictionary. Arrays carry semantic order and are never sorted.
function object(value, schema) {
  plain(value);
  const keys = Object.keys(schema);
  if (Object.keys(value).length !== keys.length || keys.some(k => !Object.hasOwn(value, k))) fail();
  return Object.fromEntries(keys.map(k => [k, schema[k](value[k])]));
}
function text(value, max = 65536, empty = false) {
  if (typeof value !== 'string' || !value.isWellFormed() || (!empty && !value.trim()) || Buffer.byteLength(value) > max || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value)) fail();
  return value;
}
const short = v => text(v, 512);
const contextText = v => text(v, 65536, true);
const bool = v => { if (typeof v !== 'boolean') fail(); return v; };
const int = (v, min = 1, max = Number.MAX_SAFE_INTEGER) => { if (!Number.isSafeInteger(v) || v < min || v > max) fail(); return v; };
const one = v => { if (v !== 1) fail(); return v; };
const pattern = re => v => { if (typeof v !== 'string' || !re.test(v)) fail(); return v; };
const slug = pattern(/^[a-z][a-z0-9-]{0,47}$/);
const uuid = pattern(/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/);
const digest = pattern(/^[a-f0-9]{64}$/);
const sha = pattern(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/);
const nullable = parse => v => v === null ? null : parse(v);
const member = list => v => { if (!list.includes(v)) fail(); return v; };
function timestamp(v) {
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(v) || !Number.isFinite(Date.parse(v)) || new Date(v).toISOString() !== v) fail();
  return v;
}
function list(value, parse, identity = v => v, min = 0) {
  const result = dense(value).map(v => parse(v));
  if (result.length < min || new Set(result.map(identity)).size !== result.length) fail();
  return result;
}
function absolute(value) {
  text(value, 4096);
  if (/[\x00-\x1f\x7f]/.test(value) || !(path.posix.isAbsolute(value) || path.win32.isAbsolute(value)) || /^\\\\[?.]\\/.test(value) || /^[A-Za-z]:[^\\/]/.test(value)) fail('project_path');
  // A single Windows root-relative slash is not an absolute owned location.
  if (value.startsWith('\\') && !value.startsWith('\\\\')) fail('project_path');
  if (value.replaceAll('\\', '/').split('/').some(p => p === '.' || p === '..')) fail('project_path');
  return value;
}
function privatePath(value) {
  absolute(value);
  const normalized = value.replaceAll('\\', '/');
  if (normalized.split('/').some(p => /^(?:\.git|\.ssh|\.aws|\.azure|Kodo-Credentials)$/i.test(p)) || secretFile(normalized) || /(?:^|\/)(?:id_(?:rsa|dsa|ecdsa|ed25519)|[^/]*\.(?:p12|pfx|ppk))(?:\.pub)?$/i.test(normalized)) fail('project_path');
  return value;
}
function scope(value) {
  text(value, 4096);
  if (/[\\:\x00-\x1f\x7f]/.test(value) || value.startsWith('/') || value.split('/').some(p => !p || p === '.' || p === '..' || /^(?:\.git|\.env[^/]*|\.ssh)$/i.test(p)) || secretFile(value)) fail('project_scope');
  return value;
}
const reference = v => object(v, { kind: member(kinds), runId: nullable(uuid), headSha: nullable(sha), path: privatePath, sha256: digest });
const refs = v => list(v, reference, r => r.sha256);
const criterion = v => object(v, { id: slug, text, evidenceKinds: v => list(v, member(kinds), x => x, 1) });
const criteria = v => list(v, criterion, c => c.id, 1);
const mapping = v => object(v, { criterionId: slug, refs: v => list(v, digest, x => x, 1), actor: short, reason: text });
const mappings = v => list(v, mapping, m => m.criterionId);
const milestoneFields = { id: slug, title: short, acceptance: criteria, releaseRequired: bool };
const epicFields = { id: slug, milestoneId: slug, title: short, acceptance: criteria };
const taskFields = { id: slug, epicId: slug, title: short, description: text, owner: short,
  dependsOn: v => list(v, slug), writePaths: v => list(v, scope, x => x, 1), acceptance: criteria, interfaceRefs: refs,
  priority: v => int(v, 0, 100), userValue: v => int(v, 0, 5), risk: v => int(v, 0, 5), estimatedEffort: int, riskApprovalRequired: bool };
const metaFields = { schemaVersion: one, projectId: uuid, revision: int, status: member(states), createdAt: timestamp, updatedAt: timestamp, evidence: refs, mappings };
const projectHeader = { schemaVersion: one, id: slug, root: absolute, title: short, definitionOfDone: criteria,
  constraints: v => list(v, text), businessContext: contextText, architectureRefs: refs };
const projectFields = { schemaVersion: one, projectId: uuid, id: slug, root: absolute, projectKey: short, title: short,
  definitionOfDone: criteria, constraints: v => list(v, text), businessContext: contextText, architectureRefs: refs,
  status: member(states), paused: bool, revision: int, createdAt: timestamp, updatedAt: timestamp, evidence: refs, mappings };
const attemptFields = { schemaVersion: one, id: uuid, projectId: uuid, taskId: slug, taskRevision: int, number: int,
  runId: uuid, contractHash: digest, status: member(attemptStates), baseSha: nullable(sha), headSha: nullable(sha),
  evidence: refs, reason: nullable(text), createdAt: timestamp, updatedAt: timestamp };
const approvalFields = { schemaVersion: one, projectId: uuid, taskId: slug, taskRevision: int, actor: short, reason: text, approvedAt: timestamp };
const bindingFields = { schemaVersion: one, projectId: uuid, taskId: slug, taskRevision: int, attemptId: uuid, runId: uuid, contractHash: digest };
const taskContractFields = { schemaVersion: one, projectId: uuid, taskId: slug, taskRevision: int, description: text, owner: short,
  dependsOn: v => list(v, slug), writePaths: v => list(v, scope, x => x, 1), acceptance: criteria, interfaceRefs: refs };
const entity = v => {
  const e = object(v, { kind: member(['project', 'milestone', 'epic', 'task', 'attempt']), id: short });
  (['project', 'attempt'].includes(e.kind) ? uuid : slug)(e.id); return e;
};
function dated(v) { if (Date.parse(v.updatedAt) < Date.parse(v.createdAt)) fail(); return v; }
function mapped(record, ownCriteria) {
  const allowed = new Set(ownCriteria.map(c => c.id)), available = new Set(record.evidence.map(r => r.sha256));
  for (const m of record.mappings) if (!allowed.has(m.criterionId) || m.refs.some(r => !available.has(r))) fail('project_mapping');
  return record;
}
function stored(kind, value) {
  if (kind === 'project') return mapped(dated(object(value, projectFields)), value.definitionOfDone);
  const fields = { milestone: milestoneFields, epic: epicFields, task: taskFields }[kind];
  const record = dated(object(value, { ...fields, ...metaFields }));
  if (kind === 'task' && record.dependsOn.includes(record.id)) fail('project_dag');
  return mapped(record, record.acceptance);
}
function hierarchy({ milestones, epics, tasks }, complete = { milestones: true, epics: true, tasks: true }) {
  const ms = new Map(milestones.map(v => [v.id, v])), es = new Map(epics.map(v => [v.id, v])), ts = new Map(tasks.map(v => [v.id, v]));
  for (const e of epics) if (complete.milestones && !ms.has(e.milestoneId)) fail('project_parent');
  for (const t of tasks) {
    if (complete.epics && !es.has(t.epicId)) fail('project_parent');
    if (t.dependsOn.includes(t.id) || complete.tasks && t.dependsOn.some(id => !ts.has(id))) fail('project_dag');
  }
  const seen = new Set(), active = new Set();
  function visit(id) {
    if (active.has(id)) fail('project_dag');
    if (seen.has(id) || !ts.has(id)) return;
    active.add(id); for (const dep of ts.get(id).dependsOn) visit(dep); active.delete(id); seen.add(id);
  }
  for (const t of tasks) visit(t.id);
}
function projectSpec(value) {
  const s = object(value, { ...projectHeader, milestones: v => list(v, x => object(x, milestoneFields), x => x.id),
    epics: v => list(v, x => object(x, epicFields), x => x.id), tasks: v => list(v, x => object(x, taskFields), x => x.id) });
  hierarchy(s); return s;
}
function count(value) {
  const c = object(value, { total: v => int(v, 0), returned: v => int(v, 0, MAX_ITEMS), complete: bool });
  if (c.returned > c.total || c.complete !== (c.returned === c.total)) fail('project_completeness');
  return c;
}
function snapshot(value) {
  const s = object(value, { schemaVersion: one, project: v => stored('project', v), revision: int,
    milestones: v => list(v, x => stored('milestone', x), x => x.id), epics: v => list(v, x => stored('epic', x), x => x.id),
    tasks: v => list(v, x => stored('task', x), x => x.id), currentAttempts: v => list(v, x => dated(object(x, attemptFields)), x => x.taskId),
    riskApprovals: v => list(v, x => object(x, approvalFields), x => x.taskId),
    completeness: v => object(v, Object.fromEntries(['milestones', 'epics', 'tasks', 'currentAttempts', 'riskApprovals'].map(k => [k, count]))) });
  if (s.project.revision !== s.revision) fail('project_revision');
  for (const key of ['milestones', 'epics', 'tasks', 'currentAttempts', 'riskApprovals']) {
    if (s[key].length !== s.completeness[key].returned || s[key].some(r => r.projectId !== s.project.projectId)) fail('project_identity');
    if (['milestones', 'epics', 'tasks'].includes(key) && s[key].some(r => r.revision > s.revision)) fail('project_revision');
  }
  hierarchy(s, Object.fromEntries(Object.entries(s.completeness).map(([k, c]) => [k, c.complete])));
  const tasks = new Map(s.tasks.map(t => [t.id, t]));
  const runIds = new Set(), attemptIds = new Set();
  for (const a of s.currentAttempts) {
    if (runIds.has(a.runId) || attemptIds.has(a.id)) fail('project_identity'); runIds.add(a.runId); attemptIds.add(a.id);
  }
  for (const r of s.currentAttempts) {
    const t = tasks.get(r.taskId);
    if ((!t && s.completeness.tasks.complete) || (t && (r.taskRevision > t.revision || r.taskRevision !== t.revision && !['blocked', 'failed', 'cancelled', 'accepted', 'released'].includes(r.status)))) fail('project_revision');
  }
  for (const r of s.riskApprovals) {
    const t = tasks.get(r.taskId);
    if ((!t && s.completeness.tasks.complete) || (t && r.taskRevision !== t.revision)) fail('project_revision');
  }
  return s;
}
function action(value) {
  plain(value);
  if (value.op === 'create') return object(value, { op: member(['create']), spec: projectSpec });
  if (['insert', 'amend'].includes(value.op)) {
    const fields = { milestone: milestoneFields, epic: epicFields, task: taskFields }[value.kind];
    if (!fields) fail();
    const a = object(value, { op: member(['insert', 'amend']), kind: member(['milestone', 'epic', 'task']),
      ...(value.op === 'amend' ? { id: slug } : {}), record: v => object(v, fields) });
    if (a.op === 'amend' && a.id !== a.record.id) fail('project_identity');
    if (a.kind === 'task' && a.record.dependsOn.includes(a.record.id)) fail('project_dag');
    return a;
  }
  if (value.op === 'transition') {
    const a = object(value, { op: member(['transition']), kind: member(['project', 'milestone', 'epic', 'task', 'attempt']), id: short,
      to: member(value.kind === 'attempt' ? attemptStates : states), evidence: refs, mappings });
    entity({ kind: a.kind, id: a.id }); return a;
  }
  if (value.op === 'setPaused') return object(value, { op: member(['setPaused']), paused: bool });
  if (value.op === 'approveRisk') return object(value, { op: member(['approveRisk']), taskId: slug, taskRevision: int });
  if (value.op === 'reserveAttempt') return object(value, { op: member(['reserveAttempt']), taskId: slug, retryFailed: bool });
  fail();
}
const normalize = {
  projectSpec,
  project: v => stored('project', v), milestone: v => stored('milestone', v), epic: v => stored('epic', v), task: v => stored('task', v),
  attempt: v => dated(object(v, attemptFields)), riskApproval: v => object(v, approvalFields),
  event: v => object(v, { schemaVersion: one, seq: int, projectId: uuid, at: timestamp, commandId: uuid, actor: short, reason: text,
    entity, type: short, previousHash: nullable(digest), nextHash: digest }),
  snapshot,
  command: v => {
    const c = object(v, { schemaVersion: one, commandId: uuid, projectId: nullable(uuid), expectedRevision: nullable(int), actor: short, reason: text, action });
    if (c.action.op === 'create' ? c.projectId !== null || c.expectedRevision !== null : c.projectId === null || c.expectedRevision === null) fail('project_revision');
    if (c.action.op === 'transition' && c.action.kind === 'project' && c.action.id !== c.projectId) fail('project_identity');
    return c;
  },
  installBinding: v => object(v, bindingFields),
  taskContract: v => {
    const c = object(v, taskContractFields);
    if (c.dependsOn.includes(c.taskId)) fail('project_dag');
    return c;
  },
  taskRunInput: v => {
    const input = object(v, { schemaVersion: one, projectContext: v => object(v, { projectId: uuid, id: slug, root: absolute, title: short,
      definitionOfDone: criteria, constraints: v => list(v, text), businessContext: contextText, architectureRefs: refs }), task: v => normalize.taskContract(v) });
    if (input.projectContext.projectId !== input.task.projectId) fail('project_identity');
    return input;
  }
};

export function normalizeDirectorRecord(kind, input, options) {
  assertDirectorSafe(input, options);
  if (typeof kind !== 'string' || !Object.hasOwn(normalize, kind)) fail();
  const value = normalize[kind](input);
  assertDirectorSafe(value, options);
  return value;
}
export function normalizeProjectSpec(input, options) { return normalizeDirectorRecord('projectSpec', input, options); }
export function directorBytes(kind, input, options) {
  const bytes = Buffer.from(JSON.stringify(normalizeDirectorRecord(kind, input, options)), 'utf8');
  if (bytes.length > MAX_BYTES) fail('project_limit');
  if (['taskContract', 'taskRunInput'].includes(kind) && bytes.length + (kind === 'taskRunInput' ? Buffer.byteLength(PREFIX) : 0) > MAX_TASK_BYTES) fail('project_task_too_large');
  return bytes;
}
function contract(task) {
  return { schemaVersion: 1, projectId: task.projectId, taskId: task.id, taskRevision: task.revision, description: task.description,
    owner: task.owner, dependsOn: task.dependsOn, writePaths: task.writePaths, acceptance: task.acceptance, interfaceRefs: task.interfaceRefs };
}
export function directorContractHash(storedTask, options) {
  const task = normalizeDirectorRecord('task', storedTask, options);
  return createHash('sha256').update(directorBytes('taskContract', contract(task), options)).digest('hex');
}
export function buildDirectorTaskInput(input, options) {
  assertDirectorSafe(input, options);
  const { project, task } = object(input, { project: v => normalizeDirectorRecord('project', v, options), task: v => normalizeDirectorRecord('task', v, options) });
  if (project.projectId !== task.projectId) fail('project_identity');
  const projectContext = { projectId: project.projectId, id: project.id, root: project.root, title: project.title,
    definitionOfDone: project.definitionOfDone, constraints: project.constraints, businessContext: project.businessContext, architectureRefs: project.architectureRefs };
  return PREFIX + directorBytes('taskRunInput', { schemaVersion: 1, projectContext, task: contract(task) }, options).toString('utf8');
}

/** Structural lifecycle checks are NOT trusted evidence authorization. Store
 * additionally invokes the coordinator's authorizer for every forward edge. */
export function assertProjectTransition(input) {
  // This API has no credential options; external callers guard the full command
  // with their known values before invoking structural transition validation.
  assertDirectorSafe(input, { knownValues: [] });
  const v = object(input, { record: plain, to: member([...states, 'reserved']), snapshot, evidence: refs, mappings });
  const s = v.snapshot, raw = v.record;
  let kind, current;
  if (raw.projectId !== s.project.projectId) fail('project_identity');
  if (Object.hasOwn(raw, 'projectKey')) { kind = 'project'; current = s.project; }
  else if (Object.hasOwn(raw, 'taskRevision')) { kind = 'attempt'; current = s.currentAttempts.find(r => r.id === raw.id); }
  else if (Object.hasOwn(raw, 'epicId')) { kind = 'task'; current = s.tasks.find(r => r.id === raw.id); }
  else if (Object.hasOwn(raw, 'milestoneId')) { kind = 'epic'; current = s.epics.find(r => r.id === raw.id); }
  else { kind = 'milestone'; current = s.milestones.find(r => r.id === raw.id); }
  const r = normalize[kind](raw);
  if (!current || JSON.stringify(r) !== JSON.stringify(current)) fail('project_revision');
  const next = { proposed: 'ready', ready: 'running', reserved: 'running', running: 'verifying', verifying: 'integrated', integrated: 'accepted', accepted: 'released' };
  const exceptional = ['blocked', 'failed', 'cancelled'];
  if (r.status === v.to || r.status === 'released' || r.status === 'accepted' && v.to !== 'released') fail('project_transition');
  if (next[r.status] !== v.to && !(exceptional.includes(v.to) && !['accepted', 'released', 'cancelled'].includes(r.status)) && !(exceptional.includes(r.status) && r.status !== 'cancelled' && v.to === (kind === 'attempt' ? 'running' : 'ready'))) fail('project_transition');
  if (['ready', 'running', 'verifying', 'integrated', 'accepted', 'released'].includes(v.to) && (s.project.paused || ['cancelled', 'failed'].includes(s.project.status))) fail('project_control');
  const t = kind === 'task' ? r : kind === 'attempt' ? s.tasks.find(t => t.id === r.taskId) : null;
  if (['ready', 'running', 'verifying', 'integrated', 'accepted', 'released'].includes(v.to)) {
    if (Object.values(s.completeness).some(c => !c.complete)) fail('project_completeness');
    if (kind === 'attempt' && (!t || r.taskRevision !== t.revision)) fail('project_revision');
  }
  const ownCriteria = kind === 'project' ? r.definitionOfDone : kind === 'attempt' ? t?.acceptance || [] : r.acceptance;
  mapped({ evidence: [...r.evidence, ...v.evidence], mappings: v.mappings }, ownCriteria);
  if (['ready', 'running'].includes(v.to) && t) {
    if (!s.completeness.tasks.complete || t.dependsOn.some(id => !s.tasks.some(d => d.id === id && ['accepted', 'released'].includes(d.status)))) fail('project_dependency');
    if (t.riskApprovalRequired && !s.riskApprovals.some(a => a.taskId === t.id && a.taskRevision === t.revision)) fail('project_risk');
  }
  if (!['accepted', 'released'].includes(v.to)) return;
  if (Object.values(s.completeness).some(c => !c.complete)) fail('project_completeness');
  const milestoneEpics = kind === 'milestone' ? s.epics.filter(e => e.milestoneId === r.id) : [];
  const children = kind === 'project' ? [...s.milestones, ...s.epics, ...s.tasks] : kind === 'milestone' ? [...milestoneEpics, ...s.tasks.filter(t => milestoneEpics.some(e => e.id === t.epicId))] : kind === 'epic' ? s.tasks.filter(t => t.epicId === r.id) : [];
  if (children.some(c => !['accepted', 'released'].includes(c.status))) fail('project_children');
  if (v.to === 'released' && kind === 'project' && s.milestones.some(m => m.releaseRequired && m.status !== 'released')) fail('project_children');
  const evidence = new Map([...r.evidence, ...v.evidence].map(ref => [ref.sha256, ref]));
  const ownMappings = new Map([...(r.mappings || []), ...v.mappings].map(m => [m.criterionId, m]));
  if (v.to === 'accepted') for (const c of ownCriteria) {
    const m = ownMappings.get(c.id);
    if (!m || m.refs.some(id => !evidence.has(id)) || c.evidenceKinds.some(k => !m.refs.some(id => evidence.get(id)?.kind === k))) fail('project_mapping');
  }
  if (v.to === 'released' && ![...evidence.values()].some(r => r.kind === 'release')) fail('project_evidence');
}
