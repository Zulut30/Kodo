import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, rename, unlink, lstat, chmod } from 'node:fs/promises';

export const secretNames = ['GEMINI_API_KEY', 'TYPESAFE_API_KEY', 'SCRAPEDO_TOKEN', 'REDDIT_API_KEY', 'GETX_API_KEY'];
export function stateHome() { return path.resolve(process.env.KODO_HOME || path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), '.local', 'state'), 'Kodo')); }
export function credentialRoot(environment = process.env, platform = process.platform) {
  return path.resolve(environment.KODO_CREDENTIAL_HOME || (platform === 'win32'
    ? path.join(environment.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'Kodo-Credentials')
    : path.join(environment.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'kodo', 'credentials')));
}
export function worktreeHome(environment = process.env, platform = process.platform) {
  return path.resolve(environment.KODO_WORKTREE_HOME || path.join(platform === 'win32'
    ? environment.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local')
    : environment.XDG_STATE_HOME || path.join(os.homedir(), '.local', 'state'), 'Kodo-Worktrees'));
}

// These scripts are fixed; plaintext, ciphertext and paths travel only over private
// stdin/stdout pipes. DPAPI protects data at rest, not against arbitrary same-user code.
const dpapiScript = `
$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = [Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
try {
  Add-Type -AssemblyName System.Security
  $request = [Console]::In.ReadToEnd() | ConvertFrom-Json
  $data = [Convert]::FromBase64String($request.data)
  $entropy = [Text.Encoding]::UTF8.GetBytes('Kodo credentials v1')
  if ($request.operation -eq 'encrypt') {
    $result = [Security.Cryptography.ProtectedData]::Protect($data, $entropy, [Security.Cryptography.DataProtectionScope]::CurrentUser)
  } elseif ($request.operation -eq 'decrypt') {
    $result = [Security.Cryptography.ProtectedData]::Unprotect($data, $entropy, [Security.Cryptography.DataProtectionScope]::CurrentUser)
  } else { exit 1 }
  [Console]::Out.Write([Convert]::ToBase64String($result))
  exit 0
} catch { exit 1 }
`;
const aclScript = `
$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = [Text.UTF8Encoding]::new($false)
try {
  $request = [Console]::In.ReadToEnd() | ConvertFrom-Json
  $current = [Security.Principal.WindowsIdentity]::GetCurrent().User
  $system = [Security.Principal.SecurityIdentifier]::new('S-1-5-18')
  if ($request.directory) {
    $acl = [Security.AccessControl.DirectorySecurity]::new()
    $inheritance = [Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [Security.AccessControl.InheritanceFlags]::ObjectInherit
  } else {
    $acl = [Security.AccessControl.FileSecurity]::new()
    $inheritance = [Security.AccessControl.InheritanceFlags]::None
  }
  $acl.SetOwner($current)
  $acl.SetAccessRuleProtection($true, $false)
  foreach ($sid in @($current, $system)) {
    $rule = [Security.AccessControl.FileSystemAccessRule]::new($sid, [Security.AccessControl.FileSystemRights]::FullControl, $inheritance, [Security.AccessControl.PropagationFlags]::None, [Security.AccessControl.AccessControlType]::Allow)
    $acl.AddAccessRule($rule)
  }
  if ($request.directory) { [IO.Directory]::SetAccessControl($request.target, $acl) }
  else { [IO.File]::SetAccessControl($request.target, $acl) }
  exit 0
} catch { exit 1 }
`;
function credentialError(code = 'credential_store') {
  const error = new Error(code === 'credential_conflict'
    ? 'Конфликт миграции ключей Kodo: исходный файл сохранён'
    : 'Не удалось прочитать или защитить пользовательское хранилище ключей Kodo');
  error.code = code;
  return error;
}
function privatePowerShell(script, request) {
  return new Promise((resolve, reject) => {
    const executable = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    const child = spawn(executable, ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { windowsHide: true, shell: false, stdio: ['pipe', 'pipe', 'pipe'], env: workerEnvironment() });
    let output = [], size = 0, finished = false;
    const finish = error => {
      if (finished) return;
      finished = true; clearTimeout(timer);
      const result = error ? null : Buffer.concat(output);
      for (const chunk of output) chunk.fill(0); output = [];
      if (error) reject(credentialError());
      else resolve(result);
    };
    const timer = setTimeout(() => { child.kill(); finish(true); }, 30_000);
    child.stdout.on('data', chunk => { if (finished) { chunk.fill(0); return; } size += chunk.length; if (size > 1024 * 1024) { chunk.fill(0); child.kill(); finish(true); } else output.push(chunk); });
    child.stderr.resume(); // Never forward error output from a credential-handling process.
    child.on('error', () => finish(true));
    child.on('close', code => finish(code !== 0));
    child.stdin.on('error', () => finish(true));
    child.stdin.end(JSON.stringify(request));
  });
}
async function windowsCrypt(operation, input) {
  const output = await privatePowerShell(dpapiScript, { operation, data: Buffer.from(input).toString('base64') });
  try {
    const text = output.toString('utf8').trim();
    if (!text || !/^[A-Za-z0-9+/]+={0,2}$/.test(text)) throw credentialError();
    return Buffer.from(text, 'base64');
  } finally { output.fill(0); }
}
async function secureCredentialPath(target, directory, platform) {
  const info = await lstat(target);
  if (info.isSymbolicLink() || (directory ? !info.isDirectory() : !info.isFile())) throw credentialError();
  if (platform === 'win32') await privatePowerShell(aclScript, { target, directory });
  else await chmod(target, directory ? 0o700 : 0o600);
}
function onlySecrets(value) {
  if (!value || Array.isArray(value) || typeof value !== 'object') throw credentialError();
  const result = {};
  for (const name of secretNames) {
    if (value[name] !== undefined && typeof value[name] !== 'string') throw credentialError();
    if (value[name]) result[name] = value[name];
  }
  return result;
}
function sameSecrets(left, right) { return secretNames.every(name => (left[name] || '') === (right[name] || '')); }

