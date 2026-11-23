#!/usr/bin/env node
/**
 * Local reproducible benchmark of Kodo's own orchestration overhead on a small
 * `quick` task: real Engine, real Git worktrees, SQLite Store, evidence ACLs
 * and configured checks, with an instant deterministic mocked provider (0 ms,
 * zero real Codex/Claude/Gemini/Jev calls, zero network, zero API keys).
 *
 * Each trial executes in an isolated child Node process launched with a strict
 * allowlist environment so user credentials, SSH keys, XDG git ignores and
 * GIT_* overrides can never leak into fixture preparation or Engine runs.
 */
import { spawn, spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { defaultFixtures, evaluateFixture, materializeFixture } from '../runtime/benchmark-fixtures.mjs';
import { planSchema, resultSchema, reviewSchema } from '../runtime/contracts.mjs';
import { Engine } from '../runtime/engine.mjs';
import { Store } from '../runtime/store.mjs';

export const OVERHEAD_METHODOLOGY = 'local-engine-instant-provider-v1';
export const DEFAULT_RUNS = 3;
export const MAX_RUNS = 100;
export const DEFAULT_FIXTURE = 'button-color';
export const DEFAULT_CLIENT = 'codex';
export const DEFAULT_MODEL = 'gpt-6.1-sol';
export const DEFAULT_TRIAL_TIMEOUT_MS = 120_000;

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

const UNEXPECTED_KEYS = Object.freeze([
  'analyzeGemini',
  'decideJev',
  'research',
  'delivery',
  'unknownSession',
  'sessionMismatch',
  'assessmentMismatch',
  'discoveryMismatch',
]);

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const SANDBOX_PREFIX = 'kodo-overhead-';
const NULL_DEVICE = process.platform === 'win32' ? 'NUL' : '/dev/null';
const ALLOWED_GIT_ENV_KEYS = new Set([
  'PATH',
  'PATHEXT',
  'SYSTEMROOT',
  'WINDIR',
  'COMSPEC',
  'SYSTEMDRIVE',
  'COMPUTERNAME',
  'OS',
  'NUMBER_OF_PROCESSORS',
  'PROCESSOR_ARCHITECTURE',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'TERM',
  'TZ',
  'TMP',
  'TEMP',
  'TMPDIR',
  'HOME',
  'USERPROFILE',
  'HOMEDRIVE',
  'HOMEPATH',
]);

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

function setEnvVar(env, key, value, caseInsensitive) {
  const target = caseInsensitive ? key.toUpperCase() : key;
  for (const existing of Object.keys(env)) {
    if ((caseInsensitive ? existing.toUpperCase() : existing) === target) delete env[existing];
  }
  env[key] = value;
}

function deleteEnvVar(env, key, caseInsensitive) {
  const target = caseInsensitive ? key.toUpperCase() : key;
  for (const existing of Object.keys(env)) {
    if ((caseInsensitive ? existing.toUpperCase() : existing) === target) delete env[existing];
  }
}

/**
 * Strict allowlist environment for helper `git` invocations: permits only safe
 * OS/runtime variables (matched case-insensitively on Windows), strips all
 * credentials, SSH keys, XDG overrides and GIT_* redirections/config overrides,
 * and pins GIT_CONFIG_NOSYSTEM=1, GIT_CONFIG_GLOBAL and GIT_TERMINAL_PROMPT=0.
 * @param {NodeJS.ProcessEnv} [base]
 * @param {{ home?: string, temp?: string, gitConfigGlobal?: string, gitTemplateDir?: string, platform?: NodeJS.Platform }} [options]
 */
export function sanitizedGitEnv(
  base = process.env,
  { home, temp, gitConfigGlobal, gitTemplateDir, platform = process.platform } = {},
) {
  const caseInsensitive = platform === 'win32';
  /** @type {Record<string, string>} */
  const env = {};
  const seen = new Set();

  for (const [name, value] of Object.entries(base || {})) {
    if (typeof value !== 'string') continue;
    const canonical = caseInsensitive ? name.toUpperCase() : name;
    if (!ALLOWED_GIT_ENV_KEYS.has(canonical)) continue;
    if (seen.has(canonical)) continue;
    seen.add(canonical);
    env[name] = value;
  }

  if (home !== undefined) {
    setEnvVar(env, 'HOME', home, caseInsensitive);
    setEnvVar(env, 'USERPROFILE', home, caseInsensitive);
    deleteEnvVar(env, 'HOMEDRIVE', caseInsensitive);
    deleteEnvVar(env, 'HOMEPATH', caseInsensitive);
  }
  if (temp !== undefined) {
    setEnvVar(env, 'TMP', temp, caseInsensitive);
    setEnvVar(env, 'TEMP', temp, caseInsensitive);
    setEnvVar(env, 'TMPDIR', temp, caseInsensitive);
  }
  if (gitTemplateDir !== undefined) setEnvVar(env, 'GIT_TEMPLATE_DIR', gitTemplateDir, caseInsensitive);

  setEnvVar(env, 'GIT_CONFIG_NOSYSTEM', '1', caseInsensitive);
  setEnvVar(env, 'GIT_CONFIG_GLOBAL', gitConfigGlobal ?? (platform === 'win32' ? 'NUL' : '/dev/null'), caseInsensitive);
  setEnvVar(env, 'GIT_TERMINAL_PROMPT', '0', caseInsensitive);
  return env;
}

/**
 * Strict allowlist environment for a child Node trial process: starts from
 * `sanitizedGitEnv` and pins HOME/USERPROFILE, TMP/TEMP/TMPDIR, XDG_*, AppData,
 * GIT_CONFIG_GLOBAL, GIT_TEMPLATE_DIR and all KODO_* paths into the sandbox.
 * @param {NodeJS.ProcessEnv} base
 * @param {Awaited<ReturnType<typeof createSandbox>>} box
 * @param {{ platform?: NodeJS.Platform }} [options]
 */
export function buildTrialEnv(base, box, { platform = process.platform } = {}) {
  const caseInsensitive = platform === 'win32';
  const env = sanitizedGitEnv(base, {
    home: box.isolated,
    temp: box.temp,
    gitConfigGlobal: box.gitconfig,
    gitTemplateDir: box.template,
    platform,
  });
  for (const [key, value] of [
    ['XDG_CONFIG_HOME', box.xdgConfigHome],
    ['XDG_DATA_HOME', box.xdgDataHome],
    ['XDG_CACHE_HOME', box.xdgCacheHome],
    ['XDG_STATE_HOME', box.xdgStateHome],
    ['LOCALAPPDATA', box.localAppData],
    ['APPDATA', box.appData],
    ['KODO_HOME', box.stateDir],
    ['KODO_CREDENTIAL_HOME', box.credentialsDir],
    ['KODO_WORKTREE_HOME', box.worktreesDir],
    ['KODO_TOOL_HOME', box.toolsDir],
    // Node 24 automatically forwards NODE_V8_COVERAGE to spawned Node children when omitted.
    ['NODE_V8_COVERAGE', ''],
  ])
    setEnvVar(env, key, value, caseInsensitive);
  return env;
}

function writeIsolatedGitConfig(file, { template, hooks, home, temp }) {
  const env = sanitizedGitEnv(process.env, { home, temp, gitConfigGlobal: file, gitTemplateDir: template });
  const hooksArg = `core.hooksPath=${hooks.split(path.sep).join('/')}`;
  for (const [key, value] of [
    ['init.templateDir', template],
    ['core.hooksPath', hooks],
  ]) {
    const result = spawnSync('git', ['-c', hooksArg, 'config', '--file', file, key, value.split(path.sep).join('/')], {
      env,
      encoding: 'utf8',
      windowsHide: true,
    });
    if (result.status !== 0) throw new Error(`Failed to write isolated git config: ${result.stderr}`);
  }
}

/**
 * Create an isolated temporary sandbox directory layout without mutating the
 * caller's `process.env`.
 */
export async function createSandbox() {
  const parent = await realpath(os.tmpdir());
  const directory = await mkdtemp(path.join(parent, SANDBOX_PREFIX));
  const root = path.join(directory, 'repo');
  const stateDir = path.join(directory, 'state');
  const toolsDir = path.join(directory, 'tools');
  const worktreesDir = path.join(directory, 'worktrees');
  const isolated = path.join(directory, 'empty-home');
  const temp = path.join(directory, 'tmp');
  const template = path.join(isolated, 'git-template');
  const hooks = path.join(isolated, 'git-hooks');
  const gitconfig = path.join(isolated, 'gitconfig');
  const credentialsDir = path.join(isolated, 'empty-credentials');
  const xdgConfigHome = path.join(isolated, 'xdg-config');
  const xdgDataHome = path.join(isolated, 'xdg-data');
  const xdgCacheHome = path.join(isolated, 'xdg-cache');
  const xdgStateHome = path.join(isolated, 'xdg-state');
  const localAppData = path.join(isolated, 'localappdata');
  const appData = path.join(isolated, 'appdata');

  try {
    for (const dir of [
      root,
      toolsDir,
      isolated,
      temp,
      template,
      hooks,
      xdgConfigHome,
      xdgDataHome,
      xdgCacheHome,
      xdgStateHome,
      localAppData,
      appData,
    ])
      await mkdir(dir);
    await writeFile(gitconfig, '');
    writeIsolatedGitConfig(gitconfig, { template, hooks, home: isolated, temp });
  } catch (error) {
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }).catch(() => {});
    throw error;
  }

  return {
    directory,
    root,
    stateDir,
    toolsDir,
    worktreesDir,
    isolated,
    temp,
    template,
    hooks,
    gitconfig,
    credentialsDir,
    xdgConfigHome,
    xdgDataHome,
    xdgCacheHome,
    xdgStateHome,
    localAppData,
    appData,
    async cleanup() {
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

const REPAIR_OR_CONFLICT_PROMPT =
  /Repair confirmed failures|Resolve (?:these Git merge |target branch merge )?conflicts/;

/**
 * Strictly classify a mocked session request by matching the full stage schema
 * contract (type, required fields and property definitions); any incompatible
 * schema or repair/conflict prompt is reported as `'unknown'`.
 * @param {any} request
 * @returns {'plan' | 'review' | 'developer' | 'unknown'}
 */
export function classifySessionRequest(request) {
  const schema = request?.schema;
  if (isDeepStrictEqual(schema, planSchema)) return 'plan';
  if (isDeepStrictEqual(schema, reviewSchema)) return 'review';
  if (isDeepStrictEqual(schema, resultSchema) && !REPAIR_OR_CONFLICT_PROMPT.test(String(request?.prompt || '')))
    return 'developer';
  return 'unknown';
}

export function createInstantServices({ fixture, client, model, now = () => performance.now() }) {
  const mockedCalls = {
    assessment: 0,
    discovery: 0,
    sessions: 0,
    byStage: { plan: 0, developer: 0, review: 0 },
  };
  const unexpectedCalls = {
    analyzeGemini: 0,
    decideJev: 0,
    research: 0,
    delivery: 0,
    unknownSession: 0,
    sessionMismatch: 0,
    assessmentMismatch: 0,
    discoveryMismatch: 0,
  };
  /** @type {Array<{ stage: string, durationMs: number }>} */
  const sessionCallbacks = [];
  /** @type {string[]} */
  const sessionSequence = [];
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
      const stage = classifySessionRequest(request);
      sessionSequence.push(stage);
      if (stage === 'unknown') {
        unexpectedCalls.unknownSession++;
        throw new Error('Unexpected or unknown session request in quick overhead benchmark');
      }
      const sessionId = `mock-session-${++sequence}`;
      mockedCalls.sessions++;
      mockedCalls.byStage[stage]++;
      // Keep Engine's synchronous onEvent (SQLite + progress.md persistence) outside
      // the mock-work timer so engineExcludingMock never subtracts Kodo's own work.
      request.onEvent?.({ sessionId, stage });

      const started = now();
      let output;
      if (stage === 'plan') {
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
      } else if (stage === 'review') {
        output = { passed: true, findings: [] };
      } else {
        await applyFixtureSolution(fixture.id, request.cwd);
        output = { complete: true, summary: `Updated ${fixture.implementation}`, checks: ['node verify.cjs'] };
      }
      sessionCallbacks.push({ stage, durationMs: now() - started });
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

  return { mockedCalls, unexpectedCalls, sessionCallbacks, sessionSequence, provider, researcher, delivery };
}

const sameSequence = (left, right) =>
  left.length === right.length && left.every((item, index) => item === right[index]);

/**
 * Verify that mocked provider sessions match both Engine's recorded
 * `sessionAttempts` and the expected stage sequence derived from the run's
 * actual plan/route (supports both 3-session `cli` planning and 2-session local
 * fast-path planning).
 * @param {{ planSource?: string | null, plannerSession?: string | null, planTasks?: Array<{ role: string }>, sessionAttempts?: Array<{ stage: string }>, mockedSequence?: string[] }} input
 */
export function validateSessionSequence({
  planSource,
  plannerSession,
  planTasks,
  sessionAttempts = [],
  mockedSequence = [],
}) {
  const usesPlannerSession = planSource === 'cli' || Boolean(plannerSession);
  const taskRoles = Array.isArray(planTasks) && planTasks.length ? planTasks.map(task => task.role) : ['developer'];
  const expected = [...(usesPlannerSession ? ['plan'] : []), ...taskRoles, 'review'];
  const attempts = (sessionAttempts || []).map(item => item.stage);
  const mockedMatchesAttempts = sameSequence(mockedSequence, attempts);
  const attemptsMatchExpected = sameSequence(attempts, expected);
  const ok = mockedMatchesAttempts && attemptsMatchExpected;
  const mismatchCount = ok
    ? 0
    : Math.max(1, Math.abs(mockedSequence.length - attempts.length) + (attemptsMatchExpected ? 0 : 1));
  return { ok, expected, mismatchCount };
}

function attachRunObserver(store) {
  /** @type {Record<string, number | null>} */
  const marks = {
    start: null,
    created: null,
    modeSelected: null,
    analyzed: null,
    planned: null,
    nodeWorktreeReady: null,
    nodeCompleted: null,
    integrated: null,
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
    if (type === 'mode_selected' && marks.modeSelected === null) marks.modeSelected = now;
    if (type === 'analyzed' && marks.analyzed === null) marks.analyzed = now;
    if (type === 'integrated' && marks.integrated === null) marks.integrated = now;
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

/**
 * Always close the SQLite store and run sandbox cleanup even if one throws,
 * preserving any primary trial error.
 * @param {{ store?: { close(): void } | null, cleanup: () => Promise<void>, primaryError?: unknown }} resources
 */
export async function finalizeTrialResources({ store, cleanup, primaryError }) {
  let closeError;
  try {
    if (store) store.close();
  } catch (error) {
    closeError = error;
  }

  let cleanupError;
  const cleanupStart = performance.now();
  try {
    await cleanup();
  } catch (error) {
    cleanupError = error;
  }
  const cleanupMs = roundMs(performance.now() - cleanupStart);

  if (primaryError !== undefined) throw primaryError;
  if (closeError !== undefined) throw closeError;
  if (cleanupError !== undefined) throw cleanupError;
  return cleanupMs;
}

async function executeTrialInProcess({ runIndex, fixture, client, model, root, stateDir }) {
  /** @type {Store | null} */
  let store = null;
  let primaryError;
  let report;

  try {
    const setupStart = performance.now();
    const materialized = await materializeFixture({
      directory: root,
      fixture,
      client,
      model,
      mode: 'quick',
    });
    const fixtureSetupMs = roundMs(performance.now() - setupStart);

    store = new Store(stateDir, {});
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
      project: root,
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

    const sequenceCheck = validateSessionSequence({
      planSource: result.planSource,
      plannerSession: result.plannerSession,
      planTasks: result.plan?.tasks,
      sessionAttempts: result.sessionAttempts,
      mockedSequence: services.sessionSequence,
    });
    if (!sequenceCheck.ok) services.unexpectedCalls.sessionMismatch += sequenceCheck.mismatchCount;
    const expectedCalls = expectedCoordinatorCalls(result.executionMode);
    services.unexpectedCalls.assessmentMismatch += Math.abs(services.mockedCalls.assessment - expectedCalls.assessment);
    services.unexpectedCalls.discoveryMismatch += Math.abs(services.mockedCalls.discovery - expectedCalls.discovery);

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
        expectedStages: sequenceCheck.expected,
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
  } catch (error) {
    primaryError = error;
  }

  await finalizeTrialResources({ store, cleanup: async () => {}, primaryError });
  return report;
}

function expectedCoordinatorCalls(executionMode) {
  const fastPath = executionMode?.source === 'fast-path' || executionMode?.assessment === 'not_requested';
  return { assessment: fastPath ? 0 : 1, discovery: 1 };
}

function terminateProcessTree(child, graceMs) {
  if (!child.pid) return;
  if (process.platform === 'win32') {
    const killer = spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], {
      windowsHide: true,
      stdio: 'ignore',
    });
    killer.on('error', () => child.kill());
    return;
  }
  try {
    process.kill(-child.pid, 'SIGTERM');
  } catch {
    child.kill('SIGTERM');
  }
  const hardKill = setTimeout(
    () => {
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch {
        child.kill('SIGKILL');
      }
    },
    Math.min(1000, graceMs),
  );
  hardKill.unref();
  child.once('close', () => clearTimeout(hardKill));
}

/**
 * Spawn one isolated trial child process with a hard timeout and bounded
 * process-tree termination.
 * @param {{ box: Awaited<ReturnType<typeof createSandbox>>, env: Record<string, string>, payload: object, entryArgs?: string[], timeoutMs?: number, killGraceMs?: number }} options
 */
export function spawnTrialChild({
  box,
  env,
  payload,
  entryArgs = [SCRIPT_PATH, '--internal-trial'],
  timeoutMs = DEFAULT_TRIAL_TIMEOUT_MS,
  killGraceMs = 5000,
}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, entryArgs, {
      cwd: box.directory,
      env,
      detached: process.platform !== 'win32',
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    let timedOut = false;
    /** @type {NodeJS.Timeout | undefined} */
    let graceTimer;

    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutTimer);
      if (graceTimer) clearTimeout(graceTimer);
      if (error) reject(error);
      else resolve(value);
    };

    const timeoutTimer = setTimeout(() => {
      timedOut = true;
      terminateProcessTree(child, killGraceMs);
      graceTimer = setTimeout(() => {
        finish(Object.assign(new Error(`Trial child timed out after ${timeoutMs}ms`), { code: 'timeout' }));
      }, killGraceMs);
      graceTimer.unref();
    }, timeoutMs);
    timeoutTimer.unref();

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      stdout += chunk;
    });
    child.stderr.on('data', chunk => {
      stderr += chunk;
    });
    child.on('error', error => finish(error));
    child.on('close', code => {
      if (timedOut) {
        finish(Object.assign(new Error(`Trial child timed out after ${timeoutMs}ms`), { code: 'timeout' }));
        return;
      }
      let parsed;
      try {
        parsed = stdout.trim() ? JSON.parse(stdout) : null;
      } catch {
        parsed = null;
      }
      if (code === 0 && parsed?.ok && parsed.report) {
        finish(null, parsed.report);
        return;
      }
      const detail = parsed?.error || stderr.trim() || `Trial child exited with code ${code}`;
      finish(new Error(detail));
    });
    child.stdin.on('error', () => {});
    child.stdin.end(JSON.stringify(payload));
  });
}

