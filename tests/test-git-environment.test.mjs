import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, rm, symlink, copyFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const helper = new URL('../scripts/git-test-environment.mjs', import.meta.url).href;
const runner = new URL('../scripts/run-tests.mjs', import.meta.url);

test('Standalone runner imports and executes a fixture without the unshipped Git helper', async t => {
  const { temp } = await installation(t);
  const staged = path.join(temp, 'standalone');
  await mkdir(staged);
  const stagedRunner = path.join(staged, 'run-tests.mjs');
  await copyFile(runner, stagedRunner);
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  delete env.NODE_TEST_WORKER_ID;
  const pathKey = Object.keys(env).find(key => key.toLowerCase() === 'path');
  await writeFile(
    path.join(staged, 'tiny.test.mjs'),
    `
    import test from 'node:test'; import assert from 'node:assert/strict';
    test('standalone fixture',()=>assert.equal(process.env[${JSON.stringify(pathKey)}],${JSON.stringify(env[pathKey])}));
  `,
  );
  const options = { cwd: staged, env, encoding: 'utf8', windowsHide: true, timeout: 5000, maxBuffer: 64 * 1024 };
  const imported = spawnSync(
    process.execPath,
    ['--input-type=module', '-e', `await import(${JSON.stringify(pathToFileURL(stagedRunner).href)});`],
    options,
  );
  assert.equal(imported.status, 0, imported.stdout + imported.stderr);
  const executed = spawnSync(process.execPath, [stagedRunner, 'tiny.test.mjs'], options);
  assert.equal(executed.status, 0, executed.stdout + executed.stderr);
  assert.match(executed.stdout, /ok 1 - standalone fixture/);
  assert.match(executed.stdout, /# tests 1\b/);
  assert.match(executed.stdout, /# pass 1\b/);
  assert.match(executed.stdout, /# fail 0\b/);
});

async function installation(t) {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'kodo-git-env-'));
  t.after(async () => {
    assert.equal(path.dirname(path.resolve(temp)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(temp).startsWith('kodo-git-env-'));
    await rm(temp, { recursive: true, force: true });
  });
  const root = path.join(temp, 'Git');
  const launcher = path.join(root, 'cmd', 'git.exe');
  const core = path.join(root, 'mingw64', 'bin', 'git.exe');
  for (const file of [launcher, core]) {
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, 'owned fixture; metadata execution is mocked');
  }
  return { temp, root, launcher, core };
}

// Only built-in process metadata and child_process probes are mocked, inside a
// fresh child. Path discovery/lstat/native realpath use actual owned files.
function exercise(
  { launcher, core },
  { env, platform = 'win32', probe = 'ok', real = false, cwd, action = 'configure' } = {},
) {
  const script = `
    import assert from 'node:assert/strict';
    import {mock} from 'node:test';
    import cp from 'node:child_process';
    import {syncBuiltinESMExports} from 'node:module';
    const before=${JSON.stringify(env ?? { PaTh: path.dirname(launcher) + ';tail;;Unchanged', HOME: 'keep-home', SENTINEL: 'keep' })};
    mock.property(process,'env',{...before});
    mock.property(process,'platform',${JSON.stringify(platform)});
    const calls=[];
    const mode=${JSON.stringify(probe)};
    if(!${real}) mock.method(cp,'spawnSync',(file,args,options)=>{
      calls.push({file,args,options});
      assert.ok([${JSON.stringify(launcher)},${JSON.stringify(core)}].includes(file));
      assert.ok(args.length===1 && ['--version','--exec-path'].includes(args[0]));
      assert.equal(options.shell,false);
      assert.equal(options.windowsHide,true);
      assert.ok(options.timeout>0 && options.timeout<=5000);
      assert.ok(options.maxBuffer>0 && options.maxBuffer<=64*1024);
      assert.equal(options.encoding,'utf8');
      if(mode==='throw') throw Error('probe failed');
      const candidate=file===${JSON.stringify(core)};
      const execPath=${JSON.stringify(path.join(path.dirname(core), 'git-core'))};
      let stdout=args[0]==='--version' ? 'git version 2.53.0.windows.2\\n' : execPath+'\\n';
      if(candidate && mode===args[0]) stdout+='different';
      if(mode==='empty') stdout='';
      if(mode==='whitespace') stdout=' \\n';
      if(mode==='malformed-version' && args[0]==='--version') stdout='not git\\n';
      if(mode==='malformed-exec' && args[0]==='--exec-path') stdout='relative/path\\n';
      if(mode==='nul') stdout+='\\0';
      if(mode==='nonstring') stdout=42;
      return {status:mode==='nonzero'?1:mode==='null-status'?null:0,stdout,
        error:mode==='error'?Error('ETIMEDOUT'):undefined,
        signal:mode==='signal'?'SIGTERM':null,stderr:mode==='stderr'?'metadata error':''};
    });
    syncBuiltinESMExports();
    const {configureGitTestEnvironment}=await import(${JSON.stringify(helper)});
    assert.equal(configureGitTestEnvironment.length,0,'no authority or testing injection options');
    let rejectedCode;
    const action=${JSON.stringify(action)};
    if(action==='configure') configureGitTestEnvironment();
    else {
      if(action!=='import') process.argv=[process.execPath,${JSON.stringify(fileURLToPath(runner))},...(action==='invalid-cli'?['--watch']:[])];
      await import(${JSON.stringify(runner.href)});
      rejectedCode=process.exitCode;
      process.exitCode=0;
    }
    console.log(JSON.stringify({before,after:{...process.env},calls,rejectedCode}));
  `;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 15000,
    maxBuffer: 1024 * 1024,
    cwd,
  });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  return JSON.parse(result.stdout);
}

