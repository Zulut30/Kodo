import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, toolRunner, put } from './fixtures/quality/helpers.mjs';
import { runQuality } from '../runtime/quality-runner.mjs';
import { QualityProfileRegistry } from '../runtime/quality.mjs';
import { planFastChecks } from '../runtime/task-fast-checks.mjs';
import { git } from '../runtime/workspace.mjs';

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
  const run = { cwd, config: { commands: { test: [{ command: 'cargo', args: ['test'] }] } } };
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
      const selectors = expected ? expected.map(n => ['-p', n]) : [['--workspace']];
      assert.deepEqual(
        plan.commands.map(c => c.args.join(' ')).sort(),
        selectors
          .flatMap(s => [
            ['check', ...s, '--tests'],
            ['test', ...s],
          ])
          .map(a => a.join(' '))
          .sort(),
      );
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
  // A copy of the Node launcher named cargo executes the tracked scripts "check" and "test".
  const shim = 'console.log(JSON.stringify({args:process.argv.slice(2),target:process.env.CARGO_TARGET_DIR}));';
  const { project: cwd, base: home } = await fixture(t, { ...workspace, check: shim, test: shim });
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
  const checks = await runFastChecks({ engine, run });
  assert.ok(checks.complete);
  assert.deepEqual(checks.plan.affectedCrates, ['app']);
  assert.deepEqual(
    logs.map(row => row.exitCode),
    [0, 0],
  );
  assert.deepEqual(
    logs.map(row => JSON.parse(row.stdout)),
    [
      { args: ['-p', 'app', '--tests'], target: path.join(home, 'cargo-target', 'game', 'slot-1') },
      { args: ['-p', 'app'], target: path.join(home, 'cargo-target', 'game', 'slot-1') },
    ],
  );
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
