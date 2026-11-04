import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, mkdir, readFile, writeFile, rm, symlink } from 'node:fs/promises';
import { toolCatalog, installTools, resolveTool, doctorTools } from '../runtime/tools.mjs';
import * as toolchains from '../runtime/toolchains.mjs';

const integrities = {
  "oxlint": "sha512-vjy/cBZcEFcYh3dbxUoQK+bjc+QaY3ZWo86aJkZ5YAwp/HyiqP7dTdNgbvcIVJafhAH5sZbTqBp4sZcicEZngA==",
  "oxfmt": "sha512-Yo9RIn9lRWTm/U8obHbXUWc39lCpEFXlEggFoPx01zS18OCFi7mAwMmL05+p1AunuJgSkONffWyBHJzpMMCRuQ==",
  "typescript": "sha512-8FYau96o3NKOhbjKi/qNvG/W5jhzxkbdm5sj9AbZ/5T5sWqn3hJgLfGx27sRKZWTvyzCP8dLRBTf5tBTSRVUNA==",
  "stylelint": "sha512-kI10GsHXQvsH/AcklVZdQgwDuxtHi+A+h1Ujzd7h9LDf3e5jQiLQkWFlPtpynX3E6oVWHG1wo9v6dL0Mr+nnSA==",
  "html-validate": "sha512-9+cP5LyLG2blk1W8pYACmgTuFnqOuMZS8rt7G0q72wH7xqdduKE0qyV1qhwsKr/tjqmqscq81yyE6mNUuUex3Q=="
};
const expected = {
  oxlint: { version: '1.91.0', bin: 'oxlint', entry: 'bin/oxlint', output: 'Version: 1.91.0' },
  oxfmt: { version: '0.76.0', bin: 'oxfmt', entry: 'bin/oxfmt', output: 'Version: 0.76.0' },
  typescript: { version: '7.0.2', bin: 'tsc', entry: 'bin/tsc', output: 'Version 7.0.2' },
  stylelint: { version: '18.0.0', bin: 'stylelint', entry: 'bin/stylelint.mjs', output: '18.0.0' },
  'html-validate': { version: '11.18.0', bin: 'html-validate', entry: 'bin/html-validate.mjs', output: 'html-validate-11.18.0' },
  sqlfluff: { version: '4.5.0', output: 'sqlfluff, version 4.5.0' }
};
async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'kodo-quality-tools-'));
  const project = path.join(root, 'project'), home = path.join(root, 'tools');
  await mkdir(project); await mkdir(path.join(project, '.git'));
  t.after(async () => { assert.equal(path.dirname(root), path.resolve(os.tmpdir())); assert.match(path.basename(root), /^kodo-quality-tools-/); await rm(root, { recursive: true, force: true }); });
  return { root, project, home };
}
function npmFixture({ integrity, bin, version, output, exitCode = 0, missingEntry = false, linkedEntry = false, incomplete = false } = {}) {
  const calls = [];
  const runner = async (command, args, options) => {
    calls.push({ command, args, options });
    if (command === 'npm') {
      const pkg = JSON.parse(await readFile(path.join(options.cwd, 'package.json'))), [id, requested] = Object.entries(pkg.dependencies)[0];
      assert.equal(requested, expected[id].version);
      assert.ok(args.includes('--ignore-scripts') && args.includes('--no-bin-links'));
      assert.ok(!args.includes('--global') && !args.includes('-g'));
      if (args.includes('--package-lock-only')) {
        await writeFile(path.join(options.cwd, 'package-lock.json'), JSON.stringify({ lockfileVersion: 3, packages: { '': pkg, [`node_modules/${id}`]: { version: requested, integrity: integrity ?? integrities[id], resolved: `https://registry.npmjs.org/${id}/-/${id}-${requested}.tgz` } } }));
      } else {
        const root = path.join(options.cwd, 'node_modules', id), target = path.join(root, expected[id].entry);
        await mkdir(path.dirname(target), { recursive: true });
        await writeFile(path.join(root, 'package.json'), JSON.stringify({ name: id, version: version ?? requested, bin: { [expected[id].bin]: bin ?? expected[id].entry } }));
        if (linkedEntry) { const outside = path.join(options.cwd, 'outside.js'); await writeFile(outside, '// outside'); await symlink(outside, target); }
        else if (!missingEntry) await writeFile(target, '// offline quality CLI fixture');
      }
      return { code: 0, stdout: '', stderr: '' };
    }
    const id = Object.keys(expected).find(id => id !== 'sqlfluff' && args[0].endsWith(path.join('node_modules', id, expected[id].entry)));
    assert.ok(id, 'only a pinned Node entrypoint may be probed');
    assert.equal(command, process.execPath); assert.deepEqual(args.slice(1), ['--version']);
    return incomplete ? { code: 0 } : { code: exitCode, stdout: output ?? expected[id].output + '\n', stderr: exitCode ? 'PRIVATE_SUBPROCESS_OUTPUT' : '' };
  };
  return { calls, runner };
}

