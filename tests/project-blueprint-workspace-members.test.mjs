import assert from 'node:assert/strict';
import { ChildProcess, execFileSync } from 'node:child_process';
import { cp, mkdtemp, readFile, realpath, rename, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { compileBlueprint } from '../runtime/project-blueprint.mjs';
import { put } from './fixtures/quality/helpers.mjs';

const manifest = name => `[package]\nname="${name}"\nversion="0.1.0"\nedition="2021"\n`;
const workspace = (members, exclude = []) =>
  `[workspace]\nresolver="2"\nmembers=${JSON.stringify(members)}\nexclude=${JSON.stringify(exclude)}\n`;
const broad = ['contract_scope_too_broad'];
const threshold = ['contract_crate_required'];
const unavailable = ['blueprint_cargo_evidence_unavailable'];
const schema = 'schemas/v2.proto';
const side = 'examples/snapshot';
const mainMembers = ['native/codec', 'native/client', 'native/server'];

async function fixture(t, rootManifest = workspace(mainMembers, [side])) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'kodo-blueprint-members-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  await cp(new URL('./fixtures/blueprint/valid/', import.meta.url), path.join(root, '.kodo/blueprint'), {
    recursive: true,
  });
  const specPath = '.kodo/blueprint/spec.json';
  const spec = JSON.parse(await readFile(path.join(root, specPath), 'utf8'));
  spec.root = root;
  const write = (file, text) => put(root, file, text);
  const git = (...args) =>
    execFileSync(
      'git',
      [
        '-c',
        'user.name=Fixture',
        '-c',
        'user.email=test@example.invalid',
        '-c',
        'core.hooksPath=',
        '-c',
        'commit.gpgSign=false',
        ...args,
      ],
      { cwd: root, encoding: 'utf8', windowsHide: true, stdio: 'pipe' },
    ).trim();
  const commit = () => {
    git('add', '.');
    git('commit', '-qm', 'Blueprint membership fixture');
    return git('rev-parse', 'HEAD');
  };
  await write('.gitignore', '/.kodo/blueprint/\n');
  await write('Cargo.toml', rootManifest);
  await write('architecture.policy.json', { schemaVersion: 2, language: 'rust', contractCrates: ['wire-contracts'] });
  await write(side + '/Cargo.toml', workspace(['wire', 'sample']));
  for (const [dir, name] of [
    ['native/codec', 'wire-contracts'],
    ['native/client', 'client'],
    ['native/server', 'server'],
    [side + '/wire', 'wire-contracts'],
    [side + '/sample', 'sample'],
  ]) {
    await write(dir + '/Cargo.toml', manifest(name));
    await write(dir + '/src/lib.rs', 'pub struct Message;\n');
  }
  git('init', '-q');
  const compile = async (writePaths, options = {}) => {
    spec.tasks.find(task => task.id === 'storage-module').writePaths = writePaths;
    await write(specPath, spec);
    const result = await compileBlueprint(root, { hasRustToolchain: true, ...options });
    return result.findings.map(row => row.code);
  };
  return { root, git, commit, write, compile, spec };
}

test('Wave 0 follows Cargo member spellings and exclusions in draft and registration', async t => {
  const f = await fixture(t);
  const windows = path.sep === '\\';
  const sources = mainMembers.map(dir => dir + '/src/lib.rs');
  for (const [membership, exclude, includesCodec] of [
    [['native\\codec'], [], windows],
    [['Native/Codec'], [], windows],
    [['Native/co*'], [], windows],
    [['native/Co*'], [], false],
    [['native/*'], ['native\\codec'], !windows],
    [['native/*'], ['native/Codec'], true],
    [['native/*', 'native/Codec'], ['native/codec'], windows],
  ]) {
    await f.write('Cargo.toml', workspace([...mainMembers.slice(1), ...membership], exclude));
    f.commit();
    for (const forRegistration of [false, true])
      assert.deepEqual(
        await f.compile(sources, { forRegistration }),
        includesCodec ? threshold : [],
        String(membership),
      );
  }
});

test('Wave 0 reads directory witnesses for a Cargo parent step from the selected tree', async t => {
  const f = await fixture(t, workspace([...mainMembers.slice(1), 'vault/*/slots/.[.]/Bridge']));
  await f.write(
    'vault/site/Bridge/Cargo.toml',
    manifest('bridge') + '[dependencies]\nwire-contracts={path="../../../native/codec"}\n',
  );
  await f.write('vault/site/Bridge/src/lib.rs', '');
  await f.write('vault/site/slots', 'regular file');
  f.commit();
  const paths = mainMembers.map(dir => dir + '/src/lib.rs');
  assert.deepEqual(await f.compile(paths, { forRegistration: true }), []);
  await rename(path.join(f.root, 'vault/site/slots'), path.join(f.root, 'vault/site/old'));
  await f.write('vault/site/slots/marker', '');
  f.git('add', 'vault/site');
  assert.deepEqual(await f.compile(paths), threshold);
  assert.deepEqual(await f.compile(paths, { forRegistration: true }), []);
  f.commit();
  assert.deepEqual(await f.compile(paths, { forRegistration: true }), threshold);
});

test('a literal Cargo member does not require listing a separate dot glob subtree', async t => {
  const f = await fixture(t, workspace([...mainMembers, 'vault/*/pivot/.?/Bridge']));
  await f.write('vault/site/pivot/marker', '');
  await f.write('vault/site/Bridge/Cargo.toml', manifest('bridge'));
  await f.write('vault/site/Bridge/src/lib.rs', '');
  f.commit();
  const spawn = t.mock.method(ChildProcess.prototype, 'spawn');
  const codes = await f.compile(['native/client/src/lib.rs'], { forRegistration: true });
  const enumerations = spawn.mock.calls
    .map(call => call.arguments[0].args)
    .filter(args => args.includes('ls-tree') && args.includes('-r') && args.includes('vault'));
  assert.deepEqual(codes, []);
  assert.deepEqual(enumerations, []);
});

