import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runBenchmark, resumeBenchmark, reportBenchmark, normalizeBenchmarkOptions } from './benchmark.mjs';

export function parseBenchmarkArgs(argv) {
  const [command, ...args] = argv;
  if (!['run', 'resume', 'report'].includes(command))
    throw new TypeError(
      'Usage: kodo benchmark run --models MODEL,... [--client codex|claude-code] [--mode quick|standard|deep] [--repeats N] [--seed N] [--output ABSOLUTE_DIR] [--json]; resume|report PATH [--json]',
    );
  const flags = new Set(),
    values = {},
    positional = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (!arg.startsWith('--')) {
      positional.push(arg);
      continue;
    }
    if (flags.has(arg)) throw new TypeError(`Duplicate benchmark option ${arg}`);
    flags.add(arg);
    if (arg === '--json') {
      values.json = true;
      continue;
    }
    if (command !== 'run' || !['--models', '--client', '--mode', '--repeats', '--seed', '--output'].includes(arg))
      throw new TypeError(`Unknown benchmark option ${arg}`);
    const value = args[++i];
    if (!value || value.startsWith('--')) throw new TypeError(`Missing value for ${arg}`);
    const key = arg.slice(2);
    values[key] = value;
  }
  if (command !== 'run') {
    if (positional.length !== 1) throw new TypeError('Benchmark resume/report requires one PATH');
    return { command, path: path.resolve(positional[0]), json: values.json === true };
  }
  if (positional.length) throw new TypeError('Unexpected benchmark run argument');
  for (const key of ['seed', 'repeats'])
    if (values[key] !== undefined) {
      if (!/^-?\d+$/.test(values[key])) throw new TypeError(`Invalid benchmark ${key}`);
      values[key] = Number(values[key]);
    }
  const options = normalizeBenchmarkOptions(values);
  if (values.output !== undefined) options.output = values.output;
  return { command, options, json: values.json === true };
}

export function formatBenchmarkReport(report) {
  const lines = [`Benchmark ${report.benchmarkId}: ${report.complete ? 'completed' : 'pending'}`];
  if (report.output) lines.push(`Receipt directory: ${report.output}`);
  for (const row of report.summaries || [])
    lines.push(
      `${row.model} ${row.condition}: ${row.passed}/${row.completed} passed; ${row.failed} failed; ${row.pending} pending; median passing wall ms ${row.medianPassingWallMs ?? 'unknown'}`,
    );
  if (report.pause) lines.push(`Paused: ${report.pause.code}; run benchmark resume PATH explicitly.`);
  for (const row of report.excludedModels || []) lines.push(`Excluded ${row.model}: ${row.code}`);
  lines.push('Small paired sample; no universal winner, exact HTTP request count or subscription USD estimate.');
  return lines.join('\n');
}
export async function benchmarkCli(argv, dependencies = {}) {
  const parsed = parseBenchmarkArgs(argv);
  const report =
    parsed.command === 'run'
      ? await (dependencies.runBenchmark || runBenchmark)(parsed.options, dependencies)
      : parsed.command === 'resume'
        ? await (dependencies.resumeBenchmark || resumeBenchmark)(parsed.path, dependencies)
        : await (dependencies.reportBenchmark || reportBenchmark)(parsed.path);
  return { exitCode: 0, output: parsed.json ? JSON.stringify(report) : formatBenchmarkReport(report), report };
}
export const runBenchmarkCli = benchmarkCli;

// Dedicated entry port for packed-asset smoke tests; no provider calls for
// report/invalid arguments. The top-level CLI mounts this module separately.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const result = await benchmarkCli(process.argv.slice(2));
    process.stdout.write(result.output + '\n');
    process.exitCode = result.exitCode;
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
