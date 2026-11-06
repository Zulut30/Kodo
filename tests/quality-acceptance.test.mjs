// Independent phase-02 acceptance: public APIs only; every tool below is an
// offline fixture, never evidence that an SDK, provider or release was tested.
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, writeFile, rm, symlink } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { QualityProfileRegistry } from '../runtime/quality.mjs';
import { runQuality, isCurrentQualityReceipt } from '../runtime/quality-runner.mjs';
import { resolveTool, installTools, toolCatalog } from '../runtime/tools.mjs';
import { execute } from '../runtime/delivery.mjs';

const cli = fileURLToPath(new URL('../cli/index.mjs', import.meta.url));
const digest = value => createHash('sha256').update(value).digest('hex');
const output = (stdout = '', code = 0, stderr = '') => ({ stdout, code, stderr });
const versions = { oxlint: '1.91.0', oxfmt: '0.76.0', typescript: '7.0.2', stylelint: '18.0.0', 'html-validate': '11.18.0', sqlfluff: '4.5.0' };
const banners = { oxlint: 'Version: 1.91.0', oxfmt: 'Version: 0.76.0', typescript: 'Version 7.0.2', stylelint: '18.0.0', 'html-validate': 'html-validate-11.18.0', sqlfluff: 'python -m sqlfluff, version 4.5.0', dotnet: '10.0.302', rustfmt: 'rustfmt 1.8.0-stable (fixture 2026-01-01)', go: 'go version go1.24.0 windows/amd64', php: 'PHP 8.4.21 (cli)' };
const cases = [
  { language: 'csharp', file: 'Program.cs', source: 'class Program { static void Main() {} }', capability: 'format', tool: 'dotnet', metadata: { 'App.csproj': '<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><TargetFramework>net10.0</TargetFramework></PropertyGroup></Project>', 'global.json': { sdk: { version: '10.0.302' } } }, good: '', bad: output('error WHITESPACE: Invalid indentation', 2) },
  { language: 'rust', file: 'src/lib.rs', source: 'pub fn answer() -> i32 { 42 }', capability: 'format', tool: 'rustfmt', metadata: { 'Cargo.toml': '[package]\nname="acceptance"\nversion="0.1.0"\nedition="2021"', 'rust-toolchain.toml': '[toolchain]\nchannel="1.85.0"' }, quality: { tools: { rustfmt: { version: '1.8.0' } } }, good: '', bad: output('Diff in src/lib.rs:1:\n-pub fn answer()->i32{42}', 1) },
  { language: 'go', file: 'main.go', source: 'package main\nfunc main() {}\n', capability: 'format', tool: 'gofmt', metadata: { 'go.mod': 'module example.test/acceptance\n\ngo 1.24.0\n' }, good: '', bad: output('main.go\n') },
  { language: 'typescript', file: 'src/main.ts', source: 'export const answer: number = 42;', capability: 'typecheck', tool: 'typescript', metadata: { 'package.json': { devDependencies: { typescript: '7.0.2' } }, 'tsconfig.json': { compilerOptions: { strict: true } } }, good: '', bad: output('src/main.ts(1,14): error TS2322: Type string is not assignable to number.', 2) },
  { language: 'javascript', file: 'src/main.js', source: 'export const answer = 42;', capability: 'lint', tool: 'oxlint', metadata: { 'package.json': { type: 'module' } }, good: '{"diagnostics":[],"number_of_files":1}', bad: output('{"diagnostics":[{"filename":"src/main.js","message":"Unexpected debugger statement","code":"eslint(no-debugger)","severity":"warning","labels":[{"span":{"line":1,"offset":0,"length":9}}]}],"number_of_files":1}', 1) },
  { language: 'css', file: 'main.css', source: 'a { color: red; }', capability: 'lint', tool: 'stylelint', metadata: { '.stylelintrc.json': { rules: { 'color-no-invalid-hex': true } } }, good: '[{"source":"main.css","warnings":[],"parseErrors":[],"invalidOptionWarnings":[],"errored":false}]', bad: output('[{"source":"main.css","warnings":[{"line":1,"rule":"color-no-invalid-hex","severity":"error","text":"Unexpected invalid hex color"}],"parseErrors":[],"invalidOptionWarnings":[],"errored":true}]', 2) },
  { language: 'html', file: 'index.html', source: '<!doctype html><html lang="en"><head><title>Acceptance</title></head><body></body></html>', capability: 'lint', tool: 'html-validate', metadata: { '.htmlvalidate.json': { extends: ['html-validate:recommended'] } }, good: '[]', bad: output('[{"filePath":"index.html","messages":[{"ruleId":"element-required-attributes","line":1,"severity":2,"message":"Image requires alt"}],"errorCount":1,"warningCount":0}]', 1) },
  { language: 'php', file: 'plugin.php', source: '<?php\n/* Plugin Name: Acceptance */\necho "hello";\n', capability: 'lint', tool: 'php', metadata: { 'composer.json': { require: { php: '8.4.21' } } }, good: 'No syntax errors detected in plugin.php', bad: output('Errors parsing plugin.php', 255, 'PHP Parse error: unexpected token') },
  { language: 'sql', file: 'schema.sql', source: 'SELECT 1;\n', capability: 'lint', tool: 'sqlfluff', metadata: {}, quality: { dialect: 'sqlite' }, good: '[{"filepath":"schema.sql","violations":[]}]', bad: output('[{"filepath":"schema.sql","violations":[{"code":"LT01","start_line_no":1,"description":"Unexpected whitespace"}]}]', 1) }
];