test('a future Cargo member may supply its own parent step without enrolling its sibling', async t => {
  const f = await fixture(t, workspace([...mainMembers.slice(1), 'addons/*/*/.?/Bridge']));
  await f.write('addons/live/pivot/marker', '');
  await f.write('addons/live/Bridge/Cargo.toml', manifest('anchor'));
  await f.write('addons/live/Bridge/src/lib.rs', '');
  f.commit();
  const sources = mainMembers.slice(1).map(dir => dir + '/src/lib.rs');
  const paths = dir => [...sources, dir + '/Cargo.toml', dir + '/src/lib.rs'];
  const planned = 'addons/next/Bridge';
  for (const forRegistration of [false, true]) {
    assert.deepEqual(await f.compile(paths(planned), { forRegistration }), threshold);
    assert.deepEqual(await f.compile(paths('addons/next/Peer'), { forRegistration }), []);
  }
  await f.write(planned + '/Cargo.toml', manifest('new-member'));
  await f.write(planned + '/src/lib.rs', '');
  f.commit();
  assert.deepEqual(await f.compile(paths(planned), { forRegistration: true }), threshold);
});

test('Wave 0 counts packages selected by a Unicode wildcard or another recursive walk', async t => {
  const roots = mainMembers.slice(1);
  const scalar = 'extras/📦/Exporter';
  const nested = 'extras/plugins/Exporter/vendor/plugins/exporter/Unit';
  const alternate = nested.replace('vendor/plugins/exporter', 'vendor/plugins/Exporter');
  const recursive = 'extras/**/plugins/Exporter/**/Unit';
  const f = await fixture(t);
  for (const [i, dir] of [scalar, 'extras/ab/Exporter', nested, 'extras/anchor/plugins/Exporter/Unit'].entries()) {
    await f.write(dir + '/Cargo.toml', manifest('extension-' + i));
    await f.write(dir + '/src/lib.rs', '');
  }
  for (const [pattern, dir, exclude, required] of [
    ['extras/?/Exporter', scalar, [], true],
    ['extras/??/Exporter', scalar, [], false],
    [recursive, nested, [nested], path.sep === '\\'],
    [recursive, nested, [nested, alternate], false],
  ]) {
    await f.write('Cargo.toml', workspace([...roots, pattern], exclude));
    f.commit();
    const paths = [...roots, dir].map(root => root + '/src/lib.rs');
    for (const forRegistration of [false, true])
      assert.deepEqual(await f.compile(paths, { forRegistration }), required ? threshold : [], pattern);
  }
});

test('Wave 0 follows dependencies only from bridges selected within a Cargo glob component', async t => {
  const f = await fixture(t);
  const visible = 'sensors/axpkg/Bridge';
  const other = 'sensors/𠮷/pkg/Bridge';
  await f.write(visible + '/Cargo.toml', manifest('selected-bridge'));
  await f.write(
    other + '/Cargo.toml',
    manifest('nested-bridge') + '\n[dependencies]\nwire-contracts={path="../../../../native/codec"}\n',
  );
  for (const dir of [visible, other]) await f.write(dir + '/src/lib.rs', '');
  for (const [member, expected] of [
    ['sensors/?[!z]pkg/Bridge', []],
    ['sensors/?/pkg/Bridge', threshold],
  ]) {
    await f.write('Cargo.toml', workspace([...mainMembers.slice(1), member]));
    f.commit();
    for (const forRegistration of [false, true])
      assert.deepEqual(
        await f.compile(
          mainMembers.map(dir => dir + '/src/lib.rs'),
          { forRegistration },
        ),
        expected,
        member,
      );
  }
});

test('Cargo path dependencies use native separators when counting workspace packages', async t => {
  const members = ['native/client', 'native/server'];
  const f = await fixture(t, workspace(members));
  const sources = mainMembers.map(dir => dir + '/src/lib.rs');
  for (const separator of ['/', '\\']) {
    const relative = ['..', 'codec'].join(separator);
    const workspaceRoot = ['..', '..'].join(separator);
    await f.write(
      'native/client/Cargo.toml',
      manifest('client') + "[dependencies]\nwire-contracts={path='" + relative + "'}\n",
    );
    await f.write('native/codec/Cargo.toml', manifest('wire-contracts') + "workspace='" + workspaceRoot + "'\n");
    f.commit();
    const expected = separator === '/' || path.sep === '\\' ? threshold : [];
    for (const forRegistration of [false, true])
      assert.deepEqual(await f.compile(sources, { forRegistration }), expected, relative);
  }
  const inherited = ['native', 'codec'].join(path.sep);
  await f.write('native/client/Cargo.toml', manifest('client') + '[dependencies]\nwire-contracts.workspace=true\n');
  await f.write('native/codec/Cargo.toml', manifest('wire-contracts'));
  await f.write(
    'Cargo.toml',
    workspace(members) + "[workspace.dependencies]\nwire-contracts={path='" + inherited + "'}\n",
  );
  f.commit();
  assert.deepEqual(await f.compile(sources, { forRegistration: true }), threshold);
});

test('an indirect Cargo member can be reached through the native spelling of its declaring member', async t => {
  const f = await fixture(t, workspace(['Support/Bridge', ...mainMembers.slice(1)]));
  await f.write(
    'support/bridge/Cargo.toml',
    manifest('bridge') + '[dependencies]\nwire-contracts={path="../../native/codec"}\n',
  );
  await f.write('support/bridge/src/lib.rs', '');
  f.commit();
  for (const forRegistration of [false, true]) {
    assert.deepEqual(
      await f.compile(
        mainMembers.map(dir => dir + '/src/lib.rs'),
        { forRegistration },
      ),
      path.sep === '\\' ? threshold : [],
    );
  }
});

