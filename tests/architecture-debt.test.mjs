import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { applyArchitectureDebt, evaluateArchitectureProtection } from '../runtime/architecture-debt.mjs';

// Independent fixture hashing follows the frozen wire format, not D helpers.
const canonical = value =>
  Array.isArray(value)
    ? value.map(canonical)
    : value !== null && typeof value === 'object'
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
const fileHash = text => createHash('sha256').update(text).digest('hex');
const now = '2026-11-04T12:00:00.000Z';
function finding(patch = {}) {
  const body = {
    ruleId: 'dependency.forbidden',
    severity: 'error',
    file: 'src/app/main.mjs',
    offset: 0,
    fromModule: 'app',
    toModule: 'core',
    relatedFiles: ['src/core/index.mjs'],
    sourceHashes: [
      { file: 'src/app/main.mjs', sha256: fileHash('app') },
      { file: 'src/core/index.mjs', sha256: fileHash('core') },
    ],
    ...patch,
  };
  return { id: hash(body), ...body };
}
const waiver = (f, patch = {}) => ({
  findingId: f.id,
  owner: 'core-team',
  reason: 'Tracked migration',
  reviewAfter: '2026-11-05T00:00:00.000Z',
  ...patch,
});
function debtInput(patch = {}) {
  const f = finding();
  return { findings: [f], baseFindings: [f], baseline: [waiver(f)], exceptions: [], changedPaths: [], now, ...patch };
}
function policy(patch = {}) {
  return {
    schemaVersion: 1,
    version: 1,
    productRoots: ['src'],
    modules: [
      { id: 'app', roots: ['src/app'], layer: 'app', public: [], allow: ['core'] },
      { id: 'core', roots: ['src/core'], layer: 'core', public: ['src/core/index.mjs'], allow: [] },
    ],
    layers: { app: ['core'], core: [] },
    forbiddenImports: [{ from: 'app', to: 'core' }],
    cycles: 'forbid',
    contracts: 'architecture.contracts.json',
    baseline: [],
    exceptions: [],
    protectedPaths: ['tests/core-contract.test.mjs'],
    ...patch,
  };
}
function freeze(value) {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
}
const invalid = (source, index, reason) => ({ source, index, reason });
const protectedResult = paths => ({
  schemaVersion: 1,
  requiresReview: true,
  fullVerificationRequired: true,
  reviewPaths: paths,
});
const neutral = { schemaVersion: 1, requiresReview: false, fullVerificationRequired: false, reviewPaths: [] };

test('Debt adopts only the exact unchanged base finding and preserves complete severity data', () => {
  const input = debtInput(),
    result = applyArchitectureDebt(input);
  assert.deepEqual(result, {
    schemaVersion: 1,
    activeFindings: [],
    debt: [{ finding: input.findings[0], source: 'baseline', index: 0 }],
    invalidEntries: [],
  });
  assert.equal(result.debt[0].finding.severity, 'error');
  assert.notEqual(result.debt[0].finding, input.findings[0]);
});

test('Debt exceptions have the same eligibility and retain their original indexes', () => {
  const a = finding(),
    b = finding({ offset: 10 });
  const result = applyArchitectureDebt(
    debtInput({
      findings: [a, b],
      baseFindings: [a, b],
      baseline: [],
      exceptions: [waiver(a), waiver(b, { reviewAfter: now })],
    }),
  );
  assert.deepEqual(result.activeFindings, [b]);
  assert.deepEqual(result.debt, [{ finding: a, source: 'exception', index: 0 }]);
  assert.deepEqual(result.invalidEntries, [invalid('exception', 1, 'expired')]);
});

test('Debt cannot manufacture history when the base policy was genuinely absent', () => {
  const input = debtInput({ baseFindings: [] }),
    result = applyArchitectureDebt(input);
  assert.deepEqual(result.activeFindings, input.findings);
  assert.deepEqual(result.debt, []);
  assert.deepEqual(result.invalidEntries, [invalid('baseline', 0, 'not-in-base')]);
});

