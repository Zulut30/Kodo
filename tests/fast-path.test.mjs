import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { validatePlan } from '../runtime/contracts.mjs';
import { defaultFixtures } from '../runtime/benchmark-fixtures.mjs';
import {
  FAST_PATH_LIMITS,
  classifyLocalTask,
  fastPathAllowsPlan,
  fastPathPlan,
  regressionTestPaths,
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
    'index.html': '<h1>Title</h1>\n',
    'verify.cjs': "require('node:assert');\n",
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

/** The decision of a style proof: its write list is exactly its files. */
const style = (...files) => ({ fastPath: true, reason: 'style_only', files, writePaths: files });
/** The decision of a code proof: the files plus the regression tests of its sources. */
const code = (...files) => ({
  fastPath: true,
  reason: 'small_local',
  files,
  writePaths: [...files, ...files.flatMap(regressionTestPaths)],
});

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

test('Names in a command are arguments to run, not targets to write', async t => {
  // The benchmark prompt: `verify.cjs` is the check to run, not a file to edit.
  const [buttonColor] = defaultFixtures;
  const benchmark = repository(t, buttonColor.files);
  assert.deepEqual(await classifyLocalTask({ cwd: benchmark.cwd, task: buttonColor.prompt }), style('src/button.css'));
  const cwd = fixture(t);
  for (const task of [
    'Fix the off-by-one error in src/app.mjs. Run node verify.cjs.',
    'Fix the off-by-one error in src/app.mjs and run `node --test tests/app.test.mjs`',
    'Fix the off-by-one error in src/app.mjs, then execute verify.cjs',
    'Исправь ошибку в src/app.mjs и запусти node verify.cjs',
    'Исправь ошибку в src/app.mjs, выполни `npm run check -- verify.cjs`',
    'Fix the off-by-one error in src/app.mjs and run npm test',
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

test('A task that restricts the edit gets no test paths', async t => {
  const cwd = fixture(t);
  for (const task of [
    'Fix the off-by-one error in src/app.mjs. Edit only src/app.mjs.',
    'Исправь ошибку только в src/app.mjs',
    'Fix the off-by-one error in src/app.mjs; do not touch other files',
  ])
    assert.deepEqual(
      await classifyLocalTask({ cwd, task }),
      { fastPath: true, reason: 'small_local', files: ['src/app.mjs'], writePaths: ['src/app.mjs'] },
      task,
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
    await classifyLocalTask({ cwd, task: 'Fix the off-by-one error in src/app.mjs' }),
    code('src/app.mjs'),
  );
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

test('Regression test paths are a fixed list derived from the named sources', () => {
  const paths = regressionTestPaths('src/app.mjs');
  for (const expected of [
    'tests/app.test.mjs',
    'test/app.test.mjs',
    'src/app.test.mjs',
    'src/__tests__/app.test.mjs',
    'tests/app.spec.mjs',
    'src/__tests__/app.spec.js',
  ])
    assert.ok(paths.includes(expected), expected);
  for (const forbidden of [
    'tsconfig.test.json',
    'tests/package.json',
    'tests/helpers/app.mjs',
    'tests/fixtures/app.test.mjs',
    'tests/app.test.ts',
    'src/app.mjs',
  ])
    assert.ok(!paths.includes(forbidden), forbidden);
  assert.ok(
    paths.every(name => !/[*?[\]{}]/.test(name)),
    'literal paths, no masks',
  );
  assert.ok(regressionTestPaths('src/view.tsx').includes('src/__tests__/view.test.tsx'));
  assert.ok(regressionTestPaths('app.ts').includes('__tests__/app.spec.ts'));
  assert.deepEqual(regressionTestPaths('src/styles/button.css'), [], 'styles get no tests');
  assert.deepEqual(regressionTestPaths('index.html'), []);
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
    [{ task: 'Удали src/app.mjs' }, 'risk_marker'],
    [{ task: `Remove ${button}` }, 'risk_marker'],
    [{ task: 'Create a new file next to src/app.mjs' }, 'risk_marker'],
    [{ task: 'Добавь файл рядом с src/app.mjs' }, 'risk_marker'],
    [{ task: 'Создай новый файл для src/app.mjs' }, 'risk_marker'],
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
    [{ task: 'Add .pre-commit-config.yaml and edit src/app.mjs' }, 'non_style_path'],
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
    plan([]),
    plan(),
    {},
    null,
  ])
    assert.equal(fastPathAllowsPlan(outside, files), false, JSON.stringify(outside));
});

test('A small local code plan may also write the derived regression tests, and nothing else', () => {
  const allowed = ['src/app.mjs', ...regressionTestPaths('src/app.mjs')];
  const plan = (...scopes) => ({ tasks: scopes.map(writePaths => ({ writePaths })) });
  for (const inside of [
    plan(['src/app.mjs']),
    plan(allowed),
    plan(['src/app.mjs', 'tests/app.test.mjs']),
    plan(['src/app.mjs'], ['src/__tests__/app.spec.mjs']),
  ])
    assert.equal(fastPathAllowsPlan(inside, allowed), true, JSON.stringify(inside));
  for (const outside of [
    plan(['src/app.mjs', 'src/other.mjs']),
    plan(['src/app.mjs', 'tsconfig.test.json']),
    plan(['src/app.mjs', 'tests/package.json']),
    plan(['src/app.mjs', 'tests/helpers/app.mjs']),
    plan(['src/app.mjs', '**/*.test.*']),
    plan(['src/app.mjs', 'tests/**']),
    plan(['src/app.mjs', 'tests/.env']),
    plan(['src/**']),
  ])
    assert.equal(fastPathAllowsPlan(outside, allowed), false, JSON.stringify(outside));
});

test('The local fast-path plan is one deterministic, valid developer node inside the proof', () => {
  const task = 'Fix the off-by-one error in src/app.mjs';
  const proof = code('src/app.mjs');
  const plan = fastPathPlan(task, proof);
  assert.deepEqual(plan, fastPathPlan(task, proof), 'deterministic');
  validatePlan(plan);
  assert.equal(plan.tasks.length, 1);
  const [node] = plan.tasks;
  assert.deepEqual([node.role, node.dependsOn, node.parallel], ['developer', [], false]);
  assert.deepEqual(node.writePaths, proof.writePaths, 'the same list as the proof');
  assert.ok(node.description.includes(task), 'the full task reaches the worker');
  assert.ok(
    node.acceptance.some(item => /regression test/i.test(item)),
    'a behaviour change needs a regression test',
  );
  assert.ok(
    !node.acceptance.some(item => /is made in src\/app\.mjs/.test(item)),
    'no demand to change every named file',
  );
  assert.equal(fastPathAllowsPlan(plan, proof.writePaths), true);

  // A restricted edit asks for no test.
  const restricted = fastPathPlan(`${task}. Edit only src/app.mjs.`, {
    reason: 'small_local',
    files: ['src/app.mjs'],
    writePaths: ['src/app.mjs'],
  });
  assert.deepEqual(restricted.tasks[0].writePaths, ['src/app.mjs']);
  assert.ok(!restricted.tasks[0].acceptance.some(item => /regression test/i.test(item)));

  const styled = fastPathPlan('Make src/styles/button.css blue', style('src/styles/button.css'));
  validatePlan(styled);
  assert.deepEqual(styled.tasks[0].writePaths, ['src/styles/button.css']);
  assert.ok(!styled.tasks[0].acceptance.some(item => /regression test/i.test(item)));

  // A proof saved before the kind and the list were recorded is a style proof of its files.
  const legacy = fastPathPlan('Make a.css blue', { files: ['a.css'] });
  assert.doesNotMatch(legacy.summary, /undefined/);
  assert.match(legacy.summary, /style_only/);
  assert.deepEqual(legacy.tasks[0].writePaths, ['a.css']);
});
