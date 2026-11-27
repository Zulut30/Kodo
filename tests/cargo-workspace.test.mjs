import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fixture, toolRunner, put } from './fixtures/quality/helpers.mjs';
import { runQuality } from '../runtime/quality-runner.mjs';
import { QualityProfileRegistry } from '../runtime/quality.mjs';
import { planFastChecks } from '../runtime/task-fast-checks.mjs';
import { git } from '../runtime/workspace.mjs';
import { CargoDirectoryNames, cargoMemberMatcher } from '../runtime/cargo-member-paths.mjs';
import {
  compileCargoGlob,
  isBroadContractScope,
  isExplicitContractScope,
  resolveCargoWorkspace,
  scopeMatchesPath,
} from '../runtime/cargo-workspace.mjs';
import { rustContractCrateFindings } from '../runtime/project-blueprint.mjs';

test('Cargo normalizes current-directory components in member and exclude paths', () => {
  for (const [member, exclude, expected] of [
    ['./native/././codec/', [], ['codec']],
    ['native//codec', [], ['codec']],
    ['native/./c*', [], ['codec', 'control']],
    ['native/*/.', [], ['codec', 'control']],
    ['native/*', ['native/./codec'], ['control']],
    ['native/*', ['native//codec'], ['control']],
    ['native/./codec', ['native/codec'], ['codec']],
  ]) {
    const manifests = {
      'Cargo.toml': { workspace: { members: [member], exclude } },
      'native/codec/Cargo.toml': { package: { name: 'codec' } },
      'native/control/Cargo.toml': { package: { name: 'control' } },
    };
    const result = resolveCargoWorkspace({ manifests, files: Object.keys(manifests) });
    assert.deepEqual(result.unsupported, [], String(member));
    assert.deepEqual(
      result.members.map(pkg => pkg.name),
      expected,
    );
  }
});

test('Cargo resolves native member spellings and compares exclusions using the selected spelling', () => {
  const windows = path.sep === '\\';
  for (const [members, exclude, present, supported] of [
    [['native\\codec'], [], windows, windows],
    [['native\\co*'], [], windows, windows],
    [['Native/Codec'], [], windows, windows],
    [['Native/co*'], [], windows, windows],
    [['*/Codec'], [], windows, windows],
    [['native/Co*'], [], false, false],
    [['native/*'], ['native\\codec'], !windows, windows],
    [['native/*'], ['native/Codec'], true, true],
    [['Native/Codec'], ['native/codec'], windows, windows],
    [['native/*', 'native/Codec'], ['native/codec'], windows, windows],
  ]) {
    const result = resolveCargoWorkspace({
      manifests: {
        'Cargo.toml': { workspace: { members, exclude } },
        'native/codec/Cargo.toml': { package: { name: 'wire-contracts' } },
      },
    });
    assert.deepEqual(
      result.members.map(pkg => pkg.root),
      present ? ['native/codec'] : [],
      String(members),
    );
    assert.equal(result.unsupported.length === 0, supported, JSON.stringify({ members, exclude }));
  }
});

test('a recursive Cargo member glob compares the next component with the enumerated directory entry', () => {
  const lower = 'extras/a/exporter';
  const upper = 'extras/b/Exporter';
  const both = [lower, upper];
  const windows = path.sep === '\\';
  for (const [member, exclude, expected] of [
    ['extras/**/Exporter', [], [upper]],
    ['extras/**/Exporter', [lower], [upper]],
    ['extras/**/**/Exporter', [], [upper]],
    ['**/Exporter', [], [upper]],
    ['**/**/Exporter', [], [upper]],
    ['extras/**/[Ee]xporter', [], both],
    ['extras/*/Exporter', [], windows ? both : [upper]],
    ['extras/**/a/Exporter', [], windows ? [lower] : []],
    ['EXTRAS/**/Exporter', [], windows ? [upper] : []],
  ]) {
    const ws = resolveCargoWorkspace({
      manifests: {
        'Cargo.toml': { workspace: { members: [member], exclude } },
        [lower + '/Cargo.toml']: { package: { name: 'exporter' } },
        [upper + '/Cargo.toml']: { package: { name: 'monitor' } },
      },
    });
    assert.deepEqual(ws.members.map(pkg => pkg.root).sort(), expected, member);
    assert.deepEqual(
      ws.unsupported.map(item => item.reason),
      expected.length ? [] : ['member-glob-no-match'],
      member,
    );
  }
});

test('Cargo member globs count Unicode scalars in wildcards and character classes', () => {
  const parts = ['a', 'ab', 'é', 'e\u0301', '📦', '📮', '📦x', '𠮷'];
  const packages = Object.fromEntries(
    parts.map((part, i) => [`extras/${part}/Cargo.toml`, { package: { name: 'pkg' + i } }]),
  );
  for (const [pattern, matches] of [
    ['?', ['a', 'é', '📦', '📮', '𠮷']],
    ['??', ['ab', 'e\u0301', '📦x']],
    ['[📦-📮]', ['📦', '📮']],
    ['[!📦]', ['a', 'é', '📮', '𠮷']],
    ['?x', ['📦x']],
  ]) {
    const ws = resolveCargoWorkspace({
      manifests: { 'Cargo.toml': { workspace: { members: ['extras/' + pattern] } }, ...packages },
    });
    assert.deepEqual(ws.unsupported, [], pattern);
    assert.deepEqual(ws.members.map(pkg => pkg.root).sort(), matches.map(part => 'extras/' + part).sort(), pattern);
  }
});

test('Cargo member character classes match inside one path component', () => {
  const entries = ['axpkg', '𠮷.pkg', '𠮷0pkg', '𠮷zpkg', '𠮷/pkg'];
  const dir = entry => 'sensors/' + entry + '/Bridge';
  const packages = Object.fromEntries(
    entries.map((entry, i) => [dir(entry) + '/Cargo.toml', { package: { name: 'bridge-' + i } }]),
  );
  for (const [component, selected] of [
    ['?[!z]pkg', ['axpkg', '𠮷.pkg', '𠮷0pkg']],
    ['?[.-0]pkg', ['𠮷.pkg', '𠮷0pkg']],
    ['?/pkg', ['𠮷/pkg']],
  ]) {
    const pattern = dir(component);
    const glob = compileCargoGlob(pattern);
    assert.deepEqual(
      entries.filter(entry => glob.test(dir(entry))),
      selected,
      pattern,
    );
    const ws = resolveCargoWorkspace({
      manifests: { 'Cargo.toml': { workspace: { members: [pattern] } }, ...packages },
    });
    assert.deepEqual(ws.unsupported, [], pattern);
    assert.deepEqual(ws.members.map(pkg => pkg.root).sort(), selected.map(dir).sort(), pattern);
  }
});

