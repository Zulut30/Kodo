// Runtime assets, deliberately included by package.json's runtime directory.
// Only `files` and `prompt` go into the subject workspace. Held-out assertions
// are created by the coordinator AFTER the subject session has terminated.
import { createHash } from 'node:crypto';
import { lstat, mkdir, mkdtemp, readdir, readFile, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execute } from './command.mjs';
import { git } from './workspace.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
export const defaultFixtures = Object.freeze([
  Object.freeze({
    id: 'button-color', version: 1, implementation: 'src/button.css',
    prompt: 'Change the normal .button background color to #7c3aed in src/button.css. Preserve the hover, focus-visible and disabled behavior and all other declarations. Edit only src/button.css. Run node verify.cjs. Do not commit, push, create agents or access external services. Return a brief completion report.',
    files: Object.freeze({
      'src/button.css': '.button { background-color: #2563eb; color: #ffffff; border-radius: 4px; }\n.button:hover { background-color: #1d4ed8; }\n.button:focus-visible { outline: 2px solid #111827; outline-offset: 2px; }\n.button:disabled { opacity: 0.5; cursor: not-allowed; }\n',
      'index.html': '<!doctype html><link rel="stylesheet" href="src/button.css"><button class="button">Save</button>\n',
      'verify.cjs': "const assert = require('node:assert/strict'); const fs = require('node:fs'); assert.match(fs.readFileSync('src/button.css','utf8'), /background-color:\\s*#7c3aed/);\n"
    })
  }),
  Object.freeze({
    id: 'filename-extension', version: 1, implementation: 'src/extension.cjs',
    prompt: 'Fix extension(filename) in src/extension.cjs. Return the lowercase extension of the final filename component (both / and backslash separate directories). Dots in directory names do not count. Extensionless names, a leading dot alone (hidden files such as .gitignore), and a trailing dot return an empty string. A hidden name with a later dot, e.g. .config.json, has extension json. Keep the CommonJS export. Edit only src/extension.cjs. Run node verify.cjs. Do not commit, push, create agents or access external services. Return a brief completion report.',
    files: Object.freeze({
      'src/extension.cjs': "function extension(filename) { return filename.split('.').pop(); }\nmodule.exports = { extension };\n",
      'README.md': 'extension(filename) returns a lowercase filename extension without its dot.\n',
      'verify.cjs': "const assert = require('node:assert/strict'); const { extension } = require('./src/extension.cjs'); assert.equal(extension('photo.PNG'), 'png');\n"
    })
  })
]);

export function fixtureHash(fixture) {
  return hash(JSON.stringify({ id: fixture.id, version: fixture.version, implementation: fixture.implementation, prompt: fixture.prompt, files: fixture.files }));
}

export function fixtureConfig({ client, model, mode }) {
  // Legal under both the pre-mode Engine and the mode-aware Engine. Restricting
  // the allowlist also fixes planning, routing, review and repair to this model.
  return {
    schemaVersion: 1, repository: null, baseBranch: 'main', client, primaryModel: model,
    models: { codex: client === 'codex' ? [model] : [], 'claude-code': client === 'claude-code' ? [model] : [] },
    executionMode: mode, concurrency: 1, repairRounds: 1, researchBudget: 0,
    commands: { test: [{ command: 'node', args: ['verify.cjs'] }], build: [], deploy: [], smoke: [] },
    checks: [], delivery: { enabled: false, release: false, firstVersion: '0.2.0' }
  };
}

function initialFiles({ fixture, client, model, mode }) {
  return { ...fixture.files, 'kodo.config.json': JSON.stringify(fixtureConfig({ client, model, mode }), null, 2) + '\n' };
}
export function expectedFixtureSnapshot(options) {
  const result = {};
  for (const [name, text] of Object.entries(initialFiles(options))) {
    const parts = name.split('/');
    for (let i = 1; i < parts.length; i++) result[`${parts.slice(0, i).join('/')}/`] = { type: 'directory' };
    result[name] = { type: 'file', hash: hash(text), size: Buffer.byteLength(text), executable: false };
  }
  return result;
}

export async function snapshotFixture(directory) {
  const files = {}; let count = 0;
  async function visit(relative = '', depth = 0) {
    if (depth > 16) throw new Error('Fixture directory depth exceeded');
    const entries = await readdir(path.join(directory, relative), { withFileTypes: true });
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (!relative && entry.name === '.git') continue;
      if (++count > 1000) throw new Error('Fixture file count exceeded');
      const name = relative ? `${relative}/${entry.name}` : entry.name;
      const filename = path.join(directory, name), info = await lstat(filename);
      if (info.isSymbolicLink() || !info.isDirectory() && !info.isFile()) files[name] = { type: 'unsafe' };
      else if (info.isDirectory()) { files[`${name}/`] = { type: 'directory' }; await visit(name, depth + 1); }
      else files[name] = { type: 'file', hash: info.size > 1024 * 1024 ? null : hash(await readFile(filename)), size: info.size, executable: Boolean(info.mode & 0o111) };
    }
  }
  await visit(); return files;
}

