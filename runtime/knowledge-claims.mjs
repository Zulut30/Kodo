import { createHash } from 'node:crypto';

const domains = ['domain', 'product', 'technical', 'codebase'];
const candidateKeys = ['domain', 'subject', 'key', 'value', 'versions', 'synthetic', 'source', 'confidence', 'unknowns'];
const storedKeys = [...candidateKeys, 'id', 'fingerprint', 'schemaVersion', 'projectKey', 'captureId', 'revision', 'observedAt'];
const digest = /^[a-f0-9]{64}$/;
const head = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const defaults = { schemaVersion: 1, mode: 'off', sourcePaths: [], allowedOrigins: [], maxRequests: 0,
  ttlSeconds: { domain: 86400, product: 86400, technical: 604800, codebase: 3600 }, maxClaims: 200, maxEvidenceBytes: 1048576, maxContextBytes: 2048 };

function fail(code = 'knowledge_schema') {
  // No input values (particularly URL credentials) enter diagnostics.
  throw Object.assign(new Error('Invalid knowledge data'), { code });
}
function record(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) fail();
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (typeof key !== 'string' || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) fail();
  }
  return value;
}
function shape(value, keys) {
  record(value);
  if (Object.keys(value).length !== keys.length || keys.some(key => !Object.hasOwn(value, key))) fail();
}
function text(value, max = 4096) {
  if (typeof value !== 'string' || !value.trim() || value.length > max || !value.isWellFormed() || /[\x00-\x1f\x7f]/.test(value)) fail();
  return value;
}
function integer(value, min, max) {
  if (!Number.isSafeInteger(value) || value < min || value > max) fail('knowledge_limit');
  return value;
}
function array(value, max) {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length > max || Reflect.ownKeys(value).length !== value.length + 1) fail('knowledge_limit');
  for (let i = 0; i < value.length; i++) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(i));
    if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) fail();
  }
  return value;
}
// Canonical JSON sorts even integer-looking object keys lexically; array order is data.
function canonical(value) {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}';
  return JSON.stringify(value);
}
const hash = value => createHash('sha256').update(canonical(value)).digest('hex');
function jsonValue(value) {
  let nodes = 0;
  const ancestors = new Set();
  function visit(item, depth) {
    if (++nodes > 10000 || depth > 12) fail('knowledge_limit');
    if (item === null || typeof item === 'boolean' || typeof item === 'number' && Number.isFinite(item)) return;
    if (typeof item === 'string') { if (!item.isWellFormed() || Buffer.byteLength(item) > 262144) fail('knowledge_limit'); return; }
    if (typeof item !== 'object' || ancestors.has(item)) fail();
    ancestors.add(item);
    if (Array.isArray(item)) { array(item, 10000); for (const entry of item) visit(entry, depth + 1); }
    else { record(item); for (const key of Object.keys(item)) { if (!key.isWellFormed() || Buffer.byteLength(key) > 262144) fail('knowledge_limit'); visit(item[key], depth + 1); } }
    ancestors.delete(item);
  }
  visit(value, 0);
  const serialized = canonical(value);
  if (Buffer.byteLength(serialized) > 262144) fail('knowledge_limit');
  return JSON.parse(serialized);
}
function timestamp(value, nullable = true) {
  if (nullable && value === null) return null;
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) fail();
  const time = Date.parse(value);
  if (!Number.isFinite(time) || new Date(time).toISOString() !== value) fail();
  return value;
}
function relative(value) {
  text(value);
  if (/[\\:*?{}\[\]<>|%#]/.test(value) || value.split('/').some(part => !part || part === '.' || part === '..' || /[. ]$/.test(part) || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) fail('knowledge_path');
  return value;
}
function origin(value) {
  text(value, 2048);
  let parsed; try { parsed = new URL(value); } catch { fail(); }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.origin !== value) fail();
  return value;
}
function versions(value) {
  record(value);
  if (Object.keys(value).length > 16) fail('knowledge_limit');
  return Object.fromEntries(Object.keys(value).sort().map(key => [text(key, 128), text(value[key], 128)]));
}

/** Strict policy normalization. Missing policy alone means disabled defaults. */
export function validateResearchPolicy(value = undefined) {
  if (value === undefined) return structuredClone(defaults);
  shape(value, Object.keys(defaults));
  if (value.schemaVersion !== 1 || !['off', 'local-only', 'on-demand', 'milestone'].includes(value.mode)) fail();
  shape(value.ttlSeconds, domains);
  const sourcePaths = array(value.sourcePaths, 1000).map(relative);
  const allowedOrigins = array(value.allowedOrigins, 1000).map(origin);
  if (new Set(sourcePaths).size !== sourcePaths.length || new Set(allowedOrigins).size !== allowedOrigins.length) fail();
  return { schemaVersion: 1, mode: value.mode, sourcePaths: sourcePaths.sort(), allowedOrigins: allowedOrigins.sort(),
    maxRequests: integer(value.maxRequests, 0, Number.MAX_SAFE_INTEGER),
    ttlSeconds: Object.fromEntries(domains.map(domain => [domain, integer(value.ttlSeconds[domain], 1, 31536000)])),
    maxClaims: integer(value.maxClaims, 1, 1000), maxEvidenceBytes: integer(value.maxEvidenceBytes, 1, 1048576), maxContextBytes: integer(value.maxContextBytes, 128, 4096) };
}

/** URL metadata is never fetched. Rejection returns reason codes, never raw input. */
export function sanitizeKnowledgeUrl(value, { allowedOrigins = [] } = {}) {
  const allow = new Set(array(allowedOrigins, 1000).map(origin));
  if (value === null) return { url: null, unknowns: [] };
  const reject = reason => ({ url: null, unknowns: [reason] });
  if (typeof value !== 'string' || value.length > 4096 || !value.isWellFormed() || /[\x00-\x20\x7f\\]/.test(value)) return reject('unsafe_url');
  let parsed; try { parsed = new URL(value); } catch { return reject('unsafe_url'); }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || /^https:\/\/[^/]*@/i.test(value) || !allow.has(parsed.origin)) return reject('unsafe_url');
  if (value.split('#', 1)[0].includes('?')) {
    const entries = [...parsed.searchParams];
    if (parsed.origin !== 'https://news.ycombinator.com' || parsed.pathname !== '/item' || entries.length !== 1 || entries[0][0] !== 'id' || !/^\d+$/.test(entries[0][1])) return reject('unsupported_url_query');
  }
  if (parsed.hash && !/^#[A-Za-z][A-Za-z0-9_.:-]{0,127}$/.test(parsed.hash)) return reject('unsafe_url_anchor');
  return { url: parsed.href, unknowns: [] };
}

/** Caller supplies canonical project identity. This module performs no I/O. */
export function normalizeClaim(input) {
  shape(input, ['projectKey', ...candidateKeys]);
  text(input.projectKey);
  if (!domains.includes(input.domain) || typeof input.synthetic !== 'boolean') fail();
  const claimVersions = versions(input.versions);
  if (input.domain !== 'codebase' && Object.hasOwn(claimVersions, 'headSha')) fail();
  shape(input.source, ['id', 'kind', 'url', 'path', 'pointer', 'retrievedAt', 'validAsOf', 'evidenceRef']);
  const s = input.source;
  if (!['local', 'discovery'].includes(s.kind)) fail();
  let url = null;
  if (s.url !== null) {
    if (typeof s.url !== 'string') fail('knowledge_url');
    let allowedOrigin; try { allowedOrigin = new URL(s.url).origin; } catch { fail(); }
    const sanitized = sanitizeKnowledgeUrl(s.url, { allowedOrigins: [allowedOrigin] });
    if (sanitized.url === null) fail('knowledge_url');
    url = sanitized.url;
  }
  if (s.path !== null) relative(s.path);
  if (s.pointer !== null && (typeof s.pointer !== 'string' || s.pointer.length > 2048 || !s.pointer.isWellFormed() || /[\x00-\x1f\x7f]/.test(s.pointer) || !(s.pointer === '' || s.pointer === '$sha256' || s.pointer === '$exports' || s.pointer.startsWith('/') && !/~(?:[^01]|$)/.test(s.pointer)))) fail();
  if (s.kind === 'local' && (s.path === null || s.pointer === null)) fail();
  shape(s.evidenceRef, ['path', 'bytes', 'sha256']);
  if (typeof s.evidenceRef.sha256 !== 'string' || !digest.test(s.evidenceRef.sha256)) fail();
  if (input.confidence !== null && (typeof input.confidence !== 'number' || !Number.isFinite(input.confidence) || input.confidence < 0 || input.confidence > 1)) fail();
  const candidate = { domain: input.domain, subject: text(input.subject, 128), key: text(input.key, 128), value: jsonValue(input.value),
    versions: claimVersions, synthetic: input.synthetic,
    source: { id: text(s.id, 128), kind: s.kind, url, path: s.path, pointer: s.pointer, retrievedAt: timestamp(s.retrievedAt), validAsOf: timestamp(s.validAsOf),
      evidenceRef: { path: text(s.evidenceRef.path), bytes: integer(s.evidenceRef.bytes, 1, 1048576), sha256: s.evidenceRef.sha256 } },
    confidence: input.confidence, unknowns: array(input.unknowns, 32).map(value => text(value, 200)) };
  return { ...candidate, id: hash([input.projectKey, candidate.domain, candidate.subject, candidate.key, candidate.versions, candidate.source.id, candidate.synthetic]), fingerprint: hash(candidate) };
}

export function evaluateClaims(input) {
  shape(input, ['claims', 'context', 'policy', 'now', 'evidenceChecks']);
  const policy = validateResearchPolicy(input.policy);
  array(input.claims, policy.maxClaims);
  const { context } = input;
  shape(context, ['schemaVersion', 'projectKey', 'versions', 'synthetic', 'headSha', 'contextHash', 'contextSource']);
  text(context.projectKey); versions(context.versions);
  if (context.schemaVersion !== 1 || typeof context.synthetic !== 'boolean' || typeof context.headSha !== 'string' || !head.test(context.headSha) || !['fixed', 'override', 'absent'].includes(context.contextSource) || Object.hasOwn(context.versions, 'headSha')) fail();
  if (context.contextHash !== hash({ projectKey: context.projectKey, versions: context.versions, synthetic: context.synthetic, headSha: context.headSha })) fail('knowledge_context');
  const now = Date.parse(timestamp(input.now, false));
  const evidence = input.evidenceChecks;
  shape(evidence, ['schemaVersion', 'items']);
  if (evidence.schemaVersion !== 1) fail();
  for (const item of array(evidence.items, 1000)) {
    shape(item, ['id', 'revision', 'evidenceHash', 'intact', 'sourceMatches']);
    if (typeof item.id !== 'string' || !digest.test(item.id) || typeof item.evidenceHash !== 'string' || !digest.test(item.evidenceHash) || typeof item.intact !== 'boolean' || typeof item.sourceMatches !== 'boolean') fail();
    integer(item.revision, 1, Number.MAX_SAFE_INTEGER);
  }
  const latest = new Map();
  let evidenceBytes = 0;
  for (const claim of input.claims) {
    shape(claim, storedKeys);
    if (claim.projectKey !== context.projectKey) fail('knowledge_project');
    if (claim.schemaVersion !== 1 || typeof claim.id !== 'string' || !digest.test(claim.id) || typeof claim.fingerprint !== 'string' || !digest.test(claim.fingerprint) || typeof claim.captureId !== 'string' || !/^[\w.-]{1,128}$/.test(claim.captureId)) fail();
    integer(claim.revision, 1, Number.MAX_SAFE_INTEGER); timestamp(claim.observedAt, false);
    const normalized = normalizeClaim({ projectKey: claim.projectKey, ...Object.fromEntries(candidateKeys.map(key => [key, claim[key]])) });
    evidenceBytes += normalized.source.evidenceRef.bytes;
    if (evidenceBytes > policy.maxEvidenceBytes) fail('knowledge_limit');
    const previous = latest.get(claim.id);
    if (previous && previous.claim.revision === claim.revision && canonical(previous.claim) !== canonical(claim)) fail('knowledge_revision');
    if (!previous || previous.claim.revision < claim.revision) latest.set(claim.id, { claim: structuredClone(claim), normalized });
  }
  const entries = [...latest.values()].sort((a, b) => a.claim.id < b.claim.id ? -1 : a.claim.id > b.claim.id ? 1 : 0);
  const groups = new Map();
  for (const entry of entries) {
    const { claim, normalized } = entry;
    entry.integrity = claim.id === normalized.id && claim.fingerprint === normalized.fingerprint &&
      canonical(Object.fromEntries(candidateKeys.map(key => [key, claim[key]]))) === canonical(Object.fromEntries(candidateKeys.map(key => [key, normalized[key]])));
    if (!entry.integrity) continue;
    entry.valueBytes = canonical(claim.value);
    const comparable = canonical([claim.projectKey, claim.domain, claim.subject, claim.key, claim.versions, claim.synthetic]);
    if (!groups.has(comparable)) groups.set(comparable, []);
    groups.get(comparable).push(entry);
  }
  const conflicts = new Map(entries.map(({ claim }) => [claim.id, new Set()]));
  for (const group of groups.values()) for (let i = 0; i < group.length; i++) for (let j = i + 1; j < group.length; j++) {
    const a = group[i].claim, b = group[j].claim;
    if (a.source.id !== b.source.id && group[i].valueBytes !== group[j].valueBytes) {
      conflicts.get(a.id).add(b.id); conflicts.get(b.id).add(a.id);
    }
  }
  const unknowns = new Set();
  const priority = ['invalidated', 'stale', 'conflicted', 'untrusted', 'unknown'];
  const rows = entries.map(({ claim, integrity }) => {
    const states = new Set(), reasons = new Set();
    const reason = (state, code) => { states.add(state); reasons.add(code); if (state === 'unknown') unknowns.add(code); };
    if (!integrity) reason('invalidated', 'claim_integrity');
    if (Date.parse(claim.observedAt) > now) reason('invalidated', 'observation_in_future');
    const currentVersions = claim.domain === 'codebase' ? { ...context.versions, headSha: context.headSha } : context.versions;
    if (!Object.keys(claim.versions).length || claim.domain === 'codebase' && !Object.hasOwn(claim.versions, 'headSha')) reason('unknown', 'missing_claim_versions');
    for (const [key, value] of Object.entries(claim.versions)) {
      if (!Object.hasOwn(currentVersions, key)) reason('unknown', 'missing_current_version:' + key);
      else if (currentVersions[key] !== value) reason('invalidated', 'version_mismatch:' + key);
    }
    if (claim.synthetic !== context.synthetic) reason('invalidated', 'synthetic_context_mismatch');
    const retrieved = claim.source.retrievedAt === null ? null : Date.parse(claim.source.retrievedAt);
    if (retrieved === null) reason('stale', 'missing_retrieved_at');
    else if (retrieved > now) reason('stale', 'retrieval_in_future');
    else if (now - retrieved >= policy.ttlSeconds[claim.domain] * 1000) reason('stale', 'ttl_expired');
    if (claim.source.validAsOf === null) reason('unknown', 'missing_valid_as_of');
    else if (Date.parse(claim.source.validAsOf) > now) reason('unknown', 'valid_as_of_in_future');
    const conflictIds = [...conflicts.get(claim.id)].sort();
    if (conflictIds.length) reason('conflicted', 'incompatible_values');
    const matched = evidence.items.filter(item => item.id === claim.id && item.revision === claim.revision);
    if (matched.length !== 1 || matched[0].evidenceHash !== claim.source.evidenceRef.sha256 || !matched[0].intact || !matched[0].sourceMatches) reason('untrusted', 'evidence_unverified');
    if (policy.mode === 'off') reason('untrusted', 'policy_off');
    // A kind, URL, hash or confidence label is provenance, never a fact checker.
    if (claim.source.kind !== 'local' || !claim.synthetic && claim.domain !== 'codebase') reason('untrusted', 'no_mechanical_verification');
    if (claim.unknowns.length) reason('unknown', 'claim_unknowns');
    for (const unknown of claim.unknowns) unknowns.add(unknown);
    const state = priority.find(value => states.has(value)) ?? 'fresh';
    const projection = state === 'fresh' ? claim.synthetic ? 'synthetic-reference' : 'local-observation' : null;
    return { claim, state, reasons: [...reasons].sort(), conflictIds, projection };
  });
  return { schemaVersion: 1, rows, unknowns: [...unknowns].sort() };
}
