import { validateExecutionProfile } from './execution-profile.mjs';
import { backup } from 'node:sqlite';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, lstatSync, realpathSync, chmodSync } from 'node:fs';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { redact, workerEnvironment } from './security.mjs';
import { execute } from './command.mjs';
import { assertPrivateArtifactPath } from './progress.mjs';
import { gateRange } from './project-integration.mjs';
import { assertFence } from './lease-fence.mjs';

const fail = code => {
  throw Object.assign(new Error('Project ' + code), { code: 'project_' + code });
};
const requireValue = (condition, code = 'record_invalid') => {
  if (!condition) fail(code);
};
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const uuid = value =>
  typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
const canonicalRoot = value => realpathSync.native(value);
const identity = value => {
  const root = canonicalRoot(value);
  return process.platform === 'win32' ? root.toLowerCase() : root;
};
const forwardStates = new Set(['ready', 'running', 'verifying', 'integrated', 'accepted', 'released']);
const retryStates = new Set(['blocked', 'failed', 'cancelled']);
const settledStates = new Set(['blocked', 'failed', 'cancelled', 'accepted', 'released']);
const children = ['milestone', 'epic', 'task'];
const mergeBy = (previous, next, key) => [
  ...new Map([...previous, ...next].map(value => [value[key], value])).values(),
];
const migrationSql = `
  CREATE TABLE kodo_project_records (
    project_id TEXT NOT NULL, kind TEXT NOT NULL, id TEXT NOT NULL, body TEXT NOT NULL,
    PRIMARY KEY(project_id,kind,id));
  CREATE TABLE kodo_project_attempts (
    id TEXT PRIMARY KEY, project_id TEXT NOT NULL, task_id TEXT NOT NULL, number INTEGER NOT NULL,
    run_id TEXT NOT NULL UNIQUE, installed INTEGER NOT NULL DEFAULT 0, body TEXT NOT NULL,
    UNIQUE(project_id,task_id,number));
  CREATE TABLE kodo_project_current (
    project_id TEXT NOT NULL, task_id TEXT NOT NULL, attempt_id TEXT NOT NULL UNIQUE,
    PRIMARY KEY(project_id,task_id));
  CREATE TABLE kodo_project_approvals (
    project_id TEXT NOT NULL, task_id TEXT NOT NULL, task_revision INTEGER NOT NULL, body TEXT NOT NULL,
    PRIMARY KEY(project_id,task_id,task_revision));
  CREATE TABLE kodo_project_commands (
    namespace TEXT NOT NULL, command_id TEXT NOT NULL, payload_hash TEXT NOT NULL, body TEXT NOT NULL,
    PRIMARY KEY(namespace,command_id));
  CREATE TABLE kodo_project_events (
    seq INTEGER PRIMARY KEY AUTOINCREMENT, project_id TEXT NOT NULL, body TEXT NOT NULL);
  CREATE INDEX kodo_project_event_project ON kodo_project_events(project_id,seq);
  CREATE INDEX kodo_project_attempt_task ON kodo_project_attempts(project_id,task_id,number);
`;
const migrations = [
  migrationSql,
  'CREATE TABLE kodo_project_profiles(project_id TEXT PRIMARY KEY, body TEXT NOT NULL)',
];
function installedVersion(db) {
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='kodo_project_migrations'").get()) return 0;
  const rows = db.prepare('SELECT version,digest FROM kodo_project_migrations ORDER BY version').all();
  for (const [index, row] of rows.entries())
    requireValue(
      row.version === index + 1 && index < migrations.length && row.digest === hash(migrations[index]),
      'migration_unsupported',
    );
  return rows.length;
}

