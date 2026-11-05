import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdir, writeFile, readFile, chmod, cp, realpath } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { Engine } from '../runtime/engine.mjs';
import { execute, deliver } from '../runtime/delivery.mjs';
import { diffHash } from '../runtime/workspace.mjs';
import { readConfig } from '../runtime/config.mjs';
import { normalizeArchitectureConfig, runArchitectureChecks, isCurrentArchitectureReceipt } from '../runtime/architecture-gate.mjs';
import { architectureCli } from '../runtime/architecture-cli.mjs';
import { fixture, fakeServices, node, git } from './helpers/engine-fixture.mjs';

const enabled = { enabled: true };

async function windowsAcl(script, filename) {
  return execute(path.join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe'),
    ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from("$ErrorActionPreference='Stop'; $ProgressPreference='SilentlyContinue'; " + script, 'utf16le').toString('base64')],
    { env: { SystemRoot: process.env.SystemRoot, ACL_TEST_FILE: filename } });
}
const policy = () => ({ schemaVersion: 1, version: 1, productRoots: ['src'], modules: [
  { id: 'core', roots: ['src/core'], layer: 'core', public: ['src/core/index.mjs'], allow: [] },
  { id: 'app', roots: ['src/app'], layer: 'app', public: [], allow: ['core'] }
], layers: { app: ['core'], core: [] }, forbiddenImports: [], cycles: 'forbid', contracts: 'architecture.contracts.json', baseline: [], exceptions: [], protectedPaths: ['architecture.policy.json'] });

async function setup(t, { forbidden = false, onReview, architecture = enabled } = {}) {
  const fx = await fixture(t, { config: { architecture, repairRounds: 1, researchBudget: 0, concurrency: 1 }, testScript: 'process.exit(0);\n' });
  const services = fakeServices({ onReview });
  const engine = new Engine({ store: fx.openStore(), ...services });
  const run = await engine.create('Architecture gate requirement', { project: fx.project, mode: 'quick', model: 'gpt-6.1-sol' });
  await engine.prepare(run);
  run.models = await services.provider.discoverProviders();
  run.plan = { summary: 'Enroll explicit boundaries', tasks: [node('enroll', 'developer', ['src', 'tests', 'architecture.policy.json', 'architecture.contracts.json'])] };
  const put = async (file, value) => { const name = path.join(run.cwd, file); await mkdir(path.dirname(name), { recursive: true }); await writeFile(name, typeof value === 'string' ? value : JSON.stringify(value)); };
  // The baseline has no policy; product ownership is explicit in the head.
  const rules = policy();
  await put('src/core/index.mjs', 'export const value=1;\n');
  await put('src/app/main.mjs', "import {value} from '../core/index.mjs'; export const result=value;\n");
  if (forbidden) rules.forbiddenImports = [{ from: 'app', to: 'core' }];
  // Move the fixture's pre-existing module into an owned directory.
  git(run.cwd, 'rm', 'src/value.mjs');
  await put('architecture.policy.json', rules);
  await put('architecture.contracts.json', { schemaVersion: 1, contracts: [{ id: 'api', module: 'core', version: 1, entry: 'src/core/index.mjs', exports: ['value'], shapeHash: createHash('sha256').update('{"exports":["value"]}').digest('hex'), tests: ['tests/value.test.mjs'] }], migrations: [] });
  await put('tests/value.test.mjs', "import test from 'node:test'; import assert from 'node:assert/strict'; import {value} from '../src/core/index.mjs'; test('public value is one',()=>assert.equal(value,1));\n");
  git(run.cwd, 'add', '.'); git(run.cwd, 'commit', '-m', 'Architecture enrollment');
  run.headSha = git(run.cwd, 'rev-parse', 'HEAD'); engine.save(run);
  return { ...fx, engine, run, services, put, options: () => ({ cwd: run.cwd, headSha: run.headSha, baseSha: run.baseSha, config: run.config.architecture, artifacts: run.artifacts }) };
}

