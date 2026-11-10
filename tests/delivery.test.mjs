import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, writeFile, copyFile, readdir, rm, chmod, rename, symlink } from 'node:fs/promises';
import { constants, watch } from 'node:fs';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import childProcess, { spawn, spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import os from 'node:os';
import path from 'node:path';
import Ajv from 'ajv';
import {
  deliver,
  reconcileDelivery,
  prepareReleaseVersion,
  releasePackage,
  validateChecks,
  assertFreshRelease,
  execute,
} from '../runtime/delivery.mjs';
import { deliveryOperations, uncertainOperations } from '../runtime/delivery-operations.mjs';

const digest = value => createHash('sha256').update(value).digest('hex');
const receiptSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['version', 'tag', 'commit', 'url', 'artifact', 'artifactUrl', 'sha256', 'smoke', 'published'],
  properties: {
    version: { type: 'string', pattern: '^\\d+\\.\\d+\\.\\d+$' },
    tag: { type: 'string', pattern: '^v\\d+\\.\\d+\\.\\d+$' },
    commit: { type: 'string', pattern: '^[a-f0-9]{40,64}$' },
    url: { type: 'string', pattern: '^https://github\\.com/' },
    artifact: { type: 'string', pattern: '\\.tgz$' },
    artifactUrl: { type: 'string', pattern: '^https://github\\.com/.+/releases/download/' },
    sha256: { type: 'string', pattern: '^[a-f0-9]{64}$' },
    published: { const: true },
    smoke: {
      type: 'object',
      additionalProperties: false,
      required: ['passed', 'commands', 'node', 'platform', 'artifactSha256'],
      properties: {
        passed: { const: true },
        commands: { type: 'array', minItems: 1, items: { type: 'string' } },
        node: { type: 'string' },
        platform: { type: 'string' },
        artifactSha256: { type: 'string', pattern: '^[a-f0-9]{64}$' },
      },
    },
  },
};
const validateReceipt = new Ajv({ strict: true }).compile(receiptSchema);
async function fixture(t, { brokenCli = false } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'kodo-delivery-test-'));
  t.after(async () => {
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith('kodo-delivery-test-'));
    await rm(root, { recursive: true, force: true });
  });
  const project = path.join(root, 'project'),
    remote = path.join(root, 'remote.git');
  await mkdir(project);
  const git = async (...args) => (await execute('git', args, { cwd: project })).stdout.trim();
  await git('init', '--bare', remote);
  await git('init', '-b', 'main');
  await git('config', 'user.name', 'Kodo Test');
  await git('config', 'user.email', 'kodo-test@example.invalid');
  await git('config', 'core.autocrlf', 'false');
  await writeFile(
    path.join(project, 'package.json'),
    JSON.stringify({
      name: '@kodo-fixture/test',
      version: '0.1.0',
      type: 'module',
      bin: { kodo: 'cli.mjs' },
      files: ['cli.mjs'],
    }),
  );
  await writeFile(
    path.join(project, 'cli.mjs'),
    brokenCli
      ? "console.log('broken command');\n"
      : "const arg=process.argv[2]; console.log(arg==='list'?JSON.stringify([{id:'skills/example'}]):arg==='validate'?JSON.stringify({valid:true}):'Kodo fixture help');\n",
  );
  await git('add', '.');
  await git('commit', '-m', 'base');
  await git('remote', 'add', 'origin', remote);
  await git('push', '-u', 'origin', 'main');
  const baseSha = await git('rev-parse', 'HEAD');
  await git('switch', '-c', 'kodo/test-run');
  await writeFile(path.join(project, 'feature.txt'), 'feature\n');
  const featureManifest = JSON.parse(await readFile(path.join(project, 'package.json'), 'utf8'));
  featureManifest.version = '0.2.0';
  await writeFile(path.join(project, 'package.json'), JSON.stringify(featureManifest));
  await git('add', '.');
  await git('commit', '-m', 'feature');
  const headSha = await git('rev-parse', 'HEAD');
  const run = {
    id: 'run-test',
    project,
    branch: 'kodo/test-run',
    task: 'Implement tested feature',
    baseSha,
    headSha,
    releaseAssignment: { version: '0.2.0', previousVersion: '0.1.0', baseSha, prepared: true },
  };
  const review = {
    passed: true,
    headSha,
    diffHash: digest(
      (await execute('git', ['diff', '--binary', `${baseSha}...${headSha}`], { cwd: project })).stdout.trimEnd(),
    ),
  };
  const leases = new Map(),
    updates = [],
    events = [],
    calls = [];
  const store = {
    acquireLease(name, owner) {
      if (leases.has(name)) return null;
      const token = `${name}:${owner}`;
      leases.set(name, token);
      return token;
    },
    releaseLease(token) {
      for (const [name, value] of leases) if (value === token) leases.delete(name);
    },
    updateRun(id, patch) {
      assert.equal(id, run.id);
      updates.push(structuredClone(patch));
      Object.assign(run, patch);
    },
    event(id, type, data) {
      events.push({ id, type, data });
    },
  };
  const state = {
    pr: null,
    creates: 0,
    merges: 0,
    check: 'SUCCESS',
    protected: true,
    release: null,
    releaseCreates: 0,
    uploads: 0,
    publishes: 0,
    status: null,
  };
  const assets = path.join(root, 'published');
  await mkdir(assets);
  const exec = async (command, args, options) => {
    calls.push({ command, args });
    if (command !== 'gh') return execute(command, args, options);
    const output = value => ({
      stdout: typeof value === 'string' ? value : JSON.stringify(value),
      stderr: '',
      code: 0,
    });
    if (args[0] === 'api' && args[1]?.startsWith('repos/'))
      return output({
        required_status_checks: { strict: state.protected, contexts: ['ci', 'kodo/review'] },
        enforce_admins: { enabled: true },
      });
    if (args[0] === 'api' && args.includes('POST')) {
      state.status = 'SUCCESS';
      return output({ state: 'success' });
    }
    if (args[0] === 'pr' && args[1] === 'list') return output(state.pr ? [state.pr] : []);
    if (args[0] === 'pr' && args[1] === 'create') {
      const body = await readFile(args[args.indexOf('--body-file') + 1], 'utf8');
      assert.ok(body.includes('<!-- kodo-run:run-test -->'));
      assert.match(body, /Diff SHA-256/);
      state.creates++;
      state.pr = { number: 7, url: 'https://github.com/test/kodo/pull/7', state: 'OPEN' };
      return output(state.pr.url);
    }
    if (args[0] === 'pr' && args[1] === 'view')
      return output({
        ...state.pr,
        headRefOid: state.prHead ?? headSha,
        baseRefName: 'main',
        baseRefOid: state.prBase ?? run.baseSha,
        mergeCommit: state.pr?.state === 'MERGED' ? { oid: state.mergeCommit ?? headSha } : null,
        statusCheckRollup: state.noChecks
          ? []
          : [
              { name: 'ci', conclusion: state.check },
              { context: 'kodo/review', state: state.status ?? 'PENDING' },
            ],
      });
    if (args[0] === 'pr' && args[1] === 'merge') {
      assert.ok(args.includes('--match-head-commit'));
      assert.ok(!args.includes('--admin'));
      if (config.delivery.release) assert.ok(leases.has('release:test/kodo:main'));
      state.mergeCommit = state.squashMerge
        ? await git(
            'commit-tree',
            await git('rev-parse', 'HEAD^{tree}'),
            '-p',
            baseSha,
            '-m',
            'Genuine GitHub-style squash merge',
          )
        : headSha;
      state.merges++;
      state.pr.state = 'MERGED';
      await git('push', 'origin', `${state.mergeCommit}:main`);
      return output('');
    }
    if (args[0] === 'release' && args[1] === 'list') {
      const available =
        state.releaseList ??
        (state.release
          ? [
              {
                tagName: state.release.tag,
                isDraft: Boolean(state.release.isDraft),
                isPrerelease: Boolean(state.release.isPrerelease),
              },
            ]
          : []);
      return output(available.slice(0, Number(args[args.indexOf('--limit') + 1])));
    }
    if (args[0] === 'release' && args[1] === 'create') {
      state.releaseCreates++;
      const tag = args[2],
        artifact = args[3],
        sums = args[4];
      assert.equal(args[args.indexOf('--target') + 1], headSha);
      assert.ok(!args.includes('--clobber'));
      assert.ok(args.includes('--latest=false'));
      await copyFile(artifact, path.join(assets, path.basename(artifact)));
      await copyFile(sums, path.join(assets, 'SHA256SUMS'));
      const isDraft = args.includes('--draft');
      if (!isDraft) {
        state.publishes++;
        await git('tag', tag, headSha);
        await git('push', 'origin', tag);
      }
      const body = await readFile(args[args.indexOf('--notes-file') + 1], 'utf8');
      state.release = {
        tag,
        filename: path.basename(artifact),
        url: `https://github.com/test/kodo/releases/tag/${tag}`,
        isDraft,
        body,
        targetCommitish: headSha,
      };
      return output(state.release.url);
    }
    if (args[0] === 'release' && args[1] === 'view')
      return output({
        tagName: state.release.tag,
        url: state.release.url,
        assets: (await readdir(assets)).map(name => ({ name })),
        isDraft: Boolean(state.release.isDraft),
        isPrerelease: Boolean(state.release.isPrerelease),
        body: state.release.body ?? '',
        targetCommitish: state.release.targetCommitish ?? headSha,
      });
    if (args[0] === 'release' && args[1] === 'upload') {
      assert.ok(!args.includes('--clobber'));
      state.uploads++;
      await copyFile(args[3], path.join(assets, path.basename(args[3])), constants.COPYFILE_EXCL);
      return output('');
    }
    if (args[0] === 'release' && args[1] === 'edit') {
      assert.ok(args.includes('--draft=false') || args.includes('--draft'));
      assert.ok(args.includes('--latest=false'));
      assert.equal(args[args.indexOf('--target') + 1], headSha);
      if (args.includes('--notes-file'))
        state.release.body = await readFile(args[args.indexOf('--notes-file') + 1], 'utf8');
      if (state.release.isDraft && args.includes('--draft=false')) {
        const current = await execute('git', ['rev-parse', '--verify', `refs/tags/${state.release.tag}^{commit}`], {
          cwd: project,
          allowFailure: true,
        });
        if (current.code) await git('tag', state.release.tag, headSha);
        else assert.equal(current.stdout.trim(), headSha);
        await git('push', 'origin', state.release.tag);
        state.publishes++;
        state.release.isDraft = false;
      }
      return output('');
    }
    if (args[0] === 'release' && args[1] === 'download') {
      const filename = args[args.indexOf('--pattern') + 1],
        directory = args[args.indexOf('--dir') + 1];
      await copyFile(path.join(assets, filename), path.join(directory, filename));
      return output('');
    }
    throw new Error(`Unexpected fake GitHub command: ${args.join(' ')}`);
  };
  const config = {
    repository: 'test/kodo',
    baseBranch: 'main',
    checks: ['ci'],
    commands: { test: [], build: [] },
    delivery: { enabled: true, release: true, firstVersion: '0.2.0' },
  };
  return {
    root,
    project,
    remote,
    git,
    run,
    review,
    store,
    state,
    calls,
    leases,
    updates,
    events,
    config,
    exec,
    maxWaitMs: 0,
    pollMs: 1,
    cwd: project,
    assets,
  };
}

test('Delivery checks require success and reject skipped missing duplicate and failed checks', () => {
  assert.deepEqual(validateChecks([{ name: 'ci', conclusion: 'SUCCESS' }], ['ci']), {
    ready: true,
    missing: [],
    pending: [],
    failed: [],
  });
  assert.equal(validateChecks([{ name: 'ci', conclusion: 'SKIPPED' }], ['ci']).ready, false);
  assert.deepEqual(validateChecks([], ['ci']).missing, ['ci']);
  assert.deepEqual(validateChecks([{ name: 'ci', status: 'IN_PROGRESS' }], ['ci']).pending, ['ci']);
  assert.deepEqual(
    validateChecks(
      [
        { name: 'ci', conclusion: 'FAILURE' },
        { name: 'ci', conclusion: 'SUCCESS' },
      ],
      ['ci'],
    ).failed,
    ['ci'],
  );
  assert.throws(() => validateChecks([], []), { code: 'configuration' });
});

test('Release freshness requires ancestry and excludes equal newer or backward publications', () => {
  assert.equal(assertFreshRelease({ candidateSha: 'a', remoteHead: 'a', version: '0.2.0' }), true);
  assert.throws(() => assertFreshRelease({ candidateSha: 'a', remoteHead: 'b', version: '0.2.0' }), {
    code: 'stale_release',
  });
  assert.throws(
    () =>
      assertFreshRelease({
        candidateSha: 'a',
        remoteHead: 'a',
        latestSha: 'b',
        latestVersion: 'v0.3.0',
        version: '0.2.0',
      }),
    { code: 'stale_release' },
  );
  assert.throws(
    () =>
      assertFreshRelease({
        candidateSha: 'a',
        remoteHead: 'a',
        latestSha: 'b',
        latestVersion: 'v0.2.0',
        version: '0.2.0',
      }),
    { code: 'stale_release' },
  );
  assert.throws(
    () =>
      assertFreshRelease({
        candidateSha: 'a',
        remoteHead: 'a',
        latestSha: 'a',
        latestVersion: 'v0.2.0',
        version: '0.2.0',
      }),
    { code: 'stale_release' },
  );
  assert.equal(
    assertFreshRelease({ candidateSha: 'a', remoteHead: 'later', candidateIsAncestor: true, version: '0.2.0' }),
    true,
  );
  assert.equal(
    assertFreshRelease({
      candidateSha: 'candidate',
      remoteHead: 'later',
      candidateIsAncestor: true,
      latestSha: 'earlier',
      containsLatest: true,
      latestVersion: 'v0.2.0',
      version: '0.3.0',
    }),
    true,
  );
  assert.throws(
    () =>
      assertFreshRelease({
        candidateSha: 'a',
        remoteHead: 'later',
        candidateIsAncestor: true,
        latestSha: 'published',
        latestVersion: 'v0.2.0',
        version: '0.3.0',
      }),
    { code: 'stale_release' },
  );
  assert.throws(() => assertFreshRelease({ candidateSha: 'a', remoteHead: 'a', version: 'latest' }), {
    code: 'release_version_mismatch',
  });
});

