import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { validatePlan } from '../runtime/contracts.mjs';
import { defaultFixtures } from '../runtime/benchmark-fixtures.mjs';
import {
  FAST_PATH_LIMITS,
  FAST_PATH_VERSION,
  classifyLocalTask,
  fastPathAllowsPlan,
  fastPathOutdated,
  fastPathPlan,
} from '../runtime/fast-path.mjs';

/** A committed repository with `files`; returns a git runner for extra setup. */
function repository(t, files) {
  const cwd = mkdtempSync(path.join(os.tmpdir(), 'kodo-fast-path-'));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const git = (...args) => {
    const result = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true });
    assert.equal(result.status, 0, result.stderr);
    return result;
  };
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(cwd, name)), { recursive: true });
    writeFileSync(path.join(cwd, name), text);
  }
  git('init', '-b', 'main');
  git('config', 'user.name', 'Fast Path Test');
  git('config', 'user.email', 'fast-path@example.invalid');
  git('add', '.');
  git('commit', '-m', 'Fixture');
  return { cwd, git };
}

function fixture(t) {
  const { cwd, git } = repository(t, {
    'src/styles/button.css': '.button { color: red; }\n',
    'src/styles/theme.scss': '$accent: red;\n',
    'src/styles/a.css': 'a {}\n',
    'src/styles/b.css': 'b {}\n',
    'src/styles/huge.css': `/* ${'x'.repeat(FAST_PATH_LIMITS.fileBytes)} */\n`,
    'src/app.mjs': 'export const app = 1;\n',
    'src/view.tsx': 'export const View = () => null;\n',
    'src/big.js': `// ${'x'.repeat(FAST_PATH_LIMITS.fileBytes)}\n`,
    'tests/app.test.mjs': "import '../src/app.mjs';\n",
    'index.html': '<h1>Title</h1>\n',
    'verify.cjs': "require('node:assert');\n",
    'runtime/metrics.mjs': 'export const metrics = 1;\n',
    'runtime/config.mjs': 'export const config = 1;\n',
    'dist/app.js': 'export {};\n',
    'notes.md': '# Notes\n',
    '.config/hidden.css': 'x {}\n',
  });
  writeFileSync(path.join(cwd, 'src/styles/untracked.css', ''), 'u {}\n');
  writeFileSync(path.join(cwd, 'src/untracked.js'), 'export {};\n');
  // An untracked dot-file next to the project: its name is a file here, not a selector.
  writeFileSync(path.join(cwd, '.palette'), 'red\n');
  // A tracked symbolic link and a directory, both with a style name.
  const blob = spawnSync('git', ['hash-object', '-w', '--stdin'], { cwd, input: 'button.css', encoding: 'utf8' });
  git('update-index', '--add', '--cacheinfo', `120000,${blob.stdout.trim()},src/styles/link.css`);
  writeFileSync(path.join(cwd, 'src/styles/link.css'), 'a {}\n');
  mkdirSync(path.join(cwd, 'src/styles/folder.css'));
  writeFileSync(path.join(cwd, 'src/styles/folder.css/inner.txt'), 'x\n');
  git('add', 'src/styles/folder.css/inner.txt');
  return cwd;
}

/** A proof writes exactly the files it names, whatever its kind. */
const style = (...files) => ({ fastPath: true, reason: 'style_only', files, writePaths: files });
const code = (...files) => ({ fastPath: true, reason: 'small_local', files, writePaths: files });

