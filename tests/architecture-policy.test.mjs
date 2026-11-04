import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, readdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { validateArchitecturePolicy, evaluateArchitecture } from '../runtime/architecture-policy.mjs';

const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const hash = value => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
const source = value => createHash('sha256').update(value).digest('hex');
const clone = value => structuredClone(value);
function policy() {
  return { schemaVersion: 1, version: 1, productRoots: ['src'], modules: [
    { id: 'app', roots: ['src/app'], layer: 'app', public: ['src/app/index.mjs'], allow: ['core'] },
    { id: 'core', roots: ['src/core'], layer: 'core', public: ['src/core/index.mjs'], allow: [] }
  ], layers: { app: ['core'], core: [] }, forbiddenImports: [{ from: 'core', to: 'app' }], cycles: 'forbid', contracts: 'architecture.contracts.json', baseline: [], exceptions: [], protectedPaths: ['architecture.contracts.json', 'architecture.policy.json'] };
}
function graph(p, { paths = ['src/app/index.mjs', 'src/core/index.mjs'], links = [[0, 1]], sources = {} } = {}) {
  const nodes = paths.map(file => {
    const owner = p.modules.find(module => module.roots.some(root => file.startsWith(root + '/')));
    return { id: 'file:' + file, kind: 'file', path: file, module: owner?.id ?? null, layer: owner?.layer ?? null, sourceHash: source(sources[file] ?? file), exports: [], public: owner?.public.includes(file) ?? false };
  });
  const edges = links.map(([from, to], offset) => {
    const data = { from: nodes[from].id, to: nodes[to].id, kind: 'import', specifier: './target.mjs', offset };
    return { id: hash([data.from, data.to, data.kind, data.specifier, offset]), ...data };
  });
  const files = paths.map(file => ({ path: file, mode: '100644', oid: 'a'.repeat(40) })).sort((a, b) => a.path.localeCompare(b.path));
  return { schemaVersion: 1, headSha: 'b'.repeat(40), sourceHash: hash(files), policyHash: hash(validateArchitecturePolicy(p)), productRoots: [...p.productRoots], files, modules: clone(p.modules), nodes, edges, unsupported: [] };
}
const rules = (p, g) => evaluateArchitecture({ policy: p, graph: g }).findings;

test('Policy normalizes sets and modules without mutating input or debt order', () => {
  const p = policy(); p.modules.reverse(); p.protectedPaths.reverse();
  p.baseline = [{ findingId: 'f'.repeat(64), owner: 'team', reason: 'legacy', reviewAfter: '2027-01-01T00:00:00.000Z' }, { findingId: 'a'.repeat(64), owner: 'team', reason: 'legacy', reviewAfter: '2027-01-02T00:00:00Z' }];
  const before = clone(p), result = validateArchitecturePolicy(p);
  assert.deepEqual(result, { ...before, modules: [...before.modules].reverse(), protectedPaths: [...before.protectedPaths].sort() });
  assert.deepEqual(p, before); assert.notEqual(result.modules[0], p.modules[1]);
  assert.deepEqual(validateArchitecturePolicy(result), result);
});

