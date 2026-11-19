import test from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { countTestEvents, countingArguments, executeCheck, nodeTestOutcome } from '../runtime/task-fast-checks.mjs';

// Review finding (major): `node --test` was counted from the text of its summary on stdout. A
// directory with an empty index.js, user output without a newline glued to the synthetic line of a
// file without tests and a `describe` named like a file gave wrong counts. Kodo now counts the
// events of its own reporter (runtime/test-count-reporter.mjs).

const event = (fields = {}) => ({
  type: 'test:pass',
  kind: 'test',
  nesting: 1,
  name: 'works',
  file: path.resolve('a.test.mjs'),
  line: 3,
  column: 5,
  skip: false,
  todo: false,
  ...fields,
});
const lines = (...events) => [...events, { type: 'end' }].map(row => `${JSON.stringify(row)}\n`).join('');
const destination = path.resolve(os.tmpdir(), 'kodo-test-events-x', 'events.jsonl');
const observed = (step, testEvents, args = countingArguments(step.args, destination)) => ({
  executed: { command: step.command, args },
  testEvents,
});

test('countTestEvents counts passed tests only: no suites, skips, todos, failures or synthetic file tests', () => {
  assert.equal(countTestEvents(lines(event(), event({ name: 'other', line: 4 }))), 2);
  assert.equal(countTestEvents(lines(event({ kind: 'suite', nesting: 0, name: 'index.mjs', line: 1 }))), 0);
  assert.equal(countTestEvents(lines(event({ skip: true }), event({ todo: true }))), 0);
  assert.equal(countTestEvents(lines(event({ type: 'test:fail' }))), 0);
  // A file without tests: one top-level test named after the file, at 1:1.
  const file = path.resolve('tests', 'empty.test.mjs');
  assert.equal(countTestEvents(lines(event({ nesting: 0, name: 'empty.test.mjs', file, line: 1, column: 1 }))), 0);
  // Node names it by its path as the runner resolved it: relative to its directory, with `..`, or absolute.
  for (const name of [path.join('tests', 'empty.test.mjs'), path.join('..', 'tests', 'empty.test.mjs'), file])
    assert.equal(countTestEvents(lines(event({ nesting: 0, name, file, line: 1, column: 1 }))), 0, name);
  assert.equal(
    countTestEvents(lines(event({ nesting: 0, name: path.join('other', 'empty.test.mjs'), file, line: 1, column: 1 }))),
    1,
    'a path that names another file',
  );
  // A directory resolved to its index.js is reported under the directory's name.
  const directory = path.resolve('tests');
  assert.equal(countTestEvents(lines(event({ nesting: 0, name: 'tests', file: directory, line: 1, column: 1 }))), 0);
  // A real top-level test is counted, even one named like its file but declared elsewhere.
  assert.equal(countTestEvents(lines(event({ nesting: 0, name: 'empty.test.mjs', file, line: 2, column: 1 }))), 1);
  assert.equal(countTestEvents(lines()), 0);
});

test('countTestEvents gives no count for a missing, malformed or incomplete event file', () => {
  const complete = lines(event());
  for (const [label, text] of [
    ['missing', null],
    ['not text', 42],
    ['empty', ''],
    ['no end line', `${JSON.stringify(event())}\n`],
    ['cut in the middle', complete.slice(0, -5)],
    ['no final newline', complete.slice(0, -1)],
    ['text after the end', `${complete}${JSON.stringify(event())}\n`],
    ['malformed line', `{"type":\n${complete}`],
    ['unknown type', lines({ ...event(), type: 'test:diagnostic' })],
    ['skip not boolean', lines({ ...event(), skip: 'reason' })],
    ['end with extra fields', `${JSON.stringify(event())}\n${JSON.stringify({ type: 'end', tests: 9 })}\n`],
  ])
    assert.equal(countTestEvents(text), null, label);
});