test('A short task naming only existing tracked style files is a fast path', async t => {
  const cwd = fixture(t);
  assert.deepEqual(
    await classifyLocalTask({ cwd, task: 'Make the button in src/styles/button.css blue.' }),
    style('src/styles/button.css'),
  );
  const two = await classifyLocalTask({
    cwd,
    task: 'Сделай акцент синим: src/styles/theme.scss, src/styles/button.css',
    requested: 'quick',
  });
  assert.deepEqual(two, style('src/styles/button.css', 'src/styles/theme.scss'));
  // Numbers with units and typographic quotes do not look like other files.
  for (const task of [
    'Set opacity to 0.8 and padding to 1.5rem in src/styles/button.css',
    'Use rgba(0,0,0,0.5) for the shadow in «src/styles/button.css»',
    'Make the button 50% wider: “src/styles/button.css”',
  ])
    assert.deepEqual((await classifyLocalTask({ cwd, task })).files, ['src/styles/button.css'], task);
  // Sentence punctuation and quotes around a path are not part of it.
  const quoted = await classifyLocalTask({ cwd, task: 'Darken the hover state. File: "src/styles/button.css".' });
  assert.deepEqual(quoted.files, ['src/styles/button.css']);
});

test('A class selector next to proven style files is not a path', async t => {
  const cwd = fixture(t);
  const button = 'src/styles/button.css';
  // Changed deliberately: `.button` was doubt while only paths were recognised. A leading-dot word
  // that is neither tracked nor present, nor a known dot-file, a data file or a secret name, is a
  // CSS selector; only next to style files.
  for (const task of [
    `Make .button blue in ${button}`,
    `Darken .button:hover and .card.is-active in ${button}`,
    `Сделай .btn--large и .card__title синими в ${button}`,
  ])
    assert.deepEqual(await classifyLocalTask({ cwd, task }), style(button), task);
});

test('Names after a known interpreter or package manager are arguments, not targets', async t => {
  // The benchmark prompt: `verify.cjs` is the check to run, not a file to edit.
  const [buttonColor] = defaultFixtures;
  const benchmark = repository(t, buttonColor.files);
  assert.deepEqual(await classifyLocalTask({ cwd: benchmark.cwd, task: buttonColor.prompt }), style('src/button.css'));
  const cwd = fixture(t);
  for (const task of [
    'Fix the off-by-one error in src/app.mjs. Run node verify.cjs.',
    'Исправь ошибку в src/app.mjs и запусти node verify.cjs',
    'Fix the off-by-one error in src/app.mjs and run npm test',
    'Fix the off-by-one error in src/app.mjs, then npm run check',
    'Fix the off-by-one error in src/app.mjs. Edit only src/app.mjs.',
  ])
    assert.deepEqual(await classifyLocalTask({ cwd, task }), code('src/app.mjs'), task);
  // A name that is also a target outside the command is a target.
  assert.deepEqual(
    await classifyLocalTask({ cwd, task: 'Fix verify.cjs and run node verify.cjs' }),
    code('verify.cjs'),
  );
  // A single name in backticks is a name, not a command.
  assert.deepEqual(
    await classifyLocalTask({ cwd, task: 'Fix the off-by-one error in `src/app.mjs`' }),
    code('src/app.mjs'),
  );
  // Only commands remain: nothing is proven.
  assert.deepEqual(await classifyLocalTask({ cwd, task: 'Run node verify.cjs' }), {
    fastPath: false,
    reason: 'no_paths',
  });
});

test('A code proof writes only the named files; a test is writable only when it is named', async t => {
  const cwd = fixture(t);
  assert.deepEqual(
    await classifyLocalTask({ cwd, task: 'Fix the off-by-one error in src/app.mjs' }),
    code('src/app.mjs'),
  );
  assert.deepEqual(
    await classifyLocalTask({
      cwd,
      task: 'Fix the off-by-one error in src/app.mjs and cover it in tests/app.test.mjs',
    }),
    code('src/app.mjs', 'tests/app.test.mjs'),
  );
});

test('Updating or deleting the content of named files is not a risk marker', async t => {
  const cwd = fixture(t);
  const button = 'src/styles/button.css';
  for (const task of [
    `Удали старые правила из ${button}`,
    `Обнови цвет кнопки в ${button}`,
    `Обновить отступы в ${button}`,
    `Удалить тень у кнопки в ${button}`,
    `Удали неиспользуемое свойство color в ${button}`,
    `Remove the old rules from ${button}`,
    `Delete the unused shadow in ${button}`,
  ])
    assert.deepEqual(await classifyLocalTask({ cwd, task }), style(button), task);
  assert.deepEqual(
    await classifyLocalTask({ cwd, task: 'Remove the unused export from src/app.mjs' }),
    code('src/app.mjs'),
  );
});