export async function materializeFixture({ directory, fixture, client, model, mode = 'quick' }) {
  directory = path.resolve(directory);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  if ((await readdir(directory)).length) throw new Error('Fixture directory must be empty');
  const files = initialFiles({ fixture, client, model, mode });
  for (const [name, text] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(directory, name)), { recursive: true });
    await writeFile(path.join(directory, name), text, { flag: 'wx' });
  }
  await git(directory, ['init', '-b', 'main']);
  await git(directory, ['config', 'user.name', 'Kodo Benchmark']);
  await git(directory, ['config', 'user.email', 'benchmark@example.invalid']);
  await git(directory, ['config', 'core.autocrlf', 'false']);
  await git(directory, ['add', '--all']);
  // Commit bytes, not just file contents, are identical across each pair.
  const env = { ...process.env, GIT_AUTHOR_DATE: '2000-01-01T00:00:00Z', GIT_COMMITTER_DATE: '2000-01-01T00:00:00Z' };
  await git(directory, ['-c', 'commit.gpgsign=false', 'commit', '-m', 'Benchmark initial fixture'], { env });
  return { directory, initialCommit: await git(directory, ['rev-parse', 'HEAD']), fixtureHash: fixtureHash(fixture), baseline: await snapshotFixture(directory) };
}

// Expectations are literals independent of the public smoke tests and the
// model's completion claim. Subject JS executes only in a timed subprocess/VM
// without require/process, with Node filesystem permissions limited to a copy.
const oracleScript = String.raw`
const fs = require('node:fs'), vm = require('node:vm'), assert = require('node:assert/strict');
const source = fs.readFileSync('implementation', 'utf8');
if (process.argv[2] === 'button-color') {
  const rules = [...source.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/([^{}]+)\{([^{}]*)\}/g)];
  const rest = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/[^{}]+\{[^{}]*\}/g, '').trim();
  assert.equal(rest, ''); assert.equal(rules.length, 4);
  const parsed = {};
  for (const [, selector, body] of rules) {
    const key = selector.trim(); assert.ok(!Object.hasOwn(parsed, key)); parsed[key] = {};
    for (const text of body.split(';').map(x => x.trim()).filter(Boolean)) {
      const colon = text.indexOf(':'); assert.ok(colon > 0);
      const name = text.slice(0,colon).trim(), value = text.slice(colon+1).trim();
      assert.ok(!Object.hasOwn(parsed[key], name)); parsed[key][name] = value;
    }
  }
  assert.deepEqual(parsed, {
    '.button': { 'background-color': '#7c3aed', color: '#ffffff', 'border-radius': '4px' },
    '.button:hover': { 'background-color': '#1d4ed8' },
    '.button:focus-visible': { outline: '2px solid #111827', 'outline-offset': '2px' },
    '.button:disabled': { opacity: '0.5', cursor: 'not-allowed' }
  });
} else {
  const context = vm.createContext(Object.create(null), { codeGeneration: { strings: false, wasm: false } });
  vm.runInContext('const module = { exports: {} }; const exports = module.exports;\n' + source, context, { timeout: 500 });
  const cases = [
    ['image.png','png'],['photo.JPEG','jpeg'],['a.tar.GZ','gz'],['README',''],['',''],
    ['.gitignore',''],['.config.JSON','json'],['trailing.',''],['a.b/README',''],
    ['a.b/file.TXT','txt'],['a.b\\README',''],['dir\\archive.ZIP','zip'],
    ['dir/.hidden',''],['dir.with.dots/sub/file',''],['a..B','b']
  ];
  for (const [input, expected] of cases) assert.equal(vm.runInContext('module.exports.extension(' + JSON.stringify(input) + ')', context, { timeout: 500 }), expected);
}
`;

export async function evaluateFixture({ fixture, cwd, baseline }) {
  let actual;
  try { actual = await snapshotFixture(cwd); }
  catch { return { correctness: { passed: false, code: 'unsafe_workspace' }, scope: { passed: false, violations: 1 } }; }
  const names = new Set([...Object.keys(baseline), ...Object.keys(actual)]);
  let violations = 0;
  for (const name of names) if (name !== fixture.implementation && JSON.stringify(baseline[name]) !== JSON.stringify(actual[name])) violations++;
  const implementation = actual[fixture.implementation];
  if (implementation?.type !== 'file' || implementation.hash === null || implementation.executable !== baseline[fixture.implementation]?.executable) violations++;
  const scope = { passed: violations === 0, violations };
  if (implementation?.type !== 'file' || implementation.size > 65536) return { correctness: { passed: false, code: 'invalid_implementation' }, scope };
  const directory = await mkdtemp(path.join(os.tmpdir(), 'kodo-heldout-'));
  try {
    await writeFile(path.join(directory, 'implementation'), await readFile(path.join(cwd, fixture.implementation)), { mode: 0o600 });
    await writeFile(path.join(directory, 'oracle.cjs'), oracleScript, { mode: 0o600 });
    const result = await execute(process.execPath, ['--permission', `--allow-fs-read=${directory}`, 'oracle.cjs', fixture.id], {
      cwd: directory, env: process.platform === 'win32' ? { SystemRoot: process.env.SystemRoot } : {}, timeoutMs: 5000, allowFailure: true
    });
    // Never expose assertion output or subject code in a benchmark receipt.
    return { correctness: { passed: result.code === 0, code: result.code === 0 ? 'passed' : 'heldout_failed' }, scope };
  } catch { return { correctness: { passed: false, code: 'heldout_failed' }, scope }; }
  finally { await rm(directory, { recursive: true, force: true }); }
}
