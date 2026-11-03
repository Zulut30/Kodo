import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, writeFile, rm, readdir } from 'node:fs/promises';
import { gzipSync } from 'node:zlib';
import { toolCatalog, resolveTool, installTools, formatToolContext } from '../runtime/tools.mjs';
import registry from '../registry.json' with { type: 'json' };
import { defaultSkillIds } from '../runtime/skill-policy.mjs';
import { workerEnvironment } from '../runtime/security.mjs';

const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const rtkModule = () => import('../runtime/rtk.mjs');
function readyTool() {
  const base = path.resolve(os.tmpdir(), 'kodo-rtk-ready');
  const directory = path.join(base, 'installation');
  return { id: 'rtk', version: '1.1.0', status: 'ready', ready: true, args: [],
    command: path.join(directory, 'native', process.platform === 'win32' ? 'rtk.exe' : 'rtk'),
    directory, receipt: path.join(base, 'receipt.json') };
}
async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'kodo-rtk-test-'));
  const project = path.join(root, 'project'), home = path.join(root, 'tools');
  await mkdir(project); await mkdir(path.join(project, '.git'));
  t.after(async () => {
    assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
    assert.match(path.basename(root), /^kodo-rtk-test-/);
    await rm(root, { recursive: true, force: true });
  });
  return { root, project, home };
}

// Real archive formats with inert bytes; no download or native executable runs.
function archiveFixture(format, files) {
  if (format === 'tar.gz') {
    const entries = Object.entries(files).map(([name, contents]) => {
      const header = Buffer.alloc(512), data = Buffer.from(contents);
      header.write(name); header.write('0000755\0', 100); header.write('0000000\0', 108); header.write('0000000\0', 116);
      header.write(data.length.toString(8).padStart(11, '0') + '\0', 124); header.fill(32, 148, 156);
      header.write('0', 156); header.write('ustar\0', 257);
      header.write(header.reduce((a, b) => a + b, 0).toString(8).padStart(6, '0') + '\0 ', 148);
      return Buffer.concat([header, data, Buffer.alloc((512 - data.length % 512) % 512)]);
    });
    return gzipSync(Buffer.concat([...entries, Buffer.alloc(1024)]));
  }
  let offset = 0;
  const bodies = [], table = [];
  for (const [name, contents] of Object.entries(files)) {
    const filename = Buffer.from(name), data = Buffer.from(contents), local = Buffer.alloc(30), central = Buffer.alloc(46);
    local.writeUInt32LE(0x04034b50); local.writeUInt32LE(data.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(filename.length, 26);
    central.writeUInt32LE(0x02014b50); central.writeUInt32LE(data.length, 20); central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(filename.length, 28); central.writeUInt32LE(offset, 42);
    const body = Buffer.concat([local, filename, data]); bodies.push(body); table.push(central, filename); offset += body.length;
  }
  const directory = Buffer.concat(table), end = Buffer.alloc(22), count = Object.keys(files).length;
  end.writeUInt32LE(0x06054b50); end.writeUInt16LE(count, 8); end.writeUInt16LE(count, 10);
  end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...bodies, directory, end]);
}

// Substitute only the catalog in a private copy of the real installer module.
// Production receives no checksum/verification bypass or second installer API.
async function offlineInstaller(fx, { corrupt = false, omitLicense = false, wrongVersion = false } = {}) {
  const assets = {};
  for (const [platform, executable, format] of [['win32-x64', 'rtk.exe', 'zip'], ['linux-x64', 'rtk', 'tar.gz']]) {
    const files = { [executable]: 'inert offline executable fixture', ...(!omitLicense ? { LICENSE: 'Apache License\nVersion 2.0, January 2004\n' } : {}) };
    const bytes = archiveFixture(format, files);
    assets[platform] = { executable, format, sha256: digest(bytes), url: `https://offline.invalid/${platform}`, bytes };
  }
  const selected = assets[`${process.platform}-${process.arch}`];
  // Unsupported CI hosts still exercise the real native installer, with the
  // current platform mapped to an inert archive only in this private fixture.
  if (!selected) assets[`${process.platform}-${process.arch}`] = assets['linux-x64'];
  const pin = { ...toolCatalog.find(t => t.id === 'rtk'), assets: Object.fromEntries(Object.entries(assets).map(([id, { bytes, ...asset }]) => [id, asset])) };
  const catalogFile = path.join(fx.root, 'fixture-catalog.json');
  await writeFile(catalogFile, JSON.stringify([pin]));
  const source = await readFile(new URL('../runtime/tools.mjs', import.meta.url), 'utf8');
  const isolated = source.replace(/from '(\.\/[^']+)'/g, (_match, relative) => `from '${relative === './tool-catalog.json' ? pathToFileURL(catalogFile).href : new URL(relative, new URL('../runtime/tools.mjs', import.meta.url)).href}'`);
  const moduleFile = path.join(fx.root, 'installer.mjs'); await writeFile(moduleFile, isolated);
  const installer = await import(pathToFileURL(moduleFile).href);
  const calls = [];
  const runner = async (command, args, options) => {
    calls.push({ command, args, options });
    if (command === process.execPath) {
      const asset = Object.values(assets).find(a => a.url === args.at(-2));
      assert.ok(asset, 'download must use the fixture pin');
      await writeFile(args.at(-1), corrupt ? 'bad archive' : asset.bytes);
      return { code: 0, stdout: '', stderr: '' };
    }
    assert.deepEqual(args, ['--version']);
    assert.ok(command.startsWith(fx.home));
    assert.equal(options.env.RTK_RECALL, '0'); assert.equal(options.env.RTK_TEE, '0');
    assert.equal(options.env.RTK_TELEMETRY_DISABLED, '1');
    assert.ok(options.env.RTK_DB_PATH.startsWith(options.cwd));
    return { code: 0, stdout: wrongVersion ? 'rtk 0.50.0\n' : 'rtk 1.1.0\n', stderr: '' };
  };
  return { installer, runner, calls };
}

