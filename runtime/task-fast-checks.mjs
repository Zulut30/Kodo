/**
 * The `task-fast` verification profile: the cheap check of one task in a wave
 * project. Full verification (every command, smoke, gates and one review of the
 * whole diff) runs once per epic gate instead.
 *
 * The plan follows `kodo ci` L1: `node --check` of the affected JavaScript and
 * `node --test` of the affected test files. Any doubt (graph fallback, no
 * affected test, a runner that is not Node's own) runs the configured
 * `commands.test` in full. The receipt is never a full-check receipt: its
 * fingerprint and evidence kind differ, and it carries `profile: 'task-fast'`.
 */
import path from 'node:path';
import { createHash } from 'node:crypto';
import { lstat, mkdir, mkdtemp, readFile, realpath, rm, stat } from 'node:fs/promises';
import { isDeepStrictEqual } from 'node:util';
import { performance } from 'node:perf_hooks';
import { execute } from './command.mjs';
import { git } from './workspace.mjs';
import { validateCommandTimeouts } from './config.mjs';
import { stateHome, workerEnvironment } from './security.mjs';
import { inspectCurrentSource, planAffected } from './ci-graph.mjs';
import { cacheFingerprint, readCheckCache, writeCheckCache } from './ci-cache.mjs';
import { buildDiagnosticPack } from './diagnostic-pack.mjs';

export const TASK_FAST_PROFILE = 'task-fast';
export const FAST_CHECK_TIMEOUT_MS = 120000;
/**
 * The algorithm that counts passed `node --test` tests: the events of Kodo's own reporter
 * (`runtime/test-count-reporter.mjs`), never the text of the summary. Since 5 an npm script command
 * always runs as configured and its exit code decides; a simple script (resolveNpmScript, no `.npmrc`)
 * gets a separate counting run of its `node --test` (`count`), whose confirmed zero fails the check.
 * Part of the task-fast cache key and of every counted receipt row; a receipt or cache entry of
 * another version is never reused.
 */
export const TEST_COUNT_VERSION = 5;
const REPORTER_URL = new URL('./test-count-reporter.mjs', import.meta.url).href;
// Kodo's own reporter module, at any install location.
const kodoReporterArgument = /^--test-reporter=file:\/\/\/.+\/runtime\/test-count-reporter\.mjs$/;
// An event file larger than this is not read: its count is unknown.
const EVENTS_LIMIT = 64 * 1024 * 1024;
const LIST_LIMIT = 1000;
const REASON_LIMIT = 100;
const sha256 = value => createHash('sha256').update(value).digest('hex');
const fail = (message, code) => Object.assign(new Error(message), { code });
const javascript = file => /\.[cm]?js$/.test(file);
const lockFile = /(?:^|\/)(?:package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb?)$/;
const executionReasons = ['cancelled', 'timeout', 'invalid_output', 'command_failed', 'ENOENT', 'EACCES', 'EPERM'];

/**
 * The hard per-command timeout of the profile.
 * @param {{ fastChecks?: { timeoutMs?: number } }} run
 * @returns {number}
 */
export function fastCheckTimeout(run) {
  const settings = run.fastChecks;
  const invalid = () =>
    fail('Некорректный fastChecks.timeoutMs: требуется целое число от 1 до 2147483647 мс', 'configuration');
  if (settings === undefined) return FAST_CHECK_TIMEOUT_MS;
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) throw invalid();
  if (Object.keys(settings).some(key => key !== 'timeoutMs')) throw invalid();
  const value = settings.timeoutMs;
  if (value === undefined) return FAST_CHECK_TIMEOUT_MS;
  if (!Number.isSafeInteger(value) || value < 1 || value > 2147483647) throw invalid();
  return value;
}

// Node options Kodo knows: 'flag' takes no value, 'value' takes the next argument unless written
// as --name=value. Any other option makes the command line ambiguous: Kodo cannot tell whether
// the next argument is its value, a test pattern or the script.
const flagOptions = [
  'test',
  'test-only',
  'test-force-exit',
  'test-randomize',
  'test-update-snapshots',
  'experimental-test-coverage',
  'experimental-test-module-mocks',
  'experimental-test-snapshots',
  'experimental-strip-types',
  'experimental-transform-types',
  'no-experimental-strip-types',
  'no-warnings',
  'no-deprecation',
  'enable-source-maps',
  'trace-warnings',
  'trace-deprecation',
  'trace-uncaught',
  'pending-deprecation',
  'throw-deprecation',
  'preserve-symlinks',
  'preserve-symlinks-main',
  'expose-gc',
  'watch',
];
const valueOptions = [
  'test-reporter',
  'test-reporter-destination',
  'test-name-pattern',
  'test-skip-pattern',
  'test-shard',
  'test-concurrency',
  'test-timeout',
  'test-isolation',
  'test-rerun-failures',
  'experimental-test-tag-filter',
  'test-coverage-include',
  'test-coverage-exclude',
  'test-coverage-branches',
  'test-coverage-functions',
  'test-coverage-lines',
  'test-global-setup',
  'import',
  'require',
  'r',
  'loader',
  'experimental-loader',
  'conditions',
  'C',
  'env-file',
  'env-file-if-exists',
  'input-type',
  'unhandled-rejections',
  'disable-warning',
  'redirect-warnings',
  'stack-trace-limit',
  'max-old-space-size',
  'title',
  'watch-path',
];
/** @type {Map<string, 'flag' | 'value'>} */
const optionKinds = new Map();
for (const name of flagOptions) optionKinds.set(name, 'flag');
for (const name of valueOptions) optionKinds.set(name, 'value');
// The options a countable `node --test` may carry: they neither select tests nor change which tests
// run. Reporter options are allowed because Kodo replaces them (countingArguments). Anything else (a
// filter, a rerun state file, a tag filter, watch mode, an unknown option) gives no countable count:
// a filter without matches can report the file itself as one passed test.
const countableOptions = new Set([
  'test',
  'test-reporter',
  'test-reporter-destination',
  'test-force-exit',
  'test-randomize',
  'test-concurrency',
  'test-timeout',
  'test-isolation',
  'experimental-test-coverage',
  'experimental-test-module-mocks',
  'experimental-test-snapshots',
  'test-coverage-include',
  'test-coverage-exclude',
  'test-coverage-branches',
  'test-coverage-functions',
  'test-coverage-lines',
  'experimental-strip-types',
  'experimental-transform-types',
  'no-experimental-strip-types',
  'no-warnings',
  'no-deprecation',
  'enable-source-maps',
  'trace-warnings',
  'trace-deprecation',
  'trace-uncaught',
  'pending-deprecation',
  'throw-deprecation',
  'preserve-symlinks',
  'preserve-symlinks-main',
  'expose-gc',
  'import',
  'require',
  'r',
  'loader',
  'experimental-loader',
  'conditions',
  'C',
  // Not --env-file / --env-file-if-exists: a file may set NODE_OPTIONS with a test filter.
  'unhandled-rejections',
  'disable-warning',
  'stack-trace-limit',
  'max-old-space-size',
  'title',
]);
// Options that select tests: narrowed or not, they may run none at all.
const selectionNames = new Set([
  'test-shard',
  'test-name-pattern',
  'test-skip-pattern',
  'test-only',
  'test-rerun-failures',
  'experimental-test-tag-filter',
]);
// A whole-suite threshold (coverage) cannot be judged on the affected files alone.
const coverageOption = name => name === 'experimental-test-coverage' || name.startsWith('test-coverage-');
// Reporter options: Kodo removes them from a counted command and sets its own.
const reporterNames = new Set(['test-reporter', 'test-reporter-destination']);
// The built-in reporters a counted command keeps on stdout for diagnostics.
const diagnosticReporters = ['spec', 'tap'];
const nodeCommand = command => command === process.execPath || /(?:^|[\\/])node(?:\.exe)?$/i.test(command);
const optionName = arg => {
  const match = /^--?([^=]+)(?:=([\s\S]*))?$/.exec(arg);
  return match ? { name: match[1].replaceAll('_', '-'), value: match[2] } : null;
};

