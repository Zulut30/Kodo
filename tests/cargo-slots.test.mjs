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
