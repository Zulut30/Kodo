import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { expandScopeAlternatives } from '../runtime/cargo-workspace.mjs';
import {
  createPackageFileOwnerResolver,
  plannedPackageDirs,
  scopedDirectoryMatcher,
  selectedManifestRoots,
  selectsCargoManifest,
} from '../runtime/project-blueprint-cargo-scopes.mjs';
import { ownsPath } from '../runtime/scope-paths.mjs';

function candidates(scopes, dirs) {
  const manifests = new Map(dirs.map((dir, i) => [dir, String(i + 1).padStart(40, '0')]));
  return plannedPackageDirs(new Set(scopes), manifests);
}

test('overlapping Cargo directory choices consume one budget entry per distinct path', () => {
  const prefix = 'crates/host/plugins/';
  const platforms = ['', '-win', '-linux', '-mac', '-web', '-ios', '-android'];
  const names = ['exporter', 'exporter-cli', 'reader', 'reader-cli', 'writer-cli', 'writer'];
  const directories = new Set(
    names.flatMap(name => ['', '-cli'].flatMap(suffix => platforms.map(platform => prefix + name + suffix + platform))),
  );
  const pattern =
    prefix + '@(exporter|{exporter-cli|reader|reader-cli|writer-cli,writer})@(|-cli)@(' + platforms.join('|') + ')';
  assert.equal(directories.size, 63);
  assert.equal(expandScopeAlternatives(pattern, 62), null);
  for (const limit of [63, 64]) assert.deepEqual(new Set(expandScopeAlternatives(pattern, limit)), directories);
  assert.deepEqual(new Set(selectedManifestRoots(pattern + '/Cargo.toml')), directories);
  assert.deepEqual(expandScopeAlternatives('{lib,./lib,lib/}', 1), ['lib']);
});

test('choosing a manifest avoids multiplying literal suffix choices in a sibling filename', t => {
  const matcher = t.mock.method(path.posix, 'matchesGlob');
  const manifest = 'plugins/exporter/Cargo.toml';
  const options = { concreteDirectory: true, finiteName: true };
  function count(name, sibling, reverse) {
    const choices = reverse ? [sibling, name] : [name, sibling];
    const before = matcher.mock.callCount();
    assert.equal(
      selectsCargoManifest('plugins/exporter/@(' + choices.join('|') + ')', manifest, options),
      name === 'Cargo.toml',
    );
    return matcher.mock.callCount() - before;
  }
  const suffixes = ['win', 'x64', 'debug', 'en', 'signed', 'bundle', 'local', 'ci']
    .map(tag => '{,-' + tag + '}')
    .join('');
  for (const name of ['Cargo.toml', 'Cargo.tom*'])
    for (const reverse of [false, true])
      assert.equal(count(name, 'release' + suffixes + '.md', reverse), count(name, 'release.md', reverse));
});

test('the expansion limit counts canonical directory paths before visiting their suffix choices', () => {
  const prefix = 'crates/host/plugins/';
  const alias = 'crates/host/{plugins,plugins/}/';
  const suffix = '@(|-cli)@(|-win|-linux|-mac|-web|-ios|-android)';
  const combined = '@(exporter|{exporter-cli|reader|reader-cli|writer-cli,writer})' + suffix;
  const names = ['exporter', 'exporter-cli', 'reader', 'reader-cli', 'writer-cli', 'writer'];
  const split = names.flatMap(name => [...selectedManifestRoots(prefix + name + suffix + '/Cargo.toml')]);
  const expected = new Set(split);
  assert.equal(expected.size, 63);
  for (const dir of expected) assert.ok(ownsPath([alias + combined + '/Cargo.toml'], dir + '/Cargo.toml'));
  for (const limit of [63, 64]) assert.deepEqual(new Set(expandScopeAlternatives(alias + combined, limit)), expected);
  assert.deepEqual(new Set(selectedManifestRoots(alias + combined + '/Cargo.toml')), expected);

  for (const count of [63, 64, 65]) {
    const members = Array.from({ length: count }, (_, i) => 'm' + i);
    const pattern = 'native/{stage/../plugins,plugins/./,plugins}/@(' + members.join('|') + ')';
    const dirs = members.map(name => 'native/plugins/' + name);
    for (const limit of [63, 64, 65]) {
      const branches = expandScopeAlternatives(pattern, limit);
      if (count > limit) assert.equal(branches, null);
      else assert.deepEqual(new Set(branches), new Set(dirs));
    }
  }
});

