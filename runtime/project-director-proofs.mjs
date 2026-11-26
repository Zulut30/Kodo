import { verifyRemoteProof } from './remote-task-receipt.mjs';
import path from 'node:path';
import { realpath, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { diffHash } from './workspace.mjs';
import { execute } from './command.mjs';
import { inspectCurrentSource } from './ci-graph.mjs';
import { readConfig, validateCommandTimeouts } from './config.mjs';
import {
  gateRange,
  gateRepairInScope,
  integrationBranch,
  integrationHeadOf,
  mergeOnBranch,
  treesDiffer,
} from './project-integration.mjs';
import { integrationLeaseHeld } from './project-integration-lease.mjs';
import { WAVE_POLICY_FIELDS, assertWavePolicy } from './wave-policy.mjs';
import { isCurrentBehaviorReceipt } from './behavior-gate.mjs';
import {
  architectureOriginForRun,
  architectureTaskPathsForRun,
  architectureTaskScopesForRun,
} from './architecture-gate.mjs';
import {
  TEST_COUNT_VERSION,
  countingPlan,
  nodeTestOutcome,
  npmContextFor,
  npmCountOutcome,
} from './task-fast-checks.mjs';
import { arbitrationAccepts, arbitrationReceiptValue } from './gate-arbiter.mjs';

export const fail = code => {
  throw Object.assign(new Error(`Project ${code}`), { code: `project_${code}` });
};
export const requireValue = (value, code = 'proof_invalid') => {
  if (!value) fail(code);
};
export const settled = value => ['accepted', 'released'].includes(value);
export const retryable = value => ['blocked', 'failed', 'cancelled'].includes(value);
export const stages = ['ready', 'running', 'verifying', 'integrated', 'accepted', 'released'];
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
export const canonical = async value => {
  const root = await realpath(value);
  return process.platform === 'win32' ? root.toLowerCase() : root;
};
export function complete(snapshot) {
  for (const name of ['milestones', 'epics', 'tasks', 'currentAttempts', 'riskApprovals']) {
    const count = snapshot.completeness?.[name];
    requireValue(
      count?.complete === true && count.total === snapshot[name]?.length && count.returned === count.total,
      'snapshot_incomplete',
    );
  }
}
export function control(snapshot, allowReleased = false) {
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
export async function contractsFor(contracts) {
  return contracts || (await import('./project-contracts.mjs'));
}
export async function evidenceFor(evaluator) {
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
export async function validateRun({ store, engine, contracts, snapshot, run, publication = false }) {
  const options = { knownValues: known(engine) };
  contracts.assertDirectorSafe(run, options);
  requireValue(isDeepStrictEqual(run, store.getRun(run.id)), 'run_changed');
  assertAttemptBinding({ contracts, snapshot, run, options });
  await assertRunSource(snapshot, run);
  await assertFullReceipts(engine, run);
  if (publication) await assertPublication(engine, run);
  requireValue((await inspectCurrentSource({ project: run.cwd, headSha: run.headSha })) === 'clean', 'head_changed');
}
// Same root, same verification config, an unstopped Run and a clean verified head. A wave Run's
// verification policy (WAVE_POLICY_FIELDS) belongs to its verified commit (assertWavePolicy), so
// only its other settings are compared, and only with the user's checkout.
async function assertRunSource(snapshot, run, wave = false) {
  requireValue((await canonical(run.project)) === snapshot.project.projectKey, 'root_changed');
  const fields = ['commands', 'checks', 'security', 'uiVerification', 'architecture', 'repository', 'baseBranch'];
  for (const root of new Set(wave ? [run.project] : [run.project, run.cwd])) {
    const current = await readConfig(root, { client: run.client });
    for (const field of wave ? fields.filter(name => !WAVE_POLICY_FIELDS.includes(name)) : fields)
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
// The full check receipt of `run.headSha`: the configured test and build commands of this
// runtime, each passed, with an intact log of exactly that passing command.
async function assertCheckReceipts(engine, run) {
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
}

// The review receipt of `run.headSha` (its session and the current diff of the Run).
const reviewOfHead = async run =>
  run.review.headSha === run.headSha &&
  run.review.sessionId &&
  run.review.diffHash === (await diffHash(run.cwd, run.baseSha));

// Every enabled UI/security/architecture gate holds a current receipt for `run.headSha`.
async function assertGateReceipts(engine, run, gateContext) {
  const archTaskPaths = architectureTaskPathsForRun(run);
  const archTaskScopes = architectureTaskScopesForRun(run, gateContext ?? undefined);
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
            ...(field === 'architectureChecks'
              ? {
                  taskPaths: archTaskPaths,
                  ...architectureOriginForRun(run),
                  ...(archTaskScopes ? { taskScopes: archTaskScopes } : {}),
                }
              : {}),
          })) === true,
        'gate_stale',
      );
  }
}

