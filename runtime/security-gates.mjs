/** Coordinator-owned, local security gates. Raw scanner JSON exists only in
 * memory: receipts and private evidence contain allowlisted locations/counters.
 * A previous receipt never bypasses a scan. Delivery/resume can synchronously
 * validate a completed receipt and its evidence for the exact head/config/pins.
 */
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, realpathSync, readFileSync } from 'node:fs';
import { lstat, mkdir, mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { execute } from './command.mjs';
import { resolveTool, installTools, toolCatalog } from './tools.mjs';
import { workerEnvironment, redact } from './security.mjs';

const ids = ['semgrep', 'gitleaks'];
const builtinRules = fileURLToPath(new URL('./security-rules.yml', import.meta.url));
const timeoutMs = 180000, maxOutput = 8 * 1024 ** 2, maxEvidence = 2 * 1024 ** 2;
const hash = value => createHash('sha256').update(value).digest('hex');
const headOK = value => typeof value === 'string' && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value);
const pinsHash = () => hash(JSON.stringify(toolCatalog.filter(t => ids.includes(t.id))));
const fail = code => Object.assign(new Error(code), { code });
const reasons = new Set(['cancelled', 'timeout', 'invalid_artifacts', 'invalid_head', 'changed_head', 'dirty_worktree', 'invalid_source', 'empty_source', 'scope_limit', 'invalid_rules', 'history_limit', 'invalid_history', 'tool_missing', 'tool_version', 'execution_error', 'malformed_output', 'incomplete_scan', 'unsafe_metadata', 'cleanup_failed', 'temporary_directory']);
const safeReason = error => reasons.has(error?.code) ? error.code : 'execution_error';
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
function keys(value, allowed) { if (!object(value) || Object.keys(value).some(k => !allowed.includes(k))) throw fail('invalid_security_config'); }
function relative(name) {
  if (typeof name !== 'string' || !name || name.length > 2048 || /[\\:\x00-\x1f\x7f]/.test(name) || name.startsWith('/') || name.split('/').some(p => !p || p === '.' || p === '..' || /[. ]$/.test(p) || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(p))) throw fail('invalid_source');
  return name;
}
export function normalizeSecurityConfig(value = undefined) {
  if (value === undefined) value = {};
  keys(value, ['enabled', 'autoInstall', 'tools', 'semgrepConfig', 'history']);
  for (const key of ['enabled', 'autoInstall']) if (value[key] !== undefined && typeof value[key] !== 'boolean') throw fail('invalid_security_config');
  const selected = value.tools ?? ids;
  if (!Array.isArray(selected) || !selected.length || selected.length > 2 || new Set(selected).size !== selected.length || selected.some(id => !ids.includes(id))) throw fail('invalid_security_config');
  const config = { enabled: value.enabled ?? false, autoInstall: value.autoInstall ?? true, tools: ids.filter(id => selected.includes(id)) };
  if (value.semgrepConfig !== undefined) {
    try { relative(value.semgrepConfig); } catch { throw fail('invalid_security_config'); }
    if (!/\.ya?ml$/i.test(value.semgrepConfig)) throw fail('invalid_security_config');
    config.semgrepConfig = value.semgrepConfig;
  }
  // History is opt-in and must name an immutable, bounded range ending at the
  // checked head. Never silently scan all unrelated old commits or truncate it.
  if (value.history !== undefined) {
    keys(value.history, ['baseSha', 'maxCommits']);
    const maxCommits = value.history.maxCommits ?? 50;
    if (!config.tools.includes('gitleaks') || !headOK(value.history.baseSha) || !Number.isInteger(maxCommits) || maxCommits < 1 || maxCommits > 100) throw fail('invalid_security_config');
    config.history = { baseSha: value.history.baseSha, maxCommits };
  }
  return config;
}
export const securityConfigHash = config => hash(JSON.stringify(normalizeSecurityConfig(config)));
function inside(root, file) { const rel = path.relative(root, file); return !rel || (rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel)); }
function noLinks(file) {
  for (let current = path.resolve(file); ; current = path.dirname(current)) {
    try { if (lstatSync(current).isSymbolicLink()) throw fail('invalid_artifacts'); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    if (current === path.dirname(current)) break;
  }
}
function canonical(file) { return existsSync(file) ? realpathSync(file) : path.join(canonical(path.dirname(file)), path.basename(file)); }
function outsideGit(file, cwd) {
  if (typeof file !== 'string' || !path.isAbsolute(file)) throw fail('invalid_artifacts');
  noLinks(file); const actual = canonical(file);
  if (cwd && inside(canonical(cwd), actual)) throw fail('invalid_artifacts');
  for (let current = actual; ; current = path.dirname(current)) {
    if (existsSync(path.join(current, '.git'))) throw fail('invalid_artifacts');
    if (current === path.dirname(current)) break;
  }
}
function excluded(name) {
  return /(?:^|\/)(?:\.git|node_modules|\.venv|venv|__pycache__|\.next|coverage)(?:\/|$)/.test(name)
    || /^skills\/[^/]+\/references\/upstream\//.test(name);
}
const supportedSource = name => /\.(?:[cm]?jsx?|[cm]?tsx?|py|pyi)$/.test(name);
function rules(config, cwd) {
  if (!config.tools.includes('semgrep')) return { bytes: Buffer.alloc(0), sha256: hash('') };
  const file = config.semgrepConfig ? path.join(cwd, config.semgrepConfig) : builtinRules;
  try {
    noLinks(file); const info = lstatSync(file);
    if (!info.isFile() || info.size < 1 || info.size > 1024 ** 2 || (config.semgrepConfig && !inside(canonical(cwd), canonical(file)))) throw fail('invalid_rules');
    const bytes = readFileSync(file), text = bytes.toString('utf8');
    // Local rule files only. Secret validators and SCA are not an offline OSS
    // gate; their inclusion must not silently introduce network requests.
    const keysText = text.replaceAll('"', '').replaceAll("'", '');
    if (!/^rules\s*:/m.test(text) || /\b(?:validators?|extends|include|configs|r2c-internal-project-depends-on)\s*:/m.test(keysText) || /\bproduct\s*:\s*(?:secrets|supply-chain)/m.test(keysText)) throw fail('invalid_rules');
    return { bytes, sha256: hash(bytes) };
  } catch { throw fail('invalid_rules'); }
}
function environment(home, temp = home, extra = {}) {
  const base = workerEnvironment(), env = {};
  for (const [key, value] of Object.entries(base)) if (/^(?:PATH|PATHEXT|SYSTEMROOT|WINDIR|COMSPEC|LANG|LC_ALL|NUMBER_OF_PROCESSORS|PROCESSOR_ARCHITECTURE)$/i.test(key)) env[key] = value;
  return { ...env, ...extra, HOME: home, USERPROFILE: home, APPDATA: home, LOCALAPPDATA: home,
    XDG_CONFIG_HOME: home, XDG_CACHE_HOME: home, TEMP: temp, TMP: temp, TMPDIR: temp,
    SEMGREP_SETTINGS_FILE: path.join(home, 'settings.yml'), SEMGREP_LOG_FILE: path.join(home, 'semgrep.log'),
    SEMGREP_SEND_METRICS: 'off', SEMGREP_ENABLE_VERSION_CHECK: '0', SEMGREP_APP_TOKEN: '',
    NO_UPDATE_CHECKS: '1', DO_NOT_TRACK: '1', ANONYMIZED_TELEMETRY: 'false',
    PYTHONNOUSERSITE: '1', PYTHONDONTWRITEBYTECODE: '1', GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: path.join(home, 'empty.gitconfig'), GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never',
    // Also constrain Git children launched by Gitleaks, which do not pass
    // through Kodo's execute()/gitBoundary() wrapper.
    GIT_CONFIG_COUNT: '3', GIT_CONFIG_KEY_0: 'core.hooksPath', GIT_CONFIG_VALUE_0: process.platform === 'win32' ? 'NUL' : '/dev/null',
    GIT_CONFIG_KEY_1: 'core.fsmonitor', GIT_CONFIG_VALUE_1: 'false', GIT_CONFIG_KEY_2: 'credential.helper', GIT_CONFIG_VALUE_2: '' };
}
async function call(runner, command, args, options) {
  if (options.signal?.aborted) throw fail('cancelled');
  let result;
  try { result = await runner(command, args, { ...options, timeoutMs, rawOutput: true, allowFailure: true }); }
  catch (error) { throw fail(options.signal?.aborted ? 'cancelled' : error.code === 'timeout' ? 'timeout' : 'execution_error'); }
  if (options.signal?.aborted) throw fail('cancelled');
  if (!Number.isInteger(result?.code) || typeof result.stdout !== 'string' || typeof result.stderr !== 'string' || result.stdout.length > maxOutput || result.stderr.length > maxOutput) throw fail('malformed_output');
  return result;
}
async function git(runner, args, cwd, env, signal) {
  const result = await call(runner, 'git', args, { cwd, env, signal });
  if (result.code !== 0) throw fail('invalid_source');
  return result.stdout;
}
async function checkedHead(runner, cwd, headSha, env, signal) {
  if ((await git(runner, ['rev-parse', '--verify', 'HEAD'], cwd, env, signal)).trim() !== headSha) throw fail('changed_head');
  if (await git(runner, ['status', '--porcelain=v1', '-z', '--untracked-files=normal'], cwd, env, signal)) throw fail('dirty_worktree');
}
async function snapshot(runner, cwd, target, headSha, env, signal, secrets) {
  const entries = (await git(runner, ['ls-tree', '-r', '--full-tree', '-z', headSha], cwd, env, signal)).split('\0').filter(Boolean);
  if (!entries.length || entries.length > 50000) throw fail('empty_source');
  const manifest = []; let total = 0;
  for (const entry of entries.sort()) {
    const match = /^(\d+) (\w+) ([a-f0-9]+)\t([^]*)$/.exec(entry);
    if (!match) throw fail('invalid_source');
    const [, mode, kind, blobId, name] = match;
    relative(name); if (excluded(name)) continue;
    if (kind !== 'blob' || !['100644', '100755'].includes(mode) || safeText(name, secrets) !== name) throw fail('invalid_source');
    const file = path.join(cwd, name); noLinks(file);
    const info = await lstat(file);
    if (!info.isFile()) throw fail('invalid_source');
    total += info.size;
    if (info.size > 16 * 1024 ** 2 || total > 128 * 1024 ** 2) throw fail('scope_limit');
    const bytes = await readFile(file);
    const gitHash = data => createHash(headSha.length === 40 ? 'sha1' : 'sha256').update(`blob ${data.length}\0`).update(data).digest('hex');
    // git status can hide assume-unchanged/skip-worktree edits. Verify each
    // scanned byte against the committed blob, allowing normal CRLF checkout
    // conversion without invoking project-defined Git clean/smudge filters.
    if (gitHash(bytes) !== blobId) {
      const text = bytes.toString('utf8');
      if (!Buffer.from(text).equals(bytes) || gitHash(Buffer.from(text.replaceAll('\r\n', '\n'))) !== blobId) throw fail('dirty_worktree');
    }
    if (target) {
      const dest = path.join(target, name); await mkdir(path.dirname(dest), { recursive: true, mode: 0o700 });
      await writeFile(dest, bytes, { flag: 'wx', mode: 0o600 });
    }
    manifest.push({ file: name, sha256: hash(bytes) });
  }
  if (!manifest.length) throw fail('empty_source');
  return { files: manifest.map(f => f.file), manifest, hash: hash(JSON.stringify(manifest)) };
}
// Always delete only directories created by this invocation, after checking
// their fixed parent/prefix. Never delete the caller's artifact or tool home.
async function removeOwned(directory, parent, prefix) {
  if (path.dirname(directory) !== parent || !path.basename(directory).startsWith(prefix)) throw fail('cleanup_failed');
  noLinks(directory); await rm(directory, { recursive: true, force: true });
}
const shortPathScript = `$ErrorActionPreference='Stop'; try { $p=[Console]::In.ReadToEnd(); [Console]::Out.Write((New-Object -ComObject Scripting.FileSystemObject).GetFolder($p).ShortPath) } catch { exit 1 }`;
async function shortTemp(runner, env, signal) {
  const candidates = process.platform === 'win32'
    ? [...new Set([os.tmpdir(), path.join(os.homedir(), 'AppData', 'Local', 'Temp'), path.join(process.env.SystemRoot || 'C:\\Windows', 'Temp')])]
    : [os.tmpdir()];
  for (const parent of candidates) {
    let directory;
    try {
      noLinks(parent); directory = await mkdtemp(path.join(parent, 'ks-'));
      let alias = directory;
      if (process.platform === 'win32' && alias.length > 70) {
        const executable = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
        const result = await call(runner, executable, ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(shortPathScript, 'utf16le').toString('base64')], { cwd: directory, env, signal, input: directory });
        alias = result.stdout.trim();
        if (result.code !== 0 || !path.isAbsolute(alias) || /[\x00-\x1f]/.test(alias) || canonical(alias) !== canonical(directory)) throw fail('temporary_directory');
      }
      if (process.platform === 'win32' && alias.length > 70) throw fail('temporary_directory');
      return { directory, parent, alias };
    } catch (error) {
      if (directory) await removeOwned(directory, parent, 'ks-');
      if (signal?.aborted) throw fail('cancelled');
    }
  }
  throw fail('temporary_directory');
}
function safeText(value, secrets) {
  let text = redact(value, secrets);
  for (const secret of Object.values(secrets)) if (typeof secret === 'string' && secret) text = text.split(secret).join('[REDACTED]');
  return text;
}
function location(file, root, allowed, history = false) {
  if (typeof file !== 'string' || file.length > 4096) throw fail('unsafe_metadata');
  const portable = file.replaceAll('\\', '/');
  const name = path.isAbsolute(file) ? path.relative(root, file).replaceAll('\\', '/') : portable.replace(/^\.\//, '');
  relative(name);
  if (excluded(name) || (!history && !allowed.includes(name))) throw fail('unsafe_metadata');
  return name;
}
function finding(ruleId, file, line, severity, secrets) {
  if (typeof ruleId !== 'string' || !/^[a-zA-Z0-9_.-]{1,256}$/.test(ruleId) || !Number.isSafeInteger(line) || line < 1 || line > 10000000 || !['ERROR', 'WARNING', 'INFO', 'INVENTORY', 'EXPERIMENT', 'LOW', 'MEDIUM', 'HIGH', 'CRITICAL'].includes(severity)) throw fail('unsafe_metadata');
  return { ruleId: safeText(ruleId, secrets), file: safeText(file, secrets), line, severity };
}
function parsedJSON(result) { try { return JSON.parse(result.stdout); } catch { throw fail('malformed_output'); } }
function semgrepResult(result, root, source, secrets, custom) {
  const data = parsedJSON(result);
  if (!object(data) || data.version !== '1.183.0' || !Array.isArray(data.results) || !Array.isArray(data.errors) || !Array.isArray(data.paths?.scanned) || data.results.length > 10000) throw fail('malformed_output');
  if (data.errors.length) throw fail('incomplete_scan');
  if (![0, 1].includes(result.code)) throw fail('execution_error');
  const scanned = data.paths.scanned.map(p => location(p, root, source.files));
  const expected = source.files.filter(supportedSource);
  if (!scanned.length || new Set(scanned).size !== scanned.length || (!custom && expected.some(p => !scanned.includes(p)))) throw fail('incomplete_scan');
  const findings = data.results.map(r => finding(r?.check_id, location(r?.path, root, source.files), r?.start?.line, r?.extra?.severity, secrets));
  if ((result.code === 0) !== (findings.length === 0)) throw fail('malformed_output');
  return { status: findings.length ? 'failed' : 'passed', findings, scannedFiles: scanned.length };
}
function gitleaksResult(result, root, source, secrets, history = false) {
  // This JSON format has no errors/coverage member. At log-level=error any
  // diagnostic (including a skipped unreadable file) makes the scan incomplete.
  if (result.stderr.trim()) throw fail('incomplete_scan');
  if (![0, 42].includes(result.code)) throw fail('execution_error');
  const data = parsedJSON(result);
  if (!Array.isArray(data) || data.length > 10000) throw fail('malformed_output');
  const findings = data.map(r => finding(r?.RuleID, location(r?.File, root, source.files, history), r?.StartLine, 'ERROR', secrets));
  if ((result.code === 0) !== (findings.length === 0)) throw fail('malformed_output');
  // Gitleaks JSON provides findings, not an observed file-coverage counter.
  // Record the exact supplied scope separately instead of inventing a count.
  return { status: findings.length ? 'failed' : 'passed', findings, scannedFiles: null, scopeFiles: source.files.length };
}
const gitleaksRules = `title = "Kodo local default secret rules"\n[extend]\nuseDefault = true\n[[allowlists]]\ndescription = "Generated dependencies and pinned upstream reference data"\npaths = ['''(^|/)(\\.git|node_modules|\\.venv|venv|__pycache__|\\.next|coverage)(/|$)''', '''^skills/[^/]+/references/upstream/''']\n`;
async function runScanner({ tool, config, source, target, scratch, cwd, headSha, runner, signal, secrets, env }) {
  const common = { cwd: target, env: { ...env, ...tool.env }, signal };
  if (tool.id === 'semgrep') {
    const temp = await shortTemp(runner, env, signal);
    try {
      common.env = environment(path.join(scratch, 'home'), temp.alias, tool.env);
      const result = await call(runner, tool.command, [...tool.args, 'scan', '--config', path.join(scratch, 'rules.yml'), '--json', '--error', '--strict', '--quiet', '--metrics=off', '--disable-version-check', '--oss-only', '--no-git-ignore', '--x-ignore-semgrepignore-files', '--disable-nosem', '--no-rewrite-rule-ids', '--no-exclude-minified-files', '--max-target-bytes=0', '--timeout=30', '.'], common);
      return semgrepResult(result, target, source, secrets, Boolean(config.semgrepConfig));
    } finally { await removeOwned(temp.directory, temp.parent, 'ks-'); }
  }
  const flags = ['--config', path.join(scratch, 'gitleaks.toml'), '--redact=100', '--no-banner', '--no-color', '--log-level=error', '--report-format=json', '--report-path=-', '--exit-code=42', '--ignore-gitleaks-allow', '--gitleaks-ignore-path', path.join(scratch, 'empty.ignore'), '--max-decode-depth=5', '--timeout=150'];
  const current = gitleaksResult(await call(runner, tool.command, [...tool.args, 'dir', ...flags, '.'], common), target, source, secrets);
  if (!config.history) return current;
  const base = config.history.baseSha;
  await git(runner, ['merge-base', '--is-ancestor', base, headSha], cwd, env, signal).catch(() => { throw fail('invalid_history'); });
  const count = Number((await git(runner, ['rev-list', '--count', `${base}..${headSha}`], cwd, env, signal)).trim());
  if (!Number.isSafeInteger(count) || count < 1 || count > config.history.maxCommits) throw fail('history_limit');
  const historical = gitleaksResult(await call(runner, tool.command, [...tool.args, 'git', ...flags, `--log-opts=${base}..${headSha} --max-count=${config.history.maxCommits} --no-ext-diff --no-textconv`, '.'], { ...common, cwd }), cwd, source, secrets, true);
  const findings = [...current.findings, ...historical.findings];
  return { ...current, status: findings.length ? 'failed' : 'passed', findings, historyCommits: count };
}

export async function runSecurityChecks({ cwd = process.cwd(), headSha, config, artifacts, previous: _previous, secrets = {}, signal, runner = execute, toolHome } = {}) {
  config = normalizeSecurityConfig(config);
  if (!headOK(headSha)) throw fail('invalid_head');
  const receipt = { schemaVersion: 1, headSha, configHash: securityConfigHash(config), pinsHash: pinsHash(), status: config.enabled ? 'blocked' : 'disabled', passed: config.enabled ? false : null, tools: [] };
  if (!config.enabled) return receipt;
  let scratch, directory, source, ruleData;
  try {
    if (signal?.aborted) throw fail('cancelled');
    cwd = path.resolve(cwd); noLinks(cwd); outsideGit(artifacts, cwd);
    await mkdir(artifacts, { recursive: true, mode: 0o700 });
    directory = await mkdtemp(path.join(artifacts, 'security-')); receipt.evidenceRoot = directory; receipt.cwd = cwd;
    scratch = await mkdtemp(path.join(directory, 'scratch-'));
    const target = path.join(scratch, 'source'), home = path.join(scratch, 'home');
    await mkdir(target); await mkdir(home);
    const env = environment(home);
    await checkedHead(runner, cwd, headSha, env, signal);
    ruleData = rules(config, cwd); receipt.rulesHash = ruleData.sha256;
    await writeFile(path.join(scratch, 'rules.yml'), ruleData.bytes, { mode: 0o600 });
    await writeFile(path.join(scratch, 'gitleaks.toml'), gitleaksRules, { mode: 0o600 });
    await writeFile(path.join(scratch, 'empty.ignore'), '', { mode: 0o600 });
    source = await snapshot(runner, cwd, target, headSha, env, signal, secrets); receipt.sourceHash = source.hash;
    for (const id of config.tools) {
      const row = { tool: id, version: toolCatalog.find(t => t.id === id).version, status: 'blocked', findings: [], scannedFiles: 0, evidence: [] }; receipt.tools.push(row);
      try {
        let tool = await resolveTool(id, { home: toolHome, project: cwd });
        if (!tool.ready && config.autoInstall) { await installTools([id], { home: toolHome, project: cwd, signal, runner }); tool = await resolveTool(id, { home: toolHome, project: cwd }); }
        if (!tool.ready) throw fail('tool_missing');
        if (tool.version !== row.version) throw fail('tool_version');
        Object.assign(row, await runScanner({ tool, config, source, target, scratch, cwd, headSha, runner, signal, secrets, env }));
      } catch (error) { row.reason = safeReason(error); row.status = row.reason === 'tool_missing' ? 'blocked' : 'error'; row.findings = []; }
    }
    await checkedHead(runner, cwd, headSha, env, signal);
    if ((await snapshot(runner, cwd, undefined, headSha, env, signal, secrets)).hash !== source.hash) throw fail('dirty_worktree');
    if (rules(config, cwd).sha256 !== receipt.rulesHash) throw fail('invalid_rules');
  } catch (error) {
    const reason = safeReason(error);
    for (const id of config.tools) {
      let row = receipt.tools.find(r => r.tool === id);
      if (!row) { row = { tool: id, version: toolCatalog.find(t => t.id === id).version, findings: [], scannedFiles: 0, evidence: [] }; receipt.tools.push(row); }
      row.status = 'error'; row.reason = reason;
    }
  } finally {
    try { if (scratch) await removeOwned(scratch, directory, 'scratch-'); }
    catch { for (const row of receipt.tools) { row.status = 'error'; row.reason = 'cleanup_failed'; } }
  }
  if (directory && source) {
    try {
      const content = JSON.stringify({ schemaVersion: 1, headSha, files: source.manifest });
      if (Buffer.byteLength(content) > maxEvidence) throw fail('scope_limit');
      const file = path.join(directory, 'sources.json'); await writeFile(file, content, { flag: 'wx', mode: 0o600 });
      receipt.sourceEvidence = { path: file, sha256: hash(content), bytes: Buffer.byteLength(content) };
    } catch { for (const row of receipt.tools) { row.status = 'error'; row.reason = 'invalid_artifacts'; } }
  }
  // Persist only the safe schema after raw snapshots, logs and private homes
  // have been removed. Missing evidence also prevents a fresh passing receipt.
  for (const row of receipt.tools) {
    if (!directory) continue;
    try {
      const content = JSON.stringify({ schemaVersion: 1, headSha, configHash: receipt.configHash, pinsHash: receipt.pinsHash, rulesHash: receipt.rulesHash, sourceHash: receipt.sourceHash, ...row, evidence: undefined });
      if (Buffer.byteLength(content) > maxEvidence) throw fail('scope_limit');
      const file = path.join(directory, `${row.tool}.json`);
      await writeFile(file, content, { flag: 'wx', mode: 0o600 });
      row.evidence = [{ path: file, sha256: hash(content), bytes: Buffer.byteLength(content) }];
    } catch { row.status = 'error'; row.reason = 'invalid_artifacts'; row.evidence = []; }
  }
  receipt.passed = receipt.tools.length === config.tools.length && receipt.tools.every(r => r.status === 'passed' && r.evidence.length === 1);
  receipt.status = receipt.passed ? 'passed' : receipt.tools.some(r => r.status === 'failed') ? 'failed' : 'blocked';
  return receipt;
}

export function isCurrentSecurityReceipt(receipt, { headSha, config } = {}) {
  try {
    config = normalizeSecurityConfig(config);
    if (!headOK(headSha) || receipt?.schemaVersion !== 1 || receipt.headSha !== headSha || receipt.configHash !== securityConfigHash(config) || receipt.pinsHash !== pinsHash()) return false;
    if (!config.enabled) return receipt.status === 'disabled' && receipt.passed === null && Array.isArray(receipt.tools) && receipt.tools.length === 0;
    if (receipt.status !== 'passed' || receipt.passed !== true || !Array.isArray(receipt.tools) || receipt.tools.length !== config.tools.length || !/^[a-f0-9]{64}$/.test(receipt.sourceHash)) return false;
    if (typeof receipt.cwd !== 'string' || !path.isAbsolute(receipt.cwd)) return false;
    outsideGit(receipt.evidenceRoot, receipt.cwd);
    if (rules(config, receipt.cwd).sha256 !== receipt.rulesHash) return false;
    const source = readEvidence(receipt.sourceEvidence, receipt.evidenceRoot);
    if (source.schemaVersion !== 1 || source.headSha !== headSha || !Array.isArray(source.files) || !source.files.length || source.files.length > 50000 || hash(JSON.stringify(source.files)) !== receipt.sourceHash) return false;
    const names = new Set();
    for (const entry of source.files) {
      relative(entry.file);
      if (names.has(entry.file) || excluded(entry.file) || !/^[a-f0-9]{64}$/.test(entry.sha256)) return false;
      names.add(entry.file);
      const file = path.join(receipt.cwd, entry.file); noLinks(file);
      const info = lstatSync(file);
      if (!info.isFile() || info.size > 16 * 1024 ** 2 || hash(readFileSync(file)) !== entry.sha256) return false;
    }
    return config.tools.every((id, i) => {
      const row = receipt.tools[i];
      if (row?.tool !== id || row.version !== toolCatalog.find(t => t.id === id).version || row.status !== 'passed' || row.reason !== undefined || !Array.isArray(row.findings) || row.findings.length || !Array.isArray(row.evidence) || row.evidence.length !== 1) return false;
      if (id === 'semgrep' ? !Number.isSafeInteger(row.scannedFiles) || row.scannedFiles < 1 : row.scannedFiles !== null || row.scopeFiles !== source.files.length) return false;
      if (config.history && id === 'gitleaks' && (!Number.isSafeInteger(row.historyCommits) || row.historyCommits < 1 || row.historyCommits > config.history.maxCommits)) return false;
      const data = readEvidence(row.evidence[0], receipt.evidenceRoot);
      return data.schemaVersion === 1 && data.headSha === headSha && data.configHash === receipt.configHash && data.pinsHash === receipt.pinsHash && data.rulesHash === receipt.rulesHash && data.sourceHash === receipt.sourceHash
        && data.tool === id && data.version === row.version && data.status === 'passed' && data.reason === undefined && Array.isArray(data.findings) && data.findings.length === 0 && data.scannedFiles === row.scannedFiles && data.scopeFiles === row.scopeFiles && data.historyCommits === row.historyCommits;
    });
  } catch { return false; }
}
function readEvidence(e, root) {
  if (!e || !path.isAbsolute(e.path) || !inside(root, e.path) || !Number.isSafeInteger(e.bytes) || e.bytes < 1 || e.bytes > maxEvidence || !/^[a-f0-9]{64}$/.test(e.sha256)) throw fail('invalid_artifacts');
  noLinks(e.path); const info = lstatSync(e.path);
  if (!info.isFile() || info.size !== e.bytes) throw fail('invalid_artifacts');
  const bytes = readFileSync(e.path); if (hash(bytes) !== e.sha256) throw fail('invalid_artifacts');
  return JSON.parse(bytes);
}
