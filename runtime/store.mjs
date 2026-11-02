import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { stateHome, redact } from './security.mjs';
const projectKey = value => { const resolved = path.resolve(value); return process.platform === 'win32' ? resolved.toLowerCase() : resolved; };

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
