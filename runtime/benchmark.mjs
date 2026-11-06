import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile, rename, lstat } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { Engine as ProductionEngine } from './engine.mjs';
import { Store as ProductionStore } from './store.mjs';
import * as nativeProvider from './providers.mjs';
import { loadSecrets, workerEnvironment } from './security.mjs';
import { resolveClient, runProcess, subscriptionEnvironment } from './process.mjs';
import { aggregateMetrics, normalizeUsage } from './metrics.mjs';
import { normalizeMode } from './modes.mjs';
import { git } from './workspace.mjs';
import {
  defaultFixtures,
  fixtureHash,
  materializeFixture,
  evaluateFixture,
  expectedFixtureSnapshot,
} from './benchmark-fixtures.mjs';

export const benchmarkMethodology = 'paired-native-engine-heldout-v1';
// Native memory is separate from Engine lessons/cache. Keep the signed-in
// credential home in place and disable memory PER INVOCATION for both arms.
// Sources: https://github.com/openai/codex/blob/main/codex-rs/core/config.schema.json
// https://code.claude.com/docs/en/memory (CLAUDE_CODE_DISABLE_AUTO_MEMORY).
export function isolatedBenchmarkInvocation(client, invocation) {
  const args = [...(invocation.args || [])],
    env = { ...invocation.env };
  if (client === 'codex' && args.includes('exec'))
    args.splice(
      args.indexOf('exec'),
      0,
      '-c',
      'features.memories=false',
      '-c',
      'features.memory_tool=false',
      '-c',
      'memories.generate_memories=false',
      '-c',
      'memories.use_memories=false',
      '-c',
      'memories.dedicated_tools=false',
    );
  if (client === 'claude-code') env.CLAUDE_CODE_DISABLE_AUTO_MEMORY = '1';
  return { ...invocation, args, env };
}
const nativeSession = (provider, request) =>
  provider.runSession(request, {
    processImpl: invocation => runProcess(isolatedBenchmarkInvocation(request.client, invocation)),
  });
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const hash = value =>
  createHash('sha256')
    .update(typeof value === 'string' ? value : stable(value))
    .digest('hex');
function stable(value) {
  return JSON.stringify(value, (_, item) =>
    item && typeof item === 'object' && !Array.isArray(item)
      ? Object.fromEntries(
          Object.keys(item)
            .sort()
            .map(key => [key, item[key]]),
        )
      : item,
  );
}
const finite = value => (Number.isFinite(value) && value >= 0 ? value : null);
const count = value => (Number.isSafeInteger(value) && value >= 0 ? value : null);
const modelName = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/.test(value);
const pendingCodes = new Set(['quota', 'auth', 'cancelled', 'lease_lost', 'unavailable']);
function failure(error, signal) {
  const code =
    signal?.aborted || error?.name === 'AbortError'
      ? 'cancelled'
      : [
            'quota',
            'auth',
            'cancelled',
            'lease_lost',
            'unavailable',
            'blocked',
            'invalid_output',
            'fixed_model',
            'command_failed',
            'timeout',
          ].includes(error?.code)
        ? error.code
        : 'error';
  const retry = typeof error?.retryAt === 'string' ? Date.parse(error.retryAt) : NaN;
  // Provider messages and arbitrary structured outputs are intentionally absent.
  return { code, ...(Number.isFinite(retry) ? { retryAt: new Date(retry).toISOString() } : {}) };
}

