import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm, symlink } from 'node:fs/promises';
import { execute } from '../runtime/command.mjs';
import { toolCatalog } from '../runtime/tools.mjs';
import { inventory } from '../runtime/toolchains.mjs';

const api = () => import('../runtime/security-gates.mjs');
const hash = value => createHash('sha256').update(value).digest('hex');
const config = { enabled: true, autoInstall: false };
const privateText = 'synthetic-private-value-do-not-publish';

async function put(root, file, content) {
  const target = path.join(root, file); await mkdir(path.dirname(target), { recursive: true }); await writeFile(target, content); return target;
}
async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'kodo-security-test-'));
  t.after(async () => {
    assert.equal(path.dirname(root), path.resolve(os.tmpdir())); assert.match(path.basename(root), /^kodo-security-test-/);
    await rm(root, { recursive: true, force: true });
  });
  const cwd = path.join(root, 'project'), artifacts = path.join(root, 'evidence'), toolHome = path.join(root, 'tools');
  await mkdir(cwd); await mkdir(artifacts); await mkdir(toolHome);
  await put(cwd, 'runtime/main.js', 'export const answer = 42;\n');
  await put(cwd, 'tests/main.test.py', 'assert 6 * 7 == 42\n');
  await put(cwd, 'README.md', '# fixture\n');
  await put(cwd, 'node_modules/generated.js', 'not a scanner target');
  await put(cwd, 'skills/example/references/upstream/example.py', 'not a scanner target');
  await execute('git', ['init', '-q', '--initial-branch=fixture'], { cwd });
  await execute('git', ['add', '.'], { cwd });
  await execute('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@localhost', '-c', 'commit.gpgSign=false', 'commit', '-qm', 'fixture'], { cwd });
  const headSha = (await execute('git', ['rev-parse', 'HEAD'], { cwd })).stdout.trim();
  await put(toolHome, '.kodo-tools.json', JSON.stringify({ schemaVersion: 1, owner: 'kodo-managed-tools' }));
  // Only process boundaries are faked. The managed resolver validates actual
  // private files/receipts; these inert executables are never live acceptance.
  for (const id of ['semgrep', 'gitleaks']) {
    const pin = toolCatalog.find(t => t.id === id), pins = [pin];
    const key = `${id === 'semgrep' ? 'python-semgrep' : id}-${hash(JSON.stringify({ schema: 1, platform: process.platform, arch: process.arch, pins })).slice(0, 24)}`;
    const installation = randomUUID(), base = path.join(toolHome, key), directory = path.join(base, installation);
    if (id === 'semgrep') {
      await put(directory, `venv/${process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python'}`, 'inert local process fixture');
      await put(directory, 'venv/pyvenv.cfg', 'include-system-site-packages = false\n');
    } else await put(directory, `native/${pin.assets[`${process.platform}-${process.arch}`].executable}`, 'inert local process fixture');
    await put(base, 'receipt.json', JSON.stringify({ schemaVersion: 1, key, installation, platform: process.platform, arch: process.arch,
      pins: hash(JSON.stringify(pins)), probes: { [id]: pin.version }, files: await inventory(directory) }));
  }
  return { root, cwd, headSha, artifacts, toolHome, config };
}

async function files(directory, prefix = '') {
  const result = [];
  for (const e of await readdir(path.join(directory, prefix), { withFileTypes: true })) {
    const name = prefix + e.name;
    if (e.isDirectory()) result.push(...await files(directory, name + '/')); else result.push(name);
  }
  return result.sort();
}
function scannerRunner(fx, overrides = {}) {
  const calls = [];
  const runner = async (command, args, options) => {
    if (command === 'git') return execute(command, args, options);
    const tool = args.includes('scan') ? 'semgrep' : path.basename(command).startsWith('gitleaks') ? 'gitleaks' : undefined;
    assert.ok(tool, 'no installer, download or unexpected process is allowed');
    calls.push({ tool, command, args, options });
    const targets = await files(options.cwd);
    assert.ok(targets.includes('runtime/main.js')); assert.ok(targets.includes('tests/main.test.py'));
    if (!args.includes('git')) assert.ok(!targets.some(p => p.includes('node_modules') || p.includes('references/upstream') || p.startsWith('.git/')));
    const safe = tool === 'semgrep'
      ? { code: 0, stdout: JSON.stringify({ version: '1.183.0', results: [], errors: [], paths: { scanned: ['runtime/main.js', 'tests/main.test.py'] } }), stderr: '' }
      : { code: 0, stdout: '[]', stderr: '' };
    return overrides[tool] ? overrides[tool]({ args, options, targets, safe }) : safe;
  };
  return { runner, calls };
}

