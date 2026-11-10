import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm, realpath, link, symlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { loadKnowledgeContext, refreshKnowledge, checkKnowledgeEvidence } from '../runtime/knowledge-refresh.mjs';

test('Numeric version keys share lexical canonical context identity with claims evaluation and capture replay', async t => {
  const numeric = { 2: 'B', 10: 'A' };
  const fx = await fixture(t, {
    context: { schemaVersion: 1, versions: numeric, synthetic: false },
    capture: input({ versions: numeric }),
  });
  const { evaluateClaims, normalizeClaim, sanitizeKnowledgeUrl } = await import('../runtime/knowledge-claims.mjs');
  const loaded = await loadKnowledgeContext(fx.options, { secrets: {} });
  const expected =
    '{"headSha":' +
    JSON.stringify(fx.head) +
    ',"projectKey":' +
    JSON.stringify(loaded.context.projectKey) +
    ',"synthetic":false,"versions":{"10":"A","2":"B"}}';
  assert.equal(loaded.context.contextHash, sha(expected));
  assert.deepEqual(
    evaluateClaims({ claims: [], ...loaded, now, evidenceChecks: { schemaVersion: 1, items: [] } }).rows,
    [],
  );
  const ports = { ...fx.ports, claims: { normalizeClaim, sanitizeKnowledgeUrl }, secrets: {} };
  const saved = await refreshKnowledge(fx.options, ports);
  assert.equal(saved.status, 'refreshed', JSON.stringify(saved));
  const checks = await checkKnowledgeEvidence(
    { project: fx.project, evidenceRoot: path.join(fx.home, 'knowledge-evidence'), claims: saved.capture.claims },
    ports,
  );
  const evaluated = evaluateClaims({ claims: saved.capture.claims, ...loaded, now, evidenceChecks: checks });
  assert.equal(evaluated.rows[0].state, 'fresh');
  assert.equal((await refreshKnowledge(fx.options, ports)).status, 'replayed');
});

const now = '2026-11-05T12:00:00.000Z';
const canonical = value =>
  JSON.stringify(value, (_, item) =>
    item && typeof item === 'object' && !Array.isArray(item)
      ? Object.fromEntries(
          Object.keys(item)
            .sort()
            .map(key => [key, item[key]]),
        )
      : item,
  );
const sha = text => createHash('sha256').update(text).digest('hex');
const hash = value => sha(canonical(value));
const git = (cwd, ...args) =>
  execFileSync('git', ['-c', 'core.autocrlf=false', ...args], { cwd, encoding: 'utf8', windowsHide: true }).trim();
