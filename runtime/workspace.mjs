import { createHash } from 'node:crypto';
import { readFile, lstat, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { execute } from './command.mjs';
import { secretFile, redact, stateHome, worktreeHome } from './security.mjs';
export async function git(cwd, args, options = {}) {
  return (await execute('git', args, { cwd, ...options })).stdout.trim();
}
export async function diffHash(cwd, baseSha, headSha = 'HEAD') {
  return createHash('sha256')
    .update(
      (
        await execute('git', ['diff', '--binary', `${baseSha}...${headSha}`], { cwd, rawOutput: true })
      ).stdout.trimEnd(),
    )
    .digest('hex');
}
// Private run worktrees never live in the user's checkout. An explicit
// KODO_WORKTREE_HOME wins; a state home inside Git keeps worktrees beside its
// temporary artifact home; the default state home uses the default worktree home.
/** @param {{ storeHome: string, stateInGit?: boolean, artifactHome?: string }} options */
export function worktreeHomeFor({ storeHome, stateInGit = false, artifactHome }) {
  return (
    process.env.KODO_WORKTREE_HOME ||
    (stateInGit
      ? `${artifactHome}-worktrees`
      : path.resolve(storeHome) === stateHome()
        ? worktreeHome()
        : `${storeHome}-worktrees`)
  );
}
export async function inspectProject(project) {
  const root = await git(project, ['rev-parse', '--show-toplevel']);
  const head = await git(root, ['rev-parse', 'HEAD']);
  const dirty = await git(root, ['status', '--porcelain=v1']);
  const branches = await git(root, ['worktree', 'list', '--porcelain']);
  return { root, head, dirty, worktrees: branches };
}
export async function makeWorktree(project, directory, branch, base) {
  await mkdir(path.dirname(directory), { recursive: true });
  const exists = await lstat(directory).catch(() => null);
  if (exists) {
    if ((await git(directory, ['branch', '--show-current'])) !== branch)
      throw new Error('Несоответствие ветки существующего worktree');
    return directory;
  }
  const branchExists =
    (
      await execute('git', ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`], {
        cwd: project,
        allowFailure: true,
      })
    ).code === 0;
  await git(
    project,
    branchExists ? ['worktree', 'add', directory, branch] : ['worktree', 'add', '-b', branch, directory, base],
  );
  return directory;
}
export async function collectFiles(cwd, task, secrets = {}) {
  const names = (await git(cwd, ['ls-files', '-z'])).split('\0').filter(Boolean);
  const terms = task
    .toLowerCase()
    .split(/\W+/)
    .filter(word => word.length > 3);
  const eligible = names.filter(
    name =>
      !secretFile(name) &&
      !/(^|\/)(node_modules|dist|build|coverage|\.git|vendor)\//.test(name) &&
      !/^skills\/[^/]+\/references\/upstream\//.test(name) &&
      !/(lock\.json|lock\.yaml|\.lock)$/.test(name),
  );
  eligible.sort((a, b) => score(b) - score(a) || a.localeCompare(b));
  function score(name) {
    return (
      (/(package\.json|README|AGENTS|kodo.config)/.test(name) ? 20 : 0) +
      terms.filter(term => name.toLowerCase().includes(term)).length * 5
    );
  }
  const files = [];
  let size = 0;
  for (const name of eligible) {
    if (files.length >= 150 || size >= 450000) break;
    const filename = path.join(cwd, name),
      stat = await lstat(filename);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 50000) continue;
    const data = await readFile(filename);
    if (data.includes(0)) continue;
    files.push({ path: name, content: redact(data.toString('utf8'), secrets) });
    size += data.length;
  }
  return { files, omitted: names.length - files.length, bytes: size };
}
export async function changedFiles(cwd, base) {
  // NUL-separated raw names: Git quotes non-ASCII names in line mode, and redaction must not
  // rewrite a path before it is matched against the task's write scope. Never trimmed: a
  // NUL-separated name may begin with whitespace or U+FEFF.
  const { stdout } = await execute('git', ['diff', '--no-renames', '--name-only', '-z', base], {
    cwd,
    rawOutput: true,
  });
  return stdout.split('\0').filter(Boolean);
}
export async function commitChanges(cwd, message, paths) {
  if (paths === undefined) await git(cwd, ['add', '-A']);
  else {
    if (!Array.isArray(paths)) throw new Error('Commit paths must be an array');
    const selected = paths.map(name => {
      if (
        typeof name !== 'string' ||
        /[\x00-\x1f:]/.test(name) ||
        path.win32.isAbsolute(name) ||
        path.posix.isAbsolute(name)
      )
        throw new Error('Unsafe commit path');
      const relative = name.replaceAll('\\', '/');
      if (relative.split('/').some(part => !part || part === '.' || part === '..'))
        throw new Error('Unsafe commit path');
      return relative;
    });
    const allowed = new Set(selected);
    const staged = (await git(cwd, ['diff', '--cached', '--no-renames', '--name-only', '-z']))
      .split('\0')
      .filter(Boolean);
    if (staged.some(name => !allowed.has(name)))
      throw new Error('Unrelated files are already staged; refusing metadata commit');
    const existing = [];
    for (const name of allowed) {
      const stat = await lstat(path.join(cwd, name)).catch(error => {
        if (error.code === 'ENOENT') return null;
        throw error;
      });
      if (!stat) continue;
      if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`Commit metadata must be a regular file: ${name}`);
      existing.push(name);
    }
    if (existing.length) await git(cwd, ['--literal-pathspecs', 'add', '--all', '--', ...existing]);
  }
  const result = await execute('git', ['diff', '--cached', '--quiet'], { cwd, allowFailure: true });
  if (result.code === 1) await git(cwd, ['commit', '-m', message]);
  else if (result.code !== 0) throw new Error('Не удалось проверить staged changes');
  return git(cwd, ['rev-parse', 'HEAD']);
}