/**
 * Node's own command line: its options up to the script, `--` or (in test mode) the test patterns.
 * Names are normalized (`_` as `-`, as Node accepts both); after a script the remaining arguments
 * belong to the script. An unknown option makes the parse ambiguous; when it is ambiguous and any
 * later argument is `--test`, the command is treated as the test runner whose summary is unknown.
 * @param {string[]} [args]
 */
export function nodeArguments(args = []) {
  const list = args.map(String),
    options = [],
    positionals = [];
  let ambiguous = false,
    separated = false,
    script = null;
  for (let index = 0; index < list.length; index++) {
    const arg = list[index];
    const testMode = options.some(option => option.name === 'test');
    if (arg === '--') {
      separated = true;
      if (testMode) positionals.push(...list.slice(index + 1));
      else script = list[index + 1] ?? null;
      break;
    }
    if (!arg.startsWith('-') || arg === '-') {
      if (!testMode) {
        script = arg;
        break;
      }
      positionals.push(arg);
      continue;
    }
    const parsedOption = optionName(arg) ?? { name: arg, value: undefined };
    const kind = optionKinds.get(parsedOption.name);
    const inline = parsedOption.value !== undefined;
    let value = parsedOption.value;
    if (!inline && kind === 'value') value = list[++index];
    if (!kind) ambiguous = true;
    options.push({ name: parsedOption.name, value, inline });
  }
  const testFlag = list.some(arg => optionName(arg)?.name === 'test');
  const testMode = options.some(option => option.name === 'test') || (ambiguous && testFlag);
  return { options, positionals, script, testMode, ambiguous, separated };
}
const parsed = step => nodeArguments(step.args || []);
/** Whether a configured command is Node's own test runner (`node --test`, any value). */
export const nodeTestCommand = step => nodeCommand(step.command) && parsed(step).testMode;
const selecting = ({ options }) => options.some(option => selectionNames.has(option.name));
/**
 * A `node --test` command whose passed tests Kodo can count: every option is known and allowed and
 * no test is selected away. Kodo executes it with its own reporters (countingArguments).
 * @param {{ command: string, args?: string[] }} step
 */
export const countedRunner = step => {
  if (!nodeCommand(step.command)) return false;
  const node = parsed(step);
  return (
    node.testMode &&
    !node.ambiguous &&
    node.options.every(option => countableOptions.has(option.name)) &&
    !selecting(node)
  );
};

/**
 * The arguments Kodo executes for a counted `node --test` command: the command's own reporter
 * options removed, then one diagnostic reporter on stdout (the command's single `spec` or `tap`
 * reporter, otherwise `spec`) and Kodo's event reporter into `destination`, before the command's
 * remaining arguments in their order.
 * @param {string[] | undefined} args
 * @param {string} destination
 * @returns {string[]}
 */
export function countingArguments(args = [], destination) {
  const list = args.map(String),
    kept = [],
    names = [];
  for (let index = 0; index < list.length; index++) {
    const arg = list[index];
    if (arg === '--') {
      kept.push(...list.slice(index));
      break;
    }
    const option = arg.startsWith('-') && arg !== '-' ? optionName(arg) : null;
    const separate = option && option.value === undefined && optionKinds.get(option.name) === 'value';
    const value = separate ? list[index + 1] : option?.value;
    if (option?.name === 'test-reporter') names.push(value);
    if (!option || !reporterNames.has(option.name)) kept.push(...(separate ? [arg, list[index + 1]] : [arg]));
    if (separate) index++;
  }
  const diagnostic = names.length === 1 && diagnosticReporters.includes(names[0]) ? names[0] : 'spec';
  return [
    `--test-reporter=${diagnostic}`,
    '--test-reporter-destination=stdout',
    `--test-reporter=${REPORTER_URL}`,
    `--test-reporter-destination=${destination}`,
    ...kept.filter(arg => arg !== undefined),
  ];
}