const policy = overrides => ({
  schemaVersion: 1,
  mode: 'local-only',
  sourcePaths: ['src'],
  allowedOrigins: [],
  maxRequests: 0,
  ttlSeconds: { domain: 86400, product: 86400, technical: 604800, codebase: 3600 },
  maxClaims: 200,
  maxEvidenceBytes: 1048576,
  maxContextBytes: 2048,
  ...overrides,
});
const input = overrides => ({
  schemaVersion: 1,
  captureId: 'capture-1',
  synthetic: false,
  claims: [
    {
      domain: 'codebase',
      subject: 'app',
      key: 'version',
      value: '1.0',
      versions: {},
      source: {
        id: 'package-version',
        kind: 'local',
        url: null,
        path: 'src/data.json',
        pointer: '/version',
        retrievedAt: null,
        validAsOf: null,
      },
      confidence: null,
      unknowns: [],
      ...overrides,
    },
  ],
});
async function put(root, name, value) {
  await mkdir(path.dirname(path.join(root, name)), { recursive: true });
  await writeFile(path.join(root, name), typeof value === 'string' ? value : JSON.stringify(value));
}
async function fixture(
  t,
  {
    capture = input(),
    rules = policy(),
    context = { schemaVersion: 1, versions: { patch: 'current' }, synthetic: false },
    files = {},
    objectFormat = 'sha1',
  } = {},
) {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'kodo-capture-'));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const root = await realpath(temporary),
    project = path.join(root, 'project'),
    home = path.join(root, 'private');
  await mkdir(project);
  await mkdir(home);
  git(project, 'init', '-q', '--object-format=' + objectFormat);
  git(project, 'config', 'user.name', 'Fixture');
  git(project, 'config', 'user.email', 'fixture@example.invalid');
  for (const [name, value] of Object.entries({
    'src/data.json': { version: '1.0', 'a/b': { '~key': [7, 8] } },
    'research.policy.json': rules,
    'input.json': capture,
    ...(context === null ? {} : { 'research.context.json': context }),
    ...files,
  }))
    await put(project, name, value);
  const commit = () => {
    git(project, 'add', '-A');
    git(project, 'commit', '-qm', 'fixture');
    return git(project, 'rev-parse', 'HEAD');
  };
  const head = commit(),
    receipts = new Map(),
    calls = { writes: 0, appends: 0, finds: 0 };
  const store = {
    home,
    findKnowledgeCapture(projectKey, captureId) {
      calls.finds++;
      return receipts.get(`${projectKey}:${captureId}`) || null;
    },
    appendKnowledgeCapture(capture) {
      calls.appends++;
      const key = `${capture.projectKey}:${capture.captureId}`,
        previous = receipts.get(key);
      if (previous) {
        for (const field of ['inputHash', 'policyHash', 'contextHash']) assert.equal(capture[field], previous[field]);
        return { ...previous, replayed: true };
      }
      const result = {
        schemaVersion: 1,
        ...capture,
        replayed: false,
        claims: capture.claims.map(claim => ({
          ...claim,
          schemaVersion: 1,
          projectKey: capture.projectKey,
          captureId: capture.captureId,
          revision: 1,
          observedAt: capture.capturedAt,
        })),
      };
      receipts.set(key, result);
      return result;
    },
  };
  const claims = {
    normalizeClaim({ projectKey, ...value }) {
      const id = hash([
        projectKey,
        value.domain,
        value.subject,
        value.key,
        value.versions,
        value.source.id,
        value.synthetic,
      ]);
      return { ...value, id, fingerprint: hash(value) };
    },
    sanitizeKnowledgeUrl(value) {
      assert.equal(value, null);
      return { url: null, unknowns: [] };
    },
  };
  const writeEvidence = async (run, kind, value, { headSha }) => {
    calls.writes++;
    const text = JSON.stringify({ schemaVersion: 1, kind, baseSha: run.baseSha || null, headSha, value }),
      sha256 = sha(text);
    const filename = path.join(run.artifacts, 'evidence', `${kind}-${sha256}.json`);
    await mkdir(path.dirname(filename), { recursive: true });
    await writeFile(filename, text, { flag: 'wx', mode: 0o600 });
    return { path: filename, bytes: Buffer.byteLength(text), sha256, headSha };
  };
  const assertEvidence = async ref => {
    const text = await readFile(ref.path, 'utf8');
    assert.equal(sha(text), ref.sha256);
    assert.equal(JSON.parse(text).headSha, ref.headSha);
  };
  const ports = { claims, store, writeEvidence, assertEvidence, now: () => now };
  return { project, home, root, head, commit, calls, ports, options: { project, inputPath: 'input.json', now } };
}
function blocked(result, code) {
  assert.equal(result.status, 'blocked');
  assert.equal(result.requests, 0);
  assert.equal(result.capture, null);
  assert.ok(
    result.errors.some(item => item.code === code),
    JSON.stringify(result.errors),
  );
}

