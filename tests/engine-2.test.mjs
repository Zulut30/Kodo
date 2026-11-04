import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Engine } from '../runtime/engine.mjs';
import { makeWorktree, diffHash } from '../runtime/workspace.mjs';
import { createHash } from 'node:crypto';
import { runUIVerification } from '../runtime/ui-verification.mjs';
import { read, exists, git, fixture, node, fakeServices, integrationConflict, combinedModule, refreshFixture } from './helpers/engine-fixture.mjs';

test('Engine five verification rounds stop with persisted controller assessment until explicit retry', async t => {
  const fx = await fixture(t, { config: { executionMode: 'deep', repairRounds: 5 }, testScript: 'process.exit(0);\n' });
  const services = fakeServices({ plan: { summary: 'one', tasks: [node('feature', 'developer', ['src/value.mjs'])] } });
  services.provider.runSession = async request => {
    if (request.schema.properties.tasks) return { output: { summary: 'one', tasks: [node('feature', 'developer', ['src/value.mjs'])] } };
    if (request.schema.properties.passed) { services.calls.review.push(request); return { output: { passed: false, findings: [{ severity: 'major', file: 'src/value.mjs', problem: `remaining ${services.calls.review.length}`, fix: 'Implement remaining requirement' }] } }; }
    await writeFile(path.join(request.cwd, 'src/value.mjs'), `export const value = ${services.calls.review.length};\n`);
    return { output: { summary: 'changed', checks: [], complete: true } };
  };
  const engine = new Engine({ store: fx.openStore(), ...services }), run = await engine.create('Bound repairs', { project: fx.project });
  const blocked = await engine.run(run.id);
  assert.equal(blocked.state, 'blocked'); assert.equal(services.calls.review.length, 5);
  assert.equal(blocked.controllerAssessment.reason, 'repair_budget_exhausted'); assert.equal(blocked.controllerAssessment.attempts, 5);
  await engine.run(run.id); assert.equal(services.calls.review.length, 5, 'ordinary resume must not reset the budget');
  await engine.run(run.id, { retryFailed: true }); assert.equal(services.calls.review.length, 10);
  assert.equal(engine.store.getRun(run.id).verification.previousCycles[0].attempt, 5);
});

