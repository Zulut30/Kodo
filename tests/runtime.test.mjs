import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, readdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { Store } from '../runtime/store.mjs';
import { redact, workerEnvironment } from '../runtime/security.mjs';
import { validatePlan, scopesOverlap, ownsPath } from '../runtime/contracts.mjs';
import { migrate } from '../runtime/migration.mjs';
import { readConfig, initConfig } from '../runtime/config.mjs';

async function temp(t) { const root = await mkdtemp(path.join(os.tmpdir(), 'kodo-core-test-')); t.after(async () => { assert.equal(path.dirname(root), path.resolve(os.tmpdir())); assert.ok(path.basename(root).startsWith('kodo-core-test-')); await rm(root, { recursive: true, force: true }); }); return root; }
test('Store persists run events and redacts secrets across reopen', async t => {
  let second; t.after(() => second?.close());
  const home = await temp(t), secrets = { GEMINI_API_KEY: 'fake-sensitive-credential-123' };
  const first = new Store(home, secrets); const run = first.createRun({ task: 'task with fake-sensitive-credential-123', project: '/project' });
  first.updateRun(run.id, { state: 'awaiting_plan', sessionId: 'exact-session' }); first.event(run.id, 'result', { error: 'fake-sensitive-credential-123' }); first.close();
  second = new Store(home);
  assert.equal(second.getRun(run.id).state, 'awaiting_plan'); assert.equal(second.getRun(run.id).sessionId, 'exact-session');
  assert.equal(second.getRun(run.id).task, 'task with [REDACTED]'); assert.equal(second.events(run.id).at(-1).data.error, '[REDACTED]');
  assert.equal(second.listRuns('/other').length, 0); assert.throws(() => second.getRun('missing'), /не найден/);
});
test('Subscription leases cap concurrent sessions and expire without stealing active slots', async t => {
  let store; t.after(() => store?.close()); store = new Store(await temp(t));
  const first = store.acquireLease('account', 'a', { limit: 2 }); const second = store.acquireLease('account', 'b', { limit: 2 });
  assert.ok(first); assert.ok(second); assert.equal(store.acquireLease('account', 'c', { limit: 2 }), null);
  assert.equal(store.renewLease(first), true); store.releaseLease(first); assert.equal(store.renewLease(first), false);
  assert.ok(store.acquireLease('account', 'c', { limit: 2 }));
  const expired = store.acquireLease('expired', 'owner', { ttlMs: -1 }); assert.ok(expired); assert.ok(store.acquireLease('expired', 'next')); assert.equal(store.renewLease(expired), false);
});
test('Worker environment removes all provider secrets and endpoint overrides', () => {
  const env = workerEnvironment({ PATH: 'allowed', GEMINI_API_KEY: 'private', TYPESAFE_API_KEY: 'private', SCRAPEDO_TOKEN: 'private', GETX_API_KEY: 'private', REDDIT_API_KEY: 'private', GH_TOKEN: 'private', OPENAI_API_KEY: 'private', ANTHROPIC_API_KEY: 'private', OPENAI_BASE_URL: 'private', ANTHROPIC_BASE_URL: 'private', NPM_TOKEN: 'private', AWS_SECRET_ACCESS_KEY: 'private', AWS_SESSION_TOKEN: 'private', DATABASE_URL: 'private', DB_PASSWORD: 'private', KODO_OTHER: 'private', CODEX_APP_TOOLS_PIPE_PATH: 'parent' });
  assert.deepEqual(env, { PATH: 'allowed' }); assert.equal(redact('https://example.test/?token=private&x=1 Bearer abcdefgh123'), 'https://example.test/?token=[REDACTED]&x=1 Bearer [REDACTED]');
});

