// Submission handling for external worker chats (`completeTask` in
// `project-external.mjs`): commit inspection, abandon and conflict retry,
// admission, remote submission preparation and `task-fast` verification.

import { createHash, randomUUID } from 'node:crypto';
import { fetchSubmission, remoteRefs, transport } from './project-remote-transport.mjs';
import { isDeepStrictEqual } from 'node:util';
import { stat } from 'node:fs/promises';
import { matchesReceiptFile, receiptBinding } from './remote-task-receipt.mjs';
import { execute } from './command.mjs';
import { retryDiff } from './project-retry-diff.mjs';
import { git } from './workspace.mjs';
import { redact } from './security.mjs';
import { inspectHistory, integrationHeadOf, mergeOnBranch } from './project-integration.mjs';
import { withIntegrationLease } from './project-integration-lease.mjs';
import { bindingFor, storedRun } from './project-director.mjs';
import { acquireLeaseWaiting, leaseOwned, withHeldLease, withProjectSection } from './project-controller-lease.mjs';
import { withMachineBuild } from './machine-build-lease.mjs';
import { openIntegrationQueue } from './project-integration-queue.mjs';
import { verifyTaskFastOnce } from './wave-verifier.mjs';
import {
  ancestor,
  cancelled,
  clockMs,
  command,
  controlledProject,
  currentOf,
  fail,
  inFlightStates,
  integrationStarted,
  logEvent,
  need,
  snapshotOf,
  storeOf,
  transition,
} from './project-external-shared.mjs';

