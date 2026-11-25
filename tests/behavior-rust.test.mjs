import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  BEHAVIOR_GATE_VERSION,
  isCurrentBehaviorReceipt,
  normalizeVerificationConfig,
  runBehaviorGate,
  rustTestCases,
  testWeakening,
  verificationConfigHash,
} from '../runtime/behavior-gate.mjs';
import { strictlyInside, withBaseLock } from '../runtime/behavior-rust.mjs';

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
const names = (file, source, options) => rustTestCases(file, source, options).map(item => item.name);

const lib =
  'pub fn add(a: i32, b: i32) -> i32 {\n    a + b\n}\n\n' +
  '#[cfg(test)]\nmod tests {\n    use super::*;\n\n' +
  '    #[test]\n    fn adds() {\n        assert_eq!(add(1, 1), 2);\n    }\n\n' +
  '    #[test]\n    fn adds_negative() {\n        assert_eq!(add(-1, -1), -2);\n    }\n}\n';
const withoutNegative = lib.replace(
  '\n    #[test]\n    fn adds_negative() {\n        assert_eq!(add(-1, -1), -2);\n    }\n',
  '',
);

test('Rust test names follow libtest: crate-relative module path and function', () => {
  assert.deepEqual(names('src/lib.rs', lib), ['tests::adds', 'tests::adds_negative']);
  assert.deepEqual(names('src/main.rs', lib), ['tests::adds', 'tests::adds_negative']);
  assert.deepEqual(names('crates/engine/src/world/chunk.rs', lib), [
    'world::chunk::tests::adds',
    'world::chunk::tests::adds_negative',
  ]);
  assert.deepEqual(names('src/world/mod.rs', lib), ['world::tests::adds', 'world::tests::adds_negative']);
  assert.deepEqual(names('src/bin/server.rs', lib), ['tests::adds', 'tests::adds_negative']);
  assert.deepEqual(names('src/bin/server/net.rs', lib), ['net::tests::adds', 'net::tests::adds_negative']);
  const falls = '#[test]\nfn falls() {\n    assert!(fall() > 0);\n}\n';
  // An integration test file, and `tests/<dir>/main.rs`, are crates of their own.
  assert.deepEqual(names('tests/physics.rs', falls), ['falls']);
  assert.deepEqual(names('tests/multi/main.rs', falls), ['falls']);
  // A file next to `tests/multi/main.rs` is a module of that crate (as Cargo 1.96 prints `helper::in_helper`).
  assert.deepEqual(names('tests/multi/helper.rs', falls, { nestedCrate: true }), ['helper::falls']);
  // Without a `main.rs` there, a directory under `tests/` is a shared module.
  assert.deepEqual(names('tests/common/mod.rs', 'mod inner {\n    #[test]\n    fn shared() { check(); }\n}\n'), [
    'common::inner::shared',
  ]);
});

test('Rust test attributes and identifiers are read as tokens', () => {
  const attributes =
    '#[tokio::test]\nasync fn ticks() { assert!(tick().await); }\n' +
    '#[tokio::test(flavor = "multi_thread", worker_threads = 2)]\nasync fn ticks_many() { assert!(tick().await); }\n' +
    '#[::tokio::test]\nasync fn rooted() { assert!(tick().await); }\n' +
    '# [ test ]\nfn spaced() { assert!(one()); }\n' +
    '#[test]\n# [ ignore ]\nfn spaced_ignore() { assert!(slow()); }\n' +
    '#[test]\n#[ignore = "slow"]\nfn slow() { assert!(slow()); }\n' +
    '#[test_case(1)]\nfn generated(x: i32) { assert!(x > 0); }\n' +
    '#[cfg_attr(not(feature = "gpu"), ignore)]\n#[test]\nfn gpu() { assert!(gpu()); }\n' +
    '#[cfg_attr(any(), ignore)]\n#[test]\nfn never_ignored() { assert!(one()); }\n' +
    '#[cfg_attr(test, ignore)]\n#[test]\nfn ignored_in_tests() { assert!(one()); }\n' +
    '#[cfg_attr(test, cfg_attr(test, ignore))]\n#[test]\nfn nested_ignore() { assert!(one()); }\n' +
    '#[cfg_attr(test, test)]\nfn test_through_cfg_attr() { assert!(one()); }\n' +
    '#[test] pub(crate) fn one_line() { assert!(one()); }\n';
  assert.deepEqual(rustTestCases('tests/runtime.rs', attributes), [
    { name: 'ticks', skipped: false },
    { name: 'ticks_many', skipped: false },
    { name: 'rooted', skipped: false },
    { name: 'spaced', skipped: false },
    { name: 'spaced_ignore', skipped: true },
    { name: 'slow', skipped: true },
    // A feature is not the reading's to judge: the registry of a full gate sees `--ignored`.
    { name: 'gpu', skipped: false },
    { name: 'never_ignored', skipped: false },
    { name: 'ignored_in_tests', skipped: true },
    { name: 'nested_ignore', skipped: true },
    { name: 'test_through_cfg_attr', skipped: false },
    { name: 'one_line', skipped: false },
  ]);
  // Raw and Unicode identifiers as libtest prints them (checked against Cargo 1.96).
  const raw =
    'mod tests {\n    #[test] fn r#type() { assert!(one()); }\n    #[test] fn проверка() { assert!(one()); }\n' +
    '    mod r#mod { #[test] fn inner() { assert!(one()); } }\n    #[test] fn r#return() { assert!(one()); }\n' +
    '    #[test] fn after_raw_fn() { let r#fn = 1; assert_eq!(r#fn, 1); }\n}\n';
  assert.deepEqual(names('src/lib.rs', raw), [
    'tests::r#type',
    'tests::проверка',
    'tests::r#mod::inner',
    'tests::r#return',
    'tests::after_raw_fn',
  ]);
  // A `{` in the return type is not the body; a character outside the BMP is a literal.
  const typed =
    "const SMILE: char = '😀';\n#[test]\nfn generic() -> Result<[u8; { 1 + 1 }], ()> { assert!(one()); Ok([0; 2]) }\n" +
    '#[test]\nfn after() { assert!(one()); }\n';
  assert.deepEqual(names('tests/typed.rs', typed), ['generic', 'after']);
});

test('A macro_rules! body is a template, not tests', () => {
  const source =
    'macro_rules! cases {\n    ($name:ident) => {\n        #[test]\n        fn literal_in_macro() { assert!(true); }\n' +
    '        #[test]\n        fn $name() { assert!(one()); }\n    };\n}\ncases!(gen_a);\n#[test]\nfn real() { assert!(one()); }\n';
  assert.deepEqual(names('tests/macros.rs', source), ['real']);
});

test('A changed macro_rules! template the package calls is checked for tests that cannot fail', async t => {
  const template = body =>
    `#[macro_export]\nmacro_rules! cases {\n    ($($n:ident),*) => { $(\n        #[test]\n        fn $n() {${body}}\n    )* };\n}\n`;
  const real = '\n            assert_eq!(crate::add(1, 1), 2);\n        ';
  const callers = {
    'src/lib.rs': 'pub fn add(a: i32, b: i32) -> i32 { a + b }\n#[macro_use]\nmod generated;\nmod checks;\n',
  };
  await t.test('emptied in the template, called from an unchanged file', async s => {
    const repo = repository(s, {
      ...callers,
      'src/generated.rs': template(real),
      'src/checks.rs': 'cases!(gen_a, gen_b);\n',
    });
    const { findings } = await testWeakening(repo.change({ 'src/generated.rs': template(' ') }));
    assert.deepEqual(rules(findings), ['weak_or_empty_test:src/generated.rs']);
    assert.match(findings[0].detail, /cases!: fn \$n \(empty body\)/);
  });
  await t.test('an unused template defines no test', async s => {
    const repo = repository(s, { ...callers, 'src/generated.rs': template(real), 'src/checks.rs': '// nothing\n' });
    assert.deepEqual(await weakened(repo.change({ 'src/generated.rs': template(' ') })), []);
  });
  await t.test('an unchanged weak template is old code', async s => {
    const repo = repository(s, { ...callers, 'src/generated.rs': template(' '), 'src/checks.rs': 'cases!(gen_a);\n' });
    assert.deepEqual(await weakened(repo.change({ 'src/generated.rs': `// touched\n${template(' ')}` })), []);
  });
});

