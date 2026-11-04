import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import os from 'node:os';
import path from 'node:path';
import { Engine } from '../runtime/engine.mjs';
import { Store } from '../runtime/store.mjs';
import { readConfig } from '../runtime/config.mjs';
import * as delivery from '../runtime/delivery.mjs';

function git(cwd, ...args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

async function fixture(t, { secrets = {}, services } = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'kodo-engine-contract-'));
  const project = path.join(directory, 'project'), home = path.join(directory, 'state');
  await mkdir(project);
  await writeFile(path.join(project, 'package.json'), JSON.stringify({ name: 'engine-fixture', version: '0.1.0' }));
  git(project, 'init', '-b', 'main');
  git(project, 'config', 'user.name', 'Engine Contract Test');
  git(project, 'config', 'user.email', 'engine-contract@example.invalid');
  git(project, 'add', '.'); git(project, 'commit', '-m', 'Fixture');
  // The store deliberately has no secret map: protection must come from Engine's
  // private delivery boundary, not a second redactor hiding the defect.
  const store = new Store(home);
  t.after(async () => {
    store.close();
    const resolved = path.resolve(directory);
    assert.equal(path.dirname(resolved), path.resolve(os.tmpdir()));
    assert.ok(path.basename(resolved).startsWith('kodo-engine-contract-'));
    await rm(resolved, { recursive: true, force: true });
  });
  const config = await readConfig(project);
  config.commands = { test: [{ command: process.execPath, args: ['-e', "console.log('check-complete')"] }], build: [], deploy: [], smoke: [] };
  const baseSha = git(project, 'rev-parse', 'HEAD');
  const run = store.createRun({ task: 'Engine contract fixture', project, cwd: project, config, client: 'codex', providers: 'current',
    branch: 'kodo/fixture', baseSha, headSha: baseSha, completed: { implementation: true }, nodes: {} });
  run.artifacts = path.join(home, 'runs', run.id);
  await mkdir(run.artifacts, { recursive: true }); store.updateRun(run.id, run);
  const engine = new Engine({ store, secrets, ...(services ? { delivery: services } : {}) });
  return { directory, project, store, engine, run };
}

function isolateDelivery(engine) {
  // Earlier stages are outside this contract. Keep Engine.run, delivery context,
  // SQLite events/errors, leases and the actual subprocess executor intact.
  for (const name of ['prepare', 'plan', 'recoverIntegrationEdits', 'synchronizeBase', 'verify']) engine[name] = async () => {};
  engine.policy = async () => '';
  engine.provider = { discoverProviders: async () => [{ client: 'codex', model: 'gpt-6.1-sol', available: true }] };
}

