import test from 'node:test';
import assert from 'node:assert/strict';
import {
  JOB_STATES,
  STARVATION_BYPASSES,
  admission,
  assertJobTransition,
  hostStatus,
  normalizeJobSpec,
  rankJobs,
} from '../runtime/job-contracts.mjs';

const spec = (key, extra = {}) => ({ key, role: 'developer', writePaths: [`src/${key}.mjs`], ...extra });
const job = (key, state = 'queued', extra = {}) => {
  const normalized = normalizeJobSpec(spec(key, extra.spec));
  return {
    id: key,
    key,
    seq: extra.seq ?? 1,
    state,
    priority: normalized.priority,
    bypassed: extra.bypassed ?? 0,
    spec: normalized,
  };
};
const limits = { workers: 4, pools: {} };
const code = (fn, expected) => assert.throws(fn, error => error.code === expected, expected);

test('JobSpec is normalized with safe defaults and a stable shape', () => {
  const normalized = normalizeJobSpec({ key: 'a', role: 'tester', writePaths: ['./src//a.mjs', 'src/a.mjs'] });
  assert.deepEqual(normalized, {
    schemaVersion: 1,
    key: 'a',
    role: 'tester',
    priority: 50,
    dependsOn: [],
    readPaths: [],
    writePaths: ['src/a.mjs'],
    locks: [],
    requiredTools: [],
    capabilities: [],
    host: 'native',
    pool: null,
    model: null,
    retry: { maxAttempts: 2 },
    payload: {},
  });
  assert.deepEqual(normalizeJobSpec(normalized), normalized, 'normalization is idempotent');
});

test('JobSpec rejects unsafe paths, unknown fields, roles and budgets', () => {
  for (const bad of [
    { key: '' },
    { key: 'a', role: 'wizard' },
    { key: 'a', writePaths: ['../outside'] },
    { key: 'a', writePaths: ['/abs/path'] },
    { key: 'a', writePaths: ['C:/abs/path'] },
    { key: 'a', readPaths: ['src\\win'] },
    { key: 'a', priority: 101 },
    { key: 'a', retry: { maxAttempts: 6 } },
    { key: 'a', dependsOn: ['a'] },
    { key: 'a', dependsOn: ['b', 'b'] },
    { key: 'a', host: 'mainframe' },
    { key: 'a', surprise: true },
    { key: 'a', payload: { blob: 'x'.repeat(70000) } },
    { key: 'a', payload: [1] },
    null,
  ])
    code(() => normalizeJobSpec(bad && { role: 'developer', ...bad }), 'job_spec_invalid');
});

test('Read-only roles cannot declare write scopes', () => {
  code(() => normalizeJobSpec({ key: 'r', role: 'reviewer', writePaths: ['src/a.mjs'] }), 'job_spec_invalid');
  assert.deepEqual(normalizeJobSpec({ key: 'r', role: 'reviewer', readPaths: ['src'] }).writePaths, []);
});

