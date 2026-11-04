import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, rename } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { planAffected } from '../runtime/ci-graph.mjs';

const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true }).trim();
async function put(root, file, text) { await mkdir(path.dirname(path.join(root, file)), { recursive: true }); await writeFile(path.join(root, file), text); }
async function fixture(t, extra = {}) {
  const project = await mkdtemp(path.join(os.tmpdir(), 'kodo-graph-'));
  t.after(() => rm(project, { recursive: true, force: true }));
  git(project, 'init', '-q'); git(project, 'config', 'user.email', 'fixture@example.invalid'); git(project, 'config', 'user.name', 'Fixture');
  const files = { 'package.json': '{"type":"module"}', 'src/value.mjs': 'export const value = 1;', 'src/bridge.mjs': "export {value} from './value.mjs';", 'tests/value.test.mjs': "import {value} from '../src/bridge.mjs';", 'tests/other.test.mjs': 'export const other = true;', ...extra };
  for (const [file, text] of Object.entries(files)) await put(project, file, text);
  const commit = () => { git(project, 'add', '-A'); git(project, 'commit', '-qm', 'fixture'); return git(project, 'rev-parse', 'HEAD'); };
  return { project, commit, baseSha: commit() };
}

test('Affected graph follows transitive re-exports and excludes independent tests deterministically', async t => {
  const fx = await fixture(t); await put(fx.project, 'src/value.mjs', 'export const value = 2;'); const headSha = fx.commit();
  const input = { ...fx, headSha }, plan = await planAffected(input);
  assert.equal(plan.fallback, false); assert.deepEqual(plan.testFiles, ['tests/value.test.mjs']);
  assert.deepEqual(plan.affectedFiles, ['src/bridge.mjs', 'src/value.mjs', 'tests/value.test.mjs']);
  assert.deepEqual(await planAffected(input), plan); assert.match(plan.sourceHash, /^[a-f0-9]{64}$/); assert.match(plan.dependencyHash, /^[a-f0-9]{64}$/);
});

test('Affected graph parses literal dynamic imports require and workspace package boundaries', async t => {
  const fx = await fixture(t, {
    'packages/lib/package.json': '{"name":"@fixture/lib","exports":"./entry.mjs"}',
    'packages/lib/entry.mjs': "export {value} from './value.mjs';", 'packages/lib/value.mjs': 'export const value = 1;',
    'packages/app/package.json': '{"name":"@fixture/app","dependencies":{"@fixture/lib":"*","acorn":"8.15.0"}}',
    'packages/app/bridge.cjs': "const builtin = require('node:path'); const parser = require('acorn'); module.exports = require('@fixture/lib');",
    'tests/workspace.test.mjs': "await import('../packages/app/bridge.cjs');"
  });
  await put(fx.project, 'packages/lib/value.mjs', 'export const value = 2;');
  const plan = await planAffected({ ...fx, headSha: fx.commit() });
  assert.equal(plan.fallback, false); assert.deepEqual(plan.testFiles, ['tests/workspace.test.mjs']);
});

test('Affected graph retains old reverse edges for deleted and renamed files', async t => {
  const fx = await fixture(t); await rename(path.join(fx.project, 'src/value.mjs'), path.join(fx.project, 'src/moved.mjs'));
  await put(fx.project, 'src/bridge.mjs', "export {value} from './moved.mjs';");
  let headSha = fx.commit(), plan = await planAffected({ ...fx, headSha });
  assert.ok(plan.changedFiles.includes('src/value.mjs')); assert.ok(plan.changedFiles.includes('src/moved.mjs'));
  assert.ok(plan.testFiles.includes('tests/value.test.mjs'));
  await rm(path.join(fx.project, 'src/moved.mjs')); headSha = fx.commit();
  plan = await planAffected({ ...fx, headSha }); assert.equal(plan.fallback, true);
  assert.deepEqual(plan.testFiles, ['tests/other.test.mjs', 'tests/value.test.mjs']); assert.ok(plan.reasons.some(reason => reason.includes('unresolved')));
});