test('Delivery creates one reviewed PR merges after checks and reconciles resume without duplicate actions', async t => {
  const ctx = await fixture(t);
  const receipt = await deliver(ctx);
  assert.equal(receipt.pr.number, 7);
  assert.equal(receipt.mergeCommit, ctx.run.headSha);
  assert.equal(ctx.state.creates, 1);
  assert.equal(ctx.state.merges, 1);
  assert.equal(ctx.leases.size, 0);
  assert.ok(ctx.updates.some(patch => patch.delivery?.pr?.number === 7 && !patch.delivery.mergeCommit));
  const resumed = await deliver(ctx);
  assert.equal(resumed.mergeCommit, receipt.mergeCommit);
  assert.equal(ctx.state.creates, 1);
  assert.equal(ctx.state.merges, 1);
});

test('Delivery refuses a stale review before push or PR creation', async t => {
  const ctx = await fixture(t);
  ctx.review.diffHash = '0'.repeat(64);
  await assert.rejects(deliver(ctx), { code: 'stale_review' });
  assert.equal(ctx.state.creates, 0);
  assert.equal(ctx.state.merges, 0);
  assert.equal(
    ctx.calls.some(call => call.command === 'git' && call.args[0] === 'push'),
    false,
  );
});

test('Delivery refuses weak branch protection before push', async t => {
  const ctx = await fixture(t);
  ctx.state.protected = false;
  await assert.rejects(deliver(ctx), { code: 'branch_protection' });
  assert.equal(ctx.state.creates, 0);
  assert.equal(ctx.state.merges, 0);
});

test('Delivery preserves created PR and stops on failed or pending CI', async t => {
  for (const conclusion of ['FAILURE', 'SKIPPED', 'IN_PROGRESS']) {
    const ctx = await fixture(t);
    ctx.state.check = conclusion;
    await assert.rejects(deliver(ctx), { code: conclusion === 'IN_PROGRESS' ? 'checks_pending' : 'checks_failed' });
    assert.equal(ctx.run.delivery.pr.number, 7);
    assert.equal(ctx.state.merges, 0);
    assert.equal(ctx.leases.size, 0);
  }
});

test('Delivery preflight rejects an advanced target before pushing or creating a PR', async t => {
  const ctx = await fixture(t);
  await ctx.git('push', 'origin', `${ctx.run.headSha}:main`);
  await assert.rejects(deliver(ctx), { code: 'stale_base' });
  assert.equal(ctx.state.creates, 0);
  assert.equal(ctx.run.delivery, undefined);
  assert.equal(
    ctx.calls.some(call => call.command === 'git' && call.args[0] === 'push'),
    false,
  );
  assert.equal(ctx.state.merges, 0);
  assert.equal(ctx.leases.size, 0);
});

test('Delivery detects a changed PR base before waiting for pending or missing CI', async t => {
  for (const noChecks of [false, true]) {
    const ctx = await fixture(t);
    ctx.state.check = 'IN_PROGRESS';
    ctx.state.noChecks = noChecks;
    ctx.state.prBase = 'a'.repeat(40);
    await assert.rejects(deliver(ctx), { code: 'stale_base', baseSha: ctx.state.prBase });
    assert.equal(ctx.run.delivery.pr.number, 7);
    assert.equal(ctx.state.merges, 0);
    assert.equal(
      ctx.events.some(event => event.type === 'delivery.checks_waiting'),
      false,
    );
    assert.equal(ctx.leases.size, 0);
  }
});

test('Delivery rechecks remote base under queue lease after an earlier fresh preflight', async t => {
  const ctx = await fixture(t),
    runner = ctx.exec;
  let advanced = false;
  ctx.exec = async (command, args, options) => {
    if (!advanced && command === 'gh' && args[0] === 'pr' && args[1] === 'view') {
      advanced = true;
      await ctx.git('push', 'origin', `${ctx.run.headSha}:main`);
    }
    return runner(command, args, options);
  };
  await assert.rejects(deliver(ctx), { code: 'stale_base' });
  assert.equal(ctx.state.merges, 0);
  assert.equal(ctx.leases.size, 0);
  assert.equal(ctx.run.delivery.pr.number, 7);
  assert.equal(advanced, true);
});

test('Busy merge queue defers delivery without bypassing the lock', async t => {
  const ctx = await fixture(t);
  ctx.leases.set('merge:test/kodo:main', 'other-run');
  await assert.rejects(deliver(ctx), { code: 'queue_waiting' });
  assert.equal(ctx.state.merges, 0);
  assert.equal(ctx.leases.get('merge:test/kodo:main'), 'other-run');
});

test('Release packages exact merged commit installs artifact and reconciles without republishing', async t => {
  const ctx = await fixture(t);
  const delivered = await deliver(ctx);
  const release = await releasePackage({ ...ctx, mergeCommit: delivered.mergeCommit });
  assert.equal(validateReceipt(release), true, JSON.stringify(validateReceipt.errors));
  assert.equal(release.published, true);
  assert.equal(release.version, '0.2.0');
  assert.equal(release.commit, ctx.run.headSha);
  assert.equal(release.smoke.passed, true);
  assert.equal(release.sha256, digest(await readFile(path.join(ctx.assets, release.artifact))));
  assert.equal(ctx.state.publishes, 1);
  assert.equal(ctx.leases.size, 0);
  const resumed = await releasePackage({ ...ctx, mergeCommit: delivered.mergeCommit });
  assert.equal(resumed.sha256, release.sha256);
  assert.equal(resumed.url, release.url);
  assert.equal(ctx.state.publishes, 1);
  assert.equal(ctx.leases.size, 0);
  await writeFile(path.join(ctx.project, 'later.txt'), 'newer work\n');
  await ctx.git('add', 'later.txt');
  await ctx.git('commit', '-m', 'later work');
  await ctx.git('push', 'origin', 'HEAD:main');
  assert.equal((await releasePackage({ ...ctx, mergeCommit: delivered.mergeCommit })).sha256, release.sha256);
  assert.equal(ctx.state.publishes, 1);
});

test('Release never publishes an old source commit or a package failing installed smoke', async t => {
  const old = await fixture(t);
  await old.git('push', 'origin', `${old.run.headSha}:main`);
  const tree = await old.git('rev-parse', 'HEAD^{tree}');
  const unrelated = await old.git('commit-tree', tree, '-m', 'unrelated history');
  await assert.rejects(releasePackage({ ...old, mergeCommit: unrelated }), { code: 'stale_release' });
  assert.equal(old.state.publishes, 0);
  assert.equal(old.leases.size, 0);
  const broken = await fixture(t, { brokenCli: true });
  await broken.git('push', 'origin', `${broken.run.headSha}:main`);
  await assert.rejects(releasePackage({ ...broken, mergeCommit: broken.run.headSha }), { code: 'smoke_failed' });
  assert.equal(broken.state.publishes, 0);
  assert.equal(broken.leases.size, 0);
});

test('Delivery cancellation does not create a PR and leaves no lease', async t => {
  const ctx = await fixture(t),
    controller = new AbortController();
  controller.abort();
  await assert.rejects(deliver({ ...ctx, signal: controller.signal }), { code: 'cancelled' });
  assert.equal(ctx.state.creates, 0);
  assert.equal(ctx.leases.size, 0);
});

test('Resuming a merged PR rejects an unrelated immutable reviewed head', async t => {
  const ctx = await fixture(t);
  await deliver(ctx);
  ctx.run.delivery.reviewedHead = ctx.run.baseSha;
  await assert.rejects(deliver(ctx), { code: 'stale_review' });
  assert.equal(ctx.state.creates, 1);
  assert.equal(ctx.state.merges, 1);
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
  assert.equal(ctx.state.publishes, 1);
  assert.equal(ctx.leases.size, 0);
});

test('Native command execution reports nonzero exit and timeout without a shell', async () => {
  await assert.rejects(execute(process.execPath, ['-e', 'process.exit(4)']), { code: 'command_failed', exitCode: 4 });
  const result = await execute(process.execPath, ['-e', 'process.stdout.write("expected"); process.exit(5)'], {
    allowFailure: true,
  });
  assert.equal(result.code, 5);
  assert.equal(result.stdout, 'expected');
  await assert.rejects(execute(process.execPath, ['-e', 'setTimeout(()=>{},10000)'], { timeoutMs: 30 }), {
    code: 'timeout',
  });
});

async function readyFile(directory, name) {
  const filename = path.join(directory, name);
  return new Promise((resolve, reject) => {
    const watcher = watch(directory, check);
    const watchdog = setTimeout(() => finish(new Error('Fixture readiness watchdog expired')), 20000);
    function finish(error, value) {
      clearTimeout(watchdog);
      watcher.close();
      if (error) reject(error);
      else resolve(value);
    }
    async function check() {
      try {
        const value = JSON.parse(await readFile(filename, 'utf8'));
        finish(null, value);
      } catch (error) {
        if (!['ENOENT', undefined].includes(error.code) && !(error instanceof SyntaxError)) finish(error);
      }
    }
    check();
  });
}

async function ownedTree(t, { inheritedPipes = true } = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'kodo-delivery-test-'));
  let pids = [];
  t.after(async () => {
    // Failure recovery targets only PIDs obtained from this fixture's handshake.
    for (const pid of pids.slice().reverse()) {
      if (process.platform === 'win32')
        spawnSync('taskkill.exe', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
      else {
        try {
          process.kill(pid, 'SIGKILL');
        } catch (error) {
          if (error.code !== 'ESRCH') throw error;
        }
      }
    }
    assert.equal(path.dirname(directory), path.resolve(os.tmpdir()));
    assert.ok(path.basename(directory).startsWith('kodo-delivery-test-'));
    await rm(directory, { recursive: true, force: true });
  });
  const script = `
    const {spawn}=require('node:child_process'),fs=require('node:fs');
    const level=Number(process.argv[2]),dir=process.argv[3];
    process.on('SIGTERM',()=>{});
    fs.openSync(require('node:path').join(process.cwd(),'held-'+level),'w');
    const ready=pids=>{
      if(level===0){fs.watch(dir,(_,name)=>{if(name==='flood')process.stdout.write('x'.repeat(8192));});
        console.log('owned tree ready');console.error('owned tree stderr ready');fs.writeFileSync(require('node:path').join(dir,'ready.json'),JSON.stringify(pids));}
      else process.send(pids);
    };
    if(level===2)ready([process.pid]);
    else {const child=spawn(process.execPath,[__filename,String(level+1),dir],{
      cwd:process.cwd(),windowsHide:true,stdio:['ignore',${JSON.stringify(inheritedPipes ? 'inherit' : 'ignore')},${JSON.stringify(inheritedPipes ? 'inherit' : 'ignore')},'ipc']});
      child.on('message',pids=>ready([process.pid,...pids]));}
    setInterval(()=>{},1000);
  `;
  // The recursive script is passed as data, with no shell or global processes.
  const filename = path.join(directory, 'tree.cjs');
  await writeFile(filename, script);
  const ready = readyFile(directory, 'ready.json').then(value => {
    pids = value;
    return value;
  });
  return {
    directory,
    filename,
    ready,
    disarm: () => {
      pids = [];
    },
  };
}

async function assertStopped(
  pids,
  {
    platform = process.platform,
    probe = pid => process.kill(pid, 0),
    readStat = pid => readFile(`/proc/${pid}/stat`, 'utf8'),
  } = {},
) {
  for (const pid of pids) {
    try {
      probe(pid);
    } catch (error) {
      if (error.code === 'ESRCH') continue;
      throw error;
    }
    // Linux can retain an already-dead orphan as a zombie until PID 1 reaps it.
    if (platform === 'linux') {
      try {
        if (/\) Z /.test(await readStat(pid))) continue;
      } catch (error) {
        if (['ENOENT', 'ESRCH'].includes(error.code)) continue;
        throw error;
      }
    }
    assert.fail(`Owned fixture process ${pid} is still running after execute settled`);
  }
}

test('Owned process assertion handles reaping between liveness and proc observation', async () => {
  for (const code of ['ESRCH', 'ENOENT'])
    await assertStopped([123], {
      platform: 'linux',
      probe() {},
      readStat: async () => {
        throw Object.assign(new Error('Owned process was reaped'), { code });
      },
    });
  await assertStopped([123], { platform: 'linux', probe() {}, readStat: async () => '123 (owned node) Z 1' });
  await assert.rejects(
    () => assertStopped([123], { platform: 'linux', probe() {}, readStat: async () => '123 (owned node) R 1' }),
    /still running/,
  );
  await assert.rejects(
    () =>
      assertStopped([123], {
        platform: 'linux',
        probe() {},
        readStat: async () => {
          throw Object.assign(new Error('Access denied'), { code: 'EACCES' });
        },
      }),
    error => error.code === 'EACCES',
  );
});

