/**
 * Two-level verification of a wave project. A task done by an external chat is
 * checked once with the `task-fast` profile; the full verification (all
 * commands, behaviour gate, UI/security/architecture gates, one independent
 * review of the whole epic diff and `commands.smoke`) runs once per epic gate,
 * in its own gate Run on branch `kodo/<gate.runId>` from the integrated head.
 *
 * Gate Runs and external Runs are never executed by `Engine.run()`; this module
 * drives them under the same `run:<id>` lease.
 */
import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { execute } from './command.mjs';
import { git, makeWorktree } from './workspace.mjs';
import { redact, workerEnvironment } from './security.mjs';
import { validateCommandTimeouts } from './config.mjs';
import { inspectCurrentSource } from './ci-graph.mjs';
import { resolveMode } from './modes.mjs';
import { normalizeWatchdogConfig, resolveBlocker } from './watchdog.mjs';
import { currentBlocker } from './engine.mjs';
import { runFastChecks } from './task-fast-checks.mjs';
import { gateBindingFor } from './project-contracts.mjs';

/** The watchdog of a wave gate when the project sets none. */
export const GATE_WATCHDOG = Object.freeze({ stalledRounds: 2, rejectUnchanged: true });
const shaPattern = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const runIdPattern = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,100}$/;
const budgetKeys = ['researchBudget', 'repairRounds', 'concurrency', 'maxTasks'];
const passThrough = ['client', 'model', 'providers', 'mode', 'concurrency'];
const fail = (message, code) => Object.assign(new Error(message), { code });
const invalid = detail => fail(`Некорректный гейт эпика: ${detail}`, 'gate_invalid');
const nonEmpty = value => typeof value === 'string' && value.length > 0;

/**
 * The hash bound into a gate Run: SHA-256 of the JSON array of
 * `{taskId, attemptId, runId, mergeCommit}` in merge order.
 * @param {{ taskId: string, attemptId: string, runId: string, mergeCommit: string }[]} merges
 */
export function gateMergesHash(merges) {
  const rows = merges.map(({ taskId, attemptId, runId, mergeCommit }) => ({ taskId, attemptId, runId, mergeCommit }));
  return createHash('sha256').update(JSON.stringify(rows)).digest('hex');
}

/** The covered tasks of a gate, in merge order; the gate head must contain its base and every merge. */
async function coveredTasks({ project, gate, tasks }) {
  if (!gate || typeof gate !== 'object' || gate.schemaVersion !== 1) throw invalid('schemaVersion');
  if (!nonEmpty(gate.id) || !nonEmpty(gate.projectId)) throw invalid('id');
  if (!nonEmpty(gate.runId) || !runIdPattern.test(gate.runId)) throw invalid('runId');
  if (!Number.isSafeInteger(gate.number) || gate.number < 1) throw invalid('number');
  if (!shaPattern.test(gate.baseSha) || !shaPattern.test(gate.headSha)) throw invalid('baseSha/headSha');
  if (!project || !nonEmpty(project.root)) throw invalid('project.root');
  if (project.projectId !== undefined && project.projectId !== gate.projectId) throw invalid('projectId');
  if (!Array.isArray(gate.merges) || !gate.merges.length || !Array.isArray(tasks)) throw invalid('merges');
  const byId = new Map(tasks.map(task => [task?.id, task]));
  const covered = new Map();
  for (const merge of gate.merges) {
    const task = byId.get(merge?.taskId);
    if (
      !task ||
      !nonEmpty(merge.attemptId) ||
      !nonEmpty(merge.runId) ||
      !shaPattern.test(merge.mergeCommit) ||
      !Array.isArray(task.writePaths) ||
      !task.writePaths.length ||
      !task.writePaths.every(nonEmpty)
    )
      throw invalid(`merge ${String(merge?.taskId).slice(0, 80)}`);
    // A retried task keeps its latest merge.
    covered.delete(task.id);
    covered.set(task.id, { task, merge });
  }
  for (const commit of [gate.baseSha, ...gate.merges.map(merge => merge.mergeCommit)]) {
    const contained = await execute('git', ['merge-base', '--is-ancestor', commit, gate.headSha], {
      cwd: project.root,
      allowFailure: true,
    });
    if (contained.code !== 0) throw invalid(`${commit.slice(0, 12)} is not contained in the gate head`);
  }
  return [...covered.values()];
}

