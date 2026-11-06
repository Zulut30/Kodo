import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmod, lstat, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Engine } from '../runtime/engine.mjs';
import { Store } from '../runtime/store.mjs';
import { execute } from '../runtime/command.mjs';
import { workerEnvironment } from '../runtime/security.mjs';

test('Failed commands retain the actual stdout failure alongside stderr notices for repair diagnosis', async () => {
  await assert.rejects(
    execute(process.execPath, [
      '-e',
      'console.error("npm-style notice");console.log("required behavior assertion failed");process.exit(7);',
    ]),
    error => {
      assert.equal(error.code, 'command_failed');
      assert.match(error.message, /npm-style notice/);
      assert.match(error.message, /required behavior assertion failed/);
      return true;
    },
  );
});

const nullHooks = process.platform === 'win32' ? 'NUL' : '/dev/null';
const shell = value => `'${value.replaceAll('\\', '/').replaceAll("'", "'\\''")}'`;
const selectors = [
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_INDEX_FILE',
  'GIT_COMMON_DIR',
  'GIT_OBJECT_DIRECTORY',
  'GIT_NAMESPACE',
];

test('Worker prompts remove known credentials from analysis and host plans while preserving credential-handling code examples', async t => {
  const f = await fixture(t),
    project = await f.repository('prompt-project');
  const secrets = { GEMINI_API_KEY: 'fixture-private-analysis-123', TYPESAFE_API_KEY: 'fixture-private-host-plan-456' };
  let observed = false;
  const store = f.openStore(),
    engine = new Engine({
      store,
      secrets,
      provider: {
        runSession: async request => {
          observed = true;
          for (const value of Object.values(secrets))
            assert.equal(request.prompt.includes(value), false, 'a known credential reached the worker prompt');
          assert.match(request.prompt, /\[REDACTED\]/);
          assert.ok(request.prompt.includes('Bearer ${token}'), 'generic code text must remain meaningful');
          return { sessionId: 'clean-prompt-worker', output: { summary: 'checked', checks: [], complete: true } };
        },
      },
    });
  const run = store.createRun({
    project,
    cwd: project,
    task: 'safe task',
    state: 'implementing',
    config: { concurrency: 1 },
  });
  const prompt =
    `Analysis: ${secrets.GEMINI_API_KEY}; host plan: ${secrets.TYPESAFE_API_KEY}; ` +
    'Literal source example: Bearer ${token}';
  await engine.session(run, { client: 'codex', model: 'gpt-6.1-sol', cwd: project, prompt }, undefined);
  assert.equal(observed, true);
});
async function exists(filename) {
  try {
    await lstat(filename);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'kodo-finalization-test-'));
  const stores = [];
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([name]) => !selectors.includes(name.toUpperCase())),
  );
  t.after(async () => {
    for (const store of stores) store.close();
    const resolved = path.resolve(root);
    assert.equal(path.dirname(resolved), path.resolve(os.tmpdir()));
    assert.ok(path.basename(resolved).startsWith('kodo-finalization-test-'));
    await rm(resolved, { recursive: true, force: true });
  });
  function raw(cwd, args, environment = env) {
    const result = spawnSync('git', ['-c', `core.hooksPath=${nullHooks}`, '-c', 'commit.gpgsign=false', ...args], {
      cwd,
      env: environment,
      encoding: 'utf8',
      windowsHide: true,
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    return result.stdout.trim();
  }
  async function repository(name) {
    const project = path.join(root, name);
    await mkdir(project);
    raw(project, ['init', '-b', 'main']);
    raw(project, ['config', 'user.name', 'Kodo Finalization Test']);
    raw(project, ['config', 'user.email', 'kodo-finalization@example.invalid']);
    raw(project, ['config', 'commit.gpgsign', 'false']);
    raw(project, ['config', 'core.autocrlf', 'false']);
    await writeFile(path.join(project, 'value.txt'), `${name} base\n`);
    raw(project, ['add', '-A']);
    raw(project, ['commit', '-m', 'baseline']);
    return project;
  }
  async function helper(name, source) {
    const filename = path.join(root, name);
    await writeFile(filename, `#!/bin/sh\n${source}\n`);
    await chmod(filename, 0o755);
    return filename;
  }
  const openStore = () => {
    const store = new Store(path.join(root, 'state'));
    stores.push(store);
    return store;
  };
  return { root, env, raw, repository, helper, openStore };
}

test('Release recovery commits owned package scripts and dependency repairs after version assignment', async t => {
  const f = await fixture(t),
    project = await f.repository('project');
  const assigned = {
    name: 'fixture',
    version: '0.2.0',
    scripts: { test: 'node old.mjs' },
    dependencies: { library: '^1.0.0' },
  };
  await writeFile(path.join(project, 'package.json'), JSON.stringify(assigned));
  f.raw(project, ['add', 'package.json']);
  f.raw(project, ['commit', '-m', 'assign release version']);
  const before = f.raw(project, ['rev-parse', 'HEAD']);
  const store = f.openStore(),
    engine = new Engine({ store });
  const run = store.createRun({
    project,
    cwd: project,
    task: 'repair package configuration',
    headSha: before,
    checks: { previous: true },
    review: { previous: true },
    config: { delivery: { enabled: false, release: true } },
    releaseAssignment: { version: '0.2.0', prepared: true },
    plan: { summary: 'repair package', tasks: [{ id: 'repair', writePaths: ['package.json'] }] },
  });
  const repaired = { ...assigned, scripts: { test: 'node fixed.mjs' }, dependencies: { library: '^1.1.0' } };
  await writeFile(path.join(project, 'package.json'), JSON.stringify(repaired));
  await engine.recoverIntegrationEdits(run);
  const after = f.raw(project, ['rev-parse', 'HEAD']);
  assert.notEqual(after, before);
  assert.deepEqual(JSON.parse(f.raw(project, ['show', 'HEAD:package.json'])), repaired);
  assert.equal(run.headSha, after);
  assert.equal(run.checks, null);
  assert.equal(run.review, null);
  assert.equal(f.raw(project, ['status', '--porcelain']), '');
  await engine.recoverIntegrationEdits(run);
  assert.equal(f.raw(project, ['rev-parse', 'HEAD']), after);
  assert.equal(store.events(run.id).filter(event => event.type === 'repair_recovered').length, 1);
});

function foreignEnvironment(env, project) {
  return {
    ...env,
    GIT_DIR: path.join(project, '.git'),
    GIT_WORK_TREE: project,
    GIT_INDEX_FILE: path.join(project, '.git', 'index'),
    GIT_COMMON_DIR: path.join(project, '.git'),
    GIT_OBJECT_DIRECTORY: path.join(project, '.git', 'objects'),
    GIT_NAMESPACE: 'foreign-namespace',
  };
}

test('Worker Git ignores inherited cross-repository selection variables', async t => {
  const f = await fixture(t),
    project = await f.repository('requested'),
    foreign = await f.repository('foreign');
  const contaminated = foreignEnvironment(f.env, foreign);
  assert.equal(
    await realpath(path.resolve(f.raw(project, ['rev-parse', '--show-toplevel'], contaminated))),
    await realpath(foreign),
    'positive control must select the foreign repository',
  );
  const clean = workerEnvironment(contaminated);
  for (const name of selectors)
    assert.equal(
      Object.keys(clean).some(key => key.toUpperCase() === name),
      false,
      name,
    );
  const child = await execute(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      "import {execFileSync} from 'node:child_process'; process.stdout.write(execFileSync('git',['rev-parse','--show-toplevel'],{encoding:'utf8'}));",
    ],
    { cwd: project, env: clean },
  );
  assert.equal(await realpath(path.resolve(child.stdout.trim())), await realpath(project));
});