test('Git dev bootstrap prepends verified same-install core and preserves PATH casing tail and other env', async t => {
  const layout = await installation(t);
  const { before, after, calls } = exercise(layout);
  assert.deepEqual(after, { ...before, PaTh: path.dirname(layout.core) + ';' + before.PaTh });
  assert.equal(Object.keys(after).filter(key => key.toLowerCase() === 'path').length, 1);
  assert.deepEqual(
    calls.map(({ file, args }) => [file, args]),
    [
      [layout.launcher, ['--version']],
      [layout.core, ['--version']],
      [layout.launcher, ['--exec-path']],
      [layout.core, ['--exec-path']],
    ],
  );
});

test('Git metadata probes receive only allowed OS path and locale env without credentials or config values', async t => {
  const layout = await installation(t);
  const allowed = {
    PaTh: path.dirname(layout.launcher) + ';keep-tail',
    SystemRoot: 'C:\\Windows',
    WINDIR: 'C:\\Windows',
    COMSPEC: 'C:\\Windows\\System32\\cmd.exe',
    PATHEXT: '.COM;.EXE;.BAT;.CMD',
    TEMP: 'C:\\owned-temp',
    TMP: 'C:\\owned-tmp',
    HOME: 'C:\\owned-home',
    USERPROFILE: 'C:\\owned-profile',
    HOMEDRIVE: 'C:',
    HOMEPATH: '\\owned-profile',
    SystemDrive: 'C:',
    GIT_EXEC_PATH: 'C:\\owned-git\\libexec\\git-core',
    LANG: 'en_US.UTF-8',
    lc_all: 'C',
  };
  const env = {
    ...allowed,
    OPENAI_API_KEY: 'fake-openai',
    ANTHROPIC_API_KEY: 'fake-claude',
    GITHUB_TOKEN: 'fake-github',
    GH_TOKEN: 'fake-gh',
    API_TOKEN: 'fake-api',
    KODO_GEMINI_API_KEY: 'fake-google',
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_VALUE_0: 'fake-config-secret',
  };
  const result = exercise(layout, { env });
  assert.equal(result.calls.length, 4);
  for (const call of result.calls) assert.deepEqual(call.options.env, allowed);
  assert.deepEqual(result.after, { ...env, PaTh: path.dirname(layout.core) + ';' + allowed.PaTh });
});

