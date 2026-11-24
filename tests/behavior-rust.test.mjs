import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  normalizeVerificationConfig,
  runBehaviorGate,
  rustTestCases,
  testWeakening,
} from '../runtime/behavior-gate.mjs';

/** A Git repository with one commit; `change` edits the tree and commits the head. */
function repository(t, files = {}) {
  const cwd = mkdtempSync(path.join(os.tmpdir(), 'kodo-rust-'));
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
  write({ 'README.md': '# game\n', ...files });
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

const lib =
  'pub fn add(a: i32, b: i32) -> i32 {\n    a + b\n}\n\n' +
  '#[cfg(test)]\nmod tests {\n    use super::*;\n\n' +
  '    #[test]\n    fn adds() {\n        assert_eq!(add(1, 1), 2);\n    }\n\n' +
  '    #[test]\n    fn adds_negative() {\n        assert_eq!(add(-1, -1), -2);\n    }\n}\n';
const withoutNegative = lib.replace(
  '\n    #[test]\n    fn adds_negative() {\n        assert_eq!(add(-1, -1), -2);\n    }\n',
  '',
);

test('Rust test names follow `cargo test -- --list`: crate-relative module path and function', () => {
  const names = (file, source) => rustTestCases(file, source).map(item => item.name);
  assert.deepEqual(names('src/lib.rs', lib), ['tests::adds', 'tests::adds_negative']);
  assert.deepEqual(names('src/main.rs', lib), ['tests::adds', 'tests::adds_negative']);
  assert.deepEqual(names('crates/engine/src/world/chunk.rs', lib), [
    'world::chunk::tests::adds',
    'world::chunk::tests::adds_negative',
  ]);
  assert.deepEqual(names('src/world/mod.rs', lib), ['world::tests::adds', 'world::tests::adds_negative']);
  assert.deepEqual(names('src/bin/server.rs', lib), ['tests::adds', 'tests::adds_negative']);
  assert.deepEqual(names('src/bin/server/net.rs', lib), ['net::tests::adds', 'net::tests::adds_negative']);
  // An integration test file is a crate of its own.
  assert.deepEqual(names('tests/physics.rs', '#[test]\nfn falls() {\n    assert!(fall() > 0);\n}\n'), ['falls']);
  assert.deepEqual(names('tests/common/mod.rs', 'mod inner {\n    #[test]\n    fn shared() { check(); }\n}\n'), [
    'common::inner::shared',
  ]);
  const attributes =
    '#[tokio::test]\nasync fn ticks() { assert!(tick().await); }\n' +
    '#[tokio::test(flavor = "multi_thread", worker_threads = 2)]\nasync fn ticks_many() { assert!(tick().await); }\n' +
    '#[test]\n#[ignore = "slow"]\nfn slow() { assert!(slow()); }\n' +
    '#[test_case(1)]\nfn generated(x: i32) { assert!(x > 0); }\n' +
    '#[cfg_attr(not(feature = "gpu"), ignore)]\n#[test]\nfn gpu() { assert!(gpu()); }\n' +
    '#[test] pub(crate) fn one_line() { assert!(one()); }\n';
  assert.deepEqual(rustTestCases('tests/runtime.rs', attributes), [
    { name: 'ticks', skipped: false },
    { name: 'ticks_many', skipped: false },
    { name: 'slow', skipped: true },
    { name: 'gpu', skipped: true },
    { name: 'one_line', skipped: false },
  ]);
});

test('Rust tests inside src/**/*.rs are protected', async t => {
  await t.test('a test removed from a #[cfg(test)] module in src/', async s => {
    const repo = repository(s, { 'src/lib.rs': lib });
    const { findings } = await testWeakening(repo.change({ 'src/lib.rs': withoutNegative }));
    assert.deepEqual(rules(findings), ['tests_removed:src/lib.rs']);
    assert.match(findings[0].detail, /"tests::adds_negative"/);
  });
  await t.test('a deleted source file takes its tests with it', async s => {
    const repo = repository(s, { 'src/lib.rs': 'pub mod world;\n', 'src/world/chunk.rs': lib });
    const { findings } = await testWeakening(repo.change({}, ['src/world/chunk.rs']));
    assert.deepEqual(rules(findings), ['test_deleted:src/world/chunk.rs']);
    assert.match(findings[0].detail, /"world::chunk::tests::adds"/);
  });
  await t.test('a test module moved to another module is a rename: its cargo names are gone', async s => {
    const repo = repository(s, { 'src/lib.rs': lib });
    const head = repo.change({ 'src/lib.rs': 'pub mod math;\n', 'src/math.rs': lib });
    assert.deepEqual(await weakened(head), ['tests_removed:src/lib.rs']);
  });
  await t.test('an #[ignore] added in src/ switches the test off', async s => {
    const repo = repository(s, { 'src/lib.rs': lib });
    const head = repo.change({
      'src/lib.rs': lib.replace('    #[test]\n    fn adds()', '    #[test]\n    #[ignore]\n    fn adds()'),
    });
    assert.deepEqual(await weakened(head), ['test_skipped:src/lib.rs']);
  });
  await t.test('editing production code next to unchanged tests passes', async s => {
    const repo = repository(s, { 'src/lib.rs': lib, 'src/plain.rs': 'pub fn one() -> i32 {\n    1\n}\n' });
    const head = repo.change({
      'src/lib.rs': lib.replace('    a + b\n', '    b + a\n'),
      'src/plain.rs': 'pub fn one() -> i32 {\n    2 - 1\n}\n',
    });
    const result = await testWeakening(head);
    assert.deepEqual([result.findings, result.unchecked, result.warnings], [[], [], []]);
  });
  await t.test('an asserting helper in production code does not count as a test assertion', async s => {
    const helper = 'pub fn check(x: i32) {\n    assert!(x > 0);\n    assert!(x < 10);\n}\n';
    const repo = repository(s, { 'src/lib.rs': `${helper}${lib}` });
    const head = repo.change({ 'src/lib.rs': `pub fn check(_x: i32) {}\n${lib}` });
    assert.deepEqual((await testWeakening(head)).warnings, []);
  });
});

test('Commented-out Rust tests are removed tests', async t => {
  await t.test('line comments', async s => {
    const repo = repository(s, { 'src/lib.rs': lib });
    const head = repo.change({
      'src/lib.rs': lib.replace(
        '    #[test]\n    fn adds_negative() {',
        '    // #[test]\n    // fn adds_negative() {}\n    fn adds_negative_off() {',
      ),
    });
    assert.deepEqual(await weakened(head), ['tests_removed:src/lib.rs']);
  });
  await t.test('nested block comments and doc comments', async s => {
    const repo = repository(s, { 'src/lib.rs': lib });
    const nested = lib.replace(
      '    #[test]\n    fn adds_negative() {\n        assert_eq!(add(-1, -1), -2);\n    }\n',
      '    /* outer /* inner */\n    #[test]\n    fn adds_negative() {\n        assert_eq!(add(-1, -1), -2);\n    }\n    */\n' +
        '    /// #[test]\n    /// fn adds_negative() {}\n    //! #[test] fn adds_negative() {}\n',
    );
    assert.deepEqual(await weakened(repo.change({ 'src/lib.rs': nested })), ['tests_removed:src/lib.rs']);
  });
  await t.test('a test after a nested block comment is still read', async s => {
    const kept = lib.replace('#[cfg(test)]', '/* a /* nested */ note */\n#[cfg(test)]');
    const repo = repository(s, { 'src/lib.rs': lib });
    assert.deepEqual(await weakened(repo.change({ 'src/lib.rs': kept })), []);
  });
});

test('Rust tests quoted in strings are not tests; literals do not derail the lexer', async t => {
  await t.test('raw strings with any number of #', async s => {
    const repo = repository(s, { 'src/lib.rs': lib });
    const head = repo.change({
      'src/lib.rs': withoutNegative.replace(
        'mod tests {\n',
        'mod tests {\n    const FIXTURE: &str = r##"\n    #[test]\n    fn adds_negative() { "# }\n    "##;\n' +
          '    const OTHER: &[u8] = br#"#[test] fn adds_negative() {}"#;\n',
      ),
    });
    assert.deepEqual(await weakened(head), ['tests_removed:src/lib.rs']);
  });
  await t.test('plain, byte and C strings over several lines', async s => {
    const repo = repository(s, { 'src/lib.rs': lib });
    const head = repo.change({
      'src/lib.rs': withoutNegative.replace(
        'mod tests {\n',
        'mod tests {\n    const A: &str = "\n    #[test]\n    fn adds_negative() {}\n    \\" still a string";\n' +
          '    const B: &[u8] = b"#[test] fn adds_negative() {}";\n    const C: &core::ffi::CStr = c"#[test]\nfn adds_negative() {}";\n',
      ),
    });
    assert.deepEqual(await weakened(head), ['tests_removed:src/lib.rs']);
  });
  await t.test('character literals and lifetimes', async s => {
    const tricky =
      "pub fn first<'a>(text: &'a str) -> &'a str {\n    let quote = '\"';\n    let escaped = '\\'';\n" +
      "    let brace = '{';\n    let byte = b'\"';\n    let unicode = '\\u{1F600}';\n    'outer: loop {\n        break 'outer;\n    }\n" +
      '    let _ = (quote, escaped, brace, byte, unicode);\n    text\n}\n' +
      lib.replace('pub fn add', 'pub fn add_unused');
    const repo = repository(s, { 'src/lib.rs': tricky });
    assert.deepEqual(
      rustTestCases('src/lib.rs', tricky).map(item => item.name),
      ['tests::adds', 'tests::adds_negative'],
    );
    const head = repo.change({ 'src/lib.rs': tricky.replace('fn adds_negative()', 'fn adds_negative_renamed()') });
    assert.deepEqual(await weakened(head), ['tests_removed:src/lib.rs']);
  });
});

test('A changed or new Rust test without a real assertion is weak_or_empty_test', async t => {
  const changed = async (s, body) => {
    const repo = repository(s, { 'src/lib.rs': lib });
    const head = repo.change({
      'src/lib.rs': lib.replace('        assert_eq!(add(-1, -1), -2);\n', body),
    });
    return testWeakening(head);
  };
  for (const [label, body] of [
    ['an emptied body', ''],
    ['a body of comments', '        // TODO: assert_eq!(add(-1, -1), -2);\n'],
    ['assert!(true)', '        assert!(true);\n'],
    ['the same value on both sides', '        assert_eq!(add(-1, -1), add(-1, -1));\n'],
    ['an early return', '        return;\n        assert_eq!(add(-1, -1), -2);\n'],
    ['a computation that checks nothing', '        let _ = add(-1, -1);\n'],
  ])
    await t.test(label, async s => {
      const { findings } = await changed(s, body);
      assert.deepEqual(rules(findings), ['weak_or_empty_test:src/lib.rs']);
      assert.match(findings[0].detail, /"tests::adds_negative"/);
    });
  for (const [label, body] of [
    ['a stronger assertion', '        assert_eq!(add(-1, -1), -2);\n        assert_ne!(add(-1, 1), 1);\n'],
    ['unwrap on the checked call', '        "-2".parse::<i32>().unwrap();\n'],
    ['the ? operator', '        let n: i32 = "-2".parse()?;\n        let _ = n;\n'],
    ['panic! on a mismatch', '        if add(-1, -1) != -2 {\n            panic!("wrong");\n        }\n'],
    ['a project assertion helper', '        assert_close(add(-1, -1) as f32, -2.0);\n'],
    [
      'a conditional return before the assertion',
      '        if skip() {\n            return;\n        }\n        assert_eq!(add(-1, -1), -2);\n',
    ],
  ])
    await t.test(`passes: ${label}`, async s => {
      assert.deepEqual(rules((await changed(s, body)).findings), []);
    });
  await t.test('#[should_panic] is an assertion', async s => {
    const repo = repository(s, { 'src/lib.rs': lib });
    const head = repo.change({
      'src/lib.rs': lib.replace(
        '    #[test]\n    fn adds_negative() {\n        assert_eq!(add(-1, -1), -2);\n',
        '    #[test]\n    #[should_panic(expected = "overflow")]\n    fn adds_negative() {\n        add(i32::MAX, 1);\n',
      ),
    });
    assert.deepEqual(await weakened(head), []);
  });
  await t.test('a new empty test is weak; an old empty test in a changed file is left alone', async s => {
    const old = lib.replace('        assert_eq!(add(-1, -1), -2);\n', '');
    const repo = repository(s, { 'src/lib.rs': old });
    assert.deepEqual(await weakened(repo.change({ 'src/lib.rs': old.replace('    a + b\n', '    b + a\n') })), []);
    const added = repo.change({
      'src/lib.rs': old.replace(
        'mod tests {\n',
        'mod tests {\n    #[test]\n    fn fresh() {\n        assert!(true);\n    }\n',
      ),
    });
    const { findings } = await testWeakening(added);
    assert.deepEqual(rules(findings), ['weak_or_empty_test:src/lib.rs']);
    assert.match(findings[0].detail, /"tests::fresh"/);
    assert.doesNotMatch(findings[0].detail, /adds_negative/);
  });
  await t.test('a permission to remove tests does not allow a fake one', async s => {
    const repo = repository(s, { 'src/lib.rs': lib });
    const head = repo.change({ 'src/lib.rs': lib.replace('        assert_eq!(add(-1, -1), -2);\n', '') });
    const result = await testWeakening({ ...head, allowed: ['src/**'] });
    assert.deepEqual(rules(result.findings), ['weak_or_empty_test:src/lib.rs']);
  });
});

test('Rust lexing stays linear on hostile input', async t => {
  const size = 200000;
  const files = {
    'src/attrs.rs': `#[test]\nfn kept() { assert!(ok()); }\n${'#[allow(unused)]\n'.repeat(size / 17)}`,
    'src/open.rs': `#[test]\nfn kept() { assert!(ok()); }\n${'#['.repeat(size / 2)}`,
    'src/raw.rs': `#[test]\nfn kept() { assert!(ok()); }\n${'r#'.repeat(size / 2)}`,
    'src/quotes.rs': `#[test]\nfn kept() { assert!(ok()); }\n${"'\\".repeat(size / 2)}`,
    'src/comments.rs': `#[test]\nfn kept() { assert!(ok()); }\n${'/*'.repeat(size / 2)}`,
    'src/fns.rs': `#[test]\nfn kept() { assert!(ok()); }\n${'#[test] fn x('.repeat(size / 13)}`,
  };
  const repo = repository(t, files);
  const head = repo.change(Object.fromEntries(Object.entries(files).map(([name, text]) => [name, `${text}\n`])));
  const started = performance.now();
  await testWeakening(head);
  const elapsed = performance.now() - started;
  assert.ok(elapsed < 10000, `scanned in ${Math.round(elapsed)} ms`);
});

const cargoToml = '[package]\nname = "game"\nversion = "0.1.0"\nedition = "2021"\n';
/**
 * A fake `cargo`: `cargo --version` answers, and `cargo test … -- --list` prints the
 * `cargo.list` file of the checkout it runs in, so the base and the head can differ.
 */
function fakeCargo(calls, { missing = false, failIn = null } = {}) {
  return async (command, args, options) => {
    calls.push({ command, args, cwd: options.cwd, target: options.env?.CARGO_TARGET_DIR });
    if (command !== 'cargo') return { code: 0, stdout: '', stderr: '' };
    if (missing) throw Object.assign(new Error('not found'), { code: 'ENOENT' });
    if (args[0] === '--version') return { code: 0, stdout: 'cargo 1.83.0\n', stderr: '' };
    const list = readFileSync(path.join(options.cwd, 'cargo.list'), 'utf8');
    if (failIn && list.includes(failIn)) return { code: 101, stdout: '', stderr: 'error[E0425]: cannot find value' };
    return { code: 0, stdout: list, stderr: '     Running unittests src/lib.rs (target/debug/deps/game-1)\n' };
  };
}
const listing = (...names) =>
  `${names.map(name => `${name}: test`).join('\n')}\n\n${names.length} tests, 0 benchmarks\n`;

test('The test registry from `cargo test -- --list` is compared on the base and the head', async t => {
  const files = {
    'Cargo.toml': cargoToml,
    'src/lib.rs': lib,
    'src/generated.rs':
      'macro_rules! cases { ($($n:ident),*) => { $( #[test] fn $n() { assert!(true); } )* } }\ncases!(gen_a, gen_b);\n',
  };
  const baseList = listing('tests::adds', 'tests::adds_negative', 'generated::gen_a', 'generated::gen_b');
  await t.test('a test only cargo sees (macro-generated) disappears: test_deleted', async s => {
    const repo = repository(s, { ...files, 'cargo.list': `${baseList}src/lib.rs - add (line 3): test\n` });
    const head = repo.change({
      'src/generated.rs': files['src/generated.rs'].replace('gen_a, gen_b', 'gen_a'),
      // Doc tests carry line numbers, which move with any edit above them: they are not compared.
      'cargo.list': `${listing('tests::adds', 'tests::adds_negative', 'generated::gen_a')}src/lib.rs - add (line 9): test\n`,
    });
    const calls = [];
    const receipt = await runBehaviorGate({ ...head, config: {}, runner: fakeCargo(calls) });
    assert.deepEqual(rules(receipt.findings), ['test_deleted:null']);
    assert.match(receipt.findings[0].detail, /cargo test -- --list.*"generated::gen_b"/);
    assert.deepEqual(receipt.testRegistry, { status: 'compared', base: 4, head: 3 });
    const listed = calls.filter(call => call.command === 'cargo' && call.args[0] === 'test');
    assert.equal(listed.length, 2);
    assert.deepEqual(listed[0].args, ['test', '--workspace', '--tests', '--', '--list']);
    const baseCall = listed.find(call => call.cwd !== repo.cwd);
    assert.ok(baseCall, 'the base is listed in its own checkout');
    assert.equal(baseCall.target, path.join(repo.cwd, 'target'), 'the base build shares the target directory');
    assert.equal(existsSync(baseCall.cwd), false, 'the base checkout is removed');
    assert.equal(repo.git('worktree', 'list', '--porcelain').match(/^worktree /gm).length, 1);
  });
  await t.test('a removal the static reading already reported is not reported twice', async s => {
    const repo = repository(s, { ...files, 'cargo.list': baseList });
    const head = repo.change({
      'src/lib.rs': withoutNegative,
      'cargo.list': listing('tests::adds', 'generated::gen_a', 'generated::gen_b'),
    });
    const receipt = await runBehaviorGate({ ...head, config: {}, runner: fakeCargo([]) });
    assert.deepEqual(rules(receipt.findings), ['tests_removed:src/lib.rs']);
  });
  await t.test('a removal allowed for its file is allowed in the registry too', async s => {
    const repo = repository(s, { ...files, 'cargo.list': baseList });
    const head = repo.change({
      'src/lib.rs': withoutNegative,
      'cargo.list': listing('tests::adds', 'generated::gen_a', 'generated::gen_b'),
    });
    const receipt = await runBehaviorGate({
      ...head,
      config: { verification: { testRemovalAllowed: ['src/lib.rs'] } },
      runner: fakeCargo([]),
    });
    assert.deepEqual(rules(receipt.findings), []);
    assert.deepEqual(rules(receipt.allowed), ['tests_removed:src/lib.rs']);
  });
  await t.test('an honest change keeps every name and passes', async s => {
    const repo = repository(s, { ...files, 'cargo.list': baseList });
    const head = repo.change({
      'src/lib.rs': lib.replace('    a + b\n', '    b + a\n'),
      'cargo.list': listing(
        'tests::adds',
        'tests::adds_negative',
        'generated::gen_a',
        'generated::gen_b',
        'tests::new_one',
      ),
    });
    const receipt = await runBehaviorGate({ ...head, config: {}, runner: fakeCargo([]) });
    assert.deepEqual([receipt.findings, receipt.passed], [[], true]);
    assert.deepEqual(receipt.testRegistry, { status: 'compared', base: 4, head: 5 });
  });
  await t.test('without cargo, or when a build fails, the registry is unchecked, not a pass or a failure', async s => {
    const repo = repository(s, { ...files, 'cargo.list': baseList });
    const head = repo.change({
      'src/lib.rs': lib.replace('    a + b\n', '    b + a\n'),
      'cargo.list': `${baseList}broken\n`,
    });
    const missing = await runBehaviorGate({ ...head, config: {}, runner: fakeCargo([], { missing: true }) });
    assert.deepEqual(
      [missing.findings, missing.testRegistry],
      [[], { status: 'unavailable', reason: 'cargo_unavailable' }],
    );
    assert.deepEqual(missing.unchecked, [{ file: null, reason: 'test_registry: cargo_unavailable' }]);
    const failed = await runBehaviorGate({ ...head, config: {}, runner: fakeCargo([], { failIn: 'broken' }) });
    assert.deepEqual([failed.findings, failed.testRegistry], [[], { status: 'failed', reason: 'head_exit_101' }]);
    assert.deepEqual(failed.unchecked, [{ file: null, reason: 'test_registry: head_exit_101' }]);
  });
  await t.test('not a Rust change, or switched off: cargo is not called', async s => {
    const repo = repository(s, { ...files, 'cargo.list': baseList });
    const calls = [];
    const docs = await runBehaviorGate({
      ...repo.change({ 'README.md': '# game!\n' }),
      config: {},
      runner: fakeCargo(calls),
    });
    assert.equal(docs.testRegistry, undefined);
    const off = await runBehaviorGate({
      ...repo.change({ 'src/lib.rs': withoutNegative }),
      config: { verification: { testRegistry: false } },
      runner: fakeCargo(calls),
    });
    assert.equal(off.testRegistry, undefined);
    assert.deepEqual(calls, []);
    assert.equal(normalizeVerificationConfig({ testRegistry: false }).testRegistry, false);
    assert.throws(() => normalizeVerificationConfig({ testRegistry: 'yes' }), /testRegistry must be boolean/);
  });
});

/** The oracle templates as the docs give them: they are kept valid by this test. */
function documentedTemplates() {
  const docs = readFileSync(new URL('../docs/VERIFICATION.md', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
  const block = [...docs.matchAll(/```json\n([\s\S]*?)\n```/g)].find(match => match[1].includes('"headless-smoke"'));
  assert.ok(block, 'docs/VERIFICATION.md has the oracle templates');
  return JSON.parse(block[1]);
}

test('Oracle templates for large projects: property, performance budget, headless smoke', async t => {
  const templates = documentedTemplates();
  const verification = normalizeVerificationConfig(templates.verification);
  assert.deepEqual(
    verification.oracles.map(oracle => oracle.id),
    ['contract-properties', 'frame-budget', 'headless-smoke'],
  );
  const outputs = {
    'contract-properties': { code: 0, stdout: 'test result: ok. 12 passed; 0 failed\n' },
    'frame-budget': { code: 0, stdout: 'warmup frame_ms_p95=40.0\nframe_ms_p95=12.5\npeak_rss_mb=380\n' },
    'headless-smoke': { code: 0, stdout: 'steps_completed=600\nentities=1342\n' },
  };
  const run = async (s, overrides = {}) => {
    const repo = repository(s);
    const head = repo.change({ 'README.md': '# game, changed\n' });
    const byId = { ...outputs, ...overrides };
    return runBehaviorGate({
      ...head,
      config: templates,
      runner: async (command, args) => {
        const oracle = verification.oracles.find(
          item => item.command === command && item.args.join(' ') === args.join(' '),
        );
        return { stderr: '', ...byId[oracle.id] };
      },
    });
  };
  await t.test('every budget met: the oracles pass and the receipt shows the measured values', async s => {
    const receipt = await run(s);
    assert.deepEqual([receipt.findings, receipt.passed], [[], true]);
    assert.deepEqual(
      receipt.oracles.find(oracle => oracle.id === 'frame-budget').budgets.map(budget => [budget.value, budget.status]),
      [
        [12.5, 'met'],
        [380, 'met'],
      ],
      'the last value printed is the one judged',
    );
  });
  await t.test('a budget exceeded fails the oracle even with exit code 0', async s => {
    const receipt = await run(s, { 'frame-budget': { code: 0, stdout: 'frame_ms_p95=21.3\npeak_rss_mb=380\n' } });
    assert.deepEqual(rules(receipt.findings), ['oracle_failed:null']);
    assert.match(receipt.findings[0].detail, /frame-budget: frame_ms_p95=\(\[0-9\.\]\+\) = 21\.3, above max 16\.6/);
    const oracle = receipt.oracles.find(item => item.id === 'frame-budget');
    assert.deepEqual([oracle.status, oracle.reason], ['failed', 'budget_exceeded']);
  });
  await t.test('a smoke run that produced nothing fails: no number is not a pass', async s => {
    const receipt = await run(s, { 'headless-smoke': { code: 0, stdout: 'steps_completed=600\nentities=0\n' } });
    assert.match(receipt.findings[0].detail, /entities=\(\[0-9\]\+\) = 0, below min 1/);
    const silent = await run(s, { 'headless-smoke': { code: 0, stdout: 'done\n' } });
    const oracle = silent.oracles.find(item => item.id === 'headless-smoke');
    assert.deepEqual([oracle.status, oracle.reason], ['failed', 'budget_metric_missing']);
    assert.match(silent.findings[0].detail, /not found in the output/);
  });
  await t.test('a crashed oracle is judged by its exit code; its budgets are not read', async s => {
    const receipt = await run(s, { 'frame-budget': { code: 101, stdout: 'frame_ms_p95=1\npeak_rss_mb=1\n' } });
    const oracle = receipt.oracles.find(item => item.id === 'frame-budget');
    assert.deepEqual([oracle.status, oracle.exitCode, oracle.budgets], ['failed', 101, undefined]);
  });
  await t.test('budgets are validated with the configuration', () => {
    const base = { id: 'perf', command: 'cargo', protect: ['bench/**'] };
    for (const [budgets, message] of [
      [[], /budgets must be a list of 1 to 8/],
      [[{ metric: 'frame=\d+', max: 1 }], /capture the number in a group/],
      [[{ metric: 'frame=(', max: 1 }], /not a regular expression/],
      [[{ metric: 'frame=(\d+)' }], /needs max or min/],
      [[{ metric: 'frame=(\d+)', min: 2, max: 1 }], /min is above max/],
      [[{ metric: 'frame=(\d+)', max: '16' }], /max must be a number/],
      [[{ metric: 'frame=(\d+)', max: 1, unit: 'ms' }], /unknown oracle perf budget key unit/],
    ])
      assert.throws(() => normalizeVerificationConfig({ oracles: [{ ...base, budgets }] }), message);
    // An oracle without budgets keeps its old normalized form.
    assert.deepEqual(Object.keys(normalizeVerificationConfig({ oracles: [base] }).oracles[0]), [
      'id',
      'command',
      'args',
      'protect',
    ]);
  });
});
