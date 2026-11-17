import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { Engine } from '../runtime/engine.mjs';
import { Store } from '../runtime/store.mjs';
import * as A from '../runtime/project-contracts.mjs';
import { openProjectStore } from '../runtime/project-store.mjs';
import {
  assertFullChecks,
  createProjectDirector,
  createProjectTransitionAuthorizer,
} from '../runtime/project-director.mjs';
import { createWaveContext, selectWave } from '../runtime/project-director-waves.mjs';

// Wave execution through the real Engine with fake subscription providers, a real
// temporary Git repository and the production transition authorizer.
const wave = { cadence: 'wave', integration: 'branch' };
const proof = id => ({ id, text: 'The observable wave requirement holds.', evidenceKinds: ['acceptance'] });
const task = (id, overrides = {}) => ({
  id,
  epicId: 'e1',
  title: `Task ${id}`,
  description: `Implement task ${id}.`,
  owner: 'developer',
  dependsOn: [],
  writePaths: [`${id}.txt`],
  acceptance: [proof(`${id}-proof`)],
  interfaceRefs: [],
  priority: 50,
  userValue: 1,
  risk: 1,
  estimatedEffort: 1,
  riskApprovalRequired: false,
  ...overrides,
});
const done = id => ({
  sessionId: `worker-${id}`,
  output: { summary: `${id} done`, checks: ['written'], complete: true },
});
const envKeys = [
  'HOME',
  'USERPROFILE',
  'KODO_HOME',
  'KODO_CREDENTIAL_HOME',
  'KODO_WORKTREE_HOME',
  'GIT_CONFIG_NOSYSTEM',
  'GIT_CONFIG_GLOBAL',
  'GIT_TERMINAL_PROMPT',
];

function git(cwd, ...args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true });
  assert.equal(result.status, 0, `${args.join(' ')}\n${result.stderr}`);
  return result.stdout.trim();
}

/** Fake subscription clients: a planner per task, workers writing the task file, reviews and repairs. */
function providers(fileOf, hooks) {
  const calls = { planner: [], worker: [], repair: [], review: 0, analysis: 0, active: 0, maxActive: 0 };
  const provider = {
    assessTask: async () => {
      throw Object.assign(new Error('Offline assessment'), { code: 'unavailable' });
    },
    analyzeGemini: async () => {
      calls.analysis++;
      return { summary: 'Fixture analysis', model: 'offline-gemini', files: [], limitations: [] };
    },
    discoverProviders: async () => [{ id: 'codex-sol', client: 'codex', model: 'gpt-6.1-sol', available: true }],
    decideJev: async () => ({ model: 'codex-sol', parallel: true, confidence: 0.95, sessionMode: 'fresh' }),
    runSession: async request => {
      if (request.schema?.properties?.tasks) {
        const id = /"taskId":"([a-z][a-z0-9-]*)"/.exec(request.prompt)[1];
        calls.planner.push(id);
        return {
          sessionId: `planner-${id}`,
          output: {
            summary: `Implement ${id}`,
            tasks: [
              {
                id: 'implementation',
                role: 'developer',
                writePaths: [fileOf(id)],
                dependsOn: [],
                description: `Implement task ${id}.`,
                acceptance: [`${id} exists`],
                parallel: true,
              },
            ],
          },
        };
      }
      if (request.schema?.properties?.passed) {
        calls.review++;
        if (hooks.onReview) await hooks.onReview(request, calls);
        return { sessionId: `review-${calls.review}`, output: { passed: true, findings: [] } };
      }
      if (/Repair confirmed failures/.test(request.prompt)) {
        calls.repair.push(request);
        await hooks.onRepair?.(request, calls);
        return done('repair');
      }
      const id = /Implement task ([a-z][a-z0-9-]*)\./.exec(request.prompt)[1];
      calls.worker.push(id);
      calls.active++;
      calls.maxActive = Math.max(calls.maxActive, calls.active);
      try {
        await hooks.onWorker?.(request, id, calls);
        const file = path.join(request.cwd, fileOf(id));
        await mkdir(path.dirname(file), { recursive: true });
        await writeFile(file, `${id} implemented\n`);
      } finally {
        calls.active--;
      }
      request.onEvent?.({ sessionId: `worker-${id}` });
      return done(id);
    },
  };
  const delivery = {
    deliver: async () => assert.fail('A wave task never delivers'),
    releasePackage: async () => assert.fail('A wave task never releases'),
  };
  return {
    calls,
    services: { provider, researcher: async () => ({ items: [], requests: 1, errors: [], cache: [] }), delivery },
  };
}