test('Engine keeps partial pending verification repair out of HEAD until the exact session completes', async t => {
  const fx = await fixture(t, { config: { repairRounds: 2, researchBudget: 0 },
    testScript: "import assert from 'node:assert/strict'; import {value} from './src/value.mjs'; assert.equal(value, 3);\n" });
  const services = fakeServices({ plan: { summary: 'value three', tasks: [node('feature', 'developer', ['src/value.mjs'])] } });
  const original = services.provider.runSession, repairSnapshots = [];
  let store = fx.openStore();
  services.provider.runSession = async request => {
    if (!/Repair confirmed failures/.test(request.prompt)) return original(request);
    repairSnapshots.push({ headSha: git(request.cwd, 'rev-parse', 'HEAD'), committed: git(request.cwd, 'show', 'HEAD:src/value.mjs'),
      working: await read(path.join(request.cwd, 'src/value.mjs')), complete: store.getRun(run.id).verification.pendingRepair.complete });
    if (repairSnapshots.length > 1) assert.equal(request.sessionId, 'partial-verification-session');
    request.onEvent({ sessionId: 'partial-verification-session' });
    if (repairSnapshots.length <= 2) {
      await writeFile(path.join(request.cwd, 'src/value.mjs'), 'export const value = 99;\n');
      throw Object.assign(new Error('fixture quota after partial file write'), { code: 'quota' });
    }
    await writeFile(path.join(request.cwd, 'src/value.mjs'), 'export const value = 3;\n');
    return { sessionId: 'partial-verification-session', output: { complete: true, summary: 'repair completed', checks: [] } };
  };
  let engine = new Engine({ store, ...services });
  const run = await engine.create('Keep unfinished repair uncommitted', { project: fx.project });
  let failedHead;
  for (let interruption = 1; interruption <= 2; interruption++) {
    const paused = await engine.run(run.id);
    assert.equal(paused.state, 'waiting_limits', paused.error?.message); assert.equal(paused.error.code, 'quota');
    failedHead ||= paused.verification.pendingRepair.headSha;
    assert.equal(git(paused.cwd, 'rev-parse', 'HEAD'), failedHead, 'incomplete repair writes must never be committed by generic recovery');
    assert.equal(git(paused.cwd, 'show', 'HEAD:src/value.mjs'), 'export const value = 2;');
    assert.equal(await read(path.join(paused.cwd, 'src/value.mjs')), 'export const value = 99;\n');
    assert.notEqual(git(paused.cwd, 'status', '--porcelain'), '');
    assert.equal(paused.verification.attempt, 1); assert.notEqual(paused.verification.pendingRepair.complete, true);
    assert.equal(paused.verification.pendingRepair.sessionId, 'partial-verification-session');
    fx.closeStore(store); store = fx.openStore(); engine = new Engine({ store, ...services });
  }
  const result = await engine.run(run.id);
  assert.equal(result.state, 'succeeded', result.error?.message); assert.equal(repairSnapshots.length, 3);
  for (const snapshot of repairSnapshots) {
    assert.equal(snapshot.headSha, failedHead); assert.equal(snapshot.committed, 'export const value = 2;'); assert.notEqual(snapshot.complete, true);
  }
  assert.deepEqual(repairSnapshots.map(snapshot => snapshot.working), ['export const value = 2;\n', 'export const value = 99;\n', 'export const value = 99;\n']);
  assert.equal(git(result.cwd, 'show', 'HEAD:src/value.mjs'), 'export const value = 3;');
  assert.equal(git(result.cwd, 'rev-list', '--count', `${failedHead}..HEAD`), '1', 'only the completed repair becomes a commit');
  assert.equal(result.verification.pendingRepair, undefined); assert.equal(result.verification.attempt, 1); assert.equal(result.verification.cycle, 1);
  assert.equal(result.verification.previousCycles, undefined); assert.equal(result.controllerAssessment, undefined);
  assert.equal(result.checks.headSha, result.headSha); assert.equal(result.review.headSha, result.headSha);
  assert.equal(result.uiVerification.headSha, result.headSha); assert.equal(result.securityChecks.headSha, result.headSha);
  assert.equal(services.calls.worker.length, 1); assert.equal(services.calls.review.length, 1);
  assert.equal(store.events(run.id).filter(event => event.type === 'check_started').length, 2);
  assert.equal(store.events(run.id).filter(event => event.type === 'repair_recovered').length, 0);
  assert.equal(store.events(run.id).filter(event => event.type === 'retry_requested').length, 0);
  assert.equal(git(result.cwd, 'status', '--porcelain'), ''); assert.equal(git(fx.project, 'rev-parse', 'HEAD'), fx.base);
});

test('Engine node budgets stop after five or earlier identical no progress and persist the assessment', async t => {
  for (const repeated of [false, true]) await t.test(repeated ? 'identical-no-progress' : 'five-distinct-attempts', async subtest => {
    const fx = await fixture(subtest, { config: { executionMode: 'deep', repairRounds: 5 }, testScript: 'process.exit(0);\n' });
    let workers = 0;
    const services = fakeServices({ plan: { summary: 'one', tasks: [node('feature', 'developer', ['src/value.mjs'])] }, onWorker: async () => ({ output: { complete: false, checks: [], summary: repeated ? 'same unresolved requirement' : `remaining requirement ${++workers}` } }) });
    if (repeated) { const original = services.provider.runSession; services.provider.runSession = request => { if (!request.schema.properties.tasks) workers++; return original(request); }; }
    const engine = new Engine({ store: fx.openStore(), ...services }), run = await engine.create('Bound node repairs', { project: fx.project });
    const blocked = await engine.run(run.id), expected = repeated ? 2 : 5;
    assert.equal(blocked.state, 'blocked'); assert.equal(workers, expected); assert.equal(blocked.nodes.feature.status, 'blocked');
    assert.equal(blocked.controllerAssessment.attempts, expected); assert.equal(blocked.controllerAssessment.reason, repeated ? 'no_progress' : 'repair_budget_exhausted');
    await engine.run(run.id); assert.equal(workers, expected);
  });
});