async function put(root, name, value) {
  const target = path.join(root, name); await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, typeof value === 'string' ? value : JSON.stringify(value));
}
async function fixture(t, spec = cases[4], quality = {}, extras = {}) {
  const base = await mkdtemp(path.join(os.tmpdir(), 'kodo-qacc-'));
  const project = path.join(base, 'project'), evidenceDir = path.join(base, 'evidence'), toolHome = path.join(base, 'tools');
  await mkdir(project); await mkdir(evidenceDir);
  t.after(async () => { assert.equal(path.dirname(base), path.resolve(os.tmpdir())); assert.match(path.basename(base), /^kodo-qacc-/); await rm(base, { recursive: true, force: true }); });
  for (const [name, value] of Object.entries({ ...spec.metadata, [spec.file]: spec.source, ...extras })) await put(project, name, value);
  await put(project, 'kodo.config.json', { schemaVersion: 1, quality: { ...spec.quality, ...quality } });
  for (const args of [['init', '-q', '--initial-branch=fixture'], ['add', '.'], ['-c', 'user.name=Acceptance', '-c', 'user.email=acceptance@localhost', '-c', 'commit.gpgSign=false', 'commit', '-qm', 'fixture']]) await execute('git', args, { cwd: project });
  return { base, project, evidenceDir, toolHome };
}
function ports(spec, { state = 'ready', bad = false, version, result, mutate } = {}) {
  const calls = [];
  const resolve = async id => ({ id, version: versions[id], ready: state === 'ready', status: state, command: `fixture-${id}`, args: [], env: {} });
  const nativeResolve = async id => { if (state !== 'ready') throw Object.assign(new Error('offline fixture unavailable'), { code: state }); return { command: `fixture-${id}`, args: [], env: {} }; };
  const runner = async (command, args, options) => {
    const id = command.replace(/^fixture-/, ''); calls.push({ id, args, options });
    assert.ok(!args.some(arg => ['--fix', '--write', 'install', 'restore', 'update'].includes(arg)), 'acceptance tools must remain read-only');
    if (args.includes('--version')) return output(version ?? banners[id]);
    if (id === 'go' && args[0] === 'version') return output(`${args[1]}: go1.24.0`);
    if (mutate) await mutate();
    return result ?? (bad ? spec.bad : output(spec.good));
  };
  return { resolve, nativeResolve, runner, calls };
}
function run(fx, spec, tools, extra = {}) { return runQuality({ ...fx, ...tools, changedPaths: [spec.file], capabilities: [spec.capability], ...extra }); }