test('Missing and off policy avoid Git Store clock and input reads', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'kodo-off-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const ports = new Proxy(
    {},
    {
      get() {
        throw new Error('disabled path touched a port');
      },
    },
  );
  const loaded = await loadKnowledgeContext({ project: root }, ports);
  assert.equal(loaded.policy.mode, 'off');
  assert.equal(loaded.context, null);
  const result = await refreshKnowledge({ project: root, inputPath: '../../credentials.json' }, ports);
  assert.deepEqual(result, { schemaVersion: 1, status: 'disabled', requests: 0, capture: null, errors: [] });
});
test('Current missing context never borrows captured patch expectations', async t => {
  const fx = await fixture(t, { context: null });
  const { context } = await loadKnowledgeContext(fx.options);
  assert.deepEqual(context.versions, {});
  assert.equal(context.contextSource, 'absent');
  assert.equal(context.headSha, fx.head);
});
test('Malformed current metadata and forbidden HEAD never fall back', async t => {
  for (const context of [
    '{bad',
    { schemaVersion: 1, versions: { headSha: 'invented' }, synthetic: false },
    { schemaVersion: 1, versions: {}, synthetic: false, projectKey: 'other' },
  ]) {
    const fx = await fixture(t, { context });
    await assert.rejects(loadKnowledgeContext(fx.options));
  }
});
test('Capture observes JSON pointer owned value and stamps only codebase dates', async t => {
  const fx = await fixture(t),
    result = await refreshKnowledge(fx.options, fx.ports);
  assert.equal(result.status, 'refreshed');
  assert.equal(result.requests, 0);
  assert.deepEqual(result.errors, []);
  const claim = result.capture.claims[0];
  assert.equal(claim.value, '1.0');
  assert.equal(claim.versions.headSha, fx.head);
  assert.equal(claim.source.retrievedAt, now);
  assert.equal(claim.source.validAsOf, now);
  assert.equal(claim.observedAt, now);
  assert.equal(claim.synthetic, false);
  assert.equal(claim.projectKey, process.platform === 'win32' ? fx.project.toLowerCase() : fx.project);
  assert.deepEqual(Object.keys(claim.source.evidenceRef).sort(), ['bytes', 'path', 'sha256']);
  assert.ok(!claim.source.evidenceRef.path.startsWith(fx.project + path.sep));
});
test('Pointer escaping array selection and file SHA are mechanical observations', async t => {
  for (const [pointer, value] of [
    ['/a~1b/~0key/1', 8],
    ['$sha256', sha(JSON.stringify({ version: '1.0', 'a/b': { '~key': [7, 8] } }))],
  ]) {
    const capture = input({ value });
    capture.claims[0].source.pointer = pointer;
    const fx = await fixture(t, { capture });
    assert.equal((await refreshKnowledge(fx.options, fx.ports)).status, 'refreshed');
  }
});
test('Source mismatch and absent pointer reject without evidence or append', async t => {
  for (const [pointer, value] of [
    ['/version', 'wrong'],
    ['/absent', null],
    ['/a~2b', null],
    ['/a~1b/~0key/01', 8],
  ]) {
    const capture = input({ value });
    capture.claims[0].source.pointer = pointer;
    const fx = await fixture(t, { capture });
    blocked(await refreshKnowledge(fx.options, fx.ports), 'knowledge_selector');
    assert.equal(fx.calls.writes, 0);
    assert.equal(fx.calls.appends, 0);
  }
});
test('Local noncodebase dates and discovery dates remain unverified input dates', async t => {
  for (const kind of ['local', 'discovery']) {
    const capture = input({ domain: 'product', versions: { patch: 'old' } });
    capture.claims[0].source.kind = kind;
    capture.claims[0].source.retrievedAt = '2025-01-01T00:00:00.000Z';
    if (kind === 'discovery') {
      capture.claims[0].source.path = null;
      capture.claims[0].source.pointer = null;
    }
    const fx = await fixture(t, { capture }),
      result = await refreshKnowledge(fx.options, fx.ports);
    assert.equal(result.status, 'refreshed');
    const claim = result.capture.claims[0];
    assert.deepEqual(claim.versions, { patch: 'old' });
    assert.equal(claim.source.retrievedAt, '2025-01-01T00:00:00.000Z');
    assert.equal(claim.source.validAsOf, null);
  }
});
test('Replaying capture preserves original observation TTL and creates no new evidence', async t => {
  const fx = await fixture(t),
    first = await refreshKnowledge(fx.options, fx.ports);
  assert.equal(first.status, 'refreshed');
  const writes = fx.calls.writes;
  const second = await refreshKnowledge({ ...fx.options, now: '2026-11-06T12:00:00.000Z' }, fx.ports);
  assert.equal(second.status, 'replayed');
  assert.equal(second.capture.capturedAt, now);
  assert.equal(second.capture.claims[0].source.retrievedAt, now);
  assert.equal(fx.calls.writes, writes);
  await put(fx.project, 'input.json', input({ value: 'changed' }));
  fx.commit();
  blocked(await refreshKnowledge(fx.options, fx.ports), 'knowledge_replay');
});
test('Tampered immutable evidence and changed current source fail fresh evidence checks', async t => {
  const fx = await fixture(t),
    result = await refreshKnowledge(fx.options, fx.ports);
  assert.equal(result.status, 'refreshed');
  const claims = result.capture.claims,
    evidenceRoot = path.join(fx.home, 'knowledge-evidence');
  const args = { project: fx.project, evidenceRoot, claims };
  let checks = await checkKnowledgeEvidence(args, fx.ports);
  assert.equal(checks.items[0].intact, true);
  assert.equal(checks.items[0].sourceMatches, true);
  assert.equal(checks.items[0].evidenceHash, claims[0].source.evidenceRef.sha256);
  const file = claims[0].source.evidenceRef.path,
    original = await readFile(file);
  await writeFile(file, '{}');
  checks = await checkKnowledgeEvidence(args, fx.ports);
  assert.equal(checks.items[0].intact, false);
  await writeFile(file, original);
  await put(fx.project, 'src/data.json', { version: '2.0' });
  checks = await checkKnowledgeEvidence(args, fx.ports);
  assert.equal(checks.items[0].sourceMatches, false);
});
test('Capture HEAD checker retains noncodebase evidence after an unrelated commit and keeps codebase invalidation', async t => {
  const capture = input();
  capture.synthetic = true;
  capture.claims = ['domain', 'product', 'technical', 'codebase'].map(domain => {
    const row = input({ domain }).claims[0];
    row.source.id = domain;
    row.source.retrievedAt = now;
    row.source.validAsOf = now;
    return row;
  });
  const fx = await fixture(t, { capture, context: { schemaVersion: 1, versions: {}, synthetic: true } });
  const saved = await refreshKnowledge(fx.options, fx.ports);
  assert.equal(saved.status, 'refreshed');
  const before = structuredClone(saved.capture),
    verified = [];
  await put(fx.project, 'unrelated.json', { note: 'new HEAD, same source' });
  const currentHead = fx.commit();
  assert.notEqual(currentHead, fx.head);
  const checks = await checkKnowledgeEvidence(
    { project: fx.project, evidenceRoot: path.join(fx.home, 'knowledge-evidence'), claims: saved.capture.claims },
    { ...fx.ports, onVerifiedReference: row => verified.push(row) },
  );
  assert.deepEqual(Object.keys(checks).sort(), ['items', 'schemaVersion']);
  for (const item of checks.items)
    assert.deepEqual(Object.keys(item).sort(), ['evidenceHash', 'id', 'intact', 'revision', 'sourceMatches']);
  assert.deepEqual(
    checks.items.map(item => item.sourceMatches),
    [true, true, true, false],
  );
  assert.deepEqual(
    verified,
    saved.capture.claims.slice(0, 3).map(claim => ({
      id: claim.id,
      revision: claim.revision,
      reference: { ...claim.source.evidenceRef, headSha: fx.head },
    })),
  );
  assert.deepEqual(saved.capture, before, 'verification never rewrites capture hashes, history or dates');
  await put(fx.project, 'src/data.json', { version: 'changed' });
  fx.commit();
  verified.length = 0;
  const changed = await checkKnowledgeEvidence(
    { project: fx.project, evidenceRoot: path.join(fx.home, 'knowledge-evidence'), claims: saved.capture.claims },
    { ...fx.ports, onVerifiedReference: row => verified.push(row) },
  );
  assert.ok(changed.items.every(item => !item.sourceMatches));
  assert.deepEqual(verified, []);
});

