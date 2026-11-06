import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, realpath, symlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';

// A missing feature is a behavioral RED, rather than an import-time runner crash.
const parser = await import('../runtime/javascript-dependencies.mjs').catch(error => {
  if (error.code === 'ERR_MODULE_NOT_FOUND' && error.url?.endsWith('/runtime/javascript-dependencies.mjs')) return {};
  throw error;
});
const graph = await import('../runtime/architecture-graph.mjs').catch(error => {
  if (error.code === 'ERR_MODULE_NOT_FOUND' && error.url?.endsWith('/runtime/architecture-graph.mjs')) return {};
  throw error;
});
const inspect = input => {
  assert.equal(typeof parser.inspectJavaScriptModule, 'function', 'shared module inspector is required');
  return parser.inspectJavaScriptModule(input);
};
const read = input => {
  assert.equal(typeof graph.readArchitectureGraph, 'function', 'immutable architecture graph is required');
  return graph.readArchitectureGraph(input);
};
const canonical = value =>
  JSON.stringify(value, function (key, item) {
    return item && typeof item === 'object' && !Array.isArray(item)
      ? Object.fromEntries(
          Object.keys(item)
            .sort()
            .map(key => [key, item[key]]),
        )
      : item;
  });
const hash = value => createHash('sha256').update(canonical(value)).digest('hex');
const git = (cwd, ...args) =>
  execFileSync('git', ['-c', 'core.autocrlf=false', ...args], { cwd, encoding: 'utf8', windowsHide: true }).trim();
async function put(root, file, text) {
  await mkdir(path.dirname(path.join(root, file)), { recursive: true });
  await writeFile(path.join(root, file), text);
}
const policy = () => ({
  schemaVersion: 1,
  version: 1,
  productRoots: ['src'],
  modules: [
    { id: 'app', roots: ['src/app'], layer: 'app', public: [], allow: ['core'] },
    { id: 'core', roots: ['src/core'], layer: 'core', public: ['src/core/index.mjs'], allow: [] },
  ],
  layers: { app: ['core'], core: [] },
  forbiddenImports: [],
  cycles: 'forbid',
  contracts: 'architecture.contracts.json',
  baseline: [],
  exceptions: [],
  protectedPaths: [],
});
async function fixture(t, extra = {}) {
  const project = await mkdtemp(path.join(os.tmpdir(), 'kodo-architecture-'));
  t.after(() => rm(project, { recursive: true, force: true }));
  git(project, 'init', '-q');
  git(project, 'config', 'user.email', 'fixture@example.invalid');
  git(project, 'config', 'user.name', 'Fixture');
  for (const [file, source] of Object.entries({
    'package.json': '{"type":"module"}',
    'src/core/index.mjs': 'export const value = 1;',
    'src/app/main.mjs': "import {value} from '../core/index.mjs'; export default value;",
    'tests/oracle.test.mjs': 'throw new Error("must never execute");',
    ...extra,
  }))
    await put(project, file, source);
  const commit = () => {
    git(project, 'add', '-A');
    git(project, 'commit', '-qm', 'fixture');
    return git(project, 'rev-parse', 'HEAD');
  };
  return { project, commit, headSha: commit(), policy: policy() };
}

test('Shared inspector preserves dependency occurrences kinds offsets and sorted export names', () => {
  const source =
    "import './a.mjs'; export {x as z} from './a.mjs'; await import('./b.mjs'); require('pkg'); require.resolve('pkg'); export default 1; export const a = 2;";
  const result = inspect({ file: 'src/main.mjs', source });
  assert.deepEqual(result, {
    schemaVersion: 1,
    dependencies: [
      { specifier: './a.mjs', kind: 'import', offset: 0 },
      { specifier: './a.mjs', kind: 'reexport', offset: source.indexOf('export') },
      { specifier: './b.mjs', kind: 'dynamic-import', offset: source.indexOf('import(') },
      { specifier: 'pkg', kind: 'require', offset: source.indexOf('require(') },
      { specifier: 'pkg', kind: 'require-resolve', offset: source.indexOf('require.resolve') },
    ],
    exports: ['a', 'default', 'z'],
    unsupported: [],
  });
});

