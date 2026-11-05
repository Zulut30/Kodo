import test from 'node:test';
import assert from 'node:assert/strict';

const P = '11111111-1111-4111-8111-111111111111';
const R = '22222222-2222-4222-8222-222222222222';
const A = '33333333-3333-4333-8333-333333333333';
const head = 'a'.repeat(40);
const criterion = id => ({ id, text: 'Observable result', evidenceKinds: ['acceptance'] });
function fixture() {
  let serial = 0;
  const ref = kind => ({ kind, runId: R, headSha: head, path: `C:/isolated-evidence/${kind}.json`, sha256: (++serial).toString(16).padStart(64, '0') });
  const evidence = ['acceptance', 'checks', 'review', 'delivery', 'release'].map(ref);
  const task = { id: 'work', epicId: 'epic', projectId: P, revision: 1, status: 'verifying', dependsOn: [], interfaceRefs: [], acceptance: [criterion('task-done')], evidence: [], mappings: [], riskApprovalRequired: false };
  const attempt = { id: A, projectId: P, taskId: task.id, taskRevision: 1, number: 1, runId: R, contractHash: 'c'.repeat(64), status: 'verifying', headSha: head, evidence };
  const mappings = [{ criterionId: 'task-done', refs: [evidence[0].sha256], actor: 'tester', reason: 'Verified result' }];
  const snapshot = { schemaVersion: 1, project: { id: 'project', projectId: P, revision: 7, status: 'running', paused: false, definitionOfDone: [criterion('project-done')], evidence: [], mappings: [] }, revision: 7,
    milestones: [{ id: 'milestone', projectId: P, status: 'accepted', releaseRequired: true, acceptance: [criterion('milestone-done')], evidence: [], mappings: [] }],
    epics: [{ id: 'epic', milestoneId: 'milestone', projectId: P, status: 'accepted', acceptance: [criterion('epic-done')], evidence: [], mappings: [] }],
    tasks: [task], currentAttempts: [attempt], riskApprovals: [], completeness: {} };
  for (const key of ['milestones', 'epics', 'tasks', 'currentAttempts', 'riskApprovals']) snapshot.completeness[key] = { total: snapshot[key].length, returned: snapshot[key].length, complete: true };
  const commandLine = { command: 'node', args: ['--test'], timeoutMs: 1000 };
  const run = { id: R, project: 'C:/isolated-project', state: 'succeeded', headSha: head, directorBinding: { schemaVersion: 1, projectId: P, taskId: task.id, taskRevision: 1, attemptId: A, runId: R, contractHash: attempt.contractHash },
    plan: { tasks: [{ id: 'developer' }] }, nodes: { developer: { status: 'integrated', headSha: head } },
    config: { commands: { test: [commandLine], build: [] }, uiVerification: { enabled: false }, security: { enabled: true }, architecture: { enabled: false } },
    checks: { schemaVersion: 2, complete: true, headSha: head, results: [{ kind: 'test', command: commandLine, exitCode: 0 }] },
    review: { passed: true, headSha: head }, securityChecks: { status: 'passed', passed: true, headSha: head },
    delivery: { mergeCommit: head }, release: { published: true, commit: head, sha256: 'd'.repeat(64) } };
  const ports = { knownValues: [], contracts: { normalizeDirectorRecord: (_kind, value) => structuredClone(value), assertDirectorSafe() {} }, verifyRef: async () => {}, validateRun: async () => {} };
  return { snapshot, attempt, run, mappings, evidence, ports };
}
const attemptEvaluation = async f => (await import('../runtime/project-evidence.mjs')).evaluateProjectAttempt(f, f.ports);
const transitionEvaluation = async f => (await import('../runtime/project-evidence.mjs')).evaluateProjectTransition(f, f.ports);
function command(f, kind, id, to, criterionId) {
  return { schemaVersion: 1, commandId: '44444444-4444-4444-8444-444444444444', projectId: P, expectedRevision: 7, actor: 'coordinator', reason: 'Verified transition', action: { op: 'transition', kind, id, to, evidence: f.evidence, mappings: [{ ...f.mappings[0], criterionId }] } };
}

