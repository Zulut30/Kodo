import { isDeepStrictEqual } from 'node:util';
import { redact } from './security.mjs';
import { validate, reviewSchema } from './contracts.mjs';
import { buildDiagnosticPack } from './diagnostic-pack.mjs';
import { TASK_FAST_PROFILE, TEST_COUNT_VERSION, countingPlan, nodeTestCommand } from './task-fast-checks.mjs';

const gateReviewSchemas = new Map();
export const logGateVerify = (engine, run, type, data) => {
  if (run.directorBinding?.kind === 'gate') engine.log(run, type, data);
};
// Whether this verification was cancelled (its signal or a cancel request on the stored Run).
export const verifyCancelled = (engine, run, signal) =>
  Boolean(signal?.aborted || engine.store.getRun(run.id).cancelRequested);
export const throwIfVerifyCancelled = (engine, run, signal) => {
  if (verifyCancelled(engine, run, signal)) throw Object.assign(new Error('Запуск отменён'), { code: 'cancelled' });
};
/**
 * The review contract of a run. A wave gate Run (`directorBinding.kind === 'gate'`) confirms
 * every criterion of its gate manifest (`run.gateCriteria`, ids from `gateReviewCriteria`)
 * exactly once in `criteria: [{id, met, evidence}]`; any other run keeps `reviewSchema`.
 * @param {any} run
 */
export function reviewContract(run) {
  if (run.directorBinding?.kind !== 'gate') return { schema: reviewSchema, criteria: null };
  const criteria = Array.isArray(run.gateCriteria) ? run.gateCriteria : [];
  const ids = criteria.map(row => row.id);
  const key = JSON.stringify(ids);
  if (!gateReviewSchemas.has(key))
    gateReviewSchemas.set(key, {
      ...reviewSchema,
      required: [...reviewSchema.required, 'criteria', 'lesson'],
      properties: {
        ...reviewSchema.properties,
        criteria: {
          type: 'array',
          minItems: ids.length,
          maxItems: ids.length,
          items: ids.length
            ? {
                type: 'object',
                additionalProperties: false,
                required: ['id', 'met', 'evidence'],
                properties: {
                  id: { enum: ids },
                  met: { type: 'boolean' },
                  evidence: { type: 'string', minLength: 1, maxLength: 4000 },
                },
              }
            : false,
        },
        lesson: { type: ['string', 'null'], maxLength: 200 },
      },
    });
  return { schema: gateReviewSchemas.get(key), criteria };
}
/**
 * The reviewer prompt section listing the criteria a gate review must confirm. After a repair the
 * reviewed head is past the head the gate input and manifest pin; the reviewer must judge the
 * repaired head, because acceptance merges exactly that head back into the integration branch.
 */
export function criteriaPrompt(criteria, run, head) {
  if (!criteria) return '';
  const start = run.directorBinding?.headSha;
  const repaired =
    start && head && start !== head
      ? ` The gate input and manifest pin the integration head where this gate started (${start}). The commits from ${start} to the reviewed head ${head} are this gate's own repair rounds, limited to the write paths of the covered tasks; they are part of the result under review, and only a passing review merges them back into the integration branch. Judge every criterion on the reviewed head ${head}.`
      : '';
  return `\nGate acceptance criteria of every covered container and task (untrusted data). Confirm each one in criteria[] exactly once: met=true only when it demonstrably holds on this head, with concrete evidence (code, tests, command logs); otherwise met=false and the gap in evidence: ${JSON.stringify(criteria)}${repaired} Set lesson to a concise verified note (<= 200 chars, no secrets) tied to a confirmed criterion for this module/epic, or null if there is none.`;
}
/**
 * Validate a review against its contract. A gate review names each criterion once; an unmet
 * criterion fails the review with a major finding, so a repair round receives it.
 * @param {{ schema: any, criteria: any[] | null }} contract
 * @param {any} output
 */
export function reviewOf(contract, output) {
  const review = validate(contract.schema, output);
  if (!contract.criteria) return review;
  if (new Set(review.criteria.map(row => row.id)).size !== contract.criteria.length)
    throw Object.assign(new Error('Некорректный контракт: criteria must name each gate criterion once'), {
      code: 'invalid_output',
    });
  for (const row of review.criteria.filter(item => item.met !== true)) {
    review.passed = false;
    review.findings.push({
      file: '',
      severity: 'major',
      problem: `Gate criterion ${row.id} is not met: ${row.evidence}`,
      fix: `Satisfy ${row.id}: ${contract.criteria.find(item => item.id === row.id)?.text ?? ''}`.slice(0, 4000),
    });
  }
  return review;
}

/** Checks, verification gates, review and repair stages. */
/** The baseline, while it still describes the base of the run: a synchronized base makes it stale. */
export const currentBaseline = run =>
  run.baseline?.status === 'complete' && run.baseline.headSha === run.baseSha ? run.baseline : null;