test('file owner lookup matches a materialized child once per filename pattern', t => {
  const root = 'crates/host/plugins/exporter';
  const docs = root + '/release-win-en.md';
  const owners = createPackageFileOwnerResolver(
    new Map([
      [root, '1'],
      [docs, '2'],
    ]),
    new Map(),
  );
  const matcher = t.mock.method(path.posix, 'matchesGlob');
  const tags = ['win', 'x64', 'debug', 'en', 'signed', 'bundle', 'local', 'ci'];
  for (const n of [0, 4, 8]) {
    const suffix = tags
      .slice(0, n)
      .map(tag => '{,-' + tag + '}')
      .join('');
    const pattern = '@(Cargo.tom*|release' + suffix + '.md)';
    const before = matcher.mock.callCount();
    const found = owners(root + '/' + pattern);
    const calls = matcher.mock.calls
      .slice(before)
      .filter(({ arguments: [name, glob] }) => name === 'src' && glob.includes('release'));
    assert.ok(calls.length <= 1, n + ' suffixes compared with src ' + calls.length + ' times');
    assert.deepEqual(found, new Set(n ? [root, docs] : [root]));
  }
});

test('an oversized directory product leaves an independently named manifest reachable in either arm order', () => {
  const literal = 'crates/host/plugins/exporter';
  const prefix = 'crates/host/{plugins,plugins/}/';
  for (const choices of [6, 8]) {
    const bulk = 'archive' + '{a,b}'.repeat(choices);
    for (const arms of [
      [bulk, 'exporter'],
      ['exporter', bulk],
    ]) {
      for (const group of ['{' + arms.join(',') + '}', '@(' + arms.join('|') + ')']) {
        const scope = prefix + group + '/Cargo.toml';
        assert.equal(expandScopeAlternatives(prefix + group, 64), null);
        assert.ok(ownsPath([scope], literal + '/Cargo.toml'));
        assert.deepEqual([...selectedManifestRoots(scope)], [literal]);
      }
    }
  }
});

test('an empty choice may expose an extglob operator, a brace range or a parent directory', () => {
  for (const [pattern, file] of [
    ['native/src/@{,old}(read.rs|write.rs)', 'native/src/read.rs'],
    ['native/generated/file{1{,x}..3}.rs', 'native/generated/file1.rs'],
    ['stage/.{,old}./native/src/read.rs', 'native/src/read.rs'],
  ]) {
    assert.ok(ownsPath([pattern], file));
    assert.deepEqual(candidates([pattern], ['native']), new Set(['native']));
  }
});

test('literal suffixes in separate directory arms stay within the distinct path budget', () => {
  const plugins = Array.from({ length: 32 }, (_, i) => 'plugin' + i);
  const pattern = 'native/@(' + plugins.map(name => name + '{,-cli}').join('|') + ')';
  const dirs = plugins.flatMap(name => ['native/' + name, 'native/' + name + '-cli']);
  assert.deepEqual(new Set(expandScopeAlternatives(pattern, 64)), new Set(dirs));
  assert.equal(expandScopeAlternatives(pattern, 63), null);
});

