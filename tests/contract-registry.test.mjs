import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { ContractRegistry } from '../runtime/contract-registry.mjs';

const hash = value => createHash('sha256').update(typeof value === 'string' ? value : canonical(value)).digest('hex');
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}
const entry = 'src/core/index.mjs';
const producerTest = 'tests/core.test.mjs';
const contract = (extra = {}) => ({ id: 'core-api', module: 'core', version: 1, entry, exports: ['value'], shapeHash: hash({ exports: ['value'] }), tests: [producerTest], ...extra });
const registry = (contracts = [contract()], migrations = []) => ({ schemaVersion: 1, contracts, migrations });
function graph({ publicCore = true, extraContracts = false } = {}) {
  const modules = ['core', 'app', 'web'].map(id => ({ id, roots: [`src/${id}`], layer: id, public: id === 'core' ? (publicCore ? [entry] : []) : (extraContracts ? [`src/${id}/index.mjs`] : []), allow: [] }));
  const nodes = modules.map(module => ({ id: `file:src/${module.id}/index.mjs`, kind: 'file', path: `src/${module.id}/index.mjs`, module: module.id, layer: module.layer, sourceHash: hash(`${module.id}-source`), exports: ['value'], public: module.public.length > 0 }));
  const files = [entry, 'src/app/index.mjs', 'src/web/index.mjs', producerTest, 'tests/app.test.mjs', 'tests/web.test.mjs', 'tests/core-replacement.test.mjs', 'docs/migrate.md', 'src/core/style.css'].sort().map(path => ({ path, mode: '100644', oid: 'a'.repeat(40) }));
  const edges = [['app', 'core'], ['web', 'app']].map(([from, to]) => ({ id: hash([from, to]), from: `file:src/${from}/index.mjs`, to: `file:src/${to}/index.mjs`, kind: 'import', specifier: `../${to}/index.mjs`, offset: 0 }));
  return { schemaVersion: 1, headSha: 'a'.repeat(40), sourceHash: hash(files), policyHash: hash('policy'), productRoots: ['src'], files, modules, nodes, edges, unsupported: [] };
}
function input() { return { base: registry(), head: registry(), baseGraph: graph(), headGraph: graph(), changedPaths: [] }; }
const plan = value => new ContractRegistry().plan(value);
const rules = result => result.findings.map(row => row.ruleId);
function migration(extra = {}) {
  return { contractId: 'core-api', fromVersion: 1, toVersion: 2, plan: 'docs/migrate.md', consumers: ['app', 'web'], tests: [{ module: 'core', files: [producerTest] }, { module: 'app', files: ['tests/app.test.mjs'] }, { module: 'web', files: ['tests/web.test.mjs'] }], ...extra };
}
function breaking() {
  const value = input();
  value.head.contracts[0] = contract({ version: 2, exports: ['replacement'], shapeHash: hash('declared-v2') });
  value.headGraph.nodes[0].exports = ['replacement'];
  value.headGraph.nodes[0].sourceHash = hash('core-v2');
  value.headGraph.nodes[1].sourceHash = hash('app-v2');
  value.headGraph.nodes[2].sourceHash = hash('web-v2');
  value.head.migrations.push(migration());
  value.changedPaths = [entry, 'src/app/index.mjs', 'src/web/index.mjs'];
  return value;
}
function assertFindingRecords(result) {
  for (const finding of result.findings) {
    assert.deepEqual(Object.keys(finding).sort(), ['id', 'ruleId', 'severity', 'file', 'offset', 'fromModule', 'toModule', 'relatedFiles', 'sourceHashes'].sort());
    const { id, ...body } = finding;
    assert.equal(id, hash(body));
    assert.equal(finding.severity, 'error');
    assert.equal(finding.offset, null);
    assert.deepEqual(finding.sourceHashes.map(row => row.file), [...new Set(finding.sourceHashes.map(row => row.file))].sort());
  }
}

test('Null registries are neutral only without public entries', () => {
  const empty = graph({ publicCore: false });
  assert.deepEqual(plan({ base: null, head: null, baseGraph: empty, headGraph: empty, changedPaths: [] }), { schemaVersion: 1, status: 'not_applicable', changes: [], requiredConsumers: [], requiredTests: [], findings: [] });
  assert.equal(plan({ ...input(), base: null, head: null }).status, 'blocked');
  assert.equal(plan({ ...input(), head: null }).status, 'blocked', 'enrolled registry removal is not neutral');
});