async function executeTrial({ runIndex, fixture, client, model, trialTimeoutMs = DEFAULT_TRIAL_TIMEOUT_MS }) {
  const box = await createSandbox();
  let primaryError;
  let report;

  try {
    const env = buildTrialEnv(process.env, box);
    report = await spawnTrialChild({
      box,
      env,
      payload: { runIndex, fixtureId: fixture.id, client, model, root: box.root, stateDir: box.stateDir },
      timeoutMs: trialTimeoutMs,
    });
  } catch (error) {
    primaryError = error;
  }

  const cleanupMs = await finalizeTrialResources({ store: null, cleanup: () => box.cleanup(), primaryError });
  report.detailsMs.cleanup = cleanupMs;
  return report;
}

/** @param {{ env?: NodeJS.ProcessEnv, cwd?: string }} [options] */
export function repoCommit({ env = process.env, cwd } = {}) {
  const target = cwd || path.resolve(path.dirname(SCRIPT_PATH), '..');
  const result = spawnSync('git', ['-c', `core.hooksPath=${NULL_DEVICE}`, 'rev-parse', 'HEAD'], {
    cwd: target,
    env: sanitizedGitEnv(env),
    encoding: 'utf8',
    windowsHide: true,
  });
  return result.status === 0 ? result.stdout.trim() : null;
}