export function normalizeBenchmarkOptions(options = {}, { platform = process.platform } = {}) {
  const client = options.client ?? 'codex',
    mode = normalizeMode(options.mode) ?? 'quick';
  const models = typeof options.models === 'string' ? options.models.split(',') : options.models;
  if (!['codex', 'claude-code'].includes(client)) throw new TypeError('Benchmark client must be codex or claude-code');
  if (
    !Array.isArray(models) ||
    !models.length ||
    models.length > 32 ||
    models.some(value => !modelName(value)) ||
    new Set(models).size !== models.length
  )
    throw new TypeError('Benchmark requires distinct native model names');
  const repeats = options.repeats ?? 2,
    seed = options.seed ?? 1;
  if (!Number.isSafeInteger(repeats) || repeats < 1 || repeats > 100)
    throw new TypeError('Benchmark repeats must be an integer from 1 to 100');
  if (!Number.isSafeInteger(seed) || seed < -2147483648 || seed > 2147483647)
    throw new TypeError('Benchmark seed must be a signed 32-bit integer');
  if (options.output !== undefined && (typeof options.output !== 'string' || !path.isAbsolute(options.output)))
    throw new TypeError('Benchmark output must be an absolute directory');
  if (platform === 'win32' && options.output && path.resolve(options.output).length > 80)
    throw new TypeError(
      'Windows benchmark requires a short execution root (at most 80 characters), such as D:/KodoBench/pilot. Deep process working directories are not supported by the Windows runtime.',
    );
  return { client, models: [...models], mode, repeats, seed };
}

