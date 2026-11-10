import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  validateResearchPolicy,
  normalizeClaim,
  evaluateClaims,
  sanitizeKnowledgeUrl,
} from '../runtime/knowledge-claims.mjs';

const projectKey = 'c:/projects/fixture';
const headSha = 'a'.repeat(40);
const now = '2026-11-05T12:00:00.000Z';
const canonical = value =>
  Array.isArray(value)
    ? value.map(canonical)
    : value && typeof value === 'object'
      ? Object.fromEntries(
          Object.keys(value)
            .sort()
            .map(key => [key, canonical(value[key])]),
        )
      : value;
const hash = value =>
  createHash('sha256')
    .update(JSON.stringify(canonical(value)))
    .digest('hex');
const defaults = {
  schemaVersion: 1,
  mode: 'off',
  sourcePaths: [],
  allowedOrigins: [],
  maxRequests: 0,
  ttlSeconds: { domain: 86400, product: 86400, technical: 604800, codebase: 3600 },
  maxClaims: 200,
  maxEvidenceBytes: 1048576,
  maxContextBytes: 2048,
};
const policy = (overrides = {}) => ({ ...structuredClone(defaults), mode: 'local-only', ...overrides });
const context = (overrides = {}) => {
  const result = {
    schemaVersion: 1,
    projectKey,
    versions: { patch: 'fixture-A', format: 'Standard' },
    synthetic: false,
    headSha,
    contextSource: 'fixed',
    ...overrides,
  };
  result.contextHash = hash({
    projectKey: result.projectKey,
    versions: result.versions,
    synthetic: result.synthetic,
    headSha: result.headSha,
  });
  return result;
};
function candidate(overrides = {}) {
  return {
    domain: 'codebase',
    subject: 'fixture-package',
    key: 'version',
    value: '1.0.0',
    versions: { headSha },
    synthetic: false,
    source: {
      id: 'manifest',
      kind: 'local',
      url: null,
      path: 'package.json',
      pointer: '/version',
      retrievedAt: now,
      validAsOf: now,
      evidenceRef: { path: 'C:/private/evidence/fixture.json', bytes: 128, sha256: 'b'.repeat(64) },
    },
    confidence: null,
    unknowns: [],
    ...overrides,
  };
}
// Persistence-shaped fixtures are independent of normalizeClaim: evaluation must validate them.
function stored(data = candidate(), overrides = {}) {
  const id = hash([projectKey, data.domain, data.subject, data.key, data.versions, data.source.id, data.synthetic]);
  return {
    ...structuredClone(data),
    id,
    fingerprint: hash(data),
    schemaVersion: 1,
    projectKey,
    captureId: 'fixture-1',
    revision: 1,
    observedAt: now,
    ...overrides,
  };
}
const checks = claims => ({
  schemaVersion: 1,
  items: claims.map(claim => ({
    id: claim.id,
    revision: claim.revision,
    evidenceHash: claim.source.evidenceRef.sha256,
    intact: true,
    sourceMatches: true,
  })),
});
const evaluate = (claims, options = {}) =>
  evaluateClaims({ claims, context: context(), policy: policy(), now, evidenceChecks: checks(claims), ...options });
const row = (claim = stored(), options = {}) => evaluate([claim], options).rows[0];