test('countingArguments replaces every reporter option and keeps the rest of the command in order', () => {
  const [spec, stdout, kodo, file] = countingArguments(['--test'], destination);
  assert.deepEqual(
    [spec, stdout, file],
    ['--test-reporter=spec', '--test-reporter-destination=stdout', `--test-reporter-destination=${destination}`],
  );
  assert.match(kodo, /^--test-reporter=file:\/\/.+\/runtime\/test-count-reporter\.mjs$/);
  const tail = args => countingArguments(args, destination).slice(4);
  const head = args => countingArguments(args, destination)[0];
  assert.deepEqual(tail(['--test', '--test-reporter', 'dot', '--import', 'x.mjs', 'tests/']), [
    '--test',
    '--import',
    'x.mjs',
    'tests/',
  ]);
  assert.deepEqual(tail(['--test_reporter=junit', '--test-reporter-destination', 'out.xml', '--test']), ['--test']);
  // After `--` every argument is a test path, even one that looks like a reporter option.
  assert.deepEqual(tail(['--test', '--', '--test-reporter=dot']), ['--test', '--', '--test-reporter=dot']);
  // The diagnostic reporter is the command's single spec or tap reporter, otherwise spec.
  assert.equal(head(['--test', '--test-reporter=tap']), '--test-reporter=tap');
  assert.equal(head(['--test', '--test-reporter', 'tap']), '--test-reporter=tap');
  assert.equal(head(['--test', '--test-reporter=dot']), '--test-reporter=spec');
  assert.equal(head(['--test', '--test-reporter=tap', '--test-reporter=dot']), '--test-reporter=spec');
});

test('nodeTestOutcome counts the event file of exactly the executed counting command, never stdout', () => {
  const step = { command: 'node', args: ['--test', '--test-reporter=tap'] };
  const one = lines(event());
  assert.deepEqual(nodeTestOutcome(step, observed(step, one)), { tests: 1 });
  // stdout claiming more tests changes nothing; no event file is no count.
  assert.deepEqual(nodeTestOutcome(step, { ...observed(step, one), stdout: '# tests 5\n# pass 5\n' }), { tests: 1 });
  assert.deepEqual(nodeTestOutcome(step, { ...observed(step, null), stdout: '# tests 5\n# pass 5\n' }), {
    tests: null,
  });
  assert.deepEqual(nodeTestOutcome(step, undefined), { tests: null });
  // The executed arguments must be Kodo's counting arguments of this very command.
  const counting = countingArguments(step.args, destination);
  for (const args of [
    step.args,
    [...counting, '--test-name-pattern=nothing'],
    countingArguments(['--test'], destination),
    countingArguments(step.args, 'events.jsonl'),
    counting.with(2, '--test-reporter=dot'),
  ])
    assert.deepEqual(nodeTestOutcome(step, observed(step, one, args)), { tests: null }, args.join(' '));
  assert.deepEqual(
    nodeTestOutcome(step, { executed: { command: process.execPath, args: counting }, testEvents: one }),
    { tests: null },
    'another executable',
  );
  // A command that selects tests is never counted, whatever its events say.
  const filtered = { command: 'node', args: ['--test', '--test-name-pattern=a'] };
  assert.deepEqual(nodeTestOutcome(filtered, observed(filtered, one)), { tests: null });
  assert.equal(nodeTestOutcome({ command: 'node', args: ['verify.mjs'] }, observed(step, one)), null);
});

/** A throwaway project in the system temporary directory. */
async function project(t, files) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'kodo-count-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const [name, text] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(root, name)), { recursive: true });
    await writeFile(path.join(root, name), text);
  }
  return root;
}
const env = extra => {
  const value = { ...process.env, ...extra };
  for (const name of Object.keys(value))
    if (/^(?:NODE_TEST_CONTEXT|NODE_TEST_WORKER_ID|NODE_OPTIONS)$/i.test(name)) delete value[name];
  return value;
};
async function counted(cwd, args, extra = {}) {
  const step = { command: process.execPath, args };
  const outcome = await executeCheck(step, { cwd, env: env(extra), allowFailure: true, timeoutMs: 60000 }, true);
  assert.equal(outcome.error, null);
  assert.equal(outcome.result.code, 0, outcome.result.stdout + outcome.result.stderr);
  return { ...outcome, tests: nodeTestOutcome(step, outcome)?.tests };
}
const imports = "import { describe, it, test } from 'node:test';\n";

