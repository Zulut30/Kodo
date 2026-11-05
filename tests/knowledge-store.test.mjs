import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, realpathSync, existsSync, readdirSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as storage from '../runtime/store.mjs';

// Fixture hashing is independent of Store and uses the frozen public fields.
const canonical = value => JSON.stringify(value, function (_key, item) {
  return item && typeof item === 'object' && !Array.isArray(item)
    ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item;
});
const hash = value => createHash('sha256').update(canonical(value)).digest('hex');
const stamp = '2026-11-04T12:00:00.000Z';
const nativeKey = value => process.platform === 'win32' ? realpathSync.native(value).toLowerCase() : realpathSync.native(value);
function fixture(t, secrets = {}) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'kodo-knowledge-store-'));
  const project = path.join(root, 'Project'); mkdirSync(project);
  const home = path.join(root, 'state');
  const stores = [];
  t.after(() => {
    for (const store of stores.reverse()) store.close();
    assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith('kodo-knowledge-store-'));
    rmSync(root, { recursive: true, force: true });
  });
  const open = () => { const store = new storage.Store(home, secrets); stores.push(store); return store; };
  const reader = () => { const store = storage.openKnowledgeReader(home); stores.push(store); return store; };
  const close = store => { store.close(); stores.splice(stores.indexOf(store), 1); };
  return { root, project, projectKey: nativeKey(project), home, open, reader, close };
}
function claim(projectKey, overrides = {}) {
  const data = {
    domain: 'codebase', subject: 'runtime', key: 'exports', value: ['Store'], versions: { headSha: 'a'.repeat(40) }, synthetic: false,
    source: { id: 'store-source', kind: 'local', url: null, path: 'runtime/store.mjs', pointer: '$exports', retrievedAt: stamp, validAsOf: stamp,
      evidenceRef: { path: '/private/evidence/store.json', bytes: 120, sha256: 'd'.repeat(64) } },
    confidence: null, unknowns: [], ...overrides
  };
  return { id: hash([projectKey, data.domain, data.subject, data.key, data.versions, data.source.id, data.synthetic]), fingerprint: hash(data), ...data };
}
function capture(projectKey, captureId = 'capture-1', claims = [claim(projectKey)], overrides = {}) {
  return { schemaVersion: 1, projectKey, captureId, inputHash: '1'.repeat(64), policyHash: '2'.repeat(64), contextHash: '3'.repeat(64), capturedAt: stamp, claims, ...overrides };
}

test('Knowledge reader leaves an absent home and database absent', t => {
  const f = fixture(t);
  assert.equal(typeof storage.openKnowledgeReader, 'function');
  const reader = f.reader();
  assert.deepEqual(reader.listKnowledgeClaims(f.projectKey), []);
  assert.equal(reader.findKnowledgeCapture(f.projectKey, 'missing'), null);
  assert.equal(reader.appendKnowledgeCapture, undefined);
  assert.equal(existsSync(f.home), false);
  mkdirSync(f.home); const emptyReader = f.reader();
  assert.deepEqual(emptyReader.listKnowledgeClaims(f.projectKey), []);
  assert.deepEqual(readdirSync(f.home), []);
});

test('Knowledge reader does not migrate legacy databases or create sidecars', t => {
  const f = fixture(t); mkdirSync(f.home);
  const file = path.join(f.home, 'state.sqlite'); const db = new DatabaseSync(file);
  db.exec('CREATE TABLE runs(id TEXT PRIMARY KEY, body TEXT NOT NULL, updated INTEGER NOT NULL)'); db.close();
  const before = readFileSync(file), files = readdirSync(f.home);
  const reader = f.reader();
  assert.deepEqual(reader.listKnowledgeClaims(f.projectKey), []);
  assert.equal(reader.findKnowledgeCapture(f.projectKey, 'missing'), null);
  assert.deepEqual(readFileSync(file), before);
  assert.deepEqual(readdirSync(f.home), files);
});

