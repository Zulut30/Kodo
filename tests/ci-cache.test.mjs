import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, readdir, rm, symlink, link, chmod } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { planAffected } from '../runtime/ci-graph.mjs';
import { cacheFingerprint, readCheckCache, writeCheckCache } from '../runtime/ci-cache.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true }).trim();
async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'kodo-cache-')), project = path.join(root, 'project'), home = path.join(root, 'private');
  const { mkdir } = await import('node:fs/promises'); await mkdir(project);
  t.after(() => rm(root, { recursive: true, force: true }));
  git(project, 'init', '-q'); git(project, 'config', 'user.email', 'fixture@example.invalid'); git(project, 'config', 'user.name', 'Fixture');
  await writeFile(path.join(project, 'value.mjs'), 'export const value = 1;');
  git(project, 'add', '-A'); git(project, 'commit', '-qm', 'fixture');
  const headSha = git(project, 'rev-parse', 'HEAD'), plan = await planAffected({ project, headSha, baseSha: headSha });
  const input = { project, headSha, sourceHash: plan.sourceHash, dependencyHash: plan.dependencyHash, lockHash: hash('[]'),
    runtimeVersions: { node: process.versions.node, v8: process.versions.v8, modules: process.versions.modules }, toolVersions: { node: process.versions.node },
    platform: process.platform, arch: process.arch, command: process.execPath, args: ['--test'], envHash: hash('{}'), gateConfig: {}, kind: 'test' };
  const evidence = path.join(root, 'output.txt'); await writeFile(evidence, 'tests passed\n');
  const fingerprint = cacheFingerprint(input), receipt = { kind: 'test', status: 'passed', exitCode: 0, complete: true, headSha,
    command: input.command, args: input.args, evidence: [{ path: evidence, bytes: 13, sha256: hash('tests passed\n') }] };
  return { root, project, home, headSha, input, fingerprint, receipt };
}

test('Command cache first run misses and exact successful complete private receipt can be reused', async t => {
  const fx = await fixture(t); assert.equal(await readCheckCache(fx), null);
  assert.equal(await writeCheckCache(fx), true);
  const result = await readCheckCache(fx); assert.equal(result.exitCode, 0); assert.equal(result.headSha, fx.headSha);
  assert.equal(result.trust, 'private-local'); assert.equal(result.complete, true);
});

test('Command cache requires freshly supplied complete context on every read', async t => {
  const fx = await fixture(t); assert.equal(await writeCheckCache(fx), true);
  const { input, ...withoutContext } = fx;
  assert.equal(await readCheckCache(withoutContext), null);
  for (const patch of [{ envHash: hash('new-env') }, { toolVersions: { node: 'different' } }, { gateConfig: { required: true } }]) {
    assert.equal(await readCheckCache({ ...fx, input: { ...input, ...patch } }), null);
  }
  assert.equal((await readCheckCache(fx)).exitCode, 0);
});

test('Command cache fingerprints invalidate source dependency lock HEAD runtime tools arguments environment and gates', async t => {
  const fx = await fixture(t);
  for (const patch of [{ sourceHash: hash('source') }, { dependencyHash: hash('dep') }, { lockHash: hash('lock') }, { headSha: 'a'.repeat(40) },
    { runtimeVersions: { ...fx.input.runtimeVersions, node: '0.0.0' } }, { toolVersions: { node: '0.0.0' } }, { platform: 'other' }, { arch: 'other' },
    { args: ['--test', 'different.test.mjs'] }, { envHash: hash('env') }, { gateConfig: { security: true } }]) {
    const changed = cacheFingerprint({ ...fx.input, ...patch }); assert.notEqual(changed, fx.fingerprint); assert.equal(await readCheckCache({ ...fx, fingerprint: changed }), null);
  }
  const reordered = Object.fromEntries(Object.entries(fx.input).reverse()); assert.equal(cacheFingerprint(reordered), fx.fingerprint);
  for (const key of ['sourceHash', 'dependencyHash', 'lockHash', 'runtimeVersions', 'toolVersions', 'args', 'envHash', 'gateConfig', 'headSha']) {
    const missing = { ...fx.input }; delete missing[key]; assert.throws(() => cacheFingerprint(missing), /fingerprint/i);
  }
});

