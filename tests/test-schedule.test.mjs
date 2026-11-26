import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink } from 'node:fs/promises';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const root = fileURLToPath(new URL('../', import.meta.url));
const runner = path.join(root, 'scripts/run-tests.mjs');
const scheduleUrl = new URL('../scripts/run-tests.mjs', import.meta.url);
const packageJson = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
// Exercise the package entry point even in the pre-implementation RED run.
const entryArgs = packageJson.scripts.test
  .split(' ')
  .slice(1)
  .map(arg => (arg.startsWith('scripts/') ? path.join(root, arg) : arg));
const pass = "const { test } = require('node:test'); test('fixture passes', () => {});\n";
const fixtureCleanups = new WeakMap();

async function fixture(t) {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'kodo-test-order-'));
  const cleanups = [];
  fixtureCleanups.set(t, cleanups);
  t.after(async () => {
    for (const cleanup of cleanups.reverse()) await cleanup();
    assert.equal(path.dirname(path.resolve(temp)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(temp).startsWith('kodo-test-order-'));
    await rm(temp, { recursive: true, force: true });
  });
  const put = async (name, content = pass) => {
    const file = path.join(temp, name);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, content);
  };
  return { temp, put };
}

function child(t, cwd, args = [], options = {}) {
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  delete env.NODE_TEST_WORKER_ID;
  const proc = spawn(process.execPath, args, { cwd, env, windowsHide: true, ...options });
  let stdout = '',
    stderr = '';
  proc.stdout.on('data', data => {
    stdout += data;
  });
  proc.stderr.on('data', data => {
    stderr += data;
  });
  const done = new Promise((resolve, reject) => {
    proc.on('error', reject);
    proc.on('close', (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
  fixtureCleanups.get(t).push(async () => {
    if (proc.exitCode === null && proc.signalCode === null) proc.kill();
    await done;
  });
  return { proc, done };
}

async function lines(file) {
  try {
    return (await readFile(file, 'utf8')).trim().split('\n').filter(Boolean);
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
}

async function waitFor(predicate) {
  const end = Date.now() + 5000;
  while (!(await predicate())) {
    assert.ok(Date.now() < end, 'short fixture did not reach readiness');
    await delay(10);
  }
}

test(
  'Scheduler retains nonzero TAP results and emits bounded named failure diagnostics',
  { timeout: 15000 },
  async t => {
    const { temp, put } = await fixture(t);
    await put(
      'tests/failure.test.cjs',
      "const test = require('node:test'); for(let i=0;i<25;i++) test('named fixture regression '+i,()=>{throw Error('owned failure')});\n",
    );
    const result = await child(t, temp, entryArgs).done;
    assert.notEqual(result.code, 0);
    assert.match(result.stdout, /not ok.*named fixture regression 0/);
    const records = result.stderr.split(/\r?\n/).flatMap(line => {
      try {
        const row = JSON.parse(line);
        return row.kind === 'kodo-test-failure' ? [row] : [];
      } catch {
        return [];
      }
    });
    assert.equal(records.length, 16);
    assert.equal(records[0].name, 'named fixture regression 0');
    assert.ok(
      records.every(
        row => typeof row.name === 'string' && row.name.length <= 240 && typeof row.failureType === 'string',
      ),
    );
    assert.ok(Buffer.byteLength(result.stderr) < 8192);
  },
);

test('Scheduler orders observed file durations longest first and retains every discovered file once', async t => {
  const { temp, put } = await fixture(t);
  const { orderTests, discoverTests, heavySuites } = await import(scheduleUrl);
  // Independent oracle locked from source821 receipt c9b54c3c: all 19 completed
  // files >=90000 ms descending, then scheduling's 100233.5395 ms case-work
  // lower-bound heuristic (not file elapsed), then the three retained lighter
  // priorities descending. Neither old receipts nor production data define it.
  const expected = [
    'tests/delivery.test.mjs',
    'tests/project-director.test.mjs',
    'tests/architecture-gate-integration.test.mjs',
    'tests/architecture-cli.test.mjs',
    'tests/engine-2.test.mjs',
    'tests/engine-4.test.mjs',
    'tests/engine-3.test.mjs',
    'tests/benchmark.test.mjs',
    'tests/engine.test.mjs',
    'tests/knowledge-cli.test.mjs',
    'tests/ci-graph.test.mjs',
    'tests/knowledge-refresh.test.mjs',
    'tests/mode-engine-2.test.mjs',
    'tests/ci-cache.test.mjs',
    'tests/efficiency-engine.test.mjs',
    'tests/mode-engine.test.mjs',
    'tests/mode-engine-4.test.mjs',
    'tests/quality-runner.test.mjs',
    'tests/mode-engine-3.test.mjs',
    'tests/scheduling-engine.test.mjs',
    'tests/ci-cli.test.mjs',
    'tests/project-director-oracle.test.mjs',
    'tests/architecture-acceptance.test.mjs',
    'tests/a-unobserved.test.mjs',
    'tests/z-unobserved.test.mjs',
  ].map(file => path.resolve(temp, file));
  const scrambled = [16, 18, 6, 11, 1, 14, 4, 17, 9, 2, 13, 0, 15, 10, 5, 12, 3, 8, 7, 24, 20, 22, 19, 23, 21].map(
    index => expected[index],
  );
  for (const file of scrambled) await put(path.relative(temp, file));
  await put('tests/helper.mjs', 'throw Error("not a default test name");');
  const input = [...scrambled, scrambled[0], path.relative(temp, scrambled[11])];
  const original = [...input];
  const ordered = orderTests(input, temp);
  assert.equal(ordered.length, expected.length);
  assert.equal(new Set(ordered).size, expected.length);
  assert.deepEqual([...ordered].sort(), [...expected].sort(), 'same complete file multiset');
  assert.deepEqual(input, original, 'ordering must not mutate caller input');
  // Default discovery keeps every file except the heavy suites, which `npm run test:heavy` runs (stage 16E).
  assert.deepEqual(
    [...discoverTests(temp)].sort(),
    expected.filter(file => !heavySuites.includes(path.relative(temp, file).replaceAll('\\', '/'))).sort(),
    'default discovery remains complete outside the separate steps',
  );
  assert.deepEqual(ordered, expected);
  assert.deepEqual(orderTests([...input].reverse(), temp), expected);
});

function workflowJob(workflow, name) {
  const marker = `\n  ${name}:\n`;
  const start = workflow.indexOf(marker);
  assert.notEqual(start, -1, `workflow defines job ${name}`);
  const rest = workflow.slice(start + marker.length);
  return rest.split(/\n {2}[A-Za-z0-9_-]+:\n/)[0];
}

test('The wave factory suites run in their own command and parallel CI shards, outside default discovery', async () => {
  const { discoverTests, separateSuites, waveShards } = await import(scheduleUrl);
  // With them, one L2 command reached its fixed Windows deadline (runs 45410439061, 45418257242).
  // Split into balanced 4-file shards so each Windows CI shard runs all files in one concurrent wave.
  assert.deepEqual(waveShards, {
    director: [
      'tests/project-wave-director.test.mjs',
      'tests/project-wave-director-recovery.test.mjs',
      'tests/project-wave-e2e.test.mjs',
      'tests/project-wave-e2e-gates.test.mjs',
    ],
    parallel: [
      'tests/project-parallel-engine.test.mjs',
      'tests/project-parallel-fencing.test.mjs',
      'tests/project-remote-diagnostics.test.mjs',
      'tests/project-remote-transport.test.mjs',
    ],
  });
  assert.deepEqual(separateSuites, [...waveShards.director, ...waveShards.parallel]);
  const discovered = discoverTests(root).map(file => path.relative(root, file).replaceAll('\\', '/'));
  for (const suite of separateSuites) {
    assert.ok(!discovered.includes(suite), `${suite} is not in the default suite`);
    assert.ok(statSync(path.join(root, suite)).isFile(), `${suite} exists`);
  }
  const scripts = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')).scripts;
  assert.equal(scripts['test:waves'], `node scripts/run-tests.mjs ${separateSuites.join(' ')}`);
  assert.equal(scripts['test:waves:director'], `node scripts/run-tests.mjs ${waveShards.director.join(' ')}`);
  assert.equal(scripts['test:waves:parallel'], `node scripts/run-tests.mjs ${waveShards.parallel.join(' ')}`);
  const workflow = readFileSync(path.join(root, '.github/workflows/ci.yml'), 'utf8');
  const fast = workflowJob(workflow, 'fast');
  assert.doesNotMatch(fast, /npm run test:waves/);
  for (const [shard, osName] of [
    ['director', 'ubuntu'],
    ['director', 'windows'],
    ['parallel', 'ubuntu'],
    ['parallel', 'windows'],
  ]) {
    const job = workflowJob(workflow, `ci-waves-${shard}-${osName}`);
    assert.match(job, new RegExp(`runs-on: ${osName}-latest`));
    assert.match(job, new RegExp(`run: npm run test:waves:${shard}\\n`));
  }
});

test('The heavy integration suites run in their own command and parallel CI jobs, outside default discovery', async () => {
  const { discoverTests, heavySuites } = await import(scheduleUrl);
  // Stage 16E: with them, one Windows L2 command took 2032658-2325940 ms and timed out on a slow runner.
  // The per-file measurements behind this list are in docs/CI.md.
  assert.deepEqual(heavySuites, [
    'tests/delivery.test.mjs',
    'tests/architecture-rust.test.mjs',
    'tests/project-director.test.mjs',
    'tests/wave-context-integration.test.mjs',
    'tests/task-fast-checks.test.mjs',
    'tests/behavior-rust.test.mjs',
    'tests/architecture-gate-integration.test.mjs',
    'tests/project-integration.test.mjs',
    'tests/engine-2.test.mjs',
    'tests/engine-4.test.mjs',
    'tests/engine-3.test.mjs',
    'tests/benchmark.test.mjs',
    'tests/engine.test.mjs',
    'tests/architecture-cli.test.mjs',
    'tests/ci-graph.test.mjs',
    'tests/knowledge-refresh.test.mjs',
    'tests/knowledge-cli.test.mjs',
    'tests/cargo-fetch-recovery.test.mjs',
    'tests/project-integration-fence.test.mjs',
  ]);
  const discovered = discoverTests(root).map(file => path.relative(root, file).replaceAll('\\', '/'));
  for (const suite of heavySuites) {
    assert.ok(!discovered.includes(suite), `${suite} is not in the default suite`);
    assert.ok(statSync(path.join(root, suite)).isFile(), `${suite} exists`);
  }
  const scripts = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')).scripts;
  assert.equal(scripts['test:heavy'], `node scripts/run-tests.mjs ${heavySuites.join(' ')}`);
  const workflow = readFileSync(path.join(root, '.github/workflows/ci.yml'), 'utf8');
  const fast = workflowJob(workflow, 'fast');
  assert.doesNotMatch(fast, /npm run test:heavy/);
  for (const osName of ['ubuntu', 'windows']) {
    const heavyJob = workflowJob(workflow, `ci-heavy-${osName}`);
    assert.match(heavyJob, new RegExp(`runs-on: ${osName}-latest`));
    assert.match(heavyJob, /\n {6}- name: Heavy integration suites\n {8}run: npm run test:heavy\n/);
  }
});

test('Every default-pattern test file runs in exactly one required check shard', async () => {
  const { discoverTests } = await import(scheduleUrl);
  // Independent oracle: Node's default test glob over the checkout, without the runner's exclusions.
  const extensions = process.features.typescript ? 'js,mjs,cjs,ts,mts,cts' : 'js,mjs,cjs';
  const pattern = `**/{test,test/**/*,test-*,*[._-]test}.{${extensions}}`;
  const all = [];
  const visit = directory => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name === '.git' || entry.isSymbolicLink()) continue;
      const file = path.join(directory, entry.name);
      const relative = path.relative(root, file).replaceAll('\\', '/');
      if (entry.isDirectory() && !entry.name.startsWith('.')) visit(file);
      else if (entry.isFile() && path.matchesGlob(relative, pattern)) all.push(relative);
    }
  };
  visit(root);
  assert.ok(all.length > 100, 'the checkout has its test files');
  const scripts = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')).scripts;
  assert.match(scripts.check, /&& npm test$/);
  assert.equal(scripts.test, 'node scripts/run-tests.mjs');
  const listed = name => {
    const [command, ...files] = scripts[name].split(' ');
    assert.equal(`${command} ${files.shift()}`, 'node scripts/run-tests.mjs', `${name} uses the repository runner`);
    return files;
  };
  const steps = {
    'npm run check': discoverTests(root).map(file => path.relative(root, file).replaceAll('\\', '/')),
    'npm run test:waves:director': listed('test:waves:director'),
    'npm run test:waves:parallel': listed('test:waves:parallel'),
    'npm run test:heavy': listed('test:heavy'),
  };
  const runs = new Map();
  for (const [step, files] of Object.entries(steps))
    for (const file of files) runs.set(file, [...(runs.get(file) ?? []), step]);
  for (const file of all)
    assert.deepEqual(runs.get(file)?.length, 1, `${file} runs in exactly one shard: ${runs.get(file) ?? 'none'}`);
  assert.deepEqual([...runs.keys()].sort(), [...all].sort(), 'no shard names a file outside the default pattern');
  // Every mandatory leg is a dedicated single-OS job emitting positive `outputs.passed`, gated by `check` with `if: always()`.
  const workflow = readFileSync(path.join(root, '.github/workflows/ci.yml'), 'utf8');
  const fast = workflowJob(workflow, 'fast');
  const check = workflowJob(workflow, 'check');
  assert.match(check, /\n {4}if: always\(\)\n/);
  assert.match(check, /os: \[ubuntu-latest, windows-latest\]/);
  assert.match(check, /node: \[24\]/);
  const requiredLegs = [
    ['ci-l2-ubuntu', 'ubuntu-latest', ['node scripts/ci.mjs run --tier L2']],
    ['ci-l2-windows', 'windows-latest', ['node scripts/ci.mjs run --tier L2']],
    ['ci-heavy-ubuntu', 'ubuntu-latest', ['npm run test:heavy']],
    ['ci-heavy-windows', 'windows-latest', ['npm run test:heavy']],
    ['ci-waves-director-ubuntu', 'ubuntu-latest', ['npm run test:waves:director']],
    ['ci-waves-director-windows', 'windows-latest', ['npm run test:waves:director']],
    ['ci-waves-parallel-ubuntu', 'ubuntu-latest', ['npm run test:waves:parallel']],
    ['ci-waves-parallel-windows', 'windows-latest', ['npm run test:waves:parallel']],
    ['ci-final-ubuntu', 'ubuntu-latest', ['npm run test:final', 'node scripts/package-smoke.mjs']],
    ['ci-final-windows', 'windows-latest', ['npm run test:final', 'node scripts/package-smoke.mjs']],
  ];
  for (const [jobName, runnerOs, commands] of requiredLegs) {
    const job = workflowJob(workflow, jobName);
    assert.match(job, new RegExp(`runs-on: ${runnerOs}`), `${jobName} runs on ${runnerOs}`);
    assert.match(job, /node-version: 24/, `${jobName} uses Node 24`);
    assert.match(
      job,
      /passed: \$\{\{ steps\.verify\.outputs\.passed \}\}/,
      `${jobName} exports positive passed output`,
    );
    assert.doesNotMatch(job, /matrix:/, `${jobName} has no matrix rollup ambiguity`);
    for (const command of commands) {
      assert.equal(job.split(`run: ${command}`).length - 1, 1, `${command} runs once in ${jobName}`);
      assert.ok(!fast.includes(command), `${command} is not in the fast job`);
    }
    assert.ok(check.includes(`- ${jobName}\n`), `check depends on ${jobName}`);
    assert.ok(check.includes(`needs.${jobName}.result`), `check verifies ${jobName}.result`);
    assert.ok(check.includes(`needs.${jobName}.outputs.passed`), `check verifies ${jobName}.outputs.passed`);
  }
});
test(
  'Scheduler starts heuristic heavy files before lexical files in real isolated children',
  { timeout: 15000 },
  async t => {
    const { temp, put } = await fixture(t);
    const observed = path.join(temp, 'starts');
    // Stage 16E moved these priority files to `npm run test:heavy`: default discovery never starts them.
    const heavy = [
      'tests/project-director.test.mjs',
      'tests/architecture-gate-integration.test.mjs',
      'tests/architecture-cli.test.mjs',
      'tests/knowledge-cli.test.mjs',
      'tests/ci-graph.test.mjs',
      'tests/knowledge-refresh.test.mjs',
    ];
    const expected = [
      'tests/mode-engine-2.test.mjs',
      'tests/ci-cache.test.mjs',
      'tests/efficiency-engine.test.mjs',
      'tests/mode-engine.test.mjs',
      'tests/mode-engine-4.test.mjs',
      'tests/quality-runner.test.mjs',
      'tests/mode-engine-3.test.mjs',
      'tests/scheduling-engine.test.mjs',
      'tests/project-director-oracle.test.mjs',
      'tests/a.test.mjs',
      'tests/z.test.mjs',
    ];
    for (const name of [...expected, ...heavy].reverse()) {
      await put(
        name,
        `import { appendFileSync } from 'node:fs'; import test from 'node:test'; appendFileSync(${JSON.stringify(observed)}, ${JSON.stringify(name + '\n')}); test('ok', () => {});`,
      );
    }
    const result = await child(t, temp, [...entryArgs, '--test-concurrency=1']).done;
    assert.equal(result.code, 0, result.stdout + result.stderr);
    assert.deepEqual(await lines(observed), expected);
  },
);

test(
  'Scheduler discovers every Node24 default name recursively and excludes unrelated files',
  { timeout: 15000 },
  async t => {
    const { temp, put } = await fixture(t);
    const expected = [
      'test.js',
      'test-a.mjs',
      'a.test.cjs',
      'a-test.js',
      'a_test.mjs',
      'nested/test/deep/helper.cjs',
      'nested/test/helper.js',
      'nested/test.mjs',
      'nested/test-nested.cjs',
      'nested/a.test.mjs',
      'nested/a_test.js',
      'types/test-basic.ts',
      'types/basic-test.mts',
      'types/basic_test.cts',
    ];
    for (const name of expected) {
      const source = /\.(mjs|mts)$/.test(name) ? "import test from 'node:test'; test('present', () => {});" : pass;
      await put(name, source);
    }
    for (const name of [
      'ordinary.mjs',
      'tests/helper.mjs',
      'contest/a.js',
      'test/no.txt',
      'test/ordinary.json',
      'x.test.jsx',
      'x.test.tsx',
      '.hidden/a.test.mjs',
      '.git/a.test.mjs',
      'node_modules/a.test.mjs',
      'nested/node_modules/test.js',
    ])
      await put(name, 'throw new Error("must not execute");');
    const { discoverTests } = await import(scheduleUrl);
    const relative = files => files.map(file => path.relative(temp, file).replaceAll('\\', '/')).sort();
    assert.deepEqual(relative(discoverTests(temp)), [...expected].sort());
    // Independent native discovery executes the same known fixtures.
    const native = await child(t, temp, ['--test', '--test-reporter=tap']).done;
    assert.equal(native.code, 0, native.stdout + native.stderr);
    assert.match(native.stdout, new RegExp(`# tests ${expected.length}\\b`));
    await put('new/deep/new.test.mjs', "import test from 'node:test'; test('new', () => {});");
    assert.deepEqual(relative(discoverTests(temp)), [...expected, 'new/deep/new.test.mjs'].sort());
    const noTypes = await child(t, temp, [
      '--no-experimental-strip-types',
      '--input-type=module',
      '-e',
      `import { discoverTests } from ${JSON.stringify(scheduleUrl.href)}; console.log(JSON.stringify(discoverTests(process.cwd())));`,
    ]).done;
    assert.equal(noTypes.code, 0, noTypes.stderr);
    assert.deepEqual(
      relative(JSON.parse(noTypes.stdout)),
      [...expected.filter(name => !/\.(ts|mts|cts)$/.test(name)), 'new/deep/new.test.mjs'].sort(),
    );
  },
);

test('Scheduler never traverses directory links outside checkout or duplicate linked trees', async t => {
  const { temp, put } = await fixture(t);
  await put('project/tests/real.test.cjs');
  await put('outside/escape.test.cjs', 'throw new Error("outside checkout");');
  await symlink(path.join(temp, 'outside'), path.join(temp, 'project', 'escape'), 'junction');
  await symlink(path.join(temp, 'project/tests'), path.join(temp, 'project', 'alias'), 'junction');
  await symlink(path.join(temp, 'project'), path.join(temp, 'project/tests', 'loop'), 'junction');
  const { discoverTests } = await import(scheduleUrl);
  assert.deepEqual(discoverTests(path.join(temp, 'project')), [path.join(temp, 'project/tests/real.test.cjs')]);
  const result = await child(t, path.join(temp, 'project'), [runner, 'escape/escape.test.cjs']).done;
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /linked test path/);
  assert.equal(result.stdout, '');
});

test('Scheduler deduplicates priorities and preserves deterministic lexical fallback', async () => {
  const { orderTests } = await import(scheduleUrl);
  const files = [
    'z.test.mjs',
    'tests/ci-cache.test.mjs',
    'tests/project-director.test.mjs',
    'A.test.mjs',
    'a.test.mjs',
    'tests/ci-graph.test.mjs',
    'tests/project-director-oracle.test.mjs',
    'tests/ci-cache.test.mjs',
  ];
  const expected = [
    'tests/project-director.test.mjs',
    'tests/ci-graph.test.mjs',
    'tests/ci-cache.test.mjs',
    'tests/project-director-oracle.test.mjs',
    'A.test.mjs',
    'a.test.mjs',
    'z.test.mjs',
  ].map(file => path.resolve(root, file));
  assert.deepEqual(
    orderTests(
      files.map(file => path.resolve(root, file)),
      root,
    ),
    expected,
  );
  assert.deepEqual(
    orderTests(
      [...files].reverse().map(file => path.resolve(root, file)),
      root,
    ),
    expected,
  );
});

test(
  'Scheduler defaults to four concurrent isolated workers and executes each file once',
  { timeout: 15000 },
  async t => {
    const { temp, put } = await fixture(t);
    const log = path.join(temp, 'events'),
      release = path.join(temp, 'release');
    for (let id = 0; id < 7; id++)
      await put(
        `${id}.test.cjs`,
        `const {appendFileSync,existsSync}=require('node:fs'); const {setTimeout:delay}=require('node:timers/promises'); const test=require('node:test'); const log=${JSON.stringify(log)}; appendFileSync(log, JSON.stringify({event:'start',id:${id},pid:process.pid})+'\\n'); test('barrier',{timeout:5000},async()=>{ while(!existsSync(${JSON.stringify(release)})) await delay(10); appendFileSync(log,JSON.stringify({event:'end',id:${id}})+'\\n'); });`,
      );
    const execution = child(t, temp, entryArgs);
    try {
      await waitFor(async () => (await lines(log)).length >= 4);
      await delay(100);
      assert.equal((await lines(log)).length, 4, 'fifth worker must wait for a slot');
    } finally {
      await writeFile(release, 'go');
    }
    const result = await execution.done;
    assert.equal(result.code, 0, result.stdout + result.stderr);
    const events = (await lines(log)).map(line => JSON.parse(line));
    const starts = events.filter(event => event.event === 'start');
    assert.equal(starts.length, 7);
    assert.equal(new Set(starts.map(event => event.id)).size, 7);
    assert.equal(new Set(starts.map(event => event.pid)).size, 7);
    assert.ok(starts.every(event => event.pid !== execution.proc.pid));
    let active = 0,
      peak = 0;
    for (const event of events) {
      active += event.event === 'start' ? 1 : -1;
      peak = Math.max(peak, active);
    }
    assert.equal(peak, 4);
    assert.equal(active, 0);
  },
);

for (const [kind, source, diagnostic] of [
  [
    'assertion',
    "const test=require('node:test'); test('real assertion',()=>require('node:assert/strict').equal(1,2));",
    /ERR_ASSERTION|1 !== 2/,
  ],
  ['import crash', "require('./absent-import.cjs');", /MODULE_NOT_FOUND|Cannot find module/],
  [
    'cancelled child',
    "const test=require('node:test'); test('cancelled',{signal:AbortSignal.abort()},()=>{});",
    /abort|cancel/i,
  ],
])
  test(`Scheduler returns nonzero and retains diagnostics for ${kind}`, { timeout: 10000 }, async t => {
    const { temp, put } = await fixture(t);
    await put('broken.test.cjs', source);
    await put('following.test.cjs');
    const result = await child(t, temp, entryArgs).done;
    assert.notEqual(result.code, 0, result.stdout + result.stderr);
    assert.match(result.stdout + result.stderr, diagnostic);
    assert.match(result.stdout, /fixture passes/, 'failure must not suppress other files');
  });

test(
  'Scheduler supports explicit paths deduplication and name patterns through the package entry',
  { timeout: 10000 },
  async t => {
    const { temp, put } = await fixture(t);
    await put(
      'selected.cjs',
      "const test=require('node:test'); test('wanted',()=>{}); test('unwanted',()=>{throw Error('must be filtered')});",
    );
    await put('other.test.cjs', "throw Error('explicit selection ignored');");
    for (const args of [
      ['--test-name-pattern', '^wanted$', 'selected.cjs', './selected.cjs'],
      ['selected.cjs', '--test-name-pattern=^wanted$'],
    ]) {
      const result = await child(t, temp, [...entryArgs, ...args]).done;
      assert.equal(result.code, 0, result.stdout + result.stderr);
      assert.match(result.stdout, /# tests 1\b/);
      assert.doesNotMatch(result.stdout, /must be filtered|explicit selection ignored/);
    }
  },
);

test('Scheduler rejects unsupported flags unsafe paths and empty explicit selections', { timeout: 15000 }, async t => {
  const { temp, put } = await fixture(t);
  await put('good.test.cjs');
  await put('node_modules/forbidden.cjs', "throw Error('must not execute');");
  await put('.git/forbidden.cjs', "throw Error('must not execute');");
  for (const args of [
    ['--watch'],
    ['--test-force-exit'],
    ['--test-concurrency=9'],
    ['--test-concurrency=0'],
    ['--test-name-pattern'],
    ['absent.cjs'],
    ['../escape.cjs'],
    ['*.test.cjs'],
    ['node_modules/forbidden.cjs'],
    ['.git/forbidden.cjs'],
    ['.'],
  ]) {
    const result = await child(t, temp, [runner, ...args]).done;
    assert.notEqual(result.code, 0, JSON.stringify(args));
    assert.match(result.stderr, /unsupported|concurrency|value|not found|outside|literal/i);
    assert.doesNotMatch(result.stdout, /fixture passes/);
  }
});

test('Scheduler abort drains its owned children and reports cancellation as nonzero', { timeout: 15000 }, async t => {
  const { temp, put } = await fixture(t),
    ready = path.join(temp, 'ready');
  await put(
    'owned.test.cjs',
    `require('node:fs').writeFileSync(${JSON.stringify(ready)},String(process.pid)); require('node:test')('alive',async()=>{ await new Promise(resolve=>setTimeout(resolve,4000)); });`,
  );
  const script = `import {runTests} from ${JSON.stringify(pathToFileURL(runner).href)}; import {existsSync} from 'node:fs'; const controller=new AbortController(); const timer=setInterval(()=>{if(existsSync(${JSON.stringify(ready)})){clearInterval(timer);controller.abort();}},10); try{await runTests({signal:controller.signal});}finally{clearInterval(timer);}`;
  await put('abort-driver.mjs', script);
  const result = await child(t, temp, ['abort-driver.mjs']).done;
  assert.notEqual(result.code, 0, result.stdout + result.stderr);
  assert.match(result.stdout + result.stderr, /abort|cancel/i);
  const pid = Number(await readFile(ready, 'utf8'));
  assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' }, 'owned child must be gone after runner closes');
});

async function concurrencyBarrier(t, { expected, resources, explicit }) {
  const { temp, put } = await fixture(t);
  const log = path.join(temp, 'events'),
    release = path.join(temp, 'release');
  const count = 11;
  for (let id = 0; id < count; id++)
    await put(
      `${id}.test.cjs`,
      `
    const {appendFileSync,existsSync}=require('node:fs');
    const {setTimeout:delay}=require('node:timers/promises');
    const test=require('node:test');
    const log=${JSON.stringify(log)};
    appendFileSync(log,JSON.stringify({event:'start',id:${id},pid:process.pid})+${JSON.stringify('\n')});
    test('resource barrier',{timeout:5000},async()=>{
      while(!existsSync(${JSON.stringify(release)})) await delay(10);
      appendFileSync(log,JSON.stringify({event:'end',id:${id}})+${JSON.stringify('\n')});
    });
  `,
    );
  let args = [...entryArgs];
  if (resources) {
    // Only OS readings are controlled. Discovery, filesystem, process isolation,
    // the package entry point and the official Node scheduler remain real.
    await put(
      'resources.mjs',
      `import os from 'node:os'; import {syncBuiltinESMExports} from 'node:module';
      os.availableParallelism=()=>${resources[0]}; os.freemem=()=>${resources[1]}; syncBuiltinESMExports();`,
    );
    args = ['--import', pathToFileURL(path.join(temp, 'resources.mjs')).href, ...args];
  }
  if (explicit !== undefined) args.push(`--test-concurrency=${explicit}`);
  const execution = child(t, temp, args);
  try {
    await waitFor(async () => (await lines(log)).length >= expected || execution.proc.exitCode !== null);
    await delay(100);
    const waiting = (await lines(log)).map(line => JSON.parse(line));
    assert.equal(waiting.length, expected, 'next file must wait until a slot is released');
    assert.ok(waiting.every(event => event.event === 'start'));
    assert.equal(new Set(waiting.map(event => event.pid)).size, expected, 'barrier requires distinct child PIDs');
  } finally {
    await writeFile(release, 'go');
  }
  const result = await execution.done;
  assert.equal(result.code, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /# tests 11\b/);
  const events = (await lines(log)).map(line => JSON.parse(line));
  const starts = events.filter(event => event.event === 'start');
  const ends = events.filter(event => event.event === 'end');
  assert.deepEqual(
    starts.map(event => event.id).sort((a, b) => a - b),
    Array.from({ length: count }, (_, id) => id),
  );
  assert.deepEqual(
    ends.map(event => event.id).sort((a, b) => a - b),
    Array.from({ length: count }, (_, id) => id),
  );
  assert.equal(new Set(starts.map(event => event.pid)).size, count);
  assert.ok(starts.every(event => event.pid !== execution.proc.pid));
  let active = 0,
    peak = 0;
  for (const event of events) {
    active += event.event === 'start' ? 1 : -1;
    assert.ok(active >= 0 && active <= expected, 'active file count remains bounded');
    peak = Math.max(peak, active);
  }
  assert.equal(peak, expected);
  assert.equal(active, 0, 'all started files drained');
  for (const { pid } of starts) assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
}

test(
  'Scheduler explicit eight runs eight distinct child PIDs once and drains more than eight files',
  { timeout: 15000 },
  async t => {
    await concurrencyBarrier(t, { expected: 8, explicit: 8 });
  },
);

for (const [label, resources, expected, explicit] of [
  ['low CPU defaults to four', [8, 8 * 1024 ** 3], 4],
  ['low memory defaults to four', [32, 2 * 1024 ** 3], 4],
  ['high resources conservatively default to four', [32, 8 * 1024 ** 3], 4],
  ['explicit one overrides high resources', [32, 8 * 1024 ** 3], 1, 1],
  ['explicit eight overrides low resources', [8, 2 * 1024 ** 3], 8, 8],
])
  test(`Scheduler default wiring: ${label}`, { timeout: 15000 }, async t => {
    await concurrencyBarrier(t, { resources, expected, explicit });
  });

test(
  'Scheduler accepts every explicit integer one through eight and rejects malformed concurrency',
  { timeout: 15000 },
  async t => {
    const { temp, put } = await fixture(t);
    await put('one.test.cjs');
    for (let value = 1; value <= 8; value++) {
      const result = await child(t, temp, [...entryArgs, '--test-concurrency', String(value)]).done;
      assert.equal(result.code, 0, result.stdout + result.stderr);
      assert.match(result.stdout, /# tests 1\b/);
    }
    for (const value of ['0', '9', '1.5', 'Infinity', 'NaN', 'unknown', '-1', '08', '']) {
      const result = await child(t, temp, [...entryArgs, `--test-concurrency=${value}`]).done;
      assert.notEqual(result.code, 0, value);
      assert.match(result.stderr, /concurrency/i);
      assert.doesNotMatch(result.stdout, /fixture passes/);
    }
  },
);

test('Fast subset lists distinct discovered files outside the slow priority list', async () => {
  const { fastTests, discoverTests, orderTests } = await import(scheduleUrl);
  assert.ok(fastTests.length > 0, 'test:fast must select files');
  assert.equal(new Set(fastTests).size, fastTests.length, 'no duplicate fast entries');
  const discovered = new Set(discoverTests(root).map(file => path.relative(root, file).split(path.sep).join('/')));
  for (const file of fastTests) assert.ok(discovered.has(file), `${file} is a discovered test file`);
  // orderTests puts slow priority files first, then the rest lexically; '!' sorts
  // before every test name, so anything ranked ahead of the probe is a slow file.
  const probe = path.join(root, 'tests', '!unranked.test.mjs');
  const ranked = orderTests([...fastTests.map(file => path.join(root, file)), probe], root);
  assert.deepEqual(
    ranked.slice(0, ranked.indexOf(probe)).map(file => path.relative(root, file)),
    [],
    'fast files must not be in the slow priority list',
  );
});

test('Scheduler --fast runs from the checkout root and rejects explicit paths', { timeout: 15000 }, async t => {
  const { temp, put } = await fixture(t);
  await put('extra.test.cjs');
  const result = await child(t, temp, [runner, '--fast', 'extra.test.cjs']).done;
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /--fast selects its own files/);
  assert.doesNotMatch(result.stdout, /fixture passes/);
});

test('Scheduler --coverage reports first-party sources only and stays opt-in', { timeout: 30000 }, async t => {
  const { temp, put } = await fixture(t);
  await put('runtime/covered.mjs', 'export const pick = flag => (flag ? "yes" : "no");\n');
  await put('runtime/fixtures/ignored.mjs', 'export const ignored = 1;\n');
  await put(
    'covered.test.mjs',
    [
      "import { test } from 'node:test';",
      "import { pick } from './runtime/covered.mjs';",
      "import './runtime/fixtures/ignored.mjs';",
      "test('fixture passes', () => pick(true));",
      '',
    ].join('\n'),
  );
  const covered = await child(t, temp, [runner, '--coverage', 'covered.test.mjs']).done;
  assert.equal(covered.code, 0, covered.stderr);
  assert.match(covered.stdout, /fixture passes/);
  assert.match(covered.stdout, /# start of coverage report/);
  assert.match(covered.stdout, /covered\.mjs/);
  assert.doesNotMatch(covered.stdout, /ignored\.mjs|covered\.test\.mjs \|/);
  const plain = await child(t, temp, [runner, 'covered.test.mjs']).done;
  assert.equal(plain.code, 0, plain.stderr);
  assert.doesNotMatch(plain.stdout, /start of coverage report/);
});
