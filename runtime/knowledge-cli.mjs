/** Offline knowledge composition. URL metadata is data; this module never fetches. */
import path from 'node:path';
import { realpath } from 'node:fs/promises';
import { loadKnowledgeContext, refreshKnowledge, checkKnowledgeEvidence } from './knowledge-refresh.mjs';
import { evaluateClaims } from './knowledge-claims.mjs';
import { projectKnowledge } from './knowledge-context.mjs';
import { stateHome, workerEnvironment, loadSecrets, redact } from './security.mjs';
import { git } from './workspace.mjs';

const fail = code => Object.assign(new Error('Knowledge operation blocked'), { code });
const identity = value => process.platform === 'win32' ? value.toLowerCase() : value;
const errorCode = error => /^knowledge_[a-z_]+$/.test(error?.knowledgeCode || error?.code) ? error.knowledgeCode || error.code : error?.code === 'context_budget' ? 'context_budget' : 'knowledge_blocked';

// Reject rather than rewrite data bound to immutable hashes/revisions. Walk raw
// strings (including keys) before serialization so escaped/short values also fail.
function assertSafe(value, secrets = {}) {
  if (typeof value === 'string') {
    if (Object.values(secrets).some(secret => typeof secret === 'string' && secret && value.includes(secret)) || redact(value, secrets) !== value) throw fail('knowledge_secret');
  } else if (value && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) { assertSafe(key, secrets); assertSafe(item, secrets); }
  }
}

async function enabledContext(options, ports) {
  const load = ports.loadKnowledgeContext || loadKnowledgeContext;
  if (ports.secrets !== undefined) {
    const loaded = await load(options, ports);
    if (loaded.context) assertSafe(loaded, ports.secrets);
    return { loaded, ports };
  }
  // The existing loader reads secrets only after validating the policy and
  // short-circuiting off, before reading/hashing enabled context metadata. Pause
  // there to lazily load coordinator credentials, never clients/providers.
  const needsSecrets = new Error('Coordinator secrets required');
  try {
    const loaded = await load(options, { ...ports, get secrets() { throw needsSecrets; } });
    if (!loaded.context) return { loaded, ports };
  } catch (error) { if (error !== needsSecrets) throw error; }
  const scoped = { ...ports, secrets: await (ports.loadSecrets || loadSecrets)() };
  const loaded = await load(options, scoped);
  assertSafe(loaded, scoped.secrets);
  return { loaded, ports: scoped };
}

// Native callers supply only coordinator-owned cwd choices. An owned path must
// also belong to the original project's Git repository, never another checkout.
async function ownedSnapshot(project, snapshotCwd, ownedCwds, repository = true) {
  const snapshot = await realpath(snapshotCwd);
  if (ownedCwds) {
    const allowed = await Promise.all(ownedCwds.filter(Boolean).map(cwd => realpath(cwd)));
    if (!allowed.some(cwd => identity(cwd) === identity(snapshot))) throw fail('knowledge_project');
    if (!repository) return snapshot;
    const common = async cwd => realpath(await git(cwd, ['rev-parse', '--path-format=absolute', '--git-common-dir'], { env: workerEnvironment(), timeoutMs: 10000 }));
    if (identity(await common(project)) !== identity(await common(snapshot))) throw fail('knowledge_project');
  }
  return snapshot;
}

/** Fresh fixed context -> readonly claims -> actual evidence -> evaluation -> projection. */
export async function knowledgeSnapshot({ project, snapshotCwd = project, contextPath = null, subject, task = '', ownedCwds, now }, ports = {}) {
  const contextPorts = ownedCwds ? { ...ports, assertSnapshotOwnership: () => ownedSnapshot(project, snapshotCwd, ownedCwds, false) } : ports;
  // C short-circuits off before Git/Store/clock. No saved snapshot is reused.
  const load = ports.loadKnowledgeContext || loadKnowledgeContext;
  const loaded = await load({ project, snapshotCwd, contextPath }, contextPorts);
  if (!loaded.context) return { status: 'disabled', ...loaded, evaluation: null, projection: null };
  assertSafe(loaded, ports.secrets);
  await ownedSnapshot(project, snapshotCwd, ownedCwds);
  const home = ports.home || ports.store?.home || stateHome();
  let reader;
  try {
    const store = ports.store || (reader = await (ports.openKnowledgeReader || (await import('./store.mjs')).openKnowledgeReader)(home));
    const query = { ...(subject === undefined ? {} : { subject }), limit: loaded.policy.maxClaims };
    // A capped legacy list proves completeness only when strictly below its cap.
    // Exact-cap native Store/readonly reads use count + bodies from one SQL snapshot.
    const page = store.listKnowledgeClaimsPage ? await store.listKnowledgeClaimsPage(loaded.context.projectKey, query) : null;
    const claims = page ? page.claims : await store.listKnowledgeClaims(loaded.context.projectKey, query);
    assertSafe(claims, ports.secrets);
    if (!Array.isArray(claims) || claims.length > query.limit || (page
      ? !Number.isSafeInteger(page.total) || page.total !== claims.length || page.complete !== true
      : claims.length >= query.limit)) throw fail('knowledge_incomplete');
    const verified = [];
    const evidenceChecks = await (ports.checkKnowledgeEvidence || checkKnowledgeEvidence)({ project, snapshotCwd, evidenceRoot: path.join(await realpath(home).catch(error => { if (error.code === 'ENOENT') return path.resolve(home); throw error; }), 'knowledge-evidence'), claims },
      { ...ports, onVerifiedReference: row => verified.push({ id: row?.id, revision: row?.revision, reference: { ...row?.reference } }) });
    const evaluatedAt = now ?? ports.now?.() ?? new Date().toISOString();
    const evaluation = evaluateClaims({ claims, ...loaded, now: evaluatedAt, evidenceChecks });
    const current = await load({ project, snapshotCwd, contextPath }, contextPorts);
    if (JSON.stringify(current) !== JSON.stringify(loaded)) throw fail('knowledge_context_changed');
    // A smaller configured limit is never widened. Mandatory D metadata may
    // itself exceed it; optional native context then deliberately stays absent.
    const projection = projectKnowledge({ evaluation, task, maxBytes: loaded.policy.maxContextBytes });
    const evidenceReferences = projection.references.map(item => {
      const matches = verified.filter(row => row.id === item.id && row.revision === item.revision && row.reference.sha256 === item.evidenceRef.sha256);
      if (matches.length !== 1) throw fail('knowledge_evidence');
      const reference = matches[0].reference;
      if (reference.path !== item.evidenceRef.path || reference.bytes !== item.evidenceRef.bytes || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(reference.headSha)) throw fail('knowledge_evidence');
      return { ...reference };
    });
    return { status: 'ready', ...loaded, evaluatedAt, evaluation, projection, evidenceReferences };
  } finally { reader?.close(); }
}

