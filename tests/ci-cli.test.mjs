import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { mkdtemp, mkdir, writeFile, rm, readFile, access } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execute } from '../runtime/command.mjs';
import { ciCli, planCi, runCi } from '../runtime/ci-cli.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sha = 'a'.repeat(40);

test('CI acceptance blocks dirty source before execution and mutation under an unchanged HEAD', async t => {
  for (const scenario of ['dirty before', 'mutation during', 'clean source']) await t.test(scenario, async t => {
    const project = await mkdtemp(path.join(os.tmpdir(), 'kodo-ci-clean-'));
    t.after(async () => { assert.equal(path.dirname(project), path.resolve(os.tmpdir())); await rm(project, { recursive: true, force: true }); });
    const git = args => execute('git', args, { cwd: project });
    await git(['init', '-q']); await git(['config', 'user.name', 'CI Fixture']); await git(['config', 'user.email', 'ci@example.invalid']);
    const file = path.join(project, 'source.mjs'); await writeFile(file, 'export const value = 1;\n');
    await git(['add', 'source.mjs']); await git(['commit', '-qm', 'fixture']);
    const head = (await git(['rev-parse', 'HEAD'])).stdout.trim();
    if (scenario === 'dirty before') await writeFile(file, 'export const value = 2;\n');
    let checks = 0;
    const result = await runCi({ project, tier: 'L2' }, {
      execute: async (command, args, options) => {
        if (command !== 'npm') return execute(command, args, options);
        checks++; if (scenario === 'mutation during') await writeFile(file, 'export const value = 3;\n');
        return { code: 0, stdout: '', stderr: '' };
      }, security: async () => ({ status: 'passed', passed: true })
    });
    assert.equal((await git(['rev-parse', 'HEAD'])).stdout.trim(), head);
    assert.equal(result.status, scenario === 'clean source' ? 'passed' : 'blocked');
    assert.equal(result.complete, scenario === 'clean source');
    assert.equal(checks, scenario === 'dirty before' ? 0 : 1);
  });
});

const graph = { schemaVersion: 1, changedFiles: ['src.mjs'], affectedFiles: ['src.mjs', 'tests/dependent.test.mjs'], testFiles: ['tests/dependent.test.mjs'], fallback: false, reasons: [], sourceHash: 's', dependencyHash: 'd' };
function ports(overrides = {}) {
  const calls = [];
  return { calls, dependencies: {
    head: async () => sha, sourceState: async () => 'clean', planAffected: async () => graph,
    qualityRegistry: { detect: async () => ({ files: [{ path: 'src.mjs' }] }), plan: async (_project, options) => ({ status: 'applicable', checks: [{ id: 'js:lint', status: 'applicable' }], options }) },
    runQuality: async options => { calls.push(['quality', options]); return { status: 'passed', receipts: [{ id: 'js:lint', status: 'passed' }] }; },
    execute: async (command, args) => { calls.push([command, args]); return { code: 0, stdout: '', stderr: '' }; },
    security: async () => ({ status: 'passed', passed: true }),
    ...overrides
  } };
}

test('CI strict arguments reject invalid duplicate and positional flags as JSON', async () => {
  for (const args of [['other'], ['plan', '--tier', 'L4'], ['plan', '--base', 'HEAD'], ['plan', '--tier', 'L1', '--tier', 'L0'], ['run', '--fix'], ['run', 'extra'], ['run', '--project'], ['plan', '--json', '--json']]) {
    const r = await ciCli([...args, '--json']);
    assert.equal(r.exitCode, 1); assert.equal(JSON.parse(r.output).status, 'blocked');
  }
});

test('CI acceptance never passes when current source state cannot be verified', async () => {
  for (const sourceState of [async () => 'unknown', async () => { throw new Error('unavailable'); }]) {
    const p = ports({ sourceState });
    const result = await runCi({ project: root, tier: 'L2' }, p.dependencies);
    assert.equal(result.status, 'blocked'); assert.equal(result.complete, false);
    assert.equal(result.receipts[0].reason, 'source_unavailable'); assert.equal(p.calls.length, 0);
  }
});

test('CI L0 plans changed format and lint and preserves applicable checks', async () => {
  const p = ports(); const report = await planCi({ project: root, tier: 'L0', baseSha: sha }, p.dependencies);
  assert.deepEqual(report.quality.options.capabilities, ['format', 'lint']);
  assert.deepEqual(report.quality.options.changedPaths, ['src.mjs']);
  assert.equal(report.quality.checks[0].status, 'applicable'); assert.equal(p.calls.length, 0);
});

