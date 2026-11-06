import { run } from 'node:test';
import { tap } from 'node:test/reporters';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import { readdirSync, lstatSync } from 'node:fs';

// Node 24 internal/test_runner/utils kDefaultPattern. Keep the built-in glob
// semantics (including hidden names and the strip-types switch), not an allowlist.
const extensions = process.features.typescript ? 'js,mjs,cjs,ts,mts,cts' : 'js,mjs,cjs';
const defaultPattern = `**/{test,test/**/*,test-*,*[._-]test}.{${extensions}}`;

// Source821 Windows/Node24.22.1 receipt c9b54c3c: all completed files >=90000 ms
// in descending durationMs, not reporter delivery order. Static observations,
// not runtime weights; environment/overlap differ and no speedup is implied.
// Scheduling has only a case-work lower bound; retain lighter prior entries.
// See docs/archive/WINDOWS-TEST-SPEED.md for provenance and the incomplete full check.
const priority = [
  'tests/delivery.test.mjs', // 434779.5897 ms
  'tests/project-director.test.mjs', // 375928.3714 ms
  'tests/architecture-gate-integration.test.mjs', // 314342.0235 ms
  'tests/architecture-cli.test.mjs', // 220780.7633 ms
  'tests/engine-2.test.mjs', // 219297.3218 ms
  'tests/engine-4.test.mjs', // 210502.2130 ms
  'tests/engine-3.test.mjs', // 204285.3006 ms
  'tests/benchmark.test.mjs', // 200519.1471 ms (completed file)
  'tests/engine.test.mjs', // 197217.0646 ms
  'tests/knowledge-cli.test.mjs', // 187586.6471 ms
  'tests/ci-graph.test.mjs', // 162527.6399 ms
  'tests/knowledge-refresh.test.mjs', // 158457.3852 ms
  'tests/mode-engine-2.test.mjs', // 125502.3442 ms
  'tests/ci-cache.test.mjs', // 124490.6677 ms
  'tests/efficiency-engine.test.mjs', // 124346.2806 ms
  'tests/mode-engine.test.mjs', // 123214.6159 ms
  'tests/mode-engine-4.test.mjs', // 119188.7387 ms
  'tests/quality-runner.test.mjs', // 114368.0009 ms
  'tests/mode-engine-3.test.mjs', // 110802.8659 ms
  // Same receipt: 11/12 sequential top-level cases total 100233.5395 ms.
  // Heuristic placement from a LOWER BOUND, never a completed-file duration.
  'tests/scheduling-engine.test.mjs',
  'tests/ci-cli.test.mjs', // 62405.4714 ms; retained lighter priority
  'tests/project-director-oracle.test.mjs', // 22760.5585 ms; retained lighter priority
  'tests/architecture-acceptance.test.mjs', // 17840.1058 ms; retained lighter priority
];

// `npm run test:fast`: unit-level files measured at a few seconds each on
// Windows, for edit-time feedback in well under a minute. It never replaces
// the full suite in `npm run check`; tests/test-schedule.test.mjs keeps every
// entry a discovered test file outside the slow priority list.
export const fastTests = [
  'tests/architecture-debt.test.mjs',
  'tests/architecture-policy.test.mjs',
  'tests/audit.test.mjs',
  'tests/benchmark-cli.test.mjs',
  'tests/cli-retry.test.mjs',
  'tests/context-pack.test.mjs',
  'tests/contract-registry.test.mjs',
  'tests/efficiency-acceptance.test.mjs',
  'tests/knowledge-claims.test.mjs',
  'tests/knowledge-context.test.mjs',
  'tests/knowledge-store.test.mjs',
  'tests/metrics.test.mjs',
  'tests/modes.test.mjs',
  'tests/package-pins.test.mjs',
  'tests/progress.test.mjs',
  'tests/project-cancel.test.mjs',
  'tests/project-contracts.test.mjs',
  'tests/project-evidence.test.mjs',
  'tests/project-planner.test.mjs',
  'tests/project-progress.test.mjs',
  'tests/providers.test.mjs',
  'tests/quality-cli.test.mjs',
  'tests/quality-protocol-regressions.test.mjs',
  'tests/quality-tools.test.mjs',
  'tests/registry-stats.test.mjs',
  'tests/rtk.test.mjs',
  'tests/runtime.test.mjs',
  'tests/security.test.mjs',
  'tests/skill-pin-batch-oracle.test.mjs',
  'tests/skill-policy.test.mjs',
  'tests/task-context.test.mjs',
  'tests/task-scheduler.test.mjs',
  'tests/test-git-environment.test.mjs',
  'tests/test-schedule.test.mjs',
  'tests/tools.test.mjs',
  'tests/ui-bridge.test.mjs',
  'tests/ui-verification.test.mjs',
  'tests/utf8-process.test.mjs',
];

export function orderTests(files, cwd) {
  const rank = file => {
    const index = priority.indexOf(path.relative(cwd, file).replaceAll('\\', '/'));
    return index === -1 ? priority.length : index;
  };
  return [...new Set(files.map(file => path.resolve(cwd, file)))].sort(
    (a, b) => rank(a) - rank(b) || (a < b ? -1 : a > b ? 1 : 0),
  );
}

