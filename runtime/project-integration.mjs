import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { lstat, realpath } from 'node:fs/promises';
import { execute, gitBoundary } from './command.mjs';
import { git, makeWorktree, withWorktreeLock } from './workspace.mjs';
import { ownsPath } from './contracts.mjs';
import { secretFile } from './security.mjs';

// Git layer of a wave project's shared integration branch. It never touches the
// user's checkout, branch or HEAD: all merges happen in a private linked
// worktree outside it. Serializing merges (lease `project-integration:<id>`)
// belongs to the caller, which may pass that lease as the `withLease` port.
const fail = code => {
  throw Object.assign(new Error(`Project ${code}`), { code: `project_${code}` });
};
const sha = value => typeof value === 'string' && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value);
const slug = value => typeof value === 'string' && /^[a-z][a-z0-9-]{0,47}$/.test(value);
const prefix = 'kodo/project/';
// Repository data (paths, worktree records, file names) is read raw: redaction would change the
// very names the decisions below are about (a path `a&key=x/credentials.json` reads `a&key=[REDACTED]`).
const rawGit = (cwd, args) => git(cwd, args, { rawOutput: true });

export function integrationBranch(projectId) {
  if (typeof projectId !== 'string' || !/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,62}[A-Za-z0-9])?$/.test(projectId))
    fail('integration_invalid');
  return `${prefix}${projectId}`;
}

// Resolve through the nearest existing ancestor so a not-yet-created directory
// is compared with the same canonical spelling as the checkout.
async function canonical(target) {
  let current = path.resolve(target);
  const rest = [];
  for (;;) {
    try {
      const resolved = path.join(await realpath(current), ...rest.reverse());
      return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
    } catch (error) {
      const parent = path.dirname(current);
      if (error.code !== 'ENOENT' || parent === current) throw error;
      rest.unshift(path.basename(current));
      current = parent;
    }
  }
}
const inside = (parent, child) => {
  const relative = path.relative(parent, child);
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
};

function parseWorktrees(output) {
  return output
    .split(/\r?\n\r?\n/)
    .map(block => {
      const record = {};
      for (const line of block.split(/\r?\n/).filter(Boolean)) {
        const space = line.indexOf(' ');
        record[space === -1 ? line : line.slice(0, space)] = space === -1 ? true : line.slice(space + 1);
      }
      return record;
    })
    .filter(record => typeof record.worktree === 'string');
}

/**
 * The project's integration branch and its private worktree. The worktree is accepted only at its
 * canonical path `<worktreeHome>/project-<projectId>/integration` (compared by realpath): a branch
 * checked out by any other worktree (a user's linked checkout, also next to the canonical one
 * after `git switch --ignore-other-worktrees`) is `project_integration_branch_busy` before any Git
 * operation changes anything, so Kodo never moves another checkout's HEAD.
 * @param {{ root: string, projectId: string, worktreeHome: string }} options
 */
export async function ensureIntegration({ root, projectId, worktreeHome }) {
  const branch = integrationBranch(projectId);
  if (typeof root !== 'string' || typeof worktreeHome !== 'string' || !path.isAbsolute(worktreeHome))
    fail('integration_worktree_invalid');
  const checkout = await rawGit(root, ['rev-parse', '--show-toplevel']);
  const userCheckout = await canonical(checkout);
  const expected = path.join(path.resolve(worktreeHome), `project-${projectId}`, 'integration');
  const own = await canonical(expected);
  if (inside(userCheckout, own)) fail('integration_worktree_invalid');
  // Every worktree that has the branch open, not only the first one listed.
  const holders = async () =>
    parseWorktrees(await rawGit(checkout, ['worktree', 'list', '--porcelain'])).filter(
      record => record.branch === `refs/heads/${branch}`,
    );
  let found = await holders();
  if (found.some(record => record.prunable)) {
    // A registered directory is gone; drop only stale registrations and attach the
    // surviving branch again below.
    await withWorktreeLock(checkout, () => git(checkout, ['worktree', 'prune']));
    found = await holders();
  }
  for (const record of found)
    if (record.prunable || (await canonical(path.resolve(record.worktree))) !== own) fail('integration_branch_busy');
  const worktree = expected;
  if (!found.length) {
    const base = await git(checkout, ['rev-parse', '--verify', 'HEAD^{commit}']);
    // An existing branch without a worktree is attached as is, never reset.
    await makeWorktree(checkout, worktree, branch, base);
  }
  return { branch, worktree, head: await git(worktree, ['rev-parse', '--verify', 'HEAD^{commit}']) };
}