test('Affected graph fails broad for computed dependencies unsupported syntax and undeclared imports', async t => {
  for (const [file, source, reason] of [
    ['src/value.mjs', 'await import(process.env.MODULE);', 'dynamic-dependency'],
    ['src/value.mjs', 'require(process.env.MODULE);', 'dynamic-dependency'],
    ['src/value.mjs', "import 'missing-package';", 'unresolved'],
    ['src/value.ts', 'export const value: number = 2;', 'unsupported-syntax'],
    ['src/value.mjs', 'export const broken = ;', 'parse-error']
  ]) {
    const fx = await fixture(t); await put(fx.project, file, source);
    const plan = await planAffected({ ...fx, headSha: fx.commit() });
    assert.equal(plan.fallback, true); assert.ok(plan.testFiles.includes('tests/other.test.mjs'));
    assert.ok(plan.reasons.some(value => value.includes(reason)), JSON.stringify(plan.reasons));
  }
});

test('Affected graph config lock CI and public entry changes invalidate narrow plans', async t => {
  for (const file of ['unknown.config.json', 'unknown.config.mjs', 'package-lock.json', '.github/workflows/ci.yml', 'src/public.mjs']) {
    const fx = await fixture(t, { 'package.json': '{"type":"module","exports":"./src/public.mjs"}', 'src/public.mjs': 'export const api = 1;' });
    await put(fx.project, file, file.endsWith('.mjs') ? 'export const api = 2;' : '{}');
    const plan = await planAffected({ ...fx, headSha: fx.commit() });
    assert.equal(plan.fallback, true); assert.ok(plan.testFiles.includes('tests/other.test.mjs')); assert.ok(plan.reasons.length);
  }
});

test('Affected graph never trusts incomplete changed paths or a dirty tree', async t => {
  const fx = await fixture(t); await put(fx.project, 'src/value.mjs', 'export const value = 2;'); const headSha = fx.commit();
  const plan = await planAffected({ ...fx, headSha, changedPaths: [] }); assert.ok(plan.testFiles.includes('tests/value.test.mjs'));
  await put(fx.project, 'untracked.mjs', 'export const surprise = true;');
  const dirty = await planAffected({ ...fx, headSha }); assert.equal(dirty.fallback, true); assert.ok(dirty.reasons.includes('dirty-worktree'));
  await assert.rejects(() => planAffected({ ...fx, headSha, changedPaths: ['../escape'] }), /path/i);
});

test('Affected graph recognizes node-only builtins and fails broad on runtime file and process dependencies', async t => {
  const fx = await fixture(t, { 'tests/value.test.mjs': "import test from 'node:test'; import '../src/bridge.mjs';" });
  await put(fx.project, 'src/value.mjs', 'export const value = 2;'); let headSha = fx.commit();
  assert.equal((await planAffected({ ...fx, headSha })).fallback, false);
  await put(fx.project, 'tests/other.test.mjs', "import {readFile} from 'node:fs/promises'; await readFile(new URL('../src/value.mjs', import.meta.url));");
  headSha = fx.commit(); const plan = await planAffected({ ...fx, headSha });
  assert.equal(plan.fallback, true); assert.ok(plan.testFiles.includes('tests/other.test.mjs'));
  assert.ok(plan.reasons.some(reason => reason.includes('runtime-dependency')));
});

test('Affected graph requires the repository root and ignores relative diff configuration', async t => {
  const fx = await fixture(t); await put(fx.project, 'src/value.mjs', 'export const value = 2;'); const headSha = fx.commit();
  git(fx.project, 'config', 'diff.relative', 'true');
  const plan = await planAffected({ ...fx, headSha }); assert.deepEqual(plan.testFiles, ['tests/value.test.mjs']);
  await assert.rejects(() => planAffected({ ...fx, project: path.join(fx.project, 'src'), headSha }), /root/i);
});

test('Affected graph cannot narrow tests in a project with unsupported source languages', async t => {
  const fx = await fixture(t, { 'bridge.py': 'import subprocess\nsubprocess.run(["node", "src/value.mjs"])\n' });
  await put(fx.project, 'src/value.mjs', 'export const value = 2;');
  const plan = await planAffected({ ...fx, headSha: fx.commit() });
  assert.equal(plan.fallback, true); assert.ok(plan.reasons.includes('unsupported-syntax:bridge.py')); assert.ok(plan.testFiles.includes('tests/other.test.mjs'));
});