test('One to three small tracked source files are a small local code change', async t => {
  const cwd = fixture(t);
  assert.deepEqual(
    await classifyLocalTask({ cwd, task: 'Make src/styles/button.css blue and update src/app.mjs' }),
    code('src/app.mjs', 'src/styles/button.css'),
    'a style file next to a source file makes the code kind',
  );
  assert.deepEqual(
    await classifyLocalTask({ cwd, task: 'Обнови заголовок в index.html и подпись в src/view.tsx' }),
    code('index.html', 'src/view.tsx'),
  );
});

test('With core.ignorecase the canonical index name is used; an ambiguous name is doubt', async t => {
  const repo = repository(t, { 'src/app.mjs': 'export const app = 1;\n' });
  repo.git('config', 'core.ignorecase', 'true');
  assert.deepEqual(
    await classifyLocalTask({ cwd: repo.cwd, task: 'Fix the off-by-one error in SRC/App.mjs' }),
    code('src/app.mjs'),
  );
  const blob = spawnSync('git', ['hash-object', '-w', '--stdin'], { cwd: repo.cwd, input: 'x', encoding: 'utf8' });
  repo.git('update-index', '--add', '--cacheinfo', `100644,${blob.stdout.trim()},src/APP.mjs`);
  assert.deepEqual(await classifyLocalTask({ cwd: repo.cwd, task: 'Fix the off-by-one error in src/app.mjs' }), {
    fastPath: false,
    reason: 'path_ambiguous',
  });
});

test('A named file reached through a linked directory is outside the worktree', async t => {
  const repo = repository(t, { 'inside/app.mjs': 'export const app = 1;\n' });
  const outside = mkdtempSync(path.join(os.tmpdir(), 'kodo-fast-path-outside-'));
  t.after(() => rmSync(outside, { recursive: true, force: true }));
  writeFileSync(path.join(outside, 'app.mjs'), 'export const app = 2;\n');
  rmSync(path.join(repo.cwd, 'inside'), { recursive: true, force: true });
  try {
    symlinkSync(outside, path.join(repo.cwd, 'inside'), process.platform === 'win32' ? 'junction' : 'dir');
  } catch (error) {
    t.skip(`cannot create a directory link here: ${error.code}`);
    return;
  }
  // The index still records `inside/app.mjs` as a regular file.
  assert.deepEqual(await classifyLocalTask({ cwd: repo.cwd, task: 'Fix inside/app.mjs' }), {
    fastPath: false,
    reason: 'path_outside',
  });
});

test('A path is a write target only in the clause of an edit verb', async t => {
  const cwd = fixture(t);
  assert.deepEqual(await classifyLocalTask({ cwd, task: 'Edit runtime/config.mjs' }), code('runtime/config.mjs'));
  // The four examples of the review: another role, a negation, an unknown role, deleting an obsolete file.
  for (const [task, reason] of [
    ['Read runtime/metrics.mjs and edit runtime/config.mjs', 'ambiguous'],
    ['Edit runtime/config.mjs but never edit runtime/metrics.mjs', 'ambiguous'],
    ['Fix runtime/config.mjs, then eslint runtime/metrics.mjs', 'ambiguous'],
    ['Delete obsolete runtime/metrics.mjs', 'risk_marker'],
    // The same roles in other words.
    ['Compare runtime/metrics.mjs with runtime/config.mjs and fix runtime/config.mjs', 'ambiguous'],
    ['Исправь runtime/config.mjs, но не меняй логику, посмотри runtime/metrics.mjs', 'ambiguous'],
    ['Прочитай runtime/metrics.mjs и исправь runtime/config.mjs', 'ambiguous'],
    ['Fix runtime/config.mjs; you must not edit runtime/metrics.mjs', 'ambiguous'],
    ['runtime/metrics.mjs', 'ambiguous'],
    ['Удали устаревший runtime/metrics.mjs', 'risk_marker'],
  ])
    assert.deepEqual(await classifyLocalTask({ cwd, task }), { fastPath: false, reason }, task);
});

