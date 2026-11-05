import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, realpath, chmod } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { randomUUID, createHash } from 'node:crypto';
import { workerEnvironment } from '../runtime/security.mjs';

const cli = fileURLToPath(new URL('../cli/index.mjs', import.meta.url));
// Fail closed and report observed Node network entry-point attempts in each CLI child.
const networkGuard = 'data:text/javascript,' + encodeURIComponent(`
  import http from 'node:http'; import https from 'node:https';
  import net from 'node:net'; import tls from 'node:tls';
  import { syncBuiltinESMExports } from 'node:module';
  let attempts = 0; const deny = () => { attempts++; throw new Error('offline fixture'); };
  globalThis.fetch = deny; http.request = http.get = https.request = https.get = deny;
  net.connect = net.createConnection = net.Socket.prototype.connect = tls.connect = deny;
  syncBuiltinESMExports(); process.on('exit', () => console.error('network-attempts:' + attempts));
`);
const now = '2026-11-05T12:00:00.000Z';
const git = (cwd, ...args) => execFileSync('git', ['-c', 'core.autocrlf=false', ...args], { cwd, encoding: 'utf8', windowsHide: true, env: workerEnvironment() }).trim();
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
  const invoke = (args, environment = {}, json = true) => {
    const result = spawnSync(process.execPath, ['--import', networkGuard, cli, ...args, '--project', project, ...(json ? ['--json'] : [])], { encoding: 'utf8', windowsHide: true, env: { ...workerEnvironment(), ...environment, KODO_HOME: home, KODO_CREDENTIAL_HOME: path.join(root, 'absent-credentials') } });
    assert.equal(result.error, undefined); assert.ok(result.stdout.trim(), result.stderr);
    assert.ok(result.stderr.includes('network-attempts:0'), result.stderr);
    return { exitCode: result.status, report: json ? JSON.parse(result.stdout) : null, raw: result.stdout + result.stderr };
  };
  return { root, project, home, put, commit, input, context, invoke };
}

test('CLI off status routes before runtime and creates no state or credentials', async t => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'kodo-knowledge-off-'))); t.after(() => rm(root, { recursive: true, force: true }));
  const result = spawnSync(process.execPath, [cli, 'research', 'status', '--project', root, '--json'], { encoding: 'utf8', windowsHide: true, env: { ...workerEnvironment(), KODO_HOME: path.join(root, 'state'), KODO_CREDENTIAL_HOME: path.join(root, 'credentials') } });
  assert.equal(result.status, 0, result.stderr); const report = JSON.parse(result.stdout);
  assert.equal(report.status, 'disabled'); assert.equal(report.requests, 0);
  await assert.rejects(readFile(path.join(root, 'state', 'state.sqlite')), { code: 'ENOENT' });
  await assert.rejects(readFile(path.join(root, 'credentials', 'credentials.dpapi.json')), { code: 'ENOENT' });
});