test('a sibling dependency uses its selected spelling for workspace exclusions', async t => {
  const f = await fixture(t);
  const members = mainMembers.slice(1);
  const sources = mainMembers.map(dir => dir + '/src/lib.rs');
  const direct = '[dependencies]\nwire-contracts={path="../Codec"}\n';
  const inherited = '[workspace.dependencies]\nwire-contracts={path="native/Codec"}\n';
  await f.write(
    'support/relay/Cargo.toml',
    manifest('relay') + '[dependencies]\nwire-contracts={path="../../native/Codec"}\n',
  );
  await f.write('support/relay/src/lib.rs', '');
  for (const [client, rootDeps, exclude, included] of [
    [direct, '', 'native/codec', true],
    ['[dev-dependencies]\nwire-contracts.workspace=true\n', inherited, 'native/codec', true],
    ['[dependencies]\nrelay={path="../../support/relay"}\n', '', 'native/codec', true],
    [direct, '', 'native/Codec', false],
    ['', '', 'native/codec', false],
  ]) {
    await f.write('Cargo.toml', workspace(members, [exclude]) + rootDeps);
    await f.write('native/client/Cargo.toml', manifest('client') + client);
    f.commit();
    for (const forRegistration of [false, true]) {
      const belongs = included && path.sep === '\\';
      assert.deepEqual(await f.compile(sources, { forRegistration }), belongs ? threshold : []);
      assert.deepEqual(await f.compile(['native/cod*/' + schema], { forRegistration }), belongs ? broad : []);
    }
  }
});

test(
  'an excluded package reached through a native alias requires its dependency evidence',
  {
    skip: path.sep !== '\\',
  },
  async t => {
    const f = await fixture(t, workspace(mainMembers.slice(1), ['native/codec']));
    const mask = ['native/cod*/' + schema];
    const bridge = 'support/relay/Cargo.toml';
    await f.write('native/server/Cargo.toml', 'invalid TOML');
    await f.write(
      'native/client/Cargo.toml',
      manifest('client') + '[dependencies]\nrelay={path="../../support/relay"}\n',
    );
    await f.write(bridge, manifest('relay') + '[dependencies]\nwire-contracts={path="../../native/Codec"}\n');
    f.commit();
    assert.deepEqual(await f.compile(mask, { forRegistration: true }), broad);

    await f.write(bridge, 'invalid TOML');
    f.commit();
    assert.deepEqual(await f.compile(mask, { forRegistration: true }), unavailable);
    for (const members of [
      ['native/client', 'support/relay'],
      ['support/relay', 'native/client'],
    ]) {
      await f.write('Cargo.toml', workspace(members, ['native/codec']));
      f.commit();
      assert.deepEqual(await f.compile(mask, { forRegistration: true }), unavailable);
    }
  },
);

test('Wave 0 counts an excluded plugin reachable below a literal workspace member', async t => {
  const f = await fixture(t);
  const host = 'native/client';
  const plugin = host + '/plugins/exporter';
  const glob = host + '/plugins/*';
  await f.write(plugin + '/Cargo.toml', manifest('wire-contracts'));
  await f.write(plugin + '/src/lib.rs', '');
  const writes = [host + '/src/lib.rs', 'native/server/src/lib.rs', plugin + '/Cargo.toml', plugin + '/src/lib.rs'];
  for (const [members, dependency, included, exclude = [plugin]] of [
    [[host, glob], false, true],
    [[host], true, true],
    [[host], false, false],
    [['native/clien?', glob], false, false],
    [['native/other/../client', glob], false, false],
    [['native/clien?', glob], false, false, [plugin + '/Cargo.toml']],
    [['.', host, glob], false, true],
    ...(path.sep === '\\'
      ? [
          [['Native/Client'], true, true],
          [['Native/Client', glob], false, false],
        ]
      : []),
  ]) {
    await f.write('Cargo.toml', workspace([...members, 'native/server'], exclude));
    await f.write(
      host + '/Cargo.toml',
      manifest('client') + (dependency ? '[dependencies]\nwire-contracts={path="plugins/exporter"}\n' : ''),
    );
    f.commit();
    for (const forRegistration of [false, true]) {
      assert.deepEqual(await f.compile(writes, { forRegistration }), included ? threshold : []);
      assert.deepEqual(await f.compile([glob + '/' + schema], { forRegistration }), included ? broad : []);
    }
  }
});

test('a planned contract respects the nearest existing package for each grouped file scope', async t => {
  const outer = 'crates/api-contracts';
  const child = outer + '/codegen';
  const other = 'tools/renderer';
  const f = await fixture(t, workspace([child, other]));
  await rm(path.join(f.root, 'architecture.policy.json'));
  for (const id of ['web-module', 'api-module'])
    f.spec.tasks.find(task => task.id === id).dependsOn.push('storage-module');
  f.spec.constraints.push('workspaceRoot: .', 'contractCrate: ' + outer);
  f.spec.tasks.find(task => task.id === 'scaffold').writePaths = [
    'Cargo.toml',
    outer + '/Cargo.toml',
    outer + '/src/lib.rs',
    'architecture.policy.json',
  ];
  for (const [dir, name] of [
    [child, 'codegen'],
    [other, 'renderer'],
  ]) {
    await f.write(dir + '/Cargo.toml', manifest(name));
    await f.write(dir + '/src/lib.rs', '');
    await f.write(dir + '/' + schema, 'syntax = "proto3";\n');
  }
  f.commit();
  for (const materialized of [false, true]) {
    if (materialized) {
      await f.write('Cargo.toml', workspace([child, other, outer]));
      await f.write(outer + '/Cargo.toml', manifest('api-contracts'));
      await f.write(outer + '/src/lib.rs', '');
      f.commit();
    }
    for (const [scope, expected] of [
      [child, []],
      ['{' + child + '}', []],
      ['{' + child + ',' + other + '}', []],
      ['{' + outer + '}', broad],
      ['{' + child + ',' + outer + '}', broad],
    ]) {
      for (const forRegistration of [false, true])
        assert.deepEqual(await f.compile([scope + '/' + schema], { forRegistration }), expected, scope);
    }
  }
});

test('an independent workspace can change its namesake package under data, source and manifest scopes', async t => {
  const f = await fixture(t);
  f.commit();
  for (const file of [schema, 'src/new.rs', 'Cargo.toml']) {
    const copy = side + '/*/' + file;
    const parent = 'native/cod*/' + file;
    for (const forRegistration of [false, true]) {
      assert.deepEqual(await f.compile([copy], { forRegistration }), [], copy);
      assert.deepEqual(await f.compile([parent, copy], { forRegistration }), broad, parent);
    }
  }
  assert.deepEqual(await f.compile(['native/codec/Cargo.toml', side + '/*/Cargo.toml']), []);
  assert.deepEqual(await f.compile([side + '/Cargo.toml', side + '/*/Cargo.toml']), []);
  const two = ['native/codec/src/lib.rs', 'native/client/src/lib.rs'];
  assert.deepEqual(await f.compile([...two, side + '/wire/src/lib.rs']), []);
  assert.deepEqual(await f.compile([...two, 'native/server/src/lib.rs']), threshold);
  assert.deepEqual(
    await f.compile([side + '/*/' + schema], { packageNames: { [side + '/wire']: 'wire-contracts' } }),
    broad,
  );
  await f.write('Cargo.toml', workspace(mainMembers)); // Still an independent workspace, without an explicit exclude.
  assert.deepEqual(await f.compile([side + '/*/' + schema]), []);
});

