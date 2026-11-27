import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { publishRefs } from '../runtime/project-publish.mjs';
import { Store } from '../runtime/store.mjs';

// The real Git inherits stdout, so Kodo sees its protocol replies directly.
// Only delivery of the commit line is gated. EOF closes the real stdin.
const transportSource = `using System;
using System.Diagnostics;
using System.IO;
using System.Threading;

class GitTransport {
    static int Main(string[] args) {
        var dir = Environment.GetEnvironmentVariable("REF_TEST_GATE");
        var start = new ProcessStartInfo(Environment.GetEnvironmentVariable("REF_TEST_GIT"),
            String.Join(" ", args)) { UseShellExecute = false, RedirectStandardInput = true };
        using (var git = Process.Start(start)) {
            string line;
            while ((line = Console.ReadLine()) != null) {
                if (line == "commit") {
                    File.WriteAllText(Path.Combine(dir, "commit-sent"), line);
                    var clock = Stopwatch.StartNew();
                    while (!File.Exists(Path.Combine(dir, "release"))) {
                        if (clock.ElapsedMilliseconds > 30000) return 2;
                        Thread.Sleep(20);
                    }
                }
                git.StandardInput.Write(line + "\\n");
                git.StandardInput.Flush();
            }
            git.StandardInput.Close();
            git.WaitForExit();
            return git.ExitCode;
        }
    }
}
`;

function run(command, args, options) {
  const result = spawnSync(command, args, { encoding: 'utf8', windowsHide: true, ...options });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result.stdout.trim();
}

async function fixture(t, format) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'kodo-ref-'));
  const repo = path.join(dir, 'repo');
  await mkdir(repo);
  const git = (...args) => run('git', ['-c', 'core.hooksPath=NUL', ...args], { cwd: repo });
  git('init', '-q', '-b', 'main', '--ref-format=' + format);
  git('config', 'user.name', 'Ref Test');
  git('config', 'user.email', 'ref@example.invalid');
  for (const message of ['base', 'next']) git('commit', '--no-gpg-sign', '--allow-empty', '-qm', message);
  const base = git('rev-parse', 'HEAD^'),
    next = git('rev-parse', 'HEAD');
  const dest = 'refs/heads/target',
    worker = 'refs/heads/worker';
  git('update-ref', dest, base);
  git('update-ref', worker, base);
  const store = new Store(path.join(dir, 'state'));
  t.after(async () => {
    store.close();
    await rm(dir, { recursive: true, force: true });
  });
  const token = store.acquireLease('publish', 'first');
  const commands = { verify: [{ ref: worker, sha: base }], update: [{ ref: dest, expected: base, next }] };
  return { dir, repo, git, base, next, dest, store, token, commands };
}

for (const format of ['files', 'reftable']) {
  test(
    'Windows publish recovers from a denied rename on ' + format,
    { skip: process.platform !== 'win32' },
    async t => {
      const { dir, repo, git, base, next, dest, store, token, commands } = await fixture(t, format);
      const held = path.join(repo, '.git', format === 'files' ? dest : 'reftable/tables.list');
      const ask = path.join(dir, 'ask.sh');
      await writeFile(ask, '#!/bin/sh\nprintf "%s" "$1" > "$0.called"\nexit 1\n');
      // Share reads and writes but keep Windows from replacing the destination.
      const holder = spawn(
        'powershell.exe',
        [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          "$h = [IO.File]::Open($env:REF_TEST_HELD, 'Open', 'Read', 'ReadWrite'); try { [Console]::WriteLine('held'); [void][Console]::ReadLine() } finally { $h.Dispose() }",
        ],
        { env: { ...process.env, REF_TEST_HELD: held }, windowsHide: true, stdio: ['pipe', 'pipe', 'inherit'] },
      );
      const closed = once(holder, 'close');
      const previous = process.env.GIT_ASK_YESNO;
      try {
        const lines = createInterface({ input: holder.stdout, crlfDelay: Infinity })[Symbol.asyncIterator]();
        assert.equal((await lines.next()).value, 'held');
        process.env.GIT_ASK_YESNO = ask;
        assert.throws(
          () => publishRefs(store, [token], repo, commands),
          error => error.code === 'project_lease_lost' && error.refused === undefined,
        );
        assert.equal(store.db.isTransaction, false);
        assert.equal(process.env.GIT_ASK_YESNO, ask);
        assert.equal(existsSync(ask + '.called'), false, 'the ref publisher must not invoke the inherited helper');
        assert.equal(git('rev-parse', dest), base);
        const paths = await readdir(path.join(repo, '.git'), { recursive: true });
        assert.deepEqual(
          paths.filter(name => name.endsWith('.lock')),
          [],
        );
      } finally {
        if (previous === undefined) delete process.env.GIT_ASK_YESNO;
        else process.env.GIT_ASK_YESNO = previous;
        holder.stdin.end('\n');
        assert.deepEqual(await closed, [0, null]);
      }
      git('update-ref', 'refs/heads/unrelated', next);
      git('update-ref', dest, next, base);
      git('update-ref', dest, base, next);
      publishRefs(store, [token], repo, commands);
      assert.equal(git('rev-parse', dest), next);
    },
  );
}

