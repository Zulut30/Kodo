import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Store } from '../runtime/store.mjs';
import { openProjectStore } from '../runtime/project-store.mjs';
import * as contracts from '../runtime/project-contracts.mjs';
import { openIntegrationQueue } from '../runtime/project-integration-queue.mjs';
import { buildProjectReport } from '../runtime/telemetry.mjs';
import { humanProject, reportCli } from '../runtime/report-cli.mjs';
import { nextWave, completeTask } from '../runtime/project-external.mjs';
import { Engine } from '../runtime/engine.mjs';
import { git } from '../runtime/workspace.mjs';

const T0 = Date.parse('2026-11-25T10:00:00.000Z');
const at = sec => T0 + sec * 1000;
const iso = sec => new Date(at(sec)).toISOString();
const sha = n => String(n).padStart(40, '0');
const criterion = id => ({ id, text: 'Independent observable requirement', evidenceKinds: ['acceptance'] });

function taskSpec(id, epicId, writePaths, dependsOn = []) {
  return {
    id,
    epicId,
    title: `Task ${id}`,
    description: `Implement ${id}`,
    owner: 'developer',
    dependsOn,
    writePaths,
    acceptance: [criterion(`${id}-proof`)],
    interfaceRefs: [],
    priority: 50,
    userValue: 1,
    risk: 1,
    estimatedEffort: 1,
    riskApprovalRequired: false,
  };
}

function sessionMetric(durationMs) {
  return {
    durationMs,
    toolSteps: 1,
    promptBytes: 800,
    contextOriginalBytes: 2000,
    contextSentBytes: 500,
    nativeRequestCount: null,
    usage: {
      inputTokens: 40,
      cachedInputTokens: 0,
      outputTokens: 10,
      cacheReadTokens: null,
      cacheWriteTokens: null,
      totalTokens: 50,
      semantics: 'input-includes-cached',
      source: 'codex.usage',
    },
  };
}

const sessionRow = (stage, durationMs, status = 'completed') => ({
  stage,
  node: null,
  client: 'codex',
  model: 'gpt-6.2-astra',
  status,
  metrics: sessionMetric(durationMs),
});

const PROFILE = {
  schemaVersion: 1,
  subscriptions: [
    { id: 'codex-heavy', provider: 'codex', model: 'gpt-6.2-astra', slots: 2, tier: 'heavy' },
    { id: 'gemini-fast', provider: 'antigravity', model: 'gemini-4-neon', slots: 2, tier: 'fast' },
  ],
  machines: [{ id: 'local-pc', kind: 'local', maxWorkers: 4, maxHeavyBuilds: 2 }],
};

async function initRepo(dir) {
  await mkdir(dir, { recursive: true });
  await git(dir, ['init', '-b', 'main']);
  await git(dir, ['config', 'user.email', 'test@example.com']);
  await git(dir, ['config', 'user.name', 'Test']);
  await writeFile(
    path.join(dir, 'kodo.config.json'),
    JSON.stringify({
      schemaVersion: 1,
      client: 'codex',
      commands: { test: [{ command: 'node', args: ['--test'] }], build: [], deploy: [], smoke: [] },
    }),
  );
  await writeFile(path.join(dir, 'README.md'), 'init\n');
  await git(dir, ['add', '.']);
  await git(dir, ['commit', '-m', 'init']);
  return git(dir, ['rev-parse', 'HEAD']);
}