test('draft and registration use the workspace members of their own snapshot', async t => {
  const f = await fixture(t);
  f.commit();
  await f.write('Cargo.toml', workspace(['native/*'], ['native/codec', side]));
  const scopes = ['native/cod*/' + schema];
  assert.deepEqual(await f.compile(scopes), []);
  assert.deepEqual(await f.compile(scopes, { forRegistration: true }), broad);
  f.commit();
  assert.deepEqual(await f.compile(scopes, { forRegistration: true }), []);
  // Cargo gives an explicitly named member precedence over the exclude subtree.
  await f.write('Cargo.toml', workspace(['native/*', './native/codec/'], ['native/codec', side]));
  assert.deepEqual(await f.compile(scopes), broad);
});

test('an independently declared workspace protects its explicitly declared contract', async t => {
  const f = await fixture(t);
  f.commit();
  f.spec.constraints.push('workspaceRoot: ' + side);
  for (const contract of [side + '/wire', 'wire-contracts']) {
    f.spec.constraints.push('contractCrate: ' + contract);
    for (const forRegistration of [false, true]) {
      assert.deepEqual(await f.compile([side + '/*/' + schema], { forRegistration }), broad);
      assert.deepEqual(await f.compile([side + '/wire/' + schema], { forRegistration }), []);
      assert.deepEqual(await f.compile([side + '/sam*/' + schema], { forRegistration }), []);
    }
    f.spec.constraints.pop();
  }
});

test('three planned members need a Wave 0 contract from their own workspace', async t => {
  const f = await fixture(t);
  const inner = [side + '/wire', side + '/sample', side + '/extra'];
  await f.write(side + '/Cargo.toml', workspace(['wire', 'sample', 'extra']));
  await f.write(side + '/extra/Cargo.toml', manifest('extra'));
  await f.write(side + '/extra/src/lib.rs', '');
  f.commit();
  f.spec.constraints.push('workspaceRoot: ' + side);
  const scaffold = f.spec.tasks.find(task => task.id === 'scaffold');
  for (const [planned, correct, namesake] of [
    [mainMembers, 'native/codec', side + '/wire'],
    [inner, side + '/wire', 'native/codec'],
  ]) {
    const paths = planned.map(dir => dir + '/src/lib.rs');
    for (const [contract, expected] of [
      [namesake, threshold],
      [correct, []],
    ]) {
      scaffold.writePaths = [contract + '/Cargo.toml', contract + '/src/lib.rs'];
      assert.deepEqual(await f.compile(paths, { forRegistration: true }), expected);
    }
  }
  // These two packages explicitly belong to the outer workspace. The
  // declared root package of the inner one cannot make them its third crate.
  const outer = inner.slice(1);
  await f.write('Cargo.toml', workspace(['native/codec', ...outer]));
  await f.write(side + '/Cargo.toml', manifest('snapshot') + workspace(['wire']));
  for (const dir of outer) await f.write(dir + '/Cargo.toml', manifest(path.basename(dir)) + 'workspace="../../.."\n');
  f.spec.constraints.push('rootPackage: ' + side);
  scaffold.writePaths = ['package.json', 'tooling'];
  assert.deepEqual(await f.compile(outer.map(dir => dir + '/src/lib.rs')), []);
});

test('a declared workspace can satisfy Wave 0 and protect files only at a member contract', async t => {
  const f = await fixture(t);
  const wire = side + '/wire';
  const archive = side + '/fixtures/v1';
  const members = [wire, side + '/sample', side + '/producer'];
  await f.write(side + '/Cargo.toml', workspace(['wire', 'sample', 'producer'], ['fixtures']));
  await f.write(wire + '/Cargo.toml', manifest('message-schema'));
  await f.write(archive + '/Cargo.toml', manifest('message-schema'));
  await f.write(archive + '/src/lib.rs', '');
  await f.write(side + '/producer/Cargo.toml', manifest('producer'));
  await f.write(side + '/producer/src/lib.rs', '');
  f.commit();
  const scaffold = f.spec.tasks.find(task => task.id === 'scaffold');
  const planned = members.map(dir => dir + '/src/lib.rs');
  f.spec.constraints.push('workspaceRoot: ' + side);
  assert.deepEqual(await f.compile([...planned.slice(0, 2), archive + '/src/lib.rs']), []);
  for (const token of ['message-schema', wire, archive]) {
    f.spec.constraints.push('contractCrate: ' + token);
    scaffold.writePaths = [archive + '/Cargo.toml', archive + '/src/lib.rs'];
    assert.deepEqual(await f.compile(planned, { forRegistration: true }), threshold, token);
    scaffold.writePaths = [wire + '/Cargo.toml', wire + '/src/lib.rs'];
    assert.deepEqual(await f.compile(planned), token === archive ? threshold : [], token);
    for (const file of [schema, 'src/new.rs', 'Cargo.toml']) {
      assert.deepEqual(await f.compile([side + '/fixtures/*/' + file]), [], file);
      assert.deepEqual(await f.compile([side + '/w*/' + file]), token === archive ? [] : broad, file);
    }
    if (token === 'message-schema') {
      assert.deepEqual(await f.compile([side + '/fixtures/*/' + schema], { architecturePolicy: null }), []);
      assert.deepEqual(await f.compile([side + '/w*/' + schema], { architecturePolicy: null }), broad);
    }
    f.spec.constraints.pop();
  }
  await f.write(archive + '/Cargo.toml', 'invalid TOML');
  f.commit();
  f.spec.constraints.push('contractCrate: message-schema');
  const archiveScopes = [schema, 'src/new.rs', 'Cargo.toml'].map(file => side + '/fixtures/*/' + file);
  assert.deepEqual(await f.compile(archiveScopes, { forRegistration: true }), []);
});

