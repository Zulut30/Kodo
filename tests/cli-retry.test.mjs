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
      assert.equal(value.nextRetryAt, undefined);
      const status = spawnSync(process.execPath, [path.join(root, 'cli/index.mjs'), 'status', value.id, '--json'], {
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
      assert.equal(status.status, 0, status.stderr);
      assert.equal(Object.hasOwn(JSON.parse(status.stdout), 'nextRetryAt'), false);
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

test('Two-process resume after waiting_limits preserves --prepare and --plan intent and clears nextRetryAt', async t => {
  await t.test('run --prepare --json -> waiting_limits -> resume --json -> awaiting_plan', async subtest => {
    const directory = await makeRepo(subtest);
    const env = {
      ...process.env,
      KODO_HOME: path.join(directory, 'state'),
      KODO_CREDENTIAL_HOME: path.join(directory, 'credentials'),
    };
    const quotaHook = path.join(directory, 'prepare-quota-hook.mjs');
    await writeFile(
      quotaHook,
      `import { Engine } from ${JSON.stringify(pathToFileURL(path.join(root, 'runtime/engine.mjs')).href)};
Engine.prototype.prepare = async function () {
  throw Object.assign(new Error('quota during prepare'), { code: 'quota', retryAt: '2099-01-01T00:00:00.000Z' });
};\n`,
    );
    const first = spawnSync(
      process.execPath,
      [
        '--import',
        pathToFileURL(quotaHook).href,
        path.join(root, 'cli/index.mjs'),
        'run',
        'fixture prepare task',
        '--project',
        directory,
        '--mode',
        'quick',
        '--prepare',
        '--json',
      ],
      { cwd: directory, encoding: 'utf8', windowsHide: true, timeout: 30000, env },
    );
    assert.equal(first.status, 2, first.stderr);
    const paused = JSON.parse(first.stdout);
    assert.equal(paused.state, 'waiting_limits');
    assert.equal(paused.retryAt, '2099-01-01T00:00:00.000Z');

    const resumeHook = path.join(directory, 'prepare-resume-hook.mjs');
    await writeFile(
      resumeHook,
      `import { Engine } from ${JSON.stringify(pathToFileURL(path.join(root, 'runtime/engine.mjs')).href)};
Engine.prototype.selectModels = async function () {
  throw new Error('must_not_run_planner_after_prepare');
};
Engine.prototype.plan = async function () {
  throw new Error('must_not_run_planner_after_prepare');
};\n`,
    );
    const second = spawnSync(
      process.execPath,
      ['--import', pathToFileURL(resumeHook).href, path.join(root, 'cli/index.mjs'), 'resume', paused.id, '--json'],
      { cwd: directory, encoding: 'utf8', windowsHide: true, timeout: 30000, env },
    );
    assert.equal(second.status, 0, second.stderr || second.stdout);
    const resumed = JSON.parse(second.stdout);
    assert.equal(resumed.state, 'awaiting_plan');
    assert.equal(Object.hasOwn(resumed, 'nextRetryAt'), false);

    const status = spawnSync(process.execPath, [path.join(root, 'cli/index.mjs'), 'status', paused.id, '--json'], {
      cwd: directory,
      encoding: 'utf8',
      windowsHide: true,
      timeout: 30000,
      env,
    });
    assert.equal(status.status, 0, status.stderr);
    const stored = JSON.parse(status.stdout);
    assert.equal(stored.state, 'awaiting_plan');
    assert.equal(Object.hasOwn(stored, 'nextRetryAt'), false);
  });

  await t.test(
    'run --plan --json -> waiting_limits before plan saved -> resume --json applies host plan',
    async subtest => {
      const directory = await makeRepo(subtest);
      const env = {
        ...process.env,
        KODO_HOME: path.join(directory, 'state'),
        KODO_CREDENTIAL_HOME: path.join(directory, 'credentials'),
      };
      const planFile = path.join(directory, 'host-plan.json');
      await writeFile(
        planFile,
        JSON.stringify({
          summary: 'fixture host plan',
          tasks: [
            {
              id: 't1',
              role: 'developer',
              description: 'Update baseline',
              dependsOn: [],
              writePaths: ['baseline.txt'],
              acceptance: ['baseline updated'],
              parallel: false,
            },
          ],
        }),
      );
      const quotaHook = path.join(directory, 'plan-quota-hook.mjs');
      await writeFile(
        quotaHook,
        `import { Engine } from ${JSON.stringify(pathToFileURL(path.join(root, 'runtime/engine.mjs')).href)};
Engine.prototype.selectModels = async function () {
  throw Object.assign(new Error('quota before plan'), { code: 'quota', retryAt: '2099-01-01T00:00:00.000Z' });
};\n`,
      );
      const first = spawnSync(
        process.execPath,
        [
          '--import',
          pathToFileURL(quotaHook).href,
          path.join(root, 'cli/index.mjs'),
          'run',
          'fixture plan task',
          '--project',
          directory,
          '--mode',
          'quick',
          '--plan',
          planFile,
          '--json',
        ],
        { cwd: directory, encoding: 'utf8', windowsHide: true, timeout: 30000, env },
      );
      assert.equal(first.status, 2, first.stderr);
      const paused = JSON.parse(first.stdout);
      assert.equal(paused.state, 'waiting_limits');
      assert.equal(paused.plan, undefined);
      // Replace with another valid plan and then delete the original file before resume:
      // resume must execute the snapshotted original plan, neither the replacement nor ENOENT.
      await writeFile(
        planFile,
        JSON.stringify({
          summary: 'mutated plan that must be ignored',
          tasks: [
            {
              id: 't2',
              role: 'developer',
              description: 'Mutated task',
              dependsOn: [],
              writePaths: ['baseline.txt'],
              acceptance: ['mutated'],
              parallel: false,
            },
          ],
        }),
      );
      await rm(planFile, { force: true });

      const resumeHook = path.join(directory, 'plan-resume-hook.mjs');
      await writeFile(
        resumeHook,
        `import { Engine } from ${JSON.stringify(pathToFileURL(path.join(root, 'runtime/engine.mjs')).href)};
Engine.prototype.selectModels = async function (run) {
  run.models = [{ id: 'codex:gpt-6.1-sol', client: 'codex', model: 'gpt-6.1-sol', available: true }];
  this.save(run);
  return run.models;
};
Engine.prototype.session = async function () {
  throw new Error('must_not_invoke_native_planner');
};
Engine.prototype.baseline = async function () {};
Engine.prototype.executeTasks = async function (run) {
  run.nodes.t1 = { id: 't1', status: 'integrated' };
};
Engine.prototype.recoverIntegrationEdits = async function () {};
Engine.prototype.verify = async function () {};\n`,
      );
      const second = spawnSync(
        process.execPath,
        ['--import', pathToFileURL(resumeHook).href, path.join(root, 'cli/index.mjs'), 'resume', paused.id, '--json'],
        { cwd: directory, encoding: 'utf8', windowsHide: true, timeout: 30000, env },
      );
      assert.equal(second.status, 0, second.stderr || second.stdout);
      const resumed = JSON.parse(second.stdout);
      assert.equal(resumed.state, 'succeeded');
      assert.equal(resumed.planSource, 'host');
      assert.equal(resumed.plan?.summary, 'fixture host plan');
      assert.equal(Object.hasOwn(resumed, 'nextRetryAt'), false);

      const status = spawnSync(process.execPath, [path.join(root, 'cli/index.mjs'), 'status', paused.id, '--json'], {
        cwd: directory,
        encoding: 'utf8',
        windowsHide: true,
        timeout: 30000,
        env,
      });
      assert.equal(status.status, 0, status.stderr);
      const stored = JSON.parse(status.stdout);
      assert.equal(stored.state, 'succeeded');
      assert.equal(Object.hasOwn(stored, 'nextRetryAt'), false);
    },
  );
});

test('Pending plan snapshot, prepare write failure, --prepare --plan priority and atomic waiting_limits nextRetryAt', async t => {
  await t.test('same-process auto-retry does not re-read deleted --plan after plan was applied', async subtest => {
    const directory = await makeRepo(subtest);
    const env = {
      ...process.env,
      KODO_HOME: path.join(directory, 'state'),
      KODO_CREDENTIAL_HOME: path.join(directory, 'credentials'),
    };
    const planFile = path.join(directory, 'host-plan.json');
    await writeFile(
      planFile,
      JSON.stringify({
        summary: 'applied once plan',
        tasks: [
          {
            id: 't1',
            role: 'developer',
            description: 'Update baseline',
            dependsOn: [],
            writePaths: ['baseline.txt'],
            acceptance: ['baseline updated'],
            parallel: false,
          },
        ],
      }),
    );
    const hook = path.join(directory, 'same-proc-plan-hook.mjs');
    await writeFile(
      hook,
      `import { rm } from 'node:fs/promises';
import { mock } from 'node:test';
import { Engine } from ${JSON.stringify(pathToFileURL(path.join(root, 'runtime/engine.mjs')).href)};
let execCalls = 0;
Engine.prototype.selectModels = async function (run) {
  run.models = [{ id: 'codex:gpt-6.1-sol', client: 'codex', model: 'gpt-6.1-sol', available: true }];
  this.save(run);
  return run.models;
};
Engine.prototype.baseline = async function () {};
Engine.prototype.executeTasks = async function (run) {
  execCalls++;
  if (execCalls === 1) {
    await rm(${JSON.stringify(planFile)}, { force: true });
    mock.timers.enable({ apis: ['Date', 'setTimeout'], now: Date.now() });
    const retryAt = new Date(Date.now() + 80).toISOString();
    setImmediate(() => mock.timers.tick(80));
    throw Object.assign(new Error('quota during execute'), { code: 'quota', retryAt });
  }
  mock.timers.reset();
  run.nodes.t1 = { id: 't1', status: 'integrated' };
};
Engine.prototype.recoverIntegrationEdits = async function () {};
Engine.prototype.verify = async function () {};\n`,
    );
    const result = spawnSync(
      process.execPath,
      [
        '--import',
        pathToFileURL(hook).href,
        path.join(root, 'cli/index.mjs'),
        'run',
        'fixture same-proc plan',
        '--project',
        directory,
        '--mode',
        'quick',
        '--plan',
        planFile,
      ],
      { cwd: directory, encoding: 'utf8', windowsHide: true, timeout: 30000, env },
    );
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const value = JSON.parse(result.stdout);
    assert.equal(value.state, 'succeeded');
    assert.equal(value.plan?.summary, 'applied once plan');
    assert.equal(Object.hasOwn(value, 'nextRetryAt'), false);
  });

  await t.test('write failure during prepare artifact creation keeps pendingPrepare for next resume', async subtest => {
    const directory = await makeRepo(subtest);
    const env = {
      ...process.env,
      KODO_HOME: path.join(directory, 'state'),
      KODO_CREDENTIAL_HOME: path.join(directory, 'credentials'),
    };
    const failHook = path.join(directory, 'prepare-write-fail-hook.mjs');
    await writeFile(
      failHook,
      `import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { Engine } from ${JSON.stringify(pathToFileURL(path.join(root, 'runtime/engine.mjs')).href)};
const orig = Engine.prototype.preparePlanningContext;
Engine.prototype.preparePlanningContext = async function (run) {
  await mkdir(path.join(run.artifacts, 'plan.schema.json'), { recursive: true });
  return orig.call(this, run);
};\n`,
    );
    const first = spawnSync(
      process.execPath,
      [
        '--import',
        pathToFileURL(failHook).href,
        path.join(root, 'cli/index.mjs'),
        'run',
        'fixture prepare write fail',
        '--project',
        directory,
        '--mode',
        'quick',
        '--prepare',
        '--json',
      ],
      { cwd: directory, encoding: 'utf8', windowsHide: true, timeout: 30000, env },
    );
    assert.equal(first.status, 2, first.stderr);
    const blocked = JSON.parse(first.stdout);
    assert.equal(blocked.state, 'blocked');
    assert.equal(blocked.pendingPrepare, true);
    await rm(path.join(blocked.artifacts, 'plan.schema.json'), { recursive: true, force: true });

    const resumeHook = path.join(directory, 'prepare-write-resume-hook.mjs');
    await writeFile(
      resumeHook,
      `import { Engine } from ${JSON.stringify(pathToFileURL(path.join(root, 'runtime/engine.mjs')).href)};
Engine.prototype.selectModels = async function () {
  throw new Error('must_not_run_planner_after_prepare_write_error');
};
Engine.prototype.plan = async function () {
  throw new Error('must_not_run_planner_after_prepare_write_error');
};\n`,
    );
    const second = spawnSync(
      process.execPath,
      ['--import', pathToFileURL(resumeHook).href, path.join(root, 'cli/index.mjs'), 'resume', blocked.id, '--json'],
      { cwd: directory, encoding: 'utf8', windowsHide: true, timeout: 30000, env },
    );
    assert.equal(second.status, 0, second.stderr || second.stdout);
    const resumed = JSON.parse(second.stdout);
    assert.equal(resumed.state, 'awaiting_plan');
    assert.equal(resumed.pendingPrepare, undefined);
  });

  await t.test('run --prepare --plan FILE prioritizes --prepare and stops in awaiting_plan', async subtest => {
    const directory = await makeRepo(subtest);
    const env = {
      ...process.env,
      KODO_HOME: path.join(directory, 'state'),
      KODO_CREDENTIAL_HOME: path.join(directory, 'credentials'),
    };
    const planFile = path.join(directory, 'ignored-during-prepare.json');
    await writeFile(
      planFile,
      JSON.stringify({
        summary: 'must not execute during prepare',
        tasks: [
          {
            id: 't1',
            role: 'developer',
            description: 'Update baseline',
            dependsOn: [],
            writePaths: ['baseline.txt'],
            acceptance: ['baseline updated'],
            parallel: false,
          },
        ],
      }),
    );
    const guardHook = path.join(directory, 'prepare-priority-hook.mjs');
    await writeFile(
      guardHook,
      `import { Engine } from ${JSON.stringify(pathToFileURL(path.join(root, 'runtime/engine.mjs')).href)};
Engine.prototype.selectModels = async function () {
  throw new Error('must_not_execute_when_prepare_set');
};
Engine.prototype.plan = async function () {
  throw new Error('must_not_execute_when_prepare_set');
};\n`,
    );
    const result = spawnSync(
      process.execPath,
      [
        '--import',
        pathToFileURL(guardHook).href,
        path.join(root, 'cli/index.mjs'),
        'run',
        'fixture prepare priority',
        '--project',
        directory,
        '--mode',
        'quick',
        '--prepare',
        '--plan',
        planFile,
        '--json',
      ],
      { cwd: directory, encoding: 'utf8', windowsHide: true, timeout: 30000, env },
    );
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const value = JSON.parse(result.stdout);
    assert.equal(value.state, 'awaiting_plan');
    assert.equal(value.plan, undefined);
  });

  await t.test('Engine sets nextRetryAt atomically on waiting_limits and respects concurrent cancel', async subtest => {
    const directory = await makeRepo(subtest);
    const { Store } = await import('../runtime/store.mjs');
    const { Engine } = await import('../runtime/engine.mjs');
    const store = new Store(path.join(directory, 'state'), {});
    try {
      const engine = new Engine({ store, secrets: {} });
      const retryAt = '2099-01-01T00:00:00.000Z';
      engine.prepare = async () => {
        throw Object.assign(new Error('quota in engine'), { code: 'quota', retryAt });
      };
      const run = await engine.create('atomic retry test', { project: directory, mode: 'quick' });
      const paused = await engine.run(run.id);
      assert.equal(paused.state, 'waiting_limits');
      assert.equal(paused.nextRetryAt, retryAt);
      assert.equal(store.getRun(run.id).nextRetryAt, retryAt);

      // Concurrent cancel must clear nextRetryAt even when preserveCancellation update runs.
      store.updateRun(run.id, { cancelRequested: true, state: 'cancelled', nextRetryAt: undefined });
      const raced = store.updateRun(run.id, { nextRetryAt: retryAt }, { preserveCancellation: true });
      assert.equal(raced.state, 'cancelled');
      assert.equal(Object.hasOwn(raced, 'nextRetryAt'), false);
      assert.equal(Object.hasOwn(store.getRun(run.id), 'nextRetryAt'), false);
    } finally {
      store.close();
    }
  });
});
