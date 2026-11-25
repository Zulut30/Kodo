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

test('diagnostic-pack parses real Node 24 spec and TAP fixtures (✖ failing tests: and |- YAML block scalars)', async () => {
  const realSpec = await readFile(path.join(fixturesDir, 'node24-spec.txt'), 'utf8');
  const specPack = buildDiagnosticPack({ stdout: realSpec });
  assert.equal(specPack.items.length, 2, `expected 2 spec items, got ${JSON.stringify(specPack.items)}`);
  assert.deepEqual(specPack.failingTests, ['strict equality mismatch', 'explicit error message']);
  assert.equal(specPack.items[0].file, 'sample.test.mjs');
  assert.equal(specPack.items[0].line, 4);
  assert.equal(specPack.items[0].column, 1);
  assert.equal(specPack.items[0].code, 'ERR_ASSERTION');
  assert.match(specPack.items[0].message, /Expected values to be strictly equal/);
  assert.equal(specPack.items[1].file, 'sample.test.mjs');
  assert.equal(specPack.items[1].line, 5);
  assert.match(specPack.items[1].message, /boom failed/);

  const realTap = await readFile(path.join(fixturesDir, 'node24-tap.txt'), 'utf8');
  const tapPack = buildDiagnosticPack({ stdout: realTap });
  assert.equal(tapPack.items.length, 2);
  assert.deepEqual(tapPack.failingTests, ['strict equality mismatch', 'explicit error message']);
  assert.notEqual(tapPack.items[0].message, '|-');
  assert.match(tapPack.items[0].message, /Expected values to be strictly equal/);
  assert.match(tapPack.items[0].message, /1 !== 2/);
  assert.equal(tapPack.items[0].file, 'fixtures/sample.test.mjs');
  assert.equal(tapPack.items[0].line, 4);
  assert.match(tapPack.items[1].message, /boom failed/);
});

test('diagnostic-pack redacts secrets before 320-char truncation, reserves room for first item before test names, enforces maxBytes floor, and parses text rustc errors', () => {
  // 1. Secret straddling 320-char boundary must not leak its prefix!
  const secret = 'SUPER_SECRET_TOKEN_XYZ_9876543210';
  const paddedMsg = `${'a'.repeat(312)}${secret} trailing`;
  const redactedPack = buildDiagnosticPack({
    gates: [
      { status: 'failed', report: { findings: [{ ruleId: 'sec', file: 'src/a.mjs', line: 1, message: paddedMsg }] } },
    ],
    secrets: { token: secret },
  });
  assert.doesNotMatch(JSON.stringify(redactedPack), /SUPER_SECRET/);

  // 2. 50 failing tests under tight maxBytes: must keep at least 1 diagnostic item before failingTests list!
  const fiftyFailures = Array.from(
    { length: 50 },
    (_, i) =>
      `not ok ${i + 1} - very long failing test name number ${String(i).padStart(3, '0')}\n  ---\n  location: 'tests/t${i}.test.mjs:${i + 1}:1'\n  error: 'Failure ${i}'\n  code: 'ERR_ASSERTION'\n  ...\n`,
  ).join('');
  const tightPack = buildDiagnosticPack({ stdout: fiftyFailures, maxBytes: 900 });
  assert.ok(tightPack.bytes <= 900, `bytes ${tightPack.bytes} > 900`);
  assert.ok(tightPack.items.length >= 1, 'must reserve room for at least the first diagnostic item');

  // 3. Lower bound of maxBytes is enforced strictly.
  assert.throws(
    () => buildDiagnosticPack({ stdout: '', maxBytes: 128 }),
    error => error.code === 'diagnostic_invalid',
  );
  const floorPack = buildDiagnosticPack({ stdout: fiftyFailures, maxBytes: 256 });
  assert.ok(floorPack.bytes <= 256, `bytes ${floorPack.bytes} > 256`);

  // 4. Plain text rustc output from ordinary `cargo test`.
  const rustText = [
    '   Compiling core-lib v0.1.0 (/repo/crates/core)',
    'error[E0425]: cannot find value `missing_var` in this scope',
    ' --> src/lib.rs:3:5',
    '  |',
    '3 |     missing_var',
    '  |     ^^^^^^^^^^^ not found in this scope',
    '',
    'warning[unused_variables]: unused variable: `x`',
    ' --> src/lib.rs:10:9',
    '',
    'error: could not compile `core-lib` (lib test) due to 1 previous error; 1 warning emitted',
  ].join('\n');
  const rustPack = buildDiagnosticPack({ stderr: rustText });
  assert.equal(rustPack.items.length, 2);
  assert.deepEqual(rustPack.items[0], {
    file: 'src/lib.rs',
    line: 3,
    column: 5,
    code: 'E0425',
    level: 'error',
    message: 'cannot find value `missing_var` in this scope (not found in this scope)',
    failingTests: [],
  });
  assert.equal(rustPack.items[1].level, 'warning');
  assert.equal(rustPack.items[1].file, 'src/lib.rs');
  assert.equal(rustPack.items[1].line, 10);
});

test('G8: TAP # TODO and # SKIP directives are ignored before building items and failingTests (real Node 24 output)', async () => {
  const realTapTodoSkip = await readFile(path.join(fixturesDir, 'node24-tap-todo-skip.txt'), 'utf8');
  assert.match(realTapTodoSkip, /^# fail 1$/m);
  assert.match(realTapTodoSkip, /^# todo 50$/m);
  assert.match(realTapTodoSkip, /^# skipped 1$/m);

  const pack = buildDiagnosticPack({ stdout: realTapTodoSkip });
  assert.equal(pack.items.length, 1, `expected only the 1 real failure, got ${pack.items.length}`);
  assert.deepEqual(pack.failingTests, ['only real failure']);
  assert.match(pack.items[0].message, /real regression/);

  // Also verify not ok with # SKIP directive is excluded, while an escaped \# TODO in a real failure name is kept.
  const syntheticTap = [
    'TAP version 13',
    'not ok 1 - skipped check # SKIP not supported on this OS',
    '  ---',
    "  error: 'should be ignored'",
    '  ...',
    'not ok 2 - todo check # todo',
    'not ok 3 - real test with \\# TODO in name',
    '  ---',
    "  location: 'tests/real.test.mjs:12:1'",
    "  error: 'real failure'",
    '  ...',
  ].join('\n');
  const synthPack = buildDiagnosticPack({ stdout: syntheticTap });
  assert.equal(synthPack.items.length, 1);
  assert.deepEqual(synthPack.failingTests, ['real test with \\# TODO in name']);
  assert.match(synthPack.items[0].message, /real failure/);
});
