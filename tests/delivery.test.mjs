import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, writeFile, copyFile, readdir, rm, chmod } from 'node:fs/promises';
import { constants } from 'node:fs';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import Ajv from 'ajv';
import { deliver, reconcileDelivery, prepareReleaseVersion, releasePackage, validateChecks, assertFreshRelease, execute } from '../runtime/delivery.mjs';

const digest = value => createHash('sha256').update(value).digest('hex');
const receiptSchema = {
  type: 'object', additionalProperties: false,
  required: ['version', 'tag', 'commit', 'url', 'artifact', 'artifactUrl', 'sha256', 'smoke', 'published'],
  properties: {
    version: { type: 'string', pattern: '^\\d+\\.\\d+\\.\\d+$' }, tag: { type: 'string', pattern: '^v\\d+\\.\\d+\\.\\d+$' },
    commit: { type: 'string', pattern: '^[a-f0-9]{40,64}$' }, url: { type: 'string', pattern: '^https://github\\.com/' },
    artifact: { type: 'string', pattern: '\\.tgz$' }, artifactUrl: { type: 'string', pattern: '^https://github\\.com/.+/releases/download/' },
    sha256: { type: 'string', pattern: '^[a-f0-9]{64}$' }, published: { const: true },
    smoke: { type: 'object', additionalProperties: false, required: ['passed', 'commands', 'node', 'platform'], properties: {
      passed: { const: true }, commands: { type: 'array', minItems: 1, items: { type: 'string' } }, node: { type: 'string' }, platform: { type: 'string' }
    } }
  }
};
const validateReceipt = new Ajv({ strict: true }).compile(receiptSchema);
async function fixture(t, { brokenCli = false } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'kodo-delivery-test-'));
  t.after(async () => {
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith('kodo-delivery-test-'));
    await rm(root, { recursive: true, force: true });
  });
  const project = path.join(root, 'project'), remote = path.join(root, 'remote.git');
  await mkdir(project);
  const git = async (...args) => (await execute('git', args, { cwd: project })).stdout.trim();
  await git('init', '--bare', remote);
  await git('init', '-b', 'main');
  await git('config', 'user.name', 'Kodo Test'); await git('config', 'user.email', 'kodo-test@example.invalid');
  await git('config', 'core.autocrlf', 'false');
  await writeFile(path.join(project, 'package.json'), JSON.stringify({ name: '@kodo-fixture/test', version: '0.1.0', type: 'module', bin: { kodo: 'cli.mjs' }, files: ['cli.mjs'] }));
  await writeFile(path.join(project, 'cli.mjs'), brokenCli ? "console.log('broken command');\n" : "const arg=process.argv[2]; console.log(arg==='list'?JSON.stringify([{id:'skills/example'}]):arg==='validate'?JSON.stringify({valid:true}):'Kodo fixture help');\n");
  await git('add', '.'); await git('commit', '-m', 'base'); await git('remote', 'add', 'origin', remote); await git('push', '-u', 'origin', 'main');
  const baseSha = await git('rev-parse', 'HEAD');
  await git('switch', '-c', 'kodo/test-run'); await writeFile(path.join(project, 'feature.txt'), 'feature\n');
  const featureManifest = JSON.parse(await readFile(path.join(project, 'package.json'), 'utf8')); featureManifest.version = '0.2.0';
  await writeFile(path.join(project, 'package.json'), JSON.stringify(featureManifest));
  await git('add', '.'); await git('commit', '-m', 'feature');
  const headSha = await git('rev-parse', 'HEAD');
  const run = { id: 'run-test', project, branch: 'kodo/test-run', task: 'Implement tested feature', baseSha, headSha, releaseAssignment: { version: '0.2.0', previousVersion: '0.1.0', baseSha, prepared: true } };
  const review = { passed: true, headSha, diffHash: digest((await execute('git', ['diff', '--binary', `${baseSha}...${headSha}`], { cwd: project })).stdout.trimEnd()) };
  const leases = new Map(), updates = [], events = [], calls = [];
  const store = {
    acquireLease(name, owner) { if (leases.has(name)) return null; const token = `${name}:${owner}`; leases.set(name, token); return token; },
    releaseLease(token) { for (const [name, value] of leases) if (value === token) leases.delete(name); },
    updateRun(id, patch) { assert.equal(id, run.id); updates.push(structuredClone(patch)); Object.assign(run, patch); },
    event(id, type, data) { events.push({ id, type, data }); }
  };
  const state = { pr: null, creates: 0, merges: 0, check: 'SUCCESS', protected: true, release: null, releaseCreates: 0, uploads: 0, publishes: 0, status: null };
  const assets = path.join(root, 'published'); await mkdir(assets);
  const exec = async (command, args, options) => {
    calls.push({ command, args });
    if (command !== 'gh') return execute(command, args, options);
    const output = value => ({ stdout: typeof value === 'string' ? value : JSON.stringify(value), stderr: '', code: 0 });
    if (args[0] === 'api' && args[1]?.startsWith('repos/')) return output({ required_status_checks: { strict: state.protected, contexts: ['ci', 'kodo/review'] }, enforce_admins: { enabled: true } });
    if (args[0] === 'api' && args.includes('POST')) { state.status = 'SUCCESS'; return output({ state: 'success' }); }
    if (args[0] === 'pr' && args[1] === 'list') return output(state.pr ? [state.pr] : []);
    if (args[0] === 'pr' && args[1] === 'create') {
      const body = await readFile(args[args.indexOf('--body-file') + 1], 'utf8');
      assert.match(body, /<!-- kodo-run:run-test -->/); assert.match(body, /Diff SHA-256/);
      state.creates++; state.pr = { number: 7, url: 'https://github.com/test/kodo/pull/7', state: 'OPEN' }; return output(state.pr.url);
    }
    if (args[0] === 'pr' && args[1] === 'view') return output({ ...state.pr, headRefOid: state.prHead ?? headSha, baseRefName: 'main', baseRefOid: state.prBase ?? run.baseSha, mergeCommit: state.pr?.state === 'MERGED' ? { oid: state.mergeCommit ?? headSha } : null, statusCheckRollup: state.noChecks ? [] : [{ name: 'ci', conclusion: state.check }, { context: 'kodo/review', state: state.status ?? 'PENDING' }] });
    if (args[0] === 'pr' && args[1] === 'merge') {
      assert.ok(args.includes('--match-head-commit')); assert.ok(!args.includes('--admin'));
      if (config.delivery.release) assert.ok(leases.has('release:test/kodo:main'));
      state.mergeCommit = state.squashMerge ? await git('commit-tree', await git('rev-parse', 'HEAD^{tree}'), '-p', baseSha, '-m', 'Genuine GitHub-style squash merge') : headSha;
      state.merges++; state.pr.state = 'MERGED'; await git('push', 'origin', `${state.mergeCommit}:main`); return output('');
    }
    if (args[0] === 'release' && args[1] === 'list') {
      const available = state.releaseList ?? (state.release ? [{ tagName: state.release.tag, isDraft: Boolean(state.release.isDraft), isPrerelease: Boolean(state.release.isPrerelease) }] : []);
      return output(available.slice(0, Number(args[args.indexOf('--limit') + 1])));
    }
    if (args[0] === 'release' && args[1] === 'create') {
      state.releaseCreates++;
      const tag = args[2], artifact = args[3], sums = args[4];
      assert.equal(args[args.indexOf('--target') + 1], headSha);
      assert.ok(!args.includes('--clobber'));
      assert.ok(args.includes('--latest=false'));
      await copyFile(artifact, path.join(assets, path.basename(artifact))); await copyFile(sums, path.join(assets, 'SHA256SUMS'));
      const isDraft = args.includes('--draft');
      if (!isDraft) { state.publishes++; await git('tag', tag, headSha); await git('push', 'origin', tag); }
      const body = await readFile(args[args.indexOf('--notes-file') + 1], 'utf8');
      state.release = { tag, filename: path.basename(artifact), url: `https://github.com/test/kodo/releases/tag/${tag}`, isDraft, body, targetCommitish: headSha };
      return output(state.release.url);
    }
    if (args[0] === 'release' && args[1] === 'view') return output({ tagName: state.release.tag, url: state.release.url, assets: (await readdir(assets)).map(name => ({ name })), isDraft: Boolean(state.release.isDraft), isPrerelease: Boolean(state.release.isPrerelease), body: state.release.body ?? '', targetCommitish: state.release.targetCommitish ?? headSha });
    if (args[0] === 'release' && args[1] === 'upload') {
      assert.ok(!args.includes('--clobber'));
      state.uploads++;
      await copyFile(args[3], path.join(assets, path.basename(args[3])), constants.COPYFILE_EXCL); return output('');
    }
    if (args[0] === 'release' && args[1] === 'edit') {
      assert.ok(args.includes('--draft=false') || args.includes('--draft')); assert.ok(args.includes('--latest=false'));
      assert.equal(args[args.indexOf('--target') + 1], headSha);
      if (args.includes('--notes-file')) state.release.body = await readFile(args[args.indexOf('--notes-file') + 1], 'utf8');
      if (state.release.isDraft && args.includes('--draft=false')) {
        const current = await execute('git', ['rev-parse', '--verify', `refs/tags/${state.release.tag}^{commit}`], { cwd: project, allowFailure: true });
        if (current.code) await git('tag', state.release.tag, headSha);
        else assert.equal(current.stdout.trim(), headSha);
        await git('push', 'origin', state.release.tag);
        state.publishes++; state.release.isDraft = false;
      }
      return output('');
    }
    if (args[0] === 'release' && args[1] === 'download') {
      const filename = args[args.indexOf('--pattern') + 1], directory = args[args.indexOf('--dir') + 1];
      await copyFile(path.join(assets, filename), path.join(directory, filename)); return output('');
    }
    throw new Error(`Unexpected fake GitHub command: ${args.join(' ')}`);
  };
  const config = { repository: 'test/kodo', baseBranch: 'main', checks: ['ci'], commands: { test: [], build: [] }, delivery: { enabled: true, release: true, firstVersion: '0.2.0' } };
  return { root, project, remote, git, run, review, store, state, calls, leases, updates, events, config, exec, maxWaitMs: 0, pollMs: 1, cwd: project, assets };
}