test('Engine runs enabled UI after local checks and rejects evidence changed during independent review', async t => {
  const fx = await fixture(t, { config: { uiVerification: { enabled: true, autoInstall: false, cases: [{ id: 'fixture', tool: 'browser-harness', url: 'http://127.0.0.1:1', assertions: [{ selector: 'body', text: 'Ready' }] }] } } });
  const services = fakeServices(), store = fx.openStore(); let created, gateCalls = 0;
  const gates = { runUIVerification: async options => {
    const saved = store.getRun(created.id); assert.equal(saved.checks.headSha, options.headSha); assert.equal(saved.checks.results[0].exitCode, 0); gateCalls++;
    return runUIVerification({ ...options, caseRunner: async () => ({ schemaVersion: 1, status: 'completed', observations: [{ exists: true, count: 1, text: 'Ready', value: null }] }) });
  } };
  services.provider.runSession = ((original) => async request => {
    if (request.schema.properties.passed) {
      assert.equal(gateCalls, 1); const saved = store.getRun(created.id); assert.equal(saved.uiVerification.status, 'passed');
      await writeFile(saved.uiVerification.cases[0].evidence[0].path, 'tampered after gate');
    }
    return original(request);
  })(services.provider.runSession);
  const engine = new Engine({ store, ...services, gates }); created = await engine.create('Bind UI evidence', { project: fx.project });
  const blocked = await engine.run(created.id);
  assert.equal(blocked.state, 'blocked'); assert.equal(blocked.error.code, 'stale_verification'); assert.equal(blocked.review, null); assert.equal(blocked.uiVerification, null);
});

test('Engine exposes only managed ready ripgrep on worker PATH while provider credentials stay scrubbed', async t => {
  const fx = await fixture(t), command = path.join(fx.directory, 'managed-tools', 'rg.exe');
  const engine = new Engine({ store: fx.openStore(), secrets: { GEMINI_API_KEY: 'private-fixture-key' }, tools: { resolveTool: async id => { assert.equal(id, 'ripgrep'); return { id, ready: true, command, args: [] }; } } });
  const run = await engine.create('Scoped code search', { project: fx.project });
  const environment = await engine.executionEnvironment(run, fx.project);
  const pathKey = Object.keys(environment).find(key => key.toLowerCase() === 'path');
  assert.deepEqual(environment[pathKey].split(path.delimiter).slice(0, 2), [path.dirname(process.execPath), path.dirname(command)]);
  assert.equal(environment.GEMINI_API_KEY, undefined); assert.equal(environment.TYPESAFE_API_KEY, undefined); assert.equal(environment.OPENAI_API_KEY, undefined);
});

test('Engine allows credential-handling source text and hashes its exact Git diff while rejecting actual secrets', async t => {
  const fx = await fixture(t);
  const secret = 'fixture-configured-private-value';
  const engine = new Engine({ store: fx.openStore(), secrets: { GEMINI_API_KEY: secret } });
  const file = path.join(fx.project, 'src/value.mjs');
  await writeFile(file, 'export const auth = token => `Bearer ${token}`;\n');
  assert.deepEqual(await engine.checkScope(fx.project, fx.base, ['src/value.mjs']), ['src/value.mjs']);
  git(fx.project, 'add', '.'); git(fx.project, 'commit', '-m', 'credential handling source');
  const native = git(fx.project, 'diff', '--binary', `${fx.base}...HEAD`);
  assert.equal(await diffHash(fx.project, fx.base), createHash('sha256').update(native.trimEnd()).digest('hex'));
  await writeFile(file, `export const accidental = '${secret}';\n`);
  await assert.rejects(engine.checkScope(fx.project, fx.base, ['src/value.mjs']), /Секрет обнаружен/);
});

