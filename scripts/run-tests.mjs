import { run } from 'node:test';
import { tap } from 'node:test/reporters';
import { pipeline } from 'node:stream/promises';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { readdirSync, lstatSync } from 'node:fs';

// Node 24 internal/test_runner/utils kDefaultPattern. Keep the built-in glob
// semantics (including hidden names and the strip-types switch), not an allowlist.
const extensions = process.features.typescript ? 'js,mjs,cjs,ts,mts,cts' : 'js,mjs,cjs';
const defaultPattern = `**/{test,test/**/*,test-*,*[._-]test}.{${extensions}}`;

// Scheduling heuristics only: no fabricated durations or speedup estimates.
const priority = [
  'tests/project-director.test.mjs',
  'tests/project-director-oracle.test.mjs',
  'tests/ci-graph.test.mjs',
  'tests/ci-cache.test.mjs',
  'tests/architecture-gate-integration.test.mjs',
  'tests/mode-engine.test.mjs',
  'tests/mode-engine-2.test.mjs',
  'tests/mode-engine-3.test.mjs',
  'tests/mode-engine-4.test.mjs',
  'tests/ci-cli.test.mjs',
  'tests/delivery.test.mjs',
  'tests/engine.test.mjs',
  'tests/engine-2.test.mjs',
  'tests/engine-3.test.mjs',
  'tests/engine-4.test.mjs',
];

export function orderTests(files, cwd) {
  const rank = file => {
    const index = priority.indexOf(path.relative(cwd, file).replaceAll('\\', '/'));
    return index === -1 ? priority.length : index;
  };
  return [...new Set(files.map(file => path.resolve(cwd, file)))].sort((a, b) =>
    rank(a) - rank(b) || (a < b ? -1 : a > b ? 1 : 0));
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
    const file = path.resolve(cwd, name), relative = path.relative(cwd, file);
    if (!relative || relative.startsWith(`..${path.sep}`) || relative === '..' || path.isAbsolute(relative)) throw new Error(`Test path outside checkout: ${name}`);
    let current = path.resolve(cwd);
    for (const part of relative.split(path.sep)) {
      if (part === 'node_modules' || part === '.git') throw new Error(`Unsupported test path: ${name}`);
      current = path.join(current, part);
      let stat;
      try { stat = lstatSync(current); }
      catch (error) { if (error.code === 'ENOENT') throw new Error(`Test file not found: ${name}`); throw error; }
      if (stat.isSymbolicLink()) throw new Error(`Unsupported linked test path: ${name}`);
    }
    if (!lstatSync(file).isFile()) throw new Error(`Only literal test files are supported: ${name}`);
    return file;
  });
  return orderTests(files, cwd);
}

function concurrencyValue(value) {
  if (!/^[1-4]$/.test(String(value))) throw new Error('Test concurrency must be an integer from 1 to 4');
  return Number(value);
}

export async function runTests({ cwd = process.cwd(), paths = [], concurrency = 4, testNamePatterns, signal } = {}) {
  // Never accept Node's recursive-run warning as a successful empty suite.
  if (process.env.NODE_TEST_CONTEXT !== undefined) throw new Error('Unsupported recursive test runner invocation');
  const files = paths.length ? explicitTests(cwd, paths) : discoverTests(cwd);
  const aborted = () => { process.exitCode = 1; };
  if (signal?.aborted) aborted();
  signal?.addEventListener('abort', aborted, { once: true });
  try {
    const stream = run({ files, cwd, concurrency: concurrencyValue(concurrency), isolation: 'process', testNamePatterns, signal });
    stream.on('test:fail', () => { process.exitCode = 1; });
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
    if (!literal && arg === '--') { literal = true; continue; }
    if (!literal && arg.startsWith('--')) {
      const split = arg.indexOf('='), key = split === -1 ? arg : arg.slice(0, split);
      if (key !== '--test-name-pattern' && key !== '--test-concurrency') throw new Error(`Unsupported test runner option: ${arg}`);
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
  return options;
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  try {
    await runTests({ ...parseArgs(process.argv.slice(2)), signal: controller.signal });
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  } finally {
    process.removeListener('SIGINT', stop);
    process.removeListener('SIGTERM', stop);
  }
}
