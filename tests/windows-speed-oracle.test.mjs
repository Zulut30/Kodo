import test from 'node:test';
import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { Transform } from 'node:stream';
import { mkdtemp, mkdir, readFile, writeFile, rm, access, realpath } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import { inspectCurrentSource } from '../runtime/ci-graph.mjs';
import { execute } from '../runtime/command.mjs';
import { Engine } from '../runtime/engine.mjs';
import { Store } from '../runtime/store.mjs';
import { runCi } from '../runtime/ci-cli.mjs';
import { runProfiledCommand } from '../runtime/ci-profiler.mjs';
import { workerEnvironment } from '../runtime/security.mjs';

// Frozen behavioral oracle for windows-perf-ports-v1, not a performance benchmark.
// All Git commands pass through to an owned repository; only explicit malformed
// observation cases alter the returned stream. No new production authority port.
const secrets = Object.freeze({
  FIRST: 'oracle-alpha-middle',
  SECOND: 'middle-omega-tail',
  BOUNDARY: 'boundary-private-oracle-credential',
});
const overlap = 'oracle-alpha-middle-omega-tail';
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const childEnv = () => {
  const env = workerEnvironment();
  delete env.NODE_TEST_CONTEXT;
  return env;
};

async function scratch(t, beforeCleanup = () => {}) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'kodo-speed-oracle-')));
  t.after(async () => {
    await beforeCleanup();
    assert.equal(path.dirname(root).toLowerCase(), (await realpath(os.tmpdir())).toLowerCase());
    assert.match(path.basename(root), /^kodo-speed-oracle-/);
    await rm(root, { recursive: true, force: true });
  });
  return root;
}
async function repository(t, extra = {}, beforeCleanup) {
  const root = await scratch(t, beforeCleanup),
    project = path.join(root, 'project');
  await mkdir(project);
  const git = async args =>
    (await execute('git', args, { cwd: project, env: childEnv(), rawOutput: true })).stdout.trim();
  for (const args of [
    ['init', '-q'],
    ['config', 'user.name', 'Oracle Fixture'],
    ['config', 'user.email', 'oracle@example.invalid'],
    ['config', 'core.autocrlf', 'false'],
  ])
    await git(args);
  const files = typeof extra === 'function' ? extra(root) : extra;
  for (const [file, text] of Object.entries({ 'value.mjs': 'export const value = 1;\n', ...files })) {
    await mkdir(path.dirname(path.join(project, file)), { recursive: true });
    await writeFile(path.join(project, file), text);
  }
  await git(['add', '.']);
  await git(['commit', '-qm', 'owned oracle baseline']);
  return { root, project, git, headSha: await git(['rev-parse', 'HEAD']) };
}
function observeSpawns(t, observe) {
  const spawn = childProcess.spawn;
  const mocked = t.mock.method(childProcess, 'spawn', function (command, args, options) {
    const child = spawn.call(childProcess, command, args, options);
    observe({ command, args, options, child });
    return child;
  });
  syncBuiltinESMExports();
  t.after(() => {
    mocked.mock.restore();
    syncBuiltinESMExports();
  });
}
function replaceOutput(child, transform) {
  const original = child.stdout;
  let text = '';
  const rewritten = new Transform({
    transform(chunk, encoding, done) {
      text += chunk.toString('utf8');
      done();
    },
    flush(done) {
      this.push(transform(text));
      done();
    },
  });
  child.stdout = original.pipe(rewritten);
}
async function rejection(promise) {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  assert.fail('the controlled stopped command must reject');
}
function noSecret(value) {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  for (const fragment of [...Object.values(secrets), overlap, 'omega-tail', 'boundary-private', 'oracle-credential']) {
    assert.ok(!text.includes(fragment), `sanitized output leaked fake credential fragment ${fragment}`);
  }
}
function stoppedResult(error, code, { truncated = false } = {}) {
  assert.equal(error.code, code, 'the first stop cause remains the typed error code');
  assert.ok(error.result && typeof error.result === 'object', 'stopped commands retain sanitized diagnostic result');
  const result = error.result;
  assert.ok(result.code === null || Number.isInteger(result.code), 'actual child exit is an integer or null');
  assert.ok(Number.isFinite(result.durationMs) && result.durationMs >= 0);
  assert.equal(typeof result.outputTruncated, 'boolean');
  if (truncated) assert.equal(result.outputTruncated, true);
  assert.equal(typeof result.reason, 'string');
  assert.ok(result.reason.length > 0 && result.reason.length <= 80);
  for (const stream of ['stdout', 'stderr']) {
    assert.equal(typeof result[stream], 'string');
    assert.ok(result[stream].length <= 24000, `${stream} has a bounded diagnostic capture`);
    assert.ok(result[stream].isWellFormed());
  }
  for (const unsafe of ['rawOutput', 'env', 'args', 'stack']) assert.equal(result[unsafe], undefined);
  noSecret({ ...error, message: error.message });
  return result;
}

