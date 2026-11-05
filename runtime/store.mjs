import { DatabaseSync } from 'node:sqlite';
import { randomUUID, createHash } from 'node:crypto';
import { mkdirSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { stateHome, redact } from './security.mjs';
const projectKey = value => { const resolved = path.resolve(value); return process.platform === 'win32' ? resolved.toLowerCase() : resolved; };

// Knowledge identity deliberately differs from the legacy lexical run/lesson key.
const knowledgeProjectKey = value => {
  const resolved = realpathSync.native(value);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
};
const knowledgeDomains = ['domain', 'product', 'technical', 'codebase'];
const knowledgeTables = ['knowledge_captures', 'knowledge_claim_revisions', 'knowledge_source_locators'];
function knowledgeError(code) { return Object.assign(new Error(`Knowledge ${code}`), { code: `knowledge_${code}` }); }
function requireKnowledge(condition, code = 'record_invalid') { if (!condition) throw knowledgeError(code); }
function plainRecord(value) { return value !== null && typeof value === 'object' && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value)); }
function exactKeys(value, keys) {
  requireKnowledge(plainRecord(value));
  const own = Reflect.ownKeys(value);
  requireKnowledge(own.length === keys.length && own.every(key => keys.includes(key) && Object.getOwnPropertyDescriptor(value, key).enumerable && 'value' in Object.getOwnPropertyDescriptor(value, key)));
}
function text(value, max = Infinity) { return typeof value === 'string' && value.trim().length > 0 && value.length <= max; }
function utc(value) { return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value; }
function digest(value) { return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value); }
function canonicalKnowledge(value, budget = null, depth = 0) {
  if (budget) requireKnowledge(++budget.nodes <= 10000 && depth <= 12, 'json_limit');
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number') { requireKnowledge(Number.isFinite(value)); return JSON.stringify(value); }
  if (Array.isArray(value)) {
    requireKnowledge(Reflect.ownKeys(value).length === value.length + 1);
    const items = [];
    for (let index = 0; index < value.length; index++) {
      requireKnowledge(Object.hasOwn(value, index) && 'value' in Object.getOwnPropertyDescriptor(value, index));
      items.push(canonicalKnowledge(value[index], budget, depth + 1));
    }
    return `[${items.join(',')}]`;
  }
  requireKnowledge(plainRecord(value));
  const keys = Reflect.ownKeys(value);
  requireKnowledge(keys.every(key => typeof key === 'string' && Object.getOwnPropertyDescriptor(value, key).enumerable && 'value' in Object.getOwnPropertyDescriptor(value, key)));
  return `{${keys.sort().map(key => `${JSON.stringify(key)}:${canonicalKnowledge(value[key], budget, depth + 1)}`).join(',')}}`;
}
const knowledgeHash = value => createHash('sha256').update(canonicalKnowledge(value)).digest('hex');
const sourceLocator = source => canonicalKnowledge({ kind: source.kind, url: source.url, path: source.path, pointer: source.pointer });
function validateKnowledgeClaim(claim, project) {
  exactKeys(claim, ['id', 'fingerprint', 'domain', 'subject', 'key', 'value', 'versions', 'synthetic', 'source', 'confidence', 'unknowns']);
  requireKnowledge(digest(claim.id) && digest(claim.fingerprint) && knowledgeDomains.includes(claim.domain));
  requireKnowledge(text(claim.subject, 128) && text(claim.key, 128) && typeof claim.synthetic === 'boolean');
  requireKnowledge(plainRecord(claim.versions) && Reflect.ownKeys(claim.versions).length <= 16);
  requireKnowledge(Object.entries(claim.versions).every(([key, value]) => text(key) && text(value, 128)));
  requireKnowledge(claim.confidence === null || (typeof claim.confidence === 'number' && Number.isFinite(claim.confidence) && claim.confidence >= 0 && claim.confidence <= 1));
  requireKnowledge(Array.isArray(claim.unknowns) && claim.unknowns.length <= 32 && claim.unknowns.every(item => typeof item === 'string' && item.length <= 200));
  const source = claim.source;
  exactKeys(source, ['id', 'kind', 'url', 'path', 'pointer', 'retrievedAt', 'validAsOf', 'evidenceRef']);
  requireKnowledge(text(source.id, 128) && ['local', 'discovery'].includes(source.kind));
  requireKnowledge(['url', 'path', 'pointer'].every(key => source[key] === null || typeof source[key] === 'string'));
  requireKnowledge([source.retrievedAt, source.validAsOf].every(value => value === null || utc(value)));
  exactKeys(source.evidenceRef, ['path', 'bytes', 'sha256']);
  requireKnowledge(text(source.evidenceRef.path) && Number.isSafeInteger(source.evidenceRef.bytes) && source.evidenceRef.bytes >= 0 && source.evidenceRef.bytes <= 1048576 && digest(source.evidenceRef.sha256));
  requireKnowledge(Buffer.byteLength(canonicalKnowledge(claim.value, { nodes: 0 }), 'utf8') <= 262144, 'json_limit');
  const { id, fingerprint, ...data } = claim;
  requireKnowledge(id === knowledgeHash([project, claim.domain, claim.subject, claim.key, claim.versions, source.id, claim.synthetic]) && fingerprint === knowledgeHash(data), 'hash_mismatch');
}
function validateKnowledgeCapture(capture, secrets) {
  exactKeys(capture, ['schemaVersion', 'projectKey', 'captureId', 'inputHash', 'policyHash', 'contextHash', 'capturedAt', 'claims']);
  requireKnowledge(capture.schemaVersion === 1 && text(capture.projectKey));
  requireKnowledge(typeof capture.captureId === 'string' && /^[\w.-]{1,128}$/.test(capture.captureId));
  requireKnowledge([capture.inputHash, capture.policyHash, capture.contextHash].every(digest) && utc(capture.capturedAt));
  requireKnowledge(Array.isArray(capture.claims) && capture.claims.length <= 1000);
  const project = knowledgeProjectKey(capture.projectKey);
  requireKnowledge(capture.projectKey === project, 'project_identity');
  const ids = new Set();
  for (const claim of capture.claims) { validateKnowledgeClaim(claim, project); requireKnowledge(!ids.has(claim.id), 'duplicate_claim'); ids.add(claim.id); }
  const serialized = canonicalKnowledge(capture);
  // No redacted copy may replace an already hashed capture. This also checks keys.
  requireKnowledge(serialized === canonicalKnowledge(redact(capture, secrets)), 'secret_redaction_required');
  const known = Object.values(secrets).filter(value => typeof value === 'string' && value.length > 0);
  function rejectKnown(value) {
    if (typeof value === 'string') requireKnowledge(!known.some(secret => value.includes(secret)), 'secret_redaction_required');
    else if (value && typeof value === 'object') for (const [key, item] of Object.entries(value)) { rejectKnown(key); rejectKnown(item); }
  }
  rejectKnown(capture);
  return JSON.parse(serialized);
}
function readKnowledgeCapture(db, project, captureId) {
  const row = db.prepare('SELECT body FROM knowledge_captures WHERE project_key=? AND capture_id=?').get(project, captureId);
  return row ? JSON.parse(row.body) : null;
}
function readKnowledgeClaims(db, project, { domain, subject, limit = 200, history = false } = {}, page = false) {
  requireKnowledge(Number.isSafeInteger(limit) && limit >= 1 && limit <= 1000 && typeof history === 'boolean', 'query_invalid');
  requireKnowledge(domain === undefined || knowledgeDomains.includes(domain), 'query_invalid');
  requireKnowledge(subject === undefined || text(subject, 128), 'query_invalid');
  if (page && !db) return { claims: [], total: 0, complete: true };
  const clauses = ['r.project_key=?'], parameters = [project];
  if (!history) clauses.push('r.revision=(SELECT MAX(latest.revision) FROM knowledge_claim_revisions latest WHERE latest.project_key=r.project_key AND latest.claim_id=r.claim_id)');
  if (domain !== undefined) { clauses.push("json_extract(r.body,'$.domain')=?"); parameters.push(domain); }
  if (subject !== undefined) { clauses.push("json_extract(r.body,'$.subject')=?"); parameters.push(subject); }
  if (page) {
    // Materialize identifiers only. Count and <=limit bodies share one statement's
    // SQLite snapshot; no extra claim body is fetched to detect overflow.
    const rows = db.prepare(`WITH matching AS MATERIALIZED (
      SELECT r.claim_id,r.revision FROM knowledge_claim_revisions r WHERE ${clauses.join(' AND ')}
    ), bounded AS MATERIALIZED (
      SELECT claim_id,revision FROM matching ORDER BY revision DESC,claim_id ASC LIMIT ?
    ) SELECT r.body,totals.total FROM (SELECT COUNT(*) AS total FROM matching) totals
      LEFT JOIN bounded b ON 1
      LEFT JOIN knowledge_claim_revisions r ON r.project_key=? AND r.claim_id=b.claim_id AND r.revision=b.revision
      ORDER BY b.revision DESC,b.claim_id ASC`).all(...parameters, limit, project);
    const claims = rows.filter(row => row.body !== null).map(row => JSON.parse(row.body)), total = rows[0].total;
    return { claims, total, complete: total === claims.length };
  }
  return db.prepare(`SELECT r.body FROM knowledge_claim_revisions r WHERE ${clauses.join(' AND ')} ORDER BY r.revision DESC,r.claim_id ASC LIMIT ?`)
    .all(...parameters, limit).map(row => JSON.parse(row.body));
}