test('CI L1 executes syntax lint typecheck and proven dependent tests', async () => {
  const p = ports(); const r = await runCi({ project: root, tier: 'L1', baseSha: sha }, p.dependencies);
  assert.equal(r.status, 'passed');
  assert.deepEqual(p.calls[0][1].capabilities, ['lint', 'typecheck']);
  assert.ok(p.calls.some(([, args]) => Array.isArray(args) && args[0] === '--check' && args[1] === 'src.mjs'));
  assert.ok(p.calls.some(([, args]) => Array.isArray(args) && args.includes('tests/dependent.test.mjs') && args[0] === '--test'));
});

test('CI graph fallback runs broad tests and full quality scope', async () => {
  const p = ports({ planAffected: async () => ({ ...graph, fallback: true, reasons: ['unknown_dependency'] }) });
  const r = await runCi({ project: root, tier: 'L1', baseSha: sha }, p.dependencies);
  assert.equal(r.status, 'passed'); assert.equal(p.calls[0][1].mode, 'standard');
  assert.equal(p.calls[0][1].changedPaths, undefined);
  assert.ok(p.calls.some(([, args]) => Array.isArray(args) && args.length === 1 && args[0] === '--test'));
});

test('CI feedback fallback keeps ambiguity defers full tests and never claims complete L1', async () => {
  const reasons = Array.from({ length: 153 }, (_, i) => `unknown_dependency_${i}`);
  const p = ports({ planAffected: async () => ({ ...graph, fallback: true, reasons, affectedFiles: ['src.mjs', 'unrelated.mjs', 'tests/dependent.test.mjs'] }) });
  const r = await ciCli(['feedback', '--base', sha, '--json'], p.dependencies);
  assert.equal(r.exitCode, 0); assert.equal(r.report.status, 'feedback_ready');
  assert.equal(r.report.complete, false); assert.equal(r.report.requiresFullCheck, true);
  assert.deepEqual(r.report.graph.reasons, reasons);
  assert.ok(r.report.deferredChecks.some(row => row.phase === 'tests' && row.status === 'deferred' && row.tier === 'L2' && row.headSha === sha));
  const quality = p.calls.find(([kind]) => kind === 'quality')[1];
  assert.equal(quality.mode, 'quick'); assert.deepEqual(quality.changedPaths, ['src.mjs']);
  assert.equal(p.calls.filter(([, args]) => Array.isArray(args) && args[0] === '--check').length, 1);
  assert.ok(!p.calls.some(([, args]) => Array.isArray(args) && (args.includes('--test') || args.join(' ') === 'run check')));
});

test('CI feedback runs only proven affected tests without broad fallback', async () => {
  const p = ports(); const r = await ciCli(['feedback', '--base', sha, '--json'], p.dependencies);
  assert.equal(r.exitCode, 0); assert.equal(r.report.status, 'feedback_ready');
  assert.equal(r.report.complete, false); assert.equal(r.report.requiresFullCheck, true);
  assert.deepEqual(p.calls.find(([kind]) => kind === 'quality')[1].changedPaths, graph.affectedFiles.filter(name => name === 'src.mjs'));
  assert.ok(p.calls.some(([, args]) => Array.isArray(args) && args[0] === '--test' && args[1] === 'tests/dependent.test.mjs'));
});

test('CI feedback neutral docs remain neutral and mixed neutral receipts preserve actual checks', async () => {
  const neutral = { id: 'other:lint', status: 'skipped', reason: 'no_changed_or_affected_source' };
  for (const checked of [false, true]) {
    const p = ports({ planAffected: async () => checked ? { ...graph, fallback: true, reasons: ['unknown'] } : { ...graph, changedFiles: ['README.md'], affectedFiles: ['README.md'], testFiles: [], fallback: true, reasons: ['documentation'] },
      runQuality: async () => ({ status: checked ? 'passed' : 'skipped', receipts: checked ? [neutral, { id: 'js:lint', status: 'passed' }] : [neutral] }) });
    const r = await ciCli(['feedback', '--base', sha, '--json'], p.dependencies);
    assert.equal(r.exitCode, 0); assert.equal(r.report.complete, false);
    assert.equal(r.report.codeChecksObserved, checked);
    assert.equal(r.report.status, checked ? 'feedback_ready' : 'not_applicable');
    assert.equal(r.report.receipts[0].report.receipts[0].status, 'skipped');
  }
});

test('CI feedback rejects missing disabled failed or blocked quality even alongside passing syntax', async () => {
  for (const status of ['missing', 'unsupported', 'blocked', 'disabled', 'failed']) {
    for (const rows of [[{ status }], [{ status: 'passed' }, { status }], [{ status: 'not_applicable' }]]) {
      const p = ports({ runQuality: async () => ({ status, receipts: rows }) });
      const r = await ciCli(['feedback', '--base', sha, '--json'], p.dependencies);
      assert.equal(r.exitCode, 1); assert.equal(r.report.complete, false);
      assert.notEqual(r.report.status, 'feedback_ready');
    }
  }
});