// npm runs one package script for exactly these arguments: `npm test` (`t`, `tst`) and
// `npm run <name>` (`run-script`, `rum`, `urn`). An npm option or arguments for the script are not resolved.
const npmTestAliases = new Set(['test', 't', 'tst']);
const npmRunAliases = new Set(['run', 'run-script', 'rum', 'urn']);
const npmScriptName = /^[A-Za-z0-9_][A-Za-z0-9_:.-]*$/;
// `npm` itself; on Windows also `npm.cmd` (names are case-insensitive there).
const npmCommand = command => command === 'npm' || (process.platform === 'win32' && /^npm(?:\.cmd)?$/i.test(command));
// A script Kodo runs without npm and its shell: `node` and arguments of plain characters separated by
// spaces. Quotes, escapes, `$`, `%`, `~`, globs, `&`, `|`, `;`, `<`, `>`, backticks, parentheses, `!`,
// `^`, `#`, tabs and line breaks may mean something to sh or cmd.exe: such a script keeps its exit code.
const plainNodeScript = /^node(?: +[A-Za-z0-9_@+=:,./-]+)+$/;

/**
 * The package script an npm command runs (`npm test` → `test`, `npm run <name>` → `<name>`), or null.
 * @param {{ command: string, args?: string[] }} step
 * @returns {string | null}
 */
export function npmScript(step) {
  if (typeof step?.command !== 'string' || !npmCommand(step.command)) return null;
  const args = (step.args ?? []).map(String);
  if (args.length === 1 && npmTestAliases.has(args[0])) return 'test';
  if (args.length === 2 && npmRunAliases.has(args[0]) && npmScriptName.test(args[1])) return args[1];
  return null;
}

/**
 * The Node command an npm script command (npmScript) is equivalent to in the raw `package.json` of
 * the checked commit: the script is a plain `node …` (plainNodeScript, no shell operator or
 * substitution) that Kodo can count (countedRunner), neither `pre<name>` nor `post<name>` exists and
 * the manifest declares no `workspaces`. Anything else is null: another runner, a shell chain, a
 * pre/post script or workspaces are judged by the exit code of npm alone.
 * @param {{ command: string, args?: string[] }} step
 * @param {string | null | undefined} packageText
 * @returns {{ resolved: { script: string, text: string }, step: { command: string, args: string[] } } | null}
 */
export function resolveNpmScript(step, packageText) {
  const script = npmScript(step);
  if (!script || typeof packageText !== 'string') return null;
  let manifest;
  try {
    // npm reads package.json as UTF-8 and ignores a byte order mark.
    manifest = JSON.parse(packageText.replace(/^\uFEFF/, ''));
  } catch {
    return null;
  }
  const scripts = manifest?.scripts;
  if (!scripts || typeof scripts !== 'object' || Array.isArray(scripts)) return null;
  // npm may run the script in every workspace too.
  if (Object.hasOwn(manifest, 'workspaces')) return null;
  const text = Object.hasOwn(scripts, script) ? scripts[script] : undefined;
  if (typeof text !== 'string' || !plainNodeScript.test(text)) return null;
  if (Object.hasOwn(scripts, `pre${script}`) || Object.hasOwn(scripts, `post${script}`)) return null;
  const node = { command: process.execPath, args: text.split(/ +/).slice(1) };
  return countedRunner(node) ? { resolved: { script, text }, step: node } : null;
}

/**
 * What npm reads from the root of `commit` beside `cwd`: the raw `package.json` (null when the commit
 * has none or it is not a regular file) and whether a project `.npmrc` exists (an entry of that name
 * in any letter case and of any type: it can set `node-options`, `workspaces`, `script-shell` and
 * more). Read from Git, never from the working tree.
 * @param {string} cwd
 * @param {string} commit
 * @returns {Promise<{ packageText: string | null, npmrc: boolean }>}
 */
export async function npmContextAt(cwd, commit) {
  const options = { cwd, env: workerEnvironment(), rawOutput: true, timeoutMs: 30000 };
  const listed = (await execute('git', ['ls-tree', '-z', commit], options)).stdout;
  const entries = listed
    .split('\0')
    .filter(Boolean)
    .map(row => /^(\d+) (\w+) ([a-f0-9]+)\t([\s\S]+)$/.exec(row));
  if (entries.some(entry => !entry)) throw fail('Malformed Git tree listing', 'configuration');
  const manifest = entries.find(
    ([, mode, type, , name]) => name === 'package.json' && type === 'blob' && /^100(?:644|755)$/.test(mode),
  );
  return {
    packageText: manifest ? (await execute('git', ['cat-file', 'blob', manifest[3]], options)).stdout : null,
    npmrc: entries.some(entry => entry[4].toLowerCase() === '.npmrc'),
  };
}

/**
 * The npm context of `headSha` (npmContextAt), read only when one of the test `commands` runs an npm script.
 * @param {string} cwd
 * @param {string} headSha
 * @param {{ command: string, args?: string[] }[]} commands
 */
export const npmContextFor = async (cwd, headSha, commands) =>
  commands.some(step => npmScript(step)) ? npmContextAt(cwd, headSha) : null;

/**
 * How Kodo counts a configured test command of a wave project: a countable `node --test` runs as
 * configured with Kodo's reporters (`{ step }`). An npm script command always runs as configured and
 * its exit code decides; when it is simple (its script resolves, see resolveNpmScript, and the checked
 * commit has no `.npmrc`) Kodo also counts the equivalent Node command in a separate run
 * (`{ npm: { resolved, step } }`, see countNpmScript). Null for anything else (its exit code decides).
 * @param {{ command: string, args?: string[] }} step
 * @param {{ packageText: string | null, npmrc: boolean } | null | undefined} context npmContextAt
 * @returns {{ step?: { command: string, args?: string[] }, npm?: { resolved: { script: string, text: string }, step: { command: string, args: string[] } } } | null}
 */
export function countingPlan(step, context) {
  if (countedRunner(step)) return { step };
  const npm = context && !context.npmrc ? resolveNpmScript(step, context.packageText) : null;
  return npm ? { npm } : null;
}

/**
 * The command Kodo launches for a configured check of a wave project: an npm command named `npm.cmd`
 * on Windows (which Node cannot spawn without a shell) runs as `npm`, through Node and npm's own CLI.
 * @param {{ command: string, args?: string[] }} step
 */
