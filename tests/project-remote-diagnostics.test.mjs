// Stage 16A: remote worker portable diagnostics, path hygiene and ref garbage collection.
import test from 'node:test';
import assert from 'node:assert/strict';
import { tracingChannel } from 'node:diagnostics_channel';
import os from 'node:os';
import path from 'node:path';
import { nextWave } from '../runtime/project-external.mjs';
import { git, commit, remoteFixture, assertNoLocalPath } from './helpers/parallel-engine-fixture.mjs';

test('round4 T1 long TypeError stays actionable before trimming on replay and retry', async t => {
  const f = await remoteFixture(t);
  const [brief] = (await f.pull()).briefs;
  f.checkout(brief);
  const head = await commit(f.clone, {
    'src/t0.mjs':
      "export const t0 = { valueOf() { throw new TypeError('detail '.repeat(31) + '(' + import.meta.url + ')'); } };\n",
  });
  git(f.clone, 'push', 'origin', 'HEAD:' + brief.workRef);
  assert.equal((await f.complete(brief, head)).status, 'checks_failed');
  const failed = f.store.getRun(brief.runId);
  assert.ok(failed.lastDiagnostics.items.some(item => item.message.includes('detail (src/t0.mjs)')));
  // Simulate a pack persisted by an older Kodo which cut through this Run's directory name.
  const legacy = structuredClone(failed.lastDiagnostics);
  const partial = failed.cwd.slice(0, failed.cwd.indexOf(failed.id) + 8);
  legacy.items.push({ ...legacy.items[0], message: 'older stack (' + partial + '\u2026)' });
  f.store.updateRun(brief.runId, { lastDiagnostics: legacy });
  const check = pull => {
    assert.equal(pull.briefs.length, 1, JSON.stringify(pull.blocked));
    const [row] = pull.briefs;
    assert.ok(row.prompt.includes('older stack (<local-path>)'));
    assert.match(row.prompt, /detail \(src\/t0\.mjs\)/);
    assert.ok(row.diagnostics.items.some(item => item.message.includes('detail (src/t0.mjs)')));
    assertNoLocalPath(row, [f.store.getRun(brief.runId).cwd, f.home, os.homedir()]);
    return row;
  };
  check(await f.pull());
  assert.equal((await f.complete(brief, head, { abandon: true, deferGate: false })).status, 'abandoned');
  assert.notEqual(
    check(await nextWave(f.ctx, { projectId: f.projectId, host: 't3', ports: f.ports, retryFailed: true })).attemptId,
    brief.attemptId,
  );
});

test('round4 T1 masks stored local paths and truncated checkout prefixes in diagnostics only', async () => {
  const { portableDiagnostics, assertRemoteBriefPaths } = await import('../runtime/remote-brief-paths.mjs');
  const cwd = 'C:/Users/worker/state-worktrees/31f76caf-3333/integration';
  const roots = ['C:/Users/worker', 'D:/private/state'];
  const pack = {
    items: [
      {
        message: 'at (file:///c:/Users/worker/state-worktrees/31f76caf-33\u2026)',
        file: 'D:/private/state/errors/log',
      },
      { message: 'before home (file:///C:/Us\u2026)', file: cwd + '/src/ok.mjs' },
    ],
  };
  const result = portableDiagnostics(pack, [cwd], 'win32', roots);
  assert.deepEqual(result.items, [
    { message: 'at (<local-path>)', file: '<local-path>' },
    { message: 'before home (<local-path>)', file: 'src/ok.mjs' },
  ]);
  assert.throws(
    () => assertRemoteBriefPaths({ prompt: 'outside diagnostics: D:/private/state/errors/log' }, roots, 'win32'),
    { code: 'project_brief_path_leak' },
  );
});

