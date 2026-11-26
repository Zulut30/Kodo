import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { buildProjectReport } from '../runtime/telemetry.mjs';
import { createProjectDirector } from '../runtime/project-director.mjs';
import { TEST_COUNT_VERSION } from '../runtime/task-fast-checks.mjs';
import { confirmedCriteria } from './helpers/gate-review.mjs';
import {
  proof,
  task,
  git,
  fixture,
  editConfig,
  authorizeByGate,
  defaultNpmTest,
  authorizeTask,
  withoutCommands,
  npmManifest,
  editWorker,
} from './helpers/wave-e2e-fixture.mjs';

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
