/// <reference path="./quality-runner-tools.mjs" />
/** Read-only source checks through the existing owned-process execution port.
 * Configured project commands are trusted executable code, not an OS sandbox.
 * Passing receipts require unchanged inventory/head and intact private evidence.
 */
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { execute as executeProcess } from './delivery.mjs';
import { resolveTool, toolCatalog } from './tools.mjs';
import { inside, noLinks, sha256 } from './toolchains.mjs';
import { redact, stateHome } from './security.mjs';
import { QualityProfileRegistry, qualityError, qualityInventory, qualityPath } from './quality.mjs';
import { parseQualityOutput } from './quality-parsers.mjs';
import {
  managed,
  toolIdentity,
  nativeTool,
  qualityNativeTool,
  privateDirectory,
  environment,
  validVersion,
  argumentsFor,
  safeProjectEntrypoint,
  typeScriptConfigContent,
  intactTypeScriptConfig,
} from './quality-runner-tools.mjs';

export { parseQualityOutput };

/** @typedef {(command: string, args: string[], options: NonNullable<Parameters<typeof executeProcess>[2]> & {cwd: string, signal?: AbortSignal}) => ReturnType<typeof executeProcess>} QualityCommand */
/** @type {QualityCommand} */
const execute = executeProcess;

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
      ...(check.unpinnedToolchain ? { unpinnedToolchain: true } : {}),
    }),
  );
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
/** Shared state of one quality run: plan, limits, private evidence and the checked head. */
async function qualityRunContext(options) {
  const {
    project = process.cwd(),
    runner = execute,
    resolve = resolveTool,
    nativeResolve = nativeTool,
    signal,
  } = options;
  /** @type {Awaited<ReturnType<QualityProfileRegistry['plan']>> & {actualChangedPaths?: string[]}} */
  const plan = await new QualityProfileRegistry().plan(project, options);
  const start = performance.now(),
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
  return {
    options,
    plan,
    start,
    receipts,
    sqlObservations,
    timeoutMs,
    maxOutputBytes,
    evidenceRoot,
    env,
    clean,
    headSha,
    headError,
    head,
    runner,
    resolve,
    nativeResolve,
    signal,
  };
}

/** The bounded process port of one check: shared deadline, output budget and exact SQL reuse. */
function createCheckCall(ctx, check, receipt, logs, began) {
  const { plan, signal, timeoutMs, maxOutputBytes, env, sqlObservations, headSha, runner, clean } = ctx;
  let capturedBytes = 0;
  return async (command, args, overrides = {}) => {
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
}

/** Resolve the managed or native tool, its identity and its sanitized environment. */
async function resolveCheckTool(ctx, check, receipt) {
  const { options, plan, signal, headError, resolve, nativeResolve, evidenceRoot, env } = ctx;
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
  } else tool = await qualityNativeTool(check, nativeResolve);
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
  return { tool, toolEnv, prefix };
}

async function verifyRustCompiler(check, receipt, call, { tool, toolEnv, prefix }, nativeResolve) {
  const rustc = await nativeResolve('rustc');
  const compiler = await call(rustc.command, [...(rustc.args ?? []), '--version'], { stage: 'version' });
  const expectedRustc =
    check.rustcVersion ??
    (check.unpinnedToolchain ? /^rustc (\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?)/.exec(compiler.stdout)?.[1] : null);
  if (
    !expectedRustc ||
    compiler.code !== 0 ||
    compiler.stderr.trim() ||
    !validVersion('rustc', compiler.stdout, expectedRustc)
  )
    throw qualityError('version_mismatch', 'Rust compiler version mismatch');
  receipt.compilerIdentity = await toolIdentity(rustc);
  if (check.capability === 'lint') {
    const clippy = await call(tool.command, [...prefix, 'clippy', '--version'], {
      env: toolEnv,
      stage: 'version',
    });
    const pin = check.clippyVersion ?? /^clippy (\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?)/.exec(clippy.stdout)?.[1];
    if (!pin || clippy.code !== 0 || clippy.stderr.trim() || !validVersion('clippy', clippy.stdout, pin))
      throw qualityError('version_mismatch', 'Clippy version mismatch');
  }
}

/** Exact compiler, runtime and tool versions plus safe configured entrypoints and paths. */
async function verifyCheckRuntime(ctx, check, receipt, call, { tool, toolEnv, prefix }) {
  const { plan, nativeResolve } = ctx;
  if (check.tool === 'cargo') await verifyRustCompiler(check, receipt, call, { tool, toolEnv, prefix }, nativeResolve);
  if (['phpcs', 'phpstan'].includes(check.tool)) {
    const php = await call(tool.command, [...prefix, '--version'], { env: toolEnv, stage: 'version' });
    if (php.code !== 0 || php.stderr.trim() || !validVersion('php', php.stdout, check.phpVersion))
      throw qualityError('version_mismatch', 'PHP runtime version mismatch');
    receipt.entryHash = await safeProjectEntrypoint(plan.project, (check.root ? check.root + '/' : '') + check.entry);
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
  let actualVersion = check.version;
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
    actualVersion =
      check.toolchain && check.tool === 'rustfmt'
        ? /^rustfmt (\d+\.\d+\.\d+)/.exec(version.stdout)?.[1]
        : (check.version ??
          (check.unpinnedToolchain && check.tool === 'cargo'
            ? /^cargo (\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?)/.exec(version.stdout)?.[1]
            : null));
    if (
      !actualVersion ||
      version.code !== 0 ||
      version.stderr.trim() ||
      (check.configured
        ? version.stdout.trim() !== check.configured.versionOutput
        : !validVersion(check.tool, version.stdout, actualVersion))
    )
      throw qualityError('version_mismatch', 'exact quality tool version mismatch');
  }
  receipt.actualVersion = actualVersion;
}