// Both pipes have completed their initial writes before READY is emitted. A
// cancellation listener waits for READY on stdout and STDERR_READY on stderr.
const diagnosticScript = `
const payload = marker => '🙂'.repeat(16000) + ${JSON.stringify(overlap)} + 'z'.repeat(4090 - (' END ' + marker).length) + ' END ' + marker;
process.stderr.write(payload('STDERR_READY'), () => process.stdout.write(payload('READY')));
setInterval(() => {}, 1000);
`;
function cancelWhenReady(t, controller, script) {
  let out = '',
    err = '',
    ready = false;
  observeSpawns(t, ({ command, args, child }) => {
    if (command !== process.execPath || !args.includes(script)) return;
    const check = () => {
      if (!ready && out.includes(' READY') && err.includes(' STDERR_READY')) {
        ready = true;
        controller.abort();
      }
    };
    child.stdout.on('data', chunk => {
      out = (out + chunk).slice(-100);
      check();
    });
    child.stderr.on('data', chunk => {
      err = (err + chunk).slice(-100);
      check();
    });
  });
  return () => assert.equal(ready, true, 'cancellation followed observed readiness on both real pipes');
}

test('Windows speed oracle: clean repeated same-HEAD inspection uses at most six total Git processes with two fresh protective queries per call', async t => {
  const fx = await repository(t),
    calls = [];
  observeSpawns(t, ({ command, args, child }) => {
    if (!/(?:^|[\\/])git(?:\.exe)?$/i.test(command)) return;
    calls.push(args);
    if (args.includes('status') && args.some(arg => arg.startsWith('--porcelain=v2'))) {
      replaceOutput(child, text => text + '# branch.upstream origin/fixture\0# branch.ab +0 -0\0');
    }
  });
  for (let inspection = 0; inspection < 2; inspection++) {
    const start = calls.length;
    assert.equal(await inspectCurrentSource(fx), 'clean');
    const observed = calls.slice(start),
      count = observed.length;
    const protective = observed.filter(
      args => args.includes('config') && args.includes('--name-only') && args.includes('--get-regexp'),
    ).length;
    const core = count - protective;
    t.diagnostic(
      `inspection=${inspection + 1} realGitProcesses=${count} coreObservations=${core} protectiveQueries=${protective}`,
    );
    assert.equal(protective, 2, 'each source fence retains its fresh filter-name protective query');
    assert.ok(
      count > 0 && count <= 6,
      `one complete inspection launched ${count} total Git processes, budget is 6 including 2 protective queries`,
    );
    assert.ok(core > 0 && core <= 4, `one complete inspection launched ${core} core observations, budget is 4`);
  }
});

for (const flag of ['--assume-unchanged', '--skip-worktree']) {
  test(`Windows speed oracle: ${flag} cannot hide same-size tracked byte edits after a clean observation`, async t => {
    const fx = await repository(t);
    assert.equal(await inspectCurrentSource(fx), 'clean');
    await fx.git(['update-index', flag, '--', 'value.mjs']);
    await writeFile(path.join(fx.project, 'value.mjs'), 'export const value = 9;\n');
    assert.equal(await fx.git(['status', '--porcelain=v1', '-z']), '', 'real index flag hides the edit from porcelain');
    assert.equal(await inspectCurrentSource(fx), 'dirty');
  });
}

