import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, put, projects } from './fixtures/quality/helpers.mjs';
const api = () => import('../runtime/quality.mjs');

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