test('Debt rejects new and worsened findings while keeping the old waiver invalid', () => {
  const old = finding(),
    changed = finding({ offset: 20 }),
    added = finding({ ruleId: 'entry.private' });
  const result = applyArchitectureDebt(debtInput({ findings: [changed, added] }));
  assert.deepEqual(result.activeFindings, [changed, added]);
  assert.deepEqual(result.debt, []);
  assert.deepEqual(result.invalidEntries, [invalid('baseline', 0, 'ineligible')]);
});

test('Debt rejects changed source on the primary related and hashed participating paths', async t => {
  for (const [name, changedPath] of [
    ['primary', 'src/app/main.mjs'],
    ['related', 'src/core/index.mjs'],
    ['hash-only', 'src/shared.mjs'],
  ])
    await t.test(name, () => {
      const f = finding({
        sourceHashes: [...finding().sourceHashes, { file: 'src/shared.mjs', sha256: fileHash('shared') }],
      });
      const input = debtInput({ findings: [f], baseFindings: [f], baseline: [waiver(f)], changedPaths: [changedPath] });
      const result = applyArchitectureDebt(input);
      assert.deepEqual(result.activeFindings, [f]);
      assert.deepEqual(result.debt, []);
      assert.deepEqual(result.invalidEntries, [invalid('baseline', 0, 'changed-source')]);
    });
});

test('Debt does not confuse a sibling path with a participating source', () => {
  assert.equal(applyArchitectureDebt(debtInput({ changedPaths: ['src/core/index.mjs.backup'] })).debt.length, 1);
});

test('Debt refuses a changed source hash and never transfers an old waiver to a new ID', () => {
  const old = finding(),
    next = finding({ sourceHashes: [{ file: 'src/app/main.mjs', sha256: fileHash('new app') }, old.sourceHashes[1]] });
  const result = applyArchitectureDebt(debtInput({ findings: [next], changedPaths: ['src/app/main.mjs'] }));
  assert.deepEqual(result.activeFindings, [next]);
  assert.deepEqual(result.invalidEntries, [invalid('baseline', 0, 'changed-source')]);
});

test('Debt rejects every copy of duplicates within or across waiver sources', async t => {
  const f = finding(),
    entry = waiver(f);
  for (const [name, baseline, exceptions, expected] of [
    ['baseline', [entry, entry], [], [invalid('baseline', 0, 'duplicate'), invalid('baseline', 1, 'duplicate')]],
    ['exception', [], [entry, entry], [invalid('exception', 0, 'duplicate'), invalid('exception', 1, 'duplicate')]],
    ['cross-source', [entry], [entry], [invalid('baseline', 0, 'duplicate'), invalid('exception', 0, 'duplicate')]],
  ])
    await t.test(name, () => {
      const result = applyArchitectureDebt(debtInput({ baseline, exceptions }));
      assert.deepEqual(result.activeFindings, [f]);
      assert.deepEqual(result.debt, []);
      assert.deepEqual(result.invalidEntries, expected);
    });
});

test('Debt expiration is strict at the injected clock boundary', async t => {
  for (const [name, reviewAfter, allowed] of [
    ['before', '2026-11-04T11:59:59.999Z', false],
    ['equal', now, false],
    ['after', '2026-11-04T12:00:00.001Z', true],
    ['seconds', '2026-11-04T12:00:01Z', true],
  ])
    await t.test(name, () => {
      const result = applyArchitectureDebt(debtInput({ baseline: [waiver(finding(), { reviewAfter })] }));
      assert.equal(result.debt.length, allowed ? 1 : 0);
      assert.deepEqual(result.invalidEntries, allowed ? [] : [invalid('baseline', 0, 'expired')]);
    });
});

