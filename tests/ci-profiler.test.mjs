import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm, readdir, symlink } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { watch } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { execute } from '../runtime/delivery.mjs';
import { summarizeProfile, runProfiledCommand } from '../runtime/ci-profiler.mjs';
import reporter from '../scripts/ci-reporter.mjs';

const repo = fileURLToPath(new URL('../', import.meta.url));
const reporterPath = new URL('../scripts/ci-reporter.mjs', import.meta.url).href;
async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'kodo-ci-profile-test-'));
  t.after(async () => {
    assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith('kodo-ci-profile-test-'));
    await rm(root, { recursive: true, force: true });
  });
  const cwd = path.join(root, 'project'); await mkdir(cwd);
  return { root, cwd, evidenceDir: path.join(root, 'evidence') };
}
const span = (id, durationMs, extra = {}) => ({ kind: 'span', id, bucket: 'testFile', durationMs, status: 'passed', ...extra });
const summary = (file, duration_ms, failed = 0) => ({ type: 'test:summary', data: { file, duration_ms, success: failed === 0, counts: { tests: 2, failed, passed: 2 - failed, cancelled: 0, skipped: 0, todo: 0 } } });

test('Profile computes nearest-rank distributions and explicit dependency critical path', () => {
  const report = summarizeProfile([
    span('a', 10, { startMs: 100, dependsOn: [] }),
    span('b', 20, { startMs: 100, dependsOn: [] }),
    span('c', 100, { startMs: 120, dependsOn: ['a', 'b'], status: 'failed' })
  ]);
  assert.equal(report.schemaVersion, 1);
  assert.equal(report.buckets.testFile.count, 3);
  assert.equal(report.buckets.testFile.p50Ms, 20);
  assert.equal(report.buckets.testFile.p90Ms, 100);
  assert.equal(report.buckets.testFile.failures, 1);
  assert.equal(report.wallMs, 120);
  assert.equal(report.criticalPathMs, 120);
});

test('Empty and partial profiles never invent missing measurements', () => {
  const empty = summarizeProfile([]);
  assert.equal(empty.wallMs, null); assert.equal(empty.criticalPathMs, null);
  for (const bucket of Object.values(empty.buckets)) assert.equal(bucket, null);
  const partial = summarizeProfile([summary('a.mjs', 42), { type: 'test:start', data: { file: 'slow.mjs' } }]);
  assert.equal(partial.buckets.testFile.p50Ms, 42);
  assert.equal(partial.buckets.testFile.retries, null);
  assert.equal(partial.wallMs, null); assert.equal(partial.criticalPathMs, null);
  for (const name of ['setup', 'queue', 'toolInstall', 'powershell', 'acl', 'gitWorktree', 'packageSmoke']) assert.equal(partial.buckets[name], null);
});

test('Profile ignores malformed events and bounds both ingestion and public details', () => {
  const invalid = [null, 'broken', {}, span('x', -1), summary('x', NaN), span('x', Infinity), { type: 'test:pass', data: {} }];
  const result = summarizeProfile([...invalid, ...Array.from({ length: 10 }, (_, n) => span(`id${n}`, n))], { maxRecords: 12, maxDetails: 2 });
  assert.equal(result.malformedRecords, 7);
  assert.equal(result.omittedRecords, 5);
  assert.equal(result.buckets.testFile.count, 5);
  assert.equal(result.details.length, 2); assert.equal(result.omittedDetails, 3);
  assert.ok(JSON.stringify(result).length < 8000);
  assert.throws(() => summarizeProfile('not an array'), /records/i);
});

