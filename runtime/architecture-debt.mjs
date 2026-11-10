import { createHash } from 'node:crypto';

const FINDING_LIMIT = 10000;
const PATH_LIMIT = 20000;
const eligibleRules = new Set([
  'ownership.unowned',
  'ownership.overlap',
  'dependency.forbidden',
  'dependency.not-allowed',
  'dependency.cycle',
  'layer.direction',
  'entry.private',
]);
const rules = new Set([
  ...eligibleRules,
  'contract.exports',
  'contract.version',
  'contract.migration',
  'contract.dependent',
  'contract.tests',
]);
const findingKeys = [
  'id',
  'ruleId',
  'severity',
  'file',
  'offset',
  'fromModule',
  'toModule',
  'relatedFiles',
  'sourceHashes',
];
const policyKeys = [
  'schemaVersion',
  'version',
  'productRoots',
  'modules',
  'layers',
  'forbiddenImports',
  'cycles',
  'contracts',
  'baseline',
  'exceptions',
  'protectedPaths',
];
const sha256 = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const text = value => typeof value === 'string' && value.trim().length > 0;
const object = value =>
  value !== null &&
  typeof value === 'object' &&
  !Array.isArray(value) &&
  [Object.prototype, null].includes(Object.getPrototypeOf(value));
const exact = (value, keys) =>
  object(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
function fail(code = 'configuration') {
  throw Object.assign(new Error('Invalid architecture debt/protection input'), { code });
}
function list(value, limit) {
  if (!Array.isArray(value)) fail();
  if (value.length > limit) fail('scope_limit');
  if (Object.keys(value).length !== value.length) fail();
  for (let index = 0; index < value.length; index++) if (!Object.hasOwn(value, index)) fail();
  return value;
}
function relative(value) {
  if (
    typeof value !== 'string' ||
    !value ||
    value !== value.normalize('NFC') ||
    /[\\:\x00-\x1f\x7f*?[\]{}]/.test(value) ||
    value.startsWith('/') ||
    value
      .split('/')
      .some(
        part =>
          !part ||
          part === '.' ||
          part === '..' ||
          /[. ]$/.test(part) ||
          /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part),
      )
  )
    fail('unsafe_path');
  return value;
}
function paths(values) {
  return list(values, PATH_LIMIT).map(relative);
}
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (object(value))
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map(key => [key, canonical(value[key])]),
    );
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'boolean' ||
    (typeof value === 'number' && Number.isFinite(value))
  )
    return value;
  fail();
}
const serialize = value => JSON.stringify(canonical(value));
function freeze(value) {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
}
const result = value => freeze(canonical(value));
const sortedUnique = values => [...new Set(values)].sort();
const orderedSet = values => values.every((value, index) => index === 0 || values[index - 1] < value);
function utc(value) {
  if (typeof value !== 'string') return null;
  const match = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,3}))?Z$/.exec(value);
  if (!match) return null;
  const normalized = match[1] + '.' + (match[2] || '').padEnd(3, '0') + 'Z';
  const ms = Date.parse(normalized);
  return Number.isFinite(ms) && new Date(ms).toISOString() === normalized ? ms : null;
}
function validEntry(entry) {
  return (
    exact(entry, ['findingId', 'owner', 'reason', 'reviewAfter']) &&
    sha256(entry.findingId) &&
    text(entry.owner) &&
    text(entry.reason) &&
    utc(entry.reviewAfter) !== null
  );
}
function validateFinding(finding) {
  if (
    !exact(finding, findingKeys) ||
    !sha256(finding.id) ||
    !rules.has(finding.ruleId) ||
    finding.severity !== 'error' ||
    !(finding.offset === null || (Number.isSafeInteger(finding.offset) && finding.offset >= 0)) ||
    ![finding.fromModule, finding.toModule].every(value => value === null || text(value))
  )
    fail();
  if (finding.file !== null) relative(finding.file);
  const related = paths(finding.relatedFiles);
  if (!orderedSet(related)) fail();
  const hashes = list(finding.sourceHashes, PATH_LIMIT);
  for (const entry of hashes) {
    if (!exact(entry, ['file', 'sha256']) || !sha256(entry.sha256)) fail();
    relative(entry.file);
  }
  if (!orderedSet(hashes.map(entry => entry.file))) fail();
  // D cannot infer new history or reconstruct missing source evidence.
  if (
    eligibleRules.has(finding.ruleId) &&
    (!hashes.length ||
      [finding.file, ...related].filter(file => file !== null).some(file => !hashes.some(entry => entry.file === file)))
  )
    fail();
  const { id, ...body } = finding;
  if (createHash('sha256').update(serialize(body)).digest('hex') !== id) fail();
}
function findingsMap(values) {
  const map = new Map();
  for (const finding of list(values, FINDING_LIMIT)) {
    validateFinding(finding);
    if (map.has(finding.id)) fail();
    map.set(finding.id, finding);
  }
  return map;
}