test('CI feedback preserves metadata changes for quality ownership widening', async () => {
  const files = ['package.json', 'package-lock.json', '.github/workflows/ci.yml', 'src.mjs'];
  const p = ports({ planAffected: async () => ({ ...graph, changedFiles: files, fallback: true, reasons: ['unknown_config'] }),
    qualityRegistry: { detect: async () => ({ files: files.map(path => ({ path })) }), plan: async (_project, options) => ({ options, checks: [] }) } });
  const r = await ciCli(['feedback', '--base', sha, '--json'], p.dependencies);
  assert.equal(r.report.qualityOptions.mode, 'quick'); assert.deepEqual(r.report.qualityOptions.changedPaths, files);
  assert.ok(r.report.deferredChecks.some(row => row.tier === 'L2'));
});

test('CI feedback cancellation and head mutation cannot report ready', async () => {
  const controller = new AbortController(); controller.abort();
  const p = ports(); const cancelled = await ciCli(['feedback', '--base', sha, '--json'], { ...p.dependencies, signal: controller.signal });
  assert.equal(cancelled.exitCode, 1); assert.equal(cancelled.report.complete, false);
  assert.ok(!p.calls.some(([kind]) => kind === 'quality'));
  let reads = 0;
  const changed = ports({ head: async () => reads++ === 0 ? sha : 'b'.repeat(40) });
  const r = await ciCli(['feedback', '--base', sha, '--json'], changed.dependencies);
  assert.equal(r.exitCode, 1); assert.equal(r.report.complete, false);
  assert.ok(r.report.receipts.some(row => row.reason === 'changed_head'));
});

test('CI feedback rejects other tiers unknown base and arbitrary options as JSON', async () => {
  for (const args of [['--tier', 'L0'], ['--tier', 'L2'], ['--tier', 'L3'], ['--base', 'HEAD'], ['--unknown']]) {
    const r = await ciCli(['feedback', '--base', sha, ...args, '--json'], ports().dependencies);
    assert.equal(r.exitCode, 1); assert.equal(r.report.status, 'blocked');
  }
  const r = await ciCli(['feedback', '--json']);
  assert.equal(r.exitCode, 1); assert.equal(r.report.reason, 'base_required');
});

test('CI graph rejects ASCII control paths and retains space and noncontrol boundaries', async () => {
  for (const code of [...Array.from({ length: 32 }, (_, i) => i), 127]) {
    const name = `src${String.fromCharCode(code)}name.mjs`;
    const p = ports({ planAffected: async () => ({ ...graph, changedFiles: [name] }) });
    const r = await ciCli(['plan', '--base', sha, '--json'], p.dependencies);
    assert.equal(r.exitCode, 1); assert.equal(r.report.reason, 'invalid_graph');
  }
  for (const code of [32, 126, 128]) {
    const name = `src${String.fromCharCode(code)}name.mjs`;
    const p = ports({ planAffected: async () => ({ ...graph, changedFiles: [name] }) });
    const r = await ciCli(['plan', '--base', sha, '--json'], p.dependencies);
    assert.equal(r.exitCode, 0);
  }
});

test('CI deleted and excluded files stay in graph but never enter quality source scope', async () => {
  const p = ports({ planAffected: async () => ({ ...graph, changedFiles: ['deleted.mjs', 'src.mjs', 'README.md'] }) });
  const r = await planCi({ project: root, tier: 'L0', baseSha: sha }, p.dependencies);
  assert.deepEqual(r.graph.changedFiles, ['deleted.mjs', 'src.mjs', 'README.md']);
  assert.deepEqual(r.qualityOptions.changedPaths, ['src.mjs']);
});

test('CI neutral quality scope remains explicit without claiming passed checks', async () => {
  const p = ports({ runQuality: async () => ({ status: 'skipped', receipts: [{ id: 'lint', status: 'skipped', reason: 'no_changed_or_affected_source' }] }) });
  const r = await runCi({ project: root, tier: 'L0', baseSha: sha }, p.dependencies);
  assert.equal(r.status, 'not_applicable'); assert.equal(r.complete, false);
  assert.equal(r.receipts[0].report.receipts[0].status, 'skipped');
});

test('CI missing tools disabled and skipped checks never become passed', async () => {
  for (const status of ['missing', 'disabled', 'skipped', 'unsupported', 'blocked', 'failed']) {
    const p = ports({ runQuality: async () => ({ status, receipts: [{ id: 'lint', status }] }) });
    const r = await runCi({ project: root, tier: 'L0', baseSha: sha }, p.dependencies);
    assert.notEqual(r.status, 'passed'); assert.equal(r.receipts[0].report.receipts[0].status, status);
  }
});

test('CI failed syntax and test exit codes block completion', async () => {
  for (const flag of ['--check', '--test']) {
    const p = ports({ execute: async (_command, args) => ({ code: args[0] === flag ? 7 : 0, stdout: '', stderr: '' }) });
    const r = await runCi({ project: root, tier: 'L1', baseSha: sha }, p.dependencies);
    assert.equal(r.status, 'failed'); assert.ok(r.receipts.some(row => row.exitCode === 7));
  }
});