const hasUnexpectedCalls = calls => Object.values(calls || {}).some(value => typeof value === 'number' && value > 0);

function trialSessionMismatchCount(item) {
  const recorded = item.unexpectedCalls?.sessionMismatch ?? 0;
  const mockedCount = item.mockedCalls?.sessions ?? 0;
  const attemptCount = item.nativeSessions?.count ?? 0;
  const byStageSum = Object.values(item.mockedCalls?.byStage || {}).reduce((sum, count) => sum + count, 0);
  const countDelta = Math.abs(mockedCount - attemptCount) + Math.abs(byStageSum - mockedCount);
  return Math.max(recorded, countDelta);
}

function trialCoordinatorMismatch(item) {
  const expected = expectedCoordinatorCalls(item.executionMode);
  const assessmentDelta = Math.abs((item.mockedCalls?.assessment ?? 0) - expected.assessment);
  const discoveryDelta = Math.abs((item.mockedCalls?.discovery ?? 0) - expected.discovery);
  return {
    assessmentMismatch: Math.max(item.unexpectedCalls?.assessmentMismatch ?? 0, assessmentDelta),
    discoveryMismatch: Math.max(item.unexpectedCalls?.discoveryMismatch ?? 0, discoveryDelta),
  };
}

/**
 * Run the local Kodo overhead benchmark N times and return the structured report.
 * Each trial executes in an isolated child process with an allowlist environment,
 * so the caller's `process.env` is never mutated.
 * @param {{ runs?: number, fixture?: string, client?: string, model?: string, trialTimeoutMs?: number }} [options]
 * @param {{ runTrial?: typeof executeTrial }} [dependencies]
 */