const acceptance = task => {
  const texts = (task.acceptance || []).map(item => (typeof item === 'string' ? item : item?.text)).filter(nonEmpty);
  return texts.length ? texts : [`${task.id} keeps its accepted behaviour`];
};

/**
 * Build the gate Run draft and install it through the store port.
 * `input`: optional `task` text and the Run options `client`, `model`, `providers`, `mode`, `concurrency`.
 * The port defaults to `engine.store.installGateRun(draft)`; its result is returned.
 * @param {{
 *   engine: any, project: any, gate: any, tasks: any[],
 *   input?: { task?: string, client?: string, model?: string, providers?: string, mode?: string, concurrency?: number },
 *   installGateRun?: (draft: any) => any,
 * }} options
 */
export async function createGateRunDraft({ engine, project, gate, tasks, input = {}, installGateRun }) {
  const install =
    installGateRun ??
    (typeof engine.store.installGateRun === 'function' ? draft => engine.store.installGateRun(draft) : null);
  if (typeof install !== 'function') throw fail('Не задан порт установки gate run', 'gate_install_unavailable');
  const covered = await coveredTasks({ project, gate, tasks });
  const ids = covered.map(({ task }) => task.id);
  const text =
    input.task ??
    `Epic gate ${gate.number}: verify the integrated result of tasks ${ids.join(', ')} ` +
      `(base ${gate.baseSha.slice(0, 12)}, head ${gate.headSha.slice(0, 12)}). ` +
      'Repair only confirmed failures inside the write paths of these tasks.';
  const options = Object.fromEntries(passThrough.filter(key => input[key] !== undefined).map(key => [key, input[key]]));
  // The gate never delivers: the coordinator merges and publishes.
  const prepared = await engine.prepareRun(
    text,
    { ...options, project: project.root, baseSha: gate.baseSha, delivery: 'none' },
    true,
  );
  const executionMode = resolveMode({
    requested: input.mode ?? prepared.config.executionMode ?? 'standard',
    config: prepared.config,
    concurrencyExplicit: prepared.requestedConcurrency != null,
  });
  const config = {
    ...prepared.config,
    watchdog: normalizeWatchdogConfig(project.execution?.watchdog ?? GATE_WATCHDOG),
  };
  for (const key of budgetKeys) config[key] = executionMode.profile[key];
  const draft = {
    ...prepared,
    config,
    id: gate.runId,
    createdAt: new Date().toISOString(),
    state: 'created',
    // Single source of truth with the store: installGateRun compares these bytes.
    directorBinding: gateBindingFor(gate),
    executionMode,
    plan: {
      summary: `Epic gate ${gate.number} over ${ids.length} integrated tasks`,
      tasks: covered.map(({ task }) => ({
        id: task.id,
        role: 'developer',
        description: String(task.description || task.title || task.id),
        dependsOn: [],
        writePaths: [...task.writePaths],
        acceptance: acceptance(task),
        parallel: false,
      })),
    },
    planSource: 'gate',
    nodes: Object.fromEntries(
      covered.map(({ task, merge }) => [
        task.id,
        {
          id: task.id,
          attempt: 0,
          status: 'integrated',
          headSha: merge.mergeCommit,
          sourceRunId: merge.runId,
          attemptId: merge.attemptId,
        },
      ]),
    ),
    completed: { implementation: true },
    headSha: gate.headSha,
    research: { items: [], requests: 0, errors: [], cache: [] },
  };
  await engine.initializeRun(draft);
  return await install(draft);
}