for (const [index, spec] of cases.entries()) test(`QACC-${String(index + 1).padStart(2, '0')} ${spec.language} good bad missing unsupported public matrix`, async t => {
  const fx = await fixture(t, spec);
  const detected = await new QualityProfileRegistry().detect(fx.project);
  assert.ok(detected.languages.includes(spec.language));
  for (const scenario of ['good', 'bad', 'missing', 'unsupported']) await t.test(scenario, async () => {
    const tools = ports(spec, { state: ['missing', 'unsupported'].includes(scenario) ? scenario : 'ready', bad: scenario === 'bad' });
    const result = await run(fx, spec, tools);
    assert.equal(result.receipts.length, 1); const receipt = result.receipts[0];
    assert.equal(receipt.language, spec.language); assert.equal(receipt.capability, spec.capability);
    assert.equal(receipt.status, { good: 'passed', bad: 'failed', missing: 'missing', unsupported: 'unsupported' }[scenario], JSON.stringify(receipt));
    assert.equal(result.passed, scenario === 'good');
    assert.ok(receipt.durationMs >= 0); assert.match(receipt.headSha, /^[a-f0-9]{40,64}$/);
    for (const key of ['sourceHash', 'configHash', 'pinsHash']) assert.match(receipt[key], /^[a-f0-9]{64}$/);
    assert.equal(receipt.evidence.length, 1); const evidence = receipt.evidence[0];
    const bytes = await readFile(evidence.path); assert.equal(digest(bytes), evidence.sha256); assert.equal(bytes.length, evidence.bytes);
    assert.equal(JSON.parse(bytes).status, receipt.status);
    if (scenario === 'good') { assert.ok(tools.calls.length >= 2); assert.ok(receipt.actualVersion); }
    if (['missing', 'unsupported'].includes(scenario)) assert.equal(tools.calls.length, 0);
  });
});

test('QACC-10 registry and real managed resolver compose without installation', async t => {
  for (const spec of cases.filter(c => versions[c.tool])) {
    const fx = await fixture(t, spec);
    const plan = await new QualityProfileRegistry().plan(fx.project, { capabilities: [spec.capability], changedPaths: [spec.file] });
    assert.equal(plan.checks[0].tool, spec.tool); assert.equal(plan.checks[0].version, versions[spec.tool]);
    const never = async () => assert.fail('missing or unsupported managed tool must not execute');
    for (const platform of [process.platform, 'freebsd']) {
      const result = await runQuality({ ...fx, runner: never, platform, arch: process.arch, capabilities: [spec.capability] });
      assert.equal(result.receipts[0].status, platform === 'freebsd' ? 'unsupported' : 'missing'); assert.equal(result.passed, false);
    }
    assert.equal(existsSync(fx.toolHome), false, 'resolve must not silently install');
  }
});