test('First enrollment selects actual producer tests without demanding consumer migrations', () => {
  const value = { ...input(), base: null };
  const result = plan(value);
  assert.equal(result.status, 'planned');
  assert.deepEqual(result.changes, [{ contractId: 'core-api', kind: 'added', fromVersion: null, toVersion: 1, consumers: ['app', 'web'] }]);
  assert.deepEqual(result.requiredTests, [{ file: producerTest, forContracts: ['core-api'], forModules: ['core'] }]);
  assert.deepEqual(result.findings, []);
});

test('Unchanged metadata and CSS changes select no unrelated tests', () => {
  const value = input(); value.changedPaths = ['src/core/style.css'];
  assert.deepEqual(plan(value), { schemaVersion: 1, status: 'planned', changes: [], requiredConsumers: [], requiredTests: [], findings: [] });
});

test('Implementation-only producer edits select producer and transitive registered consumer tests without a version bump', () => {
  const value = input(); value.baseGraph = graph({ extraContracts: true }); value.headGraph = graph({ extraContracts: true });
  for (const id of ['app', 'web']) for (const side of ['base', 'head']) value[side].contracts.push(contract({ id: `${id}-api`, module: id, entry: `src/${id}/index.mjs`, tests: [`tests/${id}.test.mjs`] }));
  value.changedPaths = [entry]; value.headGraph.nodes[0].sourceHash = hash('implementation-only');
  const result = plan(value);
  assert.equal(result.status, 'planned'); assert.deepEqual(result.changes, []); assert.deepEqual(result.findings, []);
  assert.deepEqual(result.requiredConsumers, ['app', 'web']);
  assert.deepEqual(result.requiredTests, [
    { file: 'tests/app.test.mjs', forContracts: ['app-api'], forModules: ['app'] },
    { file: producerTest, forContracts: ['core-api'], forModules: ['core'] },
    { file: 'tests/web.test.mjs', forContracts: ['web-api'], forModules: ['web'] }
  ]);
});

test('Export removal with unchanged registry blocks despite unchanged declared shape hash', () => {
  const value = input(); value.headGraph.nodes[0].exports = []; value.changedPaths = [entry];
  const result = plan(value);
  assert.equal(result.status, 'blocked'); assert.ok(rules(result).includes('contract.exports')); assertFindingRecords(result);
  const finding = result.findings.find(row => row.ruleId === 'contract.exports');
  assert.equal(finding.file, entry); assert.deepEqual(finding.sourceHashes, [{ file: entry, sha256: value.headGraph.nodes[0].sourceHash }]);
});

test('Public entries require exactly one contract and exact AST export names', () => {
  for (const mutate of [
    value => { value.head.contracts = []; },
    value => { value.head.contracts.push(contract({ id: 'other-api' })); },
    value => { value.headGraph.modules[0].public = []; value.headGraph.nodes[0].public = false; },
    value => { value.head.contracts[0].exports = ['wrong']; },
    value => { value.headGraph.unsupported = [{ id: hash('unsupported'), scope: 'exports', file: entry, reason: 'export-star', offset: 0 }]; }
  ]) {
    const value = input(); mutate(value);
    assert.ok(rules(plan(value)).includes('contract.exports'));
  }
});

test('Declared shape changes and version rollback cannot pass without migration', () => {
  const value = input(); value.head.contracts[0].shapeHash = hash('changed-declaration');
  let result = plan(value); assert.equal(result.status, 'blocked'); assert.ok(rules(result).includes('contract.version')); assert.ok(rules(result).includes('contract.migration'));
  value.head.contracts[0] = contract(); value.base.contracts[0].version = 2;
  result = plan(value); assert.equal(result.status, 'blocked'); assert.ok(rules(result).includes('contract.version'));
});

test('Complete breaking migration maps transitive consumers and exact frozen required test records', () => {
  const value = breaking(); const result = plan(value);
  assert.equal(result.status, 'planned'); assert.deepEqual(result.findings, []);
  assert.deepEqual(result.changes, [{ contractId: 'core-api', kind: 'breaking', fromVersion: 1, toVersion: 2, consumers: ['app', 'web'] }]);
  assert.deepEqual(result.requiredConsumers, ['app', 'web']);
  assert.deepEqual(result.requiredTests, [
    { file: 'tests/app.test.mjs', forContracts: ['core-api'], forModules: ['app'] },
    { file: producerTest, forContracts: ['core-api'], forModules: ['core'] },
    { file: 'tests/web.test.mjs', forContracts: ['core-api'], forModules: ['web'] }
  ]);
});

