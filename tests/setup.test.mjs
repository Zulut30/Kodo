import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  rm,
  readdir,
  unlink,
  access,
  lstat,
  realpath,
  chmod,
  symlink,
  rmdir,
} from 'node:fs/promises';
import { Engine } from '../runtime/engine.mjs';
import { Store } from '../runtime/store.mjs';
import { execute, resolveCommand } from '../runtime/command.mjs';
import { workerEnvironment } from '../runtime/security.mjs';

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'kodo-setup-test-'));
  const project = path.join(root, 'project'),
    store = new Store(path.join(root, 'state'));
  const tempRoot = await realpath(os.tmpdir()),
    existingCaches = new Set((await readdir(tempRoot)).filter(name => name.startsWith('kodo-npm-cache-'))),
    ownedCaches = new Set();
  t.after(async () => {
    store.close();
    assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith('kodo-setup-test-'));
    await rm(root, { recursive: true, force: true });
    // This fixture created a fresh, isolated Store.home. Only its new private
    // random caches may be removed; never delete a pre-existing/shared user cache.
    for (const cache of ownedCaches) {
      const info = await lstat(cache);
      assert.equal(path.dirname(cache), tempRoot);
      assert.match(path.basename(cache), /^kodo-npm-cache-[a-f0-9]{24}-[A-Za-z0-9]{6,}$/);
      assert.equal(existingCaches.has(path.basename(cache)), false);
      assert.ok(info.isDirectory() && !info.isSymbolicLink());
      if (process.platform !== 'win32') {
        assert.equal(info.uid, process.getuid());
        assert.equal(info.mode & 0o077, 0);
      }
      await rm(cache, { recursive: true, force: true });
    }
  });
  await mkdir(project);
  const run = store.createRun({
    task: 'Verify local dependency setup',
    cwd: project,
    config: { concurrency: 2 },
    state: 'planning',
  });
  const engine = new Engine({ store });
  const executionEnvironment = engine.executionEnvironment.bind(engine);
  engine.executionEnvironment = async (...args) => {
    const environment = await executionEnvironment(...args),
      cache = environment.NPM_CONFIG_CACHE;
    const pointer = JSON.parse(await readFile(path.join(store.home, 'npm-cache.json'), 'utf8'));
    assert.equal(pointer.cache, cache);
    assert.equal(path.dirname(cache), tempRoot);
    assert.equal(existingCaches.has(path.basename(cache)), false);
    const info = await lstat(cache);
    assert.ok(info.isDirectory() && !info.isSymbolicLink());
    if (process.platform !== 'win32') {
      assert.equal(info.uid, process.getuid());
      assert.equal(info.mode & 0o077, 0);
    }
    ownedCaches.add(cache);
    return environment;
  };
  const manualEnv = {
    ...workerEnvironment(),
    NPM_CONFIG_CACHE: path.join(root, 'manual-cache'),
    NPM_CONFIG_OFFLINE: 'true',
  };
  async function useVersion(version) {
    const source = path.join(root, `dependency-${version}`);
    await mkdir(source);
    await writeFile(
      path.join(source, 'package.json'),
      JSON.stringify({ name: 'kodo-fixture-dependency', version, main: 'index.cjs' }),
    );
    await writeFile(path.join(source, 'index.cjs'), `module.exports = '${version}';\n`);
    const packed = await execute(
      'npm',
      ['pack', '--ignore-scripts', '--offline', '--json', '--pack-destination', root],
      { cwd: source, env: manualEnv },
    );
    const filename = JSON.parse(packed.stdout)[0].filename;
    await writeFile(
      path.join(project, 'package.json'),
      JSON.stringify({
        name: 'kodo-setup-fixture',
        version: '1.0.0',
        private: true,
        dependencies: { 'kodo-fixture-dependency': `file:../${filename}` },
      }),
    );
    await execute(
      'npm',
      ['install', '--package-lock-only', '--ignore-scripts', '--offline', '--no-audit', '--no-fund'],
      { cwd: project, env: manualEnv },
    );
  }
  return { root, project, store, run, engine, useVersion, tempRoot };
}
async function offline(action) {
  const before = process.env.NPM_CONFIG_OFFLINE;
  process.env.NPM_CONFIG_OFFLINE = 'true';
  try {
    return await action();
  } finally {
    if (before === undefined) delete process.env.NPM_CONFIG_OFFLINE;
    else process.env.NPM_CONFIG_OFFLINE = before;
  }
}
async function installed(project) {
  return JSON.parse(await readFile(path.join(project, 'node_modules/kodo-fixture-dependency/package.json'), 'utf8'))
    .version;
}

