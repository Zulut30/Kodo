/** Behaviour gate: deterministic, model-free checks of the final head that
 * outrank a reviewer's report.
 *
 * 1. QualityPolicy: the change is classified by its changed paths, and each
 *    type names the gates it needs. A needed gate that is disabled is a
 *    recorded gap, never a PASS.
 * 2. Test protection: tests that existed on the base may not be deleted,
 *    skipped, focused or stripped of their cases and assertions.
 * 3. Behavioural oracles: project-owned commands (contract tests, comparison
 *    with a reference tool) run by the coordinator. The files an oracle
 *    protects must be byte-identical to the base.
 *
 * The receipt is bound to the exact head, base and configuration.
 */
import { createHash } from 'node:crypto';
import { ownsPath } from './contracts.mjs';
import { execute } from './command.mjs';
import { workerEnvironment } from './security.mjs';

export const BEHAVIOR_GATE_VERSION = 1;
const MAX_FILE_BYTES = 1048576;
const hash = value => createHash('sha256').update(value).digest('hex');

/** @returns {never} */
function invalid(message) {
  throw Object.assign(new Error(`Некорректная конфигурация Kodo: verification: ${message}`), {
    code: 'configuration',
  });
}

/**
 * @typedef {object} VerificationConfig
 * @property {boolean} baseline Run the check commands on the base commit before any edit.
 * @property {boolean} testProtection Refuse deleted, skipped or weakened tests.
 * @property {boolean} strictGates A gate the policy needs but the project disabled fails the gate.
 * @property {{ id: string, command: string, args: string[], timeoutMs?: number, protect: string[] }[]} oracles
 */

/**
 * @param {unknown} [value]
 * @returns {VerificationConfig}
 */
export function normalizeVerificationConfig(value = undefined) {
  const input = /** @type {Record<string, any>} */ (value === undefined ? {} : value);
  if (!input || typeof input !== 'object' || Array.isArray(input)) invalid('an object is expected');
  const known = ['baseline', 'testProtection', 'strictGates', 'oracles'];
  for (const key of Object.keys(input)) if (!known.includes(key)) invalid(`unknown key ${key}`);
  for (const key of ['baseline', 'testProtection', 'strictGates'])
    if (input[key] !== undefined && typeof input[key] !== 'boolean') invalid(`${key} must be boolean`);
  const oracles = input.oracles ?? [];
  if (!Array.isArray(oracles) || oracles.length > 8) invalid('oracles must be a list of at most 8');
  const ids = new Set();
  const normalized = oracles.map(oracle => {
    if (!oracle || typeof oracle !== 'object' || Array.isArray(oracle)) invalid('an oracle must be an object');
    for (const key of Object.keys(oracle))
      if (!['id', 'command', 'args', 'timeoutMs', 'protect'].includes(key)) invalid(`unknown oracle key ${key}`);
    if (typeof oracle.id !== 'string' || !/^[a-z][a-z0-9-]{0,47}$/.test(oracle.id) || ids.has(oracle.id))
      invalid('oracle id must be a unique slug');
    ids.add(oracle.id);
    if (typeof oracle.command !== 'string' || !oracle.command.trim()) invalid(`oracle ${oracle.id} has no command`);
    const args = oracle.args ?? [];
    if (!Array.isArray(args) || args.some(arg => typeof arg !== 'string')) invalid(`oracle ${oracle.id} args`);
    const protect = oracle.protect ?? [];
    if (
      !Array.isArray(protect) ||
      !protect.length ||
      protect.length > 64 ||
      protect.some(
        scope =>
          typeof scope !== 'string' ||
          !scope ||
          scope.includes('\\') ||
          scope.startsWith('/') ||
          scope.includes(':') ||
          scope.split('/').includes('..'),
      )
    )
      invalid(`oracle ${oracle.id} must protect repository-relative paths`);
    if (
      oracle.timeoutMs !== undefined &&
      (!Number.isInteger(oracle.timeoutMs) || oracle.timeoutMs < 0 || oracle.timeoutMs > 2147483647)
    )
      invalid(`oracle ${oracle.id} timeoutMs`);
    return {
      id: oracle.id,
      command: oracle.command,
      args: [...args],
      ...(oracle.timeoutMs === undefined ? {} : { timeoutMs: oracle.timeoutMs }),
      protect: [...protect],
    };
  });
  return {
    baseline: input.baseline ?? false,
    testProtection: input.testProtection ?? true,
    strictGates: input.strictGates ?? false,
    oracles: normalized,
  };
}

