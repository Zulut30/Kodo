/** Durable job contracts: the JobSpec shape, the job state machine and the pure
 * admission decision. No I/O lives here; `job-store.mjs` applies these rules
 * inside SQLite transactions. A job is one scoped unit of worker execution that
 * is integrated separately, at most once, by the coordinator.
 */
import { scopesOverlap } from './contracts.mjs';

/**
 * @typedef {object} JobSpec
 * @property {1} schemaVersion
 * @property {string} key Idempotency key, unique inside one queue.
 * @property {string} role Logical role; a role alone never starts a model session.
 * @property {number} priority 0..100, higher first.
 * @property {string[]} dependsOn Keys that must be integrated before this job starts.
 * @property {string[]} readPaths
 * @property {string[]} writePaths
 * @property {string[]} locks Exclusive shared-interface locks.
 * @property {string[]} requiredTools
 * @property {string[]} capabilities Required worker capabilities.
 * @property {string} host Execution host; a host is not a model.
 * @property {string | null} pool Subscription pool that bounds concurrency.
 * @property {string | null} model
 * @property {{ maxAttempts: number }} retry
 * @property {Record<string, any>} payload Opaque caller data (contract and evidence references).
 */

/**
 * @typedef {object} JobView The fields admission needs from a stored job.
 * @property {string} id
 * @property {string} key
 * @property {number} seq
 * @property {string} state
 * @property {number} priority
 * @property {number} bypassed
 * @property {JobSpec} spec
 */

/**
 * @typedef {object} JobLimits
 * @property {number} workers Concurrently running jobs, 1..8.
 * @property {Record<string, number>} [pools] Running jobs per subscription pool, 0..8.
 */

/** @typedef {Record<string, { available?: boolean, reason?: string }>} HostConnections */

/** @typedef {{ admit: boolean, reason?: string, detail?: string }} AdmissionDecision `reason` is set when `admit` is false. */

export const JOB_STATES = Object.freeze([
  'queued',
  'running',
  'waiting_quota',
  'verifying',
  'integrating',
  'integrated',
  'blocked',
  'failed',
  'cancelled',
]);
export const JOB_ROLES = Object.freeze([
  'architect',
  'developer',
  'tester',
  'documentation',
  'security',
  'performance',
  'ui-qa',
  'reviewer',
]);
export const JOB_HOSTS = Object.freeze(['native', 't3', 'orca']);
/** After this many lost claims a ready job reserves its scopes. */
export const STARVATION_BYPASSES = 8;
export const MAX_JOB_BYTES = 65536;

const readOnlyRoles = new Set(['reviewer']);
/** Started but not yet integrated: these hold their scopes and locks. */
const holding = new Set(['running', 'waiting_quota', 'verifying', 'integrating']);
const unavailable = new Set(['blocked', 'failed', 'cancelled']);
const transitions = {
  queued: ['running', 'blocked', 'cancelled'],
  running: ['verifying', 'queued', 'waiting_quota', 'blocked', 'failed', 'cancelled'],
  waiting_quota: ['queued', 'cancelled'],
  verifying: ['integrating', 'cancelled'],
  integrating: ['integrated', 'verifying', 'blocked', 'cancelled'],
  integrated: [],
  blocked: ['queued', 'cancelled'],
  failed: ['queued', 'cancelled'],
  cancelled: ['queued'],
};

/** @returns {never} */
function fail(code, message = code) {
  throw Object.assign(new Error(`Job: ${message}`), { code: `job_${code}` });
}
const requireSpec = (condition, message) => {
  if (!condition) fail('spec_invalid', message);
};
const plain = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const keyPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/;
const namePattern = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,79}$/;

function names(value, field, pattern = namePattern) {
  if (value === undefined) return [];
  requireSpec(Array.isArray(value) && value.length <= 64, `${field} must be a short list`);
  requireSpec(
    value.every(item => typeof item === 'string' && pattern.test(item)),
    `${field} has an invalid entry`,
  );
  requireSpec(new Set(value).size === value.length, `${field} has duplicates`);
  return [...value].sort();
}

