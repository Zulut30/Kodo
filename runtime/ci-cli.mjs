/** Offline CI orchestration. Graph/profiler remain separate frozen ports;
 * no provider, credential store, delivery or cached PASS startup here.
 */
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { access } from 'node:fs/promises';
import { execute } from './command.mjs';
import { redact, workerEnvironment } from './security.mjs';

export const ciHelp =
  'kodo ci plan|run|profile [--tier L0|L1|L2|L3] [--base SHA] [--project PATH] [--json]\nkodo ci feedback --base SHA [--tier L1] [--project PATH] [--json]';
const shaOK = value => typeof value === 'string' && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value);
const fail = reason => Object.assign(new Error(reason), { code: reason });
const tiers = ['L0', 'L1', 'L2', 'L3'];
export function parseCiArgs(argv) {
  const [action, ...args] = argv;
  if (!['plan', 'run', 'profile', 'feedback'].includes(action)) throw fail('arguments');
  const options = { project: process.cwd(), tier: 'L1' },
    seen = new Set();
  let json = false;
  for (let i = 0; i < args.length; i++) {
    const flag = args[i];
    if (!['--tier', '--base', '--project', '--json'].includes(flag) || seen.has(flag)) throw fail('arguments');
    seen.add(flag);
    if (flag === '--json') {
      json = true;
      continue;
    }
    const value = args[++i];
    if (!value || value.startsWith('-')) throw fail('arguments');
    if (flag === '--tier') {
      if (!tiers.includes(value)) throw fail('arguments');
      options.tier = value;
    }
    if (flag === '--base') {
      if (!shaOK(value)) throw fail('arguments');
      options.baseSha = value;
    }
    if (flag === '--project') options.project = path.resolve(value);
  }
  if (action === 'feedback' && options.tier !== 'L1') throw fail('arguments');
  if (['L0', 'L1'].includes(options.tier) && !options.baseSha) throw fail('base_required');
  return { action, options, json };
}

function safePath(name) {
  if (
    typeof name !== 'string' ||
    !name ||
    name.startsWith('-') ||
    /[\\:]/.test(name) ||
    [...name].some(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127) ||
    path.isAbsolute(name) ||
    name.split('/').some(part => !part || part === '.' || part === '..')
  )
    throw fail('invalid_graph');
  return name;
}
function validateGraph(graph) {
  if (
    graph?.schemaVersion !== 1 ||
    typeof graph.fallback !== 'boolean' ||
    !Array.isArray(graph.reasons) ||
    !graph.reasons.every(r => typeof r === 'string') ||
    typeof graph.sourceHash !== 'string' ||
    typeof graph.dependencyHash !== 'string'
  )
    throw fail('invalid_graph');
  for (const key of ['changedFiles', 'affectedFiles', 'testFiles']) {
    if (!Array.isArray(graph[key]) || graph[key].length > 100000) throw fail('invalid_graph');
    graph[key].forEach(safePath);
    if (new Set(graph[key]).size !== graph[key].length) throw fail('invalid_graph');
  }
  // Naming conventions belong to the graph. Node also discovers generic
  // files under test/ and TypeScript; never narrow that public contract here.
  if (graph.testFiles.some(name => !graph.affectedFiles.includes(name))) throw fail('invalid_graph');
  return graph;
}
async function currentHead(project, dependencies) {
  const value = dependencies.head
    ? await dependencies.head(project)
    : (await execute('git', ['rev-parse', '--verify', 'HEAD'], { cwd: project, timeoutMs: 10000 })).stdout.trim();
  if (!shaOK(value)) throw fail('invalid_head');
  return value;
}
async function sourceState(project, headSha, dependencies) {
  try {
    const value = dependencies.sourceState
      ? await dependencies.sourceState(project)
      : await (await import('./ci-graph.mjs')).inspectCurrentSource({ project, headSha });
    return ['clean', 'dirty'].includes(value) ? value : 'unknown';
  } catch {
    return 'unknown';
  }
}
async function affected(options, dependencies) {
  const plan = dependencies.planAffected ?? (await import('./ci-graph.mjs')).planAffected;
  if (typeof plan !== 'function') throw fail('graph_contract');
  return validateGraph(await plan(options));
}
async function workingChanges(project, dependencies, signal) {
  const run = dependencies.execute ?? execute;
  const paths = [];
  for (const args of [
    ['diff', '--name-only', '--relative', '-z', 'HEAD', '--', '.'],
    ['ls-files', '--others', '--exclude-standard', '-z', '--', '.'],
  ]) {
    const result = await run('git', args, { cwd: project, signal, timeoutMs: 10000, rawOutput: true });
    if (result.code !== 0 || typeof result.stdout !== 'string') throw fail('changed_paths');
    paths.push(...result.stdout.split('\0').filter(Boolean));
  }
  return [...new Set(paths)].sort().map(safePath);
}

