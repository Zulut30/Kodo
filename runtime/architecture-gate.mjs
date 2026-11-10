/** Coordinator gate for fresh, offline Architecture Guardian evidence. */
import path from 'node:path';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile, lstat, realpath } from 'node:fs/promises';
import { execute } from './command.mjs';
import { workerEnvironment } from './security.mjs';
import { assertPrivateArtifactPath } from './progress.mjs';
import { noLinks, inside } from './toolchains.mjs';

const digest = value => createHash('sha256').update(value).digest('hex');
function canonical(value) {
  if (
    value === null ||
    ['string', 'boolean'].includes(typeof value) ||
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
  throw new TypeError('Invalid architecture record');
}
const hash = value => digest(JSON.stringify(canonical(value)));
const failure = code => Object.assign(new Error('Architecture gate requires current complete evidence'), { code });
const runtime = () => ({
  node: process.versions.node,
  abi: process.versions.modules,
  platform: process.platform,
  arch: process.arch,
});
export function normalizeArchitectureConfig(value = {}) {
  if (
    !value ||
    Object.getPrototypeOf(value) !== Object.prototype ||
    Object.keys(value).some(key => key !== 'enabled') ||
    (value.enabled !== undefined && typeof value.enabled !== 'boolean')
  )
    throw failure('invalid_architecture_config');
  return { enabled: value.enabled ?? false };
}
export const architectureConfigHash = config => hash(normalizeArchitectureConfig(config));

// Bind both pinned parser bytes and every local checker/runner boundary. Read
// live bytes again at acceptance; cached module code cannot bless edited pins.
async function pins() {
  const files = [
    'architecture-gate.mjs',
    'architecture-cli.mjs',
    'architecture-graph.mjs',
    'architecture-policy.mjs',
    'architecture-debt.mjs',
    'contract-registry.mjs',
    'javascript-dependencies.mjs',
    'ci-graph.mjs',
    'command.mjs',
    'delivery.mjs',
    'delivery-process.mjs',
    'delivery-context.mjs',
    'delivery-release.mjs',
    'config.mjs',
    'engine.mjs',
    'engine-core.mjs',
    'engine-planning.mjs',
    'engine-execution.mjs',
    'engine-jobs.mjs',
    'fast-path.mjs',
    'context-manifest.mjs',
    'engine-verification.mjs',
    'security.mjs',
    'toolchains.mjs',
    'progress.mjs',
  ];
  const lock = new URL('../package-lock.json', import.meta.url);
  const urls = [
    ...files.map(file => new URL(file, import.meta.url)),
    new URL('../package.json', import.meta.url),
    lock,
    new URL(import.meta.resolve('acorn')),
  ];
  return hash(
    await Promise.all(
      urls.map(async url => {
        // npm installed packages do not contain package-lock.json. Bind its
        // absence too; declared dependency pins and actual parser bytes remain required.
        try {
          return { file: url.href, sha256: digest(await readFile(url)) };
        } catch (error) {
          if (url === lock && error.code === 'ENOENT') return { file: url.href, sha256: null };
          throw error;
        }
      }),
    ),
  );
}
const loadedPins = pins().catch(() => null);
const powershell = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe');
async function acl(script, paths, signal) {
  await execute(
    powershell,
    [
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-EncodedCommand',
      Buffer.from(
        "$ErrorActionPreference='Stop'; [Console]::InputEncoding=[Text.UTF8Encoding]::new($false); " + script,
        'utf16le',
      ).toString('base64'),
    ],
    { input: JSON.stringify(paths), env: workerEnvironment(), signal, timeoutMs: 20000 },
  );
}
async function privateDirectory(artifacts, cwd, signal) {
  if (typeof artifacts !== 'string' || !path.isAbsolute(artifacts)) throw failure('evidence_integrity');
  await noLinks(artifacts);
  assertPrivateArtifactPath(artifacts);
  await mkdir(artifacts, { recursive: true, mode: 0o700 });
  if (inside(await realpath(cwd), await realpath(artifacts))) throw failure('evidence_integrity');
  const directory = await mkdtemp(path.join(artifacts, 'architecture-gate-'));
  if (process.platform === 'win32')
    await acl(
      "$p=[Console]::In.ReadToEnd()|ConvertFrom-Json; $user=[Security.Principal.WindowsIdentity]::GetCurrent().User; $acl=[Security.AccessControl.DirectorySecurity]::new(); $acl.SetOwner($user); $acl.SetAccessRuleProtection($true,$false); foreach($sid in @($user,[Security.Principal.SecurityIdentifier]::new('S-1-5-18'))) {$acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($sid,'FullControl','ContainerInherit,ObjectInherit','None','Allow'))}; [IO.Directory]::SetAccessControl($p[0],$acl)",
      [directory],
      signal,
    );
  // The checker canonicalizes nested evidence paths. Use the same root spelling
  // so Windows 8.3 aliases cannot make valid evidence fail containment checks.
  return await realpath(directory);
}
async function readEvidence(entry, root) {
  if (
    !entry ||
    !path.isAbsolute(entry.path) ||
    !inside(root, entry.path) ||
    entry.path === root ||
    !Number.isSafeInteger(entry.bytes) ||
    entry.bytes < 1 ||
    entry.bytes > 40 * 1024 ** 2 ||
    !/^[a-f0-9]{64}$/.test(entry.sha256)
  )
    throw failure('evidence_integrity');
  await noLinks(entry.path);
  assertPrivateArtifactPath(entry.path);
  const info = await lstat(entry.path);
  if (
    !info.isFile() ||
    info.nlink !== 1 ||
    info.size !== entry.bytes ||
    (process.platform !== 'win32' && (info.uid !== process.getuid() || info.mode & 0o077))
  )
    throw failure('evidence_integrity');
  const bytes = await readFile(entry.path);
  if (digest(bytes) !== entry.sha256) throw failure('evidence_integrity');
  return JSON.parse(bytes.toString('utf8'));
}
async function privacy(root, entries, signal) {
  await noLinks(root);
  assertPrivateArtifactPath(root);
  const info = await lstat(root);
  if (!info.isDirectory() || (process.platform !== 'win32' && (info.uid !== process.getuid() || info.mode & 0o077)))
    throw failure('evidence_integrity');
  if (process.platform === 'win32')
    await acl(
      "$paths=[Console]::In.ReadToEnd()|ConvertFrom-Json; $user=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value; foreach($p in $paths) {$dir=[IO.Directory]::Exists($p); $a=if($dir){[IO.Directory]::GetAccessControl($p)}else{[IO.File]::GetAccessControl($p)}; if($a.GetOwner([Security.Principal.SecurityIdentifier]).Value -ne $user -or ($dir -and -not $a.AreAccessRulesProtected)){exit 1}; $rules=$a.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier]); foreach($r in $rules){if($r.IdentityReference.Value -notin @($user,'S-1-5-18') -or $r.AccessControlType -ne 'Allow'){exit 1}}; foreach($id in @($user,'S-1-5-18')) {$full=$false; foreach($r in $rules){if($r.IdentityReference.Value -eq $id -and ($r.FileSystemRights -band [Security.AccessControl.FileSystemRights]::FullControl) -eq [Security.AccessControl.FileSystemRights]::FullControl){$full=$true}}; if(-not $full){exit 1}}}",
      [root, ...entries.map(entry => entry.path)],
      signal,
    );
}
const snapshot = receipt => Object.fromEntries(Object.entries(receipt).filter(([key]) => key !== 'evidence'));
const staticReport = report =>
  Object.fromEntries(Object.entries(report).filter(([key]) => !['status', 'passed', 'receipts'].includes(key)));

/**
 * @typedef {object} ArchitectureGateOptions
 * @property {string} [cwd] Checked project checkout.
 * @property {string} [headSha] Exact head the receipt is bound to.
 * @property {string} [baseSha] Merge base of the affected-module plan.
 * @property {Record<string, any>} [config] Raw `architecture` configuration; normalized here.
 * @property {AbortSignal} [signal]
 */

/** @param {ArchitectureGateOptions & { artifacts?: string, secrets?: import('./security.mjs').Secrets }} [options] */
export async function runArchitectureChecks({
  cwd = process.cwd(),
  headSha,
  baseSha,
  config,
  artifacts,
  secrets = {},
  signal,
} = {}) {
  config = normalizeArchitectureConfig(config);
  const receipt = {
    schemaVersion: 1,
    status: 'disabled',
    passed: null,
    headSha,
    baseSha,
    configHash: architectureConfigHash(config),
  };
  if (!config.enabled) return receipt;
  const directory = await privateDirectory(artifacts, cwd, signal);
  Object.assign(receipt, {
    status: 'blocked',
    passed: false,
    cwd: await realpath(cwd),
    evidenceRoot: directory,
    runtime: runtime(),
    pinsHash: await pins(),
  });
  try {
    if (receipt.pinsHash !== (await loadedPins)) throw failure('checker_changed');
    // Lazy import avoids config -> gate -> E -> delivery import cycles.
    const { checkArchitecture } = await import('./architecture-cli.mjs');
    receipt.report = await checkArchitecture({
      project: cwd,
      baseSha,
      headSha,
      evidenceDir: directory,
      signal,
      redactions: secrets,
    });
    receipt.status =
      receipt.report.passed === true ? 'passed' : receipt.report.status === 'failed' ? 'failed' : 'blocked';
    receipt.passed = receipt.status === 'passed';
    if (receipt.pinsHash !== (await pins()) || hash(receipt.runtime) !== hash(runtime()))
      throw failure('checker_changed');
  } catch (error) {
    receipt.status = 'blocked';
    receipt.passed = false;
    receipt.reason = [
      'cancelled',
      'timeout',
      'evidence_integrity',
      'dirty_head',
      'changed_head',
      'configuration',
      'checker_changed',
    ].includes(error.code)
      ? error.code
      : 'configuration';
  }
  // Static rejections also have immutable, exact-base/head private evidence.
  const bytes = Buffer.from(JSON.stringify(snapshot(receipt)));
  const entry = { path: path.join(directory, 'gate.json'), bytes: bytes.length, sha256: digest(bytes) };
  await writeFile(entry.path, bytes, { flag: 'wx', mode: 0o400 });
  receipt.evidence = [entry];
  // File owner is independent of the parent's inherited DACL on elevated
  // Windows. Protect freshly created bytes; acceptance below remains read-only.
  if (process.platform === 'win32')
    await acl(
      "$p=[Console]::In.ReadToEnd()|ConvertFrom-Json; $user=[Security.Principal.WindowsIdentity]::GetCurrent().User; $a=[Security.AccessControl.FileSecurity]::new(); $a.SetOwner($user); $a.SetAccessRuleProtection($true,$false); foreach($sid in @($user,[Security.Principal.SecurityIdentifier]::new('S-1-5-18'))) {$a.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($sid,'FullControl','Allow'))}; [IO.File]::SetAccessControl($p[0],$a)",
      [entry.path],
      signal,
    );
  await privacy(directory, receipt.evidence, signal);
  return receipt;
}

/**
 * @param {any} receipt
 * @param {ArchitectureGateOptions & { project?: string, now?: any }} [options] `now` is a clock override forwarded to the CLI.
 */
// oxlint-disable-next-line complexity -- debt: docs/kodo-roadmap/MAINTAINABILITY-PLAN.md
export async function isCurrentArchitectureReceipt(
  receipt,
  { cwd, project, headSha, baseSha, config, signal, now } = {},
) {
  try {
    config = normalizeArchitectureConfig(config);
    if (!config.enabled) return true; // Neutral, never an enabled PASS.
    if (
      receipt?.schemaVersion !== 1 ||
      receipt.status !== 'passed' ||
      receipt.passed !== true ||
      receipt.headSha !== headSha ||
      receipt.baseSha !== baseSha ||
      receipt.configHash !== architectureConfigHash(config) ||
      (!cwd && !project) ||
      receipt.cwd !== (await realpath(cwd ?? project)) ||
      receipt.pinsHash !== (await loadedPins) ||
      receipt.pinsHash !== (await pins()) ||
      hash(receipt.runtime) !== hash(runtime()) ||
      receipt.evidence?.length !== 1
    )
      return false;
    const stored = await readEvidence(receipt.evidence[0], receipt.evidenceRoot);
    if (hash(stored) !== hash(snapshot(receipt))) return false;
    const { architectureCli } = await import('./architecture-cli.mjs');
    const planned = await architectureCli(['plan', '--project', receipt.cwd, '--base', baseSha, '--json'], {
      signal,
      ...(now ? { now } : {}),
    });
    if (
      planned.report.status !== 'planned' ||
      hash(staticReport(planned.report)) !== hash(staticReport(receipt.report))
    )
      return false;
    const report = receipt.report;
    if (
      report.status !== 'passed' ||
      report.passed !== true ||
      report.headSha !== headSha ||
      report.receipts.length !== report.requiredTests.length
    )
      return false;
    const entries = [...receipt.evidence];
    for (const [index, row] of report.receipts.entries()) {
      if (
        row.status !== 'passed' ||
        row.exitCode !== 0 ||
        row.file !== report.requiredTests[index].file ||
        row.headSha !== headSha ||
        row.sourceHash !== report.hashes.source ||
        row.policyHash !== report.hashes.policy ||
        row.registryHash !== report.hashes.registry ||
        hash(row.runtime) !== hash(receipt.runtime) ||
        row.id !== hash([headSha, row.file, row.sourceHash, row.policyHash, row.registryHash, row.runtime]) ||
        row.counts?.tests < 1 ||
        row.counts?.pass !== row.counts?.tests ||
        ['fail', 'cancelled', 'skipped', 'todo'].some(key => row.counts?.[key] !== 0) ||
        !row.evidence?.length
      )
        return false;
      for (const entry of row.evidence) {
        await readEvidence(entry, receipt.evidenceRoot);
        entries.push(entry);
      }
    }
    await privacy(receipt.evidenceRoot, entries, signal);
    // E owns the nested test directories and their protected ACLs as well.
    for (const directory of new Set(
      entries.map(entry => path.dirname(entry.path)).filter(directory => directory !== receipt.evidenceRoot),
    ))
      await privacy(directory, [], signal);
    return receipt.pinsHash === (await pins()) && hash(receipt.runtime) === hash(runtime());
  } catch {
    return false;
  }
}
