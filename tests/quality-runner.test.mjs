import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { fixture, put, projects, pins, fakeTools, toolRunner, windowsShortPath, vendoredGo } from './fixtures/quality/helpers.mjs';
const api = () => import('../runtime/quality-runner.mjs');

test('Quality Go seals workspace and persistent environment for build and vet', async t => {
  const { runQuality } = await api();
  for (const [label, files, mod] of [['standalone', projects.go, 'readonly'], ['vendor', vendoredGo, 'vendor']]) {
    const fx = await fixture(t, files), fake = toolRunner();
    const nativeResolve = async id => ({ command: id, args: [], env: { GOENV: '/outside/env', GOWORK: '/outside/go.work', GOFLAGS: '-overlay=/outside/overlay.json', GOPROXY: 'https://outside.invalid', goenv: '/outside/env', gowork: '/outside/go.work', goflags: '-modfile=/outside/go.mod' } });
    const result = await runQuality({ ...fx, nativeResolve, runner: fake.runner, capabilities: ['lint', 'typecheck'] });
    assert.equal(result.status, 'passed', label);
    for (const { options } of fake.calls) {
      assert.equal(options.env.GOWORK, 'off'); assert.equal(options.env.GOENV, 'off');
      assert.equal(options.env.GOFLAGS, `-mod=${mod}`); assert.equal(options.env.GOPROXY, 'off');
      assert.equal(options.env.GOTOOLCHAIN, 'local');
      assert.equal(options.env.goenv, undefined); assert.equal(options.env.gowork, undefined); assert.equal(options.env.goflags, undefined);
      assert.ok(options.env.GOMODCACHE.startsWith(result.evidenceRoot));
    }
    assert.ok(fake.calls.some(c => c.args[0] === 'vet')); assert.ok(fake.calls.some(c => c.args[0] === 'build'));
  }
});

test('Quality Go vendor mutations invalidate receipts and activate owning quick checks', async t => {
  const { runQuality, isCurrentQualityReceipt } = await api();
  const fx = await fixture(t, vendoredGo), fake = toolRunner();
  const options = { ...fx, runner: fake.runner, capabilities: ['typecheck'] };
  const first = await runQuality(options);
  assert.equal(first.passed, true); assert.equal(await isCurrentQualityReceipt(first, options), true);
  await put(fx.project, 'vendor/example.test/dependency/value.go', 'package dependency\nvar Value int = "bad"\n');
  assert.equal(await isCurrentQualityReceipt(first, options), false);
  const quick = await runQuality({ ...options, changedPaths: ['vendor/example.test/dependency/value.go'], mode: 'quick' });
  assert.equal(quick.receipts[0].status, 'passed');
  assert.match(quick.receipts[0].scopeReason, /vendor/);
  assert.ok(fake.calls.filter(c => c.args[0] === 'build').length >= 2, 'quick executes the compiler again');
  assert.deepEqual(quick.receipts[0].files, ['main.go']);
  const hashes = new Map(first.plan.files.map(f => [f.path, f.sha256]));
  assert.ok(hashes.has('vendor/modules.txt')); assert.ok(hashes.has('vendor/example.test/dependency/value.go'));
});

test('Quality Go exact version and shared deadline remain fail closed', async t => {
  const { runQuality } = await api();
  const fx = await fixture(t, projects.go);
  const mismatch = toolRunner({ go: () => ({ code: 0, stdout: 'go version go1.24.1 windows/amd64', stderr: '' }) });
  const wrong = await runQuality({ ...fx, runner: mismatch.runner, capabilities: ['typecheck'] });
  assert.equal(wrong.status, 'blocked'); assert.equal(wrong.receipts[0].reason, 'version_mismatch');
  assert.equal(mismatch.calls.some(call => call.args[0] === 'build'), false);
  const expired = toolRunner({ go: async ({ args }) => {
    assert.equal(args[0], 'version', 'expired version budget must prevent build');
    await new Promise(resolve => setTimeout(resolve, 1100));
    return { code: 0, stdout: 'go version go1.24.0 windows/amd64', stderr: '' };
  } });
  const deadline = await runQuality({ ...fx, runner: expired.runner, capabilities: ['typecheck'], timeoutMs: 1000 });
  assert.equal(deadline.status, 'blocked'); assert.equal(deadline.receipts[0].reason, 'timeout');
  assert.equal(expired.calls.length, 1);
});

test('Quality native Go ignores parent workspace and never certifies sibling dependency bytes', { skip: !process.env.KODO_QUALITY_GO_BINARY }, async t => {
  const { runQuality, isCurrentQualityReceipt } = await api();
  const binary = process.env.KODO_QUALITY_GO_BINARY;
  const nativeResolve = async () => ({ command: binary, args: [], env: {} });
  await t.test('sibling dependency is not a standalone PASS', async t => {
    const fx = await fixture(t, { ...projects.go, 'main.go': 'package main\nimport "example.test/sibling"\nvar value int = sibling.Value\nfunc main() {}\n' });
    await put(fx.base, 'go.work', 'go 1.24.0\nuse (\n ./project\n ./sibling\n)\n');
    await put(fx.base, 'sibling/go.mod', 'module example.test/sibling\n\ngo 1.24.0\n');
    await put(fx.base, 'sibling/value.go', 'package sibling\nconst Value = 42\n');
    const options = { ...fx, nativeResolve, capabilities: ['typecheck'] };
    const first = await runQuality(options);
    await put(fx.base, 'sibling/value.go', 'package sibling\nconst Value = "bad"\n');
    const current = await isCurrentQualityReceipt(first, options);
    await captureGoProbe('parent-workspace-sibling', first, { currentAfterSiblingMutation: current });
    assert.equal(first.passed, false, 'untracked workspace dependency must never receive PASS');
    assert.equal(current, false, 'a successful receipt cannot survive a dependency mutation');
  });
  await t.test('valid stdlib module ignores unrelated parent workspace', async t => {
    const fx = await fixture(t, { ...projects.go, 'main.go': 'package main\nimport "fmt"\nfunc main() { fmt.Println("ok") }\n' });
    await put(fx.base, 'go.work', 'go 1.24.0\nuse ./sibling\n');
    await put(fx.base, 'sibling/go.mod', 'module example.test/sibling\n\ngo 1.24.0\n');
    await put(fx.base, 'sibling/value.go', 'package sibling\nconst Value = 42\n');
    const result = await runQuality({ ...fx, nativeResolve, capabilities: ['typecheck'] });
    await captureGoProbe('parent-workspace-stdlib', result);
    assert.equal(result.passed, true, JSON.stringify(result.receipts));
  });
});

