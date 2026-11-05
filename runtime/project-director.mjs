import path from 'node:path';
import { realpath, readFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { git, diffHash } from './workspace.mjs';
import { execute } from './command.mjs';
import { inspectCurrentSource } from './ci-graph.mjs';
import { readConfig, validateCommandTimeouts } from './config.mjs';
import { resolveMode } from './modes.mjs';

const fail = code => { throw Object.assign(new Error(`Project ${code}`), { code: `project_${code}` }); };
const requireValue = (value, code = 'proof_invalid') => { if (!value) fail(code); };
const settled = value => ['accepted', 'released'].includes(value);
const retryable = value => ['blocked', 'failed', 'cancelled'].includes(value);
const stages = ['ready', 'running', 'verifying', 'integrated', 'accepted', 'released'];
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const known = engine => Object.values(engine.secrets || {}).filter(value => typeof value === 'string');
const bindingFor = attempt => ({ schemaVersion: 1, projectId: attempt.projectId, taskId: attempt.taskId, taskRevision: attempt.taskRevision,
  attemptId: attempt.id, runId: attempt.runId, contractHash: attempt.contractHash });
const canonical = async value => { const root = await realpath(value); return process.platform === 'win32' ? root.toLowerCase() : root; };
function complete(snapshot) {
  for (const name of ['milestones', 'epics', 'tasks', 'currentAttempts', 'riskApprovals']) {
    const count = snapshot.completeness?.[name];
    requireValue(count?.complete === true && count.total === snapshot[name]?.length && count.returned === count.total, 'snapshot_incomplete');
  }
}
function control(snapshot) {
  complete(snapshot);
  requireValue(!snapshot.project.paused && !['cancelled', 'failed', 'blocked', 'released'].includes(snapshot.project.status), 'control_blocked');
}
function storedRun(store, id) {
  // Missing is distinguished from a corrupt/closed Store. No raw DB access.
  try { return store.getRun(id); }
  catch (error) { if (error.message === `Запуск не найден: ${id}`) return null; throw error; }
}
async function contractsFor(contracts) { return contracts || await import('./project-contracts.mjs'); }
async function evidenceFor(evaluator) { return evaluator || await import('./project-evidence.mjs'); }
async function verifyRef(engine, ref, run) {
  requireValue(typeof engine.assertEvidence === 'function');
  if (run && ref.kind !== 'interface') {
    const root = await realpath(path.join(run.artifacts, 'evidence')), file = await realpath(ref.path);
    const relative = path.relative(root, file);
    requireValue(relative && !relative.startsWith('..') && !path.isAbsolute(relative));
  }
  await engine.assertEvidence(ref);
  if (run && ['acceptance', 'contract', 'checks', 'review', 'delivery', 'release'].includes(ref.kind)) {
    const envelope = JSON.parse(await readFile(ref.path, 'utf8'));
    requireValue(envelope.kind === `project-${ref.kind}` && isDeepStrictEqual(envelope.value, observation(run, ref.kind)));
  }
}
function observation(run, kind) {
  if (kind === 'acceptance') return { directorBinding: run.directorBinding, task: run.task, checks: run.checks, review: run.review };
  if (kind === 'contract') return { directorBinding: run.directorBinding, task: run.task };
  return run[kind];
}
async function validateRun({ store, engine, contracts, snapshot, run, publication = false }) {
  const options = { knownValues: known(engine) };
  contracts.assertDirectorSafe(run, options);
  requireValue(isDeepStrictEqual(run, store.getRun(run.id)), 'run_changed');
  const attempt = snapshot.currentAttempts.find(row => row.runId === run.id), task = snapshot.tasks.find(row => row.id === attempt?.taskId);
  requireValue(attempt && task && isDeepStrictEqual(run.directorBinding, bindingFor(attempt))
    && attempt.taskRevision === task.revision && attempt.contractHash === contracts.directorContractHash(task, options)
    && run.task === contracts.buildDirectorTaskInput({ project: snapshot.project, task }, options), 'binding_invalid');
  requireValue(await canonical(run.project) === snapshot.project.projectKey, 'root_changed');
  requireValue(!run.cancelRequested && !['cancelled', 'blocked', 'failed', 'waiting_limits'].includes(run.state), 'run_blocked');
  requireValue(await git(run.cwd, ['rev-parse', 'HEAD']) === run.headSha
    && await inspectCurrentSource({ project: run.cwd, headSha: run.headSha }) === 'clean', 'head_changed');
  validateCommandTimeouts(run.config.commands);
  const expected = ['test', 'build'].flatMap(kind => run.config.commands[kind].map(command => ({ kind, command })));
  const fingerprint = hash({ headSha: run.headSha, expected, runtime: { node: process.version, abi: process.versions.modules, platform: process.platform, arch: process.arch } });
  requireValue(run.config.commands.test.length && run.checks?.schemaVersion === 2 && run.checks.complete === true
    && run.checks.headSha === run.headSha && run.checks.fingerprint === fingerprint
    && run.checks.results?.length === expected.length, 'checks_stale');
  for (let index = 0; index < expected.length; index++) {
    const row = run.checks.results[index];
    requireValue(row.exitCode === 0 && row.kind === expected[index].kind && isDeepStrictEqual(row.command, expected[index].command)
      && row.outputPath && row.outputHash, 'checks_stale');
    await engine.assertEvidence({ path: row.outputPath, sha256: row.outputHash, headSha: run.headSha });
    const log = JSON.parse(await readFile(row.outputPath, 'utf8'));
    requireValue(log.kind === 'check' && log.value.exitCode === 0 && log.value.kind === row.kind && isDeepStrictEqual(log.value.command, row.command));
  }
  requireValue(run.review?.passed === true && run.review.headSha === run.headSha && run.review.sessionId
    && !run.review.findings?.some(row => ['major', 'blocker'].includes(row.severity))
    && run.review.diffHash === await diffHash(run.cwd, run.baseSha), 'review_stale');
  for (const [field, setting, method] of [
    ['uiVerification', 'uiVerification', 'isCurrentUIReceipt'], ['securityChecks', 'security', 'isCurrentSecurityReceipt'],
    ['architectureChecks', 'architecture', 'isCurrentArchitectureReceipt']
  ]) {
    const config = run.config[setting];
    requireValue(typeof config?.enabled === 'boolean', 'gate_unknown');
    if (config.enabled) requireValue(typeof engine.gates?.[method] === 'function' && await engine.gates[method](run[field], {
      cwd: run.cwd, headSha: run.headSha, baseSha: run.baseSha, config
    }) === true, 'gate_stale');
  }
  if (publication) {
    requireValue(run.config.delivery?.enabled && run.delivery?.mergeCommit && run.delivery.reviewedHead === run.headSha
      && typeof engine.delivery?.reconcileDelivery === 'function', 'publication_unverified');
    const reconciled = await engine.delivery.reconcileDelivery({ run: structuredClone(run), config: run.config,
      cwd: run.cwd, secrets: engine.secrets || {} });
    requireValue(reconciled?.mergeCommit === run.delivery.mergeCommit && reconciled.reviewedHead === run.headSha, 'publication_unverified');
    requireValue(run.release?.published === true && run.release.commit === reconciled.mergeCommit
      && run.delivery.release && isDeepStrictEqual(run.delivery.release, run.release), 'publication_unverified');
  }
  requireValue(await git(run.cwd, ['rev-parse', 'HEAD']) === run.headSha
    && await inspectCurrentSource({ project: run.cwd, headSha: run.headSha }) === 'clean', 'head_changed');
}

// Installed only by explicit Project composition. Store remains the CAS owner;
// Engine never imports Director and no provider session is initialized here.
export function createProjectTransitionAuthorizer({ store, engine, contracts, evaluator } = {}) {
  return async ({ command, snapshot }) => {
    const A = await contractsFor(contracts), D = await evidenceFor(evaluator), options = { knownValues: known(engine) };
    A.assertDirectorSafe({ command, snapshot }, options);
    command = A.normalizeDirectorRecord('command', command, options);
    snapshot = A.normalizeDirectorRecord('snapshot', snapshot, options);
    control(snapshot);
    const action = command.action;
    requireValue(action.op === 'transition' && command.projectId === snapshot.project.projectId
      && command.expectedRevision === snapshot.revision, 'revision_conflict');
    let run = null;
    if (!(action.kind === 'task' && action.to === 'ready')) {
      const ids = new Set(action.evidence.map(ref => ref.runId).filter(Boolean));
      let attempts = snapshot.currentAttempts;
      if (action.kind === 'attempt') attempts = attempts.filter(row => row.id === action.id);
      else if (action.kind === 'task') attempts = attempts.filter(row => row.taskId === action.id);
      else {
        const epics = snapshot.epics.filter(row => action.kind === 'project' || action.kind === 'milestone' && row.milestoneId === action.id || action.kind === 'epic' && row.id === action.id);
        const tasks = new Set(snapshot.tasks.filter(row => epics.some(epic => epic.id === row.epicId)).map(row => row.id));
        attempts = attempts.filter(row => tasks.has(row.taskId) && ids.has(row.runId));
      }
      requireValue(attempts.length === 1, 'binding_invalid');
      run = storedRun(store, attempts[0].runId); requireValue(run, 'binding_invalid');
    }
    const result = await D.evaluateProjectTransition({ command, snapshot, run }, { contracts: A, knownValues: options.knownValues,
      verifyRef: ref => verifyRef(engine, ref, run),
      validateRun: value => validateRun({ store, engine, contracts: A, snapshot, run: value, publication: action.to === 'released' }) });
    requireValue(result?.eligibleStates?.includes(action.to), 'transition_blocked');
  };
}

export function createProjectDirector({ repo, engine, planner, evaluator, clock = () => new Date().toISOString() } = {}) {
  const store = engine.store;
  const optionsFor = options => ({ actor: options.actor || 'project-director', reason: options.reason || 'Foreground Project command' });
  const command = (snapshot, action, options = {}) => ({ schemaVersion: 1, commandId: options.commandId || randomUUID(),
    projectId: snapshot.project.projectId, expectedRevision: snapshot.revision, ...optionsFor(options), action });
  const apply = (snapshot, action, options) => repo.apply(command(snapshot, action, options));
  const snapshotFor = async id => { const snapshot = await repo.snapshot(id); complete(snapshot); return snapshot; };
  const ports = async () => ({ contracts: await contractsFor(), knownValues: known(engine) });

  async function plan(id, options = {}) {
    const snapshot = await snapshotFor(id), A = await ports();
    const config = await readConfig(snapshot.project.root, options.mode === undefined ? {} : { executionMode: options.mode });
    requireValue(Number.isSafeInteger(options.limit ?? 24) && (options.limit ?? 24) >= 1 && (options.limit ?? 24) <= 24, 'limit_invalid');
    const limit = Math.min(options.limit ?? 24, resolveMode({ requested: options.mode, config }).profile.maxTasks);
    const availability = [];
    for (const task of snapshot.tasks) {
      let verified = true, reason = null;
      try { for (const ref of task.interfaceRefs) await verifyRef(engine, ref); }
      catch { verified = false; reason = 'interface_proof_invalid'; }
      availability.push({ taskId: task.id, available: true, interfacesVerified: verified, reason });
    }
    const planHorizon = typeof planner === 'function' ? planner : planner?.planProjectHorizon || (await import('./project-planner.mjs')).planProjectHorizon;
    return planHorizon({ snapshot, limit, availability, now: clock() }, A);
  }

  // A durable branch/head is a frontier only when all accepted code is present.
  // Compare Git ancestry rather than timestamps or the user's unchanged checkout.
  async function frontier(snapshot, task) {
    const root = snapshot.project.root;
    requireValue(await canonical(root) === snapshot.project.projectKey, 'root_changed');
    const current = await git(root, ['rev-parse', 'HEAD']);
    const relevant = snapshot.currentAttempts.filter(attempt => settled(snapshot.tasks.find(row => row.id === attempt.taskId)?.status));
    const heads = [];
    for (const attempt of relevant) {
      const run = storedRun(store, attempt.runId);
      requireValue(run && isDeepStrictEqual(run.directorBinding, bindingFor(attempt)) && run.state === 'succeeded'
        && await canonical(run.project) === snapshot.project.projectKey, 'frontier_binding_invalid');
      let head;
      if (run.config.delivery?.enabled) {
        requireValue(run.delivery?.mergeCommit && run.delivery.reviewedHead === run.headSha, 'frontier_publication_missing');
        head = run.delivery.mergeCommit;
      } else {
        requireValue(run.branch && run.headSha && await git(root, ['rev-parse', '--verify', `refs/heads/${run.branch}`]) === run.headSha, 'frontier_head_changed');
        head = run.headSha;
      }
      requireValue(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(head), 'frontier_head_invalid');
      heads.push(head);
    }
    for (const dependency of task.dependsOn) requireValue(relevant.some(row => row.taskId === dependency), 'frontier_dependency_missing');
    const ancestor = async (base, head) => {
      const result = await execute('git', ['merge-base', '--is-ancestor', base, head], { cwd: root, allowFailure: true });
      requireValue([0, 1].includes(result.code), 'frontier_invalid'); return result.code === 0;
    };
    let selected = current;
    for (const head of [...new Set(heads)]) {
      if (await ancestor(selected, head)) selected = head;
    }
    for (const head of [current, ...heads]) requireValue(await ancestor(head, selected), 'frontier_reconciliation_required');
    return selected;
  }

  async function foreground(id, options = {}) {
    let snapshot = await snapshotFor(id); control(snapshot);
    const token = store.acquireLease(`project:${id}`, randomUUID(), { ttlMs: 60000, limit: 1 });
    requireValue(token, 'busy');
    const controller = new AbortController(), abort = () => controller.abort();
    options.signal?.addEventListener('abort', abort, { once: true }); if (options.signal?.aborted) abort();
    let leaseLost = false;
    const renew = () => {
      try { if (store.renewLease(token)) return; } catch { /* A failed renewal also loses ownership. */ }
      leaseLost = true; abort();
    };
    const timer = setInterval(renew, engine.leaseHeartbeatMs || 10000); timer.unref();
    let pollingBusy = false;
    const polling = setInterval(async () => {
      if (pollingBusy) return;
      pollingBusy = true;
      try { const s = await repo.snapshot(id); if (s.project.paused || s.project.status === 'cancelled') abort(); }
      catch { abort(); }
      finally { pollingBusy = false; }
    }, 250); polling.unref();
    const guard = async (revision, attempt) => {
      renew(); requireValue(!leaseLost, 'lease_lost'); requireValue(!controller.signal.aborted, 'control_blocked');
      const before = await snapshotFor(id);
      requireValue(await canonical(before.project.root) === before.project.projectKey, 'root_changed');
      const s = await snapshotFor(id); control(s); renew(); requireValue(!leaseLost, 'lease_lost');
      requireValue(s.revision === before.revision, 'revision_conflict');
      requireValue(revision === undefined || s.revision === revision, 'revision_conflict');
      if (attempt) requireValue(isDeepStrictEqual(s.currentAttempts.find(row => row.taskId === attempt.taskId), attempt), 'binding_changed');
      return s;
    };
    try {
      snapshot = await guard(snapshot.revision);
      const active = snapshot.currentAttempts.filter(row => !settled(row.status) && !retryable(row.status));
      requireValue(active.length <= 1, 'multiple_active_attempts');
      let attempt = active[0], task;
      if (!attempt && options.retryFailed) {
        const candidates = snapshot.currentAttempts.filter(row => retryable(row.status));
        if (candidates.length) {
          requireValue(candidates.length === 1, 'retry_ambiguous');
          task = snapshot.tasks.find(row => row.id === candidates[0].taskId);
          await guard(snapshot.revision);
          attempt = (await apply(snapshot, { op: 'reserveAttempt', taskId: task.id, retryFailed: true }, options)).attempt;
          snapshot = await guard();
        }
      }
      if (!attempt) {
        const horizon = await plan(id, options);
        snapshot = await guard(horizon.revision);
        if (!horizon.taskIds.length) return { status: 'blocked', blockers: horizon.blocked };
        task = snapshot.tasks.find(row => row.id === horizon.taskIds[0]);
        if (task.status !== 'ready') {
          await guard(snapshot.revision);
          await apply(snapshot, { op: 'transition', kind: 'task', id: task.id, to: 'ready', evidence: [], mappings: [] });
          snapshot = await guard(); task = snapshot.tasks.find(row => row.id === task.id);
        }
        await guard(snapshot.revision);
        attempt = (await apply(snapshot, { op: 'reserveAttempt', taskId: task.id, retryFailed: false }, options)).attempt;
        snapshot = await guard();
      }
      task = snapshot.tasks.find(row => row.id === attempt.taskId);
      const A = await ports(), input = A.contracts.buildDirectorTaskInput({ project: snapshot.project, task }, A);
      let run = storedRun(store, attempt.runId);
      if (!run) {
        const baseSha = await frontier(snapshot, task);
        snapshot = await guard(snapshot.revision, attempt);
        run = await engine.createReserved(input, { ...options, project: snapshot.project.root, providers: options.providers || 'current', baseSha }, {
          binding: bindingFor(attempt), installRun: async value => {
            await guard(snapshot.revision, attempt);
            const revision = snapshot.revision, installed = await repo.installRun(value);
            snapshot = await guard(revision + 1, attempt);
            return installed;
          }
        });
      }
      requireValue(run.task === input && isDeepStrictEqual(run.directorBinding, bindingFor(attempt)), 'binding_invalid');
      await guard(snapshot.revision, attempt);
      if (!settled(attempt.status) && !['blocked', 'failed', 'cancelled'].includes(run.state)) {
        // Resume preserves Engine's fixed mode/model, quota, budget and sessions.
        // Project retry reserves a NEW Run; it never resets a saved Engine cycle.
        await engine.run(run.id, { signal: controller.signal });
      }
      snapshot = await guard(snapshot.revision, attempt);
      run = store.getRun(attempt.runId);
      if (retryable(run.state)) {
        await apply(snapshot, { op: 'transition', kind: 'attempt', id: attempt.id, to: run.state, evidence: [], mappings: [] });
        return { status: run.state, runId: run.id };
      }
      if (run.state !== 'succeeded') return { status: run.state, runId: run.id };
      await advance(id, run, guard);
      snapshot = await guard();
      const accepted = snapshot.tasks.find(row => row.id === attempt.taskId);
      return { status: settled(accepted.status) ? 'succeeded' : 'blocked', runId: run.id,
        ...(settled(accepted.status) ? {} : { blockers: ['task_acceptance_unverified'] }) };
    } finally {
      clearInterval(timer); clearInterval(polling); options.signal?.removeEventListener('abort', abort); store.releaseLease(token);
    }
  }

  async function advance(id, run, guard) {
    const A = await ports(), D = await evidenceFor(evaluator);
    let snapshot = await guard();
    // Acceptance observes the actual checked/reviewed frozen task, rather than
    // trusting a provider's completion prose or a caller-supplied decision.
    await validateRun({ store, engine, contracts: A.contracts, snapshot, run });
    const refs = [];
    if (typeof engine.persistEvidence === 'function') {
      for (const kind of ['acceptance', 'contract', 'checks', 'review', ...(run.release?.published ? ['delivery', 'release'] : [])]) {
        const headSha = ['delivery', 'release'].includes(kind) ? run.delivery.mergeCommit : run.headSha;
        const ref = await engine.persistEvidence(run, `project-${kind}`, observation(run, kind), { headSha });
        refs.push({ kind, runId: run.id, headSha, path: ref.path, sha256: ref.sha256 });
      }
    }
    for (const kind of ['attempt', 'task']) {
      for (let step = 0; step < stages.length; step++) {
        snapshot = await guard();
        const attempt = snapshot.currentAttempts.find(row => row.runId === run.id), task = snapshot.tasks.find(row => row.id === attempt.taskId);
        const record = kind === 'attempt' ? attempt : task;
        const to = record.status === 'reserved' ? 'running' : stages[stages.indexOf(record.status) + 1];
        if (!to || record.status === 'released') break;
        const evidence = [...new Map([...record.evidence, ...task.interfaceRefs, ...refs].map(ref => [ref.sha256, ref])).values()];
        const mappings = task.acceptance.map(criterion => ({ criterionId: criterion.id,
          refs: evidence.filter(ref => criterion.evidenceKinds.includes(ref.kind)).map(ref => ref.sha256),
          actor: 'project-director', reason: 'Exact frozen task passed required checks and independent review' }));
        if (mappings.some(row => !row.refs.length)) break;
        const c = command(snapshot, { op: 'transition', kind, id: record.id, to, evidence, mappings });
        const result = await D.evaluateProjectTransition({ snapshot, command: c, run }, { ...A,
          verifyRef: ref => verifyRef(engine, ref, run), validateRun: value => validateRun({ store, engine, contracts: A.contracts, snapshot, run: value, publication: to === 'released' }) });
        if (!result.eligibleStates.includes(to)) break;
        await guard(snapshot.revision, attempt);
        await repo.apply(c);
      }
    }
  }

  async function cancel(id, options = {}) {
    let snapshot = await snapshotFor(id);
    if (snapshot.project.status !== 'cancelled') await apply(snapshot, { op: 'transition', kind: 'project', id, to: 'cancelled', evidence: [], mappings: [] }, options);
    snapshot = await snapshotFor(id);
    for (const attempt of snapshot.currentAttempts.filter(row => !settled(row.status))) {
      if (attempt.status !== 'cancelled') {
        await apply(snapshot, { op: 'transition', kind: 'attempt', id: attempt.id, to: 'cancelled', evidence: [], mappings: [] });
        snapshot = await snapshotFor(id);
      }
      const run = storedRun(store, attempt.runId);
      if (run) {
        store.updateRun(run.id, { cancelRequested: true });
        if (typeof engine.cancel === 'function') await engine.cancel(run.id);
      }
    }
    return { status: 'cancelled' };
  }
  async function pause(id, options = {}) {
    const snapshot = await snapshotFor(id);
    return apply(snapshot, { op: 'setPaused', paused: options.paused ?? true }, options);
  }
  async function resume(id, options = {}) {
    const snapshot = await snapshotFor(id);
    requireValue(!['cancelled', 'failed', 'released'].includes(snapshot.project.status), 'control_blocked');
    if (snapshot.project.paused) await apply(snapshot, { op: 'setPaused', paused: false }, optionsFor(options));
    return foreground(id, options);
  }
  async function reprioritize(id, taskId, options = {}) {
    const snapshot = await snapshotFor(id), task = snapshot.tasks.find(row => row.id === taskId);
    requireValue(task, 'task_missing');
    const { schemaVersion, projectId, revision, status, createdAt, updatedAt, evidence, mappings, ...spec } = task;
    return apply(snapshot, { op: 'amend', kind: 'task', id: taskId, record: { ...spec, priority: options.priority } }, options);
  }
  async function approveRisk(id, taskId, options = {}) {
    const snapshot = await snapshotFor(id), task = snapshot.tasks.find(row => row.id === taskId);
    requireValue(task, 'task_missing');
    return apply(snapshot, { op: 'approveRisk', taskId, taskRevision: task.revision }, options);
  }
  return { plan, run: foreground, resume, cancel, pause, reprioritize, approveRisk };
}
