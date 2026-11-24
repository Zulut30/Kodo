/**
 * The integration queue of wave projects: verified task heads wait here for their merge into the
 * integration branch instead of each submission waiting for lease `project-integration:<id>`.
 *
 * Rows live in the state home's SQLite (the project store's connection) in their own versioned
 * table, created by this module's migration (`kodo_integration_queue_migrations`, the version and
 * digest pattern of the project store); the project store's own migration is untouched.
 *
 * Order: `priority` (higher first; a run profile may later pass a critical-path weight, 0 by
 * default), then the order of enqueueing. A drain claims a batch of consecutive queued rows with
 * disjoint write paths and integrates them one after another under one hold of the integration
 * lease (the caller holds it). Each row ends `integrated`, `rejected` (the integration refused
 * this task, e.g. `project_integration_conflict`; the others go on) or `failed` (an error).
 * A drain that stopped mid-batch (crash) leaves rows `merging`: the next drain integrates them
 * first, and the integration step is idempotent (a recorded merge is never repeated).
 */
import { createHash, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { scopesOverlap } from './contracts.mjs';

const fail = code => {
  throw Object.assign(new Error(`Project ${code}`), { code: `project_${code}` });
};
const need = (value, code) => {
  if (!value) fail(code);
};

const migrationSql = `
  CREATE TABLE kodo_integration_queue (
    seq INTEGER PRIMARY KEY AUTOINCREMENT, project_id TEXT NOT NULL, task_id TEXT NOT NULL,
    attempt_id TEXT NOT NULL, run_id TEXT NOT NULL, head_sha TEXT NOT NULL,
    priority INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL, batch_id TEXT,
    enqueued_at TEXT NOT NULL, updated_at TEXT NOT NULL, outcome TEXT NOT NULL,
    UNIQUE(project_id,run_id,head_sha));
  CREATE INDEX kodo_integration_queue_order ON kodo_integration_queue(project_id,status,priority,seq);
`;
const migrationHash = createHash('sha256').update(migrationSql).digest('hex');
const MIGRATION_VERSION = 1;

/** Queue row states; `integrated`, `rejected` and `failed` are terminal. */
export const QUEUE_STATES = ['queued', 'merging', 'integrated', 'rejected', 'failed'];
const terminal = new Set(['integrated', 'rejected', 'failed']);
const MAX_PRIORITY = 1000000;

function transaction(db, operation) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = operation();
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

function migrate(db) {
  need(!db.isTransaction, 'transaction_active');
  const table = name => db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);
  const latest = () =>
    table('kodo_integration_queue_migrations')
      ? db.prepare('SELECT version,digest FROM kodo_integration_queue_migrations ORDER BY version DESC LIMIT 1').get()
      : null;
  const check = row => {
    need(row.version === MIGRATION_VERSION && row.digest === migrationHash, 'integration_queue_unsupported');
    need(table('kodo_integration_queue'), 'database_corrupt');
  };
  const current = latest();
  if (current) return check(current);
  transaction(db, () => {
    const raced = latest();
    if (raced) return check(raced);
    db.exec(
      'CREATE TABLE IF NOT EXISTS kodo_integration_queue_migrations(version INTEGER PRIMARY KEY,digest TEXT NOT NULL,installed_at TEXT NOT NULL)',
    );
    db.exec(migrationSql);
    db.prepare('INSERT INTO kodo_integration_queue_migrations VALUES(?,?,?)').run(
      MIGRATION_VERSION,
      migrationHash,
      new Date().toISOString(),
    );
  });
}

const entryOf = row =>
  row && {
    seq: Number(row.seq),
    projectId: row.project_id,
    taskId: row.task_id,
    attemptId: row.attempt_id,
    runId: row.run_id,
    headSha: row.head_sha,
    priority: Number(row.priority),
    status: row.status,
    batchId: row.batch_id ?? null,
    enqueuedAt: row.enqueued_at,
    updatedAt: row.updated_at,
    outcome: JSON.parse(row.outcome),
  };