function paths(value, field) {
  if (value === undefined) return [];
  requireSpec(Array.isArray(value) && value.length <= 256, `${field} must be a list`);
  const normalized = value.map(item => {
    requireSpec(typeof item === 'string' && item.length <= 512 && item.isWellFormed(), `${field} entry is invalid`);
    requireSpec(!/[\\\0-\x1f]/.test(item) && !/^(?:\/|[A-Za-z]:)/.test(item), `${field} must be repo-relative`);
    const parts = item.split('/').filter(part => part && part !== '.');
    requireSpec(parts.length > 0 && !parts.includes('..'), `${field} must stay inside the checkout`);
    return parts.join('/');
  });
  return [...new Set(normalized)].sort();
}

const specFields = new Set([
  'schemaVersion',
  'key',
  'role',
  'priority',
  'dependsOn',
  'readPaths',
  'writePaths',
  'locks',
  'requiredTools',
  'capabilities',
  'host',
  'pool',
  'model',
  'retry',
  'payload',
]);

/**
 * Validate and canonicalize a job specification. The result is stable, so its
 * hash identifies the request for idempotent enqueue.
 * @param {any} input
 * @returns {JobSpec}
 */
export function normalizeJobSpec(input) {
  requireSpec(plain(input), 'specification must be an object');
  requireSpec(
    Object.keys(input).every(field => specFields.has(field)),
    'unknown field',
  );
  requireSpec(input.schemaVersion === undefined || input.schemaVersion === 1, 'unsupported schemaVersion');
  requireSpec(typeof input.key === 'string' && keyPattern.test(input.key), 'key is invalid');
  requireSpec(JOB_ROLES.includes(input.role), 'role is unknown');
  const priority = input.priority ?? 50;
  requireSpec(Number.isInteger(priority) && priority >= 0 && priority <= 100, 'priority must be 0..100');
  const dependsOn = names(input.dependsOn, 'dependsOn', keyPattern);
  requireSpec(!dependsOn.includes(input.key), 'a job cannot depend on itself');
  const writePaths = paths(input.writePaths, 'writePaths');
  requireSpec(!readOnlyRoles.has(input.role) || !writePaths.length, 'a read-only role cannot write');
  const host = input.host ?? 'native';
  requireSpec(JOB_HOSTS.includes(host), 'host is unknown');
  const pool = input.pool ?? null;
  requireSpec(pool === null || (typeof pool === 'string' && /^[a-z][a-z0-9-]{0,47}$/.test(pool)), 'pool is invalid');
  const model = input.model ?? null;
  requireSpec(model === null || (typeof model === 'string' && /^\S{1,128}$/.test(model)), 'model is invalid');
  const retry = input.retry ?? {};
  requireSpec(plain(retry) && Object.keys(retry).every(field => field === 'maxAttempts'), 'retry is invalid');
  const maxAttempts = retry.maxAttempts ?? 2;
  requireSpec(Number.isInteger(maxAttempts) && maxAttempts >= 1 && maxAttempts <= 5, 'retry.maxAttempts must be 1..5');
  const payload = input.payload ?? {};
  requireSpec(plain(payload), 'payload must be an object');
  let bytes;
  try {
    bytes = Buffer.byteLength(JSON.stringify(payload));
  } catch {
    fail('spec_invalid', 'payload must be JSON');
  }
  requireSpec(bytes <= MAX_JOB_BYTES, 'payload is too large');
  return {
    schemaVersion: 1,
    key: input.key,
    role: input.role,
    priority,
    dependsOn,
    readPaths: paths(input.readPaths, 'readPaths'),
    writePaths,
    locks: names(input.locks, 'locks'),
    requiredTools: names(input.requiredTools, 'requiredTools'),
    capabilities: names(input.capabilities, 'capabilities'),
    host,
    pool,
    model,
    retry: { maxAttempts },
    payload: structuredClone(payload),
  };
}

/** Reject a state change the lifecycle does not define. */
export function assertJobTransition(from, to) {
  if (!Object.hasOwn(transitions, from) || !transitions[from].includes(to))
    fail('transition_invalid', `${from} -> ${to}`);
}

/**
 * Availability of an execution host. Only `native` exists today; an adapter
 * that is not connected is reported unavailable instead of silently running
 * the job natively.
 * @param {string} id
 * @param {HostConnections} [hosts]
 */
export function hostStatus(id, hosts = {}) {
  const connection = hosts[id];
  const available = id === 'native' ? connection?.available !== false : connection?.available === true;
  return available ? { id, available } : { id, available, reason: connection?.reason ?? 'not_connected' };
}

