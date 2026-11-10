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
    assert.match(findings[0].detail, /switched off: "adds", "subtracts"/);
  });
  await t.test('assertions stripped while the test count stays is a warning', async s => {
    const repo = repository(s);
    const head = repo.change({ 'tests/math.test.mjs': twoTests.replace('  assert.equal(2 + 2, 4);\n', '') });
    const result = await testWeakening(head);
    assert.deepEqual(result.findings, [], 'fewer assertions alone is not refused');
    assert.equal(result.warnings.length, 1);
    assert.match(result.warnings[0].detail, /^assertions \d+ -> \d+ across changed tests$/);
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
        // The existing cases keep their names; a case is added; a new skipped test is not weakening.
        'tests/math.test.mjs':
          "import test from 'node:test';\nimport assert from 'node:assert/strict';\n" +
          "test('adds', () => assert.equal(1 + 1, 2));\ntest('adds more', () => assert.equal(2 + 2, 4));\n" +
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

const header = "import test from 'node:test';\nimport assert from 'node:assert/strict';\n";
const one = (name, body = 'assert.equal(1, 1)') => `test('${name}', () => {\n  ${body};\n});\n`;

test('Cases are compared by name: fillers do not hide a removal, moves and data are not removals', async t => {
  await t.test('a deleted file is not compensated by a new file with as many cases', async s => {
    const repo = repository(s);
    const head = repo.change({ 'tests/filler.test.mjs': header + one('a') + one('b') }, ['tests/math.test.mjs']);
    assert.deepEqual(await weakened(head), ['test_deleted:tests/math.test.mjs']);
  });
  await t.test('a removed case is not compensated by a new case elsewhere', async s => {
    const repo = repository(s, { 'tests/other.test.mjs': header + one('other') });
    const head = repo.change({
      'tests/math.test.mjs': twoTests.replace(/test\('subtracts'[\s\S]*$/, ''),
      'tests/other.test.mjs': header + one('other') + one('brand new'),
    });
    const { findings } = await testWeakening(head);
    assert.deepEqual(rules(findings), ['tests_removed:tests/math.test.mjs']);
    assert.match(findings[0].detail, /test cases removed: "subtracts"/);
  });
  await t.test('a test renamed out of the runner is not compensated by fillers', async s => {
    const repo = repository(s);
    mkdirSync(path.join(repo.cwd, 'archive'));
    repo.git('mv', 'tests/math.test.mjs', 'archive/math.mjs.off');
    const head = repo.change({ 'tests/filler.test.mjs': header + one('a') + one('b') });
    assert.deepEqual(await weakened(head), ['test_deleted:tests/math.test.mjs']);
  });
  await t.test('a renamed case is reported as removed', async s => {
    const repo = repository(s);
    const head = repo.change({ 'tests/math.test.mjs': twoTests.replace("test('adds'", "test('sums'") });
    assert.deepEqual(await weakened(head), ['tests_removed:tests/math.test.mjs'], 'a known limit of name identity');
  });
  await t.test('skip as data, and a new conditionally skipped test, are not skips', async s => {
    const repo = repository(s);
    const head = repo.change({
      'tests/math.test.mjs':
        twoTests.replace(
          '  assert.equal(2 - 1, 1);\n',
          '  assert.deepEqual(page({ skip: 10, take: 5 }), { todo: 0 });\n  assert.equal(2 - 1, 1);\n',
        ) + "test('windows only', { skip: process.platform !== 'win32' }, () => {\n  assert.equal(1, 1);\n});\n",
    });
    assert.deepEqual(await weakened(head), []);
  });
  await t.test('a skip option added to an existing case is a skip', async s => {
    const repo = repository(s);
    const head = repo.change({
      'tests/math.test.mjs': twoTests.replace(
        "test('adds', () =>",
        "test('adds', { skip: process.platform !== 'win32' }, () =>",
      ),
    });
    assert.deepEqual(await weakened(head), ['test_skipped:tests/math.test.mjs']);
  });
  await t.test('glob strings and URLs are not comments', async s => {
    const withDocs = `${twoTests}/**\n * Helper.\n */\nexport const helper = () => 'https://example.invalid/a';\n`;
    const repo = repository(s, { 'tests/math.test.mjs': withDocs });
    const added = repo.change({
      'tests/math.test.mjs': withDocs.replace(header, `${header}const scopes = ['src/**', '/*.js'];\n`),
    });
    assert.deepEqual(await weakened(added), [], 'a string with /* opens no comment');
    const second = repository(s, {
      'tests/math.test.mjs': withDocs.replace(header, `${header}const scopes = ['src/**'];\n`),
    });
    const removed = second.change({
      'tests/math.test.mjs': withDocs
        .replace(header, `${header}const scopes = ['src/**'];\n`)
        .replace(/test\('subtracts'[\s\S]*?\}\);\n/, ''),
    });
    assert.deepEqual(
      await weakened(removed),
      ['tests_removed:tests/math.test.mjs'],
      'cases after such a string are still seen',
    );
  });
  await t.test('test code quoted inside a string is not a test', async s => {
    const fixture = `${header}const sample = "test('inner', () => {})";\n${one('outer', 'assert.ok(sample)')}`;
    const repo = repository(s, { 'tests/meta.test.mjs': fixture });
    const head = repo.change({ 'tests/meta.test.mjs': fixture.replace("test('inner'", "it('other'") });
    assert.deepEqual(await weakened(head), []);
  });
  await t.test('playwright groups and steps are not cases', async s => {
    const grouped = `${header}test.describe('math', () => {\n  test('adds', async () => {\n    await test.step('open', async () => {});\n    assert.equal(1 + 1, 2);\n  });\n});\n`;
    const repo = repository(s, { 'tests/e2e.test.mjs': grouped });
    const head = repo.change({
      'tests/e2e.test.mjs': `${header}test('adds', async () => {\n  assert.equal(1 + 1, 2);\n});\n`,
    });
    assert.deepEqual(await weakened(head), []);
  });
  await t.test('an already skipped test may move to another file', async s => {
    const skipped = "test.skip('later', () => {});\n";
    const repo = repository(s, {
      'tests/a.test.mjs': header + one('a') + skipped,
      'tests/b.test.mjs': header + one('b'),
    });
    const head = repo.change({
      'tests/a.test.mjs': header + one('a'),
      'tests/b.test.mjs': header + one('b') + skipped,
    });
    assert.deepEqual(await weakened(head), []);
  });
  await t.test('an allowed removal does not turn an honest move into a removal', async s => {
    const repo = repository(s, { 'tests/legacy/old.test.mjs': header + one('legacy') });
    const head = repo.change(
      {
        'tests/math.test.mjs': twoTests.replace(/test\('subtracts'[\s\S]*$/, ''),
        'tests/subtract.test.mjs': `${header}test('subtracts', () => {\n  assert.equal(2 - 1, 1);\n});\n`,
      },
      ['tests/legacy/old.test.mjs'],
    );
    const receipt = await runBehaviorGate({
      ...head,
      config: { verification: { testRemovalAllowed: ['tests/legacy/**'] } },
    });
    assert.deepEqual([receipt.passed, rules(receipt.findings)], [true, []]);
    // Git may pair the deleted legacy file with the new one as a rename; the permission follows the base path.
    assert.deepEqual(
      receipt.allowed.map(finding => finding.file),
      ['tests/legacy/old.test.mjs'],
    );
  });
  await t.test('the permission covers removal only, not a skip', async s => {
    const repo = repository(s);
    const head = repo.change({ 'tests/math.test.mjs': twoTests.replace("test('adds'", "test.skip('adds'") });
    const receipt = await runBehaviorGate({ ...head, config: { verification: { testRemovalAllowed: ['tests/**'] } } });
    assert.deepEqual(rules(receipt.findings), ['test_skipped:tests/math.test.mjs']);
  });
  await t.test('a removed test file too large to read is still a removed test', async s => {
    const big = `${twoTests}// ${'x'.repeat(300000)}\n`;
    const repo = repository(s, { 'tests/big.test.mjs': big });
    const receipt = await runBehaviorGate({ ...repo.change({}, ['tests/big.test.mjs']), config: {} });
    assert.deepEqual(rules(receipt.findings), ['test_deleted:tests/big.test.mjs']);
    assert.deepEqual(receipt.unchecked, [{ file: 'tests/big.test.mjs', reason: 'too_large' }]);
  });
});

test('A finding only a person can fix makes the whole gate unrepairable, whatever else was found', async t => {
  const repo = repository(t, { 'styles/app.css': 'a { color: red; }\n' });
  const head = repo.change({ 'styles/app.css': 'a { color: blue; }\n' }, ['tests/math.test.mjs']);
  const receipt = await runBehaviorGate({ ...head, config: { verification: { strictGates: true } } });
  assert.deepEqual(rules(receipt.findings).sort(), ['required_gate_disabled:null', 'test_deleted:tests/math.test.mjs']);
  assert.equal(receipt.repairable, false, 'repair rounds would be spent for nothing');
});

test('Template names with interpolation, regex literals and nested quotes do not derail the scanner', async t => {
  const tricky =
    header +
    "for (const flag of ['a', 'b'])\n  test(`hidden by ${flag}`, async () => {\n    assert.match(`${flag}'s \"x\"`, /['\"`/]+x/);\n  });\n" +
    'const pattern = /https?:\\/\\/[^\'"]+/;\n' +
    one('first after') +
    one('second after', "assert.ok(pattern.test('https://example.invalid/'))");
  const repo = repository(t, { 'tests/tricky.test.mjs': tricky });
  const touched = repo.change({ 'tests/tricky.test.mjs': `${tricky}\n// touched\n` });
  assert.deepEqual(await weakened(touched), [], 'a harmless edit reports nothing');
  const removed = repo.change({
    'tests/tricky.test.mjs': tricky.replace(
      one('second after', "assert.ok(pattern.test('https://example.invalid/'))"),
      '',
    ),
  });
  const { findings } = await testWeakening(removed);
  assert.deepEqual(rules(findings), ['tests_removed:tests/tricky.test.mjs']);
  assert.match(findings[0].detail, /"second after"/);
  const renamedTemplate = repo.change({
    'tests/tricky.test.mjs': tricky.replace('hidden by ${flag}', 'shown by ${flag}'),
  });
  assert.match((await testWeakening(renamedTemplate)).findings[0].detail, /"hidden by \$\{flag\}"/);
});

const grouped =
  "import { describe, test } from 'node:test';\nimport assert from 'node:assert/strict';\n" +
  "describe('math', () => {\n  test('adds', () => assert.equal(1 + 1, 2));\n  test('subtracts', () => assert.equal(2 - 1, 1));\n});\n" +
  "describe('other', () => {\n  test('multiplies', () => assert.equal(2 * 2, 4));\n});\n";

test('A skip on a group switches off the cases under it; .only stops the rest of the file', async t => {
  const math = /switched off: "adds", "subtracts"$/;
  const forms = [
    ['describe.skip', text => text.replace("describe('math'", "describe.skip('math'"), math],
    ['xdescribe', text => text.replace("describe('math'", "xdescribe('math'"), math],
    ['describe.todo', text => text.replace("describe('math'", "describe.todo('math'"), math],
    [
      'describe with a skip option',
      text => text.replace("describe('math', () =>", "describe('math', { skip: true }, () =>"),
      math,
    ],
    ['Playwright test.describe.skip', text => text.replace("describe('math'", "test.describe.skip('math'"), math],
    ['describe.skipIf', text => text.replace("describe('math'", "describe.skipIf(process.env.CI)('math'"), math],
    [
      'a new skipped group around an existing one',
      text =>
        `${text.replace("describe('other', () => {", "describe.skip('wip', () => {\ndescribe('other', () => {")}});\n`,
      /switched off: "multiplies"$/,
    ],
    [
      'describe.only on a sibling group',
      text => text.replace("describe('other'", "describe.only('other'"),
      /focused with \.only 0 -> 1/,
    ],
    [
      'Playwright test.describe.only',
      text => text.replace("describe('other'", "test.describe.only('other'"),
      /focused with \.only 0 -> 1/,
    ],
  ];
  for (const [name, change, detail] of forms)
    await t.test(name, async s => {
      const repo = repository(s, { 'tests/grouped.test.mjs': grouped });
      const { findings } = await testWeakening(repo.change({ 'tests/grouped.test.mjs': change(grouped) }));
      assert.deepEqual(rules(findings), ['test_skipped:tests/grouped.test.mjs']);
      assert.match(findings[0].detail, detail);
    });
  await t.test('a subtest and a case with the shorthand option', async s => {
    const parent =
      header +
      "const skip = true;\ntest('parent', async t => {\n  await t.test('sub', () => assert.ok(skip));\n});\n" +
      one('plain');
    const repo = repository(s, { 'tests/parent.test.mjs': parent });
    const head = repo.change({
      'tests/parent.test.mjs': parent
        .replace("t.test('sub', () =>", "t.test('sub', { skip: true }, () =>")
        .replace("test('plain', () =>", "test('plain', { skip }, () =>"),
    });
    const { findings } = await testWeakening(head);
    assert.deepEqual(rules(findings), ['test_skipped:tests/parent.test.mjs']);
    assert.match(findings[0].detail, /switched off: "plain", "sub"$/);
  });
});

test('Honest work around skips passes: enabling a test, a namesake todo, new skipped or focused tests', async t => {
  const honest = [
    [
      'a conditional skip removed',
      grouped.replace("test('adds'", "test.skipIf(process.platform === 'win32')('adds'"),
      grouped,
    ],
    ['a skipped group enabled', grouped.replace("describe('math'", "describe.skip('math'"), grouped],
    ['a todo with the name of a running case', grouped, `${grouped}test.todo('adds');\n`],
    [
      'a quote style change',
      `${header}test('it\\'s fine', () => assert.ok(true));\n`,
      `${header}test("it's fine", () => assert.ok(true));\n`,
    ],
    [
      'a new skipped group of new cases',
      grouped,
      `${grouped}describe.skip('later', () => {\n  test('divides', () => assert.equal(4 / 2, 2));\n});\n`,
    ],
    [
      'a group that was already skipped',
      grouped.replace("describe('math'", "describe.skip('math'"),
      `${grouped.replace("describe('math'", "describe.skip('math'")}\n// touched\n`,
    ],
  ];
  for (const [name, before, after] of honest)
    await t.test(name, async s => {
      const repo = repository(s, { 'tests/grouped.test.mjs': before });
      assert.deepEqual(await weakened(repo.change({ 'tests/grouped.test.mjs': after })), []);
    });
  await t.test('.only in a file of new tests only', async s => {
    const repo = repository(s);
    const head = repo.change({ 'tests/new.test.mjs': `${header}test.only('fresh', () => assert.ok(true));\n` });
    assert.deepEqual(await weakened(head), [], 'no existing test of that file stops running');
  });
});

test('Python, Rust and Java: a skip on a class or a module, long decorators, comments between', async t => {
  const python =
    'import unittest\nimport pytest\n\n\nclass TestTotal(unittest.TestCase):\n' +
    '    def test_total(self):\n        self.assertEqual(total([1]), 1)\n\n' +
    '    def test_empty(self):\n        self.assertEqual(total([]), 0)\n\n\n' +
    '@pytest.mark.parametrize(\n    "value",\n    [1, 2],\n)\ndef test_param(value):\n    assert value\n';
  const forms = [
    [
      'a decorator on a class',
      text => text.replace('class TestTotal', '@unittest.skip("later")\nclass TestTotal'),
      /switched off: "test_total", "test_empty"$/,
    ],
    [
      'a module-level pytestmark',
      text => text.replace('\n\nclass', '\npytestmark = pytest.mark.skip(reason="later")\n\nclass'),
      /switched off: "test_total", "test_empty", "test_param"$/,
    ],
    [
      'a skip above a decorator that spans lines',
      text => text.replace('@pytest.mark.parametrize(', '@pytest.mark.skip\n@pytest.mark.parametrize('),
      /switched off: "test_param"$/,
    ],
    [
      'a decorator in a file with CRLF line ends',
      text =>
        text.replace('    def test_empty', '    @unittest.skip("later")\n    def test_empty').replaceAll('\n', '\r\n'),
      /switched off: "test_empty"$/,
    ],
  ];
  for (const [name, change, detail] of forms)
    await t.test(name, async s => {
      const repo = repository(s, { 'tests/test_total.py': python });
      const { findings } = await testWeakening(repo.change({ 'tests/test_total.py': change(python) }));
      assert.deepEqual(rules(findings), ['test_skipped:tests/test_total.py']);
      assert.match(findings[0].detail, detail);
    });
  await t.test('an edit of the body under a long decorator is honest work', async s => {
    const repo = repository(s, { 'tests/test_total.py': python });
    const head = repo.change({ 'tests/test_total.py': python.replace('assert value\n', 'assert value > 0\n') });
    assert.deepEqual(await weakened(head), []);
  });
  await t.test('rust: a comment between the attribute and the function', async s => {
    const rust = '#[test]\n// explains the case\nfn adds() {\n    assert_eq!(1 + 1, 2);\n}\n';
    const repo = repository(s, { 'src/lib_test.rs': rust });
    const head = repo.change({ 'src/lib_test.rs': rust.replace('#[test]\n', '#[test]\n#[ignore]\n') });
    assert.deepEqual(await weakened(head), ['test_skipped:src/lib_test.rs']);
    const removed = repo.change({ 'src/lib_test.rs': '// nothing left\n' });
    assert.deepEqual(await weakened(removed), ['tests_removed:src/lib_test.rs']);
  });
  await t.test('java: @Disabled on the class', async s => {
    const java =
      'import org.junit.jupiter.api.Test;\n\nclass TotalTest {\n    @Test\n    void addsUp() {\n        assertEquals(2, 1 + 1);\n    }\n}\n';
    const repo = repository(s, { 'src/test/java/TotalTest.java': java });
    const head = repo.change({
      'src/test/java/TotalTest.java': java.replace('class TotalTest', '@Disabled("later")\nclass TotalTest'),
    });
    assert.deepEqual(await weakened(head), ['test_skipped:src/test/java/TotalTest.java']);
  });
});

test('Code inside a template expression does not derail the scanner', async t => {
  const tricky =
    header +
    "const brace = c => `${c === '{' ? 1 : 2}`;\n" +
    "const nested = `a ${`b ${'`'} c`} d`;\n" +
    "const cleaned = value => `${value.replace(/[`}]/g, '')}`;\n" +
    'const commented = `${1 /* } ` */ + 1}`;\n' +
    one('first after') +
    one('second after');
  const repo = repository(t, { 'tests/tricky.test.mjs': tricky });
  assert.deepEqual(await weakened(repo.change({ 'tests/tricky.test.mjs': `${tricky}\n// touched\n` })), []);
  const removed = repo.change({ 'tests/tricky.test.mjs': tricky.replace(one('second after'), '') });
  const { findings } = await testWeakening(removed);
  assert.deepEqual(rules(findings), ['tests_removed:tests/tricky.test.mjs']);
  assert.match(findings[0].detail, /test cases removed: "second after"$/);
});

test('Scanning stays linear on input built to make a pattern rescan the file', async t => {
  const size = 200000;
  const files = {
    'tests/slashes.test.mjs': `${header}${one('kept')}const value = 1${' / 2'.repeat(size / 4)};\n`,
    'tests/test_decorated.py': `def test_kept():\n    assert True\n\n\n${'@decorator\n'.repeat(size / 11)}`,
    'src/attrs_test.rs': `#[test]\nfn kept() {}\n${'#[allow(unused)]\n'.repeat(size / 17)}`,
    'src/test/java/ManyTest.java': `class ManyTest {\n  @Test\n  void kept() {}\n}\n${'@Ignore'.repeat(size / 7)}`,
    'src/test/java/DenseTest.java': `class DenseTest {\n${'  @Disabled @A @Test void same() {}\n'.repeat(size / 34)}}\n`,
    'src/test/java/QuotesTest.java': `class QuotesTest {\n  @Test\n  void kept() {}\n  String s = ${'\\"'.repeat(size / 2)};\n}\n`,
    'src/test/kotlin/ApostrophesTest.kt': `class ApostrophesTest {\n  @Test fun kept() {}\n}\n${"'\\".repeat(size / 2)}\n`,
  };
  const repo = repository(t, files);
  const head = repo.change(Object.fromEntries(Object.entries(files).map(([name, text]) => [name, `${text}\n`])));
  const started = performance.now();
  const result = await testWeakening(head);
  const elapsed = performance.now() - started;
  assert.deepEqual([result.findings, result.unchecked], [[], []]);
  // Each of these took tens of seconds with a pattern that rescans; linear work is far under a second.
  assert.ok(elapsed < 10000, `scanned in ${Math.round(elapsed)} ms`);
});

test('A skipped newcomer does not switch its neighbours off; list and class marks are read', async t => {
  await t.test('a new skipped group with JSX before existing cases', async s => {
    const view = `${header}describe('math', () => {\n  test('adds', () => assert.equal(1 + 1, 2));\n});\n`;
    const repo = repository(s, { 'tests/view.test.tsx': view });
    const head = repo.change({
      'tests/view.test.tsx': view.replace(
        "describe('math'",
        "describe.skip('wip', () => {\n  test('fresh', () => {\n    render(<App>hi</App>);\n  });\n});\ndescribe('math'",
      ),
    });
    assert.deepEqual(await weakened(head), []);
  });
  const conditional =
    header +
    "test('opens', async ({ page, browserName }) => {\n  test.skip(browserName === 'firefox', 'flaky');\n  assert.ok(page);\n});\n";
  const plain = conditional.replace("  test.skip(browserName === 'firefox', 'flaky');\n", '');
  await t.test('a conditional skip removed from a test body', async s => {
    const repo = repository(s, { 'tests/page.test.mjs': conditional });
    assert.deepEqual(await weakened(repo.change({ 'tests/page.test.mjs': plain })), []);
  });
  await t.test('a conditional skip added to a test body', async s => {
    const repo = repository(s, { 'tests/page.test.mjs': plain });
    const { findings } = await testWeakening(repo.change({ 'tests/page.test.mjs': conditional }));
    assert.deepEqual(rules(findings), ['test_skipped:tests/page.test.mjs']);
    assert.match(findings[0].detail, /skip calls inside existing tests 0 -> 1/);
  });
  await t.test('pytestmark as a list over several lines', async s => {
    const marked =
      'import pytest\n\npytestmark = [\n    pytest.mark.slow,\n]\n\n\ndef test_total():\n    assert True\n';
    const repo = repository(s, { 'tests/test_marked.py': marked });
    const head = repo.change({
      'tests/test_marked.py': marked.replace(
        '    pytest.mark.slow,\n',
        '    pytest.mark.slow,\n    pytest.mark.skip(reason="later"),\n',
      ),
    });
    assert.deepEqual(await weakened(head), ['test_skipped:tests/test_marked.py']);
    const touched = repo.change({ 'tests/test_marked.py': marked.replace('assert True', 'assert 1 == 1') });
    assert.deepEqual(await weakened(touched), [], 'a mark without a skip switches nothing off');
  });
  await t.test('pytestmark inside a class', async s => {
    const classed =
      'import pytest\n\n\nclass TestTotal:\n    def test_total(self):\n        assert True\n\n\ndef test_free():\n    assert True\n';
    const repo = repository(s, { 'tests/test_classed.py': classed });
    const head = repo.change({
      'tests/test_classed.py': classed.replace(
        'class TestTotal:\n',
        'class TestTotal:\n    pytestmark = pytest.mark.skip\n\n',
      ),
    });
    const { findings } = await testWeakening(head);
    assert.deepEqual(rules(findings), ['test_skipped:tests/test_classed.py']);
    assert.match(findings[0].detail, /switched off: "test_total"$/);
  });
  await t.test('java: @Disabled on a new method beside an existing one', async s => {
    const java =
      'import org.junit.jupiter.api.Test;\n\nclass TotalTest {\n    @Test\n    void subtracts() {\n        assertEquals(1, 2 - 1);\n    }\n}\n';
    const repo = repository(s, { 'src/test/java/TotalTest.java': java });
    const head = repo.change({
      'src/test/java/TotalTest.java': java.replace(
        '    @Test\n    void subtracts',
        '    @Disabled("waiting for the new class loader")\n    @Test\n    void fresh() {}\n\n    @Test\n    void subtracts',
      ),
    });
    assert.deepEqual(await weakened(head), []);
    const disabled = repo.change({
      'src/test/java/TotalTest.java': java.replace(
        '    @Test\n    void subtracts',
        '    @Disabled\n    @Test\n    void subtracts',
      ),
    });
    assert.deepEqual(await weakened(disabled), ['test_skipped:src/test/java/TotalTest.java']);
  });
});

test('Annotations and marks are read with their strings and their place', async t => {
  const java =
    'import org.junit.jupiter.api.Test;\n\nclass TotalTest {\n    @Test\n    void subtracts() {\n        assertEquals(1, 2 - 1);\n    }\n}\n';
  for (const [name, change] of [
    [
      'java: a reason with a semicolon, braces and parentheses on a method',
      text => text.replace('    @Test\n', '    @Disabled("flaky; fix {later} (see JIRA-1)")\n    @Test\n'),
    ],
    [
      'java: a reason with parentheses and a comment on a class',
      text =>
        text.replace('class TotalTest', '@Disabled("flaky (see JIRA-1)") // until the class is ready\nclass TotalTest'),
    ],
  ])
    await t.test(name, async s => {
      const repo = repository(s, { 'src/test/java/TotalTest.java': java });
      const head = repo.change({ 'src/test/java/TotalTest.java': change(java) });
      assert.deepEqual(await weakened(head), ['test_skipped:src/test/java/TotalTest.java']);
    });
  await t.test('kotlin: a disabled newcomer with an expression body', async s => {
    const kotlin = 'class TotalTest {\n    @Test fun subtracts() = assertEquals(1, 2 - 1)\n}\n';
    const repo = repository(s, { 'src/test/kotlin/TotalTest.kt': kotlin });
    const head = repo.change({
      'src/test/kotlin/TotalTest.kt': kotlin.replace(
        '    @Test fun subtracts',
        '    @Disabled("wip") @Test fun fresh() = assertEquals(1, 1)\n    @Test fun subtracts',
      ),
    });
    assert.deepEqual(await weakened(head), []);
  });
  await t.test('a new skipped group with a self-closing JSX tag', async s => {
    const view = `${header}describe('math', () => {\n  test('adds', () => assert.equal(1 + 1, 2));\n});\n`;
    const repo = repository(s, { 'tests/view.test.tsx': view });
    const head = repo.change({
      'tests/view.test.tsx': view.replace(
        "describe('math'",
        "describe.skip('wip', () => {\n  test('fresh', () => {\n    render(<App user={user} />);\n  });\n});\ndescribe('math'",
      ),
    });
    assert.deepEqual(await weakened(head), []);
  });
  const opens = `${header}test('opens', async ({ page, isMobile }) => {\n  assert.ok(page);\n});\n`;
  for (const call of ['test.fixme();', "test.skip(!isMobile, 'desktop only');"])
    await t.test(`a skip call without a name: ${call}`, async s => {
      const repo = repository(s, { 'tests/page.test.mjs': opens });
      const head = repo.change({
        'tests/page.test.mjs': opens.replace('  assert.ok(page);', `  ${call}\n  assert.ok(page);`),
      });
      const { findings } = await testWeakening(head);
      assert.deepEqual(rules(findings), ['test_skipped:tests/page.test.mjs']);
      assert.match(findings[0].detail, /skip calls inside existing tests 0 -> 1/);
    });
  const classed =
    'import pytest\n\n\nclass TestTotal:\n    def test_total(self):\n        assert True\n\n    def test_empty(self):\n        assert True\n';
  await t.test('pytestmark at the end of a class body covers the tests above it', async s => {
    const repo = repository(s, { 'tests/test_classed.py': classed });
    const head = repo.change({ 'tests/test_classed.py': `${classed}\n    pytestmark = pytest.mark.skip\n` });
    const { findings } = await testWeakening(head);
    assert.deepEqual(rules(findings), ['test_skipped:tests/test_classed.py']);
    assert.match(findings[0].detail, /switched off: "test_total", "test_empty"$/);
  });
  await t.test('a variable named pytestmark inside a method marks nothing', async s => {
    const repo = repository(s, { 'tests/test_classed.py': classed });
    const head = repo.change({
      'tests/test_classed.py': classed.replace(
        '    def test_total(self):\n',
        '    def test_total(self):\n        pytestmark = compute(skip_list)\n',
      ),
    });
    assert.deepEqual(await weakened(head), []);
  });
  await t.test('java: a block comment between the annotations, a quote in a character literal', async s => {
    const quoted = java.replace('class TotalTest {\n', "class TotalTest {\n    char quote = '\"';\n");
    const repo = repository(s, { 'src/test/java/TotalTest.java': quoted });
    const head = repo.change({
      'src/test/java/TotalTest.java': quoted.replace(
        '    @Test\n',
        '    @Disabled\n    /* flaky; see {the} (issue) */\n    @Test\n',
      ),
    });
    assert.deepEqual(await weakened(head), ['test_skipped:src/test/java/TotalTest.java']);
  });
  await t.test('pytestmark under a class header that spans lines', async s => {
    const wide = classed.replace('class TestTotal:\n', 'class TestTotal(\n        Base,\n        Mixin):\n');
    const repo = repository(s, { 'tests/test_classed.py': wide });
    const head = repo.change({
      'tests/test_classed.py': wide.replace(
        '        Mixin):\n',
        '        Mixin):\n    pytestmark = pytest.mark.skip\n\n',
      ),
    });
    const { findings } = await testWeakening(head);
    assert.deepEqual(rules(findings), ['test_skipped:tests/test_classed.py']);
    assert.match(findings[0].detail, /switched off: "test_total", "test_empty"$/);
  });
});

test('The file that lost a case is the one reported, also when another file has a case of that name', async t => {
  const works = `${header}${one('works')}`;
  const repo = repository(t, { 'tests/a.test.mjs': works, 'tests/z.test.mjs': works });
  // `tests/a.test.mjs` is deleted; `tests/z.test.mjs` keeps its own case and only gains a comment.
  const head = repo.change({ 'tests/z.test.mjs': `${works}// touched\n` }, ['tests/a.test.mjs']);
  const refused = await runBehaviorGate({
    ...head,
    config: { verification: { testRemovalAllowed: ['tests/z.test.mjs'] } },
  });
  assert.deepEqual(
    rules(refused.findings),
    ['test_deleted:tests/a.test.mjs'],
    'a permission for another file does not cover it',
  );
  assert.deepEqual(refused.allowed, []);
  const permitted = await runBehaviorGate({
    ...head,
    config: { verification: { testRemovalAllowed: ['tests/a.test.mjs'] } },
  });
  assert.equal(permitted.passed, true);
  assert.deepEqual(rules(permitted.allowed), ['test_deleted:tests/a.test.mjs']);
  // A real move is still a move: the case leaves one file and appears in a new one.
  const moved = repo.change({ 'tests/b.test.mjs': works });
  assert.deepEqual(await weakened(moved), [], 'the deleted case is found in the new file');
});