export const npmLaunch = step =>
  step.command !== 'npm' && npmCommand(step.command) ? { ...step, command: 'npm' } : step;

/**
 * Only Node's own test runner can be narrowed to the affected files. Its options must survive
 * the narrowing (written as --name=value or known flags, none that selects tests or judges the whole
 * suite such as a coverage threshold); a positional path limits which test files run. Reporter
 * options do not matter: Kodo replaces them when it executes the command (countingArguments).
 * @param {{ command: string, args?: string[] }[]} commands
 */
function nodeTestRunner(commands) {
  if (commands.length !== 1) return { reason: commands.length ? 'runner-multiple-commands' : 'runner-not-configured' };
  const [step] = commands,
    args = step.args || [];
  const node = nodeArguments(args);
  if (!nodeCommand(step.command) || !node.testMode) return { reason: 'runner-not-node-test' };
  if (selecting(node)) return { reason: 'runner-selection' };
  if (
    !countedRunner(step) ||
    node.separated ||
    node.options.some(
      option => coverageOption(option.name) || (!option.inline && optionKinds.get(option.name) === 'value'),
    )
  )
    return { reason: 'runner-options' };
  const flags = args.filter(arg => String(arg).startsWith('-')),
    scopes = [];
  for (const arg of node.positionals) {
    if (/[*?[\]{}]/.test(arg)) return { reason: 'runner-options' };
    const scope = path.posix.normalize(arg.replaceAll('\\', '/')).replace(/\/+$/, '');
    if (path.posix.isAbsolute(scope) || /^[a-z]:/i.test(scope) || scope === '..' || scope.startsWith('../'))
      return { reason: 'runner-options' };
    scopes.push(scope);
  }
  return { flags, scopes };
}
const inScope = (file, scopes) =>
  !scopes.length || scopes.some(scope => scope === '.' || file === scope || file.startsWith(`${scope}/`));

async function syntaxTargets(cwd, files) {
  const targets = [];
  for (const file of files.filter(javascript)) {
    // A deleted or renamed file stays in the graph for its reverse edges; there is nothing to parse.
    const info = await lstat(path.join(cwd, file)).catch(() => null);
    if (info?.isFile()) targets.push(file);
  }
  return targets;
}

const fullCommands = (configured, timeoutMs) =>
  configured.map(({ command, args = [], timeoutMs: own }) => ({
    kind: 'test',
    command,
    args: [...args],
    timeoutMs: Math.min(own ?? timeoutMs, timeoutMs),
  }));

const eventTypes = new Set(['test:pass', 'test:fail']);
const textOrNull = value => value === null || typeof value === 'string';
const integerOrNull = value => value === null || Number.isSafeInteger(value);
const validEvent = event =>
  event !== null &&
  typeof event === 'object' &&
  eventTypes.has(event.type) &&
  textOrNull(event.kind) &&
  integerOrNull(event.nesting) &&
  integerOrNull(event.line) &&
  integerOrNull(event.column) &&
  typeof event.skip === 'boolean' &&
  typeof event.todo === 'boolean';
// Node's placeholder test of a file or directory that registered no test sits at the top level at
// position 1:1. Recognized by position alone (names and paths are not recorded): a real top-level
// test written at 1:1 is not counted either, which can only lower the count.
const syntheticTest = event => event.nesting === 0 && event.line === 1 && event.column === 1;

/**
 * Tests a `node --test` run passed, from the event file of Kodo's reporter
 * (`runtime/test-count-reporter.mjs`): the `test:pass` events of tests (not suites) that are neither
 * skipped nor todo, without the synthetic test of a file without tests. `null` when the file is
 * missing, malformed or incomplete (no final `end` line).
 * @param {unknown} text
 * @returns {number | null}
 */
export function countTestEvents(text) {
  if (typeof text !== 'string' || !text.endsWith('\n')) return null;
  const lines = text.slice(0, -1).split('\n');
  let tests = 0;
  for (const [index, line] of lines.entries()) {
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      return null;
    }
    if (index === lines.length - 1) return isDeepStrictEqual(event, { type: 'end' }) ? tests : null;
    if (!validEvent(event)) return null;
    if (event.type === 'test:pass' && event.kind === 'test' && !event.skip && !event.todo && !syntheticTest(event))
      tests++;
  }
  return null;
}

/**
 * The outcome of one `node --test` command from its observed execution (the value of its evidence
 * log): null for a command that is not Node's test runner; otherwise `{ tests }`, the count of its
 * event file (countTestEvents), or `tests: null` when the command cannot be counted (a selecting or
 * unknown option), was not executed with exactly Kodo's counting arguments (`executed`) or its event
 * file (`testEvents`) is missing, malformed or incomplete. stdout is never counted.
 * A wave gate Run requires `tests > 0` for each of its full `node --test` commands.
 * @param {{ command: string, args?: string[] }} step
 * @param {{ executed?: { command?: string, args?: string[] }, testEvents?: unknown } | null | undefined} observed
 * @returns {{ tests: number | null } | null}
 */
export function nodeTestOutcome(step, observed) {
  if (!nodeTestCommand(step)) return null;
  if (!countedRunner(step)) return { tests: null };
  return { tests: exactExecution(step, observed?.executed) ? countTestEvents(observed.testEvents) : null };
}

/**
 * Whether `executed` is exactly the counted execution of `step` (countingArguments) into an absolute
 * event file. The receipt names Kodo's reporter by the location Kodo ran from; a later Kodo installed
 * elsewhere still recognizes it as its own reporter module.
 * @param {{ command: string, args?: string[] }} step
 * @param {{ command?: string, args?: string[] } | null | undefined} executed
 */
function exactExecution(step, executed) {
  const destination = Array.isArray(executed?.args)
    ? /^--test-reporter-destination=([\s\S]+)$/.exec(String(executed.args[3] ?? ''))?.[1]
    : undefined;
  const expected = countingArguments(step.args, destination);
  if (Array.isArray(executed?.args) && kodoReporterArgument.test(String(executed.args[2] ?? '')))
    expected[2] = String(executed.args[2]);
  return (
    destination !== undefined &&
    path.isAbsolute(destination) &&
    executed.command === step.command &&
    isDeepStrictEqual(executed.args, expected)
  );
}