test('Quality tools expose exactly six additional immutable pins and metadata', () => {
  assert.equal(toolCatalog.length, 16);
  assert.deepEqual(Object.fromEntries(toolCatalog.slice(10).map(t => [t.id, t.version])), Object.fromEntries(Object.entries(expected).map(([id, t]) => [id, t.version])));
  for (const tool of toolCatalog.slice(10)) {
    assert.ok(tool.platforms.includes('win32-x64') && tool.platforms.includes('linux-x64'));
    assert.ok(tool.source && tool.capability && tool.license);
    if (tool.kind === 'npm') { assert.equal(tool.entry, expected[tool.id].entry); assert.equal(tool.binName, expected[tool.id].bin); assert.equal(tool.integrity, integrities[tool.id]); }
  }
  const sql = toolCatalog.find(t => t.id === 'sqlfluff');
  assert.equal(sql.entryModule, 'sqlfluff'); assert.equal(sql.group, 'quality');
  assert.deepEqual(sql.files.map(f => f.sha256), ['471a9abcad8061e36b69f711a6d89393241e30f9d1e0869f79965c0ae2c889c7', '0b0d5b2cca03e7d138b8d899249fed5fa54083e407bbd161449c0b30f901b7b8']);
});

test('Quality npm tools use isolated pinned installs and generic verified Node entrypoints', async t => {
  const fx = await fixture(t), fake = npmFixture();
  const installed = await installTools(Object.keys(expected).slice(0, 5), { ...fx, runner: fake.runner });
  for (const tool of installed) {
    assert.equal(tool.ready, true, tool.id); assert.equal(tool.version, expected[tool.id].version);
    assert.equal(tool.command, process.execPath); assert.equal(tool.args.length, 1);
    assert.ok(tool.args[0].endsWith(path.join('node_modules', tool.id, expected[tool.id].entry)));
    const resolved = await resolveTool(tool.id, fx); assert.equal(resolved.ready, true);
  }
  const count = fake.calls.length; await installTools(['typescript'], { ...fx, runner: fake.runner }); assert.equal(fake.calls.length, count);
  for (const call of fake.calls) {
    assert.ok(call.options.cwd.startsWith(fx.home));
    for (const key of ['OPENAI_API_KEY', 'GEMINI_API_KEY', 'NODE_OPTIONS', 'PIP_EXTRA_INDEX_URL']) assert.equal(call.options.env[key], undefined);
  }
  await writeFile(installed[0].args[0], '// tampered'); assert.equal((await resolveTool('oxlint', fx)).ready, false);
});

test('Generic npm entry validation rejects unsafe paths missing metadata and wrong bin names', () => {
  assert.equal(typeof toolchains.npmEntrypoint, 'function');
  const tool = { id: 'fixture-tool', entry: 'bin/cli.mjs', binName: 'fixture' };
  assert.equal(toolchains.npmEntrypoint(tool, { bin: { fixture: './bin/cli.mjs' } }), 'bin/cli.mjs');
  assert.equal(toolchains.npmEntrypoint({ ...tool, binName: 'fixture-tool' }, { bin: 'bin/cli.mjs' }), 'bin/cli.mjs');
  for (const entry of ['../escape', '/absolute', 'C:/drive', 'bin\\escape', 'bin/../escape', 'bin/./cli', 'bin/cli\u0000', 'bin/nul', '--require']) assert.throws(() => toolchains.npmEntrypoint({ ...tool, entry }, { bin: { fixture: entry } }));
  for (const pkg of [{}, { bin: {} }, { bin: { other: tool.entry } }, { bin: { fixture: '../escape' } }, { bin: { fixture: 'bin/other' } }, { bin: 'bin/cli.mjs' }]) assert.throws(() => toolchains.npmEntrypoint(tool, pkg));
  assert.throws(() => toolchains.npmEntrypoint({ ...tool, entry: undefined }, { bin: { fixture: tool.entry } }));
  assert.throws(() => toolchains.npmEntrypoint({ ...tool, binName: undefined }, { bin: { fixture: tool.entry } }));
});