test('Shared inspector reports uncertainty without source or parser error leakage', () => {
  for (const [source, reason, scope] of [
    ['await import(name);', 'computed-loader', 'dependency'],
    ['const load = require; load(name);', 'aliased-loader', 'dependency'],
    ["export * from './a.mjs';", 'export-star', 'exports'],
    ['module.exports = 1;', 'commonjs-exports', 'exports'],
    ['export const {x} = object;', 'export-pattern', 'exports'],
    ['export const secret = ;', 'parse-error', 'dependency'],
  ]) {
    const result = inspect({ file: 'src/a.mjs', source });
    assert.ok(
      result.unsupported.some(item => item.reason === reason && item.scope === scope),
      reason,
    );
    for (const item of result.unsupported) assert.deepEqual(Object.keys(item).sort(), ['offset', 'reason', 'scope']);
  }
  assert.deepEqual(
    inspect({ file: 'src/a.mjs', source: '// import("fake")\nconst text = "require(ignored)";' }).dependencies,
    [],
  );
});

test('Historical graph reads the requested commit while checkout and source differ', async t => {
  const fx = await fixture(t),
    base = fx.headSha;
  await put(fx.project, 'src/core/index.mjs', 'export const changed = 2;');
  fx.commit();
  await put(fx.project, 'src/core/index.mjs', 'dirty bytes are not a snapshot');
  const result = await read({ ...fx, headSha: base });
  assert.equal(result.headSha, base);
  assert.deepEqual(result.nodes.find(node => node.path === 'src/core/index.mjs').exports, ['value']);
  assert.deepEqual(
    result.nodes.find(node => node.path === 'src/core/index.mjs'),
    {
      id: 'file:src/core/index.mjs',
      kind: 'file',
      path: 'src/core/index.mjs',
      module: 'core',
      layer: 'core',
      sourceHash: createHash('sha256').update('export const value = 1;').digest('hex'),
      exports: ['value'],
      public: true,
    },
  );
  assert.deepEqual(result.unsupported, []);
  assert.deepEqual(
    result.files.map(file => file.path),
    ['package.json', 'src/app/main.mjs', 'src/core/index.mjs', 'tests/oracle.test.mjs'],
  );
  assert.equal(result.sourceHash, hash(result.files));
  assert.equal(result.policyHash, hash(fx.policy));
  assert.equal(
    result.edges[0].id,
    hash(['file:src/app/main.mjs', 'file:src/core/index.mjs', 'import', '../core/index.mjs', 0]),
  );
  assert.deepEqual(await read({ ...fx, headSha: base }), result);
  fx.policy.modules[0].allow.push('mutated');
  assert.deepEqual(result.modules[0].allow, ['core']);
});

test('Product roots include unowned JS while outside tracked sources are inventory only', async t => {
  const fx = await fixture(t, {
    'src/unowned.js': 'export const orphan = true;',
    'docs/demo.ts': 'invalid TS',
    'src/app/theme.css': 'body{}',
    'scripts/task.mjs': 'invalid JS',
  });
  const result = await read(fx);
  const orphan = result.nodes.find(node => node.path === 'src/unowned.js');
  assert.equal(orphan.module, null);
  assert.equal(orphan.layer, null);
  assert.equal(orphan.public, false);
  assert.equal(result.nodes.length, 3);
  assert.equal(result.files.length, 8);
  assert.deepEqual(result.unsupported, []);
});