test('recursive Cargo member walks apply exclusions to each spelling of a package', () => {
  const pattern = 'extras/**/plugins/Exporter/**/Unit';
  const dir = 'extras/plugins/Exporter/vendor/plugins/exporter/Unit';
  const alias = dir.replace('vendor/plugins/exporter', 'vendor/plugins/Exporter');
  const windows = path.sep === '\\';
  for (const [exclude, expected] of [
    [[dir], windows ? [dir] : []],
    [[alias], [dir]],
    [[dir, alias], []],
  ]) {
    const ws = resolveCargoWorkspace({
      manifests: {
        'Cargo.toml': { workspace: { members: [pattern], exclude } },
        [dir + '/Cargo.toml']: { package: { name: 'exporter' } },
      },
    });
    assert.deepEqual(ws.unsupported, [], JSON.stringify(exclude));
    assert.deepEqual(
      ws.members.map(pkg => pkg.root),
      expected,
      JSON.stringify(exclude),
    );
  }
  const duplicate = resolveCargoWorkspace({
    manifests: {
      'Cargo.toml': { workspace: { members: [pattern] } },
      [dir + '/Cargo.toml']: { package: { name: 'exporter' } },
    },
  });
  assert.deepEqual(
    duplicate.unsupported.map(row => row.reason),
    windows ? ['duplicate-crate-name'] : [],
  );
});

test('a trailing Cargo globstar enumerates descendants of each matched directory', () => {
  const hub = 'vault/node/Hub';
  const leaf = hub + '/branch/node/hub';
  const roots = [hub, hub + '/branch', hub + '/branch/node', leaf];
  const names = new CargoDirectoryNames(roots);
  for (const pattern of [hub + '/**', hub + '/**/**', 'vault/**/node/Hub/**']) {
    const match = cargoMemberMatcher(pattern, names);
    assert.deepEqual([...match.spellings(hub)], [], pattern);
    assert.deepEqual([...match.spellings(leaf)], [leaf], pattern);
  }
  const current = cargoMemberMatcher('vault/**/node/Hub', names);
  assert.equal(current(hub), hub);
  const packages = roots.map((dir, i) => [dir + '/Cargo.toml', { package: { name: 'crate-' + i } }]);
  for (const exclude of [[], [leaf]]) {
    const result = resolveCargoWorkspace({
      manifests: {
        'Cargo.toml': { workspace: { members: ['vault/[n]ode/Hub', 'vault/**/node/Hub/**'], exclude } },
        ...Object.fromEntries(packages),
      },
    });
    assert.deepEqual(result.unsupported, []);
    assert.deepEqual(
      result.members.map(member => member.root).sort(),
      roots.filter(dir => !exclude.includes(dir)).sort(),
    );
  }
});

test('a terminal Cargo globstar needs a directory entry even when ordinary files exist', () => {
  const dir = 'vault/leaf';
  const resolve = member =>
    resolveCargoWorkspace({
      manifests: {
        'Cargo.toml': { workspace: { members: [member] } },
        [dir + '/Cargo.toml']: { package: { name: 'leaf' }, lib: { path: 'unit.rs' } },
      },
      files: ['Cargo.toml', dir + '/Cargo.toml', dir + '/unit.rs'],
    });
  const recursive = resolve(dir + '/**');
  assert.deepEqual(recursive.members, []);
  assert.deepEqual(
    recursive.unsupported.map(row => row.reason),
    ['member-glob-no-match'],
  );
  const ordinary = resolve(dir + '/*');
  assert.deepEqual(ordinary.members, []);
  assert.deepEqual(ordinary.unsupported, []);
});

test('Cargo expands dot entries only at a directory that the member pattern actually reached', () => {
  const packages = {
    'vault/slots': 'slots',
    'vault/slots/.plugin': 'bridge',
    'vault/slots/.plugin/driver': 'driver',
    'vault/reader': 'reader',
  };
  const resolve = pattern =>
    resolveCargoWorkspace({
      manifests: {
        'Cargo.toml': { workspace: { members: [pattern] } },
        ...Object.fromEntries(
          Object.entries(packages).map(([dir, name]) => [dir + '/Cargo.toml', { package: { name } }]),
        ),
      },
    });
  for (const [pattern, members] of [
    ['vault/slots/.*/**', ['bridge', 'driver', 'reader', 'slots']],
    ['vault/slots/[.]*/**', ['driver']],
    ['vault/slots/.p*/**', ['driver']],
    ['vault/**/.*/driver', ['driver']],
    ['vault/*/./.plugin', ['bridge']],
  ]) {
    const result = resolve(pattern);
    assert.deepEqual(result.members.map(pkg => pkg.name).sort(), members, pattern);
    assert.deepEqual(result.unsupported, [], pattern);
  }
  const invalid = resolve('vault/**/./.plugin/driver');
  assert.deepEqual(invalid.members, []);
  assert.deepEqual(
    invalid.unsupported.map(row => row.reason),
    ['member-glob-no-match'],
  );
});

test('Cargo parent matches need a directory witness and normalize before exclusion', () => {
  const packages = { 'vault/yes/Bridge': 'included', 'vault/no/Bridge': 'file', 'vault/absent/Bridge': 'absent' };
  const manifests = Object.fromEntries(
    Object.entries(packages).map(([dir, name]) => [dir + '/Cargo.toml', { package: { name } }]),
  );
  for (const exclude of [[], ['vault/yes/Bridge']]) {
    const result = resolveCargoWorkspace({
      manifests: { 'Cargo.toml': { workspace: { members: ['vault/*/slots/.[.]/Bridge'], exclude } }, ...manifests },
      files: [...Object.keys(manifests), 'vault/yes/slots/marker', 'vault/no/slots'],
    });
    assert.deepEqual(
      result.members.map(pkg => pkg.name),
      exclude.length ? [] : ['included'],
    );
    assert.deepEqual(result.unsupported, []);
  }
});

test('a descending Cargo character range contributes no characters to its class', () => {
  for (const [pattern, accepted, rejected] of [
    ['?[z-a0]pkg', ['𠮷0pkg'], ['𠮷zpkg', '𠮷apkg']],
    ['[z-a0]]', ['0]'], ['z]', '0']],
    ['[z-a0**]', ['0', '*'], ['z', 'a', '/']],
    ['[[]-]', ['[-]'], ['[-', '-]']],
    ['?[!z-a0]pkg', ['𠮷apkg', '𠮷zpkg'], ['𠮷0pkg', 'a/pkg']],
    ['[🦀-🐈]x', [], ['🦀x', '🐈x']],
    ['[!🦀-🐈]x', ['🦀x', '🐈x'], ['/x']],
  ]) {
    const re = compileCargoGlob(pattern);
    assert.ok(re, pattern);
    for (const input of accepted) assert.equal(re.test(input), true, input);
    for (const input of rejected) assert.equal(re.test(input), false, input);
  }
});

test('a single Cargo member lookup prefers the exact spelling across recursive walks', () => {
  const dir = 'extras/plugins/exporter/vendor/plugins/Exporter/Unit';
  const alternate = dir.replace('plugins/exporter', 'plugins/Exporter');
  const match = cargoMemberMatcher('extras/**/plugins/Exporter/**/Unit', new CargoDirectoryNames([dir]));
  assert.equal(match(dir), dir);
  assert.deepEqual([...match.spellings(dir)], path.sep === '\\' ? [dir, alternate] : [dir]);
});