export async function runOverheadBenchmark(
  {
    runs = DEFAULT_RUNS,
    fixture: fixtureId = DEFAULT_FIXTURE,
    client = DEFAULT_CLIENT,
    model = DEFAULT_MODEL,
    trialTimeoutMs = DEFAULT_TRIAL_TIMEOUT_MS,
  } = {},
  { runTrial = executeTrial } = {},
) {
  if (!Number.isSafeInteger(runs) || runs < 1 || runs > MAX_RUNS)
    throw new TypeError(`runs must be an integer from 1 to ${MAX_RUNS}`);
  const fixture = defaultFixtures.find(item => item.id === fixtureId);
  if (!fixture) throw new TypeError(`Unknown fixture: ${fixtureId}`);

  const results = [];
  for (let index = 1; index <= runs; index++) {
    results.push(await runTrial({ runIndex: index, fixture, client, model, trialTimeoutMs }));
  }

  const normalizedUnexpected = results.map(item => {
    const coordinator = trialCoordinatorMismatch(item);
    return {
      analyzeGemini: item.unexpectedCalls?.analyzeGemini ?? 0,
      decideJev: item.unexpectedCalls?.decideJev ?? 0,
      research: item.unexpectedCalls?.research ?? 0,
      delivery: item.unexpectedCalls?.delivery ?? 0,
      unknownSession: item.unexpectedCalls?.unknownSession ?? 0,
      sessionMismatch: trialSessionMismatchCount(item),
      assessmentMismatch: coordinator.assessmentMismatch,
      discoveryMismatch: coordinator.discoveryMismatch,
    };
  });

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
    ['plan', 'developer', 'review'].map(stage => [
      stage,
      summarizeValues(results.map(item => item.mockedCalls.byStage[stage])),
    ]),
  );

  const unexpectedTotals = Object.fromEntries(
    UNEXPECTED_KEYS.map(key => [key, normalizedUnexpected.reduce((sum, row) => sum + row[key], 0)]),
  );
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
      allVerified:
        !hasUnexpectedCalls(unexpectedTotals) &&
        results.every(
          (item, index) =>
            item.state === 'succeeded' &&
            item.verified.correctnessPassed &&
            item.verified.scopePassed &&
            !hasUnexpectedCalls(normalizedUnexpected[index]),
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

/** @param {Awaited<ReturnType<typeof runOverheadBenchmark>>} report */
export function formatTextReport(report) {
  const { summary, options, environment } = report;
  const unexpectedEntries = Object.entries(report.providerCalls?.unexpected || {}).filter(([, count]) => count > 0);
  const lines = [
    `Kodo overhead benchmark (${options.fixture}, mode=${options.mode}, delivery=${options.delivery}, runs=${options.runs})`,
    `Среда: Node ${environment.node}, ${environment.platform}/${environment.arch}, commit=${environment.commit?.slice(0, 12) ?? 'unknown'}`,
    `Успешно: ${summary.succeeded}/${summary.runs} (verified=${summary.allVerified}), реальных вызовов провайдеров: ${report.realProviderCalls}`,
    ...(unexpectedEntries.length
      ? [`Неожиданные вызовы: ${unexpectedEntries.map(([name, count]) => `${name}=${count}`).join(', ')}`]
      : []),
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

/**
 * Execute the CLI entrypoint and return its exit code (0 on verified success, 1 otherwise).
 * @param {string[]} argv
 * @param {{ runBenchmark?: typeof runOverheadBenchmark, writeOut?: (text: string) => void, writeErr?: (text: string) => void }} [dependencies]
 */
export async function runCli(
  argv,
  { runBenchmark = runOverheadBenchmark, writeOut = console.log, writeErr = console.error } = {},
) {
  try {
    const options = parseArgs(argv);
    if (options.help) {
      writeOut(USAGE);
      return { exitCode: 0 };
    }
    const report = await runBenchmark(options);
    writeOut(options.json ? JSON.stringify(report, null, 2) : formatTextReport(report));
    return { exitCode: report.summary.allVerified ? 0 : 1, report };
  } catch (error) {
    writeErr(error?.message || String(error));
    return { exitCode: 1, error };
  }
}

async function runInternalTrialFromStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  try {
    const payload = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    const fixture = defaultFixtures.find(item => item.id === payload.fixtureId);
    if (!fixture) throw new TypeError(`Unknown fixture: ${payload.fixtureId}`);
    const report = await executeTrialInProcess({
      runIndex: payload.runIndex,
      fixture,
      client: payload.client,
      model: payload.model,
      root: payload.root,
      stateDir: payload.stateDir,
    });
    process.stdout.write(JSON.stringify({ ok: true, report }) + '\n');
  } catch (error) {
    process.stdout.write(JSON.stringify({ ok: false, error: error?.message || String(error) }) + '\n');
    process.exitCode = 1;
  }
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  if (process.argv[2] === '--internal-trial') {
    await runInternalTrialFromStdin();
  } else {
    const { exitCode } = await runCli(process.argv.slice(2));
    process.exitCode = exitCode;
  }
}
