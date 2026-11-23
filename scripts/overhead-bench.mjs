#!/usr/bin/env node
/**
 * Local reproducible benchmark of Kodo's own orchestration overhead on a small
 * `quick` task: real Engine, real Git worktrees, SQLite Store, evidence ACLs
 * and configured checks, with an instant deterministic mocked provider (0 ms,
 * zero real Codex/Claude/Gemini/Jev calls, zero network, zero API keys).
 */
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { defaultFixtures, evaluateFixture, materializeFixture } from '../runtime/benchmark-fixtures.mjs';
import { Engine } from '../runtime/engine.mjs';
import { workerEnvironment } from '../runtime/security.mjs';
import { Store } from '../runtime/store.mjs';

export const OVERHEAD_METHODOLOGY = 'local-engine-instant-provider-v1';
export const DEFAULT_RUNS = 3;
export const MAX_RUNS = 100;
export const DEFAULT_FIXTURE = 'button-color';
export const DEFAULT_CLIENT = 'codex';
export const DEFAULT_MODEL = 'gpt-6.1-sol';

export const STAGE_KEYS = Object.freeze([
  'createAndMode',
  'analysis',
  'plan',
  'worktree',
  'sessions',
  'integration',
  'checks',
  'review',
  'delivery',
  'finalize',
]);

const SANDBOX_PREFIX = 'kodo-overhead-';
const SANDBOX_ENV_KEYS = [
  'HOME',
  'USERPROFILE',
  'KODO_HOME',
  'KODO_CREDENTIAL_HOME',
  'KODO_WORKTREE_HOME',
  'KODO_TOOL_HOME',
  'KODO_CODEX_CLIJS',
  'GIT_CONFIG_NOSYSTEM',
  'GIT_CONFIG_GLOBAL',
  'GIT_TERMINAL_PROMPT',
  'TMP',
  'TEMP',
  'TMPDIR',
];
const GIT_REDIRECT_KEYS = [
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_INDEX_FILE',
  'GIT_OBJECT_DIRECTORY',
  'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_COMMON_DIR',
  'GIT_NAMESPACE',
  'GIT_CEILING_DIRECTORIES',
  'GIT_DISCOVERY_ACROSS_FILESYSTEM',
  'GIT_CONFIG',
  'GIT_CONFIG_SYSTEM',
  'GIT_CONFIG_PARAMETERS',
  'GIT_CONFIG_COUNT',
  'GIT_TEMPLATE_DIR',
];

const LIMITATIONS = Object.freeze([
  'Измеряет только локальные накладные расходы Kodo (Engine, Git worktree, SQLite, ACL evidence, проверки) при мгновенном подменённом провайдере.',
  'НЕ измеряет LLM-латентность, время запуска/ответа Codex/Claude/Gemini/Jev, расход квоты подписок и сетевые задержки.',
  'НЕ является сравнением Kodo с обычным native-клиентом; цифры зависят от текущей нагрузки CPU/диска и антивируса/ACL ОС.',
]);

const STAGE_LABELS = Object.freeze({
  createAndMode: 'Создание / оценка режима (+ integration worktree)',
  analysis: 'Анализ (локальный + evidence ACL)',
  plan: 'План (модели + планирование)',
  worktree: 'Worktree узла (routing + git worktree)',
  sessions: 'Сессия реализации (evidence + worker + commit)',
  integration: 'Интеграция (git merge --no-ff)',
  checks: 'Проверки (verify.cjs + behavior/gates)',
  review: 'Ревью (diff + evidence + review-сессия)',
  delivery: 'Доставка (none)',
  finalize: 'Финализация (policy + lesson + receipt)',
});

const roundMs = value => Math.round(value * 100) / 100;