/**
 * The outcome of the counting run of a simple npm script (countingPlan `npm`) from its logged `count`:
 * null when the log is not that run (another resolution, or not exactly Kodo's counting command);
 * otherwise `{ tests }` — the event count (countTestEvents) of a run that exited 0, and `null` for a
 * run that failed, stopped or left no complete event file (the exit code of npm decides then).
 * @param {{ resolved: { script: string, text: string }, step: { command: string, args: string[] } }} plan
 * @param {{ resolved?: unknown, executed?: { command?: string, args?: string[] }, exitCode?: unknown, testEvents?: unknown } | null | undefined} logged
 * @returns {{ tests: number | null } | null}
 */
export function npmCountOutcome(plan, logged) {
  if (!isDeepStrictEqual(logged?.resolved, plan.resolved)) return null;
  // The counting run could not be prepared (its event directory): no count, npm's exit code decides.
  if (unavailableCount(logged)) return { tests: null };
  if (!exactExecution(plan.step, logged.executed)) return null;
  return { tests: logged.exitCode === 0 ? countTestEvents(logged.testEvents) : null };
}

// A preparation failure of the counting run, recorded by a constant code only.
const countUnavailable = failure =>
  `count_unavailable:${/^[a-z_]{1,48}$/i.test(String(failure?.code ?? '')) ? String(failure.code) : 'error'}`;
const unavailableCount = logged =>
  typeof logged?.unavailable === 'string' &&
  /^count_unavailable:[a-z_]{1,48}$/i.test(logged.unavailable) &&
  logged.executed === null &&
  logged.exitCode === null &&
  logged.tests === null &&
  logged.testEvents === null;

/** The real path of `target`, or that of its nearest existing ancestor followed by the rest. */
async function canonicalPath(target) {
  const resolved = path.resolve(target);
  try {
    return await realpath(resolved);
  } catch (error) {
    const parent = path.dirname(resolved);
    if (error?.code !== 'ENOENT' || parent === resolved) throw error;
    return path.join(await canonicalPath(parent), path.basename(resolved));
  }
}
// Both paths are canonical (real paths in their stored case): compared segment by segment, exactly.
// path.relative folds case on Windows with Unicode rules, which would merge distinct directories
// such as `Repo-K` and `Repo-K` (Kelvin sign).
const inside = (outer, inner) => {
  const parts = value => value.split(path.sep).filter(Boolean);
  const [container, contained] = [parts(outer), parts(inner)];
  return container.length <= contained.length && container.every((segment, index) => segment === contained[index]);
};

/**
 * A fresh private directory for one event file, under Kodo's state home (not TEMP: the tests'
 * temporary directory stays untouched) and outside every project root: the command's working
 * directory and the project's source checkout. Real paths are compared before and after the
 * directory is created, so a junction or symlink cannot place it inside a project.
 * @param {string[]} roots
 */
async function eventDirectory(roots) {
  const home = path.resolve(stateHome());
  const root = path.join(home, 'test-events');
  const projects = await Promise.all(roots.map(canonicalPath));
  const refuse = () =>
    Object.assign(new Error('Kodo state home lies inside the project'), { code: 'fast_check_events_location' });
  // Only real paths are compared: how a path is written (a link inside the project leading
  // outside, or the reverse) never decides. Kodo's home and its test-events must both be outside.
  const outside = async target => {
    const real = await canonicalPath(target);
    return !projects.some(project => inside(project, real));
  };
  if (!(await outside(home)) || !(await outside(root))) throw refuse();
  await mkdir(root, { recursive: true, mode: 0o700 });
  const actual = await realpath(root);
  if (projects.some(project => inside(project, actual))) throw refuse();
  return mkdtemp(path.join(actual, 'run-'));
}

/**
 * Execute one check command. A counted `node --test` command (countedRunner) runs with Kodo's
 * reporters (countingArguments); its event file lives in a fresh private directory under Kodo's
 * state home, outside the project and the command's temporary directory, is read back as
 * `testEvents` (null when missing or too large) and is then removed.
 * Never throws for the command itself: a stopped execution is returned as `error`.
 * @param {{ command: string, args?: string[] }} step
 * @param {Record<string, any>} options `execute` options
 * @param {boolean} counted
 * @param {string[]} [roots] Project roots besides `options.cwd` (the source checkout of a worktree).
 */
export async function executeCheck(step, options, counted, roots = []) {
  const run = async (command, args) => {
    try {
      return { result: await execute(command, args, options), error: null };
    } catch (error) {
      return { result: null, error };
    }
  };
  if (!counted) return run(step.command, step.args ?? []);
  const directory = await eventDirectory([options.cwd ?? process.cwd(), ...roots]);
  const file = path.join(directory, 'events.jsonl');
  const executed = { command: step.command, args: countingArguments(step.args, file) };
  try {
    const outcome = await run(executed.command, executed.args);
    const info = await stat(file).catch(() => null);
    const testEvents =
      info?.isFile() && info.size <= EVENTS_LIMIT ? await readFile(file, 'utf8').catch(() => null) : null;
    return { ...outcome, executed, testEvents };
  } finally {
    await rm(directory, { recursive: true, force: true }).catch(() => {});
  }
}

const stopReason = error => (executionReasons.includes(error.code) ? error.code : 'execution_failed');

/**
 * The separate counting run of a simple npm script (countingPlan `npm`) after its configured npm
 * command passed: the equivalent Node command runs with Kodo's reporters (executeCheck) and never
 * replaces npm. `count` is the receipt row part `{ resolved, executed, exitCode, tests }` (npmCountOutcome);
 * `logged` adds the reason of a stopped run, the tail of its output and `testEvents` for the evidence
 * log; `error` is the stop of the run, if any.
 * @param {{ resolved: { script: string, text: string }, step: { command: string, args: string[] } }} plan
 * @param {Record<string, any>} options `execute` options
 * @param {string[]} [roots]
 */