test('Debt rejects malformed waived records without treating them as approval', async t => {
  const f = finding();
  for (const [name, patch] of [
    ['unknown-key', { approved: true }],
    ['blank-owner', { owner: ' ' }],
    ['blank-reason', { reason: '' }],
    ['invalid-id', { findingId: 'bad' }],
    ['impossible-date', { reviewAfter: '2026-02-30T00:00:00Z' }],
    ['non-utc', { reviewAfter: '2026-11-05T01:00:00+01:00' }],
    ['missing-clock', { reviewAfter: undefined }],
  ])
    await t.test(name, () => {
      const result = applyArchitectureDebt(debtInput({ baseline: [waiver(f, patch)] }));
      assert.deepEqual(result.activeFindings, [f]);
      assert.deepEqual(result.debt, []);
      assert.deepEqual(result.invalidEntries, [invalid('baseline', 0, 'ineligible')]);
    });
});

test('Debt requires an explicit valid UTC clock instead of reading ambient time', async t => {
  for (const [name, value] of [
    ['missing', undefined],
    ['date-object', new Date(now)],
    ['local-time', '2026-11-04T12:00:00'],
    ['offset-time', '2026-11-04T12:00:00+00:00'],
    ['rollover', '2026-02-30T12:00:00Z'],
    ['garbage', 'tomorrow'],
  ])
    await t.test(name, () => {
      assert.throws(() => applyArchitectureDebt(debtInput({ now: value })), { code: 'configuration' });
    });
});

test('Debt allows only the fixed eligible architectural rule families', async t => {
  for (const ruleId of [
    'ownership.unowned',
    'ownership.overlap',
    'dependency.forbidden',
    'dependency.not-allowed',
    'dependency.cycle',
    'layer.direction',
    'entry.private',
  ])
    await t.test(ruleId, () => {
      const f = finding({ ruleId });
      assert.equal(
        applyArchitectureDebt(debtInput({ findings: [f], baseFindings: [f], baseline: [waiver(f)] })).debt.length,
        1,
      );
    });
  for (const ruleId of [
    'contract.exports',
    'contract.version',
    'contract.migration',
    'contract.dependent',
    'contract.tests',
  ])
    await t.test(ruleId, () => {
      const f = finding({ ruleId });
      const result = applyArchitectureDebt(debtInput({ findings: [f], baseFindings: [f], baseline: [waiver(f)] }));
      assert.deepEqual(result.activeFindings, [f]);
      assert.deepEqual(result.invalidEntries, [invalid('baseline', 0, 'ineligible')]);
    });
});

test('Debt rejects forged incomplete unsupported and duplicate finding data', async t => {
  const good = finding();
  for (const [name, findings] of [
    ['forged-id', [{ ...good, offset: 1 }]],
    ['missing-field', [{ ...good, sourceHashes: undefined }]],
    ['unknown-field', [{ ...good, approved: true }]],
    ['downgraded-severity', [finding({ severity: 'warning' })]],
    ['unsupported', [finding({ ruleId: 'unsupported.language' })]],
    ['duplicate', [good, good]],
    ['empty-source-hashes', [finding({ sourceHashes: [] })]],
    ['missing-participant', [finding({ sourceHashes: [good.sourceHashes[0]] })]],
  ])
    await t.test(name, () => {
      assert.throws(() => applyArchitectureDebt(debtInput({ findings })), { code: 'configuration' });
    });
  assert.throws(() => applyArchitectureDebt(debtInput({ baseFindings: [good, good] })), { code: 'configuration' });
});

test('Debt returns complete empty and active-only results without inventing waivers', () => {
  assert.deepEqual(applyArchitectureDebt(debtInput({ findings: [], baseFindings: [], baseline: [] })), {
    schemaVersion: 1,
    activeFindings: [],
    debt: [],
    invalidEntries: [],
  });
  const f = finding();
  assert.deepEqual(applyArchitectureDebt(debtInput({ baseline: [] })), {
    schemaVersion: 1,
    activeFindings: [f],
    debt: [],
    invalidEntries: [],
  });
});

