/** Durable jobs on the existing Store connection: idempotent enqueue, owned
 * leases with heartbeat, bounded retries and at-most-once integration. Every
 * decision is taken inside one `BEGIN IMMEDIATE` transaction, so several
 * processes sharing the state database cannot start or integrate a job twice.
 * Execution and integration themselves belong to the caller (see
 * `job-scheduler.mjs`); this module only records who owns what.
 */
import { createHash, randomUUID } from 'node:crypto';
import { statSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { redact } from './security.mjs';
import {
  MAX_JOB_BYTES,
  admission,
  assertJobTransition,
  hostStatus,
  normalizeJobSpec,
  rankJobs,
} from './job-contracts.mjs';

/** @typedef {import('./job-contracts.mjs').JobSpec} JobSpec */

/**
 * @typedef {object} Job
 * @property {string} id
 * @property {string} queue
 * @property {string} key
 * @property {number} seq
 * @property {string} state
 * @property {number} priority
 * @property {number} bypassed
 * @property {number} attempt Claims counted against the retry policy.
 * @property {number} revision
 * @property {JobSpec} spec
 * @property {string | null} reason
 * @property {string | null} leaseOwner
 * @property {number | null} leaseExpires
 * @property {number | null} retryAt
 * @property {Record<string, any> | null} checkpoint Partial progress kept across a quota wait.
 * @property {Record<string, any> | null} result
 * @property {Record<string, any> | null} integration Integration receipt.
 * @property {boolean} cancelRequested
 * @property {string} createdAt
 * @property {string} updatedAt
 */

/** @typedef {{ db: any, secrets: Record<string, string>, now: () => number }} JobContext */

export const MAX_QUEUE_JOBS = 1000;
export const MAX_QUOTA_WAITS = 12;
export const MAX_INTEGRATION_ATTEMPTS = 3;

const migrationSql = `
  CREATE TABLE kodo_jobs(
    id TEXT PRIMARY KEY, queue TEXT NOT NULL, key TEXT NOT NULL, seq INTEGER NOT NULL,
    state TEXT NOT NULL, priority INTEGER NOT NULL, bypassed INTEGER NOT NULL DEFAULT 0,
    attempt INTEGER NOT NULL DEFAULT 0, quota_waits INTEGER NOT NULL DEFAULT 0,
    integration_attempts INTEGER NOT NULL DEFAULT 0, revision INTEGER NOT NULL DEFAULT 1,
    spec TEXT NOT NULL, spec_hash TEXT NOT NULL,
    lease_owner TEXT, lease_token TEXT, lease_expires INTEGER,
    retry_at INTEGER, checkpoint TEXT, result TEXT, result_hash TEXT, result_token TEXT, verified_at INTEGER,
    integration TEXT, integration_hash TEXT, reason TEXT, cancel_requested INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
    UNIQUE(queue, key), UNIQUE(queue, seq));
  CREATE INDEX kodo_jobs_queue_state ON kodo_jobs(queue, state);
  CREATE TABLE kodo_job_events(
    seq INTEGER PRIMARY KEY AUTOINCREMENT, job_id TEXT NOT NULL, queue TEXT NOT NULL,
    type TEXT NOT NULL, data TEXT NOT NULL, time TEXT NOT NULL);
  CREATE INDEX kodo_job_events_job ON kodo_job_events(job_id);
`;
const sha256 = value => createHash('sha256').update(value).digest('hex');
const migrationHash = sha256(migrationSql);
const columns = new Set([
  'state',
  'bypassed',
  'attempt',
  'quota_waits',
  'integration_attempts',
  'lease_owner',
  'lease_token',
  'lease_expires',
  'retry_at',
  'checkpoint',
  'result',
  'result_hash',
  'result_token',
  'verified_at',
  'integration',
  'integration_hash',
  'reason',
  'cancel_requested',
]);
const noLease = { lease_owner: null, lease_token: null, lease_expires: null };

/** @returns {never} */
function fail(code, message = code) {
  throw Object.assign(new Error(`Job: ${message}`), { code: `job_${code}` });
}
const requireValue = (condition, code, message) => {
  if (!condition) fail(code, message);
};
const plain = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
/** @returns {any} */
const one = (ctx, sql, ...args) => ctx.db.prepare(sql).get(...args);
/** @returns {any[]} */
const all = (ctx, sql, ...args) => ctx.db.prepare(sql).all(...args);

function transaction(ctx, operation) {
  ctx.db.exec('BEGIN IMMEDIATE');
  try {
    const result = operation();
    ctx.db.exec('COMMIT');
    return result;
  } catch (error) {
    try {
      ctx.db.exec('ROLLBACK');
    } catch {
      /* Preserve the initiating failure. */
    }
    throw error;
  }
}

function migrate(ctx) {
  transaction(ctx, () => {
    ctx.db.exec(
      'CREATE TABLE IF NOT EXISTS kodo_job_migrations(version INTEGER PRIMARY KEY,digest TEXT NOT NULL,installed_at TEXT NOT NULL)',
    );
    const latest = one(ctx, 'SELECT version,digest FROM kodo_job_migrations ORDER BY version DESC LIMIT 1');
    if (latest) {
      requireValue(latest.version === 1 && latest.digest === migrationHash, 'migration_unsupported');
      return;
    }
    // Additive only: new tables beside the legacy runs/events/leases, which stay untouched.
    ctx.db.exec(migrationSql);
    ctx.db
      .prepare('INSERT INTO kodo_job_migrations VALUES(?,?,?)')
      .run(1, migrationHash, new Date(ctx.now()).toISOString());
  });
}

/** Caller data must already be free of configured secrets and bounded. */
function safeJson(ctx, value, what) {
  requireValue(plain(value), 'payload_invalid', `${what} must be an object`);
  let text;
  try {
    text = JSON.stringify(value);
  } catch {
    fail('payload_invalid', `${what} must be JSON`);
  }
  requireValue(Buffer.byteLength(text) <= MAX_JOB_BYTES, 'payload_invalid', `${what} is too large`);
  requireValue(isDeepStrictEqual(JSON.parse(text), redact(JSON.parse(text), ctx.secrets)), 'secret_redaction_required');
  return text;
}
/** Failure text comes from arbitrary errors: redact and bound instead of rejecting. */
const safeReason = (ctx, value) => (value == null ? null : String(redact(String(value), ctx.secrets)).slice(0, 500));
const lifetime = value => {
  const ttl = value ?? 60000;
  requireValue(Number.isInteger(ttl) && ttl >= 1 && ttl <= 3_600_000, 'lease_invalid', 'ttlMs must be 1..3600000');
  return ttl;
};
const ownerName = value => {
  requireValue(typeof value === 'string' && /^[\w.:@-]{1,120}$/.test(value), 'lease_invalid', 'owner is invalid');
  return value;
};
const queueName = value => {
  requireValue(typeof value === 'string' && /^[A-Za-z][\w.:-]{0,119}$/.test(value), 'queue_invalid');
  return value;
};

/** @returns {Job} */
function view(row) {
  const json = text => (text ? JSON.parse(text) : null);
  return {
    id: row.id,
    queue: row.queue,
    key: row.key,
    seq: row.seq,
    state: row.state,
    priority: row.priority,
    bypassed: row.bypassed,
    attempt: row.attempt,
    revision: row.revision,
    spec: JSON.parse(row.spec),
    reason: row.reason,
    leaseOwner: row.lease_owner,
    leaseExpires: row.lease_expires,
    retryAt: row.retry_at,
    checkpoint: json(row.checkpoint),
    result: json(row.result),
    integration: json(row.integration),
    cancelRequested: row.cancel_requested === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
const rowsOf = (ctx, queue) => all(ctx, 'SELECT * FROM kodo_jobs WHERE queue=? ORDER BY seq', queue);
function rowById(ctx, id) {
  const row = typeof id === 'string' ? one(ctx, 'SELECT * FROM kodo_jobs WHERE id=?', id) : undefined;
  requireValue(row, 'not_found');
  return row;
}

function record(ctx, row, type, data = {}) {
  ctx.db
    .prepare('INSERT INTO kodo_job_events(job_id,queue,type,data,time) VALUES(?,?,?,?,?)')
    .run(row.id, row.queue, type, JSON.stringify(data), new Date(ctx.now()).toISOString());
}

/** Compare-and-set one job row and append its status receipt. Returns the new row. */
function update(ctx, row, patch, event, data = {}) {
  if (patch.state !== undefined && patch.state !== row.state) assertJobTransition(row.state, patch.state);
  const names = Object.keys(patch);
  requireValue(
    names.every(name => columns.has(name)),
    'column_invalid',
  );
  const changed = ctx.db
    .prepare(
      `UPDATE kodo_jobs SET ${names.map(name => `${name}=?`).join(',')},revision=revision+1,updated_at=? WHERE id=? AND revision=?`,
    )
    .run(...names.map(name => patch[name]), new Date(ctx.now()).toISOString(), row.id, row.revision).changes;
  requireValue(changed === 1, 'revision_conflict');
  const next = rowById(ctx, row.id);
  record(ctx, next, event, { state: next.state, attempt: next.attempt, ...data });
  return next;
}

function assertAcyclic(specs) {
  const byKey = new Map(specs.map(spec => [spec.key, spec]));
  const done = new Set(),
    visiting = new Set();
  const visit = spec => {
    if (done.has(spec.key)) return;
    requireValue(!visiting.has(spec.key), 'dependency_cycle', spec.key);
    visiting.add(spec.key);
    for (const key of spec.dependsOn) {
      requireValue(byKey.has(key), 'dependency_unknown', key);
      visit(byKey.get(key));
    }
    visiting.delete(spec.key);
    done.add(spec.key);
  };
  for (const spec of specs) visit(spec);
}

/**
 * Add jobs to a queue. A repeated key with the same specification returns the
 * existing job; a changed specification is a conflict, never an overwrite.
 * @param {JobContext} ctx
 * @param {string} queue
 * @param {any[]} inputs
 * @returns {{ jobs: Job[], created: number }}
 */
function enqueue(ctx, queue, inputs) {
  queueName(queue);
  requireValue(Array.isArray(inputs) && inputs.length >= 1 && inputs.length <= 256, 'spec_invalid', 'batch of 1..256');
  const specs = inputs.map(normalizeJobSpec);
  requireValue(new Set(specs.map(spec => spec.key)).size === specs.length, 'spec_invalid', 'duplicate key in batch');
  const texts = specs.map(spec => safeJson(ctx, spec, 'specification'));
  return transaction(ctx, () => {
    const existing = rowsOf(ctx, queue);
    const byKey = new Map(existing.map(row => [row.key, row]));
    const fresh = specs.filter((spec, index) => {
      const row = byKey.get(spec.key);
      requireValue(!row || row.spec_hash === sha256(texts[index]), 'idempotency_conflict', spec.key);
      return !row;
    });
    assertAcyclic([...existing.map(row => JSON.parse(row.spec)), ...fresh]);
    requireValue(existing.length + fresh.length <= MAX_QUEUE_JOBS, 'queue_full');
    let seq = existing.reduce((max, row) => Math.max(max, row.seq), 0);
    const time = new Date(ctx.now()).toISOString();
    const insert = ctx.db.prepare(
      'INSERT INTO kodo_jobs(id,queue,key,seq,state,priority,spec,spec_hash,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)',
    );
    for (const spec of fresh) {
      const text = texts[specs.indexOf(spec)],
        id = randomUUID();
      insert.run(id, queue, spec.key, ++seq, 'queued', spec.priority, text, sha256(text), time, time);
      record(ctx, { id, queue }, 'enqueued', { state: 'queued', key: spec.key });
    }
    const rows = new Map(rowsOf(ctx, queue).map(row => [row.key, row]));
    return { jobs: specs.map(spec => view(rows.get(spec.key))), created: fresh.length };
  });
}

/**
 * Expired leases and (un)blocked dependents. Runs inside a transaction. Host
 * blocks are decided only when the caller knows its connections (`hosts`).
 * @param {JobContext} ctx
 * @param {string} queue
 * @param {import('./job-contracts.mjs').HostConnections} [hosts]
 */
function sweep(ctx, queue, hosts) {
  const now = ctx.now();
  for (const row of rowsOf(ctx, queue)) {
    if (row.state !== 'running' || row.lease_expires > now) continue;
    const exhausted = row.attempt >= JSON.parse(row.spec).retry.maxAttempts;
    update(ctx, row, { state: exhausted ? 'failed' : 'queued', reason: 'lease_lost', ...noLease }, 'lease_lost');
  }
  // Dependency and host blocks cascade, so repeat until nothing changes.
  for (let pass = 0, changed = true; changed && pass <= MAX_QUEUE_JOBS; pass++) {
    changed = false;
    const rows = rowsOf(ctx, queue),
      state = new Map(rows.map(row => [row.key, row.state]));
    for (const row of rows) {
      const spec = JSON.parse(row.spec);
      const broken = spec.dependsOn.find(key => ['blocked', 'failed', 'cancelled'].includes(state.get(key)));
      const hostBlocked = (row.reason ?? '').startsWith('host_unavailable:');
      // Without host knowledge an existing host block stands and no new one is made.
      const host = hosts ? (hostStatus(spec.host, hosts).available ? null : spec.host) : hostBlocked ? spec.host : null;
      const reason = broken !== undefined ? `dependency:${broken}` : host ? `host_unavailable:${host}` : null;
      const automatic = hostBlocked || (row.reason ?? '').startsWith('dependency:');
      if (row.state === 'queued' && reason) update(ctx, row, { state: 'blocked', reason }, 'blocked');
      else if (row.state === 'blocked' && automatic && !reason)
        update(ctx, row, { state: 'queued', reason: null }, 'unblocked');
      else continue;
      changed = true;
    }
  }
}

const admissionView = row => ({ ...row, spec: JSON.parse(row.spec) });

/**
 * Atomically start the best admissible job of a queue for one worker. A job
 * whose quota wait is over resumes first: it never left its scopes.
 * @param {JobContext} ctx
 * @param {string} queue
 * @param {{ owner: string, ttlMs?: number, limits: import('./job-contracts.mjs').JobLimits, hosts?: import('./job-contracts.mjs').HostConnections, worker?: { capabilities?: string[], tools?: string[] } }} options
 * @returns {{ job: Job | null, token: string | null, waiting: { key: string, reason: string, detail?: string }[] }}
 */
function claim(ctx, queue, { owner, ttlMs, limits, hosts = {}, worker = {} }) {
  queueName(queue);
  ownerName(owner);
  const ttl = lifetime(ttlMs);
  return transaction(ctx, () => {
    sweep(ctx, queue, hosts);
    const jobs = rowsOf(ctx, queue).map(admissionView);
    const resuming = jobs.filter(job => job.state === 'waiting_quota' && job.retry_at <= ctx.now());
    const candidates = [...rankJobs(resuming), ...rankJobs(jobs.filter(job => job.state === 'queued'))];
    const decisions = candidates.map(job => ({ job, decision: admission(job, { jobs, limits, hosts, worker }) }));
    const picked = decisions.find(item => item.decision.admit)?.job;
    const waiting = decisions
      .filter(item => item.job !== picked)
      .map(({ job, decision }) => {
        /** @type {{ key: string, reason: string, detail?: string }} */
        const row = { key: job.key, reason: decision.admit ? 'outranked' : decision.reason };
        if (!decision.admit && decision.detail !== undefined) row.detail = decision.detail;
        return row;
      });
    if (!picked) return { job: null, token: null, waiting };
    // Ready work that lost this claim ages, so it cannot be bypassed forever.
    const aging = new Set(['outranked', 'scope_conflict', 'lock_conflict', 'pool_full', 'yield_to_starved']);
    for (const row of waiting.filter(item => aging.has(item.reason)))
      ctx.db
        .prepare("UPDATE kodo_jobs SET bypassed=bypassed+1 WHERE queue=? AND key=? AND state='queued'")
        .run(queue, row.key);
    const token = randomUUID();
    const next = update(
      ctx,
      rowById(ctx, picked.id),
      {
        state: 'running',
        attempt: picked.attempt + 1,
        bypassed: 0,
        reason: null,
        retry_at: null,
        lease_owner: owner,
        lease_token: token,
        lease_expires: ctx.now() + ttl,
      },
      picked.state === 'waiting_quota' ? 'quota_resumed' : 'claimed',
      { owner },
    );
    return { job: view(next), token, waiting };
  });
}

/** The caller still owns the running job. */
function owned(ctx, id, token) {
  const row = rowById(ctx, id);
  requireValue(row.state === 'running' && typeof token === 'string' && row.lease_token === token, 'lease_lost');
  return row;
}

/**
 * Renew an execution or integration lease. A lost or cancelled job reports why so the worker stops.
 * @param {JobContext} ctx
 * @param {string} id
 * @param {string} token
 * @param {{ ttlMs?: number }} [options]
 * @returns {{ ok: true } | { ok: false, reason: string }}
 */
function heartbeat(ctx, id, token, { ttlMs } = {}) {
  const ttl = lifetime(ttlMs);
  return transaction(ctx, () => {
    const row = rowById(ctx, id);
    if (row.state === 'cancelled') return { ok: false, reason: 'cancelled' };
    if (!['running', 'integrating'].includes(row.state) || row.lease_token !== token)
      return { ok: false, reason: 'lease_lost' };
    ctx.db.prepare('UPDATE kodo_jobs SET lease_expires=? WHERE id=?').run(ctx.now() + ttl, id);
    return { ok: true };
  });
}

/** Record a worker result. The job then waits for integration and is never executed again. */
function complete(ctx, id, token, result) {
  const text = safeJson(ctx, result, 'result');
  return transaction(ctx, () => {
    const row = rowById(ctx, id);
    if (row.result_token && row.result_token === token) {
      requireValue(row.result_hash === sha256(text), 'result_conflict');
      return view(row);
    }
    owned(ctx, id, token);
    return view(
      update(
        ctx,
        row,
        {
          state: 'verifying',
          result: text,
          result_hash: sha256(text),
          result_token: token,
          verified_at: ctx.now(),
          reason: null,
          ...noLease,
        },
        'completed',
        { resultHash: sha256(text) },
      ),
    );
  });
}

/**
 * Report a failed execution: retried within the policy, otherwise failed.
 * @param {JobContext} ctx
 * @param {string} id
 * @param {string} token
 * @param {{ reason?: string, retryable?: boolean }} [options]
 */
function failJob(ctx, id, token, { reason, retryable = true } = {}) {
  return transaction(ctx, () => {
    const row = owned(ctx, id, token);
    const retry = retryable && row.attempt < JSON.parse(row.spec).retry.maxAttempts;
    const state = retry ? 'queued' : 'failed';
    return view(update(ctx, row, { state, reason: safeReason(ctx, reason) ?? 'failed', ...noLease }, state));
  });
}

/**
 * Hand a running job back without a verdict (coordinator stop or pause). It
 * returns to the queue and the interrupted claim does not count as an attempt.
 * @param {JobContext} ctx
 * @param {string} id
 * @param {string} token
 * @param {{ reason?: string }} [options]
 */
function release(ctx, id, token, { reason } = {}) {
  return transaction(ctx, () => {
    const row = owned(ctx, id, token);
    const patch = {
      state: 'queued',
      attempt: Math.max(0, row.attempt - 1),
      reason: safeReason(ctx, reason) ?? 'released',
    };
    return view(update(ctx, row, { ...patch, ...noLease }, 'released'));
  });
}

/**
 * Pause for provider quota. The job keeps its scopes and partial progress but
 * frees its worker slot; the wait does not count as a failed attempt.
 * @param {JobContext} ctx
 * @param {string} id
 * @param {string} token
 * @param {{ retryAt: number, reason?: string, checkpoint?: Record<string, any> }} options
 */
function waitQuota(ctx, id, token, { retryAt, reason, checkpoint }) {
  requireValue(Number.isSafeInteger(retryAt) && retryAt > 0, 'payload_invalid', 'retryAt must be a timestamp');
  const saved = checkpoint === undefined ? undefined : safeJson(ctx, checkpoint, 'checkpoint');
  return transaction(ctx, () => {
    const row = owned(ctx, id, token);
    const waits = row.quota_waits + 1;
    const patch =
      waits >= MAX_QUOTA_WAITS
        ? { state: 'blocked', reason: 'quota_exhausted' }
        : { state: 'waiting_quota', retry_at: retryAt, reason: safeReason(ctx, reason) ?? 'quota' };
    return view(
      update(
        ctx,
        row,
        {
          ...patch,
          quota_waits: waits,
          attempt: Math.max(0, row.attempt - 1),
          ...(saved === undefined ? {} : { checkpoint: saved }),
          ...noLease,
        },
        patch.state,
      ),
    );
  });
}

/**
 * Take the single integration slot of a queue. An integration whose owner
 * disappeared is returned first with `recovery: true`: the caller must find out
 * whether it landed before integrating anything else.
 * @param {JobContext} ctx
 * @param {string} queue
 * @param {{ owner: string, ttlMs?: number }} options
 * @returns {{ job: Job, token: string, recovery: boolean } | null}
 */
function beginIntegration(ctx, queue, { owner, ttlMs }) {
  queueName(queue);
  ownerName(owner);
  const ttl = lifetime(ttlMs);
  return transaction(ctx, () => {
    sweep(ctx, queue);
    const rows = rowsOf(ctx, queue);
    const lease = { lease_owner: owner, lease_token: randomUUID(), lease_expires: ctx.now() + ttl };
    const interrupted = rows.find(row => row.state === 'integrating');
    if (interrupted) {
      if (interrupted.lease_expires > ctx.now()) return null;
      const next = update(ctx, interrupted, lease, 'integration_recovery', { owner });
      return { job: view(next), token: lease.lease_token, recovery: true };
    }
    const [ready] = rows
      .filter(row => row.state === 'verifying')
      .sort((a, b) => a.verified_at - b.verified_at || a.seq - b.seq);
    if (!ready) return null;
    const next = update(
      ctx,
      ready,
      { state: 'integrating', integration_attempts: ready.integration_attempts + 1, ...lease },
      'integrating',
      { owner },
    );
    return { job: view(next), token: lease.lease_token, recovery: false };
  });
}

/** Record that a result is integrated. Repeating the same receipt is a no-op. */
function finishIntegration(ctx, id, token, receipt) {
  const text = safeJson(ctx, receipt, 'integration receipt');
  return transaction(ctx, () => {
    const row = rowById(ctx, id);
    if (row.state === 'integrated') {
      requireValue(row.integration_hash === sha256(text), 'integration_conflict');
      return view(row);
    }
    requireValue(row.state === 'integrating' && row.lease_token === token, 'lease_lost');
    const reason = row.cancel_requested ? 'cancel_after_integration' : null;
    return view(
      update(
        ctx,
        row,
        { state: 'integrated', integration: text, integration_hash: sha256(text), reason, ...noLease },
        'integrated',
        { integrationHash: sha256(text) },
      ),
    );
  });
}

/**
 * Record that an integration is confirmed absent. The recorded result is
 * integrated again later (bounded), or the job blocks on a conflict.
 * @param {JobContext} ctx
 * @param {string} id
 * @param {string} token
 * @param {{ reason?: string, retry?: boolean }} [options]
 */
function abortIntegration(ctx, id, token, { reason, retry = true } = {}) {
  return transaction(ctx, () => {
    const row = rowById(ctx, id);
    requireValue(row.state === 'integrating' && row.lease_token === token, 'lease_lost');
    const text = safeReason(ctx, reason) ?? 'integration_failed';
    const patch = row.cancel_requested
      ? { state: 'cancelled', reason: 'cancelled' }
      : !retry
        ? { state: 'blocked', reason: text }
        : row.integration_attempts >= MAX_INTEGRATION_ATTEMPTS
          ? { state: 'blocked', reason: 'integration_exhausted' }
          : { state: 'verifying', reason: text };
    return view(update(ctx, row, { ...patch, ...noLease }, 'integration_aborted'));
  });
}

/**
 * Cancel a job. A running worker loses its lease; an integration in flight is
 * only marked, because the merge may already exist.
 * @param {JobContext} ctx
 * @param {string} id
 * @param {{ reason?: string }} [options]
 */
function cancel(ctx, id, { reason } = {}) {
  return transaction(ctx, () => {
    const row = rowById(ctx, id);
    if (row.state === 'cancelled') return view(row);
    if (row.state === 'integrating') return view(update(ctx, row, { cancel_requested: 1 }, 'cancel_requested'));
    return view(
      update(ctx, row, { state: 'cancelled', reason: safeReason(ctx, reason) ?? 'cancelled', ...noLease }, 'cancelled'),
    );
  });
}

/** Return a blocked, failed or cancelled job to the queue with a fresh retry budget. */
function retry(ctx, id) {
  return transaction(ctx, () => {
    const row = rowById(ctx, id);
    requireValue(
      ['blocked', 'failed', 'cancelled'].includes(row.state),
      'transition_invalid',
      `${row.state} -> queued`,
    );
    return view(
      update(
        ctx,
        row,
        {
          state: 'queued',
          attempt: 0,
          quota_waits: 0,
          integration_attempts: 0,
          reason: null,
          result: null,
          result_hash: null,
          result_token: null,
          verified_at: null,
          cancel_requested: 0,
        },
        'retried',
      ),
    );
  });
}

const get = (ctx, id) => view(rowById(ctx, id));
const list = (ctx, queue) => rowsOf(ctx, queueName(queue)).map(view);
const queues = ctx => all(ctx, 'SELECT DISTINCT queue FROM kodo_jobs ORDER BY queue').map(row => row.queue);
const events = (ctx, id) =>
  all(ctx, 'SELECT seq,type,data,time FROM kodo_job_events WHERE job_id=? ORDER BY seq', rowById(ctx, id).id).map(
    row => ({ seq: row.seq, type: row.type, data: JSON.parse(row.data), time: row.time }),
  );
const recover = (ctx, queue, hosts) => transaction(ctx, () => sweep(ctx, queueName(queue), hosts));

/**
 * Hand a whole queue to a new coordinator that already holds an outer exclusive
 * lease on it (for an Engine run, the Run lease). Leases of the previous owner
 * are void at once instead of after their TTL: a running job returns to the
 * queue without spending an attempt, and an integration in flight becomes
 * recoverable, so the next `beginIntegration` returns it with `recovery: true`.
 * Never call this without that outer lease: it is what excludes a live owner.
 * @param {JobContext} ctx
 * @param {string} queue
 */
function takeOver(ctx, queue) {
  queueName(queue);
  return transaction(ctx, () => {
    for (const row of rowsOf(ctx, queue)) {
      if (row.state === 'running') {
        const patch = { state: 'queued', attempt: Math.max(0, row.attempt - 1), reason: 'owner_replaced' };
        update(ctx, row, { ...patch, ...noLease }, 'released');
      } else if (row.state === 'integrating' && row.lease_expires > 0)
        update(ctx, row, { lease_expires: 0 }, 'integration_orphaned');
    }
  });
}

/**
 * Open the durable job repository on an existing legacy Store.
 * @param {{ store: { db: any, secrets?: Record<string, string> }, now?: () => number }} options
 */
export function openJobStore({ store, now = Date.now }) {
  requireValue(store?.db && typeof store.db.prepare === 'function', 'store_invalid');
  /** @type {JobContext} */
  const ctx = { db: store.db, secrets: store.secrets || {}, now };
  migrate(ctx);
  /** @template {any[]} A @template R @param {(ctx: JobContext, ...args: A) => R} operation */
  const bind =
    operation =>
    /** @param {A} args */
    (...args) =>
      operation(ctx, ...args);
  return {
    enqueue: bind(enqueue),
    claim: bind(claim),
    heartbeat: bind(heartbeat),
    complete: bind(complete),
    fail: bind(failJob),
    waitQuota: bind(waitQuota),
    release: bind(release),
    beginIntegration: bind(beginIntegration),
    finishIntegration: bind(finishIntegration),
    abortIntegration: bind(abortIntegration),
    cancel: bind(cancel),
    retry: bind(retry),
    recover: bind(recover),
    takeOver: bind(takeOver),
    get: bind(get),
    list: bind(list),
    queues: bind(queues),
    events: bind(events),
  };
}

const jobTables = ['kodo_job_events', 'kodo_job_migrations', 'kodo_jobs'];

/** A read-only connection, or null when the home has no job tables yet. */
function readOnlyDatabase(home) {
  const filename = path.join(home, 'state.sqlite');
  if (!statSync(filename, { throwIfNoEntry: false })?.isFile()) return null;
  let db;
  // A cleanly closed WAL database has no sidecars and plain READONLY would
  // create them. Without pending WAL frames an immutable open reads the file as is.
  if (statSync(`${filename}-wal`, { throwIfNoEntry: false })?.size) db = new DatabaseSync(filename, { readOnly: true });
  else {
    const uri = pathToFileURL(path.resolve(filename));
    uri.searchParams.set('mode', 'ro');
    uri.searchParams.set('immutable', '1');
    db = new DatabaseSync(uri.href, { readOnly: true });
  }
  try {
    db.exec('PRAGMA query_only=ON; PRAGMA busy_timeout=5000');
    const present = db
      .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name IN (${jobTables.map(() => '?').join(',')})`)
      .all(...jobTables);
    if (present.length !== jobTables.length) {
      db.close();
      return null;
    }
    /** @type {any} */
    const latest = db.prepare('SELECT version,digest FROM kodo_job_migrations ORDER BY version DESC LIMIT 1').get();
    requireValue(latest?.version === 1 && latest.digest === migrationHash, 'migration_unsupported');
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}

/**
 * Open the job tables strictly for reading: no migration, no write lock and no
 * state directory or database created. A home without job tables reads as empty.
 * @param {{ home: string }} options
 */
export function openJobReader({ home }) {
  const db = readOnlyDatabase(home);
  /** @type {JobContext} */
  const ctx = { db, secrets: {}, now: Date.now };
  return {
    /** @param {string} id */
    get: id => (db ? get(ctx, id) : fail('not_found')),
    /** @param {string} queue */
    list: queue => (db ? list(ctx, queue) : (queueName(queue), [])),
    queues: () => (db ? queues(ctx) : []),
    /** @param {string} id */
    events: id => (db ? events(ctx, id) : fail('not_found')),
    close: () => db?.close(),
  };
}