test('Graph resolves builtins declared externals and local workspace package entries', async t => {
  const fx = await fixture(t, {
    'package.json': '{"type":"module","dependencies":{"pkg":"1"}}',
    'src/core/package.json':
      '{"type":"module","name":"@test/core","exports":{".":"./index.mjs","./detail":"./detail.js"}}',
    'src/core/detail.js': 'export function detail() {}',
    'src/app/main.mjs': "import '@test/core'; import '@test/core/detail'; import 'node:fs'; import 'pkg/sub';",
  });
  const result = await read(fx);
  assert.deepEqual(
    result.edges.map(edge => edge.to),
    ['file:src/core/index.mjs', 'file:src/core/detail.js', 'builtin:fs', 'external:pkg/sub'],
  );
  assert.deepEqual(
    result.nodes.find(node => node.id === 'builtin:fs'),
    {
      id: 'builtin:fs',
      kind: 'builtin',
      path: null,
      module: null,
      layer: null,
      sourceHash: null,
      exports: [],
      public: false,
    },
  );
  assert.deepEqual(result.unsupported, []);
});

test('Unknown out-of-product ambiguous and unsafe imports have explicit blocked edges', async t => {
  const fx = await fixture(t, {
    'src/app/main.mjs':
      "import 'missing'; import '../../tests/oracle.test.mjs'; import '../core/choice'; import '../../../outside.mjs';",
    'src/core/choice.mjs': 'export {};',
    'src/core/choice.js': 'export {};',
  });
  const result = await read(fx);
  assert.deepEqual(
    result.edges.map(edge => edge.to),
    [null, null, null, null],
  );
  assert.deepEqual(
    result.unsupported.map(item => item.reason),
    ['unresolved-import', 'out-of-product-import', 'ambiguous-import', 'unsafe-path'],
  );
  for (const item of result.unsupported) assert.equal(item.id, hash([item.scope, item.file, item.reason, item.offset]));
});

test('Non ESM products and unsupported public exports are explicit graph uncertainty', async t => {
  const fx = await fixture(t, {
    'src/code.ts': 'export const v: number = 1;',
    'src/legacy.cjs': 'module.exports = 1;',
    'src/legacy/package.json': '{}',
    'src/legacy/code.js': 'exports.value = 1;',
    'src/core/index.mjs': "export * from './detail.mjs';",
    'src/core/detail.mjs': 'export const detail = 1;',
  });
  const result = await read(fx);
  for (const file of ['src/code.ts', 'src/legacy.cjs', 'src/legacy/code.js'])
    assert.ok(
      result.unsupported.some(
        item => item.scope === 'language' && item.file === file && item.reason === 'unsupported-language',
      ),
      file,
    );
  assert.ok(result.unsupported.some(item => item.file === 'src/core/index.mjs' && item.reason === 'export-star'));
});

test('Graph rejects non-root projects abbreviated revisions and unsafe policy paths', async t => {
  const fx = await fixture(t);
  await assert.rejects(
    () => read({ ...fx, project: path.join(fx.project, 'src') }),
    error => error.code === 'unsafe_path',
  );
  await assert.rejects(
    () => read({ ...fx, headSha: fx.headSha.slice(0, 8) }),
    error => error.code === 'arguments',
  );
  await assert.rejects(
    () => read({ ...fx, headSha: '0'.repeat(40) }),
    error => error.code === 'configuration',
  );
  await assert.rejects(
    () => read({ ...fx, policy: { ...fx.policy, productRoots: ['../outside'] } }),
    error => error.code === 'unsafe_path',
  );
});

test('Shared inspector handles named APIs namespace exports and literal strings without executing', () => {
  const source =
    "export function run() {} export class Box {} const x = 1; export { x as 'a-b' }; export * as namespace from './api.mjs'; export let first, second;";
  const result = inspect({ file: 'src/api.mjs', source });
  assert.deepEqual(result.exports, ['Box', 'a-b', 'first', 'namespace', 'run', 'second']);
  assert.deepEqual(result.unsupported, []);
  assert.deepEqual(
    inspect({ file: 'src/old.cjs', source: "const api = require('./api.cjs'); module.exports = api;" }).dependencies,
    [{ specifier: './api.cjs', kind: 'require', offset: 12 }],
  );
});

