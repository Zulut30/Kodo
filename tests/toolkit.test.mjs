import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile, readdir, rm, symlink, lstat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadCatalog, validateManifest, resolveComponents, safeRelative, readBundle, validateSkill } from '../cli/catalog.mjs';
import { planInstallation, applyInstallation } from '../cli/installer.mjs';
import { renderComponent, selectClients } from '../adapters/index.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const catalog = await loadCatalog(root);
const cli = path.join(root, 'cli/index.mjs');
const text = filename => readFile(filename, 'utf8');
const exists = async filename => { try { await lstat(filename); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; } };

async function temporary(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'kodo-test-'));
  t.after(async () => {
    const resolved = path.resolve(directory);
    assert.equal(path.dirname(resolved), path.resolve(os.tmpdir()));
    assert.ok(path.basename(resolved).startsWith('kodo-test-'));
    await rm(resolved, { recursive: true, force: true });
  });
  return directory;
}

function run(...args) { return spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8', cwd: os.tmpdir() }); }

test('Catalog validates all shipped components and resolves unique dependencies before consumers', () => {
  assert.equal(catalog.registry.components.length, 20);
  const resolved = resolveComponents(catalog.registry, ['pipelines/fix-bug', 'pipelines/build-feature']);
  const ids = resolved.map(item => item.id);
  assert.equal(new Set(ids).size, ids.length);
  assert.ok(ids.indexOf('skills/bug-hunting') < ids.indexOf('pipelines/fix-bug'));
  assert.ok(ids.indexOf('agents/architect') < ids.indexOf('pipelines/build-feature'));
  assert.throws(() => resolveComponents(catalog.registry, ['skills/missing']), /Неизвестный компонент/);
});

test('Manifest rejects malformed metadata, missing dependencies and cycles', async t => {
  const cases = [
    ['schema', value => value.schemaVersion = 2, /registry/],
    ['duplicate', value => value.components.push(value.components[0]), /Повторный id/],
    ['path', value => value.components[0].id = 'skills/../../outside', /id/],
    ['type', value => value.components[0].type = 'mcp', /type\/entry/],
    ['version', value => value.components[0].version = 'latest', /метаданные/],
    ['description', value => value.components[0].description = '', /метаданные/],
    ['missing', value => value.components[0].requires = ['skills/missing'], /Неизвестный/],
    ['cycle', value => value.components[0].requires = [value.components[0].id], /Цикл/],
    ['repeated-dependency', value => value.components[0].requires = ['agents/developer', 'agents/developer'], /зависимости/]
  ];
  for (const [name, mutate, expected] of cases) await t.test(name, () => {
    const registry = structuredClone(catalog.registry);
    mutate(registry);
    assert.throws(() => validateManifest(registry), expected);
  });
});

test('Path validation rejects traversal and Windows path aliases', () => {
  for (const value of ['../escape', '/absolute', 'C:/escape', 'a\\b', 'a/../b', 'a//b', 'a/./b', 'a/nul.txt', 'a/CON', 'a/end.', 'a/end ', 'a/stream:name', 'a/\u0000b']) assert.throws(() => safeRelative(value));
  assert.equal(safeRelative('.agents/skills/code-review/SKILL.md'), '.agents/skills/code-review/SKILL.md');
});

test('Adapters emit the documented layout and role format for each client', () => {
  const component = catalog.registry.components.find(item => item.id === 'agents/architect');
  const bundle = catalog.bundles.get(component.id);
  const codex = renderComponent(component, bundle, [], catalog.bundles, 'codex');
  const claude = renderComponent(component, bundle, [], catalog.bundles, 'claude-code');
  const opencode = renderComponent(component, bundle, [], catalog.bundles, 'opencode');
  const codexText = codex.get('.agents/skills/kodo-architect/SKILL.md').toString();
  validateSkill(codexText, 'kodo-architect');
  assert.match(claude.get('.claude/agents/kodo-architect.md').toString(), /^---\nname: kodo-architect\ndescription: "/);
  assert.match(opencode.get('.opencode/agents/kodo-architect.md').toString(), /\nmode: subagent\n---/);
  assert.deepEqual(selectClients(['all']), ['codex', 'claude-code', 'opencode']);
  assert.deepEqual(selectClients(['codex', 'codex']), ['codex']);
  assert.throws(() => selectClients([]), /--client/);
  assert.throws(() => selectClients(['all', 'unknown']), /Неизвестный клиент/);
  assert.throws(() => selectClients(['constructor']), /Неизвестный клиент/);
  assert.throws(() => renderComponent(component, bundle, [], catalog.bundles, 'toString'), /Неизвестный клиент/);
});

test('Dry run resolves the complete preset without creating the target', async t => {
  const directory = await temporary(t), target = path.join(directory, 'new-project');
  const plan = await planInstallation(catalog, ['presets/nextjs'], ['all'], target);
  assert.ok(plan.components.includes('pipelines/build-website'));
  assert.ok(plan.components.includes('skills/seo-audit'));
  assert.ok(plan.components.includes('mcp/browser'));
  assert.equal(await exists(target), false);
  assert.equal(plan.changes.filter(item => item.path === '.agents/skills/code-review/SKILL.md').length, 1);
  assert.ok(plan.changes.every(item => item.status === 'create'));
  for (const file of plan.changes.filter(item => item.path.endsWith('/SKILL.md'))) {
    validateSkill(file.data.toString('utf8'), path.posix.basename(path.posix.dirname(file.path)));
  }
});

test('Preset installs for all clients with self-contained pipelines and repeatable files', async t => {
  const target = await temporary(t);
  await writeFile(path.join(target, 'AGENTS.md'), 'user instructions\n');
  await writeFile(path.join(target, 'opencode.jsonc'), '// user config\n{}\n');
  const first = await planInstallation(catalog, ['presets/nextjs'], ['all'], target);
  await applyInstallation(first);
  const pipelineRoot = path.join(target, '.claude/skills/build-website');
  const instructions = await text(path.join(pipelineRoot, 'SKILL.md'));
  validateSkill(instructions, 'build-website');
  const references = [...instructions.matchAll(/\]\((references\/[^)]+)\)/g)];
  assert.equal(references.length, 7);
  for (const match of references) assert.equal(await exists(path.join(pipelineRoot, match[1])), true, match[1]);
  assert.match(await text(path.join(pipelineRoot, 'references/agents/designer/AGENT.md')), /Дизайнер/);
  assert.equal(await exists(path.join(target, '.claude/agents/kodo-developer.md')), true);
  assert.equal(await exists(path.join(target, '.opencode/agents/kodo-developer.md')), true);
  assert.equal(await exists(path.join(target, '.agents/skills/build-feature/SKILL.md')), true);
  assert.equal(await exists(path.join(target, '.agents/skills/kodo-preset-nextjs/SKILL.md')), true);
  assert.equal(await text(path.join(target, 'AGENTS.md')), 'user instructions\n');
  assert.equal(await text(path.join(target, 'opencode.jsonc')), '// user config\n{}\n');
  assert.equal(await exists(path.join(target, '.codex/config.toml')), false);
  assert.equal(await exists(path.join(target, '.mcp.json')), false);
  const lockBefore = await text(path.join(target, '.kodo/lock.json'));
  const second = await planInstallation(catalog, ['presets/nextjs'], ['all'], target);
  assert.ok(second.changes.every(item => item.status === 'unchanged'));
  await applyInstallation(second);
  assert.equal(await text(path.join(target, '.kodo/lock.json')), lockBefore);
  assert.equal(await exists(path.join(target, '.kodo/install.guard')), false);
});