export async function planCi(options, dependencies = {}) {
  const { tier = 'L1', baseSha } = options,
    project = path.resolve(options.project ?? process.cwd());
  if (!tiers.includes(tier) || (options.feedback && tier !== 'L1') || (baseSha !== undefined && !shaOK(baseSha)))
    throw fail('arguments');
  if (['L0', 'L1'].includes(tier) && !baseSha) throw fail('base_required');
  const headSha = await currentHead(project, dependencies);
  const report = {
    schemaVersion: 1,
    tier,
    project,
    baseSha: baseSha ?? null,
    headSha,
    status: 'planned',
    platform: process.platform,
    requiredPlatforms: tier === 'L2' ? ['linux', 'win32'] : [process.platform],
    crossPlatformVerified: false,
    deploymentVerified: false,
    commands: [],
  };
  if (tier === 'L0' || tier === 'L1') {
    report.graph = await affected(
      {
        project,
        baseSha,
        headSha,
        ...(options.feedback ? { changedPaths: await workingChanges(project, dependencies, options.signal) } : {}),
      },
      dependencies,
    );
    if (options.feedback) {
      report.requiresFullCheck = true;
      report.deferredChecks = [
        ...(report.graph.fallback
          ? [
              {
                phase: 'tests',
                status: 'deferred',
                reason: 'affected_graph_fallback',
                tier: 'L2',
                headSha,
                ambiguityReasonCount: report.graph.reasons.length,
              },
            ]
          : []),
        { phase: 'fullcheck', status: 'required', tier: 'L2', headSha, platforms: ['linux', 'win32'] },
      ];
    }
    const registry = dependencies.qualityRegistry ?? new (await import('./quality.mjs')).QualityProfileRegistry();
    const capabilities = tier === 'L0' ? ['format', 'lint'] : ['lint', 'typecheck'];
    // Deleted/excluded paths cannot be passed to the quality inventory. The
    // graph retains them for reverse dependency/fallback decisions.
    const inventory = await registry.detect(project),
      names = new Set(inventory.files.map(row => row.path));
    const scope =
      tier === 'L0' || (options.feedback && report.graph.fallback)
        ? report.graph.changedFiles
        : report.graph.affectedFiles;
    const broad = report.graph.fallback && !options.feedback;
    const qualityOptions = {
      project,
      capabilities,
      mode: broad ? 'standard' : 'quick',
      ...(broad ? {} : { changedPaths: scope.filter(name => names.has(name)) }),
    };
    report.quality = await registry.plan(project, qualityOptions);
    report.qualityOptions = qualityOptions;
    if (tier === 'L1') {
      for (const file of (options.feedback ? scope : report.graph.affectedFiles).filter(
        name => names.has(name) && /\.[cm]?js$/.test(name),
      ))
        report.commands.push({ phase: 'syntax', command: process.execPath, args: ['--check', file] });
      if ((!options.feedback || !report.graph.fallback) && (report.graph.fallback || report.graph.testFiles.length))
        report.commands.push({
          phase: 'tests',
          command: process.execPath,
          args: ['--test', ...(report.graph.fallback ? [] : report.graph.testFiles)],
        });
    }
  } else if (tier === 'L2') {
    report.commands.push({ phase: 'fullcheck', command: 'npm', args: ['run', 'check'] });
    report.security = { required: true, reuse: false, autoInstall: false };
  } else
    report.commands.push({ phase: 'package-smoke', command: process.execPath, args: ['scripts/package-smoke.mjs'] });
  return report;
}