/** Hold `run:<id>` like Engine.run(): heartbeat, cancellation requests and the caller's signal. */
async function withRunLease(engine, id, signal, action) {
  const token = engine.store.acquireLease(`run:${id}`, id);
  if (!token) throw fail('Этот запуск уже исполняется', 'run_busy');
  const controller = new AbortController(),
    cancel = () => controller.abort();
  let leaseError;
  const heartbeat = setInterval(() => {
    if (!engine.store.renewLease(token)) {
      leaseError = fail('Потеряна блокировка запуска', 'lease_lost');
      cancel();
    }
  }, engine.leaseHeartbeatMs);
  heartbeat.unref();
  const cancellation = setInterval(() => {
    if (engine.store.getRun(id).cancelRequested) cancel();
  }, 500);
  cancellation.unref();
  signal?.addEventListener('abort', cancel, { once: true });
  if (signal?.aborted) cancel();
  try {
    return await action(controller.signal, () => leaseError);
  } finally {
    clearInterval(heartbeat);
    clearInterval(cancellation);
    signal?.removeEventListener('abort', cancel);
    engine.store.releaseLease(token);
  }
}

/** The gate worktree starts at the integrated head; repairs only add commits on top of it. */
async function gateWorktree(run) {
  const { headSha } = run.directorBinding;
  await makeWorktree(run.project, run.cwd, run.branch, headSha);
  const contained = await execute('git', ['merge-base', '--is-ancestor', headSha, 'HEAD'], {
    cwd: run.cwd,
    allowFailure: true,
  });
  if (contained.code !== 0) throw fail('Worktree гейта не содержит интегрированный head эпика', 'gate_head_mismatch');
}

/** Execute `commands.smoke` on the verified head and record `run.smoke`. */
async function runSmoke(engine, run, signal) {
  const commands = run.config.commands.smoke || [];
  const headSha = await git(run.cwd, ['rev-parse', 'HEAD']);
  const results = [];
  run.smoke = { schemaVersion: 1, headSha, configured: commands.length > 0, complete: false, results };
  run.state = 'verifying';
  engine.save(run);
  for (const { command, args = [], timeoutMs } of commands) {
    engine.checkCancelled(run, signal);
    const started = performance.now();
    let result, error;
    try {
      result = await execute(command, args, {
        cwd: run.cwd,
        signal,
        env: workerEnvironment(),
        secrets: engine.secrets,
        timeoutMs,
        allowFailure: true,
      });
    } catch (caught) {
      error = caught;
    }
    const output = result ?? error?.result ?? {},
      exitCode = result ? result.code : null,
      reason = error ? error.code || 'execution_failed' : undefined;
    const value = {
      command,
      args,
      exitCode,
      ...(reason ? { reason } : {}),
      durationMs: Math.round(performance.now() - started),
      stdout: typeof output.stdout === 'string' ? output.stdout : '',
      stderr: typeof output.stderr === 'string' ? output.stderr : '',
    };
    const evidence = await engine.persistEvidence(run, 'smoke', value, { headSha }).catch(persistError => {
      if (!error) throw persistError;
      return null;
    });
    results.push({
      command,
      args: [...args],
      exitCode,
      durationMs: value.durationMs,
      ...(reason ? { reason } : {}),
      ...(evidence
        ? {
            evidence: { path: evidence.path, sha256: evidence.sha256, bytes: evidence.bytes, headSha },
            outputPath: evidence.path,
            outputHash: evidence.sha256,
          }
        : {}),
    });
    engine.save(run);
    if (error) {
      if (signal?.aborted || error.code === 'cancelled') throw error;
      throw fail(`Smoke-проверка не завершилась (${reason})`, 'smoke_failed');
    }
    if ((await inspectCurrentSource({ project: run.cwd, headSha })) !== 'clean')
      throw fail('Smoke-проверка изменила проверяемый commit или файлы', 'dirty_worktree');
    if (exitCode !== 0)
      throw fail(
        `Smoke-проверка не пройдена (exit ${exitCode}): ${(value.stdout + value.stderr).slice(-6000)}`,
        'smoke_failed',
      );
  }
  run.smoke.complete = true;
  engine.save(run);
}

