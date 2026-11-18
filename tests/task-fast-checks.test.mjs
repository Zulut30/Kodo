import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Engine } from '../runtime/engine.mjs';
import { Store } from '../runtime/store.mjs';
import { contentHash } from '../runtime/engine-core.mjs';
import { makeWorktree, diffHash } from '../runtime/workspace.mjs';
import { execute } from '../runtime/command.mjs';
import * as A from '../runtime/project-contracts.mjs';
import * as D from '../runtime/project-evidence.mjs';
import { openProjectStore } from '../runtime/project-store.mjs';
import { createProjectDirector, createProjectTransitionAuthorizer } from '../runtime/project-director.mjs';
import { withIntegrationLease } from '../runtime/project-integration-lease.mjs';
import { TASK_FAST_PROFILE, passedTests, planFastChecks, runFastChecks } from '../runtime/task-fast-checks.mjs';
import { fixture, git } from './helpers/engine-fixture.mjs';

const nodeTest = { command: process.execPath, args: ['--test'] };
const testSource = (name, cases) =>
  "import test from 'node:test';\nimport assert from 'node:assert/strict';\n" +
  `import { ${name} } from '../src/${name}.mjs';\n` +
  cases.map(([title, body]) => `test('${title}', () => ${body});\n`).join('');
const aCases = [
  ['a is one', 'assert.equal(a, 1)'],
  ['a is a number', "assert.equal(typeof a, 'number')"],
];
const files = {
  'src/a.mjs': 'export const a = 1;\n',
  'src/b.mjs': 'export const b = 2;\n',
  'tests/a.test.mjs': testSource('a', aCases),
  'tests/b.test.mjs': testSource('b', [['b is two', 'assert.equal(b, 2)']]),
};
const write = async (cwd, changes) => {
  for (const [name, text] of Object.entries(changes)) {
    await mkdir(path.dirname(path.join(cwd, name)), { recursive: true });
    await writeFile(path.join(cwd, name), text);
  }
};
const log = async row => JSON.parse(await readFile(row.evidence.path, 'utf8'));
const legacyFingerprint = (run, headSha) =>
  contentHash({
    headSha,
    expected: ['test', 'build'].flatMap(kind => run.config.commands[kind].map(command => ({ kind, command }))),
    runtime: { node: process.version, abi: process.versions.modules, platform: process.platform, arch: process.arch },
  });

/** A Node project with two independent modules and their tests; the Run works in its own worktree. */
async function workspace(t, { commands = { test: [nodeTest], build: [], deploy: [], smoke: [] } } = {}) {
  // The default fixture script imports a missing file, which would make every graph broad.
  const fx = await fixture(t, { config: { commands }, testScript: 'process.exit(0);\n' });
  await write(fx.project, files);
  git(fx.project, 'add', '.');
  git(fx.project, 'commit', '-m', 'Two modules with tests');
  const store = fx.openStore(),
    engine = new Engine({ store });
  const run = await engine.create('Change module a', { project: fx.project });
  await makeWorktree(run.project, run.cwd, run.branch, run.baseSha);
  run.verificationProfile = TASK_FAST_PROFILE;
  engine.save(run);
  const commit = async changes => {
    await write(run.cwd, changes);
    git(run.cwd, 'add', '-A');
    git(run.cwd, 'commit', '-m', 'Task change');
    return git(run.cwd, 'rev-parse', 'HEAD');
  };
  return { fx, store, engine, run, commit };
}