export const verificationConfigHash = config =>
  hash(JSON.stringify({ version: BEHAVIOR_GATE_VERSION, config: normalizeVerificationConfig(config) }));

/** @type {[string, RegExp][]} */
const changeTypes = [
  [
    'ci',
    /(^|\/)\.github\/(?:workflows|actions)\/|(^|\/)\.gitlab-ci\.yml$|(^|\/)azure-pipelines\.yml$|(^|\/)Jenkinsfile$/i,
  ],
  [
    'release',
    /(^|\/)(?:CHANGELOG[^/]*|\.releaserc[^/]*|release[^/]*\.(?:json|ya?ml|[cm]?js))$|(^|\/)scripts\/release/i,
  ],
  ['schema', /(^|\/)(?:migrations?|schema|prisma|db)\/|\.sql$|(^|\/)schema\.[a-z]+$/i],
  ['security', /(^|\/)(?:auth\w*|security|crypto\w*|permissions?|secrets?|oauth\w*|session\w*|acl)(?:\/|\.|-|_)/i],
  [
    'api',
    /(^|\/)(?:api|routes?|controllers?|handlers?|graphql|proto)\/|\.(?:proto|graphql)$|openapi[^/]*\.(?:ya?ml|json)$/i,
  ],
  [
    'tests',
    /(^|\/)(?:tests?|__tests__|spec)\/|\.(?:test|spec)\.[cm]?[jt]sx?$|_test\.(?:go|py|rs)$|(^|\/)test_[^/]+\.py$/i,
  ],
  ['style', /\.(?:css|scss|sass|less|styl|pcss)$/i],
  ['content', /\.(?:md|mdx|txt|rst|adoc)$|(^|\/)(?:docs?|LICENSE[^/]*)(?:\/|$)/i],
  [
    'config',
    /(^|\/)(?:package(?:-lock)?\.json|pnpm-lock\.yaml|yarn\.lock|Cargo\.(?:toml|lock)|go\.(?:mod|sum)|pyproject\.toml|requirements[^/]*\.txt|kodo\.config\.json|tsconfig[^/]*\.json|\.[a-z]+rc(?:\.[a-z]+)?)$/i,
  ],
];
const isTestFile = file => changeTypes.find(([type]) => type === 'tests')[1].test(file);
const highRisk = new Set(['ci', 'release', 'schema', 'security']);
const lowRisk = new Set(['style', 'content', 'tests']);
/** Gates each change type needs. `oracle` means at least one configured behavioural oracle. */
const neededGates = {
  style: ['ui'],
  security: ['security'],
  ci: ['security'],
  release: ['security'],
  config: ['security'],
  schema: ['oracle'],
  api: ['architecture'],
};

/**
 * Change types of a set of changed paths. A path with no specific type is `code`.
 * @param {string[]} paths
 * @returns {string[]} Sorted unique types.
 */
export function classifyChange(paths) {
  const types = new Set();
  for (const file of paths) {
    const matched = changeTypes.filter(([, pattern]) => pattern.test(file)).map(([type]) => type);
    for (const type of matched.length ? matched : ['code']) types.add(type);
  }
  return [...types].sort();
}

/**
 * What a change of these types requires and what the project cannot verify.
 * @param {{ types: string[], config: Record<string, any>, verification: VerificationConfig }} input
 */
export function qualityPolicy({ types, config, verification }) {
  const enabled = {
    ui: config.uiVerification?.enabled === true,
    security: config.security?.enabled === true,
    architecture: config.architecture?.enabled === true,
    oracle: verification.oracles.length > 0,
  };
  const required = [...new Set(types.flatMap(type => neededGates[type] ?? []))].sort();
  const risk = types.some(type => highRisk.has(type))
    ? 'high'
    : types.length && types.every(type => lowRisk.has(type))
      ? 'low'
      : 'medium';
  return {
    risk,
    types,
    // Local checks and the independent review are always required and enforced by the Engine.
    required: ['checks', 'review', ...required],
    // `disabled` is a gap, never a PASS.
    gaps: required.filter(gate => !enabled[gate]).map(gate => ({ gate, reason: 'disabled' })),
  };
}