test('Delivery checks require success and reject skipped missing duplicate and failed checks', () => {
  assert.deepEqual(validateChecks([{ name: 'ci', conclusion: 'SUCCESS' }], ['ci']), { ready: true, missing: [], pending: [], failed: [] });
  assert.equal(validateChecks([{ name: 'ci', conclusion: 'SKIPPED' }], ['ci']).ready, false);
  assert.deepEqual(validateChecks([], ['ci']).missing, ['ci']);
  assert.deepEqual(validateChecks([{ name: 'ci', status: 'IN_PROGRESS' }], ['ci']).pending, ['ci']);
  assert.deepEqual(validateChecks([{ name: 'ci', conclusion: 'FAILURE' }, { name: 'ci', conclusion: 'SUCCESS' }], ['ci']).failed, ['ci']);
  assert.throws(() => validateChecks([], []), { code: 'configuration' });
});

test('Release freshness requires ancestry and excludes equal newer or backward publications', () => {
  assert.equal(assertFreshRelease({ candidateSha: 'a', remoteHead: 'a', version: '0.2.0' }), true);
  assert.throws(() => assertFreshRelease({ candidateSha: 'a', remoteHead: 'b', version: '0.2.0' }), { code: 'stale_release' });
  assert.throws(() => assertFreshRelease({ candidateSha: 'a', remoteHead: 'a', latestSha: 'b', latestVersion: 'v0.3.0', version: '0.2.0' }), { code: 'stale_release' });
  assert.throws(() => assertFreshRelease({ candidateSha: 'a', remoteHead: 'a', latestSha: 'b', latestVersion: 'v0.2.0', version: '0.2.0' }), { code: 'stale_release' });
  assert.throws(() => assertFreshRelease({ candidateSha: 'a', remoteHead: 'a', latestSha: 'a', latestVersion: 'v0.2.0', version: '0.2.0' }), { code: 'stale_release' });
  assert.equal(assertFreshRelease({ candidateSha: 'a', remoteHead: 'later', candidateIsAncestor: true, version: '0.2.0' }), true);
  assert.equal(assertFreshRelease({ candidateSha: 'candidate', remoteHead: 'later', candidateIsAncestor: true, latestSha: 'earlier', containsLatest: true, latestVersion: 'v0.2.0', version: '0.3.0' }), true);
  assert.throws(() => assertFreshRelease({ candidateSha: 'a', remoteHead: 'later', candidateIsAncestor: true, latestSha: 'published', latestVersion: 'v0.2.0', version: '0.3.0' }), { code: 'stale_release' });
  assert.throws(() => assertFreshRelease({ candidateSha: 'a', remoteHead: 'a', version: 'latest' }), { code: 'release_version_mismatch' });
});