test('Task-fast checks run only the affected test and a second pass on the same head hits the private cache', async t => {
  const { store, engine, run, commit } = await workspace(t);
  const headSha = await commit({ 'src/a.mjs': 'export const a = 1;\nexport const extra = true;\n' });
  const checks = await runFastChecks({ engine, run });
  assert.equal(checks.schemaVersion, 2);
  assert.equal(checks.profile, 'task-fast');
  assert.equal(checks.headSha, headSha);
  assert.equal(checks.complete, true);
  assert.equal(checks.plan.fallback, false, JSON.stringify(checks.plan.reasons));
  assert.deepEqual(checks.plan.changed, ['src/a.mjs']);
  assert.deepEqual(checks.plan.affected, ['src/a.mjs', 'tests/a.test.mjs']);
  assert.deepEqual(checks.plan.testFiles, ['tests/a.test.mjs']);
  assert.deepEqual(
    checks.results.map(row => [row.kind, row.command, row.args, row.exitCode]),
    [
      ['syntax', process.execPath, ['--check', 'src/a.mjs'], 0],
      ['syntax', process.execPath, ['--check', 'tests/a.test.mjs'], 0],
      ['test', process.execPath, ['--test', 'tests/a.test.mjs'], 0],
    ],
  );
  for (const row of checks.results) {
    assert.ok(Number.isFinite(row.durationMs) && row.durationMs >= 0);
    assert.equal(row.cached, undefined, 'the first pass executes every command');
    await engine.assertEvidence({ path: row.evidence.path, sha256: row.evidence.sha256, headSha });
    assert.equal(row.outputPath, row.evidence.path, 'blocker and review references keep working');
  }
  const output = (await log(checks.results[2])).value;
  assert.match(output.stdout, /a is one/);
  assert.doesNotMatch(output.stdout, /b is two/, 'the unrelated test file is not executed');
  assert.deepEqual(store.getRun(run.id).checks, checks, 'the receipt is saved with the Run');

  run.checks = null;
  engine.save(run);
  const second = await runFastChecks({ engine, run });
  const testRow = second.results.find(row => row.kind === 'test');
  assert.equal(testRow.cached, true, 'the exact clean head and command reuse the private receipt');
  assert.equal(testRow.exitCode, 0);
  assert.equal(testRow.evidence.path, checks.results[2].evidence.path, 'cached evidence is the original full log');
  assert.ok(
    second.results.filter(row => row.kind === 'syntax').every(row => row.cached === undefined),
    'syntax checks are cheap and always run',
  );
  assert.equal(second.complete, true);
});

test('Task-fast checks fall back to the full test command for config changes, unknown runners and untested code', async t => {
  const { engine, run, commit } = await workspace(t);
  const headSha = await commit({ 'vitest.config.mjs': 'export default {};\n' });
  const checks = await runFastChecks({ engine, run });
  assert.equal(checks.plan.fallback, true);
  assert.ok(checks.plan.reasons.includes('config-change:vitest.config.mjs'), JSON.stringify(checks.plan.reasons));
  assert.deepEqual(
    checks.results.map(row => [row.kind, row.command, row.args, row.exitCode, row.cached]),
    [['test', process.execPath, ['--test'], 0, undefined]],
  );
  const output = (await log(checks.results[0])).value.stdout;
  assert.match(output, /a is one/);
  assert.match(output, /b is two/, 'the full configured suite ran');

  const custom = {
    ...run,
    config: {
      ...run.config,
      commands: { ...run.config.commands, test: [{ command: process.execPath, args: ['verify.mjs'] }] },
    },
  };
  const other = await planFastChecks({ run: custom, cwd: run.cwd, baseSha: run.baseSha, headSha });
  assert.equal(other.fallback, true);
  assert.ok(other.reasons.includes('runner-not-node-test'));
  assert.deepEqual(
    other.commands.map(row => [row.kind, row.args]),
    [['test', ['verify.mjs']]],
  );

  const untested = await commit({ 'src/value.mjs': 'export const value = 3;\n' });
  const plan = await planFastChecks({ run, cwd: run.cwd, baseSha: headSha, headSha: untested });
  assert.equal(plan.fallback, true);
  assert.deepEqual(plan.reasons, ['no-affected-tests']);
  assert.deepEqual(
    plan.commands.map(row => [row.kind, row.args]),
    [['test', ['--test']]],
  );
});

test('Task-fast checks keep the behaviour gate: a removed test case blocks the change', async t => {
  const { engine, run, commit } = await workspace(t);
  await commit({ 'tests/a.test.mjs': testSource('a', aCases.slice(0, 1)) });
  const checks = await runFastChecks({ engine, run });
  assert.equal(checks.complete, true, 'the remaining test still passes');
  assert.deepEqual(checks.plan.testFiles, ['tests/a.test.mjs']);
  await assert.rejects(() => engine.behaviorGate(run), { code: 'behavior_failed' });
  assert.equal(run.behavior.passed, false);
  assert.ok(
    run.behavior.findings.some(row => row.rule === 'tests_removed' && /a is a number/.test(row.detail)),
    JSON.stringify(run.behavior.findings),
  );
});

test('Task-fast checks stop a hanging command at the hard timeout with an explicit code', async t => {
  const { engine, run, commit } = await workspace(t);
  await commit({
    'tests/slow.test.mjs':
      "import test from 'node:test';\ntest('waits', () => new Promise(resolve => setTimeout(resolve, 120000)));\n",
  });
  run.fastChecks = { timeoutMs: 5000 };
  engine.save(run);
  await assert.rejects(() => runFastChecks({ engine, run }), { code: 'fast_check_timeout' });
  assert.equal(run.checks.complete, false);
  const last = run.checks.results.at(-1);
  assert.deepEqual(
    [last.kind, last.args, last.exitCode, last.reason],
    ['test', ['--test', 'tests/slow.test.mjs'], null, 'timeout'],
  );
  assert.equal((await log(last)).kind, 'fast-check', 'the stopped command keeps its evidence');
  run.fastChecks = { timeoutMs: 0 };
  await assert.rejects(() => runFastChecks({ engine, run }), { code: 'configuration' });
});