test('Security config defaults are disabled and normalization is strict and stable', async () => {
  const { normalizeSecurityConfig: normalize, securityConfigHash: digest } = await api();
  assert.deepEqual(normalize(), { enabled: false, autoInstall: true, tools: ['semgrep', 'gitleaks'] });
  assert.equal(digest({ enabled: true, tools: ['gitleaks', 'semgrep'] }), digest({ tools: ['semgrep', 'gitleaks'], enabled: true }));
  for (const bad of [null, true, [], { enabled: 'true' }, { autoInstall: 1 }, { tools: [] }, { tools: ['semgrep', 'semgrep'] },
    { tools: ['other'] }, { semgrepConfig: 'https://example.test/rules.yml' }, { semgrepConfig: '../rules.yml' },
    { semgrepConfig: '/rules.yml' }, { semgrepConfig: 'p/default' }, { history: { baseSha: 'HEAD~1' } },
    { history: { baseSha: 'a'.repeat(40), maxCommits: 0 } }, { history: { baseSha: 'a'.repeat(40), maxCommits: 101 } }, { surprise: true }]) assert.throws(() => normalize(bad));
  for (const maxCommits of [1, 100]) assert.equal(normalize({ history: { baseSha: 'a'.repeat(40), maxCommits } }).history.maxCommits, maxCommits);
});

test('Disabled security produces explicit neutral evidence without processes or installations', async () => {
  const { runSecurityChecks, isCurrentSecurityReceipt } = await api(); let calls = 0;
  const receipt = await runSecurityChecks({ headSha: 'a'.repeat(40), runner: async () => { calls++; throw new Error('unexpected'); } });
  assert.equal(calls, 0); assert.equal(receipt.status, 'disabled'); assert.equal(receipt.passed, null);
  assert.deepEqual(receipt.tools, []); assert.equal(isCurrentSecurityReceipt(receipt, { headSha: 'a'.repeat(40) }), true);
});

test('Both pinned scanners scan tracked runtime and tests with isolated offline environments', async t => {
  const fx = await fixture(t), fake = scannerRunner(fx);
  const { runSecurityChecks, isCurrentSecurityReceipt } = await api();
  const receipt = await runSecurityChecks({ ...fx, runner: fake.runner, secrets: { GEMINI_API_KEY: privateText } });
  assert.equal(receipt.status, 'passed'); assert.equal(receipt.passed, true);
  assert.deepEqual(receipt.tools.map(r => [r.tool, r.version, r.status]), [['semgrep', '1.183.0', 'passed'], ['gitleaks', '8.30.1', 'passed']]);
  assert.equal(isCurrentSecurityReceipt(receipt, fx), true);
  for (const { tool, args, options } of fake.calls) {
    assert.equal(options.allowFailure, true); assert.equal(options.rawOutput, true);
    assert.ok(options.timeoutMs > 0 && options.timeoutMs <= 180000);
    assert.equal(options.env.GEMINI_API_KEY, undefined); assert.ok(!JSON.stringify(options.env).includes(privateText));
    assert.equal(options.env.SEMGREP_SEND_METRICS, 'off'); assert.equal(options.env.SEMGREP_ENABLE_VERSION_CHECK, '0');
    assert.ok(!options.cwd.startsWith(fx.cwd));
    if (tool === 'semgrep') {
      assert.ok(args.includes('--metrics=off') && args.includes('--disable-version-check') && args.includes('--strict'));
      assert.ok(args.includes('--no-git-ignore') && args.includes('--x-ignore-semgrepignore-files'));
      assert.equal(options.env.TEMP, options.env.TMP); assert.equal(options.env.TMP, options.env.TMPDIR);
      assert.ok(!options.env.TMPDIR.startsWith(fx.artifacts));
      if (process.platform === 'win32') assert.ok(options.env.TMPDIR.length <= 70);
    } else {
      assert.ok(args.includes('--redact=100') && args.includes('--ignore-gitleaks-allow') && args.includes('--exit-code=42'));
      assert.ok(args.includes('--config'));
    }
  }
  const retained = await files(receipt.evidenceRoot);
  assert.ok(retained.length >= 2); assert.ok(retained.every(f => /^[a-z]+\.json$/.test(f)), 'raw snapshots and scanner homes must be removed');
});

