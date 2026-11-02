import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { chmod, lstat, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execute } from '../runtime/command.mjs';
import { commitChanges, makeWorktree } from '../runtime/workspace.mjs';

const shell = value => `'${value.replaceAll('\\', '/').replaceAll("'", "'\\''")}'`;
const fakeToken = 'fixture-github-value-never-send';
const disabledHooks = process.platform === 'win32' ? 'NUL' : '/dev/null';
async function exists(filename) { try { await lstat(filename); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; } }

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'kodo-git-boundary-'));
  const project = path.join(root, 'project'), hooks = path.join(root, 'hooks');
  await mkdir(project); await mkdir(hooks);
  const globalConfig = path.join(root, 'global.gitconfig');
  const config = `[user]\n\tname = Kodo Test\n\temail = kodo@example.invalid\n[commit]\n\tgpgsign = false\n[core]\n\thooksPath = ${JSON.stringify(hooks.replaceAll('\\', '/'))}\n[credential]\n\thelper = fixture-user-helper\n`;
  await writeFile(globalConfig, config);
  const overrides = { GIT_CONFIG_GLOBAL: globalConfig, GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0', GH_TOKEN: fakeToken, GEMINI_API_KEY: 'fixture-gemini-value-never-send' };
  const previous = Object.fromEntries(Object.keys(overrides).map(name => [name, process.env[name]]));
  Object.assign(process.env, overrides);
  t.after(async () => {
    for (const [name, value] of Object.entries(previous)) { if (value === undefined) delete process.env[name]; else process.env[name] = value; }
    const resolved = path.resolve(root);
    assert.equal(path.dirname(resolved), path.resolve(os.tmpdir()));
    assert.ok(path.basename(resolved).startsWith('kodo-git-boundary-'));
    await rm(resolved, { recursive: true, force: true });
  });
  const env = { ...process.env };
  function raw(args, cwd = project) {
    const result = spawnSync('git', args, { cwd, env, encoding: 'utf8', windowsHide: true });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    return result.stdout.trim();
  }
  raw(['init', '-b', 'main']);
  await writeFile(path.join(project, 'package.json'), '{"name":"fixture","version":"1.0.0"}\n');
  await writeFile(path.join(project, 'notes.txt'), 'original notes\n');
  raw(['add', '-A']); raw(['commit', '-m', 'initial']);
  async function hook(name) {
    const marker = path.join(root, `${name}.marker`);
    const filename = path.join(hooks, name);
    await writeFile(filename, `#!/bin/sh\nprintf '%s' "\${GH_TOKEN-absent}" > ${shell(marker)}\n`);
    await chmod(filename, 0o755);
    return marker;
  }
  return { root, project, hooks, globalConfig, config, env, raw, hook };
}

test('Coordinator commits never execute inherited user hooks or modify global Git configuration', async t => {
  const f = await fixture(t), marker = await f.hook('pre-commit');
  await writeFile(path.join(f.project, 'notes.txt'), 'control change\n');
  f.raw(['add', '-A']); f.raw(['commit', '-m', 'raw positive control']);
  assert.equal(await readFile(marker, 'utf8'), fakeToken, 'positive control must demonstrate the real hook and inherited token');
  await rm(marker);
  await writeFile(path.join(f.project, 'notes.txt'), 'coordinator change\n');
  const head = await commitChanges(f.project, 'guarded commit');
  assert.equal(f.raw(['show', `${head}:notes.txt`]), 'coordinator change');
  assert.equal(await exists(marker), false, 'repository hook must never run in the coordinator');
  assert.equal(await readFile(f.globalConfig, 'utf8'), f.config);
});

test('Local Git repository code receives scrubbed credentials and cannot override disabled hooks', async t => {
  const f = await fixture(t);
  f.raw(['config', 'alias.observe', '!printf "%s:%s" "${GH_TOKEN-absent}" "${GEMINI_API_KEY-absent}"']);
  const observed = await execute('git', ['observe'], { cwd: f.project, env: f.env });
  assert.equal(observed.stdout, 'absent:absent');
  const hooks = await execute('git', ['-c', `core.hooksPath=${f.hooks}`, 'config', '--get', 'core.hooksPath'], { cwd: f.project, env: f.env });
  assert.equal(hooks.stdout.trim(), disabledHooks);
  const helpers = await execute('git', ['config', '--get-all', 'credential.helper'], { cwd: f.project, env: f.env });
  assert.equal(helpers.stdout.replaceAll('\r\n', '\n'), 'fixture-user-helper\n\n', 'empty final helper entry must disable inherited helpers for local commands');
  assert.equal(await readFile(f.globalConfig, 'utf8'), f.config);
});