test('Knowledge reader leaves a closed legacy WAL database without new sidecars', t => {
  const f = fixture(t); mkdirSync(f.home);
  const file = path.join(f.home, 'state.sqlite'); const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode=WAL; CREATE TABLE knowledge(run_id TEXT PRIMARY KEY,project TEXT NOT NULL,body TEXT NOT NULL,time INTEGER NOT NULL)'); db.close();
  const before = readFileSync(file), files = readdirSync(f.home);
  const reader = f.reader();
  assert.deepEqual(reader.listKnowledgeClaims(f.projectKey), []);
  assert.equal(reader.findKnowledgeCapture(f.projectKey, 'missing'), null);
  assert.deepEqual(readFileSync(file), before);
  assert.deepEqual(readdirSync(f.home), files);
});

test('Knowledge capture persists exact revisions and replay retains the original observation across reopen', t => {
  const f = fixture(t), store = f.open(), input = capture(f.projectKey);
  const expectedClaim = { ...input.claims[0], schemaVersion: 1, projectKey: f.projectKey, captureId: 'capture-1', revision: 1, observedAt: stamp };
  const expected = { schemaVersion: 1, projectKey: f.projectKey, captureId: 'capture-1', inputHash: input.inputHash, policyHash: input.policyHash,
    contextHash: input.contextHash, capturedAt: stamp, replayed: false, claims: [expectedClaim] };
  assert.deepEqual(store.appendKnowledgeCapture(input), expected);
  f.close(store);
  const reopened = f.open();
  assert.deepEqual(reopened.findKnowledgeCapture(f.projectKey, 'capture-1'), expected);
  const retry = capture(f.projectKey, 'capture-1', input.claims, { capturedAt: '2026-11-05T12:00:00.000Z' });
  assert.deepEqual(reopened.appendKnowledgeCapture(retry), { ...expected, replayed: true });
  const changed = claim(f.projectKey, { value: ['Store', 'openKnowledgeReader'] });
  const second = reopened.appendKnowledgeCapture(capture(f.projectKey, 'capture-2', [changed], { capturedAt: '2026-11-05T12:00:00.000Z' }));
  assert.equal(second.claims[0].revision, 2);
  assert.equal(second.claims[0].observedAt, '2026-11-05T12:00:00.000Z');
  assert.deepEqual(reopened.listKnowledgeClaims(f.projectKey), second.claims);
  assert.deepEqual(reopened.listKnowledgeClaims(f.projectKey, { history: true }).map(row => row.revision), [2, 1]);
  assert.deepEqual(f.reader().findKnowledgeCapture(f.projectKey, 'capture-1'), expected);
  assert.deepEqual(f.reader().listKnowledgeClaims(f.projectKey), second.claims);
  f.close(reopened);
  assert.deepEqual(f.reader().listKnowledgeClaims(f.projectKey), second.claims);
  assert.equal(input.claims[0].revision, undefined);
});

test('Knowledge replay rejects changed capture hashes and preserves the saved receipt', t => {
  const f = fixture(t), store = f.open(), input = capture(f.projectKey), saved = store.appendKnowledgeCapture(input);
  for (const key of ['inputHash', 'policyHash', 'contextHash']) {
    assert.throws(() => store.appendKnowledgeCapture({ ...input, [key]: '9'.repeat(64) }), /replay|capture/i);
    assert.deepEqual(store.findKnowledgeCapture(f.projectKey, input.captureId), saved);
  }
  assert.equal(store.listKnowledgeClaims(f.projectKey, { history: true }).length, 1);
});