test('Cargo only probes native aliases on paths that can match the whole member pattern', () => {
  const dir = 'extras/plugins/exporter/vendor/plugins/exporter/Unit';
  const unrelated = Array.from({ length: 32 }, (_, i) => [
    'other/' + i + '/exporter/Cargo.toml',
    { package: { name: 'other-' + i } },
  ]);
  const probes = [];
  const ws = resolveCargoWorkspace({
    manifests: {
      ...Object.fromEntries(unrelated),
      'Cargo.toml': { workspace: { members: ['addons/*/Exporter', 'extras/**/plugins/Exporter/**/Unit'] } },
      [dir + '/Cargo.toml']: { package: { name: 'exporter' } },
      'extras/anchor/plugins/Exporter/Unit/Cargo.toml': { package: { name: 'anchor' } },
      'addons/control/Exporter/Cargo.toml': { package: { name: 'control' } },
    },
    probeAlias: original => {
      probes.push(original);
      return !original.includes('/vendor/plugins/');
    },
  });
  assert.deepEqual(ws.unsupported, []);
  assert.deepEqual(
    ws.members.map(pkg => pkg.name).sort(),
    path.sep === '\\' ? ['anchor', 'control', 'exporter'] : ['anchor', 'control'],
  );
  assert.equal(
    probes.some(p => p.startsWith('other/')),
    false,
  );
});

test('recursive Cargo walks probe aliases only on reachable path components', () => {
  const pattern = 'addons/*/unit/depot/**/unit/Depot/**/Leaf';
  const branches = ['east', 'north', 'south', 'west'];
  const dirs = branches.map(branch => 'addons/' + branch + '/unit/depot/area/unit/Depot/Leaf');
  const lower = 'addons/live/unit/depot/area/unit/depot/Leaf';
  const upper = lower.replace('area/unit/depot', 'area/unit/Depot');
  for (const allow of [false, true]) {
    const probes = [];
    const names = new CargoDirectoryNames([...dirs, lower], actual => {
      probes.push(actual);
      return allow;
    });
    const matcher = cargoMemberMatcher(pattern, names);
    for (const dir of dirs) assert.deepEqual([...matcher.spellings(dir)], [dir]);
    assert.deepEqual(probes, []);
    assert.deepEqual([...matcher.spellings(lower)], path.sep === '\\' && allow ? [upper] : []);
    assert.deepEqual(probes, path.sep === '\\' ? [lower.slice(0, -'/Leaf'.length)] : []);
  }
});

test('recursive Cargo walks stop probing after a required directory alias fails', () => {
  const dir = 'addons/live/depot/a/unit/shelf/b/Leaf';
  const probes = [];
  const names = new CargoDirectoryNames([dir], actual => {
    probes.push(actual);
    return false;
  });
  const matcher = cargoMemberMatcher('addons/*/Depot/**/unit/Shelf/**/Leaf', names);
  assert.deepEqual([...matcher.spellings(dir)], []);
  assert.deepEqual(probes, path.sep === '\\' ? ['addons/live/depot'] : []);
});

test('Cargo preserves distinct snapshot entries and detects two member spellings for one package', () => {
  const manifests = {
    'native/Codec/Cargo.toml': { package: { name: 'upper' } },
    'native/codec/Cargo.toml': { package: { name: 'lower' } },
  };
  const resolve = (members, files = manifests) =>
    resolveCargoWorkspace({ manifests: { 'Cargo.toml': { workspace: { members } }, ...files } });
  assert.deepEqual(
    resolve(['native/Codec']).members.map(pkg => pkg.name),
    ['upper'],
  );
  assert.deepEqual(
    resolve(['native/codec']).members.map(pkg => pkg.name),
    ['lower'],
  );
  assert.deepEqual(
    resolve(['native/CODEC']).unsupported.map(row => row.reason),
    ['missing-workspace-member'],
  );
  const single = { 'native/codec/Cargo.toml': manifests['native/codec/Cargo.toml'] };
  assert.deepEqual(
    resolve(['native/*', 'native/Codec'], single).unsupported.map(row => row.reason),
    [path.sep === '\\' ? 'duplicate-crate-name' : 'missing-workspace-member'],
  );
});

test('a literal workspace member overrides exclude below it when its plugin is selected', () => {
  const host = 'crates/host';
  const plugin = host + '/plugins/exporter';
  const glob = host + '/plugins/*';
  for (const [members, dependencies, expected, exclude = [plugin]] of [
    [[host, glob], {}, ['host', 'exporter']],
    [[host], { exporter: { path: 'plugins/exporter' } }, ['host', 'exporter']],
    [[host], {}, ['host']],
    [['crates/hos?', glob], {}, ['host']],
    [['crates/hos?', glob], { exporter: { path: 'plugins/exporter' } }, ['host']],
    [['crates/other/../host', glob], {}, ['host']],
    [['crates/hos?', glob], {}, ['host'], [plugin + '/Cargo.toml']],
    [['.', host, glob], {}, ['host', 'exporter']],
    ...(path.sep === '\\'
      ? [
          [['crates/Host'], { exporter: { path: 'plugins/exporter' } }, ['host', 'exporter']],
          [['crates/hos?'], { exporter: { path: 'plugins/Exporter' } }, ['host', 'exporter']],
          [['crates/hos?'], { exporter: { path: 'plugins/Exporter' } }, ['host'], [host + '/plugins/Exporter']],
          [['crates/Host', glob], {}, ['host']],
        ]
      : []),
  ]) {
    const manifests = {
      'Cargo.toml': { workspace: { members, exclude } },
      [host + '/Cargo.toml']: { package: { name: 'host' }, dependencies },
      [plugin + '/Cargo.toml']: { package: { name: 'exporter' } },
    };
    const result = resolveCargoWorkspace({ manifests });
    assert.deepEqual(result.unsupported, []);
    assert.deepEqual(
      result.members.map(pkg => pkg.name),
      expected,
      JSON.stringify(members),
    );
  }
});