test('A real node --test run is counted by its events: empty index.js, glued output, describe named like a file', async t => {
  const root = await project(t, {
    'tests/index.js': '',
    'glued.test.mjs': "process.stdout.write('loading... ');\n",
    'suite.test.mjs': `${imports}describe('index.mjs', () => {\n  it('works', () => {});\n});\n`,
    'empty.test.mjs': 'export const value = 1;\n',
    'skips.test.mjs': `${imports}test.skip('skipped', () => {});\ntest.todo('planned');\ntest('runtime skip', t => t.skip());\n`,
  });
  // `node --test tests/` runs tests/index.js: an empty file is not a passed test.
  assert.equal((await counted(root, ['--test', 'tests/'])).tests, 0);
  assert.equal((await counted(root, ['--test', '--test-reporter=tap', 'tests/'])).tests, 0);
  // Output without a newline glued to the synthetic line of a file without tests changes nothing.
  for (const reporter of ['spec', 'tap'])
    assert.equal(
      (await counted(root, ['--test', `--test-reporter=${reporter}`, 'glued.test.mjs', 'suite.test.mjs'])).tests,
      1,
      reporter,
    );
  // A describe named like a file is a suite: its one passing test counts.
  assert.equal((await counted(root, ['--test', 'suite.test.mjs'])).tests, 1);
  assert.equal((await counted(root, ['--test', 'empty.test.mjs'])).tests, 0, 'a file without tests');
  // A file without tests in another directory is named by its path from the runner's directory.
  for (const [cwd, file] of [
    [root, 'tests/index.js'],
    [root, './tests/index.js'],
    [root, path.join(root, 'tests', 'index.js')],
    [path.join(root, 'tests'), '../glued.test.mjs'],
  ])
    assert.equal((await counted(cwd, ['--test', file])).tests, 0, file);
  assert.equal((await counted(root, ['--test', '--test-isolation=none', 'tests/index.js'])).tests, 0);
  assert.equal((await counted(root, ['--test', 'skips.test.mjs'])).tests, 0, 'skip and todo are not passes');
  // Colour codes in the diagnostic output do not reach the count.
  const all = ['--test', 'glued.test.mjs', 'suite.test.mjs', 'empty.test.mjs', 'skips.test.mjs'];
  for (const colour of [{ FORCE_COLOR: '1' }, { FORCE_COLOR: '3' }, { NO_COLOR: '1' }])
    assert.equal((await counted(root, all, colour)).tests, 1, JSON.stringify(colour));
});

test('Kodo replaces the reporters of a counted run and removes its private event file', async t => {
  const root = await project(t, {
    'a.test.mjs': `${imports}test('a', () => {});\ntest('b', () => {});\n`,
  });
  const run = await counted(root, ['--test', '--test-reporter=junit', '--test-reporter-destination=report.xml']);
  assert.equal(run.tests, 2);
  // The user's reporter never ran: no report file appeared in the project.
  await assert.rejects(() => access(path.join(root, 'report.xml')), { code: 'ENOENT' });
  assert.match(run.result.stdout, /✔ a/u, 'the diagnostic spec reporter writes to stdout');
  assert.deepEqual(JSON.parse(run.testEvents.trim().split('\n').at(-1)), { type: 'end' });
  const destination = /^--test-reporter-destination=(.+)$/.exec(run.executed.args[3])[1];
  assert.ok(path.isAbsolute(destination) && !destination.startsWith(root), destination);
  await assert.rejects(() => access(path.dirname(destination)), { code: 'ENOENT' }, 'the event directory is removed');
});