const ORDER = 'ORDER BY priority DESC, seq ASC';

/**
 * The integration queue on the legacy Store's SQLite connection (migrated on first open).
 * @param {{ db: any }} store
 */
export function openIntegrationQueue(store) {
  need(store?.db, 'store_invalid');
  const db = store.db;
  migrate(db);
  const now = () => new Date().toISOString();
  const select = (where, ...values) =>
    db
      .prepare(`SELECT * FROM kodo_integration_queue WHERE ${where} ${ORDER}`)
      .all(...values)
      .map(entryOf);
  const queue = {
    /** @param {number} seq */
    get: seq => entryOf(db.prepare('SELECT * FROM kodo_integration_queue WHERE seq=?').get(seq)),
    /** Every row of the project in queue order. @param {string} projectId */
    list: projectId => select('project_id=?', projectId),
    /** Rows a stopped drain left `merging`. @param {string} projectId */
    orphans: projectId => select("project_id=? AND status='merging'", projectId),
    /**
     * Queue a verified head. A repeat returns the live or integrated row; a rejected or failed
     * row is replaced by a new one at the end of its priority.
     * @param {{ projectId: string, taskId: string, attemptId: string, runId: string, headSha: string,
     *   priority?: number }} input
     */
    enqueue(input) {
      const { projectId, taskId, attemptId, runId, headSha, priority = 0 } = input;
      need(
        [projectId, taskId, attemptId, runId, headSha].every(value => typeof value === 'string' && value) &&
          Number.isSafeInteger(priority) &&
          Math.abs(priority) <= MAX_PRIORITY,
        'integration_queue_invalid',
      );
      return transaction(db, () => {
        const existing = entryOf(
          db
            .prepare('SELECT * FROM kodo_integration_queue WHERE project_id=? AND run_id=? AND head_sha=?')
            .get(projectId, runId, headSha),
        );
        if (existing && !['rejected', 'failed'].includes(existing.status)) return existing;
        if (existing) db.prepare('DELETE FROM kodo_integration_queue WHERE seq=?').run(existing.seq);
        const at = now();
        const { lastInsertRowid } = db
          .prepare(
            "INSERT INTO kodo_integration_queue(project_id,task_id,attempt_id,run_id,head_sha,priority,status,batch_id,enqueued_at,updated_at,outcome) VALUES(?,?,?,?,?,?,'queued',NULL,?,?,'{}')",
          )
          .run(projectId, taskId, attemptId, runId, headSha, priority, at, at);
        return queue.get(Number(lastInsertRowid));
      });
    },
    /**
     * Claim the next batch: queued rows in queue order whose write paths (`scopeOf(entry)`, null
     * when unknown) overlap no row already in the batch, at most `maxBatch`.
     * @param {string} projectId
     * @param {{ scopeOf?: (entry: any) => string[] | null, maxBatch?: number }} [options]
     */
    claim(projectId, { scopeOf = () => null, maxBatch = 16 } = {}) {
      return transaction(db, () => {
        const batchId = randomUUID(),
          batch = [],
          scopes = [];
        for (const entry of select("project_id=? AND status='queued'", projectId)) {
          if (batch.length >= maxBatch) break;
          const scope = scopeOf(entry);
          if (scope && scopes.some(other => scopesOverlap(other, scope))) continue;
          if (scope) scopes.push(scope);
          batch.push(entry);
        }
        const at = now();
        const claim = db.prepare(
          "UPDATE kodo_integration_queue SET status='merging',batch_id=?,updated_at=? WHERE seq=? AND status='queued'",
        );
        for (const entry of batch) claim.run(batchId, at, entry.seq);
        return batch.map(entry => queue.get(entry.seq));
      });
    },
    /**
     * Record the outcome of a `merging` row (`integrated`, `rejected` or `failed`); a repeat is a no-op.
     * @param {number} seq
     * @param {{ status: string, [key: string]: any }} outcome
     */
    finish(seq, outcome) {
      need(terminal.has(outcome?.status), 'integration_queue_invalid');
      db.prepare(
        "UPDATE kodo_integration_queue SET status=?,outcome=?,updated_at=? WHERE seq=? AND status='merging'",
      ).run(outcome.status, JSON.stringify(outcome), now(), seq);
      return queue.get(seq);
    },
    /** Put an unstarted `merging` row back in the queue (a drain stopped before it). @param {number} seq */
    release(seq) {
      db.prepare(
        "UPDATE kodo_integration_queue SET status='queued',batch_id=NULL,updated_at=? WHERE seq=? AND status='merging'",
      ).run(now(), seq);
    },
  };
  return queue;
}