test('large independent directory lists leave their product unexpanded', t => {
  const width = 24;
  const list = '@(' + Array.from({ length: width }, (_, i) => 'm' + i).join('|') + ')';
  const product = 'archive/' + [list, list, list].join('/') + '/stage/..';
  const normalize = t.mock.method(path.posix, 'normalize');
  assert.deepEqual([...selectedManifestRoots('native/' + product + '/Cargo.toml')], []);
  // Three lists with 72 written entries would produce 13,824 distinct paths.
  assert.ok(normalize.mock.callCount() <= 2 * 3 * width);
  for (const arms of [
    [product, 'exporter'],
    ['exporter', product],
  ]) {
    const scope = 'native/{' + arms.join(',') + '}/Cargo.toml';
    assert.ok(ownsPath([scope], 'native/exporter/Cargo.toml'));
    assert.deepEqual([...selectedManifestRoots(scope)], ['native/exporter']);
  }
});

test('an oversized directory arm preserves an explicit sibling with a shared navigation suffix', () => {
  const parent = 'crates/host/{plugins,plugins/}/';
  const packageDir = 'crates/host/plugins/exporter';
  const bulk = 'archive' + '@(a|b)'.repeat(12);
  for (const arms of [
    [bulk, 'exporter'],
    ['exporter', bulk],
  ]) {
    const scope = parent + '@(' + arms.join('|') + ')/{tmp/..,cache/..}/Cargo.toml';
    assert.ok(ownsPath([scope], packageDir + '/Cargo.toml'));
    assert.deepEqual([...selectedManifestRoots(scope)], [packageDir]);
  }
  const nested = '{exporter|reader,writer}';
  const named = ['exporter', 'reader', 'writer'].map(name => 'crates/host/plugins/' + name);
  for (const arms of [
    [bulk, nested],
    [nested, bulk],
  ]) {
    const scope = parent + '@(' + arms.join('|') + ')/Cargo.toml';
    for (const dir of named) assert.ok(ownsPath([scope], dir + '/Cargo.toml'));
    assert.deepEqual(new Set(selectedManifestRoots(scope)), new Set(named));
  }
  const differentDepths = 'native/{layouts/v2,plugins}/../{host,worker}';
  const expected = ['native/layouts/host', 'native/layouts/worker', 'native/host', 'native/worker'];
  assert.deepEqual(new Set(expandScopeAlternatives(differentDepths, 4)), new Set(expected));
  assert.deepEqual(new Set(selectedManifestRoots(differentDepths + '/Cargo.toml')), new Set(expected));
  const rootChoice = '{assets/../,configs}/Cargo.toml';
  assert.ok(ownsPath([rootChoice], 'Cargo.toml'));
  assert.deepEqual(new Set(selectedManifestRoots(rootChoice)), new Set(['', 'configs']));
});

test('directory and filename choices discover the same manifest roots after brace expansion', () => {
  const parent = 'crates/host/plugins/';
  for (const [grouped, separate, expected] of [
    [
      '@({codec,cache|exporter})/Cargo.toml',
      ['@(codec)/Cargo.toml', '@(cache|exporter)/Cargo.toml'],
      ['cache', 'codec', 'exporter'],
    ],
    [
      'exporter/Cargo.?({toml,backup)/docs/file})',
      ['exporter/Cargo.?(toml)', 'exporter/Cargo.?(backup)/docs/file)'],
      ['exporter'],
    ],
  ]) {
    const roots = scopes => new Set(scopes.flatMap(scope => [...selectedManifestRoots(parent + scope)]));
    assert.deepEqual(roots(separate), new Set(expected.map(name => parent + name)));
    assert.deepEqual(roots([grouped]), roots(separate), grouped);
  }

  const members = Array.from({ length: 33 }, (_, index) => 'member' + index);
  const grouped = parent + '@(shared|{' + members.join(',') + '})/Cargo.toml';
  assert.deepEqual(new Set(selectedManifestRoots(grouped)), new Set(['shared', ...members].map(name => parent + name)));
});

test('an empty brace alternative inside a class can change the closing bracket', () => {
  const root = 'plugins/exporter';
  const manifest = root + '/Cargo.toml';
  const pattern = root + '/Cargo.tom@([{x,}]*|l])';
  const options = { concreteDirectory: true, finiteName: true };
  assert.ok(ownsPath([pattern], manifest));
  assert.equal(selectsCargoManifest(pattern, manifest, options), true);
});

