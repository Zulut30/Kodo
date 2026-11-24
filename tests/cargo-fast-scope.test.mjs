import test from 'node:test';
import assert from 'node:assert/strict';
import { affectedCrates } from '../runtime/cargo-graph.mjs';

import { fixture, put } from './fixtures/quality/helpers.mjs';
import { git } from '../runtime/workspace.mjs';
import { planFastChecks } from '../runtime/task-fast-checks.mjs';

function model() {
  const docs = new Map([['Cargo.toml', { workspace: { members: ['crates/*'] } }]]);
  for (let i = 0; i < 10; i++)
    docs.set('crates/c' + i + '/Cargo.toml', { package: { name: 'c' + i, version: '1.0.0' } });
  const sources = new Map(),
    entries = [];
  const plan = (file = 'crates/c3/src/lib.rs') =>
    affectedCrates(docs, Array.isArray(file) ? file : [file], { sources, entries });
  return { docs, sources, entries, plan };
}

const ordinary = [
  "struct State<'a> { path: &'a str }",
  "impl<'a> State<'a> { fn compare(&mut self,p:&'a str) -> bool {",
  'let path = p; self.path = path; let include = true;',
  '// path = "../x"; include!(env!("OUT_DIR"))',
  '/* /* nested */ include!("../../c3/src/lib.rs"); #[path="../x"] */',
  'const S: &str = "escaped \\" include!(env!(\\"X\\"))";',
  'const R: &str = r###"#[path="../x"] include_str!(env!("X"))"###;',
  'const B: &[u8] = b"path = foo"; const BR: &[u8] = br##"include!(env!("X"))"##;',
  'let _ = c"path = foo"; let _ = cr#"include!(env!("X"))"#;',
  "let quote = '\"';",
  'path == p || path != p || include != true } }',
  '#[cfg(any())] #[route(path = "/health")] fn health() {}',
  '#[cfg_attr(any(), route(path="/health"))] fn api() {}',
].join('\n');

test('ordinary Rust in a sibling leaves c3 alone in a ten-crate workspace', () => {
  const { sources, plan } = model();
  sources.set('crates/c8/src/lib.rs', ordinary);
  const scope = plan();
  assert.equal(scope.fallback, false);
  assert.deepEqual(scope.affectedCrates, ['c3']);
});

test('ten crates select c3, leaf build scripts and both reverse closures', () => {
  const { docs, sources, plan } = model();
  docs.get('crates/c4/Cargo.toml').dependencies = { c3: { path: '../c3' } };
  sources.set('crates/c8/src/lib.rs', ordinary);
  sources.set('crates/c9/build.rs', 'fn main() {}');
  const scope = plan();
  assert.equal(scope.fallback, false);
  assert.deepEqual(scope.affectedCrates.sort(), ['c3', 'c4', 'c9']);
  docs.get('crates/c7/Cargo.toml').dependencies = { c9: { path: '../c9' } };
  assert.deepEqual(plan('README.md').affectedCrates.sort(), ['c7', 'c9']);
});

for (const attr of [
  '#[cfg_attr(unix, allow(dead_code), path = "source.rs")]',
  '#[cfg_attr(unix, route(path = "/a"), path = "source.rs")]',
  '#[path = "source.rs"]',
  '#![path = "source.rs"]',
  '#[cfg_attr(all(unix,feature="x"),path="source.rs")]',
  '#[cfg_attr(unix,cfg_attr(test,path="source.rs"))]',
]) {
  test('nested manifest makes path ambiguous ' + attr, () => {
    const { docs, sources, plan } = model();
    sources.set('crates/c8/src/lib.rs', attr + ' mod inner;');
    docs.set('crates/c8/src/vendor/Cargo.toml', { package: { name: 'vendor' } });
    assert.deepEqual(plan().reasons, ['cargo-source-path']);
  });
}