test('QACC-11 installed fixture entrypoints compose through real managed resolver and subprocess', async t => {
  const fx = await fixture(t);
  // This replaces npm entirely. No package manager, download or network occurs.
  // Catalog data supplies installation identity, not an expected acceptance result.
  const ids = ['oxlint', 'oxfmt', 'typescript', 'stylelint', 'html-validate'];
  const fakeInstaller = async (command, args, options) => {
    if (command !== 'npm') { assert.equal(command, process.execPath); return execute(command, args, options); }
    assert.ok(args.includes('--ignore-scripts')); assert.ok(!args.includes('--global'));
    const pkg = JSON.parse(await readFile(path.join(options.cwd, 'package.json'), 'utf8'));
    const id = Object.keys(pkg.dependencies)[0], pin = toolCatalog.find(row => row.id === id);
    if (args.includes('--package-lock-only')) await put(options.cwd, 'package-lock.json', { lockfileVersion: 3, packages: { '': pkg, [`node_modules/${id}`]: { version: pin.version, integrity: pin.integrity, resolved: `https://registry.npmjs.org/${id}/-/${id}-${pin.version}.tgz` } } });
    else {
      const root = path.join(options.cwd, 'node_modules', id);
      await put(root, 'package.json', { name: id, version: pin.version, bin: { [pin.binName]: pin.entry } });
      const clean = { oxlint: '{"diagnostics":[],"number_of_files":1}', oxfmt: 'Checking formatting...\nAll matched files use the correct format.\nFinished in 1ms on 1 files using 1 threads.', typescript: '', stylelint: '[{"source":"main.css","warnings":[],"parseErrors":[],"invalidOptionWarnings":[],"errored":false}]', 'html-validate': '[]' }[id];
      await put(root, pin.entry, `process.stdout.write(process.argv.includes('--version') ? ${JSON.stringify(banners[id])} : ${JSON.stringify(clean)});`);
    }
    return output();
  };
  const installed = await installTools(ids, { home: fx.toolHome, project: fx.project, runner: fakeInstaller });
  assert.ok(installed.every(row => row.ready), JSON.stringify(installed));
  for (const id of ids) {
    const spec = id === 'oxfmt' ? { ...cases[4], capability: 'format' } : cases.find(row => row.tool === id);
    const target = await fixture(t, spec);
    const result = await runQuality({ ...target, toolHome: fx.toolHome, capabilities: [spec.capability], changedPaths: [spec.file] });
    assert.equal(result.status, 'passed', `${id}: ${JSON.stringify(result.receipts)}`);
    assert.equal(result.receipts[0].actualVersion, versions[id]);
    assert.equal(await isCurrentQualityReceipt(result, { project: target.project, toolHome: fx.toolHome }), true);
  }
  await writeFile(installed[0].args[0], 'throw new Error("tampered fixture");');
  const tampered = await runQuality({ ...fx, capabilities: ['lint'] });
  assert.equal(tampered.passed, false); assert.equal(tampered.receipts[0].reason, 'tool_integrity');
  assert.equal((await resolveTool('oxlint', { home: fx.toolHome, project: fx.project })).ready, false);
});

test('QACC-12 exact pins complete versions and complete outputs are mandatory', async t => {
  const cs = await fixture(t, cases[0]); await put(cs.project, 'global.json', { sdk: { version: 'latest' } });
  const missing = await run(cs, cases[0], ports(cases[0])); assert.equal(missing.receipts[0].status, 'missing'); assert.equal(missing.passed, false);
  const fx = await fixture(t), spec = cases[4];
  for (const version of ['', 'Version: 1.91', 'Version: 1.91.0-beta', 'Expected 1.91.0; installed 9.9.9']) {
    const result = await run(fx, spec, ports(spec, { version })); assert.equal(result.receipts[0].reason, 'version_mismatch'); assert.equal(result.passed, false);
  }
  for (const result of [{ code: 0 }, output('{}'), output('{"diagnostics":[]}'), output('{"diagnostics":[],"number_of_files":0}'), output('{"diagnostics":[],"number_of_files":1}', 2), { ...output(spec.good), outputTruncated: true }]) {
    assert.equal((await run(fx, spec, ports(spec, { result }))).passed, false, JSON.stringify(result));
  }
});

