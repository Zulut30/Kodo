import path from 'node:path';
import { mkdir, mkdtemp, readFile, realpath, rm, stat } from 'node:fs/promises';
import { isDeepStrictEqual } from 'node:util';
import { execute } from './command.mjs';
import { stateHome, workerEnvironment } from './security.mjs';

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
export const fail = (message, code) => Object.assign(new Error(message), { code });
const executionReasons = ['cancelled', 'timeout', 'invalid_output', 'command_failed', 'ENOENT', 'EACCES', 'EPERM'];

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
export function nodeTestRunner(commands) {
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

export const stopReason = error => (executionReasons.includes(error.code) ? error.code : 'execution_failed');

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