const invalid = [
  ['unknown root key', p => { p.protected = []; }],
  ['missing required key', p => { delete p.contracts; }],
  ['unknown module key', p => { p.modules[0].private = []; }],
  ['unknown forbidden key', p => { p.forbiddenImports[0].reason = 'x'; }],
  ['empty product roots', p => { p.productRoots = []; }],
  ['duplicate product roots', p => { p.productRoots.push('src'); }],
  ['nested product roots', p => { p.productRoots.push('src/core'); }],
  ['overlapping module roots', p => { p.modules[0].roots = ['src']; }],
  ['nested roots in module', p => { p.modules[0].roots.push('src/app/nested'); }],
  ['module outside product', p => { p.modules[0].roots = ['other/app']; }],
  ['duplicate module id', p => { p.modules[1].id = 'app'; }],
  ['unknown allowed module', p => { p.modules[0].allow = ['missing']; }],
  ['duplicate allow', p => { p.modules[0].allow = ['core', 'core']; }],
  ['unknown layer', p => { p.modules[0].layer = 'missing'; }],
  ['unknown layer dependency', p => { p.layers.app = ['missing']; }],
  ['duplicate layer dependency', p => { p.layers.app = ['core', 'core']; }],
  ['unknown forbidden module', p => { p.forbiddenImports[0].from = 'missing'; }],
  ['duplicate forbidden pair', p => { p.forbiddenImports.push(clone(p.forbiddenImports[0])); }],
  ['impossible public path', p => { p.modules[0].public = ['src/core/index.mjs']; }],
  ['public root directory', p => { p.modules[0].public = ['src/app']; }],
  ['non executable public entry', p => { p.modules[0].public = ['src/app/style.css']; }],
  ['duplicate public entry', p => { p.modules[0].public.push('src/app/index.mjs'); }],
  ['old cycles mode', p => { p.cycles = 'allow'; }],
  ['invalid version', p => { p.version = 0; }],
  ['invalid schema', p => { p.schemaVersion = 2; }],
  ['undefined required value', p => { p.exceptions = undefined; }],
  ['oversized modules', p => { p.modules = Array(257).fill(p.modules[0]); }],
  ['oversized debt', p => { p.baseline = Array(10001).fill({}); }],
  ['malformed debt', p => { p.exceptions = [{ findingId: 'bad', owner: '', reason: '', reviewAfter: 'tomorrow' }]; }],
  ['non string finding hash', p => { p.baseline = [{ findingId: ['a'.repeat(64)], owner: 'x', reason: 'x', reviewAfter: '2027-01-01T00:00:00Z' }]; }],
  ['unknown debt key', p => { p.baseline = [{ findingId: 'a'.repeat(64), owner: 'x', reason: 'x', reviewAfter: '2027-01-01T00:00:00Z', approved: true }]; }],
  ['non UTC debt time', p => { p.baseline = [{ findingId: 'a'.repeat(64), owner: 'x', reason: 'x', reviewAfter: '2027-01-01T01:00:00+01:00' }]; }],
  ['impossible UTC date', p => { p.baseline = [{ findingId: 'a'.repeat(64), owner: 'x', reason: 'x', reviewAfter: '2027-02-30T00:00:00Z' }]; }]
];
for (const [name, mutate] of invalid) test('Policy rejects ' + name, () => {
  const p = policy(); mutate(p); assert.throws(() => validateArchitecturePolicy(p));
});
const unsafe = ['', '.', '..', '../src', '/src', 'C:/src', 'src\\core', 'src/../core', 'src//core', 'src/*', 'src/{a,b}', 'src/?.mjs', 'src/%2e%2e', 'src/\u0000x', 'src/CON', 'src/core.', 'src/core ', 'src/e\u0301'];
for (let index = 0; index < unsafe.length; index++) test('Policy rejects unsafe canonical path case ' + index, () => {
  const p = policy(); p.productRoots = [unsafe[index]]; assert.throws(() => validateArchitecturePolicy(p));
});

test('Permitted public cross-module dependency produces no findings', () => {
  const p = policy(), g = graph(p), before = clone(g);
  assert.deepEqual(evaluateArchitecture({ policy: p, graph: g }), { schemaVersion: 1, findings: [] }); assert.deepEqual(g, before);
});
for (const [name, mutate, expected] of [
  ['allow list', p => { p.modules[0].allow = []; }, 'dependency.not-allowed'],
  ['layer direction', p => { p.layers.app = []; }, 'layer.direction'],
  ['private entry', p => { p.modules[1].public = []; }, 'entry.private'],
  ['forbidden dependency', p => { p.forbiddenImports.push({ from: 'app', to: 'core' }); }, 'dependency.forbidden']
]) test('Dependency rule isolates ' + name + ' and records both source hashes', () => {
  const p = policy(); mutate(p); const g = graph(p), findings = rules(p, g);
  assert.deepEqual(findings.map(f => f.ruleId), [expected]);
  const body = { ruleId: expected, severity: 'error', file: 'src/app/index.mjs', offset: 0, fromModule: 'app', toModule: 'core', relatedFiles: ['src/core/index.mjs'], sourceHashes: [
    { file: 'src/app/index.mjs', sha256: source('src/app/index.mjs') }, { file: 'src/core/index.mjs', sha256: source('src/core/index.mjs') }
  ] };
  assert.deepEqual(findings[0], { id: hash(body), ...body });
  const changed = graph(p, { sources: { 'src/core/index.mjs': 'changed target' } });
  assert.notEqual(rules(p, changed)[0].id, findings[0].id);
});

