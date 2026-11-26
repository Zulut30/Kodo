import { createHash } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { fail, requireValue } from './project-store-validation.mjs';

export const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const uuid = value =>
  typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
const canonicalRoot = value => realpathSync.native(value);
export const identity = value => {
  const root = canonicalRoot(value);
  return process.platform === 'win32' ? root.toLowerCase() : root;
};
export const forwardStates = new Set(['ready', 'running', 'verifying', 'integrated', 'accepted', 'released']);
export const retryStates = new Set(['blocked', 'failed', 'cancelled']);
export const settledStates = new Set(['blocked', 'failed', 'cancelled', 'accepted', 'released']);
export const children = ['milestone', 'epic', 'task'];
export const mergeBy = (previous, next, key) => [
  ...new Map([...previous, ...next].map(value => [value[key], value])).values(),
];
export function transaction(db, mode, operation) {
  db.exec(mode);
  try {
    const result = operation();
    requireValue(!result || typeof result.then !== 'function', 'transaction_async');
    db.exec('COMMIT');
    return result;
  } catch (error) {
    try {
      db.exec('ROLLBACK');
    } catch {
      /* Preserve the initiating failure. */
    }
    throw error;
  }
}

// Wave ports are optional at open so legacy injected contracts keep working;
// every wave operation requires them explicitly.
export function port(ctx, name) {
  requireValue(typeof ctx.contracts[name] === 'function', 'contracts_invalid');
  return ctx.contracts[name];
}

export const isWave = (ctx, project) =>
  typeof ctx.contracts.isWaveProject === 'function' && ctx.contracts.isWaveProject(project) === true;

export const bytes = (ctx, kind, value) => {
  ctx.validation.safe(value);
  return ctx.contracts.directorBytes(kind, value, ctx.options);
};

export const recordHash = (ctx, kind, value) => hash(bytes(ctx, kind, value));

export const body = (ctx, kind, value) => bytes(ctx, kind, value).toString('utf8');

function decode(ctx, kind, text) {
  try {
    return ctx.validation.validated(kind, text);
  } catch {
    fail('database_corrupt');
  }
}

export function get(ctx, projectId, kind, id) {
  const row = ctx.db
    .prepare('SELECT body FROM kodo_project_records WHERE project_id=? AND kind=? AND id=?')
    .get(projectId, kind, id);
  requireValue(row, 'entity_not_found');
  const record = decode(ctx, kind, row.body);
  requireValue(
    record.projectId === projectId && (kind === 'project' ? record.projectId : record.id) === id,
    'database_corrupt',
  );
  if (kind === 'project') requireValue(record.projectKey === identity(record.root), 'database_corrupt');
  return record;
}

export function put(ctx, kind, record, insert = false) {
  const id = kind === 'project' ? record.projectId : record.id;
  if (insert)
    ctx.db
      .prepare('INSERT INTO kodo_project_records VALUES(?,?,?,?)')
      .run(record.projectId, kind, id, body(ctx, kind, record));
  else {
    const result = ctx.db
      .prepare('UPDATE kodo_project_records SET body=? WHERE project_id=? AND kind=? AND id=?')
      .run(body(ctx, kind, record), record.projectId, kind, id);
    requireValue(result.changes === 1, 'entity_not_found');
  }
}

export function attemptRecord(ctx, row) {
  if (!row) return null;
  const value = decode(ctx, 'attempt', row.body);
  requireValue(
    value.id === row.id &&
      value.projectId === row.project_id &&
      value.taskId === row.task_id &&
      value.runId === row.run_id &&
      value.number === row.number &&
      [0, 1].includes(row.installed),
    'database_corrupt',
  );
  return value;
}

export function currentAttempt(ctx, projectId, taskId) {
  const slot = ctx.db
    .prepare('SELECT attempt_id FROM kodo_project_current WHERE project_id=? AND task_id=?')
    .get(projectId, taskId);
  if (!slot) return null;
  const row = ctx.db.prepare('SELECT * FROM kodo_project_attempts WHERE id=?').get(slot.attempt_id),
    value = attemptRecord(ctx, row);
  requireValue(value && value.projectId === projectId && value.taskId === taskId, 'database_corrupt');
  return value;
}

export function writeAttempt(ctx, attempt, insert = false) {
  if (insert)
    ctx.db
      .prepare('INSERT INTO kodo_project_attempts(id,project_id,task_id,number,run_id,body) VALUES(?,?,?,?,?,?)')
      .run(attempt.id, attempt.projectId, attempt.taskId, attempt.number, attempt.runId, body(ctx, 'attempt', attempt));
  else
    requireValue(
      ctx.db
        .prepare('UPDATE kodo_project_attempts SET body=? WHERE id=?')
        .run(body(ctx, 'attempt', attempt), attempt.id).changes === 1,
      'entity_not_found',
    );
}