test('Unmanaged and locally edited files are preserved before any installation writes', async t => {
  const target = await temporary(t), filename = path.join(target, '.agents/skills/code-review/SKILL.md');
  await mkdir(path.dirname(filename), { recursive: true });
  await writeFile(filename, 'user skill\n');
  await assert.rejects(planInstallation(catalog, ['skills/code-review'], ['codex'], target), /не принадлежит/);
  assert.equal(await text(filename), 'user skill\n');
  assert.equal(await exists(path.join(target, '.kodo')), false);
  await rm(filename);
  await applyInstallation(await planInstallation(catalog, ['skills/code-review'], ['codex'], target));
  await writeFile(filename, 'edited skill\n');
  const lockBefore = await text(path.join(target, '.kodo/lock.json'));
  await assert.rejects(planInstallation(catalog, ['presets/dotnet'], ['codex'], target), /изменён пользователем/);
  assert.equal(await text(filename), 'edited skill\n');
  assert.equal(await text(path.join(target, '.kodo/lock.json')), lockBefore);
  assert.equal(await exists(path.join(target, '.agents/skills/build-feature')), false);
});

test('Managed files update while unrelated installed components remain tracked', async t => {
  const target = await temporary(t);
  await applyInstallation(await planInstallation(catalog, ['skills/code-review', 'skills/bug-hunting'], ['codex'], target));
  const updated = { ...catalog, bundles: new Map(catalog.bundles) };
  updated.bundles.set('skills/code-review', new Map(catalog.bundles.get('skills/code-review')));
  updated.bundles.get('skills/code-review').set('SKILL.md', Buffer.from('updated source\n'));
  const plan = await planInstallation(updated, ['skills/code-review'], ['codex'], target);
  assert.ok(plan.changes.every(item => item.status === 'update'));
  await applyInstallation(plan);
  assert.equal(await text(path.join(target, '.agents/skills/code-review/SKILL.md')), 'updated source\n');
  const lock = JSON.parse(await text(path.join(target, '.kodo/lock.json')));
  assert.equal(lock.files['.agents/skills/bug-hunting/SKILL.md'].component, 'skills/bug-hunting');
});

