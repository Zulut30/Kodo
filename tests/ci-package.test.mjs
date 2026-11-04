import test from 'node:test';
import assert from 'node:assert/strict';
import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execute } from '../runtime/command.mjs';
import { workerEnvironment } from '../runtime/security.mjs';
import { runProfiledCommand } from '../runtime/ci-profiler.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));

test('Packed CI reporter loads by installed runtime file URL and observes one real passing test', async t => {
  const temporaryRoot = await realpath(os.tmpdir());
  const scratch = await mkdtemp(path.join(temporaryRoot, 'kodo-ci-package-'));
  t.after(async () => {
    const resolved = await realpath(scratch);
    assert.equal(path.dirname(resolved), temporaryRoot);
    assert.ok(path.basename(resolved).startsWith('kodo-ci-package-'));
    assert.equal((await lstat(scratch)).isSymbolicLink(), false);
    await rm(resolved, { recursive: true, force: true });
  });
  const env = workerEnvironment();
  // A nested node:test process must not inherit the parent runner's IPC mode.
  delete env.NODE_TEST_CONTEXT;
  const userConfig = path.join(scratch, 'npmrc');
  await writeFile(userConfig, '');
  const packed = await execute('npm', ['pack', '--offline', '--ignore-scripts', '--json',
    '--pack-destination', scratch, '--userconfig', userConfig, '--cache', path.join(scratch, 'npm-cache')],
  { cwd: root, env, timeoutMs: 60000 });
  const packages = JSON.parse(packed.stdout);
  assert.equal(packages.length, 1);
  const archiveName = packages[0].filename;
  assert.equal(path.basename(archiveName), archiveName);
  const installed = path.join(scratch, 'installed space #');
  await mkdir(installed);
  // This is our own trusted npm archive, extracted with the platform tar port.
  await execute('tar', ['-xzf', path.join(scratch, archiveName), '-C', installed], { cwd: scratch, env });
  const runtime = pathToFileURL(path.join(installed, 'package/runtime/ci-cli.mjs'));
  assert.equal((await lstat(runtime)).isFile(), true);
  const reporter = new URL('../scripts/ci-reporter.mjs', runtime);
  const project = path.join(scratch, 'project');
  await mkdir(project);
  const fixture = path.join(project, 'passing.test.mjs');
  await writeFile(fixture, "import test from 'node:test'; import assert from 'node:assert/strict'; test('packed reporter fixture', () => assert.equal(2 + 2, 4));\n");
  const result = await runProfiledCommand({ command: process.execPath,
    args: ['--test', `--test-reporter=${reporter.href}`, '--test-reporter-destination=stderr',
      '--test-reporter=tap', '--test-reporter-destination=stdout', fixture],
    cwd: project, env, evidenceDir: path.join(scratch, 'evidence'), timeoutMs: 20000, phase: 'package' });
  assert.equal(result.exitCode, 0, result.stderr);
  assert.equal((await lstat(reporter)).isFile(), true, 'runtime reporter must be a delivered file');
  assert.deepEqual(await readdir(new URL('./', reporter)), ['ci-reporter.mjs'], 'ship only the required script asset');
  assert.ok(!packages[0].files.some(file => /^(?:tests|prompts|\.cache|private)(?:\/|$)/.test(file.path)));
  assert.match(result.stdout, /ok 1 - packed reporter fixture/);
  assert.match(result.stdout, /# tests 1\b/);
  assert.match(result.stdout, /# pass 1\b/);
  assert.match(result.stdout, /# fail 0\b/);
  const events = result.stderr.trim().split(/\r?\n/).map(line => JSON.parse(line));
  assert.equal(events.length, 2, 'one file summary plus the overall summary');
  for (const event of events) {
    assert.equal(event.type, 'test:summary');
    assert.equal(event.data.success, true);
    assert.deepEqual(event.data.counts, { tests: 1, passed: 1, failed: 0, cancelled: 0, skipped: 0, todo: 0 });
    assert.ok(Number.isFinite(event.data.duration_ms) && event.data.duration_ms >= 0);
  }
  assert.equal(events.filter(event => event.data.file === fixture).length, 1);
  assert.equal(events.filter(event => event.data.file === undefined).length, 1);
  const profile = JSON.parse(await readFile(result.profilePath, 'utf8'));
  assert.equal(profile.exitCode, 0);
  assert.equal(profile.buckets.testFile.count, 1);
  assert.equal(profile.buckets.testFile.failures, 0);
  assert.equal(profile.tests.passed, 1);
  assert.equal(profile.tests.failed, 0);
});
