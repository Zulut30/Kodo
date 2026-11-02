import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { access, cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defaultSkillIds, loadDefaultPolicy, verifyDefaultSkillPins } from '../runtime/skill-policy.mjs';
import { readBundle, validateSkill } from '../cli/catalog.mjs';
import { planInstallation, applyInstallation } from '../cli/installer.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const text = filename => readFile(filename, 'utf8');
const digest = data => createHash('sha256').update(data).digest('hex');
const expectedIds = [
  'skills/architecture-patterns','skills/architecture-decision-records','skills/monorepo-management','skills/e2e-testing-patterns',
  'skills/subagent-driven-development','skills/systematic-debugging','skills/test-driven-development','skills/using-git-worktrees',
  'skills/differential-review','skills/react-best-practices','skills/composition-patterns','skills/ce-compound','skills/spec-kit'
];

async function temporary(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'kodo-policy-test-'));
  t.after(async () => {
    const resolved = path.resolve(directory);
    assert.equal(path.dirname(resolved), path.resolve(os.tmpdir()));
    assert.ok(path.basename(resolved).startsWith('kodo-policy-test-'));
    await rm(resolved, { recursive: true, force: true });
  });
  return directory;
}

test('Default policy evaluates all thirteen pinned skills at every runtime stage without network calls', async t => {
  const project = await temporary(t);
  const originalFetch = globalThis.fetch;
  let requests = 0;
  globalThis.fetch = async () => { requests++; throw new Error('policy must not use network'); };
  t.after(() => { globalThis.fetch = originalFetch; });
  assert.deepEqual(defaultSkillIds, expectedIds);
  for (const stage of ['analyze','plan','developer','tester','documenter','review','repair','complete']) {
    const result = await loadDefaultPolicy({ project, stage, task: 'Improve a command line parser' });
    assert.deepEqual(result.skills.map(item => item.id), expectedIds);
    assert.equal(result.skills.length, 13);
    assert.ok(result.skills.every(item => typeof item.applies === 'boolean' && item.reason.length > 0 && /^[a-f0-9]{40}$/.test(item.revision)));
    assert.ok(result.skills.every(item => item.source.startsWith('https://github.com/')));
    assert.match(result.context, /All 13 bundled skills were evaluated/);
    assert.match(result.context, /coordinator owns model routing/);
    assert.match(result.hash, /^[a-f0-9]{64}$/);
    if (stage === 'complete') {
      assert.equal(result.skills.find(item => item.id === 'skills/ce-compound').applies, true);
      assert.match(result.context, /cheapest form|доказательство/);
    }
  }
  assert.equal(requests, 0);
});