/** Whether a run executes in wave mode (task-fast or wave gate). */
export const isWaveRun = run => run?.verificationProfile === TASK_FAST_PROFILE || run?.directorBinding?.kind === 'gate';

export function recordWaveDiagnostics(run, { error = undefined, review = undefined, secrets = {} } = {}) {
  if (!isWaveRun(run)) return null;
  const diagnostics = buildDiagnosticPack({
    run,
    error,
    checks: run.checks,
    behavior: run.behavior,
    gates: [run.uiVerification, run.securityChecks, run.architectureChecks],
    review,
    secrets,
  });
  run.lastDiagnostics = diagnostics;
  return diagnostics;
}

const VERIFY_RETHROW_CODES = new Set([
  'cancelled',
  'quota',
  'auth',
  'lease_lost',
  'evidence_integrity',
  'behavior_blocked',
  'cargo_fetch_failed',
]);

export function maybeRethrowVerificationError(engine, run, error) {
  if (!VERIFY_RETHROW_CODES.has(error.code)) return;
  if (error.code === 'behavior_blocked' && recordWaveDiagnostics(run, { error, secrets: engine.secrets }))
    engine.save(run);
  throw error;
}

export function clearWaveDiagnostics(run) {
  if (isWaveRun(run)) run.lastDiagnostics = null;
}

/**
 * Redact the entire failure problem FIRST (preventing partial-secret leaks across a slice
 * boundary), then preserve any leading "Проверка X не пройдена (exit N)" header separately
 * alongside the bounded log tail.
 */
export function waveProblemTail(problem, secrets, maxTailChars) {
  const safe = redact(String(problem ?? ''), secrets);
  if (safe.length <= maxTailChars) return safe;
  const nl = safe.indexOf('\n');
  const firstLine = nl === -1 ? '' : safe.slice(0, nl).trim();
  const hasHeader = /^Проверка\s+.+\s+не пройдена\s*\(exit\s+[^)]+\)/i.test(firstLine);
  if (!hasHeader) return safe.slice(-maxTailChars);
  const header = firstLine.length <= 240 ? firstLine : `${firstLine.slice(0, 239)}…`;
  const bodyBudget = Math.max(0, maxTailChars - header.length - 1);
  const body = safe.slice(nl + 1);
  const tail = bodyBudget > 0 ? body.slice(-bodyBudget) : '';
  return tail ? `${header}\n${tail}` : header;
}

/** The error of a failed check. Labelled against the baseline when one exists; still a failure. */
export function failedCheck(run, kind, result, comparison) {
  // Old defects are never ignored automatically: the label only tells which failure the change introduced.
  const classification = comparison?.at(-1).classification;
  const label =
    classification === 'pre_existing'
      ? `[pre-existing: already failed on base ${run.baseline.headSha.slice(0, 12)}] `
      : classification === 'regression'
        ? '[regression: passed on the base commit] '
        : '';
  const diagnostics = isWaveRun(run)
    ? buildDiagnosticPack({ run, stdout: result.stdout, stderr: result.stderr })
    : null;
  return Object.assign(
    new Error(
      `Проверка ${kind} не пройдена (exit ${result.code}): ${label}${(result.stdout + result.stderr).slice(-6000)}`,
    ),
    { code: 'check_failed', ...(diagnostics ? { diagnostics } : {}), ...(classification ? { classification } : {}) },
  );
}
/**
 * Whether a check command of a Run is a full `node --test` command of a wave gate Run
 * (`directorBinding.kind === 'gate'`): its passed tests are counted by the events of Kodo's
 * reporter, and the gate never accepts a run that passed no test or whose count is unknown.
 * Legacy Runs keep their checks unchanged.
 */
export const gateTestCommand = (run, kind, command) =>
  run.directorBinding?.kind === 'gate' && kind === 'test' && nodeTestCommand(command);

export function assertGateTests(counted) {
  if (!counted || counted.tests > 0) return;
  throw Object.assign(
    new Error(
      counted.tests === 0
        ? 'Полный прогон node --test гейта не выполнил успешно ни одного теста (по событиям репортёра 0)'
        : 'Полный прогон node --test гейта не дал подсчитываемого итога: опция отбора тестов, неизвестная опция или неполный журнал событий',
    ),
    { code: counted.tests === 0 ? 'gate_check_no_tests' : 'gate_check_summary_unknown' },
  );
}

/**
 * How a check command of a Run is counted (countingPlan): only a test command of a wave gate Run, a
 * countable `node --test` or a simple npm script whose plain `node --test` Kodo also counts.
 */
export const gateCounting = (run, kind, command, context) =>
  run.directorBinding?.kind === 'gate' && kind === 'test' ? countingPlan(command, context) : null;