/** Resolve and verify the exact tool, runtimes and entrypoints before a check runs. */
async function prepareCheckTool(ctx, check, receipt, call) {
  const prepared = await resolveCheckTool(ctx, check, receipt);
  await verifyCheckRuntime(ctx, check, receipt, call, prepared);
  return prepared;
}

/** Run the check (per file for native PHP lint) and adopt only fully matched debt. */
async function executeCheckGroups(ctx, check, receipt, call, { tool, toolEnv, prefix }) {
  const { plan, evidenceRoot } = ctx;
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
}

/** Re-verify config, sources and head after a check, then persist its private evidence. */
async function settleCheckReceipt(ctx, check, receipt, logs, began) {
  const { plan, signal, headError, headSha, head, evidenceRoot, receipts, clean } = ctx;
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

async function runQualityCheck(ctx, check) {
  const { plan, headSha, receipts, signal } = ctx;
  const began = performance.now(),
    logs = [];
  const receipt = {
    schemaVersion: 1,
    id: check.id,
    language: check.language,
    capability: check.capability,
    tool: check.tool,
    version: check.version,
    status: check.status,
    reason: check.reason,
    ...(check.unpinnedToolchain ? { unpinnedToolchain: true } : {}),
    ...(check.warnings?.length ? { warnings: [...check.warnings] } : {}),
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
  const call = createCheckCall(ctx, check, receipt, logs, began);
  try {
    if (check.status !== 'applicable') return;
    await executeCheckGroups(ctx, check, receipt, call, await prepareCheckTool(ctx, check, receipt, call));
  } catch (error) {
    const code = signal?.aborted
      ? 'cancelled'
      : error.result?.outputTruncated
        ? 'output_limit'
        : (error.code ?? 'process_failed');
    receipt.status = ['missing', 'unsupported'].includes(code) ? code : 'blocked';
    receipt.reason = code === 'ENOENT' ? 'missing' : code;
  } finally {
    await settleCheckReceipt(ctx, check, receipt, logs, began);
  }
}

export async function runQuality(options = {}) {
  const ctx = await qualityRunContext(options);
  const { plan, receipts, start, headSha, evidenceRoot, clean } = ctx;
  for (const check of plan.checks) await runQualityCheck(ctx, check);
  const status = receipts.some(r => ['blocked', 'missing', 'unsupported'].includes(r.status))
    ? 'blocked'
    : receipts.some(r => r.status === 'failed')
      ? 'failed'
      : receipts.some(r => r.status === 'passed')
        ? 'passed'
        : plan.config.enabled
          ? 'skipped'
          : 'disabled';
  const warnings = [...new Set(receipts.flatMap(r => r.warnings ?? []))];
  return clean({
    schemaVersion: 1,
    status,
    passed: status === 'passed' ? true : ['failed', 'blocked'].includes(status) ? false : null,
    ...(warnings.length ? { warnings } : {}),
    durationMs: performance.now() - start,
    headSha,
    configHash: plan.configHash,
    sourceHash: plan.sourceHash,
    evidenceRoot,
    plan,
    receipts,
  });
}

/** Read HEAD with the arguments and bounds supplied by the receipt validator.
 * @callback ReceiptHeadRunner
 * @param {'git'} command
 * @param {['rev-parse', '--verify', 'HEAD']} args
 * @param {{cwd: string, timeoutMs: 10000, maxOutputBytes: 1024}} options
 * @returns {ReturnType<typeof executeProcess> | Awaited<ReturnType<typeof executeProcess>>}
 */

/** Check a saved receipt against the current Git head and its evidence.
 * @param {Awaited<ReturnType<typeof runQuality>> | null} [report]
 * @param {object} [options]
 * @param {string | null | undefined} [options.project]
 * @param {string | null | undefined} [options.toolHome]
 * @param {ReceiptHeadRunner | undefined} [options.runner]
 * @param {typeof resolveTool | undefined} [options.resolve]
 * @param {typeof nativeTool | undefined} [options.nativeResolve]
 */
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
      report.warnings?.includes('toolchain_unpinned') ||
      !Array.isArray(report.receipts) ||
      !report.receipts.some(r => r.status === 'passed') ||
      report.receipts.some(r => r.unpinnedToolchain === true || r.warnings?.includes('toolchain_unpinned'))
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
        row.unpinnedToolchain === true ||
        row.warnings?.includes('toolchain_unpinned') ||
        check.unpinnedToolchain === true ||
        (row.status === 'passed' && check.status !== 'applicable') ||
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
      const stored = JSON.parse(content.toString('utf8'));
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
        let tool;
        if (managed.has(check.tool)) {
          const resolved = await resolve(check.tool, { project: plan.project, home: toolHome });
          if (!resolved.ready || resolved.status !== 'ready') return false;
          tool = resolved;
        } else {
          tool = await qualityNativeTool(check, nativeResolve);
        }
        if ((await toolIdentity(tool)) !== row.toolIdentity) return false;
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