test('shared resources select literal readers and build script consumers only', () => {
  const { docs, sources, plan } = model();
  docs.get('crates/c4/Cargo.toml').dependencies = { c3: { path: '../c3' } };
  sources.set('crates/c3/src/lib.rs', 'const MAP:&str=include_str! /* input */ (r#"../../../assets/map.json"#);');
  sources.set('crates/c5/src/lib.rs', 'const DATA:&[u8]=include_bytes!("../../../assets/map.json");');
  sources.set('crates/c7/src/lib.rs', 'const TXT:&str=include_str!("../../../docs/notes.txt");');
  const scope = plan('assets/map.json');
  assert.equal(scope.fallback, false);
  assert.deepEqual(scope.affectedCrates.sort(), ['c3', 'c4', 'c5']);
  assert.deepEqual(plan('docs/notes.txt').affectedCrates, ['c7']);
  assert.deepEqual(plan('README.md').affectedCrates, []);
  sources.set('crates/c9/build.rs', 'fn main() {}');
  assert.deepEqual(plan('assets/map.json').affectedCrates.sort(), ['c3', 'c4', 'c5', 'c9']);
  sources.set('crates/c6/src/lib.rs', 'include_str!(concat!(env!("ROOT"),"/notes"));');
  assert.deepEqual(plan('README.md').reasons, ['cargo-source-path']);
});

test('Cargo default version and unrelated links preserve precise selection', () => {
  const { docs, sources, entries, plan } = model();
  delete docs.get('crates/c3/Cargo.toml').package.version;
  assert.deepEqual(plan().packageSpecs, ['c3@0.0.0']);
  entries.push({ file: 'docs/alias', mode: '120000' });
  assert.equal(plan().fallback, false);
  sources.set('crates/c1/src/lib.rs', 'include_str!("../../../docs/alias/file");');
  assert.deepEqual(plan().reasons, ['cargo-linked-input']);
  entries.push({ file: 'crates/c1/link', mode: '120000' });
  sources.clear();
  assert.deepEqual(plan().reasons, ['cargo-linked-input']);
});

test('a path traversing a link before .. cannot prove literal ownership', () => {
  const { entries, sources, plan } = model();
  entries.push({ file: 'docs/link', mode: '120000' });
  sources.set('crates/c5/src/lib.rs', 'include_str!("../../../docs/link/../note.txt");');
  assert.deepEqual(plan('README.md').reasons, ['cargo-linked-input']);
});
test('a symlink can hide a prefix of a workspace member glob', () => {
  const { docs, entries, plan } = model();
  docs.get('Cargo.toml').workspace.members.push('engines/*/packages/*');
  entries.push({ file: 'engines/physics', mode: '120000' });
  assert.deepEqual(plan().reasons, ['cargo-linked-input']);
});
test('ten committed Cargo manifests yield a single precise task-fast invocation', async t => {
  const files = { 'Cargo.toml': '[workspace]\nmembers=["crates/*"]', 'Cargo.lock': 'version=4' };
  for (let n = 0; n < 10; n++) {
    const dir = 'crates/c' + n;
    files[dir + '/Cargo.toml'] =
      '[package]\nname="c' +
      n +
      '"\nversion="1.0.0"\nedition="2021"' +
      (n === 4 ? '\n[dependencies]\nc3={path="../c3"}' : '');
    files[dir + '/src/lib.rs'] = n === 8 ? ordinary : 'pub fn value() {}';
  }
  files['crates/c9/build.rs'] = 'fn main() {}';
  const { project: cwd } = await fixture(t, files);
  const baseSha = await git(cwd, ['rev-parse', 'HEAD']);
  await put(cwd, 'crates/c3/src/lib.rs', 'pub fn changed() {}');
  await git(cwd, [
    '-c',
    'user.name=test',
    '-c',
    'user.email=t@example.org',
    '-c',
    'commit.gpgSign=false',
    'commit',
    '-qam',
    'edit c3',
  ]);
  const plan = await planFastChecks({
    run: { cwd, config: { commands: { test: [] } } },
    baseSha,
    headSha: await git(cwd, ['rev-parse', 'HEAD']),
  });
  assert.equal(plan.fallback, false);
  assert.deepEqual(plan.reasons, ['cargo-build-script-input']);
  assert.equal(plan.commands.length, 1);
  const { args } = plan.commands[0];
  assert.equal(args[0], 'test');
  const locked = await planFastChecks({
    run: {
      cwd,
      config: { commands: { test: [{ command: 'cargo', args: ['+stable', 'test', '--workspace', '--locked'] }] } },
    },
    baseSha,
    headSha: plan.headSha,
  });
  assert.deepEqual(locked.commands[0].args, ['+stable', ...args]);
  assert.deepEqual(args.flatMap((value, index) => (value === '-p' ? [args[index + 1]] : [])).sort(), [
    'c3@1.0.0',
    'c4@1.0.0',
    'c9@1.0.0',
  ]);
});

