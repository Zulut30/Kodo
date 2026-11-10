import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Engine } from '../runtime/engine.mjs';
import { isCurrentBehaviorReceipt } from '../runtime/behavior-gate.mjs';
import { fixture, fakeServices, git, node } from './helpers/engine-fixture.mjs';

const done = { sessionId: 'worker', output: { summary: 'done', checks: [], complete: true } };
const isRepair = call => /Repair confirmed failures/.test(call.prompt);
const write = async (cwd, name, text) => {
  await mkdir(path.dirname(path.join(cwd, name)), { recursive: true });
  await writeFile(path.join(cwd, name), text);
};

/**
 * A project with extra committed files and one developer node. `onWorker(call, repair)` edits the
 * worktree; the reviewer always reports PASS, so only the coordinator's own gates can stop a run.
 */
async function project(t, { files = {}, config = {}, scopes = ['src/**'], onWorker }) {
  const fx = await fixture(t, {
    config: { repairRounds: 2, researchBudget: 0, ...config },
    testScript: 'process.exit(0);\n',
  });
  for (const [name, text] of Object.entries(files)) await write(fx.project, name, text);
  if (Object.keys(files).length) {
    git(fx.project, 'add', '.');
    git(fx.project, 'commit', '-m', 'Fixture files');
  }
  const services = fakeServices({
    plan: { summary: 'One change', tasks: [node('change', 'developer', scopes)] },
    onWorker: async call => {
      await onWorker(call, isRepair(call));
      return done;
    },
  });
  const store = fx.openStore(),
    engine = new Engine({ store, ...services });
  const run = await engine.create('Change the module', { project: fx.project });
  return { fx, services, engine, run };
}

// Compiles and loads, but computes the wrong object id: no `blob <size>\0` header.
const wrongBlobId =
  "import { createHash } from 'node:crypto';\nexport const blobId = text => createHash('sha1').update(text).digest('hex');\n";
const rightBlobId =
  "import { createHash } from 'node:crypto';\n" +
  'export const blobId = text =>\n' +
  "  createHash('sha1').update(`blob ${Buffer.byteLength(text)}\\0`).update(text).digest('hex');\n";
// The oracle asks the installed Git, not the implementation and not a model.
const gitOracle =
  "import { spawnSync } from 'node:child_process';\nimport { blobId } from '../src/blob.mjs';\n" +
  "for (const text of ['', 'hello\\n', 'Привет, Kodo\\n']) {\n" +
  "  const git = spawnSync('git', ['hash-object', '--stdin'], { input: text, encoding: 'utf8' });\n" +
  '  if (git.status !== 0) { console.error(git.stderr); process.exit(2); }\n' +
  '  if (blobId(text) !== git.stdout.trim()) {\n' +
  '    console.error(`blobId(${JSON.stringify(text)}) = ${blobId(text)}, git says ${git.stdout.trim()}`);\n' +
  '    process.exit(1);\n  }\n}\n';
const oracleConfig = {
  verification: {
    oracles: [{ id: 'git-blob', command: process.execPath, args: ['oracle/git-blob.mjs'], protect: ['oracle/**'] }],
  },
};

test('Code that compiles but disagrees with installed Git is stopped by the oracle, then repaired once', async t => {
  const { services, engine, run } = await project(t, {
    files: { 'src/blob.mjs': 'export const blobId = () => "";\n', 'oracle/git-blob.mjs': gitOracle },
    config: oracleConfig,
    onWorker: (call, repair) => write(call.cwd, 'src/blob.mjs', repair ? rightBlobId : wrongBlobId),
  });
  const result = await engine.run(run.id);
  assert.equal(result.state, 'succeeded', result.error?.message);
  const repairs = services.calls.worker.filter(isRepair);
  assert.equal(repairs.length, 1, 'the confirmed defect triggers one bounded repair');
  assert.match(repairs[0].prompt, /Behaviour gate failed[\s\S]*git-blob exit 1[\s\S]*git says/);
  assert.equal(services.calls.review.length, 1, 'the reviewer is asked only after the oracle is green');
  assert.deepEqual(
    result.behavior.oracles.map(oracle => [oracle.id, oracle.status, oracle.exitCode]),
    [['git-blob', 'passed', 0]],
  );
  assert.equal(
    isCurrentBehaviorReceipt(result.behavior, {
      headSha: result.headSha,
      baseSha: result.baseSha,
      config: result.config,
    }),
    true,
  );
  assert.equal(
    isCurrentBehaviorReceipt(result.behavior, {
      headSha: result.baseSha,
      baseSha: result.baseSha,
      config: result.config,
    }),
    false,
    'the receipt does not vouch for another head',
  );
});

