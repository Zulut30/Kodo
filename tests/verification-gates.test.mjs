import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import path from 'node:path';
import { deliver } from '../runtime/delivery.mjs';
import { runUIVerification } from '../runtime/ui-verification.mjs';
import { Engine } from '../runtime/engine.mjs';
import { Store } from '../runtime/store.mjs';
import { readConfig } from '../runtime/config.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const cli = path.join(root, 'cli/index.mjs');
function fixture(t) {
  const home = mkdtempSync(path.join(os.tmpdir(), 'kodo-gate-cli-'));
  t.after(() => { assert.equal(path.dirname(home), path.resolve(os.tmpdir())); rmSync(home, { recursive: true, force: true }); });
  const project = path.join(home, 'project'); mkdirSync(project);
  const env = { ...process.env, KODO_HOME: path.join(home, 'state'), KODO_TOOL_HOME: path.join(home, 'tools'), KODO_CREDENTIAL_HOME: path.join(home, 'credentials') };
  const run = args => spawnSync(process.execPath, [cli, ...args], { cwd: project, env, encoding: 'utf8', windowsHide: true });
  return { home, project, env, run };
}
test('Worker PATH keeps the current Node runtime first and only ready managed ripgrep before inherited entries', async t => {
  const fx = fixture(t), nodeDirectory = path.dirname(process.execPath), rgDirectory = path.join(fx.home, 'managed-rg');
  const pathName = Object.keys(process.env).find(name => name.toLowerCase() === 'path') || 'PATH';
  const inheritedEntries = process.env[pathName] ? process.env[pathName].split(path.delimiter) : [];
  for (const ready of [true, false]) {
    const calls = [], engine = new Engine({ store: { home: fx.env.KODO_HOME }, tools: {
      resolveTool: async (id, options) => {
        calls.push({ id, options });
        return { id, ready, command: path.join(rgDirectory, process.platform === 'win32' ? 'rg.exe' : 'rg') };
      }
    } });
    // Cache initialization has dedicated setup tests; isolate the PATH contract.
    engine.withLease = async () => path.join(fx.home, 'cache');
    const environment = await engine.executionEnvironment({}, fx.project);
    const entries = environment[pathName].split(path.delimiter);
    assert.deepEqual(calls, [{ id: 'ripgrep', options: { project: fx.project } }]);
    assert.equal(entries[0], nodeDirectory);
    assert.deepEqual(entries, ready ? [nodeDirectory, rgDirectory, ...inheritedEntries] : [nodeDirectory, ...inheritedEntries]);
    assert.equal(entries.includes(rgDirectory), ready);
  }
});

