/** Progress watchdog: decides from accepted facts whether a run is moving, and
 * keeps the concrete current blocker apart from older errors.
 *
 * Progress is a change of an accepted criterion: a node integrated, a check
 * command or gate that now passes, fewer confirmed findings. Lines, commits,
 * sessions and tool calls are deliberately not progress. The watchdog only
 * observes and stops; it never edits code or delivers. Its state is plain data
 * saved with the run, and every step is idempotent by its key.
 */
import { createHash } from 'node:crypto';
import { execute } from './command.mjs';

export const WATCHDOG_VERSION = 1;
const HISTORY = 20;
const hash = value => createHash('sha256').update(value).digest('hex');

/**
 * @typedef {object} WatchdogConfig
 * @property {number | null} stalledRounds Consecutive repair rounds without verified progress before the run stops; null disables the rule.
 * @property {boolean} rejectCosmetic A code or test node that changed only comments and whitespace is not complete.
 */

/**
 * @param {unknown} [value]
 * @returns {WatchdogConfig}
 */
export function normalizeWatchdogConfig(value = undefined) {
  const input = /** @type {Record<string, any>} */ (value === undefined ? {} : value);
  const invalid = () => Object.assign(new Error('Некорректная конфигурация Kodo: watchdog'), { code: 'configuration' });
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw invalid();
  for (const key of Object.keys(input)) if (!['stalledRounds', 'rejectCosmetic'].includes(key)) throw invalid();
  const rounds = input.stalledRounds;
  if (rounds !== undefined && rounds !== null && !(Number.isSafeInteger(rounds) && rounds >= 1 && rounds <= 5))
    throw invalid();
  if (input.rejectCosmetic !== undefined && typeof input.rejectCosmetic !== 'boolean') throw invalid();
  return { stalledRounds: rounds ?? null, rejectCosmetic: input.rejectCosmetic ?? false };
}

/**
 * The accepted facts of a run at one moment. Only these can show progress.
 * @param {any} run
 */
export function observeRun(run) {
  const nodes = Object.values(run.nodes || {});
  const gates = [run.uiVerification, run.securityChecks, run.architectureChecks];
  return {
    integrated: nodes.filter(node => node.status === 'integrated').length,
    checksPassed: (run.checks?.results || []).filter(row => row.exitCode === 0).length,
    behaviorPassed: run.behavior?.passed === true,
    behaviorFindings: Array.isArray(run.behavior?.findings) ? run.behavior.findings.length : null,
    gatesPassed: gates.filter(gate => gate?.passed === true).length,
    reviewPassed: run.review?.passed === true,
    reviewFindings: Array.isArray(run.review?.findings) ? run.review.findings.length : null,
  };
}

/**
 * Did any accepted criterion change for the better between two observations?
 * @param {ReturnType<typeof observeRun>} before
 * @param {ReturnType<typeof observeRun>} after
 */
export function verifiedProgress(before, after) {
  const fewer = (was, now) => typeof was === 'number' && typeof now === 'number' && now < was;
  const reasons = [
    after.integrated > before.integrated && 'node_integrated',
    after.checksPassed > before.checksPassed && 'check_passed',
    after.behaviorPassed && !before.behaviorPassed && 'behavior_gate_passed',
    fewer(before.behaviorFindings, after.behaviorFindings) && 'behavior_findings_resolved',
    after.gatesPassed > before.gatesPassed && 'gate_passed',
    after.reviewPassed && !before.reviewPassed && 'review_passed',
    fewer(before.reviewFindings, after.reviewFindings) && 'review_findings_resolved',
  ].filter(Boolean);
  return { progressed: reasons.length > 0, reasons };
}

const least = (a, b) => (typeof a !== 'number' ? b : typeof b !== 'number' ? a : Math.min(a, b));

/** The best accepted state seen so far: a round that breaks something and repairs it again adds nothing. */
function bestOf(a, b) {
  return {
    integrated: Math.max(a.integrated, b.integrated),
    checksPassed: Math.max(a.checksPassed, b.checksPassed),
    behaviorPassed: a.behaviorPassed || b.behaviorPassed,
    behaviorFindings: least(a.behaviorFindings, b.behaviorFindings),
    gatesPassed: Math.max(a.gatesPassed, b.gatesPassed),
    reviewPassed: a.reviewPassed || b.reviewPassed,
    reviewFindings: least(a.reviewFindings, b.reviewFindings),
  };
}