/** @param {number[]} values */
export function summarizeValues(values) {
  const finite = values.filter(value => typeof value === 'number' && Number.isFinite(value));
  if (!finite.length) return { median: null, min: null, max: null, spread: null, mean: null };
  const sorted = [...finite].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const median = sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  const min = sorted[0];
  const max = sorted[sorted.length - 1];
  const mean = sorted.reduce((acc, item) => acc + item, 0) / sorted.length;
  return {
    median: roundMs(median),
    min: roundMs(min),
    max: roundMs(max),
    spread: roundMs(max - min),
    mean: roundMs(mean),
  };
}

/** @param {string[]} argv */
export function parseArgs(argv) {
  let runs = DEFAULT_RUNS;
  let fixture = DEFAULT_FIXTURE;
  let json = false;
  let help = false;
  const seen = new Set();
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === '--help' || arg === '-h') {
      help = true;
      continue;
    }
    if (arg === '--json') {
      if (seen.has('json')) throw new TypeError('Duplicate flag: --json');
      seen.add('json');
      json = true;
      continue;
    }
    if (arg === '--runs' || arg.startsWith('--runs=')) {
      if (seen.has('runs')) throw new TypeError('Duplicate flag: --runs');
      seen.add('runs');
      const raw = arg === '--runs' ? argv[++index] : arg.slice('--runs='.length);
      if (typeof raw !== 'string' || !/^[1-9]\d*$/.test(raw))
        throw new TypeError(`--runs must be an integer from 1 to ${MAX_RUNS}`);
      runs = Number(raw);
      if (!Number.isSafeInteger(runs) || runs < 1 || runs > MAX_RUNS)
        throw new TypeError(`--runs must be an integer from 1 to ${MAX_RUNS}`);
      continue;
    }
    if (arg === '--fixture' || arg.startsWith('--fixture=')) {
      if (seen.has('fixture')) throw new TypeError('Duplicate flag: --fixture');
      seen.add('fixture');
      const raw = arg === '--fixture' ? argv[++index] : arg.slice('--fixture='.length);
      if (!raw || !defaultFixtures.some(item => item.id === raw))
        throw new TypeError(`Unknown --fixture: ${raw ?? ''}. Available: ${defaultFixtures.map(f => f.id).join(', ')}`);
      fixture = raw;
      continue;
    }
    throw new TypeError(`Unknown argument: ${arg}`);
  }
  return { runs, fixture, json, help };
}

/**
 * Clean environment for helper `git` invocations: no credentials/keys and no
 * inherited GIT_* redirections or global/system config overrides.
 * @param {NodeJS.ProcessEnv} [base]
 */
export function sanitizedGitEnv(base = process.env) {
  const env = workerEnvironment(base);
  for (const key of [...GIT_REDIRECT_KEYS, 'GIT_CONFIG_GLOBAL']) delete env[key];
  env.GIT_CONFIG_NOSYSTEM = '1';
  env.GIT_TERMINAL_PROMPT = '0';
  return env;
}

function writeIsolatedGitConfig(file, { template, hooks }) {
  const env = sanitizedGitEnv();
  for (const [key, value] of [
    ['init.templateDir', template],
    ['core.hooksPath', hooks],
  ]) {
    const result = spawnSync('git', ['config', '--file', file, key, value.split(path.sep).join('/')], {
      env,
      encoding: 'utf8',
      windowsHide: true,
    });
    if (result.status !== 0) throw new Error(`Failed to write isolated git config: ${result.stderr}`);
  }
}