for (const scenario of [
  { name: 'exit at handle boundary', boundary: 'handle', exit: true },
  {
    name: 'confirmed exit during handle acquisition',
    boundary: 'handle',
    exit: true,
    fault: 'InvalidOperationException',
  },
  { name: 'exit at kill boundary', boundary: 'kill', exit: true },
  { name: 'live process error during kill', boundary: 'kill', fault: 'InvalidOperationException' },
  { name: 'access denied during handle acquisition', boundary: 'handle', fault: 'ComponentModel.Win32Exception' },
  { name: 'continues descendant enumeration after an observed child disappears', boundary: 'lookup', tree: true },
  { name: 'rejects an owned tree that remains alive after shutdown', boundary: 'kill', tree: true, survives: true },
]) {
  test(`Windows owned teardown ${scenario.name}`, { skip: process.platform !== 'win32', timeout: 40000 }, async t => {
    const nativeSpawn = childProcess.spawn;
    let injected = false,
      helperStderr = '';
    const mocked = t.mock.method(childProcess, 'spawn', (command, args, options) => {
      if (!/powershell\.exe$/i.test(command)) return nativeSpawn(command, args, options);
      const index = args.indexOf('-EncodedCommand') + 1;
      let script = Buffer.from(args[index], 'base64').toString('utf16le');
      // Exit a real owned process exactly after discovery / the liveness check.
      // A separate Process instance avoids opening the captured object's handle.
      const exit = scenario.exit
        ? '$terminator = [Diagnostics.Process]::GetProcessById($p.Id); $terminator.Kill(); $terminator.WaitForExit(); $terminator.Dispose();'
        : '';
      const fault = scenario.fault
        ? `throw [${scenario.fault}]::new(${scenario.fault === 'ComponentModel.Win32Exception' ? 5 : "'Fixture process operation failed'"});`
        : '';
      if (scenario.boundary === 'lookup') {
        const lookup = '$p = [Diagnostics.Process]::GetProcessById($ownedId)';
        assert.ok(script.includes(lookup));
        // Model GetProcessById finding an exited, already-reaped child. Its
        // still-live grandchild must still be enumerated and awaited.
        const vanish =
          "if ($ownedId -ne $root -and !$script:fixtureExited) { $script:fixtureExited = $true; $gone = [Diagnostics.Process]::GetProcessById($ownedId); $gone.Kill(); $gone.WaitForExit(); $gone.Dispose(); throw [ArgumentException]::new('Fixture child exited') };";
        script = script.replace(lookup, `${vanish} ${lookup}`);
      } else if (scenario.boundary === 'handle') {
        assert.ok(script.includes('$null = $p.Handle'));
        script = script.replace('$null = $p.Handle', `${exit} ${fault} $null = $p.Handle`);
      } else {
        // Suppress the earlier bulk kill so this process reaches the Kill race.
        script = script.replace(/try \{ & .*taskkill\.exe.*?\} catch \{ \}/, '');
        assert.ok(!script.includes('taskkill.exe'));
        assert.ok(script.includes('$p.Kill()'));
        script = script.replace('$p.Kill()', scenario.survives ? '$null = $p.Id' : `${exit} ${fault} $p.Kill()`);
        if (scenario.survives) {
          assert.ok(script.includes("throw 'Owned process did not exit'"));
          script = script.replace(
            "throw 'Owned process did not exit'",
            "if (@($owned | Where-Object { $_.Id -ne $root -and !$_.HasExited }).Count -gt 0) { [Console]::Error.WriteLine('Fixture descendant still alive before rejection') }; throw 'Owned process did not exit'",
          );
        }
      }
      injected = true;
      const argv = [...args];
      argv[index] = Buffer.from(script, 'utf16le').toString('base64');
      const helper = nativeSpawn(command, argv, options);
      helper.stderr.on('data', chunk => {
        helperStderr += chunk;
      });
      return helper;
    });
    syncBuiltinESMExports();
    try {
      const tree = scenario.tree ? await ownedTree(t) : undefined;
      const outcome = execute(
        process.execPath,
        tree
          ? [tree.filename, '0', tree.directory]
          : ['-e', "process.stdout.write('x'.repeat(2048));setInterval(()=>{},1000)"],
        { cwd: tree?.directory, maxOutputBytes: 1024 },
      ).catch(error => error);
      let pids;
      if (tree) {
        pids = await tree.ready;
        await writeFile(path.join(tree.directory, 'flood'), 'go');
      }
      const error = await outcome;
      assert.equal(injected, true);
      assert.equal(error.code, 'invalid_output');
      if ((scenario.fault && !scenario.exit) || scenario.survives) {
        assert.equal(error.teardownError?.code, 'process_teardown');
        assert.match(error.teardownError.message, /Owned process teardown helper failed \(1\)/);
        if (scenario.survives) assert.match(helperStderr, /Owned process did not exit/);
      } else assert.equal(error.teardownError, undefined, helperStderr);
      if (tree) {
        if (scenario.survives) assert.match(helperStderr, /Fixture descendant still alive before rejection/);
        else {
          await assertStopped(pids);
          tree.disarm();
        }
        assert.match(error.stdout, /owned tree ready/);
      } else assert.equal(error.stdout, 'x'.repeat(1024));
    } finally {
      mocked.mock.restore();
      syncBuiltinESMExports();
    }
  });
}

for (const mode of ['timeout', 'abort', 'output-limit']) {
  test(`Delivery lifecycle awaits owned parent and grandchild shutdown on ${mode}`, { timeout: 40000 }, async t => {
    const tree = await ownedTree(t, { inheritedPipes: mode !== 'abort' });
    const canary = spawn(process.execPath, ['-e', "process.on('message',()=>process.exit(0));process.send('ready')"], {
      windowsHide: true,
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    });
    const canaryClosed = new Promise(resolve => canary.once('close', resolve));
    t.after(async () => {
      if (canary.connected) canary.send('exit');
      await canaryClosed;
    });
    await new Promise((resolve, reject) => {
      canary.once('message', resolve);
      canary.once('error', reject);
    });
    const controller = new AbortController();
    const outcome = execute(process.execPath, [tree.filename, '0', tree.directory], {
      cwd: tree.directory,
      signal: controller.signal,
      timeoutMs: mode === 'timeout' ? 4000 : 10000,
      maxOutputBytes: 1024,
    }).then(
      value => ({ value }),
      error => ({ error }),
    );
    const pids = await tree.ready;
    assert.equal(pids.length, 3);
    if (mode === 'abort') controller.abort();
    if (mode === 'output-limit') await writeFile(path.join(tree.directory, 'flood'), 'go');
    const { error } = await outcome;
    assert.equal(error?.code, { timeout: 'timeout', abort: 'cancelled', 'output-limit': 'invalid_output' }[mode]);
    await assertStopped(pids);
    tree.disarm();
    assert.equal(canary.exitCode, null);
    assert.equal(canary.signalCode, null);
    assert.equal(process.kill(canary.pid, 0), true);
    assert.match(error.stdout, /owned tree ready/);
    assert.equal(error.teardownError, undefined);
    assert.ok(Buffer.byteLength(error.stdout) + Buffer.byteLength(error.stderr) <= 1024);
    // Removal happens immediately after settlement, without a retry or sleep.
    await rm(tree.directory, { recursive: true });
  });
}

test('Delivery lifecycle preserves complete bounded stdout and stderr diagnostics safely', async () => {
  const text = 'failing assertion near the beginning\n' + 'detail\n'.repeat(9000);
  const secret = 'fixture-private-value';
  await assert.rejects(
    execute(process.execPath, [
      '-e',
      `process.stdout.write('failing assertion near the beginning\\n'+'detail\\n'.repeat(9000));process.stderr.write('specific failure Bearer ${secret}');process.exitCode=9`,
    ]),
    error => {
      assert.equal(error.code, 'command_failed');
      assert.equal(error.exitCode, 9);
      assert.equal(error.stdout, text);
      assert.match(error.stderr, /specific failure Bearer \[REDACTED\]/);
      assert.match(error.message, /stdout/);
      assert.match(error.message, /specific failure/);
      assert.match(error.message, /failing assertion near the beginning/);
      assert.equal(JSON.stringify(error).includes(secret), false);
      return true;
    },
  );
});

for (const mode of ['timeout', 'abort']) {
  test(`Release lifecycle awaits real owned tree before source cleanup on ${mode}`, { timeout: 40000 }, async t => {
    const ctx = await fixture(t),
      runner = ctx.exec,
      tree = await ownedTree(t),
      controller = new AbortController();
    await ctx.git('push', 'origin', `${ctx.run.headSha}:main`);
    ctx.config.commands.test = [
      {
        command: process.execPath,
        args: [tree.filename, '0', tree.directory],
        timeoutMs: mode === 'timeout' ? 4000 : 15000,
      },
    ];
    let source,
      pids,
      cleanupObserved = false;
    ctx.exec = async (command, args, options) => {
      if (command === process.execPath && args[0] === tree.filename) source = options.cwd;
      if (command === 'git' && args[0] === 'worktree' && args[1] === 'remove') {
        await assertStopped(pids);
        cleanupObserved = true;
      }
      return runner(command, args, options);
    };
    const outcome = releasePackage({ ...ctx, mergeCommit: ctx.run.headSha, signal: controller.signal }).catch(
      error => error,
    );
    pids = await tree.ready;
    if (mode === 'abort') controller.abort();
    const error = await outcome;
    assert.equal(error.code, mode === 'timeout' ? 'timeout' : 'cancelled');
    assert.match(error.stdout, /owned tree ready/);
    assert.match(error.stderr, /owned tree stderr ready/);
    assert.equal(error.cleanupErrors, undefined);
    assert.equal(error.teardownError, undefined);
    assert.equal(cleanupObserved, true);
    await assertStopped(pids);
    tree.disarm();
    await assert.rejects(readFile(path.join(source, 'package.json')), { code: 'ENOENT' });
    assert.equal(ctx.leases.size, 0);
    assert.equal(ctx.state.releaseCreates, 0);
    assert.equal(ctx.run.delivery?.release, undefined);
  });
}

test('Release lifecycle records complete redacted command diagnostics before cleanup', async t => {
  const ctx = await fixture(t);
  await ctx.git('push', 'origin', `${ctx.run.headSha}:main`);
  ctx.config.commands.test = [
    {
      command: process.execPath,
      args: [
        '-e',
        "process.stdout.write('first assertion\\n'+'detail\\n'.repeat(9000));process.stderr.write('last failure Bearer fixture-private-value');process.exitCode=6",
      ],
    },
  ];
  await assert.rejects(releasePackage({ ...ctx, mergeCommit: ctx.run.headSha }), error => {
    assert.equal(error.code, 'command_failed');
    assert.equal(error.exitCode, 6);
    assert.match(error.message, /first assertion/);
    return true;
  });
  const diagnostic = ctx.events.find(event => event.type === 'delivery.command_failed').data;
  assert.equal(diagnostic.stdout, 'first assertion\n' + 'detail\n'.repeat(9000));
  assert.equal(diagnostic.stderr, 'last failure Bearer [REDACTED]');
  assert.equal(diagnostic.outputTruncated, false);
  assert.equal(JSON.stringify(diagnostic).includes('fixture-private-value'), false);
  assert.equal(ctx.leases.size, 0);
  assert.equal(ctx.state.releaseCreates, 0);
});

async function credentialRedactionFixture(t) {
  const ctx = await fixture(t);
  await ctx.git('push', 'origin', `${ctx.run.headSha}:main`);
  const environmentOnly = 'fictional-env-only-credential',
    explicit = 'fictional-explicit-credential';
  const previous = process.env.NPM_TOKEN,
    previousValue = process.env.FIXTURE_RELEASE_VALUE;
  process.env.NPM_TOKEN = environmentOnly;
  process.env.FIXTURE_RELEASE_VALUE = 'kept';
  t.after(() => {
    if (previous === undefined) delete process.env.NPM_TOKEN;
    else process.env.NPM_TOKEN = previous;
    if (previousValue === undefined) delete process.env.FIXTURE_RELEASE_VALUE;
    else process.env.FIXTURE_RELEASE_VALUE = previousValue;
  });
  // The same key must retain both values in the redaction set. Only the explicit
  // value is in options.secrets; the child reads the env-only value from fake config.
  ctx.secrets = { NPM_TOKEN: explicit };
  const configFile = path.join(ctx.root, 'fixture-tool-config.json');
  await writeFile(configFile, JSON.stringify({ environmentOnly, explicit }));
  return { ctx, environmentOnly, explicit, configFile };
}

function assertCredentialFailure(error, { environmentOnly, explicit }, code, exitCode) {
  assert.ok(error instanceof Error);
  assert.equal(error.code, code);
  assert.equal(error.exitCode, exitCode);
  assert.equal(error.result.code, exitCode);
  for (const representation of [
    error.message,
    error.stack,
    JSON.stringify(error),
    JSON.stringify(Object.getOwnPropertyDescriptors(error)),
  ]) {
    assert.equal(
      representation.includes(environmentOnly),
      false,
      'env-only credential escaped in an error representation',
    );
    assert.equal(representation.includes(explicit), false, 'explicit credential escaped in an error representation');
  }
  assert.equal(error.stdout, 'first assertion [REDACTED]\n' + 'detail\n'.repeat(9000) + 'tail [REDACTED]\n');
  assert.equal(error.stderr, 'last failure [REDACTED] / [REDACTED]\n');
  assert.match(error.message, /first assertion/);
  assert.match(error.message, /last failure/);
  assert.ok(error.message.length < 25000);
  assert.equal(error.result.stdout, error.stdout);
  assert.equal(error.result.stderr, error.stderr);
}