test('C1 wave project report computes all telemetry KPIs from recorded timestamps with controlled clock', async t => {
  const dir = await realpath(await mkdtemp(path.join(os.tmpdir(), 'kodo-c1-wave-')));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const root = path.join(dir, 'repo');
  const home = path.join(dir, 'state');
  const baseSha = await initRepo(root);

  let clockSec = 0;
  const clockMs = () => at(clockSec);
  const clockIso = () => iso(clockSec);

  const store = new Store(home, {}, { clock: clockMs });
  try {
    const repo = await openProjectStore({
      store,
      contracts,
      authorizeTransition: async () => {},
      clock: clockIso,
      gateRange: async () => true,
    });
    const cmd = (projectId, expectedRevision, action) => ({
      schemaVersion: 1,
      commandId: randomUUID(),
      projectId,
      expectedRevision,
      actor: 'project-external:t3',
      reason: 'Controlled telemetry fixture',
      action,
    });
    const spec = contracts.normalizeProjectSpec(
      {
        schemaVersion: 1,
        id: 'c1-wave',
        root,
        title: 'Wave telemetry fixture',
        execution: { cadence: 'wave', integration: 'branch' },
        definitionOfDone: [criterion('project-proof')],
        constraints: ['Stay in scope'],
        businessContext: 'Telemetry test',
        architectureRefs: [],
        milestones: [{ id: 'm1', title: 'M1', acceptance: [criterion('m1-proof')], releaseRequired: false }],
        epics: [
          { id: 'e1', milestoneId: 'm1', title: 'E1', acceptance: [criterion('e1-proof')] },
          { id: 'e2', milestoneId: 'm1', title: 'E2', acceptance: [criterion('e2-proof')] },
        ],
        tasks: [
          taskSpec('t1', 'e1', ['src/t1.mjs']),
          taskSpec('t2', 'e1', ['src/t2.mjs']),
          taskSpec('t3', 'e2', ['src/t3.mjs']),
        ],
      },
      { knownValues: [] },
    );

    const { projectId } = await repo.apply(cmd(null, null, { op: 'create', spec }));
    repo.setProfile(projectId, PROFILE);
    const queue = openIntegrationQueue(store, { clock: clockIso });

    const reserveAndInstall = async (taskId, placement, retryFailed = false) => {
      let s = repo.snapshot(projectId);
      const task = s.tasks.find(item => item.id === taskId);
      if (task.status === 'proposed') {
        await repo.apply(
          cmd(projectId, s.revision, {
            op: 'transition',
            kind: 'task',
            id: taskId,
            to: 'ready',
            evidence: [],
            mappings: [],
          }),
        );
        s = repo.snapshot(projectId);
      }
      const { attempt } = await repo.apply(cmd(projectId, s.revision, { op: 'reserveAttempt', taskId, retryFailed }));
      const runDraft = {
        id: attempt.runId,
        project: root,
        task: contracts.buildDirectorTaskInput(
          { project: s.project, task: s.tasks.find(i => i.id === taskId) },
          { knownValues: [] },
        ),
        createdAt: clockIso(),
        state: 'created',
        config: {
          commands: { test: [], build: [], deploy: [], smoke: [] },
          repairRounds: 1,
          delivery: { enabled: false },
        },
        client: 'codex',
        providers: 'current',
        baseSha,
        snapshot: { baseSha },
        requestedMode: null,
        sessionAttempts: [],
        coordinatorOperations: [],
        completed: {},
        nodes: {},
        artifacts: path.join(home, 'runs', attempt.runId),
        worktreeRoot: path.join(home, 'worktrees'),
        cwd: path.join(home, 'worktrees', attempt.runId),
        branch: `kodo/${attempt.runId}`,
        executor: { kind: 'external', host: 't3' },
        verificationProfile: 'task-fast',
        workerPlacement: placement,
        review: null,
        directorBinding: {
          schemaVersion: 1,
          projectId,
          taskId,
          taskRevision: attempt.taskRevision,
          attemptId: attempt.id,
          runId: attempt.runId,
          contractHash: attempt.contractHash,
        },
      };
      await repo.installRun({ binding: runDraft.directorBinding, runDraft });
      store.updateRun(attempt.runId, { state: 'executing', headSha: baseSha });
      store.event(
        attempt.runId,
        'brief_issued',
        {
          attemptId: attempt.id,
          host: 't3',
          subscriptionId: placement.subscription.id,
          machineId: placement.machine.id,
        },
        clockMs(),
      );
      s = repo.snapshot(projectId);
      await repo.apply(
        cmd(projectId, s.revision, {
          op: 'transition',
          kind: 'attempt',
          id: attempt.id,
          to: 'running',
          evidence: [],
          mappings: [],
        }),
      );
      s = repo.snapshot(projectId);
      const tCur = s.tasks.find(item => item.id === taskId);
      if (tCur.status === 'ready') {
        await repo.apply(
          cmd(projectId, s.revision, {
            op: 'transition',
            kind: 'task',
            id: taskId,
            to: 'running',
            evidence: [],
            mappings: [],
          }),
        );
      }
      return attempt;
    };

    const subCodex = {
      subscription: { id: 'codex-heavy', provider: 'codex', model: 'gpt-6.2-astra', tier: 'heavy' },
      machine: { id: 'local-pc', kind: 'local' },
    };
    const subGemini = {
      subscription: { id: 'gemini-fast', provider: 'antigravity', model: 'gemini-4-neon', tier: 'fast' },
      machine: { id: 'local-pc', kind: 'local' },
    };

    // --- Timeline (in seconds from T0) ---
    // t=0s: Issue t1 (codex-heavy) and t2 attempt #1 (gemini-fast)
    clockSec = 0;
    const a1 = await reserveAndInstall('t1', subCodex);
    const a2_1 = await reserveAndInstall('t2', subGemini);

    // t=10s: Issue t3 (codex-heavy)
    clockSec = 10;
    const a3 = await reserveAndInstall('t3', subCodex);

    // t=20s: t1 submits head1, passes task-fast on 1st try (20s..30s = 10s), enqueues at 30s,
    // dequeues at 40s (wait=10s), integrates at 45s (merge=5s). Total t1 duration: 45s - 0s = 45s.
    clockSec = 20;
    store.event(a1.runId, 'task_submitted', { attemptId: a1.id, headSha: sha(11), accepted: true }, clockMs());
    store.event(a1.runId, 'task_fast_started', { attemptId: a1.id, headSha: sha(11) }, clockMs());
    clockSec = 30;
    store.event(a1.runId, 'task_fast_finished', { attemptId: a1.id, headSha: sha(11), passed: true }, clockMs());
    store.updateRun(a1.runId, {
      state: 'succeeded',
      headSha: sha(11),
      checks: { profile: 'task-fast', headSha: sha(11), complete: true, results: [] },
    });
    store.event(a1.runId, 'succeeded', { attemptId: a1.id, headSha: sha(11) }, clockMs());
    const q1 = queue.enqueue({ projectId, taskId: 't1', attemptId: a1.id, runId: a1.runId, baseSha, headSha: sha(11) });
    store.event(a1.runId, 'integration_enqueued', { seq: q1.seq, attemptId: a1.id, headSha: sha(11) }, clockMs());
    clockSec = 40;
    const [c1] = queue.claim(projectId, { maxBatch: 1 });
    store.event(a1.runId, 'integration_dequeued', { seq: c1.seq, attemptId: a1.id, headSha: sha(11) }, clockMs());
    clockSec = 45;
    store.updateRun(a1.runId, {
      integration: {
        branch: `kodo/project/${projectId}`,
        before: baseSha,
        mergeCommit: sha(101),
        mergedHead: sha(11),
        status: 'merged',
        mergedAt: clockIso(),
      },
      externalCompletion: {
        schemaVersion: 1,
        headSha: sha(11),
        integration: { status: 'integrated', mergeCommit: sha(101) },
        gates: null,
        integratedAt: clockIso(),
      },
    });
    queue.finish(c1.seq, c1.claim, { status: 'integrated', dequeuedAt: iso(40), finishedAt: iso(45) });
    store.event(
      a1.runId,
      'integration_finished',
      { seq: c1.seq, attemptId: a1.id, headSha: sha(11), status: 'integrated' },
      clockMs(),
    );
    for (const to of ['verifying', 'integrated']) {
      let s = repo.snapshot(projectId);
      await repo.apply(
        cmd(projectId, s.revision, { op: 'transition', kind: 'attempt', id: a1.id, to, evidence: [], mappings: [] }),
      );
      s = repo.snapshot(projectId);
      await repo.apply(
        cmd(projectId, s.revision, { op: 'transition', kind: 'task', id: 't1', to, evidence: [], mappings: [] }),
      );
    }

    // t=50s: t2 attempt #1 submits head21 -> fails task-fast (50s..60s = 10s), then abandoned at t=60s!
    // Agent time for a2_1: 50s - 0s = 50s.
    clockSec = 50;
    store.event(a2_1.runId, 'task_submitted', { attemptId: a2_1.id, headSha: sha(21), accepted: true }, clockMs());
    store.event(a2_1.runId, 'task_fast_started', { attemptId: a2_1.id, headSha: sha(21) }, clockMs());
    clockSec = 60;
    store.event(
      a2_1.runId,
      'task_fast_finished',
      { attemptId: a2_1.id, headSha: sha(21), passed: false, code: 'check_failed' },
      clockMs(),
    );
    let s = repo.snapshot(projectId);
    await repo.apply(
      cmd(projectId, s.revision, {
        op: 'transition',
        kind: 'attempt',
        id: a2_1.id,
        to: 'blocked',
        evidence: [],
        mappings: [],
      }),
    );
    store.updateRun(a2_1.runId, {
      cancelRequested: true,
      state: 'cancelled',
      error: { code: 'external_abandoned', message: 'abandoned' },
      externalAbandon: { schemaVersion: 1, attemptId: a2_1.id, headSha: sha(21) },
    });
    store.event(
      a2_1.runId,
      'cancelled',
      { attemptId: a2_1.id, headSha: sha(21), code: 'external_abandoned' },
      clockMs(),
    );

    // t=90s: Human/dispatcher runs retry-failed for t2 -> attempt #2 (gemini-fast)!
    // Human wait between abandon (60s) and retry-failed (90s) = 30s!
    clockSec = 90;
    const a2_2 = await reserveAndInstall('t2', subGemini, true);

    // t=110s: t3 submits head31 -> fails task-fast (110s..115s = 5s) -> fixes and submits head32 at t=135s ->
    // passes task-fast (135s..145s = 10s) -> enqueues 145s -> dequeues 150s (wait=5s) -> integrates 160s (merge=10s).
    // t3 agent time: (110 - 10) + (135 - 115) = 100 + 20 = 120s.
    // t3 total taskDuration: 160 - 10 = 150s.
    clockSec = 110;
    store.event(a3.runId, 'task_submitted', { attemptId: a3.id, headSha: sha(31), accepted: true }, clockMs());
    store.event(a3.runId, 'task_fast_started', { attemptId: a3.id, headSha: sha(31) }, clockMs());
    clockSec = 115;
    store.event(
      a3.runId,
      'task_fast_finished',
      { attemptId: a3.id, headSha: sha(31), passed: false, code: 'check_failed' },
      clockMs(),
    );
    clockSec = 135;
    store.event(a3.runId, 'task_submitted', { attemptId: a3.id, headSha: sha(32), accepted: true }, clockMs());
    store.event(a3.runId, 'task_fast_started', { attemptId: a3.id, headSha: sha(32) }, clockMs());
    clockSec = 145;
    store.event(a3.runId, 'task_fast_finished', { attemptId: a3.id, headSha: sha(32), passed: true }, clockMs());
    store.updateRun(a3.runId, {
      state: 'succeeded',
      headSha: sha(32),
      checks: { profile: 'task-fast', headSha: sha(32), complete: true, results: [] },
    });
    store.event(a3.runId, 'succeeded', { attemptId: a3.id, headSha: sha(32) }, clockMs());
    const q3 = queue.enqueue({ projectId, taskId: 't3', attemptId: a3.id, runId: a3.runId, baseSha, headSha: sha(32) });
    store.event(a3.runId, 'integration_enqueued', { seq: q3.seq, attemptId: a3.id, headSha: sha(32) }, clockMs());
    clockSec = 150;
    const [c3] = queue.claim(projectId, { maxBatch: 1 });
    store.event(a3.runId, 'integration_dequeued', { seq: c3.seq, attemptId: a3.id, headSha: sha(32) }, clockMs());
    clockSec = 160;
    store.updateRun(a3.runId, {
      integration: {
        branch: `kodo/project/${projectId}`,
        before: sha(101),
        mergeCommit: sha(103),
        mergedHead: sha(32),
        status: 'merged',
        mergedAt: clockIso(),
      },
      externalCompletion: {
        schemaVersion: 1,
        headSha: sha(32),
        integration: { status: 'integrated', mergeCommit: sha(103) },
        gates: null,
        integratedAt: clockIso(),
      },
    });
    queue.finish(c3.seq, c3.claim, { status: 'integrated', dequeuedAt: iso(150), finishedAt: iso(160) });
    store.event(
      a3.runId,
      'integration_finished',
      { seq: c3.seq, attemptId: a3.id, headSha: sha(32), status: 'integrated' },
      clockMs(),
    );
    for (const to of ['verifying', 'integrated']) {
      s = repo.snapshot(projectId);
      await repo.apply(
        cmd(projectId, s.revision, { op: 'transition', kind: 'attempt', id: a3.id, to, evidence: [], mappings: [] }),
      );
      s = repo.snapshot(projectId);
      await repo.apply(
        cmd(projectId, s.revision, { op: 'transition', kind: 'task', id: 't3', to, evidence: [], mappings: [] }),
      );
    }

    // t=150s..180s: t2 attempt #2 submits at 150s (agent=60s), task-fast 150s..160s (10s),
    // enqueues 160s, dequeues 175s (wait=15s), integrates 180s (merge=5s).
    // t2 total taskDuration from first brief (0s) to integration (180s) = 180s!
    clockSec = 150;
    store.event(a2_2.runId, 'task_submitted', { attemptId: a2_2.id, headSha: sha(22), accepted: true }, clockMs());
    store.event(a2_2.runId, 'task_fast_started', { attemptId: a2_2.id, headSha: sha(22) }, clockMs());
    clockSec = 160;
    store.event(a2_2.runId, 'task_fast_finished', { attemptId: a2_2.id, headSha: sha(22), passed: true }, clockMs());
    store.updateRun(a2_2.runId, {
      state: 'succeeded',
      headSha: sha(22),
      checks: { profile: 'task-fast', headSha: sha(22), complete: true, results: [] },
    });
    store.event(a2_2.runId, 'succeeded', { attemptId: a2_2.id, headSha: sha(22) }, clockMs());
    const q2 = queue.enqueue({
      projectId,
      taskId: 't2',
      attemptId: a2_2.id,
      runId: a2_2.runId,
      baseSha,
      headSha: sha(22),
    });
    store.event(a2_2.runId, 'integration_enqueued', { seq: q2.seq, attemptId: a2_2.id, headSha: sha(22) }, clockMs());
    clockSec = 175;
    const [c2] = queue.claim(projectId, { maxBatch: 1 });
    store.event(a2_2.runId, 'integration_dequeued', { seq: c2.seq, attemptId: a2_2.id, headSha: sha(22) }, clockMs());
    clockSec = 180;
    store.updateRun(a2_2.runId, {
      integration: {
        branch: `kodo/project/${projectId}`,
        before: sha(103),
        mergeCommit: sha(102),
        mergedHead: sha(22),
        status: 'merged',
        mergedAt: clockIso(),
      },
      externalCompletion: {
        schemaVersion: 1,
        headSha: sha(22),
        integration: { status: 'integrated', mergeCommit: sha(102) },
        gates: null,
        integratedAt: clockIso(),
      },
    });
    queue.finish(c2.seq, c2.claim, { status: 'integrated', dequeuedAt: iso(175), finishedAt: iso(180) });
    store.event(
      a2_2.runId,
      'integration_finished',
      { seq: c2.seq, attemptId: a2_2.id, headSha: sha(22), status: 'integrated' },
      clockMs(),
    );
    for (const to of ['verifying', 'integrated']) {
      s = repo.snapshot(projectId);
      await repo.apply(
        cmd(projectId, s.revision, { op: 'transition', kind: 'attempt', id: a2_2.id, to, evidence: [], mappings: [] }),
      );
      s = repo.snapshot(projectId);
      await repo.apply(
        cmd(projectId, s.revision, { op: 'transition', kind: 'task', id: 't2', to, evidence: [], mappings: [] }),
      );
    }

    // --- Gates ---
    // Gate 1 (epic e1: t1, t2): passes WITHOUT repair, hits waiting_limits for 40s (200s..240s), has gateArbitration!
    // Accepted at t=300s.
    clockSec = 185;
    s = repo.snapshot(projectId);
    const g1Res = await repo.apply(
      cmd(projectId, s.revision, {
        op: 'reserveGate',
        containers: [{ kind: 'epic', id: 'e1' }],
        baseSha,
        headSha: sha(102),
        merges: [
          { taskId: 't1', attemptId: a1.id, runId: a1.runId, mergeCommit: sha(101) },
          { taskId: 't2', attemptId: a2_2.id, runId: a2_2.runId, mergeCommit: sha(102) },
        ],
        retry: false,
      }),
    );
    const g1 = repo.snapshot(projectId).gates.find(g => g.id === g1Res.entity.id);
    store.createRun({
      id: g1.runId,
      project: root,
      task: 'gate-1',
      client: 'codex',
      state: 'succeeded',
      baseSha,
      headSha: sha(102),
      directorBinding: { kind: 'gate', projectId, gateId: g1.id, runId: g1.runId },
      sessionAttempts: [sessionRow('review', 12_000)],
      coordinatorOperations: [],
      gateArbitration: { decision: 'confirm_pass', model: 'opus' },
      blocker: {
        current: null,
        history: [
          {
            code: 'quota',
            scope: 'run',
            firstSeen: iso(200),
            lastSeen: iso(200),
            endedAt: iso(240),
            outcome: 'resumed',
          },
        ],
      },
    });
    clockSec = 190;
    store.event(g1.runId, 'gate_verify_started', { attempt: 0 }, clockMs());
    clockSec = 200;
    store.event(g1.runId, 'gate_verify_finished', { attempt: 0, passed: true }, clockMs());
    store.event(g1.runId, 'waiting_limits', { code: 'quota' }, clockMs());
    clockSec = 240;
    store.event(g1.runId, 'resumed', { previousState: 'waiting_limits' }, clockMs());
    clockSec = 290;
    store.event(g1.runId, 'gate_succeeded', { headSha: sha(102), smoke: 0 }, clockMs());
    clockSec = 300;
    store.event(g1.runId, 'gate_accepted', { gateId: g1.id, taskIds: ['t1', 't2'] }, clockMs());
    const acceptTask = async (id, gateRunId, head) => {
      const ref = {
        kind: 'acceptance',
        runId: gateRunId,
        headSha: head,
        path: path.join(home, 'evidence', `${id}.json`),
        sha256: 'a'.repeat(64),
      };
      const mapping = {
        criterionId: `${id}-proof`,
        refs: [ref.sha256],
        actor: 'project-director',
        reason: 'gate verified',
      };
      s = repo.snapshot(projectId);
      await repo.apply(
        cmd(projectId, s.revision, {
          op: 'transition',
          kind: 'task',
          id,
          to: 'accepted',
          evidence: [ref],
          mappings: [mapping],
        }),
      );
    };
    for (const id of ['t1', 't2']) await acceptTask(id, g1.runId, sha(102));

    // Gate 2 (epic e2: t3): requires 1 repair round (repair_required + repair session 15s), accepted at t=360s.
    clockSec = 305;
    s = repo.snapshot(projectId);
    const g2Res = await repo.apply(
      cmd(projectId, s.revision, {
        op: 'reserveGate',
        containers: [{ kind: 'epic', id: 'e2' }],
        baseSha: sha(101),
        headSha: sha(103),
        merges: [{ taskId: 't3', attemptId: a3.id, runId: a3.runId, mergeCommit: sha(103) }],
        retry: false,
      }),
    );
    const g2 = repo.snapshot(projectId).gates.find(g => g.id === g2Res.entity.id);
    store.createRun({
      id: g2.runId,
      project: root,
      task: 'gate-2',
      client: 'codex',
      state: 'succeeded',
      baseSha: sha(101),
      headSha: sha(104), // repair moved head
      directorBinding: { kind: 'gate', projectId, gateId: g2.id, runId: g2.runId },
      sessionAttempts: [sessionRow('review', 8000), sessionRow('repair', 15_000), sessionRow('review', 7000)],
      coordinatorOperations: [],
    });
    clockSec = 310;
    store.event(g2.runId, 'gate_verify_started', { attempt: 0 }, clockMs());
    clockSec = 318;
    store.event(g2.runId, 'gate_verify_finished', { attempt: 0, passed: false }, clockMs());
    store.event(g2.runId, 'repair_required', { attempt: 0, problem: 'fix' }, clockMs());
    clockSec = 335;
    store.event(g2.runId, 'gate_verify_started', { attempt: 1 }, clockMs());
    clockSec = 345;
    store.event(g2.runId, 'gate_verify_finished', { attempt: 1, passed: true }, clockMs());
    clockSec = 355;
    store.event(g2.runId, 'gate_succeeded', { headSha: sha(104), smoke: 0 }, clockMs());
    clockSec = 360;
    store.event(g2.runId, 'gate_accepted', { gateId: g2.id, taskIds: ['t3'] }, clockMs());
    await acceptTask('t3', g2.runId, sha(104));

    store.close();

    const jsonRes = await reportCli(['--project', projectId, '--json'], { home, secrets: {} });
    assert.equal(jsonRes.exitCode, 0, jsonRes.output);
    const r = jsonRes.report;

    // 1. throughput:
    // Integrated: 3 tasks over [0s, 180s] = 180_000ms (0.05h) -> 60 tasks/hour!
    // Accepted: 3 tasks over [0s, 360s] = 360_000ms (0.1h) -> 30 tasks/hour!
    assert.deepEqual(r.throughput.integrated, {
      tasksPerHour: 60,
      count: 3,
      windowStart: iso(0),
      windowEnd: iso(180),
      windowMs: 180_000,
      known: 3,
      total: 3,
      complete: true,
    });
    assert.deepEqual(r.throughput.accepted, {
      tasksPerHour: 30,
      count: 3,
      windowStart: iso(0),
      windowEnd: iso(360),
      windowMs: 360_000,
      known: 3,
      total: 3,
      complete: true,
    });

    // 2. taskDuration: t1=45s, t3=150s, t2=180s -> sorted [45_000, 150_000, 180_000] -> p50=150_000, p95=180_000
    assert.deepEqual(r.taskDuration, {
      p50Ms: 150_000,
      p95Ms: 180_000,
      known: 3,
      total: 3,
      complete: true,
    });

    // 3. breakdown:
    // agent: a1=20s, a2_1=50s, a2_2=60s, a3=100s+20s=120s -> total 250_000ms (4/4 known)
    assert.deepEqual(r.breakdown.agent, {
      durationMs: 250_000,
      measuredMs: 250_000,
      known: 4,
      total: 4,
      complete: true,
    });
    // taskFast: a1=10s, a2_1=10s, a3_1=5s, a3_2=10s, a2_2=10s -> total 45_000ms (5/5 known)
    assert.deepEqual(r.breakdown.taskFast, {
      durationMs: 45_000,
      measuredMs: 45_000,
      known: 5,
      total: 5,
      complete: true,
    });
    // integrationQueue wait: [10s, 5s, 15s] -> sum 30_000ms, p50=10_000, p95=15_000
    assert.deepEqual(r.breakdown.integrationQueue.wait, {
      durationMs: 30_000,
      measuredMs: 30_000,
      p50Ms: 10_000,
      p95Ms: 15_000,
      known: 3,
      total: 3,
      complete: true,
    });
    // integrationQueue merge: [5s, 10s, 5s] -> sum 20_000ms, p50=5_000, p95=10_000
    assert.deepEqual(r.breakdown.integrationQueue.merge, {
      durationMs: 20_000,
      measuredMs: 20_000,
      p50Ms: 5000,
      p95Ms: 10_000,
      known: 3,
      total: 3,
      complete: true,
    });
    // gates: verify = 10s + 8s + 10s = 28_000ms (3/3); review = 12s + 8s + 7s = 27_000ms (3/3); repair = 15_000ms (1/1)
    assert.deepEqual(r.breakdown.gates.verify, {
      durationMs: 28_000,
      measuredMs: 28_000,
      known: 3,
      total: 3,
      complete: true,
    });
    assert.deepEqual(r.breakdown.gates.review, {
      durationMs: 27_000,
      measuredMs: 27_000,
      known: 3,
      total: 3,
      complete: true,
    });
    assert.deepEqual(r.breakdown.gates.repair, {
      durationMs: 15_000,
      measuredMs: 15_000,
      known: 1,
      total: 1,
      complete: true,
    });
    // quota: g1 waiting_limits 200s..240s = 40_000ms
    assert.deepEqual(r.breakdown.quota, {
      durationMs: 40_000,
      measuredMs: 40_000,
      known: 1,
      total: 1,
      complete: true,
    });
    // human: a2_1 abandoned/blocked at 60s -> a2_2 reserved at 90s = 30_000ms
    assert.deepEqual(r.breakdown.human, {
      durationMs: 30_000,
      measuredMs: 30_000,
      known: 1,
      total: 1,
      complete: true,
    });

    // 4. firstPassYield:
    // taskFast: t1 passed on 1st try; t2 failed attempt #1; t3 failed 1st submission -> 1/3
    assert.deepEqual(r.firstPassYield.taskFast, {
      passed: 1,
      known: 3,
      total: 3,
      rate: 0.3333,
      complete: true,
    });
    // gate: g1 passed without repair; g2 needed repair -> 1/2 = 0.5
    assert.deepEqual(r.firstPassYield.gate, {
      passed: 1,
      known: 2,
      total: 2,
      rate: 0.5,
      complete: true,
    });

    // 5. arbitrations: g1 has confirm_pass -> count 1
    assert.deepEqual(r.arbitrations, {
      count: 1,
      decisions: { confirm_pass: 1 },
      complete: true,
    });

    // 6. interventions: abandon=1 (a2_1), retryFailed=1 (a2_2), rejections=2 (a2_1 task-fast fail + a3 first task-fast fail)
    assert.deepEqual(r.interventions, {
      abandon: 1,
      retryFailed: 1,
      rejections: 2,
      total: 4,
      complete: true,
    });

    // 7. utilization over [0s, 180s]:
    // Intervals: a1=[0,45] (codex), a2_1=[0,60] (gemini), a3=[10,160] (codex), a2_2=[90,180] (gemini)
    // Overall counts:
    //   [0,10]: 2 (10s)
    //   [10,45]: 3 (35s)
    //   [45,60]: 2 (15s)
    //   [60,90]: 1 (30s)
    //   [90,160]: 2 (70s)
    //   [160,180]: 1 (20s)
    //   Durations: 1->50s, 2->95s, 3->35s. Total 180s, half=90s. cum(1)=50 < 90, cum(2)=145 > 90 => median=2, peak=3!
    assert.deepEqual(r.utilization.overall, {
      median: 2,
      peak: 3,
      capacity: 4,
      windowMs: 180_000,
      known: 4,
      total: 4,
      complete: true,
    });
    assert.deepEqual(r.utilization.subscriptions, [
      {
        id: 'codex-heavy',
        provider: 'codex',
        model: 'gpt-6.2-astra',
        tier: 'heavy',
        slots: 2,
        // [0,10]:1 (10s), [10,45]:2 (35s), [45,160]:1 (115s), [160,180]:0 (20s) -> 0:20, 1:125, 2:35 -> median=1, peak=2
        median: 1,
        peak: 2,
        complete: true,
      },
      {
        id: 'gemini-fast',
        provider: 'antigravity',
        model: 'gemini-4-neon',
        tier: 'fast',
        slots: 2,
        // [0,60]:1 (60s), [60,90]:0 (30s), [90,180]:1 (90s) -> 0:30, 1:150 -> median=1, peak=1
        median: 1,
        peak: 1,
        complete: true,
      },
    ]);
    assert.deepEqual(r.utilization.machines, [
      {
        id: 'local-pc',
        kind: 'local',
        maxWorkers: 4,
        maxHeavyBuilds: 2,
        median: 2,
        peak: 3,
        complete: true,
      },
    ]);

    // Existing fields stay backward-compatible and external wallMs is now measured!
    assert.equal(r.totals.tasks, 3);
    assert.equal(r.totals.accepted, 3);
    assert.equal(r.totals.attempts, 4);
    assert.equal(typeof r.totals.wallMs, 'number');

    // Text report includes all C1 sections
    const textRes = await reportCli(['--project', projectId], { home, secrets: {} });
    assert.equal(textRes.exitCode, 0);
    assert.match(textRes.output, /^Throughput:/m);
    assert.match(textRes.output, /^Task duration:/m);
    assert.match(textRes.output, /^Breakdown:/m);
    assert.match(textRes.output, /^First-pass yield:/m);
    assert.match(textRes.output, /^Arbitrations: 1 \(confirm_pass 1\)/m);
    assert.match(textRes.output, /^Interventions: abandon 1, retry-failed 1, rejections 2/m);
    assert.match(textRes.output, /^Utilization: slots median 2, peak 3\/4/m);
    assert.match(textRes.output, /subscription codex-heavy/);
    assert.match(textRes.output, /machine local-pc/);
  } finally {
    try {
      store.close();
    } catch {
      /* already closed */
    }
  }
});