export async function countNpmScript(plan, options, roots = []) {
  let prepared;
  try {
    prepared = await executeCheck(plan.step, options, true, roots);
  } catch (failure) {
    // A refused location is a configuration error, never an unknown count.
    if (failure?.code === 'fast_check_events_location') throw failure;
    // After npm passed, a counting run that cannot even be prepared leaves npm's result in place.
    const count = { resolved: plan.resolved, executed: null, exitCode: null, tests: null };
    const unavailable = countUnavailable(failure);
    return { count, logged: { ...count, unavailable, stdout: '', stderr: '', testEvents: null }, error: null };
  }
  const { result, error, executed, testEvents } = prepared;
  const output = result ?? error?.result ?? {};
  const exitCode = result ? result.code : null;
  const tests = npmCountOutcome(plan, { resolved: plan.resolved, executed, exitCode, testEvents })?.tests ?? null;
  const count = { resolved: plan.resolved, executed, exitCode, tests };
  const tail = value => (typeof value === 'string' ? value.slice(-24000) : '');
  return {
    count,
    logged: {
      ...count,
      ...(error ? { reason: stopReason(error) } : {}),
      stdout: tail(output.stdout),
      stderr: tail(output.stderr),
      testEvents,
    },
    error,
  };
}

/**
 * Execute one check command of a wave project by its counting plan (countingPlan): a countable
 * `node --test` with Kodo's reporters, anything else as `launch` (the configured command, see
 * npmLaunch); after a simple npm script passed, also its counting run (countNpmScript, `npm`).
 * `recorded` is the counting part of the receipt row (`executed` and `countVersion`, or `countVersion`
 * and `count`), `observed` that of its evidence log (with `testEvents`).
 * @param {{ command: string, args?: string[] }} launch
 * @param {ReturnType<typeof countingPlan>} counting
 * @param {Record<string, any>} options `execute` options
 * @param {string[]} roots
 */
export async function executeCounted(launch, counting, options, roots) {
  const direct = counting?.step;
  const execution = await executeCheck(direct ?? launch, options, Boolean(direct), roots);
  const npm = counting?.npm && execution.result?.code === 0 ? await countNpmScript(counting.npm, options, roots) : null;
  if (direct) {
    const recorded = { executed: execution.executed, countVersion: TEST_COUNT_VERSION };
    return { ...execution, npm, recorded, observed: { ...recorded, testEvents: execution.testEvents } };
  }
  const recorded = npm ? { countVersion: TEST_COUNT_VERSION, count: npm.count } : {};
  return { ...execution, npm, recorded, observed: npm ? { ...recorded, count: npm.logged } : {} };
}

/**
 * The fast plan for one head, with the reasons for any full fallback.
 * @param {{ run: any, cwd?: string, baseSha?: string, headSha: string }} input
 */
export async function planFastChecks({ run, cwd = run.cwd, baseSha = run.baseSha, headSha }) {
  const timeoutMs = fastCheckTimeout(run);
  const configured = run.config.commands.test || [];
  const reasons = [];
  let graph = null;
  try {
    graph = await planAffected({ project: cwd, baseSha, headSha });
  } catch {
    reasons.push('graph-error');
  }
  if (graph?.fallback) reasons.push(...graph.reasons);
  const runner = nodeTestRunner(configured);
  if (runner.reason) reasons.push(runner.reason);
  const tests = reasons.length ? [] : graph.testFiles.filter(file => inScope(file, runner.scopes));
  if (!reasons.length && !tests.length) reasons.push('no-affected-tests');
  const fallback = reasons.length > 0;
  const commands = fallback
    ? fullCommands(configured, timeoutMs)
    : [
        ...(await syntaxTargets(cwd, graph.affectedFiles)).map(file => ({
          kind: 'syntax',
          command: process.execPath,
          args: ['--check', file],
          timeoutMs,
        })),
        { kind: 'test', command: process.execPath, args: [...runner.flags, ...tests], timeoutMs },
      ];
  const changed = graph?.changedFiles ?? [],
    affected = fallback ? [] : graph.affectedFiles;
  const truncated = changed.length > LIST_LIMIT || affected.length > LIST_LIMIT || reasons.length > REASON_LIMIT;
  return {
    schemaVersion: 1,
    profile: TASK_FAST_PROFILE,
    baseSha,
    headSha,
    changed: changed.slice(0, LIST_LIMIT),
    affected: affected.slice(0, LIST_LIMIT),
    testFiles: tests,
    fallback,
    reasons: reasons.slice(0, REASON_LIMIT),
    ...(truncated ? { truncated: true } : {}),
    sourceHash: graph?.sourceHash ?? null,
    dependencyHash: graph?.dependencyHash ?? null,
    commands,
  };
}

/** The environment of a counted test run: no inherited `node --test` context. */
export function fastEnvironment() {
  const env = workerEnvironment();
  // A runner that inherits an enclosing `node --test` context skips every file and exits 0, and
  // NODE_OPTIONS could add a test filter the command line does not show: wave checks run only
  // the options written in the command.
  for (const name of Object.keys(env))
    if (/^(?:NODE_TEST_(?:CONTEXT|WORKER_ID)|NODE_OPTIONS)$/i.test(name)) delete env[name];
  return env;
}

async function assertClean(cwd, headSha, message) {
  if ((await inspectCurrentSource({ project: cwd, headSha })) !== 'clean') throw fail(message, 'dirty_worktree');
}

/** The freshly observed command context for the private cache. Unknown context means no cache. */
async function cacheContext(run, plan, headSha, env) {
  try {
    // The cache demands a canonical project path; the graph already refused links in it.
    const project = await realpath(run.cwd);
    const tree = await execute('git', ['ls-tree', '-rz', '--full-tree', headSha], {
      cwd: project,
      env: workerEnvironment(),
      rawOutput: true,
      timeoutMs: 30000,
    });
    const locks = tree.stdout
      .split('\0')
      .filter(Boolean)
      .flatMap(row => {
        const match = /^\d+ \w+ ([a-f0-9]+)\t([\s\S]+)$/.exec(row);
        return match && lockFile.test(match[2]) ? [[match[2], match[1]]] : [];
      })
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    const variables = Object.entries(env).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return {
      project,
      headSha,
      sourceHash: plan.sourceHash,
      dependencyHash: plan.dependencyHash,
      lockHash: sha256(JSON.stringify(locks)),
      envHash: sha256(JSON.stringify(variables)),
      runtimeVersions: { node: process.versions.node, v8: process.versions.v8, modules: process.versions.modules },
      toolVersions: { node: process.versions.node },
      platform: process.platform,
      arch: process.arch,
    };
  } catch {
    return null;
  }
}

