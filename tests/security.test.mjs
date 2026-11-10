import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, access, stat, readdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  createCredentialStore,
  credentialRoot,
  worktreeHome,
  secretNames,
  workerEnvironment,
} from '../runtime/security.mjs';

const fixtureKeys = {
  GEMINI_API_KEY: 'fixture-gemini-private-value',
  TYPESAFE_API_KEY: 'fixture-jev-private-value',
  GETX_API_KEY: 'fixture-quoted-"-\\-значение',
};
const complete = (stored = {}) => Object.fromEntries(secretNames.map(name => [name, stored[name] || '']));
async function temp(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'kodo-security-test-'));
  t.after(async () => {
    assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith('kodo-security-test-'));
    await rm(root, { recursive: true, force: true });
  });
  return root;
}
function fakeCrypto() {
  const payloads = new Map();
  let serial = 0;
  return {
    encrypt: async input => {
      const token = Buffer.from(`opaque-fixture-${++serial}`);
      payloads.set(token.toString(), Buffer.from(input));
      return token;
    },
    decrypt: async input => {
      const data = payloads.get(input.toString());
      if (!data) throw new Error('fixture decryption failed');
      return Buffer.from(data);
    },
  };
}
async function fixture(t, overrides = {}) {
  const root = await temp(t),
    directory = path.join(root, 'credentials'),
    legacyDirectory = path.join(root, 'state');
  await mkdir(legacyDirectory);
  const calls = [],
    crypto = fakeCrypto();
  const settings = {
    directory,
    legacyDirectory,
    platform: 'win32',
    ...crypto,
    securePath: async (target, isDirectory) => {
      await access(target);
      calls.push({ target, isDirectory });
    },
    ...overrides,
  };
  return { root, directory, legacyDirectory, calls, settings, store: createCredentialStore(settings) };
}

test('Credential and worktree defaults are separate from state and honor explicit location overrides', () => {
  const local = path.resolve('fixture-user'),
    environment = {
      LOCALAPPDATA: local,
      XDG_CONFIG_HOME: path.join(local, 'config'),
      XDG_STATE_HOME: path.join(local, 'state'),
    };
  assert.equal(credentialRoot(environment, 'win32'), path.join(local, 'Kodo-Credentials'));
  assert.equal(worktreeHome(environment, 'win32'), path.join(local, 'Kodo-Worktrees'));
  assert.equal(credentialRoot(environment, 'linux'), path.join(local, 'config', 'kodo', 'credentials'));
  assert.equal(worktreeHome(environment, 'linux'), path.join(local, 'state', 'Kodo-Worktrees'));
  assert.equal(
    credentialRoot({ KODO_CREDENTIAL_HOME: './specific-credentials' }),
    path.resolve('specific-credentials'),
  );
  assert.equal(worktreeHome({ KODO_WORKTREE_HOME: './specific-worktrees' }), path.resolve('specific-worktrees'));
  assert.deepEqual(
    workerEnvironment({ PATH: 'allowed', KODO_CREDENTIAL_HOME: 'private', KODO_WORKTREE_HOME: 'private' }),
    { PATH: 'allowed' },
  );
});

test('Verified encrypted migration removes legacy plaintext and reopens with exact key values', async t => {
  const fx = await fixture(t);
  await writeFile(fx.store.legacyFile, '\uFEFF' + JSON.stringify({ ...fixtureKeys, UNRELATED: 'must-not-be-stored' }));
  assert.deepEqual(await fx.store.load({ environment: {} }), complete(fixtureKeys));
  await assert.rejects(access(fx.store.legacyFile), { code: 'ENOENT' });
  const disk = await readFile(fx.store.file, 'utf8');
  for (const value of Object.values(fixtureKeys)) assert.equal(disk.includes(value), false);
  assert.equal(disk.includes('UNRELATED'), false);
  assert.equal(JSON.parse(disk).protection, 'windows-dpapi-current-user');
  assert.deepEqual(await createCredentialStore(fx.settings).load({ environment: {} }), complete(fixtureKeys));
  assert.ok(fx.calls.some(call => call.target === fx.directory && call.isDirectory));
  assert.ok(fx.calls.some(call => call.target === fx.store.file && !call.isDirectory));
  assert.ok(fx.calls.some(call => call.target.endsWith('.tmp') && !call.isDirectory));
  assert.deepEqual((await readdir(fx.directory)).sort(), ['credentials.dpapi.json']);
});

