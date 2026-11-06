import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, writeFile, rename, unlink, chmod, realpath } from 'node:fs/promises';
import { execute } from './command.mjs';
import { noLinks } from './toolchains.mjs';
import { assertPrivateArtifactPath } from './progress.mjs';
import { workerEnvironment } from './security.mjs';
import { inspectCurrentSource, planAffected } from './ci-graph.mjs';

const kinds = new Set(['test', 'build', 'lint', 'typecheck']);
const digest = value => createHash('sha256').update(value).digest('hex');
const hex = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const canonical = value => {
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'boolean' ||
    (typeof value === 'number' && Number.isFinite(value))
  )
    return value;
  if (Array.isArray(value)) return value.map(canonical);
  if (value && Object.getPrototypeOf(value) === Object.prototype)
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map(key => [key, canonical(value[key])]),
    );
  throw new Error('Invalid cache fingerprint data');
};
const encode = value => JSON.stringify(canonical(value));
const object = value => value && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
function fingerprintContext(input) {
  if (
    !object(input) ||
    !path.isAbsolute(input.project || '') ||
    !/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(input.headSha || '') ||
    !['sourceHash', 'dependencyHash', 'lockHash', 'envHash'].every(key => hex(input[key])) ||
    !kinds.has(input.kind) ||
    typeof input.command !== 'string' ||
    !input.command.trim() ||
    !Array.isArray(input.args) ||
    input.args.some(arg => typeof arg !== 'string') ||
    !object(input.gateConfig) ||
    !object(input.runtimeVersions) ||
    !['node', 'v8', 'modules'].every(
      key => typeof input.runtimeVersions[key] === 'string' && input.runtimeVersions[key],
    ) ||
    !object(input.toolVersions) ||
    !Object.keys(input.toolVersions).length ||
    Object.values(input.toolVersions).some(version => typeof version !== 'string' || !version.trim()) ||
    ![input.platform, input.arch].every(value => typeof value === 'string' && value)
  )
    throw new Error('Incomplete cache fingerprint');
  // Keep raw arguments/environment/config out of the persisted receipt. The
  // caller must freshly observe tools/env/gates before deriving a lookup key.
  return {
    schemaVersion: 1,
    project: path.resolve(input.project),
    headSha: input.headSha,
    sourceHash: input.sourceHash,
    dependencyHash: input.dependencyHash,
    lockHash: input.lockHash,
    envHash: input.envHash,
    runtimeVersions: canonical(input.runtimeVersions),
    toolsHash: digest(encode(input.toolVersions)),
    platform: input.platform,
    arch: input.arch,
    kind: input.kind,
    commandHash: digest(encode({ command: input.command, args: input.args })),
    gateConfigHash: digest(encode(input.gateConfig)),
  };
}

/** A key is data, never proof. Pass freshly observed complete context on every lookup. */
export function cacheFingerprint(input) {
  return digest(encode(fingerprintContext(input)));
}

async function git(project, args) {
  return (await execute('git', args, { cwd: project, env: workerEnvironment(), rawOutput: true, timeoutMs: 30000 }))
    .stdout;
}
async function current(context, project, headSha) {
  if (
    context.project !== path.resolve(project) ||
    context.headSha !== headSha ||
    context.platform !== process.platform ||
    context.arch !== process.arch ||
    !['node', 'v8', 'modules'].every(key => context.runtimeVersions[key] === process.versions[key])
  )
    return false;
  await noLinks(project);
  if ((await realpath(project)) !== path.resolve(project)) return false;
  if ((await inspectCurrentSource({ project, headSha })) !== 'clean') return false;
  const plan = await planAffected({ project, baseSha: headSha, headSha });
  const locks = (await git(project, ['ls-tree', '-rz', '--full-tree', headSha]))
    .split('\0')
    .filter(Boolean)
    .flatMap(row => {
      const match = /^\d+ \w+ ([a-f0-9]+)\t([\s\S]+)$/.exec(row);
      return match &&
        /(?:^|\/)(?:package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb?)$/.test(match[2])
        ? [[match[2], match[1]]]
        : [];
    })
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return (
    !plan.fallback &&
    plan.sourceHash === context.sourceHash &&
    plan.dependencyHash === context.dependencyHash &&
    digest(JSON.stringify(locks)) === context.lockHash
  );
}