test('Quality npm rejects integrity version entrypoint and incomplete process failures', async t => {
  for (const failure of [{ integrity: 'sha512-wrong' }, { version: '99.0.0' }, { bin: '../outside' }, { bin: 'bin/other.mjs' }, { missingEntry: true }, { linkedEntry: true }, { output: 'Version 99.0.0 expected 7.0.2' }, { output: 'Version 7.0.2-beta' }, { output: '' }, { exitCode: 1 }, { incomplete: true }]) {
    const fx = await fixture(t), fake = npmFixture(failure);
    const [report] = await installTools(['typescript'], { ...fx, runner: fake.runner });
    assert.equal(report.status, 'error'); assert.equal(report.ready, false);
    assert.equal((await resolveTool('typescript', fx)).ready, false);
    assert.ok(!JSON.stringify(report).includes('PRIVATE_SUBPROCESS_OUTPUT'));
    if (failure.integrity) assert.equal(fake.calls.filter(c => c.args[0] === 'ci').length, 0);
  }
});

test('Quality tools remain missing or unsupported without implicit installation', async t => {
  const fx = await fixture(t); let calls = 0;
  for (const id of Object.keys(expected)) {
    assert.equal((await resolveTool(id, fx)).status, 'missing');
    const unsupported = await resolveTool(id, { ...fx, platform: 'freebsd', arch: 'x64' });
    assert.equal(unsupported.ready, false); assert.equal(unsupported.status, 'unsupported');
  }
  const reports = await doctorTools({ ...fx, live: false, runner: async () => { calls++; throw Error('unexpected process'); } });
  assert.equal(reports.length, 16); assert.equal(calls, 0);
  await assert.rejects(readFile(path.join(fx.home, '.kodo-tools.json')), { code: 'ENOENT' });
});

test('Quality doctor rejects a changed version and missing receipt probes', async t => {
  const fx = await fixture(t), fake = npmFixture();
  const [installed] = await installTools(['typescript'], { ...fx, runner: fake.runner }); assert.equal(installed.ready, true);
  const reports = await doctorTools({ ...fx, runner: async () => ({ code: 0, stdout: 'Version 99.0.0', stderr: '' }) });
  assert.equal(reports.find(r => r.id === 'typescript').status, 'error');
  const receipt = JSON.parse(await readFile(installed.receipt)); delete receipt.probes.typescript;
  await writeFile(installed.receipt, JSON.stringify(receipt)); assert.equal((await resolveTool('typescript', fx)).ready, false);
});