test('Default policy loads differential sources for review and omits React and monorepo content for a plain project', async t => {
  const project = await temporary(t);
  await writeFile(path.join(project, 'package.json'), JSON.stringify({ name: 'plain-cli', dependencies: { ajv: '^8.0.0' } }));
  const result = await loadDefaultPolicy({ project, stage: 'review', task: 'Review retry handling in a CLI' });
  assert.equal(result.skills.find(item => item.id === 'skills/differential-review').applies, true);
  assert.equal(result.skills.find(item => item.id === 'skills/react-best-practices').applies, false);
  assert.equal(result.skills.find(item => item.id === 'skills/composition-patterns').applies, false);
  assert.equal(result.skills.find(item => item.id === 'skills/monorepo-management').applies, false);
  assert.match(result.context, /Security-focused code review/);
  assert.match(result.context, /CC-BY-SA-4.0/);
  assert.doesNotMatch(result.context, /### skills\/react-best-practices/);
  assert.doesNotMatch(result.context, /### skills\/monorepo-management/);
});

test('Default policy detects React in a nested workspace and selects both Vercel practices', async t => {
  const project = await temporary(t);
  await writeFile(path.join(project, 'package.json'), JSON.stringify({ name: 'workspace', workspaces: ['apps/*'] }));
  await mkdir(path.join(project, 'apps/web'), { recursive: true });
  await writeFile(path.join(project, 'apps/web/package.json'), JSON.stringify({ name: 'web', dependencies: { react: '^19.0.0', next: '^16.0.0' } }));
  const result = await loadDefaultPolicy({ project, stage: 'developer', task: 'Improve component request handling' });
  for (const id of ['skills/monorepo-management','skills/react-best-practices','skills/composition-patterns']) assert.equal(result.skills.find(item => item.id === id).applies, true, id);
  assert.match(result.context, /### skills\/react-best-practices/);
  assert.match(result.context, /### skills\/composition-patterns/);
  assert.match(result.context, /vercel-react-best-practices/);
  assert.match(result.context, /architecture-avoid-boolean-props/);
});

test('Default policy supports pnpm workspaces and explicit new React requirements before dependencies exist', async t => {
  const project = await temporary(t);
  await writeFile(path.join(project, 'pnpm-workspace.yaml'), "packages:\n  - packages/*\n");
  const result = await loadDefaultPolicy({ project, stage: 'plan', task: 'Build a React client for the existing command' });
  assert.equal(result.skills.find(item => item.id === 'skills/monorepo-management').applies, true);
  assert.equal(result.skills.find(item => item.id === 'skills/react-best-practices').applies, true);
  const unrelated = await loadDefaultPolicy({ project, stage: 'documenter', task: 'Explain the command line usage' });
  assert.equal(unrelated.skills.find(item => item.id === 'skills/react-best-practices').applies, false);
  assert.equal(unrelated.skills.find(item => item.id === 'skills/monorepo-management').applies, true);
});

test('Default provenance verifies original resources and retained license declarations', async () => {
  const { lock, resources } = await verifyDefaultSkillPins(root);
  assert.equal(lock.components.length, 13);
  const sourceCounts = new Map();
  for (const component of lock.components) {
    assert.ok(component.files.length >= 2);
    for (const file of component.files) {
      const data = await readFile(path.join(root, file.path));
      assert.equal(data.length, file.bytes, file.path);
      assert.equal(digest(data), file.sha256, file.path);
      assert.ok(file.upstreamPath.length > 0);
    }
    sourceCounts.set(component.id, component.files.length);
    assert.ok(resources.get(component.entryPoint).length > 0);
    assert.ok(resources.get(component.license.localPath).length > 0);
    const wrapper = await text(path.join(root, component.id, 'SKILL.md'));
    validateSkill(wrapper, component.id.split('/')[1]);
  }
  assert.equal(lock.components.find(item => item.id === 'skills/differential-review').license.spdx, 'CC-BY-SA-4.0');
  assert.match(await text(path.join(root, 'skills/differential-review/SKILL.md')), /эта адаптация распространяются по/);
  assert.ok(sourceCounts.get('skills/react-best-practices') > 10, 'Vercel supporting rules must be retained');
  assert.ok(resources.get('skills/spec-kit/references/upstream/tasks-template.md').includes('Task'));
});

test('Default policy rejects altered pinned source and invalid provenance before building a prompt', async t => {
  const directory = await temporary(t), copiedRoot = path.join(directory, 'bundle'), project = path.join(directory, 'project');
  await mkdir(copiedRoot); await mkdir(project);
  await cp(path.join(root, 'skills'), path.join(copiedRoot, 'skills'), { recursive: true });
  const lock = JSON.parse(await text(path.join(root, 'third-party-skills.lock.json')));
  await writeFile(path.join(copiedRoot, 'third-party-skills.lock.json'), JSON.stringify(lock));
  const entry = lock.components[0].entryPoint;
  const original = await readFile(path.join(copiedRoot, entry));
  await writeFile(path.join(copiedRoot, entry), Buffer.concat([original, Buffer.from('\nmodified source\n')]));
  await assert.rejects(loadDefaultPolicy({ project, root: copiedRoot, stage: 'plan' }), error => error.code === 'skill_integrity' && /hash mismatch/.test(error.message));
  await writeFile(path.join(copiedRoot, entry), original);
  lock.components[0].revision = 'main';
  await writeFile(path.join(copiedRoot, 'third-party-skills.lock.json'), JSON.stringify(lock));
  await assert.rejects(loadDefaultPolicy({ project, root: copiedRoot, stage: 'plan' }), error => error.code === 'skill_integrity' && /invalid component/.test(error.message));
});

test('Default policy hash is stable for identical context and changes with applicability or stage', async t => {
  const project = await temporary(t);
  const first = await loadDefaultPolicy({ project, stage: 'plan', task: 'Document the parser' });
  const same = await loadDefaultPolicy({ project, stage: 'plan', task: 'Document the parser' });
  assert.equal(first.hash, same.hash);
  const review = await loadDefaultPolicy({ project, stage: 'review', task: 'Document the parser' });
  assert.notEqual(first.hash, review.hash);
  await writeFile(path.join(project, 'package.json'), JSON.stringify({ dependencies: { react: '^18.0.0' } }));
  const react = await loadDefaultPolicy({ project, stage: 'plan', task: 'Document the parser' });
  assert.notEqual(first.hash, react.hash);
  await assert.rejects(loadDefaultPolicy({ project, stage: 'unknown' }), /Unknown Kodo skill stage/);
});

test('Adapted upstream skill installs as one discoverable wrapper with intact local supporting files', async t => {
  const target = await temporary(t), id = 'skills/systematic-debugging';
  const bundle = await readBundle(path.join(root, id));
  const catalog = {
    registry: { schemaVersion: 1, version: '0.2.0', components: [{ id, type: 'skill', version: '0.2.0', description: 'Systematic debugging', entry: 'SKILL.md', requires: [] }] },
    bundles: new Map([[id, bundle]])
  };
  const plan = await planInstallation(catalog, [id], ['codex','claude-code'], target);
  await applyInstallation(plan);
  const base = path.join(target, '.agents/skills/systematic-debugging');
  validateSkill(await text(path.join(base, 'SKILL.md')), 'systematic-debugging');
  const source = await readFile(path.join(base, 'references/upstream/SKILL.md.original'));
  assert.equal(digest(source), digest(bundle.get('references/upstream/SKILL.md.original')));
  await access(path.join(base, 'references/upstream/root-cause-tracing.md'));
  await access(path.join(target, '.claude/skills/systematic-debugging/SKILL.md'));
  assert.equal([...bundle.keys()].filter(name => path.posix.basename(name) === 'SKILL.md').length, 1);
});

test('Default policy resolves bundled resources outside a generic target project to existing absolute files', async t => {
  const project = await temporary(t);
  const result = await loadDefaultPolicy({ project, stage: 'plan', task: 'Plan a React workspace module' });
  assert.match(result.context, /Bundle resource root \(read-only\):/);
  assert.match(result.context, /never from the target project cwd/);
  assert.doesNotMatch(result.context, /\]\(references\/upstream\//);
  const links = [...result.context.matchAll(/\]\(<?((?:[A-Za-z]:\/|\/)[^)>]+)>?\)/g)].map(match => match[1].split('#')[0]);
  assert.ok(links.length >= 15, 'loaded adapters must retain usable local reference links');
  for (const filename of links) {
    assert.ok(!filename.startsWith(project.replaceAll('\\', '/') + '/'));
    await access(filename);
  }
  const before = JSON.parse(await text(path.join(root, 'third-party-skills.lock.json'))).components[0].files[1];
  assert.equal(digest(await readFile(path.join(root, before.path))), before.sha256, 'context link resolution must not rewrite pinned source bytes');
});
