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
import { lstat, readFile, realpath } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import { execute } from './command.mjs';
import { git } from './workspace.mjs';
import { FAST_CHECK_TIMEOUT_MS, fastCheckTimeout, validateCommandTimeouts } from './config.mjs';
import { workerEnvironment } from './security.mjs';
import { inspectCurrentSource, planAffected } from './ci-graph.mjs';
import { cargoFetchError, cargoLockFailure, cargoOfflineMiss, warmCargoDependencies } from './cargo-fetch.mjs';
import { cacheFingerprint, readCheckCache, writeCheckCache } from './ci-cache.mjs';
import { buildDiagnosticPack } from './diagnostic-pack.mjs';
import {
  TEST_COUNT_VERSION,
  countingPlan,
  executeCounted,
  nodeTestCommand,
  nodeTestOutcome,
  nodeTestRunner,
  npmContextFor,
  npmLaunch,
  stopReason,
  fail,
} from './task-fast-counting.mjs';

export const TASK_FAST_PROFILE = 'task-fast';
export { fastCheckTimeout, FAST_CHECK_TIMEOUT_MS };
export {
  TEST_COUNT_VERSION,
  nodeArguments,
  nodeTestCommand,
  countedRunner,
  countingArguments,
  npmScript,
  resolveNpmScript,
  npmContextAt,
  npmContextFor,
  countingPlan,
  npmLaunch,
  countTestEvents,
  nodeTestOutcome,
  npmCountOutcome,
  executeCheck,
  countNpmScript,
  executeCounted,
} from './task-fast-counting.mjs';

const LIST_LIMIT = 1000;
const REASON_LIMIT = 100;
const sha256 = value => createHash('sha256').update(value).digest('hex');
const javascript = file => /\.[cm]?js$/.test(file);
const lockFile = /(?:^|\/)(?:package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb?)$/;

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

const cargoCommand = step => {
  const name = path.basename(step.command);
  return process.platform === 'win32' ? /^cargo(?:\.exe)?$/i.test(name) : name === 'cargo';
};
const cargoToolchain = step => (step.args?.[0]?.startsWith('+') ? step.args[0] : undefined);
const cargoInvocation = step => JSON.stringify([step.command, cargoToolchain(step)]);
function plainCargo(step) {
  if (!cargoCommand(step)) return false;
  const args = step.args ?? [];
  const index = cargoToolchain(step) ? 1 : 0;
  return args[index] === 'test' && args.slice(index + 1).every(arg => arg === '--workspace' || arg === '--locked');
}
function selectCargoPackages(step, selector) {
  if (!plainCargo(step)) return step;
  const toolchain = cargoToolchain(step);
  const prefix = toolchain ? [toolchain] : [];
  if (selector.length) return { ...step, args: [...prefix, 'test', ...selector, '--locked'] };
  return { ...step, kind: 'metadata', args: [...prefix, 'metadata', '--locked', '--no-deps', '--format-version', '1'] };
}
async function rustFastPlan({ run, cwd, baseSha, headSha, configured }) {
  const manifest = await lstat(path.join(cwd, 'Cargo.toml')).catch(() => null);
  if (!manifest?.isFile() && !manifest?.isSymbolicLink()) return null;
  const timeoutMs = fastCheckTimeout(run, 600000);
  const useDefault =
    !configured.length ||
    (configured.length === 1 &&
      configured[0].command === 'npm' &&
      configured[0].args.join(' ') === 'test' &&
      !(await lstat(path.join(cwd, 'package.json')).catch(() => null)));
  const selected = useDefault
    ? [{ command: 'cargo', args: ['test'], timeoutMs: configured[0]?.timeoutMs }]
    : configured;
  if (!selected.some(cargoCommand)) return null;
  let graph;
  try {
    const { cargoPlanAt } = await import('./cargo-graph.mjs');
    graph = await cargoPlanAt(cwd, baseSha, headSha);
  } catch {
    graph = { changed: [], affectedCrates: [], fallback: true, reasons: ['cargo-graph-error'] };
  }
  const selector = graph.fallback ? ['--workspace'] : graph.packageSpecs.flatMap(spec => ['-p', spec]);
  const commands = fullCommands(selected, timeoutMs).map(step => selectCargoPackages(step, selector));
  return {
    schemaVersion: 1,
    profile: TASK_FAST_PROFILE,
    rust: true,
    ...(graph.unrelatedLinks?.length && selected.every(plainCargo)
      ? { unrelatedCargoLinks: graph.unrelatedLinks }
      : {}),
    baseSha,
    headSha,
    changed: graph.changed.slice(0, LIST_LIMIT),
    affected: graph.affectedCrates,
    affectedCrates: graph.affectedCrates,
    testFiles: [],
    fallback: graph.fallback,
    reasons: graph.reasons,
    truncated: graph.changed.length > LIST_LIMIT,
    sourceHash: null,
    dependencyHash: null,
    commands,
  };
}