/** Whether a queue row reached its end. @param {{ status: string }} entry */
export const queueEntryDone = entry => terminal.has(entry.status);

/**
 * Drain the project's queue: rows a stopped drain left `merging` first, then batches of queued
 * rows with disjoint write paths, each integrated by `integrate(entry)` (idempotent: it must
 * recognize a merge it already made). The caller holds the integration lease for the whole drain.
 * At most `maxBatches` batches per call, so one holder never keeps the leases for an endless
 * stream of submissions. A cancelled `signal` stops before the next row and returns the
 * unstarted rows to the queue.
 * @param {{ queue: ReturnType<typeof openIntegrationQueue>, projectId: string,
 *   integrate: (entry: any) => Promise<{ status: string, [key: string]: any }>,
 *   scopeOf?: (entry: any) => string[] | null, maxBatch?: number, maxBatches?: number,
 *   signal?: AbortSignal }} input
 * @returns {Promise<any[]>} the finished rows in order
 */
export async function drainIntegrationQueue(input) {
  const { queue, projectId, integrate, scopeOf, maxBatch = 16, maxBatches = 4, signal } = input;
  const finished = [];
  for (let round = 0; round < maxBatches; round++) {
    const orphans = queue.orphans(projectId);
    const batch = orphans.length ? orphans : queue.claim(projectId, { scopeOf, maxBatch });
    if (!batch.length) return finished;
    for (const [index, entry] of batch.entries()) {
      if (signal?.aborted) {
        for (const rest of batch.slice(index)) queue.release(rest.seq);
        return finished;
      }
      let outcome;
      try {
        outcome = await integrate(entry);
        need(terminal.has(outcome?.status), 'integration_queue_invalid');
      } catch (error) {
        outcome = {
          status: 'failed',
          code: typeof error?.code === 'string' && /^[a-z][a-z0-9_]*$/.test(error.code) ? error.code : 'project_error',
        };
      }
      finished.push(queue.finish(entry.seq, outcome));
    }
  }
  return finished;
}

/**
 * Wait until queue row `seq` is finished, draining the queue whenever this caller can take the
 * leases (`tryDrain()` resolves true after a drain, false while another holder drains).
 * `project_integration_queue_cancelled` on `signal` and `project_integration_queue_timeout` after
 * `waitMs`: the row stays queued, and a repeated submission of the same head waits for it again.
 * @param {{ queue: ReturnType<typeof openIntegrationQueue>, seq: number, tryDrain: () => Promise<boolean>,
 *   signal?: AbortSignal, waitMs?: number, pollMs?: number, now?: () => number }} input
 */
export async function awaitIntegration({ queue, seq, tryDrain, signal, waitMs = 1800000, pollMs = 25, now }) {
  const clock = now ?? (() => Date.now());
  const deadline = clock() + waitMs;
  for (;;) {
    const entry = queue.get(seq);
    need(entry, 'integration_queue_missing');
    if (queueEntryDone(entry)) return entry;
    if (signal?.aborted) fail('integration_queue_cancelled');
    if (await tryDrain()) continue;
    if (clock() >= deadline) fail('integration_queue_timeout');
    await delay(pollMs, undefined, signal ? { signal } : undefined).catch(() => {});
  }
}