// Only a linked worktree on an integration branch may be merged into or reset.
// This guard keeps `merge --abort` and `reset --hard` away from the user's main checkout.
async function integrationWorktree(worktree) {
  if (typeof worktree !== 'string' || !path.isAbsolute(worktree)) fail('integration_worktree_invalid');
  const [gitDir, commonDir] = (
    await rawGit(worktree, ['rev-parse', '--path-format=absolute', '--git-dir', '--git-common-dir'])
  ).split(/\r?\n/);
  const branch = await rawGit(worktree, ['branch', '--show-current']);
  if (!gitDir || !commonDir || (await canonical(gitDir)) === (await canonical(commonDir)) || !branch.startsWith(prefix))
    fail('integration_worktree_invalid');
  return branch;
}

// Per-worktree state of an unfinished Git operation. A merge may start only when
// none exists: a merge or cherry-pick with no net change keeps its state file
// while `git status --porcelain` is empty.
const unfinishedStates = [
  'MERGE_HEAD',
  'CHERRY_PICK_HEAD',
  'REVERT_HEAD',
  'rebase-merge',
  'rebase-apply',
  'sequencer',
  'BISECT_LOG',
];

async function unfinishedOperations(worktree) {
  const paths = (
    await rawGit(worktree, [
      'rev-parse',
      '--path-format=absolute',
      ...unfinishedStates.flatMap(name => ['--git-path', name]),
    ])
  ).split(/\r?\n/);
  if (paths.length !== unfinishedStates.length) fail('integration_worktree_invalid');
  const found = [];
  for (const [index, name] of unfinishedStates.entries())
    if (await lstat(path.resolve(worktree, paths[index])).catch(() => null)) found.push(name);
  return found;
}

// ...and it must also be clean, with no unfinished operation.
async function assertIntegrationWorktree(worktree) {
  const branch = await integrationWorktree(worktree);
  if (
    (await git(worktree, ['status', '--porcelain=v1', '--untracked-files=all'])) ||
    (await unfinishedOperations(worktree)).length
  )
    fail('integration_worktree_invalid');
  return branch;
}

async function ancestor(worktree, base, head) {
  return (
    (await execute('git', ['merge-base', '--is-ancestor', base, head], { cwd: worktree, allowFailure: true })).code ===
    0
  );
}

async function headOf(worktree) {
  return git(worktree, ['rev-parse', '--verify', 'HEAD^{commit}']);
}

async function assertCommit(worktree, commit) {
  const found = await execute('git', ['rev-parse', '--verify', '--quiet', `${commit}^{commit}`], {
    cwd: worktree,
    allowFailure: true,
  });
  if (found.code !== 0 || found.stdout.trim() !== commit) fail('integration_invalid');
}

/**
 * The head of the project's integration branch `kodo/project/<projectId>` (null when absent).
 * @param {{ cwd: string, projectId: string }} options
 */
/**
 * Whether `head` is on the project's integration branch: true, false (confirmed, also when the
 * branch does not exist) or null when Git could not answer (an unreadable object, a locked file).
 * Callers must not treat null as absence: a merge that was published may only be unreadable now.
 * @param {{ cwd: string, projectId: string, head: string }} input
 * @returns {Promise<boolean | null>}
 */
export async function headOnIntegrationBranch({ cwd, projectId, head }) {
  const branch = await execute(
    'git',
    ['rev-parse', '--verify', '--quiet', `refs/heads/${integrationBranch(projectId)}^{commit}`],
    { cwd, allowFailure: true },
  );
  // `--verify --quiet` exits 1 without output for a missing ref; anything else is not an answer.
  if (branch.code === 1 && !branch.stdout.trim()) return false;
  if (branch.code !== 0) return null;
  const ancestor = await execute('git', ['merge-base', '--is-ancestor', head, branch.stdout.trim()], {
    cwd,
    allowFailure: true,
  });
  if (ancestor.code === 0) return true;
  return ancestor.code === 1 ? false : null;
}

export async function integrationHeadOf({ cwd, projectId }) {
  const found = await execute(
    'git',
    ['rev-parse', '--verify', '--quiet', `refs/heads/${integrationBranch(projectId)}^{commit}`],
    { cwd, allowFailure: true },
  );
  return found.code === 0 && sha(found.stdout.trim()) ? found.stdout.trim() : null;
}

async function parentsOf(cwd, commit) {
  const found = await execute('git', ['rev-list', '--parents', '-n', '1', commit], { cwd, allowFailure: true });
  return found.code === 0 ? found.stdout.trim().split(' ').slice(1) : null;
}

