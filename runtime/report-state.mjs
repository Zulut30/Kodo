/** Read-only access to Kodo state and credentials for `kodo report`.
 *
 * Nothing here writes, migrates or changes permissions of a file in the state
 * home or the credential directory:
 * - `readReportState` never opens the live database files with a lock or a
 *   shared-memory index. Without pending WAL frames the main file is opened
 *   `immutable`; with them, the database and its WAL are copied into a private
 *   temporary directory, the copy is recovered and checked there and removed
 *   afterwards. A copy or a read that raced a writer is retried, then refused.
 * - `readRedactionSecrets` reads existing keys (environment, the credential
 *   store and a legacy `secrets.json`) only to redact output. It creates no
 *   directory and does not migrate a legacy file.
 * See docs/OBSERVABILITY.md.
 */
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { copyFileSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { lstat, readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { credentialRoot, secretNames, workerEnvironment } from './security.mjs';

export const STATE_ATTEMPTS = 3;
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

/**
 * A private copy of the database with its committed WAL frames folded in, or
 * null when the live files changed while they were copied or the copy fails
 * its integrity check. Recovery happens only inside the private directory.
 */
function privateCopy(filename, before, temporaryRoot) {
  const directory = mkdtempSync(path.join(temporaryRoot, 'kodo-report-snapshot-'));
  const copy = path.join(directory, 'state.sqlite');
  try {
    copyFileSync(filename, copy);
    copyFileSync(`${filename}-wal`, `${copy}-wal`);
    const after = probe(filename);
    if (mark(after.db) !== mark(before.db) || mark(after.wal) !== mark(before.wal)) throw new Error('changed');
    const db = new DatabaseSync(copy);
    try {
      if (db.prepare('PRAGMA quick_check').get()?.quick_check !== 'ok') throw new Error('corrupt');
      db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    } finally {
      db.close();
    }
    return directory;
  } catch {
    rmSync(directory, { recursive: true, force: true });
    return null;
  }
}

/**
 * Run `read` against a consistent read-only view of `home/state.sqlite`.
 * @template T
 * @param {string} home
 * @param {(state: { db: DatabaseSync, tables: Set<string> }) => Promise<T> | T} read
 * @param {{ probed?: () => unknown, temporaryRoot?: string }} [options] `probed` is a test seam
 *   called after the files were inspected and before they are opened or copied.
 * @returns {Promise<T>}
 */
export async function readReportState(home, read, { probed, temporaryRoot = os.tmpdir() } = {}) {
  const filename = path.join(home, 'state.sqlite');
  for (let attempt = 0; attempt < STATE_ATTEMPTS; attempt++) {
    const before = probe(filename);
    if (!before.db?.isFile()) fail('report_not_found');
    await probed?.();
    const directory = before.wal?.size ? privateCopy(filename, before, temporaryRoot) : null;
    if (before.wal?.size && !directory) continue;
    // A private copy cannot change. The live main file can only change by a checkpoint: read again then.
    const stable = () => directory !== null || mark(probe(filename).db) === mark(before.db);
    let state;
    try {
      state = openImmutable(directory ? path.join(directory, 'state.sqlite') : filename);
      const result = await read(state);
      if (stable()) return result;
    } catch (error) {
      if (stable()) throw error;
    } finally {
      state?.db.close();
      if (directory) rmSync(directory, { recursive: true, force: true });
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
    return secretValues(JSON.parse(bytes.toString('utf8').replace(/^\uFEFF/, '')));
  } finally {
    bytes.fill(0);
  }
}

// Decrypt only: the same envelope and entropy as the credential store in security.mjs.
const dpapiDecryptScript = `
$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = [Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
try {
  Add-Type -AssemblyName System.Security
  $data = [Convert]::FromBase64String([Console]::In.ReadToEnd().Trim())
  $entropy = [Text.Encoding]::UTF8.GetBytes('Kodo credentials v1')
  $result = [Security.Cryptography.ProtectedData]::Unprotect($data, $entropy, [Security.Cryptography.DataProtectionScope]::CurrentUser)
  [Console]::Out.Write([Convert]::ToBase64String($result))
  exit 0
} catch { exit 1 }
`;

/** @param {Buffer} ciphertext @returns {Promise<Buffer>} */
function dpapiDecrypt(ciphertext) {
  return new Promise((resolve, reject) => {
    const executable = path.join(
      process.env.SystemRoot || 'C:\\Windows',
      'System32/WindowsPowerShell/v1.0/powershell.exe',
    );
    const script = Buffer.from(dpapiDecryptScript, 'utf16le').toString('base64');
    const child = spawn(executable, ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', script], {
      windowsHide: true,
      shell: false,
      stdio: ['pipe', 'pipe', 'ignore'],
      env: workerEnvironment(),
    });
    let chunks = [],
      size = 0,
      finished = false;
    const finish = failed => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      const output = Buffer.concat(chunks);
      for (const chunk of chunks) chunk.fill(0);
      chunks = [];
      const text = failed ? '' : output.toString('utf8').trim();
      output.fill(0);
      if (/^[A-Za-z0-9+/]+={0,2}$/.test(text)) resolve(Buffer.from(text, 'base64'));
      else reject(Object.assign(new Error('report_unavailable'), { code: 'report_unavailable' }));
    };
    const timer = setTimeout(() => {
      child.kill();
      finish(true);
    }, 30_000);
    child.stdout.on('data', chunk => {
      size += chunk.length;
      if (finished) chunk.fill(0);
      else if (size > MAX_CREDENTIAL_BYTES) {
        chunk.fill(0);
        child.kill();
        finish(true);
      } else chunks.push(chunk);
    });
    child.on('error', () => finish(true));
    child.on('close', code => finish(code !== 0));
    child.stdin.on('error', () => finish(true));
    child.stdin.end(ciphertext.toString('base64'));
  });
}

async function storedSecrets(bytes, platform, decrypt) {
  let envelope;
  try {
    envelope = JSON.parse(bytes.toString('utf8').replace(/^\uFEFF/, ''));
  } finally {
    bytes.fill(0);
  }
  const protection = platform === 'win32' ? 'windows-dpapi-current-user' : 'file-permissions';
  if (envelope?.version !== 1 || envelope.protection !== protection) fail('report_unavailable');
  if (platform !== 'win32') return secretValues(envelope.data);
  if (typeof envelope.data !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(envelope.data)) fail('report_unavailable');
  return parseSecrets(await decrypt(Buffer.from(envelope.data, 'base64')));
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
  decrypt = dpapiDecrypt,
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