test('Credential redaction covers direct runner overlapping environment and options names', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'kodo-delivery-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const environmentOnly = 'fictional-env-only-credential',
    explicit = 'fictional-explicit-credential';
  const configFile = path.join(directory, 'fixture-tool-config.json');
  await writeFile(configFile, JSON.stringify({ environmentOnly, explicit }));
  const script = `
    const {environmentOnly,explicit}=JSON.parse(require('node:fs').readFileSync(process.argv[1],'utf8'));
    if(process.env.NPM_TOKEN!==undefined)throw new Error('credential was forwarded');
    process.stdout.write('first assertion '+environmentOnly+'\\n'+'detail\\n'.repeat(9000)+'tail '+explicit+'\\n');
    process.stderr.write('last failure '+environmentOnly+' / '+explicit+'\\n');process.exitCode=6;
  `;
  await assert.rejects(
    execute(process.execPath, ['-e', script, configFile], {
      cwd: directory,
      env: { ...process.env, NPM_TOKEN: environmentOnly },
      secrets: { NPM_TOKEN: explicit },
    }),
    error => {
      assertCredentialFailure(error, { environmentOnly, explicit }, 'command_failed', 6);
      return true;
    },
  );
});

function fullOverlapCases() {
  const short = ['fixture', 'shared'].join('-');
  const tail = ['private', 'suffix'].join('-');
  const left = ['fixture', 'middle'].join('-'),
    right = ['middle', 'ending'].join('-');
  const providerHead = ['sk', 'x'.repeat(20)].join('-');
  return [
    { name: 'prefix', values: [short, `${short}-${tail}`], text: `${short}-${tail}` },
    { name: 'substring', values: [short, `outer-${short}-${tail}`], text: `outer-${short}-${tail}` },
    { name: 'crossing', values: [left, right], text: ['fixture', 'middle', 'ending'].join('-') },
    { name: 'generic prefix', values: [providerHead, `${providerHead}::${tail}`], text: `${providerHead}::${tail}` },
    { name: 'self overlap', values: ['ab'.repeat(4)], text: 'ab'.repeat(7) },
  ];
}

function assertFullOverlapFailure(error, stdout, stderr, code = 'command_failed') {
  assert.ok(error instanceof Error);
  assert.equal(error.code, code);
  assert.equal(error.exitCode, 7);
  assert.equal(error.stdout, stdout);
  assert.equal(error.stderr, stderr);
  assert.equal(error.result.stdout, stdout);
  assert.equal(error.result.stderr, stderr);
  assert.equal(error.result.code, 7);
  for (const representation of [
    error.message,
    error.stack,
    JSON.stringify(error),
    JSON.stringify(Object.getOwnPropertyDescriptors(error)),
  ]) {
    assert.equal(
      /fixture-|shared|private-suffix|outer-|middle-|-ending|abab/.test(representation),
      false,
      'overlapping credential bytes escaped in an error representation',
    );
  }
}

test('Full overlap redaction unions original matches for real execute regardless of value order', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'kodo-delivery-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const configFile = path.join(directory, 'overlap.json');
  const script = `
    const {text}=JSON.parse(require('node:fs').readFileSync(process.argv[1],'utf8'));
    if(process.env.NPM_TOKEN!==undefined)throw new Error('credential was forwarded');
    process.stdout.write('assertion Привет 😀\\0 '+text+' / Bearer '+text+' / Bearer unknown-value\\n');
    process.stderr.write('diagnostic '+text+' / ?token='+text+'&safe=1 / ?key=unknown-value&safe=2\\n');process.exitCode=7;
  `;
  for (const sample of fullOverlapCases()) {
    await writeFile(configFile, JSON.stringify(sample));
    for (const reverse of [false, true]) {
      const values = reverse ? [...sample.values].reverse() : sample.values;
      const error = await execute(process.execPath, ['-e', script, configFile], {
        cwd: directory,
        env: { ...process.env, NPM_TOKEN: values[0] },
        secrets: { NPM_TOKEN: values[1] ?? values[0] },
      }).catch(error => error);
      assertFullOverlapFailure(
        error,
        'assertion Привет 😀\0 [REDACTED] / Bearer [REDACTED] / Bearer [REDACTED]\n',
        'diagnostic [REDACTED] / ?token=[REDACTED]&safe=1 / ?key=[REDACTED]&safe=2\n',
      );
      assert.equal(error.teardownError, undefined);
    }
  }
});

for (const mode of ['execute', 'result', 'command_failed', 'timeout', 'cancelled', 'frozen']) {
  test(`Full overlap redaction protects context events and error representations on ${mode}`, async t => {
    const cases = fullOverlapCases(),
      outputs = cases.map(sample => sample.text);
    const ctx = await fixture(t);
    const previous = process.env.NPM_TOKEN;
    process.env.NPM_TOKEN = cases[0].values[0];
    t.after(() => {
      if (previous === undefined) delete process.env.NPM_TOKEN;
      else process.env.NPM_TOKEN = previous;
    });
    // The same option name must retain the longer value alongside the env prefix.
    ctx.secrets = {
      NPM_TOKEN: cases[0].values[1],
      ...Object.fromEntries(
        cases.flatMap((sample, index) => sample.values.map((value, part) => [`overlap${index}_${part}`, value])),
      ),
    };
    ctx.run.delivery = { pr: { number: 7 } };
    const stdout =
      outputs.map(text => `assertion ${text}\n`).join('') + 'detail\n'.repeat(9000) + `tail ${outputs[0]}\n`;
    const stderr = outputs.map(text => `diagnostic ${text}\n`).join('');
    const cleanStdout = 'assertion [REDACTED]\n'.repeat(cases.length) + 'detail\n'.repeat(9000) + 'tail [REDACTED]\n';
    const cleanStderr = 'diagnostic [REDACTED]\n'.repeat(cases.length);
    const result = { stdout, stderr, code: 7, diagnostics: { detail: outputs.join(' / ') } };
    const code = ['execute', 'result', 'frozen'].includes(mode) ? 'command_failed' : mode;
    const primary = Object.assign(new TypeError(outputs.join(' / '), { cause: new Error(outputs.join(' / ')) }), {
      code,
      exitCode: 7,
      stdout,
      stderr,
      result,
    });
    void primary.stack;
    void primary.cause.stack;
    if (mode === 'frozen') {
      Object.freeze(primary.cause);
      Object.freeze(result.diagnostics);
      Object.freeze(result);
      Object.freeze(primary);
    }
    const configFile = path.join(ctx.root, 'overlap.json');
    await writeFile(configFile, JSON.stringify({ stdout, stderr }));
    ctx.exec = async (command, args, options) => {
      assert.equal(command, 'gh');
      assert.equal(options.env.NPM_TOKEN, undefined);
      assert.ok(Object.values(options.secrets).includes(cases[0].values[0]));
      assert.ok(Object.values(options.secrets).includes(cases[0].values[1]));
      if (mode === 'execute')
        return execute(
          process.execPath,
          [
            '-e',
            "const data=JSON.parse(require('node:fs').readFileSync(process.argv[1],'utf8'));process.stdout.write(data.stdout);process.stderr.write(data.stderr);process.exitCode=7",
            configFile,
          ],
          options,
        );
      if (mode === 'result') return result;
      throw primary;
    };
    const error = await reconcileDelivery(ctx).catch(error => error);
    assertFullOverlapFailure(error, cleanStdout, cleanStderr, code);
    assert.match(error.message, mode === 'execute' || mode === 'result' ? /assertion/ : /\[REDACTED\]/);
    if (mode !== 'execute')
      assert.equal(error.result.diagnostics.detail, Array(cases.length).fill('[REDACTED]').join(' / '));
    if (!['execute', 'result'].includes(mode)) {
      assert.ok(error instanceof TypeError);
      if (mode === 'frozen') assert.notEqual(error, primary);
      else assert.equal(error, primary);
      assert.equal(error.cause.message, Array(cases.length).fill('[REDACTED]').join(' / '));
      assert.equal(/fixture-|shared|private-suffix|outer-|middle-|-ending|abab/.test(error.cause.stack), false);
    }
    const diagnostic = ctx.events.find(event => event.type === 'delivery.command_failed').data;
    assert.deepEqual(diagnostic, {
      command: 'gh',
      code,
      exitCode: 7,
      stdout: cleanStdout,
      stderr: cleanStderr,
      outputTruncated: false,
    });
    assert.equal(ctx.leases.size, 0);
    assert.equal(ctx.state.releaseCreates, 0);
  });
}

const defaultOutputCap = 20 * 1024 * 1024;
const boundarySecret = ['fixture-env-boundary', '0123456789abcde'].join('-');
const boundaryMarker = 'actionable assertion before boundary\n';
async function outputBoundaryScript(directory, stream, cap = defaultOutputCap) {
  const configFile = path.join(directory, 'output-boundary.json');
  await writeFile(configFile, JSON.stringify({ secret: boundarySecret, stream, cap }));
  const script = `
    const fs=require('node:fs'),{secret,stream,cap}=JSON.parse(fs.readFileSync(process.argv[1],'utf8'));
    if(process.env.NPM_TOKEN!==undefined)throw new Error('credential was forwarded');
    const output=process[stream],write=text=>new Promise(resolve=>output.write(text,resolve));
    (async()=>{
      await write(${JSON.stringify(boundaryMarker)});
      let remaining=cap-(secret.length-1)-${Buffer.byteLength(boundaryMarker)};
      while(remaining>0){const size=Math.min(remaining,65536);await write('.'.repeat(size));remaining-=size;}
      await write(secret.slice(0,11));await new Promise(resolve=>setImmediate(resolve));
      await write(secret.slice(11));setInterval(()=>{},1000);
    })();
  `;
  return ['-e', script, configFile];
}

function assertBoundaryFailure(error, stream, cap = defaultOutputCap, diagnostic) {
  assert.ok(error instanceof Error);
  assert.equal(error.code, 'invalid_output');
  assert.equal(error.result.outputTruncated, true);
  assert.equal(error.exitCode, error.result.code);
  assert.equal(error.exitCode, process.platform === 'win32' ? 1 : null);
  const representations = {
    message: error.message,
    stack: error.stack,
    stdout: error.stdout,
    stderr: error.stderr,
    'result.stdout': error.result.stdout,
    'result.stderr': error.result.stderr,
    ...(diagnostic ? { event: JSON.stringify(diagnostic) } : {}),
  };
  const leaked = Object.entries(representations)
    .filter(([, value]) => value.includes(boundarySecret.slice(0, -1)))
    .map(([name]) => name);
  assert.deepEqual(leaked, [], 'credential prefix escaped at capture boundary');
  assert.ok(error[stream].startsWith(boundaryMarker));
  assert.ok(error[stream].endsWith('[REDACTED]'));
  assert.equal(error.result[stream], error[stream]);
  assert.ok(Buffer.byteLength(error.stdout) + Buffer.byteLength(error.stderr) <= cap);
  assert.equal(error.teardownError, undefined);
}

for (const stream of ['stdout', 'stderr']) {
  test(`Output boundary redaction protects direct default cap on ${stream}`, { timeout: 40000 }, async t => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'kodo-delivery-test-'));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const args = await outputBoundaryScript(directory, stream);
    const error = await execute(process.execPath, args, {
      cwd: directory,
      env: { ...process.env, NPM_TOKEN: boundarySecret },
    }).catch(error => error);
    assertBoundaryFailure(error, stream);
  });

  test(`Output boundary redaction protects release default cap and event on ${stream}`, { timeout: 40000 }, async t => {
    const ctx = await fixture(t),
      runner = ctx.exec;
    await ctx.git('push', 'origin', `${ctx.run.headSha}:main`);
    const previous = process.env.NPM_TOKEN;
    process.env.NPM_TOKEN = boundarySecret;
    t.after(() => {
      if (previous === undefined) delete process.env.NPM_TOKEN;
      else process.env.NPM_TOKEN = previous;
    });
    ctx.config.commands.test = [{ command: process.execPath, args: await outputBoundaryScript(ctx.root, stream) }];
    let source;
    ctx.exec = async (command, args, options) => {
      if (command === process.execPath) {
        source = options.cwd;
        assert.equal(options.env.NPM_TOKEN, undefined);
      }
      return runner(command, args, options);
    };
    const error = await releasePackage({ ...ctx, mergeCommit: ctx.run.headSha }).catch(error => error);
    const diagnostic = ctx.events.find(event => event.type === 'delivery.command_failed').data;
    assertBoundaryFailure(error, stream, defaultOutputCap, diagnostic);
    assert.equal(diagnostic.stdout, error.stdout);
    assert.equal(diagnostic.stderr, error.stderr);
    assert.equal(diagnostic.code, error.code);
    assert.equal(diagnostic.exitCode, error.exitCode);
    assert.equal(diagnostic.outputTruncated, true);
    assert.equal(JSON.stringify(diagnostic).includes(boundarySecret.slice(0, -1)), false);
    assert.equal(error.cleanupErrors, undefined);
    await assert.rejects(readFile(path.join(source, 'package.json')), { code: 'ENOENT' });
    assert.equal(ctx.leases.size, 0);
    assert.equal(ctx.state.releaseCreates, 0);
    assert.equal(ctx.run.delivery?.release, undefined);
  });
}