test('Package conditions aliases malformed manifests and duplicate names block without guessing', async t => {
  const cases = [
    {
      extra: {
        'src/core/package.json':
          '{"name":"lib","type":"module","exports":{"import":"./index.mjs","require":"./legacy.cjs"}}',
      },
      source: "import 'lib';",
      reason: 'unsupported-package',
    },
    {
      extra: { 'package.json': '{"type":"module","imports":{"#alias":"./src/core/index.mjs"}}' },
      source: "import '#alias';",
      reason: 'unsupported-package',
    },
    { extra: { 'package.json': '{ malformed' }, source: "import 'lib';", reason: 'unsupported-package' },
    {
      extra: {
        'src/core/package.json': '{"name":"lib","exports":"./index.mjs"}',
        'src/other/package.json': '{"name":"lib","exports":"./index.mjs"}',
      },
      source: "import 'lib';",
      reason: 'ambiguous-import',
    },
    {
      extra: { 'src/core/package.json': '{"name":"lib","exports":"../outside.mjs"}' },
      source: "import 'lib';",
      reason: 'unsupported-package',
    },
  ];
  for (const item of cases) {
    const fx = await fixture(t, { ...item.extra, 'src/app/main.mjs': item.source });
    const result = await read(fx);
    assert.ok(
      result.unsupported.some(row => row.reason === item.reason),
      item.reason,
    );
    assert.ok(result.edges.some(edge => edge.to === null));
  }
});

test('Object reads preserve Unicode bytes and inventory binary resources without executing filters', async t => {
  const source = "// 🦉\nexport const привет = '🌳';";
  const fx = await fixture(t, {
    'src/core/index.mjs': source,
    'src/app/data.bin': Buffer.from([0, 255, 128]),
    '.gitattributes': '*.mjs filter=tripwire\n',
  });
  git(fx.project, 'config', 'filter.tripwire.clean', 'echo called > filter-ran.txt; exit 1');
  git(fx.project, 'config', 'filter.tripwire.smudge', 'echo called > filter-ran.txt; exit 1');
  git(fx.project, 'config', 'filter.tripwire.required', 'true');
  const result = await read(fx),
    node = result.nodes.find(node => node.path === 'src/core/index.mjs');
  assert.equal(node.sourceHash, createHash('sha256').update(source).digest('hex'));
  assert.deepEqual(node.exports, ['привет']);
  assert.deepEqual(result.unsupported, []);
  await assert.rejects(() => readFile(path.join(fx.project, 'filter-ran.txt')), { code: 'ENOENT' });
});

test('Invalid UTF8 product source blocks instead of hashing replacement text as an API', async t => {
  const fx = await fixture(t, { 'src/core/index.mjs': Buffer.from([47, 47, 255]) });
  const result = await read(fx);
  assert.ok(result.unsupported.some(item => item.file === 'src/core/index.mjs' && item.reason === 'parse-error'));
  assert.equal(
    result.nodes.find(item => item.path === 'src/core/index.mjs').sourceHash,
    createHash('sha256')
      .update(Buffer.from([47, 47, 255]))
      .digest('hex'),
  );
});

test('Git links and submodules stay in full inventory with explicit tree uncertainty', async t => {
  const fx = await fixture(t);
  const oid = execFileSync('git', ['hash-object', '-w', '--stdin', '--no-filters'], {
    cwd: fx.project,
    input: '../outside.mjs',
    encoding: 'utf8',
    windowsHide: true,
  }).trim();
  git(fx.project, 'update-index', '--add', '--cacheinfo', '120000', oid, 'src/core/link.mjs');
  git(fx.project, 'update-index', '--add', '--cacheinfo', '160000', fx.headSha, 'vendor/module');
  git(fx.project, 'commit', '-qm', 'unsafe tree');
  const headSha = git(fx.project, 'rev-parse', 'HEAD');
  const result = await read({ ...fx, headSha });
  assert.equal(result.files.find(file => file.path === 'src/core/link.mjs').mode, '120000');
  assert.ok(result.unsupported.some(item => item.scope === 'tree' && item.file === 'src/core/link.mjs'));
  assert.ok(result.unsupported.some(item => item.scope === 'tree' && item.file === 'vendor/module'));
});