// Fixed script: user paths travel over stdin, never shell interpolation. Only
// the cache-owned directory/new temporary file are protected. Read never repairs.
const aclScript = `$ErrorActionPreference='Stop'
[Console]::InputEncoding=[Text.UTF8Encoding]::new($false)
try {
  $r=[Console]::In.ReadToEnd() | ConvertFrom-Json
  $user=[Security.Principal.WindowsIdentity]::GetCurrent().User
  $system=[Security.Principal.SecurityIdentifier]::new('S-1-5-18')
  if ($r.protect) {
    $acl=[Security.AccessControl.DirectorySecurity]::new()
    $acl.SetOwner($user); $acl.SetAccessRuleProtection($true,$false)
    $inherit=[Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [Security.AccessControl.InheritanceFlags]::ObjectInherit
    foreach($sid in @($user,$system)) { $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($sid,[Security.AccessControl.FileSystemRights]::FullControl,$inherit,[Security.AccessControl.PropagationFlags]::None,[Security.AccessControl.AccessControlType]::Allow)) }
    [IO.Directory]::SetAccessControl($r.target,$acl)
  }
  if ($r.protectFile) {
    $acl=[Security.AccessControl.FileSecurity]::new()
    $acl.SetOwner($user); $acl.SetAccessRuleProtection($true,$false)
    foreach($sid in @($user,$system)) { $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($sid,[Security.AccessControl.FileSystemRights]::FullControl,[Security.AccessControl.AccessControlType]::Allow)) }
    [IO.File]::SetAccessControl($r.file,$acl)
  }
  $actual=[IO.Directory]::GetAccessControl($r.target)
  if (-not $actual.AreAccessRulesProtected) { exit 1 }
  $entries=@($actual)
  if ($r.file) { $entries+=([IO.File]::GetAccessControl($r.file)) }
  foreach($entry in $entries) {
    if ($entry.GetOwner([Security.Principal.SecurityIdentifier]).Value -ne $user.Value) { exit 1 }
    foreach($rule in $entry.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier])) {
      if ($rule.AccessControlType -eq 'Allow' -and $rule.IdentityReference.Value -notin @($user.Value,$system.Value)) { exit 1 }
    }
  }
} catch { exit 1 }`;
async function privateDirectory(directory, create, file, protectFile = false) {
  assertPrivateArtifactPath(directory);
  await noLinks(directory);
  if (create) await mkdir(directory, { recursive: true, mode: 0o700 });
  const info = await lstat(directory);
  if (!info.isDirectory()) throw new Error('Invalid private cache directory');
  if (process.platform === 'win32')
    await execute(
      path.join(process.env.SystemRoot || 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe'),
      [
        '-NoLogo',
        '-NoProfile',
        '-NonInteractive',
        '-EncodedCommand',
        Buffer.from(aclScript, 'utf16le').toString('base64'),
      ],
      {
        input: JSON.stringify({ target: directory, protect: create, file, protectFile }),
        env: workerEnvironment(),
        timeoutMs: 30000,
      },
    );
  else {
    if (create) await chmod(directory, 0o700);
    const actual = await lstat(directory);
    if (actual.mode & 0o077 || actual.uid !== process.getuid()) throw new Error('Non-private cache permissions');
  }
  assertPrivateArtifactPath(directory);
  await noLinks(directory);
}
async function regularPrivateFile(file, maxBytes = 16 * 1024 * 1024) {
  assertPrivateArtifactPath(file);
  await noLinks(file);
  const info = await lstat(file);
  if (!info.isFile() || info.nlink !== 1 || info.size > maxBytes) throw new Error('Unsafe cache evidence');
  return info;
}
async function evidenceValid(evidence) {
  if (!Array.isArray(evidence) || evidence.length < 1 || evidence.length > 20) return false;
  for (const row of evidence) {
    if (
      !row ||
      !path.isAbsolute(row.path || '') ||
      !hex(row.sha256) ||
      !Number.isSafeInteger(row.bytes) ||
      row.bytes < 0
    )
      return false;
    const info = await regularPrivateFile(row.path);
    if (info.size !== row.bytes || digest(await readFile(row.path)) !== row.sha256) return false;
  }
  return true;
}
function successful(receipt, context, input) {
  return (
    receipt &&
    kinds.has(receipt.kind) &&
    receipt.kind === context.kind &&
    receipt.exitCode === 0 &&
    receipt.status === 'passed' &&
    receipt.complete === true &&
    receipt.headSha === context.headSha &&
    (!receipt.trust || receipt.trust === 'private-local') &&
    (input
      ? receipt.command === input.command && encode(receipt.args) === encode(input.args)
      : receipt.commandHash === context.commandHash)
  );
}
function location(home, fingerprint) {
  if (!home || !path.isAbsolute(home) || !hex(fingerprint)) throw new Error('Invalid private cache location');
  const directory = path.join(path.resolve(home), 'ci-check-cache-v1');
  return { directory, file: path.join(directory, `${fingerprint}.json`) };
}

/** Only the command receipt is reused. UI/security receipts are always fresh. */
export async function readCheckCache({ home, fingerprint, project, headSha, trust = 'private-local', input }) {
  try {
    if (trust !== 'private-local' || !input || cacheFingerprint(input) !== fingerprint) return null;
    const { directory, file } = location(home, fingerprint);
    const info = await regularPrivateFile(file, 256 * 1024);
    await privateDirectory(directory, false, file);
    if (process.platform !== 'win32' && (info.mode & 0o077 || info.uid !== process.getuid())) return null;
    const envelope = JSON.parse(await readFile(file, 'utf8'));
    if (
      envelope.schemaVersion !== 1 ||
      envelope.trust !== 'private-local' ||
      envelope.fingerprint !== fingerprint ||
      !hex(envelope.integrityHash) ||
      digest(encode({ context: envelope.context, receipt: envelope.receipt })) !== envelope.integrityHash ||
      digest(encode(envelope.context)) !== fingerprint ||
      !successful(envelope.receipt, envelope.context) ||
      !(await current(envelope.context, project, headSha)) ||
      !(await evidenceValid(envelope.receipt.evidence))
    )
      return null;
    return { ...envelope.receipt, trust: 'private-local' };
  } catch {
    return null;
  }
}

/** Failed/missing/dirty/public input is a miss; cache I/O never manufactures PASS. */
export async function writeCheckCache({
  home,
  fingerprint,
  receipt,
  project,
  headSha,
  input,
  trust = 'private-local',
}) {
  let temporary;
  try {
    if (trust !== 'private-local') return false;
    const context = fingerprintContext(input),
      { directory, file } = location(home, fingerprint);
    if (
      digest(encode(context)) !== fingerprint ||
      !successful(receipt, context, input) ||
      !(await current(context, project, headSha)) ||
      !(await evidenceValid(receipt.evidence))
    )
      return false;
    await privateDirectory(directory, true);
    try {
      await regularPrivateFile(file, 256 * 1024);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    const saved = {
      kind: receipt.kind,
      status: 'passed',
      exitCode: 0,
      complete: true,
      headSha,
      commandHash: context.commandHash,
      evidence: receipt.evidence.map(({ path: filePath, bytes, sha256 }) => ({ path: filePath, bytes, sha256 })),
    };
    const envelope = {
      schemaVersion: 1,
      trust: 'private-local',
      fingerprint,
      context,
      receipt: saved,
      integrityHash: digest(encode({ context, receipt: saved })),
    };
    temporary = path.join(directory, `.${randomUUID()}.tmp`);
    await writeFile(temporary, encode(envelope) + '\n', { flag: 'wx', mode: 0o600 });
    await regularPrivateFile(temporary, 256 * 1024);
    if (process.platform === 'win32') await privateDirectory(directory, false, temporary, true);
    await noLinks(directory);
    await rename(temporary, file);
    temporary = undefined;
    return true;
  } catch {
    return false;
  } finally {
    if (temporary) await unlink(temporary).catch(() => {});
  }
}
