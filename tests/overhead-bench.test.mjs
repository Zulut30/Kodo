import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { defaultFixtures } from '../runtime/benchmark-fixtures.mjs';
import * as overheadBench from '../scripts/overhead-bench.mjs';

const {
  DEFAULT_FIXTURE,
  DEFAULT_RUNS,
  OVERHEAD_METHODOLOGY,
  STAGE_KEYS,
  formatTextReport,
  parseArgs,
  runOverheadBenchmark,
  summarizeValues,
} = overheadBench;

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const script = path.join(root, 'scripts', 'overhead-bench.mjs');

function runGit(cwd, args, env = process.env) {
  const result = spawnSync('git', args, { cwd, env, encoding: 'utf8', windowsHide: true });
  assert.equal(result.status, 0, `${args.join(' ')}\n${result.stderr}`);
  return result.stdout.trim();
}

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

test('sanitizedGitEnv strips credentials and all GIT_* redirects', () => {
  assert.equal(typeof overheadBench.sanitizedGitEnv, 'function', 'sanitizedGitEnv must be exported');
  const cleaned = overheadBench.sanitizedGitEnv({
    PATH: process.env.PATH,
    GEMINI_API_KEY: 'fake-gemini',
    KODO_TYPESAFE_API_KEY: 'fake-jev',
    GITHUB_TOKEN: 'fake-gh',
    GIT_DIR: '/foreign/.git',
    GIT_WORK_TREE: '/foreign',
    GIT_CONFIG_GLOBAL: '/foreign/gitconfig',
    GIT_TEMPLATE_DIR: '/foreign/template',
    GIT_INDEX_FILE: '/foreign/index',
  });
  assert.equal(cleaned.GEMINI_API_KEY, undefined);
  assert.equal(cleaned.KODO_TYPESAFE_API_KEY, undefined);
  assert.equal(cleaned.GITHUB_TOKEN, undefined);
  assert.equal(cleaned.GIT_DIR, undefined);
  assert.equal(cleaned.GIT_WORK_TREE, undefined);
  assert.equal(cleaned.GIT_CONFIG_GLOBAL, undefined);
  assert.equal(cleaned.GIT_TEMPLATE_DIR, undefined);
  assert.equal(cleaned.GIT_INDEX_FILE, undefined);
  assert.equal(cleaned.GIT_CONFIG_NOSYSTEM, '1');
  assert.equal(cleaned.GIT_TERMINAL_PROMPT, '0');
  assert.equal(cleaned.PATH, process.env.PATH);
});

test('createInstantServices excludes synchronous request.onEvent work from providerCallback timing', async () => {
  assert.equal(typeof overheadBench.createInstantServices, 'function', 'createInstantServices must be exported');
  const fixture = defaultFixtures.find(item => item.id === 'button-color');
  const services = overheadBench.createInstantServices({ fixture, client: 'codex', model: 'gpt-6.1-sol' });
  await services.provider.runSession({
    schema: { properties: { tasks: {} } },
    onEvent: () => {
      const until = performance.now() + 25;
      while (performance.now() < until) {
        /* simulate synchronous Engine SQLite/progress.md write inside onEvent */
      }
    },
  });
  assert.equal(services.sessionCallbacks.length, 1);
  assert.ok(
    services.sessionCallbacks[0].durationMs < 15,
    `expected mock callback time < 15ms without onEvent, got ${services.sessionCallbacks[0].durationMs}ms`,
  );
});

test('createSandbox isolates KODO_TOOL_HOME and KODO_CODEX_CLIJS and restores them on cleanup', async () => {
  assert.equal(typeof overheadBench.createSandbox, 'function', 'createSandbox must be exported');
  const prevToolHome = process.env.KODO_TOOL_HOME;
  const prevCodexCli = process.env.KODO_CODEX_CLIJS;
  const hostTools = path.join(os.tmpdir(), 'host-user-tools-sentinel');
  process.env.KODO_TOOL_HOME = hostTools;
  process.env.KODO_CODEX_CLIJS = path.join(os.tmpdir(), 'host-codex-cli.js');
  try {
    const box = await overheadBench.createSandbox();
    try {
      assert.notEqual(process.env.KODO_TOOL_HOME, hostTools, 'sandbox must override host KODO_TOOL_HOME');
      assert.ok(
        path.resolve(process.env.KODO_TOOL_HOME).startsWith(path.resolve(box.directory) + path.sep),
        'KODO_TOOL_HOME must point inside the run sandbox directory',
      );
      assert.equal(process.env.KODO_CODEX_CLIJS, undefined, 'sandbox must unset KODO_CODEX_CLIJS');
    } finally {
      await box.cleanup();
    }
    assert.equal(process.env.KODO_TOOL_HOME, hostTools);
    assert.equal(process.env.KODO_CODEX_CLIJS, path.join(os.tmpdir(), 'host-codex-cli.js'));
  } finally {
    if (prevToolHome === undefined) delete process.env.KODO_TOOL_HOME;
    else process.env.KODO_TOOL_HOME = prevToolHome;
    if (prevCodexCli === undefined) delete process.env.KODO_CODEX_CLIJS;
    else process.env.KODO_CODEX_CLIJS = prevCodexCli;
  }
});