test('Findings fail with only typed locations and no secret match snippets or raw output', async t => {
  const fx = await fixture(t);
  const fake = scannerRunner(fx, {
    semgrep: () => ({ code: 1, stdout: JSON.stringify({ version: '1.183.0', errors: [], paths: { scanned: ['runtime/main.js', 'tests/main.test.py'] },
      results: [{ check_id: 'kodo.javascript.eval', path: 'runtime/main.js', start: { line: 7 }, extra: { severity: 'ERROR', message: privateText, lines: privateText, metadata: { secret: privateText } } }] }), stderr: privateText }),
    gitleaks: () => ({ code: 42, stdout: JSON.stringify([{ RuleID: 'github-pat', File: 'tests/main.test.py', StartLine: 9, Secret: privateText, Match: privateText, Description: privateText }]), stderr: '' })
  });
  const receipt = await (await api()).runSecurityChecks({ ...fx, runner: fake.runner });
  assert.equal(receipt.passed, false); assert.equal(receipt.status, 'failed');
  assert.deepEqual(receipt.tools.map(r => r.status), ['failed', 'failed']);
  assert.deepEqual(receipt.tools[0].findings, [{ ruleId: 'kodo.javascript.eval', file: 'runtime/main.js', line: 7, severity: 'ERROR' }]);
  assert.deepEqual(receipt.tools[1].findings, [{ ruleId: 'github-pat', file: 'tests/main.test.py', line: 9, severity: 'ERROR' }]);
  assert.ok(!JSON.stringify(receipt).includes(privateText));
  for (const f of await files(receipt.evidenceRoot)) assert.ok(!(await readFile(path.join(receipt.evidenceRoot, f), 'utf8')).includes(privateText));
});

for (const [name, tool, result] of [
  ['Semgrep RPC errors', 'semgrep', { code: 2, stdout: '{"results":[],"errors":[{"message":"private"}]}', stderr: privateText }],
  ['Semgrep missing coverage', 'semgrep', { code: 0, stdout: '{"version":"1.183.0","results":[],"errors":[],"paths":{"scanned":[]}}', stderr: '' }],
  ['Semgrep partial coverage', 'semgrep', { code: 0, stdout: '{"version":"1.183.0","results":[],"errors":[],"paths":{"scanned":["runtime/main.js"]}}', stderr: '' }],
  ['Semgrep wrong version', 'semgrep', { code: 0, stdout: '{"version":"1.0.0","results":[],"errors":[],"paths":{"scanned":["runtime/main.js","tests/main.test.py"]}}', stderr: '' }],
  ['Semgrep warning errors', 'semgrep', { code: 0, stdout: '{"version":"1.183.0","results":[],"errors":[{}],"paths":{"scanned":["runtime/main.js","tests/main.test.py"]}}', stderr: '' }],
  ['Gitleaks execution error', 'gitleaks', { code: 1, stdout: '[]', stderr: privateText }],
  ['Gitleaks logged read error with zero exit', 'gitleaks', { code: 0, stdout: '[]', stderr: privateText }],
  ['Gitleaks empty stdout', 'gitleaks', { code: 0, stdout: '', stderr: '' }],
  ['Gitleaks malformed JSON', 'gitleaks', { code: 0, stdout: privateText, stderr: '' }],
  ['Gitleaks false clean exit', 'gitleaks', { code: 0, stdout: '[{"RuleID":"x","File":"runtime/main.js","StartLine":1}]', stderr: '' }],
  ['Gitleaks malformed finding', 'gitleaks', { code: 42, stdout: '[{"RuleID":"x","File":"../private","StartLine":0,"Secret":"private"}]', stderr: '' }]
]) test(`${name} cannot produce a passing receipt`, async t => {
  const fx = await fixture(t), fake = scannerRunner(fx, { [tool]: () => result });
  const { runSecurityChecks, isCurrentSecurityReceipt } = await api();
  const receipt = await runSecurityChecks({ ...fx, runner: fake.runner });
  assert.equal(receipt.passed, false); assert.equal(isCurrentSecurityReceipt(receipt, fx), false);
  assert.equal(receipt.tools.find(r => r.tool === tool).status, 'error');
  assert.ok(!JSON.stringify(receipt).includes(privateText));
});

