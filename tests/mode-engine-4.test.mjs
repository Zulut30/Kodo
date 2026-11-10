import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { git, task, metrics, fixture } from './helpers/mode-engine-fixture.mjs';

test('Automatic assessment precedes expensive analysis and project mode is overridden by explicit mode', async t => {
  const fx = await fixture(t, {
    config: { executionMode: 'deep', researchBudget: 2, repairRounds: 2, concurrency: 1 },
  });
  const explicit = await fx.engine.create('Set value to one', { project: fx.project, mode: 'standard' });
  const result = await fx.engine.run(explicit.id, { prepare: true });
  assert.equal(result.state, 'awaiting_plan');
  assert.equal(result.executionMode.selected, 'standard');
  assert.deepEqual(fx.calls, ['assessment', 'analysis', 'research']);
  assert.equal(result.config.researchBudget, 2);
  assert.equal(result.config.repairRounds, 2);
  assert.equal(result.config.concurrency, 1);
  assert.equal(result.executionMode.profile.maxTasks, 12);
  const auto = await fixture(t);
  const run = await auto.engine.create('Set value to one', { project: auto.project });
  const prepared = await auto.engine.run(run.id, { prepare: true });
  assert.equal(prepared.executionMode.selected, 'quick');
  assert.equal(prepared.executionMode.source, 'jev');
  assert.deepEqual(auto.calls, ['assessment']);
});

test('Mode plan limits reject oversized host and native plans before any executor', async t => {
  for (const mode of ['quick', 'standard']) {
    const maxTasks = mode === 'quick' ? 2 : 12;
    const oversized = () => ({
      summary: 'Too many tasks',
      tasks: Array.from({ length: maxTasks + 1 }, (_, i) => task(`task-${i}`)),
    });
    const fx = await fixture(t, { plan: oversized });
    const run = await fx.engine.create('Set value to one', { project: fx.project, mode });
    const result = await fx.engine.run(run.id);
    assert.equal(result.state, 'blocked');
    assert.equal(result.error.code, 'invalid_plan');
    assert.equal(fx.calls.includes('worker'), false);
    const file = path.join(fx.root, 'host-plan.json');
    await writeFile(file, JSON.stringify(oversized()));
    const hostRun = await fx.engine.create('Set value to one', { project: fx.project, mode });
    const hostResult = await fx.engine.run(hostRun.id, { planFile: file });
    assert.equal(hostResult.state, 'blocked');
    assert.equal(hostResult.error.code, 'invalid_plan');
  }
});

test('Quick failure keeps actual failed checks and independent review findings without extra research or repair', async t => {
  for (const options of [{ failedCheck: true }, { failedReview: true }]) {
    const fx = await fixture(t, options);
    const run = await fx.engine.create('Set value to one', { project: fx.project, mode: 'quick' });
    const result = await fx.engine.run(run.id);
    assert.equal(result.state, 'blocked');
    assert.equal(result.controllerAssessment.attempts, 1);
    if (options.failedCheck) {
      assert.equal(result.checks.results[0].exitCode, 1);
      assert.equal(fx.calls.includes('review'), false);
    } else {
      assert.equal(result.review.passed, false);
      assert.equal(result.review.findings[0].severity, 'major');
      assert.equal(result.review.headSha, result.headSha);
    }
    assert.equal(fx.calls.includes('research'), false);
    assert.equal(fx.calls.filter(c => c === 'worker').length, 1);
    await fx.engine.moreResearch(result, 'Confirmed blocker');
    assert.equal(fx.calls.includes('research'), false);
  }
});

test('Truncated assessment context cannot auto-select quick and lower configured task caps are enforced', async t => {
  const fx = await fixture(t, { config: { maxTasks: 1 } });
  await writeFile(path.join(fx.project, 'large.txt'), 'x'.repeat(2049));
  git(fx.project, 'add', '.');
  git(fx.project, 'commit', '-m', 'Larger classifier context');
  const run = await fx.engine.create('Set value to one; inspect large.txt', { project: fx.project });
  const prepared = await fx.engine.run(run.id, { prepare: true });
  assert.equal(prepared.executionMode.contextTruncated, true);
  assert.equal(prepared.executionMode.selected, 'standard');
  assert.equal(prepared.executionMode.profile.maxTasks, 1);
  const planFile = path.join(fx.root, 'two-tasks.json');
  await writeFile(planFile, JSON.stringify({ summary: 'Too many', tasks: [task('one'), task('two')] }));
  const result = await fx.engine.run(run.id, { planFile });
  assert.equal(result.state, 'blocked');
  assert.equal(result.error.code, 'invalid_plan');
  assert.equal(fx.calls.includes('worker'), false);
});

