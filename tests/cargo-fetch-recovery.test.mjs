import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { link, copyFile, readFile, writeFile, unlink } from 'node:fs/promises';
import { fixture, put } from './fixtures/quality/helpers.mjs';
import { warmCargoDependencies } from '../runtime/cargo-fetch.mjs';
import { runFastChecks } from '../runtime/task-fast-checks.mjs';
import { git } from '../runtime/workspace.mjs';

test('warm marker follows active Cargo version and source configuration', async t => {
  const { base: home, project: cwd } = await fixture(t, { 'Cargo.lock': 'version=4' });
  let version = 'cargo 1.85.0',
    fetches = 0;
  const runCommand = async (_cmd, args) => {
    if (['--version', '-V'].includes(args[0])) return { code: 0, stdout: version };
    assert.deepEqual(args, ['fetch', '--locked']);
    fetches++;
    return { code: 0 };
  };
  const warm = () =>
    warmCargoDependencies({
      home,
      cwd,
      command: 'fake-cargo',
      env: { CARGO_HOME: path.join(home, 'cargo-home') },
      timeoutMs: 1000,
      runCommand,
    });
  await warm();
  await warm();
  assert.equal(fetches, 1);
  version = 'cargo 1.90.0';
  await warm();
  assert.equal(fetches, 2);
  await put(cwd, '.cargo/config.toml', '[source.crates-io]\nreplace-with="first"');
  await warm();
  await warm();
  assert.equal(fetches, 3);
  await put(cwd, '.cargo/config.toml', '[source.crates-io]\nreplace-with="second"');
  await warm();
  assert.equal(fetches, 4);
});

async function fakeRun(t, locked = true, extraFiles = {}, cargoArgs = [['test']]) {
  const fetch = [
    "const fs=require('node:fs');const dir=process.env.CARGO_TARGET_DIR;",
    "fs.appendFileSync(dir+'/calls','fetch\\n');",
    "if(fs.existsSync(dir+'/stale-lock')){console.error('error: the lock file Cargo.lock needs to be updated but --locked was passed');process.exit(101);}",
    "if(fs.existsSync(dir+'/evicted'))fs.unlinkSync(dir+'/evicted');",
  ].join('\n');
  const script = [
    "const fs=require('node:fs');const dir=process.env.CARGO_TARGET_DIR;",
    "fs.appendFileSync(dir+'/calls',process.argv[1].split(/[\\\\/]/).pop()+'\\n');",
    "if(['evicted','unavailable'].some(name=>fs.existsSync(dir+'/'+name))){console.error('error: failed to download example v1.0.0\\nCaused by:\\n  attempting to make an HTTP request, but --offline was specified');process.exit(101);}",
    "if(fs.existsSync(dir+'/locked-test') && process.argv.includes('--locked')){console.error('error: cannot update the lock file Cargo.lock because --locked was passed');process.exit(101);}",
    "if(fs.existsSync(dir+'/compiler')){ console.error('error[E0308]: mismatched types');process.exit(101);}",
  ].join('\n');
  const files = {
    'Cargo.toml': '[workspace]\nmembers=["crates/a"]',
    'crates/a/Cargo.toml': '[package]\nname="a"\nversion="1.0.0"',
    'crates/a/src/lib.rs': '',
    'README.md': 'hello',
    fetch,
    test: script,
    metadata: script,
    ...extraFiles,
    '.gitignore': locked ? '' : 'Cargo.lock',
  };
  if (locked) files['Cargo.lock'] = 'version=4';
  const { project: cwd, base: home } = await fixture(t, files);
  const cargo = path.join(home, process.platform === 'win32' ? 'cargo.exe' : 'cargo');
  await link(process.execPath, cargo).catch(() => copyFile(process.execPath, cargo));
  const baseSha = await git(cwd, ['rev-parse', 'HEAD']);
  const commit = async file => {
    await put(cwd, file, '// edited');
    await git(cwd, [
      '-c',
      'user.name=test',
      '-c',
      'user.email=t@example.org',
      '-c',
      'commit.gpgSign=false',
      'commit',
      '-qam',
      'edit',
    ]);
  };
  const run = {
    cwd,
    project: cwd,
    baseSha,
    directorBinding: { projectId: 'game' },
    config: { commands: { test: cargoArgs.map(args => ({ command: cargo, args })) } },
  };
  const engine = {
    store: { home },
    setup: async () => {},
    save() {},
    log() {},
    checkCancelled() {},
    persistEvidence: async () => ({ path: path.join(home, 'log'), bytes: 1, sha256: '0'.repeat(64) }),
  };
  const target = path.join(home, 'cargo-target', 'game', 'slot-1');
  return {
    go: () => runFastChecks({ engine, run }),
    set: name => writeFile(path.join(target, name), ''),
    calls: () => readFile(path.join(target, 'calls'), 'utf8'),
    commit,
    cwd,
  };
}
test('offline cache eviction refetches once and retries only the Cargo step', async t => {
  const f = await fakeRun(t);
  await f.commit('crates/a/src/lib.rs');
  await f.go();
  await f.set('evicted');
  await f.go();
  assert.equal(await f.calls(), 'fetch\ntest\ntest\nfetch\ntest\n');
  await f.set('unavailable');
  await assert.rejects(f.go(), { code: 'cargo_fetch_failed' });
  assert.equal(await f.calls(), 'fetch\ntest\ntest\nfetch\ntest\ntest\nfetch\ntest\n');
});
test('ordinary compiler errors stay submission failures without a fetch retry', async t => {
  const f = await fakeRun(t);
  await f.go();
  await f.set('compiler');
  await assert.rejects(f.go(), { code: 'check_failed' });
  assert.equal(await f.calls(), 'fetch\ntest\ntest\n');
});
test('an outdated locked submission is repairable even when fetch was retried', async t => {
  const f = await fakeRun(t);
  await f.go();
  await f.set('evicted');
  await f.set('stale-lock');
  await assert.rejects(f.go(), error => error.code === 'check_failed' && /Cargo.lock/.test(error.message));
  assert.equal(await f.calls(), 'fetch\ntest\ntest\nfetch\n');
});
test('missing committed Cargo.lock is a submission defect even with an ignored local copy', async t => {
  const f = await fakeRun(t, false);
  for (const ignored of [false, true]) {
    if (ignored) await put(f.cwd, 'Cargo.lock', 'version=4');
    await assert.rejects(f.go(), error => error.code === 'check_failed' && /Cargo.lock/.test(error.message));
  }
});
test('a documentation-only change gets a real metadata receipt with no crate compilation', async t => {
  const f = await fakeRun(t);
  await f.commit('README.md');
  const checks = await f.go();
  assert.deepEqual(checks.plan.reasons, ['cargo-no-affected-crates']);
  assert.deepEqual(checks.plan.affectedCrates, []);
  assert.equal(checks.results.length, 1);
  assert.equal(checks.results[0].kind, 'metadata');
  assert.equal(checks.results[0].args[0], 'metadata');
  assert.equal(checks.results[0].exitCode, 0);
});