test('round4 T2 recognizes decorated local paths and skips short roots and relative paths', async () => {
  const { assertRemoteBriefPaths } = await import('../runtime/remote-brief-paths.mjs');
  const roots = ['/home/worker', '/'];
  for (const text of [
    '**/home/worker/state**',
    '\x1b[31m/home/worker/state\x1b[0m',
    'x|/home/worker/state',
    'x>/home/worker/state',
    'x@/home/worker/state',
  ])
    assert.throws(() => assertRemoteBriefPaths({ prompt: text }, roots, 'linux'), { code: 'project_brief_path_leak' });
  assert.throws(
    () => assertRemoteBriefPaths({ prompt: '\u00abC:\\Users\\worker\\state\u00bb' }, ['C:\\Users\\worker'], 'win32'),
    { code: 'project_brief_path_leak' },
  );
  assert.doesNotThrow(() =>
    assertRemoteBriefPaths(
      { prompt: 'root /; app/root.tsx; src/home/worker/file; https://site/home/worker/file' },
      roots,
      'linux',
    ),
  );
  assert.doesNotThrow(() => assertRemoteBriefPaths({ prompt: 'volume C:\\' }, ['C:\\'], 'win32'));
});

test('round3 N1 remote pull and retry receive portable task-fast diagnostics from the failing worktree', async t => {
  const f = await remoteFixture(t);
  const [brief] = (await f.pull()).briefs;
  f.checkout(brief);
  const head = await commit(f.clone, {
    'src/t0.mjs': 'export const t0 = { valueOf() { throw new TypeError(import.meta.url); } };\n',
  });
  git(f.clone, 'push', 'origin', 'HEAD:' + brief.workRef);
  assert.equal((await f.complete(brief, head)).status, 'checks_failed');
  const failed = f.store.getRun(brief.runId);
  assert.match(JSON.stringify(failed.lastDiagnostics), /src\/t0\.mjs/);
  const check = pull => {
    assert.equal(pull.briefs.length, 1, JSON.stringify(pull.blocked));
    const [row] = pull.briefs;
    assert.match(JSON.stringify(row.diagnostics), /src\/t0\.mjs/);
    assert.match(row.prompt, /src\/t0\.mjs/);
    assertNoLocalPath(row, [failed.cwd, f.home, f.root]);
    assert.ok(!JSON.stringify(row.diagnostics).includes(failed.id));
    return row;
  };
  assert.equal(check(await f.pull()).attemptId, brief.attemptId);
  assert.equal((await f.complete(brief, head, { abandon: true, deferGate: false })).status, 'abandoned');
  const retry = check(await nextWave(f.ctx, { projectId: f.projectId, host: 't3', ports: f.ports, retryFailed: true }));
  assert.notEqual(retry.attemptId, brief.attemptId);
  assert.deepEqual(f.store.getRun(brief.runId).lastDiagnostics, failed.lastDiagnostics);
});

test('round3 N1 maps drive paths and file URLs from both known worktrees', async () => {
  const { portableDiagnostics } = await import('../runtime/remote-brief-paths.mjs');
  const roots = ['C:\\Kodo Work\\attempt\\integration', 'D:\\Kodo Work\\project-integration'];
  const pack = {
    items: [
      {
        file: 'c:/Kodo Work\\attempt/integration\\src\\t0.mjs',
        message: 'at (file:///c:/Kodo%20Work/attempt/integration/src/t0.mjs:5:2)',
      },
      {
        file: '/d:/Kodo%20Work/project-integration/lib/check.mjs',
        message: 'location=D:\\Kodo Work/project-integration\\lib\\check.mjs',
      },
      { file: 'C:\\Kodo Work\\attempt\\integration-other\\module.mjs', message: 'Unrelated worktree' },
    ],
    bytes: 0,
  };
  const result = portableDiagnostics(pack, roots, 'win32');
  assert.deepEqual(result.items, [
    { file: 'src/t0.mjs', message: 'at (src/t0.mjs:5:2)' },
    { file: 'lib/check.mjs', message: 'location=lib/check.mjs' },
    pack.items[2],
  ]);
  assert.equal(result.bytes, Buffer.byteLength(JSON.stringify(result)));
});

