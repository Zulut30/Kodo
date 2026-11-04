/** Managed optional tool port. Import/list/resolve perform no installation or
 * process launch. Install/doctor return arrays of {id, version, command, args,
 * ready, status, reason?}; status is ready, missing, unsupported or error.
 * Python browser commands are private interpreters: append the coordinator's
 * bridge path and its arguments. env contains only safe tool-specific overrides;
 * the caller must supply a credential-scrubbed environment. ready proves local
 * installation integrity, never browser/desktop access or a successful UI case.
 */
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { chmod, lstat, mkdir, mkdtemp, open, readFile, readdir, realpath, rename, rm, unlink, writeFile } from 'node:fs/promises';
import catalog from './tool-catalog.json' with { type: 'json' };
import { execute } from './command.mjs';
import { stateHome, workerEnvironment } from './security.mjs';
import { createVenvScript, downloadScript, extractNativeArchive, fileHash, inside, inventory, noLinks, npmEntrypoint, pythonEntrypoint, pythonProbeScript, relativeFile, sha256, supportsNodeEngine } from './toolchains.mjs';
import { formatRtkContext, isManagedRtkReady } from './rtk.mjs';

function freeze(value) {
  if (value && typeof value === 'object') { for (const item of Object.values(value)) freeze(item); Object.freeze(value); }
  return value;
}
export const toolCatalog = freeze(catalog);
const byId = new Map(toolCatalog.map(tool => [tool.id, tool]));
const SCHEMA = 1;
function toolFor(id) {
  const tool = byId.get(id);
  if (!tool) throw new Error('Unknown tool id');
  return tool;
}
function members(tool) { return tool.kind === 'python' ? toolCatalog.filter(t => t.kind === 'python' && t.group === tool.group) : [tool]; }
function groupKey(tool, platform, arch) {
  const pins = members(tool);
  return `${tool.kind === 'python' ? `python-${tool.group}` : tool.id}-${sha256(JSON.stringify({ schema: SCHEMA, platform, arch, pins })).slice(0, 24)}`;
}
function supported(tool, platform, arch) {
  return (!tool.engines || supportsNodeEngine(tool.engines.node)) && (tool.assets ? Boolean(tool.assets[`${platform}-${arch}`]) : tool.platforms.includes(`${platform}-${arch}`));
}
function result(tool, status, reason, extra = {}) {
  return { id: tool.id, version: tool.version, command: null, args: [], ready: status === 'ready', status, ...(reason ? { reason } : {}), ...extra };
}
async function exists(target) { try { await lstat(target); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; } }
async function canonical(target) {
  try { return await realpath(target); }
  catch (error) { if (error.code !== 'ENOENT') throw error; return path.join(await canonical(path.dirname(target)), path.basename(target)); }
}
async function readJSON(filename, maxBytes = 32 * 1024 ** 2) {
  await noLinks(filename);
  const info = await lstat(filename);
  if (!info.isFile() || info.size > maxBytes) throw new Error('Invalid installation metadata');
  return JSON.parse(await readFile(filename, 'utf8'));
}

/** A dedicated absolute home outside the project and every Git checkout.
 * Existing arbitrary directories are never adopted or cleaned up. */