test('Missing producer migration, consumer mapping, changed consumer JS or tracked plan blocks', () => {
  for (const [expected, mutate] of [
    ['contract.migration', value => { value.head.migrations = []; }],
    ['contract.tests', value => { value.head.migrations[0].tests.shift(); }],
    ['contract.dependent', value => { value.head.migrations[0].consumers = ['app']; }],
    ['contract.tests', value => { value.head.migrations[0].tests.pop(); }],
    ['contract.dependent', value => { value.changedPaths = [entry, 'src/app/index.mjs', 'src/web/style.css']; }],
    ['contract.migration', value => { value.headGraph.files = value.headGraph.files.filter(row => row.path !== 'docs/migrate.md'); }]
  ]) {
    const value = breaking(); mutate(value); const result = plan(value);
    assert.equal(result.status, 'blocked'); assert.ok(rules(result).includes(expected), `${expected}: ${JSON.stringify(result)}`); assertFindingRecords(result);
  }
});

test('Consumer discovery uses reverse dependency union from both immutable graphs including removed consumers', () => {
  const value = breaking(); value.headGraph.edges = []; value.headGraph.nodes = value.headGraph.nodes.filter(row => row.module !== 'web'); value.headGraph.modules = value.headGraph.modules.filter(row => row.id !== 'web');
  const result = plan(value);
  assert.equal(result.status, 'planned'); assert.deepEqual(result.requiredConsumers, ['app', 'web']);
  value.changedPaths = [entry, 'src/app/index.mjs']; assert.ok(rules(plan(value)).includes('contract.dependent'));
});

test('Consumer path or mode changes without changed source cannot satisfy migration obligations', () => {
  const value = breaking(); value.headGraph.nodes[2].sourceHash = value.baseGraph.nodes[2].sourceHash;
  value.headGraph.files.find(row => row.path === 'src/web/index.mjs').mode = '100755';
  const result = plan(value);
  assert.equal(result.status, 'blocked');
  assert.ok(result.findings.some(row => row.ruleId === 'contract.dependent' && row.toModule === 'web'));
});

test('Changed private producer JS selects its declared tests and exact export string names remain valid', () => {
  const value = input(); const privateFile = 'src/core/private.mjs';
  value.headGraph.nodes.push({ ...value.headGraph.nodes[0], id: `file:${privateFile}`, path: privateFile, exports: [], public: false, sourceHash: hash('private-new') });
  value.headGraph.files.push({ path: privateFile, mode: '100644', oid: 'b'.repeat(40) });
  value.changedPaths = [privateFile];
  const result = plan(value);
  assert.equal(result.status, 'planned'); assert.deepEqual(result.changes, []);
  assert.deepEqual(result.requiredTests, [{ file: producerTest, forContracts: ['core-api'], forModules: ['core'] }]);
  for (const side of ['base', 'head']) value[side].contracts[0].exports = ['', 'default', 'space name'];
  for (const side of ['baseGraph', 'headGraph']) value[side].nodes[0].exports = ['', 'default', 'space name'];
  assert.equal(plan(value).status, 'planned');
});

test('Migration history is append-only, forward and cannot resurrect retired IDs', () => {
  const previous = migration({ fromVersion: 1, toVersion: 2 });
  for (const mutate of [value => { value.head.migrations = []; }, value => { value.head.migrations[0].plan = 'docs/other.md'; }]) {
    const value = input(); value.base.contracts[0].version = 2; value.head.contracts[0].version = 2; value.base.migrations = [previous]; value.head.migrations = [structuredClone(previous)]; mutate(value);
    assert.ok(rules(plan(value)).includes('contract.migration'));
  }
  const value = { ...input(), base: registry([], [migration({ toVersion: null })]), baseGraph: graph({ publicCore: false }) };
  value.head.migrations = structuredClone(value.base.migrations);
  assert.equal(plan(value).status, 'blocked'); assert.ok(rules(plan(value)).includes('contract.version'));
  const backwards = input(); backwards.head.migrations = [migration({ fromVersion: 2, toVersion: 1 })];
  assert.equal(plan(backwards).status, 'blocked');
});

test('Unchanged historical migrations still require complete producer and consumer test mappings', () => {
  for (const tests of [[], [{ module: 'core', files: [producerTest] }], [{ module: 'app', files: ['tests/app.test.mjs'] }, { module: 'web', files: ['tests/web.test.mjs'] }]]) {
    const value = input();
    for (const side of ['base', 'head']) {
      value[side].contracts[0].version = 2;
      value[side].migrations = [migration({ tests })];
    }
    const result = plan(value);
    assert.equal(result.status, 'blocked'); assert.ok(rules(result).includes('contract.tests'));
  }
});

