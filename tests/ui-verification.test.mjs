import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import { startProjectServer, uiEnvironment } from '../runtime/ui-browser.mjs';
import { smokeOptions } from '../scripts/ui-smoke.mjs';
import { observationFunction } from '../runtime/ui-schema.mjs';
import { runInNewContext } from 'node:vm';
import { normalizeUIConfig, runUIVerification, isCurrentUIReceipt } from '../runtime/ui-verification.mjs';

const headSha = 'a'.repeat(40);
const config = { enabled: true, autoInstall: false, cases: [{ id: 'save', tool: 'browser-harness', url: 'http://127.0.0.1:12345/', steps: [{ action: 'click', selector: '#save' }], assertions: [{ selector: '#result', text: 'Saved' }] }] };
async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'kodo-ui-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return { cwd: process.cwd(), artifacts: root, headSha, config };
}
test('UI disabled produces explicit null evidence without invoking tools', async () => {
  assert.deepEqual(normalizeUIConfig(), { enabled: false, cases: [], autoInstall: true, maxSteps: 12, timeoutMs: 180000 });
  const r = await runUIVerification({ headSha, caseRunner: () => { throw Error('must not execute'); } });
  assert.equal(r.status, 'disabled'); assert.equal(r.passed, null);
  assert.equal(isCurrentUIReceipt(r, { headSha }), true);
});
test('UI rejects unsafe or empty contracts before starting tools', () => {
  for (const change of [{ cases: [] }, { maxSteps: 0 }, { maxSteps: 31 }, { timeoutMs: 999 }, { timeoutMs: 600001 }, { enabled: 'yes' }, { record: true }]) assert.throws(() => normalizeUIConfig({ ...config, ...change }));
  for (const change of [{ tool: 'unknown' }, { url: 'file:///etc/passwd' }, { url: 'https://user:pass@example.test' }, { assertions: [] }, { assertions: [{ selector: '#x', exists: 'yes' }] }, { tool: 'browser-use' }, { id: '../x' }]) assert.throws(() => normalizeUIConfig({ ...config, cases: [{ ...config.cases[0], ...change }] }));
  assert.throws(() => normalizeUIConfig({ ...config, cases: [config.cases[0], config.cases[0]] }));
  assert.throws(() => normalizeUIConfig({ ...config, start: { command: 'cmd', args: ['/c', 'bad'] } }));
});
test('a model success or DONE with no independent observations cannot pass', async t => {
  const base = await fixture(t);
  for (const output of [{ status: 'passed', passed: true }, { schemaVersion: 1, status: 'completed', observations: [] }, { schemaVersion: 1, status: 'completed', observations: [{ exists: true, count: 1, text: 'Not saved', value: null }] }]) {
    const r = await runUIVerification({ ...base, caseRunner: async () => output });
    assert.equal(r.passed, false); assert.equal(r.status, 'failed');
  }
});
test('receipt binds independent readback, head, config, pins and private evidence bytes', async t => {
  const base = await fixture(t);
  const r = await runUIVerification({ ...base, caseRunner: async () => ({ schemaVersion: 1, status: 'completed', observations: [{ exists: true, count: 1, text: 'Saved', value: null }], steps: 1 }) });
  assert.equal(r.status, 'passed'); assert.equal(r.cases[0].assertions[0].passed, true);
  assert.equal(isCurrentUIReceipt(r, { headSha, config }), true);
  assert.equal(isCurrentUIReceipt(r, { headSha: 'b'.repeat(40), config }), false);
  assert.equal(isCurrentUIReceipt(r, { headSha, config: { ...config, maxSteps: 13 } }), false);
  assert.equal(isCurrentUIReceipt({ ...r, pinsHash: '0'.repeat(64) }, { headSha, config }), false);
  assert.equal(isCurrentUIReceipt({ ...r, cases: [] }, { headSha, config }), false);
  const evidence = r.cases[0].evidence[0];
  assert.ok(path.isAbsolute(evidence.path));
  const content = await readFile(evidence.path, 'utf8');
  await writeFile(evidence.path, content + ' ');
  assert.equal(isCurrentUIReceipt(r, { headSha, config }), false);
});
test('missing dependencies and exceptions are explicit and do not expose provider output', async t => {
  const base = await fixture(t);
  const secret = 'private-test-secret-never-persist';
  const r = await runUIVerification({ ...base, secrets: { GEMINI_API_KEY: secret }, caseRunner: async () => { throw Error(secret); } });
  assert.equal(r.passed, false); assert.ok(!JSON.stringify(r).includes(secret));
  const b = await runUIVerification({ ...base, caseRunner: async () => ({ schemaVersion: 1, status: 'blocked', reason: 'tool_missing' }) });
  assert.equal(b.status, 'blocked'); assert.equal(b.passed, false);
});
test('case timeout and cancellation fail closed even when the injected port never returns', async t => {
  const base = await fixture(t);
  const r = await runUIVerification({ ...base, config: { ...config, timeoutMs: 1000 }, caseRunner: () => new Promise(() => {}) });
  assert.equal(r.passed, false); assert.equal(r.cases[0].reason, 'timeout');
  const controller = new AbortController(); controller.abort();
  const b = await runUIVerification({ ...base, signal: controller.signal, caseRunner: () => { throw Error('called'); } });
  assert.equal(b.passed, false);
});
test('previous success is not reused and malformed/ambiguous observations fail', async t => {
  const base = await fixture(t); let calls = 0;
  const port = async () => { calls++; return { schemaVersion: 1, status: 'completed', observations: [{ exists: true, count: 2, text: 'Saved', value: null }] }; };
  const r = await runUIVerification({ ...base, previous: { status: 'passed' }, caseRunner: port });
  assert.equal(calls, 1); assert.equal(r.passed, false);
});
test('Vibetest requires both independently observed QA states and preserves exploratory evidence privately', async t => {
  const base = await fixture(t);
  const vconfig = { ...config, cases: [{ ...config.cases[0], tool: 'vibetest', goal: 'Save' }] };
  const observed = [{ exists: true, count: 1, text: 'Saved', value: null }];
  const baseOutput = { schemaVersion: 1, status: 'completed', observations: observed };
  const missing = await runUIVerification({ ...base, config: vconfig, caseRunner: async () => baseOutput });
  assert.equal(missing.passed, false);
  const output = { ...baseOutput, qa: { agents: 2, observations: [observed, observed], severity: { high_severity: [], medium_severity: [], low_severity: [] }, reports: ['Explored first form', 'Explored navigation'] } };
  const good = await runUIVerification({ ...base, config: vconfig, caseRunner: async () => output });
  assert.equal(good.passed, true);
  const saved = JSON.parse(await readFile(good.cases[0].evidence[0].path, 'utf8'));
  assert.deepEqual(saved.qa.reports, ['Explored first form', 'Explored navigation']);
  const bad = await runUIVerification({ ...base, config: vconfig, caseRunner: async () => ({ ...output, qa: { ...output.qa, observations: [observed, [{ exists: true, count: 1, text: 'Error', value: null }]] } }) });
  assert.equal(bad.passed, false);
});
test('credentials are checked before managed installation and artifacts inside Git are rejected', async t => {
  const base = await fixture(t);
  const r = await runUIVerification({ ...base, config: { ...config, autoInstall: true, cases: [{ ...config.cases[0], tool: 'jev-ultrafast', goal: 'Save' }] }, runner: async () => { throw Error('must not install'); } });
  assert.equal(r.status, 'blocked'); assert.equal(r.cases[0].reason, 'credentials_missing');
  let calls = 0;
  const bad = await runUIVerification({ ...base, artifacts: process.cwd(), caseRunner: () => { calls++; } });
  assert.equal(bad.passed, false); assert.equal(calls, 0);
});
test('owned project server starts with scrubbed environment and is stopped after failing UI verification', async t => {
  const base = await fixture(t);
  const probe = createServer();
  await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
  const port = probe.address().port; await new Promise(resolve => probe.close(resolve));
  const url = `http://127.0.0.1:${port}/`;
  const start = { command: process.execPath, args: [fileURLToPath(new URL('../scripts/fixtures/kodo-ui-server.mjs', import.meta.url)), String(port)] };
  let pid;
  const r = await runUIVerification({ ...base, config: { ...config, start, cases: [{ ...config.cases[0], url }] }, caseRunner: async () => {
    const health = await (await fetch(url + 'health')).json(); pid = health.pid;
    return { schemaVersion: 1, status: 'failed', reason: 'assertion_failed' };
  } });
  assert.equal(r.passed, false); assert.ok(Number.isInteger(pid));
  await assert.rejects(fetch(url, { signal: AbortSignal.timeout(1000) }));
});
test('owned server refuses an already listening project endpoint even if it returns an HTTP error', async t => {
  const { createServer: httpServer } = await import('node:http');
  const server = httpServer((req, res) => { res.writeHead(404); res.end(); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = await fixture(t);
  await assert.rejects(startProjectServer({ command: process.execPath, args: ['-e', 'process.exit(0)'] }, { cwd: base.cwd, env: uiEnvironment(base.artifacts), url: `http://127.0.0.1:${server.address().port}/`, timeoutMs: 1000 }), /server_already_running/);
});
test('smoke defaults avoid model calls and rejects ambiguous CLI arguments', () => {
  assert.deepEqual(smokeOptions([]).tools, ['browser-harness', 'chrome-devtools-mcp', 'agent-desktop']);
  assert.equal(smokeOptions(['--help']).help, true);
  for (const args of [['--tools'], ['--tools', 'bad'], ['--tools', 'browser-use,browser-use'], ['--unknown']]) assert.throws(() => smokeOptions(args));
});
test('absence assertions cannot pass on a failed navigation or unrelated document', () => {
  const fn = observationFunction([{ selector: '#missing' }], 'http://127.0.0.1:1234/');
  const context = { document: { querySelectorAll: () => [], readyState: 'complete' }, location: { origin: 'null' } };
  assert.throws(() => runInNewContext(`(${fn})()`, context));
  context.location.origin = 'http://127.0.0.1:1234';
  assert.equal(runInNewContext(`(${fn})()`, context)[0].count, 0);
});
