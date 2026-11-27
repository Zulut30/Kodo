import test from 'node:test';
import assert from 'node:assert/strict';
import { ChildProcess, execFileSync, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { cp, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateArchitecturePolicy } from '../runtime/architecture-policy.mjs';
import { compileBlueprint, rustContractCrateFindings } from '../runtime/project-blueprint.mjs';
import { workerEnvironment } from '../runtime/security.mjs';

const policy = { schemaVersion: 2, language: 'rust', contractCrates: ['wire-contracts'] };
const manifest = name => `[package]\nname="${name}"\nversion="0.1.0"\n`;
const wildcard = 'native/*/src/schema.rs';
const schemaScope = 'native/*/schemas/api.proto';
const broad = ['contract_scope_too_broad'];
const codes = result => result.findings.map(row => row.code);

async function fixture(t) {
  const dir = await realpath(await mkdtemp(path.join(os.tmpdir(), 'kodo-contract-owner-')));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const root = path.join(dir, 'repo');
  const blueprint = path.join(root, '.kodo', 'blueprint');
  await cp(new URL('./fixtures/blueprint/valid/', import.meta.url), blueprint, { recursive: true });
  const draft = JSON.parse(await readFile(path.join(blueprint, 'spec.json'), 'utf8'));
  draft.root = root;
  const put = async (file, data) => {
    const dest = path.join(root, file);
    await mkdir(path.dirname(dest), { recursive: true });
    await writeFile(dest, data);
  };
  const git = (...args) =>
    execFileSync(
      'git',
      [
        '-c',
        'core.hooksPath=',
        '-c',
        'user.name=Fixture',
        '-c',
        'user.email=test@example.invalid',
        '-c',
        'commit.gpgSign=false',
        ...args,
      ],
      { cwd: root, stdio: 'pipe', encoding: 'utf8' },
    ).trim();
  const save = label => {
    git('add', '.');
    git('commit', '-qm', label);
    return git('rev-parse', 'HEAD');
  };
  async function writeScopes(paths) {
    draft.tasks.find(task => task.id === 'storage-module').writePaths = paths;
    await put('.kodo/blueprint/spec.json', JSON.stringify(draft));
  }
  async function compile(paths, options = {}) {
    await writeScopes(paths);
    return compileBlueprint(root, { hasRustToolchain: true, ...options });
  }
  await put('.gitignore', '/.kodo/blueprint/\n');
  return { dir, root, draft, put, git, save, compile, writeScopes };
}

function publicCodes(writePaths, packageNames) {
  return rustContractCrateFindings(
    { id: 'demo', epics: [{ id: 'foundation' }], tasks: [{ id: 'write', epicId: 'foundation', writePaths }] },
    '',
    policy,
    undefined,
    packageNames,
  ).map(row => row.code);
}

function sequenceModuleWrites(draft) {
  for (const id of ['api-module', 'web-module'])
    draft.tasks.find(task => task.id === id).dependsOn.push('storage-module');
}

test('policy package owners protect schemas, models and data without counting them as planned Rust crates', () => {
  const names = new Map([
    ['native/codec', 'wire-contracts'],
    ['native/control', 'control'],
  ]);
  for (const scope of [schemaScope, 'native/*/models/record.ts', 'native/*/data/*.bin'])
    assert.deepEqual(publicCodes([scope], names), broad, scope);
  assert.deepEqual(publicCodes(['native/codec/schemas/*.proto', 'native/con*/data/v1.bin'], names), []);
  names.set('native/extra', 'extra');
  assert.deepEqual(publicCodes(['native/{control,extra}/src/build.rs', schemaScope], names), broad);
  assert.deepEqual(publicCodes(['*.json'], { '.': 'wire-contracts' }), broad);
  assert.deepEqual(publicCodes(['settings.json'], { '.': 'wire-contracts' }), []);
});

test('a directory scope covering an ancestor of a policy package also covers its files', () => {
  const names = { 'native/group.v2/codec': 'wire-contracts' };
  for (const scope of ['native/group.v2', 'native/group*', 'native/*/codec'])
    assert.deepEqual(publicCodes([scope], names), broad, scope);
  assert.deepEqual(publicCodes(['native/gr*/data/api.proto'], names), []);
});

test('unrelated packages add no glob comparisons to the public contract check', t => {
  const names = new Map();
  const paths = [];
  for (let i = 0; i < 12; i++) {
    names.set(`native/area${i}/codec`, i === 0 ? 'wire-contracts' : `codec-${i}`);
    paths.push(`native/area${i}/co*/schemas/api.proto`);
  }
  const match = t.mock.method(path.posix, 'matchesGlob');
  assert.deepEqual(publicCodes(paths, names), broad);
  const before = match.mock.callCount();
  for (let i = 0; i < 96; i++) names.set(`native/unrelated/part${i}`, `other-${i}`);
  assert.deepEqual(publicCodes(paths, names), broad);
  const after = match.mock.callCount() - before;
  assert.equal(after, before, 'disjoint package catalogs must not multiply scope comparisons');
  t.diagnostic(`12 data scopes, 0 / 96 unrelated packages: ${before} / ${after} glob comparisons`);
});

async function schemaProject(t) {
  const f = await fixture(t);
  f.draft.constraints = ['Node.js 24 service with a versioned storage schema in a local Cargo workspace.'];
  f.draft.tasks.find(task => task.id === 'storage-module').description = 'Update the storage schema for note headers.';
  const projectPolicy = {
    ...policy,
    version: 1,
    productRoots: ['native'],
    layers: [
      { id: 'contracts', crates: ['wire-contracts'] },
      { id: 'control', crates: ['control'] },
    ],
    cycles: 'forbid',
    allowedExternalCrates: [],
    allowedDevExternalCrates: [],
    baseline: [],
    exceptions: [],
    protectedPaths: ['architecture.policy.json', 'Cargo.toml'],
  };
  validateArchitecturePolicy(projectPolicy);
  await f.put('architecture.policy.json', JSON.stringify(projectPolicy));
  await f.put('Cargo.toml', '[workspace]\nmembers=["native/codec","native/control"]\nresolver="2"\n');
  await f.put('rust-toolchain.toml', '[toolchain]\nchannel="1.85.1"\ncomponents=["rustfmt","clippy"]\n');
  await f.put(
    'kodo.config.json',
    JSON.stringify({ schemaVersion: 1, client: 'codex', commands: { test: ['cargo test'] } }),
  );
  for (const [dir, name] of [
    ['codec', 'wire-contracts'],
    ['control', 'control'],
  ]) {
    await f.put(`native/${dir}/Cargo.toml`, manifest(name));
    await f.put(`native/${dir}/src/lib.rs`, 'pub struct Header;\n');
    await f.put(`native/${dir}/schemas/api.proto`, 'syntax = "proto3";\nmessage Header {}\n');
  }
  f.git('init', '-q');
  return { ...f, head: f.save('Schema owners and pinned toolchain') };
}

test('contract lint treats braces around a package path as broad in draft and registration', async t => {
  const f = await schemaProject(t);
  sequenceModuleWrites(f.draft);
  for (const [scope, expected] of [
    ['{native/codec}/schemas/api.proto', broad],
    ['{{native/codec},native/control}/schemas/api.proto', broad],
    ['{native/control}/schemas/api.proto', []],
    ['native/{codec}/schemas/api.proto', []],
    ['native/codec/{schemas,src}/**', []],
  ]) {
    for (const forRegistration of [false, true]) {
      const result = await f.compile([scope], { forRegistration });
      assert.deepEqual(codes(result), expected, scope);
    }
  }
});

test('compileBlueprint resolves committed and draft schema owners independently and honors explicit packageNames', async t => {
  const f = await schemaProject(t);
  await f.put('native/codec/Cargo.toml', manifest('draft-codec'));
  assert.deepEqual(codes(await f.compile([schemaScope])), []);
  const committed = await f.compile([schemaScope], { forRegistration: true });
  assert.equal(committed.headSha, f.head);
  assert.deepEqual(codes(committed), broad);
  assert.deepEqual(committed.findings[0].taskIds, ['storage-module']);
  assert.deepEqual(codes(await f.compile([schemaScope], { forRegistration: true, packageNames: {} })), []);
  assert.deepEqual(
    codes(await f.compile([schemaScope], { packageNames: { 'native/codec': 'wire-contracts' } })),
    broad,
  );
});

test('registration reads the same selected blobs when unrelated packages share the Git search directory', async t => {
  const f = await schemaProject(t);
  // The fixture also plans src/api and src/web. Their nearest manifest is the virtual workspace root.
  const expected = ['architecture.policy.json', 'Cargo.toml', 'native/codec/Cargo.toml', 'native/control/Cargo.toml']
    .map(file => f.git('rev-parse', 'HEAD:' + file))
    .sort();
  const spawn = t.mock.method(ChildProcess.prototype, 'spawn');
  const observe = async () => {
    const start = spawn.mock.callCount();
    const compiled = await f.compile([schemaScope], { forRegistration: true });
    assert.deepEqual(codes(compiled), broad);
    const commands = spawn.mock.calls.slice(start).map(call => call.arguments[0].args);
    const listings = commands.filter(args => args.includes('ls-tree') && args.includes('-r'));
    assert.equal(listings.length, 1);
    assert.ok(listings[0].includes(compiled.headSha));
    const leads = listings[0].slice(listings[0].indexOf('--') + 1);
    assert.ok(leads.includes('native') && !leads.includes('.'));
    const reads = commands
      .filter(args => args.includes('cat-file') && args.at(-2) === 'blob')
      .map(args => args.at(-1))
      .sort();
    assert.deepEqual(reads, expected);
  };
  await observe();
  // All of these appear under the very same Git search lead, native/.
  for (let i = 0; i < 24; i++) await f.put(`native/tools/extra${i}/Cargo.toml`, manifest(`other-${i}`));
  f.save('Unrelated nested packages');
  await observe();
});

test('project apply-spec rejects the broad committed schema owner and registers the explicit schema path', async t => {
  const f = await schemaProject(t);
  sequenceModuleWrites(f.draft);
  const home = path.join(f.dir, 'state');
  const cli = fileURLToPath(new URL('../cli/index.mjs', import.meta.url));
  const apply = async scope => {
    await f.writeScopes([scope]);
    const run = spawnSync(process.execPath, [cli, 'project', 'apply-spec', '--root', f.root, '--json'], {
      cwd: f.root,
      env: { ...workerEnvironment(), KODO_HOME: home, KODO_CREDENTIAL_HOME: path.join(f.dir, 'credentials') },
      encoding: 'utf8',
      windowsHide: true,
    });
    const { result } = JSON.parse(run.stdout);
    return [run.status, result.status, result.findings?.map(row => [row.code, row.taskIds]) ?? []];
  };
  for (const scope of [schemaScope, '{native/codec}/schemas/api.proto']) {
    assert.deepEqual(await apply(scope), [1, 'invalid', [['contract_scope_too_broad', ['storage-module']]]], scope);
  }
  assert.equal(existsSync(home), false);
  assert.deepEqual(await apply('native/codec/schemas/api.proto'), [0, 'created', []]);
});

test('compileBlueprint protects the actual package reached by a source glob before and after a package rename', async t => {
  const f = await fixture(t);
  await f.put('Cargo.toml', '[workspace]\nmembers=["native/codec","contracts/wire"]\n');
  await f.put('architecture.policy.json', JSON.stringify(policy));
  await f.put('native/codec/Cargo.toml', manifest('codec'));
  await f.put('native/codec/src/types.rs', 'pub struct Header;\n');
  await f.put('native/codec/src/schema.rs', 'pub struct Schema;\n');
  await f.put('contracts/wire/Cargo.toml', manifest('wire-contracts'));
  await f.put('contracts/wire/src/lib.rs', 'pub struct Envelope;\n');
  f.git('init', '-q');
  const before = f.save('Original package names');
  for (const paths of [[wildcard], ['native/codec/src/types.rs', wildcard]]) {
    const result = await f.compile(paths, { forRegistration: true });
    assert.equal(result.headSha, before);
    assert.deepEqual(codes(result), []);
  }

  await f.put('native/codec/Cargo.toml', manifest('wire-contracts'));
  await f.put('contracts/wire/Cargo.toml', manifest('codec'));
  assert.deepEqual(codes(await f.compile([wildcard], { forRegistration: true })), []);
  assert.deepEqual(codes(await f.compile([wildcard])), broad, 'draft sees the uncommitted rename');
  const after = f.save('Swap the two package names');
  for (const paths of [[wildcard], ['native/codec/src/types.rs', wildcard], ['native/codec/Cargo.toml', wildcard]]) {
    const result = await f.compile(paths, { forRegistration: true });
    assert.equal(result.headSha, after);
    assert.deepEqual(codes(result), broad);
    assert.deepEqual(result.findings[0].taskIds, ['storage-module']);
  }
  assert.deepEqual(codes(await f.compile(['contracts/*/src/schema.rs'])), []);
  assert.deepEqual(codes(await f.compile(['native/codec/src/*.rs'])), []);
});

test('root and unconventional package names follow the policy and explicit API options', async t => {
  const f = await fixture(t);
  const customPolicy = { ...policy, contractCrates: ['wire_v3'] };
  await f.put('architecture.policy.json', JSON.stringify(customPolicy));
  await f.put('Cargo.toml', manifest('wire_v3'));
  assert.deepEqual(codes(await f.compile(['generated*.rs'])), broad);
  assert.deepEqual(codes(await f.compile(['generated.rs'])), []);
  await f.put('Cargo.toml', '[workspace]\nmembers=["components/parser.v2"]\n');
  await f.put('components/parser.v2/Cargo.toml', manifest('wire_v3'));
  const paths = ['components/*/src/new.rs'];
  assert.deepEqual(codes(await f.compile(paths)), broad);
  assert.deepEqual(codes(await f.compile(paths, { architecturePolicy: null })), []);
  assert.deepEqual(codes(await f.compile(paths, { packageNames: { 'components/parser.v2': 'other' } })), []);
  const supplied = new Map([['components/future', 'wire_v3']]);
  assert.deepEqual(codes(await f.compile(paths, { packageNames: supplied })), broad);
});

test('an explicit package catalog counts only planned crate owners and honors the root package name', () => {
  const names = {
    '.': 'root-package',
    'native/codec': 'wire-contracts',
    'native/client': 'client',
    'tools/extra': 'extra',
  };
  const check = (writePaths, packageNames = names) => publicCodes(writePaths, packageNames);
  const twoPackages = 'native/{codec,client}/src/new.rs';
  assert.deepEqual(check([twoPackages]), broad);
  assert.deepEqual(check([twoPackages, 'tools/extra/src/main.rs']), [...broad, 'contract_crate_required']);
  assert.deepEqual(check(['*/types.rs'], { '.': 'wire-contracts' }), broad);
  assert.deepEqual(check(['src/types.rs'], { '.': 'wire-contracts' }), []);
});

test('the Wave 0 threshold counts concrete manifest and Rust source owners once', () => {
  const two = { 'native/codec': 'codec', 'native/control': 'control' };
  const existing = { ...two, 'crates/events': 'events' };
  const sources = ['native/codec/src/lib.rs', 'native/control/src/lib.rs'];
  for (const scope of [
    'native/@(codec|control)/Cargo.toml',
    'native/{codec,control}/Cargo.toml',
    'native/*/Cargo.toml',
  ])
    assert.deepEqual(publicCodes([scope], existing), [], scope);
  for (const names of [two, existing]) {
    for (const data of ['crates/events/schemas/event.proto', 'crates/event[s]/schemas/event.proto'])
      assert.deepEqual(publicCodes([...sources, data], names), [], data);
    for (const rust of ['crates/events/src/lib.rs', 'crates/events/src/**', 'crates/events/Cargo.toml'])
      assert.deepEqual(publicCodes([...sources, rust], names), ['contract_crate_required'], rust);
  }
});

test('internal dot components in Cargo members protect the same schema as the canonical path', async t => {
  const f = await fixture(t);
  await f.put('architecture.policy.json', JSON.stringify(policy));
  await f.put('native/codec/Cargo.toml', manifest('wire-contracts'));
  await f.put('native/control/Cargo.toml', manifest('control'));
  await f.put('Cargo.toml', '[workspace]\nmembers=["native/./codec","native/control"]\n');
  f.git('init', '-q');
  f.save('Workspace with an internal dot component');
  for (const forRegistration of [false, true]) {
    assert.deepEqual(codes(await f.compile(['native/cod*/schemas/api.proto'], { forRegistration })), broad);
    assert.deepEqual(codes(await f.compile(['native/con*/schemas/api.proto'], { forRegistration })), []);
    assert.deepEqual(codes(await f.compile(['native/codec/schemas/api.proto'], { forRegistration })), []);
  }
});

test('a planned nested Cargo package counts once before and after its manifest exists', () => {
  const host = 'native/host';
  const child = host + '/crates/exporter';
  const existing = { [host]: 'host', 'native/control': 'control' };
  for (const names of [existing, { ...existing, [child]: 'exporter' }]) {
    const two = ['native/control/src/lib.rs', child + '/Cargo.toml', child + '/src/lib.rs'];
    assert.deepEqual(publicCodes(two, names), []);
    assert.deepEqual(publicCodes([...two, host + '/src/lib.rs'], names), ['contract_crate_required']);
  }
});

test('a module named crates stays in its source package when counting Wave 0', async t => {
  const f = await fixture(t);
  const engine = 'crates/engine';
  const cache = 'crates/cache/src/lib.rs';
  const wire = 'crates/wire/src/lib.rs';
  const module = engine + '/src/crates/resolve/mod.rs';
  const generated = engine + '/generated/crates/parser/src/table.rs';
  const extensions = engine + '/extensions/crates';
  await f.put('architecture.policy.json', JSON.stringify(policy));
  await f.put('Cargo.toml', `[workspace]\nmembers=["crates/*","${extensions}/*"]\nresolver="2"\n`);
  await f.put(extensions + '/seed/Cargo.toml', manifest('seed'));
  await f.put(extensions + '/seed/src/lib.rs', '');
  await f.put(engine + '/Cargo.toml', manifest('engine'));
  await f.put('crates/cache/Cargo.toml', manifest('cache'));
  await f.put('crates/wire/Cargo.toml', manifest('wire-contracts'));
  await f.put(cache, '');
  await f.put(wire, '');
  await f.put(
    engine + '/src/lib.rs',
    'pub mod crates;\n#[path = "../generated/crates/parser/src/table.rs"] pub mod tables;\n',
  );
  await f.put(engine + '/src/crates/mod.rs', 'pub mod resolve;\n');
  await f.put(module, 'pub struct Index;\n');
  await f.put(generated, 'pub struct Table;\n');
  f.git('init', '-q');
  f.save('Modules inside a package and a separate member pattern for extensions');
  for (const forRegistration of [false, true]) {
    for (const scope of [
      module,
      engine + '/src/crates/resolve/**',
      engine + '/src/crates/new/src/item.rs',
      generated,
      engine + '/generated/crates/new/src/item.rs',
    ]) {
      assert.deepEqual(
        codes(await f.compile([scope, cache, wire], { forRegistration })),
        ['contract_crate_required'],
        scope,
      );
      assert.deepEqual(codes(await f.compile([scope, engine + '/src/lib.rs', cache], { forRegistration })), [], scope);
    }
    const member = extensions + '/codec/src/lib.rs';
    assert.deepEqual(codes(await f.compile([member, cache], { forRegistration })), []);
    assert.deepEqual(codes(await f.compile([member, engine + '/src/lib.rs', cache], { forRegistration })), [
      'contract_crate_required',
    ]);
  }
});

test('declared members below src count before and after their manifests exist', async t => {
  const f = await fixture(t);
  const group = 'src/rust/crates';
  const wire = group + '/wire';
  const cache = group + '/cache';
  const exporter = group + '/exporter';
  const nested = wire + '/src/extensions/crates';
  const packages = 'src/components';
  await f.put('architecture.policy.json', JSON.stringify(policy));
  await f.put('Cargo.toml', `[workspace]\nmembers=["${group}/*","${nested}/*","${packages}/*"]\nresolver="2"\n`);
  for (const [dir, name] of [
    [wire, 'wire-contracts'],
    [cache, 'cache'],
    [nested + '/seed', 'seed'],
    [packages + '/seed', 'component-seed'],
  ]) {
    await f.put(dir + '/Cargo.toml', manifest(name));
    await f.put(dir + '/src/lib.rs', '');
  }
  f.git('init', '-q');
  f.save('Cargo members under the virtual root src and an existing package src');
  for (const materialized of [false, true]) {
    if (materialized) {
      await f.put(exporter + '/Cargo.toml', manifest('exporter'));
      await f.put(exporter + '/src/lib.rs', '');
      f.save('Materialize the third member');
    }
    for (const forRegistration of [false, true]) {
      const options = { forRegistration };
      const two = [wire + '/src/lib.rs', cache + '/src/lib.rs'];
      for (const scope of [
        exporter,
        exporter + '/**',
        exporter + '/src/lib.rs',
        nested + '/plugin/src/lib.rs',
        packages + '/encoder',
        packages + '/{seed,encoder}/src/lib.rs',
      ]) {
        assert.deepEqual(codes(await f.compile([...two, scope], options)), ['contract_crate_required'], scope);
      }
      assert.deepEqual(codes(await f.compile([two[0], exporter], options)), []);
      assert.deepEqual(codes(await f.compile([two[0], packages + '/{encoder,decoder}/src/lib.rs'], options)), [
        'contract_crate_required',
      ]);
      assert.deepEqual(codes(await f.compile([...two, packages + '/encoder/schema/version.proto'], options)), []);
    }
  }
});

test('each enclosing workspace keeps its declared future members when another root is named', async t => {
  const f = await fixture(t);
  const side = 'native/examples';
  const group = side + '/packs';
  const future = group + '/codec';
  const first = 'native/service';
  const second = 'native/frontend';
  const local = side + '/generator';
  const seed = group + '/seed';
  await f.put('architecture.policy.json', JSON.stringify(policy));
  await f.put('Cargo.toml', `[workspace]\nmembers=["${first}","${second}","${group}/*"]\nresolver="2"\n`);
  for (const dir of [first, second, local, seed]) {
    await f.put(dir + '/Cargo.toml', manifest(path.basename(dir)));
    await f.put(dir + '/src/lib.rs', '');
  }
  f.draft.constraints.push('workspaceRoot: ' + side);
  f.git('init', '-q');
  for (const shared of [false, true]) {
    await f.put(
      side + '/Cargo.toml',
      '[workspace]\nmembers=' + JSON.stringify(shared ? ['generator', 'packs/*'] : ['generator']) + '\n',
    );
    f.save(shared ? 'Both workspaces declare the member' : 'Only the enclosing workspace declares the member');
    for (const forRegistration of [false, true]) {
      const check = dirs =>
        f.compile([...dirs.map(dir => dir + '/src/lib.rs'), future], { forRegistration }).then(codes);
      assert.deepEqual(await check([first, second]), ['contract_crate_required']);
      assert.deepEqual(await check([local, seed]), shared ? ['contract_crate_required'] : []);
    }
  }
});

test('editing the workspace manifest preserves ownership of modules in its root package', async t => {
  const f = await fixture(t);
  const cache = 'crates/cache/src/lib.rs';
  const module = 'generated/crates/parser/src/types.rs';
  await f.put('architecture.policy.json', JSON.stringify(policy));
  await f.put('Cargo.toml', manifest('host') + '[workspace]\nmembers=["crates/cache"]\nresolver="2"\n');
  await f.put('src/lib.rs', `#[path = "../${module}"] pub mod parser;\n`);
  await f.put(module, 'pub struct Token;\n');
  await f.put('crates/cache/Cargo.toml', manifest('cache'));
  await f.put(cache, '');
  f.git('init', '-q');
  f.save('A root package contains a module outside src');
  for (const forRegistration of [false, true]) {
    for (const source of [module, 'generated/crates/next/src/types.rs']) {
      const paths = ['Cargo.toml', cache, source];
      assert.deepEqual(codes(await f.compile(paths, { forRegistration })), []);
      assert.deepEqual(publicCodes(paths, { '.': 'host', 'crates/cache': 'cache' }), []);
    }
    const newCrate = 'generated/crates/next';
    assert.deepEqual(
      codes(
        await f.compile(['Cargo.toml', cache, newCrate + '/Cargo.toml', newCrate + '/src/lib.rs'], { forRegistration }),
      ),
      ['contract_crate_required'],
    );
  }
});

test('a root manifest edit keeps files and module directories with their owning package', async t => {
  const f = await fixture(t);
  const names = { '.': 'host', 'crates/cache': 'cache' };
  const file = 'src/crates/parser';
  const folder = 'generated/crates/format';
  await f.put('architecture.policy.json', JSON.stringify(policy));
  await f.put('Cargo.toml', manifest('host') + '[workspace]\nmembers=["crates/cache"]\n');
  await f.put('crates/cache/Cargo.toml', manifest('cache'));
  await f.put('crates/cache/src/lib.rs', '');
  await f.put(
    'src/lib.rs',
    '#[path="crates/parser"] mod parser;\n#[path="../generated/crates/format/mod.rs"] mod format;\n',
  );
  await f.put(file, 'pub struct Parser;\n');
  await f.put(folder + '/mod.rs', 'pub struct Format;\n');
  f.git('init', '-q');
  f.save('Two packages and two ordinary modules');
  const common = ['Cargo.toml', 'crates/cache/src/lib.rs'];
  for (const scope of [file, folder, folder + '/**', folder + '/mod.rs']) {
    const paths = [...common, scope];
    assert.deepEqual(publicCodes(paths, names), [], scope);
    for (const forRegistration of [false, true])
      assert.deepEqual(codes(await f.compile(paths, { forRegistration })), [], scope);
  }
  const plugin = [...common, 'generated/crates/plugin/Cargo.toml', 'generated/crates/plugin/src/lib.rs'];
  assert.deepEqual(publicCodes(plugin, names), ['contract_crate_required']);
  assert.deepEqual(codes(await f.compile(plugin, { forRegistration: true })), ['contract_crate_required']);
});

test('a dotted directory covered by a Cargo member glob counts before its manifest exists', async t => {
  const f = await fixture(t);
  const group = 'src/rust/crates';
  const first = group + '/input';
  const second = group + '/cache';
  const third = group + '/exporter.v2';
  const catalog = { [first]: 'input', [second]: 'cache' };
  await f.put('architecture.policy.json', JSON.stringify(policy));
  await f.put('Cargo.toml', `[workspace]\nmembers=["${group}/*"]\nresolver="2"\n`);
  for (const dir of [first, second]) {
    await f.put(dir + '/Cargo.toml', manifest(path.basename(dir)));
    await f.put(dir + '/src/lib.rs', '');
  }
  await f.put(group + '/parser', 'pub struct Parser;\n');
  await f.put(group + '/notes.v2', 'release notes\n');
  f.git('init', '-q');
  f.save('Two members under a Cargo glob');
  const two = [first + '/src/lib.rs', second + '/src/lib.rs'];
  for (const materialized of [false, true]) {
    if (materialized) {
      await f.put(third + '/Cargo.toml', manifest('exporter'));
      await f.put(third + '/src/lib.rs', '');
      f.save('Add the dotted member without changing the workspace');
    }
    for (const forRegistration of [false, true]) {
      for (const scope of [third, third + '/**', third + '/Cargo.toml', third + '/src/lib.rs'])
        assert.deepEqual(
          codes(await f.compile([...two, scope], { forRegistration })),
          ['contract_crate_required'],
          scope,
        );
      assert.deepEqual(codes(await f.compile([two[0], third], { forRegistration })), []);
      assert.deepEqual(codes(await f.compile([...two, third + '/docs/info.proto'], { forRegistration })), []);
      for (const scope of [
        group + '/parser',
        group + '/notes.v2',
        group + '/{cache,parser}/src/lib.rs',
        group + '/{cache,parser}/Cargo.toml',
        group + '/parser/src/lib.rs',
        group + '/parser/Cargo.toml',
      ])
        assert.deepEqual(codes(await f.compile([...two, scope], { forRegistration })), [], scope);
      const replaceFile = [...two, group + '/parser', group + '/parser/Cargo.toml'];
      assert.deepEqual(codes(await f.compile(replaceFile, { forRegistration })), ['contract_crate_required']);
    }
    assert.deepEqual(publicCodes([...two, third], catalog), ['contract_crate_required']);
    assert.deepEqual(publicCodes([...two, third + '/docs/info.proto'], catalog), []);
  }
});

test('a file selector for a future Cargo manifest counts its package in an existing directory', async t => {
  const f = await fixture(t);
  const host = manifest('host');
  const cache = 'crates/cache';
  const next = 'crates/exporter';
  await f.put('architecture.policy.json', JSON.stringify(policy));
  await f.put('Cargo.toml', host + '[workspace]\nmembers=["crates/cache"]\n');
  await f.put('src/lib.rs', '');
  await f.put(cache + '/Cargo.toml', manifest('cache'));
  await f.put(cache + '/src/lib.rs', '');
  await f.put(next + '/README.md', 'Planned exporter\n');
  f.git('init', '-q');
  f.save('Existing directory for a future workspace member');
  const paths = ['Cargo.toml', cache + '/src/lib.rs', next + '/src/lib.rs'];
  const selectors = ['Cargo.{toml,lock}', 'Cargo.@(toml|lock)', '{Cargo.toml,Cargo.lock}', 'Cargo.t[oa]ml', 'Cargo.*'];
  for (const materialized of [false, true]) {
    if (materialized) {
      await f.put('Cargo.toml', host + '[workspace]\nmembers=["crates/cache","crates/exporter"]\n');
      await f.put(next + '/Cargo.toml', manifest('exporter'));
      await f.put(next + '/src/lib.rs', '');
      f.save('Add the package using only its manifest, library and the workspace manifest');
    }
    for (const forRegistration of [false, true]) {
      for (const name of selectors) {
        const result = await f.compile([...paths, next + '/' + name], { forRegistration });
        assert.deepEqual(codes(result), ['contract_crate_required'], name);
      }
      const other = await f.compile([...paths, next + '/Cargo.{lock,bak}'], { forRegistration });
      assert.deepEqual(codes(other), materialized ? ['contract_crate_required'] : []);
      const binary = [paths[0], paths[1], next + '/{Cargo.*,src/bin/export.rs}'];
      assert.deepEqual(codes(await f.compile(binary, { forRegistration })), ['contract_crate_required']);
      for (const rootScope of ['Cargo.{toml,lock}', 'Cargo.@(toml|lock)']) {
        const both = [rootScope, ...paths.slice(1), next + '/Cargo.@(toml|lock)'];
        assert.deepEqual(codes(await f.compile(both, { forRegistration })), ['contract_crate_required'], rootScope);
      }
    }
  }
});

test('a planned manifest in the workspace grouping directory is a file before and after creation', async t => {
  const f = await fixture(t);
  const group = 'src/rust/crates';
  const packages = ['input', 'cache'];
  const sources = packages.map(name => group + '/' + name + '/src/lib.rs');
  await f.put('architecture.policy.json', JSON.stringify(policy));
  await f.put('Cargo.toml', '[workspace]\nmembers=["src/rust/crates/*"]\nresolver="2"\n');
  for (const name of packages) {
    await f.put(group + '/' + name + '/Cargo.toml', manifest(name) + 'workspace="../../../.."\n');
    await f.put(group + '/' + name + '/src/lib.rs', '');
  }
  await f.put(group + '/standalone.rs', 'pub fn run() {}\n');
  f.git('init', '-q');
  f.save('Two members bound to the outer workspace');
  for (const materialized of [false, true]) {
    if (materialized) {
      await f.put(group + '/Cargo.toml', manifest('standalone') + '[lib]\npath="standalone.rs"\n[workspace]\n');
      f.save('Create the independent workspace manifest in the grouping directory');
    }
    for (const forRegistration of [false, true]) {
      for (const files of [['Cargo.toml'], ['Cargo.{toml,lock}'], ['Cargo.toml', 'Cargo.lock', 'extra.rs']]) {
        const paths = [...sources, ...files.map(name => group + '/' + name)];
        assert.deepEqual(codes(await f.compile(paths, { forRegistration })), [], files.join(', '));
      }
      const third = await f.compile([...sources, group + '/exporter.v2/Cargo.toml'], { forRegistration });
      assert.deepEqual(codes(third), ['contract_crate_required']);
    }
  }
  const names = Object.fromEntries(packages.map(name => [group + '/' + name, name]));
  assert.deepEqual(publicCodes([...sources, group + '/Cargo.lock', group + '/extra.rs'], names), []);
});

test('Cargo member rules distinguish an absent .rs member directory from a Rust file', async t => {
  const f = await fixture(t);
  sequenceModuleWrites(f.draft);
  const packages = ['vendor/input.rs', 'vendor/cache.rs'];
  const sources = packages.map(dir => dir + '/src/lib.rs');
  const future = 'vendor/exporter.rs';
  await f.put('architecture.policy.json', JSON.stringify(policy));
  for (const [i, dir] of packages.entries()) {
    await f.put(dir + '/Cargo.toml', manifest(['input', 'cache'][i]) + 'workspace="../.."\n');
    await f.put(sources[i], '');
  }
  await f.put('vendor/layout.rs', '// A regular file in the repository\n');
  f.git('init', '-q');
  for (const members of [
    ['vendor/*.rs', 'vendor/*.toml', 'vendor/*.lock'],
    ['vendor/input.rs', 'vendor/cache.rs', future],
    ['vendor/*'],
  ]) {
    await f.put('Cargo.toml', '[workspace]\nmembers=' + JSON.stringify(members) + '\n');
    f.save(members.join(', '));
    for (const forRegistration of [false, true]) {
      const check = paths => f.compile([...sources, ...paths], { forRegistration }).then(codes);
      assert.deepEqual(await check([future]), members[0] === 'vendor/*' ? [] : ['contract_crate_required']);
      assert.deepEqual(await check([future, future + '/docs/*.md']), ['contract_crate_required']);
      if (members[0] === 'vendor/*.rs') assert.deepEqual(await check([future + '.rs']), ['contract_crate_required']);
      if (members[0] === 'vendor/*') {
        const docs = '/docs/*.md';
        for (const scope of [
          'vendor/{exporter.rs,cache.rs}' + docs,
          'vendor/exporter.{rs,v2}' + docs,
          'vendor/exporter.@(rs|v2)' + docs,
          'vendor/exporter.r[s]' + docs,
          '{docs/guide.md,vendor/exporter.{rs,v2}' + docs + '}',
        ])
          assert.deepEqual(await check([future, scope]), ['contract_crate_required'], scope);
        assert.deepEqual(await check([future, 'vendor/exporter.{ts,v2}' + docs]), []);
        assert.deepEqual(await check([future, future + '/{..,../archive}' + docs]), []);
        assert.deepEqual(await check([future, '{' + future + ',vendor/exporter.v2' + docs + '}']), []);
      }
      assert.deepEqual(await check([future + '/**']), ['contract_crate_required']);
      assert.deepEqual(await check(['vendor/layout.rs']), []);
      assert.deepEqual(await check(['vendor/Cargo.toml', 'vendor/Cargo.lock']), []);
    }
  }
});

test('grouping a module subtree with other selectors preserves which branch selects its Cargo manifest', async t => {
  const f = await fixture(t);
  sequenceModuleWrites(f.draft);
  const module = 'crates/format';
  const cache = 'crates/cache/src/lib.rs';
  const docs = 'docs/format.md';
  await f.put('architecture.policy.json', JSON.stringify(policy));
  await f.put('Cargo.toml', manifest('host') + '[workspace]\nmembers=["crates/cache"]\n');
  await f.put('crates/cache/Cargo.toml', manifest('cache'));
  await f.put(cache, '');
  await f.put('src/lib.rs', '#[path="../crates/format/mod.rs"] pub mod format;\n');
  await f.put(module + '/mod.rs', 'pub struct Format;\n');
  await f.put(docs, 'Format documentation\n');
  f.git('init', '-q');
  f.save('Two packages and a separate module directory');
  const unrelated = Array.from({ length: 70 }, (_, i) => 'docs/guide' + i + '.md');
  for (const forRegistration of [false, true]) {
    const check = paths => f.compile(['Cargo.toml', cache, ...paths], { forRegistration }).then(codes);
    for (const suffix of ['/*', '/**', '/**/*', '/?*', '/+(*)', '/@(foo.md|*)']) {
      const branch = module + suffix;
      for (const scopes of [[branch, docs], ['{' + branch + ',' + docs + '}'], ['{' + docs + ',' + branch + '}']])
        assert.deepEqual(await check(scopes), [], scopes.join(' '));
    }
    const subtree = module + '/**';
    const manifestGlob = module + '/Cargo.*';
    assert.deepEqual(await check([module + '/src/lib.rs', module + '/{./Cargo.toml,docs/*.md}']), [
      'contract_crate_required',
    ]);
    for (const name of ['cargo.toml', 'Cargo.toml', 'Cargo.lock']) {
      const directed = path.posix.matchesGlob('Cargo.toml', '@(' + name + ')');
      for (const pattern of ['@(' + name + '|README*.md)', '@(@(' + name + '|Cargo.lock)|*)']) {
        const scopes = [module + '/src/lib.rs', module + '/' + pattern];
        assert.deepEqual(await check(scopes), directed ? ['contract_crate_required'] : [], pattern);
      }
    }
    assert.deepEqual(await check(['{' + [subtree, ...unrelated].join(',') + '}']), []);
    assert.deepEqual(await check(['{' + [subtree, ...unrelated, manifestGlob].join(',') + '}']), [
      'contract_crate_required',
    ]);
    assert.deepEqual(await check([subtree, manifestGlob]), ['contract_crate_required']);
    assert.deepEqual(await check(['{' + module + '/**,crates/cache/Cargo.toml}']), []);
    assert.deepEqual(await check([module + '/{*.md,**}']), []);
  }
});

test('a file-directed glob can select the existing workspace manifest when adding a third package', async t => {
  const f = await fixture(t);
  sequenceModuleWrites(f.draft);
  const next = 'crates/exporter';
  await f.put('architecture.policy.json', JSON.stringify(policy));
  await f.put('Cargo.toml', manifest('host') + '[workspace]\nmembers=["crates/cache"]\n');
  await f.put('src/lib.rs', '');
  await f.put('crates/cache/Cargo.toml', manifest('cache'));
  await f.put('crates/cache/src/lib.rs', '');
  await f.put(next + '/README.md', 'A future exporter\n');
  f.git('init', '-q');
  f.save('The existing root manifest can add exporter to the workspace');
  for (const forRegistration of [false, true]) {
    for (const rootScope of ['Cargo.*', 'Cargo.tom*', '*.toml', '{docs/**,Cargo.*}', 'Cargo.lo*', '*']) {
      const paths = [rootScope, 'crates/cache/src/lib.rs', next + '/Cargo.toml', next + '/src/lib.rs'];
      const findings = codes(await f.compile(paths, { forRegistration }));
      if (rootScope === '*') assert.deepEqual(findings, ['blueprint_owner_ambiguous']);
      else assert.deepEqual(findings, rootScope === 'Cargo.lo*' ? [] : ['contract_crate_required'], rootScope);
    }
  }
});

test('draft and registration require Wave 0 for equivalent nested manifest directory spellings', async t => {
  const f = await fixture(t);
  sequenceModuleWrites(f.draft);
  f.draft.tasks.find(task => task.id === 'scaffold').writePaths = ['package.json', 'tooling'];
  await f.put('architecture.policy.json', JSON.stringify(policy));
  await f.put('Cargo.toml', '[workspace]\nmembers=["crates/host", "crates/codec"]\n');
  for (const [dir, name] of [
    ['host', 'host'],
    ['codec', 'wire-contracts'],
  ]) {
    await f.put('crates/' + dir + '/Cargo.toml', manifest(name));
    await f.put('crates/' + dir + '/src/lib.rs', '');
  }
  f.git('init', '-q');
  f.save('Two packages before the exporter is created');
  const alias = 'crates/host/{plugins,plugins/}/';
  const suffix = '@(|-cli|-web)@(|-win|-linux|-mac|-ios|-android|-bsd)/Cargo.toml';
  const names = ['exporter', 'writer', 'reader'];
  const scopes = [
    'Cargo.toml',
    'crates/host/src/lib.rs',
    'crates/codec/src/lib.rs',
    'crates/host/plugins/exporter/src/lib.rs',
  ];
  for (const forRegistration of [false, true]) {
    for (const group of [[alias + '@(' + names.join('|') + ')' + suffix], names.map(name => alias + name + suffix)]) {
      assert.deepEqual(codes(await f.compile([...scopes, ...group], { forRegistration })), ['contract_crate_required']);
    }
  }
});

test('a planned manifest identifies its exact plugin package below a crates directory', () => {
  const host = 'crates/host';
  const child = host + '/plugins/exporter';
  const worker = 'crates/worker';
  const existing = { [host]: 'host', [worker]: 'worker' };
  const customModule = host + '/crates/parser/src/item.rs';
  assert.deepEqual(publicCodes([customModule, host + '/src/lib.rs', worker + '/src/lib.rs'], existing), []);
  const sources = [worker + '/src/lib.rs', host + '/src/lib.rs', child + '/src/lib.rs'];
  const lower = child + '/cargo.toml';
  const wildcard = child + '/Cargo.*';
  const split = publicCodes([...sources, lower, wildcard], existing);
  assert.deepEqual(split, []);
  assert.deepEqual(publicCodes([...sources, child + '/{cargo.toml,Cargo.*}'], existing), split);
  assert.deepEqual(publicCodes([...sources, '{' + lower + ',' + host + '/plugins/*/Cargo.toml}'], existing), split);
  for (const selector of ['@(cargo.toml|README*.md)', '{./Cargo.toml,docs/*.md}', '{cargo.toml,README*.md}']) {
    const scope = child + '/' + selector;
    const plansManifest = path.posix.matchesGlob(child + '/Cargo.toml', scope);
    const paths = [worker + '/src/lib.rs', host + '/src/lib.rs', child + '/src/lib.rs', scope];
    assert.deepEqual(publicCodes(paths, existing), plansManifest ? ['contract_crate_required'] : [], scope);
  }
  for (const names of [existing, { ...existing, [child]: 'exporter' }]) {
    for (const file of ['Cargo.toml', '{Cargo.toml,README.md}', '@(Cargo.toml|README.md)']) {
      const two = [worker + '/src/lib.rs', child + '/' + file, child + '/src/lib.rs'];
      assert.deepEqual(publicCodes(two, names), [], file);
      assert.deepEqual(publicCodes([...two, host + '/src/lib.rs'], names), ['contract_crate_required'], file);
    }
  }
});

test('an optional manifest suffix uses the matching filename branch to plan a third package', () => {
  const host = 'crates/host';
  const codec = 'crates/codec';
  const exporter = host + '/plugins/exporter';
  const names = { [host]: 'host', [codec]: 'codec' };
  const sources = [host, codec, exporter].map(dir => dir + '/src/lib.rs');
  const check = suffixes => publicCodes([...sources, ...suffixes.map(suffix => exporter + '/Cargo.' + suffix)], names);
  assert.deepEqual(check(['?(toml)', '?(lock*)']), ['contract_crate_required']);
  for (const suffix of ['?({toml,lock*})', '?(@(toml|lock*))', '?(toml|lock*)', '?({lock*,toml})', '?([t*]oml|lock*)'])
    assert.deepEqual(check([suffix]), ['contract_crate_required'], suffix);
  assert.deepEqual(check(['?(tom*|lock)']), []);

  for (const [left, right, required] of [
    ['toml', 'lock|bak', true],
    ['lock|toml', 'bak*', true],
    ['tom*|lock', 'bak', false],
  ]) {
    for (const operator of ['?', '@']) {
      const separate = check([`${operator}(${left})`, `${operator}(${right})`]);
      assert.deepEqual(separate, required ? ['contract_crate_required'] : []);
      for (const arms of [
        [left, right],
        [right, left],
      ]) {
        const grouped = `${operator}({${arms.join(',')}})`;
        assert.deepEqual(check([grouped]), separate, grouped);
      }
    }
  }
});

test('a large documentation sibling preserves an explicit future plugin manifest', () => {
  const host = 'crates/host';
  const codec = 'crates/codec';
  const exporter = host + '/plugins/exporter';
  const names = { [host]: 'host', [codec]: 'codec' };
  const sources = [host, codec, exporter].map(dir => dir + '/src/lib.rs');
  const guides = 'docs/{en,de,fr,it,es,pl,nl,sv,uk}/{install,start,format,input,output,errors,cli,config}.md';
  for (const branches of [
    ['Cargo.toml', guides],
    [guides, 'Cargo.toml'],
  ]) {
    const split = publicCodes([...sources, ...branches.map(branch => exporter + '/' + branch)], names);
    assert.deepEqual(split, ['contract_crate_required']);
    assert.deepEqual(publicCodes([...sources, exporter + '/{' + branches.join(',') + '}'], names), split);
  }
  assert.deepEqual(publicCodes([...sources, exporter + '/{Cargo.lock,' + guides + '}'], names), []);
});

test('the nearest nested manifest owns future sources, including a virtual workspace that shadows a package', async t => {
  const f = await fixture(t);
  await f.put('architecture.policy.json', JSON.stringify(policy));
  await f.put('native/codec/Cargo.toml', manifest('wire-contracts'));
  await f.put('native/codec/nested/Cargo.toml', '[workspace]\nmembers=[]\n');
  await f.put('native/codec/client/Cargo.toml', manifest('client'));
  for (const child of ['nested', 'client']) {
    const scope = `native/c*/${child}/src/new.rs`;
    assert.deepEqual(codes(await f.compile([scope])), [], scope);
    assert.deepEqual(
      codes(await f.compile(['native/codec/src/lib.rs', scope])),
      [],
      'another planned source belongs to the outer crate',
    );
  }
  assert.deepEqual(
    codes(await f.compile(['native/codec/src/lib.rs', 'native/{codec/README.md,codec/client/src/new.rs}'])),
    broad,
    'the nested source does not authorize the alternative in the outer crate',
  );
  assert.deepEqual(codes(await f.compile(['native/c*/src/new.rs'])), broad);
});

test('the nearest package or virtual workspace owns each arm of a data mask, including future files', async t => {
  const f = await fixture(t);
  await f.put('architecture.policy.json', JSON.stringify(policy));
  await f.put('native/codec/Cargo.toml', manifest('wire-contracts'));
  await f.put('native/codec/nested/Cargo.toml', '[workspace]\nmembers=["client"]\n');
  await f.put('native/codec/nested/client/Cargo.toml', manifest('client'));
  await f.put('native/codec/nested/client/models/header.ts', 'export interface Header {}\n');
  const outer = 'native/codec/schemas/api.proto';
  const nested = 'native/co*/nested/{models/header.ts,client/data/future.bin}';
  const mixed = 'native/{codec/nested/client/models/header.ts,codec/schemas/api.proto}';
  assert.deepEqual(codes(await f.compile([outer, 'native/codec/src/lib.rs', nested])), []);
  assert.deepEqual(codes(await f.compile([mixed])), broad);
  assert.deepEqual(
    codes(await f.compile(['native/{codec/schemas/api.proto,codec/nested/client/src/header.rs}'])),
    broad,
  );
  await f.put('native/codec/Cargo.toml', manifest('codec'));
  await f.put('native/codec/nested/client/Cargo.toml', manifest('wire-contracts'));
  assert.deepEqual(codes(await f.compile([nested])), broad);
  assert.deepEqual(codes(await f.compile(['native/co*/nested/models/header.ts'])), []);
  assert.deepEqual(codes(await f.compile(['native/co*/schemas/api.proto'])), []);
});

test('registration rejects unreadable selected package metadata and leaves unrelated metadata unread', async t => {
  const f = await fixture(t);
  await f.put('architecture.policy.json', JSON.stringify(policy));
  await f.put('native/codec/Cargo.toml', Buffer.from([0xff]));
  await f.put('tools/extra/Cargo.toml', manifest('client'));
  f.git('init', '-q');
  f.save('Invalid UTF-8 in codec');
  assert.deepEqual(codes(await f.compile(['tools/*/src/new.rs'], { forRegistration: true })), []);
  assert.deepEqual(codes(await f.compile([wildcard], { forRegistration: true })), [
    'blueprint_cargo_evidence_unavailable',
  ]);
  assert.deepEqual(codes(await f.compile([wildcard])), [], 'draft metadata is best effort');
  assert.deepEqual(codes(await f.compile([wildcard], { forRegistration: true, packageNames: {} })), []);
  assert.deepEqual(codes(await f.compile([schemaScope], { forRegistration: true })), [
    'blueprint_cargo_evidence_unavailable',
  ]);
  assert.deepEqual(codes(await f.compile([schemaScope])), []);
  assert.deepEqual(codes(await f.compile(['native/codec/schemas/*.proto'], { forRegistration: true })), []);
});

test('a crates/ directory hint cannot select a broken outer manifest across a nested boundary', async t => {
  const f = await fixture(t);
  await f.put('architecture.policy.json', JSON.stringify(policy));
  await f.put('crates/codec/Cargo.toml', 'invalid TOML');
  await f.put('crates/codec/nested/Cargo.toml', '[workspace]\nmembers=[]\n');
  f.git('init', '-q');
  f.save('Only the nested manifest owns this source');
  const nested = 'crates/codec/neste[d]/src/future.rs';
  assert.deepEqual(codes(await f.compile([nested], { forRegistration: true })), []);
  assert.deepEqual(
    codes(await f.compile(['crates/codec/neste[d]/schemas/future.proto'], { forRegistration: true })),
    [],
  );
  const reachesOuter = 'crates/codec/{nested/src/future.rs,src/future.rs}';
  assert.deepEqual(codes(await f.compile([reachesOuter], { forRegistration: true })), [
    'blueprint_cargo_evidence_unavailable',
  ]);
});

test('a JavaScript blueprint with a Rust sample outside a crate does not read an unrelated Cargo manifest', async t => {
  const f = await fixture(t);
  await f.put('native/codec/Cargo.toml', 'invalid TOML');
  await f.put('web/generated.js', '');
  await f.put('examples/schema.rs', '');
  f.git('init', '-q');
  f.save('Web app with a sample and unrelated Rust metadata');
  for (const forRegistration of [true, false])
    assert.deepEqual(
      codes(
        await f.compile(['web/*.js', 'examples/schema.rs', schemaScope], {
          hasRustToolchain: undefined,
          forRegistration,
        }),
      ),
      [],
    );
});
