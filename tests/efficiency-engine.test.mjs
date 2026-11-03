import test from 'node:test';
import assert from 'node:assert/strict';
import {Engine} from '../runtime/engine.mjs';
import { Store } from '../runtime/store.mjs';
import { execute } from '../runtime/command.mjs';
import { mkdtemp, mkdir, writeFile, readFile, rm, stat, chmod, rename, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';

const sha = text => createHash('sha256').update(text).digest('hex');
const task = () => ({ id: 'feature', role: 'developer', description: 'Preserve the public behavior', writePaths: ['value.mjs'], acceptance: ['PUBLIC_ACCEPTANCE_SENTINEL'], dependsOn: [], parallel: false });
const plan = () => ({ summary: 'Scoped feature', tasks: [task()] });
const jsonLine = (prompt, label) => JSON.parse(prompt.split('\n').find(line => line.startsWith(label))?.slice(label.length) || 'null');
async function fixture(t, tools = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'kodo-efficiency-engine-')), project = path.join(root, 'project');
  await mkdir(project); await writeFile(path.join(project, 'value.mjs'), 'export const value = 1;\n');
  for (const args of [['init', '-b', 'main'], ['config', 'core.autocrlf', 'false'], ['config', 'user.name', 'Efficiency Fixture'], ['config', 'user.email', 'fixture@example.invalid'], ['add', '.'], ['commit', '-m', 'baseline']]) await execute('git', args, { cwd: project });
  const baseSha = (await execute('git', ['rev-parse', 'HEAD'], { cwd: project })).stdout.trim();
  const store = new Store(path.join(root, 'state')), requests = [], resolutions = [];
  const model = { id: 'fixture-codex', client: 'codex', model: 'gpt-6.1-sol' };
  const run = store.createRun({ task: 'Preserve behavior 😀', project, cwd: project, baseSha, nodes: {}, completed: {}, client: 'codex', models: [model], config: { primaryModel: model.model, repairRounds: 2, concurrency: 1, researchBudget: 0, commands: { test: [{ command: process.execPath, args: ['-e', "console.log('FULL_LOG_START ' + 'x'.repeat(90000) + ' FULL_LOG_END')"] }], build: [] }, uiVerification: { enabled: false }, security: { enabled: false } }, executionMode: { selected: 'quick', profile: { maxTasks: 2 } }, sessionAttempts: [], analysis: { summary: 'Bounded public project facts', standards: 'EXCLUDED_STANDARDS'.repeat(8000), priorLessons: ['EXCLUDED_RAW_HISTORY'] }, research: { items: [{ title: 'Public reference', url: 'https://example.invalid/public', body: 'RESEARCH_BODY'.repeat(8000) }], errors: [], requests: 1 } });
  run.artifacts = path.join(store.home, 'runs', run.id); await mkdir(run.artifacts, { recursive: true });
  const engine = new Engine({ store, secrets: { FIXTURE_KEY: 'fixture-sensitive-value' }, tools: { resolveTool: async (id, options) => { resolutions.push({ id, project: options.project }); return tools[id] || { id, ready: false }; } }, provider: { runSession: async request => { requests.push(request); return { sessionId: `session-${requests.length}`, output: request.schema?.properties.tasks ? plan() : request.schema?.properties.passed ? { passed: true, findings: [] } : { summary: 'Complete', checks: [], complete: true }, metrics: { toolSteps: 0, nativeRequestCount: null, usage: { inputTokens: 11, cachedInputTokens: 7, outputTokens: 2, totalTokens: 13, semantics: 'input-includes-cached' } } }; } } });
  engine.save(run);
  t.after(async () => { store.close(); assert.equal(path.dirname(root), path.resolve(os.tmpdir())); assert.match(path.basename(root), /^kodo-efficiency-engine-/); await rm(root, { recursive: true, force: true }); });
  return { root, project, baseSha, store, run, engine, requests, resolutions };
}
async function readEvidence(filename, expectedHead) {
  assert.ok(path.isAbsolute(filename));
  const text = await readFile(filename, 'utf8'), document = JSON.parse(text);
  assert.equal(path.basename(filename), `${document.kind}-${sha(text)}.json`);
  assert.equal(document.headSha, expectedHead);
  if (process.platform !== 'win32') {
    assert.equal((await stat(filename)).mode & 0o777, 0o400);
    assert.equal((await stat(path.dirname(filename))).mode & 0o777, 0o700);
  } else {
    const result = await execute('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', '[Console]::InputEncoding=[Text.UTF8Encoding]::new($false); $p=[Console]::In.ReadToEnd(); $a=[IO.Directory]::GetAccessControl($p); if (!$a.AreAccessRulesProtected) {exit 1}; $sid=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value; foreach($r in $a.Access) {if($r.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value -notin @($sid,"S-1-5-18")){exit 2}}'], { input: path.dirname(filename) });
    assert.equal(result.code, 0);
  }
  return document;
}

