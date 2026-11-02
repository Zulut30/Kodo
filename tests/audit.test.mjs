import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { defaultSkillIds } from '../runtime/skill-policy.mjs';

// Public contract fixtures, independent of the report implementation and policy evaluator.
const ids = [
  'skills/architecture-patterns', 'skills/architecture-decision-records',
  'skills/monorepo-management', 'skills/e2e-testing-patterns',
  'skills/subagent-driven-development', 'skills/systematic-debugging',
  'skills/test-driven-development', 'skills/using-git-worktrees',
  'skills/differential-review', 'skills/react-best-practices',
  'skills/composition-patterns', 'skills/ce-compound', 'skills/spec-kit'
];
const stages = ['analyze', 'plan', 'developer', 'tester', 'documenter', 'review', 'complete'];
const hash = 'ab'.repeat(32), revision = 'cd'.repeat(20);
const baseSha = '12'.repeat(20), headSha = '34'.repeat(20);
const privateMarker = 'DO-NOT-EXPORT-AUDIT-FIXTURE';
const auditUrl = new URL('../runtime/audit.mjs', import.meta.url);
const topKeys = ['schemaVersion', 'runId', 'state', 'baseSha', 'headSha', 'evidenceLevel', 'skills', 'checks', 'review', 'delivery', 'release'];

async function builder() {
  let module;
  try { module = await import(auditUrl.href); }
  catch (error) {
    if (error.code === 'ERR_MODULE_NOT_FOUND' && error.url === auditUrl.href) {
      assert.fail('Missing audit feature: runtime/audit.mjs must export buildAuditReport(run)');
    }
    throw error;
  }
  assert.equal(typeof module.buildAuditReport, 'function', 'buildAuditReport must be a public export');
  return module.buildAuditReport;
}

