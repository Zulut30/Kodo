import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
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
  const directory = await temporary(t), copiedRoot = path.join(directory, 'bundle with spaces'), project = path.join(directory, 'project');
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

test('Compact policy keeps complete adapters and provenance with on-demand upstream references instead of excerpts', async t => {
  const project = await temporary(t);
  const result = await loadDefaultPolicy({ project, stage: 'review', task: 'Review a React monorepo' });
  assert.match(result.context, /^Kodo default skill policy v1, stage review/);
  assert.equal(result.skills.filter(row => row.applies).length, 12);
  assert.doesNotMatch(result.context, /Pinned upstream reference excerpt|# Security-focused code review|# Systematic Debugging/);
  for (const skill of result.skills) {
    assert.ok(result.context.includes(skill.id));
    assert.ok(result.context.includes(skill.revision), `${skill.id} provenance`);
    assert.ok(result.context.includes(skill.source), `${skill.id} source`);
    if (!skill.applies) continue;
    const adapter = (await text(path.join(root, skill.id, 'SKILL.md'))).replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, '');
    const prose = adapter.replace(/\]\([^)]+\)/g, ']');
    assert.ok(result.context.replace(/\]\([^)]+\)/g, ']').includes(prose), `${skill.id}: full adapter prose`);
  }
});

test('Repeated compact policy loads recheck even non-applicable pinned resources', async t => {
  const directory = await temporary(t), copiedRoot = path.join(directory, 'bundle with spaces'), project = path.join(directory, 'project');
  await mkdir(copiedRoot); await mkdir(project);
  await cp(path.join(root, 'skills'), path.join(copiedRoot, 'skills'), { recursive: true });
  const lock = JSON.parse(await text(path.join(root, 'third-party-skills.lock.json')));
  await writeFile(path.join(copiedRoot, 'third-party-skills.lock.json'), JSON.stringify(lock));
  const adapterPath = path.join(copiedRoot, 'skills/ce-compound/SKILL.md');
  await writeFile(adapterPath, (await text(adapterPath)) + '\n' + 'Complete adapter obligation. '.repeat(100) + '\nADAPTER_TAIL_MUST_SURVIVE\n');
  const first = await loadDefaultPolicy({ root: copiedRoot, project, stage: 'complete' });
  assert.match(first.context, /ADAPTER_TAIL_MUST_SURVIVE/);
  const links = [...first.context.matchAll(/\]\(<([^>]+)>\)/g)].map(match => match[1]);
  assert.ok(links.length > 0);
  for (const filename of links) await access(filename);
  assert.equal(first.skills.find(row => row.id === 'skills/react-best-practices').applies, false);
  const unused = lock.components.find(row => row.id === 'skills/react-best-practices').files.at(-1).path;
  await writeFile(path.join(copiedRoot, unused), 'changed unused upstream rule');
  await assert.rejects(loadDefaultPolicy({ root: copiedRoot, project, stage: 'complete' }), error => error.code === 'skill_integrity' && /hash mismatch/.test(error.message));
});

test('Pinned verification overlaps at most four fresh resource operations and preserves all lock entries', async t => {
  const lock = JSON.parse(await text(path.join(root, 'third-party-skills.lock.json')));
  const files = lock.components.flatMap(component => component.files);
  const expected = new Map();
  for (const file of files) expected.set(file.path, await text(path.join(root, file.path)));
  assert.equal(expected.size, 183);
  const targets = new Set(files.map(file => path.join(root, file.path)));
  const originalLstat = fs.lstat, originalReadFile = fs.readFile;
  let lockRead = false, active = 0, peak = 0;
  const reads = new Map();
  const statSpy = t.mock.method(fs, 'lstat', async (filename, ...args) => {
    if (filename === root && lockRead) { active++; peak = Math.max(peak, active); }
    return originalLstat(filename, ...args);
  });
  const readSpy = t.mock.method(fs, 'readFile', async (filename, ...args) => {
    if (!targets.has(filename)) {
      const data = await originalReadFile(filename, ...args);
      if (filename === path.join(root, 'third-party-skills.lock.json')) lockRead = true;
      return data;
    }
    reads.set(filename, (reads.get(filename) || 0) + 1);
    try { return await originalReadFile(filename, ...args); }
    finally { active--; }
  });
  syncBuiltinESMExports();
  try {
    for (let call = 1; call <= 2; call++) {
      lockRead = false;
      const verified = await verifyDefaultSkillPins(root);
      assert.deepEqual([...verified.byId.keys()], lock.components.map(component => component.id));
      assert.deepEqual([...verified.resources], [...expected]);
      assert.equal(active, 0);
      assert.equal(reads.size, 183);
      assert.ok([...reads.values()].every(count => count === call), 'every pinned file must be read again');
    }
    assert.ok(peak > 1, `independent resource operations must overlap; observed ${peak}`);
    assert.ok(peak <= 4, `resource operation bound exceeded: ${peak}`);
  } finally {
    statSpy.mock.restore(); readSpy.mock.restore(); syncBuiltinESMExports();
  }
});