test('Every ambiguity is doubt, not a guess', async t => {
  const cwd = fixture(t);
  const cases = [
    // An exclusion or negation next to a path.
    'Fix src/app.mjs except src/view.tsx',
    'Fix src/app.mjs without touching src/view.tsx',
    'Fix src/app.mjs; do not change src/view.tsx',
    "Fix src/app.mjs but don't modify src/view.tsx",
    'Исправь src/app.mjs, не меняй src/view.tsx',
    'Исправь src/app.mjs, но не трогай src/view.tsx',
    'Исправь всё в src/app.mjs кроме экспорта',
    // A run verb with an unknown way to run a name, or an unknown tool with options.
    'Fix src/app.mjs, then execute verify.cjs',
    'Fix src/app.mjs and run eslint on src/view.tsx',
    'Исправь src/app.mjs и запусти verify.cjs',
    'Fix src/app.mjs; eslint --fix src/view.tsx',
    // Several words in backticks: a command whose meaning is not read.
    'Fix src/app.mjs and run `node --test tests/app.test.mjs`',
    'Исправь src/app.mjs, выполни `npm run check`',
  ];
  for (const task of cases)
    assert.deepEqual(await classifyLocalTask({ cwd, task }), { fastPath: false, reason: 'ambiguous' }, task);
});