test('a future crate counts in its declared workspace before and after its manifest exists', async t => {
  const f = await fixture(t);
  const future = side + '/crates/export';
  const futurePaths = [future + '/Cargo.toml', future + '/src/lib.rs'];
  const outer = mainMembers.slice(0, 2).map(dir => dir + '/src/lib.rs');
  const inner = ['wire', 'sample'].map(dir => side + '/' + dir + '/src/lib.rs');
  await f.write(side + '/Cargo.toml', workspace(['wire', 'sample', 'crates/*']));
  await f.write(side + '/crates/seed/Cargo.toml', manifest('seed'));
  await f.write(side + '/crates/seed/src/lib.rs', '');
  f.commit();
  for (const materialized of [false, true]) {
    if (materialized) {
      await f.write(futurePaths[0], manifest('export'));
      await f.write(futurePaths[1], '');
      f.commit();
    }
    assert.deepEqual(await f.compile([...outer, ...futurePaths], { forRegistration: true }), []);
    f.spec.constraints.push('workspaceRoot: ' + side);
    assert.deepEqual(await f.compile([...outer, ...futurePaths]), []);
    assert.deepEqual(await f.compile([...inner, ...futurePaths], { forRegistration: true }), threshold);
    f.spec.constraints.pop();
  }
});

test('a nested workspace resolves its own transitive and explicit members at the selected revision', async t => {
  const f = await fixture(t);
  const inner =
    workspace(['apps/[ab]'], ['fixtures']) +
    '[workspace.dependencies]\nprotocol={package="message-schema",path="wire"}\n';
  await f.write(side + '/Cargo.toml', inner);
  await f.write(side + '/wire/Cargo.toml', manifest('message-schema'));
  await f.write(side + '/apps/a/Cargo.toml', manifest('app') + '[dependencies]\nbridge={path="../../shared/bridge"}\n');
  await f.write(side + '/apps/a/src/lib.rs', '');
  const bridge = side + '/shared/bridge/Cargo.toml';
  await f.write(bridge, manifest('bridge') + "[target.'cfg(unix)'.build-dependencies]\nprotocol.workspace=true\n");
  await f.write(side + '/shared/bridge/src/lib.rs', '');
  f.commit();
  f.spec.constraints.push('workspaceRoot: ' + side, 'contractCrate: message-schema');
  const scopes = [side + '/w*/' + schema];
  const planned = ['apps/a', 'shared/bridge', 'wire'].map(dir => side + '/' + dir + '/src/lib.rs');
  assert.deepEqual(await f.compile(scopes, { forRegistration: true }), broad);
  assert.deepEqual(await f.compile(planned), threshold);
  const scaffold = f.spec.tasks.find(task => task.id === 'scaffold');
  const initialPaths = scaffold.writePaths;
  scaffold.writePaths = [side + '/wire/Cargo.toml', side + '/wire/src/lib.rs'];
  assert.deepEqual(await f.compile(planned), []);
  scaffold.writePaths = initialPaths;
  await f.write(bridge, manifest('bridge'));
  assert.deepEqual(await f.compile(scopes), []);
  assert.deepEqual(await f.compile(planned), []);
  assert.deepEqual(await f.compile(scopes, { forRegistration: true }), broad);
  f.commit();
  assert.deepEqual(await f.compile(scopes, { forRegistration: true }), []);
  await f.write(side + '/Cargo.toml', workspace(['apps/a', 'wire'], ['wire']));
  assert.deepEqual(await f.compile(scopes), broad, 'an explicit member wins over the local exclude');
});

test('a scaffold can extend a member list or create the workspace manifest in Wave 0', async t => {
  const f = await fixture(t, workspace(mainMembers.slice(0, 2), [side]));
  const scaffold = f.spec.tasks.find(task => task.id === 'scaffold');
  const two = mainMembers.slice(0, 2).map(dir => dir + '/src/lib.rs');
  const future = dir => [dir + '/Cargo.toml', dir + '/src/lib.rs'];
  scaffold.writePaths = ['Cargo.toml'];
  f.commit();
  assert.deepEqual(await f.compile([...two, ...future('crates/next')], { forRegistration: true }), threshold);
  assert.deepEqual(await f.compile([...two, ...future(side + '/crates/export')]), []);
  await rm(path.join(f.root, 'Cargo.toml'));
  f.commit();
  const newMembers = ['crates/one/src/lib.rs', 'crates/two/src/lib.rs'];
  assert.deepEqual(await f.compile([...newMembers, ...future('crates/third')]), threshold);
  scaffold.writePaths = ['Cargo.toml', ...future('crates/wire-contracts')];
  assert.deepEqual(await f.compile(newMembers, { forRegistration: true }), []);
  f.spec.constraints.push('workspaceRoot: ' + side);
  scaffold.writePaths = ['Cargo.toml', 'src/lib.rs'];
  assert.deepEqual(await f.compile(two, { forRegistration: true }), threshold, 'the new root package is the third');
});

test('a planned workspace root without a manifest cannot take an existing Cargo member from its workspace', async t => {
  const f = await fixture(t, workspace([side + '/wire', 'native/client'], [side]));
  await rm(path.join(f.root, side, 'Cargo.toml'));
  f.spec.constraints.push('workspaceRoot: ' + side, 'contractCrate: sample');
  f.commit();
  assert.deepEqual(await f.compile([side + '/w*/' + schema], { forRegistration: true }), broad);
  assert.deepEqual(await f.compile([side + '/sa*/' + schema]), broad);
});

test('a missing Rust policy uses the conventional contract name and an omitted contractCrates list grants no names', async t => {
  const f = await fixture(t);
  f.spec.constraints.push('workspaceRoot: .');
  const scopes = ['native/cod*/src/lib.rs'];
  const options = { forRegistration: true };
  f.commit();
  assert.deepEqual(await f.compile(scopes, { ...options, architecturePolicy: null }), broad);
  assert.deepEqual(
    await f.compile(scopes, { ...options, architecturePolicy: { schemaVersion: 2, language: 'rust' } }),
    [],
  );
  await f.write('Cargo.toml', manifest('root-package') + workspace(mainMembers, [side]));
  f.spec.constraints.push('contractCrate: root-package');
  f.spec.tasks.find(task => task.id === 'scaffold').writePaths = ['Cargo.toml', 'src/lib.rs'];
  assert.deepEqual(await f.compile(['schema-*.proto'], { architecturePolicy: null }), broad);
});