test('Capture HEAD SHA256 repositories retain the verified 64 character capture head', async t => {
  const fx = await fixture(t, { capture: input({ domain: 'product' }), objectFormat: 'sha256' });
  assert.equal(fx.head.length, 64);
  const saved = await refreshKnowledge(fx.options, fx.ports);
  assert.equal(saved.status, 'refreshed');
  await put(fx.project, 'unrelated.json', { note: 'new SHA256 head' });
  assert.notEqual(fx.commit(), fx.head);
  const verified = [],
    checks = await checkKnowledgeEvidence(
      { project: fx.project, evidenceRoot: path.join(fx.home, 'knowledge-evidence'), claims: saved.capture.claims },
      { ...fx.ports, onVerifiedReference: row => verified.push(row) },
    );
  assert.equal(checks.items[0].intact, true);
  assert.equal(checks.items[0].sourceMatches, true);
  assert.deepEqual(verified, [
    {
      id: saved.capture.claims[0].id,
      revision: 1,
      reference: { ...saved.capture.claims[0].source.evidenceRef, headSha: fx.head },
    },
  ]);
});

test('Capture HEAD metadata is withheld for malformed heads inconsistent base tamper and final HEAD fence', async t => {
  const capture = input({ domain: 'product' });
  const fx = await fixture(t, { capture }),
    saved = await refreshKnowledge(fx.options, fx.ports);
  assert.equal(saved.status, 'refreshed');
  const claim = saved.capture.claims[0],
    original = JSON.parse(await readFile(claim.source.evidenceRef.path, 'utf8'));
  for (const envelope of [
    { ...original, headSha: null, baseSha: null },
    { ...original, headSha: 'invented', baseSha: 'invented' },
    { ...original, headSha: 'a'.repeat(39), baseSha: 'a'.repeat(39) },
    { ...original, headSha: 'a'.repeat(65), baseSha: 'a'.repeat(65) },
    { ...original, baseSha: 'b'.repeat(40) },
  ]) {
    const text = JSON.stringify(envelope),
      sha256 = sha(text),
      filename = path.join(path.dirname(claim.source.evidenceRef.path), `knowledge-${sha256}.json`);
    await writeFile(filename, text);
    const changed = structuredClone(claim);
    changed.source.evidenceRef = { path: filename, bytes: Buffer.byteLength(text), sha256 };
    const verified = [],
      checks = await checkKnowledgeEvidence(
        { project: fx.project, evidenceRoot: path.join(fx.home, 'knowledge-evidence'), claims: [changed] },
        { ...fx.ports, onVerifiedReference: row => verified.push(row) },
      );
    assert.equal(checks.items[0].intact, false);
    assert.deepEqual(verified, []);
  }
  await writeFile(claim.source.evidenceRef.path, '{}');
  const verified = [],
    checks = await checkKnowledgeEvidence(
      { project: fx.project, evidenceRoot: path.join(fx.home, 'knowledge-evidence'), claims: [claim] },
      { ...fx.ports, onVerifiedReference: row => verified.push(row) },
    );
  assert.equal(checks.items[0].intact, false);
  assert.deepEqual(verified, []);
  await writeFile(claim.source.evidenceRef.path, JSON.stringify(original));
  const fenced = await checkKnowledgeEvidence(
    { project: fx.project, evidenceRoot: path.join(fx.home, 'knowledge-evidence'), claims: [claim] },
    {
      ...fx.ports,
      onVerifiedReference: row => verified.push(row),
      assertEvidence: async reference => {
        await fx.ports.assertEvidence(reference);
        await put(fx.project, 'unrelated.json', { note: 'HEAD changes during verification' });
        fx.commit();
      },
    },
  );
  assert.equal(fenced.items[0].intact, true);
  assert.equal(fenced.items[0].sourceMatches, false);
  assert.deepEqual(verified, [], 'metadata cannot escape the final clean HEAD fence');
});