/**
 * One watchdog step after a failed round. A round progresses only when it
 * beats the best state reached so far. Repeating a step with the same key
 * changes nothing, so a crash between the step and its save is harmless.
 * @param {any} state Saved state, or undefined for the first step.
 * @param {{ key: string, observation: ReturnType<typeof observeRun>, limit: number | null }} input
 */
export function watchdogStep(state, { key, observation, limit }) {
  const previous = state?.schemaVersion === WATCHDOG_VERSION ? state : undefined;
  if (previous?.lastKey === key) return previous;
  const progress = previous?.best
    ? verifiedProgress(previous.best, observation)
    : { progressed: true, reasons: ['first_round'] };
  const stalled = progress.progressed ? 0 : previous.stalled + 1;
  const next = {
    schemaVersion: WATCHDOG_VERSION,
    lastKey: key,
    best: previous?.best ? bestOf(previous.best, observation) : observation,
    stalled,
    rounds: [...(previous?.rounds || []), { key, progressed: progress.progressed, reasons: progress.reasons }].slice(
      -HISTORY,
    ),
  };
  // A threshold is a diagnostic rule, not a guarantee: it stops the run for a human or a new approach.
  if (limit !== null && stalled >= limit) next.stopped = { reason: 'no_verified_progress', stalled, limit, key };
  return next;
}

/** An explicit retry cycle starts counting again; the history of rounds stays. */
export function resetWatchdog(state) {
  if (state?.schemaVersion !== WATCHDOG_VERSION) return state;
  const { stopped: _stopped, ...rest } = state;
  return { ...rest, stalled: 0, best: null };
}

const hints = {
  no_progress: 'The same failure repeated on the same commit: the repair did not change the failing behaviour.',
  no_verified_progress:
    'Several repair rounds changed no accepted criterion: the failure may be nondeterministic, or the repairs do not address it.',
  repair_budget_exhausted:
    'The repair budget ended while the failure kept changing; a different approach or a split is needed.',
  pre_existing: 'The failing check already failed on the base commit: the defect predates this change.',
  regression: 'The failing check passed on the base commit: this change introduced the failure.',
  behavior_failed:
    'A deterministic gate failed (weakened tests or a behavioural oracle); a review report cannot override it.',
  budget: 'The explicit session cap of this run is reached; a wider budget requires a new run.',
  context_budget: 'A session context exceeded the explicit limit; mandatory context is never shortened to fit.',
  quota: 'The provider subscription limit was reached; the saved session resumes after the retry time.',
};

/**
 * Record why a run stopped. The same blocker (the same reason, in the same
 * place, on the same commit) seen again is counted, not duplicated; a
 * different one moves the previous into history.
 * @param {any} blockers `{ current, history }` or undefined.
 * @param {{ code: string, message: string, scope: string, at: string, headSha?: string | null,
 *   reasons?: string[], evidence?: { sha256: string, kind?: string }[] }} blocker
 */
export function recordBlocker(blockers, { code, message, scope, at, headSha = null, reasons = [], evidence = [] }) {
  const text = String(message ?? '').slice(0, 2000);
  const signature = hash(JSON.stringify([code, scope, headSha]));
  let history = blockers?.history || [],
    current = blockers?.current;
  // A resume that stops for the same reason continues the same blocker instead of piling up copies.
  const last = history.at(-1);
  if (!current && last?.outcome === 'resumed' && last.signature === signature) {
    const { endedAt: _endedAt, outcome: _outcome, ...resumed } = last;
    current = resumed;
    history = history.slice(0, -1);
  }
  if (current?.signature === signature)
    return {
      current: { ...current, lastSeen: at, occurrences: current.occurrences + 1, lastMessage: text },
      history,
    };
  return {
    current: {
      code,
      scope,
      message: text,
      signature,
      firstSeen: at,
      lastSeen: at,
      occurrences: 1,
      headSha,
      // Candidate explanations derived from recorded facts; none is a verdict.
      hypotheses: [...new Set([code, ...reasons])].map(key => hints[key]).filter(Boolean),
      evidence: evidence.slice(0, 20).map(item => ({ sha256: item.sha256, ...(item.kind ? { kind: item.kind } : {}) })),
    },
    history: current ? [...history, { ...current, endedAt: at, outcome: 'replaced' }].slice(-HISTORY) : history,
  };
}