test('Legacy Engine check reuse rejects task-fast and forged task-fast receipts', async t => {
  const { store, engine, run, commit } = await workspace(t);
  const headSha = await commit({ 'vitest.config.mjs': 'export default {};\n' });
  const fast = await runFastChecks({ engine, run });
  assert.equal(fast.plan.fallback, true, 'the fast plan runs exactly the configured commands');
  // Everything the old predicate looked at matches; only the profile says this is not a full receipt.
  const forged = {
    ...fast,
    fingerprint: legacyFingerprint(run, headSha),
    results: fast.results.map(row => ({
      kind: 'test',
      command: nodeTest,
      exitCode: 0,
      outputPath: row.outputPath,
      outputHash: row.outputHash,
    })),
  };
  for (const receipt of [fast, forged]) {
    run.checks = receipt;
    engine.save(run);
    const before = store.events(run.id).length;
    await engine.checks(run);
    const events = store
      .events(run.id)
      .slice(before)
      .map(row => row.type);
    assert.ok(!events.includes('checks_reused'), 'a task-fast receipt never stands in for the full checks');
    assert.ok(events.includes('check_started'));
    assert.equal(run.checks.profile, undefined);
    assert.equal(run.checks.fingerprint, legacyFingerprint(run, headSha));
    assert.deepEqual(
      run.checks.results.map(row => row.command),
      [nodeTest],
    );
  }
  const before = store.events(run.id).length;
  await engine.checks(run);
  assert.ok(
    store
      .events(run.id)
      .slice(before)
      .some(row => row.type === 'checks_reused'),
    'the genuine full receipt is still reused',
  );
});

/** The project director fixture, reduced to one trusted task (see tests/project-director.test.mjs). */
async function directorFixture(t, { wave = false } = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'kodo-fast-director-'));
  const root = path.join(directory, 'repo'),
    home = path.join(directory, 'state'),
    isolated = path.join(directory, 'empty-home');
  await mkdir(root);
  await mkdir(isolated);
  await writeFile(path.join(isolated, 'gitconfig'), '');
  const environment = {
    HOME: isolated,
    USERPROFILE: isolated,
    KODO_HOME: home,
    KODO_CREDENTIAL_HOME: path.join(isolated, 'empty-credentials'),
    KODO_WORKTREE_HOME: path.join(directory, 'worktrees'),
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: path.join(isolated, 'gitconfig'),
    GIT_TERMINAL_PROMPT: '0',
  };
  const previous = Object.fromEntries(Object.keys(environment).map(key => [key, process.env[key]]));
  Object.assign(process.env, environment);
  const stores = new Set();
  t.after(async () => {
    for (const store of stores) store.close();
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    assert.equal(path.dirname(directory), path.resolve(os.tmpdir()));
    assert.match(path.basename(directory), /^kodo-fast-director-/);
    await rm(directory, { recursive: true, force: true });
  });
  const config = {
    schemaVersion: 1,
    client: 'codex',
    executionMode: 'quick',
    maxTasks: 1,
    concurrency: 1,
    researchBudget: 0,
    repairRounds: 1,
    commands: { test: [{ command: process.execPath, args: ['check.mjs'] }], build: [], deploy: [], smoke: [] },
    delivery: { enabled: false, release: false },
    uiVerification: { enabled: false },
    security: { enabled: false },
    architecture: { enabled: false },
  };
  await writeFile(path.join(root, 'kodo.config.json'), JSON.stringify(config));
  await writeFile(
    path.join(root, 'check.mjs'),
    "import {existsSync} from 'node:fs'; import assert from 'node:assert/strict'; assert.ok(existsSync('first.txt'));\n",
  );
  for (const args of [
    ['init', '-b', 'main'],
    ['config', 'user.name', 'Owned Fast Director'],
    ['config', 'user.email', 'fast-director@example.invalid'],
    ['config', 'core.autocrlf', 'false'],
    ['config', 'commit.gpgSign', 'false'],
    ['add', '.'],
    ['commit', '-m', 'Owned fixture baseline'],
  ])
    await execute('git', args, { cwd: root, env: { ...process.env, ...environment } });
  const store = new Store(home, {});
  stores.add(store);
  const engine = new Engine({ store, secrets: {}, leaseHeartbeatMs: 10 });
  const contract = await engine.persistEvidence(
    { artifacts: path.join(home, 'interfaces') },
    'interface',
    { taskBoundary: 'Owned assigned file' },
    { headSha: null },
  );
  const proof = id => ({ id, text: 'The assigned file exists and passes its check.', evidenceKinds: ['acceptance'] });
  const authorizer = createProjectTransitionAuthorizer({ store, engine, contracts: A, evaluator: D });
  const repo = await openProjectStore({ store, contracts: A, authorizeTransition: authorizer });
  const c = (snapshot, action) => ({
    schemaVersion: 1,
    projectId: snapshot?.project.projectId ?? null,
    expectedRevision: snapshot?.revision ?? null,
    commandId: randomUUID(),
    actor: 'owned-test',
    reason: 'Observe the public requirement',
    action,
  });
  const created = await repo.apply(
    c(null, {
      op: 'create',
      spec: {
        schemaVersion: 1,
        id: 'owned',
        root,
        title: 'Owned fast director',
        definitionOfDone: [proof('project-proof')],
        constraints: ['Only assigned paths.'],
        businessContext: 'Subscription-free fixture.',
        architectureRefs: [],
        milestones: [
          { id: 'milestone', title: 'Milestone', acceptance: [proof('milestone-proof')], releaseRequired: false },
        ],
        epics: [{ id: 'epic', milestoneId: 'milestone', title: 'Epic', acceptance: [proof('epic-proof')] }],
        tasks: [
          {
            id: 'first',
            epicId: 'epic',
            title: 'first',
            description: 'Implement first.',
            owner: 'developer',
            dependsOn: [],
            writePaths: ['first.txt'],
            acceptance: [proof('first-proof')],
            interfaceRefs: [
              { kind: 'interface', runId: null, headSha: null, path: contract.path, sha256: contract.sha256 },
            ],
            priority: 50,
            userValue: 1,
            risk: 1,
            estimatedEffort: 1,
            riskApprovalRequired: false,
          },
        ],
        ...(wave ? { execution: { cadence: 'wave', integration: 'branch' } } : {}),
      },
    }),
  );
  const id = created.projectId;
  await repo.apply(
    c(repo.snapshot(id), { op: 'transition', kind: 'task', id: 'first', to: 'ready', evidence: [], mappings: [] }),
  );
  return { store, engine, repo, id, c, authorizer, director: createProjectDirector({ repo, engine }) };
}

