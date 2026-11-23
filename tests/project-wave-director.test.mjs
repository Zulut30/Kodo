import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { Engine } from '../runtime/engine.mjs';
import { Store } from '../runtime/store.mjs';
import * as A from '../runtime/project-contracts.mjs';
import { openProjectStore } from '../runtime/project-store.mjs';
import { createProjectDirector, createProjectTransitionAuthorizer } from '../runtime/project-director.mjs';
import { createWaveContext, selectWave } from '../runtime/project-director-waves.mjs';
import { nextWave } from '../runtime/project-external.mjs';
import { withIntegrationLease } from '../runtime/project-integration-lease.mjs';
import { evaluateWaveTransition } from '../runtime/project-wave-evidence.mjs';
import { confirmedCriteria } from './helpers/gate-review.mjs';

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
        return {
          sessionId: `review-${calls.review}`,
          output: { passed: true, findings: [], ...confirmedCriteria(request.schema) },
        };
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
    wrapRepo = repo => repo,
    evaluator,
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
    authorizeTransition: createProjectTransitionAuthorizer({ store, engine, contracts: A, evaluator }),
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
  const director = createProjectDirector({ repo: wrapRepo(repo), engine });
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
  const branch = `refs/heads/kodo/project/${id}`;
  const branchHead = () => git(root, 'rev-parse', branch);
  // The private integration worktree of the project branch (another writer commits there).
  const integrationWorktree = () =>
    git(root, 'worktree', 'list', '--porcelain')
      .split(/\r?\n\r?\n/)
      .find(block => block.includes(`branch ${branch}`))
      .split(/\r?\n/)[0]
      .slice('worktree '.length);
  const commitOnBranch = async (name, text) => {
    const worktree = integrationWorktree();
    await writeFile(path.join(worktree, name), text);
    git(worktree, 'add', '-A');
    git(worktree, 'commit', '-m', `Another writer adds ${name}`);
    return git(worktree, 'rev-parse', 'HEAD');
  };
  return {
    directory,
    root,
    home,
    flag,
    store,
    engine,
    repo,
    id,
    director,
    calls,
    command,
    user,
    merges,
    runs,
    branchHead,
    integrationWorktree,
    commitOnBranch,
  };
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
    // Audit finding 8a: a gate blocker names its gate and gate Run, the place of its findings.
    const named = { gateId: snapshot.gates[0].id, runId: snapshot.gates[0].runId };
    const gateRows = result =>
      result.blockers.filter(row => row.kind === 'epic').map(({ gateId, runId }) => ({ gateId, runId }));
    assert.deepEqual(gateRows(blocked), [named]);
    // Audit finding 4a: the pull protocol names the stopped gate instead of an empty wave.
    const ctx = { repo: f.repo, engine: f.engine, store: f.store, contracts: A };
    const waiting = await nextWave(ctx, { projectId: f.id, host: 't3' });
    assert.deepEqual(waiting.briefs, []);
    assert.deepEqual(waiting.blocked, [
      { code: 'no_verified_progress', kind: 'epic', id: 'e1', ...named, state: 'blocked' },
    ]);
    await rm(f.flag);
    const still = await f.director.drain(f.id);
    assert.equal(still.status, 'blocked', 'a failed gate is retried only explicitly');
    assert.deepEqual(gateRows(still), [named]);
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

test(
  'A write outside writePaths blocks the wave task with scope_conflict without a repair round',
  { timeout: 300000 },
  async t => {
    const f = await fixture(t, {
      tasks: [task('alpha'), task('beta')],
      config: { executionMode: 'deep', repairRounds: 5 },
      hooks: {
        onWorker: async (request, id) => {
          if (id === 'alpha') await writeFile(path.join(request.cwd, 'stray.txt'), 'outside the task\n');
        },
      },
    });
    const result = await f.director.drain(f.id, { concurrency: 2 });
    assert.equal(result.status, 'blocked', JSON.stringify(result));
    assert.deepEqual(
      result.blockers.map(row => [row.kind, row.id, row.code]),
      [['task', 'alpha', 'scope_conflict']],
    );
    assert.deepEqual(
      f.calls.worker.filter(id => id === 'alpha'),
      ['alpha'],
      'the scope violation spends no repair session',
    );
    const run = f.runs().find(row => row.directorBinding?.taskId === 'alpha');
    assert.equal(run.state, 'blocked');
    assert.equal(run.blocker.current.code, 'scope_conflict');
    assert.equal(run.nodes.implementation.attempt, 1);
    const snapshot = f.repo.snapshot(f.id);
    assert.equal(snapshot.tasks.find(row => row.id === 'beta').status, 'integrated');
    assert.equal(
      spawnSync('git', ['cat-file', '-e', `${f.branchHead()}:stray.txt`], { cwd: f.root }).status !== 0,
      true,
      'the stray file never reaches the integration branch',
    );
  },
);

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