async function fixture(
  t,
  {
    tasks = [task('alpha'), task('beta'), task('gamma')],
    config = {},
    failTogether = [],
    files = {},
    execution = wave,
    hooks = {},
  } = {},
) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'kodo-wave-director-'));
  const root = path.join(directory, 'repo'),
    home = path.join(directory, 'state'),
    isolated = path.join(directory, 'empty-home'),
    flag = path.join(directory, 'combined-fails.flag');
  await mkdir(root);
  await mkdir(isolated);
  await writeFile(path.join(isolated, 'gitconfig'), '');
  const previous = Object.fromEntries(envKeys.map(key => [key, process.env[key]]));
  Object.assign(process.env, {
    HOME: isolated,
    USERPROFILE: isolated,
    KODO_HOME: home,
    KODO_CREDENTIAL_HOME: path.join(isolated, 'empty-credentials'),
    KODO_WORKTREE_HOME: path.join(directory, 'worktrees'),
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: path.join(isolated, 'gitconfig'),
    GIT_TERMINAL_PROMPT: '0',
  });
  const stores = new Set();
  t.after(async () => {
    for (const store of stores) store.close();
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    assert.equal(path.dirname(directory), path.resolve(os.tmpdir()));
    assert.match(path.basename(directory), /^kodo-wave-director-/);
    await rm(directory, { recursive: true, force: true });
  });
  await writeFile(
    path.join(root, 'kodo.config.json'),
    JSON.stringify({
      schemaVersion: 1,
      client: 'codex',
      executionMode: 'quick',
      maxTasks: 2,
      concurrency: 1,
      researchBudget: 0,
      repairRounds: 1,
      commands: { test: [{ command: process.execPath, args: ['check.mjs'] }], build: [], deploy: [], smoke: [] },
      delivery: { enabled: false, release: false },
      uiVerification: { enabled: false },
      security: { enabled: false },
      architecture: { enabled: false },
      ...config,
    }),
  );
  // Each task passes alone; the combined result fails while the flag exists.
  await writeFile(
    path.join(root, 'check.mjs'),
    `import { existsSync } from 'node:fs';\nconst together = ${JSON.stringify(failTogether)};\n` +
      `if (together.length && together.every(name => existsSync(name)) && existsSync(${JSON.stringify(flag)})) {\n` +
      `  console.error('combined behaviour fails');\n  process.exit(1);\n}\n`,
  );
  await writeFile(path.join(root, '.gitattributes'), '* text=auto eol=lf\n');
  git(root, 'init', '-b', 'main');
  git(root, 'config', 'user.name', 'Kodo Wave Test');
  git(root, 'config', 'user.email', 'kodo-wave@example.invalid');
  git(root, 'config', 'core.autocrlf', 'false');
  git(root, 'config', 'commit.gpgSign', 'false');
  git(root, 'add', '.');
  git(root, 'commit', '-m', 'Wave fixture baseline');
  const store = new Store(home, {});
  stores.add(store);
  const fileOf = id => files[id] ?? `${id}.txt`;
  const { calls, services } = providers(fileOf, hooks);
  const engine = new Engine({ store, secrets: {}, leaseHeartbeatMs: 50, ...services });
  const repo = await openProjectStore({
    store,
    contracts: A,
    authorizeTransition: createProjectTransitionAuthorizer({ store, engine, contracts: A }),
  });
  const epicIds = [...new Set(tasks.map(row => row.epicId))];
  const spec = {
    schemaVersion: 1,
    id: 'wave',
    root,
    title: 'Wave fixture',
    definitionOfDone: [proof('project-proof')],
    constraints: ['Only the assigned paths.'],
    businessContext: 'Offline wave fixture.',
    architectureRefs: [],
    milestones: [{ id: 'm1', title: 'Milestone', acceptance: [proof('m1-proof')], releaseRequired: false }],
    epics: epicIds.map(id => ({ id, milestoneId: 'm1', title: `Epic ${id}`, acceptance: [proof(`${id}-proof`)] })),
    tasks,
    ...(execution ? { execution } : {}),
  };
  const command = (snapshot, action) => ({
    schemaVersion: 1,
    commandId: randomUUID(),
    projectId: snapshot?.project.projectId ?? null,
    expectedRevision: snapshot?.revision ?? null,
    actor: 'wave-test',
    reason: 'Observe the wave requirement',
    action,
  });
  const id = (await repo.apply(command(null, { op: 'create', spec }))).projectId;
  const director = createProjectDirector({ repo, engine });
  const user = () => ({
    head: git(root, 'rev-parse', 'HEAD'),
    branch: git(root, 'branch', '--show-current'),
    status: git(root, 'status', '--porcelain=v1'),
  });
  const merges = () =>
    git(root, 'log', '--first-parent', '--merges', '--format=%s', `refs/heads/kodo/project/${id}`)
      .split('\n')
      .filter(Boolean);
  const runs = () => store.listRuns(root);
  return { directory, root, home, flag, store, engine, repo, id, director, calls, command, user, merges, runs };
}

