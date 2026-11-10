import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { FAST_PATH_LIMITS, classifyLocalTask, fastPathAllowsPlan } from '../runtime/fast-path.mjs';

function fixture(t) {
  const cwd = mkdtempSync(path.join(os.tmpdir(), 'kodo-fast-path-'));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const git = (...args) => {
    const result = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true });
    assert.equal(result.status, 0, result.stderr);
  };
  mkdirSync(path.join(cwd, 'src/styles'), { recursive: true });
  mkdirSync(path.join(cwd, '.config'));
  for (const [name, text] of [
    ['src/styles/button.css', '.button { color: red; }\n'],
    ['src/styles/theme.scss', '$accent: red;\n'],
    ['src/styles/a.css', 'a {}\n'],
    ['src/styles/b.css', 'b {}\n'],
    ['src/styles/huge.css', `/* ${'x'.repeat(FAST_PATH_LIMITS.fileBytes)} */\n`],
    ['src/app.mjs', 'export const app = 1;\n'],
    ['.config/hidden.css', 'x {}\n'],
  ])
    writeFileSync(path.join(cwd, name), text);
  git('init', '-b', 'main');
  git('config', 'user.name', 'Fast Path Test');
  git('config', 'user.email', 'fast-path@example.invalid');
  git('add', '.');
  git('commit', '-m', 'Fixture');
  writeFileSync(path.join(cwd, 'src/styles/untracked.css', ''), 'u {}\n');
  return cwd;
}

test('A short task naming only existing tracked style files is a fast path', async t => {
  const cwd = fixture(t);
  assert.deepEqual(await classifyLocalTask({ cwd, task: 'Make the button in src/styles/button.css blue.' }), {
    fastPath: true,
    reason: 'style_only',
    files: ['src/styles/button.css'],
  });
  const two = await classifyLocalTask({
    cwd,
    task: 'Сделай акцент синим: src/styles/theme.scss, src/styles/button.css',
    requested: 'quick',
  });
  assert.deepEqual(two.files, ['src/styles/button.css', 'src/styles/theme.scss']);
  // Sentence punctuation and quotes around a path are not part of it.
  const quoted = await classifyLocalTask({ cwd, task: 'Darken the hover state. File: "src/styles/button.css".' });
  assert.deepEqual(quoted.files, ['src/styles/button.css']);
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
    [{ task: `Remove the old rules from ${button}` }, 'risk_marker'],
    [{ task: `Удали старые правила из ${button}` }, 'risk_marker'],
    [{ task: 'Make the button blue' }, 'no_paths'],
    [{ task: `Make ${button} blue and update src/app.mjs` }, 'non_style_path'],
    [{ task: `Make ${button} blue as described in docs/design.md` }, 'non_style_path'],
    [{ task: `Make ${button} match Node.js branding` }, 'non_style_path'],
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
  ];
  for (const [input, reason] of cases)
    assert.deepEqual(await classifyLocalTask({ cwd, ...input }), { fastPath: false, reason }, JSON.stringify(input));
});

test('A fast-path plan may write only the proven files, literally', () => {
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