function qualityState(report) {
  if (!Array.isArray(report?.receipts)) return 'blocked';
  if (report.receipts.some(row => row.status === 'failed') || report.status === 'failed') return 'failed';
  if (['missing', 'unsupported', 'blocked', 'disabled'].includes(report.status)) return 'blocked';
  if (report.receipts.some(row => !['passed', 'not_applicable', 'skipped'].includes(row.status))) return 'blocked';
  // Scope exclusions stay visible and neutral; any other skip is incomplete.
  if (report.receipts.some(row => row.status === 'skipped' && row.reason !== 'no_changed_or_affected_source'))
    return 'blocked';
  if (report.receipts.some(row => row.status === 'passed') && report.status === 'passed') return 'passed';
  return ['disabled', 'missing', 'unsupported', 'blocked', 'skipped'].includes(report.status) &&
    !report.receipts.every(row => row.status === 'not_applicable' || row.reason === 'no_changed_or_affected_source')
    ? 'blocked'
    : 'not_applicable';
}
async function security(options, dependencies) {
  if (dependencies.security) return dependencies.security(options);
  const { readConfig } = await import('./config.mjs');
  const { runSecurityChecks, isCurrentSecurityReceipt } = await import('./security-gates.mjs');
  const selected = (await readConfig(options.project)).security;
  // L2 never installs optional tools implicitly and never accepts disabled gates.
  if (!selected.enabled) return { status: 'disabled', passed: null };
  const config = { ...selected, autoInstall: false };
  const receipt = await runSecurityChecks({
    cwd: options.project,
    headSha: options.headSha,
    config,
    artifacts: options.evidenceDir,
    signal: options.signal,
  });
  if (receipt.status === 'passed' && !isCurrentSecurityReceipt(receipt, { headSha: options.headSha, config }))
    return { ...receipt, status: 'blocked', passed: false, reason: 'stale_security' };
  return receipt;
}

function redactDiagnosticOutput(text, secrets) {
  // Sweep original ranges before replacing: sequential replacement can destroy
  // crossing/prefix matches and expose a suffix. Keep one pending match per
  // known value, including overlapping occurrences of the same value.
  const pending = [...new Set(Object.values(secrets))]
    .filter(value => typeof value === 'string' && value.length > 5 && value.length <= text.length)
    .map(value => ({ value, index: text.indexOf(value) }))
    .filter(match => match.index >= 0);
  const parts = [];
  let cursor = 0,
    start = -1,
    end = 0;
  const flush = () => {
    if (start >= 0) {
      parts.push(text.slice(cursor, start), '[REDACTED]');
      cursor = end;
    }
  };
  while (pending.length) {
    let next = 0;
    for (let index = 1; index < pending.length; index++) if (pending[index].index < pending[next].index) next = index;
    const match = pending[next];
    if (start < 0 || match.index > end) {
      flush();
      start = match.index;
      end = match.index + match.value.length;
    } else end = Math.max(end, match.index + match.value.length);
    match.index = text.indexOf(match.value, match.index + 1);
    if (match.index < 0) pending.splice(next, 1);
  }
  flush();
  return redact(parts.length ? parts.join('') + text.slice(cursor) : text);
}

function failureDiagnostic(result, secrets) {
  const diagnostic = {};
  for (const stream of ['stdout', 'stderr']) {
    // Redact the entire capture before cutting: a credential may cross the
    // tail boundary. Advance past UTF-8 continuation bytes to retain valid text.
    const bytes = Buffer.from(
      redactDiagnosticOutput(typeof result[stream] === 'string' ? result[stream] : '', secrets),
    );
    let start = Math.max(0, bytes.length - 4096);
    while (start < bytes.length && (bytes[start] & 0xc0) === 0x80) start++;
    diagnostic[`${stream}Tail`] = bytes.subarray(start).toString('utf8');
    diagnostic[`${stream}Truncated`] = start > 0;
  }
  return diagnostic;
}

