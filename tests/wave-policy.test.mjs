import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { configureGitTestEnvironment } from '../scripts/git-test-environment.mjs';
import { git } from '../runtime/workspace.mjs';
import { normalizeConfig } from '../runtime/config.mjs';
import { wavePolicyAt, wavePolicyHash } from '../runtime/wave-policy.mjs';

configureGitTestEnvironment();
const keys = ['HOME', 'USERPROFILE', 'GIT_CONFIG_NOSYSTEM', 'GIT_CONFIG_GLOBAL', 'GIT_TERMINAL_PROMPT'];

async function fixture(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'kodo-wave-policy-'));
  const root = path.join(directory, 'repo'),
    isolated = path.join(directory, 'empty-home');
  await mkdir(root);
  await mkdir(isolated);
  await writeFile(path.join(isolated, 'gitconfig'), '');
  const previous = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  Object.assign(process.env, {
    HOME: isolated,
    USERPROFILE: isolated,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: path.join(isolated, 'gitconfig'),
    GIT_TERMINAL_PROMPT: '0',
  });
  t.after(async () => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    assert.equal(path.dirname(directory), path.resolve(os.tmpdir()));
    assert.match(path.basename(directory), /^kodo-wave-policy-/);
    await rm(directory, { recursive: true, force: true });
  });
  for (const args of [
    ['init', '-b', 'main'],
    ['config', 'user.name', 'Wave Policy'],
    ['config', 'user.email', 'wave-policy@example.invalid'],
    ['config', 'core.autocrlf', 'false'],
    ['config', 'commit.gpgSign', 'false'],
  ])
    await git(root, args);
  // Commit one kodo.config.json and return its commit.
  const commit = async config => {
    await writeFile(path.join(root, 'kodo.config.json'), JSON.stringify(config));
    await git(root, ['add', '-A']);
    await git(root, ['commit', '-q', '--allow-empty', '-m', 'Policy']);
    return git(root, ['rev-parse', 'HEAD']);
  };
  return { root, commit };
}

const policy = test => ({
  schemaVersion: 1,
  commands: { test: [test], build: [], deploy: [], smoke: [] },
});

test('wavePolicyAt reads the committed policy raw and refuses one the Store would record redacted', async t => {
  // Review finding (blocker): `git show` went through the redacting runner, so a command that exits 19
  // when its argument is intact was parsed, hashed and executed as `?key=[REDACTED]` and exited 0.
  const f = await fixture(t);
  const exitsUnlessRedacted = {
    command: process.execPath,
    args: ['-e', "process.exit(process.argv[1].includes('REDACTED') ? 0 : 19)", '?key=intact-value'],
  };
  const tampered = await f.commit(policy(exitsUnlessRedacted));
  await assert.rejects(wavePolicyAt(f.root, tampered), { code: 'project_wave_policy_unsafe' });

  // A known secret value in the policy is refused as well, before anything records it.
  const secrets = { token: 'kodo-policy-known-secret' };
  const known = await f.commit(policy({ command: process.execPath, args: ['-e', `'${secrets.token}'`] }));
  await assert.rejects(wavePolicyAt(f.root, known, { secrets }), { code: 'project_wave_policy_unsafe' });

  // A safe policy is exactly the committed one: template references stay, the hash is of its value.
  const config = policy({ command: process.execPath, args: ['--test', '--test-reporter=tap', '${PATH}'] });
  const safe = await f.commit(config);
  const read = await wavePolicyAt(f.root, safe, { secrets });
  assert.deepEqual(read.config.commands.test, config.commands.test);
  assert.equal(read.hash, wavePolicyHash(normalizeConfig(config)));
});