test('round3 N2 POSIX guard accepts relative paths and URLs and refuses an absolute state path', async () => {
  const { assertRemoteBriefPaths } = await import('../runtime/remote-brief-paths.mjs');
  const brief = {
    writePaths: ['app/root.tsx', 'src/app/page.tsx'],
    prompt: 'See https://example.test/apple/ and app/readme.md',
  };
  for (const home of ['/root', '/']) {
    const roots = ['/app', '/srv/kodo/state', home];
    assert.doesNotThrow(() => assertRemoteBriefPaths(brief, roots, 'linux'));
    for (const value of [
      '/srv/kodo/state',
      'at (/srv/kodo/state/file)',
      'location=file:///srv/kodo/state/file',
      'path:/srv/kodo/state/file',
    ]) {
      assert.throws(() => assertRemoteBriefPaths({ ...brief, prompt: value }, roots, 'linux'), {
        code: 'project_brief_path_leak',
      });
    }
  }
});

test('round3 abandon returns its recorded verdict when the verifier holds its lease', async t => {
  const f = await remoteFixture(t);
  const [brief] = (await f.pull()).briefs;
  const name = 'project-verify:' + brief.runId;
  const held = f.store.acquireLease(name, 'held-by-verifier');
  const acquire = f.store.acquireLease.bind(f.store);
  let tries = 0;
  f.store.acquireLease = (key, owner, options) => {
    if (key === name && ++tries > 1) throw new Error('cleanup waited for the verifier after recording abandon');
    return acquire(key, owner, options);
  };
  try {
    assert.equal((await f.complete(brief, brief.baseSha, { abandon: true, deferGate: false })).status, 'abandoned');
    assert.equal(tries, 1);
  } finally {
    f.store.releaseLease(held);
  }
});

test('round3 GC lists project refs once per remote and preserves live attempts', async t => {
  const f = await remoteFixture(t);
  const [first] = (await f.pull()).briefs;
  const retry = async () =>
    (await nextWave(f.ctx, { projectId: f.projectId, host: 't3', ports: f.ports, retryFailed: true })).briefs[0];
  const abandon = brief => f.complete(brief, brief.baseSha, { abandon: true, deferGate: false });
  await abandon(first);
  const second = await retry();
  await abandon(second);
  const live = await retry();
  for (const brief of [first, second]) git(f.bare, 'update-ref', brief.workRef, brief.baseSha);
  const requests = [];
  const channel = tracingChannel('child_process.spawn').start;
  const observe = ({ options }) => {
    if (options.args.includes('ls-remote')) requests.push(options.args.slice(options.args.indexOf('ls-remote')));
  };
  channel.subscribe(observe);
  try {
    const { gcProjectWorktrees } = await import('../runtime/project-worktree-gc.mjs');
    await gcProjectWorktrees(f.store, await f.snapshot());
  } finally {
    channel.unsubscribe(observe);
  }
  assert.deepEqual(requests, [['ls-remote', '--refs', 'origin', 'refs/kodo/' + f.projectId + '/*']]);
  assert.equal(git(f.bare, 'for-each-ref', '--format=%(refname)', 'refs/kodo'), live.baseRef);
});

test('round2 R1 R2 architecture references use relative paths and digests even in nested JSON', async t => {
  const f = await remoteFixture(t, (root, home) => ({
    architectureRefs: [root, home].map((dir, i) => ({
      path: path.join(dir, 'architecture.md'),
      sha256: String(i + 1).repeat(64),
      kind: 'contract',
      headSha: null,
      runId: null,
    })),
  }));
  const {
    briefs: [brief],
  } = await f.pull();
  assertNoLocalPath(brief, [f.root, f.home, os.homedir()]);
  assert.match(brief.prompt, /"path":"architecture.md"/);
  assert.ok(brief.prompt.includes('sha256:' + '2'.repeat(64)));
});

test('round2 R1 refuses private paths embedded in free text', async t => {
  const f = await remoteFixture(t, (_root, home) => ({ businessContext: 'Read notes at ' + path.join(home, 'notes') }));
  const pull = await f.pull();
  assert.equal(pull.blocked[0]?.code, 'project_brief_path_leak');
  assert.equal(pull.briefs.length, 0);
});