test('RTK pins only verified OSS archives without changing component or skill counts', () => {
  const pin = toolCatalog.find(t => t.id === 'rtk');
  assert.ok(pin);
  assert.equal(toolCatalog.length, 10); assert.equal(registry.components.length, 33); assert.equal(defaultSkillIds.length, 13);
  assert.equal(pin.repository, 'rtk-ai/rtk'); assert.equal(pin.version, '1.1.0');
  assert.equal(pin.revision, '753a3b0e939f2e4490fc24e3a1984010f40a103c'); assert.equal(pin.license, 'Apache-2.0');
  assert.deepEqual(Object.keys(pin.assets).sort(), ['linux-x64', 'win32-x64']);
  assert.deepEqual(pin.assets['win32-x64'], { url: 'https://github.com/rtk-ai/rtk/releases/download/v1.1.0/rtk-oss-x86_64-pc-windows-msvc.zip', sha256: '9b076379be9d86011ca3f3a0264d0be4851da5535453a47f67fa46b4e893fbb2', format: 'zip', executable: 'rtk.exe' });
  assert.deepEqual(pin.assets['linux-x64'], { url: 'https://github.com/rtk-ai/rtk/releases/download/v1.1.0/rtk-oss-x86_64-unknown-linux-musl.tar.gz', sha256: '4dec94a64035e08189ae82fd5408fe4ae9ae27a665fc07e3e3ec3c4c2d8e8a3e', format: 'tar.gz', executable: 'rtk' });
});

test('RTK missing and unsupported resolution stays raw without installation', async t => {
  const fx = await fixture(t);
  const missing = await resolveTool('rtk', { ...fx, platform: 'win32', arch: 'x64' });
  assert.equal(missing.status, 'missing'); assert.equal(missing.command, null);
  const unsupported = await resolveTool('rtk', { ...fx, platform: 'darwin', arch: 'arm64' });
  assert.equal(unsupported.status, 'unsupported'); assert.equal(unsupported.ready, false);
  await assert.rejects(readdir(fx.home), { code: 'ENOENT' });
});