test('Tools CLI metadata is offline and validates subcommands arity and flags before side effects', t => {
  const fx = fixture(t), result = fx.run(['tools', 'list', '--json']);
  assert.equal(result.status, 0, result.stderr); assert.equal(JSON.parse(result.stdout).length, 10);
  assert.equal(existsSync(fx.env.KODO_HOME), false); assert.equal(existsSync(fx.env.KODO_TOOL_HOME), false); assert.equal(existsSync(fx.env.KODO_CREDENTIAL_HOME), false);
  const doctor = fx.run(['tools', 'doctor', '--live', '--json']);
  assert.equal(doctor.status, 2, doctor.stderr); assert.equal(JSON.parse(doctor.stdout).length, 10);
  assert.equal(existsSync(fx.env.KODO_TOOL_HOME), false);
  for (const args of [['tools'], ['tools', 'list', 'extra'], ['tools', 'install'], ['tools', 'install', 'unknown'], ['tools', 'doctor', 'extra'], ['tools', 'list', '--live'], ['tools', 'list', '--json', '--json'], ['ui', 'verify', '--live'], ['security', 'verify', 'extra']]) {
    const invalid = fx.run(args); assert.notEqual(invalid.status, 0, args.join(' '));
  }
  assert.equal(existsSync(fx.env.KODO_CREDENTIAL_HOME), false); assert.equal(existsSync(fx.env.KODO_TOOL_HOME), false);
});
test('Standalone CLI records explicit disabled receipts without credentials installation or provider calls', t => {
  const fx = fixture(t);
  writeFileSync(path.join(fx.project, 'source.txt'), 'fixture\n');
  for (const args of [['init', '-b', 'main'], ['config', 'user.name', 'Fixture'], ['config', 'user.email', 'fixture@example.invalid'], ['add', '.'], ['commit', '-m', 'Fixture']]) assert.equal(spawnSync('git', args, { cwd: fx.project, windowsHide: true }).status, 0);
  for (const kind of ['ui', 'security']) {
    const result = fx.run([kind, 'verify', '--project', fx.project, '--json']);
    assert.equal(result.status, 0, result.stderr);
    const receipt = JSON.parse(result.stdout); assert.equal(receipt.status, 'disabled'); assert.equal(receipt.passed, null); assert.match(receipt.headSha, /^[a-f0-9]{40}$/);
  }
  assert.equal(existsSync(fx.env.KODO_CREDENTIAL_HOME), false); assert.equal(existsSync(fx.env.KODO_TOOL_HOME), false);
  fx.env.KODO_HOME = path.join(fx.project, 'state');
  const nestedState = fx.run(['ui', 'verify', '--json']); assert.equal(nestedState.status, 0, nestedState.stderr);
  assert.equal(existsSync(fx.env.KODO_HOME), false, 'private verification artifacts must not be written into Git even with a project-local KODO_HOME');
  writeFileSync(path.join(fx.project, 'source.txt'), 'changed');
  assert.notEqual(fx.run(['security', 'verify', '--json']).status, 0);
});
test('Standalone CLI enabled missing tools return nonzero blocked evidence without auto-install', t => {
  const fx = fixture(t);
  const config = { uiVerification: { enabled: true, autoInstall: false, cases: [{ id: 'fixture', tool: 'browser-harness', url: 'http://127.0.0.1:1', assertions: [{ selector: 'body', exists: true }] }] }, security: { enabled: true, autoInstall: false } };
  writeFileSync(path.join(fx.project, 'kodo.config.json'), JSON.stringify(config));
  for (const args of [['init', '-b', 'main'], ['config', 'user.name', 'Fixture'], ['config', 'user.email', 'fixture@example.invalid'], ['add', '.'], ['commit', '-m', 'Fixture']]) assert.equal(spawnSync('git', args, { cwd: fx.project, windowsHide: true }).status, 0);
  for (const kind of ['ui', 'security']) {
    const result = fx.run([kind, 'verify', '--json']); assert.equal(result.status, 2, result.stderr);
    const receipt = JSON.parse(result.stdout); assert.equal(receipt.status, 'blocked'); assert.equal(receipt.passed, false);
  }
  assert.equal(existsSync(fx.env.KODO_TOOL_HOME), false); assert.equal(existsSync(fx.env.KODO_CREDENTIAL_HOME), false);
});
test('Direct delivery rejects missing forged or stale enabled gate receipts before publishing', async () => {
  const headSha = 'a'.repeat(40), diff = 'fixture diff', calls = [];
  const run = { id: 'fixture', headSha, baseSha: 'b'.repeat(40), branch: 'kodo/fixture', project: root, checks: { headSha }, uiVerification: { schemaVersion: 1, status: 'passed', passed: true, headSha }, securityChecks: { schemaVersion: 1, status: 'passed', passed: true, headSha } };
  const review = { passed: true, headSha, diffHash: createHash('sha256').update(diff).digest('hex') };
  const exec = async (command, args) => {
    calls.push([command, args]);
    if (command === 'git' && args[0] === 'rev-parse') return { code: 0, stdout: headSha };
    if (command === 'git' && args[0] === 'diff') return { code: 0, stdout: diff };
    if (command === 'git' && args[0] === 'status') return { code: 0, stdout: '' };
    throw new Error('Must not reach remote publishing');
  };
  for (const receipt of [undefined, run.uiVerification, { ...run.uiVerification, headSha: 'c'.repeat(40) }]) {
    await assert.rejects(deliver({ run: { ...run, uiVerification: receipt }, review, config: { repository: 'fixture/repo', uiVerification: { enabled: true, cases: [{ id: 'case', tool: 'browser-harness', url: 'http://localhost', assertions: [{ selector: 'body', exists: true }] }] } }, exec }), { code: 'stale_ui_verification' });
  }
  await assert.rejects(deliver({ run, review, config: { repository: 'fixture/repo', security: { enabled: true } }, exec }), { code: 'stale_security_checks' });
  await assert.rejects(deliver({ run: { ...run, config: { security: { enabled: true } } }, review, config: { repository: 'fixture/repo', security: { enabled: false } }, exec }), { code: 'stale_security_checks' });
  assert.ok(calls.every(([command, args]) => command === 'git' && ['rev-parse', 'diff', 'status'].includes(args[0])));
});