async function metadata() {
  const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
  const sources = [
    'runtime/benchmark.mjs',
    'runtime/benchmark-cli.mjs',
    'runtime/benchmark-fixtures.mjs',
    'runtime/engine.mjs',
    'runtime/engine-core.mjs',
    'runtime/engine-planning.mjs',
    'runtime/engine-execution.mjs',
    'runtime/engine-verification.mjs',
    'runtime/modes.mjs',
    'runtime/providers.mjs',
    'runtime/metrics.mjs',
    'runtime/command.mjs',
    'runtime/config.mjs',
    'runtime/workspace.mjs',
    'runtime/task-context.mjs',
    'third-party-skills.lock.json',
  ];
  const hashes = {};
  for (const file of sources) hashes[file] = hash(await readFile(path.join(root, file), 'utf8'));
  const commit = await lstat(path.join(root, '.git'))
    .then(() => git(root, ['rev-parse', 'HEAD']))
    .catch(() => null);
  return { version: pkg.version, commit, sources: hashes };
}
async function clientVersion(client) {
  try {
    const env = subscriptionEnvironment(),
      executable = await resolveClient(client, env);
    const result = await runProcess({ ...executable, args: [...executable.args, '--version'], env, timeoutMs: 20000 });
    // Keep only a version token, never arbitrary native output or executable paths.
    return result.exitCode === 0 ? (/\b\d+\.\d+\.\d+(?:[-+][\w.-]+)?\b/.exec(result.stdout)?.[0] ?? null) : null;
  } catch {
    return null;
  }
}
async function identity(options, dependencies) {
  return {
    methodology: benchmarkMethodology,
    options,
    engine: await metadata(),
    clientVersion: await (dependencies.clientVersion || clientVersion)(options.client),
    fixtures: defaultFixtures.map(fixture => ({ id: fixture.id, hash: fixtureHash(fixture) })),
  };
}
async function atomic(file, value) {
  const temporary = `${file}.${randomUUID()}.tmp`;
  await writeFile(temporary, JSON.stringify(value, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  await rename(temporary, file);
}
const receiptPath = directory => path.join(directory, 'benchmark.json');
async function readReceipt(location) {
  const directory = path.resolve(location.endsWith('.json') ? path.dirname(location) : location);
  const manifest = JSON.parse(await readFile(receiptPath(directory), 'utf8'));
  if (
    manifest.schemaVersion !== 1 ||
    manifest.identityHash !== hash(manifest.identity) ||
    !Array.isArray(manifest.trials) ||
    !/^[a-f0-9-]{36}$/.test(manifest.id)
  )
    throw new Error('Invalid benchmark identity or receipt');
  if (manifest.scheduled) {
    const expected = schedule(manifest);
    if (
      expected.length !== manifest.trials.length ||
      manifest.trials.some(
        (cell, i) =>
          ['trialId', 'pairKey', 'fixture', 'fixtureHash', 'model', 'repeat', 'condition'].some(
            key => cell[key] !== expected[i][key],
          ) ||
          !['pending', 'completed'].includes(cell.status) ||
          !Array.isArray(cell.attempts) ||
          !Array.isArray(cell.sessions) ||
          (cell.workspace !== undefined &&
            !new RegExp(`^trials/${cell.trialId}/attempt-[1-9][0-9]*$`).test(cell.workspace)) ||
          (cell.workspace !== undefined &&
            (!/^[a-f0-9]{40}$/.test(cell.initialCommit) ||
              hash(cell.baseline) !==
                hash(
                  expectedFixtureSnapshot({
                    fixture: defaultFixtures.find(item => item.id === cell.fixture),
                    ...manifest.identity.options,
                    model: cell.model,
                  }),
                ))) ||
          (cell.engineRunId !== undefined && !/^[a-f0-9-]{36}$/.test(cell.engineRunId)),
      )
    )
      throw new Error('Invalid benchmark trial identity or workspace');
  }
  return { directory, manifest };
}
function shuffled(values, seed) {
  let state = seed >>> 0;
  function random() {
    state += 0x6d2b79f5;
    let n = Math.imul(state ^ (state >>> 15), 1 | state);
    n ^= n + Math.imul(n ^ (n >>> 7), 61 | n);
    return ((n ^ (n >>> 14)) >>> 0) / 4294967296;
  }
  for (let i = values.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [values[i], values[j]] = [values[j], values[i]];
  }
  return values;
}
function schedule(manifest) {
  const { options } = manifest.identity,
    cells = [];
  for (const fixture of defaultFixtures)
    for (const model of options.models.filter(model => manifest.capabilities[model]?.available))
      for (let repeat = 1; repeat <= options.repeats; repeat++) {
        const pairKey = hash({ identity: manifest.identityHash, fixture: fixture.id, model, repeat });
        for (const condition of ['plain', 'kodo'])
          cells.push({
            trialId: hash({ benchmark: manifest.id, pairKey, condition }).slice(0, 32),
            pairKey,
            fixture: fixture.id,
            fixtureHash: fixtureHash(fixture),
            model,
            repeat,
            condition,
            status: 'pending',
            attempts: [],
            sessions: [],
            wallMs: 0,
            logicalCalls: { analysis: 0, routing: 0, discovery: 0 },
            reportedModels: [],
          });
      }
  return shuffled(cells, options.seed);
}

// Trial state/knowledge stays private. Only subscription leases are delegated to
// the SAME account SQLite used by ordinary coordinators. Never a private lease.
function trialStore(store, account) {
  const tokens = new Set(),
    acquire = store.acquireLease.bind(store),
    renew = store.renewLease.bind(store),
    release = store.releaseLease.bind(store);
  store.acquireLease = (name, owner, options = {}) => {
    if (!name.startsWith('subscription:')) return acquire(name, owner, options);
    const token = account.acquireLease(name, owner, { ...options, limit: 2 });
    if (token) tokens.add(token);
    return token;
  };
  store.renewLease = (token, ttl) => (tokens.has(token) ? account.renewLease(token, ttl) : renew(token, ttl));
  store.releaseLease = token => {
    if (tokens.delete(token)) account.releaseLease(token);
    else release(token);
  };
  return store;
}
async function accountLease(account, client, owner, action, signal, heartbeatMs = 10000) {
  let token;
  while (!(token = account.acquireLease(`subscription:${client}`, owner, { limit: 2, ttlMs: 60000 }))) {
    signal?.throwIfAborted();
    await new Promise((resolve, reject) => {
      const done = () => {
        signal?.removeEventListener('abort', abort);
        resolve();
      };
      const timer = setTimeout(done, 250),
        abort = () => {
          clearTimeout(timer);
          signal?.removeEventListener('abort', abort);
          reject(signal.reason);
        };
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) abort();
    });
  }
  const controller = new AbortController(),
    abort = () => controller.abort(signal?.reason);
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) abort();
  let lost = false;
  const timer = setInterval(() => {
    if (!account.renewLease(token)) {
      lost = true;
      controller.abort();
    }
  }, heartbeatMs);
  timer.unref();
  try {
    controller.signal.throwIfAborted();
    const result = await action(controller.signal);
    if (lost) throw Object.assign(new Error('Subscription lease lost'), { code: 'lease_lost' });
    return result;
  } catch (error) {
    if (lost) throw Object.assign(new Error('Subscription lease lost'), { code: 'lease_lost' });
    throw error;
  } finally {
    clearInterval(timer);
    signal?.removeEventListener('abort', abort);
    account.releaseLease(token);
  }
}

