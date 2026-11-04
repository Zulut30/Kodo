import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, rename, realpath, symlink, link, open } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { inspectCurrentSource, planAffected } from '../runtime/ci-graph.mjs';
import { runCi } from '../runtime/ci-cli.mjs';
import { execute } from '../runtime/command.mjs';

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

test('Shared inspector extraction preserves exact CI fallback reasons for loader aliases and export uncertainty', async t => {
  for (const source of ['const load = require; load(name);', "import { createRequire as load } from 'node:module';", 'eval(source);', 'new Function(source);', 'require.resolve(name);']) {
    const fx = await fixture(t); await put(fx.project, 'src/value.mjs', source);
    const result = await planAffected({ ...fx, headSha: fx.commit() });
    assert.ok(result.reasons.includes('dynamic-dependency:src/value.mjs'));
    assert.ok(result.fallback); assert.ok(result.testFiles.includes('tests/other.test.mjs'));
  }
  const fx = await fixture(t, { 'src/bridge.mjs': "export * from './value.mjs';", 'old.cjs': 'module.exports = 1;' });
  await put(fx.project, 'src/value.mjs', 'export const value = 2;');
  const result = await planAffected({ ...fx, headSha: fx.commit() });
  assert.equal(result.fallback, false); assert.deepEqual(result.reasons, []);
  assert.deepEqual(result.testFiles, ['tests/value.test.mjs']);
});

test('Affected graph includes exact test basenames discovered by default Node runner', async t => {
  for (const extension of ['js', 'mjs', 'cjs']) await t.test(`test.${extension}`, async t => {
    const file = `test.${extension}`;
    const source = extension === 'cjs'
      ? "const {test} = require('node:test'); const assert = require('node:assert/strict'); const {value} = require('./src/value.mjs');"
      : "import {test} from 'node:test'; import assert from 'node:assert/strict'; import {value} from './src/value.mjs';";
    const fx = await fixture(t, { [file]: `${source}\ntest('exact basename assertion', () => assert.equal(value, 1));` });
    // Nested runners must not inherit the parent node:test IPC context.
    const env = { ...process.env }; delete env.NODE_TEST_CONTEXT;
    const discover = () => spawnSync(process.execPath, ['--test', '--test-reporter=tap'], { cwd: fx.project, env, encoding: 'utf8', windowsHide: true });
    const before = discover(); assert.equal(before.status, 0, before.stderr + before.stdout);
    assert.match(before.stdout, /ok \d+ - exact basename assertion/);
    await put(fx.project, 'src/value.mjs', 'export const value = 2;'); const headSha = fx.commit();
    const after = discover(); assert.equal(after.status, 1, after.stderr + after.stdout);
    assert.match(after.stdout, /not ok \d+ - exact basename assertion/);
    const plan = await planAffected({ ...fx, headSha });
    assert.equal(plan.fallback, false); assert.deepEqual(plan.reasons, []);
    assert.ok(plan.affectedFiles.includes(file));
    assert.deepEqual(plan.testFiles, [file, 'tests/value.test.mjs']);
  });
});

test('L1 runs exact basename affected test and rejects its real failing assertion', async t => {
  const fx = await fixture(t, { 'test.mjs': "import {test} from 'node:test'; import assert from 'node:assert/strict'; import {value} from './src/value.mjs'; test('L1 exact basename assertion', () => assert.equal(value, 1));" });
  await put(fx.project, 'src/value.mjs', 'export const value = 2;'); fx.commit();
  const calls = [];
  const result = await runCi({ project: fx.project, baseSha: fx.baseSha, tier: 'L1' }, {
    qualityRegistry: { detect: async () => ({ files: ['src/value.mjs', 'src/bridge.mjs', 'test.mjs', 'tests/value.test.mjs'].map(path => ({ path })) }), plan: async () => ({}) },
    runQuality: async () => ({ status: 'not_applicable', receipts: [{ status: 'not_applicable' }] }),
    execute: async (command, args, options) => {
      const env = { ...options.env }; delete env.NODE_TEST_CONTEXT;
      const observation = await execute(command, args, { ...options, env });
      calls.push({ command, args, ...observation }); return observation;
    }
  });
  assert.equal(result.complete, false, 'L1 must not accept a failing default-discovered test');
  assert.equal(result.status, 'failed'); assert.equal(result.graph.fallback, false);
  assert.deepEqual(result.graph.testFiles, ['test.mjs', 'tests/value.test.mjs']);
  const receipt = result.receipts.find(row => row.phase === 'tests');
  assert.equal(receipt?.status, 'failed'); assert.equal(receipt.exitCode, 1);
  const testCall = calls.find(row => row.args[0] === '--test');
  assert.equal(testCall.command, process.execPath);
  assert.deepEqual(testCall.args, ['--test', 'test.mjs', 'tests/value.test.mjs']);
  assert.match(testCall.stdout, /L1 exact basename assertion/);
  assert.match(testCall.stdout, /2 !== 1/);
});