for (const probe of [
  '--version',
  '--exec-path',
  'throw',
  'error',
  'nonzero',
  'null-status',
  'signal',
  'stderr',
  'empty',
  'whitespace',
  'malformed-version',
  'malformed-exec',
  'nul',
  'nonstring',
]) {
  test(`Git dev bootstrap falls back unchanged on probe ${probe}`, async t => {
    const layout = await installation(t);
    const { before, after, calls } = exercise(layout, { probe });
    assert.deepEqual(after, before);
    assert.ok(calls.length > 0 && calls.length <= 4);
  });
}

test('Git dev bootstrap is a non-Windows no-op even with an eligible layout', async t => {
  const result = exercise(await installation(t), { platform: 'linux' });
  assert.deepEqual(result.after, result.before);
  assert.deepEqual(result.calls, []);
});

for (const action of ['import', 'invalid-cli', 'recursive-cli']) {
  test(`Git dev bootstrap does not probe during ${action}`, async t => {
    const layout = await installation(t);
    const env = {
      Path: path.dirname(layout.launcher),
      ...(action === 'recursive-cli' ? { NODE_TEST_CONTEXT: 'child-v8' } : {}),
    };
    const result = exercise(layout, { action, env });
    assert.deepEqual(result.after, result.before);
    assert.deepEqual(result.calls, []);
    if (action !== 'import') assert.equal(result.rejectedCode, 1);
  });
}

test('Git dev bootstrap preserves a custom Git shadowing PATH in the current directory', async t => {
  const layout = await installation(t);
  const cwd = path.join(layout.temp, 'working');
  await mkdir(cwd);
  await writeFile(path.join(cwd, 'git.cmd'), '@echo custom');
  const result = exercise(layout, { cwd });
  assert.deepEqual(result.after, result.before);
  assert.deepEqual(result.calls, []);
});

for (const kind of [
  'custom-first',
  'git-com-first',
  'unknown-launcher-first',
  'core-selected',
  'missing-core',
  'missing-launcher',
  'directory-core',
  'no-path',
  'empty-path',
  'duplicate-keys',
]) {
  test(`Git dev bootstrap preserves environment for ${kind}`, async t => {
    const layout = await installation(t);
    let env = { PATH: path.dirname(layout.launcher), HOME: 'keep', MARKER: 'untouched' };
    if (['custom-first', 'git-com-first', 'unknown-launcher-first'].includes(kind)) {
      const custom = path.join(layout.temp, 'custom');
      await mkdir(custom);
      await writeFile(
        path.join(
          custom,
          kind === 'git-com-first' ? 'git.com' : kind === 'unknown-launcher-first' ? 'git.cmd' : 'git.exe',
        ),
        'custom',
      );
      env.PATH = custom + ';' + env.PATH;
    }
    if (kind === 'core-selected') env.PATH = path.dirname(layout.core) + ';' + env.PATH;
    if (kind === 'missing-core') await rm(layout.core);
    if (kind === 'missing-launcher') await rm(layout.launcher);
    if (kind === 'directory-core') {
      await rm(layout.core);
      await mkdir(layout.core);
    }
    if (kind === 'no-path') delete env.PATH;
    if (kind === 'empty-path') env.PATH = '';
    if (kind === 'duplicate-keys') env.Path = env.PATH;
    const result = exercise(layout, { env });
    assert.deepEqual(result.after, result.before);
    assert.deepEqual(result.calls, []);
  });
}