test('Job state machine allows only the documented transitions', () => {
  assert.deepEqual(JOB_STATES, [
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
  for (const [from, to] of [
    ['queued', 'running'],
    ['running', 'verifying'],
    ['running', 'queued'],
    ['running', 'waiting_quota'],
    ['waiting_quota', 'queued'],
    ['verifying', 'integrating'],
    ['integrating', 'integrated'],
    ['integrating', 'verifying'],
    ['integrating', 'blocked'],
    ['blocked', 'queued'],
    ['failed', 'queued'],
  ])
    assertJobTransition(from, to);
  for (const [from, to] of [
    ['queued', 'verifying'],
    ['queued', 'integrated'],
    ['running', 'integrated'],
    ['running', 'integrating'],
    ['verifying', 'integrated'],
    ['integrated', 'queued'],
    ['integrated', 'cancelled'],
    ['cancelled', 'running'],
    ['integrating', 'running'],
    ['nowhere', 'queued'],
  ])
    code(() => assertJobTransition(from, to), 'job_transition_invalid');
});

test('A dependent is admitted only after its prerequisite is integrated', () => {
  const c = job('c', 'queued', { spec: { dependsOn: ['a'] } });
  for (const state of ['queued', 'running', 'waiting_quota', 'verifying', 'integrating'])
    assert.deepEqual(admission(c, { jobs: [job('a', state), c], limits }), {
      admit: false,
      reason: 'dependency_pending',
      detail: 'a',
    });
  for (const state of ['failed', 'cancelled', 'blocked'])
    assert.deepEqual(admission(c, { jobs: [job('a', state), c], limits }), {
      admit: false,
      reason: 'dependency_unavailable',
      detail: 'a',
    });
  assert.deepEqual(admission(c, { jobs: [job('a', 'integrated'), c], limits }), { admit: true });
});

test('Overlapping write scopes and shared locks are serialized until integration', () => {
  const b = job('b', 'queued', { spec: { writePaths: ['src/a.mjs'] } });
  for (const state of ['running', 'waiting_quota', 'verifying', 'integrating'])
    assert.equal(admission(b, { jobs: [job('a', state), b], limits }).reason, 'scope_conflict', state);
  for (const state of ['queued', 'integrated', 'failed', 'cancelled', 'blocked'])
    assert.equal(admission(b, { jobs: [job('a', state), b], limits }).admit, true, state);
  // A reader must not start from sources another active job is still changing.
  const reader = job('r', 'queued', { spec: { role: 'reviewer', writePaths: [], readPaths: ['src'] } });
  assert.equal(admission(reader, { jobs: [job('a', 'running'), reader], limits }).reason, 'scope_conflict');
  // An isolated worktree snapshot lets a writer start while a reader works.
  const writer = job('w', 'queued');
  assert.equal(admission(writer, { jobs: [{ ...reader, state: 'running' }, writer], limits }).admit, true);
  const locked = job('l', 'queued', { spec: { locks: ['api:public'] } });
  const holder = job('h', 'running', { spec: { locks: ['api:public'] } });
  assert.deepEqual(admission(locked, { jobs: [holder, locked], limits }), {
    admit: false,
    reason: 'lock_conflict',
    detail: 'api:public',
  });
});

test('Worker and subscription pool limits bound concurrently running jobs', () => {
  const next = job('n', 'queued', { spec: { pool: 'codex' } });
  const running = ['a', 'b'].map(key => job(key, 'running', { spec: { pool: 'codex' } }));
  assert.equal(admission(next, { jobs: [...running, next], limits: { workers: 2, pools: {} } }).reason, 'workers_full');
  assert.equal(
    admission(next, { jobs: [...running, next], limits: { workers: 8, pools: { codex: 2 } } }).reason,
    'pool_full',
  );
  assert.equal(admission(next, { jobs: [...running, next], limits: { workers: 8, pools: { codex: 3 } } }).admit, true);
  // Completed-but-not-integrated work holds scopes, not a worker slot.
  const verifying = ['a', 'b'].map(key => job(key, 'verifying'));
  assert.equal(admission(next, { jobs: [...verifying, next], limits: { workers: 1, pools: {} } }).admit, true);
  for (const bad of [{ workers: 0, pools: {} }, { workers: 9, pools: {} }, { workers: 2, pools: { codex: -1 } }, {}])
    code(() => admission(next, { jobs: [next], limits: bad }), 'job_limits_invalid');
});

test('An unconnected host is unavailable and never falls back to native', () => {
  assert.deepEqual(hostStatus('native'), { id: 'native', available: true });
  assert.deepEqual(hostStatus('t3'), { id: 't3', available: false, reason: 'not_connected' });
  assert.deepEqual(hostStatus('orca'), { id: 'orca', available: false, reason: 'not_connected' });
  assert.deepEqual(hostStatus('t3', { t3: { available: true } }), { id: 't3', available: true });
  const remote = job('t', 'queued', { spec: { host: 't3' } });
  assert.deepEqual(admission(remote, { jobs: [remote], limits }), {
    admit: false,
    reason: 'host_unavailable',
    detail: 't3',
  });
  assert.equal(admission(remote, { jobs: [remote], limits, hosts: { t3: { available: true } } }).admit, true);
});

test('Required worker capabilities and tools gate admission to a matching worker', () => {
  const needy = job('n', 'queued', { spec: { capabilities: ['gpu'], requiredTools: ['ripgrep'] } });
  assert.equal(admission(needy, { jobs: [needy], limits }).reason, 'worker_mismatch');
  assert.equal(
    admission(needy, { jobs: [needy], limits, worker: { capabilities: ['gpu'], tools: ['ripgrep', 'rtk'] } }).admit,
    true,
  );
});

test('Ranking is priority first, then age; bypassed jobs gain priority', () => {
  const ranked = rankJobs([
    job('low-old', 'queued', { seq: 1, spec: { priority: 10 } }),
    job('high', 'queued', { seq: 3, spec: { priority: 90 } }),
    job('mid', 'queued', { seq: 2, spec: { priority: 50 } }),
    job('mid-late', 'queued', { seq: 4, spec: { priority: 50 } }),
    job('aged', 'queued', { seq: 5, bypassed: 85, spec: { priority: 10 } }),
  ]);
  assert.deepEqual(
    ranked.map(item => item.key),
    ['aged', 'high', 'mid', 'mid-late', 'low-old'],
  );
});

test('A starved job reserves its scopes against later conflicting work', () => {
  const wide = job('wide', 'queued', { seq: 1, bypassed: STARVATION_BYPASSES, spec: { writePaths: ['src'] } });
  const narrow = job('narrow', 'queued', { seq: 9, spec: { writePaths: ['src/x.mjs'], priority: 90 } });
  const other = job('other', 'queued', { seq: 9, spec: { writePaths: ['docs/x.md'], priority: 90 } });
  const active = job('busy', 'running', { spec: { writePaths: ['src/y.mjs'] } });
  const jobs = [wide, narrow, other, active];
  assert.equal(admission(wide, { jobs, limits }).reason, 'scope_conflict');
  assert.deepEqual(admission(narrow, { jobs, limits }), { admit: false, reason: 'yield_to_starved', detail: 'wide' });
  assert.equal(admission(other, { jobs, limits }).admit, true, 'unrelated work keeps flowing');
  const fresh = { ...wide, bypassed: STARVATION_BYPASSES - 1 };
  assert.equal(admission(narrow, { jobs: [fresh, narrow, other, active], limits }).admit, true);
});