test('C1 unknown or missing timestamps stay null with complete:false and arbitrations default to 0', () => {
  const snapshot = {
    schemaVersion: 1,
    project: { projectId: 'p-incomplete', status: 'running', paused: false, revision: 2 },
    revision: 2,
    milestones: [{ id: 'm1', status: 'running' }],
    epics: [{ id: 'e1', status: 'running' }],
    tasks: [
      { id: 't1', epicId: 'e1', status: 'integrated' },
      { id: 't2', epicId: 'e1', status: 'running' },
    ],
    currentAttempts: [
      { id: 'att-1', taskId: 't1', number: 1, runId: 'run-1', status: 'integrated' },
      { id: 'att-2', taskId: 't2', number: 1, runId: 'run-2', status: 'running' },
    ],
    riskApprovals: [],
    completeness: {
      milestones: { total: 1, returned: 1, complete: true },
      epics: { total: 1, returned: 1, complete: true },
      tasks: { total: 2, returned: 2, complete: true },
      currentAttempts: { total: 2, returned: 2, complete: true },
      riskApprovals: { total: 0, returned: 0, complete: true },
    },
    gates: [{ id: 'g1', number: 1, runId: 'gate-run-1', containers: [{ kind: 'epic', id: 'e1' }], installed: true }],
  };
  // Pre-16C runs: no brief_issued, no task_submitted, no task_fast_started/finished, no integration timestamps;
  // gate-run-1 is stuck in waiting_limits (open quota wait), no gateArbitration field.
  const runs = {
    'run-1': {
      id: 'run-1',
      state: 'succeeded',
      executor: { kind: 'external', host: 't3' },
      verificationProfile: 'task-fast',
      checks: { profile: 'task-fast', complete: true, results: [] },
      sessionAttempts: [],
      coordinatorOperations: [],
    },
    'run-2': {
      id: 'run-2',
      state: 'executing',
      executor: { kind: 'external', host: 't3' },
      verificationProfile: 'task-fast',
      sessionAttempts: [],
      coordinatorOperations: [],
    },
    'gate-run-1': {
      id: 'gate-run-1',
      state: 'waiting_limits',
      sessionAttempts: [],
      coordinatorOperations: [],
      blocker: {
        current: { code: 'quota', scope: 'run', firstSeen: iso(10), lastSeen: iso(10), occurrences: 1 },
        history: [],
      },
    },
  };
  const events = {
    'run-1': [{ seq: 1, type: 'created', time: at(0), data: {} }],
    'run-2': [{ seq: 1, type: 'created', time: at(5), data: {} }],
    'gate-run-1': [
      { seq: 1, type: 'created', time: at(8), data: {} },
      { seq: 2, type: 'waiting_limits', time: at(10), data: { code: 'quota' } },
    ],
  };
  const report = buildProjectReport(snapshot, runs, events, { now: at(50) });

  assert.equal(report.throughput.integrated.tasksPerHour, null);
  assert.equal(report.throughput.integrated.complete, false);
  assert.equal(report.throughput.accepted.tasksPerHour, null);
  assert.equal(report.throughput.accepted.complete, false);

  assert.equal(report.taskDuration.p50Ms, null);
  assert.equal(report.taskDuration.p95Ms, null);
  assert.equal(report.taskDuration.complete, false);

  assert.equal(report.breakdown.agent.durationMs, null);
  assert.equal(report.breakdown.agent.complete, false);
  assert.equal(report.breakdown.taskFast.durationMs, null);
  assert.equal(report.breakdown.taskFast.complete, false);
  assert.equal(report.breakdown.integrationQueue.wait.durationMs, null);
  assert.equal(report.breakdown.integrationQueue.wait.complete, false);
  assert.equal(report.breakdown.integrationQueue.merge.durationMs, null);
  assert.equal(report.breakdown.integrationQueue.merge.complete, false);
  assert.equal(report.breakdown.quota.durationMs, null);
  assert.equal(report.breakdown.quota.complete, false);

  assert.equal(report.firstPassYield.taskFast.rate, null);
  assert.equal(report.firstPassYield.taskFast.complete, false);
  assert.equal(report.firstPassYield.gate.rate, null);
  assert.equal(report.firstPassYield.gate.complete, false);

  assert.deepEqual(report.arbitrations, { count: 0, decisions: {}, complete: true });

  assert.equal(report.utilization.overall.median, null);
  assert.equal(report.utilization.overall.peak, null);
  assert.equal(report.utilization.overall.complete, false);

  const text = humanProject(report);
  assert.match(text, /Arbitrations: 0/);
  assert.match(text, /Throughput: integrated unknown/);
});