const parseParents = text =>
  text
    .split(/\r?\n/)
    .filter(Boolean)
    .map(line => {
      const [commit, ...parents] = line.trim().split(' ');
      return { commit, parents };
    });

/**
 * Whether a task merge recorded by its Run is still on the integration branch: `mergeCommit`
 * is reachable from `branchHead` and its parents are exactly `before` (first) and `mergedHead`.
 * @param {{ cwd: string, branchHead: string, mergeCommit: string, before: string, mergedHead: string }} options
 */
export async function mergeOnBranch({ cwd, branchHead, mergeCommit, before, mergedHead }) {
  if (![branchHead, mergeCommit, before, mergedHead].every(sha)) return false;
  const parents = await parentsOf(cwd, mergeCommit);
  return Boolean(
    parents?.length === 2 &&
    parents[0] === before &&
    parents[1] === mergedHead &&
    (await ancestor(cwd, mergeCommit, branchHead)),
  );
}

/**
 * The parents of every merge of a gate when `baseSha..headSha` is its range: each merge lies on
 * the first-parent history of `headSha` after `baseSha`, and the earliest of them has `baseSha`
 * as its first parent, so the range is non-empty and contains all of them. Null otherwise.
 * One Git call. `headSha` may also be a later head of the integration branch.
 * @param {{ cwd: string, baseSha: string, headSha: string, mergeCommits: string[] }} options
 * @returns {Promise<Map<string, string[]> | null>}
 */
export async function gateRange({ cwd, baseSha, headSha, mergeCommits }) {
  if (!sha(baseSha) || !sha(headSha) || baseSha === headSha || !Array.isArray(mergeCommits) || !mergeCommits.length)
    return null;
  if (!mergeCommits.every(sha)) return null;
  const found = await execute('git', ['rev-list', '--first-parent', '--parents', headSha, `^${baseSha}`], {
    cwd,
    allowFailure: true,
  });
  const history = found.code === 0 ? parseParents(found.stdout) : [];
  const parents = new Map(history.map(row => [row.commit, row.parents]));
  const earliest = history.at(-1);
  if (
    !earliest ||
    !mergeCommits.includes(earliest.commit) ||
    earliest.parents[0] !== baseSha ||
    !mergeCommits.every(commit => parents.get(commit)?.length === 2)
  )
    return null;
  return new Map(mergeCommits.map(commit => [commit, parents.get(commit)]));
}

/**
 * The base of a gate over `mergeCommits` on `headSha`: the first parent of the earliest of them
 * on the first-parent history of the head (see gateRange); anything else is refused.
 * @param {{ cwd: string, headSha: string, mergeCommits: string[] }} options
 */
export async function gateBase({ cwd, headSha, mergeCommits }) {
  if (!sha(headSha) || !Array.isArray(mergeCommits) || !mergeCommits.length || !mergeCommits.every(sha))
    fail('integration_invalid');
  const found = await execute('git', ['rev-list', '--no-walk=unsorted', '--parents', '--stdin'], {
    cwd,
    input: `${mergeCommits.join('\n')}\n`,
    allowFailure: true,
  });
  const rows = found.code === 0 ? parseParents(found.stdout) : [];
  if (rows.length !== new Set(mergeCommits).size || rows.some(row => row.parents.length !== 2))
    fail('integration_invalid');
  // The oldest first parent: merges on one first-parent history have ordered first parents.
  let base = null;
  for (const parent of new Set(rows.map(row => row.parents[0])))
    if (!base || (await ancestor(cwd, parent, base))) base = parent;
  if (!(await gateRange({ cwd, baseSha: base, headSha, mergeCommits }))) fail('integration_invalid');
  return base;
}

/**
 * Whether the trees of `from` and `to` differ (a non-empty diff to review).
 * @param {{ cwd: string, from: string, to: string }} options
 */
export async function treesDiffer({ cwd, from, to }) {
  if (!sha(from) || !sha(to)) fail('integration_invalid');
  const found = await execute('git', ['diff', '--quiet', '--no-ext-diff', from, to], { cwd, allowFailure: true });
  if (![0, 1].includes(found.code)) fail('integration_invalid');
  return found.code === 1;
}

/** @param {{ worktree: string, mergeCommits?: string[] }} options */
export async function waveFrontier({ worktree, mergeCommits = [] }) {
  if (!Array.isArray(mergeCommits)) fail('frontier_integration_missing');
  const head = await headOf(worktree);
  for (const commit of mergeCommits)
    if (!sha(commit) || !(await ancestor(worktree, commit, head))) fail('frontier_integration_missing');
  return head;
}