/** Pure debt evaluation. Entries never change severity or confer review authority. */
export function applyArchitectureDebt(input) {
  if (!exact(input, ['findings', 'baseFindings', 'baseline', 'exceptions', 'changedPaths', 'now'])) fail();
  const clock = utc(input.now);
  if (clock === null) fail();
  const head = findingsMap(input.findings),
    base = findingsMap(input.baseFindings);
  const changed = new Set(paths(input.changedPaths));
  const entries = ['baseline', 'exceptions'].flatMap(key =>
    list(input[key], FINDING_LIMIT).map((entry, index) => ({
      entry,
      index,
      source: key === 'baseline' ? 'baseline' : 'exception',
    })),
  );
  if (entries.length > FINDING_LIMIT) fail('scope_limit');
  const counts = new Map();
  for (const { entry } of entries)
    if (object(entry) && sha256(entry.findingId)) {
      counts.set(entry.findingId, (counts.get(entry.findingId) || 0) + 1);
    }
  const debt = [],
    invalidEntries = [],
    adopted = new Set();
  for (const { entry, source, index } of entries) {
    let reason;
    const old = base.get(entry?.findingId),
      current = head.get(entry?.findingId);
    if (!validEntry(entry)) reason = 'ineligible';
    else if (counts.get(entry.findingId) > 1) reason = 'duplicate';
    else if (utc(entry.reviewAfter) <= clock) reason = 'expired';
    else if (!old) reason = 'not-in-base';
    else if (!eligibleRules.has(old.ruleId)) reason = 'ineligible';
    else if (
      [old.file, ...old.relatedFiles, ...old.sourceHashes.map(row => row.file)].some(
        file => file !== null && changed.has(file),
      )
    )
      reason = 'changed-source';
    else if (!current || serialize(current) !== serialize(old)) reason = 'ineligible';
    if (reason) invalidEntries.push({ source, index, reason });
    else {
      debt.push({ finding: current, source, index });
      adopted.add(current.id);
    }
  }
  return result({
    schemaVersion: 1,
    activeFindings: input.findings.filter(finding => !adopted.has(finding.id)),
    debt,
    invalidEntries,
  });
}

// Validation of rule semantics belongs to B. D checks the wire shape and paths
// it consumes, compares the entire policy, and never imports its sibling stages.
function validatePolicy(policy) {
  if (policy === null) return;
  if (
    !exact(policy, policyKeys) ||
    policy.schemaVersion !== 1 ||
    !Number.isSafeInteger(policy.version) ||
    policy.version < 1 ||
    policy.cycles !== 'forbid' ||
    !object(policy.layers)
  )
    fail();
  if (!paths(policy.productRoots).length) fail();
  paths(policy.protectedPaths);
  relative(policy.contracts);
  for (const module of list(policy.modules, 256)) {
    if (!exact(module, ['id', 'roots', 'layer', 'public', 'allow']) || !text(module.id) || !text(module.layer)) fail();
    paths(module.roots);
    paths(module.public);
    if (!list(module.allow, 256).every(text)) fail();
  }
  for (const [layer, allowed] of Object.entries(policy.layers)) {
    if (!text(layer) || !list(allowed, 256).every(text)) fail();
  }
  for (const rule of list(policy.forbiddenImports, 100000)) {
    if (!exact(rule, ['from', 'to']) || !text(rule.from) || !text(rule.to)) fail();
  }
  for (const key of ['baseline', 'exceptions']) {
    // Invalid waiver entries are reported by applyArchitectureDebt, not silently
    // discarded here. Comparison still includes their exact content.
    list(policy[key], FINDING_LIMIT);
  }
  serialize(policy);
}
const within = (file, prefix) => file === prefix || file.startsWith(prefix + '/');
function builtinProtection(file) {
  return (
    file === 'architecture.policy.json' ||
    file === 'architecture.contracts.json' ||
    within(file, '.github/workflows') ||
    within(file, '.github/actions') ||
    /(?:^|\/)(?:\.gitlab-ci\.ya?ml|azure-pipelines\.ya?ml|Jenkinsfile)$/.test(file) ||
    /^(?:runtime|scripts)\/ci(?:[./-]|$)/.test(file) ||
    /(?:^|\/)(?:golden|__snapshots__)(?:\/|$)/.test(file) ||
    /(?:^|\/)[^/]+(?:\.golden(?:\.[^/]+)?|\.snap)$/.test(file) ||
    within(file, 'tests/fixtures') ||
    /(?:^|\/)(?:package\.json|package-lock\.json|npm-shrinkwrap\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb?|\.node-version|\.nvmrc|\.tool-versions)$/.test(
      file,
    ) ||
    [
      'registry.json',
      'third-party-skills.lock.json',
      'runtime/tool-catalog.json',
      'runtime/toolchains.mjs',
      'runtime/quality-tool-registry.mjs',
      'runtime/tool-registry.mjs',
    ].includes(file)
  );
}

/** Old protection remains effective even when head deletes its declaration. */
export function evaluateArchitectureProtection(input) {
  if (!exact(input, ['basePolicy', 'headPolicy', 'changedPaths'])) fail();
  const { basePolicy, headPolicy } = input;
  validatePolicy(basePolicy);
  validatePolicy(headPolicy);
  const changed = paths(input.changedPaths),
    reviewPaths = new Set();
  if (serialize(basePolicy) !== serialize(headPolicy)) reviewPaths.add('architecture.policy.json');
  const protectedPaths = [basePolicy, headPolicy]
    .filter(policy => policy !== null)
    .flatMap(policy => [policy.contracts, ...policy.protectedPaths]);
  for (const file of changed) {
    if (builtinProtection(file) || protectedPaths.some(prefix => within(file, prefix))) reviewPaths.add(file);
  }
  const required = reviewPaths.size > 0;
  return result({
    schemaVersion: 1,
    requiresReview: required,
    fullVerificationRequired: required,
    reviewPaths: sortedUnique([...reviewPaths]),
  });
}