test('Retries and flaky labels require observed attempt evidence', () => {
  const report = summarizeProfile([
    span('retry', 4, { attempt: 1, status: 'failed' }),
    span('retry', 5, { attempt: 2 }),
    span('alwaysFails', 6, { attempt: 1, status: 'failed' }),
    span('alwaysFails', 7, { attempt: 2, status: 'failed' }),
    span('label', 8, { flaky: true })
  ]);
  assert.equal(report.buckets.testFile.retries, 2);
  assert.equal(report.buckets.testFile.flakyObserved, 1);
  assert.equal(report.buckets.testFile.flakyLabelled, 1);
  assert.equal(report.buckets.testFile.failures, 3);
  const cycle = summarizeProfile([span('a', 1, { dependsOn: ['b'] }), span('b', 1, { dependsOn: ['a'] })]);
  assert.equal(cycle.criticalPathMs, null);
});

test('Public profile allowlists fields and hashes arbitrary labels', () => {
  const secret = 'sensitive-custom-value';
  const report = summarizeProfile([span(secret, 2, { file: secret, env: { PRIVATE: secret }, args: [secret], phase: secret, error: secret })], { env: { PRIVATE: secret } });
  assert.ok(!JSON.stringify(report).includes(secret));
  assert.match(report.details[0].id, /^[a-f0-9]{64}$/);
  assert.ok(!JSON.stringify(report).includes('PRIVATE'));
});

test('Reporter emits only actual per-file summary timing and no test-name inference', async () => {
  async function* source() {
    yield { type: 'test:pass', data: { name: 'fake.test.mjs', file: '/real.mjs', details: { duration_ms: 999 }, nesting: 0 } };
    yield summary('/real.mjs', 12, 1);
    yield summary(undefined, 30, 1);
    yield { type: 'test:summary', data: { file: '/bad.mjs', duration_ms: -1 } };
  }
  let output = ''; for await (const chunk of reporter(source())) output += chunk;
  const records = output.trim().split('\n').map(line => JSON.parse(line));
  assert.equal(records.length, 2);
  assert.equal(records[0].data.duration_ms, 12);
  const report = summarizeProfile(records);
  assert.equal(report.buckets.testFile.count, 1); assert.equal(report.buckets.testFile.p50Ms, 12);
  assert.equal(report.wallMs, 30); assert.equal(report.tests.failed, 1);
});

test('Profiled command retains TAP stderr and exact failing exit without exposing arguments', async t => {
  const f = await fixture(t);
  const sentinel = 'private-argument-7311';
  const result = await runProfiledCommand({ ...f, command: process.execPath, args: ['-e', "console.log('TAP version 13'); console.error('failure detail'); process.exit(7)", sentinel], phase: 'unit', tier: 'L1' });
  assert.equal(result.exitCode, 7); assert.match(result.stdout, /TAP version 13/); assert.match(result.stderr, /failure detail/);
  assert.ok(result.durationMs > 0);
  const report = JSON.parse(await readFile(result.profilePath, 'utf8'));
  assert.equal(report.buckets.command.failures, 1);
  assert.ok(!JSON.stringify(report).includes(sentinel));
  const logs = await readdir(path.dirname(result.profilePath));
  assert.ok(logs.includes('stdout.log')); assert.ok(logs.includes('stderr.log'));
  assert.equal(await readFile(path.join(path.dirname(result.profilePath), 'stdout.log'), 'utf8'), result.stdout);
});

test('Node24 real events distinguish file duration from deceptive test name and retain failed TAP', async t => {
  const f = await fixture(t);
  await writeFile(path.join(f.cwd, 'actual.test.mjs'), "import test from 'node:test'; import assert from 'node:assert/strict'; test('pretend.other.test.mjs', () => assert.fail('regression reason'));\n");
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => key !== 'NODE_TEST_CONTEXT'));
  const result = await runProfiledCommand({ ...f, env, command: process.execPath, args: ['--test', '--test-reporter=tap', '--test-reporter-destination=stdout', `--test-reporter=${reporterPath}`, '--test-reporter-destination=stderr', 'actual.test.mjs'] });
  assert.equal(result.exitCode, 1, result.stderr); assert.match(result.stdout, /regression reason/);
  const report = JSON.parse(await readFile(result.profilePath, 'utf8'));
  assert.equal(report.buckets.testFile.count, 1); assert.ok(report.buckets.testFile.p50Ms > 0);
  assert.equal(report.tests.failed, 1); assert.equal(report.buckets.testFile.failures, 1);
  assert.equal(report.buckets.test, null);
});