const statuses = rows => Object.fromEntries(rows.map(row => [row.id ?? row.taskId, row.status]));

test(
  'Three disjoint tasks run in parallel, integrate into the project branch and one gate accepts the chain',
  { timeout: 300000 },
  async t => {
    const f = await fixture(t, {
      hooks: {
        // Each worker waits until all three are inside a session: proves overlapping execution.
        onWorker: async (_request, _id, calls) => {
          for (let i = 0; i < 400 && calls.active < 3; i++) await delay(25);
        },
      },
    });
    const before = f.user();
    const result = await f.director.drain(f.id, { concurrency: 3 });
    assert.equal(result.status, 'accepted', JSON.stringify(result));
    assert.equal(result.waves, 1);
    assert.deepEqual([...result.integrated].sort(), ['alpha', 'beta', 'gamma']);
    assert.equal(f.calls.maxActive, 3, 'three task sessions overlapped in time');
    assert.equal(f.calls.analysis, 0, 'quick mode: no Gemini analysis');
    assert.equal(f.calls.review, 1, 'one independent review: the gate');
    const snapshot = f.repo.snapshot(f.id);
    assert.equal(snapshot.project.status, 'accepted');
    assert.deepEqual(statuses(snapshot.milestones), { m1: 'accepted' });
    assert.deepEqual(statuses(snapshot.epics), { e1: 'accepted' });
    assert.deepEqual(statuses(snapshot.tasks), { alpha: 'accepted', beta: 'accepted', gamma: 'accepted' });
    assert.ok(snapshot.currentAttempts.every(row => row.status === 'accepted'));
    assert.equal(snapshot.gates.length, 1);
    assert.deepEqual(snapshot.gates[0].containers, [
      { kind: 'epic', id: 'e1' },
      { kind: 'milestone', id: 'm1' },
      { kind: 'project', id: f.id },
    ]);
    assert.deepEqual(result.gates, [
      { gateId: snapshot.gates[0].id, runId: snapshot.gates[0].runId, state: 'succeeded' },
    ]);
    // Task runs: task-fast, quick, no delivery, the wave watchdog and the drain concurrency.
    const taskRuns = f.runs().filter(run => run.directorBinding?.kind !== 'gate');
    assert.equal(taskRuns.length, 3);
    for (const run of taskRuns) {
      assert.equal(run.verificationProfile, 'task-fast');
      assert.equal(run.checks.profile, 'task-fast');
      assert.equal(run.executionMode.selected, 'quick');
      assert.equal(run.config.delivery.enabled, false);
      assert.deepEqual(run.config.watchdog, { stalledRounds: 2, rejectUnchanged: true });
      assert.equal(run.config.concurrency, 3);
      assert.equal(run.integration.status, 'merged');
      assert.equal(run.integration.branch, `kodo/project/${f.id}`);
    }
    assert.deepEqual(f.merges().sort(), ['Kodo: integrate alpha', 'Kodo: integrate beta', 'Kodo: integrate gamma']);
    for (const name of ['alpha', 'beta', 'gamma'])
      assert.equal(git(f.root, 'show', `refs/heads/kodo/project/${f.id}:${name}.txt`), `${name} implemented`);
    assert.deepEqual(f.user(), before, "the user's HEAD, branch and working tree are untouched");
    const again = await f.director.drain(f.id);
    assert.equal(again.status, 'accepted');
    assert.equal(again.waves, 0);
  },
);