export async function runCi(options, dependencies = {}) {
  const plan = await planCi(options, dependencies),
    receipts = [],
    began = performance.now();
  const evidenceDir = options.evidenceDir ?? path.join(os.tmpdir(), 'kodo-ci-evidence', randomUUID());
  const common = { cwd: plan.project, env: workerEnvironment(), signal: options.signal, timeoutMs: 1200000 };
  const secrets = Object.fromEntries(Object.entries(process.env).filter(([name]) => !(name in common.env)));
  if (options.signal?.aborted)
    return {
      ...plan,
      status: 'blocked',
      complete: false,
      durationMs: performance.now() - began,
      receipts: [{ phase: 'run', status: 'blocked', reason: 'cancelled' }],
    };
  const requiresCleanSource = !options.feedback && ['L1', 'L2', 'L3'].includes(plan.tier);
  if (requiresCleanSource) {
    const state = await sourceState(plan.project, plan.headSha, dependencies);
    if (state !== 'clean')
      return {
        ...plan,
        status: 'blocked',
        complete: false,
        durationMs: performance.now() - began,
        receipts: [
          { phase: 'source', status: 'blocked', reason: state === 'dirty' ? 'dirty_worktree' : 'source_unavailable' },
        ],
      };
  }
  if (plan.quality) {
    const qualityRunner = dependencies.runQuality ?? (await import('./quality-runner.mjs')).runQuality;
    const quality = await qualityRunner({ ...plan.qualityOptions, evidenceDir, signal: options.signal });
    receipts.push({ phase: 'quality', status: qualityState(quality), report: quality });
  }
  for (const command of plan.commands) {
    if (options.signal?.aborted) break;
    const start = performance.now();
    try {
      let result;
      if (options.profile || !dependencies.execute) {
        const profile = dependencies.runProfiledCommand ?? (await import('./ci-profiler.mjs')).runProfiledCommand;
        if (typeof profile !== 'function') throw fail('profiler_contract');
        const args = [...command.args];
        if (options.profile && command.phase === 'tests') {
          const reporter = new URL('../scripts/ci-reporter.mjs', import.meta.url);
          // Installed packages may omit development scripts; missing reporter
          // leaves test-file observations unknown rather than inventing timings.
          try {
            await access(reporter);
            args.splice(
              1,
              0,
              `--test-reporter=${reporter.href}`,
              '--test-reporter=tap',
              '--test-reporter-destination=stdout',
              '--test-reporter-destination=stdout',
            );
          } catch (error) {
            if (error.code !== 'ENOENT') throw error;
          }
        }
        const phase = { syntax: 'quality', tests: 'unit', fullcheck: 'integration', 'package-smoke': 'package' }[
          command.phase
        ];
        result = await profile({
          ...command,
          args,
          ...common,
          redactions: secrets,
          phase,
          evidenceDir,
          tier: plan.tier,
        });
      } else {
        const observation = await (dependencies.execute ?? execute)(command.command, command.args, {
          ...common,
          allowFailure: true,
        });
        result = {
          exitCode: observation.code,
          durationMs: performance.now() - start,
          stdout: observation.stdout,
          stderr: observation.stderr,
        };
      }
      const valid = Number.isInteger(result.exitCode) && result.exitCode >= 0;
      receipts.push({
        ...command,
        status: valid ? (result.exitCode === 0 ? 'passed' : 'failed') : 'blocked',
        exitCode: result.exitCode,
        durationMs: result.durationMs,
        ...(result.profilePath ? { profilePath: result.profilePath } : {}),
        ...(valid && result.exitCode !== 0 ? { diagnostic: failureDiagnostic(result, secrets) } : {}),
      });
    } catch (error) {
      // The profiler attaches captures to infrastructure errors too. Publish
      // only typed metadata and the same redacted byte tails as nonzero exits;
      // a stopped child remains blocked even if its actual exit code was zero.
      receipts.push({
        ...command,
        status: 'blocked',
        reason: ['timeout', 'cancelled', 'invalid_output', 'profiler_contract'].includes(error.code)
          ? error.code
          : 'command_error',
        exitCode: Number.isInteger(error.exitCode) && error.exitCode >= 0 ? error.exitCode : null,
        durationMs:
          Number.isFinite(error.durationMs) && error.durationMs >= 0 ? error.durationMs : performance.now() - start,
        ...(typeof error.outputTruncated === 'boolean' ? { outputTruncated: error.outputTruncated } : {}),
        ...(typeof error.profilePath === 'string' && error.profilePath.length <= 4096
          ? { profilePath: redactDiagnosticOutput(error.profilePath, secrets) }
          : {}),
        ...(typeof error.stdout === 'string' || typeof error.stderr === 'string'
          ? { diagnostic: failureDiagnostic(error, secrets) }
          : {}),
      });
    }
    if (options.signal?.aborted) break;
  }
  if (plan.security && !options.signal?.aborted) {
    const receipt = await security(
      { project: plan.project, headSha: plan.headSha, evidenceDir, signal: options.signal },
      dependencies,
    );
    receipts.push({
      phase: 'security',
      status:
        receipt.status === 'passed' && receipt.passed === true
          ? 'passed'
          : receipt.status === 'failed'
            ? 'failed'
            : 'blocked',
      report: receipt,
    });
  }
  // Detect movement during any check; successful local execution is never a
  // cross-platform, release/deployment or reusable command-cache receipt.
  const unchanged = (await currentHead(plan.project, dependencies)) === plan.headSha;
  if (!unchanged || options.signal?.aborted)
    receipts.push({ phase: 'head', status: 'blocked', reason: unchanged ? 'cancelled' : 'changed_head' });
  if (requiresCleanSource) {
    const state = await sourceState(plan.project, plan.headSha, dependencies);
    if (state !== 'clean')
      receipts.push({
        phase: 'source',
        status: 'blocked',
        reason: state === 'dirty' ? 'dirty_worktree' : 'source_unavailable',
      });
  }
  const status = receipts.some(row => row.status === 'failed')
    ? 'failed'
    : receipts.some(row => row.status === 'blocked')
      ? 'blocked'
      : receipts.some(row => row.status === 'passed')
        ? 'passed'
        : 'not_applicable';
  return {
    ...plan,
    status: options.feedback && status === 'passed' ? 'feedback_ready' : status,
    complete: !options.feedback && status === 'passed',
    ...(options.feedback
      ? {
          codeChecksObserved: receipts.some(
            row => ['quality', 'syntax'].includes(row.phase) && row.status === 'passed',
          ),
        }
      : {}),
    durationMs: performance.now() - began,
    evidenceDir,
    receipts,
  };
}