test('A passing review report cannot override a failing oracle', async t => {
  const { services, engine, run } = await project(t, {
    files: { 'src/blob.mjs': 'export const blobId = () => "";\n', 'oracle/git-blob.mjs': gitOracle },
    config: { ...oracleConfig, repairRounds: 1 },
    onWorker: call => write(call.cwd, 'src/blob.mjs', wrongBlobId),
  });
  const result = await engine.run(run.id);
  assert.equal(result.state, 'blocked');
  assert.match(result.error.message, /Behaviour gate failed|Verification repair cycle stopped|Нет прогресса/);
  assert.equal(services.calls.review.length, 0, 'the always-PASS reviewer never got a say');
  assert.equal(result.review, null);
  assert.equal(result.behavior.passed, false);
  assert.equal(services.calls.delivery, 0);
});

test('Deleting or skipping an existing test stops the run even though checks and review would pass', async t => {
  const existing =
    "import test from 'node:test';\nimport assert from 'node:assert/strict';\n" +
    "test('value is a number', () => assert.equal(typeof 1, 'number'));\n";
  for (const [name, weaken, rule] of [
    ['deleted', call => rm(path.join(call.cwd, 'tests/value.test.mjs')), 'test_deleted'],
    [
      'skipped',
      call => write(call.cwd, 'tests/value.test.mjs', existing.replace("test('value", "test.skip('value")),
      'test_skipped',
    ],
  ])
    await t.test(name, async subtest => {
      const { services, engine, run } = await project(subtest, {
        files: { 'tests/value.test.mjs': existing },
        config: { repairRounds: 1 },
        scopes: ['src/**', 'tests/**'],
        onWorker: async call => {
          await write(call.cwd, 'src/value.mjs', 'export const value = 2;\n');
          await weaken(call);
        },
      });
      const result = await engine.run(run.id);
      assert.equal(result.state, 'blocked');
      assert.deepEqual(
        result.behavior.findings.map(finding => [finding.rule, finding.file]),
        [[rule, 'tests/value.test.mjs']],
      );
      assert.equal(services.calls.review.length, 0);
    });
});

test('An implementation may not edit the oracle that judges it', async t => {
  const { services, engine, run } = await project(t, {
    files: { 'src/blob.mjs': 'export const blobId = () => "";\n', 'oracle/git-blob.mjs': gitOracle },
    config: { ...oracleConfig, repairRounds: 1 },
    scopes: ['src/**', 'oracle/**'],
    onWorker: async call => {
      await write(call.cwd, 'src/blob.mjs', wrongBlobId);
      await write(call.cwd, 'oracle/git-blob.mjs', 'process.exit(0);\n');
    },
  });
  const result = await engine.run(run.id);
  assert.equal(result.state, 'blocked');
  assert.deepEqual(
    result.behavior.findings.map(finding => finding.rule),
    ['oracle_modified'],
  );
  assert.deepEqual(result.behavior.oracles, [
    { id: 'git-blob', status: 'not_run', reason: 'oracle_modified', exitCode: null },
  ]);
  assert.equal(services.calls.review.length, 0);
});

