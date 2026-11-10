import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { readConfig } from '../runtime/config.mjs';
import { manifestFreshness } from '../runtime/context-manifest.mjs';
import { fixture, git, task } from './helpers/mode-engine-fixture.mjs';

const css = 'styles/button.css';
const cssTask = `Make the button in ${css} blue.`;
const stylePlan = () => ({
  summary: 'Recolour the button',
  tasks: [{ ...task('recolour'), description: 'Make the button blue', writePaths: [css] }],
});

/** The mode fixture plus a tracked stylesheet; workers write whatever their node owns. */
async function styled(t, options = {}) {
  const fx = await fixture(t, { plan: stylePlan, ...options });
  await mkdir(path.join(fx.project, 'styles'));
  await writeFile(path.join(fx.project, css), '.button { color: red; }\n');
  // The fixture's check and build expect value 1; keep them green for a style-only change.
  await writeFile(path.join(fx.project, 'value.mjs'), 'export const value = 1;\n');
  git(fx.project, 'add', '.');
  git(fx.project, 'commit', '-m', 'Add stylesheet');
  const session = fx.provider.runSession;
  fx.provider.runSession = async request => {
    const worker = !request.schema.properties.tasks && !request.schema.properties.passed;
    if (!worker) return session(request);
    fx.sessions.push(request);
    fx.calls.push('worker');
    const target = path.basename(request.cwd) === 'code' ? 'value.mjs' : css;
    await writeFile(
      path.join(request.cwd, target),
      target === css ? '.button { color: blue; }\n' : 'export const value = 1;\nexport const touched = true;\n',
    );
    request.onEvent?.({ sessionId: `worker-${fx.sessions.length}` });
    return { sessionId: `worker-${fx.sessions.length}`, output: { complete: true, summary: 'done', checks: [] } };
  };
  return fx;
}

test('A proven style-only task skips Jev, Gemini and research and still gets an independent review', async t => {
  const fx = await styled(t);
  const run = await fx.engine.create(cssTask, { project: fx.project });
  const result = await fx.engine.run(run.id);
  assert.equal(result.state, 'succeeded', result.error?.message);
  assert.deepEqual(
    fx.calls.filter(call => call !== 'discovery'),
    ['plan', 'worker', 'review'],
    'no assessment, analysis, research or routing call',
  );
  assert.deepEqual(
    [result.executionMode.selected, result.executionMode.source, result.executionMode.requested],
    ['quick', 'fast-path', null],
  );
  assert.deepEqual(result.fastPath.files, [css]);
  // The receipt does not pretend that an assessment was tried and was unavailable.
  assert.deepEqual(
    [result.executionMode.assessment, result.executionMode.requests, result.executionMode.fallback],
    ['not_requested', 0, undefined],
  );
  assert.equal(result.executionMode.assessmentReason, undefined);
  assert.equal(result.research.requests, 0);
  assert.equal(result.analysis.kind, 'local');
  assert.equal(await readFile(path.join(result.cwd, css), 'utf8'), '.button { color: blue; }\n');
  assert.equal(result.review.passed, true, 'the review gate is not skipped');
});

test('Doubt takes the ordinary route: a non-style path, a risk word or an explicit wider mode', async t => {
  for (const [name, text, options] of [
    ['non-style path', `Make ${css} blue and update value.mjs`, {}],
    ['risk word', `Hide the login button in ${css}`, {}],
    ['explicit standard', cssTask, { mode: 'standard' }],
  ])
    await t.test(name, async subtest => {
      const fx = await styled(subtest);
      const run = await fx.engine.create(text, { project: fx.project, ...options });
      const result = await fx.engine.run(run.id);
      assert.equal(result.state, 'succeeded', result.error?.message);
      assert.equal(fx.calls.filter(call => call === 'assessment').length, 1, 'the ordinary assessment ran');
      assert.notEqual(result.executionMode.source, 'fast-path');
      assert.equal(result.fastPath, undefined);
    });
});

test('A plan that leaves the proven files revokes the fast path and restores the ordinary budgets', async t => {
  const fx = await styled(t, {
    config: { repairRounds: 3, researchBudget: 7 },
    plan: () => ({ summary: 'Also touch code', tasks: [{ ...task('code'), writePaths: ['value.mjs'] }] }),
  });
  const run = await fx.engine.create(cssTask, { project: fx.project });
  const result = await fx.engine.run(run.id);
  assert.equal(result.state, 'succeeded', result.error?.message);
  assert.deepEqual(
    fx.calls.filter(call => ['plan', 'assessment'].includes(call)),
    ['plan', 'assessment', 'plan'],
    'the ordinary route assesses and plans again',
  );
  assert.equal(result.fastPath.revoked, 'plan_outside_proof');
  // The fixture assessment is confidently low and local, so the ordinary route also selects quick,
  // but from Jev and from the project's own budgets, not from the fast-path clamp.
  assert.deepEqual([result.executionMode.source, result.executionMode.selected], ['jev', 'quick']);
  assert.equal(result.executionMode.profile.repairRounds, 1, 'quick profile of the ordinary route');
  assert.deepEqual(result.fastPath.budgets, { researchBudget: 7, repairRounds: 3, concurrency: 2, maxTasks: null });
});