test('Policy defaults are exact and smaller configured budgets survive normalization', () => {
  assert.deepEqual(validateResearchPolicy(), defaults);
  const p = policy({
    maxClaims: 1,
    maxEvidenceBytes: 128,
    maxContextBytes: 128,
    ttlSeconds: { domain: 1, product: 2, technical: 3, codebase: 4 },
  });
  const before = structuredClone(p);
  assert.deepEqual(validateResearchPolicy(p), p);
  assert.deepEqual(p, before);
});
for (const [name, mutate] of [
  [
    'unknown key',
    p => {
      p.trust = true;
    },
  ],
  [
    'missing key',
    p => {
      delete p.maxRequests;
    },
  ],
  [
    'unknown TTL domain',
    p => {
      p.ttlSeconds.other = 1;
    },
  ],
  [
    'zero TTL',
    p => {
      p.ttlSeconds.domain = 0;
    },
  ],
  [
    'TTL hard cap',
    p => {
      p.ttlSeconds.domain = 31536001;
    },
  ],
  [
    'claims hard cap',
    p => {
      p.maxClaims = 1001;
    },
  ],
  [
    'evidence hard cap',
    p => {
      p.maxEvidenceBytes = 1048577;
    },
  ],
  [
    'context hard cap',
    p => {
      p.maxContextBytes = 4097;
    },
  ],
  [
    'unsafe source path',
    p => {
      p.sourcePaths = ['../credentials.json'];
    },
  ],
  [
    'origin credentials',
    p => {
      p.allowedOrigins = ['https://user:secret@example.test'];
    },
  ],
  [
    'nonorigin allowlist',
    p => {
      p.allowedOrigins = ['https://example.test/docs'];
    },
  ],
  [
    'unknown mode',
    p => {
      p.mode = 'trusted';
    },
  ],
  [
    'zero claims',
    p => {
      p.maxClaims = 0;
    },
  ],
  [
    'zero evidence',
    p => {
      p.maxEvidenceBytes = 0;
    },
  ],
  [
    'context floor',
    p => {
      p.maxContextBytes = 127;
    },
  ],
  [
    'negative requests',
    p => {
      p.maxRequests = -1;
    },
  ],
])
  test('Policy rejects ' + name, () => {
    const p = policy();
    mutate(p);
    assert.throws(() => validateResearchPolicy(p));
  });

test('Canonical identities bind project/version/source/synthetic and fingerprints bind all candidate data', () => {
  const data = candidate({ value: { z: 1, a: [2, 3] }, versions: { region: 'EU', patch: 'fixture-A' } });
  const result = normalizeClaim({ projectKey, ...data });
  assert.deepEqual(result, {
    ...data,
    id: hash([
      projectKey,
      'codebase',
      'fixture-package',
      'version',
      { patch: 'fixture-A', region: 'EU' },
      'manifest',
      false,
    ]),
    fingerprint: hash(data),
  });
  assert.equal(Object.hasOwn(result, 'projectKey'), false);
  const reordered = candidate({ ...data, value: { a: [2, 3], z: 1 }, versions: { patch: 'fixture-A', region: 'EU' } });
  assert.deepEqual(normalizeClaim({ ...reordered, projectKey }), result);
  for (const change of [
    { projectKey: 'other-project' },
    { versions: { patch: 'fixture-B' } },
    { synthetic: true },
    { source: { ...data.source, id: 'other-source' } },
  ]) {
    assert.notEqual(normalizeClaim({ projectKey, ...data, ...change }).id, result.id);
  }
  const changed = normalizeClaim({ projectKey, ...data, value: { z: 1, a: [3, 2] } });
  assert.equal(changed.id, result.id);
  assert.notEqual(changed.fingerprint, result.fingerprint);
});
for (const [name, mutate] of [
  [
    'unknown row key',
    c => {
      c.trusted = true;
    },
  ],
  [
    'missing unknowns',
    c => {
      delete c.unknowns;
    },
  ],
  [
    'unknown domain',
    c => {
      c.domain = 'market';
    },
  ],
  [
    'long subject',
    c => {
      c.subject = 'a'.repeat(129);
    },
  ],
  [
    'confidence label',
    c => {
      c.confidence = 'official';
    },
  ],
  [
    'confidence overflow',
    c => {
      c.confidence = 1.01;
    },
  ],
  [
    'unknown source key',
    c => {
      c.source.verified = true;
    },
  ],
  [
    'unknown evidence key',
    c => {
      c.source.evidenceRef.verified = true;
    },
  ],
  [
    'versions cap',
    c => {
      c.versions = Object.fromEntries(Array.from({ length: 17 }, (_, i) => ['v' + i, 'x']));
    },
  ],
  [
    'empty version',
    c => {
      c.versions = { patch: '' };
    },
  ],
  [
    'unknowns cap',
    c => {
      c.unknowns = Array(33).fill('x');
    },
  ],
  [
    'long unknown',
    c => {
      c.unknowns = ['x'.repeat(201)];
    },
  ],
  [
    'nonfinite JSON',
    c => {
      c.value = Infinity;
    },
  ],
  [
    'undefined JSON',
    c => {
      c.value = { a: undefined };
    },
  ],
  [
    'cyclic JSON',
    c => {
      c.value = {};
      c.value.self = c.value;
    },
  ],
  [
    'deep JSON',
    c => {
      c.value = Array.from({ length: 14 }).reduce(value => ({ value }), 0);
    },
  ],
  [
    'large value',
    c => {
      c.value = 'x'.repeat(262144);
    },
  ],
  [
    'nodes cap',
    c => {
      c.value = Array(10001).fill(0);
    },
  ],
  [
    'impossible UTC date',
    c => {
      c.source.retrievedAt = '2026-02-30T00:00:00.000Z';
    },
  ],
  [
    'noncanonical UTC date',
    c => {
      c.source.validAsOf = '2026-11-05T12:00:00Z';
    },
  ],
  [
    'credential URL',
    c => {
      c.source.url = 'https://user:private-sentinel@example.test/docs';
    },
  ],
])
  test('Candidate rejects ' + name, () => {
    const c = candidate();
    mutate(c);
    assert.throws(() => normalizeClaim({ projectKey, ...c }));
  });