test('Thrown runner errors and cancellation are safe failures with no raw exception data', async t => {
  const fx = await fixture(t), { runSecurityChecks } = await api();
  const fake = scannerRunner(fx, { semgrep: () => { throw Object.assign(new Error(privateText), { result: { stdout: privateText } }); } });
  const receipt = await runSecurityChecks({ ...fx, runner: fake.runner });
  assert.equal(receipt.tools[0].status, 'error'); assert.ok(!JSON.stringify(receipt).includes(privateText));
  const controller = new AbortController(); controller.abort(new Error(privateText)); let calls = 0;
  const cancelled = await runSecurityChecks({ ...fx, signal: controller.signal, runner: async () => { calls++; } });
  assert.equal(cancelled.passed, false); assert.equal(calls, 0); assert.ok(!JSON.stringify(cancelled).includes(privateText));
});

test('Unavailable managed tools block without a global fallback or automatic install when disabled', async t => {
  const fx = await fixture(t); await rm(fx.toolHome, { recursive: true });
  const { runSecurityChecks } = await api(); let scans = 0;
  const receipt = await runSecurityChecks({ ...fx, runner: async (cmd, args, opts) => { if (cmd === 'git') return execute(cmd, args, opts); scans++; throw new Error(privateText); } });
  assert.equal(receipt.status, 'blocked'); assert.equal(receipt.passed, false); assert.equal(scans, 0);
  assert.deepEqual(receipt.tools.map(t => t.reason), ['tool_missing', 'tool_missing']);
});

test('Receipts reject changed head configuration pins missing evidence and tampered bytes', async t => {
  const fx = await fixture(t), { runSecurityChecks, isCurrentSecurityReceipt } = await api();
  const fake = scannerRunner(fx), receipt = await runSecurityChecks({ ...fx, runner: fake.runner });
  assert.equal(isCurrentSecurityReceipt(receipt, fx), true);
  assert.equal(isCurrentSecurityReceipt(receipt, { ...fx, headSha: 'b'.repeat(40) }), false);
  assert.equal(isCurrentSecurityReceipt(receipt, { ...fx, config: { ...config, tools: ['semgrep'] } }), false);
  assert.equal(isCurrentSecurityReceipt({ ...receipt, pinsHash: '0'.repeat(64) }, fx), false);
  const missing = structuredClone(receipt); missing.tools.pop(); assert.equal(isCurrentSecurityReceipt(missing, fx), false);
  const forged = structuredClone(receipt); forged.tools[0].scannedFiles = 0; assert.equal(isCurrentSecurityReceipt(forged, fx), false);
  const evidence = receipt.tools[0].evidence[0]; await writeFile(evidence.path, '{}');
  assert.equal(isCurrentSecurityReceipt(receipt, fx), false);
});

test('Previous passed receipts never skip execution or bless a new scanner error', async t => {
  const fx = await fixture(t), { runSecurityChecks } = await api();
  const clean = scannerRunner(fx), previous = await runSecurityChecks({ ...fx, runner: clean.runner });
  const broken = scannerRunner(fx, { gitleaks: () => ({ code: 1, stdout: '[]', stderr: privateText }) });
  const receipt = await runSecurityChecks({ ...fx, previous, runner: broken.runner });
  assert.equal(broken.calls.length, 2); assert.equal(receipt.passed, false);
});