test('CI L2 always runs full check and fresh security with platform scope', async () => {
  let securityCalls = 0;
  const p = ports({ security: async () => { securityCalls++; return { status: 'disabled', passed: null }; } });
  const r = await runCi({ project: root, tier: 'L2' }, p.dependencies);
  assert.ok(p.calls.some(([command, args]) => command === 'npm' && args.join(' ') === 'run check'));
  assert.equal(securityCalls, 1); assert.equal(r.status, 'blocked');
  assert.deepEqual(r.requiredPlatforms, ['linux', 'win32']); assert.equal(r.crossPlatformVerified, false);
});

test('CI L2 public diagnostic exposes a real failing npm assertion and retains private full output', async t => {
  const scratch = await mkdtemp(path.join(os.tmpdir(), 'kodo-ci-diagnostic-'));
  t.after(async () => { assert.equal(path.dirname(scratch), path.resolve(os.tmpdir())); await rm(scratch, { recursive: true, force: true }); });
  const project = path.join(scratch, 'project'); await mkdir(project);
  const git = args => execute('git', args, { cwd: project });
  await git(['init', '-q']); await git(['config', 'user.name', 'CI Fixture']); await git(['config', 'user.email', 'ci@example.invalid']);
  await writeFile(path.join(project, 'package.json'), JSON.stringify({ private: true, scripts: { check: 'node --test broken.test.mjs' } }));
  await writeFile(path.join(project, 'broken.test.mjs'), "import test from 'node:test'; import assert from 'node:assert/strict'; console.log('private-prefix-' + 'x'.repeat(9000)); test('diagnostic fixture assertion', () => assert.equal(1, 2));\n");
  await git(['add', '.']); await git(['commit', '-qm', 'fixture']);
  // A nested Node runner must not inherit the outer test worker context.
  const env = { ...process.env }; delete env.NODE_TEST_CONTEXT;
  const invocation = await execute(process.execPath, ['--input-type=module', '-e',
    `import { ciCli } from ${JSON.stringify(pathToFileURL(path.join(root, 'runtime/ci-cli.mjs')).href)}; const r = await ciCli(['run', '--tier', 'L2', '--project', ${JSON.stringify(project)}, '--json'], { security: async () => ({ status: 'passed', passed: true }) }); console.log(r.output); process.exitCode = r.exitCode;`],
  { cwd: project, env, allowFailure: true, timeoutMs: 20000 });
  const r = { exitCode: invocation.code, output: invocation.stdout, report: JSON.parse(invocation.stdout) };
  assert.equal(r.exitCode, 1); assert.equal(r.report.status, 'failed'); assert.equal(r.report.complete, false);
  const receipt = r.report.receipts.find(row => row.phase === 'fullcheck');
  assert.equal(receipt.status, 'failed'); assert.equal(receipt.exitCode, 1);
  assert.equal(JSON.parse(r.output).receipts[0].profilePath, receipt.profilePath);
  const raw = await readFile(path.join(path.dirname(receipt.profilePath), 'stdout.log'), 'utf8');
  assert.match(raw, /private-prefix-/); assert.match(raw, /diagnostic fixture assertion/); assert.match(raw, /AssertionError/);
  assert.ok(receipt.diagnostic, 'public command receipt must expose the failure');
  assert.match(receipt.diagnostic.stdoutTail, /diagnostic fixture assertion/);
  assert.match(receipt.diagnostic.stdoutTail, /AssertionError/);
  assert.doesNotMatch(r.output, /private-prefix-/);
  assert.ok(Buffer.byteLength(receipt.diagnostic.stdoutTail) <= 4096);
  assert.equal(receipt.diagnostic.stdoutTruncated, true);
  assert.equal(receipt.diagnostic.stderrTruncated, false);
});

test('CI failure diagnostics mask known secrets before byte tails and exclude environment and argv snapshots', async () => {
  const name = 'KODO_CI_DIAGNOSTIC_SECRET', previous = process.env[name];
  const secret = ['private', 'diagnostic', 'secret', 'value'].join('-');
  process.env[name] = secret;
  try {
    const result = { code: 8, stdout: `failure ${secret}`, stderr: 'p'.repeat(6000) + secret + 'z'.repeat(4090),
      env: { unexpected: 'environment-snapshot' }, args: ['argv-snapshot'] };
    for (const profile of [false, true]) {
      const p = ports({ execute: async () => result, runProfiledCommand: async () => ({ ...result, exitCode: result.code, profilePath: '/private/profile.json' }) });
      const r = await ciCli([profile ? 'profile' : 'run', '--tier', 'L2', '--json'], p.dependencies);
      assert.equal(r.exitCode, 1); assert.equal(r.report.complete, false);
      const diagnostic = r.report.receipts[0].diagnostic;
      assert.ok(diagnostic); assert.equal(diagnostic.stdoutTail, 'failure [REDACTED]');
      assert.doesNotMatch(diagnostic.stderrTail, /value/);
      assert.equal(diagnostic.stderrTruncated, true); assert.ok(Buffer.byteLength(diagnostic.stderrTail) <= 4096);
      assert.deepEqual(Object.keys(diagnostic).sort(), ['stderrTail', 'stderrTruncated', 'stdoutTail', 'stdoutTruncated']);
      for (const value of [secret, name, 'environment-snapshot', 'argv-snapshot']) assert.ok(!r.output.includes(value));
    }
  } finally { if (previous === undefined) delete process.env[name]; else process.env[name] = previous; }
});

