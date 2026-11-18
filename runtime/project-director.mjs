import path from 'node:path';
import { realpath, readFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { git, diffHash } from './workspace.mjs';
import { execute } from './command.mjs';
import { inspectCurrentSource } from './ci-graph.mjs';
import { readConfig, validateCommandTimeouts } from './config.mjs';
import { resolveMode } from './modes.mjs';
import {
  gateRange,
  gateRepairInScope,
  integrationBranch,
  integrationHeadOf,
  mergeOnBranch,
  treesDiffer,
} from './project-integration.mjs';
import { integrationLeaseHeld } from './project-integration-lease.mjs';

const fail = code => {
  throw Object.assign(new Error(`Project ${code}`), { code: `project_${code}` });
};
const requireValue = (value, code = 'proof_invalid') => {
  if (!value) fail(code);
};
const settled = value => ['accepted', 'released'].includes(value);
const retryable = value => ['blocked', 'failed', 'cancelled'].includes(value);
const stages = ['ready', 'running', 'verifying', 'integrated', 'accepted', 'released'];
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export const known = engine => Object.values(engine.secrets || {}).filter(value => typeof value === 'string');
export const bindingFor = attempt => ({
  schemaVersion: 1,
  projectId: attempt.projectId,
  taskId: attempt.taskId,
  taskRevision: attempt.taskRevision,
  attemptId: attempt.id,
  runId: attempt.runId,
  contractHash: attempt.contractHash,
});
const canonical = async value => {
  const root = await realpath(value);
  return process.platform === 'win32' ? root.toLowerCase() : root;
};
function complete(snapshot) {
  for (const name of ['milestones', 'epics', 'tasks', 'currentAttempts', 'riskApprovals']) {
    const count = snapshot.completeness?.[name];
    requireValue(
      count?.complete === true && count.total === snapshot[name]?.length && count.returned === count.total,
      'snapshot_incomplete',
    );
  }
}
function control(snapshot, allowReleased = false) {
  complete(snapshot);
  requireValue(
    !snapshot.project.paused &&
      !['cancelled', 'failed', 'blocked', ...(allowReleased ? [] : ['released'])].includes(snapshot.project.status),
    'control_blocked',
  );
}
export function storedRun(store, id) {
  // Missing is distinguished from a corrupt/closed Store. No raw DB access.
  try {
    return store.getRun(id);
  } catch (error) {
    if (error.message === `Запуск не найден: ${id}`) return null;
    throw error;
  }
}
async function contractsFor(contracts) {
  return contracts || (await import('./project-contracts.mjs'));
}
async function evidenceFor(evaluator) {
  return evaluator || (await import('./project-evidence.mjs'));
}
export async function verifyRef(engine, ref, run, container = false) {
  requireValue(typeof engine.assertEvidence === 'function');
  if (run && ref.kind !== 'interface') {
    const root = await realpath(path.join(run.artifacts, 'evidence')),
      file = await realpath(ref.path);
    const relative = path.relative(root, file);
    requireValue(relative && !relative.startsWith('..') && !path.isAbsolute(relative));
  }
  await engine.assertEvidence(ref);
  if (run && ['acceptance', 'contract', 'checks', 'review', 'delivery', 'release'].includes(ref.kind)) {
    const envelope = JSON.parse(await readFile(ref.path, 'utf8'));
    if (container && ['acceptance', 'contract'].includes(ref.kind)) {
      // Own mappings may reference independently supplied immutable observations.
      // The generic Task success observation is never a container's own proof.
      requireValue(!['project-acceptance', 'project-contract'].includes(envelope.kind));
      return;
    }
    requireValue(
      envelope.kind === `project-${ref.kind}` && isDeepStrictEqual(envelope.value, observation(run, ref.kind)),
    );
  }
}
export function observation(run, kind) {
  if (kind === 'acceptance')
    return { directorBinding: run.directorBinding, task: run.task, checks: run.checks, review: run.review };
  if (kind === 'contract') return { directorBinding: run.directorBinding, task: run.task };
  return run[kind];
}
// The task Run of the current attempt, bound to the frozen task contract.
function assertAttemptBinding({ contracts, snapshot, run, options }) {
  const attempt = snapshot.currentAttempts.find(row => row.runId === run.id),
    task = snapshot.tasks.find(row => row.id === attempt?.taskId);
  requireValue(
    attempt &&
      task &&
      isDeepStrictEqual(run.directorBinding, bindingFor(attempt)) &&
      attempt.taskRevision === task.revision &&
      attempt.contractHash === contracts.directorContractHash(task, options) &&
      run.task === contracts.buildDirectorTaskInput({ project: snapshot.project, task }, options),
    'binding_invalid',
  );
}
async function validateRun({ store, engine, contracts, snapshot, run, publication = false }) {
  const options = { knownValues: known(engine) };
  contracts.assertDirectorSafe(run, options);
  requireValue(isDeepStrictEqual(run, store.getRun(run.id)), 'run_changed');
  assertAttemptBinding({ contracts, snapshot, run, options });
  await assertRunSource(snapshot, run);
  await assertFullReceipts(engine, run);
  if (publication) await assertPublication(engine, run);
  requireValue((await inspectCurrentSource({ project: run.cwd, headSha: run.headSha })) === 'clean', 'head_changed');
}
// Same root, same verification config, an unstopped Run and a clean verified head.
async function assertRunSource(snapshot, run) {
  requireValue((await canonical(run.project)) === snapshot.project.projectKey, 'root_changed');
  for (const root of new Set([run.project, run.cwd])) {
    const current = await readConfig(root, { client: run.client });
    for (const field of [
      'commands',
      'checks',
      'security',
      'uiVerification',
      'architecture',
      'repository',
      'baseBranch',
    ])
      requireValue(isDeepStrictEqual(current[field], run.config[field]), 'config_changed');
    if (run.fixedModel)
      requireValue(current.models[run.fixedModel.client]?.includes(run.fixedModel.model), 'model_unavailable');
  }
  requireValue(
    !run.cancelRequested && !['cancelled', 'blocked', 'failed', 'waiting_limits'].includes(run.state),
    'run_blocked',
  );
  requireValue((await inspectCurrentSource({ project: run.cwd, headSha: run.headSha })) === 'clean', 'head_changed');
}
// Full checks with their logs, the independent review and every enabled gate on the verified head.
async function assertFullReceipts(engine, run) {
  validateCommandTimeouts(run.config.commands);
  const expected = ['test', 'build'].flatMap(kind => run.config.commands[kind].map(command => ({ kind, command })));
  const fingerprint = hash({
    headSha: run.headSha,
    expected,
    runtime: { node: process.version, abi: process.versions.modules, platform: process.platform, arch: process.arch },
  });
  requireValue(
    run.config.commands.test.length &&
      run.checks?.schemaVersion === 2 &&
      // A profiled receipt (task-fast) never stands in for the full checks, even with full logs.
      !Object.hasOwn(run.checks, 'profile') &&
      run.verificationProfile === undefined &&
      run.checks.complete === true &&
      run.checks.headSha === run.headSha &&
      run.checks.fingerprint === fingerprint &&
      run.checks.results?.length === expected.length,
    'checks_stale',
  );
  for (let index = 0; index < expected.length; index++) {
    const row = run.checks.results[index];
    requireValue(
      row.exitCode === 0 &&
        row.kind === expected[index].kind &&
        isDeepStrictEqual(row.command, expected[index].command) &&
        row.outputPath &&
        row.outputHash,
      'checks_stale',
    );
    await engine.assertEvidence({ path: row.outputPath, sha256: row.outputHash, headSha: run.headSha });
    const log = JSON.parse(await readFile(row.outputPath, 'utf8'));
    requireValue(
      log.kind === 'check' &&
        log.value.exitCode === 0 &&
        log.value.kind === row.kind &&
        isDeepStrictEqual(log.value.command, row.command),
    );
  }
  requireValue(
    run.review?.passed === true &&
      run.review.headSha === run.headSha &&
      run.review.sessionId &&
      !run.review.findings?.some(row => ['major', 'blocker'].includes(row.severity)) &&
      run.review.diffHash === (await diffHash(run.cwd, run.baseSha)),
    'review_stale',
  );
  for (const [field, setting, method] of [
    ['uiVerification', 'uiVerification', 'isCurrentUIReceipt'],
    ['securityChecks', 'security', 'isCurrentSecurityReceipt'],
    ['architectureChecks', 'architecture', 'isCurrentArchitectureReceipt'],
  ]) {
    const config = run.config[setting];
    requireValue(typeof config?.enabled === 'boolean', 'gate_unknown');
    if (config.enabled)
      requireValue(
        typeof engine.gates?.[method] === 'function' &&
          (await engine.gates[method](run[field], {
            cwd: run.cwd,
            headSha: run.headSha,
            baseSha: run.baseSha,
            config,
          })) === true,
        'gate_stale',
      );
  }
}
async function assertPublication(engine, run) {
  requireValue(
    run.config.delivery?.enabled &&
      run.delivery?.mergeCommit &&
      run.delivery.reviewedHead === run.headSha &&
      typeof engine.delivery?.reconcileDelivery === 'function',
    'publication_unverified',
  );
  const reconciled = await engine.delivery.reconcileDelivery({
    run: structuredClone(run),
    config: run.config,
    cwd: run.cwd,
    secrets: engine.secrets || {},
  });
  requireValue(
    reconciled?.mergeCommit === run.delivery.mergeCommit && reconciled.reviewedHead === run.headSha,
    'publication_unverified',
  );
  requireValue(
    run.release?.published === true &&
      run.release.commit === reconciled.mergeCommit &&
      run.delivery.release &&
      isDeepStrictEqual(run.delivery.release, run.release),
    'publication_unverified',
  );
}

// Each journal of a receipt row exists, is intact, belongs to the verified head and
// records exactly that passing command.
async function assertLogs(engine, run, rows, kind) {
  for (const row of rows) {
    await engine.assertEvidence({ path: row.outputPath, sha256: row.outputHash, headSha: run.headSha });
    const log = JSON.parse(await readFile(row.outputPath, 'utf8'));
    requireValue(
      log.kind === kind &&
        log.value.exitCode === 0 &&
        isDeepStrictEqual(log.value.command, row.command) &&
        isDeepStrictEqual(log.value.args ?? [], row.args ?? []),
      'checks_stale',
    );
  }
}

const contains = async (cwd, commit, head) =>
  (await execute('git', ['merge-base', '--is-ancestor', commit, head], { cwd, allowFailure: true })).code === 0;

// A recorded merge of a task Run is still on the integration branch: reachable from its current
// head, with exactly the recorded `before` (first) and the verified head (second) as parents.
async function assertTaskMerge(snapshot, run) {
  if (run.integration?.status !== 'merged') return;
  const projectId = snapshot.project.projectId;
  requireValue(
    run.integration.branch === integrationBranch(projectId) &&
      run.integration.mergedHead === run.headSha &&
      (await mergeOnBranch({
        cwd: run.project,
        branchHead: await integrationHeadOf({ cwd: run.project, projectId }),
        mergeCommit: run.integration.mergeCommit,
        before: run.integration.before,
        mergedHead: run.headSha,
      })),
    'integration_invalid',
  );
}

// The gate manifest artifact: intact, in the gate Run's evidence, on the gate head, and equal to
// the manifest of the covered tasks whose SHA-256 the gate input (run.task) binds.
async function assertGateManifest({ engine, contracts, snapshot, run, gate, tasks, options }) {
  const ref = run.gateManifest;
  requireValue(
    typeof contracts.buildGateManifest === 'function' && ref?.headSha === gate.headSha,
    'gate_manifest_invalid',
  );
  await verifyRef(engine, { kind: 'gate-manifest', path: ref.path, sha256: ref.sha256, headSha: ref.headSha }, run);
  const envelope = JSON.parse(await readFile(ref.path, 'utf8'));
  const { manifest } = contracts.buildGateManifest({ project: snapshot.project, gate, tasks }, options);
  requireValue(
    envelope.kind === 'gate-manifest' &&
      envelope.baseSha === gate.baseSha &&
      isDeepStrictEqual(envelope.value, manifest),
    'gate_manifest_invalid',
  );
}

// The gate's range and everything it accepts are on the integration branch now (the caller holds
// lease project-integration until the transition commits): the reviewed range
// gate.baseSha..run.headSha is non-empty and holds every covered merge, each covered merge is
// still its task Run's recorded merge on the branch, and the verified head is in the branch.
async function assertGateOnBranch({ store, snapshot, run, gate }) {
  const cwd = run.project,
    mergeCommits = gate.merges.map(merge => merge.mergeCommit);
  requireValue(
    run.baseSha === gate.baseSha &&
      (await gateRange({ cwd, baseSha: gate.baseSha, headSha: gate.headSha, mergeCommits })) &&
      (await treesDiffer({ cwd, from: gate.baseSha, to: run.headSha })),
    'gate_range_invalid',
  );
  const branchHead = await integrationHeadOf({ cwd, projectId: snapshot.project.projectId });
  const onBranch = branchHead && (await gateRange({ cwd, baseSha: gate.baseSha, headSha: branchHead, mergeCommits }));
  requireValue(onBranch && (await contains(cwd, run.headSha, branchHead)), 'integration_invalid');
  for (const merge of gate.merges) {
    const taskRun = storedRun(store, merge.runId),
      integration = taskRun?.integration,
      [first, second] = onBranch.get(merge.mergeCommit);
    requireValue(
      integration?.status === 'merged' &&
        integration.mergeCommit === merge.mergeCommit &&
        integration.mergedHead === taskRun.headSha &&
        first === integration.before &&
        second === taskRun.headSha,
      'integration_invalid',
    );
  }
}

// Wave Runs: a task Run (native or of an external chat, always profile task-fast)
// carries the task-fast receipt once it succeeded; before that it proves only its
// binding and source, and the evaluator grants it at most running/verifying. A gate
// Run is bound to its gate record, carries the full receipts and smoke logs, its
// verified head descends from the gate head inside the covered tasks' write paths
// and is already contained in the integration branch.
async function validateWaveRun({ store, engine, contracts, snapshot, run, gate }) {
  const options = { knownValues: known(engine) };
  contracts.assertDirectorSafe(run, options);
  requireValue(isDeepStrictEqual(run, store.getRun(run.id)), 'run_changed');
  if (!gate) {
    assertAttemptBinding({ contracts, snapshot, run, options });
    requireValue(run.verificationProfile === 'task-fast', 'checks_stale');
    await assertRunSource(snapshot, run);
    if (run.state === 'succeeded') {
      requireValue(run.checks?.profile === 'task-fast' && Array.isArray(run.checks.results), 'checks_stale');
      await assertLogs(engine, run, run.checks.results, 'fast-check');
      await assertTaskMerge(snapshot, run);
    }
  } else {
    const tasks = gate.merges.map(merge => snapshot.tasks.find(row => row.id === merge.taskId));
    requireValue(
      tasks.every(Boolean) &&
        JSON.stringify(run.directorBinding) === JSON.stringify(contracts.gateBindingFor(gate, options)) &&
        run.task === contracts.buildGateInput({ project: snapshot.project, gate, tasks }, options),
      'binding_invalid',
    );
    await assertRunSource(snapshot, run);
    await assertFullReceipts(engine, run);
    requireValue(Array.isArray(run.smoke?.results), 'smoke_stale');
    await assertLogs(engine, run, run.smoke.results, 'smoke');
    const writePaths = tasks.flatMap(task => task.writePaths);
    requireValue(
      await gateRepairInScope({ worktree: run.cwd, from: gate.headSha, to: run.headSha, writePaths }),
      'gate_scope',
    );
    await assertGateManifest({ engine, contracts, snapshot, run, gate, tasks, options });
    // Nothing is accepted that the integration branch does not contain (mergeBackGate first).
    await assertGateOnBranch({ store, snapshot, run, gate });
  }
  requireValue((await inspectCurrentSource({ project: run.cwd, headSha: run.headSha })) === 'clean', 'head_changed');
}

// The Run a wave transition is decided by: the task Run of the current attempt
// for ready..integrated, the one gate Run named by the evidence for accepted.
async function waveInput(store, snapshot, action) {
  if (action.to === 'accepted') {
    const ids = new Set(action.evidence.map(ref => ref.runId).filter(Boolean));
    const gates = snapshot.gates.filter(gate => ids.has(gate.runId));
    requireValue(gates.length === 1, 'binding_invalid');
    const run = storedRun(store, gates[0].runId);
    requireValue(run, 'binding_invalid');
    const integrationHead =
      action.kind === 'project'
        ? await integrationHeadOf({ cwd: snapshot.project.root, projectId: snapshot.project.projectId })
        : undefined;
    return { run, gate: gates[0], integrationHead };
  }
  if (!['attempt', 'task'].includes(action.kind) || action.to === 'ready') return { run: null };
  const attempts = snapshot.currentAttempts.filter(row =>
    action.kind === 'attempt' ? row.id === action.id : row.taskId === action.id,
  );
  requireValue(attempts.length === 1, 'binding_invalid');
  const run = storedRun(store, attempts[0].runId);
  requireValue(run, 'binding_invalid');
  return { run };
}

// Wave proof that reads the integration branch (a task's merge, a gate's range and head) is
// checked under lease `project-integration:<id>`, which the caller holds until the project
// store commits the transition: no Kodo merge or merge-back moves the branch in between.
const readsBranch = action =>
  action.to === 'accepted' || (['attempt', 'task'].includes(action.kind) && action.to === 'integrated');

async function authorizeWave({ store, engine, A, evaluator, command, snapshot, options }) {
  const action = command.action,
    projectId = snapshot.project.projectId;
  const leased = readsBranch(action);
  if (leased) requireValue(integrationLeaseHeld(store, projectId), 'integration_lease_required');
  const { run, gate, integrationHead } = await waveInput(store, snapshot, action);
  const evaluate =
    evaluator?.evaluateWaveTransition ?? (await import('./project-wave-evidence.mjs')).evaluateWaveTransition;
  const result = await evaluate(
    {
      command,
      snapshot,
      run,
      ...(gate ? { gate } : {}),
      ...(integrationHead !== undefined ? { integrationHead } : {}),
    },
    {
      contracts: A,
      knownValues: options.knownValues,
      // A wave container is accepted only by a gate Run whose own observation (gate
      // binding, gate input over every covered task, full receipts) is its proof, so a
      // ref is checked exactly against that Run; a task Run's observation never reaches
      // a container (waveInput binds containers only to gate Runs).
      verifyRef: ref => verifyRef(engine, ref, run, !gate && !['task', 'attempt'].includes(action.kind)),
      validateRun: value => validateWaveRun({ store, engine, contracts: A, snapshot, run: value, gate }),
    },
  );
  requireValue(result?.eligibleStates?.includes(action.to), 'transition_blocked');
  // The project is accepted only on the branch head that is still current after every check.
  if (integrationHead !== undefined)
    requireValue(
      (await integrationHeadOf({ cwd: snapshot.project.root, projectId })) === integrationHead,
      'integration_head_changed',
    );
  if (leased) requireValue(integrationLeaseHeld(store, projectId), 'integration_lease_required');
}

// Installed only by explicit Project composition. Store remains the CAS owner;
// Engine never imports Director and no provider session is initialized here.
export function createProjectTransitionAuthorizer({ store, engine, contracts, evaluator } = {}) {
  return async ({ command, snapshot }) => {
    const A = await contractsFor(contracts),
      D = await evidenceFor(evaluator),
      options = { knownValues: known(engine) };
    A.assertDirectorSafe({ command, snapshot }, options);
    command = A.normalizeDirectorRecord('command', command, options);
    snapshot = A.normalizeDirectorRecord('snapshot', snapshot, options);
    control(snapshot);
    const action = command.action;
    requireValue(
      action.op === 'transition' &&
        command.projectId === snapshot.project.projectId &&
        command.expectedRevision === snapshot.revision,
      'revision_conflict',
    );
    // Wave projects never reach the legacy evaluator: their acceptance belongs to gate Runs.
    if (A.isWaveProject?.(snapshot.project) === true)
      return authorizeWave({ store, engine, A, evaluator, command, snapshot, options });
    let run = null;
    if (!(action.kind === 'task' && action.to === 'ready')) {
      const ids = new Set(action.evidence.map(ref => ref.runId).filter(Boolean));
      let attempts = snapshot.currentAttempts;
      if (action.kind === 'attempt') attempts = attempts.filter(row => row.id === action.id);
      else if (action.kind === 'task') attempts = attempts.filter(row => row.taskId === action.id);
      else {
        const epics = snapshot.epics.filter(
          row =>
            action.kind === 'project' ||
            (action.kind === 'milestone' && row.milestoneId === action.id) ||
            (action.kind === 'epic' && row.id === action.id),
        );
        const tasks = new Set(
          snapshot.tasks.filter(row => epics.some(epic => epic.id === row.epicId)).map(row => row.id),
        );
        attempts = attempts.filter(row => tasks.has(row.taskId) && ids.has(row.runId));
      }
      requireValue(attempts.length === 1, 'binding_invalid');
      run = storedRun(store, attempts[0].runId);
      requireValue(run, 'binding_invalid');
    }
    const result = await D.evaluateProjectTransition(
      { command, snapshot, run },
      {
        contracts: A,
        knownValues: options.knownValues,
        verifyRef: ref => verifyRef(engine, ref, run, !['task', 'attempt'].includes(action.kind)),
        validateRun: value =>
          validateRun({ store, engine, contracts: A, snapshot, run: value, publication: action.to === 'released' }),
      },
    );
    requireValue(result?.eligibleStates?.includes(action.to), 'transition_blocked');
  };
}

export function createProjectDirector({
  repo,
  engine,
  planner,
  evaluator,
  clock = () => new Date().toISOString(),
} = {}) {
  const store = engine.store;
  const ctx = { repo, engine, planner, evaluator, clock, store };
  return {
    plan: (...args) => plan(ctx, ...args),
    run: (...args) => foreground(ctx, ...args),
    resume: (...args) => resume(ctx, ...args),
    drain: (...args) => drainProject(ctx, ...args),
    cancel: (...args) => cancel(ctx, ...args),
    pause: (...args) => pause(ctx, ...args),
    reprioritize: (...args) => reprioritize(ctx, ...args),
    approveRisk: (...args) => approveRisk(ctx, ...args),
  };
}

const optionsFor = (ctx, options) => ({
  actor: options.actor || 'project-director',
  reason: options.reason || 'Foreground Project command',
});

const command = (ctx, snapshot, action, options = {}) => ({
  schemaVersion: 1,
  commandId: options.commandId || randomUUID(),
  projectId: snapshot.project.projectId,
  expectedRevision: snapshot.revision,
  ...optionsFor(ctx, options),
  action,
});

const apply = (ctx, snapshot, action, options) => ctx.repo.apply(command(ctx, snapshot, action, options));

const snapshotFor = async (ctx, id) => {
  const snapshot = await ctx.repo.snapshot(id);
  complete(snapshot);
  return snapshot;
};

const ports = async ctx => ({ contracts: await contractsFor(), knownValues: known(ctx.engine) });

async function horizonFor(ctx, snapshot, options = {}) {
  const A = await ports(ctx);
  const config = await readConfig(
    snapshot.project.root,
    options.mode === undefined ? {} : { executionMode: options.mode },
  );
  requireValue(
    Number.isSafeInteger(options.limit ?? 24) && (options.limit ?? 24) >= 1 && (options.limit ?? 24) <= 24,
    'limit_invalid',
  );
  const limit = Math.min(options.limit ?? 24, resolveMode({ requested: options.mode, config }).profile.maxTasks);
  const availability = [];
  for (const task of snapshot.tasks) {
    let verified = true,
      reason = null;
    try {
      for (const ref of task.interfaceRefs) await verifyRef(ctx.engine, ref);
    } catch {
      verified = false;
      reason = 'interface_proof_invalid';
    }
    availability.push({ taskId: task.id, available: true, interfacesVerified: verified, reason });
  }
  const planHorizon =
    typeof ctx.planner === 'function'
      ? ctx.planner
      : ctx.planner?.planProjectHorizon || (await import('./project-planner.mjs')).planProjectHorizon;
  return planHorizon({ snapshot, limit, availability, now: ctx.clock() }, A);
}

async function plan(ctx, id, options = {}) {
  return horizonFor(ctx, await snapshotFor(ctx, id), options);
}

async function admission(ctx, snapshot, task, options, retry = false, recovery = false) {
  // C evaluates the actual snapshot, including current approvals and immutable
  // interfaces. Only the existing reservation's scheduling exclusions are
  // waived: recovery/retry is not selection of another horizon task.
  const horizon = await horizonFor(ctx, snapshot, options);
  requireValue(horizon.revision === snapshot.revision, 'revision_conflict');
  const blocked = horizon.blocked.find(row => row.taskId === task.id);
  requireValue(blocked || horizon.taskIds.includes(task.id), 'admission_invalid');
  const expected = new Set(['horizon_limit', retry ? 'retry_required' : 'attempt_exists']);
  if (retry) {
    expected.add('attempt_revision_mismatch');
    if (retryable(task.status)) expected.add(`task_${task.status}`);
  } else if (['running', 'verifying', 'integrated'].includes(task.status)) expected.add(`task_${task.status}`);
  if (recovery && task.status === 'accepted') expected.add('task_accepted');
  const reasons = blocked?.reasons.filter(reason => !expected.has(reason)) || [];
  return reasons.length ? { status: 'blocked', blockers: [{ taskId: task.id, reasons }] } : null;
}

// A durable branch/head is a frontier only when all accepted code is present.
// Compare Git ancestry rather than timestamps or the user's unchanged checkout.
async function frontier(ctx, snapshot, task) {
  const root = snapshot.project.root;
  requireValue((await canonical(root)) === snapshot.project.projectKey, 'root_changed');
  const current = await git(root, ['rev-parse', 'HEAD']);
  const relevant = snapshot.currentAttempts.filter(attempt =>
    settled(snapshot.tasks.find(row => row.id === attempt.taskId)?.status),
  );
  const heads = [];
  for (const attempt of relevant) {
    const run = storedRun(ctx.store, attempt.runId);
    requireValue(
      run &&
        isDeepStrictEqual(run.directorBinding, bindingFor(attempt)) &&
        run.state === 'succeeded' &&
        (await canonical(run.project)) === snapshot.project.projectKey,
      'frontier_binding_invalid',
    );
    let head;
    if (run.config.delivery?.enabled) {
      requireValue(
        run.delivery?.mergeCommit && run.delivery.reviewedHead === run.headSha,
        'frontier_publication_missing',
      );
      head = run.delivery.mergeCommit;
    } else {
      requireValue(
        run.branch &&
          run.headSha &&
          (await git(root, ['rev-parse', '--verify', `refs/heads/${run.branch}`])) === run.headSha,
        'frontier_head_changed',
      );
      head = run.headSha;
    }
    requireValue(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(head), 'frontier_head_invalid');
    heads.push(head);
  }
  for (const dependency of task.dependsOn)
    requireValue(
      relevant.some(row => row.taskId === dependency),
      'frontier_dependency_missing',
    );
  const ancestor = async (base, head) => {
    const result = await execute('git', ['merge-base', '--is-ancestor', base, head], {
      cwd: root,
      allowFailure: true,
    });
    requireValue([0, 1].includes(result.code), 'frontier_invalid');
    return result.code === 0;
  };
  let selected = current;
  for (const head of new Set(heads)) {
    if (await ancestor(selected, head)) selected = head;
  }
  for (const head of [current, ...heads])
    requireValue(await ancestor(head, selected), 'frontier_reconciliation_required');
  return selected;
}

export async function priorRetryRun(ctx, snapshot, attempt) {
  if (attempt.number === 1) return null;
  // Only metadata is examined. Never replay old provider/gate sessions. The
  // atomic reservation events order predecessors even across an install crash.
  const runs = new Map(
    ctx.store
      .listRuns(snapshot.project.root)
      .filter(
        run =>
          run.directorBinding?.projectId === attempt.projectId &&
          run.directorBinding.taskId === attempt.taskId &&
          run.id !== attempt.runId,
      )
      .map(run => [run.directorBinding.attemptId, run]),
  );
  let after = 0,
    previous = null;
  for (let page = 0; page < 64; page++) {
    const history = await ctx.repo.history(attempt.projectId, { after, limit: 1000 });
    requireValue(history.revision === snapshot.revision, 'revision_conflict');
    for (const event of history.events)
      if (event.type === 'reserveAttempt' && event.entity.kind === 'attempt') {
        if (event.entity.id === attempt.id) {
          requireValue(previous, 'retry_policy_missing');
          return previous;
        }
        if (runs.has(event.entity.id)) previous = runs.get(event.entity.id);
      }
    if (history.complete) break;
    requireValue(history.nextAfter > after, 'retry_history_incomplete');
    after = history.nextAfter;
  }
  fail('retry_history_incomplete');
}

export async function retrySettings(ctx, snapshot, previous) {
  if (!previous) return null;
  (await ports(ctx)).contracts.assertDirectorSafe(previous, { knownValues: known(ctx.engine) });
  requireValue((await canonical(previous.project)) === snapshot.project.projectKey, 'retry_binding_invalid');
  const model = previous.fixedModel?.model || previous.config.primaryModel || undefined;
  const current = await readConfig(snapshot.project.root, { client: previous.client });
  requireValue(!model || current.models[previous.client]?.includes(model), 'retry_model_unavailable');
  return {
    client: previous.client,
    ...(model ? { model } : {}),
    providers: previous.providers,
    mode: previous.requestedMode || previous.executionMode?.selected || previous.config.executionMode || 'standard',
    concurrency: Math.min(current.concurrency, previous.config.concurrency),
  };
}

// oxlint-disable-next-line max-lines-per-function -- debt: docs/kodo-roadmap/MAINTAINABILITY-PLAN.md
async function foreground(ctx, id, options = {}) {
  let snapshot = await snapshotFor(ctx, id);
  await refuseWave(snapshot);
  if (snapshot.project.status === 'released') return { status: 'succeeded', projectStatus: 'released' };
  control(snapshot);
  const token = ctx.store.acquireLease(`project:${id}`, randomUUID(), { ttlMs: 60000, limit: 1 });
  requireValue(token, 'busy');
  const controller = new AbortController(),
    abort = () => controller.abort();
  options.signal?.addEventListener('abort', abort, { once: true });
  if (options.signal?.aborted) abort();
  let leaseLost = false;
  const renew = () => {
    try {
      if (ctx.store.renewLease(token)) return;
    } catch {
      /* A failed renewal also loses ownership. */
    }
    leaseLost = true;
    abort();
  };
  const timer = setInterval(renew, ctx.engine.leaseHeartbeatMs || 10000);
  timer.unref();
  let pollingBusy = false;
  const polling = setInterval(async () => {
    if (pollingBusy) return;
    pollingBusy = true;
    // Pause gates later starts/advancement through guard; admitted Engine work
    // keeps its session. Abort retains its cancellation meaning for Engine.
    try {
      const s = await ctx.repo.snapshot(id);
      if (s.project.status === 'cancelled') abort();
    } catch {
      abort();
    } finally {
      pollingBusy = false;
    }
  }, 250);
  polling.unref();
  const guard = async (revision, attempt, allowReleased = false) => {
    renew();
    requireValue(!leaseLost, 'lease_lost');
    requireValue(!controller.signal.aborted, 'control_blocked');
    const before = await snapshotFor(ctx, id);
    requireValue((await canonical(before.project.root)) === before.project.projectKey, 'root_changed');
    const s = await snapshotFor(ctx, id);
    control(s, allowReleased);
    renew();
    requireValue(!leaseLost, 'lease_lost');
    requireValue(s.revision === before.revision, 'revision_conflict');
    requireValue(revision === undefined || s.revision === revision, 'revision_conflict');
    if (attempt)
      requireValue(
        isDeepStrictEqual(
          s.currentAttempts.find(row => row.taskId === attempt.taskId),
          attempt,
        ),
        'binding_changed',
      );
    return s;
  };
  try {
    snapshot = await guard(snapshot.revision);
    const active = snapshot.currentAttempts.filter(row => {
      const task = snapshot.tasks.find(task => task.id === row.taskId);
      // A durable Attempt may precede its Task projection across a crash.
      // Select that same reservation before scheduling any further work.
      return (
        (!settled(row.status) && !retryable(row.status)) ||
        (settled(row.status) &&
          stages.includes(task?.status) &&
          stages.indexOf(task.status) < stages.indexOf(row.status))
      );
    });
    requireValue(active.length <= 1, 'multiple_active_attempts');
    let attempt = active[0],
      task,
      previous = null;
    if (!attempt && options.retryFailed) {
      const candidates = snapshot.currentAttempts.filter(row => retryable(row.status));
      if (candidates.length) {
        requireValue(candidates.length === 1, 'retry_ambiguous');
        task = snapshot.tasks.find(row => row.id === candidates[0].taskId);
        previous = storedRun(ctx.store, candidates[0].runId) || (await priorRetryRun(ctx, snapshot, candidates[0]));
        await retrySettings(ctx, snapshot, previous);
        const denied = await admission(ctx, snapshot, task, options, true);
        await guard(snapshot.revision);
        if (denied) return denied;
        attempt = (await apply(ctx, snapshot, { op: 'reserveAttempt', taskId: task.id, retryFailed: true }, options))
          .attempt;
        snapshot = await guard();
      }
    }
    if (!attempt) {
      const horizon = await plan(ctx, id, options);
      snapshot = await guard(horizon.revision);
      if (!horizon.taskIds.length) {
        if (snapshot.tasks.every(task => settled(task.status)))
          return containerResult(ctx, await advanceContainers(ctx, guard));
        return { status: 'blocked', blockers: horizon.blocked };
      }
      task = snapshot.tasks.find(row => row.id === horizon.taskIds[0]);
      if (task.status !== 'ready') {
        await guard(snapshot.revision);
        await apply(ctx, snapshot, {
          op: 'transition',
          kind: 'task',
          id: task.id,
          to: 'ready',
          evidence: [],
          mappings: [],
        });
        snapshot = await guard();
        task = snapshot.tasks.find(row => row.id === task.id);
      }
      const denied = await admission(ctx, snapshot, task, options);
      await guard(snapshot.revision);
      if (denied) return denied;
      attempt = (await apply(ctx, snapshot, { op: 'reserveAttempt', taskId: task.id, retryFailed: false }, options))
        .attempt;
      snapshot = await guard();
    }
    task = snapshot.tasks.find(row => row.id === attempt.taskId);
    const recovery = settled(attempt.status);
    const denied = await admission(ctx, snapshot, task, options, false, recovery);
    await guard(snapshot.revision, attempt);
    if (denied) return denied;
    const A = await ports(ctx),
      input = A.contracts.buildDirectorTaskInput({ project: snapshot.project, task }, A);
    let run = storedRun(ctx.store, attempt.runId);
    if (recovery) requireValue(run?.state === 'succeeded', 'recovery_run_invalid');
    if (!run) {
      previous ||= await priorRetryRun(ctx, snapshot, attempt);
      const retry = await retrySettings(ctx, snapshot, previous);
      const baseSha = await frontier(ctx, snapshot, task);
      snapshot = await guard(snapshot.revision, attempt);
      run = await ctx.engine.createReserved(
        input,
        { ...options, project: snapshot.project.root, providers: options.providers || 'current', ...retry, baseSha },
        {
          binding: bindingFor(attempt),
          installRun: async value => {
            const denied = await admission(ctx, snapshot, task, options);
            await guard(snapshot.revision, attempt);
            requireValue(!denied, 'admission_blocked');
            if (previous)
              for (const field of ['researchBudget', 'repairRounds', 'concurrency', 'maxTasks']) {
                const limit = previous.config[field] ?? previous.executionMode?.profile[field];
                if (limit !== undefined)
                  value.runDraft.config[field] = Math.min(value.runDraft.config[field] ?? limit, limit);
              }
            // Explicit run caps follow the same rule: a retry never widens a saved cap.
            for (const [key, cap] of Object.entries(previous?.config.budgets ?? {})) {
              const budgets = (value.runDraft.config.budgets ??= {});
              budgets[key] = Math.min(budgets[key] ?? cap, cap);
            }
            const revision = snapshot.revision,
              installed = await ctx.repo.installRun(value);
            snapshot = await guard(revision + 1, attempt);
            return installed;
          },
        },
      );
    }
    requireValue(run.task === input && isDeepStrictEqual(run.directorBinding, bindingFor(attempt)), 'binding_invalid');
    const dispatchDenied = await admission(ctx, snapshot, task, options, false, recovery);
    await guard(snapshot.revision, attempt);
    if (dispatchDenied) return dispatchDenied;
    if (recovery) {
      const D = await evidenceFor(ctx.evaluator);
      // Validate the existing terminal proof before advance can persist any
      // observations. Attempts store refs, while criterion mappings belong to
      // Tasks; map only those existing refs against the frozen Task criteria.
      const mappings = task.acceptance.map(criterion => ({
        criterionId: criterion.id,
        refs: attempt.evidence.filter(ref => criterion.evidenceKinds.includes(ref.kind)).map(ref => ref.sha256),
        actor: 'project-director',
        reason: 'Revalidate existing Attempt proof before recovering its Task projection',
      }));
      const proof = await D.evaluateProjectAttempt(
        { snapshot, attempt, run, mappings },
        {
          ...A,
          verifyRef: ref => verifyRef(ctx.engine, ref, run),
          validateRun: value =>
            validateRun({
              store: ctx.store,
              engine: ctx.engine,
              contracts: A.contracts,
              snapshot,
              run: value,
              publication: attempt.status === 'released',
            }),
        },
      );
      requireValue(
        proof.blockers.length === 0 && proof.eligibleStates.includes(attempt.status),
        'recovery_proof_invalid',
      );
      // The evaluator preserves terminal history even when publication is no
      // longer eligible. Require its verified release chain explicitly.
      if (attempt.status === 'released')
        requireValue(
          /^[a-f0-9]{64}$/.test(run.release?.sha256) &&
            ['delivery', 'release'].every(kind => proof.evidence.some(ref => ref.kind === kind)),
          'recovery_proof_invalid',
        );
      await guard(snapshot.revision, attempt);
    }
    if (!settled(attempt.status) && !['succeeded', 'blocked', 'failed', 'cancelled'].includes(run.state)) {
      // Resume preserves Engine's fixed mode/model, quota, budget and sessions.
      // Project retry reserves a NEW Run; it never resets a saved Engine cycle.
      await ctx.engine.run(run.id, { signal: controller.signal });
    }
    snapshot = await guard(snapshot.revision, attempt);
    run = ctx.store.getRun(attempt.runId);
    if (retryable(run.state)) {
      await apply(ctx, snapshot, {
        op: 'transition',
        kind: 'attempt',
        id: attempt.id,
        to: run.state,
        evidence: [],
        mappings: [],
      });
      return { status: run.state, runId: run.id };
    }
    if (run.state !== 'succeeded') return { status: run.state, runId: run.id };
    await advance(ctx, id, run, guard);
    snapshot = await guard();
    const accepted = snapshot.tasks.find(row => row.id === attempt.taskId);
    if (settled(accepted.status) && snapshot.tasks.every(task => settled(task.status)))
      return { ...containerResult(ctx, await advanceContainers(ctx, guard)), runId: run.id };
    return {
      status: settled(accepted.status) ? 'succeeded' : 'blocked',
      runId: run.id,
      ...(settled(accepted.status) ? {} : { blockers: ['task_acceptance_unverified'] }),
    };
  } finally {
    clearInterval(timer);
    clearInterval(polling);
    options.signal?.removeEventListener('abort', abort);
    ctx.store.releaseLease(token);
  }
}

function containerResult(ctx, { snapshot, blockers }) {
  return {
    status: settled(snapshot.project.status) ? 'succeeded' : 'blocked',
    projectStatus: snapshot.project.status,
    ...(blockers.length ? { blockers } : {}),
  };
}

async function advanceContainers(ctx, guard) {
  const A = await ports(ctx),
    D = await evidenceFor(ctx.evaluator),
    blockers = [];
  let snapshot = await guard();
  const entities = [
    ...snapshot.epics.map(row => ['epic', row.id]),
    ...snapshot.milestones.map(row => ['milestone', row.id]),
    ['project', snapshot.project.projectId],
  ];
  for (const [kind, id] of entities) {
    for (let step = 0; step < stages.length; step++) {
      snapshot = await guard();
      const record = kind === 'project' ? snapshot.project : snapshot[`${kind}s`].find(row => row.id === id);
      if (record.status === 'released') break;
      if (record.status === 'accepted' && !record.evidence.some(ref => ref.kind === 'release')) break;
      const children =
        kind === 'project'
          ? snapshot.milestones
          : kind === 'milestone'
            ? snapshot.epics.filter(row => row.milestoneId === id)
            : snapshot.tasks.filter(row => row.epicId === id);
      if (!children.length || !children.every(row => settled(row.status))) {
        blockers.push(`${kind}:${id}:children_not_accepted`);
        break;
      }
      const criteria = kind === 'project' ? record.definitionOfDone : record.acceptance;
      const byHash = new Map(record.evidence.map(ref => [ref.sha256, ref]));
      const ownProof = criteria.every(criterion => {
        const mapping = record.mappings.find(row => row.criterionId === criterion.id);
        return (
          mapping?.refs.length &&
          mapping.refs.every(digest => byHash.has(digest)) &&
          criterion.evidenceKinds.every(type => mapping.refs.some(digest => byHash.get(digest).kind === type))
        );
      });
      if (!ownProof) {
        blockers.push(`${kind}:${id}:own_proof_missing`);
        break;
      }
      const ids = new Set(
        record.evidence
          .filter(ref => ['checks', 'review'].includes(ref.kind))
          .map(ref => ref.runId)
          .filter(Boolean),
      );
      if (ids.size !== 1) {
        blockers.push(`${kind}:${id}:bound_run_ambiguous`);
        break;
      }
      const run = storedRun(ctx.store, [...ids][0]);
      if (!run) {
        blockers.push(`${kind}:${id}:bound_run_missing`);
        break;
      }
      const to = record.status === 'proposed' ? 'ready' : stages[stages.indexOf(record.status) + 1];
      if (!to) {
        blockers.push(`${kind}:${id}:state_blocked`);
        break;
      }
      const c = command(ctx, snapshot, {
        op: 'transition',
        kind,
        id,
        to,
        evidence: record.evidence,
        mappings: record.mappings,
      });
      const result = await D.evaluateProjectTransition(
        { snapshot, command: c, run },
        {
          ...A,
          verifyRef: ref => verifyRef(ctx.engine, ref, run, true),
          validateRun: value =>
            validateRun({
              store: ctx.store,
              engine: ctx.engine,
              contracts: A.contracts,
              snapshot,
              run: value,
              publication: to === 'released',
            }),
        },
      );
      if (!result.eligibleStates.includes(to)) {
        blockers.push(...result.blockers.map(reason => `${kind}:${id}:${reason}`));
        break;
      }
      await guard(snapshot.revision);
      await ctx.repo.apply(c);
      if (kind === 'project' && to === 'released')
        return { snapshot: await guard(undefined, undefined, true), blockers };
    }
  }
  return { snapshot: await guard(), blockers: [...new Set(blockers)] };
}

async function advance(ctx, id, run, guard) {
  const A = await ports(ctx),
    D = await evidenceFor(ctx.evaluator);
  let snapshot = await guard();
  // Acceptance observes the actual checked/reviewed frozen task, rather than
  // trusting a provider's completion prose or a caller-supplied decision.
  await validateRun({ store: ctx.store, engine: ctx.engine, contracts: A.contracts, snapshot, run });
  const refs = [];
  if (typeof ctx.engine.persistEvidence === 'function') {
    for (const kind of [
      'acceptance',
      'contract',
      'checks',
      'review',
      ...(run.release?.published ? ['delivery', 'release'] : []),
    ]) {
      const headSha = ['delivery', 'release'].includes(kind) ? run.delivery.mergeCommit : run.headSha;
      const ref = await ctx.engine.persistEvidence(run, `project-${kind}`, observation(run, kind), { headSha });
      refs.push({ kind, runId: run.id, headSha, path: ref.path, sha256: ref.sha256 });
    }
  }
  for (const kind of ['attempt', 'task']) {
    for (let step = 0; step < stages.length; step++) {
      snapshot = await guard();
      const attempt = snapshot.currentAttempts.find(row => row.runId === run.id),
        task = snapshot.tasks.find(row => row.id === attempt.taskId);
      const record = kind === 'attempt' ? attempt : task;
      const to = record.status === 'reserved' ? 'running' : stages[stages.indexOf(record.status) + 1];
      if (!to || record.status === 'released') break;
      const evidence = [
        ...new Map([...record.evidence, ...task.interfaceRefs, ...refs].map(ref => [ref.sha256, ref])).values(),
      ];
      const mappings = task.acceptance.map(criterion => ({
        criterionId: criterion.id,
        refs: evidence.filter(ref => criterion.evidenceKinds.includes(ref.kind)).map(ref => ref.sha256),
        actor: 'project-director',
        reason: 'Exact frozen task passed required checks and independent review',
      }));
      if (mappings.some(row => !row.refs.length)) break;
      const c = command(ctx, snapshot, { op: 'transition', kind, id: record.id, to, evidence, mappings });
      const result = await D.evaluateProjectTransition(
        { snapshot, command: c, run },
        {
          ...A,
          verifyRef: ref => verifyRef(ctx.engine, ref, run),
          validateRun: value =>
            validateRun({
              store: ctx.store,
              engine: ctx.engine,
              contracts: A.contracts,
              snapshot,
              run: value,
              publication: to === 'released',
            }),
        },
      );
      if (!result.eligibleStates.includes(to)) break;
      await guard(snapshot.revision, attempt);
      await ctx.repo.apply(c);
    }
  }
}

async function cancel(ctx, id, options = {}) {
  let snapshot = await snapshotFor(ctx, id);
  if (snapshot.project.status !== 'cancelled')
    await apply(
      ctx,
      snapshot,
      { op: 'transition', kind: 'project', id, to: 'cancelled', evidence: [], mappings: [] },
      options,
    );
  snapshot = await snapshotFor(ctx, id);
  for (const attempt of snapshot.currentAttempts.filter(row => !settled(row.status))) {
    if (!retryable(attempt.status)) {
      await apply(ctx, snapshot, {
        op: 'transition',
        kind: 'attempt',
        id: attempt.id,
        to: 'cancelled',
        evidence: [],
        mappings: [],
      });
      snapshot = await snapshotFor(ctx, id);
    }
    const run = storedRun(ctx.store, attempt.runId);
    if (run) {
      ctx.store.updateRun(run.id, { cancelRequested: true });
      if (typeof ctx.engine.cancel === 'function') await ctx.engine.cancel(run.id);
    }
  }
  // Wave gates: unfinished gate Runs are cancelled too. Legacy snapshots have no gates.
  for (const gate of snapshot.gates ?? []) {
    const run = storedRun(ctx.store, gate.runId);
    if (run && !['succeeded', 'blocked', 'failed', 'cancelled'].includes(run.state)) {
      ctx.store.updateRun(run.id, { cancelRequested: true });
      if (typeof ctx.engine.cancel === 'function') await ctx.engine.cancel(run.id);
    }
  }
  return { status: 'cancelled' };
}

async function pause(ctx, id, options = {}) {
  const snapshot = await snapshotFor(ctx, id);
  return apply(ctx, snapshot, { op: 'setPaused', paused: options.paused ?? true }, options);
}

const isWave = async snapshot => (await contractsFor()).isWaveProject(snapshot.project) === true;

// Wave projects never run through this one-task foreground loop, whose acceptance
// comes from the task's own Run: `run` refuses, `resume` drains one wave.
async function refuseWave(snapshot) {
  if (await isWave(snapshot)) fail('wave_drain_required');
}

const waveContext = (ctx, W) =>
  W.createWaveContext({ repo: ctx.repo, engine: ctx.engine, store: ctx.store, clock: ctx.clock });

// `resume` of a wave project is a drain of exactly one wave of one task.
async function waveResume(ctx, id, options) {
  const W = await import('./project-director-waves.mjs');
  const result = await W.drain(waveContext(ctx, W), id, {
    maxWaves: 1,
    concurrency: 1,
    retryFailed: options.retryFailed === true,
    signal: options.signal,
    commandId: options.commandId,
  });
  return {
    ...result,
    status: ['accepted', 'max_waves'].includes(result.status) ? 'succeeded' : result.status,
    drainStatus: result.status,
  };
}

async function drainProject(ctx, id, options = {}) {
  const W = await import('./project-director-waves.mjs');
  return W.drain(waveContext(ctx, W), id, options);
}

async function resume(ctx, id, options = {}) {
  const snapshot = await snapshotFor(ctx, id);
  requireValue(!['cancelled', 'failed'].includes(snapshot.project.status), 'control_blocked');
  if (snapshot.project.paused) await apply(ctx, snapshot, { op: 'setPaused', paused: false }, optionsFor(ctx, options));
  return (await isWave(snapshot)) ? waveResume(ctx, id, options) : foreground(ctx, id, options);
}

async function reprioritize(ctx, id, taskId, options = {}) {
  const snapshot = await snapshotFor(ctx, id),
    task = snapshot.tasks.find(row => row.id === taskId);
  requireValue(task, 'task_missing');
  const { schemaVersion, projectId, revision, status, createdAt, updatedAt, evidence, mappings, ...spec } = task;
  return apply(
    ctx,
    snapshot,
    { op: 'amend', kind: 'task', id: taskId, record: { ...spec, priority: options.priority } },
    options,
  );
}

async function approveRisk(ctx, id, taskId, options = {}) {
  const snapshot = await snapshotFor(ctx, id),
    task = snapshot.tasks.find(row => row.id === taskId);
  requireValue(task, 'task_missing');
  return apply(ctx, snapshot, { op: 'approveRisk', taskId, taskRevision: task.revision }, options);
}