test('Debt and protection reject caller approval fields unsafe paths and scope overflow', () => {
  assert.throws(() => applyArchitectureDebt({ ...debtInput(), approved: true }), { code: 'configuration' });
  assert.throws(
    () => evaluateArchitectureProtection({ basePolicy: null, headPolicy: null, changedPaths: [], approved: true }),
    { code: 'configuration' },
  );
  for (const file of ['../src/a.mjs', 'src\\a.mjs', '/src/a.mjs', 'src/*.mjs', 'src/./a.mjs', 'src/e\u0301.mjs']) {
    assert.throws(() => applyArchitectureDebt(debtInput({ changedPaths: [file] })), { code: 'unsafe_path' });
    assert.throws(() => evaluateArchitectureProtection({ basePolicy: null, headPolicy: null, changedPaths: [file] }), {
      code: 'unsafe_path',
    });
  }
  assert.throws(() => applyArchitectureDebt(debtInput({ baseline: Array(10001).fill(waiver(finding())) })), {
    code: 'scope_limit',
  });
});

test('Debt and protection are deterministic deep-frozen results without mutating inputs', () => {
  const input = freeze(debtInput()),
    snapshot = JSON.stringify(input),
    a = applyArchitectureDebt(input),
    b = applyArchitectureDebt(input);
  assert.deepEqual(a, b);
  assert.equal(JSON.stringify(input), snapshot);
  assert.ok(Object.isFrozen(a) && Object.isFrozen(a.debt) && Object.isFrozen(a.debt[0].finding.sourceHashes[0]));
  assert.throws(() => {
    a.debt[0].finding.severity = 'warning';
  }, TypeError);
  const p = policy(),
    args = freeze({ basePolicy: p, headPolicy: p, changedPaths: ['tests/core-contract.test.mjs'] });
  const result = evaluateArchitectureProtection(args);
  assert.deepEqual(result, protectedResult(['tests/core-contract.test.mjs']));
  assert.deepEqual(result, evaluateArchitectureProtection(args));
  assert.ok(Object.isFrozen(result) && Object.isFrozen(result.reviewPaths));
});

test('Protection is neutral for unchanged policy and ordinary or CSS product changes', () => {
  const p = policy();
  assert.deepEqual(
    evaluateArchitectureProtection({
      basePolicy: p,
      headPolicy: structuredClone(p),
      changedPaths: ['src/app/main.mjs', 'src/app/style.css', 'docs/readme.md'],
    }),
    neutral,
  );
  assert.deepEqual(evaluateArchitectureProtection({ basePolicy: null, headPolicy: null, changedPaths: [] }), neutral);
});

test('Protection requires review and full verification for first enrollment and policy deletion', () => {
  const p = policy();
  assert.deepEqual(
    evaluateArchitectureProtection({ basePolicy: null, headPolicy: p, changedPaths: [] }),
    protectedResult(['architecture.policy.json']),
  );
  assert.deepEqual(
    evaluateArchitectureProtection({ basePolicy: p, headPolicy: null, changedPaths: [] }),
    protectedResult(['architecture.policy.json']),
  );
});

test('Protection detects changed policy roots rules contracts and waiver records without trusting the diff', async t => {
  for (const [name, patch] of [
    ['roots', { productRoots: ['lib'] }],
    ['module-root', { modules: [policy().modules[1]] }],
    ['rules', { forbiddenImports: [] }],
    ['contract-path', { contracts: 'new-contracts.json' }],
    ['baseline', { baseline: [waiver(finding())] }],
    ['exceptions', { exceptions: [waiver(finding())] }],
    ['removed-protection', { protectedPaths: [] }],
    ['version', { version: 2 }],
  ])
    await t.test(name, () => {
      assert.deepEqual(
        evaluateArchitectureProtection({ basePolicy: policy(), headPolicy: policy(patch), changedPaths: [] }),
        protectedResult(['architecture.policy.json']),
      );
    });
});

