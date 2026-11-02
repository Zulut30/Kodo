import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, mkdir, writeFile, readFile, rm, readdir, unlink, access } from 'node:fs/promises';
import { Engine } from '../runtime/engine.mjs';
import { Store } from '../runtime/store.mjs';
import { execute, resolveCommand } from '../runtime/command.mjs';
import { workerEnvironment } from '../runtime/security.mjs';

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'kodo-setup-test-'));
  const project = path.join(root, 'project'), store = new Store(path.join(root, 'state'));
  const caches = new Set();
  t.after(async () => {
    store.close();
    assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith('kodo-setup-test-'));
    await rm(root, { recursive: true, force: true });
    for (const cache of caches) {
      const resolved = path.resolve(cache), cacheRoot = path.join(os.tmpdir(), 'kodo-npm-cache');
      assert.ok(resolved.startsWith(cacheRoot + path.sep));
      await rm(resolved, { recursive: true, force: true });
    }
  });
  await mkdir(project);
  const run = store.createRun({ task: 'Verify local dependency setup', cwd: project, config: { concurrency: 2 }, state: 'planning' });
  const engine = new Engine({ store });
  const executionEnvironment = engine.executionEnvironment.bind(engine);
  engine.executionEnvironment = async (...args) => { const environment = await executionEnvironment(...args); caches.add(environment.NPM_CONFIG_CACHE); return environment; };
  const manualEnv = { ...workerEnvironment(), NPM_CONFIG_CACHE: path.join(root, 'manual-cache'), NPM_CONFIG_OFFLINE: 'true' };
  async function useVersion(version) {
    const source = path.join(root, `dependency-${version}`); await mkdir(source);
    await writeFile(path.join(source, 'package.json'), JSON.stringify({ name: 'kodo-fixture-dependency', version, main: 'index.cjs' }));
    await writeFile(path.join(source, 'index.cjs'), `module.exports = '${version}';\n`);
    const packed = await execute('npm', ['pack', '--ignore-scripts', '--offline', '--json', '--pack-destination', root], { cwd: source, env: manualEnv });
    const filename = JSON.parse(packed.stdout)[0].filename;
    await writeFile(path.join(project, 'package.json'), JSON.stringify({ name: 'kodo-setup-fixture', version: '1.0.0', private: true, dependencies: { 'kodo-fixture-dependency': `file:../${filename}` } }));
    await execute('npm', ['install', '--package-lock-only', '--ignore-scripts', '--offline', '--no-audit', '--no-fund'], { cwd: project, env: manualEnv });
  }
  return { root, project, store, run, engine, useVersion, caches };
}
async function offline(action) {
  const before = process.env.NPM_CONFIG_OFFLINE; process.env.NPM_CONFIG_OFFLINE = 'true';
  try { return await action(); }
  finally { if (before === undefined) delete process.env.NPM_CONFIG_OFFLINE; else process.env.NPM_CONFIG_OFFLINE = before; }
}
async function installed(project) { return JSON.parse(await readFile(path.join(project, 'node_modules/kodo-fixture-dependency/package.json'), 'utf8')).version; }