test('Engine.run protects outside-env secret prefixes through every real delivery entrypoint', async t => {
  for (const target of ['reconcile', 'prepare-version', 'deliver', 'retry-reconcile', 'retry-version', 'release']) await t.test(target, async subtest => {
    const secret = `fixture-only-${randomBytes(24).toString('hex')}`, prefix = secret.slice(0, 20), marker = 'bounded-diagnostic\n';
    assert.equal(Object.values(process.env).some(value => value?.includes(secret)), false);
    let runnerCalls = 0, versionCalls = 0, deliveryCalls = 0, fx;
    const runner = async (_command, _args, settings) => {
      runnerCalls++;
      // This is a real local process. No real service, key store or credentials.
      return delivery.execute(process.execPath, [path.join(fx.directory, 'output.mjs')], {
        ...settings, timeoutMs: 10000, maxOutputBytes: Buffer.byteLength(marker + prefix)
      });
    };
    const invoke = (name, options) => delivery[name]({ ...options, exec: runner });
    const services = {
      reconcileDelivery: options => target === 'reconcile' || target === 'retry-reconcile' && deliveryCalls
        ? invoke('reconcileDelivery', options) : null,
      prepareReleaseVersion: options => {
        versionCalls++;
        return target === 'prepare-version' || target === 'retry-version' && versionCalls === 2
          ? invoke('prepareReleaseVersion', options) : { changed: false };
      },
      deliver: options => {
        deliveryCalls++;
        if (target === 'deliver') return invoke('deliver', options);
        if (['retry-reconcile', 'retry-version'].includes(target) && deliveryCalls === 1) {
          if (target === 'retry-reconcile') options.run.delivery = { pr: { number: 1 } };
          throw Object.assign(new Error('Fixture target advanced'), { code: 'stale_base' });
        }
        return { mergeCommit: options.run.headSha };
      },
      releasePackage: options => invoke('releasePackage', options)
    };
    fx = await fixture(subtest, { secrets: { fixture: secret }, services });
    await writeFile(path.join(fx.directory, 'output.mjs'), `
      const secret = ${JSON.stringify(secret)};
      if (Object.values(process.env).some(value => value?.includes(secret))) process.exit(71);
      process.stdout.write(${JSON.stringify(marker)} + secret + 'x'.repeat(1024));
    `);
    isolateDelivery(fx.engine);
    fx.run.config.repository = 'fixture/engine';
    fx.run.config.delivery = { enabled: true, release: ['prepare-version', 'retry-version', 'release'].includes(target) };
    if (target === 'reconcile') fx.run.delivery = { pr: { number: 1 } };
    fx.store.updateRun(fx.run.id, fx.run);
    const result = await fx.engine.run(fx.run.id);
    assert.equal(runnerCalls, 1, 'must reach the actual delivery command boundary');
    assert.equal(result.state, 'blocked'); assert.equal(result.error.code, 'invalid_output');
    assert.ok(result.error.message.includes(marker.trim()));
    // Boolean diagnostics keep even the expected RED receipt free of fake keys.
    assert.equal(result.error.message.includes(prefix), false, 'partial key escaped into Engine error');
    const saved = fx.store.getRun(result.id), events = fx.store.events(result.id);
    assert.equal(JSON.stringify(saved).includes(prefix), false, 'partial key persisted in run state');
    assert.equal(JSON.stringify(events).includes(prefix), false, 'partial key persisted in events');
    const commandEvent = events.find(event => event.type === 'delivery.command_failed');
    assert.ok(commandEvent); assert.equal(commandEvent.data.outputTruncated, true);
    assert.ok(commandEvent.data.stdout.includes(marker.trim()));
    assert.ok(commandEvent.data.stdout.includes('[REDACTED]'));
    assert.equal(Object.hasOwn(saved, 'secrets'), false);
    assert.equal(Object.hasOwn(saved.config, 'secrets'), false);
  });
});

