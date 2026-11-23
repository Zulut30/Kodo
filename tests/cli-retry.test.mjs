import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
test('CLI automatic quota retries preserve host preparation and explicit plan files', async t => {
  for (const prepare of [true, false])
    await t.test(prepare ? 'host-preparation' : 'explicit-plan', async subtest => {
      const directory = await mkdtemp(path.join(os.tmpdir(), 'kodo-cli-retry-'));
      subtest.after(async () => {
        assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()));
        assert.ok(path.basename(directory).startsWith('kodo-cli-retry-'));
        await rm(directory, { recursive: true, force: true });
      });
      const git = args =>
        execFileSync('git', args, { cwd: directory, encoding: 'utf8', windowsHide: true, stdio: 'pipe' });
      git(['init', '-b', 'main']);
      git(['config', 'user.name', 'CLI Retry Test']);
      git(['config', 'user.email', 'retry@example.invalid']);
      await writeFile(path.join(directory, 'baseline.txt'), 'baseline\n');
      git(['add', '.']);
      git(['commit', '-m', 'baseline']);
      const planFile = path.join(directory, 'plan.json');
      await writeFile(planFile, JSON.stringify({ summary: 'fixture plan', tasks: [] }));
      const hook = path.join(directory, 'engine-fixture.mjs');
      const expected = prepare ? { prepare: true } : { planFile };
      await writeFile(
        hook,
        `import assert from 'node:assert/strict';
import {mock} from 'node:test';
import {Engine} from ${JSON.stringify(pathToFileURL(path.join(root, 'runtime/engine.mjs')).href)};
let calls=0;
Engine.prototype.run=async function(id,options){
 calls++;
 if(calls===1) {
   mock.timers.enable({apis:['Date','setTimeout'],now:Date.now()});
   const retryAt=new Date(Date.now()+80).toISOString();
   const paused=this.store.updateRun(id,{state:'waiting_limits',error:{code:'quota',retryAt}});
   setImmediate(()=>mock.timers.tick(80));
   return paused;
 }
 assert.equal(this.store.getRun(id).nextRetryAt, new Date(Date.now()).toISOString());
 mock.timers.reset();
 assert.equal(calls,2);
 const expected=${JSON.stringify(expected)};
 for(const [key,value] of Object.entries(expected)) assert.equal(options[key],value,'automatic retry lost '+key);
 return this.store.updateRun(id,{state:${JSON.stringify(prepare ? 'awaiting_plan' : 'succeeded')},retryConfirmed:true});
};\n`,
      );
      const result = spawnSync(
        process.execPath,
        [
          '--import',
          pathToFileURL(hook).href,
          path.join(root, 'cli/index.mjs'),
          'run',
          'fixture task',
          '--project',
          directory,
          ...(prepare ? ['--prepare'] : ['--plan', planFile]),
        ],
        {
          cwd: directory,
          encoding: 'utf8',
          windowsHide: true,
          timeout: 30000,
          env: {
            ...process.env,
            KODO_HOME: path.join(directory, 'state'),
            KODO_CREDENTIAL_HOME: path.join(directory, 'credentials'),
          },
        },
      );
      assert.ifError(result.error);
      assert.equal(result.status, 0, result.stderr);
      const value = JSON.parse(result.stdout);
      assert.equal(value.state, prepare ? 'awaiting_plan' : 'succeeded');
      assert.equal(value.retryConfirmed, true);
    });
});

async function makeRepo(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'kodo-cli-nowait-'));
  t.after(async () => {
    assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(directory).startsWith('kodo-cli-nowait-'));
    await rm(directory, { recursive: true, force: true });
  });
  const git = args => execFileSync('git', args, { cwd: directory, encoding: 'utf8', windowsHide: true, stdio: 'pipe' });
  git(['init', '-b', 'main']);
  git(['config', 'user.name', 'CLI Retry Test']);
  git(['config', 'user.email', 'retry@example.invalid']);
  await writeFile(path.join(directory, 'baseline.txt'), 'baseline\n');
  git(['add', '.']);
  git(['commit', '-m', 'baseline']);
  return directory;
}