test('Native failed attempts retain metrics and logical research requests exclude cache reuse', async t => {
  const fx = await fixture(t, { failedWorker: true });
  const run = await fx.engine.create('Set value to one', { project: fx.project, mode: 'quick' });
  const result = await fx.engine.run(run.id);
  assert.equal(result.state, 'waiting_limits');
  assert.equal(result.metrics.sessions, 2);
  assert.equal(result.metrics.usage.totalTokens, 24);
  assert.equal(result.metrics.toolSteps, 2);
  assert.equal(result.sessionAttempts[1].status, 'failed');
  assert.equal(result.sessionAttempts[1].errorCode, 'quota');
  const standard = await fixture(t);
  standard.engine.researcher = async () => ({
    requests: 0,
    items: [{ source: 'cache' }],
    errors: [],
    cache: ['cached'],
  });
  const next = await standard.engine.create('Set value to one', { project: standard.project, mode: 'standard' });
  const prepared = await standard.engine.run(next.id, { prepare: true });
  assert.equal(prepared.metrics.coordinatorLogicalCalls.research, 1);
  assert.equal(prepared.metrics.researchRequests, 0);
});

test('Node no-progress detection distinguishes changed tracked and untracked contents with identical porcelain', async t => {
  for (const untracked of [false, true]) {
    const fx = await fixture(t, {
      config: { executionMode: 'deep', repairRounds: 4, researchBudget: 0 },
      plan: () => ({
        summary: 'Continue real content progress',
        tasks: [{ ...task('fix'), writePaths: ['value.mjs', 'notes.txt'] }],
      }),
    });
    const original = fx.provider.runSession;
    let attempts = 0;
    fx.provider.runSession = async request => {
      if (!request.schema.properties.tasks && !request.schema.properties.passed) {
        attempts++;
        if (attempts < 3) {
          await writeFile(
            path.join(request.cwd, untracked ? 'notes.txt' : 'value.mjs'),
            untracked ? `progress ${attempts}\n` : `export const value = 0; // progress ${attempts}\n`,
          );
          return { metrics: metrics(), output: { complete: false, summary: 'Same remaining requirement', checks: [] } };
        }
      }
      return original(request);
    };
    const run = await fx.engine.create('Set value to one', { project: fx.project });
    const result = await fx.engine.run(run.id);
    assert.equal(result.state, 'succeeded', `${untracked ? 'untracked' : 'tracked'} content: ${result.error?.message}`);
    assert.equal(attempts, 3);
    assert.equal(result.nodes.fix.attempt, 3);
    assert.equal(result.nodes.fix.stopped, undefined);
  }
});

test('Quick rejects contradictory passing review receipts with blocker or major findings', async t => {
  for (const severity of ['blocker', 'major'])
    await t.test(severity, async subtest => {
      const fx = await fixture(subtest);
      const original = fx.provider.runSession;
      fx.provider.runSession = async request => {
        const response = await original(request);
        if (request.schema.properties.passed)
          response.output = {
            passed: true,
            findings: [
              {
                file: 'value.mjs',
                severity,
                problem: 'A confirmed acceptance condition is missing',
                fix: 'Implement the missing condition',
              },
            ],
          };
        return response;
      };
      const run = await fx.engine.create('Set value to one', { project: fx.project, mode: 'quick' });
      const result = await fx.engine.run(run.id);
      assert.equal(result.state, 'blocked');
      assert.deepEqual(
        result.checks.results.map(row => row.exitCode),
        [0, 0],
      );
      assert.equal(result.review.passed, false, 'severity overrides the reviewer success boolean');
      assert.equal(result.review.findings[0].severity, severity);
      assert.equal(result.review.headSha, result.headSha);
      assert.equal(result.controllerAssessment.attempts, 1);
      assert.deepEqual(fx.calls, ['assessment', 'discovery', 'plan', 'worker', 'review']);
    });
});