function safeMetrics(client, result, elapsed) {
  const value = result?.metrics;
  const usage = value?.usage
    ? Object.fromEntries(
        ['inputTokens', 'cachedInputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'totalTokens'].map(
          key => [key, count(value.usage[key])],
        ),
      )
    : normalizeUsage(client, result?.usage);
  usage.semantics = client === 'codex' ? 'input-includes-cached' : 'cache-read-and-write-separate-from-input';
  usage.source = value?.usage || result?.usage ? `${client}.usage` : null;
  return {
    durationMs: finite(value?.durationMs) ?? elapsed,
    toolSteps: count(value?.toolSteps),
    nativeRequestCount: null,
    usage,
  };
}
function environment(cache) {
  const env = subscriptionEnvironment(workerEnvironment());
  for (const name of Object.keys(env)) if (/^(?:NPM_CONFIG_CACHE|NODE_OPTIONS)$/i.test(name)) delete env[name];
  env.NPM_CONFIG_CACHE = cache;
  const key = Object.keys(env).find(name => name.toLowerCase() === 'path') || 'PATH';
  env[key] = [path.dirname(process.execPath), env[key]].filter(Boolean).join(path.delimiter);
  return env;
}

async function probe(manifest, context) {
  const { provider, account, save, signal } = context,
    { options } = manifest.identity;
  for (const model of options.models) {
    if (Object.hasOwn(manifest.capabilities, model)) continue;
    try {
      signal?.throwIfAborted();
      // Codex exec requires a Git workspace. A probe is separate from measured
      // cells and gets neither a previous trial's repo nor its learned files.
      const probeRoot = await mkdtemp(path.join(context.directory, 'probe-'));
      const probeFixture = await materializeFixture({
        directory: path.join(probeRoot, 'project'),
        fixture: defaultFixtures[0],
        ...options,
        model,
      });
      const cache = path.join(probeRoot, 'native-cache');
      await mkdir(cache);
      const entries = await provider.discoverProviders(
        { client: options.client, providers: 'current', primaryModel: model },
        {
          config: { project: probeFixture.directory, models: { [options.client]: [model] } },
          live: true,
          sessionImpl: request =>
            accountLease(
              account,
              options.client,
              `benchmark-probe:${manifest.id}`,
              async leaseSignal => {
                const start = performance.now();
                try {
                  const result = await nativeSession(provider, {
                    ...request,
                    signal: leaseSignal,
                    env: environment(cache),
                  });
                  manifest.probeMetrics.push(safeMetrics(options.client, result, performance.now() - start));
                  return result;
                } catch (error) {
                  manifest.probeMetrics.push(safeMetrics(options.client, error, performance.now() - start));
                  throw error;
                } finally {
                  await save();
                }
              },
              signal,
            ),
        },
      );
      signal?.throwIfAborted();
      const entry = entries.find(item => item.client === options.client && item.model === model);
      if (!entry?.available && ['quota', 'auth', 'unavailable'].includes(entry?.code))
        throw Object.assign(new Error('Capability probe paused'), { code: entry.code });
      manifest.capabilities[model] = {
        available: entry?.available === true && entry?.verified === true,
        verified: entry?.verified === true,
        code: entry?.available === true && entry?.verified === true ? null : 'unsupported_or_unverified',
      };
      await save();
    } catch (error) {
      manifest.pause = failure(error, signal);
      await save();
      return false;
    }
  }
  if (!manifest.scheduled) {
    manifest.trials = schedule(manifest);
    manifest.scheduled = true;
    await save();
  }
  return true;
}

