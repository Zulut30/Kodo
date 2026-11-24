import test from 'node:test';
import assert from 'node:assert/strict';
import { affectedCrates } from '../runtime/cargo-graph.mjs';

function model() {
  const docs = new Map([['Cargo.toml', { workspace: { members: ['crates/*'] } }]]);
  for (let i = 0; i < 10; i++)
    docs.set('crates/c' + i + '/Cargo.toml', { package: { name: 'c' + i, version: '1.0.0' } });
  const sources = new Map(),
    entries = [];
  const plan = (file = 'crates/c3/src/lib.rs') => affectedCrates(docs, [file], { sources, entries });
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
  const { fixture, put } = await import('./fixtures/quality/helpers.mjs');
  const { git } = await import('../runtime/workspace.mjs');
  const { planFastChecks } = await import('../runtime/task-fast-checks.mjs');
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