test('Output boundary redaction handles every split small caps long secrets and UTF8 without retaining later chunks', async t => {
  // The real default-cap processes above cover the OS boundary. This controlled
  // stream fixture additionally forces every byte split, including UTF8 bytes;
  // an OS is free to coalesce writes and cannot promise those partitions.
  let chunks = [],
    code = 7;
  const mocked = t.mock.method(childProcess, 'spawn', () => {
    const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough() });
    queueMicrotask(() => {
      for (const [stream, chunk] of chunks) child[stream].write(chunk);
      child.stdout.end();
      child.stderr.end();
      child.emit('close', code);
    });
    return child;
  });
  syncBuiltinESMExports();
  try {
    for (const stream of ['stdout', 'stderr']) {
      chunks = [[stream, Buffer.from('assertion\n' + boundarySecret.slice(0, -1))]];
      const overlapError = await execute('fixture-stream', [], {
        env: { ...process.env, NPM_TOKEN: boundarySecret },
        secrets: { NPM_TOKEN: boundarySecret.slice(0, 20) },
      }).catch(error => error);
      assert.equal(
        overlapError[stream],
        'assertion\n[REDACTED]',
        'a shorter explicit value must not hide the env-only boundary match',
      );
      const marker = 'assertion\n',
        raw = Buffer.from(marker + boundarySecret.slice(0, -1));
      for (let split = 0; split <= raw.length; split++) {
        chunks = [
          [stream, raw.subarray(0, split)],
          [stream, raw.subarray(split)],
        ];
        const error = await execute('fixture-stream', [], { secrets: { NPM_TOKEN: boundarySecret } }).catch(
          error => error,
        );
        assert.equal(error.code, 'command_failed');
        assert.equal(error.exitCode, 7);
        assert.equal(error[stream], marker + '[REDACTED]', `${stream} byte split ${split}`);
        assert.equal(error.result[stream], error[stream]);
      }
      for (let cap = 1; cap <= boundarySecret.length + 1; cap++) {
        chunks = [[stream, Buffer.from(boundarySecret + '!')]];
        const error = await execute('fixture-stream', [], {
          maxOutputBytes: cap,
          secrets: { NPM_TOKEN: boundarySecret },
        }).catch(error => error);
        assert.equal(error.code, cap < boundarySecret.length + 1 ? 'invalid_output' : 'command_failed');
        assert.equal(error[stream].includes(boundarySecret.slice(0, Math.min(cap, boundarySecret.length))), false);
        assert.ok(Buffer.byteLength(error.stdout) + Buffer.byteLength(error.stderr) <= cap);
        assert.equal(error.result.outputTruncated, cap < boundarySecret.length + 1 ? true : undefined);
      }
      const longSecret = 'ab'.repeat(65536) + 'Z';
      chunks = [[stream, Buffer.from(longSecret.slice(0, 4097))]];
      const longError = await execute('fixture-stream', [], {
        maxOutputBytes: 4096,
        secrets: { NPM_TOKEN: longSecret },
      }).catch(error => error);
      assert.equal(longError.code, 'invalid_output');
      assert.equal(longError[stream], '[REDACTED]');
      assert.ok(Buffer.byteLength(longError[stream]) <= 4096);
      // Overlapping proper prefixes need fallback, rather than the last start
      // character alone; different known values may share the same prefix.
      chunks = [[stream, Buffer.from('assertion\nabababa')]];
      const repeatedError = await execute('fixture-stream', [], {
        secrets: { first: 'abababac', second: 'abababad' },
      }).catch(error => error);
      assert.equal(repeatedError[stream], 'assertion\n*******');
      chunks = [[stream, Buffer.from('assertion\naaaaaaa')]];
      const completeOverlap = await execute('fixture-stream', [], { secrets: { first: 'aaaaaa' } }).catch(
        error => error,
      );
      assert.equal(
        completeOverlap[stream],
        'assertion\n*****',
        'a full match overlapping the boundary must not become a visible prefix',
      );
      const unicodeSecret = 'ключ😀-fictional-value';
      const unicodeRaw = Buffer.from('assertion\n' + unicodeSecret.slice(0, -1));
      for (let split = 0; split <= unicodeRaw.length; split++) {
        chunks = [
          [stream, unicodeRaw.subarray(0, split)],
          [stream, unicodeRaw.subarray(split)],
        ];
        const error = await execute('fixture-stream', [], { secrets: { NPM_TOKEN: unicodeSecret } }).catch(
          error => error,
        );
        assert.equal(error[stream], 'assertion\n[REDACTED]', `${stream} Unicode byte split ${split}`);
      }
    }
    // Freeze capture at the first exceeded chunk, even when a partial Unicode
    // character left room. No later stream/chunk may fill that gap.
    chunks = [
      ['stdout', Buffer.from('ok😀')],
      ['stderr', Buffer.from('late')],
    ];
    const unicodeError = await execute('fixture-stream', [], { maxOutputBytes: 5, env: {} }).catch(error => error);
    assert.equal(unicodeError.code, 'invalid_output');
    assert.equal(unicodeError.stdout, 'ok');
    assert.equal(unicodeError.stderr, '');
    chunks = [['stdout', Buffer.from('ok�overflow')]];
    const replacementError = await execute('fixture-stream', [], { maxOutputBytes: 5 }).catch(error => error);
    assert.equal(replacementError.stdout, 'ok�', 'a valid replacement character is ordinary UTF8 data');
    // Full secrets split into one-byte chunks are still removed on failure.
    const text = 'assertion Привет 😀\0 ' + boundarySecret + '\n';
    chunks = [...Buffer.from(text)].map(byte => ['stdout', Buffer.from([byte])]);
    const fullError = await execute('fixture-stream', [], { secrets: { NPM_TOKEN: boundarySecret } }).catch(
      error => error,
    );
    assert.equal(fullError.stdout, 'assertion Привет 😀\0 [REDACTED]\n');
    // Successful machine output (including a secret-looking prefix) stays raw.
    code = 0;
    const raw = text + boundarySecret.slice(0, -1);
    chunks = [...Buffer.from(raw)].map(byte => ['stdout', Buffer.from([byte])]);
    assert.equal((await execute('fixture-stream', [], { secrets: { NPM_TOKEN: boundarySecret } })).stdout, raw);
  } finally {
    mocked.mock.restore();
    syncBuiltinESMExports();
  }
});

for (const mode of ['timeout', 'cancelled']) {
  test(`Output boundary redaction protects unfinished real streams on ${mode}`, { timeout: 40000 }, async t => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'kodo-delivery-test-'));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const readyPath = path.join(directory, 'ready.json'),
      ready = readyFile(directory, 'ready.json');
    const controller = new AbortController();
    const script = `
      const fs=require('node:fs'),secret=JSON.parse(fs.readFileSync(process.argv[1],'utf8'));
      if(process.env.NPM_TOKEN!==undefined)throw new Error('credential was forwarded');
      process.stdout.write('actionable stdout\\n'+secret.slice(0,17),()=>{
        process.stderr.write('actionable stderr\\n'+secret.slice(0,29),()=>{
          setInterval(()=>{},1000);fs.writeFileSync(process.argv[2],JSON.stringify({ready:true}));
        });
      });
    `;
    const configFile = path.join(directory, 'fictional-key.json');
    await writeFile(configFile, JSON.stringify(boundarySecret));
    const outcome = execute(process.execPath, ['-e', script, configFile, readyPath], {
      cwd: directory,
      env: { ...process.env, NPM_TOKEN: boundarySecret },
      signal: controller.signal,
      timeoutMs: mode === 'timeout' ? 4000 : 15000,
    }).catch(error => error);
    assert.deepEqual(await ready, { ready: true });
    if (mode === 'cancelled') controller.abort();
    const error = await outcome;
    assert.equal(error.code, mode);
    assert.equal(error.exitCode, process.platform === 'win32' ? 1 : null);
    assert.equal(error.stdout, 'actionable stdout\n[REDACTED]');
    assert.equal(error.stderr, 'actionable stderr\n[REDACTED]');
    assert.equal(error.result.stdout, error.stdout);
    assert.equal(error.result.stderr, error.stderr);
    assert.equal(error.result.outputTruncated, undefined);
    assert.equal(error.teardownError, undefined);
    for (const representation of [error.message, error.stack, JSON.stringify(error)]) {
      assert.equal(representation.includes(boundarySecret.slice(0, 17)), false);
    }
  });
}

for (const mode of ['exit', 'timeout', 'cancelled']) {
  test(`Credential redaction covers real release command errors on ${mode}`, { timeout: 40000 }, async t => {
    const data = await credentialRedactionFixture(t),
      { ctx, configFile } = data;
    const controller = new AbortController(),
      runner = ctx.exec;
    const readyPath = path.join(ctx.root, 'credential-ready.json');
    const ready = mode === 'exit' ? undefined : readyFile(ctx.root, path.basename(readyPath));
    const script = `
      const fs=require('node:fs'),{environmentOnly,explicit}=JSON.parse(fs.readFileSync(process.argv[1],'utf8'));
      if(process.env.NPM_TOKEN!==undefined)throw new Error('credential was forwarded');
      if(process.env.FIXTURE_RELEASE_VALUE!=='kept')throw new Error('safe environment was lost');
      process.stdout.write('first assertion '+environmentOnly+'\\n'+'detail\\n'.repeat(9000)+'tail '+explicit+'\\n');
      process.stderr.write('last failure '+environmentOnly+' / '+explicit+'\\n');
      if(process.argv[2]==='exit')process.exitCode=6;
      else {setInterval(()=>{},1000);fs.writeFileSync(process.argv[3],JSON.stringify({ready:true}));}
    `;
    ctx.config.commands.test = [
      {
        command: process.execPath,
        args: ['-e', script, configFile, mode, readyPath],
        timeoutMs: mode === 'timeout' ? 4000 : 15000,
      },
    ];
    let source, redactions, environment;
    ctx.exec = async (command, args, options) => {
      if (command === process.execPath && args[2] === configFile) {
        source = options.cwd;
        redactions = options.secrets;
        environment = options.env;
      }
      return runner(command, args, options);
    };
    const outcome = releasePackage({ ...ctx, mergeCommit: ctx.run.headSha, signal: controller.signal }).catch(
      error => error,
    );
    if (ready) {
      assert.deepEqual(await ready, { ready: true });
      if (mode === 'cancelled') controller.abort();
    }
    const error = await outcome;
    assertCredentialFailure(
      error,
      data,
      mode === 'exit' ? 'command_failed' : mode,
      mode === 'exit' ? 6 : process.platform === 'win32' ? 1 : null,
    );
    assert.ok(Object.values(redactions).includes(data.environmentOnly));
    assert.ok(Object.values(redactions).includes(data.explicit));
    assert.equal(environment.NPM_TOKEN, undefined);
    assert.equal(environment.FIXTURE_RELEASE_VALUE, 'kept');
    const diagnostic = ctx.events.find(event => event.type === 'delivery.command_failed').data;
    assert.equal(diagnostic.stdout, error.stdout);
    assert.equal(diagnostic.stderr, error.stderr);
    assert.equal(diagnostic.code, error.code);
    assert.equal(diagnostic.exitCode, error.exitCode);
    assert.equal(diagnostic.outputTruncated, false);
    assert.equal(error.cleanupErrors, undefined);
    assert.equal(error.teardownError, undefined);
    await assert.rejects(readFile(path.join(source, 'package.json')), { code: 'ENOENT' });
    assert.equal(ctx.leases.size, 0);
    assert.equal(ctx.state.releaseCreates, 0);
    assert.equal(ctx.run.delivery?.release, undefined);
  });
}

for (const mode of ['result', 'command_failed', 'timeout', 'cancelled', 'frozen']) {
  test(`Credential redaction covers fallback runner errors on ${mode}`, async t => {
    const data = await credentialRedactionFixture(t),
      { ctx, environmentOnly, explicit } = data;
    const runner = ctx.exec;
    ctx.config.commands.test = [{ command: 'fixture-redaction' }];
    const stdout = `first assertion ${environmentOnly}\n` + 'detail\n'.repeat(9000) + `tail ${explicit}\n`;
    const stderr = `last failure ${environmentOnly} / ${explicit}\n`;
    const result = {
      stdout,
      stderr,
      code: 7,
      outputTruncated: true,
      diagnostics: { detail: `config ${environmentOnly} / ${explicit}` },
    };
    const code = mode === 'result' || mode === 'frozen' ? 'command_failed' : mode;
    const primary = Object.assign(
      new TypeError(`fixture failure ${environmentOnly} / ${explicit}: first assertion; last failure`, {
        cause: new Error(`config ${environmentOnly}`),
      }),
      { code, exitCode: 7, stdout, stderr, result },
    );
    // Node 24 exposes stack through an accessor even after it has been cached.
    void primary.stack;
    void primary.cause.stack;
    if (mode === 'frozen') {
      Object.freeze(primary);
      Object.freeze(result);
    }
    let source, redactions;
    ctx.exec = async (command, args, options) => {
      if (command !== 'fixture-redaction') return runner(command, args, options);
      source = options.cwd;
      redactions = options.secrets;
      assert.equal(options.env.NPM_TOKEN, undefined);
      if (mode === 'result') return result;
      throw primary;
    };
    const error = await releasePackage({ ...ctx, mergeCommit: ctx.run.headSha }).catch(error => error);
    assertCredentialFailure(error, data, code, 7);
    assert.equal(error.result.diagnostics.detail, 'config [REDACTED] / [REDACTED]');
    assert.equal(error.result.outputTruncated, true);
    if (mode !== 'result') {
      if (mode === 'frozen') assert.notEqual(error, primary);
      else assert.equal(error, primary);
      assert.ok(error instanceof TypeError);
      assert.equal(error.cause.message, 'config [REDACTED]');
      assert.equal(error.cause.stack.includes(environmentOnly), false);
    }
    assert.ok(Object.values(redactions).includes(environmentOnly));
    assert.ok(Object.values(redactions).includes(explicit));
    const diagnostic = ctx.events.find(event => event.type === 'delivery.command_failed').data;
    assert.equal(diagnostic.stdout, error.stdout);
    assert.equal(diagnostic.stderr, error.stderr);
    assert.equal(diagnostic.exitCode, 7);
    assert.equal(diagnostic.outputTruncated, true);
    assert.equal(JSON.stringify(ctx.events).includes(environmentOnly), false);
    assert.equal(JSON.stringify(ctx.events).includes(explicit), false);
    await assert.rejects(readFile(path.join(source, 'package.json')), { code: 'ENOENT' });
    assert.equal(ctx.leases.size, 0);
    assert.equal(ctx.state.releaseCreates, 0);
    assert.equal(ctx.run.delivery?.release, undefined);
  });
}

