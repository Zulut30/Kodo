import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { runUIVerification } from '../runtime/ui-verification.mjs';
import { runSecurityChecks } from '../runtime/security-gates.mjs';
import { git, task, metrics, fixture } from './helpers/mode-engine-fixture.mjs';

test('Independent task routing separates parallel confidence from model uncertainty and sends the prepared graph', async t => {
  const fx = await fixture(t);
  const run = await fx.engine.create('Implement independent module contracts', { project: fx.project, mode: 'deep' });
  await fx.engine.prepare(run);
  run.models = await fx.provider.discoverProviders();
  run.plan = {
    summary: 'Two isolated module deliverables',
    tasks: [
      { ...task('first'), writePaths: ['first.mjs'], parallel: true },
      { ...task('second'), writePaths: ['second.mjs'], parallel: true },
    ],
  };
  const state = (run.nodes.first = { id: 'first', attempt: 0 });
  fx.engine.save(run);
  fx.provider.decideJev = async request => {
    assert.deepEqual(
      request.node.coordination.map(n => n.id),
      ['first', 'second'],
    );
    assert.deepEqual(
      request.node.coordination.map(n => n.writePaths),
      [['first.mjs'], ['second.mjs']],
    );
    return {
      model: 'sol',
      parallel: true,
      confidence: 0.1,
      modelConfidence: 0.2,
      parallelConfidence: 0.95,
      sessionConfidence: 0.1,
    };
  };
  const selected = await fx.engine.route(run, run.plan.tasks[0], state);
  assert.equal(selected.id, 'astra');
  assert.equal(state.routing.parallel, true);
  fx.provider.decideJev = async () => ({
    model: 'sol',
    parallel: true,
    confidence: 0.9,
    modelConfidence: 0.9,
    parallelConfidence: 0.2,
  });
  await fx.engine.route(run, run.plan.tasks[0], state);
  assert.equal(state.routing.parallel, false);
  fx.provider.decideJev = async () => ({ model: 'sol', parallel: true, confidence: 0.9, parallelConfidence: 2 });
  await assert.rejects(fx.engine.route(run, run.plan.tasks[0], state), /контракт/i);
});

test('Quick prepare persists selection across config changes and resumes without repeated assessment or analysis', async t => {
  const fx = await fixture(t);
  const run = await fx.engine.create('Set value to one', { project: fx.project, mode: 'quick' });
  const prepared = await fx.engine.run(run.id, { prepare: true });
  assert.equal(prepared.state, 'awaiting_plan');
  assert.equal(prepared.analysis.kind, 'local');
  assert.ok(prepared.analysis.files.includes('value.mjs'));
  assert.equal(prepared.research.requests, 0);
  await writeFile(path.join(fx.project, 'kodo.config.json'), JSON.stringify({ executionMode: 'deep' }));
  const result = await fx.engine.run(run.id);
  assert.equal(result.state, 'succeeded', result.error?.message);
  assert.equal(result.executionMode.selected, 'quick');
  assert.equal(fx.calls.filter(c => c === 'assessment').length, 1);
  assert.equal(fx.calls.includes('analysis'), false);
  assert.equal(fx.store.events(run.id).filter(e => e.type === 'mode_selected').length, 1);
});

test('Malformed or unavailable assessment records honest standard fallback and abort is propagated', async t => {
  for (const assessment of [
    () => ({ fallback: false, complexity: 'bad', requests: 1 }),
    () => {
      throw new Error('offline');
    },
  ]) {
    const fx = await fixture(t, { assessment });
    const run = await fx.engine.create('Set value to one', { project: fx.project });
    const result = await fx.engine.run(run.id, { prepare: true });
    assert.equal(result.state, 'awaiting_plan');
    assert.equal(result.executionMode.selected, 'standard');
    assert.equal(result.executionMode.fallback, true);
    assert.equal(result.executionMode.confidence, null);
    assert.deepEqual(fx.calls, ['assessment', 'analysis', 'research']);
  }
  const fx = await fixture(t, {
    assessment: () => {
      throw Object.assign(new Error('aborted'), { name: 'AbortError' });
    },
  });
  const run = await fx.engine.create('Set value to one', { project: fx.project });
  const result = await fx.engine.run(run.id);
  assert.equal(result.state, 'cancelled');
  assert.deepEqual(fx.calls, ['assessment']);
});

test('Automatic quick by assessment for a named local change ignores unrelated project size without hiding focused truncation', async t => {
  const fx = await fixture(t);
  await mkdir(path.join(fx.project, 'src'));
  await mkdir(path.join(fx.project, 'unrelated'));
  await writeFile(
    path.join(fx.project, 'src/button.css'),
    'button { color: blue; }\nbutton:focus { outline: auto; }\n',
  );
  for (let index = 0; index < 80; index++)
    await writeFile(
      path.join(fx.project, 'unrelated', `module-${index}.mjs`),
      `// unrelated ${index}\n${'x'.repeat(3000)}`,
    );
  git(fx.project, 'add', '.');
  git(fx.project, 'commit', '-m', 'Large project with a localized button');
  const original = fx.provider.assessTask;
  let map;
  fx.provider.assessTask = request => {
    map = request.files;
    return original(request);
  };
  // Naming a non-style file is doubt for the deterministic fast path (stage 08),
  // so this task takes the ordinary assessed route this test is about.
  const run = await fx.engine.create(
    'Change src/button.css button color from blue to red preserving focus per README.md',
    {
      project: fx.project,
    },
  );
  const result = await fx.engine.run(run.id, { prepare: true });
  assert.equal(result.state, 'awaiting_plan');
  assert.equal(result.executionMode.selected, 'quick');
  assert.equal(result.executionMode.contextTruncated, false);
  assert.deepEqual(fx.calls, ['assessment']);
  assert.ok(map.length <= 32);
  assert.match(map.find(file => file.path === 'src/button.css').content, /color: blue/);
  assert.ok(
    map.every(file => !file.path.startsWith('unrelated/') || file.content === undefined),
    'unrelated source is not task context',
  );
});