test('a changed unrelated link in a root package is not a shared input', () => {
  const { docs, entries, plan } = model();
  docs.get('Cargo.toml').package = { name: 'root', version: '1.0.0' };
  entries.push({ file: 'docs/manual', mode: '120000' });
  assert.equal(plan('docs/manual').fallback, false);
  assert.deepEqual(plan('docs/manual').affectedCrates, []);
});

for (const declaration of [
  'macro_rules! inc { () => {{ include_str!("../../../data/x.txt") }} }',
  'macro_rules! inc { ($args:tt) => { include_str! $args } }',
  'macro_rules! inc [ () => { include_bytes!["../../../data/x.txt"] } ];',
  'macro_rules! inc ( () => { include!("generated.rs") } );',
  'macro r#inc($x:expr) { #[cfg_attr(test, path = "module.rs")] mod m; }',
  'macro inc { () => { #![path = "module.rs"] } }',
]) {
  test('expansion-site path widens workspace: ' + declaration, () => {
    const { sources, plan } = model();
    sources.set('crates/c0/src/lib.rs', declaration);
    sources.set('crates/c0/src/generated.rs', '');
    sources.set('crates/c1/src/nested/mod.rs', 'c0::inc!();');
    for (const changed of ['crates/data/x.txt', 'README.md'])
      assert.deepEqual(plan(changed).reasons, ['cargo-source-path']);
  });
}
test('balanced path-free macro ends before a normal literal include', () => {
  const { sources, plan } = model();
  sources.set(
    'crates/c0/src/lib.rs',
    'macro_rules! noop { () => {{ let s = "}"; }} } const S:&str=include_str!("../../../README.md");',
  );
  assert.deepEqual(plan('README.md').reasons, []);
  assert.deepEqual(plan('README.md').affectedCrates, ['c0']);
});
test('only explicit external documentation may have no readers', () => {
  const { sources, plan } = model();
  for (const file of ['README.md', 'guides/install.md', 'LICENSE-MIT', 'CHANGELOG.rst', 'docs/reference/input.sql'])
    assert.deepEqual(plan(file).reasons, ['cargo-no-affected-crates'], file);
  sources.set('crates/c9/build.rs', '');
  sources.set('crates/c3/src/lib.rs', 'include_bytes!("../../../assets/known");');
  for (const file of [
    'assets/level.json',
    'shaders/game.wgsl',
    '.sqlx/query.json',
    'migrations/up.sql',
    'fixtures/data',
    '.env',
    'memory.x',
  ])
    assert.deepEqual(plan(['assets/known', file]).reasons, ['cargo-unowned-input'], file);
});
for (const [field, value, inherited, changed] of [
  ['readme', '../../README.md', false, 'README.md'],
  ['license-file', '../../LICENSE-MIT', false, 'LICENSE-MIT'],
  ['readme', 'docs/reference.txt', true, 'docs/reference.txt'],
  ['license-file', 'LICENSE-THIRD', true, 'LICENSE-THIRD'],
  ['include', ['/resources/*.md'], true, 'crates/c3/resources/a.md'],
]) {
  test('package manifest reader selects transitive consumers: ' + [field, value, inherited], () => {
    const { docs, plan } = model();
    docs.get('crates/c4/Cargo.toml').dependencies = { c3: { path: '../c3' } };
    if (inherited) docs.get('Cargo.toml').workspace.package = { [field]: value };
    docs.get('crates/c3/Cargo.toml').package[field] = inherited ? { workspace: true } : value;
    const scope = plan(changed);
    assert.deepEqual(scope.reasons, ['cargo-manifest-input']);
    assert.deepEqual(scope.affectedCrates.sort(), ['c3', 'c4']);
  });
}
for (const [value, changed] of [
  [['../../assets/exact.bin'], 'assets/exact.bin'],
  [['*.json'], 'crates/c3/data/.hidden.json'],
]) {
  test('package.include of non-documentation input still widens: ' + changed, () => {
    const { docs, plan } = model();
    docs.get('crates/c3/Cargo.toml').package.include = value;
    assert.deepEqual(plan(changed).reasons, ['cargo-unowned-input']);
  });
}
for (const [field, value] of [
  ['include', ['../../assets/*.json']],
  ['readme', '$OUT/guide.md'],
  ['include', ['sub/*/../../x']],
]) {
  test('uncertain manifest path widens workspace: ' + value, () => {
    const { docs, plan } = model();
    docs.get('crates/c3/Cargo.toml').package[field] = value;
    assert.deepEqual(plan().reasons, ['cargo-manifest-path']);
  });
}
for (const file of ['custom/sub.rs', 'custom/resources', 'shared/generated.rs']) {
  test('linked root target sibling or Rust source widens workspace: ' + file, () => {
    const { docs, entries, plan } = model();
    Object.assign(docs.get('Cargo.toml'), { package: { name: 'root' }, lib: { path: 'custom/lib.rs' } });
    entries.push({ file, mode: '120000' });
    for (const changed of [file, 'crates/c1/src/lib.rs'])
      assert.deepEqual(plan(changed).reasons, ['cargo-linked-input']);
  });
}
test('Build.rs follows the filesystem policy for a default build script', () => {
  const { sources, plan } = model();
  sources.set('crates/c9/Build.rs', 'fn main() {}');
  const windows = process.platform === 'win32';
  assert.deepEqual(plan().reasons, windows ? ['cargo-build-script-input'] : []);
  assert.deepEqual(plan().affectedCrates.sort(), windows ? ['c3', 'c9'] : ['c3']);
  assert.deepEqual(plan('crates/c9/Build.rs').reasons, windows ? [] : ['cargo-unowned-input']);
});