test('Quality native Go prepared vendor works offline and tracks dependency errors and quick scope', { skip: !process.env.KODO_QUALITY_GO_BINARY }, async t => {
  const { runQuality, isCurrentQualityReceipt } = await api();
  const fx = await fixture(t, vendoredGo);
  const nativeResolve = async () => ({ command: process.env.KODO_QUALITY_GO_BINARY, args: [], env: {} });
  const options = { ...fx, nativeResolve, capabilities: ['typecheck'] };
  const { execute } = await import('../runtime/delivery.mjs');
  const command = process.env.KODO_QUALITY_GO_BINARY, args = ['build', '-o', path.join(fx.base, 'ordinary-build.exe'), './...'];
  const env = { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, HOME: fx.base, USERPROFILE: fx.base, TEMP: fx.base, TMP: fx.base,
    GOENV: 'off', GOWORK: 'off', GOTOOLCHAIN: 'local', GOPROXY: 'off', GOSUMDB: 'off', GOFLAGS: '', GOCACHE: path.join(fx.base, 'ordinary-cache'), GOMODCACHE: path.join(fx.base, 'empty-mod-cache') };
  const ordinary = await execute(command, args, { cwd: fx.project, env, timeoutMs: 120000, allowFailure: true });
  assert.equal(ordinary.code, 0, 'prepared fixture also builds with ordinary offline Go defaults');
  const good = await runQuality(options);
  await captureGoProbe('vendor-valid', good, { ordinaryOfflineBuild: { command, args, env, ...ordinary } });
  assert.equal(good.passed, true, JSON.stringify(good.receipts));
  assert.equal(await isCurrentQualityReceipt(good, options), true);
  await put(fx.project, 'vendor/example.test/dependency/value.go', 'package dependency\nvar Value int = "bad"\n');
  assert.equal(await isCurrentQualityReceipt(good, options), false);
  const bad = await runQuality(options);
  await captureGoProbe('vendor-bad-type', bad);
  assert.equal(bad.status, 'failed', JSON.stringify(bad.receipts));
  const quick = await runQuality({ ...options, mode: 'quick', changedPaths: ['vendor/example.test/dependency/value.go'] });
  await captureGoProbe('vendor-quick-bad-type', quick);
  assert.equal(quick.status, 'failed', JSON.stringify(quick.receipts));
  assert.deepEqual(quick.receipts[0].files, ['main.go']);
});

async function captureGoProbe(name, report, observations = {}) {
  if (!process.env.KODO_QUALITY_GO_PROBE_EVIDENCE) return;
  const { cp, mkdir } = await import('node:fs/promises');
  const target = path.join(process.env.KODO_QUALITY_GO_PROBE_EVIDENCE, name);
  await mkdir(target, { recursive: true });
  await put(target, 'report.json', { ...report, observations });
  await mkdir(path.join(target, 'raw'), { recursive: true });
  for (const receipt of report.receipts) for (const item of receipt.evidence) await cp(item.path, path.join(target, 'raw', path.basename(item.path)));
}

test('Quality TypeScript checks every receipt root despite files exclude and noCheck', async t => {
  const { runQuality } = await api();
  for (const scope of [{ files: ['src/main.ts'] }, { exclude: ['src/bad.ts'] }, { compilerOptions: { noCheck: true } }]) {
    const fx = await fixture(t, { ...projects.typescript, 'tsconfig.json': scope, 'src/bad.ts': 'export const bad: number = "wrong";' });
    const fake = toolRunner({ typescript: async ({ args, options }) => {
      if (args.includes('--version')) return { code: 0, stdout: 'Version 7.0.2', stderr: '' };
      const config = JSON.parse(await readFile(path.resolve(options.cwd, args[args.indexOf('--project') + 1]), 'utf8'));
      const roots = (config.files ?? ['src/main.ts', 'src/bad.ts']).map(file => path.resolve(options.cwd, file));
      const covered = roots.includes(path.join(await realpath(fx.project), 'src/bad.ts')) && !config.exclude?.includes('src/bad.ts') && !config.compilerOptions?.noCheck;
      return { code: covered ? 2 : 0, stdout: covered ? 'src/bad.ts(1,14): error TS2322: Type string is not assignable to number.' : '', stderr: '' };
    } });
    const result = await runQuality({ ...fx, resolve: fakeTools(), runner: fake.runner, mode: 'quick', changedPaths: ['src/bad.ts'], capabilities: ['typecheck'] });
    assert.equal(result.status, 'failed', JSON.stringify(scope));
    assert.deepEqual(result.receipts[0].files, ['src/bad.ts', 'src/main.ts']);
    assert.equal(fake.calls.filter(call => !call.args.includes('--version')).length, 1, 'one compiler check, no extra probe');
  }
});

test('Quality TypeScript private config binds exact roots options and tamper-sensitive receipts', async t => {
  const { runQuality, isCurrentQualityReceipt } = await api();
  const fx = await fixture(t, { ...projects.typescript, 'tsconfig.json': { extends: './config/base.json', files: ['src/main.ts'] }, 'config/base.json': { compilerOptions: { target: 'es2022', module: 'esnext', paths: { '@/*': ['../src/*'] }, jsx: 'preserve', noCheck: true } }, 'src/other.ts': 'export const other = 1;' });
  const fake = toolRunner(), resolve = fakeTools();
  const result = await runQuality({ ...fx, resolve, runner: fake.runner, capabilities: ['typecheck'] });
  assert.equal(result.status, 'passed');
  const checkCall = fake.calls.find(call => call.args.includes('--project'));
  const configPath = checkCall.args[checkCall.args.indexOf('--project') + 1];
  assert.equal(path.dirname(configPath), result.evidenceRoot);
  const config = JSON.parse(await readFile(configPath, 'utf8'));
  assert.equal(config.extends, path.join(await realpath(fx.project), 'tsconfig.json'));
  assert.deepEqual(config.files, result.receipts[0].files.map(file => path.join(result.plan.project, file)));
  assert.deepEqual(config.include, []); assert.deepEqual(config.exclude, []);
  assert.equal(config.compilerOptions.noEmit, true); assert.equal(config.compilerOptions.noCheck, false);
  assert.equal(config.compilerOptions.noResolve, true);
  assert.deepEqual(config.compilerOptions.types, []); assert.deepEqual(config.compilerOptions.typeRoots, []);
  assert.equal(config.compilerOptions.skipLibCheck, false); assert.equal(config.compilerOptions.skipDefaultLibCheck, false);
  assert.equal(config.compilerOptions.incremental, false); assert.equal(config.compilerOptions.composite, false);
  assert.equal(await isCurrentQualityReceipt(result, { resolve, runner: fake.runner }), true);
  const original = await readFile(configPath, 'utf8');
  await chmod(configPath, 0o600);
  await put(path.dirname(configPath), path.basename(configPath), { ...config, files: [] });
  assert.equal(await isCurrentQualityReceipt(result, { resolve, runner: fake.runner }), false);
  await put(path.dirname(configPath), path.basename(configPath), original);
  await put(fx.project, 'config/base.json', { compilerOptions: { target: 'es5' } });
  assert.equal(await isCurrentQualityReceipt(result, { resolve, runner: fake.runner }), false);
});