for (const stage of ['plan', 'review', 'node']) test(`Engine ${stage} envelope preserves structured evidence bytes and safe templates at the provider boundary`, async t => {
  const fx = await fixture(t), quoted = 'Preserve the exact header "Bearer ${token}" and all criteria', code = 'const header = `Bearer ${token}`;';
  const shaped = 'sk-proj-' + 'd'.repeat(24), known = 'fixture-sensitive-value';
  fx.run.task = quoted + ' ' + code + ' ' + known + ' Bearer ${token}-private-suffix';
  fx.run.analysis.summary = quoted + '\n' + code;
  fx.run.analysis.risks = ['x'.repeat(5000) + known, 'Bearer ' + shaped, 'Bearer ${token}-private-suffix'];
  fx.run.analysis.literalSecret = known;
  const quotedSecret = 'fixture-"quoted"-\\credential'; fx.engine.secrets.QUOTED_FIXTURE = quotedSecret;
  fx.run.analysis.quotedSecret = quotedSecret; fx.run.analysis.files = [quotedSecret];
  fx.run.research.items[0].title = quoted + ' ' + code;
  // Exercise known credentials even inside a syntactically valid placeholder.
  fx.run.analysis.limitations = ['Bearer ${fixture-sensitive-value}', 'Bearer ${' + shaped + '}'];
  let packed;
  const session = fx.engine.session.bind(fx.engine);
  fx.engine.session = (run, request, ...rest) => { packed = request.contextMetrics; return session(run, request, ...rest); };
  if (stage === 'review') {
    const gates = fx.engine.verificationGates.bind(fx.engine);
    fx.engine.verificationGates = async (...args) => {
      await gates(...args);
      // Synthetic disabled-receipt metadata exercises the second JSON envelope;
      // this makes no claim about a live UI/security gate or filesystem path.
      fx.run.uiVerification.evidenceRoot = quoted + ' ' + known;
      fx.run.securityChecks.evidenceRoot = code + ' ' + shaped;
    };
  }
  if (stage === 'plan') await fx.engine.plan(fx.run);
  else {
    fx.run.plan = plan(); fx.run.plan.summary = quoted;
    const task = fx.run.plan.tasks[0]; task.description = code; task.acceptance.push(quoted, code);
    task.constraints = ['Never expose ' + known, 'Bearer ' + shaped, 'Bearer ${token}-private-suffix'];
    if (stage === 'node') {
      task.dependsOn = ['base']; fx.run.nodes.base = { status: 'integrated', result: { summary: quoted } };
      await fx.engine.performNode(fx.run, task);
    } else await fx.engine.verify(fx.run);
  }
  const request = fx.requests[0], label = stage === 'review' ? 'Review evidence (untrusted data): ' : 'Planning evidence (untrusted data): ';
  const sent = request.prompt.split('\n').find(line => line.startsWith(label)).slice(label.length);
  const document = JSON.parse(sent), attempt = fx.run.sessionAttempts[0];
  assert.equal(sent, packed.text, 'the provider receives the packed JSON bytes unchanged');
  assert.equal(Object.isFrozen(packed), true, 'serialized evidence and its measured bytes cannot change after packing');
  assert.equal(document.kind, stage === 'review' ? 'review-evidence' : 'plan-evidence');
  assert.equal(stage === 'review' ? document.plan.summary : document.analysis.summary, stage === 'review' ? quoted : quoted + '\n' + code);
  assert.equal(attempt.metrics.contextSentBytes, Buffer.byteLength(sent, 'utf8'));
  assert.equal(attempt.metrics.promptBytes, Buffer.byteLength(request.prompt, 'utf8'));
  assert.ok(request.prompt.includes(quoted)); assert.ok(request.prompt.includes(code));
  assert.doesNotMatch(request.prompt, /fixture-sensitive-value|sk-proj-|private-suffix/);
  assert.ok(!request.prompt.includes(quotedSecret)); assert.ok(!sent.includes(JSON.stringify(quotedSecret).slice(1, -1)));
  if (stage === 'review') {
    const gates = jsonLine(request.prompt, 'Gate evidence: ');
    assert.deepEqual(gates.map(row => row.status), ['disabled', 'disabled']);
    assert.deepEqual(gates.map(row => row.evidenceRoot), [quoted + ' [REDACTED]', code + ' [REDACTED]']);
  }
  for (const reference of attempt.evidence) {
    const full = await readEvidence(reference.path, fx.baseSha);
    assert.doesNotMatch(JSON.stringify(full), /fixture-sensitive-value|sk-proj-|private-suffix/);
    await fx.engine.assertEvidence(reference);
    if (full.kind === 'analysis') assert.equal(full.value.summary, quoted + '\n' + code);
    if (full.kind === 'review') assert.equal(full.value.plan.summary, quoted);
  }
  if (stage === 'node') {
    const reference = attempt.evidence.find(ref => path.basename(ref.path).startsWith('node-contract-'));
    const full = (await readEvidence(reference.path, fx.baseSha)).value.task;
    assert.equal(full.description, code); assert.deepEqual(full.acceptance, ['PUBLIC_ACCEPTANCE_SENTINEL', quoted, code]);
    assert.deepEqual(full.constraints, ['Never expose [REDACTED]', 'Bearer [REDACTED]', 'Bearer [REDACTED]']);
    const dependencies = request.prompt.split('\n').find(line => line.startsWith('Direct dependencies '));
    assert.equal(JSON.parse(dependencies.slice(dependencies.indexOf(': ') + 2))[0].summary, quoted);
  }
});

