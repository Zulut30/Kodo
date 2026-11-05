import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, realpath, chmod } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const cli = fileURLToPath(new URL('../cli/index.mjs', import.meta.url));
const now = '2026-11-05T12:00:00.000Z';
const git = (cwd, ...args) => execFileSync('git', ['-c', 'core.autocrlf=false', ...args], { cwd, encoding: 'utf8', windowsHide: true }).trim();
const policy = { schemaVersion: 1, mode: 'local-only', sourcePaths: ['data.json'], allowedOrigins: [], maxRequests: 0, ttlSeconds: { domain: 86400, product: 86400, technical: 604800, codebase: 3600 }, maxClaims: 200, maxEvidenceBytes: 1048576, maxContextBytes: 2048 };
async function fixture(t) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'kodo-knowledge-cli-'))), project = path.join(root, 'project'), home = path.join(root, 'state');
  await mkdir(project); t.after(() => rm(root, { recursive: true, force: true }));
  const put = (file, data) => writeFile(path.join(project, file), JSON.stringify(data));
  const context = { schemaVersion: 1, versions: { patch: 'A' }, synthetic: true };
  const input = { schemaVersion: 1, captureId: 'first', synthetic: true, claims: [{ domain: 'product', subject: 'fixture', key: 'value', value: 7, versions: { patch: 'A' }, source: { id: 'fixture-value', kind: 'local', url: null, path: 'data.json', pointer: '/value', retrievedAt: now, validAsOf: now }, confidence: null, unknowns: [] }] };
  await put('research.policy.json', policy); await put('research.context.json', context); await put('override.json', { ...context, versions: { patch: 'B' } }); await put('input.json', input); await put('data.json', { value: 7 });
  git(project, 'init', '-q'); git(project, 'config', 'user.name', 'Fixture'); git(project, 'config', 'user.email', 'fixture@example.invalid');
  const commit = () => { git(project, 'add', '-A'); git(project, 'commit', '-qm', 'fixture'); return git(project, 'rev-parse', 'HEAD'); }; commit();
  const invoke = args => {
    const result = spawnSync(process.execPath, [cli, ...args, '--project', project, '--json'], { encoding: 'utf8', windowsHide: true, env: { ...process.env, KODO_HOME: home, KODO_CREDENTIAL_HOME: path.join(root, 'absent-credentials') } });
    assert.equal(result.error, undefined); assert.ok(result.stdout.trim(), result.stderr);
    return { exitCode: result.status, report: JSON.parse(result.stdout) };
  };
  return { root, project, home, put, commit, input, context, invoke };
}

test('CLI off status routes before runtime and creates no state or credentials', async t => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'kodo-knowledge-off-'))); t.after(() => rm(root, { recursive: true, force: true }));
  const result = spawnSync(process.execPath, [cli, 'research', 'status', '--project', root, '--json'], { encoding: 'utf8', windowsHide: true, env: { ...process.env, KODO_HOME: path.join(root, 'state'), KODO_CREDENTIAL_HOME: path.join(root, 'credentials') } });
  assert.equal(result.status, 0, result.stderr); const report = JSON.parse(result.stdout);
  assert.equal(report.status, 'disabled'); assert.equal(report.requests, 0);
  await assert.rejects(readFile(path.join(root, 'state', 'state.sqlite')), { code: 'ENOENT' });
  await assert.rejects(readFile(path.join(root, 'credentials', 'credentials.dpapi.json')), { code: 'ENOENT' });
});