function decisions() {
  return ids.map((id, index) => ({
    id, applies: index < 7, reason: index < 7 ? 'Relevant to this stage' : 'Not relevant to this stage', revision
  }));
}
function policy() { return { hash, skills: decisions() }; }
function runFixture() {
  return {
    id: 'audit-contract-run', state: 'succeeded', baseSha, headSha,
    plan: { tasks: [{ role: 'tester' }, { role: 'documenter' }, { role: 'developer' }, { role: 'tester' }] },
    defaultSkills: Object.fromEntries(stages.map(stage => [stage, policy()]))
  };
}
function assertKeys(value, expected) {
  assert.deepEqual(Object.keys(value).sort(), [...expected].sort());
}
function assertIncomplete(report) {
  assert.equal(report.schemaVersion, 1);
  assert.equal(report.evidenceLevel, 'recorded-instructions');
  assert.equal(report.skills.complete, false);
  assert.ok(Array.isArray(report.skills.stages));
}
function assertInvalidStage(report, stage) {
  assertIncomplete(report);
  const entry = report.skills.stages.find(item => item.stage === stage);
  assert.ok(entry, `Malformed recorded stage ${stage} must remain inspectable`);
  assert.equal(entry.valid, false);
}
function deepFreeze(value) {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

test('Audit fixtures cover all 13 public default skill IDs', () => {
  assert.deepEqual(defaultSkillIds, ids);
  assert.equal(new Set(ids).size, 13);
});

test('Audit report exports a synchronous allowlisted schema with canonical complete coverage', async () => {
  const build = await builder();
  const report = build(runFixture());
  assert.ok(report && typeof report === 'object');
  assert.equal(typeof report.then, 'undefined', 'report construction must be synchronous');
  assertKeys(report, topKeys);
  assert.deepEqual(report, {
    schemaVersion: 1, runId: 'audit-contract-run', state: 'succeeded', baseSha, headSha,
    evidenceLevel: 'recorded-instructions',
    skills: {
      expectedStages: stages, recordedStages: stages, missingStages: [], complete: true,
      stages: stages.map(stage => ({ stage, hash, valid: true, skills: decisions() }))
    },
    checks: null, review: null, delivery: null, release: null
  });
});

test('Audit normalizes shuffled stage records and skill decisions deterministically', async () => {
  const build = await builder();
  const run = runFixture();
  run.defaultSkills = Object.fromEntries([...stages].reverse().map(stage => [stage, {
    hash, skills: [...decisions().slice(5), ...decisions().slice(0, 5)].reverse()
  }]));
  const report = build(run);
  assert.equal(report.skills.complete, true);
  assert.deepEqual(report.skills.recordedStages, stages);
  assert.deepEqual(report.skills.stages, stages.map(stage => ({ stage, hash, valid: true, skills: decisions() })));
  assert.deepEqual(build(run), report);
});

test('Audit accepts valid non-applicable decisions without claiming semantic compliance', async () => {
  const build = await builder();
  const run = runFixture();
  for (const entry of Object.values(run.defaultSkills)) for (const skill of entry.skills) skill.applies = false;
  const report = build(run);
  assert.equal(report.skills.complete, true);
  assert.equal(report.evidenceLevel, 'recorded-instructions');
  for (const entry of report.skills.stages) {
    assert.equal(entry.valid, true);
    assert.equal(entry.skills.length, 13);
    assert.ok(entry.skills.every(skill => skill.applies === false));
  }
});

for (const [roles, expected] of [
  [['developer'], ['analyze', 'plan', 'developer', 'review', 'complete']],
  [['documenter'], ['analyze', 'plan', 'documenter', 'review', 'complete']],
  [['tester', 'developer'], ['analyze', 'plan', 'developer', 'tester', 'review', 'complete']],
  [['documenter', 'tester'], ['analyze', 'plan', 'tester', 'documenter', 'review', 'complete']],
  [['documenter', 'tester', 'developer'], ['analyze', 'plan', 'developer', 'tester', 'documenter', 'review', 'complete']],
  [['tester', 'tester'], ['analyze', 'plan', 'tester', 'review', 'complete']],
  [['documenter', 'developer'], ['analyze', 'plan', 'developer', 'documenter', 'review', 'complete']]
]) test(`Audit derives expected stages from subset roles ${roles.join(',')}`, async () => {
  const build = await builder();
  const run = runFixture();
  run.plan.tasks = roles.map(role => ({ role }));
  run.defaultSkills = Object.fromEntries(expected.map(stage => [stage, policy()]));
  const report = build(run);
  assert.deepEqual(report.skills.expectedStages, expected);
  assert.deepEqual(report.skills.recordedStages, expected);
  assert.deepEqual(report.skills.missingStages, []);
  assert.equal(report.skills.complete, true);
});

for (const stage of stages) test(`Audit detects missing expected stage ${stage}`, async () => {
  const build = await builder();
  const run = runFixture();
  delete run.defaultSkills[stage];
  const report = build(run);
  assertIncomplete(report);
  assert.deepEqual(report.skills.expectedStages, stages);
  assert.deepEqual(report.skills.missingStages, [stage]);
  assert.deepEqual(report.skills.recordedStages, stages.filter(item => item !== stage));
});

test('Audit includes repair only when recorded and validates it', async () => {
  const build = await builder();
  const run = runFixture();
  assert.equal(build(run).skills.expectedStages.includes('repair'), false);
  run.defaultSkills.repair = policy();
  const expected = ['analyze', 'plan', 'developer', 'tester', 'documenter', 'review', 'repair', 'complete'];
  const report = build(run);
  assert.deepEqual(report.skills.expectedStages, expected);
  assert.deepEqual(report.skills.recordedStages, expected);
  assert.equal(report.skills.complete, true);
  for (const broken of [null, {}, { ...policy(), hash: 'invalid' }]) {
    run.defaultSkills.repair = broken;
    const invalid = build(run);
    assert.deepEqual(invalid.skills.expectedStages, expected);
    assertInvalidStage(invalid, 'repair');
  }
});

test('Audit validates recorded known stages even when their roles are not required', async () => {
  const build = await builder();
  const run = runFixture();
  run.plan.tasks = [{ role: 'tester' }];
  const expected = ['analyze', 'plan', 'tester', 'review', 'complete'];
  assert.deepEqual(build(run).skills.expectedStages, expected);
  assert.equal(build(run).skills.complete, true);
  run.defaultSkills.documenter.skills.pop();
  assertInvalidStage(build(run), 'documenter');
});

test('Audit rejects unknown recorded stages without leaking their payload', async () => {
  const build = await builder();
  const run = runFixture();
  run.defaultSkills.unknown = { ...policy(), prompt: privateMarker };
  const report = build(run);
  assertIncomplete(report);
  assert.deepEqual(report.skills.expectedStages, stages);
  assert.ok(!JSON.stringify(report).includes(privateMarker));
});

test('Audit cannot replace a missing expected stage with an extra stage of the same count', async () => {
  const build = await builder();
  const run = runFixture();
  delete run.defaultSkills.tester;
  run.defaultSkills.repair = policy();
  const report = build(run);
  assertIncomplete(report);
  assert.deepEqual(report.skills.expectedStages, ['analyze', 'plan', 'developer', 'tester', 'documenter', 'review', 'repair', 'complete']);
  assert.deepEqual(report.skills.missingStages, ['tester']);
  assert.equal(report.skills.recordedStages.length, 7);
  assert.ok(report.skills.stages.every(entry => entry.valid));
});

test('Audit keeps old runs inspectable with missing coverage and null receipts', async () => {
  const build = await builder();
  const report = build({ id: 'old-run', state: 'awaiting_plan' });
  assertIncomplete(report);
  assertKeys(report, topKeys);
  assert.equal(report.runId, 'old-run');
  assert.equal(report.state, 'awaiting_plan');
  assert.equal(report.baseSha, null);
  assert.equal(report.headSha, null);
  assert.deepEqual(report.skills.expectedStages, ['analyze', 'plan', 'review', 'complete']);
  assert.deepEqual(report.skills.missingStages, ['analyze', 'plan', 'review', 'complete']);
  assert.deepEqual(report.skills.recordedStages, []);
  for (const key of ['checks', 'review', 'delivery', 'release']) assert.equal(report[key], null);
});

for (const [name, value] of [
  ['missing', undefined], ['null', null], ['array', []], ['string', 'invalid'], ['number', 7], ['empty object', {}]
]) test(`Audit treats ${name} policy container as incomplete`, async () => {
  const build = await builder();
  const run = runFixture();
  run.defaultSkills = value;
  const report = build(run);
  assertIncomplete(report);
  assert.deepEqual(report.skills.missingStages, stages);
});

for (const [name, plan] of [
  ['missing plan', undefined], ['null plan', null], ['array plan', []], ['missing tasks', {}],
  ['null tasks', { tasks: null }], ['object tasks', { tasks: {} }], ['string tasks', { tasks: 'tester' }],
  ['empty tasks', { tasks: [] }], ['null task', { tasks: [null] }], ['missing role', { tasks: [{}] }],
  ['invalid role', { tasks: [{ role: 'invented' }] }], ['stage used as role', { tasks: [{ role: 'review' }] }],
  ['mixed valid and malformed tasks', { tasks: [{ role: 'tester' }, null] }]
]) test(`Audit cannot claim completeness with ${name}`, async () => {
  const build = await builder();
  const run = runFixture();
  run.plan = plan;
  assertIncomplete(build(run));
});

const badStages = [
  ['null stage', () => null], ['array stage', () => []], ['string stage', () => 'invalid'],
  ...[
    ['missing', undefined], ['null', null], ['non-string', 64], ['object', {}], ['empty', ''],
    ['short', 'a'.repeat(63)], ['long', 'a'.repeat(65)], ['uppercase', 'AB'.repeat(32)],
    ['non-hex', 'g'.repeat(64)], ['trailing newline', hash + '\n']
  ].map(([name, value]) => [`${name} hash`, entry => ({ ...entry, hash: value })]),
  ...[
    ['missing', undefined], ['null', null], ['object', {}], ['string', 'invalid'], ['empty', []]
  ].map(([name, value]) => [`${name} skill list`, entry => ({ ...entry, skills: value })]),
  ['missing default skill', entry => ({ ...entry, skills: entry.skills.slice(1) })],
  ['duplicate default skill', entry => ({ ...entry, skills: [...entry.skills.slice(1), entry.skills[1]] })],
  ['extra skill', entry => ({ ...entry, skills: [...entry.skills, { ...entry.skills[0], id: 'skills/extra' }] })],
  ['unknown skill replaces default', entry => ({ ...entry, skills: [{ ...entry.skills[0], id: 'skills/extra' }, ...entry.skills.slice(1)] })]
];
for (const [name, breakStage] of badStages) test(`Audit invalidates ${name}`, async () => {
  const build = await builder();
  const run = runFixture();
  run.defaultSkills.analyze = breakStage(policy());
  assertInvalidStage(build(run), 'analyze');
});

const badDecisions = [
  ['null decision', () => null], ['array decision', () => []], ['primitive decision', () => false],
  ...[
    ['missing id', 'id', undefined], ['non-string id', 'id', {}], ['empty id', 'id', ''],
    ['missing applies', 'applies', undefined], ['null applies', 'applies', null],
    ['string applies', 'applies', 'false'], ['numeric applies', 'applies', 1],
    ['missing reason', 'reason', undefined], ['null reason', 'reason', null], ['numeric reason', 'reason', 1],
    ['empty reason', 'reason', ''], ['blank reason', 'reason', ' \t\n '],
    ['missing revision', 'revision', undefined], ['null revision', 'revision', null],
    ['non-string revision', 'revision', {}], ['empty revision', 'revision', ''],
    ['short revision', 'revision', 'a'.repeat(39)], ['long revision', 'revision', 'a'.repeat(41)],
    ['uppercase revision', 'revision', 'AB'.repeat(20)], ['non-hex revision', 'revision', 'g'.repeat(40)],
    ['newline revision', 'revision', revision + '\n']
  ].map(([name, field, value]) => [name, decision => ({ ...decision, [field]: value })])
];
for (const [name, breakDecision] of badDecisions) test(`Audit invalidates ${name} for applicable and non-applicable skills`, async () => {
  const build = await builder();
  for (const applies of [true, false]) {
    const run = runFixture();
    run.defaultSkills.tester.skills[0] = breakDecision({ ...decisions()[0], applies });
    assertInvalidStage(build(run), 'tester');
  }
});

test('Audit allowlists receipts and omits tasks prompts source paths config and provider output', async () => {
  const build = await builder();
  const run = runFixture();
  for (const key of ['task', 'config', 'nodes', 'analysis', 'research', 'prompt', 'project', 'cwd', 'artifacts', 'worktreeRoot', 'env', 'credentials', 'planningContext']) {
    run[key] = { private: privateMarker };
  }
  run.plan.private = privateMarker;
  for (const entry of Object.values(run.defaultSkills)) {
    entry.prompt = privateMarker;
    for (const decision of entry.skills) Object.assign(decision, { source: privateMarker, arbitrary: { text: privateMarker } });
  }
  run.checks = { headSha, command: privateMarker, results: [
    { exitCode: 0, command: { args: [privateMarker] }, stdout: privateMarker },
    { exitCode: 2, stderr: privateMarker, provider: privateMarker }
  ] };
  run.review = { passed: false, headSha, diffHash: hash, findings: [privateMarker], provider: privateMarker };
  run.delivery = { pr: { number: 42, url: 'https://example.invalid/pull/42', body: privateMarker }, reviewedHead: headSha, mergeCommit: baseSha, diffHash: privateMarker, release: { private: privateMarker } };
  run.release = {
    version: '1.2.3', tag: 'v1.2.3', commit: baseSha, url: 'https://example.invalid/releases/v1.2.3',
    artifact: 'kodo-1.2.3.tgz', artifactUrl: 'https://example.invalid/kodo-1.2.3.tgz', sha256: hash,
    published: true, smoke: { passed: false, node: 'v24.19.0', platform: 'win32', stdout: privateMarker },
    path: privateMarker, output: privateMarker
  };
  const report = build(run);
  assertKeys(report, topKeys);
  assert.deepEqual(report.checks, { headSha, results: [{ exitCode: 0 }, { exitCode: 2 }] });
  assert.deepEqual(report.review, { passed: false, headSha, diffHash: hash });
  assert.deepEqual(report.delivery, { pr: { number: 42, url: 'https://example.invalid/pull/42' }, reviewedHead: headSha, mergeCommit: baseSha });
  assert.deepEqual(report.release, {
    version: '1.2.3', tag: 'v1.2.3', commit: baseSha, url: 'https://example.invalid/releases/v1.2.3',
    artifact: 'kodo-1.2.3.tgz', artifactUrl: 'https://example.invalid/kodo-1.2.3.tgz', sha256: hash,
    published: true, smoke: { passed: false, node: 'v24.19.0', platform: 'win32' }
  });
  assert.equal(report.skills.complete, true, 'coverage is independent of check, review and release success');
  for (const entry of report.skills.stages) {
    assertKeys(entry, ['stage', 'hash', 'valid', 'skills']);
    for (const skill of entry.skills) assertKeys(skill, ['id', 'applies', 'reason', 'revision']);
  }
  assert.ok(!JSON.stringify(report).includes(privateMarker));
});

test('Audit does not copy nested arbitrary values through malformed allowlisted receipt fields', async () => {
  const build = await builder();
  const run = runFixture(), unsafe = { prompt: privateMarker };
  run.baseSha = unsafe; run.headSha = [unsafe];
  run.checks = { headSha: unsafe, results: [{ exitCode: unsafe }, null, unsafe] };
  run.review = { passed: unsafe, headSha: unsafe, diffHash: unsafe };
  run.delivery = { pr: { number: unsafe, url: unsafe }, reviewedHead: unsafe, mergeCommit: unsafe };
  run.release = Object.fromEntries(['version', 'tag', 'commit', 'url', 'artifact', 'artifactUrl', 'sha256', 'published'].map(key => [key, unsafe]));
  run.release.smoke = { passed: unsafe, node: unsafe, platform: unsafe };
  const report = build(run);
  assert.equal(report.baseSha, null);
  assert.equal(report.headSha, null);
  assert.ok(!JSON.stringify(report).includes(privateMarker));
});

test('Audit preserves false receipt booleans and zero exit codes without coercing malformed scalars', async () => {
  const build = await builder();
  const run = runFixture();
  run.checks = { headSha, results: [{ exitCode: 0 }, { exitCode: '0' }, { exitCode: false }] };
  run.review = { passed: false, headSha, diffHash: hash };
  run.release = { published: false, smoke: { passed: false, node: 'v24.19.0', platform: 'win32' } };
  const report = build(run);
  assert.deepEqual(report.checks, { headSha, results: [{ exitCode: 0 }, {}, {}] });
  assert.deepEqual(report.review, { passed: false, headSha, diffHash: hash });
  assert.deepEqual(report.release, { published: false, smoke: { passed: false, node: 'v24.19.0', platform: 'win32' } });
  for (const value of ['false', 'true', 0, 1, [], {}]) {
    run.review.passed = value;
    run.release.published = value;
    run.release.smoke.passed = value;
    const invalid = build(run);
    assert.equal(Object.hasOwn(invalid.review, 'passed'), false);
    assert.equal(Object.hasOwn(invalid.release, 'published'), false);
    assert.equal(Object.hasOwn(invalid.release.smoke, 'passed'), false);
  }
});

test('Audit malformed policy diagnostics never echo arbitrary fields or invalid object values', async () => {
  const build = await builder();
  const run = runFixture();
  run.defaultSkills.tester = { hash: { prompt: privateMarker }, extra: privateMarker, skills: [
    { id: { private: privateMarker }, applies: { private: privateMarker }, reason: { private: privateMarker }, revision: { private: privateMarker }, source: privateMarker }
  ] };
  const report = build(run);
  assertInvalidStage(report, 'tester');
  assert.ok(!JSON.stringify(report).includes(privateMarker));
});

test('Audit does not leak nested values through malformed run identity fields', async () => {
  const build = await builder();
  const run = runFixture();
  run.id = { prompt: privateMarker };
  run.state = [{ config: privateMarker }];
  const report = build(run);
  assertKeys(report, topKeys);
  assert.ok(!JSON.stringify(report).includes(privateMarker));
});

test('Audit tolerates malformed receipts on otherwise inspectable saved runs', async () => {
  const build = await builder();
  for (const value of [null, false, 4, 'invalid', [], {}]) {
    const run = runFixture();
    for (const key of ['checks', 'review', 'delivery', 'release']) run[key] = value;
    const report = build(run);
    assertKeys(report, topKeys);
    assert.equal(report.skills.complete, true);
  }
});

test('Audit never mutates nested input including shuffled arrays malformed policies and receipts', async () => {
  const build = await builder();
  for (const malformed of [false, true]) {
    const run = runFixture();
    run.defaultSkills.tester.skills.reverse();
    run.checks = { headSha, results: [{ exitCode: 0, stdout: privateMarker }] };
    run.review = { passed: true, headSha, diffHash: hash, findings: [privateMarker] };
    run.delivery = { pr: { number: 4, url: 'https://example.invalid/pull/4', raw: privateMarker } };
    run.release = { published: false, smoke: { passed: false, node: 'v24.19.0', platform: 'win32', stdout: privateMarker } };
    if (malformed) run.defaultSkills.plan.hash = null;
    const before = structuredClone(run);
    build(run);
    assert.deepEqual(run, before);
    build(deepFreeze(run));
    assert.deepEqual(run, before);
  }
});

test('Audit rejects invalid root inputs but accepts an empty legacy run object', async () => {
  const build = await builder();
  for (const value of [undefined, null, [], 'run', 42, false]) assert.throws(() => build(value));
  assertIncomplete(build({}));
});

test('Audit pure builder succeeds with filesystem writes and child processes forbidden', async () => {
  await builder();
  // Unlike Store opening SQLite, the pure builder needs no writable directory.
  const script = `import assert from 'node:assert/strict';
    import { buildAuditReport } from ${JSON.stringify(auditUrl.href)};
    const report = buildAuditReport(${JSON.stringify(runFixture())});
    assert.equal(report.skills.complete, true);
    assert.equal(typeof report.then, 'undefined');
    console.log(JSON.stringify(report));`;
  const result = spawnSync(process.execPath, ['--permission', '--allow-fs-read=*', '--input-type=module', '--eval', script], {
    encoding: 'utf8', timeout: 10_000, windowsHide: true,
    env: { SystemRoot: process.env.SystemRoot, NODE_NO_WARNINGS: '1' }
  });
  assert.ifError(result.error);
  assert.equal(result.signal, null);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).runId, 'audit-contract-run');
});
