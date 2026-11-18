import path from 'node:path';
import { lstat, realpath } from 'node:fs/promises';
import { execute } from './command.mjs';
import { git, makeWorktree } from './workspace.mjs';
import { ownsPath } from './contracts.mjs';

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

/** @param {{ root: string, projectId: string, worktreeHome: string }} options */
export async function ensureIntegration({ root, projectId, worktreeHome }) {
  const branch = integrationBranch(projectId);
  if (typeof root !== 'string' || typeof worktreeHome !== 'string' || !path.isAbsolute(worktreeHome))
    fail('integration_worktree_invalid');
  const checkout = await git(root, ['rev-parse', '--show-toplevel']);
  const userCheckout = await canonical(checkout);
  const outside = async directory => {
    if (inside(userCheckout, await canonical(directory))) fail('integration_worktree_invalid');
    return directory;
  };
  let found = parseWorktrees(await git(checkout, ['worktree', 'list', '--porcelain'])).find(
    record => record.branch === `refs/heads/${branch}`,
  );
  if (found?.prunable) {
    // The registered directory is gone; drop only the stale registration and
    // attach the surviving branch again below.
    await git(checkout, ['worktree', 'prune']);
    found = null;
  }
  let worktree;
  if (found) worktree = await outside(path.resolve(found.worktree));
  else {
    worktree = await outside(path.join(path.resolve(worktreeHome), `project-${projectId}`, 'integration'));
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
    await git(worktree, ['rev-parse', '--path-format=absolute', '--git-dir', '--git-common-dir'])
  ).split(/\r?\n/);
  const branch = await git(worktree, ['branch', '--show-current']);
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
    await git(worktree, [
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

async function abortMerge(worktree, before) {
  await execute('git', ['merge', '--abort'], { cwd: worktree, allowFailure: true });
  if ((await headOf(worktree)) !== before || (await git(worktree, ['status', '--porcelain=v1'])))
    await git(worktree, ['reset', '--hard', before]);
}

async function verifiedMerge(worktree, before, taskHead, writePaths, commit = 'HEAD') {
  const [first, second, third] = (await git(worktree, ['rev-list', '--parents', '-n', '1', commit]))
    .split(' ')
    .slice(1);
  const changed = (await git(worktree, ['diff', '--no-renames', '--name-only', '-z', before, commit]))
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

/**
 * `pending` is the value an earlier attempt passed to `savePending` (null when none was saved).
 * @param {{
 *   worktree: string, taskId: string, taskHead: string, writePaths: string[],
 *   savePending: (pending: { before: string }) => unknown,
 *   pending?: { before: string } | null,
 *   withLease?: <T>(work: () => Promise<T>) => Promise<T>,
 * }} options
 */
export async function mergeTask({ worktree, taskId, taskHead, writePaths, savePending, pending = null, withLease }) {
  if (
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
    await abandonInterruptedMerge(worktree, pending, taskHead);
    const branch = await assertIntegrationWorktree(worktree);
    await assertCommit(worktree, taskHead);
    const head = await headOf(worktree);
    if (await ancestor(worktree, taskHead, head)) {
      // A crash may also have hit between the merge and its scope check.
      const recovered = await existingMerge(worktree, taskHead);
      if (!(await verifiedMerge(worktree, recovered.before, taskHead, writePaths, recovered.mergeCommit))) {
        if (recovered.mergeCommit === head) await git(worktree, ['reset', '--hard', recovered.before]);
        fail('integration_scope');
      }
      return { branch, ...recovered, mergedHead: taskHead, status: 'merged' };
    }
    const before = head;
    await savePending({ before });
    const merged = await execute(
      'git',
      ['merge', '--no-ff', '--no-edit', '-m', `Kodo: integrate ${taskId}`, taskHead],
      { cwd: worktree, allowFailure: true },
    );
    if (merged.code !== 0) {
      await abortMerge(worktree, before);
      fail('integration_conflict');
    }
    if (!(await verifiedMerge(worktree, before, taskHead, writePaths))) {
      await git(worktree, ['reset', '--hard', before]);
      fail('integration_scope');
    }
    return { branch, before, mergeCommit: await headOf(worktree), mergedHead: taskHead, status: 'merged' };
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
  const changed = (await git(worktree, ['diff', '--no-renames', '--name-only', '-z', from, to]))
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
 * @param {{ worktree: string, expectedHead: string, gateHead: string }} options
 */
export async function mergeBackGate({ worktree, expectedHead, gateHead }) {
  if (!sha(gateHead) || !sha(expectedHead)) fail('integration_invalid');
  await assertIntegrationWorktree(worktree);
  await assertCommit(worktree, gateHead);
  await assertCommit(worktree, expectedHead);
  if (!(await ancestor(worktree, expectedHead, gateHead))) fail('integration_invalid');
  const before = await headOf(worktree);
  if (await ancestor(worktree, gateHead, before)) return before;
  // The branch is never rewritten: it must still contain the gate head.
  if (!(await ancestor(worktree, expectedHead, before))) fail('integration_invalid');
  const args =
    before === expectedHead
      ? ['merge', '--ff-only', gateHead]
      : ['merge', '--no-ff', '--no-edit', '-m', 'Kodo: integrate gate repairs', gateHead];
  if ((await execute('git', args, { cwd: worktree, allowFailure: true })).code !== 0) {
    await abortMerge(worktree, before);
    fail('integration_conflict');
  }
  return headOf(worktree);
}