test('task-fast verifies an unrelated Git symlink without following it or widening the plan', async t => {
  const f = await fakeRun(t);
  await f.commit('crates/a/src/lib.rs');
  const oid = await git(f.cwd, ['hash-object', '-w', 'README.md']);
  await git(f.cwd, ['update-index', '--add', '--cacheinfo', '120000,' + oid + ',notes.md']);
  await git(f.cwd, [
    '-c',
    'user.name=test',
    '-c',
    'user.email=t@example.org',
    '-c',
    'commit.gpgSign=false',
    'commit',
    '-qm',
    'link',
  ]);
  // Use Git's link representation on this checkout (including core.symlinks=false on Windows).
  await git(f.cwd, ['checkout-index', '--force', '--', 'notes.md']);
  const checks = await f.go();
  assert.deepEqual(checks.plan.affectedCrates, ['a']);
  assert.equal(checks.plan.fallback, false);
  assert.deepEqual(checks.results[0].args, ['test', '-p', 'a@1.0.0', '--locked']);
  await git(f.cwd, ['update-index', '--assume-unchanged', 'notes.md']);
  await unlink(path.join(f.cwd, 'notes.md'));
  await put(f.cwd, 'notes.md', 'hello');
  await git(f.cwd, ['config', 'core.symlinks', 'true']);
  await assert.rejects(f.go(), { code: 'dirty_worktree' });
  await git(f.cwd, ['config', 'core.symlinks', 'false']);
  await put(f.cwd, 'notes.md', 'different');
  await assert.rejects(f.go(), { code: 'dirty_worktree' });
});

test('a warm marker cannot hide lock drift in a submitted manifest', async t => {
  const f = await fakeRun(t);
  await f.go();
  await f.set('locked-test');
  await assert.rejects(
    f.go(),
    error => error.code === 'check_failed' && /закоммитьте.*Cargo.lock|Cargo.lock.*закоммитьте/.test(error.message),
  );
  assert.equal(await f.calls(), 'fetch\ntest\ntest\n');
});