// Full checks with their logs, the independent review and every enabled gate on the verified head.
async function assertFullReceipts(engine, run, gateContext = null) {
  await assertCheckReceipts(engine, run);
  // A gate Run whose review refused may be accepted only by a `confirm_pass` arbitration bound to
  // this verified head and to that review receipt (16B1); its immutable receipt is checked too.
  const arbitrated = gateContext !== null && run.review?.passed === false && arbitrationAccepts(run);
  requireValue(
    (arbitrated ||
      (run.review?.passed === true &&
        !run.review.findings?.some(row => ['major', 'blocker'].includes(row.severity)))) &&
      (await reviewOfHead(run)),
    'review_stale',
  );
  if (arbitrated) await assertArbitrationReceipt(engine, run);
  await assertGateReceipts(engine, run, gateContext);
}

/**
 * The receipts a gate arbiter relies on (16B1), checked like the Director's acceptance does
 * before any arbiter session: on the reviewed `headSha` of a refused gate review, the full check
 * receipt with intact logs and positive test counts, a current behaviour receipt, the review bound
 * to the current diff of the gate (`diffHash`), current UI/security/architecture receipts and,
 * with `smoke`, the smoke receipt with its logs. Throws the receipt's `project_*` code (or
 * `evidence_integrity`) on any mismatch.
 * @param {any} engine
 * @param {any} run the gate Run (its `run.headSha` is not changed)
 * @param {string} headSha the reviewed head
 * @param {{ smoke?: boolean }} [options]
 */