async function locations({ home, project = process.cwd() } = {}) {
  const selected = home ?? process.env.KODO_TOOL_HOME ?? path.join(path.dirname(stateHome()), 'Kodo-Tools');
  if (typeof selected !== 'string' || !selected.trim() || !path.isAbsolute(selected)) throw new Error('Tool home must be an absolute dedicated directory');
  const root = path.resolve(selected), cwd = await canonical(path.resolve(project));
  await noLinks(root);
  const actual = await canonical(root), user = path.resolve(os.homedir());
  if (actual === path.parse(actual).root || actual === user || inside(cwd, actual) || inside(actual, cwd)) throw new Error('Unsafe tool home overlaps the project or user home');
  for (let current = actual; ; current = path.dirname(current)) {
    if (await exists(path.join(current, '.git'))) throw new Error('Tool home must be outside Git projects');
    if (current === path.dirname(current)) break;
  }
  if (await exists(root)) {
    if (!(await lstat(root)).isDirectory()) throw new Error('Unsafe tool home');
    const entries = await readdir(root);
    if (entries.length) {
      const marker = await readJSON(path.join(root, '.kodo-tools.json'), 1024).catch(() => null);
      if (marker?.schemaVersion !== SCHEMA || marker?.owner !== 'kodo-managed-tools') throw new Error('Unsafe tool home: not a dedicated Kodo installation directory');
    }
  }
  return { home: root, project: cwd };
}
async function initializeHome(home) {
  await noLinks(home); await mkdir(home, { recursive: true, mode: 0o700 });
  const marker = path.join(home, '.kodo-tools.json');
  try { await writeFile(marker, JSON.stringify({ schemaVersion: SCHEMA, owner: 'kodo-managed-tools' }), { flag: 'wx', mode: 0o600 }); }
  catch (error) { if (error.code !== 'EEXIST') throw error; }
}
function pythonPath(directory, platform) { return path.join(directory, 'venv', platform === 'win32' ? 'Scripts/python.exe' : 'bin/python'); }
function desktopName(platform, arch) { return `agent-desktop-${platform}-${arch}${platform === 'win32' ? '.exe' : ''}`; }
function desktopHelper(platform, arch) {
  return platform === 'darwin' ? `agent-desktop-macos-helper-${platform}-${arch}` : platform === 'linux' ? `agent-desktop-linux-clipboard-owner-${platform}-${arch}` : null;
}
function invocation(tool, directory, platform, arch) {
  if (tool.kind === 'python') return {
    command: pythonPath(directory, platform), args: tool.id === 'semgrep' ? ['-I', '-B', '-c', 'from semgrep.console_scripts.entrypoint import main; main()'] : ['-I', '-B', ...(tool.entryModule ? ['-m', pythonEntrypoint(tool.entryModule)] : [])],
    env: { PYTHONDONTWRITEBYTECODE: '1', PYTHONNOUSERSITE: '1', ANONYMIZED_TELEMETRY: 'false', SEMGREP_SEND_METRICS: 'off', SEMGREP_ENABLE_VERSION_CHECK: '0' }
  };
  if (tool.kind === 'native') return { command: path.join(directory, 'native', tool.assets[`${platform}-${arch}`].executable), args: [], env: tool.id === 'rtk' ? { RTK_RECALL: '0', RTK_TEE: '0', RTK_TELEMETRY_DISABLED: '1' } : {} };
  const root = path.join(directory, 'npm', 'node_modules', tool.id);
  if (tool.id === 'chrome-devtools-mcp') return { command: process.execPath, args: [path.join(root, tool.entry), '--no-usage-statistics', '--no-performance-crux'], env: { NO_UPDATE_CHECKS: '1', CHROME_DEVTOOLS_MCP_NO_UPDATE_CHECKS: '1' } };
  if (tool.id !== 'agent-desktop') return { command: process.execPath, args: [path.join(root, relativeFile(tool.entry))], env: { NO_UPDATE_CHECKS: '1' } };
  const helper = desktopHelper(platform, arch);
  return { command: path.join(root, 'bin', desktopName(platform, arch)), args: [], env: helper ? {
    [platform === 'darwin' ? 'AGENT_DESKTOP_MACOS_HELPER_PATH' : 'AGENT_DESKTOP_LINUX_CLIPBOARD_OWNER_PATH']: path.join(root, 'bin', helper)
  } : {} };
}
async function verifyNpm(tool, directory, platform, arch, installed = true) {
  const npm = path.join(directory, 'npm');
  const lock = await readJSON(path.join(npm, 'package-lock.json'));
  const entry = lock.packages?.[`node_modules/${tool.id}`];
  const url = `https://registry.npmjs.org/${tool.id}/-/${tool.id}-${tool.version}.tgz`;
  if (entry?.version !== tool.version || entry?.integrity !== tool.integrity || entry?.resolved !== url) throw new Error('Npm pinned integrity mismatch');
  if (!installed) return;
  const root = path.join(npm, 'node_modules', tool.id);
  const pkg = await readJSON(path.join(root, 'package.json'));
  if (pkg.name !== tool.id || pkg.version !== tool.version) throw new Error('Wrong npm package');
  if (tool.id === 'agent-desktop') {
    for (const name of [desktopName(platform, arch), desktopHelper(platform, arch)].filter(Boolean)) {
      const binary = path.join(root, 'bin', name);
      await noLinks(binary);
      const expected = (await readFile(binary + '.sha256', 'utf8')).trim();
      if (!/^[a-f0-9]{64}$/i.test(expected) || await fileHash(binary) !== expected.toLowerCase()) throw new Error('Desktop binary checksum mismatch');
    }
  } else npmEntrypoint(tool.id === 'chrome-devtools-mcp' ? { ...tool, binName: tool.id } : tool, pkg);
}
async function validateInstallation(tool, directory, platform, arch) {
  const call = invocation(tool, directory, platform, arch);
  // Node itself lives outside this install; validate the actual script too.
  const target = tool.kind === 'npm' && tool.id !== 'agent-desktop' ? call.args[0] : call.command;
  await noLinks(target);
  if (!(await lstat(target)).isFile()) throw new Error('Missing executable');
  if (tool.kind === 'native' && tool.licenseFile) {
    const license = path.join(directory, 'native', relativeFile(tool.licenseFile));
    await noLinks(license);
    if (!(await lstat(license)).isFile()) throw new Error('Missing native license');
  }
  if (tool.kind === 'npm') await verifyNpm(tool, directory, platform, arch);
  if (tool.kind === 'python') {
    const cfg = await readFile(path.join(directory, 'venv', 'pyvenv.cfg'), 'utf8');
    if (!/^include-system-site-packages\s*=\s*false\s*$/im.test(cfg)) throw new Error('Python environment is not isolated');
  }
  return call;
}
async function resolved(tool, home, platform, arch) {
  if (!supported(tool, platform, arch)) return result(tool, 'unsupported', 'No pinned package for this platform/architecture or Node runtime');
  const key = groupKey(tool, platform, arch), base = path.join(home, key), receiptPath = path.join(base, 'receipt.json');
  try {
    await noLinks(base);
    if (!await exists(receiptPath)) return result(tool, 'missing', 'Pinned managed installation is missing');
    const receipt = await readJSON(receiptPath);
    if (receipt.schemaVersion !== SCHEMA || receipt.key !== key || receipt.platform !== platform || receipt.arch !== arch || !/^[a-f0-9-]{36}$/.test(receipt.installation) || !Array.isArray(receipt.files) || !receipt.files.length) throw new Error('Invalid receipt');
    if (receipt.pins !== sha256(JSON.stringify(members(tool)))) throw new Error('Stale tool pins');
    const directory = path.join(base, receipt.installation);
    const files = await inventory(directory);
    if (JSON.stringify(files) !== JSON.stringify(receipt.files)) throw new Error('Stale file inventory');
    const call = await validateInstallation(tool, directory, platform, arch);
    if (!members(tool).every(pin => receipt.probes?.[pin.id] === pin.version)) throw new Error('Incomplete installation probes');
    return result(tool, 'ready', undefined, { ...call, directory, receipt: receiptPath });
  } catch { return result(tool, 'error', 'Installation receipt, checksum, files or pins are invalid; reinstall explicitly'); }
}