test('All independent cross-module violations remain visible together', () => {
  const p = policy(); p.modules[0].allow = []; p.layers.app = []; p.modules[1].public = []; p.forbiddenImports.push({ from: 'app', to: 'core' });
  assert.deepEqual(rules(p, graph(p)).map(f => f.ruleId).sort(), ['dependency.forbidden', 'dependency.not-allowed', 'entry.private', 'layer.direction']);
});
test('Unowned product file fails ownership while inventory-only files are neutral', () => {
  const p = policy(), g = graph(p, { paths: ['src/unowned.mjs'], links: [] });
  g.files.push({ path: 'tests/oracle.mjs', mode: '100644', oid: 'a'.repeat(40) });
  const findings = rules(p, g); assert.equal(findings.length, 1); assert.equal(findings[0].ruleId, 'ownership.unowned');
  assert.equal(findings[0].file, 'src/unowned.mjs'); assert.deepEqual(findings[0].sourceHashes, [{ file: 'src/unowned.mjs', sha256: source('src/unowned.mjs') }]);
});
test('Self-module private imports and file cycles are permitted', () => {
  const p = policy(); assert.deepEqual(rules(p, graph(p, { paths: ['src/app/index.mjs', 'src/app/private.mjs'], links: [[0, 1], [1, 0]] })), []);
});
test('Builtins and external imports are neutral for module boundary rules', () => {
  const p = policy(), g = graph(p, { paths: ['src/app/index.mjs'], links: [] });
  for (const [kind, name] of [['builtin', 'fs'], ['external', 'pkg/subpath']]) {
    const id = kind + ':' + name; g.nodes.push({ id, kind, path: null, module: null, layer: null, sourceHash: null, exports: [], public: false });
    g.edges.push({ id: hash(id), from: g.nodes[0].id, to: id, kind: 'import', specifier: name, offset: 0 });
  }
  assert.deepEqual(rules(p, g), []);
});
test('Module cycles produce one canonical finding per strongly connected component', () => {
  const p = policy(); p.modules[1].allow = ['app']; p.modules[1].layer = 'app'; p.layers.app = ['app']; p.forbiddenImports = [];
  const g = graph(p, { links: [[0, 1], [1, 0]] }), findings = rules(p, g);
  const cycles = findings.filter(f => f.ruleId === 'dependency.cycle'); assert.equal(cycles.length, 1); assert.equal(findings.length, 1);
  assert.deepEqual(cycles[0].relatedFiles, ['src/app/index.mjs', 'src/core/index.mjs']);
  assert.deepEqual(cycles[0].sourceHashes.map(row => row.file), cycles[0].relatedFiles);
  const shuffled = clone(g); shuffled.nodes.reverse(); shuffled.edges.reverse();
  assert.deepEqual(rules(p, shuffled), findings);
  const acyclic = clone(g); acyclic.edges.pop(); assert.equal(rules(p, acyclic).filter(f => f.ruleId === 'dependency.cycle').length, 0);
});
test('Graph limit overflow and dangling references block instead of returning a clean result', () => {
  const p = policy(), g = graph(p); g.edges[0].to = 'file:src/missing.mjs'; assert.throws(() => rules(p, g));
  g.edges = Array(100001).fill(g.edges[0]); assert.throws(() => rules(p, g), error => error.code === 'scope_limit');
});

test('Graph policy hash and product scope must match the evaluated normalized policy', () => {
  const p = policy(), g = graph(p); g.policyHash = '0'.repeat(64);
  assert.throws(() => rules(p, g), error => error.code === 'configuration');
  g.policyHash = hash(validateArchitecturePolicy(p)); g.productRoots = ['other'];
  assert.throws(() => rules(p, g), error => error.code === 'configuration');
});
test('Ownership and public boundaries use policy paths rather than claimed node flags', () => {
  const p = policy(), g = graph(p, { paths: ['src/app/index.mjs', 'src/core/private.mjs'] });
  g.nodes[1].module = 'app'; g.nodes[1].public = true;
  assert.deepEqual(rules(p, g).map(f => f.ruleId), ['entry.private']);
  const unowned = graph(p, { paths: ['src/unowned.mjs'], links: [] }); unowned.nodes[0].module = 'core';
  assert.deepEqual(rules(p, unowned).map(f => f.ruleId), ['ownership.unowned']);
});
test('An unassigned initial module map remains valid and exposes product ownership failures', () => {
  const p = policy(); p.modules = []; p.layers = {}; p.forbiddenImports = [];
  assert.deepEqual(validateArchitecturePolicy(p), p);
  assert.equal(rules(p, graph(p, { paths: ['src/new.mjs'], links: [] }))[0].ruleId, 'ownership.unowned');
});
test('Same-layer and bidirectional layer permissions do not exempt actual module cycles', () => {
  const p = policy(); p.layers.core = ['app']; p.modules[1].allow = ['app']; p.forbiddenImports = [];
  assert.deepEqual(rules(p, graph(p)), []);
  assert.deepEqual(rules(p, graph(p, { links: [[0, 1], [1, 0]] })).map(f => f.ruleId), ['dependency.cycle']);
});
test('Module schema accepts the exact 256-module boundary and rejects the adjacent overflow', () => {
  const p = policy(); p.layers = { product: [] }; p.forbiddenImports = [];
  p.modules = Array.from({ length: 256 }, (_, index) => ({ id: 'm' + index, roots: ['src/m' + index], layer: 'product', public: [], allow: [] }));
  assert.equal(validateArchitecturePolicy(p).modules.length, 256);
  p.modules.push({ id: 'overflow', roots: ['src/overflow'], layer: 'product', public: [], allow: [] });
  assert.throws(() => validateArchitecturePolicy(p), error => error.code === 'scope_limit');
});
test('Finding limit accepts exactly 10000 findings and blocks the adjacent overflow', () => {
  const p = policy(), paths = Array.from({ length: 10000 }, (_, index) => 'src/unowned' + index + '.mjs');
  assert.equal(rules(p, graph(p, { paths, links: [] })).length, 10000);
  paths.push('src/overflow.mjs');
  assert.throws(() => rules(p, graph(p, { paths, links: [] })), error => error.code === 'scope_limit');
});
test('Graph inventory file limit blocks before accepting a partial product graph', () => {
  const p = policy(), g = graph(p); g.files = Array(20001).fill(g.files[0]);
  assert.throws(() => rules(p, g), error => error.code === 'scope_limit');
});
test('Evaluation rejects unknown wrapper keys and non string graph hashes with typed errors', () => {
  const p = policy(), g = graph(p);
  assert.throws(() => evaluateArchitecture({ policy: p, graph: g, approved: true }), error => error.code === 'configuration');
  assert.throws(() => evaluateArchitecture(null), error => error.code === 'configuration');
  g.nodes[0].sourceHash = [g.nodes[0].sourceHash];
  assert.throws(() => rules(p, g), error => error.code === 'configuration');
});
test('Policy set permutations yield the same finding IDs and duplicate edges cannot hide failures', () => {
  const p = policy(); p.modules[0].allow = [];
  const g = graph(p), expected = rules(p, g); p.modules.reverse(); p.protectedPaths.reverse();
  assert.deepEqual(rules(p, g), expected);
  g.edges.push({ ...g.edges[0] }); assert.throws(() => rules(p, g));
});

