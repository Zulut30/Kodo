import { measureContext } from './context-pack.mjs';

const states = ['invalidated', 'stale', 'conflicted', 'untrusted', 'unknown'];
const domains = ['domain', 'product', 'technical', 'codebase'];
const claimKeys = ['schemaVersion', 'projectKey', 'captureId', 'id', 'fingerprint', 'revision', 'observedAt', 'domain', 'subject', 'key', 'value', 'versions', 'synthetic', 'source', 'confidence', 'unknowns'];
const sourceKeys = ['id', 'kind', 'url', 'path', 'pointer', 'retrievedAt', 'validAsOf', 'evidenceRef'];
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const exact = (value, keys) => record(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const bounded = (value, max = 128) => typeof value === 'string' && value.trim().length > 0 && value.length <= max;
const hash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const positive = value => Number.isSafeInteger(value) && value > 0;
const strings = value => Array.isArray(value) && value.every(item => typeof item === 'string');
const utc = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
const size = value => measureContext(JSON.stringify(value));

// Accept JSON data only. Getters, toJSON hooks, exotic objects, cycles and
// nonfinite values must never execute or turn into different projected data.
// Sorting object keys also makes equality and tie-breaking insertion independent.
function jsonData(value, depth = 0, budget = { nodes: 0 }, ancestors = new Set()) {
  if (++budget.nodes > (budget.maxNodes ?? 10000) || depth > (budget.maxDepth ?? 12)) throw new TypeError('Invalid knowledge JSON data');
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value !== 'object' || ancestors.has(value)) throw new TypeError('Invalid knowledge JSON data');
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null && prototype !== Array.prototype) throw new TypeError('Invalid knowledge JSON data');
  if (!Array.isArray(value) && prototype === Array.prototype) throw new TypeError('Invalid knowledge JSON data');
  const keys = Reflect.ownKeys(value);
  const allowed = Array.isArray(value) ? keys.filter(key => key !== 'length') : keys;
  if (allowed.some(key => typeof key !== 'string')) throw new TypeError('Invalid knowledge JSON data');
  if (Array.isArray(value) && (allowed.length !== value.length || allowed.some((key, index) => key !== String(index)))) throw new TypeError('Invalid knowledge JSON data');
  const entries = [];
  ancestors.add(value);
  try {
    for (const key of Array.isArray(value) ? allowed : allowed.sort()) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) throw new TypeError('Invalid knowledge JSON data');
      entries.push([key, jsonData(descriptor.value, depth + 1, budget, ancestors)]);
    }
  } finally { ancestors.delete(value); }
  return Array.isArray(value) ? entries.map(([, item]) => item) : Object.fromEntries(entries);
}

function versions(value) {
  return record(value) && Object.keys(value).length <= 16 && Object.entries(value).every(([key, item]) => bounded(key) && bounded(item));
}

function evidence(value) {
  return exact(value, ['path', 'bytes', 'sha256']) && bounded(value.path, 4096) && positive(value.bytes) && value.bytes <= 1048576 && hash(value.sha256);
}

function validReference(row) {
  if (!exact(row, ['claim', 'state', 'reasons', 'conflictIds', 'projection']) || !strings(row.reasons) || row.reasons.length || !Array.isArray(row.conflictIds) || row.conflictIds.length) return false;
  const claim = row.claim;
  if (!exact(claim, claimKeys) || claim.schemaVersion !== 1 || !bounded(claim.projectKey, 4096) || !bounded(claim.captureId) || !utc(claim.observedAt) || !hash(claim.fingerprint)) return false;
  if (!bounded(claim.subject) || !strings(claim.unknowns) || claim.unknowns.length || !(claim.confidence === null || typeof claim.confidence === 'number' && claim.confidence >= 0 && claim.confidence <= 1)) return false;
  const source = claim.source;
  if (!exact(source, sourceKeys) || !bounded(source.id) || !['local', 'discovery'].includes(source.kind) || ![source.url, source.path, source.pointer].every(item => item === null || bounded(item, 4096)) || ![source.retrievedAt, source.validAsOf].every(item => item === null || utc(item))) return false;
  if (!hash(claim.id) || !positive(claim.revision) || !domains.includes(claim.domain) || !bounded(claim.key) || !versions(claim.versions) || typeof claim.synthetic !== 'boolean' || !evidence(source.evidenceRef) || size(claim.value) > 262144) return false;
  try { jsonData(claim.value); } catch { return false; }
  if (row.projection === 'local-observation') {
    return !claim.synthetic && claim.domain === 'codebase' && source.kind === 'local';
  }
  return row.projection === 'synthetic-reference' && claim.synthetic;
}