test('Rust tests of two crates with one name are two tests', async t => {
  const one = '#[cfg(test)]\nmod tests {\n    #[test]\n    fn adds() {\n        assert!(crate::ok());\n    }\n}\n';
  const repo = repository(t, { 'crates/a/src/lib.rs': one, 'crates/b/src/lib.rs': 'pub fn ok() -> bool { true }\n' });
  // Crate a loses `tests::adds`, crate b gains a test of that name: not a move.
  const head = repo.change({ 'crates/a/src/lib.rs': 'pub fn ok() -> bool { true }\n', 'crates/b/src/lib.rs': one });
  const { findings } = await testWeakening(head);
  assert.deepEqual(rules(findings), ['tests_removed:crates/a/src/lib.rs']);
  assert.match(findings[0].detail, /"crates\/a: tests::adds"/);
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
  await t.test('a test removed from a module next to tests/<dir>/main.rs keeps the crate-relative name', async s => {
    const helper = '#[test]\nfn in_helper() {\n    assert!(one());\n}\n#[test]\nfn other() {\n    assert!(one());\n}\n';
    const repo = repository(s, { 'tests/multi/main.rs': 'mod helper;\n', 'tests/multi/helper.rs': helper });
    const { findings } = await testWeakening(
      repo.change({ 'tests/multi/helper.rs': helper.replace(/#\[test\]\nfn other[\s\S]*$/, '') }),
    );
    assert.deepEqual(rules(findings), ['tests_removed:tests/multi/helper.rs']);
    assert.match(findings[0].detail, /"test multi: helper::other"/);
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

test('A cfg provably false in a test build switches an existing test off; unknown flags are left to the registry', async t => {
  const on = (s, edited) => {
    const repo = repository(s, { 'src/lib.rs': lib });
    return weakened(repo.change({ 'src/lib.rs': edited }));
  };
  for (const [label, edited] of [
    [
      '#[cfg(any())] on the test',
      lib.replace('    #[test]\n    fn adds()', '    #[cfg(any())]\n    #[test]\n    fn adds()'),
    ],
    ['#[cfg(false)] on the module', lib.replace('#[cfg(test)]\nmod tests', '#[cfg(false)]\nmod tests')],
    [
      '#[cfg(not(true))] on the test',
      lib.replace('    #[test]\n    fn adds()', '    #[cfg(not(true))]\n    #[test]\n    fn adds()'),
    ],
    [
      '#[cfg(not(all()))] on the test',
      lib.replace('    #[test]\n    fn adds()', '    #[cfg(not(all()))]\n    #[test]\n    fn adds()'),
    ],
    [
      '#[cfg_attr(test, cfg(any()))] on the test',
      lib.replace('    #[test]\n    fn adds()', '    #[cfg_attr(test, cfg(any()))]\n    #[test]\n    fn adds()'),
    ],
    [
      '#[cfg_attr(test, ignore)] on the test',
      lib.replace('    #[test]\n    fn adds()', '    #[test]\n    #[cfg_attr(test, ignore)]\n    fn adds()'),
    ],
    [
      'a nested cfg_attr(test, cfg_attr(test, ignore))',
      lib.replace(
        '    #[test]\n    fn adds()',
        '    #[test]\n    #[cfg_attr(test, cfg_attr(test, ignore))]\n    fn adds()',
      ),
    ],
    ['#[cfg(not(test))] on the module', lib.replace('#[cfg(test)]\nmod tests', '#[cfg(not(test))]\nmod tests')],
    ['#![cfg(any())] in the module', lib.replace('mod tests {\n', 'mod tests {\n    #![cfg(any())]\n')],
    ['#![cfg(all(test, any()))] on the file', `#![cfg(all(test, any()))]\n${lib}`],
    ['a spaced # [ignore]', lib.replace('    #[test]\n    fn adds()', '    #[test]\n    # [ ignore ]\n    fn adds()')],
  ])
    await t.test(label, async s => assert.deepEqual(await on(s, edited), ['test_skipped:src/lib.rs']));
  for (const [label, edited] of [
    [
      'cfg_attr(<false>, ignore) is no ignore',
      lib.replace('    #[test]\n    fn adds()', '    #[test]\n    #[cfg_attr(any(), ignore)]\n    fn adds()'),
    ],
    ['#[cfg(FALSE)]: an unknown flag', lib.replace('#[cfg(test)]\nmod tests', '#[cfg(FALSE)]\nmod tests')],
    [
      'cfg_attr(<platform>, ignore)',
      lib.replace('    #[test]\n    fn adds()', '    #[test]\n    #[cfg_attr(windows, ignore)]\n    fn adds()'),
    ],
    [
      'a cfg that depends on a feature is left to the registry',
      lib.replace('    #[test]\n    fn adds()', '    #[cfg(feature = "simd")]\n    #[test]\n    fn adds()'),
    ],
  ])
    await t.test(`passes: ${label}`, async s => assert.deepEqual(await on(s, edited), []));
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
  await t.test('character literals, lifetimes and characters outside the BMP', async s => {
    const tricky =
      "pub fn first<'a>(text: &'a str) -> &'a str {\n    let quote = '\"';\n    let escaped = '\\'';\n" +
      "    let brace = '{';\n    let byte = b'\"';\n    let unicode = '\\u{1F600}';\n    let smile = '😀';\n" +
      "    'outer: loop {\n        break 'outer;\n    }\n" +
      '    let _ = (quote, escaped, brace, byte, unicode, smile);\n    text\n}\n' +
      lib.replace('pub fn add', 'pub fn add_unused');
    const repo = repository(s, { 'src/lib.rs': tricky });
    assert.deepEqual(names('src/lib.rs', tricky), ['tests::adds', 'tests::adds_negative']);
    const head = repo.change({ 'src/lib.rs': tricky.replace('fn adds_negative()', 'fn adds_negative_renamed()') });
    assert.deepEqual(await weakened(head), ['tests_removed:src/lib.rs']);
  });
});

/** `lib` with the body of `adds_negative` replaced. */
const negativeBody = body => lib.replace('        assert_eq!(add(-1, -1), -2);\n', body);

test('weak_or_empty_test refuses only tests that cannot fail', async t => {
  const changed = async (s, body) => {
    const repo = repository(s, { 'src/lib.rs': lib });
    return testWeakening(repo.change({ 'src/lib.rs': negativeBody(body) }));
  };
  for (const [label, body] of [
    ['an emptied body', ''],
    ['a body of comments', '        // TODO: assert_eq!(add(-1, -1), -2);\n'],
    ['assert!(true)', '        assert!(true);\n'],
    ['assert![true] and assert!{true}', '        assert![true];\n        debug_assert!{ true }\n'],
    ['assert!(!false) with a message', '        assert!(!false, "always");\n'],
    [
      'the same literal on both sides',
      '        assert_eq!(-2, -2);\n        assert_eq!("x", ("x"));\n        assert!(\'c\' == \'c\');\n        assert_eq!(true, true);\n',
    ],
    [
      'std::assert! and core::assert! with extra parentheses',
      '        std::assert!((true));\n        ::core::assert!(!(false));\n',
    ],
    ['std::assert! { true } as a block statement', '        std::assert! { true }\n        assert!(true);\n'],
    ['a return before the first statement', '        return;\n        assert_eq!(add(-1, -1), -2);\n'],
    ['return ()', '        return ();\n'],
    ['return Ok(())', '        return Ok(());\n        assert_eq!(add(-1, -1), -2);\n'],
    [
      'a return in the else branch of if false',
      '        if false {\n            assert_eq!(add(-1, -1), -2);\n        } else {\n            return;\n        }\n        assert_eq!(add(-1, -1), -2);\n',
    ],
    ['a return in a block', '        {\n            return;\n        }\n        assert_eq!(add(-1, -1), -2);\n'],
    [
      'a return under if true',
      '        if true {\n            return;\n        }\n        assert_eq!(add(-1, -1), -2);\n',
    ],
    ['a dead if false block', '        if false {\n            assert_eq!(add(-1, -1), -2);\n        }\n'],
    ['a closure nobody calls', '        let check = || assert_eq!(add(-1, -1), -2);\n'],
    [
      'a ? inside a closure nobody calls',
      '        let _parse = |s: &str| -> Result<i32, std::num::ParseIntError> { Ok(s.parse::<i32>()?) };\n        assert!(true);\n',
    ],
  ])
    await t.test(label, async s => {
      const { findings } = await changed(s, body);
      assert.deepEqual(rules(findings), ['weak_or_empty_test:src/lib.rs']);
      assert.match(findings[0].detail, /"tests::adds_negative"/);
    });
  for (const [label, body] of [
    ['a stronger assertion', '        assert_eq!(add(-1, -1), -2);\n        assert_ne!(add(-1, 1), 1);\n'],
    ['different string literals are not the same value', '        assert_eq!("-2", "minus two");\n'],
    ['unwrap on the checked call', '        "-2".parse::<i32>().unwrap();\n'],
    ['the ? operator', '        let n: i32 = "-2".parse()?;\n        let _ = n;\n'],
    ['panic! on a mismatch', '        if add(-1, -1) != -2 {\n            panic!("wrong");\n        }\n'],
    ['a project assertion helper', '        assert_close(add(-1, -1) as f32, -2.0);\n'],
    ['a turbofish helper', '        assert_close::<f32>(add(-1, -1) as f32, -2.0);\n'],
    ['a call to an unknown function may check', '        let _ = add(-1, -1);\n'],
    ['the same call on both sides may differ between reads', '        assert_eq!(read(), read());\n'],
    ['the same name on both sides is not a literal (NaN != NaN)', '        assert!(EXPECTED == EXPECTED);\n'],
    ['the same path on both sides is not a literal', '        assert_eq!(f32::NAN, f32::NAN);\n'],
    ['the same call on both sides of ==', '        assert!(add(-1, -1) == add(-1, -1));\n'],
    ['a return with a call may check', '        return check_all(add(-1, -1));\n'],
    [
      'the else branch of if false runs its assertion',
      '        if false {\n            return;\n        } else {\n            assert_eq!(add(-1, -1), -2);\n        }\n',
    ],
    ['a closure that is called', '        let check = || assert_eq!(add(-1, -1), -2);\n        check();\n'],
    [
      'a conditional return before the assertion',
      '        if skip() {\n            return;\n        }\n        assert_eq!(add(-1, -1), -2);\n',
    ],
  ])
    await t.test(`passes: ${label}`, async s => {
      assert.deepEqual(rules((await changed(s, body)).findings), []);
    });
  await t.test('#[should_panic] on a body that calls code is not weak', async s => {
    const repo = repository(s, { 'src/lib.rs': lib });
    const head = repo.change({
      'src/lib.rs': lib.replace(
        '    #[test]\n    fn adds_negative() {\n        assert_eq!(add(-1, -1), -2);\n',
        '    #[test]\n    #[should_panic(expected = "overflow")]\n    fn adds_negative() {\n        add(i32::MAX, 1);\n',
      ),
    });
    assert.deepEqual(await weakened(head), []);
  });
  await t.test('a new empty test is weak; an old one is left alone, also when reformatted', async s => {
    const old = negativeBody('');
    const repo = repository(s, { 'src/lib.rs': old });
    const reformatted = old.replace('    fn adds_negative() {\n    }', '    fn adds_negative()\n    {\n    }');
    assert.deepEqual(
      await weakened(repo.change({ 'src/lib.rs': reformatted.replace('    a + b\n', '    b + a\n') })),
      [],
    );
    const added = repo.change({
      'src/lib.rs': reformatted.replace(
        'mod tests {\n',
        'mod tests {\n    #[test]\n    fn fresh() {\n        assert!(true);\n    }\n',
      ),
    });
    const { findings } = await testWeakening(added);
    assert.deepEqual(rules(findings), ['weak_or_empty_test:src/lib.rs']);
    assert.match(findings[0].detail, /"tests::fresh"/);
    assert.doesNotMatch(findings[0].detail, /adds_negative/);
  });
  await t.test('a literal changed in an old weak test is a change: its value is not blanked', async s => {
    const old = negativeBody('        assert_eq!("x", "x");\n');
    const repo = repository(s, { 'src/lib.rs': old });
    const head = repo.change({ 'src/lib.rs': old.replace('assert_eq!("x", "x")', 'assert_eq!("y", "y")') });
    assert.deepEqual(await weakened(head), ['weak_or_empty_test:src/lib.rs']);
  });
  await t.test('a namesake in another crate does not excuse an emptied test', async s => {
    const empty = negativeBody('');
    const repo = repository(s, { 'crates/a/src/lib.rs': empty, 'crates/b/src/lib.rs': lib });
    // Both files change: the old empty namesake in crate a is on the base side of the comparison.
    const head = repo.change({
      'crates/a/src/lib.rs': empty.replace('    a + b\n', '    b + a\n'),
      'crates/b/src/lib.rs': empty,
    });
    assert.deepEqual(await weakened(head), ['weak_or_empty_test:crates/b/src/lib.rs']);
  });
  await t.test('a permission to remove tests does not allow a fake one', async s => {
    const repo = repository(s, { 'src/lib.rs': lib });
    const head = repo.change({ 'src/lib.rs': negativeBody('') });
    const result = await testWeakening({ ...head, allowed: ['src/**'] });
    assert.deepEqual(rules(result.findings), ['weak_or_empty_test:src/lib.rs']);
  });
});

test('An existing test that loses #[should_panic] or changes its expectation is weakened', async t => {
  const panicking = lib.replace(
    '    #[test]\n    fn adds_negative() {\n        assert_eq!(add(-1, -1), -2);\n',
    '    #[test]\n    #[should_panic(expected = "overflow")]\n    fn adds_negative() {\n        add(i32::MAX, 1);\n',
  );
  for (const [label, edited] of [
    ['removed', panicking.replace('    #[should_panic(expected = "overflow")]\n', '')],
    ['expectation changed', panicking.replace('expected = "overflow"', 'expected = ""')],
    ['expectation dropped', panicking.replace('#[should_panic(expected = "overflow")]', '#[should_panic]')],
  ])
    await t.test(label, async s => {
      const repo = repository(s, { 'src/lib.rs': panicking });
      const { findings } = await testWeakening(repo.change({ 'src/lib.rs': edited }));
      assert.deepEqual(rules(findings), ['test_weakened:src/lib.rs']);
      assert.match(findings[0].detail, /"tests::adds_negative"/);
    });
  const throughCfgAttr = panicking.replace(
    '#[should_panic(expected = "overflow")]',
    '#[cfg_attr(test, should_panic(expected = "overflow"))]',
  );
  await t.test('cfg_attr(test, should_panic(…)) is a should_panic: removing it weakens', async s => {
    const repo = repository(s, { 'src/lib.rs': throughCfgAttr });
    const { findings } = await testWeakening(
      repo.change({
        'src/lib.rs': throughCfgAttr.replace('    #[cfg_attr(test, should_panic(expected = "overflow"))]\n', ''),
      }),
    );
    assert.deepEqual(rules(findings), ['test_weakened:src/lib.rs']);
  });
  await t.test('the same expectation through cfg_attr, or a message added to a bare one, passes', async s => {
    const repo = repository(s, { 'src/lib.rs': panicking });
    assert.deepEqual(await weakened(repo.change({ 'src/lib.rs': throughCfgAttr })), []);
    const bare = panicking.replace('#[should_panic(expected = "overflow")]', '#[should_panic]');
    const second = repository(s, { 'src/lib.rs': bare });
    assert.deepEqual(await weakened(second.change({ 'src/lib.rs': panicking })), [], 'adding expected tightens');
  });
  await t.test('added, or allowed for the file', async s => {
    const repo = repository(s, { 'src/lib.rs': lib });
    assert.deepEqual(await weakened(repo.change({ 'src/lib.rs': panicking })), []);
    const removed = repo.change({ 'src/lib.rs': lib });
    const result = await testWeakening({
      ...removed,
      baseSha: repo.git('rev-parse', 'HEAD~1'),
      allowed: ['src/lib.rs'],
    });
    assert.deepEqual([rules(result.findings), rules(result.allowed)], [[], ['test_weakened:src/lib.rs']]);
  });
});

test('Rust lexing stays linear on hostile input and still finds the real test', async t => {
  const size = 200000;
  const kept = '#[test]\nfn kept() { assert!(ok()); }\n';
  const files = {
    'src/attrs.rs': `${kept}${'#[allow(unused)]\n'.repeat(size / 17)}`,
    'src/open.rs': `${kept}${'#['.repeat(size / 2)}`,
    'src/raw.rs': `${kept}${'r#'.repeat(size / 2)}`,
    'src/quotes.rs': `${kept}${"'\\".repeat(size / 2)}`,
    'src/comments.rs': `${kept}${'/*'.repeat(size / 2)}`,
    'src/fns.rs': `${kept}${'#[test] fn x('.repeat(size / 13)}`,
    'src/nested.rs': `#[test]\nfn kept() { ${'{'.repeat(size / 4)}assert!(ok());${'}'.repeat(size / 4)} }\n`,
    'src/cfg.rs': `#[cfg(${'not('.repeat(size / 8)}test${')'.repeat(size / 8)})]\n${kept}`,
    'src/statements.rs': `#[test]\nfn kept() { ${'let _ = || {};\n'.repeat(size / 15)} assert!(ok()); }\n`,
  };
  for (const [file, source] of Object.entries(files)) {
    const started = performance.now();
    const found = names(file, source);
    assert.ok(performance.now() - started < 5000, `${file} read in ${Math.round(performance.now() - started)} ms`);
    if (file !== 'src/cfg.rs')
      assert.ok(
        found.some(name => name.endsWith('kept')),
        `${file}: ${found.slice(0, 3)}`,
      );
  }
  const repo = repository(t, files);
  const head = repo.change(Object.fromEntries(Object.entries(files).map(([name, text]) => [name, `${text}\n`])));
  const started = performance.now();
  const result = await testWeakening(head);
  assert.ok(performance.now() - started < 20000);
  assert.deepEqual(result.findings, [], 'appending a newline weakens nothing');
});

const cargoToml = '[package]\nname = "game"\nversion = "0.1.0"\nedition = "2021"\n';
/**
 * A fake Cargo. `cargo test --no-run --message-format=json` reports one test executable per
 * target listed in the checkout's `registry.json`; each executable lists its tests and, with
 * `--ignored`, its ignored tests, like libtest. `state.active`/`state.most` count base builds
 * that run at the same time.
 */
function fakeCargo(
  calls,
  { missing = false, failIn = null, version = 'cargo 1.96.0', canonicalManifest = false, state = null } = {},
) {
  const executables = new Map();
  return async (command, args, options) => {
    calls.push({ command, args, cwd: options.cwd, target: options.env?.CARGO_TARGET_DIR });
    if (command === 'cargo') {
      if (missing) throw Object.assign(new Error('not found'), { code: 'ENOENT' });
      if (args[0] === '--version') return { code: 0, stdout: `${version}\n`, stderr: '' };
      const targets = JSON.parse(readFileSync(path.join(options.cwd, 'registry.json'), 'utf8'));
      if (failIn && JSON.stringify(targets).includes(failIn))
        return { code: 101, stdout: '', stderr: 'error[E0425]: cannot find value' };
      if (state && options.env?.CARGO_TARGET_DIR) {
        state.active++;
        state.most = Math.max(state.most, state.active);
        await new Promise(resolve => setTimeout(resolve, 60));
        state.active--;
      }
      const directory = options.env?.CARGO_TARGET_DIR ?? path.join(options.cwd, 'target');
      // Cargo prints the manifest path as the file system names it.
      const root = canonicalManifest ? realpathSync.native(options.cwd) : options.cwd;
      const lines = ['{"reason":"build-script-executed","package_id":"x"}', 'not json'];
      for (const target of targets) {
        const executable = path.join(
          directory,
          'debug',
          'deps',
          `${target.package}-${target.target}-${target.kind}.exe`,
        );
        executables.set(executable, target);
        const manifest = path.join(root, target.dir ?? '', 'Cargo.toml');
        const src = path.join(root, target.dir ?? '', target.src ?? defaultRoot(target));
        lines.push(
          JSON.stringify({
            reason: 'compiler-artifact',
            package_id: `path+file:///${root.replace(/\\/g, '/')}/${target.dir ?? ''}#${target.package}@0.1.0`,
            manifest_path: manifest,
            target: { kind: [target.kind], name: target.target, src_path: src },
            profile: { test: true },
            executable,
          }),
          JSON.stringify({
            reason: 'compiler-artifact',
            package_id: `x#${target.package}@0.1.0`,
            manifest_path: manifest,
            target: { kind: [target.kind], name: target.target },
            profile: { test: false },
            executable: null,
          }),
        );
      }
      return { code: 0, stdout: `${lines.join('\n')}\n`, stderr: '   Compiling game v0.1.0\n' };
    }
    const target = executables.get(command);
    if (!target) return { code: 0, stdout: '', stderr: '' };
    const listed = args.includes('--ignored') ? (target.ignored ?? []) : target.tests;
    return { code: 0, stdout: listed.map(name => `${name}: test\n`).join(''), stderr: '' };
  };
}
/** Where Cargo puts the root of a target by default. */
const defaultRoot = target =>
  target.kind === 'lib'
    ? 'src/lib.rs'
    : target.kind === 'bin'
      ? target.target === target.package
        ? 'src/main.rs'
        : `src/bin/${target.target}.rs`
      : `${{ test: 'tests', bench: 'benches', example: 'examples' }[target.kind]}/${target.target}.rs`;
const registry = (...targets) => `${JSON.stringify(targets, null, 1)}\n`;
const libTarget = (tests, ignored = []) => ({ package: 'game', kind: 'lib', target: 'game', tests, ignored });
const baseBuilds = calls => calls.filter(call => call.command === 'cargo' && call.args[0] === 'test' && call.target);
const worktrees = repo => repo.git('worktree', 'list', '--porcelain').match(/^worktree /gm).length;

test('The test registry from libtest is compared on a full gate of a Rust project', async t => {
  const files = {
    'Cargo.toml': cargoToml,
    'src/lib.rs': lib,
    'src/generated.rs':
      'macro_rules! cases { ($($n:ident),*) => { $( #[test] fn $n() { assert!(one()); } )* } }\ncases!(gen_a, gen_b);\n',
  };
  const baseTests = ['tests::adds', 'tests::adds_negative', 'generated::gen_a', 'generated::gen_b'];
  const homes = s => {
    const home = mkdtempSync(path.join(os.tmpdir(), 'kodo-registry-home-'));
    s.after(() => rmSync(home, { recursive: true, force: true }));
    return home;
  };
  const gate = async (s, head, options = {}) =>
    runBehaviorGate({ ...head, config: {}, registry: true, registryHome: homes(s), ...options });
  await t.test(
    'a test only the registry sees disappears: test_deleted; the base has its own checkout and target',
    async s => {
      const repo = repository(s, { ...files, 'registry.json': registry(libTarget(baseTests)) });
      const head = repo.change({
        'src/generated.rs': files['src/generated.rs'].replace('gen_a, gen_b', 'gen_a'),
        'registry.json': registry(libTarget(baseTests.slice(0, 3))),
      });
      const calls = [],
        home = homes(s);
      const receipt = await runBehaviorGate({
        ...head,
        config: {},
        runner: fakeCargo(calls),
        registry: true,
        registryHome: home,
      });
      assert.deepEqual(rules(receipt.findings), ['test_deleted:null']);
      assert.match(receipt.findings[0].detail, /"game lib game: generated::gen_b"/);
      assert.deepEqual([receipt.status, receipt.testRegistry], ['failed', { status: 'compared', base: 4, head: 3 }]);
      const builds = calls.filter(call => call.command === 'cargo' && call.args[0] === 'test');
      assert.deepEqual(builds[0].args, ['test', '--workspace', '--no-run', '--message-format=json']);
      const lists = calls
        .filter(call => call.command !== 'cargo' && call.command !== 'rustc')
        .map(call => call.args.join(' '));
      assert.deepEqual([...new Set(lists)].sort(), ['--list --format terse', '--list --format terse --ignored']);
      const [base] = baseBuilds(calls);
      assert.equal(base.cwd, path.join(home, 'base-checkout'), 'the base checkout has a stable path');
      assert.equal(base.target, path.join(home, 'registry-base'), 'the base has its own target directory');
      assert.equal(builds.find(call => call.cwd === repo.cwd).target, undefined, "the head keeps the project's target");
      assert.equal(worktrees(repo), 2, 'the stable base checkout stays for the next gate');
    },
  );
  await t.test('a full gate compares whatever changed; task-fast and testRegistry: false never call Cargo', async s => {
    const repo = repository(s, { ...files, 'registry.json': registry(libTarget(baseTests)) });
    const head = repo.change({ 'README.md': '# game!\n' });
    const calls = [];
    const full = await gate(s, head, { runner: fakeCargo(calls) });
    assert.deepEqual([full.status, full.testRegistry?.status], ['passed', 'compared']);
    const before = calls.length;
    assert.ok(before > 0);
    const fast = await runBehaviorGate({ ...head, config: {}, runner: fakeCargo(calls) });
    const off = await gate(s, head, { config: { verification: { testRegistry: false } }, runner: fakeCargo(calls) });
    assert.deepEqual([fast.testRegistry, off.testRegistry, calls.length], [undefined, undefined, before]);
    assert.throws(() => normalizeVerificationConfig({ testRegistry: 'yes' }), /testRegistry must be boolean/);
  });
  await t.test('a removal the static reading already reported is not reported twice', async s => {
    const repo = repository(s, { ...files, 'registry.json': registry(libTarget(baseTests)) });
    const head = repo.change({
      'src/lib.rs': withoutNegative,
      'registry.json': registry(libTarget(baseTests.filter(name => name !== 'tests::adds_negative'))),
    });
    const receipt = await gate(s, head, { runner: fakeCargo([]) });
    assert.deepEqual(rules(receipt.findings), ['tests_removed:src/lib.rs']);
  });
  await t.test('an explanation is used once: the same name gone from two crates', async s => {
    const crates = {
      'Cargo.toml': '[workspace]\nmembers = ["crates/a", "crates/b"]\n',
      'crates/a/src/lib.rs': lib,
      'crates/b/src/lib.rs': 'pub fn b() {}\n',
    };
    const both = registry(
      { ...libTarget(['tests::adds', 'tests::adds_negative']), package: 'a', target: 'a', dir: 'crates/a' },
      { ...libTarget(['tests::adds_negative']), package: 'b', target: 'b', dir: 'crates/b' },
    );
    const repo = repository(s, { ...crates, 'registry.json': both });
    const head = repo.change({
      'crates/a/src/lib.rs': withoutNegative,
      'registry.json': registry(
        { ...libTarget(['tests::adds']), package: 'a', target: 'a', dir: 'crates/a' },
        { ...libTarget([]), package: 'b', target: 'b', dir: 'crates/b' },
      ),
    });
    const receipt = await gate(s, head, { runner: fakeCargo([]) });
    assert.deepEqual(rules(receipt.findings).sort(), ['test_deleted:null', 'tests_removed:crates/a/src/lib.rs']);
    assert.match(receipt.findings.find(item => item.file === null).detail, /"b lib b: tests::adds_negative"/);
  });
  await t.test('a permission for the file covers the registry, once per case', async s => {
    const repo = repository(s, { ...files, 'registry.json': registry(libTarget(baseTests)) });
    const head = repo.change({
      'src/lib.rs': withoutNegative,
      'registry.json': registry(libTarget(baseTests.filter(name => name !== 'tests::adds_negative'))),
    });
    const receipt = await gate(s, head, {
      config: { verification: { testRemovalAllowed: ['src/lib.rs'] } },
      runner: fakeCargo([]),
    });
    assert.deepEqual([rules(receipt.findings), rules(receipt.allowed)], [[], ['tests_removed:src/lib.rs']]);
  });
  await t.test('a permission does not cover a test still in its file on the head', async s => {
    // `#[cfg(feature = "slow")]` is unknown to the reading: only the registry sees the test go.
    const gated = lib.replace(
      '    #[test]\n    fn adds_negative()',
      '    #[cfg(feature = "slow")]\n    #[test]\n    fn adds_negative()',
    );
    const repo = repository(s, { ...files, 'registry.json': registry(libTarget(baseTests)) });
    const head = repo.change({
      'src/lib.rs': gated,
      'registry.json': registry(libTarget(baseTests.filter(name => name !== 'tests::adds_negative'))),
    });
    for (const verification of [{}, { testRemovalAllowed: ['src/lib.rs'] }]) {
      const receipt = await gate(s, head, { config: { verification }, runner: fakeCargo([]) });
      assert.deepEqual([rules(receipt.findings), receipt.allowed], [['test_deleted:null'], []]);
    }
  });
  await t.test('a permission on tests/a.rs does not cover a loss in target test b', async s => {
    const x = '#[test]\nfn x() {\n    assert!(game::one());\n}\n';
    const targets = (a, b) =>
      registry(
        { package: 'game', kind: 'test', target: 'a', tests: a },
        { package: 'game', kind: 'test', target: 'b', tests: b },
      );
    const repo = repository(s, {
      'Cargo.toml': cargoToml,
      'tests/a.rs': x,
      'tests/b.rs': x,
      'registry.json': targets(['x'], ['x']),
    });
    const head = repo.change({
      'tests/a.rs': '// x moved out\n',
      'tests/b.rs': x.replace('#[test]\n', '#[cfg(feature = "slow")]\n#[test]\n'),
      'registry.json': targets([], []),
    });
    const receipt = await gate(s, head, {
      config: { verification: { testRemovalAllowed: ['tests/a.rs'] } },
      runner: fakeCargo([]),
    });
    assert.deepEqual(rules(receipt.allowed), ['tests_removed:tests/a.rs']);
    assert.deepEqual(rules(receipt.findings), ['test_deleted:null']);
    assert.match(receipt.findings[0].detail, /"game test b: x"/);
  });
  await t.test('an #[ignore] the reading saw does not explain a test that is gone', async s => {
    const repo = repository(s, { ...files, 'registry.json': registry(libTarget(baseTests)) });
    const head = repo.change({
      'src/lib.rs': lib.replace('    #[test]\n    fn adds()', '    #[test]\n    #[ignore]\n    fn adds()'),
      'registry.json': registry(libTarget(baseTests.filter(name => name !== 'tests::adds'))),
    });
    const receipt = await gate(s, head, { runner: fakeCargo([]) });
    assert.deepEqual(rules(receipt.findings).sort(), ['test_deleted:null', 'test_skipped:src/lib.rs']);
  });
  await t.test('a test libtest lists as ignored now, unseen by the reading: test_skipped', async s => {
    const repo = repository(s, { ...files, 'registry.json': registry(libTarget(baseTests)) });
    const head = repo.change({ 'registry.json': registry(libTarget(baseTests, ['generated::gen_a'])) });
    const receipt = await gate(s, head, { runner: fakeCargo([]) });
    assert.deepEqual(rules(receipt.findings), ['test_skipped:null']);
    assert.match(receipt.findings[0].detail, /ignored now: "game lib game: generated::gen_a"/);
  });
  await t.test('without Cargo, or when a build fails, the gate is incomplete and says what to do', async s => {
    const repo = repository(s, { ...files, 'registry.json': registry(libTarget(baseTests)) });
    const head = repo.change({ 'src/lib.rs': lib.replace('    a + b\n', '    b + a\n') });
    const missing = await gate(s, head, { runner: fakeCargo([], { missing: true }) });
    assert.deepEqual(
      [missing.status, missing.passed, missing.repairable, missing.testRegistry],
      ['incomplete', false, false, { status: 'incomplete', reason: 'cargo_unavailable' }],
    );
    assert.deepEqual(rules(missing.findings), ['test_registry_incomplete:null']);
    assert.match(
      missing.findings[0].detail,
      /cargo_unavailable\. Install Cargo .*"verification": \{ "testRegistry": false \}/,
    );
    assert.equal(
      isCurrentBehaviorReceipt(missing, { headSha: head.headSha, baseSha: head.baseSha, config: {} }),
      false,
    );
    const broken = repo.change({ 'registry.json': registry(libTarget([...baseTests, 'broken'])) });
    const failed = await gate(s, broken, { runner: fakeCargo([], { failIn: 'broken' }) });
    assert.deepEqual(
      [failed.status, failed.testRegistry],
      ['incomplete', { status: 'incomplete', reason: 'head_build_exit_101' }],
    );
  });
  await t.test('a base checkout that cannot be prepared leaves the gate incomplete, not crashed', async s => {
    const repo = repository(s, { ...files, 'registry.json': registry(libTarget(baseTests)) });
    const home = path.join(homes(s), 'home-is-a-file');
    writeFileSync(home, 'a file where the registry home belongs\n');
    const head = repo.change({ 'README.md': '# game!\n' });
    const receipt = await runBehaviorGate({
      ...head,
      config: {},
      runner: fakeCargo([]),
      registry: true,
      registryHome: home,
    });
    assert.deepEqual([receipt.status, receipt.testRegistry.status], ['incomplete', 'incomplete']);
    assert.match(receipt.testRegistry.reason, /^base_checkout: /);
  });
  await t.test('a new crate has an empty base registry and is not built on the base', async s => {
    const repo = repository(s);
    const calls = [];
    const head = repo.change({ ...files, 'registry.json': registry(libTarget(baseTests)) });
    const receipt = await gate(s, head, { runner: fakeCargo(calls) });
    assert.deepEqual(
      [receipt.status, receipt.testRegistry],
      ['passed', { status: 'compared', base: 0, head: 4, baseRegistry: 'absent' }],
    );
    assert.equal(calls.filter(call => call.command === 'cargo' && call.args[0] === 'test').length, 1);
  });
  await t.test('a removed root Cargo.toml: the base registry against an empty head, with permissions', async s => {
    const crate = {
      'Cargo.toml': cargoToml,
      'src/lib.rs': lib,
      'registry.json': registry(libTarget(baseTests.slice(0, 2))),
    };
    const repo = repository(s, crate);
    const head = repo.change({}, Object.keys(crate));
    const calls = [];
    const refused = await gate(s, head, { runner: fakeCargo(calls) });
    assert.deepEqual(refused.testRegistry, { status: 'compared', base: 2, head: 0, headRegistry: 'absent' });
    assert.deepEqual(rules(refused.findings), ['test_deleted:src/lib.rs']);
    assert.equal(calls.filter(call => call.command === 'cargo' && call.args[0] === 'test').length, 1, 'only the base');
    const allowed = await gate(s, head, {
      config: { verification: { testRemovalAllowed: ['src/**'] } },
      runner: fakeCargo([]),
    });
    assert.deepEqual([rules(allowed.findings), rules(allowed.allowed)], [[], ['test_deleted:src/lib.rs']]);
  });
  await t.test('a harness = false target is tracked as a target and never run for a list', async s => {
    const manifest = `${cargoToml}\n[[test]]\nname = "smoke" # a custom harness\nharness = false\n`;
    const smoke = { package: 'game', kind: 'test', target: 'smoke', tests: ['would_run'] };
    const repo = repository(s, {
      'Cargo.toml': manifest,
      'tests/smoke.rs': 'fn main() {}\n',
      'registry.json': registry(libTarget(['tests::adds']), smoke),
    });
    const head = repo.change({ 'Cargo.toml': cargoToml, 'registry.json': registry(libTarget(['tests::adds'])) }, [
      'tests/smoke.rs',
    ]);
    const calls = [];
    const receipt = await gate(s, head, { runner: fakeCargo(calls) });
    assert.deepEqual(rules(receipt.findings), ['test_deleted:null']);
    assert.match(receipt.findings[0].detail, /"game test smoke: \(target, harness = false\)"/);
    assert.equal(
      calls.some(call => /smoke/.test(call.command)),
      false,
      'the harness-free executable is not run',
    );
    const allowed = await gate(s, head, {
      config: { verification: { testRemovalAllowed: ['tests/smoke.rs'] } },
      runner: fakeCargo([]),
    });
    assert.deepEqual([rules(allowed.findings), rules(allowed.allowed)], [[], ['test_deleted:tests/smoke.rs']]);
  });
  await t.test('the stable base checkout is reused for another base and repaired when broken', async s => {
    const repo = repository(s, { ...files, 'registry.json': registry(libTarget(baseTests)) });
    const home = homes(s);
    const first = repo.change({ 'README.md': '# one\n' });
    const second = repo.change({ 'README.md': '# two\n' });
    const run = (head, baseSha) =>
      runBehaviorGate({ ...head, baseSha, config: {}, runner: fakeCargo([]), registry: true, registryHome: home });
    assert.equal((await run(first, repo.baseSha)).testRegistry.status, 'compared');
    assert.equal((await run(second, first.headSha)).testRegistry.status, 'compared');
    assert.equal(repo.git('-C', path.join(home, 'base-checkout'), 'rev-parse', 'HEAD'), first.headSha);
    assert.equal(worktrees(repo), 2);
    // A checkout deleted behind Git's back is still registered: it is removed and added again.
    rmSync(path.join(home, 'base-checkout'), { recursive: true, force: true });
    const third = repo.change({ 'README.md': '# three\n' });
    assert.equal((await run(third, second.headSha)).testRegistry.status, 'compared');
    assert.equal(repo.git('-C', path.join(home, 'base-checkout'), 'rev-parse', 'HEAD'), second.headSha);
    assert.equal(worktrees(repo), 2);
  });
  await t.test('a finished base registry is cached by commit and toolchain', async s => {
    const repo = repository(s, { ...files, 'registry.json': registry(libTarget(baseTests)) });
    const home = homes(s);
    const head = repo.change({ 'README.md': '# game!\n' });
    const calls = [];
    const run = version =>
      runBehaviorGate({
        ...head,
        config: {},
        runner: fakeCargo(calls, { version }),
        registry: true,
        registryHome: home,
      });
    const first = await run('cargo 1.96.0');
    const again = await run('cargo 1.96.0');
    assert.deepEqual([first.testRegistry.baseCached, again.testRegistry.baseCached], [undefined, true]);
    assert.equal(baseBuilds(calls).length, 1, 'a repair round on the same base does not build it again');
    await run('cargo 1.97.0');
    assert.equal(baseBuilds(calls).length, 2, 'another toolchain builds again');
  });
  await t.test('parallel gates never build into the base target directory at the same time', async s => {
    const repo = repository(s, { ...files, 'registry.json': registry(libTarget(baseTests)) });
    const home = homes(s);
    const middle = repo.change({ 'README.md': '# middle\n' });
    const head = repo.change({ 'README.md': '# head\n' });
    const state = { active: 0, most: 0 },
      calls = [];
    const run = baseSha =>
      runBehaviorGate({
        ...head,
        baseSha,
        config: {},
        runner: fakeCargo(calls, { state }),
        registry: true,
        registryHome: home,
      });
    const receipts = await Promise.all([run(repo.baseSha), run(middle.headSha), run(repo.baseSha)]);
    assert.deepEqual(
      receipts.map(receipt => receipt.testRegistry.status),
      ['compared', 'compared', 'compared'],
    );
    assert.equal(state.most, 1, 'base builds ran one at a time');
    assert.equal(baseBuilds(calls).length, 2, 'the third gate found the first base in the cache');
  });
  await t.test('a manifest path the file system names differently from the checkout still matches', async s => {
    const repo = repository(s, { ...files, 'registry.json': registry(libTarget(baseTests)) });
    const head = repo.change({
      'src/lib.rs': withoutNegative,
      'registry.json': registry(libTarget(baseTests.filter(name => name !== 'tests::adds_negative'))),
    });
    // The gate reaches the worktree and Kodo's state through links (as `/var` -> `/private/var` on
    // macOS or an 8.3 name on Windows); Cargo prints the canonical paths.
    const links = homes(s);
    const link = path.join(links, 'linked-worktree'),
      home = path.join(links, 'linked-home');
    symlinkSync(repo.cwd, link, 'junction');
    symlinkSync(homes(s), home, 'junction');
    const receipt = await runBehaviorGate({
      ...head,
      cwd: link,
      config: {},
      registry: true,
      registryHome: home,
      runner: fakeCargo([], { canonicalManifest: true }),
    });
    assert.deepEqual(
      [rules(receipt.findings), receipt.testRegistry.status],
      [['tests_removed:src/lib.rs'], 'compared'],
    );
  });
  await t.test(
    'a Rust file too large to read makes a full gate incomplete; task-fast lists it as unchecked',
    async s => {
      const repo = repository(s, { ...files, 'registry.json': registry(libTarget(baseTests)) });
      const big = `${lib}${'// filler line of a generated table\n'.repeat(70000)}`;
      const head = repo.change({ 'src/table.rs': big });
      const full = await gate(s, head, { runner: fakeCargo([]) });
      assert.deepEqual(
        [full.status, rules(full.findings)],
        ['incomplete', ['test_inspection_incomplete:src/table.rs']],
      );
      const fast = await runBehaviorGate({ ...head, config: {} });
      assert.deepEqual([fast.status, fast.unchecked], ['passed', [{ file: 'src/table.rs', reason: 'too_large' }]]);
    },
  );
});

test('A plain cargo test that selects fewer default members is test_selection_narrowed', async t => {
  const workspace = members => `[workspace]\nmembers = ["crates/a", "crates/b"]\ndefault-members = [${members}]\n`;
  const config = args => ({ commands: { test: [{ command: 'cargo', args }] } });
  const repo = repository(t, { 'Cargo.toml': workspace('"crates/a", "crates/b"') });
  const head = repo.change({ 'Cargo.toml': workspace('"crates/a"') });
  const narrowed = await runBehaviorGate({ ...head, config: config(['test']) });
  assert.deepEqual(rules(narrowed.findings), ['test_selection_narrowed:Cargo.toml']);
  assert.match(narrowed.findings[0].detail, /"crates\/b"/);
  const workspaceWide = await runBehaviorGate({ ...head, config: config(['test', '--workspace']) });
  assert.deepEqual(workspaceWide.findings, []);
  const allowed = await runBehaviorGate({
    ...head,
    config: { ...config(['test']), verification: { testRemovalAllowed: ['Cargo.toml'] } },
  });
  assert.deepEqual([allowed.findings, rules(allowed.allowed)], [[], ['test_selection_narrowed:Cargo.toml']]);
});

test('Round 4: targets, moves, cache, TOML, sizes, maybe-tests, macro calls, checkout repair, case', async t => {
  const homes = s => {
    const home = mkdtempSync(path.join(os.tmpdir(), 'kodo-registry-home-'));
    s.after(() => rmSync(home, { recursive: true, force: true }));
    return home;
  };
  const gate = async (s, head, options = {}) =>
    runBehaviorGate({ ...head, config: {}, registry: true, registryHome: homes(s), runner: fakeCargo([]), ...options });
  const x = name =>
    `#[cfg(test)]\nmod tests {\n    #[test]\n    fn ${name}() {\n        assert!(crate::one());\n    }\n}\n`;
  const gated = name => x(name).replace('    #[test]\n', '    #[cfg(feature = "slow")]\n    #[test]\n');
  const libAndBin = (lib, bin) =>
    registry(
      { package: 'game', kind: 'lib', target: 'game', tests: lib },
      { package: 'game', kind: 'bin', target: 'game', tests: bin },
    );
  await t.test('K1: a permission on src/lib.rs does not hide a loss in the binary', async s => {
    const repo = repository(s, {
      'Cargo.toml': cargoToml,
      'src/lib.rs': `pub fn one() -> bool { true }\n${x('same')}`,
      'src/main.rs': `fn main() {}\nfn one() -> bool { true }\n${x('same')}`,
      'registry.json': libAndBin(['tests::same'], ['tests::same']),
    });
    const head = repo.change({
      'src/lib.rs': 'pub fn one() -> bool { true }\n',
      'src/main.rs': `fn main() {}\nfn one() -> bool { true }\n${gated('same')}`,
      'registry.json': libAndBin([], []),
    });
    const receipt = await gate(s, head, { config: { verification: { testRemovalAllowed: ['src/lib.rs'] } } });
    assert.deepEqual(
      [rules(receipt.findings), rules(receipt.allowed)],
      [['test_deleted:null'], ['tests_removed:src/lib.rs']],
    );
    assert.match(receipt.findings[0].detail, /"game bin game: tests::same"/);
  });
  await t.test('K1: a module of a library and a binary is ambiguous unless one target had the test', async s => {
    const files = {
      'Cargo.toml': cargoToml,
      'src/lib.rs': 'pub mod util;\npub fn one() -> bool { true }\n',
      'src/main.rs': 'mod util;\nfn main() {}\nfn one() -> bool { true }\n',
      'src/util.rs': x('y'),
    };
    const allowed = { config: { verification: { testRemovalAllowed: ['src/util.rs'] } } };
    const only = repository(s, { ...files, 'registry.json': libAndBin(['util::tests::y'], []) });
    const confirmed = await gate(
      s,
      only.change({ 'src/util.rs': '// y removed\n', 'registry.json': libAndBin([], []) }),
      allowed,
    );
    assert.deepEqual([rules(confirmed.findings), rules(confirmed.allowed)], [[], ['tests_removed:src/util.rs']]);
    const both = repository(s, { ...files, 'registry.json': libAndBin(['util::tests::y'], ['util::tests::y']) });
    const ambiguous = await gate(
      s,
      both.change({ 'src/util.rs': '// y removed\n', 'registry.json': libAndBin([], []) }),
      allowed,
    );
    assert.deepEqual(rules(ambiguous.findings), ['test_deleted:null']);
    assert.match(ambiguous.findings[0].detail, /2 tests are gone/);
  });
  await t.test('K2: a test "moved" into another target under an unknown cfg is a removal', async s => {
    const test = '#[test]\nfn x() {\n    assert!(game::one());\n}\n';
    const targets = (a, b) =>
      registry(
        { package: 'game', kind: 'test', target: 'a', tests: a },
        { package: 'game', kind: 'test', target: 'b', tests: b },
      );
    const repo = repository(s, {
      'Cargo.toml': cargoToml,
      'tests/a.rs': test,
      'tests/b.rs': '// empty\n',
      'registry.json': targets(['x'], []),
    });
    const head = repo.change({
      'tests/a.rs': '// moved out\n',
      'tests/b.rs': test.replace('#[test]\n', '#[cfg(feature = "slow")]\n#[test]\n'),
      'registry.json': targets([], []),
    });
    assert.deepEqual(await weakened(head), ['tests_removed:tests/a.rs'], 'task-fast sees it too');
    const receipt = await gate(s, head);
    assert.deepEqual(rules(receipt.findings), ['tests_removed:tests/a.rs']);
  });
  await t.test('K2: a move between the library and the binary counts only when the head registry shows it', async s => {
    const files = {
      'Cargo.toml': cargoToml,
      'src/lib.rs': 'pub fn one() -> bool { true }\n',
      'src/main.rs': `fn main() {}\nfn one() -> bool { true }\n${x('same')}`,
    };
    const after = lib => ({ 'src/main.rs': 'fn main() {}\n', 'src/lib.rs': `pub fn one() -> bool { true }\n${lib}` });
    const repo = repository(s, { ...files, 'registry.json': libAndBin([], ['tests::same']) });
    const moved = repo.change({ ...after(x('same')), 'registry.json': libAndBin(['tests::same'], []) });
    assert.deepEqual([await weakened(moved), (await gate(s, moved)).findings], [[], []], 'a confirmed move');
    const hidden = repository(s, { ...files, 'registry.json': libAndBin([], ['tests::same']) });
    const lost = hidden.change({ ...after(gated('same')), 'registry.json': libAndBin([], []) });
    assert.deepEqual(await weakened(lost), [], 'the reading sees a move');
    const receipt = await gate(s, lost);
    assert.deepEqual(rules(receipt.findings), ['test_deleted:null']);
    assert.match(receipt.findings[0].detail, /"game bin game: tests::same"/);
  });
  await t.test(
    'K3: the cache key follows the worker environment, CARGO_HOME and versions in the base checkout',
    async s => {
      const repo = repository(s, {
        'Cargo.toml': cargoToml,
        'src/lib.rs': lib,
        'registry.json': registry(libTarget(['tests::adds'])),
      });
      const head = repo.change({ 'README.md': '# again\n' });
      const home = homes(s),
        cargoHome = homes(s),
        calls = [];
      const saved = { flags: process.env.CARGO_ENCODED_RUSTFLAGS, home: process.env.CARGO_HOME };
      s.after(() => {
        for (const [name, value] of [
          ['CARGO_ENCODED_RUSTFLAGS', saved.flags],
          ['CARGO_HOME', saved.home],
        ])
          if (value === undefined) delete process.env[name];
          else process.env[name] = value;
      });
      process.env.CARGO_HOME = cargoHome;
      const run = () =>
        runBehaviorGate({ ...head, config: {}, registry: true, registryHome: home, runner: fakeCargo(calls) });
      await run();
      await run();
      assert.equal(baseBuilds(calls).length, 1, 'a warm cache');
      process.env.CARGO_ENCODED_RUSTFLAGS = '--cfg\u001fslow';
      await run();
      assert.equal(baseBuilds(calls).length, 2, 'CARGO_ENCODED_RUSTFLAGS changes the base');
      writeFileSync(path.join(cargoHome, 'config.toml'), '[build]\nrustflags = ["--cfg", "fast"]\n');
      await run();
      assert.equal(baseBuilds(calls).length, 3, 'CARGO_HOME configuration changes the base');
      const versions = calls.filter(
        call => call.args[0] === '--version' && call.cwd === path.join(home, 'base-checkout'),
      );
      assert.deepEqual(
        [...new Set(versions.map(call => call.command))].sort(),
        ['cargo', 'rustc'],
        'versions in the base checkout',
      );
    },
  );
  await t.test(
    'K4: manifests are read as TOML: single quotes, comments in arrays; -p is not a plain cargo test',
    async s => {
      const manifest = `${cargoToml}\n[[test]]\nname = 'smoke' # single quotes\nharness = false\n`;
      const repo = repository(s, {
        'Cargo.toml': manifest,
        'tests/smoke.rs': 'fn main() {}\n',
        'registry.json': registry(libTarget(['tests::adds']), {
          package: 'game',
          kind: 'test',
          target: 'smoke',
          tests: ['would_run'],
        }),
      });
      const calls = [];
      const head = repo.change({ 'Cargo.toml': cargoToml, 'registry.json': registry(libTarget(['tests::adds'])) }, [
        'tests/smoke.rs',
      ]);
      const receipt = await gate(s, head, { runner: fakeCargo(calls) });
      assert.match(receipt.findings[0].detail, /"game test smoke: \(target, harness = false\)"/);
      assert.equal(
        calls.some(call => /smoke/.test(call.command)),
        false,
      );
      const workspace = members =>
        `[workspace]\nmembers = [\n  "crates/a", # the core\n  "crates/b",\n]\ndefault-members = [${members}]\n`;
      const narrowed = repository(s, { 'Cargo.toml': workspace('\n  "crates/a", # first\n  "crates/b" # second\n') });
      const changed = narrowed.change({ 'Cargo.toml': workspace('"crates/a", # only a\n') });
      const plain = await runBehaviorGate({
        ...changed,
        config: { commands: { test: [{ command: 'cargo', args: ['test'] }] } },
      });
      assert.deepEqual(rules(plain.findings), ['test_selection_narrowed:Cargo.toml']);
      assert.match(plain.findings[0].detail, /"crates\/b"/);
      for (const args of [
        ['test', '-p', 'a'],
        ['test', '--package', 'a'],
        ['test', '-pa'],
      ]) {
        const package_ = await runBehaviorGate({
          ...changed,
          config: { commands: { test: [{ command: 'cargo', args }] } },
        });
        assert.deepEqual(package_.findings, [], args.join(' '));
      }
    },
  );
  await t.test('K5: a changed Rust file too large to read: incomplete once, also with testRegistry: false', async s => {
    const big = `${lib}${'// filler line of a generated table\n'.repeat(70000)}`;
    const repo = repository(s, {
      'Cargo.toml': cargoToml,
      'src/lib.rs': lib,
      'src/table.rs': big,
      'registry.json': registry(libTarget(['tests::adds', 'tests::adds_negative'])),
    });
    const head = repo.change({ 'src/table.rs': `${big}// touched\n` });
    const receipt = await gate(s, head, { config: { verification: { testRegistry: false } } });
    assert.deepEqual(
      [receipt.status, rules(receipt.findings)],
      ['incomplete', ['test_inspection_incomplete:src/table.rs']],
    );
  });
  await t.test('K6: a test only through cfg_attr(<unknown>, test) is left to the registry', async s => {
    const repo = repository(s, { 'src/lib.rs': lib });
    const maybe = lib.replace(
      '    #[test]\n    fn adds_negative()',
      '    #[cfg_attr(feature = "slow", test)]\n    fn adds_negative()',
    );
    assert.deepEqual(await weakened(repo.change({ 'src/lib.rs': maybe })), []);
    const fromMaybe = repository(s, { 'src/lib.rs': maybe });
    assert.deepEqual(
      await weakened(fromMaybe.change({ 'src/lib.rs': withoutNegative })),
      [],
      'a maybe-test that goes is the registry’s',
    );
    assert.deepEqual(
      rustTestCases('src/lib.rs', maybe).map(item => item.name),
      ['tests::adds', 'tests::adds_negative'],
    );
  });
  await t.test('K7: macro calls are tokens; an exported macro is looked for in the whole repository', async s => {
    const template = body =>
      `#[macro_export]\nmacro_rules! cases {\n    ($n:ident) => {\n        #[test]\n        fn $n() {${body}}\n    };\n}\n`;
    const real = ' assert_eq!(1 + 1, 2); ';
    const quoted = repository(s, {
      'crates/a/src/lib.rs': `${template(real)}`,
      'crates/b/src/lib.rs': '// cases!(gen_a);\nconst DOC: &str = "cases!(gen_b)";\n',
    });
    assert.deepEqual(
      await weakened(quoted.change({ 'crates/a/src/lib.rs': template(' ') })),
      [],
      'comments and strings call nothing',
    );
    const used = repository(s, { 'crates/a/src/lib.rs': template(real), 'crates/b/src/lib.rs': 'a::cases!(gen_a);\n' });
    assert.deepEqual(await weakened(used.change({ 'crates/a/src/lib.rs': template(' ') })), [
      'weak_or_empty_test:crates/a/src/lib.rs',
    ]);
  });
  await t.test('K9: a base checkout with a broken .git is rebuilt, never run in an outer repository', async s => {
    // The registry home inside the repository: Git in a checkout without its own `.git` would climb to it.
    const repo = repository(s, {
      '.gitignore': '.kodo-home/\n',
      'Cargo.toml': cargoToml,
      'src/lib.rs': lib,
      'registry.json': registry(libTarget(['tests::adds'])),
    });
    const home = path.join(repo.cwd, '.kodo-home');
    const first = repo.change({ 'README.md': '# one\n' });
    const second = repo.change({ 'README.md': '# two\n' });
    const run = (head, baseSha) =>
      runBehaviorGate({ ...head, baseSha, config: {}, registry: true, registryHome: home, runner: fakeCargo([]) });
    assert.equal((await run(first, repo.baseSha)).testRegistry.status, 'compared');
    // Git for Windows hides `.git`: a hidden file is replaced, not truncated.
    rmSync(path.join(home, 'base-checkout', '.git'), { force: true });
    writeFileSync(path.join(home, 'base-checkout', '.git'), 'gitdir: /nowhere/at/all\n');
    assert.equal((await run(second, first.headSha)).testRegistry.status, 'compared');
    assert.equal(repo.git('-C', path.join(home, 'base-checkout'), 'rev-parse', 'HEAD'), first.headSha);
    rmSync(path.join(home, 'base-checkout', '.git'), { force: true });
    const third = repo.change({ 'README.md': '# three\n' });
    writeFileSync(path.join(repo.cwd, 'notes.local'), 'an untracked file of the outer repository\n');
    assert.equal((await run(third, second.headSha)).testRegistry.status, 'compared');
    assert.equal(repo.git('-C', path.join(home, 'base-checkout'), 'rev-parse', 'HEAD'), second.headSha);
    assert.equal(repo.git('rev-parse', 'HEAD'), third.headSha, 'the outer repository was not moved');
    assert.equal(existsSync(path.join(repo.cwd, 'notes.local')), true, 'nor cleaned');
  });
  await t.test('K10: a crate directory with capitals (crates/Core) matches on every platform', async s => {
    const core = { package: 'core-lib', kind: 'lib', target: 'core_lib', dir: 'crates/Core' };
    const repo = repository(s, {
      'Cargo.toml': '[workspace]\nmembers = ["crates/Core"]\n',
      'crates/Core/src/lib.rs': lib,
      'registry.json': registry({ ...core, tests: ['tests::adds', 'tests::adds_negative'] }),
    });
    const head = repo.change({
      'crates/Core/src/lib.rs': withoutNegative,
      'registry.json': registry({ ...core, tests: ['tests::adds'] }),
    });
    const receipt = await gate(s, head, { runner: fakeCargo([], { canonicalManifest: true }) });
    assert.deepEqual(rules(receipt.findings), ['tests_removed:crates/Core/src/lib.rs']);
  });
});

test('The base build lock holds across processes and is released when its holder dies', async t => {
  const home = mkdtempSync(path.join(os.tmpdir(), 'kodo-lock-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const module = new URL('../runtime/behavior-rust.mjs', import.meta.url).href;
  const holder = spawn(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `const { withBaseLock } = await import(${JSON.stringify(module)});
       // The pending wait is kept reachable: a collected lock would close its connection and free the lock.
       globalThis.held = withBaseLock(${JSON.stringify(home)}, async () => {
         console.log('locked');
         await new Promise(resolve => { globalThis.release = resolve; setInterval(() => {}, 1000); });
       });`,
    ],
    { stdio: ['ignore', 'pipe', 'inherit'] },
  );
  t.after(() => holder.kill());
  await new Promise((resolve, reject) => {
    holder.stdout.on('data', data => String(data).includes('locked') && resolve());
    holder.on('exit', code => reject(new Error(`holder exited ${code}`)));
  });
  await assert.rejects(
    withBaseLock(home, async () => 'second', undefined, 400),
    /Timed out waiting for the base build/,
  );
  holder.kill('SIGKILL');
  await new Promise(resolve => holder.on('exit', resolve));
  assert.equal(await withBaseLock(home, async () => 'second', undefined, 10000), 'second');
});

test('Round 5: empty targets, moves into ignore, nested templates, checkout bounds', async t => {
  const homes = s => {
    const home = mkdtempSync(path.join(os.tmpdir(), 'kodo-registry-home-'));
    s.after(() => rmSync(home, { recursive: true, force: true }));
    return home;
  };
  const gate = async (s, head, options = {}) =>
    runBehaviorGate({ ...head, config: {}, registry: true, registryHome: homes(s), runner: fakeCargo([]), ...options });
  const unit = (name, attribute = '#[test]') =>
    `#[cfg(test)]\nmod tests {\n    ${attribute}\n    fn ${name}() {\n        assert!(crate::one());\n    }\n}\n`;
  const libAndBin = (lib, bin, ignored = []) =>
    registry(
      { package: 'game', kind: 'lib', target: 'game', tests: lib, ignored },
      { package: 'game', kind: 'bin', target: 'game', tests: bin },
    );
  const one = 'pub fn one() -> bool { true }\n';
  const main = 'fn main() {}\nfn one() -> bool { true }\n';
  await t.test(
    'Z1: a library that lists no test is still a target: its permission does not reach the binary',
    async s => {
      const repo = repository(s, {
        'Cargo.toml': cargoToml,
        'src/lib.rs': `${one}${unit('same', '#[cfg(feature = "slow")]\n    #[test]')}`,
        'src/main.rs': `${main}${unit('same')}`,
        'registry.json': libAndBin([], ['tests::same']),
      });
      const head = repo.change({
        'src/lib.rs': one,
        'src/main.rs': `${main}${unit('same', '#[cfg(feature = "slow")]\n    #[test]')}`,
        'registry.json': libAndBin([], []),
      });
      const receipt = await gate(s, head, { config: { verification: { testRemovalAllowed: ['src/lib.rs'] } } });
      assert.deepEqual(
        [rules(receipt.findings), rules(receipt.allowed)],
        [['test_deleted:null'], ['tests_removed:src/lib.rs']],
      );
      assert.match(receipt.findings[0].detail, /"game bin game: tests::same"/);
    },
  );
  await t.test('Z2: an active test moved to where it is ignored is test_skipped', async s => {
    const repo = repository(s, {
      'Cargo.toml': cargoToml,
      'src/lib.rs': one,
      'src/main.rs': `${main}${unit('same')}`,
      'registry.json': libAndBin([], ['tests::same']),
    });
    const ignored = repo.change({
      'src/main.rs': main,
      'src/lib.rs': `${one}${unit('same', '#[test]\n    #[cfg_attr(feature = "slow", ignore)]')}`,
      'registry.json': libAndBin(['tests::same'], [], ['tests::same']),
    });
    assert.deepEqual(await weakened(ignored), [], 'the reading sees a move');
    const receipt = await gate(s, ignored);
    assert.deepEqual(rules(receipt.findings), ['test_skipped:null']);
    assert.match(receipt.findings[0].detail, /ignored now: "game bin game: tests::same"/);
    const active = repository(s, {
      'Cargo.toml': cargoToml,
      'src/lib.rs': one,
      'src/main.rs': `${main}${unit('same')}`,
      'registry.json': libAndBin([], ['tests::same']),
    });
    const kept = active.change({
      'src/main.rs': main,
      'src/lib.rs': `${one}${unit('same')}`,
      'registry.json': libAndBin(['tests::same'], []),
    });
    assert.deepEqual((await gate(s, kept)).findings, [], 'an active move stays a move');
  });
  await t.test('Z3: a template expanded by a called wrapper is checked; an unreached one is not', async s => {
    const make = body =>
      `macro_rules! make_case {\n    ($n:ident) => {\n        #[test]\n        fn $n() {${body}}\n    };\n}\n`;
    const files = {
      'src/lib.rs': '#[macro_use]\nmod gen;\n#[macro_use]\nmod wrap;\nmod use_it;\n',
      'src/gen.rs': make(' assert_eq!(1 + 1, 2); '),
      'src/wrap.rs': 'macro_rules! cases {\n    () => {\n        make_case!(adds);\n    };\n}\n',
    };
    const called = repository(s, { ...files, 'src/use_it.rs': 'cases!();\n' });
    assert.deepEqual(await weakened(called.change({ 'src/gen.rs': make(' ') })), ['weak_or_empty_test:src/gen.rs']);
    const unused = repository(s, { ...files, 'src/use_it.rs': '// cases!();\nconst NOTE: &str = "cases!()";\n' });
    assert.deepEqual(await weakened(unused.change({ 'src/gen.rs': make(' ') })), []);
    // Two templates that only call each other reach nothing, and the search ends.
    const cycle = repository(s, {
      ...files,
      'src/wrap.rs':
        'macro_rules! cases {\n    () => {\n        make_case!(adds);\n        again!();\n    };\n}\nmacro_rules! again {\n    () => {\n        cases!();\n    };\n}\n',
      'src/use_it.rs': '// nothing calls them\n',
    });
    assert.deepEqual(await weakened(cycle.change({ 'src/gen.rs': make(' ') })), []);
    // A long chain of wrappers is followed to its real call: a search budget never means "unreached".
    const chain = ['macro_rules! w0 {\n    () => {\n        make_case!(adds);\n    };\n}\n'];
    for (let n = 1; n < 36; n++) chain.push(`macro_rules! w${n} {\n    () => {\n        w${n - 1}!();\n    };\n}\n`);
    const deep = repository(s, { ...files, 'src/wrap.rs': chain.join(''), 'src/use_it.rs': 'w35!();\n' });
    assert.deepEqual(await weakened(deep.change({ 'src/gen.rs': make(' ') })), ['weak_or_empty_test:src/gen.rs']);
  });
  await t.test(
    'Z4: the base checkout must lie strictly inside the registry home, as the file system resolves it',
    async s => {
      const home = homes(s);
      assert.equal(strictlyInside(home, path.join(home, 'base-checkout')), true);
      assert.equal(strictlyInside(home, home), false);
      assert.equal(strictlyInside(home, path.join(home, '..', 'elsewhere')), false);
      assert.equal(strictlyInside(home, path.join(home, '..', `${path.basename(home)}-sibling`, 'x')), false);
      if (process.platform === 'win32') {
        const drive = home.slice(0, 1).toUpperCase() === 'Z' ? 'Y' : 'Z';
        assert.equal(strictlyInside(home, `${drive}:\\outer\\base-checkout`), false, 'another drive');
      }
      // A link in place of the checkout that leads outside: no Git command, no deletion there.
      const outside = homes(s);
      writeFileSync(path.join(outside, 'precious.txt'), 'kept\n');
      symlinkSync(outside, path.join(home, 'base-checkout'), 'junction');
      const repo = repository(s, {
        'Cargo.toml': cargoToml,
        'src/lib.rs': lib,
        'registry.json': registry(libTarget(['tests::adds'])),
      });
      const head = repo.change({ 'README.md': '# again\n' });
      const receipt = await runBehaviorGate({
        ...head,
        config: {},
        registry: true,
        registryHome: home,
        runner: fakeCargo([]),
      });
      assert.equal(receipt.status, 'incomplete');
      assert.match(receipt.testRegistry.reason, /outside the registry home/);
      assert.equal(readFileSync(path.join(outside, 'precious.txt'), 'utf8'), 'kept\n');
    },
  );
  await t.test('Z4: a checkout of another repository is never moved, cleaned or deleted', async s => {
    const home = homes(s);
    const checkout = path.join(home, 'base-checkout');
    const other = repository(s, { 'README.md': '# other\n' });
    other.git('worktree', 'add', '--detach', '--quiet', checkout, other.baseSha);
    writeFileSync(path.join(checkout, 'scratch.txt'), 'theirs\n');
    const repo = repository(s, {
      'Cargo.toml': cargoToml,
      'src/lib.rs': lib,
      'registry.json': registry(libTarget(['tests::adds'])),
    });
    const head = repo.change({ 'README.md': '# again\n' });
    const gate = () =>
      runBehaviorGate({ ...head, config: {}, registry: true, registryHome: home, runner: fakeCargo([]) });
    const receipt = await gate();
    assert.equal(receipt.status, 'incomplete');
    assert.match(receipt.testRegistry.reason, /another repository/);
    assert.equal(other.git('-C', checkout, 'rev-parse', 'HEAD'), other.baseSha, 'their checkout was not moved');
    assert.equal(readFileSync(path.join(checkout, 'scratch.txt'), 'utf8'), 'theirs\n', 'nor cleaned');
    assert.equal(other.git('rev-parse', 'HEAD'), other.baseSha, 'the other repository was not moved');
  });
  await t.test('Z4: a stale registration reused by another clone at the same path is left untouched', async s => {
    const home = homes(s);
    const checkout = path.join(home, 'base-checkout');
    const repo = repository(s, {
      'Cargo.toml': cargoToml,
      'src/lib.rs': lib,
      'registry.json': registry(libTarget(['tests::adds'])),
    });
    const head = repo.change({ 'README.md': '# again\n' });
    const gate = () =>
      runBehaviorGate({ ...head, config: {}, registry: true, registryHome: home, runner: fakeCargo([]) });
    assert.equal((await gate()).testRegistry.status, 'compared');
    // The directory goes away without `worktree prune`: this repository still lists the path.
    rmSync(checkout, { recursive: true, force: true });
    const other = repository(s, { 'README.md': '# other\n' });
    other.git('worktree', 'add', '--detach', '--quiet', checkout, other.baseSha);
    const receipt = await gate();
    assert.equal(receipt.status, 'incomplete');
    assert.match(receipt.testRegistry.reason, /another repository/);
    assert.equal(other.git('-C', checkout, 'rev-parse', 'HEAD'), other.baseSha, 'their HEAD was not moved');
  });
});

test('The hash of a default verification block is unchanged; a disabled registry changes it', () => {
  const old = createHash('sha256')
    .update(
      JSON.stringify({
        version: BEHAVIOR_GATE_VERSION,
        config: { baseline: false, testProtection: true, testRemovalAllowed: [], strictGates: false, oracles: [] },
      }),
    )
    .digest('hex');
  assert.equal(verificationConfigHash(undefined), old);
  assert.equal(verificationConfigHash({ testRegistry: true }), old);
  assert.notEqual(verificationConfigHash({ testRegistry: false }), old);
});

/** The oracle templates as the docs give them: they are kept valid by this test. */
function documentedTemplates() {
  const docs = readFileSync(new URL('../docs/VERIFICATION.md', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
  const block = [...docs.matchAll(/```json\n([\s\S]*?)\n```/g)].find(match => match[1].includes('"headless-smoke"'));
  assert.ok(block, 'docs/VERIFICATION.md has the oracle templates');
  return JSON.parse(block[1]);
}

test('Oracle budgets read one structured result: property, performance budget, headless smoke', async t => {
  const templates = documentedTemplates();
  const verification = normalizeVerificationConfig(templates.verification);
  assert.deepEqual(
    verification.oracles.map(oracle => oracle.id),
    ['contract-properties', 'frame-budget', 'headless-smoke'],
  );
  const metrics = (...pairs) => JSON.stringify({ metrics: pairs.map(([name, value]) => ({ name, value })) });
  const results = {
    'frame-budget': { stdout: 'frame_ms_p95=99\n', result: metrics(['frame_ms_p95', 12.5], ['peak_rss_mb', 380]) },
    'headless-smoke': { result: metrics(['steps_completed', 600], ['entities', 1342]) },
  };
  const run = async (s, overrides = {}) => {
    const repo = repository(s);
    const head = repo.change({ 'README.md': '# game, changed\n' });
    const byId = { ...results, ...overrides };
    const seen = [];
    const receipt = await runBehaviorGate({
      ...head,
      config: templates,
      runner: async (command, args, options) => {
        const oracle = verification.oracles.find(
          item => item.command === command && item.args.join(' ') === args.join(' '),
        );
        const planned = byId[oracle.id] ?? {};
        seen.push([oracle.id, options.env.KODO_ORACLE_RESULT]);
        if (planned.result !== undefined && options.env.KODO_ORACLE_RESULT)
          writeFileSync(options.env.KODO_ORACLE_RESULT, planned.result);
        return { code: planned.code ?? 0, stdout: planned.stdout ?? '', stderr: planned.stderr ?? '' };
      },
    });
    return { receipt, seen };
  };
  const oracle = (receipt, id) => receipt.oracles.find(item => item.id === id);
  await t.test('every budget met: the receipt shows the measured values; console text is not a metric', async s => {
    const { receipt, seen } = await run(s);
    assert.deepEqual([receipt.findings, receipt.passed], [[], true]);
    assert.deepEqual(
      oracle(receipt, 'frame-budget').budgets.map(budget => [budget.metric, budget.value, budget.status]),
      [
        ['frame_ms_p95', 12.5, 'met'],
        ['peak_rss_mb', 380, 'met'],
      ],
    );
    // Only an oracle with budgets gets a result file, and it lies outside the checked tree.
    assert.equal(seen.find(([id]) => id === 'contract-properties')[1], undefined);
    const file = seen.find(([id]) => id === 'frame-budget')[1];
    assert.ok(file && path.basename(file) === 'result.json' && !existsSync(file), 'the result file is removed');
  });
  for (const [label, override, reason, detail] of [
    [
      'a budget exceeded',
      { result: metrics(['frame_ms_p95', 21.3], ['peak_rss_mb', 380]) },
      'budget_exceeded',
      /frame_ms_p95 = 21\.3, above max 16\.6/,
    ],
    [
      'a metric reported twice',
      { result: metrics(['frame_ms_p95', 1], ['frame_ms_p95', 2], ['peak_rss_mb', 1]) },
      'budget_metric_ambiguous',
      /frame_ms_p95: reported more than once/,
    ],
    [
      'a metric not reported',
      { result: metrics(['peak_rss_mb', 1]) },
      'budget_metric_missing',
      /frame_ms_p95: not reported/,
    ],
    [
      'a value that is not a finite number',
      { result: metrics(['frame_ms_p95', '12'], ['peak_rss_mb', 1]) },
      'budget_result_invalid',
      /frame_ms_p95: not a finite number/,
    ],
    [
      'no result file, the number only on stdout',
      { result: undefined, stdout: 'frame_ms_p95=1\npeak_rss_mb=1\n' },
      'budget_result_missing',
      /budget_result_missing/,
    ],
    ['a result that is not JSON', { result: 'frame_ms_p95=1' }, 'budget_result_invalid', /budget_result_invalid/],
  ])
    await t.test(`${label} fails the oracle even with exit code 0`, async s => {
      const { receipt } = await run(s, { 'frame-budget': override });
      assert.deepEqual(rules(receipt.findings), ['oracle_failed:null']);
      assert.match(receipt.findings[0].detail, detail);
      assert.deepEqual(
        [oracle(receipt, 'frame-budget').status, oracle(receipt, 'frame-budget').reason],
        ['failed', reason],
      );
    });
  await t.test('a smoke run that produced nothing fails', async s => {
    const { receipt } = await run(s, {
      'headless-smoke': { result: metrics(['steps_completed', 600], ['entities', 0]) },
    });
    assert.match(receipt.findings[0].detail, /entities = 0, below min 1/);
  });
  await t.test('a crashed oracle is judged by its exit code; its budgets are not read', async s => {
    const { receipt } = await run(s, {
      'frame-budget': { code: 101, result: metrics(['frame_ms_p95', 1], ['peak_rss_mb', 1]) },
    });
    const failed = oracle(receipt, 'frame-budget');
    assert.deepEqual([failed.status, failed.exitCode, failed.budgets], ['failed', 101, undefined]);
  });
  await t.test('budgets are validated with the configuration', () => {
    const base = { id: 'perf', command: 'cargo', protect: ['bench/**'] };
    for (const [budgets, message] of [
      [[], /budgets must be a list of 1 to 8/],
      [[{ metric: 'frame=(\\d+)', max: 1 }], /must be a metric name/],
      [[{ metric: 'frame_ms' }], /needs max or min/],
      [[{ metric: 'frame_ms', min: 2, max: 1 }], /min is above max/],
      [[{ metric: 'frame_ms', max: '16' }], /max must be a number/],
      [[{ metric: 'frame_ms', max: Infinity }], /max must be a number/],
      [[{ metric: 'frame_ms', max: 1, unit: 'ms' }], /unknown oracle perf budget key unit/],
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