test('contract scopes recognize Node glob syntax in a package name and preserve literal directories', () => {
  const packages = new Map([
    ['native/codec', 'wire-contracts'],
    ['native/control', 'control'],
  ]);
  for (const group of ['{codec,control}', '@(codec|control)', '+(co|dec)', '!(control)', '@(co@(d|x)ec|none)']) {
    const scope = `native/${group}/src/schema.rs`;
    assert.equal(scopeMatchesPath(scope, 'native/codec/src/schema.rs'), true, scope);
    assert.equal(isExplicitContractScope(scope, 'native/codec'), false, scope);
    assert.equal(isBroadContractScope(scope, 'native/codec'), true, scope);
    const findings = rustContractCrateFindings(
      { id: 'sample', epics: [], tasks: [{ id: 'schema', dependsOn: [], writePaths: [scope] }] },
      '',
      { schemaVersion: 2, language: 'rust', contractCrates: ['wire-contracts'] },
      undefined,
      packages,
    );
    assert.deepEqual(
      findings.map(finding => finding.code),
      ['contract_scope_too_broad'],
      scope,
    );
  }
  assert.equal(isBroadContractScope('native/!(codec)/src/schema.rs', 'native/codec'), false);
  assert.equal(isBroadContractScope('native/codec/src/@(model|wire).rs', 'native/codec'), false);
  assert.equal(isExplicitContractScope('native/codec(old)/src/schema.rs', 'native/codec(old)'), true);
  assert.equal(isBroadContractScope('native/{a..c}/src/schema.rs', 'native/b'), true);
  assert.equal(isBroadContractScope('native/{a..c}/src/schema.rs', 'native/d'), false);
  assert.equal(isBroadContractScope('{native/engines,libs/cores}/{a..c}/schema.rs', 'native/engines/b'), true);
  assert.equal(isBroadContractScope('native/{codec}/schema.rs', 'native/codec'), false);
  assert.equal(isBroadContractScope('@(model|wire).rs', ''), true);
});

const workspace = {
  'Cargo.toml':
    '[workspace]\nmembers=["crates/*"]\n[workspace.package]\nedition="2021"\n[workspace.dependencies]\nengine={package="core",path="crates/core"}',
  'Cargo.lock': `version = 4

[[package]]
name = "app"
version = "0.1.0"
dependencies = ["world"]

[[package]]
name = "core"
version = "0.1.0"

[[package]]
name = "world"
version = "0.1.0"
dependencies = ["core"]
`,
  'rust-toolchain.toml': '[toolchain]\nchannel="1.85.0"\ncomponents=["rustfmt","clippy"]',
};
for (const [name, deps] of [
  ['core', ''],
  ['world', '[dependencies]\nengine.workspace=true'],
  ['app', '[build-dependencies]\nworld={path="../world"}'],
]) {
  workspace[`crates/${name}/Cargo.toml`] =
    `[package]\nname="${name}"\nversion="0.1.0"\nedition.workspace=true\n${deps}`;
  workspace[`crates/${name}/src/lib.rs`] = 'pub fn value() {}\n';
}

test('workspace members inherit edition, lock and toolchain components', async t => {
  const fx = await fixture(t, workspace);
  const plan = await new QualityProfileRegistry().plan(fx.project, { capabilities: ['format', 'lint', 'typecheck'] });
  assert.equal(plan.checks.length, 9);
  for (const check of plan.checks) {
    assert.equal(check.edition, '2021', check.id);
    assert.equal(check.status, 'applicable', check.reason);
    if (check.tool === 'cargo') assert.equal(check.rustcVersion, '1.85.0');
  }
  const fake = toolRunner();
  const runner = (command, args, options) =>
    command === 'rustup' && args[0] === 'run' && args[1] === '1.85.0'
      ? fake.runner(args[2], args.slice(3), options)
      : fake.runner(command, args, options);
  const result = await runQuality({ ...fx, runner, capabilities: ['format', 'lint', 'typecheck'] });
  assert.equal(result.status, 'passed', JSON.stringify(result.receipts.map(c => c.reason)));
});

test('task-fast plans transitive consumers, workspace inputs and Rust timeouts', async t => {
  const { project: cwd } = await fixture(t, workspace);
  const run = {
    cwd,
    config: { commands: { test: [{ command: process.platform === 'win32' ? 'CARGO.EXE' : 'cargo', args: ['test'] }] } },
  };
  for (const [file, expected] of [
    ['crates/core/src/lib.rs', ['core', 'world', 'app']],
    ['crates/app/src/lib.rs', ['app']],
    ['Cargo.toml', null],
  ]) {
    const baseSha = await git(cwd, ['rev-parse', 'HEAD']);
    await put(cwd, file, workspace[file] + '\n');
    await git(cwd, [
      '-c',
      'user.name=test',
      '-c',
      'user.email=test@example.org',
      '-c',
      'commit.gpgSign=false',
      'commit',
      '-qam',
      'change',
    ]);
    const headSha = await git(cwd, ['rev-parse', 'HEAD']);
    for (const timeout of [undefined, 55555]) {
      const plan = await planFastChecks({
        run: { ...run, config: { ...run.config, fastChecks: { timeoutMs: timeout } } },
        baseSha,
        headSha,
      });
      const specs = expected?.map(n => n + '@0.1.0');
      assert.equal(plan.commands.length, 1);
      const [kind, ...args] = plan.commands[0].args;
      assert.equal(kind, 'test');
      assert.equal(args.pop(), '--locked');
      if (specs) {
        assert.deepEqual(
          args.filter((_, i) => i % 2 === 0),
          specs.map(() => '-p'),
        );
        assert.deepEqual(args.filter((_, i) => i % 2 === 1).sort(), specs.sort());
      } else assert.deepEqual(args, ['--workspace']);
      assert.ok(plan.commands.every(c => c.timeoutMs === (timeout ?? 600000)));
    }
  }
});

test('root lock and toolchain apply with a literal member edition', async t => {
  const fx = await fixture(t, {
    ...workspace,
    ...Object.fromEntries(
      Object.entries(workspace)
        .filter(([k]) => k.startsWith('crates/') && k.endsWith('Cargo.toml'))
        .map(([k, v]) => [k, v.replace('edition.workspace=true', 'edition="2021"')]),
    ),
  });
  const { checks } = await new QualityProfileRegistry().plan(fx.project, {
    capabilities: ['typecheck', 'format', 'lint'],
  });
  assert.deepEqual(
    checks.filter(c => c.status !== 'applicable').map(c => [c.root, c.reason, c.version, c.rustcVersion]),
    [],
  );
});