function transaction(db, mode, operation) {
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

async function migrate(store, skipMigration) {
  const db = store.db;
  requireValue(!db.isTransaction, 'transaction_active');
  requireValue(db.prepare('PRAGMA quick_check').get().quick_check === 'ok', 'database_corrupt');
  const current = installedVersion(db);
  if (current) {
    // Missing or altered tables/indexes are corruption, not permission to recreate them.
    for (const name of [
      'records',
      'attempts',
      'current',
      'approvals',
      'commands',
      'events',
      ...(current >= 2 ? ['profiles'] : []),
    ]) {
      requireValue(
        db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get('kodo_project_' + name),
        'database_corrupt',
      );
    }
    if (skipMigration || current === migrations.length) return;
  }
  requireValue(!skipMigration, 'migration_unsupported');
  const location = db.location();
  requireValue(typeof location === 'string' && path.isAbsolute(location), 'database_invalid');
  // Node's SQLite backup API includes committed WAL pages. Never copy a live main file.
  const directory = path.join(path.dirname(location), 'project-backups');
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  requireValue(lstatSync(directory).isDirectory() && !lstatSync(directory).isSymbolicLink(), 'backup_path_invalid');
  requireValue(identity(path.dirname(directory)) === identity(path.dirname(location)), 'backup_path_invalid');
  const owned = mkdtempSync(path.join(directory, 'migration-'));
  assertPrivateArtifactPath(owned);
  chmodSync(owned, 0o700);
  if (process.platform === 'win32') {
    const script =
      "$ErrorActionPreference='Stop'; try { $target=[Console]::In.ReadToEnd(); $user=[Security.Principal.WindowsIdentity]::GetCurrent().User; $acl=[Security.AccessControl.DirectorySecurity]::new(); $acl.SetOwner($user); $acl.SetAccessRuleProtection($true,$false); foreach($sid in @($user,[Security.Principal.SecurityIdentifier]::new('S-1-5-18'))) { $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($sid,'FullControl','ContainerInherit,ObjectInherit','None','Allow')) }; [IO.Directory]::SetAccessControl($target,$acl) } catch { exit 1 }";
    await execute(
      path.join(process.env.SystemRoot || 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe'),
      [
        '-NoLogo',
        '-NoProfile',
        '-NonInteractive',
        '-EncodedCommand',
        Buffer.from(script, 'utf16le').toString('base64'),
      ],
      { input: owned, env: workerEnvironment(), timeoutMs: 30000 },
    );
  }
  const destination = path.join(owned, `before-v${current + 1}.sqlite`);
  await backup(db, destination);
  chmodSync(destination, 0o600);
  // Failed DDL rolls back on this connection. Keep the backup for offline recovery;
  // automatic replacement of an open DB would discard newer writes.
  transaction(db, 'BEGIN IMMEDIATE', () => {
    const latest = installedVersion(db);
    db.exec(
      'CREATE TABLE IF NOT EXISTS kodo_project_migrations(version INTEGER PRIMARY KEY,digest TEXT NOT NULL,installed_at TEXT NOT NULL)',
    );
    for (const [index, sql] of migrations.entries()) {
      if (index < latest) continue;
      db.exec(sql);
      db.prepare('INSERT INTO kodo_project_migrations VALUES(?,?,?)').run(
        index + 1,
        hash(sql),
        new Date().toISOString(),
      );
    }
  });
}

// The Git range of a wave gate reservation in the project root (the default `gateRange` port).
const gitGateRange = async ({ root, baseSha, headSha, mergeCommits }) =>
  gateRange({ cwd: root, baseSha, headSha, mergeCommits });

/** Additive Project Director repository on the existing legacy Store connection.
 * `gateRange({ root, baseSha, headSha, mergeCommits })` (default: Git in the project root)
 * checks the commit range of a wave gate reservation before its transaction.
 * @param {{ store?: any, contracts?: any, authorizeTransition?: any, skipMigration?: boolean,
 *   gateRange?: (input: { root: string, baseSha: string, headSha: string, mergeCommits: string[] }) => Promise<boolean | Map<string, string[]> | null> }} [options]
 */
export async function openProjectStore({
  store,
  contracts,
  authorizeTransition,
  skipMigration = false,
  gateRange: range = gitGateRange,
} = {}) {
  requireValue(store?.db && typeof store.createRun === 'function', 'store_invalid');

  requireValue(authorizeTransition === undefined || typeof authorizeTransition === 'function', 'authorizer_invalid');
  requireValue(typeof range === 'function', 'store_invalid');

  contracts ??= await import('./project-contracts.mjs');

  for (const port of [
    'assertDirectorSafe',
    'normalizeDirectorRecord',
    'directorBytes',
    'directorContractHash',
    'buildDirectorTaskInput',
    'assertProjectTransition',
  ]) {
    requireValue(typeof contracts[port] === 'function', 'contracts_invalid');
  }

  const options = {
    knownValues: Object.values(store.secrets || {}).filter(value => typeof value === 'string' && value.length > 0),
  };

  const db = store.db;

  // Cache only validated persisted bytes, never caller-owned objects or revisions.
  // Both the encoded keys and detached values count toward the per-repository cap.
  const validationCache = new Map(),
    validationLimit = 8 * 1024 * 1024;

  let validationBytes = 0,
    validationSecrets = structuredClone(store.secrets || {});

  await migrate(store, skipMigration);
  const ctx = {
    store,
    contracts,
    authorizeTransition,
    gateRange: range,
    options,
    db,
    validationCache,
    validationLimit,
    validationBytes,
    validationSecrets,
  };
  return {
    getProfile: id => readProfile(ctx, id),
    setProfile: (id, profile) => transaction(db, 'BEGIN IMMEDIATE', () => writeProfile(ctx, id, profile)),
    pausePool: (id, subscription, until) =>
      transaction(db, 'BEGIN IMMEDIATE', () => {
        const profile = readProfile(ctx, id);
        const pool = profile?.subscriptions.find(row => row.id === subscription);
        requireValue(pool && typeof until === 'string', 'profile_invalid');
        pool.cooldownUntil = until;
        return writeProfile(ctx, id, profile);
      }),
    apply: (...args) => apply(ctx, ...args),
    snapshot: (...args) => snapshot(ctx, ...args),
    history: (...args) => history(ctx, ...args),
    installRun: (...args) => installRun(ctx, ...args),
    installGateRun: (...args) => installGateRun(ctx, ...args),
  };
}

// Wave ports are optional at open so legacy injected contracts keep working;
// every wave operation requires them explicitly.
function port(ctx, name) {
  requireValue(typeof ctx.contracts[name] === 'function', 'contracts_invalid');
  return ctx.contracts[name];
}

const isWave = (ctx, project) =>
  typeof ctx.contracts.isWaveProject === 'function' && ctx.contracts.isWaveProject(project) === true;

function refreshValidationContext(ctx) {
  if (isDeepStrictEqual(ctx.validationSecrets, ctx.store.secrets || {})) return;
  ctx.validationCache.clear();
  ctx.validationBytes = 0;
  ctx.validationSecrets = structuredClone(ctx.store.secrets || {});
  ctx.options.knownValues = Object.values(ctx.validationSecrets).filter(
    value => typeof value === 'string' && value.length > 0,
  );
}

function readProfile(ctx, id) {
  get(ctx, id, 'project', id);
  const row = ctx.db.prepare('SELECT body FROM kodo_project_profiles WHERE project_id=?').get(id);
  refreshValidationContext(ctx);
  if (!row) return null;
  try {
    return validateExecutionProfile(JSON.parse(row.body), ctx.options);
  } catch (error) {
    if (error?.code === 'project_unsafe') throw error;
    fail('database_corrupt');
  }
}
function writeProfile(ctx, id, profile) {
  requireValue(isWave(ctx, get(ctx, id, 'project', id)), 'wave_required');
  refreshValidationContext(ctx);
  const normalized = validateExecutionProfile(profile, ctx.options);
  ctx.db
    .prepare('INSERT INTO kodo_project_profiles VALUES(?,?) ON CONFLICT(project_id) DO UPDATE SET body=excluded.body')
    .run(id, JSON.stringify(normalized));
  return normalized;
}

function safe(ctx, value) {
  refreshValidationContext(ctx);
  ctx.contracts.assertDirectorSafe(value, ctx.options);
  requireValue(isDeepStrictEqual(value, redact(value, ctx.store.secrets || {})), 'secret_redaction_required');
}

function normalize(ctx, kind, value) {
  safe(ctx, value);
  const normalized = ctx.contracts.normalizeDirectorRecord(kind, value, ctx.options);
  safe(ctx, normalized);
  return normalized;
}

const bytes = (ctx, kind, value) => {
  safe(ctx, value);
  return ctx.contracts.directorBytes(kind, value, ctx.options);
};

const recordHash = (ctx, kind, value) => hash(bytes(ctx, kind, value));

const body = (ctx, kind, value) => bytes(ctx, kind, value).toString('utf8');

function validated(ctx, kind, text, parse = () => JSON.parse(text)) {
  refreshValidationContext(ctx);
  const key = kind + '\0' + text,
    cached = ctx.validationCache.get(key);
  if (cached) {
    ctx.validationCache.delete(key);
    ctx.validationCache.set(key, cached);
    return structuredClone(cached.value);
  }
  const value = normalize(ctx, kind, parse());
  const size = Buffer.byteLength(key) + Buffer.byteLength(JSON.stringify(value));
  if (size <= ctx.validationLimit) {
    while (
      ctx.validationCache.size &&
      (ctx.validationCache.size >= 2048 || ctx.validationBytes + size > ctx.validationLimit)
    ) {
      const oldest = ctx.validationCache.keys().next().value;
      ctx.validationBytes -= ctx.validationCache.get(oldest).size;
      ctx.validationCache.delete(oldest);
    }
    ctx.validationCache.set(key, { value: structuredClone(value), size });
    ctx.validationBytes += size;
  }
  return value;
}

function decode(ctx, kind, text) {
  try {
    return validated(ctx, kind, text);
  } catch {
    fail('database_corrupt');
  }
}

function get(ctx, projectId, kind, id) {
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

function put(ctx, kind, record, insert = false) {
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

function attemptRecord(ctx, row) {
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

function currentAttempt(ctx, projectId, taskId) {
  const slot = ctx.db
    .prepare('SELECT attempt_id FROM kodo_project_current WHERE project_id=? AND task_id=?')
    .get(projectId, taskId);
  if (!slot) return null;
  const row = ctx.db.prepare('SELECT * FROM kodo_project_attempts WHERE id=?').get(slot.attempt_id),
    value = attemptRecord(ctx, row);
  requireValue(value && value.projectId === projectId && value.taskId === taskId, 'database_corrupt');
  return value;
}

function writeAttempt(ctx, attempt, insert = false) {
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

function readSnapshot(ctx, projectId) {
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
  return validated(ctx, 'snapshot', JSON.stringify(value), () => value);
}

function snapshot(ctx, projectId) {
  return transaction(ctx.db, 'BEGIN', () => readSnapshot(ctx, projectId));
}

function history(ctx, projectId, { after = 0, limit = 1000 } = {}) {
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

function replay(ctx, namespace, commandId, payloadHash) {
  const row = ctx.db
    .prepare('SELECT payload_hash,body FROM kodo_project_commands WHERE namespace=? AND command_id=?')
    .get(namespace, commandId);
  if (!row) return null;
  requireValue(row.payload_hash === payloadHash, 'command_conflict');
  let result;
  try {
    result = JSON.parse(row.body);
    safe(ctx, result);
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

function complete(ctx, s) {
  requireValue(
    Object.values(s.completeness).every(count => count.complete && count.total === count.returned),
    'snapshot_incomplete',
  );
}

function control(ctx, project) {
  requireValue(!project.paused && !['cancelled', 'failed', 'released'].includes(project.status), 'control_blocked');
}

function frozenAttempt(ctx, attempt, task) {
  requireValue(
    task &&
      attempt.taskRevision === task.revision &&
      attempt.contractHash === ctx.contracts.directorContractHash(task, ctx.options),
    'binding_conflict',
  );
}

function metadata(ctx, projectId, now) {
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

function addEvent(ctx, command, kind, record, previous, now) {
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

function assertGraph(ctx, s) {
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
    safe(ctx, ctx.contracts.buildDirectorTaskInput({ project, task }, ctx.options));
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
    if (
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
    let commit = saved.target;
    // A fast-forward return may publish several repair commits.
    while (history.has(commit) && commit !== saved.before) {
      origins.set(commit, { kind: 'gate', ref: gate.id, writePaths });
      commit = history.get(commit)[0];
    }
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
async function assertGateAncestry(ctx, command) {
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

const operations = {
  setPaused: applySetPaused,
  insert: applyRecordEdit,
  amend: applyRecordEdit,
  approveRisk: applyRiskApproval,
  reserveAttempt: applyReserveAttempt,
  transition: applyTransition,
  appendMilestone: applyAppendMilestone,
  reserveGate: applyReserveGate,
};

async function apply(ctx, input) {
  safe(ctx, input);
  // Canonicalize before shared command encoding, including creation replay.
  let raw = normalize(ctx, 'command', input);
  const displayRoot = raw.action.op === 'create' ? raw.action.spec.root : null;
  if (raw.action.op === 'create') {
    requireValue(typeof displayRoot === 'string' && path.isAbsolute(displayRoot), 'project_identity');
    raw = { ...raw, action: { ...raw.action, spec: { ...raw.action.spec, root: identity(displayRoot) } } };
  }
  const command = normalize(ctx, 'command', raw),
    { action } = command;
  const namespace = action.op === 'create' ? 'root:' + identity(action.spec.root) : 'project:' + command.projectId;
  const payloadHash = recordHash(ctx, 'command', command);
  const prior = replay(ctx, namespace, command.commandId, payloadHash);
  if (prior) return prior;
  const history = action.op === 'reserveGate' ? await assertGateAncestry(ctx, command) : null;
  let authorizedSnapshot = null;
  if (action.op === 'transition' && forwardStates.has(action.to)) {
    requireValue(typeof ctx.authorizeTransition === 'function', 'authorization_required');
    authorizedSnapshot = snapshot(ctx, command.projectId);
    complete(ctx, authorizedSnapshot);
    requireValue(authorizedSnapshot.revision === command.expectedRevision, 'revision_conflict');
    control(ctx, authorizedSnapshot.project);
    // Trusted ports receive detached values. No mutable caller data survives the await.
    const pending = ctx.authorizeTransition({
      command: structuredClone(command),
      snapshot: structuredClone(authorizedSnapshot),
    });
    requireValue(pending && typeof pending.then === 'function', 'authorization_denied');
    const decision = await pending;
    requireValue(decision === undefined, 'authorization_denied');
  }
  return transaction(ctx.db, 'BEGIN IMMEDIATE', () => {
    // A lease holder's command is fenced: its leases must still be live (runtime/lease-fence.mjs).
    assertFence(ctx.db);
    const repeated = replay(ctx, namespace, command.commandId, payloadHash);
    if (repeated) return repeated;
    const now = new Date().toISOString();
    let project,
      record,
      previous = null,
      kind = action.kind,
      attempt = null;
    if (action.op === 'create') {
      requireValue(command.projectId === null && command.expectedRevision === null, 'revision_conflict');
      const spec = action.spec,
        projectId = randomUUID();
      const { milestones, epics, tasks, ...header } = spec;
      project = {
        ...header,
        root: displayRoot,
        ...metadata(ctx, projectId, now),
        projectKey: identity(spec.root),
        paused: false,
      };
      put(ctx, 'project', project, true);
      for (const [childKind, list] of [
        ['milestone', milestones],
        ['epic', epics],
        ['task', tasks],
      ]) {
        for (const child of list) put(ctx, childKind, { ...child, ...metadata(ctx, projectId, now) }, true);
      }
      kind = 'project';
      record = project;
    } else {
      project = get(ctx, command.projectId, 'project', command.projectId);
      requireValue(project.revision === command.expectedRevision, 'revision_conflict');
      if (authorizedSnapshot) {
        const current = readSnapshot(ctx, project.projectId);
        complete(ctx, current);
        control(ctx, project);
        requireValue(
          bytes(ctx, 'snapshot', current).equals(bytes(ctx, 'snapshot', authorizedSnapshot)),
          'authorization_stale',
        );
        for (const item of current.currentAttempts.filter(item => !settledStates.has(item.status)))
          frozenAttempt(
            ctx,
            item,
            current.tasks.find(task => task.id === item.taskId),
          );
      }
      const projectId = project.projectId;
      {
        const change = { kind, previous, record, attempt };
        if (!Object.hasOwn(operations, action.op)) fail('command_invalid');
        operations[action.op](ctx, { command, action, project, projectId, now, history }, change);
        ({ kind, previous, record, attempt } = change);
      }
      project = { ...(kind === 'project' ? record : project), revision: project.revision + 1, updatedAt: now };
      put(ctx, 'project', project);
      if (kind === 'project') record = project;
    }
    assertGraph(ctx, readSnapshot(ctx, project.projectId));
    const entity = addEvent(ctx, command, kind, record, previous, now);
    const result = {
      schemaVersion: 1,
      projectId: project.projectId,
      revision: project.revision,
      entity,
      attempt,
      replayed: false,
    };
    safe(ctx, result);
    ctx.db
      .prepare('INSERT INTO kodo_project_commands VALUES(?,?,?,?)')
      .run(namespace, command.commandId, payloadHash, JSON.stringify(result));
    return result;
  });
}

async function installRun(ctx, input) {
  // Installs are fenced like commands: a holder whose lease passed on installs nothing.
  safe(ctx, input);
  requireValue(
    input && Object.keys(input).length === 2 && Object.hasOwn(input, 'binding') && Object.hasOwn(input, 'runDraft'),
    'record_invalid',
  );
  const binding = normalize(ctx, 'installBinding', input.binding),
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
        bytes(ctx, 'installBinding', normalize(ctx, 'installBinding', runDraft.directorBinding)).equals(
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
          bytes(ctx, 'installBinding', normalize(ctx, 'installBinding', saved.directorBinding)).equals(
            bytes(ctx, 'installBinding', binding),
          ),
        'binding_conflict',
      );
      return saved;
    }
    requireValue(installed === 0 && attempt.status === 'reserved', 'binding_conflict');
    control(ctx, s.project);
    requireValue(validRunDraft(runDraft), 'run_draft_invalid');
    safe(ctx, runDraft);
    const saved = ctx.store.createRun(runDraft);
    requireValue(saved && typeof saved.then !== 'function' && isDeepStrictEqual(saved, runDraft), 'run_draft_invalid');
    ctx.db.prepare('UPDATE kodo_project_attempts SET installed=1 WHERE id=?').run(attempt.id);
    put(ctx, 'project', { ...s.project, revision: s.revision + 1, updatedAt: new Date().toISOString() });
    return saved;
  });
}

function savedRun(ctx, row) {
  let saved;
  try {
    saved = JSON.parse(row.body);
    safe(ctx, saved);
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
async function installGateRun(ctx, input) {
  safe(ctx, input);
  requireValue(
    input && Object.keys(input).length === 2 && Object.hasOwn(input, 'binding') && Object.hasOwn(input, 'runDraft'),
    'record_invalid',
  );
  const bindingFor = port(ctx, 'gateBindingFor'),
    gateInput = port(ctx, 'buildGateInput'),
    criteriaOf = port(ctx, 'gateContainerCriteria');
  const binding = normalize(ctx, 'gateBinding', input.binding),
    runDraft = structuredClone(input.runDraft);
  const bound = value =>
    bytes(ctx, 'gateBinding', normalize(ctx, 'gateBinding', value)).equals(bytes(ctx, 'gateBinding', binding));
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
    safe(ctx, runDraft);
    const saved = ctx.store.createRun(runDraft);
    requireValue(saved && typeof saved.then !== 'function' && isDeepStrictEqual(saved, runDraft), 'run_draft_invalid');
    const now = new Date().toISOString();
    put(ctx, 'gate', { ...gate, installed: true, updatedAt: now });
    put(ctx, 'project', { ...s.project, revision: s.revision + 1, updatedAt: now });
    return saved;
  });
}