async function cachedRow(engine, step, input, headSha) {
  const hit = await readCheckCache({
    home: engine.store.home,
    fingerprint: cacheFingerprint(input),
    project: input.project,
    headSha,
    input,
  });
  const file = hit?.evidence?.[0];
  if (!file) return null;
  let logged, outcome;
  try {
    await engine.assertEvidence({ path: file.path, sha256: file.sha256, headSha });
    // The cached log must still prove its count by its own events, with the current algorithm.
    logged = JSON.parse(await readFile(file.path, 'utf8')).value;
    outcome = nodeTestOutcome(step, logged);
  } catch {
    return null;
  }
  if (!(outcome?.tests > 0)) return null;
  return {
    ...rowBase(step),
    exitCode: 0,
    durationMs: 0,
    cached: true,
    executed: logged.executed,
    countVersion: TEST_COUNT_VERSION,
    tests: outcome.tests,
    evidence: { path: file.path, sha256: file.sha256, bytes: file.bytes, headSha },
    outputPath: file.path,
    outputHash: file.sha256,
  };
}

const rowBase = step => ({ kind: step.kind, command: step.command, args: step.args });

/**
 * One command of the plan: a cached receipt, or its execution with persisted evidence.
 * A countable `node --test` step (countingPlan `step`) runs with Kodo's reporters (executeCheck): its
 * row keeps the planned `command`/`args`, adds the `executed` command, `countVersion` and how many
 * tests passed by the event file (`row.tests`); its log also holds `executed` and `testEvents`.
 * Passing none is `noTests`, never cached. An npm script command always runs as configured (its exit
 * code decides); after it passed, a simple one (countingPlan `npm`) gets its counting run
 * (countNpmScript): the row adds `countVersion` and `count`, the log `count` with `testEvents`, and a
 * confirmed zero fails the check (`fast_check_no_tests`).
 */
async function runStep({ engine, run, step, headSha, env, cache, counting, signal }) {
  const base = rowBase(step);
  const input =
    cache && step.kind === 'test'
      ? {
          ...cache,
          kind: 'test',
          command: step.command,
          args: step.args,
          // Only runs that passed a test (not skip/todo) by the events of the current counting
          // algorithm are cached; entries of older algorithms (`passedTests`, `executedTests`) never match.
          gateConfig: { profile: TASK_FAST_PROFILE, timeoutMs: step.timeoutMs, countVersion: TEST_COUNT_VERSION },
        }
      : null;
  const hit = input && (await cachedRow(engine, step, input, headSha));
  if (hit) return { row: hit };
  const started = performance.now();
  const options = { cwd: run.cwd, signal, env, secrets: engine.secrets, timeoutMs: step.timeoutMs, allowFailure: true };
  const direct = counting?.step;
  // The configured npm command decides; only after it passed is its script counted separately (`npm`).
  const { result, error, npm, recorded, observed } = await executeCounted(npmLaunch(step), counting, options, [
    run.project,
  ]);
  const durationMs = Math.round(performance.now() - started);
  const output = result ?? error?.result ?? {};
  const exitCode = result ? result.code : null;
  const reason = error ? stopReason(error) : undefined;
  const value = {
    ...base,
    exitCode,
    ...(reason ? { reason } : {}),
    durationMs,
    stdout: typeof output.stdout === 'string' ? output.stdout : '',
    stderr: typeof output.stderr === 'string' ? output.stderr : '',
    ...observed,
  };
  let evidence = null;
  try {
    evidence = await engine.persistEvidence(run, 'fast-check', value, { headSha });
  } catch (persistError) {
    // A stopped command keeps its own error; a finished one cannot pass without its log.
    if (!error) throw persistError;
  }
  /** @type {Record<string, any>} */
  const row = {
    ...base,
    exitCode,
    durationMs,
    ...(reason ? { reason } : {}),
    ...recorded,
    ...(evidence
      ? {
          evidence: { path: evidence.path, sha256: evidence.sha256, bytes: evidence.bytes, headSha },
          outputPath: evidence.path,
          outputHash: evidence.sha256,
        }
      : {}),
  };
  if (error) {
    if (error.code !== 'timeout' || signal?.aborted) return { row, error };
    const line = `${path.basename(step.command)} ${step.args.join(' ')}`.slice(0, 500);
    return {
      row,
      error: fail(
        `Быстрая проверка ${step.kind} превысила таймаут ${step.timeoutMs} мс: ${line}`,
        'fast_check_timeout',
      ),
    };
  }
  await assertClean(run.cwd, headSha, 'Команда проверки изменила проверяемый commit или файлы');
  if (result.code !== 0) {
    const diagnostics = buildDiagnosticPack({
      stdout: value.stdout,
      stderr: value.stderr,
      secrets: engine.secrets,
    });
    row.diagnostics = diagnostics;
    return {
      row,
      error: Object.assign(
        fail(
          `Проверка ${step.kind} не пройдена (exit ${result.code}): ${(value.stdout + value.stderr).slice(-6000)}`,
          'check_failed',
        ),
        { diagnostics },
      ),
    };
  }
  if (npm?.error?.code === 'cancelled') return { row, error: npm.error };
  // npm passed, but its plain `node --test` passed no test by Kodo's events: not a pass. A counting run
  // that failed, stopped or gave no complete event file leaves the decision to npm's exit code.
  if (npm?.count.tests === 0)
    return {
      row,
      error: fail(
        `Скрипт npm ${npm.count.resolved.script} завершился успешно, но его node --test не выполнил успешно ни одного теста (по событиям репортёра Kodo 0)`,
        'fast_check_no_tests',
      ),
    };
  if (direct) {
    // Exit 0 after passing nothing (only skip/todo, no tests, no complete event file) is not a pass:
    // never cache it.
    row.tests = nodeTestOutcome(direct, observed)?.tests ?? null;
    if (!(row.tests > 0)) return { row, noTests: true, unknown: row.tests === null };
  }
  if (input)
    await writeCheckCache({
      home: engine.store.home,
      fingerprint: cacheFingerprint(input),
      project: input.project,
      headSha,
      input,
      receipt: {
        kind: 'test',
        status: 'passed',
        exitCode: 0,
        complete: true,
        headSha,
        command: step.command,
        args: step.args,
        evidence: [{ path: evidence.path, bytes: evidence.bytes, sha256: evidence.sha256 }],
      },
    });
  return { row };
}