test('Local Semgrep rule bytes are bound to evidence and remote or escaping rule sources fail closed', async t => {
  const fx = await fixture(t), { runSecurityChecks, isCurrentSecurityReceipt } = await api();
  const rules = await put(fx.cwd, 'rules.yml', 'rules:\n  - id: fixture\n    languages: [javascript]\n    message: unsafe\n    severity: ERROR\n    pattern: eval(...)\n');
  await execute('git', ['add', '.'], { cwd: fx.cwd });
  await execute('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@localhost', '-c', 'commit.gpgSign=false', 'commit', '-qm', 'rules'], { cwd: fx.cwd });
  fx.headSha = (await execute('git', ['rev-parse', 'HEAD'], { cwd: fx.cwd })).stdout.trim();
  fx.config = { ...config, semgrepConfig: 'rules.yml' };
  const fake = scannerRunner(fx), receipt = await runSecurityChecks({ ...fx, runner: fake.runner });
  assert.equal(receipt.passed, true); assert.equal(isCurrentSecurityReceipt(receipt, fx), true);
  await writeFile(rules, 'rules: []\n'); assert.equal(isCurrentSecurityReceipt(receipt, fx), false);
  const blocked = await runSecurityChecks({ ...fx, runner: fake.runner }); assert.equal(blocked.passed, false);
});

test('Dirty changed heads and in-project artifacts are rejected before scanning', async t => {
  const fx = await fixture(t), { runSecurityChecks } = await api(), fake = scannerRunner(fx);
  const wrong = await runSecurityChecks({ ...fx, headSha: 'd'.repeat(40), runner: fake.runner }); assert.equal(wrong.passed, false);
  const inGit = await runSecurityChecks({ ...fx, artifacts: path.join(fx.cwd, 'private'), runner: fake.runner }); assert.equal(inGit.passed, false);
  await put(fx.cwd, 'runtime/main.js', 'changed\n');
  const dirty = await runSecurityChecks({ ...fx, runner: fake.runner }); assert.equal(dirty.passed, false); assert.equal(fake.calls.length, 0);
});

test('Assume-unchanged source edits cannot be certified as the checked Git head', async t => {
  const fx = await fixture(t), { runSecurityChecks } = await api(), fake = scannerRunner(fx);
  await execute('git', ['update-index', '--assume-unchanged', 'runtime/main.js'], { cwd: fx.cwd });
  await put(fx.cwd, 'runtime/main.js', 'export const changed = true;\n');
  assert.equal((await execute('git', ['status', '--porcelain'], { cwd: fx.cwd })).stdout, '');
  const receipt = await runSecurityChecks({ ...fx, runner: fake.runner });
  assert.equal(receipt.passed, false); assert.equal(fake.calls.length, 0);
});

test('Flow-style remote validators are rejected without scanner or network execution', async t => {
  const fx = await fixture(t), { runSecurityChecks } = await api(), fake = scannerRunner(fx);
  await put(fx.cwd, 'rules.yml', 'rules:\n  - {id: remote, languages: [python], pattern: eval(...), message: unsafe, severity: ERROR, "validators": [{http: {request: {url: "https://example.test"}}}]}\n');
  await execute('git', ['add', '.'], { cwd: fx.cwd });
  await execute('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@localhost', '-c', 'commit.gpgSign=false', 'commit', '-qm', 'rules'], { cwd: fx.cwd });
  fx.headSha = (await execute('git', ['rev-parse', 'HEAD'], { cwd: fx.cwd })).stdout.trim();
  const receipt = await runSecurityChecks({ ...fx, config: { ...config, semgrepConfig: 'rules.yml' }, runner: fake.runner });
  assert.equal(receipt.passed, false); assert.equal(fake.calls.length, 0);
});

