import { execFileSync } from 'node:child_process';
import { lstatSync, readdirSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { workerEnvironment } from './security.mjs';
import { relativeFile } from './toolchains.mjs';

// Node does not expose FileCaseSensitiveInfo. For a sparse entry, query the
// containing directory handle and compare the names using Windows ordinal
// casing. The output of fsutil's queryCaseSensitiveInfo command is localized.
const query = `
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::InputEncoding = [Text.UTF8Encoding]::new($false)
$request = [Console]::In.ReadToEnd() | ConvertFrom-Json
Add-Type -Name Directory -Namespace Kodo -MemberDefinition @'
[DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
public static extern Microsoft.Win32.SafeHandles.SafeFileHandle CreateFile(string path, uint access, uint share, IntPtr security, uint creation, uint flags, IntPtr template);
[DllImport("kernel32.dll", SetLastError=true)]
public static extern bool GetFileInformationByHandleEx(Microsoft.Win32.SafeHandles.SafeFileHandle file, int infoClass, out uint flags, uint size);
[DllImport("kernel32.dll", CharSet=CharSet.Unicode)]
public static extern int CompareStringOrdinal(string a, int sizeA, string b, int sizeB, bool ignoreCase);
'@
# FILE_READ_ATTRIBUTES, share read/write/delete, OPEN_EXISTING,
# FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT
$handle = [Kodo.Directory]::CreateFile($request.directory, 0x80, 7, [IntPtr]::Zero, 3, 0x02200000, [IntPtr]::Zero)
try {
  [uint32]$flags = 0
  if ($handle.IsInvalid -or ![Kodo.Directory]::GetFileInformationByHandleEx($handle, 23, [ref]$flags, 4)) { exit 1 }
  if ($flags -band 1) { [Console]::Write('sensitive') }
  elseif ([Kodo.Directory]::CompareStringOrdinal($request.name, -1, $request.spelling, -1, $true) -eq 2) { [Console]::Write('alias') }
  else { [Console]::Write('distinct') }
} finally { $handle.Dispose() }
`;

function queryDirectory(directory, name, spelling) {
  const system = process.env.SystemRoot || 'C:\\Windows';
  const shell = path.join(system, 'System32/WindowsPowerShell/v1.0/powershell.exe');
  const args = [
    '-NoLogo',
    '-NoProfile',
    '-NonInteractive',
    '-EncodedCommand',
    Buffer.from(query, 'utf16le').toString('base64'),
  ];
  const result = execFileSync(shell, args, {
    cwd: system,
    env: workerEnvironment(),
    stdio: 'pipe',
    windowsHide: true,
    timeout: 10000,
    maxBuffer: 16384,
    input: JSON.stringify({ directory: path.toNamespacedPath(directory), name, spelling }),
    encoding: 'utf8',
  });
  if (!['alias', 'distinct', 'sensitive'].includes(result)) throw new Error('Invalid Windows directory lookup');
  return result;
}

// A missing snapshot directory would inherit the nearest materialized parent's
// case flag. A file or junction in the checkout must never redirect the probe.
function nearestDirectory(root, parent) {
  let existing = '.';
  for (const part of parent === '.' ? [] : parent.split('/')) {
    const child = path.posix.join(existing, part);
    if (!lstatSync(path.join(root, child), { throwIfNoEntry: false })?.isDirectory()) break;
    existing = child;
  }
  return existing;
}

const fileId = file => lstatSync(file, { bigint: true, throwIfNoEntry: false });
function observedAlias(root, original, spelling) {
  const entry = fileId(path.join(root, original));
  if (!entry) return undefined;
  const alias = fileId(path.join(root, spelling));
  if (alias?.ino !== entry.ino || alias.dev !== entry.dev) return false;
  if (entry.nlink === 1n && entry.ino !== 0n) return true;
  // Distinct names can be hard links to the same inode in a sensitive directory.
  const entries = readdirSync(path.join(root, path.posix.dirname(original)));
  return !entries.includes(path.posix.basename(original)) || !entries.includes(path.posix.basename(spelling));
}

const asciiFold = name => name.replace(/[a-z]/g, c => c.toUpperCase());

// The caller supplies sibling spellings from its selected tree. Case mode is
// per directory, and a Unicode lookup can require more than JS uppercasing.
export function cargoPathAliasProbe(root, { materializedOnly = false } = {}) {
  const insensitive = new Map();
  let project;
  return (original, spelling) => {
    const parent = path.posix.dirname(relativeFile(original));
    const gitPath = /(?:^|\/)(?:\.git|git~\d+)(?:\/|$)/i;
    if (parent !== path.posix.dirname(relativeFile(spelling)) || gitPath.test(original) || gitPath.test(spelling))
      throw new Error('Unsafe Cargo directory lookup');
    const name = path.posix.basename(original);
    const requested = path.posix.basename(spelling);
    const ascii = asciiFold(name) === asciiFold(requested);
    const cached = insensitive.get(parent);
    if (cached === false || (ascii && cached === true)) return cached;
    project ??= realpathSync.native(path.resolve(root));
    const existing = nearestDirectory(project, parent);
    const inherited = insensitive.get(existing);
    if (inherited === false || (ascii && inherited === true)) return inherited;
    if (existing === parent) {
      const alias = observedAlias(project, original, spelling);
      if (alias !== undefined) {
        if (ascii) insensitive.set(parent, alias);
        return alias;
      }
    }
    if (materializedOnly) return false;
    const result = queryDirectory(path.join(project, existing), name, requested);
    insensitive.set(existing, result !== 'sensitive');
    insensitive.set(parent, result !== 'sensitive');
    return result === 'alias';
  };
}