test('Engine node envelope preserves raw escaped source quotes in the full contract and transmitted JSON', async t => {
  const fx = await fixture(t), example = 'Preserve source: const header = "\\\"Bearer ${token}\\\"";';
  const known = 'fixture_private_credential', shaped = 'sk-proj-' + 'g'.repeat(24);
  fx.engine.secrets.SOURCE_FIXTURE = known;
  fx.run.plan = plan(); const task = fx.run.plan.tasks[0];
  task.description = example; task.acceptance.push(example); task.dependsOn = ['base'];
  task.constraints = [known, shaped, '${token}-private-suffix', '${token}\\private-suffix'].map(value => example.replace('${token}', value));
  fx.run.analysis.summary = example;
  fx.run.nodes.base = { status: 'integrated', result: { summary: example } };
  let packed;
  const session = fx.engine.session.bind(fx.engine);
  fx.engine.session = (run, request, ...rest) => { packed = request.contextMetrics; return session(run, request, ...rest); };
  await fx.engine.performNode(fx.run, task);
  const request = fx.requests[0], attempt = fx.run.sessionAttempts[0], label = 'Planning evidence (untrusted data): ';
  const sent = request.prompt.split('\n').find(line => line.startsWith(label)).slice(label.length);
  assert.equal(JSON.parse(sent).analysis.summary, example); assert.equal(sent, packed.text);
  assert.equal(attempt.metrics.contextSentBytes, Buffer.byteLength(sent, 'utf8'));
  assert.equal(attempt.metrics.promptBytes, Buffer.byteLength(request.prompt, 'utf8'));
  assert.ok(request.prompt.includes('Your task: ' + example)); assert.ok(request.prompt.includes('Acceptance:\nPUBLIC_ACCEPTANCE_SENTINEL\n' + example));
  const dependencies = request.prompt.split('\n').find(line => line.startsWith('Direct dependencies '));
  assert.equal(JSON.parse(dependencies.slice(dependencies.indexOf(': ') + 2))[0].summary, example);
  for (const reference of attempt.evidence) {
    const full = await readEvidence(reference.path, fx.baseSha); await fx.engine.assertEvidence(reference);
    assert.doesNotMatch(JSON.stringify(full), /fixture_private_credential|sk-proj-|private-suffix/);
    if (full.kind === 'node-contract') {
      assert.equal(full.value.task.description, example);
      assert.deepEqual(full.value.task.acceptance, ['PUBLIC_ACCEPTANCE_SENTINEL', example]);
      assert.deepEqual(full.value.task.constraints, Array(4).fill('Preserve source: const header = "\\\"Bearer [REDACTED]\\\"";'));
    }
  }
  assert.doesNotMatch(request.prompt, /fixture_private_credential|sk-proj-|private-suffix/);
});