test('Pinned verification drains started siblings and reports the first lock-ordered read error', async t => {
  const lock = JSON.parse(await text(path.join(root, 'third-party-skills.lock.json')));
  const firstFiles = lock.components[0].files.slice(0, 4).map(file => path.join(root, file.path));
  assert.equal(firstFiles.length, 4);
  const originalReadFile = fs.readFile;
  const entered = [], finished = [];
  const allStarted = Promise.withResolvers(), releaseSibling = Promise.withResolvers();
  const readSpy = t.mock.method(fs, 'readFile', async (filename, ...args) => {
    const index = firstFiles.indexOf(filename);
    if (index < 0) return originalReadFile(filename, ...args);
    entered.push(filename);
    if (entered.length === 4) allStarted.resolve();
    try {
      if (index === 0) {
        await allStarted.promise;
        setImmediate(() => releaseSibling.resolve());
        throw new Error('first ordered failure');
      }
      if (index === 1) throw new Error('earlier completion but later lock entry');
      if (index === 2) await releaseSibling.promise;
      return await originalReadFile(filename, ...args);
    } finally { finished.push(filename); }
  });
  syncBuiltinESMExports();
  try {
    await assert.rejects(verifyDefaultSkillPins(root), error => {
      assert.equal(error.code, 'skill_integrity');
      assert.equal(error.message, `Default skill integrity: cannot read ${lock.components[0].files[0].path}: first ordered failure`);
      assert.equal(entered.length, 4);
      assert.deepEqual(new Set(finished), new Set(firstFiles), 'all started reads must finish before rejection');
      return true;
    });
  } finally {
    allStarted.resolve(); releaseSibling.resolve();
    readSpy.mock.restore(); syncBuiltinESMExports();
  }
});

test('Pinned verification preserves hash failure precedence over a later invalid file record', async t => {
  const directory = await temporary(t);
  await cp(path.join(root, 'skills'), path.join(directory, 'skills'), { recursive: true });
  const lock = JSON.parse(await text(path.join(root, 'third-party-skills.lock.json')));
  const first = lock.components[0].files[0];
  await writeFile(path.join(directory, first.path), 'corrupt first resource');
  lock.components[0].files[1].sha256 = 'invalid';
  await writeFile(path.join(directory, 'third-party-skills.lock.json'), JSON.stringify(lock));
  await assert.rejects(verifyDefaultSkillPins(directory), error => {
    assert.equal(error.code, 'skill_integrity');
    assert.equal(error.message, `Default skill integrity: hash mismatch: ${first.path}`);
    return true;
  });
});

test('Pinned verification drains an earlier read before reporting a later duplicate record', async t => {
  const directory = await temporary(t);
  await cp(path.join(root, 'skills'), path.join(directory, 'skills'), { recursive: true });
  const lock = JSON.parse(await text(path.join(root, 'third-party-skills.lock.json')));
  const first = lock.components[0].files[0];
  lock.components[0].files[1] = { ...first };
  await writeFile(path.join(directory, 'third-party-skills.lock.json'), JSON.stringify(lock));
  const originalReadFile = fs.readFile;
  const started = Promise.withResolvers(), release = Promise.withResolvers();
  let finished = false, settled = false;
  const readSpy = t.mock.method(fs, 'readFile', async (filename, ...args) => {
    if (filename !== path.join(directory, first.path)) return originalReadFile(filename, ...args);
    started.resolve();
    await release.promise;
    try { return await originalReadFile(filename, ...args); }
    finally { finished = true; }
  });
  syncBuiltinESMExports();
  const outcome = verifyDefaultSkillPins(directory).then(
    value => { settled = true; return { value }; },
    error => { settled = true; return { error }; }
  );
  try {
    await started.promise;
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(settled, false, 'metadata rejection must wait for the held read');
    release.resolve();
    const { error } = await outcome;
    assert.equal(finished, true);
    assert.equal(error?.code, 'skill_integrity');
    assert.equal(error.message, `Default skill integrity: invalid file record: ${lock.components[0].id}`);
  } finally {
    release.resolve(); await outcome;
    readSpy.mock.restore(); syncBuiltinESMExports();
  }
});