test('Delivery lifecycle preserves cwd environment stdin EOF and allowFailure', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'kodo-delivery-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const result = await execute(
    process.execPath,
    [
      '-e',
      "let input='';process.stdin.on('data',x=>input+=x);process.stdin.on('end',()=>{console.log(JSON.stringify({cwd:process.cwd(),value:process.env.FIXTURE_VALUE,secret:process.env.NPM_TOKEN,input}));process.exit(7)});process.stdin.resume()",
    ],
    {
      cwd: directory,
      env: { ...process.env, FIXTURE_VALUE: 'kept', NPM_TOKEN: 'fixture-never-forward' },
      allowFailure: true,
    },
  );
  assert.equal(result.code, 7);
  assert.deepEqual(JSON.parse(result.stdout), { cwd: directory, value: 'kept', input: '' });
});

test('Delivery lifecycle pre-aborted execution never starts a command', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'kodo-delivery-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    execute(process.execPath, ['-e', "require('fs').writeFileSync('unexpected','started')"], {
      cwd: directory,
      signal: controller.signal,
    }),
    { code: 'cancelled' },
  );
  assert.deepEqual(await readdir(directory), []);
});

test('Release lifecycle forwards explicit and default test and build deadlines', async t => {
  const ctx = await fixture(t),
    runner = ctx.exec,
    observed = [];
  await ctx.git('push', 'origin', `${ctx.run.headSha}:main`);
  ctx.config.commands.test = [
    { command: 'fixture-check', args: ['explicit'], timeoutMs: 71 },
    { command: 'fixture-check', args: ['default-test'] },
  ];
  ctx.config.commands.build = [
    { command: 'fixture-check', args: ['default-build'] },
    { command: 'fixture-check', args: ['explicit-build'], timeoutMs: 93 },
  ];
  ctx.exec = async (command, args, options) => {
    if (command === 'fixture-check') {
      observed.push([args[0], options.timeoutMs]);
      return { stdout: '', code: 0 };
    }
    return runner(command, args, options);
  };
  const release = await releasePackage({ ...ctx, mergeCommit: ctx.run.headSha });
  assert.equal(release.published, true);
  assert.deepEqual(observed, [
    ['explicit', 71],
    ['default-test', 1200000],
    ['default-build', 1200000],
    ['explicit-build', 93],
  ]);
  const self = JSON.parse(await readFile(new URL('../kodo.config.json', import.meta.url), 'utf8'));
  assert.deepEqual(self.commands.test, [{ command: 'npm', args: ['run', 'check'], timeoutMs: 1800000 }]);
});

for (const code of ['timeout', 'command_failed', 'cancelled']) {
  test(`Release lifecycle retains primary ${code} when owned cleanup refuses a replaced link`, async t => {
    const ctx = await fixture(t),
      runner = ctx.exec;
    await ctx.git('push', 'origin', `${ctx.run.headSha}:main`);
    ctx.config.commands.test = [{ command: 'fixture-primary' }];
    const external = path.join(ctx.root, 'external');
    await mkdir(external);
    await writeFile(path.join(external, 'sentinel'), 'must survive');
    const primary = Object.assign(new Error('primary diagnostic'), {
      code,
      stdout: 'first actionable failure',
      stderr: 'more detail',
    });
    let directory, moved;
    ctx.exec = async (command, args, options) => {
      if (command === 'fixture-primary') {
        directory = path.dirname(options.cwd);
        moved = `${directory}-displaced`;
        await rename(directory, moved);
        await symlink(external, directory, process.platform === 'win32' ? 'junction' : 'dir');
        throw primary;
      }
      return runner(command, args, options);
    };
    t.after(async () => {
      if (directory) await rm(directory, { force: true });
      if (moved) {
        assert.equal(path.dirname(moved), path.resolve(os.tmpdir()));
        assert.ok(path.basename(moved).startsWith('kodo-release-'));
        await rm(moved, { recursive: true, force: true });
      }
    });
    await assert.rejects(releasePackage({ ...ctx, mergeCommit: ctx.run.headSha }), error => {
      assert.equal(error, primary);
      assert.equal(error.stdout, 'first actionable failure');
      assert.ok(error.cleanupErrors.some(item => item.code === 'unsafe_path'));
      return true;
    });
    assert.equal(await readFile(path.join(external, 'sentinel'), 'utf8'), 'must survive');
    assert.ok(ctx.events.some(event => event.type === 'delivery.cleanup_failed' && event.data.code === 'unsafe_path'));
    assert.equal(ctx.leases.size, 0);
    assert.equal(ctx.state.releaseCreates, 0);
    assert.equal(ctx.run.delivery?.release, undefined);
  });
}

for (const code of ['timeout', 'command_failed', 'cancelled']) {
  test(`Release lifecycle retains primary ${code} after bounded EBUSY cleanup retries`, async t => {
    const ctx = await fixture(t),
      runner = ctx.exec;
    await ctx.git('push', 'origin', `${ctx.run.headSha}:main`);
    ctx.config.commands.test = [{ command: 'fixture-primary' }];
    const primary = Object.assign(new Error('primary fixture failure'), {
      code,
      stdout: 'original assertion',
      stderr: 'original stderr',
    });
    let directory,
      attempts = 0;
    const nativeRemove = fs.promises.rm;
    const mocked = t.mock.method(fs.promises, 'rm', async (target, options) => {
      if (target === directory) {
        attempts++;
        throw Object.assign(new Error('fixture locked release directory'), { code: 'EBUSY' });
      }
      return nativeRemove(target, options);
    });
    syncBuiltinESMExports();
    ctx.exec = async (command, args, options) => {
      if (command === 'fixture-primary') {
        directory = path.dirname(options.cwd);
        throw primary;
      }
      return runner(command, args, options);
    };
    try {
      await assert.rejects(releasePackage({ ...ctx, mergeCommit: ctx.run.headSha }), error => {
        assert.equal(error, primary);
        assert.equal(error.stdout, 'original assertion');
        assert.equal(error.stderr, 'original stderr');
        assert.ok(error.cleanupErrors.some(item => item.code === 'EBUSY'));
        return true;
      });
      assert.equal(attempts, 4);
      assert.equal(ctx.leases.size, 0);
      assert.equal(ctx.state.releaseCreates, 0);
      assert.ok(ctx.events.some(event => event.type === 'delivery.cleanup_failed' && event.data.code === 'EBUSY'));
    } finally {
      mocked.mock.restore();
      syncBuiltinESMExports();
      if (directory) {
        assert.equal(path.dirname(directory), path.resolve(os.tmpdir()));
        assert.ok(path.basename(directory).startsWith('kodo-release-'));
        await nativeRemove(directory, { recursive: true, force: true });
      }
    }
  });
}

test('Release lifecycle retries transient locks and keeps a confirmed published receipt on persistent cleanup failure', async t => {
  for (const persistent of [false, true]) {
    const ctx = await fixture(t),
      runner = ctx.exec;
    await ctx.git('push', 'origin', `${ctx.run.headSha}:main`);
    let directory,
      attempts = 0;
    const nativeRemove = fs.promises.rm;
    const mocked = t.mock.method(fs.promises, 'rm', async (target, options) => {
      if (target === directory && ++attempts <= (persistent ? 4 : 2))
        throw Object.assign(new Error('fixture temporary lock'), { code: 'EBUSY' });
      return nativeRemove(target, options);
    });
    syncBuiltinESMExports();
    ctx.exec = async (command, args, options) => {
      if (command === 'git' && args[0] === 'worktree' && args[1] === 'add') directory = path.dirname(args[3]);
      return runner(command, args, options);
    };
    try {
      const receipt = await releasePackage({ ...ctx, mergeCommit: ctx.run.headSha });
      assert.equal(receipt.published, true);
      assert.deepEqual(ctx.run.delivery.release, receipt);
      assert.equal(attempts, persistent ? 4 : 3);
      assert.equal(ctx.leases.size, 0);
      assert.equal(
        ctx.events.some(event => event.type === 'delivery.cleanup_failed'),
        persistent,
      );
    } finally {
      mocked.mock.restore();
      syncBuiltinESMExports();
      if (directory) {
        assert.equal(path.dirname(directory), path.resolve(os.tmpdir()));
        assert.ok(path.basename(directory).startsWith('kodo-release-'));
        await nativeRemove(directory, { recursive: true, force: true });
      }
    }
  }
});

test('Lost merge lease stops mutation and heartbeat cleanup releases the token', async t => {
  const ctx = await fixture(t);
  let signalRenewal;
  const renewed = new Promise(resolve => (signalRenewal = resolve));
  let renewals = 0;
  ctx.store.renewLease = () => {
    renewals++;
    signalRenewal();
    return false;
  };
  const runner = ctx.exec;
  ctx.exec = async (command, args, options) => {
    if (command === 'git' && args[0] === 'fetch' && ctx.leases.size) await renewed;
    return runner(command, args, options);
  };
  await assert.rejects(deliver({ ...ctx, leaseHeartbeatMs: 1 }), { code: 'lease_lost' });
  assert.ok(renewals > 0);
  assert.equal(ctx.state.merges, 0);
  assert.equal(ctx.leases.size, 0);
});

test('Release version preparation updates only metadata and resumes without another bump', async t => {
  const ctx = await fixture(t);
  const manifest = JSON.parse(await readFile(path.join(ctx.project, 'package.json'), 'utf8'));
  manifest.version = '0.1.0';
  await writeFile(path.join(ctx.project, 'package.json'), JSON.stringify(manifest));
  await writeFile(
    path.join(ctx.project, 'package-lock.json'),
    JSON.stringify({
      name: manifest.name,
      version: '0.1.0',
      lockfileVersion: 3,
      packages: { '': { name: manifest.name, version: '0.1.0' } },
    }),
  );
  await writeFile(
    path.join(ctx.project, 'registry.json'),
    JSON.stringify({ schemaVersion: 1, version: '0.1.0', components: [{ id: 'skills/example', version: '0.1.0' }] }),
  );
  const prepared = await prepareReleaseVersion(ctx);
  assert.equal(prepared.version, '0.2.0');
  assert.deepEqual(prepared.files, ['package.json', 'package-lock.json', 'registry.json']);
  assert.equal(JSON.parse(await readFile(path.join(ctx.project, 'package-lock.json'))).packages[''].version, '0.2.0');
  const registry = JSON.parse(await readFile(path.join(ctx.project, 'registry.json')));
  assert.equal(registry.version, '0.2.0');
  assert.equal(registry.components[0].version, '0.1.0');
  assert.equal(ctx.run.releaseAssignment.prepared, true);
  const resumed = await prepareReleaseVersion(ctx);
  assert.equal(resumed.version, '0.2.0');
  assert.equal(resumed.changed, false);
  assert.equal(ctx.leases.size, 0);
});

test('Release version preparation bumps past current and latest after target advancement', async t => {
  const ctx = await fixture(t);
  ctx.state.release = { tag: 'v0.2.0' };
  const first = await prepareReleaseVersion(ctx);
  assert.equal(first.version, '0.2.1');
  assert.equal((await prepareReleaseVersion(ctx)).version, '0.2.1');
  ctx.run.baseSha = ctx.run.headSha;
  const synchronized = await prepareReleaseVersion(ctx);
  assert.equal(synchronized.version, '0.2.1');
  assert.equal(synchronized.changed, false);
  ctx.state.release.tag = 'v0.2.1';
  const next = await prepareReleaseVersion(ctx);
  assert.equal(next.version, '0.2.2');
  assert.equal(ctx.leases.size, 0);
});

test('Release reconciliation skips newer drafts and uploads absent assets without replacement', async t => {
  const ctx = await fixture(t);
  const delivered = await deliver(ctx);
  const release = await releasePackage({ ...ctx, mergeCommit: delivered.mergeCommit });
  delete ctx.run.delivery.release; // Simulate crash after publication, before saving its receipt.
  ctx.state.releaseList = [
    { tagName: 'v9.0.0', isDraft: true, isPrerelease: false },
    { tagName: 'v0.2.0', isDraft: false, isPrerelease: false },
  ];
  await rm(path.join(ctx.assets, 'SHA256SUMS'));
  const controller = new AbortController(),
    runner = ctx.exec;
  ctx.exec = async (command, args, options) => {
    if (command === 'gh' && args[0] === 'release' && args[1] === 'upload') {
      assert.equal(options.signal, undefined);
      controller.abort();
    }
    return runner(command, args, options);
  };
  const resumed = await releasePackage({ ...ctx, mergeCommit: delivered.mergeCommit, signal: controller.signal });
  assert.equal(controller.signal.aborted, true);
  assert.equal(resumed.sha256, release.sha256);
  assert.equal(ctx.state.publishes, 1);
  assert.equal(
    (await readFile(path.join(ctx.assets, 'SHA256SUMS'), 'utf8')).trim(),
    `${release.sha256}  ${release.artifact}`,
  );
  assert.equal(ctx.leases.size, 0);
});

test('Release refuses a dangling tag pointing to a different commit', async t => {
  const ctx = await fixture(t);
  await ctx.git('push', 'origin', `${ctx.run.headSha}:main`);
  await ctx.git('tag', 'v0.2.0', ctx.run.baseSha);
  await ctx.git('push', 'origin', 'v0.2.0');
  await assert.rejects(releasePackage({ ...ctx, mergeCommit: ctx.run.headSha }), { code: 'release_conflict' });
  assert.equal(ctx.state.publishes, 0);
  assert.equal(ctx.leases.size, 0);
});