export async function createSandbox() {
  const parent = os.tmpdir();
  const directory = await mkdtemp(path.join(parent, SANDBOX_PREFIX));
  const previous = Object.fromEntries([...SANDBOX_ENV_KEYS, ...GIT_REDIRECT_KEYS].map(key => [key, process.env[key]]));
  const root = path.join(directory, 'repo');
  const stateDir = path.join(directory, 'state');
  const toolsDir = path.join(directory, 'tools');
  const isolated = path.join(directory, 'empty-home');
  const temp = path.join(directory, 'tmp');
  const template = path.join(isolated, 'git-template');
  const hooks = path.join(isolated, 'git-hooks');
  const gitconfig = path.join(isolated, 'gitconfig');

  const restoreEnv = () => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };

  try {
    await mkdir(root);
    await mkdir(toolsDir);
    await mkdir(isolated);
    await mkdir(temp);
    await mkdir(template);
    await mkdir(hooks);
    await writeFile(gitconfig, '');
    writeIsolatedGitConfig(gitconfig, { template, hooks });
    for (const key of GIT_REDIRECT_KEYS) delete process.env[key];
    delete process.env.KODO_CODEX_CLIJS;
    Object.assign(process.env, {
      TMP: temp,
      TEMP: temp,
      TMPDIR: temp,
      GIT_TEMPLATE_DIR: template,
      HOME: isolated,
      USERPROFILE: isolated,
      KODO_HOME: stateDir,
      KODO_CREDENTIAL_HOME: path.join(isolated, 'empty-credentials'),
      KODO_WORKTREE_HOME: path.join(directory, 'worktrees'),
      KODO_TOOL_HOME: toolsDir,
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: gitconfig,
      GIT_TERMINAL_PROMPT: '0',
    });
  } catch (error) {
    restoreEnv();
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }).catch(() => {});
    throw error;
  }

  return {
    directory,
    root,
    stateDir,
    toolsDir,
    async cleanup() {
      restoreEnv();
      if (
        path.dirname(path.resolve(directory)) !== path.resolve(parent) ||
        !path.basename(directory).startsWith(SANDBOX_PREFIX)
      )
        throw new Error('Refusing to remove directory outside overhead benchmark temp root');
      await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    },
  };
}

async function applyFixtureSolution(fixtureId, cwd) {
  if (fixtureId === 'button-color') {
    const file = path.join(cwd, 'src/button.css');
    const content = await readFile(file, 'utf8');
    await writeFile(file, content.replace('background-color: #2563eb;', 'background-color: #7c3aed;'));
    return;
  }
  if (fixtureId === 'filename-extension') {
    const file = path.join(cwd, 'src/extension.cjs');
    const source = [
      'function extension(filename) {',
      "  const base = String(filename).split(/[\\\\/]/).pop() || '';",
      "  const dot = base.lastIndexOf('.');",
      "  if (dot <= 0 || dot === base.length - 1) return '';",
      '  return base.slice(dot + 1).toLowerCase();',
      '}',
      'module.exports = { extension };',
      '',
    ].join('\n');
    await writeFile(file, source);
    return;
  }
  throw new Error(`No deterministic solution configured for fixture: ${fixtureId}`);
}