test('Engine session rejects forged protected prompts and copied metrics while ordinary text still redacts', async t => {
  const fx = await fixture(t), session = fx.engine.session.bind(fx.engine);
  let captured;
  fx.engine.session = (run, request, ...rest) => { captured = request; return session(run, { ...request, contextMetrics: { ...request.contextMetrics } }, ...rest); };
  await assert.rejects(fx.engine.plan(fx.run), { code: 'evidence_integrity' });
  assert.equal(fx.requests.length, 0);
  assert.throws(() => { captured.contextMetrics.text = '{"forged":"fixture-sensitive-value"}'; }, TypeError);
  await assert.rejects(session(fx.run, { ...captured, prompt: { ...captured.prompt } }), TypeError);
  await assert.rejects(session(fx.run, { ...captured, prompt: 'fixture-sensitive-value', contextMetrics: { text: 'fixture-sensitive-value', originalBytes: 1, sentBytes: 1 } }), { code: 'evidence_integrity' });
  assert.equal(fx.requests.length, 0);
  await session(fx.run, { client: 'codex', model: 'gpt-6.1-sol', cwd: fx.project, prompt: 'const header = `Bearer ${token}`; fixture-sensitive-value Bearer ${token}-private-suffix', readOnly: true });
  assert.match(fx.requests[0].prompt, /const header = `Bearer \$\{token\}`;/);
  assert.doesNotMatch(fx.requests[0].prompt, /fixture-sensitive-value|private-suffix/);
  assert.equal(fx.run.sessionAttempts[0].metrics.contextSentBytes, null);
});

test('Engine prepares one private evidence directory per worker batch and rechecks protection for the next batch', async t => {
  const fx = await fixture(t), prepare = fx.engine.privateDirectory.bind(fx.engine), prepared = [];
  fx.engine.privateDirectory = async directory => { prepared.push(directory); return prepare(directory); };
  fx.run.plan = plan();
  fx.run.plan.tasks[0].acceptance.push('Preserve Bearer ${process.env.API_KEY}', 'Redact fixture-sensitive-value');
  await fx.engine.performNode(fx.run, fx.run.plan.tasks[0]);
  const directory = path.join(fx.run.artifacts, 'evidence');
  assert.deepEqual(prepared, [directory], 'contract, analysis and research share one protected batch before the worker starts');
  const attempt = fx.run.sessionAttempts[0]; assert.equal(attempt.evidence.length, 3);
  for (const reference of attempt.evidence) {
    const document = await readEvidence(reference.path, fx.baseSha);
    assert.doesNotMatch(JSON.stringify(document), /fixture-sensitive-value/);
    await fx.engine.assertEvidence(reference);
  }
  const contract = JSON.parse(await readFile(attempt.evidence.find(ref => path.basename(ref.path).startsWith('node-contract-')).path, 'utf8'));
  assert.ok(contract.value.task.acceptance.includes('Preserve Bearer ${process.env.API_KEY}'));
  assert.match(fx.requests[0].prompt, /Bearer \$\{process\.env\.API_KEY\}/);
  if (process.platform === 'win32') {
    await execute('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', '[Console]::InputEncoding=[Text.UTF8Encoding]::new($false); $p=[Console]::In.ReadToEnd(); $a=[IO.Directory]::GetAccessControl($p); $a.SetAccessRuleProtection($false,$true); [IO.Directory]::SetAccessControl($p,$a)'], { input: directory });
  } else await chmod(directory, 0o755);
  const next = await fx.engine.planningEvidence(fx.run);
  assert.deepEqual(prepared, [directory, directory], 'no successful protection receipt is cached across batches or sessions');
  for (const reference of next.references) await readEvidence(reference.path, fx.baseSha);
});

test('Engine evidence batches reject expired writers and replaced or missing directories before producing another artifact', async t => {
  const fx = await fixture(t), directory = path.join(fx.run.artifacts, 'evidence');
  let retained;
  await fx.engine.withEvidenceBatch(fx.run, async persist => { retained = persist; await persist('test', { result: 'original' }); });
  const originalFiles = await readdir(directory);
  await assert.rejects(retained('test', { result: 'expired' }), { code: 'evidence_integrity' });
  assert.deepEqual(await readdir(directory), originalFiles);
  await assert.rejects(fx.engine.withEvidenceBatch(fx.run, async persist => {
    await rename(directory, `${directory}-original`); await mkdir(directory);
    await persist('test', { result: 'replacement' });
  }), { code: 'evidence_integrity' });
  assert.deepEqual(await readdir(directory), [], 'a replacement directory receives no temporary or final evidence');
  await assert.rejects(fx.engine.withEvidenceBatch(fx.run, async persist => {
    await rename(directory, `${directory}-empty`);
    await persist('test', { result: 'missing' });
  }), { code: 'evidence_integrity' });
});