test('Architecture configuration is strict and old saved runs stay neutral with fixed lower limits', async t => {
  assert.deepEqual(normalizeArchitectureConfig(), { enabled: false });
  for (const value of [null, true, { enabled: 1 }, { enabled: true, policy: 'elsewhere.json' }]) assert.throws(() => normalizeArchitectureConfig(value));
  const fx = await setup(t, { architecture: { enabled: false } });
  delete fx.run.config.architecture;
  assert.deepEqual((await readConfig(fx.project)).architecture, { enabled: false });
  const newProjectConfig = JSON.parse(await readFile(path.join(fx.project, 'kodo.config.json'), 'utf8'));
  newProjectConfig.architecture = enabled;
  await writeFile(path.join(fx.project, 'kodo.config.json'), JSON.stringify(newProjectConfig));
  const before = structuredClone({ mode: fx.run.executionMode, fixedModel: fx.run.fixedModel, rounds: fx.run.config.repairRounds, budget: fx.run.config.researchBudget, concurrency: fx.run.config.concurrency });
  const neutral = await runArchitectureChecks(fx.options());
  assert.equal(neutral.status, 'disabled'); assert.equal(neutral.passed, null);
  assert.equal(await isCurrentArchitectureReceipt(neutral, fx.options()), true);
  await fx.engine.verify(fx.run);
  assert.equal(fx.run.architectureChecks.status, 'disabled');
  assert.equal(fx.run.config.architecture, undefined);
  assert.deepEqual({ mode: fx.run.executionMode, fixedModel: fx.run.fixedModel, rounds: fx.run.config.repairRounds, budget: fx.run.config.researchBudget, concurrency: fx.run.config.concurrency }, before);
  assert.equal(fx.services.calls.review[0].model, 'gpt-6.1-sol');
  assert.deepEqual((await readConfig(fx.project)).architecture, enabled, 'new project defaults must not retroactively enable a saved run');
});

test('Real enabled Engine executes contract TAP and exposes exact private architecture evidence to review', async t => {
  const fx = await setup(t);
  await fx.engine.verify(fx.run);
  const receipt = fx.run.architectureChecks;
  assert.equal(receipt.status, 'passed'); assert.equal(receipt.passed, true);
  assert.equal(receipt.headSha, fx.run.headSha); assert.equal(receipt.baseSha, fx.run.baseSha);
  assert.equal(receipt.report.basePolicyState, 'absent'); assert.equal(receipt.report.baseRulesEvaluated, false);
  assert.equal(receipt.report.requiresReview, true); assert.equal(receipt.report.fullVerificationRequired, true);
  assert.equal(receipt.report.receipts.length, 1); assert.equal(receipt.report.receipts[0].counts.tests, 1);
  assert.equal(receipt.report.receipts[0].counts.pass, 1);
  const capture = JSON.parse(await readFile(receipt.report.receipts[0].evidence[0].path, 'utf8'));
  assert.match(capture.stdout, /public value is one/);
  t.diagnostic(JSON.stringify({ control: 'real-permitted', baseSha: receipt.baseSha, headSha: receipt.headSha, hashes: receipt.report.hashes, pinsHash: receipt.pinsHash, runtime: receipt.runtime, testReceipt: receipt.report.receipts[0], capture }));
  assert.equal(await isCurrentArchitectureReceipt(receipt, fx.options()), true);
  assert.equal(fx.services.calls.review.length, 1);
  assert.ok(fx.services.calls.review[0].prompt.includes(JSON.stringify(receipt.evidence[0].path)));
  assert.equal(fx.run.review.passed, true);
  let remoteCalls = 0;
  const options = { run: fx.run, review: fx.run.review, cwd: fx.run.cwd, config: fx.run.config, exec: async (command, args, settings) => {
    if (command !== 'git') { remoteCalls++; throw Object.assign(Error('Stop before remote delivery'), { code: 'after_gate' }); }
    return execute(command, args, settings);
  } };
  await assert.rejects(deliver(options), { code: 'after_gate' });
  assert.equal(remoteCalls, 1, 'valid architecture control must pass local delivery prerequisite');
  await assert.rejects(deliver({ ...options, config: { ...fx.run.config, architecture: { enabled: false } } }), { code: 'stale_architecture_checks' });
  const raw = receipt.report.receipts[0].evidence[0].path;
  await chmod(raw, 0o600); await writeFile(raw, 'changed after review');
  await assert.rejects(deliver(options), { code: 'stale_architecture_checks' });
  assert.equal(remoteCalls, 1, 'tampered evidence must block before remote delivery');
});

