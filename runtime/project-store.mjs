import { validateExecutionProfile } from './execution-profile.mjs';
import { backup } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, lstatSync, chmodSync } from 'node:fs';
import path from 'node:path';
import { workerEnvironment } from './security.mjs';
import { execute } from './command.mjs';
import { assertPrivateArtifactPath } from './progress.mjs';
import { gateRange } from './project-integration.mjs';
import { assertFence } from './lease-fence.mjs';
import {
  metadata,
  hash,
  identity,
  forwardStates,
  settledStates,
  transaction,
  isWave,
  bytes,
  recordHash,
  get,
  put,
  readSnapshot,
  snapshot,
  history,
  replay,
  complete,
  control,
  frozenAttempt,
  addEvent,
  assertGraph,
} from './project-store-records.mjs';
import { fail, requireValue, createValidationCache } from './project-store-validation.mjs';
import { assertGateAncestry, operations, installRun, installGateRun } from './project-store-transitions.mjs';

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
 *   clock?: () => string,
 *   gateRange?: (input: { root: string, baseSha: string, headSha: string, mergeCommits: string[] }) => Promise<boolean | Map<string, string[]> | null> }} [options]
 */
export async function openProjectStore({
  store,
  contracts,
  authorizeTransition,
  skipMigration = false,
  clock = () => new Date().toISOString(),
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
  const validation = createValidationCache(store, contracts, options);

  await migrate(store, skipMigration);
  const ctx = {
    store,
    contracts,
    authorizeTransition,
    clock: typeof clock === 'function' ? clock : () => new Date().toISOString(),
    gateRange: range,
    options,
    db,
    validation,
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

function readProfile(ctx, id) {
  get(ctx, id, 'project', id);
  const row = ctx.db.prepare('SELECT body FROM kodo_project_profiles WHERE project_id=?').get(id);
  ctx.validation.refresh();
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
  ctx.validation.refresh();
  const normalized = validateExecutionProfile(profile, ctx.options);
  ctx.db
    .prepare('INSERT INTO kodo_project_profiles VALUES(?,?) ON CONFLICT(project_id) DO UPDATE SET body=excluded.body')
    .run(id, JSON.stringify(normalized));
  return normalized;
}

async function apply(ctx, input) {
  ctx.validation.safe(input);
  // Canonicalize before shared command encoding, including creation replay.
  let raw = ctx.validation.normalize('command', input);
  const displayRoot = raw.action.op === 'create' ? raw.action.spec.root : null;
  if (raw.action.op === 'create') {
    requireValue(typeof displayRoot === 'string' && path.isAbsolute(displayRoot), 'project_identity');
    raw = { ...raw, action: { ...raw.action, spec: { ...raw.action.spec, root: identity(displayRoot) } } };
  }
  const command = ctx.validation.normalize('command', raw),
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
    const now = ctx.clock();
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
    ctx.validation.safe(result);
    ctx.db
      .prepare('INSERT INTO kodo_project_commands VALUES(?,?,?,?)')
      .run(namespace, command.commandId, payloadHash, JSON.stringify(result));
    return result;
  });
}
