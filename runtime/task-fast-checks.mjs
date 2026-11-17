/**
 * The `task-fast` verification profile: the cheap check of one task in a wave
 * project. Full verification (every command, smoke, gates and one review of the
 * whole diff) runs once per epic gate instead.
 *
 * The plan follows `kodo ci` L1: `node --check` of the affected JavaScript and
 * `node --test` of the affected test files. Any doubt (graph fallback, no
 * affected test, a runner that is not Node's own) runs the configured
 * `commands.test` in full. The receipt is never a full-check receipt: its
 * fingerprint and evidence kind differ, and it carries `profile: 'task-fast'`.
 */
import path from 'node:path';
import { createHash } from 'node:crypto';
import { lstat, realpath } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import { execute } from './command.mjs';
import { git } from './workspace.mjs';
import { validateCommandTimeouts } from './config.mjs';
import { workerEnvironment } from './security.mjs';
import { inspectCurrentSource, planAffected } from './ci-graph.mjs';
import { cacheFingerprint, readCheckCache, writeCheckCache } from './ci-cache.mjs';

export const TASK_FAST_PROFILE = 'task-fast';
export const FAST_CHECK_TIMEOUT_MS = 120000;
const LIST_LIMIT = 1000;
const REASON_LIMIT = 100;
const sha256 = value => createHash('sha256').update(value).digest('hex');
const fail = (message, code) => Object.assign(new Error(message), { code });
const javascript = file => /\.[cm]?js$/.test(file);
const lockFile = /(?:^|\/)(?:package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb?)$/;
const executionReasons = ['cancelled', 'timeout', 'invalid_output', 'command_failed', 'ENOENT', 'EACCES', 'EPERM'];

/**
 * The hard per-command timeout of the profile.
 * @param {{ fastChecks?: { timeoutMs?: number } }} run
 * @returns {number}
 */
export function fastCheckTimeout(run) {
  const settings = run.fastChecks;
  const invalid = () =>
    fail('Некорректный fastChecks.timeoutMs: требуется целое число от 1 до 2147483647 мс', 'configuration');
  if (settings === undefined) return FAST_CHECK_TIMEOUT_MS;
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) throw invalid();
  if (Object.keys(settings).some(key => key !== 'timeoutMs')) throw invalid();
  const value = settings.timeoutMs;
  if (value === undefined) return FAST_CHECK_TIMEOUT_MS;
  if (!Number.isSafeInteger(value) || value < 1 || value > 2147483647) throw invalid();
  return value;
}

// Options that change which tests run: narrowed, they may run none at all.
const selectionOption = /^--(?:test-shard|test-name-pattern|test-skip-pattern|test-only)(?:=|$)/;
// Options that change the summary the narrowed run is counted by.
const reporterOption = /^--test-reporter(?:-destination)?(?:=|$)/;

/**
 * Only Node's own test runner can be narrowed to the affected files. Its options must
 * survive the narrowing (`--name=value` only, none that selects tests or changes the
 * reporter); a positional path limits which test files run.
 * @param {{ command: string, args?: string[] }[]} commands
 */
function nodeTestRunner(commands) {
  if (commands.length !== 1) return { reason: commands.length ? 'runner-multiple-commands' : 'runner-not-configured' };
  const [{ command, args = [] }] = commands;
  if (!(command === process.execPath || /(?:^|[\\/])node(?:\.exe)?$/i.test(command)) || !args.includes('--test'))
    return { reason: 'runner-not-node-test' };
  const flags = [],
    scopes = [];
  for (const arg of args) {
    if (selectionOption.test(arg)) return { reason: 'runner-selection' };
    if (reporterOption.test(arg)) return { reason: 'runner-reporter' };
    if (arg === '--test' || /^--[a-z][a-z0-9-]*=/.test(arg)) flags.push(arg);
    else if (arg.startsWith('-') || /[*?[\]{}]/.test(arg)) return { reason: 'runner-options' };
    else {
      const scope = path.posix.normalize(arg.replaceAll('\\', '/')).replace(/\/+$/, '');
      if (path.posix.isAbsolute(scope) || /^[a-z]:/i.test(scope) || scope === '..' || scope.startsWith('../'))
        return { reason: 'runner-options' };
      scopes.push(scope);
    }
  }
  return { flags, scopes };
}
const inScope = (file, scopes) =>
  !scopes.length || scopes.some(scope => scope === '.' || file === scope || file.startsWith(`${scope}/`));

