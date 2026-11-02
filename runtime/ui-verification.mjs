import path from 'node:path';
import { existsSync, lstatSync, readFileSync, realpathSync } from 'node:fs';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { normalizeUIConfig, uiConfigHash, uiTools, modelTools, hash, fail, assessObservations } from './ui-schema.mjs';
import { toolCatalog, resolveTool, installTools } from './tools.mjs';
import { redact } from './security.mjs';
import { execute } from './command.mjs';
import { runInstalledCase, startProjectServer, uiEnvironment } from './ui-browser.mjs';

export { normalizeUIConfig, uiConfigHash } from './ui-schema.mjs';
const safeReasons = new Set(['tool_missing', 'credentials_missing', 'browser_missing', 'desktop_unavailable', 'desktop_error', 'ambiguous_target', 'timeout', 'cancelled', 'malformed_output', 'incomplete_observation', 'assertion_failed', 'agent_failed', 'provider_error', 'cleanup_failed', 'unsupported_tool_api', 'process_unavailable', 'process_exited', 'server_already_running', 'invalid_artifacts', 'bridge_error', 'mcp_error', 'action_readback_failed', 'uncertain_delivery']);
const pinsHash = () => hash(JSON.stringify(toolCatalog.filter(t => uiTools.includes(t.id))));
const headOK = value => typeof value === 'string' && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value);
const safeReason = error => safeReasons.has(error?.code) ? error.code : 'adapter_error';
function inside(root, file) { const rel = path.relative(root, file); return rel === '' || (!rel.startsWith('..' + path.sep) && rel !== '..' && !path.isAbsolute(rel)); }
function noLinks(file) {
  for (let current = path.resolve(file); ; current = path.dirname(current)) {
    try { if (lstatSync(current).isSymbolicLink()) throw fail('invalid_artifacts'); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    if (current === path.dirname(current)) break;
  }
}
function canonical(file) {
  if (existsSync(file)) return realpathSync(file);
  return path.join(canonical(path.dirname(file)), path.basename(file));
}
function outsideGit(file, cwd) {
  if (typeof file !== 'string' || !path.isAbsolute(file)) throw fail('invalid_artifacts');
  noLinks(file);
  const actual = canonical(file);
  if (cwd && inside(canonical(cwd), actual)) throw fail('invalid_artifacts');
  for (let current = actual; ; current = path.dirname(current)) {
    if (existsSync(path.join(current, '.git'))) throw fail('invalid_artifacts');
    if (current === path.dirname(current)) break;
  }
}
async function bounded(operation, timeoutMs, parent, awaitCleanup = false) {
  const controller = new AbortController();
  let timer, cancel, pending;
  try {
    return await Promise.race([
      new Promise((_, reject) => {
        timer = setTimeout(() => { controller.abort(); reject(fail('timeout')); }, timeoutMs);
        cancel = () => { controller.abort(); reject(fail('cancelled')); };
        parent?.addEventListener('abort', cancel, { once: true });
        if (parent?.aborted) cancel();
      }),
      pending = Promise.resolve().then(() => { if (controller.signal.aborted) throw fail('cancelled'); return operation(controller.signal); })
    ]);
  } catch (error) {
    controller.abort();
    if (awaitCleanup) {
      let cleanupTimer;
      try { await Promise.race([pending.catch(() => {}), new Promise(resolve => { cleanupTimer = setTimeout(resolve, 20000); })]); }
      finally { clearTimeout(cleanupTimer); }
    }
    throw error;
  } finally { clearTimeout(timer); parent?.removeEventListener('abort', cancel); controller.abort(); }
}
function checkedResult(c, result) {
  if (result?.schemaVersion !== 1 || !['completed', 'blocked', 'failed'].includes(result.status)) throw fail('malformed_output');
  if (result.status !== 'completed') return { status: result.status, assertions: [], reason: safeReasons.has(result.reason) ? result.reason : 'adapter_error' };
  const assertions = assessObservations(c, result.observations);
  if (c.tool === 'vibetest') {
    const qa = result.qa;
    if (qa?.agents !== 2 || !Array.isArray(qa.observations) || qa.observations.length !== 2 || !Array.isArray(qa.reports) || qa.reports.length !== 2 || !qa.reports.every(r => typeof r === 'string' && r.length <= 12000) || !qa.severity || Object.keys(qa.severity).sort().join(',') !== 'high_severity,low_severity,medium_severity') throw fail('malformed_output');
    if (!Object.values(qa.severity).every(a => Array.isArray(a) && a.length === 0) || !qa.observations.every(o => assessObservations(c, o).every(a => a.passed))) throw fail('assertion_failed');
  }
  if (result.steps !== undefined && (!Number.isInteger(result.steps) || result.steps < 0 || result.steps > 100)) throw fail('malformed_output');
  return { status: assertions.every(a => a.passed) ? 'passed' : 'failed', assertions, ...(assertions.some(a => !a.passed) ? { reason: 'assertion_failed' } : {}), steps: result.steps ?? 0 };
}

/** caseRunner is a coordinator/test dependency port. Return schemaVersion:1,
 * status:completed|failed|blocked and independent observations in assertion order.
 * It must never return an LLM's verdict as observed state. Previous receipts are
 * not shortcuts: this function always re-executes configured cases. */
export async function runUIVerification({ cwd = process.cwd(), headSha, config, artifacts, previous: _previous, secrets = {}, signal, runner = execute, caseRunner, toolHome } = {}) {
  config = normalizeUIConfig(config);
  if (!headOK(headSha)) throw fail('invalid_head');
  const receipt = { schemaVersion: 1, headSha, configHash: uiConfigHash(config), pinsHash: pinsHash(), status: config.enabled ? 'failed' : 'disabled', passed: config.enabled ? false : null, cases: [] };
  if (!config.enabled) return receipt;
  let directory, server;
  try {
    outsideGit(artifacts, cwd);
    await mkdir(artifacts, { recursive: true, mode: 0o700 });
    directory = await mkdtemp(path.join(artifacts, 'ui-'));
    receipt.evidenceRoot = directory;
    if (config.start) {
      const url = config.cases.find(c => c.url)?.url;
      if (!url || !['127.0.0.1', 'localhost', '[::1]'].includes(new URL(url).hostname)) throw fail('invalid_ui_url');
      server = await startProjectServer(config.start, { cwd, env: uiEnvironment(directory), signal, url, timeoutMs: config.timeoutMs });
    }
    for (const c of config.cases) {
      const row = { id: c.id, tool: c.tool, status: 'failed', assertions: [], evidence: [] };
      receipt.cases.push(row);
      const evidenceDir = path.join(directory, c.id); await mkdir(evidenceDir, { mode: 0o700 });
      try {
        if (signal?.aborted) throw fail('cancelled');
        const result = await bounded(async caseSignal => {
          if (caseRunner) return caseRunner({ case: c, config, cwd, evidenceDir, signal: caseSignal, runner, secrets, toolHome });
          const needed = modelTools.includes(c.tool) ? ['GEMINI_API_KEY', ...(c.tool === 'jev-ultrafast' ? ['TYPESAFE_API_KEY'] : [])] : [];
          if (needed.some(name => typeof secrets[name] !== 'string' || !secrets[name].trim())) throw fail('credentials_missing', true);
          let tool = await resolveTool(c.tool, { home: toolHome, project: cwd });
          if (!tool.ready && config.autoInstall) { await installTools([c.tool], { home: toolHome, project: cwd, runner, signal: caseSignal }); tool = await resolveTool(c.tool, { home: toolHome, project: cwd }); }
          if (!tool.ready) throw fail('tool_missing', true);
          return runInstalledCase({ case: c, config, tool, evidenceDir, signal: caseSignal, runner, secrets: Object.fromEntries(needed.map(name => [name, secrets[name]])) });
        }, config.timeoutMs, signal, !caseRunner);
        Object.assign(row, checkedResult(c, result));
        // Evidence is allowlisted observed state, not full prompts/history/stdout.
        const content = JSON.stringify(redact({ schemaVersion: 1, headSha, configHash: receipt.configHash, pinsHash: receipt.pinsHash, id: c.id, tool: c.tool, status: result.status, observations: result.observations ?? [], assertions: row.assertions, steps: row.steps ?? 0,
          ...(c.tool === 'vibetest' && result.qa ? { qa: { agents: result.qa.agents, observations: result.qa.observations, severity: result.qa.severity, reports: result.qa.reports } } : {}) }, secrets));
        if (Buffer.byteLength(content) > 2 * 1024 * 1024) throw fail('malformed_output');
        const filename = path.join(evidenceDir, 'observations.json');
        await writeFile(filename, content, { flag: 'wx', mode: 0o600 });
        row.evidence.push({ path: filename, sha256: hash(content), bytes: Buffer.byteLength(content) });
      } catch (error) { row.status = error.blocked ? 'blocked' : 'failed'; row.reason = safeReason(error); row.assertions = []; }
    }
  } catch (error) {
    for (const c of config.cases.filter(c => !receipt.cases.some(r => r.id === c.id))) receipt.cases.push({ id: c.id, tool: c.tool, status: error.blocked ? 'blocked' : 'failed', assertions: [], evidence: [], reason: safeReason(error) });
  } finally {
    try { await server?.stop(); }
    catch { for (const row of receipt.cases) { row.status = 'failed'; row.reason = 'cleanup_failed'; } }
  }
  receipt.passed = receipt.cases.length === config.cases.length && receipt.cases.every(c => c.status === 'passed');
  receipt.status = receipt.passed ? 'passed' : receipt.cases.some(c => c.status === 'failed') ? 'failed' : 'blocked';
  return receipt;
}

/** Synchronous for delivery/resume guards. Re-read every private evidence byte;
 * saved booleans and the old receipt alone are not a trust boundary. */
export function isCurrentUIReceipt(receipt, { headSha, config } = {}) {
  try {
    config = normalizeUIConfig(config);
    if (!headOK(headSha) || receipt?.schemaVersion !== 1 || receipt.headSha !== headSha || receipt.configHash !== uiConfigHash(config) || receipt.pinsHash !== pinsHash()) return false;
    if (!config.enabled) return receipt.status === 'disabled' && receipt.passed === null && Array.isArray(receipt.cases) && receipt.cases.length === 0;
    if (receipt.status !== 'passed' || receipt.passed !== true || !Array.isArray(receipt.cases) || receipt.cases.length !== config.cases.length) return false;
    outsideGit(receipt.evidenceRoot);
    return config.cases.every((c, i) => {
      const row = receipt.cases[i];
      if (row?.id !== c.id || row.tool !== c.tool || row.status !== 'passed' || !Array.isArray(row.evidence) || row.evidence.length !== 1) return false;
      const e = row.evidence[0];
      if (!path.isAbsolute(e.path) || !inside(receipt.evidenceRoot, e.path) || !Number.isInteger(e.bytes) || e.bytes < 1 || e.bytes > 2 * 1024 * 1024 || !/^[a-f0-9]{64}$/.test(e.sha256)) return false;
      noLinks(e.path); const info = lstatSync(e.path);
      if (!info.isFile() || info.size !== e.bytes) return false;
      const bytes = readFileSync(e.path);
      if (hash(bytes) !== e.sha256) return false;
      const data = JSON.parse(bytes);
      if (data.schemaVersion !== 1 || data.headSha !== headSha || data.configHash !== receipt.configHash || data.pinsHash !== receipt.pinsHash || data.id !== c.id || data.tool !== c.tool || data.status !== 'completed') return false;
      const checked = checkedResult(c, data).assertions;
      return checked.every(a => a.passed) && JSON.stringify(checked) === JSON.stringify(row.assertions) && JSON.stringify(checked) === JSON.stringify(data.assertions);
    });
  } catch { return false; }
}