test('Real enabled Engine rejects forbidden imports before reviewer-approved responses or delivery', async t => {
  const fx = await setup(t, { forbidden: true, onReview: async () => ({ output: { passed: true, findings: [] } }) });
  await assert.rejects(fx.engine.verify(fx.run));
  const receipt = fx.run.architectureChecks;
  assert.equal(receipt.status, 'failed'); assert.equal(receipt.report.findings.some(row => row.ruleId === 'dependency.forbidden'), true);
  assert.equal(receipt.headSha, fx.run.headSha); assert.equal(fx.services.calls.review.length, 0); assert.equal(fx.services.calls.delivery, 0);
  assert.equal(JSON.parse(await readFile(receipt.evidence[0].path, 'utf8')).report.status, 'failed');
  t.diagnostic(JSON.stringify({ control: 'real-forbidden', baseSha: receipt.baseSha, headSha: receipt.headSha, report: receipt.report, evidence: receipt.evidence }));
  const review = { passed: true, headSha: fx.run.headSha, diffHash: await diffHash(fx.run.cwd, fx.run.baseSha) };
  await assert.rejects(deliver({ run: fx.run, review, cwd: fx.run.cwd, config: fx.run.config, exec: async (command, args, options) => {
    assert.equal(command, 'git', 'architecture must block before any remote command'); return execute(command, args, options);
  } }), { code: 'stale_architecture_checks' });
});

test('Architecture freshness rejects stale identity config runtime pins source and tampered or missing evidence', async t => {
  const fx = await setup(t); const receipt = await runArchitectureChecks(fx.options());
  assert.equal(receipt.passed, true);
  for (const changed of [{ ...receipt, baseSha: 'a'.repeat(40) }, { ...receipt, headSha: 'a'.repeat(40) }, { ...receipt, configHash: 'a'.repeat(64) }, { ...receipt, pinsHash: 'a'.repeat(64) }, { ...receipt, runtime: { ...receipt.runtime, node: '0.0.0' } }, { ...receipt, evidence: [] }, { ...receipt, report: { ...receipt.report, receipts: [] } }]) {
    assert.equal(await isCurrentArchitectureReceipt(changed, fx.options()), false);
  }
  assert.equal(await isCurrentArchitectureReceipt(receipt, { ...fx.options(), config: { enabled: true, policy: 'other' } }), false);
  await fx.put('src/core/index.mjs', 'export const value=9;\n');
  assert.equal(await isCurrentArchitectureReceipt(receipt, fx.options()), false);
  await fx.put('src/core/index.mjs', 'export const value=1;\n');
  assert.equal(await isCurrentArchitectureReceipt(receipt, fx.options()), true);
  const evidence = receipt.report.receipts[0].evidence[0].path;
  await chmod(evidence, 0o600); await writeFile(evidence, 'tampered');
  assert.equal(await isCurrentArchitectureReceipt(receipt, fx.options()), false);
});