// After a crash between the merge and its durable record, the task head is
// already integrated. Recover the original merge from first-parent history.
async function existingMerge(worktree, taskHead) {
  // Commits reachable from the task head cannot be its merge; this bounds the walk.
  const lines = (await git(worktree, ['rev-list', '--first-parent', '--merges', '--parents', 'HEAD', `^${taskHead}`]))
    .split(/\r?\n/)
    .filter(Boolean);
  for (const line of lines) {
    const [mergeCommit, before, mergedHead, ...extra] = line.split(' ');
    if (mergedHead === taskHead && !extra.length) return { before, mergeCommit };
  }
  return fail('integration_invalid');
}

const coded = code => Object.assign(new Error(`Project ${code}`), { code });

// A ref's current value, synchronously: the SHA, null when it does not exist, undefined when Git
// could not answer (did not run, timed out, failed otherwise).
function refValue(cwd, ref, timeoutMs) {
  const { args, env } = gitBoundary(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], process.env);
  const found = spawnSync('git', args, { cwd, env, encoding: 'utf8', timeout: timeoutMs, windowsHide: true });
  if (found.error || found.status === null) return undefined;
  if (found.status === 0) return found.stdout.trim();
  return found.status === 1 && !found.stdout.trim() ? null : undefined;
}

/**
 * Change refs in one atomic, synchronous `git update-ref --stdin` transaction (hooks off):
 * `verify` rows must still hold their SHA and each `update` moves a ref from `expected` to `next`.
 * Synchronous on purpose: the caller may run it inside an open SQLite write transaction that
 * fences its lease tokens (`publishRefs` in runtime/project-publish.mjs), so no other process can
 * take the lease between the token check and the ref change. A `verify` row that no longer holds
 * is `project_submission_stale` (the worker moved its branch); any other refusal is
 * `project_lease_lost` (another holder moved the branch).
 * @param {string} cwd
 * @param {{ verify?: { ref: string, sha: string }[], update: { ref: string, next: string, expected: string }[] }} commands
 * @param {{ timeoutMs?: number }} [options]
 */
export function updateRefsAtomically(cwd, { verify = [], update }, { timeoutMs = 5000 } = {}) {
  const valid = row => typeof row?.ref === 'string' && row.ref.startsWith('refs/heads/') && !/\s/.test(row.ref);
  if (
    !Array.isArray(verify) ||
    !Array.isArray(update) ||
    !update.length ||
    !verify.every(row => valid(row) && sha(row.sha)) ||
    !update.every(row => valid(row) && sha(row.next) && sha(row.expected))
  )
    fail('integration_invalid');
  const input = [
    'start',
    ...verify.map(row => `verify ${row.ref} ${row.sha}`),
    ...update.map(row => `update ${row.ref} ${row.next} ${row.expected}`),
    'commit',
    '',
  ].join('\n');
  const { args, env } = gitBoundary(['update-ref', '--stdin'], process.env);
  const result = spawnSync('git', args, { cwd, env, input, encoding: 'utf8', timeout: timeoutMs, windowsHide: true });
  if (result.status === 0) return;
  // A Git that did not run or timed out changed nothing that can be trusted: a lost publish at
  // once. A refused transaction is classified by `refusedPublish` after the caller's SQLite
  // transaction ended (no second Git call while the write lock is held).
  if (result.error || result.status === null) throw coded('project_lease_lost');
  throw Object.assign(coded('project_lease_lost'), { refused: true });
}

/**
 * The code of a refused ref transaction (outside any SQLite transaction): `project_submission_stale`
 * when a `verify` row (the worker's branch) moved, otherwise the error itself.
 * @param {any} error
 * @param {string} cwd
 * @param {{ ref: string, sha: string }[]} [verify]
 */
export function refusedPublish(error, cwd, verify = []) {
  if (error?.refused !== true) return error;
  // Only a worker ref read back with another value (or gone) is stale; an unanswered read keeps
  // the original lost-publish error rather than guessing that the worker moved.
  const values = verify.map(row => refValue(cwd, row.ref, 5000));
  if (values.includes(undefined)) return error;
  return values.some((value, index) => value !== verify[index].sha) ? coded('project_submission_stale') : error;
}

/** The default ref publisher: the atomic update without a lease fence (callers without a Store). */
export const atomicPublisher = async ({ cwd, verify, update }) => {
  try {
    updateRefsAtomically(cwd, { verify, update });
  } catch (error) {
    throw refusedPublish(error, cwd, verify);
  }
};