test('Physical Windows root aliases work and symlink repository roots are rejected', async t => {
  const fx = await fixture(t),
    wrapper = await mkdtemp(path.join(os.tmpdir(), 'kodo-architecture-alias-'));
  t.after(() => rm(wrapper, { recursive: true, force: true }));
  const link = path.join(wrapper, 'link');
  await symlink(fx.project, link, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(
    () => read({ ...fx, project: link }),
    error => error.code === 'unsafe_path',
  );
  if (process.platform === 'win32') {
    const physical = await realpath(fx.project),
      alias = path.join(path.dirname(physical), path.basename(physical).toUpperCase());
    assert.notEqual(alias, physical);
    assert.deepEqual(await read({ ...fx, project: alias }), await read(fx));
  }
});

test('Product CJS loaders block even with literal dependencies and harmless builtin IO stays supported', async t => {
  const fx = await fixture(t, {
    'src/app/main.mjs': "const p = require('node:path');",
    'src/core/index.mjs': "import fs from 'node:fs/promises'; export const value = fs;",
  });
  const result = await read(fx);
  assert.deepEqual(
    result.edges.map(edge => edge.kind),
    ['require', 'import'],
  );
  assert.ok(result.unsupported.some(item => item.file === 'src/app/main.mjs' && item.scope === 'language'));
  assert.ok(!result.unsupported.some(item => item.file === 'src/core/index.mjs'));
});

test('Safe relative paths with spaces resolve and outside inventory changes affect only snapshot hash', async t => {
  const fx = await fixture(t, {
    'src/core/with space.mjs': 'export const spaced = 1;',
    'src/app/main.mjs': "import '../core/with space.mjs';",
  });
  const before = await read(fx);
  assert.deepEqual(before.unsupported, []);
  assert.equal(before.edges[0].to, 'file:src/core/with space.mjs');
  await put(fx.project, 'docs/notes.txt', 'inventory changes are still hashed');
  const after = await read({ ...fx, headSha: fx.commit() });
  assert.notEqual(after.sourceHash, before.sourceHash);
  assert.deepEqual(after.nodes, before.nodes);
  assert.deepEqual(after.edges, before.edges);
});

test('Tracked file inventory limit blocks before partial graphs can be accepted', async t => {
  const fx = await fixture(t),
    oid = git(fx.project, 'rev-parse', 'HEAD:src/core/index.mjs');
  const input = Array.from({ length: 20000 }, (_, index) => `100644 ${oid}\tdocs/file-${index}.txt\n`).join('');
  execFileSync('git', ['update-index', '--index-info'], { cwd: fx.project, input, windowsHide: true });
  git(fx.project, 'commit', '-qm', 'oversized tree');
  await assert.rejects(
    () => read({ ...fx, headSha: git(fx.project, 'rev-parse', 'HEAD') }),
    error => error.code === 'scope_limit',
  );
});

test('Missing inventory-only Git objects block instead of producing a complete snapshot', async t => {
  const fx = await fixture(t);
  git(fx.project, 'update-index', '--add', '--info-only', '--cacheinfo', '100644', '1'.repeat(40), 'docs/missing.txt');
  const tree = git(fx.project, 'write-tree', '--missing-ok'),
    headSha = git(fx.project, 'commit-tree', tree, '-p', fx.headSha, '-m', 'missing object');
  await assert.rejects(
    () => read({ ...fx, headSha }),
    error => error.code === 'configuration',
  );
});

test('Malformed external dependency declarations remain unsupported rather than accepted package edges', async t => {
  const fx = await fixture(t, {
    'package.json': '{"type":"module","dependencies":{"pkg":{}}}',
    'src/app/main.mjs': "import 'pkg';",
  });
  const result = await read(fx);
  assert.equal(result.edges[0].to, null);
  assert.ok(result.unsupported.some(item => item.reason === 'unsupported-package' && item.file === 'src/app/main.mjs'));
});