test('Quality TypeScript generated config mutation during compiler execution blocks PASS', async t => {
  const { runQuality } = await api(), fx = await fixture(t, projects.typescript);
  const fake = toolRunner({ typescript: async ({ args, options }) => {
    if (args.includes('--version')) return { code: 0, stdout: 'Version 7.0.2', stderr: '' };
    const filename = path.resolve(options.cwd, args[args.indexOf('--project') + 1]);
    if (path.dirname(filename) !== await realpath(fx.project)) { await chmod(filename, 0o600); await put(path.dirname(filename), path.basename(filename), {}); }
    return { code: 0, stdout: '', stderr: '' };
  } });
  const result = await runQuality({ ...fx, resolve: fakeTools(), runner: fake.runner, capabilities: ['typecheck'] });
  assert.equal(result.status, 'blocked'); assert.equal(result.receipts[0].reason, 'typecheck_config_integrity');
});

test('Quality TypeScript unsupported project references never execute or receive PASS', async t => {
  const { runQuality } = await api();
  const fx = await fixture(t, { ...projects.typescript, 'tsconfig.json': { files: ['src/main.ts'], references: [{ path: './lib' }] }, 'lib/tsconfig.json': { compilerOptions: { composite: true } }, 'lib/bad.ts': 'export const bad: number = "wrong";' });
  const fake = toolRunner();
  const result = await runQuality({ ...fx, resolve: async () => assert.fail('unsupported graph must not resolve a tool'), runner: fake.runner, changedPaths: ['lib/bad.ts'], capabilities: ['typecheck'] });
  assert.equal(result.passed, false); assert.equal(result.receipts[0].status, 'blocked');
  assert.equal(result.receipts[0].reason, 'typescript_project_references_unsupported');
  assert.ok(result.receipts[0].files.includes('lib/bad.ts')); assert.equal(fake.calls.length, 0);
});

test('Quality Windows short names inside the root map only to inventoried diagnostic files', { skip: process.platform !== 'win32' }, async t => {
  const { parseQualityOutput } = await api();
  const file = 'src/long directory name for diagnostics/index.html';
  const fx = await fixture(t, { [file]: '<img src="x">' }), project = await realpath(fx.project);
  const shortRoot = await windowsShortPath(fx.project), shortDirectory = await windowsShortPath(path.dirname(path.join(fx.project, file)));
  const alias = path.join(project, path.relative(shortRoot, shortDirectory), 'index.html');
  if (alias === path.join(project, file)) { t.skip('8.3 names unavailable for this owned directory'); return; }
  const record = { filePath: alias, source: '<img src="x">', errorCount: 1, warningCount: 0, messages: [{ ruleId: 'wcag/h37', line: 1, severity: 2, message: 'Image requires alt' }] };
  const check = { tool: 'html-validate', root: '', files: [file], capability: 'lint' };
  const parsed = parseQualityOutput(check, { code: 1, stdout: JSON.stringify([record]), stderr: '' }, project);
  assert.equal(parsed.clean, false); assert.equal(parsed.findings[0].file, file);
  record.filePath = path.join(fx.base, 'outside.html');
  await put(fx.base, 'outside.html', '<img src="x">');
  assert.throws(() => parseQualityOutput(check, { code: 1, stdout: JSON.stringify([record]), stderr: '' }, project));
});

test('Quality Windows aliases keep evidence outside the canonical project', { skip: process.platform !== 'win32' }, async t => {
  const { runQuality } = await api(), fx = await fixture(t, projects.javascript);
  const alias = await windowsShortPath(fx.project);
  for (const project of [fx.project, alias]) {
    await assert.rejects(() => runQuality({ ...fx, project, evidenceDir: path.join(project, 'private-evidence'), resolve: fakeTools(), runner: toolRunner().runner, capabilities: ['lint'] }), /outside the project/);
  }
});

test('Quality Windows aliases map absolute diagnostics only inside the inventoried root', { skip: process.platform !== 'win32' }, async t => {
  const { runQuality } = await api(), fx = await fixture(t, projects.html);
  const alias = await windowsShortPath(fx.project);
  const reported = path.join(alias, 'index.html');
  const fake = toolRunner({ 'html-validate': ({ args }) => args.includes('--version')
    ? { code: 0, stdout: '11.18.0', stderr: '' }
    : { code: 1, stdout: JSON.stringify([{ filePath: reported, messages: [{ ruleId: 'wcag/h37', severity: 2, line: 1, message: 'Image requires alt' }], errorCount: 1, warningCount: 0 }]), stderr: '' } });
  const result = await runQuality({ ...fx, runner: fake.runner, resolve: fakeTools(), capabilities: ['lint'] });
  assert.equal(result.status, 'failed'); assert.equal(result.receipts[0].findings[0].file, 'index.html');
  const { parseQualityOutput } = await api();
  const check = { tool: 'html-validate', files: ['index.html'], root: '' };
  const response = filePath => ({ code: 0, stdout: JSON.stringify([{ filePath, messages: [], errorCount: 0, warningCount: 0 }]), stderr: '' });
  assert.throws(() => parseQualityOutput(check, response(path.join(fx.evidenceDir, 'outside.html')), result.plan.project), /malformed/);
  const { symlink } = await import('node:fs/promises');
  const linked = path.join(fx.evidenceDir, 'linked-project');
  await symlink(fx.project, linked, 'junction');
  assert.throws(() => parseQualityOutput(check, response(path.join(linked, 'index.html')), result.plan.project), /malformed/);
});