test('package.include cannot claim excluded inputs or files in nested packages', () => {
  const { docs, plan } = model();
  docs.get('Cargo.toml').package = { name: 'game', include: ['**/*', '!assets/debug/**'] };
  for (const file of ['crates/c3/fixtures/a.json', 'assets/debug/map.json'])
    assert.deepEqual(plan(file).reasons, ['cargo-unowned-input'], file);
  // package.include names archive contents, not the only readers: shared data still widens.
  assert.deepEqual(plan('assets/release/map.json').reasons, ['cargo-unowned-input']);
  assert.deepEqual(plan('README.md').affectedCrates, ['game']);
});
test('an unanchored basename include matches descendants, a path with a slash is package-relative', () => {
  const { docs, plan } = model();
  docs.get('crates/c3/Cargo.toml').package.include = ['assets/*.txt', 'LICENSE'];
  assert.deepEqual(plan('crates/c3/nested/assets/skip.txt').reasons, ['cargo-unowned-input']);
  assert.deepEqual(plan('crates/c3/nested/LICENSE').affectedCrates, ['c3']);
});

test('Cargo plans an exported macro from the submitted Git blobs at its invocation site', async t => {
  const { project: cwd } = await fixture(t, {
    'Cargo.toml': '[workspace]\nmembers=["crates/a","crates/b"]',
    'Cargo.lock': 'version=4',
    'crates/a/Cargo.toml': '[package]\nname="a"\nversion="1.0.0"\nedition="2021"',
    'crates/b/Cargo.toml': '[package]\nname="b"\nversion="1.0.0"\nedition="2021"\n[dependencies]\na={path="../a"}',
    'crates/a/src/lib.rs': '#[macro_export] macro_rules! inc { () => { include_str!("../../../data/x.txt") } }',
    'crates/b/src/lib.rs': 'mod nested;',
    'crates/b/src/nested/mod.rs': '#[test] fn reads_data() { assert_eq!(a::inc!(), "base"); }',
    'data/x.txt': 'definition-relative',
    'crates/data/x.txt': 'base',
  });
  const baseSha = await git(cwd, ['rev-parse', 'HEAD']);
  await put(cwd, 'crates/data/x.txt', 'changed');
  await git(cwd, [
    '-c',
    'user.name=test',
    '-c',
    'user.email=t@example.org',
    '-c',
    'commit.gpgSign=false',
    'commit',
    '-qam',
    'edit input',
  ]);
  const plan = await planFastChecks({
    run: { cwd, config: { commands: { test: [] } } },
    baseSha,
    headSha: await git(cwd, ['rev-parse', 'HEAD']),
  });
  assert.deepEqual(plan.reasons, ['cargo-source-path']);
  assert.deepEqual(
    plan.commands.map(step => step.args),
    [['test', '--workspace', '--locked']],
  );
});