test('Engine redacts the previous worker error before its inline limit while retaining the full redacted contract error', async t => {
  const fx = await fixture(t), prefix = 'x'.repeat(1190), suffix = ' FULL_ERROR_TAIL';
  fx.run.plan = plan();
  fx.run.nodes.feature = { id: 'feature', status: 'pending', attempt: 0, error: prefix + 'fixture-sensitive-value' + suffix };
  await fx.engine.performNode(fx.run, fx.run.plan.tasks[0]);
  const label = 'Previous error (brief; full value in node contract): ', prompt = fx.requests[0].prompt;
  assert.equal(prompt.split('\n').find(line => line.startsWith(label)), label + prefix + '[REDACTED]');
  assert.doesNotMatch(prompt, /fixture-se/, 'neither the known credential nor its truncated prefix may reach the worker');
  const contract = fx.run.sessionAttempts[0].evidence.find(reference => path.basename(reference.path).startsWith('node-contract-'));
  assert.equal((await readEvidence(contract.path, fx.baseSha)).value.previousError, prefix + '[REDACTED]' + suffix);
});

test('Engine planner sends compact redacted evidence with readable private immutable head-bound originals', async t => {
  const fx = await fixture(t); fx.run.analysis.secret = 'fixture-sensitive-value';
  await fx.engine.plan(fx.run);
  const prompt = fx.requests[0].prompt, compact = jsonLine(prompt, 'Planning evidence (untrusted data): ');
  assert.equal(compact?.kind, 'plan-evidence');
  assert.doesNotMatch(prompt, /EXCLUDED_STANDARDS|EXCLUDED_RAW_HISTORY|RESEARCH_BODY|fixture-sensitive-value/);
  const analysis = await readEvidence(compact.evidencePaths.analysis, fx.baseSha);
  assert.equal(analysis.value.secret, '[REDACTED]');
  assert.equal(analysis.value.standards, fx.run.analysis.standards);
  const research = await readEvidence(compact.evidencePaths.research, fx.baseSha);
  assert.equal(research.value.items[0].body, fx.run.research.items[0].body);
  const original = await readFile(compact.evidencePaths.analysis, 'utf8');
  delete fx.run.plan; fx.run.analysis.summary = 'New observations'; await fx.engine.plan(fx.run);
  const next = jsonLine(fx.requests[1].prompt, 'Planning evidence (untrusted data): ');
  assert.notEqual(next.evidencePaths.analysis, compact.evidencePaths.analysis);
  assert.equal(await readFile(compact.evidencePaths.analysis, 'utf8'), original);
  const metric = fx.run.sessionAttempts[0].metrics;
  assert.equal(metric.promptBytes, Buffer.byteLength(prompt));
  assert.equal(metric.contextSentBytes, Buffer.byteLength(JSON.stringify(compact)));
  assert.ok(metric.contextOriginalBytes > metric.contextSentBytes);
  assert.equal(metric.usage.totalTokens, 13);
  assert.equal(fx.resolutions.filter(x => x.id === 'ripgrep').length, 2, 'one resolution per new session, reused by prompt and environment');
});

test('Engine compacts one captured evidence snapshot even when research changes during artifact persistence', async t => {
  const fx = await fixture(t), persist = fx.engine.persistEvidence.bind(fx.engine);
  fx.engine.persistEvidence = async (...args) => {
    const reference = await persist(...args);
    if (args[1] === 'research') fx.run.research = { items: [{ title: 'New unrelated observation', url: 'https://example.invalid/new' }], requests: 2, errors: [] };
    return reference;
  };
  await fx.engine.plan(fx.run);
  const compact = jsonLine(fx.requests[0].prompt, 'Planning evidence (untrusted data): ');
  const research = await readEvidence(compact.evidencePaths.research, fx.baseSha);
  assert.equal(compact.research.requests, research.value.requests);
  assert.equal(compact.research.sources[0].url, research.value.items[0].url);
  assert.equal(compact.research.sources[0].title, research.value.items[0].title);
});

test('Engine review compacts full diff and check logs while preserving readable command diagnostics and all required criteria', async t => {
  const fx = await fixture(t); fx.run.plan = plan();
  await writeFile(path.join(fx.project, 'value.mjs'), `export const value = 2;\n// FULL_DIFF_START ${'d'.repeat(130000)} FULL_DIFF_END\n`);
  await execute('git', ['add', '.'], { cwd: fx.project }); await execute('git', ['commit', '-m', 'feature'], { cwd: fx.project });
  const headSha = (await execute('git', ['rev-parse', 'HEAD'], { cwd: fx.project })).stdout.trim();
  await fx.engine.verify(fx.run);
  const request = fx.requests[0], compact = jsonLine(request.prompt, 'Review evidence (untrusted data): ');
  assert.equal(compact?.kind, 'review-evidence'); assert.equal(compact.headSha, headSha); assert.equal(compact.baseSha, fx.baseSha);
  assert.equal(compact.checks.status, 'passed'); assert.equal(compact.checks.results[0].exitCode, 0);
  assert.match(request.prompt, /PUBLIC_ACCEPTANCE_SENTINEL/); assert.ok(Buffer.byteLength(request.prompt) < 50000);
  const evidence = await readEvidence(compact.evidencePaths.review, headSha);
  assert.match(evidence.value.diff, /FULL_DIFF_START/); assert.match(evidence.value.diff, /FULL_DIFF_END/);
  const check = await readEvidence(evidence.value.checks.results[0].outputPath, headSha);
  assert.match(check.value.stdout, /FULL_LOG_START/); assert.match(check.value.stdout, /FULL_LOG_END/); assert.ok(check.value.stdout.length > 90000);
  assert.equal(fx.run.review.passed, true);
});