test('Quality Windows receipt containment rejects relocated evidence through aliases', { skip: process.platform !== 'win32' }, async t => {
  const { runQuality, isCurrentQualityReceipt } = await api(), fx = await fixture(t, projects.javascript);
  const resolve = fakeTools(), runner = toolRunner().runner;
  const result = await runQuality({ ...fx, resolve, runner, capabilities: ['lint'] });
  assert.equal(await isCurrentQualityReceipt(result, { resolve, runner }), true);
  const { cp } = await import('node:fs/promises');
  const target = path.join(fx.project, '.kodo', 'relocated-evidence');
  await cp(result.evidenceRoot, target, { recursive: true });
  const alias = await windowsShortPath(target), relocated = structuredClone(result);
  relocated.evidenceRoot = alias;
  for (const row of relocated.receipts) for (const item of row.evidence) item.path = path.join(alias, path.basename(item.path));
  assert.equal(await isCurrentQualityReceipt(relocated, { resolve, runner }), false);
});

test('Quality quick config changes cannot hide failing TypeScript behind passing JavaScript', async t => {
  const { runQuality } = await api();
  const fx = await fixture(t, { ...projects.typescript, 'src/main.ts': 'export const value: number = "bad";', 'src/main.js': 'export const ok = 1;' });
  const fake = toolRunner({ typescript: ({ args }) => args.includes('--version')
    ? { code: 0, stdout: 'Version 7.0.2', stderr: '' }
    : { code: 2, stdout: 'src/main.ts(1,14): error TS2322: Type string is not assignable to type number.', stderr: '' } });
  const result = await runQuality({ ...fx, project: await realpath(fx.project), runner: fake.runner, resolve: fakeTools(), mode: 'quick', changedPaths: ['tsconfig.json', 'src/main.js'], capabilities: ['lint', 'typecheck'] });
  assert.equal(result.status, 'failed');
  assert.equal(result.receipts.find(c => c.id === 'typescript:.:typecheck').status, 'failed');
  assert.equal(result.receipts.find(c => c.id === 'javascript:.:lint').status, 'passed');
  assert.ok(fake.calls.some(c => c.id === 'typescript' && c.args.includes('--project')));
  assert.match(result.receipts.find(c => c.id === 'typescript:.:typecheck').scopeReason, /config|metadata/);
});

test('Quality runner gives nine languages independent verified capability receipts', async t => {
  const { runQuality } = await api();
  for (const [language, files] of Object.entries(projects)) {
    const fx = await fixture(t, files, { tools: pins, dialect: 'postgres' });
    const { runner } = toolRunner();
    const result = await runQuality({ ...fx, runner, resolve: fakeTools(), capabilities: [language === 'php' ? 'lint' : 'format'] });
    assert.equal(result.status, 'passed', `${language}: ${JSON.stringify(result.receipts)}`);
    const receipt = result.receipts.find(r => r.language === language && r.status === 'passed');
    assert.ok(receipt, language); assert.ok(receipt.durationMs >= 0); assert.match(receipt.headSha, /^[a-f0-9]{40,64}$/);
    assert.match(receipt.configHash, /^[a-f0-9]{64}$/); assert.match(receipt.sourceHash, /^[a-f0-9]{64}$/); assert.match(receipt.pinsHash, /^[a-f0-9]{64}$/);
    assert.equal(receipt.evidence.length, 1); assert.match(receipt.evidence[0].sha256, /^[a-f0-9]{64}$/);
    assert.equal(JSON.parse(await readFile(receipt.evidence[0].path, 'utf8')).status, 'passed');
  }
});
test('Quality runner never passes missing unsupported or mismatched tools', async t => {
  const { runQuality } = await api(); const fx = await fixture(t, projects.javascript);
  for (const status of ['missing', 'unsupported', 'error']) {
    const result = await runQuality({ ...fx, resolve: fakeTools({ ready: false, status }), runner: toolRunner().runner, capabilities: ['lint'] });
    assert.notEqual(result.status, 'passed'); assert.equal(result.receipts[0].status, status === 'error' ? 'blocked' : status);
  }
  const { runner } = toolRunner({ oxlint: () => ({ code: 0, stdout: '1.90.0', stderr: '' }) });
  const result = await runQuality({ ...fx, resolve: fakeTools(), runner, capabilities: ['lint'] });
  assert.equal(result.receipts[0].reason, 'version_mismatch'); assert.equal(result.status, 'blocked');
});
test('Quality runner blocks malformed partial nonzero and gofmt exit zero filenames', async t => {
  const { runQuality } = await api(); const fx = await fixture(t, projects.javascript);
  for (const output of [{ code: 0, stdout: '{}', stderr: '' }, { code: 0, stdout: '{"diagnostics":[]}', stderr: '' }, { code: 0, stdout: '{', stderr: '' }, { code: 2, stdout: '{"diagnostics":[],"number_of_files":1}', stderr: '' }]) {
    const { runner } = toolRunner({ oxlint: ({ args }) => args.includes('--version') ? { code: 0, stdout: '1.91.0', stderr: '' } : output });
    const result = await runQuality({ ...fx, runner, resolve: fakeTools(), capabilities: ['lint'] });
    assert.notEqual(result.status, 'passed');
  }
  const go = await fixture(t, projects.go);
  const result = await runQuality({ ...go, resolve: fakeTools(), runner: toolRunner({ gofmt: () => ({ code: 0, stdout: 'main.go\n', stderr: '' }) }).runner, capabilities: ['format'] });
  assert.equal(result.receipts[0].status, 'failed');
});
test('Quality debt accepts only matching old observations and blocks changed or worsened code', async t => {
  const { runQuality } = await api(); const fx = await fixture(t, { ...projects.javascript, 'src/new.js': 'export const n = 1;' }, { strictness: 'adopt' });
  const output = { code: 1, stdout: '{"diagnostics":[{"code":"no-unused-vars","severity":"warning","message":"old","labels":[{"span":{"offset":0,"length":1}}],"filename":"src/main.js"}],"number_of_files":2}', stderr: '' };
  const runner = toolRunner({ oxlint: ({ args }) => args.includes('--version') ? { code: 0, stdout: '1.91.0', stderr: '' } : output }).runner;
  const before = await runQuality({ ...fx, runner, resolve: fakeTools(), capabilities: ['lint'], mode: 'standard', changedPaths: ['src/new.js'] });
  assert.equal(before.status, 'failed'); const finding = before.receipts[0].findings[0];
  const baseline = [{ ...finding, language: 'javascript', capability: 'lint', tool: 'oxlint', sourceHash: before.plan.files.find(f => f.path === finding.file).sha256 }];
  await put(fx.project, 'kodo.config.json', { quality: { strictness: 'adopt', baseline } });
  const old = await runQuality({ ...fx, runner, resolve: fakeTools(), capabilities: ['lint'], mode: 'standard', changedPaths: ['src/new.js'] });
  assert.equal(old.status, 'passed'); assert.equal(old.receipts[0].debtCount, 1);
  const changed = await runQuality({ ...fx, runner, resolve: fakeTools(), capabilities: ['lint'], mode: 'standard', changedPaths: ['src/main.js'] });
  assert.equal(changed.status, 'failed');
  await put(fx.project, 'src/main.js', 'export const changed = 2;');
  const worsened = await runQuality({ ...fx, runner, resolve: fakeTools(), capabilities: ['lint'], mode: 'standard', changedPaths: ['src/new.js'] });
  assert.equal(worsened.status, 'failed');
});
test('Quality runner detects source mutation and records redacted bounded private evidence', async t => {
  const { runQuality } = await api(); const fx = await fixture(t, projects.javascript);
  const secret = (await import('node:crypto')).randomBytes(20).toString('hex');
  const runner = toolRunner({ oxlint: async ({ args }) => {
    if (args.includes('--version')) return { code: 0, stdout: '1.91.0', stderr: '' };
    await put(fx.project, 'src/main.js', 'mutated');
    return { code: 1, stdout: '', stderr: `Bearer ${secret}` };
  } }).runner;
  const result = await runQuality({ ...fx, runner, resolve: fakeTools(), capabilities: ['lint'] });
  assert.equal(result.receipts[0].reason, 'source_mutation');
  const text = await readFile(result.receipts[0].evidence[0].path, 'utf8');
  assert.ok(!text.includes(secret)); assert.match(text, /REDACTED/);
});