export function createInstantServices({ fixture, client, model }) {
  const mockedCalls = {
    assessment: 0,
    discovery: 0,
    sessions: 0,
    byStage: { plan: 0, developer: 0, review: 0, other: 0 },
  };
  const unexpectedCalls = { analyzeGemini: 0, decideJev: 0, research: 0, delivery: 0 };
  /** @type {Array<{ stage: string, durationMs: number }>} */
  const sessionCallbacks = [];
  let sequence = 0;

  const provider = {
    assessTask: async () => {
      mockedCalls.assessment++;
      return { fallback: true, code: 'unavailable' };
    },
    discoverProviders: async () => {
      mockedCalls.discovery++;
      return [{ id: `${client}-${model}`, client, model, available: true }];
    },
    analyzeGemini: async () => {
      unexpectedCalls.analyzeGemini++;
      throw new Error('Unexpected analyzeGemini call in quick overhead benchmark');
    },
    decideJev: async () => {
      unexpectedCalls.decideJev++;
      throw new Error('Unexpected decideJev call in quick overhead benchmark');
    },
    runSession: async request => {
      const sessionId = `mock-session-${++sequence}`;
      const isPlan = Boolean(request.schema?.properties?.tasks);
      const isReview = Boolean(request.schema?.properties?.passed);
      const stage = isPlan ? 'plan' : isReview ? 'review' : 'developer';
      mockedCalls.sessions++;
      mockedCalls.byStage[stage]++;
      // Keep Engine's synchronous onEvent (SQLite + progress.md persistence) outside
      // the mock-work timer so engineExcludingMock never subtracts Kodo's own work.
      request.onEvent?.({ sessionId, stage });

      const started = performance.now();
      let output;
      if (isPlan) {
        output = {
          summary: `Implement ${fixture.id}`,
          tasks: [
            {
              id: 'implement',
              role: 'developer',
              description: `Apply deterministic fix for ${fixture.id}.`,
              writePaths: [fixture.implementation],
              dependsOn: [],
              acceptance: ['node verify.cjs passes and only the implementation file changes'],
              parallel: false,
            },
          ],
        };
      } else if (isReview) {
        output = { passed: true, findings: [] };
      } else {
        await applyFixtureSolution(fixture.id, request.cwd);
        output = { complete: true, summary: `Updated ${fixture.implementation}`, checks: ['node verify.cjs'] };
      }
      sessionCallbacks.push({ stage, durationMs: performance.now() - started });
      return { sessionId, output };
    },
  };

  const researcher = async () => {
    unexpectedCalls.research++;
    throw new Error('Unexpected researcher call in quick overhead benchmark');
  };

  const forbidDelivery = async () => {
    unexpectedCalls.delivery++;
    throw new Error('Unexpected delivery call when delivery=none');
  };

  const delivery = {
    deliver: forbidDelivery,
    releasePackage: forbidDelivery,
    prepareReleaseVersion: forbidDelivery,
    reconcileDelivery: forbidDelivery,
  };

  return { mockedCalls, unexpectedCalls, sessionCallbacks, provider, researcher, delivery };
}

function attachRunObserver(store) {
  /** @type {Record<string, number | null>} */
  const marks = {
    start: null,
    createdEvent: null,
    created: null,
    modeSelected: null,
    analyzed: null,
    planned: null,
    routed: null,
    nodeWorktreeReady: null,
    nodeCompleted: null,
    integrated: null,
    checkStarted: null,
    reviewStarted: null,
    succeeded: null,
    finished: null,
  };
  /** @type {Array<{ type: string, at: number }>} */
  const observedEvents = [];

  const originalUpdateRun = store.updateRun.bind(store);
  store.updateRun = (id, patch, options) => {
    const updated = originalUpdateRun(id, patch, options);
    const now = performance.now();
    if (marks.planned === null && patch?.plan) marks.planned = now;
    if (patch?.nodes && typeof patch.nodes === 'object') {
      const nodes = Object.values(patch.nodes);
      if (marks.nodeWorktreeReady === null && nodes.some(node => node?.status === 'running'))
        marks.nodeWorktreeReady = now;
      if (marks.nodeCompleted === null && nodes.some(node => node?.status === 'completed')) marks.nodeCompleted = now;
    }
    if (marks.reviewStarted === null && patch?.state === 'reviewing') marks.reviewStarted = now;
    return updated;
  };

  const originalEvent = store.event.bind(store);
  store.event = (runId, type, data) => {
    const now = performance.now();
    const written = originalEvent(runId, type, data);
    observedEvents.push({ type, at: now });
    if (type === 'created' && marks.createdEvent === null) marks.createdEvent = now;
    if (type === 'mode_selected' && marks.modeSelected === null) marks.modeSelected = now;
    if (type === 'analyzed' && marks.analyzed === null) marks.analyzed = now;
    if (type === 'routed' && marks.routed === null) marks.routed = now;
    if (type === 'integrated' && marks.integrated === null) marks.integrated = now;
    if (type === 'check_started' && marks.checkStarted === null) marks.checkStarted = now;
    if (type === 'succeeded' && marks.succeeded === null) marks.succeeded = now;
    return written;
  };

  return { marks, observedEvents };
}

/**
 * Map persisted SQLite events to their observed high-resolution offsets.
 * Unobserved events stay `null` rather than substituting another timestamp.
 * @param {Array<{ seq: number, type: string }>} storedEvents
 * @param {Array<{ type: string, at: number }>} observedEvents
 * @param {number | null} startMs
 */