test('Delivery creates one reviewed PR merges after checks and reconciles resume without duplicate actions', async t => {
  const ctx = await fixture(t);
  const receipt = await deliver(ctx);
  assert.equal(receipt.pr.number, 7); assert.equal(receipt.mergeCommit, ctx.run.headSha);
  assert.equal(ctx.state.creates, 1); assert.equal(ctx.state.merges, 1); assert.equal(ctx.leases.size, 0);
  assert.ok(ctx.updates.some(patch => patch.delivery?.pr?.number === 7 && !patch.delivery.mergeCommit));
  const resumed = await deliver(ctx);
  assert.equal(resumed.mergeCommit, receipt.mergeCommit);
  assert.equal(ctx.state.creates, 1); assert.equal(ctx.state.merges, 1);
});

test('Delivery refuses a stale review before push or PR creation', async t => {
  const ctx = await fixture(t); ctx.review.diffHash = '0'.repeat(64);
  await assert.rejects(deliver(ctx), { code: 'stale_review' });
  assert.equal(ctx.state.creates, 0); assert.equal(ctx.state.merges, 0);
  assert.equal(ctx.calls.some(call => call.command === 'git' && call.args[0] === 'push'), false);
});

test('Delivery refuses weak branch protection before push', async t => {
  const ctx = await fixture(t); ctx.state.protected = false;
  await assert.rejects(deliver(ctx), { code: 'branch_protection' });
  assert.equal(ctx.state.creates, 0); assert.equal(ctx.state.merges, 0);
});

test('Delivery preserves created PR and stops on failed or pending CI', async t => {
  for (const conclusion of ['FAILURE', 'SKIPPED', 'IN_PROGRESS']) {
    const ctx = await fixture(t); ctx.state.check = conclusion;
    await assert.rejects(deliver(ctx), { code: conclusion === 'IN_PROGRESS' ? 'checks_pending' : 'checks_failed' });
    assert.equal(ctx.run.delivery.pr.number, 7); assert.equal(ctx.state.merges, 0); assert.equal(ctx.leases.size, 0);
  }
});

test('Delivery preflight rejects an advanced target before pushing or creating a PR', async t => {
  const ctx = await fixture(t);
  await ctx.git('push', 'origin', `${ctx.run.headSha}:main`);
  await assert.rejects(deliver(ctx), { code: 'stale_base' });
  assert.equal(ctx.state.creates, 0); assert.equal(ctx.run.delivery, undefined);
  assert.equal(ctx.calls.some(call => call.command === 'git' && call.args[0] === 'push'), false);
  assert.equal(ctx.state.merges, 0); assert.equal(ctx.leases.size, 0);
});

test('Delivery detects a changed PR base before waiting for pending or missing CI', async t => {
  for (const noChecks of [false, true]) {
    const ctx = await fixture(t); ctx.state.check = 'IN_PROGRESS'; ctx.state.noChecks = noChecks;
    ctx.state.prBase = 'a'.repeat(40);
    await assert.rejects(deliver(ctx), { code: 'stale_base', baseSha: ctx.state.prBase });
    assert.equal(ctx.run.delivery.pr.number, 7); assert.equal(ctx.state.merges, 0);
    assert.equal(ctx.events.some(event => event.type === 'delivery.checks_waiting'), false);
    assert.equal(ctx.leases.size, 0);
  }
});

test('Delivery rechecks remote base under queue lease after an earlier fresh preflight', async t => {
  const ctx = await fixture(t), runner = ctx.exec;
  let advanced = false;
  ctx.exec = async (command, args, options) => {
    if (!advanced && command === 'gh' && args[0] === 'pr' && args[1] === 'view') {
      advanced = true;
      await ctx.git('push', 'origin', `${ctx.run.headSha}:main`);
    }
    return runner(command, args, options);
  };
  await assert.rejects(deliver(ctx), { code: 'stale_base' });
  assert.equal(ctx.state.merges, 0); assert.equal(ctx.leases.size, 0);
  assert.equal(ctx.run.delivery.pr.number, 7);
  assert.equal(advanced, true);
});

test('Busy merge queue defers delivery without bypassing the lock', async t => {
  const ctx = await fixture(t); ctx.leases.set('merge:test/kodo:main', 'other-run');
  await assert.rejects(deliver(ctx), { code: 'queue_waiting' });
  assert.equal(ctx.state.merges, 0); assert.equal(ctx.leases.get('merge:test/kodo:main'), 'other-run');
});