test('Quality nine language failures missing tools and unsupported platforms cannot pass', async t => {
  const { runQuality } = await api();
  for (const [language, files] of Object.entries(projects)) {
    const fx = await fixture(t, files, { tools: pins, dialect: 'postgres' });
    const capability = language === 'php' ? 'lint' : 'format';
    const bad = toolRunner();
    const badRunner = async (command, args, options) => args.includes('--version') || args[0] === 'version' ? bad.runner(command, args, options) : { code: 1, stdout: 'invalid source', stderr: 'diagnostic' };
    assert.notEqual((await runQuality({ ...fx, resolve: fakeTools(), runner: badRunner, capabilities: [capability] })).status, 'passed', language);
    for (const status of ['missing', 'unsupported']) {
      const nativeResolve = async () => { throw Object.assign(new Error('unavailable fixture runtime'), { code: status }); };
      const report = await runQuality({ ...fx, resolve: fakeTools({ ready: false, status }), nativeResolve, runner: toolRunner().runner, capabilities: [capability] });
      assert.equal(report.status, 'blocked', language); assert.equal(report.receipts[0].status, status, language);
    }
  }
});

test('Quality lint and compiler commands are useful read-only checks with explicit dependency scope', async t => {
  const { runQuality } = await api();
  for (const [language, files] of Object.entries(projects)) {
    const fx = await fixture(t, files, { tools: pins, dialect: 'postgres' }), fake = toolRunner();
    const result = await runQuality({ ...fx, resolve: fakeTools(), runner: fake.runner, capabilities: ['lint'] });
    assert.equal(result.status, 'passed', `${language} ${JSON.stringify(result.receipts)}`);
    assert.ok(fake.calls.some(call => !call.args.includes('--version') && call.args[0] !== 'version'));
    assert.ok(fake.calls.every(call => !call.args.some(arg => ['--write', '--fix', 'install', 'update', 'restore'].includes(arg))));
  }
  for (const language of ['csharp', 'rust', 'go', 'typescript']) {
    const fx = await fixture(t, projects[language], { tools: pins }), fake = toolRunner();
    const result = await runQuality({ ...fx, resolve: fakeTools(), runner: fake.runner, capabilities: ['typecheck'] });
    assert.equal(result.status, 'passed', language); assert.match(result.receipts[0].scopeReason, /dependency/);
  }
});

async function scriptFixture(t, source, extra = {}) {
  return fixture(t, { ...projects.javascript, 'scripts/check.mjs': source }, {
    checks: [{ id: 'fixture-check', capability: 'test', command: 'node', args: ['scripts/check.mjs'], version: process.versions.node, versionOutput: `v${process.versions.node}`, readOnly: true, files: ['src/main.js'], ...extra }]
  });
}
test('Quality configured checks require complete coverage and never execute shipping commands', async t => {
  const { runQuality } = await api();
  const good = await scriptFixture(t, 'console.log(JSON.stringify({schemaVersion:1,complete:true,status:"passed",findings:[],scannedFiles:["src/main.js"]}));');
  const result = await runQuality({ ...good, nativeResolve: undefined, capabilities: ['test'] });
  assert.equal(result.status, 'passed'); assert.equal(result.receipts.length, 1); assert.equal(result.receipts[0].capability, 'test');
  const partial = await scriptFixture(t, 'console.log(JSON.stringify({schemaVersion:1,complete:true,status:"passed",findings:[],scannedFiles:[]}));');
  assert.equal((await runQuality({ ...partial, nativeResolve: undefined, capabilities: ['test'] })).receipts[0].reason, 'invalid_output');
  const shipping = await scriptFixture(t, 'throw new Error("must not start")', { args: ['publish'] });
  await assert.rejects(() => runQuality({ ...shipping, capabilities: ['test'] }), /unsafe.*arguments/);
});