async function trial(cell, manifest, context) {
  const { directory, provider, account, secrets, Engine, Store, save, signal } = context,
    { options } = manifest.identity;
  const fixture = defaultFixtures.find(item => item.id === cell.fixture);
  for (const previous of cell.attempts)
    if (previous.status === 'running') {
      previous.status = 'interrupted';
      previous.durationMs = null;
      cell.wallIncomplete = true;
    }
  const attempt = { number: cell.attempts.length + 1, status: 'running' };
  cell.attempts.push(attempt);
  await save();
  const started = performance.now();
  let store, result, cwd, fault;
  try {
    signal?.throwIfAborted();
    const trialRoot = path.join(directory, 'trials', cell.trialId);
    await mkdir(trialRoot, { recursive: true, mode: 0o700 });
    // An interrupted Kodo trial resumes ONLY its own Engine state. A plain
    // retry is a fresh session/repo, never --last or another cell's history.
    if (!cell.workspace || cell.condition === 'plain') {
      const relative = `trials/${cell.trialId}/attempt-${attempt.number}`;
      const fx = await materializeFixture({
        directory: path.join(directory, relative, 'project'),
        fixture,
        ...options,
        model: cell.model,
      });
      cell.workspace = relative;
      cell.initialCommit = fx.initialCommit;
      cell.baseline = fx.baseline;
      const counterpart = manifest.trials.find(
        other => other.pairKey === cell.pairKey && other !== cell && other.initialCommit,
      );
      if (counterpart && counterpart.initialCommit !== cell.initialCommit) throw new Error('Pair source mismatch');
      await save();
    }
    const home = path.join(directory, cell.workspace),
      project = path.join(home, 'project');
    const env = environment(path.join(home, 'native-cache'));
    await mkdir(env.NPM_CONFIG_CACHE, { recursive: true });
    const wrapped = { ...provider };
    wrapped.runSession = async request => {
      if (request.client !== options.client || request.model !== cell.model)
        throw Object.assign(new Error('Fixed model boundary violated'), { code: 'fixed_model' });
      const start = performance.now();
      let nativeResult;
      // A killed coordinator cannot run finally. Record the attempt before the
      // native boundary; an interrupted receipt keeps unknown usage/time rather
      // than silently dropping the attempt from the resumed aggregate.
      const sessionIndex = cell.sessions.length;
      cell.sessions.push({
        durationMs: null,
        toolSteps: null,
        nativeRequestCount: null,
        usage: normalizeUsage(options.client),
      });
      await save();
      try {
        nativeResult = await nativeSession(provider, { ...request, env });
        if (nativeResult?.model && nativeResult.model !== cell.model)
          throw Object.assign(new Error('Reported model differs'), { code: 'fixed_model' });
        if (modelName(nativeResult?.model) && !cell.reportedModels.includes(nativeResult.model))
          cell.reportedModels.push(nativeResult.model);
        return nativeResult;
      } catch (error) {
        nativeResult ||= error;
        throw error;
      } finally {
        cell.sessions[sessionIndex] = safeMetrics(options.client, nativeResult, performance.now() - start);
        await save();
      }
    };
    for (const [name, key] of [
      ['analyzeGemini', 'analysis'],
      ['decideJev', 'routing'],
      ['discoverProviders', 'discovery'],
    ])
      if (provider[name])
        wrapped[name] = async (...args) => {
          cell.logicalCalls[key]++;
          await save();
          return provider[name](...args);
        };
    cwd = project;
    if (cell.condition === 'plain') {
      await accountLease(
        account,
        options.client,
        cell.trialId,
        leaseSignal =>
          wrapped.runSession({
            client: options.client,
            model: cell.model,
            cwd,
            prompt: fixture.prompt,
            readOnly: false,
            signal: leaseSignal,
          }),
        signal,
      );
      result = { state: 'succeeded' };
    } else {
      store = trialStore(new Store(path.join(home, 'state'), secrets), account);
      const forbidden = async () => {
        throw new Error('Benchmark delivery is forbidden');
      };
      const engine = new Engine({
        store,
        secrets,
        provider: wrapped,
        ...(context.researcher ? { researcher: context.researcher } : {}),
        delivery: {
          deliver: forbidden,
          releasePackage: forbidden,
          prepareReleaseVersion: forbidden,
          reconcileDelivery: forbidden,
        },
      });
      if (!cell.engineRunId) {
        const run = await engine.create(fixture.prompt, {
          project,
          client: options.client,
          model: cell.model,
          mode: options.mode,
          providers: 'current',
          delivery: 'none',
        });
        // Engine.create ordinarily honors KODO_WORKTREE_HOME. Benchmarks must
        // keep ALL of their worktrees inside this trial even on a desktop host
        // with a global override. Persist through Engine's existing state port.
        if (run.worktreeRoot) {
          const worktreeRoot = path.join(home, 'worktrees', run.id);
          store.updateRun(run.id, { worktreeRoot, cwd: path.join(worktreeRoot, 'integration') });
        }
        cell.engineRunId = run.id;
        await save();
      }
      cwd = store.getRun(cell.engineRunId).cwd || project;
      result = await engine.run(cell.engineRunId, { signal, resumeCancelled: true });
      if (result.metrics?.coordinatorLogicalCalls && typeof result.metrics.coordinatorLogicalCalls === 'object') {
        cell.engineLogicalCalls = Object.fromEntries(
          ['assessment', 'analysis', 'research', 'routing', 'discovery'].map(key => [
            key,
            count(result.metrics.coordinatorLogicalCalls[key]),
          ]),
        );
      }
      cwd = result.cwd || project;
      const resolved = path.resolve(cwd),
        expectedRoot = path.resolve(home);
      // The real Engine uses <state>-worktrees. Never evaluate a caller's repo.
      if (!resolved.startsWith(expectedRoot + path.sep)) throw new Error('Engine workspace escaped trial');
      cell.researchRequests = count(result.research?.requests);
      if (result.state !== 'succeeded') fault = failure(result.error || { code: 'blocked' }, signal);
    }
    if (signal?.aborted) fault = { code: 'cancelled' };
    if (fault && pendingCodes.has(fault.code)) throw Object.assign(new Error('Trial paused'), fault);
    const checked = await evaluateFixture({ fixture, cwd, baseline: cell.baseline });
    // The original fixture commit must still exist unmodified, even if Engine
    // has committed its implementation. Working-tree hashes catch ignored files.
    let intact = true;
    try {
      const tree = await git(project, ['rev-parse', `${cell.initialCommit}^{tree}`]);
      intact = Boolean(tree) && (await git(project, ['remote'])).length === 0;
    } catch {
      intact = false;
    }
    if (!intact) checked.scope = { passed: false, violations: checked.scope.violations + 1 };
    Object.assign(cell, checked, {
      execution: { succeeded: !fault, error: fault ?? null },
      passed: !fault && checked.correctness.passed && checked.scope.passed,
      status: 'completed',
    });
    attempt.status = fault ? 'failed' : 'completed';
    if (fault) attempt.error = fault;
  } catch (error) {
    fault = failure(error, signal);
    attempt.error = fault;
    if (pendingCodes.has(fault.code)) {
      attempt.status = 'pending';
      cell.status = 'pending';
      manifest.pause = fault;
    } else {
      attempt.status = 'failed';
      cell.status = 'completed';
      cell.passed = false;
      cell.execution = { succeeded: false, error: fault };
      const confined =
        cwd && cell.workspace && path.resolve(cwd).startsWith(path.resolve(directory, cell.workspace) + path.sep);
      const checked =
        confined && cell.baseline
          ? await evaluateFixture({ fixture, cwd, baseline: cell.baseline })
          : { correctness: { passed: null, code: 'execution_failed' }, scope: { passed: null, violations: null } };
      cell.correctness = checked.correctness;
      cell.scope = checked.scope;
    }
  } finally {
    attempt.durationMs = performance.now() - started;
    cell.wallMs += attempt.durationMs;
    if (store) store.close();
    await save();
  }
}