test('Setup installs missing dependencies despite legacy Ajv and refreshes changed locks while reusing unchanged installs after reopen', async t =>
  offline(async () => {
    const fx = await fixture(t);
    await fx.useVersion('1.0.0');
    await mkdir(path.join(fx.project, 'node_modules/ajv'), { recursive: true });
    await fx.engine.setup(fx.project, fx.run);
    assert.equal(await installed(fx.project), '1.0.0');
    const setupDirectory = path.join(fx.store.home, 'setup');
    const receipts = await readdir(setupDirectory);
    assert.equal(receipts.length, 1);
    const firstReceipt = JSON.parse(await readFile(path.join(setupDirectory, receipts[0]), 'utf8'));
    assert.equal(firstReceipt.cwd, path.resolve(fx.project));
    assert.equal(firstReceipt.runtime.version, process.version);
    assert.equal(firstReceipt.runtime.platform, process.platform);
    assert.equal(firstReceipt.runtime.arch, process.arch);
    assert.equal(path.relative(fx.project, setupDirectory).startsWith('..'), true);
    await fx.useVersion('2.0.0');
    await fx.engine.setup(fx.project, fx.run);
    assert.equal(await installed(fx.project), '2.0.0');
    const sentinel = path.join(fx.project, 'node_modules/unchanged-install-sentinel');
    await writeFile(sentinel, 'keep across cache hit\n');
    const reopened = new Engine({ store: fx.store });
    await reopened.setup(fx.project, fx.run);
    assert.equal(await readFile(sentinel, 'utf8'), 'keep across cache hit\n');
    assert.equal(fx.store.events(fx.run.id).filter(event => event.type === 'setup').length, 2);
    const currentReceipt = JSON.parse(await readFile(path.join(setupDirectory, receipts[0]), 'utf8'));
    assert.notEqual(currentReceipt.fingerprint, firstReceipt.fingerprint);
  }));

test('Setup reinstalls when the installed dependency index is missing or empty despite a matching receipt', async t =>
  offline(async () => {
    const fx = await fixture(t);
    await fx.useVersion('1.0.0');
    await fx.engine.setup(fx.project, fx.run);
    const index = path.join(fx.project, 'node_modules/.package-lock.json'),
      sentinel = path.join(fx.project, 'node_modules/reinstall-sentinel');
    await writeFile(sentinel, 'remove on reinstall');
    await unlink(index);
    await fx.engine.setup(fx.project, fx.run);
    await assert.rejects(access(sentinel), { code: 'ENOENT' });
    assert.equal(await installed(fx.project), '1.0.0');
    await writeFile(sentinel, 'remove after empty index');
    await writeFile(index, '');
    await fx.engine.setup(fx.project, fx.run);
    await assert.rejects(access(sentinel), { code: 'ENOENT' });
    assert.equal(await installed(fx.project), '1.0.0');
    assert.equal(fx.store.events(fx.run.id).filter(event => event.type === 'setup').length, 3);
  }));