test('Engine cancellation interrupts a running worker without starting review or delivery', async t => {
  const fx = await fixture(t, { testScript: 'process.exit(0);\n' }), controller = new AbortController();
  const plan = { summary: 'Set value two.', tasks: [node('feature', 'developer', ['src/value.mjs'])] };
  const services = fakeServices({ plan, onWorker: async request => {
    request.onEvent({ sessionId: 'cancelled-worker-session' });
    controller.abort();
    assert.equal(request.signal.aborted, true);
    throw Object.assign(new Error('fixture cancelled'), { code: 'cancelled' });
  } });
  const store = fx.openStore(), engine = new Engine({ store, ...services });
  const run = await engine.create('Implement value two', { project: fx.project });
  const result = await engine.run(run.id, { signal: controller.signal });
  assert.equal(result.state, 'cancelled');
  assert.equal(result.error.code, 'cancelled');
  assert.equal(services.calls.worker.length, 1);
  assert.equal(services.calls.review.length, 0);
  assert.equal(services.calls.delivery, 0);
  const again = await engine.run(run.id);
  assert.equal(again.state, 'cancelled');
  assert.equal(services.calls.worker.length, 1);
  assert.equal(git(fx.project, 'rev-parse', 'HEAD'), fx.base);
  assert.equal(await read(path.join(fx.project, 'src/value.mjs')), 'export const value = 0;\n');
});

test('Engine rejects a staged rename that deletes an unowned source path', async t => {
  const fx = await fixture(t, { testScript: 'process.exit(0);\n' });
  git(fx.project, 'mv', 'untouched.txt', 'src/renamed.txt');
  const engine = new Engine({ store: fx.openStore() });
  await assert.rejects(engine.checkScope(fx.project, fx.base, ['src/renamed.txt']), /вне области задачи: untouched.txt/);
});

test('Engine rejects resolver scope violations and secret writes before merge commit', async t => {
  const cases = [
    { id: 'outside-scope', secret: false, expected: /вне области задачи: untouched.txt/ },
    { id: 'secret-in-owned-file', secret: true, expected: /Секрет обнаружен/ }
  ];
  for (const entry of cases) await t.test(entry.id, async subtest => {
    const secret = 'fixture-private-secret-for-resolver-only';
    const fx = await integrationConflict(subtest, async request => {
      await writeFile(path.join(request.cwd, 'src/value.mjs'), combinedModule + (entry.secret ? `export const accidentalKey = '${secret}';\n` : ''));
      if (!entry.secret) await writeFile(path.join(request.cwd, 'untouched.txt'), 'unauthorized resolver edit\n');
      return { sessionId: 'invalid-resolver', output: { summary: 'resolved', checks: [], complete: true } };
    }, { GEMINI_API_KEY: secret });
    const before = git(fx.run.cwd, 'rev-parse', 'HEAD');
    await assert.rejects(fx.engine.integrateNode(fx.run, fx.tasks[1]), entry.expected);
    assert.equal(git(fx.run.cwd, 'rev-parse', 'HEAD'), before);
    assert.notEqual(fx.run.nodes.second.status, 'integrated');
    assert.equal(await read(path.join(fx.project, 'untouched.txt')), 'committed content\n');
  });
});