test('two different workspaces below threshold need no unrelated dependency bodies', async t => {
  const f = await fixture(t, workspace(['native/server'], [side]));
  await f.write('native/server/Cargo.toml', 'invalid TOML');
  f.spec.constraints.push('workspaceRoot: ' + side);
  f.commit();
  const scopes = ['native/client/src/lib.rs', side + '/sample/src/lib.rs', side + '/wire/src/lib.rs'];
  assert.deepEqual(await f.compile(scopes, { forRegistration: true }), []);
});

test('a transitive inherited path dependency can pull a contract from outside the member glob', async t => {
  const rootManifest =
    workspace(['app/[ab]'], [side]) +
    '[workspace.dependencies]\nprotocol = { package="wire-contracts", path="native/codec" }\n';
  const f = await fixture(t, rootManifest);
  await f.write('app/a/Cargo.toml', manifest('start') + '[dependencies]\nbridge = { path="../../shared/bridge" }\n');
  await f.write(
    'shared/bridge/Cargo.toml',
    manifest('bridge') + "[target.'cfg(unix)'.dev-dependencies]\nprotocol.workspace=true\n",
  );
  for (const dir of ['app/a', 'shared/bridge']) await f.write(dir + '/src/lib.rs', '');
  // This package is under the member glob's search lead, but cannot be in its dependency closure.
  await f.write('app/z/Cargo.toml', 'invalid TOML');
  f.commit();
  const scopes = ['native/cod*/' + schema];
  for (const forRegistration of [false, true]) assert.deepEqual(await f.compile(scopes, { forRegistration }), broad);

  const oid = f.git('rev-parse', 'HEAD:shared/bridge/Cargo.toml');
  const object = path.join(f.root, '.git/objects', oid.slice(0, 2), oid.slice(2));
  const backup = path.join(f.root, 'saved-bridge-blob');
  await rename(object, backup);
  try {
    assert.deepEqual(await f.compile(scopes, { forRegistration: true }), unavailable);
  } finally {
    await rename(backup, object);
  }
  await f.write('shared/bridge/Cargo.toml', manifest('bridge'));
  assert.deepEqual(await f.compile(scopes), [], 'removing the edge removes root membership');
  assert.deepEqual(await f.compile(scopes, { forRegistration: true }), broad);
  await f.write('shared/bridge/Cargo.toml', 'invalid TOML');
  f.commit();
  assert.deepEqual(await f.compile(scopes, { forRegistration: true }), unavailable);
});

test('direct membership requires no manifest reads outside the selected owners', async t => {
  const f = await fixture(t, workspace(['native/*'], [side]));
  for (let i = 0; i < 16; i++) await f.write(`native/other${i}/Cargo.toml`, manifest(`other${i}`));
  f.spec.constraints.push('workspaceRoot: ' + side);
  await f.write(side + '/Cargo.toml', 'invalid TOML');
  f.commit();
  const wanted = ['architecture.policy.json', 'Cargo.toml', 'native/codec/Cargo.toml']
    .map(file => f.git('rev-parse', 'HEAD:' + file))
    .sort();
  const spawn = t.mock.method(ChildProcess.prototype, 'spawn');
  assert.deepEqual(await f.compile(['native/cod*/' + schema], { forRegistration: true }), broad);
  const reads = spawn.mock.calls
    .map(call => call.arguments[0].args)
    .filter(args => args.includes('cat-file') && args.at(-2) === 'blob')
    .map(args => args.at(-1))
    .sort();
  assert.deepEqual(reads, wanted);
  t.diagnostic(`${reads.length} blobs read with 16 unrelated members of the same Cargo glob`);
});

test('overlapping roots use the workspace that declares or reaches the package through path dependencies', async t => {
  const paths = ['native/client', 'native/server'];
  const wire = side + '/wire';
  const f = await fixture(t, workspace(paths));
  await f.write(side + '/Cargo.toml', workspace(['sample']));
  await f.write('native/client/Cargo.toml', manifest('client') + '[dependencies]\nbridge={path="../bridge"}\n');
  await f.write('native/bridge/src/lib.rs', '');
  await f.write(
    'native/bridge/Cargo.toml',
    manifest('bridge') + '[dependencies]\nwire-contracts={path="../../examples/snapshot/wire"}\n',
  );
  f.commit();
  f.spec.constraints.push('workspaceRoot: ' + side);
  const mask = [side + '/w*/' + schema];
  const planned = [...paths, wire].map(dir => dir + '/src/lib.rs');
  assert.deepEqual(await f.compile(mask, { forRegistration: true }), broad);
  assert.deepEqual(await f.compile(planned), threshold);
  assert.deepEqual(await f.compile([wire + '/' + schema]), []);
  assert.deepEqual(await f.compile([...planned.slice(0, 2), side + '/sample/src/lib.rs']), []);

  await f.write(side + '/Cargo.toml', workspace(['sample'], ['wire']));
  assert.deepEqual(await f.compile(mask), broad, 'an exclude only applies to its own workspace');
  await f.write('native/bridge/Cargo.toml', manifest('bridge'));
  assert.deepEqual(await f.compile(mask), []);
  assert.deepEqual(await f.compile(mask, { forRegistration: true }), broad, 'the committed edge is still present');

  await f.write('Cargo.toml', workspace([...paths, wire], [side]));
  assert.deepEqual(await f.compile(mask), broad, 'a literal member wins over its own exclude');
  assert.deepEqual(await f.compile(planned), threshold);
  await f.write(wire + '/Cargo.toml', manifest('wire-contracts') + 'workspace="../../.."\n');
  assert.deepEqual(await f.compile(mask), broad);
  await f.write('Cargo.toml', workspace(paths, [side]));
  assert.deepEqual(await f.compile(mask), [], 'pointing at a workspace cannot enroll the package');
});