export async function ciCli(argv, dependencies = {}) {
  const json = argv.includes('--json');
  try {
    const parsed = parseCiArgs(argv);
    const report =
      parsed.action === 'plan'
        ? await planCi(parsed.options, dependencies)
        : await runCi(
            {
              ...parsed.options,
              signal: dependencies.signal,
              profile: parsed.action === 'profile',
              feedback: parsed.action === 'feedback',
            },
            dependencies,
          );
    const exitCode = ['failed', 'blocked'].includes(report.status) ? 1 : 0;
    const output = parsed.json
      ? JSON.stringify(report)
      : [
          `CI ${report.tier}: ${report.status} (${report.platform})`,
          ...(report.receipts ?? report.commands).map(row => `${row.phase}: ${row.status ?? 'planned'}`),
          'Cross-platform and deployment evidence must be collected separately.',
        ].join('\n');
    return { report, exitCode, output };
  } catch (error) {
    const allowed = [
      'arguments',
      'base_required',
      'invalid_graph',
      'invalid_head',
      'graph_contract',
      'profiler_contract',
    ];
    const report = {
      schemaVersion: 1,
      status: 'blocked',
      reason: allowed.includes(error.code)
        ? error.code
        : error.code === 'ERR_MODULE_NOT_FOUND'
          ? 'dependency_missing'
          : 'ci_error',
    };
    return { report, exitCode: 1, output: json ? JSON.stringify(report) : `CI blocked: ${report.reason}\n${ciHelp}` };
  }
}