// The injected crypto/permission operations keep migration failure tests portable.
export function createCredentialStore({ directory = credentialRoot(), legacyDirectory = stateHome(), platform = process.platform,
  encrypt = input => windowsCrypt('encrypt', input), decrypt = input => windowsCrypt('decrypt', input),
  securePath = (target, isDirectory) => secureCredentialPath(target, isDirectory, platform) } = {}) {
  const file = path.join(path.resolve(directory), platform === 'win32' ? 'credentials.dpapi.json' : 'credentials.json');
  const legacyFile = path.join(path.resolve(legacyDirectory), 'secrets.json');
  const protection = platform === 'win32' ? 'windows-dpapi-current-user' : 'file-permissions';
  async function prepare() { await mkdir(path.dirname(file), { recursive: true, mode: 0o700 }); await securePath(path.dirname(file), true); }
  async function readStored(filename = file) {
    try {
      await securePath(filename, false);
      const text = await readFile(filename, 'utf8');
      if (text.length > 1024 * 1024) throw credentialError();
      const envelope = JSON.parse(text.replace(/^\uFEFF/, ''));
      if (envelope.version !== 1 || envelope.protection !== protection) throw credentialError();
      if (platform !== 'win32') return onlySecrets(envelope.data);
      if (typeof envelope.data !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(envelope.data)) throw credentialError();
      const plaintext = await decrypt(Buffer.from(envelope.data, 'base64'));
      try { return onlySecrets(JSON.parse(plaintext.toString('utf8'))); }
      finally { plaintext.fill(0); }
    } catch (error) { if (error.code === 'ENOENT') return null; throw credentialError(); }
  }
  async function save(value) {
    let temporary;
    try {
      const secrets = onlySecrets(value); await prepare();
      const plaintext = Buffer.from(JSON.stringify(secrets), 'utf8');
      let data;
      try { data = platform === 'win32' ? (await encrypt(plaintext)).toString('base64') : secrets; }
      finally { plaintext.fill(0); }
      temporary = path.join(path.dirname(file), `.credentials-${randomUUID()}.tmp`);
      await writeFile(temporary, JSON.stringify({ version: 1, protection, data }) + '\n', { flag: 'wx', mode: 0o600 });
      await securePath(temporary, false);
      if (!sameSecrets(secrets, await readStored(temporary) || {})) throw credentialError();
      await rename(temporary, file); temporary = undefined;
      await securePath(file, false);
      const verified = await readStored();
      if (!verified || !sameSecrets(secrets, verified)) throw credentialError();
      return verified;
    } catch { throw credentialError(); }
    finally { if (temporary) await unlink(temporary).catch(() => {}); }
  }
  async function load({ environment = process.env } = {}) {
    try {
      await prepare();
      let stored = await readStored(), legacyBytes;
      try {
        const info = await lstat(legacyFile);
        if (!info.isFile() || info.isSymbolicLink() || info.size > 1024 * 1024) throw credentialError();
        legacyBytes = await readFile(legacyFile);
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
      if (legacyBytes) {
        const legacy = onlySecrets(JSON.parse(legacyBytes.toString('utf8').replace(/^\uFEFF/, '')));
        if (stored && secretNames.some(name => stored[name] && legacy[name] && stored[name] !== legacy[name])) throw credentialError('credential_conflict');
        const combined = { ...legacy, ...stored };
        stored = stored && sameSecrets(stored, combined) ? stored : await save(combined);
        // Verify the installed file and ensure nobody edited the legacy input
        // before removing plaintext. Failure always retains the original file.
        if (!sameSecrets(stored, await readStored() || {})) throw credentialError();
        try {
          if (!(await readFile(legacyFile)).equals(legacyBytes)) throw credentialError('credential_conflict');
          await unlink(legacyFile);
        } catch (error) { if (error.code !== 'ENOENT') throw error; }
        legacyBytes.fill(0);
      } else if (!stored) stored = await readStored(); // A concurrent migration may have just completed.
      return Object.fromEntries(secretNames.map(name => [name, environment[`KODO_${name}`] || environment[name] || stored?.[name] || '']));
    } catch (error) { throw credentialError(error.code === 'credential_conflict' ? error.code : undefined); }
  }
  return { file, legacyFile, load, save };
}
export async function loadSecrets() {
  return createCredentialStore().load();
}
export function redact(value, secrets = {}) {
  if (typeof value !== 'string') {
    if (Array.isArray(value)) return value.map(item => redact(item, secrets));
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [redact(key, secrets), redact(item, secrets)]));
    return value;
  }
  let text = value;
  for (const secret of Object.values(secrets)) if (typeof secret === 'string' && secret.length > 5) text = text.split(secret).join('[REDACTED]');
  text = text.replace(/AIza[\w-]{25,}/g, '[REDACTED]').replace(/(?:apikey_|get-x-api-|reddit-api-|sk-(?:proj-)?)[A-Za-z0-9_-]{16,}/g, '[REDACTED]');
  text = text.replace(/(Bearer\s+)[^\s"'<>]+/gi, '$1[REDACTED]').replace(/([?&](?:token|key|api_key)=)[^&\s"']+/gi, '$1[REDACTED]');
  return text;
}
export function workerEnvironment(base = process.env) {
  return Object.fromEntries(Object.entries(base).filter(([name]) => !/(?:API[_-]?KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|DATABASE_URL|SCRAPEDO|REDDIT_API|GETX|TYPESAFE|GEMINI|OPENROUTER|BASE_URL|USE_BEDROCK|USE_VERTEX|USE_FOUNDRY)/i.test(name) && !/^(?:KODO_|GH_|GITHUB_)/i.test(name) && !/^GIT_(?:DIR|WORK_TREE|INDEX_FILE|COMMON_DIR|OBJECT_DIRECTORY|NAMESPACE)$/i.test(name) && (!/^CODEX_/i.test(name) || name === 'CODEX_HOME')));
}
export function secretFile(name) { return /(?:^|\/)(?:\.env(?:\..*)?|auth\.json|secrets?(?:\..*)?|credentials?(?:\..*)?|[^/]*\.(?:pem|key|pfx))$/i.test(name); }
