/** Offline knowledge composition. URL metadata is data; this module never fetches. */
import path from 'node:path';
import { realpath } from 'node:fs/promises';
import { loadKnowledgeContext, refreshKnowledge, checkKnowledgeEvidence } from './knowledge-refresh.mjs';
import { evaluateClaims } from './knowledge-claims.mjs';
import { projectKnowledge } from './knowledge-context.mjs';
import { stateHome, workerEnvironment } from './security.mjs';
import { git } from './workspace.mjs';

const fail = code => Object.assign(new Error('Knowledge operation blocked'), { code });
const identity = value => process.platform === 'win32' ? value.toLowerCase() : value;
const errorCode = error => /^knowledge_[a-z_]+$/.test(error?.knowledgeCode || error?.code) ? error.knowledgeCode || error.code : error?.code === 'context_budget' ? 'context_budget' : 'knowledge_blocked';

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
  if (ownedCwds) await ownedSnapshot(project, snapshotCwd, ownedCwds, false);
  const load = ports.loadKnowledgeContext || loadKnowledgeContext;
  // C short-circuits off before Git/Store/clock. No saved snapshot is reused.
  const loaded = await load({ project, snapshotCwd, contextPath }, ports);
  if (!loaded.context) return { status: 'disabled', ...loaded, evaluation: null, projection: null };
  await ownedSnapshot(project, snapshotCwd, ownedCwds);
  const home = ports.home || ports.store?.home || stateHome();
  let reader;
  try {
    const store = ports.store || (reader = await (ports.openKnowledgeReader || (await import('./store.mjs')).openKnowledgeReader)(home));
    const claims = await store.listKnowledgeClaims(loaded.context.projectKey, { ...(subject === undefined ? {} : { subject }), limit: loaded.policy.maxClaims });
    const evidenceChecks = await (ports.checkKnowledgeEvidence || checkKnowledgeEvidence)({ project, snapshotCwd, evidenceRoot: path.join(await realpath(home).catch(error => { if (error.code === 'ENOENT') return path.resolve(home); throw error; }), 'knowledge-evidence'), claims }, ports);
    const evaluatedAt = now ?? ports.now?.() ?? new Date().toISOString();
    const evaluation = evaluateClaims({ claims, ...loaded, now: evaluatedAt, evidenceChecks });
    const current = await load({ project, snapshotCwd, contextPath }, ports);
    if (JSON.stringify(current) !== JSON.stringify(loaded)) throw fail('knowledge_context_changed');
    // A smaller configured limit is never widened. Mandatory D metadata may
    // itself exceed it; optional native context then deliberately stays absent.
    const projection = projectKnowledge({ evaluation, task, maxBytes: loaded.policy.maxContextBytes });
    return { status: 'ready', ...loaded, evaluatedAt, evaluation, projection };
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
    if (options.action === 'refresh') {
      const loaded = await (ports.loadKnowledgeContext || loadKnowledgeContext)(options, ports);
      if (!loaded.context) report = { schemaVersion: 1, status: 'disabled', requests: 0, capture: null, errors: [] };
      else {
        let store;
        try {
          store = ports.store || new (await import('./store.mjs')).Store(ports.home || stateHome(), ports.secrets || {});
          report = await refreshKnowledge(options, { ...ports, store });
        } finally { if (!ports.store) store?.close(); }
      }
    }
    else {
      const loaded = options.action === 'status'
        ? await (ports.loadKnowledgeContext || loadKnowledgeContext)(options, ports)
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