test('CI public failure diagnostics merge original secret ranges through real profiler and injected execute', async t => {
  const secrets = {
    KODO_CI_FIRST_TOKEN: 'alpha-overlap', KODO_CI_SECOND_TOKEN: 'overlap-omega',
    KODO_CI_A_PREFIX_TOKEN: 'prefix-value', KODO_CI_Z_LONG_TOKEN: 'prefix-value-extended'
  };
  const previous = Object.fromEntries(Object.keys(secrets).map(name => [name, process.env[name]]));
  Object.assign(process.env, secrets);
  t.after(() => {
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
  });
  for (const route of ['real profiler', 'injected execute']) {
    for (const kind of ['crossing', 'prefix']) {
      for (const boundary of [false, true]) await t.test(`${route}: ${kind}${boundary ? ' at tail boundary' : ' repeated'}`, async t => {
        const value = kind === 'crossing' ? 'alpha-overlap-omega' : 'prefix-value-extended';
        const output = Object.fromEntries(['stdout', 'stderr'].map(stream => [stream, boundary
          ? 'private-prefix-' + 'p'.repeat(6000) + value + 'z'.repeat(4090)
          : `${stream}: ${value} / ${value}`]));
        const scratch = await mkdtemp(path.join(os.tmpdir(), 'kodo-ci-overlap-'));
        t.after(async () => { assert.equal(path.dirname(scratch), path.resolve(os.tmpdir())); await rm(scratch, { recursive: true, force: true }); });
        const project = path.join(scratch, 'project'); await mkdir(project);
        const git = args => execute('git', args, { cwd: project });
        await git(['init', '-q']); await git(['config', 'user.name', 'CI Fixture']); await git(['config', 'user.email', 'ci@example.invalid']);
        await writeFile(path.join(project, 'package.json'), JSON.stringify({ private: true, scripts: { check: 'node emit.mjs' } }));
        await writeFile(path.join(project, '.npmrc'), 'loglevel=silent\n');
        await writeFile(path.join(project, 'emit.mjs'), `
          import assert from 'node:assert/strict';
          for (const name of ${JSON.stringify(Object.keys(secrets))}) assert.equal(process.env[name], undefined);
          process.stdout.write(${JSON.stringify(output.stdout)});
          process.stderr.write(${JSON.stringify(output.stderr)});
          process.exitCode = 8;
        `);
        await git(['add', '.']); await git(['commit', '-qm', 'fixture']);
        let executions = 0;
        const dependencies = route === 'real profiler'
          ? { security: async () => ({ status: 'passed', passed: true }) }
          : ports({ execute: async (_command, _args, options) => {
            executions++;
            for (const name of Object.keys(secrets)) assert.equal(options.env[name], undefined);
            return { code: 8, ...output, env: { unexpected: 'environment-snapshot' }, args: ['argv-snapshot'] };
          } }).dependencies;
        const result = await ciCli(['run', '--tier', 'L2', '--project', project, '--json'], dependencies);
        const report = JSON.parse(result.output), receipt = report.receipts.find(row => row.phase === 'fullcheck');
        assert.equal(result.exitCode, 1); assert.equal(report.status, 'failed'); assert.equal(report.complete, false);
        assert.equal(receipt.status, 'failed'); assert.equal(receipt.exitCode, 8);
        if (route === 'real profiler') {
          assert.ok(receipt.profilePath);
          for (const stream of ['stdout', 'stderr']) {
            const raw = await readFile(path.join(path.dirname(receipt.profilePath), `${stream}.log`), 'utf8');
            const expected = boundary
              ? 'private-prefix-' + 'p'.repeat(6000) + '[REDACTED]' + 'z'.repeat(4090)
              : `${stream}: [REDACTED] / [REDACTED]`;
            assert.equal(raw, expected, 'private captures retain the complete nonsecret output');
            for (const hidden of [...Object.values(secrets), '-omega', '-extended']) assert.ok(!raw.includes(hidden));
          }
        } else assert.equal(executions, 1);
        const diagnostic = receipt.diagnostic;
        assert.ok(diagnostic);
        assert.deepEqual(Object.keys(diagnostic).sort(), ['stderrTail', 'stderrTruncated', 'stdoutTail', 'stdoutTruncated']);
        for (const stream of ['stdout', 'stderr']) {
          const expected = boundary ? 'ACTED]' + 'z'.repeat(4090) : `${stream}: [REDACTED] / [REDACTED]`;
          assert.equal(diagnostic[`${stream}Tail`], expected);
          assert.equal(diagnostic[`${stream}Truncated`], boundary);
          assert.ok(Buffer.byteLength(diagnostic[`${stream}Tail`]) <= 4096);
        }
        for (const hidden of [...Object.keys(secrets), ...Object.values(secrets), '-omega', '-extended', 'private-prefix-', 'environment-snapshot', 'argv-snapshot']) assert.ok(!result.output.includes(hidden));
        assert.equal(receipt.env, undefined); assert.equal(receipt.stdout, undefined); assert.equal(receipt.stderr, undefined);
      });
    }
  }
});