test('Acceptance awaits both trusted validators and requires verified publication separately', async () => {
  const f = fixture(); let refs = 0, runs = 0;
  f.ports.verifyRef = async () => { await new Promise(resolve => setImmediate(resolve)); refs++; };
  f.ports.validateRun = async () => { await new Promise(resolve => setImmediate(resolve)); runs++; };
  const result = await attemptEvaluation(f);
  assert.ok(result.eligibleStates.includes('accepted'));
  assert.ok(result.eligibleStates.includes('released'));
  assert.equal(runs, 1); assert.equal(refs, f.evidence.length);
  f.attempt.evidence = f.evidence.filter(ref => !['release', 'delivery'].includes(ref.kind));
  const local = await attemptEvaluation(f);
  assert.ok(local.eligibleStates.includes('accepted')); assert.ok(!local.eligibleStates.includes('released'));
  assert.deepEqual(local.blockers, []);
});

test('Accepted proof without future publication has no blockers but explicit release stays blocked', async () => {
  const f = fixture();
  f.attempt.evidence = f.evidence.filter(ref => !['release', 'delivery'].includes(ref.kind));
  delete f.run.release; delete f.run.delivery;
  const accepted = await attemptEvaluation(f);
  assert.ok(accepted.eligibleStates.includes('accepted'));
  assert.ok(!accepted.eligibleStates.includes('released'));
  assert.deepEqual(accepted.blockers, []);
  f.command = command(f, 'attempt', A, 'accepted', 'task-done');
  f.command.action.evidence = f.attempt.evidence;
  assert.deepEqual((await transitionEvaluation(f)).blockers, []);
  f.command.action.to = 'released';
  const released = await transitionEvaluation(f);
  assert.ok(!released.eligibleStates.includes('released'));
  assert.ok(released.blockers.includes('publication_proof_missing'));
});

for (const [name, mutate] of [
  ['publication prose', f => { f.run.release = { published: true, tag: 'v1.0.0' }; }],
  ['unpublished release', f => { f.run.release.published = false; }],
  ['missing release digest', f => { delete f.run.release.sha256; }],
  ['missing delivery ref', f => { f.attempt.evidence = f.evidence.filter(ref => ref.kind !== 'delivery'); }],
  ['missing release ref', f => { f.attempt.evidence = f.evidence.filter(ref => ref.kind !== 'release'); }],
]) test(`Accepted proof cannot become released from ${name}`, async () => {
  const f = fixture(); mutate(f);
  const result = await attemptEvaluation(f);
  assert.ok(result.eligibleStates.includes('accepted'));
  assert.ok(!result.eligibleStates.includes('released'));
  assert.deepEqual(result.blockers, []);
  f.command = command(f, 'attempt', A, 'released', 'task-done');
  f.command.action.evidence = f.attempt.evidence;
  const transition = await transitionEvaluation(f);
  assert.ok(!transition.eligibleStates.includes('released'));
  assert.ok(transition.blockers.includes('publication_proof_missing'));
});

for (const [name, mutate] of [
  ['completed text', f => { f.run = { id: R, completed: { implementation: true }, state: 'succeeded' }; }],
  ['stale checks', f => { f.run.checks.headSha = 'b'.repeat(40); }],
  ['stale review', f => { f.run.review.headSha = 'b'.repeat(40); }],
  ['missing mapping', f => { f.mappings = []; }],
  ['missing evidence kind', f => { f.attempt.evidence = f.evidence.filter(ref => ref.kind !== 'checks'); }],
  ['missing gate', f => { delete f.run.securityChecks; }],
  ['enabled gate marked disabled', f => { f.run.securityChecks.status = 'disabled'; }],
  ['missing command result', f => { f.run.checks.results = []; }],
  ['unfinished child run node', f => { f.run.nodes.developer.status = 'completed'; }],
  ['cross-project binding', f => { f.run.directorBinding.projectId = R; }],
  ['stale task revision', f => { f.snapshot.tasks[0].revision++; }],
  ['noncurrent attempt', f => { f.snapshot.currentAttempts = []; f.snapshot.completeness.currentAttempts = { total: 0, returned: 0, complete: true }; }],
  ['incomplete snapshot', f => { f.snapshot.completeness.tasks.complete = false; }],
  ['pause control', f => { f.snapshot.project.paused = true; }],
  ['cancel control', f => { f.run.cancelRequested = true; }],
  ['failed actual run', f => { f.run.state = 'failed'; }],
  ['receipt attached to created run', f => { f.run.state = 'created'; }],
  ['missing trusted validator', f => { delete f.ports.validateRun; }],
  ['caller boolean validator', f => { f.ports.validateRun = true; }],
  ['validator decision value', f => { f.ports.validateRun = async () => true; }],
  ['async invalid run', f => { f.ports.validateRun = async () => { await Promise.resolve(); throw Error('FAKE_SECRET'); }; }],
  ['async tampered ref', f => { f.ports.verifyRef = async () => { await Promise.resolve(); throw Error('FAKE_SECRET'); }; }],
]) test(`No acceptance from ${name}`, async () => {
  const f = fixture(); mutate(f);
  const result = await attemptEvaluation(f);
  assert.ok(!result.eligibleStates.includes('accepted'));
  assert.ok(!result.eligibleStates.includes('released'));
  assert.ok(result.blockers.length); assert.ok(!JSON.stringify(result).includes('FAKE_SECRET'));
});

