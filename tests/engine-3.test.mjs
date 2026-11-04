import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Engine } from '../runtime/engine.mjs';
import { read, exists, git, fixture, node, fakeServices, integrationConflict, combinedModule, refreshFixture } from './helpers/engine-fixture.mjs';

test('Engine configured gates block review and repairs receive only safe findings', async t => {
  for (const autocrlf of ['false', 'true']) await t.test(`core.autocrlf=${autocrlf}`, async subtest => {
    const fx = await fixture(subtest, { config: { repairRounds: 2, security: { enabled: true } } }), services = fakeServices();
    git(fx.project, 'config', 'core.autocrlf', autocrlf);
    let gateCalls = 0, repairCalls = 0;
    const gates = {
      runSecurityChecks: async ({ headSha }) => {
        gateCalls++;
        return { headSha, status: 'failed', passed: false, tools: [{ tool: 'semgrep', status: 'failed', findings: [{ ruleId: 'safe-rule', file: 'src/value.mjs', line: 1, severity: 'ERROR', Secret: 'RAW_PRIVATE_FINDING' }], stderr: 'RAW_PRIVATE_STDERR' }] };
      },
      isCurrentSecurityReceipt: () => false
    };
    const original = services.provider.runSession;
    services.provider.runSession = async request => {
      if (/Repair confirmed failures/.test(request.prompt)) {
        repairCalls++;
        assert.match(request.prompt, /safe-rule/); assert.doesNotMatch(request.prompt, /RAW_PRIVATE/);
        return { output: { summary: 'No code fix', checks: [], complete: true } };
      }
      return original(request);
    };
    const engine = new Engine({ store: fx.openStore(), ...services, gates }), run = await engine.create('Scan feature', { project: fx.project });
    const result = await engine.run(run.id);
    const diagnostic = JSON.stringify({ error: result.error, nodes: Object.values(result.nodes).map(({ id, status, error }) => ({ id, status, error })) });
    assert.equal(result.state, 'blocked', diagnostic);
    assert.equal(result.completed.implementation, true, diagnostic);
    assert.ok(result.securityChecks, diagnostic);
    assert.equal(gateCalls, 2, diagnostic); assert.equal(repairCalls, 1, diagnostic);
    assert.equal(result.securityChecks.status, 'failed'); assert.equal(services.calls.review.length, 0);
    assert.ok(result.controllerAssessment); assert.equal(result.controllerAssessment.automaticRetries, false);
  });
});

test('Engine distinguishes incomplete verification output from a completed repair interrupted before commit', async t => {
  for (const complete of [false, true]) await t.test(complete ? 'completed-before-cancel' : 'incomplete-output', async subtest => {
    const fx = await fixture(subtest, { config: { repairRounds: 2, researchBudget: 0 },
      testScript: "import assert from 'node:assert/strict'; import {value} from './src/value.mjs'; assert.equal(value, 3);\n" });
    const services = fakeServices({ plan: { summary: 'value three', tasks: [node('feature', 'developer', ['src/value.mjs'])] } });
    const original = services.provider.runSession, controller = new AbortController(); let repairs = 0;
    services.provider.runSession = async request => {
      if (!/Repair confirmed failures/.test(request.prompt)) return original(request);
      repairs++; request.onEvent({ sessionId: 'verification-completion-session' });
      if (repairs === 1 && !complete) return { sessionId: 'verification-completion-session', output: { complete: false, summary: 'Unfinished repair', checks: [] } };
      if (repairs > 1) assert.equal(request.sessionId, 'verification-completion-session');
      await writeFile(path.join(request.cwd, 'src/value.mjs'), 'export const value = 3;\n');
      if (complete) controller.abort();
      return { sessionId: 'verification-completion-session', output: { complete: true, summary: 'Repaired value', checks: [] } };
    };
    const firstStore = fx.openStore(), firstEngine = new Engine({ store: firstStore, ...services });
    const run = await firstEngine.create('Persist verification completion', { project: fx.project });
    const paused = await firstEngine.run(run.id, { signal: controller.signal });
    assert.equal(paused.state, complete ? 'cancelled' : 'blocked', paused.error?.message);
    assert.equal(paused.verification.attempt, 1); assert.equal(paused.verification.stopped, undefined);
    assert.equal(services.calls.review.length, 0);
    if (complete) assert.notEqual(git(paused.cwd, 'status', '--porcelain'), '', 'cancellation leaves the completed repair for scoped commit recovery');
    fx.closeStore(firstStore);
    const store = fx.openStore(), engine = new Engine({ store, ...services });
    const result = await engine.run(run.id, { resumeCancelled: complete });
    assert.equal(result.state, 'succeeded', result.error?.message);
    assert.equal(repairs, complete ? 1 : 2, 'completed repair output survives reopening SQLite and must not launch another repair session');
    assert.equal(result.verification.pendingRepair, undefined); assert.equal(result.verification.attempt, 1);
    assert.equal(result.checks.headSha, result.headSha); assert.equal(result.review.headSha, result.headSha);
    assert.equal(services.calls.worker.length, 1); assert.equal(services.calls.review.length, 1);
    assert.equal(store.events(run.id).filter(event => event.type === 'check_started').length, 2);
    assert.equal(git(result.cwd, 'status', '--porcelain'), '');
  });
});