test('A session cap is persisted: resume and a retry cycle cannot start another session', async t => {
  const fx = await styled(t, { config: { budgets: { sessions: 2 } } });
  const run = await fx.engine.create(cssTask, { project: fx.project });
  const blocked = await fx.engine.run(run.id);
  assert.deepEqual([blocked.state, blocked.error.code], ['blocked', 'budget']);
  assert.deepEqual(
    blocked.sessionAttempts.map(attempt => attempt.stage),
    ['plan', 'developer'],
    'the review session was refused before it started',
  );
  assert.equal(fx.sessions.length, 2);
  assert.equal(blocked.config.budgets.sessions, 2);
  for (const options of [{}, { retryFailed: true }]) {
    const again = await fx.engine.run(run.id, options);
    assert.deepEqual([again.state, again.error.code], ['blocked', 'budget']);
    assert.equal(again.sessionAttempts.length, 2);
    assert.equal(fx.sessions.length, 2, 'no provider session after the cap');
  }
});

test('Budgets are optional, bounded and reject unknown keys', async t => {
  const fx = await styled(t);
  assert.equal((await readConfig(fx.project)).budgets, undefined, 'absent means no cap');
  assert.deepEqual((await readConfig(fx.project, { budgets: { sessions: 1, contextBytes: 4096 } })).budgets, {
    sessions: 1,
    contextBytes: 4096,
  });
  for (const budgets of [{ sessions: 0 }, { sessions: 1.5 }, { contextBytes: 100 }, { tokens: 5 }, [], 'many'])
    await assert.rejects(readConfig(fx.project, { budgets }), /budgets/, JSON.stringify(budgets));
});

test('Every session leaves a manifest bound to its contract and head; a context limit refuses, never cuts', async t => {
  const secret = 'kodo-fixture-secret-0001';
  const fx = await styled(t);
  fx.engine.secrets = { FIXTURE_TOKEN: secret };
  const run = await fx.engine.create(cssTask, { project: fx.project });
  const result = await fx.engine.run(run.id);
  assert.equal(result.state, 'succeeded', result.error?.message);
  assert.equal(result.sessionAttempts.length, 3);
  for (const attempt of result.sessionAttempts) {
    const { manifest } = attempt;
    assert.equal(manifest.kind, 'context-manifest');
    assert.match(attempt.manifestSha256, /^[0-9a-f]{64}$/);
    assert.equal(manifest.totalBytes, attempt.metrics.promptBytes, `${attempt.stage}: sizes add up to the prompt`);
    assert.equal(manifest.limitBytes, null);
    assert.doesNotMatch(JSON.stringify(manifest), new RegExp(`${secret}|Make the button|state`));
  }
  const worker = result.sessionAttempts.find(attempt => attempt.stage === 'developer');
  const { manifest } = worker;
  const contract = worker.evidence.find(item => path.basename(item.path).startsWith('node-contract-'));
  assert.equal(manifest.mandatory.contract.sha256, contract.sha256);
  const context = manifest.sections.find(section => section.name === 'task-context');
  assert.equal(context.mandatory, true);
  assert.match(fx.sessions[1].prompt, /Make the button blue/, 'the full task description reached the worker');
  const hashes = Object.fromEntries(manifest.references.map(item => [item.file, item.sha256]));
  assert.equal(manifestFreshness(manifest, { headSha: manifest.headSha, hashes }).status, 'fresh');
  assert.equal(manifestFreshness(manifest, { headSha: result.headSha, hashes }).status, 'stale');

  const tight = await styled(t, { config: { budgets: { contextBytes: 4096 } } });
  const refused = await tight.engine.run((await tight.engine.create(cssTask, { project: tight.project })).id);
  assert.deepEqual([refused.state, refused.error.code], ['blocked', 'context_budget']);
  assert.equal(tight.sessions.length, 0, 'nothing was sent in a shortened form');
});

test('A session cap that refuses the worker stops the run as a budget stop, without repair or research', async t => {
  // Standard mode: a node failure would normally trigger research and another routed attempt.
  const fx = await styled(t, { config: { budgets: { sessions: 1 }, repairRounds: 3, researchBudget: 5 } });
  const run = await fx.engine.create(cssTask, { project: fx.project, mode: 'standard' });
  const result = await fx.engine.run(run.id);
  assert.deepEqual([result.state, result.error.code], ['blocked', 'budget']);
  assert.equal(result.executionMode.selected, 'standard');
  assert.deepEqual(
    result.sessionAttempts.map(attempt => attempt.stage),
    ['plan'],
    'the worker session was refused before it started',
  );
  const node = Object.values(result.nodes)[0];
  assert.deepEqual([node.attempt, node.stopped, node.error], [0, undefined, undefined], 'no attempt was spent');
  const research = fx.calls.filter(call => call === 'research').length;
  const again = await fx.engine.run(run.id, { retryFailed: true });
  assert.deepEqual([again.state, again.error.code], ['blocked', 'budget']);
  assert.equal(fx.calls.filter(call => call === 'research').length, research, 'the refusal starts no research');
  assert.equal(fx.sessions.length, 1);
});

test('A broken or forbidden host plan is refused without revoking the fast path', async t => {
  const fx = await styled(t);
  const run = await fx.engine.create(cssTask, { project: fx.project });
  const planFile = path.join(fx.root, 'plan.json');
  await writeFile(planFile, JSON.stringify({ summary: 'No tasks', tasks: [] }));
  const refused = await fx.engine.run(run.id, { planFile });
  assert.equal(refused.state, 'blocked');
  assert.deepEqual(
    [refused.executionMode.source, refused.fastPath.revoked],
    ['fast-path', undefined],
    'an invalid plan cannot widen the run',
  );
  assert.ok(!fx.calls.includes('assessment'));
});