test('URL metadata permits only exact allowlisted HTTPS origins, numeric HN id and safe docs anchor', () => {
  const allowedOrigins = ['https://example.test', 'https://news.ycombinator.com'];
  assert.deepEqual(sanitizeKnowledgeUrl('https://example.test/docs#api-v1', { allowedOrigins }), {
    url: 'https://example.test/docs#api-v1',
    unknowns: [],
  });
  assert.equal(
    sanitizeKnowledgeUrl('https://news.ycombinator.com/item?id=123', { allowedOrigins }).url,
    'https://news.ycombinator.com/item?id=123',
  );
  for (const value of [
    'http://example.test/docs',
    'https://example.test.evil/docs',
    'https://example.test:8443/docs',
    'https://private-sentinel@example.test/docs',
    'https://example.test/docs?token=private-sentinel',
    'https://example.test/docs?%61pi_key=private-sentinel',
    'https://example.test/docs?search=anything',
    'https://example.test/docs?',
    'https://news.ycombinator.com/item?id=1&id=2',
    'https://news.ycombinator.com/item?id=oops',
    'https://example.test/docs#token=private-sentinel',
    'https://example.test/\nprivate-sentinel',
    'invalid-private-sentinel',
  ]) {
    const result = sanitizeKnowledgeUrl(value, { allowedOrigins });
    assert.equal(result.url, null);
    assert.ok(result.unknowns.length);
    assert.ok(!JSON.stringify(result).includes('private-sentinel'));
  }
  assert.equal(sanitizeKnowledgeUrl('https://example.test/docs').url, null);
  assert.deepEqual(sanitizeKnowledgeUrl(null), { url: null, unknowns: [] });
});