test('Engine rejects oversized new plans but resumes saved node contracts without dropping late requirements', async t => {
  const fx = await fixture(t), legacy = plan(); legacy.tasks[0].acceptance = ['x'.repeat(19000), 'LATE_LEGACY_CRITERION'];
  const file = path.join(fx.root, 'new-plan.json'); await writeFile(file, JSON.stringify(legacy));
  await assert.rejects(fx.engine.plan(fx.run, file), error => error.code === 'task_contract_too_large' && /split|decompos/i.test(error.message));
  fx.run.plan = legacy; await fx.engine.plan(fx.run); await fx.engine.plan(fx.run, file);
  await fx.engine.performNode(fx.run, legacy.tasks[0]);
  const prompt = fx.requests[0].prompt;
  const match = /Mandatory full node contract \(read before acting\): (.+)/.exec(prompt);
  assert.ok(match, 'legacy prompt requires the entire contract, not a truncated acceptance list');
  const evidence = await readEvidence(match[1], fx.baseSha);
  assert.deepEqual(evidence.value.task.acceptance, legacy.tasks[0].acceptance);
  assert.equal(fx.run.nodes.feature.status, 'completed');
});

test('Engine coordinator checks keep raw Node diagnostics and retain the full failed command output privately', async t => {
  const fx = await fixture(t);
  fx.run.config.commands.test[0].args = ['-e', "console.log('RAW_NODE_FAILURE_SENTINEL ' + 'x'.repeat(90000) + ' RAW_NODE_END'); process.exit(23)"];
  await assert.rejects(fx.engine.checks(fx.run), { code: 'check_failed' });
  const row = fx.run.checks.results[0]; assert.equal(row.exitCode, 23); assert.equal(fx.run.checks.complete, false);
  const evidence = await readEvidence(row.outputPath, fx.baseSha);
  assert.equal(evidence.value.exitCode, 23); assert.match(evidence.value.stdout, /RAW_NODE_FAILURE_SENTINEL/); assert.match(evidence.value.stdout, /RAW_NODE_END/);
  assert.equal(fx.resolutions.some(item => item.id === 'rtk'), false, 'coordinator checks do not resolve or wrap RTK');
  assert.equal(fx.requests.length, 0, 'check failure itself calls no model');
});

test('Engine session uses verified managed RTK only in a private worker environment and rechecks each new session', async t => {
  const root = path.join(path.resolve(os.tmpdir()), 'fixture-managed-rtk'), directory = path.join(root, '1.1.0');
  const rtk = { id: 'rtk', version: '1.1.0', ready: true, status: 'ready', directory, command: path.join(directory, 'native', process.platform === 'win32' ? 'rtk.exe' : 'rtk'), receipt: path.join(root, 'receipt.json') };
  const fx = await fixture(t, { rtk }); const originalPath = process.env.PATH, homes = Object.fromEntries(['HOME', 'USERPROFILE', 'CODEX_HOME', 'CLAUDE_CONFIG_DIR'].map(key => [key, process.env[key]]));
  fx.run.plan = plan();
  const request = { client: 'codex', model: 'gpt-6.1-sol', cwd: fx.project, prompt: '😀 fixture-sensitive-value https://example.invalid/?token=private-value', readOnly: true };
  await fx.engine.session(fx.run, request);
  const sent = fx.requests[0], environment = sent.env, pathKey = Object.keys(environment).find(key => key.toLowerCase() === 'path');
  assert.match(sent.prompt, /Node node:test\/TAP raw/);
  assert.ok(environment[pathKey].split(path.delimiter).includes(path.dirname(rtk.command)));
  assert.equal(environment.RTK_RECALL, '0'); assert.equal(environment.RTK_TEE, '0'); assert.equal(environment.RTK_TELEMETRY_DISABLED, '1');
  assert.equal(path.basename(environment.RTK_DB_PATH), 'tracking.db');
  assert.ok(path.relative(fx.run.artifacts, environment.RTK_DB_PATH).startsWith('worker-tools'));
  if (process.platform !== 'win32') assert.equal((await stat(path.dirname(environment.RTK_DB_PATH))).mode & 0o777, 0o700);
  for (const [key, value] of Object.entries(homes)) assert.equal(environment[key], value);
  assert.equal(process.env.PATH, originalPath); assert.doesNotMatch(sent.prompt, /fixture-sensitive-value|private-value/);
  assert.equal(fx.run.sessionAttempts[0].metrics.promptBytes, Buffer.byteLength(sent.prompt));
  assert.equal(fx.resolutions.filter(x => x.id === 'rtk').length, 1); assert.equal(fx.resolutions.filter(x => x.id === 'ripgrep').length, 1);
  rtk.ready = false; await fx.engine.session(fx.run, request);
  assert.equal(fx.resolutions.filter(x => x.id === 'rtk').length, 2);
  assert.equal(fx.requests[1].env.RTK_DB_PATH, undefined); assert.doesNotMatch(fx.requests[1].prompt, /Managed RTK OSS/);
  assert.equal(fx.requests[1].env[pathKey].split(path.delimiter).includes(path.dirname(rtk.command)), false);
});