test('Release packages exact merged commit installs artifact and reconciles without republishing', async t => {
  const ctx = await fixture(t);
  const delivered = await deliver(ctx);
  const release = await releasePackage({ ...ctx, mergeCommit: delivered.mergeCommit });
  assert.equal(validateReceipt(release), true, JSON.stringify(validateReceipt.errors));
  assert.equal(release.published, true); assert.equal(release.version, '0.2.0');
  assert.equal(release.commit, ctx.run.headSha); assert.equal(release.smoke.passed, true);
  assert.equal(release.sha256, digest(await readFile(path.join(ctx.assets, release.artifact))));
  assert.equal(ctx.state.publishes, 1); assert.equal(ctx.leases.size, 0);
  const resumed = await releasePackage({ ...ctx, mergeCommit: delivered.mergeCommit });
  assert.equal(resumed.sha256, release.sha256); assert.equal(resumed.url, release.url);
  assert.equal(ctx.state.publishes, 1); assert.equal(ctx.leases.size, 0);
  await writeFile(path.join(ctx.project, 'later.txt'), 'newer work\n');
  await ctx.git('add', 'later.txt'); await ctx.git('commit', '-m', 'later work'); await ctx.git('push', 'origin', 'HEAD:main');
  assert.equal((await releasePackage({ ...ctx, mergeCommit: delivered.mergeCommit })).sha256, release.sha256);
  assert.equal(ctx.state.publishes, 1);
});

test('Release never publishes an old source commit or a package failing installed smoke', async t => {
  const old = await fixture(t);
  await old.git('push', 'origin', `${old.run.headSha}:main`);
  const tree = await old.git('rev-parse', 'HEAD^{tree}');
  const unrelated = await old.git('commit-tree', tree, '-m', 'unrelated history');
  await assert.rejects(releasePackage({ ...old, mergeCommit: unrelated }), { code: 'stale_release' });
  assert.equal(old.state.publishes, 0); assert.equal(old.leases.size, 0);
  const broken = await fixture(t, { brokenCli: true });
  await broken.git('push', 'origin', `${broken.run.headSha}:main`);
  await assert.rejects(releasePackage({ ...broken, mergeCommit: broken.run.headSha }), { code: 'smoke_failed' });
  assert.equal(broken.state.publishes, 0); assert.equal(broken.leases.size, 0);
});

test('Delivery cancellation does not create a PR and leaves no lease', async t => {
  const ctx = await fixture(t), controller = new AbortController(); controller.abort();
  await assert.rejects(deliver({ ...ctx, signal: controller.signal }), { code: 'cancelled' });
  assert.equal(ctx.state.creates, 0); assert.equal(ctx.leases.size, 0);
});

test('Resuming a merged PR rejects an unrelated immutable reviewed head', async t => {
  const ctx = await fixture(t);
  await deliver(ctx);
  ctx.run.delivery.reviewedHead = ctx.run.baseSha;
  await assert.rejects(deliver(ctx), { code: 'stale_review' });
  assert.equal(ctx.state.creates, 1); assert.equal(ctx.state.merges, 1);
});

test('Published release reconciliation checks saved asset bytes and refuses a changed package', async t => {
  const ctx = await fixture(t);
  const delivered = await deliver(ctx);
  const release = await releasePackage({ ...ctx, mergeCommit: delivered.mergeCommit });
  const original = await readFile(path.join(ctx.assets, release.artifact));
  await writeFile(path.join(ctx.assets, release.artifact), 'replaced artifact');
  await assert.rejects(releasePackage({ ...ctx, mergeCommit: delivered.mergeCommit }), { code: 'release_conflict' });
  await writeFile(path.join(ctx.assets, release.artifact), original);
  await writeFile(path.join(ctx.assets, 'SHA256SUMS'), 'invalid checksum\n');
  await assert.rejects(releasePackage({ ...ctx, mergeCommit: delivered.mergeCommit }), { code: 'release_conflict' });
  assert.equal(ctx.state.publishes, 1); assert.equal(ctx.leases.size, 0);
});

test('Native command execution reports nonzero exit and timeout without a shell', async () => {
  await assert.rejects(execute(process.execPath, ['-e', 'process.exit(4)']), { code: 'command_failed', exitCode: 4 });
  const result = await execute(process.execPath, ['-e', 'process.stdout.write("expected"); process.exit(5)'], { allowFailure: true });
  assert.equal(result.code, 5); assert.equal(result.stdout, 'expected');
  await assert.rejects(execute(process.execPath, ['-e', 'setTimeout(()=>{},10000)'], { timeoutMs: 30 }), { code: 'timeout' });
});

test('Lost merge lease stops mutation and heartbeat cleanup releases the token', async t => {
  const ctx = await fixture(t);
  let signalRenewal;
  const renewed = new Promise(resolve => signalRenewal = resolve);
  let renewals = 0;
  ctx.store.renewLease = () => { renewals++; signalRenewal(); return false; };
  const runner = ctx.exec;
  ctx.exec = async (command, args, options) => {
    if (command === 'git' && args[0] === 'fetch' && ctx.leases.size) await renewed;
    return runner(command, args, options);
  };
  await assert.rejects(deliver({ ...ctx, leaseHeartbeatMs: 1 }), { code: 'lease_lost' });
  assert.ok(renewals > 0); assert.equal(ctx.state.merges, 0); assert.equal(ctx.leases.size, 0);
});

