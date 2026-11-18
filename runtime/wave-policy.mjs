/**
 * The trusted verification policy of a wave Run: the check-related fields of
 * `kodo.config.json` in the verified commit, never in the user's checkout.
 * A task Run verifies under the policy of its base (the integration frontier);
 * a task may change the policy only when `kodo.config.json` is in its write
 * paths, and the epic gate then executes the new policy on its head. A gate Run
 * verifies under the policy of its gate head, and its verified head must keep it.
 */
import { createHash } from 'node:crypto';
import { execute } from './command.mjs';
import { normalizeConfig } from './config.mjs';
import { ownsPath } from './contracts.mjs';

/** The configuration fields that decide how a head is verified. */
export const WAVE_POLICY_FIELDS = Object.freeze([
  'commands',
  'verification',
  'security',
  'uiVerification',
  'architecture',
]);
export const CONFIG_FILE = 'kodo.config.json';
const sha = value => typeof value === 'string' && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value);
const fail = code => {
  throw Object.assign(new Error(`Project ${code}`), { code: `project_${code}` });
};

// Canonical JSON: sorted keys, so the hash is about values, not their order in the file.
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object')
    return `{${Object.keys(value)
      .filter(key => value[key] !== undefined)
      .sort()
      .map(key => `${JSON.stringify(key)}:${canonical(value[key])}`)
      .join(',')}}`;
  return JSON.stringify(value);
}

/**
 * The policy fields of a normalized configuration (absent fields stay absent).
 * @param {Record<string, any>} config
 */
export function wavePolicyOf(config) {
  return Object.fromEntries(
    WAVE_POLICY_FIELDS.filter(field => config?.[field] !== undefined).map(field => [field, config[field]]),
  );
}

/** SHA-256 of the canonical policy of a configuration. @param {Record<string, any>} config */
export const wavePolicyHash = config =>
  createHash('sha256')
    .update(canonical(wavePolicyOf(config)))
    .digest('hex');

/**
 * The normalized configuration of `kodo.config.json` in `commit` (defaults when the file is
 * absent) and its policy hash. An unreadable or invalid file is `project_wave_policy_invalid`.
 * @param {string} cwd a checkout of the repository
 * @param {string} commit
 */
export async function wavePolicyAt(cwd, commit) {
  if (!sha(commit)) fail('wave_policy_invalid');
  const listed = await execute('git', ['ls-tree', '--name-only', commit, '--', CONFIG_FILE], {
    cwd,
    allowFailure: true,
  });
  if (listed.code !== 0) fail('wave_policy_invalid');
  let file = {};
  if (listed.stdout.trim()) {
    const shown = await execute('git', ['show', `${commit}:${CONFIG_FILE}`], { cwd, allowFailure: true });
    if (shown.code !== 0) fail('wave_policy_invalid');
    try {
      file = JSON.parse(shown.stdout);
    } catch {
      fail('wave_policy_invalid');
    }
  }
  if (!file || typeof file !== 'object' || Array.isArray(file)) fail('wave_policy_invalid');
  let config;
  try {
    config = normalizeConfig(file);
  } catch {
    fail('wave_policy_invalid');
  }
  return { config, hash: wavePolicyHash(config) };
}

/**
 * Replace the policy fields of a wave Run draft with those of `commit` and record
 * `draft.wavePolicy = {schemaVersion: 1, commit, hash}`. Other settings stay the caller's.
 * @param {{ project: string, config: Record<string, any>, wavePolicy?: any }} draft
 * @param {string} commit
 */
export async function applyWavePolicy(draft, commit) {
  const { config, hash } = await wavePolicyAt(draft.project, commit);
  for (const field of WAVE_POLICY_FIELDS)
    if (config[field] === undefined) delete draft.config[field];
    else draft.config[field] = structuredClone(config[field]);
  draft.wavePolicy = { schemaVersion: 1, commit, hash };
  return draft;
}

/**
 * Whether a wave Run still verifies under the policy it recorded: its own configuration has the
 * recorded hash, which is the policy of `run.wavePolicy.commit` (`policyCommit`). `headSha`, when
 * given, is the verified head: its policy must be the same, unless `kodo.config.json` is one of
 * `writePaths` (a task that changes the policy; its epic gate executes the new one).
 * Throws `project_wave_policy_mismatch`.
 * @param {{ run: any, policyCommit: string, headSha?: string, writePaths?: string[] }} input
 */
export async function assertWavePolicy({ run, policyCommit, headSha, writePaths = [] }) {
  const own = wavePolicyHash(run.config);
  if (run.wavePolicy?.schemaVersion !== 1 || run.wavePolicy.commit !== policyCommit || run.wavePolicy.hash !== own)
    fail('wave_policy_mismatch');
  if ((await wavePolicyAt(run.project, policyCommit)).hash !== own) fail('wave_policy_mismatch');
  if (!headSha || headSha === policyCommit) return;
  if ((await wavePolicyAt(run.project, headSha)).hash !== own && !ownsPath(writePaths, CONFIG_FILE))
    fail('wave_policy_mismatch');
}