test('Tasks with overlapping write paths never share a wave', { timeout: 300000 }, async t => {
  const f = await fixture(t, {
    tasks: [
      task('wide', { writePaths: ['notes/**'] }),
      task('narrow', { writePaths: ['notes/narrow.txt'] }),
      task('other', { writePaths: ['other.txt'] }),
    ],
    files: { wide: 'notes/wide.txt', narrow: 'notes/narrow.txt' },
  });
  const snapshot = f.repo.snapshot(f.id);
  assert.deepEqual(selectWave(snapshot, { limit: 3 }), ['narrow', 'other']);
  assert.deepEqual(selectWave(snapshot, { limit: 3, inFlight: ['narrow'] }), ['other']);
  assert.deepEqual(selectWave(snapshot, { limit: 1 }), ['narrow']);
  assert.throws(() => selectWave(snapshot, { limit: 0 }), { code: 'project_limit_invalid' });
  const result = await f.director.drain(f.id, { concurrency: 3 });
  assert.equal(result.status, 'accepted', JSON.stringify(result));
  assert.equal(result.waves, 2);
  const runs = f.runs().filter(run => run.directorBinding?.kind !== 'gate');
  const wide = runs.find(run => run.directorBinding.taskId === 'wide'),
    narrow = runs.find(run => run.directorBinding.taskId === 'narrow');
  // The second wave starts from the integration head that already contains the first merge.
  const ancestor = spawnSync('git', ['merge-base', '--is-ancestor', narrow.integration.mergeCommit, wide.baseSha], {
    cwd: f.root,
  });
  assert.equal(ancestor.status, 0);
});

test(
  'The watchdog stops a gate on its second round without progress; --retry-failed creates a new gate',
  { timeout: 300000 },
  async t => {
    let round = 0;
    const f = await fixture(t, {
      tasks: [task('alpha'), task('beta')],
      config: { executionMode: 'deep', repairRounds: 5 },
      failTogether: ['alpha.txt', 'beta.txt'],
      hooks: {
        onRepair: async request => writeFile(path.join(request.cwd, 'alpha.txt'), `repair ${++round}\n`),
      },
    });
    await writeFile(f.flag, 'fail\n');
    const blocked = await f.director.drain(f.id, { concurrency: 2 });
    assert.equal(blocked.status, 'blocked', JSON.stringify(blocked));
    assert.equal(blocked.code, 'no_verified_progress');
    assert.equal(f.calls.repair.length, 2, 'the watchdog stopped on the second round without progress');
    let snapshot = f.repo.snapshot(f.id);
    assert.deepEqual(statuses(snapshot.tasks), { alpha: 'integrated', beta: 'integrated' });
    assert.equal(snapshot.epics[0].status, 'integrated');
    assert.equal(snapshot.gates.length, 1);
    assert.equal(f.store.getRun(snapshot.gates[0].runId).state, 'blocked');
    await rm(f.flag);
    const still = await f.director.drain(f.id);
    assert.equal(still.status, 'blocked', 'a failed gate is retried only explicitly');
    assert.equal(f.repo.snapshot(f.id).gates.length, 1);
    const accepted = await f.director.drain(f.id, { retryFailed: true });
    assert.equal(accepted.status, 'accepted', JSON.stringify(accepted));
    snapshot = f.repo.snapshot(f.id);
    assert.deepEqual(
      snapshot.gates.map(gate => gate.number),
      [1, 2],
    );
    assert.equal(f.store.getRun(snapshot.gates[1].runId).state, 'succeeded');
    assert.equal(snapshot.project.status, 'accepted');
  },
);

