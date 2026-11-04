import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { realpath } from 'node:fs/promises';
import { fixture, put, projects, pins, windowsShortPath } from './fixtures/quality/helpers.mjs';
const api = () => import('../runtime/quality.mjs');

test('Quality Windows drive case and short aliases preserve safe discovery and planning', { skip: process.platform !== 'win32' }, async t => {
  const { QualityProfileRegistry } = await api(), registry = new QualityProfileRegistry();
  const fx = await fixture(t, Object.fromEntries(Object.entries(projects.javascript).map(([name, value]) => ['project directory for alias/' + name, value])));
  const project = path.join(fx.project, 'project directory for alias'), canonical = await realpath(project);
  const aliases = [canonical[0].toLowerCase() + canonical.slice(1), canonical[0].toUpperCase() + canonical.slice(1)];
  const short = await windowsShortPath(project);
  if (/~\d/.test(short)) aliases.push(short);
  else t.diagnostic('8.3 names unavailable on this volume; drive case coverage still runs');
  const expected = await registry.detect(canonical);
  for (const alias of aliases) {
    assert.deepEqual((await registry.detect(alias)).files, expected.files);
    const plan = await registry.plan(alias, { changedPaths: ['src/main.js'], capabilities: ['lint'] });
    assert.equal(plan.status, 'applicable');
    assert.deepEqual(plan.checks[0].files, ['src/main.js']);
  }
});

test('Quality quick metadata changes activate configured checks without crossing sibling projects', async t => {
  const { QualityProfileRegistry } = await api(), registry = new QualityProfileRegistry();
  const fx = await fixture(t, { ...projects.javascript, 'src/other.js': 'export const other = 1;', 'sibling/package.json': {}, 'sibling/main.js': '', 'custom-policy.json': {} }, {
    checks: [{ id: 'project-test', command: 'node', args: ['scripts/test.mjs'], version: process.versions.node, versionOutput: `v${process.versions.node}`, readOnly: true, capability: 'test', files: ['src/main.js', 'src/other.js'] }]
  });
  const project = await realpath(fx.project);
  const configured = plan => plan.checks.find(c => c.id === 'configured:project-test');
  const metadata = configured(await registry.plan(project, { changedPaths: ['package.json'], capabilities: ['test'] }));
  assert.equal(metadata.status, 'applicable'); assert.match(metadata.scopeReason, /metadata/);
  assert.equal(configured(await registry.plan(project, { changedPaths: ['sibling/package.json'], capabilities: ['test'] })).status, 'skipped');
  assert.equal(configured(await registry.plan(project, { changedPaths: ['custom-policy.json'], capabilities: ['test'] })).status, 'blocked');
  await assert.rejects(() => registry.plan(project, { changedPaths: ['src/main.js'], capabilities: ['test'] }), /widening/);
});

test('Quality quick metadata changes widen owning checks and preserve sibling and source scopes', async t => {
  const { QualityProfileRegistry } = await api(), registry = new QualityProfileRegistry();
  const fx = await fixture(t, {
    ...projects.typescript, 'src/main.js': 'export const ok = 1;', 'src/other.js': 'export const other = 1;',
    'src/main.css': 'a { color: red; }', '.stylelintrc.json': { rules: {} },
    'sibling/package.json': { type: 'module' }, 'sibling/main.js': 'export const sibling = 1;',
    'sibling/tsconfig.json': {}, 'sibling/main.ts': 'export const sibling: number = 1;',
    'package-lock.json': { lockfileVersion: 3, packages: { '': { devDependencies: { typescript: '7.0.2' } } } },
    'pnpm-lock.yaml': 'lockfileVersion: 9.0', 'custom-policy.json': {},
  });
  const project = await realpath(fx.project);
  for (const metadata of ['package.json', 'package-lock.json', 'pnpm-lock.yaml', 'tsconfig.json', '.stylelintrc.json']) {
    const plan = await registry.plan(project, { changedPaths: [metadata, 'src/main.js'], capabilities: ['lint', 'typecheck'] });
    const ts = plan.checks.find(c => c.id === 'typescript:.:typecheck');
    assert.equal(ts.status, 'applicable', metadata); assert.deepEqual(ts.files, ['src/main.ts']);
    assert.match(ts.scopeReason, /metadata|config|manifest|lock/);
    const js = plan.checks.find(c => c.id === 'javascript:.:lint');
    assert.deepEqual(js.files, ['src/main.js', 'src/other.js']); assert.match(js.scopeReason, /metadata|config|manifest|lock/);
  }
  const sibling = await registry.plan(project, { changedPaths: ['sibling/package.json'], capabilities: ['lint', 'typecheck'] });
  assert.ok(sibling.checks.filter(c => c.root === '').every(c => c.status === 'skipped'));
  assert.equal(sibling.checks.find(c => c.id === 'typescript:sibling:typecheck').status, 'applicable');
  for (const source of ['src/main.js', 'src/main.css']) {
    const plan = await registry.plan(project, { changedPaths: [source], capabilities: ['format'] });
    assert.deepEqual(plan.checks.filter(c => c.status === 'applicable').flatMap(c => c.files), [source]);
  }
  const unknown = await registry.plan(project, { changedPaths: ['custom-policy.json', 'src/main.js'], capabilities: ['lint', 'typecheck'] });
  assert.equal(unknown.status, 'blocked');
  assert.ok(unknown.checks.some(c => c.reason === 'explicit_affected_scope_required'));
  const explicit = await registry.plan(project, { changedPaths: ['custom-policy.json'], affectedPaths: ['src/main.ts'], capabilities: ['typecheck'] });
  assert.equal(explicit.checks.find(c => c.id === 'typescript:.:typecheck').status, 'applicable');
});