test('Changed target or lock after planning prevents stale installation', async t => {
  const directory = await temporary(t);
  for (const mode of ['file', 'lock']) {
    const target = path.join(directory, mode);
    const plan = await planInstallation(catalog, ['skills/code-review'], ['codex'], target);
    if (mode === 'file') {
      const filename = path.join(target, '.agents/skills/code-review/SKILL.md');
      await mkdir(path.dirname(filename), { recursive: true });
      await writeFile(filename, 'late user edit\n');
    } else {
      await mkdir(path.join(target, '.kodo'), { recursive: true });
      await writeFile(path.join(target, '.kodo/lock.json'), '{}');
    }
    await assert.rejects(applyInstallation(plan), /изменил/);
    assert.equal(await exists(path.join(target, '.kodo/components')), false);
    assert.equal(await exists(path.join(target, '.kodo/install.guard')), false);
    if (mode === 'file') assert.equal(await text(path.join(target, '.agents/skills/code-review/SKILL.md')), 'late user edit\n');
    else assert.equal(await text(path.join(target, '.kodo/lock.json')), '{}');
  }
});

test('Existing installation guard prevents a second installer from changing files', async t => {
  const target = await temporary(t);
  const plan = await planInstallation(catalog, ['skills/code-review'], ['codex'], target);
  await mkdir(path.join(target, '.kodo'));
  await writeFile(path.join(target, '.kodo/install.guard'), 'other installer\n');
  await assert.rejects(applyInstallation(plan), /Другая установка/);
  assert.equal(await text(path.join(target, '.kodo/install.guard')), 'other installer\n');
  assert.equal(await exists(path.join(target, '.agents')), false);
});