// Symbolic links and submodules never enter the integration branch (raw output: never redacted).
async function specialEntries(cwd, base, head) {
  const raw = await git(cwd, ['diff', '--raw', '--no-renames', '--no-abbrev', base, head], { rawOutput: true });
  return raw
    .split(/\r?\n/)
    .filter(Boolean)
    .filter(line => /^:\d{6} (?:120000|160000) /.test(line));
}
// What the worker chat has to fix for each refusal of the submitted commit (constant text).
const submissionMessages = {
  external_branch_mismatch: 'The brief branch does not point at --head: commit on brief.branch and submit its head.',
  external_worktree_missing: 'The brief worktree is missing or is not a Git work tree.',
  external_worktree_mismatch:
    'The brief worktree is not on brief.branch at --head: check out brief.branch there and submit its head.',
  external_worktree_dirty: 'The brief worktree has uncommitted or untracked files: commit or remove them.',
  external_no_changes: '--head equals brief.baseSha: commit the change before submitting.',
  external_not_descendant: 'brief.baseSha is not an ancestor of --head: commit on top of brief.baseSha without rebase.',
  external_symlink: 'The change adds a symbolic link or a submodule: replace it with regular files.',
  external_head_changed: 'The worktree head moved while the checks ran: submit the current head again.',
};
const problem = (code, error, secrets = {}) => ({
  code,
  ...(error
    ? { message: redact(String(error.message), secrets).slice(0, 2000) }
    : submissionMessages[code]
      ? { message: submissionMessages[code] }
      : {}),
});
const historyCodes = {
  scope: 'external_scope',
  cargo_lock_version_change: 'external_scope',
  secret_path: 'external_scope',
  special: 'external_symlink',
  secret: 'external_unsafe_change',
  unverifiable: 'external_history_unverifiable',
  too_long: 'external_history_too_long',
};
// Every commit of base..head, not only the result: a secret committed and deleted later is still
// in the history the merge would bring into the integration branch.
async function historyDefect(engine, run, task, head) {
  const found = await inspectHistory({
    cwd: run.project,
    base: run.baseSha,
    head,
    writePaths: task.writePaths,
    secrets: engine.secrets,
  });
  if (!found) return null;
  const where = found.commit ? `commit ${found.commit.slice(0, 12)}: ${found.file}` : `more than the commit limit`;
  return {
    code: historyCodes[found.kind],
    message: redact(`Unsafe history (${found.kind}) in ${where}`, engine.secrets).slice(0, 2000),
  };
}
// The worker's branch and worktree still stand clean on `head`; the first defect otherwise. Checked
// on submission and again by the queue drain right before the merge.
export async function workerStateDefect(run, head) {
  const branch = await execute('git', ['rev-parse', '--verify', '--quiet', `refs/heads/${run.branch}`], {
    cwd: run.project,
    allowFailure: true,
  });
  if (branch.code !== 0 || branch.stdout.trim() !== head) return problem('external_branch_mismatch');
  // A deleted worktree directory: git cannot even start there (ENOENT), so it is checked first.
  const directory = await stat(run.cwd).catch(() => null);
  if (!directory?.isDirectory()) return problem('external_worktree_missing');
  const worktreeHead = await execute('git', ['rev-parse', 'HEAD'], { cwd: run.cwd, allowFailure: true });
  if (worktreeHead.code !== 0) return problem('external_worktree_missing');
  if (
    worktreeHead.stdout.trim() !== head ||
    (await git(run.cwd, ['branch', '--show-current'], { rawOutput: true })) !== run.branch
  )
    return problem('external_worktree_mismatch');
  if (await git(run.cwd, ['status', '--porcelain=v1', '--untracked-files=all']))
    return problem('external_worktree_dirty');
  return null;
}
// Worker-fixable defects of the submitted commit, before any check runs.
async function inspectSubmission(engine, run, task, head) {
  const state = await workerStateDefect(run, head);
  if (state) return state;
  if (head === run.baseSha) return problem('external_no_changes');
  if (!(await ancestor(run.project, run.baseSha, head))) return problem('external_not_descendant');
  const history = await historyDefect(engine, run, task, head);
  if (history) return history;
  if ((await specialEntries(run.project, run.baseSha, head)).length) return problem('external_symlink');
  try {
    await engine.checkScope(run.cwd, run.baseSha, task.writePaths, task.writePaths);
  } catch (error) {
    return problem(
      error.code === 'scope_conflict' ? 'external_scope' : 'external_unsafe_change',
      error,
      engine.secrets,
    );
  }
  return null;
}
async function abandonAttempt(ctx, snapshot, attempt, run, { head, commandId }) {
  const store = storeOf(ctx);
  // The abandon names its attempt and head: a late repeat replays it and never stops a retry.
  const abandoned = run.externalAbandon ?? { schemaVersion: 1, attemptId: attempt.id, headSha: head };
  if (attempt.status === 'blocked') {
    if (run.state !== 'cancelled' || !run.externalAbandon)
      store.updateRun(run.id, { cancelRequested: true, state: 'cancelled', externalAbandon: abandoned });
    return { status: 'abandoned', attemptId: attempt.id, revision: snapshot.revision, replayed: true };
  }
  if (!inFlightStates.has(attempt.status) || run.integration?.status === 'merged')
    return { status: 'blocked', code: 'project_attempt_not_running', revision: snapshot.revision };
  await ctx.repo.apply(
    command(snapshot, transition('attempt', attempt.id, 'blocked'), {
      commandId,
      reason: 'External worker abandoned the task',
    }),
  );
  store.updateRun(run.id, {
    cancelRequested: true,
    state: 'cancelled',
    error: { code: 'external_abandoned', message: 'External worker abandoned the task' },
    externalAbandon: abandoned,
  });
  logEvent(
    store,
    run.id,
    'cancelled',
    { attemptId: attempt.id, headSha: head, code: 'external_abandoned' },
    clockMs(ctx),
  );
  return {
    status: 'abandoned',
    attemptId: attempt.id,
    revision: (await snapshotOf(ctx, snapshot.project.projectId)).revision,
  };
}
// Runs inside the queue drain's fenced project and integration sections.
export async function scheduleConflictRetry(ctx, snapshot, task, attempt, run, headSha, integration) {
  const code = 'project_integration_conflict';
  const used = storeOf(ctx)
    .db.prepare(
      "SELECT count(*) AS n FROM kodo_project_attempts a JOIN runs r ON r.id=a.run_id WHERE a.project_id=? AND a.task_id=? AND json_type(r.body, '$.externalConflict')='object'",
    )
    .get(snapshot.project.projectId, task.id).n;
  if (used >= 2) return { status: 'rejected', code, integration };
  const previousAttempt = {
    attemptId: attempt.id,
    headSha,
    reason: code,
  };
  const retry = { scheduled: true, remaining: 1 - used };
  const current = currentOf(snapshot, task.id);
  if (current.id !== attempt.id || cancelled(run)) return { status: 'rejected', code: 'project_submission_stale' };
  if (current.status !== 'blocked')
    await ctx.repo.apply(
      command(snapshot, transition('attempt', attempt.id, 'blocked'), {
        commandId: randomUUID(),
        reason: 'project_integration_conflict_retry',
      }),
    );
  storeOf(ctx).updateRun(run.id, {
    state: 'cancelled',
    cancelRequested: true,
    externalAbandon: { schemaVersion: 1, attemptId: attempt.id, headSha },
    externalConflict: {
      previousAttempt,
      writePaths: task.writePaths,
      retry,
      integration,
      reason: integration.reason ?? code,
      number: attempt.number,
    },
    error: { code: 'project_integration_conflict_retry', message: 'Integration conflict' },
  });
  return {
    status: 'rejected',
    code: 'project_integration_conflict_retry',
    retry,
    integration,
    reason: integration.reason ?? code,
  };
}
// The drain persists the immutable inputs before settling the queue. A completion,
// its replay or a concurrent next-wave can finish capture after releasing the leases.
export async function captureConflictDiff(ctx, runId, legacyScopes) {
  const store = storeOf(ctx);
  const run = store.getRun(runId);
  const conflict = run.externalConflict;
  if (conflict.previousAttempt.truncated !== undefined) return conflict.previousAttempt;
  const captured = await retryDiff(
    run,
    conflict.writePaths ?? legacyScopes,
    conflict.previousAttempt.headSha,
    ctx.engine.secrets,
  );
  const previousAttempt = { ...conflict.previousAttempt, ...captured };
  store.updateRun(runId, { externalConflict: { ...conflict, previousAttempt } });
  return previousAttempt;
}
// The Runs of this task's attempts that an abandon already stopped with `head`.
function recordedAbandons(ctx, snapshot, taskId, head) {
  return storeOf(ctx)
    .listRuns(snapshot.project.root)
    .filter(
      row =>
        row.directorBinding?.projectId === snapshot.project.projectId &&
        row.directorBinding.taskId === taskId &&
        row.executor?.kind === 'external' &&
        row.externalAbandon?.schemaVersion === 1 &&
        row.externalAbandon.attemptId === row.directorBinding.attemptId &&
        row.externalAbandon.headSha === head,
    );
}
// The Run of an earlier attempt of this task that an abandon already stopped (`attemptId`). Null
// when the current attempt is meant or the named attempt was never abandoned.
function earlierAbandon(ctx, snapshot, attempt, attemptId) {
  if (attemptId === attempt.id) return null;
  return (
    storeOf(ctx)
      .listRuns(snapshot.project.root)
      .find(
        row =>
          row.directorBinding?.projectId === snapshot.project.projectId &&
          row.directorBinding.taskId === attempt.taskId &&
          row.directorBinding.attemptId === attemptId &&
          row.executor?.kind === 'external' &&
          row.externalAbandon?.schemaVersion === 1,
      ) ?? null
  );
}
const replayedAbandon = (row, snapshot) => ({
  status: 'abandoned',
  attemptId: row.directorBinding.attemptId,
  revision: snapshot.revision,
  replayed: true,
});
// `--abandon` stops exactly the attempt it names (`attemptId`): a repeat for an earlier attempt
// returns that result and leaves the current attempt (a retry) alone; a named attempt that is
// not current is stale. Without an attempt id only an unambiguous repeat of an abandon already
// recorded with this head is answered (its result, nothing changes); anything else is
// `project_arguments` and never stops the current attempt.
export async function abandonTarget(ctx, { snapshot, attempt, run }, input) {
  if (input.attemptId === undefined) {
    const recorded = recordedAbandons(ctx, snapshot, attempt.taskId, input.head);
    need(recorded.length === 1, 'arguments');
    return replayedAbandon(recorded[0], snapshot);
  }
  const earlier = earlierAbandon(ctx, snapshot, attempt, input.attemptId);
  if (earlier) return replayedAbandon(earlier, snapshot);
  if (input.attemptId !== attempt.id)
    return { status: 'blocked', code: 'project_attempt_stale', revision: snapshot.revision };
  return abandonAttempt(ctx, snapshot, attempt, run, input);
}
// Whether the merge the Run recorded is still on the integration branch with its recorded parents.
export async function mergeRecorded(projectId, run) {
  const integration = run.integration;
  return (
    integration?.status === 'merged' &&
    integration.mergedHead === run.headSha &&
    (await mergeOnBranch({
      cwd: run.project,
      branchHead: await integrationHeadOf({ cwd: run.project, projectId }),
      mergeCommit: integration.mergeCommit,
      before: integration.before,
      mergedHead: run.headSha,
    }))
  );
}
// A completion already recorded for this head is returned, not repeated; deferred gates may still
// run (`finishCompletion`). The recorded merge is checked first under lease
// `project-integration:<id>` (reachable from the branch head with both recorded parents): a merge
// that left the branch (reset, rewrite) is a recovery blocker, never a replayed `integrated`. A
// queue row that a stopped drain left live for this head is finished with the same verdict.
// Runs in the caller's project section.
export async function replayedMerge(ctx, input, run) {
  const store = storeOf(ctx),
    { projectId } = input;
  const present = await withIntegrationLease(store, projectId, () => mergeRecorded(projectId, run), {
    signal: input.signal,
  });
  const queue = openIntegrationQueue(store);
  if (present) {
    queue.settle(projectId, run.id, input.head, {
      status: 'integrated',
      integration: run.externalCompletion.integration,
    });
    return null;
  }
  queue.settle(projectId, run.id, input.head, { status: 'rejected', code: 'project_integration_missing' });
  return {
    status: 'blocked',
    code: 'project_integration_missing',
    integration: run.externalCompletion.integration,
    revision: (await snapshotOf(ctx, projectId)).revision,
    replayed: true,
  };
}
// Where a submission of `head` stands now: `verified` (this head passed or is integrated), `stale`
// (another attempt or Run, an abandon or cancel, another head integrated, the attempt stopped) or
// `go` (verify it). Read in a project section.
async function verificationState(ctx, C, input, attemptId, runId) {
  const { attempt, run } = await externalAttempt(ctx, C, input.projectId, input.taskId);
  const head = input.head;
  if (attempt.id !== attemptId || run.id !== runId || cancelled(run)) return 'stale';
  if (run.externalCompletion?.headSha === head) return 'verified';
  if (integrationStarted(run))
    return run.integration.mergedHead === head || run.headSha === head ? 'verified' : 'stale';
  if (run.externalCompletion) return 'stale';
  if (run.state === 'succeeded' && run.headSha === head && run.checks?.headSha === head && run.checks.complete)
    return 'verified';
  return ['running', 'verifying'].includes(attempt.status) ? 'go' : 'stale';
}
// A profile machine id as a build-semaphore id: profile ids may hold `/` and run to 128
// characters, the semaphore takes `[a-z0-9._-]{1,64}`; others get a stable digest.
const buildSlotId = id =>
  /^[a-z0-9][a-z0-9._-]{0,63}$/i.test(id) ? id : `m-${createHash('sha256').update(id).digest('hex').slice(0, 24)}`;