export async function resolveTool(id, { home, project, platform = process.platform, arch = process.arch } = {}) {
  const tool = toolFor(id), location = await locations({ home, project });
  return resolved(tool, location.home, platform, arch);
}

// Do not inherit arbitrary provider, npm/pip/uv, Python, proxy-auth or browser
// settings into package managers. Even metadata probes receive no provider keys.
function environment(directory, extra = {}) {
  const base = workerEnvironment(), env = {};
  for (const [key, value] of Object.entries(base)) if (/^(?:PATH|PATHEXT|SYSTEMROOT|WINDIR|COMSPEC|LANG|LC_ALL|NUMBER_OF_PROCESSORS|PROCESSOR_ARCHITECTURE)$/i.test(key)) env[key] = value;
  const privateHome = path.join(directory, 'work');
  return { ...env, HOME: privateHome, USERPROFILE: privateHome, APPDATA: privateHome, LOCALAPPDATA: privateHome, TMP: privateHome, TEMP: privateHome, TMPDIR: privateHome,
    XDG_CONFIG_HOME: privateHome, XDG_CACHE_HOME: privateHome, NPM_CONFIG_CACHE: path.join(privateHome, 'npm-cache'), NPM_CONFIG_USERCONFIG: path.join(privateHome, 'empty.npmrc'), NPM_CONFIG_GLOBALCONFIG: path.join(privateHome, 'global.npmrc'),
    UV_CACHE_DIR: path.join(privateHome, 'uv-cache'), UV_PYTHON_INSTALL_DIR: path.join(privateHome, 'python'), UV_NO_CONFIG: '1', UV_PYTHON_DOWNLOADS: 'never', UV_KEYRING_PROVIDER: 'disabled',
    PIP_CONFIG_FILE: process.platform === 'win32' ? 'NUL' : '/dev/null', PIP_DISABLE_PIP_VERSION_CHECK: '1', PYTHONNOUSERSITE: '1', PYTHONDONTWRITEBYTECODE: '1',
    GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: path.join(privateHome, 'empty.gitconfig'), GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never',
    GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'core.longpaths', GIT_CONFIG_VALUE_0: 'true',
    NO_UPDATE_CHECKS: '1', DO_NOT_TRACK: '1', ANONYMIZED_TELEMETRY: 'false', SEMGREP_SEND_METRICS: 'off', SEMGREP_ENABLE_VERSION_CHECK: '0', ...extra };
}
async function run(runner, command, args, directory, signal, extra = {}, timeoutMs = 300000) {
  signal?.throwIfAborted();
  try {
    const output = await runner(command, args, { cwd: directory, env: environment(directory, extra), signal, timeoutMs, allowFailure: true });
    signal?.throwIfAborted();
    if (output?.code !== 0 || typeof output.stdout !== 'string') throw new Error('Failed tool process');
    return output.stdout;
  } catch (error) {
    signal?.throwIfAborted();
    // Never propagate arbitrary subprocess stdout/stderr (paths, secrets, source).
    throw new Error(error.code === 'ENOENT' ? 'Required installation executable is missing' : 'Tool process failed or timed out');
  }
}
async function workingDirectory(directory) {
  await mkdir(path.join(directory, 'work'), { recursive: true, mode: 0o700 });
  for (const name of ['empty.npmrc', 'global.npmrc', 'empty.gitconfig']) await writeFile(path.join(directory, 'work', name), '', { mode: 0o600 });
}
function pythonPins(tool) { return members(tool).map(t => ({ id: t.id, version: t.version, module: t.module, revision: t.revision, git: t.spec.includes('git+'), ...(t.entryModule ? { entryModule: pythonEntrypoint(t.entryModule) } : {}) })); }
async function probe(tool, directory, platform, arch, runner, signal, cwd = directory) {
  const call = invocation(tool, directory, platform, arch);
  if (tool.kind === 'python') {
    const output = await run(runner, call.command, ['-I', '-B', '-c', pythonProbeScript, JSON.stringify(pythonPins(tool))], cwd, signal, call.env, 30000);
    let parsed; try { parsed = JSON.parse(output); } catch { throw new Error('Invalid Python metadata result'); }
    if (parsed.python !== '3.12' || parsed.assets !== true || !members(tool).every(t => parsed.versions?.[t.id] === t.version && (!t.spec.includes('git+') || parsed.revisions?.[t.id] === t.revision))) throw new Error('Python metadata mismatch');
    if (tool.id !== 'semgrep' && !tool.entryModule) return;
  }
  const flag = tool.id === 'gitleaks' ? 'version' : '--version';
  const probeEnv = tool.id === 'rtk' ? { ...call.env, RTK_DB_PATH: path.join(cwd, 'work', 'tracking.db') } : call.env;
  const output = await run(runner, call.command, [...call.args, flag], cwd, signal, probeEnv, 30000);
  // Native desktop protocol version 2.5 is distinct from package version 1.0.2.
  // Probe only the CLI version command; never snapshot/list applications.
  const text = output.trim(), escaped = tool.version.replaceAll('.', '\\.');
  const pattern = tool.id === 'ripgrep' ? new RegExp(`^ripgrep ${escaped}(?: \\(rev [a-f0-9]+\\))?$`)
    : tool.id === 'agent-desktop' ? new RegExp(`^agent-desktop ${escaped}$`)
      : tool.id === 'gitleaks' ? new RegExp(`^(?:gitleaks(?: version)? )?${escaped}$`)
        : tool.id === 'rtk' ? new RegExp(`^rtk ${escaped}$`) : tool.versionPrefixes ? new RegExp(`^(?:${tool.versionPrefixes.map(prefix => prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})${escaped}$`) : new RegExp(`^${escaped}$`);
  if (output.length > 4096 || !pattern.test(tool.id === 'ripgrep' ? text.split(/\r?\n/)[0] : text)) throw new Error('Tool version mismatch');
}
async function installNpm(tool, directory, platform, arch, runner, signal) {
  const npm = path.join(directory, 'npm'); await mkdir(npm, { mode: 0o700 });
  await writeFile(path.join(npm, 'package.json'), JSON.stringify({ name: 'kodo-private-tool', version: '1.0.0', private: true, dependencies: { [tool.id]: tool.version } }), { mode: 0o600 });
  // A lock-only resolution cannot execute upstream scripts. Check its root
  // integrity against the research pin before npm ci downloads/extracts it.
  await workingDirectory(npm);
  const flags = ['--ignore-scripts', '--no-audit', '--no-fund', '--no-bin-links', '--registry=https://registry.npmjs.org/', ...(tool.engines ? ['--engine-strict'] : [])];
  await run(runner, 'npm', ['install', '--package-lock-only', ...flags], npm, signal);
  await verifyNpm(tool, directory, platform, arch, false);
  await run(runner, 'npm', ['ci', ...flags], npm, signal);
  await verifyNpm(tool, directory, platform, arch);
  if (tool.id === 'agent-desktop') for (const name of [desktopName(platform, arch), desktopHelper(platform, arch)].filter(Boolean)) await chmod(path.join(npm, 'node_modules', tool.id, 'bin', name), 0o700);
}
async function installPython(tool, directory, platform, runner, signal) {
  // uv is an explicit prerequisite; never bootstrap it, upgrade user Python, or
  // download a runtime implicitly. Existing Python 3.12 is copied into a venv.
  const existingPythonHome = process.env.UV_PYTHON_INSTALL_DIR || (platform === 'win32'
    ? path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'uv', 'python')
    : path.join(process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share'), 'uv', 'python'));
  // Discovery may read the user's existing runtime location; downloads and all
  // cache writes stay disabled/private. Installing packages never uses it.
  const found = (await run(runner, 'uv', ['python', 'find', '--no-project', '--no-config', '--no-python-downloads', '3.12'], directory, signal, { UV_PYTHON_INSTALL_DIR: existingPythonHome }, 30000)).trim();
  if (!path.isAbsolute(found) || /[\r\n\0]/.test(found)) throw new Error('Python 3.12 interpreter unavailable');
  await run(runner, found, ['-I', '-B', '-c', createVenvScript, path.join(directory, 'venv')], directory, signal);
  const pins = members(tool);
  let requirements = pins.map(t => t.spec);
  if (pins.some(t => t.files)) {
    // uv verifies supplied hashes while resolving transitive dependencies.
    // Pin the primary artifacts before package code can be imported/probed.
    const lines = pins.map(t => {
      if (t.spec !== `${t.id}==${t.version}` || !Array.isArray(t.files) || !t.files.length || t.files.some(f => !/^[a-f0-9]{64}$/.test(f.sha256))) throw new Error('Invalid Python artifact pins');
      return `${t.spec} ${t.files.map(f => `--hash=sha256:${f.sha256}`).join(' ')}`;
    });
    const filename = path.join(directory, 'requirements.txt');
    await writeFile(filename, lines.join('\n') + '\n', { flag: 'wx', mode: 0o600 });
    requirements = ['--requirement', filename];
  }
  await run(runner, 'uv', ['pip', 'install', '--no-config', '--no-python-downloads', '--keyring-provider', 'disabled', '--link-mode', 'copy', '--python', pythonPath(directory, platform), '--default-index', 'https://pypi.org/simple', ...requirements], directory, signal, {}, 900000);
}
async function installNative(tool, directory, platform, arch, runner, signal) {
  const asset = tool.assets[`${platform}-${arch}`], archive = path.join(directory, 'download');
  await run(runner, process.execPath, ['--input-type=module', '-e', downloadScript, asset.url, archive], directory, signal, {}, 150000);
  await extractNativeArchive({ archive, destination: path.join(directory, 'native'), format: asset.format, sha256: asset.sha256 });
  await chmod(path.join(directory, 'native', relativeFile(asset.executable)), 0o700);
  // Retain verified archive bytes in the inventory as provenance, never run them.
}
/** Install only explicit approved IDs (or 'all'). Failure is a safe per-tool
 * report; invalid ids/homes and cancellation throw before any installation.
 * Reuse checks exact pins and every installed file. Failed/stale installs are
 * retained; a new private attempt replaces only the atomic receipt pointer.
 */
export async function installTools(ids, { home, project, signal, runner = execute } = {}) {
  const selected = ids === 'all' || (Array.isArray(ids) && ids.length === 1 && ids[0] === 'all') ? toolCatalog.map(t => t.id) : typeof ids === 'string' ? [ids] : ids;
  if (!Array.isArray(selected) || !selected.length) throw new Error('Tool ids must be a nonempty list');
  const requested = [...new Set(selected)].map(toolFor);
  const location = await locations({ home, project }); signal?.throwIfAborted();
  await initializeHome(location.home);
  const results = [], platform = process.platform, arch = process.arch, attempted = new Map();
  for (const tool of requested) {
    signal?.throwIfAborted();
    const initial = await resolved(tool, location.home, platform, arch);
    if (initial.ready || initial.status === 'unsupported') { results.push(initial); continue; }
    const key = groupKey(tool, platform, arch);
    if (attempted.has(key)) { results.push(result(tool, 'error', attempted.get(key))); continue; }
    const base = path.join(location.home, key); let lock;
    try {
      await noLinks(base); await mkdir(base, { recursive: true, mode: 0o700 });
      lock = await open(path.join(base, 'install.lock'), 'wx', 0o600);
      const current = await resolved(tool, location.home, platform, arch);
      if (current.ready) { results.push(current); continue; }
      const installation = randomUUID(), directory = path.join(base, installation);
      await mkdir(directory, { mode: 0o700 }); await workingDirectory(directory);
      if (tool.kind === 'npm') await installNpm(tool, directory, platform, arch, runner, signal);
      else if (tool.kind === 'python') await installPython(tool, directory, platform, runner, signal);
      else await installNative(tool, directory, platform, arch, runner, signal);
      for (const member of members(tool)) await validateInstallation(member, directory, platform, arch);
      await probe(tool, directory, platform, arch, runner, signal);
      // No deletion of user/global data: move only the fresh attempt's caches.
      // Python venv path stays fixed (console-script shebangs are not relocatable).
      for (const relative of ['work', ...(tool.kind === 'npm' ? ['npm/work'] : [])]) {
        const source = path.join(directory, relative);
        await noLinks(source);
        if (await exists(source)) await rename(source, path.join(base, `${installation}-${relative.replace('/', '-')}-cache`));
      }
      const receipt = { schemaVersion: SCHEMA, key, installation, platform, arch, pins: sha256(JSON.stringify(members(tool))), probes: Object.fromEntries(members(tool).map(t => [t.id, t.version])), files: await inventory(directory) };
      const temporary = path.join(base, `receipt-${installation}.tmp`);
      await writeFile(temporary, JSON.stringify(receipt), { flag: 'wx', mode: 0o600 });
      signal?.throwIfAborted(); await noLinks(path.join(base, 'receipt.json')); await rename(temporary, path.join(base, 'receipt.json'));
      results.push(await resolved(tool, location.home, platform, arch));
    } catch (error) {
      signal?.throwIfAborted();
      const reason = error.code === 'EEXIST' ? 'Another installation holds the lock; no tools changed' : 'Installation failed integrity, prerequisites or probe checks; no ready receipt written';
      attempted.set(key, reason); results.push(result(tool, 'error', reason));
    } finally {
      if (lock) { await lock.close(); await unlink(path.join(base, 'install.lock')); }
    }
  }
  return results;
}

/** Probe versions/metadata only, even with live=true. Real UI acceptance belongs
 * to the coordinator's owned fixtures. No install, browser attachment or API. */
export async function doctorTools({ home, project, signal, runner = execute, live = false } = {}) {
  const location = await locations({ home, project }), reports = [];
  for (const tool of toolCatalog) {
    signal?.throwIfAborted();
    const status = await resolved(tool, location.home, process.platform, process.arch);
    if (!status.ready) { reports.push(status); continue; }
    let scratch;
    try {
      scratch = await mkdtemp(path.join(path.dirname(status.directory), 'probe-'));
      await workingDirectory(scratch);
      await probe(tool, status.directory, process.platform, process.arch, runner, signal, scratch);
      reports.push({ ...status, probe: 'version-and-metadata', live: Boolean(live) });
    } catch {
      signal?.throwIfAborted(); reports.push(result(tool, 'error', 'Local version/metadata probe failed; no UI or API verification performed'));
    } finally {
      if (scratch) {
        // Only this invocation's newly created sibling scratch, never an
        // installation, existing user cache or computed external directory.
        if (!inside(location.home, scratch) || path.dirname(scratch) !== path.dirname(status.directory) || !path.basename(scratch).startsWith('probe-')) throw new Error('Unsafe probe cleanup path');
        await noLinks(scratch); await rm(scratch, { recursive: true, force: true });
      }
    }
  }
  return reports;
}

/** Only allowlisted static capabilities/status enter worker prompts. Never
 * serialize supplied config, paths, URLs, arguments, reasons or credentials. */
export function formatToolContext({ stage, uiVerification, security, tools = [] } = {}) {
  const role = ['analyze', 'plan', 'developer', 'tester', 'documenter', 'review', 'repair', 'complete'].includes(stage) ? stage : 'worker';
  const guidance = {
    analyze: 'Identify owned UI surfaces and local scanner prerequisites; CLI-only work needs explicit disabled/not-applicable evidence.',
    plan: 'Plan bounded cases with independent observed-state assertions and dependencies on the coordinator gates.',
    developer: 'Implement within assigned files; use scoped search and targeted regressions. Leave live UI agents and provider credentials to the coordinator.',
    tester: 'Check public requirements and failed/malformed/stale evidence. Request owned fixture acceptance through the coordinator.',
    documenter: 'Document exact pins, prerequisites and limitations. Distinguish local tests, actual native/UI checks, published artifacts and deployment.',
    review: 'Require enabled gate receipts for the exact checked Git head, configuration and tool pins; reject incomplete or stale evidence.',
    repair: 'Repair only actionable safe findings in the assigned scope. Changed files invalidate earlier UI/security receipts.',
    complete: 'Report the evidence level actually observed; a successful install or doctor is not UI acceptance, publication or deployment.'
  };
  const lines = [`Kodo optional tools (${role}). Availability is local installation evidence, not a successful UI/security check.`,
    guidance[role] || 'Follow the assigned scope and coordinator-owned verification boundaries.',
    'Default scoped code search: rg --files <explicit-directory>; rg -n --glob <pattern> -- <query> <explicit-directory>. Bound paths and output; do not scan credentials or entire user homes.',
    'The coordinator owns installation, browser/desktop processes and UI/security gates. Workers receive no provider keys. GPT/Claude remain subscription-only; no API or Browser Use Cloud fallback.',
    `UI verification: ${uiVerification?.enabled === true ? 'configured; independent observed assertions required before review/delivery' : 'disabled; report disabled/not-applicable explicitly'}.`,
    `Security gates: ${security?.enabled === true ? 'configured; local rules and redacted findings must pass before review/delivery' : 'disabled'}.`];
  for (const tool of toolCatalog) {
    const states = Array.isArray(tools) ? tools.filter(item => item?.id === tool.id) : [];
    const available = states.length === 1 && states[0].ready === true && states[0].version === tool.version
      && (tool.id !== 'rtk' || isManagedRtkReady(states[0]));
    lines.push(`${tool.id}@${tool.version}: ${available ? 'available' : 'unavailable'}. ${tool.capability}.`);
    if (tool.id === 'rtk' && available) lines.push(formatRtkContext(states[0]));
  }
  lines.push('Desktop is scoped to the configured owned app/window; never auto-record private content. Browser profiles/endpoints must be owned and isolated. A missing, unsupported, malformed or failed check blocks enabled gates.');
  return lines.join('\n').slice(0, 8000);
}