test('Accepted and released history cannot be demoted by later invalid evidence', async () => {
  for (const status of ['accepted', 'released']) {
    const f = fixture(); f.attempt.status = status; f.ports.validateRun = async () => { throw Error('stale'); };
    assert.deepEqual((await attemptEvaluation(f)).eligibleStates, [status]);
    f.command = command(f, 'attempt', A, 'failed', 'task-done');
    assert.ok(!(await transitionEvaluation(f)).eligibleStates.includes('failed'));
  }
});

test('Containers require complete accepted children and their own mapped criteria', async () => {
  const f = fixture(); f.snapshot.tasks[0].status = 'accepted';
  f.command = command(f, 'epic', 'epic', 'accepted', 'epic-done');
  f.snapshot.epics[0].status = 'integrated';
  assert.ok((await transitionEvaluation(f)).eligibleStates.includes('accepted'));
  f.command.action.mappings = f.mappings;
  assert.ok(!(await transitionEvaluation(f)).eligibleStates.includes('accepted'));
  f.command.action.mappings[0].criterionId = 'epic-done'; f.snapshot.tasks[0].status = 'integrated';
  assert.ok(!(await transitionEvaluation(f)).eligibleStates.includes('accepted'));
});

test('Project release waits for releaseRequired milestones and cannot use forged command state', async () => {
  const f = fixture(); f.snapshot.project.status = 'accepted'; f.snapshot.tasks[0].status = 'accepted';
  f.command = command(f, 'project', P, 'released', 'project-done');
  assert.ok(!(await transitionEvaluation(f)).eligibleStates.includes('released'));
  f.snapshot.milestones[0].status = 'released';
  assert.ok((await transitionEvaluation(f)).eligibleStates.includes('released'));
  f.command.expectedRevision = 6;
  assert.ok(!(await transitionEvaluation(f)).eligibleStates.includes('released'));
});

function projectAcceptanceFixture() {
  const f = fixture();
  f.snapshot.project.status = 'integrated'; f.snapshot.tasks[0].status = 'accepted';
  f.evidence = f.evidence.filter(ref => !['release', 'delivery'].includes(ref.kind));
  f.command = command(f, 'project', P, 'accepted', 'project-done');
  return f;
}

test('Project acceptance uses UUID command identity with complete children and own proof', async () => {
  const f = projectAcceptanceFixture(); let runs = 0, refs = 0;
  f.ports.validateRun = async () => { await Promise.resolve(); runs++; };
  f.ports.verifyRef = async () => { await Promise.resolve(); refs++; };
  const result = await transitionEvaluation(f);
  assert.notEqual(f.snapshot.project.id, f.command.action.id);
  assert.ok(result.eligibleStates.includes('accepted'));
  assert.ok(!result.eligibleStates.includes('released'));
  assert.deepEqual(result.blockers, []);
  assert.equal(runs, 1); assert.equal(refs, f.evidence.length);
});

