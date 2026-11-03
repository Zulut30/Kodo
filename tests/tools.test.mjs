import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, writeFile, rm, readdir, symlink } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { gzipSync, deflateRawSync } from 'node:zlib';
import { toolCatalog, installTools, resolveTool, doctorTools, formatToolContext } from '../runtime/tools.mjs';
import { extractNativeArchive } from '../runtime/toolchains.mjs';

const pins = { 'agent-desktop': '1.0.2', 'browser-use': '0.13.14', 'browser-harness': '0.1.13', vibetest: '0.1.0', 'jev-ultrafast': '0.1.0', 'chrome-devtools-mcp': '1.12.0', semgrep: '1.183.0', gitleaks: '8.30.1', ripgrep: '15.2.0' };
const npmIntegrity = {
  'agent-desktop': 'sha512-k2Qi3f0y1U60YaJOw1dob3EO55P/DuH4HK3WKdI9sMZLjVxpGZAzuG50rIWuIqS0JIVy07g+0pp9Of2JDjTX0w==',
  'chrome-devtools-mcp': 'sha512-lAGpH0zXT1ZdaPefP1KK/MvxwihOlu7VGQ7p4wbhD9OhN17vUC4KWk/ImUYR9DE4s+7r4r0ySV4xr2OkTa7ZMA=='
};
const digest = data => createHash('sha256').update(data).digest('hex');
async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'kodo-tools-test-'));
  const project = path.join(root, 'project'), home = path.join(root, 'tools');
  await mkdir(project); await mkdir(path.join(project, '.git'));
  t.after(async () => {
    assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
    assert.match(path.basename(root), /^kodo-tools-test-/);
    await rm(root, { recursive: true, force: true });
  });
  return { root, project, home };
}

// This fakes only external installation/probing. Resolver, hashes, receipts and
// all files they inspect are real. These are never live-tool acceptance results.
function npmRunner({ badIntegrity = false, badChecksum = false, failProbe = false, binPrefix = '' } = {}) {
  const calls = [];
  const runner = async (command, args, options) => {
    calls.push({ command, args, options });
    if (command === 'npm') {
      const target = options.cwd;
      const pkg = JSON.parse(await readFile(path.join(target, 'package.json')));
      const [id, version] = Object.entries(pkg.dependencies)[0];
      assert.equal(version, pins[id]);
      assert.ok(args.includes('--ignore-scripts'));
      assert.ok(!args.includes('-g') && !args.includes('--global'));
      if (args.includes('--package-lock-only')) {
        await writeFile(path.join(target, 'package-lock.json'), JSON.stringify({ lockfileVersion: 3, packages: { '': pkg, [`node_modules/${id}`]: { version, integrity: badIntegrity ? 'sha512-wrong' : npmIntegrity[id], resolved: `https://registry.npmjs.org/${id}/-/${id}-${version}.tgz` } } }));
      } else {
        const folder = path.join(target, 'node_modules', id);
        await mkdir(path.join(folder, 'bin'), { recursive: true });
        await writeFile(path.join(folder, 'package.json'), JSON.stringify({ name: id, version, bin: { [id]: binPrefix + 'build/src/bin/chrome-devtools-mcp.js' } }));
        if (id === 'agent-desktop') {
          const name = `agent-desktop-${process.platform}-${process.arch}${process.platform === 'win32' ? '.exe' : ''}`;
          const bytes = Buffer.from('offline native fixture');
          await writeFile(path.join(folder, 'bin', name), bytes);
          await writeFile(path.join(folder, 'bin', name + '.sha256'), badChecksum ? '0'.repeat(64) : digest(bytes));
          if (process.platform !== 'win32') {
            const helper = process.platform === 'darwin' ? 'agent-desktop-macos-helper' : 'agent-desktop-linux-clipboard-owner';
            await writeFile(path.join(folder, 'bin', `${helper}-${process.platform}-${process.arch}`), bytes);
            await writeFile(path.join(folder, 'bin', `${helper}-${process.platform}-${process.arch}.sha256`), digest(bytes));
          }
        } else {
          await mkdir(path.join(folder, 'build/src/bin'), { recursive: true });
          await writeFile(path.join(folder, 'build/src/bin/chrome-devtools-mcp.js'), '/* offline MCP fixture */');
        }
      }
      return { code: 0, stdout: '', stderr: '' };
    }
    if (failProbe) return { code: 1, stdout: 'not ready', stderr: 'private-output-must-not-escape' };
    return { code: 0, stdout: command.includes('agent-desktop') ? 'agent-desktop 1.0.2\n' : '1.12.0\n', stderr: '' };
  };
  return { runner, calls };
}

