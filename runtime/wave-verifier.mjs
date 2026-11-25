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
import { buildGateInput, buildGateManifest, gateBindingFor, gateReviewCriteria } from './project-contracts.mjs';
import { applyWavePolicy, assertWavePolicy } from './wave-policy.mjs';
import { gateRange, gateRepairInScope, integrationHeadOf } from './project-integration.mjs';
import { buildDiagnosticPack } from './diagnostic-pack.mjs';
import { modulesFromWritePaths, verifiedLessonSummaries } from './context-pack.mjs';
import { arbitrableRefusal, arbitrateGate, arbitrationAccepts, arbitrationStop } from './gate-arbiter.mjs';

/** The watchdog of a wave gate when the project sets none. */
export const GATE_WATCHDOG = Object.freeze({ stalledRounds: 2, rejectUnchanged: true });
/** The fewest repair rounds of a gate Run in any mode (a repair is verified again). */
export const GATE_MIN_REPAIR_ROUNDS = 2;
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

/** The merge the task's own Run recorded: its parents are exactly the recorded `before` and verified head. */
function assertMergeOfAttempt(engine, parents, merge) {
  let run = null;
  try {
    run = engine.store.getRun(merge.runId);
  } catch {
    /* A missing task Run is reported below. */
  }
  const integration = run?.integration;
  if (
    integration?.status !== 'merged' ||
    integration.mergeCommit !== merge.mergeCommit ||
    !shaPattern.test(run.headSha) ||
    !shaPattern.test(integration.before) ||
    integration.mergedHead !== run.headSha
  )
    throw invalid(`merge ${merge.taskId} is not the recorded integration of its attempt`);
  const [first, second] = parents.get(merge.mergeCommit) ?? [];
  if (first !== integration.before || second !== run.headSha)
    throw invalid(`merge ${merge.taskId} does not merge the head of its attempt`);
}

/** The covered tasks of a gate, in merge order; its range must hold every merge of their attempts. */
async function coveredTasks({ engine, project, gate, tasks }) {
  if (!gate || typeof gate !== 'object' || gate.schemaVersion !== 1) throw invalid('schemaVersion');
  if (!nonEmpty(gate.id) || !nonEmpty(gate.projectId)) throw invalid('id');
  if (!nonEmpty(gate.runId) || !runIdPattern.test(gate.runId)) throw invalid('runId');
  if (!Number.isSafeInteger(gate.number) || gate.number < 1) throw invalid('number');
  if (!shaPattern.test(gate.baseSha) || !shaPattern.test(gate.headSha)) throw invalid('baseSha/headSha');
  if (!project || !nonEmpty(project.root)) throw invalid('project.root');
  if (project.projectId !== gate.projectId) throw invalid('projectId');
  if (!Array.isArray(gate.merges) || !gate.merges.length || !Array.isArray(tasks)) throw invalid('merges');
  const byId = new Map(tasks.map(task => [task?.id, task]));
  const covered = [];
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
    covered.push({ task, merge });
  }
  // The reviewed range is gate.baseSha..gate.headSha: the base is the first parent of the
  // earliest covered merge on the branch history, so the range holds every covered merge.
  const parents = await gateRange({
    cwd: project.root,
    baseSha: gate.baseSha,
    headSha: gate.headSha,
    mergeCommits: gate.merges.map(merge => merge.mergeCommit),
  });
  if (!parents) throw invalid('baseSha is not the parent of the earliest covered merge on the gate head');
  for (const merge of gate.merges) assertMergeOfAttempt(engine, parents, merge);
  return covered;
}

/** The gate head must still be the head of the project integration branch (under its lease). */
async function assertIntegrationHead(project, gate) {
  if ((await integrationHeadOf({ cwd: project.root, projectId: gate.projectId })) !== gate.headSha)
    throw fail('Голова интеграционной ветки проекта не равна head гейта', 'gate_head_stale');
}

/** An installed gate's Run, replayed through the store before any head check (null when none). */
async function installedRun({ engine, project, gate, tasks, containers, installGateRun }) {
  let stored = null;
  try {
    stored = engine.store.getRun(gate.runId);
  } catch {
    return null;
  }
  if (!stored) return null;
  const byId = new Map((tasks || []).map(task => [task?.id, task]));
  const covered = (Array.isArray(gate.merges) ? gate.merges : []).map(merge => byId.get(merge?.taskId));
  if (!covered.length || covered.some(task => !task)) return null; // coveredTasks reports it.
  // The store returns its saved Run only for this exact binding and gate input.
  return installGateRun({
    binding: gateBindingFor(gate),
    runDraft: {
      id: gate.runId,
      project: project.root,
      task: buildGateInput({ project, gate, tasks: covered, containers }),
      directorBinding: gateBindingFor(gate),
    },
  });
}

