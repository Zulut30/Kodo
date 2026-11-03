import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildProgress, writeProgress } from '../runtime/progress.mjs';

test('Progress is bounded allowlisted recovery evidence and atomically replaced from authoritative state', t => {
  const home = mkdtempSync(path.join(os.tmpdir(), 'kodo-progress-'));
  t.after(() => { assert.equal(path.dirname(home), path.resolve(os.tmpdir())); rmSync(home, { recursive: true, force: true }); });
  const run = { id: 'fixture', artifacts: path.join(home, 'runs/fixture'), state: 'testing', headSha: 'abc123', nodes: { work: { status: 'integrated', headSha: 'def456', result: { summary: 'Do not include fake-secret-value', prompt: 'RAW_PROMPT' } } }, checks: { headSha: 'abc123', results: [{ kind: 'test', exitCode: 0, output: 'RAW_OUTPUT' }] }, analysis: { standards: 'NESTED_STANDARDS' }, error: { code: 'blocked', message: 'fake-secret-value' } };
  const filename = writeProgress(run, { home, secrets: { KEY: 'fake-secret-value' } });
  let text = readFileSync(filename, 'utf8');
  for (const value of ['testing', 'integrated', 'abc123', 'def456', '[REDACTED]', 'SQLite']) assert.ok(text.includes(value), value);
  for (const value of ['RAW_PROMPT', 'RAW_OUTPUT', 'NESTED_STANDARDS', 'fake-secret-value']) assert.ok(!text.includes(value), value);
  assert.ok(Buffer.byteLength(buildProgress({ ...run, nodes: Object.fromEntries(Array.from({ length: 2000 }, (_, i) => [i, { status: 'pending', error: 'я'.repeat(10000) }])) })) <= 65536);
  writeFileSync(filename, 'stale file'); run.state = 'succeeded'; writeProgress(run, { home });
  text = readFileSync(filename, 'utf8'); assert.match(text, /succeeded/); assert.doesNotMatch(text, /stale file/);
  assert.deepEqual(readdirSync(path.dirname(filename)), ['progress.md']);
});

test('Progress refuses repository destinations and unsafe run identifiers', t => {
  const home = mkdtempSync(path.join(os.tmpdir(), 'kodo-progress-'));
  t.after(() => { assert.equal(path.dirname(home), path.resolve(os.tmpdir())); rmSync(home, { recursive: true, force: true }); });
  assert.throws(() => writeProgress({ id: '../escape' }, { home }));
  mkdirSync(path.join(home, '.git'));
  assert.throws(() => writeProgress({ id: 'safe' }, { home }), /Git|repository/);
});
