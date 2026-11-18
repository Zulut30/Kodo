/** Read-only access to Kodo state and credentials for `kodo report`.
 *
 * Nothing here writes, migrates or changes permissions of a file in the state
 * home or the credential directory:
 * - `readReportState` never opens the live database files with a lock or a
 *   shared-memory index. Without pending WAL frames the main file is opened
 *   `immutable`; with them, the database and its WAL are copied into a private
 *   temporary directory, the copy is recovered and checked there and removed
 *   afterwards. A copy or a read that raced a writer is retried, then refused.
 *   The copy reads exactly what any SQLite reader would read: an unfinished or
 *   damaged WAL tail is ignored, as it is for the original. The temporary
 *   directory is never inside, nor around, the state or the credential home.
 * - `readRedactionSecrets` reads existing keys (environment, the credential
 *   store and a legacy `secrets.json`) only to redact output. It creates no
 *   directory and does not migrate a legacy file.
 * See docs/OBSERVABILITY.md.
 */
import os from 'node:os';
import path from 'node:path';
import { copyFileSync, mkdtempSync, realpathSync, rmSync, statSync } from 'node:fs';
import { lstat, readFile } from 'node:fs/promises';
import { setTimeout as sleep } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { randomBytes } from 'node:crypto';
import {
  credentialRoot,
  decodeCredentials,
  decryptWindowsCredentials,
  secretNames,
  workerEnvironment,
} from './security.mjs';
import { execute } from './command.mjs';

// A new directory created WITH a protected owner-only security descriptor (current user and
// SYSTEM, inheritance cut): no moment exists in which an inherited ACL lets another account
// open it. A name that already existed (created by someone else) fails the owner check.
const createScript = String.raw`$ErrorActionPreference='Stop'
[Console]::InputEncoding=[Text.UTF8Encoding]::new($false)
try {
  $target=[Console]::In.ReadToEnd()
  $user=[Security.Principal.WindowsIdentity]::GetCurrent().User
  $system=[Security.Principal.SecurityIdentifier]::new('S-1-5-18')
  if (Test-Path -LiteralPath $target) { exit 1 }
  $acl=[Security.AccessControl.DirectorySecurity]::new()
  $acl.SetOwner($user); $acl.SetAccessRuleProtection($true,$false)
  $inherit=[Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [Security.AccessControl.InheritanceFlags]::ObjectInherit
  foreach($sid in @($user,$system)) { $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($sid,[Security.AccessControl.FileSystemRights]::FullControl,$inherit,[Security.AccessControl.PropagationFlags]::None,[Security.AccessControl.AccessControlType]::Allow)) }
  [void][IO.Directory]::CreateDirectory($target,$acl)
  $actual=[IO.Directory]::GetAccessControl($target)
  if ($actual.GetOwner([Security.Principal.SecurityIdentifier]).Value -ne $user.Value) { exit 1 }
  if (-not $actual.AreAccessRulesProtected) { exit 1 }
  foreach($rule in $actual.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier])) {
    if ($rule.AccessControlType -eq 'Allow' -and $rule.IdentityReference.Value -notin @($user.Value,$system.Value)) { exit 1 }
  }
} catch { exit 1 }`;
const powershell = () =>
  path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');

/**
 * Create a new private directory for a copy under `root` before any private byte exists.
 * Windows: created with a protected owner-only ACL in one call (Node modes do not restrict
 * ACLs, and a shared temporary root may grant inherited access). POSIX: `mkdtemp` (0700),
 * then mode and owner are verified.
 * @param {string} root
 * @returns {Promise<string>}
 */
export async function createPrivateDirectory(root) {
  if (process.platform === 'win32') {
    const directory = path.join(root, `kodo-report-snapshot-${randomBytes(12).toString('hex')}`);
    await execute(
      powershell(),
      [
        '-NoLogo',
        '-NoProfile',
        '-NonInteractive',
        '-EncodedCommand',
        Buffer.from(createScript, 'utf16le').toString('base64'),
      ],
      { input: directory, env: workerEnvironment(), timeoutMs: 30000 },
    );
    return directory;
  }
  const directory = mkdtempSync(path.join(root, 'kodo-report-snapshot-'));
  const info = await lstat(directory);
  if (!info.isDirectory() || info.mode & 0o077 || info.uid !== process.getuid?.()) {
    rmSync(directory, { recursive: true, force: true });
    throw new Error('copy_not_private');
  }
  return directory;
}