test('concurrent stale readers coalesce refresh and a failed refresh clears readiness', async t => {
  const { base: home, project: cwd } = await fixture(t, { 'Cargo.lock': 'version=4' });
  let calls = 0,
    fail = false;
  const runCommand = async (_cmd, args) => {
    if (args[0] !== 'fetch') return { code: 0, stdout: 'cargo 1.85.0' };
    calls++;
    return fail ? { code: 101, stderr: 'network unreachable' } : { code: 0 };
  };
  const warm = () =>
    warmCargoDependencies({
      home,
      cwd,
      command: 'fake',
      env: { CARGO_HOME: path.join(home, 'cargo') },
      timeoutMs: 1000,
      runCommand,
    });
  const one = await warm(),
    two = await warm();
  await Promise.all([one(), two()]);
  assert.equal(calls, 2);
  fail = true;
  await assert.rejects(one(), { code: 'cargo_fetch_failed' });
  fail = false;
  await warm();
  assert.equal(calls, 4);
});

test('a configured toolchain override is used for both the version and the locked fetch', async t => {
  const { base: home, project: cwd } = await fixture(t, { 'Cargo.lock': 'version=4' });
  const seen = [];
  const options = {
    home,
    cwd,
    env: { CARGO_HOME: path.join(home, 'cargo') },
    timeoutMs: 1000,
    command: 'cargo',
    runCommand: async (_cmd, args) => {
      seen.push(args);
      return { code: 0, stdout: 'cargo ' + args[0] };
    },
  };
  for (const toolchain of ['+stable', '+nightly', '+stable']) await warmCargoDependencies({ ...options, toolchain });
  assert.deepEqual(seen, [
    ['+stable', '--version'],
    ['+stable', 'fetch', '--locked'],
    ['+nightly', '--version'],
    ['+nightly', 'fetch', '--locked'],
    ['+stable', '--version'],
  ]);
});

test('task-fast warms each configured Cargo toolchain before offline steps', async t => {
  const proxy = [
    "const fs=require('node:fs'),path=require('node:path');",
    'const toolchain=path.basename(process.argv[1]),action=process.argv[2];',
    "fs.appendFileSync(path.join(process.env.CARGO_TARGET_DIR,'calls'),toolchain+' '+action+'\\n');",
    "if(action==='--version')console.log('cargo '+toolchain);",
  ].join('\n');
  const f = await fakeRun(t, true, { '+stable': proxy, '+nightly': proxy }, [
    ['+stable', 'test'],
    ['+nightly', 'test'],
  ]);
  await f.go();
  assert.deepEqual((await f.calls()).trim().split('\n'), [
    '+stable --version',
    '+stable fetch',
    '+nightly --version',
    '+nightly fetch',
    '+stable test',
    '+nightly test',
  ]);
});

for (const reason of [
  'failed to parse manifest at crates/a/Cargo.toml',
  'failed to load manifest for workspace member a',
  'failed to parse lock file at Cargo.lock',
  // Verbatim Cargo 1.96 output for a broken root Cargo.toml: no "failed to parse" phrase at all.
  'unclosed array, expected `]`\n --> Cargo.toml:6:8\n  |\n6 | foo = [\n  |        ^',
]) {
  test('cold fetch reports submission defect: ' + reason, async t => {
    const { base: home, project: cwd } = await fixture(t, { 'Cargo.lock': 'version=4' });
    const runCommand = async (_cmd, args) =>
      args[0] === 'fetch' ? { code: 101, stderr: 'error: ' + reason } : { code: 0, stdout: 'cargo 1.96' };
    await assert.rejects(
      warmCargoDependencies({ home, cwd, command: 'fake', env: {}, timeoutMs: 1000, runCommand }),
      error => error.code === 'check_failed' && error.message.includes(reason),
    );
  });
}

test('an unowned asset at the submitted head runs a locked workspace test', async t => {
  const f = await fakeRun(t, true, { 'assets/level.json': '{}' });
  await f.commit('assets/level.json');
  const checks = await f.go();
  assert.deepEqual(checks.plan.reasons, ['cargo-unowned-input']);
  assert.equal(checks.plan.fallback, true);
  assert.deepEqual(
    checks.results.map(step => step.args),
    [['test', '--workspace', '--locked']],
  );
});