test('Knowledge reader observes subsequent committed captures from another connection', t => {
  const f = fixture(t), first = f.open();
  first.appendKnowledgeCapture(capture(f.projectKey)); f.close(first);
  const reader = f.reader();
  assert.equal(reader.listKnowledgeClaims(f.projectKey)[0].revision, 1);
  const writer = f.open();
  const observations = []; let pendingCapture = 'next';
  writer.db.function('observe_knowledge_commit', () => {
    observations.push({ revision: reader.listKnowledgeClaims(f.projectKey)[0].revision, pending: reader.findKnowledgeCapture(f.projectKey, pendingCapture) });
    return 1;
  });
  writer.db.exec('CREATE TRIGGER observe_knowledge_revision AFTER INSERT ON knowledge_claim_revisions BEGIN SELECT observe_knowledge_commit(); END');
  const saved = writer.appendKnowledgeCapture(capture(f.projectKey, 'next', [claim(f.projectKey, { value: ['next'] })]));
  assert.deepEqual(observations, [{ revision: 1, pending: null }], 'a reader cannot observe uncommitted revisions or captures');
  assert.deepEqual(reader.listKnowledgeClaims(f.projectKey), saved.claims);
  assert.deepEqual(reader.findKnowledgeCapture(f.projectKey, 'next'), saved);
  const alreadyOpenReader = f.reader(); pendingCapture = 'later';
  const later = writer.appendKnowledgeCapture(capture(f.projectKey, 'later', [claim(f.projectKey, { value: ['later'] })]));
  assert.deepEqual(observations, [{ revision: 1, pending: null }, { revision: 2, pending: null }]);
  assert.deepEqual(alreadyOpenReader.listKnowledgeClaims(f.projectKey), later.claims);
  assert.deepEqual(reader.listKnowledgeClaims(f.projectKey), later.claims);
  assert.deepEqual(alreadyOpenReader.findKnowledgeCapture(f.projectKey, 'later'), later);
  writer.db.exec('DROP TRIGGER observe_knowledge_revision');
});

test('Knowledge source identifiers are bound to the entire locator within each project', t => {
  const f = fixture(t), store = f.open(), original = claim(f.projectKey);
  store.appendKnowledgeCapture(capture(f.projectKey));
  for (const locator of [{ kind: 'discovery' }, { url: 'https://example.test/docs' }, { path: 'other.mjs' }, { pointer: '/other' }]) {
    const changed = claim(f.projectKey, { source: { ...original.source, ...locator } });
    assert.throws(() => store.appendKnowledgeCapture(capture(f.projectKey, 'changed', [changed])), /source|locator/i);
    assert.equal(store.findKnowledgeCapture(f.projectKey, 'changed'), null);
    assert.throws(() => store.appendKnowledgeCapture(capture(f.projectKey, 'capture-1', [changed])), /source|locator/i);
  }
  const project2 = path.join(f.root, 'Other'); mkdirSync(project2); const key2 = nativeKey(project2);
  const isolated = claim(key2, { source: { ...original.source, path: 'other.mjs' } });
  store.appendKnowledgeCapture(capture(key2, 'capture-1', [isolated]));
  assert.deepEqual(store.listKnowledgeClaims(key2).map(row => row.source.path), ['other.mjs']);
  assert.deepEqual(store.listKnowledgeClaims(f.projectKey).map(row => row.source.path), ['runtime/store.mjs']);
});

test('Knowledge SQL failure rolls back capture, revisions and source bindings together', t => {
  const f = fixture(t), store = f.open();
  store.db.exec(`CREATE TRIGGER fail_knowledge_revision BEFORE INSERT ON knowledge_claim_revisions
    WHEN json_extract(NEW.body, '$.key') = 'rollback' BEGIN SELECT RAISE(ABORT, 'fixture rollback'); END`);
  const first = claim(f.projectKey), second = claim(f.projectKey, { key: 'rollback' });
  assert.throws(() => store.appendKnowledgeCapture(capture(f.projectKey, 'atomic', [first, second])), /fixture rollback/);
  assert.equal(f.reader().findKnowledgeCapture(f.projectKey, 'atomic'), null);
  assert.deepEqual(f.reader().listKnowledgeClaims(f.projectKey, { history: true }), []);
  store.db.exec('DROP TRIGGER fail_knowledge_revision');
  const moved = claim(f.projectKey, { source: { ...first.source, path: 'moved.mjs' } });
  const saved = store.appendKnowledgeCapture(capture(f.projectKey, 'atomic', [moved]));
  assert.equal(saved.claims[0].revision, 1);
  assert.equal(saved.claims[0].source.path, 'moved.mjs');
});