test('Direct delivery rechecks real fixture evidence bytes and configuration rather than trusting saved success', async t => {
  const fx = fixture(t), headSha = 'a'.repeat(40), diff = 'fixture diff';
  const config = { enabled: true, autoInstall: false, cases: [{ id: 'fixture', tool: 'browser-harness', url: 'http://127.0.0.1:1', assertions: [{ selector: 'body', text: 'Ready' }] }] };
  const uiVerification = await runUIVerification({ cwd: fx.project, artifacts: path.join(fx.home, 'artifacts'), headSha, config, caseRunner: async () => ({ schemaVersion: 1, status: 'completed', observations: [{ exists: true, count: 1, text: 'Ready', value: null }] }) });
  assert.equal(uiVerification.status, 'passed');
  const run = { id: 'fixture', headSha, baseSha: 'b'.repeat(40), branch: 'kodo/fixture', checks: { headSha }, uiVerification };
  const review = { passed: true, headSha, diffHash: createHash('sha256').update(diff).digest('hex') };
  const exec = async (command, args) => {
    if (command === 'git' && args[0] === 'rev-parse') return { code: 0, stdout: headSha };
    if (command === 'git' && args[0] === 'diff') return { code: 0, stdout: diff };
    if (command === 'git' && args[0] === 'status') return { code: 0, stdout: '' };
    throw Object.assign(new Error('Gate passed; stop before remote operation'), { code: 'after_gate' });
  };
  const options = { run, review, cwd: fx.project, config: { repository: 'fixture/repo', uiVerification: config }, exec };
  await assert.rejects(deliver(options), { code: 'after_gate' });
  run.config = { uiVerification: config };
  await assert.rejects(deliver({ ...options, config: { repository: 'fixture/repo', uiVerification: { enabled: false } } }), { code: 'stale_ui_verification' });
  await assert.rejects(deliver({ ...options, run: { ...run, uiVerification: undefined }, config: { repository: 'fixture/repo' } }), { code: 'stale_ui_verification' });
  await assert.rejects(deliver({ ...options, config: { ...options.config, uiVerification: { ...config, maxSteps: 13 } } }), { code: 'stale_ui_verification' });
  writeFileSync(uiVerification.cases[0].evidence[0].path, 'tampered');
  await assert.rejects(deliver(options), { code: 'stale_ui_verification' });
});