test('QACC-13 quick scope manifest mismatches and filesystem escapes fail closed', async t => {
  const spec = cases[4], fx = await fixture(t, spec, {}, { 'src/affected.js': 'export const dependency = 1;', 'src/unrelated.js': 'export const other = 1;' });
  const plan = await new QualityProfileRegistry().plan(fx.project, { changedPaths: [spec.file], affectedPaths: ['src/affected.js'], capabilities: ['lint'] });
  assert.deepEqual(plan.checks[0].files, ['src/affected.js', spec.file]);
  for (const file of ['../escape.js', '--fix.js', 'src/missing.js', '.env', 'src/*.js']) await assert.rejects(() => new QualityProfileRegistry().plan(fx.project, { changedPaths: [file], capabilities: ['lint'] }));
  const empty = await run(fx, spec, ports(spec), { changedPaths: [] }); assert.equal(empty.passed, null); assert.equal(empty.receipts[0].status, 'skipped');
  await put(fx.project, 'package.json', { name: 'acceptance', version: '1.0.0', dependencies: { react: '19.0.0' } });
  await put(fx.project, 'package-lock.json', { name: 'different-project', lockfileVersion: 3, packages: { '': { name: 'different-project', dependencies: {} } } });
  await assert.rejects(() => new QualityProfileRegistry().detect(fx.project));
  const linked = await fixture(t); await put(linked.base, 'external/main.js', 'export const external = 1;');
  await symlink(path.join(linked.base, 'external'), path.join(linked.project, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(() => new QualityProfileRegistry().detect(linked.project));
});

test('QACC-14 real source mutation blocks clean output and invalidates receipts', async t => {
  const spec = cases[4], fx = await fixture(t);
  const tools = ports(spec); const clean = await run(fx, spec, tools);
  assert.equal(clean.passed, true); assert.equal(await isCurrentQualityReceipt(clean, { project: fx.project, resolve: tools.resolve }), true);
  await writeFile(clean.receipts[0].evidence[0].path, '{}');
  assert.equal(await isCurrentQualityReceipt(clean, { project: fx.project, resolve: tools.resolve }), false);
  const mutated = await run(fx, spec, ports(spec, { mutate: () => put(fx.project, spec.file, 'export const changed = 7;') }));
  assert.equal(mutated.passed, false); assert.equal(mutated.receipts[0].reason, 'source_mutation');
  assert.equal(await readFile(path.join(fx.project, spec.file), 'utf8'), 'export const changed = 7;', 'mutation evidence must not be hidden by rollback');
});

test('QACC-15 old debt cannot hide changed new duplicate or worsened violations', async t => {
  const spec = cases[4], fx = await fixture(t, spec, { strictness: 'adopt' }, { 'src/other.js': 'export const other = 1;' });
  const bad = ports(spec, { bad: true });
  // Coverage is two files in standard mode; the one old diagnostic is unchanged.
  const badRunner = async (...args) => { const result = await bad.runner(...args); return result.stdout.includes('number_of_files') ? { ...result, stdout: result.stdout.replace('"number_of_files":1', '"number_of_files":2') } : result; };
  const options = { mode: 'standard', changedPaths: ['src/other.js'], runner: badRunner };
  const first = await run(fx, spec, bad, options); assert.equal(first.status, 'failed');
  const finding = first.receipts[0].findings[0]; assert.ok(finding);
  const baseline = [{ ...finding, language: 'javascript', capability: 'lint', tool: 'oxlint', sourceHash: first.plan.files.find(row => row.path === spec.file).sha256 }];
  await put(fx.project, 'kodo.config.json', { quality: { strictness: 'adopt', baseline } });
  const old = await run(fx, spec, bad, options); assert.equal(old.status, 'passed'); assert.equal(old.receipts[0].debtCount, 1);
  const changed = await run(fx, spec, bad, { ...options, changedPaths: [spec.file] }); assert.equal(changed.status, 'failed'); assert.equal(changed.receipts[0].debtCount, 0);
  const duplicateRunner = async (...args) => { const result = await badRunner(...args); if (!result.stdout.includes('number_of_files')) return result; const doc = JSON.parse(result.stdout); doc.diagnostics.push(doc.diagnostics[0]); return output(JSON.stringify(doc), 1); };
  assert.equal((await run(fx, spec, bad, { ...options, runner: duplicateRunner })).status, 'failed');
  const worseRunner = async (...args) => { const result = await badRunner(...args); return { ...result, stdout: result.stdout.replace('"severity":"warning"', '"severity":"error"') }; };
  assert.equal((await run(fx, spec, bad, { ...options, runner: worseRunner })).status, 'failed');
  await put(fx.project, spec.file, 'debugger; // newly edited');
  const newDebt = await run(fx, spec, bad, options); assert.equal(newDebt.status, 'failed'); assert.ok(newDebt.plan.actualChangedPaths.includes(spec.file));
});

test('QACC-16 distinct capabilities and SQL reuse never manufacture test security or release proof', async t => {
  const spec = cases[8], fx = await fixture(t, spec), tools = ports(spec);
  const result = await run(fx, spec, tools, { capabilities: ['format', 'lint', 'typecheck', 'test', 'security', 'architecture', 'release'] });
  assert.equal(result.receipts.length, 7); assert.equal(new Set(result.receipts.map(row => row.evidence[0].path)).size, 7);
  assert.deepEqual(result.receipts.map(row => row.status), ['passed', 'passed', 'not_applicable', 'skipped', 'skipped', 'skipped', 'skipped']);
  assert.deepEqual(result.receipts[1].reusedFrom, [result.receipts[0].id]);
  assert.equal(tools.calls.filter(row => row.args[0] === 'lint').length, 1);
  const neutral = await run(fx, spec, tools, { capabilities: ['security', 'release'] }); assert.equal(neutral.passed, null);
  await put(fx.project, 'kodo.config.json', { quality: {} });
  const missingDialect = await run(fx, spec, tools); assert.equal(missingDialect.passed, false); assert.equal(missingDialect.receipts[0].reason, 'sql_dialect_required');
  await put(fx.project, 'kodo.config.json', { quality: { dialect: 'unsupported_dialect' } });
  assert.equal((await run(fx, spec, tools)).receipts[0].status, 'unsupported');
});

test('QACC-17 CLI JSON and legacy commands work without provider or runtime startup', async t => {
  const fx = await fixture(t, cases[3]); const emptyPath = path.join(fx.base, 'empty-path'); await mkdir(emptyPath);
  const state = path.join(fx.base, 'no-state'), credentials = path.join(fx.base, 'no-credentials');
  const env = { PATH: emptyPath, SystemRoot: process.env.SystemRoot, KODO_HOME: state, KODO_CREDENTIAL_HOME: credentials, KODO_TOOL_HOME: fx.toolHome, NODE_NO_WARNINGS: '1' };
  for (const action of ['detect', 'plan', 'run']) {
    const args = [cli, 'quality', action, '--project', fx.project, '--json', ...(action === 'detect' ? [] : ['--capability', 'typecheck']), ...(action === 'run' ? ['--evidence-dir', fx.evidenceDir] : [])];
    const result = await execute(process.execPath, args, { env, allowFailure: true }); const doc = JSON.parse(result.stdout);
    assert.equal(result.stderr, ''); assert.ok((doc.languages ?? doc.plan.languages).includes('typescript'));
    assert.equal(result.code, action === 'run' ? 1 : 0); if (action === 'run') assert.equal(doc.passed, false);
  }
  for (const args of [['quality', 'run', '--fix', '--json'], ['quality', 'plan', '--mode', 'invalid', '--json']]) {
    const result = await execute(process.execPath, [cli, ...args], { env, allowFailure: true }); assert.equal(result.code, 1); assert.equal(JSON.parse(result.stdout).status, 'blocked');
  }
  for (const args of [['--help'], ['list', '--json'], ['tools', 'list', '--json']]) {
    const result = await execute(process.execPath, [cli, ...args], { env, allowFailure: true }); assert.equal(result.code, 0, result.stderr);
    if (args[0] === '--help') assert.match(result.stdout, /quality/); else assert.ok(JSON.parse(result.stdout));
  }
  assert.equal(existsSync(state), false); assert.equal(existsSync(credentials), false); assert.equal(existsSync(fx.toolHome), false);
});

test('QACC-18 detected framework evidence comes from manifests and source', async t => {
  const fx = await fixture(t, cases[3], {}, { 'package.json': { dependencies: { react: '19.0.0', next: '16.0.0', astro: '5.0.0' } }, 'plugin.php': '<?php\n/* Plugin Name: Acceptance */\nadd_action("init", "acceptance_init");' });
  const detection = await new QualityProfileRegistry().detect(fx.project);
  for (const framework of ['react', 'next', 'astro', 'wordpress']) assert.ok(detection.frameworks.includes(framework), framework);
  const falseLabel = await fixture(t, cases[4], {}, { 'next-react-astro-wordpress/readme.txt': 'folder names do not enable frameworks' });
  assert.deepEqual((await new QualityProfileRegistry().detect(falseLabel.project)).frameworks, []);
});

test('QACC-19 gofmt version observation must identify the checked executable', async t => {
  const spec = cases[2], fx = await fixture(t, spec), tools = ports(spec);
  for (const [name, stdout] of [['unrelated executable', 'unrelated-tool: go1.24.0'], ['multiline corruption', 'corrupt version output\nfixture-gofmt: go1.24.0']]) await t.test(name, async () => {
    const runner = (command, args, options) => command === 'fixture-go' && args[0] === 'version' ? output(stdout) : tools.runner(command, args, options);
    const result = await run(fx, spec, tools, { runner });
    assert.equal(result.passed, false, `version output must bind to the requested binary: ${JSON.stringify(stdout)}`);
    assert.equal(result.receipts[0].reason, 'version_mismatch');
  });
});

test('QACC-20 dotnet warning summary cannot become a clean typecheck', async t => {
  const spec = cases[0], fx = await fixture(t, spec);
  const result = await run(fx, spec, ports(spec, { result: output('Build succeeded.\n    1 Warning(s)\n    0 Error(s)\n') }), { capabilities: ['typecheck'] });
  assert.equal(result.passed, false, 'nonzero warnings summary is not a complete clean build');
  assert.notEqual(result.receipts[0].status, 'passed');
});

test('QACC-21 HTML validator source text is not a diagnostic file path', async t => {
  const spec = cases[6], fx = await fixture(t, spec);
  // HTML-Validate's observed JSON includes BOTH filePath and source HTML.
  // The latter is raw content, not a filesystem selector or public finding.
  const source = '<html><body><img src="RAW_HTML_ACCEPTANCE_MARKER"></body></html>\n';
  const doc = [{ filePath: path.join(fx.project, spec.file), source, messages: [{ ruleId: 'wcag/h37', severity: 2, line: 1, message: 'Image requires alt' }], errorCount: 1, warningCount: 0 }];
  const result = await run(fx, spec, ports(spec, { result: output(JSON.stringify(doc), 1) }));
  assert.equal(result.status, 'failed', 'a real validator violation must be parsed, not blocked as an unsafe source path');
  assert.equal(result.receipts[0].reason, 'violations');
  assert.equal(result.receipts[0].findings[0].file, spec.file);
  assert.equal(result.receipts[0].findings[0].ruleId, 'wcag/h37');
  assert.ok(!JSON.stringify(result.receipts).includes('RAW_HTML_ACCEPTANCE_MARKER'));
  doc[0].filePath = path.join(fx.base, 'outside.html');
  const outside = await run(fx, spec, ports(spec, { result: output(JSON.stringify(doc), 1) }));
  assert.equal(outside.passed, false); assert.equal(outside.receipts[0].status, 'blocked');
});