test('Retirement requires existing producer and consumer replacement tests in head', () => {
  const value = breaking(); value.head.contracts = []; value.headGraph.modules[0].public = []; value.headGraph.nodes[0].public = false;
  value.headGraph.files = value.headGraph.files.filter(row => row.path !== producerTest);
  value.head.migrations = [migration({ toVersion: null, tests: [{ module: 'core', files: ['tests/core-replacement.test.mjs'] }, { module: 'app', files: ['tests/app.test.mjs'] }, { module: 'web', files: ['tests/web.test.mjs'] }] })];
  const result = plan(value);
  assert.equal(result.status, 'planned'); assert.deepEqual(result.changes, [{ contractId: 'core-api', kind: 'retired', fromVersion: 1, toVersion: null, consumers: ['app', 'web'] }]);
  assert.ok(result.requiredTests.some(row => row.file === 'tests/core-replacement.test.mjs')); assert.ok(!result.requiredTests.some(row => row.file === producerTest));
  value.headGraph.files = value.headGraph.files.filter(row => row.path !== 'tests/core-replacement.test.mjs');
  assert.ok(rules(plan(value)).includes('contract.tests'));
});

test('Missing, nonregular or wrongly named declared tests block without execution or receipts', () => {
  for (const mutate of [
    value => { value.head.contracts[0].tests = []; },
    value => { value.headGraph.files = value.headGraph.files.filter(row => row.path !== producerTest); },
    value => { value.headGraph.files.find(row => row.path === producerTest).mode = '120000'; },
    value => { value.head.contracts[0].tests = ['docs/migrate.md']; }
  ]) {
    const value = input(); mutate(value); const result = plan(value);
    assert.equal(result.status, 'blocked'); assert.ok(rules(result).includes('contract.tests')); assert.ok(!('receipts' in result));
  }
});

test('Registry rejects unknown fields, unsafe paths, invalid hashes and duplicate set members', () => {
  for (const mutate of [
    value => { value.head.extra = true; },
    value => { value.head.contracts[0].extra = true; },
    value => { value.head.contracts[0].version = 0; },
    value => { value.head.contracts[0].shapeHash = 'declared'; },
    value => { value.head.contracts[0].entry = '../src/index.mjs'; },
    value => { value.head.contracts[0].tests = ['C:/secret.test.mjs']; },
    value => { value.head.contracts[0].tests = [producerTest, producerTest]; },
    value => { value.head.contracts[0].exports = ['z', 'a']; },
    value => { value.head.migrations = [{ ...migration(), extra: true }]; },
    value => { value.head.migrations = [migration({ tests: [{ module: 'app', files: [], extra: true }] })]; }
  ]) {
    const value = input(); mutate(value); assert.throws(() => plan(value), { code: 'configuration' });
  }
  assert.throws(() => plan({ ...input(), untrusted: true }), { code: 'configuration' });
  assert.throws(() => plan({ ...input(), changedPaths: undefined }), { code: 'configuration' });
  const oversized = input(); oversized.head.contracts = Array.from({ length: 257 }, (_, index) => contract({ id: `contract-${index}` }));
  assert.throws(() => plan(oversized), { code: 'scope_limit' });
});

test('Plan is deterministic, immutable and merges shared test attribution without inferred semantic compatibility', () => {
  const value = breaking(); value.head.migrations[0].tests[1].files = [producerTest];
  const before = structuredClone(value); const result = plan(value);
  assert.deepEqual(value, before); assert.deepEqual(plan(value), result); assertFindingRecords(result);
  assert.equal(result.status, 'planned');
  assert.deepEqual(result.requiredTests.find(row => row.file === producerTest), { file: producerTest, forContracts: ['core-api'], forModules: ['app', 'core'] });
});

test('Temporary Git snapshot inventory determines tracked tests without reading or running their source', async t => {
  const project = await mkdtemp(path.join(os.tmpdir(), 'kodo-contract-fixture-'));
  t.after(() => rm(project, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', args, { cwd: project, encoding: 'utf8', windowsHide: true }).trim();
  git('init', '-q'); git('config', 'user.name', 'Fixture'); git('config', 'user.email', 'fixture@example.invalid');
  for (const [file, source] of [[entry, 'export const value = 1;'], [producerTest, 'throw new Error("planner must never execute this test");']]) {
    await mkdir(path.dirname(path.join(project, file)), { recursive: true }); await writeFile(path.join(project, file), source);
  }
  git('add', '-A'); git('commit', '-qm', 'independent contract fixture');
  const value = { ...input(), base: null }; value.headGraph.headSha = git('rev-parse', 'HEAD');
  value.headGraph.files = git('ls-tree', '-r', 'HEAD').split('\n').map(line => { const [, mode, oid, file] = /^(\d+) blob ([a-f0-9]+)\t(.+)$/.exec(line); return { path: file, mode, oid }; });
  assert.equal(plan(value).status, 'planned');
  git('rm', '-q', producerTest); git('commit', '-qm', 'remove registered test');
  value.headGraph.files = value.headGraph.files.filter(row => row.path !== producerTest);
  assert.ok(rules(plan(value)).includes('contract.tests'));
});