test('task-fast executes the crate plan with a warm target through a fake cargo executable', async t => {
  const { copyFile, link } = await import('node:fs/promises');
  const { default: path } = await import('node:path');
  const { runFastChecks } = await import('../runtime/task-fast-checks.mjs');
  // A copy of the Node launcher named cargo executes the tracked scripts "fetch" and "test".
  const shim = `
    console.log(JSON.stringify({
      args: process.argv.slice(2),
      target: process.env.CARGO_TARGET_DIR,
      offline: process.env.CARGO_NET_OFFLINE
    }));
  `;
  const fetch = `
    const fs = require('node:fs');
    const file = process.env.CARGO_TARGET_DIR + '/fetch-log';
    fs.appendFileSync(file, JSON.stringify([process.argv.slice(2), process.env.CARGO_NET_OFFLINE]) + '\\n');
    if (!fs.existsSync(file + '.allow')) process.exit(42);
  `;
  const { project: cwd, base: home } = await fixture(t, { ...workspace, fetch, test: shim });
  const cargo = path.join(home, process.platform === 'win32' ? 'cargo.exe' : 'cargo');
  await link(process.execPath, cargo).catch(() => copyFile(process.execPath, cargo));
  const baseSha = await git(cwd, ['rev-parse', 'HEAD']);
  await put(cwd, 'crates/app/src/lib.rs', 'pub fn new_value() {}\n');
  await git(cwd, [
    '-c',
    'user.name=test',
    '-c',
    'user.email=test@example.org',
    '-c',
    'commit.gpgSign=false',
    'commit',
    '-qam',
    'only app',
  ]);
  const run = {
    project: cwd,
    cwd,
    baseSha,
    directorBinding: { projectId: 'game' },
    config: { commands: { test: [{ command: cargo, args: ['test'] }] } },
  };
  const logs = [];
  const engine = {
    store: { home },
    setup: async () => {},
    checkCancelled() {},
    save() {},
    log() {},
    persistEvidence: async (_run, _kind, data) => {
      logs.push(data);
      return { path: path.join(home, 'fake-receipt'), sha256: '0'.repeat(64), bytes: 1 };
    },
  };
  const { writeFile, readFile } = await import('node:fs/promises');
  const target = path.join(home, 'cargo-target', 'game', 'slot-1');
  await assert.rejects(runFastChecks({ engine, run }), { code: 'cargo_fetch_failed' });
  await writeFile(path.join(target, 'fetch-log.allow'), '');
  for (let i = 0; i < 2; i++) {
    logs.length = 0;
    const checks = await runFastChecks({ engine, run });
    assert.ok(checks.complete);
    assert.deepEqual(checks.plan.affectedCrates, ['app']);
    assert.deepEqual(
      logs.map(row => JSON.parse(row.stdout)),
      [{ args: ['-p', 'app@0.1.0', '--locked'], target, offline: 'true' }],
    );
  }
  assert.deepEqual(
    (await readFile(path.join(target, 'fetch-log'), 'utf8'))
      .trim()
      .split(/\r?\n/)
      .map(line => JSON.parse(line)),
    [
      [['--locked'], 'false'],
      [['--locked'], 'false'],
    ],
  );
  await put(cwd, 'Cargo.lock', workspace['Cargo.lock'] + '# new graph\n');
  await git(cwd, [
    '-c',
    'user.name=test',
    '-c',
    'user.email=test@example.org',
    '-c',
    'commit.gpgSign=false',
    'commit',
    '-qam',
    'lock',
  ]);
  await runFastChecks({ engine, run });
  assert.equal((await readFile(path.join(target, 'fetch-log'), 'utf8')).trim().split(/\r?\n/).length, 3);
});

test('Cargo shared inputs widen the plan even in a workspace with a root package', async () => {
  const { parse } = await import('smol-toml');
  const { affectedCrates } = await import('../runtime/cargo-graph.mjs');
  const docs = new Map(
    Object.entries(workspace)
      .filter(([name]) => name.endsWith('Cargo.toml'))
      .map(([name, source]) => [name, parse(source)]),
  );
  docs.get('Cargo.toml').package = { name: 'root-package' };
  for (const file of ['Cargo.lock', 'rust-toolchain.toml', '.cargo/config', '.cargo/config.toml']) {
    const plan = affectedCrates(docs, [file]);
    assert.equal(plan.fallback, true, file);
    assert.deepEqual(plan.affectedCrates.sort(), ['app', 'core', 'root-package', 'world']);
  }
});

const graphDocs = () =>
  new Map([
    [
      'Cargo.toml',
      {
        package: { name: 'game', version: '1.0.0' },
        workspace: { members: ['.', 'crates/*'], exclude: ['crates/skip'] },
      },
    ],
    [
      'crates/render/Cargo.toml',
      {
        package: { name: 'config', version: '2.0.0' },
        dependencies: { other: { package: 'config', version: '1.0.0' } },
      },
    ],
  ]);