test('CI failure diagnostics preserve Unicode and finite per-stream byte boundaries', async () => {
  for (const length of [4095, 4096, 4097]) {
    const p = ports({ execute: async () => ({ code: 1, stdout: 'a'.repeat(length), stderr: 'b'.repeat(length) }) });
    const r = await runCi({ project: root, tier: 'L2' }, p.dependencies);
    const diagnostic = r.receipts[0].diagnostic;
    assert.ok(diagnostic);
    for (const stream of ['stdout', 'stderr']) {
      assert.equal(Buffer.byteLength(diagnostic[`${stream}Tail`]), Math.min(length, 4096));
      assert.equal(diagnostic[`${stream}Truncated`], length > 4096);
    }
  }
  const p = ports({ execute: async () => ({ code: 1, stdout: '🙂'.repeat(1500) + 'END', stderr: '界'.repeat(2000) + 'END' }) });
  const diagnostic = (await runCi({ project: root, tier: 'L2' }, p.dependencies)).receipts[0].diagnostic;
  for (const stream of ['stdout', 'stderr']) {
    const tail = diagnostic[`${stream}Tail`];
    assert.ok(Buffer.byteLength(tail) <= 4096); assert.ok(tail.endsWith('END'));
    assert.ok(tail.isWellFormed()); assert.ok(!tail.includes('\uFFFD'));
    assert.equal(diagnostic[`${stream}Truncated`], true);
  }
});

test('CI passing and incomplete processes omit diagnostics and preserve typed infrastructure failures', async () => {
  for (const profile of [false, true]) {
    for (const code of [0, null, -1, NaN]) {
      const p = ports({ execute: async () => ({ code, stdout: 'unpublished output', stderr: 'unpublished error' }),
        runProfiledCommand: async () => ({ exitCode: code, stdout: 'unpublished output', stderr: 'unpublished error', profilePath: '/private/profile.json' }) });
      const r = await ciCli([profile ? 'profile' : 'run', '--tier', 'L2', '--json'], p.dependencies);
      assert.equal(r.report.receipts[0].status, code === 0 ? 'passed' : 'blocked');
      assert.equal(r.report.receipts[0].diagnostic, undefined);
      assert.doesNotMatch(r.output, /unpublished/);
    }
    for (const code of ['timeout', 'cancelled', 'ENOENT']) {
      const throws = async () => { throw Object.assign(new Error('private infrastructure error'), { code, stderr: 'invented process stderr', profilePath: '/private/profile.json' }); };
      const p = ports({ execute: throws, runProfiledCommand: throws });
      const r = await ciCli([profile ? 'profile' : 'run', '--tier', 'L2', '--json'], p.dependencies);
      assert.equal(r.exitCode, 1); assert.equal(r.report.status, 'blocked'); assert.equal(r.report.complete, false);
      assert.equal(r.report.receipts[0].reason, code === 'ENOENT' ? 'command_error' : code);
      assert.equal(r.report.receipts[0].profilePath, '/private/profile.json');
      assert.equal(r.report.receipts[0].diagnostic, undefined); assert.doesNotMatch(r.output, /invented process stderr|private infrastructure error/);
    }
  }
});

test('CI profile L2 keeps one npm check without cascading reporter options', async () => {
  const previous = process.env.NODE_OPTIONS;
  delete process.env.NODE_OPTIONS;
  try {
    const observed = [];
    const p = ports({ runProfiledCommand: async options => { observed.push(options); return { exitCode: 0, durationMs: 1, stdout: '', stderr: '' }; } });
    const r = await ciCli(['profile', '--tier', 'L2', '--json'], p.dependencies);
    assert.equal(r.exitCode, 0);
    assert.equal(observed.length, 1); assert.equal(observed[0].command, 'npm');
    assert.deepEqual(observed[0].args, ['run', 'check']);
    assert.equal(observed[0].env.NODE_OPTIONS, undefined);
    assert.equal(process.env.NODE_OPTIONS, undefined);
  } finally {
    if (previous === undefined) delete process.env.NODE_OPTIONS; else process.env.NODE_OPTIONS = previous;
  }
});

