import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { access, mkdir, mkdtemp, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defaultFixtures } from '../runtime/benchmark-fixtures.mjs';
import * as overheadBench from '../scripts/overhead-bench.mjs';

const {
  DEFAULT_FIXTURE,
  DEFAULT_RUNS,
  OVERHEAD_METHODOLOGY,
  STAGE_KEYS,
  buildEventTimeline,
  createInstantServices,
  createSandbox,
  formatTextReport,
  parseArgs,
  runOverheadBenchmark,
  sanitizedGitEnv,
  summarizeValues,
} = overheadBench;

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const script = path.join(root, 'scripts', 'overhead-bench.mjs');
const nullDevice = process.platform === 'win32' ? 'NUL' : '/dev/null';

function runIsolatedGit(cwd, args, envOptions) {
  const env = sanitizedGitEnv(envOptions.baseEnv ?? process.env, envOptions);
  const hooksPath = envOptions.hooksDir ? envOptions.hooksDir.split(path.sep).join('/') : nullDevice;
  const result = spawnSync('git', ['-c', `core.hooksPath=${hooksPath}`, ...args], {
    cwd,
    env,
    encoding: 'utf8',
    windowsHide: true,
  });
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

test('sanitizedGitEnv uses an allowlist and blocks secrets, GIT_CONFIG_* and lowercase vars', () => {
  const poisoned = {
    Path: process.env.PATH || process.env.Path || '/usr/bin',
    SystemRoot: process.env.SystemRoot || 'C:\\Windows',
    SSH_PRIVATE_KEY: 'synthetic-ssh-key',
    ssh_private_key: 'synthetic-ssh-key-lower',
    GEMINI_API_KEY: 'synthetic-gemini',
    gemini_api_key: 'synthetic-gemini-lower',
    KODO_TYPESAFE_API_KEY: 'synthetic-jev',
    GITHUB_TOKEN: 'synthetic-gh',
    GIT_DIR: '/foreign/.git',
    git_dir: '/foreign/.git-lower',
    GIT_WORK_TREE: '/foreign',
    GIT_INDEX_FILE: '/foreign/index',
    git_index_file: '/foreign/index-lower',
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: 'http.extraHeader',
    GIT_CONFIG_VALUE_0: 'Authorization: Bearer synthetic-header',
    git_config_value_0: 'Authorization: Bearer synthetic-header-lower',
    GIT_CONFIG_GLOBAL: '/foreign/gitconfig',
    GIT_TEMPLATE_DIR: '/foreign/template',
    UNRELATED_CUSTOM_VAR: 'must-not-pass',
  };

  const cleaned = sanitizedGitEnv(poisoned, {
    home: '/sandbox/home',
    temp: '/sandbox/tmp',
    gitConfigGlobal: '/sandbox/gitconfig',
    platform: 'win32',
  });

  const keysLower = new Set(Object.keys(cleaned).map(key => key.toLowerCase()));
  for (const forbidden of [
    'ssh_private_key',
    'gemini_api_key',
    'kodo_typesafe_api_key',
    'github_token',
    'git_dir',
    'git_work_tree',
    'git_index_file',
    'git_config_count',
    'git_config_key_0',
    'git_config_value_0',
    'git_template_dir',
    'unrelated_custom_var',
  ])
    assert.ok(!keysLower.has(forbidden), `forbidden env var leaked: ${forbidden}`);

  assert.ok(keysLower.has('path'), 'Windows Path/PATH must be preserved case-insensitively');
  assert.equal(cleaned.HOME, '/sandbox/home');
  assert.equal(cleaned.USERPROFILE, '/sandbox/home');
  assert.equal(cleaned.TMP, '/sandbox/tmp');
  assert.equal(cleaned.TEMP, '/sandbox/tmp');
  assert.equal(cleaned.GIT_CONFIG_GLOBAL, '/sandbox/gitconfig');
  assert.equal(cleaned.GIT_CONFIG_NOSYSTEM, '1');
  assert.equal(cleaned.GIT_TERMINAL_PROMPT, '0');

  // Verify real git does not see injected GIT_CONFIG_VALUE_0 when invoked with sanitizedGitEnv.
  const gitCheck = spawnSync('git', ['-c', `core.hooksPath=${nullDevice}`, 'config', '--list'], {
    cwd: root,
    env: sanitizedGitEnv({ ...process.env, ...poisoned }),
    encoding: 'utf8',
    windowsHide: true,
  });
  assert.equal(gitCheck.status, 0, gitCheck.stderr);
  assert.doesNotMatch(gitCheck.stdout, /synthetic-header|extraheader/i);
});

test('repoCommit ignores broken user ~/.gitconfig', async () => {
  assert.equal(typeof overheadBench.repoCommit, 'function', 'repoCommit must be exported');
  const tmpParent = await realpath(os.tmpdir());
  const brokenHome = await mkdtemp(path.join(tmpParent, 'kodo-overhead-broken-git-'));
  try {
    await writeFile(path.join(brokenHome, '.gitconfig'), '[broken\n');
    const sha = overheadBench.repoCommit({
      env: { ...process.env, HOME: brokenHome, USERPROFILE: brokenHome },
    });
    assert.match(String(sha), /^[0-9a-f]{40}$/, 'repoCommit must return HEAD SHA even with broken ~/.gitconfig');
  } finally {
    await rm(brokenHome, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test('createInstantServices excludes synchronous request.onEvent work using deterministic clock', async () => {
  const fixture = defaultFixtures.find(item => item.id === 'button-color');
  let tick = 1000;
  const services = createInstantServices({
    fixture,
    client: 'codex',
    model: 'gpt-6.1-sol',
    now: () => tick,
  });
  await services.provider.runSession({
    schema: { properties: { tasks: {} } },
    onEvent: () => {
      // Advance deterministic clock only inside onEvent (no busy-wait).
      tick += 500;
    },
  });
  assert.equal(services.sessionCallbacks.length, 1);
  assert.equal(services.sessionCallbacks[0].durationMs, 0, 'onEvent time must not be counted in providerCallback');
});

test('createSandbox uses canonical realpath tmpdir, isolates KODO_TOOL_HOME/KODO_CODEX_CLIJS and restores env', async () => {
  const prevToolHome = process.env.KODO_TOOL_HOME;
  const prevCodexCli = process.env.KODO_CODEX_CLIJS;
  const hostTools = path.join(os.tmpdir(), 'host-user-tools-sentinel');
  process.env.KODO_TOOL_HOME = hostTools;
  process.env.KODO_CODEX_CLIJS = path.join(os.tmpdir(), 'host-codex-cli.js');
  try {
    const box = await createSandbox();
    try {
      assert.equal(box.directory, await realpath(box.directory), 'sandbox directory must be canonical realpath');
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

test('finalizeTrialResources runs cleanup even if store.close throws and preserves primary error', async () => {
  assert.equal(typeof overheadBench.finalizeTrialResources, 'function', 'finalizeTrialResources must be exported');

  // Case 1: store.close throws with no primary error -> cleanup still runs, close error propagates.
  let cleanedA = false;
  await assert.rejects(
    overheadBench.finalizeTrialResources({
      store: {
        close() {
          throw new Error('close boom');
        },
      },
      cleanup: async () => {
        cleanedA = true;
      },
    }),
    /close boom/,
  );
  assert.equal(cleanedA, true, 'cleanup must still execute when store.close throws');

  // Case 2: primary error present + both close and cleanup throw -> both run, primary error is preserved.
  let closedB = false;
  let cleanedB = false;
  const primary = new Error('primary trial error');
  await assert.rejects(
    overheadBench.finalizeTrialResources({
      store: {
        close() {
          closedB = true;
          throw new Error('secondary close error');
        },
      },
      cleanup: async () => {
        cleanedB = true;
        throw new Error('secondary cleanup error');
      },
      primaryError: primary,
    }),
    error => error === primary,
  );
  assert.equal(closedB, true);
  assert.equal(cleanedB, true);
});

function stubTrial(runIndex, overrides = {}) {
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
    mockedCalls: { assessment: 1, discovery: 1, sessions: 3, byStage: { plan: 1, developer: 1, review: 1 } },
    unexpectedCalls: { analyzeGemini: 0, decideJev: 0, research: 0, delivery: 0 },
    events: [],
    ...overrides,
  };
}

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
    return stubTrial(runIndex);
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

test('unexpected provider calls fail allVerified, appear in text report and yield CLI exitCode 1', async () => {
  const report = await runOverheadBenchmark(
    { runs: 1 },
    {
      runTrial: async ({ runIndex }) =>
        stubTrial(runIndex, {
          unexpectedCalls: { analyzeGemini: 0, decideJev: 1, research: 2, delivery: 0 },
        }),
    },
  );
  assert.equal(report.summary.allVerified, false, 'non-zero unexpected calls must invalidate allVerified');
  const text = formatTextReport(report);
  assert.match(text, /decideJev=1/, 'text report must surface non-zero unexpected decideJev calls');
  assert.match(text, /research=2/, 'text report must surface non-zero unexpected research calls');

  assert.equal(typeof overheadBench.runCli, 'function', 'runCli must be exported');
  const stdoutLines = [];
  const cliResult = await overheadBench.runCli(['--runs', '1', '--json'], {
    runBenchmark: async () => report,
    writeOut: line => stdoutLines.push(line),
  });
  assert.equal(cliResult.exitCode, 1, 'CLI must exit 1 when allVerified is false due to unexpected calls');
  assert.equal(JSON.parse(stdoutLines.join('\n')).summary.allVerified, false);
});

test('buildEventTimeline returns observed offsets and null for unobserved events', () => {
  const timeline = buildEventTimeline(
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
  'overhead-bench --runs 1 --json isolates env/temp/git-redirects, protects external GIT_INDEX_FILE, records real created offset, and cleans its temp root',
  { timeout: 120000 },
  async () => {
    const tmpParent = await realpath(os.tmpdir());
    const suiteRoot = await mkdtemp(path.join(tmpParent, 'kodo-overhead-test-'));
    try {
      const childTemp = path.join(suiteRoot, 'child-temp');
      const foreignRepo = path.join(suiteRoot, 'foreign-repo');
      const hostTools = path.join(suiteRoot, 'host-tools');
      const gitHome = path.join(suiteRoot, 'git-home');
      const emptyHooks = path.join(gitHome, 'hooks');
      const emptyTemplate = path.join(gitHome, 'template');
      const emptyGitConfig = path.join(gitHome, 'gitconfig');
      const externalIndexSentinel = path.join(suiteRoot, 'external-index-sentinel');

      await mkdir(childTemp, { recursive: true });
      await mkdir(foreignRepo, { recursive: true });
      await mkdir(hostTools, { recursive: true });
      await mkdir(emptyHooks, { recursive: true });
      await mkdir(emptyTemplate, { recursive: true });
      await writeFile(emptyGitConfig, '');
      await writeFile(path.join(hostTools, 'sentinel.txt'), 'not-a-kodo-tool-home\n');

      // Separate Git repository prepared with isolated env (even with external GIT_INDEX_FILE present
      // in baseEnv) so `git add .` can never touch externalIndexSentinel.
      await writeFile(path.join(foreignRepo, 'README.md'), 'foreign repo\n');
      const poisonedBaseEnv = {
        ...process.env,
        GIT_INDEX_FILE: externalIndexSentinel,
        GIT_DIR: path.join(suiteRoot, 'nonexistent-git-dir'),
        GIT_WORK_TREE: suiteRoot,
        SSH_PRIVATE_KEY: 'synthetic-ssh-key',
      };
      const gitEnvOptions = {
        baseEnv: poisonedBaseEnv,
        home: gitHome,
        temp: childTemp,
        gitConfigGlobal: emptyGitConfig,
        gitTemplateDir: emptyTemplate,
        hooksDir: emptyHooks,
      };
      runIsolatedGit(foreignRepo, ['init', '-b', 'main'], gitEnvOptions);
      runIsolatedGit(foreignRepo, ['config', 'user.name', 'Foreign'], gitEnvOptions);
      runIsolatedGit(foreignRepo, ['config', 'user.email', 'foreign@example.invalid'], gitEnvOptions);
      runIsolatedGit(foreignRepo, ['add', '.'], gitEnvOptions);
      runIsolatedGit(foreignRepo, ['-c', 'commit.gpgsign=false', 'commit', '-m', 'Foreign commit'], gitEnvOptions);
      await assert.rejects(
        access(externalIndexSentinel),
        { code: 'ENOENT' },
        'fixture git setup must never create or modify external GIT_INDEX_FILE',
      );

      const foreignHead = runIsolatedGit(foreignRepo, ['rev-parse', 'HEAD'], gitEnvOptions);
      const expectedRepoHead = runIsolatedGit(root, ['rev-parse', 'HEAD'], gitEnvOptions);
      assert.notEqual(foreignHead, expectedRepoHead);

      const childEnv = {
        ...process.env,
        TMP: childTemp,
        TEMP: childTemp,
        TMPDIR: childTemp,
        KODO_TOOL_HOME: hostTools,
        GIT_DIR: path.join(foreignRepo, '.git'),
        GIT_WORK_TREE: foreignRepo,
        GIT_INDEX_FILE: externalIndexSentinel,
        GIT_CONFIG_COUNT: '1',
        GIT_CONFIG_KEY_0: 'http.extraHeader',
        GIT_CONFIG_VALUE_0: 'Authorization: Bearer synthetic-header',
        SSH_PRIVATE_KEY: 'synthetic-ssh-key',
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
      await assert.rejects(
        access(externalIndexSentinel),
        { code: 'ENOENT' },
        'benchmark run must never create or modify external GIT_INDEX_FILE',
      );

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
      assert.deepEqual(Object.keys(report.summary.nativeSessions.byStage), ['plan', 'developer', 'review']);

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