test('Quality quick manifest and config changes select all nine language profiles', async t => {
  const { QualityProfileRegistry } = await api(), registry = new QualityProfileRegistry();
  const metadata = { csharp: 'global.json', rust: 'Cargo.toml', go: 'go.mod', typescript: 'tsconfig.json', javascript: 'package.json', css: '.stylelintrc.json', html: '.htmlvalidate.json', php: 'composer.json', sql: '.sqlfluff' };
  for (const [language, files] of Object.entries(projects)) {
    const fx = await fixture(t, { ...files, ...(language === 'sql' ? { '.sqlfluff': '[sqlfluff]\ndialect=postgres\n' } : {}) }, { tools: { ...pins, phpcs: { version: '3.13.5' } }, dialect: 'postgres' });
    const plan = await registry.plan(fx.project, { changedPaths: [metadata[language]], capabilities: ['format'] });
    const check = plan.checks.find(c => c.language === language);
    assert.equal(check.status, 'applicable', language);
    assert.ok(check.files.length > 0, language); assert.match(check.scopeReason, /metadata/);
  }
});

test('Quality canonical discovery still rejects linked and non-directory roots', async t => {
  const { QualityProfileRegistry } = await api(), registry = new QualityProfileRegistry();
  const fx = await fixture(t, projects.javascript);
  await assert.rejects(() => registry.detect(path.join(fx.project, 'package.json')), /real directory/);
  const { symlink } = await import('node:fs/promises');
  const linked = path.join(fx.evidenceDir, 'linked-project');
  await symlink(fx.project, linked, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(() => registry.detect(linked), /link/i);
});

test('Quality detects all nine languages from manifests and source evidence', async t => {
  const { QualityProfileRegistry } = await api();
  for (const [language, files] of Object.entries(projects)) {
    const fx = await fixture(t, files);
    const report = await new QualityProfileRegistry().detect(fx.project);
    assert.ok(report.languages.includes(language), language);
    assert.ok(report.profiles.find(p => p.language === language).files.length > 0, language);
    assert.match(report.sourceHash, /^[a-f0-9]{64}$/);
  }
});
test('Quality framework indicators require real dependencies config or PHP source', async t => {
  const { QualityProfileRegistry } = await api(); const registry = new QualityProfileRegistry();
  const fx = await fixture(t, { 'next-react-astro-wordpress/README.md': 'names are not evidence' });
  assert.deepEqual((await registry.detect(fx.project)).frameworks, []);
  await put(fx.project, 'package.json', { dependencies: { react: '19.0.0', next: '15.0.0', astro: '5.0.0' } });
  await put(fx.project, 'plugin.php', '<?php\n/* Plugin Name: Fixture */\nadd_action("init", function() {});');
  assert.deepEqual((await registry.detect(fx.project)).frameworks, ['astro', 'next', 'react', 'wordpress']);
});
test('Quality plan is deterministic offline and quick files stay changed or affected', async t => {
  const { QualityProfileRegistry } = await api(); const registry = new QualityProfileRegistry();
  const fx = await fixture(t, { ...projects.javascript, 'src/other.js': 'export const other = 1;' });
  const one = await registry.plan(fx.project, { changedPaths: ['src/main.js'], mode: 'quick' });
  const two = await registry.plan(fx.project, { changedPaths: ['src/main.js'], mode: 'quick' });
  assert.deepEqual(one, two);
  for (const check of one.checks.filter(c => c.status === 'applicable')) assert.deepEqual(check.files, ['src/main.js']);
  assert.equal(one.checks.find(c => c.capability === 'security').status, 'skipped');
});
test('Quality rejects bad config versions dialect baseline and unknown keys', async t => {
  const { QualityProfileRegistry } = await api();
  for (const quality of [{ strictness: 'anything' }, { tools: { php: { version: '^8.4' } } }, { dialect: '--fix' }, { baseline: [{ file: 'new.js' }] }, { typo: true }]) {
    const fx = await fixture(t, projects.javascript, quality);
    await assert.rejects(() => new QualityProfileRegistry().plan(fx.project), /quality|Quality/);
  }
});
test('Quality requires SQL dialect native pins and matching package lock', async t => {
  const { QualityProfileRegistry } = await api(); const registry = new QualityProfileRegistry();
  const sql = await fixture(t, projects.sql);
  assert.equal((await registry.plan(sql.project)).checks.find(c => c.language === 'sql' && c.capability === 'lint').status, 'blocked');
  const cs = await fixture(t, { 'App.csproj': projects.csharp['App.csproj'], 'Program.cs': 'class P {}' });
  assert.equal((await registry.plan(cs.project)).checks.find(c => c.tool === 'dotnet').status, 'missing');
  const js = await fixture(t, { ...projects.javascript, 'package-lock.json': { lockfileVersion: 3, packages: { '': { dependencies: { next: '1.0.0' } } } } });
  await assert.rejects(() => registry.detect(js.project), /lock|manifest/);
});
test('Quality rejects escaped option secret and symlink source paths', async t => {
  const { QualityProfileRegistry } = await api(); const registry = new QualityProfileRegistry();
  const fx = await fixture(t, projects.javascript);
  for (const name of ['../outside.js', '/outside.js', '--fix', 'src/../main.js', '.env', 'src\\main.js']) {
    await assert.rejects(() => registry.plan(fx.project, { changedPaths: [name] }), /path|scope|secret/i);
  }
  const { symlink } = await import('node:fs/promises');
  await symlink(fx.evidenceDir, `${fx.project}/linked`, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(() => registry.detect(fx.project), /link/i);
});

test('Quality dialect and disabled capability states stay explicit and empty quick scope skips execution', async t => {
  const { QualityProfileRegistry } = await api(); const registry = new QualityProfileRegistry();
  const sql = await fixture(t, projects.sql, { dialect: 'invented_dialect' });
  assert.equal((await registry.plan(sql.project, { capabilities: ['lint'] })).checks[0].status, 'unsupported');
  const disabled = await fixture(t, projects.javascript, { enabled: false });
  assert.ok((await registry.plan(disabled.project)).checks.every(c => c.status === 'disabled'));
  const js = await fixture(t, projects.javascript, { capabilities: { lint: false } });
  assert.equal((await registry.plan(js.project)).checks.find(c => c.capability === 'lint').status, 'disabled');
  assert.ok((await registry.plan(js.project, { changedPaths: [] })).checks.filter(c => c.capability === 'format').every(c => c.status === 'skipped'));
});

test('Quality native pins inherit from root manifests and reject conflicting exact versions', async t => {
  const { QualityProfileRegistry } = await api(); const registry = new QualityProfileRegistry();
  const fx = await fixture(t, { 'global.json': projects.csharp['global.json'], 'src/App.csproj': projects.csharp['App.csproj'], 'src/Program.cs': 'class P {}' });
  assert.equal((await registry.plan(fx.project, { capabilities: ['format'] })).checks[0].version, '9.0.100');
  await put(fx.project, 'kodo.config.json', { quality: { tools: { dotnet: { version: '9.0.101' } } } });
  await assert.rejects(() => registry.plan(fx.project), /conflicts/);
});

test('Quality compiler and configured command scopes cannot escape through config or option values', async t => {
  const { QualityProfileRegistry } = await api(); const registry = new QualityProfileRegistry();
  const fx = await fixture(t, { ...projects.typescript, 'tsconfig.json': { include: ['../../private/**/*.ts'] } });
  await assert.rejects(() => registry.plan(fx.project, { capabilities: ['typecheck'] }), /scope|path/i);
  const native = await fixture(t, { ...projects.rust, 'Cargo.toml': '[package]\nname="fixture"\nversion="0.1.0"\nedition="2021"\n[dependencies]\nprivate={path="../../private"}' });
  await assert.rejects(() => registry.plan(native.project), /scope|path/i);
});