async function executeBenchmark(directory, manifest, dependencies, signal) {
  const Store = dependencies.Store || ProductionStore;
  const secrets = dependencies.secrets ?? (await loadSecrets());
  const account = dependencies.accountStore || new Store(undefined, secrets);
  const token = account.acquireLease(`benchmark:${hash(directory)}`, manifest.id, { ttlMs: 60000 });
  if (!token) {
    if (!dependencies.accountStore) account.close();
    throw new Error('Benchmark is already running');
  }
  const controller = new AbortController(),
    abort = () => controller.abort(signal?.reason);
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) abort();
  const timer = setInterval(() => {
    if (!account.renewLease(token)) controller.abort();
  }, 10000);
  timer.unref();
  const context = {
    ...dependencies,
    Store,
    Engine: dependencies.Engine || ProductionEngine,
    directory,
    secrets,
    account,
    provider: dependencies.provider || nativeProvider,
    signal: controller.signal,
    save: () => atomic(receiptPath(directory), manifest),
  };
  try {
    delete manifest.pause;
    if (await probe(manifest, context))
      for (const cell of manifest.trials) {
        if (cell.status === 'completed') continue;
        await trial(cell, manifest, context);
        if (manifest.pause) break;
      }
    manifest.complete = Boolean(manifest.scheduled && manifest.trials.every(cell => cell.status === 'completed'));
    await context.save();
    return { ...buildBenchmarkReport(manifest), output: directory };
  } finally {
    clearInterval(timer);
    signal?.removeEventListener('abort', abort);
    account.releaseLease(token);
    if (!dependencies.accountStore) account.close();
  }
}

