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
import { parseQualityOutput } from './quality-parsers.mjs';

export { parseQualityOutput };

const managed = new Set(['oxlint', 'oxfmt', 'typescript', 'stylelint', 'html-validate', 'sqlfluff']);
const relative = (root, file) => './' + (root ? file.slice(root.length + 1) : file);
const resultStates = new Set([
  'passed',
  'failed',
  'blocked',
  'missing',
  'unsupported',
  'not_applicable',
  'skipped',
  'disabled',
]);
const pinsHash = (check, plan) =>
  sha256(
    JSON.stringify({
      tool: check.tool,
      version: check.version,
      pin: toolCatalog.find(t => t.id === check.tool) ?? plan.config.tools[check.tool] ?? null,
    }),
  );
async function toolIdentity(tool) {
  return sha256(
    JSON.stringify({
      command: tool.command,
      args: tool.args ?? [],
      version: tool.version ?? null,
      binaryHash: tool.binaryHash ?? null,
      installationHash: tool.receipt ? sha256(await readFile(tool.receipt)) : null,
    }),
  );
}

async function nativeTool(id) {
  if (!['node', 'dotnet', 'cargo', 'rustc', 'rustfmt', 'go', 'gofmt', 'php'].includes(id))
    throw qualityError('unsupported', 'unknown native quality runtime');
  if (id === 'node')
    return { command: process.execPath, args: [], env: {}, binaryHash: sha256(await readFile(process.execPath)) };
  for (const directory of (process.env.PATH ?? '').split(path.delimiter).filter(Boolean)) {
    if (!path.isAbsolute(directory)) continue;
    const filename = path.join(directory, id + (process.platform === 'win32' ? '.exe' : ''));
    try {
      await access(filename);
      const actual = await realpath(filename),
        info = await lstat(actual);
      if (!info.isFile() || info.size > 256 * 1024 * 1024) continue;
      return { command: filename, args: [], env: {}, binaryHash: sha256(await readFile(actual)) };
    } catch (error) {
      if (!['ENOENT', 'ENOTDIR', 'EACCES'].includes(error.code)) throw error;
    }
  }
  throw qualityError('missing', 'native quality runtime is not installed');
}
async function privateDirectory(target, project) {
  const requested = path.resolve(target);
  await noLinks(requested);
  // The project is canonical; compare evidence in that same namespace even
  // when its not-yet-created leaf is supplied through a Windows alias.
  let current = requested;
  const missing = [];
  let absolute;
  for (;;) {
    try {
      absolute = path.join(await realpath(current), ...missing);
      break;
    } catch (error) {
      if (error.code !== 'ENOENT' || current === path.dirname(current)) throw error;
      missing.unshift(path.basename(current));
      current = path.dirname(current);
    }
  }
  await noLinks(absolute);
  if (
    inside(project, absolute) ||
    inside(absolute, project) ||
    absolute === path.parse(absolute).root ||
    absolute === (await realpath(os.homedir()))
  )
    throw qualityError(
      'unsafe_evidence',
      'quality evidence must be in a dedicated private directory outside the project',
    );
  for (let current = absolute; ; current = path.dirname(current)) {
    try {
      await lstat(path.join(current, '.git'));
      throw qualityError('unsafe_evidence', 'quality evidence must be outside Git');
    } catch (error) {
      if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') throw error;
    }
    if (current === path.dirname(current)) break;
  }
  await mkdir(absolute, { recursive: true, mode: 0o700 });
  return mkdtemp(path.join(absolute, 'quality-'));
}
function environment(home) {
  const base = workerEnvironment(),
    safe = {};
  for (const [key, value] of Object.entries(base))
    if (
      /^(?:PATH|PATHEXT|SYSTEMROOT|WINDIR|COMSPEC|LANG|LC_ALL|NUMBER_OF_PROCESSORS|PROCESSOR_ARCHITECTURE|DOTNET_ROOT|DOTNET_ROOT_X64)$/i.test(
        key,
      )
    )
      safe[key] = value;
  return {
    ...safe,
    HOME: home,
    USERPROFILE: home,
    APPDATA: home,
    LOCALAPPDATA: home,
    TEMP: home,
    TMP: home,
    TMPDIR: home,
    XDG_CONFIG_HOME: home,
    XDG_CACHE_HOME: home,
    NO_COLOR: '1',
    FORCE_COLOR: '0',
    CI: '1',
    DO_NOT_TRACK: '1',
    DOTNET_CLI_HOME: home,
    DOTNET_NOLOGO: '1',
    DOTNET_SKIP_FIRST_TIME_EXPERIENCE: '1',
    DOTNET_CLI_TELEMETRY_OPTOUT: '1',
    DOTNET_CLI_WORKLOAD_UPDATE_NOTIFY_DISABLE: '1',
    DOTNET_CLI_UI_LANGUAGE: 'en-US',
    VSLANG: '1033',
    RUSTUP_HOME: process.env.RUSTUP_HOME || path.join(os.homedir(), '.rustup'),
    RUSTUP_AUTO_INSTALL: '0',
    CARGO_HOME: home,
    CARGO_TARGET_DIR: path.join(home, 'cargo-target'),
    CARGO_NET_OFFLINE: 'true',
    GOENV: 'off',
    GOWORK: 'off',
    GO111MODULE: 'on',
    GOTOOLCHAIN: 'local',
    GOPROXY: 'off',
    GOSUMDB: 'off',
    GOFLAGS: '-mod=readonly',
    GOPATH: path.join(home, 'go-path'),
    GOCACHE: path.join(home, 'go-cache'),
    GOMODCACHE: path.join(home, 'go-mod'),
    PYTHONDONTWRITEBYTECODE: '1',
    PYTHONNOUSERSITE: '1',
    PIP_DISABLE_PIP_VERSION_CHECK: '1',
    NPM_CONFIG_UPDATE_NOTIFIER: 'false',
  };
}
function validVersion(id, output, version) {
  if (typeof output !== 'string' || output.length > 4096) return false;
  const v = version.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'),
    text = output.trim();
  const patterns = {
    oxlint: `^(?:Version: )?${v}$`,
    oxfmt: `^(?:Version: )?${v}$`,
    typescript: `^Version ${v}$`,
    stylelint: `^${v}$`,
    'html-validate': `^(?:html-validate-)?${v}$`,
    sqlfluff: `^(?:python -m )?sqlfluff, version ${v}$`,
    node: `^v${v}$`,
    dotnet: `^${v}$`,
    cargo: `^cargo ${v}(?: \\([^\\r\\n]+\\))?$`,
    rustc: `^rustc ${v}(?: \\([^\\r\\n]+\\))?$`,
    clippy: `^clippy ${v}(?: \\([^\\r\\n]+\\))?$`,
    rustfmt: `^rustfmt ${v}(?:-(?:stable|nightly))?(?: \\([^\\r\\n]+\\))?$`,
    go: `^go version go${v} [a-z0-9]+/[a-z0-9]+$`,
    php: `^PHP ${v} \\(cli\\)(?:[^\\r\\n]*)(?:\\r?\\nCopyright \\(c\\) The PHP Group(?:[\\s\\S]*))?$`,
    phpcs: `^PHP_CodeSniffer version ${v} \\(stable\\)(?:[^\\r\\n]*)$`,
    phpstan: `^PHPStan - PHP Static Analysis Tool ${v}$`,
    phpunit: `^PHPUnit ${v}(?:[^\\r\\n]*)$`,
  };
  return Boolean(patterns[id] && new RegExp(patterns[id]).test(text));
}

