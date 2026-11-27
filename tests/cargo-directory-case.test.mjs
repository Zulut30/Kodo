import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, readdir } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { readArchitectureGraph } from '../runtime/architecture-graph.mjs';
import { parseCargoWorkspace } from '../runtime/architecture-rust.mjs';
import { readCargoPackagePlan } from '../runtime/project-blueprint-rust.mjs';
import { git } from '../runtime/workspace.mjs';
import { fixture, put } from './fixtures/quality/helpers.mjs';

test('Cargo consumers resolve snapshot entries using the case mode of their parent', async t => {
  const { project } = await fixture(t);
  const windows = process.platform === 'win32';
  const dirs = ['core', 'wire', 'extras/a/exporter', 'extras/b/Exporter', 'extras/normal/exporter'];
  const pkgNames = ['core', 'wire-contracts', 'independent', 'monitor', 'normal'];
  for (const [parent, mode] of [
    ['extras/a', 'enable'],
    ['extras/normal', 'disable'],
  ]) {
    const directory = path.join(project, parent);
    await mkdir(directory, { recursive: true });
    if (windows) {
      try {
        execFileSync(
          path.join(process.env.SystemRoot, 'System32/fsutil.exe'),
          ['file', 'setCaseSensitiveInfo', directory, mode],
          { stdio: 'pipe', windowsHide: true },
        );
      } catch {
        return t.skip('This Windows volume or account cannot set per-directory case sensitivity');
      }
    }
    await put(project, parent + '/42', 'keep the parent in the sparse checkout');
  }
  await put(
    project,
    'Cargo.toml',
    '[workspace]\nmembers=["core", "wire", "extras/*/Exporter"]\nexclude=["extras/a/exporter", "extras/normal/exporter"]\n',
  );
  for (const [i, dir] of dirs.entries()) {
    await put(project, dir + '/Cargo.toml', `[package]\nname="${pkgNames[i]}"\nversion="0.1.0"\n`);
    await put(project, dir + '/src/lib.rs', 'pub struct Packet;\n');
  }
  await git(project, ['add', '.']);
  await git(project, [
    '-c',
    'user.name=Fixture',
    '-c',
    'user.email=fixture@localhost',
    '-c',
    'commit.gpgSign=false',
    'commit',
    '-qm',
    'Cargo workspace',
  ]);
  const headSha = await git(project, ['rev-parse', 'HEAD']);
  const policy = {
    schemaVersion: 2,
    language: 'rust',
    productRoots: ['core', 'extras', 'wire'],
    layers: [],
    contractCrates: ['wire-contracts'],
  };
  const spec = { tasks: [{ id: 'edit', writePaths: dirs.map(dir => dir + '/src/lib.rs') }] };
  const expected = ['core', 'extras/b/Exporter', ...(windows ? ['extras/normal/exporter'] : []), 'wire'];
  for (const checkout of ['full', 'sparse']) {
    if (checkout === 'sparse') {
      await git(project, [
        'sparse-checkout',
        'set',
        '--no-cone',
        '/*',
        '!/extras/a/exporter/',
        '!/extras/normal/exporter/',
      ]);
      assert.deepEqual(await readdir(path.join(project, 'extras/a')), ['42']);
      assert.equal(await git(project, ['status', '--porcelain']), '');
    }
    await t.test(checkout + ' architecture graph', async () => {
      const graph = await readArchitectureGraph({ project, headSha, policy });
      assert.deepEqual(graph.unsupported, []);
      assert.deepEqual(graph.crates.map(crate => crate.root).sort(), expected);
    });
    await t.test(checkout + ' registration plan', async () => {
      const { plan } = await readCargoPackagePlan(project, spec, '', headSha, policy);
      assert.deepEqual(
        [...plan.workspaceOwners]
          .filter(([, roots]) => roots.includes(''))
          .map(([dir]) => dir)
          .sort(),
        expected,
      );
    });
  }
});

test('Rust architecture follows direct and inherited path dependencies with the same native spelling', () => {
  const spelling = process.platform === 'win32' ? 'extras/Exporter' : 'extras/exporter';
  const contents = new Map([
    [
      'Cargo.toml',
      '[workspace]\nmembers=["core","wire"]\n[workspace.dependencies]\nexporter={path="' + spelling + '"}\n',
    ],
    ['core/Cargo.toml', '[package]\nname="core"\n[dependencies]\nexporter={path="../' + spelling + '"}\n'],
    ['wire/Cargo.toml', '[package]\nname="wire"\n[dependencies]\nexporter.workspace=true\n'],
    ['extras/exporter/Cargo.toml', '[package]\nname="exporter"\n'],
  ]);
  const files = [...contents.keys()].map(path => ({ path, mode: '100644', oid: '0'.repeat(40) }));
  const graph = parseCargoWorkspace({ files, contents });
  assert.deepEqual(graph.unsupported, []);
  assert.deepEqual(
    graph.edges.map(({ from, to, workspaceInherited }) => [from, to, workspaceInherited]),
    [
      ['core', 'exporter', false],
      ['wire', 'exporter', true],
    ],
  );
});