test('Engine failed UI readback after real local checks blocks independent review and retains actionable safe evidence', async t => {
  const fx = fixture(t), uiVerification = { enabled: true, autoInstall: false, cases: [{ id: 'save', tool: 'browser-harness',
    url: 'http://127.0.0.1:1/', assertions: [{ selector: '#result', text: 'Saved' }] }] };
  writeFileSync(path.join(fx.project, 'value.mjs'), 'export const value = 2;\n');
  writeFileSync(path.join(fx.project, 'kodo.config.json'), JSON.stringify({ repairRounds: 1, researchBudget: 0, uiVerification,
    commands: { test: [{ command: process.execPath, args: ['--input-type=module', '-e', "import assert from 'node:assert/strict'; import {value} from './value.mjs'; assert.equal(value, 2); console.log('VALUE_CHECK_PASSED');"] }] } }));
  const git = (...args) => {
    const result = spawnSync('git', args, { cwd: fx.project, encoding: 'utf8', windowsHide: true });
    assert.equal(result.status, 0, result.stderr); return result.stdout.trim();
  };
  git('init', '-b', 'main'); git('config', 'user.name', 'Gate Fixture'); git('config', 'user.email', 'gate@example.invalid');
  git('config', 'commit.gpgSign', 'false'); git('add', '.'); git('commit', '-m', 'Gate baseline');
  const baseSha = git('rev-parse', 'HEAD'), config = await readConfig(fx.project), store = new Store(fx.env.KODO_HOME);
  try {
    const task = { id: 'feature', role: 'developer', description: 'Expose value two', dependsOn: [], writePaths: ['value.mjs'], acceptance: ['value equals two'], parallel: false };
    const run = store.createRun({ project: fx.project, task: 'Require verified UI', config, baseSha, client: 'codex', providers: 'current',
      completed: { analysis: true, implementation: true }, plan: { summary: 'Value feature', tasks: [task] }, nodes: { feature: { id: 'feature', status: 'integrated', headSha: baseSha } } });
    const worktreeRoot = path.join(fx.home, 'worktrees');
    Object.assign(run, { worktreeRoot, cwd: path.join(worktreeRoot, 'integration'), branch: `kodo/${run.id}`, artifacts: path.join(store.home, 'runs', run.id) });
    store.updateRun(run.id, run);
    let gateCalls = 0, providerCalls = 0;
    const engine = new Engine({ store, provider: {
      discoverProviders: async () => [{ id: 'subscription-fixture', client: 'codex', model: 'gpt-6.1-sol', available: true }],
      runSession: async () => { providerCalls++; return { output: { passed: true, findings: [] } }; }
    }, tools: { resolveTool: async id => ({ id, ready: false }) }, gates: {
      runUIVerification: async options => {
        gateCalls++;
        const saved = store.getRun(run.id);
        assert.equal(saved.checks.headSha, options.headSha); assert.equal(saved.checks.results[0].exitCode, 0);
        assert.match(saved.checks.results[0].output, /VALUE_CHECK_PASSED/);
        return runUIVerification({ ...options, caseRunner: async () => ({ schemaVersion: 1, status: 'completed',
          observations: [{ exists: true, count: 1, text: 'Not saved', value: null }], history: 'RAW_UI_HISTORY_SENTINEL' }) });
      }
    } });
    const blocked = await engine.run(run.id);
    assert.equal(blocked.state, 'blocked'); assert.equal(blocked.error.code, 'blocked');
    assert.equal(gateCalls, 1); assert.equal(providerCalls, 0, 'neither independent review nor repair may run after an exhausted failed gate');
    assert.equal(blocked.review, null); assert.equal(blocked.uiVerification.passed, false);
    assert.equal(blocked.uiVerification.cases[0].status, 'failed');
    assert.deepEqual(blocked.uiVerification.cases[0].assertions, [{ index: 0, passed: false, kind: 'dom' }]);
    assert.equal(blocked.controllerAssessment.reason, 'repair_budget_exhausted');
    assert.match(blocked.controllerAssessment.summary, /save/); assert.match(blocked.controllerAssessment.summary, /failedAssertions/);
    assert.doesNotMatch(blocked.controllerAssessment.summary, /RAW_UI_HISTORY_SENTINEL|Not saved/);
    assert.equal(existsSync(blocked.uiVerification.cases[0].evidence[0].path), true);
    assert.equal(git('rev-parse', 'HEAD'), baseSha); assert.equal(git('status', '--porcelain'), '');
  } finally { store.close(); }
});