test('Credential environment overrides remain coordinator-only and are never persisted', async t => {
  const fx = await fixture(t);
  await fx.store.save(fixtureKeys);
  const environment = {
    GEMINI_API_KEY: 'direct-override-value',
    KODO_GEMINI_API_KEY: 'prefixed-override-value',
    REDDIT_API_KEY: 'environment-only-value',
  };
  assert.deepEqual(
    await fx.store.load({ environment }),
    complete({ ...fixtureKeys, GEMINI_API_KEY: 'prefixed-override-value', REDDIT_API_KEY: 'environment-only-value' }),
  );
  assert.deepEqual(await fx.store.load({ environment: {} }), complete(fixtureKeys));
  assert.deepEqual(workerEnvironment(environment), {});
});

test('Empty credential storage returns the complete empty contract without creating a key file', async t => {
  const fx = await fixture(t);
  assert.deepEqual(await fx.store.load({ environment: {} }), complete());
  assert.deepEqual(await readdir(fx.directory), []);
});

test('Migration retains plaintext and emits only a fixed error when protection or verification fails', async t => {
  for (const failure of ['encrypt', 'decrypt', 'acl']) {
    const fx = await fixture(t);
    const original = JSON.stringify(fixtureKeys);
    await writeFile(fx.store.legacyFile, original);
    const settings = { ...fx.settings };
    if (failure === 'acl')
      settings.securePath = async () => {
        throw new Error(original);
      };
    else
      settings[failure] = async () => {
        throw new Error(original);
      };
    await assert.rejects(createCredentialStore(settings).load({ environment: {} }), error => {
      assert.equal(error.code, 'credential_store');
      for (const value of Object.values(fixtureKeys)) assert.equal(error.message.includes(value), false);
      assert.equal(error.cause, undefined);
      return true;
    });
    assert.equal(await readFile(fx.store.legacyFile, 'utf8'), original);
    assert.deepEqual(await readdir(fx.directory).catch(() => []), []);
  }
});

test('Migration rejects a decrypted payload that differs from the legacy keys before removing plaintext', async t => {
  const fx = await fixture(t),
    original = JSON.stringify(fixtureKeys);
  await writeFile(fx.store.legacyFile, original);
  const store = createCredentialStore({
    ...fx.settings,
    decrypt: async () => Buffer.from(JSON.stringify({ GEMINI_API_KEY: 'different-fixture-value' })),
  });
  await assert.rejects(store.load({ environment: {} }), { code: 'credential_store' });
  assert.equal(await readFile(fx.store.legacyFile, 'utf8'), original);
  await assert.rejects(access(store.file), { code: 'ENOENT' });
  assert.deepEqual(await readdir(fx.directory), []);
});

test('Migration retains plaintext when the installed encrypted file cannot be verified after rename', async t => {
  const fx = await fixture(t),
    original = JSON.stringify(fixtureKeys);
  let reads = 0;
  await writeFile(fx.store.legacyFile, original);
  const store = createCredentialStore({
    ...fx.settings,
    decrypt: async input => {
      if (++reads === 2) throw new Error(original);
      return fx.settings.decrypt(input);
    },
  });
  await assert.rejects(store.load({ environment: {} }), { code: 'credential_store' });
  assert.equal(await readFile(fx.store.legacyFile, 'utf8'), original);
  assert.deepEqual(await readdir(fx.directory), ['credentials.dpapi.json']);
  assert.deepEqual(await fx.store.load({ environment: {} }), complete(fixtureKeys));
  await assert.rejects(access(store.legacyFile), { code: 'ENOENT' });
});

test('Migration preserves a concurrently edited legacy file instead of deleting the new user values', async t => {
  const fx = await fixture(t),
    changed = JSON.stringify({ GEMINI_API_KEY: 'user-edited-fixture-value' });
  await writeFile(fx.store.legacyFile, JSON.stringify(fixtureKeys));
  const store = createCredentialStore({
    ...fx.settings,
    encrypt: async input => {
      await writeFile(fx.store.legacyFile, changed);
      return fx.settings.encrypt(input);
    },
  });
  await assert.rejects(store.load({ environment: {} }), { code: 'credential_conflict' });
  assert.equal(await readFile(fx.store.legacyFile, 'utf8'), changed);
  assert.ok(await stat(fx.store.file));
});

test('Existing protected storage merges missing legacy keys and refuses conflicting values', async t => {
  const fx = await fixture(t);
  await fx.store.save({ GEMINI_API_KEY: fixtureKeys.GEMINI_API_KEY });
  await writeFile(fx.store.legacyFile, JSON.stringify(fixtureKeys));
  assert.deepEqual(await fx.store.load({ environment: {} }), complete(fixtureKeys));
  const conflicting = JSON.stringify({ GEMINI_API_KEY: 'conflicting-fixture-value' });
  await writeFile(fx.store.legacyFile, conflicting);
  await assert.rejects(fx.store.load({ environment: {} }), { code: 'credential_conflict' });
  assert.equal(await readFile(fx.store.legacyFile, 'utf8'), conflicting);
  assert.deepEqual(
    await createCredentialStore({ ...fx.settings, legacyDirectory: path.join(fx.root, 'missing') }).load({
      environment: {},
    }),
    complete(fixtureKeys),
  );
});

