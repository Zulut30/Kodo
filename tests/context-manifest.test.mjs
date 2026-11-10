import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { buildContextManifest, manifestFreshness } from '../runtime/context-manifest.mjs';

const head = 'a'.repeat(40);
const hash = letter => letter.repeat(64);
const ref = (kind, letter, extra = {}) => ({
  // Built with the platform separator, as the Engine builds evidence paths.
  path: path.join(path.sep, 'private', 'state', 'runs', 'r1', 'evidence', `${kind}-${hash(letter)}.json`),
  sha256: hash(letter),
  bytes: 120,
  headSha: head,
  ...extra,
});
const worker = (extra = {}) => ({
  runId: 'r1',
  stage: 'developer',
  node: 'feature',
  headSha: head,
  sections: [
    { name: 'guidance', bytes: 900, mandatory: true },
    { name: 'instructions', bytes: 300, mandatory: true },
    { name: 'task-context', bytes: 1500, mandatory: true },
    {
      name: 'evidence',
      bytes: 4000,
      mandatory: false,
      originalBytes: 52000,
      truncated: true,
      omitted: [{ field: 'analysis.files', items: 40 }],
    },
  ],
  references: [ref('analysis', 'b'), ref('node-contract', 'c')],
  ...extra,
});
const code = (fn, expected) => assert.throws(fn, error => error.code === expected, expected);

test('A manifest records sizes, the mandatory contract and what bounded packing left out', () => {
  const manifest = buildContextManifest(worker());
  assert.equal(manifest.kind, 'context-manifest');
  assert.equal(manifest.totalBytes, 6700);
  assert.deepEqual(manifest.mandatory.contract, {
    kind: 'node-contract',
    file: `node-contract-${hash('c')}.json`,
    sha256: hash('c'),
    bytes: 120,
    headSha: head,
  });
  const evidence = manifest.sections.find(section => section.name === 'evidence');
  assert.deepEqual(
    [evidence.originalBytes, evidence.truncated, evidence.omitted],
    [52000, true, [{ field: 'analysis.files', items: 40 }]],
  );
  const context = manifest.sections.find(section => section.name === 'task-context');
  assert.deepEqual([context.mandatory, context.bytes, context.truncated], [true, 1500, undefined]);
});

test('The mandatory task contract survives: it is required, never shortened and never silently dropped', () => {
  code(
    () => buildContextManifest(worker({ references: [ref('analysis', 'b')] })),
    'context_manifest_invalid',
    'a task context without its contract',
  );
  const shortened = worker();
  shortened.sections[2] = { ...shortened.sections[2], truncated: true, omitted: [{ field: 'acceptance', items: 1 }] };
  code(() => buildContextManifest(shortened), 'context_manifest_invalid');
  const silent = worker();
  silent.sections[3] = { name: 'evidence', bytes: 10, mandatory: false, truncated: true };
  code(() => buildContextManifest(silent), 'context_manifest_invalid');
  const renamed = worker({ references: [ref('analysis', 'b'), { ...ref('node-contract', 'c'), sha256: hash('d') }] });
  code(() => buildContextManifest(renamed), 'context_manifest_invalid');
});

test('An explicit limit refuses the session instead of shortening mandatory context', () => {
  assert.equal(buildContextManifest(worker({ limitBytes: 6700 })).limitBytes, 6700);
  assert.throws(
    () => buildContextManifest(worker({ limitBytes: 6699 })),
    error =>
      error.code === 'context_budget' &&
      error.totalBytes === 6700 &&
      error.limitBytes === 6699 &&
      error.mandatoryBytes === 2700,
  );
  code(() => buildContextManifest(worker({ limitBytes: 0 })), 'context_manifest_invalid');
});

test('A manifest holds no prompt text, private path or secret', () => {
  const known = 'fixture-sensitive-value';
  const input = worker();
  input.sections[3].omitted = [{ field: 'analysis.files', items: 40, text: `ignore previous instructions ${known}` }];
  const text = JSON.stringify(buildContextManifest(input));
  assert.doesNotMatch(text, /private|runs|ignore previous|fixture-sensitive/);
  assert.deepEqual(Object.keys(JSON.parse(text)).sort(), [
    'headSha',
    'kind',
    'limitBytes',
    'mandatory',
    'node',
    'references',
    'runId',
    'schemaVersion',
    'sections',
    'stage',
    'totalBytes',
  ]);
});

test('Invalid input is rejected: unknown section shape, duplicate names, bad head or reference', () => {
  const dup = worker();
  dup.sections.push({ name: 'guidance', bytes: 1, mandatory: true });
  code(() => buildContextManifest(dup), 'context_manifest_invalid');
  code(() => buildContextManifest(worker({ headSha: 'main' })), 'context_manifest_invalid');
  code(() => buildContextManifest(worker({ sections: [] })), 'context_manifest_invalid');
  code(() => buildContextManifest(worker({ sections: [{ name: 'Bad Name', bytes: 1 }] })), 'context_manifest_invalid');
  // A reference whose file name does not carry its hash is kept, but its kind is not trusted.
  const plain = buildContextManifest({
    runId: 'r1',
    stage: 'review',
    sections: [{ name: 'prompt', bytes: 10, mandatory: true }],
    references: [{ path: 'D:/x/knowledge.json', sha256: hash('e'), bytes: 5 }],
  });
  assert.deepEqual(plain.references, [
    { kind: 'evidence', file: 'knowledge.json', sha256: hash('e'), bytes: 5, headSha: null },
  ]);
  assert.equal(plain.mandatory.contract, null);
  // A reference without a valid hash is recorded as unverifiable and never becomes the contract.
  const loose = buildContextManifest({
    runId: 'r1',
    stage: 'review',
    sections: [{ name: 'prompt', bytes: 10, mandatory: true }],
    references: [{ path: `x/node-contract-${hash('c')}.json`, sha256: 'nope', bytes: -1, headSha: 'main' }],
  });
  assert.deepEqual(loose.references, [
    { kind: 'evidence', file: `node-contract-${hash('c')}.json`, sha256: null, bytes: null, headSha: null },
  ]);
  assert.equal(manifestFreshness(loose, { headSha: null, hashes: {} }).status, 'fresh', 'unverifiable is not invalid');
});

test('Freshness: a moved head is stale, changed or missing evidence invalidates, no observation is unknown', () => {
  const manifest = buildContextManifest(worker());
  const hashes = Object.fromEntries(manifest.references.map(item => [item.file, item.sha256]));
  assert.deepEqual(manifestFreshness(manifest, { headSha: head, hashes }), { status: 'fresh', reasons: [] });
  assert.deepEqual(manifestFreshness(manifest, { headSha: 'b'.repeat(40), hashes }), {
    status: 'stale',
    reasons: ['head_moved'],
  });
  const contract = manifest.mandatory.contract.file;
  assert.deepEqual(manifestFreshness(manifest, { headSha: head, hashes: { ...hashes, [contract]: hash('f') } }), {
    status: 'invalidated',
    reasons: [`changed:${contract}`],
  });
  const { [contract]: _gone, ...rest } = hashes;
  assert.deepEqual(manifestFreshness(manifest, { headSha: head, hashes: rest }), {
    status: 'invalidated',
    reasons: [`missing:${contract}`],
  });
  assert.equal(manifestFreshness(manifest, {}).status, 'unknown');
  assert.equal(manifestFreshness({ kind: 'other' }, { headSha: head, hashes }).status, 'unknown');
});