test('Engine serializes two ready tasks with overlapping write scopes even when Jev permits parallel work', async t => {
  const script = "import assert from 'node:assert/strict'; import {readFileSync} from 'node:fs'; assert.equal(readFileSync('shared.txt','utf8'), 'base\\nfirst\\nsecond\\n');\n";
  const fx = await fixture(t, { testScript: script });
  const plan = { summary: 'Append two lines in order.', tasks: [
    node('first', 'developer', ['shared.txt'], [], 'append first'),
    node('second', 'developer', ['shared.txt'], [], 'append second')
  ] };
  let active = 0, maxActive = 0;
  const sequence = [];
  const services = fakeServices({ plan, onWorker: async request => {
    const label = /Your task: append (first|second)/.exec(request.prompt)?.[1];
    assert.ok(label);
    active++; maxActive = Math.max(maxActive, active); sequence.push(`start-${label}`);
    try {
      await new Promise(resolve => setImmediate(resolve));
      const filename = path.join(request.cwd, 'shared.txt');
      const before = await read(filename);
      assert.equal(before, label === 'first' ? 'base\n' : 'base\nfirst\n');
      await writeFile(filename, `${before}${label}\n`);
      sequence.push(`finish-${label}`);
      return { sessionId: `append-${label}`, output: { summary: `appended ${label}`, checks: [], complete: true } };
    } finally { active--; }
  } });
  const engine = new Engine({ store: fx.openStore(), ...services });
  const run = await engine.create('Append first and second', { project: fx.project });
  const result = await engine.run(run.id);
  assert.equal(result.state, 'succeeded', result.error?.message);
  assert.equal(maxActive, 1);
  assert.deepEqual(sequence, ['start-first', 'finish-first', 'start-second', 'finish-second']);
  assert.equal(await read(path.join(result.cwd, 'shared.txt')), 'base\nfirst\nsecond\n');
  assert.equal(await read(path.join(fx.project, 'shared.txt')), 'base\n');
});