test('Engine resolves worker tool integrity only after obtaining the subscription lease and reuses it within that session', async t => {
  const fx = await fixture(t), withLease = fx.engine.withLease.bind(fx.engine), resolve = fx.engine.tools.resolveTool;
  let leased = false;
  fx.engine.withLease = (run, name, limit, action, signal) => withLease(run, name, limit, async leasedSignal => { if (name.startsWith('subscription:')) leased = true; return action(leasedSignal); }, signal);
  fx.engine.tools.resolveTool = async (...args) => { assert.equal(leased, true, 'a queued session must not retain an old tool verification'); return resolve(...args); };
  await fx.engine.session(fx.run, { client: 'codex', model: 'gpt-6.1-sol', cwd: fx.project, prompt: 'Lease-bound tools', readOnly: true });
  assert.equal(fx.resolutions.filter(item => item.id === 'ripgrep').length, 1);
  assert.equal(fx.resolutions.filter(item => item.id === 'rtk').length, 1);
});

test('Engine retains measured prompt bytes on typed provider failures without inventing native usage', async t => {
  const fx = await fixture(t); fx.engine.provider.runSession = async () => { throw Object.assign(new Error('Quota'), { code: 'quota', metrics: { toolSteps: null, usage: { totalTokens: null } } }); };
  await assert.rejects(fx.engine.session(fx.run, { client: 'codex', model: 'gpt-6.1-sol', cwd: fx.project, prompt: 'failed 😀', readOnly: true }), { code: 'quota' });
  const attempt = fx.run.sessionAttempts[0]; assert.equal(attempt.status, 'failed'); assert.equal(attempt.errorCode, 'quota');
  assert.ok(attempt.metrics.promptBytes > Buffer.byteLength('failed 😀')); assert.equal(attempt.metrics.contextOriginalBytes, null); assert.equal(attempt.metrics.usage.totalTokens, null);
});

test('Engine immutable evidence rejects altered bytes and paths inside Git', async t => {
  const fx = await fixture(t), value = { boundary: 'full evidence' };
  fx.run.artifacts = path.join(fx.root, 'приватные 🦊', 'runs', fx.run.id);
  const evidence = await fx.engine.persistEvidence(fx.run, 'test', value, { headSha: fx.baseSha });
  await readEvidence(evidence.path, fx.baseSha);
  await chmod(evidence.path, 0o600); await writeFile(evidence.path, 'tampered');
  await assert.rejects(fx.engine.persistEvidence(fx.run, 'test', value, { headSha: fx.baseSha }), { code: 'evidence_integrity' });
  await assert.rejects(fx.engine.persistEvidence({ ...fx.run, artifacts: fx.project }, 'test', value), { code: 'artifacts_in_git' });
});

test('Engine rejects evidence changed during a successful review and refuses damaged cached check logs', async t => {
  const fx = await fixture(t); fx.run.plan = plan();
  const original = fx.engine.provider.runSession;
  fx.engine.provider.runSession = async request => {
    const result = await original(request), compact = jsonLine(request.prompt, 'Review evidence (untrusted data): ');
    await chmod(compact.evidencePaths.review, 0o600); await writeFile(compact.evidencePaths.review, 'altered review evidence');
    return result;
  };
  await assert.rejects(fx.engine.verify(fx.run), { code: 'evidence_integrity' });
  assert.equal(fx.run.review, null, 'no passing review may survive damaged evidence');
  const row = fx.run.checks.results[0]; await chmod(row.outputPath, 0o600); await writeFile(row.outputPath, 'altered check log');
  await assert.rejects(fx.engine.checks(fx.run), { code: 'evidence_integrity' });
});