// Inspection never opens a writable Store, creates a home, or migrates tables.
export function openKnowledgeReader(home = stateHome()) {
  let db = null, probeOnly = false;
  const filename = path.join(home, 'state.sqlite');
  try {
    requireKnowledge(statSync(filename).isFile(), 'database_invalid');
    const wal = statSync(`${filename}-wal`, { throwIfNoEntry: false });
    const shared = statSync(`${filename}-shm`, { throwIfNoEntry: false });
    // SQLite READONLY alone may create WAL/SHM for a closed WAL database.
    // Use immutable only for a short schema probe without pending WAL frames.
    // An orphan WAL needs writer recovery first, never permission/sidecar repair.
    requireKnowledge(!wal?.size || shared?.isFile(), 'database_recovery_required');
    const uri = pathToFileURL(path.resolve(filename));
    uri.searchParams.set('mode', 'ro');
    probeOnly = !wal?.size;
    if (probeOnly) uri.searchParams.set('immutable', '1');
    db = new DatabaseSync(uri.href, { readOnly: true });
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  let available = false;
  try {
    if (db) {
      db.exec('PRAGMA query_only=ON; PRAGMA busy_timeout=5000');
      const tables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(row => row.name));
      available = knowledgeTables.every(name => tables.has(name));
      // A real reader must retain ordinary SQLite locking and see later commits
      // even when a writer is opened after this function returns.
      if (probeOnly && available) {
        db.close(); db = null;
        db = new DatabaseSync(filename, { readOnly: true });
        db.exec('PRAGMA query_only=ON; PRAGMA busy_timeout=5000');
      } else if (!available) { db.close(); db = null; }
    }
  } catch (error) { db?.close(); throw error; }
  return {
    findKnowledgeCapture(project, captureId) { return available ? readKnowledgeCapture(db, knowledgeProjectKey(project), captureId) : null; },
    listKnowledgeClaims(project, options = {}) { return available ? readKnowledgeClaims(db, knowledgeProjectKey(project), options) : []; },
    listKnowledgeClaimsPage(project, options = {}) { return readKnowledgeClaims(available ? db : null, available ? knowledgeProjectKey(project) : project, options, true); },
    close() { if (db) { db.close(); db = null; } available = false; }
  };
}