test('Engine resolves target branch conflicts then invalidates checks and review before redelivery', async t => {
  const fx = await fixture(t, { remote: true, config: { repairRounds: 2, delivery: { enabled: true, release: false } }, testScript: "import assert from 'node:assert/strict'; import {value} from './src/value.mjs'; assert.equal(value, 2);\n" });
  const plan = { summary: 'Set value two.', tasks: [node('feature', 'developer', ['src/value.mjs'])] };
  let conflictResolutions = 0, upstreamSha;
  const services = fakeServices({ plan, onWorker: async request => {
    if (request.role === 'developer') await writeFile(path.join(request.cwd, 'src/value.mjs'), 'export const value = 2;\n');
    else {
      assert.match(request.prompt, /conflict/i);
      conflictResolutions++;
      await writeFile(path.join(request.cwd, 'src/value.mjs'), "export const value = 2;\nexport const remoteAddition = 'kept';\n");
      git(request.cwd, 'add', 'src/value.mjs');
    }
    return { sessionId: `target-merge-${services.calls.worker.length}`, output: { summary: 'changes preserved', checks: [], complete: true } };
  } });
  services.delivery.deliver = async ({ run, review }) => {
    services.calls.delivery++;
    if (services.calls.delivery === 1) {
      const other = path.join(fx.directory, 'other-client');
      git(fx.directory, 'clone', '--branch', 'main', path.join(fx.directory, 'origin.git'), other);
      git(other, 'config', 'user.name', 'Other Kodo Task'); git(other, 'config', 'user.email', 'other@example.invalid');
      git(other, 'config', 'core.autocrlf', 'false');
      await writeFile(path.join(other, 'src/value.mjs'), "export const value = 4;\nexport const remoteAddition = 'kept';\n");
      git(other, 'add', '.'); git(other, 'commit', '-m', 'Concurrent main update'); git(other, 'push', 'origin', 'main');
      upstreamSha = git(other, 'rev-parse', 'HEAD');
      throw Object.assign(new Error('target moved before merge'), { code: 'stale_base' });
    }
    assert.equal(run.baseSha, upstreamSha);
    assert.equal(review.headSha, run.headSha);
    assert.equal(run.checks.headSha, run.headSha);
    return { pr: { number: 1, url: 'https://example.invalid/pull/1' }, mergeCommit: run.headSha };
  };
  const engine = new Engine({ store: fx.openStore(), ...services });
  const run = await engine.create('Implement value two', { project: fx.project });
  const result = await engine.run(run.id);
  assert.equal(result.state, 'succeeded', result.error?.message);
  assert.equal(conflictResolutions, 1);
  assert.equal(services.calls.delivery, 2);
  assert.equal(services.calls.review.length, 2);
  assert.notEqual(result.headSha, result.nodes.feature.headSha);
  assert.equal(result.review.headSha, result.headSha);
  assert.match(await read(path.join(result.cwd, 'src/value.mjs')), /remoteAddition = 'kept'/);
  assert.equal(git(fx.project, 'rev-parse', 'HEAD'), fx.base);
});

test('Engine keeps the per run research ceiling when two failures request research concurrently', async t => {
  const fx = await fixture(t, { testScript: 'process.exit(0);\n' });
  const services = fakeServices();
  services.researcher = async ({ budget }) => {
    await new Promise(resolve => setImmediate(resolve));
    return { items: [], requests: budget, errors: [], cache: [] };
  };
  const engine = new Engine({ store: fx.openStore(), ...services });
  const run = await engine.create('Concurrent research fixture', { project: fx.project });
  run.research = { items: [], requests: 1, errors: [], cache: [] };
  engine.save(run);
  await Promise.all([engine.moreResearch(run, 'first failed node'), engine.moreResearch(run, 'second failed node')]);
  assert.equal(run.research.requests, run.config.researchBudget);
  assert.equal(engine.store.getRun(run.id).research.requests, run.config.researchBudget);
});

test('Engine resumes a staged resolved node merge without rerunning the resolver', async t => {
  let resolutions = 0;
  const fx = await integrationConflict(t, async () => {
    resolutions++;
    throw new Error('resolved staged merge must not need another resolver session');
  });
  const merge = spawnSync('git', ['merge', '--no-ff', '--no-edit', fx.run.nodes.second.branch], { cwd: fx.run.cwd, encoding: 'utf8', windowsHide: true });
  assert.equal(merge.status, 1, merge.stderr);
  assert.match(git(fx.run.cwd, 'diff', '--name-only', '--diff-filter=U'), /src\/value.mjs/);
  await writeFile(path.join(fx.run.cwd, 'src/value.mjs'), combinedModule);
  git(fx.run.cwd, 'add', 'src/value.mjs');
  assert.equal(git(fx.run.cwd, 'diff', '--name-only', '--diff-filter=U'), '');
  const resumed = fx.store.getRun(fx.run.id);
  await fx.engine.integrateNode(resumed, fx.tasks[1]);
  assert.equal(resolutions, 0);
  assert.equal(resumed.nodes.second.status, 'integrated');
  assert.equal(await read(path.join(resumed.cwd, 'src/value.mjs')), combinedModule);
  assert.equal(git(resumed.cwd, 'status', '--porcelain'), '');
  assert.equal(git(resumed.cwd, 'rev-parse', 'HEAD'), resumed.headSha);
});