test('Write failure rolls back created files and restores updated files with the original lock', async t => {
  const target = await temporary(t);
  await applyInstallation(await planInstallation(catalog, ['skills/code-review'], ['codex'], target));
  const originalSkill = await text(path.join(target, '.agents/skills/code-review/SKILL.md'));
  const originalSource = await text(path.join(target, '.kodo/components/skills/code-review/SKILL.md'));
  const originalLock = await text(path.join(target, '.kodo/lock.json'));
  // Isolate the injected filesystem error in a child process. No production
  // source is changed, and the test still uses real temporary files/renames.
  const code = `
    import fs from 'node:fs/promises';
    import path from 'node:path';
    import { pathToFileURL } from 'node:url';
    import { syncBuiltinESMExports } from 'node:module';
    const [root, target] = process.argv.slice(1);
    const realRename = fs.rename;
    let failed = false;
    fs.rename = async (from, to) => {
      if (!failed && to === path.join(target, '.agents/skills/code-review/SKILL.md')) {
        failed = true;
        throw Object.assign(new Error('simulated EIO'), { code: 'EIO' });
      }
      return realRename(from, to);
    };
    syncBuiltinESMExports();
    const { loadCatalog } = await import(pathToFileURL(path.join(root, 'cli/catalog.mjs')));
    const { planInstallation, applyInstallation } = await import(pathToFileURL(path.join(root, 'cli/installer.mjs')));
    const catalog = await loadCatalog(root);
    const bundle = catalog.bundles.get('skills/code-review');
    bundle.set('SKILL.md', Buffer.concat([bundle.get('SKILL.md'), Buffer.from('\\nUpdated instructions.\\n')]));
    const plan = await planInstallation(catalog, ['skills/bug-hunting', 'skills/code-review'], ['codex'], target);
    try { await applyInstallation(plan); throw new Error('expected EIO'); }
    catch (error) { if (error.code !== 'EIO' || !failed) throw error; }
    console.log('rollback exercised');
  `;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', code, root, target], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), 'rollback exercised');
  assert.equal(await text(path.join(target, '.agents/skills/code-review/SKILL.md')), originalSkill);
  assert.equal(await text(path.join(target, '.kodo/components/skills/code-review/SKILL.md')), originalSource);
  assert.equal(await text(path.join(target, '.kodo/lock.json')), originalLock);
  assert.equal(await exists(path.join(target, '.agents/skills/bug-hunting/SKILL.md')), false);
  assert.equal(await exists(path.join(target, '.kodo/components/skills/bug-hunting/SKILL.md')), false);
  assert.equal(await exists(path.join(target, '.kodo/install.guard')), false);
  assert.deepEqual(await readdir(path.join(target, '.agents/skills/code-review')), ['SKILL.md']);
});

test('Directory conflicts and corrupted ownership metadata fail without overwriting', async t => {
  const target = await temporary(t);
  await mkdir(path.join(target, '.agents/skills/code-review/SKILL.md'), { recursive: true });
  await assert.rejects(planInstallation(catalog, ['skills/code-review'], ['codex'], target), /Конфликт с папкой/);
  assert.equal(await exists(path.join(target, '.kodo')), false);
  const other = path.join(target, 'other');
  await mkdir(path.join(other, '.kodo'), { recursive: true });
  await writeFile(path.join(other, '.kodo/lock.json'), '{broken');
  await assert.rejects(planInstallation(catalog, ['skills/code-review'], ['codex'], other), SyntaxError);
  await writeFile(path.join(other, '.kodo/lock.json'), JSON.stringify({ schemaVersion: 1, files: { '../outside': { sha256: '0'.repeat(64), component: 'x', version: '1.0.0' } } }));
  await assert.rejects(planInstallation(catalog, ['skills/code-review'], ['codex'], other), /Небезопасный/);
  assert.equal(await exists(path.join(other, '.agents')), false);
});

