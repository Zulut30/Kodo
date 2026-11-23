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
  finalizeTrialResources,
  formatTextReport,
  parseArgs,
  repoCommit,
  runCli,
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
    ['--internal-trial'],
  ])
    assert.throws(() => parseArgs(invalid), TypeError, JSON.stringify(invalid));

  assert.deepEqual(summarizeValues([30, 10, 20]), { median: 20, min: 10, max: 30, spread: 20, mean: 20 });
  assert.deepEqual(summarizeValues([10, 20, 30, 40]), { median: 25, min: 10, max: 40, spread: 30, mean: 25 });
  assert.deepEqual(summarizeValues([]), { median: null, min: null, max: null, spread: null, mean: null });
});

test('sanitizedGitEnv uses an allowlist and blocks secrets, GIT_CONFIG_* and lowercase vars', async () => {
  const poisoned = {
    Path: process.env.PATH || process.env.Path || '/usr/bin',
    SystemRoot: process.env.SystemRoot || 'C:\\Windows',
    SSH_PRIVATE_KEY: 'synthetic-ssh-key',
    ssh_private_key: 'synthetic-ssh-key-lower',
    GEMINI_API_KEY: 'synthetic-gemini',
    gemini_api_key: 'synthetic-gemini-lower',
    KODO_TYPESAFE_API_KEY: 'synthetic-jev',
    GITHUB_TOKEN: 'synthetic-gh',
    XDG_CONFIG_HOME: '/foreign/xdg-config',
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
    'xdg_config_home',
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

  // Verify in an empty temporary repository using `git config --get` (never `--list` on Kodo checkout,
  // and never printing git config stdout on failure).
  const tmpParent = await realpath(os.tmpdir());
  const emptyRepo = await mkdtemp(path.join(tmpParent, 'kodo-overhead-gitconfig-'));
  try {
    const emptyConfig = path.join(emptyRepo, 'empty-gitconfig');
    const repoDir = path.join(emptyRepo, 'repo');
    await mkdir(repoDir);
    await writeFile(emptyConfig, '');
    const isolatedEnv = sanitizedGitEnv(
      { ...process.env, ...poisoned },
      { home: emptyRepo, temp: emptyRepo, gitConfigGlobal: emptyConfig },
    );
    const init = spawnSync('git', ['-c', `core.hooksPath=${nullDevice}`, 'init', '-b', 'main'], {
      cwd: repoDir,
      env: isolatedEnv,
      encoding: 'utf8',
      windowsHide: true,
    });
    assert.equal(init.status, 0);

    const probe = spawnSync('git', ['-c', `core.hooksPath=${nullDevice}`, 'config', '--get', 'http.extraHeader'], {
      cwd: repoDir,
      env: isolatedEnv,
      encoding: 'utf8',
      windowsHide: true,
    });
    assert.equal(probe.status, 1, 'injected http.extraHeader must not be visible to git');
    assert.equal(probe.stdout.length, 0, 'git config --get must return empty output for absent key');
  } finally {
    await rm(emptyRepo, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test('buildTrialEnv isolates child git processes from host SSH_PRIVATE_KEY and XDG_CONFIG_HOME', async () => {
  assert.equal(typeof overheadBench.buildTrialEnv, 'function', 'buildTrialEnv must be exported');
  const box = await createSandbox();
  try {
    const poisonedParent = {
      ...process.env,
      SSH_PRIVATE_KEY: 'synthetic-ssh-key',
      XDG_CONFIG_HOME: path.join(box.directory, 'host-xdg-sentinel'),
      GEMINI_API_KEY: 'synthetic-gemini',
    };
    const trialEnv = overheadBench.buildTrialEnv(poisonedParent, box);
    assert.equal(trialEnv.SSH_PRIVATE_KEY, undefined);
    assert.equal(trialEnv.GEMINI_API_KEY, undefined);
    assert.equal(trialEnv.XDG_CONFIG_HOME, box.xdgConfigHome);
    assert.equal(trialEnv.XDG_DATA_HOME, box.xdgDataHome);
    assert.equal(trialEnv.XDG_CACHE_HOME, box.xdgCacheHome);
    assert.equal(trialEnv.KODO_HOME, box.stateDir);
    assert.equal(trialEnv.KODO_TOOL_HOME, box.toolsDir);

    // Probe an actual `git` subprocess spawned with trialEnv via a tiny node alias.
    const probeScript = path.join(box.directory, 'probe-env.mjs');
    await writeFile(
      probeScript,
      'console.log(JSON.stringify({ ssh: process.env.SSH_PRIVATE_KEY ?? null, xdg: process.env.XDG_CONFIG_HOME ?? null }));\n',
    );
    const aliasCmd = `!"${process.execPath.replaceAll('\\', '/')}" "${probeScript.replaceAll('\\', '/')}"`;
    const gitProbe = spawnSync(
      'git',
      ['-c', `core.hooksPath=${nullDevice}`, '-c', `alias.envprobe=${aliasCmd}`, 'envprobe'],
      {
        cwd: box.directory,
        env: trialEnv,
        encoding: 'utf8',
        windowsHide: true,
      },
    );
    assert.equal(gitProbe.status, 0, gitProbe.stderr);
    assert.deepEqual(JSON.parse(gitProbe.stdout.trim()), {
      ssh: null,
      xdg: box.xdgConfigHome,
    });
  } finally {
    await box.cleanup();
  }
});

test('repoCommit ignores broken user ~/.gitconfig', async () => {
  const tmpParent = await realpath(os.tmpdir());
  const brokenHome = await mkdtemp(path.join(tmpParent, 'kodo-overhead-broken-git-'));
  try {
    await writeFile(path.join(brokenHome, '.gitconfig'), '[broken\n');
    const sha = repoCommit({
      env: { ...process.env, HOME: brokenHome, USERPROFILE: brokenHome },
    });
    assert.match(String(sha), /^[0-9a-f]{40}$/, 'repoCommit must return HEAD SHA even with broken ~/.gitconfig');
  } finally {
    await rm(brokenHome, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test('createInstantServices excludes onEvent work with deterministic clock and rejects unknown session requests', async () => {
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
      tick += 500;
    },
  });
  assert.equal(services.sessionCallbacks.length, 1);
  assert.equal(services.sessionCallbacks[0].durationMs, 0, 'onEvent time must not be counted in providerCallback');

  // Unknown schema and repair prompts must be flagged as unexpected, never classified as developer.
  await assert.rejects(
    services.provider.runSession({
      schema: { properties: { unknownField: {} } },
      prompt: 'Unknown request',
    }),
    /Unexpected or unknown session request/i,
  );
  await assert.rejects(
    services.provider.runSession({
      schema: { properties: { complete: {}, summary: {}, checks: {} } },
      prompt: 'Repair confirmed failures in task',
    }),
    /Unexpected or unknown session request/i,
  );
  assert.equal(services.unexpectedCalls.unknownSession, 2);
  assert.equal(services.mockedCalls.byStage.developer, 0);
});

test('validateSessionSequence verifies both 3-session cli route and 2-session fast-path route and catches mismatches', () => {
  assert.equal(typeof overheadBench.validateSessionSequence, 'function', 'validateSessionSequence must be exported');

  // Current 3-session route (plan -> developer -> review)
  assert.deepEqual(
    overheadBench.validateSessionSequence({
      planSource: 'cli',
      plannerSession: 'mock-session-1',
      planTasks: [{ role: 'developer' }],
      sessionAttempts: [{ stage: 'plan' }, { stage: 'developer' }, { stage: 'review' }],
      mockedSequence: ['plan', 'developer', 'review'],
    }),
    { ok: true, expected: ['plan', 'developer', 'review'], mismatchCount: 0 },
  );

  // Future 2-session fast-path route (local plan: developer -> review)
  assert.deepEqual(
    overheadBench.validateSessionSequence({
      planSource: 'fast-path',
      plannerSession: undefined,
      planTasks: [{ role: 'developer' }],
      sessionAttempts: [{ stage: 'developer' }, { stage: 'review' }],
      mockedSequence: ['developer', 'review'],
    }),
    { ok: true, expected: ['developer', 'review'], mismatchCount: 0 },
  );

  // Extra mocked call (4 mocked vs 3 attempts) must fail.
  const extraMocked = overheadBench.validateSessionSequence({
    planSource: 'cli',
    plannerSession: 'mock-session-1',
    planTasks: [{ role: 'developer' }],
    sessionAttempts: [{ stage: 'plan' }, { stage: 'developer' }, { stage: 'review' }],
    mockedSequence: ['plan', 'developer', 'developer', 'review'],
  });
  assert.equal(extraMocked.ok, false);
  assert.ok(extraMocked.mismatchCount >= 1);

  // Unknown stage must fail.
  const unknownStage = overheadBench.validateSessionSequence({
    planSource: 'fast-path',
    plannerSession: undefined,
    planTasks: [{ role: 'developer' }],
    sessionAttempts: [{ stage: 'developer' }, { stage: 'review' }],
    mockedSequence: ['unknown', 'review'],
  });
  assert.equal(unknownStage.ok, false);
  assert.ok(unknownStage.mismatchCount >= 1);
});

test('createSandbox uses canonical realpath tmpdir and does not mutate parent process.env', async () => {
  const beforeHome = process.env.HOME;
  const beforeKodoHome = process.env.KODO_HOME;
  const beforeToolHome = process.env.KODO_TOOL_HOME;
  const box = await createSandbox();
  try {
    assert.equal(box.directory, await realpath(box.directory), 'sandbox directory must be canonical realpath');
    assert.equal(process.env.HOME, beforeHome, 'createSandbox must not mutate parent HOME');
    assert.equal(process.env.KODO_HOME, beforeKodoHome, 'createSandbox must not mutate parent KODO_HOME');
    assert.equal(process.env.KODO_TOOL_HOME, beforeToolHome, 'createSandbox must not mutate parent KODO_TOOL_HOME');
    assert.ok(
      path.resolve(box.toolsDir).startsWith(path.resolve(box.directory) + path.sep),
      'toolsDir must live inside sandbox directory',
    );
  } finally {
    await box.cleanup();
  }
});

test('finalizeTrialResources runs cleanup even if store.close throws and preserves primary error', async () => {
  let cleanedA = false;
  await assert.rejects(
    finalizeTrialResources({
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

  let closedB = false;
  let cleanedB = false;
  const primary = new Error('primary trial error');
  await assert.rejects(
    finalizeTrialResources({
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
    unexpectedCalls: {
      analyzeGemini: 0,
      decideJev: 0,
      research: 0,
      delivery: 0,
      unknownSession: 0,
      sessionMismatch: 0,
    },
    events: [],
    ...overrides,
  };
}

test('unexpected provider calls and extra mocked sessions fail allVerified, appear in text report and yield CLI exitCode 1', async () => {
  // Case 1: unexpected decideJev / research calls
  const report = await runOverheadBenchmark(
    { runs: 1 },
    {
      runTrial: async ({ runIndex }) =>
        stubTrial(runIndex, {
          unexpectedCalls: {
            analyzeGemini: 0,
            decideJev: 1,
            research: 2,
            delivery: 0,
            unknownSession: 0,
            sessionMismatch: 0,
          },
        }),
    },
  );
  assert.equal(report.summary.allVerified, false, 'non-zero unexpected calls must invalidate allVerified');
  const text = formatTextReport(report);
  assert.match(text, /decideJev=1/);
  assert.match(text, /research=2/);

  const stdoutLines = [];
  const cliResult = await runCli(['--runs', '1', '--json'], {
    runBenchmark: async () => report,
    writeOut: line => stdoutLines.push(line),
  });
  assert.equal(cliResult.exitCode, 1, 'CLI must exit 1 when allVerified is false due to unexpected calls');
  assert.equal(JSON.parse(stdoutLines.join('\n')).summary.allVerified, false);

  // Case 2: 4 mocked session calls vs 3 Engine attempts -> must be detected as sessionMismatch -> exitCode 1
  const mismatchReport = await runOverheadBenchmark(
    { runs: 1 },
    {
      runTrial: async ({ runIndex }) =>
        stubTrial(runIndex, {
          mockedCalls: { assessment: 1, discovery: 1, sessions: 4, byStage: { plan: 1, developer: 2, review: 1 } },
          nativeSessions: { count: 3, stages: ['plan', 'developer', 'review'], attempts: [] },
        }),
    },
  );
  assert.equal(mismatchReport.summary.allVerified, false, '4 mocked calls vs 3 attempts must fail allVerified');
  assert.ok(mismatchReport.providerCalls.unexpected.sessionMismatch >= 1);
  assert.match(formatTextReport(mismatchReport), /sessionMismatch=/);
  const mismatchCli = await runCli(['--runs', '1'], {
    runBenchmark: async () => mismatchReport,
    writeOut: () => {},
  });
  assert.equal(mismatchCli.exitCode, 1);
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
  'overhead-bench --runs 1 --json isolates child process from host SSH_PRIVATE_KEY, XDG git/ignore, GIT_INDEX_FILE and cleans temp root',
  { timeout: 120000 },
  async () => {
    const tmpParent = await realpath(os.tmpdir());
    const suiteRoot = await mkdtemp(path.join(tmpParent, 'kodo-overhead-test-'));
    try {
      const childTemp = path.join(suiteRoot, 'child-temp');
      const foreignRepo = path.join(suiteRoot, 'foreign-repo');
      const hostTools = path.join(suiteRoot, 'host-tools');
      const hostXdgConfig = path.join(suiteRoot, 'host-xdg-config');
      const gitHome = path.join(suiteRoot, 'git-home');
      const emptyHooks = path.join(gitHome, 'hooks');
      const emptyTemplate = path.join(gitHome, 'template');
      const emptyGitConfig = path.join(gitHome, 'gitconfig');
      const externalIndexSentinel = path.join(suiteRoot, 'external-index-sentinel');

      await mkdir(childTemp, { recursive: true });
      await mkdir(foreignRepo, { recursive: true });
      await mkdir(hostTools, { recursive: true });
      await mkdir(path.join(hostXdgConfig, 'git'), { recursive: true });
      await mkdir(emptyHooks, { recursive: true });
      await mkdir(emptyTemplate, { recursive: true });
      await writeFile(emptyGitConfig, '');
      await writeFile(path.join(hostTools, 'sentinel.txt'), 'not-a-kodo-tool-home\n');
      // Poisoned XDG global git ignore that ignores the fixture implementation file!
      await writeFile(path.join(hostXdgConfig, 'git', 'ignore'), 'src/button.css\n');

      await writeFile(path.join(foreignRepo, 'README.md'), 'foreign repo\n');
      const poisonedBaseEnv = {
        ...process.env,
        GIT_INDEX_FILE: externalIndexSentinel,
        GIT_DIR: path.join(suiteRoot, 'nonexistent-git-dir'),
        GIT_WORK_TREE: suiteRoot,
        SSH_PRIVATE_KEY: 'synthetic-ssh-key',
        XDG_CONFIG_HOME: hostXdgConfig,
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
        XDG_CONFIG_HOME: hostXdgConfig,
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
        unknownSession: 0,
        sessionMismatch: 0,
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

      const remaining = await readdir(childTemp);
      assert.deepEqual(remaining, [], 'all temporary benchmark directories must be removed');
    } finally {
      await rm(suiteRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  },
);