test('Command secrets are removed before private logs and public profile are persisted', async t => {
  const f = await fixture(t); const secret = 'custom-secret-value-23914';
  const result = await runProfiledCommand({ ...f, env: { ...process.env, CUSTOM_TOKEN: secret }, command: process.execPath, args: ['-e', `console.log(${JSON.stringify(secret)}); console.error('Bearer example-token')`] });
  assert.ok(!result.stdout.includes(secret)); assert.match(result.stdout, /REDACTED/);
  for (const file of await readdir(path.dirname(result.profilePath))) {
    const bytes = await readFile(path.join(path.dirname(result.profilePath), file), 'utf8');
    assert.ok(!bytes.includes(secret)); assert.ok(!bytes.includes('example-token'));
  }
});

test('Overlapping known environment secrets cannot expose a tail in successful command logs', async t => {
  const f = await fixture(t);
  const result = await runProfiledCommand({ ...f, env: { ...process.env, FIRST_TOKEN: 'alpha-overlap', SECOND_TOKEN: 'overlap-omega' }, command: process.execPath, args: ['-e', "console.log('alpha-overlap-omega')"] });
  assert.equal(result.stdout, '[REDACTED]\n');
  assert.equal(await readFile(path.join(path.dirname(result.profilePath), 'stdout.log'), 'utf8'), '[REDACTED]\n');
});

test('Profiler metadata redactions merge with removed env values in passing failing and error captures', async t => {
  for (const outcome of ['passing', 'failing', 'timeout']) await t.test(outcome, async t => {
    const f = await fixture(t);
    const redactions = { SHARED_TOKEN: 'alpha-overlap', SECOND_TOKEN: 'overlap-omega', PREFIX_TOKEN: 'prefix-value', LONG_TOKEN: 'prefix-value-extended' };
    const env = { ...process.env, SHARED_TOKEN: 'inferred-private-value' };
    const prefix = 'nonsecret-prefix-' + 'p'.repeat(6000);
    const text = prefix + 'alpha-overlap-omega / prefix-value-extended / inferred-private-value / alpha-overlap-omega' + 'z'.repeat(4090);
    const expected = prefix + '[REDACTED] / [REDACTED] / [REDACTED] / [REDACTED]' + 'z'.repeat(4090);
    const script = path.join(f.cwd, 'emit.cjs');
    await writeFile(script, `
      const assert = require('node:assert/strict');
      for (const name of ${JSON.stringify(Object.keys(redactions))}) assert.equal(process.env[name], undefined);
      assert.equal(process.env.redactions, undefined);
      assert.deepEqual(process.argv.slice(2), []);
      process.stdout.write(${JSON.stringify(text)});
      process.stderr.write(${JSON.stringify(text)});
      ${outcome === 'timeout' ? 'setInterval(() => {}, 500);' : `process.exitCode = ${outcome === 'passing' ? 0 : 8};`}
    `);
    const invocation = runProfiledCommand({ ...f, redactions, env, command: process.execPath, args: [script], timeoutMs: 2000 });
    const result = outcome === 'timeout'
      ? await invocation.then(() => assert.fail('Expected timeout'), error => error)
      : await invocation;
    if (outcome === 'timeout') assert.equal(result.code, 'timeout');
    else assert.equal(result.exitCode, outcome === 'passing' ? 0 : 8);
    assert.equal(result.stdout, expected); assert.equal(result.stderr, expected);
    const directory = path.dirname(result.profilePath);
    for (const stream of ['stdout', 'stderr']) assert.equal(await readFile(path.join(directory, `${stream}.log`), 'utf8'), expected);
    const files = await readdir(directory);
    assert.equal(files.includes('error.log'), outcome === 'timeout');
    for (const file of files) {
      const capture = await readFile(path.join(directory, file), 'utf8');
      for (const value of [...Object.values(redactions), env.SHARED_TOKEN, '-omega', '-extended', 'SHARED_TOKEN']) assert.ok(!capture.includes(value));
    }
    const report = JSON.parse(await readFile(result.profilePath, 'utf8'));
    assert.equal(report.buckets.command.failures, outcome === 'passing' ? 0 : 1);
    for (const name of ['redactions', 'env', 'args', 'secrets']) assert.equal(report[name], undefined);
  });
});

