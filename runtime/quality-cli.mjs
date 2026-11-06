import path from 'node:path';
import { QualityProfileRegistry, qualityCapabilities, qualityError } from './quality.mjs';
import { runQuality } from './quality-runner.mjs';

export const qualityHelp =
  'kodo quality detect|plan|run [--project PATH] [--json]\nplan/run: [--mode quick|standard|deep] [--changed PATH] [--affected PATH] [--capability format|lint|typecheck|test|security|architecture|release]\nrun: [--evidence-dir PATH] [--timeout-ms N] [--max-output-bytes N]';
export function parseQualityArgs(argv) {
  const [action, ...args] = argv;
  if (!['detect', 'plan', 'run'].includes(action)) throw qualityError('arguments', qualityHelp);
  const values = { project: process.cwd() },
    seen = new Set();
  let json = false;
  for (let index = 0; index < args.length; index++) {
    const flag = args[index];
    const allowed = [
      '--project',
      '--json',
      ...(action === 'detect' ? [] : ['--mode', '--changed', '--affected', '--capability']),
      ...(action === 'run' ? ['--evidence-dir', '--timeout-ms', '--max-output-bytes'] : []),
    ];
    if (!allowed.includes(flag)) throw qualityError('arguments', 'unknown or inapplicable quality option');
    const repeated = ['--changed', '--affected', '--capability'].includes(flag);
    if (seen.has(flag) && !repeated) throw qualityError('arguments', 'duplicate quality option');
    seen.add(flag);
    if (flag === '--json') {
      json = true;
      continue;
    }
    const value = args[++index];
    if (!value || value.startsWith('-')) throw qualityError('arguments', 'quality option requires a value');
    if (flag === '--project') values.project = path.resolve(value);
    if (flag === '--evidence-dir') values.evidenceDir = path.resolve(value);
    if (flag === '--mode') {
      if (!['quick', 'standard', 'deep'].includes(value)) throw qualityError('arguments', 'invalid quality mode');
      values.mode = value;
    }
    if (repeated) {
      const key = { '--changed': 'changedPaths', '--affected': 'affectedPaths', '--capability': 'capabilities' }[flag];
      if (key === 'capabilities' && !qualityCapabilities.includes(value))
        throw qualityError('arguments', 'invalid quality capability');
      values[key] ??= [];
      if (values[key].includes(value)) throw qualityError('arguments', 'duplicate quality scope/capability');
      values[key].push(value);
    }
    if (['--timeout-ms', '--max-output-bytes'].includes(flag)) {
      if (!/^[1-9]\d*$/.test(value)) throw qualityError('arguments', 'quality limit must be a positive integer');
      const key = flag === '--timeout-ms' ? 'timeoutMs' : 'maxOutputBytes',
        number = Number(value);
      if (!Number.isSafeInteger(number) || number > (key === 'timeoutMs' ? 1800000 : 16 * 1024 * 1024))
        throw qualityError('arguments', 'quality limit exceeds maximum');
      values[key] = number;
    }
  }
  return { action, options: values, json };
}
export async function qualityCli(argv, dependencies = {}) {
  const json = argv.includes('--json');
  try {
    const parsed = parseQualityArgs(argv),
      registry = dependencies.registry ?? new QualityProfileRegistry();
    const report =
      parsed.action === 'detect'
        ? await registry.detect(parsed.options.project)
        : parsed.action === 'plan'
          ? await registry.plan(parsed.options.project, parsed.options)
          : await (dependencies.runQuality ?? runQuality)(parsed.options);
    const exitCode = ['failed', 'blocked'].includes(report.status) ? 1 : 0;
    const lines = [
      `Quality ${parsed.action}: ${report.status ?? 'planned'}`,
      `Languages: ${(report.languages ?? report.plan?.languages ?? []).join(', ') || 'none'}`,
    ];
    for (const row of report.receipts ?? report.checks ?? [])
      lines.push(`${row.id}: ${row.status}${row.reason ? ` (${row.reason})` : ''}`);
    if (report.evidenceRoot) lines.push(`Private evidence: ${report.evidenceRoot}`);
    return { report, exitCode, output: parsed.json ? JSON.stringify(report) : lines.join('\n') };
  } catch (error) {
    // No arbitrary source/config/subprocess message is exposed in JSON errors.
    const report = { schemaVersion: 1, status: 'blocked', reason: error.code ?? 'quality_error' };
    return { report, exitCode: 1, output: json ? JSON.stringify(report) : `Quality blocked: ${report.reason}` };
  }
}