test('With a baseline, a break in a dependent module is labelled a regression and an old failure pre-existing', async t => {
  // The check exercises a consumer of the changed module, not the module itself.
  const consumer = "import { value } from './value.mjs';\nexport const doubled = value * 2;\n";
  const verify =
    "import { doubled } from './src/consumer.mjs';\nif (doubled !== 0) { console.error('doubled is ' + doubled); process.exit(1); }\n";
  await t.test('regression', async subtest => {
    const { engine, run } = await project(subtest, {
      files: { 'src/consumer.mjs': consumer, 'verify.mjs': verify },
      config: { verification: { baseline: true }, repairRounds: 1 },
      onWorker: call => write(call.cwd, 'src/value.mjs', 'export const value = 21;\n'),
    });
    const result = await engine.run(run.id);
    assert.equal(result.state, 'blocked');
    assert.deepEqual([result.baseline.status, result.baseline.headSha], ['complete', result.baseSha]);
    assert.deepEqual(
      result.baseline.results.map(row => row.exitCode),
      [0],
    );
    assert.deepEqual(
      result.checks.comparison.map(row => [row.baseline, row.final, row.classification]),
      [[0, 1, 'regression']],
    );
    assert.match(result.controllerAssessment.summary, /\[regression: passed on the base commit\] doubled is 42/);
  });
  await t.test('pre-existing', async subtest => {
    const { engine, run } = await project(subtest, {
      files: { 'src/consumer.mjs': consumer, 'verify.mjs': verify.replace('doubled !== 0', 'doubled !== 7') },
      config: { verification: { baseline: true }, repairRounds: 1 },
      onWorker: call => write(call.cwd, 'src/value.mjs', 'export const value = 21;\n'),
    });
    const result = await engine.run(run.id);
    assert.equal(result.state, 'blocked', 'an old failure is labelled, never ignored');
    assert.deepEqual(
      result.checks.comparison.map(row => [row.baseline, row.final, row.classification]),
      [[1, 1, 'pre_existing']],
    );
    assert.match(result.controllerAssessment.summary, /\[pre-existing: already failed on base [0-9a-f]{12}\]/);
  });
  await t.test('no baseline unless enabled', async subtest => {
    const { engine, run } = await project(subtest, {
      onWorker: call => write(call.cwd, 'src/value.mjs', 'export const value = 2;\n'),
    });
    const result = await engine.run(run.id);
    assert.equal(result.state, 'succeeded', result.error?.message);
    assert.equal(result.baseline, undefined);
    assert.equal(result.checks.comparison, undefined);
    assert.deepEqual(
      [result.behavior.passed, result.behavior.policy.types, result.behavior.oracles],
      [true, ['code'], []],
    );
  });
});

test('A style change records the disabled UI gate as a gap; strictGates turns the gap into a stop', async t => {
  for (const [name, verification, state] of [
    ['reported', {}, 'succeeded'],
    ['strict', { strictGates: true }, 'blocked'],
  ])
    await t.test(name, async subtest => {
      const { services, engine, run } = await project(subtest, {
        files: { 'styles/app.css': 'a { color: red; }\n' },
        config: { verification, repairRounds: 3 },
        scopes: ['styles/app.css'],
        onWorker: call => write(call.cwd, 'styles/app.css', 'a { color: blue; }\n'),
      });
      const result = await engine.run(run.id);
      assert.equal(result.state, state, result.error?.message);
      if (state === 'blocked') {
        // Nobody but a person can enable a gate: no repair session is spent on it.
        assert.equal(result.error.code, 'behavior_blocked');
        assert.equal(services.calls.worker.filter(isRepair).length, 0);
      }
      assert.deepEqual(result.behavior.policy, {
        risk: 'low',
        types: ['style'],
        required: ['checks', 'review', 'ui'],
        gaps: [{ gate: 'ui', reason: 'disabled' }],
      });
      assert.equal(result.uiVerification?.passed ?? null, null, 'a disabled gate is never a PASS');
    });
});
