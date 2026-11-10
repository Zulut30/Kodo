import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { access, lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execute } from '../runtime/command.mjs';
import { workerEnvironment } from '../runtime/security.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const temporaryPrefix = 'kodo-package-smoke-';

async function smoke() {
  const temporaryRoot = await realpath(os.tmpdir());
  const scratch = await mkdtemp(path.join(temporaryRoot, temporaryPrefix));
  try {
    const prefix = path.join(scratch, 'installed');
    const userConfig = path.join(scratch, 'npmrc');
    await mkdir(prefix);
    await writeFile(userConfig, '');
    const env = workerEnvironment();
    const npmOptions = ['--userconfig', userConfig, '--cache', path.join(scratch, 'npm-cache')];
    const expected = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
    const packed = await execute(
      'npm',
      ['pack', '--ignore-scripts', '--json', '--pack-destination', scratch, ...npmOptions],
      { cwd: root, env },
    );
    const packages = JSON.parse(packed.stdout);
    assert.equal(packages.length, 1, 'pack must produce exactly one Kodo archive');
    const archiveName = packages[0].filename;
    assert.equal(path.basename(archiveName), archiveName, 'pack archive must stay in the temporary directory');
    const archive = path.join(scratch, archiveName);
    const sha256 = createHash('sha256')
      .update(await readFile(archive))
      .digest('hex');
    await execute(
      'npm',
      [
        'install',
        '--prefix',
        prefix,
        '--ignore-scripts',
        '--no-audit',
        '--no-fund',
        '--package-lock=false',
        archive,
        ...npmOptions,
      ],
      { cwd: scratch, env },
    );

    const installedRoot = path.join(prefix, 'node_modules', ...expected.name.split('/'));
    const installed = JSON.parse(await readFile(path.join(installedRoot, 'package.json'), 'utf8'));
    assert.equal(installed.name, expected.name);
    assert.equal(installed.version, expected.version);
    const bin = path.resolve(installedRoot, installed.bin.kodo);
    const relativeBin = path.relative(installedRoot, bin);
    assert.ok(
      relativeBin && !relativeBin.startsWith(`..${path.sep}`) && !path.isAbsolute(relativeBin),
      'installed bin must belong to the package',
    );
    assert.equal((await lstat(bin)).isFile(), true, 'installed package bin must be a regular file');
    const launcher = path.join(prefix, 'node_modules', '.bin', process.platform === 'win32' ? 'kodo.cmd' : 'kodo');
    await access(launcher);

    // Always execute the installed entry point; the checkout is not on its module path.
    const run = args => execute(process.execPath, [bin, ...args], { cwd: prefix, env });
    const help = await run(['--help']);
    assert.match(help.stdout, /Kodo/);
    assert.match(help.stdout, /kodo run/);
    const validation = JSON.parse((await run(['validate', '--json'])).stdout);
    assert.equal(validation.valid, true);
    const catalog = JSON.parse((await run(['list', '--json'])).stdout);
    assert.ok(Array.isArray(catalog) && catalog.length > 0);
    assert.equal(validation.components, catalog.length);

    const policy = await import(pathToFileURL(path.join(installedRoot, 'runtime', 'skill-policy.mjs')).href);
    const { lock } = await policy.verifyDefaultSkillPins();
    const ids = new Set(catalog.map(component => component.id));
    for (const id of [...policy.defaultSkillIds, 'skills/kodo-build-feature'])
      assert.ok(ids.has(id), `installed catalog missing ${id}`);
    assert.equal(lock.components.length, 13);
    console.log(
      JSON.stringify(
        {
          package: installed.name,
          version: installed.version,
          archive: archiveName,
          sha256,
          components: catalog.length,
          defaultSkills: lock.components.length,
          upstreamFiles: lock.components.reduce((count, component) => count + component.files.length, 0),
          checks: [
            'npm pack',
            'isolated install --ignore-scripts',
            'installed package bin and launcher',
            'installed CLI help',
            'installed CLI validate --json',
            'installed CLI list --json',
            'installed default skill pins',
          ],
          passed: true,
        },
        null,
        2,
      ),
    );
  } finally {
    const resolved = await realpath(scratch);
    assert.equal(path.dirname(resolved), temporaryRoot, 'cleanup must remain directly inside the temporary directory');
    assert.ok(path.basename(resolved).startsWith(temporaryPrefix), 'cleanup requires the unique package-smoke prefix');
    assert.equal((await lstat(scratch)).isSymbolicLink(), false, 'cleanup must not follow a replaced directory link');
    await rm(resolved, { recursive: true, force: true });
  }
}

smoke().catch(error => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
