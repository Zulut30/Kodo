/** Read-only source checks through the existing owned-process execution port.
 * Configured project commands are trusted executable code, not an OS sandbox.
 * Passing receipts require unchanged inventory/head and intact private evidence.
 */
import path from 'node:path';
import os from 'node:os';
import { performance } from 'node:perf_hooks';
import { access, lstat, mkdir, mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises';
import { execute } from './delivery.mjs';
import { resolveTool, toolCatalog } from './tools.mjs';
import { inside, noLinks, sha256 } from './toolchains.mjs';
import { redact, stateHome, workerEnvironment } from './security.mjs';
import { QualityProfileRegistry, qualityError, qualityInventory, qualityPath } from './quality.mjs';

const managed = new Set(['oxlint', 'oxfmt', 'typescript', 'stylelint', 'html-validate', 'sqlfluff']);
const malformed = () => { throw qualityError('invalid_output', 'incomplete or malformed quality tool output'); };
const parse = value => { try { return JSON.parse(value); } catch { return malformed(); } };
const relative = (root, file) => './' + (root ? file.slice(root.length + 1) : file);
const resultStates = new Set(['passed', 'failed', 'blocked', 'missing', 'unsupported', 'not_applicable', 'skipped', 'disabled']);
const pinsHash = (check, plan) => sha256(JSON.stringify({ tool: check.tool, version: check.version, pin: toolCatalog.find(t => t.id === check.tool) ?? plan.config.tools[check.tool] ?? null }));
async function toolIdentity(tool) {
  return sha256(JSON.stringify({ command: tool.command, args: tool.args ?? [], version: tool.version ?? null, binaryHash: tool.binaryHash ?? null, installationHash: tool.receipt ? sha256(await readFile(tool.receipt)) : null }));
}

async function nativeTool(id) {
  if (!['node', 'dotnet', 'cargo', 'rustc', 'rustfmt', 'go', 'gofmt', 'php'].includes(id)) throw qualityError('unsupported', 'unknown native quality runtime');
  if (id === 'node') return { command: process.execPath, args: [], env: {}, binaryHash: sha256(await readFile(process.execPath)) };
  for (const directory of (process.env.PATH ?? '').split(path.delimiter).filter(Boolean)) {
    if (!path.isAbsolute(directory)) continue;
    const filename = path.join(directory, id + (process.platform === 'win32' ? '.exe' : ''));
    try {
      await access(filename); const actual = await realpath(filename), info = await lstat(actual);
      if (!info.isFile() || info.size > 256 * 1024 * 1024) continue;
      return { command: filename, args: [], env: {}, binaryHash: sha256(await readFile(actual)) };
    } catch (error) { if (!['ENOENT', 'ENOTDIR', 'EACCES'].includes(error.code)) throw error; }
  }
  throw qualityError('missing', 'native quality runtime is not installed');
}
async function privateDirectory(target, project) {
  const absolute = path.resolve(target); await noLinks(absolute);
  if (inside(project, absolute) || inside(absolute, project) || absolute === path.parse(absolute).root || absolute === path.resolve(os.homedir())) throw qualityError('unsafe_evidence', 'quality evidence must be in a dedicated private directory outside the project');
  for (let current = absolute; ; current = path.dirname(current)) {
    try { await lstat(path.join(current, '.git')); throw qualityError('unsafe_evidence', 'quality evidence must be outside Git'); }
    catch (error) { if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') throw error; }
    if (current === path.dirname(current)) break;
  }
  await mkdir(absolute, { recursive: true, mode: 0o700 });
  return mkdtemp(path.join(absolute, 'quality-'));
}
function environment(home) {
  const base = workerEnvironment(), safe = {};
  for (const [key, value] of Object.entries(base)) if (/^(?:PATH|PATHEXT|SYSTEMROOT|WINDIR|COMSPEC|LANG|LC_ALL|NUMBER_OF_PROCESSORS|PROCESSOR_ARCHITECTURE|DOTNET_ROOT|DOTNET_ROOT_X64)$/i.test(key)) safe[key] = value;
  return { ...safe, HOME: home, USERPROFILE: home, APPDATA: home, LOCALAPPDATA: home, TEMP: home, TMP: home, TMPDIR: home,
    XDG_CONFIG_HOME: home, XDG_CACHE_HOME: home, NO_COLOR: '1', FORCE_COLOR: '0', CI: '1', DO_NOT_TRACK: '1',
    DOTNET_CLI_HOME: home, DOTNET_NOLOGO: '1', DOTNET_SKIP_FIRST_TIME_EXPERIENCE: '1', DOTNET_CLI_TELEMETRY_OPTOUT: '1', DOTNET_CLI_WORKLOAD_UPDATE_NOTIFY_DISABLE: '1', DOTNET_CLI_UI_LANGUAGE: 'en-US', VSLANG: '1033',
    RUSTUP_HOME: process.env.RUSTUP_HOME || path.join(os.homedir(), '.rustup'), RUSTUP_AUTO_INSTALL: '0', CARGO_HOME: home, CARGO_TARGET_DIR: path.join(home, 'cargo-target'), CARGO_NET_OFFLINE: 'true',
    GOENV: 'off', GOTOOLCHAIN: 'local', GOPROXY: 'off', GOSUMDB: 'off', GOFLAGS: '-mod=readonly', GOCACHE: path.join(home, 'go-cache'), GOMODCACHE: path.join(home, 'go-mod'),
    PYTHONDONTWRITEBYTECODE: '1', PYTHONNOUSERSITE: '1', PIP_DISABLE_PIP_VERSION_CHECK: '1', NPM_CONFIG_UPDATE_NOTIFIER: 'false' };
}
function validVersion(id, output, version) {
  if (typeof output !== 'string' || output.length > 4096) return false;
  const v = version.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), text = output.trim();
  const patterns = {
    oxlint: `^(?:Version: )?${v}$`, oxfmt: `^(?:Version: )?${v}$`, typescript: `^Version ${v}$`, stylelint: `^${v}$`, 'html-validate': `^(?:html-validate-)?${v}$`, sqlfluff: `^(?:python -m )?sqlfluff, version ${v}$`,
    node: `^v${v}$`, dotnet: `^${v}$`, cargo: `^cargo ${v}(?: \\([^\\r\\n]+\\))?$`, rustc: `^rustc ${v}(?: \\([^\\r\\n]+\\))?$`, clippy: `^clippy ${v}(?: \\([^\\r\\n]+\\))?$`, rustfmt: `^rustfmt ${v}(?:-(?:stable|nightly))?(?: \\([^\\r\\n]+\\))?$`,
    go: `^go version go${v} [a-z0-9]+/[a-z0-9]+$`, php: `^PHP ${v} \\(cli\\)(?:[^\\r\\n]*)(?:\\r?\\nCopyright \\(c\\) The PHP Group(?:[\\s\\S]*))?$`,
    phpcs: `^PHP_CodeSniffer version ${v} \\(stable\\)(?:[^\\r\\n]*)$`, phpstan: `^PHPStan - PHP Static Analysis Tool ${v}$`, phpunit: `^PHPUnit ${v}(?:[^\\r\\n]*)$`
  };
  return Boolean(patterns[id] && new RegExp(patterns[id]).test(text));
}
function fileInOutput(value, check, project) {
  if (typeof value !== 'string' || !value) return malformed();
  const filename = value.replaceAll('\\', '/');
  let name;
  if (path.isAbsolute(value) || /^[A-Za-z]:\//.test(filename)) {
    if (!inside(project, path.resolve(value))) return malformed();
    name = path.relative(project, value).replaceAll('\\', '/');
  } else name = (check.root ? check.root + '/' : '') + filename.replace(/^\.\//, '');
  qualityPath(name);
  if (!check.files.includes(name)) return malformed(); return name;
}
function finding(file, ruleId, line, severity, identity) {
  if (typeof ruleId !== 'string' || !/^[\w./:()@-]{1,160}$/.test(ruleId) || !Number.isInteger(line) || line < 1 || !['error', 'warning', 'info'].includes(severity)) return malformed();
  return { file, ruleId, line, severity, fingerprint: sha256(JSON.stringify({ file, ruleId, line, severity, identity })) };
}
/** Parsers never equate arbitrary exit-zero output with a completed check. */
export function parseQualityOutput(check, result, project) {
  if (!result || !Number.isInteger(result.code) || typeof result.stdout !== 'string' || typeof result.stderr !== 'string' || result.outputTruncated) return malformed();
  const out = result.stdout.trim(), findings = [], id = check.tool;
  if (check.configured) {
    const doc = parse(out);
    if (doc?.schemaVersion !== 1 || doc.complete !== true || !['passed', 'failed'].includes(doc.status) || !Array.isArray(doc.findings) || !Array.isArray(doc.scannedFiles)) return malformed();
    const scanned = doc.scannedFiles.map(f => fileInOutput(f, check, project));
    if (new Set(scanned).size !== check.files.length || check.files.some(f => !scanned.includes(f))) return malformed();
    for (const item of doc.findings) findings.push(finding(fileInOutput(item.file, check, project), item.ruleId, item.line, item.severity, item.fingerprint ?? item.message));
    if ((doc.status === 'passed') !== (findings.length === 0)) return malformed();
  } else if (id === 'oxlint') {
    if (result.stderr.trim()) return malformed();
    const doc = parse(out);
    if (!Array.isArray(doc?.diagnostics) || !Number.isInteger(doc.number_of_files) || doc.number_of_files !== check.files.length) return malformed();
    for (const item of doc.diagnostics) {
      const file = fileInOutput(item.filename, check, project), line = item.labels?.[0]?.span?.line ?? 1;
      if (typeof item.message !== 'string' || !Array.isArray(item.labels)) return malformed();
      findings.push(finding(file, item.code, line, item.severity, { message: item.message, labels: item.labels }));
    }
  } else if (['stylelint', 'html-validate', 'sqlfluff'].includes(id)) {
    if (id === 'stylelint' ? Boolean(out) && Boolean(result.stderr.trim()) : Boolean(result.stderr.trim())) return malformed();
    const doc = parse(id === 'stylelint' ? out || result.stderr.trim() : out);
    if (!Array.isArray(doc) || (id === 'html-validate' ? doc.length > check.files.length : doc.length !== check.files.length)) return malformed();
    const scanned = new Set();
    for (const item of doc) {
      const reportedPath = id === 'stylelint' ? item.source : id === 'html-validate' ? item.filePath : item.filepath;
      const file = fileInOutput(reportedPath, check, project); if (scanned.has(file)) return malformed(); scanned.add(file);
      let messages;
      if (id === 'stylelint') {
        if (!Array.isArray(item.warnings) || !Array.isArray(item.parseErrors) || !Array.isArray(item.invalidOptionWarnings) || item.parseErrors.length || item.invalidOptionWarnings.length || item.errored && !item.warnings.length) return malformed();
        messages = item.warnings;
      } else if (id === 'html-validate') {
        if (!Array.isArray(item.messages) || !Number.isInteger(item.errorCount) || item.errorCount < 0 || !Number.isInteger(item.warningCount) || item.warningCount < 0 || item.errorCount + item.warningCount !== item.messages.length) return malformed();
        messages = item.messages;
      } else { if (!Array.isArray(item.violations)) return malformed(); messages = item.violations; }
      for (const item of messages) findings.push(finding(file, item.rule ?? item.ruleId ?? item.code, item.line ?? item.start_line_no, item.severity === 2 ? 'error' : item.severity === 1 ? 'warning' : item.severity ?? 'error', item.text ?? item.message ?? item.description));
    }
  } else if (id === 'gofmt') {
    if (result.stderr.trim()) return malformed();
    for (const name of out ? out.split(/\r?\n/) : []) findings.push(finding(fileInOutput(name, check, project), 'format', 1, 'error', 'gofmt-unformatted'));
  } else if (id === 'oxfmt') {
    const complete = /^Checking formatting\.\.\.\s+All matched files use the correct format\.\s+Finished in [\d.]+(?:ms|s) on (\d+) files using \d+ threads\.$/.exec(out);
    const notice = 'No config found, using defaults. Please add a config file or try `oxfmt --init` if needed.';
    if (result.code === 0 && complete && Number(complete[1]) === check.files.length && (!result.stderr.trim() || result.stderr.trim() === notice)) return { findings, clean: true };
    if (result.code !== 0) return { findings, clean: false };
    return malformed();
  } else if (id === 'typescript') {
    if (result.code === 0 && !out && !result.stderr.trim()) return { findings, clean: true };
    // Type errors are not silently baseline-able from incomplete text output.
    if (result.code !== 0 && /error TS\d+:/.test(out + result.stderr)) return { findings, clean: false };
    return malformed();
  } else if (id === 'rustfmt') {
    if (result.code === 0 && !out && !result.stderr.trim()) return { findings, clean: true };
    if (result.code !== 0 && /^(?:Diff in|error:)/m.test(out + result.stderr)) return { findings, clean: false };
    return malformed();
  } else if (id === 'cargo') {
    if (result.code === 0 && result.stderr.trim().split(/\r?\n/).filter(Boolean).some(line => !/^\s*(?:Checking|Compiling|Finished|Fresh|Blocking waiting for file lock)\b/.test(line))) return malformed();
    const rows = out.split(/\r?\n/).filter(Boolean).map(parse);
    if (!rows.length || rows.at(-1).reason !== 'build-finished' || typeof rows.at(-1).success !== 'boolean') return malformed();
    if (rows.some(row => !['compiler-message', 'compiler-artifact', 'build-script-executed', 'build-finished'].includes(row.reason))) return malformed();
    for (const row of rows.filter(r => r.reason === 'compiler-message')) {
      const message = row.message, span = message?.spans?.find(s => s.is_primary);
      if (message?.level === 'failure-note') continue;
      if (!span || !['error', 'warning', 'note', 'help'].includes(message.level)) return malformed();
      findings.push(finding(fileInOutput(span.file_name, check, project), message.code?.code ?? 'compiler', span.line_start, ['note', 'help'].includes(message.level) ? 'info' : message.level, message.message));
    }
    if (result.code === 0 && rows.at(-1).success !== true) return malformed();
  } else if (id === 'go') {
    if (result.code === 0 && !out && !result.stderr.trim()) return { findings, clean: true };
    if (result.code !== 0 && /(?:\.go:\d+|^# )/m.test(out + result.stderr)) return { findings, clean: false };
    return malformed();
  } else if (id === 'dotnet') {
    if (check.capability === 'typecheck') {
      const summaries = out.split(/\r?\n/).filter(line => /(?:Warning|Error)\(s\)/.test(line));
      const completeCleanSummary = summaries.length === 2 && summaries.some(line => /^\s*0 Warning\(s\)\s*$/.test(line)) && summaries.some(line => /^\s*0 Error\(s\)\s*$/.test(line));
      if (result.code === 0 && !result.stderr.trim() && /Build succeeded\./.test(out) && !/Build FAILED/.test(out) && completeCleanSummary && !/\b(?:warning|error) [A-Z]+\d+:/.test(out)) return { findings, clean: true };
      if (result.code !== 0 && /(?:Build FAILED|error [A-Z]+\d+:)/.test(out + result.stderr)) return { findings, clean: false };
      return malformed();
    }
    if (result.code === 0 && !out && !result.stderr.trim()) return { findings, clean: true };
    if (result.code !== 0) return { findings, clean: false };
    return malformed();
  } else if (id === 'php') {
    if (result.code === 0 && /^No syntax errors detected in [^\r\n]+$/.test(out) && !result.stderr.trim()) return { findings, clean: true };
    if (result.code !== 0 && /(?:Parse error|Errors parsing|Fatal error)/.test(out + result.stderr)) return { findings, clean: false };
    return malformed();
  } else if (id === 'phpcs') {
    const doc = parse(out); if (!doc?.totals || !doc.files || typeof doc.files !== 'object') return malformed();
    const entries = Object.entries(doc.files);
    if (entries.length !== check.files.length) return malformed();
    for (const [name, item] of entries) {
      if (!Array.isArray(item.messages)) return malformed();
      const file = fileInOutput(name, check, project);
      for (const message of item.messages) findings.push(finding(file, message.source, message.line, message.type?.toLowerCase(), message.message));
    }
    if (doc.totals.errors + doc.totals.warnings !== findings.length) return malformed();
  } else if (id === 'phpstan') {
    const doc = parse(out);
    if (!doc?.totals || !doc.files || !Array.isArray(doc.errors) || doc.errors.length || doc.totals.errors !== 0 || !Number.isInteger(doc.totals.file_errors) || doc.totals.file_errors < 0) return malformed();
    for (const [name, item] of Object.entries(doc.files)) {
      if (!Array.isArray(item.messages)) return malformed();
      for (const message of item.messages) findings.push(finding(fileInOutput(name, check, project), message.identifier ?? 'phpstan', message.line, 'error', message.message));
    }
    if (doc.totals.file_errors !== findings.length) return malformed();
  } else return malformed();
  return { findings, clean: findings.length === 0 && result.code === 0 };
}

function argumentsFor(check, home, plan) {
  const files = check.files.map(f => relative(check.root, f)), manifest = check.manifest ? relative(check.root, check.manifest) : undefined;
  if (check.configured) return check.configured.args;
  switch (check.tool) {
    case 'oxlint': return ['--format', 'json', '--deny-warnings', '--no-ignore', ...(check.frameworks?.includes('react') ? ['--react-plugin', '--jsx-a11y-plugin'] : []), ...(check.frameworks?.includes('next') ? ['--nextjs-plugin'] : []), ...files];
    case 'oxfmt': return ['--check', ...files];
    case 'typescript': return ['--noEmit', '--incremental', 'false', '--pretty', 'false', ...(plan.config.strictness === 'strict' ? ['--strict'] : []), '--project', manifest];
    case 'stylelint': return ['--formatter', 'json', ...files];
    case 'html-validate': return ['--formatter', 'json', '--max-warnings', '0', ...files];
    case 'sqlfluff': return ['lint', '--format', 'json', '--dialect', check.dialect, '--disable-progress-bar', ...files];
    case 'rustfmt': return ['--check', '--edition', check.edition, ...files];
    case 'cargo': return [check.capability === 'lint' ? 'clippy' : 'check', '--offline', '--locked', '--manifest-path', manifest, '--message-format=json', ...(check.capability === 'lint' ? ['--', '-D', 'warnings'] : [])];
    case 'gofmt': return ['-l', ...files];
    case 'go': return check.capability === 'typecheck' ? ['build', '-o', path.join(home, 'go-output') + path.sep, './...'] : ['vet', './...'];
    case 'dotnet': return check.capability === 'typecheck'
      ? ['build', manifest, '--no-restore', '--nologo', '-p:TreatWarningsAsErrors=true', `-p:OutputPath=${path.join(home, 'dotnet-output')}`]
      : ['format', ...(check.capability === 'lint' ? ['analyzers'] : ['whitespace']), manifest, '--verify-no-changes', '--no-restore', '--include', ...files];
    case 'php': return ['-n', '-l', files[0]];
    case 'phpcs': return [check.entry, '--report=json', `--standard=${check.frameworks?.includes('wordpress') ? 'WordPress' : 'PSR12'}`, ...files];
    case 'phpstan': return [check.entry, 'analyse', '--no-progress', '--error-format=json', ...files];
    default: throw qualityError('unsupported', 'unsupported quality command');
  }
}
function allowDebt(check, findings, plan) {
  if (plan.config.strictness !== 'adopt') return { findings, debtCount: 0 };
  const changed = new Set([...(plan.changedPaths ?? check.files), ...plan.affectedPaths, ...(plan.actualChangedPaths ?? [])]), hashes = new Map(plan.files.map(f => [f.path, f.sha256]));
  let debtCount = 0; const used = new Set();
  const remaining = findings.filter(item => {
    const index = plan.config.baseline.findIndex((old, index) => !used.has(index) && !changed.has(item.file) && old.language === check.language && old.capability === check.capability && old.tool === check.tool && old.file === item.file && old.line === item.line && old.ruleId === item.ruleId && old.severity === item.severity && old.fingerprint === item.fingerprint && old.sourceHash === hashes.get(item.file));
    if (index < 0) return true; used.add(index); debtCount++; return false;
  });
  return { findings: remaining, debtCount };
}
async function safeProjectEntrypoint(project, entry) {
  qualityPath(entry); const filename = path.join(project, entry); await noLinks(filename);
  const info = await lstat(filename);
  if (!info.isFile() || info.nlink > 1 || info.size > 32 * 1024 * 1024) throw qualityError('unsafe_path', 'unsafe quality project executable');
  return sha256(await readFile(filename));
}
export async function runQuality(options = {}) {
  const { project = process.cwd(), runner = execute, resolve = resolveTool, nativeResolve = nativeTool, signal } = options;
  const plan = await new QualityProfileRegistry().plan(project, options), start = performance.now(), receipts = [];
  // SQL format/lint deliberately use the same read-only SQLFluff invocation.
  // Share only exact commands within this run; capabilities still evaluate their
  // own findings/debt and retain separate receipts. This is not a cross-run cache.
  const sqlObservations = new Map();
  const timeoutMs = options.timeoutMs ?? plan.config.timeoutMs, maxOutputBytes = options.maxOutputBytes ?? plan.config.maxOutputBytes;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 1800000 || !Number.isInteger(maxOutputBytes) || maxOutputBytes < 1 || maxOutputBytes > 16 * 1024 * 1024) throw qualityError('configuration', 'invalid quality deadline or output limit');
  const evidenceRoot = await privateDirectory(options.evidenceDir ?? path.join(stateHome(), 'quality'), plan.project);
  const env = environment(evidenceRoot);
  const secrets = Object.fromEntries(Object.entries(process.env).filter(([name]) => /(?:API[_-]?KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|DATABASE_URL)/i.test(name)));
  const clean = value => redact(value, secrets);
  let headSha = null, headError;
  const head = async () => {
    const result = await execute('git', ['rev-parse', '--verify', 'HEAD'], { cwd: plan.project, signal, timeoutMs: Math.min(timeoutMs, 10000), maxOutputBytes: 1024 });
    const value = result.stdout.trim(); if (!/^[a-f0-9]{40,64}$/.test(value)) throw qualityError('git_head_required', 'valid Git HEAD required for quality receipts'); return value;
  };
  try {
    headSha = await head();
    const git = async args => {
      const output = await execute('git', args, { cwd: plan.project, signal, timeoutMs: Math.min(timeoutMs, 10000), maxOutputBytes: 2 * 1024 * 1024 });
      return output.stdout;
    };
    const prefix = (await git(['rev-parse', '--show-prefix'])).trim();
    const tracked = new Set((await git(['ls-tree', '-r', '--full-tree', '--name-only', '-z', 'HEAD', '--', '.'])).split('\0').filter(Boolean).map(name => name.startsWith(prefix) ? name.slice(prefix.length) : null).filter(Boolean));
    const modified = new Set((await git(['diff', '--name-only', '--relative', '-z', 'HEAD', '--', '.'])).split('\0').filter(Boolean));
    plan.actualChangedPaths = plan.files.filter(file => !tracked.has(file.path) || modified.has(file.path)).map(file => file.path);
  } catch (error) { headError = error.code === 'cancelled' ? 'cancelled' : 'git_head_required'; }
  for (const check of plan.checks) {
    const began = performance.now(), logs = []; let capturedBytes = 0;
    const receipt = { schemaVersion: 1, id: check.id, language: check.language, capability: check.capability, tool: check.tool, version: check.version, status: check.status, reason: check.reason, files: check.files, scopeReason: check.scopeReason, headSha, configHash: plan.configHash, sourceHash: plan.sourceHash, pinsHash: pinsHash(check, plan), findings: [], debtCount: 0, durationMs: 0, evidence: [] };
    receipts.push(receipt);
    const call = async (command, args, overrides = {}) => {
      signal?.throwIfAborted();
      const remaining = Math.ceil(timeoutMs - (performance.now() - began));
      if (remaining < 1) throw qualityError('timeout', 'quality check deadline exceeded');
      if (capturedBytes >= maxOutputBytes) throw qualityError('output_limit', 'quality check output budget exhausted');
      const settings = { cwd: path.join(plan.project, check.root), signal, timeoutMs: remaining, maxOutputBytes: maxOutputBytes - capturedBytes, allowFailure: true, env, ...overrides };
      const sharedKey = check.tool === 'sqlfluff' && !check.configured ? sha256(JSON.stringify({ command, args, cwd: settings.cwd, env: settings.env, toolIdentity: receipt.toolIdentity, version: check.version, files: check.files, sourceHash: plan.sourceHash, configHash: plan.configHash, headSha })) : null;
      const observation = sharedKey ? sqlObservations.get(sharedKey) : undefined;
      if (observation) {
        receipt.reusedFrom = [...new Set([...(receipt.reusedFrom ?? []), observation.id])];
        logs.push({ stage: overrides.stage ?? 'check', reusedFrom: observation.id, durationMs: 0, observationHash: observation.hash });
        if (observation.error) throw observation.error;
        return structuredClone(observation.output);
      }
      const callStart = performance.now();
      try {
        const output = await runner(command, args, settings);
        // A dependency-injected process port must honor the same complete contract.
        if (!output || typeof output.stdout !== 'string' || typeof output.stderr !== 'string' || !Number.isInteger(output.code)) throw qualityError('invalid_output', 'incomplete quality process result');
        capturedBytes += Buffer.byteLength(output.stdout) + Buffer.byteLength(output.stderr);
        if (capturedBytes > maxOutputBytes || output.outputTruncated) throw Object.assign(qualityError('output_limit', 'quality output exceeded limit'), { result: output });
        logs.push(clean({ stage: overrides.stage ?? 'check', command, args, durationMs: performance.now() - callStart, ...output }));
        signal?.throwIfAborted();
        if (sharedKey) sqlObservations.set(sharedKey, { id: receipt.id, output, hash: sha256(JSON.stringify(clean(output))) });
        return output;
      } catch (error) {
        if (error.result) {
          const output = clean(error.result), available = Math.max(0, maxOutputBytes - logs.reduce((total, row) => total + Buffer.byteLength(row.stdout ?? '') + Buffer.byteLength(row.stderr ?? ''), 0));
          const stdout = Buffer.from(output.stdout ?? '').subarray(0, available).toString('utf8'), stderr = Buffer.from(output.stderr ?? '').subarray(0, Math.max(0, available - Buffer.byteLength(stdout))).toString('utf8');
          logs.push({ stage: overrides.stage ?? 'check', command: clean(command), args: clean(args), durationMs: performance.now() - callStart, ...output, stdout, stderr });
        }
        if (sharedKey) sqlObservations.set(sharedKey, { id: receipt.id, error, hash: sha256(JSON.stringify(clean({ code: error.code ?? 'process_failed', result: error.result ?? null }))) });
        throw error;
      }
    };
    try {
      if (check.status !== 'applicable') continue;
      if (headError) throw qualityError(headError, headError);
      signal?.throwIfAborted();
      if (sha256(JSON.stringify(await qualityInventory(plan.project))) !== plan.sourceHash) throw qualityError('source_mutation', 'source changed since quality plan');
      let tool;
      if (managed.has(check.tool)) {
        tool = await resolve(check.tool, { project: plan.project, home: options.toolHome, platform: options.platform, arch: options.arch });
        if (!tool?.ready || tool.status !== 'ready') throw qualityError(['missing', 'unsupported'].includes(tool?.status) ? tool.status : 'tool_integrity', 'managed quality tool is not ready');
        if (tool.id !== check.tool || tool.version !== check.version || typeof tool.command !== 'string' || !Array.isArray(tool.args) || tool.args.some(a => typeof a !== 'string')) throw qualityError('tool_integrity', 'invalid managed tool port');
      } else tool = await nativeResolve(['phpcs', 'phpstan'].includes(check.tool) ? 'php' : check.tool);
      receipt.binaryHash = tool.binaryHash ?? null;
      receipt.toolIdentity = await toolIdentity(tool);
      if (check.tool === 'go' && check.capability === 'typecheck') await mkdir(path.join(evidenceRoot, 'go-output'), { recursive: true, mode: 0o700 });
      const toolEnv = { ...env, ...(tool.env ?? {}) }, prefix = tool.args ?? [];
      if (check.tool === 'cargo') {
        const rustc = await nativeResolve('rustc');
        const compiler = await call(rustc.command, [...(rustc.args ?? []), '--version'], { stage: 'version' });
        if (compiler.code !== 0 || compiler.stderr.trim() || !validVersion('rustc', compiler.stdout, check.rustcVersion)) throw qualityError('version_mismatch', 'Rust compiler version mismatch');
        receipt.compilerIdentity = await toolIdentity(rustc);
        if (check.capability === 'lint') {
          const clippy = await call(tool.command, [...prefix, 'clippy', '--version'], { env: toolEnv, stage: 'version' });
          if (clippy.code !== 0 || clippy.stderr.trim() || !validVersion('clippy', clippy.stdout, check.clippyVersion)) throw qualityError('version_mismatch', 'Clippy version mismatch');
        }
      }
      if (['phpcs', 'phpstan'].includes(check.tool)) {
        const php = await call(tool.command, [...prefix, '--version'], { env: toolEnv, stage: 'version' });
        if (php.code !== 0 || php.stderr.trim() || !validVersion('php', php.stdout, check.phpVersion)) throw qualityError('version_mismatch', 'PHP runtime version mismatch');
        receipt.entryHash = await safeProjectEntrypoint(plan.project, (check.root ? check.root + '/' : '') + check.entry);
      }
      if (check.configured && ['node', 'php'].includes(check.tool)) {
        receipt.entryHash = await safeProjectEntrypoint(plan.project, check.configured.args[0].replace(/^\.\//, ''));
      }
      if (check.configured) for (const arg of check.configured.args) {
        const value = arg.startsWith('-') && arg.includes('=') ? arg.slice(arg.indexOf('=') + 1) : arg;
        if (value.includes('/') || value.includes('\\') || value.includes(':')) {
          const name = value.replace(/^\.\//, ''); qualityPath(name);
          if (!plan.files.some(f => f.path === name)) throw qualityError('unsafe_path', 'configured quality command path is outside its source scope');
        }
      }
      let version;
      if (check.tool === 'gofmt') {
        const go = await nativeResolve('go');
        version = await call(go.command, [...(go.args ?? []), 'version', tool.command], { stage: 'version' });
        const expected = `${tool.command}: go${check.version}`;
        const observed = version.stdout.replace(/\r?\n$/, '');
        if (version.code !== 0 || version.stderr.trim() || /[\r\n\0]/.test(observed) || observed !== expected) throw qualityError('version_mismatch', 'gofmt binary version mismatch');
      } else {
        const versionArgs = ['phpcs', 'phpstan'].includes(check.tool) ? [check.entry, '--version'] : check.tool === 'go' ? ['version'] : ['--version'];
        version = await call(tool.command, [...prefix, ...versionArgs], { env: toolEnv, stage: 'version' });
        if (version.code !== 0 || version.stderr.trim() || (check.configured ? version.stdout.trim() !== check.configured.versionOutput : !validVersion(check.tool, version.stdout, check.version))) throw qualityError('version_mismatch', 'exact quality tool version mismatch');
      }
      receipt.actualVersion = check.version;
      const groups = check.tool === 'php' && !check.configured ? check.files.map(file => ({ ...check, files: [file] })) : [check];
      let successful = true;
      for (const group of groups) {
        const output = await call(tool.command, [...prefix, ...argumentsFor(group, evidenceRoot, plan)], { env: toolEnv });
        let parsed = parseQualityOutput(group, output, plan.project);
        const debt = allowDebt(check, parsed.findings, plan);
        receipt.findings.push(...debt.findings); receipt.debtCount += debt.debtCount;
        // Only known diagnostic exit codes with fully matched old observations
        // may be adopted. Crashes and arbitrary nonzero codes never become PASS.
        const diagnosticExitCodes = { oxlint: [1], stylelint: [2], 'html-validate': [1], sqlfluff: [1], phpcs: [1, 2], phpstan: [1] };
        const baselined = parsed.findings.length > 0 && debt.findings.length === 0 && diagnosticExitCodes[check.tool]?.includes(output.code);
        successful &&= (parsed.clean && output.code === 0) || baselined;
      }
      receipt.status = successful ? 'passed' : 'failed'; if (!successful) receipt.reason = receipt.findings.length ? 'violations' : 'tool_failed';
    } catch (error) {
      const code = signal?.aborted ? 'cancelled' : error.result?.outputTruncated ? 'output_limit' : error.code ?? 'process_failed';
      receipt.status = ['missing', 'unsupported'].includes(code) ? code : 'blocked';
      receipt.reason = code === 'ENOENT' ? 'missing' : code;
    } finally {
      if (check.status === 'applicable') {
        try {
          if (sha256(JSON.stringify(await qualityInventory(plan.project))) !== plan.sourceHash) { receipt.status = 'blocked'; receipt.reason = 'source_mutation'; }
          else if (!headError && await head() !== headSha) { receipt.status = 'blocked'; receipt.reason = 'head_mutation'; }
        } catch (error) { receipt.status = 'blocked'; receipt.reason = signal?.aborted ? 'cancelled' : error.code ?? 'source_mutation'; }
      }
      receipt.durationMs = performance.now() - began;
      if (!resultStates.has(receipt.status)) { receipt.status = 'blocked'; receipt.reason = 'incomplete_receipt'; }
      const content = JSON.stringify(clean({ ...receipt, evidence: undefined, logs })) + '\n';
      const filename = path.join(evidenceRoot, `${String(receipts.length).padStart(4, '0')}-${sha256(check.id).slice(0, 12)}.json`);
      try { await writeFile(filename, content, { flag: 'wx', mode: 0o600 }); receipt.evidence = [{ path: filename, sha256: sha256(content), bytes: Buffer.byteLength(content) }]; }
      catch { receipt.status = 'blocked'; receipt.reason = 'evidence_write_failed'; }
    }
  }
  const status = receipts.some(r => ['blocked', 'missing', 'unsupported'].includes(r.status)) ? 'blocked' : receipts.some(r => r.status === 'failed') ? 'failed' : receipts.some(r => r.status === 'passed') ? 'passed' : plan.config.enabled ? 'skipped' : 'disabled';
  return clean({ schemaVersion: 1, status, passed: status === 'passed' ? true : ['failed', 'blocked'].includes(status) ? false : null, durationMs: performance.now() - start, headSha, configHash: plan.configHash, sourceHash: plan.sourceHash, evidenceRoot, plan, receipts });
}

/** Current-head validation is for callers reusing a receipt; Engine is unchanged. */
export async function isCurrentQualityReceipt(report, { project, runner = execute, resolve = resolveTool, nativeResolve = nativeTool, toolHome } = {}) {
  try {
    if (report?.schemaVersion !== 1 || report.status !== 'passed' || report.passed !== true || !Array.isArray(report.receipts) || !report.receipts.some(r => r.status === 'passed')) return false;
    const plan = await new QualityProfileRegistry().plan(project ?? report.plan.project, { mode: report.plan.mode, changedPaths: report.plan.changedPaths, affectedPaths: report.plan.affectedPaths, capabilities: report.plan.selectedCapabilities });
    if (plan.configHash !== report.configHash || plan.sourceHash !== report.sourceHash) return false;
    const head = await runner('git', ['rev-parse', '--verify', 'HEAD'], { cwd: plan.project, timeoutMs: 10000, maxOutputBytes: 1024 });
    if (head.code !== 0 || head.stdout.trim() !== report.headSha || plan.checks.length !== report.receipts.length) return false;
    await noLinks(report.evidenceRoot);
    if (inside(plan.project, report.evidenceRoot)) return false;
    for (const [index, row] of report.receipts.entries()) {
      const check = plan.checks[index];
      if (row.id !== check.id || row.tool !== check.tool || row.version !== check.version || row.pinsHash !== pinsHash(check, plan) || JSON.stringify(row.files) !== JSON.stringify(check.files)) return false;
      if (!resultStates.has(row.status) || ['blocked', 'failed', 'missing', 'unsupported'].includes(row.status) || row.evidence.length !== 1) return false;
      const item = row.evidence[0]; if (!inside(report.evidenceRoot, path.resolve(item.path))) return false; await noLinks(item.path);
      const content = await readFile(item.path); if (sha256(content) !== item.sha256 || content.length !== item.bytes) return false;
      const stored = JSON.parse(content);
      const { logs, ...storedReceipt } = stored, { evidence, ...suppliedReceipt } = row;
      if (JSON.stringify(storedReceipt) !== JSON.stringify(suppliedReceipt) || stored.headSha !== report.headSha || stored.sourceHash !== report.sourceHash || stored.configHash !== report.configHash) return false;
      if (row.status === 'passed') {
        const tool = managed.has(check.tool) ? await resolve(check.tool, { project: plan.project, home: toolHome }) : await nativeResolve(['phpcs', 'phpstan'].includes(check.tool) ? 'php' : check.tool);
        if (managed.has(check.tool) && (!tool.ready || tool.status !== 'ready') || await toolIdentity(tool) !== row.toolIdentity) return false;
        if (row.compilerIdentity && await toolIdentity(await nativeResolve('rustc')) !== row.compilerIdentity) return false;
        if (row.entryHash && await safeProjectEntrypoint(plan.project, check.configured?.args[0].replace(/^\.\//, '') ?? (check.root ? check.root + '/' : '') + check.entry) !== row.entryHash) return false;
      }
    }
    return true;
  } catch { return false; }
}