test('CI L3 preserves installed package smoke command and exit status', async () => {
  const p = ports(); const r = await runCi({ project: root, tier: 'L3' }, p.dependencies);
  assert.equal(r.status, 'passed');
  assert.deepEqual(p.calls[0], [process.execPath, ['scripts/package-smoke.mjs']]);
  assert.equal(r.deploymentVerified, false);
});

test('CI changed head invalidates successful local commands', async () => {
  let reads = 0;
  const p = ports({ head: async () => reads++ === 0 ? sha : 'b'.repeat(40) });
  const r = await runCi({ project: root, tier: 'L3' }, p.dependencies);
  assert.equal(r.status, 'blocked'); assert.equal(r.complete, false);
  assert.equal(r.receipts.at(-1).reason, 'changed_head');
});

test('CI preaborted run launches no checks and returns cancelled', async () => {
  const controller = new AbortController(); controller.abort();
  const p = ports();
  const r = await ciCli(['run', '--tier', 'L3', '--json'], { ...p.dependencies, signal: controller.signal });
  assert.equal(r.exitCode, 1); assert.equal(p.calls.length, 0);
  assert.ok(r.report.receipts.some(row => row.reason === 'cancelled'));
});

test('CI profile uses profiler port and retains failed command receipt', async () => {
  const observed = [];
  const p = ports({ runProfiledCommand: async options => { observed.push(options); return { exitCode: 3, durationMs: 12, stdout: 'private output\n' + 'x'.repeat(5000) + '\nfailure detail', stderr: '', profilePath: '/private/profile.json' }; } });
  const r = await ciCli(['profile', '--tier', 'L3', '--project', root, '--json'], p.dependencies);
  assert.equal(r.exitCode, 1); assert.equal(observed[0].phase, 'package');
  assert.equal(r.report.receipts[0].profilePath, '/private/profile.json'); assert.doesNotMatch(r.output, /private output/);
  assert.match(r.report.receipts[0].diagnostic.stdoutTail, /failure detail/);
  assert.equal(r.report.receipts[0].diagnostic.stdoutTruncated, true);
});

test('CI profile supplies file URL and matching destinations to two real Node reporters', async t => {
  const scratch = await mkdtemp(path.join(os.tmpdir(), 'kodo-ci-reporters-'));
  t.after(() => rm(scratch, { recursive: true, force: true }));
  // Stage our own unmodified module with development assets, as it will appear
  // after integration. Other runtime modules are referenced, never copied.
  const staged = path.join(scratch, 'source space #');
  await mkdir(path.join(staged, 'runtime'), { recursive: true });
  await mkdir(path.join(staged, 'scripts'));
  await writeFile(path.join(staged, 'runtime/ci-cli.mjs'), await readFile(path.join(root, 'runtime/ci-cli.mjs')));
  for (const name of ['command', 'security']) await writeFile(path.join(staged, `runtime/${name}.mjs`), `export * from ${JSON.stringify(pathToFileURL(path.join(root, `runtime/${name}.mjs`)).href)};\n`);
  await writeFile(path.join(staged, 'scripts/ci-reporter.mjs'), "export default async function* reporter(source) { for await (const event of source) if (event.type === 'test:summary') yield JSON.stringify(event) + '\\n'; }\n");
  await writeFile(path.join(staged, 'dependent.test.mjs'), "import test from 'node:test'; import assert from 'node:assert/strict'; test('real reporter fixture', () => assert.equal(2 + 2, 4));\n");
  const { ciCli: stagedCli } = await import(pathToFileURL(path.join(staged, 'runtime/ci-cli.mjs')));
  let raw, invocation;
  const p = ports({ planAffected: async () => ({ ...graph, changedFiles: [], affectedFiles: ['dependent.test.mjs'], testFiles: ['dependent.test.mjs'] }),
    runProfiledCommand: async options => {
      invocation = options;
      const env = { ...options.env }; delete env.NODE_TEST_CONTEXT;
      raw = await execute(options.command, options.args, { cwd: options.cwd, env, allowFailure: true, timeoutMs: 20000 });
      return { exitCode: raw.code, durationMs: 1, stdout: raw.stdout, stderr: raw.stderr };
    } });
  const r = await stagedCli(['profile', '--tier', 'L1', '--base', sha, '--project', staged, '--json'], p.dependencies);
  assert.equal(r.exitCode, 0, raw?.stderr);
  assert.equal(raw.code, 0, raw.stderr);
  assert.match(raw.stdout, /ok 1 - real reporter fixture/);
  const events = raw.stdout.split(/\r?\n/).filter(line => line.startsWith('{')).map(line => JSON.parse(line));
  assert.ok(events.some(event => event.type === 'test:summary' && event.data.file && event.data.duration_ms >= 0));
  assert.equal(invocation.args.filter(arg => arg.startsWith('--test-reporter=')).length, 2);
  assert.deepEqual(invocation.args.filter(arg => arg.startsWith('--test-reporter-destination=')), ['--test-reporter-destination=stdout', '--test-reporter-destination=stdout']);
  const reporter = invocation.args.find(arg => arg.startsWith('--test-reporter=file:')).slice('--test-reporter='.length);
  assert.equal(fileURLToPath(reporter), path.join(staged, 'scripts/ci-reporter.mjs'));
});