function argumentsFor(check, home, plan) {
  const files = check.files.map(f => relative(check.root, f)),
    manifest = check.manifest ? relative(check.root, check.manifest) : undefined;
  if (check.configured) return check.configured.args;
  switch (check.tool) {
    case 'oxlint':
      return [
        '--format',
        'json',
        '--deny-warnings',
        '--no-ignore',
        ...(check.frameworks?.includes('react') ? ['--react-plugin', '--jsx-a11y-plugin'] : []),
        ...(check.frameworks?.includes('next') ? ['--nextjs-plugin'] : []),
        ...files,
      ];
    case 'oxfmt':
      return ['--check', ...files];
    case 'typescript':
      return [
        '--noEmit',
        '--incremental',
        'false',
        '--pretty',
        'false',
        ...(plan.config.strictness === 'strict' ? ['--strict'] : []),
        '--project',
        check.typecheckConfig.path,
      ];
    case 'stylelint':
      return ['--formatter', 'json', ...files];
    case 'html-validate':
      return ['--formatter', 'json', '--max-warnings', '0', ...files];
    case 'sqlfluff':
      return ['lint', '--format', 'json', '--dialect', check.dialect, '--disable-progress-bar', ...files];
    case 'rustfmt':
      return ['--check', '--edition', check.edition, ...files];
    case 'cargo':
      return [
        check.capability === 'lint' ? 'clippy' : 'check',
        '--offline',
        '--locked',
        '--manifest-path',
        manifest,
        '--message-format=json',
        ...(check.capability === 'lint' ? ['--', '-D', 'warnings'] : []),
      ];
    case 'gofmt':
      return ['-l', ...files];
    case 'go':
      return check.capability === 'typecheck'
        ? ['build', '-o', path.join(home, 'go-output') + path.sep, './...']
        : ['vet', './...'];
    case 'dotnet':
      return check.capability === 'typecheck'
        ? [
            'build',
            manifest,
            '--no-restore',
            '--nologo',
            '-p:TreatWarningsAsErrors=true',
            `-p:OutputPath=${path.join(home, 'dotnet-output')}`,
          ]
        : [
            'format',
            ...(check.capability === 'lint' ? ['analyzers'] : ['whitespace']),
            manifest,
            '--verify-no-changes',
            '--no-restore',
            '--include',
            ...files,
          ];
    case 'php':
      return ['-n', '-l', files[0]];
    case 'phpcs':
      return [
        check.entry,
        '--report=json',
        `--standard=${check.frameworks?.includes('wordpress') ? 'WordPress' : 'PSR12'}`,
        ...files,
      ];
    case 'phpstan':
      return [check.entry, 'analyse', '--no-progress', '--error-format=json', ...files];
    default:
      throw qualityError('unsupported', 'unsupported quality command');
  }
}
function allowDebt(check, findings, plan) {
  if (plan.config.strictness !== 'adopt') return { findings, debtCount: 0 };
  const changed = new Set([
      ...(plan.changedPaths ?? check.files),
      ...plan.affectedPaths,
      ...(plan.actualChangedPaths ?? []),
    ]),
    hashes = new Map(plan.files.map(f => [f.path, f.sha256]));
  let debtCount = 0;
  const used = new Set();
  const remaining = findings.filter(item => {
    const index = plan.config.baseline.findIndex(
      (old, index) =>
        !used.has(index) &&
        !changed.has(item.file) &&
        old.language === check.language &&
        old.capability === check.capability &&
        old.tool === check.tool &&
        old.file === item.file &&
        old.line === item.line &&
        old.ruleId === item.ruleId &&
        old.severity === item.severity &&
        old.fingerprint === item.fingerprint &&
        old.sourceHash === hashes.get(item.file),
    );
    if (index < 0) return true;
    used.add(index);
    debtCount++;
    return false;
  });
  return { findings: remaining, debtCount };
}
async function safeProjectEntrypoint(project, entry) {
  qualityPath(entry);
  const filename = path.join(project, entry);
  await noLinks(filename);
  const info = await lstat(filename);
  if (!info.isFile() || info.nlink > 1 || info.size > 32 * 1024 * 1024)
    throw qualityError('unsafe_path', 'unsafe quality project executable');
  return sha256(await readFile(filename));
}
function typeScriptConfigContent(check, plan) {
  return (
    JSON.stringify({
      extends: path.join(plan.project, check.manifest),
      files: check.files.map(file => path.join(plan.project, file)),
      include: [],
      exclude: [],
      // Roots are already inventoried. Never let imports/references expand the
      // compiler program beyond the source hashes bound into this receipt.
      compilerOptions: {
        noResolve: true,
        types: [],
        typeRoots: [],
        noEmit: true,
        noCheck: false,
        skipLibCheck: false,
        skipDefaultLibCheck: false,
        incremental: false,
        composite: false,
        declaration: false,
        declarationMap: false,
        emitDeclarationOnly: false,
      },
    }) + '\n'
  );
}
async function intactTypeScriptConfig(item, check, plan, evidenceRoot) {
  if (!item || path.dirname(item.path) !== evidenceRoot) return false;
  await noLinks(item.path);
  const info = await lstat(item.path);
  if (!info.isFile() || info.nlink > 1 || info.size > 4 * 1024 * 1024) return false;
  const content = await readFile(item.path),
    expected = typeScriptConfigContent(check, plan);
  return content.length === item.bytes && sha256(content) === item.sha256 && content.toString('utf8') === expected;
}
// oxlint-disable-next-line max-lines-per-function, complexity -- debt: docs/kodo-roadmap/MAINTAINABILITY-PLAN.md
export async function runQuality(options = {}) {
  const {
    project = process.cwd(),
    runner = execute,
    resolve = resolveTool,
    nativeResolve = nativeTool,
    signal,
  } = options;
  const plan = await new QualityProfileRegistry().plan(project, options),
    start = performance.now(),
    receipts = [];
  // SQL format/lint deliberately use the same read-only SQLFluff invocation.
  // Share only exact commands within this run; capabilities still evaluate their
  // own findings/debt and retain separate receipts. This is not a cross-run cache.
  const sqlObservations = new Map();
  const timeoutMs = options.timeoutMs ?? plan.config.timeoutMs,
    maxOutputBytes = options.maxOutputBytes ?? plan.config.maxOutputBytes;
  if (
    !Number.isInteger(timeoutMs) ||
    timeoutMs < 1 ||
    timeoutMs > 1800000 ||
    !Number.isInteger(maxOutputBytes) ||
    maxOutputBytes < 1 ||
    maxOutputBytes > 16 * 1024 * 1024
  )
    throw qualityError('configuration', 'invalid quality deadline or output limit');
  const evidenceRoot = await privateDirectory(options.evidenceDir ?? path.join(stateHome(), 'quality'), plan.project);
  const env = environment(evidenceRoot);
  const secrets = Object.fromEntries(
    Object.entries(process.env).filter(([name]) =>
      /(?:API[_-]?KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|DATABASE_URL)/i.test(name),
    ),
  );
  const clean = value => redact(value, secrets);
  let headSha = null,
    headError;
  const head = async () => {
    const result = await execute('git', ['rev-parse', '--verify', 'HEAD'], {
      cwd: plan.project,
      signal,
      timeoutMs: Math.min(timeoutMs, 10000),
      maxOutputBytes: 1024,
    });
    const value = result.stdout.trim();
    if (!/^[a-f0-9]{40,64}$/.test(value))
      throw qualityError('git_head_required', 'valid Git HEAD required for quality receipts');
    return value;
  };
  try {
    headSha = await head();
    const git = async args => {
      const output = await execute('git', args, {
        cwd: plan.project,
        signal,
        timeoutMs: Math.min(timeoutMs, 10000),
        maxOutputBytes: 2 * 1024 * 1024,
      });
      return output.stdout;
    };
    const prefix = (await git(['rev-parse', '--show-prefix'])).trim();
    const tracked = new Set(
      (await git(['ls-tree', '-r', '--full-tree', '--name-only', '-z', 'HEAD', '--', '.']))
        .split('\0')
        .filter(Boolean)
        .map(name => (name.startsWith(prefix) ? name.slice(prefix.length) : null))
        .filter(Boolean),
    );
    const modified = new Set(
      (await git(['diff', '--name-only', '--relative', '-z', 'HEAD', '--', '.'])).split('\0').filter(Boolean),
    );
    plan.actualChangedPaths = plan.files
      .filter(file => !tracked.has(file.path) || modified.has(file.path))
      .map(file => file.path);
  } catch (error) {
    headError = error.code === 'cancelled' ? 'cancelled' : 'git_head_required';
  }
  for (const check of plan.checks) {
    const began = performance.now(),
      logs = [];
    let capturedBytes = 0;
    const receipt = {
      schemaVersion: 1,
      id: check.id,
      language: check.language,
      capability: check.capability,
      tool: check.tool,
      version: check.version,
      status: check.status,
      reason: check.reason,
      files: check.files,
      scopeReason: check.scopeReason,
      headSha,
      configHash: plan.configHash,
      sourceHash: plan.sourceHash,
      pinsHash: pinsHash(check, plan),
      findings: [],
      debtCount: 0,
      durationMs: 0,
      evidence: [],
    };
    receipts.push(receipt);
    const call = async (command, args, overrides = {}) => {
      signal?.throwIfAborted();
      const remaining = Math.ceil(timeoutMs - (performance.now() - began));
      if (remaining < 1) throw qualityError('timeout', 'quality check deadline exceeded');
      if (capturedBytes >= maxOutputBytes) throw qualityError('output_limit', 'quality check output budget exhausted');
      const settings = {
        cwd: path.join(plan.project, check.root),
        signal,
        timeoutMs: remaining,
        maxOutputBytes: maxOutputBytes - capturedBytes,
        allowFailure: true,
        env,
        ...overrides,
      };
      const sharedKey =
        check.tool === 'sqlfluff' && !check.configured
          ? sha256(
              JSON.stringify({
                command,
                args,
                cwd: settings.cwd,
                env: settings.env,
                toolIdentity: receipt.toolIdentity,
                version: check.version,
                files: check.files,
                sourceHash: plan.sourceHash,
                configHash: plan.configHash,
                headSha,
              }),
            )
          : null;
      const observation = sharedKey ? sqlObservations.get(sharedKey) : undefined;
      if (observation) {
        receipt.reusedFrom = [...new Set([...(receipt.reusedFrom ?? []), observation.id])];
        logs.push({
          stage: overrides.stage ?? 'check',
          reusedFrom: observation.id,
          durationMs: 0,
          observationHash: observation.hash,
        });
        if (observation.error) throw observation.error;
        return structuredClone(observation.output);
      }
      const callStart = performance.now();
      try {
        const output = await runner(command, args, settings);
        // A dependency-injected process port must honor the same complete contract.
        if (
          !output ||
          typeof output.stdout !== 'string' ||
          typeof output.stderr !== 'string' ||
          !Number.isInteger(output.code)
        )
          throw qualityError('invalid_output', 'incomplete quality process result');
        capturedBytes += Buffer.byteLength(output.stdout) + Buffer.byteLength(output.stderr);
        if (capturedBytes > maxOutputBytes || output.outputTruncated)
          throw Object.assign(qualityError('output_limit', 'quality output exceeded limit'), { result: output });
        logs.push(
          clean({
            stage: overrides.stage ?? 'check',
            command,
            args,
            durationMs: performance.now() - callStart,
            ...output,
          }),
        );
        signal?.throwIfAborted();
        if (sharedKey)
          sqlObservations.set(sharedKey, { id: receipt.id, output, hash: sha256(JSON.stringify(clean(output))) });
        return output;
      } catch (error) {
        if (error.result) {
          const output = clean(error.result),
            available = Math.max(
              0,
              maxOutputBytes -
                logs.reduce(
                  (total, row) => total + Buffer.byteLength(row.stdout ?? '') + Buffer.byteLength(row.stderr ?? ''),
                  0,
                ),
            );
          const stdout = Buffer.from(output.stdout ?? '')
              .subarray(0, available)
              .toString('utf8'),
            stderr = Buffer.from(output.stderr ?? '')
              .subarray(0, Math.max(0, available - Buffer.byteLength(stdout)))
              .toString('utf8');
          logs.push({
            stage: overrides.stage ?? 'check',
            command: clean(command),
            args: clean(args),
            durationMs: performance.now() - callStart,
            ...output,
            stdout,
            stderr,
          });
        }
        if (sharedKey)
          sqlObservations.set(sharedKey, {
            id: receipt.id,
            error,
            hash: sha256(JSON.stringify(clean({ code: error.code ?? 'process_failed', result: error.result ?? null }))),
          });
        throw error;
      }
    };
    try {
      if (check.status !== 'applicable') continue;
      if (headError) throw qualityError(headError, headError);
      signal?.throwIfAborted();
      if (sha256(JSON.stringify(await qualityInventory(plan.project))) !== plan.sourceHash)
        throw qualityError('source_mutation', 'source changed since quality plan');
      let tool;
      if (managed.has(check.tool)) {
        tool = await resolve(check.tool, {
          project: plan.project,
          home: options.toolHome,
          platform: options.platform,
          arch: options.arch,
        });
        if (!tool?.ready || tool.status !== 'ready')
          throw qualityError(
            ['missing', 'unsupported'].includes(tool?.status) ? tool.status : 'tool_integrity',
            'managed quality tool is not ready',
          );
        if (
          tool.id !== check.tool ||
          tool.version !== check.version ||
          typeof tool.command !== 'string' ||
          !Array.isArray(tool.args) ||
          tool.args.some(a => typeof a !== 'string')
        )
          throw qualityError('tool_integrity', 'invalid managed tool port');
      } else tool = await nativeResolve(['phpcs', 'phpstan'].includes(check.tool) ? 'php' : check.tool);
      receipt.binaryHash = tool.binaryHash ?? null;
      receipt.toolIdentity = await toolIdentity(tool);
      if (check.tool === 'go' && check.capability === 'typecheck')
        await mkdir(path.join(evidenceRoot, 'go-output'), { recursive: true, mode: 0o700 });
      const toolEnv = { ...env, ...tool.env },
        prefix = tool.args ?? [];
      if (check.tool === 'go' && !check.configured) {
        // Native resolver additions cannot reopen workspaces, user GOENV,
        // overlays, downloads or external module caches after sanitization.
        const fixed = [
          'GOENV',
          'GOWORK',
          'GO111MODULE',
          'GOTOOLCHAIN',
          'GOPROXY',
          'GOSUMDB',
          'GOPATH',
          'GOCACHE',
          'GOMODCACHE',
          'GOFLAGS',
        ];
        // Windows environment names are case-insensitive.
        for (const key of Object.keys(toolEnv)) if (fixed.includes(key.toUpperCase())) delete toolEnv[key];
        for (const key of fixed) toolEnv[key] = env[key];
        toolEnv.GOFLAGS = `-mod=${check.goModuleMode}`;
      }
      if (check.tool === 'cargo') {
        const rustc = await nativeResolve('rustc');
        const compiler = await call(rustc.command, [...(rustc.args ?? []), '--version'], { stage: 'version' });
        if (
          compiler.code !== 0 ||
          compiler.stderr.trim() ||
          !validVersion('rustc', compiler.stdout, check.rustcVersion)
        )
          throw qualityError('version_mismatch', 'Rust compiler version mismatch');
        receipt.compilerIdentity = await toolIdentity(rustc);
        if (check.capability === 'lint') {
          const clippy = await call(tool.command, [...prefix, 'clippy', '--version'], {
            env: toolEnv,
            stage: 'version',
          });
          if (clippy.code !== 0 || clippy.stderr.trim() || !validVersion('clippy', clippy.stdout, check.clippyVersion))
            throw qualityError('version_mismatch', 'Clippy version mismatch');
        }
      }
      if (['phpcs', 'phpstan'].includes(check.tool)) {
        const php = await call(tool.command, [...prefix, '--version'], { env: toolEnv, stage: 'version' });
        if (php.code !== 0 || php.stderr.trim() || !validVersion('php', php.stdout, check.phpVersion))
          throw qualityError('version_mismatch', 'PHP runtime version mismatch');
        receipt.entryHash = await safeProjectEntrypoint(
          plan.project,
          (check.root ? check.root + '/' : '') + check.entry,
        );
      }
      if (check.configured && ['node', 'php'].includes(check.tool)) {
        receipt.entryHash = await safeProjectEntrypoint(plan.project, check.configured.args[0].replace(/^\.\//, ''));
      }
      if (check.configured)
        for (const arg of check.configured.args) {
          const value = arg.startsWith('-') && arg.includes('=') ? arg.slice(arg.indexOf('=') + 1) : arg;
          if (value.includes('/') || value.includes('\\') || value.includes(':')) {
            const name = value.replace(/^\.\//, '');
            qualityPath(name);
            if (!plan.files.some(f => f.path === name))
              throw qualityError('unsafe_path', 'configured quality command path is outside its source scope');
          }
        }
      let version;
      if (check.tool === 'gofmt') {
        const go = await nativeResolve('go');
        version = await call(go.command, [...(go.args ?? []), 'version', tool.command], { stage: 'version' });
        const expected = `${tool.command}: go${check.version}`;
        const observed = version.stdout.replace(/\r?\n$/, '');
        if (version.code !== 0 || version.stderr.trim() || /[\r\n\0]/.test(observed) || observed !== expected)
          throw qualityError('version_mismatch', 'gofmt binary version mismatch');
      } else {
        const versionArgs = ['phpcs', 'phpstan'].includes(check.tool)
          ? [check.entry, '--version']
          : check.tool === 'go'
            ? ['version']
            : ['--version'];
        version = await call(tool.command, [...prefix, ...versionArgs], { env: toolEnv, stage: 'version' });
        if (
          version.code !== 0 ||
          version.stderr.trim() ||
          (check.configured
            ? version.stdout.trim() !== check.configured.versionOutput
            : !validVersion(check.tool, version.stdout, check.version))
        )
          throw qualityError('version_mismatch', 'exact quality tool version mismatch');
      }
      receipt.actualVersion = check.version;
      let executionCheck = check;
      if (check.tool === 'typescript' && !check.configured) {
        const content = typeScriptConfigContent(check, plan),
          filename = path.join(evidenceRoot, `typescript-${sha256(check.id).slice(0, 12)}.json`);
        await writeFile(filename, content, { flag: 'wx', mode: 0o400 });
        receipt.typecheckConfig = { path: filename, sha256: sha256(content), bytes: Buffer.byteLength(content) };
        executionCheck = { ...check, typecheckConfig: receipt.typecheckConfig };
        if (!(await intactTypeScriptConfig(receipt.typecheckConfig, check, plan, evidenceRoot)))
          throw qualityError('typecheck_config_integrity', 'private TypeScript config changed');
      }
      const groups =
        check.tool === 'php' && !check.configured
          ? check.files.map(file => ({ ...check, files: [file] }))
          : [executionCheck];
      let successful = true;
      for (const group of groups) {
        const output = await call(tool.command, [...prefix, ...argumentsFor(group, evidenceRoot, plan)], {
          env: toolEnv,
        });
        let parsed = parseQualityOutput(group, output, plan.project);
        const debt = allowDebt(check, parsed.findings, plan);
        receipt.findings.push(...debt.findings);
        receipt.debtCount += debt.debtCount;
        // Only known diagnostic exit codes with fully matched old observations
        // may be adopted. Crashes and arbitrary nonzero codes never become PASS.
        const diagnosticExitCodes = {
          oxlint: [1],
          stylelint: [2],
          'html-validate': [1],
          sqlfluff: [1],
          phpcs: [1, 2],
          phpstan: [1],
        };
        const baselined =
          parsed.findings.length > 0 &&
          debt.findings.length === 0 &&
          diagnosticExitCodes[check.tool]?.includes(output.code);
        successful &&= (parsed.clean && output.code === 0) || baselined;
      }
      receipt.status = successful ? 'passed' : 'failed';
      if (!successful) receipt.reason = receipt.findings.length ? 'violations' : 'tool_failed';
    } catch (error) {
      const code = signal?.aborted
        ? 'cancelled'
        : error.result?.outputTruncated
          ? 'output_limit'
          : (error.code ?? 'process_failed');
      receipt.status = ['missing', 'unsupported'].includes(code) ? code : 'blocked';
      receipt.reason = code === 'ENOENT' ? 'missing' : code;
    } finally {
      if (check.status === 'applicable') {
        try {
          if (
            receipt.typecheckConfig &&
            !(await intactTypeScriptConfig(receipt.typecheckConfig, check, plan, evidenceRoot))
          ) {
            receipt.status = 'blocked';
            receipt.reason = 'typecheck_config_integrity';
          } else if (sha256(JSON.stringify(await qualityInventory(plan.project))) !== plan.sourceHash) {
            receipt.status = 'blocked';
            receipt.reason = 'source_mutation';
          } else if (!headError && (await head()) !== headSha) {
            receipt.status = 'blocked';
            receipt.reason = 'head_mutation';
          }
        } catch (error) {
          receipt.status = 'blocked';
          receipt.reason = signal?.aborted ? 'cancelled' : (error.code ?? 'source_mutation');
        }
      }
      receipt.durationMs = performance.now() - began;
      if (!resultStates.has(receipt.status)) {
        receipt.status = 'blocked';
        receipt.reason = 'incomplete_receipt';
      }
      const content = JSON.stringify(clean({ ...receipt, evidence: undefined, logs })) + '\n';
      const filename = path.join(
        evidenceRoot,
        `${String(receipts.length).padStart(4, '0')}-${sha256(check.id).slice(0, 12)}.json`,
      );
      try {
        await writeFile(filename, content, { flag: 'wx', mode: 0o600 });
        receipt.evidence = [{ path: filename, sha256: sha256(content), bytes: Buffer.byteLength(content) }];
      } catch {
        receipt.status = 'blocked';
        receipt.reason = 'evidence_write_failed';
      }
    }
  }
  const status = receipts.some(r => ['blocked', 'missing', 'unsupported'].includes(r.status))
    ? 'blocked'
    : receipts.some(r => r.status === 'failed')
      ? 'failed'
      : receipts.some(r => r.status === 'passed')
        ? 'passed'
        : plan.config.enabled
          ? 'skipped'
          : 'disabled';
  return clean({
    schemaVersion: 1,
    status,
    passed: status === 'passed' ? true : ['failed', 'blocked'].includes(status) ? false : null,
    durationMs: performance.now() - start,
    headSha,
    configHash: plan.configHash,
    sourceHash: plan.sourceHash,
    evidenceRoot,
    plan,
    receipts,
  });
}

/** Current-head validation is for callers reusing a receipt; Engine is unchanged. */
// oxlint-disable-next-line complexity -- debt: docs/kodo-roadmap/MAINTAINABILITY-PLAN.md
export async function isCurrentQualityReceipt(
  report,
  { project, runner = execute, resolve = resolveTool, nativeResolve = nativeTool, toolHome } = {},
) {
  try {
    if (
      report?.schemaVersion !== 1 ||
      report.status !== 'passed' ||
      report.passed !== true ||
      !Array.isArray(report.receipts) ||
      !report.receipts.some(r => r.status === 'passed')
    )
      return false;
    const plan = await new QualityProfileRegistry().plan(project ?? report.plan.project, {
      mode: report.plan.mode,
      changedPaths: report.plan.changedPaths,
      affectedPaths: report.plan.affectedPaths,
      capabilities: report.plan.selectedCapabilities,
    });
    if (plan.configHash !== report.configHash || plan.sourceHash !== report.sourceHash) return false;
    const head = await runner('git', ['rev-parse', '--verify', 'HEAD'], {
      cwd: plan.project,
      timeoutMs: 10000,
      maxOutputBytes: 1024,
    });
    if (head.code !== 0 || head.stdout.trim() !== report.headSha || plan.checks.length !== report.receipts.length)
      return false;
    await noLinks(report.evidenceRoot);
    const evidenceRoot = await realpath(report.evidenceRoot);
    if (inside(plan.project, evidenceRoot) || inside(evidenceRoot, plan.project)) return false;
    for (const [index, row] of report.receipts.entries()) {
      const check = plan.checks[index];
      if (
        row.id !== check.id ||
        row.tool !== check.tool ||
        row.version !== check.version ||
        row.pinsHash !== pinsHash(check, plan) ||
        JSON.stringify(row.files) !== JSON.stringify(check.files)
      )
        return false;
      if (
        !resultStates.has(row.status) ||
        ['blocked', 'failed', 'missing', 'unsupported'].includes(row.status) ||
        row.evidence.length !== 1
      )
        return false;
      const item = row.evidence[0];
      await noLinks(item.path);
      const evidencePath = await realpath(item.path);
      if (!inside(evidenceRoot, evidencePath)) return false;
      const content = await readFile(evidencePath);
      if (sha256(content) !== item.sha256 || content.length !== item.bytes) return false;
      const stored = JSON.parse(content);
      const { logs, ...storedReceipt } = stored,
        { evidence, ...suppliedReceipt } = row;
      if (
        JSON.stringify(storedReceipt) !== JSON.stringify(suppliedReceipt) ||
        stored.headSha !== report.headSha ||
        stored.sourceHash !== report.sourceHash ||
        stored.configHash !== report.configHash
      )
        return false;
      if (row.status === 'passed') {
        if (
          check.tool === 'typescript' &&
          !check.configured &&
          !(await intactTypeScriptConfig(row.typecheckConfig, check, plan, evidenceRoot))
        )
          return false;
        const tool = managed.has(check.tool)
          ? await resolve(check.tool, { project: plan.project, home: toolHome })
          : await nativeResolve(['phpcs', 'phpstan'].includes(check.tool) ? 'php' : check.tool);
        if (
          (managed.has(check.tool) && (!tool.ready || tool.status !== 'ready')) ||
          (await toolIdentity(tool)) !== row.toolIdentity
        )
          return false;
        if (row.compilerIdentity && (await toolIdentity(await nativeResolve('rustc'))) !== row.compilerIdentity)
          return false;
        if (
          row.entryHash &&
          (await safeProjectEntrypoint(
            plan.project,
            check.configured?.args[0].replace(/^\.\//, '') ?? (check.root ? check.root + '/' : '') + check.entry,
          )) !== row.entryHash
        )
          return false;
      }
    }
    return true;
  } catch {
    return false;
  }
}