for (const file of [
  'assets/a.json',
  'crates/render/fixtures/a.txt',
  'crates/render/.cargo/config.toml',
  'crates/render/src/rust-toolchain.toml',
  'crates/render/src/a.json',
]) {
  test('unknown Cargo input widens ' + file, async () => {
    const { affectedCrates } = await import('../runtime/cargo-graph.mjs');
    assert.equal(affectedCrates(graphDocs(), [file]).fallback, true);
  });
}
for (const [key, value] of [
  ['lib', { path: '../shared.rs' }],
  ['bin', [{ path: '../shared.rs' }]],
  ['test', [{ path: '../shared.rs' }]],
  ['bench', [{ path: '../shared.rs' }]],
  ['example', [{ path: '../shared.rs' }]],
  ['build', '../build.rs'],
]) {
  test('external target forces workspace ' + key, async () => {
    const { affectedCrates } = await import('../runtime/cargo-graph.mjs');
    const docs = graphDocs(),
      doc = docs.get('crates/render/Cargo.toml');
    if (key === 'build') doc.package.build = value;
    else doc[key] = value;
    assert.equal(affectedCrates(docs, ['src/main.rs']).fallback, true);
    if (key === 'build') doc.package.build = 'custom.rs';
    else doc[key] = key === 'lib' ? { path: 'custom.rs' } : [{ path: 'custom.rs' }];
    assert.deepEqual(affectedCrates(docs, ['crates/render/custom.rs']).affectedCrates, ['config']);
  });
}
for (const [name, contents] of [
  ['include_str', 'include_str!("../../../src/main.rs")'],
  ['include_bytes', 'include_bytes! ( "../../../src/main.rs" )'],
  ['include', 'include!(concat!(env!("OUT_DIR"),"/file"))'],
  ['path', '#[path = "../../../src/main.rs"] mod m;'],
  ['patch', '[patch.crates-io]\nx={path="foo"}'],
  ['source', '[source.crates-io]\nreplace-with="vendor"'],
  ['build-script', 'fn main() {}'],
  ['manifest-link', ''],
]) {
  test('hidden Cargo edge ' + name, async t => {
    const { cargoPlanAt } = await import('../runtime/cargo-graph.mjs');
    const file =
      name === 'build-script'
        ? 'crates/app/build.rs'
        : ['patch', 'source'].includes(name)
          ? '.cargo/config'
          : 'crates/app/src/hidden.rs';
    const { project } = await fixture(t, { ...workspace, [file]: contents });
    const base = await git(project, ['rev-parse', 'HEAD']);
    if (name === 'manifest-link') {
      const oid = await git(project, ['rev-parse', 'HEAD:Cargo.toml']);
      await git(project, ['update-index', '--add', '--cacheinfo', '120000,' + oid + ',crates/shadow/Cargo.toml']);
    }
    await put(project, 'crates/world/src/lib.rs', 'pub fn changed() {}');
    await git(project, ['add', 'crates/world/src/lib.rs']);
    await git(project, [
      '-c',
      'user.name=test',
      '-c',
      'user.email=test@example.org',
      '-c',
      'commit.gpgSign=false',
      'commit',
      '-qm',
      'change',
    ]);
    // For the link case compare a later source-only change so the manifest diff itself cannot widen.
    let from = base;
    if (name === 'manifest-link') {
      from = await git(project, ['rev-parse', 'HEAD']);
      await put(project, 'crates/world/src/lib.rs', 'pub fn another() {}');
      await git(project, ['add', 'crates/world/src/lib.rs']);
      await git(project, [
        '-c',
        'user.name=test',
        '-c',
        'user.email=test@example.org',
        '-c',
        'commit.gpgSign=false',
        'commit',
        '-qm',
        'source',
      ]);
    }
    const plan = await cargoPlanAt(project, from, await git(project, ['rev-parse', 'HEAD']));
    if (name === 'build-script') {
      assert.equal(plan.fallback, false);
      assert.deepEqual(plan.affectedCrates.sort(), ['app', 'world']);
      assert.deepEqual(plan.reasons, ['cargo-build-script-input']);
    } else {
      const expected = {
        patch: 'cargo-config-dependencies',
        source: 'cargo-config-dependencies',
        'manifest-link': 'cargo-linked-input',
      };
      assert.equal(plan.fallback, true);
      assert.deepEqual(plan.reasons, [expected[name] ?? 'cargo-source-path']);
    }
  });
}
test('Cargo membership stops at excludes and nested workspace roots', async () => {
  const { cargoMembers } = await import('../runtime/cargo-graph.mjs');
  const docs = graphDocs();
  for (const [dir, name] of [
    ['crates/skip/child', 'skip-child'],
    ['crates/inner', 'inner'],
    ['crates/inner/member', 'inner-member'],
  ])
    docs.set(dir + '/Cargo.toml', { package: { name } });
  docs.get('crates/inner/Cargo.toml').workspace = { members: ['member'] };
  for (const root of ['', '.']) assert.deepEqual([...cargoMembers(docs, root).keys()].sort(), ['', 'crates/render']);
  assert.deepEqual([...cargoMembers(docs, 'crates/inner').keys()].sort(), ['crates/inner', 'crates/inner/member']);
});
test('nested CRLF virtual workspace selects the nearest edition and toolchain without package.json', async t => {
  const fx = await fixture(t, {
    ...workspace,
    'Cargo.toml': '[workspace]\nmembers=["**"]\n[workspace.package]\nedition="2018"',
    'crates/Cargo.toml':
      '[workspace]\r\nmembers=["*"]\r\n[workspace.package]\r\nedition="2024"\r\n[workspace.dependencies]\r\nengine={package="core",path="core"}',
    'crates/Cargo.lock': workspace['Cargo.lock'],
    'crates/rust-toolchain.toml': '[toolchain]\r\nchannel="1.88.0"\r\n',
  });
  const { checks } = await new QualityProfileRegistry().plan(fx.project, { capabilities: ['typecheck'] });
  assert.ok(
    checks.length &&
      checks.every(c => c.status === 'applicable' && c.edition === '2024' && c.rustcVersion === '1.88.0'),
  );
});
test('Rust selectors distinguish a registry dependency with the same name', async t => {
  const { project: cwd } = await fixture(t, {
    'Cargo.toml': '[package]\nname="config"\nversion="2.0.0"\n[dependencies]\nother={package="config",version="1.0.0"}',
    'src/lib.rs': '',
    'Cargo.lock': 'version=4',
  });
  const baseSha = await git(cwd, ['rev-parse', 'HEAD']);
  await put(cwd, 'src/lib.rs', 'pub fn x() {}');
  await git(cwd, [
    '-c',
    'user.name=test',
    '-c',
    'user.email=test@example.org',
    '-c',
    'commit.gpgSign=false',
    'commit',
    '-qam',
    'change',
  ]);
  const { normalizeConfig } = await import('../runtime/config.mjs');
  const plan = await planFastChecks({
    run: { cwd, config: normalizeConfig({}) },
    baseSha,
    headSha: await git(cwd, ['rev-parse', 'HEAD']),
  });
  assert.deepEqual(
    plan.commands.map(c => c.args),
    [['test', '-p', 'config@2.0.0', '--locked']],
  );
});
test('optional Rust settings validate without adding absent policy keys', async () => {
  const { normalizeConfig } = await import('../runtime/config.mjs');
  for (const input of [
    { rust: null },
    { rust: { sccache: 1 } },
    { rust: { extra: true } },
    { fastChecks: [] },
    { fastChecks: { timeoutMs: 0 } },
    { fastChecks: { extra: true } },
  ])
    assert.throws(() => normalizeConfig(input));
  const config = normalizeConfig({});
  assert.ok(!Object.hasOwn(config, 'rust') && !Object.hasOwn(config, 'fastChecks'));
});

test('Rust noTests fallback keeps the Rust default and explicit limit', async () => {
  const { fullFastFallback } = await import('../runtime/task-fast-checks.mjs');
  for (const timeout of [undefined, 9876]) {
    const run = {
      config: { commands: { test: [{ command: 'cargo', args: ['test'] }] }, fastChecks: { timeoutMs: timeout } },
    };
    const plan = fullFastFallback(run, { rust: true });
    assert.deepEqual(
      plan.commands.map(c => [c.args, c.timeoutMs]),
      [[['test', '--workspace', '--locked'], timeout ?? 600000]],
    );
  }
});

test('a root package cannot claim a nested manifest or read another member as private source', async () => {
  const { affectedCrates } = await import('../runtime/cargo-graph.mjs');
  const docs = graphDocs();
  docs.set('src/vendor/Cargo.toml', { package: { name: 'vendored', version: '1.0.0' } });
  assert.equal(affectedCrates(docs, ['src/vendor/src/lib.rs']).fallback, true);
  for (const source of [
    'include!("../crates/render/src/lib.rs")',
    '#[path="../crates/render/src/lib.rs"] mod render;',
  ]) {
    const snapshot = { entries: [], sources: new Map([['src/lib.rs', source]]) };
    assert.equal(affectedCrates(docs, ['crates/render/src/lib.rs'], snapshot).fallback, true);
  }
  docs.get('Cargo.toml').lib = { path: 'crates/render/shared.rs' };
  assert.equal(affectedCrates(docs, ['crates/render/src/lib.rs']).fallback, true);
});
test('same registry version also widens package selection', async () => {
  const { affectedCrates } = await import('../runtime/cargo-graph.mjs');
  const sources = new Map([
    ['Cargo.lock', '[[package]]\nname="config"\nversion="2.0.0"\nsource="registry+https://example.invalid"'],
  ]);
  assert.deepEqual(affectedCrates(graphDocs(), ['crates/render/src/lib.rs'], { entries: [], sources }).reasons, [
    'cargo-ambiguous-package',
  ]);
});