for (const kind of ['candidate-file', 'launcher-file', 'directory-escape', 'earlier-directory-link']) {
  test(`Git dev bootstrap refuses symlink ${kind}`, async t => {
    const layout = await installation(t);
    const target = path.join(layout.temp, 'outside');
    await mkdir(target);
    await writeFile(path.join(target, 'git.exe'), 'outside Git');
    try {
      if (kind === 'earlier-directory-link') {
        await symlink(target, path.join(layout.temp, 'custom'), process.platform === 'win32' ? 'junction' : 'dir');
      } else if (kind === 'directory-escape') {
        await rm(path.dirname(layout.core), { recursive: true });
        await symlink(target, path.dirname(layout.core), process.platform === 'win32' ? 'junction' : 'dir');
      } else {
        const file = kind === 'candidate-file' ? layout.core : layout.launcher;
        await rm(file);
        await symlink(path.join(target, 'git.exe'), file, 'file');
      }
    } catch (error) {
      if (error.code === 'EPERM' || error.code === 'ENOTSUP') {
        t.skip('host does not allow this symlink type');
        return;
      }
      throw error;
    }
    const options =
      kind === 'earlier-directory-link'
        ? { env: { Path: path.join(layout.temp, 'custom') + ';' + path.dirname(layout.launcher) } }
        : {};
    const result = exercise(layout, options);
    assert.deepEqual(result.after, result.before);
    assert.deepEqual(result.calls, []);
  });
}

test('Git dev bootstrap uses the first real Git installation in PATH', async t => {
  const layout = await installation(t);
  const result = exercise(layout, {
    env: { Path: path.join(layout.temp, 'absent') + ';' + path.dirname(layout.launcher) + ';later', MARKER: 'same' },
  });
  assert.deepEqual(result.after, { ...result.before, Path: path.dirname(layout.core) + ';' + result.before.Path });
});

test('Git dev bootstrap verifies real installed Windows Git and runs status in an owned repository', async t => {
  if (process.platform !== 'win32') {
    t.skip('Windows installed Git only');
    return;
  }
  const { temp } = await installation(t);
  const { lstatSync, realpathSync } = await import('node:fs');
  const key = Object.keys(process.env).find(key => key.toLowerCase() === 'path');
  let launcher;
  for (const directory of (process.env[key] ?? '').split(';')) {
    const file = path.resolve(directory.replace(/^"(.*)"$/, '$1'), 'git.exe');
    try {
      if (lstatSync(file).isFile() && !lstatSync(file).isSymbolicLink()) {
        launcher = file;
        break;
      }
    } catch {}
  }
  // The outer dev runner may already have prepended the core. Exercise the
  // real wrapper explicitly in an owned child, without changing our PATH.
  if (
    launcher &&
    path.basename(path.dirname(launcher)).toLowerCase() === 'bin' &&
    path.basename(path.dirname(path.dirname(launcher))).toLowerCase() === 'mingw64'
  ) {
    launcher = path.resolve(path.dirname(launcher), '../../cmd/git.exe');
  }
  if (!launcher || path.basename(path.dirname(launcher)).toLowerCase() !== 'cmd') {
    t.skip('installed Git cmd launcher unavailable');
    return;
  }
  const core = path.resolve(path.dirname(launcher), '../mingw64/bin/git.exe');
  try {
    assert.ok(lstatSync(core).isFile());
    realpathSync.native(core);
  } catch {
    t.skip('same-install core unavailable');
    return;
  }
  const result = exercise(
    { launcher, core },
    { real: true, env: { ...process.env, [key]: path.dirname(launcher) + ';' + process.env[key] } },
  );
  assert.equal(result.after[key], path.dirname(core) + ';' + result.before[key]);
  const initialized = spawnSync(core, ['init', '--quiet', temp], {
    env: result.after,
    encoding: 'utf8',
    windowsHide: true,
    timeout: 5000,
  });
  assert.equal(initialized.status, 0, initialized.stderr);
  const status = spawnSync('git', ['status', '--porcelain'], {
    cwd: temp,
    env: result.after,
    encoding: 'utf8',
    windowsHide: true,
    timeout: 5000,
  });
  assert.equal(status.status, 0, status.stderr);
  assert.equal(status.stdout, '?? Git/\n');
});