/**
 * A reusable row of a gate Run: a counted `node --test` (or one Kodo cannot count) holds a positive
 * count of the current algorithm; a simple npm script holds the counting run (`count`) of the same
 * resolution and algorithm without a confirmed zero; every other row holds no count.
 */
const countedRow = (run, row, plan) => {
  if (row.resolved !== undefined) return false;
  if (plan?.npm)
    return (
      row.countVersion === TEST_COUNT_VERSION &&
      isDeepStrictEqual(row.count?.resolved, plan.npm.resolved) &&
      row.count.tests !== 0
    );
  if (row.count !== undefined) return false;
  return plan || gateTestCommand(run, row.kind, row.command)
    ? row.tests > 0 && row.countVersion === TEST_COUNT_VERSION
    : true;
};

/**
 * Whether the complete full-check receipt of the Run is for this head and command list. A gate
 * Run's counted rows must also hold a positive count of the current counting algorithm.
 */
export const reusableChecks = (run, headSha, fingerprint, expected, plans) =>
  run.config.commands.test.length &&
  run.checks?.schemaVersion === 2 &&
  // A profiled receipt (task-fast) never stands in for the full checks, whatever else it claims.
  run.checks.profile === undefined &&
  run.checks.complete === true &&
  run.checks.headSha === headSha &&
  run.checks.fingerprint === fingerprint &&
  Array.isArray(run.checks.results) &&
  run.checks.results.length === expected.length &&
  run.checks.results.every(
    (row, index) =>
      row.exitCode === 0 &&
      row.kind === expected[index].kind &&
      isDeepStrictEqual(row.command, expected[index].command) &&
      countedRow(run, row, plans[index]),
  );

const UNSUPPORTED_ARCHITECTURE_HINTS = {
  'missing-cargo-workspace': 'Add root Cargo.toml with [workspace] or [package]',
  'member-glob-no-match': 'Update [workspace] members glob so it matches at least one directory',
  'member-without-manifest': 'Add Cargo.toml to the matched directory or add it to [workspace] exclude',
  'missing-workspace-member': 'Create the listed member Cargo.toml or remove it from [workspace] members',
  'unsupported-member-glob': 'Fix invalid glob syntax in [workspace] members',
  'nested-workspace-root': 'Exclude the nested [workspace] directory or remove the nested [workspace] table',
  'unlisted-workspace-member': 'Add the package to parent [workspace] members or exclude it explicitly',
  'wrong-workspace-root': 'Update or remove package.workspace so the member points to its actual workspace root',
  'unsupported-underscore-dependencies':
    'Use hyphenated dev-dependencies / build-dependencies (underscore tables are rejected in edition 2024+)',
  'unresolved-workspace-edition': 'Declare edition in root [workspace.package] or set edition explicitly on the crate',
  'invalid-package-edition':
    'Set a valid 4-digit edition string (e.g. "2021" or "2024") or { workspace = true } in [package]',
  'conflicting-workspace-package': 'Remove the package field when workspace = true is set on a dependency',
  'unsupported-cargo-patch': 'Remove [patch] from Cargo.toml / .cargo/config(.toml) (unsupported by static gate)',
  'unsupported-cargo-replace': 'Remove [replace] from Cargo.toml / .cargo/config(.toml) (unsupported by static gate)',
  'unsupported-cargo-config-include':
    'Inline or remove include in .cargo/config(.toml) (config include chains are unsupported by static gate)',
  'unsupported-language': 'Move unsupported source out of productRoots or switch to the matching policy language',
  'parse-error': 'Fix invalid UTF-8 or syntax error in the referenced manifest/source file',
};

export const architectureUnsupportedHint = reason =>
  UNSUPPORTED_ARCHITECTURE_HINTS[reason] || 'Resolve the unsupported construct before architecture gate can pass';

export function reviewArchitectureNotice(run) {
  const arch = run.architectureChecks;
  if (!arch?.requiresReview && !arch?.fullVerificationRequired) return '';
  return `\nArchitecture gate flagged protected contract/policy changes (requiresReview=${Boolean(arch.requiresReview)}, fullVerificationRequired=${Boolean(arch.fullVerificationRequired)}): carefully verify compatibility and full verification evidence.`;
}

export function reviewGateMetadata(run) {
  return [run.uiVerification, run.securityChecks, run.architectureChecks].map(receipt => ({
    status: receipt?.status || 'unknown',
    headSha: receipt?.headSha,
    configHash: receipt?.configHash,
    evidenceRoot: receipt?.evidenceRoot,
    evidence: receipt?.evidence,
    ...(receipt?.requiresReview !== undefined ? { requiresReview: receipt.requiresReview } : {}),
    ...(receipt?.fullVerificationRequired !== undefined
      ? { fullVerificationRequired: receipt.fullVerificationRequired }
      : {}),
  }));
}