test('A quota stop returns waiting_limits and the next drain resumes the same Run', { timeout: 300000 }, async t => {
  let quota = true;
  const f = await fixture(t, {
    tasks: [task('alpha')],
    hooks: {
      onWorker: async () => {
        if (!quota) return;
        quota = false;
        throw Object.assign(new Error('fixture quota'), { code: 'quota' });
      },
    },
  });
  const waiting = await f.director.drain(f.id);
  assert.equal(waiting.status, 'waiting_limits', JSON.stringify(waiting));
  assert.deepEqual(
    waiting.blockers.map(row => [row.code, row.id]),
    [['quota', 'alpha']],
  );
  const [run] = f.runs();
  assert.equal(run.state, 'waiting_limits');
  assert.equal(f.repo.snapshot(f.id).currentAttempts[0].status, 'reserved');
  const accepted = await f.director.drain(f.id);
  assert.equal(accepted.status, 'accepted', JSON.stringify(accepted));
  const snapshot = f.repo.snapshot(f.id);
  assert.equal(snapshot.currentAttempts[0].runId, run.id, 'the same reservation and Run continue');
  assert.equal(snapshot.currentAttempts[0].number, 1);
  assert.equal(f.runs().filter(row => row.directorBinding?.kind !== 'gate').length, 1);
});

test('A missing risk approval blocks the drain before any reservation', async t => {
  const f = await fixture(t, {
    tasks: [task('alpha', { riskApprovalRequired: true }), task('beta', { dependsOn: ['alpha'] })],
  });
  const result = await f.director.drain(f.id);
  assert.equal(result.status, 'blocked');
  assert.equal(result.code, 'risk_approval_required');
  assert.equal(result.waves, 0);
  assert.equal(f.repo.snapshot(f.id).currentAttempts.length, 0);
  assert.equal(f.runs().length, 0);
  await f.director.approveRisk(f.id, 'alpha', { reason: 'Reviewed fixture risk' });
  assert.deepEqual(selectWave(f.repo.snapshot(f.id), { limit: 3 }), ['alpha']);
});

test('resume of a wave project executes exactly one task', { timeout: 300000 }, async t => {
  const f = await fixture(t, { tasks: [task('alpha'), task('beta')] });
  const first = await f.director.resume(f.id);
  assert.equal(first.status, 'succeeded', JSON.stringify(first));
  assert.equal(first.drainStatus, 'max_waves');
  assert.equal(first.integrated.length, 1);
  let snapshot = f.repo.snapshot(f.id);
  assert.equal(snapshot.currentAttempts.length, 1);
  assert.equal(f.runs().length, 1);
  assert.equal(f.calls.worker.length, 1);
  const second = await f.director.resume(f.id);
  assert.equal(second.status, 'succeeded', JSON.stringify(second));
  assert.equal(second.drainStatus, 'accepted');
  snapshot = f.repo.snapshot(f.id);
  assert.equal(snapshot.currentAttempts.length, 2);
  assert.equal(snapshot.project.status, 'accepted');
});

test('appendMilestone reopens an accepted project and drain accepts it again', { timeout: 300000 }, async t => {
  const f = await fixture(t, { tasks: [task('alpha')] });
  assert.equal((await f.director.drain(f.id)).status, 'accepted');
  const reopened = await f.repo.apply(
    f.command(f.repo.snapshot(f.id), {
      op: 'appendMilestone',
      milestone: { id: 'm2', title: 'Second', acceptance: [proof('m2-proof')], releaseRequired: false },
      epics: [{ id: 'e2', milestoneId: 'm2', title: 'Second epic', acceptance: [proof('e2-proof')] }],
      tasks: [task('delta', { epicId: 'e2', dependsOn: ['alpha'] })],
    }),
  );
  assert.equal(f.repo.snapshot(f.id).project.status, 'running', JSON.stringify(reopened));
  const result = await f.director.drain(f.id);
  assert.equal(result.status, 'accepted', JSON.stringify(result));
  const snapshot = f.repo.snapshot(f.id);
  assert.equal(snapshot.project.reopened.length, 1);
  assert.deepEqual(statuses(snapshot.tasks), { alpha: 'accepted', delta: 'accepted' });
  assert.deepEqual(
    snapshot.gates.map(gate => gate.containers.map(row => row.kind)),
    [
      ['epic', 'milestone', 'project'],
      ['epic', 'milestone', 'project'],
    ],
  );
  assert.deepEqual(
    snapshot.gates[1].merges.map(row => row.taskId),
    ['alpha', 'delta'],
  );
  const delta = f.runs().find(run => run.directorBinding?.taskId === 'delta');
  assert.equal(
    spawnSync('git', ['merge-base', '--is-ancestor', snapshot.gates[0].headSha, delta.baseSha], { cwd: f.root }).status,
    0,
    'the new task starts from the accepted integration head',
  );
});