const acceptance = task => {
  const texts = (task.acceptance || []).map(item => (typeof item === 'string' ? item : item?.text)).filter(nonEmpty);
  return texts.length ? texts : [`${task.id} keeps its accepted behaviour`];
};

/**
 * Build the gate Run draft and install it through the project store:
 * `installGateRun({ binding: gateBindingFor(gate), runDraft })` (e.g. `projectStore.installGateRun`).
 * `project` and `tasks` are the stored records of the snapshot and `containers` the criteria of
 * the gate's containers (`gateContainerCriteria(snapshot, gate)`); `runDraft.task` is
 * `buildGateInput({ project, gate, tasks: covered tasks in merge order, containers })`.
 * The draft verifies under the policy of the gate head (`applyWavePolicy`) and its review
 * confirms every criterion of the manifest (`runDraft.gateCriteria`).
 * `input`: the Run options `client`, `model`, `providers`, `mode`, `concurrency`.
 * The caller serializes integration: pass `withLease` (runs the head check and the install
 * inside lease `project-integration:<projectId>`) or `leaseHeld: true` when it already holds it.
 * @param {{
 *   engine: any, project: any, gate: any, tasks: any[], containers: any[],
 *   input?: { client?: string, model?: string, providers?: string, mode?: string, concurrency?: number },
 *   installGateRun: (input: { binding: any, runDraft: any }) => any,
 *   withLease?: <T>(work: () => Promise<T>) => Promise<T>, leaseHeld?: boolean,
 * }} options
 */
export async function createGateRunDraft({
  engine,
  project,
  gate,
  tasks,
  containers,
  input = {},
  installGateRun,
  withLease,
  leaseHeld = false,
}) {
  if (typeof installGateRun !== 'function') throw fail('Не задан порт установки gate run', 'gate_install_unavailable');
  if (withLease !== undefined && typeof withLease !== 'function') throw invalid('withLease');
  if (withLease === undefined && leaseHeld !== true)
    throw fail('Черновик гейта требует lease project-integration проекта', 'gate_lease_required');
  const work = async () => {
    // An exact repeat of a finished install returns its Run even after the branch moved on.
    const replayed = await installedRun({ engine, project, gate, tasks, containers, installGateRun });
    if (replayed) return replayed;
    const covered = await coveredTasks({ engine, project, gate, tasks });
    await assertIntegrationHead(project, gate);
    const runDraft = await gateDraft({ engine, project, gate, covered, containers, input });
    return await installGateRun({ binding: gateBindingFor(gate), runDraft });
  };
  return withLease ? await withLease(work) : await work();
}