// A fully checked and independently reviewed task Run, as the legacy Engine leaves it.
const verifiedRunner = f => async runId => {
  const run = f.store.getRun(runId);
  await makeWorktree(run.project, run.cwd, run.branch, run.baseSha);
  await writeFile(path.join(run.cwd, 'first.txt'), 'accepted dependency\n');
  await git(run.cwd, 'add', 'first.txt');
  await git(run.cwd, 'commit', '-m', 'Owned first');
  run.headSha = git(run.cwd, 'rev-parse', 'HEAD');
  run.plan = {
    summary: 'One scoped fixture change',
    tasks: [
      {
        id: 'implementation',
        role: 'developer',
        description: 'Owned file',
        writePaths: ['first.txt'],
        dependsOn: [],
        acceptance: ['Independent file check passes'],
        parallel: false,
      },
    ],
  };
  run.nodes = { implementation: { status: 'integrated' } };
  run.completed.implementation = true;
  await f.engine.checks(run);
  run.review = {
    passed: true,
    findings: [],
    sessionId: 'owned-independent-review',
    headSha: run.headSha,
    diffHash: await diffHash(run.cwd, run.baseSha),
  };
  run.state = 'succeeded';
  f.engine.save(run);
  return run;
};

test('Project director acceptance rejects task-fast and forged task-fast receipts', async t => {
  const f = await directorFixture(t);
  f.engine.run = verifiedRunner(f);
  await f.director.run(f.id);
  const snapshot = f.repo.snapshot(f.id),
    stored = f.store.getRun(snapshot.currentAttempts[0].runId);
  const refs = snapshot.tasks[0].evidence,
    mappings = snapshot.tasks[0].mappings;
  snapshot.tasks[0].status = 'integrated';
  snapshot.currentAttempts[0].status = 'integrated';
  const command = f.c(snapshot, {
    op: 'transition',
    kind: 'task',
    id: 'first',
    to: 'accepted',
    evidence: refs,
    mappings,
  });
  await f.authorizer({ command, snapshot });

  const fast = await runFastChecks({ engine: f.engine, run: stored });
  assert.equal(fast.plan.fallback, true, 'a non-JS change runs the full configured command');
  assert.deepEqual(
    fast.results.map(row => [row.command, row.args, row.exitCode]),
    [[process.execPath, ['check.mjs'], 0]],
  );
  await assert.rejects(() => f.authorizer({ command, snapshot }), { code: 'project_transition_blocked' });

  const forged = {
    ...fast,
    fingerprint: legacyFingerprint(stored, stored.headSha),
    results: fast.results.map(row => ({
      kind: 'test',
      command: stored.config.commands.test[0],
      exitCode: 0,
      outputPath: row.outputPath,
      outputHash: row.outputHash,
    })),
  };
  stored.checks = forged;
  f.engine.save(stored);
  await assert.rejects(() => f.authorizer({ command, snapshot }), { code: 'project_transition_blocked' });

  await f.engine.checks(stored);
  stored.state = 'succeeded';
  f.engine.save(stored);
  await f.authorizer({ command, snapshot });
});