test('Traversal secret filenames links hardlinks and unallowlisted sources are refused', async t => {
  for (const name of [
    '../outside.json',
    'src/../data.json',
    'src/.env',
    'src/credentials.json',
    'src/.git/config',
    'other/data.json',
    'src/data.json:stream',
  ]) {
    const capture = input();
    capture.claims[0].source.path = name;
    const fx = await fixture(t, { capture }),
      result = await refreshKnowledge(fx.options, fx.ports);
    assert.equal(result.status, 'blocked');
    assert.equal(fx.calls.writes, 0);
  }
  const fx = await fixture(t);
  await link(path.join(fx.project, 'src/data.json'), path.join(fx.root, 'hard.json'));
  blocked(await refreshKnowledge(fx.options, fx.ports), 'knowledge_path');
});
test('Known secret values and provider shaped secrets never reach evidence or hashes', async t => {
  for (const value of ['fixture-sensitive-value', 'sk-' + 'x'.repeat(28)]) {
    const fx = await fixture(t, { capture: input({ value }), files: { 'src/data.json': { version: value } } });
    fx.ports.secrets = { fixture: 'fixture-sensitive-value' };
    const result = await refreshKnowledge(fx.options, fx.ports);
    blocked(result, 'knowledge_secret');
    assert.ok(!JSON.stringify(result).includes(value));
    assert.equal(fx.calls.writes, 0);
    assert.equal(fx.calls.appends, 0);
  }
});
function escapedValue(secret, location) {
  return {
    nested: [location === 'key' ? { ['field:' + secret]: 'neutral' } : { field: 'before ' + secret + ' after' }],
  };
}