test('checking a member directory costs the same with optional filename suffixes', t => {
  const normalize = t.mock.method(path.posix, 'normalize');
  const compare = filename => {
    const before = normalize.mock.callCount();
    const descendsInto = scopedDirectoryMatcher(['vendor/exporter.{rs,v2}/docs/' + filename]);
    assert.equal(descendsInto('vendor/exporter.rs'), true);
    assert.equal(descendsInto('vendor/exporter.ts'), false);
    return normalize.mock.callCount() - before;
  };
  assert.equal(compare('guide' + '{,-copy}'.repeat(8) + '.md'), compare('guide.md'));
});

test('a navigation segment in a directory does not multiply optional filename suffixes', t => {
  const normalize = t.mock.method(path.posix, 'normalize');
  const count = filename => {
    const before = normalize.mock.callCount();
    const descendsInto = scopedDirectoryMatcher(['vendor/{./exporter.rs,exporter.v2}/docs/' + filename]);
    assert.equal(descendsInto('vendor/exporter.rs'), true);
    assert.equal(descendsInto('vendor/exporter.v2/docs'), true);
    assert.equal(descendsInto('vendor/other'), false);
    return normalize.mock.callCount() - before;
  };
  const ordinary = count('guide.md');
  for (const filename of [
    'guide{,-draft}{,-en}{,-v2}{,-mobile}.md',
    '{guide,readme}{,-draft}{,-de}',
    '{..,guide}{,-draft}',
  ])
    assert.equal(count(filename), ordinary, filename);
  const navigationOnly = scopedDirectoryMatcher(['vendor/{./exporter.rs,exporter.v2}/docs/{.,..}']);
  assert.equal(navigationOnly('vendor/exporter.rs/docs'), false);
  assert.equal(navigationOnly('vendor/exporter.rs'), true);
});

test('a repeated choice owns a future file in the concrete package directory', () => {
  const scope = 'native/+(@(foo|bar))/src/new.rs';
  assert.ok(ownsPath([scope], 'native/foobar/src/new.rs'));
  assert.deepEqual(candidates([scope], ['native/foobar', 'native/baz']), new Set(['native/foobar']));
});

test('only the owning manifest’s own src tree implies future Rust files from directory scopes', () => {
  const dirs = ['native/engine'];
  for (const suffix of ['', '/**']) {
    const scope = './native/engine/src/parser' + suffix;
    assert.ok(ownsPath([scope], 'native/engine/src/parser/token.rs'));
    assert.deepEqual(candidates([scope], dirs), new Set(dirs), scope);
    assert.deepEqual(candidates(['native/engine/frontend/src/components' + suffix], dirs), new Set());
  }
  assert.deepEqual(candidates(['native/engine/src/README.md'], dirs), new Set());
  const nested = [...dirs, 'native/engine/src/vendor'];
  assert.deepEqual(candidates(['native/engine/src/vendor/frontend/src/**'], nested), new Set());
  assert.deepEqual(candidates(['native/engine/src/vendor/src/**'], nested), new Set(['native/engine/src/vendor']));
});

test('the nearest manifest shadows its parent for the literal and every equivalent singleton mask', () => {
  const dirs = ['native', 'native/fixtures'];
  for (const part of ['fixtures', 'f[i]xtures', '{fixtures,fixtures}']) {
    const scope = 'native/' + part + '/web/parse.rs';
    assert.ok(ownsPath([scope], 'native/fixtures/web/parse.rs'));
    assert.deepEqual(candidates([scope], dirs), new Set(['native/fixtures']), scope);
  }
});