test('Full validators reject a profiled receipt even with full logs and the legacy fingerprint', async t => {
  const f = await directorFixture(t);
  f.engine.run = verifiedRunner(f);
  await f.director.run(f.id);
  const snapshot = f.repo.snapshot(f.id),
    full = f.store.getRun(snapshot.currentAttempts[0].runId);
  snapshot.tasks[0].status = 'integrated';
  snapshot.currentAttempts[0].status = 'integrated';
  const command = f.c(snapshot, {
    op: 'transition',
    kind: 'task',
    id: 'first',
    to: 'accepted',
    evidence: snapshot.tasks[0].evidence,
    mappings: snapshot.tasks[0].mappings,
  });
  const evaluate = run =>
    D.evaluateProjectTransition(
      { command, snapshot, run },
      { contracts: A, knownValues: [], verifyRef: async () => {}, validateRun: async () => {} },
    );
  await f.authorizer({ command, snapshot });
  assert.ok((await evaluate(full)).eligibleStates.includes('accepted'), 'the unprofiled full receipt still accepts');
  for (const [label, profiled] of [
    ['task-fast marker', { ...full, checks: { ...full.checks, profile: 'task-fast' } }],
    ['any marker', { ...full, checks: { ...full.checks, profile: null } }],
    ['profiled Run', { ...full, verificationProfile: 'task-fast' }],
  ]) {
    // The pure evaluator alone already refuses it...
    assert.ok(!(await evaluate(profiled)).eligibleStates.includes('accepted'), label);
    // ...and so does the trusted validateRun of the production authorizer.
    f.store.updateRun(full.id, profiled);
    await assert.rejects(() => f.authorizer({ command, snapshot }), { code: 'project_transition_blocked' }, label);
  }
});

test('A wave project is never run by the legacy director nor accepted by its own task Run', async t => {
  const f = await directorFixture(t, { wave: true });
  f.engine.run = verifiedRunner(f);
  // `resume` of a wave project is a one-wave drain (tests/project-wave-director.test.mjs).
  await assert.rejects(() => f.director.run(f.id), { code: 'project_wave_drain_required' });
  let snapshot = f.repo.snapshot(f.id);
  assert.equal(snapshot.currentAttempts.length, 0, 'no task Run was started');

  // The review scenario: a fully checked and reviewed task Run of its own, no gate at all.
  snapshot = f.repo.snapshot(f.id);
  await f.repo.apply(f.c(snapshot, { op: 'reserveAttempt', taskId: 'first', retryFailed: false }));
  snapshot = f.repo.snapshot(f.id);
  const [attempt] = snapshot.currentAttempts,
    [task] = snapshot.tasks;
  const reserved = await f.engine.createReserved(
    A.buildDirectorTaskInput({ project: snapshot.project, task }, { knownValues: [] }),
    { project: snapshot.project.root, providers: 'current' },
    {
      binding: {
        schemaVersion: 1,
        projectId: attempt.projectId,
        taskId: attempt.taskId,
        taskRevision: attempt.taskRevision,
        attemptId: attempt.id,
        runId: attempt.runId,
        contractHash: attempt.contractHash,
      },
      installRun: f.repo.installRun,
    },
  );
  const run = await verifiedRunner(f)(reserved.id);
  const refs = [];
  for (const [kind, value] of [
    ['acceptance', { directorBinding: run.directorBinding, task: run.task, checks: run.checks, review: run.review }],
    ['contract', { directorBinding: run.directorBinding, task: run.task }],
    ['checks', run.checks],
    ['review', run.review],
  ]) {
    const ref = await f.engine.persistEvidence(run, `project-${kind}`, value, { headSha: run.headSha });
    refs.push({ kind, runId: run.id, headSha: run.headSha, path: ref.path, sha256: ref.sha256 });
  }
  snapshot = f.repo.snapshot(f.id);
  assert.equal(snapshot.gates.length, 0);
  snapshot.tasks[0].status = 'integrated';
  snapshot.currentAttempts[0].status = 'integrated';
  const evidence = [...task.interfaceRefs, ...refs];
  const command = f.c(snapshot, {
    op: 'transition',
    kind: 'task',
    id: 'first',
    to: 'accepted',
    evidence,
    mappings: [
      {
        criterionId: 'first-proof',
        refs: [refs[0].sha256],
        actor: 'project-director',
        reason: 'Exact frozen task passed required checks and independent review',
      },
    ],
  });
  const legacy = await D.evaluateProjectTransition(
    { command, snapshot, run: f.store.getRun(run.id) },
    { contracts: A, knownValues: [], verifyRef: async () => {}, validateRun: async () => {} },
  );
  assert.ok(legacy.eligibleStates.includes('accepted'), 'the legacy evaluator would accept this proof');
  // The production authorizer routes the wave project to the wave evaluator: no gate, no acceptance.
  // Wave proof that reads the integration branch needs its lease, held until the commit.
  await assert.rejects(() => f.authorizer({ command, snapshot }), { code: 'project_integration_lease_required' });
  const leased = work => withIntegrationLease(f.store, f.id, work);
  await assert.rejects(
    () => leased(() => f.authorizer({ command, snapshot })),
    error => ['project_binding_invalid', 'project_transition_blocked'].includes(error.code),
  );
  // The full receipt of a task Run is not task-fast proof either: not even integrated.
  snapshot.tasks[0].status = 'verifying';
  snapshot.currentAttempts[0].status = 'verifying';
  const integrated = f.c(snapshot, {
    op: 'transition',
    kind: 'task',
    id: 'first',
    to: 'integrated',
    evidence,
    mappings: [],
  });
  await assert.rejects(() => leased(() => f.authorizer({ command: integrated, snapshot })), {
    code: 'project_transition_blocked',
  });
});