test('Windows architecture freshness accepts real short-path aliases with canonical private evidence', { skip: process.platform !== 'win32' }, async t => {
  const fx = await setup(t);
  // Query only our fixture's existing directory; no links or filesystem changes.
  const short = (await windowsAcl("[Console]::Out.Write((New-Object -ComObject Scripting.FileSystemObject).GetFolder($env:ACL_TEST_FILE).ShortPath)", fx.run.artifacts)).stdout.trim();
  const canonicalArtifacts = await realpath(fx.run.artifacts);
  if (short.toLowerCase() === canonicalArtifacts.toLowerCase()) return t.skip('Fixture volume has no distinct 8.3 alias');
  assert.equal(await realpath(short), canonicalArtifacts);
  const options = { ...fx.options(), cwd: fx.run.cwd.toUpperCase(), artifacts: short };
  assert.equal(await realpath(options.cwd), await realpath(fx.run.cwd));
  const receipt = await runArchitectureChecks(options);
  assert.equal(receipt.passed, true);
  const planned = await architectureCli(['plan', '--project', receipt.cwd, '--base', fx.run.baseSha, '--json']);
  assert.equal(planned.report.status, 'planned');
  const stable = report => Object.fromEntries(Object.entries(report).filter(([key]) => !['status', 'passed', 'receipts'].includes(key)));
  assert.deepEqual(stable(receipt.report), stable(planned.report), 'path aliases must not change the static architecture record');
  const canonicalRoot = await realpath(receipt.evidenceRoot);
  const nestedInsideRoot = receipt.report.receipts.every(row => row.evidence.every(entry => {
    const relative = path.relative(receipt.evidenceRoot, entry.path);
    return relative && !path.isAbsolute(relative) && !relative.startsWith('..' + path.sep);
  }));
  t.diagnostic(JSON.stringify({ control: 'windows-path-alias', staticReportsEqual: true, evidenceRootCanonical: receipt.evidenceRoot === canonicalRoot, nestedInsideRoot }));
  assert.equal(await isCurrentArchitectureReceipt(receipt, options), true);
  assert.equal(receipt.evidenceRoot, canonicalRoot);
  assert.equal(nestedInsideRoot, true);
  assert.equal(await isCurrentArchitectureReceipt(receipt, { ...fx.options(), cwd: receipt.cwd }), true);
});

test('Engine awaits asynchronous freshness and rejects evidence tampered during approved review', async t => {
  let fx;
  fx = await setup(t, { onReview: async () => {
    const filename = fx.run.architectureChecks.report.receipts[0].evidence[0].path;
    await chmod(filename, 0o600); await writeFile(filename, 'tampered during review');
    return { sessionId: 'approved', output: { passed: true, findings: [] } };
  } });
  await assert.rejects(fx.engine.verify(fx.run), { code: 'stale_verification' });
  assert.equal(fx.run.review, null); assert.equal(fx.run.architectureChecks, null);
});

test('Architecture gate rejects expired used waivers without rerunning contract tests', async t => {
  const fx = await setup(t, { forbidden: true });
  // Genuine enrolled base findings, unchanged source: a waiver can apply.
  fx.run.baseSha = fx.run.headSha;
  const failing = await runArchitectureChecks(fx.options());
  const finding = failing.report.findings.find(row => row.ruleId === 'dependency.forbidden');
  assert.ok(finding);
  const rules = JSON.parse(await readFile(path.join(fx.run.cwd, 'architecture.policy.json'), 'utf8'));
  rules.baseline = [{ findingId: finding.id, owner: 'fixture', reason: 'Tracked unchanged debt', reviewAfter: '2999-01-01T00:00:00.000Z' }];
  await fx.put('architecture.policy.json', rules);
  git(fx.run.cwd, 'add', '.'); git(fx.run.cwd, 'commit', '-m', 'Record unchanged debt');
  fx.run.headSha = git(fx.run.cwd, 'rev-parse', 'HEAD');
  const receipt = await runArchitectureChecks(fx.options());
  assert.equal(receipt.passed, true); assert.equal(receipt.report.debt.debt.length, 1);
  assert.equal(await isCurrentArchitectureReceipt(receipt, fx.options()), true);
  assert.equal(await isCurrentArchitectureReceipt(receipt, { ...fx.options(), now: () => '3000-01-01T00:00:00.000Z' }), false);
});