test('a package shared by two Cargo workspace invocations counts in each and keeps the root policy', async t => {
  const wire = side + '/wire';
  const outer = ['native/client', 'native/server', wire];
  const inner = [side + '/sample', side + '/extra', wire];
  const f = await fixture(t, workspace(outer));
  await f.write(side + '/Cargo.toml', workspace(['sample', 'extra', 'wire']));
  await f.write(side + '/extra/Cargo.toml', manifest('extra'));
  await f.write(side + '/extra/src/lib.rs', '');
  await f.write(wire + '/Cargo.toml', manifest('message'));
  await f.write('architecture.policy.json', { schemaVersion: 2, language: 'rust', contractCrates: ['message'] });
  f.commit();
  const declarations = ['workspaceRoot: .', 'workspaceRoot: ' + side];
  const sources = dirs => dirs.map(dir => dir + '/src/lib.rs');
  for (const order of [declarations, [...declarations].reverse()]) {
    f.spec.constraints.push(...order);
    assert.deepEqual(await f.compile([side + '/w*/' + schema], { forRegistration: true }), broad);
    for (const dirs of [outer, inner]) {
      assert.deepEqual(await f.compile(sources(dirs)), threshold);
      assert.deepEqual(await f.compile(sources(dirs), { architecturePolicy: null }), [
        ...threshold,
        'architecture_policy_required',
      ]);
    }
    assert.deepEqual(await f.compile(sources([outer[0], inner[0], wire])), []);
    f.spec.constraints.splice(-order.length);
  }
  f.spec.constraints.push(...declarations, 'contractCrate: sample');
  const scaffold = f.spec.tasks.find(task => task.id === 'scaffold');
  const contract = dir => [dir + '/Cargo.toml', dir + '/src/lib.rs'];
  for (const dir of [wire, inner[0]]) {
    scaffold.writePaths = contract(dir);
    assert.deepEqual(await f.compile(sources([...new Set([...outer, ...inner])])), threshold);
  }
  scaffold.writePaths = [...contract(wire), ...contract(inner[0])];
  assert.deepEqual(await f.compile(sources([...new Set([...outer, ...inner])])), []);
});

test('a repository-local sibling joins its explicit workspace only through a declaration or dependency', async t => {
  const root = 'engines/ingest';
  const shared = 'common/message';
  const f = await fixture(t, workspace(['native/server'], ['engines', 'common']));
  const nested = members => f.write(root + '/Cargo.toml', workspace(members));
  const local = ['cli', 'server'];
  await nested([...local, '../../common/message']);
  for (const name of local) {
    await f.write(root + '/' + name + '/Cargo.toml', manifest('ingest-' + name));
    await f.write(root + '/' + name + '/src/lib.rs', '');
  }
  const sibling = manifest('packet-format') + 'workspace="../../engines/ingest"\n';
  await f.write(shared + '/Cargo.toml', sibling);
  await f.write(shared + '/src/lib.rs', '');
  const sha = f.commit();
  f.spec.constraints.push('workspaceRoot: ' + root, 'contractCrate: packet-format');
  const mask = ['common/mess*/' + schema];
  const planned = [...local.map(dir => root + '/' + dir), shared].map(dir => dir + '/src/lib.rs');
  const spawn = t.mock.method(ChildProcess.prototype, 'spawn');
  assert.deepEqual(await f.compile(mask, { forRegistration: true }), broad);
  const gitCalls = spawn.mock.calls.map(call => call.arguments[0].args);
  spawn.mock.restore();
  const files = ['architecture.policy.json', 'Cargo.toml', root + '/Cargo.toml', shared + '/Cargo.toml'];
  const blobs = gitCalls.filter(args => args.includes('cat-file') && args.at(-2) === 'blob');
  assert.deepEqual(
    blobs.map(args => args.at(-1)).sort(),
    files.map(file => f.git('rev-parse', sha + ':' + file)).sort(),
  );
  assert.ok(gitCalls.filter(args => args.includes('ls-tree')).every(args => args.includes(sha)));
  assert.equal(gitCalls.filter(args => args.includes('HEAD^{commit}')).length, 1);
  assert.deepEqual(await f.compile(planned), threshold);
  assert.deepEqual(await f.compile([shared + '/' + schema]), []);

  await nested([...local, '../..//common/./mess*']);
  assert.deepEqual(await f.compile(mask), broad);
  await nested(local);
  assert.deepEqual(await f.compile(mask), [], 'the explicit workspace pointer alone is insufficient');
  assert.deepEqual(await f.compile(planned), []);
  assert.deepEqual(await f.compile(mask, { forRegistration: true }), broad);

  await f.write(
    root + '/cli/Cargo.toml',
    manifest('ingest-cli') + '[dependencies]\npacket-format={path="../../../common/message"}\n',
  );
  assert.deepEqual(await f.compile(mask), broad);
  assert.deepEqual(await f.compile(planned), threshold);
  await f.write(shared + '/Cargo.toml', manifest('packet-format'));
  assert.deepEqual(await f.compile(mask), [], 'a sibling path dependency without the workspace pointer is external');

  await f.write(shared + '/Cargo.toml', sibling);
  await f.write(
    root + '/Cargo.toml',
    workspace(local) + '[workspace.dependencies]\nbridge={path="../../common/bridge"}\n',
  );
  await f.write(root + '/cli/Cargo.toml', manifest('ingest-cli') + '[dependencies]\nbridge.workspace=true\n');
  const bridge = 'common/bridge/Cargo.toml';
  await f.write(
    bridge,
    manifest('bridge') + 'workspace="../../engines/ingest"\n[dependencies]\npacket-format={path="../message"}\n',
  );
  await f.write('common/bridge/src/lib.rs', '');
  f.commit();
  assert.deepEqual(await f.compile(mask, { forRegistration: true }), broad);
  await f.write(bridge, manifest('bridge') + 'workspace="../../engines/ingest"\n');
  assert.deepEqual(await f.compile(mask), []);
  assert.deepEqual(await f.compile(mask, { forRegistration: true }), broad);
  await f.write(bridge, 'invalid TOML');
  f.commit();
  assert.deepEqual(await f.compile(mask, { forRegistration: true }), unavailable);
});