test('Command cache rejects failures missing evidence gates unknown and public trust', async t => {
  const fx = await fixture(t);
  for (const patch of [{ exitCode: 1 }, { status: 'unknown' }, { complete: false }, { evidence: [] }, { kind: 'ui' }, { kind: 'security' }, { kind: 'unknown' }, { trust: 'public' }, { headSha: 'a'.repeat(40) }, { args: ['different'] }]) {
    assert.equal(await writeCheckCache({ ...fx, receipt: { ...fx.receipt, ...patch } }), false);
  }
  assert.equal(await readCheckCache(fx), null);
  assert.equal(await writeCheckCache({ ...fx, trust: 'public' }), false);
});

test('Command cache detects tampered envelope missing output and changed output bytes', async t => {
  const fx = await fixture(t); assert.equal(await writeCheckCache(fx), true);
  const directory = path.join(fx.home, 'ci-check-cache-v1'), file = path.join(directory, (await readdir(directory)).find(name => name.endsWith('.json')));
  const original = await readFile(file, 'utf8'), envelope = JSON.parse(original); envelope.receipt.exitCode = 9;
  await writeFile(file, JSON.stringify(envelope)); assert.equal(await readCheckCache(fx), null);
  await writeFile(file, original); await writeFile(fx.receipt.evidence[0].path, 'other output\n'); assert.equal(await readCheckCache(fx), null);
  await rm(fx.receipt.evidence[0].path); assert.equal(await readCheckCache(fx), null);
});

test('Command cache dirty tree wrong current HEAD runtime and forged hashes cannot pass', async t => {
  const fx = await fixture(t); assert.equal(await writeCheckCache(fx), true);
  await writeFile(path.join(fx.project, 'value.mjs'), 'export const value = 2;'); assert.equal(await readCheckCache(fx), null); assert.equal(await writeCheckCache(fx), false);
  git(fx.project, 'add', '-A'); git(fx.project, 'commit', '-qm', 'new head'); assert.equal(await readCheckCache(fx), null);
  git(fx.project, 'reset', '--hard', fx.headSha);
  for (const patch of [{ runtimeVersions: { ...fx.input.runtimeVersions, node: '0.0.0' } }, { sourceHash: hash('fake') }, { dependencyHash: hash('fake') }, { lockHash: hash('fake') }]) {
    const input = { ...fx.input, ...patch }, fingerprint = cacheFingerprint(input); assert.equal(await writeCheckCache({ ...fx, input, fingerprint }), false);
  }
});

test('Command cache rechecks dirty untracked files after a successful write', async t => {
  const fx = await fixture(t); assert.equal(await writeCheckCache(fx), true);
  await writeFile(path.join(fx.project, 'surprise.mjs'), 'export const surprise = true;');
  assert.equal(await readCheckCache(fx), null); assert.equal(await writeCheckCache(fx), false);
});

test('Command cache rejects repository storage symlink home hardlinked output and public envelopes', async t => {
  const fx = await fixture(t);
  assert.equal(await writeCheckCache({ ...fx, home: path.join(fx.project, 'cache') }), false);
  const alias = path.join(fx.root, 'alias'); await symlink(fx.root, alias, process.platform === 'win32' ? 'junction' : 'dir');
  assert.equal(await writeCheckCache({ ...fx, home: path.join(alias, 'private') }), false);
  await link(fx.receipt.evidence[0].path, path.join(fx.root, 'hardlink')); assert.equal(await writeCheckCache(fx), false);
  await rm(path.join(fx.root, 'hardlink')); assert.equal(await writeCheckCache(fx), true);
  const file = path.join(fx.home, 'ci-check-cache-v1', fx.fingerprint + '.json'); const envelope = JSON.parse(await readFile(file, 'utf8'));
  envelope.trust = 'public'; await writeFile(file, JSON.stringify(envelope)); assert.equal(await readCheckCache(fx), null);
});

test('Command cache refuses receipt permissions widened after a successful write', async t => {
  const fx = await fixture(t); assert.equal(await writeCheckCache(fx), true);
  const file = path.join(fx.home, 'ci-check-cache-v1', fx.fingerprint + '.json');
  if (process.platform === 'win32') execFileSync('icacls.exe', [file, '/grant', '*S-1-1-0:R'], { windowsHide: true, stdio: 'pipe' });
  else await chmod(file, 0o644);
  assert.equal(await readCheckCache(fx), null);
});