test('Release version preparation updates only metadata and resumes without another bump', async t => {
  const ctx = await fixture(t);
  const manifest = JSON.parse(await readFile(path.join(ctx.project, 'package.json'), 'utf8')); manifest.version = '0.1.0';
  await writeFile(path.join(ctx.project, 'package.json'), JSON.stringify(manifest));
  await writeFile(path.join(ctx.project, 'package-lock.json'), JSON.stringify({ name: manifest.name, version: '0.1.0', lockfileVersion: 3, packages: { '': { name: manifest.name, version: '0.1.0' } } }));
  await writeFile(path.join(ctx.project, 'registry.json'), JSON.stringify({ schemaVersion: 1, version: '0.1.0', components: [{ id: 'skills/example', version: '0.1.0' }] }));
  const prepared = await prepareReleaseVersion(ctx);
  assert.equal(prepared.version, '0.2.0');
  assert.deepEqual(prepared.files, ['package.json', 'package-lock.json', 'registry.json']);
  assert.equal(JSON.parse(await readFile(path.join(ctx.project, 'package-lock.json'))).packages[''].version, '0.2.0');
  const registry = JSON.parse(await readFile(path.join(ctx.project, 'registry.json')));
  assert.equal(registry.version, '0.2.0'); assert.equal(registry.components[0].version, '0.1.0');
  assert.equal(ctx.run.releaseAssignment.prepared, true);
  const resumed = await prepareReleaseVersion(ctx);
  assert.equal(resumed.version, '0.2.0'); assert.equal(resumed.changed, false); assert.equal(ctx.leases.size, 0);
});

test('Release version preparation bumps past current and latest after target advancement', async t => {
  const ctx = await fixture(t);
  ctx.state.release = { tag: 'v0.2.0' };
  const first = await prepareReleaseVersion(ctx);
  assert.equal(first.version, '0.2.1');
  assert.equal((await prepareReleaseVersion(ctx)).version, '0.2.1');
  ctx.run.baseSha = ctx.run.headSha;
  const synchronized = await prepareReleaseVersion(ctx);
  assert.equal(synchronized.version, '0.2.1'); assert.equal(synchronized.changed, false);
  ctx.state.release.tag = 'v0.2.1';
  const next = await prepareReleaseVersion(ctx);
  assert.equal(next.version, '0.2.2'); assert.equal(ctx.leases.size, 0);
});

test('Release reconciliation skips newer drafts and uploads absent assets without replacement', async t => {
  const ctx = await fixture(t);
  const delivered = await deliver(ctx);
  const release = await releasePackage({ ...ctx, mergeCommit: delivered.mergeCommit });
  delete ctx.run.delivery.release; // Simulate crash after publication, before saving its receipt.
  ctx.state.releaseList = [{ tagName: 'v9.0.0', isDraft: true, isPrerelease: false }, { tagName: 'v0.2.0', isDraft: false, isPrerelease: false }];
  await rm(path.join(ctx.assets, 'SHA256SUMS'));
  const controller = new AbortController(), runner = ctx.exec;
  ctx.exec = async (command, args, options) => {
    if (command === 'gh' && args[0] === 'release' && args[1] === 'upload') { assert.equal(options.signal, undefined); controller.abort(); }
    return runner(command, args, options);
  };
  const resumed = await releasePackage({ ...ctx, mergeCommit: delivered.mergeCommit, signal: controller.signal });
  assert.equal(controller.signal.aborted, true);
  assert.equal(resumed.sha256, release.sha256); assert.equal(ctx.state.publishes, 1);
  assert.equal((await readFile(path.join(ctx.assets, 'SHA256SUMS'), 'utf8')).trim(), `${release.sha256}  ${release.artifact}`);
  assert.equal(ctx.leases.size, 0);
});

test('Release refuses a dangling tag pointing to a different commit', async t => {
  const ctx = await fixture(t);
  await ctx.git('push', 'origin', `${ctx.run.headSha}:main`);
  await ctx.git('tag', 'v0.2.0', ctx.run.baseSha); await ctx.git('push', 'origin', 'v0.2.0');
  await assert.rejects(releasePackage({ ...ctx, mergeCommit: ctx.run.headSha }), { code: 'release_conflict' });
  assert.equal(ctx.state.publishes, 0); assert.equal(ctx.leases.size, 0);
});

test('Release subprocess environment excludes inherited credentials from npm tests builds and installed smoke', async t => {
  const ctx = await fixture(t);
  const delivered = await deliver(ctx);
  const hostile = { NPM_TOKEN: 'fixture-npm-secret', AWS_SECRET_ACCESS_KEY: 'fixture-aws-secret', GH_TOKEN: 'fixture-github-secret', GEMINI_API_KEY: 'fixture-google-secret', KODO_GEMINI_API_KEY: 'fixture-kodo-google-secret' };
  const before = Object.fromEntries(Object.keys(hostile).map(name => [name, process.env[name]]));
  Object.assign(process.env, hostile);
  const observed = [], runner = ctx.exec;
  ctx.config.commands.test = [{ command: process.execPath, args: ['cli.mjs', 'validate'] }];
  ctx.config.commands.build = [{ command: process.execPath, args: ['cli.mjs', '--help'] }];
  ctx.exec = async (command, args, options) => {
    for (const name of Object.keys(hostile).filter(name => name !== 'GH_TOKEN')) assert.equal(options.env[name], undefined, `${command} inherited ${name}`);
    const githubTransport = command === 'gh' || command === 'git' && ['fetch', 'push', 'pull', 'clone', 'ls-remote'].includes(args[0]);
    assert.equal(options.env.GH_TOKEN, githubTransport ? hostile.GH_TOKEN : undefined, `${command} GitHub credential boundary`);
    if (!['git', 'gh'].includes(command)) {
      observed.push({ command, args });
      assert.ok(options.env);
      for (const name of Object.keys(hostile)) assert.equal(options.env[name], undefined, `${command} inherited ${name}`);
    }
    return runner(command, args, options);
  };
  try {
    const release = await releasePackage({ ...ctx, mergeCommit: delivered.mergeCommit });
    assert.equal(release.published, true);
    assert.ok(observed.some(item => item.command === 'npm' && item.args[0] === 'pack'));
    assert.ok(observed.some(item => item.command === 'npm' && item.args[0] === 'install'));
    assert.equal(observed.filter(item => item.command === process.execPath).length, 5);
    const native = await execute(process.execPath, ['-e', 'console.log(JSON.stringify(Object.fromEntries(Object.entries(process.env).filter(([name])=>/NPM_TOKEN|AWS_SECRET_ACCESS_KEY|GH_TOKEN|GEMINI_API_KEY/.test(name)))))']);
    assert.deepEqual(JSON.parse(native.stdout), {});
  } finally {
    for (const [name, value] of Object.entries(before)) if (value === undefined) delete process.env[name]; else process.env[name] = value;
  }
});