test('Enabled gate cannot accept a repository without policy or fabricated reviewer receipts', async t => {
  const fx = await fixture(t, { testScript: 'process.exit(0);\n' });
  const options = { cwd: fx.project, baseSha: fx.base, headSha: fx.base, config: enabled, artifacts: path.join(fx.directory, 'private') };
  const receipt = await runArchitectureChecks(options);
  assert.equal(receipt.status, 'blocked'); assert.equal(receipt.report.status, 'not_applicable');
  assert.equal(await isCurrentArchitectureReceipt(receipt, options), false);
  assert.equal(await isCurrentArchitectureReceipt({ schemaVersion: 1, status: 'passed', passed: true, headSha: fx.base }, options), false);
});

test('Windows gate creates protected owned files and rejects changed ACLs without repairing acceptance', { skip: process.platform !== 'win32' }, async t => {
  const fx = await setup(t);
  const receipt = await runArchitectureChecks(fx.options());
  assert.equal(receipt.passed, true);
  const files = [receipt.evidence[0].path, receipt.report.receipts[0].evidence[0].path];
  for (const file of files) {
    const observed = await windowsAcl("$a=[IO.File]::GetAccessControl($env:ACL_TEST_FILE); $u=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value; [Console]::Out.Write(($a.AreAccessRulesProtected -and $a.GetOwner([Security.Principal.SecurityIdentifier]).Value -eq $u))", file);
    assert.equal(observed.stdout.trim(), 'True');
  }
  assert.equal(await isCurrentArchitectureReceipt(receipt, fx.options()), true);
  // Change each descriptor without changing bytes or receipt hashes. Acceptance
  // must reject it and must leave the altered descriptor unchanged.
  for (const file of files) {
    const original = (await windowsAcl("[Console]::Out.Write([IO.File]::GetAccessControl($env:ACL_TEST_FILE).GetSecurityDescriptorSddlForm('All'))", file)).stdout;
    for (const mutation of [
      "$a.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new([Security.Principal.SecurityIdentifier]::new('S-1-1-0'),'Read','Allow'))",
      "$u=[Security.Principal.WindowsIdentity]::GetCurrent().User; $a.PurgeAccessRules($u); $a.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($u,'Read','Allow'))"
    ]) {
      try {
        await windowsAcl("$a=[IO.File]::GetAccessControl($env:ACL_TEST_FILE); " + mutation + "; [IO.File]::SetAccessControl($env:ACL_TEST_FILE,$a)", file);
        const changed = (await windowsAcl("[Console]::Out.Write([IO.File]::GetAccessControl($env:ACL_TEST_FILE).GetSecurityDescriptorSddlForm('All'))", file)).stdout;
        assert.notEqual(createHash('sha256').update(changed).digest('hex'), createHash('sha256').update(original).digest('hex'));
        assert.equal(await isCurrentArchitectureReceipt(receipt, fx.options()), false);
        const after = (await windowsAcl("[Console]::Out.Write([IO.File]::GetAccessControl($env:ACL_TEST_FILE).GetSecurityDescriptorSddlForm('All'))", file)).stdout;
        assert.equal(createHash('sha256').update(after).digest('hex'), createHash('sha256').update(changed).digest('hex'));
      } finally {
        await windowsAcl("$a=[Security.AccessControl.FileSecurity]::new(); $a.SetSecurityDescriptorSddlForm([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('" + Buffer.from(original).toString('base64') + "')),[Security.AccessControl.AccessControlSections]::Access); [IO.File]::SetAccessControl($env:ACL_TEST_FILE,$a)", file);
      }
      assert.equal(await isCurrentArchitectureReceipt(receipt, fx.options()), true);
    }
  }
});