/**
 * The current blocker stops being current (the run resumed or succeeded). It
 * is kept in history, so an old error is never shown as the present one.
 * @param {any} blockers
 * @param {{ at: string, outcome: 'resumed' | 'succeeded' }} resolution
 */
export function resolveBlocker(blockers, { at, outcome }) {
  if (!blockers?.current) return blockers;
  return {
    current: null,
    history: [...(blockers.history || []), { ...blockers.current, endedAt: at, outcome }].slice(-HISTORY),
  };
}

/** Line-comment and block-comment syntax by file extension. An unknown extension is never judged cosmetic. */
const cLike = { line: /^\s*\/\//, block: true };
const hashLike = { line: /^\s*#(?!!)/, block: false };
const syntaxes = {
  ...Object.fromEntries(
    'js mjs cjs jsx ts mts cts tsx java c h cc cpp hpp cs go rs kt kts swift scala scss less'
      .split(' ')
      .map(ext => [ext, cLike]),
  ),
  css: { line: null, block: true },
  ...Object.fromEntries('py rb sh bash zsh yml yaml toml'.split(' ').map(ext => [ext, hashLike])),
};
const MAX_COSMETIC_FILES = 50;

function commentOnly(line, syntax) {
  if (!line.trim()) return true;
  if (syntax.line?.test(line)) return true;
  if (!syntax.block) return false;
  // `/* note */ code` is code: a block comment line may have nothing after its end.
  if (/^\s*\/\*/.test(line)) return !line.includes('*/') || /\*\/\s*$/.test(line);
  // A continuation line of a block comment. `*ptr = x;` and `*gen() {` are code.
  return /^\s*\*(?:\s|\/\s*$|$)/.test(line) && !/[;{]\s*$/.test(line);
}

/**
 * True only when the staged change against `baseSha` is certainly cosmetic:
 * nothing changed, or every changed line of every modified file is blank, a
 * comment, or differs in trailing whitespace. Anything else counts as real
 * work: added, deleted or renamed files, mode changes, binary files,
 * indentation (it is meaning in Python and YAML), unknown file types.
 * @param {string} cwd
 * @param {string} baseSha
 */
export async function cosmeticOnly(cwd, baseSha) {
  await execute('git', ['add', '-A'], { cwd });
  const base = ['diff', '--cached', '--no-color', '--no-ext-diff', '--no-renames'];
  const status = (await execute('git', [...base, '--name-status', '-z', baseSha, '--'], { cwd })).stdout
    .split('\0')
    .filter(Boolean);
  if (!status.length) return true;
  const files = [];
  for (let index = 0; index < status.length; index += 2) {
    if (status[index] !== 'M') return false;
    files.push(status[index + 1]);
  }
  if (files.length > MAX_COSMETIC_FILES) return false;
  if (/^ mode change /m.test((await execute('git', [...base, '--summary', baseSha, '--'], { cwd })).stdout))
    return false;
  for (const file of files) {
    const syntax = syntaxes[file.slice(file.lastIndexOf('.') + 1).toLowerCase()];
    if (!syntax) return false;
    const diff = await execute(
      'git',
      [...base, '-U0', '--ignore-space-at-eol', '--ignore-cr-at-eol', '--ignore-blank-lines', baseSha, '--', file],
      { cwd },
    );
    if (/^Binary files /m.test(diff.stdout)) return false;
    const changed = diff.stdout
      .split('\n')
      .filter(line => /^[+-]/.test(line) && !/^(?:\+\+\+|---) /.test(line))
      .map(line => line.slice(1));
    if (!changed.every(line => commentOnly(line, syntax))) return false;
  }
  return true;
}