export function readSnapshot(ctx, projectId) {
  requireValue(uuid(projectId), 'query_invalid');
  const project = get(ctx, projectId, 'project', projectId);
  const completeness = {};
  const readSet = (key, query, parameters, parser) => {
    const total = ctx.db.prepare('SELECT COUNT(*) AS total FROM (' + query + ')').get(...parameters).total;
    const values = ctx.db
      .prepare(query + ' LIMIT 1000')
      .all(...parameters)
      .map(parser);
    completeness[key] = { total, returned: values.length, complete: total === values.length };
    return values;
  };
  const sets = {};
  for (const kind of children) {
    sets[kind + 's'] = readSet(
      kind + 's',
      'SELECT id,body FROM kodo_project_records WHERE project_id=? AND kind=? ORDER BY id',
      [projectId, kind],
      row => {
        const record = decode(ctx, kind, row.body);
        requireValue(record.projectId === projectId && record.id === row.id, 'database_corrupt');
        return record;
      },
    );
  }
  const currentAttempts = readSet(
    'currentAttempts',
    'SELECT a.* FROM kodo_project_current c JOIN kodo_project_attempts a ON a.id=c.attempt_id AND a.project_id=c.project_id AND a.task_id=c.task_id WHERE c.project_id=? ORDER BY c.task_id',
    [projectId],
    row => {
      const value = attemptRecord(ctx, row);
      requireValue(value.projectId === projectId, 'database_corrupt');
      return value;
    },
  );
  requireValue(
    ctx.db.prepare('SELECT COUNT(*) AS n FROM kodo_project_current WHERE project_id=?').get(projectId).n ===
      completeness.currentAttempts.total,
    'database_corrupt',
  );
  const riskApprovals = readSet(
    'riskApprovals',
    "SELECT a.* FROM kodo_project_approvals a JOIN kodo_project_records t ON t.project_id=a.project_id AND t.kind='task' AND t.id=a.task_id AND json_extract(t.body,'$.revision')=a.task_revision WHERE a.project_id=? ORDER BY a.task_id",
    [projectId],
    row => {
      const value = decode(ctx, 'riskApproval', row.body);
      requireValue(
        value.projectId === projectId && value.taskId === row.task_id && value.taskRevision === row.task_revision,
        'database_corrupt',
      );
      return value;
    },
  );
  // Wave gates are read in the same transaction; legacy snapshots have no key.
  const gates = isWave(ctx, project)
    ? {
        gates: readSet(
          'gates',
          "SELECT id,body FROM kodo_project_records WHERE project_id=? AND kind='gate' ORDER BY json_extract(body,'$.number'),id",
          [projectId],
          row => {
            const gate = decode(ctx, 'gate', row.body);
            requireValue(gate.projectId === projectId && gate.id === row.id, 'database_corrupt');
            return gate;
          },
        ),
      }
    : {};
  const value = {
    schemaVersion: 1,
    project,
    revision: project.revision,
    ...sets,
    currentAttempts,
    riskApprovals,
    completeness,
    ...gates,
  };
  // Counts, relational columns and bodies are still read/checked in this SQL
  // transaction. Only an exact aggregate may reuse its pure validation result.
  return ctx.validation.validated('snapshot', JSON.stringify(value), () => value);
}

export function snapshot(ctx, projectId) {
  return transaction(ctx.db, 'BEGIN', () => readSnapshot(ctx, projectId));
}

export function history(ctx, projectId, { after = 0, limit = 1000 } = {}) {
  requireValue(
    uuid(projectId) &&
      Number.isSafeInteger(after) &&
      after >= 0 &&
      Number.isSafeInteger(limit) &&
      limit >= 1 &&
      limit <= 1000,
    'query_invalid',
  );
  return transaction(ctx.db, 'BEGIN', () => {
    const project = get(ctx, projectId, 'project', projectId);
    const total = ctx.db
      .prepare('SELECT COUNT(*) AS n FROM kodo_project_events WHERE project_id=? AND seq>?')
      .get(projectId, after).n;
    const events = ctx.db
      .prepare('SELECT seq,body FROM kodo_project_events WHERE project_id=? AND seq>? ORDER BY seq LIMIT ?')
      .all(projectId, after, limit)
      .map(row => {
        const event = decode(ctx, 'event', row.body);
        requireValue(event.seq === row.seq && event.projectId === projectId, 'database_corrupt');
        return event;
      });
    return {
      schemaVersion: 1,
      projectId,
      revision: project.revision,
      events,
      total,
      complete: events.length === total,
      nextAfter: events.at(-1)?.seq ?? after,
    };
  });
}