test('C1 pull protocol records brief_issued, task_submitted, task_fast_started/finished, and queue timestamps', async t => {
  const dir = await realpath(await mkdtemp(path.join(os.tmpdir(), 'kodo-c1-pull-')));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const root = path.join(dir, 'repo');
  const home = path.join(dir, 'state');
  await initRepo(root);

  let clockSec = 0;
  const clockMs = () => at(clockSec);
  const clockIso = () => iso(clockSec);

  const store = new Store(home, {}, { clock: clockMs });
  try {
    const engine = new Engine({ store, secrets: {} });
    const repo = await openProjectStore({
      store,
      contracts,
      authorizeTransition: async () => {},
      clock: clockIso,
    });
    const spec = contracts.normalizeProjectSpec(
      {
        schemaVersion: 1,
        id: 'c1-pull',
        root,
        title: 'Pull timestamp test',
        execution: { cadence: 'wave', integration: 'branch' },
        definitionOfDone: [criterion('p-proof')],
        constraints: ['Scope only'],
        businessContext: 'Test',
        architectureRefs: [],
        milestones: [{ id: 'm1', title: 'M1', acceptance: [criterion('m-proof')], releaseRequired: false }],
        epics: [{ id: 'e1', milestoneId: 'm1', title: 'E1', acceptance: [criterion('e-proof')] }],
        tasks: [taskSpec('a', 'e1', ['a.txt'])],
      },
      { knownValues: [] },
    );
    const { projectId } = await repo.apply({
      schemaVersion: 1,
      commandId: randomUUID(),
      projectId: null,
      expectedRevision: null,
      actor: 'test',
      reason: 'create',
      action: { op: 'create', spec },
    });
    repo.setProfile(projectId, PROFILE);

    const ctx = { repo, engine, store, contracts, clock: clockIso };

    clockSec = 10;
    const wave = await nextWave(ctx, { projectId, host: 't3', limit: 1 });
    assert.equal(wave.briefs.length, 1);
    const [brief] = wave.briefs;

    await writeFile(path.join(brief.worktree, 'a.txt'), 'hello\n');
    await git(brief.worktree, ['add', 'a.txt']);
    await git(brief.worktree, ['commit', '-m', 'add a']);
    const head = await git(brief.worktree, ['rev-parse', 'HEAD']);

    clockSec = 40;
    const res = await completeTask(ctx, {
      projectId,
      taskId: 'a',
      head,
      attemptId: brief.attemptId,
      deferGate: true,
      ports: {
        verifyTaskFast: async ({ run: runId }) => {
          clockSec = 55;
          store.updateRun(runId, {
            headSha: head,
            checks: { schemaVersion: 2, profile: 'task-fast', headSha: head, complete: true, results: [] },
          });
          return { passed: true, headSha: head };
        },
        createWaveContext: input => input,
        integrateAndAdvance: async () => {
          clockSec = 70;
          return { status: 'integrated', mergeCommit: sha(999), revision: repo.snapshot(projectId).revision };
        },
        runPendingGates: async () => ({ accepted: [], blocked: [] }),
      },
    });
    assert.equal(res.status, 'integrated', JSON.stringify(res));

    const runEvents = store.events(brief.runId);
    const byType = type => runEvents.filter(e => e.type === type);
    assert.equal(byType('brief_issued').length, 1);
    assert.equal(byType('brief_issued')[0].time, at(10));
    assert.equal(byType('task_submitted').length, 1);
    assert.equal(byType('task_submitted')[0].time, at(40));
    assert.equal(byType('task_fast_started').length, 1);
    assert.equal(byType('task_fast_started')[0].time, at(40));
    assert.equal(byType('task_fast_finished').length, 1);
    assert.equal(byType('task_fast_finished')[0].time, at(55));
    assert.equal(byType('succeeded').length, 1);
    assert.equal(byType('integration_enqueued').length, 1);
    assert.equal(byType('integration_dequeued').length, 1);
    assert.equal(byType('integration_finished').length, 1);
    assert.equal(byType('integration_finished')[0].time, at(70));

    const rows = openIntegrationQueue(store, { clock: clockIso }).list(projectId);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].enqueuedAt, iso(55));
    assert.equal(rows[0].outcome.dequeuedAt, iso(55));
    assert.equal(rows[0].outcome.finishedAt, iso(70));
  } finally {
    store.close();
  }
});