test('Windows speed oracle: missing wrong malformed and nested source identity cannot become clean', async t => {
  const fx = await repository(t);
  for (const headSha of [undefined, '', 'f'.repeat(40), fx.headSha + '\n' + fx.headSha, 'g'.repeat(40)]) {
    assert.notEqual(await inspectCurrentSource({ project: fx.project, headSha }), 'clean');
  }
  assert.notEqual(
    await inspectCurrentSource({ project: path.join(fx.project, 'missing'), headSha: fx.headSha }),
    'clean',
  );
  await mkdir(path.join(fx.project, 'nested'));
  assert.notEqual(
    await inspectCurrentSource({ project: path.join(fx.project, 'nested'), headSha: fx.headSha }),
    'clean',
  );
});

for (const observation of ['missing', 'duplicate', 'malformed', 'wrong', 'unborn']) {
  test(`Windows speed oracle: ${observation} observed HEAD fails closed`, async t => {
    const fx = await repository(t);
    let injected = 0;
    observeSpawns(t, ({ command, args, child }) => {
      if (!/(?:^|[\\/])git(?:\.exe)?$/i.test(command)) return;
      const revision = args.includes('rev-parse') && args.includes('HEAD');
      const status = args.includes('status') && args.some(arg => arg.startsWith('--porcelain=v2'));
      if (!revision && !status) return;
      replaceOutput(child, text => {
        injected++;
        const oid =
          observation === 'wrong'
            ? 'f'.repeat(40)
            : observation === 'unborn'
              ? '(initial)'
              : observation === 'malformed'
                ? 'not-an-object-id'
                : fx.headSha;
        if (revision)
          return observation === 'missing' ? '' : observation === 'duplicate' ? `${oid}\n${oid}\n` : oid + '\n';
        const rows = text.split('\0').filter(row => !row.startsWith('# branch.oid '));
        if (observation !== 'missing') rows.unshift(`# branch.oid ${oid}`);
        if (observation === 'duplicate') rows.unshift(`# branch.oid ${oid}`);
        return rows.join('\0');
      });
    });
    assert.notEqual(await inspectCurrentSource(fx), 'clean');
    assert.ok(injected > 0, 'fault injection exercised the actual Git HEAD observation');
  });
}

test('Windows speed oracle: a source change at the second fence is never accepted', async t => {
  const fx = await repository(t);
  let statuses = 0;
  observeSpawns(t, ({ command, args, child }) => {
    if (!/(?:^|[\\/])git(?:\.exe)?$/i.test(command) || !args.includes('status')) return;
    statuses++;
    if (statuses === 2) replaceOutput(child, text => text + '?? late-change.mjs\0');
  });
  assert.notEqual(await inspectCurrentSource(fx), 'clean');
  assert.equal(statuses, 2, 'both source fences execute');
});

test('Windows speed oracle: successful stdin UTF8 and rawOutput behavior remains intact', async () => {
  const script =
    "process.stdin.setEncoding('utf8');let s='';process.stdin.on('data',x=>s+=x);process.stdin.on('end',()=>{process.stdout.write(s);process.stderr.write('ошибка 🙂')});";
  const input = `Привет 🙂 ${secrets.FIRST}`;
  const raw = await execute(process.execPath, ['-e', script], { env: childEnv(), input, secrets, rawOutput: true });
  assert.equal(raw.code, 0);
  assert.equal(raw.stdout, input);
  assert.equal(raw.stderr, 'ошибка 🙂');
  const clean = await execute(process.execPath, ['-e', script], { env: childEnv(), input, secrets });
  assert.equal(clean.stdout, 'Привет 🙂 [REDACTED]');
  assert.equal(clean.stderr, raw.stderr);
});

test('Windows speed oracle: timeout retains bounded redacted diagnostic result despite rawOutput request', async () => {
  const error = await rejection(
    execute(process.execPath, ['-e', diagnosticScript], { env: childEnv(), timeoutMs: 2000, secrets, rawOutput: true }),
  );
  const result = stoppedResult(error, 'timeout', { truncated: true });
  assert.match(result.stdout, /READY/);
  assert.match(result.stderr, /STDERR_READY/);
  assert.match(result.stdout + result.stderr, /\[REDACTED\]/);
});