test('Short escaped known strings in nested keys and values block before normalization or writer calls', async t => {
  for (const secret of ['q"9', 'q\\9', '\t'])
    for (const location of ['key', 'value']) {
      await t.test(JSON.stringify({ secret, location }), async t => {
        const value = escapedValue(secret, location);
        const fx = await fixture(t, { capture: input({ value }), files: { 'src/data.json': { version: value } } });
        let normalizations = 0;
        const claims = Object.fromEntries(
          Object.entries(fx.ports.claims).map(([name, method]) => [
            name,
            (...args) => {
              normalizations++;
              return method(...args);
            },
          ]),
        );
        const result = await refreshKnowledge(fx.options, {
          ...fx.ports,
          claims,
          secrets: { fake: secret, empty: '' },
        });
        assert.deepEqual(fx.calls, { writes: 0, appends: 0, finds: 0 });
        assert.equal(normalizations, 0);
        blocked(result, 'knowledge_secret');
      });
    }
});

test('Short escaped known strings leave no evidence or capture with the default Engine writer and SQLite Store', async t => {
  const { Store } = await import('../runtime/store.mjs');
  for (const secret of ['q"9', 'q\\9', '\t'])
    for (const location of ['key', 'value']) {
      await t.test(JSON.stringify({ secret, location }), async t => {
        const value = escapedValue(secret, location),
          secrets = { fake: secret, empty: '' };
        const fx = await fixture(t, { capture: input({ value }), files: { 'src/data.json': { version: value } } });
        const store = new Store(fx.home, secrets);
        try {
          const result = await refreshKnowledge(fx.options, { store, secrets });
          assert.equal(store.findKnowledgeCapture(fx.project, 'capture-1'), null);
          assert.deepEqual(store.listKnowledgeClaims(fx.project, { history: true }), []);
          const files = await readdir(path.join(fx.home, 'knowledge-evidence'), { recursive: true }).catch(error => {
            if (error.code === 'ENOENT') return [];
            throw error;
          });
          assert.deepEqual(files, []);
          blocked(result, 'knowledge_secret');
        } finally {
          store.close();
        }
      });
    }
});

test('Short escaped known metadata keys block before context hashing', async t => {
  const secret = 'q"9';
  const fx = await fixture(t, { context: { schemaVersion: 1, versions: { [secret]: 'current' }, synthetic: false } });
  await assert.rejects(
    loadKnowledgeContext(fx.options, { secrets: { fake: secret } }),
    error => error.knowledgeCode === 'knowledge_secret',
  );
});