test('Unicode ranges distinguish occupied names from a future directory in the outer package', () => {
  const nested = ['А', 'Б', 'а', 'б'].map(name => 'native/' + name);
  const dirs = ['native', ...nested];
  const future = 'native/Ж/generated/new.rs';
  for (const part of ['[А-Б]', '[А-Я]']) {
    const scope = 'native/' + part + '/generated/new.rs';
    const owners = nested.filter(dir => ownsPath([scope], dir + '/generated/new.rs'));
    if (ownsPath([scope], future)) owners.push('native');
    assert.deepEqual(candidates([scope], dirs), new Set(owners), scope);
  }
});

test('a mask can reach both a nested manifest and future siblings in the outer package', () => {
  const dirs = ['native', 'native/fixtures'];
  for (const part of ['{fixtures,generated}', 'f[iu]xtures', 'fi*xtures', '+(fixtures)']) {
    const scope = 'native/' + part + '/web/parse.rs';
    assert.deepEqual(candidates([scope], dirs), new Set(dirs), scope);
  }
});

test('every filename alternative stays paired with its own directory', () => {
  const dirs = ['native/engine'];
  for (const filename of ['@(read.rs|write.rs)', '{read.rs,write.rs}', 'parse.r[s]']) {
    const scope = 'native/engine/generated/' + filename;
    assert.deepEqual(candidates([scope], dirs), new Set(dirs), scope);
  }
  for (const scopes of [
    ['native/engine/src/README.md', 'native/fixtures/demo.rs'],
    ['native/{engine/src/README.md,fixtures/demo.rs}'],
    ['native/{engine/src/@(README.md|index.ts),fixtures/@(demo.rs|other.rs)}'],
  ])
    assert.deepEqual(candidates(scopes, dirs), new Set(), scopes.join(', '));
});

test('directory extglobs use the canonical matcher, including choices inside repetition or negation', () => {
  const dirs = ['foo', 'bar', 'foobar', 'barfoo', 'other', 'a!'].map(name => 'native/' + name);
  for (const pattern of ['+(@(foo|bar))', '*(@(foo|bar))', '!(foo|bar)', '!(@(foo|bar))']) {
    const scope = 'native/' + pattern + '/gen/new.rs';
    const expected = dirs.filter(dir => ownsPath([scope], dir + '/gen/new.rs'));
    assert.deepEqual(candidates([scope], dirs), new Set(expected), scope);
  }
});

test('large filename choices keep late Rust alternatives and their package boundary', () => {
  const dirs = ['native', 'native/fixtures'];
  const docs = Array.from({ length: 90 }, (_, i) => 'note' + i + '.md');
  for (const leaf of ['@(' + [...docs, 'parse.rs'].join('|') + ')', '{' + [...docs, 'parse.rs'].join(',') + '}']) {
    const scope = 'native/f[i]xtures/web/' + leaf;
    assert.ok(ownsPath([scope], 'native/fixtures/web/parse.rs'));
    assert.deepEqual(candidates([scope], dirs), new Set(['native/fixtures']), scope);
  }
});

test('each concrete directory and file combination selects exactly its deepest manifest', () => {
  const dirs = ['.', 'native', 'native/pkg1', 'native/pkg2', 'native/pkg2/inner', 'other/pkg3'];
  // This language is finite. Enumerate its paths independently of the planned-source resolver.
  const files = [];
  for (const n of [1, 2, 3])
    for (const spelling of ['pkg', 'PKG'])
      for (const suffix of ['parser.rs', 'inner/parser.rs', 'notes/README.md'])
        files.push('native/' + spelling + n + '/' + suffix);
  for (const scope of [
    'native/pkg[12]/inner/parser.rs',
    'native/pkg{1..3}/parser.rs',
    'native/pkg{1..2}/{notes/README.md,inner/parser.rs}',
    'native/{pkg1/notes/README.md,pkg2/inner/parser.rs,pkg3/notes/README.md}',
  ]) {
    const owners = files
      .filter(file => file.endsWith('.rs') && ownsPath([scope], file))
      .map(file => dirs.findLast(dir => dir === '.' || file.startsWith(dir + '/')));
    assert.deepEqual(candidates([scope], dirs), new Set(owners), scope);
  }
});