const markers = {
  // A skipped or focused test is still a case; `skips` counts the modifier separately.
  cases:
    /\b(?:test|it|describe|suite)\s*(?:\.\s*\w+\b[^(\n]*)?\(|\bdef\s+test_\w+|#\[(?:\w+::)?test\]|\bfunc\s+Test\w+\s*\(|@Test\b/g,
  skips:
    /\b(?:test|it|describe|suite)\s*\.\s*(?:skip|todo|only)\b|\bx(?:it|describe|test)\s*\(|@pytest\.mark\.(?:skip|xfail)|#\[ignore\]|\bt\.Skip(?:f|Now)?\(|@(?:Disabled|Ignore)\b|\{\s*(?:skip|todo)\s*:\s*(?:true|['"`])/g,
  assertions: /\bassert\w*|\bexpect\s*\(|\.should\b|\brequire\.\w+\(/g,
};
const count = (text, pattern) => (text.match(pattern) || []).length;

async function show(cwd, revision, file) {
  const result = await execute('git', ['show', `${revision}:${file}`], { cwd, allowFailure: true });
  return result.code === 0 && Buffer.byteLength(result.stdout) <= MAX_FILE_BYTES ? result.stdout : null;
}

/** Changed files between base and head as `{ status, from, to }`, renames followed. */
async function changes(cwd, baseSha, headSha) {
  const output = (await execute('git', ['diff', '--name-status', '-M', '-z', `${baseSha}...${headSha}`], { cwd }))
    .stdout;
  const fields = output.split('\0').filter(Boolean),
    rows = [];
  for (let index = 0; index < fields.length;) {
    const status = fields[index++][0];
    const from = fields[index++];
    const to = status === 'R' || status === 'C' ? fields[index++] : from;
    rows.push({ status, from, to });
  }
  return rows;
}

/**
 * Tests that existed on the base and were deleted, skipped, focused or weakened.
 * Heuristic by design: it counts test-case, skip and assertion markers.
 * @param {{ cwd: string, baseSha: string, headSha: string }} input
 */
export async function testWeakening({ cwd, baseSha, headSha }) {
  const findings = [];
  for (const { status, from, to } of await changes(cwd, baseSha, headSha)) {
    if (status === 'A' || status === 'C' || !isTestFile(from)) continue;
    const before = await show(cwd, baseSha, from);
    if (before === null) continue;
    const cases = count(before, markers.cases);
    if (!cases) continue; // A helper or fixture, not a test.
    if (status === 'D') {
      findings.push({ rule: 'test_deleted', file: from, detail: `${cases} test cases removed with the file` });
      continue;
    }
    const after = await show(cwd, headSha, to);
    if (after === null) continue;
    const now = {
      cases: count(after, markers.cases),
      skips: count(after, markers.skips),
      assertions: count(after, markers.assertions),
    };
    const was = { skips: count(before, markers.skips), assertions: count(before, markers.assertions) };
    if (now.cases < cases)
      findings.push({ rule: 'tests_removed', file: to, detail: `test cases ${cases} -> ${now.cases}` });
    if (now.skips > was.skips)
      findings.push({ rule: 'test_skipped', file: to, detail: `skip/only/todo markers ${was.skips} -> ${now.skips}` });
    // Fewer assertions with the same cases is weakening. With more cases it is a refactor;
    // with fewer, `tests_removed` already says so.
    if (now.assertions < was.assertions && now.cases === cases)
      findings.push({
        rule: 'assertions_removed',
        file: to,
        detail: `assertions ${was.assertions} -> ${now.assertions}`,
      });
  }
  return findings;
}

/**
 * Run the behaviour gate on a clean checkout of `headSha`.
 * @param {{ cwd: string, headSha: string, baseSha: string, config: Record<string, any>, signal?: AbortSignal,
 *   secrets?: Record<string, string>, runner?: typeof execute,
 *   persist?: (kind: string, value: any) => Promise<{ sha256: string, path: string }> }} input
 */
export async function runBehaviorGate({
  cwd,
  headSha,
  baseSha,
  config,
  signal,
  secrets = {},
  runner = execute,
  persist,
}) {
  const verification = normalizeVerificationConfig(config.verification);
  const rows = await changes(cwd, baseSha, headSha);
  const paths = [...new Set(rows.flatMap(row => [row.from, row.to]))].sort();
  const policy = qualityPolicy({ types: classifyChange(paths), config, verification });
  const findings = [];
  if (verification.strictGates)
    for (const gap of policy.gaps)
      findings.push({
        rule: 'required_gate_disabled',
        file: null,
        detail: `${gap.gate} gate is required for this change`,
      });
  if (verification.testProtection) findings.push(...(await testWeakening({ cwd, baseSha, headSha })));
  const oracles = [];
  for (const oracle of verification.oracles) {
    // An implementation may not edit the oracle that judges it.
    const touched = paths.filter(file => ownsPath(oracle.protect, file));
    for (const file of touched)
      findings.push({ rule: 'oracle_modified', file, detail: `protected by oracle ${oracle.id}` });
    if (touched.length) {
      oracles.push({ id: oracle.id, status: 'not_run', reason: 'oracle_modified', exitCode: null });
      continue;
    }
    let result;
    try {
      result = await runner(oracle.command, oracle.args, {
        cwd,
        signal,
        env: workerEnvironment(),
        secrets,
        timeoutMs: oracle.timeoutMs,
        allowFailure: true,
      });
    } catch (error) {
      if (signal?.aborted || error.code === 'cancelled') throw error;
      // A crashed or timed-out oracle proves nothing: it is a failure, not a pass.
      const reason = ['timeout', 'ENOENT', 'EACCES', 'EPERM'].includes(error.code) ? error.code : 'execution_failed';
      oracles.push({ id: oracle.id, status: 'failed', reason, exitCode: null });
      findings.push({ rule: 'oracle_failed', file: null, detail: `${oracle.id}: ${reason}` });
      continue;
    }
    const output = (result.stdout + result.stderr).slice(-24000);
    const evidence = persist
      ? await persist('oracle', {
          id: oracle.id,
          command: oracle.command,
          args: oracle.args,
          exitCode: result.code,
          output,
        })
      : null;
    oracles.push({
      id: oracle.id,
      status: result.code === 0 ? 'passed' : 'failed',
      exitCode: result.code,
      ...(evidence ? { outputPath: evidence.path, outputHash: evidence.sha256 } : {}),
    });
    if (result.code !== 0)
      findings.push({
        rule: 'oracle_failed',
        file: null,
        detail: `${oracle.id} exit ${result.code}: ${output.slice(-2000)}`,
      });
  }
  return {
    schemaVersion: BEHAVIOR_GATE_VERSION,
    headSha,
    baseSha,
    configHash: verificationConfigHash(config.verification),
    status: findings.length ? 'failed' : 'passed',
    passed: findings.length === 0,
    policy,
    findings,
    oracles,
  };
}

/**
 * A receipt counts only for the exact head, base and verification configuration it was made for.
 * @param {any} receipt
 * @param {{ headSha?: string, baseSha?: string, config?: Record<string, any> }} [current]
 */
export function isCurrentBehaviorReceipt(receipt, { headSha, baseSha, config } = {}) {
  return (
    receipt?.schemaVersion === BEHAVIOR_GATE_VERSION &&
    typeof headSha === 'string' &&
    receipt.headSha === headSha &&
    receipt.baseSha === baseSha &&
    receipt.configHash === verificationConfigHash(config?.verification) &&
    receipt.passed === true &&
    receipt.status === 'passed' &&
    Array.isArray(receipt.findings) &&
    receipt.findings.length === 0
  );
}

/**
 * Compare final check results with the baseline taken on the base commit.
 * A failure that already existed is labelled, never ignored.
 * @param {{ results: { kind: string, command: any, exitCode: number | null }[] } | null | undefined} baseline
 * @param {{ kind: string, command: any, exitCode: number | null }[]} results
 */
export function compareWithBaseline(baseline, results) {
  if (!baseline || !Array.isArray(baseline.results)) return null;
  const key = row => JSON.stringify([row.kind, row.command]);
  const before = new Map(baseline.results.map(row => [key(row), row]));
  return results.map(row => {
    const base = before.get(key(row));
    const failed = row.exitCode !== 0,
      failedBefore = base ? base.exitCode !== 0 : null;
    const classification = !base
      ? 'no_baseline'
      : failed
        ? failedBefore
          ? 'pre_existing'
          : 'regression'
        : failedBefore
          ? 'fixed'
          : 'unchanged';
    return {
      kind: row.kind,
      command: row.command,
      baseline: base ? base.exitCode : null,
      final: row.exitCode,
      classification,
    };
  });
}