test('C1 preserves backward compatibility of legacy project reports and counts abandon/conflict rejections', () => {
  const legacySnapshot = {
    schemaVersion: 1,
    project: { projectId: 'p-legacy', status: 'running', paused: false, revision: 3 },
    revision: 3,
    milestones: [{ id: 'm1', status: 'running' }],
    epics: [{ id: 'e1', status: 'running' }],
    tasks: [{ id: 't1', epicId: 'e1', status: 'blocked' }],
    currentAttempts: [
      { id: 'a1', taskId: 't1', number: 1, runId: 'r1', status: 'blocked', createdAt: iso(0), updatedAt: iso(15) },
    ],
    riskApprovals: [],
    completeness: {
      milestones: { total: 1, returned: 1, complete: true },
      epics: { total: 1, returned: 1, complete: true },
      tasks: { total: 1, returned: 1, complete: true },
      currentAttempts: { total: 1, returned: 1, complete: true },
      riskApprovals: { total: 0, returned: 0, complete: true },
    },
  };
  const runs = {
    r1: {
      id: 'r1',
      state: 'blocked',
      createdAt: iso(0),
      sessionAttempts: [sessionRow('developer', 5000, 'failed')],
      coordinatorOperations: [],
      blocker: {
        current: { code: 'check_failed', scope: 'run', firstSeen: iso(15), lastSeen: iso(15), occurrences: 1 },
        history: [],
      },
    },
  };
  const events = {
    r1: [
      { seq: 1, type: 'created', time: at(0), data: {} },
      { seq: 2, type: 'blocked', time: at(15), data: { code: 'check_failed' } },
    ],
  };
  const report = buildProjectReport(legacySnapshot, runs, events, { now: at(30) });
  // Legacy fields unchanged:
  assert.equal(report.schemaVersion, 1);
  assert.equal(report.kind, 'project');
  assert.equal(report.gates, undefined);
  assert.equal(report.totals.tasks, 1);
  assert.equal(report.totals.blocked, 1);
  assert.equal(report.totals.attempts, 1);
  assert.equal(report.totals.sessions, 1);
  assert.equal(report.totals.wallMs, 15_000);
  // C1 fields present and honest:
  assert.deepEqual(report.arbitrations, { count: 0, decisions: {}, complete: true });
  assert.deepEqual(report.interventions, { abandon: 0, retryFailed: 0, rejections: 1, total: 1, complete: true });
  assert.equal(report.breakdown.human.durationMs, null);
  assert.equal(report.breakdown.human.complete, false);
  assert.equal(report.breakdown.quota.durationMs, 0);
  assert.equal(report.breakdown.quota.complete, true);
  assert.deepEqual(report.utilization.subscriptions, []);
  assert.deepEqual(report.utilization.machines, []);
});