test('Every doubt returns the ordinary route with its reason', async t => {
  const cwd = fixture(t);
  const button = 'src/styles/button.css';
  const cases = [
    [{ task: `Make ${button} blue`, requested: 'standard' }, 'mode_requested'],
    [{ task: `Make ${button} blue`, requested: 'deep' }, 'mode_requested'],
    [{ task: '' }, 'task_invalid'],
    [{ task: `Make ${button} blue. ${'More words. '.repeat(80)}` }, 'task_too_long'],
    [{ task: `Copy the palette from https://example.invalid/a.css into ${button}` }, 'url'],
    [{ task: `Make ../outside/${button} blue` }, 'path_not_relative'],
    [{ task: `Make /etc/${button} blue` }, 'path_not_relative'],
    [{ task: `Hide the login button in ${button}` }, 'risk_marker'],
    // Deleting or creating a file, dependencies, packages, keys and permissions remain risks.
    [{ task: `Удали файл ${button}` }, 'risk_marker'],
    [{ task: `Delete the file ${button}` }, 'risk_marker'],
    [{ task: 'Delete src/app.mjs' }, 'risk_marker'],
    [{ task: 'Delete "src/app.mjs"' }, 'risk_marker'],
    [{ task: 'Удали src/app.mjs' }, 'risk_marker'],
    [{ task: 'Удали «src/app.mjs»' }, 'risk_marker'],
    [{ task: 'Run git rm -f src/app.mjs' }, 'risk_marker'],
    [{ task: `Remove ${button}` }, 'risk_marker'],
    [{ task: 'Create a new file next to src/app.mjs' }, 'risk_marker'],
    [{ task: 'Добавь файл рядом с src/app.mjs' }, 'risk_marker'],
    [{ task: 'Создай новый файл для src/app.mjs' }, 'risk_marker'],
    [{ task: 'Create src/helper.mjs for src/app.mjs' }, 'risk_marker'],
    [{ task: `Add .palette to ${button}` }, 'risk_marker'],
    [{ task: `Добавь .palette в ${button}` }, 'risk_marker'],
    [{ task: `Обнови зависимости и цвет в ${button}` }, 'risk_marker'],
    [{ task: `Установи пакет для анимации в ${button}` }, 'risk_marker'],
    [{ task: 'Move the API key into src/app.mjs' }, 'risk_marker'],
    [{ task: 'Поменяй ключи доступа в src/app.mjs' }, 'risk_marker'],
    [{ task: 'Выдай права администратора в src/app.mjs' }, 'risk_marker'],
    [{ task: 'Check permissions in src/app.mjs' }, 'risk_marker'],
    [{ task: 'Run npm audit fix for src/app.mjs' }, 'risk_marker'],
    [{ task: 'Fix src/app.mjs with npx some-tool' }, 'risk_marker'],
    [{ task: 'Make the button blue' }, 'no_paths'],
    // A selector alone proves nothing, and it never hides a name next to code.
    [{ task: 'Make .button blue' }, 'no_paths'],
    [{ task: 'Make .button blue in src/app.mjs' }, 'non_style_path'],
    // A configuration or data name is never a selector or an argument-free mention.
    [{ task: 'Read .pre-commit-config.yaml and edit src/app.mjs' }, 'non_style_path'],
    [{ task: `Make ${button} blue per .stylelintrc.json` }, 'non_style_path'],
    [{ task: 'Read settings.yaml in src/app.mjs' }, 'non_style_path'],
    [{ task: `Make ${button} blue as described in docs/design.md` }, 'non_style_path'],
    [{ task: 'Fix the typo in notes.md' }, 'non_style_path'],
    [{ task: 'Fix the bundle in dist/app.js' }, 'non_style_path'],
    // Shaped like a source file, so it must be a tracked one.
    [{ task: `Make ${button} match Node.js branding` }, 'path_untracked'],
    [{ task: 'Fix src/untracked.js' }, 'path_untracked'],
    [{ task: 'Fix src/big.js' }, 'file_too_large'],
    [{ task: 'Fix src/app.mjs, src/view.tsx, index.html and src/styles/a.css' }, 'too_many_files'],
    // Dot-files are not selectors: a known name, a secret name or a file that exists.
    [{ task: `Use the registry from .npmrc in ${button}` }, 'non_style_path'],
    [{ task: `Use .palette colours in ${button}` }, 'non_style_path'],
    [{ task: `Load .pem from ${button}` }, 'non_style_path'],
    [{ task: `Recolour ${button} src/styles/theme.scss src/styles/a.css src/styles/b.css` }, 'too_many_files'],
    [{ task: 'Make .config/hidden.css blue' }, 'non_style_path'],
    // Anything that looks like another file is doubt, whatever its shape.
    [{ task: `Make ${button} blue and add DEBUG=1 to .env` }, 'non_style_path'],
    [{ task: `Make ${button} blue and fix обработчик.js` }, 'non_style_path'],
    [{ task: `Make ${button} blue, unpack icons.7z` }, 'non_style_path'],
    [{ task: `Make ${button} blue per app.properties` }, 'non_style_path'],
    [{ task: `Make ${button} blue and restart src/server` }, 'non_style_path'],
    [{ task: `Make ${button} blue as in v1.2` }, 'non_style_path'],
    // Risk words are matched inside longer words too.
    [{ task: `Style the oauth button in ${button}` }, 'risk_marker'],
    [{ task: `Recolour ${button} before the redeploy` }, 'risk_marker'],
    [{ task: `Покрась кнопку «платёж» в ${button}` }, 'risk_marker'],
    [{ task: `Покрась кнопку базы данных в ${button}` }, 'risk_marker'],
    [{ task: 'Make src/styles/untracked.css blue' }, 'path_untracked'],
    [{ task: 'Make src/styles/missing.css blue' }, 'path_untracked'],
    [{ task: 'Make src/styles/huge.css blue' }, 'file_too_large'],
    // The index entry is a symbolic link even where the working tree shows a plain file.
    [{ task: 'Make src/styles/link.css blue' }, 'path_not_file'],
    [{ task: 'Make src/styles/folder.css blue' }, 'path_not_file'],
    // A number with a suffix that is not a CSS unit still looks like a file.
    [{ task: `Make ${button} blue and unpack 2.7z` }, 'non_style_path'],
    [{ task: `Make ${button} blue as in 1.0a` }, 'non_style_path'],
  ];
  for (const [input, reason] of cases)
    assert.deepEqual(await classifyLocalTask({ cwd, ...input }), { fastPath: false, reason }, JSON.stringify(input));
});