/**
 * Run the fast plan on the clean HEAD of `run.cwd` and record `run.checks`.
 * Throws `check_failed`, `fast_check_timeout` or `dirty_worktree` like the full checks do.
 * @param {{ engine: any, run: any, signal?: AbortSignal }} input
 */
export async function runFastChecks({ engine, run, signal }) {
  const timeoutMs = fastCheckTimeout(run);
  validateCommandTimeouts(run.config.commands);
  await engine.setup(run.cwd, run, signal);
  const headSha = await git(run.cwd, ['rev-parse', 'HEAD']);
  await assertClean(run.cwd, headSha, 'Проверка commit требует чистого integration worktree');
  let plan = await planFastChecks({ run, cwd: run.cwd, baseSha: run.baseSha, headSha });
  if (!plan.commands.length) throw new Error('Не настроена команда проверки результата');
  let outcome = await executePlan({ engine, run, plan, headSha, signal });
  if (outcome.noTests) {
    // The narrowed run executed no test: run the configured commands.test in full instead.
    engine.log(run, 'fast_checks_no_tests', { headSha, testFiles: plan.testFiles.length });
    plan = {
      ...plan,
      affected: [],
      testFiles: [],
      fallback: true,
      reasons: ['no-tests-executed'],
      commands: fullCommands(run.config.commands.test || [], timeoutMs),
    };
    if (!plan.commands.length) throw new Error('Не настроена команда проверки результата');
    outcome = await executePlan({ engine, run, plan, headSha, signal });
  }
  run.checks.complete = true;
  run.lastDiagnostics = null;
  engine.save(run);
  engine.log(run, 'fast_checks', {
    headSha,
    fallback: plan.fallback,
    commands: outcome.results.length,
    cached: outcome.results.filter(row => row.cached).length,
  });
  return run.checks;
}

/**
 * A full `node --test` run passed with an unknown outcome: the command cannot be counted (a
 * selecting or unknown option, see countedRunner) or the event file of Kodo's reporter is missing,
 * malformed or incomplete. Like zero passed tests, it is never a green receipt.
 * @param {boolean} counted whether Kodo ran the command with its reporters (countingPlan)
 */
const summaryUnknown = counted =>
  fail(
    counted
      ? 'Полный прогон node --test не дал полного журнала событий репортёра Kodo: число пройденных тестов неизвестно'
      : 'Полный прогон node --test нельзя подсчитать: у команды есть опция отбора тестов, watch-режим или неизвестная опция',
    'fast_check_summary_unknown',
  );

/** Record a fresh, incomplete receipt for the plan and execute its commands in order. */
async function executePlan({ engine, run, plan, headSha, signal }) {
  const results = [];
  run.checks = {
    schemaVersion: 2,
    profile: TASK_FAST_PROFILE,
    headSha,
    // Domain-separated: a fast receipt can never carry the fingerprint of the full checks.
    fingerprint: sha256(
      JSON.stringify({
        profile: TASK_FAST_PROFILE,
        headSha,
        commands: plan.commands,
        countVersion: TEST_COUNT_VERSION,
        runtime: {
          node: process.version,
          abi: process.versions.modules,
          platform: process.platform,
          arch: process.arch,
        },
      }),
    ),
    plan: {
      changed: plan.changed,
      affected: plan.affected,
      testFiles: plan.testFiles,
      fallback: plan.fallback,
      reasons: plan.reasons,
      ...(plan.truncated ? { truncated: true } : {}),
    },
    complete: false,
    results,
  };
  engine.save(run);
  const env = fastEnvironment();
  const cache = plan.fallback ? null : await cacheContext(run, plan, headSha, env);
  const tests = plan.commands.filter(step => step.kind === 'test');
  // A simple npm script command is also counted by the plain `node --test` of the checked commit's package.json.
  const context = await npmContextFor(run.cwd, headSha, tests);
  const plans = plan.commands.map(step => (step.kind === 'test' ? countingPlan(step, context) : null));
  // The full suite is judged by its sum only when every test command is a `node --test` counted by
  // Kodo; an npm script's counting run is extra evidence that fails on its own zero only.
  const judged = plan.commands.every((step, index) => step.kind !== 'test' || plans[index]?.step);
  let passed = 0;
  for (const [index, step] of plan.commands.entries()) {
    engine.checkCancelled(run, signal);
    const counting = plans[index];
    const { row, error, noTests, unknown } = await runStep({
      engine,
      run,
      step,
      headSha,
      env,
      cache,
      counting,
      signal,
    });
    results.push(row);
    if (error?.diagnostics) {
      run.checks.diagnostics = error.diagnostics;
      run.lastDiagnostics = error.diagnostics;
    }
    engine.save(run);
    if (error) throw error;
    // A narrowed run that passed no test is replaced by the full suite.
    if (noTests && !plan.fallback) return { results, noTests: true };
    // A full `node --test` run whose outcome is unknown proves nothing (see summaryUnknown).
    if (plan.fallback && step.kind === 'test' && (unknown || (!counting && nodeTestCommand(step))))
      throw summaryUnknown(Boolean(counting?.step));
    passed += row.tests ?? 0;
  }
  if (plan.fallback && judged && passed === 0)
    throw fail(
      'Полный прогон commands.test (node --test) не выполнил успешно ни одного теста: все тесты пропущены (skip/todo) или не найдены',
      'fast_check_no_tests',
    );
  return { results, noTests: false };
}