export class Store {
  constructor(home = stateHome(), secrets = {}) {
    this.home = home; this.secrets = secrets;
    mkdirSync(home, { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path.join(home, 'state.sqlite'));
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS runs(id TEXT PRIMARY KEY, body TEXT NOT NULL, updated INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS events(seq INTEGER PRIMARY KEY AUTOINCREMENT,run_id TEXT NOT NULL,type TEXT NOT NULL,data TEXT NOT NULL,time INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS leases(token TEXT PRIMARY KEY,name TEXT NOT NULL,owner TEXT NOT NULL,expires INTEGER NOT NULL,pid INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS lease_names ON leases(name);
      CREATE TABLE IF NOT EXISTS knowledge(run_id TEXT PRIMARY KEY,project TEXT NOT NULL,body TEXT NOT NULL,time INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS knowledge_captures(project_key TEXT NOT NULL,capture_id TEXT NOT NULL,body TEXT NOT NULL,PRIMARY KEY(project_key,capture_id));
      CREATE TABLE IF NOT EXISTS knowledge_claim_revisions(project_key TEXT NOT NULL,claim_id TEXT NOT NULL,revision INTEGER NOT NULL CHECK(revision>0),capture_id TEXT NOT NULL,body TEXT NOT NULL,PRIMARY KEY(project_key,claim_id,revision));
      CREATE TABLE IF NOT EXISTS knowledge_source_locators(project_key TEXT NOT NULL,source_id TEXT NOT NULL,locator TEXT NOT NULL,PRIMARY KEY(project_key,source_id));
    `);
  }
  createRun(run) {
    const value = { ...run, id: run.id || randomUUID(), createdAt: new Date().toISOString(), state: 'created', completed: {}, nodes: {}, ...run };
    this.db.prepare('INSERT INTO runs VALUES(?,?,?)').run(value.id, JSON.stringify(redact(value, this.secrets)), Date.now());
    this.event(value.id, 'created', { task: value.task }); return value;
  }
  getRun(id) { const row = this.db.prepare('SELECT body FROM runs WHERE id=?').get(id); if (!row) throw new Error(`Запуск не найден: ${id}`); return JSON.parse(row.body); }
  updateRun(id, patch, { preserveCancellation = false } = {}) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const current = this.getRun(id);
      const run = { ...current, ...patch, updatedAt: new Date().toISOString() };
      if (preserveCancellation) {
        run.cancelRequested = Boolean(current.cancelRequested);
        if (run.cancelRequested && !run.release?.published) run.state = 'cancelled';
      }
      this.db.prepare('UPDATE runs SET body=?,updated=? WHERE id=?').run(JSON.stringify(redact(run, this.secrets)), Date.now(), id); this.db.exec('COMMIT'); return run;
    }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  listRuns(project) { return this.db.prepare('SELECT body FROM runs ORDER BY updated DESC').all().map(row => JSON.parse(row.body)).filter(run => !project || projectKey(run.project) === projectKey(project)); }
  event(runId, type, data = {}) { this.db.prepare('INSERT INTO events(run_id,type,data,time) VALUES(?,?,?,?)').run(runId, type, JSON.stringify(redact(data, this.secrets)), Date.now()); }
  events(runId, after = 0) { return this.db.prepare('SELECT * FROM events WHERE run_id=? AND seq>? ORDER BY seq').all(runId, after).map(row => ({ ...row, data: JSON.parse(row.data) })); }
  remember(run) {
    const lesson = redact({ runId: run.id, task: run.task, headSha: run.headSha, summary: run.plan?.summary, checks: run.checks?.results.map(item => ({ command: item.command, exitCode: item.exitCode })), review: run.review && { passed: run.review.passed, headSha: run.review.headSha }, repaired: this.events(run.id).filter(item => ['node_failed','repair_required'].includes(item.type)).map(item => item.data), sources: run.research?.items.map(item => ({ url: item.url, verification: item.verification })) }, this.secrets);
    this.db.prepare('INSERT OR REPLACE INTO knowledge VALUES(?,?,?,?)').run(run.id, projectKey(run.project), JSON.stringify(lesson), Date.now()); return lesson;
  }
  lessons(project, limit = 5) { return this.db.prepare('SELECT body FROM knowledge WHERE project=? ORDER BY time DESC LIMIT ?').all(projectKey(project), limit).map(row => JSON.parse(row.body)); }
  findKnowledgeCapture(project, captureId) { return readKnowledgeCapture(this.db, knowledgeProjectKey(project), captureId); }
  listKnowledgeClaims(project, options = {}) { return readKnowledgeClaims(this.db, knowledgeProjectKey(project), options); }
  listKnowledgeClaimsPage(project, options = {}) { return readKnowledgeClaims(this.db, knowledgeProjectKey(project), options, true); }
  appendKnowledgeCapture(input) {
    const capture = validateKnowledgeCapture(input, this.secrets);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const previous = readKnowledgeCapture(this.db, capture.projectKey, capture.captureId);
      // Check locators even for a replay: hashes do not authorize rebinding a source.
      const locators = new Map();
      for (const claim of capture.claims) {
        const locator = sourceLocator(claim.source);
        const saved = this.db.prepare('SELECT locator FROM knowledge_source_locators WHERE project_key=? AND source_id=?').get(capture.projectKey, claim.source.id);
        requireKnowledge((!saved || saved.locator === locator) && (!locators.has(claim.source.id) || locators.get(claim.source.id) === locator), 'source_locator_conflict');
        locators.set(claim.source.id, locator);
      }
      if (previous) {
        requireKnowledge(['inputHash', 'policyHash', 'contextHash'].every(key => capture[key] === previous[key]), 'capture_replay_conflict');
        const originalLocators = new Map(previous.claims.map(claim => [claim.source.id, sourceLocator(claim.source)]));
        requireKnowledge(originalLocators.size === locators.size && [...locators].every(([id, locator]) => originalLocators.get(id) === locator), 'source_locator_conflict');
        this.db.exec('COMMIT'); return { ...previous, replayed: true };
      }
      for (const [id, locator] of locators) this.db.prepare('INSERT OR IGNORE INTO knowledge_source_locators VALUES(?,?,?)').run(capture.projectKey, id, locator);
      const claims = capture.claims.map(claim => {
        const revision = this.db.prepare('SELECT COALESCE(MAX(revision),0)+1 AS next FROM knowledge_claim_revisions WHERE project_key=? AND claim_id=?').get(capture.projectKey, claim.id).next;
        const stored = { ...claim, schemaVersion: 1, projectKey: capture.projectKey, captureId: capture.captureId, revision, observedAt: capture.capturedAt };
        this.db.prepare('INSERT INTO knowledge_claim_revisions VALUES(?,?,?,?,?)').run(capture.projectKey, claim.id, revision, capture.captureId, JSON.stringify(stored));
        return stored;
      });
      const receipt = { schemaVersion: 1, projectKey: capture.projectKey, captureId: capture.captureId, inputHash: capture.inputHash, policyHash: capture.policyHash, contextHash: capture.contextHash, capturedAt: capture.capturedAt, replayed: false, claims };
      this.db.prepare('INSERT INTO knowledge_captures VALUES(?,?,?)').run(capture.projectKey, capture.captureId, JSON.stringify(receipt));
      this.db.exec('COMMIT'); return receipt;
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  acquireLease(name, owner, { ttlMs = 60000, limit = 1 } = {}) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const now = Date.now();
      this.db.prepare('DELETE FROM leases WHERE expires<?').run(now);
      for (const item of this.db.prepare('SELECT token,pid FROM leases').all()) {
        try { process.kill(item.pid, 0); } catch (error) { if (error.code === 'ESRCH') this.db.prepare('DELETE FROM leases WHERE token=?').run(item.token); }
      }
      const count = this.db.prepare('SELECT count(*) AS count FROM leases WHERE name=?').get(name).count;
      let token = null;
      if (count < limit) { token = randomUUID(); this.db.prepare('INSERT INTO leases VALUES(?,?,?,?,?)').run(token, name, owner, now + ttlMs, process.pid); }
      this.db.exec('COMMIT'); return token;
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  renewLease(token, ttlMs = 60000) { return this.db.prepare('UPDATE leases SET expires=? WHERE token=?').run(Date.now() + ttlMs, token).changes > 0; }
  releaseLease(token) { this.db.prepare('DELETE FROM leases WHERE token=?').run(token); }
  close() { this.db.close(); }
}