test('A fast-path plan may write only the listed paths, literally', () => {
  const files = ['src/styles/button.css', 'src/styles/theme.scss'];
  const plan = (...scopes) => ({ tasks: scopes.map(writePaths => ({ writePaths })) });
  assert.equal(fastPathAllowsPlan(plan(['src/styles/button.css']), files), true);
  assert.equal(fastPathAllowsPlan(plan(['src/styles/button.css'], ['src/styles/theme.scss']), files), true);
  for (const outside of [
    plan(['src/styles/button.css', 'src/app.mjs']),
    plan(['src/styles/*.css']),
    plan(['src/styles']),
    plan(['src/styles/button.css'], ['tests/button.test.mjs']),
    plan(['src/styles/button.css', '**/*.test.*']),
    plan([]),
    plan(),
    {},
    null,
  ])
    assert.equal(fastPathAllowsPlan(outside, files), false, JSON.stringify(outside));
});

test('The local fast-path plan is one deterministic, valid developer node of the named files', () => {
  const task = 'Fix the off-by-one error in src/app.mjs';
  const proof = { ...code('src/app.mjs'), version: FAST_PATH_VERSION };
  const plan = fastPathPlan(task, proof);
  assert.deepEqual(plan, fastPathPlan(task, proof), 'deterministic');
  validatePlan(plan);
  assert.equal(plan.tasks.length, 1);
  const [node] = plan.tasks;
  assert.deepEqual([node.role, node.dependsOn, node.parallel], ['developer', [], false]);
  assert.deepEqual(node.writePaths, ['src/app.mjs'], 'only the named file');
  assert.ok(node.description.includes(task), 'the full task reaches the worker');
  assert.ok(!node.acceptance.some(item => /regression test|test file/i.test(item)), 'no test is demanded');
  assert.ok(!node.acceptance.some(item => /is made in src\/app\.mjs/.test(item)), 'no demand to change every file');
  assert.equal(fastPathAllowsPlan(plan, proof.writePaths), true);

  // A named test is the one test the node may and should update.
  const tested = fastPathPlan(`${task} and cover it in tests/app.test.mjs`, {
    ...code('src/app.mjs', 'tests/app.test.mjs'),
    version: FAST_PATH_VERSION,
  });
  assert.deepEqual(tested.tasks[0].writePaths, ['src/app.mjs', 'tests/app.test.mjs']);
  assert.ok(tested.tasks[0].acceptance.some(item => item.includes('tests/app.test.mjs')));

  const styled = fastPathPlan('Make src/styles/button.css blue', style('src/styles/button.css'));
  validatePlan(styled);
  assert.deepEqual(styled.tasks[0].writePaths, ['src/styles/button.css']);

  // A style proof saved before the kind and the list were recorded is a style proof of its files.
  const legacy = fastPathPlan('Make a.css blue', { files: ['a.css'] });
  assert.doesNotMatch(legacy.summary, /undefined/);
  assert.match(legacy.summary, /style_only/);
  assert.deepEqual(legacy.tasks[0].writePaths, ['a.css']);
});

test('A saved code proof of an unreleased intermediate format is outdated; a style proof is not', () => {
  assert.equal(fastPathOutdated({ version: 1, reason: 'style_only', files: ['a.css'] }), false);
  assert.equal(fastPathOutdated({ files: ['a.css'] }), false);
  assert.equal(fastPathOutdated({ version: 2, reason: 'small_local', files: ['a.mjs'] }), true, 'no write list');
  assert.equal(
    fastPathOutdated({
      version: 2,
      reason: 'small_local',
      files: ['a.mjs'],
      writePaths: ['a.mjs', 'tests/a.test.mjs'],
    }),
    true,
    'derived test paths',
  );
  assert.equal(
    fastPathOutdated({ version: FAST_PATH_VERSION, reason: 'small_local', files: ['a.mjs'], writePaths: ['a.mjs'] }),
    false,
  );
});