export const STATE_ATTEMPTS = 3;
/** Removal of a private copy is retried while Windows still holds a handle on it. */
export const REMOVE_ATTEMPTS = 5;
const REMOVE_DELAY_MS = 100;
const REMOVE_RETRY_CODES = new Set(['EPERM', 'EBUSY']);
const MAX_CREDENTIAL_BYTES = 1024 * 1024;
const fail = code => {
  throw Object.assign(new Error(code), { code });
};

const probe = filename => ({
  db: statSync(filename, { throwIfNoEntry: false }),
  wal: statSync(`${filename}-wal`, { throwIfNoEntry: false }),
});
const mark = info => (info ? `${info.size}:${info.mtimeMs}:${info.ctimeMs}` : 'absent');

/** Immutable: no lock, no shared memory, no WAL read and no sidecar file is ever created. */
function openImmutable(filename) {
  const uri = pathToFileURL(path.resolve(filename));
  uri.searchParams.set('mode', 'ro');
  uri.searchParams.set('immutable', '1');
  const db = new DatabaseSync(uri.href, { readOnly: true });
  try {
    db.exec('PRAGMA query_only=ON');
    const tables = new Set(
      db
        .prepare("SELECT name FROM sqlite_master WHERE type='table'")
        .all()
        .map(row => String(row.name)),
    );
    return { db, tables };
  } catch (error) {
    db.close();
    throw error;
  }
}

/** The real path of `target`, or that of its nearest existing ancestor followed by the rest. */
function canonical(target) {
  const resolved = path.resolve(target);
  try {
    return realpathSync.native(resolved);
  } catch (error) {
    const parent = path.dirname(resolved);
    if (error?.code !== 'ENOENT' || parent === resolved) throw error;
    return path.join(canonical(parent), path.basename(resolved));
  }
}
const contains = (outer, inner) => {
  const relative = path.relative(outer, inner);
  // Only the platform separator splits a path: on POSIX `..\x` is one name inside `outer`.
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
};

/**
 * The real temporary root for private copies. Refused (`report_unavailable`)
 * before any file is created when it lies inside a protected home or contains one.
 */
function snapshotRoot(temporaryRoot, protectedRoots) {
  let root;
  try {
    root = realpathSync.native(path.resolve(temporaryRoot));
  } catch {
    return fail('report_unavailable');
  }
  for (const item of protectedRoots) {
    const guarded = canonical(item);
    if (contains(guarded, root) || contains(root, guarded)) fail('report_unavailable');
  }
  return root;
}

/**
 * Copy the database and its WAL into `directory` and fold the committed frames
 * into the copy. False when the live files changed while they were copied or the
 * copy fails its integrity check. Recovery happens only inside the private directory.
 */
function copyInto(filename, before, directory) {
  const copy = path.join(directory, 'state.sqlite');
  try {
    copyFileSync(filename, copy);
    copyFileSync(`${filename}-wal`, `${copy}-wal`);
    const after = probe(filename);
    if (mark(after.db) !== mark(before.db) || mark(after.wal) !== mark(before.wal)) return false;
    const db = new DatabaseSync(copy);
    try {
      if (db.prepare('PRAGMA quick_check').get()?.quick_check !== 'ok') return false;
      db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    } finally {
      db.close();
    }
    return true;
  } catch {
    return false;
  }
}

/** Remove a private copy; a transient Windows lock is waited out a bounded number of times. */
async function removeCopy(directory, remove) {
  for (let attempt = 1; ; attempt++) {
    try {
      remove(directory, { recursive: true, force: true });
      return;
    } catch (error) {
      // A copy that cannot be removed is never left behind silently.
      if (!REMOVE_RETRY_CODES.has(error?.code) || attempt >= REMOVE_ATTEMPTS) fail('report_unavailable');
      await sleep(REMOVE_DELAY_MS);
    }
  }
}

/**
 * Run `read` against a consistent read-only view of `home/state.sqlite`. The view
 * carries `snapshot: { method: 'immutable' | 'wal-copy', attempts }`.
 * @template T
 * @param {string} home
 * @param {(state: { db: DatabaseSync, tables: Set<string>,
 *   snapshot?: { method: 'immutable' | 'wal-copy', attempts: number } }) => Promise<T> | T} read
 * @param {{ probed?: () => unknown, temporaryRoot?: string, credentialHome?: string,
 *   removeDirectory?: (directory: string, options: { recursive: boolean, force: boolean }) => void,
 *   createDirectory?: (root: string) => Promise<string> }} [options]
 *   `probed` is a test seam called after the files were inspected and before they are opened or
 *   copied; `removeDirectory` is the removal port of a private copy.
 * @returns {Promise<T>}
 */
