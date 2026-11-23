import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DEFAULT_FIXTURE,
  DEFAULT_RUNS,
  OVERHEAD_METHODOLOGY,
  STAGE_KEYS,
  formatTextReport,
  parseArgs,
  summarizeValues,
} from '../scripts/overhead-bench.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const script = path.join(root, 'scripts', 'overhead-bench.mjs');

test('overhead-bench argument parser and summary statistics follow contract', () => {
  assert.deepEqual(parseArgs([]), { runs: DEFAULT_RUNS, fixture: DEFAULT_FIXTURE, json: false, help: false });
  assert.deepEqual(parseArgs(['--runs', '1', '--json']), {
    runs: 1,
    fixture: 'button-color',
    json: true,
    help: false,
  });
  assert.deepEqual(parseArgs(['--runs=5', '--fixture=filename-extension']), {
    runs: 5,
    fixture: 'filename-extension',
    json: false,
    help: false,
  });
  assert.equal(parseArgs(['--help']).help, true);

  for (const invalid of [
    ['--runs', '0'],
    ['--runs', '-1'],
    ['--runs', '1.5'],
    ['--runs', '101'],
    ['--runs'],
    ['--fixture', 'unknown-fixture'],
    ['--json', '--json'],
    ['--unknown'],
  ])
    assert.throws(() => parseArgs(invalid), TypeError, JSON.stringify(invalid));

  assert.deepEqual(summarizeValues([30, 10, 20]), { median: 20, min: 10, max: 30, spread: 20, mean: 20 });
  assert.deepEqual(summarizeValues([10, 20, 30, 40]), { median: 25, min: 10, max: 40, spread: 30, mean: 25 });
  assert.deepEqual(summarizeValues([]), { median: null, min: null, max: null, spread: null, mean: null });
});

test(
  'overhead-bench --runs 1 --json produces a valid report with zero real provider calls and cleans temp dirs',
  { timeout: 120000 },
  async () => {
    const beforeTmp = new Set((await readdir(os.tmpdir())).filter(name => name.startsWith('kodo-overhead-')));

    const result = spawnSync(process.execPath, [script, '--runs', '1', '--json'], {
      cwd: root,
      encoding: 'utf8',
      windowsHide: true,
      timeout: 110000,
    });

    assert.equal(result.error, undefined, result.error?.message);
    assert.equal(result.status, 0, `stderr: ${result.stderr}\nstdout: ${result.stdout}`);

    const report = JSON.parse(result.stdout);
    assert.equal(report.schemaVersion, 1);
    assert.equal(report.kind, 'kodo-overhead-benchmark');
    assert.equal(report.methodology, OVERHEAD_METHODOLOGY);
    assert.deepEqual(report.options, {
      fixture: 'button-color',
      mode: 'quick',
      client: 'codex',
      model: 'gpt-6.1-sol',
      delivery: 'none',
      runs: 1,
    });

    assert.equal(report.realProviderCalls, 0);
    assert.equal(report.providerCalls.real, 0);
    assert.deepEqual(report.providerCalls.unexpected, {
      analyzeGemini: 0,
      decideJev: 0,
      research: 0,
      delivery: 0,
    });

    assert.equal(report.summary.runs, 1);
    assert.equal(report.summary.succeeded, 1);
    assert.equal(report.summary.allVerified, true);
    assert.ok(typeof report.summary.totalMs.median === 'number' && report.summary.totalMs.median > 0);
    assert.equal(report.summary.totalMs.spread, 0);
    assert.ok(report.summary.nativeSessions.median >= 2, 'at least worker and review sessions ran');

    for (const key of STAGE_KEYS) {
      const stat = report.summary.stagesMs[key];
      assert.ok(stat && typeof stat.median === 'number' && stat.median >= 0, `stage ${key} median`);
      assert.equal(stat.spread, 0, `stage ${key} spread for 1 run`);
    }
    assert.equal(report.summary.stagesMs.delivery.median, 0);

    assert.equal(report.runs.length, 1);
    const [trial] = report.runs;
    assert.equal(trial.state, 'succeeded');
    assert.equal(trial.executionMode.selected, 'quick');
    assert.equal(trial.delivery, 'none');
    assert.equal(trial.nativeSessions.count, report.summary.nativeSessions.median);
    assert.deepEqual(trial.verified, { correctnessPassed: true, scopePassed: true, scopeViolations: 0 });

    const eventTypes = new Set(trial.events.map(item => item.type));
    for (const required of [
      'created',
      'mode_selected',
      'analyzed',
      'routed',
      'integrated',
      'check_started',
      'succeeded',
    ])
      assert.ok(eventTypes.has(required), `missing event: ${required}`);

    assert.ok(Array.isArray(report.limitations) && report.limitations.length >= 2);
    const text = formatTextReport(report);
    assert.match(text, /реальных вызовов провайдеров: 0/);
    assert.match(text, /Доставка \(none\)/);

    const afterTmp = (await readdir(os.tmpdir())).filter(
      name => name.startsWith('kodo-overhead-') && !beforeTmp.has(name),
    );
    assert.deepEqual(afterTmp, [], 'all temporary benchmark directories must be removed');
  },
);