test('runOverheadBenchmark serializes overlapping calls so sandboxes never collide', async () => {
  let active = 0;
  let maxActive = 0;
  let calls = 0;
  const fakeTrial = async ({ runIndex }) => {
    active++;
    maxActive = Math.max(maxActive, active);
    calls++;
    await new Promise(resolve => setTimeout(resolve, 25));
    active--;
    return {
      run: runIndex,
      state: 'succeeded',
      executionMode: { selected: 'quick', source: 'explicit', requested: 'quick' },
      delivery: 'none',
      totalMs: 10,
      stagesMs: Object.fromEntries(STAGE_KEYS.map(key => [key, key === 'delivery' ? 0 : 1])),
      detailsMs: {
        createOnly: 1,
        modeAndIntegrationWorktree: 1,
        providerCallback: 0.5,
        engineExcludingMock: 9.5,
        fixtureSetup: 1,
        cleanup: 1,
      },
      nativeSessions: { count: 3, stages: ['plan', 'developer', 'review'], attempts: [] },
      verified: { correctnessPassed: true, scopePassed: true, scopeViolations: 0 },
      mockedCalls: {
        assessment: 1,
        discovery: 1,
        sessions: 3,
        byStage: { plan: 1, developer: 1, review: 1, other: 0 },
      },
      unexpectedCalls: { analyzeGemini: 0, decideJev: 0, research: 0, delivery: 0 },
      events: [],
    };
  };

  const [first, second] = await Promise.all([
    runOverheadBenchmark({ runs: 1 }, { runTrial: fakeTrial }),
    runOverheadBenchmark({ runs: 1 }, { runTrial: fakeTrial }),
  ]);
  assert.equal(calls, 2, 'both serialized runs must use the injected trial runner');
  assert.equal(maxActive, 1, 'overlapping runOverheadBenchmark calls must never interleave');
  assert.equal(first.summary.succeeded, 1);
  assert.equal(second.summary.succeeded, 1);
});

test('buildEventTimeline returns observed offsets and null for unobserved events', () => {
  const timeline = overheadBench.buildEventTimeline(
    [
      { seq: 1, type: 'created' },
      { seq: 2, type: 'mode_selected' },
      { seq: 3, type: 'unobserved_event' },
    ],
    [
      { type: 'created', at: 112.5 },
      { type: 'mode_selected', at: 150.25 },
    ],
    100,
  );
  assert.deepEqual(timeline, [
    { seq: 1, type: 'created', offsetMs: 12.5 },
    { seq: 2, type: 'mode_selected', offsetMs: 50.25 },
    { seq: 3, type: 'unobserved_event', offsetMs: null },
  ]);
});

test(
  'overhead-bench --runs 1 --json isolates env/temp/git-redirects, records real created offset, and cleans its temp root',
  { timeout: 120000 },
  async () => {
    const suiteRoot = await mkdtemp(path.join(os.tmpdir(), 'kodo-overhead-test-'));
    try {
      const childTemp = path.join(suiteRoot, 'child-temp');
      const foreignRepo = path.join(suiteRoot, 'foreign-repo');
      const hostTools = path.join(suiteRoot, 'host-tools');
      await mkdir(childTemp, { recursive: true });
      await mkdir(foreignRepo, { recursive: true });
      await mkdir(hostTools, { recursive: true });
      await writeFile(path.join(hostTools, 'sentinel.txt'), 'not-a-kodo-tool-home\n');

      // Separate Git repository whose GIT_DIR/GIT_WORK_TREE are injected into the child process
      // to verify environment.commit still reports Kodo's own HEAD and never inherits GIT_DIR.
      await writeFile(path.join(foreignRepo, 'README.md'), 'foreign repo\n');
      const cleanGitEnv = {
        ...process.env,
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_TERMINAL_PROMPT: '0',
      };
      delete cleanGitEnv.GIT_DIR;
      delete cleanGitEnv.GIT_WORK_TREE;
      runGit(foreignRepo, ['init', '-b', 'main'], cleanGitEnv);
      runGit(foreignRepo, ['config', 'user.name', 'Foreign'], cleanGitEnv);
      runGit(foreignRepo, ['config', 'user.email', 'foreign@example.invalid'], cleanGitEnv);
      runGit(foreignRepo, ['add', '.'], cleanGitEnv);
      runGit(foreignRepo, ['-c', 'commit.gpgsign=false', 'commit', '-m', 'Foreign commit'], cleanGitEnv);
      const foreignHead = runGit(foreignRepo, ['rev-parse', 'HEAD'], cleanGitEnv);
      const expectedRepoHead = runGit(root, ['rev-parse', 'HEAD'], cleanGitEnv);
      assert.notEqual(foreignHead, expectedRepoHead);

      const childEnv = {
        ...process.env,
        TMP: childTemp,
        TEMP: childTemp,
        TMPDIR: childTemp,
        KODO_TOOL_HOME: hostTools,
        GIT_DIR: path.join(foreignRepo, '.git'),
        GIT_WORK_TREE: foreignRepo,
        GEMINI_API_KEY: 'dummy-test-sentinel-value',
      };

      const result = spawnSync(process.execPath, [script, '--runs', '1', '--json'], {
        cwd: root,
        env: childEnv,
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
      assert.equal(report.environment.commit, expectedRepoHead, 'environment.commit must ignore inherited GIT_DIR');
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

      const createdEvent = trial.events.find(item => item.type === 'created');
      assert.ok(typeof createdEvent.offsetMs === 'number' && createdEvent.offsetMs >= 0);
      assert.ok(
        createdEvent.offsetMs < trial.detailsMs.createOnly,
        `created event (${createdEvent.offsetMs}ms) must be recorded before engine.create() returns (${trial.detailsMs.createOnly}ms)`,
      );

      assert.ok(Array.isArray(report.limitations) && report.limitations.length >= 2);
      const text = formatTextReport(report);
      assert.match(text, /реальных вызовов провайдеров: 0/);
      assert.match(text, /Доставка \(none\)/);

      // Dedicated child temp root must be completely empty after the benchmark finishes.
      const remaining = await readdir(childTemp);
      assert.deepEqual(remaining, [], 'all temporary benchmark directories must be removed');
    } finally {
      await rm(suiteRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  },
);
