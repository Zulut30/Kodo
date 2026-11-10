import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import { parseBenchmarkArgs, benchmarkCli } from '../runtime/benchmark-cli.mjs';

test('Benchmark CLI parses selected native client models modes seed and repeats without provider calls', async () => {
  const parsed = parseBenchmarkArgs([
    'run',
    '--models',
    'gpt-6.1-sol,gpt-6-astra',
    '--client',
    'codex',
    '--mode',
    'deep',
    '--repeats',
    '2',
    '--seed',
    '42',
    '--output',
    path.join(os.tmpdir(), 'kb-cli'),
    '--json',
  ]);
  assert.deepEqual(parsed.options.models, ['gpt-6.1-sol', 'gpt-6-astra']);
  assert.equal(parsed.options.mode, 'deep');
  assert.equal(parsed.options.seed, 42);
  assert.equal(parsed.options.repeats, 2);
  let call;
  const result = await benchmarkCli(['report', process.cwd(), '--json'], {
    reportBenchmark: async value => {
      call = value;
      return { complete: false, trials: [] };
    },
  });
  assert.equal(call, process.cwd());
  assert.equal(JSON.parse(result.output).complete, false);
  assert.equal(result.exitCode, 0);
});

test('Benchmark CLI rejects invalid flags empty models invalid counts and conflicting positional arguments', () => {
  for (const args of [
    [],
    ['run'],
    ['run', '--models', 'a,,b'],
    ['run', '--models', 'a', '--repeats', '0'],
    ['run', '--models', 'a', '--seed', 'NaN'],
    ['run', '--models', 'a', '--mode', 'auto'],
    ['run', '--models', 'a', '--client', 'both'],
    ['report', 'a', 'b'],
    ['resume', 'a', '--models', 'b'],
    ['run', '--models', 'a', '--unknown'],
    ['run', '--models', 'a', '--models', 'b'],
  ])
    assert.throws(() => parseBenchmarkArgs(args));
});

test('Dedicated CLI entry rejects invalid invocation offline and fixture assets belong to the package', async () => {
  const result = spawnSync(
    process.execPath,
    [
      fileURLToPath(new URL('../runtime/benchmark-cli.mjs', import.meta.url)),
      'run',
      '--models',
      'test-model',
      '--mode',
      'auto',
    ],
    { encoding: 'utf8', windowsHide: true },
  );
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Invalid execution mode/);
  const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  assert.ok(pkg.files.includes('runtime'));
  const { defaultFixtures } = await import('../runtime/benchmark-fixtures.mjs');
  assert.deepEqual(
    defaultFixtures.map(item => item.id),
    ['button-color', 'filename-extension'],
  );
});