test('Coordinator push disables pre-push hooks while updating a real remote', async t => {
  const f = await fixture(t), remote = path.join(f.root, 'remote.git');
  f.raw(['init', '--bare', remote]);
  const marker = await f.hook('pre-push');
  f.raw(['push', remote, 'main']);
  assert.equal(await readFile(marker, 'utf8'), fakeToken);
  await rm(marker);
  await writeFile(path.join(f.project, 'notes.txt'), 'pushed safely\n');
  const head = await commitChanges(f.project, 'next commit');
  await execute('git', ['push', remote, 'main'], { cwd: f.project, env: f.env });
  assert.equal(f.raw(['rev-parse', 'main'], remote), head);
  assert.equal(await exists(marker), false);
});

test('Network Git retains GitHub authentication for credential helpers without exposing provider API keys', async t => {
  const f = await fixture(t), marker = path.join(f.root, 'credential-environment.json');
  const helper = path.join(f.root, 'credential-helper.cjs');
  await writeFile(helper, `require('node:fs').writeFileSync(${JSON.stringify(marker)}, JSON.stringify({ github: process.env.GH_TOKEN ?? null, gemini: process.env.GEMINI_API_KEY ?? null }));\nconsole.log('username=fixture\\npassword=fixture\\n');\n`);
  f.raw(['config', 'credential.helper', '']);
  f.raw(['config', '--add', 'credential.helper', `!${shell(process.execPath)} ${shell(helper)}`]);
  const server = createServer((request, response) => { response.writeHead(401, { 'WWW-Authenticate': 'Basic realm="Kodo local test"', Connection: 'close' }); response.end(); });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  t.after(() => new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())));
  const result = await execute('git', ['fetch', `http://127.0.0.1:${server.address().port}/fixture.git`], { cwd: f.project, env: f.env, allowFailure: true, timeoutMs: 10000 });
  assert.notEqual(result.code, 0, 'local HTTP fixture intentionally rejects authentication');
  assert.deepEqual(JSON.parse(await readFile(marker, 'utf8')), { github: fakeToken, gemini: null });
  assert.equal(await readFile(f.globalConfig, 'utf8'), f.config);
});

test('Coordinator worktree checkout disables shared post-checkout hooks', async t => {
  const f = await fixture(t), marker = await f.hook('post-checkout');
  const worktree = path.join(f.root, 'worker');
  await makeWorktree(f.project, worktree, 'worker', 'HEAD');
  assert.equal(await readFile(path.join(worktree, 'notes.txt'), 'utf8'), 'original notes\n');
  assert.equal(await exists(marker), false);
});

test('Metadata commit includes only existing requested paths and preserves other unstaged changes', async t => {
  const f = await fixture(t);
  await writeFile(path.join(f.project, 'package.json'), '{"name":"fixture","version":"1.0.1"}\n');
  await writeFile(path.join(f.project, 'notes.txt'), 'unfinished user work\n');
  await writeFile(path.join(f.project, 'scratch.txt'), 'new unrelated file\n');
  const head = await commitChanges(f.project, 'release metadata', ['package.json', 'package-lock.json', 'registry.json']);
  assert.equal(f.raw(['show', `${head}:package.json`]), '{"name":"fixture","version":"1.0.1"}');
  assert.equal(f.raw(['show', `${head}:notes.txt`]), 'original notes');
  assert.deepEqual(f.raw(['diff', '--name-only']), 'notes.txt');
  assert.equal(f.raw(['ls-files', '--others', '--exclude-standard']), 'scratch.txt');
  assert.equal(f.raw(['diff', '--cached', '--name-only']), '');
});

test('Metadata commit rejects unrelated staged files before changing the index', async t => {
  const f = await fixture(t), before = f.raw(['rev-parse', 'HEAD']);
  await writeFile(path.join(f.project, 'notes.txt'), 'staged user work\n');
  await writeFile(path.join(f.project, 'package.json'), '{"version":"1.0.1"}\n');
  f.raw(['add', 'notes.txt']);
  await assert.rejects(commitChanges(f.project, 'release metadata', ['package.json']), /staged|индекс|подготовлен/i);
  assert.equal(f.raw(['rev-parse', 'HEAD']), before);
  assert.equal(f.raw(['diff', '--cached', '--name-only']), 'notes.txt');
  assert.equal(f.raw(['diff', '--name-only']), 'package.json');
});

test('Metadata commit with no existing requested paths never stages unrelated work', async t => {
  const f = await fixture(t), before = f.raw(['rev-parse', 'HEAD']);
  await writeFile(path.join(f.project, 'notes.txt'), 'unfinished work\n');
  const head = await commitChanges(f.project, 'no release metadata', ['package-lock.json', 'registry.json']);
  assert.equal(head, before);
  assert.equal(f.raw(['diff', '--name-only']), 'notes.txt');
  assert.equal(f.raw(['diff', '--cached', '--name-only']), '');
});