test('Catalog exposes exactly the approved pins and immutable native digests', () => {
  assert.deepEqual(Object.fromEntries(toolCatalog.map(t => [t.id, t.version])), pins);
  assert.equal(toolCatalog.find(t => t.id === 'vibetest').revision, 'fe0b90ac9d6a129ce06f5b53074241a9f205015b');
  assert.equal(toolCatalog.find(t => t.id === 'jev-ultrafast').revision, '8251e272398011cdef648965204d1c20cd838333');
  for (const id of ['gitleaks', 'ripgrep']) {
    assert.equal(Object.keys(toolCatalog.find(t => t.id === id).assets).length, 6);
    for (const asset of Object.values(toolCatalog.find(t => t.id === id).assets)) assert.match(asset.sha256, /^[a-f0-9]{64}$/);
  }
  assert.throws(() => { toolCatalog[0].version = 'latest'; }, TypeError);
});

test('Import, missing resolve and doctor do not install or contact browsers', async t => {
  const fx = await fixture(t);
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', `globalThis.fetch=()=>{throw new Error('network forbidden')}; await import(${JSON.stringify(pathToFileURL(path.resolve('runtime/tools.mjs')).href)});`], { env: { ...process.env, KODO_TOOL_HOME: fx.home }, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  let calls = 0;
  const reports = await doctorTools({ ...fx, live: true, runner: async () => { calls++; throw new Error('unexpected execution'); } });
  assert.equal(reports.length, 9); assert.equal(calls, 0);
  for (const report of reports) { assert.equal(report.ready, false); assert.equal(report.status, 'missing'); }
  await assert.rejects(readFile(path.join(fx.home, '.kodo-tools.json')), { code: 'ENOENT' });
});