test('Cancellation during irreversible merge confirms and persists its successful receipt', async t => {
  const ctx = await fixture(t), controller = new AbortController(), runner = ctx.exec;
  ctx.exec = async (command, args, options) => {
    if (command === 'gh' && args[0] === 'pr' && args[1] === 'merge') { assert.equal(options.signal, undefined); controller.abort(); }
    return runner(command, args, options);
  };
  const receipt = await deliver({ ...ctx, signal: controller.signal });
  assert.equal(controller.signal.aborted, true);
  assert.equal(receipt.mergeCommit, ctx.run.headSha); assert.equal(ctx.run.delivery.mergeCommit, ctx.run.headSha);
  assert.equal(ctx.state.merges, 1); assert.equal(ctx.leases.size, 0);
});

test('Cancellation during release creation verifies publication and saves its receipt', async t => {
  const ctx = await fixture(t);
  const delivered = await deliver(ctx), controller = new AbortController(), runner = ctx.exec;
  ctx.exec = async (command, args, options) => {
    if (command === 'gh' && args[0] === 'release' && args[1] === 'create') { assert.equal(options.signal, undefined); controller.abort(); }
    return runner(command, args, options);
  };
  const receipt = await releasePackage({ ...ctx, mergeCommit: delivered.mergeCommit, signal: controller.signal });
  assert.equal(controller.signal.aborted, true); assert.equal(receipt.published, true);
  assert.equal(ctx.run.delivery.release.sha256, receipt.sha256); assert.equal(ctx.state.publishes, 1); assert.equal(ctx.leases.size, 0);
});

test('Cancellation before irreversible publication prevents release creation', async t => {
  const ctx = await fixture(t);
  const delivered = await deliver(ctx), controller = new AbortController(), runner = ctx.exec;
  let listings = 0;
  ctx.exec = async (command, args, options) => {
    if (command === 'gh' && args[0] === 'release' && args[1] === 'list' && ++listings === 2) controller.abort();
    return runner(command, args, options);
  };
  await assert.rejects(releasePackage({ ...ctx, mergeCommit: delivered.mergeCommit, signal: controller.signal }), { code: 'cancelled' });
  assert.equal(ctx.state.publishes, 0); assert.equal(ctx.run.delivery.release, undefined); assert.equal(ctx.leases.size, 0);
});

test('Release publishes an unreleased merged ancestor after main advances', async t => {
  const ctx = await fixture(t);
  const delivered = await deliver(ctx);
  await writeFile(path.join(ctx.project, 'newer-work.txt'), 'parallel task\n');
  await ctx.git('add', 'newer-work.txt'); await ctx.git('commit', '-m', 'parallel task'); await ctx.git('push', 'origin', 'HEAD:main');
  assert.notEqual(await ctx.git('rev-parse', 'origin/main'), delivered.mergeCommit);
  const receipt = await releasePackage({ ...ctx, mergeCommit: delivered.mergeCommit });
  assert.equal(receipt.commit, delivered.mergeCommit); assert.equal(receipt.published, true);
  assert.equal(await ctx.git('rev-parse', 'refs/tags/v0.2.0^{commit}'), delivered.mergeCommit);
  assert.equal(ctx.state.releaseCreates, 1); assert.equal(ctx.state.publishes, 1);
});

test('Interrupted owned draft is completed and published without a second creation', async t => {
  const ctx = await fixture(t);
  const delivered = await deliver(ctx), runner = ctx.exec;
  ctx.exec = async (command, args, options) => {
    const result = await runner(command, args, options);
    if (command === 'gh' && args[0] === 'release' && args[1] === 'create') {
      await rm(path.join(ctx.assets, 'SHA256SUMS'));
      throw Object.assign(new Error('interrupted after draft creation'), { code: 'simulated_disconnect' });
    }
    return result;
  };
  await assert.rejects(releasePackage({ ...ctx, mergeCommit: delivered.mergeCommit }), { code: 'simulated_disconnect' });
  assert.equal(ctx.state.release.isDraft, true); assert.equal(ctx.state.publishes, 0); assert.equal(ctx.state.releaseCreates, 1);
  let recoveryPacks = 0;
  ctx.exec = async (command, args, options) => {
    if (command === 'npm' && args[0] === 'pack') { recoveryPacks++; throw new Error('Another npm version would produce different compressed bytes'); }
    return runner(command, args, options);
  };
  const receipt = await releasePackage({ ...ctx, mergeCommit: delivered.mergeCommit });
  assert.equal(receipt.published, true); assert.equal(ctx.state.release.isDraft, false);
  assert.equal(ctx.state.releaseCreates, 1); assert.equal(ctx.state.publishes, 1); assert.equal(ctx.state.uploads, 1);
  assert.equal(recoveryPacks, 0);
  assert.equal(ctx.run.delivery.release.sha256, receipt.sha256); assert.equal(ctx.leases.size, 0);
});

