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