test('Bounded history uses only the explicit base-to-checked-head range and retains current findings', async t => {
  const fx = await fixture(t), { runSecurityChecks, isCurrentSecurityReceipt } = await api(), baseSha = fx.headSha;
  await put(fx.cwd, 'README.md', '# next fixture\n');
  await execute('git', ['add', '.'], { cwd: fx.cwd });
  await execute('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@localhost', '-c', 'commit.gpgSign=false', 'commit', '-qm', 'next fixture'], { cwd: fx.cwd });
  fx.headSha = (await execute('git', ['rev-parse', 'HEAD'], { cwd: fx.cwd })).stdout.trim();
  fx.config = { ...config, history: { baseSha, maxCommits: 1 } };
  const fake = scannerRunner(fx), receipt = await runSecurityChecks({ ...fx, runner: fake.runner });
  assert.equal(receipt.passed, true); assert.equal(isCurrentSecurityReceipt(receipt, fx), true);
  const call = fake.calls.find(c => c.args.includes('git'));
  assert.ok(call); assert.ok(call.args.includes(`--log-opts=${baseSha}..${fx.headSha} --max-count=1 --no-ext-diff --no-textconv`));
  assert.ok(!call.args.includes('--all')); assert.equal(receipt.tools[1].historyCommits, 1);
  const limited = await runSecurityChecks({ ...fx, config: { ...config, history: { baseSha: fx.headSha, maxCommits: 1 } }, runner: fake.runner });
  assert.equal(limited.passed, false); assert.equal(limited.tools[1].reason, 'history_limit');
  const found = scannerRunner(fx, { gitleaks: ({ args, safe }) => args.includes('git') ? safe : { code: 42, stdout: '[{"RuleID":"fixture","File":"README.md","StartLine":1}]', stderr: '' } });
  const failed = await runSecurityChecks({ ...fx, runner: found.runner });
  assert.equal(failed.passed, false); assert.equal(failed.tools[1].findings.length, 1);
});

test('Known provider values in allowed metadata are redacted before evidence is written', async t => {
  const fx = await fixture(t), { runSecurityChecks } = await api();
  const fake = scannerRunner(fx, { gitleaks: () => ({ code: 42, stdout: JSON.stringify([{ RuleID: privateText, File: 'runtime/main.js', StartLine: 1 }]), stderr: '' }) });
  const receipt = await runSecurityChecks({ ...fx, runner: fake.runner, secrets: { GEMINI_API_KEY: privateText } });
  assert.equal(receipt.passed, false); assert.equal(receipt.tools[1].findings[0].ruleId, '[REDACTED]');
  assert.ok(!JSON.stringify(receipt).includes(privateText));
  const report = await readFile(receipt.tools[1].evidence[0].path, 'utf8'); assert.ok(!report.includes(privateText));
});

test('Receipt freshness also rejects edits to source bytes without a new head', async t => {
  const fx = await fixture(t), { runSecurityChecks, isCurrentSecurityReceipt } = await api(), fake = scannerRunner(fx);
  const receipt = await runSecurityChecks({ ...fx, runner: fake.runner }); assert.equal(isCurrentSecurityReceipt(receipt, fx), true);
  await put(fx.cwd, 'runtime/main.js', 'export const answer = 43;\n');
  assert.equal(isCurrentSecurityReceipt(receipt, fx), false);
});

test('An oversized history range blocks instead of silently truncating to the budget', async t => {
  const fx = await fixture(t), { runSecurityChecks } = await api(), baseSha = fx.headSha;
  for (const n of [1, 2]) {
    await put(fx.cwd, 'README.md', `# fixture revision ${n}\n`);
    await execute('git', ['add', '.'], { cwd: fx.cwd });
    await execute('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@localhost', '-c', 'commit.gpgSign=false', 'commit', '-qm', 'fixture revision'], { cwd: fx.cwd });
  }
  fx.headSha = (await execute('git', ['rev-parse', 'HEAD'], { cwd: fx.cwd })).stdout.trim();
  const fake = scannerRunner(fx);
  const receipt = await runSecurityChecks({ ...fx, config: { ...config, history: { baseSha, maxCommits: 1 } }, runner: fake.runner });
  assert.equal(receipt.passed, false); assert.equal(receipt.tools[1].reason, 'history_limit');
  assert.ok(!fake.calls.some(c => c.args.includes('git')));
});