const summary = (mark, counts) =>
  ['tests', 'suites', 'pass', 'fail', 'cancelled', 'skipped', 'todo', 'duration_ms']
    .map(name => `${mark} ${name} ${counts[name] ?? 0}\n`)
    .join('');

test('passedTests counts passed tests without skip and todo from the final spec or TAP summary', () => {
  assert.equal(passedTests(summary('ℹ', { tests: 3, pass: 1, skipped: 1, todo: 1, duration_ms: 1.5 })), 1);
  assert.equal(passedTests(summary('ℹ', { tests: 1, todo: 1 })), 0, 'a todo test is not a passed test');
  assert.equal(passedTests(summary('ℹ', { tests: 2, skipped: 2 })), 0, 'a skipped test is not a passed test');
  assert.equal(passedTests(summary('#', { tests: 4, pass: 4 }).replaceAll('\n', '\r\n')), 4);
  assert.equal(passedTests(summary('ℹ', {})), 0);
  // Test output printed before the runner's own summary cannot replace it.
  assert.equal(
    passedTests(`# pass 77\n${summary('ℹ', { tests: 9, pass: 9 })}${summary('ℹ', { tests: 1, todo: 1 })}`),
    0,
  );
  assert.equal(passedTests(summary('ℹ', { tests: 2, pass: 1 })), null, 'an inconsistent summary is no summary');
  assert.equal(passedTests('ℹ tests 1\nℹ pass 1\n'), null, 'an incomplete summary is no summary');
  assert.equal(passedTests('ok 1 - a\n'), null);
});

