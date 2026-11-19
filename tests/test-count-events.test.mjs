import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { countTestEvents, countingArguments, executeCheck, nodeTestOutcome } from '../runtime/task-fast-checks.mjs';

// Event files go under Kodo's state home: every test here uses a private one, never the real one.
const isolatedHome = await mkdtemp(path.join(os.tmpdir(), 'kodo-count-state-'));
const originalHome = process.env.KODO_HOME;
process.env.KODO_HOME = isolatedHome;
after(async () => {
  if (originalHome === undefined) delete process.env.KODO_HOME;
  else process.env.KODO_HOME = originalHome;
  await rm(isolatedHome, { recursive: true, force: true });
});

// Review finding (major): `node --test` was counted from the text of its summary on stdout. A
// directory with an empty index.js, user output without a newline glued to the synthetic line of a
// file without tests and a `describe` named like a file gave wrong counts. Kodo now counts the
// events of its own reporter (runtime/test-count-reporter.mjs).

// Kodo's reporter records no names or paths: only what the count needs.
const event = (fields = {}) => ({
  type: 'test:pass',
  kind: 'test',
  nesting: 1,
  line: 3,
  column: 5,
  skip: false,
  todo: false,
  ...fields,
});
const lines = (...events) =>
  [...events, { type: 'end' }]
    .map(
      row => `${JSON.stringify(row)}
`,
    )
    .join('');
const destination = path.resolve(os.tmpdir(), 'kodo-test-events-x', 'events.jsonl');
const observed = (step, testEvents, args = countingArguments(step.args, destination)) => ({
  executed: { command: step.command, args },
  testEvents,
});