test('Source links and destination junctions are rejected without writes outside the project', async t => {
  const directory = await temporary(t), external = path.join(directory, 'external'), target = path.join(directory, 'project');
  await mkdir(external); await mkdir(target);
  await writeFile(path.join(external, 'keep.txt'), 'keep\n');
  await symlink(external, path.join(target, '.agents'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(planInstallation(catalog, ['skills/code-review'], ['codex'], target), /ссылку или junction/);
  assert.deepEqual(await readdir(external), ['keep.txt']);
  await assert.rejects(readBundle(path.join(target, '.agents')), /Ссылки/);
});

test('Catalog rejects a missing entry and an invalid pipeline reference', async t => {
  const directory = await temporary(t);
  const registry = structuredClone(catalog.registry);
  registry.components = registry.components.filter(item => item.id === 'skills/code-review');
  await mkdir(path.join(directory, 'skills/code-review'), { recursive: true });
  await writeFile(path.join(directory, 'registry.json'), JSON.stringify(registry));
  await assert.rejects(loadCatalog(directory), /Отсутствует/);
  const source = catalog.bundles.get('skills/code-review').get('SKILL.md');
  await writeFile(path.join(directory, 'skills/code-review/SKILL.md'), source);
  assert.equal((await loadCatalog(directory)).registry.components.length, 1);
  const pipeline = catalog.registry.components.find(item => item.id === 'pipelines/build-feature');
  const dependencies = resolveComponents(catalog.registry, pipeline.requires);
  registry.components = [...dependencies, pipeline];
  for (const component of registry.components) for (const [name, data] of catalog.bundles.get(component.id)) {
    const filename = path.join(directory, component.id, name);
    await mkdir(path.dirname(filename), { recursive: true }); await writeFile(filename, data);
  }
  await writeFile(path.join(directory, 'registry.json'), JSON.stringify(registry));
  const content = JSON.parse(catalog.bundles.get(pipeline.id).get('pipeline.json'));
  content.steps[0].agent = 'agents/designer';
  await writeFile(path.join(directory, pipeline.id, 'pipeline.json'), JSON.stringify(content));
  await assert.rejects(loadCatalog(directory), /Некорректный этап/);
});

test('CLI supports catalog queries, pipeline plans and JSON dry run from another directory', async t => {
  const directory = await temporary(t), target = path.join(directory, 'dry-run');
  const list = run('list', 'skill', '--json');
  assert.equal(list.status, 0, list.stderr);
  assert.deepEqual(JSON.parse(list.stdout).map(item => item.id), ['skills/code-review', 'skills/ui-audit', 'skills/bug-hunting', 'skills/seo-audit', 'skills/kodo-build-feature']);
  const show = run('show', 'agents/designer', '--json');
  assert.equal(show.status, 0, show.stderr);
  assert.match(JSON.parse(show.stdout).content, /Дизайнер/);
  const plan = run('plan', 'pipelines/fix-bug', '--json');
  assert.equal(plan.status, 0, plan.stderr);
  assert.equal(JSON.parse(plan.stdout).content.steps[0].skill, 'skills/bug-hunting');
  const dryRun = run('init', '--preset', 'dotnet', '--client', 'codex', '--target', target, '--dry-run', '--json');
  assert.equal(dryRun.status, 0, dryRun.stderr);
  assert.equal(JSON.parse(dryRun.stdout).dryRun, true);
  assert.equal(await exists(target), false);
  const install = run('install', 'skills/bug-hunting', '--client', 'claude-code', '--target', path.join(directory, 'installed'), '--json');
  assert.equal(install.status, 0, install.stderr);
  assert.equal(JSON.parse(install.stdout).dryRun, false);
  assert.equal(await exists(path.join(directory, 'installed/.claude/skills/bug-hunting/SKILL.md')), true);
});

test('CLI returns an error for unknown or incomplete input without stdout success data', () => {
  for (const args of [
    ['unknown'], ['list', 'unknown'], ['show'], ['show', 'skills/missing'], ['plan', 'skills/code-review'],
    ['validate', '--target', 'project'], ['install', 'skills/code-review'],
    ['install', 'skills/code-review', '--client', 'codex', '--target'],
    ['install', 'skills/code-review', '--client', 'missing', '--target', 'project'],
    ['init', '--preset', 'dotnet', '--client', 'codex', '--target', 'project', '--force']
  ]) {
    const result = run(...args);
    assert.equal(result.status, 1, args.join(' '));
    assert.match(result.stderr, /^Ошибка:/);
    assert.equal(result.stdout, '');
  }
});