test('CLI run and resume with --json or --no-wait return waiting_limits and retryAt immediately without sleeping', async t => {
  const futureIso = '2099-01-01T00:00:00.000Z';
  const cases = [
    { name: 'run --json with retryAt', command: 'run', flags: ['--json'], retryAt: futureIso },
    { name: 'run --json without retryAt', command: 'run', flags: ['--json'], retryAt: null },
    { name: 'resume --json with retryAt', command: 'resume', flags: ['--json'], retryAt: futureIso },
    { name: 'run --no-wait without --json', command: 'run', flags: ['--no-wait'], retryAt: futureIso },
    { name: 'resume --no-wait without --json', command: 'resume', flags: ['--no-wait'], retryAt: futureIso },
  ];
  for (const item of cases) {
    await t.test(item.name, async subtest => {
      const directory = await makeRepo(subtest);
      const env = {
        ...process.env,
        KODO_HOME: path.join(directory, 'state'),
        KODO_CREDENTIAL_HOME: path.join(directory, 'credentials'),
      };
      const hook = path.join(directory, 'waiting-hook.mjs');
      await writeFile(
        hook,
        `import assert from 'node:assert/strict';
import { Engine } from ${JSON.stringify(pathToFileURL(path.join(root, 'runtime/engine.mjs')).href)};
let calls = 0;
Engine.prototype.run = async function (id) {
  calls++;
  assert.equal(calls, 1, 'must not retry after immediate waiting_limits return');
  globalThis.setTimeout = () => {
    throw new Error('unexpected_sleep_on_waiting_limits');
  };
  const retryAt = ${JSON.stringify(item.retryAt)};
  return this.store.updateRun(id, {
    state: 'waiting_limits',
    error: { code: 'quota', message: 'limit reached', ...(retryAt ? { retryAt } : {}) },
  });
};\n`,
      );
      let args;
      if (item.command === 'run') {
        args = ['run', 'fixture task', '--project', directory, ...item.flags];
      } else {
        const seedHook = path.join(directory, 'seed-hook.mjs');
        await writeFile(
          seedHook,
          `import { Engine } from ${JSON.stringify(pathToFileURL(path.join(root, 'runtime/engine.mjs')).href)};
Engine.prototype.run = async function (id) {
  return this.store.updateRun(id, { state: 'awaiting_plan' });
};\n`,
        );
        const seeded = spawnSync(
          process.execPath,
          [
            '--import',
            pathToFileURL(seedHook).href,
            path.join(root, 'cli/index.mjs'),
            'run',
            'fixture task',
            '--project',
            directory,
            '--prepare',
            '--json',
          ],
          { cwd: directory, encoding: 'utf8', windowsHide: true, timeout: 30000, env },
        );
        assert.equal(seeded.status, 0, seeded.stderr);
        const runId = JSON.parse(seeded.stdout).id;
        args = ['resume', runId, ...item.flags];
      }
      const before = Date.now();
      const result = spawnSync(
        process.execPath,
        ['--import', pathToFileURL(hook).href, path.join(root, 'cli/index.mjs'), ...args],
        { cwd: directory, encoding: 'utf8', windowsHide: true, timeout: 30000, env },
      );
      assert.ifError(result.error);
      assert.equal(result.status, 2, result.stderr);
      const value = JSON.parse(result.stdout);
      assert.equal(value.state, 'waiting_limits');
      assert.equal(typeof value.retryAt, 'string');
      assert.equal(value.nextRetryAt, value.retryAt);
      if (item.retryAt) assert.equal(value.retryAt, item.retryAt);
      else assert.ok(Date.parse(value.retryAt) > before + 14 * 60 * 1000);
    });
  }
});

test('CLI rejects --no-wait on non-waiting commands', async t => {
  const directory = await makeRepo(t);
  const result = spawnSync(process.execPath, [path.join(root, 'cli/index.mjs'), 'status', 'missing-run', '--no-wait'], {
    cwd: directory,
    encoding: 'utf8',
    windowsHide: true,
    timeout: 30000,
    env: {
      ...process.env,
      KODO_HOME: path.join(directory, 'state'),
      KODO_CREDENTIAL_HOME: path.join(directory, 'credentials'),
    },
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /неприменим/i);
});