test('Engine refreshes a retried node from integrated upstream while preserving its scoped unfinished tests', async t => {
  const fx = await fixture(t, { testScript: 'process.exit(0);\n' });
  const task = node('tests', 'tester', ['tests/retained.mjs']);
  const services = fakeServices({ plan: { summary: 'Preserve pending test', tasks: [task] }, onWorker: async request => {
    assert.equal(await read(path.join(request.cwd, 'upstream-fix.txt')), 'fixed baseline\n');
    assert.equal(await read(path.join(request.cwd, 'tests/retained.mjs')), 'unfinished test content\n');
    return { sessionId: 'refreshed-test', output: { summary: 'preserved and checked', checks: ['baseline observed'], complete: true } };
  } });
  const store = fx.openStore(), engine = new Engine({ store, ...services });
  const run = await engine.create('Refresh a retried test', { project: fx.project });
  await engine.prepare(run); run.plan = { summary: 'Preserve pending test', tasks: [task] }; run.models = await services.provider.discoverProviders();
  const cwd = path.join(store.home, 'worktrees', run.id, task.id), branch = `kodo/${run.id}-${task.id}`;
  await makeWorktree(fx.project, cwd, branch, fx.base);
  await mkdir(path.join(cwd, 'tests')); await writeFile(path.join(cwd, 'tests/retained.mjs'), 'unfinished test content\n');
  run.nodes[task.id] = { id: task.id, status: 'pending', attempt: 0, cwd, branch, baseSha: fx.base };
  await writeFile(path.join(run.cwd, 'upstream-fix.txt'), 'fixed baseline\n'); git(run.cwd, 'add', '.'); git(run.cwd, 'commit', '-m', 'Integrated baseline fix');
  engine.save(run); const head = git(run.cwd, 'rev-parse', 'HEAD');
  await engine.performNode(run, task);
  assert.equal(run.nodes.tests.status, 'completed'); assert.equal(run.nodes.tests.baseSha, head);
  assert.deepEqual(run.nodes.tests.changedFiles, ['tests/retained.mjs']);
  assert.equal(await exists(path.join(fx.project, 'tests/retained.mjs')), false);
});

test('Engine reassigns a stale release version and repeats checks and review before retrying delivery', async t => {
  const fx = await fixture(t, { remote: true, testScript: 'process.exit(0);\n' });
  const plan = { summary: 'Set value two', tasks: [node('feature', 'developer', ['src/value.mjs'])] };
  const services = fakeServices({ plan }); let assignments = 0;
  services.delivery.prepareReleaseVersion = async ({ cwd }) => {
    assignments++; await writeFile(path.join(cwd, 'registry.json'), JSON.stringify({ version: `0.2.${assignments}` }));
  };
  services.delivery.deliver = async ({ run, review }) => {
    services.calls.delivery++;
    if (services.calls.delivery === 1) throw Object.assign(new Error('Version claimed by another task'), { code: 'stale_base' });
    assert.equal(assignments, 2); assert.equal(JSON.parse(await read(path.join(run.cwd, 'registry.json'))).version, '0.2.2');
    assert.equal(review.headSha, git(run.cwd, 'rev-parse', 'HEAD')); assert.equal(run.checks.headSha, review.headSha);
    return { mergeCommit: review.headSha, pr: { number: 1 } };
  };
  const engine = new Engine({ store: fx.openStore(), ...services });
  const run = await engine.create('Release version refresh', { project: fx.project }); const result = await engine.run(run.id);
  assert.equal(result.state, 'succeeded', result.error?.message); assert.equal(assignments, 2);
  assert.equal(services.calls.review.length, 2); assert.equal(services.calls.release, 1);
});

test('Engine recovers a completed node refresh merge when its base receipt was not saved', async t => {
  const fx = await refreshFixture(t, async () => ({ sessionId: 'recovered-refresh-worker', output: { summary: 'done', checks: [], complete: true } }));
  fx.run.nodes.feature.pendingRefresh = { headSha: fx.target, model: 'codex-sol' }; fx.engine.save(fx.run);
  git(fx.cwd, 'merge', '--no-edit', fx.target); // Crash after merge, before updating baseSha.
  const resumed = fx.store.getRun(fx.run.id);
  await fx.engine.performNode(resumed, fx.task);
  assert.equal(resumed.nodes.feature.status, 'completed'); assert.equal(resumed.nodes.feature.baseSha, fx.target);
  assert.deepEqual(resumed.nodes.feature.changedFiles, ['src/value.mjs']);
});