test('workspace member patterns, dependency paths and package pointers stay within the blueprint tree', async t => {
  const f = await fixture(t);
  const outside = await realpath(await mkdtemp(path.join(os.tmpdir(), 'kodo-outside-blueprint-')));
  t.after(() => rm(outside, { recursive: true, force: true }));
  const name = path.basename(outside);
  const escape = '../../../' + name;
  await put(outside, 'Cargo.toml', 'invalid TOML');
  await f.write(side + '/Cargo.toml', workspace(['sample', escape, escape + '/*']));
  await f.write(side + '/sample/Cargo.toml', manifest('sample') + '[dependencies]\nout={path="../' + escape + '"}\n');
  f.spec.constraints.push('workspaceRoot: ' + side, 'contractCrate: wire-contracts');
  f.commit();
  const mask = [side + '/w*/' + schema];
  const spawn = t.mock.method(ChildProcess.prototype, 'spawn');
  assert.deepEqual(await f.compile(mask, { forRegistration: true }), []);
  assert.deepEqual(await f.compile(mask), []);
  await f.write(side + '/wire/Cargo.toml', manifest('wire-contracts') + 'workspace="../' + escape + '"\n');
  f.commit();
  assert.deepEqual(await f.compile(mask, { forRegistration: true }), []);
  for (const call of spawn.mock.calls) {
    const args = call.arguments[0].args;
    if (args.includes('ls-tree')) assert.ok(!args.some(arg => arg.includes(name)), args.join(' '));
  }
});

test('an excluded schema owner needs no name lookup, and one ordinary source needs no dependency traversal', async t => {
  const f = await fixture(t, workspace(['native/server'], [side]));
  await f.write('native/server/Cargo.toml', 'invalid TOML');
  await f.write(side + '/wire/Cargo.toml', 'invalid TOML');
  f.commit();
  for (const scope of [
    side + '/*/' + schema,
    side + '/*/src/new.rs',
    side + '/*/Cargo.toml',
    'native/client/src/lib.rs',
  ])
    assert.deepEqual(await f.compile([scope], { forRegistration: true }), [], scope);
});

test('an ordinary edit below threshold needs no metadata from excluded packages or a sibling workspace', async t => {
  const f = await fixture(t, workspace(['native/client'], ['archive', side]));
  const archived = 'archive/codegen';
  const metadata = '#' + 'x'.repeat(64 * 1024);
  await f.write(archived + '/Cargo.toml', manifest('generated') + metadata);
  await f.write(archived + '/src/lib.rs', '');
  await f.write('native/client/Cargo.toml', manifest('client') + metadata);
  f.commit();
  const declarations = ['workspaceRoot: .', 'workspaceRoot: ' + side, 'contractCrate: generated'];
  const spawn = t.mock.method(ChildProcess.prototype, 'spawn');
  for (const order of [declarations, declarations.toReversed()]) {
    f.spec.constraints = order;
    assert.deepEqual(
      await f.compile(['native/client/src/lib.rs', archived + '/src/lib.rs'], { forRegistration: true }),
      [],
    );
  }
  const selected = spawn.mock.calls
    .map(call => call.arguments[0].args)
    .filter(args => args.includes('ls-tree') && args.includes('-l'))
    .flatMap(args => args.slice(args.indexOf('--') + 1));
  assert.deepEqual([...new Set(selected)].sort(), ['Cargo.toml', 'architecture.policy.json']);
});

test('a sibling workspace checks only reachable archive manifests for a broad schema or a third package', async t => {
  const f = await fixture(t, workspace(['native/client'], ['archive', side]));
  const wire = 'archive/packet';
  const generator = 'archive/codegen';
  const pointer = 'workspace="../../' + side + '"\n';
  const generated = manifest('generated') + pointer + '#' + 'x'.repeat(64 * 1024);
  for (const [dir, doc] of [
    [wire, manifest('packet-format') + pointer],
    [generator, generated],
    ['archive/unused', 'invalid TOML'],
  ]) {
    await f.write(dir + '/Cargo.toml', doc);
    await f.write(dir + '/src/lib.rs', '');
  }
  const helper = side + '/sample/Cargo.toml';
  const dependsOn = (name, dir) => manifest('sample') + '[dependencies]\n' + name + '={path="../../../' + dir + '"}\n';
  await f.write(helper, dependsOn('packet-format', wire));
  f.commit();
  f.spec.constraints.push('contractCrate: packet-format', 'workspaceRoot: ' + side);
  const mask = ['archive/*/' + schema];
  const reg = { forRegistration: true };
  const two = [side + '/sample/src/lib.rs', side + '/wire/src/lib.rs'];
  assert.deepEqual(await f.compile(mask, reg), broad);
  assert.deepEqual(await f.compile([...two, generator + '/src/lib.rs'], reg), []);
  assert.deepEqual(await f.compile([...two, generator + '/src/lib.rs', wire + '/src/lib.rs'], reg), threshold);

  await f.write(helper, dependsOn('generated', generator));
  assert.deepEqual(await f.compile(mask), []);
  assert.deepEqual(await f.compile(mask, reg), broad);
  f.commit();
  assert.deepEqual(await f.compile(mask, reg), unavailable);

  // The other end of the proof can also rule out an unreadable dependency
  // graph: a package outside this root must point back to it.
  await f.write(helper, 'invalid TOML');
  await f.write(wire + '/Cargo.toml', manifest('packet-format'));
  f.commit();
  assert.deepEqual(await f.compile(['archive/pack*/' + schema], reg), []);
});

test('workspace members use the Cargo package table for legacy names and inherited editions', async t => {
  const f = await fixture(t, workspace(mainMembers, [side]) + '[workspace.package]\nedition="2024"\n');
  const legacy = manifest('wire-contracts').replace('[package]', '[project]');
  const scopes = ['native/cod*/' + schema];
  for (const [doc, expected] of [
    [legacy, broad],
    [legacy + '[package]\nname="ordinary"\nversion="0.1.0"\n', []],
    [legacy.replace('edition="2021"', 'edition="2024"'), unavailable],
    [legacy.replace('edition="2021"', 'edition.workspace=true'), unavailable],
  ]) {
    await f.write('native/codec/Cargo.toml', doc);
    f.commit();
    for (const forRegistration of [false, true])
      assert.deepEqual(await f.compile(scopes, { forRegistration }), expected);
  }
});