test('Mechanically verified local codebase observation alone is fresh and projectable', () => {
  const result = row();
  assert.equal(result.state, 'fresh');
  assert.deepEqual(result.reasons, []);
  assert.deepEqual(result.conflictIds, []);
  assert.equal(result.projection, 'local-observation');
});
test('TTL expires at the exact boundary and smaller policy TTL stays binding', () => {
  const claim = stored();
  assert.equal(row(claim, { now: '2026-11-05T12:59:59.999Z' }).state, 'fresh');
  const expired = row(claim, { now: '2026-11-05T13:00:00.000Z' });
  assert.equal(expired.state, 'stale');
  assert.equal(expired.projection, null);
  const p = policy();
  p.ttlSeconds.codebase = 1;
  assert.equal(row(claim, { policy: p, now: '2026-11-05T12:00:01.000Z' }).state, 'stale');
});
test('TTL uses retrieval rather than newer observation time and fails closed on missing or future dates', () => {
  for (const retrievedAt of ['2026-11-05T10:00:00.000Z', null, '2026-11-05T12:00:00.001Z']) {
    const data = candidate();
    data.source.retrievedAt = retrievedAt;
    const result = row(stored(data));
    assert.equal(result.state, 'stale');
    assert.equal(result.projection, null);
  }
  const data = candidate();
  data.source.validAsOf = '2026-11-05T12:00:00.001Z';
  assert.equal(row(stored(data)).projection, null);
});
test('Version and actual HEAD changes invalidate; absent current versions never borrow captures', () => {
  const claim = stored(candidate({ versions: { patch: 'fixture-A', format: 'Standard', headSha } }));
  for (const c of [
    context({ versions: { patch: 'fixture-B', format: 'Standard' } }),
    context({ headSha: 'c'.repeat(40) }),
  ]) {
    const result = row(claim, { context: c });
    assert.equal(result.state, 'invalidated');
    assert.equal(result.projection, null);
  }
  assert.equal(row(claim, { context: context({ versions: {} }) }).state, 'unknown');
  assert.equal(row(stored(candidate({ versions: {} }))).state, 'unknown');
});
test('Latest revision per id wins independently of input order and never revives older fresh evidence', () => {
  const old = stored();
  const data = candidate();
  data.source.retrievedAt = '2026-11-04T12:00:00.000Z';
  const latest = stored(data, { revision: 2, captureId: 'fixture-2' });
  for (const input of [
    [latest, old],
    [old, latest],
  ]) {
    const result = evaluate(input);
    assert.equal(result.rows.length, 1);
    assert.equal(result.rows[0].claim.revision, 2);
    assert.equal(result.rows[0].state, 'stale');
  }
});
test('Comparable incompatible values across sources conflict without confidence ranking', () => {
  const a = stored(candidate({ confidence: 1 }));
  const bdata = candidate({ value: '2.0.0', confidence: 0 });
  bdata.source.id = 'other';
  const b = stored(bdata);
  const result = evaluate([a, b]);
  for (const r of result.rows) {
    assert.equal(r.state, 'conflicted');
    assert.equal(r.projection, null);
    assert.deepEqual(r.conflictIds, [r.claim.id === a.id ? b.id : a.id]);
  }
  bdata.value = '1.0.0';
  assert.ok(evaluate([a, stored(bdata)]).rows.every(r => r.state === 'fresh'));
});
test('Entire version maps, regions, patches, formats and synthetic flags fence comparisons', () => {
  const a = stored(candidate({ versions: { headSha, patch: 'fixture-A' } }));
  for (const change of [
    { versions: { headSha, patch: 'fixture-B' } },
    { versions: { headSha, patch: 'fixture-A', region: 'EU' } },
    { versions: { headSha, patch: 'fixture-A', format: 'Wild' } },
    { versions: { headSha: 'd'.repeat(40), patch: 'fixture-A' } },
    { synthetic: true },
  ]) {
    const data = candidate({ value: '2.0.0', versions: { headSha, patch: 'fixture-A' }, ...change });
    data.source.id = 'other';
    assert.ok(evaluate([a, stored(data)]).rows.every(r => !r.conflictIds.length));
  }
});
test('Tampered id and fingerprint invalidate records even when evidence labels are positive', () => {
  const changed = stored();
  changed.value = 'injected';
  const wrongId = stored();
  wrongId.id = 'e'.repeat(64);
  for (const claim of [changed, wrongId]) {
    const result = row(claim);
    assert.equal(result.state, 'invalidated');
    assert.equal(result.projection, null);
  }
});
test('Cross-project records reject the entire evaluation without reflecting foreign contents', () => {
  const foreign = stored(candidate({ value: 'foreign-private-sentinel' }), { projectKey: 'other-project' });
  assert.throws(
    () => evaluate([stored(), foreign]),
    error => !error.message.includes('foreign-private-sentinel'),
  );
});
test('Evidence checks bind id revision hash intact and sourceMatches; confidence and labels grant no trust', () => {
  const claim = stored(candidate({ confidence: 1 }));
  for (const patch of [
    { id: 'e'.repeat(64) },
    { revision: 2 },
    { evidenceHash: 'e'.repeat(64) },
    { intact: false },
    { sourceMatches: false },
  ]) {
    const evidenceChecks = checks([claim]);
    Object.assign(evidenceChecks.items[0], patch);
    const result = row(claim, { evidenceChecks });
    assert.equal(result.state, 'untrusted');
    assert.equal(result.projection, null);
  }
  assert.equal(row(claim, { evidenceChecks: { schemaVersion: 1, items: [] } }).state, 'untrusted');
});
test('All four domains remain inspectable while external/discovery claims stay untrusted', () => {
  for (const domain of ['domain', 'product', 'technical', 'codebase']) {
    const data = candidate({
      domain,
      versions: domain === 'codebase' ? { headSha } : { patch: 'fixture-A' },
      confidence: 1,
    });
    data.source.kind = 'discovery';
    data.source.url = 'https://example.test/docs';
    data.source.path = null;
    data.source.pointer = null;
    const result = row(stored(data));
    assert.equal(result.state, 'untrusted');
    assert.equal(result.projection, null);
    data.source.kind = 'local';
    data.source.url = null;
    data.source.path = 'fixture.json';
    data.source.pointer = '/version';
    if (domain !== 'codebase') assert.equal(row(stored(data)).projection, null);
  }
});
test('Synthetic references require explicit matching synthetic context and remain visibly synthetic', () => {
  const fixture = stored(candidate({ domain: 'product', versions: { patch: 'fixture-A' }, synthetic: true }));
  assert.equal(row(fixture).projection, null);
  const projected = row(fixture, { context: context({ synthetic: true }) });
  assert.equal(projected.state, 'fresh');
  assert.equal(projected.projection, 'synthetic-reference');
  assert.equal(projected.claim.synthetic, true);
  assert.equal(row(stored(), { context: context({ synthetic: true }) }).projection, null);
});
test('Unknowns block projection and all reasons survive invalidated/stale/conflicted priority', () => {
  const unknown = row(stored(candidate({ unknowns: ['sample size not observed'] })));
  assert.equal(unknown.state, 'unknown');
  assert.equal(unknown.projection, null);
  assert.ok(
    evaluate([stored(candidate({ unknowns: ['sample size not observed'] }))]).unknowns.includes(
      'sample size not observed',
    ),
  );
  const data = candidate({ versions: { headSha: 'd'.repeat(40) }, unknowns: ['sample size not observed'] });
  data.source.retrievedAt = '2026-11-01T12:00:00.000Z';
  const other = structuredClone(data);
  other.source.id = 'other';
  other.value = 'other';
  const result = evaluate([stored(data), stored(other)]);
  assert.ok(
    result.rows.every(
      r => r.state === 'invalidated' && r.projection === null && r.reasons.length >= 3 && r.conflictIds.length === 1,
    ),
  );
});
test('Evaluation preserves lower claim/evidence policy caps and policy off never projects', () => {
  const a = stored(),
    data = candidate({ key: 'name' }),
    b = stored(data);
  assert.throws(() => evaluate([a, b], { policy: policy({ maxClaims: 1 }) }));
  assert.throws(() => evaluate([a], { policy: policy({ maxEvidenceBytes: 127 }) }));
  assert.equal(row(a, { policy: validateResearchPolicy() }).projection, null);
});
test('Strict evaluation rejects unknown context/check/record fields and leaves caller data unchanged', () => {
  const claim = stored(),
    original = structuredClone(claim);
  const options = { context: context(), policy: policy(), evidenceChecks: checks([claim]) };
  const before = structuredClone(options);
  evaluate([claim], options);
  assert.deepEqual(claim, original);
  assert.deepEqual(options, before);
  assert.throws(() => evaluate([claim], { context: { ...context(), trusted: true } }));
  assert.throws(() => evaluate([{ ...claim, trusted: true }]));
  assert.throws(() => evaluate([claim], { evidenceChecks: { ...checks([claim]), trusted: true } }));
  assert.throws(() => evaluate([claim], { context: { ...context(), contextHash: '0'.repeat(64) } }));
});