// The worktree that has the integration branch checked out follows the branch's current head
// (never moves the branch itself), under the repository's worktree lock.
async function syncWorktree(worktree) {
  await withWorktreeLock(worktree, () => git(worktree, ['reset', '--quiet', '--hard', 'HEAD']));
}

// The integration branch moves only through `publish` (an atomic ref transaction; in production
// fenced by the holder's lease tokens): a holder whose branch another holder moved, or whose lease
// passed on, changes nothing. `verify` rows (the worker's branch on its verified head) are checked
// in the same ref transaction.
/**
 * @param {string} worktree
 * @param {string} branch
 * @param {string} next
 * @param {string} expected
 * @param {(commands: { cwd: string, verify: any[], update: any[] }) => Promise<unknown>} [publish]
 * @param {{ ref: string, sha: string }[]} [verify]
 */
async function advanceBranch(worktree, branch, next, expected, publish = atomicPublisher, verify = []) {
  await publish({ cwd: worktree, verify, update: [{ ref: `refs/heads/${branch}`, next, expected }] });
  await syncWorktree(worktree);
}

// A crash between publishing a merge and syncing the worktree leaves the branch on the merge
// commit while the index and files still are the saved `before`. Exactly that state (no unfinished
// operation, no untracked file, index tree = tree of `before`, files = index) is synced to the
// branch head; any other state is left for assertIntegrationWorktree to refuse.
async function resumePublishedMerge(worktree, pending) {
  if (!sha(pending?.mergeCommit)) return;
  await integrationWorktree(worktree);
  if ((await headOf(worktree)) !== pending.mergeCommit) return;
  if ((await unfinishedOperations(worktree)).length) return;
  if (await git(worktree, ['ls-files', '--others', '--exclude-standard'])) return;
  const index = await execute('git', ['write-tree'], { cwd: worktree, allowFailure: true });
  if (index.code !== 0 || index.stdout.trim() !== (await git(worktree, ['rev-parse', `${pending.before}^{tree}`])))
    return;
  if ((await execute('git', ['diff', '--quiet'], { cwd: worktree, allowFailure: true })).code !== 0) return;
  await syncWorktree(worktree);
}

// `merge.verifySignatures` keeps its meaning for Kodo's merges: the task head must carry a valid
// signature (`project_integration_unverified_signature` otherwise).
async function assertSignature(worktree, taskHead) {
  const setting = await execute('git', ['config', '--type=bool', '--get', 'merge.verifySignatures'], {
    cwd: worktree,
    allowFailure: true,
  });
  if (setting.code !== 0 || setting.stdout.trim() !== 'true') return;
  const verified = await execute('git', ['verify-commit', taskHead], { cwd: worktree, allowFailure: true });
  if (verified.code !== 0) fail('integration_unverified_signature');
}

// The merge commit of `head` into `before` (first parent `before`), built without touching any
// worktree or branch (`merge-tree --write-tree`, the same ort merge as `git merge`).
async function mergeCommitOf(worktree, before, head, message) {
  const tree = await execute('git', ['merge-tree', '--write-tree', '--no-messages', before, head], {
    cwd: worktree,
    allowFailure: true,
  });
  if (tree.code === 1) fail('integration_conflict');
  if (tree.code !== 0) fail('integration_invalid');
  const treeSha = tree.stdout.trim().split(/\r?\n/)[0];
  return git(worktree, ['commit-tree', treeSha, '-p', before, '-p', head, '-m', message]);
}

async function abortMerge(worktree, before) {
  await execute('git', ['merge', '--abort'], { cwd: worktree, allowFailure: true });
  if ((await headOf(worktree)) !== before || (await git(worktree, ['status', '--porcelain=v1'])))
    await git(worktree, ['reset', '--hard', before]);
}

async function verifiedMerge(worktree, before, taskHead, writePaths, commit = 'HEAD') {
  const [first, second, third] = (await git(worktree, ['rev-list', '--parents', '-n', '1', commit]))
    .split(' ')
    .slice(1);
  const changed = (await rawGit(worktree, ['diff', '--no-renames', '--name-only', '-z', before, commit]))
    .split('\0')
    .filter(Boolean);
  return (
    first === before && second === taskHead && third === undefined && changed.every(name => ownsPath(writePaths, name))
  );
}