test(
  'integrated is authorized only under the integration lease, by a merge still on the branch with its recorded parents',
  { timeout: 300000 },
  async t => {
    // Review finding F1-2a: a stored merge receipt was enough after the branch had moved; the
    // Git checks ran outside the lease and the first parent was never compared.
    let captured = null;
    const f = await fixture(t, {
      tasks: [task('alpha')],
      wrapRepo: repo => ({
        ...repo,
        apply: async command => {
          const action = command.action;
          if (!captured && action.op === 'transition' && action.kind === 'attempt' && action.to === 'integrated') {
            captured = command;
            throw Object.assign(new Error('Owned stop before the integrated transition'), { code: 'fixture_stop' });
          }
          return repo.apply(command);
        },
      }),
    });
    const stopped = await f.director.drain(f.id);
    assert.equal(stopped.status, 'blocked', JSON.stringify(stopped));
    const run = f.store.getRun(captured.action.evidence[0].runId);
    const integration = run.integration;
    assert.equal(integration.status, 'merged');
    const again = () => ({ ...captured, commandId: randomUUID(), expectedRevision: f.repo.snapshot(f.id).revision });
    const leased = work => withIntegrationLease(f.store, f.id, work);
    // Outside the lease a merge or merge-back may move the branch before the commit.
    await assert.rejects(f.repo.apply(again()), { code: 'project_integration_lease_required' });
    // A receipt whose `before` is not the merge's first parent proves nothing.
    f.store.updateRun(run.id, { integration: { ...integration, before: run.headSha } });
    await assert.rejects(
      leased(() => f.repo.apply(again())),
      { code: 'project_transition_blocked' },
      'first parent',
    );
    f.store.updateRun(run.id, { integration });
    // After the merge is rolled back the saved receipt proves nothing either.
    const worktree = f.integrationWorktree();
    git(worktree, 'reset', '--hard', integration.before);
    await assert.rejects(
      leased(() => f.repo.apply(again())),
      { code: 'project_transition_blocked' },
      'rollback',
    );
    git(worktree, 'reset', '--hard', integration.mergeCommit);
    // Under the lease, with the merge on the branch, the transition commits.
    await leased(() => f.repo.apply(again()));
    assert.equal(f.repo.snapshot(f.id).currentAttempts[0].status, 'integrated');
    const result = await f.director.drain(f.id);
    assert.equal(result.status, 'accepted', JSON.stringify(result));
  },
);

test(
  'The project is accepted only on a head still current after every check; a moved branch gets a project gate',
  { timeout: 300000 },
  async t => {
    // Review finding F1-2c: the integration head was read before the asynchronous proof, so a
    // branch moved during the check let the project be accepted on a stale head.
    let moved = null,
      f;
    f = await fixture(t, {
      tasks: [task('alpha')],
      evaluator: {
        evaluateWaveTransition: async (input, ports) => {
          const result = await evaluateWaveTransition(input, ports);
          const action = input.command.action;
          if (!moved && action.kind === 'project' && action.to === 'accepted')
            moved = await f.commitOnBranch('late.txt', 'late writer\n');
          return result;
        },
      },
    });
    const result = await f.director.drain(f.id);
    assert.equal(result.status, 'accepted', JSON.stringify(result));
    assert.ok(moved, 'the branch moved while the project proof was checked');
    const snapshot = f.repo.snapshot(f.id);
    assert.deepEqual(
      snapshot.gates.map(gate => gate.containers.map(row => row.kind)),
      [['epic', 'milestone', 'project'], ['project']],
    );
    const projectGate = snapshot.gates[1];
    assert.equal(projectGate.headSha, moved, 'the project gate verified the moved head');
    assert.equal(f.store.getRun(projectGate.runId).headSha, f.branchHead());
    assert.equal(git(f.root, 'show', `${f.branchHead()}:late.txt`), 'late writer');
  },
);