test('HEAD expectations belong only to codebase claims', () => {
  for (const domain of ['domain', 'product', 'technical'])
    assert.throws(() => normalizeClaim({ projectKey, ...candidate({ domain }) }));
});
test('Canonical fingerprint sorts integer-looking keys lexically without reordering arrays', () => {
  const data = candidate({ value: { 2: 'two', 10: 'ten' } });
  const expectedBytes = JSON.stringify(canonical(data)).replace(
    '"value":{"2":"two","10":"ten"}',
    '"value":{"10":"ten","2":"two"}',
  );
  assert.equal(
    normalizeClaim({ projectKey, ...data }).fingerprint,
    createHash('sha256').update(expectedBytes).digest('hex'),
  );
});
test('Ambiguous checks and duplicate revision equivocation fail closed', () => {
  const claim = stored(),
    evidenceChecks = checks([claim]);
  evidenceChecks.items.push({ ...evidenceChecks.items[0], intact: false });
  assert.equal(row(claim, { evidenceChecks }).projection, null);
  const changed = stored(candidate({ value: 'other' }));
  assert.throws(() => evaluate([claim, changed]));
});
test('Unknown timestamps and future observations never project and dates are strictly validated on evaluation', () => {
  const data = candidate();
  data.source.validAsOf = null;
  assert.equal(row(stored(data)).state, 'unknown');
  assert.equal(row(stored(candidate(), { observedAt: '2026-11-06T12:00:00.000Z' })).state, 'invalidated');
  const malformed = stored();
  malformed.source.retrievedAt = 'yesterday';
  assert.throws(() => row(malformed));
});
test('Strict JSON rejects accessor-bearing objects and exotic array prototypes without invoking accessors', () => {
  let accessed = false;
  const data = candidate();
  Object.defineProperty(data, 'value', {
    enumerable: true,
    get() {
      accessed = true;
      return 'x';
    },
  });
  // Supply descriptors without spreading the untrusted record (spreading would run its getter).
  const input = Object.create(null, {
    ...Object.getOwnPropertyDescriptors(data),
    projectKey: { enumerable: true, value: projectKey },
  });
  assert.throws(() => normalizeClaim(input));
  assert.equal(accessed, false);
  class Exotic extends Array {}
  assert.throws(() => normalizeClaim({ projectKey, ...candidate({ value: new Exotic(1, 2) }) }));
});
test('URL objects are rejected before coercion can execute untrusted code', () => {
  let coerced = false;
  const data = candidate();
  data.source.url = {
    toString() {
      coerced = true;
      return 'https://example.test/docs';
    },
  };
  assert.throws(() => normalizeClaim({ projectKey, ...data }));
  assert.equal(coerced, false);
});
test('Lower total evidence cap applies across records and domains have distinct TTLs', () => {
  assert.throws(() =>
    evaluate([stored(), stored(candidate({ key: 'name' }))], { policy: policy({ maxEvidenceBytes: 255 }) }),
  );
  const syntheticContext = context({ synthetic: true });
  for (const [domain, ttl] of Object.entries(defaults.ttlSeconds)) {
    const claim = stored(
      candidate({ domain, synthetic: true, versions: domain === 'codebase' ? { headSha } : { patch: 'fixture-A' } }),
    );
    const boundary = new Date(Date.parse(now) + ttl * 1000).toISOString();
    assert.equal(row(claim, { context: syntheticContext, now: boundary }).state, 'stale');
  }
});