test('two Cargo slots share a single successful fetch for one lock and Cargo home', { timeout: 30000 }, async t => {
  const { warmCargoDependencies } = await import('../runtime/cargo-fetch.mjs');
  const { withCargoSlot } = await import('../runtime/cargo-slots.mjs');
  const { readFile } = await import('node:fs/promises');
  const { default: path } = await import('node:path');
  const source =
    "const fs=require('node:fs');fs.appendFileSync(process.env.FETCH_LOG,'fetched\\n');setTimeout(()=>{},200)";
  const { base: home, project: cwd } = await fixture(t, { 'Cargo.lock': 'version=4', fetch: source });
  const file = path.join(home, 'fetch-log');
  const both = Promise.withResolvers();
  t.signal.addEventListener('abort', () => both.reject(t.signal.reason), { once: true });
  let waiting = 0;
  const results = await Promise.all(
    ['game', 'engine'].map(projectId =>
      withCargoSlot(
        { home, projectId, maxHeavyBuilds: 2, signal: t.signal, env: { ...process.env, FETCH_LOG: file } },
        async env => {
          if (++waiting === 2) both.resolve();
          await both.promise;
          await warmCargoDependencies({ home, cwd, command: process.execPath, env, timeoutMs: 10000 });
          return path.basename(env.CARGO_TARGET_DIR);
        },
      ),
    ),
  );
  assert.deepEqual(results.sort(), ['slot-1', 'slot-2']);
  assert.equal(await readFile(file, 'utf8'), 'fetched\n');
});

test('Cargo scans an explicit Rust target with a nonstandard extension at HEAD', async t => {
  const { cargoPlanAt } = await import('../runtime/cargo-graph.mjs');
  const filename = 'crates/app/entry.inc';
  const { project } = await fixture(t, {
    ...workspace,
    'crates/app/Cargo.toml': workspace['crates/app/Cargo.toml'] + '\n[lib]\npath="entry.inc"\n',
    [filename]: 'include_str!("../core/src/lib.rs");',
  });
  const base = await git(project, ['rev-parse', 'HEAD']);
  await put(project, 'crates/core/src/lib.rs', 'pub fn changed() {}');
  await git(project, [
    '-c',
    'user.name=test',
    '-c',
    'user.email=test@example.org',
    '-c',
    'commit.gpgSign=false',
    'commit',
    '-qam',
    'edit',
  ]);
  assert.deepEqual((await cargoPlanAt(project, base, await git(project, ['rev-parse', 'HEAD']))).reasons, [
    'cargo-source-path',
  ]);
});

test('clean Cargo homes on the same machine each get a warmup', async t => {
  const { warmCargoDependencies } = await import('../runtime/cargo-fetch.mjs');
  const { readFile } = await import('node:fs/promises');
  const { default: path } = await import('node:path');
  const { base: home, project: cwd } = await fixture(t, {
    'Cargo.lock': 'version=4',
    fetch: "require('node:fs').appendFileSync(process.env.FETCH_LOG,'fetched\\n');",
  });
  const file = path.join(home, 'fetch-log');
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toUpperCase() !== 'CARGO_HOME'));
  const name = process.platform === 'win32' ? 'Cargo_Home' : 'CARGO_HOME';
  for (const directory of ['first', 'second']) {
    await warmCargoDependencies({
      home,
      cwd,
      command: process.execPath,
      env: { ...env, FETCH_LOG: file, [name]: path.join(home, directory) },
      timeoutMs: 10000,
    });
  }
  assert.equal(await readFile(file, 'utf8'), 'fetched\nfetched\n');
});

test('D2: cargoMembers matches all live cargo metadata fixtures and unsupported triggers full fallback', async () => {
  const { readdir, readFile } = await import('node:fs/promises');
  const { default: path } = await import('node:path');
  const { parse } = await import('smol-toml');
  const { cargoMembers, cargoWorkspace, affectedCrates } = await import('../runtime/cargo-graph.mjs');
  const fixturesDir = path.join(import.meta.dirname, 'fixtures', 'cargo-metadata');
  const entries = (await readdir(fixturesDir)).filter(name => name.endsWith('.json')).sort();
  assert.ok(entries.length >= 27, `expected at least 27 cargo-metadata fixtures, got ${entries.length}`);
  for (const name of entries) {
    const fx = JSON.parse(await readFile(path.join(fixturesDir, name), 'utf8'));
    const docs = new Map(Object.entries(fx.manifests).map(([file, text]) => [file, parse(text)]));
    const startDir = fx.startDir || '';
    const resolved = cargoWorkspace(docs, startDir, { files: fx.files });
    if (fx.ok === false) {
      assert.ok(
        resolved.unsupported.some(row => row.reason === fx.expectedReason),
        `${name}: expected unsupported ${fx.expectedReason}, got ${JSON.stringify(resolved.unsupported)}`,
      );
      if (startDir === '') {
        const snapshot = {
          entries: (fx.files || Object.keys(fx.manifests)).map(file => ({ file, mode: '100644' })),
          sources: new Map(),
        };
        const plan = affectedCrates(docs, ['crates/a/src/lib.rs'], snapshot);
        assert.equal(plan.fallback, true, `${name}: unsupported workspace must fall back`);
        assert.deepEqual(plan.reasons, ['cargo-workspace-unsupported'], `${name}: fallback reason`);
        assert.deepEqual(plan.packageSpecs, [], `${name}: fallback clears packageSpecs`);
      }
      continue;
    }
    assert.deepEqual(
      resolved.unsupported,
      [],
      `${name}: unexpected unsupported ${JSON.stringify(resolved.unsupported)}`,
    );
    const members = cargoMembers(docs, startDir, { files: fx.files });
    const actual = [...members.entries()]
      .map(([dir, doc]) => ({ name: doc.package.name, manifest: dir ? `${dir}/Cargo.toml` : 'Cargo.toml' }))
      .sort((a, b) => (a.manifest < b.manifest ? -1 : a.manifest > b.manifest ? 1 : 0));
    assert.deepEqual(actual, fx.workspace_members, `${name}: cargoMembers mismatch`);
  }

  // Malformed glob -> unsupported -> full fallback with cargo-workspace-unsupported.
  const badGlobDocs = new Map([
    ['Cargo.toml', parse('[workspace]\nmembers = ["crates/[unclosed"]\n')],
    ['crates/a/Cargo.toml', parse('[package]\nname = "a"\nversion = "0.1.0"\nedition = "2021"\n')],
  ]);
  const badPlan = affectedCrates(badGlobDocs, ['crates/a/src/lib.rs']);
  assert.equal(badPlan.fallback, true);
  assert.deepEqual(badPlan.reasons, ['cargo-workspace-unsupported']);
});