test('cancel during a gate cancels its Run and the drain', { timeout: 300000 }, async t => {
  let director;
  const f = await fixture(t, {
    tasks: [task('alpha')],
    hooks: {
      onReview: async () => {
        assert.deepEqual(await director.cancel(f.id), { status: 'cancelled' });
      },
    },
  });
  director = f.director;
  const result = await f.director.drain(f.id);
  assert.equal(result.status, 'cancelled', JSON.stringify(result));
  const snapshot = f.repo.snapshot(f.id);
  assert.equal(snapshot.project.status, 'cancelled');
  const gate = f.store.getRun(snapshot.gates[0].runId);
  assert.equal(gate.cancelRequested, true);
  assert.equal(gate.state, 'cancelled');
  assert.equal(snapshot.tasks[0].status, 'integrated', 'no acceptance without a finished gate');
});

test('A repeated drain after a crash mid-wave never duplicates merges', { timeout: 300000 }, async t => {
  const f = await fixture(t, { tasks: [task('alpha'), task('beta')] });
  const updateRun = f.store.updateRun.bind(f.store);
  let crashed = false;
  f.store.updateRun = (id, patch, options) => {
    if (!crashed && patch.integration?.status === 'merged') {
      crashed = true;
      throw Object.assign(new Error('Owned crash after the merge commit'), { code: 'fixture_crash' });
    }
    return updateRun(id, patch, options);
  };
  await assert.rejects(f.director.drain(f.id, { concurrency: 2 }), /Owned crash after the merge commit/);
  f.store.updateRun = updateRun;
  const pending = f.runs().filter(run => run.integration?.status === 'pending');
  assert.equal(pending.length, 1, 'the merge happened, its record did not');
  assert.equal(f.merges().length >= 1, true);
  const result = await f.director.drain(f.id, { concurrency: 2 });
  assert.equal(result.status, 'accepted', JSON.stringify(result));
  assert.deepEqual(f.merges().sort(), ['Kodo: integrate alpha', 'Kodo: integrate beta']);
  assert.equal(f.runs().filter(run => run.directorBinding?.kind !== 'gate').length, 2, 'no new Run');
  assert.equal(f.calls.worker.length, 2, 'no task executed twice');
});

test('drain refuses a legacy project and invalid bounds', async t => {
  const f = await fixture(t, { tasks: [task('alpha')], execution: null });
  await assert.rejects(f.director.drain(f.id), { code: 'project_wave_not_enabled' });
  const ctx = createWaveContext({ repo: f.repo, engine: f.engine });
  assert.equal(ctx.store, f.store);
  for (const options of [{ maxWaves: 0 }, { maxWaves: 101 }, { concurrency: 6 }, { concurrency: 1.5 }])
    await assert.rejects(f.director.drain(f.id, options), { code: 'project_drain_invalid' });
});

test('The legacy full-checks validator rejects a profiled receipt even with a matching fingerprint', async () => {
  const headSha = 'a'.repeat(40),
    command = { command: process.execPath, args: ['check.mjs'] };
  const run = { headSha, config: { commands: { test: [command], build: [], deploy: [], smoke: [] } } };
  const fingerprint = createHash('sha256')
    .update(
      JSON.stringify({
        headSha,
        expected: [{ kind: 'test', command }],
        runtime: {
          node: process.version,
          abi: process.versions.modules,
          platform: process.platform,
          arch: process.arch,
        },
      }),
    )
    .digest('hex');
  run.checks = {
    schemaVersion: 2,
    profile: 'task-fast',
    complete: true,
    headSha,
    fingerprint,
    results: [{ exitCode: 0, kind: 'test', command, outputPath: 'missing', outputHash: 'b'.repeat(64) }],
  };
  const engine = {
    assertEvidence: async () => {
      throw Object.assign(new Error('Evidence reached'), { code: 'evidence_integrity' });
    },
  };
  await assert.rejects(assertFullChecks(engine, run), { code: 'project_checks_stale' });
  delete run.checks.profile;
  // Without the profile the same receipt reaches its evidence: the profile alone rejected it.
  await assert.rejects(assertFullChecks(engine, run), { code: 'evidence_integrity' });
});
