import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { chmod, writeFile } from 'node:fs/promises';
import { fixture } from './fixtures/quality/helpers.mjs';
import { withCargoSlot } from '../runtime/cargo-slots.mjs';

test('Cargo waits for the only target slot and reuses it after release', async t => {
  const { base: home } = await fixture(t);
  const options = { home, projectId: 'game' };
  let active = 0;
  const entered = Promise.withResolvers(),
    release = Promise.withResolvers();
  const first = withCargoSlot(options, async env => {
    active++;
    entered.resolve();
    await release.promise;
    active--;
    return env.CARGO_TARGET_DIR;
  });
  await entered.promise;
  try {
    const blocked = withCargoSlot({ ...options, signal: AbortSignal.timeout(250) }, () =>
      assert.fail('occupied slot granted'),
    );
    await assert.rejects(blocked, e => ['AbortError', 'TimeoutError'].includes(e.name));
  } finally {
    release.resolve();
  }
  const next = await withCargoSlot(options, env => {
    assert.equal(active, 0);
    return env.CARGO_TARGET_DIR;
  });
  assert.equal(await first, next);
});

test('two Cargo builds get distinct slots, including sccache only on request', async t => {
  const { base: home } = await fixture(t);
  const wrapper = path.join(home, process.platform === 'win32' ? 'sccache.exe' : 'sccache');
  await writeFile(wrapper, '');
  await chmod(wrapper, 0o700);
  const options = { home, projectId: 'game', maxHeavyBuilds: 2, env: { PATH: home, RUSTC_WRAPPER: 'inherited' } };
  const entered = Promise.withResolvers(),
    release = Promise.withResolvers();
  const first = withCargoSlot(options, async env => {
    entered.resolve(env);
    await release.promise;
  });
  const original = await entered.promise;
  try {
    assert.equal(original.RUSTC_WRAPPER, undefined);
    await assert.rejects(
      withCargoSlot({ ...options, sccache: 'auto' }, env => {
        assert.equal(env.CARGO_TARGET_DIR, path.join(home, 'cargo-target', 'game', 'slot-2'));
        assert.notEqual(original.CARGO_TARGET_DIR, env.CARGO_TARGET_DIR);
        assert.equal(env.RUSTC_WRAPPER, wrapper);
        throw new Error('build failed');
      }),
      /build failed/,
    );
    assert.equal(
      await withCargoSlot({ ...options, sccache: true, env: { PATH: '' } }, env => env.RUSTC_WRAPPER),
      undefined,
    );
  } finally {
    release.resolve();
    await first;
  }
});

test('Cargo slot clears every inherited wrapper and target override and accepts a quoted Windows PATH', async t => {
  const { base: home } = await fixture(t);
  const wrapper = path.join(home, process.platform === 'win32' ? 'sccache.exe' : 'sccache');
  await writeFile(wrapper, '');
  await chmod(wrapper, 0o700);
  const keys = [
    'RUSTC_WORKSPACE_WRAPPER',
    'CARGO_BUILD_RUSTC_WRAPPER',
    'CARGO_BUILD_RUSTC_WORKSPACE_WRAPPER',
    'CARGO_BUILD_TARGET_DIR',
  ];
  const env = Object.fromEntries(keys.map(k => [k, 'outside']));
  env.PATH = process.platform === 'win32' ? '"' + home + '"' : home;
  await withCargoSlot({ home, projectId: 'test', sccache: true, env }, build => {
    assert.deepEqual(
      keys.filter(k => k in build),
      [],
    );
    assert.equal(build.RUSTC_WRAPPER, wrapper);
  });
});
test('Cargo slot treats SQLITE_BUSY during open as contention', async () => {
  const { tryCargoLock } = await import('../runtime/cargo-slots.mjs');
  assert.equal(
    tryCargoLock('unused', () => {
      throw Object.assign(new Error('busy'), { errcode: 5 });
    }),
    null,
  );
});
test('separate Node processes cannot share a slot and a killed holder releases it', { timeout: 30000 }, async t => {
  const { spawn } = await import('node:child_process');
  const { once } = await import('node:events');
  const { base: home } = await fixture(t);
  const module = new URL('../runtime/cargo-slots.mjs', import.meta.url).href;
  const script = `
    import {withCargoSlot} from ${JSON.stringify(module)};
    const options = {home: ${JSON.stringify(home)}, projectId: 'test'};
    const mode = process.argv[1];
    if (mode === 'wait') {
      try {
        await withCargoSlot({...options, signal: AbortSignal.timeout(300)}, () => process.send('overlap'));
      } catch (error) {
        if (!['TimeoutError', 'AbortError'].includes(error.name)) throw error;
        process.send('busy');
      }
    }
    await withCargoSlot(options, async env => {
      process.send(env.CARGO_TARGET_DIR);
      if (mode === 'hold') await new Promise(() => setInterval(() => {}, 1000));
    });
    process.disconnect();
  `;
  const child = mode =>
    spawn(process.execPath, ['--input-type=module', '-e', script, mode], {
      stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
      windowsHide: true,
    });
  const holder = child('hold');
  let waiter;
  try {
    const [target] = await once(holder, 'message');
    waiter = child('wait');
    assert.equal((await once(waiter, 'message'))[0], 'busy');
    const acquired = once(waiter, 'message'),
      closed = once(waiter, 'exit');
    holder.kill('SIGKILL');
    assert.equal((await acquired)[0], target);
    assert.equal((await closed)[0], 0);
  } finally {
    holder.kill();
    waiter?.kill();
  }
});