test('Installed-layout gate works without package lock and rejects changed actual checker or parser bytes', async t => {
  const fx = await setup(t);
  const installed = path.join(fx.directory, 'installed');
  // Independent owned copy: no source edits in the tested Kodo checkout.
  await cp(new URL('../runtime/', import.meta.url), path.join(installed, 'runtime'), { recursive: true });
  await cp(new URL('../package.json', import.meta.url), path.join(installed, 'package.json'));
  const parserSource = fileURLToPath(new URL('../', import.meta.resolve('acorn')));
  await cp(parserSource, path.join(installed, 'node_modules/acorn'), { recursive: true });
  const gatePath = path.join(installed, 'runtime/architecture-gate.mjs');
  const gate = await import(pathToFileURL(gatePath));
  const receipt = await gate.runArchitectureChecks(fx.options());
  assert.equal(receipt.passed, true);
  assert.equal(await gate.isCurrentArchitectureReceipt(receipt, fx.options()), true);
  for (const filename of [gatePath, path.join(installed, 'node_modules/acorn/dist/acorn.mjs')]) {
    const original = await readFile(filename);
    await writeFile(filename, Buffer.concat([original, Buffer.from('\n// changed pin\n')]));
    assert.equal(await gate.isCurrentArchitectureReceipt(receipt, fx.options()), false);
    await writeFile(filename, original);
  }
  assert.equal(await gate.isCurrentArchitectureReceipt(receipt, fx.options()), true);
});

test('Delivery revalidates real architecture evidence after CI and queue waits before merge', async t => {
  const fx = await setup(t);
  await fx.engine.checks(fx.run);
  fx.run.architectureChecks = await runArchitectureChecks(fx.options());
  assert.equal(fx.run.architectureChecks.passed, true);
  const review = { passed: true, headSha: fx.run.headSha, diffHash: await diffHash(fx.run.cwd, fx.run.baseSha) };
  let observations = 0, merges = 0;
  const pr = { number: 1, url: 'https://example.invalid/pr/1', state: 'OPEN', headRefOid: fx.run.headSha, baseRefName: 'main', baseRefOid: fx.run.baseSha,
    statusCheckRollup: [{ __typename: 'CheckRun', name: 'unit', status: 'COMPLETED', conclusion: 'SUCCESS' }, { __typename: 'StatusContext', context: 'kodo/review', state: 'SUCCESS' }] };
  const exec = async (command, args, settings) => {
    const result = value => ({ code: 0, stdout: typeof value === 'string' ? value : JSON.stringify(value), stderr: '' });
    if (command === 'git') {
      if (['fetch', 'push'].includes(args[0])) return result('');
      if (args[0] === 'rev-parse' && args[1] === 'origin/main') return result(fx.run.baseSha);
      return execute(command, args, settings);
    }
    assert.equal(command, 'gh');
    if (args[0] === 'api') return result(args.includes('POST') ? {} : { required_status_checks: { strict: true, contexts: ['unit', 'kodo/review'] }, enforce_admins: { enabled: true } });
    if (args[1] === 'list') return result([pr]);
    if (args[1] === 'view') {
      if (++observations === 2) {
        const file = fx.run.architectureChecks.report.receipts[0].evidence[0].path;
        await chmod(file, 0o600); await writeFile(file, 'tampered during simulated CI wait');
      }
      return result(pr);
    }
    if (args[1] === 'merge') merges++;
    throw Error('Unexpected remote operation');
  };
  await assert.rejects(deliver({ run: fx.run, config: { ...fx.run.config, checks: ['unit'] }, review, cwd: fx.run.cwd, store: fx.engine.store, exec }), { code: 'stale_architecture_checks' });
  assert.equal(observations, 2); assert.equal(merges, 0);
});
