import path from 'node:path';
import { createHash } from 'node:crypto';
import { open, lstat, realpath } from 'node:fs/promises';
import { isDeepStrictEqual } from 'node:util';
import { git } from './workspace.mjs';
import { redact, secretFile, workerEnvironment } from './security.mjs';

const domains = ['domain', 'product', 'technical', 'codebase'];
const defaults = () => ({
  schemaVersion: 1,
  mode: 'off',
  sourcePaths: [],
  allowedOrigins: [],
  maxRequests: 0,
  ttlSeconds: { domain: 86400, product: 86400, technical: 604800, codebase: 3600 },
  maxClaims: 200,
  maxEvidenceBytes: 1048576,
  maxContextBytes: 2048,
});
const hashBytes = value => createHash('sha256').update(value).digest('hex');
// Match claims/Store exactly, including lexical ordering of integer-looking keys.
function canonical(value) {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object')
    return (
      '{' +
      Object.keys(value)
        .sort()
        .map(key => JSON.stringify(key) + ':' + canonical(value[key]))
        .join(',') +
      '}'
    );
  return JSON.stringify(value);
}
const hash = value => hashBytes(canonical(value));
const identity = value => (process.platform === 'win32' ? value.toLowerCase() : value);
const fail = (code, file = null) => {
  throw Object.assign(new Error(code), { knowledgeCode: code, file });
};
const record = value => value && typeof value === 'object' && !Array.isArray(value);
function keys(value, expected, file) {
  if (!record(value) || !isDeepStrictEqual(Object.keys(value).sort(), [...expected].sort()))
    fail('knowledge_schema', file);
}
function boundedString(value, max = 128) {
  return typeof value === 'string' && value.length > 0 && value.length <= max && !/[\x00-\x1f]/.test(value);
}
function relative(value) {
  if (
    !boundedString(value, 512) ||
    /[\\:%*?<>|"\x7f]/.test(value) ||
    path.isAbsolute(value) ||
    value
      .split('/')
      .some(
        part =>
          !part ||
          part === '.' ||
          part === '..' ||
          /[. ]$/.test(part) ||
          secretFile(part) ||
          /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part),
      ) ||
    /(?:^|\/)(?:\.git|\.ssh|\.aws|\.codex|\.claude|node_modules)(?:\/|$)/i.test(value) ||
    secretFile(value)
  )
    fail('knowledge_path');
  return value;
}
function inside(root, target) {
  const rel = path.relative(root, target);
  return rel === '' || (!path.isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${path.sep}`));
}
async function noLinks(root, target, missing = false) {
  if (!inside(root, target)) fail('knowledge_path');
  let current = root;
  const parts = path.relative(root, target).split(path.sep).filter(Boolean);
  for (let i = -1; i < parts.length; i++) {
    if (i >= 0) current = path.join(current, parts[i]);
    let stat;
    try {
      stat = await lstat(current);
    } catch (error) {
      if (missing && error.code === 'ENOENT') return;
      throw error;
    }
    if (stat.isSymbolicLink() || (stat.isFile() && stat.nlink !== 1) || (i < parts.length - 1 && !stat.isDirectory()))
      fail('knowledge_path');
  }
}
function clean(value, secrets = {}) {
  const known = Object.values(secrets).filter(secret => typeof secret === 'string' && secret.length > 0);
  // Inspect decoded strings and keys: JSON escaping can hide even short known
  // credentials from a substring check on serialized bytes.
  function inspect(item) {
    if (typeof item === 'string') {
      if (known.some(secret => item.includes(secret))) fail('knowledge_secret');
    } else if (item && typeof item === 'object') {
      for (const [key, child] of Object.entries(item)) {
        inspect(key);
        inspect(child);
      }
    }
  }
  inspect(value);
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  if (redact(text, secrets) !== text) fail('knowledge_secret');
  return value;
}
function jsonValue(value) {
  let nodes = 0;
  function walk(item, depth) {
    if (++nodes > 10000 || depth > 12) fail('knowledge_limit');
    if (
      item === null ||
      typeof item === 'boolean' ||
      typeof item === 'string' ||
      (typeof item === 'number' && Number.isFinite(item))
    )
      return;
    if (!Array.isArray(item) && !record(item)) fail('knowledge_schema');
    for (const child of Object.values(item)) walk(child, depth + 1);
  }
  walk(value, 0);
  if (Buffer.byteLength(JSON.stringify(value)) > 262144) fail('knowledge_limit');
}
async function readOwned(root, filename, limit, secrets, optional = false) {
  relative(filename);
  const target = path.join(root, filename);
  try {
    await noLinks(root, target);
    const handle = await open(target, 'r');
    try {
      const before = await handle.stat();
      if (!before.isFile() || before.nlink !== 1 || before.size > limit) fail('knowledge_limit', filename);
      const bytes = Buffer.alloc(Math.min(limit + 1, before.size + 1));
      let size = 0;
      while (size < bytes.length) {
        const result = await handle.read(bytes, size, bytes.length - size, size);
        if (!result.bytesRead) break;
        size += result.bytesRead;
      }
      const after = await handle.stat(),
        current = await lstat(target);
      if (
        size !== before.size ||
        size > limit ||
        before.size !== after.size ||
        before.mtimeMs !== after.mtimeMs ||
        before.ino !== current.ino ||
        before.dev !== current.dev ||
        current.isSymbolicLink() ||
        current.nlink !== 1
      )
        fail('knowledge_source_changed', filename);
      const data = bytes.subarray(0, size);
      await noLinks(root, target);
      clean(data.toString('utf8'), secrets);
      return data;
    } finally {
      await handle.close();
    }
  } catch (error) {
    if (optional && error.code === 'ENOENT') return null;
    throw error;
  }
}
function parse(bytes, file) {
  try {
    const value = JSON.parse(bytes.toString('utf8'));
    jsonValue(value);
    return value;
  } catch (error) {
    if (error.knowledgeCode) throw error;
    fail('knowledge_json', file);
  }
}
function versions(value, allowHead = false) {
  if (
    !record(value) ||
    Object.keys(value).length > 16 ||
    Object.entries(value).some(
      ([key, val]) =>
        !boundedString(key) || !boundedString(val) || key === 'projectKey' || (key === 'headSha' && !allowHead),
    )
  )
    fail('knowledge_versions');
}
function policyValue(value) {
  keys(value, Object.keys(defaults()), 'research.policy.json');
  if (
    value.schemaVersion !== 1 ||
    !['off', 'local-only', 'on-demand', 'milestone'].includes(value.mode) ||
    !Number.isInteger(value.maxRequests) ||
    value.maxRequests < 0 ||
    value.maxRequests > 1000
  )
    fail('knowledge_policy');
  for (const [key, low, high] of [
    ['maxClaims', 1, 1000],
    ['maxEvidenceBytes', 1, 1048576],
    ['maxContextBytes', 128, 4096],
  ])
    if (!Number.isInteger(value[key]) || value[key] < low || value[key] > high) fail('knowledge_policy');
  keys(value.ttlSeconds, domains);
  if (Object.values(value.ttlSeconds).some(item => !Number.isInteger(item) || item < 1 || item > 31536000))
    fail('knowledge_policy');
  if (
    !Array.isArray(value.sourcePaths) ||
    value.sourcePaths.length > 200 ||
    !Array.isArray(value.allowedOrigins) ||
    value.allowedOrigins.length > 200
  )
    fail('knowledge_policy');
  value.sourcePaths.forEach(relative);
  for (const origin of value.allowedOrigins) {
    let url;
    try {
      url = new URL(origin);
    } catch {
      fail('knowledge_policy');
    }
    if (url.protocol !== 'https:' || url.origin !== origin || url.username || url.password) fail('knowledge_policy');
  }
  return value;
}
async function snapshot(cwd) {
  const root = await realpath(cwd);
  const options = { env: workerEnvironment(), timeoutMs: 10000 };
  if (identity(await realpath(await git(root, ['rev-parse', '--show-toplevel'], options))) !== identity(root))
    fail('knowledge_snapshot');
  const head = await git(root, ['rev-parse', 'HEAD'], options);
  // As in ci-graph, status must not invoke a repository's clean/process
  // filters. Read driver names only, never commands or credential values.
  const config = await git(
    root,
    ['config', '--null', '--name-only', '--get-regexp', '^filter\\..*\\.(clean|smudge|process|required)$'],
    { ...options, allowFailure: true },
  );
  const names = config.split('\0').filter(Boolean);
  if (config.length > 65536 || names.length > 256) fail('knowledge_snapshot');
  const drivers = [
    ...new Set(
      names.map(name => {
        const match = /^(filter\.[^\x00-\x20=\x7f]+)\.(?:clean|smudge|process|required)$/i.exec(name);
        if (!match) fail('knowledge_snapshot');
        return match[1];
      }),
    ),
  ];
  const suppress = drivers.flatMap(driver =>
    ['clean', 'smudge', 'process', 'required'].flatMap(key => [
      '-c',
      `${driver}.${key}=${key === 'required' ? 'false' : ''}`,
    ]),
  );
  if (
    !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(head) ||
    (await git(root, [...suppress, 'status', '--porcelain=v1', '--untracked-files=all'], options))
  )
    fail('knowledge_snapshot');
  return { root, head };
}
async function tracked(root, file) {
  const row = await git(root, ['ls-tree', '-z', '--full-tree', 'HEAD', '--', relative(file)], {
    env: workerEnvironment(),
    timeoutMs: 10000,
  });
  const match = /^(?:100644|100755) blob ([a-f0-9]{40}(?:[a-f0-9]{24})?)\t([^\0]+)\0$/.exec(row);
  if (!match || match[2] !== file) fail('knowledge_untracked', file);
  return match[1];
}
function assertTrackedBytes(bytes, oid) {
  const blobHash = data =>
    createHash(oid.length === 40 ? 'sha1' : 'sha256')
      .update(`blob ${data.length}\0`)
      .update(data)
      .digest('hex');
  if (blobHash(bytes) === oid) return;
  // Preserve the existing ci-graph/security-gates CRLF checkout compatibility,
  // without invoking Git filters or trusting index assume/skip flags.
  const text = bytes.toString('utf8');
  if (!Buffer.from(text).equals(bytes) || blobHash(Buffer.from(text.replaceAll('\r\n', '\n'))) !== oid)
    fail('knowledge_snapshot');
}
export async function loadKnowledgeContext({ project, snapshotCwd = project, contextPath = null }, ports = {}) {
  const root = await realpath(project);
  const policyBytes = await readOwned(root, 'research.policy.json', 65536, {}, true);
  const policy = policyBytes ? policyValue(parse(policyBytes, 'research.policy.json')) : defaults();
  if (policy.mode === 'off') return { policy, context: null };
  // Native ownership checks belong after the default-off exit and before Git.
  await ports.assertSnapshotOwnership?.();
  const secrets = ports.secrets || {};
  clean(policy, secrets);
  const file = contextPath === null ? 'research.context.json' : relative(contextPath);
  const bytes = await readOwned(root, file, 16384, secrets, contextPath === null);
  const metadata = bytes ? parse(bytes, file) : { schemaVersion: 1, versions: {}, synthetic: false };
  clean(metadata, secrets);
  keys(metadata, ['schemaVersion', 'versions', 'synthetic'], file);
  if (metadata.schemaVersion !== 1 || typeof metadata.synthetic !== 'boolean') fail('knowledge_context', file);
  versions(metadata.versions);
  const source = await snapshot(snapshotCwd),
    projectKey = identity(root);
  if (policyBytes) assertTrackedBytes(policyBytes, await tracked(root, 'research.policy.json'));
  if (bytes) assertTrackedBytes(bytes, await tracked(root, file));
  const context = {
    schemaVersion: 1,
    projectKey,
    versions: metadata.versions,
    synthetic: metadata.synthetic,
    headSha: source.head,
    contextHash: hash({ projectKey, versions: metadata.versions, synthetic: metadata.synthetic, headSha: source.head }),
    contextSource: bytes ? (contextPath === null ? 'fixed' : 'override') : 'absent',
  };
  return { policy, context };
}

function timestamp(value, nullable = true) {
  if (nullable && value === null) return;
  if (
    typeof value !== 'string' ||
    !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value) ||
    !Number.isFinite(Date.parse(value)) ||
    new Date(value).toISOString() !== value
  )
    fail('knowledge_timestamp');
}
function validateInput(value, policy) {
  keys(value, ['schemaVersion', 'captureId', 'synthetic', 'claims']);
  if (
    value.schemaVersion !== 1 ||
    typeof value.captureId !== 'string' ||
    !/^[\w.-]{1,128}$/.test(value.captureId) ||
    typeof value.synthetic !== 'boolean' ||
    !Array.isArray(value.claims) ||
    value.claims.length > policy.maxClaims ||
    value.claims.length === 0
  )
    fail('knowledge_input');
  for (const claim of value.claims) {
    keys(claim, ['domain', 'subject', 'key', 'value', 'versions', 'source', 'confidence', 'unknowns']);
    if (
      !domains.includes(claim.domain) ||
      !boundedString(claim.subject) ||
      !boundedString(claim.key) ||
      (claim.confidence !== null &&
        (typeof claim.confidence !== 'number' ||
          !Number.isFinite(claim.confidence) ||
          claim.confidence < 0 ||
          claim.confidence > 1)) ||
      !Array.isArray(claim.unknowns) ||
      claim.unknowns.length > 32 ||
      claim.unknowns.some(item => !boundedString(item, 200))
    )
      fail('knowledge_input');
    jsonValue(claim.value);
    versions(claim.versions, claim.domain === 'codebase');
    keys(claim.source, ['id', 'kind', 'url', 'path', 'pointer', 'retrievedAt', 'validAsOf']);
    const source = claim.source;
    if (
      !boundedString(source.id) ||
      !['local', 'discovery'].includes(source.kind) ||
      (source.url !== null && !boundedString(source.url, 2048))
    )
      fail('knowledge_source');
    timestamp(source.retrievedAt);
    timestamp(source.validAsOf);
    if (source.kind === 'local') {
      relative(source.path);
      if (!policy.sourcePaths.some(allowed => source.path === allowed || source.path.startsWith(allowed + '/')))
        fail('knowledge_path');
      if (
        typeof source.pointer !== 'string' ||
        source.pointer.length > 512 ||
        (!['$sha256', '$exports', ''].includes(source.pointer) && !source.pointer.startsWith('/'))
      )
        fail('knowledge_selector');
    } else if (source.path !== null || source.pointer !== null) fail('knowledge_source');
  }
}
async function selection(bytes, source) {
  if (source.pointer === '$sha256') return hashBytes(bytes);
  if (source.pointer === '$exports') {
    if (!/\.(?:mjs|js)$/.test(source.path)) fail('knowledge_selector');
    const { inspectJavaScriptModule } = await import('./javascript-dependencies.mjs');
    const observation = inspectJavaScriptModule({ file: source.path, source: bytes.toString('utf8') });
    if (observation.unsupported.length) fail('knowledge_selector');
    return observation.exports;
  }
  let value = parse(bytes, source.path);
  if (source.pointer === '') return value;
  if (!source.pointer.startsWith('/')) fail('knowledge_selector');
  for (const raw of source.pointer.slice(1).split('/')) {
    if (/~(?![01])/.test(raw)) fail('knowledge_selector');
    const key = raw.replace(/~1/g, '/').replace(/~0/g, '~');
    if (
      (!record(value) && !Array.isArray(value)) ||
      (Array.isArray(value) && !/^(?:0|[1-9]\d*)$/.test(key)) ||
      !Object.hasOwn(value, key)
    )
      fail('knowledge_selector');
    value = value[key];
  }
  return value;
}
async function evidenceAdapter(ports, store) {
  if (ports.writeEvidence && ports.assertEvidence) return { write: ports.writeEvidence, assert: ports.assertEvidence };
  // Construct only the existing evidence boundary, never openEngine, credentials,
  // subscription clients or providers. Import is deferred until an enabled call.
  const { Engine } = await import('./engine.mjs');
  const engine = new Engine({ store, secrets: ports.secrets || {} });
  return {
    write: ports.writeEvidence || engine.persistEvidence.bind(engine),
    assert: ports.assertEvidence || engine.assertEvidence.bind(engine),
  };
}
async function absoluteNoLinks(target, missing = false) {
  await noLinks(path.parse(path.resolve(target)).root, path.resolve(target), missing);
}
async function evidenceDirectory(home, project, snapshotRoot) {
  await absoluteNoLinks(home);
  const root = path.join(await realpath(home), 'knowledge-evidence');
  if (inside(project, root) || inside(snapshotRoot, root)) fail('knowledge_evidence_path');
  await absoluteNoLinks(root, true);
  // A store nested in any other repository is not an outside-Git evidence home.
  const gitRoot = await git(home, ['rev-parse', '--show-toplevel'], {
    env: workerEnvironment(),
    timeoutMs: 10000,
  }).catch(() => null);
  if (gitRoot) fail('knowledge_evidence_path');
  return root;
}
function envelopeValue(projectKey, source, value) {
  const { id, kind, url, path: filename, pointer } = source;
  return { schemaVersion: 1, projectKey, source: { id, kind, url, path: filename, pointer }, value };
}
async function verifyReference(ref, { root, projectKey, source, value, headSha, adapter, limit }) {
  keys(ref, ['path', 'bytes', 'sha256']);
  if (
    typeof ref.path !== 'string' ||
    !path.isAbsolute(ref.path) ||
    !inside(root, ref.path) ||
    !Number.isInteger(ref.bytes) ||
    ref.bytes < 1 ||
    ref.bytes > limit ||
    !/^[a-f0-9]{64}$/.test(ref.sha256) ||
    path.basename(ref.path) !== `knowledge-${ref.sha256}.json`
  )
    fail('knowledge_evidence');
  await absoluteNoLinks(ref.path);
  const relativePath = path.relative(root, ref.path).split(path.sep).join('/');
  const bytes = await readOwned(root, relativePath, limit, {});
  if (bytes.length !== ref.bytes || hashBytes(bytes) !== ref.sha256) fail('knowledge_evidence');
  const envelope = parse(bytes, relativePath);
  keys(envelope, ['schemaVersion', 'kind', 'baseSha', 'headSha', 'value']);
  if (
    envelope.schemaVersion !== 1 ||
    envelope.kind !== 'knowledge' ||
    !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(envelope.headSha) ||
    envelope.baseSha !== envelope.headSha ||
    (headSha !== undefined && envelope.headSha !== headSha) ||
    !isDeepStrictEqual(envelope.value, envelopeValue(projectKey, source, value))
  )
    fail('knowledge_evidence');
  const reference = { ...ref, headSha: envelope.headSha };
  await adapter.assert(reference);
  return reference;
}

export async function refreshKnowledge(options, ports = {}) {
  const report = (status, capture = null, errors = []) => ({ schemaVersion: 1, status, requests: 0, capture, errors });
  let ownedStore;
  try {
    const { policy, context } = await loadKnowledgeContext(options, ports);
    if (policy.mode === 'off') return report('disabled');
    const secrets = ports.secrets || {},
      root = await realpath(options.project),
      sourceRoot = await realpath(options.snapshotCwd || options.project);
    const inputPath = relative(options.inputPath);
    const inputOid = await tracked(root, inputPath);
    const inputBytes = await readOwned(root, inputPath, policy.maxEvidenceBytes, secrets);
    const input = parse(inputBytes, inputPath);
    clean(input, secrets);
    assertTrackedBytes(inputBytes, inputOid);
    validateInput(input, policy);
    const claimsPort = ports.claims || (await import('./knowledge-claims.mjs'));
    for (const claim of input.claims) {
      const sanitized = claimsPort.sanitizeKnowledgeUrl(claim.source.url, { allowedOrigins: policy.allowedOrigins });
      claim.source.url = sanitized.url;
      claim.unknowns = [...new Set([...claim.unknowns, ...sanitized.unknowns])];
      if (claim.unknowns.length > 32 || claim.unknowns.some(item => !boundedString(item, 200))) fail('knowledge_limit');
    }
    clean(input, secrets);
    const inputHash = hash(input),
      policyHash = hash(policy),
      contextHash = context.contextHash;
    const store = ports.store || (ownedStore = new (await import('./store.mjs')).Store(undefined, secrets));
    const previous = await store.findKnowledgeCapture(context.projectKey, input.captureId);
    if (previous) {
      if (
        previous.inputHash !== inputHash ||
        previous.policyHash !== policyHash ||
        previous.contextHash !== contextHash
      )
        fail('knowledge_replay');
      return report('replayed', { ...previous, replayed: true });
    }
    const capturedAt = options.now !== undefined ? options.now : ports.now ? ports.now() : new Date().toISOString();
    timestamp(capturedAt, false);
    const evidenceRoot = await evidenceDirectory(store.home, root, sourceRoot);
    const sources = new Map(),
      candidates = [],
      locators = new Map();
    let budget = inputBytes.length;
    const charge = bytes => {
      budget += bytes;
      if (budget > policy.maxEvidenceBytes) fail('knowledge_limit');
    };
    // Finish validating every selection before persisting any evidence.
    for (const row of input.claims) {
      const claim = structuredClone(row),
        locator = canonical({
          kind: claim.source.kind,
          url: claim.source.url,
          path: claim.source.path,
          pointer: claim.source.pointer,
        });
      if (locators.has(claim.source.id) && locators.get(claim.source.id) !== locator) fail('knowledge_source');
      locators.set(claim.source.id, locator);
      let selected = claim.value;
      if (claim.source.kind === 'local') {
        if (!sources.has(claim.source.path)) {
          const oid = await tracked(sourceRoot, claim.source.path);
          const bytes = await readOwned(sourceRoot, claim.source.path, policy.maxEvidenceBytes - budget, secrets);
          assertTrackedBytes(bytes, oid);
          charge(bytes.length);
          sources.set(claim.source.path, bytes);
        }
        selected = await selection(sources.get(claim.source.path), claim.source);
        clean(selected, secrets);
        jsonValue(selected);
        if (!isDeepStrictEqual(selected, claim.value)) fail('knowledge_selector');
        if (claim.domain === 'codebase') {
          if (claim.versions.headSha && claim.versions.headSha !== context.headSha) fail('knowledge_head');
          claim.versions.headSha = context.headSha;
          versions(claim.versions, true);
          claim.source.retrievedAt = capturedAt;
          claim.source.validAsOf = capturedAt;
        }
      }
      const value = envelopeValue(context.projectKey, claim.source, selected);
      // The standard Engine envelope has a deterministic byte size; account for
      // all envelopes before the first write as well as checking exact receipts.
      charge(
        Buffer.byteLength(
          JSON.stringify({
            schemaVersion: 1,
            kind: 'knowledge',
            baseSha: context.headSha,
            headSha: context.headSha,
            value,
          }),
        ),
      );
      candidates.push({ claim, value });
    }
    if ((await snapshot(sourceRoot)).head !== context.headSha) fail('knowledge_head');
    const adapter = await evidenceAdapter(ports, store),
      claims = [];
    const run = { id: input.captureId, artifacts: evidenceRoot, baseSha: context.headSha, headSha: context.headSha };
    for (const { claim, value } of candidates) {
      const reference = await adapter.write(run, 'knowledge', value, { headSha: context.headSha });
      const ref = { path: reference.path, bytes: reference.bytes, sha256: reference.sha256 };
      await verifyReference(ref, {
        root: evidenceRoot,
        projectKey: context.projectKey,
        source: claim.source,
        value: claim.value,
        headSha: context.headSha,
        adapter,
        limit: policy.maxEvidenceBytes,
      });
      claim.source.evidenceRef = ref;
      claims.push(claimsPort.normalizeClaim({ projectKey: context.projectKey, ...claim, synthetic: input.synthetic }));
    }
    if ((await snapshot(sourceRoot)).head !== context.headSha) fail('knowledge_head');
    for (const [filename, original] of sources)
      if (!(await readOwned(sourceRoot, filename, policy.maxEvidenceBytes, secrets)).equals(original))
        fail('knowledge_source_changed');
    const current = await loadKnowledgeContext(options, ports);
    if (
      hash(current.policy) !== policyHash ||
      current.context?.contextHash !== contextHash ||
      !(await readOwned(root, inputPath, policy.maxEvidenceBytes, secrets)).equals(inputBytes)
    )
      fail('knowledge_source_changed');
    const capture = await store.appendKnowledgeCapture({
      schemaVersion: 1,
      projectKey: context.projectKey,
      captureId: input.captureId,
      inputHash,
      policyHash,
      contextHash,
      capturedAt,
      claims,
    });
    return report(capture.replayed ? 'replayed' : 'refreshed', capture);
  } catch (error) {
    return report('blocked', null, [
      {
        code: error.knowledgeCode || 'knowledge_blocked',
        file: ['research.policy.json', 'research.context.json'].includes(error.file) ? error.file : null,
      },
    ]);
  } finally {
    ownedStore?.close();
  }
}

export async function checkKnowledgeEvidence({ project, snapshotCwd = project, evidenceRoot, claims }, ports = {}) {
  const items = [],
    roots = {},
    verified = [];
  let remaining;
  // Per-record failures are neutral evidence failures, never success or leaked
  // filesystem/parser errors. Nothing here mutates a capture or its timestamps.
  try {
    roots.project = await realpath(project);
    roots.loaded = await loadKnowledgeContext({ project, snapshotCwd }, ports);
    if (!roots.loaded.context) fail('knowledge_disabled');
    roots.source = { root: await realpath(snapshotCwd), head: roots.loaded.context.headSha };
    await absoluteNoLinks(evidenceRoot);
    roots.evidence = await realpath(evidenceRoot);
    if (inside(roots.project, roots.evidence) || inside(roots.source.root, roots.evidence))
      fail('knowledge_evidence_path');
    remaining = roots.loaded.policy.maxEvidenceBytes;
  } catch {
    roots.invalid = true;
  }
  let adapter;
  for (const claim of Array.isArray(claims) ? claims.slice(0, 1000) : []) {
    const ref = claim?.source?.evidenceRef;
    const item = {
      id: claim?.id,
      revision: claim?.revision,
      evidenceHash: ref?.sha256,
      intact: false,
      sourceMatches: false,
    };
    items.push(item);
    if (roots.invalid) continue;
    try {
      const { policy, context } = roots.loaded;
      if (
        claim.projectKey !== context.projectKey ||
        (claim.source.kind !== 'local' && claim.source.kind !== 'discovery')
      )
        fail('knowledge_evidence');
      adapter ||= await evidenceAdapter(ports, ports.store || { home: path.dirname(roots.evidence) });
      // Capture bytes retain their original HEAD. Only codebase observations
      // require that HEAD to equal the current owned source snapshot.
      const reference = await verifyReference(ref, {
        root: roots.evidence,
        projectKey: context.projectKey,
        source: claim.source,
        value: claim.value,
        headSha: claim.domain === 'codebase' ? roots.source.head : undefined,
        adapter,
        limit: remaining,
      });
      remaining -= reference.bytes;
      item.intact = true;
      if (claim.source.kind !== 'local') continue;
      relative(claim.source.path);
      if (
        !policy.sourcePaths.some(
          allowed => claim.source.path === allowed || claim.source.path.startsWith(allowed + '/'),
        )
      )
        fail('knowledge_path');
      if (claim.domain === 'codebase' && claim.versions.headSha !== roots.source.head) fail('knowledge_head');
      const oid = await tracked(roots.source.root, claim.source.path);
      const bytes = await readOwned(roots.source.root, claim.source.path, remaining, ports.secrets || {});
      assertTrackedBytes(bytes, oid);
      remaining -= bytes.length;
      item.sourceMatches = isDeepStrictEqual(await selection(bytes, claim.source), claim.value);
      if (item.sourceMatches) verified.push({ item, reference });
    } catch {
      /* This exact revision/hash stays ineligible. */
    }
  }
  if (!roots.invalid) {
    try {
      if ((await snapshot(roots.source.root)).head !== roots.source.head) throw new Error('head');
    } catch {
      for (const item of items) item.sourceMatches = false;
    }
  }
  // The trusted seam is separate from the public serialized checks and is
  // emitted only after source verification and the final clean-HEAD fence.
  for (const { item, reference } of verified)
    if (item.intact && item.sourceMatches) {
      ports.onVerifiedReference?.({ id: item.id, revision: item.revision, reference: { ...reference } });
    }
  return { schemaVersion: 1, items };
}