test('Release subprocess environment excludes inherited credentials from npm tests builds and installed smoke', async t => {
  const ctx = await fixture(t);
  const delivered = await deliver(ctx);
  const hostile = {
    NPM_TOKEN: 'fixture-npm-secret',
    AWS_SECRET_ACCESS_KEY: 'fixture-aws-secret',
    GH_TOKEN: 'fixture-github-secret',
    GEMINI_API_KEY: 'fixture-google-secret',
    KODO_GEMINI_API_KEY: 'fixture-kodo-google-secret',
  };
  const before = Object.fromEntries(Object.keys(hostile).map(name => [name, process.env[name]]));
  Object.assign(process.env, hostile);
  const observed = [],
    runner = ctx.exec;
  ctx.config.commands.test = [{ command: process.execPath, args: ['cli.mjs', 'validate'] }];
  ctx.config.commands.build = [{ command: process.execPath, args: ['cli.mjs', '--help'] }];
  ctx.exec = async (command, args, options) => {
    for (const name of Object.keys(hostile).filter(name => name !== 'GH_TOKEN'))
      assert.equal(options.env[name], undefined, `${command} inherited ${name}`);
    const githubTransport =
      command === 'gh' || (command === 'git' && ['fetch', 'push', 'pull', 'clone', 'ls-remote'].includes(args[0]));
    assert.equal(
      options.env.GH_TOKEN,
      githubTransport ? hostile.GH_TOKEN : undefined,
      `${command} GitHub credential boundary`,
    );
    if (!['git', 'gh'].includes(command)) {
      observed.push({ command, args });
      assert.ok(options.env);
      for (const name of Object.keys(hostile))
        assert.equal(options.env[name], undefined, `${command} inherited ${name}`);
    }
    return runner(command, args, options);
  };
  try {
    const release = await releasePackage({ ...ctx, mergeCommit: delivered.mergeCommit });
    assert.equal(release.published, true);
    assert.ok(observed.some(item => item.command === 'npm' && item.args[0] === 'pack'));
    assert.ok(observed.some(item => item.command === 'npm' && item.args[0] === 'install'));
    assert.equal(observed.filter(item => item.command === process.execPath).length, 5);
    const native = await execute(process.execPath, [
      '-e',
      'console.log(JSON.stringify(Object.fromEntries(Object.entries(process.env).filter(([name])=>/NPM_TOKEN|AWS_SECRET_ACCESS_KEY|GH_TOKEN|GEMINI_API_KEY/.test(name)))))',
    ]);
    assert.deepEqual(JSON.parse(native.stdout), {});
  } finally {
    for (const [name, value] of Object.entries(before))
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
  }
});

test('Cancellation during irreversible merge confirms and persists its successful receipt', async t => {
  const ctx = await fixture(t),
    controller = new AbortController(),
    runner = ctx.exec;
  ctx.exec = async (command, args, options) => {
    if (command === 'gh' && args[0] === 'pr' && args[1] === 'merge') {
      assert.equal(options.signal, undefined);
      controller.abort();
    }
    return runner(command, args, options);
  };
  const receipt = await deliver({ ...ctx, signal: controller.signal });
  assert.equal(controller.signal.aborted, true);
  assert.equal(receipt.mergeCommit, ctx.run.headSha);
  assert.equal(ctx.run.delivery.mergeCommit, ctx.run.headSha);
  assert.equal(ctx.state.merges, 1);
  assert.equal(ctx.leases.size, 0);
});

test('Cancellation during release creation verifies publication and saves its receipt', async t => {
  const ctx = await fixture(t);
  const delivered = await deliver(ctx),
    controller = new AbortController(),
    runner = ctx.exec;
  ctx.exec = async (command, args, options) => {
    if (command === 'gh' && args[0] === 'release' && args[1] === 'create') {
      assert.equal(options.signal, undefined);
      controller.abort();
    }
    return runner(command, args, options);
  };
  const receipt = await releasePackage({ ...ctx, mergeCommit: delivered.mergeCommit, signal: controller.signal });
  assert.equal(controller.signal.aborted, true);
  assert.equal(receipt.published, true);
  assert.equal(ctx.run.delivery.release.sha256, receipt.sha256);
  assert.equal(ctx.state.publishes, 1);
  assert.equal(ctx.leases.size, 0);
});

test('Cancellation before irreversible publication prevents release creation', async t => {
  const ctx = await fixture(t);
  const delivered = await deliver(ctx),
    controller = new AbortController(),
    runner = ctx.exec;
  let listings = 0;
  ctx.exec = async (command, args, options) => {
    if (command === 'gh' && args[0] === 'release' && args[1] === 'list' && ++listings === 2) controller.abort();
    return runner(command, args, options);
  };
  await assert.rejects(releasePackage({ ...ctx, mergeCommit: delivered.mergeCommit, signal: controller.signal }), {
    code: 'cancelled',
  });
  assert.equal(ctx.state.publishes, 0);
  assert.equal(ctx.run.delivery.release, undefined);
  assert.equal(ctx.leases.size, 0);
});

test('Release publishes an unreleased merged ancestor after main advances', async t => {
  const ctx = await fixture(t);
  const delivered = await deliver(ctx);
  await writeFile(path.join(ctx.project, 'newer-work.txt'), 'parallel task\n');
  await ctx.git('add', 'newer-work.txt');
  await ctx.git('commit', '-m', 'parallel task');
  await ctx.git('push', 'origin', 'HEAD:main');
  assert.notEqual(await ctx.git('rev-parse', 'origin/main'), delivered.mergeCommit);
  const receipt = await releasePackage({ ...ctx, mergeCommit: delivered.mergeCommit });
  assert.equal(receipt.commit, delivered.mergeCommit);
  assert.equal(receipt.published, true);
  assert.equal(await ctx.git('rev-parse', 'refs/tags/v0.2.0^{commit}'), delivered.mergeCommit);
  assert.equal(ctx.state.releaseCreates, 1);
  assert.equal(ctx.state.publishes, 1);
});

test('Interrupted owned draft is completed and published without a second creation', async t => {
  const ctx = await fixture(t);
  const delivered = await deliver(ctx),
    runner = ctx.exec;
  ctx.exec = async (command, args, options) => {
    const result = await runner(command, args, options);
    if (command === 'gh' && args[0] === 'release' && args[1] === 'create') {
      await rm(path.join(ctx.assets, 'SHA256SUMS'));
      throw Object.assign(new Error('interrupted after draft creation'), { code: 'simulated_disconnect' });
    }
    return result;
  };
  await assert.rejects(releasePackage({ ...ctx, mergeCommit: delivered.mergeCommit }), {
    code: 'simulated_disconnect',
  });
  assert.equal(ctx.state.release.isDraft, true);
  assert.equal(ctx.state.publishes, 0);
  assert.equal(ctx.state.releaseCreates, 1);
  let recoveryPacks = 0;
  ctx.exec = async (command, args, options) => {
    if (command === 'npm' && args[0] === 'pack') {
      recoveryPacks++;
      throw new Error('Another npm version would produce different compressed bytes');
    }
    return runner(command, args, options);
  };
  const receipt = await releasePackage({ ...ctx, mergeCommit: delivered.mergeCommit });
  assert.equal(receipt.published, true);
  assert.equal(ctx.state.release.isDraft, false);
  assert.equal(ctx.state.releaseCreates, 1);
  assert.equal(ctx.state.publishes, 1);
  assert.equal(ctx.state.uploads, 1);
  assert.equal(recoveryPacks, 0);
  assert.equal(ctx.run.delivery.release.sha256, receipt.sha256);
  assert.equal(ctx.leases.size, 0);
});

test('Release never changes an unrelated matching-tag draft', async t => {
  const ctx = await fixture(t);
  await ctx.git('push', 'origin', `${ctx.run.headSha}:main`);
  ctx.state.release = {
    tag: 'v0.2.0',
    isDraft: true,
    targetCommitish: ctx.run.headSha,
    body: 'Human draft; unrelated to this Kodo run',
    url: 'https://github.com/test/kodo/releases/tag/v0.2.0',
  };
  await assert.rejects(releasePackage({ ...ctx, mergeCommit: ctx.run.headSha }), { code: 'release_conflict' });
  assert.equal(ctx.state.release.body, 'Human draft; unrelated to this Kodo run');
  assert.equal(ctx.state.releaseCreates, 0);
  assert.equal(ctx.state.publishes, 0);
  assert.equal(ctx.state.uploads, 0);
  assert.equal(
    ctx.calls.some(
      call =>
        call.command === 'gh' && call.args[0] === 'release' && ['edit', 'upload', 'create'].includes(call.args[1]),
    ),
    false,
  );
  assert.equal(ctx.leases.size, 0);
});

test('Merge rechecks release assignment under the shared publication lease after CI', async t => {
  const ctx = await fixture(t),
    runner = ctx.exec;
  let views = 0,
    checkedWhileLocked = false;
  ctx.exec = async (command, args, options) => {
    if (command === 'gh' && args[0] === 'pr' && args[1] === 'view' && ++views === 2)
      ctx.state.release = { tag: 'v0.2.0' };
    if (command === 'gh' && args[0] === 'release' && args[1] === 'list')
      checkedWhileLocked = ctx.leases.has('merge:test/kodo:main') && ctx.leases.has('release:test/kodo:main');
    return runner(command, args, options);
  };
  await assert.rejects(deliver(ctx), { code: 'stale_base' });
  assert.equal(checkedWhileLocked, true);
  assert.equal(ctx.state.merges, 0);
  assert.equal(ctx.run.delivery.pr.number, 7);
  assert.equal(ctx.leases.size, 0);
});

test('Published release recovery verifies and smoke tests remote archive without repacking changed npm output', async t => {
  const ctx = await fixture(t);
  const delivered = await deliver(ctx);
  const first = await releasePackage({ ...ctx, mergeCommit: delivered.mergeCommit });
  delete ctx.run.delivery.release;
  const runner = ctx.exec;
  let packs = 0,
    installedRemote = false;
  ctx.exec = async (command, args, options) => {
    if (command === 'npm' && args[0] === 'pack') {
      packs++;
      return { stdout: '{"different-npm":{"filename":"changed-format.tgz"}}', code: 0 };
    }
    if (command === 'npm' && args[0] === 'install') {
      const archive = args.at(-1);
      installedRemote = digest(await readFile(archive)) === first.sha256 && archive.includes('recover-');
    }
    return runner(command, args, options);
  };
  const resumed = await releasePackage({ ...ctx, mergeCommit: delivered.mergeCommit });
  assert.equal(resumed.sha256, first.sha256);
  assert.equal(resumed.smoke.passed, true);
  assert.equal(installedRemote, true);
  assert.equal(packs, 0);
  assert.equal(ctx.state.releaseCreates, 1);
  assert.equal(ctx.state.publishes, 1);
  assert.equal(ctx.state.uploads, 0);
});

test('Coordinator Git disables credential-reading repository hooks for push and fetch', async t => {
  const ctx = await fixture(t),
    hooks = path.join(ctx.root, 'hostile-hooks'),
    marker = path.join(ctx.root, 'hook-ran.txt');
  await mkdir(hooks);
  const quoted = marker.replaceAll('\\', '/').replaceAll("'", "'\\''");
  const script = `#!/bin/sh\nprintf '%s' "$GH_TOKEN" > '${quoted}'\nexit 42\n`;
  for (const name of ['pre-push', 'reference-transaction']) {
    const filename = path.join(hooks, name);
    await writeFile(filename, script);
    await chmod(filename, 0o755);
  }
  await ctx.git('config', 'core.hooksPath', hooks);
  const env = { ...process.env, GH_TOKEN: 'fixture-git-coordinator-secret' };
  const control = spawnSync('git', ['push', 'origin', 'HEAD:refs/heads/unprotected-proof'], {
    cwd: ctx.project,
    env,
    encoding: 'utf8',
    windowsHide: true,
  });
  assert.notEqual(control.status, 0);
  assert.equal(await readFile(marker, 'utf8'), env.GH_TOKEN);
  await rm(marker);
  await execute('git', ['push', 'origin', 'HEAD:refs/heads/protected-proof'], { cwd: ctx.project, env });
  await execute('git', ['update-ref', 'refs/heads/fetch-proof', ctx.run.headSha], { cwd: ctx.remote, env });
  await execute('git', ['fetch', 'origin'], { cwd: ctx.project, env });
  await assert.rejects(readFile(marker), { code: 'ENOENT' });
});

test('Squash merge reconciliation uses immutable reviewed head after the local branch resynchronizes', async t => {
  const ctx = await fixture(t);
  ctx.state.squashMerge = true;
  const originalHead = ctx.run.headSha;
  const delivered = await deliver(ctx);
  const squashCommit = delivered.mergeCommit;
  assert.notEqual(squashCommit, originalHead);
  await ctx.git('merge', '--no-edit', squashCommit);
  const synchronizedHead = await ctx.git('rev-parse', 'HEAD');
  assert.notEqual(synchronizedHead, originalHead);
  assert.notEqual(synchronizedHead, squashCommit);
  ctx.run.headSha = synchronizedHead;
  delete ctx.run.delivery.mergeCommit; // Process died after remote merge, before persisting the result.
  const before = ctx.calls.length;
  const reconciled = await reconcileDelivery(ctx);
  assert.equal(reconciled.mergeCommit, squashCommit);
  assert.equal(reconciled.reviewedHead, originalHead);
  assert.equal(ctx.run.headSha, synchronizedHead);
  assert.deepEqual(
    ctx.calls.slice(before).map(call => [call.command, ...call.args.slice(0, 2)]),
    [['gh', 'pr', 'view']],
  );
  assert.equal((await deliver(ctx)).mergeCommit, squashCommit);
  assert.equal(ctx.state.creates, 1);
  assert.equal(ctx.state.merges, 1);
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
  assert.deepEqual(
    ctx.calls.map(call => [call.command, ...call.args.slice(0, 2)]),
    [['gh', 'pr', 'view']],
  );
  assert.equal(ctx.state.merges, 0);
});