test('Release never changes an unrelated matching-tag draft', async t => {
  const ctx = await fixture(t);
  await ctx.git('push', 'origin', `${ctx.run.headSha}:main`);
  ctx.state.release = { tag: 'v0.2.0', isDraft: true, targetCommitish: ctx.run.headSha, body: 'Human draft; unrelated to this Kodo run', url: 'https://github.com/test/kodo/releases/tag/v0.2.0' };
  await assert.rejects(releasePackage({ ...ctx, mergeCommit: ctx.run.headSha }), { code: 'release_conflict' });
  assert.equal(ctx.state.release.body, 'Human draft; unrelated to this Kodo run');
  assert.equal(ctx.state.releaseCreates, 0); assert.equal(ctx.state.publishes, 0); assert.equal(ctx.state.uploads, 0);
  assert.equal(ctx.calls.some(call => call.command === 'gh' && call.args[0] === 'release' && ['edit', 'upload', 'create'].includes(call.args[1])), false);
  assert.equal(ctx.leases.size, 0);
});

test('Merge rechecks release assignment under the shared publication lease after CI', async t => {
  const ctx = await fixture(t), runner = ctx.exec;
  let views = 0, checkedWhileLocked = false;
  ctx.exec = async (command, args, options) => {
    if (command === 'gh' && args[0] === 'pr' && args[1] === 'view' && ++views === 2) ctx.state.release = { tag: 'v0.2.0' };
    if (command === 'gh' && args[0] === 'release' && args[1] === 'list') checkedWhileLocked = ctx.leases.has('merge:test/kodo:main') && ctx.leases.has('release:test/kodo:main');
    return runner(command, args, options);
  };
  await assert.rejects(deliver(ctx), { code: 'stale_base' });
  assert.equal(checkedWhileLocked, true); assert.equal(ctx.state.merges, 0); assert.equal(ctx.run.delivery.pr.number, 7);
  assert.equal(ctx.leases.size, 0);
});

test('Published release recovery verifies and smoke tests remote archive without repacking changed npm output', async t => {
  const ctx = await fixture(t);
  const delivered = await deliver(ctx);
  const first = await releasePackage({ ...ctx, mergeCommit: delivered.mergeCommit });
  delete ctx.run.delivery.release;
  const runner = ctx.exec;
  let packs = 0, installedRemote = false;
  ctx.exec = async (command, args, options) => {
    if (command === 'npm' && args[0] === 'pack') { packs++; return { stdout: '{"different-npm":{"filename":"changed-format.tgz"}}', code: 0 }; }
    if (command === 'npm' && args[0] === 'install') {
      const archive = args.at(-1);
      installedRemote = digest(await readFile(archive)) === first.sha256 && archive.includes('recover-');
    }
    return runner(command, args, options);
  };
  const resumed = await releasePackage({ ...ctx, mergeCommit: delivered.mergeCommit });
  assert.equal(resumed.sha256, first.sha256); assert.equal(resumed.smoke.passed, true);
  assert.equal(installedRemote, true); assert.equal(packs, 0);
  assert.equal(ctx.state.releaseCreates, 1); assert.equal(ctx.state.publishes, 1); assert.equal(ctx.state.uploads, 0);
});

test('Coordinator Git disables credential-reading repository hooks for push and fetch', async t => {
  const ctx = await fixture(t), hooks = path.join(ctx.root, 'hostile-hooks'), marker = path.join(ctx.root, 'hook-ran.txt');
  await mkdir(hooks);
  const quoted = marker.replaceAll('\\', '/').replaceAll("'", "'\\''");
  const script = `#!/bin/sh\nprintf '%s' "$GH_TOKEN" > '${quoted}'\nexit 42\n`;
  for (const name of ['pre-push', 'reference-transaction']) { const filename = path.join(hooks, name); await writeFile(filename, script); await chmod(filename, 0o755); }
  await ctx.git('config', 'core.hooksPath', hooks);
  const env = { ...process.env, GH_TOKEN: 'fixture-git-coordinator-secret' };
  const control = spawnSync('git', ['push', 'origin', 'HEAD:refs/heads/unprotected-proof'], { cwd: ctx.project, env, encoding: 'utf8', windowsHide: true });
  assert.notEqual(control.status, 0);
  assert.equal(await readFile(marker, 'utf8'), env.GH_TOKEN);
  await rm(marker);
  await execute('git', ['push', 'origin', 'HEAD:refs/heads/protected-proof'], { cwd: ctx.project, env });
  await execute('git', ['update-ref', 'refs/heads/fetch-proof', ctx.run.headSha], { cwd: ctx.remote, env });
  await execute('git', ['fetch', 'origin'], { cwd: ctx.project, env });
  await assert.rejects(readFile(marker), { code: 'ENOENT' });
});

test('Squash merge reconciliation uses immutable reviewed head after the local branch resynchronizes', async t => {
  const ctx = await fixture(t); ctx.state.squashMerge = true;
  const originalHead = ctx.run.headSha;
  const delivered = await deliver(ctx);
  const squashCommit = delivered.mergeCommit;
  assert.notEqual(squashCommit, originalHead);
  await ctx.git('merge', '--no-edit', squashCommit);
  const synchronizedHead = await ctx.git('rev-parse', 'HEAD');
  assert.notEqual(synchronizedHead, originalHead); assert.notEqual(synchronizedHead, squashCommit);
  ctx.run.headSha = synchronizedHead;
  delete ctx.run.delivery.mergeCommit; // Process died after remote merge, before persisting the result.
  const before = ctx.calls.length;
  const reconciled = await reconcileDelivery(ctx);
  assert.equal(reconciled.mergeCommit, squashCommit);
  assert.equal(reconciled.reviewedHead, originalHead); assert.equal(ctx.run.headSha, synchronizedHead);
  assert.deepEqual(ctx.calls.slice(before).map(call => [call.command, ...call.args.slice(0, 2)]), [['gh', 'pr', 'view']]);
  assert.equal((await deliver(ctx)).mergeCommit, squashCommit);
  assert.equal(ctx.state.creates, 1); assert.equal(ctx.state.merges, 1);
  delete ctx.run.delivery.reviewedHead;
  assert.equal((await reconcileDelivery(ctx)).reviewedHead, originalHead); // Falls back to the persisted/provided review.
});