test('Knowledge canonical native identity resolves project aliases without changing legacy project matching', t => {
  const f = fixture(t), alias = path.join(f.root, 'Alias');
  symlinkSync(f.project, alias, process.platform === 'win32' ? 'junction' : 'dir');
  const store = f.open(); store.appendKnowledgeCapture(capture(f.projectKey));
  assert.deepEqual(store.listKnowledgeClaims(alias), store.listKnowledgeClaims(f.project));
  assert.deepEqual(store.findKnowledgeCapture(alias, 'capture-1'), store.findKnowledgeCapture(f.project, 'capture-1'));
  store.createRun({ id: 'legacy', project: alias, task: 'unchanged alias behavior' });
  assert.equal(store.listRuns(f.project).length, 0);
  assert.equal(store.listRuns(alias).length, 1);
  store.remember({ id: 'lesson', project: alias, task: 'legacy lesson' });
  assert.equal(store.lessons(f.project).length, 0);
  assert.equal(store.lessons(alias).length, 1);
});

test('Knowledge listing filters latest revisions exactly and applies bounded limits', t => {
  const f = fixture(t), store = f.open();
  const rows = [claim(f.projectKey), claim(f.projectKey, { domain: 'technical', key: 'api' }), claim(f.projectKey, { subject: 'other', key: 'file' })];
  store.appendKnowledgeCapture(capture(f.projectKey, 'all', rows));
  store.appendKnowledgeCapture(capture(f.projectKey, 'next', [claim(f.projectKey, { value: ['changed'] })]));
  assert.equal(store.listKnowledgeClaims(f.projectKey).length, 3);
  assert.equal(store.listKnowledgeClaims(f.projectKey, { subject: 'runtime', domain: 'codebase' }).length, 1);
  assert.equal(store.listKnowledgeClaims(f.projectKey, { subject: 'run' }).length, 0);
  assert.equal(store.listKnowledgeClaims(f.projectKey, { limit: 1 }).length, 1);
  assert.equal(store.listKnowledgeClaims(f.projectKey, { history: true }).length, 4);
  for (const options of [{ limit: 0 }, { limit: 1001 }, { limit: 1.5 }, { domain: 'other' }, { history: 'yes' }]) {
    assert.throws(() => store.listKnowledgeClaims(f.projectKey, options));
  }
});

test('Knowledge listing defaults to 200 without truncating stored capture receipts or history', t => {
  const f = fixture(t), store = f.open();
  const rows = Array.from({ length: 201 }, (_, index) => claim(f.projectKey, { key: `field-${index}` }));
  const receipt = store.appendKnowledgeCapture(capture(f.projectKey, 'bounded', rows));
  assert.equal(receipt.claims.length, 201);
  assert.equal(store.listKnowledgeClaims(f.projectKey).length, 200);
  assert.equal(f.reader().listKnowledgeClaims(f.projectKey).length, 200);
  assert.equal(store.listKnowledgeClaims(f.projectKey, { history: true, limit: 201 }).length, 201);
  assert.equal(store.findKnowledgeCapture(f.projectKey, 'bounded').claims.length, 201);
});

test('Knowledge preserves imported unknown dates and separates synthetic and versioned claim identities', t => {
  const f = fixture(t), store = f.open(), original = claim(f.projectKey);
  const imported = { domain: 'domain', versions: { patch: 'fixture-A' }, synthetic: true,
    source: { ...original.source, id: 'import', kind: 'discovery', url: 'https://example.test/reference', path: null, pointer: null, retrievedAt: null, validAsOf: null },
    confidence: 0, unknowns: ['Unverified fixture'] };
  const rows = [claim(f.projectKey, imported), claim(f.projectKey, { ...imported, synthetic: false }), claim(f.projectKey, { ...imported, versions: { patch: 'fixture-B' } })];
  const saved = store.appendKnowledgeCapture(capture(f.projectKey, 'imported', rows));
  assert.equal(new Set(saved.claims.map(row => row.id)).size, 3);
  for (const row of saved.claims) {
    assert.equal(row.revision, 1); assert.equal(row.observedAt, stamp);
    assert.equal(row.source.retrievedAt, null); assert.equal(row.source.validAsOf, null);
  }
  assert.deepEqual(saved.claims.map(row => [row.synthetic, row.versions.patch]), [[true, 'fixture-A'], [false, 'fixture-A'], [true, 'fixture-B']]);
});