test('globstar may leave a nested manifest branch only when a concrete path does', () => {
  const dirs = ['native', 'native/fixtures'];
  assert.deepEqual(candidates(['native/f[i]xtures/**/parse.rs'], dirs), new Set(['native/fixtures']));
  assert.deepEqual(candidates(['native/**/fixtures/web/parse.rs'], dirs), new Set(dirs));
});

test('Rust filename evidence belongs to the arm that supplies the extension', () => {
  const dirs = ['native/engine'];
  for (const scope of [
    'native/engine/web/@(README.md|*)',
    'native/{engine/web/**,fixtures/sample.rs}',
    'native/{engine/web/*,fixtures/sample.r[s]}',
  ])
    assert.deepEqual(candidates([scope], dirs), new Set(), scope);
  for (const file of ['sample{01..03}.r[s]', 'sample[.]r[s]', 'sample.+(@(r|s))']) {
    assert.deepEqual(candidates(['native/engine/generated/' + file], dirs), new Set(dirs), file);
  }
});

test('a literal subtree scope also owns Rust files under a hidden nested crate', () => {
  const dirs = ['native', 'native/.hidden'];
  for (const scope of ['native', 'native/**']) {
    assert.ok(ownsPath([scope], 'native/.hidden/src/new.rs'));
    assert.deepEqual(candidates([scope], dirs), new Set(dirs), scope);
  }
});

test('future directories remain reachable when early spellings are occupied or excluded', () => {
  for (const [part, occupied, name] of [
    ['!(*[!b]*|b|bbb*)', [], 'bb'],
    ['+({foo,bar})', ['foo', 'bar', 'foofoo', 'barbar', 'foofoofoo', 'barbarbar'], 'foofoofoofoo'],
    ['@(Cargo.toml|generated)', [], 'generated'],
  ]) {
    const dirs = ['native', ...occupied.map(dir => 'native/' + dir)];
    const scope = 'native/' + part + '/web/new.rs';
    assert.ok(ownsPath([scope], 'native/' + name + '/web/new.rs'));
    assert.deepEqual(candidates([scope], dirs), new Set(dirs), scope);
  }
});

test('a brace alternative can change depth before the manifest prefix is matched', () => {
  const dirs = ['native/engine'];
  for (const scope of [
    'native/scratch/{..,other}/engine/new.rs',
    'native/{scratch/../engine,other}/new.rs',
    'native/engine/{,generated}/new.rs',
  ]) {
    assert.ok(ownsPath([scope], 'native/engine/new.rs'));
    assert.deepEqual(candidates([scope], dirs), new Set(dirs), scope);
  }
});

test('Cargo follows brace expansion before interpreting bracket expressions', () => {
  const dirs = ['native/engine'];
  const file = 'native/engine/src/new.rs';
  for (const prefix of ['stage/{v[1,..,2],cache}/', 'stage/{[,..,]}/', 'stage/{v[1,.,2],cache}/']) {
    const scope = prefix + file;
    const expected = ownsPath([scope], file) ? dirs : [];
    assert.deepEqual(candidates([scope], dirs), new Set(expected), scope);
  }
});

test('future Rust sources use the literal and glob meanings of a tracked package name independently', () => {
  const dirs = ['native/[client]', 'native/c', 'native/client'];
  for (const [scope, suffix] of [
    ['native/[client]/src/new.rs', '/src/new.rs'],
    ['native/[client]/src/**', '/src/future.rs'],
    ['native/[client]/src/parser', '/src/parser/future.rs'],
    ['native/[client]/src/README.md', '/src/new.rs'],
  ]) {
    const expected = dirs.filter(dir => ownsPath([scope], dir + suffix));
    assert.deepEqual(candidates([scope], dirs), new Set(expected), scope);
  }
});

