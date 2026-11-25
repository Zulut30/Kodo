/**
 * The integration queue of wave projects: verified task heads wait here for their merge into the
 * integration branch instead of each submission waiting for lease `project-integration:<id>`.
 *
 * Rows live in the state home's SQLite (the project store's connection) in their own versioned
 * table, created by this module's migration (`kodo_integration_queue_migrations`, the version and
 * digest pattern of the project store); the project store's own migration is untouched.
 *
 * Order: `priority` (higher first; a run profile may later pass a critical-path weight, 0 by
 * default), then the order of enqueueing. A drain claims consecutive queued rows in that order up
 * to the first one whose write paths overlap a claimed row (that row starts the next claim), and
 * integrates them one after another; the caller holds `project:<id>` and the integration lease,
 * at most `maxRows` rows per hold. Each row ends `integrated`, `rejected` (the integration refused
 * this task without a merge, e.g. `project_integration_conflict`; the others go on) or `failed`
 * (an error, or a merge whose transitions did not finish: a repeated submission recovers it).
 * Finished rows stay for their readers; a new submission of the same head gets a new row.
 * A drain that stopped mid-row (crash, lost lease) leaves the row `merging`: the next drain takes
 * it first, and the integration step is idempotent (a recorded merge is never repeated).
 */
import { createHash, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { scopesOverlap } from './contracts.mjs';
import { assertFence } from './lease-fence.mjs';

const fail = code => {
  throw Object.assign(new Error(`Project ${code}`), { code: `project_${code}` });
};
const need = (value, code) => {
  if (!value) fail(code);
};

const migrationSql = `
  CREATE TABLE kodo_integration_queue (
    seq INTEGER PRIMARY KEY AUTOINCREMENT, project_id TEXT NOT NULL, task_id TEXT NOT NULL,
    attempt_id TEXT NOT NULL, run_id TEXT NOT NULL, base_sha TEXT NOT NULL, head_sha TEXT NOT NULL,
    priority INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL, claim TEXT,
    enqueued_at TEXT NOT NULL, updated_at TEXT NOT NULL, outcome TEXT NOT NULL);
  CREATE UNIQUE INDEX kodo_integration_queue_active ON kodo_integration_queue(project_id,run_id,head_sha)
    WHERE status IN ('queued','merging');
  CREATE INDEX kodo_integration_queue_order ON kodo_integration_queue(project_id,status,priority,seq);
`;
const migrationHash = createHash('sha256').update(migrationSql).digest('hex');
const MIGRATION_VERSION = 1;

/** Queue row states; `integrated`, `rejected` and `failed` are terminal. */
export const QUEUE_STATES = ['queued', 'merging', 'integrated', 'rejected', 'failed'];
const terminal = new Set(['integrated', 'rejected', 'failed']);
const MAX_PRIORITY = 1000000;
/** Rows one drain integrates under one hold of its leases. */
export const DRAIN_ROWS = 4;

// One BEGIN IMMEDIATE transaction, fenced by the leases of the caller's async context
// (runtime/lease-fence.mjs): a drain whose lease passed to another holder writes nothing.
function transaction(db, operation) {
  db.exec('BEGIN IMMEDIATE');
  try {
    assertFence(db);
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
    baseSha: row.base_sha,
    headSha: row.head_sha,
    priority: Number(row.priority),
    status: row.status,
    claim: row.claim ?? null,
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
  const latestOf = (projectId, runId, headSha, statuses) =>
    entryOf(
      db
        .prepare(
          `SELECT * FROM kodo_integration_queue WHERE project_id=? AND run_id=? AND head_sha=? AND status IN (${statuses
            .map(() => '?')
            .join(',')}) ORDER BY seq DESC LIMIT 1`,
        )
        .get(projectId, runId, headSha, ...statuses),
    );
  const queue = {
    /** @param {number} seq */
    get: seq => entryOf(db.prepare('SELECT * FROM kodo_integration_queue WHERE seq=?').get(seq)),
    /** Every row of the project in queue order. @param {string} projectId */
    list: projectId => select('project_id=?', projectId),
    /** Rows a stopped drain left `merging`. @param {string} projectId */
    orphans: projectId => select("project_id=? AND status='merging'", projectId),
    /**
     * Take over at most `limit` rows a stopped drain left `merging` under the new `claim`: the old
     * drain can no longer finish or release them.
     * @param {string} projectId
     * @param {string} claim
     * @param {number} limit
     */
    adopt(projectId, claim, limit) {
      return transaction(db, () => {
        const rows = select("project_id=? AND status='merging'", projectId).slice(0, limit);
        const take = db.prepare(
          "UPDATE kodo_integration_queue SET claim=?,updated_at=? WHERE seq=? AND status='merging'",
        );
        const at = now();
        for (const entry of rows) take.run(claim, at, entry.seq);
        return rows.map(entry => queue.get(entry.seq));
      });
    },
    /**
     * Queue a verified head. A repeat returns the live (`queued`, `merging`) or integrated row of
     * this Run and head; after a rejected or failed row a new row is queued with a new `seq`
     * (the finished row stays for its readers).
     * @param {{ projectId: string, taskId: string, attemptId: string, runId: string, baseSha: string,
     *   headSha: string, priority?: number }} input
     */
    enqueue(input) {
      const { projectId, taskId, attemptId, runId, baseSha, headSha, priority = 0 } = input;
      need(
        [projectId, taskId, attemptId, runId, baseSha, headSha].every(value => typeof value === 'string' && value) &&
          Number.isSafeInteger(priority) &&
          Math.abs(priority) <= MAX_PRIORITY,
        'integration_queue_invalid',
      );
      return transaction(db, () => {
        const existing = latestOf(projectId, runId, headSha, ['queued', 'merging', 'integrated']);
        if (existing) return existing;
        const at = now();
        const { lastInsertRowid } = db
          .prepare(
            "INSERT INTO kodo_integration_queue(project_id,task_id,attempt_id,run_id,base_sha,head_sha,priority,status,claim,enqueued_at,updated_at,outcome) VALUES(?,?,?,?,?,?,?,'queued',NULL,?,?,'{}')",
          )
          .run(projectId, taskId, attemptId, runId, baseSha, headSha, priority, at, at);
        return queue.get(Number(lastInsertRowid));
      });
    },
    /**
     * Claim the next rows: queued rows in queue order, at most `maxBatch`, up to the first row whose
     * write paths (`scopeOf(entry)`, null when unknown) overlap a claimed row; that row is left
     * queued and heads the next claim, so priority and FIFO order hold.
     * @param {string} projectId
     * @param {{ scopeOf?: (entry: any) => string[] | null, maxBatch?: number, claim?: string }} [options]
     */
    claim(projectId, { scopeOf = () => null, maxBatch = DRAIN_ROWS, claim: claimId = randomUUID() } = {}) {
      return transaction(db, () => {
        const batch = [],
          scopes = [];
        for (const entry of select("project_id=? AND status='queued'", projectId)) {
          if (batch.length >= maxBatch) break;
          const scope = scopeOf(entry);
          if (scope && scopes.some(other => scopesOverlap(other, scope))) break;
          if (scope) scopes.push(scope);
          batch.push(entry);
        }
        const at = now();
        const claim = db.prepare(
          "UPDATE kodo_integration_queue SET status='merging',claim=?,updated_at=? WHERE seq=? AND status='queued'",
        );
        for (const entry of batch) claim.run(claimId, at, entry.seq);
        return batch.map(entry => queue.get(entry.seq));
      });
    },
    /**
     * Record the outcome of a `merging` row (`integrated`, `rejected` or `failed`) that `claim`
     * still holds; a repeat, or a drain whose row another drain took over, changes nothing.
     * Returns the row and whether this call finished it.
     * @param {number} seq
     * @param {string} claim
     * @param {{ status: string, [key: string]: any }} outcome
     */
    finish(seq, claim, outcome) {
      need(terminal.has(outcome?.status), 'integration_queue_invalid');
      const { changes } = transaction(db, () =>
        db
          .prepare(
            "UPDATE kodo_integration_queue SET status=?,outcome=?,updated_at=? WHERE seq=? AND claim=? AND status='merging'",
          )
          .run(outcome.status, JSON.stringify(outcome), now(), seq, claim),
      );
      return { entry: queue.get(seq), finished: changes > 0 };
    },
    /**
     * Finish the live rows of one Run and head with `outcome` (a replay found the completion that
     * a stopped drain recorded before it could finish its row).
     * @param {string} projectId
     * @param {string} runId
     * @param {string} headSha
     * @param {{ status: string, [key: string]: any }} outcome
     */
    settle(projectId, runId, headSha, outcome) {
      need(terminal.has(outcome?.status), 'integration_queue_invalid');
      transaction(db, () =>
        db
          .prepare(
            "UPDATE kodo_integration_queue SET status=?,outcome=?,updated_at=? WHERE project_id=? AND run_id=? AND head_sha=? AND status IN ('queued','merging')",
          )
          .run(outcome.status, JSON.stringify(outcome), now(), projectId, runId, headSha),
      );
    },
    /** Put a row `claim` took and never started back in the queue. @param {number} seq @param {string} claim */
    release(seq, claim) {
      transaction(db, () =>
        db
          .prepare(
            "UPDATE kodo_integration_queue SET status='queued',claim=NULL,updated_at=? WHERE seq=? AND claim=? AND status='merging'",
          )
          .run(now(), seq, claim),
      );
    },
  };
  return queue;
}

/** Whether a queue row reached its end. @param {{ status: string }} entry */
export const queueEntryDone = entry => terminal.has(entry.status);

const errorCode = error =>
  typeof error?.code === 'string' && /^[a-z][a-z0-9_]*$/.test(error.code) ? error.code : 'project_error';

/**
 * Drain the project's queue: rows a stopped drain left `merging` first, then claimed queued rows,
 * each integrated by `integrate(entry)` (idempotent: it must recognize a merge it already made);
 * at most `maxRows` rows in all, so one holder never keeps the leases for a stream of submissions.
 * The caller holds `project:<id>` and the integration lease. `stop()` is asked before every row
 * (a caller's cancel or deadline, a lost lease): it ends the drain between rows and returns the
 * rows it claimed that never started to the queue; rows found `merging` stay `merging` (taken over
 * with this drain's `claim`). A drain whose rows another drain took over can neither finish nor
 * release them, and its fenced writes fail once its lease passed on (`project_lease_lost` ends
 * the drain; the row stays `merging` for the current holder).
 * @param {{ queue: ReturnType<typeof openIntegrationQueue>, projectId: string,
 *   integrate: (entry: any) => Promise<{ status: string, [key: string]: any }>,
 *   scopeOf?: (entry: any) => string[] | null, maxRows?: number, stop?: () => boolean }} input
 * @returns {Promise<any[]>} the finished rows in order
 */
export async function drainIntegrationQueue(input) {
  const { queue, projectId, integrate, scopeOf, maxRows = DRAIN_ROWS, stop = () => false } = input;
  const claim = randomUUID(),
    finished = [];
  let budget = maxRows;
  while (budget > 0 && !stop()) {
    let adopted, claimed;
    try {
      adopted = queue.adopt(projectId, claim, budget);
      claimed = adopted.length ? [] : queue.claim(projectId, { scopeOf, maxBatch: budget, claim });
    } catch (error) {
      if (error?.code === 'project_lease_lost') return finished;
      throw error;
    }
    const rows = adopted.length ? adopted : claimed;
    if (!rows.length) break;
    for (const [index, entry] of rows.entries()) {
      if (index > 0 && stop()) {
        try {
          for (const rest of rows.slice(index)) if (claimed.includes(rest)) queue.release(rest.seq, claim);
        } catch (error) {
          // A drain whose lease passed on leaves its claimed rows to the current holder (adopt).
          if (error?.code !== 'project_lease_lost') throw error;
        }
        return finished;
      }
      let outcome;
      try {
        outcome = await integrate(entry);
        need(terminal.has(outcome?.status), 'integration_queue_invalid');
      } catch (error) {
        // A lost lease ends the drain: the row stays merging for the holder that has the leases now.
        // An unreadable integration branch is not an answer either: the row stays merging and a
        // later drain adopts it, instead of failing a merge that may already be published.
        if (['project_lease_lost', 'project_integration_unreadable'].includes(error?.code)) return finished;
        outcome = { status: 'failed', code: errorCode(error) };
      }
      let done;
      try {
        done = queue.finish(entry.seq, claim, outcome);
      } catch (error) {
        if (error?.code === 'project_lease_lost') return finished;
        throw error;
      }
      if (!done.finished) return finished;
      finished.push(done.entry);
      budget--;
    }
  }
  return finished;
}

/**
 * Wait until queue row `seq` is finished, draining the queue whenever this caller can take the
 * leases (`tryDrain(expired)` resolves true after a drain, false while another holder drains; the
 * drain asks `expired()` between rows). The deadline is absolute: it is checked before every
 * drain and after it. `project_integration_queue_cancelled` on `signal` and
 * `project_integration_queue_timeout` after `waitMs`: the row stays queued, and a repeated
 * submission of the same head waits for the same row.
 * @param {{ queue: ReturnType<typeof openIntegrationQueue>, seq: number,
 *   tryDrain: (expired: () => boolean) => Promise<boolean>, signal?: AbortSignal, waitMs?: number,
 *   pollMs?: number, now?: () => number }} input
 */
export async function awaitIntegration({ queue, seq, tryDrain, signal, waitMs = 1800000, pollMs = 25, now }) {
  const clock = now ?? (() => Date.now());
  const deadline = clock() + waitMs,
    expired = () => clock() >= deadline;
  for (;;) {
    const entry = queue.get(seq);
    need(entry, 'integration_queue_missing');
    if (queueEntryDone(entry)) return entry;
    if (signal?.aborted) fail('integration_queue_cancelled');
    if (expired()) fail('integration_queue_timeout');
    if (await tryDrain(expired)) continue;
    await delay(pollMs, undefined, signal ? { signal } : undefined).catch(() => {});
  }
}