test('Redaction preserves JSON structure while removing secrets containing quotes and backslashes', () => {
  const secret = 'fixture-"quoted"-\\credential';
  const value = { nested: [{ text: `before ${secret} after` }], literal: 'ordinary "quoted" text' };
  assert.deepEqual(redact(value, { KEY: secret }), { nested: [{ text: 'before [REDACTED] after' }], literal: value.literal });
});
test('Redaction preserves literal variable references but removes real credentials and mixed interpolation tokens', () => {
  const examples = ['Bearer ${token}', 'bearer ${process.env.API_KEY}', 'https://example.invalid/?key=${process.env.API_KEY}&token=${token}'];
  for (const example of examples) assert.equal(redact(example), example);
  for (const token of ['actual-private-token', '${token}-private-suffix', 'private-prefix${token}', '${getToken()}', '${token']) {
    assert.equal(redact(`Bearer ${token}`), 'Bearer [REDACTED]');
    assert.equal(redact(`https://example.invalid/?token=${token}`), 'https://example.invalid/?token=[REDACTED]');
  }
  const secret = 'fixture_private_credential';
  assert.equal(redact('Bearer ${fixture_private_credential}', { KEY: secret }), 'Bearer [REDACTED]', 'known credentials take precedence over placeholder syntax');
  const shaped = 'sk-proj-' + 'a'.repeat(24);
  assert.doesNotMatch(redact(`Bearer \${${shaped}}`), new RegExp(shaped));
});
test('Redaction retains source and Markdown delimiters around complete credential templates', () => {
  const examples = [
    'const header = `Bearer ${token}`;',
    'const header = `Bearer ${process.env.API_KEY}`;',
    'Preserve `Bearer ${token}` and all criteria.',
    'const url = `https://example.invalid/?key=${process.env.API_KEY}&token=${token}`;'
  ];
  for (const example of examples) assert.equal(redact(example), example);
  for (const token of ['literal-private-token', '${token}-private-suffix', 'private-prefix${token}', '${token}private', '${getToken()}', '${token']) {
    assert.equal(redact('const header = `Bearer ' + token + '`;'), 'const header = `Bearer [REDACTED]`;');
    assert.equal(redact('const url = `https://example.invalid/?token=' + token + '`;'), 'const url = `https://example.invalid/?token=[REDACTED]`;');
  }
  const secret = 'fixture_private_credential', shaped = 'sk-proj-' + 'b'.repeat(24);
  for (const token of ['${' + secret + '}', '${' + shaped + '}', '${token}-' + shaped]) {
    assert.equal(redact('const header = `Bearer ' + token + '`;', { KEY: secret }), 'const header = `Bearer [REDACTED]`;');
  }
});
test('Redaction preserves escaped source quote boundaries without allowing credential suffixes', () => {
  const example = 'Preserve source: const header = "\\\"Bearer ${token}\\\"";';
  const escapedQuote = String.fromCharCode(92, 34);
  assert.ok(example.includes(escapedQuote + 'Bearer ${token}' + escapedQuote), 'exercise raw source escapes, before any JSON serialization');
  assert.equal(redact(example), example);
  const secret = 'fixture_private_credential', shaped = 'sk-proj-' + 'e'.repeat(24);
  for (const candidate of ['literal-private-token', '${token}-private-suffix', 'private-prefix${token}', '${token}private', '${token}\\private-suffix', '${token}\\', '${getToken()}', '${' + secret + '}', '${' + shaped + '}']) {
    const source = example.replace('${token}', candidate);
    assert.equal(redact(source, { KEY: secret }), 'Preserve source: const header = "\\\"Bearer [REDACTED]\\\"";');
  }
  for (const delimiter of ['"', "'", String.fromCharCode(96)]) {
    const boundary = '\\' + delimiter;
    for (const placeholder of ['${token}', '${process.env.API_KEY}']) {
      const reference = boundary + 'Bearer ' + placeholder + boundary;
      assert.equal(redact(reference), reference);
      assert.equal(redact(boundary + 'Bearer ${token}-private-suffix' + boundary), boundary + 'Bearer [REDACTED]' + boundary);
      const query = boundary + 'https://example.invalid/?token=' + placeholder + boundary;
      assert.equal(redact(query), query);
      assert.equal(redact(boundary + 'https://example.invalid/?token=${token}-private-suffix' + boundary), boundary + 'https://example.invalid/?token=[REDACTED]' + boundary);
    }
    assert.equal(redact(boundary + 'Bearer ${token}\\' + boundary), boundary + 'Bearer [REDACTED]' + boundary, 'another backslash is still a credential suffix');
  }
  assert.equal(redact('Bearer ${token}\\'), 'Bearer [REDACTED]', 'a trailing backslash without a quote is a mixed token');
});
test('Plan contracts reject malformed graphs and forbidden scopes while overlap stays conservative', () => {
  const plan = { summary: 'feature', tasks: [{ id: 'one', role: 'developer', description: 'feature', dependsOn: [], writePaths: ['src/**'], acceptance: ['works'], parallel: true }] };
  assert.equal(validatePlan(plan), plan); assert.equal(ownsPath(['src/**'], 'src/feature.mjs'), true); assert.equal(ownsPath(['src/**'], 'test/feature.mjs'), false);
  assert.equal(scopesOverlap(['src/**'], ['src/lib/**']), true); assert.equal(scopesOverlap(['src/**'], ['docs/**']), false); assert.equal(scopesOverlap(['**/*.mjs'], ['src/lib.mjs']), true);
  for (const scopes of [['../escape'], ['/outside'], ['C:/outside'], ['.git/config'], ['src/../../escape'], ['.env.local']]) assert.throws(() => validatePlan({ ...plan, tasks: [{ ...plan.tasks[0], writePaths: scopes }] }));
  assert.throws(() => validatePlan({ ...plan, tasks: [{ ...plan.tasks[0], dependsOn: ['missing'] }] }), /Неизвестная/);
  assert.throws(() => validatePlan({ ...plan, tasks: [{ ...plan.tasks[0], dependsOn: ['one'] }] }), /Цикл/);
  assert.throws(() => validatePlan({ ...plan, tasks: [plan.tasks[0], plan.tasks[0]] }), /Повторные/);
});
test('Legacy migration preserves managed content and refuses modified user files before writes', async t => {
  const root = await temp(t), legacy = '.agents/skills/aitk-architect/SKILL.md', source = Buffer.from('---\nname: aitk-architect\n---\nAI Toolkit\n');
  await mkdir(path.join(root, '.ai-toolkit'), { recursive: true }); await mkdir(path.dirname(path.join(root, legacy)), { recursive: true }); await writeFile(path.join(root, legacy), source);
  const hash = createHash('sha256').update(source).digest('hex');
  await writeFile(path.join(root, '.ai-toolkit/lock.json'), JSON.stringify({ schemaVersion: 1, files: { [legacy]: { sha256: hash, component: 'agents/architect', version: '0.1.0' } } }));
  await writeFile(path.join(root, legacy), 'user edit'); await assert.rejects(migrate(root), /изменён пользователем/); assert.equal(await readFile(path.join(root, legacy), 'utf8'), 'user edit');
  assert.equal((await readdir(root)).includes('.kodo'), false);
  await writeFile(path.join(root, legacy), source); const result = await migrate(root); assert.equal(result.migrated, true);
  assert.equal(await readFile(path.join(root, '.agents/skills/kodo-architect/SKILL.md'), 'utf8'), '---\nname: kodo-architect\n---\nKodo\n');
  const lock = JSON.parse(await readFile(path.join(root, '.kodo/lock.json'), 'utf8')); assert.ok(lock.files['.agents/skills/kodo-architect/SKILL.md']);
  assert.deepEqual(await migrate(root), { migrated: false, reason: 'legacy_not_found' });
});
test('Config initialization never overwrites a project and rejects unsafe execution settings', async t => {
  const root = await temp(t); await initConfig(root); await assert.rejects(initConfig(root), { code: 'EEXIST' });
  assert.equal((await readConfig(root)).concurrency, 2);
  await writeFile(path.join(root, 'kodo.config.json'), JSON.stringify({ schemaVersion: 1, client: 'codex', primaryModel: 'gpt-6.1-sol' }));
  assert.equal((await readConfig(root, { client: 'claude-code' })).primaryModel, null);
  assert.equal((await readConfig(root, { client: 'claude-code', primaryModel: 'opus' })).primaryModel, 'opus');
  await writeFile(path.join(root, 'kodo.config.json'), JSON.stringify({ schemaVersion: 1, concurrency: 3 })); await assert.rejects(readConfig(root), /конфигурация/);
  await writeFile(path.join(root, 'kodo.config.json'), JSON.stringify({ schemaVersion: 1, commands: { test: [{ command: 'npm', args: [17] }] } })); await assert.rejects(readConfig(root), /команды/);
});