test('Second assigned run bumps past a merged but unpublished target version', async t => {
  const ctx = await fixture(t),
    projectB = path.join(ctx.root, 'project-b');
  await ctx.git('worktree', 'add', '-b', 'kodo/test-b', projectB, ctx.run.baseSha);
  const gitB = async (...args) => (await execute('git', args, { cwd: projectB })).stdout.trim();
  const manifestB = JSON.parse(await readFile(path.join(projectB, 'package.json'), 'utf8'));
  manifestB.version = '0.2.0';
  await writeFile(path.join(projectB, 'package.json'), JSON.stringify(manifestB));
  await writeFile(path.join(projectB, 'task-b.txt'), 'independent task B\n');
  await gitB('add', '.');
  await gitB('commit', '-m', 'task B initially assigned same version');
  const runB = {
    ...structuredClone(ctx.run),
    id: 'run-b',
    project: projectB,
    branch: 'kodo/test-b',
    headSha: await gitB('rev-parse', 'HEAD'),
    delivery: undefined,
  };
  const deliveredA = await deliver(ctx);
  assert.equal(ctx.state.publishes, 0);
  assert.equal(ctx.state.release, null);
  await gitB('fetch', 'origin', 'main');
  await gitB('merge', '--no-edit', 'origin/main');
  runB.baseSha = deliveredA.mergeCommit;
  runB.headSha = await gitB('rev-parse', 'HEAD');
  const storeB = {
    ...ctx.store,
    updateRun(id, patch) {
      assert.equal(id, runB.id);
      Object.assign(runB, patch);
    },
  };
  const optionsB = { ...ctx, run: runB, cwd: projectB, store: storeB };
  const prepared = await prepareReleaseVersion(optionsB);
  assert.equal(prepared.version, '0.2.1');
  assert.equal(prepared.changed, true);
  assert.equal(JSON.parse(await readFile(path.join(projectB, 'package.json'))).version, '0.2.1');
  assert.equal((await prepareReleaseVersion(optionsB)).changed, false);
  assert.equal(ctx.state.publishes, 0);
  assert.equal(ctx.state.release, null);
  assert.equal(ctx.leases.size, 0);
});

test('Merge rejects a target-reserved version even before any release is published', async t => {
  const ctx = await fixture(t);
  const reservedHead = ctx.run.headSha;
  await ctx.git('push', 'origin', `${reservedHead}:main`);
  await writeFile(path.join(ctx.project, 'task-b.txt'), 'more work with stale assigned version\n');
  await ctx.git('add', 'task-b.txt');
  await ctx.git('commit', '-m', 'second task after first merge');
  ctx.run.baseSha = reservedHead;
  ctx.run.headSha = await ctx.git('rev-parse', 'HEAD');
  ctx.state.prHead = ctx.run.headSha;
  ctx.review.headSha = ctx.run.headSha;
  ctx.review.diffHash = digest(
    (
      await execute('git', ['diff', '--binary', `${ctx.run.baseSha}...${ctx.run.headSha}`], { cwd: ctx.project })
    ).stdout.trimEnd(),
  );
  await assert.rejects(deliver(ctx), { code: 'stale_base', targetVersion: '0.2.0' });
  assert.equal(ctx.state.merges, 0);
  assert.equal(ctx.state.publishes, 0);
  assert.equal(ctx.state.release, null);
  assert.equal(ctx.leases.size, 0);
});

test('Release freshness fetches a newly announced tag before resolving its commit', async t => {
  const ctx = await fixture(t);
  const delivered = await deliver(ctx),
    runner = ctx.exec;
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
      if (ctx.state.release)
        inventory.push({
          tagName: ctx.state.release.tag,
          isDraft: Boolean(ctx.state.release.isDraft),
          isPrerelease: false,
        });
      return { stdout: JSON.stringify(inventory), code: 0 };
    }
    return runner(command, args, options);
  };
  const receipt = await releasePackage({ ...ctx, mergeCommit: delivered.mergeCommit });
  assert.equal(receipt.published, true);
  assert.equal(receipt.commit, delivered.mergeCommit);
  assert.equal(await ctx.git('rev-parse', 'refs/tags/v0.1.0^{commit}'), ctx.run.baseSha);
  assert.equal(ctx.state.publishes, 1);
  assert.equal(ctx.leases.size, 0);
});

const operations = ctx => Object.fromEntries(deliveryOperations(ctx.events).map(item => [item.operation, item.status]));
const timeoutAfter = (ctx, matches) => {
  const runner = ctx.exec;
  let fired = 0;
  ctx.exec = async (command, args, options) => {
    const result = await runner(command, args, options);
    if (command === 'gh' && matches(args) && !fired++)
      throw Object.assign(new Error('network timeout after the remote accepted the request'), { code: 'timeout' });
    return result;
  };
};

test('A network timeout after a successful remote merge is settled by read-back, never by a second merge', async t => {
  const ctx = await fixture(t);
  timeoutAfter(ctx, args => args[0] === 'pr' && args[1] === 'merge');
  const receipt = await deliver(ctx);
  assert.equal(receipt.mergeCommit, ctx.run.headSha);
  assert.equal(ctx.state.merges, 1);
  assert.deepEqual(operations(ctx), { pr: 'confirmed', merge: 'reconciled' });
  assert.deepEqual(uncertainOperations(ctx.events), []);
  // A later delivery of the same run finds the merge by read-back and sends no command.
  assert.equal((await deliver(ctx)).mergeCommit, receipt.mergeCommit);
  assert.equal(ctx.state.merges, 1);
  assert.equal(ctx.state.creates, 1);
  assert.equal(ctx.leases.size, 0);
});

test('A crash between the remote merge and its saved receipt leaves an uncertain operation that resume reconciles', async t => {
  const ctx = await fixture(t),
    save = ctx.store.updateRun;
  let crash = true,
    persisted;
  ctx.store.updateRun = (id, patch) => {
    if (crash && patch.delivery?.mergeCommit) {
      crash = false;
      throw new Error('process died before the receipt was saved');
    }
    if (patch.delivery) persisted = structuredClone(patch.delivery);
    return save(id, patch);
  };
  await assert.rejects(deliver(ctx), /process died/);
  assert.equal(ctx.state.merges, 1, 'the remote merge happened');
  // A new process loads what was actually persisted: the PR, but no merge receipt.
  ctx.run.delivery = persisted;
  assert.equal(ctx.run.delivery.pr.number, 7);
  assert.equal(ctx.run.delivery.mergeCommit, undefined, 'the saved state does not know about the merge');
  assert.deepEqual(uncertainOperations(ctx.events), ['merge'], 'the journal says the effect is uncertain');
  assert.equal(ctx.leases.size, 0);

  const receipt = await deliver(ctx);
  assert.equal(receipt.mergeCommit, ctx.run.headSha);
  assert.equal(ctx.state.merges, 1, 'resume read the remote state back instead of merging again');
  assert.deepEqual(operations(ctx), { pr: 'confirmed', merge: 'reconciled' });
  assert.equal(deliveryOperations(ctx.events).find(item => item.operation === 'merge').attempts, 1);
});

test('A timeout after the release assets were uploaded completes the same draft without a second upload', async t => {
  const ctx = await fixture(t);
  const delivered = await deliver(ctx);
  timeoutAfter(ctx, args => args[0] === 'release' && args[1] === 'create');
  await assert.rejects(releasePackage({ ...ctx, mergeCommit: delivered.mergeCommit }), { code: 'timeout' });
  assert.deepEqual([ctx.state.releaseCreates, ctx.state.publishes], [1, 0]);
  assert.deepEqual(uncertainOperations(ctx.events), ['release']);

  const release = await releasePackage({ ...ctx, mergeCommit: delivered.mergeCommit });
  assert.equal(validateReceipt(release), true, JSON.stringify(validateReceipt.errors));
  assert.deepEqual([ctx.state.releaseCreates, ctx.state.uploads, ctx.state.publishes], [1, 0, 1]);
  assert.equal(operations(ctx).release, 'confirmed', 'this call made the release public');
  assert.equal(release.sha256, digest(await readFile(path.join(ctx.assets, release.artifact))));
  assert.equal(release.smoke.artifactSha256, release.sha256, 'the smoke ran on the bytes the receipt publishes');
  assert.equal(ctx.leases.size, 0);
});

test('A recovered published release re-runs the installed smoke on the downloaded bytes of the same checksum', async t => {
  const ctx = await fixture(t);
  const delivered = await deliver(ctx);
  const release = await releasePackage({ ...ctx, mergeCommit: delivered.mergeCommit });
  assert.equal(operations(ctx).release, 'confirmed');
  const resumed = await releasePackage({ ...ctx, mergeCommit: delivered.mergeCommit });
  assert.equal(resumed.smoke.artifactSha256, release.sha256);
  assert.equal(operations(ctx).release, 'confirmed', 'a later read-back does not rewrite who published');
  assert.equal(
    ctx.events.filter(event => event.data?.operation === 'release' && event.data.phase === 'intent').length,
    1,
  );
  assert.equal(ctx.state.publishes, 1);
});

test('A merge command that returns while the PR is still open is not recorded as absent', async t => {
  const ctx = await fixture(t),
    runner = ctx.exec;
  // A merge queue: the command is accepted, the PR is not merged yet.
  ctx.exec = async (command, args, options) =>
    command === 'gh' && args[0] === 'pr' && args[1] === 'merge'
      ? { stdout: '', stderr: '', code: 0 }
      : runner(command, args, options);
  await assert.rejects(deliver(ctx), { code: 'merge_pending' });
  assert.deepEqual(operations(ctx), { pr: 'confirmed', merge: 'uncertain' });
  assert.deepEqual(uncertainOperations(ctx.events), ['merge'], 'the next delivery must read the PR back first');
});

test('A failed merge command with an unmerged PR is recorded as absent', async t => {
  const ctx = await fixture(t),
    runner = ctx.exec;
  ctx.exec = async (command, args, options) => {
    if (command === 'gh' && args[0] === 'pr' && args[1] === 'merge')
      throw Object.assign(new Error('merge refused by the remote'), { code: 'command_failed' });
    return runner(command, args, options);
  };
  await assert.rejects(deliver(ctx), /merge refused/);
  assert.equal(ctx.state.merges, 0);
  assert.deepEqual(operations(ctx), { pr: 'confirmed', merge: 'absent' });
  assert.deepEqual(uncertainOperations(ctx.events), []);
});

test('A journal that cannot record an outcome never fails a delivery that already happened', async t => {
  const ctx = await fixture(t),
    record = ctx.store.event;
  ctx.store.event = (id, type, data) => {
    if (type === 'delivery.operation' && data.phase === 'outcome') throw new Error('database is locked');
    return record(id, type, data);
  };
  const receipt = await deliver(ctx);
  assert.equal(receipt.mergeCommit, ctx.run.headSha);
  assert.equal(ctx.run.delivery.mergeCommit, ctx.run.headSha, 'the receipt is saved');
  assert.equal(ctx.state.merges, 1);
  assert.deepEqual(uncertainOperations(ctx.events), ['pr', 'merge'], 'the journal honestly stays uncertain');
  assert.equal(ctx.leases.size, 0);
});

test('A journal that cannot record an intent stops the remote effect before it starts', async t => {
  const ctx = await fixture(t),
    record = ctx.store.event;
  ctx.store.event = (id, type, data) => {
    if (type === 'delivery.operation' && data.operation === 'merge' && data.phase === 'intent')
      throw new Error('database is locked');
    return record(id, type, data);
  };
  await assert.rejects(deliver(ctx), /database is locked/);
  assert.equal(ctx.state.merges, 0, 'no merge without a durable intent');
  assert.equal(ctx.leases.size, 0, 'the merge queue is released');
});

test('A merge command stopped by a local timeout with the PR still open stays uncertain', async t => {
  const ctx = await fixture(t),
    runner = ctx.exec;
  // The request may already have left: an open PR right now does not prove the merge will not land.
  ctx.exec = async (command, args, options) => {
    if (command === 'gh' && args[0] === 'pr' && args[1] === 'merge')
      throw Object.assign(new Error('gh timed out'), { code: 'timeout' });
    return runner(command, args, options);
  };
  await assert.rejects(deliver(ctx), { code: 'timeout' });
  assert.deepEqual(operations(ctx), { pr: 'confirmed', merge: 'uncertain' });
  assert.equal(ctx.leases.size, 0);
});

test('A PR already merged when the branch is listed is recorded as reconciled without a merge command', async t => {
  const ctx = await fixture(t);
  // An earlier process created and merged the PR; this run has no saved receipt of either.
  ctx.state.pr = { number: 7, url: 'https://github.com/test/kodo/pull/7', state: 'MERGED' };
  const receipt = await deliver(ctx);
  assert.equal(receipt.mergeCommit, ctx.run.headSha);
  assert.deepEqual([ctx.state.creates, ctx.state.merges], [0, 0], 'nothing was created or merged again');
  assert.deepEqual(operations(ctx), { pr: 'reconciled', merge: 'reconciled' });
  assert.equal(ctx.leases.size, 0);
});