test('Engine preserves the typed evidence failure and unfinished worker changes without consuming repair budget or research', async t => {
  const fx = await fixture(t); fx.run.plan = plan(); let research = 0;
  fx.engine.moreResearch = async () => { research++; };
  const original = fx.engine.provider.runSession;
  fx.engine.provider.runSession = async request => {
    const result = await original(request), compact = jsonLine(request.prompt, 'Planning evidence (untrusted data): ');
    await writeFile(path.join(request.cwd, 'value.mjs'), 'export const value = 2;\n');
    await chmod(compact.evidencePaths.analysis, 0o600); await writeFile(compact.evidencePaths.analysis, 'changed context');
    return result;
  };
  await assert.rejects(fx.engine.performNode(fx.run, fx.run.plan.tasks[0]), { code: 'evidence_integrity' });
  const node = fx.run.nodes.feature; assert.equal(node.attempt, 0); assert.equal(node.status, 'pending'); assert.equal(node.resumeRequired, true);
  assert.equal(research, 0); assert.equal(await readFile(path.join(node.cwd, 'value.mjs'), 'utf8'), 'export const value = 2;\n');
  assert.equal(await readFile(path.join(fx.project, 'value.mjs'), 'utf8'), 'export const value = 1;\n');
  assert.equal(fx.run.sessionAttempts[0].errorCode, 'evidence_integrity'); assert.equal(fx.run.sessionAttempts[0].metrics.usage.totalTokens, 13);
});

test('Routing supplies concrete ready frontier and ignores blocked descendants without overriding Jev', async () => {
 const task=(id,writePaths,dependsOn=[])=>({id,role:'developer',description:`Implement ${id}`,writePaths,dependsOn,acceptance:['Behavior holds'],parallel:true});
 const a=task('ancestor',['src/shared.mjs']),b=task('context',['src/context.mjs'],['ancestor']),c=task('rtk',['src/rtk.mjs'],['ancestor']),future=task('integration',['src/context.mjs'],['context','rtk']);
 const models=[{id:'codex:desktop-default',client:'codex',model:'desktop-default',available:true}];
 let captured,parallel=false;
 const engine=new Engine({store:{getRun:()=>({cancelRequested:false})},provider:{decideJev:async request=>{captured=request;return{model:models[0].id,parallel,confidence:.98,modelConfidence:1,parallelConfidence:.98,sessionConfidence:.9,sessionMode:'fresh'};}}});
 engine.save=()=>{};engine.log=()=>{};
 const run={id:'fixture',task:'Objective '.repeat(200),client:'codex',models,config:{primaryModel:'desktop-default'},executionMode:{selected:'deep'},plan:{tasks:[a,b,c,future]},nodes:{ancestor:{status:'integrated'},context:{status:'pending'},rtk:{status:'pending'},integration:{status:'pending'}}};
 await engine.route(run,b,run.nodes.context);
 assert.equal(captured.node.parallelismFacts?.taskReady,true);
 assert.equal(captured.node.parallelismFacts?.planAllowsParallel,true);
 assert.deepEqual(captured.node.parallelismFacts?.compatibleReadyPeers.map(x=>x.id),['rtk']);
 assert.deepEqual(captured.node.parallelismFacts.compatibleReadyPeers[0],{id:'rtk',role:'developer',description:'Implement rtk',acceptance:['Behavior holds'],writePaths:['src/rtk.mjs']});
 assert.match(captured.node.parallelismFacts.rule,/snapshot/i);
 assert.deepEqual(captured.node.parallelismFacts?.conflictingActivePeers,[]);
 assert.ok(captured.task.length<600,'routing objective stays bounded independently of task history');
 assert.equal(run.nodes.context.routing.parallel,false,'facts do not override a serial Jev decision');
 assert.equal(captured.node.coordination.length,4,'the prepared graph is still supplied');
 run.nodes.integration.status='running';parallel=true;
 await engine.route(run,b,run.nodes.context);
 assert.deepEqual(captured.node.parallelismFacts.conflictingActivePeers,['integration']);
 assert.equal(run.nodes.context.routing.parallel,true,'normal typed routing remains separate from scheduler safety enforcement');
});
