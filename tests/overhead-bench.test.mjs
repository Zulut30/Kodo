import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { access, mkdir, mkdtemp, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { defaultFixtures } from '../runtime/benchmark-fixtures.mjs';
import { planSchema, resultSchema, reviewSchema } from '../runtime/contracts.mjs';
import * as overheadBench from '../scripts/overhead-bench.mjs';

const {
  DEFAULT_FIXTURE,
  DEFAULT_RUNS,
  OVERHEAD_METHODOLOGY,
  STAGE_KEYS,
  buildEventTimeline,
  buildTrialEnv,
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
  validateSessionSequence,
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

test('sanitizedGitEnv uses an allowlist and blocks secrets, GIT_EXEC_PATH, GIT_CONFIG_* and lowercase vars', async () => {
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
    GIT_EXEC_PATH: '/foreign/git-exec',
    git_exec_path: '/foreign/git-exec-lower',
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
    'git_exec_path',
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

test('buildTrialEnv isolates child git/node processes from SSH_PRIVATE_KEY, XDG_CONFIG_HOME and NODE_V8_COVERAGE', async () => {
  const box = await createSandbox();
  const coverageDir = await mkdtemp(path.join(await realpath(os.tmpdir()), 'kodo-overhead-cov-'));
  try {
    const poisonedParent = {
      ...process.env,
      SSH_PRIVATE_KEY: 'synthetic-ssh-key',
      XDG_CONFIG_HOME: path.join(box.directory, 'host-xdg-sentinel'),
      GEMINI_API_KEY: 'synthetic-gemini',
      NODE_V8_COVERAGE: coverageDir,
    };
    const trialEnv = buildTrialEnv(poisonedParent, box);
    assert.equal(trialEnv.SSH_PRIVATE_KEY, undefined);
    assert.equal(trialEnv.GEMINI_API_KEY, undefined);
    assert.equal(trialEnv.XDG_CONFIG_HOME, box.xdgConfigHome);
    assert.equal(trialEnv.XDG_DATA_HOME, box.xdgDataHome);
    assert.equal(trialEnv.XDG_CACHE_HOME, box.xdgCacheHome);
    assert.equal(trialEnv.KODO_HOME, box.stateDir);
    assert.equal(trialEnv.KODO_TOOL_HOME, box.toolsDir);
    assert.equal(
      trialEnv.NODE_V8_COVERAGE,
      '',
      'NODE_V8_COVERAGE must be explicitly empty to block Node auto-forwarding',
    );

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

    // Regression: launch a parent Node with NODE_V8_COVERAGE pointing to external coverageDir,
    // have it spawn a child Node using buildTrialEnv, and verify coverageDir is empty BEFORE
    // the parent exits (proving the child wrote zero coverage files outside the sandbox).
    const driverScript = path.join(box.directory, 'cov-driver.mjs');
    const benchUrl = pathToFileURL(script).href;
    await writeFile(
      driverScript,
      [
        "import { spawnSync } from 'node:child_process';",
        "import { readdirSync } from 'node:fs';",
        `import { buildTrialEnv } from ${JSON.stringify(benchUrl)};`,
        `const box = ${JSON.stringify({
          isolated: box.isolated,
          temp: box.temp,
          gitconfig: box.gitconfig,
          template: box.template,
          xdgConfigHome: box.xdgConfigHome,
          xdgDataHome: box.xdgDataHome,
          xdgCacheHome: box.xdgCacheHome,
          xdgStateHome: box.xdgStateHome,
          localAppData: box.localAppData,
          appData: box.appData,
          stateDir: box.stateDir,
          credentialsDir: box.credentialsDir,
          worktreesDir: box.worktreesDir,
          toolsDir: box.toolsDir,
        })};`,
        'const childEnv = buildTrialEnv(process.env, box);',
        'const child = spawnSync(process.execPath, ["-e", "process.exit(0)"], { env: childEnv, encoding: "utf8", windowsHide: true });',
        'if (child.status !== 0) process.exit(2);',
        `const files = readdirSync(${JSON.stringify(coverageDir)});`,
        'console.log(JSON.stringify({ childCovEnv: childEnv.NODE_V8_COVERAGE ?? null, files }));',
      ].join('\n'),
    );
    const parentRun = spawnSync(process.execPath, [driverScript], {
      cwd: box.directory,
      env: { ...process.env, NODE_V8_COVERAGE: coverageDir },
      encoding: 'utf8',
      windowsHide: true,
    });
    assert.equal(parentRun.status, 0, parentRun.stderr);
    const observed = JSON.parse(parentRun.stdout.trim());
    assert.deepEqual(observed, { childCovEnv: '', files: [] }, 'child Node must not write V8 coverage outside sandbox');
  } finally {
    await box.cleanup();
    await rm(coverageDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
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

test('createInstantServices validates full stage schemas and excludes onEvent work with deterministic clock', async () => {
  const fixture = defaultFixtures.find(item => item.id === 'button-color');
  let tick = 1000;
  const services = createInstantServices({
    fixture,
    client: 'codex',
    model: 'gpt-6.1-sol',
    now: () => tick,
  });
  await services.provider.runSession({
    schema: planSchema,
    onEvent: () => {
      tick += 500;
    },
  });
  assert.equal(services.sessionCallbacks.length, 1);
  assert.equal(services.sessionCallbacks[0].durationMs, 0, 'onEvent time must not be counted in providerCallback');

  // Negative schema cases: familiar property names with incompatible contracts MUST be rejected as unknownSession.
  const incompatibleSchemas = [
    // Plan-like property name only, missing required/summary/contract details
    { schema: { properties: { tasks: {} } }, prompt: 'Loose plan' },
    // Review with wrong `passed` type (`string` instead of `boolean`) and extra required field
    {
      schema: {
        ...reviewSchema,
        required: ['passed', 'findings', 'extraRequired'],
        properties: { ...reviewSchema.properties, passed: { type: 'string' }, extraRequired: { type: 'string' } },
      },
      prompt: 'Incompatible review',
    },
    // Unknown schema
    { schema: { properties: { unknownField: {} } }, prompt: 'Unknown request' },
    // Repair prompt with resultSchema
    { schema: resultSchema, prompt: 'Repair confirmed failures in task' },
  ];
  for (const request of incompatibleSchemas) {
    await assert.rejects(
      services.provider.runSession(request),
      /Unexpected or unknown session request/i,
      request.prompt,
    );
  }
  assert.equal(services.unexpectedCalls.unknownSession, incompatibleSchemas.length);
  assert.equal(services.mockedCalls.byStage.developer, 0);
  assert.equal(services.mockedCalls.byStage.review, 0);
});

test('validateSessionSequence verifies both 3-session cli route and 2-session fast-path route and catches mismatches', () => {
  assert.deepEqual(
    validateSessionSequence({
      planSource: 'cli',
      plannerSession: 'mock-session-1',
      planTasks: [{ role: 'developer' }],
      sessionAttempts: [{ stage: 'plan' }, { stage: 'developer' }, { stage: 'review' }],
      mockedSequence: ['plan', 'developer', 'review'],
    }),
    { ok: true, expected: ['plan', 'developer', 'review'], mismatchCount: 0 },
  );

  assert.deepEqual(
    validateSessionSequence({
      planSource: 'fast-path',
      plannerSession: undefined,
      planTasks: [{ role: 'developer' }],
      sessionAttempts: [{ stage: 'developer' }, { stage: 'review' }],
      mockedSequence: ['developer', 'review'],
    }),
    { ok: true, expected: ['developer', 'review'], mismatchCount: 0 },
  );

  const extraMocked = validateSessionSequence({
    planSource: 'cli',
    plannerSession: 'mock-session-1',
    planTasks: [{ role: 'developer' }],
    sessionAttempts: [{ stage: 'plan' }, { stage: 'developer' }, { stage: 'review' }],
    mockedSequence: ['plan', 'developer', 'developer', 'review'],
  });
  assert.equal(extraMocked.ok, false);
  assert.ok(extraMocked.mismatchCount >= 1);

  const unknownStage = validateSessionSequence({
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

test('hanging trial child is terminated on timeout, sandbox is removed and CLI exits 1', async () => {
  assert.equal(typeof overheadBench.spawnTrialChild, 'function', 'spawnTrialChild must be exported');
  const box = await createSandbox();
  const hangScript = path.join(box.directory, 'hang.mjs');
  const pidFile = path.join(box.directory, 'child.pid');
  await writeFile(
    hangScript,
    `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setInterval(() => {}, 60000);\n`,
  );
  const trialEnv = buildTrialEnv(process.env, box);
  let primaryError;
  try {
    await overheadBench.spawnTrialChild({
      box,
      env: trialEnv,
      payload: {},
      entryArgs: [hangScript],
      timeoutMs: 300,
      killGraceMs: 2000,
    });
  } catch (error) {
    primaryError = error;
  }
  assert.ok(primaryError, 'hanging child must reject on timeout');
  assert.match(primaryError.message, /timed out/i);

  let childPid = null;
  try {
    const raw = (await import('node:fs')).readFileSync(pidFile, 'utf8').trim();
    if (/^\d+$/.test(raw)) childPid = Number(raw);
  } catch {
    /* child may have been killed before writing pid */
  }
  if (childPid) {
    assert.throws(() => process.kill(childPid, 0), { code: 'ESRCH' }, 'timed-out trial child must be terminated');
  }

  await finalizeTrialResources({ store: null, cleanup: () => box.cleanup() });
  await assert.rejects(access(box.directory), { code: 'ENOENT' }, 'sandbox must be removed after timeout');

  const cliResult = await runCli(['--runs', '1'], {
    runBenchmark: async () => {
      throw primaryError;
    },
    writeOut: () => {},
    writeErr: () => {},
  });
  assert.equal(cliResult.exitCode, 1);
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
      assessmentMismatch: 0,
      discoveryMismatch: 0,
    },
    events: [],
    ...overrides,
  };
}

test('unexpected provider calls, repeated assessment/discovery and extra mocked sessions fail allVerified and exit 1', async () => {
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
            assessmentMismatch: 0,
            discoveryMismatch: 0,
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

  // Case 2: 4 mocked session calls vs 3 Engine attempts -> sessionMismatch -> exitCode 1
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

  // Case 3: repeated assessTask (2) and repeated discoverProviders (2) -> unexpected -> allVerified false, exitCode 1
  const repeatedCallsReport = await runOverheadBenchmark(
    { runs: 1 },
    {
      runTrial: async ({ runIndex }) =>
        stubTrial(runIndex, {
          mockedCalls: { assessment: 2, discovery: 2, sessions: 3, byStage: { plan: 1, developer: 1, review: 1 } },
        }),
    },
  );
  assert.equal(
    repeatedCallsReport.summary.allVerified,
    false,
    'repeated assessTask/discoverProviders must fail allVerified',
  );
  assert.equal(repeatedCallsReport.providerCalls.unexpected.assessmentMismatch, 1);
  assert.equal(repeatedCallsReport.providerCalls.unexpected.discoveryMismatch, 1);
  assert.match(formatTextReport(repeatedCallsReport), /assessmentMismatch=1/);
  assert.match(formatTextReport(repeatedCallsReport), /discoveryMismatch=1/);
  const repeatedCli = await runCli(['--runs', '1'], {
    runBenchmark: async () => repeatedCallsReport,
    writeOut: () => {},
  });
  assert.equal(repeatedCli.exitCode, 1);

  // Case 4: fast-path route expects 0 assessment calls (1 fails, 0 passes)
  const fastPathExtraAssessment = await runOverheadBenchmark(
    { runs: 1 },
    {
      runTrial: async ({ runIndex }) =>
        stubTrial(runIndex, {
          executionMode: { selected: 'quick', source: 'fast-path', requested: null },
          mockedCalls: { assessment: 1, discovery: 1, sessions: 2, byStage: { plan: 0, developer: 1, review: 1 } },
          nativeSessions: { count: 2, stages: ['developer', 'review'], attempts: [] },
        }),
    },
  );
  assert.equal(fastPathExtraAssessment.summary.allVerified, false);
  assert.equal(fastPathExtraAssessment.providerCalls.unexpected.assessmentMismatch, 1);

  const fastPathClean = await runOverheadBenchmark(
    { runs: 1 },
    {
      runTrial: async ({ runIndex }) =>
        stubTrial(runIndex, {
          executionMode: { selected: 'quick', source: 'fast-path', requested: null },
          mockedCalls: { assessment: 0, discovery: 1, sessions: 2, byStage: { plan: 0, developer: 1, review: 1 } },
          nativeSessions: { count: 2, stages: ['developer', 'review'], attempts: [] },
        }),
    },
  );
  assert.equal(fastPathClean.summary.allVerified, true);
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
        assessmentMismatch: 0,
        discoveryMismatch: 0,
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
