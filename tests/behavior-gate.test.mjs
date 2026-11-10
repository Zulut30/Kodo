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
const weakened = async head => rules((await testWeakening(head)).findings);

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
    assert.deepEqual(await weakened(repo.change({}, ['tests/math.test.mjs'])), ['test_deleted:tests/math.test.mjs']);
  });
  await t.test('removed test case', async s => {
    const repo = repository(s);
    const head = repo.change({ 'tests/math.test.mjs': twoTests.replace(/test\('subtracts'[\s\S]*$/, '') });
    assert.deepEqual(await weakened(head), ['tests_removed:tests/math.test.mjs']);
  });
  await t.test('skipped and focused tests', async s => {
    const repo = repository(s);
    const head = repo.change({
      'tests/math.test.mjs': twoTests.replace("test('adds'", "test.skip('adds'").replace("test('sub", "test.only('sub"),
    });
    const { findings } = await testWeakening(head);
    assert.deepEqual(rules(findings), ['test_skipped:tests/math.test.mjs']);
    assert.match(findings[0].detail, /0 -> 2/);
  });
  await t.test('assertions stripped while the test count stays is a warning', async s => {
    const repo = repository(s);
    const head = repo.change({ 'tests/math.test.mjs': twoTests.replace('  assert.equal(2 + 2, 4);\n', '') });
    const result = await testWeakening(head);
    assert.deepEqual(result.findings, [], 'fewer assertions alone is not refused');
    assert.deepEqual(result.warnings, [
      { rule: 'assertions_removed', file: null, detail: 'assertions 5 -> 4 across changed tests' },
    ]);
  });
  await t.test('a renamed test file is still compared', async s => {
    const repo = repository(s);
    repo.git('mv', 'tests/math.test.mjs', 'tests/arithmetic.test.mjs');
    const head = repo.change({
      'tests/arithmetic.test.mjs': twoTests.replace("test('adds'", "test.skip('adds'"),
    });
    assert.deepEqual(await weakened(head), ['test_skipped:tests/arithmetic.test.mjs']);
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
    assert.deepEqual(await weakened(head), [], 'a new skipped test and a removed helper are not weakening');
  });
});