test('Malformed protected storage and invalid legacy key types fail closed without deleting input', async t => {
  const fx = await fixture(t);
  const invalidLegacy = JSON.stringify({ GEMINI_API_KEY: { unexpected: fixtureKeys.GEMINI_API_KEY } });
  await writeFile(fx.store.legacyFile, invalidLegacy);
  await assert.rejects(fx.store.load({ environment: {} }), { code: 'credential_store' });
  assert.equal(await readFile(fx.store.legacyFile, 'utf8'), invalidLegacy);
  await writeFile(fx.store.legacyFile, JSON.stringify(fixtureKeys));
  await writeFile(fx.store.file, JSON.stringify({ version: 1, protection: 'unexpected', data: fixtureKeys }));
  await assert.rejects(fx.store.load({ environment: {} }), { code: 'credential_store' });
  assert.equal(await readFile(fx.store.legacyFile, 'utf8'), JSON.stringify(fixtureKeys));
});

test(
  'Unix credential storage uses protected file permissions outside state and persists only known keys',
  { skip: process.platform === 'win32' },
  async t => {
    const root = await temp(t),
      directory = path.join(root, 'credentials'),
      legacyDirectory = path.join(root, 'state');
    await mkdir(legacyDirectory);
    const store = createCredentialStore({ directory, legacyDirectory, platform: 'linux' });
    await writeFile(store.legacyFile, JSON.stringify({ ...fixtureKeys, UNRELATED: 'not-a-provider-key' }));
    assert.deepEqual(await store.load({ environment: {} }), complete(fixtureKeys));
    assert.equal((await stat(directory)).mode & 0o777, 0o700);
    assert.equal((await stat(store.file)).mode & 0o777, 0o600);
    assert.deepEqual(JSON.parse(await readFile(store.file, 'utf8')).data, fixtureKeys);
    await assert.rejects(access(store.legacyFile), { code: 'ENOENT' });
  },
);

test(
  'Native Windows DPAPI roundtrip stores ciphertext and automatically migrates legacy plaintext',
  { skip: process.platform !== 'win32' },
  async t => {
    const root = await temp(t),
      directory = path.join(root, 'credentials'),
      legacyDirectory = path.join(root, 'state');
    await mkdir(legacyDirectory);
    const store = createCredentialStore({ directory, legacyDirectory });
    await writeFile(store.legacyFile, JSON.stringify(fixtureKeys));
    assert.deepEqual(await store.load({ environment: {} }), complete(fixtureKeys));
    assert.deepEqual(
      await createCredentialStore({ directory, legacyDirectory }).load({ environment: {} }),
      complete(fixtureKeys),
    );
    const disk = await readFile(store.file, 'utf8');
    for (const value of Object.values(fixtureKeys)) assert.equal(disk.includes(value), false);
    await assert.rejects(access(store.legacyFile), { code: 'ENOENT' });
    const script = `
$ErrorActionPreference = 'Stop'
try {
  $request = [Console]::In.ReadToEnd() | ConvertFrom-Json
  $fileAcl = [IO.File]::GetAccessControl($request.file)
  $directoryAcl = [IO.Directory]::GetAccessControl($request.directory)
  $current = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
  $result = @{ current = $current; fileProtected = $fileAcl.AreAccessRulesProtected; directoryProtected = $directoryAcl.AreAccessRulesProtected;
    fileSids = @($fileAcl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier]) | ForEach-Object { $_.IdentityReference.Value });
    directorySids = @($directoryAcl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier]) | ForEach-Object { $_.IdentityReference.Value }) }
  [Console]::Out.Write(($result | ConvertTo-Json -Compress))
  exit 0
} catch { exit 1 }
`;
    const probe = spawnSync(
      path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
      [
        '-NoLogo',
        '-NoProfile',
        '-NonInteractive',
        '-EncodedCommand',
        Buffer.from(script, 'utf16le').toString('base64'),
      ],
      { input: JSON.stringify({ file: store.file, directory }), encoding: 'utf8', windowsHide: true },
    );
    assert.equal(probe.status, 0, 'Native ACL inspection must succeed');
    const acl = JSON.parse(probe.stdout);
    assert.equal(acl.fileProtected, true);
    assert.equal(acl.directoryProtected, true);
    const expectedSids = [acl.current, 'S-1-5-18'].sort();
    assert.deepEqual(acl.fileSids.sort(), expectedSids);
    assert.deepEqual(acl.directorySids.sort(), expectedSids);
  },
);