test('CI rejects malformed graph and unsafe test paths before execution', async () => {
  for (const data of [{}, { ...graph, testFiles: ['--test-name-pattern=skip'] }, { ...graph, affectedFiles: ['../other.mjs'] }, { ...graph, testFiles: ['tests/absent.test.mjs'] }]) {
    const p = ports({ planAffected: async () => data });
    const r = await ciCli(['run', '--tier', 'L1', '--base', sha, '--json'], p.dependencies);
    assert.equal(r.exitCode, 1); assert.equal(p.calls.length, 0);
  }
});

test('CI accepts graph proven generic test directory files without a second naming heuristic', async () => {
  const p = ports({ planAffected: async () => ({ ...graph, affectedFiles: ['src.mjs', 'test/contract.js'], testFiles: ['test/contract.js'] }) });
  const r = await runCi({ project: root, tier: 'L1', baseSha: sha }, p.dependencies);
  assert.equal(r.status, 'passed');
  assert.ok(p.calls.some(([, args]) => Array.isArray(args) && args.includes('test/contract.js')));
});

test('CI registry dispatch returns JSON errors before credential state startup', async t => {
  const scratch = await mkdtemp(path.join(os.tmpdir(), 'kodo-ci-dispatch-'));
  t.after(() => rm(scratch, { recursive: true, force: true }));
  const home = path.join(scratch, 'absent');
  const r = await execute(process.execPath, [path.join(root, 'cli/index.mjs'), 'ci', 'plan', '--tier', 'bad', '--json'], { allowFailure: true, env: { ...process.env, KODO_HOME: home } });
  assert.notEqual(r.code, 0); assert.equal(JSON.parse(r.stdout).status, 'blocked'); assert.equal(r.stderr, '');
  await assert.rejects(access(home), { code: 'ENOENT' });
});

test('CI registry and script plan L2 offline without graph profiler or credential startup', async t => {
  const scratch = await mkdtemp(path.join(os.tmpdir(), 'kodo-ci-plan-'));
  t.after(() => rm(scratch, { recursive: true, force: true }));
  const home = path.join(scratch, 'absent');
  for (const [entry, prefix] of [['cli/index.mjs', ['ci']], ['scripts/ci.mjs', []]]) {
    const r = await execute(process.execPath, [path.join(root, entry), ...prefix, 'plan', '--tier', 'L2', '--project', root, '--json'], { allowFailure: true, env: { ...process.env, KODO_HOME: home } });
    assert.equal(r.code, 0, r.stderr); assert.equal(r.stderr, '');
    const report = JSON.parse(r.stdout);
    assert.equal(report.status, 'planned'); assert.deepEqual(report.commands[0].args, ['run', 'check']);
    assert.equal(report.security.required, true); assert.equal(report.crossPlatformVerified, false);
  }
  await assert.rejects(access(home), { code: 'ENOENT' });
});

test('CI workflow keeps required full platform contexts smoke lock cache and PR cancellation', async () => {
  const workflow = await readFile(path.join(root, '.github/workflows/ci.yml'), 'utf8');
  assert.match(workflow, /\n  check:\n/); assert.match(workflow, /os: \[ubuntu-latest, windows-latest\]/); assert.match(workflow, /node: \[24\]/);
  assert.match(workflow, /npm run check/); assert.match(workflow, /node scripts\/package-smoke.mjs/);
  assert.match(workflow, /cache: npm/); assert.match(workflow, /cache-dependency-path: package-lock.json/);
  assert.match(workflow, /cancel-in-progress:.*pull_request/); assert.match(workflow, /github\.run_id/);
  assert.match(workflow, /node scripts\/ci.mjs feedback --base/); assert.doesNotMatch(workflow, /continue-on-error: true/);
  const fast = workflow.split('\n  check:')[0];
  assert.doesNotMatch(fast, /npm run check|--mode standard|run --tier L1/);
  assert.match(fast, /node scripts\/ci.mjs feedback --json/);
  assert.match(workflow, /node scripts\/ci.mjs run --tier L2/);
});