export function discoverTests(cwd = process.cwd()) {
  cwd = path.resolve(cwd);
  const files = [];
  function visit(directory) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name === '.git' || entry.isSymbolicLink()) continue;
      const file = path.join(directory, entry.name);
      const relative = path.relative(cwd, file).replaceAll('\\', '/');
      // Like Node's default glob, ** does not descend into hidden directories.
      if (entry.isDirectory() && !entry.name.startsWith('.')) visit(file);
      else if (entry.isFile() && path.matchesGlob(relative, defaultPattern)) files.push(file);
    }
  }
  visit(cwd);
  return orderTests(files, cwd);
}

// The npm wrapper accepts literal files only. Reject globs/directories rather
// than silently changing Node CLI selection semantics; native node --test remains
// available for its wider CLI. Check every component before touching the next.
export function explicitTests(cwd, names) {
  const files = names.map(name => {
    if (/[*?{}[\]]/.test(name)) throw new Error(`Only literal test paths are supported: ${name}`);
    const file = path.resolve(cwd, name),
      relative = path.relative(cwd, file);
    if (!relative || relative.startsWith(`..${path.sep}`) || relative === '..' || path.isAbsolute(relative))
      throw new Error(`Test path outside checkout: ${name}`);
    let current = path.resolve(cwd);
    for (const part of relative.split(path.sep)) {
      if (part === 'node_modules' || part === '.git') throw new Error(`Unsupported test path: ${name}`);
      current = path.join(current, part);
      let stat;
      try {
        stat = lstatSync(current);
      } catch (error) {
        if (error.code === 'ENOENT') throw new Error(`Test file not found: ${name}`);
        throw error;
      }
      if (stat.isSymbolicLink()) throw new Error(`Unsupported linked test path: ${name}`);
    }
    if (!lstatSync(file).isFile()) throw new Error(`Only literal test files are supported: ${name}`);
    return file;
  });
  return orderTests(files, cwd);
}

function concurrencyValue(value) {
  if (!/^[1-8]$/.test(String(value))) throw new Error('Test concurrency must be an integer from 1 to 8');
  return Number(value);
}

export async function runTests({ cwd = process.cwd(), paths = [], concurrency = 4, testNamePatterns, signal } = {}) {
  // Never accept Node's recursive-run warning as a successful empty suite.
  if (process.env.NODE_TEST_CONTEXT !== undefined) throw new Error('Unsupported recursive test runner invocation');
  const files = paths.length ? explicitTests(cwd, paths) : discoverTests(cwd);
  const aborted = () => {
    process.exitCode = 1;
  };
  if (signal?.aborted) aborted();
  signal?.addEventListener('abort', aborted, { once: true });
  try {
    const stream = run({
      files,
      cwd,
      concurrency: concurrencyValue(concurrency),
      isolation: 'process',
      testNamePatterns,
      signal,
    });
    let reportedFailures = 0;
    stream.on('test:fail', data => {
      process.exitCode = 1;
      if (reportedFailures++ >= 16) return;
      const name = typeof data?.name === 'string' ? data.name : 'unnamed test';
      // Keep the complete TAP stream. A short stderr summary survives the CI
      // wrapper's bounded tails when an early failure precedes many passing tests.
      console.error(
        JSON.stringify({
          kind: 'kodo-test-failure',
          name: (path.isAbsolute(name) ? path.basename(name) : name).slice(0, 240),
          failureType: String(data?.details?.error?.failureType || 'unknown').slice(0, 80),
        }),
      );
    });
    // The official runner owns spawning, scheduling, cancellation and draining.
    // Do not forceExit, replace timeouts, or filter failure events/diagnostics.
    await pipeline(stream.compose(tap), process.stdout, { end: false });
  } finally {
    signal?.removeEventListener('abort', aborted);
  }
}

function parseArgs(args) {
  const options = { paths: [], testNamePatterns: [] };
  let literal = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (!literal && arg === '--') {
      literal = true;
      continue;
    }
    if (!literal && arg === '--fast') {
      options.fast = true;
      continue;
    }
    if (!literal && arg.startsWith('--')) {
      const split = arg.indexOf('='),
        key = split === -1 ? arg : arg.slice(0, split);
      if (key !== '--test-name-pattern' && key !== '--test-concurrency')
        throw new Error(`Unsupported test runner option: ${arg}`);
      const value = split === -1 ? args[++i] : arg.slice(split + 1);
      if (value === undefined || value.startsWith('--')) throw new Error(`Missing value for ${key}`);
      if (key === '--test-concurrency') options.concurrency = concurrencyValue(value);
      else options.testNamePatterns.push(value);
    } else {
      if (!literal && arg.startsWith('-')) throw new Error(`Unsupported test runner option: ${arg}`);
      options.paths.push(arg);
    }
  }
  if (!options.testNamePatterns.length) delete options.testNamePatterns;
  if (options.fast) {
    if (options.paths.length) throw new Error('--fast selects its own files; do not combine it with test paths');
    const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
    options.cwd = root;
    options.paths = fastTests;
    delete options.fast;
  }
  return options;
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  try {
    const options = parseArgs(process.argv.slice(2));
    if (process.env.NODE_TEST_CONTEXT !== undefined) throw new Error('Unsupported recursive test runner invocation');
    const gitHelper = new URL('./git-test-environment.mjs', import.meta.url);
    try {
      const { configureGitTestEnvironment } = await import(gitHelper.href);
      configureGitTestEnvironment();
    } catch (error) {
      // The optional development helper is deliberately absent from the package.
      if (error.code !== 'ERR_MODULE_NOT_FOUND' || error.url !== gitHelper.href) throw error;
    }
    await runTests({ ...options, signal: controller.signal });
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  } finally {
    process.removeListener('SIGINT', stop);
    process.removeListener('SIGTERM', stop);
  }
}