test('Quality process port bounds output and kills the owned tree on deadline', async t => {
  const { runQuality } = await api();
  const overflow = await scriptFixture(t, 'process.stdout.write("x".repeat(20000)); setInterval(()=>{},1000);');
  const large = await runQuality({ ...overflow, nativeResolve: undefined, capabilities: ['test'], timeoutMs: 3000, maxOutputBytes: 1024 });
  assert.equal(large.status, 'blocked'); assert.equal(large.receipts[0].reason, 'output_limit');
  const tree = await scriptFixture(t, 'import {spawn} from "node:child_process"; const child=spawn(process.execPath,["-e","setInterval(()=>{},1000)"],{stdio:"ignore"}); console.log("owned-pid:"+child.pid); setInterval(()=>{},1000);');
  const deadline = await runQuality({ ...tree, nativeResolve: undefined, capabilities: ['test'], timeoutMs: 1000 });
  assert.equal(deadline.receipts[0].reason, 'timeout');
  const text = await readFile(deadline.receipts[0].evidence[0].path, 'utf8');
  const pid = Number(/owned-pid:(\d+)/.exec(text)?.[1]); assert.ok(pid > 0);
  assert.throws(() => process.kill(pid, 0), error => error.code === 'ESRCH');
});

test('Quality cancellation remains blocked and tool environments contain no credentials or startup hooks', async t => {
  const { runQuality } = await api();
  const fx = await fixture(t, projects.javascript); const controller = new AbortController(); controller.abort();
  const cancelled = await runQuality({ ...fx, runner: toolRunner().runner, resolve: fakeTools(), capabilities: ['lint'], signal: controller.signal });
  assert.equal(cancelled.receipts[0].reason, 'cancelled'); assert.equal(cancelled.status, 'blocked');
  const { randomBytes } = await import('node:crypto'); const value = randomBytes(20).toString('hex');
  const previous = process.env.SYNTHETIC_API_KEY; process.env.SYNTHETIC_API_KEY = value;
  t.after(() => { if (previous === undefined) delete process.env.SYNTHETIC_API_KEY; else process.env.SYNTHETIC_API_KEY = previous; });
  const fake = toolRunner();
  const runner = async (command, args, options) => {
    assert.equal(options.env.SYNTHETIC_API_KEY, undefined); assert.equal(options.env.NODE_OPTIONS, undefined);
    if (args.includes('--version')) return fake.runner(command, args, options);
    return { code: 1, stdout: value, stderr: `Bearer ${value}` };
  };
  const result = await runQuality({ ...fx, resolve: fakeTools(), runner, capabilities: ['lint'] });
  const text = await readFile(result.receipts[0].evidence[0].path, 'utf8'); assert.ok(!text.includes(value)); assert.match(text, /REDACTED/);
});

test('Quality passing receipts become stale on evidence config source head or pin changes', async t => {
  const { runQuality, isCurrentQualityReceipt } = await api(); const fx = await fixture(t, projects.javascript);
  const result = await runQuality({ ...fx, resolve: fakeTools(), runner: toolRunner().runner, capabilities: ['lint'] });
  assert.equal(await isCurrentQualityReceipt(result, { project: fx.project, resolve: fakeTools() }), true);
  const tampered = structuredClone(result); tampered.receipts[0].pinsHash = '0'.repeat(64);
  assert.equal(await isCurrentQualityReceipt(tampered, { project: fx.project, resolve: fakeTools() }), false);
  await put(fx.project, 'src/main.js', 'export const changed = 2;');
  assert.equal(await isCurrentQualityReceipt(result, { project: fx.project, resolve: fakeTools() }), false);
});

test('Quality parsers accept observed native JSON channels and reject incomplete formatter coverage', async t => {
  const { parseQualityOutput: parse } = await api();
  const project = process.cwd();
  const check = (tool, file) => ({ tool, files: [file], root: '', capability: 'lint' });
  const css = { code: 2, stdout: '', stderr: '[{"source":"main.css","warnings":[{"line":1,"rule":"color-no-invalid-hex","severity":"error","text":"Invalid hex color"}],"invalidOptionWarnings":[],"parseErrors":[],"errored":true}]' };
  assert.equal(parse(check('stylelint', 'main.css'), css, project).findings[0].ruleId, 'color-no-invalid-hex');
  const oxlint = { code: 1, stdout: '{"diagnostics":[{"message":"Remove debugger","code":"eslint(no-debugger)","severity":"warning","filename":"main.js","labels":[{"span":{"line":1,"offset":0,"length":9}}]}],"number_of_files":1}', stderr: '' };
  assert.equal(parse(check('oxlint', 'main.js'), oxlint, project).findings[0].ruleId, 'eslint(no-debugger)');
  assert.equal(parse(check('html-validate', 'main.html'), { code: 0, stdout: '[]', stderr: '' }, project).clean, true);
  assert.throws(() => parse(check('oxfmt', 'main.js'), { code: 0, stdout: 'All matched files use the correct format.', stderr: '' }, project), /malformed/);
  assert.throws(() => parse(check('oxfmt', 'main.js'), { code: 0, stdout: 'Checking formatting...\nAll matched files use the correct format.\nFinished in 1ms on 0 files using 1 threads.', stderr: '' }, project), /malformed/);
  assert.throws(() => parse(check('cargo', 'src/lib.rs'), { code: 0, stdout: '{"reason":"build-finished","success":true}', stderr: 'error: incomplete compiler output' }, project), /malformed/);
  assert.throws(() => parse(check('html-validate', 'main.html'), { code: 0, stdout: '[{"filePath":"main.html","messages":[],"errorCount":1,"warningCount":-1}]', stderr: '' }, project), /malformed/);
  assert.throws(() => parse(check('phpstan', 'main.php'), { code: 0, stdout: '{"totals":{"errors":2,"file_errors":0},"files":{},"errors":[]}', stderr: '' }, project), /malformed/);
});

test('Quality configured command option paths and symlinked Composer entrypoints block before checks', async t => {
  const { runQuality } = await api();
  const fx = await scriptFixture(t, 'throw new Error("must not run")', { args: ['scripts/check.mjs', '--output=../../outside.json'] });
  const result = await runQuality({ ...fx, capabilities: ['test'] });
  assert.equal(result.receipts[0].reason, 'unsafe_path');
  const php = await fixture(t, projects.php, { tools: { ...pins, phpcs: { version: '3.13.3' } } });
  const { mkdir, symlink } = await import('node:fs/promises');
  await put(php.evidenceDir, 'phpcs', '<?php echo "should not run";');
  await mkdir(`${php.project}/vendor/squizlabs/php_codesniffer`, { recursive: true });
  await symlink(php.evidenceDir, `${php.project}/vendor/squizlabs/php_codesniffer/bin`, process.platform === 'win32' ? 'junction' : 'dir');
  const blocked = await runQuality({ ...php, runner: toolRunner().runner, capabilities: ['format'] });
  assert.notEqual(blocked.status, 'passed');
});