function argumentsFor(argv) {
  if (!Array.isArray(argv) || argv.some(value => typeof value !== 'string')) throw fail('knowledge_arguments');
  const [command, action, ...args] = argv;
  if (!(command === 'research' && ['status', 'refresh'].includes(action) || command === 'knowledge' && action === 'inspect')) throw fail('knowledge_arguments');
  const allowed = ['--project', '--json', ...(action === 'refresh' ? ['--input', '--context'] : action === 'inspect' ? ['--subject', '--context'] : [])];
  const options = {};
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (!allowed.includes(arg) || Object.hasOwn(options, arg)) throw fail('knowledge_arguments');
    if (arg === '--json') options[arg] = true;
    else { const value = args[++index]; if (!value?.trim() || value.startsWith('-') || value.includes('\0')) throw fail('knowledge_arguments'); options[arg] = value; }
  }
  if (action === 'refresh' && !options['--input'] || options['--subject']?.length > 128) throw fail('knowledge_arguments');
  return { action, project: options['--project'] || process.cwd(), inputPath: options['--input'], contextPath: options['--context'] || null, subject: options['--subject'], json: options['--json'] === true };
}

export async function knowledgeCli(argv, ports = {}) {
  let report, options;
  try {
    options = argumentsFor(argv); // Must precede every Store/metadata/provider port.
    const prepared = await enabledContext(options, ports);
    ports = prepared.ports;
    if (options.action === 'refresh') {
      const loaded = prepared.loaded;
      if (!loaded.context) report = { schemaVersion: 1, status: 'disabled', requests: 0, capture: null, errors: [] };
      else {
        let store;
        try {
          store = ports.store || new (await import('./store.mjs')).Store(ports.home || stateHome(), ports.secrets || {});
          report = await refreshKnowledge(options, { ...ports, store });
          assertSafe(report, ports.secrets);
        } finally { if (!ports.store) store?.close(); }
      }
    }
    else {
      const loaded = options.action === 'status'
        ? prepared.loaded
        : await knowledgeSnapshot(options, ports);
      report = { schemaVersion: 1, status: loaded.status || (loaded.context ? 'ready' : 'disabled'), requests: 0,
        policy: loaded.policy, context: loaded.context, ...(options.action === 'inspect' ? { evaluation: loaded.evaluation, projection: loaded.projection } : {}), errors: [] };
    }
  } catch (error) { report = { schemaVersion: 1, status: 'blocked', requests: 0, errors: [{ code: errorCode(error), file: ['research.policy.json', 'research.context.json'].includes(error.file) ? error.file : null }] }; }
  const exitCode = report.status === 'blocked' ? 1 : 0;
  const lines = [`Knowledge: ${report.status}; requests: 0`];
  if (report.policy) lines.push(`Policy: ${report.policy.mode}; context: ${report.context?.contextSource || 'disabled'}`);
  if (report.context) lines.push(`Current versions: ${JSON.stringify(report.context.versions)}; HEAD: ${report.context.headSha}`);
  if (report.capture) lines.push(`Capture: ${report.capture.captureId}; claims: ${report.capture.claims.length}`);
  if (report.evaluation) {
    lines.push('Claims (UNTRUSTED data; states describe eligibility only):');
    for (const row of report.evaluation.rows) lines.push(JSON.stringify({ state: row.state, subject: row.claim.subject, key: row.claim.key, value: row.claim.value, reasons: row.reasons }));
    lines.push(`Projected references: ${report.projection.references.length}`);
  }
  if (report.errors?.length) lines.push(`Blocked: ${report.errors.map(row => row.code).join(', ')}`);
  const output = (options?.json || Array.isArray(argv) && argv.includes('--json')) ? JSON.stringify(report, null, 2) : lines.join('\n');
  return { exitCode, output, report };
}