test('Coordinator Git commits only the requested repository despite inherited Git selectors', async t => {
  const f = await fixture(t),
    project = await f.repository('requested'),
    foreign = await f.repository('foreign');
  const contaminated = foreignEnvironment(f.env, foreign),
    foreignBefore = f.raw(foreign, ['rev-parse', 'HEAD']);
  await writeFile(path.join(project, 'value.txt'), 'requested repaired\n');
  await execute('git', ['add', '--', 'value.txt'], { cwd: project, env: contaminated });
  await execute('git', ['commit', '-m', 'requested repair'], { cwd: project, env: contaminated });
  assert.equal(f.raw(project, ['show', 'HEAD:value.txt']), 'requested repaired');
  assert.equal(f.raw(project, ['status', '--porcelain']), '');
  assert.equal(f.raw(foreign, ['rev-parse', 'HEAD']), foreignBefore);
  assert.equal(f.raw(foreign, ['status', '--porcelain']), '');
});

test('Coordinator Git diff disables configured external diff and text conversion', async t => {
  const f = await fixture(t),
    project = await f.repository('diff-project');
  await writeFile(path.join(project, '.gitattributes'), '*.txt diff=fixture\n');
  f.raw(project, ['add', '.gitattributes']);
  f.raw(project, ['commit', '-m', 'diff driver']);
  const externalMarker = path.join(f.root, 'external.marker'),
    textMarker = path.join(f.root, 'textconv.marker');
  const external = await f.helper('external-diff', `printf called > ${shell(externalMarker)}\nprintf external-output`);
  const textconv = await f.helper('textconv', `printf called > ${shell(textMarker)}\nprintf converted-output`);
  f.raw(project, ['config', 'diff.external', external.replaceAll('\\', '/')]);
  f.raw(project, ['config', 'diff.fixture.textconv', textconv.replaceAll('\\', '/')]);
  await writeFile(path.join(project, 'value.txt'), 'actual changed text\n');
  f.raw(project, ['diff']);
  assert.equal(await exists(externalMarker), true);
  f.raw(project, ['diff', '--no-ext-diff', '--textconv']);
  assert.equal(await exists(textMarker), true);
  await rm(externalMarker);
  await rm(textMarker);
  const result = await execute('git', ['diff', '--ext-diff', '--textconv'], { cwd: project, env: f.env });
  assert.match(result.stdout, /\+actual changed text/);
  assert.equal(await exists(externalMarker), false);
  assert.equal(await exists(textMarker), false);
});

test('Coordinator Git status disables repository fsmonitor commands', async t => {
  const f = await fixture(t),
    project = await f.repository('monitor-project'),
    marker = path.join(f.root, 'fsmonitor.marker');
  const monitor = await f.helper('fsmonitor', `printf called > ${shell(marker)}\nprintf 'probe-token\\000'`);
  f.raw(project, ['config', 'core.fsmonitor', monitor.replaceAll('\\', '/')]);
  f.raw(project, ['status', '--porcelain']);
  assert.equal(await exists(marker), true);
  await rm(marker);
  await execute('git', ['status', '--porcelain'], { cwd: project, env: f.env });
  assert.equal(await exists(marker), false);
});