test('Quality active cancellation stops a real configured process and retains cancellation evidence', async t => {
  const { runQuality } = await api(); const { execute } = await import('../runtime/delivery.mjs');
  const fx = await scriptFixture(t, 'console.log("started"); setInterval(()=>{},1000);');
  const controller = new AbortController();
  const runner = async (command, args, options) => {
    if (args[0] === 'scripts/check.mjs') setTimeout(() => controller.abort(), 200);
    return execute(command, args, options);
  };
  const result = await runQuality({ ...fx, nativeResolve: undefined, runner, signal: controller.signal, capabilities: ['test'] });
  assert.equal(result.status, 'blocked'); assert.equal(result.receipts[0].reason, 'cancelled');
  const evidence = await readFile(result.receipts[0].evidence[0].path, 'utf8'); assert.match(evidence, /started/);
});

test('Quality debt cannot adopt untracked new errors omitted by supplied changed paths', async t => {
  const { runQuality } = await api(); const fx = await fixture(t, projects.javascript, { strictness: 'adopt' });
  await put(fx.project, 'src/new.js', 'debugger;');
  const runner = toolRunner({ oxlint: ({ args }) => args.includes('--version') ? { code: 0, stdout: 'Version: 1.91.0', stderr: '' } : { code: 1, stdout: '{"diagnostics":[{"message":"Remove debugger","code":"eslint(no-debugger)","severity":"warning","filename":"src/new.js","labels":[{"span":{"line":1,"offset":0,"length":9}}]}],"number_of_files":2}', stderr: '' } }).runner;
  const first = await runQuality({ ...fx, runner, resolve: fakeTools(), mode: 'standard', changedPaths: [], capabilities: ['lint'] });
  assert.equal(first.status, 'failed');
  const baseline = [{ ...first.receipts[0].findings[0], language: 'javascript', capability: 'lint', tool: 'oxlint', sourceHash: first.plan.files.find(f => f.path === 'src/new.js').sha256 }];
  await put(fx.project, 'kodo.config.json', { quality: { strictness: 'adopt', baseline } });
  const current = await runQuality({ ...fx, runner, resolve: fakeTools(), mode: 'standard', changedPaths: [], capabilities: ['lint'] });
  assert.equal(current.status, 'failed'); assert.ok(current.plan.actualChangedPaths.includes('src/new.js')); assert.equal(current.receipts[0].debtCount, 0);
});

test('Quality receipt validation rejects changed evidence config head and resolved installation', async t => {
  const { runQuality, isCurrentQualityReceipt: current } = await api(); const { execute } = await import('../runtime/delivery.mjs');
  const fx = await fixture(t, projects.javascript);
  const result = await runQuality({ ...fx, resolve: fakeTools(), runner: toolRunner().runner, capabilities: ['lint'] });
  const options = { project: fx.project, resolve: fakeTools() };
  assert.equal(await current(result, options), true);
  const evidence = result.receipts[0].evidence[0].path, originalEvidence = await readFile(evidence, 'utf8');
  const { writeFile } = await import('node:fs/promises');
  await writeFile(evidence, originalEvidence + ' '); assert.equal(await current(result, options), false); await writeFile(evidence, originalEvidence);
  const modified = structuredClone(result); modified.receipts[0].durationMs++;
  assert.equal(await current(modified, options), false);
  assert.equal(await current(result, { ...options, resolve: fakeTools({ command: 'different-installation' }) }), false);
  const config = await readFile(`${fx.project}/kodo.config.json`, 'utf8');
  await put(fx.project, 'kodo.config.json', { quality: { strictness: 'standard' } }); assert.equal(await current(result, options), false);
  await put(fx.project, 'kodo.config.json', config); assert.equal(await current(result, options), true);
  await execute('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@localhost', '-c', 'commit.gpgSign=false', 'commit', '--allow-empty', '-qm', 'advance fixture'], { cwd: fx.project });
  assert.equal(await current(result, options), false);
});

test('Quality identical SQL checks share one process with independent capability and debt receipts', async t => {
  const { runQuality } = await api(); const fx = await fixture(t, projects.sql, { dialect: 'sqlite', strictness: 'adopt' });
  const fake = toolRunner();
  const clean = await runQuality({ ...fx, runner: fake.runner, resolve: fakeTools(), capabilities: ['format', 'lint'] });
  assert.equal(clean.status, 'passed'); assert.equal(clean.receipts.length, 2);
  assert.equal(fake.calls.filter(call => call.args[0] === 'lint').length, 1);
  assert.equal(fake.calls.filter(call => call.args.includes('--version')).length, 1);
  assert.deepEqual(clean.receipts[1].reusedFrom, [clean.receipts[0].id]);
  const badRunner = () => toolRunner({ sqlfluff: ({ args }) => args.includes('--version') ? { code: 0, stdout: 'python -m sqlfluff, version 4.5.0', stderr: '' } : { code: 1, stdout: '[{"filepath":"schema.sql","violations":[{"code":"LT01","start_line_no":1,"description":"Unexpected whitespace"}]}]', stderr: '' } });
  const first = await runQuality({ ...fx, runner: badRunner().runner, resolve: fakeTools(), mode: 'standard', changedPaths: [], capabilities: ['format', 'lint'] });
  assert.equal(first.status, 'failed');
  const baseline = [{ ...first.receipts[1].findings[0], language: 'sql', capability: 'lint', tool: 'sqlfluff', sourceHash: first.plan.files.find(f => f.path === 'schema.sql').sha256 }];
  await put(fx.project, 'kodo.config.json', { quality: { dialect: 'sqlite', strictness: 'adopt', baseline } });
  const bad = badRunner();
  const result = await runQuality({ ...fx, runner: bad.runner, resolve: fakeTools(), mode: 'standard', changedPaths: [], capabilities: ['format', 'lint'] });
  assert.equal(result.receipts[0].status, 'failed'); assert.equal(result.receipts[1].status, 'passed'); assert.equal(result.receipts[1].debtCount, 1);
  assert.equal(bad.calls.filter(call => call.args[0] === 'lint').length, 1);
});