test('D2: rustWorkspaceRoots uses canonical Cargo resolver for explicit package.workspace and excluded crates', async t => {
  const fx = await fixture(t, {
    'Cargo.toml':
      '[workspace]\nresolver = "2"\nmembers = ["nested/sub", "peer"]\nexclude = ["crates/excluded"]\n[workspace.package]\nedition = "2024"\n',
    'Cargo.lock': 'version = 4\n',
    'rust-toolchain.toml': '[toolchain]\nchannel = "1.85.0"\ncomponents = ["clippy", "rustfmt"]\n',
    'nested/Cargo.toml': '[workspace]\nresolver = "2"\nmembers = ["other"]\n[workspace.package]\nedition = "2018"\n',
    'nested/Cargo.lock': 'version = 4\n',
    'nested/other/Cargo.toml': '[package]\nname = "other"\nversion = "0.1.0"\nedition.workspace = true\n',
    'nested/other/src/lib.rs': 'pub fn other() {}\n',
    'nested/sub/Cargo.toml':
      '[package]\nname = "sub"\nversion = "0.1.0"\nedition.workspace = true\nworkspace = "../.."\n',
    'nested/sub/src/lib.rs': 'pub fn sub() {}\n',
    'peer/Cargo.toml': '[package]\nname = "peer"\nversion = "0.1.0"\nedition.workspace = true\n',
    'peer/src/lib.rs': 'pub fn peer() {}\n',
    'crates/excluded/Cargo.toml': '[package]\nname = "excluded"\nversion = "0.1.0"\nedition.workspace = true\n',
    'crates/excluded/src/lib.rs': 'pub fn excluded() {}\n',
  });
  const { checks } = await new QualityProfileRegistry().plan(fx.project, { capabilities: ['typecheck'] });
  const byRoot = new Map(checks.map(c => [c.root, c]));
  assert.equal(byRoot.get('nested/sub').status, 'applicable');
  assert.equal(byRoot.get('nested/sub').edition, '2024');
  assert.equal(byRoot.get('nested/other').status, 'applicable');
  assert.equal(byRoot.get('nested/other').edition, '2018');
  assert.equal(byRoot.get('peer').status, 'applicable');
  assert.equal(byRoot.get('peer').edition, '2024');
  // Excluded crate cannot inherit root workspace edition or Cargo.lock.
  assert.equal(byRoot.get('crates/excluded').edition, null);
  assert.equal(byRoot.get('crates/excluded').status, 'missing');
  assert.equal(byRoot.get('crates/excluded').reason, 'cargo_lock_required');
});

test('R3: rustWorkspaceRoots resolves 500 crates and 20k files within 1s budget', async () => {
  const { performance } = await import('node:perf_hooks');
  const { rustWorkspaceRoots } = await import('../runtime/quality.mjs');
  const documents = new Map();
  const files = ['Cargo.toml', 'Cargo.lock', 'nested/Cargo.toml', 'nested/Cargo.lock'];
  documents.set('Cargo.toml', {
    workspace: {
      resolver: '2',
      members: ['crates/*', 'nested/sub'],
      exclude: ['crates/excluded'],
      package: { edition: '2024' },
    },
  });
  documents.set('nested/Cargo.toml', {
    workspace: { resolver: '2', members: ['other'], package: { edition: '2021' } },
  });
  for (let i = 0; i < 500; i++) {
    const dir = `crates/c${String(i).padStart(3, '0')}`;
    documents.set(`${dir}/Cargo.toml`, { package: { name: `c${i}`, version: '0.1.0', edition: { workspace: true } } });
    files.push(`${dir}/Cargo.toml`);
    for (let f = 0; f < 39; f++) files.push(`${dir}/src/mod_${f}.rs`);
  }
  documents.set('crates/excluded/Cargo.toml', {
    package: { name: 'excluded', version: '0.1.0', edition: '2021' },
  });
  documents.set('nested/sub/Cargo.toml', {
    package: { name: 'sub', version: '0.1.0', edition: { workspace: true }, workspace: '../..' },
  });
  documents.set('nested/other/Cargo.toml', {
    package: { name: 'other', version: '0.1.0', edition: { workspace: true } },
  });
  files.push('crates/excluded/Cargo.toml', 'nested/sub/Cargo.toml', 'nested/other/Cargo.toml');
  assert.ok(files.length >= 20000, `expected >= 20000 files, got ${files.length}`);

  const started = performance.now();
  const roots = rustWorkspaceRoots(documents, files);
  const elapsedMs = performance.now() - started;

  assert.equal(roots.get('crates/c000'), '');
  assert.equal(roots.get('crates/c499'), '');
  assert.equal(roots.get('nested/sub'), '');
  assert.equal(roots.get('nested/other'), 'nested');
  assert.equal(roots.has('crates/excluded'), false);
  assert.equal(roots.size, 502);
  assert.ok(
    elapsedMs < 1000,
    `rustWorkspaceRoots(500 crates, ${files.length} files) took ${elapsedMs.toFixed(1)}ms (> 1000ms)`,
  );
});

test('R6: cargoFeedbackGraph batches include! fragment reads instead of running ls-tree per file', async t => {
  const { execFileSync } = await import('node:child_process');
  const { cargoFeedbackGraph } = await import('../runtime/cargo-graph.mjs');
  const { readSourceSnapshot } = await import('../runtime/ci-graph.mjs');
  const fx = await fixture(t, {
    'Cargo.toml': '[workspace]\nresolver = "2"\nmembers = ["crates/*"]\n',
    'Cargo.lock': 'version = 4\n\n[[package]]\nname = "core"\nversion = "0.1.0"\n',
    'crates/core/Cargo.toml': '[package]\nname = "core"\nversion = "0.1.0"\nedition = "2021"\n',
    'crates/core/src/lib.rs': [
      'include!("f1.inc");',
      'include!("f2.inc");',
      'include!("f3.inc");',
      'include!("f4.inc");',
      'pub fn v() -> i32 { A + B + C + D }',
      '',
    ].join('\n'),
    'crates/core/src/f1.inc': 'const A: i32 = 1;\n',
    'crates/core/src/f2.inc': 'const B: i32 = 2;\n',
    'crates/core/src/f3.inc': 'const C: i32 = 3;\n',
    'crates/core/src/f4.inc': 'const D: i32 = 4;\n',
  });
  const baseSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: fx.project, encoding: 'utf8' }).trim();
  await put(
    fx.project,
    'crates/core/src/lib.rs',
    [
      'include!("f1.inc");',
      'include!("f2.inc");',
      'include!("f3.inc");',
      'include!("f4.inc");',
      'pub fn v() -> i32 { A + B + C + D + 1 }',
      '',
    ].join('\n'),
  );
  execFileSync('git', ['add', '-A'], { cwd: fx.project });
  // CI has no global Git identity: the commit names its own author.
  execFileSync(
    'git',
    ['-c', 'user.name=Kodo Test', '-c', 'user.email=kodo-test@example.invalid', 'commit', '-qm', 'edit lib'],
    { cwd: fx.project },
  );
  const headSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: fx.project, encoding: 'utf8' }).trim();

  let snapshotCalls = 0;
  const countingSnapshot = async (...args) => {
    snapshotCalls++;
    return readSourceSnapshot(...args);
  };
  const plan = await cargoFeedbackGraph(
    { project: fx.project, baseSha, headSha, changedPaths: [] },
    { readSourceSnapshot: countingSnapshot },
  );
  assert.equal(plan.fallback, false, JSON.stringify(plan));
  assert.deepEqual(plan.affectedCrates, ['core']);
  assert.ok(
    snapshotCalls >= 1 && snapshotCalls <= 2,
    `expected 1..2 batched snapshot calls for 4 include! fragments, got ${snapshotCalls}`,
  );
});