function reference({ claim, projection }) {
  return { kind: projection, id: claim.id, revision: claim.revision,
    domain: claim.domain, key: claim.key, value: claim.value,
    versions: claim.versions, synthetic: claim.synthetic, evidenceRef: claim.source.evidenceRef };
}

const words = text => new Set(text.toLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? []);
function taskWords(task) {
  if (typeof task === 'string') return words(task);
  if (!record(task)) return new Set();
  const data = jsonData(task);
  const text = [data.id, data.description, ...(Array.isArray(data.acceptance) ? data.acceptance : []), ...(Array.isArray(data.writePaths) ? data.writePaths : [])].filter(value => typeof value === 'string').join(' ');
  return words(text);
}

/**
 * Pure optional-context projection. The evaluator owns freshness, provenance and
 * context binding; this boundary projects its kind marker and validated claim.
 * References remain untrusted JSON data. No source text becomes instructions.
 * unknownCounts counts excluded rows by state (or malformed), while omitted
 * records only byte-budget losses, using the existing context-pack convention.
 */
export function projectKnowledge({ evaluation, task = '', maxBytes = 2048 } = {}) {
  if (!positive(maxBytes)) throw Object.assign(new RangeError('Knowledge context byte budget must be a positive safe integer'), { code: 'context_budget' });
  if (!exact(evaluation, ['schemaVersion', 'rows', 'unknowns']) || evaluation.schemaVersion !== 1 || !Array.isArray(evaluation.rows)) throw new TypeError('Invalid knowledge evaluation');
  const tokens = taskWords(task), candidates = [], counts = {};
  const addCount = key => { counts[key] = (counts[key] ?? 0) + 1; };
  for (const input of evaluation.rows) {
    let row;
    // The evaluation envelope must not consume the per-value depth/node allowance.
    try { row = jsonData(input, 0, { nodes: 0, maxNodes: 11000, maxDepth: 14 }); } catch { addCount('malformed'); continue; }
    if (states.includes(row?.state)) { addCount(row.state); continue; }
    if (row?.state !== 'fresh' || !validReference(row)) { addCount('malformed'); continue; }
    const searchable = words([row.claim.subject, row.claim.key, row.claim.domain, row.claim.source.path ?? ''].join(' '));
    const score = [...tokens].filter(token => searchable.has(token)).length;
    candidates.push({ reference: reference(row), score });
  }
  const lexical = (left, right) => left < right ? -1 : left > right ? 1 : 0;
  candidates.sort((left, right) => right.score - left.score || lexical(left.reference.id, right.reference.id) || right.reference.revision - left.reference.revision || lexical(JSON.stringify(left.reference), JSON.stringify(right.reference)));
  const unknownCounts = Object.fromEntries([...states, 'malformed'].filter(key => counts[key]).map(key => [key, counts[key]]));
  const result = { schemaVersion: 1, references: [], unknownCounts, omitted: [] };
  const setOmitted = () => {
    const count = candidates.length - result.references.length;
    result.omitted = count ? [{ field: 'references', items: count }] : [];
  };
  // Count omission metadata before selection; try every whole item so an early
  // oversized record does not prevent a later smaller relevant item fitting.
  setOmitted();
  for (const candidate of candidates) {
    result.references.push(candidate.reference);
    setOmitted();
    if (size(result) > maxBytes) {
      result.references.pop();
      setOmitted();
    }
  }
  if (size(result) > maxBytes) throw Object.assign(new RangeError('Knowledge context byte budget cannot retain mandatory metadata'), { code: 'context_budget' });
  return result;
}