/** The stop of a gate Run, recorded like Engine.run() records it. */
function stopRun(engine, run, error, signal) {
  run.state = engine.store.getRun(run.id).cancelRequested
    ? 'cancelled'
    : error.code === 'lease_lost'
      ? 'blocked'
      : error.code === 'quota'
        ? 'waiting_limits'
        : error.code === 'cancelled' || signal.aborted
          ? 'cancelled'
          : 'blocked';
  run.error = {
    code: error.code || 'error',
    message: redact(error.message, engine.secrets),
    ...(error.retryAt ? { retryAt: error.retryAt } : {}),
  };
  if (['blocked', 'waiting_limits'].includes(run.state)) run.blocker = currentBlocker(run, error);
  engine.save(run);
  engine.log(run, run.state, run.error);
  return run;
}

/**
 * Verify an installed gate Run once, fully: checks, behaviour gate, UI/security/architecture
 * gates and one independent review, with bounded repair inside the covered write paths,
 * then `commands.smoke`. Ends `succeeded`, or `blocked`/`waiting_limits`/`cancelled` with a blocker.
 * @param {{ engine: any, run: any, signal?: AbortSignal }} input
 */
export async function runEpicGate({ engine, run: input, signal }) {
  const id = typeof input === 'string' ? input : input?.id;
  const stored = engine.store.getRun(id);
  if (stored.directorBinding?.kind !== 'gate' || stored.directorBinding.runId !== stored.id)
    throw fail('Это не gate run эпика', 'gate_run_invalid');
  if (stored.state === 'succeeded') return stored;
  return withRunLease(engine, id, signal, async (leased, leaseError) => {
    const run = engine.store.getRun(id);
    if (run.state === 'succeeded') return run;
    run.blocker = resolveBlocker(run.blocker, { at: new Date().toISOString(), outcome: 'resumed' });
    try {
      validateCommandTimeouts(run.config.commands);
      await gateWorktree(run);
      engine.checkCancelled(run, leased);
      await engine.selectModels(run);
      await engine.verify(run, leased);
      await runSmoke(engine, run, leased);
      engine.checkCancelled(run, leased);
      run.state = 'succeeded';
      run.error = null;
      run.blocker = resolveBlocker(run.blocker, { at: new Date().toISOString(), outcome: 'succeeded' });
      engine.save(run);
      engine.log(run, 'gate_succeeded', { headSha: run.headSha, smoke: run.smoke.results.length });
      return run;
    } catch (error) {
      return stopRun(engine, run, leaseError() || error, leased);
    }
  });
}

/**
 * One pass of the task-fast checks and the behaviour gate on the Run's current head, without
 * repair: the verdict for a task an external chat implemented. A pass records `run.headSha`.
 * @param {{ engine: any, run: any, signal?: AbortSignal }} input
 */
export async function verifyTaskFastOnce({ engine, run: input, signal }) {
  const id = typeof input === 'string' ? input : input?.id;
  engine.store.getRun(id);
  return withRunLease(engine, id, signal, async (leased, leaseError) => {
    const run = engine.store.getRun(id);
    run.checks = null;
    run.behavior = null;
    engine.save(run);
    try {
      await runFastChecks({ engine, run, signal: leased });
      await engine.behaviorGate(run, leased);
      if (run.behavior.headSha !== run.checks.headSha)
        throw fail('HEAD изменился между быстрыми проверками и behaviour gate', 'stale_checks');
      run.headSha = run.checks.headSha;
      engine.save(run);
      return { passed: true, headSha: run.headSha, checks: run.checks, behavior: run.behavior };
    } catch (caught) {
      const error = leaseError() || caught;
      if (leased.aborted || ['cancelled', 'quota', 'auth', 'lease_lost', 'evidence_integrity'].includes(error.code))
        throw error;
      return {
        passed: false,
        code: error.code || 'error',
        message: redact(String(error.message), engine.secrets).slice(0, 6000),
        headSha: run.checks?.headSha ?? null,
        checks: run.checks,
        behavior: run.behavior,
      };
    }
  });
}