test('Review quota recovery reuses successful checks only while their exact head is unchanged', async t => {
  const cases = [
    { name: 'unchanged head reuses checks' },
    { name: 'changed head reruns checks', changedHead: true },
    { name: 'changed test command reruns checks', changedCommand: 'test' },
    { name: 'changed build command reruns checks', changedCommand: 'build' },
  ];
  for (const { name, changedHead = false, changedCommand } of cases)
    await t.test(name, async subtest => {
      const fx = await fixture(subtest, {
        config: {
          uiVerification: {
            enabled: true,
            autoInstall: false,
            cases: [
              {
                id: 'ready',
                tool: 'browser-harness',
                url: 'http://127.0.0.1:1',
                assertions: [{ selector: 'body', text: 'Ready' }],
              },
            ],
          },
        },
      });
      let uiCalls = 0,
        securityCalls = 0;
      fx.engine.gates.runUIVerification = request =>
        runUIVerification({
          ...request,
          caseRunner: async () => {
            uiCalls++;
            return {
              schemaVersion: 1,
              status: 'completed',
              observations: [{ exists: true, count: 1, text: 'Ready', value: null }],
            };
          },
        });
      fx.engine.gates.runSecurityChecks = request => {
        securityCalls++;
        return runSecurityChecks(request);
      };
      const log = path.join(fx.root, 'check-executions.txt');
      for (const [file, label] of [
        ['verify.mjs', 'test'],
        ['build.mjs', 'build'],
      ]) {
        const source = await readFile(path.join(fx.project, file), 'utf8');
        await writeFile(
          path.join(fx.project, file),
          source +
            `import { appendFileSync } from 'node:fs'; appendFileSync(${JSON.stringify(log)}, ${JSON.stringify(label + '\n')});\n`,
        );
      }
      git(fx.project, 'add', '.');
      git(fx.project, 'commit', '-m', 'Observe actual check command executions');
      const original = fx.provider.runSession;
      let quota = true;
      fx.provider.runSession = async request => {
        const response = await original(request);
        if (request.schema.properties.passed && quota) {
          quota = false;
          throw Object.assign(new Error('Review quota fixture'), { code: 'quota', metrics: metrics() });
        }
        return response;
      };
      const created = await fx.engine.create('Set value to one', {
        project: fx.project,
        mode: 'quick',
        model: 'gpt-6.1-sol',
      });
      const waiting = await fx.engine.run(created.id);
      assert.equal(waiting.state, 'waiting_limits');
      assert.deepEqual(
        waiting.checks.results.map(row => [row.kind, row.exitCode]),
        [
          ['test', 0],
          ['build', 0],
        ],
      );
      assert.equal(waiting.uiVerification.passed, true);
      assert.equal(uiCalls, 1);
      assert.equal(securityCalls, 1);
      const checkedHead = waiting.checks.headSha;
      if (changedHead) {
        await writeFile(path.join(waiting.cwd, 'value.mjs'), 'export const value = 1; // new scoped head\n');
        git(waiting.cwd, 'add', 'value.mjs');
        git(waiting.cwd, 'commit', '-m', 'Change the checked implementation head');
      }
      if (changedCommand) {
        const saved = fx.store.getRun(created.id);
        saved.config.commands[changedCommand][0].args.unshift(`--conditions=kodo-${changedCommand}-config-change`);
        fx.store.updateRun(created.id, { config: saved.config });
      }
      const resumed = await fx.engine.run(created.id);
      assert.equal(resumed.state, 'succeeded', resumed.error?.message);
      assert.equal(resumed.executionMode.selected, 'quick');
      assert.equal(resumed.metrics.sessions, 4, 'the failed native review remains in metrics');
      assert.equal(fx.calls.filter(call => call === 'assessment').length, 1);
      assert.equal(fx.calls.filter(call => call === 'plan').length, 1);
      assert.equal(fx.calls.filter(call => call === 'worker').length, 1);
      assert.equal(fx.calls.filter(call => call === 'review').length, 2);
      assert.ok(fx.sessions.every(request => request.model === 'gpt-6.1-sol'));
      assert.equal(uiCalls, 2, 'enabled UI observations must be fresh even when local checks are reused');
      assert.equal(securityCalls, 2, 'security gate invocation remains separate from local check reuse');
      for (const receipt of [resumed.checks, resumed.review, resumed.uiVerification, resumed.securityChecks])
        assert.equal(receipt.headSha, resumed.headSha);
      if (changedHead) assert.notEqual(resumed.headSha, checkedHead);
      else assert.equal(resumed.headSha, checkedHead);
      if (changedCommand)
        assert.deepEqual(resumed.checks.results.find(row => row.kind === changedCommand).command.args, [
          `--conditions=kodo-${changedCommand}-config-change`,
          changedCommand === 'test' ? 'verify.mjs' : 'build.mjs',
        ]);
      assert.deepEqual(
        (await readFile(log, 'utf8')).trim().split('\n'),
        changedHead || changedCommand ? ['test', 'build', 'test', 'build'] : ['test', 'build'],
        'unchanged successful checks must be reused, while a new head or check configuration requires actual commands',
      );
    });
});