// Manual layout examples: roots are explicit starters, never inferred or applied.
const layouts = {
  'modular-monolith': { app: 'src/app', core: 'src/core' },
  'plugin-host': { host: 'src/host', plugin: 'src/plugins/example' },
  library: { api: 'src/api', internal: 'src/internal' },
  'desktop-app': { main: 'src/main', renderer: 'src/renderer', shared: 'src/shared' },
  'headless-web': { routes: 'src/routes', services: 'src/services', domain: 'src/domain' }
};
test('Five manual layout starters are normalized valid data with explicit public entries', async t => {
  const dir = new URL('../presets/architecture/', import.meta.url);
  assert.deepEqual((await readdir(dir)).sort(), Object.keys(layouts).map(name => name + '.json').sort());
  for (const [name, roots] of Object.entries(layouts)) await t.test(name, async () => {
    const value = JSON.parse(await readFile(new URL(name + '.json', dir), 'utf8'));
    assert.deepEqual(validateArchitecturePolicy(value), value);
    assert.deepEqual(Object.fromEntries(value.modules.map(module => [module.id, module.roots[0]])), roots);
    assert.equal(value.contracts, 'architecture.contracts.json'); assert.ok(value.protectedPaths.includes('architecture.policy.json'));
    for (const module of value.modules) for (const file of module.public) assert.ok(file.startsWith(module.roots[0] + '/'));
    for (const module of value.modules) for (const allowed of module.allow) {
      const target = value.modules.find(candidate => candidate.id === allowed);
      const g = graph(value, { paths: [module.public[0], target.public[0]] });
      assert.deepEqual(rules(value, g), [], 'Starter allowed edge must pass all configured rules');
      const denied = clone(value); denied.modules.find(candidate => candidate.id === module.id).allow = [];
      const deniedGraph = graph(denied, { paths: [module.public[0], target.public[0]] });
      assert.deepEqual(rules(denied, deniedGraph).map(f => f.ruleId), ['dependency.not-allowed']);
    }
  });
});
test('Validation and evaluation are pure when called from an independent temporary Git fixture', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'kodo-policy-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', args, { cwd: directory, encoding: 'utf8', windowsHide: true });
  git('init', '-q'); await writeFile(path.join(directory, 'architecture.policy.json'), JSON.stringify(policy()));
  const before = git('status', '--porcelain=v1', '-z'); const p = validateArchitecturePolicy(policy());
  assert.deepEqual(rules(p, graph(p)), []); assert.equal(git('status', '--porcelain=v1', '-z'), before);
  assert.equal(await readFile(path.join(directory, 'architecture.policy.json'), 'utf8'), JSON.stringify(policy()));
});