// A crash after savePending but before the merge commit leaves MERGE_HEAD. Only
// our own interrupted merge (the only unfinished operation, HEAD = the saved
// `before`, MERGE_HEAD = this task head) is aborted. Any other unfinished
// operation, or one without `pending`, belongs to someone else: it is refused
// at once and left untouched.
async function abandonInterruptedMerge(worktree, pending, taskHead) {
  await integrationWorktree(worktree);
  const unfinished = await unfinishedOperations(worktree);
  if (!unfinished.length) return;
  if (!pending || unfinished.length !== 1 || unfinished[0] !== 'MERGE_HEAD') fail('integration_worktree_invalid');
  const mergeHead = await execute('git', ['rev-parse', '--verify', '--quiet', 'MERGE_HEAD'], {
    cwd: worktree,
    allowFailure: true,
  });
  if (mergeHead.code !== 0 || mergeHead.stdout.trim() !== taskHead || (await headOf(worktree)) !== pending.before)
    fail('integration_worktree_invalid');
  await abortMerge(worktree, pending.before);
}

/** The most commits of one task history that are inspected; a longer history is refused. */
export const HISTORY_LIMIT = 1000;
/** The largest blob whose bytes are compared with the known secret values. */
export const SECRET_SCAN_BYTES = 16 * 1024 * 1024;
/** The most blob bytes one history inspection reads; past it the history is unverifiable. */
export const HISTORY_SCAN_BYTES = 128 * 1024 * 1024;
const BLOB_TIMEOUT_MS = 60000;
const specialMode = mode => mode === '120000' || mode === '160000';

// The raw entries of one commit against each of its parents: {from, to, blob, path}.
async function commitEntries(cwd, commit) {
  const found = await execute(
    'git',
    ['diff-tree', '-r', '-m', '--root', '--no-renames', '--no-commit-id', '--raw', '-z', '--no-abbrev', commit],
    { cwd, allowFailure: true, rawOutput: true },
  );
  if (found.code !== 0) fail('integration_invalid');
  const tokens = found.stdout.split('\0'),
    entries = [];
  for (let index = 0; index < tokens.length; index++) {
    const meta = /^:(\d{6}) (\d{6}) [a-f0-9]+ ([a-f0-9]+) [A-Z]\d*$/.exec(tokens[index].trim());
    if (meta) entries.push({ from: meta[1], to: meta[2], blob: meta[3], path: tokens[++index] });
  }
  return entries;
}