test(
  'When the branch moves after an epic gate covering the project, drain reserves a project gate on the current head',
  { timeout: 300000 },
  async t => {
    // F2 open question: the project stayed `integrated` with wave_project_head_mismatch.
    let moved = null,
      f;
    f = await fixture(t, {
      tasks: [task('alpha'), task('beta')],
      hooks: {
        onReview: async () => {
          if (!moved) moved = await f.commitOnBranch('late.txt', 'late writer\n');
        },
      },
    });
    const result = await f.director.drain(f.id, { concurrency: 2 });
    assert.equal(result.status, 'accepted', JSON.stringify(result));
    const snapshot = f.repo.snapshot(f.id);
    assert.equal(snapshot.project.status, 'accepted');
    assert.deepEqual(statuses(snapshot.tasks), { alpha: 'accepted', beta: 'accepted' });
    const [epicGate, projectGate] = snapshot.gates;
    assert.deepEqual(
      epicGate.containers.map(row => row.kind),
      ['epic', 'milestone', 'project'],
    );
    assert.notEqual(f.store.getRun(epicGate.runId).headSha, moved, 'the epic gate verified the earlier head');
    assert.deepEqual(projectGate.containers, [{ kind: 'project', id: f.id }]);
    assert.equal(projectGate.headSha, moved);
    assert.equal(projectGate.baseSha, epicGate.baseSha, 'the project gate reviews the whole project range');
    assert.equal(projectGate.merges.length, 2);
    assert.equal(f.calls.review, 2, 'the epic gate and the project gate');
  },
);

test(
  'A gate whose install is refused names its reserved Run, the install stage and the diagnosis',
  { timeout: 300000 },
  async t => {
    // Review finding (minor): gate_invalid carried no runId, stage or diagnosis, although the
    // reservation already names its Run.
    const refusal = 'Некорректный гейт эпика: owned install refusal';
    const f = await fixture(t, {
      tasks: [task('alpha')],
      wrapRepo: repo => ({
        ...repo,
        installGateRun: async () => {
          throw Object.assign(new Error(refusal), { code: 'gate_invalid' });
        },
      }),
    });
    await assert.rejects(f.director.drain(f.id), { code: 'gate_invalid' });
    const [gate] = f.repo.snapshot(f.id).gates;
    assert.equal(gate.installed, false);
    assert.equal(typeof gate.runId, 'string');
    const result = await f.director.drain(f.id);
    assert.equal(result.status, 'blocked', JSON.stringify(result));
    assert.deepEqual(
      result.blockers.filter(row => row.kind === 'epic'),
      [
        {
          code: 'gate_invalid',
          kind: 'epic',
          id: 'e1',
          gateId: gate.id,
          runId: gate.runId,
          stage: 'install',
          message: refusal,
        },
      ],
    );
  },
);

test(
  'drain replaces a gate reservation whose install was interrupted and whose head went stale',
  { timeout: 300000 },
  async t => {
    // Review finding F1-3a: the stale reservation stayed blocked with gate_head_stale.
    let crash = true;
    const f = await fixture(t, {
      tasks: [task('alpha')],
      wrapRepo: repo => ({
        ...repo,
        installGateRun: async input => {
          if (crash) {
            crash = false;
            throw Object.assign(new Error('Owned crash before the gate install'), { code: 'fixture_crash' });
          }
          return repo.installGateRun(input);
        },
      }),
    });
    await assert.rejects(f.director.drain(f.id), /Owned crash before the gate install/);
    assert.deepEqual(
      f.repo.snapshot(f.id).gates.map(gate => gate.installed),
      [false],
    );
    const moved = await f.commitOnBranch('late.txt', 'late writer\n');
    const result = await f.director.drain(f.id);
    assert.equal(result.status, 'accepted', JSON.stringify(result));
    const gates = f.repo.snapshot(f.id).gates;
    assert.deepEqual(
      gates.map(gate => [gate.number, gate.installed, gate.supersededBy ?? null]),
      [
        [1, false, gates[1].id],
        [2, true, null],
      ],
    );
    assert.equal(gates[1].headSha, moved);
  },
);