function pythonFixture({ wrongVersion = false, missingModule = false, badHashes = false, cliVersion = 'sqlfluff, version 4.5.0', probeError = false } = {}) {
  const calls = [];
  const runner = async (command, args, options) => {
    calls.push({ command, args, options });
    if (command === 'uv' && args[0] === 'python') return { code: 0, stdout: path.join(options.cwd, 'bootstrap-python.exe'), stderr: '' };
    if (command.endsWith('bootstrap-python.exe')) {
      const venv = args.at(-1), python = path.join(venv, process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
      await mkdir(path.dirname(python), { recursive: true }); await writeFile(python, 'offline python fixture');
      await writeFile(path.join(venv, 'pyvenv.cfg'), 'include-system-site-packages = false\n');
    } else if (command === 'uv') {
      assert.ok(args.includes('--requirement')); assert.ok(!args.includes('--system'));
      const requirements = await readFile(args[args.indexOf('--requirement') + 1], 'utf8');
      assert.match(requirements, /^sqlfluff==4\.5\.0 --hash=sha256:471a9abcad8061e36b69f711a6d89393241e30f9d1e0869f79965c0ae2c889c7 --hash=sha256:0b0d5b2cca03e7d138b8d899249fed5fa54083e407bbd161449c0b30f901b7b8\n$/);
      if (badHashes) return { code: 1, stdout: '', stderr: 'PRIVATE_HASH_DIAGNOSTICS' };
      await writeFile(path.join(options.cwd, 'venv/package-code.py'), '# source');
    } else if (args.includes('--version')) {
      assert.deepEqual(args, ['-I', '-B', '-m', 'sqlfluff', '--version']);
      return { code: probeError ? 1 : 0, stdout: cliVersion, stderr: '' };
    } else {
      const request = JSON.parse(args.at(-1)); assert.equal(request.length, 1); assert.equal(request[0].entryModule, 'sqlfluff');
      if (missingModule) return { code: 1, stdout: '', stderr: 'missing __main__' };
      return { code: 0, stdout: JSON.stringify({ python: '3.12', assets: true, versions: { sqlfluff: wrongVersion ? '0.0.0' : '4.5.0' }, revisions: {} }), stderr: '' };
    }
    return { code: 0, stdout: '', stderr: '' };
  };
  return { runner, calls };
}

test('SQLFluff uses a separate hash constrained Python environment and module version probe', async t => {
  const fx = await fixture(t), fake = pythonFixture();
  const [installed] = await installTools(['sqlfluff'], { ...fx, runner: fake.runner }); assert.equal(installed.ready, true);
  assert.deepEqual(installed.args, ['-I', '-B', '-m', 'sqlfluff']);
  const request = fake.calls.find(c => c.args.includes('-c') && !c.command.endsWith('bootstrap-python.exe'));
  assert.ok(request.args.some(arg => arg.includes('__main__.py')));
  const before = fake.calls.length; assert.equal((await resolveTool('sqlfluff', fx)).ready, true); assert.equal(fake.calls.length, before);
  const reports = await doctorTools({ ...fx, live: false, runner: fake.runner }); assert.equal(reports.find(r => r.id === 'sqlfluff').ready, true);
});

test('SQLFluff module banner requires the exact pinned version', async t => {
  for (const [cliVersion, expectedReady] of [
    ['python -m sqlfluff, version 4.5.0', true],
    ['python -m sqlfluff, version 4.4.0', false],
    ['python -m sqlfluff, version 4.5.0 extra', false]
  ]) {
    const fx = await fixture(t), fake = pythonFixture({ cliVersion });
    const [report] = await installTools(['sqlfluff'], { ...fx, runner: fake.runner });
    assert.equal(report.ready, expectedReady);
    assert.equal((await resolveTool('sqlfluff', fx)).ready, expectedReady);
  }
});

test('SQLFluff rejects hash metadata module and CLI version failures', async t => {
  for (const failure of [{ badHashes: true }, { wrongVersion: true }, { missingModule: true }, { cliVersion: 'sqlfluff, version 4.4.0' }, { cliVersion: 'sqlfluff, version 4.5.0 expected 4.4.0' }, { probeError: true }]) {
    const fx = await fixture(t), fake = pythonFixture(failure), [report] = await installTools(['sqlfluff'], { ...fx, runner: fake.runner });
    assert.equal(report.ready, false); assert.equal(report.status, 'error');
    assert.equal((await resolveTool('sqlfluff', fx)).ready, false); assert.ok(!JSON.stringify(report).includes('PRIVATE_HASH'));
  }
});

test('Python module entry validation rejects traversal options and code injection', () => {
  assert.equal(typeof toolchains.pythonEntrypoint, 'function');
  assert.equal(toolchains.pythonEntrypoint('package.cli'), 'package.cli');
  for (const entry of ['', '../sqlfluff', '-m', 'sqlfluff;bad()', 'sqlfluff/main', 'sqlfluff\u0000', '.sqlfluff', 'sqlfluff..cli', undefined]) assert.throws(() => toolchains.pythonEntrypoint(entry));
});

test('Node engine constraints fail closed across pinned runtime boundaries', () => {
  assert.equal(typeof toolchains.supportsNodeEngine, 'function');
  const cases = [
    ['^20.19.0 || >=22.12.0', '20.18.9', false], ['^20.19.0 || >=22.12.0', '20.19.0', true],
    ['^20.19.0 || >=22.12.0', '21.0.0', false], ['^20.19.0 || >=22.12.0', '22.11.9', false],
    ['^20.19.0 || >=22.12.0', '22.12.0', true], ['^20.19.0 || >=22.12.0', '24.19.0', true],
    ['^22.22.2 || ^24.15.0 || >=26.0.0', '24.14.9', false], ['^22.22.2 || ^24.15.0 || >=26.0.0', '24.15.0', true],
    ['^22.22.2 || ^24.15.0 || >=26.0.0', '25.0.0', false], ['^22.22.2 || ^24.15.0 || >=26.0.0', '26.0.0', true],
    ['^22.22.0 || >= 24.8.0', '24.8.0', true], ['>=16.20.0', '16.19.9', false],
    ['latest', '24.19.0', false], ['', '24.19.0', false], ['>=24.0.0', '24.19.0-beta', false]
  ];
  for (const [range, version, expected] of cases) assert.equal(toolchains.supportsNodeEngine(range, version), expected);
});