export function buildEventTimeline(storedEvents, observedEvents, startMs) {
  const eventOffsetMap = new Map();
  if (typeof startMs === 'number') {
    for (const item of observedEvents) {
      const list = eventOffsetMap.get(item.type) || [];
      list.push(roundMs(Math.max(0, item.at - startMs)));
      eventOffsetMap.set(item.type, list);
    }
  }
  const consumed = new Map();
  return storedEvents.map(row => {
    const index = consumed.get(row.type) || 0;
    consumed.set(row.type, index + 1);
    const offsets = eventOffsetMap.get(row.type) || [];
    return {
      seq: row.seq,
      type: row.type,
      offsetMs: offsets[index] ?? null,
    };
  });
}

const spanMs = (from, to) =>
  typeof from === 'number' && typeof to === 'number' ? roundMs(Math.max(0, to - from)) : null;

function buildStagesMs(marks) {
  return {
    createAndMode: spanMs(marks.start, marks.modeSelected),
    analysis: spanMs(marks.modeSelected, marks.analyzed),
    plan: spanMs(marks.analyzed, marks.planned),
    worktree: spanMs(marks.planned, marks.nodeWorktreeReady),
    sessions: spanMs(marks.nodeWorktreeReady, marks.nodeCompleted),
    integration: spanMs(marks.nodeCompleted, marks.integrated),
    checks: spanMs(marks.integrated, marks.reviewStarted),
    review: spanMs(marks.reviewStarted, marks.succeeded),
    delivery: 0,
    finalize: spanMs(marks.succeeded, marks.finished),
  };
}

async function executeTrial({ runIndex, fixture, client, model }) {
  const box = await createSandbox();
  /** @type {Store | null} */
  let store = null;
  let cleanupMs = 0;
  let report;

  try {
    const setupStart = performance.now();
    const materialized = await materializeFixture({
      directory: box.root,
      fixture,
      client,
      model,
      mode: 'quick',
    });
    const fixtureSetupMs = roundMs(performance.now() - setupStart);

    store = new Store(box.stateDir, {});
    const { marks, observedEvents } = attachRunObserver(store);
    const services = createInstantServices({ fixture, client, model });
    const engine = new Engine(
      /** @type {any} */ ({
        store,
        secrets: {},
        provider: services.provider,
        researcher: services.researcher,
        delivery: services.delivery,
      }),
    );

    marks.start = performance.now();
    const created = await engine.create(fixture.prompt, {
      project: box.root,
      client,
      model,
      mode: 'quick',
      providers: 'current',
      delivery: 'none',
    });
    marks.created = performance.now();
    const result = await engine.run(created.id);
    marks.finished = performance.now();

    /** @type {Array<{ seq: number, type: string, time: number, data: any }>} */
    const storedEvents = /** @type {any} */ (store.events(created.id));
    const verification = await evaluateFixture({
      fixture,
      cwd: result.cwd,
      baseline: materialized.baseline,
    });

    store.close();
    store = null;

    const totalMs = spanMs(marks.start, marks.finished);
    const stagesMs = buildStagesMs(marks);
    const providerCallbackMs = roundMs(services.sessionCallbacks.reduce((sum, item) => sum + item.durationMs, 0));
    const events = buildEventTimeline(storedEvents, observedEvents, marks.start);

    const attempts = (result.sessionAttempts || []).map(item => ({
      stage: item.stage,
      status: item.status,
      durationMs: typeof item.metrics?.durationMs === 'number' ? roundMs(item.metrics.durationMs) : null,
      promptBytes: item.metrics?.promptBytes ?? null,
    }));

    report = {
      run: runIndex,
      state: result.state,
      executionMode: {
        selected: result.executionMode?.selected ?? null,
        source: result.executionMode?.source ?? null,
        requested: result.executionMode?.requested ?? null,
      },
      delivery: 'none',
      totalMs,
      stagesMs,
      detailsMs: {
        createOnly: spanMs(marks.start, marks.created),
        modeAndIntegrationWorktree: spanMs(marks.created, marks.modeSelected),
        providerCallback: providerCallbackMs,
        engineExcludingMock: totalMs !== null ? roundMs(Math.max(0, totalMs - providerCallbackMs)) : null,
        fixtureSetup: fixtureSetupMs,
        cleanup: 0,
      },
      nativeSessions: {
        count: attempts.length,
        stages: attempts.map(item => item.stage),
        attempts,
      },
      verified: {
        correctnessPassed: verification.correctness.passed === true,
        scopePassed: verification.scope.passed === true,
        scopeViolations: verification.scope.violations,
      },
      mockedCalls: services.mockedCalls,
      unexpectedCalls: services.unexpectedCalls,
      events,
    };
  } finally {
    if (store) store.close();
    const cleanupStart = performance.now();
    await box.cleanup();
    cleanupMs = roundMs(performance.now() - cleanupStart);
  }

  report.detailsMs.cleanup = cleanupMs;
  return report;
}

