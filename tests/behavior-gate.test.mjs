import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  classifyChange,
  compareWithBaseline,
  isCurrentBehaviorReceipt,
  normalizeVerificationConfig,
  qualityPolicy,
  runBehaviorGate,
  testWeakening,
} from '../runtime/behavior-gate.mjs';

const twoTests =
  "import test from 'node:test';\nimport assert from 'node:assert/strict';\n" +
  "test('adds', () => {\n  assert.equal(1 + 1, 2);\n  assert.equal(2 + 2, 4);\n});\n" +
  "test('subtracts', () => {\n  assert.equal(2 - 1, 1);\n});\n";

/** A Git repository with one commit; `change` edits the tree and commits the head. */
function repository(t, files = {}) {
  const cwd = mkdtempSync(path.join(os.tmpdir(), 'kodo-behavior-'));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const git = (...args) => {
    const result = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  const write = entries => {
    for (const [name, text] of Object.entries(entries)) {
      mkdirSync(path.dirname(path.join(cwd, name)), { recursive: true });
      writeFileSync(path.join(cwd, name), text);
    }
  };
  write({
    'src/math.mjs': 'export const add = (a, b) => a + b;\n',
    'tests/math.test.mjs': twoTests,
    'tests/helpers/data.mjs': 'export const data = [1, 2];\n',
    'oracle/contract.mjs': 'process.exit(0);\n',
    ...files,
  });
  git('init', '-b', 'main');
  git('config', 'user.name', 'Behaviour Test');
  git('config', 'user.email', 'behaviour@example.invalid');
  git('config', 'core.autocrlf', 'false');
  git('add', '.');
  git('commit', '-m', 'Base');
  const baseSha = git('rev-parse', 'HEAD');
  const change = (entries, remove = []) => {
    write(entries);
    for (const name of remove) git('rm', '-q', name);
    git('add', '-A');
    git('commit', '-m', 'Change');
    return { cwd, baseSha, headSha: git('rev-parse', 'HEAD') };
  };
  return { cwd, baseSha, git, change };
}
const rules = findings => findings.map(finding => `${finding.rule}:${finding.file}`);

test('A change is classified by its paths and each type names the gates it needs', () => {
  assert.deepEqual(classifyChange(['styles/app.css']), ['style']);
  assert.deepEqual(classifyChange(['README.md', 'docs/guide.txt']), ['content']);
  assert.deepEqual(classifyChange(['src/feature.mjs']), ['code']);
  assert.deepEqual(classifyChange(['src/auth/login.mjs', 'db/migrations/001.sql', '.github/workflows/ci.yml']), [
    'ci',
    'schema',
    'security',
  ]);
  assert.deepEqual(classifyChange(['api/users.mjs', 'tests/users.test.mjs', 'package.json']), [
    'api',
    'config',
    'tests',
  ]);
  const verification = normalizeVerificationConfig();
  const policy = (paths, config = {}) => qualityPolicy({ types: classifyChange(paths), config, verification });
  assert.deepEqual(policy(['styles/app.css']), {
    risk: 'low',
    types: ['style'],
    required: ['checks', 'review', 'ui'],
    gaps: [{ gate: 'ui', reason: 'disabled' }],
  });
  assert.deepEqual(policy(['styles/app.css'], { uiVerification: { enabled: true } }).gaps, []);
  const risky = policy(['src/auth/login.mjs', 'db/schema.sql'], { security: { enabled: true } });
  assert.equal(risky.risk, 'high');
  assert.deepEqual(risky.required, ['checks', 'review', 'oracle', 'security']);
  assert.deepEqual(risky.gaps, [{ gate: 'oracle', reason: 'disabled' }], 'a disabled gate is a gap, never a PASS');
  assert.equal(policy(['src/feature.mjs']).risk, 'medium');
  assert.equal(policy([]).risk, 'medium', 'no evidence of a low-risk change');
});

test('Deleted, removed, skipped, focused and stripped tests are found; honest test work is not', async t => {
  await t.test('deleted test file', async s => {
    const repo = repository(s);
    assert.deepEqual(rules(await testWeakening(repo.change({}, ['tests/math.test.mjs']))), [
      'test_deleted:tests/math.test.mjs',
    ]);
  });
  await t.test('removed test case', async s => {
    const repo = repository(s);
    const head = repo.change({ 'tests/math.test.mjs': twoTests.replace(/test\('subtracts'[\s\S]*$/, '') });
    assert.deepEqual(rules(await testWeakening(head)), ['tests_removed:tests/math.test.mjs']);
  });
  await t.test('skipped and focused tests', async s => {
    const repo = repository(s);
    const head = repo.change({
      'tests/math.test.mjs': twoTests.replace("test('adds'", "test.skip('adds'").replace("test('sub", "test.only('sub"),
    });
    const findings = await testWeakening(head);
    assert.deepEqual(rules(findings), ['test_skipped:tests/math.test.mjs']);
    assert.match(findings[0].detail, /0 -> 2/);
  });
  await t.test('assertions stripped while the test count stays', async s => {
    const repo = repository(s);
    const head = repo.change({ 'tests/math.test.mjs': twoTests.replace('  assert.equal(2 + 2, 4);\n', '') });
    assert.deepEqual(rules(await testWeakening(head)), ['assertions_removed:tests/math.test.mjs']);
  });
  await t.test('a renamed test file is still compared', async s => {
    const repo = repository(s);
    repo.git('mv', 'tests/math.test.mjs', 'tests/arithmetic.test.mjs');
    const head = repo.change({
      'tests/arithmetic.test.mjs': twoTests.replace("test('adds'", "test.skip('adds'"),
    });
    assert.deepEqual(rules(await testWeakening(head)), ['test_skipped:tests/arithmetic.test.mjs']);
  });
  await t.test('honest work passes', async s => {
    const repo = repository(s);
    const head = repo.change(
      {
        // More cases with fewer assertions each is a refactor, not weakening.
        'tests/math.test.mjs':
          "import test from 'node:test';\nimport assert from 'node:assert/strict';\n" +
          "test('adds one', () => assert.equal(1 + 1, 2));\ntest('adds two', () => assert.equal(2 + 2, 4));\n" +
          "test('subtracts', () => assert.equal(2 - 1, 1));\n",
        'tests/new.test.mjs': "import test from 'node:test';\ntest.skip('later', () => {});\n",
        'src/math.mjs': 'export const add = (a, b) => b + a;\n',
      },
      ['tests/helpers/data.mjs'],
    );
    assert.deepEqual(await testWeakening(head), [], 'a new skipped test and a removed helper are not weakening');
  });
});

test('An oracle runs on the final head, protects its own files and never passes by crashing', async t => {
  const oracle = (extra = {}) => ({
    verification: {
      oracles: [
        { id: 'contract', command: process.execPath, args: ['oracle/contract.mjs'], protect: ['oracle/**'], ...extra },
      ],
    },
  });
  const repo = repository(t);
  const head = repo.change({ 'src/math.mjs': 'export const add = (a, b) => a - b;\n' });
  const passed = await runBehaviorGate({ ...head, config: oracle() });
  assert.deepEqual([passed.status, passed.passed, passed.findings], ['passed', true, []]);
  assert.deepEqual(passed.oracles, [{ id: 'contract', status: 'passed', exitCode: 0 }]);
  assert.equal(isCurrentBehaviorReceipt(passed, { ...head, config: oracle() }), true);

  const failing = await runBehaviorGate({
    ...head,
    config: oracle({ args: ['-e', "console.error('add(2, 1) returned 1, expected 3'); process.exit(3)"] }),
  });
  assert.equal(failing.passed, false);
  assert.deepEqual([failing.oracles[0].status, failing.oracles[0].exitCode], ['failed', 3]);
  assert.match(failing.findings[0].detail, /contract exit 3: add\(2, 1\) returned 1, expected 3/);

  const crashed = await runBehaviorGate({
    ...head,
    config: oracle(),
    runner: async () => {
      throw Object.assign(new Error('timed out'), { code: 'timeout' });
    },
  });
  assert.deepEqual(crashed.oracles, [{ id: 'contract', status: 'failed', reason: 'timeout', exitCode: null }]);
  assert.equal(crashed.passed, false, 'an oracle that did not finish proves nothing');

  const edited = repo.change({ 'oracle/contract.mjs': 'process.exit(0); // always green\n' });
  let ran = false;
  const tampered = await runBehaviorGate({
    ...edited,
    config: oracle(),
    runner: async () => {
      ran = true;
      return { code: 0, stdout: '', stderr: '' };
    },
  });
  assert.equal(ran, false, 'a modified oracle is not trusted to judge');
  assert.deepEqual(rules(tampered.findings), ['oracle_modified:oracle/contract.mjs']);
  assert.deepEqual(tampered.oracles, [
    { id: 'contract', status: 'not_run', reason: 'oracle_modified', exitCode: null },
  ]);
});

test('A receipt counts only for its exact head, base and verification configuration', async t => {
  const repo = repository(t);
  const head = repo.change({ 'styles/app.css': 'a { color: blue; }\n' });
  const config = { verification: { testProtection: true } };
  const receipt = await runBehaviorGate({ ...head, config });
  assert.deepEqual(receipt.policy.types, ['style']);
  assert.deepEqual(receipt.policy.gaps, [{ gate: 'ui', reason: 'disabled' }]);
  assert.equal(receipt.passed, true, 'a gap is reported, and blocks only with strictGates');
  assert.equal(isCurrentBehaviorReceipt(receipt, { ...head, config }), true);
  assert.equal(isCurrentBehaviorReceipt(receipt, { ...head, headSha: head.baseSha, config }), false, 'stale head');
  assert.equal(isCurrentBehaviorReceipt(receipt, { ...head, baseSha: head.headSha, config }), false, 'other base');
  assert.equal(
    isCurrentBehaviorReceipt(receipt, { ...head, config: { verification: { strictGates: true } } }),
    false,
    'changed configuration',
  );
  assert.equal(isCurrentBehaviorReceipt({ ...receipt, findings: [{}] }, { ...head, config }), false);
  assert.equal(isCurrentBehaviorReceipt(null, { ...head, config }), false);
  assert.equal(isCurrentBehaviorReceipt(receipt, {}), false);

  const strict = await runBehaviorGate({ ...head, config: { verification: { strictGates: true } } });
  assert.deepEqual(rules(strict.findings), ['required_gate_disabled:null']);
  const off = await runBehaviorGate({
    ...repo.change({}, ['tests/math.test.mjs']),
    config: { verification: { testProtection: false } },
  });
  assert.equal(off.passed, true, 'test protection can be switched off explicitly');
});

test('Baseline comparison labels a failure as pre-existing or introduced and never hides it', () => {
  const command = { command: 'node', args: ['verify.mjs'] };
  const row = (kind, exitCode) => ({ kind, command, exitCode });
  assert.equal(compareWithBaseline(null, [row('test', 1)]), null);
  const baseline = { results: [row('test', 0), row('build', 2)] };
  assert.deepEqual(
    compareWithBaseline(baseline, [row('test', 1), row('build', 2)]).map(item => item.classification),
    ['regression', 'pre_existing'],
  );
  assert.deepEqual(
    compareWithBaseline(baseline, [row('test', 0), row('build', 0)]).map(item => item.classification),
    ['unchanged', 'fixed'],
  );
  assert.deepEqual(
    compareWithBaseline({ results: [{ kind: 'test', command, exitCode: null }] }, [row('test', 1)])[0],
    { kind: 'test', command, baseline: null, final: 1, classification: 'pre_existing' },
    'a baseline command that did not finish is not a pass',
  );
  assert.equal(
    compareWithBaseline(baseline, [{ kind: 'test', command: { command: 'npm', args: ['test'] }, exitCode: 1 }])[0]
      .classification,
    'no_baseline',
  );
});

test('The verification block is optional, strict about keys and safe about oracle paths', () => {
  assert.deepEqual(normalizeVerificationConfig(), {
    baseline: false,
    testProtection: true,
    strictGates: false,
    oracles: [],
  });
  const oracle = { id: 'git', command: 'node', protect: ['oracle/git.mjs'] };
  assert.deepEqual(normalizeVerificationConfig({ baseline: true, oracles: [oracle] }).oracles, [
    { id: 'git', command: 'node', args: [], protect: ['oracle/git.mjs'] },
  ]);
  for (const bad of [
    [],
    { unknown: true },
    { baseline: 'yes' },
    { oracles: {} },
    { oracles: [{ ...oracle, id: 'Bad Id' }] },
    { oracles: [oracle, oracle] },
    { oracles: [{ ...oracle, command: '' }] },
    { oracles: [{ ...oracle, protect: [] }] },
    { oracles: [{ ...oracle, protect: ['../outside'] }] },
    { oracles: [{ ...oracle, protect: ['C:/abs'] }] },
    { oracles: [{ ...oracle, args: [1] }] },
    { oracles: [{ ...oracle, timeoutMs: -1 }] },
    { oracles: [{ ...oracle, extra: 1 }] },
  ])
    assert.throws(
      () => normalizeVerificationConfig(bad),
      error => error.code === 'configuration',
      JSON.stringify(bad),
    );
});