test('Windows holds the SQLite fence through a delayed Git commit', { skip: process.platform !== 'win32' }, async t => {
  const { dir, repo, git, base, next, dest, store, token, commands } = await fixture(t, 'reftable');
  const realGit = run('where.exe', ['git.exe'], { cwd: repo }).split(/\r?\n/)[0];
  const source = path.join(dir, 'transport.cs');
  await writeFile(source, transportSource);
  run(
    'powershell.exe',
    [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      'Add-Type -Path $env:REF_TEST_SOURCE -OutputAssembly $env:REF_TEST_EXE -OutputType ConsoleApplication -ErrorAction Stop',
    ],
    { env: { ...process.env, REF_TEST_SOURCE: source, REF_TEST_EXE: path.join(dir, 'git.exe') } },
  );
  const pathKey = Object.keys(process.env).find(key => key.toLowerCase() === 'path');
  const timeoutMs = 1000;
  const request = { state: path.join(dir, 'state'), token, repo, commands, timeoutMs };
  const script = `
    import { Store } from ${JSON.stringify(new URL('../runtime/store.mjs', import.meta.url).href)};
    import { publishRefs } from ${JSON.stringify(new URL('../runtime/project-publish.mjs', import.meta.url).href)};
    const { state, token, repo, commands, timeoutMs } = JSON.parse(process.argv[1]);
    const store = new Store(state);
    try { publishRefs(store, [token], repo, commands, { timeoutMs }); }
    finally { store.close(); }`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', script, JSON.stringify(request)], {
    cwd: repo,
    env: {
      ...process.env,
      [pathKey]: dir + path.delimiter + process.env[pathKey],
      REF_TEST_GIT: realGit,
      REF_TEST_GATE: dir,
    },
    windowsHide: true,
    stdio: ['ignore', 'ignore', 'inherit'],
  });
  const closed = once(child, 'close');
  try {
    const sent = path.join(dir, 'commit-sent');
    const limit = performance.now() + 15000;
    while (!existsSync(sent) && child.exitCode === null && performance.now() < limit) await delay(20);
    assert.ok(existsSync(sent), 'Git prepared and Kodo handed off commit');
    await delay(timeoutMs + 300);
    store.db.exec('PRAGMA busy_timeout=0');
    assert.throws(
      () => store.acquireLease('other', 'competitor'),
      error => error.errcode === 5,
    );
    assert.equal(git('rev-parse', dest), base);
  } finally {
    await writeFile(path.join(dir, 'release'), '');
    await closed;
  }
  assert.equal(child.exitCode, 0, 'Git confirmed the publication');
  assert.equal(git('rev-parse', dest), next);
  assert.ok(store.acquireLease('other', 'competitor'));
  git('update-ref', 'refs/heads/unrelated', base);
  assert.throws(() => publishRefs(store, [token], repo, commands), { code: 'project_lease_lost', refused: true });
  assert.equal(git('rev-parse', dest), next);
});