test('Honest test work is let through: refactors, moves, splits, and an explicitly allowed removal', async t => {
  const twoMatchers =
    "import test from 'node:test';\nimport assert from 'node:assert/strict';\n" +
    "test('matches', () => {\n  assert.ok(/a/.test('a'));\n  assert.ok(/b/.test('b'));\n});\n";
  await t.test('regex.test( is not a test case', async s => {
    const repo = repository(s, { 'tests/match.test.mjs': twoMatchers });
    const head = repo.change({
      'tests/match.test.mjs': twoMatchers
        .replace("assert.ok(/a/.test('a'))", "assert.match('a', /a/)")
        .replace("assert.ok(/b/.test('b'))", "assert.match('b', /b/)"),
    });
    assert.deepEqual(await weakened(head), []);
  });
  await t.test('a describe wrapper may go', async s => {
    const wrapped =
      "import { describe, test } from 'node:test';\nimport assert from 'node:assert/strict';\n" +
      "describe('math', () => {\n  test('adds', () => assert.equal(1 + 1, 2));\n});\n";
    const repo = repository(s, { 'tests/wrapped.test.mjs': wrapped });
    const head = repo.change({
      'tests/wrapped.test.mjs':
        "import test from 'node:test';\nimport assert from 'node:assert/strict';\ntest('adds', () => assert.equal(1 + 1, 2));\n",
    });
    assert.deepEqual(await weakened(head), []);
  });
  await t.test('cases moved to another file', async s => {
    const repo = repository(s);
    const head = repo.change({
      'tests/math.test.mjs': twoTests.replace(/test\('subtracts'[\s\S]*$/, ''),
      'tests/subtract.test.mjs':
        "import test from 'node:test';\nimport assert from 'node:assert/strict';\n" +
        "test('subtracts', () => {\n  assert.equal(2 - 1, 1);\n});\n",
    });
    assert.deepEqual(await weakened(head), [], 'the cases are all still there');
  });
  await t.test('a file split in two', async s => {
    const repo = repository(s);
    const head = repo.change(
      {
        'tests/add.test.mjs': twoTests.replace(/test\('subtracts'[\s\S]*$/, ''),
        'tests/subtract.test.mjs':
          "import test from 'node:test';\nimport assert from 'node:assert/strict';\n" +
          "test('subtracts', () => {\n  assert.equal(2 - 1, 1);\n});\n",
      },
      ['tests/math.test.mjs'],
    );
    assert.deepEqual(await weakened(head), []);
  });
  await t.test('an obsolete test removed by explicit permission', async s => {
    const repo = repository(s);
    const head = repo.change({}, ['tests/math.test.mjs', 'src/math.mjs']);
    const refused = await runBehaviorGate({ ...head, config: {} });
    assert.deepEqual(rules(refused.findings), ['test_deleted:tests/math.test.mjs']);
    const permitted = await runBehaviorGate({
      ...head,
      config: { verification: { testRemovalAllowed: ['tests/math.test.mjs'] } },
    });
    assert.equal(permitted.passed, true);
    assert.deepEqual(rules(permitted.allowed), ['test_deleted:tests/math.test.mjs'], 'the receipt still shows it');
    const elsewhere = await runBehaviorGate({
      ...head,
      config: { verification: { testRemovalAllowed: ['tests/other/**'] } },
    });
    assert.equal(elsewhere.passed, false, 'the permission is for named paths only');
  });
});

test('Ways of switching a test off are found: comments, option forms, renames out of the runner', async t => {
  const cases = [
    ['commented out', text => text.replace(/test\('subtracts'[\s\S]*$/, m => m.replace(/^/gm, '// ')), 'tests_removed'],
    ['block comment', text => text.replace(/test\('subtracts'[\s\S]*$/, m => `/*\n${m}*/\n`), 'tests_removed'],
    ['skip option', text => text.replace("test('adds', () =>", "test('adds', { skip: true }, () =>"), 'test_skipped'],
    [
      'skip option with a reason and other options',
      text => text.replace("test('adds', () =>", "test('adds', { timeout: 5, skip: 'flaky' }, () =>"),
      'test_skipped',
    ],
    [
      't.skip in the body',
      text => text.replace("test('adds', () => {", "test('adds', t => {\n  t.skip();"),
      'test_skipped',
    ],
    ['todo', text => text.replace("test('adds'", "test.todo('adds'"), 'test_skipped'],
  ];
  for (const [name, change, rule] of cases)
    await t.test(name, async s => {
      const repo = repository(s);
      assert.deepEqual(await weakened(repo.change({ 'tests/math.test.mjs': change(twoTests) })), [
        `${rule}:tests/math.test.mjs`,
      ]);
    });
  await t.test('skip: false is not a skip', async s => {
    const repo = repository(s);
    const head = repo.change({
      'tests/math.test.mjs': twoTests.replace("test('adds', () =>", "test('adds', { skip: false }, () =>"),
    });
    assert.deepEqual(await weakened(head), []);
  });
  await t.test('renamed to a name no runner picks up', async s => {
    const repo = repository(s);
    mkdirSync(path.join(repo.cwd, 'archive'));
    repo.git('mv', 'tests/math.test.mjs', 'archive/math.mjs.off');
    const { findings } = await testWeakening(repo.change({}));
    assert.deepEqual(rules(findings), ['test_deleted:tests/math.test.mjs']);
    assert.match(findings[0].detail, /renamed to archive\/math\.mjs\.off/);
  });
  await t.test('python and rust forms', async s => {
    const repo = repository(s, {
      'tests/test_total.py': 'def test_total():\n    assert total([1]) == 1\n',
      'src/lib_test.rs': '#[test]\nfn adds() {\n    assert_eq!(1 + 1, 2);\n}\n',
    });
    const head = repo.change({
      'tests/test_total.py':
        'import unittest\n\n@unittest.skip("later")\ndef test_total():\n    assert total([1]) == 1\n',
      'src/lib_test.rs': '#[test]\n#[ignore = "slow"]\nfn adds() {\n    assert_eq!(1 + 1, 2);\n}\n',
    });
    assert.deepEqual((await weakened(head)).sort(), [
      'test_skipped:src/lib_test.rs',
      'test_skipped:tests/test_total.py',
    ]);
  });
});

test('A file too large to inspect is reported as unchecked, never silently passed over or thrown on', async t => {
  const big = `${twoTests}// ${'x'.repeat(300000)}\n`;
  const repo = repository(t, { 'tests/big.test.mjs': big });
  const head = repo.change({ 'tests/big.test.mjs': big.replace("test('adds'", "test.skip('adds'") });
  const receipt = await runBehaviorGate({ ...head, config: {} });
  assert.deepEqual(receipt.unchecked, [
    { file: 'tests/big.test.mjs', reason: 'too_large' },
    { file: 'tests/big.test.mjs', reason: 'too_large' },
  ]);
  assert.equal(receipt.passed, true, 'the limitation is visible in the receipt');
});

test('Paths are classified by whole words and real file kinds', () => {
  for (const [file, types] of [
    ['AUTHORS.md', ['content']],
    ['src/author.ts', ['code']],
    ['src/auth/session.ts', ['security']],
    ['lib/oauth2-client.mjs', ['security']],
    ['Dockerfile', ['ci']],
    ['infra/main.tf', ['ci']],
    ['docs/site/build.js', ['code']],
    ['CMakeLists.txt', ['config']],
    ['notes.txt', ['content']],
  ])
    assert.deepEqual(classifyChange([file]), types, file);
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
  assert.equal(tampered.repairable, true, 'restoring the oracle is something a repair can do');
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
  assert.equal(strict.repairable, false, 'no repair session can enable a gate');
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
    { kind: 'test', command, baseline: null, final: 1, classification: 'no_baseline' },
    'a baseline command that did not finish says nothing about the base',
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
    testRemovalAllowed: [],
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

test('An oracle that changes the checked tree fails the gate and stops the oracles after it', async t => {
  const repo = repository(t);
  const head = repo.change({ 'src/math.mjs': 'export const add = (a, b) => b + a;\n' });
  const ran = [];
  const receipt = await runBehaviorGate({
    ...head,
    config: {
      verification: {
        oracles: [
          { id: 'writer', command: 'node', protect: ['oracle/**'] },
          { id: 'later', command: 'node', protect: ['oracle/**'] },
        ],
      },
    },
    runner: async () => {
      ran.push(ran.length);
      return { code: 0, stdout: '', stderr: '' };
    },
    isClean: async () => false,
    persist: async (kind, value) => ({ sha256: 'e'.repeat(64), path: `${kind}-${value.id}` }),
  });
  assert.equal(ran.length, 1, 'no oracle runs on a tree another oracle changed');
  assert.deepEqual(rules(receipt.findings), ['oracle_dirty_worktree:null']);
  assert.equal(receipt.passed, false);
  // A crashed oracle leaves evidence too.
  const crashed = await runBehaviorGate({
    ...head,
    config: { verification: { oracles: [{ id: 'gone', command: 'missing-binary', protect: ['oracle/**'] }] } },
    runner: async () => {
      throw Object.assign(new Error('not found'), { code: 'ENOENT' });
    },
    persist: async () => ({ sha256: 'f'.repeat(64), path: 'oracle-evidence' }),
  });
  assert.deepEqual(crashed.oracles, [
    {
      id: 'gone',
      status: 'failed',
      reason: 'ENOENT',
      exitCode: null,
      outputPath: 'oracle-evidence',
      outputHash: 'f'.repeat(64),
    },
  ]);
});