for (const [name, mutate] of [
  ['display slug', f => { f.command.action.id = f.snapshot.project.id; }],
  ['wrong UUID', f => { f.command.action.id = R; }],
  ['wrong project', f => { f.command.projectId = R; }],
  ['stale revision', f => { f.command.expectedRevision--; }],
  ['unaccepted child', f => { f.snapshot.milestones[0].status = 'integrated'; }],
  ['incomplete children', f => { f.snapshot.completeness.milestones.complete = false; }],
  ['missing own mapping', f => { f.command.action.mappings = []; }],
  ['borrowed task criterion', f => { f.command.action.mappings = f.mappings; }],
  ['missing own proof', f => { f.command.action.evidence = []; }],
  ['wrong run binding', f => { f.run.directorBinding.projectId = R; }],
  ['async tampered ref', f => { f.ports.verifyRef = async () => { await Promise.resolve(); throw Error('tamper'); }; }],
  ['async invalid run', f => { f.ports.validateRun = async () => { await Promise.resolve(); throw Error('invalid'); }; }],
]) test(`Project UUID acceptance still rejects ${name}`, async () => {
  const f = projectAcceptanceFixture(); mutate(f);
  const result = await transitionEvaluation(f);
  assert.ok(!result.eligibleStates.includes('accepted'));
  assert.ok(!result.eligibleStates.includes('released'));
  assert.ok(result.blockers.length);
});

test('Readiness awaits interface refs and checks current dependencies and risk approval', async () => {
  const f = fixture(); const task = f.snapshot.tasks[0]; task.status = 'proposed';
  task.interfaceRefs = [{ ...f.evidence[0], kind: 'interface' }]; task.riskApprovalRequired = true;
  f.command = command(f, 'task', task.id, 'ready', 'task-done');
  assert.ok(!(await transitionEvaluation(f)).eligibleStates.includes('ready'));
  f.snapshot.riskApprovals = [{ projectId: P, taskId: task.id, taskRevision: 1 }];
  f.snapshot.completeness.riskApprovals = { total: 1, returned: 1, complete: true };
  assert.ok((await transitionEvaluation(f)).eligibleStates.includes('ready'));
  f.ports.verifyRef = async () => { throw Error('tamper'); };
  assert.ok(!(await transitionEvaluation(f)).eligibleStates.includes('ready'));
});

test('No implicit trust when contracts are unavailable or snapshot identity/completeness is forged', async () => {
  for (const mutate of [f => { f.snapshot.revision++; }, f => { f.snapshot.completeness.tasks.total++; }, f => { f.snapshot.tasks.push({ ...f.snapshot.tasks[0] }); }, f => { f.snapshot.tasks[0].projectId = R; }]) {
    const f = fixture(); mutate(f); assert.ok(!(await attemptEvaluation(f)).eligibleStates.includes('accepted'));
  }
});

test('Container acceptance cannot omit actual run verification', async () => {
  const f = fixture(); f.snapshot.tasks[0].status = 'accepted'; f.snapshot.epics[0].status = 'integrated';
  f.command = command(f, 'epic', 'epic', 'accepted', 'epic-done'); delete f.run;
  assert.ok(!(await transitionEvaluation(f)).eligibleStates.includes('accepted'));
});

test('A container cannot borrow a validated run from a sibling epic', async () => {
  const f = fixture();
  f.snapshot.epics.push({ ...f.snapshot.epics[0], id: 'sibling', status: 'integrated', acceptance: [criterion('sibling-done')] });
  f.snapshot.tasks.push({ ...f.snapshot.tasks[0], id: 'sibling-work', epicId: 'sibling', status: 'accepted' });
  for (const key of ['tasks', 'epics']) f.snapshot.completeness[key] = { total: f.snapshot[key].length, returned: f.snapshot[key].length, complete: true };
  f.command = command(f, 'epic', 'sibling', 'accepted', 'sibling-done');
  assert.ok(!(await transitionEvaluation(f)).eligibleStates.includes('accepted'));
});

test('Release chain can bind a verified merge commit different from checked HEAD', async () => {
  const f = fixture(); const merge = 'b'.repeat(40);
  f.run.delivery.mergeCommit = merge; f.run.release.commit = merge;
  for (const ref of f.evidence.filter(ref => ['delivery', 'release'].includes(ref.kind))) ref.headSha = merge;
  assert.ok((await attemptEvaluation(f)).eligibleStates.includes('released'));
  f.run.release.commit = 'e'.repeat(40);
  assert.ok(!(await attemptEvaluation(f)).eligibleStates.includes('released'));
});

