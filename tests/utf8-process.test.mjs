import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execute as runCommand } from '../runtime/command.mjs';
import { execute as runDelivery } from '../runtime/delivery.mjs';

const stdout = '🌍 Привет, Kodo';
const stderr = 'Ошибка: русский текст';
const script = `const out=Buffer.from(${JSON.stringify(stdout)}),err=Buffer.from(${JSON.stringify(stderr)});process.stdout.write(out.subarray(0,1));process.stderr.write(err.subarray(0,1));setTimeout(()=>{process.stdout.write(out.subarray(1));process.stderr.write(err.subarray(1));},80);`;

for (const [name, execute] of [['worker/coordinator', runCommand], ['delivery', runDelivery]]) {
  test(`${name} command capture preserves UTF-8 characters split across pipe chunks`, async () => {
    const result = await execute(process.execPath, ['-e', script]);
    assert.equal(result.code, 0); assert.equal(result.stdout, stdout); assert.equal(result.stderr, stderr);
    assert.equal(result.stdout.includes('\uFFFD'), false);
  });
}

const secrets = { first: 'fixture-abcdefghi', overlap: 'abcdefghijklm', boundary: 'fixture-boundary-sensitive-value' };
const diagnostic = 'FIRST_CAUSE ' + 'fixture-abcdefghijklm' + '\n' + 'x'.repeat(30000) + '\nTAIL_CAUSE ' + secrets.boundary;
function assertStopped(error, code, reason = code) {
  assert.equal(error.code, code);
  assert.equal(error.result.reason, reason);
  assert.equal(error.result.code === null || Number.isInteger(error.result.code), true);
  assert.ok(Number.isFinite(error.result.durationMs) && error.result.durationMs >= 0);
  assert.equal(typeof error.result.outputTruncated, 'boolean');
  for (const stream of ['stdout', 'stderr']) {
    assert.ok(error.result[stream].length <= 24000);
    assert.doesNotMatch(error.result[stream], /fixture-abc|jklm|fixture-boundary|sensitive-value/);
  }
  assert.doesNotMatch(JSON.stringify(error), /fixture-abc|jklm|fixture-boundary|sensitive-value/);
  assert.equal(Object.hasOwn(error, 'rawOutput'), false);
  return true;
}

test('worker command timeout retains bounded sanitized diagnostics and the first cause after a later abort', async t => {
  const controller = new AbortController(), schedule = globalThis.setTimeout;
  t.mock.method(globalThis, 'setTimeout', (callback, ms, ...args) => schedule(() => {
    callback(...args);
    if (ms === 1500) controller.abort();
  }, ms));
  await assert.rejects(runCommand(process.execPath, ['-e', `process.stdout.write(${JSON.stringify(diagnostic)});process.stderr.write('TIMEOUT_CAUSE');setInterval(()=>{},1000)`], {
    timeoutMs: 1500, signal: controller.signal, rawOutput: true, secrets
  }), error => {
    assertStopped(error, 'timeout');
    assert.match(error.result.stdout, /TAIL_CAUSE \[REDACTED\]/);
    assert.equal(error.result.stderr, 'TIMEOUT_CAUSE');
    assert.equal(error.result.outputTruncated, true);
    return true;
  });
});

test('worker command cancellation drains ready child diagnostics and redacts an incomplete secret boundary', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'kodo-stop-command-')), ready = path.join(root, 'ready');
  t.after(() => rm(root, { recursive: true, force: true }));
  const controller = new AbortController();
  const output = 'OVERLAP fixture-abcdefghijklm\nCANCEL_CAUSE ' + secrets.boundary.slice(0, -4);
  const running = runCommand(process.execPath, ['-e', `const fs=require('node:fs');process.stdout.write(${JSON.stringify(output)},()=>fs.writeFileSync(${JSON.stringify(ready)},'ready'));setInterval(()=>{},1000)`], {
    timeoutMs: 10000, signal: controller.signal, rawOutput: true, secrets
  });
  const rejected = assert.rejects(running, error => {
    assertStopped(error, 'cancelled');
    assert.equal(error.result.stdout, 'OVERLAP [REDACTED]\nCANCEL_CAUSE [REDACTED]');
    return true;
  });
  try {
    const deadline = Date.now() + 8000;
    while (await readFile(ready, 'utf8').catch(() => '') !== 'ready') {
      assert.ok(Date.now() < deadline, 'controlled child must become ready');
      await new Promise(resolve => setTimeout(resolve, 20));
    }
  } finally { controller.abort(); }
  await rejected;
});

for (const stream of ['stdout', 'stderr']) test(`worker command ${stream} overflow is invalid output with sanitized bounded partial diagnostics`, async () => {
  const limit = (stream === 'stdout' ? 16 : 4) * 1024 * 1024;
  const prefix = 'OUTPUT_LIMIT_CAUSE ', fragment = secrets.boundary.slice(0, -4);
  const source = `process.${stream}.write(${JSON.stringify(prefix)}+'x'.repeat(${limit - prefix.length - fragment.length})+${JSON.stringify(fragment)}+'overflow');setInterval(()=>{},1000)`;
  await assert.rejects(runCommand(process.execPath, ['-e', source], { secrets, rawOutput: true, timeoutMs: 10000 }), error => {
    assertStopped(error, 'invalid_output', 'output_limit');
    assert.equal(error.result.outputTruncated, true);
    assert.ok(error.result[stream].length > 0);
    return true;
  });
});

test('worker command successful raw output and stdin retain the original contract', async () => {
  const source = "process.stdin.pipe(process.stdout);process.stderr.write('stderr preserved')";
  const result = await runCommand(process.execPath, ['-e', source], { input: secrets.boundary, rawOutput: true, secrets });
  assert.deepEqual(result, { stdout: secrets.boundary, stderr: 'stderr preserved', code: 0 });
});