test('Neutral escaped keys and values capture and replay unchanged with empty credentials and the default writer', async t => {
  const { Store } = await import('../runtime/store.mjs');
  const value = { nested: [{ 'field:q"9': 'q\\9', tab: '\t' }] },
    secrets = { empty: '' };
  const fx = await fixture(t, { capture: input({ value }), files: { 'src/data.json': { version: value } } });
  const store = new Store(fx.home, secrets),
    ports = { store, secrets };
  try {
    const first = await refreshKnowledge(fx.options, ports);
    assert.equal(first.status, 'refreshed', JSON.stringify(first));
    assert.deepEqual(first.capture.claims[0].value, value);
    const ref = first.capture.claims[0].source.evidenceRef,
      bytes = await readFile(ref.path);
    assert.equal(sha(bytes), ref.sha256);
    assert.deepEqual(JSON.parse(bytes).value.value, value);
    const second = await refreshKnowledge({ ...fx.options, now: '2026-11-06T12:00:00.000Z' }, ports);
    assert.equal(second.status, 'replayed', JSON.stringify(second));
    assert.equal(second.capture.capturedAt, now);
    assert.deepEqual(second.capture.claims, first.capture.claims);
    assert.deepEqual(await readFile(ref.path), bytes);
    assert.equal(store.listKnowledgeClaims(fx.project, { history: true }).length, 1);
    assert.equal((await readdir(path.dirname(ref.path))).length, 1);
  } finally {
    store.close();
  }
});

test('Policy caps apply before source or evidence persistence', async t => {
  const fx = await fixture(t, { rules: policy({ maxEvidenceBytes: 200 }) });
  blocked(await refreshKnowledge(fx.options, fx.ports), 'knowledge_limit');
  assert.equal(fx.calls.writes, 0);
});
test('Capture HEAD expectation cannot be rewritten and HEAD changes during writing block append', async t => {
  const fx = await fixture(t, { capture: input({ versions: { headSha: '0'.repeat(40) } }) });
  blocked(await refreshKnowledge(fx.options, fx.ports), 'knowledge_head');
  assert.equal(fx.calls.writes, 0);
  const moving = await fixture(t),
    writer = moving.ports.writeEvidence;
  moving.ports.writeEvidence = async (...args) => {
    const ref = await writer(...args);
    await put(moving.project, 'new.json', {});
    moving.commit();
    return ref;
  };
  blocked(await refreshKnowledge(moving.options, moving.ports), 'knowledge_head');
  assert.equal(moving.calls.appends, 0);
});
test('Canonical original metadata and actual owned worktree HEAD remain separate', async t => {
  const fx = await fixture(t),
    snapshotCwd = path.join(fx.root, 'snapshot');
  git(fx.project, 'worktree', 'add', '--detach', '-q', snapshotCwd, fx.head);
  await put(snapshotCwd, 'research.context.json', {
    schemaVersion: 1,
    versions: { patch: 'snapshot-must-not-win' },
    synthetic: true,
  });
  git(snapshotCwd, 'add', '-A');
  git(snapshotCwd, 'commit', '-qm', 'snapshot');
  const actual = git(snapshotCwd, 'rev-parse', 'HEAD');
  const loaded = await loadKnowledgeContext({ ...fx.options, snapshotCwd });
  assert.deepEqual(loaded.context.versions, { patch: 'current' });
  assert.equal(loaded.context.synthetic, false);
  assert.equal(loaded.context.headSha, actual);
  assert.equal(loaded.context.projectKey, process.platform === 'win32' ? fx.project.toLowerCase() : fx.project);
});
test('Existing ESM parser observes exports without executing source and blocks unsupported syntax', async t => {
  for (const [source, allowed] of [
    ['throw new Error("never run"); export const z = 1; export default 0;', true],
    ['export * from "./elsewhere.mjs";', false],
  ]) {
    const capture = input({ value: ['default', 'z'] });
    Object.assign(capture.claims[0].source, { path: 'src/module.mjs', pointer: '$exports' });
    const fx = await fixture(t, { capture, files: { 'src/module.mjs': source } }),
      result = await refreshKnowledge(fx.options, fx.ports);
    if (allowed) assert.equal(result.status, 'refreshed');
    else blocked(result, 'knowledge_selector');
  }
});

