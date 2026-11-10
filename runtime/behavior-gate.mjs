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
const hash = value => createHash('sha256').update(value).digest('hex');

/** @returns {never} */
function invalid(message) {
  throw Object.assign(new Error(`Некорректная конфигурация Kodo: verification: ${message}`), {
    code: 'configuration',
  });
}

const relativeScope = scope =>
  typeof scope === 'string' &&
  Boolean(scope) &&
  !scope.includes('\\') &&
  !scope.startsWith('/') &&
  !scope.includes(':') &&
  !scope.split('/').includes('..');

/**
 * @typedef {object} VerificationConfig
 * @property {boolean} baseline Run the check commands on the base commit before any edit.
 * @property {boolean} testProtection Refuse deleted and skipped tests.
 * @property {string[]} testRemovalAllowed Test paths (globs) this run may delete or reduce: an explicit, narrow exception.
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
  const known = ['baseline', 'testProtection', 'testRemovalAllowed', 'strictGates', 'oracles'];
  for (const key of Object.keys(input)) if (!known.includes(key)) invalid(`unknown key ${key}`);
  for (const key of ['baseline', 'testProtection', 'strictGates'])
    if (input[key] !== undefined && typeof input[key] !== 'boolean') invalid(`${key} must be boolean`);
  const allowed = input.testRemovalAllowed ?? [];
  if (!Array.isArray(allowed) || allowed.length > 64 || allowed.some(scope => !relativeScope(scope)))
    invalid('testRemovalAllowed must be a short list of repository-relative paths');
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
    testRemovalAllowed: [...allowed],
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
    /(^|\/)\.github\/(?:workflows|actions)\/|(^|\/)\.gitlab-ci\.yml$|(^|\/)azure-pipelines\.yml$|(^|\/)Jenkinsfile$|(^|\/)\.circleci\/|(^|\/)Dockerfile[^/]*$|(^|\/)docker-compose[^/]*\.ya?ml$|\.tf$/i,
  ],
  [
    'release',
    /(^|\/)(?:CHANGELOG[^/]*|\.releaserc[^/]*|release[^/]*\.(?:json|ya?ml|[cm]?js))$|(^|\/)scripts\/release/i,
  ],
  ['schema', /(^|\/)(?:migrations?|schema|prisma|db)\/|\.sql$|(^|\/)schema\.[a-z]+$/i],
  [
    'security',
    // Whole words only: `AUTHORS.md` and `src/author.ts` are not authentication.
    /(^|\/)(?:auth|authn|authz|authentication|authorization|oauth\d?|login|security|crypto|cryptography|permissions?|secrets?|sessions?|acl)(?:\/|\.|-|_|$)/i,
  ],
  [
    'api',
    /(^|\/)(?:api|routes?|controllers?|handlers?|graphql|proto)\/|\.(?:proto|graphql)$|openapi[^/]*\.(?:ya?ml|json)$/i,
  ],
  [
    'tests',
    /(^|\/)(?:tests?|__tests__|spec)\/|\.(?:test|spec)\.[cm]?[jt]sx?$|_test\.(?:go|py|rs)$|(^|\/)test_[^/]+\.py$/i,
  ],
  ['style', /\.(?:css|scss|sass|less|styl|pcss)$/i],
  // By extension only: a script under docs/ is code.
  [
    'content',
    /\.(?:md|mdx|rst|adoc)$|(^|\/)LICENSE[^/]*$|(^|\/)(?!CMakeLists\.txt$|requirements[^/]*\.txt$)[^/]+\.txt$/i,
  ],
  [
    'config',
    /(^|\/)(?:package(?:-lock)?\.json|pnpm-lock\.yaml|yarn\.lock|Cargo\.(?:toml|lock)|go\.(?:mod|sum)|pyproject\.toml|requirements[^/]*\.txt|CMakeLists\.txt|Makefile|kodo\.config\.json|tsconfig[^/]*\.json|\.[a-z]+rc(?:\.[a-z]+)?)$/i,
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

/** Files larger than this are not inspected; the receipt says so. */
const MAX_INSPECTED_BYTES = 262144;
const markers = {
  // A test case, not `regex.test(` and not a `describe` group. Linear: no nested quantifiers.
  cases:
    /(?<![.\w$])(?:test|it)(?:\s*\.\s*\w+){0,3}\s*[(`]|\bdef\s+test_\w+|#\[(?:\w+::)?test\]|\bfunc\s+Test\w+\s*\(|@Test\b/g,
  // Explicit ways to keep a test from running.
  skips:
    /(?<![.\w$])(?:test|it|describe|suite)\s*\.\s*(?:skip|todo|only)\b|(?<![.\w$])x(?:it|describe|test)\s*\(|\b(?:t|this|ctx|context)\.(?:skip|todo)\s*\(|\b(?:skip|todo)\s*:\s*(?!false\b)[^\s,}]|@pytest\.mark\.(?:skip|xfail)|pytest\.skip\s*\(|@(?:unittest\.)?skip\w*|#\[ignore\b|\bt\.Skip(?:f|Now)?\(|@(?:Disabled|Ignore)\b/g,
  assertions: /\bassert\w*|\bexpect\s*\(|\.should\b|\brequire\.\w+\(/g,
};
const count = (text, pattern) => (text.match(pattern) || []).length;
const hashComments = /\.(?:py|rb|sh|bash|zsh|ya?ml|toml)$/i;
/**
 * Remove comments, so a commented-out test is a removed test. Not string-aware:
 * `//` after a colon (a URL) is kept; this is a counter, not a parser.
 */
function withoutComments(file, text) {
  return hashComments.test(file)
    ? text.replace(/(^|\s)#.*$/gm, '$1')
    : text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

/** Marker counts of one revision of a file, or a reason why it was not inspected. Never throws. */
async function inspect(cwd, revision, file) {
  let result;
  try {
    result = await execute('git', ['show', `${revision}:${file}`], { cwd, allowFailure: true });
  } catch {
    return { reason: 'unreadable' };
  }
  if (result.code !== 0) return { reason: 'unreadable' };
  if (Buffer.byteLength(result.stdout) > MAX_INSPECTED_BYTES) return { reason: 'too_large' };
  const text = withoutComments(file, result.stdout);
  return {
    cases: count(text, markers.cases),
    skips: count(text, markers.skips),
    assertions: count(text, markers.assertions),
  };
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
 * Tests that existed on the base and were deleted, removed or switched off.
 *
 * A heuristic over marker counts, tuned to refuse the unambiguous cases and to
 * let honest test work through: cases are counted across all changed test
 * files, so moving or splitting tests is not a removal; fewer assertions is
 * only a warning. It cannot see semantic weakening (an early `return`,
 * `assert.ok(true)`); that stays with checks, oracles and review.
 * @param {{ cwd: string, baseSha: string, headSha: string }} input
 * @returns {Promise<{ findings: { rule: string, file: string, detail: string }[],
 *   warnings: { rule: string, file: string | null, detail: string }[], unchecked: { file: string, reason: string }[] }>}
 */
export async function testWeakening({ cwd, baseSha, headSha }) {
  const rows = [],
    unchecked = [];
  for (const { status, from, to } of await changes(cwd, baseSha, headSha)) {
    // A renamed test that no longer looks like a test to any runner is a removed test.
    const before = status !== 'A' && status !== 'C' && isTestFile(from) ? await inspect(cwd, baseSha, from) : null;
    const after = status !== 'D' && isTestFile(to) ? await inspect(cwd, headSha, to) : null;
    for (const [side, file] of [
      [before, from],
      [after, to],
    ])
      if (side?.reason) unchecked.push({ file, reason: side.reason });
    if (before?.reason || after?.reason) continue;
    if (before || after) rows.push({ status, from, to, before, after });
  }
  const sum = (side, field) => rows.reduce((total, row) => total + (row[side]?.[field] ?? 0), 0);
  const removedOverall = sum('after', 'cases') < sum('before', 'cases');
  const findings = [],
    warnings = [];
  for (const { status, from, to, before, after } of rows) {
    if (!before?.cases) continue; // New, or a helper or fixture without test cases.
    const file = after ? to : from;
    const now = after ?? { cases: 0, skips: 0, assertions: 0 };
    // Fewer cases here and no fewer overall is a move or a split, not a removal.
    if (removedOverall && now.cases < before.cases)
      findings.push(
        after
          ? { rule: 'tests_removed', file, detail: `test cases ${before.cases} -> ${now.cases}` }
          : {
              rule: 'test_deleted',
              file: from,
              detail:
                status === 'D'
                  ? `${before.cases} test cases removed with the file`
                  : `renamed to ${to}, which no test runner picks up`,
            },
      );
    if (now.skips > before.skips)
      findings.push({ rule: 'test_skipped', file, detail: `skip/only/todo markers ${before.skips} -> ${now.skips}` });
  }
  if (sum('after', 'assertions') < sum('before', 'assertions') && sum('after', 'cases') <= sum('before', 'cases'))
    warnings.push({
      rule: 'assertions_removed',
      file: null,
      detail: `assertions ${sum('before', 'assertions')} -> ${sum('after', 'assertions')} across changed tests`,
    });
  return { findings, warnings, unchecked };
}

/** Findings a repair session cannot fix: only a person can change the configuration. */
const unrepairable = new Set(['required_gate_disabled']);

/** Run one oracle; a crash or a timeout is a failure with its own evidence. */
async function runOracle(oracle, { cwd, signal, secrets, runner, persist }) {
  let exitCode = null,
    reason,
    output;
  try {
    const result = await runner(oracle.command, oracle.args, {
      cwd,
      signal,
      env: workerEnvironment(),
      secrets,
      timeoutMs: oracle.timeoutMs,
      allowFailure: true,
    });
    exitCode = result.code;
    output = (result.stdout + result.stderr).slice(-24000);
  } catch (error) {
    if (signal?.aborted || error.code === 'cancelled') throw error;
    // An oracle that did not finish proves nothing: it is a failure, not a pass.
    reason = ['timeout', 'ENOENT', 'EACCES', 'EPERM'].includes(error.code) ? error.code : 'execution_failed';
    output = `not completed: ${reason}`;
  }
  const evidence = persist
    ? await persist('oracle', { id: oracle.id, command: oracle.command, args: oracle.args, exitCode, output })
    : null;
  return {
    receipt: {
      id: oracle.id,
      status: exitCode === 0 ? 'passed' : 'failed',
      ...(reason ? { reason } : {}),
      exitCode,
      ...(evidence ? { outputPath: evidence.path, outputHash: evidence.sha256 } : {}),
    },
    detail: reason ? `${oracle.id}: ${reason}` : `${oracle.id} exit ${exitCode}: ${output.slice(-2000)}`,
  };
}

/**
 * Run the behaviour gate on a clean checkout of `headSha`.
 * @param {{ cwd: string, headSha: string, baseSha: string, config: Record<string, any>, signal?: AbortSignal,
 *   secrets?: Record<string, string>, runner?: typeof execute, isClean?: () => Promise<boolean>,
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
  isClean,
  persist,
}) {
  const verification = normalizeVerificationConfig(config.verification);
  const rows = await changes(cwd, baseSha, headSha);
  const paths = [...new Set(rows.flatMap(row => [row.from, row.to]))].sort();
  const policy = qualityPolicy({ types: classifyChange(paths), config, verification });
  const findings = [],
    allowed = [],
    warnings = [],
    unchecked = [];
  if (verification.strictGates)
    for (const gap of policy.gaps)
      findings.push({
        rule: 'required_gate_disabled',
        file: null,
        detail: `${gap.gate} gate is required for this change`,
      });
  if (verification.testProtection) {
    const tests = await testWeakening({ cwd, baseSha, headSha });
    warnings.push(...tests.warnings);
    unchecked.push(...tests.unchecked);
    // The run was explicitly allowed to remove these tests; the receipt still shows that it did.
    for (const finding of tests.findings)
      (ownsPath(verification.testRemovalAllowed, finding.file) ? allowed : findings).push(finding);
  }
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
    const { receipt, detail } = await runOracle(oracle, { cwd, signal, secrets, runner, persist });
    oracles.push(receipt);
    if (receipt.status !== 'passed') findings.push({ rule: 'oracle_failed', file: null, detail });
    // An oracle observes; one that changes the checked tree invalidates everything after it.
    if (isClean && !(await isClean())) {
      findings.push({ rule: 'oracle_dirty_worktree', file: null, detail: `${oracle.id} changed the checked worktree` });
      break;
    }
  }
  return {
    schemaVersion: BEHAVIOR_GATE_VERSION,
    headSha,
    baseSha,
    configHash: verificationConfigHash(config.verification),
    status: findings.length ? 'failed' : 'passed',
    passed: findings.length === 0,
    // Nothing a repair session could change: the run stops for a person instead of spending sessions.
    repairable: findings.some(finding => !unrepairable.has(finding.rule)),
    policy,
    findings,
    allowed,
    warnings,
    unchecked,
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
    // A baseline command that did not finish says nothing about the base.
    const classification =
      !base || base.exitCode === null
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