const rank = job => job.priority + job.bypassed;
const before = (a, b) => rank(a) > rank(b) || (rank(a) === rank(b) && a.seq < b.seq);

/**
 * Claim order: priority plus accumulated bypasses, then age.
 * @template {JobView} T
 * @param {T[]} jobs
 * @returns {T[]}
 */
export function rankJobs(jobs) {
  return [...jobs].sort((a, b) => (before(a, b) ? -1 : before(b, a) ? 1 : 0));
}

/** A candidate starts from stale sources or collides on merge with `other`. */
const scopeCollision = (candidate, other) =>
  scopesOverlap(candidate.spec.writePaths, other.spec.writePaths) ||
  scopesOverlap(candidate.spec.readPaths, other.spec.writePaths);

function assertLimits(limits) {
  const count = (value, min) => Number.isInteger(value) && value >= min && value <= 8;
  if (!plain(limits) || !count(limits.workers, 1)) fail('limits_invalid', 'workers must be 1..8');
  const pools = limits.pools ?? {};
  if (!plain(pools) || !Object.values(pools).every(value => count(value, 0)))
    fail('limits_invalid', 'pool limits must be 0..8');
  return pools;
}

/** Dependencies integrated, or the first reason they are not. */
function dependencyDecision(job, jobs) {
  const byKey = new Map(jobs.map(item => [item.key, item]));
  let pending;
  for (const key of job.spec.dependsOn) {
    const state = byKey.get(key)?.state;
    if (state === 'integrated') continue;
    if (state === undefined || unavailable.has(state)) return { reason: 'dependency_unavailable', detail: key };
    pending ??= key;
  }
  return pending === undefined ? null : { reason: 'dependency_pending', detail: pending };
}

/** Scope, lock and starvation conflicts with other jobs of the queue. */
function conflictDecision(job, jobs) {
  const dependenciesMet = other => !dependencyDecision(other, jobs);
  for (const other of jobs) {
    if (other.id === job.id || other.state !== 'queued' || other.bypassed < STARVATION_BYPASSES) continue;
    const yields = job.bypassed < STARVATION_BYPASSES || before(other, job);
    if (yields && dependenciesMet(other) && (scopeCollision(job, other) || scopeCollision(other, job)))
      return { reason: 'yield_to_starved', detail: other.key };
  }
  const active = jobs.filter(other => other.id !== job.id && holding.has(other.state));
  const collision = active.find(other => scopeCollision(job, other));
  if (collision) return { reason: 'scope_conflict', detail: collision.key };
  for (const other of active) {
    const lock = job.spec.locks.find(name => other.spec.locks.includes(name));
    if (lock) return { reason: 'lock_conflict', detail: lock };
  }
  return null;
}

/**
 * Decide whether a queued job may start now. Pure: the caller supplies every
 * job of the queue as it is inside the claiming transaction.
 * @param {JobView} job
 * @param {{ jobs: JobView[], limits: JobLimits, hosts?: HostConnections, worker?: { capabilities?: string[], tools?: string[] } }} context
 * @returns {AdmissionDecision}
 */
export function admission(job, { jobs, limits, hosts = {}, worker = {} }) {
  const pools = assertLimits(limits);
  const deny = decision => ({ admit: false, ...decision });
  const dependency = dependencyDecision(job, jobs);
  if (dependency) return deny(dependency);
  if (!hostStatus(job.spec.host, hosts).available) return deny({ reason: 'host_unavailable', detail: job.spec.host });
  const offered = { capabilities: worker.capabilities ?? [], tools: worker.tools ?? [] };
  if (
    !job.spec.capabilities.every(name => offered.capabilities.includes(name)) ||
    !job.spec.requiredTools.every(name => offered.tools.includes(name))
  )
    return deny({ reason: 'worker_mismatch' });
  const conflict = conflictDecision(job, jobs);
  if (conflict) return deny(conflict);
  const running = jobs.filter(other => other.id !== job.id && other.state === 'running');
  if (running.length >= limits.workers) return deny({ reason: 'workers_full' });
  const pool = job.spec.pool;
  if (pool !== null && Object.hasOwn(pools, pool) && running.filter(o => o.spec.pool === pool).length >= pools[pool])
    return deny({ reason: 'pool_full', detail: pool });
  return { admit: true };
}
