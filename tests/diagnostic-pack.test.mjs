import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildDiagnosticPack, formatDiagnosticPack, hasStructuredDiagnostics } from '../runtime/diagnostic-pack.mjs';

const fixturesDir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'diagnostics');

test('diagnostic-pack parses real rustc --message-format=json messages, deduplicates and filters summary noise', async () => {
  const ndjson = await readFile(path.join(fixturesDir, 'rustc-messages.ndjson'), 'utf8');
  const cargoTestOut = [
    ndjson,
    'running 2 tests',
    'test chunk::tests::loads_block ... FAILED',
    'test chunk::tests::empty_chunk ... ok',
    'failures:',
    '    chunk::tests::loads_block',
  ].join('\n');

  const pack = buildDiagnosticPack({ stdout: cargoTestOut, stderr: '' });
  assert.equal(pack.kind, 'diagnostic-pack');
  assert.equal(pack.truncated, false);
  // Duplicate E0308 collapsed into one; aborting summary excluded because real errors exist.
  assert.equal(pack.items.length, 3);
  assert.deepEqual(pack.items[0], {
    file: 'crates/world/src/chunk.rs',
    line: 42,
    column: 17,
    code: 'E0308',
    level: 'error',
    message: 'mismatched types (expected `u16`, found `&str`)',
    failingTests: [],
  });
  assert.deepEqual(pack.items[1], {
    file: 'crates/world/src/lib.rs',
    line: 18,
    column: 9,
    code: 'E0425',
    level: 'error',
    message: 'cannot find value `chunk_map` in this scope (not found in this scope)',
    failingTests: [],
  });
  assert.equal(pack.items[2].level, 'warning');
  assert.equal(pack.items[2].code, 'unused_variables');
  assert.deepEqual(pack.failingTests, ['chunk::tests::loads_block']);
});

test('diagnostic-pack parses node:test spec and TAP outputs and deduplicates failing tests', () => {
  const specOut = `
✔ adds positive numbers (0.8ms)
✖ handles overflow (2.1ms)

failing tests:

test at tests/math.test.mjs:19:1
✖ handles overflow (2.1ms)
  AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:
  + actual - expected
  + 0
  - 42
`;
  const specPack = buildDiagnosticPack({ stdout: specOut });
  assert.deepEqual(specPack.failingTests, ['handles overflow']);
  assert.equal(specPack.items.length, 1);
  assert.equal(specPack.items[0].file, 'tests/math.test.mjs');
  assert.equal(specPack.items[0].line, 19);
  assert.equal(specPack.items[0].column, 1);
  assert.equal(specPack.items[0].code, 'ERR_ASSERTION');
  assert.equal(specPack.items[0].level, 'error');
  assert.deepEqual(specPack.items[0].failingTests, ['handles overflow']);

  const tapOut = `
TAP version 13
ok 1 - passes cleanly
not ok 2 - rejects invalid token
  ---
  duration_ms: 1.4
  location: 'tests/auth.test.mjs:33:5'
  failureType: 'testCodeFailure'
  error: 'Expected 401 status'
  code: 'ERR_ASSERTION'
  ...
not ok 3 - rejects invalid token
  ---
  duration_ms: 1.1
  location: 'tests/auth.test.mjs:33:5'
  failureType: 'testCodeFailure'
  error: 'Expected 401 status'
  code: 'ERR_ASSERTION'
  ...
`;
  const tapPack = buildDiagnosticPack({ stdout: tapOut });
  assert.deepEqual(tapPack.failingTests, ['rejects invalid token']);
  assert.equal(tapPack.items.length, 1, 'duplicate TAP failure deduplicated');
  assert.equal(tapPack.items[0].file, 'tests/auth.test.mjs');
  assert.equal(tapPack.items[0].line, 33);
  assert.equal(tapPack.items[0].column, 5);
  assert.equal(tapPack.items[0].code, 'ERR_ASSERTION');
  assert.match(tapPack.items[0].message, /Expected 401 status/);
});

test('diagnostic-pack parses Kodo gate failures, redacts secrets, and enforces maxItems and maxBytes', () => {
  const secret = 'sk-super-secret-value-987654321';
  const findings = Array.from({ length: 12 }, (_, i) => ({
    ruleId: `arch/no-cycle-${i}`,
    file: `src/mod${i}/index.mjs`,
    line: i + 1,
    severity: 'error',
    message: `Cycle detected with secret ${secret} in module ${i}`,
  }));
  const pack = buildDiagnosticPack({
    gates: [{ status: 'failed', report: { findings } }],
    behavior: {
      passed: false,
      code: 'behavior_weak_test',
      findings: [{ code: 'weak_or_empty_test', file: 'tests/a.test.mjs', line: 7, message: 'Empty test body' }],
    },
    secrets: { apiKey: secret },
    maxItems: 5,
    maxBytes: 900,
  });

  assert.equal(pack.truncated, true);
  assert.ok(pack.items.length <= 5);
  assert.ok(pack.omitted > 0);
  assert.ok(pack.bytes <= 900);
  assert.doesNotMatch(JSON.stringify(pack), /sk-super-secret-value-987654321/);
  const rendered = formatDiagnosticPack(pack);
  assert.doesNotMatch(rendered, /sk-super-secret-value-987654321/);
  assert.match(rendered, /truncated|omitted/i);
});

test('diagnostic-pack preserves review fix and does not treat a single generic check_failed as structured diagnostics', () => {
  const reviewPack = buildDiagnosticPack({
    review: {
      passed: false,
      findings: [
        {
          file: 'src/api.mjs',
          severity: 'major',
          problem: 'Missing null guard on payload',
          fix: 'Return 400 when payload is null',
        },
      ],
    },
  });
  assert.equal(hasStructuredDiagnostics(reviewPack), true);
  assert.equal(reviewPack.items[0].fix, 'Return 400 when payload is null');
  assert.match(formatDiagnosticPack(reviewPack), /Return 400 when payload is null/);

  const pytestLog = `${'collected item ...\n'.repeat(200)}FAILED tests/test_math.py::test_sum\nE       assert 2 == 1\n`;
  const genericPack = buildDiagnosticPack({
    stdout: pytestLog,
    error: Object.assign(new Error(`Проверка test не пройдена (exit 1): ${pytestLog.slice(-6000)}`), {
      code: 'check_failed',
    }),
  });
  assert.equal(hasStructuredDiagnostics(genericPack), false);
});