test('Worker sessions share one writable per-user temp npm cache across runs and worktrees without coordinator secrets', async t => {
  const fx = await fixture(t),
    seen = [],
    sentinels = new Set();
  t.after(async () => {
    for (const sentinel of sentinels)
      await unlink(sentinel).catch(error => {
        if (error.code !== 'ENOENT') throw error;
      });
  });
  const polluted = {
    GEMINI_API_KEY: 'fixture-coordinator-private',
    NPM_TOKEN: 'fixture-npm-private',
    DATABASE_URL: 'fixture-database-private',
  };
  const original = Object.fromEntries(Object.keys(polluted).map(name => [name, process.env[name]]));
  Object.assign(process.env, polluted);
  fx.engine.provider = {
    runSession: async request => {
      seen.push(request.env);
      const cache = request.env.NPM_CONFIG_CACHE;
      assert.equal(typeof cache, 'string');
      assert.equal(path.dirname(path.resolve(cache)), fx.tempRoot);
      assert.match(path.basename(cache), /^kodo-npm-cache-[a-f0-9]{24}-[A-Za-z0-9]{6,}$/);
      const filename = `canary-${path.basename(fx.root)}-${seen.length}`,
        sentinel = path.join(cache, filename);
      sentinels.add(sentinel);
      await execute(
        process.execPath,
        [
          '-e',
          "require('node:fs').writeFileSync(require('node:path').join(process.env.NPM_CONFIG_CACHE, process.argv[1]), 'native cache is writable\\n')",
          filename,
        ],
        { cwd: request.cwd, env: request.env },
      );
      assert.equal(await readFile(sentinel, 'utf8'), 'native cache is writable\n');
      const pathName = Object.keys(request.env).find(name => name.toLowerCase() === 'path');
      assert.equal(request.env[pathName].split(path.delimiter)[0], path.dirname(process.execPath));
      for (const name of Object.keys(polluted)) assert.equal(request.env[name], undefined);
      const npm = resolveCommand('npm', []);
      if (npm.command === process.execPath) assert.equal(request.env.npm_execpath, npm.args[0]);
      return { sessionId: 'fixture-session', output: { ok: true } };
    },
  };
  try {
    await fx.engine.session(fx.run, { client: 'codex', cwd: fx.project, prompt: 'fixture request', readOnly: true });
    await fx.engine.session(fx.run, { client: 'codex', cwd: fx.project, prompt: 'fixture repeat', readOnly: true });
    const other = path.join(fx.root, 'other-task');
    await mkdir(other);
    await fx.engine.session(fx.run, { client: 'codex', cwd: other, prompt: 'fixture other task', readOnly: true });
    const otherRun = fx.store.createRun({
      task: 'Separate run shares only the user npm cache',
      cwd: other,
      config: { concurrency: 2 },
      state: 'planning',
    });
    assert.notEqual(otherRun.id, fx.run.id);
    await fx.engine.session(otherRun, { client: 'codex', cwd: other, prompt: 'fixture second run', readOnly: true });
  } finally {
    for (const [name, value] of Object.entries(original)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
  assert.equal(seen.length, 4);
  assert.equal(new Set(seen.map(environment => environment.NPM_CONFIG_CACHE)).size, 1);
});

test('Concurrent cache creation reuses one protected pointer across coordinator connections and runs', async t => {
  const fx = await fixture(t),
    otherStore = new Store(fx.store.home);
  try {
    const otherRun = fx.store.createRun({
      task: 'Concurrent independent run',
      cwd: fx.project,
      config: { concurrency: 2 },
    });
    const otherEngine = new Engine({ store: otherStore });
    const environments = await Promise.all([
      fx.engine.executionEnvironment(fx.run, fx.project),
      otherEngine.executionEnvironment(otherRun, fx.project),
      fx.engine.executionEnvironment(otherRun, fx.root),
    ]);
    assert.equal(new Set(environments.map(environment => environment.NPM_CONFIG_CACHE)).size, 1);
    const pointer = path.join(fx.store.home, 'npm-cache.json'),
      metadata = JSON.parse(await readFile(pointer, 'utf8'));
    assert.equal(metadata.cache, environments[0].NPM_CONFIG_CACHE);
    if (process.platform !== 'win32') assert.equal((await lstat(pointer)).mode & 0o777, 0o600);
  } finally {
    otherStore.close();
  }
});

test('A forged cache pointer to an unrelated directory is replaced without changing that directory', async t => {
  const fx = await fixture(t),
    original = await fx.engine.executionEnvironment(fx.run, fx.project);
  const pointerFile = path.join(fx.store.home, 'npm-cache.json'),
    pointer = JSON.parse(await readFile(pointerFile, 'utf8'));
  const sentinel = path.join(fx.project, 'unrelated-user-file');
  await writeFile(sentinel, 'preserve unrelated directory\n');
  await writeFile(pointerFile, JSON.stringify({ ...pointer, cache: fx.project }), { mode: 0o600 });
  const fresh = await fx.engine.executionEnvironment(fx.run, fx.project);
  assert.notEqual(fresh.NPM_CONFIG_CACHE, original.NPM_CONFIG_CACHE);
  assert.notEqual(fresh.NPM_CONFIG_CACHE, fx.project);
  assert.equal(await readFile(sentinel, 'utf8'), 'preserve unrelated directory\n');
});

test(
  'POSIX cache pointers reject world writable directories and symbolic links without deleting their targets',
  { skip: process.platform === 'win32' },
  async t => {
    for (const kind of ['world-writable', 'symlink'])
      await t.test(kind, async t => {
        const fx = await fixture(t),
          first = await fx.engine.executionEnvironment(fx.run, fx.project);
        const pointerFile = path.join(fx.store.home, 'npm-cache.json'),
          pointer = JSON.parse(await readFile(pointerFile, 'utf8'));
        const prefix = path.basename(first.NPM_CONFIG_CACHE).slice(0, -6),
          unsafe = await mkdtemp(path.join(fx.tempRoot, prefix));
        let sentinel;
        if (kind === 'symlink') {
          await rmdir(unsafe);
          await symlink(fx.project, unsafe, 'dir');
          sentinel = path.join(fx.project, 'symlink-target-sentinel');
          t.after(() => unlink(unsafe));
        } else {
          await chmod(unsafe, 0o777);
          sentinel = path.join(unsafe, 'unsafe-directory-sentinel');
          t.after(async () => {
            await unlink(sentinel);
            await rmdir(unsafe);
          });
        }
        await writeFile(sentinel, 'unsafe target must remain untouched\n');
        await writeFile(pointerFile, JSON.stringify({ ...pointer, cache: unsafe }), { mode: 0o600 });
        const fresh = await fx.engine.executionEnvironment(fx.run, fx.project);
        assert.notEqual(fresh.NPM_CONFIG_CACHE, unsafe);
        assert.notEqual(fresh.NPM_CONFIG_CACHE, first.NPM_CONFIG_CACHE);
        assert.equal(await readFile(sentinel, 'utf8'), 'unsafe target must remain untouched\n');
        assert.equal((await lstat(unsafe)).isSymbolicLink(), kind === 'symlink');
        if (kind === 'world-writable') assert.equal((await lstat(unsafe)).mode & 0o777, 0o777);
      });
  },
);