test('Knowledge argument errors reject before ports and malformed metadata blocks without fallback', async t => {
  const { knowledgeCli } = await import('../runtime/knowledge-cli.mjs');
  let calls = 0; const ports = { loadKnowledgeContext() { calls++; throw new Error('must not load'); }, openKnowledgeReader() { calls++; throw new Error('must not open'); } };
  for (const args of [['research'], ['research', 'inspect'], ['knowledge', 'status'], ['research', 'status', '--context', 'x'], ['research', 'refresh'], ['knowledge', 'inspect', '--subject'], ['knowledge', 'inspect', '--json', '--json'], ['research', 'refresh', '--input', 'x', '--unknown'], ['knowledge', 'inspect', 'extra'], ['research', 'status', '--project', '--json']]) {
    const result = await knowledgeCli(args, ports); assert.equal(result.exitCode, 1); assert.equal(result.report.status, 'blocked');
  }
  assert.equal(calls, 0);
  const fx = await fixture(t); assert.equal(fx.invoke(['knowledge', 'inspect']).report.evaluation.rows.length, 0); await assert.rejects(readFile(path.join(fx.home, 'state.sqlite')), { code: 'ENOENT' }); assert.equal(fx.invoke(['research', 'refresh', '--input', 'input.json']).report.status, 'refreshed'); assert.equal(fx.invoke(['knowledge', 'inspect']).report.evaluation.rows.length, 1); await fx.put('research.context.json', { ...fx.context, headSha: 'forbidden' }); fx.commit();
  for (const args of [['research', 'status'], ['knowledge', 'inspect'], ['research', 'refresh', '--input', 'input.json']]) {
    const result = fx.invoke(args); assert.equal(result.exitCode, 1); assert.equal(result.report.status, 'blocked'); assert.equal(result.report.requests, 0);
  }
});

test('Actual CLI refresh reopen patch history source and tamper invalidation remain offline', async t => {
  const fx = await fixture(t), { knowledgeCli } = await import('../runtime/knowledge-cli.mjs'); let fetches = 0;
  const result = await knowledgeCli(['research', 'refresh', '--project', fx.project, '--input', 'input.json', '--json'], { home: fx.home, now: () => now, fetchImpl() { fetches++; throw new Error('offline'); } });
  assert.equal(result.report.status, 'refreshed', JSON.stringify(result.report)); assert.equal(fetches, 0);
  const inspect = () => knowledgeCli(['knowledge', 'inspect', '--project', fx.project, '--json'], { home: fx.home, now: () => now });
  let current = await inspect(); assert.equal(current.report.projection.references.length, 1); assert.equal(current.report.projection.references[0].kind, 'synthetic-reference');
  assert.equal(fx.invoke(['knowledge', 'inspect']).report.evaluation.rows.length, 1, 'new subprocess reopens captured history');
  const scoped = await knowledgeCli(['knowledge', 'inspect', '--project', fx.project, '--subject', 'absent'], { home: fx.home, now: () => now }); assert.equal(scoped.report.evaluation.rows.length, 0);
  const override = await knowledgeCli(['knowledge', 'inspect', '--project', fx.project, '--context', 'override.json'], { home: fx.home, now: () => now });
  assert.equal(override.report.context.contextSource, 'override'); assert.equal(override.report.projection.references.length, 0); assert.equal(JSON.parse(await readFile(path.join(fx.project, 'research.context.json'), 'utf8')).versions.patch, 'A');
  const human = await knowledgeCli(['knowledge', 'inspect', '--project', fx.project], { home: fx.home, now: () => now }); assert.ok(human.output.includes('UNTRUSTED')); assert.ok(human.output.includes('fixture'));

  const replay = await knowledgeCli(['research', 'refresh', '--project', fx.project, '--input', 'input.json'], { home: fx.home, now: () => '2026-11-06T12:00:00.000Z' });
  assert.equal(replay.report.status, 'replayed'); assert.equal(replay.report.capture.capturedAt, now);
  await fx.put('research.context.json', { ...fx.context, versions: { patch: 'B' } }); fx.commit();
  current = await inspect(); assert.equal(current.report.projection.references.length, 0); assert.ok(current.report.evaluation.rows[0].reasons.includes('version_mismatch:patch'));
  await fx.put('research.context.json', { ...fx.context, versions: {} }); fx.commit();
  current = await inspect(); assert.equal(current.report.projection.references.length, 0); assert.ok(current.report.evaluation.rows[0].reasons.includes('missing_current_version:patch'));
  const { openKnowledgeReader } = await import('../runtime/store.mjs'); const reader = openKnowledgeReader(fx.home);
  const history = reader.listKnowledgeClaims(fx.project, { history: true }); reader.close(); assert.equal(history.length, 1); assert.equal(history[0].versions.patch, 'A');
  const ref = history[0].source.evidenceRef; await chmod(ref.path, 0o600); await writeFile(ref.path, '{}');
  current = await inspect(); assert.equal(current.report.projection.references.length, 0); assert.ok(current.report.evaluation.rows[0].reasons.includes('evidence_unverified'));
});