test('Engine scopes review repairs to the repair starting head instead of earlier coordinator release edits', async t => {
  const fx = await fixture(t, { remote: true, config: { repairRounds: 2 }, testScript: "import assert from 'node:assert/strict'; import {value} from './src/value.mjs'; assert.equal(value, 2);\n" });
  const plan = { summary: 'Set value two.', tasks: [node('feature', 'developer', ['src/value.mjs'])] };
  let repairs = 0;
  const services = fakeServices({ plan, onWorker: async request => {
    if (request.role === 'developer') await writeFile(path.join(request.cwd, 'src/value.mjs'), 'export const value = 2;\n');
    else {
      assert.match(request.prompt, /Repair confirmed failures/);
      repairs++;
      await writeFile(path.join(request.cwd, 'src/value.mjs'), 'export const value = 2;\nexport const reviewFix = true;\n');
    }
    return { sessionId: `versioned-repair-${services.calls.worker.length}`, output: { summary: 'implemented', checks: [], complete: true } };
  }, onReview: async (_request, calls) => ({
    sessionId: `versioned-review-${calls.review.length}`,
    output: calls.review.length === 1
      ? { passed: false, findings: [{ file: 'src/value.mjs', severity: 'major', problem: 'reviewFix marker missing', fix: 'Add the marker' }] }
      : { passed: true, findings: [] }
  }) });
  services.delivery.prepareReleaseVersion = async ({ cwd }) => {
    await writeFile(path.join(cwd, 'registry.json'), '{"version":"0.2.0"}\n');
  };
  const engine = new Engine({ store: fx.openStore(), ...services });
  const run = await engine.create('Implement value two with reviewFix', { project: fx.project });
  const result = await engine.run(run.id);
  assert.equal(result.state, 'succeeded', result.error?.message);
  assert.equal(repairs, 1);
  assert.equal(services.calls.review.length, 2);
  assert.equal(JSON.parse(await read(path.join(result.cwd, 'registry.json'))).version, '0.2.0');
  assert.match(await read(path.join(result.cwd, 'src/value.mjs')), /reviewFix = true/);
  assert.equal(result.checks.headSha, result.headSha);
  assert.equal(result.review.headSha, result.headSha);
  assert.equal(await exists(path.join(fx.project, 'registry.json')), false);
});

test('Engine follows Jev fresh session decisions after a defect and uses the configured primary model on fallback', async t => {
  const fx = await fixture(t, { config: { repairRounds: 2 }, testScript: 'process.exit(0);\n' });
  const task = node('feature', 'developer', ['src/value.mjs']);
  const services = fakeServices({ plan: { summary: 'Repair with a fresh session', tasks: [task] }, onWorker: async (request, calls) => {
    assert.equal(request.sessionId, undefined, 'a confirmed defect with Jev=fresh must get a new session');
    return { sessionId: `attempt-${calls.worker.length}`, output: { summary: 'attempt', checks: [], complete: calls.worker.length > 1 } };
  } });
  services.provider.decideJev = async ({ node: candidate, attempt }) => {
    if (attempt > 0) assert.equal(candidate.sessionId, 'attempt-1');
    return { model: 'codex-sol', parallel: false, confidence: 0.95, sessionMode: 'fresh' };
  };
  const engine = new Engine({ store: fx.openStore(), ...services });
  const run = await engine.create('Fresh session after a defect', { project: fx.project }); const result = await engine.run(run.id);
  assert.equal(result.state, 'succeeded', result.error?.message); assert.equal(services.calls.worker.length, 2);
  result.config.primaryModel = 'gpt-6-astra';
  services.provider.decideJev = async () => ({ model: 'codex-sol', fallback: true, confidence: 0, parallel: false });
  const selected = await engine.route(result, task, { attempt: 0 });
  assert.equal(selected.id, 'codex-astra');
  services.provider.decideJev = async () => ({ model: 'codex-sol', parallel: 'yes', confidence: 1.5 });
  await assert.rejects(engine.route(result, task, { attempt: 0 }), { code: 'invalid_output' });
});