test('Task-fast checks never accept todo or skipped tests as executed tests', async t => {
  const { store, engine, run, commit } = await workspace(t);
  // A narrowed run whose only test is a todo passes nothing: the full suite runs instead.
  await commit({ 'tests/a.test.mjs': "import test from 'node:test';\ntest.todo('a is planned');\n" });
  const todo = await runFastChecks({ engine, run });
  assert.equal(todo.complete, true);
  assert.equal(todo.plan.fallback, true);
  assert.deepEqual(todo.plan.reasons, ['no-tests-executed']);
  assert.deepEqual(
    todo.results.map(row => [row.kind, row.args, row.exitCode, row.tests]),
    [['test', ['--test'], 0, 1]],
    'the full run counts only the passing test of b',
  );
  // Every test is skipped or todo: neither the narrowed nor the full run passes a test.
  const skipped =
    "import test from 'node:test';\ntest.skip('skipped', () => {});\ntest('skipped at runtime', t => t.skip());\n";
  const headSha = await commit({ 'tests/a.test.mjs': skipped, 'tests/b.test.mjs': skipped });
  await assert.rejects(() => runFastChecks({ engine, run }), { code: 'fast_check_no_tests' });
  const saved = store.getRun(run.id).checks;
  assert.equal(saved.headSha, headSha);
  assert.equal(saved.complete, false, 'no green receipt for zero passed tests');
  assert.deepEqual(saved.plan.reasons, ['no-tests-executed']);
  assert.deepEqual(
    saved.results.map(row => [row.kind, row.args, row.exitCode, row.tests]),
    [['test', ['--test'], 0, 0]],
  );
  // A planned full fallback (a config change) that passes no test fails the same way.
  await commit({ 'vitest.config.mjs': 'export default {};\n' });
  await assert.rejects(() => runFastChecks({ engine, run }), { code: 'fast_check_no_tests' });
  assert.equal(run.checks.complete, false);
  assert.ok(
    run.checks.plan.reasons.includes('config-change:vitest.config.mjs'),
    JSON.stringify(run.checks.plan.reasons),
  );
  // One passing test beside skipped and todo ones is a green narrowed run.
  git(run.cwd, 'rm', '-q', 'vitest.config.mjs');
  await commit({
    'tests/a.test.mjs':
      "import test from 'node:test';\ntest.skip('skipped', () => {});\ntest.todo('planned');\ntest('a passes', () => {});\n",
    'tests/b.test.mjs': files['tests/b.test.mjs'],
  });
  const mixed = await runFastChecks({ engine, run });
  assert.equal(mixed.complete, true);
  assert.equal(mixed.plan.fallback, false, JSON.stringify(mixed.plan.reasons));
  assert.deepEqual(mixed.plan.testFiles, ['tests/a.test.mjs']);
  assert.equal(mixed.results.find(row => row.kind === 'test').tests, 1);
});

test('Task-fast full fallback counts every node --test command and leaves other runners as before', async t => {
  const twoRunners = [
    { command: process.execPath, args: ['--test', 'tests/a.test.mjs'] },
    { command: process.execPath, args: ['--test', 'tests/b.test.mjs'] },
  ];
  const { engine, run, commit } = await workspace(t, {
    commands: { test: twoRunners, build: [], deploy: [], smoke: [] },
  });
  await commit({ 'tests/a.test.mjs': "import test from 'node:test';\ntest.skip('a is skipped', () => {});\n" });
  // Two commands always fall back; together they passed b's test.
  const together = await runFastChecks({ engine, run });
  assert.equal(together.complete, true);
  assert.ok(together.plan.reasons.includes('runner-multiple-commands'), JSON.stringify(together.plan.reasons));
  assert.deepEqual(
    together.results.map(row => row.tests),
    [0, 1],
  );
  // Another runner's output is not counted (documented limitation): its exit code decides.
  run.config.commands.test = [{ command: process.execPath, args: ['verify.mjs'] }];
  engine.save(run);
  const other = await runFastChecks({ engine, run });
  assert.equal(other.complete, true);
  assert.ok(other.plan.reasons.includes('runner-not-node-test'), JSON.stringify(other.plan.reasons));
  assert.equal(other.results[0].tests, undefined);
  // A node --test command beside another runner is counted, but the zero total is not decisive.
  run.config.commands.test = [twoRunners[0], { command: process.execPath, args: ['verify.mjs'] }];
  engine.save(run);
  const mixedRunners = await runFastChecks({ engine, run });
  assert.equal(mixedRunners.complete, true);
  assert.deepEqual(
    mixedRunners.results.map(row => row.tests),
    [0, undefined],
  );
});