test('Delivery reconciliation leaves an open PR unchanged without push or verification', async t => {
  const ctx = await fixture(t);
  assert.equal(await reconcileDelivery(ctx), null);
  assert.equal(ctx.calls.length, 0);
  ctx.state.pr = { number: 7, url: 'https://github.com/test/kodo/pull/7', state: 'OPEN' };
  ctx.run.delivery = { pr: { number: 7, url: ctx.state.pr.url }, reviewedHead: ctx.run.headSha };
  const updates = ctx.updates.length;
  assert.equal(await reconcileDelivery(ctx), null);
  assert.equal(ctx.updates.length, updates);
  assert.deepEqual(ctx.calls.map(call => [call.command, ...call.args.slice(0, 2)]), [['gh', 'pr', 'view']]);
  assert.equal(ctx.state.merges, 0);
});

test('Second assigned run bumps past a merged but unpublished target version', async t => {
  const ctx = await fixture(t), projectB = path.join(ctx.root, 'project-b');
  await ctx.git('worktree', 'add', '-b', 'kodo/test-b', projectB, ctx.run.baseSha);
  const gitB = async (...args) => (await execute('git', args, { cwd: projectB })).stdout.trim();
  const manifestB = JSON.parse(await readFile(path.join(projectB, 'package.json'), 'utf8')); manifestB.version = '0.2.0';
  await writeFile(path.join(projectB, 'package.json'), JSON.stringify(manifestB));
  await writeFile(path.join(projectB, 'task-b.txt'), 'independent task B\n');
  await gitB('add', '.'); await gitB('commit', '-m', 'task B initially assigned same version');
  const runB = { ...structuredClone(ctx.run), id: 'run-b', project: projectB, branch: 'kodo/test-b', headSha: await gitB('rev-parse', 'HEAD'), delivery: undefined };
  const deliveredA = await deliver(ctx);
  assert.equal(ctx.state.publishes, 0); assert.equal(ctx.state.release, null);
  await gitB('fetch', 'origin', 'main'); await gitB('merge', '--no-edit', 'origin/main');
  runB.baseSha = deliveredA.mergeCommit; runB.headSha = await gitB('rev-parse', 'HEAD');
  const storeB = { ...ctx.store, updateRun(id, patch) { assert.equal(id, runB.id); Object.assign(runB, patch); } };
  const optionsB = { ...ctx, run: runB, cwd: projectB, store: storeB };
  const prepared = await prepareReleaseVersion(optionsB);
  assert.equal(prepared.version, '0.2.1'); assert.equal(prepared.changed, true);
  assert.equal(JSON.parse(await readFile(path.join(projectB, 'package.json'))).version, '0.2.1');
  assert.equal((await prepareReleaseVersion(optionsB)).changed, false);
  assert.equal(ctx.state.publishes, 0); assert.equal(ctx.state.release, null); assert.equal(ctx.leases.size, 0);
});

test('Merge rejects a target-reserved version even before any release is published', async t => {
  const ctx = await fixture(t);
  const reservedHead = ctx.run.headSha;
  await ctx.git('push', 'origin', `${reservedHead}:main`);
  await writeFile(path.join(ctx.project, 'task-b.txt'), 'more work with stale assigned version\n');
  await ctx.git('add', 'task-b.txt'); await ctx.git('commit', '-m', 'second task after first merge');
  ctx.run.baseSha = reservedHead; ctx.run.headSha = await ctx.git('rev-parse', 'HEAD');
  ctx.state.prHead = ctx.run.headSha;
  ctx.review.headSha = ctx.run.headSha;
  ctx.review.diffHash = digest((await execute('git', ['diff', '--binary', `${ctx.run.baseSha}...${ctx.run.headSha}`], { cwd: ctx.project })).stdout.trimEnd());
  await assert.rejects(deliver(ctx), { code: 'stale_base', targetVersion: '0.2.0' });
  assert.equal(ctx.state.merges, 0); assert.equal(ctx.state.publishes, 0); assert.equal(ctx.state.release, null);
  assert.equal(ctx.leases.size, 0);
});

test('Release freshness fetches a newly announced tag before resolving its commit', async t => {
  const ctx = await fixture(t);
  const delivered = await deliver(ctx), runner = ctx.exec;
  await ctx.git('config', 'remote.origin.tagOpt', '--no-tags');
  let announced = false;
  ctx.exec = async (command, args, options) => {
    if (command === 'gh' && args[0] === 'release' && args[1] === 'list') {
      if (!announced) {
        announced = true;
        // GitHub reports a release created after releasePackage's initial tag
        // fetch. This repository deliberately disables automatic tag following.
        await execute('git', ['update-ref', 'refs/tags/v0.1.0', ctx.run.baseSha], { cwd: ctx.remote });
      }
      const inventory = [{ tagName: 'v0.1.0', isDraft: false, isPrerelease: false }];
      if (ctx.state.release) inventory.push({ tagName: ctx.state.release.tag, isDraft: Boolean(ctx.state.release.isDraft), isPrerelease: false });
      return { stdout: JSON.stringify(inventory), code: 0 };
    }
    return runner(command, args, options);
  };
  const receipt = await releasePackage({ ...ctx, mergeCommit: delivered.mergeCommit });
  assert.equal(receipt.published, true); assert.equal(receipt.commit, delivered.mergeCommit);
  assert.equal(await ctx.git('rev-parse', 'refs/tags/v0.1.0^{commit}'), ctx.run.baseSha);
  assert.equal(ctx.state.publishes, 1); assert.equal(ctx.leases.size, 0);
});