export async function assertArbitrableReceipts(engine, run, headSha, { smoke = false } = {}) {
  requireValue(run?.directorBinding?.kind === 'gate' && typeof headSha === 'string', 'binding_invalid');
  const view = { ...run, headSha };
  await assertCheckReceipts(engine, view);
  await assertTestCounts(view, { step: row => row.command, positive: true, code: 'gate_tests_uncounted' });
  requireValue(
    isCurrentBehaviorReceipt(view.behavior, { headSha, baseSha: view.baseSha, config: view.config }),
    'behavior_stale',
  );
  requireValue(view.review?.passed === false && (await reviewOfHead(view)), 'review_stale');
  await assertGateReceipts(engine, view, null);
  if (smoke) await assertSmoke(engine, view);
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
// the manifest of the covered tasks and containers whose SHA-256 the gate input (run.task) binds.
async function assertGateManifest({ engine, contracts, run, gate, input, options }) {
  const ref = run.gateManifest;
  requireValue(
    typeof contracts.buildGateManifest === 'function' && ref?.headSha === gate.headSha,
    'gate_manifest_invalid',
  );
  await verifyRef(engine, { kind: 'gate-manifest', path: ref.path, sha256: ref.sha256, headSha: ref.headSha }, run);
  const envelope = JSON.parse(await readFile(ref.path, 'utf8'));
  const { manifest } = contracts.buildGateManifest(input, options);
  requireValue(
    envelope.kind === 'gate-manifest' &&
      envelope.baseSha === gate.baseSha &&
      isDeepStrictEqual(envelope.value, manifest),
    'gate_manifest_invalid',
  );
  return manifest;
}

// The arbitration of a gate Run: its frozen input and its record are intact immutable evidence of
// this Run on the arbitrated head, and the receipt holds exactly the record on the Run.
async function assertArbitrationReceipt(engine, run) {
  const record = run.gateArbitration;
  for (const [kind, ref] of [
    ['gate-arbitration-input', record.input],
    ['gate-arbitration', record.receipt],
  ])
    await verifyRef(engine, { kind, path: ref?.path, sha256: ref?.sha256, headSha: record.headSha }, run).catch(() =>
      fail('arbitration_invalid'),
    );
  const envelope = JSON.parse(await readFile(record.receipt.path, 'utf8'));
  requireValue(
    envelope.kind === 'gate-arbitration' &&
      envelope.headSha === run.headSha &&
      isDeepStrictEqual(envelope.value, arbitrationReceiptValue(record)),
    'arbitration_invalid',
  );
}

// The independent review of a gate confirmed every criterion of its manifest (each covered
// container's and task's), each exactly once, met, with evidence. After a refused review, the
// `confirm_pass` arbitration that accepted the Run confirms them instead.
function assertGateCriteria(contracts, run, manifest) {
  const source =
    run.review?.passed === false && arbitrationAccepts(run)
      ? run.gateArbitration.evidence.criteria
      : run.review?.criteria;
  const expected = contracts.gateReviewCriteria(manifest),
    confirmed = Array.isArray(source) ? source : [];
  requireValue(
    isDeepStrictEqual(run.gateCriteria, expected) &&
      confirmed.length === expected.length &&
      expected.every(
        criterion =>
          confirmed.filter(
            row =>
              row?.id === criterion.id &&
              row.met === true &&
              typeof row.evidence === 'string' &&
              row.evidence.trim().length > 0,
          ).length === 1,
      ),
    'gate_criteria_unmet',
  );
}

// `commands.smoke` of the gate's policy ran completely and passed on the verified head.
async function assertSmoke(engine, run) {
  const commands = run.config.commands.smoke ?? [],
    smoke = run.smoke;
  requireValue(
    smoke?.complete === true &&
      smoke.headSha === run.headSha &&
      Array.isArray(smoke.results) &&
      smoke.results.length === commands.length &&
      commands.every(
        ({ command, args = [] }, index) =>
          smoke.results[index].command === command && isDeepStrictEqual(smoke.results[index].args ?? [], args),
      ),
    'smoke_stale',
  );
  await assertLogs(engine, run, smoke.results, 'smoke');
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

// A wave task Run (native or of an external chat, always profile task-fast) verifies under the
// policy of its base (the frontier); once it succeeded it carries the task-fast receipt, and its
// head may change the policy only inside its write paths. Before that it proves only its binding
// and source, and the evaluator grants it at most running/verifying.
async function validateWaveTask({ engine, contracts, snapshot, run, options }) {
  assertAttemptBinding({ contracts, snapshot, run, options });
  requireValue(run.verificationProfile === 'task-fast', 'checks_stale');
  await assertRunSource(snapshot, run, true);
  const task = snapshot.tasks.find(row => row.id === run.directorBinding.taskId);
  const succeeded = run.state === 'succeeded';
  await assertWavePolicy({
    run,
    policyCommit: run.baseSha,
    ...(succeeded ? { headSha: run.headSha } : {}),
    writePaths: task.writePaths,
    secrets: engine.secrets,
  });
  if (!succeeded) return;
  if (run.checks?.source === 'remote') {
    requireValue(await verifyRemoteProof(run), 'checks_stale');
    await assertTaskMerge(snapshot, run);
    return;
  }
  requireValue(run.checks?.profile === 'task-fast' && Array.isArray(run.checks.results), 'checks_stale');
  await assertLogs(engine, run, run.checks.results, 'fast-check');
  await assertTestCounts(run, { step: row => row, positive: false, code: 'fast_tests_uncounted' });
  await assertTaskMerge(snapshot, run);
}

// Each `node --test` row of a wave receipt holds the count of its own evidence log, recounted from
// the event file of Kodo's reporter that the log keeps (never from stdout), by the current counting
// algorithm; the caller checked the log's integrity and that the configured command exited 0. A
// gate Run requires a positive count for each full counted command (`gate_tests_uncounted`); a
// task-fast row only an equal, known one (`fast_tests_uncounted`): its runtime decides on zero.
// An npm script command is judged by its own exit code; when it is simple in the verified commit
// (read from Git: the script resolves, no `.npmrc`, no `workspaces`, see countingPlan) the row and
// its log must hold its counting run (assertNpmCount), otherwise neither holds one.
async function assertTestCounts(run, { step, positive, code }) {
  const tests = run.checks.results.filter(row => row.kind === 'test');
  let context = null;
  try {
    context = await npmContextFor(run.project, run.headSha, tests.map(step));
  } catch {
    fail(code);
  }
  for (const row of tests) {
    const log = JSON.parse(await readFile(row.outputPath, 'utf8'));
    // Rows of the previous algorithm (an npm script replaced by Node) are no proof.
    requireValue(row.resolved === undefined && log.value.resolved === undefined, code);
    const plan = countingPlan(step(row), context);
    if (plan?.npm) {
      assertNpmCount(row, log.value, plan.npm, code);
      continue;
    }
    requireValue(row.count === undefined && log.value.count === undefined, code);
    const outcome = nodeTestOutcome(step(row), log.value);
    requireValue(
      !outcome ||
        (Number.isSafeInteger(outcome.tests) &&
          (!positive || outcome.tests > 0) &&
          row.tests === outcome.tests &&
          row.countVersion === TEST_COUNT_VERSION),
      code,
    );
  }
}

// The counting run of a simple npm script: the log's `count` names that resolution and exactly Kodo's
// counting command; `tests` is recounted from its events (a run that did not exit 0 has none) and the
// row holds the same `count` of the current algorithm. A confirmed zero is never accepted.
function assertNpmCount(row, value, plan, code) {
  const logged = value.count;
  const outcome = npmCountOutcome(plan, logged);
  requireValue(
    outcome !== null &&
      outcome.tests !== 0 &&
      (logged.exitCode === null || Number.isSafeInteger(logged.exitCode)) &&
      logged.tests === outcome.tests &&
      row.countVersion === TEST_COUNT_VERSION &&
      value.countVersion === TEST_COUNT_VERSION &&
      row.tests === undefined &&
      row.executed === undefined &&
      isDeepStrictEqual(row.count, {
        resolved: plan.resolved,
        executed: logged.executed,
        exitCode: logged.exitCode,
        tests: outcome.tests,
      }),
    code,
  );
}

// A gate Run is bound to its gate record and the manifest of its covered tasks and containers,
// verifies under the policy of the gate head (which its verified head keeps), carries the full
// receipts, the behaviour receipt of that policy, the smoke logs and a review that confirmed
// every criterion; its verified head descends from the gate head inside the covered tasks'
// write paths and is already contained in the integration branch.
async function validateWaveGate({ store, engine, contracts, snapshot, run, gate, options }) {
  const tasks = gate.merges.map(merge => snapshot.tasks.find(row => row.id === merge.taskId));
  requireValue(tasks.every(Boolean), 'binding_invalid');
  const input = { project: snapshot.project, gate, tasks, containers: contracts.gateContainerCriteria(snapshot, gate) };
  requireValue(
    JSON.stringify(run.directorBinding) === JSON.stringify(contracts.gateBindingFor(gate, options)) &&
      run.task === contracts.buildGateInput(input, options),
    'binding_invalid',
  );
  await assertRunSource(snapshot, run, true);
  await assertWavePolicy({ run, policyCommit: gate.headSha, headSha: run.headSha, secrets: engine.secrets });
  await assertFullReceipts(engine, run, { gate, tasks });
  await assertTestCounts(run, { step: row => row.command, positive: true, code: 'gate_tests_uncounted' });
  requireValue(
    isCurrentBehaviorReceipt(run.behavior, { headSha: run.headSha, baseSha: run.baseSha, config: run.config }),
    'behavior_stale',
  );
  await assertSmoke(engine, run);
  const writePaths = tasks.flatMap(task => task.writePaths);
  requireValue(
    await gateRepairInScope({ worktree: run.cwd, from: gate.headSha, to: run.headSha, writePaths }),
    'gate_scope',
  );
  const manifest = await assertGateManifest({ engine, contracts, run, gate, input, options });
  assertGateCriteria(contracts, run, manifest);
  // Nothing is accepted that the integration branch does not contain (mergeBackGate first).
  await assertGateOnBranch({ store, snapshot, run, gate });
}

async function validateWaveRun({ store, engine, contracts, snapshot, run, gate }) {
  const options = { knownValues: known(engine) };
  contracts.assertDirectorSafe(run, options);
  requireValue(isDeepStrictEqual(run, store.getRun(run.id)), 'run_changed');
  if (gate) await validateWaveGate({ store, engine, contracts, snapshot, run, gate, options });
  else await validateWaveTask({ engine, contracts, snapshot, run, options });
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
/** @param {{store?: any, engine?: any, contracts?: any, evaluator?: any}} [options] */
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