async function waitForFile(filename, { signal, timeoutMs = 10000 } = {}) {
  const start = performance.now();
  while (true) {
    try { return await readFile(filename, 'utf8'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (performance.now() - start >= timeoutMs) throw new Error('Fixture subprocess did not become ready');
    await delay(20, undefined, { signal });
  }
}

test('Engine.checks terminates real test and build subprocesses at the explicit deadline', async t => {
  for (const kind of ['test', 'build']) await t.test(kind, async subtest => {
    const fx = await fixture(subtest), ready = path.join(fx.directory, 'ready'), late = path.join(fx.directory, 'late');
    const script = path.join(fx.directory, 'deadline.mjs');
    await writeFile(script, `
      import { writeFileSync } from 'node:fs';
      writeFileSync(${JSON.stringify(ready)}, String(process.pid));
      setTimeout(() => { writeFileSync(${JSON.stringify(late)}, 'late success'); process.exit(0); }, 4500);
    `);
    fx.run.config.commands[kind] = [{ command: process.execPath, args: [script], timeoutMs: 2000 }];
    const controller = new AbortController(), watchdog = setTimeout(() => controller.abort(), 12000);
    try {
      // Observe readiness and outcome concurrently. A watchdog abort cannot count
      // as a deadline success; the unfixed process exits successfully after 4.5s.
      const checking = fx.engine.checks(fx.run, controller.signal).then(() => ({ code: 'late_success' }), error => error);
      const [pid, outcome] = await Promise.all([waitForFile(ready, { signal: controller.signal }), checking]);
      assert.equal(outcome.code, 'timeout', 'configured deadline must stop a real check before its late success');
      await assert.rejects(readFile(late), { code: 'ENOENT' });
      assert.throws(() => process.kill(Number(pid), 0), { code: 'ESRCH' });
      assert.equal(fx.store.getRun(fx.run.id).checks.complete, false);
    } finally { clearTimeout(watchdog); controller.abort(); }
  });
});

test('Engine.checks keeps omitted deadlines and accepts the largest bounded deadline', async t => {
  const fx = await fixture(t);
  fx.run.config.commands.build = [{ command: process.execPath, args: ['-e', "console.log('build-complete')"], timeoutMs: 2147483647 }];
  await fx.engine.checks(fx.run);
  assert.equal(fx.run.checks.complete, true);
  assert.equal(fx.run.checks.results.length, 2);
  assert.equal(fx.run.checks.results[0].output.trim(), 'check-complete');
  assert.equal(Object.hasOwn(fx.run.checks.results[0].command, 'timeoutMs'), false);
  assert.equal(fx.run.checks.results[1].output.trim(), 'build-complete');
});

test('Engine.checks preserves zero as an immediate deadline', async t => {
  const fx = await fixture(t), controller = new AbortController();
  fx.run.config.commands.test = [{ command: process.execPath, args: ['-e', 'setInterval(() => {}, 1000)'], timeoutMs: 0 }];
  const watchdog = setTimeout(() => controller.abort(), 4000);
  try { await assert.rejects(fx.engine.checks(fx.run, controller.signal), { code: 'timeout' }); }
  finally { clearTimeout(watchdog); controller.abort(); }
});

const invalidTimeouts = [-1, NaN, Infinity, 0.5, '2000', 2147483648, null];
const configurationError = error => error.code === 'configuration' && /commands\.(test|build|deploy|smoke)\[0\]\.timeoutMs/.test(error.message) && /2147483647/.test(error.message);

test('Config rejects malformed command deadlines with the exact command location', async t => {
  const fx = await fixture(t), filename = path.join(fx.project, 'kodo.config.json');
  for (const kind of ['test', 'build', 'deploy', 'smoke']) for (const timeoutMs of invalidTimeouts) {
    await writeFile(filename, JSON.stringify({ commands: { [kind]: [{ command: process.execPath, args: [], timeoutMs }] } }));
    await assert.rejects(readConfig(fx.project), configurationError);
  }
  // Non-finite numbers can also arrive from valid JSON numeric overflow.
  await writeFile(filename, '{"commands":{"test":[{"command":"node","args":[],"timeoutMs":1e400}]}}');
  await assert.rejects(readConfig(fx.project), configurationError);
});

test('Engine.checks rejects malformed legacy deadlines before setup or cached-check reuse', async t => {
  const fx = await fixture(t);
  await fx.engine.checks(fx.run);
  assert.equal(fx.run.checks.complete, true);
  fx.engine.setup = async () => assert.fail('invalid deadline reached setup');
  for (const timeoutMs of invalidTimeouts) {
    fx.run.config.commands.test[0].timeoutMs = timeoutMs;
    await assert.rejects(fx.engine.checks(fx.run), configurationError);
  }
});

test('Engine.run rejects malformed saved deadlines before preparation or delivery', async t => {
  const fx = await fixture(t);
  fx.engine.prepare = async () => assert.fail('invalid saved deadline reached preparation');
  for (const kind of ['test', 'build', 'deploy', 'smoke']) for (const timeoutMs of invalidTimeouts) {
    const saved = fx.store.getRun(fx.run.id);
    saved.config.commands = { test: [], build: [], deploy: [], smoke: [], [kind]: [{ command: process.execPath, args: [], timeoutMs }] };
    fx.store.updateRun(saved.id, saved);
    const result = await fx.engine.run(saved.id);
    assert.equal(result.state, 'blocked');
    assert.ok(configurationError(result.error), 'malformed saved deadline needs an actionable configuration error');
  }
});