export async function readReportState(
  home,
  read,
  {
    probed,
    temporaryRoot = os.tmpdir(),
    credentialHome = credentialRoot(),
    removeDirectory = rmSync,
    createDirectory = createPrivateDirectory,
  } = {},
) {
  const filename = path.join(home, 'state.sqlite');
  let root;
  for (let attempt = 0; attempt < STATE_ATTEMPTS; attempt++) {
    const before = probe(filename);
    if (!before.db?.isFile()) fail('report_not_found');
    await probed?.();
    // The temporary root is checked before the first file of a copy is created.
    if (before.wal?.size) root ??= snapshotRoot(temporaryRoot, [home, credentialHome]);
    // The private copy directory is created private: no byte is copied into an open one.
    const directory = before.wal?.size ? await createDirectory(root) : null;
    // A private copy cannot change. The live main file can only change by a checkpoint: read again then.
    const stable = () => directory !== null || mark(probe(filename).db) === mark(before.db);
    let state;
    try {
      if (directory && !copyInto(filename, before, directory)) continue;
      state = openImmutable(directory ? path.join(directory, 'state.sqlite') : filename);
      const snapshot = { method: directory ? 'wal-copy' : 'immutable', attempts: attempt + 1 };
      const result = await read({ ...state, snapshot });
      if (stable()) return result;
    } catch (error) {
      if (stable()) throw error;
    } finally {
      state?.db.close();
      if (directory) await removeCopy(directory, removeDirectory);
    }
  }
  return fail('report_unavailable');
}

async function boundedFile(file) {
  let info;
  try {
    info = await lstat(file);
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
  if (!info.isFile() || info.size > MAX_CREDENTIAL_BYTES) fail('report_unavailable');
  return readFile(file);
}

function secretValues(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('report_unavailable');
  const result = {};
  for (const name of secretNames) {
    if (value[name] !== undefined && typeof value[name] !== 'string') fail('report_unavailable');
    if (value[name]) result[name] = value[name];
  }
  return result;
}

function parseSecrets(bytes) {
  try {
    return secretValues(JSON.parse(bytes.toString('utf8').replace(/^﻿/, '')));
  } finally {
    bytes.fill(0);
  }
}

/** The credential store's envelope and DPAPI decryption are shared with `loadSecrets` (read-only part only). */
async function storedSecrets(bytes, platform, decrypt) {
  let text;
  try {
    text = bytes.toString('utf8');
  } finally {
    bytes.fill(0);
  }
  return decodeCredentials(text, { platform, decrypt });
}

/**
 * Every key value known to this user, for redaction only: environment values,
 * the credential store and a legacy `<home>/secrets.json`, each read as is.
 * Unlike `loadSecrets`, no directory is created, no permission is changed and a
 * legacy file is neither migrated nor removed. A store that exists but cannot be
 * read fails closed (`report_unavailable`): a report is never printed without
 * the keys it must redact.
 * @param {{ home: string, environment?: NodeJS.ProcessEnv, platform?: NodeJS.Platform, directory?: string,
 *   decrypt?: (ciphertext: Buffer) => Promise<Buffer> }} options
 * @returns {Promise<Record<string, string>>}
 */
export async function readRedactionSecrets({
  home,
  environment = process.env,
  platform = process.platform,
  directory = credentialRoot(environment, platform),
  decrypt = decryptWindowsCredentials,
}) {
  try {
    const legacyBytes = await boundedFile(path.join(home, 'secrets.json'));
    const storeFile = path.join(directory, platform === 'win32' ? 'credentials.dpapi.json' : 'credentials.json');
    const storedBytes = await boundedFile(storeFile);
    const legacy = legacyBytes ? parseSecrets(legacyBytes) : {};
    const stored = storedBytes ? await storedSecrets(storedBytes, platform, decrypt) : {};
    const result = {};
    for (const name of secretNames)
      for (const [key, value] of [
        [`KODO_${name}`, environment[`KODO_${name}`]],
        [name, environment[name]],
        [`stored:${name}`, stored[name]],
        [`legacy:${name}`, legacy[name]],
      ])
        if (typeof value === 'string' && value) result[key] = value;
    return result;
  } catch {
    return fail('report_unavailable');
  }
}