test('Windows speed oracle: readiness-triggered cancellation retains bounded sanitized result', async t => {
  const controller = new AbortController(),
    assertReady = cancelWhenReady(t, controller, diagnosticScript);
  const error = await rejection(
    execute(process.execPath, ['-e', diagnosticScript], {
      env: childEnv(),
      signal: controller.signal,
      timeoutMs: 8000,
      secrets,
      rawOutput: true,
    }),
  );
  assertReady();
  const result = stoppedResult(error, 'cancelled', { truncated: true });
  assert.match(result.stdout, /READY/);
  assert.match(result.stderr, /STDERR_READY/);
});

test('Windows speed oracle: a later abort cannot relabel an earlier timeout', async t => {
  const controller = new AbortController();
  let exited = false;
  observeSpawns(t, ({ command, args, child }) => {
    if (command === process.execPath && args.includes(diagnosticScript))
      child.once('exit', () => {
        exited = true;
        controller.abort();
      });
  });
  const error = await rejection(
    execute(process.execPath, ['-e', diagnosticScript], {
      env: childEnv(),
      timeoutMs: 2000,
      signal: controller.signal,
      secrets,
    }),
  );
  assert.equal(exited, true);
  assert.equal(controller.signal.aborted, true);
  stoppedResult(error, 'timeout', { truncated: true });
});

function overflowScript(stream) {
  const cap = (stream === 'stdout' ? 16 : 4) * 1024 * 1024;
  // The known secret crosses the hard capture ceiling. The stream ends with
  // additional data so overflow is unavoidable even with any pipe chunking.
  return `process.${stream}.write('q'.repeat(${cap - 12}) + ${JSON.stringify(secrets.BOUNDARY)} + 'z'.repeat(65536));setInterval(()=>{},1000);`;
}
for (const stream of ['stdout', 'stderr']) {
  test(`Windows speed oracle: ${stream} overflow has invalid_output code and no boundary credential fragments`, async () => {
    const error = await rejection(
      execute(process.execPath, ['-e', overflowScript(stream)], {
        env: childEnv(),
        timeoutMs: 8000,
        secrets,
        rawOutput: true,
      }),
    );
    stoppedResult(error, 'invalid_output', { truncated: true });
  });
}

test('Windows speed oracle: a later abort cannot relabel an earlier overflow', async t => {
  const controller = new AbortController(),
    script = overflowScript('stderr');
  observeSpawns(t, ({ command, args, child }) => {
    if (command === process.execPath && args.includes(script)) child.once('exit', () => controller.abort());
  });
  const error = await rejection(
    execute(process.execPath, ['-e', script], { env: childEnv(), timeoutMs: 8000, signal: controller.signal, secrets }),
  );
  assert.equal(controller.signal.aborted, true);
  stoppedResult(error, 'invalid_output', { truncated: true });
});

async function engineFixture(t, mode) {
  let store;
  const childScript =
    mode === 'overflow'
      ? overflowScript('stderr')
      : mode === 'cancelled-zero'
        ? "console.log('ZERO_EXIT_READY');"
        : diagnosticScript;
  const fx = await repository(
      t,
      root => ({
        'stopped-child.cjs': childScript,
        'success-child.cjs': "console.log('EARLIER_SUCCESS');",
        'following-child.cjs': `require('node:fs').writeFileSync(${JSON.stringify(path.join(root, 'following-command'))},'must not run');`,
      }),
      () => store?.close(),
    ),
    state = path.join(fx.root, 'state');
  store = new Store(state);
  const script = 'stopped-child.cjs';
  const marker = path.join(fx.root, 'following-command');
  const command = (file, timeoutMs = 8000) => ({ command: process.execPath, args: [file], timeoutMs });
  const run = store.createRun({
    project: fx.project,
    cwd: fx.project,
    baseSha: fx.headSha,
    task: 'owned stopped-check oracle',
    config: {
      commands: {
        test: [
          command('success-child.cjs'),
          command(script, mode === 'timeout' ? 2000 : 8000),
          command('following-child.cjs'),
        ],
        build: [],
      },
      architecture: { enabled: false },
    },
  });
  run.artifacts = path.join(state, 'runs', run.id);
  await mkdir(run.artifacts, { recursive: true });
  const engine = new Engine({ store, secrets });
  engine.save(run);
  return {
    ...fx,
    run,
    engine,
    script,
    marker,
    reopen() {
      store.close();
      store = new Store(state);
      return { run: store.getRun(run.id), engine: new Engine({ store, secrets }) };
    },
  };
}