test('Affected graph preserves test naming conventions paths and fallback inventory', async t => {
  const names = ['nested space #/test.mjs', 'nested/test.js', 'nested/test.cjs', 'tests/value_test.js', 'tests/value-spec.cjs', 'tests/test-value.mjs', 'test/helper.js', '__tests__/helper.mjs'];
  const extras = Object.fromEntries([...names, 'nested/tester.mjs', 'nested/contest.js', 'nested/test.json'].map(file => [file, file.endsWith('.json') ? '{}' : file.endsWith('.cjs') ? "require('../src/value.mjs');" : "import '../src/value.mjs';"]));
  const fx = await fixture(t, extras); await put(fx.project, 'src/value.mjs', 'export const value = 2;');
  const narrow = await planAffected({ ...fx, headSha: fx.commit() });
  const expected = [...names, 'tests/value.test.mjs'].sort();
  assert.equal(narrow.fallback, false); assert.deepEqual(narrow.testFiles, expected);
  await put(fx.project, 'unknown.config.json', '{}');
  const broad = await planAffected({ ...fx, headSha: fx.commit() });
  assert.equal(broad.fallback, true); assert.deepEqual(broad.testFiles, [...expected, 'tests/other.test.mjs'].sort());
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

test('Affected graph accepts a real Windows case alias for the repository root', { skip: process.platform !== 'win32' }, async t => {
  const fx = await fixture(t); await put(fx.project, 'src/value.mjs', 'export const value = 2;'); const headSha = fx.commit();
  const physical = await realpath(fx.project), alias = path.join(path.dirname(physical), path.basename(physical).toUpperCase());
  assert.notEqual(alias, physical); assert.equal(await realpath(alias), physical);
  const gitRoot = path.resolve(git(alias, 'rev-parse', '--show-toplevel'));
  assert.notEqual(gitRoot, alias, 'real Git must expose the lexical root mismatch');
  assert.equal(await realpath(gitRoot), physical);
  t.diagnostic(JSON.stringify({ alias, physical, gitRoot }));
  const plan = await planAffected({ ...fx, project: alias, headSha });
  assert.equal(plan.fallback, false); assert.deepEqual(plan.reasons, []);
  assert.deepEqual(plan.testFiles, ['tests/value.test.mjs']);
  assert.deepEqual(plan.affectedFiles, ['src/bridge.mjs', 'src/value.mjs', 'tests/value.test.mjs']);
  assert.deepEqual(plan, await planAffected({ ...fx, project: physical, headSha }));
});

test('Affected graph accepts an available real Windows short path for the repository root', { skip: process.platform !== 'win32' }, async t => {
  const fx = await fixture(t); await put(fx.project, 'src/value.mjs', 'export const value = 2;'); const headSha = fx.commit();
  // Ask Windows for an existing 8.3 name; do not invent an alias or mock Git.
  const alias = execFileSync('cmd.exe', ['/d', '/c', 'for %I in ("%KODO_GRAPH_ALIAS_ROOT%") do @echo %~sI'], {
    encoding: 'utf8', windowsHide: true, windowsVerbatimArguments: true, env: { ...process.env, KODO_GRAPH_ALIAS_ROOT: fx.project }
  }).trim();
  const physical = await realpath(fx.project);
  if (!alias.includes('~') || alias === physical) { t.skip('Filesystem did not supply an 8.3 alias'); return; }
  assert.equal(await realpath(alias), physical);
  const gitRoot = path.resolve(git(alias, 'rev-parse', '--show-toplevel'));
  assert.notEqual(gitRoot, alias, 'real Git must expand the short path');
  assert.equal(await realpath(gitRoot), physical);
  t.diagnostic(JSON.stringify({ alias, physical, gitRoot }));
  const plan = await planAffected({ ...fx, project: alias, headSha });
  assert.equal(plan.fallback, false); assert.deepEqual(plan.reasons, []);
  assert.deepEqual(plan.testFiles, ['tests/value.test.mjs']);
  assert.deepEqual(plan.affectedFiles, ['src/bridge.mjs', 'src/value.mjs', 'tests/value.test.mjs']);
  assert.deepEqual(plan, await planAffected({ ...fx, project: physical, headSha }));
});

test('Affected graph rejects a linked root and linked ancestor before resolving physical paths', async t => {
  const fx = await fixture(t), wrapper = await mkdtemp(path.join(os.tmpdir(), 'kodo-graph-links-'));
  t.after(() => rm(wrapper, { recursive: true, force: true }));
  const link = path.join(wrapper, 'repository');
  await symlink(fx.project, link, process.platform === 'win32' ? 'junction' : 'dir');
  assert.equal(await realpath(link), await realpath(fx.project));
  await assert.rejects(() => planAffected({ ...fx, project: link }), /Unsafe symlink installation path/);
  await assert.rejects(() => planAffected({ ...fx, project: path.join(link, 'src') }), /Unsafe symlink installation path/);
});

test('Affected graph rejects an outside directory without a repository', async t => {
  const fx = await fixture(t), outside = await mkdtemp(path.join(os.tmpdir(), 'kodo-graph-outside-'));
  t.after(() => rm(outside, { recursive: true, force: true }));
  await assert.rejects(() => planAffected({ ...fx, project: outside }), /not a git repository/i);
});

test('Affected graph retains immutable object snapshots and current head and dirty guards', async t => {
  const fx = await fixture(t), base = await planAffected(fx);
  await put(fx.project, 'src/value.mjs', 'export const value = 2;'); const headSha = fx.commit();
  const stale = await planAffected({ ...fx, headSha: fx.baseSha });
  assert.equal(stale.fallback, true); assert.deepEqual(stale.reasons, ['head-mismatch']);
  assert.equal(stale.sourceHash, base.sourceHash); assert.equal(stale.dependencyHash, base.dependencyHash);
  const clean = await planAffected({ ...fx, headSha });
  await put(fx.project, 'src/value.mjs', 'export const broken = ;');
  const dirty = await planAffected({ ...fx, headSha });
  assert.equal(dirty.fallback, true); assert.deepEqual(dirty.reasons, ['dirty-worktree']);
  assert.equal(dirty.sourceHash, clean.sourceHash); assert.equal(dirty.dependencyHash, clean.dependencyHash);
  assert.deepEqual(dirty.testFiles, ['tests/other.test.mjs', 'tests/value.test.mjs']);
});

test('Affected graph cannot narrow tests in a project with unsupported source languages', async t => {
  const fx = await fixture(t, { 'bridge.py': 'import subprocess\nsubprocess.run(["node", "src/value.mjs"])\n' });
  await put(fx.project, 'src/value.mjs', 'export const value = 2;');
  const plan = await planAffected({ ...fx, headSha: fx.commit() });
  assert.equal(plan.fallback, true); assert.ok(plan.reasons.includes('unsupported-syntax:bridge.py')); assert.ok(plan.testFiles.includes('tests/other.test.mjs'));
});

for (const flag of ['--assume-unchanged', '--skip-worktree']) test(`Affected graph detects tracked bytes hidden by ${flag}`, async t => {
  const fx = await fixture(t), clean = await planAffected(fx);
  const file = 'src/value.mjs', before = await readFile(path.join(fx.project, file));
  git(fx.project, 'update-index', flag, file);
  await put(fx.project, file, 'export const value = 9;');
  assert.equal(git(fx.project, 'status', '--porcelain=v1', '--untracked-files=all'), '', 'real Git hides the modification');
  assert.notDeepEqual(await readFile(path.join(fx.project, file)), before, 'actual bytes changed');
  assert.equal(git(fx.project, 'rev-parse', 'HEAD'), fx.baseSha);
  assert.equal(await inspectCurrentSource({ project: fx.project, headSha: fx.baseSha }), 'dirty');
  const plan = await planAffected(fx);
  assert.equal(plan.sourceHash, clean.sourceHash); assert.equal(plan.dependencyHash, clean.dependencyHash);
  assert.equal(plan.fallback, true, 'hidden tracked edits cannot permit narrow selection');
  assert.ok(plan.reasons.includes('dirty-worktree'));
  assert.deepEqual(plan.testFiles, ['tests/other.test.mjs', 'tests/value.test.mjs']);
});

test('Current source checks clean bytes CRLF checkout and binary bytes without project filters', async t => {
  const fx = await fixture(t, { 'crlf.txt': 'first line\nsecond line\n', 'binary.dat': Buffer.from([0, 255, 13, 10, 254]) });
  const input = { project: fx.project, headSha: fx.baseSha };
  assert.equal(await inspectCurrentSource(input), 'clean');
  const sourceHash = (await planAffected(input)).sourceHash;
  git(fx.project, 'update-index', '--skip-worktree', 'crlf.txt', 'binary.dat');
  await put(fx.project, 'crlf.txt', 'first line\r\nsecond line\r\n');
  assert.equal(git(fx.project, 'status', '--porcelain=v1', '--untracked-files=all'), '');
  assert.equal(await inspectCurrentSource(input), 'clean', 'ordinary lossless UTF8 CRLF checkout remains compatible');
  assert.equal((await planAffected(input)).sourceHash, sourceHash);
  await put(fx.project, 'binary.dat', Buffer.from([0, 255, 10, 254]));
  assert.equal(await inspectCurrentSource(input), 'dirty', 'invalid UTF8 cannot use text normalization');
  await put(fx.project, 'binary.dat', Buffer.from([0, 255, 13, 10, 254]));
  await put(fx.project, '.gitattributes', 'crlf.txt filter=tripwire\n'); fx.commit();
  const headSha = git(fx.project, 'rev-parse', 'HEAD');
  // A project filter would create this marker and fail if ever executed.
  git(fx.project, 'config', 'filter.tripwire.clean', 'echo called > filter-ran.txt; exit 1');
  git(fx.project, 'config', 'filter.tripwire.required', 'true');
  await put(fx.project, 'crlf.txt', 'different actual bytes\n');
  assert.equal(git(fx.project, 'status', '--porcelain=v1', '--untracked-files=all'), '');
  assert.equal(await inspectCurrentSource({ project: fx.project, headSha }), 'dirty');
  await assert.rejects(() => readFile(path.join(fx.project, 'filter-ran.txt')), { code: 'ENOENT' });
});

test('Current source status inspection never executes configured project clean filters', async t => {
  const fx = await fixture(t, { '.gitattributes': 'src/value.mjs filter=tripwire\n' });
  git(fx.project, 'config', 'filter.tripwire.clean', 'echo called > filter-ran.txt; exit 1');
  git(fx.project, 'config', 'filter.tripwire.required', 'true');
  await put(fx.project, 'src/value.mjs', 'export const value = 9;');
  const state = await inspectCurrentSource({ project: fx.project, headSha: fx.baseSha });
  await assert.rejects(() => readFile(path.join(fx.project, 'filter-ran.txt')), { code: 'ENOENT' });
  assert.equal(state, 'dirty');
  const plan = await planAffected({ project: fx.project, headSha: fx.baseSha });
  assert.equal(plan.fallback, true); assert.ok(plan.reasons.includes('dirty-worktree'));
  await assert.rejects(() => readFile(path.join(fx.project, 'filter-ran.txt')), { code: 'ENOENT' });
});

test('Current source fails closed for invalid inputs stale HEAD non-root and linked paths', async t => {
  const fx = await fixture(t), input = { project: fx.project, headSha: fx.baseSha };
  for (const invalid of [undefined, null, {}, { project: fx.project, headSha: 'HEAD' }, { project: fx.project, headSha: 'a'.repeat(40) }, { ...input, project: path.join(fx.project, 'src') }]) {
    const state = await inspectCurrentSource(invalid);
    assert.equal(state, invalid?.headSha === 'a'.repeat(40) ? 'dirty' : 'unknown');
  }
  await put(fx.project, 'src/value.mjs', 'export const value = 2;'); fx.commit();
  assert.equal(await inspectCurrentSource(input), 'dirty');
  const wrapper = await mkdtemp(path.join(os.tmpdir(), 'kodo-source-links-'));
  t.after(() => rm(wrapper, { recursive: true, force: true }));
  const alias = path.join(wrapper, 'alias'); await symlink(fx.project, alias, process.platform === 'win32' ? 'junction' : 'dir');
  assert.equal(await inspectCurrentSource({ ...input, project: alias }), 'unknown');
  assert.equal(await inspectCurrentSource({ ...input, project: path.join(alias, 'src') }), 'unknown');
  const current = { ...input, headSha: git(fx.project, 'rev-parse', 'HEAD') };
  await put(fx.project, 'untracked.txt', 'untracked');
  assert.equal(await inspectCurrentSource(current), 'dirty');
});

test('Current source uncertainty forces broad graph for missing nonregular linked and oversized tracked files', async t => {
  const fx = await fixture(t), input = { project: fx.project, headSha: fx.baseSha }, file = path.join(fx.project, 'src/value.mjs');
  git(fx.project, 'update-index', '--skip-worktree', 'src/value.mjs');
  const unknown = async () => {
    assert.equal(git(fx.project, 'status', '--porcelain=v1', '--untracked-files=all'), '');
    assert.equal(await inspectCurrentSource(input), 'unknown');
    const plan = await planAffected(input);
    assert.equal(plan.fallback, true); assert.ok(plan.reasons.includes('unknown-source'));
    assert.deepEqual(plan.testFiles, ['tests/other.test.mjs', 'tests/value.test.mjs']);
  };
  await rm(file); await unknown();
  await mkdir(file); await unknown(); await rm(file, { recursive: true });
  const external = path.join(await realpath(os.tmpdir()), `kodo-source-${path.basename(fx.project)}.mjs`);
  t.after(() => rm(external, { force: true })); await writeFile(external, 'export const value = 1;');
  await symlink(external, file, process.platform === 'win32' ? 'junction' : 'file');
  await unknown(); await rm(file);
  await link(external, file); await unknown(); await rm(file);
  const handle = await open(file, 'w'); await handle.truncate(16 * 1024 ** 2 + 1); await handle.close();
  await unknown();
});

test('Current source enforces total byte budget with individually bounded matching blobs', async t => {
  const extras = Object.fromEntries(Array.from({ length: 9 }, (_, i) => [`data-${i}.dat`, 'x']));
  const fx = await fixture(t, extras), input = { project: fx.project, headSha: fx.baseSha };
  // Matching objects keep the earlier byte checks clean; the ninth file alone
  // exceeds the total budget. No huge fixture is committed or checked out.
  const zero = Buffer.alloc(16 * 1024 ** 2);
  const oid = execFileSync('git', ['hash-object', '-w', '--stdin', '--no-filters'], { cwd: fx.project, input: zero, encoding: 'utf8', windowsHide: true }).trim();
  for (const [index, file] of Object.keys(extras).entries()) {
    const handle = await open(path.join(fx.project, file), 'w'); await handle.truncate(16 * 1024 ** 2); await handle.close();
    git(fx.project, 'update-index', '--cacheinfo', `100644,${oid},${file}`);
    git(fx.project, 'update-index', '--skip-worktree', file);
    if (index === 0) {
      git(fx.project, 'commit', '-qm', 'one bounded blob'); input.headSha = git(fx.project, 'rev-parse', 'HEAD');
      assert.equal(await inspectCurrentSource(input), 'clean', 'an exactly 16 MiB matching file is accepted');
    }
  }
  git(fx.project, 'commit', '-qm', 'bounded blobs'); input.headSha = git(fx.project, 'rev-parse', 'HEAD');
  assert.equal(git(fx.project, 'status', '--porcelain=v1', '--untracked-files=all'), '');
  assert.equal(await inspectCurrentSource(input), 'unknown');
});

test('Current source rejects unsupported immutable symlink and submodule modes', async t => {
  for (const mode of ['120000', '160000']) {
    const fx = await fixture(t), input = { project: fx.project, headSha: fx.baseSha };
    const file = 'src/value.mjs', target = mode === '160000' ? input.headSha : git(fx.project, 'rev-parse', `${input.headSha}:${file}`);
    git(fx.project, 'update-index', '--cacheinfo', `${mode},${target},${file}`);
    git(fx.project, 'update-index', '--skip-worktree', file);
    git(fx.project, 'commit', '-qm', 'unsupported mode'); input.headSha = git(fx.project, 'rev-parse', 'HEAD');
    assert.equal(git(fx.project, 'status', '--porcelain=v1', '--untracked-files=all'), '');
    assert.equal(await inspectCurrentSource(input), 'unknown');
    const plan = await planAffected(input);
    assert.equal(plan.fallback, true); assert.ok(plan.reasons.includes('unknown-source'));
    assert.ok(plan.reasons.includes('unsupported-tree-entry:src/value.mjs'));
  }
});