test('Index concealment cannot label changed source bytes as the current HEAD', async t => {
  const fx = await fixture(t, { capture: input({ value: '2.0' }) });
  git(fx.project, 'update-index', '--assume-unchanged', 'src/data.json');
  await put(fx.project, 'src/data.json', { version: '2.0' });
  assert.equal(git(fx.project, 'status', '--porcelain'), '');
  blocked(await refreshKnowledge(fx.options, fx.ports), 'knowledge_snapshot');
  assert.equal(fx.calls.writes, 0);
  assert.equal(fx.calls.appends, 0);
});
test('Canonical metadata must be committed even when the owned snapshot stays clean', async t => {
  const fx = await fixture(t),
    snapshotCwd = path.join(fx.root, 'snapshot');
  git(fx.project, 'worktree', 'add', '--detach', '-q', snapshotCwd, fx.head);
  await put(fx.project, 'research.context.json', {
    schemaVersion: 1,
    versions: { patch: 'uncommitted' },
    synthetic: false,
  });
  await assert.rejects(loadKnowledgeContext({ ...fx.options, snapshotCwd }));
});
test('Context overrides stay command-local and linked metadata is refused', async t => {
  const fx = await fixture(t, {
    files: { 'meta/override.json': { schemaVersion: 1, versions: { patch: 'fixture' }, synthetic: true } },
  });
  const loaded = await loadKnowledgeContext({ ...fx.options, contextPath: 'meta/override.json' });
  assert.deepEqual(loaded.context.versions, { patch: 'fixture' });
  assert.equal(loaded.context.contextSource, 'override');
  assert.deepEqual((await loadKnowledgeContext(fx.options)).context.versions, { patch: 'current' });
  await mkdir(path.join(fx.root, 'outside'));
  await put(fx.root, 'outside/override.json', { schemaVersion: 1, versions: {}, synthetic: false });
  await rm(path.join(fx.project, 'meta'), { recursive: true });
  await symlink(
    path.join(fx.root, 'outside'),
    path.join(fx.project, 'meta'),
    process.platform === 'win32' ? 'junction' : 'dir',
  );
  await assert.rejects(loadKnowledgeContext({ ...fx.options, contextPath: 'meta/override.json' }));
});
test('Writer envelopes are independently bound to value source project HEAD and byte count', async t => {
  for (const field of ['value', 'project', 'head', 'bytes']) {
    const fx = await fixture(t),
      writer = fx.ports.writeEvidence;
    fx.ports.writeEvidence = async (run, kind, value, options) => {
      const altered = structuredClone(value);
      if (field === 'value') altered.value = 'wrong';
      if (field === 'project') altered.projectKey = 'other';
      const reference = await writer(run, kind, altered, field === 'head' ? { headSha: '0'.repeat(40) } : options);
      if (field === 'bytes') reference.bytes++;
      return reference;
    };
    blocked(await refreshKnowledge(fx.options, fx.ports), 'knowledge_evidence');
    assert.equal(fx.calls.appends, 0);
  }
});

test('Capture IDs retain strict string type rather than regular expression coercion', async t => {
  const capture = input();
  capture.captureId = 123;
  const fx = await fixture(t, { capture });
  blocked(await refreshKnowledge(fx.options, fx.ports), 'knowledge_input');
  assert.equal(fx.calls.writes, 0);
});
test('Local capture and verification never call fetch and honor the explicit observation clock', async t => {
  const fx = await fixture(t, { capture: { ...input(), synthetic: true } }),
    original = globalThis.fetch;
  let requests = 0;
  globalThis.fetch = () => {
    requests++;
    throw new Error('network forbidden');
  };
  t.after(() => {
    globalThis.fetch = original;
  });
  fx.ports.now = () => '2025-01-01T00:00:00.000Z';
  const result = await refreshKnowledge(fx.options, fx.ports);
  assert.equal(result.status, 'refreshed');
  assert.equal(result.capture.capturedAt, now);
  assert.equal(result.capture.claims[0].synthetic, true);
  const checks = await checkKnowledgeEvidence(
    { project: fx.project, evidenceRoot: path.join(fx.home, 'knowledge-evidence'), claims: result.capture.claims },
    fx.ports,
  );
  assert.equal(checks.items[0].sourceMatches, true);
  assert.equal(requests, 0);
});