for (const mode of ['timeout', 'cancelled', 'overflow', 'cancelled-zero']) {
  test(`Windows speed oracle: Engine ${mode} saves a failed incomplete immutable receipt that survives reopen and prevents following commands`, async t => {
    const fx = await engineFixture(t, mode),
      controller = new AbortController();
    const assertReady = mode === 'cancelled' ? cancelWhenReady(t, controller, fx.script) : () => {};
    if (mode === 'cancelled-zero')
      observeSpawns(t, ({ command, args, child }) => {
        // exit precedes close: a zero exit is real, and the abort is observed
        // while execute still owns the child and has not settled its Promise.
        if (command === process.execPath && args.includes(fx.script))
          child.once('exit', code => {
            assert.equal(code, 0);
            controller.abort();
          });
      });
    const error = await rejection(fx.engine.checks(fx.run, controller.signal));
    assertReady();
    const code = mode === 'overflow' ? 'invalid_output' : mode === 'cancelled-zero' ? 'cancelled' : mode;
    stoppedResult(error, code, { truncated: mode !== 'cancelled-zero' });
    if (mode === 'cancelled-zero')
      assert.equal(error.result.code, 0, 'an observed zero child exit cannot make a stopped check PASS');
    await assert.rejects(access(fx.marker), { code: 'ENOENT' });
    const reopened = fx.reopen(),
      saved = reopened.run;
    assert.equal(saved.checks.complete, false);
    assert.equal(saved.checks.headSha, fx.headSha);
    assert.equal(
      saved.checks.results.length,
      2,
      'earlier success and stopped failure both survive; no later command runs',
    );
    const [success, failed] = saved.checks.results;
    assert.equal(success.exitCode, 0);
    assert.match(success.output, /EARLIER_SUCCESS/);
    assert.equal(failed.status, 'failed');
    assert.equal(failed.reason, code);
    assert.equal(failed.exitCode, null, 'forced stop is never a successful command exit');
    if (Object.hasOwn(failed, 'processExitCode')) assert.equal(failed.processExitCode, error.result.code);
    assert.equal(typeof failed.outputHash, 'string');
    const bytes = await readFile(failed.outputPath),
      evidence = JSON.parse(bytes);
    assert.equal(digest(bytes), failed.outputHash);
    assert.equal(path.basename(failed.outputPath), `check-${failed.outputHash}.json`);
    assert.equal(evidence.kind, 'check');
    assert.equal(evidence.headSha, fx.headSha);
    assert.equal(evidence.value.exitCode, null);
    await reopened.engine.assertEvidence({ path: failed.outputPath, sha256: failed.outputHash, headSha: fx.headSha });
    noSecret(evidence);
    noSecret(failed);
    for (const stream of ['stdout', 'stderr']) {
      assert.equal(typeof evidence.value[stream], 'string');
      assert.ok(evidence.value[stream].length <= 24000);
    }
    const before = Buffer.from(bytes);
    // The saved incomplete receipt cannot be reused as a successful check.
    // Resume with the same aborted signal: it must reject before the next child.
    controller.abort();
    await assert.rejects(reopened.engine.checks(saved, controller.signal), { code: 'cancelled' });
    assert.equal(saved.checks.complete, false);
    await assert.rejects(access(fx.marker), { code: 'ENOENT' });
    assert.deepEqual(await readFile(failed.outputPath), before, 'reopen leaves content-addressed evidence unchanged');
  });
}