test('RTK guidance preserves raw protocols and Node TAP diagnostics for verified tools only', async () => {
  const { formatRtkContext } = await rtkModule();
  const ready = readyTool(), context = formatRtkContext(ready);
  assert.ok(context.length > 0 && Buffer.byteLength(context) <= 2400);
  for (const required of [/rtk git status/, /JSON/, /porcelain/, /-z/, /protocol/i, /Node.*TAP/, /full.*(?:error|failure)/i, /raw/i, /exit code/i, /coordinator/i, /RTK_DB_PATH/, /RTK_RECALL=0/, /RTK_TEE=0/, /approximate/i]) assert.match(context, required);
  assert.ok(!context.includes(ready.command)); assert.ok(!context.includes(ready.receipt));
  assert.doesNotMatch(context, /(?:use|run|prefer)\s+`?rtk test node/i);
  for (const tool of [undefined, {}, { ...ready, ready: false }, { ...ready, version: '0.50.0' }, { ...ready, status: 'error' }, { ...ready, id: 'rtk-proxy' }, { ...ready, receipt: undefined }, { ...ready, command: 'rtk' }]) assert.equal(formatRtkContext(tool), '');
  const malicious = { ...ready, reason: 'PRIVATE-DIAGNOSTIC' };
  assert.ok(!formatRtkContext(malicious).includes(malicious.reason));
});

test('RTK tool context rejects contradictory and duplicate availability evidence', () => {
  const ready = readyTool();
  assert.match(formatToolContext({ tools: [ready] }), /rtk@1.1.0: available/);
  assert.match(formatToolContext({ tools: [ready] }), /Node.*TAP/);
  for (const tools of [[{ ...ready, status: 'error' }], [ready, ready], [{ id: 'rtk', ready: true, version: '1.1.0' }]]) {
    const context = formatToolContext({ tools });
    assert.match(context, /rtk@1.1.0: unavailable/); assert.doesNotMatch(context, /rtk git status/);
  }
});

test('RTK worker overrides isolate tracking without changing subscription homes or inherited PATH', async () => {
  const { rtkWorkerEnvironment } = await rtkModule(), ready = readyTool();
  const first = path.resolve(os.tmpdir(), 'kodo-worker-one'), second = path.resolve(os.tmpdir(), 'kodo-worker-two');
  const environment = rtkWorkerEnvironment(ready, first);
  assert.deepEqual(environment, { RTK_DB_PATH: path.join(first, 'tracking.db'), RTK_RECALL: '0', RTK_TEE: '0', RTK_TELEMETRY_DISABLED: '1' });
  const base = { PATH: 'inherited-path', HOME: 'subscription-home', USERPROFILE: 'subscription-profile', APPDATA: 'subscription-appdata', CODEX_HOME: 'subscription-codex',
    RTK_DB_PATH: 'personal-tracking.db', RTK_RECALL: '1', RTK_TEE: '1', RTK_TELEMETRY_DISABLED: '0', GEMINI_API_KEY: 'private-coordinator-value' };
  const merged = { ...workerEnvironment(base), ...environment };
  for (const name of ['PATH', 'HOME', 'USERPROFILE', 'APPDATA', 'CODEX_HOME']) assert.equal(merged[name], base[name]);
  assert.equal(merged.RTK_DB_PATH, path.join(first, 'tracking.db')); assert.equal(merged.RTK_RECALL, '0'); assert.equal(merged.RTK_TEE, '0');
  assert.equal(merged.RTK_TELEMETRY_DISABLED, '1'); assert.equal(merged.GEMINI_API_KEY, undefined);
  assert.equal(base.RTK_DB_PATH, 'personal-tracking.db', 'do not mutate the parent environment');
  assert.notEqual(rtkWorkerEnvironment(ready, second).RTK_DB_PATH, environment.RTK_DB_PATH);
  assert.deepEqual(rtkWorkerEnvironment({ ...ready, ready: false }, first), {});
  for (const directory of ['relative', '', path.parse(first).root, os.homedir(), ready.directory, path.join(ready.directory, 'work'), first + '\u0000']) assert.throws(() => rtkWorkerEnvironment(ready, directory), /private|absolute|installation|directory/i);
});

test('RTK official archive digest mismatch stops before extraction or native execution', async t => {
  const fx = await fixture(t); let calls = 0;
  if (!['win32-x64', 'linux-x64'].includes(`${process.platform}-${process.arch}`)) {
    assert.equal((await installTools(['rtk'], { ...fx, runner: () => { throw new Error('must not execute'); } }))[0].status, 'unsupported');
    return;
  }
  const [report] = await installTools(['rtk'], { ...fx, runner: async (command, args) => {
    calls++; assert.equal(command, process.execPath); assert.match(args.at(-2), /\/rtk-oss-/);
    await writeFile(args.at(-1), 'tampered offline archive'); return { code: 0, stdout: '', stderr: '' };
  } });
  assert.equal(calls, 1); assert.equal(report.ready, false); assert.equal(report.status, 'error');
  assert.equal((await resolveTool('rtk', fx)).ready, false);
});

test('RTK offline installation reuses verified files and doctor never launches hooks or commands', async t => {
  const fx = await fixture(t), { installer, runner, calls } = await offlineInstaller(fx);
  const [installed] = await installer.installTools(['rtk'], { ...fx, runner });
  assert.equal(installed.ready, true, JSON.stringify(installed));
  assert.equal(await readFile(path.join(installed.directory, 'native', 'LICENSE'), 'utf8'), 'Apache License\nVersion 2.0, January 2004\n');
  const count = calls.length;
  assert.equal((await installer.installTools(['rtk'], { ...fx, runner }))[0].ready, true); assert.equal(calls.length, count);
  assert.equal((await installer.doctorTools({ ...fx, runner }))[0].ready, true);
  assert.equal((await installer.resolveTool('rtk', fx)).ready, true);
  assert.equal(calls.length, count + 1);
  await writeFile(installed.command, 'tampered executable');
  assert.equal((await installer.resolveTool('rtk', fx)).ready, false);
});

test('RTK offline bad archive missing license and wrong version never produce ready receipts', async t => {
  for (const failure of [{ corrupt: true }, { omitLicense: true }, { wrongVersion: true }]) {
    const fx = await fixture(t), { installer, runner, calls } = await offlineInstaller(fx, failure);
    const [report] = await installer.installTools(['rtk'], { ...fx, runner });
    assert.equal(report.status, 'error'); assert.equal(report.ready, false);
    assert.equal((await installer.resolveTool('rtk', fx)).ready, false);
    if (!failure.wrongVersion) assert.equal(calls.length, 1, 'reject integrity before the version probe');
  }
});