// Opt-in native conformance: ordinary suites remain independent of installed SDKs.
test('Quality native TypeScript compiler seals dependency closure', { skip: !process.env.KODO_QUALITY_TSC_TOOL_HOME }, async t => {
  const { runQuality, isCurrentQualityReceipt } = await api();
  const { resolveTool } = await import('../runtime/tools.mjs');
  const { execute } = await import('../runtime/delivery.mjs');
  const toolHome = process.env.KODO_QUALITY_TSC_TOOL_HOME;
  const tool = await resolveTool('typescript', { home: toolHome });
  assert.equal(tool.ready, true); assert.equal(tool.version, '7.0.2');
  const resolve = async id => { assert.equal(id, 'typescript'); return tool; };
  const cases = [
    ['escaped traversal', () => String.raw`import { value } from '\u002e\u002e/\u002e\u002e/outside/value'; export const answer = value;`],
    ['comment separated import', () => "import { value } from /* scope */ '../../outside/value'; export const answer = value;"],
    ['template dynamic import', () => 'export const answer = import(`../../outside/value`);'],
    ['absolute drive import', fx => `import { value } from ${JSON.stringify(path.join(fx.base, 'outside/value').replaceAll('\\', '/'))}; export const answer = value;`],
    ['UNC import', fx => `import { value } from /* scope */ ${JSON.stringify('//localhost/' + path.join(fx.base, 'outside/value').replaceAll('\\', '/').replace(':', '$'))}; export const answer = value;`],
    ['package main escape', () => "import { value } from './pkg'; export const answer = value;", { 'src/pkg/package.json': { main: '../../../outside/value.ts' } }],
    ['excluded internal source', () => "import { value } from /* scope */ '../dist/value'; export const answer = value;", { 'dist/value.ts': 'export const value = 42;' }],
    ['type reference escape', () => '/// <reference types="../../outside/global" />\nexport const answer = outsideValue;'],
    ['automatic external types', () => 'export const answer: number = outsideValue;', { 'node_modules/@types/untracked/index.d.ts': 'declare const outsideValue: number;' }],
    ['explicit external types', () => 'export const answer: number = outsideValue;', { 'node_modules/@types/untracked/index.d.ts': 'declare const outsideValue: number;', 'tsconfig.json': { compilerOptions: { types: ['untracked'], typeRoots: ['./node_modules/@types'] } } }]
  ];
  for (const [name, source, extras = {}] of cases) await t.test(name, async t => {
    const fx = await fixture(t, { ...projects.typescript, ...extras });
    await put(fx.base, 'outside/value.ts', 'export const value = 42;');
    await put(fx.base, 'outside/global.d.ts', 'declare const outsideValue: number;');
    await put(fx.project, 'src/main.ts', source(fx));
    const options = { ...fx, resolve, runner: execute, capabilities: ['typecheck'] };
    const first = await runQuality(options);
    await captureNativeQualityProbe(name, first);
    // Capture the original false PASS/stale-receipt defect before asserting it.
    await put(fx.base, 'outside/value.ts', 'export const value = "changed";');
    const current = await isCurrentQualityReceipt(first, { project: fx.project, resolve });
    t.diagnostic(JSON.stringify({ status: first.status, currentAfterExternalMutation: current, evidenceRoot: first.evidenceRoot }));
    assert.equal(first.passed, false, 'uncovered compiler dependency cannot receive PASS');
    assert.equal(current, false, 'external mutation cannot leave a successful current receipt');
  });
});

test('Quality native TypeScript retains local imports extends paths JSX and all roots', { skip: !process.env.KODO_QUALITY_TSC_TOOL_HOME }, async t => {
  const { runQuality, isCurrentQualityReceipt } = await api();
  const { resolveTool } = await import('../runtime/tools.mjs');
  const tool = await resolveTool('typescript', { home: process.env.KODO_QUALITY_TSC_TOOL_HOME });
  assert.equal(tool.ready, true);
  const resolve = async () => tool;
  const fx = await fixture(t, { ...projects.typescript,
    'tsconfig.json': { extends: './config/base.json', files: ['src/main.ts'], exclude: ['src/other.ts'], compilerOptions: { noResolve: false } },
    'config/base.json': { compilerOptions: { target: 'es2022', module: 'esnext', moduleResolution: 'bundler', jsx: 'preserve', paths: { '@local/*': ['../src/*'] } } },
    'src/main.ts': "import { value } from './value'; import { value as alias } from '@local/value'; export const answer: number = value + alias;",
    'src/value.ts': 'export const value = 42;',
    'src/other.ts': 'export const other: number = 1;',
    'src/view.tsx': 'export const view = <div />;',
    'src/jsx.d.ts': 'declare namespace JSX { interface IntrinsicElements { div: {}; } }'
  });
  const options = { ...fx, resolve, capabilities: ['typecheck'] };
  const clean = await runQuality(options);
  await captureNativeQualityProbe('valid-local', clean);
  t.diagnostic(JSON.stringify({ status: clean.status, evidenceRoot: clean.evidenceRoot }));
  assert.equal(clean.passed, true);
  assert.equal(await isCurrentQualityReceipt(clean, { project: fx.project, resolve }), true);
  await put(fx.project, 'src/other.ts', 'export const other: number = "wrong";');
  assert.equal(await isCurrentQualityReceipt(clean, { project: fx.project, resolve }), false);
  const bad = await runQuality(options);
  await captureNativeQualityProbe('invalid-root', bad);
  assert.equal(bad.status, 'failed', 'excluded root still checked');
});
async function captureNativeQualityProbe(name, report) {
  if (!process.env.KODO_QUALITY_TSC_PROBE_EVIDENCE) return;
  const { cp, mkdir } = await import('node:fs/promises');
  const target = path.join(process.env.KODO_QUALITY_TSC_PROBE_EVIDENCE, name.replaceAll(' ', '-'));
  await mkdir(target, { recursive: true });
  await put(target, 'report.json', report);
  await cp(report.evidenceRoot, path.join(target, 'raw'), { recursive: true });
}

test('Quality TypeScript external ambient package scopes block before tool execution', async t => {
  const { runQuality } = await api();
  for (const compilerOptions of [{ types: ['untracked'] }, { typeRoots: ['./node_modules/@types'] }]) {
    const fx = await fixture(t, { ...projects.typescript, 'tsconfig.json': { extends: './config/base.json' }, 'config/base.json': { compilerOptions } });
    const result = await runQuality({ ...fx, resolve: async () => assert.fail('unsupported ambient scope must not execute'), capabilities: ['typecheck'] });
    assert.equal(result.status, 'blocked');
    assert.equal(result.receipts[0].reason, 'typescript_external_types_unsupported');
  }
});