test('Profiler metadata redactions mask spawn error stacks without persisting the metadata', async t => {
  const f = await fixture(t), secret = 'private-spawn-value-9421';
  const failure = await runProfiledCommand({ ...f, command: path.join(f.cwd, secret), redactions: { CUSTOM_TOKEN: secret } })
    .then(() => assert.fail('Expected spawn failure'), error => error);
  assert.equal(failure.code, 'ENOENT');
  const directory = path.dirname(failure.profilePath);
  const stack = await readFile(path.join(directory, 'error.log'), 'utf8');
  assert.match(stack, /ENOENT/); assert.match(stack, /\[REDACTED\]/);
  for (const file of await readdir(directory)) {
    const capture = await readFile(path.join(directory, file), 'utf8');
    assert.ok(!capture.includes(secret)); assert.ok(!capture.includes('CUSTOM_TOKEN'));
  }
});

test('Profiler metadata redactions protect known values cut by the shared output limit', async t => {
  const f = await fixture(t), secret = 'boundary-private-value-8127';
  const marker = 'nonsecret-prefix-', padding = 20 * 1024 * 1024 - marker.length - 12;
  const prefix = marker + 'p'.repeat(padding);
  const script = path.join(f.cwd, 'limit.cjs');
  await writeFile(script, `process.stdout.write(${JSON.stringify(marker)} + 'p'.repeat(${padding}) + ${JSON.stringify(secret + 'tail')});`);
  const failure = await runProfiledCommand({ ...f, command: process.execPath, args: [script], redactions: { CUSTOM_TOKEN: secret } })
    .then(() => assert.fail('Expected output limit'), error => error);
  assert.equal(failure.code, 'invalid_output'); assert.equal(failure.outputTruncated, true);
  for (const capture of [failure.stdout, await readFile(path.join(path.dirname(failure.profilePath), 'stdout.log'), 'utf8')]) {
    assert.ok(capture.startsWith(prefix), 'complete nonsecret prefix is retained');
    assert.equal(capture.length, prefix.length + '[REDACTED]'.length);
    assert.equal(capture.slice(prefix.length), '[REDACTED]');
  }
  for (const file of await readdir(path.dirname(failure.profilePath))) {
    const capture = await readFile(path.join(path.dirname(failure.profilePath), file), 'utf8');
    assert.ok(!capture.includes(secret)); assert.ok(!capture.includes('boundary-pri'));
  }
});

test('Timeout cancel output-limit and spawn errors retain a non-passing profile and diagnostics', async t => {
  const f = await fixture(t);
  for (const kind of ['timeout', 'cancelled', 'invalid_output', 'ENOENT']) {
    const controller = new AbortController();
    const options = { ...f, command: process.execPath, args: ['-e', "console.log('started'); setInterval(() => {}, 500)"], timeoutMs: 1000 };
    if (kind === 'cancelled') { controller.abort(); options.signal = controller.signal; }
    if (kind === 'invalid_output') options.args = ['-e', "process.stdout.write('x'.repeat(21*1024*1024))"];
    if (kind === 'ENOENT') options.command = path.join(f.cwd, 'no-such-program');
    const failure = await runProfiledCommand(options).then(() => assert.fail('Expected command failure'), error => error);
    {
      const error = failure;
      assert.equal(error.code, kind); assert.ok(error.profilePath);
      const report = JSON.parse(await readFile(error.profilePath, 'utf8'));
      assert.equal(report.buckets.command.failures, 1);
      if (kind === 'timeout') assert.match(error.stdout, /started/);
      if (kind === 'invalid_output') assert.equal(error.outputTruncated, true);
    }
  }
});