test('Windows speed oracle: evidence persistence failure cannot mask the original stopped error', async t => {
  const fx = await engineFixture(t, 'timeout'),
    persist = fx.engine.persistEvidence.bind(fx.engine);
  let attempted = false;
  fx.engine.persistEvidence = async (run, kind, value, options) => {
    if (kind === 'check' && value.exitCode === null) {
      attempted = true;
      throw Object.assign(new Error('owned disk fixture failed'), { code: 'fixture_disk_failure' });
    }
    return persist(run, kind, value, options);
  };
  const error = await rejection(fx.engine.checks(fx.run));
  assert.equal(error.code, 'timeout');
  assert.equal(attempted, true, 'stopped evidence persistence was attempted');
  assert.equal(fx.run.checks.complete, false);
  await assert.rejects(access(fx.marker), { code: 'ENOENT' });
});

test('Windows speed oracle: runCi retains real profiled timeout tails bounded redacted and nonpassing', async t => {
  const fx = await repository(t, { 'scripts/package-smoke.mjs': diagnosticScript });
  const names = ['KODO_ORACLE_FIRST_SECRET', 'KODO_ORACLE_SECOND_SECRET'];
  const previous = names.map(name => process.env[name]);
  names.forEach((name, index) => {
    process.env[name] = Object.values(secrets)[index];
  });
  t.after(() =>
    names.forEach((name, index) => {
      if (previous[index] === undefined) delete process.env[name];
      else process.env[name] = previous[index];
    }),
  );
  let observedFailure;
  const result = await runCi(
    { project: fx.project, tier: 'L3', evidenceDir: path.join(fx.root, 'ci-evidence') },
    {
      runProfiledCommand: async options => {
        assert.equal(options.timeoutMs, 1200000, 'the production CI deadline remains fixed');
        assert.equal(options.command, process.execPath);
        assert.deepEqual(options.args, ['scripts/package-smoke.mjs']);
        // The owned child uses a short local deadline; runCi still supplies its
        // unchanged public 20-minute deadline. No whole-suite command executes.
        try {
          return await runProfiledCommand({ ...options, env: childEnv(), timeoutMs: 2000 });
        } catch (error) {
          // Untrusted producer metadata must not be spread into the public receipt.
          error.privatePayload = 'PRIVATE_ERROR_METADATA';
          error.env = { PRIVATE_ERROR_METADATA: 'not-public' };
          observedFailure = error;
          throw error;
        }
      },
    },
  );
  assert.equal(observedFailure?.code, 'timeout');
  assert.equal(result.complete, false);
  assert.equal(result.status, 'blocked');
  assert.equal(result.crossPlatformVerified, false);
  assert.equal(result.deploymentVerified, false);
  const receipt = result.receipts.find(row => row.phase === 'package-smoke');
  assert.equal(receipt.status, 'blocked');
  assert.equal(receipt.reason, 'timeout');
  assert.notEqual(receipt.exitCode, 0);
  assert.equal(receipt.profilePath, observedFailure.profilePath);
  assert.ok(receipt.diagnostic, 'thrown profiler failures retain allowlisted tails');
  assert.deepEqual(Object.keys(receipt.diagnostic).sort(), [
    'stderrTail',
    'stderrTruncated',
    'stdoutTail',
    'stdoutTruncated',
  ]);
  for (const stream of ['stdout', 'stderr']) {
    const tail = receipt.diagnostic[`${stream}Tail`];
    assert.ok(Buffer.byteLength(tail) <= 4096);
    assert.ok(tail.isWellFormed());
    assert.equal(receipt.diagnostic[`${stream}Truncated`], true);
    const suffix = ' END ' + (stream === 'stdout' ? 'READY' : 'STDERR_READY');
    assert.equal(
      tail,
      'ACTED]' + 'z'.repeat(4090 - suffix.length) + suffix,
      'redaction precedes the exact 4 KiB tail cut',
    );
  }
  for (const unsafe of ['stdout', 'stderr', 'env', 'stack', 'rawOutput']) assert.equal(receipt[unsafe], undefined);
  assert.equal(receipt.privatePayload, undefined);
  assert.ok(!JSON.stringify(result).includes('PRIVATE_ERROR_METADATA'));
  noSecret(result);
});