/**
 * The fast plan for one head, with the reasons for any full fallback.
 * @param {{ run: any, cwd?: string, baseSha?: string, headSha: string }} input
 */
export async function planFastChecks({ run, cwd = run.cwd, baseSha = run.baseSha, headSha }) {
  const timeoutMs = fastCheckTimeout(run);
  const configured = run.config.commands.test || [];
  const cargo = await rustFastPlan({ run, cwd, baseSha, headSha, configured });
  if (cargo) return cargo;
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

/** The environment of a counted test run: no inherited `node --test` context. */
export function fastEnvironment() {
  const env = workerEnvironment();
  // A runner that inherits an enclosing `node --test` context skips every file and exits 0, and
  // NODE_OPTIONS could add a test filter the command line does not show: wave checks run only
  // the options written in the command.
  for (const name of Object.keys(env))
    if (/^(?:NODE_TEST_(?:CONTEXT|WORKER_ID)|NODE_OPTIONS)$/i.test(name)) delete env[name];
  return env;
}

async function assertClean(cwd, headSha, message, unrelatedCargoLinks = undefined) {
  if (
    (await inspectCurrentSource({
      project: cwd,
      headSha,
      unrelatedCargoLinks: unrelatedCargoLinks && new Set(unrelatedCargoLinks),
    })) !== 'clean'
  )
    throw fail(message, 'dirty_worktree');
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

async function cachedRow(engine, step, input, headSha) {
  const hit = await readCheckCache({
    home: engine.store.home,
    fingerprint: cacheFingerprint(input),
    project: input.project,
    headSha,
    input,
  });
  const file = hit?.evidence?.[0];
  if (!file) return null;
  let logged, outcome;
  try {
    await engine.assertEvidence({ path: file.path, sha256: file.sha256, headSha });
    // The cached log must still prove its count by its own events, with the current algorithm.
    logged = JSON.parse(await readFile(file.path, 'utf8')).value;
    outcome = nodeTestOutcome(step, logged);
  } catch {
    return null;
  }
  if (!(outcome?.tests > 0)) return null;
  return {
    ...rowBase(step),
    exitCode: 0,
    durationMs: 0,
    cached: true,
    executed: logged.executed,
    countVersion: TEST_COUNT_VERSION,
    tests: outcome.tests,
    evidence: { path: file.path, sha256: file.sha256, bytes: file.bytes, headSha },
    outputPath: file.path,
    outputHash: file.sha256,
  };
}

const rowBase = step => ({ kind: step.kind, command: step.command, args: step.args });

/**
 * One command of the plan: a cached receipt, or its execution with persisted evidence.
 * A countable `node --test` step (countingPlan `step`) runs with Kodo's reporters (executeCheck): its
 * row keeps the planned `command`/`args`, adds the `executed` command, `countVersion` and how many
 * tests passed by the event file (`row.tests`); its log also holds `executed` and `testEvents`.
 * Passing none is `noTests`, never cached. An npm script command always runs as configured (its exit
 * code decides); after it passed, a simple one (countingPlan `npm`) gets its counting run
 * (countNpmScript): the row adds `countVersion` and `count`, the log `count` with `testEvents`, and a
 * confirmed zero fails the check (`fast_check_no_tests`).
 */
async function runStep({ engine, run, step, headSha, env, cache, counting, signal, unrelatedCargoLinks }) {
  const base = rowBase(step);
  const input =
    cache && step.kind === 'test'
      ? {
          ...cache,
          kind: 'test',
          command: step.command,
          args: step.args,
          // Only runs that passed a test (not skip/todo) by the events of the current counting
          // algorithm are cached; entries of older algorithms (`passedTests`, `executedTests`) never match.
          gateConfig: { profile: TASK_FAST_PROFILE, timeoutMs: step.timeoutMs, countVersion: TEST_COUNT_VERSION },
        }
      : null;
  const hit = input && (await cachedRow(engine, step, input, headSha));
  if (hit) return { row: hit };
  const started = performance.now();
  const options = { cwd: run.cwd, signal, env, secrets: engine.secrets, timeoutMs: step.timeoutMs, allowFailure: true };
  const direct = counting?.step;
  // The configured npm command decides; only after it passed is its script counted separately (`npm`).
  const { result, error, npm, recorded, observed } = await executeCounted(npmLaunch(step), counting, options, [
    run.project,
  ]);
  const durationMs = Math.round(performance.now() - started);
  const output = result ?? error?.result ?? {};
  const exitCode = result ? result.code : null;
  const reason = error ? stopReason(error) : undefined;
  const value = {
    ...base,
    exitCode,
    ...(reason ? { reason } : {}),
    durationMs,
    stdout: typeof output.stdout === 'string' ? output.stdout : '',
    stderr: typeof output.stderr === 'string' ? output.stderr : '',
    ...observed,
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
    ...recorded,
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
  await assertClean(run.cwd, headSha, 'Команда проверки изменила проверяемый commit или файлы', unrelatedCargoLinks);
  if (result.code !== 0) {
    const diagnostics = buildDiagnosticPack({
      run,
      stdout: value.stdout,
      stderr: value.stderr,
      secrets: engine.secrets,
    });
    row.diagnostics = diagnostics;
    return {
      row,
      cargoOfflineMiss: cargoCommand(step) && cargoOfflineMiss(value.stderr),
      error: Object.assign(
        (cargoCommand(step) ? cargoLockFailure(value.stderr) : null) ??
          fail(
            `Проверка ${step.kind} не пройдена (exit ${result.code}): ${(value.stdout + value.stderr).slice(-6000)}`,
            'check_failed',
          ),
        { diagnostics },
      ),
    };
  }
  if (npm?.error?.code === 'cancelled') return { row, error: npm.error };
  // npm passed, but its plain `node --test` passed no test by Kodo's events: not a pass. A counting run
  // that failed, stopped or gave no complete event file leaves the decision to npm's exit code.
  if (npm?.count.tests === 0)
    return {
      row,
      error: fail(
        `Скрипт npm ${npm.count.resolved.script} завершился успешно, но его node --test не выполнил успешно ни одного теста (по событиям репортёра Kodo 0)`,
        'fast_check_no_tests',
      ),
    };
  if (direct) {
    // Exit 0 after passing nothing (only skip/todo, no tests, no complete event file) is not a pass:
    // never cache it.
    row.tests = nodeTestOutcome(direct, observed)?.tests ?? null;
    if (!(row.tests > 0)) return { row, noTests: true, unknown: row.tests === null };
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

export function fullFastFallback(run, plan) {
  const timeoutMs = fastCheckTimeout(run, plan.rust ? 600000 : FAST_CHECK_TIMEOUT_MS);
  const configured = run.config.commands.test || [];
  const commands = fullCommands(configured, timeoutMs).map(step =>
    plan.rust ? selectCargoPackages(step, ['--workspace']) : step,
  );
  return { ...plan, affected: [], testFiles: [], fallback: true, reasons: ['no-tests-executed'], commands };
}

/**
 * Run the fast plan on the clean HEAD of `run.cwd` and record `run.checks`.
 * Throws `check_failed`, `fast_check_timeout` or `dirty_worktree` like the full checks do.
 * @param {{ engine: any, run: any, signal?: AbortSignal, maxHeavyBuilds?:number }} input
 */
export async function runFastChecks({ engine, run, signal, maxHeavyBuilds = 1 }) {
  fastCheckTimeout(run);
  validateCommandTimeouts(run.config.commands);
  await engine.setup(run.cwd, run, signal);
  const headSha = await git(run.cwd, ['rev-parse', 'HEAD']);
  let plan = await planFastChecks({ run, cwd: run.cwd, baseSha: run.baseSha, headSha });
  await assertClean(
    run.cwd,
    headSha,
    'Проверка commit требует чистого integration worktree',
    'unrelatedCargoLinks' in plan ? plan.unrelatedCargoLinks : undefined,
  );
  if (!plan.commands.length) throw new Error('Не настроена команда проверки результата');
  let outcome = await executePlan({ engine, run, plan, headSha, signal, maxHeavyBuilds });
  if (outcome.noTests) {
    // The narrowed run executed no test: run the configured commands.test in full instead.
    engine.log(run, 'fast_checks_no_tests', { headSha, testFiles: plan.testFiles.length });
    plan = fullFastFallback(run, plan);
    if (!plan.commands.length) throw new Error('Не настроена команда проверки результата');
    outcome = await executePlan({ engine, run, plan, headSha, signal, maxHeavyBuilds });
  }
  run.checks.complete = true;
  run.lastDiagnostics = null;
  engine.save(run);
  engine.log(run, 'fast_checks', {
    headSha,
    fallback: plan.fallback,
    commands: outcome.results.length,
    cached: outcome.results.filter(row => row.cached).length,
  });
  return run.checks;
}

/**
 * A full `node --test` run passed with an unknown outcome: the command cannot be counted (a
 * selecting or unknown option, see countedRunner) or the event file of Kodo's reporter is missing,
 * malformed or incomplete. Like zero passed tests, it is never a green receipt.
 * @param {boolean} counted whether Kodo ran the command with its reporters (countingPlan)
 */
const summaryUnknown = counted =>
  fail(
    counted
      ? 'Полный прогон node --test не дал полного журнала событий репортёра Kodo: число пройденных тестов неизвестно'
      : 'Полный прогон node --test нельзя подсчитать: у команды есть опция отбора тестов, watch-режим или неизвестная опция',
    'fast_check_summary_unknown',
  );

/** Record a fresh, incomplete receipt for the plan and execute its commands in order. */
async function executePlan(input) {
  const { engine, run, plan, signal } = input;
  const env = fastEnvironment();
  if (!plan.rust) return executePlanSteps(input, env);
  const { withCargoSlot } = await import('./cargo-slots.mjs');
  return withCargoSlot(
    {
      home: engine.store.home,
      projectId: run.directorBinding?.projectId ?? sha256(path.resolve(run.project ?? run.cwd)),
      maxHeavyBuilds: input.maxHeavyBuilds,
      sccache: run.config.rust?.sccache,
      env,
      signal,
      // A slot shared by the worktrees of several tasks rebuilds the workspace crates of a new one.
      checkout: run.cwd,
    },
    buildEnv => executePlanSteps(input, buildEnv),
  );
}

async function executePlanSteps({ engine, run, plan, headSha, signal }, env) {
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
        countVersion: TEST_COUNT_VERSION,
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
      ...(plan.rust ? { affectedCrates: plan.affectedCrates } : {}),
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
  const refreshers = new Map();
  if (plan.rust) {
    for (const step of plan.commands.filter(cargoCommand)) {
      const key = cargoInvocation(step);
      if (refreshers.has(key)) continue;
      const refresh = await warmCargoDependencies({
        headSha,
        home: engine.store.home,
        cwd: run.cwd,
        command: step.command,
        toolchain: cargoToolchain(step),
        env,
        signal,
        timeoutMs: step.timeoutMs,
        secrets: engine.secrets,
      });
      refreshers.set(key, refresh);
    }
    await assertClean(
      run.cwd,
      headSha,
      'После cargo fetch изменились проверяемые файлы или HEAD',
      plan.unrelatedCargoLinks,
    );
  }
  const cache = plan.rust || plan.fallback ? null : await cacheContext(run, plan, headSha, env);
  const tests = plan.commands.filter(step => step.kind === 'test');
  // A simple npm script command is also counted by the plain `node --test` of the checked commit's package.json.
  const context = await npmContextFor(run.cwd, headSha, tests);
  const plans = plan.commands.map(step => (step.kind === 'test' ? countingPlan(step, context) : null));
  // The full suite is judged by its sum only when every test command is a `node --test` counted by
  // Kodo; an npm script's counting run is extra evidence that fails on its own zero only.
  const judged = plan.commands.every((step, index) => step.kind !== 'test' || plans[index]?.step);
  let passed = 0;
  for (const [index, step] of plan.commands.entries()) {
    engine.checkCancelled(run, signal);
    const counting = plans[index];
    const executeStep = () =>
      runStep({
        unrelatedCargoLinks: plan.unrelatedCargoLinks,
        engine,
        run,
        step,
        headSha,
        env,
        cache,
        counting,
        signal,
      });
    let outcome = await executeStep();
    if (outcome.cargoOfflineMiss && refreshers.has(cargoInvocation(step))) {
      const first = outcome.row;
      results.push(first);
      engine.save(run);
      await refreshers.get(cargoInvocation(step))();
      await assertClean(
        run.cwd,
        headSha,
        'После повторного cargo fetch изменились проверяемые файлы или HEAD',
        plan.unrelatedCargoLinks,
      );
      outcome = await executeStep();
      results.pop();
      Object.assign(outcome.row, { previousAttempt: first.evidence });
      if (outcome.cargoOfflineMiss) outcome.error = cargoFetchError(outcome.error.message);
    }
    const { row, error, noTests, unknown } = outcome;
    results.push(row);
    if (error?.diagnostics) {
      run.checks.diagnostics = error.diagnostics;
      run.lastDiagnostics = error.diagnostics;
    }
    engine.save(run);
    if (error) throw error;
    // A narrowed run that passed no test is replaced by the full suite.
    if (noTests && !plan.fallback) return { results, noTests: true };
    // A full `node --test` run whose outcome is unknown proves nothing (see summaryUnknown).
    if (plan.fallback && step.kind === 'test' && (unknown || (!counting && nodeTestCommand(step))))
      throw summaryUnknown(Boolean(counting?.step));
    passed += row.tests ?? 0;
  }
  if (plan.fallback && judged && passed === 0)
    throw fail(
      'Полный прогон commands.test (node --test) не выполнил успешно ни одного теста: все тесты пропущены (skip/todo) или не найдены',
      'fast_check_no_tests',
    );
  return { results, noTests: false };
}