test('Cancellation after child readiness stops the owned command and retains its receipt', async t => {
  const f = await fixture(t); const controller = new AbortController();
  const watcher = watch(f.cwd, (_, file) => { if (String(file) === 'ready') controller.abort(); });
  t.after(() => watcher.close());
  const timer = setTimeout(() => controller.abort(), 10000); t.after(() => clearTimeout(timer));
  const failure = await runProfiledCommand({ ...f, signal: controller.signal, timeoutMs: 20000, command: process.execPath,
    args: ['-e', "const fs = require('fs'); fs.writeFileSync('ready.tmp','ready'); fs.renameSync('ready.tmp','ready'); setInterval(() => {},500)"] }).then(() => assert.fail('Expected cancellation'), error => error);
  assert.equal(await readFile(path.join(f.cwd, 'ready'), 'utf8'), 'ready');
  assert.equal(failure.code, 'cancelled');
  assert.equal(JSON.parse(await readFile(failure.profilePath, 'utf8')).buckets.command.failures, 1);
});

test('Evidence inside project or any Git ancestor and linked directories is rejected', async t => {
  const f = await fixture(t);
  const options = { ...f, command: process.execPath, args: ['-e', 'process.exit(0)'] };
  await assert.rejects(runProfiledCommand({ ...options, evidenceDir: path.join(f.cwd, 'evidence') }), /outside|evidence/i);
  const nested = path.join(f.root, 'git-repo'); await mkdir(nested); await mkdir(path.join(nested, '.git'));
  await assert.rejects(runProfiledCommand({ ...options, evidenceDir: path.join(nested, 'evidence') }), /Git|evidence/i);
  const linked = path.join(f.root, 'linked'); await symlink(f.cwd, linked, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(runProfiledCommand({ ...options, evidenceDir: path.join(linked, 'evidence') }), /symlink|link|evidence/i);
});

test('Profiler CLI run and summary preserve command failure and reject invalid flags', async t => {
  const f = await fixture(t); const cli = path.join(repo, 'scripts/ci-profiler.mjs');
  const result = await execute(process.execPath, [cli, 'run', '--cwd', f.cwd, '--evidence-dir', f.evidenceDir, '--tier', 'L1', '--', process.execPath, '-e', 'process.exit(9)'], { cwd: repo, allowFailure: true });
  assert.equal(result.code, 9);
  const response = JSON.parse(result.stdout); assert.equal(response.exitCode, 9);
  const profile = await execute(process.execPath, [cli, 'summary', response.profilePath], { cwd: repo });
  assert.equal(JSON.parse(profile.stdout).buckets.command.failures, 1);
  const invalid = await execute(process.execPath, [cli, 'run', '--typo', 'x'], { cwd: repo, allowFailure: true });
  assert.notEqual(invalid.code, 0); assert.equal(JSON.parse(invalid.stderr).code, 'configuration');
  const tainted = path.join(f.root, 'tainted.json');
  await writeFile(tainted, JSON.stringify({ schemaVersion: 1, buckets: { command: { count: 1, secretKey: { leaked: 7 } }, secretBucket: { secret: 42 } }, details: [{ id: 'raw-secret', status: 'passed', env: { PRIVATE: 123 } }], wallMs: 4, env: { PRIVATE: 8 } }));
  const safe = await execute(process.execPath, [cli, 'summary', tainted], { cwd: repo });
  for (const forbidden of ['secret', 'PRIVATE', 'env', 'leaked']) assert.ok(!safe.stdout.includes(forbidden));
});