test('Unknown ids, project descendants, repository ancestors and symlink homes are rejected before execution', async t => {
  const fx = await fixture(t); let calls = 0;
  const runner = async () => { calls++; throw new Error('must not execute'); };
  await assert.rejects(installTools(['ripgrep', '../escape'], { ...fx, runner }), /unknown|id/i);
  await assert.rejects(resolveTool('__proto__', fx), /unknown|id/i);
  for (const home of [fx.project, path.join(fx.project, 'cache'), fx.root, path.parse(fx.root).root, 'relative/tools']) {
    await assert.rejects(installTools(['ripgrep'], { ...fx, home, runner }), /home|project|absolute|unsafe/i);
  }
  const link = path.join(fx.root, 'linked'); await symlink(fx.project, link, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(installTools(['ripgrep'], { ...fx, home: path.join(link, 'tools'), runner }), /symlink|home|project/i);
  assert.equal(calls, 0);
});

test('Unsupported platforms are explicit and never ready', async t => {
  const fx = await fixture(t);
  const result = await resolveTool('ripgrep', { ...fx, platform: 'freebsd', arch: 'x64' });
  assert.equal(result.ready, false); assert.equal(result.status, 'unsupported');
});

test('Npm installs are private, script-free, verified and reused; stale content fails resolution', async t => {
  const fx = await fixture(t), fake = npmRunner();
  const result = await installTools(['agent-desktop', 'chrome-devtools-mcp'], { ...fx, runner: fake.runner });
  assert.equal(result.length, 2); assert.ok(result.every(r => r.ready));
  const desktop = await resolveTool('agent-desktop', fx), chrome = await resolveTool('chrome-devtools-mcp', fx);
  assert.match(desktop.command, /agent-desktop-.+/); assert.deepEqual(desktop.args, []);
  assert.ok(chrome.args.includes('--no-usage-statistics') && chrome.args.includes('--no-performance-crux'));
  assert.equal(chrome.env.NO_UPDATE_CHECKS, '1');
  const before = fake.calls.length;
  await installTools(['agent-desktop'], { ...fx, runner: fake.runner });
  assert.equal(fake.calls.length, before);
  for (const { options } of fake.calls) {
    assert.ok(options.cwd.startsWith(fx.home));
    assert.equal(options.env.GEMINI_API_KEY, undefined); assert.equal(options.env.OPENAI_API_KEY, undefined);
  }
  await writeFile(desktop.command, 'changed executable');
  const stale = await resolveTool('agent-desktop', fx);
  assert.equal(stale.ready, false); assert.equal(stale.status, 'error');
  const reports = await doctorTools({ ...fx, runner: fake.runner });
  assert.equal(reports.find(r => r.id === 'agent-desktop').ready, false);
});

test('Wrong npm integrity or desktop binary checksum cannot yield a ready receipt', async t => {
  for (const failure of [{ badIntegrity: true }, { badChecksum: true }, { failProbe: true }]) {
    const fx = await fixture(t), fake = npmRunner(failure);
    const [result] = await installTools(['agent-desktop'], { ...fx, runner: fake.runner });
    assert.equal(result.ready, false); assert.equal(result.status, 'error');
    assert.ok(!JSON.stringify(result).includes('private-output'));
    assert.equal((await resolveTool('agent-desktop', fx)).ready, false);
    if (failure.badIntegrity) assert.equal(fake.calls.filter(c => c.args[0] === 'ci').length, 0);
  }
});

test('Doctor checks only version/metadata; failed probes and malformed versions never pass', async t => {
  const fx = await fixture(t), fake = npmRunner();
  await installTools(['agent-desktop', 'chrome-devtools-mcp'], { ...fx, runner: fake.runner });
  const calls = [];
  const reports = await doctorTools({ ...fx, live: true, runner: async (command, args, options) => {
    calls.push({ command, args, options }); return { code: 0, stdout: 'unparseable version', stderr: '' };
  } });
  assert.equal(calls.length, 2);
  assert.ok(calls.every(c => c.args.includes('--version')));
  for (const id of ['agent-desktop', 'chrome-devtools-mcp']) assert.equal(reports.find(r => r.id === id).status, 'error');
  const contradictory = await doctorTools({ ...fx, runner: async () => ({ code: 0, stdout: 'Wrong version 99.0.0; expected 1.0.2 or 1.12.0', stderr: '' }) });
  for (const id of ['agent-desktop', 'chrome-devtools-mcp']) assert.equal(contradictory.find(r => r.id === id).ready, false);
});

test('Context is bounded, capability-specific and never reflects arbitrary private input', () => {
  const secret = 'DO-NOT-LEAK-PRIVATE-CONTENT';
  const context = formatToolContext({ stage: 'developer', uiVerification: { enabled: true, goal: secret }, security: { enabled: true, token: secret }, tools: [{ id: 'ripgrep', version: '15.2.0', ready: true, command: secret }, { id: 'browser-use', ready: false, reason: secret }, { id: secret, ready: true }] });
  assert.ok(context.length <= 8000); assert.ok(!context.includes(secret));
  assert.match(context, /rg/); assert.match(context, /scop|област/i);
  assert.match(context, /browser-use.*(?:missing|unavailable|недоступ)/i);
  assert.match(context, /coordinator|координатор/i);
});

function pythonRunner({ malformed = false, wrongCommit = false, missingAsset = false } = {}) {
  const calls = [];
  const runner = async (command, args, options) => {
    calls.push({ command, args, options });
    if (command === 'uv' && args[0] === 'python') return { code: 0, stdout: path.join(options.cwd, 'bootstrap-python.exe'), stderr: '' };
    if (command.endsWith('bootstrap-python.exe')) {
      const venv = args.at(-1), executable = path.join(venv, process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
      await mkdir(path.dirname(executable), { recursive: true }); await writeFile(executable, 'offline interpreter fixture');
      await writeFile(path.join(venv, 'pyvenv.cfg'), 'include-system-site-packages = false\nversion = 3.12.12\n');
    } else if (command === 'uv') {
      assert.deepEqual(args.slice(0, 2), ['pip', 'install']);
      assert.ok(!args.includes('--system') && !args.includes('--upgrade'));
      assert.equal(args[args.indexOf('--link-mode') + 1], 'copy');
      await writeFile(path.join(options.cwd, 'venv', 'package-code.py'), '# offline source fixture');
    } else if (args.includes('--version')) return args.includes('-m') && args.includes('semgrep') ? { code: 2, stdout: '', stderr: 'python -m semgrep is deprecated' } : { code: 0, stdout: '1.183.0\n', stderr: '' };
    else {
      if (malformed) return { code: 0, stdout: 'installed!', stderr: '' };
      if (missingAsset) return { code: 1, stdout: '', stderr: 'Missing snapshot asset' };
      const request = JSON.parse(args.at(-1));
      return { code: 0, stdout: JSON.stringify({ python: '3.12', assets: true, versions: Object.fromEntries(request.map(p => [p.id, p.version])), revisions: Object.fromEntries(request.filter(p => p.git).map(p => [p.id, wrongCommit ? 'bad' : p.revision])) }), stderr: '' };
    }
    return { code: 0, stdout: '', stderr: '' };
  };
  return { runner, calls };
}

test('Chrome MCP accepts the pinned package relative bin spelling and rejects traversal', async t => {
  const fx = await fixture(t), good = npmRunner({ binPrefix: './' });
  const installed = (await installTools(['chrome-devtools-mcp'], { ...fx, runner: good.runner }))[0];
  assert.equal(installed.ready, true);
  assert.equal(installed.env.CHROME_DEVTOOLS_MCP_NO_UPDATE_CHECKS, '1');
  const probe = good.calls.find(c => c.command === process.execPath);
  assert.equal(probe.options.env.CHROME_DEVTOOLS_MCP_NO_UPDATE_CHECKS, '1');
  const other = await fixture(t), bad = npmRunner({ binPrefix: '../' });
  assert.equal((await installTools(['chrome-devtools-mcp'], { ...other, runner: bad.runner }))[0].ready, false);
});

test('Semgrep invokes its supported console entry and uv Git uses invocation-local long paths', async t => {
  const fx = await fixture(t), fake = pythonRunner();
  const results = await installTools(['semgrep','browser-use'], { ...fx, runner: fake.runner });
  assert.ok(results.every(r => r.ready), JSON.stringify(results));
  const semgrep = results[0];
  assert.ok(semgrep.args.includes('-c'));
  assert.ok(semgrep.args.some(arg => arg.includes('semgrep.console_scripts.entrypoint')));
  const pip = fake.calls.find(c => c.command === 'uv' && c.args[0] === 'pip');
  assert.equal(pip.options.env.GIT_CONFIG_COUNT, '1');
  assert.equal(pip.options.env.GIT_CONFIG_KEY_0, 'core.longpaths');
  assert.equal(pip.options.env.GIT_CONFIG_VALUE_0, 'true');
});

test('Python installs the four compatible pins together and Semgrep separately, never into user/global environments', async t => {
  const fx = await fixture(t), fake = pythonRunner();
  const saved = { GEMINI_API_KEY: process.env.GEMINI_API_KEY, TYPESAFE_API_KEY: process.env.TYPESAFE_API_KEY, PIP_EXTRA_INDEX_URL: process.env.PIP_EXTRA_INDEX_URL, NODE_OPTIONS: process.env.NODE_OPTIONS };
  Object.assign(process.env, { GEMINI_API_KEY: 'private-google-value', TYPESAFE_API_KEY: 'private-typesafe-value', PIP_EXTRA_INDEX_URL: 'https://private:token@private.invalid', NODE_OPTIONS: '--require private.js' });
  try {
    const installed = await installTools(['browser-use', 'browser-harness', 'vibetest', 'jev-ultrafast', 'semgrep'], { ...fx, runner: fake.runner });
    assert.ok(installed.every(r => r.ready), JSON.stringify(installed));
    assert.equal(new Set(installed.slice(0, 4).map(r => r.command)).size, 1);
    assert.notEqual(installed[0].command, installed[4].command);
    const installs = fake.calls.filter(c => c.command === 'uv' && c.args[0] === 'pip');
    assert.equal(installs.length, 2);
    assert.ok(installs[0].args.includes('browser-use==0.13.14'));
    assert.ok(installs[0].args.includes('browser-harness==0.1.13'));
    assert.ok(installs[0].args.includes('vibetest @ git+https://github.com/browser-use/vibetest-use.git@fe0b90ac9d6a129ce06f5b53074241a9f205015b'));
    assert.ok(installs[0].args.includes('jev-ultrafast @ git+https://github.com/browser-use/jev-ultrafast.git@8251e272398011cdef648965204d1c20cd838333'));
    assert.ok(installs[1].args.includes('semgrep==1.183.0'));
    for (const call of fake.calls) {
      assert.equal(call.options.env.GEMINI_API_KEY, undefined); assert.equal(call.options.env.TYPESAFE_API_KEY, undefined);
      assert.equal(call.options.env.PIP_EXTRA_INDEX_URL, undefined); assert.equal(call.options.env.NODE_OPTIONS, undefined);
      assert.ok(call.options.env.UV_CACHE_DIR.startsWith(fx.home));
      assert.ok(call.options.cwd.startsWith(fx.home));
    }
    const calls = fake.calls.length; await installTools(['vibetest'], { ...fx, runner: fake.runner }); assert.equal(fake.calls.length, calls);
    await writeFile(path.join(installed[0].directory, 'venv', 'package-code.py'), '# stale source');
    assert.equal((await resolveTool('jev-ultrafast', fx)).ready, false);
    assert.equal((await resolveTool('semgrep', fx)).ready, true);
  } finally { for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } }
});

test('Python missing assets, wrong Git revisions and malformed metadata cannot create a ready receipt', async t => {
  for (const failure of [{ malformed: true }, { wrongCommit: true }, { missingAsset: true }]) {
    const fx = await fixture(t), fake = pythonRunner(failure);
    const results = await installTools(['jev-ultrafast', 'browser-use'], { ...fx, runner: fake.runner });
    assert.ok(results.every(r => !r.ready && r.status === 'error'));
    assert.equal(fake.calls.filter(c => c.command === 'uv' && c.args[0] === 'pip').length, 1, 'one failed group is not repeatedly installed');
  }
});

test('Adding executable Python bytecode invalidates a previously verified environment', async t => {
  const fx = await fixture(t), fake = pythonRunner();
  const [installed] = await installTools(['browser-use'], { ...fx, runner: fake.runner });
  assert.equal(installed.ready, true);
  await mkdir(path.join(installed.directory, 'venv', '__pycache__'));
  await writeFile(path.join(installed.directory, 'venv', '__pycache__', 'injected.cpython-312.pyc'), 'unverified executable bytecode');
  assert.equal((await resolveTool('browser-use', fx)).ready, false);
});

test('Doctor writes any subprocess cache outside immutable installations', async t => {
  const fx = await fixture(t), fake = npmRunner();
  const [installed] = await installTools(['agent-desktop'], { ...fx, runner: fake.runner });
  const receipt = await readFile(installed.receipt, 'utf8');
  const reports = await doctorTools({ ...fx, runner: async (_command, _args, options) => {
    assert.ok(!options.cwd.startsWith(installed.directory));
    await mkdir(options.env.HOME, { recursive: true });
    await writeFile(path.join(options.env.HOME, 'probe-cache'), 'version check cache');
    return { code: 0, stdout: 'agent-desktop 1.0.2', stderr: '' };
  } });
  assert.equal(reports.find(r => r.id === 'agent-desktop').ready, true);
  assert.equal(await readFile(installed.receipt, 'utf8'), receipt);
  assert.equal((await resolveTool('agent-desktop', fx)).ready, true);
});

test('Receipts with changed pins, incomplete hashes or escaping installation paths are never trusted', async t => {
  for (const mutation of [r => { r.pins = '0'.repeat(64); }, r => { r.files = []; }, r => { r.installation = '../elsewhere'; }, r => { delete r.probes; }, r => { r.files[0].sha256 = 'f'.repeat(64); }]) {
    const fx = await fixture(t), fake = npmRunner();
    const [installed] = await installTools(['agent-desktop'], { ...fx, runner: fake.runner });
    const receipt = JSON.parse(await readFile(installed.receipt)); mutation(receipt);
    await writeFile(installed.receipt, JSON.stringify(receipt));
    assert.equal((await resolveTool('agent-desktop', fx)).ready, false);
  }
});

test('Native installers use pinned release URLs and reject bytes before extraction or execution', async t => {
  const fx = await fixture(t), calls = [];
  const reports = await installTools(['gitleaks', 'ripgrep'], { ...fx, runner: async (command, args, options) => {
    calls.push({ command, args, options });
    assert.equal(command, process.execPath);
    assert.match(args.at(-2), /^https:\/\/github\.com\/(?:gitleaks\/gitleaks\/releases\/download\/v8\.30\.1|BurntSushi\/ripgrep\/releases\/download\/15\.2\.0)\//);
    assert.ok(args.at(-1).startsWith(fx.home));
    await writeFile(args.at(-1), 'tampered release archive');
    return { code: 0, stdout: '', stderr: '' };
  } });
  assert.equal(calls.length, 2); assert.ok(reports.every(r => !r.ready && r.status === 'error'));
});

function tarFixture(name = 'nested/rg', type = '0', contents = 'fixture executable') {
  const header = Buffer.alloc(512), data = Buffer.from(contents);
  header.write(name); header.write('0000755\0', 100); header.write('0000000\0', 108); header.write('0000000\0', 116);
  header.write(data.length.toString(8).padStart(11, '0') + '\0', 124); header.fill(32, 148, 156); header.write(type, 156); header.write('ustar\0', 257);
  header.write(header.reduce((a, b) => a + b, 0).toString(8).padStart(6, '0') + '\0 ', 148);
  return gzipSync(Buffer.concat([header, data, Buffer.alloc((512 - data.length % 512) % 512), Buffer.alloc(1024)]));
}
function zipFixture(name = 'nested/rg.exe', mode = 0o100755) {
  const data = Buffer.from('zip executable'), packed = deflateRawSync(data), filename = Buffer.from(name), local = Buffer.alloc(30), central = Buffer.alloc(46), end = Buffer.alloc(22);
  local.writeUInt32LE(0x04034b50); local.writeUInt16LE(8, 8); local.writeUInt32LE(packed.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(filename.length, 26);
  central.writeUInt32LE(0x02014b50); central.writeUInt16LE(8, 10); central.writeUInt32LE(packed.length, 20); central.writeUInt32LE(data.length, 24); central.writeUInt16LE(filename.length, 28); central.writeUInt32LE((mode * 65536) >>> 0, 38);
  const body = Buffer.concat([local, filename, packed]), table = Buffer.concat([central, filename]);
  end.writeUInt32LE(0x06054b50); end.writeUInt16LE(1, 8); end.writeUInt16LE(1, 10); end.writeUInt32LE(table.length, 12); end.writeUInt32LE(body.length, 16);
  return Buffer.concat([body, table, end]);
}

test('Archive extraction checks compressed-byte digest and safely extracts real zip/tar formats', async t => {
  const fx = await fixture(t);
  for (const [format, bytes, filename, expected] of [['tar.gz', tarFixture(), 'nested/rg', 'fixture executable'], ['zip', zipFixture(), 'nested/rg.exe', 'zip executable']]) {
    const archive = path.join(fx.root, format), destination = path.join(fx.root, `extracted-${format}`);
    await writeFile(archive, bytes);
    await assert.rejects(extractNativeArchive({ archive, destination, format, sha256: '0'.repeat(64) }), /checksum/i);
    await assert.rejects(readdir(destination), { code: 'ENOENT' });
    await extractNativeArchive({ archive, destination, format, sha256: digest(bytes) });
    assert.equal(await readFile(path.join(destination, filename), 'utf8'), expected);
  }
});

test('Native archives reject traversal, absolute/Windows paths, links and malformed headers without writing outside destination', async t => {
  const fx = await fixture(t); let i = 0;
  const attacks = [
    ['tar.gz', tarFixture('../escaped')], ['tar.gz', tarFixture('/absolute')], ['tar.gz', tarFixture('C:/drive')], ['tar.gz', tarFixture('nested\\escape')],
    ['tar.gz', tarFixture('link', '2')], ['tar.gz', tarFixture('hardlink', '1')], ['tar.gz', tarFixture('device', '3')],
    ['zip', zipFixture('../escaped')], ['zip', zipFixture('C:/drive')], ['zip', zipFixture('symlink', 0o120777)], ['zip', Buffer.from('malformed')]
  ];
  for (const [format, bytes] of attacks) {
    const archive = path.join(fx.root, `bad-${i}`), destination = path.join(fx.root, `out-${i++}`); await writeFile(archive, bytes);
    await assert.rejects(extractNativeArchive({ archive, destination, format, sha256: digest(bytes) }));
    await assert.rejects(readdir(destination), { code: 'ENOENT' });
  }
  await assert.rejects(readFile(path.join(fx.root, 'escaped')), { code: 'ENOENT' });
});

test('Cancellation and runner errors never turn into success or leak raw subprocess output', async t => {
  const fx = await fixture(t), controller = new AbortController(); controller.abort(); let calls = 0;
  await assert.rejects(installTools(['ripgrep'], { ...fx, signal: controller.signal, runner: async () => { calls++; } }), { name: 'AbortError' });
  assert.equal(calls, 0);
  const reports = await installTools(['ripgrep'], { ...fx, runner: async () => { throw new Error('PRIVATE_TOKEN_FROM_SUBPROCESS'); } });
  assert.equal(reports[0].status, 'error'); assert.ok(!JSON.stringify(reports).includes('PRIVATE_TOKEN'));
});