test('A slot built from another checkout drops only the fingerprints of path packages', async t => {
  const { mkdir: makeDir, readdir: list } = await import('node:fs/promises');
  const { base: home } = await fixture(t);
  const target = path.join(home, 'cargo-target', 'game', 'slot-1');
  const unit = async (dir, file, local) => {
    await makeDir(path.join(target, dir), { recursive: true });
    await writeFile(path.join(target, dir, file), JSON.stringify({ local }));
  };
  const seed = async () => {
    await unit('debug/.fingerprint/voxa-mesh-0123456789abcdef', 'lib-voxa_mesh.json', [
      { CheckDepInfo: { dep_info: 'lib-voxa_mesh' } },
    ]);
    // The build-script run of the same path package fingerprints RerunIfChanged, not dep-info.
    await unit('debug/.fingerprint/voxa-mesh-fedcba9876543210', 'run-build-script-build-script-build.json', [
      { RerunIfChanged: { output: 'x', paths: ['build.rs'] } },
    ]);
    await unit('debug/.fingerprint/serde-1111222233334444', 'lib-serde.json', [{ Precalculated: '1.0.0' }]);
    await unit('x86_64-pc-windows-msvc/release/.fingerprint/voxa-io-aaaabbbbccccdddd', 'lib-voxa_io.json', [
      { CheckDepInfo: {} },
    ]);
  };
  const units = async () =>
    [
      ...(await list(path.join(target, 'debug/.fingerprint'))),
      ...(await list(path.join(target, 'x86_64-pc-windows-msvc/release/.fingerprint'))),
    ].sort();
  const build = checkout => withCargoSlot({ home, projectId: 'game', checkout }, env => env.CARGO_TARGET_DIR);
  await seed();
  assert.equal(await build(path.join(home, 'a')), target);
  assert.deepEqual(await units(), ['serde-1111222233334444'], 'a slot without a recorded checkout is cleaned');
  await seed();
  await build(path.join(home, 'a'));
  assert.equal((await units()).length, 4, 'the same checkout keeps its incremental state');
  await build(path.join(home, 'b'));
  assert.deepEqual(await units(), ['serde-1111222233334444'], 'another checkout rebuilds the path packages');
  await seed();
  await build(undefined);
  assert.equal((await units()).length, 4, 'a build without a checkout leaves the slot alone');
});

test('Two checkouts of one workspace never share a stale library through the slot', { timeout: 300000 }, async t => {
  const { execFileSync, spawnSync } = await import('node:child_process');
  const { mkdir: makeDir, utimes } = await import('node:fs/promises');
  if (spawnSync('cargo', ['--version'], { windowsHide: true }).status !== 0) return t.skip('cargo is not installed');
  const { base: home } = await fixture(t);
  const checkout = async (name, lib, testBody) => {
    const root = path.join(home, name);
    await makeDir(path.join(root, 'crates', 'demo', 'src'), { recursive: true });
    await makeDir(path.join(root, 'crates', 'demo', 'tests'), { recursive: true });
    await writeFile(path.join(root, 'Cargo.toml'), '[workspace]\nresolver = "2"\nmembers = ["crates/*"]\n');
    await writeFile(
      path.join(root, 'crates', 'demo', 'Cargo.toml'),
      '[package]\nname = "demo"\nversion = "0.1.0"\nedition = "2021"\n',
    );
    await writeFile(path.join(root, 'crates', 'demo', 'src', 'lib.rs'), lib);
    await writeFile(path.join(root, 'crates', 'demo', 'tests', 'api.rs'), testBody);
    return root;
  };
  const older = await checkout('a', 'pub fn a() -> u32 { 1 }\n', '#[test]\nfn a() { assert_eq!(demo::a(), 1); }\n');
  const newer = await checkout(
    'b',
    'pub fn a() -> u32 { 1 }\npub fn b() -> u32 { 2 }\n',
    '#[test]\nfn b() { assert_eq!(demo::b(), 2); }\n',
  );
  // The second task wrote its sources before the first one's library was built into the slot.
  const past = new Date(Date.now() - 3600_000);
  for (const file of ['Cargo.toml', 'crates/demo/Cargo.toml', 'crates/demo/src/lib.rs', 'crates/demo/tests/api.rs'])
    await utimes(path.join(newer, file), past, past);
  const cargoTest = (cwd, slotCheckout) =>
    withCargoSlot({ home, projectId: 'game', checkout: slotCheckout, env: process.env }, env => {
      const result = spawnSync('cargo', ['test', '--offline'], { cwd, env, encoding: 'utf8', windowsHide: true });
      return { status: result.status, output: result.stdout + result.stderr };
    });
  execFileSync('cargo', ['generate-lockfile', '--offline'], { cwd: older, windowsHide: true });
  execFileSync('cargo', ['generate-lockfile', '--offline'], { cwd: newer, windowsHide: true });
  assert.equal((await cargoTest(older, older)).status, 0);
  const verified = await cargoTest(newer, newer);
  assert.equal(verified.status, 0, verified.output);
  assert.match(verified.output, /test b \.\.\. ok/);
});