test('Knowledge rejects secrets before persistence without silently rewriting hashed records', t => {
  const known = 'fake-knowledge-private-value', f = fixture(t, { GEMINI_API_KEY: known }), store = f.open();
  const original = claim(f.projectKey);
  const candidates = [claim(f.projectKey, { value: { nested: [known] } }), claim(f.projectKey, { value: { [known]: 'safe' } }),
    claim(f.projectKey, { unknowns: [known] }), claim(f.projectKey, { value: 'Bearer fixture-secret-token' }),
    claim(f.projectKey, { value: 'sk-proj-' + 'a'.repeat(24) }), claim(f.projectKey, { source: { ...original.source, path: known } })];
  for (const item of candidates) {
    assert.throws(() => store.appendKnowledgeCapture(capture(f.projectKey, 'secret', [item])), /secret|redact/i);
    assert.equal(store.findKnowledgeCapture(f.projectKey, 'secret'), null);
  }
  const safe = capture(f.projectKey, 'safe'); const saved = store.appendKnowledgeCapture(safe);
  assert.equal(saved.claims[0].fingerprint, safe.claims[0].fingerprint);
  assert.deepEqual(saved.claims[0].value, ['Store']);
  assert.deepEqual(store.listKnowledgeClaims(f.projectKey).map(row => row.captureId), ['safe']);
  for (const file of readdirSync(f.home).filter(file => file.startsWith('state.sqlite'))) {
    assert.equal(readFileSync(path.join(f.home, file)).includes(Buffer.from(known)), false);
  }
  const short = fixture(t, { KEY: 'Z9Qx' }), shortStore = short.open();
  assert.throws(() => shortStore.appendKnowledgeCapture(capture(short.projectKey, 'short', [claim(short.projectKey, { value: 'prefix-Z9Qx-suffix' })])), /secret|redact/i);
  assert.equal(shortStore.findKnowledgeCapture(short.projectKey, 'short'), null);
});

test('Knowledge validates frozen schemas, identifiers, hashes and finite bounded JSON before writing', t => {
  const f = fixture(t), store = f.open(), good = capture(f.projectKey);
  let tooDeep = null;
  for (let depth = 0; depth < 13; depth++) tooDeep = [tooDeep];
  const bad = [
    { ...good, extra: true }, { ...good, schemaVersion: 2 }, { ...good, captureId: '../bad' }, { ...good, capturedAt: 'yesterday' },
    { ...good, claims: [{ ...good.claims[0], id: '0'.repeat(64) }] },
    { ...good, claims: [{ ...good.claims[0], value: 'tampered' }] },
    { ...good, claims: [{ ...good.claims[0], extra: true }] },
    { ...good, claims: [claim(f.projectKey, { domain: 'other' })] },
    { ...good, claims: [claim(f.projectKey, { confidence: 1.1 })] },
    { ...good, claims: [claim(f.projectKey, { subject: 's'.repeat(129) })] },
    { ...good, claims: [claim(f.projectKey, { unknowns: Array(33).fill('unknown') })] },
    { ...good, claims: [claim(f.projectKey, { versions: Object.fromEntries(Array.from({ length: 17 }, (_, n) => [`v${n}`, 'x'])) })] },
    { ...good, claims: [claim(f.projectKey, { value: Infinity })] },
    { ...good, claims: [claim(f.projectKey, { value: tooDeep })] },
    { ...good, claims: [claim(f.projectKey, { value: Array(10000).fill('item') })] },
    { ...good, claims: [claim(f.projectKey, { value: 'x'.repeat(262145) })] },
    { ...good, claims: Array(1001).fill(good.claims[0]) },
    { ...good, claims: [good.claims[0], good.claims[0]] }
  ];
  for (const input of bad) { assert.throws(() => store.appendKnowledgeCapture(input)); assert.equal(store.findKnowledgeCapture(f.projectKey, 'capture-1'), null); }
  const crossProject = claim(f.projectKey + '-different');
  assert.throws(() => store.appendKnowledgeCapture({ ...good, claims: [crossProject] }));
  assert.deepEqual(store.listKnowledgeClaims(f.projectKey), []);
});