export async function runBenchmark(options = {}, dependencies = {}) {
  const normalized = normalizeBenchmarkOptions(options);
  const directory =
    options.output || path.join(os.homedir(), '.kodo', 'bench', randomUUID().replaceAll('-', '').slice(0, 12));
  if (process.platform === 'win32' && path.resolve(directory).length > 80)
    throw new TypeError('Choose a shorter Windows benchmark execution root with --output');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const descriptor = await identity(normalized, dependencies);
  const manifest = {
    schemaVersion: 1,
    id: randomUUID(),
    identity: descriptor,
    identityHash: hash(descriptor),
    capabilities: {},
    probeMetrics: [],
    scheduled: false,
    trials: [],
    complete: false,
  };
  // Exclusive creation prevents accidentally replacing an existing experiment.
  await writeFile(receiptPath(directory), JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  return executeBenchmark(directory, manifest, dependencies, options.signal);
}
export async function resumeBenchmark(location, dependencies = {}) {
  const { directory, manifest } = await readReceipt(location);
  const current = await identity(normalizeBenchmarkOptions(manifest.identity.options), dependencies);
  if (hash(current) !== manifest.identityHash)
    throw new Error('Benchmark identity changed: methodology, options, fixtures, engine or client version differs');
  return executeBenchmark(directory, manifest, dependencies, dependencies.signal);
}
export async function reportBenchmark(location) {
  const { directory, manifest } = await readReceipt(location);
  return { ...buildBenchmarkReport(manifest), output: directory };
}
export const resume = resumeBenchmark;
export const report = reportBenchmark;

const median = values => {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b),
    i = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[i] : (sorted[i - 1] + sorted[i]) / 2;
};
export function buildBenchmarkReport(manifest) {
  const options = normalizeBenchmarkOptions(manifest.identity.options);
  const trials = manifest.trials.map(cell => ({
    trialId: cell.trialId,
    pairKey: cell.pairKey,
    fixture: cell.fixture,
    fixtureHash: cell.fixtureHash,
    model: cell.model,
    reportedModels: cell.reportedModels.filter(model => model === cell.model),
    repeat: cell.repeat,
    condition: cell.condition,
    status: cell.status,
    initialCommit: cell.initialCommit ?? null,
    wallMs: cell.wallIncomplete ? null : cell.wallMs,
    attempts: cell.attempts.map(attempt => ({
      number: count(attempt.number),
      status: ['running', 'interrupted', 'pending', 'failed', 'completed'].includes(attempt.status)
        ? attempt.status
        : 'unknown',
      durationMs: finite(attempt.durationMs),
      ...(attempt.error ? { error: failure(attempt.error) } : {}),
    })),
    execution: cell.execution
      ? {
          succeeded: cell.execution.succeeded === true,
          error: cell.execution.error ? failure(cell.execution.error) : null,
        }
      : null,
    correctness: cell.correctness
      ? {
          passed: typeof cell.correctness.passed === 'boolean' ? cell.correctness.passed : null,
          code: ['passed', 'heldout_failed', 'unsafe_workspace', 'invalid_implementation', 'execution_failed'].includes(
            cell.correctness.code,
          )
            ? cell.correctness.code
            : 'unknown',
        }
      : null,
    scope: cell.scope
      ? {
          passed: typeof cell.scope.passed === 'boolean' ? cell.scope.passed : null,
          violations: count(cell.scope.violations),
        }
      : null,
    passed: cell.status === 'completed' ? cell.passed === true : null,
    metrics: {
      ...aggregateMetrics(cell.sessions),
      coordinatorLogicalCalls:
        cell.condition === 'kodo'
          ? Object.fromEntries(
              ['assessment', 'analysis', 'research', 'routing', 'discovery'].map(key => [
                key,
                count(cell.engineLogicalCalls?.[key] ?? cell.logicalCalls?.[key]),
              ]),
            )
          : null,
      researchRequests: cell.condition === 'kodo' ? (cell.researchRequests ?? null) : null,
    },
  }));
  const summaries = [];
  for (const model of options.models)
    for (const condition of ['plain', 'kodo']) {
      const selected = trials.filter(item => item.model === model && item.condition === condition);
      if (!selected.length) continue;
      const completed = selected.filter(item => item.status === 'completed'),
        passed = completed.filter(item => item.passed);
      summaries.push({
        model,
        condition,
        total: selected.length,
        completed: completed.length,
        passed: passed.length,
        failed: completed.length - passed.length,
        pending: selected.length - completed.length,
        passRate: completed.length ? passed.length / completed.length : null,
        knownWallCount: completed.filter(item => item.wallMs !== null).length,
        medianWallMs: median(completed.map(item => item.wallMs).filter(value => value !== null)),
        medianPassingWallMs: median(passed.map(item => item.wallMs).filter(value => value !== null)),
      });
    }
  const pairedDeltas = [];
  for (const plain of trials.filter(item => item.condition === 'plain')) {
    const kodo = trials.find(item => item.condition === 'kodo' && item.pairKey === plain.pairKey);
    const ready = plain.status === 'completed' && kodo?.status === 'completed';
    const delta = key =>
      ready && plain.metrics[key] !== null && kodo.metrics[key] !== null
        ? kodo.metrics[key] - plain.metrics[key]
        : null;
    pairedDeltas.push({
      pairKey: plain.pairKey,
      fixture: plain.fixture,
      model: plain.model,
      repeat: plain.repeat,
      complete: ready,
      plainPassed: plain.passed,
      kodoPassed: kodo?.passed ?? null,
      kodoMinusPlainWallMs: ready && kodo.wallMs !== null && plain.wallMs !== null ? kodo.wallMs - plain.wallMs : null,
      kodoMinusPlainToolSteps: delta('toolSteps'),
      kodoMinusPlainTotalTokens:
        ready && plain.metrics.usage.totalTokens !== null && kodo.metrics.usage.totalTokens !== null
          ? kodo.metrics.usage.totalTokens - plain.metrics.usage.totalTokens
          : null,
    });
  }
  return {
    schemaVersion: 1,
    benchmarkId: manifest.id,
    identityHash: manifest.identityHash,
    complete: manifest.complete,
    methodology: benchmarkMethodology,
    options,
    engine: manifest.identity.engine,
    clientVersion: manifest.identity.clientVersion,
    pause: manifest.pause ? failure(manifest.pause) : null,
    excludedModels: options.models
      .filter(model => Object.hasOwn(manifest.capabilities, model) && !manifest.capabilities[model].available)
      .map(model => ({ model, code: 'unsupported_or_unverified' })),
    probeMetrics: aggregateMetrics(manifest.probeMetrics),
    trials,
    summaries,
    pairedDeltas,
    limits: [
      'Kodo adds its pinned default skills, orchestration, mandatory checks and independent review to the same task prompt, source and native tool permissions.',
      'Serial paired trials use separate repos, sessions, state, knowledge and cache; subscription account and native client installation remain shared. Backend caching cannot be reset.',
      'Native memory generation and use are disabled per invocation in both conditions; subscription credential files are not copied into fixtures.',
      'Capability probes are separate overhead. Wall time includes orchestration and held-out checks; paused time between resume calls is excluded. Failed and pending counts remain visible.',
      'Codex input tokens include cached input; Claude cache read/write tokens are separate. Unknown metrics remain null; native HTTP counts, subscription USD and actual backend model identity are not observable.',
      'This small fixture sample cannot establish a universal model winner. Offline injected checks do not prove native client, published package or deployment behavior.',
    ],
  };
}