test('Engine recovers interrupted version metadata only when all other fields are unchanged', async t => {
  for (const tampered of [false, true]) await t.test(tampered ? 'extra-field-rejected' : 'version-only-recovered', async subtest => {
    const fx = await fixture(subtest, { testScript: 'process.exit(0);\n' });
    await writeFile(path.join(fx.project, 'package.json'), JSON.stringify({ name: 'fixture-kodo', version: '0.1.0' }));
    git(fx.project, 'add', '.'); git(fx.project, 'commit', '-m', 'Version baseline');
    const services = fakeServices(), engine = new Engine({ store: fx.openStore(), ...services });
    const run = await engine.create('Recover version assignment', { project: fx.project }); await engine.prepare(run);
    run.plan = { summary: 'value two', tasks: [node('feature', 'developer', ['src/value.mjs'])] };
    run.config.delivery.release = true; run.releaseAssignment = { version: '0.2.0', prepared: false };
    const value = { name: 'fixture-kodo', version: '0.2.0', ...(tampered ? { scripts: { preinstall: 'unexpected executable' } } : {}) };
    await writeFile(path.join(run.cwd, 'package.json'), JSON.stringify(value));
    const before = git(run.cwd, 'rev-parse', 'HEAD');
    if (tampered) {
      await assert.rejects(engine.recoverIntegrationEdits(run), { code: 'scope_conflict' });
      assert.equal(git(run.cwd, 'rev-parse', 'HEAD'), before);
    } else {
      await engine.recoverIntegrationEdits(run);
      assert.notEqual(git(run.cwd, 'rev-parse', 'HEAD'), before);
      assert.equal(JSON.parse(git(run.cwd, 'show', 'HEAD:package.json')).version, '0.2.0');
      assert.equal(git(run.cwd, 'status', '--porcelain'), '');
    }
  });
});

test('Engine aborts a worker action when its subscription lease is lost and releases the old token', async t => {
  const fx = await fixture(t); const store = fx.openStore();
  const engine = new Engine({ store, leaseHeartbeatMs: 1 });
  const run = await engine.create('Guard subscription lease', { project: fx.project });
  let aborted = false, released = 0;
  const release = store.releaseLease.bind(store);
  store.renewLease = () => false;
  store.releaseLease = token => { released++; release(token); };
  await assert.rejects(engine.withLease(run, 'subscription:fixture', 1, async signal => {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(resolve, 1000);
      signal.addEventListener('abort', () => { aborted = true; clearTimeout(timer); reject(new Error('action aborted')); }, { once: true });
    });
  }), { code: 'lease_lost' });
  assert.equal(aborted, true); assert.equal(released, 1);
});

test('Engine resumes an interrupted conflicted node refresh against its recorded incoming head and exact repair session', async t => {
  let repairs = 0;
  const fx = await refreshFixture(t, async request => {
    if (!request.role) {
      repairs++;
      if (repairs === 1) { request.onEvent({ sessionId: 'refresh-repair-session' }); throw Object.assign(new Error('quota in refresh resolver'), { code: 'quota' }); }
      assert.equal(request.sessionId, 'refresh-repair-session');
      await writeFile(path.join(request.cwd, 'src/value.mjs'), 'export const value = 2;\nexport const upstream = true;\n');
    }
    return { sessionId: request.role ? 'worker-after-refresh' : 'refresh-repair-session', output: { summary: 'preserved both', checks: [], complete: true } };
  }, true);
  await assert.rejects(fx.engine.performNode(fx.run, fx.task), { code: 'quota' });
  const resumed = fx.store.getRun(fx.run.id);
  assert.equal(resumed.nodes.feature.pendingRefresh.headSha, fx.target);
  await fx.engine.performNode(resumed, fx.task);
  assert.equal(resumed.nodes.feature.status, 'completed'); assert.equal(resumed.nodes.feature.baseSha, fx.target);
  assert.equal(resumed.nodes.feature.pendingRefresh, undefined); assert.deepEqual(resumed.nodes.feature.changedFiles, ['src/value.mjs']);
  assert.equal(await read(path.join(fx.cwd, 'upstream-fix.txt')), 'incoming outside task scope\n');
  assert.match(await read(path.join(fx.cwd, 'src/value.mjs')), /upstream = true/);
});