test('Enabled autoInstall uses only managed pins and safely blocks installation failures', async t => {
  const fx = await fixture(t), { runSecurityChecks } = await api(), commands = [];
  await rm(fx.toolHome, { recursive: true });
  const receipt = await runSecurityChecks({ ...fx, config: { enabled: true, autoInstall: true }, runner: async (command, args, options) => {
    if (command === 'git') return execute(command, args, options);
    commands.push({ command, args });
    assert.ok(options.cwd.startsWith(fx.toolHome));
    assert.equal(options.env.GEMINI_API_KEY, undefined);
    throw new Error(privateText);
  } });
  assert.equal(receipt.passed, false); assert.equal(receipt.status, 'blocked');
  assert.deepEqual(commands.map(c => c.command), ['uv', process.execPath]);
  assert.ok(commands[1].args.includes(toolCatalog.find(t => t.id === 'gitleaks').assets[`${process.platform}-${process.arch}`].url));
  assert.ok(!JSON.stringify(receipt).includes(privateText));
});

test('A scanner-only project config runs exactly its requested tool', async t => {
  const fx = await fixture(t), { runSecurityChecks, isCurrentSecurityReceipt } = await api(), fake = scannerRunner(fx);
  fx.config = { ...config, tools: ['gitleaks'] };
  const receipt = await runSecurityChecks({ ...fx, runner: fake.runner });
  assert.equal(receipt.passed, true); assert.deepEqual(fake.calls.map(c => c.tool), ['gitleaks']);
  assert.equal(isCurrentSecurityReceipt(receipt, fx), true);
});

test('Gitleaks reports supplied scope counts without inventing observed file coverage', async t => {
  const fx = await fixture(t), { runSecurityChecks } = await api(), fake = scannerRunner(fx);
  const receipt = await runSecurityChecks({ ...fx, runner: fake.runner });
  const row = receipt.tools.find(t => t.tool === 'gitleaks');
  assert.equal(row.status, 'passed'); assert.equal(row.scannedFiles, null); assert.equal(row.scopeFiles, 3);
});

test('Tracked source symlinks block before a scanner can follow them', async t => {
  const fx = await fixture(t), { runSecurityChecks } = await api(), fake = scannerRunner(fx);
  // Git's index mode supplies a portable symlink fixture even on Windows
  // without the privilege needed to create a native file symlink.
  await execute('git', ['update-index', '--add', '--cacheinfo', '120000', (await execute('git', ['rev-parse', 'HEAD:runtime/main.js'], { cwd: fx.cwd })).stdout.trim(), 'linked.js'], { cwd: fx.cwd });
  await put(fx.cwd, 'linked.js', 'export const answer = 42;\n');
  await execute('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@localhost', '-c', 'commit.gpgSign=false', 'commit', '-qm', 'link fixture'], { cwd: fx.cwd });
  fx.headSha = (await execute('git', ['rev-parse', 'HEAD'], { cwd: fx.cwd })).stdout.trim();
  const receipt = await runSecurityChecks({ ...fx, runner: fake.runner });
  assert.equal(receipt.passed, false); assert.equal(fake.calls.length, 0);
});

test('Edits during a scanner run invalidate the whole checked receipt', async t => {
  const fx = await fixture(t), { runSecurityChecks } = await api();
  const fake = scannerRunner(fx, { gitleaks: async ({ safe }) => { await put(fx.cwd, 'runtime/main.js', 'changed during scan\n'); return safe; } });
  const receipt = await runSecurityChecks({ ...fx, runner: fake.runner }); assert.equal(receipt.passed, false);
});

test('Evidence symlinks cannot be used to forge or redirect a fresh receipt', async t => {
  const fx = await fixture(t), { runSecurityChecks, isCurrentSecurityReceipt } = await api(), fake = scannerRunner(fx);
  const receipt = await runSecurityChecks({ ...fx, runner: fake.runner });
  const file = receipt.tools[0].evidence[0].path, copy = path.join(fx.root, 'copied.json');
  await writeFile(copy, await readFile(file)); await rm(file);
  try { await symlink(copy, file); }
  catch (e) { if (process.platform === 'win32' && e.code === 'EPERM') { assert.equal(isCurrentSecurityReceipt(receipt, fx), false); return; } throw e; }
  assert.equal(isCurrentSecurityReceipt(receipt, fx), false);
});
