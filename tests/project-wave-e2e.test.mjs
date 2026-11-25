import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { Engine } from '../runtime/engine.mjs';
import { buildProjectReport } from '../runtime/telemetry.mjs';
import { Store } from '../runtime/store.mjs';
import * as A from '../runtime/project-contracts.mjs';
import { openProjectStore } from '../runtime/project-store.mjs';
import { createProjectDirector, createProjectTransitionAuthorizer } from '../runtime/project-director.mjs';
import { NATIVE_RESERVER, externalReserver } from '../runtime/project-director-waves.mjs';
import { projectCli } from '../runtime/project-cli.mjs';
import { withIntegrationLease } from '../runtime/project-integration-lease.mjs';
import { TEST_COUNT_VERSION } from '../runtime/task-fast-checks.mjs';
import { confirmedCriteria } from './helpers/gate-review.mjs';

// End to end without fake ports: the real Store, project store, production
// authorizer, Engine (fake subscription providers only), wave director, pull
// protocol and CLI over a temporary Git repository.
// Every case of this file has one limit, { timeout: 900000 } (stage 16E). On slow Windows CI runners
// "drain accepts two epics…" took 497 s of the former 600 s limit (run 45605431480) and 428 s (run
// 45652087454). See docs/CI.md.
const wave = { cadence: 'wave', integration: 'branch' };
const proof = id => ({ id, text: 'The observable wave requirement holds.', evidenceKinds: ['acceptance'] });
const task = (id, overrides = {}) => ({
  id,
  epicId: 'e1',
  title: `Task ${id}`,
  description: `Create ${id}.txt.`,
  owner: 'developer',
  dependsOn: [],
  writePaths: [`${id}.txt`],
  acceptance: [proof(`${id}-proof`)],
  interfaceRefs: [],
  priority: 50,
  userValue: 3,
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

/** Fake subscription clients: a planner per task, workers writing `<id>.txt`, reviews and repairs. */
function providers(hooks) {
  const calls = { worker: [], repair: [], review: 0, reviews: [], active: 0, maxActive: 0 };
  const provider = {
    assessTask: async () => {
      throw Object.assign(new Error('Offline assessment'), { code: 'unavailable' });
    },
    analyzeGemini: async () => ({ summary: 'Fixture analysis', model: 'offline-gemini', files: [], limitations: [] }),
    discoverProviders: async () => [{ id: 'codex-sol', client: 'codex', model: 'gpt-6.1-sol', available: true }],
    decideJev: async () => ({ model: 'codex-sol', parallel: true, confidence: 0.95, sessionMode: 'fresh' }),
    runSession: async request => {
      if (request.schema?.properties?.tasks) {
        const id = /"taskId":"([a-z][a-z0-9-]*)"/.exec(request.prompt)[1];
        return {
          sessionId: `planner-${id}`,
          output: {
            summary: `Implement ${id}`,
            tasks: [
              {
                id: 'implementation',
                role: 'developer',
                writePaths: hooks.writePaths?.[id] ?? [`${id}.txt`],
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
        calls.reviews.push(request);
        return {
          sessionId: `review-${calls.review}`,
          output: (await hooks.onReview?.(request)) ?? {
            passed: true,
            findings: [],
            ...confirmedCriteria(request.schema),
          },
        };
      }
      if (/Repair confirmed failures/.test(request.prompt)) {
        calls.repair.push(request.cwd);
        await hooks.onRepair?.(request);
        return done('repair');
      }
      const id = /Implement task ([a-z][a-z0-9-]*)\./.exec(request.prompt)[1];
      calls.worker.push(id);
      calls.active++;
      calls.maxActive = Math.max(calls.maxActive, calls.active);
      try {
        await hooks.onWorker?.(id, calls, request);
        await writeFile(path.join(request.cwd, `${id}.txt`), `${id} implemented\n`);
      } finally {
        calls.active--;
      }
      request.onEvent?.({ sessionId: `worker-${id}` });
      return done(id);
    },
  };
  const delivery = {
    deliver: async () => assert.fail('A wave project never delivers'),
    releasePackage: async () => assert.fail('A wave project never releases'),
  };
  return {
    calls,
    services: { provider, researcher: async () => ({ items: [], requests: 1, errors: [], cache: [] }), delivery },
  };
}

// The combined result fails while left.txt and right.txt both exist and left.txt is not fixed.
const check =
  "import { existsSync, readFileSync } from 'node:fs';\n" +
  "if (existsSync('left.txt') && existsSync('right.txt') && !readFileSync('left.txt', 'utf8').includes('fixed')) {\n" +
  "  console.error('left and right disagree');\n  process.exit(1);\n}\n";

async function fixture(
  t,
  {
    epics,
    tasks,
    hooks = {},
    epicAcceptance = {},
    milestoneAcceptance = proof('m1-proof'),
    configure = config => config,
    files = {},
  },
) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'kodo-wave-e2e-'));
  const root = path.join(directory, 'repo'),
    home = path.join(directory, 'state'),
    isolated = path.join(directory, 'empty-home');
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
    assert.match(path.basename(directory), /^kodo-wave-e2e-/);
    await rm(directory, { recursive: true, force: true });
  });
  await writeFile(
    path.join(root, 'kodo.config.json'),
    JSON.stringify(
      configure({
        schemaVersion: 1,
        client: 'codex',
        // Task Runs are always quick; the gate takes this mode (repairs need a re-verification round).
        executionMode: 'standard',
        maxTasks: 2,
        concurrency: 1,
        researchBudget: 0,
        repairRounds: 3,
        commands: { test: [{ command: process.execPath, args: ['check.mjs'] }], build: [], deploy: [], smoke: [] },
        delivery: { enabled: false, release: false },
        uiVerification: { enabled: false },
        security: { enabled: false },
        architecture: { enabled: false },
      }),
    ),
  );
  await writeFile(path.join(root, 'check.mjs'), check);
  for (const [name, text] of Object.entries(files)) await writeFile(path.join(root, name), text);
  await writeFile(path.join(root, '.gitattributes'), '* text=auto eol=lf\n');
  git(root, 'init', '-b', 'main');
  git(root, 'config', 'user.name', 'Kodo Wave E2E');
  git(root, 'config', 'user.email', 'kodo-wave-e2e@example.invalid');
  git(root, 'config', 'core.autocrlf', 'false');
  git(root, 'config', 'commit.gpgSign', 'false');
  git(root, 'add', '.');
  git(root, 'commit', '-m', 'Wave E2E baseline');
  const store = new Store(home, {});
  stores.add(store);
  const { calls, services } = providers(hooks);
  const engine = new Engine({ store, secrets: {}, leaseHeartbeatMs: 50, ...services });
  const repo = await openProjectStore({
    store,
    contracts: A,
    authorizeTransition: createProjectTransitionAuthorizer({ store, engine, contracts: A }),
  });
  const command = (snapshot, action, actor = 'wave-e2e') => ({
    schemaVersion: 1,
    commandId: randomUUID(),
    projectId: snapshot?.project.projectId ?? null,
    expectedRevision: snapshot?.revision ?? null,
    actor,
    reason: 'Observe the wave requirement',
    action,
  });
  const spec = {
    schemaVersion: 1,
    id: 'wave-e2e',
    root,
    title: 'Wave end to end',
    definitionOfDone: [proof('project-proof')],
    constraints: ['Only the assigned paths.'],
    businessContext: 'Offline wave fixture.',
    architectureRefs: [],
    milestones: [{ id: 'm1', title: 'Milestone', acceptance: [milestoneAcceptance], releaseRequired: false }],
    epics: epics.map(id => ({
      id,
      milestoneId: 'm1',
      title: `Epic ${id}`,
      acceptance: [epicAcceptance[id] ?? proof(`${id}-proof`)],
    })),
    tasks,
    execution: wave,
  };
  const id = (await repo.apply(command(null, { op: 'create', spec }))).projectId;
  // CLI composition over the same Store and Engine (the CLI never closes a passed Store).
  const cli = argv => projectCli([...argv, '--json'], { secrets: {}, store, createEngine: () => engine });
  const branchHead = () => git(root, 'rev-parse', `refs/heads/kodo/project/${id}`);
  const statuses = rows => Object.fromEntries(rows.map(row => [row.id, row.status]));
  const taskRuns = () => store.listRuns(root).filter(run => run.directorBinding?.kind !== 'gate');
  return { root, store, engine, repo, id, command, calls, cli, branchHead, statuses, taskRuns };
}

test(
  'drain accepts two epics: wave 0, two parallel tasks and an epic gate that repairs the combined result',
  { timeout: 900000 },
  async t => {
    const f = await fixture(t, {
      epics: ['e0', 'e1'],
      tasks: [
        task('base', { epicId: 'e0' }),
        task('left', { dependsOn: ['base'] }),
        task('right', { dependsOn: ['base'] }),
      ],
      hooks: {
        // Both tasks of the second wave stay inside a session until the other one arrives.
        onWorker: async (id, calls) => {
          if (id === 'base') return;
          for (let i = 0; i < 400 && calls.active < 2; i++) await delay(25);
        },
        onRepair: request => writeFile(path.join(request.cwd, 'left.txt'), 'left fixed\n'),
      },
    });
    const user = git(f.root, 'rev-parse', 'HEAD');
    const result = await createProjectDirector({ repo: f.repo, engine: f.engine }).drain(f.id, { concurrency: 2 });
    assert.equal(result.status, 'accepted', JSON.stringify(result));
    assert.equal(result.waves, 2, 'wave 0 (base), then left and right together');
    assert.equal(result.integrated[0], 'base');
    assert.deepEqual([...result.integrated].sort(), ['base', 'left', 'right']);
    assert.equal(f.calls.maxActive, 2, 'left and right overlapped in time');
    assert.equal(f.calls.repair.length, 1, 'one repair round inside the epic gate');

    const snapshot = f.repo.snapshot(f.id);
    assert.equal(snapshot.project.status, 'accepted');
    assert.deepEqual(f.statuses(snapshot.milestones), { m1: 'accepted' });
    assert.deepEqual(f.statuses(snapshot.epics), { e0: 'accepted', e1: 'accepted' });
    assert.deepEqual(f.statuses(snapshot.tasks), { base: 'accepted', left: 'accepted', right: 'accepted' });
    assert.ok(snapshot.currentAttempts.every(row => row.status === 'accepted'));
    assert.deepEqual(
      snapshot.gates.map(gate => gate.containers.map(row => `${row.kind}:${row.kind === 'project' ? '' : row.id}`)),
      [['epic:e0'], ['epic:e1', 'milestone:m1', 'project:']],
    );
    const [first, second] = snapshot.gates.map(gate => f.store.getRun(gate.runId));
    assert.equal(first.state, 'succeeded');
    assert.equal(first.headSha, snapshot.gates[0].headSha, 'the first gate needed no repair');
    assert.equal(second.state, 'succeeded');
    assert.notEqual(second.headSha, snapshot.gates[1].headSha, 'the repair moved the verified head');
    assert.equal(second.directorBinding.headSha, snapshot.gates[1].headSha, 'the binding keeps the gate head');
    assert.equal(f.branchHead(), second.headSha, 'the repaired head was fast-forwarded into the branch');
    assert.equal(git(f.root, 'show', `${f.branchHead()}:left.txt`), 'left fixed');
    assert.equal(git(f.root, 'show', `${f.branchHead()}:right.txt`), 'right implemented');
    // Wave 1 started from the head that already contains the wave 0 merge.
    const runs = f.taskRuns();
    const base = runs.find(run => run.directorBinding.taskId === 'base');
    for (const id of ['left', 'right']) {
      const run = runs.find(row => row.directorBinding.taskId === id);
      assert.equal(git(f.root, 'merge-base', '--is-ancestor', base.integration.mergeCommit, run.baseSha), '');
      assert.equal(run.verificationProfile, 'task-fast');
    }
    assert.equal(git(f.root, 'rev-parse', 'HEAD'), user, "the user's checkout is untouched");
    const again = await createProjectDirector({ repo: f.repo, engine: f.engine }).drain(f.id);
    assert.deepEqual([again.status, again.waves], ['accepted', 0]);
  },
);

test(
  'T3 pull path: next-wave, a worker commit, complete-task, the epic gate, a replay, and drain leaves the external attempt alone',
  { timeout: 900000 },
  async t => {
    const f = await fixture(t, { epics: ['e1'], tasks: [task('alpha', { priority: 90 }), task('beta')] });
    const next = await f.cli(['next-wave', f.id, '--host', 't3', '--limit', '1']);
    assert.equal(next.exitCode, 0, next.output);
    const [brief] = next.report.result.briefs;
    assert.equal(brief.taskId, 'alpha');
    assert.equal(brief.baseSha, f.branchHead());

    // The drain executes beta natively and never touches the external alpha attempt.
    const drained = await f.cli(['drain', f.id]);
    assert.equal(drained.report.result.status, 'blocked', drained.output);
    assert.deepEqual(drained.report.result.integrated, ['beta']);
    assert.deepEqual(f.calls.worker, ['beta']);
    let snapshot = f.repo.snapshot(f.id);
    const alphaAttempt = snapshot.currentAttempts.find(row => row.taskId === 'alpha');
    assert.equal(alphaAttempt.runId, brief.runId);
    assert.equal(alphaAttempt.status, 'running');
    const external = f.store.getRun(brief.runId);
    assert.deepEqual([external.state, external.checks ?? null], ['executing', null]);
    assert.deepEqual(external.executor, { kind: 'external', host: 't3' });

    // The worker chat commits in its own worktree and reports the SHA.
    await writeFile(path.join(brief.worktree, 'alpha.txt'), 'alpha by the worker chat\n');
    git(brief.worktree, 'add', '-A');
    git(brief.worktree, 'commit', '-m', 'Implement alpha');
    const head = git(brief.worktree, 'rev-parse', 'HEAD');
    const completed = await f.cli(['complete-task', f.id, 'alpha', '--head', head]);
    assert.equal(completed.exitCode, 0, completed.output);
    const result = completed.report.result;
    assert.equal(result.status, 'integrated');
    assert.deepEqual(result.gates.blocked, []);
    assert.equal(result.gates.gates.length, 1);
    assert.equal(result.gates.gates[0].state, 'succeeded');
    snapshot = f.repo.snapshot(f.id);
    assert.equal(snapshot.project.status, 'accepted');
    assert.deepEqual(f.statuses(snapshot.tasks), { alpha: 'accepted', beta: 'accepted' });
    assert.deepEqual(f.statuses(snapshot.epics), { e1: 'accepted' });
    const alphaRun = f.store.getRun(brief.runId);
    assert.equal(alphaRun.headSha, head);
    assert.equal(alphaRun.checks.profile, 'task-fast');
    assert.equal(git(f.root, 'merge-base', '--is-ancestor', head, f.branchHead()), '');
    assert.equal(git(f.root, 'show', `${f.branchHead()}:alpha.txt`), 'alpha by the worker chat');

    const replay = await f.cli(['complete-task', f.id, 'alpha', '--head', head]);
    assert.equal(replay.exitCode, 0, replay.output);
    assert.equal(replay.report.result.replayed, true);
    assert.deepEqual(replay.report.result.integration, result.integration);
    assert.equal(replay.report.result.revision, snapshot.revision, 'a replay writes nothing');
    assert.equal(f.repo.snapshot(f.id).gates.length, 1, 'no second gate');
  },
);

test('drain --retry-failed never executes natively a task an external chat abandoned', { timeout: 900000 }, async t => {
  // F2 open question: the retry went to the drain, which re-ran the external task natively.
  const f = await fixture(t, { epics: ['e1'], tasks: [task('ext')] });
  const next = await f.cli(['next-wave', f.id, '--host', 't3']);
  assert.equal(next.exitCode, 0, next.output);
  const [brief] = next.report.result.briefs;
  const abandoned = await f.cli([
    'complete-task',
    f.id,
    'ext',
    '--head',
    brief.baseSha,
    '--abandon',
    '--attempt',
    brief.attemptId,
  ]);
  assert.equal(abandoned.report.result.status, 'abandoned', abandoned.output);
  const drained = await f.cli(['drain', f.id, '--retry-failed']);
  assert.equal(drained.report.result.status, 'blocked', drained.output);
  assert.ok(
    drained.report.result.blockers.some(row => row.code === 'wave_retry_executor' && row.id === 'ext'),
    drained.output,
  );
  assert.deepEqual(f.calls.worker, [], 'the drain never executed the external task');
  assert.equal(f.taskRuns().length, 1, 'no native Run was installed');
  const retried = await f.cli(['next-wave', f.id, '--host', 't3', '--retry-failed']);
  assert.equal(retried.exitCode, 0, retried.output);
  assert.deepEqual(
    retried.report.result.briefs.map(row => row.taskId),
    ['ext'],
  );
  assert.notEqual(retried.report.result.briefs[0].runId, brief.runId);
  assert.deepEqual(f.store.getRun(retried.report.result.briefs[0].runId).executor, { kind: 'external', host: 't3' });
});

test('A reservation without a Run is resumed only by its own executor', { timeout: 900000 }, async t => {
  const f = await fixture(t, { epics: ['e1'], tasks: [task('ext'), task('own')] });
  // Crashes between reserveAttempt and the Run install: one for host t3, one for the drain.
  for (const [id, actor] of [
    ['ext', externalReserver('t3')],
    ['own', NATIVE_RESERVER],
  ]) {
    await f.repo.apply(
      f.command(f.repo.snapshot(f.id), { op: 'transition', kind: 'task', id, to: 'ready', evidence: [], mappings: [] }),
    );
    await f.repo.apply(
      f.command(f.repo.snapshot(f.id), { op: 'reserveAttempt', taskId: id, retryFailed: false }, actor),
    );
  }
  const attempts = () => Object.fromEntries(f.repo.snapshot(f.id).currentAttempts.map(row => [row.taskId, row.runId]));
  const reserved = attempts();

  const orca = await f.cli(['next-wave', f.id, '--host', 'orca']);
  assert.equal(orca.exitCode, 2, orca.output);
  assert.deepEqual(orca.report.result.briefs, [], "another host adopts neither t3's nor the drain's reservation");
  assert.equal(f.taskRuns().length, 0);

  const drained = await f.cli(['drain', f.id, '--max-waves', '1']);
  assert.equal(drained.report.result.status, 'max_waves', drained.output);
  assert.deepEqual(drained.report.result.integrated, ['own']);
  assert.deepEqual(f.calls.worker, ['own'], 'the drain resumed only its own reservation');
  assert.equal(f.taskRuns().length, 1);
  assert.deepEqual(attempts(), reserved, 'no attempt was replaced');

  const t3 = await f.cli(['next-wave', f.id, '--host', 't3']);
  assert.equal(t3.exitCode, 0, t3.output);
  assert.deepEqual(
    t3.report.result.briefs.map(row => [row.taskId, row.runId]),
    [['ext', reserved.ext]],
  );
  assert.deepEqual(f.store.getRun(reserved.ext).executor, { kind: 'external', host: 't3' });
});

// --- Independent review of the project factory: regression tests ------------------------------

const editConfig = async (cwd, change) => {
  const file = path.join(cwd, 'kodo.config.json');
  await writeFile(file, JSON.stringify(change(JSON.parse(await readFile(file, 'utf8'))), null, 2));
};

// The production authorizer of an acceptance by the gate Run, with an evaluator that only runs its
// trusted validator (validateWaveRun), so the validator's own refusal code is observable.
function authorizeByGate(f, run) {
  const authorize = createProjectTransitionAuthorizer({
    store: f.store,
    engine: f.engine,
    contracts: A,
    evaluator: {
      evaluateWaveTransition: async (input, ports) => {
        await ports.validateRun(input.run);
        return { eligibleStates: [input.command.action.to] };
      },
    },
  });
  const snapshot = f.repo.snapshot(f.id);
  const ref = {
    kind: 'checks',
    runId: run.id,
    headSha: run.headSha,
    path: run.gateManifest.path,
    sha256: 'a'.repeat(64),
  };
  const command = f.command(snapshot, {
    op: 'transition',
    kind: 'epic',
    id: 'e1',
    to: 'accepted',
    evidence: [ref],
    mappings: [],
  });
  return withIntegrationLease(f.store, f.id, () => authorize({ command, snapshot }));
}

test(
  'A behavioural oracle a task adds to kodo.config.json runs in the epic gate: its exit 19 never accepts the project',
  { timeout: 900000 },
  async t => {
    // Review finding (blocker): the gate took its policy from the user's checkout and ran no oracle.
    const f = await fixture(t, {
      epics: ['e1'],
      tasks: [task('policy', { writePaths: ['kodo.config.json', 'policy.txt'] })],
      hooks: {
        writePaths: { policy: ['kodo.config.json', 'policy.txt'] },
        onWorker: (id, calls, request) =>
          editConfig(request.cwd, config => ({
            ...config,
            verification: {
              oracles: [
                {
                  id: 'exit-nineteen',
                  command: process.execPath,
                  args: ['-e', 'process.exit(19)'],
                  protect: ['oracle-guard/**'],
                },
              ],
            },
          })),
      },
    });
    const result = await createProjectDirector({ repo: f.repo, engine: f.engine }).drain(f.id);
    assert.equal(result.status, 'blocked', JSON.stringify(result));
    const snapshot = f.repo.snapshot(f.id);
    assert.notEqual(snapshot.project.status, 'accepted');
    assert.equal(snapshot.epics[0].status, 'integrated');
    assert.equal(snapshot.tasks[0].status, 'integrated', 'the task verified under the policy of its base');
    const [taskRun] = f.taskRuns();
    assert.equal(taskRun.config.verification, undefined, 'the task Run verifies under the policy of its base');
    assert.equal(taskRun.wavePolicy.commit, taskRun.baseSha);
    const gate = f.store.getRun(snapshot.gates[0].runId);
    assert.notEqual(gate.state, 'succeeded');
    assert.equal(gate.wavePolicy.commit, snapshot.gates[0].headSha, 'the gate executes the policy of its head');
    assert.deepEqual(
      gate.config.verification.oracles.map(row => row.id),
      ['exit-nineteen'],
    );
    assert.ok(
      gate.behavior?.oracles?.some(row => row.id === 'exit-nineteen' && row.exitCode === 19),
      JSON.stringify(gate.behavior?.oracles),
    );
  },
);

test(
  'commands.smoke a task adds runs in its epic gate, the task never hangs, and the validator binds the commit policy and every criterion',
  { timeout: 900000 },
  async t => {
    // Review finding (blocker, reverse failure): a task that added smoke stayed running with a recorded merge.
    const f = await fixture(t, {
      epics: ['e1'],
      tasks: [task('smoke', { writePaths: ['kodo.config.json', 'smoke.txt'] })],
      hooks: {
        writePaths: { smoke: ['kodo.config.json', 'smoke.txt'] },
        onWorker: (id, calls, request) =>
          editConfig(request.cwd, config => ({
            ...config,
            commands: {
              ...config.commands,
              smoke: [{ command: process.execPath, args: ['-e', "console.log('smoke ran')"] }],
            },
          })),
      },
    });
    const result = await createProjectDirector({ repo: f.repo, engine: f.engine }).drain(f.id);
    assert.equal(result.status, 'accepted', JSON.stringify(result));
    const snapshot = f.repo.snapshot(f.id);
    assert.deepEqual(f.statuses(snapshot.tasks), { smoke: 'accepted' });
    const gate = f.store.getRun(snapshot.gates[0].runId);
    assert.equal(gate.smoke.results.length, 1, 'the gate executed the smoke command of its head');
    assert.equal(gate.smoke.results[0].exitCode, 0);
    assert.match(JSON.parse(await readFile(gate.smoke.results[0].outputPath, 'utf8')).value.stdout, /smoke ran/);
    assert.deepEqual(
      gate.review.criteria.map(row => [row.id, row.met]),
      [
        ['epic:e1:e1-proof', true],
        ['milestone:m1:m1-proof', true],
        [`project:${f.id}:project-proof`, true],
        ['task:smoke:smoke-proof', true],
      ],
    );

    // The trusted validator accepts this gate Run as it is ...
    await authorizeByGate(f, gate);
    // ... but not with a policy that differs from the one of its verified commit ...
    f.store.updateRun(gate.id, { config: { ...gate.config, commands: { ...gate.config.commands, smoke: [] } } });
    await assert.rejects(() => authorizeByGate(f, f.store.getRun(gate.id)), { code: 'project_wave_policy_mismatch' });
    f.store.updateRun(gate.id, { config: gate.config });
    // ... nor with a review that does not confirm every covered criterion.
    const unmet = gate.review.criteria.map(row => (row.id === 'epic:e1:e1-proof' ? { ...row, met: false } : row));
    for (const criteria of [unmet, gate.review.criteria.slice(1)]) {
      f.store.updateRun(gate.id, { review: { ...gate.review, criteria } });
      await assert.rejects(() => authorizeByGate(f, f.store.getRun(gate.id)), { code: 'project_gate_criteria_unmet' });
    }
  },
);

test(
  'An epic gate confirms the epic criteria: a reviewer that finds them unmet never accepts the epic',
  { timeout: 900000 },
  async t => {
    // Review finding (major): an epic "keep scores across restarts" was accepted by a commit of one text file.
    const scores = { id: 'scores-persist', text: 'Scores persist between restarts', evidenceKinds: ['acceptance'] };
    const f = await fixture(t, {
      epics: ['e1'],
      tasks: [task('notes')],
      epicAcceptance: { e1: scores },
      hooks: {
        onReview: request =>
          request.schema.properties.criteria
            ? {
                passed: true,
                findings: [],
                ...confirmedCriteria(request.schema, { unmet: ['epic:e1:scores-persist'] }),
              }
            : undefined,
      },
    });
    const result = await createProjectDirector({ repo: f.repo, engine: f.engine }).drain(f.id);
    assert.equal(result.status, 'blocked', JSON.stringify(result));
    const snapshot = f.repo.snapshot(f.id);
    assert.notEqual(snapshot.project.status, 'accepted');
    assert.notEqual(snapshot.epics[0].status, 'accepted');
    assert.deepEqual(f.statuses(snapshot.tasks), { notes: 'integrated' });
    const gateReviews = f.calls.reviews.filter(request => request.schema.properties.criteria);
    assert.ok(gateReviews.length >= 1, 'the gate review confirms criteria');
    assert.match(
      gateReviews[0].prompt,
      /Scores persist between restarts/,
      "the reviewer's input holds the epic criterion",
    );
    assert.ok(gateReviews[0].schema.properties.criteria.items.properties.id.enum.includes('epic:e1:scores-persist'));
    const gate = f.store.getRun(snapshot.gates[0].runId);
    assert.notEqual(gate.state, 'succeeded');
    const manifest = JSON.parse(await readFile(gate.gateManifest.path, 'utf8')).value;
    assert.deepEqual(manifest.containers[0], { kind: 'epic', id: 'e1', criteria: [scores] });
  },
);

test(
  'complete-task inspects every commit: a credentials file committed and deleted later is never integrated',
  { timeout: 900000 },
  async t => {
    // Review finding (major): only the final diff was checked; the secret stayed reachable on the branch.
    const f = await fixture(t, { epics: ['e1'], tasks: [task('alpha', { writePaths: ['alpha/**'] })] });
    const next = await f.cli(['next-wave', f.id, '--host', 't3']);
    assert.equal(next.exitCode, 0, next.output);
    const [brief] = next.report.result.briefs;
    await mkdir(path.join(brief.worktree, 'alpha'));
    await writeFile(path.join(brief.worktree, 'alpha', 'credentials.json'), '{"token":"leaked"}\n');
    git(brief.worktree, 'add', '-A');
    git(brief.worktree, 'commit', '-m', 'Add credentials by mistake');
    const leaked = git(brief.worktree, 'rev-parse', 'HEAD');
    git(brief.worktree, 'rm', '-q', 'alpha/credentials.json');
    await mkdir(path.join(brief.worktree, 'alpha'), { recursive: true });
    await writeFile(path.join(brief.worktree, 'alpha', 'alpha.txt'), 'alpha\n');
    git(brief.worktree, 'add', '-A');
    git(brief.worktree, 'commit', '-m', 'Implement alpha');
    const head = git(brief.worktree, 'rev-parse', 'HEAD');
    const completed = await f.cli(['complete-task', f.id, 'alpha', '--head', head]);
    assert.equal(completed.exitCode, 2, completed.output);
    assert.equal(completed.report.result.status, 'checks_failed');
    assert.equal(completed.report.result.code, 'external_scope');
    assert.match(completed.report.result.message, /credentials\.json/);
    assert.equal(f.branchHead(), brief.baseSha, 'nothing was merged');
    const reachable = spawnSync('git', ['merge-base', '--is-ancestor', leaked, f.branchHead()], { cwd: f.root });
    assert.equal(reachable.status, 1, 'the commit with the secret is not on the integration branch');
    assert.equal(f.repo.snapshot(f.id).currentAttempts[0].status, 'running');
  },
);

test(
  'A replayed complete-task reports a merge that left the integration branch as a recovery blocker',
  { timeout: 900000 },
  async t => {
    // Review finding (major): the replay answered `integrated` after the merge was rolled back.
    const f = await fixture(t, { epics: ['e1'], tasks: [task('alpha')] });
    const [brief] = (await f.cli(['next-wave', f.id, '--host', 't3'])).report.result.briefs;
    await writeFile(path.join(brief.worktree, 'alpha.txt'), 'alpha\n');
    git(brief.worktree, 'add', '-A');
    git(brief.worktree, 'commit', '-m', 'Implement alpha');
    const head = git(brief.worktree, 'rev-parse', 'HEAD');
    const complete = ['complete-task', f.id, 'alpha', '--head', head, '--defer-gate'];
    const done = await f.cli(complete);
    assert.equal(done.report.result.status, 'integrated', done.output);
    const replay = await f.cli(complete);
    assert.deepEqual(
      [replay.exitCode, replay.report.result.status, replay.report.result.replayed],
      [0, 'integrated', true],
    );
    // The merge leaves the branch (a manual reset of the integration worktree).
    const { integration } = f.store.getRun(brief.runId);
    const block = git(f.root, 'worktree', 'list', '--porcelain')
      .split(/\r?\n\r?\n/)
      .find(row => row.includes(`branch refs/heads/kodo/project/${f.id}`));
    git(/^worktree (.+)$/m.exec(block)[1], 'reset', '-q', '--hard', integration.before);
    const late = await f.cli(complete);
    assert.equal(late.exitCode, 2, late.output);
    assert.equal(late.report.result.status, 'blocked');
    assert.equal(late.report.result.code, 'project_integration_missing');
  },
);

test('A late repeat of --abandon replays its own attempt and never blocks the retry', { timeout: 900000 }, async t => {
  // Review finding (major): the original command repeated after next-wave --retry-failed blocked the NEW attempt.
  const f = await fixture(t, { epics: ['e1'], tasks: [task('ext')] });
  const [brief] = (await f.cli(['next-wave', f.id, '--host', 't3'])).report.result.briefs;
  const abandon = ['complete-task', f.id, 'ext', '--head', brief.baseSha, '--abandon'];
  const first = await f.cli([...abandon, '--attempt', brief.attemptId]);
  assert.equal(first.report.result.status, 'abandoned', first.output);
  const [retry] = (await f.cli(['next-wave', f.id, '--host', 't3', '--retry-failed'])).report.result.briefs;
  assert.notEqual(retry.attemptId, brief.attemptId);
  const current = () => f.repo.snapshot(f.id).currentAttempts[0];
  // Without --attempt the CLI refuses the abandon before touching any state.
  const unnamed = await f.cli(abandon);
  assert.deepEqual([unnamed.exitCode, unnamed.report.result.code], [1, 'project_arguments']);
  assert.deepEqual([current().id, current().status], [retry.attemptId, 'running']);
  for (const argv of [[...abandon, '--attempt', brief.attemptId]]) {
    const late = await f.cli(argv);
    assert.deepEqual([current().id, current().status], [retry.attemptId, 'running'], 'the retry keeps running');
    assert.equal(f.store.getRun(retry.runId).state, 'executing');
    assert.equal(late.exitCode, 0, late.output);
    assert.deepEqual(
      [late.report.result.status, late.report.result.attemptId, late.report.result.replayed],
      ['abandoned', brief.attemptId, true],
    );
  }
  assert.equal(first.report.result.attemptId, brief.attemptId);
  assert.equal(
    retry.abandonCommand,
    `kodo project complete-task ${f.id} ext --head <SHA> --abandon --attempt ${retry.attemptId}`,
  );
  const stale = await f.cli(['complete-task', f.id, 'ext', '--head', brief.baseSha, '--attempt', brief.attemptId]);
  assert.deepEqual([stale.exitCode, stale.report.result.code], [2, 'project_attempt_stale']);
  const own = await f.cli([...abandon, '--attempt', retry.attemptId]);
  assert.deepEqual([own.report.result.status, own.report.result.attemptId], ['abandoned', retry.attemptId]);
  assert.equal(own.report.result.replayed, undefined);
  assert.equal(current().status, 'blocked');
});

// --- Second review of the project factory: regression tests ------------------------------------

test(
  'A policy the Store would record redacted is refused: a command that exits 19 intact never accepts the project',
  { timeout: 900000 },
  async t => {
    // Review finding (blocker): the policy was read through the redacting runner; `?key=intact-value`
    // became `?key=[REDACTED]`, so the gate executed a command that exits 0 instead of 19.
    const f = await fixture(t, {
      epics: ['e1'],
      tasks: [task('redacted', { writePaths: ['kodo.config.json', 'redacted.txt'] })],
      hooks: {
        writePaths: { redacted: ['kodo.config.json', 'redacted.txt'] },
        onWorker: (id, calls, request) =>
          editConfig(request.cwd, config => ({
            ...config,
            commands: {
              ...config.commands,
              test: [
                {
                  command: process.execPath,
                  args: ['-e', "process.exit(process.argv[1].includes('REDACTED') ? 0 : 19)", '?key=intact-value'],
                },
              ],
            },
          })),
      },
    });
    const base = git(f.root, 'rev-parse', 'HEAD');
    const result = await createProjectDirector({ repo: f.repo, engine: f.engine }).drain(f.id);
    assert.equal(result.status, 'blocked', JSON.stringify(result));
    assert.match(JSON.stringify(result), /wave_policy_unsafe/);
    const snapshot = f.repo.snapshot(f.id);
    assert.notEqual(snapshot.project.status, 'accepted');
    assert.ok(!['integrated', 'accepted'].includes(snapshot.tasks[0].status), snapshot.tasks[0].status);
    assert.equal(f.branchHead(), base, 'nothing was merged');
    assert.deepEqual(snapshot.gates, [], 'no gate executed the policy');
  },
);

test(
  'Every repair commit of a gate is inspected: a credentials file committed and deleted never enters the branch',
  { timeout: 900000 },
  async t => {
    // Review finding (major): only the verified result of the repairs was checked; the project was
    // accepted and the commit with credentials.json was on the integration branch.
    let leaked = null;
    const f = await fixture(t, {
      epics: ['e1'],
      tasks: [task('left'), task('right')],
      hooks: {
        onRepair: async request => {
          await writeFile(path.join(request.cwd, 'credentials.json'), '{"token":"leaked"}\n');
          git(request.cwd, 'add', '-A');
          git(request.cwd, 'commit', '-q', '-m', 'Repair with credentials');
          leaked = git(request.cwd, 'rev-parse', 'HEAD');
          git(request.cwd, 'rm', '-q', 'credentials.json');
          git(request.cwd, 'commit', '-q', '-m', 'Remove credentials');
          await writeFile(path.join(request.cwd, 'left.txt'), 'left fixed\n');
        },
      },
    });
    const result = await createProjectDirector({ repo: f.repo, engine: f.engine }).drain(f.id, { concurrency: 2 });
    assert.ok(leaked, 'the gate repaired the combined result');
    assert.equal(result.status, 'blocked', JSON.stringify(result));
    assert.match(JSON.stringify(result), /project_integration_history/);
    const snapshot = f.repo.snapshot(f.id);
    assert.notEqual(snapshot.project.status, 'accepted');
    assert.notEqual(snapshot.epics[0].status, 'accepted');
    const gate = f.store.getRun(snapshot.gates[0].runId);
    assert.deepEqual([gate.state, gate.error?.code], ['blocked', 'project_integration_history']);
    // The drain result reports the saved gate state, not the state before acceptance blocked it.
    assert.deepEqual(
      result.gates.filter(row => row.runId === gate.id).map(row => row.state),
      ['blocked'],
    );
    assert.equal(f.branchHead(), snapshot.gates[0].headSha, 'the repairs were never merged back');
    const reachable = spawnSync('git', ['merge-base', '--is-ancestor', leaked, f.branchHead()], { cwd: f.root });
    assert.equal(reachable.status, 1, 'the commit with credentials.json is not on the integration branch');
  },
);

test(
  'A full node --test of the gate that passes no test fails the gate and records the parsed count',
  { timeout: 900000 },
  async t => {
    // Review finding (major): a task switched commands.test to `node --test --test-reporter=tap` in a
    // repository without tests; `# tests 0`, `# pass 0` and exit 0 accepted the project.
    const f = await fixture(t, {
      epics: ['e1'],
      tasks: [task('zero', { writePaths: ['kodo.config.json', 'zero.txt'] })],
      hooks: {
        writePaths: { zero: ['kodo.config.json', 'zero.txt'] },
        onWorker: (id, calls, request) =>
          editConfig(request.cwd, config => ({
            ...config,
            commands: {
              ...config.commands,
              test: [{ command: process.execPath, args: ['--test', '--test-reporter=tap'] }],
            },
          })),
      },
    });
    const result = await createProjectDirector({ repo: f.repo, engine: f.engine }).drain(f.id);
    assert.equal(result.status, 'blocked', JSON.stringify(result));
    const snapshot = f.repo.snapshot(f.id);
    assert.notEqual(snapshot.project.status, 'accepted');
    assert.equal(snapshot.tasks[0].status, 'integrated');
    const gate = f.store.getRun(snapshot.gates[0].runId);
    assert.notEqual(gate.state, 'succeeded');
    assert.deepEqual(gate.config.commands.test[0].args, ['--test', '--test-reporter=tap']);
    assert.equal(gate.checks.results[0].exitCode, 0, 'the runner itself exited 0');
    assert.equal(gate.checks.results[0].tests, 0, 'the receipt records the parsed count');
    assert.match(gate.error.message, /node --test/);
  },
);

test(
  'A gate whose node --test passed tests records the count, and the validator binds it to the evidence log',
  { timeout: 900000 },
  async t => {
    const paths = ['kodo.config.json', 'counted.txt', 'counted.test.mjs'];
    const f = await fixture(t, {
      epics: ['e1'],
      tasks: [task('counted', { writePaths: paths })],
      hooks: {
        writePaths: { counted: paths },
        onWorker: async (id, calls, request) => {
          await writeFile(
            path.join(request.cwd, 'counted.test.mjs'),
            ["import test from 'node:test';", "test('counted', () => {});", ''].join('\n'),
          );
          await editConfig(request.cwd, config => ({
            ...config,
            commands: {
              ...config.commands,
              test: [{ command: process.execPath, args: ['--test', '--test-reporter=tap'] }],
            },
          }));
        },
      },
    });
    const result = await createProjectDirector({ repo: f.repo, engine: f.engine }).drain(f.id);
    assert.equal(result.status, 'accepted', JSON.stringify(result));
    const gate = f.store.getRun(f.repo.snapshot(f.id).gates[0].runId);
    assert.equal(gate.checks.results[0].tests, 1);
    await authorizeByGate(f, gate);
    for (const tests of [2, 0, undefined]) {
      const results = gate.checks.results.map((row, index) => (index ? row : { ...row, tests }));
      f.store.updateRun(gate.id, { checks: { ...gate.checks, results } });
      await assert.rejects(() => authorizeByGate(f, f.store.getRun(gate.id)), {
        code: 'project_gate_tests_uncounted',
      });
    }
    // The validator recounts the event file the log keeps, never stdout: a log whose stdout claims
    // more tests, whose events are incomplete or whose executed command differs proves no count.
    const log = JSON.parse(await readFile(gate.checks.results[0].outputPath, 'utf8'));
    const stdout = log.value.stdout.replace(/^# (tests|pass) 1$/gm, '# $1 5');
    assert.notEqual(stdout, log.value.stdout);
    const executed = { ...log.value.executed, args: [...log.value.executed.args, '--test-name-pattern=counted'] };
    for (const [value, tests] of [
      [{ ...log.value, stdout }, 5],
      [{ ...log.value, testEvents: log.value.testEvents.replace(/\{"type":"end"\}\n$/, '') }, 1],
      [{ ...log.value, testEvents: undefined }, 1],
      [{ ...log.value, executed }, 1],
    ]) {
      const evidence = await f.engine.persistEvidence(gate, 'check', value, { headSha: gate.headSha });
      const results = gate.checks.results.map((row, index) =>
        index ? row : { ...row, tests, outputPath: evidence.path, outputHash: evidence.sha256 },
      );
      f.store.updateRun(gate.id, { checks: { ...gate.checks, results } });
      await assert.rejects(() => authorizeByGate(f, f.store.getRun(gate.id)), {
        code: 'project_gate_tests_uncounted',
      });
    }
    // A receipt row of an older counting algorithm is no proof either.
    const results = gate.checks.results.map(({ countVersion: _, ...row }) => row);
    f.store.updateRun(gate.id, { checks: { ...gate.checks, results } });
    await assert.rejects(() => authorizeByGate(f, f.store.getRun(gate.id)), {
      code: 'project_gate_tests_uncounted',
    });
    // The genuine receipt is still accepted.
    f.store.updateRun(gate.id, { checks: gate.checks });
    await authorizeByGate(f, f.store.getRun(gate.id));
  },
);

// The default commands.test (`npm test`) whose package script is a plain `node --test`.
const defaultNpmTest = async (cwd, scripts = { test: 'node --test' }) => {
  await writeFile(path.join(cwd, 'package.json'), JSON.stringify({ name: 'wave', private: true, scripts }, null, 2));
  await editConfig(cwd, ({ commands: _, ...config }) => config);
};

test(
  'The default npm test running node --test without test files never lets the gate accept the project',
  { timeout: 900000 },
  async t => {
    // Review finding: `npm test` -> `node --test` without tests logged `tests 0`, `pass 0`, exit 0 and the
    // project was accepted: Kodo counted only a direct `node --test` and judged `npm test` by exit code.
    const paths = ['kodo.config.json', 'package.json', 'npmzero.txt'];
    const f = await fixture(t, {
      epics: ['e1'],
      tasks: [task('npmzero', { writePaths: paths })],
      hooks: { writePaths: { npmzero: paths }, onWorker: (id, calls, request) => defaultNpmTest(request.cwd) },
    });
    const result = await createProjectDirector({ repo: f.repo, engine: f.engine }).drain(f.id);
    assert.equal(result.status, 'blocked', JSON.stringify(result));
    const snapshot = f.repo.snapshot(f.id);
    assert.notEqual(snapshot.project.status, 'accepted');
    assert.equal(snapshot.tasks[0].status, 'integrated');
    const gate = f.store.getRun(snapshot.gates[0].runId);
    assert.notEqual(gate.state, 'succeeded');
    assert.deepEqual(gate.config.commands.test, [{ command: 'npm', args: ['test'] }], 'the default commands.test');
    const [row] = gate.checks.results;
    assert.deepEqual(row.command, { command: 'npm', args: ['test'] }, 'the receipt keeps the configured command');
    assert.deepEqual(row.count.resolved, { script: 'test', text: 'node --test' });
    assert.equal(row.count.executed.command, process.execPath, 'the counting run is Node itself');
    assert.deepEqual(row.count.executed.args.slice(4), ['--test']);
    assert.deepEqual(
      [row.exitCode, row.count.exitCode, row.count.tests],
      [0, 0, 0],
      'npm and its counting run exited 0 after passing no test',
    );
    assert.match(gate.error.message, /node --test/);
  },
);

test(
  'The default npm test with one node --test test is accepted with a count of 1, and the validator binds the count',
  { timeout: 900000 },
  async t => {
    const paths = ['kodo.config.json', 'package.json', 'npmone.txt', 'npmone.test.mjs'];
    const f = await fixture(t, {
      epics: ['e1'],
      tasks: [task('npmone', { writePaths: paths })],
      hooks: {
        writePaths: { npmone: paths },
        onWorker: async (id, calls, request) => {
          await writeFile(
            path.join(request.cwd, 'npmone.test.mjs'),
            ["import test from 'node:test';", "test('npm one', () => {});", ''].join('\n'),
          );
          await defaultNpmTest(request.cwd);
        },
      },
    });
    const result = await createProjectDirector({ repo: f.repo, engine: f.engine }).drain(f.id);
    assert.equal(result.status, 'accepted', JSON.stringify(result));
    const gate = f.store.getRun(f.repo.snapshot(f.id).gates[0].runId);
    const [row] = gate.checks.results;
    assert.deepEqual(row.command, { command: 'npm', args: ['test'] });
    assert.deepEqual([row.exitCode, row.countVersion, row.tests], [0, TEST_COUNT_VERSION, undefined]);
    assert.deepEqual(
      [row.count.resolved, row.count.exitCode, row.count.tests],
      [{ script: 'test', text: 'node --test' }, 0, 1],
    );
    const log = JSON.parse(await readFile(row.outputPath, 'utf8'));
    assert.match(log.value.stdout, /tests 1/, 'npm ran the configured script');
    assert.deepEqual(log.value.count.resolved, row.count.resolved, 'the evidence log keeps the counting run');
    await authorizeByGate(f, gate);
    // The receipt must hold exactly the counting run of the verified commit's script (forged counts).
    const count = row.count;
    for (const change of [
      { count: { ...count, resolved: { script: 'test', text: 'node --test npmone.test.mjs' } } },
      { count: { ...count, resolved: { script: 'unit', text: 'node --test' } } },
      { count: { ...count, tests: 2 } },
      { count: { ...count, tests: 0 } },
      { count: { ...count, tests: null } },
      { count: { ...count, exitCode: 1 } },
      { count: undefined },
      { countVersion: 4 },
      { tests: 1 },
      { resolved: count.resolved },
    ]) {
      const results = gate.checks.results.map((item, index) => (index ? item : { ...item, ...change }));
      f.store.updateRun(gate.id, { checks: { ...gate.checks, results } });
      await assert.rejects(
        () => authorizeByGate(f, f.store.getRun(gate.id)),
        { code: 'project_gate_tests_uncounted' },
        JSON.stringify(change),
      );
    }
    // A log whose counting run differs from that script's resolution, is not Kodo's exact counting
    // command, lost its events or its count, or recounts to another number proves nothing.
    const logged = log.value.count;
    const executed = { ...logged.executed, args: [...logged.executed.args, 'npmone.test.mjs'] };
    for (const value of [
      { ...log.value, count: { ...logged, resolved: { script: 'test', text: 'node --test npmone.test.mjs' } } },
      { ...log.value, count: { ...logged, executed } },
      { ...log.value, count: { ...logged, executed: { ...logged.executed, command: 'node' } } },
      { ...log.value, count: { ...logged, testEvents: logged.testEvents.replace(/\{"type":"end"\}\n$/, '') } },
      { ...log.value, count: { ...logged, testEvents: '{"type":"end"}\n' } },
      { ...log.value, count: undefined },
      { ...log.value, countVersion: 4 },
      { ...log.value, resolved: count.resolved },
    ]) {
      const evidence = await f.engine.persistEvidence(gate, 'check', value, { headSha: gate.headSha });
      const results = gate.checks.results.map((item, index) =>
        index ? item : { ...item, outputPath: evidence.path, outputHash: evidence.sha256 },
      );
      f.store.updateRun(gate.id, { checks: { ...gate.checks, results } });
      await assert.rejects(() => authorizeByGate(f, f.store.getRun(gate.id)), {
        code: 'project_gate_tests_uncounted',
      });
    }
    // The genuine receipt is still accepted.
    f.store.updateRun(gate.id, { checks: gate.checks });
    await authorizeByGate(f, f.store.getRun(gate.id));
  },
);

// The production authorizer of a task transition with an evaluator that only runs the trusted
// validator (validateWaveRun) of the task Run, so its own refusal code is observable.
function authorizeTask(f, run) {
  const authorize = createProjectTransitionAuthorizer({
    store: f.store,
    engine: f.engine,
    contracts: A,
    evaluator: {
      evaluateWaveTransition: async (input, ports) => {
        await ports.validateRun(input.run);
        return { eligibleStates: [input.command.action.to] };
      },
    },
  });
  const snapshot = f.repo.snapshot(f.id);
  const ref = {
    kind: 'checks',
    runId: run.id,
    headSha: run.headSha,
    path: run.checks.results[0].outputPath,
    sha256: 'a'.repeat(64),
  };
  const command = f.command(snapshot, {
    op: 'transition',
    kind: 'task',
    id: run.directorBinding.taskId,
    to: 'verifying',
    evidence: [ref],
    mappings: [],
  });
  return withIntegrationLease(f.store, f.id, () => authorize({ command, snapshot }));
}
const withoutCommands = ({ commands: _, ...config }) => config;
const npmManifest = JSON.stringify({ name: 'wave', private: true, scripts: { test: 'node --test' } });

test(
  'apply-spec -> drain never accepts a project whose default npm test runs node --test without test files',
  { timeout: 900000 },
  async t => {
    // Review finding (reproduced on Node 24.19.0): the default commands.test (`npm test`) and
    // `"test": "node --test"` without test files logged `tests 0`, exit 0, and drain accepted the project.
    const f = await fixture(t, {
      epics: ['e1'],
      tasks: [task('alpha')],
      configure: withoutCommands,
      files: { 'package.json': npmManifest },
    });
    const result = await createProjectDirector({ repo: f.repo, engine: f.engine }).drain(f.id);
    assert.notEqual(result.status, 'accepted', JSON.stringify(result));
    const snapshot = f.repo.snapshot(f.id);
    assert.notEqual(snapshot.project.status, 'accepted');
    assert.ok(!['integrated', 'accepted'].includes(snapshot.tasks[0].status), snapshot.tasks[0].status);
    const [run] = f.taskRuns();
    assert.deepEqual(run.config.commands.test, [{ command: 'npm', args: ['test'] }]);
    assert.equal(run.checks.complete, false, 'no green receipt for zero passed tests');
    const [row] = run.checks.results;
    assert.deepEqual(
      [row.command, row.args, row.exitCode, row.count.resolved, row.count.exitCode, row.count.tests],
      ['npm', ['test'], 0, { script: 'test', text: 'node --test' }, 0, 0],
    );
  },
);

test(
  'A task Run of the default npm test counts its node --test, and its validator binds the script of its head',
  { timeout: 900000 },
  async t => {
    const f = await fixture(t, {
      epics: ['e1'],
      tasks: [task('alpha')],
      configure: withoutCommands,
      files: {
        'package.json': npmManifest,
        'base.test.mjs': ["import test from 'node:test';", "test('base', () => {});", ''].join('\n'),
      },
    });
    const result = await createProjectDirector({ repo: f.repo, engine: f.engine }).drain(f.id);
    assert.equal(result.status, 'accepted', JSON.stringify(result));
    const [run] = f.taskRuns();
    const [row] = run.checks.results;
    assert.deepEqual(
      [row.command, row.args, row.exitCode, row.countVersion, row.count.resolved, row.count.tests],
      ['npm', ['test'], 0, TEST_COUNT_VERSION, { script: 'test', text: 'node --test' }, 1],
    );
    const gate = f.store.getRun(f.repo.snapshot(f.id).gates[0].runId);
    assert.deepEqual(
      [gate.checks.results[0].count.resolved, gate.checks.results[0].count.tests],
      [row.count.resolved, 1],
    );
    await authorizeTask(f, run);
    for (const change of [
      { count: { ...row.count, resolved: { script: 'test', text: 'node --test base.test.mjs' } } },
      { count: { ...row.count, tests: 0 } },
      { count: undefined },
      { resolved: row.count.resolved },
    ]) {
      const results = run.checks.results.map((item, index) => (index ? item : { ...item, ...change }));
      f.store.updateRun(run.id, { checks: { ...run.checks, results } });
      await assert.rejects(
        () => authorizeTask(f, f.store.getRun(run.id)),
        { code: 'project_fast_tests_uncounted' },
        JSON.stringify(change),
      );
    }
    f.store.updateRun(run.id, { checks: run.checks });
    await authorizeTask(f, f.store.getRun(run.id));
  },
);

test(
  'apply-spec -> drain accepts a project whose tests need npm: the npm exit code decides when the counting run fails',
  { timeout: 900000 },
  async t => {
    // Review finding (Windows, Node 24.19.0): a test using `npm_package_version` passed through npm but
    // failed when Kodo replaced `npm test` by Node. npm decides now; the counting run only adds evidence.
    const f = await fixture(t, {
      epics: ['e1'],
      tasks: [task('alpha')],
      configure: withoutCommands,
      files: {
        'package.json': JSON.stringify({
          name: 'wave',
          version: '7.7.7-kodo',
          private: true,
          scripts: { test: 'node --test' },
        }),
        'version.test.mjs': [
          "import test from 'node:test';",
          "import assert from 'node:assert/strict';",
          "test('npm sets the version', () => assert.equal(process.env.npm_package_version, '7.7.7-kodo'));",
          '',
        ].join('\n'),
      },
    });
    const result = await createProjectDirector({ repo: f.repo, engine: f.engine }).drain(f.id);
    assert.equal(result.status, 'accepted', JSON.stringify(result));
    const [run] = f.taskRuns();
    const gate = f.store.getRun(f.repo.snapshot(f.id).gates[0].runId);
    for (const row of [run.checks.results[0], gate.checks.results[0]])
      assert.deepEqual(
        [row.exitCode, row.count.resolved, row.count.exitCode, row.count.tests],
        [0, { script: 'test', text: 'node --test' }, 1, null],
      );
    await authorizeTask(f, run);
    await authorizeByGate(f, gate);
    // A forged count still is no proof: the log's counting run exited 1 and recounts to nothing.
    const results = gate.checks.results.map((item, index) =>
      index ? item : { ...item, count: { ...item.count, exitCode: 0, tests: 1 } },
    );
    f.store.updateRun(gate.id, { checks: { ...gate.checks, results } });
    await assert.rejects(() => authorizeByGate(f, f.store.getRun(gate.id)), {
      code: 'project_gate_tests_uncounted',
    });
  },
);

test(
  'complete-task after a crash between integration and its record reports a merge that left the branch',
  { timeout: 900000 },
  async t => {
    // Review finding (major): the write of externalCompletion failed after attempt and task reached
    // `integrated`; after the branch was reset, the repeat answered exit 0 `integrated`.
    const f = await fixture(t, { epics: ['e1'], tasks: [task('alpha')] });
    const [brief] = (await f.cli(['next-wave', f.id, '--host', 't3'])).report.result.briefs;
    await writeFile(path.join(brief.worktree, 'alpha.txt'), 'alpha\n');
    git(brief.worktree, 'add', '-A');
    git(brief.worktree, 'commit', '-m', 'Implement alpha');
    const head = git(brief.worktree, 'rev-parse', 'HEAD');
    const complete = ['complete-task', f.id, 'alpha', '--head', head, '--defer-gate'];
    const updateRun = f.store.updateRun;
    let injected = false;
    f.store.updateRun = function (id, patch, ...rest) {
      if (!injected && patch?.externalCompletion) {
        injected = true;
        throw Object.assign(new Error('Injected crash before the completion record'), { code: 'injected_crash' });
      }
      return updateRun.call(this, id, patch, ...rest);
    };
    t.after(() => delete f.store.updateRun);
    const crashed = await f.cli(complete);
    assert.equal(injected, true);
    assert.equal(crashed.exitCode, 2, crashed.output);
    delete f.store.updateRun;
    const snapshot = f.repo.snapshot(f.id);
    assert.deepEqual([snapshot.currentAttempts[0].status, snapshot.tasks[0].status], ['integrated', 'integrated']);
    const { integration, externalCompletion } = f.store.getRun(brief.runId);
    assert.equal(externalCompletion, undefined, 'the completion was never recorded');
    // The merge leaves the branch (a manual reset of the integration worktree).
    const block = git(f.root, 'worktree', 'list', '--porcelain')
      .split(/\r?\n\r?\n/)
      .find(row => row.includes(`branch refs/heads/kodo/project/${f.id}`));
    git(/^worktree (.+)$/m.exec(block)[1], 'reset', '-q', '--hard', integration.before);
    const late = await f.cli(complete);
    assert.deepEqual(
      [late.exitCode, late.report.result.status, late.report.result.code],
      [2, 'blocked', 'project_integration_missing'],
      late.output,
    );
  },
);

test(
  'A standalone epic gate lets the T3 host submit and reserve siblings during review',
  { timeout: 900000 },
  async t => {
    const observed = [];
    let betaHead;
    const hooks = { onReview: undefined };
    const f = await fixture(t, {
      epics: ['e1', 'e2'],
      tasks: [task('alpha'), task('beta', { epicId: 'e2' }), task('gamma', { epicId: 'e2' })],
      hooks,
    });
    const submit = (brief, head) =>
      f.cli(['complete-task', f.id, brief.taskId, '--head', head, '--attempt', brief.attemptId, '--defer-gate']);
    const [alpha, beta] = (await f.cli(['next-wave', f.id, '--host', 't3', '--limit', '2'])).report.result.briefs;
    for (const brief of [alpha, beta]) {
      await writeFile(path.join(brief.worktree, brief.taskId + '.txt'), brief.taskId);
      git(brief.worktree, 'add', '-A');
      git(brief.worktree, 'commit', '-m', 'Implement ' + brief.taskId);
      const head = git(brief.worktree, 'rev-parse', 'HEAD');
      if (brief === alpha) assert.equal((await submit(alpha, head)).report.result.status, 'integrated');
      else betaHead = head;
    }
    assert.equal(f.repo.snapshot(f.id).gates.length, 0);
    assert.ok(!f.repo.snapshot(f.id).currentAttempts.some(row => row.taskId === 'gamma'));
    hooks.onReview = async () => {
      if (!observed.length) {
        observed.push((await f.cli(['next-wave', f.id, '--host', 't3'])).report.result);
        observed.push((await submit(beta, betaHead)).report.result);
        observed.push((await f.cli(['gates', f.id])).report.result);
        observed.push((await f.cli(['drain', f.id])).report.result);
        observed.push((await f.cli(['complete-task', f.id, 'beta', '--head', betaHead])).report.result);
        const gamma = observed[0].briefs.find(row => row.taskId === 'gamma');
        observed.push((await submit(gamma, await editWorker(gamma, 'gamma.txt', 'gamma'))).report.result);
      }
    };
    const gated = await f.cli(['gates', f.id]);
    assert.deepEqual(
      observed[0]?.briefs?.map(brief => brief.taskId),
      ['beta', 'gamma'],
      JSON.stringify(observed),
    );
    assert.equal(observed[1].status, 'integrated');
    assert.deepEqual(
      observed.slice(2, 5).map(row => row.code),
      Array(3).fill('project_busy'),
    );
    assert.equal(observed[5].status, 'integrated');
    assert.equal(gated.report.result.status, 'passed', gated.output);
    assert.equal(f.repo.snapshot(f.id).project.status, 'accepted');
  },
);

async function editWorker(brief, file, content) {
  await writeFile(path.join(brief.worktree, file), content);
  git(brief.worktree, 'add', '-A');
  git(brief.worktree, 'commit', '-m', 'Implement ' + brief.taskId);
  return git(brief.worktree, 'rev-parse', 'HEAD');
}

for (const scenario of ['conflict', 'pause']) {
  test('Gate repair merge-back handles ' + scenario + ' during review', { timeout: 900000 }, async t => {
    let reviews = 0;
    const hooks = {
      onRepair: request => writeFile(path.join(request.cwd, 'shared.txt'), 'repair\n'),
      onReview: async request => {
        if (++reviews === 1)
          return {
            passed: true,
            findings: [],
            ...confirmedCriteria(request.schema, { unmet: ['task:alpha:alpha-proof'] }),
          };
        if (reviews !== 2) return;
        if (scenario === 'pause') {
          await f.repo.apply(f.command(f.repo.snapshot(f.id), { op: 'setPaused', paused: true }));
          return;
        }
        const [beta] = (await f.cli(['next-wave', f.id, '--host', 't3'])).report.result.briefs;
        assert.equal(beta.taskId, 'beta');
        assert.equal((await submit(beta, 'sibling\n')).report.result.status, 'integrated');
      },
    };
    const f = await fixture(t, {
      epics: ['e1', 'e2'],
      tasks: [
        task('alpha', { writePaths: ['shared.txt'] }),
        task('beta', { epicId: 'e2', dependsOn: ['alpha'], writePaths: ['shared.txt'] }),
      ],
      hooks,
    });
    const submit = async (brief, text) =>
      f.cli([
        'complete-task',
        f.id,
        brief.taskId,
        '--head',
        await editWorker(brief, 'shared.txt', text),
        '--attempt',
        brief.attemptId,
        '--defer-gate',
      ]);
    const [alpha] = (await f.cli(['next-wave', f.id, '--host', 't3'])).report.result.briefs;
    assert.equal((await submit(alpha, 'initial\n')).report.result.status, 'integrated');
    const firstHead = f.branchHead();
    const stopped = await f.cli(['gates', f.id]);
    assert.equal(stopped.report.result.status, 'blocked', stopped.output);
    const snapshot = f.repo.snapshot(f.id);
    const gate = f.store.getRun(snapshot.gates[0].runId);
    assert.notEqual(gate.headSha, firstHead, 'the verified repair changed the head');
    if (scenario === 'pause') {
      assert.equal(stopped.report.result.code, 'project_control_blocked');
      assert.equal(f.branchHead(), firstHead, 'no repair enters the paused project');
      assert.equal(gate.state, 'succeeded', 'the verified run can be accepted on resume');
      return;
    }
    const siblingHead = f.branchHead();
    assert.equal(git(f.root, 'show', siblingHead + ':shared.txt'), 'sibling');
    assert.deepEqual([gate.state, gate.error?.code], ['blocked', 'project_integration_conflict']);
    assert.ok(gate.error.message);
    const report = buildProjectReport(snapshot, { [gate.id]: gate }, {});
    assert.ok(report.blockers.some(row => row.runId === gate.id && row.code === 'project_integration_conflict'));
    assert.equal((await f.cli(['gates', f.id])).report.result.status, 'blocked');
    assert.equal(f.repo.snapshot(f.id).gates.length, 1);
    const retry = await f.cli(['gates', f.id, '--retry-failed']);
    assert.equal(retry.report.result.status, 'passed', retry.output);
    const after = f.repo.snapshot(f.id);
    const replacement = after.gates.find(row => row.containers[0].id === 'e1' && row.runId !== gate.id);
    assert.ok(replacement);
    assert.equal(replacement.headSha, siblingHead);
    assert.equal(after.project.status, 'accepted');
  });
}

test(
  'Missing milestone delivery proof stays visible and an explicit retry verifies a new gate',
  { timeout: 900000 },
  async t => {
    const f = await fixture(t, {
      epics: ['e1'],
      tasks: [task('alpha')],
      milestoneAcceptance: { ...proof('delivery-proof'), evidenceKinds: ['delivery'] },
    });
    const [brief] = (await f.cli(['next-wave', f.id, '--host', 't3'])).report.result.briefs;
    const head = await editWorker(brief, 'alpha.txt', 'alpha');
    assert.equal(
      (await f.cli(['complete-task', f.id, 'alpha', '--head', head, '--defer-gate'])).report.result.status,
      'integrated',
    );
    const pass = async (...flags) => {
      const result = await f.cli(['gates', f.id, ...flags]);
      assert.equal(result.exitCode, 2, result.output);
      assert.equal(result.report.result.status, 'blocked', result.output);
      return result.report.result.gates;
    };
    const first = await pass();
    assert.ok(first.blocked.some(row => row.code === 'wave_gate_proof_missing' && row.id === 'm1'));
    const snapshot = f.repo.snapshot(f.id);
    const initial = snapshot.gates[0];
    const run = f.store.getRun(initial.runId);
    assert.deepEqual([run.state, run.error?.code], ['blocked', 'wave_gate_proof_missing']);
    assert.ok(run.error.message);
    assert.deepEqual(first.gates, [{ gateId: initial.id, runId: run.id, state: 'blocked' }]);
    const report = buildProjectReport(snapshot, { [run.id]: run }, {});
    assert.ok(report.blockers.some(row => row.runId === run.id && row.code === run.error.code));
    const reviews = f.calls.review;
    assert.deepEqual((await pass()).gates, first.gates);
    assert.equal(f.calls.review, reviews);
    assert.equal(f.repo.snapshot(f.id).gates.length, 1);
    // An accepted epic may only anchor a retry of its original unfinished chain.
    const reserve = {
      op: 'reserveGate',
      containers: initial.containers,
      baseSha: initial.baseSha,
      headSha: initial.headSha,
      merges: initial.merges,
      retry: false,
    };
    await assert.rejects(f.repo.apply(f.command(snapshot, reserve)), { code: 'project_gate_exists' });
    await assert.rejects(
      f.repo.apply(f.command(snapshot, { ...reserve, containers: initial.containers.slice(0, 2), retry: true })),
      { code: 'project_gate_invalid' },
    );
    const retry = await pass('--retry-failed');
    assert.equal(retry.gates.length, 1);
    const replacement = retry.gates[0];
    assert.notEqual(replacement.gateId, initial.id);
    assert.notEqual(replacement.runId, run.id);
    assert.equal(f.store.getRun(replacement.runId).error.code, run.error.code);
    assert.equal(f.repo.snapshot(f.id).gates.length, 2);
    assert.ok(f.calls.review > reviews);
  },
);

test(
  'Evidence integrity refusal after verification retries with fresh proof and accepts the project',
  { timeout: 900000 },
  async t => {
    const f = await fixture(t, { epics: ['e1'], tasks: [task('alpha')] });
    const [brief] = (await f.cli(['next-wave', f.id, '--host', 't3'])).report.result.briefs;
    const head = await editWorker(brief, 'alpha.txt', 'alpha');
    assert.equal(
      (await f.cli(['complete-task', f.id, 'alpha', '--head', head, '--defer-gate'])).report.result.status,
      'integrated',
    );
    const original = f.engine.persistEvidence.bind(f.engine);
    f.engine.persistEvidence = (run, kind, ...args) => {
      if (run.directorBinding?.kind === 'gate' && kind === 'project-acceptance') {
        delete f.engine.persistEvidence;
        throw Object.assign(new Error('Fixture: immutable proof content mismatched'), { code: 'evidence_integrity' });
      }
      return original(run, kind, ...args);
    };
    const stopped = await f.cli(['gates', f.id]);
    assert.equal(stopped.exitCode, 2);
    const gate = f.repo.snapshot(f.id).gates[0];
    const run = f.store.getRun(gate.runId);
    assert.deepEqual([run.state, run.error?.code], ['blocked', 'evidence_integrity']);
    assert.equal(stopped.report.result.gates.blocked[0].code, run.error.code);
    const retry = await f.cli(['gates', f.id, '--retry-failed']);
    assert.equal(retry.exitCode, 0, retry.output);
    const after = f.repo.snapshot(f.id);
    assert.equal(after.project.status, 'accepted');
    assert.equal(after.gates.length, 2);
    assert.notEqual(after.gates[1].runId, run.id);
  },
);