// The build slot of a submission: an explicit `input.machine` (library callers); else, for an
// attempt the profile placed (15A `workerPlacement`), the slot of the PC that runs task-fast. In
// 1.1.0 that is always this PC (remote builds come with 16A): a local placement keeps its machine
// and current `maxHeavyBuilds` (1 when the profile no longer lists it); a t3-env/ssh placement uses
// the profile's local machine, else this PC's default slot.
function submissionMachine(ctx, projectId, run, input) {
  if (input.machine) return input.machine;
  const placed = run.workerPlacement?.machine;
  if (typeof placed?.id !== 'string') return undefined;
  const machines = ctx.repo.getProfile?.(projectId)?.machines ?? [];
  const host =
    placed.kind === 'local'
      ? (machines.find(row => row.id === placed.id) ?? { id: placed.id, maxHeavyBuilds: 1 })
      : machines.find(row => row.kind === 'local');
  return host ? { id: buildSlotId(host.id), maxHeavyBuilds: host.maxHeavyBuilds ?? 1 } : undefined;
}
// Verify the submitted head once. One verification per Run at a time (`project-verify:<runId>`,
// taken before the machine slot): a duplicate submission waits for the first and then finds the
// head verified. In one build slot of the machine (`machine-build:<id>`) the state is read again,
// `task-fast` runs outside `project:<id>`, and the verdict is written in a short project section
// that checks again for an abandon, a cancel, a recorded completion, an integration or another
// head; a cancel is never overwritten (`preserveCancellation`). A lost lease stops the check.
export async function verifySubmission(ctx, C, step, input) {
  const store = storeOf(ctx),
    { projectId, head, signal } = input,
    { attempt, run } = step;
  const verify = typeof input.ports?.verifyTaskFast === 'function' ? input.ports.verifyTaskFast : verifyTaskFastOnce;
  const section = work => withProjectSection(store, projectId, work, { signal });
  const state = () => section(() => verificationState(ctx, C, input, attempt.id, run.id));
  const stale = { blocked: 'project_submission_stale' };
  const machine = submissionMachine(ctx, projectId, run, input);
  const dedupe = await acquireLeaseWaiting(store, `project-verify:${run.id}`, { signal, waitMs: 2 * 3600000 });
  return withHeldLease(store, dedupe, async dedupeLost => {
    const before = await state();
    if (before !== 'go') return before === 'verified' ? null : stale;
    let remoteChecks;
    if (step.remote) {
      const checked = signal ? AbortSignal.any([dedupeLost, signal]) : dedupeLost;
      const checkLease = () => {
        if (!leaseOwned(store, dedupe)) fail('lease_lost');
        checked.throwIfAborted();
      };
      const prepared = await prepareRemoteSubmission(ctx, step, input, checked, checkLease);
      if (prepared.fetched !== false) {
        const rejected = prepared.defect;
        const defect = rejected && ('code' in rejected ? rejected : { code: rejected.blocked });
        logSubmission(ctx, run, step.attempt, input.head, defect);
        if (
          defect &&
          ![
            'external_head_changed',
            'external_branch_mismatch',
            'external_worktree_missing',
            'external_worktree_dirty',
            'external_worktree_mismatch',
            'project_submission_locked',
            'project_submission_stale',
          ].includes(defect.code) &&
          !cancelled(store.getRun(run.id))
        )
          recordFailure(ctx, run, defect);
      }
      if (prepared.defect) return prepared.defect;
      remoteChecks = prepared.remoteChecks;
    }
    return withMachineBuild(
      store,
      async slotLost => {
        const now = await state();
        if (now !== 'go') return now === 'verified' ? null : stale;
        const checked = AbortSignal.any([dedupeLost, slotLost, ...(signal ? [signal] : [])]);
        const startedAt = clockMs(ctx);
        let verdict;
        try {
          verdict = await verify({
            engine: ctx.engine,
            run: run.id,
            signal: checked,
            expectedHeadSha: head,
            remoteChecks,
            ...(machine?.maxHeavyBuilds ? { maxHeavyBuilds: machine.maxHeavyBuilds } : {}),
          });
        } catch (error) {
          // Another call verifies the same Run right now (its lease `run:<id>`).
          if (error?.code === 'run_busy') return { blocked: 'project_task_busy' };
          // A fenced write of the check found a lease of this submission gone.
          if (error?.code === 'project_lease_lost') return { blocked: 'project_lease_lost' };
          if (dedupeLost.aborted || slotLost.aborted) return { blocked: 'project_lease_lost' };
          if (cancelled(store.getRun(run.id))) return stale;
          throw error;
        }
        const finishedAt = clockMs(ctx);
        if (dedupeLost.aborted || slotLost.aborted || !leaseOwned(store, dedupe))
          return { blocked: 'project_lease_lost' };
        if (verdict.skipped)
          return verdict.code === 'head_changed'
            ? problem('external_head_changed')
            : (await state()) === 'verified'
              ? null
              : stale;
        // The verdict and its telemetry events are written together in a short project section,
        // fenced by `project-verify`, the build slot and the section (one transaction).
        try {
          return await section(async () => {
            const current = await verificationState(ctx, C, input, attempt.id, run.id);
            if (current === 'stale') return stale;
            return store.withFence([], () => {
              const written = store.getRun(run.id);
              if (cancelled(written) || integrationStarted(written) || written.externalCompletion) return stale;
              if (!verdict.passed || verdict.headSha !== head) {
                if (verificationFailureStatus(verdict.code) === 'checks_failed')
                  recordFailure(ctx, run, verdict.passed ? problem('external_head_changed') : verdict);
                // A failed check keeps its diagnostic pack for the next attempt's brief (15D).
                store.updateRun(
                  run.id,
                  {
                    state: 'executing',
                    ...(step.remote && !verdict.passed ? { remoteRejectedHead: head } : {}),
                    ...(verdict.diagnostics ? { lastDiagnostics: verdict.diagnostics } : {}),
                  },
                  { preserveCancellation: true },
                );
                if (!verdict.passed) {
                  logEvent(store, run.id, 'task_fast_started', { attemptId: attempt.id, headSha: head }, startedAt);
                  logEvent(
                    store,
                    run.id,
                    'task_fast_finished',
                    {
                      attemptId: attempt.id,
                      headSha: head,
                      passed: false,
                      outcome: 'failed',
                      code: verdict.code ?? 'check_failed',
                    },
                    finishedAt,
                  );
                }
                return verdict.passed
                  ? problem('external_head_changed')
                  : {
                      code: verdict.code,
                      message: verdict.message,
                      ...(verdict.diagnostics ? { diagnostics: verdict.diagnostics } : {}),
                    };
              }
              // Only the head that was checked, with its complete proof, becomes `succeeded`.
              if (written.headSha !== head || written.checks?.headSha !== head || written.checks.complete !== true)
                return stale;
              store.updateRun(
                run.id,
                { state: 'succeeded', error: null, lastDiagnostics: null, externalFailure: null },
                { preserveCancellation: true },
              );
              logEvent(store, run.id, 'task_fast_started', { attemptId: attempt.id, headSha: head }, startedAt);
              logEvent(
                store,
                run.id,
                'task_fast_finished',
                { attemptId: attempt.id, headSha: head, passed: true, outcome: 'passed' },
                finishedAt,
              );
              logEvent(store, run.id, 'succeeded', { attemptId: attempt.id, headSha: head }, finishedAt);
              return null;
            });
          });
        } catch (error) {
          if (error?.code === 'project_lease_lost') return { blocked: 'project_lease_lost' };
          throw error;
        }
      },
      { machine, signal },
    );
  });
}
// The external Run of the task's current attempt, or a constant refusal.
export async function externalAttempt(ctx, C, projectId, taskId) {
  const snapshot = await snapshotOf(ctx, projectId);
  need(C.isWaveProject(snapshot.project), 'wave_required');
  const task = snapshot.tasks.find(row => row.id === taskId);
  need(task, 'task_missing');
  const attempt = currentOf(snapshot, taskId);
  need(attempt, 'attempt_missing');
  const run = storedRun(storeOf(ctx), attempt.runId);
  need(
    run?.executor?.kind === 'external' && isDeepStrictEqual(run.directorBinding, bindingFor(attempt)),
    'attempt_not_external',
  );
  return { snapshot, task, attempt, run };
}
// The checks of a submission that need consistent project state, in one short project section:
// a decided result, a replay of a recorded completion, or the attempt to verify and integrate.
export const verificationFailureStatus = code => (code === 'cargo_fetch_failed' ? 'blocked' : 'checks_failed');
function recordFailure(ctx, run, defect) {
  const store = storeOf(ctx);
  const signature = createHash('sha256')
    .update(
      JSON.stringify([defect.code, defect.diagnostics?.items?.[0] ?? defect.diagnostics?.failingTests?.[0] ?? null]),
    )
    .digest('hex');
  const last = store.getRun(run.id).externalFailure;
  const repeated = last?.signature === signature;
  store.updateRun(run.id, {
    externalFailure: {
      signature,
      code: defect.code,
      repeated,
      since: repeated ? last.since : (ctx.clock?.() ?? new Date().toISOString()),
    },
  });
}
// A submission's inspection outcome for telemetry (16C): accepted or the defect code.
const logSubmission = (ctx, run, attempt, head, defect) => {
  const store = storeOf(ctx);
  const data = { attemptId: attempt.id, headSha: head, accepted: !defect, ...(defect ? { code: defect.code } : {}) };
  // The same head submitted again with the same verdict is one submission for telemetry; the
  // watchdog still counts the repeated failure (recordFailure).
  const last = store.events(run.id).findLast(event => event.type === 'task_submitted');
  if (last && isDeepStrictEqual(last.data, data)) return;
  logEvent(store, run.id, 'task_submitted', data, clockMs(ctx));
};
export async function admitSubmission(ctx, C, input) {
  const { projectId, taskId, head, attemptId } = input;
  const current = await externalAttempt(ctx, C, projectId, taskId);
  const { snapshot, task, attempt, run } = current;
  const blocked = code => ({ result: { status: 'blocked', code, revision: snapshot.revision } });
  const recorded = attemptId && attemptId !== attempt.id ? earlierAbandon(ctx, snapshot, attempt, attemptId) : run;
  if (recorded?.externalConflict?.previousAttempt.headSha === head)
    return {
      conflictRunId: recorded.id,
      task,
      result: {
        status: 'abandoned',
        code: 'project_integration_conflict_retry',
        retry: recorded.externalConflict.retry,
        integration: recorded.externalConflict.integration ?? null,
        reason: recorded.externalConflict.reason ?? recorded.externalConflict.previousAttempt.reason,
        revision: snapshot.revision,
      },
    };
  if (attemptId !== undefined && attemptId !== attempt.id) return blocked('project_attempt_stale');
  if (run.externalCompletion?.headSha === head) {
    const missing = await replayedMerge(ctx, input, run);
    return missing ? { result: missing } : { replay: run };
  }
  if (
    remoteRefs(projectId, run) &&
    run.headSha !== head &&
    (run.state === 'succeeded' || integrationStarted(run) || run.externalCompletion)
  )
    return blocked('project_submission_locked');
  if (controlledProject(snapshot.project)) return blocked('project_control_blocked');
  // A verified head whose integration was interrupted (crash) continues where it stopped.
  const interrupted = run.state === 'succeeded' && run.headSha === head && integrationStarted(run);
  if (interrupted) return { ...current, verified: true };
  if (!['running', 'verifying'].includes(attempt.status) || run.integration?.status === 'merged')
    return blocked('project_attempt_not_running');
  const remote = remoteRefs(projectId, run);
  if (!remote) {
    const defect = await inspectSubmission(ctx.engine, run, task, head);
    logSubmission(ctx, run, attempt, head, defect);
    if (defect) {
      // After reassignment, a bare SHA off this branch (or its shared starting
      // commit) does not identify the current worker. Its own commits still count.
      const attributable =
        attemptId !== undefined ||
        attempt.number === 1 ||
        (head !== run.baseSha && defect.code !== 'external_branch_mismatch');
      if (attributable) recordFailure(ctx, run, defect);
      return { result: { status: 'checks_failed', ...defect, revision: snapshot.revision } };
    }
  }
  return { ...current, verified: false, remote };
}
// The per-Run verification lease serializes checkout changes, including two dispatchers
// submitting different heads. Network, scope inspection and command planning hold no project lease.
async function prepareRemoteSubmission(ctx, step, input, signal, checkLease) {
  const { run, task, remote } = step;
  const { head, projectId } = input;
  const store = storeOf(ctx);
  const fetched = await fetchSubmission(run, remote, head, signal, checkLease);
  if (fetched) return { fetched: false, defect: { blocked: fetched } };
  if (!(await ancestor(run.project, run.baseSha, head))) return { defect: problem('external_not_descendant') };
  const unsafe = await historyDefect(ctx.engine, run, task, head);
  if (unsafe) return { defect: unsafe };
  if ((await specialEntries(run.project, run.baseSha, head)).length) return { defect: problem('external_symlink') };
  checkLease();
  const current = store.getRun(run.id);
  if (cancelled(current)) return { defect: { blocked: 'project_submission_stale' } };
  if (current.state === 'succeeded' || integrationStarted(current))
    return { defect: { blocked: 'project_submission_locked' } };
  const previous = await git(run.cwd, ['rev-parse', 'HEAD']);
  const changed = await workerStateDefect(run, previous);
  if (changed) return { defect: changed };
  checkLease();
  if (previous !== head) {
    if (previous === run.baseSha || (await ancestor(run.project, previous, head))) {
      await transport(run.cwd, ['merge', '--ff-only', head], signal);
    } else if (current.remoteRejectedHead === previous) {
      await transport(run.cwd, ['reset', '--keep', head], signal);
    } else return { defect: { blocked: 'project_submission_locked' } };
  }
  const defect = await inspectSubmission(ctx.engine, run, task, head);
  if (defect) {
    if (defect.code !== 'external_head_changed' && !cancelled(store.getRun(run.id))) {
      store.updateRun(run.id, { remoteRejectedHead: head }, { preserveCancellation: true });
    }
    return { defect };
  }
  if (
    input.receipt &&
    ctx.repo.getProfile(projectId)?.machines.some(m => m.id === run.workerPlacement.machine.id && m.trustedBuilds)
  ) {
    const binding = await receiptBinding(run, head);
    if (!(await matchesReceiptFile(input.receipt, binding))) return { defect: { blocked: 'project_receipt_mismatch' } };
    return { remoteChecks: { ...binding, source: 'remote' } };
  }
  return {};
}