test('Knowledge argument errors reject before ports and malformed metadata blocks without fallback', async t => {
  const { knowledgeCli } = await import('../runtime/knowledge-cli.mjs');
  let calls = 0; const ports = { loadSecrets() { calls++; throw new Error('must not load credentials'); }, loadKnowledgeContext() { calls++; throw new Error('must not load'); }, openKnowledgeReader() { calls++; throw new Error('must not open'); } };
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
  const result = await knowledgeCli(['research', 'refresh', '--project', fx.project, '--input', 'input.json', '--json'], { secrets: {}, home: fx.home, now: () => now, fetchImpl() { fetches++; throw new Error('offline'); } });
  assert.equal(result.report.status, 'refreshed', JSON.stringify(result.report)); assert.equal(fetches, 0);
  const inspect = () => knowledgeCli(['knowledge', 'inspect', '--project', fx.project, '--json'], { secrets: {}, home: fx.home, now: () => now });
  let current = await inspect(); assert.equal(current.report.projection.references.length, 1); assert.equal(current.report.projection.references[0].kind, 'synthetic-reference');
  assert.equal(fx.invoke(['knowledge', 'inspect']).report.evaluation.rows.length, 1, 'new subprocess reopens captured history');
  const scoped = await knowledgeCli(['knowledge', 'inspect', '--project', fx.project, '--subject', 'absent'], { secrets: {}, home: fx.home, now: () => now }); assert.equal(scoped.report.evaluation.rows.length, 0);
  const override = await knowledgeCli(['knowledge', 'inspect', '--project', fx.project, '--context', 'override.json'], { secrets: {}, home: fx.home, now: () => now });
  assert.equal(override.report.context.contextSource, 'override'); assert.equal(override.report.projection.references.length, 0); assert.equal(JSON.parse(await readFile(path.join(fx.project, 'research.context.json'), 'utf8')).versions.patch, 'A');
  const human = await knowledgeCli(['knowledge', 'inspect', '--project', fx.project], { secrets: {}, home: fx.home, now: () => now }); assert.ok(human.output.includes('UNTRUSTED')); assert.ok(human.output.includes('fixture'));

  const replay = await knowledgeCli(['research', 'refresh', '--project', fx.project, '--input', 'input.json'], { secrets: {}, home: fx.home, now: () => '2026-11-06T12:00:00.000Z' });
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

async function secretFixture(t) {
  const fx = await fixture(t), value = 'owned-fixture-' + randomUUID();
  fx.input.claims[0].value = value;
  await fx.put('input.json', fx.input); await fx.put('data.json', { value }); fx.commit();
  return { ...fx, value };
}

test('Default CLI rejects a known generated credential before capture and prints no secret', async t => {
  for (const variable of ['SCRAPEDO_TOKEN', 'KODO_SCRAPEDO_TOKEN']) {
    const fx = await secretFixture(t);
    const result = fx.invoke(['research', 'refresh', '--input', 'input.json'], { [variable]: fx.value });
    assert.equal(result.exitCode, 1); assert.equal(result.report.status, 'blocked');
    assert.equal(result.report.errors[0].code, 'knowledge_secret');
    assert.equal(result.raw.includes(fx.value), false);
    const { openKnowledgeReader } = await import('../runtime/store.mjs');
    const reader = openKnowledgeReader(fx.home);
    try { assert.deepEqual(reader.listKnowledgeClaims(fx.project, { history: true }), []); }
    finally { reader.close(); }
    await assert.rejects(readFile(path.join(fx.home, 'knowledge-evidence')), { code: 'ENOENT' });
  }
});

test('Previously unknown stored credential is blocked before JSON human and native inspection without history mutation', async t => {
  const fx = await secretFixture(t);
  const seed = fx.invoke(['research', 'refresh', '--input', 'input.json']);
  assert.equal(seed.report.status, 'refreshed'); assert.equal(seed.report.capture.claims[0].value, fx.value);
  const { openKnowledgeReader } = await import('../runtime/store.mjs');
  const history = () => { const reader = openKnowledgeReader(fx.home); try { return reader.listKnowledgeClaims(fx.project, { history: true }); } finally { reader.close(); } };
  const before = history(), dbBefore = await readFile(path.join(fx.home, 'state.sqlite'));
  const evidence = before[0].source.evidenceRef;
  const evidenceBefore = await readFile(evidence.path);
  assert.equal(createHash('sha256').update(evidenceBefore).digest('hex'), evidence.sha256);
  for (const json of [true, false]) {
    const result = fx.invoke(['knowledge', 'inspect'], { SCRAPEDO_TOKEN: fx.value }, json);
    assert.equal(result.exitCode, 1); assert.equal(result.raw.includes(fx.value), false);
    if (json) { assert.equal(result.report.status, 'blocked'); assert.equal(result.report.errors[0].code, 'knowledge_secret'); assert.equal(result.report.evaluation, undefined); }
    else assert.ok(result.raw.includes('knowledge_secret'));
  }
  const { knowledgeSnapshot } = await import('../runtime/knowledge-cli.mjs');
  let evidenceChecks = 0;
  await assert.rejects(knowledgeSnapshot({ project: fx.project }, { home: fx.home, secrets: { SCRAPEDO_TOKEN: fx.value }, checkKnowledgeEvidence() { evidenceChecks++; throw new Error('must reject before evidence'); } }), { code: 'knowledge_secret' });
  assert.equal(evidenceChecks, 0);
  assert.deepEqual(history(), before);
  assert.deepEqual(await readFile(path.join(fx.home, 'state.sqlite')), dbBefore);
  assert.deepEqual(await readFile(evidence.path), evidenceBefore);
  const neutral = fx.invoke(['knowledge', 'inspect']);
  assert.equal(neutral.report.status, 'ready'); assert.equal(neutral.report.evaluation.rows[0].claim.value, fx.value);
});

test('Credential loading is lazy for off and invalid arguments and explicit secrets bypass the loader', async t => {
  const { knowledgeCli, knowledgeSnapshot } = await import('../runtime/knowledge-cli.mjs');
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'kodo-knowledge-lazy-'))); t.after(() => rm(root, { recursive: true, force: true }));
  let calls = 0;
  const ports = { loadSecrets() { calls++; throw new Error('must not load'); }, openKnowledgeReader() { calls++; throw new Error('must not read KB'); } };
  for (const args of [['research', 'status'], ['research', 'refresh', '--input', 'missing.json'], ['knowledge', 'inspect']]) {
    assert.equal((await knowledgeCli([...args, '--project', root], ports)).report.status, 'disabled');
  }
  assert.equal((await knowledgeSnapshot({ project: root }, ports)).status, 'disabled'); assert.equal(calls, 0);
  const fx = await fixture(t);
  const status = await knowledgeCli(['research', 'status', '--project', fx.project], { ...ports, secrets: {} });
  assert.equal(status.report.status, 'ready'); assert.equal(calls, 0);
  assert.equal((await knowledgeSnapshot({ project: fx.project }, { home: fx.home, secrets: {}, loadSecrets: ports.loadSecrets })).status, 'ready');
  assert.equal(calls, 0);
  const blocked = await knowledgeCli(['knowledge', 'inspect', '--project', fx.project], ports);
  assert.equal(blocked.report.status, 'blocked'); assert.equal(calls, 1);
  const known = 'owned-context-' + randomUUID();
  await fx.put('research.context.json', { ...fx.context, versions: { patch: known } }); fx.commit();
  let loads = 0;
  const protectedStatus = await knowledgeCli(['research', 'status', '--project', fx.project, '--json'], { loadSecrets() { loads++; return { SCRAPEDO_TOKEN: known }; } });
  assert.equal(loads, 1); assert.equal(protectedStatus.report.status, 'blocked'); assert.equal(protectedStatus.output.includes(known), false);
});

test('Missing credentials preserve normal capture and configured lower caps', async t => {
  const fx = await fixture(t);
  const currentTime = new Date().toISOString();
  fx.input.claims[0].source.retrievedAt = currentTime; fx.input.claims[0].source.validAsOf = currentTime;
  await fx.put('input.json', fx.input);
  await fx.put('research.policy.json', { ...policy, maxClaims: 1, maxContextBytes: 128 }); fx.commit();
  const captured = fx.invoke(['research', 'refresh', '--input', 'input.json']);
  assert.equal(captured.report.status, 'refreshed'); assert.equal(captured.report.capture.claims[0].value, 7);
  const status = fx.invoke(['research', 'status']);
  assert.equal(status.report.policy.maxClaims, 1); assert.equal(status.report.policy.maxContextBytes, 128);
  const inspected = fx.invoke(['knowledge', 'inspect']);
  assert.equal(inspected.exitCode, 0); assert.equal(inspected.report.status, 'ready');
  assert.equal(inspected.report.projection.references.length, 0);
  assert.deepEqual(inspected.report.projection.omitted, [{ field: 'references', items: 1 }]);
  assert.ok(Buffer.byteLength(JSON.stringify(inspected.report.projection)) <= 128);
});