function repoCommit() {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const result = spawnSync('git', ['rev-parse', 'HEAD'], {
    cwd: root,
    env: sanitizedGitEnv(),
    encoding: 'utf8',
    windowsHide: true,
  });
  return result.status === 0 ? result.stdout.trim() : null;
}

let benchmarkQueue = Promise.resolve();

async function runOverheadBenchmarkSerial({ runs, fixture, client, model, runTrial }) {
  const results = [];
  for (let index = 1; index <= runs; index++) {
    results.push(await runTrial({ runIndex: index, fixture, client, model }));
  }

  const stagesSummary = Object.fromEntries(
    STAGE_KEYS.map(key => [key, summarizeValues(results.map(item => item.stagesMs[key]))]),
  );
  const detailsSummary = Object.fromEntries(
    [
      'createOnly',
      'modeAndIntegrationWorktree',
      'providerCallback',
      'engineExcludingMock',
      'fixtureSetup',
      'cleanup',
    ].map(key => [key, summarizeValues(results.map(item => item.detailsMs[key]))]),
  );
  const sessionCounts = summarizeValues(results.map(item => item.nativeSessions.count));
  const byStageSummary = Object.fromEntries(
    ['plan', 'developer', 'review', 'other'].map(stage => [
      stage,
      summarizeValues(results.map(item => item.mockedCalls.byStage[stage])),
    ]),
  );

  const unexpectedTotals = {
    analyzeGemini: results.reduce((sum, item) => sum + item.unexpectedCalls.analyzeGemini, 0),
    decideJev: results.reduce((sum, item) => sum + item.unexpectedCalls.decideJev, 0),
    research: results.reduce((sum, item) => sum + item.unexpectedCalls.research, 0),
    delivery: results.reduce((sum, item) => sum + item.unexpectedCalls.delivery, 0),
  };
  const mockedTotals = {
    assessment: results.reduce((sum, item) => sum + item.mockedCalls.assessment, 0),
    discovery: results.reduce((sum, item) => sum + item.mockedCalls.discovery, 0),
    sessions: results.reduce((sum, item) => sum + item.mockedCalls.sessions, 0),
  };

  return {
    schemaVersion: 1,
    kind: 'kodo-overhead-benchmark',
    methodology: OVERHEAD_METHODOLOGY,
    measuredAt: new Date().toISOString(),
    environment: {
      node: process.version,
      platform: process.platform,
      arch: process.arch,
      cpus: os.availableParallelism(),
      commit: repoCommit(),
    },
    options: {
      fixture: fixture.id,
      mode: 'quick',
      client,
      model,
      delivery: 'none',
      runs,
    },
    realProviderCalls: 0,
    providerCalls: {
      real: 0,
      mocked: mockedTotals,
      unexpected: unexpectedTotals,
    },
    summary: {
      runs: results.length,
      succeeded: results.filter(item => item.state === 'succeeded').length,
      allVerified: results.every(
        item => item.state === 'succeeded' && item.verified.correctnessPassed && item.verified.scopePassed,
      ),
      totalMs: summarizeValues(results.map(item => item.totalMs)),
      nativeSessions: {
        median: sessionCounts.median,
        min: sessionCounts.min,
        max: sessionCounts.max,
        spread: sessionCounts.spread,
        byStage: byStageSummary,
      },
      stagesMs: stagesSummary,
      detailsMs: detailsSummary,
    },
    limitations: [...LIMITATIONS],
    runs: results,
  };
}