test('Protection uses both old and new explicit prefixes and contract paths on additions and deletions', () => {
  const base = policy({ contracts: 'old/registry.json', protectedPaths: ['old/gold'] });
  const head = policy({ contracts: 'new/registry.json', protectedPaths: ['new/gold'] });
  assert.deepEqual(
    evaluateArchitectureProtection({
      basePolicy: base,
      headPolicy: head,
      changedPaths: [
        'old/gold/removed.mjs',
        'new/gold/added.mjs',
        'old/registry.json',
        'new/registry.json',
        'old/golden.mjs',
      ],
    }),
    protectedResult([
      'architecture.policy.json',
      'new/gold/added.mjs',
      'new/registry.json',
      'old/gold/removed.mjs',
      'old/registry.json',
    ]),
  );
});

test('Protection detects CI golden fixtures and tool pins even without a policy', async t => {
  for (const [name, file] of [
    ['policy-file', 'architecture.policy.json'],
    ['ci-workflow', '.github/workflows/ci.yml'],
    ['ci-runtime', 'runtime/ci-graph.mjs'],
    ['ci-script', 'scripts/ci-reporter.mjs'],
    ['golden', 'tests/golden/dependency.json'],
    ['fixture', 'tests/fixtures/architecture/old.json'],
    ['snapshot', 'tests/__snapshots__/api.snap'],
    ['tool-registry', 'registry.json'],
    ['skill-pins', 'third-party-skills.lock.json'],
    ['npm-lock', 'package-lock.json'],
    ['nested-lock', 'packages/app/pnpm-lock.yaml'],
    ['node-pin', '.node-version'],
    ['quality-pins', 'runtime/quality-tool-registry.mjs'],
    ['toolchains', 'runtime/toolchains.mjs'],
    ['actual-tool-catalog', 'runtime/tool-catalog.json'],
  ])
    await t.test(name, () => {
      assert.deepEqual(
        evaluateArchitectureProtection({ basePolicy: null, headPolicy: null, changedPaths: [file, file] }),
        protectedResult([file]),
      );
    });
});

test('Debt rejects sparse waiver arrays instead of silently dropping entries', () => {
  const baseline = Array(1);
  baseline.extra = waiver(finding());
  assert.throws(() => applyArchitectureDebt(debtInput({ baseline })), { code: 'configuration' });
});

test('Protection observes independent Git additions removals renames and waiver edits', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'kodo-debt-fixture-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', windowsHide: true }).trim();
  const put = async (file, text) => {
    await mkdir(path.dirname(path.join(root, file)), { recursive: true });
    await writeFile(path.join(root, file), text);
  };
  git('init', '-q');
  git('config', 'user.name', 'Fixture');
  git('config', 'user.email', 'fixture@example.invalid');
  const base = policy({ protectedPaths: ['owned/oracle.mjs'] });
  await put('architecture.policy.json', JSON.stringify(base));
  await put('owned/oracle.mjs', 'export const original = true;');
  git('add', '-A');
  git('commit', '-qm', 'base');
  const baseSha = git('rev-parse', 'HEAD'),
    head = policy({ protectedPaths: [], exceptions: [waiver(finding())] });
  git('mv', 'owned/oracle.mjs', 'owned/moved.mjs');
  await put('architecture.policy.json', JSON.stringify(head));
  await put('.github/workflows/new.yml', 'name: fixture');
  git('add', '-A');
  git('commit', '-qm', 'head');
  const changedPaths = git('diff', '--name-only', '--no-renames', baseSha, 'HEAD').split('\n');
  assert.deepEqual(
    evaluateArchitectureProtection({ basePolicy: base, headPolicy: head, changedPaths }),
    protectedResult(['.github/workflows/new.yml', 'architecture.policy.json', 'owned/oracle.mjs']),
  );
});
