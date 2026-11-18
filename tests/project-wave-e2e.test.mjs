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
import { NATIVE_RESERVER, externalReserver } from '../runtime/project-director-waves.mjs';
import { projectCli } from '../runtime/project-cli.mjs';

// End to end without fake ports: the real Store, project store, production
// authorizer, Engine (fake subscription providers only), wave director, pull
// protocol and CLI over a temporary Git repository.
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
  const calls = { worker: [], repair: [], review: 0, active: 0, maxActive: 0 };
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
                writePaths: [`${id}.txt`],
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
        return { sessionId: `review-${calls.review}`, output: { passed: true, findings: [] } };
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
        await hooks.onWorker?.(id, calls);
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

async function fixture(t, { epics, tasks, hooks = {} }) {
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
    JSON.stringify({
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
  );
  await writeFile(path.join(root, 'check.mjs'), check);
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
    milestones: [{ id: 'm1', title: 'Milestone', acceptance: [proof('m1-proof')], releaseRequired: false }],
    epics: epics.map(id => ({ id, milestoneId: 'm1', title: `Epic ${id}`, acceptance: [proof(`${id}-proof`)] })),
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
  { timeout: 600000 },
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
  { timeout: 600000 },
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

test('drain --retry-failed never executes natively a task an external chat abandoned', { timeout: 600000 }, async t => {
  // F2 open question: the retry went to the drain, which re-ran the external task natively.
  const f = await fixture(t, { epics: ['e1'], tasks: [task('ext')] });
  const next = await f.cli(['next-wave', f.id, '--host', 't3']);
  assert.equal(next.exitCode, 0, next.output);
  const [brief] = next.report.result.briefs;
  const abandoned = await f.cli(['complete-task', f.id, 'ext', '--head', brief.baseSha, '--abandon']);
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

test('A reservation without a Run is resumed only by its own executor', { timeout: 600000 }, async t => {
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