test('Task-fast checks never keep a green receipt for a narrowed run that executed no test', async t => {
  const { store, engine, run, commit } = await workspace(t);
  const headSha = await commit({
    'tests/a.test.mjs': "import test from 'node:test';\ntest.skip('a is skipped', () => {});\n",
  });
  // Options that select tests (or change the summary) are never narrowed.
  for (const [args, reason] of [
    [['--test', '--test-shard=2/2'], 'runner-selection'],
    [['--test', '--test-name-pattern=a is'], 'runner-selection'],
    [['--test', '--test-skip-pattern=a is'], 'runner-selection'],
    [['--test', '--test-only'], 'runner-selection'],
    [['--test', '--test-reporter=dot'], 'runner-reporter'],
    [['--test', '--test-reporter-destination=stdout'], 'runner-reporter'],
  ]) {
    const custom = {
      ...run,
      config: { ...run.config, commands: { ...run.config.commands, test: [{ command: process.execPath, args }] } },
    };
    const plan = await planFastChecks({ run: custom, cwd: run.cwd, baseSha: run.baseSha, headSha });
    assert.equal(plan.fallback, true, args.join(' '));
    assert.ok(plan.reasons.includes(reason), JSON.stringify(plan.reasons));
    assert.deepEqual(
      plan.commands.map(row => row.args),
      [args],
    );
  }
  // The affected test file only skips: the narrowed run executes nothing, so the full suite runs.
  const checks = await runFastChecks({ engine, run });
  assert.equal(checks.complete, true);
  assert.equal(checks.plan.fallback, true);
  assert.deepEqual(checks.plan.reasons, ['no-tests-executed']);
  assert.deepEqual(
    checks.results.map(row => [row.kind, row.args, row.exitCode]),
    [['test', ['--test'], 0]],
  );
  assert.match((await log(checks.results[0])).value.stdout, /b is two/, 'the full configured suite ran');
  assert.ok(store.events(run.id).some(row => row.type === 'fast_checks_no_tests'));
  // A narrowed run that executed tests records how many it executed.
  await commit({
    'tests/a.test.mjs': testSource('a', [...aCases, ['a is finite', 'assert.ok(Number.isFinite(a))']]),
  });
  const narrowed = await runFastChecks({ engine, run });
  assert.equal(narrowed.plan.fallback, false, JSON.stringify(narrowed.plan.reasons));
  assert.equal(narrowed.results.find(row => row.kind === 'test').tests, 3);
});

test('Task-fast checks count the tap and spec reporters and refuse a full run with an unknown summary', async t => {
  // Review finding (major): `node --test --test-reporter=tap` with one skipped test gave `# pass 0`
  // and still a complete receipt, and the project was accepted.
  const reporter = (...extra) => [{ command: process.execPath, args: ['--test', ...extra] }];
  const { store, engine, run, commit } = await workspace(t, {
    commands: { test: reporter('--test-reporter=tap'), build: [], deploy: [], smoke: [] },
  });
  const passing = testSource('a', [...aCases, ['a is finite', 'assert.ok(Number.isFinite(a))']]);
  // tap and spec summaries are countable: the narrowed run keeps the reporter and counts passed tests.
  await commit({ 'tests/a.test.mjs': passing });
  const narrowed = await runFastChecks({ engine, run });
  assert.equal(narrowed.plan.fallback, false, JSON.stringify(narrowed.plan.reasons));
  assert.deepEqual(narrowed.results.find(row => row.kind === 'test').args, [
    '--test',
    '--test-reporter=tap',
    'tests/a.test.mjs',
  ]);
  assert.equal(narrowed.results.find(row => row.kind === 'test').tests, 3);
  // Only skipped tests: the TAP summary confirms zero passed tests, never a green receipt.
  const skipped = "import test from 'node:test';\ntest.skip('skipped', () => {});\n";
  await commit({ 'tests/a.test.mjs': skipped, 'tests/b.test.mjs': skipped });
  await assert.rejects(() => runFastChecks({ engine, run }), { code: 'fast_check_no_tests' });
  assert.equal(store.getRun(run.id).checks.complete, false);
  assert.deepEqual(store.getRun(run.id).checks.plan.reasons, ['no-tests-executed'], 'the narrowed run passed none');
  assert.deepEqual(
    store.getRun(run.id).checks.results.map(row => [row.args, row.tests]),
    [[['--test', '--test-reporter=tap'], 0]],
  );
  // A reporter without a countable summary falls back to the full run, whose unknown outcome is refused.
  await commit({ 'tests/a.test.mjs': passing, 'tests/b.test.mjs': files['tests/b.test.mjs'] });
  for (const args of [['--test-reporter=dot'], ['--test-reporter=spec', '--test-reporter-destination=stdout']]) {
    run.config.commands.test = reporter(...args);
    engine.save(run);
    await assert.rejects(() => runFastChecks({ engine, run }), { code: 'fast_check_summary_unknown' }, args.join(' '));
    const saved = store.getRun(run.id).checks;
    assert.equal(saved.complete, false);
    assert.ok(saved.plan.reasons.includes('runner-reporter'), JSON.stringify(saved.plan.reasons));
    assert.deepEqual(
      saved.results.map(row => row.exitCode),
      [0],
      'the suite passed, but its count is unknown',
    );
  }
  // The spec reporter alone is countable again.
  run.config.commands.test = reporter('--test-reporter=spec');
  engine.save(run);
  const spec = await runFastChecks({ engine, run });
  assert.equal(spec.complete, true);
  assert.equal(spec.plan.fallback, false, JSON.stringify(spec.plan.reasons));
  assert.equal(spec.results.find(row => row.kind === 'test').tests, 3);
});