test('Setup installs missing dependencies despite legacy Ajv and refreshes changed locks while reusing unchanged installs after reopen', async t => offline(async () => {
  const fx = await fixture(t); await fx.useVersion('1.0.0');
  await mkdir(path.join(fx.project, 'node_modules/ajv'), { recursive: true });
  await fx.engine.setup(fx.project, fx.run);
  assert.equal(await installed(fx.project), '1.0.0');
  const setupDirectory = path.join(fx.store.home, 'setup');
  const receipts = await readdir(setupDirectory); assert.equal(receipts.length, 1);
  const firstReceipt = JSON.parse(await readFile(path.join(setupDirectory, receipts[0]), 'utf8'));
  assert.equal(firstReceipt.cwd, path.resolve(fx.project));
  assert.equal(firstReceipt.runtime.version, process.version);
  assert.equal(firstReceipt.runtime.platform, process.platform);
  assert.equal(firstReceipt.runtime.arch, process.arch);
  assert.equal(path.relative(fx.project, setupDirectory).startsWith('..'), true);
  await fx.useVersion('2.0.0'); await fx.engine.setup(fx.project, fx.run);
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

test('Setup reinstalls when the installed dependency index is missing or empty despite a matching receipt', async t => offline(async () => {
  const fx = await fixture(t); await fx.useVersion('1.0.0'); await fx.engine.setup(fx.project, fx.run);
  const index = path.join(fx.project, 'node_modules/.package-lock.json'), sentinel = path.join(fx.project, 'node_modules/reinstall-sentinel');
  await writeFile(sentinel, 'remove on reinstall'); await unlink(index);
  await fx.engine.setup(fx.project, fx.run);
  await assert.rejects(access(sentinel), { code: 'ENOENT' }); assert.equal(await installed(fx.project), '1.0.0');
  await writeFile(sentinel, 'remove after empty index'); await writeFile(index, '');
  await fx.engine.setup(fx.project, fx.run);
  await assert.rejects(access(sentinel), { code: 'ENOENT' }); assert.equal(await installed(fx.project), '1.0.0');
  assert.equal(fx.store.events(fx.run.id).filter(event => event.type === 'setup').length, 3);
}));

test('Worker sessions receive a writable task-local temp npm cache and native Node discovery without coordinator secrets', async t => {
  const fx = await fixture(t), seen = [];
  const polluted = { GEMINI_API_KEY: 'fixture-coordinator-private', NPM_TOKEN: 'fixture-npm-private', DATABASE_URL: 'fixture-database-private' };
  const original = Object.fromEntries(Object.keys(polluted).map(name => [name, process.env[name]])); Object.assign(process.env, polluted);
  fx.engine.provider = { runSession: async request => {
    seen.push(request.env); const cache = request.env.NPM_CONFIG_CACHE;
    assert.equal(typeof cache, 'string'); fx.caches.add(cache);
    assert.ok(path.resolve(cache).startsWith(path.join(os.tmpdir(), 'kodo-npm-cache') + path.sep));
    await execute(process.execPath, ['-e', "require('node:fs').writeFileSync(require('node:path').join(process.env.NPM_CONFIG_CACHE, 'worker-write-canary'), 'native cache is writable\\n')"], { cwd: request.cwd, env: request.env });
    assert.equal(await readFile(path.join(cache, 'worker-write-canary'), 'utf8'), 'native cache is writable\n');
    const pathName = Object.keys(request.env).find(name => name.toLowerCase() === 'path');
    assert.equal(request.env[pathName].split(path.delimiter)[0], path.dirname(process.execPath));
    for (const name of Object.keys(polluted)) assert.equal(request.env[name], undefined);
    const npm = resolveCommand('npm', []);
    if (npm.command === process.execPath) assert.equal(request.env.npm_execpath, npm.args[0]);
    return { sessionId: 'fixture-session', output: { ok: true } };
  } };
  try {
    await fx.engine.session(fx.run, { client: 'codex', cwd: fx.project, prompt: 'fixture request', readOnly: true });
    await fx.engine.session(fx.run, { client: 'codex', cwd: fx.project, prompt: 'fixture repeat', readOnly: true });
    const other = path.join(fx.root, 'other-task'); await mkdir(other);
    await fx.engine.session(fx.run, { client: 'codex', cwd: other, prompt: 'fixture other task', readOnly: true });
  } finally { for (const [name, value] of Object.entries(original)) { if (value === undefined) delete process.env[name]; else process.env[name] = value; } }
  assert.equal(seen[0].NPM_CONFIG_CACHE, seen[1].NPM_CONFIG_CACHE);
  assert.notEqual(seen[0].NPM_CONFIG_CACHE, seen[2].NPM_CONFIG_CACHE);
});