async function syntaxTargets(cwd, files) {
  const targets = [];
  for (const file of files.filter(javascript)) {
    // A deleted or renamed file stays in the graph for its reverse edges; there is nothing to parse.
    const info = await lstat(path.join(cwd, file)).catch(() => null);
    if (info?.isFile()) targets.push(file);
  }
  return targets;
}

const fullCommands = (configured, timeoutMs) =>
  configured.map(({ command, args = [], timeoutMs: own }) => ({
    kind: 'test',
    command,
    args: [...args],
    timeoutMs: Math.min(own ?? timeoutMs, timeoutMs),
  }));

/**
 * Tests a `node --test` run actually executed, from its summary (spec `ℹ` or TAP `#`
 * lines): tests minus skipped. `null` when the output has no summary.
 * @param {string} output
 * @returns {number | null}
 */
export function executedTests(output) {
  const counts = {};
  for (const [, name, value] of String(output).matchAll(/^(?:ℹ|#) (tests|skipped) (\d+)\s*$/gmu))
    counts[name] = Number(value);
  return counts.tests === undefined ? null : counts.tests - (counts.skipped ?? 0);
}

/**
 * The fast plan for one head, with the reasons for any full fallback.
 * @param {{ run: any, cwd?: string, baseSha?: string, headSha: string }} input
 */
export async function planFastChecks({ run, cwd = run.cwd, baseSha = run.baseSha, headSha }) {
  const timeoutMs = fastCheckTimeout(run);
  const configured = run.config.commands.test || [];
  const reasons = [];
  let graph = null;
  try {
    graph = await planAffected({ project: cwd, baseSha, headSha });
  } catch {
    reasons.push('graph-error');
  }
  if (graph?.fallback) reasons.push(...graph.reasons);
  const runner = nodeTestRunner(configured);
  if (runner.reason) reasons.push(runner.reason);
  const tests = reasons.length ? [] : graph.testFiles.filter(file => inScope(file, runner.scopes));
  if (!reasons.length && !tests.length) reasons.push('no-affected-tests');
  const fallback = reasons.length > 0;
  const commands = fallback
    ? fullCommands(configured, timeoutMs)
    : [
        ...(await syntaxTargets(cwd, graph.affectedFiles)).map(file => ({
          kind: 'syntax',
          command: process.execPath,
          args: ['--check', file],
          timeoutMs,
        })),
        { kind: 'test', command: process.execPath, args: [...runner.flags, ...tests], timeoutMs },
      ];
  const changed = graph?.changedFiles ?? [],
    affected = fallback ? [] : graph.affectedFiles;
  const truncated = changed.length > LIST_LIMIT || affected.length > LIST_LIMIT || reasons.length > REASON_LIMIT;
  return {
    schemaVersion: 1,
    profile: TASK_FAST_PROFILE,
    baseSha,
    headSha,
    changed: changed.slice(0, LIST_LIMIT),
    affected: affected.slice(0, LIST_LIMIT),
    testFiles: tests,
    fallback,
    reasons: reasons.slice(0, REASON_LIMIT),
    ...(truncated ? { truncated: true } : {}),
    sourceHash: graph?.sourceHash ?? null,
    dependencyHash: graph?.dependencyHash ?? null,
    commands,
  };
}

function fastEnvironment() {
  const env = workerEnvironment();
  // A runner that inherits an enclosing `node --test` context skips every file and exits 0.
  for (const name of Object.keys(env)) if (/^NODE_TEST_(?:CONTEXT|WORKER_ID)$/i.test(name)) delete env[name];
  return env;
}

async function assertClean(cwd, headSha, message) {
  if ((await inspectCurrentSource({ project: cwd, headSha })) !== 'clean') throw fail(message, 'dirty_worktree');
}

/** The freshly observed command context for the private cache. Unknown context means no cache. */
async function cacheContext(run, plan, headSha, env) {
  try {
    // The cache demands a canonical project path; the graph already refused links in it.
    const project = await realpath(run.cwd);
    const tree = await execute('git', ['ls-tree', '-rz', '--full-tree', headSha], {
      cwd: project,
      env: workerEnvironment(),
      rawOutput: true,
      timeoutMs: 30000,
    });
    const locks = tree.stdout
      .split('\0')
      .filter(Boolean)
      .flatMap(row => {
        const match = /^\d+ \w+ ([a-f0-9]+)\t([\s\S]+)$/.exec(row);
        return match && lockFile.test(match[2]) ? [[match[2], match[1]]] : [];
      })
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    const variables = Object.entries(env).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return {
      project,
      headSha,
      sourceHash: plan.sourceHash,
      dependencyHash: plan.dependencyHash,
      lockHash: sha256(JSON.stringify(locks)),
      envHash: sha256(JSON.stringify(variables)),
      runtimeVersions: { node: process.versions.node, v8: process.versions.v8, modules: process.versions.modules },
      toolVersions: { node: process.versions.node },
      platform: process.platform,
      arch: process.arch,
    };
  } catch {
    return null;
  }
}

async function cachedRow(engine, base, input, headSha) {
  const hit = await readCheckCache({
    home: engine.store.home,
    fingerprint: cacheFingerprint(input),
    project: input.project,
    headSha,
    input,
  });
  const file = hit?.evidence?.[0];
  if (!file) return null;
  try {
    await engine.assertEvidence({ path: file.path, sha256: file.sha256, headSha });
  } catch {
    return null;
  }
  return {
    ...base,
    exitCode: 0,
    durationMs: 0,
    cached: true,
    evidence: { path: file.path, sha256: file.sha256, bytes: file.bytes, headSha },
    outputPath: file.path,
    outputHash: file.sha256,
  };
}

/**
 * One command of the plan: a cached receipt, or its execution with persisted evidence.
 * A `counted` (narrowed) test step passes only when it executed at least one test.
 */
async function runStep({ engine, run, step, headSha, env, cache, counted, signal }) {
  const base = { kind: step.kind, command: step.command, args: step.args };
  const input =
    cache && step.kind === 'test'
      ? {
          ...cache,
          kind: 'test',
          command: step.command,
          args: step.args,
          // `executedTests`: only runs that executed a test are cached (older entries never match).
          gateConfig: { profile: TASK_FAST_PROFILE, timeoutMs: step.timeoutMs, executedTests: true },
        }
      : null;
  const hit = input && (await cachedRow(engine, base, input, headSha));
  if (hit) return { row: hit };
  const started = performance.now();
  let result, error;
  try {
    result = await execute(step.command, step.args, {
      cwd: run.cwd,
      signal,
      env,
      secrets: engine.secrets,
      timeoutMs: step.timeoutMs,
      allowFailure: true,
    });
  } catch (caught) {
    error = caught;
  }
  const durationMs = Math.round(performance.now() - started);
  const output = result ?? error?.result ?? {};
  const exitCode = result ? result.code : null;
  const reason = error ? (executionReasons.includes(error.code) ? error.code : 'execution_failed') : undefined;
  const value = {
    ...base,
    exitCode,
    ...(reason ? { reason } : {}),
    durationMs,
    stdout: typeof output.stdout === 'string' ? output.stdout : '',
    stderr: typeof output.stderr === 'string' ? output.stderr : '',
  };
  let evidence = null;
  try {
    evidence = await engine.persistEvidence(run, 'fast-check', value, { headSha });
  } catch (persistError) {
    // A stopped command keeps its own error; a finished one cannot pass without its log.
    if (!error) throw persistError;
  }
  /** @type {Record<string, any>} */
  const row = {
    ...base,
    exitCode,
    durationMs,
    ...(reason ? { reason } : {}),
    ...(evidence
      ? {
          evidence: { path: evidence.path, sha256: evidence.sha256, bytes: evidence.bytes, headSha },
          outputPath: evidence.path,
          outputHash: evidence.sha256,
        }
      : {}),
  };
  if (error) {
    if (error.code !== 'timeout' || signal?.aborted) return { row, error };
    const line = `${path.basename(step.command)} ${step.args.join(' ')}`.slice(0, 500);
    return {
      row,
      error: fail(
        `Быстрая проверка ${step.kind} превысила таймаут ${step.timeoutMs} мс: ${line}`,
        'fast_check_timeout',
      ),
    };
  }
  await assertClean(run.cwd, headSha, 'Команда проверки изменила проверяемый commit или файлы');
  if (result.code !== 0)
    return {
      row,
      error: fail(
        `Проверка ${step.kind} не пройдена (exit ${result.code}): ${(value.stdout + value.stderr).slice(-6000)}`,
        'check_failed',
      ),
    };
  if (counted) {
    // Exit 0 after running nothing is not a pass: never cache or accept it.
    row.tests = executedTests(`${value.stdout}\n${value.stderr}`);
    if (!(row.tests > 0)) return { row, noTests: true };
  }
  if (input)
    await writeCheckCache({
      home: engine.store.home,
      fingerprint: cacheFingerprint(input),
      project: input.project,
      headSha,
      input,
      receipt: {
        kind: 'test',
        status: 'passed',
        exitCode: 0,
        complete: true,
        headSha,
        command: step.command,
        args: step.args,
        evidence: [{ path: evidence.path, bytes: evidence.bytes, sha256: evidence.sha256 }],
      },
    });
  return { row };
}

/**
 * Run the fast plan on the clean HEAD of `run.cwd` and record `run.checks`.
 * Throws `check_failed`, `fast_check_timeout` or `dirty_worktree` like the full checks do.
 * @param {{ engine: any, run: any, signal?: AbortSignal }} input
 */
export async function runFastChecks({ engine, run, signal }) {
  const timeoutMs = fastCheckTimeout(run);
  validateCommandTimeouts(run.config.commands);
  await engine.setup(run.cwd, run, signal);
  const headSha = await git(run.cwd, ['rev-parse', 'HEAD']);
  await assertClean(run.cwd, headSha, 'Проверка commit требует чистого integration worktree');
  let plan = await planFastChecks({ run, cwd: run.cwd, baseSha: run.baseSha, headSha });
  if (!plan.commands.length) throw new Error('Не настроена команда проверки результата');
  let outcome = await executePlan({ engine, run, plan, headSha, signal });
  if (outcome.noTests) {
    // The narrowed run executed no test: run the configured commands.test in full instead.
    engine.log(run, 'fast_checks_no_tests', { headSha, testFiles: plan.testFiles.length });
    plan = {
      ...plan,
      affected: [],
      testFiles: [],
      fallback: true,
      reasons: ['no-tests-executed'],
      commands: fullCommands(run.config.commands.test || [], timeoutMs),
    };
    if (!plan.commands.length) throw new Error('Не настроена команда проверки результата');
    outcome = await executePlan({ engine, run, plan, headSha, signal });
  }
  run.checks.complete = true;
  engine.save(run);
  engine.log(run, 'fast_checks', {
    headSha,
    fallback: plan.fallback,
    commands: outcome.results.length,
    cached: outcome.results.filter(row => row.cached).length,
  });
  return run.checks;
}

/** Record a fresh, incomplete receipt for the plan and execute its commands in order. */
async function executePlan({ engine, run, plan, headSha, signal }) {
  const results = [];
  run.checks = {
    schemaVersion: 2,
    profile: TASK_FAST_PROFILE,
    headSha,
    // Domain-separated: a fast receipt can never carry the fingerprint of the full checks.
    fingerprint: sha256(
      JSON.stringify({
        profile: TASK_FAST_PROFILE,
        headSha,
        commands: plan.commands,
        runtime: {
          node: process.version,
          abi: process.versions.modules,
          platform: process.platform,
          arch: process.arch,
        },
      }),
    ),
    plan: {
      changed: plan.changed,
      affected: plan.affected,
      testFiles: plan.testFiles,
      fallback: plan.fallback,
      reasons: plan.reasons,
      ...(plan.truncated ? { truncated: true } : {}),
    },
    complete: false,
    results,
  };
  engine.save(run);
  const env = fastEnvironment();
  const cache = plan.fallback ? null : await cacheContext(run, plan, headSha, env);
  for (const step of plan.commands) {
    engine.checkCancelled(run, signal);
    const counted = !plan.fallback && step.kind === 'test';
    const { row, error, noTests } = await runStep({ engine, run, step, headSha, env, cache, counted, signal });
    results.push(row);
    engine.save(run);
    if (error) throw error;
    if (noTests) return { results, noTests: true };
  }
  return { results, noTests: false };
}