/**
 * Run the local Kodo overhead benchmark N times and return the structured report.
 * Calls are serialized because each trial temporarily isolates `process.env`.
 * @param {{ runs?: number, fixture?: string, client?: string, model?: string }} [options]
 * @param {{ runTrial?: typeof executeTrial }} [dependencies]
 */
export function runOverheadBenchmark(
  { runs = DEFAULT_RUNS, fixture: fixtureId = DEFAULT_FIXTURE, client = DEFAULT_CLIENT, model = DEFAULT_MODEL } = {},
  { runTrial = executeTrial } = {},
) {
  if (!Number.isSafeInteger(runs) || runs < 1 || runs > MAX_RUNS)
    return Promise.reject(new TypeError(`runs must be an integer from 1 to ${MAX_RUNS}`));
  const fixture = defaultFixtures.find(item => item.id === fixtureId);
  if (!fixture) return Promise.reject(new TypeError(`Unknown fixture: ${fixtureId}`));

  const start = () => runOverheadBenchmarkSerial({ runs, fixture, client, model, runTrial });
  const pending = benchmarkQueue.then(start, start);
  benchmarkQueue = pending.then(
    () => {},
    () => {},
  );
  return pending;
}

/** @param {Awaited<ReturnType<typeof runOverheadBenchmark>>} report */
export function formatTextReport(report) {
  const { summary, options, environment } = report;
  const lines = [
    `Kodo overhead benchmark (${options.fixture}, mode=${options.mode}, delivery=${options.delivery}, runs=${options.runs})`,
    `Среда: Node ${environment.node}, ${environment.platform}/${environment.arch}, commit=${environment.commit?.slice(0, 12) ?? 'unknown'}`,
    `Успешно: ${summary.succeeded}/${summary.runs} (verified=${summary.allVerified}), реальных вызовов провайдеров: ${report.realProviderCalls}`,
    `Общее время (Engine.create + Engine.run): медиана ${summary.totalMs.median} мс (min ${summary.totalMs.min}, max ${summary.totalMs.max}, разброс ${summary.totalMs.spread} мс)`,
    `Нативные сессии (подменённые): медиана ${summary.nativeSessions.median} (min ${summary.nativeSessions.min}, max ${summary.nativeSessions.max})`,
    `Время коллбеков подменённого провайдера: медиана ${summary.detailsMs.providerCallback.median} мс`,
    '',
    'Разбивка по этапам (мс):',
  ];
  for (const key of STAGE_KEYS) {
    const stat = summary.stagesMs[key];
    lines.push(
      `  - ${STAGE_LABELS[key]}: медиана ${stat.median} (min ${stat.min}, max ${stat.max}, разброс ${stat.spread})`,
    );
  }
  lines.push('', 'Ограничения:');
  for (const note of report.limitations) lines.push(`  - ${note}`);
  return lines.join('\n');
}

const USAGE = `Usage: node scripts/overhead-bench.mjs [--runs N] [--fixture button-color|filename-extension] [--json]`;

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  try {
    const options = parseArgs(process.argv.slice(2));
    if (options.help) {
      console.log(USAGE);
    } else {
      const report = await runOverheadBenchmark(options);
      if (options.json) console.log(JSON.stringify(report, null, 2));
      else console.log(formatTextReport(report));
      if (!report.summary.allVerified) process.exitCode = 1;
    }
  } catch (error) {
    console.error(error?.message || String(error));
    process.exitCode = 1;
  }
}