async function gateDraft({ engine, project, gate, covered, containers, input }) {
  const ids = covered.map(({ task }) => task.id);
  const knownValues = Object.values(engine.secrets || {}).filter(value => typeof value === 'string');
  const manifestInput = { project, gate, tasks: covered.map(({ task }) => task), containers };
  // Single source of truth with the store: installGateRun compares these bytes.
  const text = buildGateInput(manifestInput, { knownValues });
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
  // A repair needs a re-verification round: even quick mode gets two.
  config.repairRounds = Math.max(GATE_MIN_REPAIR_ROUNDS, config.repairRounds);
  const draft = {
    ...prepared,
    config,
    id: gate.runId,
    createdAt: new Date().toISOString(),
    state: 'created',
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
  // The gate executes the verification policy of its head, which holds every covered merge.
  await applyWavePolicy(draft, gate.headSha, { secrets: engine.secrets });
  await engine.initializeRun(draft);
  // The full list and contracts of the covered tasks and the criteria of the covered containers:
  // an immutable evidence artifact whose canonical SHA-256 the gate input (draft.task) binds.
  const { manifest } = buildGateManifest(manifestInput, { knownValues });
  draft.gateManifest = await engine.persistEvidence(draft, 'gate-manifest', manifest, { headSha: gate.headSha });
  // The independent review confirms each of them (review.criteria).
  draft.gateCriteria = gateReviewCriteria(manifest);
  const coveredWritePaths = covered.flatMap(({ task }) => task.writePaths || []);
  const epicIds = [
    ...new Set([
      ...(gate.containers || []).filter(c => c.kind === 'epic').map(c => c.id),
      ...covered.map(({ task }) => task.epicId).filter(nonEmpty),
    ]),
  ];
  draft.gateScope = {
    epicIds,
    modules: modulesFromWritePaths(coveredWritePaths),
    writePaths: [...new Set(coveredWritePaths)],
  };
  return draft;
}

function verifiedGateCheckReceipt(run) {
  const checks = run.checks;
  if (
    checks?.complete !== true ||
    typeof checks.headSha !== 'string' ||
    checks.headSha !== run.headSha ||
    checks.passed === false ||
    (checks.status !== undefined && checks.status !== 'passed') ||
    !Array.isArray(checks.results) ||
    !checks.results.length
  )
    return null;
  const results = checks.results.map(item => ({
    command: item?.command,
    exitCode: item?.exitCode,
    ...(item?.status !== undefined ? { status: item.status } : {}),
    ...(item?.passed !== undefined ? { passed: item.passed } : {}),
  }));
  const allPassed = results.every(
    item => item.exitCode === 0 && item.passed !== false && (item.status === undefined || item.status === 'passed'),
  );
  if (!allPassed) return null;
  return {
    complete: true,
    headSha: checks.headSha,
    ...(checks.status !== undefined ? { status: checks.status } : {}),
    results,
  };
}

function verifiedGateCriterionIds(run) {
  const criteria = run.review?.criteria;
  if (!Array.isArray(criteria) || !criteria.length) return null;
  if (!criteria.every(row => row && row.met === true && typeof row.id === 'string' && row.id.trim())) return null;
  const ids = [...new Set(criteria.map(row => row.id.trim()))];
  if (
    Array.isArray(run.gateCriteria) &&
    run.gateCriteria.length > 0 &&
    !run.gateCriteria.every(row => ids.includes(row.id))
  )
    return null;
  return ids;
}

/**
 * Record a head-verified, criterion-bound gate lesson (<= 200 Unicode chars, bound to `run.headSha`,
 * passing checks and passing review, redacted, without raw review findings) into
 * the project's knowledge store so subsequent tasks of the same module/epic receive it.
 * @param {any} engine
 * @param {any} run
 */
export function recordGateLesson(engine, run) {
  if (!engine?.store || !run || run.directorBinding?.kind !== 'gate') return null;
  const rawLesson =
    typeof run.review?.lesson === 'string' ? run.review.lesson : typeof run.lesson === 'string' ? run.lesson : '';
  const trimmed = redact(rawLesson.trim(), engine.secrets || {});
  if (!trimmed) return null;
  if (!shaPattern.test(run.headSha) || run.review?.passed !== true || run.review.headSha !== run.headSha) return null;
  const checks = verifiedGateCheckReceipt(run);
  const criterionIds = verifiedGateCriterionIds(run);
  if (!checks || !criterionIds) return null;
  const chars = Array.from(trimmed);
  const summary = chars.length <= 200 ? trimmed : chars.slice(0, 199).join('') + '…';
  const scope = run.gateScope ?? {
    epicIds: [],
    modules: modulesFromWritePaths((run.plan?.tasks || []).flatMap(task => task.writePaths || [])),
    writePaths: [...new Set((run.plan?.tasks || []).flatMap(task => task.writePaths || []))],
  };
  const candidate = {
    runId: run.id,
    headSha: run.headSha,
    summary,
    lesson: summary,
    kind: 'gate-lesson',
    projectId: run.directorBinding.projectId,
    gateId: run.directorBinding.gateId,
    criterionIds,
    epicIds: [...new Set(scope.epicIds || [])],
    modules: [...new Set(scope.modules || [])],
    writePaths: [...new Set(scope.writePaths || [])],
    checks,
    review: { passed: true, headSha: run.headSha },
  };
  if (!verifiedLessonSummaries([candidate], 1, { includeGateLessons: true, requireCriteria: true }).length) return null;
  if (typeof engine.store.rememberLesson === 'function')
    return engine.store.rememberLesson(run.project, run.id, candidate);
  return null;
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
async function gateWorktree(run, leased) {
  const { headSha } = run.directorBinding;
  await makeWorktree(run.project, run.cwd, run.branch, headSha, { signal: leased });
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
 * With `arbitration` (the project's execution profile and the current time), a review refusal
 * after the exhausted repair cycle, with every deterministic check green including smoke, goes to
 * the gate arbiter on another subscription once per Run (`gate-arbiter.mjs`).
 * @param {{ engine: any, run: any, signal?: AbortSignal, arbitration?: { profile?: any, now?: number } | null }} input
 */
export async function runEpicGate({ engine, run: input, signal, arbitration = null }) {
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
      await gateWorktree(run, leased);
      engine.checkCancelled(run, leased);
      await engine.selectModels(run);
      let refusal = null;
      try {
        await engine.verify(run, leased);
      } catch (error) {
        refusal = arbitration ? await arbitrableRefusal({ engine, run, error, ...arbitration }) : null;
        if (!refusal) throw error;
      }
      // A refused review leaves run.headSha on the last accepted head: the reviewed head is checked.
      const verifiedHead = refusal?.headSha ?? run.headSha;
      // Repairs may move the verified head past the gate head, but only by
      // descendants that change the covered tasks' write paths.
      const writePaths = run.plan.tasks.flatMap(task => task.writePaths);
      if (
        !(await gateRepairInScope({
          worktree: run.cwd,
          from: run.directorBinding.headSha,
          to: verifiedHead,
          writePaths,
        }))
      )
        throw fail('Проверенный head гейта не продолжает head гейта в пределах writePaths задач', 'gate_scope');
      // The verified head keeps the policy the gate executed (a repair may not change it).
      await assertWavePolicy({
        run,
        policyCommit: run.directorBinding.headSha,
        headSha: verifiedHead,
        secrets: engine.secrets,
      }).catch(error => {
        if (error?.code === 'project_wave_policy_unsafe')
          throw fail('Политика проверок гейта содержит секрет или редактируемое значение', 'wave_policy_unsafe');
        if (!['project_wave_policy_mismatch', 'project_wave_policy_invalid'].includes(error?.code)) throw error;
        throw fail('Политика проверок проверенного head гейта отличается от исполненной', 'wave_policy_mismatch');
      });
      await runSmoke(engine, run, leased);
      engine.checkCancelled(run, leased);
      if (refusal) {
        // Smoke passed on the reviewed head too: only the review's findings are in dispute.
        const record = await arbitrateGate({ engine, run, refusal, signal: leased });
        engine.checkCancelled(run, leased);
        const accepted = run.headSha;
        run.headSha = verifiedHead;
        if (!arbitrationAccepts(run)) {
          run.headSha = accepted;
          throw arbitrationStop(refusal.error, record);
        }
      }
      run.state = 'succeeded';
      run.error = null;
      run.blocker = resolveBlocker(run.blocker, { at: new Date().toISOString(), outcome: 'succeeded' });
      const recordedLesson = recordGateLesson(engine, run);
      if (recordedLesson) run.gateLesson = { headSha: run.headSha, lesson: recordedLesson.lesson };
      engine.save(run);
      engine.log(run, 'gate_succeeded', {
        headSha: run.headSha,
        smoke: run.smoke.results.length,
        ...(refusal ? { arbitration: run.gateArbitration.decision } : {}),
      });
      return run;
    } catch (error) {
      return stopRun(engine, run, leaseError() || error, leased);
    }
  });
}

/**
 * One pass of the task-fast checks and the behaviour gate on the Run's current head, without
 * repair: the verdict for a task an external chat implemented. A pass records `run.headSha`.
 * A Run whose integration started (or recorded a completion) keeps its proof: the verdict is
 * `{ passed: false, skipped: true, code: 'run_integrated' }` without touching the Run. With
 * `expectedHeadSha`, a worktree that moved to another head is `{ skipped: true, code: 'head_changed' }`
 * and its proof is kept as well.
 * @param {{ engine: any, run: any, signal?: AbortSignal, maxHeavyBuilds?: number, expectedHeadSha?: string }} input
 */
export async function verifyTaskFastOnce({ engine, run: input, signal, maxHeavyBuilds = 1, expectedHeadSha }) {
  const id = typeof input === 'string' ? input : input?.id;
  engine.store.getRun(id);
  return withRunLease(engine, id, signal, async (leased, leaseError) => {
    const run = engine.store.getRun(id);
    if (['merged', 'pending'].includes(run.integration?.status) || run.externalCompletion)
      return { passed: false, skipped: true, code: 'run_integrated', headSha: run.headSha ?? null };
    if (expectedHeadSha !== undefined) {
      const current = await execute('git', ['rev-parse', 'HEAD'], { cwd: run.cwd, allowFailure: true });
      if (current.code !== 0 || current.stdout.trim() !== expectedHeadSha)
        return { passed: false, skipped: true, code: 'head_changed', headSha: current.stdout.trim() || null };
    }
    run.checks = null;
    run.behavior = null;
    engine.save(run);
    try {
      await runFastChecks({ engine, run, signal: leased, maxHeavyBuilds });
      await engine.behaviorGate(run, leased);
      if (run.behavior.headSha !== run.checks.headSha)
        throw fail('HEAD изменился между быстрыми проверками и behaviour gate', 'stale_checks');
      run.headSha = run.checks.headSha;
      run.lastDiagnostics = null;
      engine.save(run);
      return { passed: true, headSha: run.headSha, checks: run.checks, behavior: run.behavior };
    } catch (caught) {
      const error = leaseError() || caught;
      if (
        leased.aborted ||
        ['cancelled', 'quota', 'auth', 'lease_lost', 'project_lease_lost', 'evidence_integrity'].includes(error.code)
      )
        throw error;
      const diagnostics = buildDiagnosticPack({
        checks: run.checks,
        behavior: run.behavior,
        error,
        secrets: engine.secrets,
      });
      run.lastDiagnostics = diagnostics;
      engine.save(run);
      return {
        passed: false,
        code: error.code || 'error',
        message: redact(String(error.message), engine.secrets).slice(0, 6000),
        diagnostics,
        headSha: run.checks?.headSha ?? null,
        checks: run.checks,
        behavior: run.behavior,
      };
    }
  });
}