// The raw bytes of one blob (never redacted, never decoded as text), or null when Git fails or
// the blob holds more than `limit` bytes.
function blobBytes(cwd, blob, limit) {
  const boundary = gitBoundary(['cat-file', 'blob', blob], process.env);
  return new Promise(resolve => {
    const child = spawn('git', boundary.args, {
      cwd,
      env: boundary.env,
      windowsHide: true,
      shell: false,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const chunks = [];
    let size = 0;
    const timer = setTimeout(() => child.kill(), BLOB_TIMEOUT_MS);
    child.stdout.on('data', chunk => {
      size += chunk.length;
      if (size > limit) child.kill();
      else chunks.push(chunk);
    });
    const done = value => {
      clearTimeout(timer);
      resolve(value);
    };
    child.on('error', () => done(null));
    child.on('close', code => done(code === 0 && size <= limit ? Buffer.concat(chunks) : null));
  });
}

// Whether a regular blob holds one of `needles` (raw bytes): `secret`, `clean`, or `unverifiable`
// when it is larger than SECRET_SCAN_BYTES or than the rest of the budget, or cannot be read.
async function scanBlob(cwd, blob, needles, budget) {
  const size = await execute('git', ['cat-file', '-s', blob], { cwd, allowFailure: true, rawOutput: true });
  const bytes = size.code === 0 && /^\d+$/.test(size.stdout.trim()) ? Number(size.stdout.trim()) : NaN;
  if (!Number.isSafeInteger(bytes) || bytes > SECRET_SCAN_BYTES || bytes > budget.left) return 'unverifiable';
  budget.left -= bytes;
  const content = await blobBytes(cwd, blob, bytes);
  if (!content || content.length !== bytes) return 'unverifiable';
  return needles.some(needle => content.includes(needle)) ? 'secret' : 'clean';
}

/**
 * Inspect every commit of `base..head` (reachable from head, not from base), not only the
 * result: a file a commit adds and a later commit deletes still enters the branch history.
 * Each changed path must be inside `writePaths` and not a secret file (`secretFile`), no
 * symbolic link or submodule may appear, and no added content may hold a value of `secrets`.
 * Paths and contents are compared raw (never redacted), contents as bytes; a blob that cannot be
 * compared within SECRET_SCAN_BYTES (each) and HISTORY_SCAN_BYTES (all) is `unverifiable`.
 * Returns null, or the first defect `{kind, commit, file}` with kind `scope`, `secret_path`,
 * `special`, `secret`, `unverifiable` or `too_long` (more than HISTORY_LIMIT commits).
 * @param {{ cwd: string, base: string, head: string, writePaths: string[], secrets?: Record<string, unknown> }} options
 */
export async function inspectHistory({ cwd, base, head, writePaths, secrets = {} }) {
  if (!sha(base) || !sha(head) || !Array.isArray(writePaths) || !writePaths.length) fail('integration_invalid');
  const listed = await execute('git', ['rev-list', '--reverse', head, `^${base}`], { cwd, allowFailure: true });
  if (listed.code !== 0) fail('integration_invalid');
  const commits = listed.stdout.split(/\r?\n/).filter(Boolean);
  if (commits.length > HISTORY_LIMIT) return { kind: 'too_long', commit: null, file: null };
  const values = /** @type {string[]} */ (
    Object.values(secrets).filter(value => typeof value === 'string' && value.length > 5)
  );
  const needles = [...new Set(values)].map(value => Buffer.from(value, 'utf8'));
  const scanned = new Set(),
    budget = { left: HISTORY_SCAN_BYTES };
  for (const commit of commits)
    for (const entry of await commitEntries(cwd, commit)) {
      const defect = (kind, file = entry.path) => ({ kind, commit, file });
      if (secretFile(entry.path)) return defect('secret_path');
      if (specialMode(entry.from) || specialMode(entry.to)) return defect('special');
      if (!ownsPath(writePaths, entry.path)) return defect('scope');
      if (!needles.length || entry.to === '000000' || scanned.has(entry.blob)) continue;
      scanned.add(entry.blob);
      const verdict = await scanBlob(cwd, entry.blob, needles, budget);
      if (verdict !== 'clean') return defect(verdict);
    }
  return null;
}

// The merge `commit` of `taskHead` onto `before`: its result must stay inside the write paths
// (`integration_scope`) and so must every commit it brings in (`integration_history`); a history
// whose contents cannot be compared within the budget is `integration_history_unverifiable`.
async function mergeDefect(worktree, before, taskHead, writePaths, secrets, commit = 'HEAD') {
  if (!(await verifiedMerge(worktree, before, taskHead, writePaths, commit))) return 'integration_scope';
  const found = await inspectHistory({ cwd: worktree, base: before, head: taskHead, writePaths, secrets });
  if (found) return found.kind === 'unverifiable' ? 'integration_history_unverifiable' : 'integration_history';
  return null;
}

/**
 * `pending` is the value an earlier attempt passed to `savePending` (null when none was saved).
 * Besides the merged result, every commit the merge brings in is inspected (`inspectHistory`,
 * with `secrets`): a defect rolls the merge back as `project_integration_history`
 * (`project_integration_history_unverifiable` for contents it could not compare).
 * The merge commit is built and checked first; `savePending({ before, mergeCommit })` records it, and
 * only then `publish` moves the branch (with `verify`: the worker's branch still on its head).
 * @param {{
 *   worktree: string, taskId: string, taskHead: string, writePaths: string[],
 *   savePending: (pending: { before: string, mergeCommit: string }) => unknown,
 *   pending?: { before: string, mergeCommit?: string } | null,
 *   withLease?: <T>(work: () => Promise<T>) => Promise<T>,
 *   secrets?: Record<string, unknown>,
 *   publish?: (commands: { cwd: string, verify: any[], update: any[] }) => Promise<unknown>,
 *   verify?: { ref: string, sha: string }[],
 * }} options
 */
export async function mergeTask({
  worktree,
  taskId,
  taskHead,
  writePaths,
  savePending,
  pending = null,
  withLease,
  secrets = {},
  publish = atomicPublisher,
  verify = [],
}) {
  if (
    typeof publish !== 'function' ||
    !Array.isArray(verify) ||
    !slug(taskId) ||
    !sha(taskHead) ||
    !Array.isArray(writePaths) ||
    !writePaths.length ||
    writePaths.some(scope => typeof scope !== 'string' || !scope) ||
    typeof savePending !== 'function' ||
    (pending !== null && !sha(pending?.before)) ||
    (withLease !== undefined && typeof withLease !== 'function')
  )
    fail('integration_invalid');
  const merge = async () => {
    await resumePublishedMerge(worktree, pending);
    await abandonInterruptedMerge(worktree, pending, taskHead);
    const branch = await assertIntegrationWorktree(worktree);
    await assertCommit(worktree, taskHead);
    const head = await headOf(worktree);
    if (await ancestor(worktree, taskHead, head)) {
      // A crash may also have hit between the merge and its scope check.
      const recovered = await existingMerge(worktree, taskHead);
      const defect = await mergeDefect(
        worktree,
        recovered.before,
        taskHead,
        writePaths,
        secrets,
        recovered.mergeCommit,
      );
      if (defect) {
        if (recovered.mergeCommit === head) await advanceBranch(worktree, branch, recovered.before, head, publish);
        fail(defect);
      }
      return { branch, ...recovered, mergedHead: taskHead, status: 'merged' };
    }
    const before = head;
    await assertSignature(worktree, taskHead);
    // The merge commit is built and checked before the branch moves: a conflict or a defect leaves
    // the branch and its worktree untouched, and only the publish moves the branch.
    const mergeCommit = await mergeCommitOf(worktree, before, taskHead, `Kodo: integrate ${taskId}`);
    const defect = await mergeDefect(worktree, before, taskHead, writePaths, secrets, mergeCommit);
    if (defect) fail(defect);
    await savePending({ before, mergeCommit });
    await advanceBranch(worktree, branch, mergeCommit, before, publish, verify);
    return { branch, before, mergeCommit, mergedHead: taskHead, status: 'merged' };
  };
  return withLease ? withLease(merge) : merge();
}

/**
 * Whether `to` (a gate Run's verified head) descends from `from` (the gate head)
 * and changes only files inside `writePaths` (the covered tasks' write paths).
 * @param {{ worktree: string, from: string, to: string, writePaths: string[] }} options
 */
export async function gateRepairInScope({ worktree, from, to, writePaths }) {
  if (
    !sha(from) ||
    !sha(to) ||
    !Array.isArray(writePaths) ||
    !writePaths.length ||
    writePaths.some(scope => typeof scope !== 'string' || !scope)
  )
    fail('integration_invalid');
  if (!(await ancestor(worktree, from, to))) return false;
  const changed = (await rawGit(worktree, ['diff', '--no-renames', '--name-only', '-z', from, to]))
    .split('\0')
    .filter(Boolean);
  return changed.every(name => ownsPath(writePaths, name));
}

/**
 * Bring a gate Run's verified head back to the integration branch. `expectedHead`
 * is the gate head (`gate.headSha`, the branch head the gate started from) and
 * `gateHead` the verified head (`run.headSha`), its descendant. While the branch
 * still points at `expectedHead` it fast-forwards to the verified head; when other
 * merges advanced it, the repair commits are merged `--no-ff`. Epic acceptance
 * belongs to the verified gate head; project acceptance additionally requires a
 * gate whose verified head equals the branch head at acceptance time.
 * The caller holds lease `project-integration:<projectId>`.
 * `savePending({ before, target })` records the return before it is published; `pending` (that record)
 * lets a repeat sync a worktree that a crash left between the publish and the sync.
 * @param {{ worktree: string, expectedHead: string, gateHead: string,
 *   publish?: (commands: { cwd: string, verify: any[], update: any[] }) => Promise<unknown>,
 *   pending?: { before: string, target: string } | null,
 *   savePending?: (pending: { before: string, target: string }) => unknown }} options
 */
export async function mergeBackGate({
  worktree,
  expectedHead,
  gateHead,
  publish = atomicPublisher,
  pending = null,
  savePending = () => {},
}) {
  if (
    !sha(gateHead) ||
    !sha(expectedHead) ||
    typeof publish !== 'function' ||
    typeof savePending !== 'function' ||
    (pending !== null && (!sha(pending?.before) || !sha(pending?.target)))
  )
    fail('integration_invalid');
  // A crash between the publish of this return and the worktree sync: the same recovery as a task.
  if (pending) await resumePublishedMerge(worktree, { before: pending.before, mergeCommit: pending.target });
  const branch = await assertIntegrationWorktree(worktree);
  await assertCommit(worktree, gateHead);
  await assertCommit(worktree, expectedHead);
  if (!(await ancestor(worktree, expectedHead, gateHead))) fail('integration_invalid');
  const before = await headOf(worktree);
  if (await ancestor(worktree, gateHead, before)) return before;
  // The branch is never rewritten: it must still contain the gate head.
  if (!(await ancestor(worktree, expectedHead, before))) fail('integration_invalid');
  // `merge.verifySignatures` holds for the gate head in both forms of the return.
  await assertSignature(worktree, gateHead);
  // Fast-forward to the verified head, or merge the repairs; either way by compare-and-swap.
  const next =
    before === expectedHead
      ? gateHead
      : await mergeCommitOf(worktree, before, gateHead, 'Kodo: integrate gate repairs');
  await savePending({ before, target: next });
  await advanceBranch(worktree, branch, next, before, publish);
  return next;
}