test('Task transition validates command evidence once and never executes validators twice', async () => {
  const f = fixture(); f.attempt.evidence = []; let runs = 0; let refs = 0;
  f.command = command(f, 'task', 'work', 'accepted', 'task-done');
  f.ports.validateRun = async () => { runs++; }; f.ports.verifyRef = async () => { refs++; };
  assert.ok((await transitionEvaluation(f)).eligibleStates.includes('accepted'));
  assert.equal(runs, 1); assert.equal(refs, f.evidence.length);
});

test('Accepted attempt history is not fresh authorization for an unaccepted task', async () => {
  const f = fixture(); f.attempt.status = 'accepted';
  f.command = command(f, 'task', 'work', 'accepted', 'task-done');
  f.ports.validateRun = async () => { throw Error('stale'); };
  assert.ok(!(await transitionEvaluation(f)).eligibleStates.includes('accepted'));
});

test('Attempt acceptance retains dependency, risk and frozen interface requirements', async () => {
  for (const mutate of [f => { f.snapshot.tasks[0].dependsOn = ['absent']; }, f => { f.snapshot.tasks[0].riskApprovalRequired = true; }, f => {
    f.snapshot.tasks[0].interfaceRefs = [{ ...f.evidence[0], kind: 'interface' }];
    f.ports.verifyRef = async ref => { if (ref.kind === 'interface') throw Error('tamper'); };
  }]) { const f = fixture(); mutate(f); assert.ok(!(await attemptEvaluation(f)).eligibleStates.includes('accepted')); }
});

test('Container lifecycle can reach integrated before all children are accepted', async () => {
  const f = fixture(); f.snapshot.tasks[0].status = 'integrated'; f.snapshot.epics[0].status = 'verifying';
  f.command = command(f, 'epic', 'epic', 'integrated', 'epic-done');
  assert.ok((await transitionEvaluation(f)).eligibleStates.includes('integrated'));
  f.command.action.to = 'accepted';
  assert.ok(!(await transitionEvaluation(f)).eligibleStates.includes('accepted'));
});

test('Caller-forged accepted or released attempt state cannot masquerade as stored history', async () => {
  for (const status of ['accepted', 'released']) {
    const f = fixture(); f.attempt = { ...f.attempt, status };
    const evaluation = await attemptEvaluation(f);
    assert.ok(!evaluation.eligibleStates.includes(status));
  }
});

test('Complete 1000-task snapshot is not assumed truncated', async () => {
  const f = fixture();
  f.snapshot.tasks.push(...Array.from({ length: 999 }, (_, i) => ({ ...f.snapshot.tasks[0], id: `backlog-${i}`, status: 'proposed' })));
  f.snapshot.completeness.tasks = { total: 1000, returned: 1000, complete: true };
  assert.ok((await attemptEvaluation(f)).eligibleStates.includes('accepted'));
});

test('Disabled gates stay neutral while every enabled gate must have fresh proof', async () => {
  const f = fixture(); f.run.uiVerification = { status: 'failed', passed: false };
  assert.ok((await attemptEvaluation(f)).eligibleStates.includes('accepted'));
  f.run.config.uiVerification.enabled = true;
  assert.ok(!(await attemptEvaluation(f)).eligibleStates.includes('accepted'));
});

for (const key of ['milestones', 'epics', 'currentAttempts', 'riskApprovals']) test(`Incomplete ${key} cannot authorize acceptance`, async () => {
  const f = fixture(); f.snapshot.completeness[key].complete = false;
  assert.ok(!(await attemptEvaluation(f)).eligibleStates.includes('accepted'));
});

for (const [name, mutate] of [
  ['wrong run reference', f => { f.evidence[0].runId = P; }],
  ['conflicting digest identity', f => { f.attempt.evidence.push({ ...f.evidence[0], path: 'C:/other-evidence.json' }); }],
  ['wrong criterion kind', f => { f.snapshot.tasks[0].acceptance[0].evidenceKinds = ['contract']; }],
  ['unknown criterion', f => { f.mappings[0].criterionId = 'other'; }],
  ['stale attempt head', f => { f.attempt.headSha = 'e'.repeat(40); }],
  ['missing ref verifier', f => { delete f.ports.verifyRef; }],
]) test(`Additional proof boundary: ${name}`, async () => {
  const f = fixture(); mutate(f);
  assert.ok(!(await attemptEvaluation(f)).eligibleStates.includes('accepted'));
});