test('countTestEvents counts passed tests only: no suites, skips, todos, failures or placeholder tests', () => {
  assert.equal(countTestEvents(lines(event(), event({ line: 4 }))), 2);
  assert.equal(countTestEvents(lines(event({ kind: 'suite', nesting: 0, line: 1, column: 1 }))), 0);
  assert.equal(countTestEvents(lines(event({ skip: true }), event({ todo: true }))), 0);
  assert.equal(countTestEvents(lines(event({ type: 'test:fail' }))), 0);
  // Node's placeholder for a file or directory without tests (however the path was given,
  // including ../ from a subdirectory): a top-level test at 1:1.
  assert.equal(countTestEvents(lines(event({ nesting: 0, line: 1, column: 1 }))), 0);
  // A real top-level test is counted when it is not at 1:1.
  assert.equal(countTestEvents(lines(event({ nesting: 0, line: 2, column: 1 }))), 1);
  assert.equal(countTestEvents(lines(event({ nesting: 1, line: 1, column: 1 }))), 1, 'nested at 1:1 is real');
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

test('A receipt from Kodo installed elsewhere is still recognized: only the reporter location differs', () => {
  const step = { command: 'node', args: ['--test'] };
  const one = lines(event());
  const counting = countingArguments(step.args, destination);
  // The same reporter module of another Kodo install (an upgrade or a moved checkout).
  const moved = counting.with(2, '--test-reporter=file:///D:/other/install/runtime/test-count-reporter.mjs');
  assert.deepEqual(nodeTestOutcome(step, observed(step, one, moved)), { tests: 1 });
  // A different module name is not Kodo's reporter.
  const foreign = counting.with(2, '--test-reporter=file:///D:/other/install/runtime/my-reporter.mjs');
  assert.deepEqual(nodeTestOutcome(step, observed(step, one, foreign)), { tests: null });
});

test('Review findings: ../ from a subdirectory, masked names and an in-project TEMP', async t => {
  const root = await project(t, {
    'parent/index.js': '',
    'parent/child/keep.txt': '',
    'named.test.mjs': `${imports}test('rejects Bearer bad\\\\', () => {});\n`,
    'tmp.test.mjs':
      "import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport os from 'node:os';\n" +
      "import { readdirSync } from 'node:fs';\ntest('temp is empty', () => assert.deepEqual(readdirSync(os.tmpdir()), []));\n",
  });
  // An empty parent directory run as ../ from a subdirectory is Node's placeholder, not a test.
  assert.equal((await counted(path.join(root, 'parent', 'child'), ['--test', '../'])).tests, 0);
  // The event file holds no test names: masking it cannot change the count.
  const { redact } = await import('../runtime/security.mjs');
  const named = await counted(root, ['--test', 'named.test.mjs']);
  assert.equal(named.tests, 1);
  assert.ok(!named.testEvents.includes('Bearer'), 'no names are recorded');
  assert.equal(countTestEvents(redact(named.testEvents, {})), 1);
  // The tests' TEMP is left alone, even inside the project or relative: the event file lives in Kodo's state home.
  await mkdir(path.join(root, '.tmp'));
  const inside = path.join(root, '.tmp');
  assert.equal(
    (await counted(root, ['--test', 'tmp.test.mjs'], { TEMP: inside, TMP: inside, TMPDIR: inside })).tests,
    1,
  );
  await mkdir(path.join(root, 'tmp'));
  assert.equal((await counted(root, ['--test', 'tmp.test.mjs'], { TEMP: 'tmp', TMP: 'tmp', TMPDIR: 'tmp' })).tests, 1);
});

test('The event directory is never created inside the project: the source checkout or through a link', async t => {
  const root = await project(t, {
    'a.test.mjs': `${imports}test('a', () => {});
`,
  });
  const outside = await project(t, {
    'b.test.mjs': `${imports}test('b', () => {});
`,
  });
  const scratch = await project(t, {});
  const step = { command: process.execPath, args: ['--test', 'b.test.mjs'] };
  const run = roots =>
    executeCheck(step, { cwd: outside, env: env({}), allowFailure: true, timeoutMs: 60000 }, true, roots);
  // Every KODO_HOME below is a path this test created; the original value is only restored.
  const previous = process.env.KODO_HOME;
  t.after(() => {
    if (previous === undefined) delete process.env.KODO_HOME;
    else process.env.KODO_HOME = previous;
  });
  const { symlink } = await import('node:fs/promises');
  const link = async (target, name) => {
    const at = path.join(scratch, name);
    await symlink(target, at, 'junction');
    return at;
  };
  // Kodo's state home inside the source checkout, the check running in an external worktree.
  process.env.KODO_HOME = path.join(root, '.kodo-state');
  await assert.rejects(() => run([root]), { code: 'fast_check_events_location' });
  await assert.rejects(() => access(path.join(root, '.kodo-state', 'test-events')), { code: 'ENOENT' });
  // A link outside the project that points into it is resolved to its real place.
  await mkdir(path.join(root, 'state'));
  process.env.KODO_HOME = await link(path.join(root, 'state'), 'into-source');
  await assert.rejects(() => run([root]), { code: 'fast_check_events_location' });
  // A path written inside the project whose real place is outside is accepted: only real paths count.
  const real = path.join(scratch, 'real-home');
  await mkdir(real);
  await symlink(real, path.join(root, 'state-link'), 'junction');
  process.env.KODO_HOME = path.join(root, 'state-link');
  assert.equal(nodeTestOutcome(step, await run([root]))?.tests, 1);
  // A real home inside the project stays refused even when its test-events link leads outside.
  const events = path.join(scratch, 'events');
  await mkdir(events);
  await mkdir(path.join(root, 'inner-home'));
  await symlink(events, path.join(root, 'inner-home', 'test-events'), 'junction');
  process.env.KODO_HOME = await link(path.join(root, 'inner-home'), 'to-inner');
  await assert.rejects(() => run([root]), { code: 'fast_check_events_location' });
  // An ordinary state home outside both roots works.
  process.env.KODO_HOME = path.join(scratch, 'home');
  assert.equal(nodeTestOutcome(step, await run([root]))?.tests, 1);
});

test('Without a working directory the process directory is the project: no event file is written inside it', async t => {
  const root = await project(t, {
    'c.test.mjs': `${imports}test('c', () => {});
`,
  });
  const previous = { cwd: process.cwd(), home: process.env.KODO_HOME };
  const step = { command: process.execPath, args: ['--test', 'c.test.mjs'] };
  // Restored before the project directory is removed (Windows refuses to remove the current directory).
  process.chdir(root);
  try {
    process.env.KODO_HOME = './state';
    await assert.rejects(() => executeCheck(step, { env: env({}) }, true), { code: 'fast_check_events_location' });
    await assert.rejects(() => access(path.join(root, 'state')), { code: 'ENOENT' });
  } finally {
    process.chdir(previous.cwd);
    process.env.KODO_HOME = previous.home;
  }
});

test('Directories that differ only by a Unicode case fold are different directories', async t => {
  const scratch = await project(t, {});
  const { symlink } = await import('node:fs/promises');
  const [ascii, kelvin, worktree, events] = ['Repo-K', 'Repo-K', 'worktree', 'events-outside'].map(name =>
    path.join(scratch, name),
  );
  for (const directory of [ascii, kelvin, worktree, events]) await mkdir(directory);
  await writeFile(path.join(worktree, 'd.test.mjs'), `${imports}test('d', () => {});\n`);
  await symlink(events, path.join(kelvin, 'test-events'), 'junction');
  const previous = process.env.KODO_HOME;
  process.env.KODO_HOME = kelvin;
  try {
    const step = { command: process.execPath, args: ['--test', 'd.test.mjs'] };
    const outcome = await executeCheck(
      step,
      { cwd: worktree, env: env({}), allowFailure: true, timeoutMs: 60000 },
      true,
      [ascii],
    );
    assert.equal(nodeTestOutcome(step, outcome)?.tests, 1);
  } finally {
    process.env.KODO_HOME = previous;
  }
});

test('A counting run that cannot be prepared leaves the npm result in place with an unknown count', async t => {
  const { countingPlan, countNpmScript, npmCountOutcome } = await import('../runtime/task-fast-checks.mjs');
  const root = await project(t, { 'e.test.mjs': `${imports}test('e', () => {});\n` });
  const plan = countingPlan(
    { command: 'npm', args: ['test'] },
    { packageText: JSON.stringify({ scripts: { test: 'node --test' } }), npmrc: false },
  )?.npm;
  assert.ok(plan, 'a simple npm script has a counting plan');
  // Kodo's state home where test-events is a file: the event directory cannot be created.
  const home = await mkdtemp(path.join(os.tmpdir(), 'kodo-count-blocked-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  await writeFile(path.join(home, 'test-events'), 'not a directory');
  const previous = process.env.KODO_HOME;
  process.env.KODO_HOME = home;
  try {
    const counted = await countNpmScript(plan, { cwd: root, env: env({}), allowFailure: true, timeoutMs: 60000 }, []);
    assert.equal(counted.error, null);
    assert.deepEqual(counted.count, { resolved: plan.resolved, executed: null, exitCode: null, tests: null });
    assert.match(counted.logged.unavailable, /^count_unavailable:[A-Z_]+$/i);
    assert.deepEqual(npmCountOutcome(plan, counted.logged), { tests: null });
    // Anything else in such a record is not accepted.
    assert.equal(npmCountOutcome(plan, { ...counted.logged, tests: 3 }), null);
  } finally {
    process.env.KODO_HOME = previous;
  }
});