test('a known literal package directory owns future bracketed filenames and subdirectories', () => {
  const dirs = ['native/[client]', 'native/c'];
  for (const [scope, globFile] of [
    ['native/[client]/src/model/[id].rs', 'native/c/src/model/i.rs'],
    ['native/[client]/src/pages/[id]/new.rs', 'native/c/src/pages/i/new.rs'],
    ['native/[client]/src/pages/[id]/**', 'native/c/src/pages/i/new.rs'],
  ]) {
    const literalFile = scope.endsWith('/**') ? scope.slice(0, -2) + 'new.rs' : scope;
    assert.ok(ownsPath([scope], literalFile));
    assert.ok(ownsPath([scope], globFile));
    assert.deepEqual(candidates([scope], dirs), new Set(dirs), scope);
  }
  const nested = 'native/[client]/src/pages/[id]';
  assert.deepEqual(candidates([nested + '/new.rs'], [...dirs, nested]), new Set([nested, 'native/c']));
  assert.deepEqual(candidates(['native/[client]/src/model/[id].ts'], dirs), new Set());
});

test('brace ranges that emit an empty string can normalize a planned path', () => {
  const dirs = ['native/foobar'];
  const file = 'native/foobar/src/new.rs';
  for (const prefix of [
    'stage/.{Z..a}./',
    'stage/.{a..Z}./',
    'stage/.{Z..a..2}./',
    'stage/.{Z..a..3}./',
    'stage/.{A..Z}./',
    'stage/.{Z..a}{Z..a}./',
    'stage/{v,.{Z..a}.}/',
    '{Z..a}/',
  ]) {
    const scope = prefix + file;
    assert.deepEqual(candidates([scope], dirs), new Set(ownsPath([scope], file) ? dirs : []), scope);
  }
  const packages = ['native/Z', 'native/a', 'native/zebra'];
  for (const scope of ['stage/.{Z..a}./native/{Z..a}/src/new.rs', 'native/{Z..a}/stage/.{Z..a}./src/new.rs']) {
    const expected = packages.filter(dir => ownsPath([scope], dir + '/src/new.rs'));
    assert.deepEqual(candidates([scope], packages), new Set(expected), scope);
  }
});

test('ordinary filename ranges share one normalized path layout', t => {
  const normalized = t.mock.method(path.posix, 'normalize', path.posix.normalize);
  const directories = [
    'web',
    '{apps/web,apps/admin,sites/blog,sites/docs}',
    '{views/search,views/list,views/item,parts/nav}',
    '{themes/light,themes/dark,styles/base,styles/brand}',
    '{locales/fr,locales/es,locales/de,locales/pl}',
  ].join('/');
  for (const name of ['version-a.ts', 'version-{a..c}.ts', 'version-{Z..a..3}.ts', 'version{Z..a}{Z..a}{Z..a}.js']) {
    const before = normalized.mock.callCount();
    assert.deepEqual(candidates([directories + '/' + name], ['native/engine']), new Set());
    assert.equal(normalized.mock.callCount() - before, 1, name);
  }
});

test('astral filename characters can span glob atoms in a future Rust source', () => {
  const dirs = ['native/engine'];
  const prefix = 'native/engine/src/';
  for (const [pattern, filename] of [
    ['[🦀]*.rs', '🦀parser.rs'],
    ['[🦀]?.rs', '🦀.rs'],
    ['?[🦀].rs', '🦀.rs'],
    ['[🦀][🦀].rs', '🦀.rs'],
    ['[🦀].rs', '🦀.rs'],
    ['[🦀]*.ts', '🦀parser.rs'],
  ]) {
    const scope = prefix + pattern;
    const expected = ownsPath([scope], prefix + filename) ? dirs : [];
    assert.deepEqual(candidates([scope], dirs), new Set(expected), pattern);
  }
});

test('the native POSIX matcher determines whether a differently cased spelling can escape a Git directory', () => {
  const dirs = ['native', 'native/fixtures'];
  const scope = 'native/@(fixtures)/generated/test.rs';
  const expected = new Set(['native/fixtures']);
  if (ownsPath([scope], 'native/Fixtures/generated/test.rs')) expected.add('native');
  assert.deepEqual(candidates([scope], dirs), expected);
});