export function replay(ctx, namespace, commandId, payloadHash) {
  const row = ctx.db
    .prepare('SELECT payload_hash,body FROM kodo_project_commands WHERE namespace=? AND command_id=?')
    .get(namespace, commandId);
  if (!row) return null;
  requireValue(row.payload_hash === payloadHash, 'command_conflict');
  let result;
  try {
    result = JSON.parse(row.body);
    ctx.validation.safe(result);
  } catch {
    fail('database_corrupt');
  }
  requireValue(
    result?.schemaVersion === 1 &&
      uuid(result.projectId) &&
      Number.isSafeInteger(result.revision) &&
      result.revision > 0 &&
      result.replayed === false,
    'database_corrupt',
  );
  return { ...result, replayed: true };
}

export function complete(ctx, s) {
  requireValue(
    Object.values(s.completeness).every(count => count.complete && count.total === count.returned),
    'snapshot_incomplete',
  );
}

export function control(ctx, project) {
  requireValue(!project.paused && !['cancelled', 'failed', 'released'].includes(project.status), 'control_blocked');
}

export function frozenAttempt(ctx, attempt, task) {
  requireValue(
    task &&
      attempt.taskRevision === task.revision &&
      attempt.contractHash === ctx.contracts.directorContractHash(task, ctx.options),
    'binding_conflict',
  );
}

export function metadata(ctx, projectId, now) {
  return {
    schemaVersion: 1,
    projectId,
    revision: 1,
    status: 'proposed',
    createdAt: now,
    updatedAt: now,
    evidence: [],
    mappings: [],
  };
}

export function addEvent(ctx, command, kind, record, previous, now) {
  const nextHash = recordHash(ctx, kind, record),
    previousHash = previous ? recordHash(ctx, kind, previous) : null;
  const seq = ctx.db
    .prepare('INSERT INTO kodo_project_events(project_id,body) VALUES(?,?)')
    .run(record.projectId, '{}').lastInsertRowid;
  const event = {
    schemaVersion: 1,
    seq: Number(seq),
    projectId: record.projectId,
    at: now,
    commandId: command.commandId,
    actor: command.actor,
    reason: command.reason,
    entity: { kind, id: kind === 'project' ? record.projectId : record.id },
    type: command.action.op,
    previousHash,
    nextHash,
  };
  ctx.db.prepare('UPDATE kodo_project_events SET body=? WHERE seq=?').run(body(ctx, 'event', event), seq);
  return event.entity;
}

export function assertGraph(ctx, s) {
  complete(ctx, s);
  const milestones = new Set(s.milestones.map(item => item.id)),
    epics = new Map(s.epics.map(item => [item.id, item]));
  const tasks = new Map(s.tasks.map(item => [item.id, item]));
  requireValue(tasks.size <= 1000, 'task_limit');
  for (const epic of epics.values()) requireValue(milestones.has(epic.milestoneId), 'parent_invalid');
  for (const task of tasks.values()) {
    requireValue(
      epics.has(task.epicId) && task.dependsOn.every(id => tasks.has(id) && id !== task.id),
      'dependency_invalid',
    );
  }
  const visiting = new Set(),
    visited = new Set();
  const visit = id => {
    requireValue(!visiting.has(id), 'dependency_cycle');
    if (visited.has(id)) return;
    visiting.add(id);
    for (const parent of tasks.get(id).dependsOn) visit(parent);
    visiting.delete(id);
    visited.add(id);
  };
  for (const id of tasks.keys()) visit(id);
  // A wave epic is gated after the epics it depends on: an epic cycle would never be gated.
  // A wave container without work is never gated and would block its parent for good. Checked
  // after every mutation (create, insert, amend, appendMilestone), inside the transaction.
  const empty = isWave(ctx, s.project) ? port(ctx, 'emptyContainers')(s.milestones, s.epics, s.tasks) : [];
  if (empty.length)
    throw Object.assign(
      new Error(`Project container without work: ${empty.map(c => `${c.kind} ${c.id}`).join(', ')}`),
      {
        code: 'project_container_empty',
        containers: empty,
      },
    );
  const cycle = isWave(ctx, s.project) ? port(ctx, 'epicCycle')(s.epics, s.tasks) : null;
  if (cycle)
    throw Object.assign(new Error(`Project epic dependency cycle ${cycle.join(' -> ')}`), {
      code: 'project_epic_cycle',
      epics: cycle,
    });
}

// Per-op project commands inside the apply() transaction. Each handler may set
// change.kind/previous/record/attempt; apply() then bumps the project revision.
